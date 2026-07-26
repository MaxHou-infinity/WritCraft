'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const graphIndexService = require('../src/main/graph-index-service');
const corrections = require('../src/main/graph-correction-service');
const consistencyEngine = require('../src/main/consistency-engine');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

function revision(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function graphFixture(content = '林舟的年龄是32岁。') {
  const rev = revision(content);
  const evidence = {
    id: 'ev_1111111111111111', path: 'chapter.md', filePath: 'chapter.md',
    revision: rev, contentHash: `sha256:${revision(content)}`,
    blockId: 'blk_1111111111111111', capturedAt: '2026-07-21T00:00:00.000Z',
    start: 0, end: content.length, quote: content, confidence: .97,
  };
  return {
    schema: 'writcraft.graph/v2',
    nodes: [
      { id: 'node_1111111111111111', key: '林舟', label: '林舟', type: 'person', aliases: [], summary: '', attributes: { '年龄': '32岁' }, confidence: .97, status: 'proposed', evidenceIds: [evidence.id], updatedAt: evidence.capturedAt },
      { id: 'node_2222222222222222', key: '阿舟', label: '阿舟', type: 'person', aliases: [], summary: '', attributes: {}, confidence: .8, status: 'proposed', evidenceIds: [evidence.id], updatedAt: evidence.capturedAt },
      { id: 'node_3333333333333333', key: '32岁', label: '32岁', type: 'datum', aliases: [], summary: '', attributes: {}, confidence: .97, status: 'proposed', evidenceIds: [evidence.id], updatedAt: evidence.capturedAt },
      { id: 'node_4444444444444444', key: '林先生', label: '林先生', type: 'person', aliases: [], summary: '', attributes: {}, confidence: .8, status: 'proposed', evidenceIds: [evidence.id], updatedAt: evidence.capturedAt },
    ],
    edges: [{ id: 'edge_1111111111111111', type: 'has_attribute', from: 'node_1111111111111111', to: 'node_3333333333333333', directed: true, label: '属性：年龄', relation: 'value:年龄', property: '年龄', source: 'manuscript', confidence: .97, status: 'proposed', evidenceIds: [evidence.id] }],
    evidence: [evidence],
    issues: [{ id: 'issue_age', type: 'attribute_conflict', severity: 'warning', title: '年龄冲突', description: '测试', message: '测试', status: 'open', resolution: null, details: {}, confidence: .9, nodeIds: ['node_1111111111111111'], edgeIds: ['edge_1111111111111111'], evidenceIds: [evidence.id] }],
    manifest: { inputFiles: [{ path: 'chapter.md', revision: rev }], stats: {} },
  };
}

function command(graph, value) {
  return { schema: corrections.COMMAND_SCHEMA, graphIdentity: corrections.graphIdentity(graph), ...value };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-graph-corrections-'));
}

console.log('\nGraph correction service verification');

test('persists all three bounded author corrections without modifying manuscript files', () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'chapter.md'), '林舟的年龄是32岁。');
    const before = fs.readFileSync(path.join(root, 'chapter.md'), 'utf8');
    let graph = graphFixture();
    corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' }));
    corrections.submitCorrection(root, graph, command(graph, { type: 'decide_fact', edgeId: 'edge_1111111111111111', decision: 'confirmed' }));
    corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_2222222222222222', targetNodeId: 'node_1111111111111111' }));
    const loaded = corrections.loadCorrections(root);
    assert.strictEqual(loaded.document.corrections.length, 3);
    const file = path.join(root, '.writcraft', 'graph-corrections.json');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapter.md'), 'utf8'), before);
    graph = corrections.applyCorrections(root, graphFixture());
    const person = graph.nodes.find(node => node.key === '林舟');
    assert.strictEqual(person.attributes['职业'], '记者');
    assert(person.aliases.includes('阿舟'));
    assert(!graph.nodes.some(node => node.key === '阿舟'));
    assert.strictEqual(graph.edges[0].status, 'confirmed');
    assert(graph.correctionState.corrections.every(item => item.active && item.evidenceState === 'current'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a rejected fact remains visible but suppresses its derived issue', () => {
  const root = tempRoot();
  try {
    const graph = graphFixture();
    graph.edges.push({ ...graph.edges[0], id: 'edge_2222222222222222', source: 'project_prompt', status: 'proposed' });
    corrections.submitCorrection(root, graph, command(graph, { type: 'decide_fact', edgeId: 'edge_1111111111111111', decision: 'rejected' }));
    const applied = corrections.applyCorrections(root, graphFixture());
    assert.strictEqual(applied.edges[0].status, 'rejected');
    const record = corrections.loadCorrections(root).document.corrections[0];
    assert.strictEqual(record.edge.source, 'manuscript');
    const reapplied = corrections.applyCorrections(root, graph);
    assert.strictEqual(reapplied.edges.find(edge => edge.id === 'edge_1111111111111111').status, 'rejected');
    assert.strictEqual(reapplied.edges.find(edge => edge.id === 'edge_2222222222222222').status, 'proposed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects stale graph identities and captures authoritative evidence bindings', () => {
  const root = tempRoot();
  try {
    const graph = graphFixture();
    assert.throws(() => corrections.submitCorrection(root, graph, {
      schema: corrections.COMMAND_SCHEMA,
      graphIdentity: `graph_${'0'.repeat(32)}`,
      type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者',
    }), error => error.code === 'STALE_GRAPH');
    corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' }));
    const record = corrections.loadCorrections(root).document.corrections[0];
    assert.deepStrictEqual(Object.keys(record.evidence[0]).sort(), ['blockId', 'contentHash', 'id', 'path', 'revision']);
    assert.strictEqual(record.createdAgainst, corrections.graphIdentity(graph));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('survives incremental graph cache reuse and marks changed evidence stale', () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'chapter.md'), '林舟的年龄是32岁。\n');
    let indexed = graphIndexService.indexProjectGraph(projectService, root);
    const person = indexed.graph.nodes.find(node => node.key === '林舟');
    corrections.submitCorrection(root, indexed.graph, command(indexed.graph, { type: 'edit_attribute', nodeId: person.id, attribute: '职业', value: '记者' }));
    indexed = graphIndexService.indexProjectGraph(projectService, root);
    assert.strictEqual(indexed.status, 'cache_hit');
    assert.strictEqual(indexed.graph.nodes.find(node => node.key === '林舟').attributes['职业'], '记者');
    fs.writeFileSync(path.join(root, 'chapter.md'), '林舟的年龄是33岁。\n');
    indexed = graphIndexService.indexProjectGraph(projectService, root);
    assert.strictEqual(indexed.status, 'incremental');
    const status = indexed.graph.correctionState.corrections.find(item => item.type === 'edit_attribute');
    assert.strictEqual(status.active, true);
    assert.strictEqual(status.evidenceState, 'stale');
    assert.strictEqual(indexed.graph.nodes.find(node => node.key === '林舟').attributes['职业'], '记者');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unsafe symlink storage fails closed and never follows the target', () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    fs.symlinkSync(outside, path.join(root, '.writcraft'));
    const loaded = corrections.loadCorrections(root);
    assert.strictEqual(loaded.persistenceBlocked, true);
    const graph = graphFixture();
    assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' })), error => error.code === 'CORRECTIONS_PERSISTENCE_BLOCKED');
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('invalid and oversized commands fail before any state file is written', () => {
  const root = tempRoot();
  try {
    const graph = graphFixture();
    assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '', value: '值' })), error => error.code === 'INVALID_COMMAND');
    assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '说明', value: 'x'.repeat(501) })), error => error.code === 'INVALID_COMMAND');
    for (const attribute of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute, value: '污染' })), error => error.code === 'INVALID_COMMAND');
    }
    assert.throws(() => corrections.submitCorrection(root, graph, { ...command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '说明', value: '值' }), injected: true }), error => error.code === 'INVALID_COMMAND');
    assert.throws(() => corrections.submitCorrection(root, graph, Object.assign(new Date(), command(graph, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '说明', value: '值' }))), error => error.code === 'INVALID_COMMAND');
    assert.strictEqual({}.polluted, undefined);
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft', 'graph-corrections.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('alias chains collapse deterministically and cyclic merges are rejected atomically', () => {
  const root = tempRoot();
  try {
    const graph = graphFixture();
    corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_2222222222222222' }));
    corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_2222222222222222', targetNodeId: 'node_4444444444444444' }));
    const before = fs.readFileSync(path.join(root, '.writcraft', 'graph-corrections.json'), 'utf8');
    assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_4444444444444444', targetNodeId: 'node_1111111111111111' })), error => error.code === 'INVALID_COMMAND');
    assert.strictEqual(fs.readFileSync(path.join(root, '.writcraft', 'graph-corrections.json'), 'utf8'), before);
    const applied = corrections.applyCorrections(root, graphFixture());
    const people = applied.nodes.filter(node => node.type === 'person');
    assert.strictEqual(people.length, 1);
    assert(people[0].aliases.includes('林舟'));
    assert(people[0].aliases.includes('阿舟'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('alias endpoint remap folds duplicate semantic edges and recomputes cross-file evolution', () => {
  const root = tempRoot();
  try {
    const graph = consistencyEngine.analyzeProject([
      { path: '0.md', revision: revision('甲支持丙。'), content: '甲支持丙。' },
      { path: '1.md', revision: revision('乙支持丙。'), content: '乙支持丙。' },
      { path: 'edit.md', revision: revision('乙支持丙。'), content: '乙支持丙。' },
    ], { capturedAt: '2026-07-21T00:00:00Z' });
    const byLabel = new Map(graph.nodes.map(node => [node.label, node]));
    const edgeA = graph.edges.find(edge => edge.from === byLabel.get('甲').id && edge.source === 'manuscript');
    const edgeB = graph.edges.find(edge => edge.from === byLabel.get('乙').id && edge.source === 'manuscript');
    const firstDecision = corrections.submitCorrection(root, graph, command(graph, {
      type: 'decide_fact', edgeId: edgeA.id, decision: 'confirmed',
    })).correction;
    const secondDecision = corrections.submitCorrection(root, graph, command(graph, {
      type: 'decide_fact', edgeId: edgeB.id, decision: 'rejected',
    })).correction;
    corrections.submitCorrection(root, graph, command(graph, {
      type: 'merge_alias', sourceNodeId: byLabel.get('甲').id, targetNodeId: byLabel.get('乙').id,
    }));
    const applied = corrections.applyCorrections(root, graph);
    const semantic = applied.edges.filter(edge => edge.from === byLabel.get('乙').id && edge.to === byLabel.get('丙').id &&
      edge.relation === 'supports' && edge.source === 'manuscript');
    assert.strictEqual(semantic.length, 1);
    assert.strictEqual(semantic[0].evolution.evidenceCount, 2);
    assert.strictEqual(semantic[0].evolution.pathCount, 2);
    assert.deepStrictEqual(semantic[0].evolution.paths, ['0.md', '1.md']);
    assert.strictEqual(semantic[0].evidenceIds.length, 2);
    assert.deepStrictEqual(new Set(semantic[0].correctionIds), new Set([firstDecision.id, secondDecision.id]));
    const factLedger = applied.correctionState.corrections.filter(item => item.type === 'decide_fact');
    assert.strictEqual(factLedger.filter(item => item.active).length, 1);
    assert.strictEqual(factLedger.filter(item => item.superseded).length, 1);
    const activeDecision = factLedger.find(item => item.active);
    assert.strictEqual(semantic[0].correctionId, activeDecision.id);
    assert.strictEqual(semantic[0].status, activeDecision.label === '事实已确认' ? 'confirmed' : 'rejected');
    const promptFact = applied.edges.filter(edge => edge.from === byLabel.get('乙').id && edge.to === byLabel.get('丙').id &&
      edge.relation === 'supports' && edge.source === 'project_prompt');
    assert.strictEqual(promptFact.length, 1, 'project_prompt 与 manuscript 必须保持独立事实语义');
    assert.strictEqual(promptFact[0].evolution.pathCount, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fact decisions bind the exact source and rejecting one cycle edge recomputes diagnostics', () => {
  const root = tempRoot();
  try {
    const content = '甲早于乙。\n乙早于丙。\n丙早于甲。';
    const rev = revision(content);
    const graph = consistencyEngine.analyzeProject([{ path: 'timeline.md', content, revision: rev }], { capturedAt: '2026-07-21T00:00:00Z' });
    assert(graph.issues.some(issue => issue.type === 'timeline_conflict' && issue.details.kind === 'cycle'));
    const edge = graph.edges.find(item => item.source === 'manuscript');
    corrections.submitCorrection(root, graph, command(graph, { type: 'decide_fact', edgeId: edge.id, decision: 'rejected' }));
    const applied = corrections.applyCorrections(root, graph);
    assert.strictEqual(applied.edges.find(item => item.id === edge.id).status, 'rejected');
    assert(!applied.issues.some(issue => issue.type === 'timeline_conflict' && issue.details.kind === 'cycle'));
    assert(applied.issues.every(issue => issue.nodeIds.every(id => applied.nodes.some(node => node.id === id))));
    assert(applied.issues.every(issue => issue.edgeIds.every(id => applied.edges.some(item => item.id === id && item.status !== 'rejected'))));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('alias merge recomputes conflict references and remove_correction restores the extracted graph', () => {
  const root = tempRoot();
  try {
    const content = '林舟的年龄是32岁。\n林舟的年龄是33岁。';
    const rev = revision(content);
    const graph = consistencyEngine.analyzeProject([{ path: 'chapter.md', content, revision: rev }], { capturedAt: '2026-07-21T00:00:00Z' });
    assert(graph.issues.some(issue => issue.type === 'attribute_conflict'));
    const values = graph.nodes.filter(node => node.type === 'datum');
    const submitted = corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: values[1].id, targetNodeId: values[0].id }));
    let applied = corrections.applyCorrections(root, graph);
    assert(!applied.issues.some(issue => issue.type === 'attribute_conflict'));
    for (const issue of applied.issues) {
      assert(issue.nodeIds.every(id => applied.nodes.some(node => node.id === id)));
      assert(issue.edgeIds.every(id => applied.edges.some(edge => edge.id === id)));
      assert(issue.evidenceIds.every(id => applied.evidence.some(evidence => evidence.id === id)));
    }
    corrections.submitCorrection(root, applied, command(applied, { type: 'remove_correction', correctionId: submitted.correction.id }));
    applied = corrections.applyCorrections(root, graph);
    assert(applied.nodes.some(node => node.id === values[1].id));
    assert(applied.issues.some(issue => issue.type === 'attribute_conflict'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('alias merges reject incompatible node types before persistence', () => {
  const root = tempRoot();
  try {
    const graph = graphFixture();
    assert.throws(() => corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_3333333333333333' })), error => error.code === 'INCOMPATIBLE_ALIAS_TYPES');
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft', 'graph-corrections.json')), false);
    corrections.submitCorrection(root, graph, command(graph, { type: 'merge_alias', sourceNodeId: 'node_2222222222222222', targetNodeId: 'node_1111111111111111' }));
    const changedTypes = graphFixture();
    changedTypes.nodes.find(node => node.id === 'node_2222222222222222').type = 'time';
    const applied = corrections.applyCorrections(root, changedTypes);
    assert(applied.nodes.some(node => node.id === 'node_2222222222222222'));
    assert.strictEqual(applied.correctionState.corrections.find(item => item.type === 'merge_alias').active, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('post-alias fact decisions and source-node attributes remain active after a raw re-index', () => {
  const root = tempRoot();
  try {
    const raw = graphFixture();
    corrections.submitCorrection(root, raw, command(raw, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' }));
    corrections.submitCorrection(root, raw, command(raw, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_2222222222222222' }));
    const visible = corrections.applyCorrections(root, graphFixture());
    const visibleEdge = visible.edges.find(edge => edge.id === 'edge_1111111111111111');
    assert.strictEqual(visible.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'], '记者');
    assert.strictEqual(visibleEdge.from, 'node_2222222222222222');
    corrections.submitCorrection(root, visible, command(visible, { type: 'decide_fact', edgeId: visibleEdge.id, decision: 'rejected' }));
    const reindexed = corrections.applyCorrections(root, graphFixture());
    assert.strictEqual(reindexed.edges.find(edge => edge.id === visibleEdge.id).status, 'rejected');
    assert.strictEqual(reindexed.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'], '记者');
    const byType = new Map(reindexed.correctionState.corrections.map(item => [item.type, item]));
    assert.strictEqual(byType.get('decide_fact').active, true);
    assert.strictEqual(byType.get('edit_attribute').active, true);
    assert.strictEqual(byType.get('merge_alias').active, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pre-alias fact decision remains bound after its source endpoint is merged', () => {
  const root = tempRoot();
  try {
    const raw = graphFixture();
    corrections.submitCorrection(root, raw, command(raw, { type: 'decide_fact', edgeId: 'edge_1111111111111111', decision: 'rejected' }));
    corrections.submitCorrection(root, raw, command(raw, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_2222222222222222' }));
    const reindexed = corrections.applyCorrections(root, graphFixture());
    const edge = reindexed.edges.find(item => item.id === 'edge_1111111111111111');
    assert.strictEqual(edge.from, 'node_2222222222222222');
    assert.strictEqual(edge.status, 'rejected');
    const factStatus = reindexed.correctionState.corrections.find(item => item.type === 'decide_fact');
    assert.strictEqual(factStatus.active, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an author attribute on a merged source overrides the raw target attribute consistently', () => {
  const root = tempRoot();
  try {
    const raw = graphFixture();
    raw.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'] = '医生';
    corrections.submitCorrection(root, raw, command(raw, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' }));
    corrections.submitCorrection(root, raw, command(raw, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_2222222222222222' }));
    const freshRaw = graphFixture();
    freshRaw.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'] = '医生';
    const applied = corrections.applyCorrections(root, freshRaw);
    assert.strictEqual(applied.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'], '记者');
    const attributeStatus = applied.correctionState.corrections.find(item => item.type === 'edit_attribute');
    assert.strictEqual(attributeStatus.active, true);
    assert(attributeStatus.label.includes('记者'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the latest canonical attribute wins after aliasing and older ledger entry is superseded', () => {
  const root = tempRoot();
  try {
    const raw = graphFixture();
    corrections.submitCorrection(root, raw, command(raw, { type: 'edit_attribute', nodeId: 'node_1111111111111111', attribute: '职业', value: '记者' }));
    corrections.submitCorrection(root, raw, command(raw, { type: 'merge_alias', sourceNodeId: 'node_1111111111111111', targetNodeId: 'node_2222222222222222' }));
    const visible = corrections.applyCorrections(root, graphFixture());
    corrections.submitCorrection(root, visible, command(visible, { type: 'edit_attribute', nodeId: 'node_2222222222222222', attribute: '职业', value: '作家' }));
    const applied = corrections.applyCorrections(root, graphFixture());
    assert.strictEqual(applied.nodes.find(node => node.id === 'node_2222222222222222').attributes['职业'], '作家');
    const attributes = applied.correctionState.corrections.filter(item => item.type === 'edit_attribute');
    assert.strictEqual(attributes.length, 2);
    assert.strictEqual(attributes.filter(item => item.active).length, 1);
    assert(attributes.find(item => item.label.includes('作家')).active);
    assert.strictEqual(attributes.find(item => item.label.includes('记者')).superseded, true);
    const persisted = corrections.loadCorrections(root).document.corrections.filter(item => item.type === 'edit_attribute');
    assert(Date.parse(persisted.find(item => item.node.key === '阿舟').updatedAt) > Date.parse(persisted.find(item => item.node.key === '林舟').updatedAt));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed} graph-correction checks passed.`);
