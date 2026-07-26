'use strict';

const assert = require('assert');
const filters = require('../src/renderer/graph-filter-state');

const graph = {
  nodes: [
    { id: 'alice', type: 'person', label: 'Alice', aliases: ['A', '小林'], evidenceIds: ['e1'] },
    { id: 'bob', type: 'person', label: 'Bob', evidenceIds: ['e2'] },
    { id: 'date', type: 'time', label: '2026', evidenceIds: ['e3'] },
    { id: 'idea', type: 'concept', label: '信任', evidenceIds: ['e4'] },
  ],
  edges: [{ id: 'edge1', from: 'date', to: 'alice' }, { id: 'edge2', from: 'alice', to: 'idea' }],
  evidence: [
    { id: 'e1', path: 'one.md', revision: 'r1' },
    { id: 'e2', path: 'two.md', revision: 'r2' },
    { id: 'e3', path: 'one.md', revision: 'r1' },
    { id: 'e4', path: 'two.md', revision: 'r2' },
  ],
  issues: [
    { id: 'i1', title: 'Alice 时间冲突', nodeIds: ['alice', 'date'], evidenceIds: ['e1'], status: 'open' },
    { id: 'i2', title: 'Bob 信息', nodeIds: ['bob'], evidenceIds: ['e2'], status: 'dismissed' },
    { id: 'i3', title: '信任概念冲突', nodeIds: ['idea'], evidenceIds: ['e4'], status: 'open' },
    { id: 'i4', title: '无节点诊断', nodeIds: [], evidenceIds: ['e4'], status: 'open' },
  ],
  manifest: { inputFiles: [{ path: 'two.md' }, { path: 'one.md' }] },
};

let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

console.log('\nGraph filter state verification');

