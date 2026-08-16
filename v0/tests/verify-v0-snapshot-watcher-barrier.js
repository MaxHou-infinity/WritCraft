'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProjectWatcher } = require('../src/main/project-watcher');
const {
  createSnapshotWatcherBarrierAdapter,
} = require('../src/main/snapshot-watcher-barrier');

const PROJECT = Object.freeze({
  instanceId: `instance_${'a'.repeat(24)}`,
  rootPath: '/project-a',
});
const OWNER = Object.freeze({
  projectInstanceId: PROJECT.instanceId,
  ownerGeneration: 7,
  taskId: 'local_snapshot_create',
  kind: 'SNAPSHOT_CREATE',
});

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function setup(overrides = {}) {
  let currentProject = PROJECT;
  let currentWatcher = overrides.watcher || {
    async flush() { return { ok: true, entries: 1, hashedFiles: 1 }; },
  };
  let generation = 5;
  let activeToken = null;
  let degraded = false;
  const deferredPayloads = [];
  const published = [];
  const calls = [];

  function publish(payload) {
    published.push(payload);
    if (payload?.changes?.length) generation += 1;
  }

  const adapter = createSnapshotWatcherBarrierAdapter({
    getCurrentProject: () => currentProject,
    getCurrentWatcher: () => currentWatcher,
    getMutationGeneration: () => generation,
    assertWatcherAvailable() {
      calls.push('available');
      if (degraded) throw Object.assign(new Error('degraded'), {
        code: 'PROJECT_WATCHER_UNAVAILABLE',
      });
    },
    markWatcherDegraded(project) {
      calls.push('degraded');
      if (project === currentProject) degraded = true;
    },
    beginMutation(project) {
      calls.push('begin');
      if (activeToken) throw Object.assign(new Error('busy'), {
        code: 'PROJECT_MUTATION_IN_PROGRESS',
      });
      activeToken = Object.freeze({ id: 'lease-token', rootPath: project.rootPath });
      return activeToken;
    },
    endMutation(token) {
      calls.push(['end', token]);
      if (activeToken !== token) return;
      activeToken = null;
      while (deferredPayloads.length) publish(deferredPayloads.shift());
    },
    getActiveLease: () => activeToken,
    drainDeferredWatcherPayloads(_project, token) {
      calls.push(['drain', token]);
      if (activeToken !== token) throw Object.assign(new Error('stale'), {
        code: 'SNAPSHOT_LEASE_STALE',
      });
      const count = deferredPayloads.length;
      while (deferredPayloads.length) publish(deferredPayloads.shift());
      return count;
    },
    ...(overrides.options || {}),
  });

  return {
    adapter,
    calls,
    published,
    deferredPayloads,
    get generation() { return generation; },
    get activeToken() { return activeToken; },
    get degraded() { return degraded; },
    setProject(project) { currentProject = project; },
    setWatcher(watcher) { currentWatcher = watcher; },
    replaceToken(token) { activeToken = token; },
  };
}

function settleBinding(lease, signal = new AbortController().signal) {
  return Object.freeze({ ...OWNER, lease, signal });
}

function terminalBinding(truth) {
  return Object.freeze({ ...OWNER, terminalTruth: truth });
}

