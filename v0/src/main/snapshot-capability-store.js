'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');

const COMPARE_TTL_MS = 10 * 60 * 1000;
const RESTORE_TTL_MS = 10 * 60 * 1000;
const DELETE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 64;
const CAPABILITY_ID_RE = /^snapshot_cap_[a-f0-9]{32}$/;
const OWNER_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
// Process-wide uniqueness ledger: a capability ID is never reissued in this
// process lifetime, so a stale token cannot address a later record even when
// entropy is degenerate (see allocateProcessCapabilityId).
const issuedProcessCapabilityIds = new Set();
let nextProcessCapabilityCounter = 0;

class SnapshotCapabilityStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotCapabilityStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotCapabilityStoreError(code, message);
}

function exact(value, keys, field) {
  try { schema.assertExactKeys(value, keys, field); } catch (_) {
    fail('INVALID_SNAPSHOT_CAPABILITY', `${field} 包含未知、缺失或非普通字段`);
  }
  return value;
}

function digest(value, field) {
  try { return schema.assertDigest(value, field); } catch (_) {
    fail('INVALID_SNAPSHOT_CAPABILITY', `${field} 摘要无效`);
  }
}

function opaque(value, field) {
  try { return schema.assertOpaqueId(value, field); } catch (_) {
    fail('INVALID_SNAPSHOT_CAPABILITY', `${field} opaque ID 无效`);
  }
}

function generation(value, field) {
  try { return schema.assertSafeInteger(value, field); } catch (_) {
    fail('INVALID_SNAPSHOT_CAPABILITY', `${field} generation 无效`);
  }
}

function project(value) {
  try { return schema.assertProjectInstanceId(value); } catch (_) {
    fail('INVALID_SNAPSHOT_CAPABILITY', 'projectInstanceId 无效');
  }
}

function validateOwner(value) {
  exact(value, ['ownerId', 'projectInstanceId', 'ownerGeneration'], 'snapshot capability owner');
  if (typeof value.ownerId !== 'string' || !OWNER_ID_RE.test(value.ownerId)) {
    fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot capability ownerId 无效');
  }
  project(value.projectInstanceId);
  generation(value.ownerGeneration, 'ownerGeneration');
  return Object.freeze({ ...value });
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function validateCompareBinding(value) {
  exact(value, [
    'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest', 'authorityDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest', 'comparisonDigest', 'files',
  ], 'compare binding');
  opaque(value.snapshotId, 'snapshotId');
  digest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  digest(value.publishedIdentityDigest, 'publishedIdentityDigest');
  digest(value.authorityDigest, 'authorityDigest');
  generation(value.currentMutationGeneration, 'currentMutationGeneration');
  digest(value.currentFileRevisionSetDigest, 'currentFileRevisionSetDigest');
  digest(value.comparisonDigest, 'comparisonDigest');
  if (!Array.isArray(value.files) || value.files.length > schema.SNAPSHOT_LIMITS.maxTotalItems) {
    fail('INVALID_SNAPSHOT_CAPABILITY', 'compare files 数量无效');
  }
  const fileIds = new Set();
  const diffIds = new Set();
  const cursors = new Set();
  const files = value.files.map((file, index) => {
    exact(file, [
      'fileId', 'kind', 'diffId', 'restorable', 'truncated', 'diffCursors',
    ], `compare files[${index}]`);
    opaque(file.fileId, `compare files[${index}].fileId`);
    if (file.diffId !== null) opaque(file.diffId, `compare files[${index}].diffId`);
    if (!['markdown', 'image'].includes(file.kind) || typeof file.restorable !== 'boolean' ||
        typeof file.truncated !== 'boolean' || !Array.isArray(file.diffCursors) ||
        file.diffCursors.length > 4096 || fileIds.has(file.fileId) ||
        (file.diffId !== null && diffIds.has(file.diffId)) ||
        (file.diffId === null && file.diffCursors.length !== 0) ||
        (file.kind !== 'markdown' && file.restorable) || (file.truncated && file.restorable)) {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'compare file binding 无效或重复');
    }
    fileIds.add(file.fileId);
    if (file.diffId !== null) diffIds.add(file.diffId);
    const diffCursors = file.diffCursors.map((cursor, cursorIndex) => {
      opaque(cursor, `compare files[${index}].diffCursors[${cursorIndex}]`);
      if (cursors.has(cursor)) fail('INVALID_SNAPSHOT_CAPABILITY', 'diff cursor 重复');
      cursors.add(cursor);
      return cursor;
    });
    return freeze({
      fileId: file.fileId,
      kind: file.kind,
      diffId: file.diffId,
      restorable: file.restorable,
      truncated: file.truncated,
      diffCursors,
    });
  });
  return freeze({ ...value, files });
}

