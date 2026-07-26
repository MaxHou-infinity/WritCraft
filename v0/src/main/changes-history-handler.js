'use strict';

const QUERY_SCHEMA = 'writcraft.changes-history-recovery-query/v1';
const RESOLVE_SCHEMA = 'writcraft.changes-history-recovery-resolve/v1';
const CLEAR_SCHEMA = 'writcraft.changes-history-recovery-clear/v1';
const ERROR_SCHEMA = 'writcraft.changes-history-error/v1';
const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/;

class ChangesHistoryHandlerError extends Error {
  constructor(code, message, recoverable = true) {
    super(message);
    this.name = 'ChangesHistoryHandlerError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

function fail(code, message, recoverable = true) {
  throw new ChangesHistoryHandlerError(code, message, recoverable);
}

function strictDataObject(value, keys, code = 'INVALID_RECOVERY_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, '恢复请求结构无效');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      actual.some(key => !Object.hasOwn(descriptors[key], 'value') || descriptors[key].enumerable !== true)) {
    fail(code, '恢复请求字段无效');
  }
  return Object.fromEntries(actual.map(key => [key, descriptors[key].value]));
}

function boundedCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : fallback;
}

function publicFailure(error, fallback = 'CHANGES_OPERATION_FAILED') {
  const code = boundedCode(error, fallback);
  const safe = error instanceof ChangesHistoryHandlerError ||
    /^CHANGES_(?:RECOVERY|MANUAL|OPERATION)/.test(code) ||
    ['PROJECT_WATCHER_UNAVAILABLE', 'INLINE_REWRITE_RECOVERY_PENDING',
      'CHANGESET_NOT_FOUND', 'STALE_AI_PROJECT',
      'ISSUE_REVIEW_INCOMPLETE'].includes(code);
  return {
    ok: false,
    schema: ERROR_SCHEMA,
    error: {
      code: safe ? code : fallback,
      message: safe && typeof error?.message === 'string' &&
          Buffer.byteLength(error.message, 'utf8') <= 1024
        ? error.message
        : 'Changes 操作未完成；请核对恢复状态后重试',
      recoverable: error?.recoverable !== false,
    },
  };
}

function publicRecovery(marker) {
  if (!marker) return null;
  return {
    operationId: marker.operationId,
    kind: marker.kind,
    state: marker.state,
    outcome: marker.outcome,
    affectedPaths: [...marker.affectedPaths],
    createdAt: marker.createdAt,
    updatedAt: marker.updatedAt,
    actions: [...marker.actions],
  };
}

function transactionFailure(result) {
  const code = boundedCode(result?.error, result?.status === 'manual_recovery'
    ? 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    : 'CHANGES_OPERATION_FAILED');
  return {
    ok: false,
    schema: ERROR_SCHEMA,
    operationId: result?.operationId || null,
    outcome: result?.outcome || null,
    affectedPaths: Array.isArray(result?.affectedPaths) ? [...result.affectedPaths] : [],
    recoveryRequired: result?.recoveryRequired === true,
    consumed: result?.consumed === true,
    retryable: result?.retryable === true,
    error: {
      code,
      message: result?.recoveryRequired
        ? 'Changes 提交状态需要恢复核对'
        : 'Changes 修改未提交；原审阅已安全终结',
      recoverable: result?.recoveryRequired === true,
    },
  };
}

function stripPrivateResult(result) {
  const {
    residualChangeSet: _residualChangeSet,
    error: _error,
    ...safe
  } = result || {};
  return safe;
}

