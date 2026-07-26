#!/usr/bin/env node
'use strict';

const assert = require('assert');
const State = require('../src/renderer/changes-review-state');

const H1 = `hk_${'1'.repeat(24)}`;
const H2 = `hk_${'2'.repeat(24)}`;
const H3 = `hk_${'3'.repeat(24)}`;

function review(selectionPolicy = 'hunk') {
  return {
    schema: State.REVIEW_SCHEMA,
    changeSetId: `pc_${'a'.repeat(32)}`,
    selectionPolicy,
    totalFiles: 2,
    totalHunks: 3,
    files: [
      { path: 'one.md', summary: '两处修改', selectionPolicy, hunks: [
        { id: H1, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'remove', text: 'one' }] },
        { id: H2, oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: [{ kind: 'add', text: 'two' }] },
      ] },
      { path: 'two.md', summary: '一处修改', selectionPolicy, hunks: [
        { id: H3, oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: [{ kind: 'context', text: 'three' }] },
      ] },
    ],
  };
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('\nChanges review renderer state verification');

test('every hunk starts pending and no implicit apply decision exists', () => {
  const state = State.create(review());
  assert.deepStrictEqual(State.counts(state), { accepted: 0, rejected: 0, pending: 3, total: 3 });
  assert.strictEqual(State.toDecision(state), null);
  assert(Object.isFrozen(state) && Object.isFrozen(state.decisions));
});

test('individual accept and reject produce an ID-only exact decision', () => {
  let state = State.create(review());
  state = State.update(state, H1, 'accepted');
  state = State.update(state, H2, 'rejected');
  assert.deepStrictEqual(State.toDecision(state), {
    schema: State.DECISION_SCHEMA,
    changeSetId: `pc_${'a'.repeat(32)}`,
    acceptHunkIds: [H1],
    rejectHunkIds: [H2],
  });
  assert(!JSON.stringify(State.toDecision(state)).includes('one'));
  assert(!JSON.stringify(State.toDecision(state)).includes('one.md'));
});

test('file bulk action changes only that file and reset returns to pending', () => {
  let state = State.create(review());
  state = State.updateFile(state, 'one.md', 'accepted');
  assert.deepStrictEqual(State.counts(state), { accepted: 2, rejected: 0, pending: 1, total: 3 });
  state = State.updateFile(state, 'one.md', 'pending');
  assert.deepStrictEqual(State.counts(state), { accepted: 0, rejected: 0, pending: 3, total: 3 });
});

test('whole-file reviews cannot create a partial file decision', () => {
  let state = State.create(review('file'));
  state = State.update(state, H1, 'accepted');
  assert.deepStrictEqual(State.counts(state), { accepted: 2, rejected: 0, pending: 1, total: 3 });
  state = State.update(state, H1, 'rejected');
  assert.deepStrictEqual(State.counts(state), { accepted: 0, rejected: 2, pending: 1, total: 3 });
});

test('mixed review enforces whole-file policy only on the protected file', () => {
  const mixed = review('hunk');
  mixed.selectionPolicy = 'mixed';
  mixed.files[0].selectionPolicy = 'file';
  let state = State.create(mixed);
  state = State.update(state, H1, 'accepted');
  state = State.update(state, H3, 'rejected');
  assert.deepStrictEqual(State.counts(state), { accepted: 2, rejected: 1, pending: 0, total: 3 });
});

test('malformed, duplicate and count-mismatched reviews fail closed', () => {
  assert.strictEqual(State.create({ ...review(), totalHunks: 99 }), null);
  const duplicate = review();
  duplicate.files[1].hunks[0].id = H1;
  assert.strictEqual(State.create(duplicate), null);
  assert.strictEqual(State.create({ ...review(), changeSetId: 'cs_forged' }), null);
});

console.log(`\nChanges review renderer state ${passed}/${passed} passed.`);
