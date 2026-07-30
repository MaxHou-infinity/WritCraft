'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const filters = require('../src/renderer/graph-filter-state');
const layout = require('../src/renderer/graph-layout');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/graph-view.js'), 'utf8');
let svgSceneDetachCount = 0;

function makeElement(tagName = 'div', id = '') {
  const classes = new Set();
  const listeners = new Map();
  const attributes = new Map();
  return {
    tagName, id, value: '', textContent: '', className: '', hidden: false, disabled: false,
    children: [], dataset: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    get options() { return this.children; },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'class') {
        classes.clear();
        String(value).split(/\s+/).filter(Boolean).forEach(className => classes.add(className));
      }
    },
    getAttribute(name) {
      if (name === 'class') return [...classes].join(' ') || null;
      return attributes.get(name) || null;
    },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    dispatch(type, event = {}) { for (const handler of listeners.get(type) || []) handler(event); },
    click() { this.dispatch('click', { stopPropagation() {}, preventDefault() {} }); },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...children) { children.forEach(child => this.appendChild(child)); },
    replaceChildren(...children) {
      for (const child of this.children) {
        if (this.tagName === 'svg' && child.parentNode === this) svgSceneDetachCount += 1;
        if (child.parentNode === this) child.parentNode = null;
      }
      this.children = [];
      children.forEach(child => this.appendChild(child));
    },
    setPointerCapture() {},
    querySelector(selector) {
      const className = selector.startsWith('.') ? selector.slice(1) : '';
      const queue = [...this.children];
      while (queue.length) {
        const item = queue.shift();
        if (className && String(item.className || '').split(/\s+/).includes(className)) return item;
        queue.push(...(item.children || []));
      }
      return null;
    },
  };
}

