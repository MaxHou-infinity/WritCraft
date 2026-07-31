'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  prepareWritingStructure,
} = require('../src/main/writing-structure-service');
const {
  createWritingStructureTransactionService,
} = require('../src/main/writing-structure-transaction-service');

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

function fixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-structure-tx-'));
  fs.mkdirSync(path.join(rootPath, '.writcraft', 'recovery'), { recursive: true });
  fs.chmodSync(path.join(rootPath, '.writcraft'), 0o700);
  fs.chmodSync(path.join(rootPath, '.writcraft', 'recovery'), 0o700);
  const navigationId = `nav_${'a'.repeat(32)}`;
  const projectId = `instance_${'b'.repeat(24)}`;
  const editRevision = 'c'.repeat(64);
  const navigationStore = {
    get() {
      return {
        mode: 'structure',
        navigationId,
        alternatives: [{
          alternativeId: 'alternative_1',
          chapters: [{ title: '原建议', purpose: '原目的' }],
        }],
        contextManifest: {
          files: [{ path: 'edit.md', revision: editRevision }],
        },
      };
    },
  };
  const { prepared } = prepareWritingStructure({
    navigationStore,
    ownerId: 'owner',
    projectInstanceId: projectId,
    rootPath,
    mutationGeneration: 1,
    navigationEpoch: 2,
    navigationId,
    alternativeId: 'alternative_1',
    emptyTreeDigest: 'd'.repeat(64),
    chapters: [{ title: '第一章', purpose: '解释核心问题' }],
  });
  return { rootPath, projectId, prepared };
}

