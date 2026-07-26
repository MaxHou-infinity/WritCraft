#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const tabs = require('../src/renderer/file-lifecycle-state');
const workspace = fs.readFileSync(path.join(V0, 'src/renderer/workspace.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
let passed = 0;

function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${label}: ${error.stack || error.message}`); }
}

console.log('════════ WritCraft V0 · Cursor-style tab semantics ════════');

test('单击首次打开一个 preview 标签', () => {
  const result = tabs.preview({ tabs: ['edit.md'], previewPath: null }, 'chapters/a.md');
  assert.deepEqual(result.tabs, ['edit.md', 'chapters/a.md']);
  assert.equal(result.previewPath, 'chapters/a.md');
});

test('后续单击在原位置替换唯一 preview，不累积标签', () => {
  const result = tabs.preview({
    tabs: ['edit.md', 'chapters/a.md', 'notes.md'],
    previewPath: 'chapters/a.md',
  }, 'chapters/b.md');
  assert.deepEqual(result.tabs, ['edit.md', 'chapters/b.md', 'notes.md']);
  assert.equal(result.previewPath, 'chapters/b.md');
});

test('单击已固定文件只选择，不把它降级成 preview', () => {
  const state = { tabs: ['edit.md', 'preview.md', 'fixed.md'], previewPath: 'preview.md' };
  const result = tabs.preview(state, 'fixed.md');
  assert.deepEqual(result.tabs, state.tabs);
  assert.equal(result.previewPath, 'preview.md');
});

test('双击或开始编辑固定 preview，且同一文件永远只有一个标签', () => {
  const fixed = tabs.pin({ tabs: ['edit.md', 'draft.md'], previewPath: 'draft.md' }, 'draft.md');
  assert.deepEqual(fixed.tabs, ['edit.md', 'draft.md']);
  assert.equal(fixed.previewPath, null);
  const repeated = tabs.pin({ tabs: ['edit.md', 'draft.md', 'draft.md'], previewPath: null }, 'draft.md');
  assert.deepEqual(repeated.tabs, ['edit.md', 'draft.md']);
});

test('固定其他文件不会错误清除当前 preview', () => {
  const result = tabs.pin({ tabs: ['preview.md'], previewPath: 'preview.md' }, 'fixed.md');
  assert.deepEqual(result.tabs, ['preview.md', 'fixed.md']);
  assert.equal(result.previewPath, 'preview.md');
});

test('改名和回收同步 previewPath、当前文件与视图状态', () => {
  const state = {
    tabs: ['edit.md', 'draft.md'], previewPath: 'draft.md', currentPath: 'draft.md',
    views: { 'draft.md': { cursorOffset: 17, scrollTop: 240 } },
  };
  const moved = tabs.relocate(state, 'draft.md', 'chapters/draft.md');
  assert.equal(moved.previewPath, 'chapters/draft.md');
  assert.equal(moved.currentPath, 'chapters/draft.md');
  assert.deepEqual(moved.views['chapters/draft.md'], { cursorOffset: 17, scrollTop: 240 });
  const removed = tabs.trash(moved, 'chapters/draft.md');
  assert.equal(removed.previewPath, null);
  assert.equal(removed.currentPath, 'edit.md');
  assert.ok(!removed.views['chapters/draft.md']);
});

test('文件树单击 preview、双击固定，并消除 click/dblclick 竞态', () => {
  assert.ok(workspace.includes("setTimeout(() => openFile(path, { preview: true }), 180)"));
  assert.ok(workspace.includes("button.addEventListener('dblclick'"));
  assert.ok(workspace.includes("openFile(path, { pin: true })"));
  assert.ok(workspace.includes('clearTimeout(treeOpenTimer)'));
});

test('dirty 会固定标签并显示单一未保存状态，保存后清除', () => {
  const scheduleStart = workspace.indexOf('function scheduleProjectSave()');
  const openStart = workspace.indexOf('async function openFile(', scheduleStart);
  const block = workspace.slice(scheduleStart, openStart);
  assert.ok(block.includes('state.dirty = true'));
  assert.ok(block.includes('pinTab(state.currentPath)'));
  assert.ok(block.includes('renderTabs()'));
  assert.ok(workspace.includes("tab.classList.toggle('is-dirty', isDirty)"));
  assert.ok(workspace.includes("isDirty ? '，未保存' : ''"));
  assert.ok(workspace.includes("dirty.className = 'tab-dirty'"));
  assert.ok(html.includes('.document-tab.is-dirty .tab-dirty'));
});

test('preview 有视觉/无障碍语义，标签双击也能固定', () => {
  assert.ok(workspace.includes("tab.classList.toggle('is-preview', isPreview)"));
  assert.ok(workspace.includes('预览标签，双击固定'));
  assert.ok(workspace.includes("tab.addEventListener('dblclick'"));
  assert.ok(html.includes('.document-tab.is-preview .tab-label'));
  assert.ok(html.includes('.document-tab:focus-visible'));
});

test('快速切换只提交最新读取，并恢复每文件光标与滚动', () => {
  assert.ok(workspace.includes('const openGeneration = ++state.openGeneration'));
  const firstGuard = workspace.indexOf('if (openGeneration !== state.openGeneration) return false;');
  const recovery = workspace.indexOf('await recoverContent(path', firstGuard);
  const secondGuard = workspace.indexOf('if (openGeneration !== state.openGeneration) return false;', firstGuard + 1);
  assert.ok(firstGuard >= 0 && recovery > firstGuard && secondGuard > recovery);
  assert.ok(workspace.includes('captureCurrentView()'));
  assert.ok(workspace.includes('const view = state.views[path] || {}'));
  assert.ok(workspace.includes('restoreCursor(view.cursorOffset || 0)'));
  assert.ok(workspace.includes('editorScroll.scrollTop = Math.max(0, Number(view.scrollTop) || 0)'));
});

test('新项目重置 preview，持久化恢复的既有 tabs 默认为固定', () => {
  const enter = workspace.slice(workspace.indexOf('async function enterProject'), workspace.indexOf('function presentMigration'));
  assert.ok(enter.includes('state.tabs = []'));
  assert.ok(enter.includes('state.previewPath = null'));
  assert.ok(enter.includes('state.tabs = Array.isArray(saved.workspace.tabs)'));
  assert.ok(!enter.includes('state.previewPath = saved.workspace'));
});

if (!process.exitCode) console.log(`\n✅ Cursor 式标签语义检查 ${passed}/${passed} 全过`);
