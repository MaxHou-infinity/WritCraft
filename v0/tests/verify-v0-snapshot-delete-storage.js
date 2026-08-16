#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('../src/main/evidence-delivery-schema');
const {
  SnapshotStorageWorker,
  createSnapshotStorageWorkerForRoot,
} = require('../src/main/snapshot-storage-worker');

const SOURCE = path.join(__dirname, '..', 'native', 'snapshot-storage-helper.c');
const APP_VERSION = require('../package.json').version;
const PROJECT_INSTANCE_ID = `instance_${'a'.repeat(24)}`;
const CREATED_AT = '2026-08-09T08:00:00.000Z';
const OBSERVED_AT = '2026-08-09T08:01:00.000Z';
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
  const output = path.join(scratch, `snapshot-delete-${definitions.join('-') || 'normal'}`);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    `-DWRITCRAFT_APP_VERSION="${APP_VERSION}"`,
    ...definitions.map(value => `-D${value}`), SOURCE, '-o', output,
  ]);
  return output;
}

function setup(scratch, name = 'project') {
  const project = path.join(scratch, name);
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
  fs.writeFileSync(path.join(project, 'chapter.md'), '# Snapshot delete\n\n正文 😀\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return { project, root };
}

function createRequest(index = '1') {
  const transactionId = `create_${index.repeat(32)}`;
  const snapshotId = `snapshot_${index.repeat(32)}`;
  return {
    transactionId,
    projectInstanceId: PROJECT_INSTANCE_ID,
    snapshotId,
    ownerGeneration: 7,
    creationMutationGeneration: 11,
    createdAt: CREATED_AT,
    stageBasename: `stage-${crypto.createHash('sha256').update(transactionId).digest('hex')}.wcsb`,
    finalBasename: `bundle-${crypto.createHash('sha256').update(snapshotId).digest('hex')}.wcsb`,
    signal: null,
  };
}

function deleteRequest(created, index = 'd') {
  return {
    transactionId: `delete_${index.repeat(32)}`,
    projectInstanceId: PROJECT_INSTANCE_ID,
    snapshotId: created.snapshotId,
    ownerGeneration: 19,
    snapshotManifestDigest: created.snapshotManifestDigest,
    publishedIdentityDigest: created.publishedIdentityDigest,
    committedAt: CREATED_AT,
  };
}

function reconcileRequest(request) {
  const { committedAt: _committedAt, ...rest } = request;
  return { ...rest, observedAt: OBSERVED_AT };
}

function finalPath(data, snapshotId) {
  return path.join(
    data.root,
    'bundles',
    `bundle-${crypto.createHash('sha256').update(snapshotId).digest('hex')}.wcsb`
  );
}

async function createCommitted(data, helperPath, index = '1') {
  const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
  try {
    const created = await worker.createProductionSnapshot(createRequest(index));
    assert.strictEqual(created.state, 'COMMITTED');
    await worker.close();
    return created;
  } catch (error) {
    try { await worker.destroyForReconciliation(); } catch (_) {}
    throw error;
  }
}

async function destroy(worker) {
  if (!worker) return;
  try { await worker.destroyForReconciliation(); } catch (_) {}
}

async function waitFor(target, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`sync timeout: ${path.basename(target)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function syncRelease(sync, name) {
  fs.writeFileSync(path.join(sync, `${name}.release`), '', { flag: 'wx', mode: 0o600 });
}

function quarantineNames(data) {
  return fs.readdirSync(path.join(data.root, 'quarantine'));
}

function deleteControlNames(data) {
  return fs.readdirSync(path.join(data.root, 'control')).filter(name =>
    name.startsWith('delete-')
  );
}

async function withScratch(fn) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-delete-')));
  try {
    return await fn(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function pausedDelete({ scratch, macro, syncName, mutate }) {
  const data = setup(scratch);
  const normalHelper = compile(scratch);
  const created = await createCommitted(data, normalHelper);
  const request = deleteRequest(created);
  const sync = path.join(scratch, 'sync');
  fs.mkdirSync(sync, { mode: 0o700 });
  const helperPath = compile(scratch, [macro]);
  const worker = createSnapshotStorageWorkerForRoot(data.project, {
    helperPath,
    env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: sync },
  });
  const pending = worker.deleteCommittedSnapshot(request);
  pending.catch(() => {});
  await waitFor(path.join(sync, `${syncName}.ready`));
  await mutate({ data, created, request, sync, worker, pending, normalHelper });
  syncRelease(sync, syncName);
  return { data, created, request, worker, pending, normalHelper };
}

async function run() {
  console.log('WritCraft 0.4.0 snapshot native safe-delete storage tests');

  await check('keeps the delete APIs on the production worker surface', async () => {
    assert.strictEqual(typeof SnapshotStorageWorker.prototype.deleteCommittedSnapshot, 'function');
    assert.strictEqual(typeof SnapshotStorageWorker.prototype.reconcileDelete, 'function');
  });

  await check('rejects path/body/extra/getter delete inputs before native mutation', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const worker = createSnapshotStorageWorkerForRoot(data.project, {
        helperPath: compile(scratch),
      });
      await worker.ready();
      const digest = `sha256:${'1'.repeat(64)}`;
      const exact = {
        transactionId: `delete_${'a'.repeat(32)}`,
        projectInstanceId: PROJECT_INSTANCE_ID,
        snapshotId: `snapshot_${'b'.repeat(32)}`,
        ownerGeneration: 1,
        snapshotManifestDigest: digest,
        publishedIdentityDigest: digest,
        committedAt: CREATED_AT,
      };
      try {
        await assert.rejects(
          worker.deleteCommittedSnapshot({ ...exact, path: '/tmp/leak', body: '正文' }),
          error => error?.code === 'INVALID_SCHEMA_KEYS'
        );
        let getterCalls = 0;
        const hostile = { ...exact };
        Object.defineProperty(hostile, 'publishedIdentityDigest', {
          enumerable: true,
          get() { getterCalls += 1; return digest; },
        });
        await assert.rejects(
          worker.deleteCommittedSnapshot(hostile),
          error => error?.code === 'INVALID_CANONICAL_VALUE'
        );
        assert.strictEqual(getterCalls, 0);
        assert.deepStrictEqual(deleteControlNames(data), []);
        assert.deepStrictEqual(quarantineNames(data), []);
        await worker.close();
      } finally {
        await destroy(worker);
      }
    })
  );

  await check('moves the exact receipt-bound bundle through quarantine and persists COMMITTED truth', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const helperPath = compile(scratch);
      const created = await createCommitted(data, helperPath);
      const request = deleteRequest(created);
      const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      try {
        const deleted = await worker.deleteCommittedSnapshot(request);
        assert.strictEqual(deleted.state, 'COMMITTED');
        assert.match(deleted.deletedIdentityDigest, /^sha256:[a-f0-9]{64}$/);
        assert.match(deleted.receiptDigest, /^sha256:[a-f0-9]{64}$/);
        assert.strictEqual(fs.existsSync(finalPath(data, created.snapshotId)), false);
        assert.deepStrictEqual(quarantineNames(data), []);
        const control = path.join(data.root, 'control');
        const names = deleteControlNames(data);
        assert.strictEqual(names.length, 3);
        const transactionName = names.find(name => name.startsWith('delete-transaction-'));
        const recoveryName = names.find(name => name.startsWith('delete-recovery-'));
        const receiptName = names.find(name => name.startsWith('delete-receipt-'));
        const transaction = JSON.parse(fs.readFileSync(path.join(control, transactionName), 'utf8'));
        const recovery = JSON.parse(fs.readFileSync(path.join(control, recoveryName), 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(path.join(control, receiptName), 'utf8'));
        schema.assertSnapshotReceipt(receipt, 'delete');
        schema.assertSnapshotRecovery(recovery, 'delete', receipt);
        schema.assertSnapshotTransaction(transaction, 'delete', receipt);
        assert.strictEqual(transaction.sourceIdentityDigest, created.publishedIdentityDigest);
        assert.strictEqual(receipt.deletedIdentityDigest, deleted.deletedIdentityDigest);
        await worker.close();
      } finally {
        await destroy(worker);
      }
    })
  );

  await check('response loss reconciles from formal records without replaying delete', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const normalHelper = compile(scratch);
      const created = await createCommitted(data, normalHelper);
      const request = deleteRequest(created, 'e');
      const droppingHelper = compile(scratch, ['WRITCRAFT_TEST_DROP_DELETE_COMMITTED_RESPONSE']);
      const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath: droppingHelper });
      await assert.rejects(
        worker.deleteCommittedSnapshot(request),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      await destroy(worker);
      assert.strictEqual(fs.existsSync(finalPath(data, created.snapshotId)), false);
      const reconciler = createSnapshotStorageWorkerForRoot(data.project, { helperPath: normalHelper });
      try {
        const truth = await reconciler.reconcileDelete(reconcileRequest(request));
        assert.strictEqual(truth.state, 'COMMITTED');
        assert.deepStrictEqual(quarantineNames(data), []);
        assert.strictEqual(deleteControlNames(data).length, 3);
        await reconciler.close();
      } finally {
        await destroy(reconciler);
      }
    })
  );

  await check('a crash after rename is completed by fresh reconciliation from exact quarantine', () =>
    withScratch(async scratch => {
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_AFTER_RENAME',
        syncName: 'delete-after-rename',
        async mutate({ worker }) {
          await worker.destroyForReconciliation();
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), false);
      assert.strictEqual(quarantineNames(context.data).length, 1);
      const wrongOwner = createSnapshotStorageWorkerForRoot(context.data.project, {
        helperPath: context.normalHelper,
      });
      await assert.rejects(
        wrongOwner.reconcileDelete({
          ...reconcileRequest(context.request),
          projectInstanceId: `instance_${'b'.repeat(24)}`,
        }),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(quarantineNames(context.data).length, 1);
      await destroy(wrongOwner);
      const reconciler = createSnapshotStorageWorkerForRoot(context.data.project, {
        helperPath: context.normalHelper,
      });
      try {
        const truth = await reconciler.reconcileDelete(reconcileRequest(context.request));
        assert.strictEqual(truth.state, 'COMMITTED');
        assert.deepStrictEqual(quarantineNames(context.data), []);
        await reconciler.close();
      } finally {
        await destroy(reconciler);
      }
    })
  );

  await check('fresh reconciliation never treats an absent bundle without formal markers as success', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const helperPath = compile(scratch);
      const request = {
        transactionId: `delete_${'f'.repeat(32)}`,
        projectInstanceId: PROJECT_INSTANCE_ID,
        snapshotId: `snapshot_${'9'.repeat(32)}`,
        ownerGeneration: 3,
        snapshotManifestDigest: `sha256:${'8'.repeat(64)}`,
        publishedIdentityDigest: `sha256:${'7'.repeat(64)}`,
        observedAt: OBSERVED_AT,
      };
      const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      await assert.rejects(
        worker.reconcileDelete(request),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.deepStrictEqual(deleteControlNames(data), []);
      assert.deepStrictEqual(quarantineNames(data), []);
      await destroy(worker);
    })
  );

  await check('a moved-only create receipt never authorizes delete', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const helperPath = compile(scratch);
      const created = await createCommitted(data, helperPath);
      const control = path.join(data.root, 'control');
      const receipt = fs.readdirSync(control).find(name => name.startsWith('receipt-'));
      assert(receipt);
      fs.renameSync(
        path.join(control, receipt),
        path.join(control, `receipt-${'f'.repeat(64)}.json`)
      );
      const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      try {
        const truth = await worker.deleteCommittedSnapshot(deleteRequest(created));
        assert.strictEqual(truth.state, 'UNCOMMITTED');
        assert.strictEqual(truth.reason, 'SOURCE_NOT_EXACT');
        assert.strictEqual(fs.existsSync(finalPath(data, created.snapshotId)), true);
        assert.deepStrictEqual(quarantineNames(data), []);
        assert.deepStrictEqual(deleteControlNames(data), []);
        await worker.close();
      } finally {
        await destroy(worker);
      }
    })
  );

  await check('duplicate create receipt blocks delete before quarantine with the final intact', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const helperPath = compile(scratch);
      const created = await createCommitted(data, helperPath);
      const control = path.join(data.root, 'control');
      const receipt = fs.readdirSync(control).find(name => name.startsWith('receipt-'));
      fs.writeFileSync(
        path.join(control, `receipt-${'f'.repeat(64)}.json`),
        fs.readFileSync(path.join(control, receipt)),
        { flag: 'wx', mode: 0o600 }
      );
      const worker = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      try {
        const truth = await worker.deleteCommittedSnapshot(deleteRequest(created));
        assert.deepStrictEqual(truth.state, 'UNCOMMITTED');
        assert.strictEqual(truth.reason, 'SOURCE_NOT_EXACT');
        assert.strictEqual(fs.existsSync(finalPath(data, created.snapshotId)), true);
        assert.deepStrictEqual(quarantineNames(data), []);
        assert.deepStrictEqual(deleteControlNames(data), []);
        await worker.close();
      } finally {
        await destroy(worker);
      }
    })
  );

  await check('duplicate formal delete receipt makes committed reconciliation UNKNOWN without cleanup', () =>
    withScratch(async scratch => {
      const data = setup(scratch);
      const helperPath = compile(scratch);
      const created = await createCommitted(data, helperPath);
      const request = deleteRequest(created);
      const deleter = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      assert.strictEqual((await deleter.deleteCommittedSnapshot(request)).state, 'COMMITTED');
      await deleter.close();
      const control = path.join(data.root, 'control');
      const receipt = fs.readdirSync(control).find(name => name.startsWith('delete-receipt-'));
      fs.writeFileSync(
        path.join(control, `delete-receipt-${'e'.repeat(64)}.json`),
        fs.readFileSync(path.join(control, receipt)),
        { flag: 'wx', mode: 0o600 }
      );
      const reconciler = createSnapshotStorageWorkerForRoot(data.project, { helperPath });
      await assert.rejects(
        reconciler.reconcileDelete(reconcileRequest(request)),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.readdirSync(control).filter(
        name => name.startsWith('delete-receipt-')
      ).length, 2);
      assert.deepStrictEqual(quarantineNames(data), []);
      assert.strictEqual(fs.existsSync(finalPath(data, created.snapshotId)), false);
      await destroy(reconciler);
    })
  );

  await check('open-to-rename same-inode rewrite settles UNCOMMITTED without deleting the leaf', () =>
    withScratch(async scratch => {
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_RENAME',
        syncName: 'delete-before-rename',
        mutate({ data, created }) {
          const target = finalPath(data, created.snapshotId);
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 0);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        },
      });
      try {
        const truth = await context.pending;
        assert.strictEqual(truth.state, 'UNCOMMITTED');
        assert.strictEqual(truth.reason, 'SOURCE_DRIFT');
        assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), true);
        assert.deepStrictEqual(quarantineNames(context.data), []);
        await context.worker.close();
      } finally {
        await destroy(context.worker);
      }
    })
  );

  await check('rename-to-reopen replacement returns UNKNOWN and preserves every uncertain identity', () =>
    withScratch(async scratch => {
      let oldName = null;
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_AFTER_RENAME',
        syncName: 'delete-after-rename',
        mutate({ data }) {
          const directory = path.join(data.root, 'quarantine');
          const name = fs.readdirSync(directory)[0];
          const target = path.join(directory, name);
          const exact = fs.readFileSync(target);
          oldName = `${name}.old`;
          fs.renameSync(target, path.join(directory, oldName));
          fs.writeFileSync(target, exact, { flag: 'wx', mode: 0o600 });
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), false);
      assert.strictEqual(quarantineNames(context.data).includes(oldName), true);
      assert.strictEqual(quarantineNames(context.data).length, 2);
      await destroy(context.worker);
    })
  );

  await check('a late moved-only create receipt leaves renamed quarantine UNKNOWN', () =>
    withScratch(async scratch => {
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_AFTER_RENAME',
        syncName: 'delete-after-rename',
        mutate({ data }) {
          const control = path.join(data.root, 'control');
          const receipt = fs.readdirSync(control).find(name => name.startsWith('receipt-'));
          assert(receipt);
          fs.renameSync(
            path.join(control, receipt),
            path.join(control, `receipt-${'e'.repeat(64)}.json`)
          );
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), false);
      assert.strictEqual(quarantineNames(context.data).length, 1);
      await destroy(context.worker);
      const reconciler = createSnapshotStorageWorkerForRoot(context.data.project, {
        helperPath: context.normalHelper,
      });
      await assert.rejects(
        reconciler.reconcileDelete(reconcileRequest(context.request)),
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(quarantineNames(context.data).length, 1);
      assert.strictEqual(deleteControlNames(context.data).some(
        name => name.startsWith('delete-receipt-')
      ), false);
      await destroy(reconciler);
    })
  );

  await check('reopen-to-unlink same-inode rewrite returns UNKNOWN and preserves quarantine', () =>
    withScratch(async scratch => {
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_UNLINK',
        syncName: 'delete-before-unlink',
        mutate({ data }) {
          const directory = path.join(data.root, 'quarantine');
          const target = path.join(directory, fs.readdirSync(directory)[0]);
          const fd = fs.openSync(target, 'r+');
          fs.writeSync(fd, Buffer.from([0x00]), 0, 1, 0);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), false);
      assert.strictEqual(quarantineNames(context.data).length, 1);
      await destroy(context.worker);
    })
  );

  await check('unlink-to-fsync late replacement returns UNKNOWN and never unlinks the replacement', () =>
    withScratch(async scratch => {
      let replacementPath = null;
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_AFTER_UNLINK',
        syncName: 'delete-after-unlink',
        mutate({ data, created }) {
          const directory = path.join(data.root, 'quarantine');
          const transactionHash = crypto.createHash('sha256')
            .update(deleteRequest(created).transactionId).digest('hex').slice(0, 32);
          const readyControl = path.join(data.root, 'control');
          const transactionName = fs.readdirSync(readyControl)
            .find(name => name.startsWith('delete-transaction-'));
          assert(transactionName);
          const originalName = fs.readdirSync(directory)[0];
          assert.strictEqual(originalName, undefined);
          const basename = `delete-q-${transactionHash}-${'e'.repeat(32)}.wcsb`;
          replacementPath = path.join(directory, basename);
          fs.writeFileSync(replacementPath, Buffer.from('late replacement'), {
            flag: 'wx', mode: 0o600,
          });
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(replacementPath), true);
      assert.strictEqual(fs.readFileSync(replacementPath, 'utf8'), 'late replacement');
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), false);
      await destroy(context.worker);
    })
  );

  await check('private-parent drift before rename returns UNKNOWN with the source untouched', () =>
    withScratch(async scratch => {
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_RENAME',
        syncName: 'delete-before-rename',
        mutate({ data }) {
          const quarantine = path.join(data.root, 'quarantine');
          fs.renameSync(quarantine, `${quarantine}-old`);
          fs.mkdirSync(quarantine, { mode: 0o700 });
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(finalPath(context.data, context.created.snapshotId)), true);
      assert.deepStrictEqual(quarantineNames(context.data), []);
      await destroy(context.worker);
    })
  );

  await check('project-root drift before rename returns UNKNOWN and leaves the old-root source intact', () =>
    withScratch(async scratch => {
      let oldProject = null;
      const context = await pausedDelete({
        scratch,
        macro: 'WRITCRAFT_TEST_PAUSE_DELETE_BEFORE_RENAME',
        syncName: 'delete-before-rename',
        mutate({ data }) {
          oldProject = `${data.project}-old`;
          fs.renameSync(data.project, oldProject);
          fs.mkdirSync(data.project, { mode: 0o700 });
        },
      });
      await assert.rejects(
        context.pending,
        error => error?.code === 'SNAPSHOT_RECOVERY_REQUIRED'
      );
      const oldRoot = path.join(oldProject, '.writcraft', 'snapshots', 'v1');
      assert.strictEqual(fs.existsSync(finalPath(
        { root: oldRoot }, context.created.snapshotId
      )), true);
      assert.deepStrictEqual(fs.readdirSync(path.join(oldRoot, 'quarantine')), []);
      await destroy(context.worker);
    })
  );

  console.log(`\n${passed}/${passed} Snapshot native safe-delete storage checks passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
