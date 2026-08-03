#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const V0 = path.join(__dirname, '..');
const service = require(path.join(V0, 'src/main/project-service.js'));
const mainSource = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-workspace-test-'));
const userData = path.join(scratch, 'user-data');
fs.mkdirSync(userData);
let pass = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `应抛出 ${code}`);
}

console.log('════════ WritCraft V0 · Workspace persistence verify ════════');

const project = service.createProjectAt(scratch, '恢复测试');
service.createMarkdownFile(project.rootPath, 'chapters/01.md');
service.createMarkdownFile(project.rootPath, 'notes.md');

const position = (caretOffset = 0, scrollTop = 0) => ({
  caretOffset,
  selectionAnchorOffset: caretOffset,
  selectionFocusOffset: caretOffset,
  scrollTop,
  activeOutlineId: null,
  collapsedOutlineIds: [],
});

check('新项目初始化 schema v2 工作区', () => {
  const disk = JSON.parse(fs.readFileSync(path.join(project.rootPath, service.WORKSPACE_FILE), 'utf8'));
  assert.equal(disk.schema, 'writcraft.workspace/v2');
  assert.equal(disk.schemaVersion, 2);
  assert.deepEqual(service.loadWorkspace(project.rootPath), {
    tabs: ['edit.md'],
    activePath: 'edit.md',
    files: { 'edit.md': position() },
    returnStack: [],
  });
});

check('持久化标签、激活文件、选区、滚动、大纲和返回路径', () => {
  const state = {
    tabs: ['edit.md', 'chapters/01.md'],
    activePath: 'chapters/01.md',
    files: {
      'edit.md': position(12, 24.5),
      'chapters/01.md': {
        ...position(8, 96),
        selectionAnchorOffset: 3,
        activeOutlineId: 'sec_0123456789abcdef',
        collapsedOutlineIds: ['sec_fedcba9876543210'],
      },
    },
    returnStack: [{
      view: 'project_home', stableLocator: null, scrollTop: 18, editorReturnState: null,
    }, {
      view: 'editor', stableLocator: { kind: 'file', path: 'edit.md' }, scrollTop: 0,
      editorReturnState: {
        path: 'edit.md', caretOffset: 12, selectionAnchorOffset: 4,
        selectionFocusOffset: 12, scrollTop: 24.5, revision: 'a'.repeat(64),
      },
    }],
  };
  assert.deepEqual(service.saveWorkspace(project.rootPath, state), state);
  assert.deepEqual(service.loadWorkspace(project.rootPath), state);
  const disk = fs.readFileSync(path.join(project.rootPath, service.WORKSPACE_FILE), 'utf8');
  assert.ok(!disk.includes(project.rootPath), '工作区文件不应存储项目绝对路径');
  assert.deepEqual(fs.readdirSync(path.join(project.rootPath, '.writcraft')).filter(name => name.endsWith('.tmp')), []);
});

check('工作区只接受已存在的公开 Markdown 路径', () => {
  const base = relPath => ({
    tabs: [relPath],
    activePath: relPath,
    files: { [relPath]: position() },
    returnStack: [],
  });
  throwsCode(() => service.saveWorkspace(project.rootPath, base('../outside.md')), 'PATH_TRAVERSAL');
  throwsCode(() => service.saveWorkspace(project.rootPath, base('/tmp/outside.md')), 'ABSOLUTE_PATH');
  throwsCode(() => service.saveWorkspace(project.rootPath, base('.writcraft/project.json')), 'PRIVATE_PATH');
  throwsCode(() => service.saveWorkspace(project.rootPath, base('missing.md')), 'NOT_FOUND');
  throwsCode(() => service.saveWorkspace(project.rootPath, base('image.png')), 'INVALID_EXTENSION');
});

check('拒绝标签外激活文件和非法位置', () => {
  throwsCode(() => service.saveWorkspace(project.rootPath, {
    tabs: ['edit.md'],
    activePath: 'notes.md',
    files: { 'edit.md': position() },
    returnStack: [],
  }), 'INVALID_WORKSPACE');
  throwsCode(() => service.saveWorkspace(project.rootPath, {
    tabs: ['edit.md'],
    activePath: 'edit.md',
    files: { 'edit.md': { ...position(), caretOffset: -1 } },
    returnStack: [],
  }), 'INVALID_WORKSPACE');
});

