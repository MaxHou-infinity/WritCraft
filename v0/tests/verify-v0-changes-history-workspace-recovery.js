#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Recovery = require('../src/renderer/changes-history-recovery-transaction');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
const OPERATION_ID = `chr_${'a'.repeat(48)}`;
const REVISION = '2'.repeat(64);
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function classList() {
  return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
}

function element(id = '') {
  const listeners = new Map();
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    innerText: '',
    contentEditable: 'true',
    dataset: {},
    style: {},
    classList: classList(),
    children: [],
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    setAttribute(name, value) { this[name] = String(value); },
    getAttribute(name) { return this[name] || null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains() { return false; },
    closest() { return null; },
    focus() {},
    scrollIntoView() {},
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
}

function marker(overrides = {}) {
  return {
    operationId: OPERATION_ID,
    kind: 'apply',
    state: 'terminal',
    outcome: 'applied',
    affectedPaths: ['chapters/01.md'],
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    actions: [],
    ...overrides,
  };
}

function query(recovery) {
  return {
    ok: true,
    schema: Recovery.QUERY_SCHEMA,
    recovery,
  };
}

function mutation(recovery = marker()) {
  return {
    ok: true,
    status: recovery.outcome,
    operationId: recovery.operationId,
    outcome: recovery.outcome,
    affectedPaths: [...recovery.affectedPaths],
  };
}

function harness(options = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const queryResponses = [...(options.queryResponses || [query(null)])];
  const calls = {
    order: [],
    loaded: [],
    recoveryStates: [],
    renderedHistory: [],
    clears: [],
    resolves: [],
  };
  const bridge = {
    async queryChangesHistoryRecovery() {
      calls.order.push('query');
      const next = queryResponses.length > 1 ? queryResponses.shift() : queryResponses[0];
      return typeof next === 'function' ? next() : next;
    },
    async listTree() {
      calls.order.push('tree');
      return options.treeResult || { ok: true, tree: [] };
    },
    async listChangeHistory() {
      calls.order.push('history');
      return options.historyResult || { ok: true, history: [{ id: 'change-1', status: 'applied' }] };
    },
    async readFile(relPath) {
      calls.order.push(`read:${relPath}`);
      return options.readResult || {
        ok: true,
        content: '# authoritative',
        revision: REVISION,
        frontMatter: null,
      };
    },
    async clearChangesHistoryRecovery(_projectInstanceId, operationId) {
      calls.order.push('clear');
      calls.clears.push(operationId);
      return options.clearResult || {
        ok: true,
        schema: Recovery.CLEAR_SCHEMA,
        operationId,
      };
    },
    async resolveChangesHistoryRecovery(_projectInstanceId, operationId, action) {
      calls.order.push('resolve');
      calls.resolves.push({ operationId, action });
      return options.resolveResult;
    },
    async clearRecovery() { return { ok: true }; },
  };
  const document = {
    getElementById: getElement,
    querySelector(selector) { return getElement(selector); },
    querySelectorAll() { return []; },
    createElement(tag) { return element(tag); },
    createDocumentFragment() { return element('fragment'); },
    addEventListener() {},
    dispatchEvent() {},
  };
  const local = new Map();
  const window = {
    writCraft: { project: bridge },
    WritCraftChangesHistoryRecovery: Recovery,
    __changesView: {
      setRecoveryState(value) { calls.recoveryStates.push(value); },
      clearRecoveryState() { calls.recoveryStates.push(null); },
      renderHistory(value) { calls.renderedHistory.push(value); },
    },
    __editor: {
      loadDocument(content) {
        calls.loaded.push(content);
        getElement('editor').innerText = content;
      },
      getContent() { return getElement('editor').innerText; },
      setProjectManaged() {},
    },
    addEventListener() {},
    getSelection() { return null; },
  };
  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: callback => callback(),
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init?.detail; },
    NodeFilter: { SHOW_TEXT: 4 },
    localStorage: {
      getItem(key) { return local.has(key) ? local.get(key) : null; },
      setItem(key, value) { local.set(key, value); },
      removeItem(key) { local.delete(key); },
    },
  });
  vm.runInContext(SOURCE, context, { filename: 'workspace.js' });
  const api = window.WritCraftWorkspace;
  api.state.project = { instanceId: 'project-1', name: '项目' };
  api.state.currentPath = 'chapters/01.md';
  api.state.revision = '1'.repeat(64);
  return { api, calls, elements, window };
}

