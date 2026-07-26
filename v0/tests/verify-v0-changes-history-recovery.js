#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const reviewService = require('../src/main/changeset-review-service');
const historyService = require('../src/main/change-history-service');
const {
  RECOVERY_RELATIVE_PATH,
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');

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

function fixture(files = { 'a.md': 'old A' }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-chr-'));
  const project = projectService.createProjectAt(parent, 'Recovery Project');
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

function allHunkIds(review) {
  return review.files.flatMap(file => file.hunks.map(hunk => hunk.id));
}

function decision(review, acceptHunkIds, rejectHunkIds) {
  return {
    schema: reviewService.DECISION_SCHEMA,
    changeSetId: review.changeSetId,
    acceptHunkIds,
    rejectHunkIds,
  };
}

function serviceWithAtomicWrite(atomicWriteFile) {
  return Object.freeze({ ...projectService, atomicWriteFile });
}

function markerPath(rootPath) {
  return path.join(rootPath, RECOVERY_RELATIVE_PATH);
}

console.log('\nChanges / History durable recovery verification');

test('successful apply persists authoritative terminal state until exact clear', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'applied');
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'new A');
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
    const queried = transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(queried.recovery.outcome, 'applied');
    transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      result.operationId
    );
    assert.strictEqual(fs.existsSync(markerPath(item.project.rootPath)), false);
  } finally { item.cleanup(); }
});

test('safe terminal outcomes cannot be rewritten through manual recovery actions', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    expectCode('CHANGES_RECOVERY_CONFLICT', () => transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    ));
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'new A');
  } finally { item.cleanup(); }
});

test('accepted review is sealed as an apply transaction while reject-only is review', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const acceptedSet = makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' });
    const acceptedReview = reviewService.createReview(acceptedSet);
    const accepted = transaction.prepareReview({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: acceptedSet,
      decision: decision(acceptedReview, allHunkIds(acceptedReview), []),
    });
    assert.strictEqual(accepted.kind, 'apply');
    assert.strictEqual(accepted.decisionOperation, true);
    const acceptedResult = transaction.execute(accepted);
    assert.strictEqual(acceptedResult.ok, true);
    assert.strictEqual(acceptedResult.outcome, 'applied');
    assert.strictEqual(acceptedResult.status, 'completed');
    transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      acceptedResult.operationId
    );

    const rejectedSet = makeChangeSet(item.project.rootPath, { 'a.md': 'three\n' });
    const rejectedReview = reviewService.createReview(rejectedSet);
    const rejected = transaction.prepareReview({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: rejectedSet,
      decision: decision(rejectedReview, [], allHunkIds(rejectedReview)),
    });
    assert.strictEqual(rejected.kind, 'review');
  } finally { item.cleanup(); }
});

test('reject-only History commit followed by response error reconciles as reviewed', () => {
  const item = fixture({ 'a.md': 'one\n' });
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const set = makeChangeSet(item.project.rootPath, { 'a.md': 'two\n' });
    const review = reviewService.createReview(set);
    const result = transaction.review({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: set,
      decision: decision(review, [], allHunkIds(review)),
      options: {
        saveHistory(rootPath, history) {
          historyService.saveHistory(rootPath, history);
          throw new Error('response lost after History rename');
        },
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'reviewed');
    assert.strictEqual(result.responseRecovered, true);
    assert.strictEqual(result.residualUnavailable, true);
  } finally { item.cleanup(); }
});

test('writer committed then threw plus failed rollback is authoritatively applied', () => {
  const item = fixture();
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2) throw new Error('rollback unavailable');
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
      options: {
        saveHistory(rootPath, history) {
          historyService.saveHistory(rootPath, history);
          throw new Error('writer threw after commit');
        },
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'applied');
    assert.strictEqual(result.responseRecovered, true);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'new A');
  } finally { item.cleanup(); }
});

test('History failure with successful manuscript rollback is terminal zero-write', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
      options: {
        saveHistory() { throw new Error('History unavailable'); },
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'zero_write_error');
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'old A');
  } finally { item.cleanup(); }
});

test('begin callback failure occurs after marker persistence and before any write', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    let observedMarker = false;
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
      onBegin() {
        observedMarker = fs.existsSync(markerPath(item.project.rootPath));
        throw new Error('capability isolation failed');
      },
    });
    assert.strictEqual(observedMarker, true);
    assert.strictEqual(result.outcome, 'zero_write_error');
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'old A');
  } finally { item.cleanup(); }
});

