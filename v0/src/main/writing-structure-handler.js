'use strict';

const CAPABILITY_ID_RE = /^wsc_[a-f0-9]{32}$/;
const NAVIGATION_ID_RE = /^nav_[a-f0-9]{32}$/;
const ALTERNATIVE_ID_RE = /^alternative_[1-3]$/;
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class WritingStructureHandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingStructureHandlerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingStructureHandlerError(code, message);
}

function ownerId(event) {
  if (!event?.sender || !Number.isSafeInteger(event.sender.id)) {
    fail('INVALID_OWNER', '结构规划窗口身份无效');
  }
  return `webcontents:${event.sender.id}`;
}

function boundedId(value, pattern, code, message) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code, message);
  return value;
}

function sameProject(left, right) {
  return Boolean(left && right &&
    left.instanceId === right.instanceId &&
    left.rootPath === right.rootPath);
}

function publicFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map(file => Object.freeze({
    path: file.path,
    ...(typeof file.revision === 'string' ? { revision: file.revision } : {}),
  }));
}

function publicErrorCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : fallback;
}

function createWritingStructureHandlers(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    settleProjectAuthority,
    deriveAuthority,
    writingStructureService,
    capabilityStore,
    transaction,
    assertMutationAvailable,
    assertCommitAvailable,
    assertRecoveryAvailable,
    beginMutation,
    endMutation,
    rememberCommittedFile,
    advanceGeneration,
    listTree,
    staleProjectResult,
    projectFailure,
  } = options;
  const requiredFunctions = {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    settleProjectAuthority,
    deriveAuthority,
    assertMutationAvailable,
    assertCommitAvailable,
    assertRecoveryAvailable,
    beginMutation,
    endMutation,
    rememberCommittedFile,
    advanceGeneration,
    listTree,
    staleProjectResult,
    projectFailure,
  };
  for (const [name, value] of Object.entries(requiredFunctions)) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!writingStructureService || typeof writingStructureService.prepareWritingStructure !== 'function' ||
      !capabilityStore || typeof capabilityStore.issue !== 'function' ||
      typeof capabilityStore.consume !== 'function' ||
      !transaction || typeof transaction.commit !== 'function' ||
      typeof transaction.query !== 'function' ||
      typeof transaction.acknowledge !== 'function') {
    throw new TypeError('Writing structure dependencies are incomplete');
  }

  const recoveryLeases = new Map();
  const committedOperations = new Map();

  function binding(event, project, authority, extra = {}) {
    return {
      ownerId: ownerId(event),
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: getMutationGeneration(),
      navigationEpoch: getRendererNavigationEpoch(),
      editRevision: authority.editRevision,
      emptyTreeDigest: authority.emptyTreeDigest,
      ...extra,
    };
  }

  function assertCurrent(prepared, project, mutationLease) {
    const current = getCurrentProject();
    if (!sameProject(current, project) ||
        getMutationGeneration() !== prepared.mutationGeneration ||
        getRendererNavigationEpoch() !== prepared.navigationEpoch) {
      fail('STALE_STRUCTURE_CAPABILITY', '项目状态已变化，请重新预览章节骨架');
    }
    assertCommitAvailable(project, mutationLease);
    const authority = deriveAuthority(project);
    if (authority.editRevision !== prepared.editRevision ||
        authority.emptyTreeDigest !== prepared.emptyTreeDigest ||
        authority.chaptersAbsent !== true ||
        authority.emptyBody !== true) {
      fail('STALE_STRUCTURE_CAPABILITY', '项目内容已变化，请重新预览章节骨架');
    }
    return true;
  }

  function releaseRecoveryLease(rootPath) {
    const record = recoveryLeases.get(rootPath);
    if (!record) return;
    recoveryLeases.delete(rootPath);
    endMutation(record.mutationLease, record.project);
  }

  function retainRecoveryLease(project, mutationLease, operationId, committed = false) {
    const current = recoveryLeases.get(project.rootPath);
    if (current && current.mutationLease !== mutationLease) {
      fail('WRITING_STRUCTURE_RECOVERY_PENDING', '章节骨架提交状态待恢复；不要重复确认');
    }
    recoveryLeases.set(project.rootPath, Object.freeze({
      project,
      mutationLease,
      operationId,
      committed,
    }));
  }

  function committedProgress(operationId, files) {
    let progress = committedOperations.get(operationId);
    if (!progress) {
      progress = {
        rememberedFiles: new Set(),
        generationDone: false,
        generationUnsafe: false,
        treeDone: false,
        tree: null,
        files: publicFiles(files),
      };
      committedOperations.set(operationId, progress);
      while (committedOperations.size > 64) {
        committedOperations.delete(committedOperations.keys().next().value);
      }
    }
    return progress;
  }

  function fileProgressKey(file) {
    return `${String(file?.path || '')}\0${String(file?.revision || '')}`;
  }

  function finalizeCommitted(project, result) {
    const operationId = boundedId(
      result.operationId,
      OPERATION_ID_RE,
      'INVALID_STRUCTURE_TRANSACTION',
      '章节骨架事务标识无效'
    );
    const files = publicFiles(result.files);
    const progress = committedProgress(operationId, files);
    const warningCodes = new Set();
    for (const file of files) {
      const key = fileProgressKey(file);
      if (progress.rememberedFiles.has(key)) continue;
      try {
        rememberCommittedFile(file);
        progress.rememberedFiles.add(key);
      } catch (_) {
        warningCodes.add('WATCHER_STATE_REFRESH_FAILED');
      }
    }
    const remembered = files.every(file =>
      progress.rememberedFiles.has(fileProgressKey(file))
    );
    if (remembered && !progress.generationDone && !progress.generationUnsafe) {
      const before = getMutationGeneration();
      try {
        advanceGeneration();
        const after = getMutationGeneration();
        if (after === before + 1) progress.generationDone = true;
        else {
          progress.generationUnsafe = true;
          warningCodes.add('GENERATION_REFRESH_FAILED');
        }
      } catch (_) {
        const after = getMutationGeneration();
        if (after === before + 1) {
          // The generation changed, so retrying the callback could increment it
          // twice. Preserve the recovery marker for manual resolution.
          progress.generationDone = true;
          progress.generationUnsafe = true;
        }
        warningCodes.add('GENERATION_REFRESH_FAILED');
      }
    }
    if (remembered && progress.generationDone && !progress.generationUnsafe &&
        !progress.treeDone) {
      try {
        progress.tree = listTree(project);
        progress.treeDone = true;
      } catch (_) {
        warningCodes.add('TREE_REFRESH_FAILED');
      }
    }
    const ready = remembered && progress.generationDone &&
      !progress.generationUnsafe && progress.treeDone;
    const publicResult = {
      ok: true,
      state: 'COMMITTED',
      operationId,
      files: progress.files,
      ...(progress.treeDone ? { tree: progress.tree } : {}),
      ...(!ready || warningCodes.size ? {
        refreshRequired: true,
        recoveryRequired: true,
        warning: 'WRITING_STRUCTURE_POSTCOMMIT_RECOVERY_REQUIRED',
        warningCodes: warningCodes.size
          ? [...warningCodes]
          : ['POSTCOMMIT_AUTHORITY_INCOMPLETE'],
      } : {}),
    };
    return Object.freeze({ ready, publicResult });
  }

  function publicTransactionResult(project, result, mutationLease) {
    if (!result || !['UNCOMMITTED', 'COMMITTED', 'UNKNOWN'].includes(result.state)) {
      retainRecoveryLease(project, mutationLease, result?.operationId || 'unknown');
      return {
        ok: false,
        state: 'UNKNOWN',
        error: 'WRITING_STRUCTURE_COMMIT_UNKNOWN',
        message: '章节骨架的提交状态尚未核对。请不要重复确认，先使用恢复核对。',
        retryable: false,
        recoveryRequired: true,
      };
    }
    if (result.state === 'COMMITTED') {
      const finalized = finalizeCommitted(project, result);
      if (!finalized.ready) {
        retainRecoveryLease(project, mutationLease, result.operationId, true);
        return finalized.publicResult;
      }
      let acknowledged = false;
      try {
        acknowledged = transaction.acknowledge({
          rootPath: project.rootPath,
          projectId: project.projectId,
          operationId: result.operationId,
        })?.acknowledged === true;
      } catch (_) {}
      if (acknowledged) {
        endMutation(mutationLease, project);
        committedOperations.delete(result.operationId);
        return finalized.publicResult;
      }
      retainRecoveryLease(project, mutationLease, result.operationId, true);
      return {
        ...finalized.publicResult,
        refreshRequired: true,
        recoveryRequired: true,
        warning: 'WRITING_STRUCTURE_RECOVERY_ACK_REQUIRED',
        warningCodes: [
          ...new Set([...(finalized.publicResult.warningCodes || []), 'RECOVERY_ACK_FAILED']),
        ],
      };
    }
    if (result.state === 'UNKNOWN') {
      retainRecoveryLease(project, mutationLease, result.operationId);
      return {
        ok: false,
        state: 'UNKNOWN',
        operationId: result.operationId,
        error: 'WRITING_STRUCTURE_COMMIT_UNKNOWN',
        message: '章节骨架的提交状态尚未核对。请不要重复确认，先使用恢复核对。',
        retryable: false,
        recoveryRequired: true,
      };
    }
    endMutation(mutationLease, project);
    return {
      ok: false,
      state: 'UNCOMMITTED',
      operationId: result.operationId,
      error: publicErrorCode(result.error, 'WRITING_STRUCTURE_NOT_COMMITTED'),
      message: '没有创建任何章节骨架。本次确认已终结；如需继续，请重新预览后确认。',
      retryable: false,
      recoveryRequired: false,
    };
  }

  async function prepare(event, projectInstanceId, navigationId, alternativeId, chapters) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleProjectResult();
      const selectedNavigationId = boundedId(
        navigationId,
        NAVIGATION_ID_RE,
        'INVALID_NAVIGATION_ID',
        '写作导航标识无效'
      );
      const selectedAlternativeId = boundedId(
        alternativeId,
        ALTERNATIVE_ID_RE,
        'INVALID_ALTERNATIVE',
        '结构方案标识无效'
      );
      await settleProjectAuthority(project);
      if (!sameProject(getCurrentProject(), project)) return staleProjectResult();
      const authority = deriveAuthority(project);
      if (authority.emptyBody !== true || authority.chaptersAbsent !== true) {
        fail('STRUCTURE_REQUIRES_EMPTY_PROJECT', '结构规划只用于尚无正文且尚未创建 chapters 的项目');
      }
      const preparedResult = writingStructureService.prepareWritingStructure({
        navigationStore: options.writingNavigationStore,
        ...binding(event, project, authority),
        navigationId: selectedNavigationId,
        alternativeId: selectedAlternativeId,
        chapters,
      });
      const issued = capabilityStore.issue(preparedResult.prepared);
      return {
        ok: true,
        capabilityId: issued.capabilityId,
        expiresAt: issued.expiresAt,
        preview: issued.preview,
      };
    } catch (error) {
      return projectFailure(error);
    }
  }

  async function confirm(event, capabilityId) {
    let project = null;
    let mutationLease = null;
    let commitStarted = false;
    try {
      assertTrustedSender(event);
      boundedId(
        capabilityId,
        CAPABILITY_ID_RE,
        'INVALID_STRUCTURE_CAPABILITY',
        '结构确认能力标识无效'
      );
      project = requireCurrentProject();
      await settleProjectAuthority(project);
      if (!sameProject(getCurrentProject(), project)) return staleProjectResult();
      assertMutationAvailable(project);
      const authority = deriveAuthority(project);
      const prepared = capabilityStore.consume({
        ...binding(event, project, authority),
        capabilityId,
      });
      mutationLease = beginMutation(project);
      commitStarted = true;
      let result;
      try {
        result = await transaction.commit({
          rootPath: project.rootPath,
          projectId: project.projectId,
          prepared,
          beforePublish: () => assertCurrent(prepared, project, mutationLease),
        });
      } catch (_) {
        try {
          result = transaction.query({
            rootPath: project.rootPath,
            projectId: project.projectId,
          });
        } catch (_) {
          result = { ok: false, state: 'UNKNOWN', operationId: null };
        }
      }
      return publicTransactionResult(project, result, mutationLease);
    } catch (error) {
      if (mutationLease && !recoveryLeases.has(project.rootPath)) {
        if (commitStarted) {
          retainRecoveryLease(project, mutationLease, null);
          return {
            ok: false,
            state: 'UNKNOWN',
            error: 'WRITING_STRUCTURE_COMMIT_UNKNOWN',
            message: '章节骨架的提交状态尚未核对。请不要重复确认，先使用恢复核对。',
            retryable: false,
            recoveryRequired: true,
          };
        }
        endMutation(mutationLease, project);
      }
      return projectFailure(error);
    }
  }

  async function queryRecovery(event, projectInstanceId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleProjectResult();
      const recoveryLease = recoveryLeases.get(project.rootPath);
      assertRecoveryAvailable(project, recoveryLease?.mutationLease || null);
      const result = transaction.query({
        rootPath: project.rootPath,
        projectId: project.projectId,
      });
      if (!result || !['UNCOMMITTED', 'COMMITTED', 'UNKNOWN'].includes(result.state)) {
        fail('INVALID_STRUCTURE_TRANSACTION', '章节骨架恢复结果无效');
      }
      if (result.state === 'COMMITTED') {
        return finalizeCommitted(project, result).publicResult;
      }
      if (result.state === 'UNCOMMITTED' && recoveryLease?.committed === true &&
          committedOperations.get(recoveryLease.operationId)?.treeDone === true) {
        return {
          ok: true,
          state: 'COMMITTED',
          operationId: recoveryLease.operationId,
          files: [],
          recoveryRequired: true,
        };
      }
      return {
        ok: true,
        state: result.state,
        operationId: result.operationId || null,
        recoveryRequired: result.state === 'UNKNOWN',
      };
    } catch (error) {
      return projectFailure(error);
    }
  }

  async function acknowledgeRecovery(event, projectInstanceId, operationId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleProjectResult();
      const selectedOperationId = boundedId(
        operationId,
        OPERATION_ID_RE,
        'INVALID_STRUCTURE_TRANSACTION',
        '章节骨架事务标识无效'
      );
      const recoveryLease = recoveryLeases.get(project.rootPath);
      assertRecoveryAvailable(project, recoveryLease?.mutationLease || null);
      const current = transaction.query({
        rootPath: project.rootPath,
        projectId: project.projectId,
      });
      const markerAlreadyCleared = current?.state === 'UNCOMMITTED' &&
        recoveryLease?.committed === true &&
        recoveryLease.operationId === selectedOperationId &&
        committedOperations.get(selectedOperationId)?.treeDone === true;
      if (!markerAlreadyCleared &&
          (!current || current.operationId !== selectedOperationId)) {
        fail('WRITING_STRUCTURE_RECOVERY_NOT_FOUND', '章节骨架恢复记录不存在或已变化');
      }
      if (current.state === 'UNKNOWN') {
        fail('WRITING_STRUCTURE_COMMIT_UNKNOWN', '提交状态仍未核对；当前不能结束恢复');
      }
      if (current.state === 'COMMITTED') {
        const finalized = finalizeCommitted(project, current);
        if (!finalized.ready) return finalized.publicResult;
      }
      const result = markerAlreadyCleared
        ? { acknowledged: true }
        : transaction.acknowledge({
          rootPath: project.rootPath,
          projectId: project.projectId,
          operationId: selectedOperationId,
        });
      if (result?.acknowledged !== true) {
        return {
          ok: true,
          state: current.state,
          operationId: selectedOperationId,
          acknowledged: false,
          recoveryRequired: true,
          refreshRequired: true,
          warning: 'WRITING_STRUCTURE_RECOVERY_ACK_REQUIRED',
        };
      }
      releaseRecoveryLease(project.rootPath);
      committedOperations.delete(selectedOperationId);
      return {
        ok: true,
        state: markerAlreadyCleared ? 'COMMITTED' : current.state,
        operationId: selectedOperationId,
        acknowledged: true,
      };
    } catch (error) {
      return projectFailure(error);
    }
  }

  return Object.freeze({
    prepare,
    confirm,
    queryRecovery,
    acknowledgeRecovery,
  });
}

module.exports = Object.freeze({
  WritingStructureHandlerError,
  createWritingStructureHandlers,
});
