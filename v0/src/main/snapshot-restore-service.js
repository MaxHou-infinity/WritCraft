'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');
const publicMarkdownPhaseSchema = require('./snapshot-public-markdown-phase-schema');

const RESTORE_KIND = 'SNAPSHOT_RESTORE';
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const ALLOWED_CURRENT_STATES = new Set(['available', 'missing', 'conflict', 'unavailable']);
const AUTHORITY_RESULT_KEYS = Object.freeze([
  'operationId', 'outcome', 'status', 'affectedPaths',
  'recoveryRequired', 'responseRecovered',
]);
const PRODUCTION_APPLIED_RESULT_KEYS = Object.freeze([
  'affectedPaths', 'ok', 'operationId', 'outcome', 'recoveryRequired', 'status',
]);
const PRODUCTION_RECOVERED_RESULT_KEYS = Object.freeze([
  'affectedPaths', 'confirmationUnavailable', 'ok', 'operationId', 'outcome',
  'recoveryRequired', 'residualUnavailable', 'responseRecovered', 'status',
]);
const PRODUCTION_WARNING_RESULT_KEYS = Object.freeze([
  'affectedPaths', 'confirmationUnavailable', 'ok', 'operationId', 'outcome',
  'recoveryRequired', 'residualUnavailable', 'status', 'warning',
]);

class SnapshotRestoreServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotRestoreServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotRestoreServiceError(code, message);
}

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function exact(value, keys, field) {
  try { return schema.assertExactKeys(value, keys, field); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is invalid`); }
}

function assertOwner(value) {
  exact(value, ['ownerId', 'projectInstanceId', 'ownerGeneration'], 'snapshot restore owner');
  if (typeof value.ownerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.ownerId)) {
    fail('SNAPSHOT_RESTORE_REQUEST_INVALID', 'Snapshot restore owner is invalid');
  }
  try {
    schema.assertProjectInstanceId(value.projectInstanceId);
    schema.assertSafeInteger(value.ownerGeneration, 'ownerGeneration');
  } catch (_) {
    fail('SNAPSHOT_RESTORE_REQUEST_INVALID', 'Snapshot restore owner is invalid');
  }
  return Object.freeze({ ...value });
}

function assertRequest(value, owner) {
  exact(value, [
    'schema', 'projectInstanceId', 'restoreCapabilityId', 'confirmation',
  ], 'snapshot restore request');
  try { schema.assertOpaqueId(value.restoreCapabilityId, 'restoreCapabilityId'); }
  catch (_) { fail('SNAPSHOT_RESTORE_REQUEST_INVALID', 'Restore capability is invalid'); }
  if (value.schema !== schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST ||
      value.projectInstanceId !== owner.projectInstanceId ||
      value.confirmation !== 'RESTORE_SELECTED_MARKDOWN') {
    fail('SNAPSHOT_RESTORE_REQUEST_INVALID', 'Snapshot restore request is invalid');
  }
  return Object.freeze({ ...value });
}

function assertDigest(value, field) {
  try { return schema.assertDigest(value, field); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is invalid`); }
}

function assertRevision(value, field) {
  try {
    schema.assertString(value, field, {
      ascii: true, pattern: REVISION_RE, minBytes: 64, maxBytes: 64,
    });
  } catch (_) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is invalid`);
  }
}

function assertPublicPath(value, field) {
  try {
    schema.assertString(value, field, { minBytes: 1, maxBytes: 4096, maxScalars: 1024 });
  } catch (_) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is invalid`);
  }
  const segments = value.split('/');
  if (value.startsWith('/') || value.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' ||
        segment.startsWith('.') || segment === '.writcraft') ||
      !/\.(?:md|markdown)$/iu.test(value)) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is invalid`);
  }
  return value;
}

function immutableBytes(value, byteLength, expectedDigest, revision, field, cloneBytes) {
  if (!Buffer.isBuffer(value) && typeof value !== 'string') {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} bytes are invalid`);
  }
  let bytes;
  try { bytes = cloneBytes(value); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} bytes cannot be sealed`); }
  if (!Buffer.isBuffer(bytes)) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} byte clone is invalid`);
  }
  if (bytes.length !== byteLength) {
    fail('SNAPSHOT_RESTORE_STALE', `${field} byte length drifted`);
  }
  let digest;
  try {
    digest = crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (_) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} digest is unavailable`);
  }
  if (`sha256:${digest}` !== expectedDigest || digest !== revision) {
    fail('SNAPSHOT_RESTORE_STALE', `${field} bytes drifted`);
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} is not strict UTF-8`); }
  return bytes;
}

