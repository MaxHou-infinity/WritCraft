'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function read(relPath) { return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8'); }
const html = read('src/renderer/index.html');
const graph = read('src/renderer/graph-view.js');
const changes = read('src/renderer/changes-view.js');
const layout = require('../src/renderer/graph-layout');
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

console.log('\nGraph workbench integration verification');

check('graph defaults to current-file scope with an explicit project toggle', () => {
  assert(html.includes('<option value="current">当前文件</option><option value="project">整个项目</option>'));
  assert(graph.includes("scope: graphScope?.value || 'current'"));
});
check('graph exposes search, file, time, type and issue filters', () => {
  for (const id of ['graph-search', 'graph-file-filter', 'graph-time-filter', 'graph-time-end-filter', 'graph-filter', 'issue-filter']) assert(html.includes(`id="${id}"`));
  for (const value of ['person', 'variable']) assert(html.includes(`<option value="${value}">`));
  assert(graph.includes("graphSearch?.addEventListener('input'"));
});
check('filter options come from the authoritative graph manifest and time nodes', () => {
  assert(graph.includes('helper.fileOptions(graph)'));
  assert(graph.includes('helper.timeOptions(graph)'));
  assert(graph.includes('replaceSelectOptions'));
});
check('node detail shows aliases, attributes, confidence and relations without HTML injection', () => {
  for (const marker of ['item.aliases', 'item.attributes', 'item.confidence', 'graph-relations']) assert(graph.includes(marker));
  assert(!graph.includes('detail.innerHTML'));
});
check('relation detail explains bounded cross-file evolution without claiming story time', () => {
  assert(graph.includes('formatEdgeEvolution?.(edge.evolution)'));
  assert(graph.includes('edge.evolution.evidenceCount'));
  assert(html.includes('graph-relation-evolution'));
});
check('evidence visibly reports revision staleness before navigation', () => {
  assert(graph.includes('evidenceIsStale'));
  assert(graph.includes("button.dataset.stale = 'true'"));
  assert(html.includes('.graph-evidence[data-stale="true"]'));
});
check('suggest fix sends only a Main-owned issue binding into locked Changes review', () => {
  assert(graph.includes("suggest.textContent = '生成可审阅修复'"));
  assert(graph.includes('window.__changesView?.openGraphIssue?.(issue.changesHandoff)'));
  assert(!graph.includes('openWithInstruction?.(`根据一致性问题'));
  assert(changes.includes('function openGraphIssue'));
  assert(changes.includes('星图问题专用审阅'));
});
check('graph filter state loads before the graph renderer', () => {
  assert(html.indexOf('graph-filter-state.js') < html.indexOf('graph-view.js'));
});
check('all graph controls have accessible names and visible focus treatment', () => {
  for (const label of ['图谱范围', '按文件筛选', '时间范围起点', '时间范围终点', '搜索图谱']) assert(html.includes(`aria-label="${label}"`));
  assert(html.includes('#graph-search:focus'));
  assert(html.includes('id="graph-summary" role="status" aria-live="polite"'));
  assert(graph.includes("role: 'button'"));
  assert(graph.includes("class: 'graph-node-hit'"));
  assert(graph.includes("event.key !== 'Enter' && event.key !== ' '"));
  assert(!graph.includes("card.setAttribute('role', 'button')"));
  assert(graph.includes("detailButton.className = 'issue-detail-trigger'"));
  assert(graph.includes("action.setAttribute('aria-label', issueActionLabel(label, issue, title.textContent))"));
  assert(graph.includes("suggest.setAttribute('aria-label', issueActionLabel('生成可审阅修复', issue, title.textContent))"));
  assert.match(graph, /function issueActionLabel[\s\S]*?issue\.id/);
});

check('Graph build and correction failures are written to the existing live region', () => {
  assert(html.includes('id="graph-summary" role="status" aria-live="polite"'));
  assert.match(graph, /failureMessage\('分析失败', result, '分析失败'\)/);
  assert.match(graph, /failureMessage\('分析中断', error, '分析中断：未知错误'\)/);
  assert.match(graph, /failureMessage\('纠错保存失败', result, '纠错保存失败'\)/);
  assert.match(graph, /纠错保存中断：[\s\S]*?summary\.textContent = message/);
});

check('deterministic large layout separates every priority node from all nodes and thins labels first', () => {
  const nodes = Array.from({ length: 620 }, (_, index) => ({
    id: `node-${String(index).padStart(4, '0')}`,
    type: index < 20 ? 'time' : 'person',
  }));
  const issueIds = new Set(nodes.slice(20, 40).map(node => node.id));
  const first = layout.layoutGraph(nodes, { issueIds });
  const second = layout.layoutGraph([...nodes].reverse(), { issueIds });
  assert.deepStrictEqual([...first], [...second]);
  const priorityIds = nodes.slice(0, 40).map(node => node.id);
  for (const priorityId of priorityIds) for (const node of nodes) {
    if (node.id === priorityId) continue;
    const priorityPoint = first.get(priorityId);
    const point = first.get(node.id);
    assert(
      Math.hypot(priorityPoint.x - point.x, priorityPoint.y - point.y) >= 16,
      `${priorityId} overlaps ${node.id}`
    );
  }
  assert(new Set([...first.values()].map(point => `${point.x.toFixed(4)}:${point.y.toFixed(4)}`)).size === nodes.length);
  assert(nodes.filter((node, index) => layout.shouldShowLabel(node, index, nodes.length, issueIds.has(node.id) || node.type === 'time')).length < nodes.length);
  assert(nodes.slice(0, 40).every((node, index) => layout.shouldShowLabel(node, index, nodes.length, index < 40)));
});

