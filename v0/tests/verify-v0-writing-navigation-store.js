'use strict';

const assert = require('assert');
const crypto = require('crypto');
const storeModule = require('../src/main/writing-navigation-store');
const navigationService = require('../src/main/writing-navigation-service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const OWNER = 'webContents:7';
const PROJECT = 'instance_0123456789abcdef01234567';
const ROOT = '/tmp/writcraft-project';

const CHAPTER = '# 第一章\n\n这是作者已经写下的正文证据。\n';

function fakeProject() {
  const files = { 'edit.md': '# Prompt\n', 'chapters/01.md': CHAPTER };
  return {
    listTree: () => [
      { type: 'file', path: 'edit.md' },
      { type: 'directory', path: 'chapters', children: [{ type: 'file', path: 'chapters/01.md' }] },
    ],
    readFileWithRevision(_root, filePath) {
      return {
        content: files[filePath],
        revision: crypto.createHash('sha256').update(files[filePath]).digest('hex'),
      };
    },
  };
}

async function record(index = 1, action = 'changes', goal = `下一步 ${index}`) {
  const proposal = await navigationService.proposeWritingNavigation({
    projectService: fakeProject(),
    rootPath: ROOT,
    request: {
      schema: navigationService.REQUEST_SCHEMA,
      mode: 'navigation',
      goal,
      currentFilePath: 'chapters/01.md',
      contextPaths: [],
    },
    randomBytes: size => Buffer.alloc(size, index),
    callLLM: async (_messages, _model, _tokens, options) => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: navigationService.TOOL_NAME,
        input: {
          mode: 'navigation',
          suggestions: [{
            finding: '这里需要继续推进。',
            evidenceRefs: [
              options.tools[0].input_schema.properties.suggestions.items.properties
                .evidenceRefs.items.enum[0],
            ],
            whyNow: '现在处理最清晰。',
            editIntent: 'clarify',
            expectedResult: '结构更清楚。',
            action,
          }],
        },
      },
    }),
  });
  return proposal.record;
}

function binding(extra = {}) {
  return {
    ownerId: OWNER,
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 3,
    navigationEpoch: 2,
    ...extra,
  };
}

let attemptCounter = 0;
function actionBinding(extra = {}) {
  attemptCounter += 1;
  return binding({
    attemptId: `wno_${attemptCounter.toString(16).padStart(32, '0')}`,
    ...extra,
  });
}

function deterministicBytes() {
  let index = 0;
  return size => {
    index += 1;
    return Buffer.alloc(size, index);
  };
}

