'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ACK_TTL_MS = 30 * 1000;
const DEFAULT_MAX_RECORDS = 8;
const REWRITE_ID_RE = /^ir_[a-f0-9]{32}$/;
const CAPABILITY_ID_RE = /^irc_[a-f0-9]{32}$/;
const APPLY_LEASE_ID_RE = /^iral_[a-f0-9]{32}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const LIVE_STATES = new Set(['GENERATING', 'REVIEW_PENDING_ACK', 'REVIEW', 'APPLYING']);
const PRE_APPLY_STATES = new Set(['GENERATING', 'REVIEW_PENDING_ACK', 'REVIEW']);

class InlineRewriteCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InlineRewriteCapabilityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new InlineRewriteCapabilityError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function cloneFreeze(value) {
  let clone;
  try { clone = JSON.parse(JSON.stringify(value)); }
  catch (_) { fail('INVALID_INLINE_REWRITE', 'Inline Rewrite record 不可序列化'); }
  const freeze = item => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    Object.values(item).forEach(freeze);
    return Object.freeze(item);
  };
  return freeze(clone);
}

function validateBinding(binding) {
  if (!isPlainObject(binding) || !PROJECT_INSTANCE_ID_RE.test(binding.projectInstanceId || '') ||
      typeof binding.rootPath !== 'string' || !binding.rootPath || typeof binding.ownerId !== 'string' ||
      !binding.ownerId || !Number.isSafeInteger(binding.navigationEpoch) || binding.navigationEpoch < 0) {
    fail('INVALID_INLINE_REWRITE', 'Inline Rewrite owner/project 绑定无效');
  }
  return binding;
}

function validateAckPayload(payload) {
  if (!exactKeys(payload, ['schema', 'rewriteId', 'capabilityId']) ||
      payload.schema !== 'writcraft.inline-rewrite-ack/v1' ||
      !REWRITE_ID_RE.test(payload.rewriteId || '') || !CAPABILITY_ID_RE.test(payload.capabilityId || '')) {
    fail('INVALID_INLINE_REWRITE', 'Inline Rewrite ACK 参数无效');
  }
  return payload;
}

function validateApplyPayload(payload) {
  if (!exactKeys(payload, ['schema', 'rewriteId', 'capabilityId']) ||
      Buffer.byteLength(JSON.stringify(payload), 'utf8') > 8 * 1024 ||
      payload.schema !== 'writcraft.inline-rewrite-apply/v1' ||
      !REWRITE_ID_RE.test(payload.rewriteId || '') || !CAPABILITY_ID_RE.test(payload.capabilityId || '')) {
    fail('INVALID_INLINE_REWRITE', 'Inline Rewrite apply 参数无效');
  }
  return payload;
}

function validateDiscardPayload(payload) {
  if (!exactKeys(payload, ['schema', 'rewriteId', 'capabilityId']) ||
      payload.schema !== 'writcraft.inline-rewrite-discard/v1' ||
      !((payload.rewriteId === null && payload.capabilityId === null) ||
        (REWRITE_ID_RE.test(payload.rewriteId || '') && CAPABILITY_ID_RE.test(payload.capabilityId || '')))) {
    fail('INVALID_INLINE_REWRITE', 'Inline Rewrite discard 参数无效');
  }
  return payload;
}

function createInlineRewriteCapabilityStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const rewriteIdFactory = typeof options.rewriteIdFactory === 'function' ? options.rewriteIdFactory : null;
  const capabilityIdFactory = typeof options.capabilityIdFactory === 'function' ? options.capabilityIdFactory : null;
  const applyLeaseIdFactory = typeof options.applyLeaseIdFactory === 'function' ? options.applyLeaseIdFactory : null;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? Math.min(options.ttlMs, DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  const ackTtlMs = Number.isSafeInteger(options.ackTtlMs) && options.ackTtlMs > 0
    ? Math.min(options.ackTtlMs, DEFAULT_ACK_TTL_MS) : DEFAULT_ACK_TTL_MS;
  const maxRecords = Number.isSafeInteger(options.maxRecords) && options.maxRecords > 0
    ? Math.min(options.maxRecords, DEFAULT_MAX_RECORDS) : DEFAULT_MAX_RECORDS;
  const records = new Map();
  const byCapability = new Map();
  const activeByOwner = new Map();
  const rewriteTombstones = new Map();
  const capabilityTombstones = new Set();
  const leaseIds = new Set();

  function allocatedId(factory, prefix, pattern, occupied) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = factory ? factory() : `${prefix}${crypto.randomBytes(16).toString('hex')}`;
      if (pattern.test(String(value || '')) && !occupied.has(value)) return value;
    }
    fail('INLINE_REWRITE_BUSY', '无法分配唯一 Inline Rewrite 标识');
  }

  function touch(record) {
    records.delete(record.rewriteId);
    records.set(record.rewriteId, record);
  }

  function clearAckTimer(record) {
    if (record.ackTimer) clearTimer(record.ackTimer);
    record.ackTimer = null;
  }

  function revokeRecord(record, terminalState) {
    clearAckTimer(record);
    if (record.controller) record.controller.abort();
    if (record.capabilityId) {
      byCapability.delete(record.capabilityId);
      capabilityTombstones.add(record.capabilityId);
    }
    if (record.applyLeaseId) leaseIds.delete(record.applyLeaseId);
    records.delete(record.rewriteId);
    if (activeByOwner.get(record.ownerId) === record.rewriteId) activeByOwner.delete(record.ownerId);
    rewriteTombstones.set(record.rewriteId, terminalState);
    while (rewriteTombstones.size > DEFAULT_MAX_RECORDS * 8) rewriteTombstones.delete(rewriteTombstones.keys().next().value);
    while (capabilityTombstones.size > DEFAULT_MAX_RECORDS * 8) capabilityTombstones.delete(capabilityTombstones.values().next().value);
  }

  function prune() {
    const now = clock();
    for (const record of [...records.values()]) {
      if (record.state !== 'APPLYING' && now >= record.expiresAt) revokeRecord(record, 'EXPIRED');
    }
  }

  function assertAssociation(binding, rewriteId, capabilityId, allowedStates) {
    validateBinding(binding);
    prune();
    if (!REWRITE_ID_RE.test(String(rewriteId || '')) || !CAPABILITY_ID_RE.test(String(capabilityId || ''))) {
      fail('INVALID_INLINE_REWRITE', 'Inline Rewrite 标识无效');
    }
    const record = records.get(rewriteId);
    if (!record) {
      const terminal = rewriteTombstones.get(rewriteId);
      if (terminal === 'EXPIRED') fail('INLINE_REWRITE_EXPIRED', 'Inline Rewrite 已过期');
      if (terminal === 'ACK_TIMEOUT') fail('INLINE_REWRITE_ACK_TIMEOUT', 'Inline Rewrite 预览确认超时');
      if (terminal || capabilityTombstones.has(capabilityId)) fail('INLINE_REWRITE_REPLAYED', 'Inline Rewrite 能力已使用或失效');
      fail('INLINE_REWRITE_NOT_FOUND', 'Inline Rewrite 不存在');
    }
    if (record.state === 'APPLYING' && capabilityTombstones.has(capabilityId)) {
      fail('INLINE_REWRITE_REPLAYED', 'Inline Rewrite apply 能力已烧毁');
    }
    // Association is checked before any capability mutation. A foreign ID
    // pair can therefore never burn the legitimate record.
    if (record.capabilityId !== capabilityId || byCapability.get(capabilityId) !== rewriteId ||
        record.projectInstanceId !== binding.projectInstanceId || record.rootPath !== binding.rootPath ||
        record.ownerId !== binding.ownerId || record.navigationEpoch !== binding.navigationEpoch) {
      fail('INLINE_REWRITE_NOT_FOUND', 'Inline Rewrite 不属于当前项目或页面');
    }
    if (!allowedStates.has(record.state)) {
      if (record.state === 'REVIEW_PENDING_ACK') fail('INLINE_REWRITE_NOT_ACKNOWLEDGED', 'Inline Rewrite 预览尚未确认');
      fail('INLINE_REWRITE_BUSY', 'Inline Rewrite 当前状态不可执行该操作');
    }
    if (clock() >= record.expiresAt) {
      revokeRecord(record, 'EXPIRED');
      fail('INLINE_REWRITE_EXPIRED', 'Inline Rewrite 已过期');
    }
    touch(record);
    return record;
  }

  function makeReviewResult(record) {
    const result = {
      ok: true,
      schema: 'writcraft.inline-rewrite-review/v1',
      outcome: 'review',
      rewriteId: record.rewriteId,
      capabilityId: record.capabilityId,
      expiresAt: record.expiresAt,
      replacement: record.proposal.replacement,
      summary: record.proposal.summary,
      contextManifest: record.proposal.contextManifest,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 96 * 1024) {
      revokeRecord(record, 'FAILED');
      fail('INLINE_REWRITE_TOO_LARGE', 'Inline Rewrite review 超过 96 KiB');
    }
    return cloneFreeze(result);
  }

  function boundedPublicResult(result, record = null) {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 96 * 1024) {
      if (record) revokeRecord(record, 'FAILED');
      fail('INLINE_REWRITE_TOO_LARGE', 'Inline Rewrite review 超过 96 KiB');
    }
    return cloneFreeze(result);
  }

  function beginGeneration(binding) {
    validateBinding(binding);
    prune();
    const previous = records.get(activeByOwner.get(binding.ownerId));
    if (previous) {
      if (previous.state === 'APPLYING') fail('INLINE_REWRITE_BUSY', 'Inline Rewrite 正在应用');
      revokeRecord(previous, 'CANCELED');
    }
    while (records.size >= maxRecords) {
      const candidate = [...records.values()].find(record =>
        record.ownerId !== binding.ownerId && record.state !== 'APPLYING');
      if (!candidate) fail('INLINE_REWRITE_BUSY', '所有 Inline Rewrite 槽位都在应用');
      revokeRecord(candidate, 'EVICTED');
    }
    const rewriteId = allocatedId(rewriteIdFactory, 'ir_', REWRITE_ID_RE, {
      has(value) { return records.has(value) || rewriteTombstones.has(value); },
    });
    const controller = new AbortController();
    const record = {
      rewriteId,
      capabilityId: null,
      projectInstanceId: binding.projectInstanceId,
      rootPath: binding.rootPath,
      ownerId: binding.ownerId,
      navigationEpoch: binding.navigationEpoch,
      state: 'GENERATING',
      controller,
      proposal: null,
      expiresAt: clock() + ttlMs,
      ackTimer: null,
      ackDeadline: null,
      applyLeaseId: null,
    };
    records.set(rewriteId, record);
    activeByOwner.set(binding.ownerId, rewriteId);
    return Object.freeze({ rewriteId, expiresAt: record.expiresAt, signal: controller.signal });
  }

  function completeGeneration(rewriteId, proposal) {
    prune();
    const record = records.get(rewriteId);
    if (!record || record.state !== 'GENERATING') fail('INLINE_REWRITE_NOT_FOUND', 'Inline Rewrite 生成已失效');
    const commonValid = isPlainObject(proposal) && proposal.rewriteId === rewriteId &&
      ['review', 'no_op'].includes(proposal.outcome) && typeof proposal.replacement === 'string' &&
      typeof proposal.summary === 'string' && isPlainObject(proposal.contextManifest) &&
      proposal.contextManifest.schema === 'writcraft.context-manifest/v1';
    const expectedKeys = proposal?.outcome === 'review'
      ? ['outcome', 'rewriteId', 'replacement', 'summary', 'contextManifest', 'dependencies', 'provenance', 'changeSet', 'afterContent', 'replacementEndOffset']
      : ['outcome', 'rewriteId', 'replacement', 'summary', 'contextManifest', 'provenance'];
    if (!commonValid || !exactKeys(proposal, expectedKeys)) {
      revokeRecord(record, 'FAILED');
      fail('INVALID_INLINE_REWRITE', 'Inline Rewrite proposal 无效');
    }
    if (proposal.outcome === 'no_op') {
      const result = boundedPublicResult({
        ok: true, schema: 'writcraft.inline-rewrite-review/v1', outcome: 'no_op',
        rewriteId, capabilityId: null, expiresAt: null,
        replacement: proposal.replacement, summary: proposal.summary,
        contextManifest: proposal.contextManifest,
      }, record);
      revokeRecord(record, 'NO_OP');
      return result;
    }
    const capabilityId = allocatedId(capabilityIdFactory, 'irc_', CAPABILITY_ID_RE, {
      has(value) { return byCapability.has(value) || capabilityTombstones.has(value); },
    });
    record.proposal = proposal;
    record.capabilityId = capabilityId;
    byCapability.set(capabilityId, rewriteId);
    record.state = 'REVIEW_PENDING_ACK';
    record.ackDeadline = clock() + ackTtlMs;
    record.ackTimer = setTimer(() => {
      if (record.state === 'REVIEW_PENDING_ACK' && record.capabilityId === capabilityId &&
          clock() >= record.ackDeadline) {
        revokeRecord(record, 'ACK_TIMEOUT');
      }
    }, ackTtlMs);
    return makeReviewResult(record);
  }

  function failGeneration(rewriteId, terminalState = 'FAILED') {
    const record = records.get(rewriteId);
    if (record?.state === 'GENERATING') revokeRecord(record, terminalState);
  }

  function acknowledge(binding, payload) {
    validateAckPayload(payload);
    const record = assertAssociation(binding, payload.rewriteId, payload.capabilityId, new Set(['REVIEW_PENDING_ACK']));
    if (!Number.isSafeInteger(record.ackDeadline) || clock() >= record.ackDeadline) {
      revokeRecord(record, 'ACK_TIMEOUT');
      fail('INLINE_REWRITE_ACK_TIMEOUT', 'Inline Rewrite 预览确认超时');
    }
    clearAckTimer(record);
    record.ackDeadline = null;
    record.state = 'REVIEW';
    return { ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review' };
  }

  function discard(binding, payload) {
    validateBinding(binding);
    validateDiscardPayload(payload);
    if (payload.rewriteId === null) {
      const record = records.get(activeByOwner.get(binding.ownerId));
      if (!record || record.state !== 'GENERATING' || record.projectInstanceId !== binding.projectInstanceId ||
          record.rootPath !== binding.rootPath || record.navigationEpoch !== binding.navigationEpoch) {
        fail('INLINE_REWRITE_NOT_FOUND', '没有可取消的 Inline Rewrite 生成');
      }
      revokeRecord(record, 'CANCELED');
    } else {
      const record = assertAssociation(binding, payload.rewriteId, payload.capabilityId, PRE_APPLY_STATES);
      revokeRecord(record, 'DISCARDED');
    }
    return { ok: true, schema: 'writcraft.inline-rewrite-discard-result/v1', status: 'discarded' };
  }

  function beginApply(binding, payload, persistApplyingMarker) {
    validateApplyPayload(payload);
    if (typeof persistApplyingMarker !== 'function') fail('INVALID_INLINE_REWRITE', 'Inline Rewrite marker 服务不可用');
    const record = assertAssociation(binding, payload.rewriteId, payload.capabilityId, new Set(['REVIEW']));
    // Marker persistence occurs after full association, but before capability
    // burn and APPLYING. A marker failure leaves REVIEW intact and writable
    // content untouched.
    let applyLeaseId;
    try {
      applyLeaseId = allocatedId(applyLeaseIdFactory, 'iral_', APPLY_LEASE_ID_RE, leaseIds);
    } catch (error) {
      revokeRecord(record, 'FAILED');
      throw error;
    }
    leaseIds.add(applyLeaseId);
    try {
      persistApplyingMarker(record.proposal, record);
    } catch (error) {
      leaseIds.delete(applyLeaseId);
      revokeRecord(record, 'FAILED');
      fail('INLINE_REWRITE_WRITE_FAILED', '无法持久化 Inline Rewrite 恢复标记');
    }
    byCapability.delete(record.capabilityId);
    capabilityTombstones.add(record.capabilityId);
    record.capabilityId = null;
    record.applyLeaseId = applyLeaseId;
    record.state = 'APPLYING';
    record.controller = null;
    return Object.freeze({
      rewriteId: record.rewriteId,
      applyLeaseId,
      expiresAt: record.expiresAt,
      proposal: record.proposal,
    });
  }

  function finishApply(rewriteId, applyLeaseId, terminalState = 'APPLIED') {
    const record = records.get(rewriteId);
    if (!record || record.state !== 'APPLYING' || record.applyLeaseId !== applyLeaseId) {
      fail('INLINE_REWRITE_REPLAYED', 'Inline Rewrite apply 租约已失效');
    }
    leaseIds.delete(applyLeaseId);
    record.applyLeaseId = null;
    revokeRecord(record, terminalState);
    return true;
  }

  function clearOwner(ownerId, navigationEpoch = null) {
    for (const record of [...records.values()]) {
      if (record.ownerId === ownerId && record.state !== 'APPLYING' &&
          (navigationEpoch === null || record.navigationEpoch === navigationEpoch)) {
        revokeRecord(record, 'CANCELED');
      }
    }
  }

  function inspect(rewriteId) {
    prune();
    const record = records.get(rewriteId);
    return record ? Object.freeze({
      state: record.state,
      capabilityId: record.capabilityId,
      expiresAt: record.expiresAt,
      ownerId: record.ownerId,
    }) : null;
  }

  return Object.freeze({
    beginGeneration,
    completeGeneration,
    failGeneration,
    acknowledge,
    discard,
    beginApply,
    finishApply,
    clearOwner,
    prune,
    inspect,
    get size() { prune(); return records.size; },
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_ACK_TTL_MS,
  DEFAULT_MAX_RECORDS,
  REWRITE_ID_RE,
  CAPABILITY_ID_RE,
  APPLY_LEASE_ID_RE,
  InlineRewriteCapabilityError,
  validateAckPayload,
  validateApplyPayload,
  validateDiscardPayload,
  createInlineRewriteCapabilityStore,
};