function validateCompareCurrent(value) {
  exact(value, [
    'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest', 'comparisonDigest',
  ], 'compare current authority');
  opaque(value.snapshotId, 'current.snapshotId');
  digest(value.snapshotManifestDigest, 'current.snapshotManifestDigest');
  digest(value.publishedIdentityDigest, 'current.publishedIdentityDigest');
  generation(value.currentMutationGeneration, 'current.currentMutationGeneration');
  digest(value.currentFileRevisionSetDigest, 'current.currentFileRevisionSetDigest');
  digest(value.comparisonDigest, 'current.comparisonDigest');
  return value;
}

function validateDeleteBinding(value) {
  exact(value, [
    'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest',
  ], 'delete binding');
  opaque(value.snapshotId, 'delete.snapshotId');
  digest(value.snapshotManifestDigest, 'delete.snapshotManifestDigest');
  digest(value.publishedIdentityDigest, 'delete.publishedIdentityDigest');
  generation(value.currentMutationGeneration, 'delete.currentMutationGeneration');
  digest(value.currentFileRevisionSetDigest, 'delete.currentFileRevisionSetDigest');
  return freeze({ ...value });
}

function validateDeleteCurrent(value) {
  exact(value, [
    'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest',
  ], 'delete current authority');
  return validateDeleteBinding(value);
}

function allocateProcessCapabilityId(randomBytes) {
  // A fresh 128-bit random id per capability: an observer holding one
  // capability must not be able to guess the next one issued by this process.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `snapshot_cap_${randomBytes(16).toString('hex')}`;
    if (CAPABILITY_ID_RE.test(candidate) && !issuedProcessCapabilityIds.has(candidate)) {
      issuedProcessCapabilityIds.add(candidate);
      return candidate;
    }
  }
  // Degenerate or faulty entropy: mix the process-wide counter into a fresh
  // id so uniqueness still holds when randomBytes repeats.
  nextProcessCapabilityCounter += 1;
  const counter = nextProcessCapabilityCounter.toString(16).padStart(16, '0');
  const candidate = `snapshot_cap_${randomBytes(8).toString('hex')}${counter}`;
  if (!CAPABILITY_ID_RE.test(candidate)) {
    fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot capability ID 无效');
  }
  issuedProcessCapabilityIds.add(candidate);
  return candidate;
}

