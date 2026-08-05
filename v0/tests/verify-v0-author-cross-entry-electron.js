#!/usr/bin/env node
'use strict';

// Stage-E author evidence for one realistic, owner-selected project.  The
// selected source is copied through the production author-acceptance
// transaction into a disposable derived copy.  Only that copy receives a
// small fixture file; the source snapshot is checked before and after the
// journey.  The local provider is deterministic and never sends manuscript
// text or credentials to a network endpoint.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const authorAcceptance = require('../src/main/author-acceptance-preflight-service');
const fixture = require('./fixtures/electron-ai-provider');
const {
  launchElectron,
  stopElectron,
  skipReason,
  waitForRenderer,
  waitForValue,
} = require('./verify-v0-electron-e2e');

const AUTHOR_SOURCE = process.env.WRITCRAFT_E2E_AUTHOR_PROJECT;
const TARGET_PATH = 'chapters/author-e2e.md';

async function waitForLog(logRef, marker, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logRef.value.includes(marker)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}: ${marker}`);
}

function snapshotMarkdownFiles(rootPath) {
  const paths = [];
  const visit = nodes => {
    for (const node of nodes || []) {
      if (node?.type === 'directory') visit(node.children);
      else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) {
        paths.push(node.path);
      }
    }
  };
  visit(projectService.listTree(rootPath));
  return paths.sort().map(filePath => [filePath, projectService.readFile(rootPath, filePath)]);
}

function writeFixtureFile(rootPath) {
  const target = path.join(rootPath, ...TARGET_PATH.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, [
    '# 作者验收章节',
    '',
    '这一章承接真实项目的写作目标。',
    '',
    fixture.AUTHOR_BEFORE,
    '',
    '这一段保留原有语气，方便冲突和撤销验证。',
    '',
  ].join('\n'), 'utf8');
  return target;
}

function stageSelectedAuthorSource(sourceRoot, scratch) {
  const stagedRoot = path.join(scratch, 'selected-author-source');
  fs.cpSync(sourceRoot, stagedRoot, {
    recursive: true,
    filter(sourcePath) {
      return path.basename(sourcePath) !== 'author-acceptance-copy.json';
    },
  });
  return stagedRoot;
}

async function run() {
  const unavailable = skipReason();
  if (unavailable) {
    console.log(`SKIP: ${unavailable}`);
    return;
  }
  if (!AUTHOR_SOURCE) {
    console.log('SKIP: set WRITCRAFT_E2E_AUTHOR_PROJECT to the owner-selected author project');
    return;
  }

  const sourceRoot = path.resolve(AUTHOR_SOURCE);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-author-cross-entry-'));
  const copyParent = path.join(scratch, 'copies');
  fs.mkdirSync(copyParent, { recursive: true });
  const sourceBefore = snapshotMarkdownFiles(sourceRoot);
  const stagedSourceRoot = stageSelectedAuthorSource(sourceRoot, scratch);
  const preflight = authorAcceptance.inspectProject(stagedSourceRoot);
  assert.strictEqual(preflight.eligible, true, JSON.stringify(preflight.errors));
  const copyResult = authorAcceptance.createWorkingCopy({
    rootPath: stagedSourceRoot,
    destinationParent: copyParent,
    copyName: 'author-e2e-copy',
  });
  assert.strictEqual(copyResult.ok, true, JSON.stringify(copyResult));
  const copyRoot = path.join(copyParent, 'author-e2e-copy');
  const targetFile = writeFixtureFile(copyRoot);
  const secondCopyResult = authorAcceptance.createWorkingCopy({
    rootPath: stagedSourceRoot,
    destinationParent: copyParent,
    copyName: 'author-e2e-switch-copy',
  });
  assert.strictEqual(secondCopyResult.ok, true, JSON.stringify(secondCopyResult));
  const secondRoot = path.join(copyParent, 'author-e2e-switch-copy');
  writeFixtureFile(secondRoot);
  const before = snapshotMarkdownFiles(copyRoot);
  let instance = null;
  try {
    instance = await launchElectron(scratch, copyRoot);
    await waitForRenderer(instance.client);
    await waitForValue(instance.client, `(() => {
      const state = window.__workspace?.state;
      return state?.projectReady === true && state.currentPath ? true : null;
    })()`, 'real author copy readiness');
    await instance.client.evaluate(`window.__workspace.openFile(${JSON.stringify(TARGET_PATH)}, { pin: true })`);
    await waitForValue(instance.client, `window.__workspace.state.currentPath === ${JSON.stringify(TARGET_PATH)}`,
      'real author copy target');

    const chatBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="chat"]').click();
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_CHAT_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    let chat;
    try {
      chat = await waitForValue(instance.client, `(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(fixture.AUTHOR_CHAT_RESPONSE)}));
        if (!reply) return null;
        return {
          text: reply.textContent,
          types: [...reply.querySelectorAll('.chat-response-context .context-chip')]
            .map(node => node.dataset.type),
        };
      })()`, 'real author Chat response');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        messages: document.getElementById('chat-messages')?.textContent || '',
        task: document.getElementById('ai-task-progress')?.textContent || '',
        currentPath: window.__workspace?.state?.currentPath || '',
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-4000))}`;
      throw error;
    }
    assert(chat.text.includes(fixture.AUTHOR_CHAT_RESPONSE));
    assert.deepStrictEqual(chat.types, ['scope', 'project_prompt', 'file']);
    const chatManifest = await instance.client.evaluate(`(() => {
      const manifest = window.__contextInspectorView?.getState?.()?.snapshot;
      return manifest ? {
        scope: manifest.scope,
        budgetChars: manifest.budgetChars,
        unified: manifest.unified || null,
        chips: (manifest.chips || []).map(chip => ({ type: chip.type, path: chip.filePath, source: chip.sourceId, revision: chip.revision, bytes: chip.bytes })),
      } : null;
    })()`);
    assert(chatManifest, 'author Chat must publish the Main-owned Context Manifest');
    assert(chatManifest.unified, 'author Chat must publish the unified Context Manifest envelope');
    assert(chatManifest.chips.some(chip => chip.type === 'project_prompt' && chip.path === 'edit.md'),
      'author Chat manifest must identify edit.md as project_prompt');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), chatBefore, 'Chat must not write files');

    // Keep the same Chat task in flight while the author changes edit.md.
    // Main must invalidate the old prompt/revision binding and discard the
    // provider result without allowing it into the conversation.
    const editRevisionBefore = projectService.readFile(copyRoot, 'edit.md');
    await instance.client.evaluate(`(() => {
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_EDIT_REVISION_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    const editRevisionDeadline = Date.now() + 22_000;
    while (!instance.logRef.value.includes('AUTHOR_EDIT_REVISION_PROVIDER_CALL') && Date.now() < editRevisionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_EDIT_REVISION_PROVIDER_CALL'),
      'edit.md revision fixture provider must enter its delayed boundary');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), `${editRevisionBefore}\nE2E_EDIT_REVISION_DRIFT`, 'utf8');
    const editRevisionCompleteDeadline = Date.now() + 25_000;
    while (!instance.logRef.value.includes('AUTHOR_EDIT_REVISION_PROVIDER_COMPLETE') && Date.now() < editRevisionCompleteDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_EDIT_REVISION_PROVIDER_COMPLETE'),
      'edit.md revision fixture provider must complete after drift');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const revisionUi = await instance.client.evaluate(`document.getElementById('chat-messages')?.textContent || ''`);
    assert(!revisionUi.includes(fixture.AUTHOR_EDIT_REVISION_RESPONSE),
      'edit.md revision drift must discard the late Chat response');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), editRevisionBefore, 'utf8');

    // Start a deliberately late task in project A, then use the production
    // open-recent IPC path to switch the same Electron window to project B.
    // The provider call must have crossed its real boundary before switching;
    // otherwise this would only test a preflight race.
    const projectASwitchBefore = snapshotMarkdownFiles(copyRoot);
    const projectBSwitchBefore = snapshotMarkdownFiles(secondRoot);
    await instance.client.evaluate(`(() => {
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_SWITCH_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    const switchDeadline = Date.now() + 10_000;
    while (!instance.logRef.value.includes('AUTHOR_SWITCH_PROVIDER_CALL') && Date.now() < switchDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_SWITCH_PROVIDER_CALL'),
      'project-switch fixture provider must have entered its delayed boundary');
    projectService.saveRecentProject(instance.userData, secondRoot);
    // Reload the same Electron window so the normal Renderer startup path
    // performs openRecent -> handleProjectResult -> enterProject. Calling the
    // narrow preload bridge directly would only return Main data and would
    // not prove the visible workspace switched.
    await instance.client.command('Page.reload', { ignoreCache: true });
    await waitForRenderer(instance.client);
    try {
      await waitForValue(instance.client,
        `window.__workspace?.state?.project?.name === 'author-e2e-switch-copy' && window.__workspace?.state?.projectReady === true`,
        'real author project B switch');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        project: window.__workspace?.state?.project || null,
        projectReady: window.__workspace?.state?.projectReady,
        currentPath: window.__workspace?.state?.currentPath || '',
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-5000))}`;
      throw error;
    }
    const lateResultDeadline = Date.now() + 25_000;
    while (!instance.logRef.value.includes('AUTHOR_SWITCH_PROVIDER_COMPLETE') && Date.now() < lateResultDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_SWITCH_PROVIDER_COMPLETE'),
      'project-switch fixture provider must complete after the project switch');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const switchUi = await instance.client.evaluate(`document.getElementById('chat-messages')?.textContent || ''`);
    assert(!switchUi.includes(fixture.AUTHOR_SWITCH_RESPONSE),
      'late project-A response must not render in project B');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), projectASwitchBefore,
      'project A late result must not write project A');
    assert.deepStrictEqual(snapshotMarkdownFiles(secondRoot), projectBSwitchBefore,
      'project A late result must not write project B');

    // Restore project A through the same production startup path before the
    // remainder of this journey, whose fixture file and prompt belong to A.
    projectService.saveRecentProject(instance.userData, copyRoot);
    await instance.client.command('Page.reload', { ignoreCache: true });
    await waitForRenderer(instance.client);
    await waitForValue(instance.client,
      `window.__workspace?.state?.project?.name === 'author-e2e-copy' && window.__workspace?.state?.projectReady === true`,
      'restore real author project A');

    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="navigation"]').click()`);
    await waitForValue(instance.client, `document.querySelector('#writing-navigation-host textarea')`,
      'real author Navigation input');
    const navigationRevisionBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const host = document.getElementById('writing-navigation-host');
      const input = host.querySelector('textarea');
      input.value = ${JSON.stringify(fixture.AUTHOR_NAVIGATION_REVISION_GOAL)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-navigation-action="generate"]').click();
    })()`);
    const navigationRevisionDeadline = Date.now() + 15_000;
    while (!instance.logRef.value.includes('AUTHOR_NAVIGATION_REVISION_PROVIDER_CALL') && Date.now() < navigationRevisionDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_NAVIGATION_REVISION_PROVIDER_CALL'),
      'Navigation revision fixture provider must enter its delayed boundary');
    const navigationEditBefore = projectService.readFile(copyRoot, 'edit.md');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), `${navigationEditBefore}\nE2E_NAVIGATION_EDIT_REVISION_DRIFT`, 'utf8');
    const navigationRevisionCompleteDeadline = Date.now() + 15_000;
    while (!instance.logRef.value.includes('AUTHOR_NAVIGATION_REVISION_PROVIDER_COMPLETE') && Date.now() < navigationRevisionCompleteDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(instance.logRef.value.includes('AUTHOR_NAVIGATION_REVISION_PROVIDER_COMPLETE'),
      'Navigation revision fixture provider must complete after drift');
    await new Promise(resolve => setTimeout(resolve, 600));
    const navigationRevisionUi = await instance.client.evaluate(`document.getElementById('writing-navigation-host')?.textContent || ''`);
    assert(!navigationRevisionUi.includes(fixture.AUTHOR_NAVIGATION_REVISION_RESPONSE),
      'Navigation edit.md revision drift must discard the late suggestion');
    assert(!navigationRevisionUi.includes('处理这个建议'),
      'stale Navigation response must not create a reviewable suggestion');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), navigationEditBefore, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), navigationRevisionBefore,
      'Navigation edit.md revision drift must be zero-write');
    console.log('    Author Navigation revision-drift path passed');
    const navigationCancelBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const host = document.getElementById('writing-navigation-host');
      const input = host.querySelector('textarea');
      input.value = ${JSON.stringify(fixture.AUTHOR_NAVIGATION_CANCEL_GOAL)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-navigation-action="generate"]').click();
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_NAVIGATION_CANCEL_PROVIDER_CALL', 'real author Navigation cancellation provider call', 15_000);
    await waitForValue(instance.client,
      `([...document.querySelectorAll('#writing-navigation-host .writing-navigation__secondary')].some(button => button.textContent === '停止整理'))`,
      'real author Navigation cancellation affordance', 22_000);
    await instance.client.evaluate(`([...document.querySelectorAll('#writing-navigation-host .writing-navigation__secondary')].find(button => button.textContent === '停止整理')?.click())`);
    await waitForValue(instance.client,
      `!document.querySelector('#writing-navigation-host .writing-navigation__secondary')`,
      'real author Navigation cancelled terminal');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), navigationCancelBefore,
      'cancelled Navigation zero-write');
    await waitForLog(instance.logRef, 'AUTHOR_NAVIGATION_CANCEL_PROVIDER_COMPLETE', 'real author Navigation cancellation provider completion', 25_000);
    assert(!((await instance.client.evaluate(`document.getElementById('writing-navigation-host')?.textContent || ''`))
      .includes(fixture.AUTHOR_NAVIGATION_CANCEL_RESPONSE)),
      'late cancelled Navigation answer must be discarded');

    await instance.client.evaluate(`(() => {
      const host = document.getElementById('writing-navigation-host');
      const input = host.querySelector('textarea');
      input.value = ${JSON.stringify(fixture.AUTHOR_NAVIGATION_GOAL)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-navigation-action="generate"]').click();
    })()`);
    await waitForValue(instance.client,
      `document.querySelector('.writing-navigation__suggestion .writing-navigation__primary')?.textContent === '处理这个建议'`,
      'real author Navigation suggestion');
    assert.strictEqual(await instance.client.evaluate(`([...document.querySelectorAll('.writing-navigation__secondary')].some(button => button.textContent === '添加来源'))`), false,
      'source-sufficient Navigation must not show 添加来源');
    const navigationManifest = await instance.client.evaluate(`(() => {
      const manifest = window.__writingNavigationView?.getState?.()?.result?.contextManifest;
      return manifest ? {
        editPromptCompilation: manifest.editPromptCompilation,
        omittedBodyCount: manifest.omittedBodyCount,
        omissionReason: manifest.omissionReason,
        truncationReason: manifest.truncationReason,
        disclosure: manifest.disclosure,
        unified: manifest.unified || null,
        files: manifest.files || [],
      } : null;
    })()`);
    assert(navigationManifest, 'author Navigation must publish the Main-owned Context Manifest');
    assert(navigationManifest.unified, 'author Navigation must publish the unified Context Manifest envelope');
    const chatPrompt = chatManifest.chips.find(chip => chip.type === 'project_prompt' && chip.path === 'edit.md');
    const navigationPrompt = navigationManifest.files.find(file => file.role === 'project_prompt' && file.path === 'edit.md');
    assert(navigationPrompt, 'author Navigation manifest must identify edit.md as project_prompt');
    assert.strictEqual(navigationPrompt.revision, chatPrompt.revision,
      'Chat and Navigation must bind the same edit.md revision');
    assert.strictEqual(chatManifest.unified.entry, 'chat');
    assert.strictEqual(navigationManifest.unified.entry, 'navigation');
    assert.strictEqual(navigationManifest.unified.editRevision, chatManifest.unified.editRevision);
    assert.deepStrictEqual(navigationManifest.unified.editCompilation, chatManifest.unified.editCompilation,
      'Chat and Navigation must expose identical edit.md compilation semantics');
    assert.strictEqual(navigationManifest.unified.sourceIndexRevision, null);
    assert(navigationManifest.unified.items.some(item => item.kind === 'project_prompt' && item.status === 'included'));
    assert(navigationManifest.unified.items.every(item => !String(item.path || '').startsWith('/')));
    assert(Number.isSafeInteger(chatPrompt.bytes) && chatPrompt.bytes > 0,
      'author Chat manifest must expose a bounded edit.md byte count');
    assert(Number.isSafeInteger(navigationManifest.editPromptCompilation?.compiledBytes),
      'Navigation manifest must expose bounded edit.md compilation bytes');
    assert(navigationManifest.editPromptCompilation.compiledBytes > 0,
      'Navigation manifest must expose a non-empty edit.md compilation budget');
    assert(Number.isSafeInteger(navigationPrompt.bytes) && navigationPrompt.bytes > 0,
      'Navigation manifest must expose raw edit.md bytes');
    // Chat chip bytes are the bounded disclosed context section bytes, while
    // Navigation files[].bytes is the raw edit.md snapshot. They are distinct
    // contract fields and must not be compared as if they shared a unit.
    assert(navigationManifest.editPromptCompilation.compiledBytes >= navigationPrompt.bytes,
      'Navigation compiled prompt bytes must cover its bound edit.md snapshot');
    assert.strictEqual(navigationManifest.omittedBodyCount > 0,
      navigationManifest.omissionReason === 'not_selected',
      'Navigation omission reason must match its bounded body omission count');
    assert.strictEqual(navigationManifest.truncationReason, null,
      'source-sufficient Navigation must report no truncation reason');
    assert(typeof navigationManifest.disclosure === 'string' && navigationManifest.disclosure.length > 0,
      'Navigation manifest must expose bounded disclosure semantics');
    await instance.client.evaluate(`document.querySelector('.writing-navigation__suggestion .writing-navigation__primary').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.changes-inline-review')?.textContent.includes(${JSON.stringify(fixture.AUTHOR_AFTER)})`,
      'real author inline Diff');
    const preview = await instance.client.evaluate(`(() => ({
      stage: document.querySelector('.writing-navigation__task-stage')?.textContent || '',
      writeState: document.querySelector('.writing-navigation__write-state')?.textContent || '',
      hasRemove: Boolean(document.querySelector('.changes-inline-review__text.is-remove')),
      hasAdd: Boolean(document.querySelector('.changes-inline-review__text.is-add')),
    }))()`);
    assert.strictEqual(preview.stage, 'Diff 已显示在正文编辑区');
    assert.strictEqual(preview.writeState, '尚未写入；接受后才会修改文件');
    assert.strictEqual(preview.hasRemove, true);
    assert.strictEqual(preview.hasAdd, true);
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), before, 'Diff preview must be zero-write');

    // Change the target outside the review, then prove Main blocks the stale
    // capability rather than silently merging or overwriting the author edit.
    fs.appendFileSync(targetFile, '\n作者在审阅期间补充的新句子。\n', 'utf8');
    await new Promise(resolve => setTimeout(resolve, 450));
    const acceptedRetryClick = await instance.client.evaluate(`(() => {
      const hunk = document.querySelector('.changes-inline-review__hunk');
      const accept = hunk && [...hunk.querySelectorAll('button')].find(node => node.textContent === '接受');
      const confirm = [...document.querySelectorAll('.changes-inline-review__toolbar button')]
        .find(node => node.textContent === '确认并写入');
      if (!hunk || !accept || !confirm) return {
        ok: false,
        review: document.querySelector('.changes-inline-review')?.textContent || '',
        toolbar: document.querySelector('.changes-inline-review__toolbar')?.textContent || '',
        classes: [...document.querySelectorAll('.changes-inline-review *')].map(node => node.className).filter(Boolean).slice(0, 30),
        buttons: [...document.querySelectorAll('.changes-inline-review button')].map(node => node.textContent),
      };
      accept.click();
      confirm.click();
      return { ok: true };
    })()`);
    assert.deepStrictEqual(acceptedRetryClick, { ok: true }, JSON.stringify(acceptedRetryClick));
    await waitForValue(instance.client, `(() => {
      const text = document.body.textContent;
      return text.includes('文件已变化') || text.includes('冲突') || text.includes('重新生成')
        ? text : null;
    })()`, 'real author stale Diff conflict block');
    assert(projectService.readFile(copyRoot, TARGET_PATH).includes('作者在审阅期间补充的新句子。'));
    assert(!projectService.readFile(copyRoot, TARGET_PATH).includes(fixture.AUTHOR_AFTER));
    await instance.client.evaluate(`(() => {
      const exit = [...document.querySelectorAll('.changes-inline-review__toolbar button')]
        .find(node => node.textContent === '退出审阅');
      if (exit) exit.click();
    })()`);
    await waitForValue(instance.client, `!document.querySelector('.changes-inline-review')`,
      'leaving the stale author Diff before retry');

    // Restore the external test edit, generate a fresh task, accept it, and
    // then use the existing History Safe Undo path.
    fs.writeFileSync(targetFile, before.find(([filePath]) => filePath === TARGET_PATH)[1], 'utf8');
    await new Promise(resolve => setTimeout(resolve, 450));
    await instance.client.evaluate(`document.querySelector('[data-navigation-action="generate"]').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.writing-navigation__suggestion .writing-navigation__primary')?.textContent === '处理这个建议'`,
      'real author retry suggestion');
    await instance.client.evaluate(`document.querySelector('.writing-navigation__suggestion .writing-navigation__primary').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.changes-inline-review')?.textContent.includes(${JSON.stringify(fixture.AUTHOR_AFTER)})`,
      'real author retry Diff');
    const decisionClick = await instance.client.evaluate(`(() => {
      const hunk = document.querySelector('.changes-inline-review__hunk');
      const accept = hunk && [...hunk.querySelectorAll('button')]
        .find(node => node.textContent === '接受' || node.textContent === '已接受');
      if (!hunk || !accept) return {
        ok: false,
        review: document.querySelector('.changes-inline-review')?.textContent || '',
        buttons: [...document.querySelectorAll('.changes-inline-review button')].map(node => node.textContent),
      };
      if (accept.textContent === '接受') accept.click();
      return { ok: true };
    })()`);
    assert.deepStrictEqual(decisionClick, { ok: true }, JSON.stringify(decisionClick));
    await waitForValue(instance.client,
      `document.querySelector('.changes-inline-review__hunk.is-accepted')`,
      'real author accepted hunk decision');
    const commitButton = await instance.client.evaluate(`(() => {
      const button = [...document.querySelectorAll('.changes-inline-review__toolbar button')]
        .find(node => node.textContent === '确认并写入');
      return button ? { exists: true, disabled: button.disabled } : { exists: false, disabled: true };
    })()`);
    assert.deepStrictEqual(commitButton, { exists: true, disabled: false }, JSON.stringify(commitButton));
    await instance.client.evaluate(`([...document.querySelectorAll('.changes-inline-review__toolbar button')]
      .find(node => node.textContent === '确认并写入')).click()`);
    try {
      await waitForValue(instance.client,
        `document.querySelector('.writing-navigation__task-stage')?.textContent === '修改已经写入项目文件' && window.__editor.getContent().includes(${JSON.stringify(fixture.AUTHOR_AFTER)})`,
        'real author accepted Diff');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        taskStage: document.querySelector('.writing-navigation__task-stage')?.textContent || '',
        review: document.querySelector('.changes-inline-review')?.textContent || '',
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; disk=${JSON.stringify(projectService.readFile(copyRoot, TARGET_PATH))}`;
      throw error;
    }
    const committed = projectService.readFile(copyRoot, TARGET_PATH);
    assert(committed.includes(fixture.AUTHOR_AFTER));
    assert(!committed.includes(fixture.AUTHOR_BEFORE));

    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="changes"]').click();
      window.__authorCrossEntryOriginalConfirm = window.confirm;
      window.confirm = () => true;
    })()`);
    await waitForValue(instance.client, `document.querySelector('.history-card.is-latest .history-undo')`,
      'real author Safe Undo control');
    await instance.client.evaluate(`document.querySelector('.history-card.is-latest .history-undo').click()`);
    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="navigation"]').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.writing-navigation__task-stage')?.textContent === '这次写入已经安全撤销' && window.__editor.getContent().includes(${JSON.stringify(fixture.AUTHOR_BEFORE)})`,
      'real author Safe Undo terminal');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), before, 'Safe Undo must restore the copy');
    await instance.client.evaluate(`(() => {
      window.confirm = window.__authorCrossEntryOriginalConfirm;
      delete window.__authorCrossEntryOriginalConfirm;
    })()`);

    // A strict needs_sources result must expose the recovery action only for
    // the insufficient-source branch and must remain a zero-write preview.
    const sourceNeededBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const host = document.getElementById('writing-navigation-host');
      const input = host?.querySelector('textarea');
      if (!input) return false;
      input.value = ${JSON.stringify(fixture.AUTHOR_SOURCE_NEEDED_GOAL)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-navigation-action="generate"]')?.click();
      return true;
    })()`);
    await waitForValue(instance.client,
      `document.querySelector('.writing-navigation__suggestion .writing-navigation__primary')?.textContent === '处理这个建议'`,
      'real author source-needed Navigation suggestion');
    await instance.client.evaluate(`document.querySelector('.writing-navigation__suggestion .writing-navigation__primary').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.writing-navigation__task-stage')?.textContent.includes('来源') && document.querySelector('.writing-navigation__secondary')?.textContent === '添加来源'`,
      'real author needs-sources recovery action');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), sourceNeededBefore,
      'source-needed Navigation must remain zero-write');
    const needsSourcesTask = await instance.client.evaluate(`(() => {
      const state = window.__writingNavigationView?.getState?.();
      const entry = Object.entries(state?.actions || {}).find(([, action]) => action.status === 'needs_sources');
      return entry ? { actionId: entry[0], suggestionId: entry[1].suggestionId || null } : null;
    })()`);
    assert(needsSourcesTask, 'needs_sources task must retain its action identity');
    await instance.client.evaluate(`document.querySelector('.writing-navigation__secondary')?.click()`);
    await waitForValue(instance.client,
      `document.querySelector('#source-index-list .source-card input[type="checkbox"]')`,
      'real author add-source source list');
    await instance.client.evaluate(`(() => {
      const checkbox = document.querySelector('#source-index-list .source-card input[type="checkbox"]');
      if (!checkbox.checked) checkbox.click();
      return document.getElementById('source-research-run')?.textContent || '';
    })()`);
    await waitForValue(instance.client,
      `document.getElementById('source-research-run')?.textContent === '使用所选来源继续处理' && !document.getElementById('source-research-run').disabled`,
      'real author selected source recovery action');
    await instance.client.evaluate(`document.getElementById('source-research-run').click()`);
    await waitForValue(instance.client,
      `document.querySelector('.changes-inline-review')?.textContent.includes(${JSON.stringify(fixture.AUTHOR_AFTER)})`,
      'real author resumed source task Diff');
    const resumedTask = await instance.client.evaluate(`(() => {
      const state = window.__writingNavigationView?.getState?.();
      const entry = Object.entries(state?.actions || {}).find(([id]) => id === ${JSON.stringify(needsSourcesTask.actionId)});
      return entry ? { actionId: entry[0], status: entry[1].status, suggestionId: entry[1].suggestionId || null } : null;
    })()`);
    assert(resumedTask, 'resumed source task must retain its action identity');
    assert.strictEqual(resumedTask.actionId, needsSourcesTask.actionId);
    assert.strictEqual(resumedTask.status, 'review');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), sourceNeededBefore,
      'resumed source task Diff must remain zero-write before acceptance');

    const externalRequests = instance.networkRequests.filter(url =>
      /^https?:/i.test(url) && !url.startsWith('https://api.minimaxi.com/'));
    assert.deepStrictEqual(externalRequests, [], `unexpected external requests: ${JSON.stringify(externalRequests)}`);
    assert.deepStrictEqual(snapshotMarkdownFiles(sourceRoot), sourceBefore, 'selected source must remain unchanged');
    console.log('✅ Real author cross-entry Electron 1/1 passed; source-backed Chat → Navigation → inline Diff, stale-conflict block, accept and Safe Undo verified');
  } finally {
    await stopElectron(instance).catch(() => {});
    assert.deepStrictEqual(snapshotMarkdownFiles(sourceRoot), sourceBefore, 'selected source must remain unchanged after cleanup');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { run };
