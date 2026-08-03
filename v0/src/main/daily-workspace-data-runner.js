'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_DEADLINE_MS = 5000;
const PUBLIC_FAILURES = Object.freeze({
  HOME_SNAPSHOT_TIMEOUT: '项目统计暂不可用',
  PROJECT_CHANGED: '项目状态已变化，请重新刷新工作区',
  INDEX_BYTE_LIMIT: '项目正文超过本次索引上限',
  TREE_TOO_LARGE: '项目文件数量超过本次索引上限',
  TREE_TOO_DEEP: '项目目录层级超过本次索引上限',
  UNSAFE_PROJECT_TREE: '项目树包含无法安全索引的路径',
});

class DailyWorkspaceDataError extends Error {
  constructor(code, message) { super(message); this.name = 'DailyWorkspaceDataError'; this.code = code; }
}

function publicWorkerFailure(code) {
  const stableCode = Object.prototype.hasOwnProperty.call(PUBLIC_FAILURES, code)
    ? code
    : 'DAILY_WORKSPACE_FAILED';
  return new DailyWorkspaceDataError(
    stableCode,
    PUBLIC_FAILURES[stableCode] || '工作区数据暂不可用，请稍后重试'
  );
}

function runDailyWorkspaceData(options = {}) {
  const deadlineMs = Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0
    ? Math.min(options.deadlineMs, DEFAULT_DEADLINE_MS) : DEFAULT_DEADLINE_MS;
  const WorkerClass = options.WorkerClass || Worker;
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new WorkerClass(path.join(__dirname, 'daily-workspace-data-worker.js'), {
      workerData: { rootPath: options.rootPath, authority: options.authority },
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(new DailyWorkspaceDataError('HOME_SNAPSHOT_TIMEOUT', '项目统计暂不可用'));
    }, deadlineMs);
    worker.once('message', message => {
      worker.terminate().catch(() => {});
      // Worker output is an untrusted process boundary. Preserve only
      // allowlisted codes and fixed local copy; never forward its message.
      if (!message?.ok) finish(publicWorkerFailure(message?.error?.code));
      else finish(null, message.data);
    });
    worker.once('error', () => finish(publicWorkerFailure('DAILY_WORKSPACE_FAILED')));
    worker.once('exit', code => { if (!settled && code !== 0) finish(publicWorkerFailure('DAILY_WORKSPACE_FAILED')); });
  });
}

module.exports = { DEFAULT_DEADLINE_MS, DailyWorkspaceDataError, publicWorkerFailure, runDailyWorkspaceData };
