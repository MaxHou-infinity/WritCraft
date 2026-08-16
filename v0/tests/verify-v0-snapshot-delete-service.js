#!/usr/bin/env node
'use strict';

const assert = require('assert');
const schema = require('../src/main/evidence-delivery-schema');
const { createLocalOperationService } = require('../src/main/local-operation-service');
const { createSnapshotCapabilityStore } = require('../src/main/snapshot-capability-store');
const {
  SnapshotDeleteServiceError,
  createSnapshotDeleteService,
} = require('../src/main/snapshot-delete-service');

const PROJECT = `instance_${'a'.repeat(24)}`;
const SNAPSHOT = `snapshot_${'b'.repeat(32)}`;
const MANIFEST = `sha256:${'1'.repeat(64)}`;
const PUBLISHED = `sha256:${'2'.repeat(64)}`;
const CURRENT = `sha256:${'3'.repeat(64)}`;
const DELETED = `sha256:${'4'.repeat(64)}`;
const RECEIPT = `sha256:${'5'.repeat(64)}`;
const CREATED_AT = '2026-08-09T08:00:00.000Z';
let passed = 0;
let testChain = Promise.resolve();

function test(name, fn) {
  testChain = testChain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      console.error(`  ✗ ${name}`);
      throw error;
    }
  });
  return testChain;
}

function owner(overrides = {}) {
  return {
    ownerId: 'window_main',
    projectInstanceId: PROJECT,
    ownerGeneration: 7,
    ...overrides,
  };
}

function prepareRequest(overrides = {}) {
  return {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_PREPARE_REQUEST,
    projectInstanceId: PROJECT,
    snapshotId: SNAPSHOT,
    ...overrides,
  };
}

function commitRequest(preflight, overrides = {}) {
  return {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST,
    projectInstanceId: PROJECT,
    deleteCapabilityId: preflight.deleteCapabilityId,
    confirmation: 'DELETE_SNAPSHOT',
    ...overrides,
  };
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => {
    assert(error instanceof SnapshotDeleteServiceError);
    assert.strictEqual(error.code, code);
    assert.doesNotMatch(error.message, /(?:\/tmp\/secret|正文|rootPath|body)/u);
    return true;
  });
}

