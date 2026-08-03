'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function functionSource(source, start, next) {
  return source.slice(source.indexOf(start), source.indexOf(next));
}

async function verifyReturnStackOwner() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'workspace.js'), 'utf8');
  const code = functionSource(source, '  async function returnToPreviousLocation()', '  function updateOutlineViewState');
  const opened = deferred();
  const entryA = { view: 'editor', editorReturnState: { path: 'a.md', revision: 'a'.repeat(64) } };
  const entryB = { view: 'project_home', editorReturnState: null };
  const state = { project: { instanceId: 'A' }, returnStack: [entryA], returnOperationGeneration: 0, revision: 'a'.repeat(64) };
  const mutations = [];
  const context = vm.createContext({
    state,
    setWorkspaceView: value => { mutations.push(`view:${value}`); return true; },
    openFile: async () => opened.promise,
    restoreSelection: () => mutations.push('selection'),
    editorScroll: { scrollTop: 0 },
    setSaveState: value => mutations.push(`status:${value}`),
    bridge: { dailyWorkspace: {} },
    revealRange: () => mutations.push('reveal'),
    updateWorkspaceReturnControl: () => mutations.push('control'),
    scheduleWorkspaceSave: () => mutations.push('save'),
    window: {},
  });
  vm.runInContext(`${code}\nthis.run = returnToPreviousLocation;`, context);
  const pending = context.run();
  state.project = { instanceId: 'B' };
  state.returnStack = [entryB];
  opened.resolve(true);
  assert.strictEqual(await pending, false);
  assert.deepStrictEqual(state.returnStack, [entryB]);
  assert(!mutations.includes('selection'));
  assert(!mutations.includes('reveal'));
}

async function verifyHomeOwner() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'project-home-view.js'), 'utf8');
  const begin = functionSource(source, '  function beginNavigation()', '  function setStatus');
  const resolve = functionSource(source, '  async function resolveTarget', '  async function openResolved');
  const open = functionSource(source, '  async function openResolved', '  function openPending');
  const result = deferred();
  const state = { project: { instanceId: 'A' }, revision: 'a'.repeat(64) };
  const mutations = [];
  const workspace = {
    state,
    setWorkspaceView: value => mutations.push(`view:${value}`),
    openFile: async () => { mutations.push('open'); return true; },
    pushReturnLocation: () => mutations.push('push'),
    revealRange: () => mutations.push('reveal'),
  };
  const context = vm.createContext({
    navigationSequence: 0,
    window: {
      __workspace: workspace,
      __dailyWorkspaceView: { refreshOutline: async () => mutations.push('outline') },
    },
    bridge: { resolveStableLocation: async () => result.promise },
    view: { scrollTop: 0 },
    setStatus: () => mutations.push('status'),
  });
  vm.runInContext(`function project(){ return window.__workspace.state.project; }\n${begin}\n${resolve}\n${open}\nthis.run = openResolved;`, context);
  const pending = context.run({ kind: 'file', path: 'a.md' });
  state.project = { instanceId: 'B' };
  result.resolve({ ok: true, result: { target: { action: 'open_file', filePath: 'a.md', revision: 'a'.repeat(64), offset: 0, endOffset: 1 } } });
  await pending;
  assert.deepStrictEqual(mutations, []);

  state.project = { instanceId: 'A' };
  mutations.length = 0;
  context.bridge.resolveStableLocation = async () => ({
    ok: true,
    result: { target: { action: 'open_file', filePath: 'a.md', revision: 'a'.repeat(64), offset: 0, endOffset: 1 } },
  });
  await context.run({ kind: 'file', path: 'a.md' });
  assert(mutations.indexOf('outline') > mutations.indexOf('open'));
  assert(mutations.indexOf('reveal') > mutations.indexOf('outline'));

  const back = functionSource(source, '  async function returnToOrigin()', '  backButton.addEventListener');
  const backOpened = deferred();
  state.project = { instanceId: 'A' };
  mutations.length = 0;
  workspace.openFile = async () => backOpened.promise;
  const backContext = vm.createContext({
    navigationSequence: 0,
    origin: { projectInstanceId: 'A', path: 'a.md', caretOffset: 3 },
    window: { __workspace: workspace },
  });
  vm.runInContext(`function project(){ return window.__workspace.state.project; }\n${begin}\n${back}\nthis.run = returnToOrigin;`, backContext);
  const backPending = backContext.run();
  state.project = { instanceId: 'B' };
  backOpened.resolve(true);
  await backPending;
  assert(!mutations.includes('reveal'));
}

(async () => {
  await verifyReturnStackOwner();
  await verifyHomeOwner();
  console.log('verify-v0-workspace-return-ownership: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
