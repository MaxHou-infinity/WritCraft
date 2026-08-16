'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');
const { DELETE_TTL_MS } = require('./snapshot-capability-store');

const DELETE_KIND = 'SNAPSHOT_DELETE';
const DELETE_CONFIRMATION = 'DELETE_SNAPSHOT';
const DEFAULT_DESTROY_TIMEOUT_MS = 10000;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;

class SnapshotDeleteServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotDeleteServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotDeleteServiceError(code, message);
}

function stableCode(error, fallback) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return fallback;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(error, 'code'); }
  catch (_) { return fallback; }
  return descriptor && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'string' && ERROR_CODE_RE.test(descriptor.value)
    ? descriptor.value
    : fallback;
}

function exact(value, keys, field, code = 'SNAPSHOT_DELETE_AUTHORITY_INVALID') {
  try { schema.assertExactKeys(value, keys, field); }
  catch (_) { fail(code, `${field} is invalid`); }
}

function opaque(value, field, code = 'SNAPSHOT_DELETE_AUTHORITY_INVALID') {
  try { schema.assertOpaqueId(value, field); }
  catch (_) { fail(code, `${field} is invalid`); }
}

function digest(value, field) {
  try { schema.assertDigest(value, field); }
  catch (_) { fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', `${field} is invalid`); }
}

function integer(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  try { schema.assertSafeInteger(value, field, 0, maximum); }
  catch (_) { fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', `${field} is invalid`); }
}

function timestamp(value, field) {
  try {
    schema.assertString(value, field, {
      ascii: true,
      pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      minBytes: 24,
      maxBytes: 24,
    });
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new Error('timestamp');
    return parsed;
  } catch (_) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', `${field} is invalid`);
  }
}

function nowEpoch(clock, field) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SNAPSHOT_DELETE_CLOCK_INVALID', `${field} clock is invalid`);
  }
  return value;
}

function nowIso(clock, field) {
  return new Date(nowEpoch(clock, field)).toISOString();
}

function randomTransactionId(randomBytes) {
  let bytes;
  try { bytes = randomBytes(16); }
  catch (_) { fail('SNAPSHOT_DELETE_ID_UNAVAILABLE', 'Delete transaction identity is unavailable'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    fail('SNAPSHOT_DELETE_ID_UNAVAILABLE', 'Delete transaction identity is unavailable');
  }
  return `delete_${bytes.toString('hex')}`;
}

function assertOwner(value) {
  exact(value, ['ownerId', 'projectInstanceId', 'ownerGeneration'],
    'snapshot delete owner', 'SNAPSHOT_DELETE_REQUEST_INVALID');
  if (typeof value.ownerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.ownerId)) {
    fail('SNAPSHOT_DELETE_REQUEST_INVALID', 'Snapshot delete owner is invalid');
  }
  try {
    schema.assertProjectInstanceId(value.projectInstanceId);
    schema.assertSafeInteger(value.ownerGeneration, 'ownerGeneration', 0);
  } catch (_) {
    fail('SNAPSHOT_DELETE_REQUEST_INVALID', 'Snapshot delete owner is invalid');
  }
  return Object.freeze({ ...value });
}

function assertPrepareRequest(value, owner) {
  exact(value, ['schema', 'projectInstanceId', 'snapshotId'],
    'snapshot delete prepare request', 'SNAPSHOT_DELETE_REQUEST_INVALID');
  opaque(value.snapshotId, 'snapshotId', 'SNAPSHOT_DELETE_REQUEST_INVALID');
  if (value.schema !== schema.SCHEMAS.SNAPSHOT_DELETE_PREPARE_REQUEST ||
      value.projectInstanceId !== owner.projectInstanceId) {
    fail('SNAPSHOT_DELETE_REQUEST_INVALID', 'Snapshot delete prepare request is invalid');
  }
  return Object.freeze({ ...value });
}

function assertCommitRequest(value, owner) {
  exact(value, ['schema', 'projectInstanceId', 'deleteCapabilityId', 'confirmation'],
    'snapshot delete request', 'SNAPSHOT_DELETE_REQUEST_INVALID');
  opaque(value.deleteCapabilityId, 'deleteCapabilityId', 'SNAPSHOT_DELETE_REQUEST_INVALID');
  if (value.schema !== schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST ||
      value.projectInstanceId !== owner.projectInstanceId ||
      value.confirmation !== DELETE_CONFIRMATION) {
    fail('SNAPSHOT_DELETE_REQUEST_INVALID', 'Snapshot delete request is invalid');
  }
  return Object.freeze({ ...value });
}

