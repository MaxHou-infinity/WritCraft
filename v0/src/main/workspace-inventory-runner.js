'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { WorkspaceInventoryError, DEFAULT_DEADLINE_MS } = require('./workspace-inventory-service');

function fail(code, message) {
  throw new WorkspaceInventoryError(code, message);
}

function sameAuthority(left, right) {
  return Boolean(left && right && left.projectInstanceId === right.projectInstanceId &&
    Number.isSafeInteger(left.projectMutationGeneration) &&
    left.projectMutationGeneration === right.projectMutationGeneration);
}

/**
 * Run the synchronous filesystem scan in a terminable worker. The caller must
 * provide a Main-owned live authority getter; a result is published only when
 * the exact project instance and mutation generation still match.
 */
function runWorkspaceInventory(options = {}) {
  const captureAuthority = options.captureAuthority;
  const WorkerClass = options.WorkerClass || Worker;
  const deadlineMs = Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0
    ? Math.min(options.deadlineMs, DEFAULT_DEADLINE_MS)
    : DEFAULT_DEADLINE_MS;
  if (typeof captureAuthority !== 'function' || typeof options.rootPath !== 'string' || !options.rootPath) {
    return Promise.reject(new WorkspaceInventoryError('INVALID_AUTHORITY_GUARD', '工作区索引缺少项目权威保护'));
  }
  const authority = captureAuthority();
  if (!authority || typeof authority.projectInstanceId !== 'string' ||
      !Number.isSafeInteger(authority.projectMutationGeneration) || authority.projectMutationGeneration < 0) {
    return Promise.reject(new WorkspaceInventoryError('PROJECT_CHANGED', '项目权威不可用'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new WorkerClass(path.join(__dirname, 'workspace-inventory-worker.js'), {
      workerData: {
        rootPath: options.rootPath,
        projectInstanceId: authority.projectInstanceId,
        projectMutationGeneration: authority.projectMutationGeneration,
        deadlineMs,
      },
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      callback(value);
    };
    const timeout = setTimeout(() => {
      Promise.resolve(worker.terminate()).catch(() => {});
      finish(reject, new WorkspaceInventoryError('HOME_SNAPSHOT_TIMEOUT', '项目统计暂不可用'));
    }, deadlineMs);
    worker.once('message', message => {
      if (!sameAuthority(authority, captureAuthority())) {
        finish(reject, new WorkspaceInventoryError('PROJECT_CHANGED', '项目在索引期间发生变化'));
        return;
      }
      if (!message || message.ok !== true || !message.inventory) {
        finish(reject, new WorkspaceInventoryError(
          typeof message?.error === 'string' ? message.error : 'HOME_SNAPSHOT_FAILED',
          typeof message?.message === 'string' ? message.message : '项目统计暂不可用'
        ));
        return;
      }
      finish(resolve, message.inventory);
    });
    worker.once('error', () => finish(reject,
      new WorkspaceInventoryError('HOME_SNAPSHOT_FAILED', '项目统计暂不可用')));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(reject,
        new WorkspaceInventoryError('HOME_SNAPSHOT_FAILED', '项目统计暂不可用'));
    });
  });
}

module.exports = { runWorkspaceInventory };