(async () => {
  console.log('\nWriting navigation store verification');

  await test('installs an owner-bound result and issues one Changes capability', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record() }));
    assert.match(result.suggestions[0].actionId, /^wna_[a-f0-9]{32}$/);
    assert.strictEqual(result.suggestions[0].actionIds, undefined);
    assert.strictEqual(store.get(binding({ navigationId: result.navigationId })).navigationId, result.navigationId);
    assert.strictEqual(store.stats().results, 1);
    assert.strictEqual(store.stats().actions, 1);
  });

  await test('Changes consumes its single capability after successful handoff', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(3) }));
    const lease = store.acquireAction(actionBinding({ actionId: result.suggestions[0].actionId }));
    assert.strictEqual(lease.suggestion.action, 'changes');
    assert.strictEqual(lease.repeatable, false);
    assert.strictEqual(store.settleAction(binding({ leaseId: lease.leaseId, outcome: 'success' })).consumed, true);
    assert.throws(
      () => store.acquireAction(actionBinding({ actionId: result.suggestions[0].actionId })),
      error => error.code === 'ACTION_NOT_FOUND'
    );
  });

  await test('a review-ready Changes action remains reusable only after the review is settled', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(31, 'changes') }));
    const actionId = result.suggestions[0].actionId;
    const lease = store.acquireAction(actionBinding({ actionId }));
    const settled = store.settleAction(binding({ leaseId: lease.leaseId, outcome: 'review_ready' }));
    assert.strictEqual(settled.consumed, false);
    const adjusted = store.acquireAction(actionBinding({ actionId, attemptId: `wno_${'e'.repeat(32)}` }));
    assert.strictEqual(adjusted.suggestion.action, 'changes');
    store.settleAction(binding({ leaseId: adjusted.leaseId, outcome: 'success' }));
    assert.throws(() => store.acquireAction(actionBinding({ actionId })), error => error.code === 'ACTION_NOT_FOUND');
  });

  await test('REVIEW_IN_PROGRESS style retryable settlement preserves the action', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(5, 'changes') }));
    const actionId = result.suggestions[0].actionId;
    const first = store.acquireAction(actionBinding({ actionId }));
    assert.strictEqual(store.settleAction(binding({
      leaseId: first.leaseId,
      outcome: 'review_in_progress',
    })).consumed, false);
    assert.doesNotThrow(() => store.acquireAction(actionBinding({ actionId })));
  });

  await test('retryable failures and explicit cancellation preserve a current action', async () => {
    for (const outcome of ['retryable_failure', 'cancelled']) {
      const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
      const result = store.install(binding({ record: await record(51, 'changes', outcome) }));
      const actionId = result.suggestions[0].actionId;
      const lease = store.acquireAction(actionBinding({ actionId }));
      assert.strictEqual(store.settleAction(binding({
        leaseId: lease.leaseId,
        outcome,
      })).consumed, false);
      assert.doesNotThrow(() => store.acquireAction(actionBinding({ actionId })));
    }
  });

  await test('owner-bound cancel aborts only the active lease and allows retry', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(52, 'changes', 'cancel') }));
    const actionId = result.suggestions[0].actionId;
    const attemptId = `wno_${'a'.repeat(32)}`;
    const lease = store.acquireAction(binding({ actionId, attemptId }));
    assert.strictEqual(lease.signal.aborted, false);
    assert.deepStrictEqual(store.cancelAction(binding({ actionId, attemptId })), {
      actionId,
      cancelled: true,
    });
    assert.strictEqual(lease.signal.aborted, true);
    assert.throws(
      () => store.cancelAction(binding({ actionId, attemptId })),
      error => error.code === 'ATTEMPT_NOT_ACTIVE'
    );
    assert.doesNotThrow(() => store.acquireAction(actionBinding({ actionId })));
  });

  await test('a late cancel from attempt A cannot abort retry attempt B', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(53, 'changes', 'attempt') }));
    const actionId = result.suggestions[0].actionId;
    const attemptA = `wno_${'b'.repeat(32)}`;
    const attemptB = `wno_${'c'.repeat(32)}`;
    const first = store.acquireAction(binding({ actionId, attemptId: attemptA }));
    store.settleAction(binding({ leaseId: first.leaseId, outcome: 'retryable_failure' }));
    const second = store.acquireAction(binding({ actionId, attemptId: attemptB }));
    assert.throws(
      () => store.cancelAction(binding({ actionId, attemptId: attemptA })),
      error => error.code === 'ATTEMPT_NOT_ACTIVE'
    );
    assert.strictEqual(second.signal.aborted, false);
    assert.deepStrictEqual(store.cancelAction(binding({ actionId, attemptId: attemptB })), {
      actionId,
      cancelled: true,
    });
    assert.strictEqual(second.signal.aborted, true);
  });

  await test('concurrent replay terminates the single-use action', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const result = store.install(binding({ record: await record(6, 'changes') }));
    const actionId = result.suggestions[0].actionId;
    const first = store.acquireAction(actionBinding({ actionId }));
    assert.strictEqual(store.assertLeaseCurrent(binding({ leaseId: first.leaseId })).action, 'changes');
    assert.throws(
      () => store.acquireAction(actionBinding({ actionId })),
      error => error.code === 'ACTION_REPLAYED'
    );
    assert.strictEqual(first.signal.aborted, true);
    assert.throws(
      () => store.assertLeaseCurrent(binding({ leaseId: first.leaseId })),
      error => error.code === 'LEASE_NOT_FOUND'
    );
    assert.throws(
      () => store.acquireAction(actionBinding({ actionId })),
      error => error.code === 'ACTION_NOT_FOUND'
    );
  });

  await test('foreign owner or project cannot observe or destroy another action', async () => {
    for (const changed of [
      { ownerId: 'webContents:8' },
      { projectInstanceId: 'instance_abcdef0123456789abcdef01' },
    ]) {
      const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
      const result = store.install(binding({ record: await record(7) }));
      const actionId = result.suggestions[0].actionId;
      assert.throws(
        () => store.acquireAction(actionBinding({ actionId, ...changed })),
        error => error.code === 'ACTION_NOT_FOUND'
      );
      assert.doesNotThrow(() => store.acquireAction(actionBinding({ actionId })));
    }
  });

  await test('same-owner root, generation or navigation epoch drift terminates the action', async () => {
    for (const changed of [
      { rootPath: '/tmp/other-project' },
      { mutationGeneration: 4 },
      { navigationEpoch: 3 },
    ]) {
      const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
      const result = store.install(binding({ record: await record(7) }));
      const actionId = result.suggestions[0].actionId;
      assert.throws(
        () => store.acquireAction(actionBinding({ actionId, ...changed })),
        error => error.code === 'STALE_NAVIGATION'
      );
      assert.throws(
        () => store.acquireAction(actionBinding({ actionId })),
        error => error.code === 'ACTION_NOT_FOUND'
      );
    }
  });

  await test('TTL expiry and ninth-result eviction revoke child actions', async () => {
    let now = 100;
    const ttlStore = storeModule.createWritingNavigationStore({
      clock: () => now,
      ttlMs: 50,
      randomBytes: deterministicBytes(),
    });
    const expiring = ttlStore.install(binding({ record: await record(8) }));
    const expiringLease = ttlStore.acquireAction(actionBinding({
      actionId: expiring.suggestions[0].actionId,
    }));
    now = 150;
    assert.throws(
      () => ttlStore.settleAction(binding({
        leaseId: expiringLease.leaseId,
        outcome: 'success',
      })),
      error => error.code === 'LEASE_NOT_FOUND'
    );
    assert.strictEqual(expiringLease.signal.aborted, true);

    const evictionStore = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const first = evictionStore.install(binding({ record: await record(10) }));
    for (let index = 11; index <= 18; index += 1) {
      evictionStore.install(binding({ record: await record(index) }));
    }
    assert.deepStrictEqual(evictionStore.stats(), { results: 8, actions: 8, leases: 0 });
    assert.throws(
      () => evictionStore.acquireAction(actionBinding({ actionId: first.suggestions[0].actionId })),
      error => error.code === 'ACTION_NOT_FOUND'
    );
  });

  await test('the global eight-result cap preserves isolation while evicting the oldest result', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const ownerBRecord = await record(30);
    const ownerB = store.install(binding({ ownerId: 'webContents:8', record: ownerBRecord }));
    const ownerBLease = store.acquireAction(actionBinding({
      ownerId: 'webContents:8',
      actionId: ownerB.suggestions[0].actionId,
    }));
    for (let index = 31; index <= 39; index += 1) {
      store.install(binding({ record: await record(index) }));
    }
    assert.strictEqual(store.stats().results, 8);
    assert.strictEqual(ownerBLease.signal.aborted, true);
    assert.throws(
      () => store.get(binding({
        ownerId: 'webContents:8',
        navigationId: ownerB.navigationId,
      })),
      error => error.code === 'NAVIGATION_NOT_FOUND'
    );
  });

  await test('same verified navigation ID remains isolated across owners and projects', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const shared = await record(40);
    const ownerA = store.install(binding({ record: shared }));
    const ownerB = store.install(binding({ ownerId: 'webContents:8', record: shared }));
    const projectB = store.install(binding({
      projectInstanceId: 'instance_abcdef0123456789abcdef01',
      record: shared,
    }));
    assert.strictEqual(ownerA.navigationId, ownerB.navigationId);
    assert.strictEqual(ownerA.navigationId, projectB.navigationId);
    assert.strictEqual(store.stats().results, 3);
  });

  await test('two identical explicit generations install with fresh IDs and independent actions', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const firstRecord = await record(50, 'changes', '完全相同的用户目标');
    const secondRecord = await record(51, 'changes', '完全相同的用户目标');
    const first = store.install(binding({ record: firstRecord }));
    const second = store.install(binding({ record: secondRecord }));
    assert.notStrictEqual(first.navigationId, second.navigationId);
    assert.notStrictEqual(first.suggestions[0].actionId, second.suggestions[0].actionId);
    assert.strictEqual(store.stats().results, 2);
  });

  await test('unverified caller-made records cannot receive an action capability', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const verified = await record(41);
    const forged = JSON.parse(JSON.stringify(verified));
    assert.throws(
      () => store.install(binding({ record: forged })),
      error => error.code === 'INVALID_NAVIGATION_RECORD'
    );
  });

  await test('parking preserves the latest record, aborts old work and restores fresh capabilities', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const installed = store.install(binding({ record: await record(42, 'changes', '恢复测试') }));
    const oldActionId = installed.suggestions[0].actionId;
    const running = store.acquireAction(actionBinding({ actionId: oldActionId }));

    assert.strictEqual(store.parkProject({ ownerId: OWNER, projectInstanceId: PROJECT }), 1);
    assert.strictEqual(running.signal.aborted, true);
    assert.strictEqual(store.stats().results, 1);
    assert.strictEqual(store.stats().actions, 0);
    assert.strictEqual(store.peekRestorable(OWNER, ROOT).navigationId, installed.navigationId);
    assert.throws(
      () => store.get(binding({ navigationId: installed.navigationId })),
      error => error.code === 'NAVIGATION_NOT_FOUND'
    );

    const restoredBinding = binding({
      projectInstanceId: 'instance_abcdef0123456789abcdef01',
      mutationGeneration: 8,
      navigationEpoch: 9,
    });
    const restored = store.restoreLatest({
      ...restoredBinding,
      navigationId: installed.navigationId,
    });
    assert.strictEqual(restored.navigationId, installed.navigationId);
    assert.notStrictEqual(restored.suggestions[0].actionId, oldActionId);
    assert.strictEqual(store.peekRestorable(OWNER, ROOT), null);
    assert.strictEqual(store.stats().actions, 1);
    assert.throws(
      () => store.acquireAction(actionBinding({ actionId: oldActionId })),
      error => error.code === 'ACTION_NOT_FOUND'
    );
    assert.strictEqual(store.acquireAction({
      ...restoredBinding,
      actionId: restored.suggestions[0].actionId,
      attemptId: `wno_${'d'.repeat(32)}`,
    }).suggestion.action, 'changes');
  });

  await test('failed capability remint leaves the parked record intact with no orphan actions', async () => {
    let call = 0;
    const bytes = size => {
      call += 1;
      if (call === 1) return Buffer.alloc(size, 1);
      return Buffer.alloc(size, 2);
    };
    const store = storeModule.createWritingNavigationStore({ randomBytes: bytes });
    const installed = store.install(binding({ record: await record(44, 'changes', '原子恢复') }));
    store.parkProject({ ownerId: OWNER, projectInstanceId: PROJECT });
    store.install(binding({ record: await record(45, 'changes', '占用能力') }));
    assert.throws(() => store.restoreLatest({
      ...binding({ projectInstanceId: 'instance_abcdef0123456789abcdef01' }),
      navigationId: installed.navigationId,
    }), error => error.code === 'CAPABILITY_COLLISION');
    assert.strictEqual(store.peekRestorable(OWNER, ROOT).navigationId, installed.navigationId);
    assert.deepStrictEqual(store.stats(), { results: 2, actions: 1, leases: 0 });
  });

  await test('hard invalidation deletes parked records instead of making them restorable', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    store.install(binding({ record: await record(43, 'changes', '硬失效') }));
    assert.strictEqual(store.parkProject({ ownerId: OWNER, projectInstanceId: PROJECT }), 1);
    assert.strictEqual(store.invalidateProject({ ownerId: OWNER, projectInstanceId: PROJECT }), 1);
    assert.strictEqual(store.peekRestorable(OWNER, ROOT), null);
    assert.deepStrictEqual(store.stats(), { results: 0, actions: 0, leases: 0 });
  });

  await test('project invalidation is scoped to the exact owner and instance', async () => {
    const store = storeModule.createWritingNavigationStore({ randomBytes: deterministicBytes() });
    const first = store.install(binding({ record: await record(19) }));
    const otherOwner = store.install(binding({
      ownerId: 'webContents:8',
      record: await record(20),
    }));
    assert.strictEqual(store.invalidateProject({ ownerId: OWNER, projectInstanceId: PROJECT }), 1);
    assert.throws(
      () => store.get(binding({ navigationId: first.navigationId })),
      error => error.code === 'NAVIGATION_NOT_FOUND'
    );
    assert.strictEqual(store.get(binding({
      ownerId: 'webContents:8',
      navigationId: otherOwner.navigationId,
    })).navigationId, otherOwner.navigationId);
  });

  console.log(`\n${passed}/${passed} writing-navigation store checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