function setup(overrides = {}) {
  const state = {
    now: 1_800_000_000_000,
    activeProject: PROJECT,
    activeOwnerGeneration: 7,
    snapshot: {
      projectInstanceId: PROJECT,
      snapshotId: SNAPSHOT,
      createdAt: CREATED_AT,
      markdownCount: 3,
      imageCount: 2,
      totalBytes: 4096,
      snapshotManifestDigest: MANIFEST,
      publishedIdentityDigest: PUBLISHED,
    },
    current: {
      projectInstanceId: PROJECT,
      mutationGeneration: 11,
      fileRevisionSetDigest: CURRENT,
    },
    calls: [],
    consumed: 0,
    peeked: 0,
    issued: 0,
    y: 0,
    z: 0,
    destroyed: 0,
    listed: 0,
    released: [],
    workerRequests: [],
  };
  let random = 10;
  const realLocalOperations = createLocalOperationService({
    clock: () => state.now,
    randomBytes: size => Buffer.alloc(size, random++),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  const localOperations = overrides.localOperations
    ? overrides.localOperations(realLocalOperations, state)
    : realLocalOperations;
  state.localOperations = realLocalOperations;
  const rawStore = createSnapshotCapabilityStore({
    clock: () => state.now,
    randomBytes: size => Buffer.alloc(size, random++),
  });
  const capabilityStore = {
    issueDelete(bindingOwner, binding) {
      state.issued += 1;
      const issued = rawStore.issueDelete(bindingOwner, binding);
      if (overrides.issueDelete) {
        return overrides.issueDelete(issued, rawStore, bindingOwner, binding, state);
      }
      return issued;
    },
    peekDelete(bindingOwner, request) {
      state.peeked += 1;
      if (overrides.peekDelete) return overrides.peekDelete(rawStore, bindingOwner, request, state);
      return rawStore.peekDelete(bindingOwner, request);
    },
    consumeDelete(bindingOwner, request, current) {
      state.consumed += 1;
      if (overrides.consumeDelete) {
        return overrides.consumeDelete(rawStore, bindingOwner, request, current, state);
      }
      return rawStore.consumeDelete(bindingOwner, request, current);
    },
    release: (...args) => rawStore.release(...args),
    inspect: (...args) => rawStore.inspect(...args),
  };

  function primaryWorker() {
    return {
      async deleteCommittedSnapshot(request) {
        state.y += 1;
        state.workerRequests.push(request);
        if (overrides.primary) return overrides.primary(request, state);
        return {
          transactionId: request.transactionId,
          projectInstanceId: request.projectInstanceId,
          snapshotId: request.snapshotId,
          snapshotManifestDigest: request.snapshotManifestDigest,
          sourceIdentityDigest: request.publishedIdentityDigest,
          state: 'COMMITTED',
          deletedIdentityDigest: DELETED,
          receiptDigest: RECEIPT,
        };
      },
      async destroyForReconciliation() {
        state.destroyed += 1;
        if (overrides.destroy) return overrides.destroy(state);
        return true;
      },
      async close() { state.calls.push(['close-primary']); },
    };
  }

  function reconcileWorker() {
    return {
      async reconcileDelete(request) {
        state.z += 1;
        state.workerRequests.push(request);
        if (overrides.reconcile) return overrides.reconcile(request, state);
        return {
          transactionId: request.transactionId,
          snapshotId: request.snapshotId,
          state: 'COMMITTED',
          deletedIdentityDigest: DELETED,
          receiptDigest: RECEIPT,
        };
      },
      async listCommitted() {
        state.listed += 1;
        if (overrides.list) return overrides.list(state);
        return { items: [] };
      },
      async destroyForReconciliation() { return true; },
      async close() { state.calls.push(['close-reconciler']); },
    };
  }

  const service = createSnapshotDeleteService({
    localOperations,
    capabilityStore,
    clock: () => state.now,
    randomBytes: size => Buffer.alloc(size, random++),
    destroyTimeoutMs: overrides.destroyTimeoutMs,
    async acquireLease(binding) {
      state.calls.push(['acquire', binding.purpose]);
      if (overrides.acquireLease) return overrides.acquireLease(binding, state);
      return Object.freeze({ leaseId: `${binding.purpose}-lease-${state.calls.length}` });
    },
    async releaseLease(lease, binding) {
      state.released.push({ lease, binding });
      if (overrides.releaseLease) return overrides.releaseLease(lease, binding, state);
      return true;
    },
    assertOwnerCurrent(binding) {
      state.calls.push(['assert', binding.purpose || binding.kind]);
      if (overrides.assertOwnerCurrent) return overrides.assertOwnerCurrent(binding, state);
      if (binding.projectInstanceId !== state.activeProject ||
          binding.ownerGeneration !== state.activeOwnerGeneration) {
        throw Object.assign(new Error('/tmp/secret owner drift'), { code: 'PROJECT_CHANGED' });
      }
      return true;
    },
    async settleWatcherBarrier(binding) {
      state.calls.push(['barrier', binding.kind || binding.purpose]);
      if (overrides.barrier) return overrides.barrier(binding, state);
      return {
        projectInstanceId: PROJECT,
        mutationGeneration: state.current.mutationGeneration,
      };
    },
    async readSnapshotAuthority(binding) {
      state.calls.push(['snapshot', binding]);
      if (overrides.snapshot) return overrides.snapshot(binding, state);
      return state.snapshot;
    },
    async readCurrentAuthority(binding) {
      state.calls.push(['current', binding]);
      if (overrides.current) return overrides.current(binding, state);
      return state.current;
    },
    async createProductionWorker(binding) {
      state.calls.push(['worker', binding.purpose]);
      if (overrides.worker) return overrides.worker(binding, state, {
        primaryWorker,
        reconcileWorker,
      });
      return binding.purpose === 'delete' ? primaryWorker() : reconcileWorker();
    },
  });
  return { service, state, store: rawStore, capabilityStore };
}

async function prepared(context) {
  return context.service.prepare(owner(), prepareRequest());
}

console.log('WritCraft 0.4.0 Main-only snapshot safe-delete service tests');

test('exports a factory and returns exact frozen owner-bound delete preflight', async () => {
  assert.strictEqual(typeof createSnapshotDeleteService, 'function');
  const context = setup();
  const preflight = await prepared(context);
  assert(Object.isFrozen(preflight));
  assert.deepStrictEqual(Object.keys(preflight).sort(), [
    'createdAt', 'deleteCapabilityId', 'expiresAt', 'imageCount', 'markdownCount',
    'projectInstanceId', 'schema', 'snapshotId', 'snapshotManifestDigest', 'totalBytes',
  ].sort());
  assert.strictEqual(preflight.schema, schema.SCHEMAS.SNAPSHOT_DELETE_PREFLIGHT);
  assert.strictEqual(preflight.snapshotId, SNAPSHOT);
  assert.strictEqual(preflight.markdownCount, 3);
  assert.strictEqual(preflight.imageCount, 2);
  assert.strictEqual(preflight.totalBytes, 4096);
  assert(context.store.inspect(preflight.deleteCapabilityId));
  assert.strictEqual(context.store.inspect(preflight.deleteCapabilityId).consumedAt, null);
  assert.strictEqual(context.state.issued, 1);
  assert.strictEqual(context.state.released.length, 1);
  assert(context.state.calls.filter(call => call[0] === 'snapshot').every(call =>
    !JSON.stringify(call[1]).match(/(?:rootPath|path|body|output|正文)/u)
  ));
});

test('prepare rejects a hostile issued projection with a 2099 expiry', async () => {
  const context = setup({
    issueDelete(issued) {
      return { ...issued, expiresAt: '2099-01-01T00:00:00.000Z' };
    },
  });
  await expectCode('SNAPSHOT_DELETE_AUTHORITY_INVALID', () => prepared(context));
  assert.strictEqual(context.state.issued, 1);
  assert.strictEqual(context.store.stats().capabilities, 0);
});

test('prepare rejects old/cross-shape/getter/extra/digest capability envelopes', async () => {
  let getterCalls = 0;
  const cases = [
    value => ({
      ...value,
      record: {
        ...value.record,
        issuedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:05:00.000Z',
      },
    }),
    value => ({ ...value, record: { ...value.record, schema: schema.SCHEMAS.SNAPSHOT_DELETE_SELECTION } }),
    value => ({ ...value, record: { ...value.record, authorityDigest: `sha256:${'9'.repeat(64)}` } }),
    value => ({ ...value, record: { ...value.record, selectionDigest: `sha256:${'8'.repeat(64)}` } }),
    value => ({ ...value, record: { ...value.record, singleUse: false } }),
    value => ({ ...value, record: { ...value.record, path: '/tmp/secret' } }),
    value => {
      const record = { ...value.record };
      delete record.authorityDigest;
      Object.defineProperty(record, 'authorityDigest', {
        enumerable: true,
        get() { getterCalls += 1; return value.record.authorityDigest; },
      });
      return { ...value, record };
    },
    value => {
      const selection = {
        ...value.selection,
        snapshotId: `snapshot_${'c'.repeat(32)}`,
      };
      return {
        ...value,
        selection,
        record: {
          ...value.record,
          subjectId: selection.snapshotId,
          selectionDigest: schema.digestObject(selection.schema, selection),
        },
        binding: { ...value.binding, snapshotId: selection.snapshotId },
      };
    },
  ];
  for (const mutate of cases) {
    const context = setup({
      peekDelete(rawStore, bindingOwner, request) {
        return mutate(rawStore.peekDelete(bindingOwner, request));
      },
    });
    await expectCode('SNAPSHOT_DELETE_AUTHORITY_INVALID', () => prepared(context));
    assert.strictEqual(context.store.stats().capabilities, 0);
  }
  assert.strictEqual(getterCalls, 0);
});

test('prepare rejects extra/getter requests before lease, reads, or capability issue', async () => {
  const context = setup();
  await expectCode('SNAPSHOT_DELETE_REQUEST_INVALID', () => context.service.prepare(
    owner(), { ...prepareRequest(), path: '/tmp/secret', body: '正文' }
  ));
  let getterCalls = 0;
  const hostile = prepareRequest();
  Object.defineProperty(hostile, 'snapshotId', {
    enumerable: true,
    get() { getterCalls += 1; return SNAPSHOT; },
  });
  await expectCode('SNAPSHOT_DELETE_REQUEST_INVALID', () =>
    context.service.prepare(owner(), hostile));
  assert.strictEqual(getterCalls, 0);
  assert.strictEqual(context.state.issued, 0);
  assert.strictEqual(context.state.calls.some(call => call[0] === 'acquire'), false);
});

test('prepare owner drift after an awaited read releases only its lease and issues nothing', async () => {
  const context = setup({
    snapshot(_binding, state) {
      state.activeOwnerGeneration += 1;
      return state.snapshot;
    },
  });
  await expectCode('PROJECT_CHANGED', () => prepared(context));
  assert.strictEqual(context.state.issued, 0);
  assert.strictEqual(context.state.released.length, 1);
});

test('commit consumes once, invokes Y once, destroys transport, runs fresh Z, and returns only local-task', async () => {
  const context = setup();
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert(Object.isFrozen(task));
  schema.assertLocalTask(task);
  assert.strictEqual(task.kind, 'SNAPSHOT_DELETE');
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.strictEqual(task.errorCode, null);
  assert.strictEqual(context.state.consumed, 1);
  assert.strictEqual(context.state.y, 1);
  assert.strictEqual(context.state.destroyed, 1);
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(context.state.listed, 1);
  assert.strictEqual(context.state.released.length, 2);
  assert.deepStrictEqual(Object.keys(context.state.workerRequests[0]).sort(), [
    'committedAt', 'ownerGeneration', 'projectInstanceId', 'publishedIdentityDigest',
    'snapshotId', 'snapshotManifestDigest', 'transactionId',
  ].sort());
  assert.doesNotMatch(JSON.stringify(context.state.workerRequests), /(?:\/tmp|rootPath|body|output|正文)/u);
});

test('TTL expiry and replay fail before consume and native execution', async () => {
  const expired = setup();
  const old = await prepared(expired);
  expired.state.now += 300001;
  await expectCode('SNAPSHOT_CAPABILITY_EXPIRED', () =>
    expired.service.commit(owner(), commitRequest(old)));
  assert.strictEqual(expired.state.consumed, 0);
  assert.strictEqual(expired.state.y, 0);
  assert.strictEqual(expired.state.z, 0);

  const replayed = setup();
  const current = await prepared(replayed);
  await replayed.service.commit(owner(), commitRequest(current));
  await expectCode('SNAPSHOT_CAPABILITY_REPLAYED', () =>
    replayed.service.commit(owner(), commitRequest(current)));
  assert.strictEqual(replayed.state.consumed, 1);
  assert.strictEqual(replayed.state.y, 1);
});

test('snapshot/current authority drift blocks before consume and Y', async () => {
  const context = setup();
  const preflight = await prepared(context);
  context.state.snapshot = {
    ...context.state.snapshot,
    publishedIdentityDigest: `sha256:${'9'.repeat(64)}`,
  };
  await expectCode('STALE_SNAPSHOT_CAPABILITY', () =>
    context.service.commit(owner(), commitRequest(preflight)));
  assert.strictEqual(context.state.consumed, 0);
  assert.strictEqual(context.state.y, 0);
  assert.strictEqual(context.state.z, 0);
  assert.strictEqual(context.store.inspect(preflight.deleteCapabilityId), null);

  const readinessDrift = setup({
    worker(binding, state, workers) {
      if (binding.purpose === 'delete') {
        state.current = {
          ...state.current,
          mutationGeneration: 12,
          fileRevisionSetDigest: `sha256:${'8'.repeat(64)}`,
        };
        return workers.primaryWorker();
      }
      return workers.reconcileWorker();
    },
  });
  const readinessPreflight = await prepared(readinessDrift);
  await expectCode('STALE_SNAPSHOT_CAPABILITY', () =>
    readinessDrift.service.commit(owner(), commitRequest(readinessPreflight)));
  assert.strictEqual(readinessDrift.state.consumed, 0);
  assert.strictEqual(readinessDrift.state.y, 0);
  assert.strictEqual(readinessDrift.store.inspect(readinessPreflight.deleteCapabilityId), null);
});

test('request and peek adapter accessors/extras fail before consume and native execution', async () => {
  const requestContext = setup();
  const preflight = await prepared(requestContext);
  let getterCalls = 0;
  const hostileRequest = commitRequest(preflight);
  Object.defineProperty(hostileRequest, 'confirmation', {
    enumerable: true,
    get() { getterCalls += 1; return 'DELETE_SNAPSHOT'; },
  });
  await expectCode('SNAPSHOT_DELETE_REQUEST_INVALID', () =>
    requestContext.service.commit(owner(), hostileRequest));
  assert.strictEqual(getterCalls, 0);
  assert.strictEqual(requestContext.state.peeked, 1);

  const peekContext = setup({
    peekDelete(rawStore, bindingOwner, request, state) {
      const value = rawStore.peekDelete(bindingOwner, request);
      if (state.peeked === 1) return value;
      return { ...value, path: '/tmp/secret', body: '正文' };
    },
  });
  const peekPreflight = await prepared(peekContext);
  await expectCode('SNAPSHOT_DELETE_AUTHORITY_INVALID', () =>
    peekContext.service.commit(owner(), commitRequest(peekPreflight)));
  assert.strictEqual(peekContext.state.consumed, 0);
  assert.strictEqual(peekContext.state.y, 0);

  let workerGetterCalls = 0;
  const workerContext = setup({
    worker(binding, _state, workers) {
      if (binding.purpose !== 'delete') return workers.reconcileWorker();
      const hostile = {
        async destroyForReconciliation() { return true; },
        async close() {},
      };
      Object.defineProperty(hostile, 'deleteCommittedSnapshot', {
        enumerable: true,
        get() { workerGetterCalls += 1; return async () => {}; },
      });
      return hostile;
    },
  });
  const workerPreflight = await prepared(workerContext);
  await expectCode('SNAPSHOT_DELETE_WORKER_INVALID', () =>
    workerContext.service.commit(owner(), commitRequest(workerPreflight)));
  assert.strictEqual(workerGetterCalls, 0);
  assert.strictEqual(workerContext.state.consumed, 0);
  assert.strictEqual(workerContext.state.y, 0);

  const localAdapter = setup({
    localOperations() {
      return {
        begin() { throw new Error('/tmp/secret local body 正文'); },
      };
    },
  });
  const localPreflight = await prepared(localAdapter);
  await expectCode('SNAPSHOT_DELETE_FAILED', () =>
    localAdapter.service.commit(owner(), commitRequest(localPreflight)));
  assert.strictEqual(localAdapter.state.consumed, 0);
  assert.strictEqual(localAdapter.state.y, 0);
});

test('primary response loss reconciles committed truth on one fresh Z without replaying Y', async () => {
  const context = setup({
    primary() {
      throw Object.assign(new Error('/tmp/secret 正文 body'), {
        code: 'SNAPSHOT_RECOVERY_REQUIRED',
      });
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.strictEqual(context.state.y, 1);
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(context.state.destroyed, 1);
});

test('malformed primary truth reconciles and cannot leak path/body or invoke Y twice', async () => {
  let getterCalls = 0;
  const context = setup({
    primary(request) {
      const value = {
        transactionId: request.transactionId,
        projectInstanceId: request.projectInstanceId,
        snapshotId: request.snapshotId,
        snapshotManifestDigest: request.snapshotManifestDigest,
        sourceIdentityDigest: request.publishedIdentityDigest,
        deletedIdentityDigest: DELETED,
        receiptDigest: RECEIPT,
        path: '/tmp/secret',
        body: '正文',
      };
      Object.defineProperty(value, 'state', {
        enumerable: true,
        get() { getterCalls += 1; return 'COMMITTED'; },
      });
      return value;
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.strictEqual(context.state.y, 1);
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(getterCalls, 0);
  assert.doesNotMatch(JSON.stringify(task), /(?:\/tmp\/secret|正文|body)/u);
});

test('an exception after capability consumption reconciles without invoking Y', async () => {
  const context = setup({
    consumeDelete(rawStore, bindingOwner, request, current) {
      rawStore.consumeDelete(bindingOwner, request, current);
      throw new Error('/tmp/secret consume response body 正文');
    },
    reconcile() {
      throw Object.assign(new Error('no formal delete markers'), {
        code: 'SNAPSHOT_RECOVERY_REQUIRED',
      });
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'UNKNOWN');
  assert.strictEqual(task.errorCode, 'SNAPSHOT_DELETE_UNKNOWN');
  assert.strictEqual(context.state.consumed, 1);
  assert.strictEqual(context.state.y, 0);
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(context.state.released.length, 1);
  assert.doesNotMatch(JSON.stringify(task), /(?:\/tmp\/secret|正文|body)/u);
});

test('proven primary UNCOMMITTED survives unavailable fresh Z and releases its exact lease', async () => {
  const context = setup({
    primary(request) {
      return {
        transactionId: request.transactionId,
        projectInstanceId: request.projectInstanceId,
        snapshotId: request.snapshotId,
        snapshotManifestDigest: request.snapshotManifestDigest,
        sourceIdentityDigest: request.publishedIdentityDigest,
        state: 'UNCOMMITTED',
        reason: 'SOURCE_NOT_EXACT',
      };
    },
    reconcile() { throw Object.assign(new Error('/tmp/secret'), { code: 'SNAPSHOT_RECOVERY_REQUIRED' }); },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'UNCOMMITTED');
  assert.strictEqual(task.errorCode, 'SOURCE_NOT_EXACT');
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(context.state.released.length, 2);
});

test('destroy failure after direct COMMITTED yields COMMITTED_RISK and never releases the write lease', async () => {
  const context = setup({ destroy: () => false });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(task.errorCode, 'SNAPSHOT_DELETE_DESTROY_FAILED');
  assert.strictEqual(context.state.z, 0);
  assert.strictEqual(context.state.released.length, 1);
});

test('destroy timeout after an unavailable primary yields UNKNOWN and retains lease', async () => {
  const context = setup({
    destroyTimeoutMs: 5,
    primary() { throw Object.assign(new Error('response lost'), { code: 'SNAPSHOT_RECOVERY_REQUIRED' }); },
    destroy: () => new Promise(() => {}),
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'UNKNOWN');
  assert.strictEqual(task.errorCode, 'SNAPSHOT_DELETE_DESTROY_TIMEOUT');
  assert.strictEqual(context.state.z, 0);
  assert.strictEqual(context.state.released.length, 1);
});

test('malformed fresh Z after direct COMMITTED is COMMITTED_RISK and keeps lease', async () => {
  let getterCalls = 0;
  const context = setup({
    reconcile(request) {
      const value = { transactionId: request.transactionId, snapshotId: request.snapshotId,
        deletedIdentityDigest: DELETED, receiptDigest: RECEIPT, path: '/tmp/secret' };
      Object.defineProperty(value, 'state', {
        enumerable: true,
        get() { getterCalls += 1; return 'COMMITTED'; },
      });
      return value;
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(task.errorCode, 'SNAPSHOT_DELETE_RECONCILE_FAILED');
  assert.strictEqual(context.state.released.length, 1);
  assert.strictEqual(getterCalls, 0);
});

test('project switch after consume hides owner but disk reconciliation continues to COMMITTED', async () => {
  const context = setup({
    primary(request, state) {
      state.localOperations.invalidateProject(PROJECT, 8);
      state.activeOwnerGeneration = 8;
      return {
        transactionId: request.transactionId,
        projectInstanceId: request.projectInstanceId,
        snapshotId: request.snapshotId,
        snapshotManifestDigest: request.snapshotManifestDigest,
        sourceIdentityDigest: request.publishedIdentityDigest,
        state: 'COMMITTED',
        deletedIdentityDigest: DELETED,
        receiptDigest: RECEIPT,
      };
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.strictEqual(context.state.z, 1);
  assert.strictEqual(context.state.y, 1);
});

test('a never-settling optional list cannot delay durable COMMITTED terminal truth', async () => {
  const context = setup({
    list: () => new Promise(() => {}),
  });
  const preflight = await prepared(context);
  const outcome = await Promise.race([
    context.service.commit(owner(), commitRequest(preflight)),
    new Promise(resolve => setTimeout(() => resolve('TIMED_OUT'), 25)),
  ]);
  assert.notStrictEqual(outcome, 'TIMED_OUT');
  assert.strictEqual(outcome.terminalTruth, 'COMMITTED');
  assert.strictEqual(context.state.released.length, 2);
});

test('a never-settling optional close cannot delay durable COMMITTED terminal truth', async () => {
  const context = setup({
    worker(binding, _state, workers) {
      if (binding.purpose === 'delete') return workers.primaryWorker();
      const reconciler = workers.reconcileWorker();
      return {
        ...reconciler,
        close: () => new Promise(() => {}),
      };
    },
  });
  const preflight = await prepared(context);
  const outcome = await Promise.race([
    context.service.commit(owner(), commitRequest(preflight)),
    new Promise(resolve => setTimeout(() => resolve('TIMED_OUT'), 25)),
  ]);
  assert.notStrictEqual(outcome, 'TIMED_OUT');
  assert.strictEqual(outcome.terminalTruth, 'COMMITTED');
  assert.strictEqual(context.state.released.length, 2);
});

test('COMMITTED list failure never demotes transaction truth', async () => {
  const context = setup({
    list() { throw new Error('/tmp/secret list body 正文'); },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.strictEqual(task.errorCode, null);
  assert.strictEqual(context.state.listed, 1);
});

test('terminal adapter accessor/extra drift cannot obscure durable COMMITTED truth', async () => {
  const context = setup({
    localOperations(real) {
      return {
        begin(request) {
          const handle = real.begin(request);
          return Object.freeze({
            ...handle,
            terminal(truth, code) {
              handle.terminal(truth, code);
              return {
                ...handle.snapshot(),
                path: '/tmp/secret',
                body: '正文',
              };
            },
          });
        },
      };
    },
  });
  const preflight = await prepared(context);
  const task = await context.service.commit(owner(), commitRequest(preflight));
  assert(Object.isFrozen(task));
  schema.assertLocalTask(task);
  assert.strictEqual(task.terminalTruth, 'COMMITTED');
  assert.doesNotMatch(JSON.stringify(task), /(?:\/tmp\/secret|正文|body)/u);
});

test('a late old release carries only its exact lease while a new delete owner progresses', async () => {
  let releaseStarted;
  let releaseOld;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  const releaseGate = new Promise(resolve => { releaseOld = resolve; });
  let commitReleases = 0;
  const context = setup({
    async releaseLease(_lease, binding) {
      if (binding.purpose !== 'commit') return true;
      commitReleases += 1;
      if (commitReleases === 1) {
        releaseStarted();
        await releaseGate;
      }
      return true;
    },
  });
  const firstPreflight = await prepared(context);
  const firstPending = context.service.commit(owner(), commitRequest(firstPreflight));
  await started;
  const secondPreflight = await prepared(context);
  const secondTask = await context.service.commit(owner(), commitRequest(secondPreflight));
  assert.strictEqual(secondTask.terminalTruth, 'COMMITTED');
  releaseOld();
  const firstTask = await firstPending;
  assert.strictEqual(firstTask.terminalTruth, 'COMMITTED');
  const commitLeaseIds = context.state.released
    .filter(item => item.binding.purpose === 'commit')
    .map(item => item.lease.leaseId);
  assert.strictEqual(commitLeaseIds.length, 2);
  assert.notStrictEqual(commitLeaseIds[0], commitLeaseIds[1]);
});

testChain.then(() => {
  assert.strictEqual(passed, 22);
  console.log(`\n${passed}/${passed} Main-only snapshot safe-delete service checks passed.`);
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
