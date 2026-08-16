'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { createLocalOperationService } = require('../src/main/local-operation-service');
const { createSnapshotService } = require('../src/main/snapshot-service');
const {
  DEFAULT_DESTROY_TIMEOUT_MS,
  createSnapshotStorageWorkerForRoot,
} = require('../src/main/snapshot-storage-worker');

function request() {
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
  };
}

function scriptedSpawn(onCommand, onKill = child => {
  child.closeNow();
  return true;
}) {
  return function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.exited = false;
    child.reply = line => child.stdout.write(Buffer.from(line, 'ascii'));
    child.closeNow = () => {
      if (child.exited) return;
      child.exited = true;
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
      const result = onKill(child);
      if (result !== false) child.killed = true;
      return result;
    };
    return child;
  };
}

function bound(onCommand, onKill) {
  return scriptedSpawn((line, child) => {
    if (line.startsWith('P\t')) {
      child.reply(`P\tOK\t1\t2\t${process.getuid()}\t493\n`);
      return;
    }
    if (line === 'D') {
      child.reply(
        `D\tOK\tcontrol\t3\t4\t${process.getuid()}\t448` +
        `\tbundles\t5\t6\t${process.getuid()}\t448` +
        `\tquarantine\t7\t8\t${process.getuid()}\t448\n`
      );
      return;
    }
    if (line === 'X') {
      child.reply('X\tOK\n');
      return;
    }
    onCommand(line, child);
  }, onKill);
}