function validateBarrier(value, owner) {
  exact(value, ['projectInstanceId', 'mutationGeneration'], 'snapshot delete barrier');
  if (value.projectInstanceId !== owner.projectInstanceId) {
    fail('PROJECT_CHANGED', 'Snapshot delete barrier belongs to another project');
  }
  integer(value.mutationGeneration, 'mutationGeneration');
  return Object.freeze({ ...value });
}

function validateSnapshotAuthority(value, owner, snapshotId) {
  exact(value, [
    'projectInstanceId', 'snapshotId', 'createdAt', 'markdownCount', 'imageCount',
    'totalBytes', 'snapshotManifestDigest', 'publishedIdentityDigest',
  ], 'snapshot delete sealed snapshot authority');
  try { schema.assertProjectInstanceId(value.projectInstanceId); }
  catch (_) { fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Snapshot project identity is invalid'); }
  opaque(value.snapshotId, 'snapshotId');
  timestamp(value.createdAt, 'createdAt');
  integer(value.markdownCount, 'markdownCount', schema.SNAPSHOT_LIMITS.maxMarkdownFiles);
  integer(value.imageCount, 'imageCount', schema.SNAPSHOT_LIMITS.maxImageFiles);
  integer(value.totalBytes, 'totalBytes', schema.SNAPSHOT_LIMITS.maxSnapshotBytes);
  digest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  digest(value.publishedIdentityDigest, 'publishedIdentityDigest');
  if (value.projectInstanceId !== owner.projectInstanceId || value.snapshotId !== snapshotId) {
    fail('SNAPSHOT_DELETE_STALE', 'Snapshot delete authority drifted');
  }
  return Object.freeze({ ...value });
}

function validateCurrentAuthority(value, owner, barrier) {
  exact(value, [
    'projectInstanceId', 'mutationGeneration', 'fileRevisionSetDigest',
  ], 'snapshot delete current authority');
  try { schema.assertProjectInstanceId(value.projectInstanceId); }
  catch (_) { fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Current project identity is invalid'); }
  integer(value.mutationGeneration, 'current mutationGeneration');
  digest(value.fileRevisionSetDigest, 'current fileRevisionSetDigest');
  if (value.projectInstanceId !== owner.projectInstanceId ||
      value.mutationGeneration !== barrier.mutationGeneration) {
    fail('SNAPSHOT_DELETE_STALE', 'Current project authority drifted');
  }
  return Object.freeze({ ...value });
}

function validateIssued(value) {
  exact(value, ['capabilityId', 'expiresAt'], 'snapshot delete issued capability');
  opaque(value.capabilityId, 'deleteCapabilityId');
  timestamp(value.expiresAt, 'expiresAt');
  return Object.freeze({ ...value });
}

function safeIssuedCapabilityId(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, 'capabilityId'); }
  catch (_) { return null; }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
  try { schema.assertOpaqueId(descriptor.value, 'deleteCapabilityId'); }
  catch (_) { return null; }
  return descriptor.value;
}

