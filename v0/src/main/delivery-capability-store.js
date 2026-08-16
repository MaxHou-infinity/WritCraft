'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');

const CAPABILITY_KIND = 'DELIVERY_EXPORT';
const CAPABILITY_TTL_MS = 10 * 60 * 1000;
const CAPABILITY_ID_RE = /^delivery_cap_[a-f0-9]{32}$/u;
const OWNER_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_RECORDS = 64;
const MAX_TOMBSTONES = MAX_RECORDS * 8;

class DeliveryCapabilityStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryCapabilityStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryCapabilityStoreError(code, message);
}

function exact(value, keys, field) {
  try {
    schema.assertExactKeys(value, keys, field);
  } catch (_) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 包含未知、缺失或非普通字段`);
  }
  return value;
}

function projectInstanceId(value, field = 'projectInstanceId') {
  try {
    schema.assertProjectInstanceId(value);
  } catch (_) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 无效`);
  }
  return value;
}

function ownerId(value, field = 'ownerId') {
  if (typeof value !== 'string' || !OWNER_ID_RE.test(value)) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 无效`);
  }
  return value;
}

function opaque(value, field) {
  try {
    schema.assertOpaqueId(value, field);
  } catch (_) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 无效`);
  }
  return value;
}

function digest(value, field) {
  try {
    schema.assertDigest(value, field);
  } catch (_) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 无效`);
  }
  return value;
}

function generation(value, field) {
  try {
    schema.assertSafeInteger(value, field, 0);
  } catch (_) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 无效`);
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail('INVALID_DELIVERY_CAPABILITY', `${field} 时间无效`);
  }
  return value;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    value.forEach(freeze);
  } else {
    Object.values(value).forEach(freeze);
  }
  return Object.freeze(value);
}

function normalizeBinding(raw) {
  const value = exact(raw, [
    'ownerId', 'projectInstanceId', 'ownerGeneration', 'mutationGeneration', 'navigationEpoch',
  ], 'delivery capability owner binding');
  return Object.freeze({
    ownerId: ownerId(value.ownerId),
    projectInstanceId: projectInstanceId(value.projectInstanceId),
    ownerGeneration: generation(value.ownerGeneration, 'ownerGeneration'),
    mutationGeneration: generation(value.mutationGeneration, 'mutationGeneration'),
    navigationEpoch: generation(value.navigationEpoch, 'navigationEpoch'),
  });
}

