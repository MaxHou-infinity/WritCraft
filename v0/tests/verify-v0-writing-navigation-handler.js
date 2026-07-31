'use strict';

const assert = require('assert');
const handlerModule = require('../src/main/writing-navigation-handler');

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
  rootPath: '/tmp/writcraft-project',
});
const EVENT = Object.freeze({ sender: Object.freeze({ id: 7 }) });
const RECORD = Object.freeze({
  schema: 'writcraft.writing-navigation/v1',
  navigationId: `nav_${'a'.repeat(32)}`,
  mode: 'structure',
  goal: '规划结构',
  edit: { path: 'edit.md', revision: 'a'.repeat(64) },
  sources: [],
  result: {
    schema: 'writcraft.writing-navigation/v1',
    navigationId: `nav_${'a'.repeat(32)}`,
    mode: 'structure',
    alternatives: [{
      alternativeId: 'alternative_1',
      organizingLogic: '按问题递进',
      audienceBenefit: '便于理解',
      tradeoff: '案例稍后出现',
      chapters: [{ path: 'chapters/01.md', title: '第一章', purpose: '说明问题' }],
    }],
    contextManifest: {},
  },
});

function setup(overrides = {}) {
  let currentProject = PROJECT;
  let generation = 5;
  let navigationEpoch = 2;
  const installed = [];
  let settleCalls = 0;
  let serviceCalls = 0;
  const options = {
    assertTrustedSender() {},
    requireCurrentProject: () => currentProject,
    getCurrentProject: () => currentProject,
    getMutationGeneration: () => generation,
    getRendererNavigationEpoch: () => navigationEpoch,
    settleProjectAuthority: async () => { settleCalls += 1; },
    writingNavigationService: {
      proposeWritingNavigation: async () => {
        serviceCalls += 1;
        return { ok: true, record: RECORD };
      },
    },
    writingNavigationStore: {
      install(value) {
        installed.push(value);
        return { navigationId: value.record.navigationId };
      },
    },
    projectService: {},
    projectCallLLM: () => async () => ({ ok: true }),
    staleAiProjectResult: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({
      ok: false,
      error: /^[A-Z][A-Z0-9_]*$/.test(error?.code || '') ? error.code : 'NAVIGATION_FAILED',
      message: '写作导航没有完成；本次没有修改任何项目文件',
    }),
    ...overrides,
  };
  return {
    handler: handlerModule.createProposeWritingNavigationHandler(options),
    installed,
    get settleCalls() { return settleCalls; },
    get serviceCalls() { return serviceCalls; },
    setProject(value) { currentProject = value; },
    setGeneration(value) { generation = value; },
    setNavigationEpoch(value) { navigationEpoch = value; },
  };
}

