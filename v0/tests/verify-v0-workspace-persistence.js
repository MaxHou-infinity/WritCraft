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

check('新项目初始化 schema v1 工作区', () => {
  const disk = JSON.parse(fs.readFileSync(path.join(project.rootPath, service.WORKSPACE_FILE), 'utf8'));
  assert.equal(disk.schema, 'writcraft.workspace/v1');
  assert.equal(disk.schemaVersion, 1);
  assert.deepEqual(service.loadWorkspace(project.rootPath), {
    tabs: ['edit.md'],
    activePath: 'edit.md',
    files: { 'edit.md': { cursorOffset: 0, scrollTop: 0 } },
  });
});

check('持久化标签、激活文件、光标和滚动位置', () => {
  const state = {
    tabs: ['edit.md', 'chapters/01.md'],
    activePath: 'chapters/01.md',
    files: {
      'edit.md': { cursorOffset: 12, scrollTop: 24.5 },
      'chapters/01.md': { cursorOffset: 8, scrollTop: 96 },
    },
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
    files: { [relPath]: { cursorOffset: 0, scrollTop: 0 } },
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
    files: { 'edit.md': { cursorOffset: 0, scrollTop: 0 } },
  }), 'INVALID_WORKSPACE');
  throwsCode(() => service.saveWorkspace(project.rootPath, {
    tabs: ['edit.md'],
    activePath: 'edit.md',
    files: { 'edit.md': { cursorOffset: -1, scrollTop: 0 } },
  }), 'INVALID_WORKSPACE');
});

check('损坏、旧 schema 或引用丢失文件时安全回退 edit.md', () => {
  const target = path.join(project.rootPath, service.WORKSPACE_FILE);
  fs.writeFileSync(target, '{broken');
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
  fs.writeFileSync(target, JSON.stringify({ schema: 'writcraft.workspace/v0', schemaVersion: 0 }));
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
  fs.writeFileSync(target, JSON.stringify({
    schema: 'writcraft.workspace/v1', schemaVersion: 1,
    tabs: ['gone.md'], activePath: 'gone.md',
    files: { 'gone.md': { cursorOffset: 0, scrollTop: 0 } },
  }));
  assert.deepEqual(service.loadWorkspace(project.rootPath).tabs, ['edit.md']);
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
    files: { 'edit.md': { cursorOffset: 0, scrollTop: 0 } },
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
  assert.ok(preloadSource.includes("loadWorkspace: () => ipcRenderer.invoke('writcraft:project:load-workspace')"));
  assert.ok(preloadSource.includes("saveWorkspace: (workspace) => ipcRenderer.invoke('writcraft:project:save-workspace', workspace)"));
  assert.ok(!preloadSource.includes('rootPath:'));
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}

if (!process.exitCode) console.log(`\n✅ 工作区持久化行为/安全检查 ${pass}/${pass} 全过`);
