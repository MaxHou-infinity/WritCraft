#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const reviewService = require('../src/main/changeset-review-service');
const pendingStoreService = require('../src/main/pending-changeset-store');
const {
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');
const {
  QUERY_SCHEMA,
  RESOLVE_SCHEMA,
  CLEAR_SCHEMA,
  createChangesHistoryHandler,
} = require('../src/main/changes-history-handler');

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

function fixture(files = { 'a.md': 'old A' }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-chh-'));
  const project = projectService.createProjectAt(parent, 'Handler Project');
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(project.rootPath, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return {
    parent,
    project,
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}

function makeChangeSet(rootPath, afterByPath) {
  const snapshots = Object.keys(afterByPath).map(filePath => ({
    path: filePath,
    ...projectService.readFileWithRevision(rootPath, filePath),
  }));
  return changeSetService.createChangeSet(snapshots, snapshots.map(file => ({
    path: file.path,
    after: afterByPath[file.path],
    summary: `更新 ${file.path}`,
  })));
}

function reviewedPending(store, project, changeSet) {
  const capability = store.allocateCapability();
  const review = reviewService.createReview(changeSet, { reviewId: capability });
  store.putWithCapability(capability, changeSet, project.rootPath, {
    selectionPolicy: 'hunk',
  });
  return { capability, review };
}

function decision(review, accepted = true) {
  const ids = review.files.flatMap(file => file.hunks.map(hunk => hunk.id));
  return {
    schema: reviewService.DECISION_SCHEMA,
    changeSetId: review.changeSetId,
    acceptHunkIds: accepted ? ids : [],
    rejectHunkIds: accepted ? [] : ids,
  };
}

function handlerFixture(item, overrides = {}) {
  const pending = overrides.pending || pendingStoreService.createPendingChangeSetStore();
  const transaction = overrides.transaction || createChangesHistoryTransaction({
    projectService: overrides.projectService || projectService,
    ...(overrides.reconciliationService
      ? { reconciliationService: overrides.reconciliationService }
      : {}),
  });
  const calls = { aborted: 0, finalized: 0, undo: 0 };
  const handler = createChangesHistoryHandler({
    transaction,
    pendingChangeSets: pending,
    getCurrentProject: () => overrides.currentProject === undefined
      ? item.project
      : overrides.currentProject(),
    assertMutationAvailable: overrides.assertMutationAvailable || (() => true),
    assertRecoveryAvailable: overrides.assertRecoveryAvailable || (() => true),
    validateDependencies: overrides.validateDependencies,
    abortHiddenAuthority() { calls.aborted += 1; },
    finalizeApply: overrides.finalizeApply || (({ result }) => {
      calls.finalized += 1;
      const { residualChangeSet: _private, ...safe } = result;
      return safe;
    }),
    finalizeUndo: overrides.finalizeUndo || (({ result }) => {
      calls.undo += 1;
      return result;
    }),
  });
  return { pending, transaction, handler, calls };
}

console.log('\nChanges / History Main handler verification');

test('pre-marker decision validation failure preserves the original capability', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const state = handlerFixture(item);
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const malformed = { ...decision(record.review), unknown: true };
    const result = state.handler.applyChanges(item.project.instanceId, malformed);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(state.pending.has(record.capability), true);
    assert.strictEqual(state.transaction.reconciliation.hasPending(item.project.rootPath), false);
  } finally { item.cleanup(); }
});

test('incomplete Graph Issue decision keeps its capability and public error code', () => {
  const before = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const afterLines = before.trimEnd().split('\n');
  afterLines[0] = 'changed line 1';
  afterLines[13] = 'changed line 14';
  const item = fixture({ 'a.md': before });
  try {
    const state = handlerFixture(item);
    const changeSet = makeChangeSet(item.project.rootPath, {
      'a.md': afterLines.join('\n') + '\n',
    });
    const capability = state.pending.allocateCapability();
    const review = reviewService.createReview(changeSet, { reviewId: capability });
    assert(review.totalHunks >= 2, 'fixture must produce at least two review hunks');
    state.pending.putWithCapability(capability, changeSet, item.project.rootPath, {
      selectionPolicy: 'hunk',
      requireCompleteDecision: true,
    });
    const result = state.handler.applyChanges(item.project.instanceId, {
      schema: reviewService.DECISION_SCHEMA,
      changeSetId: capability,
      acceptHunkIds: [review.files[0].hunks[0].id],
      rejectHunkIds: [],
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.schema, 'writcraft.changes-history-error/v1');
    assert.strictEqual(result.error.code, 'ISSUE_REVIEW_INCOMPLETE');
    assert.strictEqual(result.error.recoverable, true);
    assert.strictEqual(state.pending.has(capability), true);
    assert.strictEqual(state.transaction.reconciliation.hasPending(item.project.rootPath), false);
  } finally { item.cleanup(); }
});

test('normal apply burns the capability, preserves public result and blocks replay', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const state = handlerFixture(item);
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const input = decision(record.review);
    const result = state.handler.applyChanges(item.project.instanceId, input);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'applied');
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(state.pending.has(record.capability), false);
    assert.strictEqual(state.calls.finalized, 1);
    assert.strictEqual(Object.hasOwn(result, 'residualChangeSet'), false);
    const replay = state.handler.applyChanges(item.project.instanceId, input);
    assert.strictEqual(replay.ok, false);
    assert.strictEqual(replay.error.code, 'CHANGESET_NOT_FOUND');
  } finally { item.cleanup(); }
});

