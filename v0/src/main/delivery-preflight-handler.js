'use strict';

const schema = require('./delivery-preflight-schema');
const deliveryService = require('./delivery-preflight-service');

const STABLE_ERROR_CODES = new Set([
  'SNAPSHOT_BUSY', 'SNAPSHOT_BARRIER_FAILED', 'SNAPSHOT_BUDGET_EXCEEDED',
  'SNAPSHOT_CAPACITY_EXCEEDED', 'SNAPSHOT_STALE', 'SNAPSHOT_CONFLICT',
  'SNAPSHOT_OUTCOME_UNKNOWN', 'DELIVERY_STALE', 'DELIVERY_PARTIAL', 'DELIVERY_BLOCKED',
  'LOCAL_OPERATION_TIMEOUT',
]);
const STABLE_ERROR_MESSAGES = Object.freeze({
  SNAPSHOT_BUSY: 'snapshot 当前不可用',
  SNAPSHOT_BARRIER_FAILED: 'snapshot barrier 未完成',
  SNAPSHOT_BUDGET_EXCEEDED: 'snapshot 超出预算',
  SNAPSHOT_CAPACITY_EXCEEDED: 'snapshot 超出容量',
  SNAPSHOT_STALE: 'snapshot 已过期',
  SNAPSHOT_CONFLICT: 'snapshot 存在冲突',
  SNAPSHOT_OUTCOME_UNKNOWN: 'snapshot 结果未知',
  DELIVERY_STALE: '交付预检已过期',
  DELIVERY_PARTIAL: '交付预检不完整',
  DELIVERY_BLOCKED: '交付预检被阻断',
  LOCAL_OPERATION_TIMEOUT: '交付预检超时',
});

class DeliveryPreflightHandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryPreflightHandlerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryPreflightHandlerError(code, message);
}

function exactRequest(raw) {
  try {
    const request = schema.assertPreflightRequest(raw);
    return Object.freeze({
      ...request,
      orderedFiles: Object.freeze(request.orderedFiles.map(item => Object.freeze({ ...item }))),
    });
  } catch (_) {
    fail('INVALID_DELIVERY_PREFLIGHT_REQUEST', '交付预检请求无效');
  }
}

function exactBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      !Number.isSafeInteger(raw.webContentsId) || raw.webContentsId < 0 ||
      typeof raw.projectInstanceId !== 'string' ||
      !Number.isSafeInteger(raw.ownerGeneration) || raw.ownerGeneration < 0 ||
      !Number.isSafeInteger(raw.mutationGeneration) || raw.mutationGeneration < 0 ||
      !Number.isSafeInteger(raw.navigationEpoch) || raw.navigationEpoch < 0) {
    fail('DELIVERY_BLOCKED', '交付预检 owner binding 不可用');
  }
  return Object.freeze({
    webContentsId: raw.webContentsId,
    projectInstanceId: raw.projectInstanceId,
    ownerGeneration: raw.ownerGeneration,
    mutationGeneration: raw.mutationGeneration,
    navigationEpoch: raw.navigationEpoch,
  });
}

function sameBinding(left, right) {
  return left.webContentsId === right.webContentsId &&
    left.projectInstanceId === right.projectInstanceId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.mutationGeneration === right.mutationGeneration &&
    left.navigationEpoch === right.navigationEpoch;
}

function timeoutError() {
  return new DeliveryPreflightHandlerError('LOCAL_OPERATION_TIMEOUT', '交付预检超时');
}

function withDeadline(task, state) {
  const remaining = state.deadlineAt - Date.now();
  if (remaining <= 0 || state.signal.aborted) return Promise.reject(timeoutError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      state.signal.abort();
      finish(reject, timeoutError());
    }, remaining);
    Promise.resolve().then(task).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function rethrowStable(error, fallbackCode = 'DELIVERY_BLOCKED', fallbackMessage = '交付预检 authority 不可用') {
  if (error && STABLE_ERROR_CODES.has(error.code)) {
    fail(error.code, STABLE_ERROR_MESSAGES[error.code] || '交付预检失败');
  }
  fail(fallbackCode, fallbackMessage);
}

