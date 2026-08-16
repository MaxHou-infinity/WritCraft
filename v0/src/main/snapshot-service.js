'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');

const CREATE_KIND = 'SNAPSHOT_CREATE';
const CREATE_CONFIRMATION = 'CREATE_SNAPSHOT';
const STAGE_BASENAME_RE = /^stage-[a-f0-9]{64}\.wcsb$/u;
const FINAL_BASENAME_RE = /^bundle-[a-f0-9]{64}\.wcsb$/u;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const PROVEN_UNCOMMITTED_OUTCOMES = new Set(['PROVEN_PRECREATE', 'PROVEN_UNCOMMITTED']);

class SnapshotServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotServiceError(code, message);
}

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function isoTimestamp(clock, field) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SNAPSHOT_CLOCK_INVALID', `${field} clock is invalid`);
  }
  return new Date(value).toISOString();
}

function randomId(prefix, randomBytes) {
  let bytes;
  try { bytes = randomBytes(16); }
  catch (_) { fail('SNAPSHOT_ID_UNAVAILABLE', 'Snapshot identity is unavailable'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    fail('SNAPSHOT_ID_UNAVAILABLE', 'Snapshot identity is unavailable');
  }
  return `${prefix}${bytes.toString('hex')}`;
}

function basename(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}.wcsb`;
}

function assertMetadata(value) {
  schema.assertOpaqueId(value.transactionId, 'transactionId');
  schema.assertOpaqueId(value.snapshotId, 'snapshotId');
  schema.assertString(value.stageBasename, 'stageBasename', {
    ascii: true, pattern: STAGE_BASENAME_RE, maxBytes: 96,
  });
  schema.assertString(value.finalBasename, 'finalBasename', {
    ascii: true, pattern: FINAL_BASENAME_RE, maxBytes: 96,
  });
}

function assertProductionTruth(value, expected) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('SNAPSHOT_PRODUCTION_INVALID', 'Snapshot production truth is invalid');
    }
    const common = ['transactionId', 'snapshotId', 'stageBasename', 'finalBasename', 'state'];
    const keys = value.state === 'COMMITTED'
      ? [...common, 'snapshotManifestDigest', 'publishedIdentityDigest', 'receiptDigest',
        'expectedPublishedIdentityDigest']
      : value.state === 'UNCOMMITTED'
        ? [...common, 'snapshotManifestDigest', 'reason']
        : [];
    if (!keys.length) fail('SNAPSHOT_PRODUCTION_INVALID', 'Snapshot production state is invalid');
    schema.assertExactKeys(value, keys, 'snapshot production truth');
    assertMetadata(value);
    if (value.transactionId !== expected.transactionId || value.snapshotId !== expected.snapshotId ||
        value.stageBasename !== expected.stageBasename ||
        value.finalBasename !== expected.finalBasename) {
      fail('SNAPSHOT_PRODUCTION_STALE', 'Snapshot production owner drifted');
    }
    schema.assertDigest(value.snapshotManifestDigest, 'snapshotManifestDigest');
    if (value.state === 'COMMITTED') {
      schema.assertDigest(value.publishedIdentityDigest, 'publishedIdentityDigest');
      schema.assertDigest(value.receiptDigest, 'receiptDigest');
      schema.assertDigest(value.expectedPublishedIdentityDigest, 'expectedPublishedIdentityDigest');
      if (value.expectedPublishedIdentityDigest !== value.publishedIdentityDigest) {
        fail('SNAPSHOT_PRODUCTION_STALE', 'Snapshot committed identity drifted');
      }
    } else {
      schema.assertString(value.reason, 'reason', {
        ascii: true, pattern: ERROR_CODE_RE, minBytes: 1, maxBytes: 64,
      });
    }
    return value.state;
  } catch (error) {
    if (error instanceof SnapshotServiceError) throw error;
    fail('SNAPSHOT_PRODUCTION_INVALID', 'Snapshot production truth is invalid');
  }
}

function assertReconciliationTruth(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('SNAPSHOT_RECONCILE_INVALID', 'Snapshot reconciliation truth is invalid');
    }
    if (value.state === 'UNCOMMITTED') {
      schema.assertExactKeys(value, ['state'], 'snapshot production reconciliation');
      return 'UNCOMMITTED';
    }
    if (value.state === 'COMMITTED') {
      schema.assertExactKeys(value, ['state', 'publishedIdentityDigest', 'receiptDigest'],
        'snapshot production reconciliation');
      schema.assertDigest(value.publishedIdentityDigest, 'publishedIdentityDigest');
      schema.assertDigest(value.receiptDigest, 'receiptDigest');
      return 'COMMITTED';
    }
    fail('SNAPSHOT_RECONCILE_INVALID', 'Snapshot reconciliation state is invalid');
  } catch (error) {
    if (error instanceof SnapshotServiceError) throw error;
    fail('SNAPSHOT_RECONCILE_INVALID', 'Snapshot reconciliation truth is invalid');
  }
}

function createSnapshotService(options = {}) {
  const localOperations = options.localOperations;
  if (!localOperations || typeof localOperations.begin !== 'function') {
    throw new TypeError('localOperations.begin is required');
  }
  const acquireLease = typeof options.acquireLease === 'function'
    ? options.acquireLease
    : async () => fail('SNAPSHOT_LEASE_UNAVAILABLE', 'Snapshot lease authority is unavailable');
  const releaseLease = typeof options.releaseLease === 'function'
    ? options.releaseLease
    : async () => {};
  const settleWatcherBarrier = typeof options.settleWatcherBarrier === 'function'
    ? options.settleWatcherBarrier
    : async () => fail('SNAPSHOT_BARRIER_UNAVAILABLE', 'Snapshot watcher barrier is unavailable');
  const assertOwnerCurrent = typeof options.assertOwnerCurrent === 'function'
    ? options.assertOwnerCurrent
    : () => fail('SNAPSHOT_OWNER_UNAVAILABLE', 'Snapshot owner authority is unavailable');
  const createProductionWorker = typeof options.createProductionWorker === 'function'
    ? options.createProductionWorker
    : async () => fail('SNAPSHOT_PRODUCTION_WORKER_UNAVAILABLE',
      'Root-bound production snapshot worker is unavailable');
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : crypto.randomBytes;

  function requestBinding(request) {
    schema.assertExactKeys(request, [
      'projectInstanceId', 'ownerGeneration', 'confirmation',
    ], 'snapshot create service request');
    schema.assertProjectInstanceId(request.projectInstanceId);
    schema.assertSafeInteger(request.ownerGeneration, 'ownerGeneration');
    if (request.confirmation !== CREATE_CONFIRMATION) {
      fail('SNAPSHOT_CONFIRMATION_REQUIRED', 'Snapshot creation requires exact confirmation');
    }
    return Object.freeze({ ...request });
  }

  async function create(rawRequest) {
    const request = requestBinding(rawRequest);
    const operation = localOperations.begin({
      projectInstanceId: request.projectInstanceId,
      kind: CREATE_KIND,
      ownerGeneration: request.ownerGeneration,
    });
    operation.start();
    const owner = Object.freeze({
      projectInstanceId: request.projectInstanceId,
      ownerGeneration: request.ownerGeneration,
      taskId: operation.taskId,
      kind: CREATE_KIND,
    });
    let lease = null;
    let worker = null;
    let metadata = null;
    let leaseReleased = false;

    function assertCurrent() {
      operation.assertCurrentOwner();
      assertOwnerCurrent(Object.freeze({ ...owner, lease }));
      if (operation.signal.aborted) {
        fail(stableCode({ code: operation.abortCode() }, 'REQUEST_ABORTED'),
          'Snapshot operation was aborted');
      }
    }

    function progress(kind) {
      const stage = kind === 'production_build'
        ? 'publishing_bundle'
        : kind === 'production_capture'
          ? 'scanning_sources'
          : 'writing_private_bundle';
      try { operation.stage(stage); } catch (_) {
        // Progress visibility must not interrupt the worker's transaction truth.
      }
    }

    async function releaseExactLease(terminalTruth) {
      if (!lease || leaseReleased || terminalTruth === 'UNKNOWN' || terminalTruth === 'COMMITTED_RISK') {
        return;
      }
      leaseReleased = true;
      try { await releaseLease(lease, Object.freeze({ ...owner, terminalTruth })); }
      catch (_) {}
    }

    async function terminal(truth, code = null) {
      await releaseExactLease(truth);
      return operation.terminal(truth, code);
    }

    async function destroyForReconciliation(target) {
      if (!target || typeof target.destroyForReconciliation !== 'function') {
        fail('SNAPSHOT_PRODUCTION_WORKER_INVALID', 'Production worker cannot be replaced safely');
      }
      let destroyed = false;
      try { destroyed = await target.destroyForReconciliation() === true; }
      catch (_) {}
      if (!destroyed) {
        fail('SNAPSHOT_PRODUCTION_WORKER_DESTROY_FAILED',
          'Production worker could not be replaced safely');
      }
      if (worker === target) worker = null;
    }

    async function closeSettled(target) {
      if (!target || typeof target.close !== 'function') return;
      try { await target.close(); } catch (_) {}
      if (worker === target) worker = null;
    }

    async function listAfterCommit(target) {
      try {
        if (!target || typeof target.listCommitted !== 'function') return;
        await target.listCommitted();
        try { assertCurrent(); } catch (_) {}
      } catch (_) {
        // Listing is a projection and cannot demote durable COMMITTED truth.
      }
    }

    async function finishCommitted(target) {
      await listAfterCommit(target);
      await closeSettled(target);
      return terminal('COMMITTED');
    }

    async function reconcileExact(metadata, oldWorker) {
      try { operation.stage('reconciling'); } catch (_) {}
      let reconciler = null;
      let durableTruth = null;
      try {
        await destroyForReconciliation(oldWorker);
        reconciler = await createProductionWorker(Object.freeze({
          ...owner,
          lease,
          purpose: 'reconcile',
          onPhase: progress,
        }));
        worker = reconciler;
        try { assertCurrent(); } catch (_) {
          // Exact disk truth must still be resolved for an invalidated UI owner.
        }
        if (!reconciler || typeof reconciler.reconcileProductionCreate !== 'function') {
          fail('SNAPSHOT_PRODUCTION_WORKER_INVALID', 'Fresh reconciliation worker is invalid');
        }
        const result = await reconciler.reconcileProductionCreate({
          transactionId: metadata.transactionId,
          snapshotId: metadata.snapshotId,
          stageBasename: metadata.stageBasename,
          finalBasename: metadata.finalBasename,
          observedAt: isoTimestamp(clock, 'reconcile'),
        });
        durableTruth = assertReconciliationTruth(result);
        try { assertCurrent(); } catch (_) {}
        if (durableTruth === 'COMMITTED') return finishCommitted(reconciler);
        await closeSettled(reconciler);
        return terminal('UNCOMMITTED', 'SNAPSHOT_CREATE_UNCOMMITTED');
      } catch (_) {
        if (durableTruth === 'COMMITTED') return finishCommitted(reconciler);
        if (durableTruth === 'UNCOMMITTED') {
          await closeSettled(reconciler);
          return terminal('UNCOMMITTED', 'SNAPSHOT_CREATE_UNCOMMITTED');
        }
        if (reconciler) {
          try { await destroyForReconciliation(reconciler); } catch (_) {}
        }
        return terminal('UNKNOWN', 'SNAPSHOT_CREATE_UNKNOWN');
      }
    }

    try {
      lease = await acquireLease(owner);
      assertCurrent();
      if (!lease || typeof lease !== 'object') {
        fail('SNAPSHOT_LEASE_INVALID', 'Snapshot lease authority is invalid');
      }

      operation.stage('settling_watcher');
      const barrier = await settleWatcherBarrier(Object.freeze({
        ...owner,
        lease,
        signal: operation.signal,
      }));
      assertCurrent();
      schema.assertExactKeys(barrier, ['projectInstanceId', 'mutationGeneration'],
        'snapshot watcher barrier result');
      if (barrier.projectInstanceId !== request.projectInstanceId) {
        fail('PROJECT_CHANGED', 'Snapshot barrier belongs to another project');
      }
      schema.assertSafeInteger(barrier.mutationGeneration, 'mutationGeneration');

      const transactionId = randomId('stx_', randomBytes);
      const snapshotId = randomId('snap_', randomBytes);
      metadata = Object.freeze({
        transactionId,
        projectInstanceId: request.projectInstanceId,
        snapshotId,
        ownerGeneration: request.ownerGeneration,
        creationMutationGeneration: barrier.mutationGeneration,
        createdAt: isoTimestamp(clock, 'create'),
        stageBasename: basename('stage', transactionId),
        finalBasename: basename('bundle', snapshotId),
      });
      assertMetadata(metadata);
      operation.stage('scanning_sources');
      worker = await createProductionWorker(Object.freeze({
        ...owner,
        lease,
        purpose: 'create',
        onPhase: progress,
      }));
      assertCurrent();
      if (!worker || typeof worker.createProductionSnapshot !== 'function' ||
          typeof worker.destroyForReconciliation !== 'function') {
        fail('SNAPSHOT_PRODUCTION_WORKER_INVALID', 'Production snapshot worker is invalid');
      }

      let result;
      try {
        result = await worker.createProductionSnapshot(Object.freeze({
          ...metadata,
          signal: operation.signal,
        }));
      } catch (error) {
        if (PROVEN_UNCOMMITTED_OUTCOMES.has(error?.captureOutcome)) {
          await closeSettled(worker);
          return terminal('UNCOMMITTED', stableCode(error, 'SNAPSHOT_CREATE_UNCOMMITTED'));
        }
        return reconcileExact(metadata, worker);
      }
      let truth;
      try { truth = assertProductionTruth(result, metadata); }
      catch (_) { return reconcileExact(metadata, worker); }
      try { assertCurrent(); } catch (_) {
        // The worker result remains durable truth even if its UI owner switched.
      }
      if (truth === 'COMMITTED') return finishCommitted(worker);
      await closeSettled(worker);
      return terminal('UNCOMMITTED', result.reason);
    } catch (error) {
      if (worker && metadata) {
        // No formal production truth was obtained. Never call legacy cleanup.
        return reconcileExact(metadata, worker);
      }
      return terminal('UNCOMMITTED', stableCode(error, 'SNAPSHOT_CREATE_FAILED'));
    }
  }

  return Object.freeze({ create });
}

module.exports = Object.freeze({
  CREATE_KIND,
  CREATE_CONFIRMATION,
  SnapshotServiceError,
  createSnapshotService,
});