function normalizeIssue(raw) {
  const value = exact(raw, ['subjectId', 'authorityDigest', 'selectionDigest'], 'delivery capability issue');
  return Object.freeze({
    subjectId: opaque(value.subjectId, 'subjectId'),
    authorityDigest: digest(value.authorityDigest, 'authorityDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
  });
}

function normalizeConsume(raw) {
  const value = exact(raw, ['capabilityId', 'authorityDigest', 'selectionDigest'], 'delivery capability consume');
  return Object.freeze({
    capabilityId: opaque(value.capabilityId, 'capabilityId'),
    authorityDigest: digest(value.authorityDigest, 'authorityDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
  });
}

function normalizeCapabilityId(raw) {
  const value = exact(raw, ['capabilityId'], 'delivery capability revoke');
  opaque(value.capabilityId, 'capabilityId');
  if (!CAPABILITY_ID_RE.test(value.capabilityId)) fail('INVALID_DELIVERY_CAPABILITY', 'capabilityId 无效');
  return value.capabilityId;
}

function clockValue(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_DELIVERY_CAPABILITY', 'capability clock 无效');
  }
  return value;
}

function createDeliveryCapabilityStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const records = new Map();
  const tombstones = new Map();

  function remember(capabilityId, reason) {
    tombstones.set(capabilityId, reason);
    while (tombstones.size > MAX_TOMBSTONES) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  function remove(capabilityId, reason) {
    if (records.delete(capabilityId)) remember(capabilityId, reason);
  }

  function prune(nowMs = clockValue(clock)) {
    for (const entry of [...records.values()]) {
      if (nowMs >= entry.expiresAtMs) remove(entry.record.capabilityId, 'EXPIRED');
    }
    return records.size;
  }

  function allocateCapabilityId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let bytes;
      try { bytes = randomBytes(16); } catch (_) { bytes = null; }
      if (!Buffer.isBuffer(bytes) || bytes.length !== 16) continue;
      const capabilityId = `delivery_cap_${bytes.toString('hex')}`;
      // A tombstoned opaque id must never be reused. Reuse would turn a
      // previously consumed/revoked one-time capability back into a live
      // capability when a deterministic/test RNG (or an extraordinarily rare
      // real collision) returns the same bytes.
      if (CAPABILITY_ID_RE.test(capabilityId) &&
          !records.has(capabilityId) && !tombstones.has(capabilityId)) return capabilityId;
    }
    fail('DELIVERY_CAPABILITY_UNAVAILABLE', '无法分配交付 capability');
  }

  function ownerMatches(left, right) {
    return left.ownerId === right.ownerId &&
      left.projectInstanceId === right.projectInstanceId &&
      left.ownerGeneration === right.ownerGeneration &&
      left.mutationGeneration === right.mutationGeneration &&
      left.navigationEpoch === right.navigationEpoch;
  }

  function find(binding, capabilityId) {
    prune();
    const entry = records.get(capabilityId);
    if (entry) {
      if (!ownerMatches(entry.binding, binding)) fail('DELIVERY_CAPABILITY_STALE', 'delivery capability owner 已漂移');
      return entry;
    }
    const reason = tombstones.get(capabilityId);
    if (reason === 'EXPIRED') fail('DELIVERY_CAPABILITY_EXPIRED', 'delivery capability 已过期');
    if (reason) fail('DELIVERY_CAPABILITY_REPLAYED', 'delivery capability 已使用或撤销');
    fail('DELIVERY_CAPABILITY_NOT_FOUND', 'delivery capability 不存在');
  }

  function issue(rawBinding, rawIssue) {
    const binding = normalizeBinding(rawBinding);
    const issue = normalizeIssue(rawIssue);
    prune();
    while (records.size >= MAX_RECORDS) {
      const oldest = records.values().next().value;
      if (!oldest) break;
      remove(oldest.record.capabilityId, 'EVICTED');
    }
    const issuedAtMs = clockValue(clock);
    const expiresAtMs = issuedAtMs + CAPABILITY_TTL_MS;
    if (!Number.isSafeInteger(expiresAtMs)) fail('DELIVERY_CAPABILITY_UNAVAILABLE', 'delivery capability TTL 溢出');
    const capabilityId = allocateCapabilityId();
    const record = freeze({
      schema: schema.SCHEMAS.LOCAL_CAPABILITY,
      capabilityId,
      kind: CAPABILITY_KIND,
      projectInstanceId: binding.projectInstanceId,
      ownerGeneration: binding.ownerGeneration,
      subjectId: issue.subjectId,
      authorityDigest: issue.authorityDigest,
      selectionDigest: issue.selectionDigest,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      singleUse: true,
      consumedAt: null,
    });
    try { schema.assertExactKeys(record, schema.KEYS.CAPABILITY, 'delivery capability record'); }
    catch (_) { fail('INVALID_DELIVERY_CAPABILITY', 'delivery capability record schema 无效'); }
    records.set(capabilityId, { binding, record, expiresAtMs });
    return Object.freeze({ capabilityId, expiresAt: record.expiresAt });
  }

  function consume(rawBinding, rawRequest) {
    const binding = normalizeBinding(rawBinding);
    const request = normalizeConsume(rawRequest);
    const entry = find(binding, request.capabilityId);
    if (entry.record.authorityDigest !== request.authorityDigest ||
        entry.record.selectionDigest !== request.selectionDigest) {
      fail('DELIVERY_CAPABILITY_STALE', 'delivery capability authority 已漂移');
    }
    const consumedAtMs = clockValue(clock);
    const consumedAt = new Date(consumedAtMs).toISOString();
    // Consume before returning so every commit attempt is single-use, even if
    // the caller later fails while performing its external operation.
    entry.record = freeze({ ...entry.record, consumedAt });
    remove(request.capabilityId, 'CONSUMED');
    return Object.freeze({
      capabilityId: entry.record.capabilityId,
      projectInstanceId: entry.record.projectInstanceId,
      ownerGeneration: entry.record.ownerGeneration,
      subjectId: entry.record.subjectId,
      authorityDigest: entry.record.authorityDigest,
      selectionDigest: entry.record.selectionDigest,
      consumedAt,
    });
  }

  function revoke(rawBinding, rawRequest) {
    const binding = normalizeBinding(rawBinding);
    const capabilityId = normalizeCapabilityId(rawRequest);
    const entry = find(binding, capabilityId);
    remove(entry.record.capabilityId, 'REVOKED');
    return true;
  }

  function revokeProject(raw) {
    const value = exact(raw, ['projectInstanceId'], 'delivery capability project revoke');
    projectInstanceId(value.projectInstanceId);
    let count = 0;
    for (const entry of [...records.values()]) {
      if (entry.record.projectInstanceId === value.projectInstanceId) {
        remove(entry.record.capabilityId, 'PROJECT_REVOKED');
        count += 1;
      }
    }
    return count;
  }

  function inspect(raw) {
    const capabilityId = normalizeCapabilityId(raw);
    prune();
    const entry = records.get(capabilityId);
    return entry ? entry.record : null;
  }

  function stats() {
    prune();
    return Object.freeze({ active: records.size, tombstones: tombstones.size });
  }

  return Object.freeze({ issue, consume, revoke, revokeProject, inspect, prune, stats });
}

module.exports = Object.freeze({
  CAPABILITY_KIND,
  CAPABILITY_TTL_MS,
  CAPABILITY_ID_RE,
  MAX_RECORDS,
  DeliveryCapabilityStoreError,
  createDeliveryCapabilityStore,
});
