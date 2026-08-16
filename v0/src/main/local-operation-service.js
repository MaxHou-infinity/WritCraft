'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');

const PROGRESS_AFTER_MS = 2000;
const CANCEL_AFTER_MS = 10000;
const MAX_TASKS = 256;
const KIND_PATHS = Object.freeze({
  SNAPSHOT_CREATE: Object.freeze([
    'preparing', 'settling_watcher', 'scanning_sources', 'writing_private_bundle',
    'publishing_bundle', 'reconciling', 'completed',
  ]),
  SNAPSHOT_COMPARE: Object.freeze([
    'preparing', 'settling_watcher', 'reading_snapshot', 'comparing', 'completed',
  ]),
  SNAPSHOT_RESTORE: Object.freeze([
    'preparing', 'preparing_restore', 'restoring_markdown', 'reconciling', 'completed',
  ]),
  SNAPSHOT_DELETE: Object.freeze([
    'preparing', 'quarantining_snapshot', 'deleting_snapshot', 'reconciling', 'completed',
  ]),
});
const DEADLINES = Object.freeze({
  SNAPSHOT_CREATE: 120000,
  SNAPSHOT_COMPARE: 60000,
  SNAPSHOT_RESTORE: 120000,
  SNAPSHOT_DELETE: 120000,
});
const TERMINAL_STATUSES = new Set(['completed', 'failed']);

class LocalOperationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalOperationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalOperationError(code, message);
}

function exactKeys(value, keys, field) {
  schema.assertExactKeys(value, keys, field);
}

