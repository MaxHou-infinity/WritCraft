'use strict';

const crypto = require('crypto');

const SCHEMA = 'writcraft.ai-task-progress/v1';
const DEFAULT_CANCEL_AFTER_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TASKS = 256;
const TASK_ID_RE = /^ait_[a-f0-9]{32}$/;
const SAFE_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const PHASES = Object.freeze([
  'preparing_context',
  'checking_evidence',
  'generating_suggestion',
  'validating_result',
  'waiting_review',
  'committing',
  'completed',
  'cancelled',
  'timed_out',
  'failed',
  'stale',
  'conflict',
]);
const RUNNING_PHASES = new Set(PHASES.slice(0, 6));
const TERMINAL_STATUSES = new Set([
  'review',
  'needs_sources',
  'committed',
  'rejected',
  'completed',
  'cancelled',
  'timed_out',
  'failed',
  'stale',
  'conflict',
]);
const COMPLETION_STATUSES = new Set(['review', 'needs_sources', 'committed', 'rejected', 'completed']);

class AiTaskStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiTaskStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AiTaskStateError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys, code = 'INVALID_AI_TASK') {
  if (!isPlainObject(value)) fail(code, 'AI 任务请求无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, 'AI 任务请求包含未知字段或缺少字段');
  }
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    fail('INVALID_AI_TASK', `${label}无效`);
  }
  return value;
}

function projectInstanceId(value) {
  return safeId(value, '项目实例');
}

function inputRevision(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= 256 && SAFE_ID_RE.test(value)) {
    return value;
  }
  fail('INVALID_AI_TASK', '输入 revision 无效');
}

function cloneBounded(value, label, maxBytes = 4096) {
  if (!isPlainObject(value)) fail('INVALID_AI_TASK', `${label}必须是对象`);
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { serialized = null; }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    fail('INVALID_AI_TASK', `${label}超过安全范围`);
  }
  let clone;
  try { clone = JSON.parse(serialized); } catch (_) { clone = null; }
  if (!clone) fail('INVALID_AI_TASK', `${label}不可序列化`);
  return Object.freeze(clone);
}

function randomId(prefix, randomBytes, occupied) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = `${prefix}${randomBytes(16).toString('hex')}`;
    if (!occupied.has(id)) return id;
  }
  fail('AI_TASK_ID_COLLISION', '无法分配唯一 AI 任务身份');
}

