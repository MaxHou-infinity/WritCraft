'use strict';

const assert = require('assert');
const {
  createLocalOperationService,
  PROGRESS_AFTER_MS,
  CANCEL_AFTER_MS,
  DEADLINES,
} = require('../src/main/local-operation-service');

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

function harness() {
  let now = Date.parse('2026-08-06T00:00:00.000Z');
  let random = 0;
  let nextTimer = 1;
  const timers = new Map();
  const updates = [];
  const service = createLocalOperationService({
    clock: () => now,
    randomBytes: size => Buffer.alloc(size, ++random),
    setTimer(callback, delay) {
      const timer = { id: nextTimer++, at: now + delay, callback, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timers.delete(timer.id);
    },
    onUpdate: value => updates.push(value),
  });
  function advance(milliseconds) {
    now += milliseconds;
    while (true) {
      const due = [...timers.values()]
        .filter(timer => timer.at <= now)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      timers.delete(due.id);
      due.callback();
    }
  }
  return { service, updates, advance, timers };
}

const projectInstanceId = `instance_${'a'.repeat(24)}`;

console.log('WritCraft 0.4.0 local operation service tests');

test('emits queued, running, two-second progress and ten-second cancel authority', () => {
  const state = harness();
  const handle = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 1,
  });
  assert.strictEqual(handle.snapshot().status, 'queued');
  handle.start();
  handle.stage('settling_watcher');
  state.advance(PROGRESS_AFTER_MS);
  assert.strictEqual(state.updates.at(-1).elapsedMs, PROGRESS_AFTER_MS);
  assert.strictEqual(state.updates.at(-1).cancelAvailable, false);
  state.advance(CANCEL_AFTER_MS - PROGRESS_AFTER_MS);
  assert.strictEqual(state.updates.at(-1).cancelAvailable, true);
  assert.strictEqual(handle.signal.aborted, false);
});

test('disables cancellation at commit and preserves committed terminal truth', () => {
  const state = harness();
  const handle = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 1,
  });
  handle.start();
  state.advance(CANCEL_AFTER_MS);
  assert.strictEqual(handle.snapshot().cancelAvailable, true);
  handle.stage('publishing_bundle');
  assert.strictEqual(handle.snapshot().cancelAvailable, false);
  assert.throws(() => state.service.cancel({ projectInstanceId, taskId: handle.taskId }),
    error => error?.code === 'LOCAL_TASK_NOT_CANCELABLE');
  const terminal = handle.terminal('COMMITTED');
  assert.strictEqual(terminal.status, 'completed');
  assert.strictEqual(terminal.terminalTruth, 'COMMITTED');
  assert.strictEqual(terminal.errorCode, null);
});

test('cancel requests abort but wait for proven uncommitted cleanup before terminal', () => {
  const state = harness();
  const handle = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 1,
  });
  handle.start();
  handle.stage('writing_private_bundle');
  state.advance(CANCEL_AFTER_MS);
  const cancelling = state.service.cancel({ projectInstanceId, taskId: handle.taskId });
  assert.strictEqual(cancelling.status, 'cancelling');
  assert.strictEqual(cancelling.terminalTruth, null);
  assert.strictEqual(handle.signal.aborted, true);
  assert.strictEqual(handle.abortCode(), 'REQUEST_ABORTED');
  const terminal = handle.terminal('UNCOMMITTED', 'REQUEST_ABORTED');
  assert.strictEqual(terminal.status, 'failed');
  assert.strictEqual(terminal.terminalTruth, 'UNCOMMITTED');
});

test('deadline requests reconciliation instead of inventing an uncommitted result', () => {
  const state = harness();
  const handle = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 1,
  });
  handle.start();
  handle.stage('publishing_bundle');
  state.advance(DEADLINES.SNAPSHOT_CREATE);
  assert.strictEqual(handle.snapshot().status, 'cancelling');
  assert.strictEqual(handle.snapshot().terminalTruth, null);
  assert.strictEqual(handle.abortCode(), 'LOCAL_TASK_TIMEOUT');
  const terminal = handle.terminal('UNKNOWN', 'SNAPSHOT_OUTCOME_UNKNOWN');
  assert.strictEqual(terminal.terminalTruth, 'UNKNOWN');
});

test('a queued task that never starts expires as proven uncommitted and releases its owner', () => {
  const state = harness();
  const first = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_COMPARE',
    ownerGeneration: 1,
  });
  state.advance(DEADLINES.SNAPSHOT_COMPARE);
  const terminal = first.snapshot();
  assert.strictEqual(terminal.status, 'failed');
  assert.strictEqual(terminal.terminalTruth, 'UNCOMMITTED');
  assert.strictEqual(terminal.errorCode, 'LOCAL_TASK_TIMEOUT');
  const second = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_COMPARE',
    ownerGeneration: 2,
  });
  second.start();
  second.terminal('UNCOMMITTED', 'TEST_COMPLETE');
});

test('project invalidation hides old progress and cannot release a newer owner', () => {
  const state = harness();
  const first = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 1,
  });
  first.start();
  const before = state.updates.length;
  assert.strictEqual(state.service.invalidateProject(projectInstanceId, 2), 1);
  assert.strictEqual(first.signal.aborted, true);
  assert.throws(() => first.assertCurrentOwner(), error => error?.code === 'LOCAL_TASK_STALE');
  const second = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_CREATE',
    ownerGeneration: 2,
  });
  second.start();
  first.terminal('UNCOMMITTED', 'PROJECT_CHANGED');
  assert.strictEqual(state.updates.length, before + 2);
  assert.strictEqual(second.assertCurrentOwner().status, 'running');
  second.terminal('COMMITTED');
});

test('rejects concurrent owners and stage regression', () => {
  const state = harness();
  const handle = state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_COMPARE',
    ownerGeneration: 1,
  });
  assert.throws(() => state.service.begin({
    projectInstanceId,
    kind: 'SNAPSHOT_DELETE',
    ownerGeneration: 2,
  }), error => error?.code === 'LOCAL_TASK_BUSY');
  handle.start();
  handle.stage('reading_snapshot');
  assert.throws(() => handle.stage('settling_watcher'),
    error => error?.code === 'INVALID_LOCAL_TASK_TRANSITION');
  handle.terminal('UNCOMMITTED', 'SNAPSHOT_COMPARE_FAILED');
});

console.log(`\n${passed}/${passed} local operation service tests passed.`);
