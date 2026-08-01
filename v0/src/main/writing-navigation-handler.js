'use strict';

const {
  WritingNavigationError,
} = require('./writing-navigation-service');

const ATTEMPT_ID_RE = /^wno_[a-f0-9]{32}$/;
const DIAGNOSTIC_FAILURE_CODES = new Set([
  'LLM_FAILED',
  'NO_KEY',
  'NO_TEXT_BLOCK',
  'TIMEOUT',
  'REQUEST_ABORTED',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'REQUEST_FAILED',
  'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE',
  'API_FAILED',
  'INVALID_TOOL_USE',
  'INVALID_MODEL_OUTPUT',
  'INVALID_MODEL_EVIDENCE',
  'MODEL_OUTPUT_TOO_LARGE',
  'MODEL_OUTPUT_TRUNCATED',
]);

function createWritingNavigationHandlers(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    settleProjectAuthority,
    writingNavigationService,
    writingNavigationStore,
    handoffService,
    projectService,
    projectCallLLM,
    staleAiProjectResult,
    projectFailure,
    recordFailure = () => {},
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

  function requireAttemptId(value) {
    if (typeof value !== 'string' || !ATTEMPT_ID_RE.test(value)) {
      throw new WritingNavigationError('INVALID_ATTEMPT_ID', '写作导航请求标识无效');
    }
    return value;
  }

  function acquire(owner, project, navigationEpoch, attemptId) {
    const key = leaseKey(owner, project, navigationEpoch);
    if (active.has(key)) {
      throw new WritingNavigationError(
        'NAVIGATION_IN_PROGRESS',
        '写作导航正在整理中，请等待当前请求完成'
      );
    }
    const lease = Object.freeze({
      key,
      ownerId: owner,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      navigationEpoch,
      attemptId: requireAttemptId(attemptId),
      controller: new AbortController(),
    });
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

  async function propose(event, projectInstanceId, request, attemptId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const owner = ownerId(event);
      const entryNavigationEpoch = getRendererNavigationEpoch();
      const lease = acquire(owner, project, entryNavigationEpoch, attemptId);
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
          signal: lease.controller.signal,
        });
        if (!proposal.ok) {
          if (!isCurrent(project, mutationGeneration, navigationEpoch)) {
            return staleAiProjectResult();
          }
          recordFailure(DIAGNOSTIC_FAILURE_CODES.has(proposal.error)
            ? proposal.error
            : 'LLM_FAILED');
          return proposal;
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
  }

  async function cancel(event, projectInstanceId, attemptId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const owner = ownerId(event);
      const navigationEpoch = getRendererNavigationEpoch();
      const selectedAttemptId = requireAttemptId(attemptId);
      const key = leaseKey(owner, project, navigationEpoch);
      const lease = active.get(key);
      if (!lease ||
          lease.ownerId !== owner ||
          lease.projectInstanceId !== project.instanceId ||
          lease.rootPath !== project.rootPath ||
          lease.navigationEpoch !== navigationEpoch ||
          lease.attemptId !== selectedAttemptId) {
        throw new WritingNavigationError(
          'NAVIGATION_ATTEMPT_NOT_FOUND',
          '当前写作导航请求不存在或已结束'
        );
      }
      lease.controller.abort();
      release(lease);
      return Object.freeze({
        ok: true,
        cancelled: true,
        attemptId: selectedAttemptId,
      });
    } catch (error) {
      return projectFailure(error);
    }
  }

  async function resume(event, projectInstanceId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const owner = ownerId(event);
      const entryNavigationEpoch = getRendererNavigationEpoch();
      await settleProjectAuthority(project);
      if (getRendererNavigationEpoch() !== entryNavigationEpoch) return staleAiProjectResult();
      const mutationGeneration = getMutationGeneration();
      const record = writingNavigationStore.peekRestorable(owner, project.rootPath);
      if (!record || record.mode !== 'navigation') {
        return Object.freeze({ ok: true, result: null });
      }
      handoffService.revalidateRecord({
        projectService,
        rootPath: project.rootPath,
        record,
      });
      await settleProjectAuthority(project);
      if (!isCurrent(project, mutationGeneration, entryNavigationEpoch)) {
        return staleAiProjectResult();
      }
      const result = writingNavigationStore.restoreLatest({
        ownerId: owner,
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        mutationGeneration,
        navigationEpoch: entryNavigationEpoch,
        navigationId: record.navigationId,
      });
      return Object.freeze({ ok: true, result });
    } catch (error) {
      return projectFailure(error);
    }
  }

  return Object.freeze({ propose, cancel, resume });
}

function createProposeWritingNavigationHandler(options = {}) {
  return createWritingNavigationHandlers(options).propose;
}

module.exports = Object.freeze({
  createWritingNavigationHandlers,
  createProposeWritingNavigationHandler,
});
