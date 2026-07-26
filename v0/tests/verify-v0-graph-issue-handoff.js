#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const graphIndexService = require('../src/main/graph-index-service');
const issueStateService = require('../src/main/issue-state-service');
const {
  HANDOFF_SCHEMA,
  createIssueBinding,
  decorateGraphIssues,
  validateHandoffRequest,
  validateIssueDependencies,
  prepareGraphIssueHandoff,
  finalizeGraphIssueHandoff,
} = require('../src/main/graph-issue-handoff-service');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-issue-handoff-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.mkdirSync(path.join(root, 'references'));
  fs.mkdirSync(path.join(root, 'sources'));
  fs.writeFileSync(path.join(root, 'edit.md'), '# 项目规则\n林舟的年龄是32岁。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n林舟的年龄是32岁。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'chapters', 'two.md'), '# 第二章\n林舟的年龄是35岁。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'references', 'source.md'), '# 只读来源\n林舟的年龄是40岁。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sources', 'source.md'), '# 第二只读来源\n林舟的年龄是41岁。\n', 'utf8');
  return root;
}

function currentGraph(root) {
  const indexed = graphIndexService.indexProjectGraph(projectService, root);
  const issueState = issueStateService.reconcileIssueStates(root, indexed.graph.issues);
  return { ...indexed.graph, issues: issueState.issues };
}

function setup() {
  const root = makeProject();
  const graph = currentGraph(root);
  const issue = graph.issues.find(item => item.type === 'attribute_conflict');
  assert(issue, '预期存在属性冲突');
  const projectInstanceId = projectService.projectDescriptor(root).instanceId;
  return { root, graph, issue, projectInstanceId };
}

console.log('\nGraph Issue → Changes handoff verification');

