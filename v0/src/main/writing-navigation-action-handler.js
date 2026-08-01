'use strict';

const localizedEditService = require('./localized-edit-service');
const projectChangesProposalService = require('./project-changes-proposal-service');

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
    pendingChangeSets,
    cacheReview,
    discardReview,
    staleAiProjectResult,
    projectFailure,
    deadlineMs = 90_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = options;

  function ownerId(event) {
    if (!event?.sender || !Number.isSafeInteger(event.sender.id)) {
      throw new handoffService.WritingNavigationHandoffError(
        'INVALID_OWNER',
        '写作导航窗口身份无效'
      );
    }
    return `webcontents:${event.sender.id}`;
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

  async function runBoundedChangesModel(projectInstanceId, messages, sourceSignal, providerOptions) {
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
    sourceSignal?.addEventListener?.('abort', abort, { once: true });
    timeoutId = setTimer(() => {
      controller.abort();
      rejectBoundary(new handoffService.WritingNavigationHandoffError(
        'TIMEOUT',
        '修改建议生成超时；没有创建待审内容'
      ));
    }, deadlineMs);
    try {
      if (sourceSignal?.aborted) {
        abort();
        return await boundary;
      }
      const provider = Promise.resolve().then(() => projectCallLLM(projectInstanceId)(
        messages,
        'MiniMax-M3',
        localizedEditService.STRUCTURED_MAX_TOKENS,
        { signal: controller.signal, ...providerOptions }
      ));
      return await Promise.race([provider, boundary]);
    } finally {
      clearTimer(timeoutId);
      sourceSignal?.removeEventListener?.('abort', abort);
    }
  }

  return async function runWritingNavigationAction(
    event,
    projectInstanceId,
    actionId,
    attemptId
  ) {
    let lease = null;
    let leaseBinding = null;
    let settled = false;
    let cachedCapability = null;

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

      handoffService.revalidateAuthority({
        projectService,
        rootPath: project.rootPath,
        authority: lease,
      });
      assertLeaseCurrent();

      if (lease.suggestion.action === 'open') {
        const result = handoffService.openHandoff(lease);
        assertLeaseCurrent();
        settle('success');
        return result;
      }

      if (lease.suggestion.action === 'research') {
        const result = handoffService.researchHandoff(lease);
        assertLeaseCurrent();
        settle('success');
        return result;
      }

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
      });
      const providerOptions = localizedEditService.structuredProviderOptions(
        preparedHandoff.prepared.structuredRanges
      );
      let model = await runBoundedChangesModel(
        project.instanceId,
        preparedHandoff.prepared.messages,
        lease.signal,
        providerOptions
      );
      if (!isCurrent(project, mutationGeneration, navigationEpoch)) {
        throw new handoffService.WritingNavigationHandoffError(
          'PROJECT_CHANGED',
          '生成修改建议期间项目状态已变化'
        );
      }
      await settleProjectAuthority(project);
      assertLeaseCurrent();
      handoffService.revalidateAuthority({
        projectService,
        rootPath: project.rootPath,
        authority: lease,
      });
      let result;
      try {
        const providerStructureError = localizedEditService.structuredProviderResultError(model);
        if (providerStructureError) throw providerStructureError;
        result = handoffService.finalizeChangesHandoff({
          preparedHandoff,
          model,
          changeSetService,
        });
      } catch (firstError) {
        if (!localizedEditService.isRetryableStructuredOutputError(firstError)) throw firstError;
        projectChangesProposalService.validateProjectDependencies({
          projectService,
          rootPath: project.rootPath,
          dependencies: preparedHandoff.prepared.dependencies,
        });
        assertLeaseCurrent();
        const retryMessages = localizedEditService.structuredRetryMessages(
          preparedHandoff.prepared.messages,
          firstError
        );
        model = await runBoundedChangesModel(
          project.instanceId,
          retryMessages,
          lease.signal,
          providerOptions
        );
        if (!isCurrent(project, mutationGeneration, navigationEpoch)) {
          throw new handoffService.WritingNavigationHandoffError(
            'PROJECT_CHANGED',
            '重新整理修改建议期间项目状态已变化'
          );
        }
        await settleProjectAuthority(project);
        assertLeaseCurrent();
        handoffService.revalidateAuthority({
          projectService,
          rootPath: project.rootPath,
          authority: lease,
        });
        projectChangesProposalService.validateProjectDependencies({
          projectService,
          rootPath: project.rootPath,
          dependencies: preparedHandoff.prepared.dependencies,
        });
        const retryProviderStructureError = localizedEditService.structuredProviderResultError(model);
        if (retryProviderStructureError) throw retryProviderStructureError;
        result = handoffService.finalizeChangesHandoff({
          preparedHandoff,
          model,
          changeSetService,
        });
      }
      if (!result.ok) {
        settle('retryable_failure');
        return result;
      }
      if (result.noChanges) {
        settle('success');
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
        settle('success');
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
