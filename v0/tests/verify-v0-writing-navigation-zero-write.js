'use strict';

const assert = require('assert');
const crypto = require('crypto');
const service = require('../src/main/writing-navigation-service');
const storeModule = require('../src/main/writing-navigation-store');
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
  rootPath: '/tmp/writcraft-zero-write',
});
const EVENT = Object.freeze({ sender: Object.freeze({ id: 7 }) });
const ATTEMPT_ID = `wno_${'a'.repeat(32)}`;
const REQUEST = Object.freeze({
  schema: service.REQUEST_SCHEMA,
  mode: 'structure',
  goal: '比较两个结构方案',
  currentFilePath: null,
  contextPaths: Object.freeze([]),
});
const STRUCTURE = Object.freeze({
  mode: 'structure',
  alternatives: Object.freeze([
    Object.freeze({
      organizingLogic: '按问题递进',
      audienceBenefit: '先建立理解',
      tradeoff: '案例稍后出现',
      chapters: Object.freeze([
        Object.freeze({ title: '第一章', purpose: '说明问题' }),
      ]),
    }),
    Object.freeze({
      organizingLogic: '按案例展开',
      audienceBenefit: '更容易代入',
      tradeoff: '概念逐步回收',
      chapters: Object.freeze([
        Object.freeze({ title: '案例开篇', purpose: '建立真实场景' }),
      ]),
    }),
  ]),
});

function createHarness(modelFactory) {
  const state = {
    markdown: new Map([['edit.md', '# 项目主旨\n\n尚未开始正文。\n']]),
    history: [],
    changes: [],
    generation: 4,
    writeCalls: 0,
  };
  const projectService = {
    listTree() {
      return [{ type: 'file', path: 'edit.md' }];
    },
    readFileWithRevision(_root, filePath) {
      const content = state.markdown.get(filePath);
      return {
        content,
        revision: crypto.createHash('sha256').update(content).digest('hex'),
      };
    },
    writeFile() {
      state.writeCalls += 1;
      throw new Error('WRITE_MUST_NOT_BE_REACHED');
    },
  };
  const handler = handlerModule.createWritingNavigationHandlers({
    assertTrustedSender() {},
    requireCurrentProject: () => PROJECT,
    getCurrentProject: () => PROJECT,
    getMutationGeneration: () => state.generation,
    getRendererNavigationEpoch: () => 2,
    settleProjectAuthority: async () => {},
    writingNavigationService: service,
    writingNavigationStore: storeModule.createWritingNavigationStore(),
    projectService,
    projectCallLLM: () => async () => modelFactory(),
    staleAiProjectResult: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({
      ok: false,
      error: error?.code || 'PROJECT_OPERATION_FAILED',
      message: '本次没有修改任何项目文件',
    }),
  }).propose;
  return { state, handler };
}

function snapshot(state) {
  return {
    markdown: [...state.markdown],
    history: [...state.history],
    changes: [...state.changes],
    generation: state.generation,
    writeCalls: state.writeCalls,
  };
}

(async () => {
  console.log('\nWriting navigation zero-write integration verification');

  await test('a successful suggestion installs navigation authority without touching project state', async () => {
    const harness = createHarness(() => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: { name: service.TOOL_NAME, input: STRUCTURE },
    }));
    const before = snapshot(harness.state);
    const result = await harness.handler(EVENT, PROJECT.instanceId, REQUEST, ATTEMPT_ID);
    assert.strictEqual(result.ok, true);
    assert.match(result.result.navigationId, /^nav_[a-f0-9]{32}$/);
    assert.deepStrictEqual(snapshot(harness.state), before);
  });

  await test('malformed model output leaves Markdown, History, Changes and generation unchanged', async () => {
    const harness = createHarness(() => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: service.TOOL_NAME,
        input: { mode: 'structure', alternatives: [], leakedTaskGraph: [] },
      },
    }));
    const before = snapshot(harness.state);
    const result = await harness.handler(EVENT, PROJECT.instanceId, REQUEST, ATTEMPT_ID);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'INVALID_MODEL_OUTPUT');
    assert.deepStrictEqual(snapshot(harness.state), before);
  });

  console.log(`\n${passed}/${passed} writing-navigation zero-write integration checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
