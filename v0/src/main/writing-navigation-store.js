'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  isAuthenticWritingNavigationRecord,
} = require('./writing-navigation-service');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RESULTS = 8;
const MAX_RECORD_BYTES = 256 * 1024;
const NAVIGATION_ID_RE = /^nav_[a-f0-9]{32}$/;
const ACTION_ID_RE = /^wna_[a-f0-9]{32}$/;
const ATTEMPT_ID_RE = /^wno_[a-f0-9]{32}$/;
const LEASE_ID_RE = /^wnl_[a-f0-9]{32}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const ACTIONS = new Set(['open', 'research', 'changes']);
const MAX_JSON_NODES = 4096;

class WritingNavigationStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingNavigationStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingNavigationStoreError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys, code = 'INVALID_NAVIGATION_RECORD') {
  if (!isPlainObject(value)) fail(code, '写作导航记录无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, '写作导航记录包含未知字段或缺少必填字段');
  }
}

function deepCloneFreeze(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (_) { fail('INVALID_NAVIGATION_RECORD', '写作导航记录不可序列化'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    fail('INVALID_NAVIGATION_RECORD', '写作导航记录超过安全上限');
  }
  let clone;
  try { clone = JSON.parse(serialized); }
  catch (_) { fail('INVALID_NAVIGATION_RECORD', '写作导航记录不可解析'); }
  const stack = [clone];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) continue;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) fail('INVALID_NAVIGATION_RECORD', '写作导航记录节点过多');
    for (const child of Object.values(item)) stack.push(child);
    Object.freeze(item);
  }
  return clone;
}

function ownerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) {
    fail('INVALID_OWNER', '写作导航 owner 无效');
  }
  return value;
}

function projectInstanceId(value) {
  if (typeof value !== 'string' || !PROJECT_INSTANCE_ID_RE.test(value)) {
    fail('INVALID_PROJECT', '项目实例标识无效');
  }
  return value;
}

function rootPath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_ROOT', '项目根目录无效');
  }
  return path.resolve(value);
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_GENERATION', '项目修改世代无效');
  return value;
}

function navigationId(value) {
  if (typeof value !== 'string' || !NAVIGATION_ID_RE.test(value)) {
    fail('INVALID_NAVIGATION_ID', '写作导航标识无效');
  }
  return value;
}

function randomId(prefix, randomBytes, occupied) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const value = `${prefix}${randomBytes(16).toString('hex')}`;
    if (!occupied.has(value)) return value;
  }
  fail('CAPABILITY_COLLISION', '无法分配唯一写作导航能力');
}

function validateRecord(raw) {
  if (!isAuthenticWritingNavigationRecord(raw)) {
    fail('INVALID_NAVIGATION_RECORD', '写作导航记录没有通过生成服务验证');
  }
  exactKeys(raw, ['schema', 'navigationId', 'mode', 'goal', 'edit', 'sources', 'result']);
  if (raw.schema !== 'writcraft.writing-navigation/v1' ||
      !['structure', 'navigation'].includes(raw.mode) ||
      raw.navigationId !== raw.result?.navigationId ||
      raw.mode !== raw.result?.mode) {
    fail('INVALID_NAVIGATION_RECORD', '写作导航记录协议不一致');
  }
  navigationId(raw.navigationId);
  if (!Array.isArray(raw.sources) || !isPlainObject(raw.edit) || !isPlainObject(raw.result)) {
    fail('INVALID_NAVIGATION_RECORD', '写作导航权威来源无效');
  }
  if (raw.mode === 'structure' && !Array.isArray(raw.result.alternatives)) {
    fail('INVALID_NAVIGATION_RECORD', '结构规划结果无效');
  }
  if (raw.mode === 'navigation') {
    if (!Array.isArray(raw.result.suggestions) || raw.result.suggestions.length < 1 ||
        raw.result.suggestions.length > 3) {
      fail('INVALID_NAVIGATION_RECORD', '写作导航建议无效');
    }
    const ids = new Set();
    for (const suggestion of raw.result.suggestions) {
      if (!isPlainObject(suggestion) || typeof suggestion.suggestionId !== 'string' ||
          ids.has(suggestion.suggestionId) || !ACTIONS.has(suggestion.action)) {
        fail('INVALID_NAVIGATION_RECORD', '写作导航建议标识或动作无效');
      }
      ids.add(suggestion.suggestionId);
    }
  }
  return deepCloneFreeze(raw);
}

function createWritingNavigationStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? Math.min(options.ttlMs, DEFAULT_TTL_MS)
    : DEFAULT_TTL_MS;
  const maxResults = Number.isSafeInteger(options.maxResults) && options.maxResults > 0
    ? Math.min(options.maxResults, DEFAULT_MAX_RESULTS)
    : DEFAULT_MAX_RESULTS;
  const results = new Map();
  const buckets = new Map();
  const actions = new Map();
  const leases = new Map();
  const occupiedIds = new Set();

  const bucketKey = binding => JSON.stringify([binding.ownerId, binding.projectInstanceId]);
  const resultKey = (binding, id) => JSON.stringify([
    binding.ownerId, binding.projectInstanceId, id,
  ]);

  function terminateAction(actionId) {
    const action = actions.get(actionId);
    if (!action) return;
    action.terminated = true;
    if (action.leaseId) {
      const lease = leases.get(action.leaseId);
      lease?.controller.abort();
      leases.delete(action.leaseId);
      occupiedIds.delete(action.leaseId);
      action.leaseId = null;
      action.attemptId = null;
    }
  }

  function revokeEntryActions(entry) {
    for (const actionId of entry.actionIds) {
      terminateAction(actionId);
      actions.delete(actionId);
      occupiedIds.delete(actionId);
    }
    entry.actionIds = [];
  }

  function unlinkResult(key, entry) {
    results.delete(key);
    const bucket = buckets.get(entry.bucketKey);
    bucket?.delete(entry.record.navigationId);
    if (bucket?.size === 0) buckets.delete(entry.bucketKey);
  }

  function deleteResult(key) {
    const entry = results.get(key);
    if (!entry) return;
    revokeEntryActions(entry);
    unlinkResult(key, entry);
  }

  function purgeExpired() {
    const now = clock();
    for (const [key, entry] of results) {
      if (now >= entry.expiresAt) deleteResult(key);
    }
  }

  function normalizeBinding(raw, keys) {
    exactKeys(raw, keys, 'INVALID_NAVIGATION_REQUEST');
    return {
      ownerId: ownerId(raw.ownerId),
      projectInstanceId: projectInstanceId(raw.projectInstanceId),
      rootPath: rootPath(raw.rootPath),
      mutationGeneration: generation(raw.mutationGeneration),
      navigationEpoch: generation(raw.navigationEpoch),
    };
  }

  function requireEntry(id, binding) {
    purgeExpired();
    const entry = results.get(resultKey(binding, navigationId(id)));
    if (!entry || entry.parked) fail('NAVIGATION_NOT_FOUND', '写作导航已过期或不存在');
    if (entry.rootPath !== binding.rootPath ||
        entry.mutationGeneration !== binding.mutationGeneration ||
        entry.navigationEpoch !== binding.navigationEpoch) {
      fail('STALE_NAVIGATION', '写作导航已因项目状态变化失效');
    }
    return entry;
  }

  function prepareActions(entry, key) {
    const actionIds = [];
    const actionBySuggestion = new Map();
    const preparedActions = new Map();
    const reservedIds = new Set(occupiedIds);
    if (entry.record.mode === 'navigation') {
      for (const suggestion of entry.record.result.suggestions) {
        const suggestionActions = {};
        for (const actionName of ['research', 'changes']) {
          const actionId = randomId('wna_', randomBytes, reservedIds);
          reservedIds.add(actionId);
          actionIds.push(actionId);
          suggestionActions[actionName] = actionId;
          preparedActions.set(actionId, {
            resultKey: key,
            ownerId: entry.ownerId,
            projectInstanceId: entry.projectInstanceId,
            suggestionId: suggestion.suggestionId,
            action: actionName,
            terminated: false,
            leaseId: null,
            attemptId: null,
          });
        }
        actionBySuggestion.set(suggestion.suggestionId, suggestionActions);
      }
    }
    const result = deepCloneFreeze({
      ...entry.record.result,
      ...(entry.record.mode === 'navigation' ? {
        suggestions: entry.record.result.suggestions.map(suggestion => {
          const minted = actionBySuggestion.get(suggestion.suggestionId);
          return {
            ...suggestion,
            // Compatibility-only alias: fixed to Changes so the model's legacy
            // action hint never controls a public capability.
            actionId: minted.changes,
            actionIds: minted,
          };
        }),
      } : {}),
    });
    return { actionIds, preparedActions, result };
  }

  function commitPreparedActions(entry, prepared) {
    entry.actionIds = prepared.actionIds;
    entry.result = prepared.result;
    for (const [actionId, action] of prepared.preparedActions) {
      occupiedIds.add(actionId);
      actions.set(actionId, action);
    }
  }

  function install(raw) {
    const binding = normalizeBinding(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration', 'navigationEpoch', 'record',
    ]);
    const record = validateRecord(raw.record);
    purgeExpired();
    const key = resultKey(binding, record.navigationId);
    if (results.has(key)) fail('NAVIGATION_COLLISION', '写作导航结果发生冲突');
    const ownerBucketKey = bucketKey(binding);
    let bucket = buckets.get(ownerBucketKey);
    if (!bucket) {
      bucket = new Map();
      buckets.set(ownerBucketKey, bucket);
    }
    const createdAt = clock();
    const entry = {
      ...binding,
      record,
      result: record.result,
      actionIds: [],
      bucketKey: ownerBucketKey,
      createdAt,
      expiresAt: createdAt + ttlMs,
      parked: false,
    };
    commitPreparedActions(entry, prepareActions(entry, key));
    results.set(key, entry);
    bucket.set(record.navigationId, key);
    while (results.size > maxResults) deleteResult(results.keys().next().value);
    return entry.result;
  }

  function get(raw) {
    const binding = normalizeBinding(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration', 'navigationEpoch', 'navigationId',
    ]);
    return requireEntry(raw.navigationId, binding).result;
  }

  function acquireAction(raw) {
    const binding = normalizeBinding(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
      'navigationEpoch', 'actionId', 'attemptId',
    ]);
    if (typeof raw.actionId !== 'string' || !ACTION_ID_RE.test(raw.actionId)) {
      fail('INVALID_ACTION', '写作导航动作无效');
    }
    if (typeof raw.attemptId !== 'string' || !ATTEMPT_ID_RE.test(raw.attemptId)) {
      fail('INVALID_ATTEMPT', '写作导航执行轮次无效');
    }
    purgeExpired();
    const action = actions.get(raw.actionId);
    if (!action || action.terminated) fail('ACTION_NOT_FOUND', '写作导航动作已过期或已使用');
    if (action.ownerId !== binding.ownerId || action.projectInstanceId !== binding.projectInstanceId) {
      fail('ACTION_NOT_FOUND', '写作导航动作已过期或已使用');
    }
    const entry = results.get(action.resultKey);
    if (!entry || entry.parked) fail('ACTION_NOT_FOUND', '写作导航动作已过期或已使用');
    if (entry.rootPath !== binding.rootPath ||
        entry.mutationGeneration !== binding.mutationGeneration ||
        entry.navigationEpoch !== binding.navigationEpoch) {
      terminateAction(raw.actionId);
      fail('STALE_NAVIGATION', '写作导航已因项目状态变化失效');
    }
    if (action.leaseId) {
      if (['open', 'research'].includes(action.action)) {
        fail('ACTION_BUSY', action.action === 'research'
          ? '正在打开这条建议的来源面板，请稍候'
          : '正在打开这条写作导航建议，请稍候');
      }
      terminateAction(raw.actionId);
      fail('ACTION_REPLAYED', '写作导航动作已在处理中');
    }
    const suggestion = entry.record.result.suggestions.find(
      item => item.suggestionId === action.suggestionId
    );
    if (!suggestion || !['research', 'changes'].includes(action.action)) {
      action.terminated = true;
      fail('INVALID_NAVIGATION_RECORD', '写作导航动作与权威建议不一致');
    }
    const leaseId = randomId('wnl_', randomBytes, occupiedIds);
    const controller = new AbortController();
    occupiedIds.add(leaseId);
    action.leaseId = leaseId;
    action.attemptId = raw.attemptId;
    leases.set(leaseId, {
      actionId: raw.actionId,
      resultKey: action.resultKey,
      controller,
      expiresAt: entry.expiresAt,
    });
    const authority = deepCloneFreeze({
      leaseId,
      repeatable: ['open', 'research'].includes(action.action),
      navigationId: entry.record.navigationId,
      suggestion: { ...suggestion, action: action.action },
      record: entry.record,
    });
    return Object.freeze({ ...authority, signal: controller.signal });
  }

  function requireLease(raw, keys) {
    const binding = normalizeBinding(raw, keys);
    if (typeof raw.leaseId !== 'string' || !LEASE_ID_RE.test(raw.leaseId)) {
      fail('INVALID_ACTION_SETTLEMENT', '写作导航动作租约无效');
    }
    purgeExpired();
    const lease = leases.get(raw.leaseId);
    const action = lease ? actions.get(lease.actionId) : null;
    if (!lease || !action || action.leaseId !== raw.leaseId) {
      fail('LEASE_NOT_FOUND', '写作导航动作租约不存在或已过期');
    }
    if (action.ownerId !== binding.ownerId || action.projectInstanceId !== binding.projectInstanceId) {
      fail('LEASE_NOT_FOUND', '写作导航动作租约不存在或已过期');
    }
    const entry = results.get(lease.resultKey);
    if (!entry || entry.rootPath !== binding.rootPath ||
        entry.mutationGeneration !== binding.mutationGeneration ||
        entry.navigationEpoch !== binding.navigationEpoch) {
      terminateAction(lease.actionId);
      fail('STALE_NAVIGATION', '写作导航动作已因项目状态变化失效');
    }
    if (lease.controller.signal.aborted || clock() >= lease.expiresAt) {
      terminateAction(lease.actionId);
      fail('LEASE_NOT_FOUND', '写作导航动作租约不存在或已过期');
    }
    return { binding, lease, action, entry };
  }

  function assertLeaseCurrent(raw) {
    const current = requireLease(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration', 'navigationEpoch', 'leaseId',
    ]);
    return Object.freeze({
      leaseId: raw.leaseId,
      action: current.action.action,
      suggestionId: current.action.suggestionId,
      navigationId: current.entry.record.navigationId,
    });
  }

  function settleAction(raw) {
    exactKeys(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
      'navigationEpoch', 'leaseId', 'outcome',
    ], 'INVALID_ACTION_SETTLEMENT');
    if (![
      'success', 'review_in_progress', 'retryable_failure', 'cancelled', 'failed', 'stale',
    ].includes(raw.outcome)) {
      fail('INVALID_ACTION_SETTLEMENT', '写作导航动作结算无效');
    }
    const { lease, action } = requireLease(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
      'navigationEpoch', 'leaseId', 'outcome',
    ]);
    leases.delete(raw.leaseId);
    occupiedIds.delete(raw.leaseId);
    lease.controller.abort();
    action.leaseId = null;
    action.attemptId = null;
    const reviewBlocked = raw.outcome === 'review_in_progress' && action.action === 'changes';
    if (raw.outcome === 'review_in_progress' && action.action !== 'changes') {
      action.terminated = true;
      fail('INVALID_ACTION_SETTLEMENT', '只有 Changes 动作可以保留待审重试能力');
    }
    const retryable = ['retryable_failure', 'cancelled'].includes(raw.outcome);
    if (!reviewBlocked && !retryable && !['open', 'research'].includes(action.action)) {
      action.terminated = true;
    }
    if (raw.outcome === 'stale') action.terminated = true;
    return Object.freeze({
      actionId: lease.actionId,
      action: action.action,
      consumed: action.terminated,
    });
  }

  function cancelAction(raw) {
    const binding = normalizeBinding(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
      'navigationEpoch', 'actionId', 'attemptId',
    ]);
    if (typeof raw.actionId !== 'string' || !ACTION_ID_RE.test(raw.actionId)) {
      fail('INVALID_ACTION', '写作导航动作无效');
    }
    if (typeof raw.attemptId !== 'string' || !ATTEMPT_ID_RE.test(raw.attemptId)) {
      fail('INVALID_ATTEMPT', '写作导航执行轮次无效');
    }
    purgeExpired();
    const action = actions.get(raw.actionId);
    if (!action || action.terminated ||
        action.ownerId !== binding.ownerId ||
        action.projectInstanceId !== binding.projectInstanceId) {
      fail('ACTION_NOT_FOUND', '写作导航动作已过期或不存在');
    }
    const entry = results.get(action.resultKey);
    if (!entry || entry.rootPath !== binding.rootPath ||
        entry.mutationGeneration !== binding.mutationGeneration ||
        entry.navigationEpoch !== binding.navigationEpoch) {
      terminateAction(raw.actionId);
      fail('STALE_NAVIGATION', '写作导航已因项目状态变化失效');
    }
    if (!action.leaseId || action.attemptId !== raw.attemptId) {
      fail('ATTEMPT_NOT_ACTIVE', '这一轮写作导航动作当前没有正在运行');
    }
    const leaseId = action.leaseId;
    const lease = leases.get(leaseId);
    lease?.controller.abort();
    leases.delete(leaseId);
    occupiedIds.delete(leaseId);
    action.leaseId = null;
    action.attemptId = null;
    return Object.freeze({ actionId: raw.actionId, cancelled: true });
  }

  function invalidateProject(raw) {
    exactKeys(raw, ['ownerId', 'projectInstanceId'], 'INVALID_NAVIGATION_REQUEST');
    const owner = ownerId(raw.ownerId);
    const project = projectInstanceId(raw.projectInstanceId);
    let count = 0;
    for (const [key, entry] of [...results]) {
      if (entry.ownerId === owner && entry.projectInstanceId === project) {
        deleteResult(key);
        count += 1;
      }
    }
    return count;
  }

  function parkProject(raw) {
    exactKeys(raw, ['ownerId', 'projectInstanceId'], 'INVALID_NAVIGATION_REQUEST');
    const owner = ownerId(raw.ownerId);
    const project = projectInstanceId(raw.projectInstanceId);
    purgeExpired();
    let count = 0;
    for (const entry of results.values()) {
      if (entry.ownerId !== owner || entry.projectInstanceId !== project || entry.parked) continue;
      revokeEntryActions(entry);
      entry.parked = true;
      count += 1;
    }
    return count;
  }

  function peekRestorable(rawOwnerId, rawRootPath) {
    const owner = ownerId(rawOwnerId);
    const root = rootPath(rawRootPath);
    purgeExpired();
    let latest = null;
    for (const entry of results.values()) {
      if (!entry.parked || entry.ownerId !== owner || entry.rootPath !== root) continue;
      if (!latest || entry.createdAt >= latest.createdAt) latest = entry;
    }
    return latest ? latest.record : null;
  }

  function restoreLatest(raw) {
    const binding = normalizeBinding(raw, [
      'ownerId', 'projectInstanceId', 'rootPath', 'mutationGeneration', 'navigationEpoch',
      'navigationId',
    ]);
    const selectedNavigationId = navigationId(raw.navigationId);
    purgeExpired();
    let oldKey;
    let entry;
    for (const [key, candidate] of results) {
      if (!candidate.parked || candidate.ownerId !== binding.ownerId ||
          candidate.rootPath !== binding.rootPath ||
          candidate.record.navigationId !== selectedNavigationId) continue;
      oldKey = key;
      entry = candidate;
      break;
    }
    if (!entry) return null;
    const key = resultKey(binding, entry.record.navigationId);
    if (key !== oldKey && results.has(key)) {
      fail('NAVIGATION_COLLISION', '写作导航结果发生冲突');
    }
    const ownerBucketKey = bucketKey(binding);
    const restoredEntry = Object.assign({}, entry, binding, {
      bucketKey: ownerBucketKey,
      parked: false,
    });
    const prepared = prepareActions(restoredEntry, key);
    unlinkResult(oldKey, entry);
    let bucket = buckets.get(ownerBucketKey);
    if (!bucket) {
      bucket = new Map();
      buckets.set(ownerBucketKey, bucket);
    }
    commitPreparedActions(restoredEntry, prepared);
    results.set(key, restoredEntry);
    bucket.set(restoredEntry.record.navigationId, key);
    return restoredEntry.result;
  }

  function stats() {
    purgeExpired();
    return Object.freeze({ results: results.size, actions: actions.size, leases: leases.size });
  }

  return Object.freeze({
    install,
    get,
    acquireAction,
    assertLeaseCurrent,
    settleAction,
    cancelAction,
    parkProject,
    peekRestorable,
    restoreLatest,
    invalidateProject,
    stats,
  });
}

module.exports = Object.freeze({
  DEFAULT_TTL_MS,
  DEFAULT_MAX_RESULTS,
  MAX_RECORD_BYTES,
  WritingNavigationStoreError,
  createWritingNavigationStore,
});
