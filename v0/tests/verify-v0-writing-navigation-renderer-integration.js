'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'assistant-workspace.js'),
  'utf8'
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createHarness(overrides = {}) {
  const listeners = new Map();
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        classList: { remove() {} },
        setAttribute() {},
        click() {},
      });
    }
    return elements.get(id);
  };
  const captured = { navigationOptions: null, updates: [], recovered: 0 };
  const projectA = { instanceId: 'instance_0123456789abcdef01234567' };
  const workspace = {
    state: { project: projectA, tree: [], currentPath: 'chapters/01.md' },
    getCurrentPath() { return this.state.currentPath; },
    canUseAI: () => true,
    persistCurrent: async () => true,
    refreshTree: async () => true,
    openFile: async () => true,
    revealContextChip: () => true,
    ...overrides.workspace,
  };
  const bridge = {
    proposeWritingNavigation: async () => ({ ok: false }),
    cancelWritingNavigation: async () => ({ ok: true, cancelled: true }),
    prepareWritingStructure: async () => ({ ok: false }),
    confirmWritingStructure: async () => ({ ok: false, state: 'UNCOMMITTED' }),
    queryWritingStructureRecovery: async () => ({ ok: true, state: 'UNCOMMITTED' }),
    acknowledgeWritingStructureRecovery: async () => ({ ok: true, acknowledged: true }),
    runWritingNavigationAction: async () => ({ ok: false }),
    cancelWritingNavigationAction: async () => ({ ok: true, cancelled: true }),
    discardChanges: async () => ({ ok: true }),
    ...overrides.bridge,
  };
  const document = {
    getElementById: node,
    addEventListener(name, listener) {
      const entries = listeners.get(name) || [];
      entries.push(listener);
      listeners.set(name, entries);
    },
  };
  const window = {
    writCraft: { project: bridge },
    __workspace: workspace,
    __sourcesView: overrides.sourcesView || { openWritingNavigation: () => ({ ok: true }) },
    __changesView: overrides.changesView || {
      acceptProposal: () => ({ ok: true }),
      open() {},
    },
    __graphView: { close() {} },
    WritCraftWritingNavigationState: {},
    WritCraftWritingNavigationView: {
      mount(_host, options) {
        captured.navigationOptions = options;
        return {
          updateProject(...args) {
            captured.updates.push(['project', ...args]);
            return { mode: args[1].some(item => item.path !== 'edit.md') ? 'navigation' : 'structure' };
          },
          updateTree(...args) { captured.updates.push(['tree', ...args]); },
          recover() { captured.recovered += 1; return Promise.resolve(true); },
          resume() { captured.resumed = (captured.resumed || 0) + 1; return Promise.resolve(true); },
        };
      },
    },
    WritCraftContextInspector: {
      mount() {
        return { update() {}, getState() { return null; }, getRequestPolicy() { return {}; } };
      },
    },
    WritCraftAssistantDock: {
      mount(options) {
        captured.dockOptions = options;
        return { open() {}, close() {} };
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    console,
    Object,
    Promise,
  }, { filename: 'assistant-workspace.js' });
  async function dispatch(name, detail = {}) {
    for (const listener of listeners.get(name) || []) await listener({ detail });
  }
  return { captured, bridge, workspace, dispatch };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\nWriting Navigation production Renderer integration');

  await test('generation persists before the attempt-bound Main call', async () => {
    const order = [];
    const harness = createHarness({
      workspace: {
        canUseAI: () => true,
        persistCurrent: async () => { order.push('persist'); return true; },
      },
      bridge: {
        proposeWritingNavigation: async (projectId, request, attemptId) => {
          order.push(['propose', projectId, request, attemptId]);
          return { ok: false, error: 'NO_KEY' };
        },
      },
    });
    const request = { schema: 'writcraft.writing-navigation-request/v1' };
    await harness.captured.navigationOptions.onGenerate(
      request,
      `wno_${'a'.repeat(32)}`,
      harness.workspace.state.project.instanceId
    );
    assert.strictEqual(order[0], 'persist');
    assert.deepStrictEqual(order[1].slice(1), [
      harness.workspace.state.project.instanceId,
      request,
      `wno_${'a'.repeat(32)}`,
    ]);
  });

  await test('committed structure refresh is an optional post-commit callback', async () => {
    let refreshes = 0;
    const committed = {
      ok: true,
      state: 'COMMITTED',
      operationId: `wso_${'b'.repeat(32)}`,
      recoveryRequired: false,
    };
    const harness = createHarness({
      workspace: { refreshTree: async () => { refreshes += 1; throw new Error('refresh failed'); } },
      bridge: { confirmWritingStructure: async () => committed },
    });
    assert.strictEqual(
      await harness.captured.navigationOptions.onConfirmStructure(`wsc_${'c'.repeat(32)}`),
      committed
    );
    await harness.captured.navigationOptions.onStructureCommitted();
    assert.strictEqual(refreshes, 1);
  });

  await test('Research and Changes success route through their existing review surfaces', async () => {
    let researchHandoff = null;
    let review = null;
    const harness = createHarness({
      sourcesView: {
        openWritingNavigation(value) { researchHandoff = value; return { ok: true }; },
      },
      changesView: {
        acceptProposal(value) { review = value; return { ok: true }; },
        open() {},
      },
    });
    const projectId = harness.workspace.state.project.instanceId;
    harness.bridge.runWritingNavigationAction = async () => ({
      ok: true,
      kind: 'research',
      handoff: { schema: 'writcraft.writing-navigation-research/v1' },
    });
    const research = await harness.captured.navigationOptions.onRunAction(
      projectId,
      `wna_${'d'.repeat(32)}`,
      `wno_${'e'.repeat(32)}`
    );
    assert.strictEqual(research.ok, true);
    assert.strictEqual(researchHandoff, research.handoff);

    harness.bridge.runWritingNavigationAction = async () => ({
      ok: true,
      kind: 'changes',
      noChanges: false,
      changeSetId: `pc_${'f'.repeat(32)}`,
      review: { changeSetId: `pc_${'f'.repeat(32)}`, files: [] },
    });
    const changes = await harness.captured.navigationOptions.onRunAction(
      projectId,
      `wna_${'1'.repeat(32)}`,
      `wno_${'2'.repeat(32)}`
    );
    assert.strictEqual(changes.ok, true);
    assert.strictEqual(review, changes);
  });

  await test('a late project-A Changes result is discarded instead of entering project B', async () => {
    const pending = deferred();
    const discarded = [];
    let accepted = 0;
    const harness = createHarness({
      bridge: {
        runWritingNavigationAction: () => pending.promise,
        discardChanges: async (projectId, changeSetId) => {
          discarded.push([projectId, changeSetId]);
          return { ok: true };
        },
      },
      changesView: {
        acceptProposal() { accepted += 1; return { ok: true }; },
        open() {},
      },
    });
    const projectA = harness.workspace.state.project.instanceId;
    const resultPromise = harness.captured.navigationOptions.onRunAction(
      projectA,
      `wna_${'3'.repeat(32)}`,
      `wno_${'4'.repeat(32)}`
    );
    harness.workspace.state.project = { instanceId: 'instance_abcdefabcdefabcdefabcdef' };
    pending.resolve({
      ok: true,
      kind: 'changes',
      noChanges: false,
      changeSetId: `pc_${'5'.repeat(32)}`,
      review: { changeSetId: `pc_${'5'.repeat(32)}`, files: [] },
    });
    const result = await resultPromise;
    assert.strictEqual(result.error, 'PROJECT_CHANGED');
    assert.strictEqual(accepted, 0);
    assert.deepStrictEqual(discarded, [[projectA, `pc_${'5'.repeat(32)}`]]);
  });

  await test('project-entered chooses navigation resume without starting structure recovery', async () => {
    const harness = createHarness({ workspace: {
      state: {
        project: { instanceId: 'instance_0123456789abcdef01234567' },
        tree: [{ type: 'file', path: 'chapters/01.md' }],
        currentPath: 'chapters/01.md',
      },
    } });
    await harness.dispatch('writcraft:project-entered');
    assert.strictEqual(harness.captured.updates[0][0], 'project');
    assert.strictEqual(harness.captured.updates[0][1], harness.workspace.state.project);
    assert.strictEqual(harness.captured.recovered, 0);
    assert.strictEqual(harness.captured.resumed, 1);
  });

  console.log(`\n${passed}/${passed} Writing Navigation production Renderer integration checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
