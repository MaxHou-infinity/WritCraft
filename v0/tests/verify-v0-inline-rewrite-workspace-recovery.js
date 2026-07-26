#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Transaction = require('../src/renderer/inline-rewrite-transaction');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
const REVISION = '2'.repeat(64);
const REWRITE_ID = `ir_${'a'.repeat(32)}`;
const HISTORY_ID = 'change_12345678-1234-4123-8123-123456789abc';
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
    emit(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler({
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
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

function reconciliation(status, marker = null) {
  return {
    ok: true,
    schema: 'writcraft.inline-rewrite-reconciliation-result/v1',
    status,
    marker,
  };
}

function marker(outcome = 'applied', overrides = {}) {
  return {
    rewriteId: REWRITE_ID,
    path: 'chapters/01.md',
    state: 'terminal',
    outcome,
    revision: REVISION,
    historyEntryId: outcome === 'zero_write_error' ? null : HISTORY_ID,
    errorCode: outcome === 'zero_write_error' ? 'INLINE_REWRITE_WRITE_FAILED' : null,
    updatedAt: 2000000000000,
    ...overrides,
  };
}

function harness(options = {}) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const calls = { query: 0, clear: [], read: [], tree: 0, history: 0, write: 0, loaded: [] };
  const responses = [...(options.reconciliations || [reconciliation('none')])];
  const projectBridge = {
    async readFile(relPath) {
      calls.read.push(relPath);
      return options.readResult || { ok: true, content: '# authoritative', revision: REVISION, frontMatter: null };
    },
    async listTree() {
      calls.tree += 1;
      return options.treeResult || { ok: true, tree: [] };
    },
    async listChangeHistory() {
      calls.history += 1;
      return options.historyResult || { ok: true, history: [{ id: HISTORY_ID }] };
    },
    async writeFile() { calls.write += 1; return { ok: true }; },
  };
  const writCraft = {
    project: projectBridge,
    async getRewriteReconciliation(_projectInstanceId, payload) {
      calls.query += 1;
      assert.strictEqual(payload?.schema, 'writcraft.inline-rewrite-reconciliation/v1');
      assert.deepStrictEqual(Object.keys(payload), ['schema']);
      return responses.length > 1 ? responses.shift() : responses[0];
    },
    async clearRewriteReconciliation(_projectInstanceId, payload) {
      calls.clear.push(JSON.parse(JSON.stringify(payload)));
      return options.clearResult || {
        ok: true,
        schema: 'writcraft.inline-rewrite-reconciliation-clear-result/v1',
        status: 'cleared',
      };
    },
  };
  const document = {
    getElementById: getElement,
    querySelector(selector) { return getElement(selector); },
    querySelectorAll() { return []; },
    createElement(tag) { return element(tag); },
    addEventListener() {},
    dispatchEvent() {},
  };
  const local = new Map();
  const window = {
    writCraft,
    WritCraftInlineRewriteTransaction: Transaction,
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
  return { api, calls, elements };
}

async function run() {
  console.log('\nInline Rewrite workspace recovery gate verification');

  await test('blocking cancels pending saves and makes persist/input fail closed', async () => {
    const { api, calls, elements } = harness();
    api.state.dirty = true;
    const version = api.state.editVersion;
    const result = await api.beginInlineRewriteRecovery({ kind: 'trusted_success', rewriteId: REWRITE_ID });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(elements.get('editor').contentEditable, 'false');
    assert.strictEqual(await api.persistCurrent(true), false);
    elements.get('editor').emit('input');
    assert.strictEqual(api.state.editVersion, version);
    assert.strictEqual(calls.write, 0);
  });

  await test('trusted commit reloads target, tree and public History before exact marker clear', async () => {
    const terminal = marker('applied');
    const { api, calls, elements } = harness({ reconciliations: [reconciliation('terminal', terminal)] });
    const result = await api.completeInlineRewriteCommit({
      status: 'applied',
      path: terminal.path,
      revision: terminal.revision,
      rewriteId: terminal.rewriteId,
      historyEntryId: terminal.historyEntryId,
    });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.authoritativeReloaded, true);
    assert.deepStrictEqual(calls.read, ['chapters/01.md']);
    assert.strictEqual(calls.tree, 1);
    assert.strictEqual(calls.history, 1);
    assert.deepStrictEqual(calls.clear, [{
      schema: 'writcraft.inline-rewrite-reconciliation-clear/v1',
      rewriteId: REWRITE_ID,
    }]);
    assert.deepStrictEqual(calls.loaded, ['# authoritative']);
    assert.strictEqual(api.state.revision, REVISION);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
    assert.strictEqual(elements.get('editor').contentEditable, 'true');
  });

  await test('applying uses bounded polling and outcome-unknown installs only authoritative disk truth', async () => {
    const applying = marker('applied', {
      state: 'applying', outcome: null, revision: null, historyEntryId: null, errorCode: null,
    });
    const terminal = marker('applied');
    const { api, calls } = harness({
      reconciliations: [reconciliation('applying', applying), reconciliation('terminal', terminal)],
    });
    const result = await api.beginInlineRewriteRecovery({
      kind: 'outcome_unknown', rewriteId: REWRITE_ID,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.query, 2);
    assert.deepStrictEqual(calls.loaded, ['# authoritative']);
  });

  await test('known zero-write clears an existing terminal marker before allowing restore', async () => {
    const terminal = marker('zero_write_error');
    const { api, calls } = harness({
      reconciliations: [reconciliation('terminal', terminal)],
      historyResult: { ok: true, history: [] },
    });
    api.state.revision = REVISION;
    const result = await api.restoreInlineRewriteAfterZeroWrite({ rewriteId: REWRITE_ID });
    assert.strictEqual(result.safeToRestore, true);
    assert.strictEqual(result.authoritativeReloaded, true);
    assert.strictEqual(calls.loaded.length, 0, 'workspace must leave the bound preview for Editor to restore');
    assert.strictEqual(calls.clear.length, 1);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
  });

  await test('clear or authoritative reload failure remains globally blocked and requires reopen', async () => {
    const terminal = marker('applied');
    const { api, calls } = harness({
      reconciliations: [reconciliation('terminal', terminal)],
      clearResult: { ok: false },
    });
    const result = await api.completeInlineRewriteCommit({
      status: 'applied',
      path: terminal.path,
      revision: terminal.revision,
      rewriteId: terminal.rewriteId,
      historyEntryId: terminal.historyEntryId,
    });
    assert.strictEqual(result.status, 'reopen-required');
    assert.strictEqual(api.state.inlineMutationBlocked, true);
    assert.strictEqual(calls.loaded.length, 0);
  });

  await test('project-entry reconciliation unlocks only an exact none response', async () => {
    const { api, calls } = harness({ reconciliations: [reconciliation('none')] });
    const result = await api.reconcileInlineRewriteOnProjectEnter();
    assert.deepStrictEqual({ ok: result.ok, status: result.status }, { ok: true, status: 'ready' });
    assert.strictEqual(calls.query, 1);
    assert.strictEqual(api.state.inlineMutationBlocked, false);
    const enter = SOURCE.slice(SOURCE.indexOf('async function enterProject'), SOURCE.indexOf('function closeProjectOnboarding'));
    assert(enter.indexOf('await reconcileInlineRewriteOnProjectEnter()') < enter.indexOf('await loadEditContext()'));
    assert(enter.indexOf('if (!inlineRecovery.ok) return') < enter.indexOf('await openFile(initialPath)'));
  });

  console.log(`\n✅ Inline Rewrite workspace recovery ${passed}/${passed} passed`);
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
