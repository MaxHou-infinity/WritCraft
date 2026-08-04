'use strict';

const localizedEditService = require('./localized-edit-service');
const projectChangesProposalService = require('./project-changes-proposal-service');
const unifiedWritingTaskService = require('./unified-writing-task-service');

function createWritingNavigationActionHandler(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    settleProjectAuthority,
    writingNavigationStore,
    handoffService,
    projectService,
    projectCallLLM,
    changeSetService,
    sourceIndexService,
    pendingChangeSets,
    cacheReview,
    discardReview,
    staleAiProjectResult,
    projectFailure,
    aiTaskState = null,
    // Leave a bounded hand-off window before the Renderer-wide 60 second
    // terminal so a completed Main review cannot race the visible timeout.
    deadlineMs = 50_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  function reportProgress(event, attemptId, phase, taskHandle = null) {
    const taskPhase = {
      saving_current_content: 'preparing_context',
      checking_evidence: 'checking_evidence',
      generating_changes: 'generating_suggestion',
      preparing_diff: 'validating_result',
    }[phase];
    if (taskHandle && taskPhase) {
      try { taskHandle.phase(taskPhase); } catch (_) {}
    }
    try {
      event?.sender?.send?.('writcraft:writing-task-progress', Object.freeze({
        attemptId,
        phase,
      }));
    } catch (_) {
      // Progress is advisory only; Main authority never depends on delivery.
    }
  }

  function ownerId(event) {
    if (!event?.sender || !Number.isSafeInteger(event.sender.id)) {
      throw new handoffService.WritingNavigationHandoffError(
        'INVALID_OWNER',
        '写作导航窗口身份无效'
      );
    }
    return `webcontents:${event.sender.id}`;
  }

  function hasInvalidUnicode(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function binding(owner, project, mutationGeneration, navigationEpoch, extra = {}) {
    return {
      ownerId: owner,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration,
      navigationEpoch,
      ...extra,
    };
  }

  function isCurrent(project, mutationGeneration, navigationEpoch) {
    const current = getCurrentProject();
    return Boolean(current &&
      current.instanceId === project.instanceId &&
      current.rootPath === project.rootPath &&
      getMutationGeneration() === mutationGeneration &&
      getRendererNavigationEpoch() === navigationEpoch);
  }

  async function runBoundedChangesModel(
    projectInstanceId,
    messages,
    sourceSignal,
    providerOptions,
    additionalSignal = null,
    taskHandle = null
  ) {
    const controller = new AbortController();
    let rejectBoundary;
    let timeoutId;
    const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
    const abort = () => {
      controller.abort();
      rejectBoundary(new handoffService.WritingNavigationHandoffError(
        'REQUEST_ABORTED',
        '修改建议已取消；没有创建待审内容'
      ));
    };
    const abortSignals = [sourceSignal, additionalSignal].filter(Boolean);
    for (const signal of abortSignals) signal.addEventListener?.('abort', abort, { once: true });
    timeoutId = setTimer(() => {
      controller.abort();
      rejectBoundary(new handoffService.WritingNavigationHandoffError(
        'TIMEOUT',
        '修改建议生成超时；没有创建待审内容'
      ));
    }, deadlineMs);
    try {
      if (sourceSignal?.aborted || additionalSignal?.aborted) {
        abort();
        return await boundary;
      }
      const provider = Promise.resolve().then(() => projectCallLLM(projectInstanceId)(
        messages,
        'MiniMax-M3',
        localizedEditService.STRUCTURED_MAX_TOKENS,
        { signal: controller.signal, taskHandle, ...providerOptions }
      ));
      return await Promise.race([provider, boundary]);
    } finally {
      clearTimer(timeoutId);
      for (const signal of abortSignals) signal.removeEventListener?.('abort', abort);
    }
  }

  return async function runWritingNavigationAction(
    event,
    projectInstanceId,
    actionId,
    attemptId,
    adjustment = '',
    sourceIds = []
  ) {
    let lease = null;
    let leaseBinding = null;
    let settled = false;
    let cachedCapability = null;
    let taskHandle = null;

    function assertLeaseCurrent() {
      return writingNavigationStore.assertLeaseCurrent({
        ...leaseBinding,
        leaseId: lease.leaseId,
      });
    }

    function settle(outcome) {
      const result = writingNavigationStore.settleAction({
        ...leaseBinding,
        leaseId: lease.leaseId,
        outcome,
      });
      settled = true;
      return result;
    }

    function settleFailure(error) {
      if (!lease || settled) return;
      const stale = !isCurrent(
        { instanceId: leaseBinding.projectInstanceId, rootPath: leaseBinding.rootPath },
        leaseBinding.mutationGeneration,
        leaseBinding.navigationEpoch
      ) || /(?:STALE|PROJECT_CHANGED|NAVIGATION_NOT_FOUND|ACTION_NOT_FOUND|LEASE_NOT_FOUND)/.test(
        String(error?.code || '')
      );
      try { settle(stale ? 'stale' : 'retryable_failure'); } catch (_) {}
    }

    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const owner = ownerId(event);

      await settleProjectAuthority(project);
      const mutationGeneration = getMutationGeneration();
      const navigationEpoch = getRendererNavigationEpoch();
      leaseBinding = binding(owner, project, mutationGeneration, navigationEpoch);
      lease = writingNavigationStore.acquireAction({
        ...leaseBinding,
        actionId,
        attemptId,
      });
      if (aiTaskState) {
        taskHandle = aiTaskState.begin({
          projectInstanceId: project.instanceId,
          kind: 'navigation_action',
          targetLocator: {
            kind: 'writing_navigation_suggestion',
            navigationId: lease.navigationId,
            suggestionId: lease.suggestion.suggestionId,
          },
          inputRevision: mutationGeneration,
          ownerToken: lease.leaseId,
          attemptId,
        });
      }

      if (typeof adjustment !== 'string' || adjustment.length > 500 ||
          adjustment !== adjustment.trim() || hasInvalidUnicode(adjustment) ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(adjustment)) {
        throw new handoffService.WritingNavigationHandoffError(
          'INVALID_ADJUSTMENT',
          '继续调整内容无效'
        );
      }
      if (!Array.isArray(sourceIds) || sourceIds.length > 8 ||
          sourceIds.some(id => typeof id !== 'string' || !/^src_[a-f0-9]{20}$/.test(id)) ||
          new Set(sourceIds).size !== sourceIds.length) {
        throw new handoffService.WritingNavigationHandoffError(
          'INVALID_SOURCE_SELECTION',
          '补充来源选择无效'
        );
      }
      let extraContextPaths = [];
      if (sourceIds.length) {
        const index = sourceIndexService.buildSourceIndex(project.rootPath);
        const byId = new Map(index.sources.map(source => [source.id, source]));
        extraContextPaths = sourceIds.map(id => {
          const source = byId.get(id);
          if (!source) {
            throw new handoffService.WritingNavigationHandoffError(
              'SOURCE_NOT_FOUND',
              '补充来源已变化，请重新选择'
            );
          }
          return source.filePath;
        });
      }

      reportProgress(event, attemptId, 'checking_evidence', taskHandle);
      handoffService.revalidateAuthority({
        projectService,
        rootPath: project.rootPath,
        authority: lease,
      });
      assertLeaseCurrent();

      if (lease.suggestion.action !== 'changes') {
        throw new handoffService.WritingNavigationHandoffError(
          'ACTION_MISMATCH',
          '写作导航动作类型无效'
        );
      }
      if (pendingChangeSets.hasForRoot(project.rootPath)) {
        settle('review_in_progress');
        return {
          ok: false,
          error: 'REVIEW_IN_PROGRESS',
          message: '当前还有一份修改建议等待审阅。请先接受或丢弃，再从这条导航建议继续。',
        };
      }

      const preparedHandoff = handoffService.prepareChangesHandoff({
        projectService,
        rootPath: project.rootPath,
        authority: lease,
        adjustment,
        extraContextPaths,
      });
      const providerOptions = unifiedWritingTaskService.providerOptions(
        preparedHandoff.prepared.structuredRanges
      );
      reportProgress(event, attemptId, 'generating_changes', taskHandle);
      const model = await runBoundedChangesModel(
        project.instanceId,
        preparedHandoff.prepared.messages,
        lease.signal,
        providerOptions,
        taskHandle?.signal || null,
        taskHandle
      );
      if (!isCurrent(project, mutationGeneration, navigationEpoch)) {
        throw new handoffService.WritingNavigationHandoffError(
          'PROJECT_CHANGED',
          '生成修改建议期间项目状态已变化'
        );
      }
      await settleProjectAuthority(project);
      assertLeaseCurrent();
      reportProgress(event, attemptId, 'preparing_diff', taskHandle);
      handoffService.revalidateAuthority({
        projectService,
        rootPath: project.rootPath,
        authority: lease,
      });
      const parsed = unifiedWritingTaskService.parseResult(
        model,
        preparedHandoff.prepared.snapshots,
        preparedHandoff.prepared.structuredRanges
      );
      if (parsed.kind === 'needs_sources') {
        projectChangesProposalService.validateProjectDependencies({
          projectService,
          rootPath: project.rootPath,
          dependencies: preparedHandoff.prepared.dependencies,
        });
        assertLeaseCurrent();
        const result = handoffService.needsSourcesHandoff(preparedHandoff, parsed);
        taskHandle?.complete('needs_sources');
        settle('retryable_failure');
        return result;
      }
      const result = handoffService.finalizeChangesHandoff({
        preparedHandoff,
        parsed,
        changeSetService,
      });
      if (!result.ok) {
        taskHandle?.fail(result.error || 'AI_TASK_FAILED', result.message || '没有形成可审阅修改；没有写入项目文件');
        settle('retryable_failure');
        return result;
      }
      if (result.noChanges) {
        taskHandle?.fail('NO_CHANGES', '本次没有形成可审阅修改；没有写入项目文件');
        settle('retryable_failure');
        return result;
      }
      projectChangesProposalService.validateProjectDependencies({
        projectService,
        rootPath: project.rootPath,
        dependencies: result.dependencies,
      });
      if (pendingChangeSets.hasForRoot(project.rootPath)) {
        settle('review_in_progress');
        return {
          ok: false,
          error: 'REVIEW_IN_PROGRESS',
          message: '生成期间出现了另一份待审修改。现有审阅已保留，请处理后再继续。',
        };
      }
      assertLeaseCurrent();
      const cached = cacheReview(result.changeSet, project, {
        projectDependencies: result.dependencies,
        provenance: result.provenance,
      });
      cachedCapability = cached.capability;
      try {
        assertLeaseCurrent();
        settle('review_ready');
        taskHandle?.complete('review');
      } catch (error) {
        discardReview(cachedCapability, 'writing-navigation-settle-rollback');
        cachedCapability = null;
        throw error;
      }
      return {
        ok: true,
        kind: 'changes',
        noChanges: false,
        changeSetId: cached.capability,
        review: cached.review,
        fileCount: result.fileCount,
        provenance: result.provenance,
      };
    } catch (error) {
      if (cachedCapability) {
        try { discardReview(cachedCapability, 'writing-navigation-failure-rollback'); } catch (_) {}
      }
      if (taskHandle) {
        try {
          const status = taskHandle.snapshot().status;
          if (status === 'running') {
            if (error?.code === 'REQUEST_ABORTED') taskHandle.cancel();
            else if (error?.code === 'TIMEOUT') taskHandle.timeout();
            else if (/(?:STALE|PROJECT_CHANGED|NAVIGATION_NOT_FOUND|ACTION_NOT_FOUND|LEASE_NOT_FOUND)/.test(String(error?.code || ''))) {
              taskHandle.stale();
            } else taskHandle.fail(error?.code || 'AI_TASK_FAILED', error?.message);
          }
        } catch (_) {}
      }
      settleFailure(error);
      return projectFailure(error);
    }
  };

}

function createCancelWritingNavigationActionHandler(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    writingNavigationStore,
    handoffService,
    staleAiProjectResult,
    projectFailure,
  } = options;
  return async function cancelWritingNavigationAction(
    event,
    projectInstanceId,
    actionId,
    attemptId
  ) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      if (!event?.sender || !Number.isSafeInteger(event.sender.id)) {
        throw new handoffService.WritingNavigationHandoffError(
          'INVALID_OWNER',
          '写作导航窗口身份无效'
        );
      }
      writingNavigationStore.cancelAction({
        ownerId: `webcontents:${event.sender.id}`,
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        mutationGeneration: getMutationGeneration(),
        navigationEpoch: getRendererNavigationEpoch(),
        actionId,
        attemptId,
      });
      return { ok: true, cancelled: true };
    } catch (error) {
      return projectFailure(error);
    }
  };
}

module.exports = Object.freeze({
  createWritingNavigationActionHandler,
  createCancelWritingNavigationActionHandler,
});
