#!/usr/bin/env node
'use strict';

const assert = require('assert');
const transaction = require('../src/main/research-judgment-transaction');
const watcherHealthService = require('../src/main/project-watcher-health');

let passed = 0;
function test(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}

function changed(reason) {
  const error = new Error(reason);
  error.code = 'PROJECT_CHANGED';
  return error;
}

function harness(overrides = {}) {
  const state = {
    generation: 7,
    fingerprint: 'F0',
    activeMutation: false,
    authority: true,
    leaseReady: true,
    writes: 0,
    advances: 0,
    restarts: 0,
    aborts: 0,
    finishes: 0,
    invalidations: 0,
    order: [],
    ...overrides.state,
  };
  const options = {
    hasActiveMutation: () => state.activeMutation,
    busyError: () => Object.assign(new Error('busy'), { code: 'PROJECT_BUSY' }),
    advanceGeneration() { state.order.push('advance'); state.advances += 1; state.generation += 1; },
    getGeneration: () => state.generation,
    beginLease() {
      state.order.push('lease');
      if (!state.leaseReady) throw Object.assign(new Error('not ready or wrong owner'), { code: 'RESEARCH_HANDOFF_BUSY' });
      return { leaseId: 'rj_test' };
    },
    resolveAuthority() {
      state.order.push('authority');
      if (!state.authority) throw changed('stale authority');
    },
    pauseWatcher() { state.order.push('pause'); overrides.onPause?.(state); },
    restartWatcher() {
      state.order.push('restart');
      state.restarts += 1;
      overrides.onRestart?.(state);
    },
    fingerprint: () => state.fingerprint,
    changedError: reason => changed(reason),
    recordMetric(beforeRename) {
      state.order.push('prepare');
      overrides.beforeRename?.(state);
      beforeRename();
      state.order.push('rename');
      state.writes += 1;
      overrides.afterRename?.(state);
    },
    finishLease(_lease, generation) {
      state.order.push('finish');
      state.finishes += 1;
      state.reboundGeneration = generation;
      overrides.onFinish?.(state);
    },
    abortLease() { state.order.push('abort'); state.aborts += 1; },
    publishInvalidation() { state.order.push('invalidate'); state.invalidations += 1; state.generation += 1; },
  };
  return { state, run: () => transaction.recordResearchJudgmentTransaction(options) };
}

console.log('════════ WritCraft V0 · Research judgment transaction verify ════════');

test('已有异步 mutation 时零推进、零租约、零写入', () => {
  const item = harness({ state: { activeMutation: true } });
  assert.throws(item.run, error => error.code === 'PROJECT_BUSY');
  assert.equal(item.state.advances, 0);
  assert.equal(item.state.writes, 0);
  assert.deepStrictEqual(item.state.order, []);
});

test('pause 前积压的 path:null 推进 generation，事务零写并恢复 watcher', () => {
  const item = harness({ onPause(state) { state.generation += 1; state.order.push('delayed-null'); } });
  assert.throws(item.run, error => error.code === 'PROJECT_CHANGED');
  assert.equal(item.state.writes, 0);
  assert.equal(item.state.restarts, 1);
  assert.equal(item.state.aborts, 1);
  assert(item.state.order.indexOf('delayed-null') < item.state.order.indexOf('restart'));
});

test('initial resolve 后、rename 前来源变化由紧邻 callback 拒绝且零样本', () => {
  const item = harness({ beforeRename(state) { state.fingerprint = 'F1'; state.authority = false; } });
  assert.throws(item.run, error => error.code === 'PROJECT_CHANGED');
  assert.equal(item.state.writes, 0);
  assert.equal(item.state.restarts, 1);
  assert.equal(item.state.finishes, 0);
  assert.equal(item.state.aborts, 1);
  assert(item.state.order.indexOf('prepare') < item.state.order.indexOf('restart'));
});

test('正常路径严格 stop→F0→beforeRename authority→rename→restart→F1→exact rebind', () => {
  const item = harness();
  assert.deepStrictEqual(item.run(), {
    ok: true, recorded: true, handoffAvailable: true, evidenceChanged: false,
  });
  assert.equal(item.state.writes, 1);
  assert.equal(item.state.finishes, 1);
  assert.equal(item.state.aborts, 0);
  assert.equal(item.state.reboundGeneration, 8);
  const order = item.state.order;
  assert(order.indexOf('lease') < order.indexOf('advance'));
  assert(order.indexOf('authority') < order.indexOf('advance'));
  assert(order.indexOf('pause') < order.indexOf('prepare'));
  assert(order.indexOf('prepare') < order.indexOf('rename'));
  assert(order.indexOf('rename') < order.indexOf('restart'));
  assert(order.indexOf('restart') < order.lastIndexOf('authority'));
  assert(order.lastIndexOf('authority') < order.indexOf('finish'));
});

