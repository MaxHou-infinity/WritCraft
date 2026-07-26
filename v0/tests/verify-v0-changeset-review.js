'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const changeHistoryService = require('../src/main/change-history-service');
const {
  REVIEW_SCHEMA,
  DECISION_SCHEMA,
  createReview,
  validateDecision,
  resolveDecision,
  applyDecision,
} = require('../src/main/changeset-review-service');

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

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-hunk-review-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content, 'utf8');
  }
  return root;
}

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeLongText(prefix) {
  return Array.from({ length: 30 }, (_, index) => `${prefix} line ${index + 1}`).join('\n') + '\n';
}

function changedAt(content, updates) {
  const lines = content.replace(/\n$/, '').split('\n');
  for (const [index, value] of updates) lines[index] = value;
  return lines.join('\n') + '\n';
}

function makeChangeSet(root, afterByPath) {
  const snapshots = Object.keys(afterByPath).map(filePath => ({
    path: filePath,
    ...projectService.readFileWithRevision(root, filePath),
  }));
  return changeSetService.createChangeSet(snapshots, snapshots.map(file => ({
    path: file.path,
    after: afterByPath[file.path],
    summary: `更新 ${file.path}`,
  })));
}

function decision(review, acceptHunkIds = [], rejectHunkIds = []) {
  return {
    schema: DECISION_SCHEMA,
    changeSetId: review.changeSetId,
    acceptHunkIds,
    rejectHunkIds,
  };
}

function researchProvenance(targetPath, targetRevision) {
  return {
    schema: 'writcraft.research-handoff/v1',
    kind: 'research_card',
    runId: `rr_${'1'.repeat(24)}`,
    cardId: `rc_${'2'.repeat(32)}`,
    bindingDigest: `sha256:${'3'.repeat(64)}`,
    expiresAt: 1_900_000_000_000,
    evidence: {
      sourceId: `src_${'4'.repeat(20)}`,
      path: 'references/source.md',
      revision: '5'.repeat(64),
      locator: { offset: 0, end: 12, line: 1, column: 1 },
      grade: 'A',
      gradeRule: 'first_party_primary',
      quoteDigest: `sha256:${'6'.repeat(64)}`,
      quoteExcerpt: '公开引文',
    },
    targets: [{ path: targetPath, revision: targetRevision }],
  };
}

console.log('\nChangeSet hunk-review service verification');