test('partial apply plus failed rollback becomes manual and restore-before is exact', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'manual_recovery');
    assert.deepStrictEqual(
      [fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'),
        fs.readFileSync(path.join(item.project.rootPath, 'b.md'), 'utf8')],
      ['new A', 'old B']
    );
    const restored = transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    );
    assert.strictEqual(restored.recovery.outcome, 'zero_write_error');
    assert.deepStrictEqual(
      [fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'),
        fs.readFileSync(path.join(item.project.rootPath, 'b.md'), 'utf8')],
      ['old A', 'old B']
    );
  } finally { item.cleanup(); }
});

test('undo rollback failure becomes committed warning and can restore operation-before', () => {
  const item = fixture();
  try {
    const initial = createChangesHistoryTransaction({ projectService });
    const applied = initial.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    initial.reconciliation.clear(item.project.rootPath, item.project.projectId, applied.operationId);
    const entryId = historyService.listHistory(item.project.rootPath)[0].id;

    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2) throw new Error('undo rollback unavailable');
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const undone = transaction.undo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId,
      options: { saveHistory() { throw new Error('History unavailable'); } },
    });
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(undone.outcome, 'committed_warning');
    assert.strictEqual(undone.recoveryRequired, true);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'old A');
    const restored = transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      undone.operationId,
      'restore_before'
    );
    assert.strictEqual(restored.recovery.outcome, 'zero_write_error');
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'new A');
    assert.strictEqual(historyService.listHistory(item.project.rootPath)[0].status, 'applied');
  } finally { item.cleanup(); }
});

test('mid-undo apply failure plus rollback failure becomes manual recovery', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    const initial = createChangesHistoryTransaction({ projectService });
    const applied = initial.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    initial.reconciliation.clear(item.project.rootPath, item.project.projectId, applied.operationId);
    const entryId = historyService.listHistory(item.project.rootPath)[0].id;
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected undo write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.undo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'manual_recovery');
    assert.strictEqual(result.consumed, true);
    assert.strictEqual(historyService.listHistory(item.project.rootPath)[0].status, 'applied');
  } finally { item.cleanup(); }
});

test('manual keep-after writes exact sealed files and prepared History', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    const kept = transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'keep_after'
    );
    assert.strictEqual(kept.recovery.outcome, 'applied');
    assert.deepStrictEqual(
      [fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'),
        fs.readFileSync(path.join(item.project.rootPath, 'b.md'), 'utf8')],
      ['new A', 'new B']
    );
    assert.strictEqual(historyService.listHistory(item.project.rootPath).length, 1);
  } finally { item.cleanup(); }
});

test('foreign third revision prevents either manual recovery action', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    fs.writeFileSync(path.join(item.project.rootPath, 'a.md'), 'foreign A');
    expectCode('CHANGES_RECOVERY_CONFLICT', () => transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    ));
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
  } finally { item.cleanup(); }
});

test('History compare-and-swap refuses a foreign state introduced during recovery', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let raceInjected = false;
    const racingHistory = Object.freeze({
      ...historyService,
      restoreHistoryState(rootPath, targetState, options) {
        if (!raceInjected) {
          raceInjected = true;
          const expected = options.expectedState;
          historyService.saveHistory(rootPath, {
            ...expected.history,
            updatedAt: new Date(Date.parse(expected.history.updatedAt) + 1000).toISOString(),
          }, { expectedState: expected });
        }
        return historyService.restoreHistoryState(rootPath, targetState, options);
      },
    });
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const reconciliation = createChangesHistoryReconciliationService({
      projectService: flakyProject,
      historyService: racingHistory,
    });
    const transaction = createChangesHistoryTransaction({
      projectService: flakyProject,
      historyService: racingHistory,
      reconciliationService: reconciliation,
    });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    ));
    assert.strictEqual(raceInjected, true);
    assert.strictEqual(historyService.loadHistoryState(item.project.rootPath).exists, true);
    assert.strictEqual(reconciliation.query(
      item.project.rootPath,
      item.project.projectId
    ).recovery.outcome, 'manual_recovery');
  } finally { item.cleanup(); }
});

test('recovery write failure retains marker and the same action can be retried', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if ([2, 3, 4].includes(writes)) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    ));
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
    const retried = transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'restore_before'
    );
    assert.strictEqual(retried.recovery.outcome, 'zero_write_error');
  } finally { item.cleanup(); }
});

