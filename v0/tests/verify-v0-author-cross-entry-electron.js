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
  const preflight = authorAcceptance.inspectProject(sourceRoot);
  assert.strictEqual(preflight.eligible, true, JSON.stringify(preflight.errors));
  const copyResult = authorAcceptance.createWorkingCopy({
    rootPath: sourceRoot,
    destinationParent: copyParent,
    copyName: 'author-e2e-copy',
  });
  assert.strictEqual(copyResult.ok, true, JSON.stringify(copyResult));
  const copyRoot = path.join(copyParent, 'author-e2e-copy');
  const targetFile = writeFixtureFile(copyRoot);
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
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), chatBefore, 'Chat must not write files');

    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="navigation"]').click()`);
    await waitForValue(instance.client, `document.querySelector('#writing-navigation-host textarea')`,
      'real author Navigation input');
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
        body: document.body.textContent.slice(-1200),
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
