#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const flushHandlerService = require('../src/main/project-watcher-flush-handler');
const externalSyncStateService = require('../src/renderer/external-sync-state-service');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main/main.js');
const preload = read('src/main/preload.js');
const workspace = read('src/renderer/workspace.js');
const electronE2e = read('tests/verify-v0-electron-e2e.js');
let passed = 0;
const EXPECTED_CHECKS = 11;

async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHandlerHarness(options = {}) {
  const project = { instanceId: 'project-a', rootPath: '/project-a' };
  let currentProject = project;
  let currentWatcher = options.watcher || { flush: async () => ({ ok: true }) };
  let mutationDepth = options.mutationDepth || 0;
  let internalMutationEpoch = options.internalMutationEpoch || 0;
  let generation = options.generation || 7;
  let navigationEpoch = options.navigationEpoch || 3;
  const barriers = [];
  const degraded = [];
  const calls = [];
  const handler = flushHandlerService.createProjectWatcherFlushHandler({
    assertTrustedSender: event => {
      calls.push('trusted');
      if (event?.trusted !== true) throw Object.assign(new Error('untrusted'), { code: 'UNTRUSTED_SENDER' });
    },
    requireCurrentProject: () => {
      if (!currentProject) throw Object.assign(new Error('no project'), { code: 'NO_PROJECT' });
      return currentProject;
    },
    getCurrentProject: () => currentProject,
    getCurrentWatcher: () => currentWatcher,
    assertWatcherAvailable: () => {
      calls.push('available');
      if (options.degraded) throw Object.assign(new Error('degraded'), { code: 'PROJECT_WATCHER_UNAVAILABLE' });
    },
    markWatcherDegraded: value => degraded.push(value),
    getMutationDepth: () => mutationDepth,
    getInternalMutationEpoch: () => internalMutationEpoch,
    getMutationGeneration: () => generation,
    getNavigationEpoch: () => navigationEpoch,
    createError: (code, message) => Object.assign(new Error(message), { code }),
    createId: () => 'flush-id',
    projectChanged: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({ ok: false, error: error.code || 'PROJECT_OPERATION_FAILED' }),
    sendBarrier: (_event, channel, payload) => {
      calls.push('barrier');
      if (options.barrierFailure) throw new Error('send failed');
      barriers.push({ channel, payload });
    },
  });
  return {
    project,
    handler,
    barriers,
    degraded,
    calls,
    setCurrentProject: value => { currentProject = value; },
    setCurrentWatcher: value => { currentWatcher = value; },
    setMutationDepth: value => { mutationDepth = value; },
    setInternalMutationEpoch: value => { internalMutationEpoch = value; },
    setGeneration: value => { generation = value; },
    setNavigationEpoch: value => { navigationEpoch = value; },
  };
}

function loadPreloadApi(ipcRenderer, timers = {}) {
  let exposed = null;
  const sandbox = {
    require: name => {
      assert.strictEqual(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name, value) => {
            assert.strictEqual(name, 'writCraft');
            exposed = value;
          },
        },
        ipcRenderer,
      };
    },
    setTimeout: timers.setTimeout || setTimeout,
    clearTimeout: timers.clearTimeout || clearTimeout,
    Promise,
    Object,
    Array,
    Number,
  };
  vm.runInNewContext(preload, sandbox, { filename: 'preload.js' });
  return exposed;
}