function createSnapshotCapabilityStore(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const compareTtlMs = Number.isSafeInteger(options.compareTtlMs) && options.compareTtlMs > 0
    ? Math.min(options.compareTtlMs, COMPARE_TTL_MS) : COMPARE_TTL_MS;
  const restoreTtlMs = Number.isSafeInteger(options.restoreTtlMs) && options.restoreTtlMs > 0
    ? Math.min(options.restoreTtlMs, RESTORE_TTL_MS) : RESTORE_TTL_MS;
  const deleteTtlMs = Number.isSafeInteger(options.deleteTtlMs) && options.deleteTtlMs > 0
    ? Math.min(options.deleteTtlMs, DELETE_TTL_MS) : DELETE_TTL_MS;
  const maxRecords = Number.isSafeInteger(options.maxRecords) && options.maxRecords > 0
    ? Math.min(options.maxRecords, DEFAULT_MAX_RECORDS) : DEFAULT_MAX_RECORDS;
  const records = new Map();
  const tombstones = new Map();
  let allocatedCount = 0;

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'capability clock 无效');
    }
    return value;
  }

  function iso(value) {
    return new Date(value).toISOString();
  }

  function remember(capabilityId, reason) {
    tombstones.set(capabilityId, reason);
    while (tombstones.size > DEFAULT_MAX_RECORDS * 8) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  function remove(entry, reason) {
    if (records.get(entry.record.capabilityId) === entry) {
      records.delete(entry.record.capabilityId);
      remember(entry.record.capabilityId, reason);
    }
  }

  function prune() {
    const value = now();
    for (const entry of [...records.values()]) {
      if (value >= entry.expiresAtMs) remove(entry, 'EXPIRED');
    }
  }

  function allocateId() {
    const capabilityId = allocateProcessCapabilityId(randomBytes);
    allocatedCount += 1;
    return capabilityId;
  }

  function capacity() {
    prune();
    while (records.size >= maxRecords) {
      const oldest = records.values().next().value;
      if (!oldest) break;
      remove(oldest, 'EVICTED');
    }
  }

  function createEntry(ownerBinding, kind, subjectId, authorityDigest, selection, binding, ttlMs, singleUse) {
    capacity();
    const issuedAtMs = now();
    const expiresAtMs = issuedAtMs + ttlMs;
    const capabilityId = allocateId();
    const record = freeze({
      schema: schema.SCHEMAS.LOCAL_CAPABILITY,
      capabilityId,
      kind,
      projectInstanceId: ownerBinding.projectInstanceId,
      ownerGeneration: ownerBinding.ownerGeneration,
      subjectId,
      authorityDigest,
      selectionDigest: schema.digestObject(selection.schema, selection),
      issuedAt: iso(issuedAtMs),
      expiresAt: iso(expiresAtMs),
      singleUse,
      consumedAt: null,
    });
    schema.assertExactKeys(record, schema.KEYS.CAPABILITY, 'capability record');
    const entry = {
      ownerId: ownerBinding.ownerId,
      record,
      selection,
      binding,
      expiresAtMs,
      diffPositions: kind === 'SNAPSHOT_COMPARE'
        ? new Map(binding.files.filter(file => file.diffId !== null).map(file => [file.diffId, -1]))
        : null,
    };
    records.set(capabilityId, entry);
    return freeze({ capabilityId, expiresAt: record.expiresAt });
  }

  function association(ownerBinding, capabilityId, expectedKind) {
    const validOwner = validateOwner(ownerBinding);
    opaque(capabilityId, 'capabilityId');
    prune();
    const entry = records.get(capabilityId);
    if (!entry) {
      const reason = tombstones.get(capabilityId);
      if (reason === 'EXPIRED') fail('SNAPSHOT_CAPABILITY_EXPIRED', 'snapshot capability 已过期');
      if (reason) fail('SNAPSHOT_CAPABILITY_REPLAYED', 'snapshot capability 已使用或失效');
      fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'snapshot capability 不存在');
    }
    if (entry.record.kind !== expectedKind || entry.ownerId !== validOwner.ownerId ||
        entry.record.projectInstanceId !== validOwner.projectInstanceId ||
        entry.record.ownerGeneration !== validOwner.ownerGeneration) {
      fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'snapshot capability 不属于当前 owner/project');
    }
    return entry;
  }

  function stale(entry, message) {
    remove(entry, 'STALE');
    fail('STALE_SNAPSHOT_CAPABILITY', message);
  }

  function assertCompareFresh(entry, currentAuthority) {
    const value = validateCompareCurrent(currentAuthority);
    const bound = entry.binding;
    if (bound.snapshotId !== value.snapshotId ||
        bound.snapshotManifestDigest !== value.snapshotManifestDigest ||
        bound.publishedIdentityDigest !== value.publishedIdentityDigest ||
        bound.currentMutationGeneration !== value.currentMutationGeneration ||
        bound.currentFileRevisionSetDigest !== value.currentFileRevisionSetDigest ||
        bound.comparisonDigest !== value.comparisonDigest) {
      stale(entry, 'snapshot comparison authority 已漂移');
    }
    return entry;
  }

  function assertDeleteFresh(entry, currentAuthority) {
    const value = validateDeleteCurrent(currentAuthority);
    const bound = entry.binding;
    if (bound.snapshotId !== value.snapshotId ||
        bound.snapshotManifestDigest !== value.snapshotManifestDigest ||
        bound.publishedIdentityDigest !== value.publishedIdentityDigest ||
        bound.currentMutationGeneration !== value.currentMutationGeneration ||
        bound.currentFileRevisionSetDigest !== value.currentFileRevisionSetDigest) {
      stale(entry, 'snapshot delete authority 已漂移');
    }
    return entry;
  }

  function issueCompare(ownerBinding, rawBinding) {
    const validOwner = validateOwner(ownerBinding);
    const binding = validateCompareBinding(rawBinding);
    const selection = freeze({
      schema: schema.SCHEMAS.SNAPSHOT_COMPARE_SELECTION,
      projectInstanceId: validOwner.projectInstanceId,
      snapshotId: binding.snapshotId,
      snapshotManifestDigest: binding.snapshotManifestDigest,
      currentMutationGeneration: binding.currentMutationGeneration,
      currentFileRevisionSetDigest: binding.currentFileRevisionSetDigest,
      comparisonDigest: binding.comparisonDigest,
    });
    return createEntry(
      validOwner, 'SNAPSHOT_COMPARE', binding.snapshotId, binding.authorityDigest,
      selection, binding, compareTtlMs, false
    );
  }

  function resolveDiff(ownerBinding, request, currentAuthority) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, [
      'schema', 'projectInstanceId', 'compareCapabilityId', 'diffId', 'pageToken',
    ], 'snapshot diff request');
    if (request.schema !== schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST ||
        request.projectInstanceId !== validOwner.projectInstanceId) {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot diff request schema/project 无效');
    }
    opaque(request.compareCapabilityId, 'compareCapabilityId');
    opaque(request.diffId, 'diffId');
    if (request.pageToken !== null) opaque(request.pageToken, 'pageToken');
    const entry = assertCompareFresh(
      association(validOwner, request.compareCapabilityId, 'SNAPSHOT_COMPARE'),
      currentAuthority
    );
    const file = entry.binding.files.find(item => item.diffId === request.diffId);
    if (!file) fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'diff 不属于 compare capability');
    const expectedCursorIndex = entry.diffPositions.get(file.diffId);
    let pageIndex;
    if (request.pageToken === null) {
      if (expectedCursorIndex !== -1) {
        fail('SNAPSHOT_CAPABILITY_REPLAYED', 'diff 首页 cursor 已使用');
      }
      pageIndex = 0;
      entry.diffPositions.set(file.diffId, 0);
    } else {
      if (expectedCursorIndex < 0 || file.diffCursors[expectedCursorIndex] !== request.pageToken) {
        fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'diff cursor 不是上一页 sealed token');
      }
      pageIndex = expectedCursorIndex + 1;
      entry.diffPositions.set(file.diffId, expectedCursorIndex + 1);
    }
    return freeze({
      capabilityId: entry.record.capabilityId,
      fileId: file.fileId,
      diffId: file.diffId,
      pageToken: request.pageToken,
      pageIndex,
    });
  }

  function issueRestore(ownerBinding, request, currentAuthority) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, [
      'schema', 'projectInstanceId', 'compareCapabilityId', 'selectedIds', 'confirmation',
    ], 'snapshot restore prepare request');
    if (request.schema !== schema.SCHEMAS.SNAPSHOT_RESTORE_PREPARE_REQUEST ||
        request.projectInstanceId !== validOwner.projectInstanceId ||
        request.confirmation !== 'PREPARE_SELECTED_MARKDOWN_RESTORE' ||
        !Array.isArray(request.selectedIds) || request.selectedIds.length < 1 ||
        request.selectedIds.length > schema.SNAPSHOT_LIMITS.maxMarkdownFiles) {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot restore prepare request 无效');
    }
    const compareEntry = assertCompareFresh(
      association(validOwner, request.compareCapabilityId, 'SNAPSHOT_COMPARE'),
      currentAuthority
    );
    const selectedIds = [];
    const selected = [];
    const seen = new Set();
    for (const [index, fileId] of request.selectedIds.entries()) {
      opaque(fileId, `selectedIds[${index}]`);
      if (seen.has(fileId)) fail('INVALID_SNAPSHOT_CAPABILITY', 'selectedIds 重复');
      seen.add(fileId);
      const file = compareEntry.binding.files.find(item => item.fileId === fileId);
      if (!file || file.kind !== 'markdown' || !file.restorable || file.truncated) {
        fail('INVALID_SNAPSHOT_CAPABILITY', 'selectedIds 包含未 sealed 或不可恢复文件');
      }
      selectedIds.push(fileId);
      selected.push(file);
    }
    const selection = freeze({
      schema: schema.SCHEMAS.SNAPSHOT_RESTORE_SELECTION,
      compareCapabilityId: compareEntry.record.capabilityId,
      comparisonDigest: compareEntry.binding.comparisonDigest,
      selectedIds,
      currentMutationGeneration: compareEntry.binding.currentMutationGeneration,
      currentFileRevisionSetDigest: compareEntry.binding.currentFileRevisionSetDigest,
    });
    const binding = freeze({ compareCapabilityId: compareEntry.record.capabilityId, ...compareEntry.binding, selected });
    return createEntry(
      validOwner, 'SNAPSHOT_RESTORE', compareEntry.binding.snapshotId,
      compareEntry.record.authorityDigest, selection, binding, restoreTtlMs, true
    );
  }

  function consumeRestore(ownerBinding, request, currentAuthority) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, [
      'schema', 'projectInstanceId', 'restoreCapabilityId', 'confirmation',
    ], 'snapshot restore request');
    if (request.schema !== schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST ||
        request.projectInstanceId !== validOwner.projectInstanceId ||
        request.confirmation !== 'RESTORE_SELECTED_MARKDOWN') {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot restore request 无效');
    }
    const entry = assertCompareFresh(
      association(validOwner, request.restoreCapabilityId, 'SNAPSHOT_RESTORE'),
      currentAuthority
    );
    const consumedAtMs = now();
    entry.record = freeze({ ...entry.record, consumedAt: iso(consumedAtMs) });
    remove(entry, 'CONSUMED');
    return freeze({
      record: entry.record,
      selection: entry.selection,
      snapshotId: entry.binding.snapshotId,
      snapshotManifestDigest: entry.binding.snapshotManifestDigest,
      publishedIdentityDigest: entry.binding.publishedIdentityDigest,
      selected: entry.binding.selected,
    });
  }

  function issueDelete(ownerBinding, rawBinding) {
    const validOwner = validateOwner(ownerBinding);
    const binding = validateDeleteBinding(rawBinding);
    const selection = freeze({
      schema: schema.SCHEMAS.SNAPSHOT_DELETE_SELECTION,
      snapshotId: binding.snapshotId,
      snapshotManifestDigest: binding.snapshotManifestDigest,
      publishedIdentityDigest: binding.publishedIdentityDigest,
    });
    return createEntry(
      validOwner, 'SNAPSHOT_DELETE', binding.snapshotId, binding.publishedIdentityDigest,
      selection, binding, deleteTtlMs, true
    );
  }

  function consumeDelete(ownerBinding, request, currentAuthority) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, [
      'schema', 'projectInstanceId', 'deleteCapabilityId', 'confirmation',
    ], 'snapshot delete request');
    if (request.schema !== schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST ||
        request.projectInstanceId !== validOwner.projectInstanceId ||
        request.confirmation !== 'DELETE_SNAPSHOT') {
      fail('INVALID_SNAPSHOT_CAPABILITY', 'snapshot delete request 无效');
    }
    const entry = assertDeleteFresh(
      association(validOwner, request.deleteCapabilityId, 'SNAPSHOT_DELETE'),
      currentAuthority
    );
    entry.record = freeze({ ...entry.record, consumedAt: iso(now()) });
    remove(entry, 'CONSUMED');
    return freeze({ record: entry.record, selection: entry.selection, binding: entry.binding });
  }

  function peekDelete(ownerBinding, request) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, ['deleteCapabilityId'], 'snapshot delete capability lookup');
    const entry = association(
      validOwner,
      request.deleteCapabilityId,
      'SNAPSHOT_DELETE'
    );
    return freeze({ record: entry.record, selection: entry.selection, binding: entry.binding });
  }

  function release(ownerBinding, request) {
    const validOwner = validateOwner(ownerBinding);
    exact(request, ['capabilityId'], 'snapshot capability release');
    const entry = association(
      validOwner,
      request.capabilityId,
      records.get(request.capabilityId)?.record.kind
    );
    remove(entry, 'RELEASED');
    return true;
  }

  function releaseOwner(ownerBinding) {
    const validOwner = validateOwner(ownerBinding);
    let count = 0;
    for (const entry of [...records.values()]) {
      if (entry.ownerId === validOwner.ownerId &&
          entry.record.projectInstanceId === validOwner.projectInstanceId &&
          entry.record.ownerGeneration === validOwner.ownerGeneration) {
        remove(entry, 'RELEASED');
        count += 1;
      }
    }
    return count;
  }

  function invalidateProject(request) {
    exact(request, ['projectInstanceId'], 'snapshot project invalidation');
    project(request.projectInstanceId);
    let count = 0;
    for (const entry of [...records.values()]) {
      if (entry.record.projectInstanceId === request.projectInstanceId) {
        remove(entry, 'PROJECT_SWITCH');
        count += 1;
      }
    }
    return count;
  }

  function inspect(capabilityId) {
    opaque(capabilityId, 'capabilityId');
    prune();
    const entry = records.get(capabilityId);
    return entry ? entry.record : null;
  }

  function stats() {
    prune();
    return freeze({
      capabilities: records.size,
      allocatedCount,
      tombstones: tombstones.size,
    });
  }

  return freeze({
    issueCompare,
    resolveDiff,
    issueRestore,
    consumeRestore,
    issueDelete,
    peekDelete,
    consumeDelete,
    release,
    releaseOwner,
    invalidateProject,
    prune,
    inspect,
    stats,
  });
}

module.exports = Object.freeze({
  COMPARE_TTL_MS,
  RESTORE_TTL_MS,
  DELETE_TTL_MS,
  DEFAULT_MAX_RECORDS,
  CAPABILITY_ID_RE,
  SnapshotCapabilityStoreError,
  createSnapshotCapabilityStore,
});
