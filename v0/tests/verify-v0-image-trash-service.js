#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const serviceModule = require('../src/main/image-trash-service');

console.log('\nWritCraft image trash service verification');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function png(seed = 0x22) {
  const bytes = Buffer.alloc(33, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-trash-')));
  const trash = path.join(root, '.writcraft', 'image-trash');
  const generated = path.join(root, 'assets', 'generated');
  fs.mkdirSync(trash, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  let index = 0;
  const add = (bytes = png(index + 1)) => {
    index += 1;
    const name = `${String(index).padStart(32, 'a')}-${String(index).padStart(24, 'b')}.asset`;
    const target = path.join(trash, name);
    fs.writeFileSync(target, bytes);
    return { name, target, bytes };
  };
  return {
    root,
    trash,
    generated,
    add,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function binding(root, overrides = {}) {
  return {
    webContentsId: 7,
    projectInstanceId: 'project-a',
    rootPath: root,
    mutationGeneration: 3,
    navigationEpoch: 2,
    ...overrides,
  };
}

function deterministic(options = {}) {
  let tokenIndex = 0;
  return serviceModule.createImageTrashService({
    randomToken(prefix) {
      tokenIndex += 1;
      return `${prefix}_${tokenIndex.toString(16).padStart(48, '0')}`;
    },
    ...options,
  });
}

function expectCode(code, fn, properties = {}) {
  assert.throws(fn, error =>
    error instanceof serviceModule.ImageTrashError &&
    error.code === code &&
    Object.entries(properties).every(([key, value]) => error[key] === value));
}

test('list exposes bounded safe metadata, aggregate bytes and exact opaque snapshot', () => {
  const item = fixture();
  try {
    for (let index = 0; index < 55; index += 1) item.add(png(index + 1));
    const result = deterministic({ capacity: 64 }).list(binding(item.root));
    assert.strictEqual(result.schema, serviceModule.TRASH_SCHEMA);
    assert.strictEqual(result.policy, 'manual_until_restore_or_empty');
    assert.strictEqual(result.totalCount, 55);
    assert.strictEqual(result.items.length, 50);
    assert.strictEqual(result.totalBytes, 55 * 33);
    assert.match(result.snapshotToken, /^its_[a-f0-9]{48}$/);
    assert(result.items.every(entry =>
      Object.keys(entry).join(',') === 'token,createdAt,sizeBytes' &&
      /^iti_[a-f0-9]{48}$/.test(entry.token)));
    for (const forbidden of [item.root, item.trash, '.asset', 'operationId', 'digest', 'ino']) {
      assert(!JSON.stringify(result).includes(forbidden));
    }
  } finally { item.cleanup(); }
});

test('empty trash returns no capabilities and never creates private directories', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-trash-empty-')));
  try {
    const result = deterministic().list(binding(root));
    assert.deepStrictEqual(result, {
      ok: true,
      schema: serviceModule.TRASH_SCHEMA,
      policy: 'manual_until_restore_or_empty',
      totalCount: 0,
      totalBytes: 0,
      items: [],
      snapshotToken: null,
    });
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('list rejects unknown, corrupt, symlink and hard-link entries', () => {
  for (const prepare of [
    item => fs.writeFileSync(path.join(item.trash, 'unknown.txt'), 'x'),
    item => fs.mkdirSync(path.join(item.trash, `${'a'.repeat(32)}-${'b'.repeat(24)}.asset`)),
    item => fs.symlinkSync('/tmp', path.join(item.trash, `${'a'.repeat(32)}-${'b'.repeat(24)}.asset`)),
    item => {
      const entry = item.add();
      fs.linkSync(entry.target, path.join(item.root, 'hardlink'));
    },
  ]) {
    const item = fixture();
    try {
      prepare(item);
      expectCode('IMAGE_TRASH_CORRUPT', () => deterministic().list(binding(item.root)));
    } finally { item.cleanup(); }
  }
});

test('restore verifies magic and digest, restores atomically and returns only safe path', () => {
  const item = fixture();
  try {
    const entry = item.add();
    const service = deterministic();
    const listed = service.list(binding(item.root));
    const result = service.restore(binding(item.root), listed.items[0].token);
    assert.strictEqual(result.restored, true);
    assert.match(result.assetPath, /^assets\/generated\/image-[a-f0-9]{64}\.png$/);
    assert.strictEqual(fs.existsSync(entry.target), false);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(item.root, ...result.assetPath.split('/'))),
      entry.bytes
    );
    assert.deepStrictEqual(Object.keys(result), [
      'ok', 'schema', 'restored', 'assetPath', 'responseRecovered',
    ]);
    assert(!JSON.stringify(result).includes(item.root));
  } finally { item.cleanup(); }
});

test('restore rejects invalid magic and an existing destination without changing trash', () => {
  for (const conflict of [false, true]) {
    const item = fixture();
    try {
      const entry = item.add(conflict ? png() : Buffer.from('not-image'));
      const service = deterministic();
      const listed = service.list(binding(item.root));
      if (conflict) {
        const digest = require('crypto').createHash('sha256').update(entry.bytes).digest('hex');
        fs.writeFileSync(path.join(item.generated, `image-${digest}.png`), 'owner');
        expectCode('IMAGE_TRASH_DESTINATION_EXISTS', () =>
          service.restore(binding(item.root), listed.items[0].token));
      } else {
        expectCode('IMAGE_TRASH_CORRUPT', () =>
          service.restore(binding(item.root), listed.items[0].token));
      }
      assert.strictEqual(fs.existsSync(entry.target), true);
    } finally { item.cleanup(); }
  }
});

test('restore detects quarantine unlink committed-then-threw without deleting the restored target', () => {
  const item = fixture();
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  try {
    const entry = item.add();
    const fileSystem = Object.create(fs);
    fileSystem.unlinkSync = target => {
      if (!injected && target.includes(`${path.sep}image-trash-operations${path.sep}`)) {
        injected = true;
        originalUnlink(target);
        throw Object.assign(new Error('committed then threw'), { code: 'EIO' });
      }
      return originalUnlink(target);
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    const result = service.restore(binding(item.root), listed.items[0].token);
    assert.strictEqual(result.restored, true);
    assert.strictEqual(fs.existsSync(entry.target), false);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(item.root, ...result.assetPath.split('/'))),
      entry.bytes
    );
  } finally { item.cleanup(); }
});

test('restore preserves a replacement that wins the source-path race', () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  let injected = false;
  try {
    const entry = item.add();
    const foreign = png(0x77);
    const fileSystem = Object.create(fs);
    fileSystem.renameSync = (source, target) => {
      if (!injected && source === entry.target) {
        injected = true;
        fs.unlinkSync(source);
        fs.writeFileSync(source, foreign);
      }
      return originalRename(source, target);
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    const result = service.restore(binding(item.root), listed.items[0].token);
    assert.strictEqual(result.restored, true);
    assert.deepStrictEqual(fs.readFileSync(entry.target), foreign);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(item.root, ...result.assetPath.split('/'))),
      entry.bytes
    );
  } finally { item.cleanup(); }
});

test('restore removes a foreign inode published by a pre-link source replacement', () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  let injected = false;
  try {
    const entry = item.add();
    const foreign = png(0x55);
    const fileSystem = Object.create(fs);
    fileSystem.linkSync = (source, target) => {
      if (!injected && source === entry.target) {
        injected = true;
        fs.unlinkSync(source);
        fs.writeFileSync(source, foreign);
      }
      return originalLink(source, target);
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    expectCode('IMAGE_TRASH_STALE', () =>
      service.restore(binding(item.root), listed.items[0].token));
    assert.deepStrictEqual(fs.readFileSync(entry.target), foreign);
    assert.deepStrictEqual(fs.readdirSync(item.generated), []);
  } finally { item.cleanup(); }
});

test('restore rejects a same-inode same-size rewrite before publishing a digest path', () => {
  const item = fixture();
  const originalLink = fs.linkSync;
  let injected = false;
  try {
    const entry = item.add(png(0x33));
    const replacement = png(0x44);
    const fileSystem = Object.create(fs);
    fileSystem.linkSync = (source, target) => {
      const result = originalLink(source, target);
      if (!injected && source === entry.target) {
        injected = true;
        fs.writeFileSync(source, replacement);
      }
      return result;
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    expectCode('IMAGE_TRASH_STALE', () =>
      service.restore(binding(item.root), listed.items[0].token));
    assert.deepStrictEqual(fs.readFileSync(entry.target), replacement);
    assert.deepStrictEqual(fs.readdirSync(item.generated), []);
  } finally { item.cleanup(); }
});

test('empty removes only exact snapshot inodes and preserves a new arrival', () => {
  const item = fixture();
  try {
    const first = item.add();
    const second = item.add();
    const service = deterministic();
    const listed = service.list(binding(item.root));
    const late = item.add();
    const result = service.empty(binding(item.root), listed.snapshotToken);
    assert.strictEqual(result.emptiedCount, 2);
    assert.strictEqual(result.remainingCount, 1);
    assert.strictEqual(fs.existsSync(first.target), false);
    assert.strictEqual(fs.existsSync(second.target), false);
    assert.strictEqual(fs.existsSync(late.target), true);
  } finally { item.cleanup(); }
});

test('empty rejects an externally missing snapshot entry before deleting any peer', () => {
  const item = fixture();
  try {
    const first = item.add();
    const second = item.add();
    const service = deterministic();
    const listed = service.list(binding(item.root));
    fs.unlinkSync(second.target);
    expectCode('IMAGE_TRASH_STALE', () =>
      service.empty(binding(item.root), listed.snapshotToken));
    assert.strictEqual(fs.existsSync(first.target), true);
  } finally { item.cleanup(); }
});

test('empty rejects a concurrent replacement without deleting any snapshot peer', () => {
  const item = fixture();
  try {
    const first = item.add();
    const second = item.add();
    const service = deterministic();
    const listed = service.list(binding(item.root));
    fs.unlinkSync(second.target);
    fs.writeFileSync(second.target, 'replacement');
    expectCode('IMAGE_TRASH_STALE', () =>
      service.empty(binding(item.root), listed.snapshotToken));
    assert.strictEqual(fs.existsSync(first.target), true);
    assert.strictEqual(fs.readFileSync(second.target, 'utf8'), 'replacement');
  } finally { item.cleanup(); }
});

test('empty preserves a replacement that wins the commit-path race', () => {
  const item = fixture();
  const originalRename = fs.renameSync;
  let injected = false;
  try {
    const first = item.add();
    const second = item.add();
    const foreign = png(0x66);
    const fileSystem = Object.create(fs);
    fileSystem.renameSync = (source, target) => {
      if (!injected && source === first.target) {
        injected = true;
        fs.unlinkSync(source);
        fs.writeFileSync(source, foreign);
      }
      return originalRename(source, target);
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    expectCode('IMAGE_TRASH_STALE', () =>
      service.empty(binding(item.root), listed.snapshotToken));
    assert.deepStrictEqual(fs.readFileSync(first.target), foreign);
    assert.strictEqual(fs.existsSync(second.target), true);
  } finally { item.cleanup(); }
});

test('empty rejects a same-inode same-size rewrite captured after list', () => {
  const item = fixture();
  try {
    const first = item.add(png(0x11));
    const second = item.add(png(0x22));
    const service = deterministic();
    const listed = service.list(binding(item.root));
    const replacement = png(0x33);
    fs.writeFileSync(first.target, replacement);
    expectCode('IMAGE_TRASH_STALE', () =>
      service.empty(binding(item.root), listed.snapshotToken));
    assert.deepStrictEqual(fs.readFileSync(first.target), replacement);
    assert.strictEqual(fs.existsSync(second.target), true);
  } finally { item.cleanup(); }
});

test('partial empty is committed and exact retry removes only remaining snapshot entries', () => {
  const item = fixture();
  const originalUnlink = fs.unlinkSync;
  let calls = 0;
  try {
    item.add();
    item.add();
    const fileSystem = Object.create(fs);
    fileSystem.unlinkSync = target => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('injected'), { code: 'EIO' });
      return originalUnlink(target);
    };
    const service = deterministic({ fileSystem });
    const listed = service.list(binding(item.root));
    expectCode('IMAGE_TRASH_EMPTY_FAILED', () =>
      service.empty(binding(item.root), listed.snapshotToken), {
      committed: true,
      retryable: true,
    });
    const recovered = service.empty(binding(item.root), listed.snapshotToken);
    assert.strictEqual(recovered.emptiedCount, 2);
    assert.strictEqual(recovered.responseRecovered, true);
    assert.deepStrictEqual(fs.readdirSync(item.trash), []);
  } finally { item.cleanup(); }
});

test('empty detects quarantine unlink committed-then-threw and retry never widens the snapshot', () => {
  const item = fixture();
  const originalUnlink = fs.unlinkSync;
  let injected = false;
  try {
    const first = item.add();
    const second = item.add();
    const service = deterministic({
      fileSystem: Object.assign(Object.create(fs), {
        unlinkSync(target) {
          if (!injected && target.includes(`${path.sep}image-trash-operations${path.sep}`)) {
            injected = true;
            originalUnlink(target);
            throw Object.assign(new Error('committed then threw'), { code: 'EIO' });
          }
          return originalUnlink(target);
        },
      }),
    });
    const listed = service.list(binding(item.root));
    const committed = service.empty(binding(item.root), listed.snapshotToken);
    assert.strictEqual(committed.emptiedCount, 2);
    const late = item.add();
    const result = service.empty(binding(item.root), listed.snapshotToken);
    assert.strictEqual(result.emptiedCount, 2);
    assert.strictEqual(result.responseRecovered, true);
    assert.strictEqual(fs.existsSync(first.target), false);
    assert.strictEqual(fs.existsSync(second.target), false);
    assert.strictEqual(fs.existsSync(late.target), true);
  } finally { item.cleanup(); }
});

test('restore and empty retry directory fsync after the mutation already committed', () => {
  for (const action of ['restore', 'empty']) {
    const item = fixture();
    let failed = false;
    const fileSystem = Object.create(fs);
    fileSystem.fsyncSync = descriptor => {
      if (!failed && fs.fstatSync(descriptor).isDirectory()) {
        failed = true;
        throw Object.assign(new Error('injected fsync'), { code: 'EIO' });
      }
      return fs.fsyncSync(descriptor);
    };
    try {
      item.add();
      const service = deterministic({ fileSystem });
      const listed = service.list(binding(item.root));
      const token = action === 'restore' ? listed.items[0].token : listed.snapshotToken;
      expectCode('IMAGE_TRASH_COMMITTED_WARNING', () =>
        service[action](binding(item.root), token), {
        committed: true,
        retryable: true,
      });
      const recovered = service[action](binding(item.root), token);
      assert.strictEqual(recovered.responseRecovered, true);
    } finally { item.cleanup(); }
  }
});

test('committed restore and partial empty remain exactly retryable after live TTL', () => {
  for (const action of ['restore', 'empty']) {
    const item = fixture();
    let time = Date.parse('2026-07-27T09:00:00.000Z');
    let failed = false;
    const fileSystem = Object.create(fs);
    if (action === 'restore') {
      fileSystem.fsyncSync = descriptor => {
        if (!failed && fs.fstatSync(descriptor).isDirectory()) {
          failed = true;
          throw Object.assign(new Error('injected fsync'), { code: 'EIO' });
        }
        return fs.fsyncSync(descriptor);
      };
    } else {
      fileSystem.unlinkSync = target => {
        if (!failed && target.includes(`${path.sep}image-trash-operations${path.sep}`)) {
          failed = true;
          throw Object.assign(new Error('injected unlink'), { code: 'EIO' });
        }
        return fs.unlinkSync(target);
      };
    }
    try {
      item.add();
      const service = deterministic({
        fileSystem,
        now: () => new Date(time),
        ttlMs: 1000,
      });
      const listed = service.list(binding(item.root));
      const token = action === 'restore' ? listed.items[0].token : listed.snapshotToken;
      expectCode(
        action === 'restore'
          ? 'IMAGE_TRASH_COMMITTED_WARNING'
          : 'IMAGE_TRASH_EMPTY_FAILED',
        () => service[action](binding(item.root), token),
        { committed: true, retryable: true }
      );
      time += 1001;
      assert.strictEqual(
        service[action](binding(item.root), token).responseRecovered,
        true
      );
    } finally { item.cleanup(); }
  }
});

test('binding drift, expiry and capacity invalidate or refuse capabilities', () => {
  const item = fixture();
  let time = Date.parse('2026-07-27T09:00:00.000Z');
  try {
    item.add();
    const service = deterministic({ now: () => new Date(time), ttlMs: 1000 });
    const listed = service.list(binding(item.root));
    for (const drift of [
      { webContentsId: 8 },
      { projectInstanceId: 'project-b' },
      { mutationGeneration: 4 },
      { navigationEpoch: 3 },
    ]) {
      expectCode('IMAGE_TRASH_STALE', () =>
        service.restore(binding(item.root, drift), listed.items[0].token));
    }
    time += 1001;
    expectCode('IMAGE_TRASH_STALE', () =>
      service.restore(binding(item.root), listed.items[0].token));
    expectCode('IMAGE_TRASH_CAPACITY', () =>
      deterministic({ capacity: 1 }).list(binding(item.root)));
  } finally { item.cleanup(); }
});

test('refresh supersedes old live capabilities instead of exhausting owner capacity', () => {
  const item = fixture();
  try {
    item.add();
    const service = deterministic({ capacity: 2 });
    const first = service.list(binding(item.root));
    const second = service.list(binding(item.root));
    assert.notStrictEqual(first.items[0].token, second.items[0].token);
    expectCode('IMAGE_TRASH_STALE', () =>
      service.restore(binding(item.root), first.items[0].token));
    assert.strictEqual(
      service.restore(binding(item.root), second.items[0].token).restored,
      true
    );
  } finally { item.cleanup(); }
});

test('terminal response recovery is still bounded by the original token TTL', () => {
  const item = fixture();
  let time = Date.parse('2026-07-27T09:00:00.000Z');
  try {
    item.add();
    const service = deterministic({ now: () => new Date(time), ttlMs: 1000 });
    const listed = service.list(binding(item.root));
    service.empty(binding(item.root), listed.snapshotToken);
    assert.strictEqual(
      service.empty(binding(item.root), listed.snapshotToken).responseRecovered,
      true
    );
    time += 1001;
    expectCode('IMAGE_TRASH_STALE', () =>
      service.empty(binding(item.root), listed.snapshotToken));
  } finally { item.cleanup(); }
});

console.log(`\n✅ image trash service ${passed}/${passed} checks passed.\n`);
