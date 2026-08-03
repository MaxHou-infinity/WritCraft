'use strict';

const assert = require('assert');
const crypto = require('crypto');
const service = require('../src/main/workspace-inventory-service');

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function projectService(files, clockHook = null) {
  return {
    listTree() {
      return Object.entries(files).map(([filePath, content]) => ({
        type: 'file', path: filePath, name: filePath.split('/').pop(), size: Buffer.byteLength(content),
      }));
    },
    readFileWithRevision(_root, filePath) {
      if (clockHook) clockHook();
      return { content: files[filePath], revision: revision(files[filePath]) };
    },
  };
}

const files = {
  'edit.md': '# 项目\n目标',
  'chapters/01.md': '# 开始\n\n中文 ABC-123 👩🏽‍💻',
  'chapters/02.md': '# 骨架\n\n## 小节\n',
  'chapters/03.md': '   \n',
  'Graph:Unicode-路径.md': '# 合法冒号文件名\n正文',
  'references/source.md': '# 来源\n不计入正文',
};
const authority = { projectInstanceId: `instance_${'a'.repeat(24)}`, projectMutationGeneration: 1 };
const inventory = service.buildWorkspaceInventory({
  projectService: projectService(files), rootPath: '/safe', captureAuthority: () => authority,
});
assert.strictEqual(inventory.schema, 'writcraft.workspace-inventory/v1');
assert.strictEqual(inventory.markdownFileCount, 6);
assert.strictEqual(inventory.manuscriptFileCount, 4);
assert.deepStrictEqual(inventory.files.filter(file => file.manuscript).map(file => file.chapterState), ['body', 'skeleton', 'blank', 'body']);
assert.strictEqual(inventory.files.find(file => file.path === 'chapters/01.md').headings[0].heading, '开始');
assert.match(inventory.files.find(file => file.path === 'Graph:Unicode-路径.md').headings[0].id, /^sec_[a-f0-9]{16}$/);
assert.ok(inventory.manuscriptWordCount >= 5);

assert.strictEqual(service.countManuscriptWords('[可见](https://example.com) ![图](x.png)'), 3);
assert.strictEqual(service.countManuscriptWords('中文 test-case １２ 👨‍👩‍👧‍👦'), 6);
assert.strictEqual(service.countManuscriptWords('&#20013; français Ελληνικά'), 2);
assert.strictEqual(service.countManuscriptWords('[^1]: 关键证据 🇨🇳'), 5);
assert.strictEqual(service.countManuscriptWords('1️⃣'), 1);
assert.strictEqual(service.chapterState('TODO！', []), 'skeleton');
assert.strictEqual(service.chapterState('-\n>\n待补正文', []), 'skeleton');
assert.strictEqual(service.chapterState('- \n> \n', []), 'skeleton');

let now = 0;
assert.throws(() => service.buildWorkspaceInventory({
  projectService: projectService({ 'a.md': 'a', 'b.md': 'b' }, () => { now += 5; }),
  rootPath: '/safe',
  clock: () => now,
  deadlineMs: 5,
  captureAuthority: () => authority,
}), error => error.code === 'HOME_SNAPSHOT_TIMEOUT');

let generation = 1;
assert.throws(() => service.buildWorkspaceInventory({
  projectService: projectService({ 'a.md': 'a' }, () => { generation += 1; }),
  rootPath: '/safe',
  captureAuthority: () => ({ ...authority, projectMutationGeneration: generation }),
}), error => error.code === 'PROJECT_CHANGED');

assert.throws(() => service.flattenMarkdownTree([
  { type: 'file', path: '../bad.md', size: 1 },
]), error => error.code === 'UNSAFE_PROJECT_TREE');

console.log('verify-v0-workspace-inventory: ok');
