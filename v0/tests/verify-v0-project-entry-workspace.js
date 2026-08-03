#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
const ownership = source.slice(
  source.indexOf('  function beginProjectEntry()'),
  source.indexOf('  const INLINE_RECONCILIATION_REQUEST')
);
const enter = source.slice(
  source.indexOf('  async function enterProject'),
  source.indexOf('  function closeProjectOnboarding')
);
const loadEditContextSource = source.slice(
  source.indexOf('  async function loadEditContext'),
  source.indexOf('  async function queryInlineRewriteReconciliation')
);
const entryRecoveryHelpers = source.slice(
  source.indexOf('  async function releaseEntryMigration'),
  source.indexOf('  async function createProject')
);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createHarness(recoveryResults = []) {
  const events = [];
  const pendingRecovery = [...recoveryResults];
  const state = {
    project: null,
    projectReady: false,
    projectEntryGeneration: 0,
    projectEntryRequestGeneration: 0,
    projectEntryRequestOwner: null,
    openGeneration: 0,
    inlineRecoveryGeneration: 0,
    changesHistoryRecoveryGeneration: 0,
    mutationBlockers: {},
    changesHistoryRecovery: null,
    views: {},
    returnStack: [],
  };
  const noop = () => {};
  const context = vm.createContext({
    state,
    externalChangeSequence: 0,
    migrationResolver: null,
    finishMigrationDialog: noop,
    closeProjectOnboarding: noop,
    resetMarkdownTrash: noop,
    externalSyncState: { reset: noop },
    window: {
      __assistantDock: { close: noop },
      __editor: { setProjectManaged: noop },
    },
    document: {
      dispatchEvent(event) { events.push({ type: event.type, detail: event.detail }); },
    },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; },
    resultMessage: (_result, fallback) => fallback,
    showError: noop,
    setMarkdownTrashMutationBlocked: noop,
    setChangesHistoryMutationBlocked: noop,
    setSidebarView: noop,
    updateWorkspaceReturnControl: noop,
    showConflictActions: noop,
    projectTitle: { textContent: '' },
    newFileButton: { disabled: false },
    welcome: { hidden: false },
    workArea: { classList: { add: noop } },
    renderTree: noop,
    reconcileChangesHistoryOnProjectEnter: async () => {
      const next = pendingRecovery.length ? pendingRecovery.shift() : { ok: true };
      return next?.promise || next;
    },
    reconcileInlineRewriteOnProjectEnter: async () => ({ ok: true }),
    loadEditContext: async () => {},
    markdownPaths: () => ['chapters/01.md'],
    bridge: {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
    },
    openFile: async () => true,
    presentMigration: async () => 'later',
    maybeOfferOrphanRecovery: async () => {},
    maybeOfferLegacyDraft: async () => {},
    updateDocumentChrome: noop,
    setSaveState: noop,
    startOnboardingButton: null,
    openProjectOnboarding: noop,
    refreshMarkdownTrash: async () => {},
    console,
    Promise,
    clearTimeout,
    structuredClone: value => JSON.parse(JSON.stringify(value)),
  });
  vm.runInContext(`${ownership}\n${enter}\nthis.api = { beginProjectEntry, isOwnedProjectEntryCurrent, enterProject };`, context);
  return { state, events, api: context.api };
}

