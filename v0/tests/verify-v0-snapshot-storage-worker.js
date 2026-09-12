'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const schema = require('../src/main/evidence-delivery-schema');
const bundleService = require('../src/main/snapshot-bundle');
const {
  captureMetadataFramingBytes,
  createSnapshotStorageWorkerForRoot,
} = require('../src/main/snapshot-storage-worker');

const SOURCE = path.join(__dirname, '..', 'native', 'snapshot-storage-helper.c');
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function compile(scratch, definitions = []) {
  const output = path.join(scratch, 'snapshot-storage-helper');
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    `-DWRITCRAFT_APP_VERSION=\"${require('../package.json').version}\"`,
    ...definitions.map(value => `-D${value}`), SOURCE, '-o', output,
  ]);
  return output;
}

function productionRequest(overrides = {}) {
  const transactionId = `stx_${'1'.repeat(32)}`;
  const snapshotId = `snap_${'2'.repeat(32)}`;
  return {
    transactionId,
    projectInstanceId: `instance_${'a'.repeat(24)}`,
    snapshotId,
    ownerGeneration: 17,
    creationMutationGeneration: 23,
    createdAt: '2026-08-08T00:00:00.000Z',
    stageBasename: `stage-${crypto.createHash('sha256').update(transactionId).digest('hex')}.wcsb`,
    finalBasename: `bundle-${crypto.createHash('sha256').update(snapshotId).digest('hex')}.wcsb`,
    signal: null,
    ...overrides,
  };
}

function scriptedSpawn(onCommand) {
  return function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child._closed = false;
    child.reply = line => child.stdout.write(Buffer.from(line, 'ascii'));
    child.closeNow = () => {
      if (child._closed) return;
      child._closed = true;
      child.stdin.destroy();
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit('close', 91, null));
    };
    let buffered = '';
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        buffered += chunk.toString('ascii');
        try {
          while (buffered.includes('\n')) {
            const newline = buffered.indexOf('\n');
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            onCommand(line, child);
          }
          callback();
        } catch (error) {
          callback(error);
        }
      },
    });
    child.kill = () => {
      child.killed = true;
      child.closeNow();
      return true;
    };
    return child;
  };
}

function boundScript(onProductionCommand) {
  return scriptedSpawn((line, child) => {
    if (line.startsWith('P\t')) {
      child.reply(`P\tOK\t1\t2\t${process.getuid()}\t493\n`);
      return;
    }
    if (line === 'D' || line === 'I') {
      child.reply(
        `${line}\tOK\tcontrol\t3\t4\t${process.getuid()}\t448` +
        `\tbundles\t5\t6\t${process.getuid()}\t448` +
        `\tquarantine\t7\t8\t${process.getuid()}\t448\n`
      );
      return;
    }
    if (line === 'X') {
      child.reply('X\tOK\n');
      return;
    }
    onProductionCommand(line, child);
  });
}

function setup(scratch, projectName = 'project') {
  const project = path.join(scratch, projectName);
  const root = path.join(project, '.writcraft', 'snapshots', 'v1');
  fs.mkdirSync(path.join(root, 'bundles'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'control'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'quarantine'), { mode: 0o700 });
  for (const target of [
    path.join(project, '.writcraft'),
    path.join(project, '.writcraft', 'snapshots'),
    root,
    path.join(root, 'bundles'),
    path.join(root, 'control'),
    path.join(root, 'quarantine'),
  ]) fs.chmodSync(target, 0o700);
  return { project, root };
}

async function close(worker) {
  try { await worker.close(); } catch (_) {}
}

function stageRequest(content) {
  return {
    transactionId: `txn_${'1'.repeat(48)}`,
    snapshotId: `snapshot_${'2'.repeat(48)}`,
    stageBasename: `stage-${'3'.repeat(64)}.wcsb`,
    expectedBytes: content.length,
  };
}

