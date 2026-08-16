#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const evidence = require('../src/main/evidence-delivery-schema');
const lifecycle = require('../src/main/changes-history-marker-lifecycle');
const markerSchema = require('../src/main/changes-history-marker-lifecycle-schema');
const nativeBuild = require('../scripts/build-native-helper');

const SOURCE = path.join(__dirname, '..', 'native', 'changes-history-artifact-helper.c');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-marker-lifecycle-'));
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

function compile(name, definitions = []) {
  const output = path.join(scratch, name);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-mmacosx-version-min=11.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`), SOURCE, '-o', output,
  ]);
  return output;
}

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function rootIdentity(target) {
  const stat = fs.statSync(target, { bigint: true });
  return Object.freeze({
    schema: evidence.SCHEMAS.ROOT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
  });
}

function projectChainIdentity(rootPath) {
  const components = [];
  let current = path.parse(rootPath).root;
  for (const name of rootPath.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, name);
    const stat = fs.statSync(current, { bigint: true });
    components.push(Object.freeze({
      nameSha256: digest(Buffer.from(name, 'utf8')),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
    }));
  }
  const metadataName = '.writcraft';
  const metadataStat = fs.statSync(path.join(rootPath, metadataName), { bigint: true });
  components.push(Object.freeze({
    nameSha256: digest(Buffer.from(metadataName, 'utf8')),
    dev: metadataStat.dev.toString(),
    ino: metadataStat.ino.toString(),
    uid: Number(metadataStat.uid),
    mode: Number(metadataStat.mode & 0o7777n),
  }));
  return Object.freeze({ schema: evidence.SCHEMAS.ANCESTOR_IDENTITY, components });
}

function fixture(helperPath, bytes = Buffer.from('{"terminal":true}\n')) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
  const recovery = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(rootPath, '.writcraft'), 0o700);
  fs.chmodSync(recovery, 0o700);
  const markerPath = path.join(recovery, markerSchema.MARKER_BASENAME);
  fs.writeFileSync(markerPath, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(markerPath, 0o600);
  const heldFd = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stat = fs.fstatSync(heldFd, { bigint: true });
  const markerDigest = digest(bytes);
  const identity = Object.freeze({
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    contentSha256: markerDigest,
  });
  const request = Object.freeze({
    schema: markerSchema.SCHEMAS.REQUEST,
    operationId: `chr_${crypto.randomBytes(24).toString('hex')}`,
    projectId: 'marker-project',
    markerBasename: markerSchema.MARKER_BASENAME,
    markerByteLength: bytes.length,
    markerDigest,
    markerIdentityDigest: evidence.digestObjectIdentity(identity),
    finalizedPhaseDigest: `sha256:${'3'.repeat(64)}`,
    artifactCleanupDigest: `sha256:${'4'.repeat(64)}`,
    trustedRootIdentityDigest: evidence.digestRootIdentity(rootIdentity('/')),
    projectChainIdentityDigest: evidence.digestAncestorIdentity(projectChainIdentity(rootPath)),
    recoveryIdentityDigest: evidence.digestRootIdentity(rootIdentity(recovery)),
  });
  const scoped = lifecycle.createChangesHistoryMarkerLifecycle({ helperPath }).forProject(rootPath);
  return { rootPath, recovery, markerPath, heldFd, identity, request, scoped };
}

function closeFixture(item) {
  try { fs.closeSync(item.heldFd); } catch (_) {}
}

function clearBinding(item) {
  return Object.freeze({
    request: item.request,
    heldFd: item.heldFd,
    identity: item.identity,
  });
}

function markerResidue(item) {
  return fs.readdirSync(item.recovery).filter(name =>
    name.startsWith('.changes-history-marker-clear')
  );
}

function interceptedScoped(item, helperPath, intercept) {
  return lifecycle.createChangesHistoryMarkerLifecycle({
    helperPath,
    spawnSync(command, args, options) {
      intercept(options.input);
      return childProcess.spawnSync(command, args, options);
    },
  }).forProject(item.rootPath);
}

function replaceRecoveryAuthorityWithClones(item, scope) {
  const names = markerSchema.recordNames(item.request);
  let originalRecovery;
  let replacementRecovery;
  if (scope === 'project') {
    const ownedRoot = `${item.rootPath}.owned`;
    fs.renameSync(item.rootPath, ownedRoot);
    originalRecovery = path.join(ownedRoot, '.writcraft', 'recovery');
    replacementRecovery = path.join(item.rootPath, '.writcraft', 'recovery');
    fs.mkdirSync(replacementRecovery, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(item.rootPath, '.writcraft'), 0o700);
  } else if (scope === 'metadata') {
    const metadata = path.join(item.rootPath, '.writcraft');
    const ownedMetadata = path.join(item.rootPath, '.writcraft-owned');
    fs.renameSync(metadata, ownedMetadata);
    originalRecovery = path.join(ownedMetadata, 'recovery');
    replacementRecovery = path.join(metadata, 'recovery');
    fs.mkdirSync(replacementRecovery, { recursive: true, mode: 0o700 });
    fs.chmodSync(metadata, 0o700);
  } else {
    originalRecovery = `${item.recovery}.owned`;
    fs.renameSync(item.recovery, originalRecovery);
    replacementRecovery = item.recovery;
    fs.mkdirSync(replacementRecovery, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(replacementRecovery, 0o700);
  for (const name of [names.controlBasename, names.receiptBasename]) {
    const bytes = fs.readFileSync(path.join(originalRecovery, name));
    fs.writeFileSync(path.join(replacementRecovery, name), bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(path.join(replacementRecovery, name), 0o600);
  }
  return { names, originalRecovery, replacementRecovery };
}

function nativeMarkerRequest(item, command = 'CLEAR') {
  const request = item.request;
  const identity = item.identity;
  return [
    'M', command, request.operationId,
    Buffer.from(request.projectId, 'utf8').toString('hex'), request.markerBasename,
    String(request.markerByteLength), request.markerDigest, request.markerIdentityDigest,
    request.finalizedPhaseDigest, request.artifactCleanupDigest,
    markerSchema.requestDigest(request), request.trustedRootIdentityDigest,
    request.projectChainIdentityDigest, request.recoveryIdentityDigest,
    identity.dev, identity.ino, String(identity.uid), String(identity.mode),
    String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
  ].join('\t');
}

function invokeNativeMarker(helperPath, item, command = 'CLEAR') {
  const trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    return childProcess.spawnSync(helperPath, [], {
      input: [
        `P\t${Buffer.from(item.rootPath, 'utf8').toString('hex')}`,
        nativeMarkerRequest(item, command),
        '',
      ].join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', trustedRootFd, item.heldFd],
    });
  } finally { fs.closeSync(trustedRootFd); }
}

function markerControlBytes(item, quarantineBasename) {
  const control = markerSchema.buildControl(item.request, quarantineBasename);
  return markerSchema.encodeControlRecord(item.request, control);
}

function markerReceiptBytes(item, quarantineBasename) {
  const control = markerSchema.buildControl(item.request, quarantineBasename);
  const receipt = markerSchema.buildReceipt(item.request, control);
  return markerSchema.encodeReceiptRecord(item.request, control, receipt);
}

console.log('\nChanges/History native exact marker lifecycle verification');
const helper = compile('changes-history-artifact-helper-marker');

test('production module exposes the project-scoped exact marker lifecycle', () => {
  assert.strictEqual(typeof lifecycle.createChangesHistoryMarkerLifecycle, 'function');
  const item = fixture(helper);
  try {
    assert.deepStrictEqual(Reflect.ownKeys(item.scoped), ['schema', 'clear']);
  } finally { closeFixture(item); }
});

test('marker lifecycle reuses the existing signed artifact-helper build slot', () => {
  assert.deepStrictEqual(nativeBuild.NATIVE_HELPERS.changesHistoryArtifact, {
    sourceName: 'changes-history-artifact-helper.c',
    outputName: 'changes-history-artifact-helper',
  });
  assert.strictEqual(lifecycle.HELPER_PATH.endsWith('changes-history-artifact-helper'), true);
});

for (const kind of ['exact', 'foreign']) {
  test(`CLEAR preserves a preexisting ${kind} deterministic control and returns UNKNOWN`, () => {
    const item = fixture(helper, Buffer.from(`preexisting ${kind} control\n`));
    const names = markerSchema.recordNames(item.request);
    const controlPath = path.join(item.recovery, names.controlBasename);
    const quarantine = `.changes-history-marker-clear.${'5'.repeat(32)}`;
    const bytes = kind === 'exact' ? markerControlBytes(item, quarantine) : 'foreign control\n';
    try {
      fs.writeFileSync(controlPath, bytes, { flag: 'wx', mode: 0o600 });
      const markerBefore = fs.readFileSync(item.markerPath);
      const result = invokeNativeMarker(helper, item);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /M\tOK\tCLEAR\tUNKNOWN\t/);
      assert(fs.readFileSync(item.markerPath).equals(markerBefore));
      assert.strictEqual(fs.readFileSync(controlPath, 'utf8'), bytes);
      assert.strictEqual(fs.existsSync(path.join(item.recovery, quarantine)), false);
    } finally { closeFixture(item); }
  });
}

for (const kind of ['exact', 'foreign']) {
  test(`CLEAR preserves a preexisting ${kind} deterministic receipt-only set with zero writes`, () => {
    const item = fixture(helper, Buffer.from(`preexisting ${kind} receipt\n`));
    const names = markerSchema.recordNames(item.request);
    const controlPath = path.join(item.recovery, names.controlBasename);
    const receiptPath = path.join(item.recovery, names.receiptBasename);
    const quarantine = `.changes-history-marker-clear.${'6'.repeat(32)}`;
    const bytes = kind === 'exact' ? markerReceiptBytes(item, quarantine) : 'foreign receipt\n';
    try {
      fs.writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 });
      const markerBefore = fs.statSync(item.markerPath, { bigint: true });
      const receiptBefore = fs.statSync(receiptPath, { bigint: true });
      const result = invokeNativeMarker(helper, item);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /M\tOK\tCLEAR\tUNKNOWN\t/);
      const markerAfter = fs.statSync(item.markerPath, { bigint: true });
      const receiptAfter = fs.statSync(receiptPath, { bigint: true });
      assert.strictEqual(markerAfter.ino, markerBefore.ino);
      assert.strictEqual(markerAfter.ctimeNs, markerBefore.ctimeNs);
      assert.strictEqual(receiptAfter.ino, receiptBefore.ino);
      assert.strictEqual(receiptAfter.ctimeNs, receiptBefore.ctimeNs);
      assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), bytes);
      assert.strictEqual(fs.existsSync(controlPath), false);
      assert.strictEqual(fs.existsSync(path.join(item.recovery, quarantine)), false);
    } finally { closeFixture(item); }
  });
}

test('CLEAR exact-quarantines the held marker and ACK removes only formal records', () => {
  const item = fixture(helper);
  try {
    const result = item.scoped.clear(clearBinding(item));
    assert.strictEqual(result.state, 'ACKED');
    assert.strictEqual(fs.existsSync(item.markerPath), false);
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-marker-clear')),
      []
    );
  } finally { closeFixture(item); }
});

for (const [label, macro, markerExists, quarantineExists] of [
  ['control durable before marker rename', 'WRITCRAFT_TEST_MARKER_CRASH_OPEN_RENAME', true, false],
  ['marker renamed before quarantine reopen', 'WRITCRAFT_TEST_MARKER_CRASH_RENAME_REOPEN', false, true],
  ['quarantine reopened before unlink', 'WRITCRAFT_TEST_MARKER_CRASH_REOPEN_UNLINK', false, true],
  ['marker unlinked before recovery fsync', 'WRITCRAFT_TEST_MARKER_CRASH_UNLINK_FSYNC', false, false],
]) {
  test(`${label} fresh-reconciles without replaying CLEAR`, () => {
    const faultHelper = compile(`marker-${macro.toLowerCase()}`, [macro]);
    const item = fixture(faultHelper, Buffer.from(`${label}\n`));
    try {
      assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fs.existsSync(item.markerPath), markerExists);
      assert.strictEqual(markerResidue(item).some(name =>
        /^\.changes-history-marker-clear\.[a-f0-9]{32}$/u.test(name)
      ), quarantineExists);
      if (markerExists) assert.deepStrictEqual(markerResidue(item), []);
    } finally { closeFixture(item); }
  });
}

test('committed CLEAR response loss fresh-reconciles and never replays marker removal', () => {
  const faultHelper = compile('marker-drop-committed', [
    'WRITCRAFT_TEST_MARKER_DROP_COMMITTED_RESPONSE',
  ]);
  const item = fixture(faultHelper, Buffer.from('drop committed response\n'));
  try {
    assert.strictEqual(item.scoped.clear(clearBinding(item)).state, 'ACKED');
    assert.strictEqual(fs.existsSync(item.markerPath), false);
    assert.deepStrictEqual(markerResidue(item), []);
  } finally { closeFixture(item); }
});

test('ACK response loss retries only the exact token and returns idempotent ACKED', () => {
  const faultHelper = compile('marker-drop-ack', ['WRITCRAFT_TEST_MARKER_DROP_ACK_RESPONSE']);
  const item = fixture(faultHelper, Buffer.from('drop ACK response\n'));
  try {
    assert.strictEqual(item.scoped.clear(clearBinding(item)).state, 'ACKED');
    assert.strictEqual(fs.existsSync(item.markerPath), false);
    assert.deepStrictEqual(markerResidue(item), []);
  } finally { closeFixture(item); }
});

for (const recordKind of ['control', 'receipt']) {
  for (const attack of ['same-inode-same-bytes', 'new-inode-same-bytes']) {
    test(`ACK preserves ${attack} ${recordKind} publication-identity drift`, () => {
      const item = fixture(helper, Buffer.from(`${recordKind} ${attack}\n`));
      const names = markerSchema.recordNames(item.request);
      const basename = recordKind === 'control' ? names.controlBasename : names.receiptBasename;
      const recordPath = path.join(item.recovery, basename);
      const ownedPath = `${recordPath}.owned`;
      let attacked = false;
      const scoped = interceptedScoped(item, helper, input => {
        if (attacked || !input.includes('\nM\tACK\t')) return;
        attacked = true;
        const bytes = fs.readFileSync(recordPath);
        if (attack === 'same-inode-same-bytes') {
          fs.writeFileSync(recordPath, bytes);
        } else {
          fs.renameSync(recordPath, ownedPath);
          fs.writeFileSync(recordPath, bytes, { flag: 'wx', mode: 0o600 });
        }
      });
      try {
        assert.throws(() => scoped.clear(clearBinding(item)), error =>
          error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
        assert.strictEqual(attacked, true);
        assert.strictEqual(fs.existsSync(recordPath), true);
        if (attack === 'new-inode-same-bytes') assert.strictEqual(fs.existsSync(ownedPath), true);
        const other = recordKind === 'control' ? names.receiptBasename : names.controlBasename;
        assert.strictEqual(fs.existsSync(path.join(item.recovery, other)), true);
      } finally { closeFixture(item); }
    });
  }
}

for (const scope of ['metadata', 'recovery']) {
  test(`ACK preserves foreign clones after ${scope} authority replacement`, () => {
    const item = fixture(helper, Buffer.from(`ACK ${scope} replacement\n`));
    let replacement = null;
    const scoped = interceptedScoped(item, helper, input => {
      if (replacement || !input.includes('\nM\tACK\t')) return;
      replacement = replaceRecoveryAuthorityWithClones(item, scope);
    });
    try {
      assert.throws(() => scoped.clear(clearBinding(item)), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert(replacement);
      for (const name of [replacement.names.controlBasename, replacement.names.receiptBasename]) {
        assert.strictEqual(fs.existsSync(path.join(replacement.originalRecovery, name)), true);
        assert.strictEqual(fs.existsSync(path.join(replacement.replacementRecovery, name)), true);
      }
    } finally { closeFixture(item); }
  });
}

test('fresh RECONCILE preserves formal records and foreign clones after project-root replacement', () => {
  const faultHelper = compile('marker-root-drift-after-commit', [
    'WRITCRAFT_TEST_MARKER_DROP_COMMITTED_RESPONSE',
  ]);
  const item = fixture(faultHelper, Buffer.from('fresh reconcile root replacement\n'));
  let replacement = null;
  let calls = 0;
  const scoped = lifecycle.createChangesHistoryMarkerLifecycle({
    helperPath: faultHelper,
    spawnSync(command, args, options) {
      calls += 1;
      const result = childProcess.spawnSync(command, args, options);
      if (calls === 1) replacement = replaceRecoveryAuthorityWithClones(item, 'project');
      return result;
    },
  }).forProject(item.rootPath);
  try {
    assert.throws(() => scoped.clear(clearBinding(item)), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(calls, 2);
    for (const name of [replacement.names.controlBasename, replacement.names.receiptBasename]) {
      assert.strictEqual(fs.existsSync(path.join(replacement.originalRecovery, name)), true);
      assert.strictEqual(fs.existsSync(path.join(replacement.replacementRecovery, name)), true);
    }
  } finally { closeFixture(item); }
});

for (const attack of ['same-inode-same-bytes', 'new-inode-same-bytes']) {
  test(`${attack} marker drift is preserved and cannot mint committed truth`, () => {
    const item = fixture(helper, Buffer.from(`${attack}\n`));
    const originalBytes = fs.readFileSync(item.markerPath);
    const moved = `${item.markerPath}.owned`;
    try {
      if (attack === 'same-inode-same-bytes') {
        fs.writeFileSync(item.markerPath, originalBytes);
      } else {
        fs.renameSync(item.markerPath, moved);
        fs.writeFileSync(item.markerPath, originalBytes, { flag: 'wx', mode: 0o600 });
      }
      assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert(fs.readFileSync(item.markerPath).equals(originalBytes));
      if (attack === 'new-inode-same-bytes') assert(fs.readFileSync(moved).equals(originalBytes));
    } finally { closeFixture(item); }
  });
}

test('late visible-name replacement is preserved with exact quarantine evidence', () => {
  const faultHelper = compile('marker-late-replacement', [
    'WRITCRAFT_TEST_MARKER_LATE_REPLACEMENT',
  ]);
  const item = fixture(faultHelper, Buffer.from('late marker replacement\n'));
  try {
    assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.existsSync(item.markerPath), true);
    assert.strictEqual(fs.statSync(item.markerPath).size, 0);
    assert.strictEqual(markerResidue(item).some(name =>
      /^\.changes-history-marker-clear\.[a-f0-9]{32}$/u.test(name)
    ), true);
  } finally { closeFixture(item); }
});

test('late ACK receipt replacement is preserved and cannot be path-unlinked', () => {
  const faultHelper = compile('marker-ack-late-receipt', [
    'WRITCRAFT_TEST_MARKER_ACK_LATE_RECEIPT',
  ]);
  const item = fixture(faultHelper, Buffer.from('late ACK receipt\n'));
  try {
    assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    const names = markerSchema.recordNames(item.request);
    assert.strictEqual(
      fs.readFileSync(path.join(item.recovery, names.receiptBasename), 'utf8'),
      'foreign marker receipt\n'
    );
    assert.strictEqual(fs.existsSync(item.markerPath), false);
  } finally { closeFixture(item); }
});

test('wrong-name duplicate marker authority blocks before marker mutation', () => {
  const item = fixture(helper, Buffer.from('duplicate marker control\n'));
  const hostile = path.join(
    item.recovery,
    `.changes-history-marker-clear-control.${'f'.repeat(64)}`
  );
  try {
    fs.writeFileSync(hostile, 'foreign duplicate\n', { flag: 'wx', mode: 0o600 });
    const before = fs.readFileSync(item.markerPath);
    assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert(fs.readFileSync(item.markerPath).equals(before));
    assert.strictEqual(fs.readFileSync(hostile, 'utf8'), 'foreign duplicate\n');
  } finally { closeFixture(item); }
});

test('2,048-entry recovery scan budget fails closed before marker mutation', () => {
  const item = fixture(helper, Buffer.from('marker scan budget\n'));
  try {
    for (let index = 0; index < 2049; index += 1) {
      fs.writeFileSync(path.join(item.recovery, `foreign-${index}`), '', { flag: 'wx', mode: 0o600 });
    }
    const before = fs.readFileSync(item.markerPath);
    assert.throws(() => item.scoped.clear(clearBinding(item)), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert(fs.readFileSync(item.markerPath).equals(before));
    assert.deepStrictEqual(markerResidue(item), []);
  } finally { closeFixture(item); }
});

test('Unicode project authority matches repository canonical digest bytes', () => {
  const item = fixture(helper, Buffer.from('Unicode project marker\n'));
  try {
    item.request = Object.freeze({
      ...item.request,
      projectId: '作者"\\草稿😀',
    });
    assert.strictEqual(item.scoped.clear(clearBinding(item)).state, 'ACKED');
    assert.strictEqual(fs.existsSync(item.markerPath), false);
  } finally { closeFixture(item); }
});

test('accessor, extra and cross-binding drift fail before helper spawn', () => {
  const item = fixture(helper, Buffer.from('pre-spawn hostile\n'));
  let spawns = 0;
  const scoped = lifecycle.createChangesHistoryMarkerLifecycle({
    spawnSync() { spawns += 1; throw new Error('must not spawn'); },
  }).forProject(item.rootPath);
  try {
    const extra = { ...clearBinding(item), absolutePath: item.markerPath };
    assert.throws(() => scoped.clear(extra), error => error?.code === 'MARKER_CLEAR_PROTOCOL');
    let getters = 0;
    const request = { ...item.request };
    Object.defineProperty(request, 'markerDigest', {
      enumerable: true,
      get() { getters += 1; return item.request.markerDigest; },
    });
    assert.throws(() => scoped.clear({ ...clearBinding(item), request }), error =>
      error?.code === 'MARKER_CLEAR_PROTOCOL');
    assert.strictEqual(getters, 0);
    assert.throws(() => scoped.clear({
      ...clearBinding(item),
      identity: { ...item.identity, size: String(Number(item.identity.size) + 1) },
    }), error => error?.code === 'MARKER_CLEAR_PROTOCOL');
    assert.strictEqual(spawns, 0);
    assert.strictEqual(fs.existsSync(item.markerPath), true);
  } finally { closeFixture(item); }
});

test('malformed stdout and raw stderr are bounded, redacted and never replay CLEAR', () => {
  for (const attack of ['stdout', 'stderr']) {
    const item = fixture(helper, Buffer.from(`redaction ${attack}\n`));
    const inputs = [];
    let calls = 0;
    const scoped = lifecycle.createChangesHistoryMarkerLifecycle({
      spawnSync(_helper, _args, options) {
        calls += 1;
        inputs.push(options.input);
        return attack === 'stdout'
          ? { status: 0, signal: null, stdout: 'P\tOK\n/private/tmp/marker body\n', stderr: '' }
          : { status: 0, signal: null, stdout: 'P\tOK\n', stderr: '/private/tmp/raw marker body' };
      },
    }).forProject(item.rootPath);
    try {
      assert.throws(() => scoped.clear(clearBinding(item)), error => {
        assert.strictEqual(error?.code, 'CHANGES_MANUAL_RECOVERY_REQUIRED');
        assert.strictEqual(error.message.includes('/private/'), false);
        assert.strictEqual(error.message.includes('body'), false);
        return true;
      });
      assert.strictEqual(calls, 2, 'only CLEAR and one fresh RECONCILE are attempted');
      assert.strictEqual(inputs[0].includes('CLEAR'), true);
      assert.strictEqual(inputs[1].includes('RECONCILE'), true);
      assert.strictEqual(inputs.join('\n').includes('redaction'), false);
      assert.strictEqual(fs.existsSync(item.markerPath), true);
    } finally { closeFixture(item); }
  }
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`${passed}/${passed} native exact marker lifecycle checks passed.`);
