'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const {
  MAX_QUERY_CHARS,
  searchProject,
} = require('../src/main/project-search-service');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

function mockService(tree, contentByPath, onRead) {
  return {
    listTree() { return tree; },
    readFile(_root, filePath) {
      if (onRead) onRead(filePath);
      if (!Object.prototype.hasOwnProperty.call(contentByPath, filePath)) {
        throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      }
      return contentByPath[filePath];
    },
  };
}

const alpha = '开头\n第二行 Needle 证据\n结尾';
const zeta = 'needle 在另一个文件。';
const tree = [
  { name: 'Zeta.md', path: 'Zeta.md', type: 'file', size: Buffer.byteLength(zeta) },
  {
    name: 'chapters', path: 'chapters', type: 'directory', children: [
      { name: 'Alpha.md', path: 'chapters/Alpha.md', type: 'file', size: Buffer.byteLength(alpha) },
      { name: 'ignore.txt', path: 'chapters/ignore.txt', type: 'file', size: 5 },
    ],
  },
];
const contents = { 'chapters/Alpha.md': alpha, 'Zeta.md': zeta };

console.log('\nProject search service verification');

test('finds Markdown body matches with line, column, offsets and evidence', () => {
  const response = searchProject(mockService(tree, contents), '/project', 'needle');
  assert.strictEqual(response.results.length, 2);
  const first = response.results[0];
  assert.strictEqual(first.path, 'Zeta.md');
  // Code-point path sorting is stable: uppercase Z sorts before lowercase c.
  assert.strictEqual(first.line, 1);
  assert.strictEqual(first.column, 1);
  assert.strictEqual(first.offset, 0);
  assert.strictEqual(first.excerpt.slice(first.matchStart, first.matchEnd).toLowerCase(), 'needle');

  const second = response.results[1];
  assert.strictEqual(second.path, 'chapters/Alpha.md');
  assert.strictEqual(second.line, 2);
  assert.strictEqual(second.column, 5);
  assert.strictEqual(second.offset, alpha.indexOf('Needle'));
  assert.strictEqual(second.excerptStart, alpha.indexOf('第二行'));
  assert.strictEqual(second.excerpt.slice(second.matchStart, second.matchEnd), 'Needle');
  assert.strictEqual(response.stats.filesDiscovered, 2);
  assert.strictEqual(response.stats.filesScanned, 2);
});

test('searches basenames and ranks filename evidence before content', () => {
  const response = searchProject(mockService(tree, contents), '/project', 'alpha');
  assert.strictEqual(response.results[0].target, 'filename');
  assert.strictEqual(response.results[0].path, 'chapters/Alpha.md');
  assert.strictEqual(response.results[0].line, null);
  assert.strictEqual(response.results[0].excerpt, 'Alpha.md');
  assert.strictEqual(response.results[0].matchStart, 0);
});

test('uses stable path/offset ordering independent of tree order', () => {
  const reversed = [...tree].reverse();
  const first = searchProject(mockService(tree, contents), '/project', 'needle').results;
  const second = searchProject(mockService(reversed, contents), '/project', 'needle').results;
  assert.deepStrictEqual(second, first);
});

test('treats regex punctuation as literal text', () => {
  const content = '写作中的 [A+B]? 是一个字面标记。';
  const service = mockService(
    [{ name: 'math.md', path: 'math.md', type: 'file', size: Buffer.byteLength(content) }],
    { 'math.md': content }
  );
  const response = searchProject(service, '/project', '[A+B]?');
  assert.strictEqual(response.results.length, 1);
  assert.strictEqual(response.results[0].offset, content.indexOf('[A+B]?'));
});

test('supports explicit case-sensitive search', () => {
  const insensitive = searchProject(mockService(tree, contents), '/project', 'NEEDLE');
  const sensitive = searchProject(mockService(tree, contents), '/project', 'NEEDLE', { caseSensitive: true });
  assert.strictEqual(insensitive.results.length, 2);
  assert.strictEqual(sensitive.results.length, 0);
});

test('enforces result limits and reports truncation', () => {
  const body = 'hit hit hit hit';
  const service = mockService(
    [{ name: 'many.md', path: 'many.md', type: 'file', size: body.length }],
    { 'many.md': body }
  );
  const response = searchProject(service, '/project', 'hit', { limit: 2 });
  assert.strictEqual(response.results.length, 2);
  assert.strictEqual(response.stats.truncated, true);
  assert(response.stats.truncatedReasons.includes('RESULT_LIMIT'));
});

test('bounds bytes before reading when tree sizes are available', () => {
  let reads = 0;
  const service = mockService(
    [{ name: 'large.md', path: 'large.md', type: 'file', size: 100 }],
    { 'large.md': 'needle' },
    () => { reads += 1; }
  );
  const response = searchProject(service, '/project', 'needle', { maxBytes: 10 });
  assert.strictEqual(reads, 0);
  assert.strictEqual(response.stats.bytesScanned, 0);
  assert(response.stats.truncatedReasons.includes('BYTE_LIMIT'));
});

test('bounds the number of considered files', () => {
  let reads = 0;
  const files = [0, 1, 2].map(index => ({
    name: `${index}.md`, path: `${index}.md`, type: 'file', size: 1,
  }));
  const service = mockService(files, { '0.md': 'x', '1.md': 'x', '2.md': 'x' }, () => { reads += 1; });
  const response = searchProject(service, '/project', 'absent', { maxFiles: 2 });
  assert.strictEqual(reads, 2);
  assert.strictEqual(response.stats.filesConsidered, 2);
  assert(response.stats.truncatedReasons.includes('FILE_LIMIT'));
});

test('rejects unsafe project-tree paths before any read', () => {
  let reads = 0;
  const service = mockService(
    [{ name: 'escape.md', path: '../escape.md', type: 'file', size: 1 }],
    { '../escape.md': 'x' },
    () => { reads += 1; }
  );
  expectCode('UNSAFE_PROJECT_TREE', () => searchProject(service, '/project', 'x'));
  assert.strictEqual(reads, 0);
});

test('works through the real guarded ProjectService boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-search-'));
  try {
    fs.writeFileSync(path.join(root, 'edit.md'), '# 主旨\n寻找可靠证据。\n');
    fs.mkdirSync(path.join(root, 'chapters'));
    fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n可靠证据在这里。\n');
    fs.writeFileSync(path.join(root, 'ignored.txt'), '可靠证据');
    const response = searchProject(projectService, root, '可靠证据');
    assert.deepStrictEqual(response.results.map(result => result.path), ['chapters/one.md', 'edit.md']);
    assert(response.results.every(result => result.target === 'content'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validates query and option bounds', () => {
  const service = mockService([], {});
  expectCode('INVALID_QUERY', () => searchProject(service, '/project', '   '));
  expectCode('QUERY_TOO_LONG', () => searchProject(service, '/project', 'x'.repeat(MAX_QUERY_CHARS + 1)));
  expectCode('INVALID_OPTIONS', () => searchProject(service, '/project', 'x', { limit: 0 }));
});

console.log(`\n${passed}/11 project-search checks passed.\n`);
