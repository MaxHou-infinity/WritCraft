#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require(path.join(__dirname, '..', 'src/main/project-service.js'));
const sourceIndex = require(path.join(__dirname, '..', 'src/main/source-index-service.js'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-source-index-test-'));
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

function write(root, relPath, content) {
  projectService.createMarkdownFile(root, relPath);
  projectService.atomicWriteFile(root, relPath, content);
}

console.log('════════ WritCraft V0 · Source index verify ════════');

const project = projectService.createProjectAt(scratch, '来源索引');
write(project.rootPath, 'references/research.md', `---
type: source
title: 核心研究
author: 林研
published: 2025-04-02
url: https://example.com/paper
citation-key: Lin2025
payload: !!js/function "globalThis.PWNED = true"
---

# 核心研究全文

证据内容。
`);
write(project.rootPath, 'references/unsafe.md', `---
title: 不安全来源
source-url: javascript:alert(1)
---

# 不安全来源
`);
write(project.rootPath, 'references/heading-only.md', `# 仅标题来源

这一来源只使用一级标题提供名称。
`);
write(project.rootPath, 'references/same-title.md', `---
type: source
title: 同名来源
---

# 同名来源

正文。
`);
write(project.rootPath, 'bibliography.md', `---
type: reference
title: 外部书目
url: http://books.example.test/item
---

# 外部书目

引用 [核心研究](references/research.md)。
`);
write(project.rootPath, 'url-only.md', `---
title: 仅 URL 来源
url: https://data.example.test/dataset
---

# 数据集
`);
write(project.rootPath, 'chapters/01.md', `# 第一章

参见 [核心研究](../references/research.md#results)。
在线版本：[论文](https://example.com/paper)。
`);
write(project.rootPath, 'chapters/plain.md', '# 普通章节\n\n不是来源。\n');
fs.writeFileSync(path.join(project.rootPath, '.hidden-source.md'), '---\ntype: source\n---\n# hidden');

let index;
check('仅索引 references/ 与明确标记的 Markdown 来源', () => {
  index = sourceIndex.buildSourceIndex(project.rootPath);
  assert.deepEqual(index.sources.map(source => source.filePath), [
    'bibliography.md',
    'references/heading-only.md',
    'references/research.md',
    'references/same-title.md',
    'references/unsafe.md',
    'url-only.md',
  ]);
  assert.ok(!index.sources.some(source => source.filePath === 'chapters/plain.md'));
  assert.ok(!index.sources.some(source => source.filePath.includes('hidden')));
  assert.equal(index.schema, 'writcraft.sources/v1');
});

check('输出 revision、标题、来源元数据和安全 URL', () => {
  const research = index.sources.find(source => source.filePath === 'references/research.md');
  assert.match(research.id, /^src_[a-f0-9]{20}$/);
  assert.match(research.revision, /^[a-f0-9]{64}$/);
  assert.equal(research.title, '核心研究');
  assert.equal(research.metadata.author, '林研');
  assert.equal(research.metadata.published, '2025-04-02');
  assert.equal(research.metadata.citationKey, 'Lin2025');
  assert.equal(research.metadata.url, 'https://example.com/paper');
  assert.equal(globalThis.PWNED, undefined, 'Front Matter 不得被执行');

  const unsafe = index.sources.find(source => source.filePath === 'references/unsafe.md');
  assert.equal(unsafe.metadata.url, null);
  assert.equal(unsafe.indexStatus, 'indexed_with_warnings');
  assert.ok(unsafe.errors.some(error => error.code === 'UNSAFE_URL'));
  assert.equal(index.status, 'partial');
});

check('一级标题回退定位精确选中标题正文，不包含 Markdown 标记', () => {
  const headingOnly = index.sources.find(source => source.filePath === 'references/heading-only.md');
  const content = projectService.readFile(project.rootPath, headingOnly.filePath);
  assert.equal(headingOnly.title, '仅标题来源');
  assert.equal(content.slice(headingOnly.locator.offset, headingOnly.locator.end), headingOnly.title);
});

check('Front Matter title 与正文一级标题同名时，locator 优先定位正文标题', () => {
  const source = index.sources.find(item => item.filePath === 'references/same-title.md');
  const sameContent = projectService.readFile(project.rootPath, source.filePath);
  assert.equal(source.locator.offset, sameContent.indexOf('# 同名来源') + 2);
  assert.equal(sameContent.slice(source.locator.offset, source.locator.end), '同名来源');
  assert(source.locator.offset > sameContent.indexOf('title: 同名来源'));
});

check('识别文件路径与 URL 引用，返回可点击行号/offset 证据', () => {
  const research = index.sources.find(source => source.filePath === 'references/research.md');
  assert.equal(research.isReferenced, true);
  assert.equal(research.citationCount, 3);
  assert.deepEqual(research.referencedBy.map(citation => citation.fromPath), ['bibliography.md', 'chapters/01.md', 'chapters/01.md']);
  assert.deepEqual(research.referencedBy.map(citation => citation.line), [9, 3, 4]);
  for (const citation of research.referencedBy) {
    assert.equal(citation.filePath, citation.fromPath);
    assert.ok(citation.offset >= 0);
    assert.ok(citation.end > citation.offset);
    assert.ok(citation.quote.length > 0);
  }
  assert.equal(research.locator.filePath, 'references/research.md');
  assert.ok(Number.isInteger(research.locator.line));
  assert.deepEqual(sourceIndex.locateSource(index, research.id), research.locator);
  assert.equal(sourceIndex.locateSource(index, 'src_missing'), null);
  const bibliography = index.sources.find(source => source.filePath === 'bibliography.md');
  assert.equal(bibliography.isCiting, true);
  assert.equal(bibliography.citesCount, 1);
  assert.equal(bibliography.citesSources[0].targetId, research.id);
});

check('稳定排序、稳定 ID 与索引 revision', () => {
  const again = sourceIndex.buildSourceIndex(project.rootPath);
  assert.deepEqual(again, index);
  const before = index.sources.find(source => source.filePath === 'references/research.md');
  projectService.atomicWriteFile(
    project.rootPath,
    'references/research.md',
    projectService.readFile(project.rootPath, 'references/research.md') + '\n新证据。\n'
  );
  const changed = sourceIndex.buildSourceIndex(project.rootPath);
  const after = changed.sources.find(source => source.filePath === 'references/research.md');
  assert.equal(after.id, before.id, '路径未变时 ID 应稳定');
  assert.notEqual(after.revision, before.revision, '内容修改应更新文件 revision');
  assert.notEqual(changed.revision, index.revision, '内容修改应更新索引 revision');
});

check('索引上限只能收紧，超限返回 partial 与结构化错误', () => {
  const limited = sourceIndex.buildSourceIndex(project.rootPath, { maxSourceFiles: 1 });
  assert.equal(limited.sources.length, 1);
  assert.equal(limited.status, 'partial');
  assert.ok(limited.errors.some(error => error.code === 'SOURCE_LIMIT'));
  const hardBounded = sourceIndex.buildSourceIndex(project.rootPath, { maxSourceFiles: 999999 });
  assert.ok(hardBounded.sources.length <= sourceIndex.MAX_SOURCE_FILES);
});

check('完全离线，不写正文或不可重建缓存', () => {
  const before = projectService.readFile(project.rootPath, 'chapters/01.md');
  sourceIndex.buildSourceIndex(project.rootPath);
  assert.equal(projectService.readFile(project.rootPath, 'chapters/01.md'), before);
  const internalNames = fs.readdirSync(path.join(project.rootPath, '.writcraft'));
  assert.ok(!internalNames.some(name => /source|index/i.test(name)), '当前实现不持久化派生缓存');
  const sourceText = fs.readFileSync(path.join(__dirname, '..', 'src/main/source-index-service.js'), 'utf8');
  assert.ok(!sourceText.includes('fetch('));
  assert.ok(!sourceText.includes('http.request'));
  assert.ok(!sourceText.includes('https.request'));
});

check('隐藏路径不可见，references symlink 被拦截且不读取越界内容', () => {
  if (process.platform === 'win32') return;
  const unsafeRoot = path.join(scratch, 'unsafe-project');
  const outside = path.join(scratch, 'outside-references');
  fs.mkdirSync(unsafeRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(unsafeRoot, 'edit.md'), '# prompt');
  fs.writeFileSync(path.join(outside, 'secret.md'), '---\ntype: source\n---\n# SECRET-OUTSIDE');
  fs.symlinkSync(outside, path.join(unsafeRoot, 'references'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(unsafeRoot, 'linked-source.md'));
  const unsafeIndex = sourceIndex.buildSourceIndex(unsafeRoot);
  assert.equal(unsafeIndex.sources.length, 0);
  assert.equal(unsafeIndex.status, 'partial');
  assert.ok(unsafeIndex.errors.some(error => error.code === 'SYMLINK_NOT_ALLOWED' && error.filePath === 'references'));
  assert.ok(unsafeIndex.errors.some(error => error.code === 'SYMLINK_NOT_ALLOWED' && error.filePath === 'linked-source.md'));
  assert.ok(!JSON.stringify(unsafeIndex).includes('SECRET-OUTSIDE'));
});

check('安全 URL 规则拒绝脚本、本地文件与嵌入凭据', () => {
  assert.equal(sourceIndex.safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(sourceIndex.safeHttpUrl('file:///etc/passwd'), null);
  assert.equal(sourceIndex.safeHttpUrl('https://user:pass@example.com/private'), null);
  assert.equal(sourceIndex.safeHttpUrl('HTTPS://Example.COM/a'), 'https://example.com/a');
});

try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}

if (!process.exitCode) console.log(`\n✅ 来源/证据索引行为安全检查 ${pass}/${pass} 全过`);