function bundleFixture() {
  const content = Buffer.from('# Worker\n\n真实 bundle 😀\n', 'utf8');
  const header = {
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: 'file_worker_a',
    path: 'chapters/worker.md',
    kind: 'markdown',
    byteLength: content.length,
    sha256: bundleService.digestBytes(content),
  };
  const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
  const file = {
    fileId: header.fileId,
    path: header.path,
    kind: header.kind,
    mode: 0o600,
    byteLength: content.length,
    sha256: header.sha256,
    revision: header.sha256.slice(7),
    ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
    bundleObjectDigest: bundleService.bundleObjectDigest(headerBytes, content),
    references: [],
  };
  const manifest = {
    schema: schema.SCHEMAS.SNAPSHOT,
    projectInstanceId: `instance_${'a'.repeat(24)}`,
    snapshotId: `snapshot_${'2'.repeat(48)}`,
    createdAt: '2026-08-06T00:00:00.000Z',
    creationMutationGeneration: 1,
    rootIdentityDigest: `sha256:${'3'.repeat(64)}`,
    files: [file],
    fileRevisionSetDigest: null,
    budgets: {
      limits: { ...bundleService.SNAPSHOT_LIMITS },
      observed: {
        markdownFiles: 1, imageFiles: 0, totalItems: 1,
        markdownBytes: content.length, imageBytes: 0, snapshotBytes: content.length,
        manifestBytes: 0, privateMetadataBytes: 0,
      },
    },
    producerVersion: '0.3.0-stage-a',
    snapshotManifestDigest: null,
  };
  manifest.fileRevisionSetDigest = schema.createFileRevisionSetDigest([{
    fileId: file.fileId, path: file.path, revision: file.revision, sha256: file.sha256,
  }]).digest;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    manifest.snapshotManifestDigest = schema.digestObject(
      schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest'
    );
    const length = Buffer.byteLength(schema.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === length) break;
    manifest.budgets.observed.manifestBytes = length;
  }
  manifest.snapshotManifestDigest = schema.digestObject(
    schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest'
  );
  const created = bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]);
  return { ...created, manifest };
}