test('History rename followed by fsync failure stays locked until a durable retry', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  const originalFsync = fs.fsyncSync;
  try {
    let failHistoryFsync = true;
    const fsyncHistory = Object.freeze({
      ...historyService,
      restoreHistoryState(rootPath, targetState, options) {
        if (!failHistoryFsync) {
          return historyService.restoreHistoryState(rootPath, targetState, options);
        }
        failHistoryFsync = false;
        let calls = 0;
        fs.fsyncSync = fd => {
          calls += 1;
          if (calls === 2) throw new Error('recovery History directory fsync failed');
          return originalFsync(fd);
        };
        try {
          return historyService.restoreHistoryState(rootPath, targetState, options);
        } finally {
          fs.fsyncSync = originalFsync;
        }
      },
    });
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const reconciliation = createChangesHistoryReconciliationService({
      projectService: flakyProject,
      historyService: fsyncHistory,
    });
    const transaction = createChangesHistoryTransaction({
      projectService: flakyProject,
      historyService: fsyncHistory,
      reconciliationService: reconciliation,
    });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'keep_after'
    ));
    const locked = reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(locked.recovery.outcome, 'manual_recovery');
    assert.strictEqual(reconciliation.hasPending(item.project.rootPath), true);
    const retried = reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'keep_after'
    );
    assert.strictEqual(retried.recovery.outcome, 'applied');
  } finally {
    fs.fsyncSync = originalFsync;
    item.cleanup();
  }
});

test('corrupt foreign History keeps a manual transaction locked', () => {
  const item = fixture({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    let writes = 0;
    const flakyProject = serviceWithAtomicWrite((...args) => {
      writes += 1;
      if (writes === 2 || writes === 3) throw new Error(`injected write ${writes}`);
      return projectService.atomicWriteFile(...args);
    });
    const transaction = createChangesHistoryTransaction({ projectService: flakyProject });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A', 'b.md': 'new B' }),
    });
    fs.writeFileSync(path.join(item.project.rootPath, historyService.HISTORY_RELATIVE_PATH), '{corrupt');
    assert.strictEqual(transaction.reconciliation.query(
      item.project.rootPath,
      item.project.projectId
    ).recovery.outcome, 'manual_recovery');
    expectCode('CHANGES_RECOVERY_CONFLICT', () => transaction.reconciliation.resolve(
      item.project.rootPath,
      item.project.projectId,
      result.operationId,
      'keep_after'
    ));
  } finally { item.cleanup(); }
});

test('wrong project and wrong operation cannot query, resolve, or clear marker', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    expectCode('CHANGES_RECOVERY_STALE', () =>
      transaction.reconciliation.query(item.project.rootPath, 'foreign-project'));
    expectCode('CHANGES_RECOVERY_STALE', () => transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      `chr_${'0'.repeat(48)}`
    ));
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
    transaction.reconciliation.clear(item.project.rootPath, item.project.projectId, result.operationId);
  } finally { item.cleanup(); }
});

test('clear failure returns a stable error and retains the terminal marker', () => {
  const item = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeClear() { throw new Error('injected clear failure'); },
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    const result = transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      result.operationId
    ));
    assert.strictEqual(reconciliation.hasPending(item.project.rootPath), true);
  } finally { item.cleanup(); }
});

