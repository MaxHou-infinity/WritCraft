#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
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
    clickCount: 0,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    click() {
      this.clickCount += 1;
      for (const handler of listeners.get('click') || []) handler({ target: this, preventDefault() {} });
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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const mounts = [];
  const released = [];
  const accepted = [];
  const proposal = deferred();
  const bridge = {
    async proposeOnboarding() { return proposal.promise; },
    async discardChanges(projectInstanceId, changeSetId) {
      released.push({ projectInstanceId, changeSetId });
      return { ok: true };
    },
    onExternalChange() { return () => {}; },
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
    WritCraftOnboardingState: {},
    WritCraftProjectOnboarding: {
      mount(_host, options) {
        const controller = {
          destroyed: false,
          destroy() { this.destroyed = true; },
        };
        mounts.push({ options, controller });
        return controller;
      },
    },
    __changesView: {
      canStartOnboarding() { return { ok: true }; },
      close() {},
      acceptProposal(result) {
        accepted.push(result);
        return { ok: true };
      },
    },
    __graphView: { close() {} },
    __assistantDock: { close() {}, isOpen() { return false; } },
    __editor: {
      getContent() { return ''; },
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
  return {
    api: window.WritCraftWorkspace,
    mounts,
    released,
    accepted,
    proposal,
    elements,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run() {
  console.log('\nOnboarding workspace dynamic verification');

  await test('NO_KEY settings detour restores the exact project draft', async () => {
    const { api, mounts, elements } = harness();
    const draft = { step: 'review', answers: { purpose: '真实项目主旨' } };
    api.state.project = { instanceId: 'project-a', name: 'A' };
    api.state.projectPromptMissing = false;
    assert.strictEqual(api.openProjectOnboarding(), true);
    mounts.at(-1).options.onSessionChange(draft);
    mounts.at(-1).options.onOpenSettings(draft);
    assert.strictEqual(elements.get('activity-settings').clickCount, 1);
    assert.deepStrictEqual(plain(api.state.onboardingDraft), {
      projectInstanceId: 'project-a',
      session: draft,
    });
    assert.strictEqual(api.openProjectOnboarding(), true);
    assert.deepStrictEqual(plain(mounts.at(-1).options.session), draft);
  });

  await test('another project never receives the previous project draft', async () => {
    const { api, mounts } = harness();
    const draftA = { step: 'review', answers: { purpose: 'A 项目' } };
    api.state.project = { instanceId: 'project-a', name: 'A' };
    api.state.projectPromptMissing = false;
    api.openProjectOnboarding();
    mounts.at(-1).options.onSessionChange(draftA);
    api.state.project = { instanceId: 'project-b', name: 'B' };
    api.openProjectOnboarding();
    assert.strictEqual(mounts.at(-1).options.session, undefined);
    const draftB = { step: 'questions', answers: { purpose: 'B 项目' } };
    mounts.at(-1).options.onSessionChange(draftB);
    assert.deepStrictEqual(plain(api.state.onboardingDraft), {
      projectInstanceId: 'project-b',
      session: draftB,
    });
  });

  await test('successful completion clears the saved draft', async () => {
    const { api, mounts } = harness();
    api.state.project = { instanceId: 'project-a', name: 'A' };
    api.state.projectPromptMissing = false;
    api.openProjectOnboarding();
    mounts.at(-1).options.onSessionChange({ step: 'review' });
    assert.ok(api.state.onboardingDraft);
    mounts.at(-1).options.onComplete();
    assert.strictEqual(api.state.onboardingDraft, null);
  });

  await test('a late proposal from a destroyed project session is released, not applied', async () => {
    const { api, mounts, proposal, released, accepted } = harness();
    api.state.project = { instanceId: 'project-a', name: 'A' };
    api.state.projectPromptMissing = false;
    api.openProjectOnboarding();
    const pending = mounts.at(-1).options.onGenerate({ answers: {} }, {}, 'attempt-a');
    api.state.project = { instanceId: 'project-b', name: 'B' };
    api.openProjectOnboarding();
    proposal.resolve({ ok: true, changeSetId: 'changes-a' });
    const result = await pending;
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /项目或项目卡会话已变化/);
    assert.deepStrictEqual(released, [{
      projectInstanceId: 'project-a',
      changeSetId: 'changes-a',
    }]);
    assert.strictEqual(accepted.length, 0);
  });

  console.log(`\n${passed}/${passed} onboarding workspace dynamic checks passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
