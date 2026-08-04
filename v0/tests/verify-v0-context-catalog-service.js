'use strict';

const assert = require('assert');
const service = require('../src/main/context-catalog-service');

const tree = [
  { type: 'directory', path: 'chapters', children: [
    { type: 'file', path: 'chapters/01-opening.md' },
    { type: 'file', path: 'chapters/02-middle.md' },
  ] },
  { type: 'directory', path: 'references', children: [{ type: 'file', path: 'references/guide.md' }] },
  { type: 'file', path: 'edit.md' },
  { type: 'symlink', path: 'secrets.md', blocked: true },
];
const contents = {
  'chapters/01-opening.md': '# 开篇\n\n第一段\n\n## 破茧时刻\n\n第二段',
  'chapters/02-middle.md': '# 中段\n\n第三段',
  'references/guide.md': '# 指南\n\n只读来源',
  'edit.md': '# 项目主旨\n\n测试',
};
const fakeProjectService = {
  listTree: () => tree,
  readFileWithRevision: (_root, filePath) => ({ content: contents[filePath] || '', revision: `rev-${filePath}` }),
};

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

console.log('\nContext catalog service verification');
test('returns bounded Main-owned candidates without content or root paths', () => {
  const result = service.listContextCandidates({
    projectService: fakeProjectService,
    rootPath: '/private/project',
    projectInstanceId: 'instance_0123456789abcdef01234567',
    mutationGeneration: 7,
    currentFilePath: 'chapters/01-opening.md',
    query: '',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.schema, service.SCHEMA);
  assert.strictEqual(result.mutationGeneration, 7);
  assert(result.candidates.some(item => item.kind === 'file' && item.insertText.includes('chapters/01-opening.md')));
  assert(result.candidates.some(item => item.kind === 'section' && item.insertText.includes('@section')));
  assert(!JSON.stringify(result).includes('/private/project'));
  assert(!JSON.stringify(result).includes('第一段'));
  assert(!result.candidates.some(item => item.insertText.includes('secrets')));
});

test('query ranks current-file sections and rejects oversized query', () => {
  const result = service.listContextCandidates({
    projectService: fakeProjectService,
    rootPath: '/private/project',
    projectInstanceId: 'instance_0123456789abcdef01234567',
    mutationGeneration: 8,
    currentFilePath: 'chapters/01-opening.md',
    query: '破茧',
  });
  assert(result.candidates.length > 0);
  assert.strictEqual(result.candidates[0].kind, 'section');
  assert.match(result.candidates[0].label, /破茧/);
  assert.throws(() => service.listContextCandidates({ projectService: fakeProjectService, rootPath: '/private/project', query: 'x'.repeat(service.MAX_QUERY_CHARS + 1) }), error => error.code === 'QUERY_TOO_LONG');
});

console.log(`\n${passed}/${passed} context catalog checks passed.`);
