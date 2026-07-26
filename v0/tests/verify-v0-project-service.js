#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const service = require(path.join(V0, 'src/main/project-service.js'));
const mainSource = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf8');
const inlineRewriteSource = fs.readFileSync(path.join(V0, 'src/main/inline-rewrite-service.js'), 'utf8');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-project-test-'));
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

console.log('════════ WritCraft V0 · Project service verify ════════');

let project;
check('创建项目、edit.md 模板及内部元数据', () => {
  project = service.createProjectAt(scratch, '我的长文');
  assert.equal(project.name, '我的长文');
  assert.match(project.projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(project.rootPath, fs.realpathSync(path.join(scratch, '我的长文')));
  const edit = fs.readFileSync(path.join(project.rootPath, 'edit.md'), 'utf8');
  assert.match(edit, /schema: writcraft\.edit\/v1/);
  assert.match(edit, /# 项目主旨/);
  assert.match(edit, /## 关键实体与不变量/);
  const metadata = JSON.parse(fs.readFileSync(path.join(project.rootPath, '.writcraft', 'project.json'), 'utf8'));
  assert.equal(metadata.schema, 'writcraft.project/v1');
  assert.equal(metadata.schemaVersion, 1);
  assert.match(metadata.projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(metadata.name, '我的长文');
  assert.ok(!Number.isNaN(Date.parse(metadata.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(metadata.updatedAt)));
});

check('拒绝危险项目名和覆盖已有目录', () => {
  throwsCode(() => service.createProjectAt(scratch, '../逃逸'), 'INVALID_NAME');
  throwsCode(() => service.createProjectAt(scratch, '我的长文'), 'PROJECT_EXISTS');
});

check('项目名中的 YAML 特殊字符被安全引用', () => {
  const special = service.createProjectAt(scratch, '主题 #1 [草稿]');
  const firstLines = fs.readFileSync(path.join(special.rootPath, 'edit.md'), 'utf8').split('\n').slice(0, 5);
  assert.ok(firstLines.includes('title: "主题 #1 [草稿]"'));
});

check('打开项目并拒绝不含 Markdown 的普通文件夹', () => {
  assert.deepEqual(service.openProject(project.rootPath), project);
  const ordinary = path.join(scratch, 'ordinary');
  fs.mkdirSync(ordinary);
  throwsCode(() => service.openProject(ordinary), 'NOT_WRITCRAFT_PROJECT');
});

check('复制项目保留逻辑 projectId 但获得独立目录 instanceId', () => {
  const copiedRoot = path.join(scratch, '我的长文副本');
  fs.cpSync(project.rootPath, copiedRoot, { recursive: true });
  const copied = service.openProject(copiedRoot);
  assert.equal(copied.projectId, project.projectId);
  assert.notEqual(copied.instanceId, project.instanceId);
});

check('创建嵌套 Markdown 文件并列出稳定项目树', () => {
  const created = service.createMarkdownFile(project.rootPath, 'chapters/01-intro.md');
  assert.equal(created.path, 'chapters/01-intro.md');
  const tree = service.listTree(project.rootPath);
  assert.equal(tree[0].type, 'directory');
  const chapters = tree.find(node => node.path === 'chapters');
  assert.ok(chapters);
  assert.equal(chapters.children[0].path, 'chapters/01-intro.md');
  assert.equal(chapters.children[0].type, 'file');
  throwsCode(() => service.createMarkdownFile(project.rootPath, 'notes.txt'), 'INVALID_EXTENSION');
  assert.equal(service.createMarkdownFile(project.rootPath, 'notes.markdown').path, 'notes.markdown');
  throwsCode(() => service.createMarkdownFile(project.rootPath, 'chapters/01-intro.md'), 'FILE_EXISTS');
});

check('UTF-8 文本原子写入并可读取', () => {
  fs.chmodSync(path.join(project.rootPath, 'chapters', '01-intro.md'), 0o640);
  const result = service.atomicWriteFile(project.rootPath, 'chapters/01-intro.md', '# 引言\n\n你好，世界。\n');
  assert.equal(result.path, 'chapters/01-intro.md');
  assert.equal(result.bytes, Buffer.byteLength('# 引言\n\n你好，世界。\n'));
  assert.equal(service.readFile(project.rootPath, 'chapters/01-intro.md'), '# 引言\n\n你好，世界。\n');
  assert.equal(fs.statSync(path.join(project.rootPath, 'chapters', '01-intro.md')).mode & 0o777, 0o640);
  const leftovers = fs.readdirSync(path.join(project.rootPath, 'chapters')).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

check('revision 条件写阻止静默覆盖外部修改', () => {
  const snapshot = service.readFileWithRevision(project.rootPath, 'chapters/01-intro.md');
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(project.rootPath, 'chapters', '01-intro.md'), '# 外部修改\n');
  throwsCode(
    () => service.atomicWriteFile(project.rootPath, 'chapters/01-intro.md', '# 本地旧稿\n', snapshot.revision),
    'FILE_CONFLICT'
  );
  assert.equal(service.readFile(project.rootPath, 'chapters/01-intro.md'), '# 外部修改\n');
  const current = service.readFileWithRevision(project.rootPath, 'chapters/01-intro.md');
  const saved = service.atomicWriteFile(project.rootPath, 'chapters/01-intro.md', '# 合并后稿件\n', current.revision);
  assert.match(saved.revision, /^[a-f0-9]{64}$/);
});

check('拒绝绝对路径、路径穿越和畸形相对路径', () => {
  throwsCode(() => service.readFile(project.rootPath, '/etc/passwd'), 'ABSOLUTE_PATH');
  throwsCode(() => service.readFile(project.rootPath, 'C:\\Windows\\win.ini'), 'ABSOLUTE_PATH');
  throwsCode(() => service.readFile(project.rootPath, '../outside.md'), 'PATH_TRAVERSAL');
  throwsCode(() => service.readFile(project.rootPath, 'chapters/../edit.md'), 'PATH_TRAVERSAL');
  throwsCode(() => service.readFile(project.rootPath, 'chapters//01-intro.md'), 'PATH_TRAVERSAL');
});

check('拒绝通过符号链接读取、写入或创建文件', () => {
  if (process.platform === 'win32') return;
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
  fs.symlinkSync(outside, path.join(project.rootPath, 'linked'));
  throwsCode(() => service.readFile(project.rootPath, 'linked/secret.md'), 'SYMLINK_NOT_ALLOWED');
  throwsCode(() => service.atomicWriteFile(project.rootPath, 'linked/secret.md', 'changed'), 'SYMLINK_NOT_ALLOWED');
  throwsCode(() => service.createMarkdownFile(project.rootPath, 'linked/new.md'), 'SYMLINK_NOT_ALLOWED');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'secret');
});

check('项目元数据不能通过符号链接越界读取', () => {
  if (process.platform === 'win32') return;
  const root = path.join(scratch, 'untrusted-project');
  const outsideMeta = path.join(scratch, 'outside-meta');
  fs.mkdirSync(root);
  fs.mkdirSync(outsideMeta);
  fs.writeFileSync(path.join(root, 'edit.md'), '# safe');
  fs.writeFileSync(path.join(outsideMeta, 'project.json'), JSON.stringify({ name: '伪造名称' }));
  fs.symlinkSync(outsideMeta, path.join(root, '.writcraft'));
  const opened = service.openProject(root);
  assert.equal(opened.name, 'untrusted-project');
});

check('公开文件 API 与树隐藏内部和敏感路径', () => {
  fs.writeFileSync(path.join(project.rootPath, '.env'), 'SECRET=do-not-read');
  fs.mkdirSync(path.join(project.rootPath, '.git'));
  fs.writeFileSync(path.join(project.rootPath, '.git', 'config'), 'private');
  const treeNames = service.listTree(project.rootPath).map(node => node.name);
  assert.ok(!treeNames.includes('.env'));
  assert.ok(!treeNames.includes('.git'));
  assert.ok(!treeNames.includes('.writcraft'));
  throwsCode(() => service.readFile(project.rootPath, '.env'), 'PRIVATE_PATH');
  throwsCode(() => service.atomicWriteFile(project.rootPath, '.writcraft/project.json', '{}'), 'PRIVATE_PATH');
  throwsCode(() => service.createMarkdownFile(project.rootPath, '.git/notes.md'), 'PRIVATE_PATH');
  throwsCode(() => service.readFile(project.rootPath, 'image.png'), 'INVALID_EXTENSION');
});

check('拒绝过大的读取和写入', () => {
  const tooLarge = 'x'.repeat(service.MAX_FILE_BYTES + 1);
  throwsCode(() => service.atomicWriteFile(project.rootPath, 'edit.md', tooLarge), 'FILE_TOO_LARGE');
  const largePath = path.join(project.rootPath, 'large.md');
  fs.writeFileSync(largePath, tooLarge);
  throwsCode(() => service.readFile(project.rootPath, 'large.md'), 'FILE_TOO_LARGE');
});

check('原子替换失败前不会损坏已有文件', () => {
  const before = service.readFile(project.rootPath, 'edit.md');
  throwsCode(() => service.atomicWriteFile(project.rootPath, 'edit.md', 'x'.repeat(service.MAX_FILE_BYTES + 1)), 'FILE_TOO_LARGE');
  assert.equal(service.readFile(project.rootPath, 'edit.md'), before);
});

check('main 只在当前项目内注册完整 IPC', () => {
  for (const route of ['create', 'open', 'list', 'read', 'write', 'create-file', 'get-context']) {
    assert.ok(mainSource.includes(`ipcMain.handle('writcraft:project:${route}'`), `缺少 ${route} IPC`);
  }
  assert.ok(mainSource.includes('requireCurrentProject()'));
  assert.ok(mainSource.includes('assertTrustedSender(event)'));
  assert.ok(mainSource.includes('dialog.showOpenDialog'));
  assert.ok(mainSource.includes('senderUrl !== TRUSTED_RENDERER_URL'));
  assert.ok(mainSource.includes('url !== TRUSTED_RENDERER_URL'));
  assert.ok(mainSource.includes('project: publicProject(project)'));
  assert.match(mainSource, /const tree = projectService\.listTree\(project\.rootPath\);[\s\S]{0,200}setCurrentProject\(project\)/);
});

check('preload 暴露固定的最小 project API', () => {
  for (const method of ['create:', 'open:', 'listTree:', 'readFile:', 'writeFile:', 'createFile:', 'getContext:']) {
    assert.ok(preloadSource.includes(method), `缺少 ${method}`);
  }
  assert.ok(preloadSource.includes('project: Object.freeze({'));
  assert.ok(!preloadSource.includes('project: { rootPath'));
  assert.ok(preloadSource.includes('rewrite: (projectInstanceId, request)'));
  assert.ok(mainSource.includes('inlineRewriteService.prepareInlineRewrite'));
  assert.ok(mainSource.includes('inlineRewriteStore.completeGeneration'));
  assert.ok(inlineRewriteSource.includes('projectService.readFileWithRevision(rootPath, projectService.EDIT_FILE)'));
  assert.ok(inlineRewriteSource.includes('contextManifest: prepared.contextManifest'));
});

try {
  fs.rmSync(scratch, { recursive: true, force: true });
} catch (_) {}

if (!process.exitCode) console.log(`\n✅ 项目文件服务行为/安全检查 ${pass}/${pass} 全过`);
