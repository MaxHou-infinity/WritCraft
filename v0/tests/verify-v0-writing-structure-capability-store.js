'use strict';

const assert = require('assert');
const crypto = require('crypto');
const capabilityStoreModule = require('../src/main/writing-structure-capability-store');
const structureService = require('../src/main/writing-structure-service');
const navigationService = require('../src/main/writing-navigation-service');
const navigationStoreModule = require('../src/main/writing-navigation-store');

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
const OTHER_OWNER = 'webContents:8';
const PROJECT = 'instance_0123456789abcdef01234567';
const OTHER_PROJECT = 'instance_89abcdef0123456701234567';
const ROOT = '/tmp/writcraft-structure-project';
const EDIT = '# Prompt\n';
const EDIT_REVISION = crypto.createHash('sha256').update(EDIT).digest('hex');
const TREE_DIGEST = crypto.createHash('sha256').update('empty tree').digest('hex');

function bytesSequence() {
  let index = 0;
  return size => {
    index += 1;
    return Buffer.alloc(size, index);
  };
}

async function authenticPrepared(overrides = {}) {
  const proposal = await navigationService.proposeWritingNavigation({
    projectService: {
      listTree: () => [{ type: 'file', path: 'edit.md' }],
      readFileWithRevision: () => ({ content: EDIT, revision: EDIT_REVISION }),
    },
    rootPath: ROOT,
    request: {
      schema: navigationService.REQUEST_SCHEMA,
      mode: 'structure',
      goal: '生成结构',
      currentFilePath: null,
      contextPaths: [],
    },
    randomBytes: () => Buffer.alloc(16, 9),
    callLLM: async () => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: navigationService.TOOL_NAME,
        input: {
          mode: 'structure',
          alternatives: [{
            organizingLogic: '递进',
            audienceBenefit: '清楚',
            tradeoff: '较慢',
            chapters: [{ title: '第一章', purpose: '说明问题' }],
          }, {
            organizingLogic: '案例',
            audienceBenefit: '生动',
            tradeoff: '概念稍晚',
            chapters: [{ title: '开场', purpose: '建立场景' }],
          }],
        },
      },
    }),
  });
  const binding = {
    ownerId: OWNER,
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 11,
    navigationEpoch: 6,
    ...overrides,
  };
  const navigationStore = navigationStoreModule.createWritingNavigationStore({
    randomBytes: bytesSequence(),
  });
  navigationStore.install({ ...binding, record: proposal.record });
  return structureService.prepareWritingStructure({
    navigationStore,
    ...binding,
    navigationId: proposal.result.navigationId,
    alternativeId: 'alternative_1',
    emptyTreeDigest: TREE_DIGEST,
    chapters: [{ title: '作者标题', purpose: '作者确定的目的' }],
  }).prepared;
}

function consumeRequest(capabilityId, prepared, overrides = {}) {
  return {
    capabilityId,
    ownerId: prepared.ownerId,
    projectInstanceId: prepared.projectInstanceId,
    rootPath: prepared.rootPath,
    mutationGeneration: prepared.mutationGeneration,
    navigationEpoch: prepared.navigationEpoch,
    editRevision: prepared.editRevision,
    emptyTreeDigest: prepared.emptyTreeDigest,
    ...overrides,
  };
}

