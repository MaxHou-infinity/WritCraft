'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  APPLY_RESULT_SCHEMA,
  ERROR_SCHEMA,
  TERMINAL_STATES,
  createInlineRewriteApplyService,
} = require('../src/main/inline-rewrite-apply-service');

const BEFORE = 'before selected text after';
const AFTER = 'before concise text after';
const PATH = 'chapters/01.md';
const REWRITE_ID = `ir_${'a'.repeat(32)}`;
const HISTORY_ID = 'change_123e4567-e89b-42d3-a456-426614174000';

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function proposal() {
  return {
    rewriteId: REWRITE_ID,
    dependencies: { schema: 'writcraft.inline-rewrite-dependencies/v1' },
    changeSet: {
      schema: 'writcraft.changeset/v1',
      id: `cs_${'b'.repeat(24)}`,
      changes: [{
        path: PATH,
        before: BEFORE,
        after: AFTER,
        expectedRevision: revision(BEFORE),
        summary: '精简重复表达',
      }],
    },
    provenance: { schema: 'writcraft.inline-rewrite/v1' },
  };
}

function matchingHistory() {
  return {
    id: HISTORY_ID,
    provenance: {
      schema: 'writcraft.inline-rewrite/v1', kind: 'inline_rewrite', rewriteId: REWRITE_ID,
    },
  };
}

function harness(overrides = {}) {
  let content = overrides.content ?? BEFORE;
  let historyEntry = overrides.historyEntry ?? null;
  const events = [];
  const markerCalls = [];
  const projectService = {
    readFileWithRevision(_root, targetPath) {
      events.push(`read:${targetPath}`);
      if (overrides.readThrows) throw new Error('read fault');
      return { content, revision: revision(content) };
    },
  };
  const historyService = {
    applyAndRecord(_projectService, _root, changeSet, options) {
      events.push('history');
      assert.strictEqual(changeSet, item.lease.proposal.changeSet);
      assert.strictEqual(options.provenance, item.lease.proposal.provenance);
      if (overrides.historyThrows) throw new Error('history preflight fault');
      if (typeof overrides.historyApply === 'function') {
        return overrides.historyApply({
          get content() { return content; },
          set content(value) { content = value; },
          events,
        });
      }
      content = AFTER;
      historyEntry = matchingHistory();
      return { ok: true, historyEntry };
    },
  };
  const validateDependencies = () => {
    events.push('dependencies');
    if (overrides.dependencyError) throw overrides.dependencyError;
    return true;
  };
  const reconciliationService = {
    finish(marker) {
      events.push('marker');
      markerCalls.push(marker);
      if (overrides.markerThrows) throw new Error('marker fault');
      if (overrides.markerReturnsFalse) return false;
      return marker;
    },
  };
  const item = {
    lease: {
      rewriteId: REWRITE_ID,
      applyLeaseId: `iral_${'c'.repeat(32)}`,
      proposal: proposal(),
    },
    projectService,
    rootPath: '/project',
    projectId: '123e4567-e89b-42d3-a456-426614174000',
    projectInstanceId: `instance_${'d'.repeat(24)}`,
    mutationGeneration: 3,
    reconciliationService,
  };
  const findHistory = () => {
    events.push('find-history');
    if (overrides.findHistoryThrows) throw new Error('history read fault');
    return historyEntry;
  };
  const service = createInlineRewriteApplyService({ historyService, validateDependencies, findHistory });
  return {
    item,
    service,
    events,
    markerCalls,
    get content() { return content; },
  };
}

function assertExactError(result, code, recoverable) {
  assert.deepStrictEqual(Object.keys(result).sort(), ['error', 'ok', 'schema']);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.schema, ERROR_SCHEMA);
  assert.deepStrictEqual(Object.keys(result.error).sort(), ['code', 'message', 'recoverable']);
  assert.strictEqual(result.error.code, code);
  assert.strictEqual(result.error.recoverable, recoverable);
  assert(result.error.message.length > 0);
}