function validatePeeked(value, owner, request, expectConsumed = false, options = {}) {
  exact(value, ['record', 'selection', 'binding'], 'snapshot delete capability lookup');
  exact(value.record, schema.KEYS.CAPABILITY, 'snapshot delete capability record');
  exact(value.selection, [
    'schema', 'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
  ], 'snapshot delete selection');
  exact(value.binding, [
    'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest',
  ], 'snapshot delete binding');
  const record = Object.freeze({ ...value.record });
  const selection = Object.freeze({ ...value.selection });
  const binding = Object.freeze({ ...value.binding });
  opaque(record.capabilityId, 'capabilityId');
  opaque(record.subjectId, 'subjectId');
  try { schema.assertProjectInstanceId(record.projectInstanceId); }
  catch (_) { fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Capability project identity is invalid'); }
  integer(record.ownerGeneration, 'capability ownerGeneration');
  digest(record.authorityDigest, 'capability authorityDigest');
  digest(record.selectionDigest, 'capability selectionDigest');
  const issuedAtMs = timestamp(record.issuedAt, 'capability issuedAt');
  const expiresAtMs = timestamp(record.expiresAt, 'capability expiresAt');
  if (record.schema !== schema.SCHEMAS.LOCAL_CAPABILITY || record.kind !== DELETE_KIND ||
      record.singleUse !== true || expiresAtMs - issuedAtMs !== DELETE_TTL_MS) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability record contract drifted');
  }
  if (expectConsumed) {
    const consumedAtMs = timestamp(record.consumedAt, 'capability consumedAt');
    if (consumedAtMs < issuedAtMs || consumedAtMs >= expiresAtMs) {
      fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability consumption time drifted');
    }
  } else if (record.consumedAt !== null) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability was already consumed');
  }
  opaque(binding.snapshotId, 'snapshotId');
  digest(binding.snapshotManifestDigest, 'snapshotManifestDigest');
  digest(binding.publishedIdentityDigest, 'publishedIdentityDigest');
  integer(binding.currentMutationGeneration, 'currentMutationGeneration');
  digest(binding.currentFileRevisionSetDigest, 'currentFileRevisionSetDigest');
  let computedSelectionDigest;
  try {
    computedSelectionDigest = schema.digestObject(
      schema.SCHEMAS.SNAPSHOT_DELETE_SELECTION,
      selection
    );
  } catch (_) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability selection digest is invalid');
  }
  if (record.capabilityId !== request.deleteCapabilityId || record.kind !== DELETE_KIND ||
      record.projectInstanceId !== owner.projectInstanceId ||
      record.ownerGeneration !== owner.ownerGeneration ||
      record.subjectId !== binding.snapshotId ||
      record.authorityDigest !== binding.publishedIdentityDigest ||
      record.selectionDigest !== computedSelectionDigest ||
      selection.schema !== schema.SCHEMAS.SNAPSHOT_DELETE_SELECTION ||
      selection.snapshotId !== binding.snapshotId ||
      selection.snapshotManifestDigest !== binding.snapshotManifestDigest ||
      selection.publishedIdentityDigest !== binding.publishedIdentityDigest) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Snapshot delete capability lookup drifted');
  }
  if (options.issued) {
    if (options.issued.capabilityId !== record.capabilityId ||
        options.issued.expiresAt !== record.expiresAt) {
      fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Issued delete projection drifted');
    }
  }
  if (options.issuedNotBefore !== undefined &&
      (issuedAtMs < options.issuedNotBefore || issuedAtMs > options.issuedNotAfter)) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability issue time drifted');
  }
  if (options.expectedBinding &&
      schema.canonicalJson(binding) !== schema.canonicalJson(options.expectedBinding)) {
    fail('SNAPSHOT_DELETE_AUTHORITY_INVALID', 'Delete capability binding drifted');
  }
  if (options.atMs !== undefined &&
      (!Number.isSafeInteger(options.atMs) || options.atMs < issuedAtMs ||
        options.atMs >= expiresAtMs)) {
    fail('SNAPSHOT_DELETE_STALE', 'Snapshot delete capability is not current');
  }
  return Object.freeze({ record, selection, binding });
}

function validateConsumed(value, owner, request, snapshot, current, atMs) {
  const consumed = validatePeeked(value, owner, request, true, { atMs });
  const binding = consumed.binding;
  if (binding.snapshotId !== snapshot.snapshotId ||
      binding.snapshotManifestDigest !== snapshot.snapshotManifestDigest ||
      binding.publishedIdentityDigest !== snapshot.publishedIdentityDigest ||
      binding.currentMutationGeneration !== current.mutationGeneration ||
      binding.currentFileRevisionSetDigest !== current.fileRevisionSetDigest) {
    fail('SNAPSHOT_DELETE_STALE', 'Consumed delete capability drifted');
  }
  return consumed;
}

function validatePrimaryTruth(value, metadata) {
  let descriptors;
  try { descriptors = schema.assertPlainRecord(value, 'snapshot delete truth'); }
  catch (_) {
    fail('SNAPSHOT_DELETE_RESULT_INVALID', 'Snapshot delete truth is invalid');
  }
  const common = [
    'transactionId', 'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
    'sourceIdentityDigest', 'state',
  ];
  const state = descriptors.state?.value;
  const keys = state === 'COMMITTED'
    ? [...common, 'deletedIdentityDigest', 'receiptDigest']
    : state === 'UNCOMMITTED'
      ? [...common, 'reason']
      : [];
  if (!keys.length) fail('SNAPSHOT_DELETE_RESULT_INVALID', 'Snapshot delete state is invalid');
  exact(value, keys, 'snapshot delete truth', 'SNAPSHOT_DELETE_RESULT_INVALID');
  if (value.transactionId !== metadata.transactionId ||
      value.projectInstanceId !== metadata.projectInstanceId ||
      value.snapshotId !== metadata.snapshotId ||
      value.snapshotManifestDigest !== metadata.snapshotManifestDigest ||
      value.sourceIdentityDigest !== metadata.publishedIdentityDigest) {
    fail('SNAPSHOT_DELETE_RESULT_INVALID', 'Snapshot delete truth drifted');
  }
  if (value.state === 'COMMITTED') {
    digest(value.deletedIdentityDigest, 'deletedIdentityDigest');
    digest(value.receiptDigest, 'receiptDigest');
  } else if (typeof value.reason !== 'string' || !ERROR_CODE_RE.test(value.reason)) {
    fail('SNAPSHOT_DELETE_RESULT_INVALID', 'Snapshot delete reason is invalid');
  }
  return Object.freeze({ ...value });
}

