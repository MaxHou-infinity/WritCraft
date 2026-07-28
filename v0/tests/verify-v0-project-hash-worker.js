#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { once } = require('events');
const {
  HELPER_PATH,
  createProjectHashWorker,
  encodeBatch,
} = require('../src/main/project-hash-worker');

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function identity(target) {
  const stat = fs.lstatSync(target, { bigint: true });
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function item(root, relative) {
  const parts = relative.split('/');
  const ancestors = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    ancestors.push(identity(path.join(root, ...parts.slice(0, index + 1))));
  }
  const leaf = identity(path.join(root, ...parts));
  return Object.freeze({
    relative,
    maxBytes: Number(leaf.size),
    identity: leaf,
    ancestors: Object.freeze(ancestors),
  });
}

async function closeWorker(worker) {
  const closed = worker.closed ? Promise.resolve() : once(worker.child, 'close');
  worker.close();
  await closed;
}

async function run() {
  console.log('\nWritCraft native project hash worker verification');

  await check('ships one executable universal project hash helper', () => {
    fs.accessSync(HELPER_PATH, fs.constants.R_OK | fs.constants.X_OK);
    const architectures = childProcess.execFileSync('lipo', [
      '-archs',
      HELPER_PATH,
    ], { encoding: 'utf8' }).trim().split(/\s+/).sort();
    assert.deepStrictEqual(architectures, ['arm64', 'x86_64']);
  });

  await check('rejects platforms missing required directory no-follow flags', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    try {
      assert.throws(
        () => createProjectHashWorker(root, {
          openConstants: { O_RDONLY: fs.constants.O_RDONLY },
        }),
        error => error?.code === 'PROJECT_WATCHER_HASH_UNSUPPORTED'
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('native helper rejects a malformed batch as one terminal protocol failure', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      const result = childProcess.spawnSync(HELPER_PATH, [], {
        input: 'B\t7\t1\nBROKEN\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe', rootFd],
      });
      assert.strictEqual(result.status, 1);
      assert.strictEqual(result.stdout, 'E\t7\tERR\tPROTOCOL\n');
      assert.strictEqual(result.stderr, '');
    } finally {
      fs.closeSync(rootFd);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('hashes a nested Markdown file through the bound root worker', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const chapter = path.join(root, 'chapters', 'one.md');
    fs.mkdirSync(path.dirname(chapter), { recursive: true });
    fs.writeFileSync(chapter, 'nested trusted content');
    const worker = createProjectHashWorker(root);
    try {
      const results = await worker.hash([item(root, 'chapters/one.md')]);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].ok, true);
      assert.strictEqual(
        results[0].digest,
        crypto.createHash('sha256').update('nested trusted content').digest('hex').slice(0, 16)
      );
    } finally {
      await closeWorker(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('rejects a scan-to-open ancestor symlink before following the leaf', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const chapters = path.join(root, 'chapters');
    const moved = path.join(root, '.original-chapters');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(chapters, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(chapters, 'one.md'), 'shared inode content');
    fs.linkSync(path.join(chapters, 'one.md'), path.join(outside, 'one.md'));
    const expected = item(root, 'chapters/one.md');
    let attacked = false;
    const worker = createProjectHashWorker(root, {
      beforeHashOpen({ relative }) {
        if (!attacked && relative === 'chapters/one.md') {
          attacked = true;
          fs.renameSync(chapters, moved);
          fs.symlinkSync(outside, chapters);
        }
      },
    });
    try {
      const results = await worker.hash([expected]);
      assert.deepStrictEqual(results, [{ ok: false, reason: 'PATH' }]);
      assert.strictEqual(
        fs.realpathSync(path.join(chapters, 'one.md')),
        fs.realpathSync(path.join(outside, 'one.md'))
      );
    } finally {
      if (fs.lstatSync(chapters).isSymbolicLink()) fs.unlinkSync(chapters);
      if (fs.existsSync(moved)) fs.renameSync(moved, chapters);
      await closeWorker(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('rejects a same-leaf hardlink behind a different real ancestor identity', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const chapters = path.join(root, 'chapters');
    const moved = path.join(root, '.original-chapters');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(chapters, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(chapters, 'one.md'), 'shared inode content');
    fs.linkSync(path.join(chapters, 'one.md'), path.join(outside, 'one.md'));
    const expected = item(root, 'chapters/one.md');
    let attacked = false;
    const worker = createProjectHashWorker(root, {
      beforeHashOpen({ relative }) {
        if (!attacked && relative === 'chapters/one.md') {
          attacked = true;
          fs.renameSync(chapters, moved);
          fs.renameSync(outside, chapters);
        }
      },
    });
    try {
      const results = await worker.hash([expected]);
      assert.deepStrictEqual(results, [{ ok: false, reason: 'IDENTITY' }]);
      assert.strictEqual(identity(path.join(chapters, 'one.md')).ino, expected.identity.ino);
    } finally {
      if (fs.existsSync(chapters) && fs.existsSync(moved)) {
        fs.renameSync(chapters, outside);
        fs.renameSync(moved, chapters);
      }
      await closeWorker(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('rejects root replacement and resumes only after the original root identity returns', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const moved = path.join(scratch, 'original-project');
    const target = path.join(root, 'one.md');
    fs.mkdirSync(root);
    fs.writeFileSync(target, 'bound root content');
    const expected = item(root, 'one.md');
    const worker = createProjectHashWorker(root);
    try {
      fs.renameSync(root, moved);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'one.md'), 'replacement root content');
      await assert.rejects(
        worker.hash([expected]),
        error => error?.code === 'PROJECT_WATCHER_ROOT_CHANGED'
      );
      fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(moved, root);
      const results = await worker.hash([expected]);
      assert.strictEqual(results[0].ok, true);
      assert.strictEqual(
        results[0].digest,
        crypto.createHash('sha256').update('bound root content').digest('hex').slice(0, 16)
      );
    } finally {
      if (!fs.existsSync(root) && fs.existsSync(moved)) fs.renameSync(moved, root);
      await closeWorker(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('propagates an unexpected helper exit and leaves no live child', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const target = path.join(root, 'one.md');
    const failingHelper = path.join(scratch, 'failing-helper');
    fs.mkdirSync(root);
    fs.writeFileSync(target, 'content');
    fs.writeFileSync(failingHelper, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    const worker = createProjectHashWorker(root, { helperPath: failingHelper });
    try {
      await assert.rejects(
        worker.hash([item(root, 'one.md')]),
        error => error?.code === 'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE'
      );
      if (!worker.closed) await once(worker.child, 'close');
      assert.strictEqual(worker.closed, true);
    } finally {
      worker.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('turns a malformed successful identity response into a bounded protocol failure', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-hash-'));
    const root = path.join(scratch, 'project');
    const target = path.join(root, 'one.md');
    const malformedHelper = path.join(scratch, 'malformed-helper');
    fs.mkdirSync(root);
    fs.writeFileSync(target, 'content');
    fs.writeFileSync(malformedHelper, [
      '#!/bin/sh',
      'IFS= read -r header || exit 1',
      "printf 'R\\t1\\tOK\\t0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\\tbad\\t2\\t3\\t4\\t5\\t6\\t7\\n'",
      'sleep 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const worker = createProjectHashWorker(root, { helperPath: malformedHelper });
    try {
      await assert.rejects(
        worker.hash([item(root, 'one.md')]),
        error => error?.code === 'PROJECT_WATCHER_HASH_PROTOCOL'
      );
      if (!worker.closed) await once(worker.child, 'close');
      assert.strictEqual(worker.closed, true);
    } finally {
      worker.close();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('rejects invalid paths and aggregate budgets before native work', () => {
    const fakeIdentity = Object.freeze({
      dev: 1n,
      ino: 2n,
      size: 1n,
      mode: 0o100600n,
      nlink: 1n,
      mtimeNs: 3n,
      ctimeNs: 4n,
    });
    assert.throws(() => encodeBatch(1, [{
      relative: '../escape.md',
      maxBytes: 1,
      identity: fakeIdentity,
      ancestors: [],
    }]), error => error?.code === 'PROJECT_WATCHER_HASH_PROTOCOL');
    assert.throws(() => encodeBatch(1, [{
      relative: 'large.md',
      maxBytes: (5 * 1024 * 1024) + 1,
      identity: fakeIdentity,
      ancestors: [],
    }]), error => error?.code === 'PROJECT_WATCHER_HASH_PROTOCOL');
  });

  console.log(`\n${passed}/10 native project hash worker checks passed.`);
  if (passed !== 10) process.exitCode = 1;
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
