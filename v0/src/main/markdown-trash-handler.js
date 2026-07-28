'use strict';

const serviceModule = require('./markdown-trash-service');

function fail(code, message) {
  throw new serviceModule.MarkdownTrashError(code, message);
}

function createMarkdownTrashHandler(options = {}) {
  const {
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
    settleListAuthority,
    trashService,
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
    settleListAuthority,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!trashService || typeof trashService.list !== 'function' ||
      typeof trashService.restore !== 'function') throw new TypeError('trashService is required');

  function authority(event, projectInstanceId) {
    assertTrustedSender(event);
    const project = getCurrentProject();
    const webContentsId = event?.sender?.id;
    const mutationGeneration = getMutationGeneration();
    const navigationEpoch = getNavigationEpoch();
    if (!project || project.instanceId !== projectInstanceId ||
        typeof project.rootPath !== 'string' ||
        !project.rootIdentity || typeof project.rootIdentity.dev !== 'bigint' ||
        typeof project.rootIdentity.ino !== 'bigint' ||
        typeof project.rootIdentity.mode !== 'bigint' ||
        !Number.isSafeInteger(webContentsId) || webContentsId < 1 ||
        !Number.isSafeInteger(mutationGeneration) || mutationGeneration < 0 ||
        !Number.isSafeInteger(navigationEpoch) || navigationEpoch < 0) {
      fail('MARKDOWN_TRASH_STALE', '项目回收区不属于当前窗口或项目');
    }
    return Object.freeze({
      webContentsId,
      projectInstanceId,
      rootPath: project.rootPath,
      rootIdentity: project.rootIdentity,
      mutationGeneration,
      navigationEpoch,
    });
  }

  return Object.freeze({
    async list(event, projectInstanceId) {
      assertTrustedSender(event);
      const project = getCurrentProject();
      if (!project || project.instanceId !== projectInstanceId) {
        fail('MARKDOWN_TRASH_STALE', '项目回收区不属于当前窗口或项目');
      }
      await settleListAuthority(project);
      return trashService.list(authority(event, projectInstanceId));
    },
    async trash(event, relPath, expectedRevision) {
      const project = getCurrentProject();
      if (!project) fail('MARKDOWN_TRASH_STALE', '项目回收区不属于当前窗口或项目');
      return trashService.trash(
        authority(event, project.instanceId),
        relPath,
        expectedRevision
      );
    },
    async restore(event, projectInstanceId, token) {
      return trashService.restore(authority(event, projectInstanceId), token);
    },
  });
}

module.exports = { createMarkdownTrashHandler };