function validateReconciliationTruth(value, metadata) {
  let descriptors;
  try { descriptors = schema.assertPlainRecord(value, 'snapshot delete reconciliation'); }
  catch (_) {
    fail('SNAPSHOT_DELETE_RECONCILE_INVALID', 'Snapshot delete reconciliation is invalid');
  }
  const common = ['transactionId', 'snapshotId', 'state'];
  const state = descriptors.state?.value;
  const keys = state === 'COMMITTED'
    ? [...common, 'deletedIdentityDigest', 'receiptDigest']
    : state === 'UNCOMMITTED'
      ? [...common, 'reason']
      : [];
  if (!keys.length) {
    fail('SNAPSHOT_DELETE_RECONCILE_INVALID', 'Snapshot delete reconciliation state is invalid');
  }
  exact(value, keys, 'snapshot delete reconciliation', 'SNAPSHOT_DELETE_RECONCILE_INVALID');
  if (value.transactionId !== metadata.transactionId || value.snapshotId !== metadata.snapshotId) {
    fail('SNAPSHOT_DELETE_RECONCILE_INVALID', 'Snapshot delete reconciliation drifted');
  }
  if (value.state === 'COMMITTED') {
    digest(value.deletedIdentityDigest, 'deletedIdentityDigest');
    digest(value.receiptDigest, 'receiptDigest');
  } else if (typeof value.reason !== 'string' || !ERROR_CODE_RE.test(value.reason)) {
    fail('SNAPSHOT_DELETE_RECONCILE_INVALID', 'Snapshot delete reconciliation reason is invalid');
  }
  return Object.freeze({ ...value });
}

function cloneLocalTask(value, expected) {
  exact(value, [
    'schema', 'taskId', 'projectInstanceId', 'kind', 'stage', 'status', 'startedAt',
    'elapsedMs', 'cancelAvailable', 'terminalTruth', 'errorCode',
  ], 'snapshot delete local task', 'SNAPSHOT_DELETE_TERMINAL_INVALID');
  const task = Object.freeze({ ...value });
  try { schema.assertLocalTask(task); }
  catch (_) { fail('SNAPSHOT_DELETE_TERMINAL_INVALID', 'Snapshot delete local task is invalid'); }
  if (task.projectInstanceId !== expected.projectInstanceId || task.kind !== DELETE_KIND ||
      (expected.taskId && task.taskId !== expected.taskId)) {
    fail('SNAPSHOT_DELETE_TERMINAL_INVALID', 'Snapshot delete local task drifted');
  }
  return task;
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
  catch (_) { fail('SNAPSHOT_DELETE_TERMINAL_INVALID', 'Snapshot delete terminal is invalid'); }
  return task;
}

function sameTerminalTask(actual, intended) {
  return actual.taskId === intended.taskId &&
    actual.projectInstanceId === intended.projectInstanceId &&
    actual.kind === intended.kind && actual.stage === intended.stage &&
    actual.status === intended.status && actual.startedAt === intended.startedAt &&
    actual.elapsedMs >= intended.elapsedMs && actual.cancelAvailable === false &&
    actual.terminalTruth === intended.terminalTruth &&
    actual.errorCode === intended.errorCode;
}

function dataMethod(value, name, required = true) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
    if (required) fail('SNAPSHOT_DELETE_WORKER_INVALID', 'Delete worker is invalid');
    return null;
  }
  let current = value;
  for (let depth = 0; current && depth < 16; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, name); }
    catch (_) {
      if (required) fail('SNAPSHOT_DELETE_WORKER_INVALID', 'Delete worker method is invalid');
      return null;
    }
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        if (required) fail('SNAPSHOT_DELETE_WORKER_INVALID', 'Delete worker method is invalid');
        return null;
      }
      return descriptor.value.bind(value);
    }
    try { current = Object.getPrototypeOf(current); }
    catch (_) {
      if (required) fail('SNAPSHOT_DELETE_WORKER_INVALID', 'Delete worker prototype is invalid');
      return null;
    }
  }
  if (required) fail('SNAPSHOT_DELETE_WORKER_INVALID', 'Delete worker method is unavailable');
  return null;
}

