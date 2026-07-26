#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
const helper = require(path.join(V0, 'src/renderer/composer-context.js'));
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
const changes = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
const workspace = fs.readFileSync(path.join(V0, 'src/renderer/workspace.js'), 'utf8');
let passed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

const tree = [
  { type: 'file', path: 'edit.md' },
  { type: 'file', path: 'README.txt' },
  { type: 'directory', path: 'chapters', children: [
    { type: 'file', path: 'chapters/current.md' },
    { type: 'file', path: 'chapters/one.md' },
    { type: 'file', path: 'chapters/two.markdown' },
    { type: 'file', path: 'chapters/.private.md' },
  ] },
  { type: 'directory', path: 'references', children: [
    { type: 'file', path: 'references/source.md' },
  ] },
  { type: 'symlink', path: 'linked.md' },
];

console.log('════════ WritCraft V0 · Composer context UI verify ════════');

check('从项目树稳定列出公开 Markdown，排除当前目标和自动带入的 edit.md', () => {
  assert.deepEqual(helper.availableContextPaths(tree, 'chapters/current.md'), [
    'chapters/one.md',
    'chapters/two.markdown',
    'references/source.md',
  ]);
  assert.ok(!helper.collectMarkdownPaths(tree).includes('linked.md'));
  assert.ok(!helper.collectMarkdownPaths(tree).includes('chapters/.private.md'));
});

check('默认无额外文件，树变化时仅保留仍有效选择', () => {
  const available = helper.availableContextPaths(tree, 'chapters/current.md');
  assert.deepEqual(helper.reconcileSelection([], available), []);
  assert.deepEqual(
    helper.reconcileSelection(['references/source.md', 'gone.md', 'chapters/one.md'], available),
    ['references/source.md', 'chapters/one.md']
  );
});

check('上下文硬上限为 8，第 9 个不改变已选集合', () => {
  const available = Array.from({ length: 10 }, (_, index) => `chapters/${index}.md`);
  let selected = [];
  for (const filePath of available.slice(0, 8)) {
    const result = helper.updateSelection(selected, filePath, true, available);
    assert.equal(result.ok, true);
    selected = result.selected;
  }
  const ninth = helper.updateSelection(selected, available[8], true, available);
  assert.equal(ninth.ok, false);
  assert.equal(ninth.error, 'CONTEXT_LIMIT');
  assert.deepEqual(ninth.selected, selected);
  const removed = helper.updateSelection(selected, available[2], false, available);
  assert.equal(removed.selected.length, 7);
});

check('目标切换时原已选目标会被立即移除', () => {
  const before = helper.availableContextPaths(tree, 'chapters/current.md');
  const selected = helper.reconcileSelection(['chapters/one.md', 'references/source.md'], before);
  const after = helper.availableContextPaths(tree, 'chapters/one.md');
  assert.deepEqual(helper.reconcileSelection(selected, after), ['references/source.md']);
});

check('Composer 面板显示数量、每项路径与 edit.md 自动带入说明', () => {
  for (const id of ['composer-context-picker', 'composer-context-count', 'composer-context-list']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  assert.ok(html.includes('edit.md 由 Main 始终单独带入'));
  assert.ok(html.includes('最多选择 8 个'));
  assert.ok(changes.includes('pathText.textContent = filePath'));
  assert.ok(changes.includes('contextCount.textContent = `${selectedContextPaths.length} / 8`'));
  assert.ok(html.indexOf('composer-context.js') < html.indexOf('changes-view.js'));
});

check('生成章节传递选中 contextPaths，且调用前强制 flush 当前文件', () => {
  const start = changes.indexOf('async function proposeChapter()');
  const end = changes.indexOf('async function applySelected()', start);
  const chapter = changes.slice(start, end);
  assert.ok(chapter.includes('const contextPaths = refreshContextPicker()'));
  assert.ok(chapter.includes('await window.__workspace.persistCurrent(true)'));
  assert.ok(chapter.includes("schema: 'writcraft.chapter-generation-request/v1'"));
  assert.ok(chapter.includes('bridge.proposeChapter(metric.originProjectInstanceId, chapterSession.request)'));
  assert.ok(
    chapter.indexOf('await window.__workspace.persistCurrent(true)') < chapter.indexOf('bridge.proposeChapter(metric.originProjectInstanceId, chapterSession.request)'),
    '必须先 flush 再请求生成'
  );
  assert.ok(changes.includes('contextPaths.join'));
});

check('跨文件修改传递显式 target/context 的 exact request', () => {
  const start = changes.indexOf('async function propose()');
  const end = changes.indexOf('async function proposeChapter()', start);
  const crossFile = changes.slice(start, end);
  assert.ok(crossFile.includes('bridge.proposeChanges(metric.originProjectInstanceId, request)'));
  assert.ok(crossFile.includes('currentNormalRequest()'));
  assert.ok(crossFile.includes('renderNormalScopePlan(request)'));
});

check('项目切换清空选择，树/当前文件变化都刷新候选', () => {
  assert.match(changes, /document\.addEventListener\('writcraft:project-entered',[\s\S]*?refreshContextPicker\(true\);[\s\S]*?\}\);/);
  assert.match(changes, /document\.addEventListener\('writcraft:tree-changed',[\s\S]*?refreshContextPicker\(\)/);
  assert.match(changes, /document\.addEventListener\('writcraft:current-file-changed',[\s\S]*?refreshContextPicker\(\)/);
  assert.ok(workspace.includes("new CustomEvent('writcraft:tree-changed')"));
  assert.ok(workspace.includes("new CustomEvent('writcraft:current-file-changed'"));
});

check('纯逻辑模块不依赖 DOM、IPC 或真实 API', () => {
  const source = fs.readFileSync(path.join(V0, 'src/renderer/composer-context.js'), 'utf8');
  for (const forbidden of ['document.', 'window.', 'ipcRenderer', 'fetch(', 'proposeChapter']) {
    assert.ok(!source.includes(forbidden), `不应依赖 ${forbidden}`);
  }
});

if (!process.exitCode) console.log(`\n✅ Composer 上下文 ${passed}/${passed} 全过`);
