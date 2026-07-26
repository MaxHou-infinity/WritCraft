#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const sourceIndexService = require('../src/main/source-index-service');
const changeSetService = require('../src/main/changeset-service');
const changeSetReviewService = require('../src/main/changeset-review-service');
const changeHistoryService = require('../src/main/change-history-service');
const pendingStoreService = require('../src/main/pending-changeset-store');
const researchService = require('../src/main/research-service');
const researchHandoffService = require('../src/main/research-handoff-service');
const transactionService = require('../src/main/research-apply-transaction');
const changesHistoryTransactionService = require('../src/main/changes-history-transaction');

let passed = 0;
function test(label, run) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function ids(prefix, length) {
  let value = 0;
  return () => `${prefix}${(++value).toString(16).padStart(length, '0')}`;
}

function chapter(prefix = '原文') {
  return Array.from({ length: 36 }, (_, index) => `${prefix}第 ${index + 1} 行`).join('\n') + '\n';
}

function write(rootPath, relativePath, content) {
  const absolutePath = path.join(rootPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

function canonicalRun(source, sourceContent) {
  const quote = '样本增长了 20%';
  const offset = sourceContent.indexOf(quote);
  const grade = researchService.gradeSource(source);
  const metadataGradeDigest = researchService.canonicalMetadataGradeDigest({ ...source, grade });
  return {
    selectedSources: [{
      ...source,
      metadataGradeDigest,
      grade: grade.grade,
      gradeReason: grade.reason,
      gradeRule: grade.rule,
    }],
    cards: [{
      claim: '样本增长了 20%，但只适用于本地区。',
      boundary: '不能外推到其他地区。',
      source: {
        id: source.id,
        title: source.title,
        filePath: source.filePath,
        revision: source.revision,
        metadataGradeDigest,
        locator: { filePath: source.filePath, offset, end: offset + quote.length, line: 2, column: 1 },
        quote,
      },
    }],
  };
}

function createFixture(options = {}) {
  let now = 10_000;
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-research-apply-'));
  const sourceContent = '---\ntype: official\ntitle: 官方报告\n---\n# 官方报告\n样本增长了 20%，边界仅限本地区。\n';
  const before = chapter();
  write(rootPath, 'edit.md', '# 项目意图\n保持结论克制。\n');
  write(rootPath, 'references/source.md', sourceContent);
  write(rootPath, 'chapters/01.md', before);
  fs.mkdirSync(path.join(rootPath, '.writcraft'), { recursive: true });
  const project = {
    instanceId: 'instance_111111111111111111111111',
    rootPath,
  };
  const initialSourceIndex = sourceIndexService.buildSourceIndex(rootPath);
  const source = initialSourceIndex.sources.find(item => item.filePath === 'references/source.md');
  assert(source);
  let store;
  const pending = pendingStoreService.createPendingChangeSetStore({
    clock: () => now,
    onRemove({ record, reason }) {
      if (!record?.researchDependencies || !['expired', 'evicted', 'cleared'].includes(reason)) return;
      try {
        store.discard({
          projectInstanceId: project.instanceId,
          rootPath,
          cardId: record.researchDependencies.cardId,
        });
      } catch (_) {}
    },
  });
  store = researchHandoffService.createResearchHandoffStore({
    clock: () => now,
    ttlMs: 100,
    runIdFactory: ids('rr_', 24),
    cardIdFactory: ids('rc_', 32),
    leaseIdFactory: ids('rl_', 32),
    applyLeaseIdFactory: ids('ra_', 32),
    revokeCapability: capability => pending.delete(capability, 'research-owner-revoked'),
  });
  const binding = {
    projectInstanceId: project.instanceId,
    rootPath,
    mutationGeneration: 1,
    ownerId: 'webcontents:1',
    navigationEpoch: 1,
  };
  const admission = store.admitRun(binding);
  const installed = store.installRun(admission, canonicalRun(source, sourceContent));
  const cardId = installed.cards[0].id;
  const prepared = researchHandoffService.prepareResearchHandoff({
    store,
    projectService,
    ...binding,
    request: {
      schema: researchHandoffService.HANDOFF_SCHEMA,
      cardId,
      targetPaths: ['chapters/01.md'],
    },
    sourceIndex: initialSourceIndex,
  });
  const lines = before.trimEnd().split('\n');
  lines[1] = '已应用：样本增长 20%。';
  lines[31] = '仍待处理：补充地区边界。';
  const changeSet = changeSetService.createChangeSet(
    [{ path: 'chapters/01.md', content: before, revision: revision(before) }],
    [{ path: 'chapters/01.md', after: `${lines.join('\n')}\n`, summary: '补充研究结论与边界' }]
  );
  const capability = pending.allocateCapability();
  const dependencies = researchHandoffService.bindResearchCapability(prepared.dependencies, capability);
  const review = changeSetReviewService.createReview(changeSet, { reviewId: capability });
  assert.equal(review.totalHunks, 2);
  pending.putWithCapability(capability, changeSet, rootPath, {
    researchDependencies: dependencies,
    provenance: prepared.provenance,
  });
  store.issueReview(cardId, prepared.leaseId, capability, dependencies, () => true);
  store.ackReview({ ...binding, cardId, capability });
  const pendingRecord = pending.get(capability);
  const baseTransactionOptions = {
    changeSetReviewService,
    researchHandoffService,
    researchHandoffStore: store,
    pendingChangeSets: pending,
    projectService,
    sourceIndex: sourceIndexService.buildSourceIndex,
    rememberApplied() {},
    invalidateDerivedState(changeSetId) {
      pending.clearExcept(changeSetId);
    },
  };
  return {
    rootPath,
    project,
    store,
    pending,
    pendingRecord,
    capability,
    cardId,
    review,
    before,
    advanceClock(value) { now += value; },
    transaction(overrides = {}) {
      return transactionService.createResearchApplyTransaction({
        ...baseTransactionOptions,
        ...overrides,
      });
    },
    partialDecision() {
      return {
        schema: changeSetReviewService.DECISION_SCHEMA,
        changeSetId: capability,
        acceptHunkIds: [review.files[0].hunks[0].id],
        rejectHunkIds: [],
      };
    },
    rejectOnlyDecision() {
      return {
        schema: changeSetReviewService.DECISION_SCHEMA,
        changeSetId: capability,
        acceptHunkIds: [],
        rejectHunkIds: [review.files[0].hunks[0].id],
      };
    },
    cleanup() { fs.rmSync(rootPath, { recursive: true, force: true }); },
  };
}

function assertCommittedWarning(item, result, expectedState = 'FAILED') {
  assert.equal(result.ok, true);
  assert.equal(result.refreshRequired, true);
  assert.equal(result.residualUnavailable, true);
  assert.equal(result.review, null);
  assert.equal(result.changeSetId, null);
  assert(result.historyEntry?.id);
  assert.equal(item.pending.has(item.capability), false);
  assert.equal(item.pending.size, 0);
  assert.equal(item.store.inspect(item.cardId)?.state, expectedState);
  assert.equal(changeHistoryService.listHistory(item.rootPath).length, 1);
}

function assertAppliedTruthAndUndo(item, result, terminalCode = 'RESEARCH_HANDOFF_FAILED') {
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].path, 'chapters/01.md');
  const committed = projectService.readFileWithRevision(item.rootPath, 'chapters/01.md');
  assert.equal(result.applied[0].revision, committed.revision);
  assert.deepStrictEqual(result.historyEntry.provenance, item.pendingRecord.provenance);
  assert.throws(() => item.store.beginApply({
    projectInstanceId: item.project.instanceId,
    rootPath: item.rootPath,
    cardId: item.cardId,
    capability: item.capability,
  }), error => error?.code === terminalCode);
  const undone = changeHistoryService.undoChange(
    projectService,
    item.rootPath,
    result.historyEntry.id
  );
  assert.equal(undone.ok, true);
  assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), item.before);
}

