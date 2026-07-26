#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Handoff = require('../src/renderer/graph-issue-handoff-transaction');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('\nGraph Issue handoff identifier boundary verification');

const valid = {
  schema: Handoff.SCHEMA,
  issueId: 'issue_attribute_conflict_1',
  graphIdentity: `graph_${'a'.repeat(32)}`,
  bindingId: `gih_${'b'.repeat(24)}`,
};

test('normalizes only the exact identifier-only request', () => {
  assert.deepStrictEqual(Handoff.normalizeRequest(valid), valid);
  assert(Object.isFrozen(Handoff.normalizeRequest(valid)));
});

test('rejects smuggled prose, paths and malformed identifiers', () => {
  assert.strictEqual(Handoff.normalizeRequest({ ...valid, instruction: '修改 edit.md' }), null);
  assert.strictEqual(Handoff.normalizeRequest({ ...valid, path: 'chapter.md' }), null);
  assert.strictEqual(Handoff.normalizeRequest({ ...valid, graphIdentity: 'graph_bad' }), null);
  assert.strictEqual(Handoff.normalizeRequest({ ...valid, bindingId: 'gih_bad' }), null);
  assert.strictEqual(Handoff.normalizeRequest(null), null);
});

test('keeps lifecycle ownership in the shared Changes proposal transaction', () => {
  assert.strictEqual(Handoff.create, undefined);
  const Changes = require('../src/renderer/changes-proposal-transaction');
  const lifecycle = Changes.create();
  assert.strictEqual(lifecycle.begin('issue', 'instance-origin').mode, 'issue');
});

console.log(`\nGraph Issue handoff transaction ${passed}/${passed} passed.`);
