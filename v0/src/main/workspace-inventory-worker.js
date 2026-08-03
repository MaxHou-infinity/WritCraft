'use strict';

const { parentPort, workerData } = require('worker_threads');
const projectService = require('./project-service');
const inventoryService = require('./workspace-inventory-service');

function publicError(error) {
  return Object.freeze({
    ok: false,
    error: typeof error?.code === 'string' ? error.code : 'HOME_SNAPSHOT_FAILED',
    message: typeof error?.message === 'string' ? error.message : '项目统计暂不可用',
  });
}

try {
  const authority = Object.freeze({
    projectInstanceId: workerData.projectInstanceId,
    projectMutationGeneration: workerData.projectMutationGeneration,
  });
  const inventory = inventoryService.buildWorkspaceInventory({
    projectService,
    rootPath: workerData.rootPath,
    // The parent owns the live authority check before and after this worker.
    // Inside one worker, this immutable token prevents the core from silently
    // treating an unbound scan as authoritative.
    captureAuthority: () => authority,
    deadlineMs: workerData.deadlineMs,
  });
  parentPort.postMessage(Object.freeze({ ok: true, inventory }));
} catch (error) {
  parentPort.postMessage(publicError(error));
}
