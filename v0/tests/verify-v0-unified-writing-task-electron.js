#!/usr/bin/env node
'use strict';

// Focused Stage-E journey for the public unified task.  Keeping this path
// independent from the 38-stage harness gives us a reliable author-facing
// proof for the contract that matters here: one primary action, an inline
// zero-write Diff, explicit review, and Safe Undo.  The provider is the
// deterministic local fixture; no manuscript or credential leaves the App.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const longformFixture = require('./fixtures/writcraft-longform-project');
const fixture = require('./fixtures/electron-ai-provider');
const {
  launchElectron,
  stopElectron,
  skipReason,
  waitForRenderer,
  waitForValue,
} = require('./verify-v0-electron-e2e');

function snapshotMarkdownFiles(rootPath) {
  const paths = [];
  const visit = nodes => {
    for (const node of nodes || []) {
      if (node?.type === 'directory') visit(node.children);
      else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) paths.push(node.path);
    }
  };
  visit(projectService.listTree(rootPath));
  return paths.sort().map(filePath => [filePath, projectService.readFile(rootPath, filePath)]);
}

async function run() {
  const unavailable = skipReason();
  if (unavailable) {
    console.log(`SKIP: ${unavailable}`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-unified-task-e2e-'));
  const project = longformFixture.buildLongformProject({ parentPath: scratch, projectService });
  const targetPath = 'chapters/07-unified-task.md';
  const targetFile = path.join(project.rootPath, ...targetPath.split('/'));
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `# Unified task\n\n${fixture.UNIFIED_BEFORE}\n`, 'utf8');

  let instance = null;
  try {
    instance = await launchElectron(scratch, project.rootPath);
    await waitForRenderer(instance.client);
    await waitForValue(instance.client, `(() => {
      const state = window.__workspace?.state;
      return state?.projectReady === true && state.currentPath ? true : null;
    })()`, 'unified task project readiness');
    await instance.client.evaluate(`window.__workspace.openFile(${JSON.stringify(targetPath)})`);
    await waitForValue(instance.client, `window.__workspace.state.currentPath === ${JSON.stringify(targetPath)}`,
      'unified task target file');

    const before = snapshotMarkdownFiles(project.rootPath);
    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="navigation"]').click()`);
    await waitForValue(instance.client, `document.querySelector('#writing-navigation-host textarea')`,
      'writing navigation input');
    await instance.client.evaluate(`(() => {
      const host = document.getElementById('writing-navigation-host');
      const goal = host.querySelector('textarea');
      goal.value = ${JSON.stringify(fixture.UNIFIED_NAVIGATION_GOAL)};
      goal.dispatchEvent(new Event('input', { bubbles: true }));
      host.querySelector('[data-navigation-action="generate"]').click();
    })()`);
    await waitForValue(instance.client, `document.querySelector('.writing-navigation__suggestion .writing-navigation__primary')?.textContent === '处理这个建议'`,
      'one primary unified task action');

    const suggestionProof = await instance.client.evaluate(`(() => ({
      primaryCount: [...document.querySelectorAll('.writing-navigation__suggestion .writing-navigation__primary')]
        .filter(node => node.textContent === '处理这个建议').length,
      planTab: Boolean(document.querySelector('[data-assistant-mode="plan"]')),
      diskBefore: document.getElementById('editor')?.textContent || '',
    }))()`);
    assert.strictEqual(suggestionProof.primaryCount, 1);
    assert.strictEqual(suggestionProof.planTab, false);

    await instance.client.evaluate(`document.querySelector('.writing-navigation__suggestion .writing-navigation__primary').click()`);
    await waitForValue(instance.client, `document.querySelector('.changes-inline-review')?.textContent.includes(${JSON.stringify(fixture.UNIFIED_AFTER)})`,
      'inline unified task Diff');
    const preview = await instance.client.evaluate(`(() => ({
      stage: document.querySelector('.writing-navigation__task-stage')?.textContent || '',
      writeState: document.querySelector('.writing-navigation__write-state')?.textContent || '',
      hasRemove: Boolean(document.querySelector('.changes-inline-review__text.is-remove[aria-label="AI 建议删除"]')),
      hasAdd: Boolean(document.querySelector('.changes-inline-review__text.is-add[aria-label="AI 建议新增"]')),
    }))()`);
    assert.deepStrictEqual(preview, {
      stage: 'Diff 已显示在正文编辑区',
      writeState: '尚未写入；接受后才会修改文件',
      hasRemove: true,
      hasAdd: true,
    });
    assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), before,
      'preview must not write manuscript bytes');

    await instance.client.evaluate(`(() => {
      const hunk = document.querySelector('.changes-inline-review__hunk');
      [...hunk.querySelectorAll('button')].find(node => node.textContent === '拒绝').click();
      [...document.querySelectorAll('.changes-inline-review__toolbar button')]
        .find(node => node.textContent === '确认并写入').click();
    })()`);
    await waitForValue(instance.client, `document.querySelector('.writing-navigation__task-stage')?.textContent === '本次审阅已经结束' && !document.querySelector('.changes-inline-review')`,
      'rejected unified task');
    assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), before,
      'reject must remain zero-write');

    await instance.client.evaluate(`document.querySelector('[data-navigation-action="generate"]').click()`);
    await waitForValue(instance.client, `document.querySelector('.writing-navigation__suggestion .writing-navigation__primary')?.textContent === '处理这个建议'`,
      'second unified task suggestion');
    await instance.client.evaluate(`document.querySelector('.writing-navigation__suggestion .writing-navigation__primary').click()`);
    await waitForValue(instance.client, `document.querySelector('.changes-inline-review')?.textContent.includes(${JSON.stringify(fixture.UNIFIED_AFTER)})`,
      'second inline unified task Diff');
    await instance.client.evaluate(`(() => {
      const hunk = document.querySelector('.changes-inline-review__hunk');
      [...hunk.querySelectorAll('button')].find(node => node.textContent === '接受').click();
      [...document.querySelectorAll('.changes-inline-review__toolbar button')]
        .find(node => node.textContent === '确认并写入').click();
    })()`);
    await waitForValue(instance.client, `document.querySelector('.writing-navigation__task-stage')?.textContent === '修改已经写入项目文件' && window.__editor.getContent().includes(${JSON.stringify(fixture.UNIFIED_AFTER)})`,
      'accepted unified task');
    const committed = projectService.readFile(project.rootPath, targetPath);
    assert(committed.includes(fixture.UNIFIED_AFTER));
    assert(!committed.includes(fixture.UNIFIED_BEFORE));

    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="changes"]').click();
      window.__unifiedTaskOriginalConfirm = window.confirm;
      window.confirm = () => true;
    })()`);
    await waitForValue(instance.client, `document.querySelector('.history-card.is-latest .history-undo')`, 'Safe Undo control');
    await instance.client.evaluate(`document.querySelector('.history-card.is-latest .history-undo').click()`);
    await instance.client.evaluate(`document.querySelector('[data-assistant-mode="navigation"]').click()`);
    await waitForValue(instance.client, `document.querySelector('.writing-navigation__task-stage')?.textContent === '这次写入已经安全撤销' && window.__editor.getContent().includes(${JSON.stringify(fixture.UNIFIED_BEFORE)})`,
      'Safe Undo terminal state');
    assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), before,
      'Safe Undo must restore the exact pre-task manuscript');
    await instance.client.evaluate(`(() => {
      window.confirm = window.__unifiedTaskOriginalConfirm;
      delete window.__unifiedTaskOriginalConfirm;
    })()`);
    console.log('✅ Real Electron unified writing task 1/1 passed; one-click Diff, zero-write review, reject/accept and Safe Undo verified');
  } finally {
    await stopElectron(instance).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
