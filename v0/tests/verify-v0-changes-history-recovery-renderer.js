#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Recovery = require('../src/renderer/changes-history-recovery-transaction');

const OPERATION_ID = `chr_${'a'.repeat(48)}`;
const CREATED_AT = '2026-07-26T01:02:03.000Z';
const UPDATED_AT = '2026-07-26T01:02:04.000Z';
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function marker(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    kind: 'apply',
    state: 'terminal',
    outcome: 'applied',
    affectedPaths: ['chapters/01.md'],
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    actions: [],
    ...overrides,
  };
}

function query(recovery = marker()) {
  return {
    ok: true,
    schema: Recovery.QUERY_SCHEMA,
    recovery,
  };
}

function mutation(overrides = {}) {
  return {
    ok: true,
    status: 'applied',
    operationId: OPERATION_ID,
    outcome: 'applied',
    affectedPaths: ['chapters/01.md'],
    ...overrides,
  };
}

console.log('\nChanges / History Renderer recovery verification');

test('accepts and freezes an exact safe public recovery marker', () => {
  const result = Recovery.normalizeRecovery(marker());
  assert(result && Object.isFrozen(result) && Object.isFrozen(result.affectedPaths));
  assert.deepStrictEqual([...result.affectedPaths], ['chapters/01.md']);
});

test('rejects accessor fields without invoking getters', () => {
  let invoked = 0;
  const hostile = marker();
  Object.defineProperty(hostile, 'operationId', {
    enumerable: true,
    get() { invoked += 1; return OPERATION_ID; },
  });
  assert.strictEqual(Recovery.normalizeRecovery(hostile), null);
  assert.strictEqual(invoked, 0);
});

test('rejects custom prototypes and prototype-pollution keys', () => {
  assert.strictEqual(Recovery.normalizeRecovery(Object.assign(Object.create({ poisoned: true }), marker())), null);
  const hostile = marker();
  Object.defineProperty(hostile, '__proto__', { enumerable: true, value: {} });
  assert.strictEqual(Recovery.normalizeRecovery(hostile), null);
});

test('rejects invalid operation identity, kind, state and outcome combinations', () => {
  assert.strictEqual(Recovery.normalizeRecovery(marker({ operationId: `chr_${'g'.repeat(48)}` })), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ kind: 'delete' })), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ state: 'applying', outcome: 'applied' })), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ kind: 'apply', outcome: 'undone' })), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ updatedAt: '2026-07-25T01:02:04.000Z' })), null);
  assert(Recovery.normalizeRecovery(marker({ state: 'applying', outcome: null })));
});

test('enforces kind-to-path cardinality and safe unique Markdown paths', () => {
  assert(Recovery.normalizeRecovery(marker({ kind: 'review', outcome: 'reviewed', affectedPaths: [] })));
  assert.strictEqual(Recovery.normalizeRecovery(marker({ kind: 'review' })), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ affectedPaths: [] })), null);
  for (const value of [
    ['../escape.md'], ['.writcraft/private.md'], ['/absolute.md'], ['a\\b.md'],
    ['a.txt'], ['a.md', 'a.md'], ['e\u0301.md'],
  ]) {
    assert.strictEqual(Recovery.normalizeRecovery(marker({ affectedPaths: value })), null);
  }
});

test('requires exact manual actions and rejects extra marker fields', () => {
  const manual = marker({
    outcome: 'manual_recovery',
    actions: ['restore_before', 'keep_after'],
  });
  assert(Recovery.normalizeRecovery(manual));
  assert.strictEqual(Recovery.normalizeRecovery({ ...manual, secretRoot: '/tmp/project' }), null);
  assert.strictEqual(Recovery.normalizeRecovery({ ...manual, actions: ['keep_after', 'restore_before'] }), null);
  assert.strictEqual(Recovery.normalizeRecovery(marker({ actions: ['restore_before', 'keep_after'] })), null);
});

test('validates exact query, resolve and clear success schemas', () => {
  assert(Recovery.normalizeQueryResult(query()));
  assert(Recovery.normalizeQueryResult(query(null)));
  assert(Recovery.normalizeResolveResult({
    ok: true,
    schema: Recovery.RESOLVE_SCHEMA,
    recovery: marker({ outcome: 'applied' }),
  }));
  assert(Recovery.normalizeClearResult({
    ok: true,
    schema: Recovery.CLEAR_SCHEMA,
    operationId: OPERATION_ID,
  }));
  assert.strictEqual(Recovery.normalizeQueryResult({ ...query(), extra: true }), null);
  assert.strictEqual(Recovery.normalizeClearResult({
    ok: true, schema: Recovery.CLEAR_SCHEMA, operationId: OPERATION_ID, recovery: null,
  }), null);
});