test('prepare marker failure is zero-write and finish failure reconciles after response loss', () => {
  const failedPrepare = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeMarkerRename() { throw new Error('prepare marker failure'); },
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => transaction.apply({
      rootPath: failedPrepare.project.rootPath,
      projectId: failedPrepare.project.projectId,
      changeSet: makeChangeSet(failedPrepare.project.rootPath, { 'a.md': 'new A' }),
    }));
    assert.strictEqual(fs.readFileSync(path.join(failedPrepare.project.rootPath, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(reconciliation.hasPending(failedPrepare.project.rootPath), false);
  } finally { failedPrepare.cleanup(); }

  const failedFinish = fixture();
  try {
    let renames = 0;
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeMarkerRename() {
        renames += 1;
        if (renames === 2) throw new Error('finish marker failure');
      },
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    expectCode('CHANGES_RECOVERY_WRITE_FAILED', () => transaction.apply({
      rootPath: failedFinish.project.rootPath,
      projectId: failedFinish.project.projectId,
      changeSet: makeChangeSet(failedFinish.project.rootPath, { 'a.md': 'new A' }),
    }));
    assert.strictEqual(fs.readFileSync(path.join(failedFinish.project.rootPath, 'a.md'), 'utf8'), 'new A');
    const restarted = createChangesHistoryReconciliationService({ projectService });
    const queried = restarted.query(failedFinish.project.rootPath, failedFinish.project.projectId);
    assert.strictEqual(queried.recovery.outcome, 'applied');
  } finally { failedFinish.cleanup(); }
});

test('a marker in project A does not contaminate project B recovery authority', () => {
  const a = fixture();
  const b = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    const resultA = transaction.apply({
      rootPath: a.project.rootPath,
      projectId: a.project.projectId,
      changeSet: makeChangeSet(a.project.rootPath, { 'a.md': 'new A' }),
    });
    assert.strictEqual(transaction.reconciliation.hasPending(a.project.rootPath), true);
    assert.strictEqual(transaction.reconciliation.query(
      b.project.rootPath,
      b.project.projectId
    ).recovery, null);
    const resultB = transaction.apply({
      rootPath: b.project.rootPath,
      projectId: b.project.projectId,
      changeSet: makeChangeSet(b.project.rootPath, { 'a.md': 'new B' }),
    });
    assert.strictEqual(resultB.outcome, 'applied');
    transaction.reconciliation.clear(a.project.rootPath, a.project.projectId, resultA.operationId);
    transaction.reconciliation.clear(b.project.rootPath, b.project.projectId, resultB.operationId);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('first marker publication cannot overwrite a concurrently created marker', () => {
  const item = fixture();
  try {
    let injected = false;
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      beforeMarkerRename(location) {
        if (injected) return;
        injected = true;
        fs.writeFileSync(location.file, '{}');
      },
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    expectCode('CHANGES_RECOVERY_PENDING', () => transaction.apply({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
    }));
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(fs.readFileSync(markerPath(item.project.rootPath), 'utf8'), '{}');
  } finally { item.cleanup(); }
});

test('History directory fsync failures throw and failed delete restores the prior audit', () => {
  const item = fixture();
  const originalFsync = fs.fsyncSync;
  try {
    const prepared = historyService.prepareApplication(
      item.project.rootPath,
      makeChangeSet(item.project.rootPath, { 'a.md': 'new A' })
    );
    let calls = 0;
    fs.fsyncSync = fd => {
      calls += 1;
      if (calls === 2) throw new Error('directory fsync failed');
      return originalFsync(fd);
    };
    assert.throws(() => historyService.saveHistory(
      item.project.rootPath,
      prepared.preparedHistoryState.history,
      { expectedState: prepared.baseHistoryState }
    ), /directory fsync failed/);
    fs.fsyncSync = originalFsync;
    const committed = historyService.loadHistoryState(item.project.rootPath);
    assert.strictEqual(committed.exists, true);

    calls = 0;
    fs.fsyncSync = fd => {
      calls += 1;
      if (calls === 1) throw new Error('delete fsync failed');
      return originalFsync(fd);
    };
    assert.throws(() => historyService.restoreHistoryState(item.project.rootPath, {
      exists: false,
      history: {
        schema: historyService.HISTORY_SCHEMA,
        updatedAt: new Date().toISOString(),
        entries: [],
      },
    }, { expectedState: committed }), /delete fsync failed/);
    fs.fsyncSync = originalFsync;
    assert.strictEqual(historyService.loadHistoryState(item.project.rootPath).exists, true);
    assert.strictEqual(historyService.listHistory(item.project.rootPath).length, 1);
  } finally {
    fs.fsyncSync = originalFsync;
    item.cleanup();
  }
});

test('corrupt and oversized markers fail closed without reading unbounded input', () => {
  for (const kind of ['corrupt', 'oversized']) {
    const item = fixture();
    try {
      const recoveryDirectory = path.dirname(markerPath(item.project.rootPath));
      fs.mkdirSync(recoveryDirectory, { recursive: true });
      if (kind === 'corrupt') fs.writeFileSync(markerPath(item.project.rootPath), '{bad json');
      else {
        const fd = fs.openSync(markerPath(item.project.rootPath), 'w');
        fs.ftruncateSync(fd, (96 * 1024 * 1024) + 1);
        fs.closeSync(fd);
      }
      const reconciliation = createChangesHistoryReconciliationService({ projectService });
      expectCode('CHANGES_MANUAL_RECOVERY_REQUIRED', () =>
        reconciliation.query(item.project.rootPath, item.project.projectId));
      assert.strictEqual(reconciliation.hasPending(item.project.rootPath), true);
    } finally { item.cleanup(); }
  }
});

test('symlink and hard-link marker paths fail closed before manuscript write', () => {
  for (const kind of ['symlink', 'hardlink']) {
    const item = fixture();
    const outside = path.join(item.parent, `${kind}.json`);
    try {
      const recoveryDirectory = path.dirname(markerPath(item.project.rootPath));
      fs.mkdirSync(recoveryDirectory, { recursive: true });
      fs.writeFileSync(outside, '{}');
      if (kind === 'symlink') fs.symlinkSync(outside, markerPath(item.project.rootPath));
      else fs.linkSync(outside, markerPath(item.project.rootPath));
      const transaction = createChangesHistoryTransaction({ projectService });
      expectCode('CHANGES_MANUAL_RECOVERY_REQUIRED', () => transaction.apply({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        changeSet: makeChangeSet(item.project.rootPath, { 'a.md': 'new A' }),
      }));
      assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'old A');
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), '{}');
    } finally { item.cleanup(); }
  }
});

console.log(`\n${passed}/24 Changes / History recovery checks passed.\n`);
