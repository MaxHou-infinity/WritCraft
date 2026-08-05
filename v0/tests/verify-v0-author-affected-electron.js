#!/usr/bin/env node
'use strict';

// Stage-E author evidence for the remaining feature boundaries.  The owner
// selects one real manuscript; production copy transaction creates a
// disposable working copy, and only that copy receives the small fixture
// chapter/source needed to exercise Chapter, Research and Graph.  The source
// Markdown snapshot is compared before and after the whole journey.
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
const AUTHOR_TARGET = 'chapters/author-e2e.md';
const CHAPTER_TARGET = fixture.CHAT_CURRENT_PATH;
const AUTHOR_SOURCE_FILE = 'references/author-evidence.md';

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

function writeFile(rootPath, relativePath, content) {
  const target = path.join(rootPath, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
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

function seedAuthorFixtures(rootPath) {
  const authorTarget = writeFile(rootPath, AUTHOR_TARGET, [
    '# 作者验收章节',
    '',
    '这一章承接真实项目的写作目标。',
    '',
    '社区调查早于公开听证。',
    '公开听证早于正式签约。',
    fixture.GRAPH_ISSUE_BEFORE_ONE,
    fixture.GRAPH_ISSUE_BEFORE_TWO,
    '',
    fixture.AUTHOR_BEFORE,
    '',
    '这一段保留原有语气，方便图谱问题修复和撤销验证。',
    '',
  ].join('\n'));
  const chapterTarget = writeFile(rootPath, CHAPTER_TARGET, [
    '# 作者验收工作章节',
    '',
    '这是一个由真实作者项目派生的、只用于验收的章节。',
    '',
    fixture.RESEARCH_BEFORE,
    '',
    '当前正文仍由作者控制，任何 AI 结果都必须先进入 Diff。',
    '',
  ].join('\n'));
  const sourceTarget = writeFile(rootPath, AUTHOR_SOURCE_FILE, [
    '# 作者验收证据',
    '',
    '决议：调度系统进入六个月附条件试运行。',
    '',
    '该材料只用于核对主张，不代表系统已经正式验收。',
    '',
  ].join('\n'));
  writeFile(rootPath, 'chapters/author-changes-primary.md', [
    '# 作者验收 Changes 漂移主文件', '',
    fixture.CHANGES_BEFORE[0], '', fixture.CHANGES_BEFORE[1], '',
  ].join('\n'));
  const secondaryTarget = path.join(rootPath, ...fixture.CHANGES_SECOND_PATH.split('/'));
  fs.mkdirSync(path.dirname(secondaryTarget), { recursive: true });
  const secondaryBefore = fs.existsSync(secondaryTarget) ? fs.readFileSync(secondaryTarget, 'utf8') : '# 作者验收 Changes 漂移第二文件\n';
  if (!secondaryBefore.includes(fixture.CHANGES_BEFORE[2])) {
    fs.writeFileSync(secondaryTarget, `${secondaryBefore.trimEnd()}\n\n${fixture.CHANGES_BEFORE[2]}\n`, 'utf8');
  }
  return { authorTarget, chapterTarget, sourceTarget };
}

async function waitForReady(client) {
  await waitForRenderer(client);
  return waitForValue(client, `(() => {
    const state = window.__workspace?.state;
    return state?.projectReady === true && state.currentPath ? state : null;
  })()`, 'real author affected-copy readiness');
}

async function openFile(client, filePath) {
  // Do not make CDP wait on the renderer's async openFile promise.  Opening a
  // large author document can exceed the command budget, but starting the
  // next AI action before the promise settles creates a real current-file
  // invalidation race.  Keep the promise inside the renderer and poll an
  // explicit completion token instead.
  const token = `author-open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await client.evaluate(`(() => {
    const token = ${JSON.stringify(token)};
    const path = ${JSON.stringify(filePath)};
    window.__writcraftE2eOpenFile = { token, path, done: false, ok: false };
    Promise.resolve(window.__workspace.openFile(path, { pin: true })).then(result => {
      if (window.__writcraftE2eOpenFile?.token === token) {
        window.__writcraftE2eOpenFile.done = true;
        window.__writcraftE2eOpenFile.ok = result !== false;
      }
    }, () => {
      if (window.__writcraftE2eOpenFile?.token === token) window.__writcraftE2eOpenFile.done = true;
    });
  })()`);
  try {
    await waitForValue(client,
      `window.__writcraftE2eOpenFile?.token === ${JSON.stringify(token)} && window.__writcraftE2eOpenFile.done === true && window.__writcraftE2eOpenFile.ok === true`,
      `opening ${filePath}`, 20_000);
  } catch (error) {
    const diagnostics = await client.evaluate(`(() => ({
      open: window.__writcraftE2eOpenFile,
      currentPath: window.__workspace?.state?.currentPath || '',
      loading: Boolean(window.__workspace?.state?.loading),
      openGeneration: window.__workspace?.state?.openGeneration,
      dirty: Boolean(window.__workspace?.state?.dirty),
      savePromise: Boolean(window.__workspace?.state?.savePromise),
      inlineMutationBlocked: Boolean(window.__workspace?.state?.inlineMutationBlocked),
    }))()`).catch(() => null);
    error.message += `; diagnostics=${JSON.stringify(diagnostics)}`;
    throw error;
  }
}

async function undoLatest(client, description) {
  await client.evaluate(`window.__changesView?.loadHistory?.()`);
  await waitForValue(client,
    `document.querySelectorAll('.history-card').length > 0`,
    `${description}: refresh authoritative History`);
  const clicked = await client.evaluate(`(() => {
    window.confirm = () => true;
    const button = document.querySelector('.history-card.is-latest .history-undo');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.strictEqual(clicked, true, `${description}: latest Safe Undo control`);
  await waitForValue(client,
    `document.getElementById('changes-status')?.textContent.includes('已撤销 1 个文件')`,
    description);
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
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-author-affected-'));
  const copyParent = path.join(scratch, 'copies');
  fs.mkdirSync(copyParent, { recursive: true });
  const sourceBefore = snapshotMarkdownFiles(sourceRoot);
  const stagedSourceRoot = stageSelectedAuthorSource(sourceRoot, scratch);
  let instance = null;
  try {
    const preflight = authorAcceptance.inspectProject(stagedSourceRoot);
    assert.strictEqual(preflight.eligible, true, JSON.stringify(preflight.errors));
    const copyResult = authorAcceptance.createWorkingCopy({
      rootPath: stagedSourceRoot,
      destinationParent: copyParent,
      copyName: 'author-affected-copy',
    });
    assert.strictEqual(copyResult.ok, true, JSON.stringify(copyResult));
    const copyRoot = path.join(copyParent, 'author-affected-copy');
    const { authorTarget, chapterTarget } = seedAuthorFixtures(copyRoot);
    const copyBefore = snapshotMarkdownFiles(copyRoot);
    const editBefore = projectService.readFile(copyRoot, 'edit.md');
    const editSnapshot = projectService.readFileWithRevision(copyRoot, 'edit.md');

    instance = await launchElectron(scratch, copyRoot);
    await waitForReady(instance.client);
    console.log('    Author affected copy ready');
    await openFile(instance.client, AUTHOR_TARGET);

    // Chat remains informational and must expose the actual project/file
    // context while keeping the author copy's Markdown byte-identical.
    const chatBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="chat"]').click();
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_CHAT_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    const chat = await waitForValue(instance.client, `(() => {
      const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
        .find(node => node.textContent.includes(${JSON.stringify(fixture.AUTHOR_CHAT_RESPONSE)}));
      if (!reply) return null;
      return {
        text: reply.textContent,
        types: [...reply.querySelectorAll('.chat-response-context .context-chip')]
          .map(node => node.dataset.type),
      };
    })()`, 'author Chat response');
    assert(chat.text.includes(fixture.AUTHOR_CHAT_RESPONSE));
    assert.deepStrictEqual(chat.types, ['scope', 'project_prompt', 'file']);
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), chatBefore, 'author Chat zero-write');
    console.log('    Author Chat informational path passed');

    // A long Chat call must expose the 15-second cancellation control, settle
    // as cancelled, and discard the deliberately late provider response.
    await instance.client.evaluate(`(() => {
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_CANCEL_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_CANCEL_PROVIDER_CALL', 'author Chat cancellation provider call', 15_000);
    try {
      await waitForValue(instance.client,
        `document.querySelector('#ai-task-progress .ai-task-progress-cancel')`,
        'author Chat cancellation affordance', 22_000);
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        progress: document.getElementById('ai-task-progress')?.outerHTML || '',
        messages: document.getElementById('chat-messages')?.textContent || '',
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-5000))}`;
      throw error;
    }
    const cancelled = await instance.client.evaluate(`(() => {
      const button = document.querySelector('#ai-task-progress .ai-task-progress-cancel');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.strictEqual(cancelled, true);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress[data-status="cancelled"]')?.textContent.includes('已取消，未写入文件')`,
      'author Chat cancelled terminal');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    const cancelMarkdown = snapshotMarkdownFiles(copyRoot);
    const cancelUi = await instance.client.evaluate(`document.getElementById('chat-messages')?.textContent || ''`);
    assert(!cancelUi.includes(fixture.AUTHOR_CANCEL_RESPONSE), 'late cancelled Chat answer must be discarded');
    assert.deepStrictEqual(cancelMarkdown, chatBefore, 'cancelled Chat zero-write');
    console.log('    Author Chat cancellation path passed');
    // The fixture provider intentionally keeps its promise alive after the
    // Main task is cancelled. Let that late promise settle before opening the
    // next author surface, proving stale-result isolation without overlapping
    // a second CDP journey with the delayed response.
    await waitForLog(instance.logRef, 'AUTHOR_CANCEL_PROVIDER_COMPLETE', 'author Chat cancellation provider completion', 25_000);

    // A separate provider call must cross the 60-second hard deadline. The
    // terminal state is explicit, retryable, and still zero-write even after
    // the deliberately late provider response eventually settles.
    const timeoutBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.AUTHOR_TIMEOUT_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_TIMEOUT_PROVIDER_CALL', 'author Chat timeout provider call', 15_000);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress[data-status="timed_out"]')?.textContent.includes('已超时，未写入文件')`,
      'author Chat hard-timeout terminal', 70_000);
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), timeoutBefore,
      'timed-out Chat zero-write');
    const timeoutUi = await instance.client.evaluate(`document.getElementById('chat-messages')?.textContent || ''`);
    assert(!timeoutUi.includes(fixture.AUTHOR_TIMEOUT_RESPONSE),
      'late timed-out Chat answer must be discarded');
    await waitForLog(instance.logRef, 'AUTHOR_TIMEOUT_PROVIDER_COMPLETE', 'author Chat timeout provider completion', 25_000);
    console.log('    Author Chat hard-timeout path passed');
    await new Promise(resolve => setTimeout(resolve, 1_500));

    // Chapter plan: cross the real provider boundary, then change edit.md.
    // The plan is a preview-only intermediate result and must be discarded at
    // the Main dependency gate before it can create a block or Diff.
    const chapterRevisionBefore = snapshotMarkdownFiles(copyRoot);
    await openFile(instance.client, CHAPTER_TARGET);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="changes"]').click();
      const instruction = document.getElementById('changes-instruction');
      instruction.value = ${JSON.stringify(fixture.AUTHOR_CHAPTER_REVISION_GOAL)};
      instruction.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('changes-chapter').click();
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_CHAPTER_REVISION_PROVIDER_CALL', 'author Chapter revision provider call', 15_000);
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), `${editBefore}\nE2E_CHAPTER_EDIT_REVISION_DRIFT`, 'utf8');
    await waitForLog(instance.logRef, 'AUTHOR_CHAPTER_REVISION_PROVIDER_COMPLETE', 'author Chapter revision provider completion', 15_000);
    await new Promise(resolve => setTimeout(resolve, 600));
    const chapterRevisionUi = await instance.client.evaluate(`document.body.textContent || ''`);
    assert(!chapterRevisionUi.includes(fixture.AUTHOR_CHAPTER_REVISION_RESPONSE),
      'Chapter edit.md revision drift must discard the late plan');
    assert(!chapterRevisionUi.includes(fixture.CHAPTER_GENERATED_MARKER),
      'stale Chapter plan must not create a block or Diff');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), editBefore, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), chapterRevisionBefore,
      'Chapter edit.md revision drift must be zero-write');
    console.log('    Author Chapter revision-drift path passed');

    // Chapter cancellation: the plan provider crosses the real delayed
    // boundary, then Main cancellation must settle without a proposal/write.
    const chapterCancelBefore = snapshotMarkdownFiles(copyRoot);
    await openFile(instance.client, CHAPTER_TARGET);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="changes"]').click();
      const instruction = document.getElementById('changes-instruction');
      instruction.value = ${JSON.stringify(fixture.CHAPTER_CANCEL_GOAL)};
      instruction.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('changes-chapter').click();
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_CHAPTER_CANCEL_PROVIDER_CALL', 'author Chapter cancellation provider call', 15_000);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress .ai-task-progress-cancel')`,
      'author Chapter cancellation affordance', 22_000);
    await instance.client.evaluate(`document.querySelector('#ai-task-progress .ai-task-progress-cancel')?.click()`);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress[data-status="cancelled"]')?.textContent.includes('已取消，未写入文件')`,
      'author Chapter cancelled terminal');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), chapterCancelBefore,
      'cancelled Chapter zero-write');
    await waitForLog(instance.logRef, 'AUTHOR_CHAPTER_CANCEL_PROVIDER_COMPLETE', 'author Chapter cancellation provider completion', 25_000);
    assert(!((await instance.client.evaluate(`document.body.textContent || ''`))
      .includes(fixture.CHAPTER_CANCEL_RESPONSE)),
      'late cancelled Chapter answer must be discarded');

    // Chapter: plan, review, apply, and Safe Undo on the derived copy.
    console.log('    Starting author Chapter path');
    await openFile(instance.client, CHAPTER_TARGET);
    const chapterBefore = projectService.readFile(copyRoot, CHAPTER_TARGET);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="changes"]').click();
      const instruction = document.getElementById('changes-instruction');
      instruction.value = ${JSON.stringify(fixture.CHAPTER_GOAL)};
      instruction.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('changes-chapter').click();
    })()`);
    try {
      await waitForValue(instance.client, `(() => {
        const file = document.querySelector('.change-file');
        return file?.textContent.includes(${JSON.stringify(fixture.CHAPTER_GENERATED_MARKER)}) ? file : null;
      })()`, 'author Chapter Diff preview', 30_000);
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        currentPath: window.__workspace?.state?.currentPath || '',
        loading: Boolean(window.__workspace?.state?.loading),
        openGeneration: window.__workspace?.state?.openGeneration,
        dirty: Boolean(window.__workspace?.state?.dirty),
        savePromise: Boolean(window.__workspace?.state?.savePromise),
        inlineMutationBlocked: Boolean(window.__workspace?.state?.inlineMutationBlocked),
        status: document.getElementById('changes-status')?.textContent || '',
        preview: document.getElementById('changes-preview')?.textContent || '',
        progress: document.getElementById('ai-task-progress')?.outerHTML || '',
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-6000))}`;
      throw error;
    }
    assert.strictEqual(projectService.readFile(copyRoot, CHAPTER_TARGET), chapterBefore,
      'author Chapter preview zero-write');
    await instance.client.evaluate(`document.querySelector('.change-hunk-card .change-decision--accepted, .change-file-actions .change-decision--accepted').click(); document.getElementById('changes-apply').click()`);
    await waitForValue(instance.client,
      `document.getElementById('changes-status')?.textContent.includes('已安全应用 1 个文件') && window.__editor.getContent().includes(${JSON.stringify(fixture.CHAPTER_GENERATED_MARKER)})`,
      'author Chapter accepted write');
    assert(projectService.readFile(copyRoot, CHAPTER_TARGET).includes(fixture.CHAPTER_GENERATED_MARKER));
    await undoLatest(instance.client, 'author Chapter Safe Undo');
    assert.strictEqual(projectService.readFile(copyRoot, CHAPTER_TARGET), chapterBefore);

    // Ordinary Project Changes: the structured Diff response must be
    // discarded when edit.md changes after the provider has started.
    const changesRevisionBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="changes"]').click()`);
    await waitForValue(instance.client,
      `document.querySelector('#project-changes-target-list input[data-path="chapters/author-changes-primary.md"]') && document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(fixture.CHANGES_SECOND_PATH)}]')`,
      'author Changes revision targets');
    await instance.client.evaluate(`(() => {
      const wanted = new Set(['chapters/author-changes-primary.md', ${JSON.stringify(fixture.CHANGES_SECOND_PATH)}]);
      for (const input of document.querySelectorAll('#project-changes-target-list input')) {
        const shouldCheck = wanted.has(input.dataset.path);
        if (input.checked !== shouldCheck) {
          input.checked = shouldCheck;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      const instruction = document.getElementById('changes-instruction');
      instruction.value = ${JSON.stringify(fixture.AUTHOR_CHANGES_REVISION_GOAL)};
      instruction.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('changes-propose').click();
    })()`);
    await waitForValue(instance.client,
      `document.getElementById('changes-status')?.textContent.includes('再次点击')`,
      'author Changes revision scope confirmation');
    await instance.client.evaluate(`document.getElementById('changes-propose').click()`);
    await waitForLog(instance.logRef, 'AUTHOR_CHANGES_REVISION_PROVIDER_CALL', 'author Changes revision provider call', 15_000);
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), `${editBefore}\nE2E_CHANGES_EDIT_REVISION_DRIFT`, 'utf8');
    await waitForLog(instance.logRef, 'AUTHOR_CHANGES_REVISION_PROVIDER_COMPLETE', 'author Changes revision provider completion', 15_000);
    await new Promise(resolve => setTimeout(resolve, 600));
    const changesRevisionUi = await instance.client.evaluate(`document.body.textContent || ''`);
    assert(!changesRevisionUi.includes(fixture.AUTHOR_CHANGES_REVISION_RESPONSE),
      'Changes edit.md revision drift must discard the late Diff');
    const hasChangesHunk = await instance.client.evaluate(`Boolean(document.querySelector('.change-hunk-card'))`);
    assert.strictEqual(hasChangesHunk, false, 'stale Changes response must not create a Diff preview');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), editBefore, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), changesRevisionBefore,
      'Changes edit.md revision drift must be zero-write');
    console.log('    Author Changes revision-drift path passed');

    // Research: explicitly select one source, verify its evidence, carry it
    // into the dedicated Changes preview, apply, and undo without touching
    // edit.md.
    await instance.client.evaluate(`document.querySelector('[data-view="sources"]').click()`);
    await waitForValue(instance.client,
      `([...document.querySelectorAll('.source-card')].some(card => card.textContent.includes(${JSON.stringify(AUTHOR_SOURCE_FILE)})))`,
      'author Research source index');
    const researchRevisionBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.source-card')]
        .find(node => node.textContent.includes(${JSON.stringify(AUTHOR_SOURCE_FILE)}));
      const checkbox = card?.querySelector('input[type="checkbox"]');
      if (!checkbox) return false;
      if (!checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const question = document.getElementById('source-research-question');
      question.value = ${JSON.stringify(fixture.AUTHOR_RESEARCH_REVISION_QUESTION)};
      question.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('source-research-run').click();
      return true;
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_RESEARCH_REVISION_PROVIDER_CALL', 'author Research revision provider call', 15_000);
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), `${editBefore}\nE2E_RESEARCH_EDIT_REVISION_DRIFT`, 'utf8');
    await waitForLog(instance.logRef, 'AUTHOR_RESEARCH_REVISION_PROVIDER_COMPLETE', 'author Research revision provider completion', 15_000);
    await new Promise(resolve => setTimeout(resolve, 600));
    const researchRevisionUi = await instance.client.evaluate(`document.body.textContent || ''`);
    assert(!researchRevisionUi.includes(fixture.AUTHOR_RESEARCH_REVISION_RESPONSE),
      'Research edit.md revision drift must discard the late evidence');
    const hasResearchCard = await instance.client.evaluate(`Boolean(document.querySelector('.research-card'))`);
    assert.strictEqual(hasResearchCard, false, 'stale Research response must not create evidence cards');
    fs.writeFileSync(path.join(copyRoot, 'edit.md'), editBefore, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), researchRevisionBefore,
      'Research edit.md revision drift must be zero-write');
    console.log('    Author Research revision-drift path passed');

    const researchCancelBefore = snapshotMarkdownFiles(copyRoot);
    await instance.client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.source-card')]
        .find(node => node.textContent.includes(${JSON.stringify(AUTHOR_SOURCE_FILE)}));
      const checkbox = card?.querySelector('input[type="checkbox"]');
      if (!checkbox) return false;
      if (!checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const question = document.getElementById('source-research-question');
      question.value = ${JSON.stringify(fixture.AUTHOR_RESEARCH_CANCEL_QUESTION)};
      question.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('source-research-run').click();
      return true;
    })()`);
    await waitForLog(instance.logRef, 'AUTHOR_RESEARCH_CANCEL_PROVIDER_CALL', 'author Research cancellation provider call', 15_000);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress .ai-task-progress-cancel')`,
      'author Research cancellation affordance', 22_000);
    await instance.client.evaluate(`document.querySelector('#ai-task-progress .ai-task-progress-cancel')?.click()`);
    await waitForValue(instance.client,
      `document.querySelector('#ai-task-progress[data-status="cancelled"]')?.textContent.includes('已取消，未写入文件')`,
      'author Research cancelled terminal');
    assert.deepStrictEqual(snapshotMarkdownFiles(copyRoot), researchCancelBefore,
      'cancelled Research zero-write');
    await waitForLog(instance.logRef, 'AUTHOR_RESEARCH_CANCEL_PROVIDER_COMPLETE', 'author Research cancellation provider completion', 25_000);
    assert(!((await instance.client.evaluate(`document.body.textContent || ''`))
      .includes(fixture.AUTHOR_RESEARCH_CANCEL_RESPONSE)),
      'late cancelled Research answer must be discarded');

    await instance.client.evaluate(`(() => {
      const question = document.getElementById('source-research-question');
      question.value = '这份材料能支持什么主张？';
      question.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('source-research-run').click();
    })()`);
    await waitForValue(instance.client,
      `document.querySelector('.research-card .research-claim')?.textContent.includes('附条件试运行')`,
      'author Research evidence card');
    const researchManifest = await instance.client.evaluate(`(() => {
      const manifest = window.__sourcesView?.getResearchContextManifest?.();
      const node = document.querySelector('.research-context-manifest');
      return manifest ? {
        text: node?.textContent || '',
        sourceIndexRevision: manifest.sourceIndexRevision || '',
        projectPrompt: manifest.projectPrompt || null,
        totalBytes: manifest.totalBytes,
        sources: manifest.sources || [],
        omissionReason: manifest.omissionReason || null,
        unified: manifest.unified || null,
      } : null;
    })()`);
    assert(researchManifest, 'author Research must disclose its Main-owned context manifest');
    assert(researchManifest.text.includes('edit.md revision'));
    assert.strictEqual(researchManifest.projectPrompt.revision, editSnapshot.revision,
      'author Research manifest must bind the current edit.md revision');
    assert.strictEqual(researchManifest.projectPrompt.bytes, Buffer.byteLength(editBefore, 'utf8'),
      'Research edit.md bytes must match the bound project prompt');
    assert(Number.isSafeInteger(researchManifest.totalBytes) && researchManifest.totalBytes > 0,
      'Research manifest must expose a bounded byte budget');
    assert(Array.isArray(researchManifest.sources) && researchManifest.sources.length > 0,
      'Research manifest must expose selected source metadata');
    assert(researchManifest.sourceIndexRevision, 'author Research manifest must bind a source-index revision');
    assert(researchManifest.unified, 'author Research must publish the unified Context Manifest envelope');
    assert.strictEqual(researchManifest.unified.entry, 'research');
    assert.strictEqual(researchManifest.unified.editRevision, editSnapshot.revision);
    assert.strictEqual(researchManifest.unified.editCompilation.budgetBytes, 18 * 1024);
    assert.strictEqual(researchManifest.unified.editCompilation.omissionReason, null);
    assert(researchManifest.unified.items.some(item => item.kind === 'source' && item.status === 'included'));
    assert(researchManifest.unified.items.every(item => !String(item.path || '').startsWith('/')));
    console.log('    Research card ready');
    const researchBefore = projectService.readFile(copyRoot, CHAPTER_TARGET);
    console.log('    Opening Research source');
    await instance.client.evaluate(`document.querySelector('.research-card .research-source').click()`);
    try {
      await waitForValue(instance.client,
        `[...document.querySelectorAll('.research-card .research-judgment-option')].every(button => !button.disabled)`,
        'author Research source inspection', 30_000);
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        currentPath: window.__workspace?.state?.currentPath || '',
        source: document.querySelector('.research-card .research-source')?.outerHTML || '',
        stale: [...document.querySelectorAll('.research-card .research-boundary')].map(node => ({ hidden: node.hidden, text: node.textContent })),
        judgments: [...document.querySelectorAll('.research-card .research-judgment-option')].map(button => ({ text: button.textContent, disabled: button.disabled })),
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-6000))}`;
      throw error;
    }
    console.log('    Research source open');
    await instance.client.evaluate(`(() => {
      const card = document.querySelector('.research-card');
      [...card.querySelectorAll('.research-judgment-option')]
        .find(button => button.textContent === '主张匹配').click();
    })()`);
    await waitForValue(instance.client,
      `[...document.querySelectorAll('.research-card .research-judgment-option')].find(button => button.textContent === '主张匹配')?.getAttribute('aria-pressed') === 'true'`,
      'author Research matched judgment');
    console.log('    Research judgment recorded');
    console.log('    Opening Research Changes handoff');
    await instance.client.evaluate(`document.querySelector('.research-card .research-to-changes').click()`);
    await waitForValue(instance.client,
      `(() => {
        const banner = document.querySelector('.changes-research-mode');
        return window.__assistantDock.getMode() === 'changes' && Boolean(banner) && banner.hidden === false;
      })()`,
      'author Research to Changes');
    console.log('    Research Changes mode ready');
    console.log('    Selecting Research target');
    const selectedResearchTarget = await instance.client.evaluate(`(() => {
      const target = document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(CHAPTER_TARGET)}]');
      if (!target) return false;
      if (target.disabled) return false;
      if (!target.checked) {
        // Use the browser's real click path so the Renderer-owned selection
        // reducer receives the same change event as an author click.
        target.click();
      }
      return true;
    })()`);
    assert.strictEqual(selectedResearchTarget, true, 'author Research target must be present');
    const selectedTargetState = await instance.client.evaluate(`(() => ({
      count: document.getElementById('project-changes-target-count')?.textContent || '',
      checked: document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(CHAPTER_TARGET)}]')?.checked || false,
      disabled: document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(CHAPTER_TARGET)}]')?.disabled || false,
    }))()`);
    console.log(`    Research target selection state: ${JSON.stringify(selectedTargetState)}`);
    await waitForValue(instance.client,
      `document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(CHAPTER_TARGET)}]')?.checked === true`,
      'author Research target selection');
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('    Generating Research Diff');
    await instance.client.evaluate(`document.getElementById('changes-propose').click()`);
    try {
      await waitForValue(instance.client,
        `document.querySelector('#changes-preview .change-hunk-card') && document.getElementById('changes-status')?.textContent.includes('当前仅为预览')`,
        'author Research Diff preview');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        mode: window.__assistantDock.getMode(),
        banner: document.querySelector('.changes-research-mode')?.outerHTML || '',
        status: document.getElementById('changes-status')?.textContent || '',
        preview: document.getElementById('changes-preview')?.textContent || '',
        targets: [...document.querySelectorAll('#project-changes-target-list input')].map(input => ({ path: input.dataset.path, checked: input.checked })),
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-6000))}`;
      throw error;
    }
    assert.strictEqual(projectService.readFile(copyRoot, CHAPTER_TARGET), researchBefore,
      'author Research preview zero-write');
    assert.strictEqual(projectService.readFile(copyRoot, 'edit.md'), editBefore,
      'author Research keeps edit.md readonly');
    await instance.client.evaluate(`(() => {
      [...document.querySelectorAll('#changes-preview .change-hunk-actions button')]
        .find(button => button.textContent === '接受').click();
      document.getElementById('changes-apply').click();
    })()`);
    await waitForValue(instance.client,
      `document.getElementById('changes-status')?.textContent.includes('Research 修改已安全应用 1 个文件')`,
      'author Research accepted write');
    const researchAfter = projectService.readFile(copyRoot, CHAPTER_TARGET);
    assert(researchAfter.includes(fixture.RESEARCH_AFTER));
    assert(!researchAfter.includes(fixture.RESEARCH_BEFORE));
    assert.strictEqual(projectService.readFile(copyRoot, 'edit.md'), editBefore);
    await undoLatest(instance.client, 'author Research Safe Undo');
    assert.strictEqual(projectService.readFile(copyRoot, CHAPTER_TARGET), researchBefore);

    // Graph: the derived chapter contains an explicit three-edge timeline
    // cycle. The issue handoff must stay locked to Changes and require every
    // hunk before one safe write.
    const graphBefore = projectService.readFile(copyRoot, AUTHOR_TARGET);
    await instance.client.evaluate(`(() => {
      const scope = document.getElementById('graph-scope');
      scope.value = 'project';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      window.__graphView.open();
    })()`);
    await waitForValue(instance.client, `(() => [...document.querySelectorAll('.issue-card')].some(card =>
      card.textContent.includes('时间先后关系形成闭环') && card.querySelector('.issue-suggest-fix:not(:disabled)'))
    )()`, 'author Graph timeline issue');
    await instance.client.evaluate(`(() => {
      const card = [...document.querySelectorAll('.issue-card')]
        .find(node => node.textContent.includes('时间先后关系形成闭环'));
      card.querySelector('.issue-suggest-fix').click();
    })()`);
    await waitForValue(instance.client,
      "document.querySelector('#ai-task-progress .ai-task-progress-cancel')",
      'author Graph cancellation affordance', 22_000);
    await instance.client.evaluate("document.querySelector('#ai-task-progress .ai-task-progress-cancel')?.click()");
    await waitForValue(instance.client,
      "document.querySelector('#ai-task-progress[data-status=\"cancelled\"]')?.textContent.includes('已取消，未写入文件')",
      'author Graph cancelled terminal');
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), graphBefore,
      'cancelled Graph zero-write');
    await waitForLog(instance.logRef, 'GRAPH_ISSUE_PROVIDER_COMPLETE', 'author Graph provider completion latch');
    assert(!((await instance.client.evaluate(`document.body.textContent || ''`)) || '').includes(fixture.GRAPH_ISSUE_AFTER_ONE),
      'late cancelled Graph result must not enter UI');
    await waitForValue(instance.client,
      "document.querySelector('.changes-issue-mode')?.hidden === true",
      'author Graph cancellation releases issue owner');
    await instance.client.evaluate("(() => { const card = [...document.querySelectorAll('.issue-card')].find(node => node.textContent.includes('时间先后关系形成闭环')); card.querySelector('.issue-suggest-fix').click(); })()");
    try {
      await waitForValue(instance.client, `(() => {
        const banner = document.querySelector('.changes-issue-mode');
        return banner && !banner.hidden && document.querySelectorAll('.change-hunk-card').length >= 1 ? banner : null;
      })()`, 'author Graph locked Changes review', 30_000);
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        mode: window.__assistantDock.getMode(),
        banner: document.querySelector('.changes-issue-mode')?.outerHTML || '',
        status: document.getElementById('changes-status')?.textContent || '',
        preview: document.getElementById('changes-preview')?.textContent || '',
        issueCardCount: document.querySelectorAll('.issue-card').length,
        bodyTextLength: document.body.textContent.length,
      }))()`).catch(() => null);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}; log=${JSON.stringify(instance.logRef.value.slice(-6000))}`;
      throw error;
    }
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), graphBefore,
      'author Graph preview zero-write');
    await instance.client.evaluate(`(() => {
      for (const card of document.querySelectorAll('.change-hunk-card')) {
        card.querySelector('.change-decision--accepted').click();
      }
      document.getElementById('changes-apply').click();
    })()`);
    await waitForValue(instance.client,
      `document.getElementById('changes-status')?.textContent.includes('星图问题修复已安全写入')`,
      'author Graph accepted write');
    const graphAfter = projectService.readFile(copyRoot, AUTHOR_TARGET);
    assert(graphAfter.includes(fixture.GRAPH_ISSUE_AFTER_ONE));
    assert(graphAfter.includes(fixture.GRAPH_ISSUE_AFTER_TWO));
    assert(!graphAfter.includes(fixture.GRAPH_ISSUE_BEFORE_ONE));
    await undoLatest(instance.client, 'author Graph Safe Undo');
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), graphBefore);
    await instance.client.evaluate(`window.__assistantDock.close()`);

    // Image generation is a preview-only asset operation until the author
    // rates and chooses an explicit terminal action. Trash must not insert a
    // prompt/path into Markdown.
    await openFile(instance.client, AUTHOR_TARGET);
    const imageMarkdownBefore = projectService.readFile(copyRoot, AUTHOR_TARGET);
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="chat"]').click();
      document.getElementById('image-toggle').click();
      const prompt = document.getElementById('image-prompt');
      prompt.value = ${JSON.stringify(fixture.IMAGE_PROMPT)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('image-generate').click();
    })()`);
    await waitForValue(instance.client,
      "document.querySelector('#ai-task-progress .ai-task-progress-cancel')",
      'author image cancellation affordance', 22_000);
    await instance.client.evaluate("document.querySelector('#ai-task-progress .ai-task-progress-cancel')?.click()");
    await waitForValue(instance.client,
      "document.querySelector('#ai-task-progress[data-status=\"cancelled\"]')?.textContent.includes('已取消，未写入文件')",
      'author image cancelled terminal');
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), imageMarkdownBefore,
      'cancelled image zero-write');
    await waitForLog(instance.logRef, 'IMAGE_PROVIDER_COMPLETE', 'author image provider completion latch');
    assert.strictEqual(await instance.client.evaluate(`Boolean(document.querySelector('#image-result .image-preview'))`), false,
      'late cancelled image result must not enter UI');
    await instance.client.evaluate("document.getElementById('image-generate')?.click()");
    await waitForValue(instance.client, `(() => {
      const image = document.querySelector('#image-result .image-preview');
      const note = document.querySelector('#image-result .image-result-note');
      return image?.complete && image.naturalWidth === 16 && image.naturalHeight === 9 &&
        note?.textContent.includes('尚未插入正文') ? true : null;
    })()`, 'author image preview');
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), imageMarkdownBefore);
    await instance.client.evaluate(`(() => {
      const rating = document.querySelector('#image-result .image-rating');
      rating.value = '3';
      rating.dispatchEvent(new Event('change', { bubbles: true }));
      const button = [...document.querySelectorAll('#image-result .image-result-actions button')]
        .find(node => node.textContent === '移入废纸篓');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitForValue(instance.client,
      `document.querySelector('#image-result .image-state')?.textContent.includes('已移入图片废纸篓')`,
      'author image trash terminal');
    assert.strictEqual(projectService.readFile(copyRoot, AUTHOR_TARGET), imageMarkdownBefore,
      'trashed image must not modify Markdown');
    assert(!projectService.readFile(copyRoot, AUTHOR_TARGET).includes(fixture.IMAGE_PROMPT));

    // Repeat the preview with an explicit insert decision. This is the
    // complementary author path to trash: only the allowed generated asset
    // and current Markdown target may change, and Safe Undo must restore the
    // exact pre-insert bytes.
    await instance.client.evaluate(`(() => {
      document.getElementById('image-prompt').value = ${JSON.stringify(fixture.IMAGE_PROMPT)};
      document.getElementById('image-prompt').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('image-generate').click();
    })()`);
    await waitForValue(instance.client, `(() => {
      const image = document.querySelector('#image-result .image-preview');
      return image?.complete && image.naturalWidth === 16 && image.naturalHeight === 9 ? true : null;
    })()`, 'author image insert preview');
    const insertBefore = projectService.readFile(copyRoot, AUTHOR_TARGET);
    await instance.client.evaluate(`(() => {
      const rating = document.querySelector('#image-result .image-rating');
      rating.value = '4';
      rating.dispatchEvent(new Event('change', { bubbles: true }));
      const button = [...document.querySelectorAll('#image-result .image-result-actions button')]
        .find(node => node.textContent === '插入当前正文');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitForValue(instance.client,
      `document.querySelector('#image-result .image-state')?.textContent.includes('已插入正文')`,
      'author image insert terminal');
    const insertedMarkdown = projectService.readFile(copyRoot, AUTHOR_TARGET);
    assert.notStrictEqual(insertedMarkdown, insertBefore, 'inserted image must update current Markdown');
    assert.match(insertedMarkdown, /assets\/generated\/image-[a-f0-9]{64}\.(?:png|jpg)/);
    assert.strictEqual(projectService.readFile(copyRoot, 'edit.md'), editBefore,
      'image insertion keeps edit.md readonly');
    // Image insertion uses the existing workspace persistence gate rather
    // than a Changes capability, so it has no History undo card of its own.
    // Safe Undo is covered by the Chapter/Research/Graph Changes paths above;
    // here we verify the image-specific allowed-write boundary instead.

    const externalRequests = instance.networkRequests.filter(url =>
      /^https?:/i.test(url) && !url.startsWith('https://api.minimaxi.com/'));
    assert.deepStrictEqual(externalRequests, [], `unexpected external requests: ${JSON.stringify(externalRequests)}`);
    const finalSnapshot = snapshotMarkdownFiles(copyRoot);
    const beforeWithoutImageTarget = copyBefore.filter(([filePath]) => filePath !== AUTHOR_TARGET);
    const finalWithoutImageTarget = finalSnapshot.filter(([filePath]) => filePath !== AUTHOR_TARGET);
    assert.deepStrictEqual(finalWithoutImageTarget, beforeWithoutImageTarget,
      'image insertion must not modify unrelated Markdown files');
    assert(projectService.readFile(copyRoot, AUTHOR_TARGET).includes('assets/generated/image-'),
      'image insertion must leave the allowed generated asset reference in the target');
    assert.deepStrictEqual(snapshotMarkdownFiles(sourceRoot), sourceBefore,
      'selected author source must remain unchanged');
    console.log('✅ Real author affected Electron 1/1 passed; Chat cancellation, Chapter, Research, Graph, image trash, zero-write previews and Safe Undo verified');
  } finally {
    await stopElectron(instance).catch(() => {});
    assert.deepStrictEqual(snapshotMarkdownFiles(sourceRoot), sourceBefore,
      'selected author source must remain unchanged after cleanup');
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