check('合法 v1 原子迁移为 v2，损坏、未来 schema 或丢失文件不覆盖原记录', () => {
  const target = path.join(project.rootPath, service.WORKSPACE_FILE);
  fs.writeFileSync(target, JSON.stringify({
    schema: 'writcraft.workspace/v1', schemaVersion: 1,
    tabs: ['edit.md', 'chapters/01.md'], activePath: 'chapters/01.md',
    files: { 'edit.md': { cursorOffset: 2, scrollTop: 4 }, 'chapters/01.md': { cursorOffset: 7, scrollTop: 9 } },
  }));
  const migrated = service.loadWorkspace(project.rootPath);
  assert.deepEqual(migrated.files['chapters/01.md'], position(7, 9));
  assert.deepEqual(migrated.returnStack, []);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).schema, 'writcraft.workspace/v2');

  fs.writeFileSync(target, '{broken');
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
  assert.equal(fs.readFileSync(target, 'utf8'), '{broken');
  const future = JSON.stringify({ schema: 'writcraft.workspace/v99', schemaVersion: 99 });
  fs.writeFileSync(target, future);
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
  assert.equal(fs.readFileSync(target, 'utf8'), future);
  fs.writeFileSync(target, JSON.stringify({
    schema: 'writcraft.workspace/v1', schemaVersion: 1,
    tabs: ['gone.md'], activePath: 'gone.md',
    files: { 'gone.md': { cursorOffset: 0, scrollTop: 0 } },
  }));
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).schema, 'writcraft.workspace/v1');
});

check('只读采集可解释 v1，但不会抢占 Main 的迁移写权限', () => {
  const target = path.join(project.rootPath, service.WORKSPACE_FILE);
  const legacy = JSON.stringify({
    schema: 'writcraft.workspace/v1', schemaVersion: 1,
    tabs: ['edit.md'], activePath: 'edit.md',
    files: { 'edit.md': { cursorOffset: 3, scrollTop: 5 } },
  });
  fs.writeFileSync(target, legacy);
  const interpreted = service.loadWorkspace(project.rootPath, { migrate: false });
  assert.equal(interpreted.files['edit.md'].caretOffset, 3);
  assert.equal(interpreted.schema, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), legacy);
});

check('v2 拒绝未知字段、pending 定位和越界返回状态', () => {
  const base = {
    tabs: ['edit.md'], activePath: 'edit.md', files: { 'edit.md': position() }, returnStack: [],
  };
  throwsCode(() => service.saveWorkspace(project.rootPath, { ...base, unknown: true }), 'INVALID_WORKSPACE');
  throwsCode(() => service.saveWorkspace(project.rootPath, {
    ...base,
    returnStack: [{ view: 'changes', stableLocator: { kind: 'pending_review', reviewLocationId: 'x' }, scrollTop: 0, editorReturnState: null }],
  }), 'INVALID_WORKSPACE');
  throwsCode(() => service.saveWorkspace(project.rootPath, {
    ...base,
    files: { 'edit.md': { ...position(), collapsedOutlineIds: Array(129).fill('sec_0123456789abcdef') } },
  }), 'INVALID_WORKSPACE');
});

check('工作区内部文件不允许通过符号链接越界', () => {
  if (process.platform === 'win32') return;
  const unsafe = path.join(scratch, 'unsafe-project');
  const outside = path.join(scratch, 'outside-meta');
  fs.mkdirSync(unsafe);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(unsafe, 'edit.md'), '# safe');
  fs.symlinkSync(outside, path.join(unsafe, '.writcraft'));
  assert.deepEqual(service.loadWorkspace(unsafe).tabs, ['edit.md']);
  throwsCode(() => service.saveWorkspace(unsafe, {
    tabs: ['edit.md'], activePath: 'edit.md',
    files: { 'edit.md': position() }, returnStack: [],
  }), 'SYMLINK_NOT_ALLOWED');
  assert.deepEqual(fs.readdirSync(outside), []);
});

check('最近项目根目录原子保存，损坏记录回退', () => {
  assert.equal(service.loadRecentProject(userData), null);
  service.saveRecentProject(userData, project.rootPath);
  assert.equal(service.loadRecentProject(userData), null, '生产默认不应自动恢复临时 fixture');
  assert.equal(
    service.loadRecentProject(userData, { allowEphemeral: true }),
    project.rootPath,
    '显式 E2E 能力应允许恢复临时 fixture'
  );
  assert.deepEqual(fs.readdirSync(userData).filter(name => name.endsWith('.tmp')), []);
  fs.writeFileSync(path.join(userData, service.RECENT_FILE), '{broken');
  assert.equal(service.loadRecentProject(userData), null);
});

