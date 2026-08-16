#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../src/main/public-markdown-native-lifecycle');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const schema = require('../src/main/public-markdown-native-schema');

const SOURCE = path.join(__dirname, '..', 'native', 'public-markdown-create-helper.c');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-undo-lifecycle-'));
const openFds = [];
let passed = 0;
const digest = value => `sha256:${String(value).repeat(64)}`;

function compile(name, definitions = []) {
  const output = path.join(scratch, name);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-Wframe-larger-than=2097152',
    '-mmacosx-version-min=11.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`), SOURCE, '-o', output,
  ]);
  return output;
}

function rootIdentityDigest(target) {
  const stat = fs.statSync(target, { bigint: true });
  return evidence.digestRootIdentity({
    schema: evidence.SCHEMAS.ROOT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
  });
}

function objectIdentity(stat, contentSha256) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    contentSha256,
  };
}

function createdIdentity(stat, parentIdentityDigest, leaf, contentSha256) {
  return evidence.digestObject('writcraft.restore-created-identity/v1', {
    schema: 'writcraft.restore-created-identity/v1',
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    parentIdentityDigest,
    leafNameSha256: evidence.sha256(Buffer.from(leaf, 'utf8')),
    contentSha256,
  });
}

function syntheticRecordIdentity(wire, seed) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(100 + seed),
    ino: String(1000 + seed),
    uid: process.geteuid(),
    mode: 0o600,
    nlink: 1,
    size: String(Buffer.byteLength(wire, 'utf8')),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: evidence.sha256(Buffer.from(wire, 'utf8')),
  };
}

