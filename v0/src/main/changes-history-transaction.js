'use strict';

const defaultHistoryService = require('./change-history-service');
const defaultReviewService = require('./changeset-review-service');
const {
  createChangesHistoryReconciliationService,
} = require('./changes-history-reconciliation-service');

function createChangesHistoryTransaction(options = {}) {
  const projectService = options.projectService;
  const historyService = options.historyService || defaultHistoryService;
  const reviewService = options.reviewService || defaultReviewService;
  const reconciliationService = options.reconciliationService ||
    createChangesHistoryReconciliationService({ projectService, historyService });
  if (!projectService || typeof projectService.atomicWriteFile !== 'function') {
    throw new TypeError('Changes/History transaction requires ProjectService');
  }

  function prepareApply(args) {
    const historyPrepared = historyService.prepareApplication(
      args.rootPath,
      args.changeSet,
      args.options || {}
    );
    return {
      kind: 'apply',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared,
      executeOptions: args.options || {},
      execute() {
        return historyService.executePreparedApplication(
          projectService,
          args.rootPath,
          historyPrepared,
          args.options || {}
        );
      },
    };
  }

  function prepareReview(args) {
    const decisionOptions = {
      ...(args.options || {}),
      historyService,
    };
    const decisionPrepared = reviewService.prepareDecision(
      projectService,
      args.rootPath,
      args.changeSet,
      args.decision,
      decisionOptions
    );
    const writesManuscript = Boolean(decisionPrepared.resolution.acceptedChangeSet);
    return {
      // A decision containing accepted hunks is an application transaction:
      // files and History must both reach the prepared state before authority
      // can call it committed. Reject-only decisions remain History-only.
      kind: writesManuscript ? 'apply' : 'review',
      decisionOperation: true,
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared: decisionPrepared.historyPrepared,
      decisionPrepared,
      executeOptions: decisionOptions,
      execute() {
        return reviewService.executePreparedDecision(
          projectService,
          args.rootPath,
          decisionPrepared,
          decisionOptions
        );
      },
    };
  }

  function prepareUndo(args) {
    const historyPrepared = historyService.prepareUndo(
      projectService,
      args.rootPath,
      args.entryId
    );
    if (historyPrepared?.ok === false) return historyPrepared;
    return {
      kind: 'undo',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared,
      executeOptions: args.options || {},
      execute() {
        return historyService.executePreparedUndo(
          projectService,
          args.rootPath,
          historyPrepared,
          args.options || {}
        );
      },
    };
  }

  function resultFromAuthority(prepared, marker, executionResult, executionError) {
    const base = {
      operationId: marker.operationId,
      outcome: marker.outcome,
      affectedPaths: marker.files.map(file => file.path),
      recoveryRequired: ['committed_warning', 'manual_recovery'].includes(marker.outcome),
    };
    if (['applied', 'reviewed', 'undone'].includes(marker.outcome)) {
      if (executionResult?.ok === true) {
        return {
          ...executionResult,
          ...base,
          ok: true,
          status: executionResult.status || marker.outcome,
        };
      }
      return {
        ...base,
        ok: true,
        status: marker.outcome,
        responseRecovered: true,
        residualUnavailable: prepared.decisionOperation === true,
        confirmationUnavailable: true,
      };
    }
    if (marker.outcome === 'committed_warning') {
      return {
        ...base,
        ok: true,
        status: 'committed_warning',
        warning: true,
        residualUnavailable: prepared.decisionOperation === true,
        confirmationUnavailable: true,
      };
    }
    return {
      ...base,
      ok: false,
      status: marker.outcome,
      consumed: true,
      retryable: false,
      ...(executionError ? { error: executionError } : {}),
      ...(executionResult?.error && !executionError ? { error: executionResult.error } : {}),
    };
  }

  function execute(prepared, hooks = {}) {
    if (!prepared || prepared.ok === false) return prepared;
    const marker = reconciliationService.prepare(prepared.rootPath, {
      projectId: prepared.projectId,
      kind: prepared.kind,
      files: prepared.historyPrepared.files,
      baseHistoryState: prepared.historyPrepared.baseHistoryState,
      preparedHistoryState: prepared.historyPrepared.preparedHistoryState,
    });
    let executionResult = null;
    let executionError = null;
    try {
      // The caller isolates/deletes its one-time capability here. A failure is
      // classified from untouched disk/History and still leaves a terminal
      // marker, so a missing response can never replay the original token.
      if (typeof hooks.onBegin === 'function') hooks.onBegin({
        operationId: marker.operationId,
        projectId: marker.projectId,
        kind: marker.kind,
      });
      executionResult = prepared.execute();
    } catch (error) {
      executionError = error;
    }
    const classified = reconciliationService.finish(prepared.rootPath, marker.operationId);
    return resultFromAuthority(prepared, classified, executionResult, executionError);
  }

  function apply(args) {
    return execute(prepareApply(args), { onBegin: args.onBegin });
  }

  function review(args) {
    return execute(prepareReview(args), { onBegin: args.onBegin });
  }

  function undo(args) {
    const prepared = prepareUndo(args);
    return prepared?.ok === false
      ? prepared
      : execute(prepared, { onBegin: args.onBegin });
  }

  return Object.freeze({
    prepareApply,
    prepareReview,
    prepareUndo,
    execute,
    apply,
    review,
    undo,
    reconciliation: reconciliationService,
  });
}

module.exports = {
  createChangesHistoryTransaction,
};
