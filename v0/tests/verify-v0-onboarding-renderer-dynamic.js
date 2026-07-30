'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const onboardingState = require('../src/renderer/onboarding-state');
const onboardingView = require('../src/renderer/project-onboarding-view');
const onboardingMain = require('../src/main/project-onboarding-v2-service');

class FakeClassList {
  constructor(node) { this.node = node; }
  values() { return new Set(String(this.node.className || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.node.className = [...values].join(' '); }
  add(...names) { const values = this.values(); names.forEach(name => values.add(name)); this.write(values); }
  remove(...names) { const values = this.values(); names.forEach(name => values.delete(name)); this.write(values); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const values = this.values();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name); else values.delete(name);
    this.write(values);
    return enabled;
  }
}

function matches(node, rawSelector) {
  let selector = rawSelector.trim();
  if (!selector) return false;
  if (selector.includes(':not([disabled])')) {
    if (node.disabled) return false;
    selector = selector.replace(':not([disabled])', '');
  }
  if (selector === '[tabindex]:not([tabindex="-1"])') {
    return Number.isInteger(node.tabIndex) && node.tabIndex !== -1;
  }
  if (selector.includes('>')) selector = selector.split('>').pop().trim();
  const checked = selector.endsWith(':checked');
  if (checked) selector = selector.slice(0, -8);
  if (checked && !node.checked) return false;
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector === '[data-onboarding-path]') return typeof node.dataset.onboardingPath === 'string';
  if (selector === '[data-plan-provenance]') return node.dataset.planProvenance === 'true';
  if (selector === '[data-issue-provenance]') return node.dataset.issueProvenance === 'true';
  if (selector === 'input[type="checkbox"]') return node.tagName === 'INPUT' && node.type === 'checkbox';
  const id = selector.match(/^#(.+)$/);
  if (id) return node.id === id[1];
  return node.tagName === selector.toUpperCase();
}

class FakeNode {
  constructor(document, tagName = 'div', id = '') {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.classList = new FakeClassList(this);
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.type = '';
  }
  get isConnected() {
    let current = this;
    while (current?.parentElement) current = current.parentElement;
    return current === this.ownerDocument.body;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  insertBefore(node, before) {
    node.parentElement = this;
    const index = this.children.indexOf(before);
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parentElement = null; });
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener));
  }
  async dispatch(name, detail = {}) {
    const event = { target: this, preventDefault() {}, ...detail };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) {
    if (node === this) return true;
    return this.children.some(child => child.contains(node));
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(item => item.trim());
    const output = [];
    const visit = node => {
      for (const child of node.children) {
        if (selectors.some(item => matches(child, item))) output.push(child);
        visit(child);
      }
    };
    visit(this);
    return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    let current = this;
    while (current) { if (matches(current, selector)) return current; current = current.parentElement; }
    return null;
  }
}

class FakeDocument {
  constructor(ids = []) {
    this.listeners = new Map();
    this.body = new FakeNode(this, 'body', 'body');
    this.activeElement = this.body;
    this.elements = new Map();
    this.root = this.createElement('div');
    this.body.appendChild(this.root);
    for (const id of ids) {
      const node = new FakeNode(this, id.includes('instruction') ? 'textarea' : id.includes('button') ? 'button' : 'div', id);
      this.elements.set(id, node);
      this.root.appendChild(node);
    }
  }
  createElement(tagName) { return new FakeNode(this, tagName); }
  getElementById(id) { return this.elements.get(id) || null; }
  querySelector(selector) { return this.body.querySelector(selector); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)].filter(Boolean).join(' ');
}

function findByText(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    const found = findByText(child, text);
    if (found) return found;
  }
  return null;
}

function acceptFirstReviewItem(node) {
  const control = findByText(node, '接受') || findByText(node, '本文件全接受');
  assert(control, 'review accept control missing');
  return control.click();
}

function reviewStateApi() {
  const clone = state => ({ review: state.review, decisions: { ...state.decisions } });
  return {
    create(review) {
      if (!review?.changeSetId || !Array.isArray(review.files)) return null;
      const decisions = {};
      review.files.forEach(file => file.hunks.forEach(hunk => { decisions[hunk.id] = 'pending'; }));
      return { review, decisions };
    },
    update(state, id, decision) { const next = clone(state); next.decisions[id] = decision; return next; },
    updateFile(state, filePath, decision) {
      const next = clone(state);
      state.review.files.find(file => file.path === filePath)?.hunks.forEach(hunk => { next.decisions[hunk.id] = decision; });
      return next;
    },
    counts(state) {
      const values = Object.values(state.decisions);
      return {
        total: values.length,
        accepted: values.filter(value => value === 'accepted').length,
        rejected: values.filter(value => value === 'rejected').length,
        pending: values.filter(value => value === 'pending').length,
      };
    },
    toDecision(state) {
      if (Object.values(state.decisions).every(value => value === 'pending')) return null;
      return { changeSetId: state.review.changeSetId, decisions: { ...state.decisions } };
    },
  };
}

const IDS = [
  'work-area', 'changes-panel', 'changes-instruction', 'changes-preview', 'changes-commit-notice',
  'changes-status', 'changes-propose', 'changes-chapter', 'changes-apply', 'changes-discard',
  'activity-changes', 'changes-history-list', 'ai-metrics-view', 'composer-context-picker',
  'composer-context-count', 'composer-context-list', 'project-changes-target-picker',
  'project-changes-target-count', 'project-changes-target-list', 'changes-close', 'save-state',
];