check('project-entered resets every Graph control and the internal node filter to current-file defaults', () => {
  const listeners = new Map();
  function element(id = '') {
    const classes = new Set();
    return {
      id, value: '', textContent: '', hidden: false, children: [],
      classList: {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      },
      get options() { return this.children; },
      addEventListener() {}, setAttribute() {}, setPointerCapture() {}, querySelector() { return null; },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
    };
  }
  const ids = [
    'work-area', 'graph-view', 'consistency-graph', 'graph-empty', 'issue-list', 'graph-detail',
    'graph-summary', 'graph-filter', 'graph-scope', 'graph-file-filter', 'graph-time-filter',
    'graph-time-end-filter', 'graph-search', 'issue-filter', 'graph-back', 'graph-refresh', 'save-state',
  ];
  const elements = new Map(ids.map(id => [id, element(id)]));
  const graphButton = element('graph-button');
  const document = {
    getElementById: id => elements.get(id) || null,
    querySelector: selector => selector === '[data-view="graph"]' ? graphButton : null,
    createElement: () => element(),
    createElementNS: () => element(),
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  const window = {
    writCraft: { project: {} },
    __workspace: { state: { project: { instanceId: 'project-b' } }, getCurrentPath: () => 'new.md' },
  };
  vm.runInNewContext(graph, { window, document, console, Map, Set }, { filename: 'graph-view.js' });

  elements.get('graph-filter').value = 'time';
  elements.get('graph-scope').value = 'project';
  elements.get('graph-file-filter').value = 'old.md';
  elements.get('graph-time-filter').value = 'node_old_time';
  elements.get('graph-time-end-filter').value = 'node_old_time_end';
  elements.get('graph-search').value = '旧项目';
  elements.get('issue-filter').value = 'dismissed';
  elements.get('graph-file-filter').children = [{ value: 'old.md' }];
  elements.get('graph-time-filter').children = [{ value: 'node_old_time' }];
  elements.get('graph-time-end-filter').children = [{ value: 'node_old_time_end' }];

  assert(listeners.has('writcraft:project-entered'));
  listeners.get('writcraft:project-entered')();
  assert.equal(elements.get('graph-filter').value, 'all');
  assert.equal(elements.get('graph-scope').value, 'current');
  assert.equal(elements.get('graph-file-filter').value, '');
  assert.equal(elements.get('graph-time-filter').value, '');
  assert.equal(elements.get('graph-time-end-filter').value, '');
  assert.equal(elements.get('graph-search').value, '');
  assert.equal(elements.get('issue-filter').value, 'active');
  assert.deepEqual(elements.get('graph-file-filter').options.map(option => option.value), ['']);
  assert.deepEqual(elements.get('graph-time-filter').options.map(option => option.value), ['']);
  assert.deepEqual(elements.get('graph-time-end-filter').options.map(option => option.value), ['']);
  assert.match(graph, /function resetForProject\(\)[\s\S]*?filter = 'all'/);
});

check('Graph listens for bounded project-scoped source changes and rerenders stale detail without rebuilding', () => {
  assert.match(graph, /document\.addEventListener\('writcraft:graph-source-changed'/);
  assert.match(graph, /changedSourcePaths = new Set\(\[/);
  assert.match(graph, /renderGraph\(\);[\s\S]*?renderIssues\(\);[\s\S]*?refreshSelectedDetail\(\)/);
  assert.match(graph, /document\.addEventListener\('writcraft:current-file-changed'/);
  assert.match(graph, /suggest\.disabled = staleEvidence/);
});

check('author correction ignores a late response after project or refresh ownership changes', () => {
  assert.match(graph, /async function applyCorrection[\s\S]*?originSequence = refreshSequence/);
  assert.match(graph, /projectInstanceId === window\.__workspace\?\.state\?\.project\?\.instanceId/);
  assert.match(graph, /await bridge\?\.applyGraphCorrection[\s\S]*?if \(!requestIsCurrent\(\)\) return false/);
  assert.match(graph, /correctionId = \+\+correctionSequence[\s\S]*?if \(correctionId === correctionSequence\) correctionBusy = false/);
  assert.match(graph, /function resetForProject\(\)[\s\S]*?correctionSequence \+= 1[\s\S]*?correctionBusy = false/);
});

console.log(`\n${passed}/${passed} graph-workbench checks passed.`);