function safeMessage(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (normalized.length > 240 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function createAiTaskStateService(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : () => {};
  const cancelAfterMs = Number.isSafeInteger(options.cancelAfterMs) && options.cancelAfterMs > 0
    ? options.cancelAfterMs : DEFAULT_CANCEL_AFTER_MS;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > cancelAfterMs
    ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const tasks = new Map();
  const occupiedIds = new Set();

  function publicSnapshot(task) {
    const elapsedMs = Math.max(0, clock() - task.startedAt);
    return Object.freeze({
      schema: SCHEMA,
      taskId: task.taskId,
      attemptId: task.attemptId,
      projectInstanceId: task.projectInstanceId,
      kind: task.kind,
      targetLocator: task.targetLocator,
      inputRevision: task.inputRevision,
      phase: task.phase,
      status: task.status,
      canCancel: task.canCancel === true && task.status === 'running',
      elapsedMs,
      startedAt: task.startedAt,
      ...(task.code ? { code: task.code } : {}),
      ...(task.message ? { message: task.message } : {}),
    });
  }

  function emit(task) {
    try { onUpdate(publicSnapshot(task)); } catch (_) {
      // Progress is advisory; a failed renderer listener never changes task authority.
    }
  }

  function clearTimers(task) {
    if (task.cancelTimer !== null) clearTimer(task.cancelTimer);
    if (task.timeoutTimer !== null) clearTimer(task.timeoutTimer);
    task.cancelTimer = null;
    task.timeoutTimer = null;
  }

  function trimHistory() {
    while (tasks.size > MAX_TASKS) {
      const oldest = tasks.values().next().value;
      if (!oldest || oldest.status === 'running') break;
      tasks.delete(oldest.taskId);
      occupiedIds.delete(oldest.taskId);
    }
  }

  function requireTask(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
      fail('INVALID_AI_TASK', 'AI 任务身份无效');
    }
    const task = tasks.get(taskId);
    if (!task) fail('AI_TASK_NOT_FOUND', 'AI 任务不存在或已过期');
    return task;
  }

  function requireActive(taskId, attemptId, ownerToken) {
    const task = requireTask(taskId);
    if (task.attemptId !== safeId(attemptId, 'attempt') || task.ownerToken !== safeId(ownerToken, 'owner')) {
      fail('AI_TASK_NOT_OWNER', 'AI 任务不属于当前操作');
    }
    if (task.status !== 'running') fail('AI_TASK_NOT_ACTIVE', 'AI 任务已进入终态');
    return task;
  }

  function settle(task, status, phase, code = null, message = null) {
    if (task.status !== 'running') return publicSnapshot(task);
    clearTimers(task);
    task.status = status;
    task.phase = phase;
    task.canCancel = false;
    task.code = code;
    task.message = safeMessage(message);
    if (status !== 'running') task.controller.abort();
    emit(task);
    trimHistory();
    return publicSnapshot(task);
  }

  function begin(raw) {
    exactKeys(raw, [
      'projectInstanceId', 'kind', 'targetLocator', 'inputRevision', 'ownerToken', 'attemptId',
    ]);
    const project = projectInstanceId(raw.projectInstanceId);
    const kind = safeId(raw.kind, '任务类型');
    const target = cloneBounded(raw.targetLocator, '目标 locator');
    const revision = inputRevision(raw.inputRevision);
    const owner = safeId(raw.ownerToken, 'owner');
    const attempt = raw.attemptId === undefined || raw.attemptId === null
      ? randomId('ait_', randomBytes, occupiedIds)
      : safeId(raw.attemptId, 'attempt');
    if (tasks.size >= MAX_TASKS && [...tasks.values()].every(task => task.status === 'running')) {
      fail('AI_TASK_LIMIT', '当前 AI 任务过多，请先完成或取消已有任务');
    }
    const taskId = randomId('ait_', randomBytes, occupiedIds);
    occupiedIds.add(taskId);
    const task = {
      taskId,
      attemptId: attempt,
      projectInstanceId: project,
      kind,
      targetLocator: target,
      inputRevision: revision,
      ownerToken: owner,
      startedAt: clock(),
      phase: 'preparing_context',
      status: 'running',
      canCancel: false,
      code: null,
      message: null,
      controller: new AbortController(),
      cancelTimer: null,
      timeoutTimer: null,
    };
    tasks.set(taskId, task);
    task.cancelTimer = setTimer(() => {
      if (task.status !== 'running') return;
      task.canCancel = true;
      emit(task);
    }, cancelAfterMs);
    task.timeoutTimer = setTimer(() => {
      if (task.status !== 'running') return;
      settle(task, 'timed_out', 'timed_out', 'TIMEOUT', 'AI 任务超过 60 秒，已自动停止；没有写入项目文件');
    }, timeoutMs);
    emit(task);
    const handle = {
      taskId,
      attemptId: task.attemptId,
      ownerToken: task.ownerToken,
      projectInstanceId: task.projectInstanceId,
      signal: task.controller.signal,
      snapshot: () => publicSnapshot(task),
      phase(nextPhase) {
        const current = requireActive(task.taskId, task.attemptId, task.ownerToken);
        if (!RUNNING_PHASES.has(nextPhase)) fail('INVALID_AI_TASK_PHASE', 'AI 任务阶段无效');
        current.phase = nextPhase;
        emit(current);
        return publicSnapshot(current);
      },
      complete(status = 'review') {
        if (!COMPLETION_STATUSES.has(status)) fail('INVALID_AI_TASK_STATUS', 'AI 任务完成状态无效');
        return settle(requireActive(task.taskId, task.attemptId, task.ownerToken), status,
          status === 'review' || status === 'needs_sources' ? 'waiting_review' : 'completed');
      },
      fail(code = 'AI_TASK_FAILED', message = 'AI 任务失败；没有写入项目文件') {
        return settle(requireActive(task.taskId, task.attemptId, task.ownerToken), 'failed', 'failed', code, message);
      },
      timeout(message = 'AI 任务超时；没有写入项目文件') {
        return settle(requireActive(task.taskId, task.attemptId, task.ownerToken), 'timed_out', 'timed_out', 'TIMEOUT', message);
      },
      stale(message = '项目或输入内容已变化；本次结果已丢弃') {
        return settle(requireActive(task.taskId, task.attemptId, task.ownerToken), 'stale', 'stale', 'STALE', message);
      },
      cancel() {
        return settle(requireActive(task.taskId, task.attemptId, task.ownerToken), 'cancelled', 'cancelled',
          'REQUEST_ABORTED', 'AI 任务已取消；没有写入项目文件');
      },
      assertCurrent() {
        return publicSnapshot(requireActive(task.taskId, task.attemptId, task.ownerToken));
      },
    };
    return Object.freeze(handle);
  }

  function cancelByAttempt(raw) {
    exactKeys(raw, ['projectInstanceId', 'attemptId']);
    const project = projectInstanceId(raw.projectInstanceId);
    const attempt = safeId(raw.attemptId, 'attempt');
    const task = [...tasks.values()].find(item => item.projectInstanceId === project &&
      item.attemptId === attempt && item.status === 'running');
    if (!task) fail('AI_TASK_NOT_ACTIVE', '这一轮 AI 任务当前没有运行');
    return settle(task, 'cancelled', 'cancelled', 'REQUEST_ABORTED', 'AI 任务已取消；没有写入项目文件');
  }

  function invalidateProject(projectId, message = '项目已切换；本次 AI 结果已丢弃') {
    const project = projectInstanceId(projectId);
    let count = 0;
    for (const task of tasks.values()) {
      if (task.projectInstanceId !== project || task.status !== 'running') continue;
      settle(task, 'stale', 'stale', 'PROJECT_CHANGED', message);
      count += 1;
    }
    return count;
  }

  function get(taskId) {
    return publicSnapshot(requireTask(taskId));
  }

  function assertCurrent(raw) {
    exactKeys(raw, ['taskId', 'attemptId', 'ownerToken']);
    return publicSnapshot(requireActive(raw.taskId, raw.attemptId, raw.ownerToken));
  }

  function list(projectId = null) {
    if (projectId !== null) projectInstanceId(projectId);
    return Object.freeze([...tasks.values()]
      .filter(task => projectId === null || task.projectInstanceId === projectId)
      .map(publicSnapshot));
  }

  function stats() {
    return Object.freeze({
      total: tasks.size,
      running: [...tasks.values()].filter(task => task.status === 'running').length,
    });
  }

  return Object.freeze({
    SCHEMA,
    PHASES,
    begin,
    cancelByAttempt,
    invalidateProject,
    get,
    assertCurrent,
    list,
    stats,
  });
}

module.exports = Object.freeze({
  SCHEMA,
  DEFAULT_CANCEL_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_TASKS,
  PHASES,
  AiTaskStateError,
  createAiTaskStateService,
});
