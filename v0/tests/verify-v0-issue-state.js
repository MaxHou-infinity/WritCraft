'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ISSUES_SCHEMA,
  GRAPH_SCHEMA,
  loadIssueState,
  reconcileIssueStates,
  setIssueStatus,
} = require('../src/main/issue-state-service');
const { analyzeProject } = require('../src/main/consistency-engine');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-issues-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.writeFileSync(path.join(root, 'chapter.md'), '# 正文\n用户正文不可被状态文件修改。\n');
  return root;
}

function issue(suffix) {
  return {
    id: `issue_${suffix}`,
    type: 'attribute_conflict',
    severity: 'warning',
    message: `问题 ${suffix}`,
    evidenceIds: ['ev_1', 'ev_2'],
    status: 'open',
  };
}

function issuePath(root) {
  return path.join(root, '.writcraft', 'issues.json');
}

console.log('\nIssue state service verification');

test('persists acknowledged status in the v1 user-state schema', () => {
  const root = makeRoot();
  try {
    const bodyBefore = fs.readFileSync(path.join(root, 'chapter.md'), 'utf8');
    const result = setIssueStatus(root, [issue('aaa'), issue('bbb')], 'issue_aaa', 'acknowledged');
    assert.strictEqual(result.issue.status, 'acknowledged');
    const persisted = JSON.parse(fs.readFileSync(issuePath(root), 'utf8'));
    assert.strictEqual(persisted.schema, ISSUES_SCHEMA);
    assert.strictEqual(persisted.graphSchema, GRAPH_SCHEMA);
    assert.deepStrictEqual(persisted.states.map(state => [state.issueId, state.status]), [
      ['issue_aaa', 'acknowledged'],
    ]);
    assert.match(persisted.states[0].updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapter.md'), 'utf8'), bodyBefore);
    assert(!fs.readdirSync(path.join(root, '.writcraft')).some(name => name.endsWith('.tmp')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restores persisted decisions onto a freshly rebuilt graph', () => {
  const root = makeRoot();
  try {
    setIssueStatus(root, [issue('aaa'), issue('bbb')], 'issue_bbb', 'dismissed');
    const graphAfterRestart = [issue('aaa'), issue('bbb')];
    const result = reconcileIssueStates(root, graphAfterRestart);
    assert.deepStrictEqual(result.issues.map(item => [item.id, item.status]), [
      ['issue_aaa', 'open'],
      ['issue_bbb', 'dismissed'],
    ]);
    assert.strictEqual(result.recovered, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('supports resolved, dismissed and resetting to open', () => {
  const root = makeRoot();
  try {
    const graph = [issue('aaa'), issue('bbb')];
    setIssueStatus(root, graph, 'issue_aaa', 'resolved');
    setIssueStatus(root, graph, 'issue_bbb', 'dismissed');
    let loaded = loadIssueState(root).document;
    assert.deepStrictEqual(loaded.states.map(item => item.status), ['resolved', 'dismissed']);
    const reset = setIssueStatus(root, graph, 'issue_aaa', 'open');
    assert.strictEqual(reset.issue.status, 'open');
    loaded = loadIssueState(root).document;
    assert.deepStrictEqual(loaded.states.map(item => [item.issueId, item.status]), [
      ['issue_bbb', 'dismissed'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prunes decisions for issues that no longer exist in the current graph', () => {
  const root = makeRoot();
  try {
    const initial = [issue('aaa'), issue('bbb')];
    setIssueStatus(root, initial, 'issue_aaa', 'acknowledged');
    setIssueStatus(root, initial, 'issue_bbb', 'resolved');
    const result = reconcileIssueStates(root, [issue('bbb')]);
    assert.strictEqual(result.pruned, 1);
    assert.deepStrictEqual(result.issues.map(item => [item.id, item.status]), [['issue_bbb', 'resolved']]);
    assert.deepStrictEqual(loadIssueState(root).document.states.map(item => item.issueId), ['issue_bbb']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('logical issue IDs and user decisions survive evidence offset/revision changes', () => {
  const root = makeRoot();
  try {
    const firstGraph = analyzeProject([
      { path: 'a.md', revision: 'r1', content: '林舟的年龄是32岁。' },
      { path: 'b.md', revision: 'r1', content: '林舟的年龄是35岁。' },
    ]);
    const firstIssue = firstGraph.issues.find(item => item.type === 'attribute_conflict');
    assert(firstIssue);
    setIssueStatus(root, firstGraph.issues, firstIssue.id, 'acknowledged');

    const rebuiltGraph = analyzeProject([
      { path: 'a.md', revision: 'r2', content: '# 前言\n新增一段。\n林舟的年龄是32岁。' },
      { path: 'b.md', revision: 'r2', content: '# 修订\n林舟的年龄是35岁。' },
    ]);
    const rebuiltIssue = rebuiltGraph.issues.find(item => item.type === 'attribute_conflict');
    assert(rebuiltIssue);
    assert.strictEqual(rebuiltIssue.id, firstIssue.id);
    assert.notDeepStrictEqual(rebuiltIssue.evidenceIds, firstIssue.evidenceIds);
    const restored = reconcileIssueStates(root, rebuiltGraph.issues);
    assert.strictEqual(restored.issues.find(item => item.id === rebuiltIssue.id).status, 'acknowledged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt JSON falls back to open states and is atomically repaired', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(issuePath(root), '{broken json');
    const loaded = loadIssueState(root);
    assert.strictEqual(loaded.reason, 'CORRUPT');
    assert.strictEqual(loaded.needsRepair, true);
    const reconciled = reconcileIssueStates(root, [issue('aaa')]);
    assert.strictEqual(reconciled.recovered, true);
    assert.strictEqual(reconciled.issues[0].status, 'open');
    const repaired = JSON.parse(fs.readFileSync(issuePath(root), 'utf8'));
    assert.strictEqual(repaired.schema, ISSUES_SCHEMA);
    assert.deepStrictEqual(repaired.states, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('old schema and duplicate state records safely fall back', () => {
  const root = makeRoot();
  try {
    const timestamp = new Date().toISOString();
    fs.writeFileSync(issuePath(root), JSON.stringify({
      schema: 'writcraft.issues/v0', graphSchema: GRAPH_SCHEMA, updatedAt: timestamp, states: [],
    }));
    assert.strictEqual(loadIssueState(root).reason, 'INVALID');
    fs.writeFileSync(issuePath(root), JSON.stringify({
      schema: ISSUES_SCHEMA,
      graphSchema: 'writcraft.graph/v1',
      updatedAt: timestamp,
      states: [{ issueId: 'issue_aaa', status: 'dismissed', updatedAt: timestamp }],
    }));
    assert.strictEqual(loadIssueState(root).reason, 'INVALID');
    fs.writeFileSync(issuePath(root), JSON.stringify({
      schema: ISSUES_SCHEMA,
      graphSchema: GRAPH_SCHEMA,
      updatedAt: timestamp,
      states: [
        { issueId: 'issue_aaa', status: 'dismissed', updatedAt: timestamp },
        { issueId: 'issue_aaa', status: 'resolved', updatedAt: timestamp },
      ],
    }));
    assert.strictEqual(loadIssueState(root).reason, 'INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlink state files without reading or overwriting their target', () => {
  const root = makeRoot();
  const outside = path.join(os.tmpdir(), `writcraft-outside-issues-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(outside, 'external sentinel');
    fs.symlinkSync(outside, issuePath(root));
    const loaded = loadIssueState(root);
    assert.strictEqual(loaded.reason, 'UNSAFE_PATH');
    assert.strictEqual(loaded.persistenceBlocked, true);
    const reconciled = reconcileIssueStates(root, [issue('aaa')]);
    assert.strictEqual(reconciled.issues[0].status, 'open');
    assert.strictEqual(reconciled.persistenceBlocked, true);
    expectCode('UNSAFE_ISSUES_PATH', () => setIssueStatus(root, [issue('aaa')], 'issue_aaa', 'dismissed'));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'external sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch (_) {}
  }
});

test('rejects invalid statuses, foreign issue IDs and duplicate graph IDs', () => {
  const root = makeRoot();
  try {
    expectCode('INVALID_ISSUE_STATUS', () => setIssueStatus(root, [issue('aaa')], 'issue_aaa', 'hidden'));
    expectCode('INVALID_ISSUE_ID', () => setIssueStatus(root, [issue('aaa')], '../issue_aaa', 'dismissed'));
    expectCode('ISSUE_NOT_FOUND', () => setIssueStatus(root, [issue('aaa')], 'issue_missing', 'dismissed'));
    expectCode('INVALID_GRAPH_ISSUES', () => reconcileIssueStates(root, [issue('aaa'), issue('aaa')]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Main IPC and preload expose only issue ID and status under current-project authority', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  assert(main.includes("require('./issue-state-service')"));
  const routeStart = main.indexOf("ipcMain.handle('writcraft:project:set-issue-status'");
  const routeEnd = main.indexOf("ipcMain.handle('writcraft:project:build-source-index'", routeStart);
  const route = main.slice(routeStart, routeEnd);
  assert(routeStart >= 0);
  assert(route.includes('assertTrustedSender(event)'));
  assert(route.includes('requireMutableProject()'));
  assert(route.includes('project.rootPath'));
  assert(route.includes('setIssueStatus(project.rootPath, indexed.graph.issues, issueId, status)'));
  assert(!route.includes('rootPath, issueId, status)'));
  assert(route.includes('projectInstanceId !== project.instanceId'));
  assert(preload.includes("setIssueStatus: (projectInstanceId, issueId, status) => ipcRenderer.invoke('writcraft:project:set-issue-status', projectInstanceId, issueId, status)"));
  assert(main.includes('reconcileIssueStates(project.rootPath, indexed.graph.issues)'));
});

console.log(`\n${passed}/10 issue-state checks passed.\n`);
