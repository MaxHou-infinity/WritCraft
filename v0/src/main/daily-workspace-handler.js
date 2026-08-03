'use strict';

class DailyWorkspaceHandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DailyWorkspaceHandlerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DailyWorkspaceHandlerError(code, message);
}

function createDailyWorkspaceHandler(options = {}) {
  const {
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    settleReadAuthority,
    homeSnapshotService,
    prepareHomeData,
    ensureLocationState,
    captureProjectAuthority,
    locationService,
  } = options;
  if ([assertTrustedSender, getCurrentProject, getMutationGeneration, settleReadAuthority,
    prepareHomeData, ensureLocationState, captureProjectAuthority].some(value => typeof value !== 'function') ||
      !homeSnapshotService || typeof homeSnapshotService.build !== 'function' ||
      !locationService || typeof locationService.list !== 'function' ||
      typeof locationService.listOutline !== 'function' || typeof locationService.resolve !== 'function' ||
      typeof locationService.resolveStable !== 'function') {
    fail('INVALID_HANDLER', '日常写作工作区 handler 依赖不完整');
  }

  function requireProject(projectInstanceId) {
    const project = getCurrentProject();
    if (!project || project.instanceId !== projectInstanceId) fail('PROJECT_CHANGED', '项目已切换');
    return project;
  }

  function bind(project) {
    return Object.freeze({
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: getMutationGeneration(),
    });
  }

  function assertBinding(binding) {
    const project = getCurrentProject();
    if (!project || project.instanceId !== binding.projectInstanceId || project.rootPath !== binding.rootPath ||
        getMutationGeneration() !== binding.mutationGeneration) {
      fail('PROJECT_CHANGED', '项目状态已变化，请重新打开工作区');
    }
  }

  async function withSettledProject(event, projectInstanceId, operation) {
    assertTrustedSender(event);
    const project = requireProject(projectInstanceId);
    await settleReadAuthority(project);
    const binding = bind(project);
    const result = await operation(project, binding);
    await settleReadAuthority(project);
    assertBinding(binding);
    return result;
  }

  async function getHome(event, projectInstanceId) {
    return withSettledProject(event, projectInstanceId, async (project, binding) => {
      const prepared = await prepareHomeData(project, binding);
      if (!prepared || typeof prepared.captureHomeState !== 'function' || !prepared.inventory) {
        fail('INVALID_HANDLER', '日常写作工作区状态提供器无效');
      }
      return homeSnapshotService.build({
        projectInstanceId: binding.projectInstanceId,
        rootPath: binding.rootPath,
        captureAuthority: captureProjectAuthority,
        captureHomeState: prepared.captureHomeState,
        inventoryRunner: async () => prepared.inventory,
        partialReasons: Array.isArray(prepared.partialReasons) ? prepared.partialReasons : [],
      });
    });
  }

  async function listLocations(event, projectInstanceId, request) {
    return withSettledProject(event, projectInstanceId, async (project, binding) => {
      await ensureLocationState(project, binding);
      return locationService.list(projectInstanceId, request);
    });
  }

  async function resolveLocation(event, projectInstanceId, locationId) {
    return withSettledProject(event, projectInstanceId, async (project, binding) => {
      await ensureLocationState(project, binding);
      return locationService.resolve(projectInstanceId, locationId);
    });
  }

  async function listOutline(event, projectInstanceId, request) {
    return withSettledProject(event, projectInstanceId, async (project, binding) => {
      await ensureLocationState(project, binding);
      return locationService.listOutline(projectInstanceId, request);
    });
  }

  async function resolveStableLocation(event, projectInstanceId, locator) {
    return withSettledProject(event, projectInstanceId, async (project, binding) => {
      await ensureLocationState(project, binding);
      return locationService.resolveStable(projectInstanceId, locator);
    });
  }

  return Object.freeze({ getHome, listLocations, listOutline, resolveLocation, resolveStableLocation });
}

module.exports = { DailyWorkspaceHandlerError, createDailyWorkspaceHandler };
