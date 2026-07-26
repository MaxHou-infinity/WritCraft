#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Transaction = require('../src/renderer/changes-proposal-transaction');

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function chapterRequest(overrides = {}) {
  return {
    schema: 'writcraft.chapter-generation-request/v1',
    targetPath: 'chapters/one.md',
    instruction: '扩写本章',
    contextPaths: ['references/facts.md'],
    ...overrides,
  };
}

function chapterBinding(request, pendingReview = null, projectInstanceId = 'project-1') {
  return { projectInstanceId, request, pendingReview };
}

async function run() {
  console.log('\nChanges proposal transaction verification');

  await test('accepts only the four explicit proposal modes and a project instance', async () => {
    const state = Transaction.create();
    assert.strictEqual(state.begin('other', 'project-1'), null);
    assert.strictEqual(state.begin('normal', ''), null);
    assert.strictEqual(state.begin('normal', 'project-1').mode, 'normal');
    assert.strictEqual(state.begin('issue', 'project-1').mode, 'issue');
  });

  await test('normal→Plan invalidates the normal result and discards its capability with the origin project', async () => {
    const state = Transaction.create();
    const normal = state.begin('normal', 'project-origin');
    const plan = state.begin('plan', 'project-origin');
    const discarded = [];
    assert.strictEqual(await state.settle(normal, { ok: true, changeSetId: 'pc_normal' }, {
      mode: 'normal', projectInstanceId: 'project-origin',
      discard: async (projectInstanceId, id) => discarded.push([projectInstanceId, id]),
    }), false);
    assert.deepStrictEqual(discarded, [['project-origin', 'pc_normal']]);
    assert.strictEqual(state.isCurrent(plan, 'project-origin', 'plan'), true);
  });

  await test('chapter→Plan invalidates the chapter result and preserves the newer Plan lock', async () => {
    const state = Transaction.create();
    const chapter = state.begin('chapter', 'project-1');
    const plan = state.begin('plan', 'project-1');
    assert.strictEqual(state.finish(chapter, 'project-1'), false, '旧 finally 不得结束新事务');
    assert.strictEqual(state.isCurrent(plan, 'project-1', 'plan'), true);
    const discarded = [];
    await state.settle(chapter, { ok: true, changeSetId: 'pc_chapter' }, {
      mode: 'chapter', projectInstanceId: 'project-1',
      discard: async (origin, id) => discarded.push([origin, id]),
    });
    assert.deepStrictEqual(discarded, [['project-1', 'pc_chapter']]);
    assert.strictEqual(state.isCurrent(plan, 'project-1', 'plan'), true);
  });

  await test('a project switch still discards late capability with the token origin, never the new project', async () => {
    const state = Transaction.create();
    const token = state.begin('normal', 'project-a');
    state.invalidate();
    state.begin('plan', 'project-b');
    const discarded = [];
    assert.strictEqual(await state.settle(token, { ok: true, changeSetId: 'pc_a' }, {
      mode: 'normal', projectInstanceId: 'project-b',
      discard: async (origin, id) => discarded.push([origin, id]),
    }), false);
    assert.deepStrictEqual(discarded, [['project-a', 'pc_a']]);
  });

  await test('only the current token may settle and unlock its own busy epoch', async () => {
    const state = Transaction.create();
    const token = state.begin('plan', 'project-1');
    assert.strictEqual(await state.settle(token, { ok: true, changeSetId: 'pc_plan' }, {
      mode: 'plan', projectInstanceId: 'project-1', discard: async () => assert.fail('current result discarded'),
    }), true);
    assert.strictEqual(state.finish(token, 'project-1'), true);
    assert.strictEqual(state.getActive(), null);
    assert.strictEqual(state.finish(token, 'project-1'), false);
  });

  await test('Chapter refuses to start while Renderer already owns a pending review', async () => {
    const state = Transaction.create();
    const pending = { id: 'pc_existing' };
    assert.strictEqual(Transaction.beginChapter(state, 'project-1', chapterRequest(), pending), null);
    assert.strictEqual(state.getActive(), null);
  });

  await test('Chapter session binds project, target, instruction and ordered context at runtime', async () => {
    for (const current of [
      chapterBinding(chapterRequest(), null, 'project-2'),
      chapterBinding(chapterRequest({ targetPath: 'chapters/two.md' })),
      chapterBinding(chapterRequest({ instruction: '改写本章' })),
      chapterBinding(chapterRequest({ contextPaths: ['references/other.md'] })),
    ]) {
      const state = Transaction.create();
      const session = Transaction.beginChapter(state, 'project-1', chapterRequest(), null);
      assert(session);
      assert.strictEqual(Transaction.isChapterCurrent(state, session, current), false);
    }
  });

  await test('Chapter result classifier dynamically rejects malformed no-op, review and provenance envelopes', async () => {
    const request = chapterRequest();
    const provenance = {
      schema: request.schema,
      kind: 'chapter_generation',
      target: { path: request.targetPath, revision: 'r1' },
      context: [
        { path: 'edit.md', revision: 'edit-r1', role: 'project_prompt' },
        { path: 'references/facts.md', revision: 'context-r1', role: 'context' },
      ],
      generation: {
        strategy: 'planned_blocks',
        planSchema: 'writcraft.chapter-generation-plan/v1',
        blockSchema: 'writcraft.chapter-generation-block/v1',
        blockCount: 1,
      },
    };
    const review = {
      schema: 'writcraft.changes-review/v1',
      changeSetId: 'pc_review',
      selectionPolicy: 'file',
      files: [{ path: request.targetPath, selectionPolicy: 'file', hunks: [] }],
    };
    assert.deepStrictEqual(
      Transaction.classifyChapterResult({ ok: true, noChanges: true, fileCount: 0, provenance }, request),
      { ok: true, kind: 'no_changes', capabilityId: null },
    );
    assert.deepStrictEqual(
      Transaction.classifyChapterResult({
        ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_review', review, provenance,
      }, request),
      { ok: true, kind: 'review', capabilityId: 'pc_review' },
    );
    for (const [label, result, reason] of [
      ['wrong target', { ok: true, noChanges: true, fileCount: 0, provenance: {
        ...provenance, target: { path: 'chapters/two.md', revision: 'r2' },
      } }, 'INVALID_PROVENANCE'],
      ['wrong target with capability', {
        ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_leaked',
        review: { ...review, changeSetId: 'pc_leaked' },
        provenance: { ...provenance, target: { path: 'chapters/two.md', revision: 'r2' } },
      }, 'INVALID_PROVENANCE'],
      ['missing provenance', { ok: true, noChanges: true, fileCount: 0 }, 'INVALID_PROVENANCE'],
      ['no-op capability leak', {
        ok: true, noChanges: true, fileCount: 0, changeSetId: 'pc_leaked', provenance,
      }, 'INVALID_NO_CHANGES'],
      ['no-op review leak', {
        ok: true, noChanges: true, fileCount: 0, review: {}, provenance,
      }, 'INVALID_NO_CHANGES'],
      ['review missing capability', {
        ok: true, noChanges: false, fileCount: 1, review: {}, provenance,
      }, 'INVALID_REVIEW_RESULT'],
      ['review wrong file count', {
        ok: true, noChanges: false, fileCount: 0, changeSetId: 'pc_review', review, provenance,
      }, 'INVALID_REVIEW_RESULT'],
      ['review capability mismatch', {
        ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_outer',
        review: { ...review, changeSetId: 'pc_inner' }, provenance,
      }, 'INVALID_REVIEW_RESULT'],
      ['review target mismatch', {
        ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_review',
        review: { ...review, files: [{ ...review.files[0], path: 'chapters/two.md' }] }, provenance,
      }, 'INVALID_REVIEW_RESULT'],
    ]) {
      const classified = Transaction.classifyChapterResult(result, request);
      assert.strictEqual(classified.ok, false, label);
      assert.strictEqual(classified.reason, reason, label);
      if (result.changeSetId) assert.strictEqual(classified.capabilityId, result.changeSetId, `${label} capability`);
    }
    const inherited = Object.create({
      ok: true, noChanges: true, fileCount: 0, provenance,
    });
    assert.deepStrictEqual(
      Transaction.classifyChapterResult(inherited, request),
      { ok: false, kind: 'invalid', reason: 'INVALID_RESULT' },
    );
    assert.strictEqual(await Transaction.discardChapterCapability(
      async () => ({ ok: true }), 'project-1', 'pc_valid'
    ), true);
    assert.strictEqual(await Transaction.discardChapterCapability(
      async () => ({ ok: false, error: 'CHANGESET_NOT_FOUND' }), 'project-1', 'pc_missing'
    ), true);
    assert.strictEqual(await Transaction.discardChapterCapability(
      async () => ({ ok: false, error: 'IO_FAILURE' }), 'project-1', 'pc_failed'
    ), false);
    assert.strictEqual(await Transaction.discardChapterCapability(
      async () => { throw new Error('offline'); }, 'project-1', 'pc_thrown'
    ), false);
  });

  await test('a pending review arriving during deferred Chapter generation keeps ownership and disposes the late capability', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    const response = deferred();
    let pendingReview = null;
    const discarded = [];
    const settled = response.promise.then(result => Transaction.settleChapter(
      state,
      session,
      result,
      chapterBinding(request, pendingReview),
      { discard: async (origin, id) => { discarded.push([origin, id]); return { ok: true }; } },
    ));
    pendingReview = { id: 'pc_existing' };
    response.resolve({ ok: true, changeSetId: 'pc_late_chapter' });
    assert.strictEqual(await settled, false);
    assert.strictEqual(pendingReview.id, 'pc_existing');
    assert.deepStrictEqual(discarded, [['project-1', 'pc_late_chapter']]);
  });

  await test('a stale Chapter no-op cannot claim or clear a concurrently installed pending review', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    const pendingReview = { id: 'pc_existing' };
    const discarded = [];
    assert.strictEqual(await Transaction.settleChapter(
      state,
      session,
      { ok: true, noChanges: true, fileCount: 0 },
      chapterBinding(request, pendingReview),
      { discard: async (origin, id) => discarded.push([origin, id]) },
    ), false);
    assert.strictEqual(pendingReview.id, 'pc_existing');
    assert.deepStrictEqual(discarded, []);
  });

  await test('a newer Chapter request supersedes an older deferred request without losing the new epoch', async () => {
    const state = Transaction.create();
    const first = Transaction.beginChapter(state, 'project-1', chapterRequest({ instruction: '第一版' }), null);
    const secondRequest = chapterRequest({ instruction: '第二版' });
    const second = Transaction.beginChapter(state, 'project-1', secondRequest, null);
    const discarded = [];
    assert.strictEqual(await Transaction.settleChapter(
      state,
      first,
      { ok: true, changeSetId: 'pc_first' },
      chapterBinding(chapterRequest({ instruction: '第一版' })),
      { discard: async (origin, id) => discarded.push([origin, id]) },
    ), false);
    assert.deepStrictEqual(discarded, [['project-1', 'pc_first']]);
    assert.strictEqual(Transaction.isChapterCurrent(state, second, chapterBinding(secondRequest)), true);
  });

  await test('queueMicrotask after an apparently-current settle preserves a concurrently installed pending no-op owner', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    const existing = { id: 'pc_existing' };
    let pendingReview = null;
    let noOpCommitted = false;
    let settledValue = null;
    const getCurrent = () => chapterBinding(request, pendingReview);
    const flow = (async () => {
      const settled = await Transaction.settleChapter(
        state,
        session,
        { ok: true, noChanges: true, fileCount: 0 },
        getCurrent(),
        { getCurrent, discard: async () => assert.fail('no-op has no capability') },
      );
      settledValue = settled;
      if (!settled || !Transaction.isChapterCurrent(state, session, getCurrent())) return;
      // This is the synchronous ownership check used by finishNoChanges
      // immediately before it is allowed to clear Renderer state.
      if (!Transaction.isChapterCurrent(state, session, getCurrent())) return;
      pendingReview = null;
      noOpCommitted = true;
    })();
    queueMicrotask(() => { pendingReview = existing; });
    await flow;
    assert.strictEqual(settledValue, true, 'queue must land after settle resolved but before its caller resumed');
    assert.strictEqual(noOpCommitted, false);
    assert.strictEqual(pendingReview, existing);
  });

  await test('controlled replacement never renders after project, target, instruction, context or tree drift', async () => {
    const scenarios = [
      ['project', ({ setProject }) => setProject('project-2')],
      ['target', ({ setRequest }) => setRequest(chapterRequest({ targetPath: 'chapters/two.md' }))],
      ['instruction', ({ setRequest }) => setRequest(chapterRequest({ instruction: '换一种写法' }))],
      ['context', ({ setRequest }) => setRequest(chapterRequest({ contextPaths: ['references/other.md'] }))],
      ['tree epoch', ({ state }) => state.invalidate()],
    ];
    for (const [label, drift] of scenarios) {
      const state = Transaction.create();
      const request = chapterRequest();
      const session = Transaction.beginChapter(state, 'project-1', request, null);
      let currentProject = 'project-1';
      let currentRequest = request;
      const getCurrent = () => chapterBinding(currentRequest, null, currentProject);
      const gate = deferred();
      const discarded = [];
      let rendered = 0;
      let failed = 0;
      const transfer = Transaction.replaceChapterReview(state, session, { ok: true, changeSetId: `pc_${label}` }, {
        getCurrent,
        discard: async (origin, id) => { discarded.push([origin, id]); return { ok: true }; },
        prepare: () => ({ review: label }),
        replace: () => gate.promise,
        render: () => { rendered += 1; },
        onFailure: () => { failed += 1; },
      });
      drift({
        state,
        setProject: value => { currentProject = value; },
        setRequest: value => { currentRequest = value; },
      });
      gate.resolve({ ok: true, previousDiscarded: false });
      const outcome = await transfer;
      assert.strictEqual(outcome.stale, true, `${label} must be stale`);
      assert.strictEqual(rendered, 0, `${label} rendered`);
      assert.strictEqual(failed, 0, `${label} overwrote current status`);
      assert.deepStrictEqual(discarded, [['project-1', `pc_${label}`]], `${label} used wrong discard origin`);
    }
  });

  await test('a controlled pending ownership change during review replacement cannot render or overwrite status', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    let pendingReview = null;
    const getCurrent = () => chapterBinding(request, pendingReview);
    const gate = deferred();
    const discarded = [];
    let rendered = 0;
    let failed = 0;
    const transfer = Transaction.replaceChapterReview(state, session, { ok: true, changeSetId: 'pc_candidate' }, {
      getCurrent,
      discard: async (origin, id) => { discarded.push([origin, id]); return { ok: true }; },
      prepare: () => ({ review: true }),
      replace: () => gate.promise,
      render: () => { rendered += 1; },
      onFailure: () => { failed += 1; },
    });
    pendingReview = { id: 'pc_existing' };
    gate.resolve({ ok: true, previousDiscarded: false });
    assert.strictEqual((await transfer).stale, true);
    assert.strictEqual(pendingReview.id, 'pc_existing');
    assert.strictEqual(rendered, 0);
    assert.strictEqual(failed, 0);
    assert.deepStrictEqual(discarded, [['project-1', 'pc_candidate']]);
  });

  await test('an invalid Chapter review is discarded and never rendered', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    const discarded = [];
    let rendered = 0;
    let failure = null;
    const outcome = await Transaction.replaceChapterReview(
      state,
      session,
      { ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_invalid', review: {} },
      {
        getCurrent: () => chapterBinding(request),
        discard: async (origin, id) => { discarded.push([origin, id]); return { ok: true }; },
        prepare: () => null,
        replace: async () => assert.fail('invalid review must not enter replacement'),
        render: () => { rendered += 1; },
        onFailure: reason => { failure = reason; },
      },
    );
    assert.deepStrictEqual(outcome, { ok: false, stale: false, reason: 'INVALID_REVIEW' });
    assert.deepStrictEqual(discarded, [['project-1', 'pc_invalid']]);
    assert.strictEqual(rendered, 0);
    assert.strictEqual(failure, 'INVALID_REVIEW');
  });

  await test('an invalid Chapter review reports unacknowledged cleanup and never claims safe cancellation', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    let rendered = 0;
    let failure = null;
    const outcome = await Transaction.replaceChapterReview(
      state,
      session,
      { ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_cleanup_failed', review: {} },
      {
        getCurrent: () => chapterBinding(request),
        discard: async () => ({ ok: false, error: 'IO_FAILURE' }),
        prepare: () => null,
        render: () => { rendered += 1; },
        onFailure: reason => { failure = reason; },
      },
    );
    assert.deepStrictEqual(outcome, { ok: false, stale: false, reason: 'DISCARD_FAILED' });
    assert.strictEqual(rendered, 0);
    assert.strictEqual(failure, 'DISCARD_FAILED');
  });

  await test('ownership drift after acknowledged invalid-review cleanup never discards the same capability twice', async () => {
    const state = Transaction.create();
    const request = chapterRequest();
    const session = Transaction.beginChapter(state, 'project-1', request, null);
    const gate = deferred();
    let pendingReview = null;
    let discardCalls = 0;
    const outcomePromise = Transaction.replaceChapterReview(
      state,
      session,
      { ok: true, noChanges: false, fileCount: 1, changeSetId: 'pc_single_release', review: {} },
      {
        getCurrent: () => chapterBinding(request, pendingReview),
        discard: async () => {
          discardCalls += 1;
          await gate.promise;
          return { ok: true };
        },
        prepare: () => null,
      },
    );
    pendingReview = { id: 'pc_new_owner' };
    gate.resolve();
    const outcome = await outcomePromise;
    assert.deepStrictEqual(outcome, { ok: false, stale: true, reason: 'STALE_CHAPTER_RESULT' });
    assert.strictEqual(discardCalls, 1);
    assert.strictEqual(pendingReview.id, 'pc_new_owner');
  });

  await test('an old finally cannot release busy state or reset the button owned by a newer Chapter', async () => {
    const state = Transaction.create();
    const old = Transaction.beginChapter(state, 'project-1', chapterRequest({ instruction: '旧请求' }), null);
    const currentRequest = chapterRequest({ instruction: '新请求' });
    const current = Transaction.beginChapter(state, 'project-1', currentRequest, null);
    const finish = Transaction.finishChapter(state, old, 'project-1');
    assert.deepStrictEqual(finish, { finished: false, releaseBusy: false, resetButton: false });
    assert.strictEqual(Transaction.isChapterCurrent(state, current, chapterBinding(currentRequest)), true);
  });

  await test('superseding releases the old origin capability before Renderer transfers ownership', async () => {
    const calls = [];
    const result = await Transaction.supersede(
      { id: 'pc_old', projectInstanceId: 'project-old' },
      { id: 'pc_new', projectInstanceId: 'project-new' },
      { discard: async (origin, id) => { calls.push([origin, id]); return { ok: true }; } },
    );
    assert.deepStrictEqual(result, { ok: true, previousDiscarded: true });
    assert.deepStrictEqual(calls, [['project-old', 'pc_old']]);
  });

  await test('a hard old-discard failure cancels the new capability and preserves previous ownership', async () => {
    const calls = [];
    const result = await Transaction.supersede(
      { id: 'pc_old', projectInstanceId: 'project-1' },
      { id: 'pc_new', projectInstanceId: 'project-1' },
      { discard: async (origin, id) => {
        calls.push([origin, id]);
        return id === 'pc_old' ? { ok: false, error: 'IO_FAILURE' } : { ok: true };
      } },
    );
    assert.deepStrictEqual(result, { ok: false, previousDiscarded: false, error: 'IO_FAILURE' });
    assert.deepStrictEqual(calls, [['project-1', 'pc_old'], ['project-1', 'pc_new']]);
  });

  await test('explicit Plan detach invalidates handoff and disposes its late capability', async () => {
    const state = Transaction.create();
    const plan = state.begin('plan', 'project-1');
    state.invalidate();
    const discarded = [];
    assert.strictEqual(await state.settle(plan, { ok: true, changeSetId: 'pc_late_plan' }, {
      mode: 'plan', projectInstanceId: 'project-1',
      discard: async (origin, id) => discarded.push([origin, id]),
    }), false);
    assert.deepStrictEqual(discarded, [['project-1', 'pc_late_plan']]);
  });

  await test('Graph Issue handoff shares the proposal epoch and supersedes a late normal result', async () => {
    const state = Transaction.create();
    const normal = state.begin('normal', 'project-1');
    const issue = state.begin('issue', 'project-1');
    const discarded = [];
    assert.strictEqual(await state.settle(normal, { ok: true, changeSetId: 'pc_late_normal' }, {
      mode: 'normal', projectInstanceId: 'project-1',
      discard: async (origin, id) => discarded.push([origin, id]),
    }), false);
    assert.deepStrictEqual(discarded, [['project-1', 'pc_late_normal']]);
    assert.strictEqual(state.isCurrent(issue, 'project-1', 'issue'), true);
  });

  await test('Changes view gates all modes and exits completed Plan state after the first accepted write', async () => {
    const view = fs.readFileSync(path.join(__dirname, '../src/renderer/changes-view.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    for (const mode of ['normal', 'plan', 'issue']) {
      assert(view.includes(`proposalTransactions?.begin('${mode}'`), `${mode} does not share proposal gate`);
    }
    assert(view.includes('WritCraftChangesProposalTransaction?.beginChapter?.('));
    assert(view.includes('WritCraftChangesProposalTransaction.settleChapter('));
    assert(view.includes('WritCraftChangesProposalTransaction.releaseStaleChapterResult('));
    assert(view.includes('WritCraftChangesProposalTransaction.replaceChapterReview('));
    assert(view.includes('WritCraftChangesProposalTransaction.finishChapter('));
    assert(view.includes("if (pending) return setStatus('当前还有待审阅 Changes；请先应用或丢弃，再生成当前章节。', true)"));
    assert(view.includes('discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId)'));
    assert(view.includes('if (proposalTransactions.finish(transaction, window.__workspace?.state?.project?.instanceId || null)) setBusy(false)'));
    assert(view.includes('const completedPlan = appliedCount > 0 && completePlanModeAfterWrite()'));
    assert(view.includes('原 Plan 已完成'));
    assert(view.includes("recordChangeMetric('discarded', previous?.metric)"));
    assert(view.indexOf("recordChangeMetric('discarded', previous?.metric)") < view.indexOf('renderChangeSet(result, metric, candidateReviewState)', view.indexOf('async function replaceGeneratedReview')));
    assert((view.match(/if \(!result\?\.ok\)/g) || []).length >= 3, 'failed generation must return before replacement');
    assert(view.includes('if (planModeLeaveButton) planModeLeaveButton.disabled = reviewCommitInFlight'));
    assert(view.includes('if (reviewCommitInFlight || !activePlanRequest) return'));
    assert(html.indexOf('changes-proposal-transaction.js') < html.indexOf('changes-view.js'));
  });

  console.log(`\nChanges proposal transaction ${passed}/${passed} passed.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