async function verifyDestroyFailureKeepsAuthority(project, options) {
  const value = request();
  let child;
  let written = 0;
  let transactionId = null;
  let factoryCalls = 0;
  let reconcileCalls = 0;
  let releaseCalls = 0;
  const lease = Object.freeze({ leaseId: `lease-${options.name}` });
  let currentLease = lease;
  const spawn = bound((line, target) => {
    const fields = line.split('\t');
    if (fields[0] === 'G') {
      transactionId = fields[1];
      target.reply(
        `G\tOK\t${transactionId}\tcapture_${'7'.repeat(64)}` +
        `\tsha256:${'8'.repeat(64)}\t0\t0\n`
      );
    } else if (fields[0] === 'T') {
      assert.strictEqual(fields[1], transactionId);
      target.reply(`T\tOK\t${transactionId}\t${fields[2]}\n`);
    } else if (fields[0] === 'U') {
      written += fields[2].length / 2;
      target.reply(`U\tOK\t${transactionId}\t${written}\n`);
    } else if (fields[0] === 'K') {
      target.reply(`K\tOK\t${transactionId}\t0\t0\n`);
    } else if (fields[0] === 'B') {
      queueMicrotask(() => target.emit('error', new Error('B response lost')));
    } else {
      throw new Error(`unexpected failure-scenario command: ${fields[0]}`);
    }
  }, target => options.onKill(target));
  const worker = createSnapshotStorageWorkerForRoot(project, {
    spawn() {
      child = spawn();
      return child;
    },
    destroyTimeoutMs: options.testDestroyDeadlineMs,
  });
  const localOperations = createLocalOperationService({
    clock: () => 0,
    randomBytes: size => Buffer.alloc(size, 0x31),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  const service = createSnapshotService({
    localOperations,
    clock: () => 0,
    randomBytes: size => Buffer.alloc(size, 0x32),
    async acquireLease() { return lease; },
    async releaseLease(acquired) {
      releaseCalls += 1;
      if (currentLease === acquired) currentLease = null;
    },
    async settleWatcherBarrier() {
      return { projectInstanceId: value.projectInstanceId, mutationGeneration: 41 };
    },
    assertOwnerCurrent(binding) {
      if (binding.lease && binding.lease !== currentLease) {
        throw Object.assign(new Error('lease drift'), { code: 'SNAPSHOT_LEASE_CHANGED' });
      }
    },
    async createProductionWorker() {
      factoryCalls += 1;
      if (factoryCalls > 1) {
        reconcileCalls += 1;
        throw new Error('fresh R must not start');
      }
      return worker;
    },
  });
  try {
    const result = await service.create({
      projectInstanceId: value.projectInstanceId,
      ownerGeneration: value.ownerGeneration,
      confirmation: 'CREATE_SNAPSHOT',
    });
    assert.strictEqual(result.terminalTruth, 'UNKNOWN');
    assert.strictEqual(result.errorCode, 'SNAPSHOT_CREATE_UNKNOWN');
    assert.strictEqual(factoryCalls, 1);
    assert.strictEqual(reconcileCalls, 0);
    assert.strictEqual(releaseCalls, 0);
    assert.strictEqual(currentLease, lease);
  } finally {
    child?.closeNow();
  }
}

async function main() {
  assert.strictEqual(DEFAULT_DESTROY_TIMEOUT_MS, 5000);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-destroy-latch-'));
  const project = path.join(scratch, 'project');
  fs.mkdirSync(project);
  const value = request();
  let oldChild;
  let written = 0;
  let lateCommitted = false;
  let freshStarted = false;
  const oldSpawn = bound((line, child) => {
    const fields = line.split('\t');
    if (fields[0] === 'G') {
      child.reply(
        `G\tOK\t${value.transactionId}\tcapture_${'3'.repeat(64)}` +
        `\tsha256:${'4'.repeat(64)}\t0\t0\n`
      );
    } else if (fields[0] === 'T') {
      child.reply(`T\tOK\t${value.transactionId}\t${fields[2]}\n`);
    } else if (fields[0] === 'U') {
      written += fields[2].length / 2;
      child.reply(`U\tOK\t${value.transactionId}\t${written}\n`);
    } else if (fields[0] === 'K') {
      child.reply(`K\tOK\t${value.transactionId}\t0\t0\n`);
    } else if (fields[0] === 'B') {
      queueMicrotask(() => child.emit('error', new Error('B response lost')));
    } else {
      throw new Error(`unexpected old command: ${fields[0]}`);
    }
  }, child => {
    oldChild = child;
    return true;
  });
  const oldWorker = createSnapshotStorageWorkerForRoot(project, {
    spawn: oldSpawn,
    destroyTimeoutMs: 1000,
  });
  try {
    await assert.rejects(
      oldWorker.createProductionSnapshot(value),
      error => error?.captureOutcome === 'STAGE_MAY_EXIST'
    );
    const pending = (async () => {
      await oldWorker.destroyForReconciliation();
      freshStarted = true;
      const fresh = createSnapshotStorageWorkerForRoot(project, {
        spawn: bound((line, child) => {
          const fields = line.split('\t');
          if (fields[0] !== 'R') throw new Error(`unexpected fresh command: ${fields[0]}`);
          child.reply(lateCommitted
            ? `R\tOK\t${value.transactionId}\tCOMMITTED\tsha256:${'5'.repeat(64)}` +
              `\tsha256:${'6'.repeat(64)}\n`
            : `R\tOK\t${value.transactionId}\tUNCOMMITTED\n`);
        }),
      });
      try {
        return await fresh.reconcileProductionCreate({
          transactionId: value.transactionId,
          snapshotId: value.snapshotId,
          stageBasename: value.stageBasename,
          finalBasename: value.finalBasename,
          observedAt: '2026-08-08T00:01:00.000Z',
        });
      } finally {
        await fresh.close();
      }
    })();
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(freshStarted, false);
    lateCommitted = true;
    oldChild.closeNow();
    assert.strictEqual((await pending).state, 'COMMITTED');
    await verifyDestroyFailureKeepsAuthority(project, {
      name: 'kill-false',
      onKill: () => false,
      testDestroyDeadlineMs: 25,
    });
    await verifyDestroyFailureKeepsAuthority(project, {
      name: 'kill-no-close',
      onKill: () => true,
      testDestroyDeadlineMs: 25,
    });
    console.log('Snapshot worker destroy latch verification: 3/3 passed');
  } finally {
    oldChild?.closeNow();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
