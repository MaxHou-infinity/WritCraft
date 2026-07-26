#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const service = require('../src/main/project-service');
const main = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf8');
const workspace = fs.readFileSync(path.join(V0, 'src/renderer/workspace.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
const lifecycleState = require('../src/renderer/file-lifecycle-state');
const graphIndex = require('../src/main/graph-index-service');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-lifecycle-'));
let passed = 0;

function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${label}: ${error.stack || error.message}`); }
}
function throwsCode(fn, code) {
  assert.throws(fn, error => error?.code === code, `应抛出 ${code}`);
}

console.log('════════ WritCraft V0 · Safe file lifecycle verify ════════');
const project = service.createProjectAt(scratch, '生命周期');
service.createMarkdownFile(project.rootPath, 'draft.md', '# 草稿\n');
service.createMarkdownFile(project.rootPath, 'occupied.md', '# 已存在\n');
service.createMarkdownFile(project.rootPath, 'chapters/keep.md', '# 占位\n');

test('重命名排他提交并保留内容与 revision', () => {
  const before = service.readFileWithRevision(project.rootPath, 'draft.md');
  const moved = service.moveMarkdownFile(project.rootPath, 'draft.md', 'renamed.md', before.revision);
  assert.deepEqual([moved.fromPath, moved.path, moved.revision], ['draft.md', 'renamed.md', before.revision]);
  assert.equal(service.readFile(project.rootPath, 'renamed.md'), before.content);
  assert.ok(!fs.existsSync(path.join(project.rootPath, 'draft.md')));
});

test('移动到已有项目目录且不会覆盖目标', () => {
  assert.equal(service.moveMarkdownFile(project.rootPath, 'renamed.md', 'chapters/renamed.md').path, 'chapters/renamed.md');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'chapters/renamed.md', 'occupied.md'), 'FILE_EXISTS');
  assert.equal(service.readFile(project.rootPath, 'occupied.md'), '# 已存在\n');
  assert.equal(service.readFile(project.rootPath, 'chapters/renamed.md'), '# 草稿\n');
});

test('拒绝越界、隐藏路径、非 Markdown 和同路径', () => {
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', '../escape.md'), 'PATH_TRAVERSAL');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', '/tmp/escape.md'), 'ABSOLUTE_PATH');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', '.hidden.md'), 'PRIVATE_PATH');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', 'occupied.txt'), 'INVALID_EXTENSION');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', 'occupied.md'), 'SAME_PATH');
});

test('edit.md 在重命名、移动和回收操作中始终受保护', () => {
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'edit.md', 'prompt.md'), 'EDIT_FILE_PROTECTED');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', 'edit.md'), 'EDIT_FILE_PROTECTED');
  throwsCode(() => service.trashMarkdownFile(project.rootPath, 'edit.md'), 'EDIT_FILE_PROTECTED');
  assert.ok(fs.existsSync(path.join(project.rootPath, 'edit.md')));
});

test('stale revision 在改名提交前停止操作', () => {
  const before = service.readFileWithRevision(project.rootPath, 'occupied.md');
  fs.writeFileSync(path.join(project.rootPath, 'occupied.md'), '# 外部修改\n');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', 'new-name.md', before.revision), 'FILE_CONFLICT');
  assert.ok(fs.existsSync(path.join(project.rootPath, 'occupied.md')));
  assert.ok(!fs.existsSync(path.join(project.rootPath, 'new-name.md')));
});

test('拒绝源文件和目标目录中的符号链接', () => {
  if (process.platform === 'win32') return;
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'outside.md'), '# outside');
  fs.symlinkSync(path.join(outside, 'outside.md'), path.join(project.rootPath, 'linked.md'));
  fs.symlinkSync(outside, path.join(project.rootPath, 'linked-dir'));
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'linked.md', 'safe.md'), 'SYMLINK_NOT_ALLOWED');
  throwsCode(() => service.moveMarkdownFile(project.rootPath, 'occupied.md', 'linked-dir/escape.md'), 'SYMLINK_NOT_ALLOWED');
  assert.ok(!fs.existsSync(path.join(outside, 'escape.md')));
});

let trashEntry;
test('移到项目回收区并写入足够恢复的清单材料', () => {
  const before = service.readFileWithRevision(project.rootPath, 'chapters/renamed.md');
  const result = service.trashMarkdownFile(project.rootPath, 'chapters/renamed.md', before.revision);
  trashEntry = result.trashEntry;
  assert.equal(result.trashed, true);
  assert.equal(trashEntry.originalPath, 'chapters/renamed.md');
  assert.equal(trashEntry.revision, before.revision);
  assert.equal(trashEntry.bytes, Buffer.byteLength(before.content));
  assert.match(trashEntry.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(trashEntry.trashPath.startsWith('.writcraft/trash/'));
  assert.ok(fs.existsSync(path.join(project.rootPath, ...trashEntry.trashPath.split('/'))));
  const manifest = JSON.parse(fs.readFileSync(path.join(project.rootPath, service.TRASH_MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.schema, service.TRASH_SCHEMA);
  assert.equal(manifest.entries[0].id, trashEntry.id);
  assert.ok(!service.listTree(project.rootPath).some(node => node.name === '.writcraft'));
});

test('可按 manifest 恢复原路径并消费记录', () => {
  const restored = service.restoreTrashedMarkdown(project.rootPath, trashEntry.id);
  assert.equal(service.readFile(project.rootPath, restored.path), '# 草稿\n');
  assert.deepEqual(service.listTrash(project.rootPath), []);
});

test('恢复目标冲突时保留目标、回收文件和清单', () => {
  const trashed = service.trashMarkdownFile(project.rootPath, 'chapters/renamed.md');
  service.createMarkdownFile(project.rootPath, 'chapters/renamed.md', '# 新文件\n');
  throwsCode(() => service.restoreTrashedMarkdown(project.rootPath, trashed.trashEntry.id), 'FILE_EXISTS');
  assert.equal(service.readFile(project.rootPath, 'chapters/renamed.md'), '# 新文件\n');
  assert.ok(fs.existsSync(path.join(project.rootPath, ...trashed.trashEntry.trashPath.split('/'))));
  assert.ok(service.listTrash(project.rootPath).some(entry => entry.id === trashed.trashEntry.id));
});

test('manifest 写失败会回滚回收与恢复，不产生半提交', () => {
  const rollbackProject = service.createProjectAt(scratch, '回滚');
  service.createMarkdownFile(rollbackProject.rootPath, 'rollback.md', '# 不丢失\n');
  const realRename = fs.renameSync;
  fs.renameSync = function (source, target) {
    if (target === path.join(rollbackProject.rootPath, service.TRASH_MANIFEST_FILE)) {
      const error = new Error('injected manifest failure');
      error.code = 'EACCES';
      throw error;
    }
    return realRename.apply(this, arguments);
  };
  try {
    assert.throws(() => service.trashMarkdownFile(rollbackProject.rootPath, 'rollback.md'), error => error?.code === 'EACCES');
  } finally { fs.renameSync = realRename; }
  assert.equal(service.readFile(rollbackProject.rootPath, 'rollback.md'), '# 不丢失\n');
  assert.deepEqual(service.listTrash(rollbackProject.rootPath), []);

  const entry = service.trashMarkdownFile(rollbackProject.rootPath, 'rollback.md').trashEntry;
  fs.renameSync = function (source, target) {
    if (target === path.join(rollbackProject.rootPath, service.TRASH_MANIFEST_FILE)) {
      const error = new Error('injected restore manifest failure');
      error.code = 'EACCES';
      throw error;
    }
    return realRename.apply(this, arguments);
  };
  try {
    assert.throws(() => service.restoreTrashedMarkdown(rollbackProject.rootPath, entry.id), error => error?.code === 'EACCES');
  } finally { fs.renameSync = realRename; }
  assert.ok(!fs.existsSync(path.join(rollbackProject.rootPath, 'rollback.md')));
  assert.ok(fs.existsSync(path.join(rollbackProject.rootPath, ...entry.trashPath.split('/'))));
  assert.ok(service.listTrash(rollbackProject.rootPath).some(item => item.id === entry.id));
});

test('文件移动后 Graph 缓存增量移除旧路径并索引新路径', () => {
  const graphProject = service.createProjectAt(scratch, '图谱同步');
  service.createMarkdownFile(graphProject.rootPath, 'chapters/keep.md', '# 空章节\n');
  service.createMarkdownFile(graphProject.rootPath, 'story.md', '# 人物\n\n人物：林舟\n');
  const first = graphIndex.indexProjectGraph(service, graphProject.rootPath);
  assert.ok(first.graph.manifest.inputFiles.some(file => file.path === 'story.md'));
  service.moveMarkdownFile(graphProject.rootPath, 'story.md', 'chapters/story.md');
  const second = graphIndex.indexProjectGraph(service, graphProject.rootPath);
  assert.equal(second.status, 'incremental');
  assert.ok(second.removedPaths.includes('story.md'));
  assert.ok(second.analyzedPaths.includes('chapters/story.md'));
  assert.ok(!second.graph.manifest.inputFiles.some(file => file.path === 'story.md'));
  assert.ok(second.graph.manifest.inputFiles.some(file => file.path === 'chapters/story.md'));
  assert.ok((second.graph.evidence || []).every(item => item.path !== 'story.md'));
});

test('损坏的 manifest 阻止新增回收且不丢源文件', () => {
  fs.writeFileSync(path.join(project.rootPath, service.TRASH_MANIFEST_FILE), '{broken');
  throwsCode(() => service.trashMarkdownFile(project.rootPath, 'occupied.md'), 'TRASH_MANIFEST_INVALID');
  assert.equal(service.readFile(project.rootPath, 'occupied.md'), '# 外部修改\n');
});

test('Main IPC 仅使用可信当前项目且返回权威树', () => {
  for (const route of ['rename-file', 'move-file', 'trash-file']) {
    const start = main.indexOf(`ipcMain.handle('writcraft:project:${route}'`);
    const end = main.indexOf('\nipcMain.handle(', start + 20);
    const block = main.slice(start, end < 0 ? main.length : end);
    assert.ok(start >= 0 && block.includes('assertTrustedSender(event)'));
    assert.ok(block.includes('requireMutableProject()') && block.includes('project.rootPath'));
    assert.ok(block.includes('lifecycleSuccess(project, file)'));
  }
  assert.ok(main.includes('function lifecycleSuccess(project, file)'));
  assert.ok(main.includes('treeRefreshRequired: true'));
  assert.ok(main.includes('invalidateProjectDerivedState()'));
  assert.ok(main.includes('pendingChangeSets.clear()'));
  assert.ok(main.includes('projectMutationGeneration !== mutationGeneration'));
});

test('Preload 暴露窄参数接口且 renderer 不传 root', () => {
  assert.ok(preload.includes('renameFile: (sourcePath, targetPath, expectedRevision)'));
  assert.ok(preload.includes('moveFile: (sourcePath, targetPath, expectedRevision)'));
  assert.ok(preload.includes('trashFile: (relPath, expectedRevision)'));
  const block = preload.slice(preload.indexOf('project: Object.freeze({'), preload.indexOf('// 未来:'));
  assert.ok(!/rootPath|projectRoot/.test(block));
});

test('纯状态变换同步当前/后台 tabs、views，并为最后正文回落 edit.md', () => {
  const original = {
    tabs: ['edit.md', 'chapters/a.md', 'chapters/b.md'],
    currentPath: 'chapters/a.md',
    views: { 'edit.md': { cursorOffset: 1 }, 'chapters/a.md': { cursorOffset: 9 } },
  };
  const renamed = lifecycleState.relocate(original, 'chapters/a.md', 'chapters/opening.md');
  assert.deepEqual(renamed.tabs, ['edit.md', 'chapters/opening.md', 'chapters/b.md']);
  assert.equal(renamed.currentPath, 'chapters/opening.md');
  assert.deepEqual(renamed.views['chapters/opening.md'], { cursorOffset: 9 });
  assert.ok(!renamed.views['chapters/a.md']);
  assert.equal(original.currentPath, 'chapters/a.md');

  const background = lifecycleState.relocate(original, 'chapters/b.md', 'notes/b.md');
  assert.equal(background.currentPath, 'chapters/a.md');
  const removedCurrent = lifecycleState.trash(original, 'chapters/a.md');
  assert.deepEqual(removedCurrent.tabs, ['edit.md', 'chapters/b.md']);
  assert.equal(removedCurrent.currentPath, 'chapters/b.md');
  const onlyBody = lifecycleState.trash({ tabs: ['only.md'], currentPath: 'only.md', views: {} }, 'only.md');
  assert.deepEqual(onlyBody.tabs, ['edit.md']);
  assert.equal(onlyBody.currentPath, 'edit.md');
});

test('项目树提供右键/更多菜单、flush 和危险确认，并同步工作区', () => {
  assert.ok(workspace.includes("fileButton.addEventListener('contextmenu'"));
  assert.ok(workspace.includes("menu.className = 'tree-file-menu'"));
  assert.ok(workspace.includes('await persistCurrent(true)'));
  assert.ok(workspace.includes('window.confirm(`将“${sourcePath}”移到项目回收区？'));
  assert.ok(workspace.includes('WritCraftFileLifecycleState.relocate'));
  assert.ok(workspace.includes('WritCraftFileLifecycleState.trash'));
  assert.ok(workspace.includes('scheduleWorkspaceSave()'));
  assert.ok(workspace.includes("new CustomEvent('writcraft:tree-changed')"));
  assert.ok(workspace.includes("new CustomEvent('writcraft:file-lifecycle-changed'"));
  assert.ok(workspace.includes('window.__graphView?.close?.()'));
  const changesView = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
  assert.ok(changesView.includes("document.addEventListener('writcraft:file-lifecycle-changed'"));
  assert.ok(changesView.includes('旧提案已失效'));
  assert.ok(html.includes('.tree-file-menu-actions') && html.includes('.tree-file-row:focus-within'));
  assert.ok(html.indexOf('file-lifecycle-state.js') < html.indexOf('workspace.js'));
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
if (!process.exitCode) console.log(`\n✅ 安全文件生命周期检查 ${passed}/${passed} 全过`);
