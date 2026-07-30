#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Transaction = require('../src/renderer/inline-rewrite-transaction');

const R1 = '1'.repeat(64);
const R2 = '2'.repeat(64);
const REWRITE_ID = `ir_${'a'.repeat(32)}`;
const CAPABILITY_ID = `irc_${'b'.repeat(32)}`;
const INSTRUCTION = '压缩重复表达';
const HISTORY_ID = 'change_12345678-1234-4123-8123-123456789abc';
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function proof(overrides = {}) {
  return {
    schema: 'writcraft.block-anchor/v1',
    id: 'block_1234abcd',
    filePath: 'chapters/01.md',
    type: 'paragraph',
    headingKey: 'intro',
    ordinal: 1,
    blockFingerprint: '1234abcd',
    quoteFingerprint: '5678abcd',
    relativeStart: 2,
    relativeEnd: 8,
    ...overrides,
  };
}

function selection(rangeIdentity = { id: 1 }, overrides = {}) {
  return {
    startOffset: 12,
    endOffset: 18,
    digest: `sha256:${'3'.repeat(64)}`,
    proof: proof(),
    rangeIdentity,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    project: { instanceId: 'project-1' },
    currentPath: 'chapters/01.md',
    revision: R1,
    openGeneration: 7,
    editorSession: 11,
    editVersion: 19,
    dirtyGeneration: 23,
    dirty: true,
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    ok: true,
    schema: 'writcraft.inline-rewrite-review/v1',
    outcome: 'review',
    rewriteId: REWRITE_ID,
    capabilityId: CAPABILITY_ID,
    expiresAt: 2000000000000,
    replacement: '替换文本',
    summary: '精简表达',
    contextManifest: { schema: 'writcraft.context-manifest/v1' },
    ...overrides,
  };
}

function applied(overrides = {}) {
  return {
    ok: true,
    schema: 'writcraft.inline-rewrite-apply-result/v1',
    status: 'applied',
    path: 'chapters/01.md',
    revision: R2,
    historyEntryId: HISTORY_ID,
    refreshRequired: false,
    historyUnavailable: false,
    manualRecoveryRequired: false,
    message: '已应用',
    ...overrides,
  };
}

function knownError(code = 'INLINE_REWRITE_STALE', recoverable = true) {
  return {
    ok: false,
    schema: 'writcraft.inline-rewrite-error/v1',
    error: { code, message: '请求已失效', recoverable },
  };
}

function marker(outcome = 'applied', overrides = {}) {
  return {
    rewriteId: REWRITE_ID,
    path: 'chapters/01.md',
    state: 'terminal',
    outcome,
    revision: R2,
    historyEntryId: HISTORY_ID,
    errorCode: null,
    updatedAt: 2000000000000,
    ...overrides,
  };
}