test('publishes an identifier-only binding backed by exact Main dependencies', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    assert.deepStrictEqual(Object.keys(binding.request).sort(), ['bindingId', 'graphIdentity', 'issueId', 'schema']);
    assert.strictEqual(binding.request.schema, HANDOFF_SCHEMA);
    assert.match(binding.request.bindingId, /^gih_[a-f0-9]{24}$/);
    assert.strictEqual(binding.dependencies.schema, HANDOFF_SCHEMA);
    assert.strictEqual(binding.dependencies.projectInstanceId, projectInstanceId);
    assert(binding.dependencies.evidence.length >= 2);
    assert(binding.dependencies.targets.every(target => target.path !== 'edit.md'));
    assert(binding.dependencies.targets.every(target => !target.path.startsWith('references/')));
    assert(binding.dependencies.targets.every(target => !target.path.startsWith('sources/')));
    assert(binding.dependencies.evidence.some(item => item.path === 'references/source.md'));
    assert(binding.dependencies.evidence.some(item => item.path === 'sources/source.md'));
    assert(binding.dependencies.targets.some(target => target.path === 'chapters/two.md'));
    assert(Object.isFrozen(binding.dependencies.evidence));
    assert(Object.isFrozen(binding.dependencies.evidence[0]));
    const decorated = decorateGraphIssues({ graph, projectInstanceId });
    assert.deepStrictEqual(decorated.issues.find(item => item.id === issue.id).changesHandoff, binding.request);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects request smuggling and stale issue semantics even when graphIdentity is unchanged', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    expectCode('INVALID_ISSUE_HANDOFF', () => validateHandoffRequest({ ...binding.request, path: 'edit.md' }));
    const changedGraph = {
      ...graph,
      issues: graph.issues.map(item => item.id === issue.id ? { ...item, description: `${item.description}【作者语义已变化】` } : item),
    };
    const changed = createIssueBinding({ graph: changedGraph, projectInstanceId, issueId: issue.id });
    assert.strictEqual(changed.request.graphIdentity, binding.request.graphIdentity);
    assert.notStrictEqual(changed.request.bindingId, binding.request.bindingId);
    expectCode('GRAPH_ISSUE_STALE', () => prepareGraphIssueHandoff({
      graph: changedGraph, projectService, projectInstanceId, rootPath: root, request: binding.request,
    }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('binds project instance identity and rejects every tampered evidence/target proof field', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    const otherProjectInstanceId = `instance_${'f'.repeat(24)}`;
    const other = createIssueBinding({ graph, projectInstanceId: otherProjectInstanceId, issueId: issue.id });
    assert.notStrictEqual(other.request.bindingId, binding.request.bindingId);
    expectCode('GRAPH_ISSUE_STALE', () => validateIssueDependencies({
      graph, projectService, projectInstanceId: otherProjectInstanceId, rootPath: root, dependencies: binding.dependencies,
    }));

    const mutations = [
      ['target revision', value => { value.targets[0].revision = '0'.repeat(64); }],
      ['evidence revision', value => { value.evidence[0].revision = '0'.repeat(64); }],
      ['evidence range', value => { value.evidence[0].start += 1; value.evidence[0].end += 1; }],
      ['evidence blockId', value => { value.evidence[0].blockId = `blk_${'0'.repeat(16)}`; }],
      ['evidence contentHash', value => { value.evidence[0].contentHash = `sha256:${'0'.repeat(64)}`; }],
      ['evidence quote', value => { value.evidence[0].quote = value.evidence[0].quote.replace(/./u, '异'); }],
    ];
    for (const [label, mutate] of mutations) {
      const tampered = JSON.parse(JSON.stringify(binding.dependencies));
      mutate(tampered);
      expectCode('GRAPH_ISSUE_STALE', () => validateIssueDependencies({
        graph, projectService, projectInstanceId, rootPath: root, dependencies: tampered,
      }), label);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('prepares fresh targets while keeping edit.md readonly and public provenance bounded', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    const prepared = prepareGraphIssueHandoff({
      graph, projectService, projectInstanceId, rootPath: root, request: binding.request,
    });
    assert(prepared.messages[0].content.includes('只读项目 Prompt'));
    assert(prepared.messages[0].content.includes('edit.md 始终只读'));
    assert(prepared.messages[0].content.includes('只读来源证据摘录'));
    assert(prepared.messages[0].content.includes('references/source.md'));
    assert(prepared.messages[0].content.includes('sources/source.md'));
    assert(prepared.messages[0].content.includes('"oldText"'));
    assert(prepared.messages[0].content.includes('不得返回完整 after 文件'));
    assert(!prepared.messages[0].content.includes('{"changes"'));
    assert(!prepared.snapshots.some(snapshot => snapshot.path === 'edit.md'));
    assert.strictEqual(prepared.provenance.kind, 'graph_issue');
    assert.strictEqual(prepared.provenance.issueType, issue.type);
    assert.strictEqual(prepared.provenance.evidenceCount, binding.dependencies.evidence.length);
    assert(!Object.prototype.hasOwnProperty.call(prepared.provenance, 'evidence'));
    assert(!Object.prototype.hasOwnProperty.call(prepared.provenance, 'issueDigest'));
    assert.strictEqual(validateIssueDependencies({
      graph, projectService, projectInstanceId, rootPath: root, dependencies: prepared.dependencies,
    }), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fails closed when an evidence file changes after binding', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    fs.appendFileSync(path.join(root, 'chapters', 'two.md'), '新增变化\n', 'utf8');
    expectCode('GRAPH_ISSUE_STALE', () => prepareGraphIssueHandoff({
      graph, projectService, projectInstanceId, rootPath: root, request: binding.request,
    }));
    expectCode('GRAPH_ISSUE_STALE', () => validateIssueDependencies({
      graph, projectService, projectInstanceId, rootPath: root, dependencies: binding.dependencies,
    }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('localized finalize binds target snapshots, rejects every readonly class and terminates no-op cleanly', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const binding = createIssueBinding({ graph, projectInstanceId, issueId: issue.id });
    const prepared = prepareGraphIssueHandoff({ graph, projectService, projectInstanceId, rootPath: root, request: binding.request });
    assert.throws(() => finalizeGraphIssueHandoff({
      prepared,
      model: { ok: true, stopReason: 'max_tokens', text: 'secret truncated graph output {' },
      changeSetService,
    }), error => error && error.code === 'MODEL_OUTPUT_TRUNCATED' &&
      !String(error.message).includes('secret truncated graph output'));
    expectCode('UNAUTHORIZED_PATCH_PATH', () => finalizeGraphIssueHandoff({
      prepared,
      model: { ok: true, text: JSON.stringify({ edits: [{
        path: 'edit.md', oldText: '项目规则', newText: '越权', summary: '越权',
      }] }) },
      changeSetService,
    }));
    for (const readonlyPath of ['references/source.md', 'sources/source.md']) {
      expectCode('UNAUTHORIZED_PATCH_PATH', () => finalizeGraphIssueHandoff({
        prepared,
        model: { ok: true, text: JSON.stringify({ edits: [{
          path: readonlyPath, oldText: '只读来源', newText: '篡改来源', summary: '越权',
        }] }) },
        changeSetService,
      }));
    }
    const empty = finalizeGraphIssueHandoff({
      prepared,
      model: { ok: true, text: JSON.stringify({ edits: [] }) },
      changeSetService,
    });
    assert.strictEqual(empty.ok, true);
    assert.strictEqual(empty.noChanges, true);
    assert.strictEqual(empty.fileCount, 0);
    assert.strictEqual(empty.changeSet, undefined);

    const target = prepared.snapshots[0];
    const anchor = target.content.split('\n').find(line => line.includes('年龄'));
    assert(anchor);
    const noOp = finalizeGraphIssueHandoff({
      prepared,
      model: { ok: true, text: JSON.stringify({ edits: [{
        path: target.path, oldText: anchor, newText: anchor, summary: '无需修改',
      }] }) },
      changeSetService,
    });
    assert.strictEqual(noOp.noChanges, true);
    const result = finalizeGraphIssueHandoff({
      prepared,
      model: { ok: true, text: JSON.stringify({ edits: [{
        path: target.path, oldText: anchor, newText: `${anchor}\n已修正冲突。`, summary: '修正一致性',
      }] }) },
      changeSetService,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changeSet.changes[0].path, target.path);
    assert(result.changeSet.changes[0].after.includes('已修正冲突。'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('dismissed/resolved and edit-only issues never expose a repair handoff', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const dismissedGraph = {
      ...graph,
      issues: graph.issues.map(item => item.id === issue.id ? { ...item, status: 'dismissed' } : item),
    };
    expectCode('GRAPH_ISSUE_INACTIVE', () => createIssueBinding({ graph: dismissedGraph, projectInstanceId, issueId: issue.id }));
    assert.strictEqual(decorateGraphIssues({ graph: dismissedGraph, projectInstanceId }).issues
      .find(item => item.id === issue.id).changesHandoffUnavailableReason, 'GRAPH_ISSUE_INACTIVE');

    const editEvidence = graph.evidence.find(item => item.path === 'edit.md');
    assert(editEvidence);
    const editOnly = {
      ...graph,
      issues: [{ ...issue, evidenceIds: [editEvidence.id], status: 'open' }],
    };
    expectCode('NO_ISSUE_TARGETS', () => createIssueBinding({ graph: editOnly, projectInstanceId, issueId: issue.id }));
    assert.strictEqual(decorateGraphIssues({ graph: editOnly, projectInstanceId }).issues[0]
      .changesHandoffUnavailableReason, 'NO_ISSUE_TARGETS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('oversized evidence is a per-issue unavailable reason instead of breaking graph decoration', () => {
  const { root, graph, issue, projectInstanceId } = setup();
  try {
    const evidenceId = issue.evidenceIds[0];
    const tooMany = {
      ...graph,
      issues: [{ ...issue, evidenceIds: Array.from({ length: 101 }, (_, index) => `${evidenceId.slice(0, -4)}${index.toString(16).padStart(4, '0')}`) }],
    };
    const decorated = decorateGraphIssues({ graph: tooMany, projectInstanceId });
    assert.strictEqual(decorated.issues[0].changesHandoff, null);
    assert.strictEqual(decorated.issues[0].changesHandoffUnavailableReason, 'ISSUE_EVIDENCE_TOO_MANY');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\nGraph Issue handoff ${passed}/${passed} passed.`);
