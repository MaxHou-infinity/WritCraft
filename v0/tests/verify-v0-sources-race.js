#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/sources-view.js'), 'utf8');

class Element {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this[name] = String(value); }
  async fire(type) { return this.listeners.get(type)?.({ target: this }); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function indexFor(label) {
  return {
    sources: [{
      id: `src_${label.toLowerCase().repeat(20).slice(0, 20)}`,
      title: `${label}-SECRET-TITLE`, filePath: `references/${label}.md`, revision: 'a'.repeat(64),
      locator: { filePath: `references/${label}.md`, offset: 0, end: 1 }, metadata: {},
      indexStatus: 'indexed', isReferenced: false, citationCount: 0,
    }],
    counts: { sources: 1, referenced: 0, errors: 0 },
  };
}

function visibleText(element) {
  return [element.textContent, ...element.children.map(visibleText)].join(' ');
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

function findElement(element, predicate) {
  return descendants(element).find(predicate) || null;
}

function harness(bridge) {
  const ids = [
    'source-index-list', 'source-index-status', 'source-index-refresh', 'source-import', 'source-citation-style',
    'source-research-question', 'source-research-run', 'source-research-count', 'source-research-results',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  elements['source-citation-style'].value = 'apa7';
  const activity = new Element('activity-sources');
  const documentListeners = new Map();
  const document = {
    getElementById: id => elements[id] || null,
    querySelector: selector => selector === '[data-view="sources"]' ? activity : null,
    createElement: () => new Element(),
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  let refreshTreeCalls = 0;
  const window = {
    writCraft: { project: bridge },
    __workspace: {
      state: { project: { instanceId: 'A' } },
      setSidebarView() {},
      async refreshTree() { refreshTreeCalls += 1; },
      async openFile() { return true; },
      revealRange() {},
    },
  };
  vm.runInNewContext(source, { window, document, console, Set, Math }, { filename: 'sources-view.js' });
  return {
    window, elements, activity,
    dispatch(type, detail) { return documentListeners.get(type)?.({ detail }); },
    refreshTreeCalls: () => refreshTreeCalls,
  };
}

async function tick() { await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); }

async function run() {
  console.log('════════ WritCraft V0 · Sources project-race verify ════════');

  const a = deferred();
  const b = deferred();
  let buildCalls = 0;
  const refreshHarness = harness({
    buildSourceIndex(instanceId) {
      buildCalls += 1;
      assert.equal(instanceId, buildCalls === 1 ? 'A' : 'B');
      return buildCalls === 1 ? a.promise : b.promise;
    },
  });
  await refreshHarness.activity.fire('click');
  refreshHarness.window.__workspace.state.project = { instanceId: 'B' };
  refreshHarness.dispatch('writcraft:project-entered');
  a.resolve({ ok: true, index: indexFor('A') });
  await tick();
  assert(!visibleText(refreshHarness.elements['source-index-list']).includes('A-SECRET-TITLE'));
  b.resolve({ ok: true, index: indexFor('B') });
  await tick();
  assert(visibleText(refreshHarness.elements['source-index-list']).includes('B-SECRET-TITLE'));
  console.log('  ✓ A 的延迟索引不会回填 B，B 的新索引可正常呈现');

  const imported = deferred();
  const importHarness = harness({
    importReference(instanceId) { assert.equal(instanceId, 'A'); return imported.promise; },
  });
  const importTask = importHarness.elements['source-import'].fire('click');
  importHarness.window.__workspace.state.project = { instanceId: 'B' };
  importHarness.dispatch('writcraft:project-entered');
  imported.resolve({ ok: true, reference: { title: 'A-PRIVATE-IMPORT' }, index: indexFor('A') });
  await importTask;
  await tick();
  assert(!visibleText(importHarness.elements['source-index-list']).includes('A-SECRET-TITLE'));
  assert.equal(importHarness.refreshTreeCalls(), 0);
  console.log('  ✓ A 的延迟导入结果不会渲染 B，也不会刷新 B 的项目树');

  const judgmentRequests = [];
  const judgmentHarness = harness({
    async buildSourceIndex() { return { ok: true, index: indexFor('J') }; },
    async research() {
      return {
        ok: true,
        cards: [{
          claim: 'AI 主张', boundary: '不可外推',
          source: {
            id: `src_${'j'.repeat(20)}`, title: '来源', filePath: 'references/J.md', revision: 'a'.repeat(64),
            grade: 'B', gradeReason: '用户声明类型', quote: '证据摘录',
            locator: { filePath: 'references/J.md', offset: 0, end: 4 },
          },
          handoff: { schema: 'writcraft.research-handoff/v1', cardId: `rc_${'a'.repeat(32)}` },
        }],
        warnings: [],
      };
    },
    async resolveResearchCard() {
      return {
        ok: true,
        card: { source: { locator: { filePath: 'references/J.md', offset: 0, end: 4 } } },
      };
    },
    async recordResearchJudgment(instanceId, request) {
      judgmentRequests.push({ instanceId, request });
      return { ok: true, recorded: true, handoffAvailable: true, evidenceChanged: false };
    },
  });
  await judgmentHarness.activity.fire('click');
  await tick();
  const sourceCheckbox = findElement(judgmentHarness.elements['source-index-list'], node => node.type === 'checkbox');
  sourceCheckbox.checked = true;
  await sourceCheckbox.fire('change');
  judgmentHarness.elements['source-research-question'].value = '问题';
  await judgmentHarness.elements['source-research-question'].fire('input');
  await judgmentHarness.elements['source-research-run'].fire('click');
  await tick();
  const resultHost = judgmentHarness.elements['source-research-results'];
  const matchButton = findElement(resultHost, node => node.textContent === '主张匹配');
  const mismatchButton = findElement(resultHost, node => node.textContent === '主张不匹配');
  const toChanges = findElement(resultHost, node => node.className === 'research-to-changes');
  assert(matchButton && mismatchButton && toChanges);
  assert.equal(matchButton.disabled, true);
  assert.equal(toChanges.disabled, true);
  await findElement(resultHost, node => node.className === 'research-source').fire('click');
  assert.equal(matchButton.disabled, false);
  await matchButton.fire('click');
  await tick();
  assert.equal(toChanges.disabled, false);
  assert.equal(matchButton['aria-pressed'], 'true');
  assert.equal(mismatchButton['aria-pressed'], 'false');
  await mismatchButton.fire('click');
  await tick();
  assert.equal(matchButton['aria-pressed'], 'false');
  assert.equal(mismatchButton['aria-pressed'], 'true');
  assert.equal(toChanges.disabled, true);
  assert.deepStrictEqual(judgmentRequests.map(item => Object.keys(item.request).sort()), [
    ['cardId', 'schema', 'verdict'], ['cardId', 'schema', 'verdict'],
  ]);
  assert.deepStrictEqual(judgmentRequests.map(item => item.request.verdict), ['matched', 'mismatched']);
  console.log('  ✓ 来源打开后才可记录匹配判断，纠正判断复用 exact card request 并保持 Changes gate');

  let lockedJudgmentCalls = 0;
  let lockedHandoffCalls = 0;
  const lockedHarness = harness({
    async buildSourceIndex() { return { ok: true, index: indexFor('K') }; },
    async research() {
      return {
        ok: true,
        cards: [{
          claim: '证据将变化的主张', boundary: '不可外推',
          source: {
            id: `src_${'k'.repeat(20)}`, title: '来源', filePath: 'references/K.md', revision: 'a'.repeat(64),
            grade: 'B', gradeReason: '用户声明类型', quote: '证据摘录',
            locator: { filePath: 'references/K.md', offset: 0, end: 4 },
          },
          handoff: { schema: 'writcraft.research-handoff/v1', cardId: `rc_${'c'.repeat(32)}` },
        }], warnings: [],
      };
    },
    async resolveResearchCard() {
      return { ok: true, card: { source: { locator: { filePath: 'references/K.md', offset: 0, end: 4 } } } };
    },
    async recordResearchJudgment() {
      lockedJudgmentCalls += 1;
      return {
        ok: true,
        recorded: true,
        handoffAvailable: false,
        evidenceChanged: true,
        message: '判断已记录但证据随后变化，请重新 Research',
      };
    },
  });
  lockedHarness.window.__changesView = {
    async openResearchCard() { lockedHandoffCalls += 1; return { ok: true }; },
  };
  await lockedHarness.activity.fire('click');
  await tick();
  const lockedCheckbox = findElement(lockedHarness.elements['source-index-list'], node => node.type === 'checkbox');
  lockedCheckbox.checked = true;
  await lockedCheckbox.fire('change');
  lockedHarness.elements['source-research-question'].value = '问题';
  await lockedHarness.elements['source-research-question'].fire('input');
  await lockedHarness.elements['source-research-run'].fire('click');
  await tick();
  const lockedHost = lockedHarness.elements['source-research-results'];
  const lockedSource = findElement(lockedHost, node => node.className === 'research-source');
  const lockedMatch = findElement(lockedHost, node => node.textContent === '主张匹配');
  const lockedMismatch = findElement(lockedHost, node => node.textContent === '主张不匹配');
  const lockedChanges = findElement(lockedHost, node => node.className === 'research-to-changes');
  const lockedStatus = findElement(lockedHost, node => node.className === 'research-judgment-status');
  await lockedSource.fire('click');
  await lockedMatch.fire('click');
  await tick();
  assert.equal(lockedSource.disabled, true);
  assert.equal(lockedMatch.disabled, true);
  assert.equal(lockedMismatch.disabled, true);
  assert.equal(lockedChanges.disabled, true);
  assert.equal(lockedMatch['aria-pressed'], 'false');
  assert.equal(lockedMismatch['aria-pressed'], 'false');
  assert.match(lockedStatus.textContent, /判断已记录但证据随后变化，请重新 Research/);
  await lockedMatch.fire('click');
  await lockedChanges.fire('click');
  assert.equal(lockedJudgmentCalls, 1, 'old card cannot be re-judged after committed-but-stale response');
  assert.equal(lockedHandoffCalls, 0, 'recorded-but-stale judgment cannot enter Changes');
  console.log('  ✓ 已记录但证据随后变化时永久锁定旧卡判断与 Changes，并呈现 Main 消息');

  const late = deferred();
  let lateJudgmentCalls = 0;
  const lateHarness = harness({
    async buildSourceIndex() { return { ok: true, index: indexFor('L') }; },
    async research() {
      return {
        ok: true,
        cards: [{
          claim: 'A 私有主张', boundary: 'A 边界',
          source: {
            id: `src_${'l'.repeat(20)}`, title: 'A 来源', filePath: 'references/L.md', revision: 'a'.repeat(64),
            grade: 'B', gradeReason: '用户声明类型', quote: 'A 摘录',
            locator: { filePath: 'references/L.md', offset: 0, end: 4 },
          },
          handoff: { schema: 'writcraft.research-handoff/v1', cardId: `rc_${'b'.repeat(32)}` },
        }], warnings: [],
      };
    },
    async resolveResearchCard() {
      return { ok: true, card: { source: { locator: { filePath: 'references/L.md', offset: 0, end: 4 } } } };
    },
    recordResearchJudgment() { lateJudgmentCalls += 1; return late.promise; },
  });
  await lateHarness.activity.fire('click');
  await tick();
  const lateCheckbox = findElement(lateHarness.elements['source-index-list'], node => node.type === 'checkbox');
  lateCheckbox.checked = true;
  await lateCheckbox.fire('change');
  lateHarness.elements['source-research-question'].value = '问题';
  await lateHarness.elements['source-research-question'].fire('input');
  await lateHarness.elements['source-research-run'].fire('click');
  await tick();
  const lateHost = lateHarness.elements['source-research-results'];
  await findElement(lateHost, node => node.className === 'research-source').fire('click');
  const lateMatch = findElement(lateHost, node => node.textContent === '主张匹配');
  void lateMatch.fire('click');
  void lateMatch.fire('click');
  assert.equal(lateJudgmentCalls, 1);
  lateHarness.window.__workspace.state.project = { instanceId: 'B' };
  lateHarness.dispatch('writcraft:project-entered');
  late.resolve({ ok: true, recorded: true, handoffAvailable: true, evidenceChanged: false });
  await tick();
  assert(!visibleText(lateHarness.elements['source-research-results']).includes('A 私有主张'));
  assert(!visibleText(lateHarness.elements['source-research-results']).includes('已记录'));
  console.log('  ✓ A 的延迟判断结果在项目切换后不会解锁或渲染到 B');

  console.log('\n✅ Sources project-race 5/5 全过');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
