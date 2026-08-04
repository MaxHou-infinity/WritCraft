'use strict';

const assert = require('assert');
const service = require('../src/main/ai-task-state-service');

let now = 1_000;
let nextTimer = 1;
const timers = new Map();
const updates = [];
const taskState = service.createAiTaskStateService({
  clock: () => now,
  setTimer(callback, delay) {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimer(id) { timers.delete(id); },
  onUpdate(snapshot) { updates.push(snapshot); },
});

function fireTimer(id) {
  const timer = timers.get(id);
  assert(timer, `timer ${id} should exist`);
  timers.delete(id);
  timer.callback();
}

function expectCode(code, fn) {
  assert.throws(fn, error => error?.code === code, `应拒绝为 ${code}`);
}

console.log('\nAI task state service verification');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

const base = {
  projectInstanceId: 'instance_0123456789abcdef01234567',
  kind: 'navigation_action',
  targetLocator: { kind: 'suggestion', navigationId: 'nav_123', suggestionId: 'suggestion_1' },
  inputRevision: 'rev_abc123',
  ownerToken: 'owner_internal_1',
  attemptId: 'wno_0123456789abcdef0123456789abcdef',
};

test('starts with an opaque identity and a Main-owned preparing phase', () => {
  const task = taskState.begin(base);
  const snapshot = task.snapshot();
  assert.match(snapshot.taskId, /^ait_[a-f0-9]{32}$/);
  assert.strictEqual(snapshot.attemptId, base.attemptId);
  assert.strictEqual(snapshot.projectInstanceId, base.projectInstanceId);
  assert.deepStrictEqual(snapshot.targetLocator, base.targetLocator);
  assert.strictEqual(snapshot.inputRevision, base.inputRevision);
  assert.strictEqual(snapshot.phase, 'preparing_context');
  assert.strictEqual(snapshot.status, 'running');
  assert.strictEqual(snapshot.canCancel, false);
  assert.strictEqual('ownerToken' in snapshot, false);
  assert.strictEqual(updates.at(-1).schema, service.SCHEMA);
  task.phase('checking_evidence');
  assert.strictEqual(task.snapshot().phase, 'checking_evidence');
  task.phase('generating_suggestion');
  assert.strictEqual(task.snapshot().phase, 'generating_suggestion');
  task.complete('review');
  assert.strictEqual(task.snapshot().status, 'review');
  assert.strictEqual(task.snapshot().phase, 'waiting_review');
  assert.strictEqual(task.signal.aborted, true);
});

test('publishes cancel availability at 15 seconds and cancellation is zero-write', () => {
  const task = taskState.begin({ ...base, attemptId: 'wno_11111111111111111111111111111111' });
  const timerIds = [...timers.keys()];
  const cancelTimer = timerIds.find(id => timers.get(id).delay === service.DEFAULT_CANCEL_AFTER_MS);
  fireTimer(cancelTimer);
  assert.strictEqual(task.snapshot().canCancel, true);
  const cancelled = task.cancel();
  assert.strictEqual(cancelled.status, 'cancelled');
  assert.strictEqual(cancelled.phase, 'cancelled');
  assert.strictEqual(cancelled.code, 'REQUEST_ABORTED');
  assert.strictEqual(task.signal.aborted, true);
  expectCode('AI_TASK_NOT_ACTIVE', () => task.cancel());
});

test('60 second hard timeout aborts the request and emits a retryable terminal', () => {
  now += service.DEFAULT_TIMEOUT_MS;
  const task = taskState.begin({ ...base, attemptId: 'wno_22222222222222222222222222222222' });
  const timeoutTimer = [...timers.keys()].find(id => timers.get(id).delay === service.DEFAULT_TIMEOUT_MS);
  fireTimer(timeoutTimer);
  const snapshot = task.snapshot();
  assert.strictEqual(snapshot.status, 'timed_out');
  assert.strictEqual(snapshot.phase, 'timed_out');
  assert.strictEqual(snapshot.code, 'TIMEOUT');
  assert.strictEqual(snapshot.canCancel, false);
  assert.strictEqual(task.signal.aborted, true);
});

test('owner, project, revision and stale result boundaries fail closed', () => {
  const task = taskState.begin({ ...base, attemptId: 'wno_33333333333333333333333333333333' });
  expectCode('AI_TASK_NOT_OWNER', () => taskState.assertCurrent({
    taskId: task.taskId,
    attemptId: task.attemptId,
    ownerToken: 'different_owner',
  }));
  expectCode('INVALID_AI_TASK', () => taskState.begin({
    ...base, attemptId: 'wno_44444444444444444444444444444444', targetLocator: ['not-an-object'],
  }));
  taskState.invalidateProject(base.projectInstanceId);
  assert.strictEqual(task.snapshot().status, 'stale');
  expectCode('AI_TASK_NOT_ACTIVE', () => task.phase('checking_evidence'));
});

test('cancelByAttempt only cancels the matching project and attempt', () => {
  const task = taskState.begin({ ...base, attemptId: 'wno_55555555555555555555555555555555' });
  const result = taskState.cancelByAttempt({
    projectInstanceId: base.projectInstanceId,
    attemptId: 'wno_55555555555555555555555555555555',
  });
  assert.strictEqual(result.taskId, task.taskId);
  assert.strictEqual(result.status, 'cancelled');
  expectCode('AI_TASK_NOT_ACTIVE', () => taskState.cancelByAttempt({
    projectInstanceId: base.projectInstanceId,
    attemptId: 'wno_55555555555555555555555555555555',
  }));
});

test('rejects malformed identity and unknown task transitions', () => {
  expectCode('INVALID_AI_TASK', () => taskState.begin({ ...base, projectInstanceId: '' }));
  expectCode('INVALID_AI_TASK', () => taskState.get('bad_task'));
  expectCode('AI_TASK_NOT_FOUND', () => taskState.get('ait_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
});

test('distinguishes a completed non-writing task from a reviewable preview', () => {
  const task = taskState.begin({ ...base, attemptId: 'wno_66666666666666666666666666666666' });
  const completed = task.complete('completed');
  assert.strictEqual(completed.status, 'completed');
  assert.strictEqual(completed.phase, 'completed');
  assert.strictEqual(completed.code, undefined);
});

console.log(`\n${passed}/${passed} AI task state checks passed.`);