function createOwnedHelperHarness() {
  const oldContext = deferred();
  const oldConfirm = deferred();
  const confirmStarted = deferred();
  const mutations = [];
  let contextCalls = 0;
  const state = {
    project: { instanceId: 'project-a' },
    projectReady: false,
    projectEntryGeneration: 0,
    projectEntryRequestGeneration: 0,
    projectEntryRequestOwner: null,
    editContext: '',
    editContextRevision: '',
    projectPromptMissing: false,
    promptFrontMatter: null,
    tree: [{ type: 'file', path: 'chapters/a.md' }],
  };
  const localValues = new Map([['legacy-key', 'legacy-value']]);
  const context = vm.createContext({
    state,
    externalChangeSequence: 0,
    bridge: {
      async getContext() {
        contextCalls += 1;
        if (contextCalls === 1) return oldContext.promise;
        return {
          ok: true,
          editPrompt: 'B prompt',
          editRevision: 'revision-b',
          projectPromptMissing: false,
          editFrontMatter: { title: 'B' },
        };
      },
      readFile: async () => ({ ok: false }),
      previewLegacyDraft: async () => ({
        ok: true,
        token: 'migration-a',
        plan: { revision: 'legacy-a', targetPath: 'chapters/imported-a.md', renamed: false },
      }),
      listRecoveries: async () => ({
        ok: true,
        recoveries: [{ path: 'chapters/orphan-a.md' }],
      }),
      confirmLegacyDraft: async () => {
        confirmStarted.resolve();
        return oldConfirm.promise;
      },
      discardMigration: async token => { mutations.push(`discard:${token}`); },
    },
    legacyDraftSnoozed: false,
    window: {
      __legacyDraft: {
        STORAGE_KEY: 'legacy-key',
        inspect: () => ({ markdown: 'legacy A', warnings: [], savedAt: null }),
      },
    },
    document: {},
    localStorage: {
      getItem: key => localValues.get(key) || null,
      setItem: (key, value) => { localValues.set(key, value); mutations.push(`storage:${key}`); },
    },
    normalizeResult: value => value,
    resultMessage: (_result, fallback) => fallback,
    showError: message => mutations.push(`error:${message}`),
    presentMigration: async () => 'confirm',
    renderTree: () => mutations.push('render-tree'),
    openFile: async path => { mutations.push(`open:${path}`); return true; },
    setSaveState: message => mutations.push(`status:${message}`),
    markdownTreePaths: () => new Set(),
    isPublicMarkdownPath: value => typeof value === 'string' && value.endsWith('.md'),
    loadRecoveryManifest: () => [],
    readRecoveryEntry: async path => ({ content: `orphan:${path}`, revision: null, savedAt: 1 }),
    clearRecovery: () => mutations.push('clear-recovery'),
    console,
    Promise,
    clearTimeout,
  });
  vm.runInContext(
    `${ownership}\n${loadEditContextSource}\n${entryRecoveryHelpers}\n` +
    'this.api = { beginProjectEntry, projectEntryOwner, loadEditContext, maybeOfferOrphanRecovery, maybeOfferLegacyDraft };',
    context
  );
  return { state, mutations, oldContext, oldConfirm, confirmStarted, api: context.api };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('\nProject-entry workspace ownership verification');

  await test('external watcher owners share the same exact current predicate', async () => {
    const harness = createHarness();
    let current = true;
    const owner = { isCurrent: () => current };
    assert.strictEqual(harness.api.isOwnedProjectEntryCurrent(owner), true);
    current = false;
    assert.strictEqual(harness.api.isOwnedProjectEntryCurrent(owner), false);
  });

  await test('a stale project entry cannot mark a newer project ready', async () => {
    const oldRecovery = deferred();
    const harness = createHarness([oldRecovery, { ok: true }]);
    const oldToken = harness.api.beginProjectEntry();
    const oldRun = harness.api.enterProject({
      ok: true,
      project: { instanceId: 'project-a', name: 'A' },
      tree: [{ type: 'file', path: 'chapters/a.md' }],
    }, oldToken);
    await Promise.resolve();

    const newToken = harness.api.beginProjectEntry();
    const newResult = await harness.api.enterProject({
      ok: true,
      project: { instanceId: 'project-b', name: 'B' },
      tree: [{ type: 'file', path: 'chapters/b.md' }],
    }, newToken);
    assert.strictEqual(newResult, true);
    assert.strictEqual(harness.state.project.instanceId, 'project-b');
    assert.strictEqual(harness.state.projectReady, true);

    oldRecovery.resolve({ ok: true });
    assert.strictEqual(await oldRun, false);
    assert.deepStrictEqual(
      harness.events.filter(event => event.type === 'writcraft:project-entered')
        .map(event => event.detail),
      [undefined]
    );
    assert.strictEqual(harness.state.project.instanceId, 'project-b');
    assert.strictEqual(harness.state.projectReady, true);
  });

  await test('starting a project entry cancels the old workspace debounce owner', async () => {
    const harness = createHarness();
    harness.state.workspaceTimer = setTimeout(() => {}, 10_000);
    harness.api.beginProjectEntry();
    assert.strictEqual(harness.state.workspaceTimer, null);
  });

  await test('recovery failure remains not-ready and publishes a clearing event', async () => {
    const harness = createHarness([{ ok: false }]);
    const token = harness.api.beginProjectEntry();
    const result = await harness.api.enterProject({
      ok: true,
      project: { instanceId: 'project-failed', name: '失败项目' },
      tree: [],
    }, token);
    assert.strictEqual(result, false);
    assert.strictEqual(harness.state.projectReady, false);
    assert.deepStrictEqual(harness.events.map(event => event.type), [
      'writcraft:project-entering',
      'writcraft:project-entry-failed',
    ]);
  });

  await test('a late A edit context cannot overwrite the ready B project context', async () => {
    const harness = createOwnedHelperHarness();
    const tokenA = harness.api.beginProjectEntry();
    const ownerA = harness.api.projectEntryOwner(tokenA, 'project-a');
    const loadingA = harness.api.loadEditContext(ownerA);
    await Promise.resolve();

    const tokenB = harness.api.beginProjectEntry();
    harness.state.project = { instanceId: 'project-b' };
    const ownerB = harness.api.projectEntryOwner(tokenB, 'project-b');
    assert.strictEqual(await harness.api.loadEditContext(ownerB), true);
    assert.strictEqual(harness.state.editContext, 'B prompt');

    harness.oldContext.resolve({
      ok: true,
      editPrompt: 'A prompt',
      editRevision: 'revision-a',
      projectPromptMissing: false,
      editFrontMatter: { title: 'A' },
    });
    assert.strictEqual(await loadingA, false);
    assert.strictEqual(harness.state.editContext, 'B prompt');
    assert.strictEqual(harness.state.editContextRevision, 'revision-b');
    assert.strictEqual(harness.state.promptFrontMatter.title, 'B');
  });

  await test('a late A legacy confirmation cannot install tree or editor state into B', async () => {
    const harness = createOwnedHelperHarness();
    const tokenA = harness.api.beginProjectEntry();
    const ownerA = harness.api.projectEntryOwner(tokenA, 'project-a');
    const importingA = harness.api.maybeOfferLegacyDraft(ownerA);
    await harness.confirmStarted.promise;

    harness.api.beginProjectEntry();
    harness.state.project = { instanceId: 'project-b' };
    harness.state.tree = [{ type: 'file', path: 'chapters/b.md' }];
    harness.oldConfirm.resolve({
      ok: true,
      tree: [{ type: 'file', path: 'chapters/imported-a.md' }],
      file: { path: 'chapters/imported-a.md' },
    });
    assert.strictEqual(await importingA, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.state.tree)), [
      { type: 'file', path: 'chapters/b.md' },
    ]);
    assert.deepStrictEqual(harness.mutations, []);
  });

  await test('a late A orphan recovery cannot install tree or editor state into B', async () => {
    const harness = createOwnedHelperHarness();
    const tokenA = harness.api.beginProjectEntry();
    const ownerA = harness.api.projectEntryOwner(tokenA, 'project-a');
    const recoveringA = harness.api.maybeOfferOrphanRecovery(ownerA);
    await harness.confirmStarted.promise;

    harness.api.beginProjectEntry();
    harness.state.project = { instanceId: 'project-b' };
    harness.state.tree = [{ type: 'file', path: 'chapters/b.md' }];
    harness.oldConfirm.resolve({
      ok: true,
      tree: [{ type: 'file', path: 'chapters/orphan-a.md' }],
      file: { path: 'chapters/orphan-a.md', revision: 'revision-a' },
    });
    assert.strictEqual(await recoveringA, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.state.tree)), [
      { type: 'file', path: 'chapters/b.md' },
    ]);
    assert.deepStrictEqual(harness.mutations, []);
  });

  await test('project entry requests are single-flight and only their owner can release', async () => {
    const state = {
      projectEntryGeneration: 0,
      projectEntryRequestGeneration: 0,
      projectEntryRequestOwner: null,
      project: null,
    };
    const context = vm.createContext({ state, document: { dispatchEvent() {} }, CustomEvent: function () {} });
    vm.runInContext(`${ownership}\nthis.api = { beginProjectEntryRequest, finishProjectEntryRequest };`, context);
    const first = context.api.beginProjectEntryRequest();
    assert.strictEqual(typeof first, 'number');
    assert.strictEqual(context.api.beginProjectEntryRequest(), null);
    assert.strictEqual(context.api.finishProjectEntryRequest(first + 1), false);
    assert.strictEqual(context.api.beginProjectEntryRequest(), null);
    assert.strictEqual(context.api.finishProjectEntryRequest(first), true);
    assert.strictEqual(typeof context.api.beginProjectEntryRequest(), 'number');
  });

  await test('AI availability is explicitly gated by projectReady', async () => {
    assert.match(source, /function canUseAI\(\) \{[\s\S]{0,180}state\.projectReady/);
    assert.match(source, /bridge\.openRecent\(\)[\s\S]{0,240}handleProjectResult\(result, entryGeneration\)/);
  });

  console.log(`\n${passed}/${passed} project-entry workspace ownership checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
