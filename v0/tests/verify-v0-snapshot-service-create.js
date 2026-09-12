'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createLocalOperationService } = require('../src/main/local-operation-service');
const { createSnapshotService } = require('../src/main/snapshot-service');
const { createSnapshotHandler } = require('../src/main/snapshot-handler');

const PROJECT_ID = `instance_${'a'.repeat(24)}`;
const MANIFEST = `sha256:${'b'.repeat(64)}`;
const PUBLISHED = `sha256:${'c'.repeat(64)}`;
const RECEIPT = `sha256:${'d'.repeat(64)}`;

// Pinned denominator: a skipped test must show up as a red, not as a smaller
// self-consistent fraction. Update this number only when tests are added or
// removed.
const EXPECTED_TEST_COUNT = 21;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition not reached');
}

function makeRandom(seed) {
  let value = seed;
  return size => {
    const bytes = Buffer.alloc(size, value);
    value += 1;
    return bytes;
  };
}

function committed(request) {
  return {
    transactionId: request.transactionId,
    snapshotId: request.snapshotId,
    stageBasename: request.stageBasename,
    finalBasename: request.finalBasename,
    state: 'COMMITTED',
    snapshotManifestDigest: MANIFEST,
    publishedIdentityDigest: PUBLISHED,
    receiptDigest: RECEIPT,
    expectedPublishedIdentityDigest: PUBLISHED,
  };
}

function uncommitted(request) {
  return {
    transactionId: request.transactionId,
    snapshotId: request.snapshotId,
    stageBasename: request.stageBasename,
    finalBasename: request.finalBasename,
    state: 'UNCOMMITTED',
    snapshotManifestDigest: MANIFEST,
    reason: 'SNAPSHOT_SOURCE_CHANGED',
  };
}

function setup(overrides = {}) {
  let now = 0;
  let ownerGeneration = 7;
  const oldLease = Object.freeze({ leaseId: 'old-lease' });
  let currentLease = oldLease;
  const calls = [];
  const updates = [];
  let workerIndex = 0;
  const localOperations = createLocalOperationService({
    clock: () => now,
    randomBytes: makeRandom(100),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    onUpdate: value => updates.push(value),
  });
  const service = createSnapshotService({
    localOperations,
    clock: () => now,
    randomBytes: makeRandom(1),
    async acquireLease(owner) {
      calls.push(['acquire', owner]);
      return oldLease;
    },
    async releaseLease(lease, binding) {
      calls.push(['release', lease, binding]);
      if (currentLease === lease) currentLease = null;
    },
    async settleWatcherBarrier(binding) {
      calls.push(['barrier', binding]);
      return { projectInstanceId: PROJECT_ID, mutationGeneration: 41 };
    },
    assertOwnerCurrent(binding) {
      calls.push(['assert', binding]);
      if (binding.ownerGeneration !== ownerGeneration ||
          (binding.lease && binding.lease !== currentLease)) {
        throw Object.assign(new Error('stale'), { code: 'PROJECT_CHANGED' });
      }
    },
    async createProductionWorker(binding) {
      calls.push(['factory', binding]);
      workerIndex += 1;
      const id = `worker-${workerIndex}`;
      const worker = {
        id,
        async createProductionSnapshot(request) {
          calls.push(['createProductionSnapshot', id, request]);
          if (overrides.create) return overrides.create(request, worker, binding, state);
          binding.onPhase('production_capture');
          binding.onPhase('production_token_begin');
          binding.onPhase('production_build');
          return committed(request);
        },
        async reconcileProductionCreate(request) {
          calls.push(['reconcileProductionCreate', id, request]);
          if (overrides.reconcile) return overrides.reconcile(request, worker, binding, state);
          return { state: 'COMMITTED', publishedIdentityDigest: PUBLISHED, receiptDigest: RECEIPT };
        },
        async listCommitted() {
          calls.push(['listCommitted', id]);
          if (overrides.list) return overrides.list(worker, state);
          return { items: [], unavailableCount: 0 };
        },
        async close() {
          calls.push(['close', id]);
          if (overrides.close) return overrides.close(worker, state);
        },
        destroyForReconciliation() {
          calls.push(['destroy', id]);
          return overrides.destroy ? overrides.destroy(worker, state) : true;
        },
      };
      return worker;
    },
    ...(overrides.options || {}),
  });
  const state = {
    service,
    localOperations,
    calls,
    updates,
    oldLease,
    setNow(value) { now = value; },
    setOwnerGeneration(value) { ownerGeneration = value; },
    replaceLease(value) { currentLease = value; },
    currentLease() { return currentLease; },
  };
  return state;
}