(async () => {
  console.log('Snapshot watcher barrier verification');

  await test('exact active lease passes flush, drains every queued wave, then freezes generation', async () => {
    let state;
    state = setup({
      watcher: {
        async flush() {
          state.calls.push('flush:await-old-poll');
          state.deferredPayloads.push({ changes: [{ path: 'a.md', kind: 'changed' }] });
          state.calls.push('flush:strict-full-hash');
          state.deferredPayloads.push({ changes: [{ path: 'b.md', kind: 'renamed' }] });
          return { ok: true, entries: 2, hashedFiles: 2 };
        },
      },
    });
    const lease = state.adapter.acquireLease(OWNER);
    const result = await state.adapter.settleWatcherBarrier(settleBinding(lease));
    assert.deepStrictEqual(result, {
      projectInstanceId: PROJECT.instanceId,
      mutationGeneration: 7,
    });
    assert.strictEqual(state.published.length, 2);
    assert.strictEqual(state.activeToken, lease.token);
    assert.throws(() => state.adapter.acquireLease(OWNER), error =>
      error.code === 'PROJECT_MUTATION_IN_PROGRESS');
    assert.strictEqual(state.adapter.releaseLease(lease, terminalBinding('COMMITTED')), true);
    assert.strictEqual(state.activeToken, null);
  });

  await test('project switch after awaited flush fails before drain and does not degrade the new project', async () => {
    const gate = deferred();
    const watcher = { flush: () => gate.promise };
    const state = setup({ watcher });
    const lease = state.adapter.acquireLease(OWNER);
    const pending = state.adapter.settleWatcherBarrier(settleBinding(lease));
    state.setProject({ instanceId: `instance_${'b'.repeat(24)}`, rootPath: '/project-b' });
    state.setWatcher({ flush: async () => ({ ok: true }) });
    gate.resolve({ ok: true });
    await assert.rejects(pending, error => error.code === 'PROJECT_CHANGED');
    assert.strictEqual(state.calls.filter(call => Array.isArray(call) && call[0] === 'drain').length, 0);
    assert.strictEqual(state.degraded, false);
  });

  await test('lease drift after awaited flush fails closed without draining another owner queue', async () => {
    const gate = deferred();
    const state = setup({ watcher: { flush: () => gate.promise } });
    const lease = state.adapter.acquireLease(OWNER);
    const pending = state.adapter.settleWatcherBarrier(settleBinding(lease));
    const replacement = Object.freeze({ id: 'replacement', rootPath: PROJECT.rootPath });
    state.replaceToken(replacement);
    gate.resolve({ ok: true });
    await assert.rejects(pending, error => error.code === 'SNAPSHOT_LEASE_STALE');
    assert.strictEqual(state.published.length, 0);
    assert.strictEqual(state.activeToken, replacement);
  });

  await test('scan-limit or degraded flush marks only the still-current watcher and freezes no authority', async () => {
    const state = setup({
      watcher: {
        async flush() {
          throw Object.assign(new Error('bounded full hash failed'), {
            code: 'PROJECT_WATCHER_FLUSH_INCOMPLETE',
          });
        },
      },
    });
    const lease = state.adapter.acquireLease(OWNER);
    await assert.rejects(
      state.adapter.settleWatcherBarrier(settleBinding(lease)),
      error => error.code === 'PROJECT_WATCHER_UNAVAILABLE'
    );
    assert.strictEqual(state.degraded, true);
    assert.strictEqual(state.published.length, 0);
    assert.strictEqual(state.activeToken, lease.token);
  });

  await test('abort before or after flush never drains or freezes authority', async () => {
    const before = setup();
    const beforeLease = before.adapter.acquireLease(OWNER);
    const beforeController = new AbortController();
    beforeController.abort();
    await assert.rejects(
      before.adapter.settleWatcherBarrier(settleBinding(beforeLease, beforeController.signal)),
      error => error.code === 'REQUEST_ABORTED'
    );
    assert.strictEqual(before.published.length, 0);

    const gate = deferred();
    const after = setup({ watcher: { flush: () => gate.promise } });
    const afterLease = after.adapter.acquireLease(OWNER);
    const afterController = new AbortController();
    const pending = after.adapter.settleWatcherBarrier(settleBinding(afterLease, afterController.signal));
    afterController.abort();
    gate.resolve({ ok: true });
    await assert.rejects(pending, error => error.code === 'REQUEST_ABORTED');
    assert.strictEqual(after.published.length, 0);
  });

  await test('old finally cannot release a replacement lease', async () => {
    const state = setup();
    const lease = state.adapter.acquireLease(OWNER);
    assert.strictEqual(state.adapter.releaseLease(lease, terminalBinding('UNKNOWN')), false);
    assert.strictEqual(state.activeToken, lease.token);
    const replacement = Object.freeze({ id: 'new-owner', rootPath: PROJECT.rootPath });
    state.replaceToken(replacement);
    assert.strictEqual(state.adapter.releaseLease(lease, terminalBinding('UNCOMMITTED')), false);
    assert.strictEqual(state.activeToken, replacement);
    assert.strictEqual(state.calls.filter(call => Array.isArray(call) && call[0] === 'end').length, 0);
  });

  await test('deferred drain failure freezes no authority and retains the exact lease', async () => {
    let state;
    state = setup({
      watcher: {
        async flush() {
          state.deferredPayloads.push({ changes: [{ path: 'late.md', kind: 'changed' }] });
          return { ok: true };
        },
      },
      options: {
        drainDeferredWatcherPayloads() {
          throw Object.assign(new Error('drain failed'), {
            code: 'SNAPSHOT_BARRIER_DRAIN_FAILED',
          });
        },
      },
    });
    const lease = state.adapter.acquireLease(OWNER);
    await assert.rejects(
      state.adapter.settleWatcherBarrier(settleBinding(lease)),
      error => error.code === 'SNAPSHOT_BARRIER_DRAIN_FAILED'
    );
    assert.strictEqual(state.published.length, 0);
    assert.strictEqual(state.activeToken, lease.token);
  });

  await test('real strict watcher flush catches split hints, add/delete, and restored-mtime rotation escape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-barrier-'));
    const native = new EventEmitter();
    native.close = () => {};
    let watchCallback = null;
    let activeToken = null;
    let generation = 0;
    let currentProject = { ...PROJECT, rootPath: root };
    const deferredPayloads = [];
    const published = [];
    const files = [];
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(root, `chapter-${String(index).padStart(2, '0')}.md`);
      fs.writeFileSync(file, `before-${String(index).padStart(2, '0')}`);
      files.push(file);
    }
    const watcher = createProjectWatcher(root, payload => {
      if (activeToken) deferredPayloads.push(payload);
      else {
        published.push(payload);
        generation += 1;
      }
    }, {
      watchFn(_root, _options, callback) {
        watchCallback = callback;
        return native;
      },
      debounceMs: 10000,
      pollIntervalMs: 0,
      maxHashFiles: 2,
      hashFile: async target => crypto.createHash('sha256')
        .update(fs.readFileSync(target)).digest('hex').slice(0, 16),
    });
    const adapter = createSnapshotWatcherBarrierAdapter({
      getCurrentProject: () => currentProject,
      getCurrentWatcher: () => watcher,
      getMutationGeneration: () => generation,
      assertWatcherAvailable: () => {},
      markWatcherDegraded: () => {},
      beginMutation: () => {
        if (activeToken) throw Object.assign(new Error('busy'), { code: 'PROJECT_MUTATION_IN_PROGRESS' });
        activeToken = Object.freeze({ id: 'real-lease' });
        return activeToken;
      },
      endMutation(token) {
        if (activeToken === token) activeToken = null;
      },
      getActiveLease: () => activeToken,
      drainDeferredWatcherPayloads(_project, token) {
        assert.strictEqual(token, activeToken);
        const count = deferredPayloads.length;
        while (deferredPayloads.length) {
          published.push(deferredPayloads.shift());
          generation += 1;
        }
        return count;
      },
    });
    try {
      await watcher.flush();
      published.length = 0;
      generation = 0;
      const target = files[11];
      const before = fs.statSync(target);
      fs.writeFileSync(target, 'after--11');
      fs.utimesSync(target, before.atime, before.mtime);
      fs.rmSync(files[0]);
      fs.writeFileSync(path.join(root, 'new.md'), 'new');
      watchCallback('change', 'chapter-11.md');
      watchCallback('rename', 'chapter-00.md');
      watchCallback('rename', 'new.md');

      const realOwner = { ...OWNER, projectInstanceId: currentProject.instanceId };
      const lease = adapter.acquireLease(realOwner);
      const result = await adapter.settleWatcherBarrier({
        ...realOwner,
        lease,
        signal: new AbortController().signal,
      });
      const changes = published.flatMap(payload => payload.changes || []);
      assert(changes.some(change => change.path === 'chapter-11.md'));
      assert(changes.some(change => change.path === 'chapter-00.md'));
      assert(changes.some(change => change.path === 'new.md'));
      assert.strictEqual(result.mutationGeneration, generation);
      assert(generation > 0);
      adapter.releaseLease(lease, { ...realOwner, terminalTruth: 'UNCOMMITTED' });
    } finally {
      currentProject = null;
      watcher.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('Main wiring reuses existing lease/deferred maps and adapter contains no scanner fallback', async () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const adapterSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'snapshot-watcher-barrier.js'),
      'utf8'
    );
    assert.match(mainSource, /require\('\.\/snapshot-watcher-barrier'\)/u);
    assert.match(mainSource, /snapshotWatcherBarrierService\.createSnapshotWatcherBarrierAdapter/u);
    assert.match(mainSource, /internalMutationLeaseByRoot\.get\(rootPath\)/u);
    assert.match(mainSource, /drainSnapshotDeferredWatcherPayloads/u);
    assert.match(mainSource, /pending\.slice\(index\)/u);
    assert.doesNotMatch(adapterSource, /require\(['"](?:fs|path|\.\/project-service)['"]\)/u);
    assert.doesNotMatch(adapterSource, /listTree|readFile|projectSnapshot|createProjectWatcher/u);
    assert.match(adapterSource, /await watcher\.flush\(\)/u);
  });

  console.log(`Snapshot watcher barrier verification: ${passed}/9 passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