test('marker prepare failure occurs before capability burn', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeMarkerRename() { throw new Error('marker unavailable'); },
    });
    const state = handlerFixture(item, { reconciliationService: reconciliation });
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const result = state.handler.applyChanges(item.project.instanceId, decision(record.review));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'CHANGES_RECOVERY_WRITE_FAILED');
    assert.strictEqual(state.pending.has(record.capability), true);
  } finally { item.cleanup(); }
});

test('terminal marker response loss burns capability and query recovers authority', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    let writes = 0;
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeMarkerRename() {
        writes += 1;
        if (writes === 2) throw new Error('terminal response lost');
      },
    });
    const state = handlerFixture(item, { reconciliationService: reconciliation });
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const result = state.handler.applyChanges(item.project.instanceId, decision(record.review));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(state.pending.has(record.capability), false);
    assert.strictEqual(state.calls.aborted, 1);
    const restarted = handlerFixture(item);
    const query = restarted.handler.queryRecovery(item.project.instanceId, { schema: QUERY_SCHEMA });
    assert.strictEqual(query.ok, true);
    assert.strictEqual(query.recovery.outcome, 'applied');
    assert(!JSON.stringify(query).includes(item.project.rootPath));
  } finally { item.cleanup(); }
});

test('postcommit failure stays successful and terminates hidden follow-up authority', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const state = handlerFixture(item, {
      finalizeApply() { throw Object.assign(new Error('tree failed'), { code: 'TREE_REFRESH_FAILED' }); },
    });
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const result = state.handler.applyChanges(item.project.instanceId, decision(record.review));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'committed_warning');
    assert.strictEqual(result.refreshRequired, true);
    assert.strictEqual(result.residualUnavailable, true);
    assert.strictEqual(state.pending.has(record.capability), false);
    assert.strictEqual(state.calls.aborted, 1);
  } finally { item.cleanup(); }
});

test('project switch is rejected before pending capability lookup or mutation', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    let mutationChecks = 0;
    const state = handlerFixture(item, {
      assertMutationAvailable() { mutationChecks += 1; },
    });
    const record = reviewedPending(
      state.pending,
      item.project,
      makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' })
    );
    const result = state.handler.applyChanges('instance_000000000000000000000000', decision(record.review));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'STALE_AI_PROJECT');
    assert.strictEqual(mutationChecks, 0);
    assert.strictEqual(state.pending.has(record.capability), true);
  } finally { item.cleanup(); }
});

test('recovery requests are exact identifier-only objects', () => {
  const item = fixture();
  try {
    const state = handlerFixture(item);
    const invalid = state.handler.queryRecovery(item.project.instanceId, {
      schema: QUERY_SCHEMA,
      rootPath: item.project.rootPath,
    });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error.code, 'INVALID_RECOVERY_REQUEST');
    const accessor = {};
    Object.defineProperty(accessor, 'schema', {
      enumerable: true,
      get() { throw new Error('must not execute'); },
    });
    const rejected = state.handler.queryRecovery(item.project.instanceId, accessor);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.error.code, 'INVALID_RECOVERY_REQUEST');
  } finally { item.cleanup(); }
});

test('manual resolve and exact clear expose no root, content, revisions or History', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = Object.freeze({
      ...projectService,
      atomicWriteFile(...args) {
        writes += 1;
        if (writes === 2 || writes === 3) throw new Error(`write ${writes}`);
        return projectService.atomicWriteFile(...args);
      },
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const uncertain = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    const state = handlerFixture(item, { transaction });
    const resolved = state.handler.resolveRecovery(item.project.instanceId, {
      schema: RESOLVE_SCHEMA,
      operationId: uncertain.operationId,
      action: 'restore_before',
    });
    assert.strictEqual(resolved.ok, true);
    assert.strictEqual(resolved.recovery.outcome, 'zero_write_error');
    const serialized = JSON.stringify(resolved);
    assert(!serialized.includes(item.project.rootPath));
    assert(!serialized.includes('old A'));
    assert(!serialized.includes('revision'));
    assert(!serialized.includes('History'));
    const cleared = state.handler.clearRecovery(item.project.instanceId, {
      schema: CLEAR_SCHEMA,
      operationId: uncertain.operationId,
    });
    assert.deepStrictEqual(cleared, {
      ok: true,
      schema: CLEAR_SCHEMA,
      operationId: uncertain.operationId,
    });
  } finally { item.cleanup(); }
});

test('undo binds project identity and postcommit failures cannot invite replay', () => {
  const item = fixture();
  try {
    const applyTransaction = createChangesHistoryTransaction({ projectService });
    const applied = applyTransaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    applyTransaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      applied.operationId
    );
    const entryId = require('../src/main/change-history-service')
      .listHistory(item.project.rootPath)[0].id;
    const stale = handlerFixture(item).handler.undoChange(
      'instance_000000000000000000000000',
      entryId
    );
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.error.code, 'STALE_AI_PROJECT');
    const state = handlerFixture(item, {
      finalizeUndo() { throw Object.assign(new Error('tree failed'), { code: 'TREE_REFRESH_FAILED' }); },
    });
    const result = state.handler.undoChange(item.project.instanceId, entryId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'committed_warning');
    assert.strictEqual(result.refreshRequired, true);
  } finally { item.cleanup(); }
});

console.log(`\n${passed}/10 Changes / History handler checks passed.\n`);