async function run() {
  console.log('\nInline Rewrite Renderer transaction verification');

  await test('freezes every pre-await intent field without retaining selected text', async () => {
    const rangeIdentity = { id: 1 };
    const intent = Transaction.captureIntent(state(), selection(rangeIdentity), 'concise', INSTRUCTION);
    assert(intent && Object.isFrozen(intent) && Object.isFrozen(intent.selection) && Object.isFrozen(intent.selection.proof));
    assert.deepStrictEqual({
      project: intent.projectInstanceId,
      path: intent.currentPath,
      open: intent.openGeneration,
      session: intent.editorSession,
      version: intent.editVersion,
      dirtyGeneration: intent.dirtyGeneration,
      dirty: intent.dirty,
      start: intent.selection.startOffset,
      end: intent.selection.endOffset,
      digest: intent.selection.digest,
      range: intent.selection.rangeIdentity,
    }, {
      project: 'project-1', path: 'chapters/01.md', open: 7, session: 11, version: 19,
      dirtyGeneration: 23, dirty: true, start: 12, end: 18,
      digest: `sha256:${'3'.repeat(64)}`, range: rangeIdentity,
    });
    assert.strictEqual('text' in intent.selection, false);
    assert.strictEqual(intent.instruction, INSTRUCTION);
    assert.strictEqual(Transaction.captureIntent(state(), selection(null), 'concise', INSTRUCTION), null);
    assert.strictEqual(Transaction.captureIntent(state(), selection(rangeIdentity), 'unknown', INSTRUCTION), null);
    for (const invalid of ['', ' bad ', 'bad\nline', 'x'.repeat(501), '\u202Ehidden']) {
      assert.strictEqual(Transaction.captureIntent(state(), selection(rangeIdentity), 'concise', invalid), null);
    }
  });

  await test('rejects drift in each project, file, editor, dirty, selection, proof and range identity field', async () => {
    const rangeIdentity = { id: 1 };
    const originalState = state();
    const originalSelection = selection(rangeIdentity);
    const intent = Transaction.captureIntent(originalState, originalSelection, 'general', INSTRUCTION);
    const stateDrifts = [
      { project: { instanceId: 'project-2' } }, { currentPath: 'chapters/02.md' },
      { revision: R2 }, { openGeneration: 8 }, { editorSession: 12 }, { editVersion: 20 },
      { dirtyGeneration: 24 }, { dirty: false },
    ];
    for (const drift of stateDrifts) {
      assert.strictEqual(Transaction.initialBindingMatches(intent, state({ ...drift }), originalSelection, intent.style, INSTRUCTION), false);
    }
    const selectionDrifts = [
      { startOffset: 13 }, { endOffset: 19 }, { digest: `sha256:${'4'.repeat(64)}` },
      { proof: proof({ quoteFingerprint: '00000000' }) }, { rangeIdentity: { id: 1 } },
    ];
    for (const drift of selectionDrifts) {
      assert.strictEqual(Transaction.initialBindingMatches(intent, originalState, selection(rangeIdentity, drift), intent.style, INSTRUCTION), false);
    }
    assert.strictEqual(Transaction.initialBindingMatches(intent, originalState, originalSelection, 'vivid', INSTRUCTION), false);
    assert.strictEqual(Transaction.initialBindingMatches(intent, originalState, originalSelection, intent.style, '另一条要求'), false);
  });

  await test('accepts only NFC public Markdown paths in intent, apply truth and recovery markers', async () => {
    const rangeIdentity = { id: 1 };
    const invalidPaths = [
      '.writcraft/private.md', 'references/.hidden/fact.md', 'chapters/01.txt',
      'chapters/01.md\0tail', 'chapters/01\n.md', 'chapters//01.md',
      'chapters/../01.md', '/chapters/01.md', 'chapters\\01.md', 'chapters/e\u0301.md',
    ];
    for (const currentPath of invalidPaths) {
      assert.strictEqual(Transaction.captureIntent(
        state({ currentPath }),
        selection(rangeIdentity, { proof: proof({ filePath: currentPath }) }),
        'general', INSTRUCTION,
      ), null, `accepted unsafe path ${JSON.stringify(currentPath)}`);
      assert.strictEqual(Transaction.classifyApplyResponse(applied({ path: currentPath }), 'chapters/01.md').kind, 'outcome_unknown');
      assert.strictEqual(Transaction.normalizeReconciliation({
        ok: true,
        schema: 'writcraft.inline-rewrite-reconciliation-result/v1',
        status: 'terminal',
        marker: marker('applied', { path: currentPath }),
      }), null);
    }
    const markdownPath = 'appendix/notes.markdown';
    assert(Transaction.captureIntent(
      state({ currentPath: markdownPath }),
      selection(rangeIdentity, { proof: proof({ filePath: markdownPath }) }),
      'general', INSTRUCTION,
    ));
  });

  await test('permits exactly the own dirty persist revision transition and binds every later phase to it', async () => {
    const rangeIdentity = { id: 1 };
    let currentState = state();
    let currentSelection = selection(rangeIdentity);
    const intent = Transaction.captureIntent(currentState, currentSelection, 'general', INSTRUCTION);
    let settleCalls = 0;
    const prepared = await Transaction.prepareIntent(intent, {
      getState: () => currentState,
      getSelection: () => currentSelection,
      getStyle: () => 'general',
      getInstruction: () => INSTRUCTION,
      persist: async expected => {
        assert.strictEqual(expected, R1);
        currentState = state({ revision: R2, dirty: false });
        return { ok: true, revision: R2 };
      },
      settleWatcher: async () => { settleCalls += 1; },
    });
    assert.strictEqual(prepared.ok, true);
    assert.strictEqual(prepared.binding.persistedRevision, R2);
    assert.strictEqual(settleCalls, 1);
    assert.strictEqual(Transaction.preparedBindingMatches(prepared.binding, currentState, currentSelection, 'general', INSTRUCTION), true);
    assert.strictEqual(Transaction.preparedBindingMatches(prepared.binding, state({ revision: R1, dirty: false }), currentSelection, 'general', INSTRUCTION), false);
    assert.strictEqual(Transaction.createRequest(prepared.binding).expectedRevision, R2);

    currentState = state();
    currentSelection = selection(rangeIdentity);
    const watcherFailureIntent = Transaction.captureIntent(currentState, currentSelection, 'general', INSTRUCTION);
    const watcherFailure = await Transaction.prepareIntent(watcherFailureIntent, {
      getState: () => currentState,
      getSelection: () => currentSelection,
      getStyle: () => 'general',
      getInstruction: () => INSTRUCTION,
      persist: async () => {
        currentState = state({ revision: R2, dirty: false });
        return { ok: true, revision: R2 };
      },
      settleWatcher: async () => { throw new Error('barrier failed'); },
    });
    assert.deepStrictEqual(watcherFailure, { ok: false, reason: 'WATCHER_UNAVAILABLE' });
  });

  await test('clean intent cannot smuggle a revision transition and watcher/selection drift stops before IPC', async () => {
    const rangeIdentity = { id: 1 };
    let currentState = state({ dirty: false });
    let currentSelection = selection(rangeIdentity);
    const clean = Transaction.captureIntent(currentState, currentSelection, 'general', INSTRUCTION);
    const advanced = await Transaction.prepareIntent(clean, {
      getState: () => currentState,
      getSelection: () => currentSelection,
      getStyle: () => 'general',
      getInstruction: () => INSTRUCTION,
      persist: async () => {
        currentState = state({ revision: R2, dirty: false });
        return { ok: true, revision: R2 };
      },
      settleWatcher: async () => {},
    });
    assert.deepStrictEqual(advanced, { ok: false, reason: 'PERSIST_FAILED' });

    currentState = state();
    const dirtyIntent = Transaction.captureIntent(currentState, currentSelection, 'general', INSTRUCTION);
    const drifted = await Transaction.prepareIntent(dirtyIntent, {
      getState: () => currentState,
      getSelection: () => currentSelection,
      getStyle: () => 'general',
      getInstruction: () => INSTRUCTION,
      persist: async () => {
        currentState = state({ revision: R2, dirty: false });
        return { ok: true, revision: R2 };
      },
      settleWatcher: async () => { currentSelection = selection({ id: 2 }); },
    });
    assert.deepStrictEqual(drifted, { ok: false, reason: 'INTENT_STALE' });
  });

  await test('controlled slow persist observes unsaved typing and selection-only movement', async () => {
    for (const mutate of [
      context => { context.currentState = state({ revision: R2, dirty: false, editVersion: 20 }); },
      context => { context.currentSelection = selection({ id: 2 }); },
    ]) {
      const context = { currentState: state(), currentSelection: selection({ id: 1 }) };
      const intent = Transaction.captureIntent(context.currentState, context.currentSelection, 'general', INSTRUCTION);
      const gate = deferred();
      const pending = Transaction.prepareIntent(intent, {
        getState: () => context.currentState,
        getSelection: () => context.currentSelection,
        getStyle: () => 'general',
      getInstruction: () => INSTRUCTION,
        persist: () => gate.promise,
        settleWatcher: async () => {},
      });
      mutate(context);
      gate.resolve({ ok: true, revision: R2 });
      assert.deepStrictEqual(await pending, { ok: false, reason: 'INTENT_STALE' });
    }
  });

  await test('strict review and ACK validators reject extra keys, wrong association shapes and malformed output', async () => {
    assert(Transaction.normalizeReviewResult(review()));
    assert.strictEqual(Transaction.normalizeReviewResult(review({ extra: true })), null);
    assert.strictEqual(Transaction.normalizeReviewResult(review({ replacement: 'x'.repeat(13 * 1024) })), null);
    const noOp = review({ outcome: 'no_op', capabilityId: null, expiresAt: null, replacement: '原文' });
    assert(Transaction.normalizeReviewResult(noOp));
    assert.strictEqual(Transaction.normalizeReviewResult({ ...noOp, capabilityId: CAPABILITY_ID }), null);
    assert.strictEqual(Transaction.validAckResult({
      ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review',
    }), true);
    assert.strictEqual(Transaction.validAckResult({
      ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review', extra: true,
    }), false);
  });

  await test('owner state machine prevents old finally, late ACK, foreign apply and post-destroy publication', async () => {
    const owner = Transaction.createOwner();
    const first = owner.begin({ id: 'first' });
    assert(owner.transition(first, Transaction.STATES.GENERATING));
    const second = owner.begin({ id: 'second' });
    assert.strictEqual(owner.transition(first, Transaction.STATES.GENERATING), false);
    assert(owner.transition(second, Transaction.STATES.GENERATING));
    assert(owner.associateReview(second, review(), true));
    assert.deepStrictEqual(owner.ackPayload(second, true), {
      schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: REWRITE_ID, capabilityId: CAPABILITY_ID,
    });
    assert.strictEqual(owner.acknowledge(first, {
      ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review',
    }, true), false);
    assert(owner.acknowledge(second, {
      ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review',
    }, true));
    const payload = owner.beginApply(second, true);
    assert.deepStrictEqual(payload, {
      schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: REWRITE_ID, capabilityId: CAPABILITY_ID,
    });
    const destroyed = owner.destroy();
    assert.strictEqual(destroyed.discardAllowed, false, 'APPLYING must finish in Main');
    assert.strictEqual(owner.owns(second), false);
    assert.strictEqual(owner.settleApply(second, applied()), null);
  });

  await test('reject/regenerate/destroy invalidate pre-apply ownership and expose only safe discard cleanup', async () => {
    const owner = Transaction.createOwner();
    const token = owner.begin({ id: 'active' });
    owner.transition(token, Transaction.STATES.GENERATING);
    owner.associateReview(token, review(), true);
    owner.acknowledge(token, { ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review' }, true);
    const invalidated = owner.invalidate(Transaction.STATES.REJECTED);
    assert.strictEqual(invalidated.rewriteId, REWRITE_ID);
    assert.strictEqual(owner.owns(token), false);

    const other = Transaction.createOwner();
    const otherToken = other.begin({ id: 'other' });
    other.transition(otherToken, Transaction.STATES.GENERATING);
    assert.deepStrictEqual(other.discardPayload(otherToken), {
      schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: null, capabilityId: null,
    });
    other.associateReview(otherToken, review(), true);
    assert.deepStrictEqual(other.discardPayload(otherToken), {
      schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: REWRITE_ID, capabilityId: CAPABILITY_ID,
    });
    const destroyed = other.destroy();
    assert.strictEqual(destroyed.discardAllowed, true);
    assert.deepStrictEqual(Transaction.discardPayloadForReview(review()), {
      schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: REWRITE_ID, capabilityId: CAPABILITY_ID,
    });
  });

  await test('routes the four apply outcomes without Renderer commit inference', async () => {
    assert.strictEqual(Transaction.classifyApplyResponse(applied(), 'chapters/01.md').kind, 'trusted_success');
    const warning = applied({
      status: 'committed_warning', refreshRequired: true, historyEntryId: HISTORY_ID,
      message: '已应用，请重开项目；不要重试',
    });
    assert.strictEqual(Transaction.classifyApplyResponse(warning, 'chapters/01.md').kind, 'trusted_success');
    assert.strictEqual(Transaction.classifyApplyResponse(knownError(), 'chapters/01.md').kind, 'known_zero_write_error');
    assert.strictEqual(Transaction.classifyApplyResponse(
      knownError('INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED', false), 'chapters/01.md'
    ).kind, 'manual_recovery');
    assert.strictEqual(Transaction.classifyApplyResponse(undefined, 'chapters/01.md').kind, 'outcome_unknown');
    assert.strictEqual(Transaction.classifyApplyResponse({ ...applied(), extra: true }, 'chapters/01.md').kind, 'outcome_unknown');
    assert.strictEqual(Transaction.classifyApplyResponse(applied({ path: 'chapters/02.md' }), 'chapters/01.md').kind, 'outcome_unknown');
  });

  await test('malformed committed warnings become APPLY_OUTCOME_UNKNOWN and capability is never retried', async () => {
    for (const invalid of [
      applied({ status: 'committed_warning', refreshRequired: false }),
      applied({ status: 'committed_warning', historyEntryId: null, refreshRequired: true, historyUnavailable: false }),
      applied({ historyEntryId: null }),
    ]) assert.strictEqual(Transaction.classifyApplyResponse(invalid, 'chapters/01.md').kind, 'outcome_unknown');
    const owner = Transaction.createOwner();
    const token = owner.begin({ id: 'apply' });
    owner.transition(token, Transaction.STATES.GENERATING);
    owner.associateReview(token, review(), true);
    owner.acknowledge(token, { ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review' }, true);
    owner.beginApply(token, true);
    assert.strictEqual(owner.settleApply(token, null).kind, 'outcome_unknown');
    assert.strictEqual(owner.getActive().state, Transaction.STATES.APPLY_OUTCOME_UNKNOWN);
    assert.strictEqual(owner.beginApply(token, true), null);
  });

  await test('marker lifecycle distinguishes poll, reload-and-clear, zero-write restore and mandatory reopen', async () => {
    const applying = {
      ok: true,
      schema: 'writcraft.inline-rewrite-reconciliation-result/v1',
      status: 'applying',
      marker: marker(null, {
        state: 'applying', outcome: null, revision: null, historyEntryId: null, errorCode: null,
      }),
    };
    const terminal = {
      ok: true, schema: 'writcraft.inline-rewrite-reconciliation-result/v1', status: 'terminal', marker: marker(),
    };
    const manual = {
      ...terminal,
      marker: marker('manual_recovery', { revision: null, historyEntryId: null, errorCode: 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED' }),
    };
    assert.strictEqual(Transaction.reconciliationAction(applying).action, 'poll');
    assert.strictEqual(Transaction.reconciliationAction(terminal).action, 'reload-and-clear');
    assert.strictEqual(Transaction.reconciliationAction(terminal, `ir_${'c'.repeat(32)}`).action, 'reopen-required');
    assert.strictEqual(Transaction.reconciliationAction(manual).action, 'manual-recovery');
    assert.strictEqual(Transaction.reconciliationAction({ bad: true }).action, 'reopen-required');
    for (const contradictory of [
      marker('applied', { revision: null }),
      marker('applied', { historyEntryId: null }),
      marker('zero_write_error', { historyEntryId: HISTORY_ID, errorCode: 'INLINE_REWRITE_WRITE_FAILED' }),
      marker('manual_recovery', { errorCode: null }),
    ]) {
      assert.strictEqual(Transaction.normalizeReconciliation({
        ok: true, schema: 'writcraft.inline-rewrite-reconciliation-result/v1', status: 'terminal', marker: contradictory,
      }), null);
    }
    assert.strictEqual(Transaction.markerLifecycle({ kind: 'outcome_unknown' }, terminal).action, 'reload-and-clear');
    assert.deepStrictEqual(Transaction.reconciliationClearPayload(terminal.marker), {
      schema: 'writcraft.inline-rewrite-reconciliation-clear/v1', rewriteId: REWRITE_ID,
    });
    assert.strictEqual(Transaction.reconciliationClearPayload(applying.marker), null);
    assert.strictEqual(Transaction.markerLifecycle({ kind: 'known_zero_write_error' }).action, 'clear-then-restore');
    assert.strictEqual(Transaction.markerLifecycle({
      kind: 'trusted_success', result: applied({
        status: 'committed_warning', historyEntryId: null, refreshRequired: true,
        historyUnavailable: true, manualRecoveryRequired: true,
      }),
    }).action, 'manual-recovery');
  });

  await test('restore, refocus and committed caret helpers fail closed on stale/destroyed/uncleared bindings', async () => {
    assert.strictEqual(Transaction.canRestoreOrRefocus('reject', true, false, false), true);
    assert.strictEqual(Transaction.canRestoreOrRefocus('pre-send-failure', true, false, false), true);
    assert.strictEqual(Transaction.canRestoreOrRefocus('known-zero-write-error', true, true, false), true);
    assert.strictEqual(Transaction.canRestoreOrRefocus('known-zero-write-error', true, false, false), false);
    assert.strictEqual(Transaction.canRestoreOrRefocus('outcome-unknown', true, true, false), false);
    assert.strictEqual(Transaction.canRestoreOrRefocus('reject', true, false, true), false);
    assert.strictEqual(Transaction.canPlaceCommittedCaret(
      Transaction.classifyApplyResponse(applied(), 'chapters/01.md'), true, true, false
    ), true);
    assert.strictEqual(Transaction.canPlaceCommittedCaret(
      Transaction.classifyApplyResponse(applied(), 'chapters/01.md'), false, true, false
    ), false);
  });

  await test('all terminal Renderer states are explicit and state transitions fail closed', async () => {
    for (const value of ['idle', 'preparing', 'generating', 'installing', 'reviewing', 'applying',
      'applied', 'committed-warning', 'APPLY_OUTCOME_UNKNOWN', 'reconciled', 'reopen-required',
      'manual-recovery', 'no-op', 'failed', 'stale', 'project-switched', 'selection-changed',
      'canceled', 'rejected', 'discarded', 'expired', 'regenerating']) {
      assert(Object.values(Transaction.STATES).includes(value), `missing ${value}`);
    }
    const owner = Transaction.createOwner();
    const token = owner.begin({ id: 'state' });
    assert.strictEqual(owner.transition(token, Transaction.STATES.APPLIED), false);
    assert.strictEqual(owner.getActive().state, Transaction.STATES.PREPARING);
  });

  assert.strictEqual(passed, 14);
  console.log(`\nInline Rewrite Renderer transaction verification passed: ${passed}/14.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