function assertExactSuccess(result, status) {
  assert.deepStrictEqual(Object.keys(result).sort(), [
    'historyEntryId', 'historyUnavailable', 'manualRecoveryRequired', 'message', 'ok',
    'path', 'refreshRequired', 'revision', 'schema', 'status',
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.schema, APPLY_RESULT_SCHEMA);
  assert.strictEqual(result.status, status);
  assert.strictEqual(result.path, PATH);
  assert.strictEqual(result.revision, revision(AFTER));
}

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

console.log('\nInline Rewrite Main apply coordinator verification');

test('dependency preflight drift is terminal stale, zero-write, and marker-first', () => {
  const error = Object.assign(new Error('private stale detail'), { code: 'INLINE_REWRITE_STALE' });
  const h = harness({ dependencyError: error });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_STALE', true);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.STALE);
  assert.strictEqual(h.content, BEFORE);
  assert(!h.events.includes('history'));
  assert.strictEqual(h.markerCalls[0].outcome, 'zero_write_error');
  assert.strictEqual(h.markerCalls[0].errorCode, 'INLINE_REWRITE_STALE');
});

test('apply accepts only the proposal sealed into a valid apply lease', () => {
  const h = harness();
  h.item.proposal = {
    ...proposal(),
    changeSet: {
      ...proposal().changeSet,
      changes: [{ ...proposal().changeSet.changes[0], after: 'forged renderer proposal' }],
    },
  };
  const outcome = h.service.apply(h.item);
  assertExactSuccess(outcome.result, 'applied');
  assert.strictEqual(h.content, AFTER);
});

test('missing apply lease identity is nonrecoverable and terminalizes marker as manual recovery', () => {
  const h = harness();
  h.item.lease.applyLeaseId = null;
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
  assert.strictEqual(h.markerCalls[0].outcome, 'manual_recovery');
  assert(!h.events.includes('history'));
});

test('target write failure with authoritative original bytes is zero-write rolled back', () => {
  const h = harness({
    historyApply: () => ({ ok: false, status: 'rolled_back', applied: [], rolledBack: [] }),
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_WRITE_FAILED', true);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.FAILED_ROLLED_BACK);
  assert.strictEqual(h.content, BEFORE);
  assert.strictEqual(h.markerCalls[0].outcome, 'zero_write_error');
});

test('History preflight failure before target write remains zero-write', () => {
  const h = harness({ historyThrows: true });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_WRITE_FAILED', true);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.FAILED_ROLLED_BACK);
  assert.strictEqual(h.content, BEFORE);
  assert.strictEqual(h.markerCalls[0].revision, revision(BEFORE));
});

test('History failure plus successful rollback is a trusted zero-write error', () => {
  const h = harness({
    historyApply: state => {
      state.content = BEFORE;
      return { ok: false, status: 'history_failed_rolled_back', applied: [{ path: PATH }], rolledBack: [{ path: PATH }] };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_WRITE_FAILED', true);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.FAILED_ROLLED_BACK);
  assert.strictEqual(h.markerCalls[0].outcome, 'zero_write_error');
});

test('target before plus a matching History entry is contradictory and requires manual recovery', () => {
  const h = harness({
    historyEntry: matchingHistory(),
    historyApply: () => ({ ok: false, status: 'history_failed_rolled_back' }),
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(h.markerCalls[0].outcome, 'manual_recovery');
  assert.strictEqual(h.markerCalls[0].historyEntryId, HISTORY_ID);
});

test('History and rollback failure with exact after bytes returns committed warning', () => {
  const h = harness({
    historyApply: state => {
      state.content = AFTER;
      return { ok: false, status: 'history_failed_rollback_failed', rollbackFailed: [{ path: PATH }] };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactSuccess(outcome.result, 'committed_warning');
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.COMMITTED_WARNING);
  assert.strictEqual(outcome.result.historyEntryId, null);
  assert.strictEqual(outcome.result.refreshRequired, true);
  assert.strictEqual(outcome.result.historyUnavailable, true);
  assert.strictEqual(outcome.result.manualRecoveryRequired, true);
  assert.strictEqual(h.markerCalls[0].outcome, 'committed_warning');
});

test('History and rollback failure with ambiguous disk bytes requires manual recovery', () => {
  const h = harness({
    historyApply: state => {
      state.content = 'ambiguous third state';
      return { ok: false, status: 'history_failed_rollback_failed', rollbackFailed: [{ path: PATH }] };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
  assert.strictEqual(h.markerCalls[0].outcome, 'manual_recovery');
});

test('conflict plus exact after bytes is not attributed to this apply', () => {
  const h = harness({
    historyApply: state => {
      state.content = AFTER;
      return { ok: false, status: 'conflict' };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(h.markerCalls[0].outcome, 'manual_recovery');
});

test('uncertain after bytes plus matching History is contradictory and requires manual recovery', () => {
  const h = harness({
    historyEntry: matchingHistory(),
    historyApply: state => {
      state.content = AFTER;
      return { ok: false, status: 'history_failed_rollback_failed' };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
});

test('History authority read failure never returns trusted zero-write', () => {
  const h = harness({ historyThrows: true, findHistoryThrows: true });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
});

test('post-commit refresh failure preserves History truth as committed warning', () => {
  const h = harness();
  h.item.refreshCommitted = () => { throw new Error('tree refresh fault'); };
  const outcome = h.service.apply(h.item);
  assertExactSuccess(outcome.result, 'committed_warning');
  assert.strictEqual(outcome.result.historyEntryId, HISTORY_ID);
  assert.strictEqual(outcome.result.refreshRequired, true);
  assert.strictEqual(outcome.result.historyUnavailable, false);
  assert.strictEqual(outcome.result.manualRecoveryRequired, false);
  assert.strictEqual(h.markerCalls[0].outcome, 'committed_warning');
});

test('success-shaped History with foreign provenance is not trusted', () => {
  const h = harness({
    historyApply: state => {
      state.content = AFTER;
      return {
        ok: true,
        historyEntry: {
          id: HISTORY_ID,
          provenance: {
            schema: 'writcraft.inline-rewrite/v1', kind: 'inline_rewrite',
            rewriteId: `ir_${'f'.repeat(32)}`,
          },
        },
      };
    },
  });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(h.markerCalls[0].outcome, 'manual_recovery');
});

test('terminal marker finish failure never returns a retryable or trusted commit result', () => {
  const h = harness({ markerThrows: true });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
  assert.strictEqual(h.content, AFTER);
  assert.strictEqual(h.markerCalls.length, 1);
});

test('zero-write terminal marker finish failure also blocks ordinary recovery', () => {
  const error = Object.assign(new Error('stale'), { code: 'INLINE_REWRITE_STALE' });
  const h = harness({ dependencyError: error, markerThrows: true });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
  assert.strictEqual(h.content, BEFORE);
  assert.strictEqual(h.markerCalls[0].outcome, 'zero_write_error');
});

test('falsy terminal marker finish is treated as persistence failure', () => {
  const h = harness({ markerReturnsFalse: true });
  const outcome = h.service.apply(h.item);
  assertExactError(outcome.result, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false);
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.MANUAL_RECOVERY);
});

test('ordinary success returns exact applied truth after authoritative reread and marker', () => {
  const h = harness();
  const outcome = h.service.apply(h.item);
  assertExactSuccess(outcome.result, 'applied');
  assert.strictEqual(outcome.terminalState, TERMINAL_STATES.APPLIED);
  assert.strictEqual(outcome.result.historyEntryId, HISTORY_ID);
  assert.strictEqual(outcome.result.refreshRequired, false);
  assert.strictEqual(outcome.result.historyUnavailable, false);
  assert.strictEqual(outcome.result.manualRecoveryRequired, false);
  assert.deepStrictEqual(h.events.slice(0, 2), ['dependencies', 'history']);
  assert.strictEqual(h.markerCalls[0].outcome, 'applied');
});

console.log(`\n${passed}/${passed} inline-rewrite apply coordinator checks passed.\n`);