function createChangesHistoryHandler(options = {}) {
  const transaction = options.transaction;
  const pendingChangeSets = options.pendingChangeSets;
  const getCurrentProject = options.getCurrentProject;
  const assertMutationAvailable = options.assertMutationAvailable;
  const assertRecoveryAvailable = options.assertRecoveryAvailable;
  const validateDependencies = options.validateDependencies || (() => {});
  const finalizeApply = options.finalizeApply;
  const finalizeUndo = options.finalizeUndo;
  const abortHiddenAuthority = options.abortHiddenAuthority || (() => {});
  const onRecoveryResolved = options.onRecoveryResolved || (() => {});
  if (!transaction?.reconciliation || typeof transaction.review !== 'function' ||
      typeof transaction.undo !== 'function' || !pendingChangeSets ||
      typeof getCurrentProject !== 'function' ||
      typeof assertMutationAvailable !== 'function' ||
      typeof assertRecoveryAvailable !== 'function') {
    throw new TypeError('Changes/History handler dependencies are incomplete');
  }

  function current(projectInstanceId) {
    const project = getCurrentProject();
    if (!project || typeof project.rootPath !== 'string' ||
        typeof project.projectId !== 'string' || typeof project.instanceId !== 'string') {
      fail('NO_PROJECT', '请先打开写作项目');
    }
    if (projectInstanceId !== project.instanceId) {
      fail('STALE_AI_PROJECT', '项目已切换；旧请求已取消');
    }
    return project;
  }

  function recoveryRequest(projectInstanceId, request, schema, fields) {
    const project = current(projectInstanceId);
    assertRecoveryAvailable(project);
    const input = strictDataObject(request, ['schema', ...fields]);
    if (input.schema !== schema) fail('INVALID_RECOVERY_REQUEST', '恢复请求版本无效');
    return { project, input };
  }

  function applyChanges(projectInstanceId, decision) {
    let project;
    let pending;
    let changeSetId = null;
    let residualCapability = null;
    let begun = false;
    try {
      project = current(projectInstanceId);
      assertMutationAvailable(project);
      const descriptor = Object.getOwnPropertyDescriptor(decision || {}, 'changeSetId');
      changeSetId = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
      pending = pendingChangeSets.get(changeSetId);
      if (!pending || pending.rootPath !== project.rootPath) {
        fail('CHANGESET_NOT_FOUND', '待审阅修改不属于当前项目，请重新生成');
      }
      if (pending.researchDependencies) {
        fail('CHANGES_OPERATION_FAILED', 'Research 修改必须由 Research 事务入口提交');
      }
      validateDependencies({ project, pending, changeSetId, decision });
      residualCapability = pendingChangeSets.allocateCapability();
      const result = transaction.review({
        rootPath: project.rootPath,
        projectId: project.projectId,
        changeSet: pending.changeSet,
        decision,
        options: {
          reviewId: changeSetId,
          residualReviewId: residualCapability,
          selectionPolicy: pending.selectionPolicy,
          fileSelectionPolicies: pending.fileSelectionPolicies,
          requireCompleteDecision: pending.requireCompleteDecision,
          provenance: pending.provenance,
        },
        onBegin() {
          begun = true;
          if (!pendingChangeSets.delete(changeSetId, 'changes-history-begin')) {
            fail('CHANGESET_NOT_FOUND', '待审阅修改已被终结');
          }
        },
      });
      if (!result.ok) {
        if (begun) abortHiddenAuthority({ project, pending, changeSetId, result });
        return transactionFailure(result);
      }
      if (result.responseRecovered || result.status === 'committed_warning' ||
          result.recoveryRequired) {
        abortHiddenAuthority({ project, pending, changeSetId, result });
        return {
          ...stripPrivateResult(result),
          ok: true,
          refreshRequired: true,
          residualUnavailable: true,
          confirmationUnavailable: true,
        };
      }
      try {
        if (typeof finalizeApply !== 'function') {
          if (result.residualChangeSet) {
            fail('CHANGES_POSTCOMMIT_FAILED', '剩余审阅无法安全发布');
          }
          return stripPrivateResult(result);
        }
        return finalizeApply({
          project,
          pending,
          changeSetId,
          residualCapability,
          result,
        });
      } catch (error) {
        try { pendingChangeSets.delete(residualCapability, 'changes-postcommit-rollback'); } catch (_) {}
        abortHiddenAuthority({ project, pending, changeSetId, result, error });
        return {
          ...stripPrivateResult(result),
          ok: true,
          status: 'committed_warning',
          warning: true,
          refreshRequired: true,
          residualUnavailable: true,
          confirmationUnavailable: true,
          postcommitError: boundedCode(error, 'CHANGES_POSTCOMMIT_FAILED'),
        };
      }
    } catch (error) {
      if (begun) {
        try { abortHiddenAuthority({ project, pending, changeSetId, error }); } catch (_) {}
      }
      return publicFailure(error);
    }
  }

  function undoChange(projectInstanceId, historyEntryId) {
    try {
      const project = current(projectInstanceId);
      assertMutationAvailable(project);
      const result = transaction.undo({
        rootPath: project.rootPath,
        projectId: project.projectId,
        entryId: historyEntryId,
      });
      if (!result.ok) return transactionFailure(result);
      if (result.responseRecovered || result.recoveryRequired ||
          result.status === 'committed_warning') {
        return {
          ...stripPrivateResult(result),
          ok: true,
          refreshRequired: true,
        };
      }
      if (typeof finalizeUndo !== 'function') return stripPrivateResult(result);
      try {
        return finalizeUndo({ project, result });
      } catch (error) {
        return {
          ...stripPrivateResult(result),
          ok: true,
          status: 'committed_warning',
          warning: true,
          refreshRequired: true,
          postcommitError: boundedCode(error, 'CHANGES_POSTCOMMIT_FAILED'),
        };
      }
    } catch (error) {
      return publicFailure(error);
    }
  }

  function queryRecovery(projectInstanceId, request) {
    try {
      const { project } = recoveryRequest(projectInstanceId, request, QUERY_SCHEMA, []);
      const result = transaction.reconciliation.query(project.rootPath, project.projectId);
      return { ok: true, schema: QUERY_SCHEMA, recovery: publicRecovery(result.recovery) };
    } catch (error) {
      return publicFailure(error, 'CHANGES_RECOVERY_QUERY_FAILED');
    }
  }

  function resolveRecovery(projectInstanceId, request) {
    try {
      const { project, input } = recoveryRequest(
        projectInstanceId,
        request,
        RESOLVE_SCHEMA,
        ['operationId', 'action']
      );
      if (!OPERATION_ID_RE.test(input.operationId || '') ||
          !['restore_before', 'keep_after'].includes(input.action)) {
        fail('INVALID_RECOVERY_REQUEST', '恢复操作身份或动作无效');
      }
      const result = transaction.reconciliation.resolve(
        project.rootPath,
        project.projectId,
        input.operationId,
        input.action
      );
      onRecoveryResolved({ project, recovery: result.recovery, action: input.action });
      return { ok: true, schema: RESOLVE_SCHEMA, recovery: publicRecovery(result.recovery) };
    } catch (error) {
      return publicFailure(error, 'CHANGES_RECOVERY_RESOLVE_FAILED');
    }
  }

  function clearRecovery(projectInstanceId, request) {
    try {
      const { project, input } = recoveryRequest(
        projectInstanceId,
        request,
        CLEAR_SCHEMA,
        ['operationId']
      );
      if (!OPERATION_ID_RE.test(input.operationId || '')) {
        fail('INVALID_RECOVERY_REQUEST', '恢复操作身份无效');
      }
      const result = transaction.reconciliation.clear(
        project.rootPath,
        project.projectId,
        input.operationId
      );
      return { ok: true, schema: CLEAR_SCHEMA, operationId: result.operationId };
    } catch (error) {
      return publicFailure(error, 'CHANGES_RECOVERY_CLEAR_FAILED');
    }
  }

  return Object.freeze({
    applyChanges,
    undoChange,
    queryRecovery,
    resolveRecovery,
    clearRecovery,
  });
}

module.exports = {
  QUERY_SCHEMA,
  RESOLVE_SCHEMA,
  CLEAR_SCHEMA,
  ERROR_SCHEMA,
  ChangesHistoryHandlerError,
  createChangesHistoryHandler,
};