function loadChangesHarness(overrides = {}) {
  const document = new FakeDocument(IDS);
  const commitNotice = document.getElementById('changes-commit-notice');
  commitNotice.append(document.createElement('strong'), document.createElement('span'));
  const calls = {
    apply: 0,
    reconcile: 0,
    confirm: 0,
    discardConfirmation: 0,
    discardChanges: 0,
    refresh: 0,
    reload: 0,
    open: 0,
    history: 0,
    undo: 0,
    undoArgs: [],
    metrics: [],
  };
  const bridge = {
    listChangeHistory: async () => { calls.history += 1; return { ok: true, history: overrides.history || [] }; },
    undoChange: async (...args) => {
      calls.undo += 1;
      calls.undoArgs.push(args);
      return typeof overrides.undoResult === 'function'
        ? overrides.undoResult(...args) : overrides.undoResult;
    },
    applyChanges: async () => { calls.apply += 1; return overrides.applyResult; },
    confirmOnboardingFiles: async (...args) => {
      calls.confirm += 1;
      calls.confirmArgs = args;
      return typeof overrides.confirmResult === 'function' ? overrides.confirmResult(...args) : overrides.confirmResult;
    },
    discardOnboardingConfirmation: async (...args) => {
      calls.discardConfirmation += 1;
      calls.discardArgs = args;
      return typeof overrides.discardConfirmationResult === 'function'
        ? overrides.discardConfirmationResult(...args) : overrides.discardConfirmationResult || { ok: true };
    },
    discardChanges: async (...args) => {
      calls.discardChanges += 1;
      calls.discardChangesArgs = args;
      return typeof overrides.discardChangesResult === 'function'
        ? overrides.discardChangesResult(...args) : overrides.discardChangesResult || { ok: true };
    },
  };
  const workspace = {
    state: { project: { instanceId: 'instance_aaaaaaaaaaaaaaaaaaaaaaaa' }, tree: [] },
    persistCurrent: async (...args) => typeof overrides.persistCurrent === 'function'
      ? overrides.persistCurrent(...args) : overrides.persistCurrent === undefined ? true : overrides.persistCurrent,
    beginChangesHistoryMutation() {
      if (overrides.recoveryUiDuringMutation) {
        window.__changesView.setRecoveryState({
          blocked: true,
          state: 'checking',
          title: '正在确认项目写入',
          message: '正在核对撤销事务',
        });
      }
    },
    reconcileChangesHistoryAfterMutation: async (...args) => {
      calls.reconcile += 1;
      if (overrides.recoveryUiDuringMutation) window.__changesView.clearRecoveryState();
      if (typeof overrides.reconcileResult === 'function') {
        return overrides.reconcileResult(...args);
      }
      if (overrides.reconcileResult) return overrides.reconcileResult;
      return overrides.applyResult?.ok
        ? {
          ok: true,
          status: overrides.applyResult.applied?.length ? 'applied' : 'reviewed',
          mutationTrusted: true,
          authoritativeReloaded: true,
        }
        : {
          ok: true,
          status: 'ready',
          mutationTrusted: false,
          authoritativeReloaded: false,
        };
    },
    refreshTree: async () => {
      calls.refresh += 1;
      if (overrides.refreshNever) return new Promise(() => {});
      if (overrides.refreshError) throw overrides.refreshError;
    },
    getCurrentPath: () => overrides.currentPath || 'edit.md',
    reloadCurrent: async () => { calls.reload += 1; return true; },
    openFile: async (...args) => { calls.open += 1; calls.openArgs = args; return true; },
    setAIVisible() {},
  };
  const window = {
    writCraft: { project: bridge },
    __workspace: workspace,
    __assistantDock: { open() {}, close() {} },
    WritCraftChangesReviewState: reviewStateApi(),
    WritCraftAiMetrics: {
      createOperationId: () => 'f'.repeat(32),
      record: async (originProjectInstanceId, event) => {
        calls.metrics.push({ originProjectInstanceId, event });
        return typeof overrides.metricResult === 'function'
          ? overrides.metricResult(originProjectInstanceId, event, calls.metrics.length)
          : overrides.metricResult === undefined ? true : overrides.metricResult;
      },
      aggregate: async () => ({ status: 'ready', metrics: {} }),
    },
    confirm: () => true,
    addEventListener() {},
  };
  const context = {
    window, document, console, Date: overrides.Date || Date, Object, Set, Map, Promise,
    requestAnimationFrame: callback => callback(),
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    setTimeout, clearTimeout,
    setInterval: overrides.setInterval || setInterval,
    clearInterval: overrides.clearInterval || clearInterval,
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/changes-view.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'changes-view.js' });
  return { document, window, bridge, workspace, calls };
}

function changedProposal() {
  return {
    ok: true,
    noChanges: false,
    proposalKind: 'onboarding_v2',
    changeSetId: 'pc_11111111111111111111111111111111',
    proposalDigest: 'a'.repeat(64),
    fileSuggestions: [{ path: 'chapters/a.md', title: 'A', reason: '建立章节' }],
    review: {
      changeSetId: 'pc_11111111111111111111111111111111', totalHunks: 1,
      files: [{
        path: 'edit.md', summary: '更新项目说明', selectionPolicy: 'file',
        hunks: [{ id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'add', text: '项目主旨' }] }],
      }],
    },
  };
}