function projectFixture(label = 'created Safe Undo leaf\n', relativePath = 'created.md') {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
  const recovery = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(recovery, 0o700);
  const bytes = Buffer.from(label, 'utf8');
  const artifactBytes = Buffer.from(`sealed undo artifact: ${label}`, 'utf8');
  const artifactPath = path.join(recovery, `artifact-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(artifactPath, artifactBytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(artifactPath, 0o600);
  const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY);
  openFds.push(artifactFd);
  const artifactDigest = evidence.sha256(artifactBytes);
  const artifactIdentityDigest = evidence.digestObjectIdentity(objectIdentity(
    fs.fstatSync(artifactFd, { bigint: true }),
    artifactDigest
  ));
  const segments = relativePath.split('/');
  const leaf = segments.pop();
  let parentPath = rootPath;
  const ancestorComponents = segments.map(name => {
    parentPath = path.join(parentPath, name);
    fs.mkdirSync(parentPath, { mode: 0o700 });
    const stat = fs.statSync(parentPath, { bigint: true });
    return {
      nameSha256: evidence.sha256(Buffer.from(name, 'utf8')),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
    };
  });
  const publicPath = path.join(parentPath, leaf);
  fs.writeFileSync(publicPath, bytes, { flag: 'wx', mode: 0o600 });
  const contentDigest = evidence.sha256(bytes);
  const ancestorIdentityDigest = evidence.digestAncestorIdentity({
    schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
    components: ancestorComponents,
  });
  const createdIdentityDigest = createdIdentity(
    fs.statSync(publicPath, { bigint: true }),
    ancestorIdentityDigest,
    leaf,
    contentDigest
  );
  const rootBind = {
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: rootPath,
    expectedRootIdentityDigest: rootIdentityDigest(rootPath),
    expectedRecoveryIdentityDigest: rootIdentityDigest(recovery),
  };
  const parent = {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore_undo',
    selected: [{
      selectedId: 'created:0',
      action: 'CREATED',
      path: relativePath,
      revision: contentDigest.slice('sha256:'.length),
      ancestorIdentityDigest,
    }],
  };
  const phase = {
    schema: phaseSchema.SCHEMA,
    operationId: `chr_${crypto.randomBytes(24).toString('hex')}`,
    kind: 'snapshot_restore_undo',
    phase: 'PRECREATE',
    artifactDigest,
    selectionDigest: phaseSchema.digestSelection(parent),
    items: [{
      selectedId: 'created:0',
      path: relativePath,
      afterRevision: contentDigest.slice('sha256:'.length),
      ancestorIdentityDigest: parent.selected[0].ancestorIdentityDigest,
      createdIdentityDigest,
      creationReceiptDigest: null,
      quarantineReceiptDigest: null,
    }],
    preparedHistoryDigest: digest(7),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  const request = {
    schema: schema.SCHEMAS.UNDO_REQUEST,
    operationId: phase.operationId,
    artifactDigest: phase.artifactDigest,
    artifactIdentityDigest,
    artifactByteLength: artifactBytes.length,
    rootIdentityDigest: rootBind.expectedRootIdentityDigest,
    recoveryIdentityDigest: rootBind.expectedRecoveryIdentityDigest,
    precreatePhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, phase),
    selectionDigest: phase.selectionDigest,
    preparedHistoryDigest: phase.preparedHistoryDigest,
    items: [{
      selectedId: 'created:0',
      path: relativePath,
      byteLength: bytes.length,
      contentDigest,
      ancestorIdentityDigest: parent.selected[0].ancestorIdentityDigest,
      createdIdentityDigest,
    }],
  };
  const authority = schema.buildUndoAuthority(rootBind, parent, phase, request);
  return { rootPath, recovery, publicPath, bytes, artifactPath, artifactFd, authority };
}

function tokenFixture(authority) {
  const receipt = schema.buildUndoReceipt(
    authority,
    0,
    `.changes-history-native-undo-quarantine.${'b'.repeat(32)}`,
    digest(5)
  );
  const control = schema.buildUndoControl(authority, 0);
  return schema.buildUndoToken(
    authority,
    0,
    receipt,
    syntheticRecordIdentity(schema.encodeUndoControlRecord(control, authority, 0), 1),
    syntheticRecordIdentity(schema.encodeUndoReceiptRecord(receipt, authority, 0), 2)
  );
}

function identityFields(identity) {
  return [identity.dev, identity.ino, identity.uid, identity.mode, identity.nlink,
    identity.size, identity.mtimeNs, identity.ctimeNs, identity.contentSha256];
}

function undoResultWire(authority, command, state, tokens) {
  const request = authority.request;
  const letter = command === 'QUARANTINE' ? 'Q' : 'R';
  const lines = ['P\tOK', [
    letter, 'RESULT', state, request.operationId, request.artifactDigest,
    request.precreatePhaseDigest, request.selectionDigest, request.preparedHistoryDigest,
    String(tokens.length), state === 'UNKNOWN' ? 'UNKNOWN' : '-',
  ].join('\t')];
  for (const token of tokens) {
    lines.push([
      'U', token.selectedId, token.controlBasename, token.receiptBasename,
      token.quarantineBasename, token.controlDigest, token.createdIdentityDigest,
      token.quarantineIdentityDigest, token.contentDigest, token.receiptDigest,
      ...identityFields(token.controlRecordIdentity),
      ...identityFields(token.receiptRecordIdentity),
    ].join('\t'));
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

function settleResultWire(authority, settle, command, finalIdentity) {
  const letter = command === 'RESTORE_QUARANTINE' ? 'B' : 'D';
  const finalRecord = schema.buildUndoFinalRecord(settle, authority, command);
  return Buffer.from([
    'P\tOK',
    `${letter}\tRESULT\tCOMMITTED\t${settle.operationId}\t1\t-`,
    ['V', schema.undoFinalRecordName(settle, authority, command),
      finalRecord.finalRecordDigest, ...identityFields(finalIdentity)].join('\t'),
    '',
  ].join('\n'));
}

function completeAck(scoped, authority, artifactFd, settle, settled, command) {
  const ack = schema.buildUndoAckRequest(
    settle,
    settled.finalRecord,
    settled.finalRecordIdentity,
    authority,
    command
  );
  return scoped.ackUndo(
    ack,
    settle,
    settled.finalRecord,
    settled.finalRecordIdentity,
    authority,
    artifactFd,
    command
  );
}

function privateUndoNames(recovery) {
  return fs.readdirSync(recovery).filter(name =>
    name.startsWith('.changes-history-native-undo-'));
}

function nativeInput(item, commandWire) {
  return `${schema.encodeRootBind(item.authority.rootBind)}${commandWire}`;
}

function runPausedHelper({ helperPath, item, input, syncName, mutation, target }) {
  const sync = fs.mkdtempSync(path.join(scratch, 'sync-'));
  const driver = String.raw`
    const childProcess = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helperPath, artifactPath, input64, sync, syncName, mutation, target] =
      process.argv.slice(1);
    const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
    const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY);
    const child = childProcess.spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', rootFd, artifactFd],
      env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: sync },
    });
    fs.closeSync(rootFd);
    fs.closeSync(artifactFd);
    let stdout = '';
    let stderr = '';
    let closedResult = null;
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const closed = new Promise(resolve => child.on('close', (status, signal) => {
      closedResult = { status, signal, stdout, stderr };
      resolve(closedResult);
    }));
    child.stdin.end(Buffer.from(input64, 'base64'));
    async function waitFor(value) {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(value)) {
        if (closedResult) throw new Error('helper closed before sync: ' + JSON.stringify(closedResult));
        if (Date.now() >= deadline) throw new Error('native Safe Undo sync timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    function prefixed(prefix) {
      const matches = fs.readdirSync(target).filter(name => name.startsWith(prefix));
      if (matches.length !== 1) throw new Error('expected one prefixed target: ' + matches.join(','));
      return path.join(target, matches[0]);
    }
    function replaceFile(value) {
      const bytes = fs.readFileSync(value);
      const mode = fs.statSync(value).mode & 0o777;
      fs.renameSync(value, value + '.moved');
      fs.writeFileSync(value, bytes, { flag: 'wx', mode });
    }
    (async () => {
      await waitFor(path.join(sync, syncName + '.ready'));
      if (mutation === 'same-inode-rewrite') {
        const size = fs.statSync(target).size;
        fs.writeFileSync(target, Buffer.alloc(size, 0x78));
      } else if (mutation === 'new-inode-exact') {
        replaceFile(target);
      } else if (mutation === 'new-inode-quarantine') {
        replaceFile(prefixed('.changes-history-native-undo-quarantine.'));
      } else if (mutation === 'same-inode-quarantine') {
        const value = prefixed('.changes-history-native-undo-quarantine.');
        const size = fs.statSync(value).size;
        fs.writeFileSync(value, Buffer.alloc(size, 0x79));
      } else if (mutation === 'new-inode-receipt') {
        replaceFile(prefixed('.changes-history-native-undo-receipt.'));
      } else if (mutation === 'new-inode-final') {
        replaceFile(prefixed('.changes-history-native-undo-final.'));
      } else if (mutation === 'directory-replace') {
        const mode = fs.statSync(target).mode & 0o777;
        fs.renameSync(target, target + '.moved');
        fs.mkdirSync(target, { mode });
      } else if (mutation === 'root-replace') {
        const mode = fs.statSync(target).mode & 0o777;
        fs.renameSync(target, target + '.moved');
        fs.mkdirSync(path.join(target, '.writcraft', 'recovery'), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.join(target, '.writcraft', 'recovery'), 0o700);
        fs.chmodSync(target, mode);
      } else if (mutation === 'late-foreign') {
        fs.writeFileSync(target, 'foreign expected-name record\n', { flag: 'wx', mode: 0o600 });
      } else {
        throw new Error('unknown mutation: ' + mutation);
      }
      fs.writeFileSync(path.join(sync, syncName + '.release'), '', { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify(await closed));
    })().catch(error => {
      try { child.kill('SIGKILL'); } catch (_) {}
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  `;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', driver, helperPath, item.artifactPath, Buffer.from(input).toString('base64'),
    sync, syncName, mutation, target,
  ], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function assertUnknownRaw(result, letter) {
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.strictEqual(result.stderr, '');
  assert(result.stdout.startsWith(`P\tOK\n${letter}\tRESULT\tUNKNOWN\t`), result.stdout);
}

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

console.log('\nPublic Markdown native Safe Undo lifecycle verification');

const helper = compile('public-markdown-create-helper-safe-undo');

test('scoped transport exposes the complete Q/R/B/D/A lifecycle', () => {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
  const recovery = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(recovery, 0o700);
  const scoped = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'not-invoked'),
  }).forProject(rootPath);
  for (const method of [
    'quarantine', 'reconcileUndo', 'restoreQuarantine', 'finalizeUndo', 'ackUndo',
  ]) assert.strictEqual(typeof scoped[method], 'function', method);
});

test('real Q and fresh R prove one exact held quarantine transaction', () => {
  const item = projectFixture('real quarantine\n');
  const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(item.rootPath);
  const committed = scoped.quarantine(item.authority, item.artifactFd);
  assert.strictEqual(committed.state, 'COMMITTED');
  assert.strictEqual(fs.existsSync(item.publicPath), false);
  assert.strictEqual(committed.tokens.length, 1);
  assert(fs.existsSync(path.join(item.recovery, committed.tokens[0].quarantineBasename)));
  assert.deepStrictEqual(
    scoped.reconcileUndo(item.authority, item.artifactFd),
    { ...committed, command: 'RECONCILE_UNDO' }
  );
});

test('real B restores exact public leaf then A removes only formal private records', () => {
  const item = projectFixture('real rollback\n');
  const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(item.rootPath);
  const quarantined = scoped.quarantine(item.authority, item.artifactFd);
  const settle = schema.buildUndoSettleRequest(
    item.authority,
    'RESTORE_QUARANTINE',
    quarantined.tokens
  );
  const settled = scoped.restoreQuarantine(settle, item.authority, item.artifactFd);
  assert.strictEqual(settled.state, 'COMMITTED');
  assert(fs.readFileSync(item.publicPath).equals(item.bytes));
  assert.strictEqual(completeAck(
    scoped,
    item.authority,
    item.artifactFd,
    settle,
    settled,
    'RESTORE_QUARANTINE'
  ).state, 'ACKED');
  assert.deepStrictEqual(privateUndoNames(item.recovery), []);
});

test('real D deletes exact quarantine after History authority then A is durable', () => {
  const item = projectFixture('real finalize undo\n');
  const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(item.rootPath);
  const quarantined = scoped.quarantine(item.authority, item.artifactFd);
  const settle = schema.buildUndoSettleRequest(
    item.authority,
    'FINALIZE_UNDO',
    quarantined.tokens,
    digest(8)
  );
  const settled = scoped.finalizeUndo(settle, item.authority, item.artifactFd);
  assert.strictEqual(settled.state, 'COMMITTED');
  assert.strictEqual(fs.existsSync(item.publicPath), false);
  assert.strictEqual(fs.existsSync(path.join(
    item.recovery,
    quarantined.tokens[0].quarantineBasename
  )), false);
  assert.strictEqual(completeAck(
    scoped,
    item.authority,
    item.artifactFd,
    settle,
    settled,
    'FINALIZE_UNDO'
  ).state, 'ACKED');
  assert.deepStrictEqual(privateUndoNames(item.recovery), []);
});

test('real Q/D/A response loss converges only from fresh durable truth', () => {
  const qHelper = compile('undo-drop-q', ['WRITCRAFT_TEST_DROP_UNDO_COMMITTED_RESPONSE']);
  const qItem = projectFixture('drop Q response\n');
  const qScoped = lifecycle.createPublicMarkdownNativeLifecycle({ helperPath: qHelper })
    .forProject(qItem.rootPath);
  const qTruth = qScoped.quarantine(qItem.authority, qItem.artifactFd);
  assert.strictEqual(qTruth.command, 'RECONCILE_UNDO');
  assert.strictEqual(qTruth.state, 'COMMITTED');

  const dHelper = compile('undo-drop-d', ['WRITCRAFT_TEST_DROP_UNDO_SETTLE_RESPONSE']);
  const dItem = projectFixture('drop D response\n');
  const dScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: dHelper })
    .forProject(dItem.rootPath);
  const dQuarantined = dScoped.quarantine(dItem.authority, dItem.artifactFd);
  const dSettle = schema.buildUndoSettleRequest(
    dItem.authority,
    'FINALIZE_UNDO',
    dQuarantined.tokens,
    digest(8)
  );
  assert.strictEqual(dScoped.finalizeUndo(
    dSettle,
    dItem.authority,
    dItem.artifactFd
  ).state, 'COMMITTED');

  const aHelper = compile('undo-drop-a', ['WRITCRAFT_TEST_DROP_UNDO_ACK_RESPONSE']);
  const aItem = projectFixture('drop A response\n');
  const aScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: aHelper })
    .forProject(aItem.rootPath);
  const aQuarantined = aScoped.quarantine(aItem.authority, aItem.artifactFd);
  const aSettle = schema.buildUndoSettleRequest(
    aItem.authority,
    'FINALIZE_UNDO',
    aQuarantined.tokens,
    digest(8)
  );
  const aSettled = aScoped.finalizeUndo(aSettle, aItem.authority, aItem.artifactFd);
  assert.strictEqual(completeAck(
    aScoped,
    aItem.authority,
    aItem.artifactFd,
    aSettle,
    aSettled,
    'FINALIZE_UNDO'
  ).state, 'ACKED');
  assert.deepStrictEqual(privateUndoNames(aItem.recovery), []);
});

test('crash after Q rename is UNKNOWN while crash after durable receipt fresh-R commits', () => {
  const renameHelper = compile('undo-crash-rename', ['WRITCRAFT_TEST_CRASH_UNDO_AFTER_RENAME']);
  const renameItem = projectFixture('crash after rename\n');
  const renameScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: renameHelper })
    .forProject(renameItem.rootPath);
  assert.throws(
    () => renameScoped.quarantine(renameItem.authority, renameItem.artifactFd),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
      error.transactionState === 'UNKNOWN'
  );
  assert.strictEqual(fs.existsSync(renameItem.publicPath), false);
  assert(privateUndoNames(renameItem.recovery).some(name => name.includes('-quarantine.')));
  assert.strictEqual(renameScoped.reconcileUndo(
    renameItem.authority,
    renameItem.artifactFd
  ).state, 'UNKNOWN');

  const receiptHelper = compile('undo-crash-receipt', ['WRITCRAFT_TEST_CRASH_UNDO_AFTER_RECEIPT']);
  const receiptItem = projectFixture('crash after receipt\n');
  const receiptScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: receiptHelper })
    .forProject(receiptItem.rootPath);
  assert.strictEqual(receiptScoped.quarantine(
    receiptItem.authority,
    receiptItem.artifactFd
  ).state, 'COMMITTED');
});

for (const fault of [
  {
    label: 'partial current control write',
    macro: 'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE',
  },
  {
    label: 'current control file fsync failure',
    macro: 'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE',
  },
  {
    label: 'current control directory fsync failure',
    macro: 'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE',
  },
]) {
  test(`${fault.label} removes only this Q attempt and proves UNCOMMITTED`, () => {
    const faultHelper = compile(`undo-current-${fault.macro.toLowerCase()}`, [fault.macro]);
    const item = projectFixture(`${fault.label}\n`);
    const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: faultHelper })
      .forProject(item.rootPath);
    const result = scoped.quarantine(item.authority, item.artifactFd);
    assert.strictEqual(result.state, 'UNCOMMITTED');
    assert.strictEqual(
      scoped.reconcileUndo(item.authority, item.artifactFd).state,
      'UNCOMMITTED'
    );
    assert.strictEqual(fs.readFileSync(item.publicPath, 'utf8'), `${fault.label}\n`);
    assert.deepStrictEqual(privateUndoNames(item.recovery), []);
  });
}

for (const fault of [
  { label: 'partial-write', macro: 'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE' },
  { label: 'file-fsync', macro: 'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE' },
  { label: 'directory-fsync', macro: 'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE' },
]) {
  for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
    test(`${fault.label} current control cleanup preserves late ${mutation}`, () => {
      const faultHelper = compile(`undo-current-${fault.label}-${mutation}`, [
        fault.macro,
        'WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP',
      ]);
      const item = projectFixture(`${fault.label} current ${mutation}\n`);
      const names = schema.undoRecordNames(item.authority, 0);
      const control = path.join(item.recovery, names.controlBasename);
      const result = runPausedHelper({
        helperPath: faultHelper,
        item,
        input: nativeInput(item, schema.encodeUndoCommand('QUARANTINE', item.authority)),
        syncName: 'control-failure-before-cleanup',
        mutation,
        target: control,
      });
      assertUnknownRaw(result, 'Q');
      assert.strictEqual(fs.existsSync(control), true);
      if (mutation === 'new-inode-exact') {
        assert.strictEqual(fs.existsSync(`${control}.moved`), true);
      }
      assert.strictEqual(
        fs.readFileSync(item.publicPath, 'utf8'),
        `${fault.label} current ${mutation}\n`
      );
    });
  }
}

test('after-controls CAS rejects same/new inode and ancestor/root/recovery replacement', () => {
  const paused = compile('undo-pause-controls', ['WRITCRAFT_TEST_PAUSE_UNDO_AFTER_CONTROLS']);
  for (const candidate of [
    { label: 'same inode rewrite', mutation: 'same-inode-rewrite', nested: false,
      target: item => item.publicPath },
    { label: 'new inode same bytes', mutation: 'new-inode-exact', nested: false,
      target: item => item.publicPath },
    { label: 'ancestor replacement', mutation: 'directory-replace', nested: true,
      target: item => path.join(item.rootPath, 'chapters') },
    { label: 'recovery replacement', mutation: 'directory-replace', nested: false,
      target: item => item.recovery },
    { label: 'root replacement', mutation: 'root-replace', nested: false,
      target: item => item.rootPath },
  ]) {
    const item = projectFixture(
      `${candidate.label}\n`,
      candidate.nested ? 'chapters/created.md' : 'created.md'
    );
    const target = candidate.target(item);
    const result = runPausedHelper({
      helperPath: paused,
      item,
      input: nativeInput(item, schema.encodeUndoCommand('QUARANTINE', item.authority)),
      syncName: 'undo-after-controls',
      mutation: candidate.mutation,
      target,
    });
    assertUnknownRaw(result, 'Q');
    if (candidate.mutation.endsWith('replace')) {
      assert(fs.existsSync(`${target}.moved`), candidate.label);
      assert(fs.existsSync(target), candidate.label);
    } else {
      assert(fs.existsSync(target), candidate.label);
    }
  }
});

test('rename and receipt windows reject quarantine/record rewrite or replacement', () => {
  const renamePaused = compile('undo-pause-rename', ['WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RENAME']);
  for (const mutation of ['same-inode-quarantine', 'new-inode-quarantine']) {
    const item = projectFixture(`${mutation}\n`);
    const result = runPausedHelper({
      helperPath: renamePaused,
      item,
      input: nativeInput(item, schema.encodeUndoCommand('QUARANTINE', item.authority)),
      syncName: 'undo-after-rename',
      mutation,
      target: item.recovery,
    });
    assertUnknownRaw(result, 'Q');
    assert.strictEqual(fs.existsSync(item.publicPath), false);
  }

  const receiptPaused = compile('undo-pause-receipt', ['WRITCRAFT_TEST_PAUSE_UNDO_AFTER_RECEIPT']);
  const item = projectFixture('receipt replacement\n');
  const result = runPausedHelper({
    helperPath: receiptPaused,
    item,
    input: nativeInput(item, schema.encodeUndoCommand('QUARANTINE', item.authority)),
    syncName: 'undo-after-receipt',
    mutation: 'new-inode-receipt',
    target: item.recovery,
  });
  assertUnknownRaw(result, 'Q');
  assert(privateUndoNames(item.recovery).some(name => name.endsWith('.moved')));
});

test('settlement mutation/final windows retain foreign evidence and never report COMMITTED', () => {
  const mutationPaused = compile(
    'undo-pause-settle-mutation',
    ['WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_MUTATION']
  );
  const mutationItem = projectFixture('settle mutation window\n');
  const mutationScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(mutationItem.rootPath);
  const mutationQ = mutationScoped.quarantine(mutationItem.authority, mutationItem.artifactFd);
  const mutationSettle = schema.buildUndoSettleRequest(
    mutationItem.authority,
    'FINALIZE_UNDO',
    mutationQ.tokens,
    digest(8)
  );
  const quarantinePath = path.join(
    mutationItem.recovery,
    mutationQ.tokens[0].quarantineBasename
  );
  const mutationResult = runPausedHelper({
    helperPath: mutationPaused,
    item: mutationItem,
    input: nativeInput(mutationItem, schema.encodeUndoSettleCommand(
      mutationSettle,
      mutationItem.authority,
      'FINALIZE_UNDO'
    )),
    syncName: 'undo-settle-after-mutation',
    mutation: 'late-foreign',
    target: quarantinePath,
  });
  assertUnknownRaw(mutationResult, 'D');
  assert.strictEqual(fs.readFileSync(quarantinePath, 'utf8'), 'foreign expected-name record\n');

  const finalPaused = compile(
    'undo-pause-settle-final',
    ['WRITCRAFT_TEST_PAUSE_UNDO_SETTLE_AFTER_FINAL']
  );
  const finalItem = projectFixture('settle final window\n');
  const finalScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(finalItem.rootPath);
  const finalQ = finalScoped.quarantine(finalItem.authority, finalItem.artifactFd);
  const finalSettle = schema.buildUndoSettleRequest(
    finalItem.authority,
    'FINALIZE_UNDO',
    finalQ.tokens,
    digest(8)
  );
  const finalResult = runPausedHelper({
    helperPath: finalPaused,
    item: finalItem,
    input: nativeInput(finalItem, schema.encodeUndoSettleCommand(
      finalSettle,
      finalItem.authority,
      'FINALIZE_UNDO'
    )),
    syncName: 'undo-settle-after-final',
    mutation: 'new-inode-final',
    target: finalItem.recovery,
  });
  assertUnknownRaw(finalResult, 'D');
  assert(privateUndoNames(finalItem.recovery).some(name => name.endsWith('.moved')));
});

test('ACK before-cleanup and after-unlink windows preserve replacements as UNKNOWN', () => {
  const beforePaused = compile(
    'undo-pause-ack-before',
    ['WRITCRAFT_TEST_PAUSE_UNDO_ACK_BEFORE_CLEANUP']
  );
  const beforeItem = projectFixture('ACK before cleanup\n');
  const beforeScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(beforeItem.rootPath);
  const beforeQ = beforeScoped.quarantine(beforeItem.authority, beforeItem.artifactFd);
  const beforeSettle = schema.buildUndoSettleRequest(
    beforeItem.authority,
    'FINALIZE_UNDO',
    beforeQ.tokens,
    digest(8)
  );
  const beforeSettled = beforeScoped.finalizeUndo(
    beforeSettle,
    beforeItem.authority,
    beforeItem.artifactFd
  );
  const beforeAck = schema.buildUndoAckRequest(
    beforeSettle,
    beforeSettled.finalRecord,
    beforeSettled.finalRecordIdentity,
    beforeItem.authority,
    'FINALIZE_UNDO'
  );
  const beforeResult = runPausedHelper({
    helperPath: beforePaused,
    item: beforeItem,
    input: nativeInput(beforeItem, schema.encodeUndoAckCommand(
      beforeAck,
      beforeSettle,
      beforeSettled.finalRecord,
      beforeSettled.finalRecordIdentity,
      beforeItem.authority,
      'FINALIZE_UNDO'
    )),
    syncName: 'undo-ack-before-cleanup',
    mutation: 'new-inode-receipt',
    target: beforeItem.recovery,
  });
  assertUnknownRaw(beforeResult, 'A');
  assert(privateUndoNames(beforeItem.recovery).some(name => name.endsWith('.moved')));

  const afterPaused = compile(
    'undo-pause-ack-after',
    ['WRITCRAFT_TEST_PAUSE_UNDO_ACK_AFTER_UNLINK']
  );
  const afterItem = projectFixture('ACK after unlink\n');
  const afterScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(afterItem.rootPath);
  const afterQ = afterScoped.quarantine(afterItem.authority, afterItem.artifactFd);
  const afterSettle = schema.buildUndoSettleRequest(
    afterItem.authority,
    'FINALIZE_UNDO',
    afterQ.tokens,
    digest(8)
  );
  const afterSettled = afterScoped.finalizeUndo(
    afterSettle,
    afterItem.authority,
    afterItem.artifactFd
  );
  const afterAck = schema.buildUndoAckRequest(
    afterSettle,
    afterSettled.finalRecord,
    afterSettled.finalRecordIdentity,
    afterItem.authority,
    'FINALIZE_UNDO'
  );
  const lateControl = path.join(afterItem.recovery, afterQ.tokens[0].controlBasename);
  const afterResult = runPausedHelper({
    helperPath: afterPaused,
    item: afterItem,
    input: nativeInput(afterItem, schema.encodeUndoAckCommand(
      afterAck,
      afterSettle,
      afterSettled.finalRecord,
      afterSettled.finalRecordIdentity,
      afterItem.authority,
      'FINALIZE_UNDO'
    )),
    syncName: 'undo-ack-after-unlink',
    mutation: 'late-foreign',
    target: lateControl,
  });
  assertUnknownRaw(afterResult, 'A');
  assert.strictEqual(fs.readFileSync(lateControl, 'utf8'), 'foreign expected-name record\n');
});

test('preexisting exact, duplicate and wrong-name formal records block Q with zero public write', () => {
  for (const hostile of ['exact-control', 'duplicate-control', 'wrong-receipt']) {
    const item = projectFixture(`${hostile}\n`);
    const control = schema.buildUndoControl(item.authority, 0);
    const controlWire = schema.encodeUndoControlRecord(control, item.authority, 0);
    const names = schema.undoRecordNames(item.authority, 0);
    let recordPath;
    if (hostile === 'exact-control') {
      recordPath = path.join(item.recovery, names.controlBasename);
      fs.writeFileSync(recordPath, controlWire, { flag: 'wx', mode: 0o600 });
    } else if (hostile === 'duplicate-control') {
      recordPath = path.join(
        item.recovery,
        `.changes-history-native-undo-control.${'f'.repeat(64)}`
      );
      fs.writeFileSync(recordPath, controlWire, { flag: 'wx', mode: 0o600 });
    } else {
      const receipt = schema.buildUndoReceipt(
        item.authority,
        0,
        `.changes-history-native-undo-quarantine.${'e'.repeat(32)}`,
        digest(5)
      );
      recordPath = path.join(
        item.recovery,
        `.changes-history-native-undo-receipt.${'f'.repeat(64)}`
      );
      fs.writeFileSync(
        recordPath,
        schema.encodeUndoReceiptRecord(receipt, item.authority, 0),
        { flag: 'wx', mode: 0o600 }
      );
    }
    const before = fs.readFileSync(recordPath);
    const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(item.rootPath);
    assert.throws(
      () => scoped.quarantine(item.authority, item.artifactFd),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
        error.transactionState === 'UNKNOWN'
    );
    assert(fs.readFileSync(item.publicPath).equals(item.bytes));
    assert(fs.readFileSync(recordPath).equals(before));
  }
});

test('private namespace scan budget exhaustion blocks Q before public mutation', () => {
  const item = projectFixture('undo scan budget\n');
  for (let index = 0; index < 2048; index += 1) {
    fs.writeFileSync(
      path.join(item.recovery, `unrelated-${String(index).padStart(4, '0')}`),
      '',
      { flag: 'wx', mode: 0o600 }
    );
  }
  const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
    .forProject(item.rootPath);
  assert.throws(
    () => scoped.quarantine(item.authority, item.artifactFd),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
      error.transactionState === 'UNKNOWN'
  );
  assert(fs.readFileSync(item.publicPath).equals(item.bytes));
  assert.deepStrictEqual(privateUndoNames(item.recovery), []);
});

test('Q response loss uses one fresh R and parses complete record identities', () => {
  const item = projectFixture('response loss\n');
  const token = tokenFixture(item.authority);
  const calls = [];
  const scoped = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'fake-helper'),
    spawnSync(_helper, _args, options) {
      const command = options.input.split('\n')[1].split('\t')[0];
      calls.push(command);
      if (command === 'Q') {
        return { status: 1, signal: null, stdout: Buffer.alloc(0),
          stderr: Buffer.from('/private/tmp/secret.md\nMarkdown body') };
      }
      assert.strictEqual(command, 'R');
      return { status: 0, signal: null,
        stdout: undoResultWire(item.authority, 'RECONCILE_UNDO', 'COMMITTED', [token]),
        stderr: Buffer.alloc(0) };
    },
  }).forProject(item.rootPath);
  const result = scoped.quarantine(item.authority, item.artifactFd);
  assert.strictEqual(result.state, 'COMMITTED');
  assert.deepStrictEqual(result.tokens, [token]);
  assert.deepStrictEqual(calls, ['Q', 'R']);
});

test('fresh R preserves all three states without replaying Q', () => {
  for (const state of ['COMMITTED', 'UNCOMMITTED', 'UNKNOWN']) {
    const item = projectFixture(`fresh R ${state}\n`);
    const token = tokenFixture(item.authority);
    let calls = 0;
    const scoped = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: path.join(scratch, 'fake-helper'),
      spawnSync(_helper, _args, options) {
        calls += 1;
        assert.strictEqual(options.input.split('\n')[1].split('\t')[0], 'R');
        return { status: 0, signal: null, stdout: undoResultWire(
          item.authority,
          'RECONCILE_UNDO',
          state,
          state === 'COMMITTED' ? [token] : []
        ), stderr: Buffer.alloc(0) };
      },
    }).forProject(item.rootPath);
    assert.strictEqual(scoped.reconcileUndo(item.authority, item.artifactFd).state, state);
    assert.strictEqual(calls, 1);
  }
});

test('B/D/A bind command, final record and complete publication identity', () => {
  const item = projectFixture('settlement\n');
  const token = tokenFixture(item.authority);
  const restore = schema.buildUndoSettleRequest(
    item.authority,
    'RESTORE_QUARANTINE',
    [token]
  );
  const finalize = schema.buildUndoSettleRequest(
    item.authority,
    'FINALIZE_UNDO',
    [token],
    digest(8)
  );
  const finalRecords = new Map();
  for (const [command, settle, seed] of [
    ['RESTORE_QUARANTINE', restore, 10],
    ['FINALIZE_UNDO', finalize, 20],
  ]) {
    const finalRecord = schema.buildUndoFinalRecord(settle, item.authority, command);
    finalRecords.set(command, {
      settle,
      finalRecord,
      identity: syntheticRecordIdentity(
        schema.encodeUndoFinalRecord(finalRecord, settle, item.authority, command),
        seed
      ),
    });
  }
  const commands = [];
  const scoped = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'fake-helper'),
    spawnSync(_helper, _args, options) {
      const letter = options.input.split('\n')[1].split('\t')[0];
      commands.push(letter);
      if (letter === 'B' || letter === 'D') {
        const command = letter === 'B' ? 'RESTORE_QUARANTINE' : 'FINALIZE_UNDO';
        const value = finalRecords.get(command);
        return { status: 0, signal: null, stdout: settleResultWire(
          item.authority,
          value.settle,
          command,
          value.identity
        ), stderr: Buffer.alloc(0) };
      }
      assert.strictEqual(letter, 'A');
      const value = finalRecords.get('FINALIZE_UNDO');
      return { status: 0, signal: null, stdout: Buffer.from(
        `P\tOK\nA\tRESULT\tACKED\t${finalize.operationId}\t` +
        `${value.finalRecord.finalRecordDigest}\t-\n`
      ), stderr: Buffer.alloc(0) };
    },
  }).forProject(item.rootPath);
  const restored = scoped.restoreQuarantine(restore, item.authority, item.artifactFd);
  const finalized = scoped.finalizeUndo(finalize, item.authority, item.artifactFd);
  assert.strictEqual(restored.state, 'COMMITTED');
  assert.strictEqual(finalized.state, 'COMMITTED');
  const value = finalRecords.get('FINALIZE_UNDO');
  const ack = schema.buildUndoAckRequest(
    finalize,
    value.finalRecord,
    value.identity,
    item.authority,
    'FINALIZE_UNDO'
  );
  assert.strictEqual(scoped.ackUndo(
    ack,
    finalize,
    value.finalRecord,
    value.identity,
    item.authority,
    item.artifactFd,
    'FINALIZE_UNDO'
  ).state, 'ACKED');
  assert.deepStrictEqual(commands, ['B', 'D', 'A']);
});

test('valid B/A UNKNOWN is returned once and never replayed as response loss', () => {
  const item = projectFixture('valid UNKNOWN\n');
  const token = tokenFixture(item.authority);
  const settle = schema.buildUndoSettleRequest(
    item.authority,
    'RESTORE_QUARANTINE',
    [token]
  );
  const finalRecord = schema.buildUndoFinalRecord(
    settle,
    item.authority,
    'RESTORE_QUARANTINE'
  );
  const finalRecordIdentity = syntheticRecordIdentity(schema.encodeUndoFinalRecord(
    finalRecord,
    settle,
    item.authority,
    'RESTORE_QUARANTINE'
  ), 40);
  const ack = schema.buildUndoAckRequest(
    settle,
    finalRecord,
    finalRecordIdentity,
    item.authority,
    'RESTORE_QUARANTINE'
  );
  const calls = [];
  const scoped = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'fake-helper'),
    spawnSync(_helper, _args, options) {
      const letter = options.input.split('\n')[1].split('\t')[0];
      calls.push(letter);
      const output = letter === 'B'
        ? `P\tOK\nB\tRESULT\tUNKNOWN\t${settle.operationId}\t0\tUNKNOWN\n`
        : `P\tOK\nA\tRESULT\tUNKNOWN\t${settle.operationId}\t` +
          `${finalRecord.finalRecordDigest}\tUNKNOWN\n`;
      return { status: 0, signal: null, stdout: Buffer.from(output), stderr: Buffer.alloc(0) };
    },
  }).forProject(item.rootPath);
  assert.strictEqual(scoped.restoreQuarantine(
    settle,
    item.authority,
    item.artifactFd
  ).state, 'UNKNOWN');
  assert.strictEqual(scoped.ackUndo(
    ack,
    settle,
    finalRecord,
    finalRecordIdentity,
    item.authority,
    item.artifactFd,
    'RESTORE_QUARANTINE'
  ).state, 'UNKNOWN');
  assert.deepStrictEqual(calls, ['B', 'A']);
});

test('authority accessors and malformed/path-bearing responses fail closed and redact', () => {
  const item = projectFixture('hostile adapter\n');
  let getters = 0;
  let spawns = 0;
  const hostile = { ...item.authority };
  Object.defineProperty(hostile, 'request', {
    enumerable: true,
    get() { getters += 1; return item.authority.request; },
  });
  const scoped = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'fake-helper'),
    spawnSync() {
      spawns += 1;
      return { status: 0, signal: null,
        stdout: Buffer.alloc(schema.LIMITS.maxResponseBytes + 1, 0x61),
        stderr: Buffer.from('/private/tmp/secret.md\nMarkdown body') };
    },
  }).forProject(item.rootPath);
  assert.throws(() => scoped.quarantine(hostile, item.artifactFd));
  assert.strictEqual(getters, 0);
  assert.strictEqual(spawns, 0);
  let caught;
  try { scoped.quarantine(item.authority, item.artifactFd); } catch (error) { caught = error; }
  assert(caught);
  assert.strictEqual(caught.code, 'CHANGES_MANUAL_RECOVERY_REQUIRED');
  assert.strictEqual(caught.transactionState, 'UNKNOWN');
  assert(!caught.message.includes('/private/'));
  assert(!caught.message.includes('Markdown body'));
  assert.strictEqual(spawns, 2);
});

for (const fd of openFds) try { fs.closeSync(fd); } catch (_) {}
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`${passed}/${passed} Public Markdown native Safe Undo lifecycle checks passed.`);
