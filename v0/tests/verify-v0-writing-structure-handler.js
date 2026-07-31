'use strict';

const assert = require('assert');
const handlerModule = require('../src/main/writing-structure-handler');

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

const PROJECT = Object.freeze({
  instanceId: 'instance_0123456789abcdef01234567',
  rootPath: '/tmp/writcraft-structure',
  projectId: 'project-1',
});
const OTHER_PROJECT = Object.freeze({
  instanceId: 'instance_abcdef0123456789abcdef01',
  rootPath: '/tmp/writcraft-other',
  projectId: 'project-2',
});
const EVENT = Object.freeze({ sender: Object.freeze({ id: 7 }) });
const NAVIGATION_ID = `nav_${'a'.repeat(32)}`;
const CAPABILITY_ID = `wsc_${'b'.repeat(32)}`;
const OPERATION_ID = 'wst_0123456789abcdef';
const REVISION = 'c'.repeat(64);
const TREE_DIGEST = 'd'.repeat(64);
const PREPARED = Object.freeze({
  ownerId: 'webcontents:7',
  projectInstanceId: PROJECT.instanceId,
  rootPath: PROJECT.rootPath,
  mutationGeneration: 5,
  navigationEpoch: 2,
  navigationId: NAVIGATION_ID,
  editRevision: REVISION,
  emptyTreeDigest: TREE_DIGEST,
  proposalDigest: 'e'.repeat(64),
  files: Object.freeze([Object.freeze({
    path: 'chapters/01.md',
    content: '# 第一章\n\n<!-- 写作目的：说明问题 -->\n',
  })]),
  preview: Object.freeze({ schema: 'writcraft.writing-structure-preview/v1' }),
});

function setup(overrides = {}) {
  let currentProject = PROJECT;
  let generation = 5;
  let navigationEpoch = 2;
  let authority = {
    editRevision: REVISION,
    emptyTreeDigest: TREE_DIGEST,
    emptyBody: true,
    chaptersAbsent: true,
  };
  let writes = 0;
  let settleCalls = 0;
  let consumeCalls = 0;
  let mutationBegins = 0;
  let mutationEnds = 0;
  let generationAdvances = 0;
  let rememberCalls = 0;
  let activeMutation = null;
  let consumed = false;
  let queryResult = { ok: true, state: 'UNCOMMITTED', operationId: OPERATION_ID };
  const options = {
    assertTrustedSender() {},
    requireCurrentProject() {
      if (!currentProject) throw Object.assign(new Error('no project'), { code: 'NO_PROJECT' });
      return currentProject;
    },
    getCurrentProject: () => currentProject,
    getMutationGeneration: () => generation,
    getRendererNavigationEpoch: () => navigationEpoch,
    settleProjectAuthority: async () => { settleCalls += 1; },
    deriveAuthority: () => ({ ...authority }),
    writingStructureService: {
      prepareWritingStructure(request) {
        assert.strictEqual(request.ownerId, 'webcontents:7');
        assert.strictEqual(request.navigationId, NAVIGATION_ID);
        return { prepared: PREPARED };
      },
    },
    writingNavigationStore: {},
    capabilityStore: {
      issue(prepared) {
        assert.strictEqual(prepared, PREPARED);
        return { capabilityId: CAPABILITY_ID, expiresAt: 1234, preview: PREPARED.preview };
      },
      consume(request) {
        consumeCalls += 1;
        assert.deepStrictEqual(Object.keys(request).sort(), [
          'capabilityId', 'editRevision', 'emptyTreeDigest', 'mutationGeneration',
          'navigationEpoch', 'ownerId', 'projectInstanceId', 'rootPath',
        ].sort());
        if (consumed) throw Object.assign(new Error('used'), { code: 'CAPABILITY_NOT_FOUND' });
        consumed = true;
        return PREPARED;
      },
    },
    transaction: {
      async commit({ beforePublish }) {
        writes += 1;
        beforePublish();
        return {
          ok: true,
          state: 'COMMITTED',
          operationId: OPERATION_ID,
          files: [{ path: 'chapters/01.md', revision: 'f'.repeat(64) }],
        };
      },
      query: () => queryResult,
      acknowledge() {
        queryResult = { ...queryResult, acknowledged: true };
        return { acknowledged: true };
      },
    },
    assertMutationAvailable() {
      if (activeMutation) throw Object.assign(new Error('busy'), { code: 'PROJECT_MUTATION_IN_PROGRESS' });
    },
    assertCommitAvailable(_project, allowedLease) {
      if (activeMutation !== allowedLease) {
        throw Object.assign(new Error('lost lease'), { code: 'PROJECT_MUTATION_IN_PROGRESS' });
      }
    },
    assertRecoveryAvailable(_project, allowedLease) {
      if (activeMutation && activeMutation !== allowedLease) {
        throw Object.assign(new Error('busy'), { code: 'PROJECT_MUTATION_IN_PROGRESS' });
      }
    },
    beginMutation() {
      mutationBegins += 1;
      activeMutation = Object.freeze({ id: mutationBegins });
      return activeMutation;
    },
    endMutation(token) {
      if (activeMutation !== token) return;
      mutationEnds += 1;
      activeMutation = null;
    },
    rememberCommittedFile() { rememberCalls += 1; },
    advanceGeneration() {
      generationAdvances += 1;
      generation += 1;
    },
    listTree: () => [{ path: 'chapters', type: 'directory' }],
    staleProjectResult: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({
      ok: false,
      error: error?.code || 'PROJECT_OPERATION_FAILED',
      message: error?.message || 'failed',
    }),
    ...overrides,
  };
  const handlers = handlerModule.createWritingStructureHandlers(options);
  return {
    handlers,
    get writes() { return writes; },
    get settleCalls() { return settleCalls; },
    get consumeCalls() { return consumeCalls; },
    get mutationBegins() { return mutationBegins; },
    get mutationEnds() { return mutationEnds; },
    get generationAdvances() { return generationAdvances; },
    get rememberCalls() { return rememberCalls; },
    get activeMutation() { return activeMutation; },
    setProject(value) { currentProject = value; },
    setGeneration(value) { generation = value; },
    setNavigationEpoch(value) { navigationEpoch = value; },
    setAuthority(value) { authority = { ...authority, ...value }; },
    setQueryResult(value) { queryResult = value; },
  };
}