function createSnapshotDeleteService(options = {}) {
  const localOperations = options.localOperations;
  const capabilityStore = options.capabilityStore;
  if (!localOperations || typeof localOperations.begin !== 'function') {
    throw new TypeError('localOperations.begin is required');
  }
  if (!capabilityStore || typeof capabilityStore.issueDelete !== 'function' ||
      typeof capabilityStore.peekDelete !== 'function' ||
      typeof capabilityStore.consumeDelete !== 'function') {
    throw new TypeError('delete capability issue/peek/consume is required');
  }
  const acquireLease = typeof options.acquireLease === 'function'
    ? options.acquireLease
    : async () => fail('SNAPSHOT_DELETE_LEASE_UNAVAILABLE', 'Delete lease is unavailable');
  const releaseLease = typeof options.releaseLease === 'function'
    ? options.releaseLease
    : async () => false;
  const settleWatcherBarrier = typeof options.settleWatcherBarrier === 'function'
    ? options.settleWatcherBarrier
    : async () => fail('SNAPSHOT_DELETE_BARRIER_UNAVAILABLE', 'Delete barrier is unavailable');
  const assertOwnerCurrent = typeof options.assertOwnerCurrent === 'function'
    ? options.assertOwnerCurrent
    : () => fail('SNAPSHOT_DELETE_OWNER_UNAVAILABLE', 'Delete owner is unavailable');
  const readSnapshotAuthority = typeof options.readSnapshotAuthority === 'function'
    ? options.readSnapshotAuthority
    : async () => fail('SNAPSHOT_DELETE_READER_UNAVAILABLE', 'Snapshot authority is unavailable');
  const readCurrentAuthority = typeof options.readCurrentAuthority === 'function'
    ? options.readCurrentAuthority
    : async () => fail('SNAPSHOT_DELETE_READER_UNAVAILABLE', 'Current authority is unavailable');
  const createProductionWorker = typeof options.createProductionWorker === 'function'
    ? options.createProductionWorker
    : async () => fail('SNAPSHOT_DELETE_WORKER_UNAVAILABLE', 'Delete worker is unavailable');
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : crypto.randomBytes;
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const destroyTimeoutMs = Number.isSafeInteger(options.destroyTimeoutMs) &&
    options.destroyTimeoutMs > 0 && options.destroyTimeoutMs <= DEFAULT_DESTROY_TIMEOUT_MS
    ? options.destroyTimeoutMs
    : DEFAULT_DESTROY_TIMEOUT_MS;

  function assertCurrent(owner, lease, operation = null) {
    if (operation) operation.assertCurrentOwner();
    try { assertOwnerCurrent(Object.freeze({ ...owner, lease })); }
    catch (error) {
      fail(stableCode(error, 'PROJECT_CHANGED'), 'Snapshot delete owner changed');
    }
    if (operation?.signal?.aborted) {
      fail(stableCode({ code: operation.abortCode() }, 'REQUEST_ABORTED'),
        'Snapshot delete was aborted');
    }
  }

  async function releaseExact(lease, owner, truth) {
    if (!lease || !['COMMITTED', 'UNCOMMITTED'].includes(truth)) return;
    try { await releaseLease(lease, Object.freeze({ ...owner, terminalTruth: truth })); }
    catch (_) {}
  }

  async function closeSettled(worker, close = null) {
    const method = close || dataMethod(worker, 'close', false);
    if (!method) return;
    try { await method(); } catch (_) {}
  }

  function startOptionalSettledCleanup(worker, includeList) {
    if (!worker) return;
    const exactWorker = worker;
    const list = includeList ? dataMethod(exactWorker, 'listCommitted', false) : null;
    const close = dataMethod(exactWorker, 'close', false);
    void (async () => {
      if (list) {
        try { await list(); } catch (_) {}
      }
      await closeSettled(exactWorker, close);
    })().catch(() => {});
  }

  async function destroyTransport(destroy) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimer(() => reject(new SnapshotDeleteServiceError(
        'SNAPSHOT_DELETE_DESTROY_TIMEOUT', 'Delete worker destroy latch timed out'
      )), destroyTimeoutMs);
    });
    let destroyed;
    try {
      destroyed = await Promise.race([
        Promise.resolve().then(() => destroy()),
        timeout,
      ]);
    } finally {
      if (timer !== null) clearTimer(timer);
    }
    if (destroyed !== true) {
      fail('SNAPSHOT_DELETE_DESTROY_FAILED', 'Delete worker destroy latch failed');
    }
  }

  async function readAuthorities(owner, snapshotId, lease, operation = null) {
    const barrierValue = await settleWatcherBarrier(Object.freeze({
      ...owner,
      lease,
      signal: operation?.signal || null,
    }));
    assertCurrent(owner, lease, operation);
    const barrier = validateBarrier(barrierValue, owner);
    const snapshotValue = await readSnapshotAuthority(Object.freeze({
      projectInstanceId: owner.projectInstanceId,
      snapshotId,
      lease,
      signal: operation?.signal || null,
    }));
    assertCurrent(owner, lease, operation);
    const snapshot = validateSnapshotAuthority(snapshotValue, owner, snapshotId);
    const currentValue = await readCurrentAuthority(Object.freeze({
      projectInstanceId: owner.projectInstanceId,
      mutationGeneration: barrier.mutationGeneration,
      lease,
      signal: operation?.signal || null,
    }));
    assertCurrent(owner, lease, operation);
    const current = validateCurrentAuthority(currentValue, owner, barrier);
    return Object.freeze({ barrier, snapshot, current });
  }

  async function prepare(rawOwner, rawRequest) {
    const owner = assertOwner(rawOwner);
    const request = assertPrepareRequest(rawRequest, owner);
    const leaseOwner = Object.freeze({ ...owner, kind: DELETE_KIND, purpose: 'prepare' });
    let lease = null;
    let issued = null;
    let issuedCapabilityId = null;
    try {
      lease = await acquireLease(leaseOwner);
      if (!lease || typeof lease !== 'object') {
        fail('SNAPSHOT_DELETE_LEASE_UNAVAILABLE', 'Delete prepare lease is invalid');
      }
      assertCurrent(owner, lease);
      const { snapshot, current } = await readAuthorities(owner, request.snapshotId, lease);
      const expectedBinding = Object.freeze({
        snapshotId: snapshot.snapshotId,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        publishedIdentityDigest: snapshot.publishedIdentityDigest,
        currentMutationGeneration: current.mutationGeneration,
        currentFileRevisionSetDigest: current.fileRevisionSetDigest,
      });
      const issuedNotBefore = nowEpoch(clock, 'delete capability issue start');
      const rawIssued = capabilityStore.issueDelete(owner, expectedBinding);
      issuedCapabilityId = safeIssuedCapabilityId(rawIssued);
      issued = validateIssued(rawIssued);
      const issuedNotAfter = nowEpoch(clock, 'delete capability issue end');
      const peeked = validatePeeked(
        capabilityStore.peekDelete(owner, {
          deleteCapabilityId: issued.capabilityId,
        }),
        owner,
        { deleteCapabilityId: issued.capabilityId },
        false,
        {
          atMs: issuedNotAfter,
          issued,
          issuedNotBefore,
          issuedNotAfter,
          expectedBinding,
        }
      );
      assertCurrent(owner, lease);
      const result = Object.freeze({
        schema: schema.SCHEMAS.SNAPSHOT_DELETE_PREFLIGHT,
        projectInstanceId: owner.projectInstanceId,
        snapshotId: snapshot.snapshotId,
        createdAt: snapshot.createdAt,
        markdownCount: snapshot.markdownCount,
        imageCount: snapshot.imageCount,
        totalBytes: snapshot.totalBytes,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        expiresAt: peeked.record.expiresAt,
        deleteCapabilityId: peeked.record.capabilityId,
      });
      exact(result, [
        'schema', 'projectInstanceId', 'snapshotId', 'createdAt', 'markdownCount',
        'imageCount', 'totalBytes', 'snapshotManifestDigest', 'expiresAt',
        'deleteCapabilityId',
      ], 'snapshot delete preflight');
      await releaseExact(lease, leaseOwner, 'UNCOMMITTED');
      lease = null;
      return result;
    } catch (error) {
      if (issuedCapabilityId && typeof capabilityStore.release === 'function') {
        try { capabilityStore.release(owner, { capabilityId: issuedCapabilityId }); } catch (_) {}
      }
      await releaseExact(lease, leaseOwner, 'UNCOMMITTED');
      if (error instanceof SnapshotDeleteServiceError) throw error;
      throw new SnapshotDeleteServiceError(
        stableCode(error, 'SNAPSHOT_DELETE_PREPARE_FAILED'),
        'Snapshot delete prepare failed closed'
      );
    }
  }

  async function commit(rawOwner, rawRequest) {
    const owner = assertOwner(rawOwner);
    const request = assertCommitRequest(rawRequest, owner);
    let operation;
    try {
      operation = localOperations.begin({
        projectInstanceId: owner.projectInstanceId,
        kind: DELETE_KIND,
        ownerGeneration: owner.ownerGeneration,
      });
      operation.start();
    } catch (error) {
      throw new SnapshotDeleteServiceError(
        stableCode(error, 'SNAPSHOT_DELETE_FAILED'),
        'Snapshot delete local operation failed closed'
      );
    }
    const taskOwner = Object.freeze({
      ...owner,
      taskId: operation.taskId,
      kind: DELETE_KIND,
      purpose: 'commit',
    });
    let lease = null;
    let worker = null;
    let workerMethods = null;
    let consumeAttempted = false;
    let peekedCapabilityId = null;
    let metadata = null;
    let terminalBasis = null;

    async function publishTerminal(truth, errorCode) {
      const intended = terminalTaskFromBasis(terminalBasis, truth, errorCode);
      let task = intended;
      try {
        const actual = cloneLocalTask(operation.terminal(truth, errorCode), intended);
        if (sameTerminalTask(actual, intended)) task = actual;
      } catch (_) {}
      await releaseExact(lease, taskOwner, truth);
      if (['COMMITTED', 'UNCOMMITTED'].includes(truth)) lease = null;
      return task;
    }

    async function reconcile(primary) {
      try { operation.stage('reconciling'); } catch (_) {}
      let destroyed = false;
      let reconciler = null;
      let reconcilerDestroy = null;
      let reconciled = null;
      let reconcileFailureCode = null;
      try {
        await destroyTransport(workerMethods.destroy);
        destroyed = true;
        worker = null;
        reconciler = await createProductionWorker(Object.freeze({
          ...taskOwner,
          lease,
          purpose: 'reconcile',
        }));
        const reconcileDelete = dataMethod(reconciler, 'reconcileDelete');
        reconcilerDestroy = dataMethod(reconciler, 'destroyForReconciliation');
        const raw = await reconcileDelete(Object.freeze({
          transactionId: metadata.transactionId,
          projectInstanceId: metadata.projectInstanceId,
          snapshotId: metadata.snapshotId,
          ownerGeneration: metadata.ownerGeneration,
          snapshotManifestDigest: metadata.snapshotManifestDigest,
          publishedIdentityDigest: metadata.publishedIdentityDigest,
          observedAt: nowIso(clock, 'reconcile'),
        }));
        reconciled = validateReconciliationTruth(raw, metadata);
      } catch (error) {
        reconciled = null;
        reconcileFailureCode = stableCode(error, 'SNAPSHOT_DELETE_RECONCILE_FAILED');
      }
      if (!reconciled && reconcilerDestroy) {
        try {
          await destroyTransport(reconcilerDestroy);
          reconciler = null;
        } catch (_) {}
      }

      let truth;
      let errorCode;
      if (reconciled?.state === 'COMMITTED') {
        const conflict = primary?.state === 'COMMITTED' &&
          (primary.deletedIdentityDigest !== reconciled.deletedIdentityDigest ||
            primary.receiptDigest !== reconciled.receiptDigest);
        truth = conflict ? 'COMMITTED_RISK' : 'COMMITTED';
        errorCode = conflict ? 'SNAPSHOT_DELETE_TRUTH_CONFLICT' : null;
      } else if (reconciled?.state === 'UNCOMMITTED') {
        if (primary?.state === 'COMMITTED') {
          truth = 'COMMITTED_RISK';
          errorCode = 'SNAPSHOT_DELETE_TRUTH_CONFLICT';
        } else {
          truth = 'UNCOMMITTED';
          errorCode = reconciled.reason;
        }
      } else if (primary?.state === 'COMMITTED') {
        truth = 'COMMITTED_RISK';
        errorCode = destroyed
          ? 'SNAPSHOT_DELETE_RECONCILE_FAILED'
          : reconcileFailureCode === 'SNAPSHOT_DELETE_DESTROY_TIMEOUT'
            ? 'SNAPSHOT_DELETE_DESTROY_TIMEOUT'
            : 'SNAPSHOT_DELETE_DESTROY_FAILED';
      } else if (primary?.state === 'UNCOMMITTED') {
        truth = 'UNCOMMITTED';
        errorCode = primary.reason;
      } else {
        truth = 'UNKNOWN';
        errorCode = destroyed
          ? 'SNAPSHOT_DELETE_UNKNOWN'
          : reconcileFailureCode === 'SNAPSHOT_DELETE_DESTROY_TIMEOUT'
            ? 'SNAPSHOT_DELETE_DESTROY_TIMEOUT'
            : 'SNAPSHOT_DELETE_DESTROY_FAILED';
      }

      const task = await publishTerminal(truth, errorCode);
      startOptionalSettledCleanup(reconciler, truth === 'COMMITTED');
      return task;
    }

    try {
      const peeked = validatePeeked(
        capabilityStore.peekDelete(owner, { deleteCapabilityId: request.deleteCapabilityId }),
        owner,
        request,
        false,
        { atMs: nowEpoch(clock, 'delete capability lookup') }
      );
      peekedCapabilityId = request.deleteCapabilityId;
      lease = await acquireLease(taskOwner);
      if (!lease || typeof lease !== 'object') {
        fail('SNAPSHOT_DELETE_LEASE_UNAVAILABLE', 'Delete commit lease is invalid');
      }
      assertCurrent(taskOwner, lease, operation);
      operation.stage('quarantining_snapshot');
      worker = await createProductionWorker(Object.freeze({
        ...taskOwner,
        lease,
        purpose: 'delete',
      }));
      assertCurrent(taskOwner, lease, operation);
      workerMethods = Object.freeze({
        delete: dataMethod(worker, 'deleteCommittedSnapshot'),
        destroy: dataMethod(worker, 'destroyForReconciliation'),
        close: dataMethod(worker, 'close', false),
      });
      const { snapshot, current } = await readAuthorities(
        taskOwner, peeked.binding.snapshotId, lease, operation
      );
      if (snapshot.snapshotManifestDigest !== peeked.binding.snapshotManifestDigest ||
          snapshot.publishedIdentityDigest !== peeked.binding.publishedIdentityDigest ||
          current.mutationGeneration !== peeked.binding.currentMutationGeneration ||
          current.fileRevisionSetDigest !== peeked.binding.currentFileRevisionSetDigest) {
        fail('STALE_SNAPSHOT_CAPABILITY', 'Snapshot delete capability authority drifted');
      }
      metadata = Object.freeze({
        transactionId: randomTransactionId(randomBytes),
        projectInstanceId: owner.projectInstanceId,
        snapshotId: snapshot.snapshotId,
        ownerGeneration: owner.ownerGeneration,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        publishedIdentityDigest: snapshot.publishedIdentityDigest,
        committedAt: nowIso(clock, 'delete'),
      });
      terminalBasis = cloneLocalTask(operation.snapshot(), {
        projectInstanceId: owner.projectInstanceId,
        taskId: operation.taskId,
      });
      consumeAttempted = true;
      const consumedAuthority = capabilityStore.consumeDelete(owner, request, {
        snapshotId: snapshot.snapshotId,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        publishedIdentityDigest: snapshot.publishedIdentityDigest,
        currentMutationGeneration: current.mutationGeneration,
        currentFileRevisionSetDigest: current.fileRevisionSetDigest,
      });
      validateConsumed(
        consumedAuthority,
        owner,
        request,
        snapshot,
        current,
        nowEpoch(clock, 'delete capability consume')
      );

      let primary = null;
      try {
        const raw = await workerMethods.delete(metadata);
        primary = validatePrimaryTruth(raw, metadata);
      } catch (_) {
        primary = null;
      }
      return reconcile(primary);
    } catch (error) {
      if (consumeAttempted && metadata && terminalBasis) {
        return reconcile(null);
      }
      const code = stableCode(error, 'SNAPSHOT_DELETE_FAILED');
      if (peekedCapabilityId &&
          ['PROJECT_CHANGED', 'SNAPSHOT_DELETE_STALE', 'STALE_SNAPSHOT_CAPABILITY']
            .includes(code) && typeof capabilityStore.release === 'function') {
        try { capabilityStore.release(owner, { capabilityId: peekedCapabilityId }); } catch (_) {}
      }
      try { operation.terminal('UNCOMMITTED', code); } catch (_) {}
      await releaseExact(lease, taskOwner, 'UNCOMMITTED');
      lease = null;
      startOptionalSettledCleanup(worker, false);
      if (error instanceof SnapshotDeleteServiceError) throw error;
      throw new SnapshotDeleteServiceError(code, 'Snapshot delete failed closed before consume');
    }
  }

  return Object.freeze({ prepare, commit });
}

module.exports = Object.freeze({
  DELETE_KIND,
  DELETE_CONFIRMATION,
  DEFAULT_DESTROY_TIMEOUT_MS,
  SnapshotDeleteServiceError,
  createSnapshotDeleteService,
});