function createDeliveryPreflightHandler(options = {}) {
  const {
    assertTrustedSender,
    captureBinding,
    settleAuthority,
    revokeDeliveryCapability,
    readSnapshot,
    readGraph,
    readSourceIndex,
    issueDeliveryCapability,
    createService,
    service = deliveryService.createDeliveryPreflightService({ issueDeliveryCapability }),
    deadlineMs = 120000,
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender, captureBinding, settleAuthority, revokeDeliveryCapability,
    readSnapshot, readGraph, readSourceIndex,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!service || typeof service.preflight !== 'function') {
    throw new TypeError('service.preflight is required');
  }
  if (createService !== undefined && typeof createService !== 'function') {
    throw new TypeError('createService must be a function when supplied');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 10 * 60 * 1000) {
    throw new TypeError('deadlineMs must be 1000..600000');
  }

  async function preflight(event, rawRequest) {
    try {
      assertTrustedSender(event);
    } catch (_) {
      fail('DELIVERY_BLOCKED', '交付预检 sender 不可信');
    }
    let request;
    try {
      request = exactRequest(rawRequest);
    } catch (_) {
      fail('DELIVERY_BLOCKED', '交付预检请求无效');
    }
    const initial = exactBinding(captureBinding(event));
    if (request.projectInstanceId !== initial.projectInstanceId) {
      fail('DELIVERY_STALE', '交付预检请求不属于当前项目');
    }

    const state = { deadlineAt: Date.now() + deadlineMs, signal: new AbortController() };
    try {
      await withDeadline(() => settleAuthority(Object.freeze({ event, request, binding: initial, signal: state.signal.signal })), state);
    } catch (error) {
      rethrowStable(error, 'DELIVERY_BLOCKED', '交付预检 watcher barrier 不可用');
    }
    const settled = exactBinding(captureBinding(event));
    if (settled.webContentsId !== initial.webContentsId || settled.projectInstanceId !== initial.projectInstanceId ||
        settled.ownerGeneration !== initial.ownerGeneration || settled.navigationEpoch !== initial.navigationEpoch) {
      fail('DELIVERY_STALE', '项目或窗口状态在 watcher barrier 后发生变化');
    }

    let snapshot;
    let graph;
    let sourceIndex;
    let disposeSnapshot = null;
    const releaseSnapshot = () => {
      if (!disposeSnapshot) return;
      const release = disposeSnapshot;
      disposeSnapshot = null;
      try { release(); } catch (_) { fail('DELIVERY_BLOCKED', '交付预检 snapshot 资源释放失败'); }
    };
    try {
      snapshot = await withDeadline(() => readSnapshot(Object.freeze({ request, binding: settled, signal: state.signal.signal })), state);
      disposeSnapshot = typeof snapshot?.disposeSnapshot === 'function' ? snapshot.disposeSnapshot : null;
      graph = await withDeadline(() => readGraph(Object.freeze({ request, binding: settled, signal: state.signal.signal })), state);
      sourceIndex = await withDeadline(() => readSourceIndex(Object.freeze({ request, binding: settled, signal: state.signal.signal })), state);
    } catch (error) {
      releaseSnapshot();
      rethrowStable(error);
    }

    const beforeRun = exactBinding(captureBinding(event));
    if (!sameBinding(settled, beforeRun)) {
      releaseSnapshot();
      fail('DELIVERY_STALE', '项目或窗口状态在预检期间发生变化');
    }
    let result;
    try {
      // Capability issuance is owner-bound. Main integrations may provide a
      // request-scoped service so the full settled binding (including
      // mutation/navigation generations) is captured without a mutable
      // cross-request closure. Existing pure callers keep the fixed service
      // path for backwards compatibility.
      const runService = createService
        ? createService(Object.freeze({ request, binding: beforeRun }))
        : service;
      if (!runService || typeof runService.preflight !== 'function') {
        fail('DELIVERY_BLOCKED', '交付预检 service 不可用');
      }
      result = runService.preflight({
        snapshot, graph, sourceIndex, request,
        ownerGeneration: beforeRun.ownerGeneration,
      });
    } catch (error) {
      releaseSnapshot();
      rethrowStable(error, 'DELIVERY_BLOCKED', '交付预检未能完成');
    }
    const afterRun = exactBinding(captureBinding(event));
    if (!sameBinding(beforeRun, afterRun)) {
      const capabilityId = result?.public?.exportCapabilityId || null;
      if (capabilityId !== null) {
        try {
          const revoked = await revokeDeliveryCapability(Object.freeze({
            capabilityId,
            projectInstanceId: request.projectInstanceId,
            ownerGeneration: beforeRun.ownerGeneration,
          }));
          if (revoked !== true) fail('DELIVERY_BLOCKED', '交付 capability 回收未确认');
        } catch (_) {
          releaseSnapshot();
          fail('DELIVERY_BLOCKED', '交付 capability 回收失败');
        }
      }
      releaseSnapshot();
      fail('DELIVERY_STALE', '项目或窗口状态在预检完成时发生变化');
    }
    const frozenResult = Object.freeze(result);
    releaseSnapshot();
    return frozenResult;
  }

  return Object.freeze({ preflight });
}

module.exports = Object.freeze({
  DeliveryPreflightHandlerError,
  exactRequest,
  exactBinding,
  sameBinding,
  createDeliveryPreflightHandler,
});