function ordinaryProposal() {
  return {
    ok: true,
    noChanges: false,
    proposalKind: 'changeset',
    changeSetId: 'pc_33333333333333333333333333333333',
    review: {
      changeSetId: 'pc_33333333333333333333333333333333', totalHunks: 1,
      files: [{
        path: 'chapters/a.md', summary: '更新正文', selectionPolicy: 'file',
        hunks: [{ id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'add', text: '新正文' }] }],
      }],
    },
  };
}

function confirmation(source = 'no_op') {
  return {
    token: 'oct_' + '2'.repeat(32), proposalDigest: 'a'.repeat(64), source,
    fileSuggestions: [{ path: 'chapters/a.md', title: 'A', reason: '建立章节' }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert(predicate(), 'expected async checkpoint was not reached');
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert(start >= 0, `missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

(async () => {
  console.log('\nOnboarding v2 Renderer dynamic verification');

  await test('project card emits the exact ordered non-empty v2 request', async () => {
    const document = new FakeDocument();
    const underlay = document.createElement('button');
    const host = document.createElement('section');
    document.root.append(underlay, host);
    underlay.focus();
    let received = null;
    const originalAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = callback => callback();
    const controller = onboardingView.mount(host, {
      stateApi: onboardingState,
      session: {
        status: 'review', currentIndex: 9,
        answers: { structure: '三章', premise: '核心命题' }, skipped: [],
      },
      onGenerate: async request => {
        received = request;
        return {
          ok: false,
          error: 'RESERVED_SUGGESTION_PATH',
          message: '初始文件不得写入项目 Prompt、内部目录或只读来源目录',
        };
      },
    });
    assert.strictEqual(host.getAttribute('role'), 'dialog');
    assert.strictEqual(host.getAttribute('aria-modal'), 'true');
    assert(underlay.hasAttribute('inert'));
    assert.strictEqual(document.activeElement, host);
    await host.dispatch('keydown', { key: 'Tab', shiftKey: false });
    assert(host.contains(document.activeElement));
    assert.notStrictEqual(document.activeElement, host);
    await findByText(host, '生成 edit.md 提案').click();
    assert.strictEqual(received.schema, onboardingMain.REQUEST_SCHEMA);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(received.answers)), [
      { id: 'premise', text: '核心命题' }, { id: 'structure', text: '三章' },
    ]);
    assert(allText(host).includes('AI 的新文件建议包含不适合创建的位置'));
    assert(allText(host).includes('本次没有修改任何项目文件'));
    assert(!allText(host).includes('JSON'));
    assert(!allText(host).includes('内部目录'));
    controller.destroy();
    global.requestAnimationFrame = originalAnimationFrame;
    assert(!underlay.hasAttribute('inert'));
    assert.strictEqual(document.activeElement, underlay);
  });

  await test('project card exposes live truthful progress while generation is unsettled', async () => {
    const document = new FakeDocument();
    const host = document.createElement('section');
    document.root.append(host);
    const originalAnimationFrame = global.requestAnimationFrame;
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalDateNow = Date.now;
    let progressTick = null;
    let now = 1000;
    global.requestAnimationFrame = callback => callback();
    global.setInterval = callback => { progressTick = callback; return 7; };
    global.clearInterval = () => { progressTick = null; };
    Date.now = () => now;
    let resolveGeneration;
    const deferred = new Promise(resolve => { resolveGeneration = resolve; });
    const controller = onboardingView.mount(host, {
      stateApi: onboardingState,
      session: { status: 'review', currentIndex: 9, answers: { premise: '核心命题' }, skipped: [] },
      onGenerate: () => deferred,
    });
    const generationClick = findByText(host, '生成 edit.md 提案').click();
    await Promise.resolve();
    assert(allText(host).includes('AI 正在整理项目说明'));
    assert(allText(host).includes('项目卡已提交'));
    assert(allText(host).includes('整理内容并检查建议'));
    assert(allText(host).includes('进入修改预览'));
    assert(allText(host).includes('已等待 0 秒'));
    assert(allText(host).includes('请勿重复提交'));
    assert.strictEqual(findByText(host, 'AI 整理中').disabled, true);
    now = 3100;
    progressTick();
    assert(allText(host).includes('已等待 2 秒'));
    resolveGeneration({ ok: true });
    await generationClick;
    controller.destroy();
    global.requestAnimationFrame = originalAnimationFrame;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    Date.now = originalDateNow;
  });

  await test('project card dynamically records structured_failed→retried→generated without answer content', async () => {
    const document = new FakeDocument();
    const host = document.createElement('section');
    document.root.append(host);
    const events = [];
    let operation = 0;
    let attempts = 0;
    const previousMetrics = global.WritCraftAiMetrics;
    const previousWorkspace = global.__workspace;
    const originalAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = callback => callback();
    global.__workspace = { state: { project: { instanceId: 'instance_metrics_author_evidence' } } };
    global.WritCraftAiMetrics = {
      createOperationId: () => (++operation).toString(16).padStart(32, '0'),
      record: (originProjectInstanceId, event) => {
        events.push({ originProjectInstanceId, event });
        return true;
      },
    };
    try {
      const controller = onboardingView.mount(host, {
        stateApi: onboardingState,
        session: { status: 'review', currentIndex: 9, answers: { premise: '不得进入指标的作者答案' }, skipped: [] },
        onGenerate: async () => (++attempts === 1
          ? { ok: false, error: 'INVALID_FILE_SUGGESTIONS', message: '合法 JSON 但 suggestion 结构非法；不得记录' }
          : { ok: true }),
      });
      await findByText(host, '生成 edit.md 提案').click();
      await findByText(host, '重新整理 edit.md').click();
      assert.deepStrictEqual(events.map(item => item.event.outcome), ['structured_failed', 'retried', 'generated']);
      assert.equal(events[1].event.operationId, events[2].event.operationId, 'retry marker and result must correlate');
      assert(events.every(item => item.originProjectInstanceId === 'instance_metrics_author_evidence'));
      assert(events.every(item => Object.keys(item.event).sort().join(',') ===
        'action,afterChars,beforeChars,durationMs,operationId,outcome,scope,style'));
      assert(!JSON.stringify(events).includes('作者答案'));
      assert(!JSON.stringify(events).includes('suggestion 结构非法'));
      controller.destroy();

      const genericHost = document.createElement('section');
      document.root.append(genericHost);
      const genericController = onboardingView.mount(genericHost, {
        stateApi: onboardingState,
        session: { status: 'review', currentIndex: 9, answers: { premise: '仍然不记录' }, skipped: [] },
        onGenerate: async () => ({ ok: false, error: 'LLM_FAILED', message: 'provider detail' }),
      });
      await findByText(genericHost, '生成 edit.md 提案').click();
      assert.equal(events.at(-1).event.outcome, 'failed', 'non-structured provider failure stays generic');
      genericController.destroy();
    } finally {
      global.WritCraftAiMetrics = previousMetrics;
      global.__workspace = previousWorkspace;
      global.requestAnimationFrame = originalAnimationFrame;
    }
  });

  await test('NO_KEY explains the pre-provider block and opens Settings without losing answers', async () => {
    const document = new FakeDocument();
    const host = document.createElement('section');
    document.root.append(host);
    const originalAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = callback => callback();
    let settingsSession = null;
    try {
      const controller = onboardingView.mount(host, {
        stateApi: onboardingState,
        session: {
          status: 'review', currentIndex: 9,
          answers: { premise: '需要继续保留的项目主旨' }, skipped: [],
        },
        onGenerate: async () => ({ ok: false, error: 'NO_KEY' }),
        onOpenSettings: session => { settingsSession = session; },
      });
      await findByText(host, '生成 edit.md 提案').click();
      assert(allText(host).includes('这次没有调用 AI'));
      assert(allText(host).includes('当前 App 尚未配置 MiniMax Key'));
      assert(allText(host).includes('项目文件没有变化'));
      assert(!allText(host).includes('AI 暂时没有完成整理'));
      await findByText(host, '打开设置').click();
      assert.strictEqual(settingsSession.answers.premise, '需要继续保留的项目主旨');
      controller.destroy();
    } finally {
      global.requestAnimationFrame = originalAnimationFrame;
    }
  });

  await test('changed proposal applies edit only, then enters a separate confirmation', async () => {
    const harness = loadChangesHarness({
      applyResult: { ok: true, applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }], onboardingConfirmation: confirmation('review') },
      confirmResult: { ok: true, files: [{ path: 'chapters/a.md', bytes: 5, revision: 'c'.repeat(64) }] },
    });
    assert.strictEqual(harness.window.__changesView.acceptProposal(changedProposal()).ok, true);
    assert(allText(harness.document.getElementById('changes-preview')).includes('提交 edit.md 不会创建文件'));
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    assert.strictEqual(harness.calls.apply, 1);
    assert.strictEqual(harness.calls.confirm, 0, 'first-stage apply must never create files');
    assert.strictEqual(harness.document.getElementById('changes-apply').textContent, '创建所选文件');
    await harness.document.getElementById('changes-apply').click();
    assert.strictEqual(harness.calls.confirm, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.calls.confirmArgs[3])), ['chapters/a.md']);
    assert(allText(harness.document.getElementById('changes-preview')).includes('已创建 1 个初始文件'));
  });

  await test('skipping files after committed edit preserves truthful terminal copy', async () => {
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }],
        onboardingConfirmation: confirmation('review'),
      },
    });
    const operationId = '9'.repeat(32);
    assert.strictEqual(harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    }).ok, true);
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    await harness.document.getElementById('changes-discard').click();
    const previewText = allText(harness.document.getElementById('changes-preview'));
    const statusText = harness.document.getElementById('changes-status').textContent;
    assert(previewText.includes('edit.md 已保留本轮接受的更新'));
    assert(!previewText.includes('edit.md 的结果保持不变'));
    assert(statusText.includes('edit.md 更新已保留'));
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
  });

  await test('authoritative apply recovery reaches the shared terminal state without repeating refresh IPCs', async () => {
    const harness = loadChangesHarness({
      applyResult: { ok: true, applied: [{ path: 'chapters/a.md', revision: 'b'.repeat(64) }] },
      refreshNever: true,
    });
    assert.strictEqual(harness.window.__changesView.acceptProposal(ordinaryProposal()).ok, true);
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    const applying = harness.document.getElementById('changes-apply').click();
    const settled = await Promise.race([
      applying.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 40)),
    ]);
    assert.strictEqual(settled, 'settled');
    assert.strictEqual(harness.calls.refresh, 0);
    assert.strictEqual(harness.calls.reload, 0);
    assert.strictEqual(harness.calls.reconcile, 1);
    assert(harness.document.getElementById('changes-status').textContent.includes('已安全应用 1 个文件'));
  });

  await test('authoritative Research residual recovery reaches its terminal state without duplicate refresh IPCs', async () => {
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        proposalKind: 'research_card',
        applied: [{ path: 'chapters/a.md', revision: 'b'.repeat(64) }],
        residualUnavailable: true,
      },
      refreshNever: true,
    });
    const proposal = { ...ordinaryProposal(), proposalKind: 'research_card' };
    assert.strictEqual(harness.window.__changesView.acceptProposal(proposal).ok, true);
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    const historyBeforeApply = harness.calls.history;
    const applying = harness.document.getElementById('changes-apply').click();
    const settled = await Promise.race([
      applying.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 40)),
    ]);
    assert.strictEqual(settled, 'settled');
    assert.strictEqual(harness.calls.refresh, 0);
    assert.strictEqual(harness.calls.reload, 0);
    assert.strictEqual(harness.calls.history, historyBeforeApply);
    assert(harness.document.getElementById('changes-status').textContent.includes('Research 提交已生效'));
  });

  await test('authoritative Onboarding recovery opens edit.md without repeating refresh, reload or history', async () => {
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }],
        onboardingConfirmation: confirmation('review'),
      },
      currentPath: 'chapters/a.md',
      refreshNever: true,
    });
    assert.strictEqual(harness.window.__changesView.acceptProposal(changedProposal()).ok, true);
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    const historyBeforeApply = harness.calls.history;
    const applying = harness.document.getElementById('changes-apply').click();
    const settled = await Promise.race([
      applying.then(() => 'settled'),
      new Promise(resolve => setTimeout(() => resolve('timed-out'), 40)),
    ]);
    assert.strictEqual(settled, 'settled');
    assert.strictEqual(harness.calls.open, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.calls.openArgs)), ['edit.md', { pin: true }]);
    assert.strictEqual(harness.calls.refresh, 0);
    assert.strictEqual(harness.calls.reload, 0);
    assert.strictEqual(harness.calls.history, historyBeforeApply);
    assert.strictEqual(harness.document.getElementById('changes-apply').textContent, '创建所选文件');
  });

  await test('project switch settles the exact Onboarding operation before releasing its confirmation', async () => {
    const harness = loadChangesHarness({
      applyResult: { ok: true, applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }], onboardingConfirmation: confirmation('review') },
    });
    const operationId = 'a'.repeat(32);
    assert.strictEqual(harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    }).ok, true);
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    assert.equal(harness.calls.metrics.length, 0, 'edit decision stays deferred while confirmation is live');
    assert.strictEqual(await harness.window.__changesView.discardPending(), true);
    assert.equal(harness.calls.discardConfirmation, 1);
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
  });

  await test('file lifecycle invalidation settles the bound Onboarding metric without borrowing a later operation', async () => {
    const harness = loadChangesHarness({
      applyResult: { ok: true, applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }], onboardingConfirmation: confirmation('review') },
    });
    const operationId = 'b'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    harness.document.dispatchEvent({ type: 'writcraft:file-lifecycle-changed', detail: { kind: 'trash' } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(await harness.window.__changesView.discardPending(), true);
    assert.equal(harness.calls.discardConfirmation, 1);
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('pending Onboarding review survives file lifecycle invalidation until capability and exact metric settle', async () => {
    let resolveDiscard;
    const discardGate = new Promise(resolve => { resolveDiscard = resolve; });
    const harness = loadChangesHarness({ discardChangesResult: () => discardGate });
    const operationId = 'c'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    harness.document.dispatchEvent({ type: 'writcraft:file-lifecycle-changed', detail: { kind: 'rename' } });
    await Promise.resolve();
    assert.strictEqual(harness.calls.discardChanges, 1, 'lifecycle invalidation must release the live review capability');
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, false,
      'renderer ownership must remain blocked until capability release is acknowledged');
    assert.strictEqual(harness.calls.metrics.length, 0, 'terminal metric cannot precede capability release');
    const switchSettlement = harness.window.__changesView.discardPending();
    resolveDiscard({ ok: true });
    assert.strictEqual(await switchSettlement, true);
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'discarded'],
    ]);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('manual pending Onboarding discard awaits the built-in terminal metric retry', async () => {
    const harness = loadChangesHarness({ metricResult: (_instanceId, _event, callCount) => callCount >= 2 });
    const operationId = 'd'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    await harness.document.getElementById('changes-discard').click();
    assert.strictEqual(harness.calls.discardChanges, 1);
    assert.strictEqual(harness.calls.metrics.length, 2, 'manual discard must await one bounded retry');
    assert(harness.calls.metrics.every(item => item.event.operationId === operationId && item.event.outcome === 'discarded'));
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('released review capability is never discarded twice while terminal metric is retried for project switch', async () => {
    const harness = loadChangesHarness({ metricResult: (_instanceId, _event, callCount) => callCount >= 3 });
    const operationId = 'e'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    assert.strictEqual(await harness.window.__changesView.discardPending(), false,
      'project switch must remain blocked while both bounded metric attempts fail');
    assert.strictEqual(harness.calls.discardChanges, 1);
    assert.strictEqual(await harness.window.__changesView.discardPending(), true,
      'a later metric-only retry must unblock project switching');
    assert.strictEqual(harness.calls.discardChanges, 1, 'non-idempotent capability release must not be repeated');
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'discarded'], [operationId, 'discarded'], [operationId, 'discarded'],
    ]);
  });

  await test('concurrent double manual discard and project switch share one deferred review release', async () => {
    let resolveDiscard;
    const discardGate = new Promise(resolve => { resolveDiscard = resolve; });
    const harness = loadChangesHarness({ discardChangesResult: () => discardGate });
    const operationId = '2'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    const discardButton = harness.document.getElementById('changes-discard');
    const firstDiscard = discardButton.click();
    const secondDiscard = discardButton.click();
    const projectSwitch = harness.window.__changesView.discardPending();
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(harness.calls.discardChanges, 1,
      'all concurrent owners must share the exact non-idempotent capability release');
    resolveDiscard({ ok: true });
    const results = await Promise.all([firstDiscard, secondDiscard, projectSwitch]);
    assert.strictEqual(results[2], true);
    assert.strictEqual(harness.calls.discardChanges, 1);
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'discarded'],
    ]);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('committed edit refresh failure records accepted for the exact Onboarding operation', async () => {
    const harness = loadChangesHarness({
      applyResult: { ok: true, applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }], onboardingConfirmation: confirmation('review') },
      reconcileResult: { ok: true, status: 'applied', mutationTrusted: true, authoritativeReloaded: false },
      refreshError: new Error('tree unavailable after commit'),
    });
    const operationId = '1'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
    assert.strictEqual(harness.calls.discardConfirmation, 1,
      'post-commit refresh failure must release the exact new confirmation capability');
    assert.strictEqual(harness.calls.discardArgs[0], 'instance_aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.strictEqual(harness.calls.discardArgs[1], confirmation('review').token);
    assert(allText(harness.document.getElementById('changes-status')).includes('修改已经提交'));
    assert(!harness.calls.metrics.some(item => item.event.outcome === 'failed'));
  });

  await test('invalid post-commit confirmation transition releases exact token and still records accepted', async () => {
    const invalidConfirmation = { ...confirmation('review'), proposalDigest: '' };
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }],
        onboardingConfirmation: invalidConfirmation,
      },
    });
    const operationId = '3'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    assert.strictEqual(harness.calls.discardConfirmation, 1);
    assert.deepStrictEqual(harness.calls.discardArgs, [
      'instance_aaaaaaaaaaaaaaaaaaaaaaaa', invalidConfirmation.token,
    ]);
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('failed post-commit confirmation cleanup blocks switch until exact token retry succeeds', async () => {
    let releaseAttempts = 0;
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }],
        onboardingConfirmation: confirmation('review'),
      },
      reconcileResult: { ok: true, status: 'applied', mutationTrusted: true, authoritativeReloaded: false },
      refreshError: new Error('tree unavailable after commit'),
      discardConfirmationResult: () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error('temporary IPC failure');
        return { ok: true };
      },
    });
    const operationId = '4'.repeat(32);
    harness.window.__changesView.acceptProposal(changedProposal(), {
      onboardingAttempt: { operationId, startedAt: Date.now() - 10 },
    });
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    assert.deepStrictEqual(harness.calls.metrics.map(item => [item.event.operationId, item.event.outcome]), [
      [operationId, 'accepted'],
    ]);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, false,
      'unreleased post-commit token must remain an explicit project-switch barrier');
    assert.strictEqual(await harness.window.__changesView.discardPending(), true);
    assert.strictEqual(harness.calls.discardConfirmation, 2);
    assert.strictEqual(harness.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('no-op confirmation can be discarded and project switch releases its token', async () => {
    const first = loadChangesHarness();
    const noSuggestions = { ...confirmation(), fileSuggestions: [] };
    assert.strictEqual(first.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: noSuggestions,
    }).mode, 'onboarding_confirmation');
    assert(allText(first.document.getElementById('changes-preview')).includes('AI 没有提出需要新建的文件'));
    assert.strictEqual(first.document.getElementById('changes-apply').hidden, true);
    assert.strictEqual(first.document.getElementById('changes-discard').textContent, '完成项目卡');
    assert.strictEqual(first.document.getElementById('changes-panel').dataset.onboardingEmpty, 'true');
    await first.document.getElementById('changes-discard').click();
    assert.strictEqual(first.calls.discardConfirmation, 1);

    const second = loadChangesHarness();
    second.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: confirmation(),
    });
    second.document.dispatchEvent(new (class { constructor() { this.type = 'writcraft:project-entered'; } })());
    await Promise.resolve();
    assert.strictEqual(second.calls.discardConfirmation, 1);
    assert.strictEqual(second.window.__changesView.canStartOnboarding().ok, true);
  });

  await test('terminal confirmation failure clears local authority and states zero partial creation', async () => {
    const harness = loadChangesHarness({ confirmResult: { ok: false, message: '授权已终结' } });
    harness.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: confirmation(),
    });
    await harness.document.getElementById('changes-apply').click();
    assert.strictEqual(harness.calls.confirm, 1);
    assert(allText(harness.document.getElementById('changes-preview')).includes('零部分创建'));
    await harness.document.getElementById('changes-apply').click();
    assert.strictEqual(harness.calls.confirm, 1, 'terminal token must not be retried locally');
  });

  await test('refresh failure after Main success reports authoritative created files', async () => {
    const harness = loadChangesHarness({
      confirmResult: { ok: true, files: [{ path: 'chapters/a.md', bytes: 5, revision: 'c'.repeat(64) }] },
      refreshError: new Error('tree unavailable'),
    });
    harness.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: confirmation(),
    });
    await harness.document.getElementById('changes-apply').click();
    const text = allText(harness.document.getElementById('changes-preview'));
    assert(text.includes('Main 已确认创建：chapters/a.md'));
    assert(!text.includes('零部分创建'));
  });

  await test('Main post-commit refresh warning reports created files and requires project reopen', async () => {
    const harness = loadChangesHarness({
      confirmResult: {
        ok: true,
        files: [{ path: 'chapters/a.md', bytes: 5, revision: 'c'.repeat(64) }],
        warning: 'ONBOARDING_POST_COMMIT_REFRESH_REQUIRED',
        refreshRequired: true,
      },
    });
    harness.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: confirmation(),
    });
    await harness.document.getElementById('changes-apply').click();
    const previewText = allText(harness.document.getElementById('changes-preview'));
    const statusText = harness.document.getElementById('changes-status').textContent;
    assert(previewText.includes('Main 已确认创建：chapters/a.md'));
    assert(previewText.includes('Main 状态刷新异常'));
    assert(previewText.includes('重新打开当前项目'));
    assert(statusText.includes('Main 状态刷新异常'));
    assert(!statusText.includes('已确认并创建'));
    assert.strictEqual(harness.calls.refresh, 0, 'Main refresh warning must not enter the ordinary local refresh path');
  });

  await test('post-apply confirmation mint failure keeps the committed edit and creates no files', async () => {
    const harness = loadChangesHarness({
      applyResult: {
        ok: true,
        applied: [{ path: 'edit.md', revision: 'b'.repeat(64) }],
        confirmationUnavailable: { error: 'ONBOARDING_CONFIRMATION_UNAVAILABLE', reason: 'CAPABILITY_TRANSITION_FAILED' },
      },
    });
    harness.window.__changesView.acceptProposal(changedProposal());
    await acceptFirstReviewItem(harness.document.getElementById('changes-preview'));
    await harness.document.getElementById('changes-apply').click();
    const text = allText(harness.document.getElementById('changes-preview'));
    assert(text.includes('edit.md 已安全写入磁盘'));
    assert(text.includes('没有创建任何初始文件'));
    assert.strictEqual(harness.calls.confirm, 0);
  });

  await test('Main success with a mismatched file list never invents a created count', async () => {
    const harness = loadChangesHarness({
      confirmResult: { ok: true, files: [{ path: 'chapters/other.md', bytes: 5, revision: 'c'.repeat(64) }] },
    });
    harness.window.__changesView.acceptProposal({
      ok: true, noChanges: true, proposalKind: 'onboarding_v2', onboardingConfirmation: confirmation(),
    });
    await harness.document.getElementById('changes-apply').click();
    const text = allText(harness.document.getElementById('changes-preview'));
    assert(text.includes('文件清单无法安全核对'));
    assert(!text.includes('已创建 1 个'));
  });

  await test('workspace late-result release dynamically discards both review capability and confirmation token', async () => {
    const workspaceSource = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
    const functionSource = extractFunction(workspaceSource, 'releaseProposalResult');
    const calls = [];
    const bridge = {
      discardChanges: async (...args) => calls.push(['review', ...args]),
      discardOnboardingConfirmation: async (...args) => calls.push(['confirmation', ...args]),
    };
    const factory = vm.runInNewContext(`(bridge) => { ${functionSource}; return releaseProposalResult; }`);
    await factory(bridge)('instance_aaaaaaaaaaaaaaaaaaaaaaaa', {
      changeSetId: 'pc_11111111111111111111111111111111',
      onboardingConfirmation: { token: 'oct_' + '2'.repeat(32) },
    });
    assert.deepStrictEqual(calls, [
      ['review', 'instance_aaaaaaaaaaaaaaaaaaaaaaaa', 'pc_11111111111111111111111111111111'],
      ['confirmation', 'instance_aaaaaaaaaaaaaaaaaaaaaaaa', 'oct_' + '2'.repeat(32)],
    ]);
  });

  await test('workspace late-result release settles confirmation even when review release throws', async () => {
    const workspaceSource = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace.js'), 'utf8');
    const functionSource = extractFunction(workspaceSource, 'releaseProposalResult');
    const calls = [];
    const bridge = {
      discardChanges: async (...args) => { calls.push(['review', ...args]); throw new Error('review release failed'); },
      discardOnboardingConfirmation: async (...args) => calls.push(['confirmation', ...args]),
    };
    const factory = vm.runInNewContext(`(bridge) => { ${functionSource}; return releaseProposalResult; }`);
    await factory(bridge)('instance_aaaaaaaaaaaaaaaaaaaaaaaa', {
      changeSetId: 'pc_11111111111111111111111111111111',
      onboardingConfirmation: { token: 'oct_' + '2'.repeat(32) },
    });
    assert.deepStrictEqual(calls, [
      ['review', 'instance_aaaaaaaaaaaaaaaaaaaaaaaa', 'pc_11111111111111111111111111111111'],
      ['confirmation', 'instance_aaaaaaaaaaaaaaaaaaaaaaaa', 'oct_' + '2'.repeat(32)],
    ]);
  });

  await test('destroyed project card ignores deferred generation settlement and queued animation frames', async () => {
    const document = new FakeDocument();
    const underlay = document.createElement('button');
    const host = document.createElement('section');
    document.root.append(underlay, host);
    underlay.focus();
    const frames = [];
    const originalAnimationFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    let resolveGeneration;
    let completeCalls = 0;
    let replaceCalls = 0;
    const originalReplaceChildren = host.replaceChildren.bind(host);
    host.replaceChildren = (...nodes) => { replaceCalls += 1; return originalReplaceChildren(...nodes); };
    const deferred = new Promise(resolve => { resolveGeneration = resolve; });
    const controller = onboardingView.mount(host, {
      stateApi: onboardingState,
      session: { status: 'review', currentIndex: 9, answers: { premise: '核心命题' }, skipped: [] },
      onGenerate: () => deferred,
      onComplete: () => { completeCalls += 1; },
    });
    const generationClick = findByText(host, '生成 edit.md 提案').click();
    await Promise.resolve();
    controller.destroy();
    const replacementsAfterDestroy = replaceCalls;
    resolveGeneration({ ok: true });
    await generationClick;
    frames.splice(0).forEach(callback => callback());
    await Promise.resolve();
    assert.strictEqual(completeCalls, 0, 'destroyed generation must not call onComplete');
    assert.strictEqual(replaceCalls, replacementsAfterDestroy, 'destroyed generation must not render after settlement');
    assert.strictEqual(document.activeElement, underlay, 'queued frames must not refocus the destroyed host');
    global.requestAnimationFrame = originalAnimationFrame;
  });

  await test('safe undo long wait remains explicitly non-AI after ten seconds', async () => {
    let now = 1_000;
    let tick = null;
    class FakeDate extends Date {
      static now() { return now; }
    }
    const undo = deferred();
    const entry = {
      id: 'history_a',
      kind: 'changes',
      status: 'applied',
      appliedAt: '2026-07-30T08:00:00.000Z',
      files: [{ path: 'chapter-a.md' }],
    };
    const harness = loadChangesHarness({
      Date: FakeDate,
      setInterval: callback => { tick = callback; return 1; },
      clearInterval: () => { tick = null; },
      undoResult: () => undo.promise,
      reconcileResult: {
        ok: true,
        status: 'undone',
        mutationTrusted: true,
        authoritativeReloaded: true,
        recovery: { affectedPaths: ['chapter-a.md'] },
      },
    });
    harness.window.__changesView.renderHistory([entry]);
    const click = harness.document.querySelector('.history-undo').click();
    await flushUntil(() => harness.calls.undo === 1);
    assert.strictEqual(harness.calls.undo, 1);
    now = 12_000;
    tick();
    const progress = allText(harness.document.getElementById('changes-preview'));
    assert(progress.includes('安全撤销仍在核对，已等待 11 秒'));
    assert(!progress.includes('AI 正在处理'));
    undo.resolve({ ok: true, applied: [{ path: 'chapter-a.md' }] });
    await click;
  });

  await test('late undo finally cannot clear a new project undo progress or controls', async () => {
    const firstUndo = deferred();
    const secondUndo = deferred();
    const queue = [firstUndo, secondUndo];
    const makeEntry = id => ({
      id,
      kind: 'changes',
      status: 'applied',
      appliedAt: '2026-07-30T08:00:00.000Z',
      files: [{ path: `${id}.md` }],
    });
    const harness = loadChangesHarness({
      undoResult: () => queue.shift().promise,
      recoveryUiDuringMutation: true,
      reconcileResult: {
        ok: true,
        status: 'undone',
        mutationTrusted: true,
        authoritativeReloaded: true,
        recovery: { affectedPaths: ['history_b.md'] },
      },
    });
    harness.window.__changesView.renderHistory([makeEntry('history_a')]);
    const firstClick = harness.document.querySelector('.history-undo').click();
    await flushUntil(() => harness.calls.undo === 1);
    assert.strictEqual(harness.calls.undo, 1);

    harness.workspace.state.project.instanceId = 'instance_bbbbbbbbbbbbbbbbbbbbbbbb';
    harness.document.dispatchEvent({ type: 'writcraft:project-entered', detail: {} });
    harness.window.__changesView.renderHistory([makeEntry('history_b')]);
    const secondButton = harness.document.querySelector('.history-undo');
    const secondClick = secondButton.click();
    await flushUntil(() => harness.calls.undo === 2);
    assert.strictEqual(harness.calls.undo, 2);

    firstUndo.resolve({ ok: true, applied: [{ path: 'history_a.md' }] });
    await firstClick;
    const previewWhileSecondRuns = allText(harness.document.getElementById('changes-preview'));
    assert(previewWhileSecondRuns.includes('正在安全撤销'));
    assert(!previewWhileSecondRuns.includes('安全撤销已结束'));
    assert.strictEqual(secondButton.disabled, true);
    assert.strictEqual(
      harness.document.getElementById('changes-status').textContent,
      '正在检查版本并安全撤销…'
    );

    secondUndo.resolve({ ok: true, applied: [{ path: 'history_b.md' }] });
    await secondClick;
    assert(allText(harness.document.getElementById('changes-preview')).includes('安全撤销已结束'));
    assert.strictEqual(secondButton.disabled, false);
  });

  await test('npm verify includes the dynamic Renderer gate exactly once and preverify excludes it', async () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).scripts;
    const command = 'node tests/verify-v0-onboarding-renderer-dynamic.js';
    const count = value => String(value || '').split(command).length - 1;
    assert.strictEqual(count(scripts.verify), 1);
    assert.strictEqual(count(scripts.preverify), 0);
  });

  console.log(`\n${passed}/${passed} onboarding v2 Renderer dynamic checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