test('validates bounded public errors while rejecting leaked fields', () => {
  const failure = {
    ok: false,
    schema: Recovery.ERROR_SCHEMA,
    error: { code: 'CHANGES_RECOVERY_QUERY_FAILED', message: '请重开项目', recoverable: true },
  };
  assert(Recovery.normalizeQueryResult(failure));
  assert.strictEqual(Recovery.normalizeQueryResult({
    ...failure,
    rootPath: '/secret/project',
  }), null);
  assert.strictEqual(Recovery.normalizeQueryResult({
    ...failure,
    operationId: 'not-an-operation',
  }), null);
});

test('routes no marker to ready', () => {
  assert.deepStrictEqual(Recovery.routeQueryResult(query(null)), {
    action: 'ready',
    recovery: null,
  });
});

test('routes safe terminal outcomes to authoritative reload and clear', () => {
  for (const [kind, outcome, paths] of [
    ['apply', 'applied', ['a.md']],
    ['review', 'reviewed', []],
    ['undo', 'undone', ['a.md']],
    ['apply', 'zero_write_error', ['a.md']],
  ]) {
    assert.strictEqual(Recovery.routeQueryResult(query(marker({
      kind, outcome, affectedPaths: paths,
    }))).action, 'reload-and-clear');
  }
});

test('routes both uncertain terminal outcomes to manual recovery', () => {
  for (const outcome of ['committed_warning', 'manual_recovery']) {
    assert.strictEqual(Recovery.routeQueryResult(query(marker({
      outcome,
      actions: ['restore_before', 'keep_after'],
    }))).action, 'manual-recovery');
  }
});

test('routes applying, malformed and failed query results to reopen-required', () => {
  assert.strictEqual(Recovery.routeQueryResult(query(marker({
    state: 'applying',
    outcome: null,
  }))).action, 'reopen-required');
  assert.strictEqual(Recovery.routeQueryResult({ ok: true }).action, 'reopen-required');
  assert.strictEqual(Recovery.routeQueryResult({
    ok: false,
    schema: Recovery.ERROR_SCHEMA,
    error: { code: 'CHANGES_RECOVERY_QUERY_FAILED', message: '失败', recoverable: true },
  }).action, 'reopen-required');
});

test('binds apply response to exact operation, outcome and ordered paths', () => {
  const recovery = marker();
  assert.strictEqual(Recovery.mutationMatchesRecovery('apply', mutation(), recovery), true);
  assert.strictEqual(Recovery.mutationMatchesRecovery('apply', mutation({
    operationId: `chr_${'b'.repeat(48)}`,
  }), recovery), false);
  assert.strictEqual(Recovery.mutationMatchesRecovery('apply', mutation({
    outcome: 'committed_warning',
  }), recovery), false);
  assert.strictEqual(Recovery.mutationMatchesRecovery('apply', mutation({
    affectedPaths: ['other.md'],
  }), recovery), false);
});

test('allows reject-only review under apply flow but never under undo flow', () => {
  const reviewMarker = marker({ kind: 'review', outcome: 'reviewed', affectedPaths: [] });
  const reviewResponse = mutation({ status: 'reviewed', outcome: 'reviewed', affectedPaths: [] });
  assert.strictEqual(Recovery.mutationMatchesRecovery('apply', reviewResponse, reviewMarker), true);
  assert.strictEqual(Recovery.mutationMatchesRecovery('undo', reviewResponse, reviewMarker), false);
});

test('binds undo only to an undo marker with exact public truth', () => {
  const undoMarker = marker({ kind: 'undo', outcome: 'undone' });
  const undoResponse = mutation({ status: 'undone', outcome: 'undone' });
  assert.strictEqual(Recovery.mutationMatchesRecovery('undo', undoResponse, undoMarker), true);
  assert.strictEqual(Recovery.mutationMatchesRecovery('undo', undoResponse, marker({
    kind: 'apply', outcome: 'undone',
  })), false);
});

test('resolve and clear acknowledgements cannot cross operation identities', () => {
  const expected = marker({
    outcome: 'manual_recovery',
    actions: ['restore_before', 'keep_after'],
  });
  const resolved = {
    ok: true,
    schema: Recovery.RESOLVE_SCHEMA,
    recovery: marker({ outcome: 'applied' }),
  };
  assert.strictEqual(Recovery.resolveMatchesRecovery(resolved, expected, 'restore_before'), true);
  assert.strictEqual(Recovery.resolveMatchesRecovery(resolved, expected, 'invalid'), false);
  assert.strictEqual(Recovery.clearMatchesRecovery({
    ok: true,
    schema: Recovery.CLEAR_SCHEMA,
    operationId: OPERATION_ID,
  }, expected), true);
  assert.strictEqual(Recovery.clearMatchesRecovery({
    ok: true,
    schema: Recovery.CLEAR_SCHEMA,
    operationId: `chr_${'b'.repeat(48)}`,
  }, expected), false);
});

console.log(`\nChanges / History Renderer recovery: ${passed}/${passed} passed.`);