(async () => {
  console.log('\nWriting navigation handler verification');

  await test('settles authority before and after generation, then installs owner-bound truth', async () => {
    const state = setup();
    const result = await state.handler(EVENT, PROJECT.instanceId, { mode: 'structure' });
    assert.deepStrictEqual(result, { ok: true, result: { navigationId: RECORD.navigationId } });
    assert.strictEqual(state.settleCalls, 2);
    assert.strictEqual(state.serviceCalls, 1);
    assert.strictEqual(state.installed.length, 1);
    assert.deepStrictEqual(state.installed[0], {
      ownerId: 'webcontents:7',
      projectInstanceId: PROJECT.instanceId,
      rootPath: PROJECT.rootPath,
      mutationGeneration: 5,
      navigationEpoch: 2,
      record: RECORD,
    });
  });

  await test('stale project instance fails before settle or provider work', async () => {
    const state = setup();
    const result = await state.handler(EVENT, 'instance_abcdef0123456789abcdef01', {});
    assert.deepStrictEqual(result, { ok: false, error: 'PROJECT_CHANGED' });
    assert.strictEqual(state.settleCalls, 0);
    assert.strictEqual(state.serviceCalls, 0);
  });

  await test('generation or navigation epoch drift rejects late results without cache authority', async () => {
    for (const drift of ['generation', 'navigation']) {
      let state;
      state = setup({
        writingNavigationService: {
          proposeWritingNavigation: async () => {
            if (drift === 'generation') state.setGeneration(6);
            else state.setNavigationEpoch(3);
            return { ok: true, record: RECORD };
          },
        },
      });
      const result = await state.handler(EVENT, PROJECT.instanceId, {});
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'PROJECT_CHANGED');
      assert.strictEqual(state.installed.length, 0);
      assert.strictEqual(state.settleCalls, 2);
    }
  });

  await test('failed generation never installs a result', async () => {
    const state = setup({
      writingNavigationService: {
        proposeWritingNavigation: async () => ({
          ok: false,
          error: 'RATE_LIMITED',
          message: 'AI 暂时没有完成导航整理；本次没有修改任何项目文件',
        }),
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, {});
    assert.strictEqual(result.error, 'RATE_LIMITED');
    assert.strictEqual(state.installed.length, 0);
    assert.strictEqual(state.settleCalls, 1);
  });

  await test('same owner and project are single-flight while another owner remains isolated', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const state = setup({
      writingNavigationService: {
        proposeWritingNavigation: async () => {
          await gate;
          return { ok: true, record: RECORD };
        },
      },
    });
    const first = state.handler(EVENT, PROJECT.instanceId, {});
    await Promise.resolve();
    const duplicate = await state.handler(EVENT, PROJECT.instanceId, {});
    assert.strictEqual(duplicate.error, 'NAVIGATION_IN_PROGRESS');
    const other = state.handler({ sender: { id: 8 } }, PROJECT.instanceId, {});
    release();
    assert.strictEqual((await first).ok, true);
    assert.strictEqual((await other).ok, true);
  });

  await test('a new navigation epoch is not blocked or released by the old page owner', async () => {
    let releaseOld;
    let releaseNew;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const newGate = new Promise(resolve => { releaseNew = resolve; });
    let calls = 0;
    const state = setup({
      writingNavigationService: {
        proposeWritingNavigation: async () => {
          calls += 1;
          await (calls === 1 ? oldGate : newGate);
          return { ok: true, record: RECORD };
        },
      },
    });
    const oldRequest = state.handler(EVENT, PROJECT.instanceId, {});
    await Promise.resolve();
    await Promise.resolve();
    state.setNavigationEpoch(3);
    const newRequest = state.handler(EVENT, PROJECT.instanceId, {});
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(calls, 2);
    releaseOld();
    assert.strictEqual((await oldRequest).error, 'PROJECT_CHANGED');
    const duplicateNew = await state.handler(EVENT, PROJECT.instanceId, {});
    assert.strictEqual(duplicateNew.error, 'NAVIGATION_IN_PROGRESS');
    releaseNew();
    assert.strictEqual((await newRequest).ok, true);
  });

  await test('project drift wins over a provider failure classification', async () => {
    let state;
    state = setup({
      writingNavigationService: {
        proposeWritingNavigation: async () => {
          state.setProject({
            instanceId: 'instance_abcdef0123456789abcdef01',
            rootPath: '/tmp/other',
          });
          return { ok: false, error: 'LLM_FAILED', message: 'generic' };
        },
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, {});
    assert.strictEqual(result.error, 'PROJECT_CHANGED');
    assert.strictEqual(state.installed.length, 0);
  });

  await test('unexpected exceptions are content-free at the handler boundary', async () => {
    const state = setup({
      settleProjectAuthority: async () => {
        throw new Error('ENOENT /secret/project/edit.md');
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, {});
    assert.deepStrictEqual(result, {
      ok: false,
      error: 'NAVIGATION_FAILED',
      message: '写作导航没有完成；本次没有修改任何项目文件',
    });
    assert(!JSON.stringify(result).includes('/secret'));
  });

  console.log(`\n${passed}/${passed} writing-navigation handler checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
