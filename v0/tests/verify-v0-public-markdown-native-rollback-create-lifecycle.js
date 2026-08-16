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
const existingSchema = require('../src/main/snapshot-existing-restore-native-schema');
const schema = require('../src/main/public-markdown-native-schema');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-rollback-create-lifecycle-'));
const source = fs.readFileSync(path.join(
  __dirname,
  '..',
  'native',
  'public-markdown-create-helper.c'
), 'utf8');

function sha(bytes) { return evidence.sha256(Buffer.from(bytes)); }

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

function objectIdentity(target, contentSha256) {
  const stat = fs.statSync(target, { bigint: true });
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

function writePrivate(target, bytes) {
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return objectIdentity(target, sha(bytes));
}

function phase(parent, operationId, artifactDigest, state, items, overrides = {}) {
  return phaseSchema.assertPhaseRecord({
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore',
    phase: state,
    artifactDigest,
    selectionDigest: phaseSchema.digestSelection(parent),
    items,
    preparedHistoryDigest: state === 'PRECREATE' ? null : sha('prepared History'),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: state === 'PRECREATE'
      ? '2026-08-09T01:00:00.000Z'
      : '2026-08-09T01:00:01.000Z',
    ...overrides,
  }, parent);
}

function compileHelper(name = 'public-markdown-rollback-create-helper', definitions = []) {
  const output = path.join(scratch, name);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-Wframe-larger-than=2097152', '-mmacosx-version-min=11.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`),
    path.join(__dirname, '..', 'native', 'public-markdown-create-helper.c'), '-o', output,
  ]);
  return output;
}

function mixedFixture(helperPath) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'mixed-project-')));
  const privatePath = path.join(rootPath, '.writcraft');
  const recoveryPath = path.join(privatePath, 'recovery');
  fs.mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(privatePath, 0o700);
  fs.chmodSync(recoveryPath, 0o700);
  const operationId = `chr_${crypto.randomBytes(24).toString('hex')}`;
  const before = Buffer.from('original existing\n');
  const after = Buffer.from('snapshot existing\n');
  const createdBytes = Buffer.from('snapshot created\n');
  const artifactBytes = Buffer.concat([before, after, createdBytes]);
  const artifactPath = path.join(recoveryPath, `changes-history-${operationId}.bin`);
  writePrivate(artifactPath, artifactBytes);
  const artifactDigest = sha(artifactBytes);
  const artifactIdentityDigest = evidence.digestObjectIdentity(
    objectIdentity(artifactPath, artifactDigest)
  );
  const ancestor = {
    schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
    components: [],
  };
  const ancestorIdentityDigest = evidence.digestAncestorIdentity(ancestor);
  const existingPath = path.join(rootPath, 'existing.md');
  const createdPath = path.join(rootPath, 'created.md');
  fs.writeFileSync(existingPath, before, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(createdPath, createdBytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(existingPath, 0o600);
  fs.chmodSync(createdPath, 0o600);
  const parent = phaseSchema.assertParentSelectionBinding({
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [{
      selectedId: 'existing_one', action: 'EXISTING', path: 'existing.md',
      revision: sha(after).slice(7), ancestorIdentityDigest,
    }, {
      selectedId: 'missing_one', action: 'MISSING', path: 'created.md',
      revision: sha(createdBytes).slice(7), ancestorIdentityDigest,
    }],
  });
  const missingBase = {
    selectedId: 'missing_one', path: 'created.md', afterRevision: sha(createdBytes).slice(7),
    ancestorIdentityDigest, createdIdentityDigest: null, creationReceiptDigest: null,
    quarantineReceiptDigest: null,
  };
  const precreate = phase(parent, operationId, artifactDigest, 'PRECREATE', [missingBase]);
  const createRequest = schema.assertCreateRequest({
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId,
    artifactDigest,
    artifactIdentityDigest,
    artifactByteLength: artifactBytes.length,
    precreatePhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, precreate),
    selectionDigest: phaseSchema.digestSelection(parent),
    items: [{
      selectedId: 'missing_one', path: 'created.md',
      artifactOffset: before.length + after.length,
      byteLength: createdBytes.length,
      contentDigest: sha(createdBytes),
      ancestorIdentityDigest,
    }],
  });
  const createdStat = fs.statSync(createdPath, { bigint: true });
  const createdIdentityDigest = evidence.digestRestoreCreatedIdentity({
    schema: evidence.SCHEMAS.RESTORE_CREATED_IDENTITY,
    parentIdentityDigest: ancestorIdentityDigest,
    leafNameSha256: sha('created.md'),
    dev: createdStat.dev.toString(), ino: createdStat.ino.toString(),
    uid: Number(createdStat.uid), mode: Number(createdStat.mode & 0o7777n),
    nlink: Number(createdStat.nlink), size: createdStat.size.toString(),
    contentSha256: sha(createdBytes),
  }, ancestor);
  const createControl = schema.buildControl(createRequest, 0);
  const createReceipt = schema.buildReceipt(createControl, createdIdentityDigest);
  const created = phase(parent, operationId, artifactDigest, 'CREATED_RECEIPT', [{
    ...missingBase,
    createdIdentityDigest,
    creationReceiptDigest: createReceipt.receiptDigest,
  }]);
  const controlPath = path.join(recoveryPath, schema.recordNames(createRequest, 0).controlBasename);
  const receiptPath = path.join(recoveryPath, schema.recordNames(createRequest, 0).receiptBasename);
  const createControlIdentity = writePrivate(controlPath, schema.encodeControlRecord(createControl));
  const createReceiptIdentity = writePrivate(
    receiptPath,
    schema.encodeReceiptRecord(createReceipt, createControl)
  );
  const publication = {
    schema: schema.SCHEMAS.ROLLBACK_CREATE_PUBLICATION,
    token: schema.buildToken(createRequest, 0, createReceipt),
    controlRecordIdentity: createControlIdentity,
    receiptRecordIdentity: createReceiptIdentity,
  };
  const markerBytes = Buffer.from('{"phase":"CREATED_RECEIPT"}\n');
  const markerPath = path.join(recoveryPath, 'changes-history-transaction.json');
  writePrivate(markerPath, markerBytes);
  const historyBytes = Buffer.from('{"schema":"writcraft.changes/v4","entries":[]}\n');
  const historyPath = path.join(privatePath, 'changes.json');
  writePrivate(historyPath, historyBytes);
  const baseHistoryDigest = sha(Buffer.concat([Buffer.from([1]), historyBytes]));
  const existingStat = fs.statSync(existingPath, { bigint: true });
  const beforeLeafIdentity = existingSchema.digestExistingLeafIdentity(
    existingSchema.buildExistingLeafIdentity({
      selectedId: 'existing_one', path: 'existing.md', revision: sha(before).slice(7),
      ancestorIdentityDigest, byteLength: before.length, contentDigest: sha(before),
    }, {
      dev: existingStat.dev.toString(), ino: existingStat.ino.toString(),
      uid: Number(existingStat.uid), mode: Number(existingStat.mode & 0o7777n),
      nlink: Number(existingStat.nlink), size: existingStat.size.toString(),
      mtimeNs: existingStat.mtimeNs.toString(), ctimeNs: existingStat.ctimeNs.toString(),
      contentSha256: sha(before),
    }), {
      selectedId: 'existing_one', path: 'existing.md', revision: sha(before).slice(7),
      ancestorIdentityDigest, byteLength: before.length, contentDigest: sha(before),
    }
  );
  const markerAuthority = {
    schema: existingSchema.SCHEMAS.MARKER_AUTHORITY,
    operationId,
    markerDigest: sha(markerBytes),
    artifactDigest,
    artifactIdentityDigest,
    artifactByteLength: artifactBytes.length,
    baseHistoryDigest,
    baseHistoryByteLength: historyBytes.length,
  };
  const existingRequest = {
    schema: existingSchema.SCHEMAS.REQUEST,
    operationId,
    markerDigest: markerAuthority.markerDigest,
    artifactDigest,
    artifactIdentityDigest,
    artifactByteLength: artifactBytes.length,
    createdReceiptPhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, created),
    selectionDigest: phaseSchema.digestSelection(parent),
    baseHistoryDigest,
    baseHistoryByteLength: historyBytes.length,
    items: [{
      selectedId: 'existing_one', path: 'existing.md',
      beforeRevision: sha(before).slice(7), afterRevision: sha(after).slice(7),
      beforeArtifactOffset: 0, beforeByteLength: before.length,
      beforeContentDigest: sha(before), afterArtifactOffset: before.length,
      afterByteLength: after.length, afterContentDigest: sha(after),
      ancestorIdentityDigest, beforeLeafIdentityDigest: beforeLeafIdentity,
    }],
  };
  const existingAuthority = existingSchema.buildAuthority(
    markerAuthority, parent, created, existingRequest
  );
  const existingControl = existingSchema.buildControl(existingAuthority, 0);
  const existingRollback = existingSchema.buildRollbackReceipt(
    existingAuthority, 0, beforeLeafIdentity
  );
  const existingNames = existingSchema.recordNames(existingAuthority, 0);
  const existingControlIdentity = writePrivate(
    path.join(recoveryPath, existingNames.controlBasename),
    existingSchema.encodeControlRecord(existingControl, existingAuthority, 0)
  );
  const existingRollbackIdentity = writePrivate(
    path.join(recoveryPath, existingNames.rollbackReceiptBasename),
    existingSchema.encodeRollbackReceiptRecord(existingRollback, existingAuthority, 0)
  );
  const existingRollbackToken = existingSchema.buildRollbackToken(
    existingAuthority, 0, existingRollback,
    existingControlIdentity, existingRollbackIdentity
  );
  const existingTerminal = existingSchema.buildTerminalReceipt(
    existingAuthority, 'UNCOMMITTED', [existingRollbackToken]
  );
  const rootBind = {
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: rootPath,
    expectedRootIdentityDigest: rootIdentityDigest(rootPath),
    expectedRecoveryIdentityDigest: rootIdentityDigest(recoveryPath),
  };
  const held = schema.buildRollbackCreateHeldBinding(
    markerBytes.length, objectIdentity(markerPath, sha(markerBytes)),
    rootIdentityDigest(privatePath), true, sha(historyBytes),
    objectIdentity(historyPath, sha(historyBytes)), existingAuthority
  );
  const request = schema.buildRollbackCreateRequest(
    rootBind, parent, precreate, created, createRequest, [publication],
    existingAuthority, existingTerminal, held
  );
  const authority = schema.buildRollbackCreateAuthority(
    rootBind, parent, precreate, created, createRequest, [publication],
    existingAuthority, existingTerminal, held, request
  );
  const fds = {
    artifactFd: fs.openSync(artifactPath, fs.constants.O_RDONLY),
    markerFd: fs.openSync(markerPath, fs.constants.O_RDONLY),
    historyParentFd: fs.openSync(privatePath, fs.constants.O_RDONLY),
    historyFd: fs.openSync(historyPath, fs.constants.O_RDONLY),
  };
  return {
    authority, fds, createdPath, existingPath, rootPath, privatePath, recoveryPath,
    artifactPath, markerPath, historyPath, markerBytes, historyBytes, createdBytes, before,
    scoped: lifecycle.createPublicMarkdownNativeTransport({ helperPath }).forProject(rootPath),
  };
}

function closeMixed(value) {
  for (const fd of Object.values(value.fds)) try { fs.closeSync(fd); } catch (_) {}
}

function wrongRollbackRecord(value, kind) {
  const quarantineBasename = `.changes-history-native-rollback-create-quarantine.${'a'.repeat(32)}`;
  const control = schema.buildRollbackCreateControl(value.authority, 0, quarantineBasename);
  const isControl = kind === 'control';
  const bytes = isControl
    ? schema.encodeRollbackCreateControlRecord(control, value.authority, 0)
    : schema.encodeRollbackCreateReceiptRecord(
      schema.buildRollbackCreateReceipt(
        value.authority,
        0,
        control,
        `sha256:${'b'.repeat(64)}`
      ),
      value.authority,
      0,
      control
    );
  const basename = `.changes-history-native-rollback-create-${kind}.${'f'.repeat(64)}`;
  writePrivate(path.join(value.recoveryPath, basename), bytes);
  return basename;
}

function rollbackWire(value, command) {
  return `${schema.encodeRootBind(value.authority.rootBind)}` +
    schema.encodeRollbackCreateCommand(command, value.authority);
}

function runPaused(value, helperPath, command, syncName, mutation) {
  const syncPath = fs.mkdtempSync(path.join(scratch, 'sync-'));
  const driver = String.raw`
    const cp = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helper, input64, syncPath, syncName, mutation, rootPath, artifactPath,
      markerPath, privatePath, historyPath, createdPath, existingPath] = process.argv.slice(1);
    const opened = [
      fs.openSync('/', fs.constants.O_RDONLY),
      fs.openSync(artifactPath, fs.constants.O_RDONLY),
      fs.openSync(markerPath, fs.constants.O_RDONLY),
      fs.openSync(privatePath, fs.constants.O_RDONLY),
      fs.openSync(historyPath, fs.constants.O_RDONLY),
    ];
    const child = cp.spawn(helper, [], {
      stdio: ['pipe', 'pipe', 'pipe', ...opened],
      env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: syncPath },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdin.end(Buffer.from(input64, 'base64'));
    const ready = path.join(syncPath, syncName + '.ready');
    const release = path.join(syncPath, syncName + '.release');
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (!fs.existsSync(ready)) {
        if (Date.now() > deadline) { clearInterval(timer); child.kill('SIGKILL'); }
        return;
      }
      clearInterval(timer);
      if (mutation === 'marker-new-inode') {
        const bytes = fs.readFileSync(markerPath);
        fs.renameSync(markerPath, markerPath + '.held');
        fs.writeFileSync(markerPath, bytes, { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'history-same-inode') {
        fs.writeFileSync(historyPath, Buffer.concat([fs.readFileSync(historyPath), Buffer.from('x')]));
      } else if (mutation === 'created-new-inode') {
        const bytes = fs.readFileSync(createdPath);
        fs.renameSync(createdPath, createdPath + '.held');
        fs.writeFileSync(createdPath, bytes, { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'existing-new-inode') {
        const bytes = fs.readFileSync(existingPath);
        fs.renameSync(existingPath, existingPath + '.held');
        fs.writeFileSync(existingPath, bytes, { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'root-new-inode') {
        fs.renameSync(rootPath, rootPath + '.held');
        fs.mkdirSync(rootPath, { mode: 0o700 });
      } else if (mutation === 'recovery-new-inode') {
        const recovery = path.join(privatePath, 'recovery');
        fs.renameSync(recovery, recovery + '.held');
        fs.mkdirSync(recovery, { mode: 0o700 });
      } else if (mutation === 'control-same-inode' || mutation === 'control-new-inode') {
        const recovery = path.join(privatePath, 'recovery');
        const name = fs.readdirSync(recovery)
          .find(entry => entry.startsWith('.changes-history-native-rollback-create-control.'));
        if (!name) throw new Error('rollback control not found');
        const target = path.join(recovery, name);
        const bytes = fs.readFileSync(target);
        if (mutation === 'control-new-inode') {
          fs.renameSync(target, target + '.held');
          fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
        } else {
          fs.writeFileSync(target, bytes);
        }
      }
      fs.writeFileSync(release, 'release', { flag: 'wx', mode: 0o600 });
    }, 5);
    child.on('close', (code, signal) => {
      clearInterval(timer);
      for (const fd of opened) try { fs.closeSync(fd); } catch (_) {}
      process.stdout.write(JSON.stringify({ code, signal, stdout, stderr }));
    });
  `;
  const result = childProcess.execFileSync(process.execPath, [
    '-e', driver, helperPath,
    Buffer.from(rollbackWire(value, command)).toString('base64'),
    syncPath, syncName, mutation, value.rootPath, value.artifactPath,
    value.markerPath, value.privatePath, value.historyPath, value.createdPath,
    value.existingPath,
  ], { encoding: 'utf8', maxBuffer: schema.LIMITS.maxRollbackCreateResponseBytes });
  return JSON.parse(result);
}

try {
  assert.ok(source.includes('CREATE_ROLLBACK'),
    'the production helper must dispatch the signed CREATE_ROLLBACK domain');
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
  const recoveryPath = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(recoveryPath, 0o700);

  const transport = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: path.join(scratch, 'not-invoked'),
    spawnSync() {
      throw new Error('not invoked by API-shape checkpoint');
    },
  });
  const scoped = transport.forProject(rootPath);
  for (const method of [
    'quarantineCreateRollback',
    'reconcileCreateRollback',
    'deleteCreateRollback',
    'ackCreateRollback',
  ]) {
    assert.strictEqual(typeof scoped[method], 'function', `${method} must be production scoped API`);
  }
  console.log('PASS production lifecycle exposes domain-separated CREATE_ROLLBACK Q/R/D/A');

  const helper = compileHelper();
  const mixed = mixedFixture(helper);
  try {
    const quarantined = mixed.scoped.quarantineCreateRollback(mixed.authority, mixed.fds);
    assert.strictEqual(quarantined.state, 'COMMITTED');
    assert.strictEqual(quarantined.tokens.length, 1);
    assert.strictEqual(fs.existsSync(mixed.createdPath), false);
    const reconciled = mixed.scoped.reconcileCreateRollback(mixed.authority, mixed.fds);
    assert.strictEqual(reconciled.state, 'COMMITTED');
    assert.deepStrictEqual(reconciled.tokens, quarantined.tokens);
    console.log('PASS real mixed single-leaf Q converges through fresh R');

  } finally {
    closeMixed(mixed);
  }

  for (const kind of ['control', 'receipt']) {
    const hostile = mixedFixture(helper);
    try {
      const basename = wrongRollbackRecord(hostile, kind);
      const truth = hostile.scoped.reconcileCreateRollback(hostile.authority, hostile.fds);
      assert.strictEqual(truth.state, 'UNKNOWN');
      assert.throws(
        () => hostile.scoped.quarantineCreateRollback(hostile.authority, hostile.fds),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      assert.strictEqual(fs.existsSync(hostile.createdPath), true);
      assert.strictEqual(fs.existsSync(path.join(hostile.recoveryPath, basename)), true);
      console.log(`PASS wrong-basename formal rollback ${kind} blocks Q/R without deletion`);
    } finally {
      closeMixed(hostile);
    }
  }

  for (const [label, macro] of [
    ['partial write', 'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE'],
    ['file fsync', 'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE'],
    ['path recheck', 'WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE'],
    ['directory fsync', 'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE'],
  ]) {
    const faultHelper = compileHelper(`rollback-control-${label.replaceAll(' ', '-')}`, [macro]);
    const fault = mixedFixture(faultHelper);
    try {
      const truth = fault.scoped.quarantineCreateRollback(fault.authority, fault.fds);
      assert.strictEqual(truth.state, 'UNCOMMITTED');
      assert.strictEqual(fs.existsSync(fault.createdPath), true);
      assert.deepStrictEqual(
        fs.readdirSync(fault.recoveryPath)
          .filter(name => name.startsWith('.changes-history-native-rollback-create-')),
        []
      );
      console.log(`PASS rollback control ${label} cleans exact attempt to UNCOMMITTED`);
    } finally {
      closeMixed(fault);
    }
  }

  const dropHelper = compileHelper('rollback-drop-q', [
    'WRITCRAFT_TEST_DROP_ROLLBACK_COMMITTED_RESPONSE',
  ]);
  const dropped = mixedFixture(dropHelper);
  try {
    const commands = [];
    const scoped = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: dropHelper,
      spawnSync(command, args, options) {
        const commandLine = String(options.input).split('\n')[1] || '';
        commands.push(commandLine.split('\t')[0]);
        return childProcess.spawnSync(command, args, options);
      },
    }).forProject(dropped.rootPath);
    const truth = scoped.quarantineCreateRollback(dropped.authority, dropped.fds);
    assert.strictEqual(truth.state, 'COMMITTED');
    assert.deepStrictEqual(commands, ['Q', 'R']);
    assert.strictEqual(fs.existsSync(dropped.createdPath), false);
    console.log('PASS lost Q response performs Q×1 then fresh R×1 without replay');
  } finally {
    closeMixed(dropped);
  }

  const cleanupReplacementHelper = compileHelper('rollback-control-replacement', [
    'WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE',
    'WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP',
  ]);
  for (const mutation of ['control-same-inode', 'control-new-inode']) {
    const hostile = mixedFixture(cleanupReplacementHelper);
    try {
      const raw = runPaused(
        hostile,
        cleanupReplacementHelper,
        schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
        'control-failure-before-cleanup',
        mutation
      );
      assert.strictEqual(raw.code, 0);
      assert.match(raw.stdout, /^P\tOK\nQ\tRESULT\tUNKNOWN\t/m);
      assert.strictEqual(fs.existsSync(hostile.createdPath), true);
      assert.ok(fs.readdirSync(hostile.recoveryPath)
        .some(name => name.startsWith('.changes-history-native-rollback-create-control.')));
      console.log(`PASS rollback control cleanup preserves ${mutation} replacement as UNKNOWN`);
    } finally {
      closeMixed(hostile);
    }
  }

  const rPauseHelper = compileHelper('rollback-r-terminal-pause', [
    'WRITCRAFT_TEST_PAUSE_ROLLBACK_RECONCILE_BEFORE_UNCOMMITTED',
  ]);
  for (const mutation of ['marker-new-inode', 'history-same-inode', 'created-new-inode']) {
    const hostile = mixedFixture(rPauseHelper);
    try {
      const raw = runPaused(
        hostile,
        rPauseHelper,
        schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
        'rollback-reconcile-before-uncommitted',
        mutation
      );
      assert.strictEqual(raw.code, 0);
      assert.match(raw.stdout, /^P\tOK\nR\tRESULT\tUNKNOWN\t/m);
      if (mutation === 'marker-new-inode') assert.strictEqual(fs.existsSync(hostile.markerPath), true);
      if (mutation === 'history-same-inode') {
        assert.ok(fs.readFileSync(hostile.historyPath).toString('utf8').endsWith('x'));
      }
      if (mutation === 'created-new-inode') assert.strictEqual(fs.existsSync(hostile.createdPath), true);
      console.log(`PASS fresh R terminal CAS rejects ${mutation}`);
    } finally {
      closeMixed(hostile);
    }
  }

  const afterControlsHelper = compileHelper('rollback-after-controls-pause', [
    'WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_CONTROLS',
  ]);
  for (const mutation of [
    'marker-new-inode', 'created-new-inode', 'existing-new-inode',
    'root-new-inode', 'recovery-new-inode',
  ]) {
    const hostile = mixedFixture(afterControlsHelper);
    try {
      const raw = runPaused(
        hostile,
        afterControlsHelper,
        schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
        'rollback-after-controls',
        mutation
      );
      assert.strictEqual(raw.code, 0);
      assert.match(raw.stdout, /^P\tOK\nQ\tRESULT\tUNKNOWN\t/m);
      const createdAuthorityPath = mutation === 'root-new-inode'
        ? path.join(`${hostile.rootPath}.held`, 'created.md')
        : hostile.createdPath;
      assert.strictEqual(fs.existsSync(createdAuthorityPath), true);
      console.log(`PASS pre-public-rename CAS rejects ${mutation} without moving created leaf`);
    } finally {
      closeMixed(hostile);
    }
  }

  const afterReceiptHelper = compileHelper('rollback-after-receipt-pause', [
    'WRITCRAFT_TEST_PAUSE_ROLLBACK_AFTER_RECEIPT',
  ]);
  for (const mutation of [
    'marker-new-inode', 'history-same-inode', 'existing-new-inode',
    'root-new-inode', 'recovery-new-inode',
  ]) {
    const hostile = mixedFixture(afterReceiptHelper);
    try {
      const raw = runPaused(
        hostile,
        afterReceiptHelper,
        schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
        'rollback-after-receipt',
        mutation
      );
      assert.strictEqual(raw.code, 0);
      assert.match(raw.stdout, /^P\tOK\nQ\tRESULT\tUNKNOWN\t/m);
      console.log(`PASS post-receipt terminal CAS rejects ${mutation}`);
    } finally {
      closeMixed(hostile);
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
