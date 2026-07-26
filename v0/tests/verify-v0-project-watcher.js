#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const watcher = require('../src/main/project-watcher');
const watcherInvalidationPolicy = require('../src/main/watcher-invalidation-policy');

let pass = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    pass += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-watcher-'));
}

function writeSized(file, bytes, byte = 0x41) {
  fs.writeFileSync(file, Buffer.alloc(bytes, byte));
}

async function run() {
  console.log('════════ WritCraft V0 · Project watcher verify ════════');

  await check('跨平台文件名统一为项目相对路径', () => {
    assert.strictEqual(watcher.normalizeWatchPath('chapters\\one.md'), 'chapters/one.md');
    assert.strictEqual(watcher.normalizeWatchPath(Buffer.from('edit.md')), 'edit.md');
  });

  await check('隐藏、依赖和危险路径不进入 renderer 事件', () => {
    for (const value of ['.writcraft/workspace.json', '../escape.md', '/tmp/a.md', 'node_modules/x.md', 'a//b.md']) {
      assert.strictEqual(watcher.normalizeWatchPath(value), null, value);
    }
  });

  await check('批次按路径稳定排序并去重', () => {
    assert.deepStrictEqual(watcher.coalesceChanges([
      { path: 'b.md', kind: 'changed' },
      { path: 'a.md', kind: 'changed' },
      { path: 'b.md', kind: 'renamed' },
    ]), [
      { path: 'a.md', kind: 'changed' },
      { path: 'b.md', kind: 'renamed' },
    ]);
  });

  await check('无文件名事件只产生一个全项目失效信号', () => {
    assert.deepStrictEqual(watcher.coalesceChanges([
      { path: null, kind: 'changed' },
      { path: null, kind: 'renamed' },
      { path: 'edit.md', kind: 'changed' },
    ]), [
      { path: null, kind: 'invalidated' },
      { path: 'edit.md', kind: 'changed' },
    ]);
  });

  await check('内部 mutation 窗口内的无文件名事件仍 fail-closed', () => {
    let generation = 17;
    const publish = (payload, options = {}) => {
      const changed = watcherInvalidationPolicy.watcherPayloadAffectsAiContext(payload, options);
      if (changed) generation += 1;
      return changed;
    };

    assert.strictEqual(publish({
      changes: [{ path: null, kind: 'invalidated' }],
    }, {
      deferredDuringInternalMutation: true,
      namedChangeAffectsContext: () => { throw new Error('filename-less change is not named'); },
    }), true);
    assert.strictEqual(generation, 18, 'deferred timing cannot prove a filename-less event is an own echo');

    assert.strictEqual(publish({
      changes: [{ path: null, kind: 'invalidated' }],
    }), true);
    assert.strictEqual(generation, 19, 'ordinary external filename-less event must invalidate all');

    const inspected = [];
    assert.strictEqual(publish({
      changes: [
        { path: null, kind: 'invalidated' },
        { path: 'chapters/external.md', kind: 'changed' },
      ],
    }, {
      deferredDuringInternalMutation: true,
      namedChangeAffectsContext(change) {
        inspected.push(change.path);
        return true;
      },
    }), true);
    assert.deepStrictEqual(inspected, ['chapters/external.md']);
    assert.strictEqual(generation, 20, 'named external changes stay effective inside a deferred batch');

    assert.strictEqual(publish({
      changes: [{ path: 'chapters/own.md', kind: 'changed' }],
    }, {
      deferredDuringInternalMutation: true,
      namedChangeAffectsContext: () => false,
    }), false);
    assert.strictEqual(generation, 20, 'a provable named own revision is still deduplicated');
  });

  await check('pauseAndFlush 先发布延迟 path:null，暂停后的私有写回声不进入新代际', () => {
    const root = tempProject();
    let nativeCallback = null;
    const native = new EventEmitter();
    native.close = () => {};
    const payloads = [];
    const instance = watcher.createProjectWatcher(root, payload => payloads.push(payload), {
      watchFn: (_root, _options, callback) => {
        nativeCallback = callback;
        return native;
      },
      debounceMs: 1000,
      pollIntervalMs: 0,
    });
    try {
      nativeCallback('change', null);
      assert.equal(payloads.length, 0, 'debounced event must still be pending');
      assert.equal(instance.pauseAndFlush(), 1);
      assert.deepStrictEqual(payloads[0].changes, [{ path: null, kind: 'invalidated' }]);
      nativeCallback('change', null);
      assert.equal(payloads.length, 1, 'closed watcher cannot publish the transaction own echo');
    } finally {
      instance.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('native watcher 的异步 error 被消费并安全降级到 polling', async () => {
    const root = tempProject();
    const native = new EventEmitter();
    let closed = false;
    native.close = () => { closed = true; };
    const instance = watcher.createProjectWatcher(root, () => {}, {
      watchFn: () => native,
      pollIntervalMs: 20,
    });
    try {
      native.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' }));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.strictEqual(closed, true);
      assert.strictEqual(process.exitCode, undefined);
    } finally {
      instance.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('native watcher 同步资源耗尽不会阻止 polling fallback 启动', async () => {
    const root = tempProject();
    let instance;
    const events = [];
    try {
      fs.writeFileSync(path.join(root, 'edit.md'), 'before');
      instance = watcher.createProjectWatcher(root, payload => events.push(payload), {
        watchFn: () => { throw Object.assign(new Error('too many files'), { code: 'EMFILE' }); },
        pollIntervalMs: 20,
      });
      assert(instance && typeof instance.close === 'function');
      await new Promise(resolve => setTimeout(resolve, 30));
      fs.writeFileSync(path.join(root, 'edit.md'), 'after');
      await new Promise(resolve => setTimeout(resolve, 220));
      assert(events.some(payload => payload.changes.some(change => change.path === 'edit.md')));
    } finally {
      instance?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('轮询快照补偿丢失的原生 watcher 事件', () => {
    const before = new Map([['edit.md', 'file:10:1'], ['old.md', 'file:2:1']]);
    const after = new Map([['edit.md', 'file:11:2'], ['new.md', 'file:1:2']]);
    assert.deepStrictEqual(watcher.diffSnapshots(before, after), [
      { path: 'edit.md', kind: 'changed' },
      { path: 'new.md', kind: 'renamed' },
      { path: 'old.md', kind: 'renamed' },
    ]);
  });

  await check('快照与文件哈希均通过异步接口执行', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'edit.md'), '异步');
      let hashCalls = 0;
      const promise = watcher.projectSnapshot(root, {
        hashFile: async () => {
          hashCalls += 1;
          await new Promise(resolve => setTimeout(resolve, 2));
          return 'async-hash';
        },
      });
      assert(promise instanceof Promise);
      const snapshot = await promise;
      assert.strictEqual(hashCalls, 1);
      assert.strictEqual(snapshot.entries.get('edit.md').contentHash, 'async-hash');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('轮询能发现同尺寸且保留 mtime 的小型 Markdown 内容变化', async () => {
    const root = tempProject();
    const file = path.join(root, 'edit.md');
    try {
      fs.writeFileSync(file, '内容甲');
      const originalTimes = fs.statSync(file);
      const before = await watcher.projectSnapshot(root);
      fs.writeFileSync(file, '内容乙');
      fs.utimesSync(file, originalTimes.atime, originalTimes.mtime);
      const after = await watcher.projectSnapshot(root, { previous: before, cursor: before.nextCursor });
      assert.deepStrictEqual(watcher.diffSnapshots(before, after), [{ path: 'edit.md', kind: 'changed' }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('覆盖 2–5 MiB 同尺寸且保留 mtime 的 Markdown 内容变化', async () => {
    const root = tempProject();
    const file = path.join(root, 'edit.md');
    const bytes = 3 * 1024 * 1024;
    try {
      writeSized(file, bytes, 0x41);
      const originalTimes = fs.statSync(file);
      const before = await watcher.projectSnapshot(root);
      assert.strictEqual(before.stats.hashedBytes, bytes);
      assert(before.stats.hashedPaths.includes('edit.md'));
      writeSized(file, bytes, 0x42);
      fs.utimesSync(file, originalTimes.atime, originalTimes.mtime);
      const after = await watcher.projectSnapshot(root, { previous: before, cursor: before.nextCursor });
      assert.deepStrictEqual(watcher.diffSnapshots(before, after), [{ path: 'edit.md', kind: 'changed' }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('每轮严格遵守文件数与总字节预算并优先 edit.md', async () => {
    const root = tempProject();
    try {
      for (const name of ['edit.md', 'a.md', 'b.md', 'c.md']) writeSized(path.join(root, name), 1024);
      const snapshot = await watcher.projectSnapshot(root, {
        maxHashFiles: 2,
        maxHashBytes: 2048,
      });
      assert.strictEqual(snapshot.stats.hashedFiles, 2);
      assert.strictEqual(snapshot.stats.hashedBytes, 2048);
      assert.strictEqual(snapshot.stats.hashedPaths[0], 'edit.md');
      assert(snapshot.stats.hashedBytes <= 2048);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('非 edit.md 文件按游标轮转而不是每轮从头扫描', async () => {
    const root = tempProject();
    try {
      for (const name of ['edit.md', 'a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(root, name), name);
      let snapshot = null;
      const rotated = [];
      for (let round = 0; round < 3; round += 1) {
        const next = await watcher.projectSnapshot(root, {
          previous: snapshot,
          cursor: snapshot?.nextCursor || 0,
          maxHashFiles: 2,
          maxHashBytes: 1024,
        });
        assert.strictEqual(next.stats.hashedPaths[0], 'edit.md');
        rotated.push(...next.stats.hashedPaths.filter(name => name !== 'edit.md'));
        if (snapshot) assert.deepStrictEqual(watcher.diffSnapshots(snapshot, next), []);
        snapshot = next;
      }
      assert.deepStrictEqual(rotated, ['a.md', 'b.md', 'c.md']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('本轮未 hash 的已知文件沿用摘要且不会误报变化', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'edit.md'), 'prompt');
      fs.writeFileSync(path.join(root, 'chapter.md'), '正文');
      const baseline = await watcher.projectSnapshot(root, { maxHashFiles: 2, maxHashBytes: 1024 });
      assert(baseline.entries.get('chapter.md').contentHash);
      const editOnly = await watcher.projectSnapshot(root, {
        previous: baseline,
        cursor: baseline.nextCursor,
        maxHashFiles: 1,
        maxHashBytes: 1024,
      });
      assert.deepStrictEqual(editOnly.stats.hashedPaths, ['edit.md']);
      assert.strictEqual(
        editOnly.entries.get('chapter.md').contentHash,
        baseline.entries.get('chapter.md').contentHash
      );
      assert.deepStrictEqual(watcher.diffSnapshots(baseline, editOnly), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check('保留元数据的正文变化会在轮转到该文件时被发现', async () => {
    const root = tempProject();
    try {
      fs.writeFileSync(path.join(root, 'edit.md'), 'prompt');
      fs.writeFileSync(path.join(root, 'a.md'), 'AAAA');
      fs.writeFileSync(path.join(root, 'b.md'), 'BBBB');
      const baseline = await watcher.projectSnapshot(root, { maxHashFiles: 3, maxHashBytes: 1024 });
      const target = path.join(root, 'b.md');
      const originalTimes = fs.statSync(target);
      fs.writeFileSync(target, 'CCCC');
      fs.utimesSync(target, originalTimes.atime, originalTimes.mtime);
      // Some filesystems round a restored Date mtime by a millisecond. Model
      // the sync-tool case explicitly: metadata is identical while content is
      // not, so only the rotating hash can reveal it.
      baseline.entries.get('b.md').mtimeMs = Math.trunc(fs.statSync(target).mtimeMs);

      // Cursor 0 scans a.md first; b.md is intentionally carried, not changed.
      const firstRound = await watcher.projectSnapshot(root, {
        previous: baseline, cursor: 0, maxHashFiles: 2, maxHashBytes: 1024,
      });
      assert.deepStrictEqual(firstRound.stats.hashedPaths, ['edit.md', 'a.md']);
      assert.deepStrictEqual(watcher.diffSnapshots(baseline, firstRound), []);

      const secondRound = await watcher.projectSnapshot(root, {
        previous: firstRound, cursor: firstRound.nextCursor, maxHashFiles: 2, maxHashBytes: 1024,
      });
      assert.deepStrictEqual(secondRound.stats.hashedPaths, ['edit.md', 'b.md']);
      assert.deepStrictEqual(watcher.diffSnapshots(firstRound, secondRound), [{ path: 'b.md', kind: 'changed' }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  if (!process.exitCode) console.log(`\n✅ Project watcher ${pass}/${pass} 全过`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