function validateSnapshotAuthority(value, owner) {
  exact(value, [
    'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
    'publishedIdentityDigest', 'comparisonDigest', 'selectedIds', 'files',
  ], 'snapshot restore sealed snapshot authority');
  try {
    schema.assertProjectInstanceId(value.projectInstanceId);
    schema.assertOpaqueId(value.snapshotId, 'snapshotId');
  } catch (_) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Snapshot restore snapshot identity is invalid');
  }
  assertDigest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  assertDigest(value.publishedIdentityDigest, 'publishedIdentityDigest');
  assertDigest(value.comparisonDigest, 'comparisonDigest');
  if (value.projectInstanceId !== owner.projectInstanceId ||
      !Array.isArray(value.selectedIds) || value.selectedIds.length < 1 ||
      value.selectedIds.length > schema.SNAPSHOT_LIMITS.maxMarkdownFiles ||
      !Array.isArray(value.files) || value.files.length !== value.selectedIds.length) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Snapshot restore selection is invalid');
  }
  const seen = new Set();
  const seenPaths = new Set();
  let afterBytes = 0;
  const metadata = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value.files, String(index));
    if (!item || !Object.hasOwn(item, 'value') || item.enumerable !== true) {
      fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Snapshot restore files must be dense plain data');
    }
    const file = item.value;
    exact(file, [
      'fileId', 'path', 'byteLength', 'sha256', 'revision', 'content',
    ], `snapshot restore snapshot files[${index}]`);
    const descriptors = schema.assertPlainRecord(file, `snapshot restore snapshot files[${index}]`);
    try {
      schema.assertOpaqueId(descriptors.fileId.value, `snapshot files[${index}].fileId`);
      schema.assertSafeInteger(descriptors.byteLength.value, `snapshot files[${index}].byteLength`,
        0, schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes);
    } catch (_) {
      fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Snapshot restore file metadata is invalid');
    }
    const fileId = descriptors.fileId.value;
    const relativePath = descriptors.path.value;
    const byteLength = descriptors.byteLength.value;
    const digest = descriptors.sha256.value;
    const revision = descriptors.revision.value;
    assertPublicPath(relativePath, `snapshot files[${index}].path`);
    assertDigest(digest, `snapshot files[${index}].sha256`);
    assertRevision(revision, `snapshot files[${index}].revision`);
    if (fileId !== value.selectedIds[index] || seen.has(fileId) ||
        seenPaths.has(relativePath)) {
      fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Snapshot restore selected IDs are not exact');
    }
    seen.add(fileId);
    seenPaths.add(relativePath);
    afterBytes += byteLength;
    if (afterBytes > schema.SNAPSHOT_RESTORE_HISTORY_LIMITS.maxAfterBytes) {
      fail('SNAPSHOT_RESTORE_BUDGET_EXCEEDED',
        'Snapshot restore declared after bytes exceed the frozen budget');
    }
    metadata.push(Object.freeze({
      fileId,
      path: relativePath,
      byteLength,
      sha256: digest,
      revision,
      content: descriptors.content.value,
    }));
  }
  return Object.freeze({ ...value, selectedIds: Object.freeze([...value.selectedIds]),
    files: Object.freeze(metadata), afterBytes });
}

function validateCurrentAuthority(value, owner, barrier, snapshot) {
  exact(value, [
    'projectInstanceId', 'projectId', 'rootPath', 'mutationGeneration',
    'fileRevisionSetDigest', 'files',
  ], 'snapshot restore current authority');
  if (value.projectInstanceId !== owner.projectInstanceId ||
      typeof value.projectId !== 'string' || value.projectId.length < 1 ||
      typeof value.rootPath !== 'string' || !value.rootPath.startsWith('/') ||
      value.mutationGeneration !== barrier.mutationGeneration ||
      !Array.isArray(value.files) || value.files.length !== snapshot.files.length) {
    fail(value.mutationGeneration !== barrier.mutationGeneration
      ? 'SNAPSHOT_RESTORE_STALE' : 'SNAPSHOT_RESTORE_AUTHORITY_INVALID',
    'Snapshot restore current authority is invalid');
  }
  try { schema.assertSafeInteger(value.mutationGeneration, 'mutationGeneration'); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Mutation generation is invalid'); }
  assertDigest(value.fileRevisionSetDigest, 'fileRevisionSetDigest');
  let beforeBytes = 0;
  const metadata = [];
  for (let index = 0; index < value.files.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value.files, String(index));
    if (!item || !Object.hasOwn(item, 'value') || item.enumerable !== true) {
      fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Current restore files must be dense plain data');
    }
    const file = item.value;
    exact(file, [
      'fileId', 'path', 'state', 'byteLength', 'sha256', 'revision', 'content',
      'ancestorIdentityDigest', 'leafIdentityDigest',
    ], `snapshot restore current files[${index}]`);
    const descriptors = schema.assertPlainRecord(file, `snapshot restore current files[${index}]`);
    const snapshotFile = snapshot.files[index];
    const fileId = descriptors.fileId.value;
    const relativePath = descriptors.path.value;
    const state = descriptors.state.value;
    if (fileId !== snapshotFile.fileId || relativePath !== snapshotFile.path ||
        !ALLOWED_CURRENT_STATES.has(state)) {
      fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Current restore file binding is invalid');
    }
    assertDigest(descriptors.ancestorIdentityDigest.value,
      `current files[${index}].ancestorIdentityDigest`);
    if (state === 'conflict' || state === 'unavailable') {
      fail('SNAPSHOT_RESTORE_CONFLICT', 'Selected Markdown is no longer safely restorable');
    }
    if (state === 'missing') {
      if (descriptors.byteLength.value !== null || descriptors.sha256.value !== null ||
          descriptors.revision.value !== null || descriptors.content.value !== null ||
          descriptors.leafIdentityDigest.value !== null) {
        fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Missing Markdown leaked a leaf identity');
      }
      metadata.push(Object.freeze({
        fileId,
        path: relativePath,
        state,
        before: Object.freeze({
          exists: false, revision: null, contentHash: null, byteLength: 0,
          encoding: null, data: null,
        }),
        ancestorIdentityDigest: descriptors.ancestorIdentityDigest.value,
        leafIdentityDigest: null,
      }));
      continue;
    }
    const byteLength = descriptors.byteLength.value;
    try { schema.assertSafeInteger(byteLength, `current files[${index}].byteLength`, 0,
      schema.SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes); }
    catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Current byte length is invalid'); }
    assertDigest(descriptors.sha256.value, `current files[${index}].sha256`);
    assertDigest(descriptors.leafIdentityDigest.value, `current files[${index}].leafIdentityDigest`);
    assertRevision(descriptors.revision.value, `current files[${index}].revision`);
    beforeBytes += byteLength;
    if (beforeBytes + snapshot.afterBytes >
        schema.SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes) {
      fail('SNAPSHOT_RESTORE_BUDGET_EXCEEDED',
        'Snapshot restore declared before/after bytes exceed budget');
    }
    metadata.push(Object.freeze({
      fileId,
      path: relativePath,
      state,
      byteLength,
      sha256: descriptors.sha256.value,
      revision: descriptors.revision.value,
      content: descriptors.content.value,
      ancestorIdentityDigest: descriptors.ancestorIdentityDigest.value,
      leafIdentityDigest: descriptors.leafIdentityDigest.value,
    }));
  }
  return Object.freeze({ ...value, files: Object.freeze(metadata), beforeBytes });
}