(async () => {
  console.log('\nWriting structure capability verification');

  await test('issues an opaque capability for an authentic prepared record', async () => {
    const prepared = await authenticPrepared();
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      randomBytes: bytesSequence(),
    });
    const issued = store.issue(prepared);
    assert.match(issued.capabilityId, /^wsc_[a-f0-9]{32}$/);
    assert.strictEqual(issued.preview, prepared.preview);
    assert.strictEqual(store.stats().capabilities, 1);
  });

  await test('rejects a forged or cloned prepared record', async () => {
    const prepared = await authenticPrepared();
    const store = capabilityStoreModule.createWritingStructureCapabilityStore();
    assert.throws(
      () => store.issue({ ...prepared }),
      error => error.code === 'INVALID_PREPARED_STRUCTURE'
    );
    assert.throws(
      () => store.issue(JSON.parse(JSON.stringify(prepared))),
      error => error.code === 'INVALID_PREPARED_STRUCTURE'
    );
  });

  await test('consumes exactly once and returns the authentic internal record', async () => {
    const prepared = await authenticPrepared();
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      randomBytes: bytesSequence(),
    });
    const issued = store.issue(prepared);
    assert.strictEqual(store.consume(consumeRequest(issued.capabilityId, prepared)), prepared);
    assert.throws(
      () => store.consume(consumeRequest(issued.capabilityId, prepared)),
      error => error.code === 'CAPABILITY_NOT_FOUND'
    );
  });

  await test('never reissues a consumed capability ID', async () => {
    const prepared = await authenticPrepared();
    const constantBytes = size => Buffer.alloc(size, 4);
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      randomBytes: constantBytes,
    });
    const issued = store.issue(prepared);
    store.consume(consumeRequest(issued.capabilityId, prepared));
    assert.throws(
      () => store.issue(prepared),
      error => error.code === 'CAPABILITY_COLLISION'
    );
  });

  await test('expires no later than ten minutes', async () => {
    let now = 1000;
    const prepared = await authenticPrepared();
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      clock: () => now,
      ttlMs: 60 * 60 * 1000,
      randomBytes: bytesSequence(),
    });
    const issued = store.issue(prepared);
    assert.strictEqual(issued.expiresAt, now + 10 * 60 * 1000);
    now = issued.expiresAt;
    assert.throws(
      () => store.consume(consumeRequest(issued.capabilityId, prepared)),
      error => error.code === 'CAPABILITY_NOT_FOUND'
    );
  });

  await test('root, generation, epoch, tree and revision drift fail closed', async () => {
    const driftCases = [
      { mutationGeneration: 12 },
      { navigationEpoch: 7 },
      { rootPath: '/tmp/another-writcraft-structure-project' },
      { emptyTreeDigest: 'a'.repeat(64) },
      { editRevision: 'b'.repeat(64) },
    ];
    for (const drift of driftCases) {
      const prepared = await authenticPrepared();
      const store = capabilityStoreModule.createWritingStructureCapabilityStore({
        randomBytes: bytesSequence(),
      });
      const issued = store.issue(prepared);
      assert.throws(
        () => store.consume(consumeRequest(issued.capabilityId, prepared, drift)),
        error => error.code === 'STALE_STRUCTURE_CAPABILITY'
      );
      assert.throws(
        () => store.consume(consumeRequest(issued.capabilityId, prepared)),
        error => error.code === 'CAPABILITY_NOT_FOUND'
      );
    }
  });

  await test('owner and project isolation cannot consume or invalidate another capability', async () => {
    const prepared = await authenticPrepared();
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      randomBytes: bytesSequence(),
    });
    const issued = store.issue(prepared);
    assert.throws(
      () => store.consume(consumeRequest(issued.capabilityId, prepared, { ownerId: OTHER_OWNER })),
      error => error.code === 'CAPABILITY_NOT_FOUND'
    );
    assert.throws(
      () => store.consume(consumeRequest(issued.capabilityId, prepared, {
        projectInstanceId: OTHER_PROJECT,
      })),
      error => error.code === 'CAPABILITY_NOT_FOUND'
    );
    assert.strictEqual(store.invalidateProject({
      ownerId: OTHER_OWNER,
      projectInstanceId: PROJECT,
    }), 0);
    assert.strictEqual(store.stats().capabilities, 1);
    assert.strictEqual(store.consume(consumeRequest(issued.capabilityId, prepared)), prepared);
  });

  await test('invalidateProject removes every matching capability only', async () => {
    const first = await authenticPrepared();
    const second = await authenticPrepared({
      ownerId: OTHER_OWNER,
      projectInstanceId: OTHER_PROJECT,
    });
    const store = capabilityStoreModule.createWritingStructureCapabilityStore({
      randomBytes: bytesSequence(),
    });
    const firstId = store.issue(first).capabilityId;
    const secondId = store.issue(second).capabilityId;
    assert.strictEqual(store.invalidateProject({
      ownerId: first.ownerId,
      projectInstanceId: first.projectInstanceId,
    }), 1);
    assert.throws(
      () => store.consume(consumeRequest(firstId, first)),
      error => error.code === 'CAPABILITY_NOT_FOUND'
    );
    assert.strictEqual(store.consume(consumeRequest(secondId, second)), second);
  });

  console.log(`\n${passed}/${passed} writing-structure capability checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
