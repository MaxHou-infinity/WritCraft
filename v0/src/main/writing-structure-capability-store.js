'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  isAuthenticWritingStructurePreparedRecord,
} = require('./writing-structure-service');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CAPABILITY_ID_RE = /^wsc_[a-f0-9]{32}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const NAVIGATION_ID_RE = /^nav_[a-f0-9]{32}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;

class WritingStructureCapabilityStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingStructureCapabilityStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingStructureCapabilityStoreError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys, code = 'INVALID_STRUCTURE_CAPABILITY') {
  if (!isPlainObject(value)) fail(code, '结构确认能力请求无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, '结构确认能力请求包含未知字段或缺少必填字段');
  }
}

function validateOwner(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) {
    fail('INVALID_OWNER', '结构确认 owner 无效');
  }
  return value;
}

function validateProject(value) {
  if (typeof value !== 'string' || !PROJECT_INSTANCE_ID_RE.test(value)) {
    fail('INVALID_PROJECT', '项目实例标识无效');
  }
  return value;
}

function validateRoot(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_ROOT', '项目根目录无效');
  }
  return path.resolve(value);
}

function validateGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_STRUCTURE_CAPABILITY', '结构确认世代无效');
  }
  return value;
}

function validateDigest(value) {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) {
    fail('INVALID_STRUCTURE_CAPABILITY', '结构确认摘要无效');
  }
  return value;
}

function validateNavigationId(value) {
  if (typeof value !== 'string' || !NAVIGATION_ID_RE.test(value)) {
    fail('INVALID_STRUCTURE_CAPABILITY', '写作导航标识无效');
  }
  return value;
}

function randomCapabilityId(randomBytes, issuedIds) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `wsc_${randomBytes(16).toString('hex')}`;
    if (CAPABILITY_ID_RE.test(candidate) && !issuedIds.has(candidate)) return candidate;
  }
  fail('CAPABILITY_COLLISION', '无法分配唯一结构确认能力');
}

function createWritingStructureCapabilityStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? Math.min(options.ttlMs, DEFAULT_TTL_MS)
    : DEFAULT_TTL_MS;
  const records = new Map();
  // A consumed/expired token is never reissued during this store lifetime.
  // Otherwise a delayed replay could accidentally address a later capability
  // when a deterministic or faulty entropy source repeats bytes.
  const issuedIds = new Set();

  function remove(capabilityId) {
    records.delete(capabilityId);
  }

  function purgeExpired() {
    const now = clock();
    for (const [capabilityId, entry] of records) {
      if (now >= entry.expiresAt) remove(capabilityId);
    }
  }

  function issue(prepared) {
    if (!isAuthenticWritingStructurePreparedRecord(prepared)) {
      fail('INVALID_PREPARED_STRUCTURE', '结构确认记录没有通过预览服务验证');
    }
    purgeExpired();
    const capabilityId = randomCapabilityId(randomBytes, issuedIds);
    issuedIds.add(capabilityId);
    const createdAt = clock();
    const expiresAt = createdAt + ttlMs;
    records.set(capabilityId, Object.freeze({
      capabilityId,
      prepared,
      createdAt,
      expiresAt,
    }));
    return Object.freeze({
      capabilityId,
      expiresAt,
      preview: prepared.preview,
    });
  }

  function consume(raw) {
    exactKeys(raw, [
      'capabilityId', 'ownerId', 'projectInstanceId', 'rootPath',
      'mutationGeneration', 'navigationEpoch', 'editRevision', 'emptyTreeDigest',
    ]);
    if (typeof raw.capabilityId !== 'string' || !CAPABILITY_ID_RE.test(raw.capabilityId)) {
      fail('INVALID_STRUCTURE_CAPABILITY', '结构确认能力标识无效');
    }
    const binding = {
      ownerId: validateOwner(raw.ownerId),
      projectInstanceId: validateProject(raw.projectInstanceId),
      rootPath: validateRoot(raw.rootPath),
      mutationGeneration: validateGeneration(raw.mutationGeneration),
      navigationEpoch: validateGeneration(raw.navigationEpoch),
      editRevision: validateDigest(raw.editRevision),
      emptyTreeDigest: validateDigest(raw.emptyTreeDigest),
    };
    purgeExpired();
    const entry = records.get(raw.capabilityId);
    if (!entry) fail('CAPABILITY_NOT_FOUND', '结构确认能力已过期或已使用');
    const prepared = entry.prepared;
    if (prepared.ownerId !== binding.ownerId ||
        prepared.projectInstanceId !== binding.projectInstanceId) {
      fail('CAPABILITY_NOT_FOUND', '结构确认能力已过期或已使用');
    }
    if (prepared.rootPath !== binding.rootPath ||
        prepared.mutationGeneration !== binding.mutationGeneration ||
        prepared.navigationEpoch !== binding.navigationEpoch ||
        prepared.editRevision !== binding.editRevision ||
        prepared.emptyTreeDigest !== binding.emptyTreeDigest) {
      remove(raw.capabilityId);
      fail('STALE_STRUCTURE_CAPABILITY', '项目状态已变化，请重新预览章节骨架');
    }
    remove(raw.capabilityId);
    return prepared;
  }

  function invalidateProject(raw) {
    exactKeys(raw, ['ownerId', 'projectInstanceId']);
    const ownerId = validateOwner(raw.ownerId);
    const projectInstanceId = validateProject(raw.projectInstanceId);
    let count = 0;
    for (const [capabilityId, entry] of [...records]) {
      if (entry.prepared.ownerId === ownerId &&
          entry.prepared.projectInstanceId === projectInstanceId) {
        remove(capabilityId);
        count += 1;
      }
    }
    return count;
  }

  function stats() {
    purgeExpired();
    return Object.freeze({ capabilities: records.size });
  }

  return Object.freeze({
    issue,
    consume,
    invalidateProject,
    stats,
  });
}

module.exports = Object.freeze({
  DEFAULT_TTL_MS,
  WritingStructureCapabilityStoreError,
  createWritingStructureCapabilityStore,
});