check('最近项目记录拒绝符号链接', () => {
  if (process.platform === 'win32') return;
  const target = path.join(userData, service.RECENT_FILE);
  const outside = path.join(scratch, 'outside-recent.json');
  fs.writeFileSync(outside, JSON.stringify({ rootPath: '/private' }));
  try { fs.unlinkSync(target); } catch (_) {}
  fs.symlinkSync(outside, target);
  assert.equal(service.loadRecentProject(userData), null);
  throwsCode(() => service.saveRecentProject(userData, project.rootPath), 'SYMLINK_NOT_ALLOWED');
  assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).rootPath, '/private');
});

check('openRecent 重新校验持久化路径且不暴露 rootPath', () => {
  for (const route of ['open-recent', 'load-workspace', 'save-workspace']) {
    assert.ok(mainSource.includes(`ipcMain.handle('writcraft:project:${route}'`), `缺少 ${route} IPC`);
  }
  assert.ok(mainSource.includes("ipcMain.on('writcraft:project:save-workspace-before-close'"));
  assert.ok(mainSource.includes("if (projectInstanceId !== project.instanceId)"));
  assert.ok(mainSource.includes('event.returnValue = { ok: true, workspace: saved }'));
  assert.ok(mainSource.includes('operationGeneration <= workspaceSaveGeneration'));
  const recentHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('writcraft:project:open-recent'"),
    mainSource.indexOf("ipcMain.handle('writcraft:project:list'")
  );
  assert.ok(recentHandler.includes('projectService.loadRecentProject'));
  assert.ok(recentHandler.includes('allowEphemeral: Boolean(electronAiFixture)'));
  assert.ok(recentHandler.includes('openProjectRoot(rootPath)'));
  const openHelper = mainSource.slice(
    mainSource.indexOf('function openProjectRoot(rootPath)'),
    mainSource.indexOf("ipcMain.handle('writcraft:rewrite'")
  );
  assert.ok(openHelper.includes('projectService.openProject(rootPath)'));
  assert.ok(openHelper.includes('reopenedSameProject'));
  const listIndex = openHelper.indexOf('projectService.listTree(project.rootPath)');
  const promptIndex = openHelper.indexOf('projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE)');
  const abortIndex = openHelper.indexOf('abortActiveAiRequests();');
  const invalidateIndex = openHelper.indexOf("chatConversationStore.invalidateOwner(chatOwnerId, 'chat_reopened')");
  const setIndex = openHelper.indexOf('setCurrentProject(project)');
  for (const index of [listIndex, promptIndex, abortIndex, invalidateIndex, setIndex]) assert.ok(index >= 0);
  assert.ok(listIndex < abortIndex);
  assert.ok(promptIndex < abortIndex);
  assert.ok(abortIndex < invalidateIndex);
  assert.ok(invalidateIndex < setIndex);
  assert.ok(openHelper.indexOf('projectService.openProject(rootPath)') < openHelper.indexOf('setCurrentProject(project)'));
  assert.ok(openHelper.includes('project: publicProject(project)'));
  const explicitOpenHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('writcraft:project:open'"),
    mainSource.indexOf("ipcMain.handle('writcraft:project:open-recent'")
  );
  assert.ok(explicitOpenHandler.includes('openProjectRoot(result.filePaths[0])'));
  assert.ok(!explicitOpenHandler.includes('loadRecentProject'), '用户显式打开不应经过临时目录恢复过滤');
});

check('preload 仅暴露最小恢复 API', () => {
  assert.ok(preloadSource.includes("openRecent: () => ipcRenderer.invoke('writcraft:project:open-recent')"));
  assert.ok(preloadSource.includes('loadWorkspace: (projectInstanceId) =>'));
  assert.ok(preloadSource.includes("ipcRenderer.invoke('writcraft:project:load-workspace', projectInstanceId)"));
  assert.ok(preloadSource.includes("'writcraft:project:save-workspace',"));
  assert.ok(preloadSource.includes('++workspaceSaveGeneration'));
  assert.ok(preloadSource.includes("ipcRenderer.sendSync('writcraft:project:workspace-save-seed')"));
  assert.ok(preloadSource.includes("'writcraft:project:save-workspace-before-close',"));
  assert.ok(!preloadSource.includes('rootPath:'));
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}

if (!process.exitCode) console.log(`\n✅ 工作区持久化行为/安全检查 ${pass}/${pass} 全过`);
