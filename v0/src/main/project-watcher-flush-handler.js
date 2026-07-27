'use strict';

const RESULT_SCHEMA = 'writcraft.watcher-flush-result/v1';
const BARRIER_SCHEMA = 'writcraft.watcher-flush-barrier/v1';
const BARRIER_CHANNEL = 'writcraft:project:watcher-flushed';

function createProjectWatcherFlushHandler(dependencies) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getCurrentWatcher,
    assertWatcherAvailable,
    markWatcherDegraded,
    getMutationDepth,
    getInternalMutationEpoch,
    getMutationGeneration,
    getNavigationEpoch,
    createError,
    createId,
    projectChanged,
    projectFailure,
    sendBarrier,
  } = dependencies;

  function unavailable(message) {
    return createError(
      'PROJECT_WATCHER_UNAVAILABLE',
      message || '项目文件监控不可用；请重新打开项目后再继续 AI 或文件修改'
    );
  }

  function currentMatches(project, watcher) {
    const current = getCurrentProject();
    return Boolean(current && current.instanceId === project.instanceId &&
      current.rootPath === project.rootPath && getCurrentWatcher() === watcher);
  }

  return async function flushProjectWatcher(event, projectInstanceId) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (typeof projectInstanceId !== 'string' || projectInstanceId !== project.instanceId) {
        return projectChanged();
      }
      assertWatcherAvailable(project);
      const watcher = getCurrentWatcher();
      if (!watcher || typeof watcher.flush !== 'function') throw unavailable();
      if (getMutationDepth(project.rootPath) > 0) {
        throw createError(
          'PROJECT_MUTATION_IN_PROGRESS',
          '项目文件正在提交，请等待保存完成后再继续 AI 操作'
        );
      }
      const internalMutationEpoch = getInternalMutationEpoch();
      const navigationEpoch = getNavigationEpoch();

      let flushed;
      try {
        flushed = await watcher.flush();
      } catch (_) {
        if (!currentMatches(project, watcher)) return projectChanged();
        markWatcherDegraded(project);
        throw unavailable('项目文件监控无法完成一致性扫描；请重新打开项目');
      }

      if (!currentMatches(project, watcher)) return projectChanged();
      if (getNavigationEpoch() !== navigationEpoch) return projectChanged();
      if (!flushed || flushed.ok !== true) {
        markWatcherDegraded(project);
        throw unavailable();
      }
      assertWatcherAvailable(project);
      if (getMutationDepth(project.rootPath) > 0 ||
          getInternalMutationEpoch() !== internalMutationEpoch) {
        throw createError(
          'PROJECT_MUTATION_IN_PROGRESS',
          '项目文件正在提交，请等待保存完成后再继续 AI 操作'
        );
      }

      const common = {
        flushId: createId(),
        projectInstanceId: project.instanceId,
        mutationGeneration: getMutationGeneration(),
      };
      const barrier = Object.freeze({ schema: BARRIER_SCHEMA, ...common });
      sendBarrier(event, BARRIER_CHANNEL, barrier);
      return Object.freeze({ ok: true, schema: RESULT_SCHEMA, ...common });
    } catch (error) {
      return projectFailure(error);
    }
  };
}

module.exports = Object.freeze({
  RESULT_SCHEMA,
  BARRIER_SCHEMA,
  BARRIER_CHANNEL,
  createProjectWatcherFlushHandler,
});