function canonicalBase64(bytes, encodeBase64, field) {
  let data;
  try { data = encodeBase64(bytes); }
  catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} cannot be encoded`); }
  if (typeof data !== 'string' || Buffer.from(data, 'base64').length !== bytes.length ||
      Buffer.from(data, 'base64').toString('base64') !== data) {
    fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', `${field} base64 encoding is invalid`);
  }
  return data;
}

function sealRestoreBytes(snapshot, current, cloneBytes, encodeBase64) {
  const snapshotFiles = snapshot.files.map((file, index) => {
    const bytes = immutableBytes(file.content, file.byteLength, file.sha256, file.revision,
      `snapshot files[${index}]`, cloneBytes);
    return Object.freeze({
      fileId: file.fileId,
      path: file.path,
      byteLength: bytes.length,
      sha256: file.sha256,
      revision: file.revision,
      data: canonicalBase64(bytes, encodeBase64, `snapshot files[${index}]`),
    });
  });
  const currentFiles = current.files.map((file, index) => {
    if (file.state === 'missing') return file;
    const bytes = immutableBytes(file.content, file.byteLength, file.sha256, file.revision,
      `current files[${index}]`, cloneBytes);
    return Object.freeze({
      fileId: file.fileId,
      path: file.path,
      state: file.state,
      before: Object.freeze({
        exists: true,
        revision: file.revision,
        contentHash: file.sha256.slice(7),
        byteLength: bytes.length,
        encoding: 'base64',
        data: canonicalBase64(bytes, encodeBase64, `current files[${index}]`),
      }),
      ancestorIdentityDigest: file.ancestorIdentityDigest,
      leafIdentityDigest: file.leafIdentityDigest,
    });
  });
  return Object.freeze({
    snapshot: Object.freeze({ ...snapshot, files: Object.freeze(snapshotFiles) }),
    current: Object.freeze({ ...current, files: Object.freeze(currentFiles) }),
  });
}

function assertConsumed(value, request, snapshot, current) {
  let top;
  let record;
  let selection;
  let selectedIds;
  try {
    schema.assertExactKeys(value, [
      'record', 'selection', 'snapshotId', 'snapshotManifestDigest',
      'publishedIdentityDigest', 'selected',
    ], 'consumed restore authority');
    top = schema.assertPlainRecord(value, 'consumed restore authority');
    record = schema.assertPlainRecord(top.record.value, 'consumed capability record');
    selection = schema.assertPlainRecord(top.selection.value, 'consumed restore selection');
    selectedIds = cloneDenseStrings(selection.selectedIds?.value, 'consumed selectedIds');
    const selected = top.selected.value;
    if (!Array.isArray(selected) || Object.getOwnPropertySymbols(selected).length !== 0 ||
        Object.keys(selected).length !== selected.length ||
        Object.getOwnPropertyNames(selected).length !== selected.length + 1) throw new Error('selected');
    for (let index = 0; index < selected.length; index += 1) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(selected, String(index));
      if (!itemDescriptor || !Object.hasOwn(itemDescriptor, 'value')) throw new Error('selected');
      const item = schema.assertPlainRecord(itemDescriptor.value, `consumed selected[${index}]`);
      if (item.fileId?.value !== selectedIds[index]) throw new Error('selected');
    }
  } catch (_) {
    fail('SNAPSHOT_RESTORE_STALE', 'Consumed restore capability is not exact plain authority');
  }
  if (record.capabilityId?.value !== request.restoreCapabilityId ||
      top.snapshotId.value !== snapshot.snapshotId ||
      top.snapshotManifestDigest.value !== snapshot.snapshotManifestDigest ||
      top.publishedIdentityDigest.value !== snapshot.publishedIdentityDigest ||
      selection.comparisonDigest?.value !== snapshot.comparisonDigest ||
      selection.currentMutationGeneration?.value !== current.mutationGeneration ||
      selection.currentFileRevisionSetDigest?.value !== current.fileRevisionSetDigest ||
      selectedIds.length !== snapshot.selectedIds.length ||
      selectedIds.some((id, index) => id !== snapshot.selectedIds[index])) {
    fail('SNAPSHOT_RESTORE_STALE', 'Consumed restore capability does not match sealed authority');
  }
  return true;
}

function cloneDenseStrings(value, field) {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      Object.keys(value).length !== value.length) {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', `${field} is not a dense array`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
        typeof descriptor.value !== 'string') {
      fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', `${field} contains unsafe values`);
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function cloneAuthorityResult(value, expectedPaths) {
  let descriptors;
  try { descriptors = schema.assertPlainRecord(value, 'snapshot restore authority result'); }
  catch (_) { fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', 'Restore authority result is not plain data'); }
  const actualKeys = Object.keys(descriptors).sort();
  const matches = expected => actualKeys.length === expected.length &&
    [...expected].sort().every((key, index) => actualKeys[index] === key);
  const raw = {};
  if (matches(AUTHORITY_RESULT_KEYS)) {
    for (const key of AUTHORITY_RESULT_KEYS) raw[key] = descriptors[key].value;
  } else if (matches(PRODUCTION_APPLIED_RESULT_KEYS)) {
    for (const key of PRODUCTION_APPLIED_RESULT_KEYS) raw[key] = descriptors[key].value;
    if (raw.ok !== true || raw.outcome !== 'applied' || raw.status !== 'applied' ||
        raw.recoveryRequired !== false) {
      fail('SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID',
        'Production applied restore shape crossed its frozen matrix');
    }
    raw.responseRecovered = false;
  } else if (matches(PRODUCTION_RECOVERED_RESULT_KEYS)) {
    for (const key of PRODUCTION_RECOVERED_RESULT_KEYS) raw[key] = descriptors[key].value;
    if (raw.ok !== true || raw.responseRecovered !== true ||
        raw.residualUnavailable !== false || raw.confirmationUnavailable !== true ||
        raw.outcome !== 'applied' || raw.status !== 'applied' ||
        raw.recoveryRequired !== false) {
      fail('SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID',
        'Production recovered restore shape crossed its frozen matrix');
    }
  } else if (matches(PRODUCTION_WARNING_RESULT_KEYS)) {
    for (const key of PRODUCTION_WARNING_RESULT_KEYS) raw[key] = descriptors[key].value;
    if (raw.ok !== true || raw.warning !== true || raw.residualUnavailable !== false ||
        raw.confirmationUnavailable !== true || raw.outcome !== 'committed_warning' ||
        raw.status !== 'committed_warning' || raw.recoveryRequired !== true) {
      fail('SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID',
        'Production warning restore shape crossed its frozen matrix');
    }
    raw.responseRecovered = true;
  } else {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID',
      'Restore authority result has an unknown exact shape');
  }
  const affectedPaths = cloneDenseStrings(raw.affectedPaths, 'authority.affectedPaths');
  if (affectedPaths.length !== expectedPaths.length ||
      affectedPaths.some((path, index) => path !== expectedPaths[index])) {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID',
      'Restore authority paths do not match the sealed selection');
  }
  if (raw.operationId !== null) {
    try { schema.assertOpaqueId(raw.operationId, 'operationId'); }
    catch (_) { fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', 'Restore operation ID is invalid'); }
  }
  if (typeof raw.outcome !== 'string' || typeof raw.status !== 'string' ||
      typeof raw.recoveryRequired !== 'boolean' || typeof raw.responseRecovered !== 'boolean') {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', 'Restore authority primitives are invalid');
  }
  const matrices = Object.freeze({
    applied: Object.freeze({ status: 'applied', recoveryRequired: false,
      truth: 'COMMITTED', errorCode: null }),
    committed_warning: Object.freeze({ status: 'committed_warning', recoveryRequired: true,
      truth: 'COMMITTED_RISK', errorCode: 'SNAPSHOT_RESTORE_COMMITTED_WARNING' }),
    manual_recovery: Object.freeze({ status: 'manual_recovery', recoveryRequired: true,
      truth: 'UNKNOWN', errorCode: 'SNAPSHOT_RESTORE_UNKNOWN' }),
    zero_write_error: Object.freeze({ status: 'zero_write_error', recoveryRequired: false,
      truth: 'UNCOMMITTED', errorCode: 'SNAPSHOT_RESTORE_UNCOMMITTED' }),
  });
  const matrix = matrices[raw.outcome];
  if (!matrix || raw.status !== matrix.status ||
      raw.recoveryRequired !== matrix.recoveryRequired ||
      (['COMMITTED', 'COMMITTED_RISK'].includes(matrix.truth) && raw.operationId === null)) {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID', 'Restore outcome/status/truth matrix is invalid');
  }
  return Object.freeze({
    operationId: raw.operationId,
    outcome: raw.outcome,
    status: raw.status,
    affectedPaths,
    recoveryRequired: raw.recoveryRequired,
    responseRecovered: raw.responseRecovered,
    truth: matrix.truth,
    errorCode: matrix.errorCode,
  });
}

function preparedHistoryId(prepared) {
  try {
    const top = schema.assertPlainRecord(prepared, 'prepared snapshot restore transaction');
    const id = top.historyEntryId?.value;
    schema.assertOpaqueId(id, 'historyEntryId');
    return id;
  } catch (_) {
    fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID',
      'Restore transaction did not seal plain History authority before capability consumption');
  }
}

function cloneLocalTask(value) {
  try { schema.assertExactKeys(value, schema.KEYS.LOCAL_TASK, 'restore local task'); }
  catch (_) { fail('SNAPSHOT_RESTORE_TERMINAL_INVALID', 'Restore local task is not exact plain data'); }
  const descriptors = schema.assertPlainRecord(value, 'restore local task');
  const result = {};
  for (const key of schema.KEYS.LOCAL_TASK) result[key] = descriptors[key].value;
  try { schema.assertLocalTask(result); }
  catch (_) { fail('SNAPSHOT_RESTORE_TERMINAL_INVALID', 'Restore local task is invalid'); }
  return Object.freeze(result);
}

function terminalTaskFromBasis(basis, truth, errorCode) {
  const task = Object.freeze({
    ...basis,
    stage: 'completed',
    status: truth === 'COMMITTED' ? 'completed' : 'failed',
    cancelAvailable: false,
    terminalTruth: truth,
    errorCode,
  });
  try { schema.assertLocalTask(task); }
  catch (_) { fail('SNAPSHOT_RESTORE_TERMINAL_INVALID', 'Restore terminal template is invalid'); }
  return task;
}

function historyForAuthority(authority, truth, historyEntryId, expectedPaths) {
  return Object.freeze({
    operationId: authority.operationId,
    outcome: authority.outcome,
    status: authority.status,
    affectedPaths: expectedPaths,
    historyEntryId: ['COMMITTED', 'COMMITTED_RISK'].includes(truth) ? historyEntryId : null,
    recoveryRequired: ['COMMITTED_RISK', 'UNKNOWN'].includes(truth),
    responseRecovered: authority.responseRecovered,
    committedWarning: truth === 'COMMITTED_RISK',
  });
}

function buildEnvelope(owner, request, snapshotId, task, history) {
  const envelope = Object.freeze({
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_RESULT,
    projectInstanceId: owner.projectInstanceId,
    snapshotId,
    restoreCapabilityId: request.restoreCapabilityId,
    task,
    history,
  });
  try { schema.assertSnapshotRestoreResult(envelope); }
  catch (_) { fail('SNAPSHOT_RESTORE_RESULT_INVALID', 'Restore terminal result is invalid'); }
  return envelope;
}

function createSnapshotRestoreService(options = {}) {
  const localOperations = options.localOperations;
  const capabilityStore = options.capabilityStore;
  const transaction = options.transaction;
  if (!localOperations || typeof localOperations.begin !== 'function') {
    throw new TypeError('localOperations.begin is required');
  }
  if (!capabilityStore || typeof capabilityStore.consumeRestore !== 'function') {
    throw new TypeError('capabilityStore.consumeRestore is required');
  }
  if (!transaction || typeof transaction.prepareSnapshotRestore !== 'function' ||
      typeof transaction.execute !== 'function') {
    throw new TypeError('snapshot restore transaction prepare/execute is required');
  }
  const acquireLease = typeof options.acquireLease === 'function'
    ? options.acquireLease
    : async () => fail('SNAPSHOT_RESTORE_LEASE_UNAVAILABLE', 'Restore lease is unavailable');
  const releaseLease = typeof options.releaseLease === 'function'
    ? options.releaseLease
    : async () => false;
  const assertOwnerCurrent = typeof options.assertOwnerCurrent === 'function'
    ? options.assertOwnerCurrent
    : () => fail('SNAPSHOT_RESTORE_OWNER_UNAVAILABLE', 'Restore owner is unavailable');
  const settleWatcherBarrier = typeof options.settleWatcherBarrier === 'function'
    ? options.settleWatcherBarrier
    : async () => fail('SNAPSHOT_RESTORE_BARRIER_UNAVAILABLE', 'Restore barrier is unavailable');
  const readSnapshotAuthority = typeof options.readSnapshotAuthority === 'function'
    ? options.readSnapshotAuthority
    : async () => fail('SNAPSHOT_RESTORE_READER_UNAVAILABLE', 'Snapshot reader is unavailable');
  const readCurrentAuthority = typeof options.readCurrentAuthority === 'function'
    ? options.readCurrentAuthority
    : async () => fail('SNAPSHOT_RESTORE_READER_UNAVAILABLE', 'Current reader is unavailable');
  const exactRestoreExecutor = typeof options.exactRestoreExecutor === 'function'
    ? options.exactRestoreExecutor
    : null;
  const cloneBytes = typeof options.cloneBytes === 'function'
    ? options.cloneBytes
    : value => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
  const encodeBase64 = typeof options.encodeBase64 === 'function'
    ? options.encodeBase64
    : value => value.toString('base64');
  const reconcileExistingRestore = typeof options.reconcileExistingRestore === 'function'
    ? options.reconcileExistingRestore
    : async () => fail('SNAPSHOT_RESTORE_RECONCILE_UNAVAILABLE',
      'Existing restore marker reconciliation is unavailable');

  async function restore(rawOwner, rawRequest) {
    const owner = assertOwner(rawOwner);
    const request = assertRequest(rawRequest, owner);
    const operation = localOperations.begin({
      projectInstanceId: owner.projectInstanceId,
      kind: RESTORE_KIND,
      ownerGeneration: owner.ownerGeneration,
    });
    operation.start();
    const taskOwner = Object.freeze({
      ...owner,
      taskId: operation.taskId,
      kind: RESTORE_KIND,
    });
    let lease = null;
    let transactionAttempted = false;
    let terminal = false;
    let postAttemptContext = null;

    function assertCurrent() {
      operation.assertCurrentOwner();
      assertOwnerCurrent(Object.freeze({ ...taskOwner, lease }));
      if (operation.signal.aborted) {
        fail(stableCode({ code: operation.abortCode() }, 'REQUEST_ABORTED'),
          'Snapshot restore was aborted');
      }
    }

    async function release(truth) {
      if (!lease || !['COMMITTED', 'UNCOMMITTED'].includes(truth)) return;
      const exactLease = lease;
      lease = null;
      try { await releaseLease(exactLease, Object.freeze({ ...taskOwner, terminalTruth: truth })); }
      catch (_) {}
    }

    function historyFiles(snapshot, current) {
      return snapshot.files.map((after, index) => ({
        path: after.path,
        summary: 'Restore selected Markdown from Snapshot',
        before: current.files[index].before,
        after: {
          exists: true,
          revision: after.revision,
          contentHash: after.sha256.slice(7),
          byteLength: after.byteLength,
          encoding: 'base64',
          data: after.data,
        },
        createdIdentityDigest: null,
        ancestorIdentityDigest: current.files[index].ancestorIdentityDigest,
      }));
    }

    function executionBindings(snapshot, current) {
      return Object.freeze(snapshot.files.map((after, index) => Object.freeze({
        fileId: after.fileId,
        path: after.path,
        expectedBefore: current.files[index].before,
        after: Object.freeze({
          revision: after.revision,
          contentHash: after.sha256.slice(7),
          byteLength: after.byteLength,
          encoding: 'base64',
          data: after.data,
        }),
        ancestorIdentityDigest: current.files[index].ancestorIdentityDigest,
        leafIdentityDigest: current.files[index].leafIdentityDigest,
      })));
    }

    try {
      lease = await acquireLease(taskOwner);
      if (!lease || typeof lease !== 'object') {
        fail('SNAPSHOT_RESTORE_LEASE_UNAVAILABLE', 'Restore lease is invalid');
      }
      assertCurrent();
      operation.stage('preparing_restore');
      const barrier = await settleWatcherBarrier(Object.freeze({
        ...taskOwner,
        lease,
        signal: operation.signal,
      }));
      assertCurrent();
      exact(barrier, ['projectInstanceId', 'mutationGeneration'], 'snapshot restore barrier');
      if (barrier.projectInstanceId !== owner.projectInstanceId) {
        fail('PROJECT_CHANGED', 'Snapshot restore barrier belongs to another project');
      }
      try { schema.assertSafeInteger(barrier.mutationGeneration, 'mutationGeneration'); }
      catch (_) { fail('SNAPSHOT_RESTORE_AUTHORITY_INVALID', 'Restore barrier is invalid'); }

      let snapshot = validateSnapshotAuthority(await readSnapshotAuthority(Object.freeze({
        projectInstanceId: owner.projectInstanceId,
        restoreCapabilityId: request.restoreCapabilityId,
        lease,
        signal: operation.signal,
      })), owner);
      assertCurrent();
      let current = validateCurrentAuthority(await readCurrentAuthority(Object.freeze({
        projectInstanceId: owner.projectInstanceId,
        snapshotId: snapshot.snapshotId,
        selectedIds: snapshot.selectedIds,
        mutationGeneration: barrier.mutationGeneration,
        lease,
        signal: operation.signal,
      })), owner, barrier, snapshot);
      assertCurrent();

      const missingSelection = current.files.every(file => file.state === 'missing');
      const hasMissing = current.files.some(file => file.state === 'missing');
      if (hasMissing && !missingSelection &&
          (typeof transaction.commitExistingRestore !== 'function' ||
           typeof transaction.preparePublicMarkdownMarker !== 'function' ||
           typeof transaction.reconcileExistingRestore !== 'function' ||
           typeof transaction.createMissingLeaves !== 'function' ||
           typeof transaction.commitMissingRestoreHistory !== 'function' ||
           typeof transaction.finalizeMissingRestore !== 'function')) {
        fail('SNAPSHOT_RESTORE_MIXED_SELECTION_UNAVAILABLE',
          'Mixed existing and missing Markdown requires one all-or-nothing transaction');
      }
      if (missingSelection && typeof transaction.executeMissingSnapshotRestore !== 'function') {
        fail('SNAPSHOT_RESTORE_CREATED_IDENTITY_UNAVAILABLE',
          'Missing-leaf restore transaction is unavailable');
      }
      if (!missingSelection && !exactRestoreExecutor) {
        fail('SNAPSHOT_RESTORE_EXECUTOR_UNAVAILABLE',
          'Main-owned exact Snapshot restore executor is unavailable');
      }
      if (!missingSelection && exactRestoreExecutor.constructor?.name === 'AsyncFunction') {
        fail('SNAPSHOT_RESTORE_EXECUTOR_UNAVAILABLE',
          'Snapshot restore executor must settle inside the transaction boundary');
      }

      const sealed = sealRestoreBytes(snapshot, current, cloneBytes, encodeBase64);
      snapshot = sealed.snapshot;
      current = sealed.current;

      const files = historyFiles(snapshot, current);
      const bindings = executionBindings(snapshot, current);
      const provenance = Object.freeze({
        schema: 'writcraft.snapshot-restore-history/v1',
        snapshotId: snapshot.snapshotId,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        restoreCapabilityId: request.restoreCapabilityId,
        comparisonDigest: snapshot.comparisonDigest,
        selectedIds: snapshot.selectedIds,
      });
      const parentSelectionBinding = hasMissing
        ? publicMarkdownPhaseSchema.assertParentSelectionBinding({
          schema: publicMarkdownPhaseSchema.SELECTION_SCHEMA,
          kind: 'snapshot_restore',
          selected: snapshot.files.map((after, index) => ({
            selectedId: after.fileId,
            action: current.files[index].state === 'missing' ? 'MISSING' : 'EXISTING',
            path: after.path,
            revision: after.revision,
            ancestorIdentityDigest: current.files[index].ancestorIdentityDigest,
          })),
        })
        : null;
      let executorInvocations = 0;
      let executorCompletions = 0;
      const prepared = transaction.prepareSnapshotRestore({
        rootPath: current.rootPath,
        projectId: current.projectId,
        files,
        provenance,
        ...(parentSelectionBinding ? { parentSelectionBinding } : {}),
        execute(execution) {
          if (missingSelection) {
            fail('SNAPSHOT_RESTORE_EXECUTOR_REPLAYED',
              'Missing-leaf restore must not enter the existing-file executor');
          }
          executorInvocations += 1;
          if (executorInvocations !== 1) {
            fail('SNAPSHOT_RESTORE_EXECUTOR_REPLAYED',
              'Snapshot restore executor wrapper was invoked more than once');
          }
          const result = exactRestoreExecutor(Object.freeze({
            execution,
            projectInstanceId: owner.projectInstanceId,
            snapshotId: snapshot.snapshotId,
            snapshotManifestDigest: snapshot.snapshotManifestDigest,
            publishedIdentityDigest: snapshot.publishedIdentityDigest,
            mutationGeneration: current.mutationGeneration,
            fileRevisionSetDigest: current.fileRevisionSetDigest,
            bindings,
          }));
          if (result && typeof result.then === 'function') {
            fail('SNAPSHOT_RESTORE_EXECUTOR_INVALID',
              'Snapshot restore executor escaped the synchronous transaction boundary');
          }
          executorCompletions += 1;
          return result;
        },
      });
      const historyEntryId = preparedHistoryId(prepared);
      assertCurrent();
      const consumedAuthority = capabilityStore.consumeRestore(owner, request, {
        snapshotId: snapshot.snapshotId,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        publishedIdentityDigest: snapshot.publishedIdentityDigest,
        currentMutationGeneration: current.mutationGeneration,
        currentFileRevisionSetDigest: current.fileRevisionSetDigest,
        comparisonDigest: snapshot.comparisonDigest,
      });
      assertConsumed(consumedAuthority, request, snapshot, current);
      assertCurrent();
      operation.stage('restoring_markdown');
      const terminalBasis = cloneLocalTask(operation.snapshot());
      const expectedPaths = Object.freeze(snapshot.files.map(file => file.path));
      postAttemptContext = Object.freeze({
        terminalBasis,
        snapshotId: snapshot.snapshotId,
        historyEntryId,
        expectedPaths,
      });
      transactionAttempted = true;
      let reconcileCalls = 0;
      let reconcileResult = null;

      async function reconcileOnce(errorCode) {
        if (reconcileCalls !== 0) return reconcileResult;
        reconcileCalls += 1;
        try { operation.stage('reconciling'); } catch (_) {}
        const raw = await reconcileExistingRestore(Object.freeze({
          projectInstanceId: owner.projectInstanceId,
          projectId: current.projectId,
          rootPath: current.rootPath,
          snapshotId: snapshot.snapshotId,
          snapshotManifestDigest: snapshot.snapshotManifestDigest,
          restoreCapabilityId: request.restoreCapabilityId,
          historyEntryId,
          errorCode,
        }));
        reconcileResult = cloneAuthorityResult(raw, expectedPaths);
        return reconcileResult;
      }

      let authority = null;
      let directErrorCode = null;
      let directMatrixAnomaly = false;

      // All-or-nothing mixed journey: the MISSING CREATE first advances the
      // marker to CREATED_RECEIPT, then the EXISTING E/R terminal is
      // CAS-installed into the WRCCHRJ2 journal (existingTerminalPublication),
      // then History is committed and the restore finalizes. A lost EXISTING
      // response after the native E committed is rebuilt with a fresh native R
      // before the History step (no CREATE/E replay).
      function runMixedJourney(preparedTransaction) {
        let marker = transaction.preparePublicMarkdownMarker(preparedTransaction);
        marker = transaction.createMissingLeaves(preparedTransaction, marker);
        let reconciled = false;
        try {
          marker = transaction.commitExistingRestore(preparedTransaction, marker);
        } catch (existingError) {
          if (existingError?.code !== 'CHANGES_MANUAL_RECOVERY_REQUIRED') throw existingError;
          try {
            marker = transaction.reconcileExistingRestore(preparedTransaction, marker);
            reconciled = true;
          } catch (_) {
            throw existingError;
          }
        }
        marker = transaction.commitMissingRestoreHistory(preparedTransaction, marker);
        marker = transaction.finalizeMissingRestore(preparedTransaction, marker);
        const terminal = transaction.reconciliation.finish(
          preparedTransaction.rootPath,
          marker.operationId
        );
        if (terminal.state !== 'terminal' || terminal.outcome !== 'applied') {
          fail('SNAPSHOT_RESTORE_TRANSACTION_INVALID',
            'Mixed restore terminal authority is invalid');
        }
        transaction.reconciliation.clear(
          preparedTransaction.rootPath,
          preparedTransaction.projectId,
          marker.operationId
        );
        const applied = Object.freeze({
          ok: true,
          operationId: terminal.operationId,
          outcome: 'applied',
          status: 'applied',
          affectedPaths: Object.freeze(terminal.files.map(file => file.path)),
          recoveryRequired: false,
        });
        return reconciled
          ? Object.freeze({
            ...applied,
            responseRecovered: true,
            residualUnavailable: false,
            confirmationUnavailable: true,
          })
          : applied;
      }

      try {
        const raw = missingSelection
          ? transaction.executeMissingSnapshotRestore(prepared)
          : hasMissing
            ? runMixedJourney(prepared)
            : transaction.execute(prepared);
        authority = cloneAuthorityResult(raw, expectedPaths);
      } catch (executionError) {
        directErrorCode = stableCode(executionError, 'SNAPSHOT_RESTORE_RESPONSE_LOST');
        directMatrixAnomaly = executionError?.code === 'SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID';
      }
      const executorAnomaly = hasMissing
        ? executorInvocations !== 0 || executorCompletions !== 0
        : executorInvocations !== 1 ||
          (authority?.responseRecovered !== true && executorCompletions !== 1);
      if (!authority || executorAnomaly) {
        if (!missingSelection && !hasMissing) {
          try {
            authority = await reconcileOnce(directErrorCode || (executorAnomaly
              ? 'SNAPSHOT_RESTORE_EXECUTOR_COUNT_INVALID'
              : 'SNAPSHOT_RESTORE_RESULT_INVALID'));
          } catch (_) {
            authority = null;
          }
        }
      }
      if (!authority) {
        authority = Object.freeze({
          operationId: null,
          outcome: null,
          status: null,
          affectedPaths: expectedPaths,
          recoveryRequired: true,
          responseRecovered: false,
          truth: 'UNKNOWN',
          errorCode: 'SNAPSHOT_RESTORE_UNKNOWN',
        });
      }
      let truth = authority.truth;
      let errorCode = authority.errorCode;
      if ((executorAnomaly || directMatrixAnomaly) && truth === 'COMMITTED') {
        truth = 'COMMITTED_RISK';
        errorCode = executorAnomaly
          ? 'SNAPSHOT_RESTORE_EXECUTOR_COUNT_INVALID'
          : 'SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID';
      }

      // Build and validate both the intended envelope and its committed-safe
      // fallback before terminal publication or lease release. The fallback is
      // used if the terminal adapter throws, returns accessors/extra keys, or
      // publishes a mismatched task after disk truth is already committed.
      const intendedTask = terminalTaskFromBasis(terminalBasis, truth, errorCode);
      const intendedHistory = historyForAuthority(
        authority, truth, historyEntryId, expectedPaths
      );
      const intendedEnvelope = buildEnvelope(
        owner, request, snapshot.snapshotId, intendedTask, intendedHistory
      );
      const fallbackTruth = truth === 'COMMITTED' ? 'COMMITTED_RISK' : truth;
      const fallbackCode = truth === 'COMMITTED'
        ? 'SNAPSHOT_RESTORE_TERMINAL_INVALID'
        : errorCode;
      const fallbackTask = terminalTaskFromBasis(terminalBasis, fallbackTruth, fallbackCode);
      const fallbackHistory = historyForAuthority(
        authority, fallbackTruth, historyEntryId, expectedPaths
      );
      const fallbackEnvelope = buildEnvelope(
        owner, request, snapshot.snapshotId, fallbackTask, fallbackHistory
      );

      let envelope = intendedEnvelope;
      try {
        const actualTask = cloneLocalTask(operation.terminal(truth, errorCode));
        if (actualTask.taskId !== intendedTask.taskId ||
            actualTask.projectInstanceId !== intendedTask.projectInstanceId ||
            actualTask.kind !== intendedTask.kind || actualTask.stage !== 'completed' ||
            actualTask.status !== intendedTask.status ||
            actualTask.terminalTruth !== truth || actualTask.errorCode !== errorCode) {
          fail('SNAPSHOT_RESTORE_TERMINAL_INVALID', 'Restore terminal task drifted');
        }
        envelope = buildEnvelope(
          owner, request, snapshot.snapshotId, actualTask, intendedHistory
        );
      } catch (_) {
        envelope = fallbackEnvelope;
      }
      terminal = true;
      await release(envelope.task.terminalTruth);
      return envelope;
    } catch (error) {
      if (terminal) throw error;
      if (transactionAttempted && postAttemptContext) {
        const authority = Object.freeze({
          operationId: null,
          outcome: null,
          status: null,
          affectedPaths: postAttemptContext.expectedPaths,
          recoveryRequired: true,
          responseRecovered: false,
          truth: 'UNKNOWN',
          errorCode: 'SNAPSHOT_RESTORE_UNKNOWN',
        });
        const history = historyForAuthority(
          authority,
          'UNKNOWN',
          postAttemptContext.historyEntryId,
          postAttemptContext.expectedPaths
        );
        const task = terminalTaskFromBasis(
          postAttemptContext.terminalBasis,
          'UNKNOWN',
          'SNAPSHOT_RESTORE_UNKNOWN'
        );
        let envelope = buildEnvelope(
          owner, request, postAttemptContext.snapshotId, task, history
        );
        try {
          const actualTask = cloneLocalTask(
            operation.terminal('UNKNOWN', 'SNAPSHOT_RESTORE_UNKNOWN')
          );
          if (actualTask.terminalTruth === 'UNKNOWN' &&
              actualTask.errorCode === 'SNAPSHOT_RESTORE_UNKNOWN') {
            envelope = buildEnvelope(
              owner, request, postAttemptContext.snapshotId, actualTask, history
            );
          }
        } catch (_) {}
        terminal = true;
        return envelope;
      }
      const code = stableCode(error, transactionAttempted
        ? 'SNAPSHOT_RESTORE_UNKNOWN' : 'SNAPSHOT_RESTORE_FAILED');
      const truth = transactionAttempted ? 'UNKNOWN' : 'UNCOMMITTED';
      await release(truth);
      try { operation.terminal(truth, code); } catch (_) {}
      if (error instanceof SnapshotRestoreServiceError) throw error;
      throw new SnapshotRestoreServiceError(code,
        truth === 'UNKNOWN' ? 'Snapshot restore outcome is unknown' : 'Snapshot restore failed closed');
    }
  }

  return Object.freeze({ restore });
}

module.exports = Object.freeze({
  RESTORE_KIND,
  SnapshotRestoreServiceError,
  createSnapshotRestoreService,
});