async function run() {
  console.log('════════ WritCraft V0 · Watcher flush cross-layer verify ════════');

  await check('Main 成功结果只在 exact barrier 已发送后返回', async () => {
    const harness = createHandlerHarness();
    const result = await harness.handler({ trusted: true }, harness.project.instanceId);
    assert.deepStrictEqual(result, {
      ok: true,
      schema: flushHandlerService.RESULT_SCHEMA,
      flushId: 'flush-id',
      projectInstanceId: harness.project.instanceId,
      mutationGeneration: 7,
    });
    assert.deepStrictEqual(harness.calls, ['trusted', 'available', 'available', 'barrier']);
    assert.strictEqual(harness.barriers.length, 1);
    assert.strictEqual(harness.barriers[0].channel, flushHandlerService.BARRIER_CHANNEL);
    assert.deepStrictEqual(harness.barriers[0].payload, {
      schema: flushHandlerService.BARRIER_SCHEMA,
      flushId: 'flush-id',
      projectInstanceId: harness.project.instanceId,
      mutationGeneration: 7,
    });
  });

  await check('Main 在不可信 sender、项目漂移和 mutation in-flight 前零扫描', async () => {
    let flushes = 0;
    const watcher = { flush: async () => { flushes += 1; return { ok: true }; } };
    const untrusted = createHandlerHarness({ watcher });
    assert.strictEqual((await untrusted.handler({ trusted: false }, 'project-a')).error, 'UNTRUSTED_SENDER');
    const stale = createHandlerHarness({ watcher });
    assert.strictEqual((await stale.handler({ trusted: true }, 'project-b')).error, 'PROJECT_CHANGED');
    const mutating = createHandlerHarness({ watcher, mutationDepth: 1 });
    assert.strictEqual((await mutating.handler({ trusted: true }, 'project-a')).error, 'PROJECT_MUTATION_IN_PROGRESS');
    assert.strictEqual(flushes, 0);
  });

  await check('Main 对 degraded、扫描不完整和 closed watcher fail-closed', async () => {
    const degraded = createHandlerHarness({ degraded: true });
    assert.strictEqual((await degraded.handler({ trusted: true }, 'project-a')).error, 'PROJECT_WATCHER_UNAVAILABLE');
    const incomplete = createHandlerHarness({
      watcher: { flush: async () => { throw Object.assign(new Error('incomplete'), { code: 'PROJECT_WATCHER_FLUSH_INCOMPLETE' }); } },
    });
    assert.strictEqual((await incomplete.handler({ trusted: true }, 'project-a')).error, 'PROJECT_WATCHER_UNAVAILABLE');
    assert.strictEqual(incomplete.degraded.length, 1);
    const closed = createHandlerHarness({ watcher: { flush: async () => ({ ok: false, reason: 'closed' }) } });
    assert.strictEqual((await closed.handler({ trusted: true }, 'project-a')).error, 'PROJECT_WATCHER_UNAVAILABLE');
    assert.strictEqual(closed.degraded.length, 1);
  });

  await check('Main 等待期间项目或 watcher 切换只返回 stale 且不污染新项目健康状态', async () => {
    const gate = controlledPromise();
    const harness = createHandlerHarness({ watcher: { flush: () => gate.promise } });
    const pending = harness.handler({ trusted: true }, 'project-a');
    harness.setCurrentProject({ instanceId: 'project-b', rootPath: '/project-b' });
    harness.setCurrentWatcher({ flush: async () => ({ ok: true }) });
    gate.resolve({ ok: true });
    assert.strictEqual((await pending).error, 'PROJECT_CHANGED');
    assert.strictEqual(harness.degraded.length, 0);
    assert.strictEqual(harness.barriers.length, 0);
  });

  await check('Main 在扫描返回后的 mutation 和 barrier 发送故障均不铸造成功', async () => {
    const gate = controlledPromise();
    const harness = createHandlerHarness({ watcher: { flush: () => gate.promise } });
    const pending = harness.handler({ trusted: true }, 'project-a');
    harness.setMutationDepth(1);
    gate.resolve({ ok: true });
    assert.strictEqual((await pending).error, 'PROJECT_MUTATION_IN_PROGRESS');
    assert.strictEqual(harness.barriers.length, 0);
    const sendFailure = createHandlerHarness({ barrierFailure: true });
    assert.strictEqual((await sendFailure.handler({ trusted: true }, 'project-a')).error, 'PROJECT_OPERATION_FAILED');
    assert.strictEqual(sendFailure.barriers.length, 0);
  });

  await check('Main 拒绝扫描期间完整发生的内部 mutation 与 Renderer 导航漂移', async () => {
    const mutationGate = controlledPromise();
    const mutation = createHandlerHarness({ watcher: { flush: () => mutationGate.promise } });
    const mutationPending = mutation.handler({ trusted: true }, 'project-a');
    mutation.setInternalMutationEpoch(1);
    mutationGate.resolve({ ok: true });
    assert.strictEqual((await mutationPending).error, 'PROJECT_MUTATION_IN_PROGRESS');
    assert.strictEqual(mutation.barriers.length, 0);

    const navigationGate = controlledPromise();
    const navigation = createHandlerHarness({ watcher: { flush: () => navigationGate.promise } });
    const navigationPending = navigation.handler({ trusted: true }, 'project-a');
    navigation.setNavigationEpoch(4);
    navigationGate.resolve({ ok: true });
    assert.strictEqual((await navigationPending).error, 'PROJECT_CHANGED');
    assert.strictEqual(navigation.barriers.length, 0);
  });

  await check('Preload 在 invoke 前监听并接受同步先到的 exact barrier', async () => {
    const ipc = new EventEmitter();
    const invoked = [];
    ipc.invoke = async (...args) => {
      invoked.push(args);
      const result = {
        ok: true,
        schema: flushHandlerService.RESULT_SCHEMA,
        flushId: 'sync-id',
        projectInstanceId: 'project-a',
        mutationGeneration: 9,
      };
      ipc.emit(flushHandlerService.BARRIER_CHANNEL, {}, {
        schema: flushHandlerService.BARRIER_SCHEMA,
        flushId: 'sync-id',
        projectInstanceId: 'project-a',
        mutationGeneration: 9,
      });
      return result;
    };
    const api = loadPreloadApi(ipc);
    const result = await api.project.flushExternalChanges('project-a');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(invoked, [['writcraft:project:flush-external-changes', 'project-a']]);
    assert.strictEqual(ipc.listenerCount(flushHandlerService.BARRIER_CHANNEL), 0);
  });

  await check('Preload 忽略错配 barrier，exact barrier 到达后才放行并清理 listener', async () => {
    const ipc = new EventEmitter();
    ipc.invoke = async () => {
      queueMicrotask(() => {
        ipc.emit(flushHandlerService.BARRIER_CHANNEL, {}, {
          schema: flushHandlerService.BARRIER_SCHEMA,
          flushId: 'wanted',
          projectInstanceId: 'project-a',
          mutationGeneration: 11,
        });
      });
      ipc.emit(flushHandlerService.BARRIER_CHANNEL, {}, {
        schema: flushHandlerService.BARRIER_SCHEMA,
        flushId: 'wrong',
        projectInstanceId: 'project-a',
        mutationGeneration: 11,
      });
      return {
        ok: true,
        schema: flushHandlerService.RESULT_SCHEMA,
        flushId: 'wanted',
        projectInstanceId: 'project-a',
        mutationGeneration: 11,
      };
    };
    const result = await loadPreloadApi(ipc).project.flushExternalChanges('project-a');
    assert.strictEqual(result.flushId, 'wanted');
    assert.strictEqual(ipc.listenerCount(flushHandlerService.BARRIER_CHANNEL), 0);
  });

  await check('Preload 对失败、畸形成功和无项目输入立即 fail-closed 并清理', async () => {
    const ipc = new EventEmitter();
    ipc.invoke = async () => ({ ok: false, error: 'PROJECT_WATCHER_UNAVAILABLE' });
    const api = loadPreloadApi(ipc);
    assert.strictEqual((await api.project.flushExternalChanges('project-a')).error, 'PROJECT_WATCHER_UNAVAILABLE');
    assert.strictEqual(ipc.listenerCount(flushHandlerService.BARRIER_CHANNEL), 0);
    assert.strictEqual((await api.project.flushExternalChanges('')).error, 'PROJECT_CHANGED');
    ipc.invoke = async () => ({
      ok: true,
      schema: flushHandlerService.RESULT_SCHEMA,
      flushId: 'id',
      projectInstanceId: 'project-a',
      mutationGeneration: 1,
      leakedPath: '/private/project',
    });
    assert.strictEqual((await api.project.flushExternalChanges('project-a')).error, 'PROJECT_WATCHER_BARRIER_INVALID');
    assert.strictEqual(ipc.listenerCount(flushHandlerService.BARRIER_CHANNEL), 0);
  });

  await check('Renderer 外部刷新失败会阻止 AI，直到后续成功同步或项目重置', async () => {
    const sync = externalSyncStateService.createExternalSyncState();
    await sync.enqueue(async () => { throw new Error('injected tree refresh failure'); });
    assert.strictEqual(sync.available(), false);
    await assert.rejects(() => sync.drain(), /项目文件同步失败/);
    await sync.enqueue(async () => {});
    assert.strictEqual(sync.available(), true);
    await sync.enqueue(async () => { throw new Error('second failure'); });
    sync.reset();
    assert.strictEqual(sync.available(), true);
    await sync.drain();
  });

  await check('跨层源码只传 project instance 并彻底移除 1.5 秒静默推断', async () => {
    const routeStart = main.indexOf("ipcMain.handle(\n  'writcraft:project:flush-external-changes'");
    assert(routeStart >= 0);
    const route = main.slice(routeStart, main.indexOf('\nipcMain.handle(', routeStart + 30));
    assert(route.includes('assertTrustedSender'));
    assert(route.includes('getCurrentWatcher: () => currentProjectWatcher'));
    assert(route.includes('internalMutationDepthByRoot.get(rootPath) || 0'));
    assert.doesNotMatch(route, /relPath|content|revision/);
    assert(workspace.includes('await bridge.flushExternalChanges(projectInstanceId)'));
    assert(workspace.includes('await externalSyncState.drain()'));
    assert(workspace.includes('externalSyncState?.available()'));
    assert(workspace.includes('externalSyncState?.enqueue'));
    assert(workspace.includes('flushExternalChanges,'));
    assert(!workspace.includes('setTimeout(resolve, 220)'));
    assert(!electronE2e.includes('waitForExternalQuiescence'));
    assert(!electronE2e.includes('stableMs = 1500'));
    assert(electronE2e.includes('window.__workspace.flushExternalChanges()'));
  });

  assert.strictEqual(passed, EXPECTED_CHECKS);
  console.log(`\n✅ Watcher flush cross-layer ${passed}/${EXPECTED_CHECKS} 全过`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
