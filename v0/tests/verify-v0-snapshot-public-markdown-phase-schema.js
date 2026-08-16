#!/usr/bin/env node
'use strict';

const assert = require('assert');
const evidenceSchema = require('../src/main/evidence-delivery-schema');
const schema = require('../src/main/snapshot-public-markdown-phase-schema');

const digest = value => `sha256:${value.repeat(64)}`;
const operationId = `chr_${'a'.repeat(48)}`;
const timestamp = '2026-08-09T00:00:00.000Z';

function selectionItem(selectedId, action, index) {
  return {
    selectedId,
    action,
    path: `chapters/${selectedId}.md`,
    revision: String((index % 9) + 1).repeat(64),
    ancestorIdentityDigest: digest(String(((index + 1) % 9) + 1)),
  };
}

function parent(kind = 'snapshot_restore', selected = null) {
  const items = selected || (kind === 'snapshot_restore'
    ? [selectionItem('selected_existing', 'EXISTING', 0), selectionItem('selected_missing', 'MISSING', 1)]
    : [selectionItem('selected_existing', 'EXISTING', 0), selectionItem('selected_created', 'CREATED', 1)]);
  return { schema: schema.SELECTION_SCHEMA, kind, selected: items };
}

function phaseItem(binding, overrides = {}) {
  return {
    selectedId: binding.selectedId,
    path: binding.path,
    afterRevision: binding.revision,
    ancestorIdentityDigest: binding.ancestorIdentityDigest,
    createdIdentityDigest: null,
    creationReceiptDigest: null,
    quarantineReceiptDigest: null,
    ...overrides,
  };
}