test('watcher 已暂停时自有 filename-less metrics 回声不推进新 generation', () => {
  const item = harness({
    beforeRename(state) { state.order.push('own-null-ignored'); },
  });
  const result = item.run();
  assert.equal(result.handoffAvailable, true);
  assert.equal(item.state.generation, 8, 'only the pre-window fence may advance generation');
  assert.equal(item.state.invalidations, 0);
});

test('rename 后证据变化保留线性化点样本但锁定 handoff 并发布失效', () => {
  const item = harness({ afterRename(state) { state.fingerprint = 'F1'; state.authority = false; } });
  assert.deepStrictEqual(item.run(), {
    ok: true,
    recorded: true,
    handoffAvailable: false,
    evidenceChanged: true,
    message: '作者判断已记录，但证据或项目监控随后变化；请重新 Research 后再带入修改',
  });
  assert.equal(item.state.writes, 1);
  assert.equal(item.state.finishes, 0);
  assert.equal(item.state.aborts, 1);
  assert.equal(item.state.invalidations, 1);
});

test('watcher 首次重启失败会同步重试并在终检成功后解锁', () => {
  const item = harness({
    onRestart(state) { if (state.restarts === 1) throw new Error('one-shot restart failure'); },
  });
  assert.equal(item.run().handoffAvailable, true);
  assert.equal(item.state.restarts, 2);
  assert.equal(item.state.finishes, 1);
});

test('watcher 持续重启失败时已提交样本诚实返回 recorded-but-locked', () => {
  const health = watcherHealthService.createProjectWatcherHealth();
  const project = { instanceId: 'instance_a', rootPath: '/project/a' };
  const item = harness({ onRestart() {
    health.markDegraded(project);
    throw Object.assign(new Error('persistent restart failure'), { code: 'PROJECT_WATCHER_UNAVAILABLE' });
  } });
  const result = item.run();
  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.equal(result.handoffAvailable, false);
  assert.equal(result.evidenceChanged, true);
  assert.match(result.message, /重新打开项目/);
  assert.equal(item.state.restarts, 2);
  assert.equal(item.state.finishes, 0);
  assert.equal(item.state.aborts, 1);
  assert.equal(item.state.invalidations, 1);
  for (const pathName of ['runAiRequest', 'requireMutableProject']) {
    assert.throws(
      () => health.assertAvailable(project, () => Object.assign(new Error(pathName), { code: 'PROJECT_WATCHER_UNAVAILABLE' })),
      error => error.code === 'PROJECT_WATCHER_UNAVAILABLE',
    );
  }
  const reopened = { instanceId: 'instance_b', rootPath: '/project/a' };
  health.reset();
  health.clear(reopened);
  assert.strictEqual(health.assertAvailable(reopened), reopened);
});

test('非 READY 或 owner 不匹配在 pause/metrics 前失败且不 rebind', () => {
  const item = harness({ state: { leaseReady: false } });
  assert.throws(item.run, error => error.code === 'RESEARCH_HANDOFF_BUSY');
  assert.equal(item.state.writes, 0);
  assert.equal(item.state.restarts, 0);
  assert.equal(item.state.finishes, 0);
  assert.equal(item.state.advances, 0);
  assert.deepStrictEqual(item.state.order, ['lease']);
});

test('unknown/stale authority 在全局 generation fence 前失败且零副作用', () => {
  const item = harness({ state: { authority: false } });
  assert.throws(item.run, error => error.code === 'PROJECT_CHANGED');
  assert.equal(item.state.advances, 0);
  assert.equal(item.state.writes, 0);
  assert.equal(item.state.restarts, 0);
  assert.equal(item.state.aborts, 1);
  assert.deepStrictEqual(item.state.order, ['lease', 'authority', 'abort']);
});

if (!process.exitCode) console.log(`\n✅ Research judgment transaction ${passed}/${passed} 全过`);