async function run() {
  console.log('\nChanges / History workspace recovery verification');

  await test('independent blockers cannot unlock each other', async () => {
    const { api, elements } = harness();
    api.setInlineMutationBlocked(true, 'inline');
    api.setChangesHistoryMutationBlocked(true, 'changes');
    api.setInlineMutationBlocked(false);
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(elements.get('editor').contentEditable, 'false');
    api.setChangesHistoryMutationBlocked(false);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
    assert.strictEqual(elements.get('editor').contentEditable, 'true');
  });

  await test('trusted apply reloads tree, current file and History before exact clear', async () => {
    const recovery = marker();
    const { api, calls } = harness({ queryResponses: [query(recovery)] });
    api.beginChangesHistoryMutation();
    const result = await api.reconcileChangesHistoryAfterMutation('apply', mutation(recovery));
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.mutationTrusted, true);
    assert.deepStrictEqual(calls.order, [
      'query', 'tree', 'history', 'read:chapters/01.md', 'clear',
    ]);
    assert.deepStrictEqual(calls.loaded, ['# authoritative']);
    assert.strictEqual(calls.renderedHistory.length, 1);
    assert.deepStrictEqual(calls.clears, [OPERATION_ID]);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
  });

  await test('missing or malformed mutation response uses disk truth and never trusts old UI', async () => {
    const recovery = marker();
    const { api, calls } = harness({ queryResponses: [query(recovery)] });
    api.beginChangesHistoryMutation();
    const result = await api.reconcileChangesHistoryAfterMutation('apply', { ok: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mutationTrusted, false);
    assert.strictEqual(result.authoritativeReloaded, true);
    assert.strictEqual(calls.loaded.length, 1);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
  });

  await test('restore-before manual recovery remains locked until reload-clear completes', async () => {
    const uncertain = marker({
      outcome: 'manual_recovery',
      actions: ['restore_before', 'keep_after'],
    });
    const resolved = marker({ outcome: 'zero_write_error' });
    const { api, calls } = harness({
      queryResponses: [query(uncertain), query(resolved)],
      resolveResult: null,
    });
    api.state.currentPath = '';
    const entered = await api.reconcileChangesHistoryOnProjectEnter();
    assert.strictEqual(entered.status, 'manual_recovery');
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(calls.recoveryStates.at(-1).state, 'manual');
    const completed = await api.resolveChangesHistoryRecovery(OPERATION_ID, 'restore_before');
    assert.strictEqual(completed.ok, true, JSON.stringify(completed));
    assert.deepStrictEqual(calls.resolves, [{
      operationId: OPERATION_ID,
      action: 'restore_before',
    }]);
    assert.strictEqual(calls.order.at(-1), 'clear');
    assert.strictEqual(api.state.inlineMutationBlocked, false);
  });

  await test('keep-after can retry the same action after a still-manual result', async () => {
    const uncertain = marker({
      outcome: 'manual_recovery',
      actions: ['restore_before', 'keep_after'],
    });
    const resolved = marker({ outcome: 'applied' });
    const { api, calls } = harness({
      queryResponses: [query(uncertain), query(uncertain), query(resolved)],
      resolveResult: null,
    });
    api.state.currentPath = '';
    const entered = await api.reconcileChangesHistoryOnProjectEnter();
    assert.strictEqual(entered.status, 'manual_recovery');

    const first = await api.resolveChangesHistoryRecovery(OPERATION_ID, 'keep_after');
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.status, 'manual_recovery');
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(calls.recoveryStates.at(-1).state, 'manual');

    const second = await api.resolveChangesHistoryRecovery(OPERATION_ID, 'keep_after');
    assert.strictEqual(second.ok, true, JSON.stringify(second));
    assert.strictEqual(second.status, 'applied');
    assert.deepStrictEqual(calls.resolves, [
      { operationId: OPERATION_ID, action: 'keep_after' },
      { operationId: OPERATION_ID, action: 'keep_after' },
    ]);
    assert.strictEqual(calls.order.at(-1), 'clear');
    assert.strictEqual(api.state.inlineMutationBlocked, false);
  });

  await test('reload or clear failure never releases the Changes blocker', async () => {
    const recovery = marker();
    const reloadFailure = harness({
      queryResponses: [query(recovery)],
      historyResult: { ok: false },
    });
    reloadFailure.api.beginChangesHistoryMutation();
    const failedReload = await reloadFailure.api.reconcileChangesHistoryAfterMutation(
      'apply',
      mutation(recovery)
    );
    assert.strictEqual(failedReload.ok, false);
    assert.strictEqual(reloadFailure.api.state.inlineMutationBlocked, true);
    assert.strictEqual(reloadFailure.calls.clears.length, 0);

    const clearFailure = harness({
      queryResponses: [query(recovery)],
      clearResult: { ok: false },
    });
    clearFailure.api.beginChangesHistoryMutation();
    const failedClear = await clearFailure.api.reconcileChangesHistoryAfterMutation(
      'apply',
      mutation(recovery)
    );
    assert.strictEqual(failedClear.ok, false);
    assert.strictEqual(clearFailure.api.state.inlineMutationBlocked, true);
  });

  await test('late project-A query cannot clear or poison project-B blockers', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { api } = harness({ queryResponses: [() => pending] });
    api.beginChangesHistoryMutation();
    const old = api.reconcileChangesHistoryAfterMutation('apply', mutation());
    api.state.project = { instanceId: 'project-2', name: '另一个项目' };
    api.state.mutationBlockers = {};
    api.setChangesHistoryMutationBlocked(true, 'project-b-checking');
    release(query(marker()));
    const result = await old;
    assert.strictEqual(result.canceled, true);
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(api.state.inlineMutationBlockReason, 'project-b-checking');
  });

  console.log(`\nChanges / History workspace recovery: ${passed}/${passed} passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