function reportIdentity(filename) {
  try {
    const stat = fs.lstatSync(filename);
    return {
      type: stat.isDirectory() ? 'directory' : 'other',
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function helper(rootPath, behavior = {}) {
  let publishCalls = 0;
  const spawnSync = (_command, _args, options) => {
    const request = JSON.parse(options.input);
    if (request.mode === 'reserve') {
      const stagePath = path.join(rootPath, request.stage);
      if (behavior.reserveExists) {
        fs.mkdirSync(stagePath, { mode: 0o700 });
        return { status: 2, stdout: '', stderr: '' };
      }
      fs.mkdirSync(stagePath, { mode: 0o700 });
      const stat = fs.lstatSync(stagePath);
      const receipt = {
        schema: 'writcraft.structure-stage-receipt/v1',
        operationId: request.operationId,
        stage: request.stage,
        dev: String(stat.dev),
        ino: String(stat.ino),
        mode: 0o700,
      };
      const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
      const receiptBytes = behavior.corruptReceipt ? Buffer.from('broken\n') : bytes;
      fs.writeSync(options.stdio[4], receiptBytes, 0, receiptBytes.length, 0);
      fs.fsyncSync(options.stdio[4]);
      const receiptPath = path.join(
        rootPath,
        '.writcraft',
        'recovery',
        'writing-structure-stage-receipt.json'
      );
      if (behavior.receiptMode) fs.chmodSync(receiptPath, behavior.receiptMode);
      if (behavior.receiptHardlink) {
        fs.linkSync(receiptPath, `${receiptPath}.hardlink`);
      }
      if (behavior.loseReserveResponse) {
        return { status: 1, stdout: 'lost', stderr: '' };
      }
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          operationId: request.operationId,
          stage: request.stage,
          dev: String(stat.dev),
          ino: String(stat.ino),
          mode: 0o700,
        })}\n`,
        stderr: '',
      };
    }
    if (request.mode === 'inspect') {
      if (behavior.inspectFailure) return { status: 1, stdout: 'broken', stderr: '' };
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          stage: reportIdentity(path.join(rootPath, request.stage)),
          target: reportIdentity(path.join(rootPath, request.target)),
        })}\n`,
        stderr: '',
      };
    }
    if (request.mode === 'write') {
      const stagePath = path.join(rootPath, request.directory);
      const filename = path.join(stagePath, request.name);
      const bytes = Buffer.from(request.contentBase64, 'base64');
      if (behavior.failWriteAfterPartial) {
        fs.writeFileSync(filename, bytes.subarray(0, 2), {
          flag: 'wx',
          mode: 0o600,
        });
        fs.unlinkSync(filename);
        return { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
      }
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
      const stat = fs.lstatSync(filename);
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          dev: String(stat.dev),
          ino: String(stat.ino),
          mode: stat.mode & 0o777,
          bytes: stat.size,
        })}\n`,
        stderr: '',
      };
    }
    if (request.mode === 'verify') {
      const filename = path.join(rootPath, request.directory, request.name);
      const expected = Buffer.from(request.contentBase64, 'base64');
      let valid = false;
      try {
        const stat = fs.lstatSync(filename);
        valid = stat.isFile() && !stat.isSymbolicLink() &&
          stat.nlink === 1 && (stat.mode & 0o777) === 0o600 &&
          fs.readFileSync(filename).equals(expected);
      } catch (_) {}
      return valid
        ? { status: 0, stdout: '{"ok":true}\n', stderr: '' }
        : { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
    }
    if (request.mode === 'seal') {
      if (behavior.stageFsyncFailure) {
        return { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
      }
      const names = fs.readdirSync(path.join(rootPath, request.directory)).sort();
      const expected = Array.from(
        { length: request.count },
        (_, index) => `${String(index + 1).padStart(2, '0')}.md`
      );
      const valid = JSON.stringify(names) === JSON.stringify(expected);
      return valid
        ? { status: 0, stdout: '{"ok":true}\n', stderr: '' }
        : { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
    }
    if (request.mode === 'remove') {
      const filename = path.join(rootPath, request.stage, request.name);
      let valid = false;
      try {
        const stat = fs.lstatSync(filename);
        valid = String(stat.dev) === request.fileDev &&
          String(stat.ino) === request.fileIno &&
          fs.readFileSync(filename).equals(Buffer.from(request.contentBase64, 'base64'));
      } catch (_) {}
      if (!valid) return { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
      fs.unlinkSync(filename);
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    if (request.mode === 'cleanupStage') {
      const stagePath = path.join(rootPath, request.stage);
      const stat = fs.lstatSync(stagePath);
      if (String(stat.dev) !== request.dev || String(stat.ino) !== request.ino ||
          fs.readdirSync(stagePath).length !== 0) {
        return { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
      }
      fs.rmdirSync(stagePath);
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    if (request.mode === 'cleanupControls') {
      const recovery = path.join(rootPath, '.writcraft', 'recovery');
      const marker = path.join(recovery, 'writing-structure-transaction.json');
      const receipt = path.join(recovery, 'writing-structure-stage-receipt.json');
      if (behavior.controlCleanupFailure) {
        return { status: 1, stdout: '{"ok":false,"errno":null}\n', stderr: '' };
      }
      fs.unlinkSync(receipt);
      fs.unlinkSync(marker);
      return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
    }
    publishCalls += 1;
    if (behavior.publishExists) {
      fs.mkdirSync(path.join(rootPath, request.target), { mode: 0o700 });
      return {
        status: 2,
        stdout: `${JSON.stringify({
          ok: false,
          errno: 17,
          stage: reportIdentity(path.join(rootPath, request.stage)),
          target: reportIdentity(path.join(rootPath, request.target)),
          expected: false,
        })}\n`,
        stderr: '',
      };
    }
    fs.renameSync(path.join(rootPath, request.stage), path.join(rootPath, request.target));
    if (typeof behavior.afterRename === 'function') {
      behavior.afterRename(path.join(rootPath, request.target));
    }
    if (behavior.losePublishResponse) return { status: 1, stdout: 'broken', stderr: '' };
    return {
      status: 0,
      stdout: `${JSON.stringify({
        ok: true,
        errno: 0,
        stage: null,
        target: reportIdentity(path.join(rootPath, request.target)),
        expected: true,
      })}\n`,
      stderr: '',
    };
  };
  spawnSync.publishCalls = () => publishCalls;
  return spawnSync;
}

console.log('════════ WritCraft V0 · Writing structure transaction verify ════════');

test('commits exact skeleton, exposes durable marker, and exact acknowledge clears it', () => {
  const item = fixture();
  const spawnSync = helper(item.rootPath);
  const transaction = createWritingStructureTransactionService({ spawnSync });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.ok, true);
  assert.equal(spawnSync.publishCalls(), 1);
  assert.equal(
    fs.readFileSync(path.join(item.rootPath, 'chapters', '01.md'), 'utf8'),
    '# 第一章\n\n<!-- 写作目的：解释核心问题 -->\n'
  );
  assert.equal(transaction.hasPending(item.rootPath), true);
  assert.equal(transaction.query({
    rootPath: item.rootPath,
    projectId: item.projectId,
  }).state, 'COMMITTED');
  const acknowledged = transaction.acknowledge({
    rootPath: item.rootPath,
    projectId: item.projectId,
    operationId: result.operationId,
  });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(transaction.hasPending(item.rootPath), false);
});

test('lost publish response reconciles from exact moved inode without a second rename', () => {
  const item = fixture();
  const spawnSync = helper(item.rootPath, { losePublishResponse: true });
  const transaction = createWritingStructureTransactionService({ spawnSync });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.ok, true);
  assert.equal(spawnSync.publishCalls(), 1);
});

test('foreign project cannot acknowledge a committed recovery marker', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(transaction.query({
    rootPath: item.rootPath,
    projectId: `instance_${'f'.repeat(24)}`,
  }).state, 'UNKNOWN');
  assert.throws(
    () => transaction.acknowledge({
      rootPath: item.rootPath,
      projectId: item.projectId,
      operationId: `${result.operationId}f`,
    }),
    error => error && error.code === 'STRUCTURE_RECOVERY_STALE'
  );
});

test('publish EEXIST proves uncommitted and removes only the owned stage and controls', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, { publishExists: true }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNCOMMITTED');
  assert.equal(transaction.hasPending(item.rootPath), false);
  assert.deepEqual(fs.readdirSync(item.rootPath).sort(), ['.writcraft', 'chapters']);
  assert.deepEqual(fs.readdirSync(path.join(item.rootPath, 'chapters')), []);
});

test('beforePublish failure is precommit and leaves no skeleton or recovery controls', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
    beforePublish() {
      throw Object.assign(new Error('stale'), { code: 'STALE' });
    },
  });
  assert.equal(result.state, 'UNCOMMITTED');
  assert.equal(transaction.hasPending(item.rootPath), false);
  assert.equal(fs.existsSync(path.join(item.rootPath, 'chapters')), false);
});

test('a partial file write is cleaned by the exact inode owned by this attempt', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, { failWriteAfterPartial: true }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNCOMMITTED');
  assert.equal(transaction.hasPending(item.rootPath), false);
});

test('reserve stdout loss continues from its exact durable receipt', () => {
  const item = fixture();
  const spawnSync = helper(item.rootPath, { loseReserveResponse: true });
  const transaction = createWritingStructureTransactionService({ spawnSync });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'COMMITTED');
  assert.equal(spawnSync.publishCalls(), 1);
});

test('corrupt reservation receipt becomes UNKNOWN and preserves recovery lock', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, { corruptReceipt: true }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(transaction.hasPending(item.rootPath), true);
});

for (const [label, behavior] of [
  ['hard-linked', { receiptHardlink: true }],
  ['non-0600', { receiptMode: 0o644 }],
]) {
  test(`${label} reservation receipt is rejected and remains UNKNOWN`, () => {
    const item = fixture();
    const transaction = createWritingStructureTransactionService({
      spawnSync: helper(item.rootPath, behavior),
    });
    const result = transaction.commit({
      rootPath: item.rootPath,
      projectId: item.projectId,
      prepared: item.prepared,
    });
    assert.equal(result.state, 'UNKNOWN');
    assert.equal(transaction.hasPending(item.rootPath), true);
  });
}

test('failed control-file identity cleanup never reports UNCOMMITTED', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, { controlCleanupFailure: true }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
    beforePublish() {
      throw Object.assign(new Error('stale'), { code: 'STALE' });
    },
  });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(transaction.hasPending(item.rootPath), true);
});

test('committed content drift after response loss is UNKNOWN and is never deleted', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, {
      losePublishResponse: true,
      afterRename(target) {
        fs.appendFileSync(path.join(target, '01.md'), 'external');
      },
    }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(transaction.hasPending(item.rootPath), true);
  assert.match(fs.readFileSync(path.join(item.rootPath, 'chapters', '01.md'), 'utf8'), /external$/);
});

test('post-publish root fsync failure reports committed warning and query completes durability', () => {
  const item = fixture();
  const rootIdentity = fs.lstatSync(item.rootPath);
  let published = false;
  let injected = false;
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key !== 'fsyncSync') return target[key];
      return fd => {
        const stat = target.fstatSync(fd);
        if (published && !injected &&
            stat.dev === rootIdentity.dev && stat.ino === rootIdentity.ino) {
          injected = true;
          throw Object.assign(new Error('root fsync failed'), { code: 'EIO' });
        }
        return target.fsyncSync(fd);
      };
    },
  });
  const transaction = createWritingStructureTransactionService({
    fileSystem,
    spawnSync: helper(item.rootPath, {
      afterRename() {
        published = true;
      },
    }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(injected, true);
  assert.equal(result.state, 'COMMITTED');
  assert.equal(result.warning, 'STRUCTURE_DURABILITY_PENDING');
  assert.equal(transaction.query({
    rootPath: item.rootPath,
    projectId: item.projectId,
  }).state, 'COMMITTED');
});

test('stage fsync failure is precommit and cleans the exact complete stage', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, { stageFsyncFailure: true }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNCOMMITTED');
  assert.equal(transaction.hasPending(item.rootPath), false);
});

test('publish uncertainty plus inspect failure stays UNKNOWN with its recovery lock', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath, {
      losePublishResponse: true,
      inspectFailure: true,
    }),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  assert.equal(result.state, 'UNKNOWN');
  assert.equal(transaction.hasPending(item.rootPath), true);
});

if (process.platform === 'darwin') {
  test('default runner completes the service-to-native-helper boundary', () => {
    const item = fixture();
    const transaction = createWritingStructureTransactionService();
    const result = transaction.commit({
      rootPath: item.rootPath,
      projectId: item.projectId,
      prepared: item.prepared,
    });
    assert.equal(result.state, 'COMMITTED');
    assert.deepEqual(result.files, [{
      path: 'chapters/01.md',
      revision: item.prepared.files[0].sha256,
    }]);
  });
}

test('durable marker carries the complete capability binding under integrity', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath),
  });
  transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
  });
  const marker = transaction.readMarker(item.rootPath);
  assert.equal(marker.projectInstanceId, item.prepared.projectInstanceId);
  assert.equal(marker.navigationId, item.prepared.navigationId);
  assert.equal(marker.mutationGeneration, item.prepared.mutationGeneration);
  assert.equal(marker.navigationEpoch, item.prepared.navigationEpoch);
  assert.equal(marker.editRevision, item.prepared.editRevision);
  assert.equal(marker.emptyTreeDigest, item.prepared.emptyTreeDigest);
});

test('an existing corrupt marker is UNKNOWN and remains locked', () => {
  const item = fixture();
  const markerPath = path.join(
    item.rootPath, '.writcraft', 'recovery', 'writing-structure-transaction.json'
  );
  fs.writeFileSync(markerPath, 'corrupt\n', { mode: 0o600 });
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath),
  });
  assert.equal(transaction.hasPending(item.rootPath), true);
  assert.equal(transaction.readMarker(item.rootPath), null);
  assert.deepEqual(transaction.query({
    rootPath: item.rootPath,
    projectId: item.projectId,
  }), {
    ok: false,
    state: 'UNKNOWN',
    operationId: null,
  });
  assert.equal(fs.existsSync(markerPath), true);
});

test('a symlinked recovery directory is rejected before any helper or outside write', () => {
  const item = fixture();
  fs.rmdirSync(path.join(item.rootPath, '.writcraft', 'recovery'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-structure-outside-'));
  fs.symlinkSync(outside, path.join(item.rootPath, '.writcraft', 'recovery'));
  const spawnSync = helper(item.rootPath);
  const transaction = createWritingStructureTransactionService({ spawnSync });
  assert.throws(
    () => transaction.commit({
      rootPath: item.rootPath,
      projectId: item.projectId,
      prepared: item.prepared,
    }),
    error => error && error.code === 'STRUCTURE_RECOVERY_INVALID'
  );
  assert.equal(spawnSync.publishCalls(), 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a permissive recovery directory is rejected before reservation', () => {
  const item = fixture();
  const recoveryPath = path.join(item.rootPath, '.writcraft', 'recovery');
  fs.chmodSync(recoveryPath, 0o755);
  const spawnSync = helper(item.rootPath);
  const transaction = createWritingStructureTransactionService({ spawnSync });
  assert.throws(
    () => transaction.commit({
      rootPath: item.rootPath,
      projectId: item.projectId,
      prepared: item.prepared,
    }),
    error => error && error.code === 'STRUCTURE_RECOVERY_INVALID'
  );
  assert.equal(spawnSync.publishCalls(), 0);
  assert.equal(fs.existsSync(path.join(item.rootPath, 'chapters')), false);
});

test('a writable metadata directory is rejected before reservation', () => {
  const item = fixture();
  fs.chmodSync(path.join(item.rootPath, '.writcraft'), 0o777);
  const spawnSync = helper(item.rootPath);
  const transaction = createWritingStructureTransactionService({ spawnSync });
  assert.throws(
    () => transaction.commit({
      rootPath: item.rootPath,
      projectId: item.projectId,
      prepared: item.prepared,
    }),
    error => error && error.code === 'STRUCTURE_RECOVERY_INVALID'
  );
  assert.equal(spawnSync.publishCalls(), 0);
  assert.equal(fs.existsSync(path.join(item.rootPath, 'chapters')), false);
});

test('an async prepublish check fails closed and leaves no transaction artifacts', () => {
  const item = fixture();
  const transaction = createWritingStructureTransactionService({
    spawnSync: helper(item.rootPath),
  });
  const result = transaction.commit({
    rootPath: item.rootPath,
    projectId: item.projectId,
    prepared: item.prepared,
    beforePublish() {
      return Promise.resolve();
    },
  });
  assert.equal(result.state, 'UNCOMMITTED');
  assert.equal(transaction.hasPending(item.rootPath), false);
  assert.equal(fs.existsSync(path.join(item.rootPath, 'chapters')), false);
});

console.log(`\n✅ Writing structure transaction ${passed}/${passed} 全过`);
