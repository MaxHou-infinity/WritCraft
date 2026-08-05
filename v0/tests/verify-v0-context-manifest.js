'use strict';

const assert = require('assert');
const contract = require('../src/shared/context-manifest');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const revision = 'a'.repeat(64);
const edit = content => contract.createEditCompilation({
  rawContent: content,
  compiledContent: content,
  revision,
  compiledResult: { truncated: false, sections: [] },
});

console.log('\nWritCraft unified Context Manifest verification');

test('complete manifest has one exact, entry-independent semantic envelope', () => {
  const manifest = contract.createContextManifest({
    entry: 'chat',
    editRevision: revision,
    editCompilation: edit('项目主旨😀'),
    items: [contract.createContextItem({
      id: 'chat_edit', kind: 'project_prompt', path: 'edit.md', revision,
      rawBytes: Buffer.byteLength('项目主旨😀', 'utf8'), includedBytes: Buffer.byteLength('项目主旨😀', 'utf8'),
      budgetBytes: 32768,
    })],
    budgetBytes: 32768,
  });
  assert.strictEqual(manifest.schema, contract.SCHEMA);
  assert.strictEqual(manifest.editCompilation.rawBytes, Buffer.byteLength('项目主旨😀', 'utf8'));
  assert.strictEqual(manifest.totals.includedBytes, Buffer.byteLength('项目主旨😀', 'utf8'));
  assert.strictEqual(contract.validContextManifest(manifest), true);
});

test('omitted and truncated states carry stable reasons and never claim included bytes', () => {
  const manifest = contract.createContextManifest({
    entry: 'research',
    editRevision: revision,
    editCompilation: {
      status: 'truncated', rawBytes: 100, compiledBytes: 80, budgetBytes: 18 * 1024, budgetChars: 6000,
      availableSections: 3, includedSections: 2, omittedSections: 1,
      omissionReason: 'budget', truncationReason: 'edit_prompt_budget',
      selectionPolicy: contract.EDIT_SELECTION_POLICY,
    },
    items: [
      contract.createContextItem({
        id: 'research_edit', kind: 'project_prompt', path: 'edit.md', revision,
        rawBytes: 100, includedBytes: 80, budgetBytes: 256 * 1024,
      }),
      contract.createContextItem({
        id: 'research_unselected', kind: 'source', path: 'references/unused.md', revision,
        status: 'omitted', rawBytes: null, includedBytes: 0, budgetBytes: 256 * 1024,
        omissionReason: 'not_selected',
      }),
    ],
    budgetBytes: 256 * 1024,
    sourceIndexRevision: 'sha256:' + 'b'.repeat(64),
  });
  assert.strictEqual(contract.validContextManifest(manifest), true);
  assert.strictEqual(manifest.items[1].includedBytes, 0);
  assert.strictEqual(manifest.totals.omittedItems, 1);
});

test('unknown fields, absolute paths and body content fail closed', () => {
  const base = contract.createContextManifest({
    entry: 'changes', editRevision: revision, editCompilation: edit('x'), items: [], budgetBytes: 120 * 1024,
  });
  assert.strictEqual(contract.validContextManifest({ ...base, leakedBody: '正文' }), false);
  assert.throws(() => contract.createContextItem({
    id: 'bad', kind: 'context', path: '/Users/max/project.md', revision,
  }));
  const traversal = { ...base, items: [{
    id: 'bad', kind: 'context', path: '../project.md', revision, status: 'included',
    rawBytes: 0, includedBytes: 0, budgetBytes: 0, omissionReason: null, truncationReason: null,
  }] };
  assert.strictEqual(contract.validContextManifest(traversal), false);
  assert.throws(() => contract.createContextItem({
    id: 'bad', kind: 'context', path: 'notes/a.md', revision, status: 'omitted', omissionReason: null,
  }));
});

test('invalid edit is explicit and cannot silently become raw fallback', () => {
  const compilation = contract.createEditCompilation({
    rawContent: '', compiledContent: '', revision,
    compiledResult: { truncated: false, sections: [] }, unavailable: true,
  });
  assert.deepStrictEqual({ status: compilation.status, omissionReason: compilation.omissionReason }, {
    status: 'unavailable', omissionReason: 'invalid_edit',
  });
  assert.strictEqual(compilation.truncationReason, null);
});

console.log(`\nUnified Context Manifest passed: ${passed}/4.`);