function findByClass(root, className) {
  if (String(root?.className || root?.getAttribute?.('class') || '').split(/\s+/).includes(className)) return root;
  for (const child of root?.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return null;
}

function findByAttribute(root, name, value) {
  if (root?.getAttribute?.(name) === value) return root;
  for (const child of root?.children || []) {
    const found = findByAttribute(child, name, value);
    if (found) return found;
  }
  return null;
}

function findByTag(root, tagName) {
  if (root?.tagName === tagName) return root;
  for (const child of root?.children || []) {
    const found = findByTag(child, tagName);
    if (found) return found;
  }
  return null;
}

function findAllByTag(root, tagName, found = []) {
  if (root?.tagName === tagName) found.push(root);
  for (const child of root?.children || []) findAllByTag(child, tagName, found);
  return found;
}

function allText(root) {
  return [root?.textContent || '', ...(root?.children || []).map(allText)].join(' ');
}

console.log('\nGraph renderer dynamic stale verification');

(async () => {
  const passedChecks = [];
  const pass = message => {
    passedChecks.push(message);
    console.log(`  ✓ ${message}`);
  };
  const documentListeners = new Map();
  const ids = [
    'work-area', 'graph-view', 'consistency-graph', 'graph-empty', 'issue-list', 'graph-detail',
    'graph-summary', 'graph-filter', 'graph-scope', 'graph-file-filter', 'graph-time-filter',
    'graph-time-end-filter', 'graph-search', 'issue-filter', 'graph-back', 'graph-refresh', 'save-state',
  ];
  const elements = new Map(ids.map(id => [id, makeElement(id === 'consistency-graph' ? 'svg' : 'div', id)]));
  elements.get('graph-scope').value = 'project';
  elements.get('issue-filter').value = 'active';
  const graphButton = makeElement('button', 'graph-button');
  let svgElementCreates = 0;
  const document = {
    getElementById: id => elements.get(id) || null,
    querySelector: selector => selector === '[data-view="graph"]' ? graphButton : null,
    createElement: tagName => makeElement(tagName),
    createElementNS: (_namespace, tagName) => {
      svgElementCreates += 1;
      return makeElement(tagName);
    },
    addEventListener(type, handler) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
  };
  const emit = (type, detail = {}) => {
    for (const handler of documentListeners.get(type) || []) handler({ detail });
  };
  let buildCalls = 0;
  let layoutCalls = 0;
  let buildMode = 'fixture';
  let flushMode = 'success';
  let resolveDelayedBuildA;
  let resolveDelayedPersistA;
  let settleSameProjectOldBuild;
  let sameProjectRefreshCall = 0;
  let correctionMode = 'fixture';
  const racedBuildProjects = [];
  const racedPersistProjects = [];
  const graphAuthorityEvents = [];
  const sample = {
    nodes: [
      { id: 'alice', key: 'Alice', type: 'person', label: 'Alice', evidenceIds: ['e1'] },
      { id: 'bob', key: 'Bob', type: 'person', label: 'Bob', evidenceIds: ['e2'] },
      { id: 'wait', key: '等待时间', type: 'variable', label: '等待时间', evidenceIds: ['e3'] },
    ],
    edges: [
      { id: 'alice-bob', from: 'alice', to: 'bob' },
      { id: 'alice-wait', from: 'alice', to: 'wait' },
    ],
    evidence: [
      { id: 'e1', path: 'other.md', revision: 'old', start: 0, end: 5, quote: 'Alice', confidence: .99 },
      { id: 'e2', path: 'second.md', revision: 'old', start: 0, end: 3, quote: 'Bob', confidence: .99 },
      { id: 'e3', path: 'third.md', revision: 'old', start: 0, end: 4, quote: '等待时间', confidence: .99 },
    ],
    issues: [
      {
        id: 'issue-1', type: 'attribute_conflict', severity: 'error', status: 'open',
        title: 'Alice 属性冲突', message: '两个值不一致', nodeIds: ['alice'], evidenceIds: ['e1'],
        changesHandoff: { token: 'opaque-1' },
      },
      {
        id: 'issue-2', type: 'attribute_conflict', severity: 'warning', status: 'open',
        title: 'Alice 属性冲突', message: '重复标题仍须可区分', nodeIds: ['alice'], evidenceIds: [],
        changesHandoff: { token: 'opaque-2' },
      },
    ],
    manifest: { inputFiles: [{ path: 'other.md' }, { path: 'second.md' }, { path: 'third.md' }] },
    correctionState: { graphIdentity: `graph_${'1'.repeat(32)}`, corrections: [] },
  };
  const state = { project: { instanceId: 'project-a' }, revision: 'old' };
  let resolveCorrection;
  let correctionCalls = 0;
  const correctionPromise = new Promise(resolve => { resolveCorrection = resolve; });
  const window = {
    WritCraftGraphFilters: filters,
    WritCraftGraphLayout: {
      ...layout,
      layoutGraph(...args) {
        layoutCalls += 1;
        return layout.layoutGraph(...args);
      },
    },
    writCraft: { project: {
      buildGraph: async projectInstanceId => {
        graphAuthorityEvents.push(`build:${projectInstanceId}`);
        if (buildMode === 'cache-too-large') {
          return {
            ok: false,
            error: 'CACHE_TOO_LARGE',
            message: '图谱分析未完成。正文没有变化，请点击“重新分析”再试',
          };
        }
        buildCalls += 1;
        if (buildMode === 'build-race') {
          racedBuildProjects.push(projectInstanceId);
          if (projectInstanceId === 'project-race-a') {
            return new Promise(resolve => { resolveDelayedBuildA = resolve; });
          }
          return {
            ok: true,
            graph: {
              ...sample,
              nodes: [{ id: 'race-b', key: 'Race B', type: 'person', label: 'RACE_B_CURRENT', evidenceIds: ['e1'] }],
              edges: [],
              issues: [],
            },
            index: { status: 'rebuilt' },
          };
        }
        if (buildMode === 'persist-race') {
          racedBuildProjects.push(projectInstanceId);
          return {
            ok: true,
            graph: {
              ...sample,
              nodes: [{ id: 'persist-b', key: 'Persist B', type: 'person', label: 'PERSIST_B_CURRENT', evidenceIds: ['e1'] }],
              edges: [],
              issues: [],
            },
            index: { status: 'rebuilt' },
          };
        }
        if (buildMode === 'invalid-snapshot') {
          return {
            ok: true,
            graph: { ...sample, unsafe: new Date() },
            index: { status: 'rebuilt' },
          };
        }
        if (buildMode === 'same-refresh-race') {
          sameProjectRefreshCall += 1;
          const round = Math.ceil(sameProjectRefreshCall / 2);
          if (sameProjectRefreshCall % 2 === 1) {
            return new Promise((resolve, reject) => {
              settleSameProjectOldBuild = { resolve, reject };
            });
          }
          return {
            ok: true,
            graph: {
              ...sample,
              nodes: [{
                id: `same-current-${round}`,
                key: `Same current ${round}`,
                type: 'person',
                label: `SAME_CURRENT_${round}`,
                evidenceIds: ['e1'],
              }],
              edges: [],
              issues: [],
            },
            index: { status: 'rebuilt' },
          };
        }
        if (buildCalls === 1) {
          return { ok: false, error: 'INVALID_CACHE', message: '缓存证据路径无效' };
        }
        const builtGraph = buildCalls === 2 ? sample : {
          ...sample,
          nodes: sample.nodes.map(node => ({ ...node })),
        };
        return {
          ok: true,
          graph: builtGraph,
          index: {
            status: 'rebuilt',
            cacheReason: buildCalls === 2 ? 'CACHE_INVALID' : null,
          },
        };
      },
      applyGraphCorrection: async () => {
        correctionCalls += 1;
        if (correctionMode === 'invalid-snapshot') {
          return { ok: true, graph: { ...sample, unsafe: new Date() } };
        }
        if (correctionCalls === 1) return { ok: false, message: '纠错 fixture 保存失败' };
        return correctionPromise;
      },
    } },
    __workspace: {
      state,
      getCurrentPath: () => 'other.md',
      flushExternalChanges: async () => {
        graphAuthorityEvents.push(`flush:${state.project?.instanceId || ''}`);
        if (flushMode === 'reject') throw new Error('GRAPH_FLUSH_BLOCKED');
        return { ok: true };
      },
      persistCurrent: async () => {
        const owner = state.project?.instanceId;
        if (buildMode !== 'persist-race') return true;
        racedPersistProjects.push(owner);
        if (owner === 'project-persist-a') {
          return new Promise(resolve => { resolveDelayedPersistA = resolve; });
        }
        return true;
      },
    },
    __changesView: { openGraphIssue: async () => ({ ok: true }) },
  };
  vm.runInNewContext(source, { window, document, console, Map, Set, Array }, { filename: 'graph-view.js' });
  await window.__graphView.refresh();
  assert.strictEqual(buildCalls, 1);
  assert.deepStrictEqual(graphAuthorityEvents.slice(0, 2), [
    'flush:project-a',
    'build:project-a',
  ], 'Graph refresh must cross the Main-owned watcher barrier before building from project files');
  assert.match(elements.get('graph-summary').textContent, /图谱索引未能安全重建.*正文没有变化.*重新分析/);
  assert.doesNotMatch(elements.get('graph-summary').textContent, /INVALID_CACHE|缓存证据路径无效/);
  pass('Graph refresh crosses the watcher barrier and translates cache failures into a retryable terminal');

  await window.__graphView.refresh();
  assert.strictEqual(buildCalls, 2);
  assert.match(elements.get('graph-summary').textContent, /旧图谱索引不可用.*安全重建.*正文未受影响/);
  assert.doesNotMatch(elements.get('graph-summary').textContent, /CACHE_INVALID/);
  pass('Graph explains automatic cache recovery without exposing internal codes');

  buildMode = 'cache-too-large';
  await window.__graphView.refresh();
  assert.match(elements.get('graph-summary').textContent, /正文没有变化.*重新分析/);
  assert.doesNotMatch(elements.get('graph-summary').textContent, /CACHE_TOO_LARGE/);
  pass('Graph gives oversized rebuild failures the same bounded retry terminal');
  buildMode = 'normal';

  const typeMatches = (type, selected) => selected === 'all'
    || selected === 'person' && type === 'person'
    || selected === 'variable' && type === 'variable'
    || selected === 'time' && type === 'time'
    || selected === 'section' && type === 'section'
    || selected === 'entity' && ['person', 'entity', 'organization', 'place', 'location'].includes(type)
    || selected === 'concept' && ['concept', 'variable', 'value'].includes(type);
  const elementIsVisible = element => {
    if (element.getAttribute('data-secondary-hidden') === 'true') return false;
    const selected = elements.get('consistency-graph').children[0]?.getAttribute('data-type-filter') || 'all';
    if (selected === 'issues') {
      return element.getAttribute('data-issue') === 'true'
        || element.getAttribute('data-source-issue') === 'true' && element.getAttribute('data-target-issue') === 'true';
    }
    const nodeType = element.getAttribute('data-node-type');
    if (nodeType !== null) return typeMatches(nodeType, selected);
    return typeMatches(element.getAttribute('data-source-type'), selected)
      && typeMatches(element.getAttribute('data-target-type'), selected);
  };
  const nodeGroups = () => findAllByTag(elements.get('consistency-graph'), 'g')
    .filter(node => String(node.getAttribute('class') || '').split(/\s+/).includes('graph-node') && elementIsVisible(node));
  const visibleLines = () => findAllByTag(elements.get('consistency-graph'), 'line').filter(elementIsVisible);
  const nodeTransform = label => nodeGroups().find(node => node.getAttribute('aria-label')?.includes(label))?.getAttribute('transform');
  const aliceTransform = nodeTransform('Alice');
  const bobTransform = nodeTransform('Bob');
  const waitTransform = nodeTransform('等待时间');
  const baselineNodes = new Map(nodeGroups().map(node => [node.getAttribute('aria-label'), node]));
  const baselineScene = elements.get('consistency-graph').children[0];
  const baselineSvgElementCreates = svgElementCreates;
  const baselineSceneDetachCount = svgSceneDetachCount;
  assert(aliceTransform && bobTransform && waitTransform);
  assert(baselineScene, 'the initial project Graph must establish a reusable baseline scene');
  assert.strictEqual(visibleLines().length, 2);
  assert.strictEqual(layoutCalls, 1);

  elements.get('graph-filter').value = 'person';
  elements.get('graph-filter').dispatch('change');
  const personScene = elements.get('consistency-graph').children[0];
  assert.strictEqual(personScene, baselineScene, 'a type filter must preserve the baseline scene');
  assert.strictEqual(baselineScene.children.length, baselineNodes.size + 2,
    'type projection must not move any node or edge out of the baseline scene');
  assert.strictEqual(nodeGroups().length, 2);
  assert.strictEqual(visibleLines().length, 1,
    'type projection must omit an edge whose variable endpoint is hidden');
  for (const node of nodeGroups()) {
    assert.strictEqual(node, baselineNodes.get(node.getAttribute('aria-label')),
      'type projection must move the original accessible node element instead of rebuilding it');
  }
  assert.strictEqual(layoutCalls, 1, 'type projection must reuse the full-graph layout');

  elements.get('graph-filter').value = 'all';
  elements.get('graph-filter').dispatch('change');
  assert.strictEqual(elements.get('consistency-graph').children[0], baselineScene,
    'clearing the type filter must restore the exact baseline scene');
  assert.strictEqual(nodeGroups().length, 3);
  assert.strictEqual(visibleLines().length, 2);
  assert.strictEqual(svgElementCreates, baselineSvgElementCreates,
    'person -> all must not create or reparent any SVG graph element');
  assert.strictEqual(svgSceneDetachCount, baselineSceneDetachCount,
    'person -> all must keep the complete baseline scene continuously attached');
  pass('type filters preserve baseline DOM ownership, AX listeners, stable layout, and hidden-edge rules');

  elements.get('graph-filter').value = 'issues';
  elements.get('graph-filter').dispatch('change');
  assert.strictEqual(nodeGroups().length, 1);
  assert.strictEqual(visibleLines().length, 0,
    'issue projection must hide edges whose other endpoint is not issue-related');
  assert.strictEqual(baselineScene.children.length, baselineNodes.size + 2,
    'issue projection must leave every baseline element under its original scene');
  elements.get('graph-filter').value = 'all';
  elements.get('graph-filter').dispatch('change');
  assert.strictEqual(elements.get('consistency-graph').children[0], baselineScene);
  assert.strictEqual(nodeGroups().length, 3);
  assert.strictEqual(svgElementCreates, baselineSvgElementCreates,
    'issues -> all must be a scene-state change with zero SVG creation or reparenting');
  assert.strictEqual(svgSceneDetachCount, baselineSceneDetachCount,
    'issues -> all must not detach the baseline scene from the SVG');
  pass('issues -> all restores the full graph without baseline DOM mutation');

  elements.get('graph-file-filter').value = 'other.md';
  elements.get('graph-file-filter').dispatch('change');
  const filteredScene = elements.get('consistency-graph').children[0];
  assert.strictEqual(filteredScene, baselineScene, 'a file projection must preserve the baseline scene');
  assert.strictEqual(nodeGroups().length, 1);
  assert.strictEqual(nodeTransform('Alice'), aliceTransform, 'file filtering must preserve the full-graph position');
  assert.strictEqual(visibleLines().length, 0,
    'an edge with one hidden endpoint must not render from cached full-graph positions');
  const fileProjectionSvgElementCreates = svgElementCreates;
  const projectedAliceForSelection = nodeGroups().find(node => node.getAttribute('aria-label')?.includes('Alice'));
  projectedAliceForSelection.dispatch('keydown', {
    key: 'Enter',
    stopPropagation() {},
    preventDefault() {},
  });
  assert(String(nodeGroups()[0].getAttribute('class')).includes('is-selected'),
    'keyboard selection inside a file projection must update the cached node class');
  assert.strictEqual(projectedAliceForSelection.parentNode, baselineScene,
    'keyboard selection must keep the focused node inside the continuously attached baseline scene');
  assert.strictEqual(svgElementCreates, fileProjectionSvgElementCreates,
    'projected-node selection must not recreate any graph element or scene container');
  const selectedProjectionSvgElementCreates = svgElementCreates;
  elements.get('graph-file-filter').value = '';
  elements.get('graph-file-filter').dispatch('change');
  assert.strictEqual(elements.get('consistency-graph').children[0], baselineScene,
    'clearing a file filter after projected-node selection must restore the same baseline scene');
  assert(String(nodeGroups().find(node => node.getAttribute('aria-label')?.includes('Alice')).getAttribute('class')).includes('is-selected'),
    'the restored baseline must preserve the selected node state');
  assert.strictEqual(layoutCalls, 1);
  assert.strictEqual(svgElementCreates, selectedProjectionSvgElementCreates,
    'clearing the file filter must restore the baseline without creating any SVG element');
  assert.strictEqual(svgElementCreates, baselineSvgElementCreates,
    'type/file projections and selection must not create SVG elements after the baseline');
  assert.strictEqual(svgSceneDetachCount, baselineSceneDetachCount,
    'type/file projections and keyboard selection must preserve continuous scene attachment');

  elements.get('graph-file-filter').value = 'second.md';
  elements.get('graph-file-filter').dispatch('change');
  assert.strictEqual(nodeGroups().length, 1);
  assert.strictEqual(nodeTransform('Bob'), bobTransform, 'switching files must preserve the full-graph position');
  assert.strictEqual(visibleLines().length, 0);
  assert.strictEqual(layoutCalls, 1, 'filter controls must reuse one full-graph layout');

  elements.get('graph-file-filter').value = '';
  elements.get('graph-file-filter').dispatch('change');
  assert.strictEqual(elements.get('consistency-graph').children[0], baselineScene,
    'clearing the file filter must restore the exact baseline DOM scene');
  assert.strictEqual(nodeGroups().length, 3);
  assert.strictEqual(visibleLines().length, 2);
  assert.strictEqual(layoutCalls, 1);
  pass('file filters reuse stable full-graph positions and never render hidden-endpoint edges');

  elements.get('graph-filter').value = 'person';
  elements.get('graph-filter').dispatch('change');
  assert(nodeGroups().every(node => !String(node.getAttribute('class')).includes('is-selected')),
    'changing node type must clear the cached selection class');
  elements.get('graph-file-filter').value = 'other.md';
  elements.get('graph-file-filter').dispatch('change');
  assert.strictEqual(nodeGroups().length, 1, 'type and file filters must compose on one visible constellation');
  assert.strictEqual(nodeTransform('Alice'), aliceTransform);
  assert.strictEqual(visibleLines().length, 0);
  elements.get('graph-file-filter').value = '';
  elements.get('graph-file-filter').dispatch('change');
  assert.strictEqual(nodeGroups().length, 2);
  const projectedAlice = nodeGroups().find(node => node.getAttribute('aria-label')?.includes('Alice'));
  projectedAlice.dispatch('keydown', {
    key: 'Enter',
    stopPropagation() {},
    preventDefault() {},
  });
  assert.match(allText(elements.get('graph-detail')), /Alice/,
    'a baseline node moved through combined projections must retain its keyboard listener');
  pass('type/file composition keeps bounds, identity, keyboard activation, and hidden endpoints correct');

  await window.__graphView.refresh();
  assert.strictEqual(buildCalls, 3);
  assert.strictEqual(layoutCalls, 2, 'a replacement graph snapshot must compute its own full layout');

  const cards = elements.get('issue-list').children;
  assert.strictEqual(cards.length, 2, 'duplicate-titled issues must both render');
  const firstLabels = findAllByTag(cards[0], 'button').map(button => button.getAttribute('aria-label'));
  const secondLabels = findAllByTag(cards[1], 'button').map(button => button.getAttribute('aria-label'));
  for (const action of ['知悉', '忽略', '解决', '重开', '生成可审阅修复']) {
    assert(firstLabels.some(label => label?.includes(action) && label.includes('Alice 属性冲突') && label.includes('issue-1')));
    assert(secondLabels.some(label => label?.includes(action) && label.includes('Alice 属性冲突') && label.includes('issue-2')));
  }
  assert.notDeepStrictEqual(firstLabels, secondLabels, 'stable issue ids must distinguish duplicate titles');
  pass('every issue action names its title and stable id, including duplicate-title cards');

  const detailTrigger = findByClass(elements.get('issue-list').children[0], 'issue-detail-trigger');
  assert(detailTrigger, 'issue must expose an independent detail button');
  detailTrigger.click();

  state.revision = 'new';
  emit('writcraft:current-file-changed', { path: 'other.md' });
  assert.match(allText(elements.get('graph-detail')), /证据已过期/);
  assert.strictEqual(buildCalls, 3, 'current revision change must not trigger an automatic rebuild');

  emit('writcraft:graph-source-changed', { projectInstanceId: 'project-a', paths: ['other.md'] });
  const staleCard = elements.get('issue-list').children[0];
  assert.strictEqual(staleCard.dataset.stale, 'true');
  assert.match(allText(staleCard), /证据已变更.*重新分析/);
  assert.strictEqual(findByClass(staleCard, 'issue-suggest-fix').disabled, true);
  assert.match(elements.get('graph-summary').textContent, /证据已变更/);
  assert.strictEqual(buildCalls, 3, 'cross-file change must stay visibly stale until explicit refresh');

  emit('writcraft:graph-source-changed', { projectInstanceId: 'project-b', paths: ['other.md'] });
  assert.strictEqual(buildCalls, 3, 'other-project events must be ignored');
  pass('current-file and cross-file stale evidence rerender without an automatic rebuild');

  const aliceNode = findByClass(elements.get('consistency-graph'), 'graph-node');
  assert(aliceNode, 'person node must render for the correction journey');
  aliceNode.click();
  const attributeName = findByAttribute(elements.get('graph-detail'), 'aria-label', '要编辑的节点属性名');
  const attributeValue = findByAttribute(elements.get('graph-detail'), 'aria-label', '节点属性值');
  assert(attributeName && attributeValue, 'real correction controls must be present in the dynamic renderer');
  attributeName.value = '作者备注';
  attributeValue.value = '延迟 A 结果';
  const correctionForm = findByTag(elements.get('graph-detail'), 'form');
  correctionForm.dispatch('submit', { preventDefault() {} });
  await Promise.resolve();
  assert.strictEqual(correctionCalls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.get('graph-summary').textContent, /纠错保存失败.*纠错 fixture 保存失败/);
  pass('Main correction failure is announced through the existing live region');

  aliceNode.click();
  const delayedCorrectionForm = findByTag(elements.get('graph-detail'), 'form');
  delayedCorrectionForm.dispatch('submit', { preventDefault() {} });
  await Promise.resolve();
  assert.strictEqual(correctionCalls, 2);
  assert.match(elements.get('graph-summary').textContent, /正在保存/);

  state.project = { instanceId: 'project-b' };
  state.revision = 'b-revision';
  emit('writcraft:project-entered');
  const lateGraph = {
    ...sample,
    nodes: [{ id: 'late-a', key: 'Late A', type: 'person', label: 'LATE_A_MUST_NOT_RENDER', evidenceIds: [] }],
    correctionState: {
      graphIdentity: `graph_${'2'.repeat(32)}`,
      corrections: [{ id: 'late', type: 'edit_attribute', label: 'LATE_A_MUST_NOT_RENDER', active: true }],
    },
  };
  resolveCorrection({ ok: true, graph: lateGraph });
  await Promise.resolve();
  await Promise.resolve();
  assert.match(elements.get('graph-summary').textContent, /已切换项目/);
  assert.doesNotMatch(allText(elements.get('graph-detail')), /LATE_A_MUST_NOT_RENDER/);
  assert.doesNotMatch(allText(elements.get('consistency-graph')), /LATE_A_MUST_NOT_RENDER/);
  assert.strictEqual(elements.get('consistency-graph').children.length, 0);
  pass('delayed project-A correction is discarded after project-B ownership takes over');

  buildMode = 'build-race';
  state.project = { instanceId: 'project-race-a' };
  state.revision = 'race-a';
  window.__graphView.activate();
  await new Promise(resolve => setImmediate(resolve));
  assert(racedBuildProjects.includes('project-race-a'));
  assert.strictEqual(typeof resolveDelayedBuildA, 'function');

  state.project = { instanceId: 'project-race-b' };
  state.revision = 'race-b';
  emit('writcraft:project-entered');
  await new Promise(resolve => setImmediate(resolve));
  assert(racedBuildProjects.includes('project-race-b'));
  assert.match(allText(elements.get('consistency-graph')), /RACE_B_CURRENT/);
  resolveDelayedBuildA({
    ok: true,
    graph: {
      ...sample,
      nodes: [{ id: 'race-a-late', key: 'Race A late', type: 'person', label: 'RACE_A_LATE', evidenceIds: ['e1'] }],
      edges: [],
      issues: [],
    },
    index: { status: 'rebuilt' },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(allText(elements.get('consistency-graph')), /RACE_B_CURRENT/);
  assert.doesNotMatch(allText(elements.get('consistency-graph')), /RACE_A_LATE/);
  pass('project-B auto-refresh wins before a delayed project-A Graph build and cannot be overwritten');

  buildMode = 'persist-race';
  racedBuildProjects.length = 0;
  state.project = { instanceId: 'project-persist-a' };
  state.revision = 'persist-a';
  emit('writcraft:project-entered');
  await new Promise(resolve => setImmediate(resolve));
  assert(racedPersistProjects.includes('project-persist-a'));
  assert.strictEqual(typeof resolveDelayedPersistA, 'function');
  assert(!racedBuildProjects.includes('project-persist-a'));

  state.project = { instanceId: 'project-persist-b' };
  state.revision = 'persist-b';
  emit('writcraft:project-entered');
  await new Promise(resolve => setImmediate(resolve));
  assert(racedBuildProjects.includes('project-persist-b'));
  assert.match(allText(elements.get('consistency-graph')), /PERSIST_B_CURRENT/);
  resolveDelayedPersistA(true);
  await new Promise(resolve => setImmediate(resolve));
  assert(!racedBuildProjects.includes('project-persist-a'),
    'a stale persist completion must be rejected before invoking Main buildGraph');
  assert.match(allText(elements.get('consistency-graph')), /PERSIST_B_CURRENT/);
  pass('project switch during persist rejects project-A before any Graph build authority is invoked');

  buildMode = 'same-refresh-race';
  sameProjectRefreshCall = 0;
  state.project = { instanceId: 'project-same' };
  state.revision = 'same';
  const oldResolveRefresh = window.__graphView.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const newResolveRefresh = window.__graphView.refresh();
  await newResolveRefresh;
  assert.match(allText(elements.get('consistency-graph')), /SAME_CURRENT_1/);
  settleSameProjectOldBuild.resolve({
    ok: true,
    graph: {
      ...sample,
      nodes: [{ id: 'same-late-resolve', key: 'late', type: 'person', label: 'SAME_LATE_RESOLVE', evidenceIds: ['e1'] }],
      edges: [],
      issues: [],
    },
    index: { status: 'rebuilt' },
  });
  await oldResolveRefresh;
  assert.match(allText(elements.get('consistency-graph')), /SAME_CURRENT_1/);
  assert.doesNotMatch(allText(elements.get('consistency-graph')), /SAME_LATE_RESOLVE/);

  const oldRejectRefresh = window.__graphView.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const newRejectRefresh = window.__graphView.refresh();
  await newRejectRefresh;
  assert.match(allText(elements.get('consistency-graph')), /SAME_CURRENT_2/);
  settleSameProjectOldBuild.reject(new Error('SAME_LATE_REJECT'));
  await oldRejectRefresh;
  assert.match(allText(elements.get('consistency-graph')), /SAME_CURRENT_2/);
  assert.doesNotMatch(elements.get('graph-summary').textContent, /SAME_LATE_REJECT/);
  pass('a newer refresh supersedes same-project older resolve and reject completions');

  correctionMode = 'invalid-snapshot';
  const verifiedBeforeCorrection = allText(elements.get('consistency-graph'));
  const correctionNode = findByClass(elements.get('consistency-graph'), 'graph-node');
  correctionNode.click();
  const invalidCorrectionForm = findByTag(elements.get('graph-detail'), 'form');
  invalidCorrectionForm.dispatch('submit', { preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert(verifiedBeforeCorrection.includes('SAME_CURRENT_2'));
  assert.strictEqual(elements.get('consistency-graph').children.length, 0,
    'a correction may have committed before its invalid response; the old graph must fail closed');
  assert.doesNotMatch(allText(elements.get('consistency-graph')), /SAME_CURRENT_2/);
  assert.strictEqual(elements.get('issue-list').children.length, 0);
  assert.strictEqual(elements.get('graph-detail').children.length, 0);
  assert.match(elements.get('graph-summary').textContent, /纠错保存中断.*non-plain object/);
  pass('an invalid correction Graph fails closed because Main may already have committed its ledger');
  correctionMode = 'fixture';

  flushMode = 'reject';
  buildMode = 'fixture';
  const buildCallsBeforeFlushFailure = buildCalls;
  await window.__graphView.refresh();
  assert.strictEqual(buildCalls, buildCallsBeforeFlushFailure,
    'a failed watcher barrier must stop before invoking Main buildGraph');
  assert.match(elements.get('graph-summary').textContent, /分析中断.*GRAPH_FLUSH_BLOCKED/);
  pass('a failed watcher barrier blocks Graph build and remains visibly fail-closed');
  flushMode = 'success';

  buildMode = 'invalid-snapshot';
  await window.__graphView.refresh();
  assert.strictEqual(elements.get('consistency-graph').children.length, 0);
  assert.match(elements.get('graph-summary').textContent, /分析中断.*non-plain object/);
  pass('a non-plain Graph snapshot fails closed and clears the previously rendered graph');
  console.log(`\n${passedChecks.length}/${passedChecks.length} graph-renderer dynamic checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
