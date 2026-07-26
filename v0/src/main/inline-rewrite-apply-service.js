'use strict';

const crypto = require('crypto');
const defaultHistoryService = require('./change-history-service');
const defaultInlineRewriteService = require('./inline-rewrite-service');

const APPLY_RESULT_SCHEMA = 'writcraft.inline-rewrite-apply-result/v1';
const ERROR_SCHEMA = 'writcraft.inline-rewrite-error/v1';
const REVISION_RE = /^[a-f0-9]{64}$/;
const REWRITE_ID_RE = /^ir_[a-f0-9]{32}$/;
const APPLY_LEASE_ID_RE = /^iral_[a-f0-9]{32}$/;
const HISTORY_ID_RE = /^change_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ZERO_WRITE_STATUSES = new Set([
  'conflict', 'preflight_failed', 'rolled_back', 'history_failed_rolled_back', 'threw_preflight',
]);
const UNCERTAIN_WRITE_STATUSES = new Set(['rollback_failed', 'history_failed_rollback_failed']);

const TERMINAL_STATES = Object.freeze({
  APPLIED: 'APPLIED',
  COMMITTED_WARNING: 'COMMITTED_WARNING',
  FAILED_ROLLED_BACK: 'FAILED_ROLLED_BACK',
  STALE: 'STALE',
  MANUAL_RECOVERY: 'MANUAL_RECOVERY',
});

function exactError(code, message, recoverable = true) {
  return Object.freeze({
    ok: false,
    schema: ERROR_SCHEMA,
    error: Object.freeze({ code, message, recoverable }),
  });
}

function exactSuccess({
  status,
  path,
  revision,
  historyEntryId,
  refreshRequired,
  historyUnavailable,
  manualRecoveryRequired,
  message,
}) {
  return Object.freeze({
    ok: true,
    schema: APPLY_RESULT_SCHEMA,
    status,
    path,
    revision,
    historyEntryId,
    refreshRequired,
    historyUnavailable,
    manualRecoveryRequired,
    message,
  });
}

function publicError(code) {
  if (code === 'INLINE_REWRITE_STALE') {
    return exactError(code, 'Inline Rewrite 权威依赖已变化');
  }
  if (code === 'INVALID_INLINE_REWRITE') {
    return exactError(code, 'Inline Rewrite apply 数据无效');
  }
  return exactError('INLINE_REWRITE_WRITE_FAILED', 'Inline Rewrite 未能安全写入');
}

function manualRecoveryError() {
  return exactError(
    'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED',
    'Inline Rewrite 提交状态需要人工恢复；不要重试',
    false
  );
}

function terminal(result, terminalState) {
  return Object.freeze({ result, terminalState });
}

function validateInvocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('invalid invocation'), { code: 'INVALID_INLINE_REWRITE' });
  }
  const { lease, projectService, reconciliationService } = input;
  if (!lease || typeof lease !== 'object' || !REWRITE_ID_RE.test(lease.rewriteId || '') ||
      !APPLY_LEASE_ID_RE.test(lease.applyLeaseId || '') ||
      !lease.proposal || typeof lease.proposal !== 'object' || lease.proposal.rewriteId !== lease.rewriteId ||
      !lease.proposal.dependencies || !lease.proposal.changeSet || !lease.proposal.provenance ||
      typeof input.rootPath !== 'string' || !input.rootPath ||
      typeof input.projectId !== 'string' || !input.projectId ||
      typeof input.projectInstanceId !== 'string' || !input.projectInstanceId ||
      !Number.isSafeInteger(input.mutationGeneration) || input.mutationGeneration < 0 ||
      !projectService || typeof projectService.readFileWithRevision !== 'function' ||
      !reconciliationService || typeof reconciliationService.finish !== 'function') {
    throw Object.assign(new Error('invalid invocation'), { code: 'INVALID_INLINE_REWRITE' });
  }
  const proposal = lease.proposal;
  const changes = proposal.changeSet.changes;
  if (!Array.isArray(changes) || changes.length !== 1) {
    throw Object.assign(new Error('invalid invocation'), { code: 'INVALID_INLINE_REWRITE' });
  }
  const change = changes[0];
  if (!change || typeof change.path !== 'string' || typeof change.before !== 'string' ||
      typeof change.after !== 'string' || !REVISION_RE.test(change.expectedRevision || '')) {
    throw Object.assign(new Error('invalid invocation'), { code: 'INVALID_INLINE_REWRITE' });
  }
  return { change, proposal };
}

function readAuthority(projectService, rootPath, change) {
  try {
    const snapshot = projectService.readFileWithRevision(rootPath, change.path);
    if (!snapshot || typeof snapshot.content !== 'string' || !REVISION_RE.test(snapshot.revision || '')) return null;
    return snapshot;
  } catch (_) {
    return null;
  }
}