(async () => {
  console.log('\nWriting structure handler verification');

  await test('prepare settles authority and returns an exact zero-write preview capability', async () => {
    const state = setup();
    const result = await state.handlers.prepare(
      EVENT,
      PROJECT.instanceId,
      NAVIGATION_ID,
      'alternative_1',
      [{ title: '第一章', purpose: '说明问题' }]
    );
    assert.deepStrictEqual(result, {
      ok: true,
      capabilityId: CAPABILITY_ID,
      expiresAt: 1234,
      preview: PREPARED.preview,
    });
    assert.strictEqual(state.settleCalls, 1);
    assert.strictEqual(state.writes, 0);
    assert.strictEqual(state.mutationBegins, 0);
  });

  await test('prepare rejects a stale project before settle and any write', async () => {
    const state = setup();
    const result = await state.handlers.prepare(
      EVENT,
      OTHER_PROJECT.instanceId,
      NAVIGATION_ID,
      'alternative_1',
      []
    );
    assert.strictEqual(result.error, 'PROJECT_CHANGED');
    assert.strictEqual(state.settleCalls, 0);
    assert.strictEqual(state.writes, 0);
  });

  await test('prepare fails closed when a body or chapters path already exists', async () => {
    for (const drift of [
      { emptyBody: false },
      { chaptersAbsent: false },
    ]) {
      const state = setup();
      state.setAuthority(drift);
      const result = await state.handlers.prepare(
        EVENT,
        PROJECT.instanceId,
        NAVIGATION_ID,
        'alternative_1',
        [{ title: '第一章', purpose: '说明问题' }]
      );
      assert.strictEqual(result.error, 'STRUCTURE_REQUIRES_EMPTY_PROJECT');
      assert.strictEqual(state.writes, 0);
    }
  });

  await test('confirm consumes once, validates immediately before publish, and commits generation once', async () => {
    const state = setup();
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state, 'COMMITTED');
    assert.strictEqual(state.consumeCalls, 1);
    assert.strictEqual(state.mutationBegins, 1);
    assert.strictEqual(state.mutationEnds, 1);
    assert.strictEqual(state.rememberCalls, 1);
    assert.strictEqual(state.generationAdvances, 1);
    assert.strictEqual(state.activeMutation, null);
    const replay = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(replay.error, 'CAPABILITY_NOT_FOUND');
    assert.strictEqual(state.writes, 1);
  });

  await test('prepublish authority drift becomes UNCOMMITTED with a released shared lease', async () => {
    const state = setup({
      transaction: {
        async commit({ beforePublish }) {
          state.setAuthority({ emptyTreeDigest: '0'.repeat(64) });
          try { beforePublish(); }
          catch (error) {
            return {
              ok: false,
              state: 'UNCOMMITTED',
              operationId: OPERATION_ID,
              error: error.code,
            };
          }
          throw new Error('expected drift');
        },
        query: () => ({ ok: true, state: 'UNCOMMITTED', operationId: OPERATION_ID }),
        acknowledge: () => ({ acknowledged: true }),
      },
    });
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.state, 'UNCOMMITTED');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(state.generationAdvances, 0);
    assert.strictEqual(state.mutationEnds, 1);
  });

  await test('UNKNOWN keeps the exact shared mutation lease and warns against repeating', async () => {
    const state = setup({
      transaction: {
        async commit() {
          return { ok: false, state: 'UNKNOWN', operationId: OPERATION_ID };
        },
        query: () => ({ ok: true, state: 'UNKNOWN', operationId: OPERATION_ID }),
        acknowledge: () => ({ acknowledged: true }),
      },
    });
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.state, 'UNKNOWN');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.recoveryRequired, true);
    assert(state.activeMutation);
    assert.strictEqual(state.mutationEnds, 0);
  });

  await test('recovery query finalizes a committed operation only once and ack releases the same lease', async () => {
    const state = setup({
      transaction: {
        async commit() {
          return { ok: false, state: 'UNKNOWN', operationId: OPERATION_ID };
        },
        query: () => ({
          ok: true,
          state: 'COMMITTED',
          operationId: OPERATION_ID,
          files: [{ path: 'chapters/01.md', revision: 'f'.repeat(64) }],
        }),
        acknowledge: () => ({ acknowledged: true }),
      },
    });
    await state.handlers.confirm(EVENT, CAPABILITY_ID);
    const first = await state.handlers.queryRecovery(EVENT, PROJECT.instanceId);
    const second = await state.handlers.queryRecovery(EVENT, PROJECT.instanceId);
    assert.strictEqual(first.state, 'COMMITTED');
    assert.strictEqual(second.state, 'COMMITTED');
    assert.strictEqual(state.generationAdvances, 1);
    assert.strictEqual(state.rememberCalls, 1);
    assert(state.activeMutation);
    const ack = await state.handlers.acknowledgeRecovery(
      EVENT,
      PROJECT.instanceId,
      OPERATION_ID
    );
    assert.strictEqual(ack.acknowledged, true);
    assert.strictEqual(state.mutationEnds, 1);
    assert.strictEqual(state.activeMutation, null);
    assert.strictEqual(state.generationAdvances, 1);
  });

  await test('recovery refuses acknowledgement while commit truth is still unknown', async () => {
    const state = setup({
      transaction: {
        async commit() {
          return { ok: false, state: 'UNKNOWN', operationId: OPERATION_ID };
        },
        query: () => ({ ok: true, state: 'UNKNOWN', operationId: OPERATION_ID }),
        acknowledge: () => {
          throw new Error('must not acknowledge unknown');
        },
      },
    });
    await state.handlers.confirm(EVENT, CAPABILITY_ID);
    const result = await state.handlers.acknowledgeRecovery(
      EVENT,
      PROJECT.instanceId,
      OPERATION_ID
    );
    assert.strictEqual(result.error, 'WRITING_STRUCTURE_COMMIT_UNKNOWN');
    assert(state.activeMutation);
  });

  await test('postcommit tree refresh failure remains committed and does not invite repetition', async () => {
    const state = setup({
      listTree() {
        throw Object.assign(new Error('/private/path'), { code: 'TREE_TOO_LARGE' });
      },
    });
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state, 'COMMITTED');
    assert.strictEqual(result.refreshRequired, true);
    assert(result.warningCodes.includes('TREE_REFRESH_FAILED'));
    assert(!JSON.stringify(result).includes('/private/path'));
    assert.strictEqual(state.generationAdvances, 1);
  });

  await test('postcommit acknowledgement failure keeps the shared recovery lock', async () => {
    const state = setup({
      transaction: {
        async commit({ beforePublish }) {
          beforePublish();
          return {
            ok: true,
            state: 'COMMITTED',
            operationId: OPERATION_ID,
            files: [{ path: 'chapters/01.md', revision: 'f'.repeat(64) }],
          };
        },
        query: () => ({
          ok: true,
          state: 'COMMITTED',
          operationId: OPERATION_ID,
          files: [{ path: 'chapters/01.md', revision: 'f'.repeat(64) }],
        }),
        acknowledge: () => ({ acknowledged: false }),
      },
    });
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.state, 'COMMITTED');
    assert.strictEqual(result.recoveryRequired, true);
    assert.strictEqual(state.generationAdvances, 1);
    assert(state.activeMutation);
    assert.strictEqual(state.mutationEnds, 0);
    const ack = await state.handlers.acknowledgeRecovery(
      EVENT,
      PROJECT.instanceId,
      OPERATION_ID
    );
    assert.strictEqual(ack.acknowledged, false);
    assert.strictEqual(ack.recoveryRequired, true);
    assert(state.activeMutation);
  });

  await test('remember failure keeps authority and recovery retries only the failed file', async () => {
    const files = [
      { path: 'chapters/01.md', revision: '1'.repeat(64) },
      { path: 'chapters/02.md', revision: '2'.repeat(64) },
    ];
    const remembered = new Map();
    let failSecond = true;
    let generationCalls = 0;
    let treeCalls = 0;
    let acknowledgeCalls = 0;
    const transaction = {
      async commit({ beforePublish }) {
        beforePublish();
        return { ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files };
      },
      query: () => ({ ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files }),
      acknowledge: () => {
        acknowledgeCalls += 1;
        return { acknowledged: true };
      },
    };
    const state = setup({
      transaction,
      rememberCommittedFile(file) {
        remembered.set(file.path, (remembered.get(file.path) || 0) + 1);
        if (file.path === 'chapters/02.md' && failSecond) {
          failSecond = false;
          throw new Error('remember failed');
        }
      },
      advanceGeneration() {
        generationCalls += 1;
        state.setGeneration(6);
      },
      listTree() {
        treeCalls += 1;
        return [{ path: 'chapters', type: 'directory' }];
      },
    });
    const committed = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(committed.state, 'COMMITTED');
    assert.strictEqual(committed.recoveryRequired, true);
    assert.strictEqual(acknowledgeCalls, 0);
    assert.strictEqual(state.mutationEnds, 0);
    assert(state.activeMutation);
    assert.strictEqual(remembered.get('chapters/01.md'), 1);
    assert.strictEqual(remembered.get('chapters/02.md'), 1);
    assert.strictEqual(generationCalls, 0);
    assert.strictEqual(treeCalls, 0);

    const recovered = await state.handlers.queryRecovery(EVENT, PROJECT.instanceId);
    assert.strictEqual(recovered.state, 'COMMITTED');
    assert.strictEqual(recovered.recoveryRequired, undefined);
    assert.strictEqual(remembered.get('chapters/01.md'), 1);
    assert.strictEqual(remembered.get('chapters/02.md'), 2);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 1);
    const ack = await state.handlers.acknowledgeRecovery(
      EVENT,
      PROJECT.instanceId,
      OPERATION_ID
    );
    assert.strictEqual(ack.acknowledged, true);
    assert.strictEqual(acknowledgeCalls, 1);
    assert.strictEqual(remembered.get('chapters/01.md'), 1);
    assert.strictEqual(remembered.get('chapters/02.md'), 2);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 1);
    assert.strictEqual(state.mutationEnds, 1);
  });

  await test('generation failure preserves remembered state and retries generation once', async () => {
    const files = [{ path: 'chapters/01.md', revision: '1'.repeat(64) }];
    let rememberCalls = 0;
    let generationCalls = 0;
    let treeCalls = 0;
    let acknowledgeCalls = 0;
    const transaction = {
      async commit({ beforePublish }) {
        beforePublish();
        return { ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files };
      },
      query: () => ({ ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files }),
      acknowledge: () => {
        acknowledgeCalls += 1;
        return { acknowledged: true };
      },
    };
    const state = setup({
      transaction,
      rememberCommittedFile() { rememberCalls += 1; },
      advanceGeneration() {
        generationCalls += 1;
        if (generationCalls === 1) throw new Error('generation failed');
        state.setGeneration(6);
      },
      listTree() {
        treeCalls += 1;
        return [{ path: 'chapters', type: 'directory' }];
      },
    });
    const committed = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(committed.recoveryRequired, true);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 0);
    assert.strictEqual(acknowledgeCalls, 0);
    assert.strictEqual(state.mutationEnds, 0);

    const recovered = await state.handlers.queryRecovery(EVENT, PROJECT.instanceId);
    assert.strictEqual(recovered.recoveryRequired, undefined);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 2);
    assert.strictEqual(treeCalls, 1);
    await state.handlers.acknowledgeRecovery(EVENT, PROJECT.instanceId, OPERATION_ID);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 2);
    assert.strictEqual(treeCalls, 1);
    assert.strictEqual(acknowledgeCalls, 1);
    assert.strictEqual(state.mutationEnds, 1);
  });

  await test('tree failure preserves remember and generation success for one recovery retry', async () => {
    const files = [{ path: 'chapters/01.md', revision: '1'.repeat(64) }];
    let rememberCalls = 0;
    let generationCalls = 0;
    let treeCalls = 0;
    let acknowledgeCalls = 0;
    const transaction = {
      async commit({ beforePublish }) {
        beforePublish();
        return { ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files };
      },
      query: () => ({ ok: true, state: 'COMMITTED', operationId: OPERATION_ID, files }),
      acknowledge: () => {
        acknowledgeCalls += 1;
        return { acknowledged: true };
      },
    };
    const state = setup({
      transaction,
      rememberCommittedFile() { rememberCalls += 1; },
      advanceGeneration() {
        generationCalls += 1;
        state.setGeneration(6);
      },
      listTree() {
        treeCalls += 1;
        if (treeCalls === 1) throw new Error('tree failed');
        return [{ path: 'chapters', type: 'directory' }];
      },
    });
    const committed = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(committed.recoveryRequired, true);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 1);
    assert.strictEqual(acknowledgeCalls, 0);
    assert.strictEqual(state.mutationEnds, 0);

    const recovered = await state.handlers.queryRecovery(EVENT, PROJECT.instanceId);
    assert.strictEqual(recovered.recoveryRequired, undefined);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 2);
    await state.handlers.acknowledgeRecovery(EVENT, PROJECT.instanceId, OPERATION_ID);
    assert.strictEqual(rememberCalls, 1);
    assert.strictEqual(generationCalls, 1);
    assert.strictEqual(treeCalls, 2);
    assert.strictEqual(acknowledgeCalls, 1);
    assert.strictEqual(state.mutationEnds, 1);
  });

  await test('a project switch makes the final synchronous publication check fail closed', async () => {
    const state = setup({
      transaction: {
        async commit({ beforePublish }) {
          state.setProject(OTHER_PROJECT);
          try { beforePublish(); }
          catch (error) {
            return {
              ok: false,
              state: 'UNCOMMITTED',
              operationId: OPERATION_ID,
              error: error.code,
            };
          }
          throw new Error('expected project drift');
        },
        query: () => ({ ok: true, state: 'UNCOMMITTED', operationId: OPERATION_ID }),
        acknowledge: () => ({ acknowledged: true }),
      },
    });
    const result = await state.handlers.confirm(EVENT, CAPABILITY_ID);
    assert.strictEqual(result.state, 'UNCOMMITTED');
    assert.strictEqual(state.generationAdvances, 0);
    assert.strictEqual(state.mutationEnds, 1);
  });

  console.log(`\n${passed}/${passed} writing-structure handler checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