test('publishes structured Main-owned hunks with every decision pending by default', () => {
  const root = makeProject({ 'chapter.md': makeLongText('A') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, '中文改写 😀'], [25, '尾段改写']]) });
    const review = createReview(set);
    assert.strictEqual(review.schema, REVIEW_SCHEMA);
    assert.strictEqual(review.selectionPolicy, 'hunk');
    assert.strictEqual(review.totalHunks, 2);
    assert.strictEqual(review.files[0].hunks.length, 2);
    assert(review.files[0].hunks.every(hunk => /^hk_[a-f0-9]{24}$/.test(hunk.id)));
    assert(review.files[0].hunks.every(hunk => hunk.lines.every(line =>
      ['context', 'add', 'remove', 'meta'].includes(line.kind) && typeof line.text === 'string')));
    assert(!JSON.stringify(review).includes('acceptHunkIds'));
    assert(!JSON.stringify(review).includes('rejectHunkIds'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('enforces the 4 MiB limit on the final review object, including policy metadata', () => {
  const size = 2_096_950;
  const before = 'a'.repeat(size);
  const after = 'b'.repeat(size);
  const set = changeSetService.createChangeSet(
    [{ path: 'large.md', content: before, revision: revision(before) }],
    [{ path: 'large.md', after, summary: '接近审阅载荷边界' }],
  );
  assert.doesNotThrow(() => changeSetService.preview(set, { structured: true }));
  expectCode('REVIEW_TOO_LARGE', () => createReview(set));
});

test('rejects decision smuggling, overlap, stale sessions, unknown IDs and empty decisions', () => {
  const root = makeProject({ 'chapter.md': makeLongText('B') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, 'first'], [25, 'second']]) });
    const review = createReview(set);
    const first = review.files[0].hunks[0].id;
    expectCode('INVALID_DECISION', () => validateDecision(set, {
      ...decision(review, [first], []), path: 'chapter.md',
    }));
    expectCode('NO_DECISIONS', () => validateDecision(set, decision(review)));
    expectCode('DECISION_OVERLAP', () => validateDecision(set, decision(review, [first], [first])));
    expectCode('DUPLICATE_HUNK', () => validateDecision(set, decision(review, [first, first], [])));
    expectCode('STALE_CHANGESET', () => validateDecision(set, {
      ...decision(review, [first], []), changeSetId: `cs_${'0'.repeat(24)}`,
    }));
    expectCode('HUNK_NOT_FOUND', () => validateDecision(set, decision(review, [`hk_${'0'.repeat(24)}`], [])));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('binds Renderer decisions to one-time pending handles without persisting the capability in audit IDs', () => {
  const root = makeProject({ 'chapter.md': makeLongText('Capability') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, 'first'], [25, 'pending']]) });
    const handle = `pc_${'1'.repeat(32)}`;
    const nextHandle = `pc_${'2'.repeat(32)}`;
    const review = createReview(set, { reviewId: handle });
    assert.strictEqual(review.changeSetId, handle);
    const first = review.files[0].hunks[0].id;
    expectCode('RESIDUAL_REVIEW_ID_REQUIRED', () => applyDecision(
      projectService, root, set, decision(review, [first], []), { reviewId: handle },
    ));
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);
    assert.strictEqual(changeHistoryService.listHistory(root).length, 0);
    expectCode('RESIDUAL_REVIEW_ID_REUSED', () => resolveDecision(
      set, decision(review, [first], []), { reviewId: handle, residualReviewId: handle },
    ));
    const resolved = resolveDecision(set, decision(review, [first], []), {
      reviewId: handle,
      residualReviewId: nextHandle,
    });
    assert.strictEqual(resolved.sourceChangeSetId, set.id);
    assert.strictEqual(resolved.review.changeSetId, nextHandle);
    expectCode('STALE_CHANGESET', () => validateDecision(resolved.residualChangeSet, {
      ...decision(resolved.review, [resolved.review.files[0].hunks[0].id], []),
      changeSetId: handle,
    }, { reviewId: nextHandle }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolves accept/reject/pending into an accepted batch and revision-bound residual review', () => {
  const root = makeProject({ 'chapter.md': makeLongText('C') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const proposed = changedAt(before, [[1, 'accepted edit'], [14, 'rejected edit'], [27, 'pending edit']]);
    const set = makeChangeSet(root, { 'chapter.md': proposed });
    const review = createReview(set);
    assert.strictEqual(review.totalHunks, 3);
    const [accept, reject, pending] = review.files[0].hunks.map(hunk => hunk.id);
    const resolved = resolveDecision(set, decision(review, [accept], [reject]));
    const accepted = resolved.acceptedChangeSet.changes[0];
    assert(accepted.after.includes('accepted edit'));
    assert(!accepted.after.includes('rejected edit'));
    assert(!accepted.after.includes('pending edit'));
    assert.strictEqual(resolved.pendingHunkIds[0], pending);
    const residual = resolved.residualChangeSet.changes[0];
    assert.strictEqual(residual.before, accepted.after);
    assert.strictEqual(residual.expectedRevision, revision(accepted.after));
    assert(residual.after.includes('accepted edit'));
    assert(!residual.after.includes('rejected edit'));
    assert(residual.after.includes('pending edit'));
    assert.strictEqual(resolved.review.totalHunks, 1);
    assert.notStrictEqual(resolved.review.files[0].hunks[0].id, pending);

    expectCode('STALE_CHANGESET', () => resolveDecision(resolved.residualChangeSet, decision(review, [accept], [])));
    expectCode('HUNK_NOT_FOUND', () => resolveDecision(resolved.residualChangeSet, {
      ...decision(resolved.review, [accept], []),
    }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Graph Issue review requires a decision for every hunk before any write or history effect', () => {
  const root = makeProject({ 'chapter.md': makeLongText('Issue') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const proposed = changedAt(before, [[1, 'accepted issue edit'], [25, 'still pending issue edit']]);
    const set = makeChangeSet(root, { 'chapter.md': proposed });
    const review = createReview(set, { reviewId: `pc_${'9'.repeat(32)}` });
    const [first, second] = review.files[0].hunks.map(hunk => hunk.id);
    let historyCalls = 0;
    const historyService = {
      applyAndRecord() { historyCalls += 1; throw new Error('must not write'); },
      recordReviewDecision() { historyCalls += 1; throw new Error('must not write'); },
    };
    expectCode('ISSUE_REVIEW_INCOMPLETE', () => applyDecision(
      projectService,
      root,
      set,
      decision(review, [first], []),
      { reviewId: review.changeSetId, requireCompleteDecision: true, historyService },
    ));
    expectCode('ISSUE_REVIEW_INCOMPLETE', () => applyDecision(
      projectService,
      root,
      set,
      decision(review),
      { reviewId: review.changeSetId, requireCompleteDecision: true, historyService },
    ));
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);
    assert.strictEqual(historyCalls, 0);
    const complete = resolveDecision(set, decision(review, [first], [second]), {
      reviewId: review.changeSetId,
      requireCompleteDecision: true,
    });
    assert.strictEqual(complete.pendingHunkIds.length, 0);
    assert.strictEqual(complete.residualChangeSet, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applies reverse-ordered accepted IDs in authoritative document order', () => {
  const root = makeProject({ 'chapter.md': makeLongText('Order') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const proposed = changedAt(before, [[1, 'FIRST'], [14, 'MIDDLE'], [27, 'LAST']]);
    const set = makeChangeSet(root, { 'chapter.md': proposed });
    const review = createReview(set);
    const [first, middle, last] = review.files[0].hunks.map(hunk => hunk.id);
    const result = applyDecision(projectService, root, set, decision(review, [last, first], [middle]));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'completed');
    const expected = changedAt(before, [[1, 'FIRST'], [27, 'LAST']]);
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), expected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('enforces whole-file policy in Main even when IDs are otherwise valid', () => {
  const root = makeProject({ 'edit.md': makeLongText('Prompt') });
  try {
    const before = projectService.readFile(root, 'edit.md');
    const set = makeChangeSet(root, { 'edit.md': changedAt(before, [[1, 'one'], [25, 'two']]) });
    const review = createReview(set, { selectionPolicy: 'file' });
    const ids = review.files[0].hunks.map(hunk => hunk.id);
    expectCode('PARTIAL_SELECTION_FORBIDDEN', () => resolveDecision(
      set, decision(review, [ids[0]], []), { selectionPolicy: 'file' },
    ));
    expectCode('PARTIAL_SELECTION_FORBIDDEN', () => resolveDecision(
      set, decision(review, [], [ids[0]]), { selectionPolicy: 'file' },
    ));
    assert.strictEqual(resolveDecision(
      set, decision(review, ids, []), { selectionPolicy: 'file' },
    ).residualChangeSet, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('supports Main-owned per-file policy so edit.md stays atomic in a mixed ChangeSet', () => {
  const root = makeProject({ 'edit.md': makeLongText('Prompt'), 'chapter.md': makeLongText('Body') });
  try {
    const editBefore = projectService.readFile(root, 'edit.md');
    const bodyBefore = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, {
      'edit.md': changedAt(editBefore, [[1, 'prompt one'], [25, 'prompt two']]),
      'chapter.md': changedAt(bodyBefore, [[1, 'body one'], [25, 'body two']]),
    });
    const options = { fileSelectionPolicies: { 'edit.md': 'file' } };
    const review = createReview(set, options);
    assert.strictEqual(review.selectionPolicy, 'mixed');
    const edit = review.files.find(file => file.path === 'edit.md');
    const body = review.files.find(file => file.path === 'chapter.md');
    assert.strictEqual(edit.selectionPolicy, 'file');
    assert.strictEqual(body.selectionPolicy, 'hunk');
    expectCode('PARTIAL_SELECTION_FORBIDDEN', () => resolveDecision(
      set, decision(review, [edit.hunks[0].id], []), options,
    ));
    const bodyPartial = resolveDecision(set, decision(review, [body.hunks[0].id], []), options);
    assert(bodyPartial.acceptedChangeSet.changes[0].path === 'chapter.md');
    assert.strictEqual(bodyPartial.review.files.find(file => file.path === 'edit.md').selectionPolicy, 'file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('applies accepted hunks, audits them, retains residual work, and supports ordered undo', () => {
  const root = makeProject({ 'chapter.md': makeLongText('D') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, 'batch one'], [25, 'batch two']]) });
    const review = createReview(set);
    const [firstId] = review.files[0].hunks.map(hunk => hunk.id);
    const first = applyDecision(projectService, root, set, decision(review, [firstId], []));
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.status, 'applied_partial');
    assert.strictEqual(first.remainingHunkCount, 1);
    assert(projectService.readFile(root, 'chapter.md').includes('batch one'));
    assert(!projectService.readFile(root, 'chapter.md').includes('batch two'));
    assert.strictEqual(first.historyEntry.review.acceptedHunkIds[0], firstId);
    assert.strictEqual(first.historyEntry.kind, 'application');

    const secondId = first.review.files[0].hunks[0].id;
    const second = applyDecision(
      projectService, root, first.residualChangeSet, decision(first.review, [secondId], []),
    );
    assert.strictEqual(second.status, 'completed');
    assert(projectService.readFile(root, 'chapter.md').includes('batch two'));
    const history = changeHistoryService.listHistory(root);
    assert.strictEqual(history.length, 2);

    const undoSecond = changeHistoryService.undoChange(projectService, root, second.historyEntry.id);
    assert.strictEqual(undoSecond.ok, true);
    assert(projectService.readFile(root, 'chapter.md').includes('batch one'));
    assert(!projectService.readFile(root, 'chapter.md').includes('batch two'));
    const undoFirst = changeHistoryService.undoChange(projectService, root, first.historyEntry.id);
    assert.strictEqual(undoFirst.ok, true);
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reject-only decisions write no manuscript bytes but atomically update review and audit', () => {
  const root = makeProject({ 'chapter.md': makeLongText('E') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, 'reject me'], [25, 'keep pending']]) });
    const review = createReview(set);
    const result = applyDecision(projectService, root, set, decision(review, [], [review.files[0].hunks[0].id]));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'review_updated');
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);
    assert.strictEqual(result.review.totalHunks, 1);
    assert.strictEqual(result.historyEntry.kind, 'review');
    assert.strictEqual(result.historyEntry.files.length, 0);
    assert.strictEqual(changeHistoryService.listHistory(root)[0].review.rejectedHunkIds.length, 1);
    expectCode('HISTORY_NOT_UNDOABLE', () => changeHistoryService.undoChange(
      projectService, root, result.historyEntry.id,
    ));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('persists the same Research provenance for accepted and reject-only decisions', () => {
  for (const mode of ['accept', 'reject']) {
    const root = makeProject({ 'chapter.md': makeLongText(`Research-${mode}`) });
    try {
      const before = projectService.readFile(root, 'chapter.md');
      const snapshot = projectService.readFileWithRevision(root, 'chapter.md');
      const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, `${mode} research edit`]]) });
      const review = createReview(set);
      const hunkId = review.files[0].hunks[0].id;
      const provenance = researchProvenance('chapter.md', snapshot.revision);
      const result = applyDecision(
        projectService,
        root,
        set,
        decision(review, mode === 'accept' ? [hunkId] : [], mode === 'reject' ? [hunkId] : []),
        { provenance },
      );
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.historyEntry.provenance, provenance);
      assert.deepStrictEqual(changeHistoryService.listHistory(root)[0].provenance, provenance);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('conflict in one accepted file prevents every file write and leaves the review unconsumed', () => {
  const root = makeProject({ 'a.md': makeLongText('F-A'), 'b.md': makeLongText('F-B') });
  try {
    const beforeA = projectService.readFile(root, 'a.md');
    const beforeB = projectService.readFile(root, 'b.md');
    const set = makeChangeSet(root, {
      'a.md': changedAt(beforeA, [[1, 'accepted A']]),
      'b.md': changedAt(beforeB, [[1, 'accepted B']]),
    });
    const review = createReview(set);
    const ids = review.files.flatMap(file => file.hunks.map(hunk => hunk.id));
    const currentB = projectService.readFileWithRevision(root, 'b.md');
    projectService.atomicWriteFile(root, 'b.md', 'external B\n', currentB.revision);
    const result = applyDecision(projectService, root, set, decision(review, ids, []));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(result.consumed, false);
    assert.strictEqual(projectService.readFile(root, 'a.md'), beforeA);
    assert.strictEqual(projectService.readFile(root, 'b.md'), 'external B\n');
    assert.strictEqual(changeHistoryService.listHistory(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('history failures roll back accepted bytes and do not consume accepted or rejected decisions', () => {
  const root = makeProject({ 'chapter.md': makeLongText('G') });
  try {
    const before = projectService.readFile(root, 'chapter.md');
    const set = makeChangeSet(root, { 'chapter.md': changedAt(before, [[1, 'accept'], [25, 'reject']]) });
    const review = createReview(set);
    const [acceptId, rejectId] = review.files[0].hunks.map(hunk => hunk.id);
    const applied = applyDecision(projectService, root, set, decision(review, [acceptId], [rejectId]), {
      saveHistory() { throw new Error('simulated history failure'); },
    });
    assert.strictEqual(applied.ok, false);
    assert.strictEqual(applied.status, 'history_failed_rolled_back');
    assert.strictEqual(applied.consumed, false);
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);

    const rejected = applyDecision(projectService, root, set, decision(review, [], [rejectId]), {
      saveHistory() { throw new Error('simulated decision audit failure'); },
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.status, 'history_failed');
    assert.strictEqual(rejected.consumed, false);
    assert.strictEqual(projectService.readFile(root, 'chapter.md'), before);
    assert.strictEqual(changeHistoryService.listHistory(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accepted-content validation runs before disk or history mutation', () => {
  const root = makeProject({ 'edit.md': makeLongText('H') });
  try {
    const before = projectService.readFile(root, 'edit.md');
    const set = makeChangeSet(root, { 'edit.md': changedAt(before, [[1, 'schema-breaking proposal']]) });
    const review = createReview(set, { selectionPolicy: 'file' });
    let validated = 0;
    assert.throws(() => applyDecision(
      projectService,
      root,
      set,
      decision(review, review.files[0].hunks.map(hunk => hunk.id), []),
      {
        selectionPolicy: 'file',
        validateAcceptedChangeSet() {
          validated += 1;
          throw Object.assign(new Error('invalid edit prompt'), { code: 'EDIT_PROMPT_INVALID' });
        },
      },
    ), error => error.code === 'EDIT_PROMPT_INVALID');
    assert.strictEqual(validated, 1);
    assert.strictEqual(projectService.readFile(root, 'edit.md'), before);
    assert.strictEqual(changeHistoryService.listHistory(root).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed}/${passed} ChangeSet hunk-review checks passed.\n`);
