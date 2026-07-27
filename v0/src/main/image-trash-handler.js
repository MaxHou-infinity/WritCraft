'use strict';

const imageTrashServiceModule = require('./image-trash-service');

const ITEM_TOKEN_RE = /^iti_[a-f0-9]{48}$/;
const SNAPSHOT_TOKEN_RE = /^its_[a-f0-9]{48}$/;

function fail(code, message) {
  throw new imageTrashServiceModule.ImageTrashError(code, message);
}

function senderId(event) {
  const value = event?.sender?.id;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('IMAGE_TRASH_STALE', '图片废纸篓窗口已经失效');
  }
  return value;
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('IMAGE_TRASH_STALE', '图片废纸篓项目状态无效');
  }
  return value;
}

function exactToken(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('IMAGE_TRASH_REQUEST_INVALID', '图片废纸篓操作身份无效');
  }
  return value;
}

function createImageTrashHandler(options = {}) {
  const {
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
    trashService,
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!trashService || typeof trashService.list !== 'function' ||
      typeof trashService.restore !== 'function' ||
      typeof trashService.empty !== 'function') {
    throw new TypeError('trashService is required');
  }

  function currentProject(projectInstanceId) {
    const current = getCurrentProject();
    if (!current || typeof current.instanceId !== 'string' ||
        typeof current.rootPath !== 'string' ||
        current.instanceId !== projectInstanceId) {
      fail('IMAGE_TRASH_STALE', '图片废纸篓不属于当前项目');
    }
    return current;
  }

  function binding(event, project) {
    return Object.freeze({
      webContentsId: senderId(event),
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: safeGeneration(getMutationGeneration()),
      navigationEpoch: safeGeneration(getNavigationEpoch()),
    });
  }

  function list(event, projectInstanceId) {
    assertTrustedSender(event);
    const project = currentProject(projectInstanceId);
    return trashService.list(binding(event, project));
  }

  function restore(event, projectInstanceId, token) {
    assertTrustedSender(event);
    const project = currentProject(projectInstanceId);
    return trashService.restore(
      binding(event, project),
      exactToken(token, ITEM_TOKEN_RE)
    );
  }

  function empty(event, projectInstanceId, token) {
    assertTrustedSender(event);
    const project = currentProject(projectInstanceId);
    return trashService.empty(
      binding(event, project),
      exactToken(token, SNAPSHOT_TOKEN_RE)
    );
  }

  return Object.freeze({ list, restore, empty });
}

module.exports = {
  createImageTrashHandler,
};
