#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/graph-filter-state.js'), 'utf8');
const sandbox = { module: { exports: {} }, exports: {}, console };
vm.runInNewContext(source, sandbox, { filename: 'graph-filter-state.js' });
const { formatEdgeEvolution } = sandbox.module.exports;

let passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}

console.log('\nGraph evolution renderer VM verification');

check('单文件关系使用“出现于”且不误称跨文件', () => {
  const text = formatEdgeEvolution({
    evidenceCount: 2, pathCount: 1, paths: ['chapters/a.md'],
    firstPath: 'chapters/a.md', lastPath: 'chapters/a.md',
  });
  assert.equal(text, '出现于：chapters/a.md；2 条证据');
  assert(!text.includes('跨文件'));
});

check('多文件关系显示跨文件路径并明确不是故事时间', () => {
  const text = formatEdgeEvolution({
    evidenceCount: 3, pathCount: 2, paths: ['chapters/a.md', 'chapters/b.md'],
    firstPath: 'chapters/a.md', lastPath: 'chapters/b.md',
  });
  assert(text.startsWith('跨文件出现：chapters/a.md、chapters/b.md；3 条证据'));
  assert(text.includes('按文件路径排序，不代表故事时间'));
});

check('路径截断明确展示数量、总文件数与完整路径边界', () => {
  const paths = Array.from({ length: 32 }, (_, index) => `chapters/${String(index).padStart(2, '0')}.md`);
  const text = formatEdgeEvolution({
    evidenceCount: 44, pathCount: 40, paths,
    firstPath: 'chapters/00.md', lastPath: 'chapters/39.md',
  });
  assert(text.includes('展示前 32 / 共 40 个文件'));
  assert(text.includes('路径范围 chapters/00.md → chapters/39.md'));
  assert(text.includes('44 条证据'));
});

if (!process.exitCode) console.log(`\n${passed}/${passed} graph-evolution renderer checks passed.`);