check('current-file scope is the default and filters by evidence path', () => {
  assert.deepStrictEqual(filters.visibleNodes(graph, { currentPath: 'one.md' }).map(node => node.id), ['alice', 'date']);
});
check('project scope shows every node until another filter is chosen', () => {
  assert.strictEqual(filters.visibleNodes(graph, { scope: 'project' }).length, 4);
});
check('explicit file filter overrides the current-file path', () => {
  assert.deepStrictEqual(filters.visibleNodes(graph, { currentPath: 'one.md', filePath: 'two.md' }).map(node => node.id), ['bob', 'idea']);
});
check('file filtering reuses one evidence lookup per graph snapshot and invalidates on replacement', () => {
  let evidenceScans = 0;
  const evidence = [
    { id: 'cached-a', path: 'a.md' },
    { id: 'cached-b', path: 'b.md' },
  ];
  evidence.map = function (...args) {
    evidenceScans += 1;
    return Array.prototype.map.apply(this, args);
  };
  const cachedGraph = {
    nodes: [
      { id: 'cached-node-a', evidenceIds: ['cached-a'] },
      { id: 'cached-node-b', evidenceIds: ['cached-b'] },
    ],
    evidence,
  };
  assert.deepStrictEqual(filters.visibleNodes(cachedGraph, { filePath: 'a.md' }).map(node => node.id), ['cached-node-a']);
  assert.deepStrictEqual(filters.visibleNodes(cachedGraph, { filePath: 'b.md' }).map(node => node.id), ['cached-node-b']);
  assert.strictEqual(evidenceScans, 1, 'the same graph snapshot must index evidence only once');

  const replacement = { ...cachedGraph };
  assert.deepStrictEqual(filters.visibleNodes(replacement, { filePath: 'a.md' }).map(node => node.id), ['cached-node-a']);
  assert.strictEqual(evidenceScans, 2, 'a replacement graph object must receive a fresh lookup');
});
check('renderer graph snapshots are recursively cloned, frozen, bounded, and cache-safe', () => {
  const mutable = {
    nodes: [{ id: 'frozen-node', evidenceIds: ['frozen-evidence'], attributes: { role: '主角' } }],
    evidence: [{ id: 'frozen-evidence', path: 'frozen.md' }],
    edges: [],
    issues: [],
  };
  const frozen = filters.freezeGraphSnapshot(mutable);
  assert.notStrictEqual(frozen, mutable);
  assert(Object.isFrozen(frozen));
  assert(Object.isFrozen(frozen.nodes));
  assert(Object.isFrozen(frozen.nodes[0]));
  assert(Object.isFrozen(frozen.nodes[0].attributes));
  assert.throws(() => { frozen.nodes[0].attributes.role = '篡改'; }, TypeError);
  assert.deepStrictEqual(filters.nodePaths(frozen, frozen.nodes[0]), ['frozen.md']);
  assert.throws(() => { frozen.evidence[0].path = 'drift.md'; }, TypeError);
  assert.deepStrictEqual(filters.nodePaths(frozen, frozen.nodes[0]), ['frozen.md']);

  mutable.evidence[0].path = 'replacement.md';
  const replacement = filters.freezeGraphSnapshot(mutable);
  assert.deepStrictEqual(filters.nodePaths(replacement, replacement.nodes[0]), ['replacement.md']);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => filters.freezeGraphSnapshot(cyclic), /cycle/);
  assert.throws(() => filters.freezeGraphSnapshot({ graph: new Date() }), /non-plain/);
  const prototypeKey = filters.freezeGraphSnapshot(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.strictEqual(Object.getPrototypeOf(prototypeKey), Object.prototype);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(prototypeKey, '__proto__'), true);
  let getterReads = 0;
  const getterArray = [];
  Object.defineProperty(getterArray, '0', {
    enumerable: true,
    configurable: true,
    get() { getterReads += 1; return 'must-not-run'; },
  });
  getterArray.length = 1;
  assert.throws(() => filters.freezeGraphSnapshot(getterArray), /accessor array element/);
  assert.strictEqual(getterReads, 0, 'array accessors must be rejected from descriptors without executing them');
  const hidden = { visible: true };
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  assert.throws(() => filters.freezeGraphSnapshot(hidden), /hidden field/);
  assert.throws(() => filters.freezeGraphSnapshot(new Array(3)), /non-data array property/);
  assert.throws(() => filters.freezeGraphSnapshot(new Array(200001)), /oversized/);
});
check('type and alias search filters compose deterministically', () => {
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', type: 'entity', query: 'a' }).map(node => node.id), ['alice']);
});
check('node alias and issue-only searches keep related nodes and cards in one constellation', () => {
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', query: '小林' }).map(node => node.id), ['alice']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', query: '小林' }).map(issue => issue.id), ['i1']);
  graph.issues[0].type = 'attribute_conflict';
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', query: 'attribute_conflict' }).map(node => node.id), ['alice', 'date']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', query: 'attribute_conflict' }).map(issue => issue.id), ['i1']);
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', type: 'time', query: '小林' }).map(node => node.id), []);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'time', query: '小林' }).map(issue => issue.id), []);
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', type: 'time', query: 'attribute_conflict' }).map(node => node.id), ['date']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'time', query: 'attribute_conflict' }).map(issue => issue.id), ['i1']);
  graph.issues[0].type = undefined;
});
check('entity filter includes v2 place nodes', () => {
  const withPlace = { ...graph, nodes: [...graph.nodes, { id: 'harbor', type: 'place', label: '北岸码头', evidenceIds: [] }] };
  assert(filters.visibleNodes(withPlace, { scope: 'project', type: 'entity' }).some(node => node.id === 'harbor'));
});
check('time focus keeps the selected time and directly connected nodes', () => {
  assert.deepStrictEqual(filters.visibleNodes(graph, { scope: 'project', timeNodeId: 'date' }).map(node => node.id), ['alice', 'date']);
});
check('inclusive time ranges support two bounds and open-ended starts or ends', () => {
  const ranged = {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: 'date2', type: 'time', label: '2027', evidenceIds: ['e3'] },
      { id: 'date3', type: 'time', label: '2028', evidenceIds: ['e3'] },
      { id: 'carol', type: 'person', label: 'Carol', evidenceIds: ['e3'] },
    ],
    edges: [...graph.edges, { id: 'edge3', from: 'date2', to: 'bob' }, { id: 'edge4', from: 'date3', to: 'carol' }],
  };
  assert.deepStrictEqual([...filters.timeRangeNodeIds(ranged, { timeStartNodeId: 'date', timeEndNodeId: 'date2' })], ['date', 'date2']);
  assert.deepStrictEqual(filters.visibleNodes(ranged, { scope: 'project', timeStartNodeId: 'date2' }).map(node => node.id), ['bob', 'date2', 'date3', 'carol']);
  assert.deepStrictEqual(filters.visibleNodes(ranged, { scope: 'project', timeEndNodeId: 'date2' }).map(node => node.id), ['alice', 'bob', 'date', 'date2']);
  assert.deepStrictEqual(filters.visibleNodes(ranged, { scope: 'project', timeStartNodeId: 'date2', timeEndNodeId: 'date' }).map(node => node.id), ['alice', 'bob', 'date', 'date2']);
});
check('issue filtering follows scope, file and query without reviving dismissed status', () => {
  assert.deepStrictEqual(filters.visibleIssues(graph, { currentPath: 'one.md', query: '时间' }).map(issue => issue.id), ['i1']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { filePath: 'two.md' }).map(issue => issue.id), ['i2', 'i3', 'i4']);
});
check('issue list follows the active node type instead of leaking unrelated cards from the same project', () => {
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'entity' }).map(issue => issue.id), ['i1', 'i2']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'concept' }).map(issue => issue.id), ['i3']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'time' }).map(issue => issue.id), ['i1']);
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', type: 'section' }).map(issue => issue.id), []);
});
check('time focus hides issues unrelated to the selected temporal neighborhood', () => {
  assert.deepStrictEqual(filters.visibleIssues(graph, { scope: 'project', timeNodeId: 'date' }).map(issue => issue.id), ['i1']);
});
check('file and time options are stable and human-readable', () => {
  assert.deepStrictEqual(filters.fileOptions(graph), ['one.md', 'two.md']);
  assert.deepStrictEqual(filters.timeOptions(graph), [{ id: 'date', label: '2026' }]);
});
check('time options use chronological keys for years, ISO dates and Chinese dates', () => {
  const temporal = {
    nodes: [
      { id: 'cn', type: 'time', label: '2026年3月18日' },
      { id: 'old', type: 'time', label: '1998' },
      { id: 'iso', type: 'time', label: '2026-02-11' },
      { id: 'slash-october', type: 'time', label: '2026/10/1' },
      { id: 'slash-february', type: 'time', label: '2026/2/1' },
      { id: 'dot', type: 'time', label: '2026.4.2' },
      { id: 'mid', type: 'time', label: '2024' },
    ],
  };
  assert.deepStrictEqual(filters.timeOptions(temporal).map(item => item.id), [
    'old', 'mid', 'slash-february', 'iso', 'cn', 'dot', 'slash-october',
  ]);
  assert(filters.timeSortValue('2026-02-11') < filters.timeSortValue('2026年3月18日'));
  assert(filters.timeSortValue('2026/2/1') < filters.timeSortValue('2026/10/1'));
  assert.strictEqual(filters.timeSortValue('2026.4.2'), 20260402);
  assert.strictEqual(filters.timeSortValue('2026-02-31'), null);
  assert.strictEqual(filters.timeSortValue('2024-02-29'), 20240229);
  assert.strictEqual(filters.timeSortValue('2026-02-29'), null);
});
check('invalid dates use the stable label and id fallback instead of a false chronology', () => {
  const temporal = {
    nodes: [
      { id: 'invalid-b', type: 'time', label: '2026-02-31' },
      { id: 'invalid-a', type: 'time', label: '2026-02-31' },
      { id: 'valid', type: 'time', label: '2026-03-01' },
    ],
  };
  assert.deepStrictEqual(filters.timeOptions(temporal).map(item => item.id), ['valid', 'invalid-a', 'invalid-b']);
});
check('stale evidence is reported only for the active file revision mismatch', () => {
  assert.strictEqual(filters.evidenceIsStale(graph.evidence[0], 'one.md', 'new'), true);
  assert.strictEqual(filters.evidenceIsStale(graph.evidence[0], 'two.md', 'new'), false);
  assert.strictEqual(filters.evidenceIsStale(graph.evidence[0], 'one.md', 'r1'), false);
});

console.log(`\n${passed}/${passed} graph-filter checks passed.`);