function request() {
  return { projectInstanceId: PROJECT_ID, ownerGeneration: 7, confirmation: 'CREATE_SNAPSHOT' };
}

function count(state, name) {
  return state.calls.filter(call => call[0] === name).length;
}

(async () => {
  console.log('Snapshot production create service verification');

  await test('single production worker receives exact G/T/U/K/B request shape and commits', async () => {
    const state = setup();
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(count(state, 'createProductionSnapshot'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
    const production = state.calls.find(call => call[0] === 'createProductionSnapshot')[2];
    assert.deepStrictEqual(Object.keys(production).sort(), [
      'createdAt', 'creationMutationGeneration', 'finalBasename', 'ownerGeneration',
      'projectInstanceId', 'signal', 'snapshotId', 'stageBasename', 'transactionId',
    ].sort());
    assert.strictEqual(production.creationMutationGeneration, 41);
    assert.strictEqual(count(state, 'listCommitted'), 1);
    assert.strictEqual(count(state, 'close'), 1);
    assert.strictEqual(count(state, 'destroy'), 0);
  });

  await test('formal production UNCOMMITTED closes and releases without reconciliation', async () => {
    const state = setup({ create: request => uncommitted(request) });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'UNCOMMITTED');
    assert.strictEqual(result.errorCode, 'SNAPSHOT_SOURCE_CHANGED');
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
    assert.strictEqual(count(state, 'destroy'), 0);
    assert.strictEqual(count(state, 'release'), 1);
  });

  await test('only worker-proven precreate or uncommitted errors bypass fresh R', async () => {
    for (const outcome of ['PROVEN_PRECREATE', 'PROVEN_UNCOMMITTED']) {
      const state = setup({
        create() {
          throw Object.assign(new Error('proven'), {
            code: 'SNAPSHOT_CAPACITY_EXCEEDED', captureOutcome: outcome,
          });
        },
      });
      const result = await state.service.create(request());
      assert.strictEqual(result.terminalTruth, 'UNCOMMITTED');
      assert.strictEqual(count(state, 'factory'), 1);
      assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
      assert.strictEqual(count(state, 'destroy'), 0);
    }
  });

  await test('STAGE_MAY_EXIST destroys old worker and uses one fresh exact R only', async () => {
    let createRequest;
    const state = setup({
      create(value) {
        createRequest = value;
        throw Object.assign(new Error('lost B response'), {
          code: 'SNAPSHOT_RECOVERY_REQUIRED', captureOutcome: 'STAGE_MAY_EXIST',
        });
      },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(count(state, 'factory'), 2);
    assert.strictEqual(count(state, 'createProductionSnapshot'), 1);
    assert.strictEqual(count(state, 'destroy'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 1);
    const reconciliation = state.calls.find(call => call[0] === 'reconcileProductionCreate')[2];
    assert.deepStrictEqual(Object.keys(reconciliation).sort(), [
      'finalBasename', 'observedAt', 'snapshotId', 'stageBasename', 'transactionId',
    ].sort());
    for (const key of ['transactionId', 'snapshotId', 'stageBasename', 'finalBasename']) {
      assert.strictEqual(reconciliation[key], createRequest[key]);
    }
  });

  await test('fresh R cannot start until the old production worker confirms exit', async () => {
    const exitGate = deferred();
    const state = setup({
      create() {
        throw Object.assign(new Error('late B may still publish'), {
          code: 'SNAPSHOT_RECOVERY_REQUIRED', captureOutcome: 'STAGE_MAY_EXIST',
        });
      },
      async destroy(worker) {
        if (worker.id === 'worker-1') await exitGate.promise;
        return true;
      },
    });
    const pending = state.service.create(request());
    await until(() => count(state, 'destroy') === 1);
    assert.strictEqual(count(state, 'factory'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
    exitGate.resolve();
    assert.strictEqual((await pending).terminalTruth, 'COMMITTED');
    assert.strictEqual(count(state, 'factory'), 2);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 1);
  });

  await test('malformed production response never falls back and reconciles with fresh worker', async () => {
    const state = setup({ create: request => ({ ...committed(request), extra: true }) });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(count(state, 'createProductionSnapshot'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 1);
    assert.strictEqual(count(state, 'destroy'), 1);
  });

  await test('fresh reconciliation UNCOMMITTED releases exact lease and performs no cleanup replay', async () => {
    const state = setup({
      create() { throw new Error('raw transport loss'); },
      reconcile() { return { state: 'UNCOMMITTED' }; },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'UNCOMMITTED');
    assert.strictEqual(count(state, 'createProductionSnapshot'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 1);
    assert.strictEqual(count(state, 'release'), 1);
    assert.strictEqual(count(state, 'listCommitted'), 0);
  });

  await test('unavailable fresh reconciliation is UNKNOWN and keeps exact lease', async () => {
    const state = setup({
      create() { throw new Error('raw transport loss'); },
      reconcile() { throw Object.assign(new Error('R unavailable'), { code: 'SNAPSHOT_STORAGE_IO' }); },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'UNKNOWN');
    assert.strictEqual(count(state, 'factory'), 2);
    assert.strictEqual(count(state, 'destroy'), 2);
    assert.strictEqual(count(state, 'release'), 0);
    assert.strictEqual(state.currentLease(), state.oldLease);
  });

  await test('old worker destruction failure blocks fresh R and remains UNKNOWN', async () => {
    const state = setup({
      create() { throw Object.assign(new Error('lost'), { captureOutcome: 'STAGE_MAY_EXIST' }); },
      destroy() { return false; },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'UNKNOWN');
    assert.strictEqual(count(state, 'factory'), 1);
    assert.strictEqual(count(state, 'destroy'), 1);
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
    assert.strictEqual(count(state, 'release'), 0);
  });

  await test('project invalidation after response loss cannot block fresh exact R or revive old UI', async () => {
    let visibleAfterSwitch;
    let state;
    state = setup({
      create() {
        state.localOperations.invalidateProject(PROJECT_ID, 8);
        state.setOwnerGeneration(8);
        visibleAfterSwitch = state.updates.length;
        throw Object.assign(new Error('lost'), { captureOutcome: 'STAGE_MAY_EXIST' });
      },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 1);
    assert.strictEqual(state.updates.length, visibleAfterSwitch);
  });

  await test('postcommit list failure remains COMMITTED', async () => {
    const state = setup({ list() { throw new Error('list failed'); } });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(result.errorCode, null);
    assert.strictEqual(count(state, 'release'), 1);
  });

  await test('10-second pre-B cancellation is worker-proven UNCOMMITTED', async () => {
    const gate = deferred();
    let state;
    state = setup({
      async create(request, _worker, binding) {
        binding.onPhase('production_capture');
        await gate.promise;
        assert.strictEqual(request.signal.aborted, true);
        throw Object.assign(new Error('aborted'), {
          code: 'SNAPSHOT_CAPTURE_ABORTED', captureOutcome: 'PROVEN_UNCOMMITTED',
        });
      },
    });
    const pending = state.service.create(request());
    await until(() => count(state, 'createProductionSnapshot') === 1);
    state.setNow(10000);
    const taskId = state.updates.at(-1).taskId;
    state.localOperations.cancel({ projectInstanceId: PROJECT_ID, taskId });
    gate.resolve();
    const result = await pending;
    assert.strictEqual(result.terminalTruth, 'UNCOMMITTED');
    assert.strictEqual(count(state, 'reconcileProductionCreate'), 0);
  });

  await test('B phase disables local cancellation and never invokes legacy cleanup', async () => {
    const gate = deferred();
    let state;
    state = setup({
      async create(request, _worker, binding) {
        binding.onPhase('production_capture');
        binding.onPhase('production_build');
        await gate.promise;
        return committed(request);
      },
    });
    const pending = state.service.create(request());
    await until(() => state.updates.at(-1)?.stage === 'publishing_bundle');
    state.setNow(10000);
    assert.throws(
      () => state.localOperations.cancel({
        projectInstanceId: PROJECT_ID,
        taskId: state.updates.at(-1).taskId,
      }),
      error => error.code === 'LOCAL_TASK_NOT_CANCELABLE'
    );
    gate.resolve();
    assert.strictEqual((await pending).terminalTruth, 'COMMITTED');
  });

  await test('old terminal release cannot clear a replacement lease', async () => {
    const replacement = Object.freeze({ leaseId: 'new-lease' });
    let state;
    state = setup({
      list() {
        state.replaceLease(replacement);
        return { items: [], unavailableCount: 0 };
      },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.strictEqual(state.currentLease(), replacement);
    assert.strictEqual(state.calls.find(call => call[0] === 'release')[1], state.oldLease);
  });

  await test('missing production worker fails closed before any filesystem transaction', async () => {
    const state = setup({
      options: {
        createProductionWorker: undefined,
      },
    });
    const result = await state.service.create(request());
    assert.strictEqual(result.terminalTruth, 'UNCOMMITTED');
    assert.strictEqual(result.errorCode, 'SNAPSHOT_PRODUCTION_WORKER_UNAVAILABLE');
    assert.strictEqual(count(state, 'factory'), 0);
    assert.strictEqual(count(state, 'createProductionSnapshot'), 0);
  });

  await test('App handler lists only public committed snapshot metadata under Main owner authority', async () => {
    const binding = Object.freeze({ webContentsId: 7, projectInstanceId: PROJECT_ID, ownerGeneration: 11 });
    const calls = [];
    const handler = createSnapshotHandler({
      assertTrustedSender(event) { assert.strictEqual(event.sender.id, 7); },
      getCurrentProject: () => ({ instanceId: PROJECT_ID, rootPath: '/private/project' }),
      captureBinding: () => binding,
      sameBinding: (left, right) => left === right,
      storageAvailable: () => true,
      async createWorker() {
        return {
          async ready() {},
          async listCommitted() {
            return { items: [{
              snapshotId: `snap_${'1'.repeat(32)}`,
              size: 321,
              snapshotManifestDigest: MANIFEST,
            }], unavailableCount: 0 };
          },
          async readCommittedSnapshot() {
            return { manifest: {
              createdAt: '2026-08-14T00:00:00.000Z',
              files: [{ path: 'chapter.md', kind: 'markdown' }, { path: 'image.png', kind: 'image' }],
            } };
          },
          async close() { calls.push(['close']); },
        };
      },
      snapshotService: { async create() { throw new Error('not used'); } },
      localOperations: { cancel() { throw new Error('not used'); } },
    });
    const result = await handler.list({ sender: { id: 7 } }, {
      schema: 'writcraft.snapshot-list-request/v1', projectInstanceId: PROJECT_ID,
    });
    assert.deepStrictEqual(Object.keys(result.items[0]).sort(), [
      'createdAt', 'imageCount', 'markdownCount', 'snapshotId',
      'snapshotManifestDigest', 'status', 'totalBytes',
    ].sort());
    assert.strictEqual(result.items[0].markdownCount, 1);
    assert.strictEqual(result.items[0].imageCount, 1);
    assert.strictEqual(result.capacity.maxSnapshots, 20);
    assert.strictEqual(result.capacity.maxPrivateBytes, 2 * 1024 * 1024 * 1024);
    assert.deepStrictEqual(calls, [['close']]);
    assert.strictEqual(JSON.stringify(result).includes('/private/project'), false);
    assert.strictEqual(JSON.stringify(result).includes('chapter.md'), false);
  });

  await test('App handler injects Main owner generation and exact create confirmation', async () => {
    const binding = Object.freeze({ webContentsId: 9, projectInstanceId: PROJECT_ID, ownerGeneration: 17 });
    let received = null;
    const worker = {
      async ready() {}, async listCommitted() { return { items: [], unavailableCount: 0 }; },
      async close() {},
    };
    const handler = createSnapshotHandler({
      assertTrustedSender() {},
      getCurrentProject: () => ({ instanceId: PROJECT_ID, rootPath: '/private/project' }),
      captureBinding: () => binding,
      sameBinding: (left, right) => left === right,
      storageAvailable: () => true,
      async createWorker() { return worker; },
      snapshotService: { async create(value) { received = value; return { terminalTruth: 'COMMITTED' }; } },
      localOperations: { cancel() {} },
    });
    const result = await handler.create({ sender: { id: 9 } }, {
      schema: 'writcraft.snapshot-create-request/v1',
      projectInstanceId: PROJECT_ID,
      confirmation: 'CREATE_SNAPSHOT',
    });
    assert.strictEqual(result.terminalTruth, 'COMMITTED');
    assert.deepStrictEqual(received, {
      projectInstanceId: PROJECT_ID,
      ownerGeneration: 17,
      confirmation: 'CREATE_SNAPSHOT',
    });
  });

  await test('App handler blocks create when private capacity is full and never invokes mutation service', async () => {
    const binding = Object.freeze({ webContentsId: 10, projectInstanceId: PROJECT_ID, ownerGeneration: 18 });
    let createCalls = 0;
    const items = Array.from({ length: 20 }, (_, index) => ({
      snapshotId: `snap_${String(index).padStart(32, '0')}`,
      size: 1,
      snapshotManifestDigest: MANIFEST,
    }));
    const handler = createSnapshotHandler({
      assertTrustedSender() {},
      getCurrentProject: () => ({ instanceId: PROJECT_ID, rootPath: '/private/project' }),
      captureBinding: () => binding,
      sameBinding: (left, right) => left === right,
      storageAvailable: () => true,
      async createWorker() {
        return {
          async ready() {}, async listCommitted() { return { items, unavailableCount: 0 }; },
          async readCommittedSnapshot() { return { manifest: { createdAt: '2026-08-14T00:00:00.000Z', files: [] } }; },
          async close() {},
        };
      },
      snapshotService: { async create() { createCalls += 1; } },
      localOperations: { cancel() {} },
    });
    await assert.rejects(handler.create({ sender: { id: 10 } }, {
      schema: 'writcraft.snapshot-create-request/v1',
      projectInstanceId: PROJECT_ID,
      confirmation: 'CREATE_SNAPSHOT',
    }), error => error.code === 'SNAPSHOT_CAPACITY_EXCEEDED');
    assert.strictEqual(createCalls, 0);
  });

  await test('App handler lists an uninitialized private store as empty without creating it', async () => {
    const binding = Object.freeze({ webContentsId: 11, projectInstanceId: PROJECT_ID, ownerGeneration: 19 });
    let workers = 0;
    const handler = createSnapshotHandler({
      assertTrustedSender() {},
      getCurrentProject: () => ({ instanceId: PROJECT_ID, rootPath: '/private/project' }),
      captureBinding: () => binding,
      sameBinding: (left, right) => left === right,
      storageAvailable: () => false,
      async createWorker() { workers += 1; throw new Error('must not create worker'); },
      snapshotService: { async create() { throw new Error('not used'); } },
      localOperations: { cancel() {} },
    });
    const result = await handler.list({ sender: { id: 11 } }, {
      schema: 'writcraft.snapshot-list-request/v1', projectInstanceId: PROJECT_ID,
    });
    assert.deepStrictEqual(result.items, []);
    assert.strictEqual(result.capacity.usedSnapshots, 0);
    assert.strictEqual(workers, 0);
  });

  await test('App handler rechecks owner after worker close before returning list metadata', async () => {
    const bindingA = Object.freeze({ webContentsId: 12, projectInstanceId: PROJECT_ID, ownerGeneration: 20 });
    const bindingB = Object.freeze({ webContentsId: 12, projectInstanceId: PROJECT_ID, ownerGeneration: 21 });
    let current = bindingA;
    const handler = createSnapshotHandler({
      assertTrustedSender() {},
      getCurrentProject: () => ({ instanceId: PROJECT_ID, rootPath: '/private/project' }),
      captureBinding: () => current,
      sameBinding: (left, right) => left === right,
      storageAvailable: () => true,
      async createWorker() {
        return {
          async ready() {},
          async listCommitted() { return { items: [], unavailableCount: 0 }; },
          async close() { current = bindingB; },
        };
      },
      snapshotService: { async create() { throw new Error('not used'); } },
      localOperations: { cancel() {} },
    });
    await assert.rejects(handler.list({ sender: { id: 12 } }, {
      schema: 'writcraft.snapshot-list-request/v1', projectInstanceId: PROJECT_ID,
    }), error => error?.code === 'SNAPSHOT_STALE');
  });

  await test('service source has no legacy stage, sourceCapture, or zero-digest fallback', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'snapshot-service.js'),
      'utf8'
    );
    assert.match(source, /createProductionSnapshot/u);
    assert.match(source, /reconcileProductionCreate/u);
    assert.doesNotMatch(source, /sourceCapture|publishStage|cancelStage|UNKNOWN_EXPECTED_PUBLISHED_DIGEST/u);
    assert.doesNotMatch(source, /createStage|writeStage|finalizeStage|reconcileCreate/u);
  });

  assert.strictEqual(passed, EXPECTED_TEST_COUNT,
    `expected ${EXPECTED_TEST_COUNT} snapshot create service tests, ran ${passed}`);
  console.log(`Snapshot production create service verification: ${passed}/${EXPECTED_TEST_COUNT} passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