console.log('════════ WritCraft V0 · Research committed apply transaction verify ════════');

test('baseline partial apply commits disk/history and atomically exposes one residual child', () => {
  const item = createFixture();
  try {
    const result = item.transaction().apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'applied_partial');
    assert.match(result.changeSetId, /^pc_[a-f0-9]{32}$/);
    assert.notEqual(result.changeSetId, item.capability);
    assert.equal(item.pending.has(item.capability), false);
    assert.equal(item.pending.has(result.changeSetId), true);
    assert.deepStrictEqual(item.store.inspect(item.cardId), {
      state: 'REVIEW',
      retryCount: 0,
      capability: result.changeSetId,
    });
    assert(projectService.readFile(item.rootPath, 'chapters/01.md').includes('已应用：样本增长 20%。'));
    assert.equal(changeHistoryService.listHistory(item.rootPath).length, 1);
    assert.deepStrictEqual(result.historyEntry.provenance, item.pendingRecord.provenance);
  } finally { item.cleanup(); }
});

test('production injection commits Research through durable Changes/History authority', () => {
  const item = createFixture();
  try {
    const durable = changesHistoryTransactionService.createChangesHistoryTransaction({
      projectService,
      historyService: changeHistoryService,
      reviewService: changeSetReviewService,
    });
    let invoked = 0;
    const result = item.transaction({
      executeDecision({
        project,
        pending,
        changeSetId,
        decision,
        decisionOptions,
        residualReviewId,
        onBegin,
      }) {
        invoked += 1;
        return durable.review({
          rootPath: project.rootPath,
          projectId: projectService.openProject(project.rootPath).projectId,
          changeSet: pending.changeSet,
          decision,
          options: {
            ...decisionOptions,
            residualReviewId,
            provenance: pending.provenance,
          },
          onBegin,
        });
      },
    }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assert.equal(invoked, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'applied_partial');
    assert.equal(item.pending.has(item.capability), false);
    const recovery = durable.reconciliation.query(
      item.rootPath,
      projectService.openProject(item.rootPath).projectId
    );
    assert.equal(recovery.recovery.outcome, 'applied');
    assert.equal(changeHistoryService.listHistory(item.rootPath).length, 1);
  } finally { item.cleanup(); }
});

test('post-commit source drift returns authoritative committed warning and STALE terminal state', () => {
  const item = createFixture();
  try {
    const result = item.transaction({
      invalidateDerivedState(changeSetId) {
        item.pending.clearExcept(changeSetId);
        write(item.rootPath, 'references/source.md', '# 官方报告\n来源已被外部修改。\n');
      },
    }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assertCommittedWarning(item, result, 'STALE');
    assert(projectService.readFile(item.rootPath, 'chapters/01.md').includes('已应用：样本增长 20%。'));
  } finally { item.cleanup(); }
});

test('post-commit TTL expiry preserves commit and leaves an expired, non-replayable card', () => {
  const item = createFixture();
  try {
    const result = item.transaction({
      invalidateDerivedState(changeSetId) {
        item.pending.clearExcept(changeSetId);
        item.advanceClock(101);
      },
    }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.residualUnavailable, true);
    assert.equal(item.pending.size, 0);
    assert.equal(item.store.inspect(item.cardId), null);
    assert.throws(() => item.store.resolveCard({
      projectInstanceId: item.project.instanceId,
      rootPath: item.rootPath,
      cardId: item.cardId,
    }), error => error?.code === 'RESEARCH_HANDOFF_EXPIRED');
    assert.equal(changeHistoryService.listHistory(item.rootPath).length, 1);
  } finally { item.cleanup(); }
});

test('residual pending-store put failure cannot turn a committed decision into ok:false', () => {
  const item = createFixture();
  try {
    const failingPending = {
      allocateCapability: item.pending.allocateCapability,
      delete: item.pending.delete,
      clearExcept: item.pending.clearExcept,
      putWithCapability() {
        throw Object.assign(new Error('simulated residual cache failure'), { code: 'CACHE_FAILED' });
      },
    };
    const result = item.transaction({ pendingChangeSets: failingPending }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assertCommittedWarning(item, result);
    assertAppliedTruthAndUndo(item, result);
  } finally { item.cleanup(); }
});

test('failure after real finishApply installed residual settles the exact REVIEW window', () => {
  const item = createFixture();
  try {
    const failingStore = {
      ...item.store,
      finishApply(...args) {
        item.store.finishApply(...args);
        assert.equal(item.store.inspect(item.cardId).state, 'REVIEW');
        throw Object.assign(new Error('simulated finish failure'), { code: 'FINISH_FAILED' });
      },
    };
    const result = item.transaction({ researchHandoffStore: failingStore }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assertCommittedWarning(item, result);
  } finally { item.cleanup(); }
});

test('tree refresh failure removes residual and returns committed warning with tree diagnostics', () => {
  const item = createFixture();
  try {
    const failingProjectService = {
      ...projectService,
      listTree() {
        throw Object.assign(new Error('simulated tree failure'), { code: 'TREE_BROKEN' });
      },
    };
    const result = item.transaction({ projectService: failingProjectService }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assertCommittedWarning(item, result);
    assert.equal(result.treeRefreshRequired, true);
    assert.equal(result.treeError, 'TREE_BROKEN');
  } finally { item.cleanup(); }
});

test('a result getter fault after ok cannot escape the committed-warning boundary', () => {
  const item = createFixture();
  try {
    const getterFaultReviewService = {
      ...changeSetReviewService,
      applyDecision(...args) {
        const result = changeSetReviewService.applyDecision(...args);
        let appliedReads = 0;
        return new Proxy(result, {
          get(target, property, receiver) {
            if (property === 'applied' && ++appliedReads === 2) {
              throw Object.assign(new Error('simulated postcommit result read failure'), {
                code: 'RESULT_READ_FAILED',
              });
            }
            return Reflect.get(target, property, receiver);
          },
        });
      },
    };
    const result = item.transaction({ changeSetReviewService: getterFaultReviewService }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assertCommittedWarning(item, result);
    assertAppliedTruthAndUndo(item, result);
  } finally { item.cleanup(); }
});

test('reject-only residual cache failure preserves review history and writes no manuscript bytes', () => {
  const item = createFixture();
  try {
    const failingPending = {
      allocateCapability: item.pending.allocateCapability,
      delete: item.pending.delete,
      putWithCapability() {
        throw new Error('reject-only residual cache failure');
      },
    };
    const result = item.transaction({ pendingChangeSets: failingPending }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.rejectOnlyDecision(),
    });
    assertCommittedWarning(item, result);
    assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), item.before);
    assert.equal(result.applied.length, 0);
    assert.equal(result.historyEntry.kind, 'review');
  } finally { item.cleanup(); }
});

test('malformed pre-begin and stale pre-apply failures never commit or consume a replayable decision', () => {
  {
    const item = createFixture();
    try {
      assert.throws(() => item.transaction().apply({
        project: item.project,
        pending: item.pendingRecord,
        changeSetId: item.capability,
        decision: { ...item.partialDecision(), injected: true },
      }), error => error?.code === 'INVALID_DECISION');
      assert.equal(item.store.inspect(item.cardId).state, 'REVIEW');
      assert.equal(item.pending.has(item.capability), true);
      assert.equal(changeHistoryService.listHistory(item.rootPath).length, 0);
      assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), item.before);
    } finally { item.cleanup(); }
  }
  {
    const item = createFixture();
    try {
      write(item.rootPath, 'references/source.md', '# 官方报告\npre-apply stale\n');
      assert.throws(() => item.transaction().apply({
        project: item.project,
        pending: item.pendingRecord,
        changeSetId: item.capability,
        decision: item.partialDecision(),
      }), error => error?.code === 'RESEARCH_HANDOFF_STALE');
      assert.equal(item.store.inspect(item.cardId).state, 'STALE');
      assert.equal(changeHistoryService.listHistory(item.rootPath).length, 0);
      assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), item.before);
    } finally { item.cleanup(); }
  }
});

