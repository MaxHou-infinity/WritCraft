'use strict';

const assert = require('assert');
const presentation = require('../src/renderer/changes-history-presentation');

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

test('single-file history names the exact chapter instead of only a file count', () => {
  const entry = { files: [{ path: 'chapters/one.md' }] };
  assert.deepStrictEqual(presentation.target(entry), {
    title: 'chapters/one.md',
    detail: 'chapters/one.md',
  });
  const message = presentation.undoConfirmation(entry, { isLatest: true });
  assert(message.includes('• chapters/one.md'));
  assert(!message.includes('不是最新修改记录'));
});

test('older history requires an explicit non-latest warning', () => {
  const message = presentation.undoConfirmation(
    { files: [{ path: 'chapters/older.md' }] },
    { isLatest: false }
  );
  assert(message.startsWith('⚠️ 这不是最新修改记录'));
  assert(message.includes('• chapters/older.md'));
});

test('edit.md is identified as the project Prompt with a context warning', () => {
  const entry = { files: [{ path: 'edit.md' }] };
  assert.deepStrictEqual(presentation.target(entry), {
    title: '项目 Prompt · edit.md',
    detail: 'edit.md',
  });
  const message = presentation.undoConfirmation(entry, { isLatest: false });
  assert(message.includes('项目 Prompt · edit.md'));
  assert(message.includes('改变后续 AI 使用的项目上下文'));
});

test('multi-file confirmation is bounded while preserving the total', () => {
  const entry = {
    files: Array.from({ length: 8 }, (_, index) => ({ path: `chapters/${index}.md` })),
  };
  const target = presentation.target(entry);
  assert.strictEqual(target.title, '8 个文件');
  assert(target.detail.endsWith('等 8 个文件'));
  const message = presentation.undoConfirmation(entry, { isLatest: true });
  assert(message.includes('另有 3 个文件'));
  assert(!message.includes('chapters/7.md'));
});

test('control characters cannot forge extra confirmation lines', () => {
  const message = presentation.undoConfirmation(
    { files: [{ path: 'chapters/one.md\n⚠️ fake.md' }] },
    { isLatest: true }
  );
  assert(message.includes('• chapters/one.md ⚠️ fake.md'));
  assert(!message.includes('\n⚠️ fake.md'));
});

console.log(`\nHistory undo presentation verification: ${passed}/5 passed.`);
