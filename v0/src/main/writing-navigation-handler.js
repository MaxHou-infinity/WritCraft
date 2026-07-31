'use strict';

const {
  WritingNavigationError,
} = require('./writing-navigation-service');

function createProposeWritingNavigationHandler(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    settleProjectAuthority,
    writingNavigationService,
    writingNavigationStore,
    projectService,
    projectCallLLM,
    staleAiProjectResult,
    projectFailure,
  } = options;
  const active = new Map();

  function ownerId(event) {
    if (!event?.sender || !Number.isSafeInteger(event.sender.id)) {
      throw new WritingNavigationError('INVALID_OWNER', '写作导航窗口身份无效');
    }
    return `webcontents:${event.sender.id}`;
  }

  function leaseKey(owner, project, navigationEpoch) {
    return JSON.stringify([owner, project.instanceId, project.rootPath, navigationEpoch]);
  }

  function acquire(owner, project, navigationEpoch) {
    const key = leaseKey(owner, project, navigationEpoch);
    if (active.has(key)) {
      throw new WritingNavigationError(
        'NAVIGATION_IN_PROGRESS',
        '写作导航正在整理中，请等待当前请求完成'
      );
    }
    const lease = Object.freeze({ key });
    active.set(key, lease);
    return lease;
  }

  function release(lease) {
    if (active.get(lease.key) === lease) active.delete(lease.key);
  }

  function isCurrent(project, generation, navigationEpoch) {
    const current = getCurrentProject();
    return Boolean(current &&
      current.instanceId === project.instanceId &&
      current.rootPath === project.rootPath &&
      getMutationGeneration() === generation &&
      getRendererNavigationEpoch() === navigationEpoch);
  }

  return async function proposeWritingNavigationHandler(event, projectInstanceId, request) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const owner = ownerId(event);
      const entryNavigationEpoch = getRendererNavigationEpoch();
      const lease = acquire(owner, project, entryNavigationEpoch);
      try {
        await settleProjectAuthority(project);
        if (getRendererNavigationEpoch() !== entryNavigationEpoch) return staleAiProjectResult();
        const mutationGeneration = getMutationGeneration();
        const navigationEpoch = entryNavigationEpoch;
        const proposal = await writingNavigationService.proposeWritingNavigation({
          projectService,
          rootPath: project.rootPath,
          request,
          callLLM: projectCallLLM(project.instanceId),
        });
        if (!proposal.ok) {
          return isCurrent(project, mutationGeneration, navigationEpoch)
            ? proposal
            : staleAiProjectResult();
        }
        await settleProjectAuthority(project);
        if (!isCurrent(project, mutationGeneration, navigationEpoch)) {
          return {
            ok: false,
            error: 'PROJECT_CHANGED',
            message: '整理期间项目或页面状态已变化；本次建议已作废，请重新生成',
          };
        }
        const result = writingNavigationStore.install({
          ownerId: owner,
          projectInstanceId: project.instanceId,
          rootPath: project.rootPath,
          mutationGeneration,
          navigationEpoch,
          record: proposal.record,
        });
        return Object.freeze({ ok: true, result });
      } finally {
        release(lease);
      }
    } catch (error) {
      return projectFailure(error);
    }
  };
}

module.exports = Object.freeze({ createProposeWritingNavigationHandler });