test('applyDecision conflict is precommit STALE with no attributed write or history', () => {
  const item = createFixture();
  try {
    const conflictingReviewService = {
      ...changeSetReviewService,
      applyDecision(service, rootPath, changeSet, decision, options) {
        const current = projectService.readFileWithRevision(rootPath, 'chapters/01.md');
        projectService.atomicWriteFile(rootPath, 'chapters/01.md', '外部并发修改。\n', current.revision);
        return changeSetReviewService.applyDecision(service, rootPath, changeSet, decision, options);
      },
    };
    const result = item.transaction({ changeSetReviewService: conflictingReviewService }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'conflict');
    assert.equal(item.store.inspect(item.cardId).state, 'STALE');
    assert.equal(changeHistoryService.listHistory(item.rootPath).length, 0);
    assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), '外部并发修改。\n');
  } finally { item.cleanup(); }
});

test('applyDecision history failure rolls disk back and terminalizes Research as FAILED', () => {
  const item = createFixture();
  try {
    const failingReviewService = {
      ...changeSetReviewService,
      applyDecision(service, rootPath, changeSet, decision, options) {
        return changeSetReviewService.applyDecision(service, rootPath, changeSet, decision, {
          ...options,
          saveHistory() {
            throw new Error('simulated history failure');
          },
        });
      },
    };
    const result = item.transaction({ changeSetReviewService: failingReviewService }).apply({
      project: item.project,
      pending: item.pendingRecord,
      changeSetId: item.capability,
      decision: item.partialDecision(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'history_failed_rolled_back');
    assert.equal(item.store.inspect(item.cardId).state, 'FAILED');
    assert.equal(changeHistoryService.listHistory(item.rootPath).length, 0);
    assert.equal(projectService.readFile(item.rootPath, 'chapters/01.md'), item.before);
  } finally { item.cleanup(); }
});

console.log(`\n${passed}/${passed} Research committed apply transaction checks passed.\n`);