async function run() {
  console.log('WritCraft 0.4.0 snapshot storage worker tests');

  await check('committed snapshot read accepts only snapshotId and returns shared-parser exact bytes', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    const markdown = Buffer.from('# exact committed read\n\n字节 😀\n', 'utf8');
    fs.writeFileSync(path.join(data.project, 'read.md'), markdown, { mode: 0o600 });
    const creator = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
    });
    let reader = null;
    try {
      const request = productionRequest();
      const created = await creator.createProductionSnapshot(request);
      assert.strictEqual(created.state, 'COMMITTED');
      await creator.close();
      reader = createSnapshotStorageWorkerForRoot(data.project, { helperPath: compile(scratch) });
      const read = await reader.readCommittedSnapshot({ snapshotId: request.snapshotId });
      assert.strictEqual(read.snapshotId, request.snapshotId);
      assert.strictEqual(read.snapshotManifestDigest, created.snapshotManifestDigest);
      assert.strictEqual(read.publishedIdentityDigest, created.publishedIdentityDigest);
      assert.strictEqual(read.receiptDigest, created.receiptDigest);
      assert.strictEqual(read.entries.length, 1);
      assert.strictEqual(read.entries[0].fileId, read.manifest.files[0].fileId);
      assert.deepStrictEqual(read.entries[0].content, markdown);
      await assert.rejects(
        reader.readCommittedSnapshot({ snapshotId: request.snapshotId, path: 'read.md' }),
        error => error?.code === 'INVALID_SCHEMA_KEYS'
      );
      await assert.rejects(
        reader.readCommittedSnapshot({ snapshotId: `snap_${'9'.repeat(32)}` }),
        error => error?.code === 'SNAPSHOT_UNAVAILABLE' && !error.message.includes(data.project)
      );
    } finally {
      await close(reader || creator);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('corrupt or permission-drifted committed leaves are explicit unavailable items, never an empty list', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(path.join(data.project, 'corrupt.md'), '# original\n', { mode: 0o600 });
    const helperPath = compile(scratch);
    const request = productionRequest();
    const creator = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
    let reader = null;
    try {
      assert.strictEqual((await creator.createProductionSnapshot(request)).state, 'COMMITTED');
      await creator.close();
      const finalName = `bundle-${crypto.createHash('sha256').update(request.snapshotId).digest('hex')}.wcsb`;
      const finalPath = path.join(data.root, 'bundles', finalName);
      const originalBundle = fs.readFileSync(finalPath);
      const fd = fs.openSync(finalPath, 'r+');
      fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 0);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      reader = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      const listed = await reader.listCommitted();
      assert.deepStrictEqual(listed.items, []);
      assert.strictEqual(listed.unavailableCount, 1);
      assert.strictEqual(listed.unavailableItems.length, 1);
      assert.strictEqual(listed.unavailableItems[0].reason, 'BUNDLE_UNAVAILABLE');
      assert(!JSON.stringify(listed).includes(finalName));
      await assert.rejects(
        reader.readCommittedSnapshot({ snapshotId: request.snapshotId }),
        error => error?.code === 'SNAPSHOT_UNAVAILABLE'
      );
      await close(reader);
      fs.writeFileSync(finalPath, originalBundle, { mode: 0o600 });
      fs.chmodSync(finalPath, 0o644);
      reader = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      const permissionDrift = await reader.listCommitted();
      assert.deepStrictEqual(permissionDrift.items, []);
      assert.strictEqual(permissionDrift.unavailableItems[0].reason, 'BUNDLE_UNAVAILABLE');
    } finally {
      await close(reader || creator);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('committed read fails closed on bound storage ancestor and leaf replacement', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(path.join(data.project, 'replace.md'), '# original\n', { mode: 0o600 });
    const helperPath = compile(scratch);
    const request = productionRequest();
    const creator = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
    let reader = null;
    try {
      assert.strictEqual((await creator.createProductionSnapshot(request)).state, 'COMMITTED');
      await creator.close();
      reader = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      await reader.ready();
      const bundles = path.join(data.root, 'bundles');
      fs.renameSync(bundles, `${bundles}-old`);
      fs.mkdirSync(bundles, { mode: 0o700 });
      await assert.rejects(
        reader.readCommittedSnapshot({ snapshotId: request.snapshotId }),
        error => error?.code === 'SNAPSHOT_ROOT_CHANGED'
      );
    } finally {
      await close(reader || creator);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('committed read detects project-root and same-content leaf identity replacement', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const helperPath = compile(scratch);
    try {
      for (const mode of ['root', 'leaf']) {
        const data = setup(scratch, `project-${mode}`);
        fs.writeFileSync(path.join(data.project, 'replace.md'), '# immutable\n', { mode: 0o600 });
        const request = productionRequest({
          transactionId: `stx_${mode === 'root' ? '3' : '4'}${'1'.repeat(31)}`,
          snapshotId: `snap_${mode === 'root' ? '5' : '6'}${'2'.repeat(31)}`,
        });
        request.stageBasename = `stage-${crypto.createHash('sha256').update(request.transactionId).digest('hex')}.wcsb`;
        request.finalBasename = `bundle-${crypto.createHash('sha256').update(request.snapshotId).digest('hex')}.wcsb`;
        const creator = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
        assert.strictEqual((await creator.createProductionSnapshot(request)).state, 'COMMITTED');
        await creator.close();
        const reader = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
        await reader.ready();
        if (mode === 'root') {
          fs.renameSync(data.project, `${data.project}-old`);
          setup(scratch, `project-${mode}`);
          await assert.rejects(
            reader.readCommittedSnapshot({ snapshotId: request.snapshotId }),
            error => error?.code === 'SNAPSHOT_ROOT_CHANGED'
          );
        } else {
          const finalPath = path.join(data.root, 'bundles', request.finalBasename);
          const exact = fs.readFileSync(finalPath);
          fs.renameSync(finalPath, `${finalPath}.old`);
          fs.writeFileSync(finalPath, exact, { mode: 0o600, flag: 'wx' });
          await assert.rejects(
            reader.readCommittedSnapshot({ snapshotId: request.snapshotId }),
            error => error?.code === 'SNAPSHOT_UNAVAILABLE'
          );
        }
        await close(reader);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('untrusted committed-read framing rejects corruption/partial streams and close cannot tear down an owned read', async () => {
    const fixture = bundleFixture();
    const digest = value => `sha256:${value.repeat(64)}`;
    for (const responder of [
      (_line, child) => child.reply(
        `O\tSTART\t${fixture.manifest.snapshotId}\t${fixture.manifest.snapshotManifestDigest}` +
        `\t${digest('1')}\t${digest('2')}\t${fixture.bundlePayloadSha256}\t${fixture.bundle.length}\n` +
        'O\tBYTES\t0\tzz\n'
      ),
      (_line, child) => {
        child.reply(
          `O\tSTART\t${fixture.manifest.snapshotId}\t${fixture.manifest.snapshotManifestDigest}` +
          `\t${digest('1')}\t${digest('2')}\t${fixture.bundlePayloadSha256}\t${fixture.bundle.length}\n` +
          `O\tBYTES\t0\t${fixture.bundle.subarray(0, 8).toString('hex')}\n`
        );
        child.closeNow();
      },
    ]) {
      const worker = createSnapshotStorageWorkerForRoot('/private/tmp', {
        spawn: boundScript((line, child) => responder(line, child)),
      });
      try {
        await assert.rejects(
          worker.readCommittedSnapshot({ snapshotId: fixture.manifest.snapshotId }),
          error => ['SNAPSHOT_STORAGE_PROTOCOL', 'SNAPSHOT_HELPER_UNAVAILABLE'].includes(error?.code)
        );
      } finally {
        await close(worker);
      }
    }

    let ownedChild = null;
    const worker = createSnapshotStorageWorkerForRoot('/private/tmp', {
      spawn: boundScript((line, child) => {
        if (!line.startsWith('O\t')) return;
        ownedChild = child;
        setTimeout(() => child.reply(
          `O\tSTART\t${fixture.manifest.snapshotId}\t${fixture.manifest.snapshotManifestDigest}` +
          `\t${digest('1')}\t${digest('2')}\t${fixture.bundlePayloadSha256}\t${fixture.bundle.length}\n` +
          `O\tBYTES\t0\t${fixture.bundle.toString('hex')}\n` +
          `O\tOK\t${fixture.bundle.length}\n`
        ), 20);
      }),
    });
    const reading = worker.readCommittedSnapshot({ snapshotId: fixture.manifest.snapshotId });
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => worker.close(), error => error?.code === 'SNAPSHOT_STORAGE_BUSY');
    assert.strictEqual((await reading).entries.length, 1);
    assert(ownedChild && !ownedChild.killed);
    await worker.close();
  });

  await check('expected project identity rejects a replacement before native storage initialization', async () => {
    const commands = [];
    const worker = createSnapshotStorageWorkerForRoot('/private/tmp', {
      initializeStorage: true,
      expectedRootIdentity: { dev: 999, ino: 1000 },
      spawn: scriptedSpawn((line, child) => {
        commands.push(line.split('\t')[0]);
        if (line.startsWith('P\t')) {
          child.reply(`P\tOK\t1\t2\t${process.getuid()}\t493\n`);
        }
      }),
    });
    try {
      await assert.rejects(worker.ready(), error => error?.code === 'SNAPSHOT_ROOT_CHANGED');
      assert.deepStrictEqual(commands, ['P']);
    } finally {
      await close(worker);
    }
  });

  await check('production create streams sealed Markdown through shared marked and returns formal COMMITTED truth', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.mkdirSync(path.join(data.project, 'chapters'));
    fs.writeFileSync(
      path.join(data.project, 'chapters', 'worker.md'),
      `# exact\n\n${'sealed 😀\n'.repeat(9000)}`,
      { mode: 0o600 }
    );
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
    });
    try {
      const request = productionRequest();
      const result = await worker.createProductionSnapshot(request);
      assert.strictEqual(result.state, 'COMMITTED');
      assert.strictEqual(result.transactionId, request.transactionId);
      assert.strictEqual(result.snapshotId, request.snapshotId);
      assert.strictEqual(result.stageBasename, request.stageBasename);
      assert.strictEqual(result.finalBasename, request.finalBasename);
      schema.assertDigest(result.snapshotManifestDigest, 'snapshotManifestDigest');
      schema.assertDigest(result.publishedIdentityDigest, 'publishedIdentityDigest');
      schema.assertDigest(result.receiptDigest, 'receiptDigest');
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('production worker returns formal UNCOMMITTED when native private byte capacity is full', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(path.join(data.project, 'capacity.md'), '# capacity\n', { mode: 0o600 });
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch, ['WRITCRAFT_TEST_MAX_COMMITTED_PRIVATE_BYTES=1024']),
    });
    try {
      const request = productionRequest();
      const result = await worker.createProductionSnapshot(request);
      assert.deepStrictEqual(result, {
        transactionId: request.transactionId,
        snapshotId: request.snapshotId,
        stageBasename: request.stageBasename,
        finalBasename: request.finalBasename,
        state: 'UNCOMMITTED',
        snapshotManifestDigest: result.snapshotManifestDigest,
        reason: 'SNAPSHOT_CAPACITY_EXCEEDED',
      });
      schema.assertDigest(result.snapshotManifestDigest, 'snapshotManifestDigest');
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
      assert.strictEqual(fs.readdirSync(path.join(data.root, 'control')).some(name =>
        name.startsWith('stage-') || name.startsWith('recovery-')
      ), false);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('production COMMITTED response loss requires a fresh worker and exact R only', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(path.join(data.project, 'worker.md'), '# lost response\n', { mode: 0o600 });
    const request = productionRequest();
    const dropping = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch, ['WRITCRAFT_TEST_DROP_PRODUCTION_COMMITTED_RESPONSE']),
    });
    try {
      await assert.rejects(
        dropping.createProductionSnapshot(request),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED' &&
          error?.captureOutcome === 'STAGE_MAY_EXIST'
      );
      await assert.rejects(
        dropping.reconcileProductionCreate({
          transactionId: request.transactionId,
          snapshotId: request.snapshotId,
          stageBasename: request.stageBasename,
          finalBasename: request.finalBasename,
          observedAt: '2026-08-08T00:01:00.000Z',
        }),
        error => error?.code === 'SNAPSHOT_HELPER_UNAVAILABLE' ||
          error?.code === 'SNAPSHOT_RECOVERY_REQUIRED' ||
          error?.code === 'SNAPSHOT_STORAGE_BUSY'
      );
    } finally {
      await close(dropping);
    }
    const reconciler = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
    });
    try {
      const truth = await reconciler.reconcileProductionCreate({
        transactionId: request.transactionId,
        snapshotId: request.snapshotId,
        stageBasename: request.stageBasename,
        finalBasename: request.finalBasename,
        observedAt: '2026-08-08T00:01:00.000Z',
      });
      assert.strictEqual(truth.state, 'COMMITTED');
      schema.assertDigest(truth.publishedIdentityDigest, 'publishedIdentityDigest');
      schema.assertDigest(truth.receiptDigest, 'receiptDigest');
    } finally {
      await close(reconciler);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('fresh R waits for the old B helper close latch before observing a late commit', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    const request = productionRequest();
    let oldChild;
    let written = 0;
    let lateCommitted = false;
    let destroySettled = false;
    const oldSpawn = boundScript((line, child) => {
      const fields = line.split('\t');
      if (fields[0] === 'G') {
        child.reply(
          `G\tOK\t${request.transactionId}\tcapture_${'3'.repeat(64)}` +
          `\tsha256:${'4'.repeat(64)}\t0\t0\n`
        );
        return;
      }
      if (fields[0] === 'T') {
        child.reply(`T\tOK\t${request.transactionId}\t${fields[2]}\n`);
        return;
      }
      if (fields[0] === 'U') {
        written += fields[2].length / 2;
        child.reply(`U\tOK\t${request.transactionId}\t${written}\n`);
        return;
      }
      if (fields[0] === 'K') {
        child.reply(`K\tOK\t${request.transactionId}\t0\t0\n`);
        return;
      }
      if (fields[0] === 'B') {
        queueMicrotask(() => child.emit('error', new Error('B response lost')));
        return;
      }
      throw new Error(`unexpected old-worker command: ${fields[0]}`);
    });
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      spawn() {
        oldChild = oldSpawn();
        oldChild.kill = () => {
          oldChild.killed = true;
          return true;
        };
        return oldChild;
      },
      destroyTimeoutMs: 1000,
    });
    let reconciler = null;
    try {
      await assert.rejects(
        worker.createProductionSnapshot(request),
        error => error?.captureOutcome === 'STAGE_MAY_EXIST'
      );
      const reconcileAfterExit = (async () => {
        await worker.destroyForReconciliation();
        destroySettled = true;
        reconciler = createSnapshotStorageWorkerForRoot(data.project, {
          spawn: boundScript((line, child) => {
            const fields = line.split('\t');
            if (fields[0] !== 'R') throw new Error(`unexpected reconciler command: ${fields[0]}`);
            child.reply(lateCommitted
              ? `R\tOK\t${request.transactionId}\tCOMMITTED\tsha256:${'5'.repeat(64)}` +
                `\tsha256:${'6'.repeat(64)}\n`
              : `R\tOK\t${request.transactionId}\tUNCOMMITTED\n`);
          }),
        });
        return reconciler.reconcileProductionCreate({
          transactionId: request.transactionId,
          snapshotId: request.snapshotId,
          stageBasename: request.stageBasename,
          finalBasename: request.finalBasename,
          observedAt: '2026-08-08T00:01:00.000Z',
        });
      })();
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(destroySettled, false);
      assert.strictEqual(reconciler, null);
      lateCommitted = true;
      oldChild.closeNow();
      const truth = await reconcileAfterExit;
      assert.strictEqual(truth.state, 'COMMITTED');
    } finally {
      if (!oldChild?._closed) oldChild?.closeNow();
      if (reconciler) await close(reconciler);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('production G capacity error is proven precreate and legacy kernel never becomes a fallback', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(
      path.join(data.project, 'oversize.md'),
      Buffer.alloc((4 * 1024 * 1024) + 1, 0x61),
      { mode: 0o600 }
    );
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
    });
    try {
      await assert.rejects(
        worker.createProductionSnapshot(productionRequest()),
        error => error?.captureOutcome === 'PROVEN_PRECREATE'
      );
      await assert.rejects(
        worker.createStage(stageRequest(Buffer.from('x'))),
        error => error?.code === 'SNAPSHOT_TEST_KERNEL_DISABLED'
      );
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('Snapshot accepts 40, 41 and 200 images plus 300 Markdown files while rejecting 201 images', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const helperPath = compile(scratch);
    try {
      for (const imageCount of [40, 41, 200, 201]) {
        const data = setup(scratch, `project-${imageCount}`);
        fs.mkdirSync(path.join(data.project, 'assets'));
        const references = [];
        for (let index = 0; index < imageCount; index += 1) {
          references.push(`![image ${index}](assets/image-${index}.png)`);
          fs.writeFileSync(
            path.join(data.project, 'assets', `image-${index}.png`),
            Buffer.from([0x89, 0x50, 0x4e, 0x47, index & 0xff]),
            { mode: 0o600 }
          );
        }
        fs.writeFileSync(
          path.join(data.project, 'images.md'),
          `${references.join('\n')}\n`,
          { mode: 0o600 }
        );
        const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
        try {
          if (imageCount <= 200) {
            const result = await worker.createProductionSnapshot(productionRequest());
            assert.strictEqual(result.state, 'COMMITTED', `${imageCount} images`);
          } else {
            await assert.rejects(
              worker.createProductionSnapshot(productionRequest()),
              error => error?.captureOutcome === 'PROVEN_PRECREATE',
              '201 images must fail before B/private transaction creation'
            );
            assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
            assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
          }
        } finally {
          await close(worker);
        }
      }
      const maxMarkdown = setup(scratch, 'project-300-markdown');
      for (let index = 0; index < 300; index += 1) {
        fs.writeFileSync(
          path.join(maxMarkdown.project, `chapter-${String(index).padStart(3, '0')}.md`),
          '',
          { mode: 0o600 }
        );
      }
      const maxWorker = createSnapshotStorageWorkerForRoot(maxMarkdown.project, { helperPath });
      try {
        const result = await maxWorker.createProductionSnapshot(productionRequest());
        assert.strictEqual(result.state, 'COMMITTED');
      } finally {
        await close(maxWorker);
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('pre-B owner invalidation sends X and proves zero-write UNCOMMITTED', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    fs.writeFileSync(path.join(data.project, 'worker.md'), '# abort after G\n', { mode: 0o600 });
    const controller = new AbortController();
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
      beforeRequest({ kind }) {
        if (kind === 'production_token_begin') controller.abort('PROJECT_CHANGED');
      },
    });
    try {
      await assert.rejects(
        worker.createProductionSnapshot(productionRequest({ signal: controller.signal })),
        error => error?.code === 'SNAPSHOT_CAPTURE_ABORTED' &&
          error?.captureOutcome === 'PROVEN_UNCOMMITTED'
      );
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
      await worker.close();
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('untrusted G stdout rejects malformed numeric, oversized header, partial bytes and late exit without callback escape', async () => {
    const emptyDigest = `sha256:${crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')}`;
    const abcDigest = `sha256:${crypto.createHash('sha256').update('abc').digest('hex')}`;
    const captureId = `capture_${'c'.repeat(64)}`;
    const candidateId = `candidate_${'d'.repeat(64)}`;
    const captureDigest = `sha256:${'e'.repeat(64)}`;
    const goldenBytesLine = [
      'G', 'BYTES', captureId, candidateId, '123', '616263',
    ];
    const goldenWire = `${goldenBytesLine.join('\t')}\n`;
    assert.strictEqual(
      captureMetadataFramingBytes(goldenBytesLine),
      Buffer.byteLength(goldenWire, 'ascii') - Buffer.byteLength('616263', 'ascii')
    );
    const variants = [
      {
        name: 'malformed numeric',
        respond(request, child) {
          child.reply(
            `G\tMARKDOWN\t${captureId}\t${candidateId}\tfile_hostile\t01` +
            `\t${emptyDigest}\t${emptyDigest.slice(7)}\n`
          );
        },
      },
      {
        name: 'oversized header',
        respond(request, child) {
          child.reply(`G\t${'A'.repeat(140000)}\n`);
        },
      },
      {
        name: 'metadata framing overflow',
        respond(request, child) {
          const header =
            `G\tMARKDOWN\t${captureId}\t${candidateId}\tfile_hostile\t4000` +
            `\t${abcDigest}\t${abcDigest.slice(7)}\n`;
          const chunks = [];
          for (let offset = 0; offset < 4000; offset += 1) {
            chunks.push(`G\tBYTES\t${captureId}\t${candidateId}\t${offset}\t61\n`);
          }
          child.reply(header + chunks.join(''));
        },
      },
      {
        name: 'partial bytes',
        respond(request, child) {
          child.reply(
            `G\tMARKDOWN\t${captureId}\t${candidateId}\tfile_hostile\t3` +
            `\t${abcDigest}\t${abcDigest.slice(7)}\n` +
            `G\tBYTES\t${captureId}\t${candidateId}\t0\t61\n` +
            `G\tOK\t${request.transactionId}\t${captureId}\t${captureDigest}\t1\t3\n`
          );
        },
      },
      {
        name: 'unsafe terminal numeric',
        respond(request, child) {
          child.reply(
            `G\tMARKDOWN\t${captureId}\t${candidateId}\tfile_hostile\t0` +
            `\t${emptyDigest}\t${emptyDigest.slice(7)}\n` +
            `G\tOK\t${request.transactionId}\t${captureId}\t${captureDigest}` +
            `\t9007199254740992\t0\n`
          );
        },
      },
      {
        name: 'late exit',
        respond(request, child) {
          child.reply(
            `G\tMARKDOWN\t${captureId}\t${candidateId}\tfile_hostile\t0` +
            `\t${emptyDigest}\t${emptyDigest.slice(7)}\n` +
            `G\tOK\t${request.transactionId}\t${captureId}\t${captureDigest}\t1\t0\n`
          );
          child.closeNow();
        },
      },
    ];
    for (const variant of variants) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
      const data = setup(scratch);
      const request = productionRequest();
      const worker = createSnapshotStorageWorkerForRoot(data.project, {
        spawn: boundScript((line, child) => {
          if (line.startsWith('G\t')) variant.respond(request, child);
        }),
      });
      try {
        await assert.rejects(
          worker.createProductionSnapshot(request),
          error => error?.captureOutcome === 'STAGE_MAY_EXIST',
          variant.name
        );
        assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
        assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
      } finally {
        await close(worker);
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    }
  });

  await check('binds trusted identities and returns a schema-valid finalized stage', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    const fixture = bundleFixture();
    const content = fixture.bundle;
    const request = stageRequest(content);
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
      testOnlyKernel: true,
    });
    try {
      const binding = await worker.ready();
      schema.assertRootIdentity(binding.rootIdentity);
      for (const role of ['control', 'bundles', 'quarantine']) {
        assert.strictEqual(binding.parentIdentities[role].role, role);
        schema.assertSnapshotPrivateParentIdentity(binding.parentIdentities[role]);
      }
      await worker.createStage(request);
      assert.strictEqual(await worker.writeStage({ transactionId: request.transactionId, chunk: content }), content.length);
      const manifestDigest = fixture.manifest.snapshotManifestDigest;
      const identity = await worker.finalizeStage({
        transactionId: request.transactionId,
        snapshotManifestDigest: manifestDigest,
      });
      schema.assertSnapshotStageIdentity(identity, binding.parentIdentities.control);
      assert.strictEqual(identity.bundlePayloadSha256, fixture.bundlePayloadSha256);
      assert.deepStrictEqual(await worker.cancelStage({ transactionId: request.transactionId }), {
        state: 'UNCOMMITTED',
      });
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'bundles')), []);
      await Promise.all([worker.close(), worker.close()]);
      assert.strictEqual(worker.failed, null);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('rechecks close state after an awaited request hook', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    let worker;
    worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
      testOnlyKernel: true,
      async beforeRequest({ kind }) {
        if (kind === 'create_stage') await worker.close();
      },
    });
    try {
      await assert.rejects(worker.createStage(stageRequest(Buffer.from('x'))),
        error => error?.code === 'SNAPSHOT_HELPER_UNAVAILABLE');
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('fails closed when the project pathname is replaced after bind', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    let changed = false;
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch),
      testOnlyKernel: true,
      beforeRequest({ kind }) {
        if (kind !== 'create_stage' || changed) return;
        changed = true;
        fs.renameSync(data.project, `${data.project}-original`);
        setup(scratch);
      },
    });
    try {
      await assert.rejects(worker.createStage(stageRequest(Buffer.from('x'))),
        error => error?.code === 'SNAPSHOT_ROOT_CHANGED');
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
      assert.deepStrictEqual(fs.readdirSync(path.join(`${data.project}-original`, '.writcraft', 'snapshots', 'v1', 'control')), []);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('maps partial native write failure to recovery-required until exact cancel', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    const content = Buffer.alloc(64, 0x61);
    const request = stageRequest(content);
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath: compile(scratch, ['WRITCRAFT_TEST_PARTIAL_WRITE_FAIL']),
      testOnlyKernel: true,
    });
    try {
      await worker.createStage(request);
      await assert.rejects(worker.writeStage({ transactionId: request.transactionId, chunk: content }),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED');
      assert.deepStrictEqual(await worker.cancelStage({ transactionId: request.transactionId }), {
        state: 'UNCOMMITTED',
      });
      assert.deepStrictEqual(fs.readdirSync(path.join(data.root, 'control')), []);
    } finally {
      await close(worker);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('publishes, reconciles and lists only receipt-bound committed snapshots', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const data = setup(scratch);
    const fixture = bundleFixture();
    const request = stageRequest(fixture.bundle);
    const finalName = `bundle-${'4'.repeat(64)}.wcsb`;
    const helperPath = compile(scratch);
    const worker = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath,
      testOnlyKernel: true,
    });
    let published;
    try {
      await worker.createStage(request);
      await worker.writeStage({ transactionId: request.transactionId, chunk: fixture.bundle });
      await worker.finalizeStage({
        transactionId: request.transactionId,
        snapshotManifestDigest: fixture.manifest.snapshotManifestDigest,
      });
      published = await worker.publishStage({
        transactionId: request.transactionId,
        finalBasename: finalName,
        committedAt: '2026-08-06T05:00:00.000Z',
      });
      assert.strictEqual(published.state, 'COMMITTED');
      schema.assertSnapshotPublishedIdentity(published.publishedIdentity,
        (await worker.ready()).parentIdentities.bundles);
      const listed = await worker.listCommitted();
      assert.strictEqual(listed.unavailableCount, 0);
      assert.deepStrictEqual(listed.items.map(item => item.snapshotId), [request.snapshotId]);
      assert.strictEqual(listed.items[0].publishedIdentityDigest,
        published.publishedIdentityDigest);
    } finally {
      await close(worker);
    }
    const reconciler = createSnapshotStorageWorkerForRoot(data.project, {
      helperPath,
      testOnlyKernel: true,
    });
    try {
      const reconciled = await reconciler.reconcileCreate({
        transactionId: request.transactionId,
        snapshotId: request.snapshotId,
        stageBasename: request.stageBasename,
        finalBasename: finalName,
        observedAt: '2026-08-06T05:01:00.000Z',
        expectedPublishedIdentityDigest: published.publishedIdentityDigest,
      });
      assert.strictEqual(reconciled.state, 'COMMITTED');
      assert.strictEqual(reconciled.publishedIdentityDigest,
        published.publishedIdentityDigest);
    } finally {
      await close(reconciler);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  await check('maps missing roots and spawn failures to stable path-free errors', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-worker-'));
    const missing = path.join(scratch, 'private-project-name');
    try {
      assert.throws(() => createSnapshotStorageWorkerForRoot(missing), error =>
        error?.code === 'SNAPSHOT_ROOT_CHANGED' && !error.message.includes(missing));
      const data = setup(scratch);
      assert.throws(() => createSnapshotStorageWorkerForRoot(data.project, {
        spawn() { throw new Error(`spawn exposed ${data.project}`); },
      }), error => error?.code === 'SNAPSHOT_HELPER_UNAVAILABLE' &&
        !error.message.includes(data.project));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  console.log(`\n${passed}/${passed} snapshot storage worker tests passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