function createLocalOperationService(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : crypto.randomBytes;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const tasks = new Map();
  const activeByProject = new Map();
  const occupiedIds = new Set();

  function allocateId() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = `local_${randomBytes(16).toString('hex')}`;
      if (!occupiedIds.has(value)) {
        occupiedIds.add(value);
        return value;
      }
    }
    fail('LOCAL_TASK_ID_COLLISION', '无法分配本地任务身份');
  }

  function elapsed(task) {
    return Math.max(0, clock() - task.startedEpochMs);
  }

  function isCancelable(task) {
    return task.status === 'running' && elapsed(task) >= CANCEL_AFTER_MS &&
      schema.PRECOMMIT_LOCAL_TASK_STAGES.includes(task.stage);
  }

  function snapshot(task) {
    const value = {
      schema: schema.SCHEMAS.LOCAL_TASK,
      taskId: task.taskId,
      projectInstanceId: task.projectInstanceId,
      kind: task.kind,
      stage: task.stage,
      status: task.status,
      startedAt: task.startedAt,
      elapsedMs: elapsed(task),
      cancelAvailable: isCancelable(task),
      terminalTruth: task.terminalTruth,
      errorCode: task.errorCode,
    };
    schema.assertLocalTask(value);
    return Object.freeze(value);
  }

  function emit(task) {
    const value = snapshot(task);
    if (!task.visible) return value;
    try {
      onUpdate(value);
    } catch (_) {
      // Renderer progress is advisory and never changes operation authority.
    }
    return value;
  }

  function clearTimers(task) {
    for (const timer of task.timers) clearTimer(timer);
    task.timers.clear();
  }

  function activeTask(taskId) {
    schema.assertOpaqueId(taskId, 'taskId');
    const task = tasks.get(taskId);
    if (!task) fail('LOCAL_TASK_NOT_FOUND', '本地任务不存在或已过期');
    return task;
  }

  function assertOwned(task, token, allowInvalidated = false) {
    if (task.token !== token) fail('LOCAL_TASK_NOT_OWNER', '本地任务不属于当前操作');
    if (TERMINAL_STATUSES.has(task.status)) fail('LOCAL_TASK_NOT_ACTIVE', '本地任务已进入终态');
    if (!allowInvalidated && !task.visible) fail('LOCAL_TASK_STALE', '项目已切换，本地任务结果不可见');
    return task;
  }

  function requestAbort(task, code) {
    if (TERMINAL_STATUSES.has(task.status)) return snapshot(task);
    task.abortCode = task.abortCode || code;
    if (task.status === 'running') task.status = 'cancelling';
    task.controller.abort(task.abortCode);
    return emit(task);
  }

  function settle(task, token, terminalTruth, errorCode) {
    assertOwned(task, token, true);
    if (!schema.TERMINAL_TRUTHS.includes(terminalTruth)) {
      fail('INVALID_LOCAL_TASK_TERMINAL', '本地任务终态真相无效');
    }
    if (terminalTruth === 'COMMITTED' && errorCode === null) {
      task.status = 'completed';
    } else {
      schema.nullableErrorCode(errorCode, 'errorCode');
      if (errorCode === null) fail('INVALID_LOCAL_TASK_TERMINAL', '非成功终态必须有稳定 errorCode');
      task.status = 'failed';
    }
    clearTimers(task);
    task.stage = 'completed';
    task.terminalTruth = terminalTruth;
    task.errorCode = errorCode;
    task.controller.abort(errorCode || 'COMMITTED');
    if (activeByProject.get(task.projectInstanceId) === task.token) {
      activeByProject.delete(task.projectInstanceId);
    }
    const value = emit(task);
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.values().next().value;
      if (!oldest || !TERMINAL_STATUSES.has(oldest.status)) break;
      tasks.delete(oldest.taskId);
      occupiedIds.delete(oldest.taskId);
    }
    return value;
  }

  function begin(raw) {
    exactKeys(raw, ['projectInstanceId', 'kind', 'ownerGeneration'], 'local operation begin');
    schema.assertProjectInstanceId(raw.projectInstanceId);
    if (!Object.hasOwn(KIND_PATHS, raw.kind)) fail('INVALID_LOCAL_TASK', '本地任务 kind 无效');
    schema.assertSafeInteger(raw.ownerGeneration, 'ownerGeneration');
    if (activeByProject.has(raw.projectInstanceId)) {
      fail('LOCAL_TASK_BUSY', '该项目已有本地任务正在运行');
    }
    const taskId = allocateId();
    const token = Object.freeze({ taskId, ownerGeneration: raw.ownerGeneration });
    const startedEpochMs = clock();
    if (!Number.isSafeInteger(startedEpochMs) || startedEpochMs < 0) {
      fail('INVALID_LOCAL_TASK_CLOCK', '本地任务时钟无效');
    }
    const task = {
      taskId,
      token,
      projectInstanceId: raw.projectInstanceId,
      ownerGeneration: raw.ownerGeneration,
      kind: raw.kind,
      path: KIND_PATHS[raw.kind],
      stageIndex: 0,
      stage: 'preparing',
      status: 'queued',
      startedEpochMs,
      startedAt: new Date(startedEpochMs).toISOString(),
      terminalTruth: null,
      errorCode: null,
      abortCode: null,
      visible: true,
      controller: new AbortController(),
      timers: new Set(),
    };
    tasks.set(taskId, task);
    activeByProject.set(task.projectInstanceId, token);
    emit(task);

    function schedule(delay, callback) {
      const timer = setTimer(() => {
        task.timers.delete(timer);
        if (!TERMINAL_STATUSES.has(task.status)) callback();
      }, delay);
      timer?.unref?.();
      task.timers.add(timer);
    }

    schedule(PROGRESS_AFTER_MS, () => emit(task));
    schedule(CANCEL_AFTER_MS, () => emit(task));
    schedule(DEADLINES[task.kind], () => {
      if (task.status === 'queued') {
        settle(task, token, 'UNCOMMITTED', 'LOCAL_TASK_TIMEOUT');
        return;
      }
      requestAbort(task, 'LOCAL_TASK_TIMEOUT');
    });

    const handle = {
      taskId,
      projectInstanceId: task.projectInstanceId,
      ownerGeneration: task.ownerGeneration,
      signal: task.controller.signal,
      start() {
        const current = assertOwned(task, token);
        if (current.status !== 'queued') fail('INVALID_LOCAL_TASK_TRANSITION', '本地任务已开始');
        current.status = 'running';
        return emit(current);
      },
      stage(nextStage) {
        const current = assertOwned(task, token);
        if (current.status !== 'running') fail('INVALID_LOCAL_TASK_TRANSITION', '本地任务不在运行状态');
        const nextIndex = current.path.indexOf(nextStage);
        if (nextIndex < current.stageIndex || nextIndex < 0 || nextStage === 'completed') {
          fail('INVALID_LOCAL_TASK_TRANSITION', '本地任务阶段回退或越界');
        }
        current.stageIndex = nextIndex;
        current.stage = nextStage;
        return emit(current);
      },
      snapshot() {
        return snapshot(task);
      },
      assertCurrentOwner() {
        assertOwned(task, token);
        if (activeByProject.get(task.projectInstanceId) !== token) {
          fail('LOCAL_TASK_STALE', '本地任务 owner 已失效');
        }
        return snapshot(task);
      },
      terminal(terminalTruth, errorCode = null) {
        return settle(task, token, terminalTruth, errorCode);
      },
      abortCode() {
        return task.abortCode;
      },
    };
    return Object.freeze(handle);
  }

  function cancel(raw) {
    exactKeys(raw, ['projectInstanceId', 'taskId'], 'local operation cancel');
    schema.assertProjectInstanceId(raw.projectInstanceId);
    const task = activeTask(raw.taskId);
    if (task.projectInstanceId !== raw.projectInstanceId || !task.visible) {
      fail('LOCAL_TASK_NOT_OWNER', '本地任务不属于当前项目');
    }
    if (!isCancelable(task)) fail('LOCAL_TASK_NOT_CANCELABLE', '本地任务尚不可取消');
    return requestAbort(task, 'REQUEST_ABORTED');
  }

  function invalidateProject(projectInstanceId, ownerGeneration) {
    schema.assertProjectInstanceId(projectInstanceId);
    schema.assertSafeInteger(ownerGeneration, 'ownerGeneration');
    const token = activeByProject.get(projectInstanceId);
    if (!token) return 0;
    const task = tasks.get(token.taskId);
    if (!task || task.ownerGeneration >= ownerGeneration) return 0;
    activeByProject.delete(projectInstanceId);
    task.visible = false;
    requestAbort(task, 'PROJECT_CHANGED');
    return 1;
  }

  function get(taskId) {
    return snapshot(activeTask(taskId));
  }

  return Object.freeze({
    begin,
    cancel,
    invalidateProject,
    get,
  });
}

module.exports = Object.freeze({
  PROGRESS_AFTER_MS,
  CANCEL_AFTER_MS,
  MAX_TASKS,
  KIND_PATHS,
  DEADLINES,
  LocalOperationError,
  createLocalOperationService,
});