function isBefore(snapshot, change) {
  return Boolean(snapshot && snapshot.content === change.before && snapshot.revision === change.expectedRevision);
}

function isAfter(snapshot, change) {
  const expectedAfterRevision = crypto.createHash('sha256').update(change.after, 'utf8').digest('hex');
  return Boolean(snapshot && snapshot.content === change.after && snapshot.revision === expectedAfterRevision);
}

function validHistoryEntry(entry, rewriteId) {
  return Boolean(entry && typeof entry === 'object' && HISTORY_ID_RE.test(entry.id || '') &&
    entry.provenance?.schema === 'writcraft.inline-rewrite/v1' &&
    entry.provenance?.kind === 'inline_rewrite' && entry.provenance?.rewriteId === rewriteId);
}

function createInlineRewriteApplyService(options = {}) {
  const historyService = options.historyService || defaultHistoryService;
  const dependencyValidator = options.validateDependencies || defaultInlineRewriteService.validateInlineRewriteDependencies;
  const defaultRefreshCommitted = options.refreshCommitted || null;
  const findHistory = options.findHistory || (({ rootPath, rewriteId }) =>
    historyService.listHistory(rootPath).find(entry => entry.provenance?.kind === 'inline_rewrite' &&
      entry.provenance?.rewriteId === rewriteId) || null);
  if (!historyService || typeof historyService.applyAndRecord !== 'function' ||
      typeof dependencyValidator !== 'function' ||
      typeof findHistory !== 'function' ||
      (defaultRefreshCommitted !== null && typeof defaultRefreshCommitted !== 'function')) {
    throw new TypeError('Inline Rewrite apply service dependencies are invalid');
  }

  function apply(input) {
    let validated;
    try {
      validated = validateInvocation(input);
    } catch (_) {
      // The coordinator is entered only after beginApply wrote an applying
      // marker and burned the capability. An internal shape mismatch can no
      // longer be represented as a trusted/recoverable zero-write result.
      try {
        if (input?.reconciliationService && typeof input.reconciliationService.finish === 'function' &&
            typeof input.rootPath === 'string' && typeof input.projectId === 'string' &&
            REWRITE_ID_RE.test(input.lease?.rewriteId || '')) {
          input.reconciliationService.finish({
            rootPath: input.rootPath,
            projectId: input.projectId,
            rewriteId: input.lease.rewriteId,
            outcome: 'manual_recovery',
            revision: null,
            historyEntryId: null,
            errorCode: 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED',
          });
        }
      } catch (_) {}
      return terminal(manualRecoveryError(), TERMINAL_STATES.MANUAL_RECOVERY);
    }

    const {
      lease, projectService, rootPath, projectId, projectInstanceId,
      mutationGeneration, reconciliationService,
    } = input;
    const { change, proposal } = validated;
    const refreshCommitted = input.refreshCommitted === undefined
      ? defaultRefreshCommitted
      : input.refreshCommitted;

    const finishMarker = marker => {
      try {
        const finished = reconciliationService.finish({
          rootPath,
          projectId,
          rewriteId: lease.rewriteId,
          ...marker,
        });
        return Boolean(finished);
      } catch (_) {
        return false;
      }
    };

    const markerFailure = () => terminal(manualRecoveryError(), TERMINAL_STATES.MANUAL_RECOVERY);

    const queryHistory = () => {
      try {
        const entry = findHistory({ rootPath, rewriteId: lease.rewriteId });
        if (entry === null || entry === undefined) return { ok: true, entry: null };
        return validHistoryEntry(entry, lease.rewriteId)
          ? { ok: true, entry }
          : { ok: false, entry: null };
      } catch (_) {
        return { ok: false, entry: null };
      }
    };

    const zeroWrite = (code = 'INLINE_REWRITE_WRITE_FAILED', state = TERMINAL_STATES.FAILED_ROLLED_BACK,
      knownSnapshot = null, knownHistory = null) => {
      const snapshot = knownSnapshot || readAuthority(projectService, rootPath, change);
      const history = knownHistory || queryHistory();
      if (!isBefore(snapshot, change) || !history.ok || history.entry !== null) return manualRecovery(snapshot);
      if (!finishMarker({
        outcome: 'zero_write_error',
        revision: snapshot.revision,
        historyEntryId: null,
        errorCode: code,
      })) return markerFailure();
      return terminal(publicError(code), state);
    };

    const manualRecovery = (snapshot, historyEntry = null) => {
      if (!finishMarker({
        outcome: 'manual_recovery',
        revision: snapshot?.revision || null,
        historyEntryId: validHistoryEntry(historyEntry, lease.rewriteId) ? historyEntry.id : null,
        errorCode: 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED',
      })) return markerFailure();
      return terminal(manualRecoveryError(), TERMINAL_STATES.MANUAL_RECOVERY);
    };

    const historyUnavailable = snapshot => {
      if (!finishMarker({
        outcome: 'committed_warning',
        revision: snapshot.revision,
        historyEntryId: null,
        errorCode: null,
      })) return markerFailure();
      return terminal(exactSuccess({
        status: 'committed_warning',
        path: change.path,
        revision: snapshot.revision,
        historyEntryId: null,
        refreshRequired: true,
        historyUnavailable: true,
        manualRecoveryRequired: true,
        message: '已应用但历史不可用，请人工恢复；不要重试',
      }), TERMINAL_STATES.COMMITTED_WARNING);
    };

    // beginApply has already persisted the applying marker and burned the
    // capability. Everything below is therefore terminal and non-replayable.
    try {
      dependencyValidator({
        projectService,
        rootPath,
        projectId,
        projectInstanceId,
        mutationGeneration,
        dependencies: proposal.dependencies,
      });
    } catch (error) {
      const code = error?.code === 'INLINE_REWRITE_STALE'
        ? 'INLINE_REWRITE_STALE'
        : 'INVALID_INLINE_REWRITE';
      return zeroWrite(code, code === 'INLINE_REWRITE_STALE'
        ? TERMINAL_STATES.STALE
        : TERMINAL_STATES.FAILED_ROLLED_BACK);
    }

    let applied;
    let failureStatus = null;
    try {
      applied = historyService.applyAndRecord(projectService, rootPath, proposal.changeSet, {
        provenance: proposal.provenance,
      });
    } catch (_) {
      failureStatus = 'threw_preflight';
    }

    if (failureStatus || !applied || applied.ok !== true) {
      failureStatus ||= applied?.status || 'unknown';
      const snapshot = readAuthority(projectService, rootPath, change);
      const history = queryHistory();
      if (!history.ok || history.entry !== null) return manualRecovery(snapshot, history.entry);
      if (ZERO_WRITE_STATUSES.has(failureStatus) && isBefore(snapshot, change)) {
        return zeroWrite('INLINE_REWRITE_WRITE_FAILED', TERMINAL_STATES.FAILED_ROLLED_BACK, snapshot, history);
      }
      if (UNCERTAIN_WRITE_STATUSES.has(failureStatus) && isBefore(snapshot, change)) {
        return zeroWrite('INLINE_REWRITE_WRITE_FAILED', TERMINAL_STATES.FAILED_ROLLED_BACK, snapshot, history);
      }
      if (UNCERTAIN_WRITE_STATUSES.has(failureStatus) && isAfter(snapshot, change)) {
        return historyUnavailable(snapshot);
      }
      return manualRecovery(snapshot);
    }

    const historyEntryId = applied.historyEntry?.id;
    const snapshot = readAuthority(projectService, rootPath, change);
    if (!isAfter(snapshot, change) || !validHistoryEntry(applied.historyEntry, lease.rewriteId) ||
        !HISTORY_ID_RE.test(historyEntryId || '')) {
      return manualRecovery(snapshot);
    }

    let refreshFailed = false;
    if (refreshCommitted !== null) {
      if (typeof refreshCommitted !== 'function') refreshFailed = true;
      else {
        try {
          refreshCommitted({
            path: change.path,
            revision: snapshot.revision,
            historyEntryId,
            rewriteId: lease.rewriteId,
          });
        } catch (_) {
          refreshFailed = true;
        }
      }
    }

    if (refreshFailed) {
      if (!finishMarker({
        outcome: 'committed_warning',
        revision: snapshot.revision,
        historyEntryId,
        errorCode: null,
      })) return markerFailure();
      return terminal(exactSuccess({
        status: 'committed_warning',
        path: change.path,
        revision: snapshot.revision,
        historyEntryId,
        refreshRequired: true,
        historyUnavailable: false,
        manualRecoveryRequired: false,
        message: '已应用，请重开项目；不要重试',
      }), TERMINAL_STATES.COMMITTED_WARNING);
    }

    if (!finishMarker({
      outcome: 'applied',
      revision: snapshot.revision,
      historyEntryId,
      errorCode: null,
    })) return markerFailure();
    return terminal(exactSuccess({
      status: 'applied',
      path: change.path,
      revision: snapshot.revision,
      historyEntryId,
      refreshRequired: false,
      historyUnavailable: false,
      manualRecoveryRequired: false,
      message: '已应用',
    }), TERMINAL_STATES.APPLIED);
  }

  return Object.freeze({ apply });
}

module.exports = {
  APPLY_RESULT_SCHEMA,
  ERROR_SCHEMA,
  TERMINAL_STATES,
  createInlineRewriteApplyService,
};