function record(kind, phase, authority = parent(kind), overrides = {}) {
  const expected = authority.selected.filter(entry => entry.action === (
    kind === 'snapshot_restore' ? 'MISSING' : 'CREATED'
  ));
  const isRestore = kind === 'snapshot_restore';
  const created = isRestore && phase !== 'PRECREATE';
  const rollbackQuarantined = isRestore &&
    ['CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK'].includes(phase);
  const quarantined = (!isRestore &&
    ['QUARANTINED', 'HISTORY_COMMITTED', 'FINALIZED', 'RESTORED'].includes(phase)) ||
    rollbackQuarantined;
  const mixed = isRestore && authority.selected.some(entry => entry.action === 'EXISTING');
  const existingBound = mixed && [
    'EXISTING_COMMITTED', 'HISTORY_COMMITTED', 'FINALIZED',
    'CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK',
  ].includes(phase);
  return {
    schema: schema.SCHEMA,
    operationId,
    kind,
    phase,
    artifactDigest: digest('3'),
    selectionDigest: schema.digestSelection(authority),
    items: expected.map(binding => phaseItem(binding, {
      createdIdentityDigest: created || !isRestore ? digest('4') : null,
      creationReceiptDigest: created ? digest('5') : null,
      quarantineReceiptDigest: quarantined ? digest('6') : null,
    })),
    preparedHistoryDigest: isRestore && phase === 'PRECREATE' ? null : digest('7'),
    finalReceiptDigest: ['FINALIZED', 'RESTORED'].includes(phase) ? digest('8') : null,
    existingReceiptSetDigest: existingBound ? digest('9') : null,
    rollbackReceiptDigest: phase === 'ROLLED_BACK' ? digest('a') : null,
    updatedAt: timestamp,
    ...overrides,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function expectInvalid(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE');
}

console.log('\nSnapshot public-Markdown phase schema verification');

test('selection digest matches the frozen 3.1.4 Unicode canonical golden', () => {
  const authority = {
    selected: [{
      revision: '1'.repeat(64),
      path: '章节/😀.md',
      selectedId: 'selected_unicode',
      ancestorIdentityDigest: digest('2'),
      action: 'MISSING',
    }],
    kind: 'snapshot_restore',
    schema: schema.SELECTION_SCHEMA,
  };
  const canonical = '{"kind":"snapshot_restore","schema":"writcraft.changes-history-public-markdown-selection/v1","selected":[{"action":"MISSING","ancestorIdentityDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","path":"章节/😀.md","revision":"1111111111111111111111111111111111111111111111111111111111111111","selectedId":"selected_unicode"}]}';
  const preimage = Buffer.concat([
    Buffer.from('writcraft-digest/v1', 'utf8'),
    Buffer.from([0]),
    Buffer.from('writcraft.changes-history-public-markdown-selection/v1', 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonical, 'utf8'),
  ]);
  const goldenDigest = 'sha256:b56bb9d0eefeb8c94876856ab373093f763458816999cfeee25d59944828de05';
  assert.strictEqual(evidenceSchema.canonicalJson(authority), canonical);
  assert.deepStrictEqual(evidenceSchema.digestPreimage(schema.SELECTION_SCHEMA, authority), preimage);
  assert.strictEqual(schema.digestSelection(authority), goldenDigest);
  const reorderedKeys = {
    schema: schema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [{
      action: 'MISSING',
      ancestorIdentityDigest: digest('2'),
      selectedId: 'selected_unicode',
      revision: '1'.repeat(64),
      path: '章节/😀.md',
    }],
  };
  assert.strictEqual(schema.digestSelection(reorderedKeys), goldenDigest);
  expectInvalid(() => schema.digestSelection({
    ...authority,
    selected: [{ ...authority.selected[0], path: '章节/e\u0301.md' }],
  }));
});

test('mixed restore derives only the missing-leaf subset from complete parent authority', () => {
  const authority = parent();
  const precreate = record('snapshot_restore', 'PRECREATE', authority);
  const created = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  const valid = schema.assertPhaseRecord(precreate, authority);
  assert.deepStrictEqual(valid.items.map(entry => entry.selectedId), ['selected_missing']);
  assert.strictEqual(valid.items[0].createdIdentityDigest, null);
  schema.assertTransition(precreate, created, authority);
});

test('mixed restore freezes the only mainline and formal rollback branches', () => {
  const authority = parent();
  const precreate = record('snapshot_restore', 'PRECREATE', authority);
  const created = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  const existing = record('snapshot_restore', 'EXISTING_COMMITTED', authority);
  const history = record('snapshot_restore', 'HISTORY_COMMITTED', authority);
  const finalized = record('snapshot_restore', 'FINALIZED', authority);
  schema.assertTransition(precreate, created, authority);
  schema.assertTransition(created, existing, authority);
  schema.assertTransition(existing, history, authority);
  schema.assertTransition(history, finalized, authority);

  const rollback = record('snapshot_restore', 'CREATE_ROLLBACK_QUARANTINED', authority);
  const rolledBack = record('snapshot_restore', 'ROLLED_BACK', authority);
  schema.assertTransition(created, rollback, authority);
  schema.assertTransition(rollback, rolledBack, authority);

  const fullMissing = parent('snapshot_restore', [
    selectionItem('missing_a', 'MISSING', 0),
    selectionItem('missing_b', 'MISSING', 1),
  ]);
  schema.assertTransition(
    record('snapshot_restore', 'CREATED_RECEIPT', fullMissing),
    record('snapshot_restore', 'HISTORY_COMMITTED', fullMissing),
    fullMissing
  );
  expectInvalid(() => schema.assertTransition(
    record('snapshot_restore', 'CREATED_RECEIPT', fullMissing),
    record('snapshot_restore', 'EXISTING_COMMITTED', fullMissing),
    fullMissing
  ));
});

test('mixed digest nullability and branch CAS fail closed', () => {
  const authority = parent();
  const created = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  const existing = record('snapshot_restore', 'EXISTING_COMMITTED', authority);
  const history = record('snapshot_restore', 'HISTORY_COMMITTED', authority);
  const rollback = record('snapshot_restore', 'CREATE_ROLLBACK_QUARANTINED', authority);
  const rolledBack = record('snapshot_restore', 'ROLLED_BACK', authority);
  assert.strictEqual(created.existingReceiptSetDigest, null);
  assert.strictEqual(existing.rollbackReceiptDigest, null);
  assert.strictEqual(rollback.rollbackReceiptDigest, null);
  assert.strictEqual(rolledBack.rollbackReceiptDigest, digest('a'));
  assert.strictEqual(rollback.items[0].quarantineReceiptDigest, digest('6'));
  expectInvalid(() => schema.assertPhaseRecord({
    ...created, existingReceiptSetDigest: digest('9'),
  }, authority));
  expectInvalid(() => schema.assertPhaseRecord({
    ...existing, existingReceiptSetDigest: null,
  }, authority));
  expectInvalid(() => schema.assertPhaseRecord({
    ...rollback, rollbackReceiptDigest: digest('a'),
  }, authority));
  expectInvalid(() => schema.assertPhaseRecord({
    ...rolledBack, rollbackReceiptDigest: null,
  }, authority));
  expectInvalid(() => schema.assertTransition(existing, {
    ...history, existingReceiptSetDigest: digest('8'),
  }, authority));
  expectInvalid(() => schema.assertTransition(rollback, {
    ...rolledBack,
    items: [{ ...rolledBack.items[0], quarantineReceiptDigest: digest('8') }],
  }, authority));
});

test('cross-branch, backward, UNKNOWN and rollback replay stay locked', () => {
  const authority = parent();
  const created = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  const existing = record('snapshot_restore', 'EXISTING_COMMITTED', authority);
  const rollback = record('snapshot_restore', 'CREATE_ROLLBACK_QUARANTINED', authority);
  const rolledBack = record('snapshot_restore', 'ROLLED_BACK', authority);
  const history = record('snapshot_restore', 'HISTORY_COMMITTED', authority);
  expectInvalid(() => schema.assertTransition(created, history, authority));
  expectInvalid(() => schema.assertTransition(existing, rollback, authority));
  expectInvalid(() => schema.assertTransition(rollback, history, authority));
  expectInvalid(() => schema.assertTransition(rolledBack, rolledBack, authority));
  expectInvalid(() => schema.assertTransition(rollback, created, authority));
  expectInvalid(() => schema.assertPhaseRecord({ ...created, phase: 'UNKNOWN' }, authority));
});

test('existing leaf cannot be fabricated as a created receipt', () => {
  const authority = parent();
  const existing = authority.selected[0];
  expectInvalid(() => schema.assertPhaseRecord(record(
    'snapshot_restore',
    'CREATED_RECEIPT',
    authority,
    {
      items: [phaseItem(existing, {
        createdIdentityDigest: digest('4'),
        creationReceiptDigest: digest('5'),
      })],
    }
  ), authority));
});

test('every missing leaf is mandatory and omission fails closed', () => {
  const authority = parent('snapshot_restore', [
    selectionItem('selected_missing_a', 'MISSING', 0),
    selectionItem('selected_existing', 'EXISTING', 1),
    selectionItem('selected_missing_b', 'MISSING', 2),
  ]);
  const complete = record('snapshot_restore', 'PRECREATE', authority);
  assert.strictEqual(schema.assertPhaseRecord(complete, authority).items.length, 2);
  expectInvalid(() => schema.assertPhaseRecord({
    ...complete,
    items: [complete.items[0]],
  }, authority));
});

test('Safe Undo derives only CREATED and closes quarantine through finalization', () => {
  const authority = parent('snapshot_restore_undo');
  const precreate = record('snapshot_restore_undo', 'PRECREATE', authority);
  const quarantined = record('snapshot_restore_undo', 'QUARANTINED', authority);
  const committed = record('snapshot_restore_undo', 'HISTORY_COMMITTED', authority);
  const finalized = record('snapshot_restore_undo', 'FINALIZED', authority);
  assert.deepStrictEqual(schema.assertPhaseRecord(precreate, authority).items
    .map(entry => entry.selectedId), ['selected_created']);
  schema.assertTransition(precreate, quarantined, authority);
  schema.assertTransition(quarantined, committed, authority);
  schema.assertTransition(committed, finalized, authority);
});

test('Safe Undo B settlement reaches terminal RESTORED without claiming undone History', () => {
  const authority = parent('snapshot_restore_undo');
  const quarantined = record('snapshot_restore_undo', 'QUARANTINED', authority);
  const restored = record('snapshot_restore_undo', 'RESTORED', authority);
  const valid = schema.assertTransition(quarantined, restored, authority);
  assert.strictEqual(valid.phase, 'RESTORED');
  assert.strictEqual(valid.preparedHistoryDigest, quarantined.preparedHistoryDigest);
  assert.strictEqual(valid.items[0].quarantineReceiptDigest,
    quarantined.items[0].quarantineReceiptDigest);
  assert.strictEqual(valid.finalReceiptDigest, digest('8'));
  expectInvalid(() => schema.assertTransition(restored, quarantined, authority));
  expectInvalid(() => schema.assertTransition(restored, record(
    'snapshot_restore_undo',
    'HISTORY_COMMITTED',
    authority
  ), authority));
});

test('parent/top/item/array accessors are rejected with zero getter calls', () => {
  let getters = 0;
  const authority = parent();
  Object.defineProperty(authority.selected[1], 'path', {
    enumerable: true,
    get() { getters += 1; return 'chapters/evil.md'; },
  });
  expectInvalid(() => schema.assertParentSelectionBinding(authority));
  const top = record('snapshot_restore', 'PRECREATE', parent());
  Object.defineProperty(top, 'phase', {
    enumerable: true,
    get() { getters += 1; return 'PRECREATE'; },
  });
  expectInvalid(() => schema.assertPhaseRecord(top, parent()));
  for (const field of ['existingReceiptSetDigest', 'rollbackReceiptDigest']) {
    const hostile = record('snapshot_restore', 'CREATED_RECEIPT', parent());
    Object.defineProperty(hostile, field, {
      enumerable: true,
      get() { getters += 1; return null; },
    });
    expectInvalid(() => schema.assertPhaseRecord(hostile, parent()));
  }
  const item = record('snapshot_restore', 'PRECREATE', parent());
  Object.defineProperty(item.items[0], 'path', {
    enumerable: true,
    get() { getters += 1; return 'chapters/evil.md'; },
  });
  expectInvalid(() => schema.assertPhaseRecord(item, parent()));
  const array = parent();
  Object.defineProperty(array.selected, '1', {
    enumerable: true,
    get() { getters += 1; return selectionItem('evil', 'MISSING', 1); },
  });
  expectInvalid(() => schema.assertParentSelectionBinding(array));
  assert.strictEqual(getters, 0);
});

test('parent binding rejects Symbol, hidden, sparse, duplicate and invalid action mapping', () => {
  const symbolic = parent();
  symbolic[Symbol('smuggled')] = true;
  expectInvalid(() => schema.assertParentSelectionBinding(symbolic));
  const hidden = parent();
  Object.defineProperty(hidden.selected[0], 'hidden', { value: true, enumerable: false });
  expectInvalid(() => schema.assertParentSelectionBinding(hidden));
  const sparse = parent();
  sparse.selected = new Array(2);
  expectInvalid(() => schema.assertParentSelectionBinding(sparse));
  const duplicate = parent('snapshot_restore', [
    selectionItem('same', 'EXISTING', 0), selectionItem('same', 'MISSING', 1),
  ]);
  expectInvalid(() => schema.assertParentSelectionBinding(duplicate));
  const wrongAction = parent('snapshot_restore', [selectionItem('created', 'CREATED', 0)]);
  expectInvalid(() => schema.assertParentSelectionBinding(wrongAction));
});

test('complete 300-item MISSING subset is accepted and independent 301 parent is rejected', () => {
  const selected = Array.from({ length: 300 }, (_, index) => selectionItem(
    `selected_${index}`,
    'MISSING',
    index
  ));
  const authority = parent('snapshot_restore', selected);
  assert.strictEqual(schema.assertParentSelectionBinding(authority).selected.length, 300);
  assert.strictEqual(schema.assertPhaseRecord(
    record('snapshot_restore', 'PRECREATE', authority),
    authority
  ).items.length, 300);
  const created = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  const history = record('snapshot_restore', 'HISTORY_COMMITTED', authority);
  assert.strictEqual(created.items.length, 300);
  assert.strictEqual(schema.assertTransition(created, history, authority).items.length, 300);

  const tooMany = parent('snapshot_restore', Array.from(
    { length: 301 },
    (_, index) => selectionItem(`overflow_${index}`, 'MISSING', 300 - index)
  ));
  expectInvalid(() => schema.assertParentSelectionBinding(tooMany));
});

test('parent reorder and path/revision/ancestor drift invalidate phase authority', () => {
  const authority = parent();
  const phase = record('snapshot_restore', 'PRECREATE', authority);
  for (const drifted of [
    parent('snapshot_restore', [...authority.selected].reverse()),
    parent('snapshot_restore', [authority.selected[1]]),
    parent('snapshot_restore', [
      authority.selected[0], { ...authority.selected[1], path: 'chapters/drift.md' },
    ]),
    parent('snapshot_restore', [
      authority.selected[0], { ...authority.selected[1], revision: '9'.repeat(64) },
    ]),
    parent('snapshot_restore', [
      authority.selected[0], { ...authority.selected[1], ancestorIdentityDigest: digest('9') },
    ]),
  ]) {
    expectInvalid(() => schema.assertPhaseRecord(phase, drifted));
    expectInvalid(() => schema.assertTransition(
      phase,
      record('snapshot_restore', 'CREATED_RECEIPT', authority),
      authority,
      drifted
    ));
  }
});

test('subset order/path/revision/receipt drift and duplicate path fail closed', () => {
  const authority = parent('snapshot_restore', [
    selectionItem('missing_a', 'MISSING', 0), selectionItem('missing_b', 'MISSING', 1),
  ]);
  const before = record('snapshot_restore', 'PRECREATE', authority);
  const after = record('snapshot_restore', 'CREATED_RECEIPT', authority);
  schema.assertTransition(before, after, authority);
  for (const items of [
    [...after.items].reverse(),
    [{ ...after.items[0], path: 'chapters/drift.md' }, after.items[1]],
    [{ ...after.items[0], afterRevision: '9'.repeat(64) }, after.items[1]],
    [{ ...after.items[0], ancestorIdentityDigest: digest('9') }, after.items[1]],
  ]) expectInvalid(() => schema.assertPhaseRecord({ ...after, items }, authority));
  expectInvalid(() => schema.assertTransition(after, {
    ...record('snapshot_restore', 'HISTORY_COMMITTED', authority),
    items: [{ ...after.items[0], creationReceiptDigest: digest('9') }, after.items[1]],
  }, authority));
  const duplicatePath = parent('snapshot_restore', [
    selectionItem('a', 'MISSING', 0),
    { ...selectionItem('b', 'MISSING', 1), path: 'chapters/a.md' },
  ]);
  expectInvalid(() => schema.assertParentSelectionBinding(duplicatePath));
});

test('skipped/backward phases and FINALIZED replay fail closed', () => {
  const authority = parent('snapshot_restore_undo');
  const precreate = record('snapshot_restore_undo', 'PRECREATE', authority);
  const quarantined = record('snapshot_restore_undo', 'QUARANTINED', authority);
  const committed = record('snapshot_restore_undo', 'HISTORY_COMMITTED', authority);
  const finalized = record('snapshot_restore_undo', 'FINALIZED', authority);
  expectInvalid(() => schema.assertTransition(precreate, committed, authority));
  expectInvalid(() => schema.assertTransition(committed, quarantined, authority));
  expectInvalid(() => schema.assertTransition(finalized, finalized, authority));
});

console.log(`\n${passed}/15 Snapshot public-Markdown phase schema checks passed.`);
