// DOM-free Renderer ownership, intent and recovery guards for Inline Rewrite v1.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftInlineRewriteTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUEST_SCHEMA = 'writcraft.inline-rewrite/v1';
  const REVIEW_SCHEMA = 'writcraft.inline-rewrite-review/v1';
  const ACK_RESULT_SCHEMA = 'writcraft.inline-rewrite-ack-result/v1';
  const APPLY_RESULT_SCHEMA = 'writcraft.inline-rewrite-apply-result/v1';
  const ERROR_SCHEMA = 'writcraft.inline-rewrite-error/v1';
  const RECONCILIATION_RESULT_SCHEMA = 'writcraft.inline-rewrite-reconciliation-result/v1';
  const REWRITE_ID = /^ir_[a-f0-9]{32}$/;
  const CAPABILITY_ID = /^irc_[a-f0-9]{32}$/;
  const REVISION = /^[a-f0-9]{64}$/;
  const HISTORY_ID = /^change_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const DIGEST = /^sha256:[a-f0-9]{64}$/;
  const BLOCK_ID = /^block_[a-f0-9]{8}$/;
  const FINGERPRINT = /^[a-f0-9]{8}$/;
  const STYLES = Object.freeze(['general', 'concise', 'vivid', 'academic', 'casual']);
  const PROOF_KEYS = Object.freeze([
    'schema', 'id', 'filePath', 'type', 'headingKey', 'ordinal',
    'blockFingerprint', 'quoteFingerprint', 'relativeStart', 'relativeEnd',
  ]);
  const ERROR_CODES = new Set([
    'INVALID_INLINE_REWRITE', 'INLINE_REWRITE_TOO_LARGE', 'INLINE_REWRITE_BUSY',
    'INLINE_REWRITE_NOT_FOUND', 'INLINE_REWRITE_ACK_TIMEOUT',
    'INLINE_REWRITE_NOT_ACKNOWLEDGED', 'INLINE_REWRITE_STALE',
    'INLINE_REWRITE_EXPIRED', 'INLINE_REWRITE_REPLAYED',
    'INLINE_REWRITE_PROTECTED_TARGET', 'MODEL_OUTPUT_TRUNCATED',
    'MODEL_OUTPUT_INCOMPLETE', 'INVALID_MODEL_OUTPUT',
    'INLINE_REWRITE_WRITE_FAILED', 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED',
  ]);

  const STATES = Object.freeze({
    IDLE: 'idle',
    PREPARING: 'preparing',
    GENERATING: 'generating',
    INSTALLING: 'installing',
    REVIEWING: 'reviewing',
    REGENERATING: 'regenerating',
    APPLYING: 'applying',
    APPLIED: 'applied',
    COMMITTED_WARNING: 'committed-warning',
    APPLY_OUTCOME_UNKNOWN: 'APPLY_OUTCOME_UNKNOWN',
    RECONCILED: 'reconciled',
    REOPEN_REQUIRED: 'reopen-required',
    MANUAL_RECOVERY: 'manual-recovery',
    NO_OP: 'no-op',
    FAILED: 'failed',
    STALE: 'stale',
    PROJECT_SWITCHED: 'project-switched',
    SELECTION_CHANGED: 'selection-changed',
    CANCELED: 'canceled',
    REJECTED: 'rejected',
    DISCARDED: 'discarded',
    EXPIRED: 'expired',
  });

  const TRANSITIONS = Object.freeze({
    idle: ['preparing'],
    preparing: ['generating', 'failed', 'stale', 'project-switched', 'selection-changed', 'canceled'],
    generating: ['installing', 'no-op', 'failed', 'stale', 'project-switched', 'selection-changed', 'canceled'],
    installing: ['reviewing', 'failed', 'stale', 'project-switched', 'selection-changed', 'canceled', 'expired'],
    reviewing: ['applying', 'regenerating', 'rejected', 'discarded', 'expired', 'stale', 'project-switched', 'selection-changed'],
    regenerating: ['generating', 'failed', 'stale', 'project-switched', 'selection-changed', 'canceled'],
    applying: ['applied', 'committed-warning', 'manual-recovery', 'failed', 'stale', 'APPLY_OUTCOME_UNKNOWN'],
    APPLY_OUTCOME_UNKNOWN: ['reconciled', 'reopen-required', 'manual-recovery'],
  });

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function exactKeys(value, keys) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function byteLength(value) {
    return new TextEncoder().encode(String(value)).byteLength;
  }

  function validPath(value) {
    if (typeof value !== 'string' || !value || byteLength(value) > 1024 || value !== value.normalize('NFC') ||
        value.startsWith('/') || value.includes('\\') || value.includes('//') ||
        /[\u0000-\u001F\u007F-\u009F]/u.test(value)) return false;
    const parts = value.split('/');
    return !parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) &&
      /\.(?:md|markdown)$/i.test(parts[parts.length - 1]);
  }

  function cloneProof(value) {
    if (!exactKeys(value, PROOF_KEYS) || value.schema !== 'writcraft.block-anchor/v1' ||
        !BLOCK_ID.test(value.id) || !validPath(value.filePath) || typeof value.type !== 'string' || !value.type ||
        byteLength(value.type) > 80 || typeof value.headingKey !== 'string' || byteLength(value.headingKey) > 1024 ||
        !Number.isSafeInteger(value.ordinal) || value.ordinal < 1 ||
        !FINGERPRINT.test(value.blockFingerprint) || !FINGERPRINT.test(value.quoteFingerprint) ||
        !Number.isSafeInteger(value.relativeStart) || value.relativeStart < 0 ||
        !Number.isSafeInteger(value.relativeEnd) || value.relativeEnd < value.relativeStart) return null;
    const copy = {};
    for (const key of PROOF_KEYS) copy[key] = value[key];
    return Object.freeze(copy);
  }

  function sameProof(left, right) {
    const normalized = cloneProof(right);
    return Boolean(left && normalized && PROOF_KEYS.every(key => left[key] === normalized[key]));
  }

  function normalizeSelection(value, currentPath) {
    if (!isPlainObject(value) || !Number.isSafeInteger(value.startOffset) || value.startOffset < 0 ||
        !Number.isSafeInteger(value.endOffset) || value.endOffset <= value.startOffset ||
        !DIGEST.test(value.digest || '') || value.rangeIdentity === null || value.rangeIdentity === undefined) return null;
    const proof = cloneProof(value.proof);
    if (!proof || proof.filePath !== currentPath) return null;
    return Object.freeze({
      startOffset: value.startOffset,
      endOffset: value.endOffset,
      digest: value.digest,
      proof,
      rangeIdentity: value.rangeIdentity,
    });
  }

  function captureIntent(workspaceState, selection, style) {
    const projectInstanceId = workspaceState?.project?.instanceId;
    const currentPath = workspaceState?.currentPath;
    const revision = workspaceState?.revision;
    const openGeneration = workspaceState?.openGeneration;
    const editorSession = Number.isSafeInteger(workspaceState?.editorSession)
      ? workspaceState.editorSession
      : openGeneration;
    const dirtyGeneration = Number.isSafeInteger(workspaceState?.dirtyGeneration)
      ? workspaceState.dirtyGeneration
      : workspaceState?.editVersion;
    const normalized = normalizeSelection(selection, currentPath);
    if (typeof projectInstanceId !== 'string' || !projectInstanceId || !validPath(currentPath) ||
        !REVISION.test(revision || '') || !Number.isSafeInteger(openGeneration) || openGeneration < 0 ||
        !Number.isSafeInteger(editorSession) || editorSession < 0 ||
        !Number.isSafeInteger(workspaceState?.editVersion) || workspaceState.editVersion < 0 ||
        !Number.isSafeInteger(dirtyGeneration) || dirtyGeneration < 0 ||
        typeof workspaceState?.dirty !== 'boolean' || !STYLES.includes(style) || !normalized) return null;
    return Object.freeze({
      schema: REQUEST_SCHEMA,
      projectInstanceId,
      currentPath,
      revision,
      openGeneration,
      editorSession,
      editVersion: workspaceState.editVersion,
      dirtyGeneration,
      dirty: workspaceState.dirty,
      style,
      selection: normalized,
    });
  }

  function identityMatches(intent, workspaceState, selection, currentStyle) {
    if (!intent || !workspaceState?.project) return false;
    const current = normalizeSelection(selection, workspaceState.currentPath);
    const editorSession = Number.isSafeInteger(workspaceState.editorSession)
      ? workspaceState.editorSession
      : workspaceState.openGeneration;
    const dirtyGeneration = Number.isSafeInteger(workspaceState.dirtyGeneration)
      ? workspaceState.dirtyGeneration
      : workspaceState.editVersion;
    return Boolean(current && currentStyle === intent.style && intent.projectInstanceId === workspaceState.project.instanceId &&
      intent.currentPath === workspaceState.currentPath && intent.openGeneration === workspaceState.openGeneration &&
      intent.editorSession === editorSession && intent.editVersion === workspaceState.editVersion &&
      intent.dirtyGeneration === dirtyGeneration && intent.selection.startOffset === current.startOffset &&
      intent.selection.endOffset === current.endOffset && intent.selection.digest === current.digest &&
      intent.selection.rangeIdentity === current.rangeIdentity && sameProof(intent.selection.proof, current.proof));
  }

  function initialBindingMatches(intent, workspaceState, selection, currentStyle) {
    return identityMatches(intent, workspaceState, selection, currentStyle) && intent.revision === workspaceState.revision &&
      intent.dirty === workspaceState.dirty;
  }

  function preparedBindingMatches(binding, workspaceState, selection, currentStyle) {
    return Boolean(binding && identityMatches(binding.intent, workspaceState, selection, currentStyle) &&
      workspaceState.dirty === false && workspaceState.revision === binding.persistedRevision);
  }

  function normalizePersistResult(result) {
    if (!exactKeys(result, ['ok', 'revision']) || result.ok !== true || !REVISION.test(result.revision || '')) return null;
    return Object.freeze({ ok: true, revision: result.revision });
  }

  async function prepareIntent(intent, adapters) {
    if (!intent || !adapters || typeof adapters.getState !== 'function' ||
        typeof adapters.getSelection !== 'function' || typeof adapters.getStyle !== 'function' || typeof adapters.persist !== 'function' ||
        typeof adapters.settleWatcher !== 'function') return Object.freeze({ ok: false, reason: 'INVALID_INTENT' });
    if (!initialBindingMatches(intent, adapters.getState(), adapters.getSelection(), adapters.getStyle())) {
      return Object.freeze({ ok: false, reason: 'INTENT_STALE' });
    }
    const persisted = normalizePersistResult(await adapters.persist(intent.revision));
    if (!persisted || (!intent.dirty && persisted.revision !== intent.revision)) {
      return Object.freeze({ ok: false, reason: 'PERSIST_FAILED' });
    }
    const binding = Object.freeze({ intent, persistedRevision: persisted.revision });
    if (!preparedBindingMatches(binding, adapters.getState(), adapters.getSelection(), adapters.getStyle())) {
      return Object.freeze({ ok: false, reason: 'INTENT_STALE' });
    }
    await adapters.settleWatcher();
    if (!preparedBindingMatches(binding, adapters.getState(), adapters.getSelection(), adapters.getStyle())) {
      return Object.freeze({ ok: false, reason: 'INTENT_STALE' });
    }
    return Object.freeze({ ok: true, binding });
  }

  function createRequest(binding) {
    if (!binding?.intent || !REVISION.test(binding.persistedRevision || '')) return null;
    const intent = binding.intent;
    const request = {
      schema: REQUEST_SCHEMA,
      currentFilePath: intent.currentPath,
      expectedRevision: binding.persistedRevision,
      style: intent.style,
      selection: {
        startOffset: intent.selection.startOffset,
        endOffset: intent.selection.endOffset,
        proof: intent.selection.proof,
      },
    };
    if (byteLength(JSON.stringify(request)) > 4 * 1024) return null;
    return Object.freeze({ ...request, selection: Object.freeze(request.selection) });
  }

  function validSummary(value) {
    return typeof value === 'string' && value && value === value.trim() && !/[\0\r\n]/.test(value) &&
      Array.from(value).length <= 240 && byteLength(value) <= 1024;
  }

  function normalizeReviewResult(value) {
    const keys = ['ok', 'schema', 'outcome', 'rewriteId', 'capabilityId', 'expiresAt',
      'replacement', 'summary', 'contextManifest'];
    if (!exactKeys(value, keys) || value.ok !== true || value.schema !== REVIEW_SCHEMA ||
        !['review', 'no_op'].includes(value.outcome) || !REWRITE_ID.test(value.rewriteId || '') ||
        typeof value.replacement !== 'string' || value.replacement.includes('\0') ||
        byteLength(value.replacement) > 12 * 1024 || !validSummary(value.summary) ||
        !isPlainObject(value.contextManifest) || value.contextManifest.schema !== 'writcraft.context-manifest/v1') return null;
    if (value.outcome === 'review' && (!CAPABILITY_ID.test(value.capabilityId || '') ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0)) return null;
    if (value.outcome === 'no_op' && (value.capabilityId !== null || value.expiresAt !== null)) return null;
    return Object.freeze({ ...value });
  }

  function validAckResult(value) {
    return exactKeys(value, ['ok', 'schema', 'status']) && value.ok === true &&
      value.schema === ACK_RESULT_SCHEMA && value.status === 'review';
  }

  function normalizeApplySuccess(value) {
    const keys = ['ok', 'schema', 'status', 'path', 'revision', 'historyEntryId', 'refreshRequired',
      'historyUnavailable', 'manualRecoveryRequired', 'message'];
    if (!exactKeys(value, keys) || value.ok !== true || value.schema !== APPLY_RESULT_SCHEMA ||
        !['applied', 'committed_warning'].includes(value.status) || !validPath(value.path) ||
        !REVISION.test(value.revision || '') || typeof value.refreshRequired !== 'boolean' ||
        typeof value.historyUnavailable !== 'boolean' || typeof value.manualRecoveryRequired !== 'boolean' ||
        typeof value.message !== 'string' || !value.message || byteLength(value.message) > 1024) return null;
    const historyValid = value.historyEntryId === null || HISTORY_ID.test(value.historyEntryId || '');
    if (!historyValid) return null;
    if (value.status === 'applied' && (!HISTORY_ID.test(value.historyEntryId || '') ||
        value.refreshRequired || value.historyUnavailable || value.manualRecoveryRequired)) return null;
    const logicalRefreshWarning = value.status === 'committed_warning' && HISTORY_ID.test(value.historyEntryId || '') &&
      value.refreshRequired && !value.historyUnavailable && !value.manualRecoveryRequired;
    const historyRecoveryWarning = value.status === 'committed_warning' && value.historyEntryId === null &&
      value.refreshRequired && value.historyUnavailable && value.manualRecoveryRequired;
    if (value.status === 'committed_warning' && !logicalRefreshWarning && !historyRecoveryWarning) return null;
    return Object.freeze({ ...value });
  }

  function normalizeError(value) {
    if (!exactKeys(value, ['ok', 'schema', 'error']) || value.ok !== false || value.schema !== ERROR_SCHEMA ||
        !exactKeys(value.error, ['code', 'message', 'recoverable']) || !ERROR_CODES.has(value.error.code) ||
        typeof value.error.message !== 'string' || !value.error.message || byteLength(value.error.message) > 1024 ||
        typeof value.error.recoverable !== 'boolean') return null;
    if (value.error.code === 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED' && value.error.recoverable !== false) return null;
    return Object.freeze({ ...value, error: Object.freeze({ ...value.error }) });
  }

  function classifyApplyResponse(value, expectedPath) {
    const success = normalizeApplySuccess(value);
    if (success && validPath(expectedPath) && success.path === expectedPath) {
      return Object.freeze({ kind: 'trusted_success', result: success });
    }
    if (success) return Object.freeze({ kind: 'outcome_unknown', result: null });
    const error = normalizeError(value);
    if (error?.error.code === 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED') {
      return Object.freeze({ kind: 'manual_recovery', result: error });
    }
    if (error) return Object.freeze({ kind: 'known_zero_write_error', result: error });
    return Object.freeze({ kind: 'outcome_unknown', result: null });
  }

  function normalizeMarker(value) {
    const keys = ['rewriteId', 'path', 'state', 'outcome', 'revision', 'historyEntryId', 'errorCode', 'updatedAt'];
    if (!exactKeys(value, keys) || !REWRITE_ID.test(value.rewriteId || '') || !validPath(value.path) ||
        !['applying', 'terminal'].includes(value.state) || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0) return null;
    if (value.state === 'applying') {
      if (value.outcome !== null || value.revision !== null || value.historyEntryId !== null || value.errorCode !== null) return null;
    } else {
      const revisionValid = REVISION.test(value.revision || '');
      const historyValid = HISTORY_ID.test(value.historyEntryId || '');
      const errorValid = ERROR_CODES.has(value.errorCode);
      const outcomeValid =
        (value.outcome === 'applied' && revisionValid && historyValid && value.errorCode === null) ||
        (value.outcome === 'committed_warning' && revisionValid &&
          (value.historyEntryId === null || historyValid) && value.errorCode === null) ||
        (value.outcome === 'zero_write_error' && revisionValid && value.historyEntryId === null && errorValid &&
          value.errorCode !== 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED') ||
        (value.outcome === 'manual_recovery' && (value.revision === null || revisionValid) &&
          (value.historyEntryId === null || historyValid) &&
          value.errorCode === 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED');
      if (!outcomeValid) return null;
    }
    return Object.freeze({ ...value });
  }

  function normalizeReconciliation(value, expectedRewriteId = null) {
    if (!exactKeys(value, ['ok', 'schema', 'status', 'marker']) || value.ok !== true ||
        value.schema !== RECONCILIATION_RESULT_SCHEMA || !['none', 'applying', 'terminal'].includes(value.status)) return null;
    if (value.status === 'none') return value.marker === null ? Object.freeze({ ...value }) : null;
    const marker = normalizeMarker(value.marker);
    if (!marker || marker.state !== value.status ||
        (expectedRewriteId !== null && marker.rewriteId !== expectedRewriteId)) return null;
    return Object.freeze({ ...value, marker });
  }

  function reconciliationAction(value, expectedRewriteId = null) {
    const normalized = normalizeReconciliation(value, expectedRewriteId);
    if (!normalized) return Object.freeze({ action: 'reopen-required', marker: null });
    if (normalized.status === 'none') return Object.freeze({ action: 'ready', marker: null });
    if (normalized.status === 'applying') return Object.freeze({ action: 'poll', marker: normalized.marker });
    if (normalized.marker.outcome === 'manual_recovery') {
      return Object.freeze({ action: 'manual-recovery', marker: normalized.marker });
    }
    return Object.freeze({ action: 'reload-and-clear', marker: normalized.marker });
  }

  function markerLifecycle(route, reconciliation, expectedRewriteId = null) {
    if (!route || route.kind === 'outcome_unknown') return reconciliationAction(reconciliation, expectedRewriteId);
    if (route.kind === 'manual_recovery') return Object.freeze({ action: 'manual-recovery', marker: null });
    if (route.kind === 'known_zero_write_error') return Object.freeze({ action: 'clear-then-restore', marker: null });
    if (route.kind === 'trusted_success') {
      return route.result.manualRecoveryRequired
        ? Object.freeze({ action: 'manual-recovery', marker: null })
        : Object.freeze({ action: 'reload-and-clear', marker: null });
    }
    return Object.freeze({ action: 'reopen-required', marker: null });
  }

  function canRestoreOrRefocus(reason, bindingCurrent, markerCleared, destroyed) {
    if (!bindingCurrent || destroyed) return false;
    if (reason === 'reject' || reason === 'pre-send-failure') return true;
    return reason === 'known-zero-write-error' && markerCleared === true;
  }

  function canPlaceCommittedCaret(route, bindingCurrent, authoritativeReloaded, destroyed) {
    return Boolean(route?.kind === 'trusted_success' && bindingCurrent && authoritativeReloaded && !destroyed &&
      route.result.manualRecoveryRequired === false);
  }

  function discardPayloadForReview(value) {
    const review = normalizeReviewResult(value);
    if (!review || review.outcome !== 'review') return null;
    return Object.freeze({
      schema: 'writcraft.inline-rewrite-discard/v1',
      rewriteId: review.rewriteId,
      capabilityId: review.capabilityId,
    });
  }

  function reconciliationClearPayload(value) {
    const marker = normalizeMarker(value);
    if (!marker || marker.state !== 'terminal') return null;
    return Object.freeze({
      schema: 'writcraft.inline-rewrite-reconciliation-clear/v1',
      rewriteId: marker.rewriteId,
    });
  }

  function createOwner() {
    let sequence = 0;
    let active = null;
    let destroyed = false;

    function snapshot(record) {
      return record ? Object.freeze({
        token: record.token,
        state: record.state,
        rewriteId: record.rewriteId,
        capabilityId: record.capabilityId,
        intent: record.intent,
      }) : null;
    }

    function owns(token) {
      return Boolean(!destroyed && active && token && active.token === token && token.sequence === sequence);
    }

    function begin(intent) {
      if (destroyed || !intent) return null;
      sequence += 1;
      const token = Object.freeze({ sequence });
      active = { token, state: STATES.PREPARING, rewriteId: null, capabilityId: null, intent };
      return token;
    }

    function transition(token, next) {
      if (!owns(token) || !TRANSITIONS[active.state]?.includes(next)) return false;
      active.state = next;
      return true;
    }

    function associateReview(token, value, bindingCurrent) {
      const review = normalizeReviewResult(value);
      if (!owns(token) || active.state !== STATES.GENERATING || !review || !bindingCurrent) return null;
      if (review.outcome === 'no_op') {
        active.rewriteId = review.rewriteId;
        active.state = STATES.NO_OP;
        return snapshot(active);
      }
      active.rewriteId = review.rewriteId;
      active.capabilityId = review.capabilityId;
      active.state = STATES.INSTALLING;
      return snapshot(active);
    }

    function acknowledge(token, value, bindingCurrent) {
      if (!owns(token) || active.state !== STATES.INSTALLING || !bindingCurrent || !validAckResult(value)) return false;
      active.state = STATES.REVIEWING;
      return true;
    }

    function ackPayload(token, bindingCurrent) {
      if (!owns(token) || active.state !== STATES.INSTALLING || !bindingCurrent) return null;
      return Object.freeze({
        schema: 'writcraft.inline-rewrite-ack/v1',
        rewriteId: active.rewriteId,
        capabilityId: active.capabilityId,
      });
    }

    function discardPayload(token) {
      if (!owns(token) || active.state === STATES.APPLYING ||
          !['generating', 'installing', 'reviewing', 'regenerating'].includes(active.state)) return null;
      return Object.freeze({
        schema: 'writcraft.inline-rewrite-discard/v1',
        rewriteId: active.rewriteId,
        capabilityId: active.capabilityId,
      });
    }

    function beginApply(token, bindingCurrent) {
      if (!owns(token) || active.state !== STATES.REVIEWING || !bindingCurrent) return null;
      active.state = STATES.APPLYING;
      return Object.freeze({
        schema: 'writcraft.inline-rewrite-apply/v1',
        rewriteId: active.rewriteId,
        capabilityId: active.capabilityId,
      });
    }

    function settleApply(token, value) {
      if (!owns(token) || active.state !== STATES.APPLYING) return null;
      const route = classifyApplyResponse(value, active.intent.currentPath);
      active.state = route.kind === 'trusted_success'
        ? (route.result.status === 'applied' ? STATES.APPLIED : STATES.COMMITTED_WARNING)
        : route.kind === 'manual_recovery'
          ? STATES.MANUAL_RECOVERY
          : route.kind === 'known_zero_write_error'
            ? (route.result.error.code === 'INLINE_REWRITE_STALE' ? STATES.STALE : STATES.FAILED)
            : STATES.APPLY_OUTCOME_UNKNOWN;
      return route;
    }

    function invalidate(next = STATES.CANCELED) {
      if (!active || destroyed || active.state === STATES.APPLYING) return null;
      const previous = snapshot(active);
      if (TRANSITIONS[active.state]?.includes(next)) active.state = next;
      sequence += 1;
      active = null;
      return previous;
    }

    function destroy() {
      const previous = snapshot(active);
      destroyed = true;
      sequence += 1;
      active = null;
      return Object.freeze({ previous, discardAllowed: previous ? previous.state !== STATES.APPLYING : false });
    }

    return Object.freeze({
      begin,
      transition,
      associateReview,
      ackPayload,
      acknowledge,
      discardPayload,
      beginApply,
      settleApply,
      invalidate,
      destroy,
      owns,
      getActive: () => snapshot(active),
      isDestroyed: () => destroyed,
    });
  }

  return Object.freeze({
    STATES,
    STYLES,
    captureIntent,
    initialBindingMatches,
    preparedBindingMatches,
    prepareIntent,
    createRequest,
    normalizeReviewResult,
    validAckResult,
    classifyApplyResponse,
    normalizeReconciliation,
    reconciliationAction,
    markerLifecycle,
    reconciliationClearPayload,
    canRestoreOrRefocus,
    canPlaceCommittedCaret,
    discardPayloadForReview,
    createOwner,
  });
});
