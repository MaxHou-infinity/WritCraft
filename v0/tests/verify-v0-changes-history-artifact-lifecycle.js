#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const historyService = require('../src/main/change-history-service');
const { createChangesHistoryReconciliationService } = require(
  '../src/main/changes-history-reconciliation-service'
);
const { createChangesHistoryTransaction } = require('../src/main/changes-history-transaction');
const lifecycleService = require('../src/main/changes-history-artifact-lifecycle');
const publicMarkdownPhaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const nativeHelperBuild = require('../scripts/build-native-helper');

const SOURCE = path.join(__dirname, '..', 'native', 'changes-history-artifact-helper.c');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-chra-lifecycle-'));
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}${error?.nativeCode ? ` (${error.nativeCode})` : ''}`);
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

function fixture(helperPath, content = Buffer.from('artifact bytes\n')) {
  const parent = fs.mkdtempSync(path.join(scratch, 'project-'));
  const project = projectService.createProjectAt(parent, 'Artifact Lifecycle');
  const recovery = path.join(project.rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(recovery, 0o700);
  const basename = `changes-history-chr_${'a'.repeat(48)}.bin`;
  const target = path.join(recovery, basename);
  fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
  const heldFd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stat = fs.fstatSync(heldFd, { bigint: true });
  const request = Object.freeze({
    basename,
    heldFd,
    identity: Object.freeze({
      dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(),
      mode: stat.mode.toString(), nlink: stat.nlink.toString(), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    }),
    binding: Object.freeze({
      byteLength: content.length,
      sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    }),
  });
  const scoped = lifecycleService.createChangesHistoryArtifactLifecycle({ helperPath })
    .forProject(project.rootPath);
  return { parent, project, recovery, basename, target, heldFd, request, scoped };
}

function closeFixture(item) {
  try { fs.closeSync(item.heldFd); } catch (_) {}
}

function requestForFd(item, heldFd) {
  const stat = fs.fstatSync(heldFd, { bigint: true });
  return Object.freeze({
    ...item.request,
    heldFd,
    identity: Object.freeze({
      dev: stat.dev.toString(), ino: stat.ino.toString(), uid: stat.uid.toString(),
      mode: stat.mode.toString(), nlink: stat.nlink.toString(), size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
    }),
  });
}

function replaceWithSelfHashedForeign(target, label) {
  const body = `FOREIGN\t${label}`;
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  fs.unlinkSync(target);
  fs.writeFileSync(target, `${body}\tsha256:${digest}\n`, { flag: 'wx', mode: 0o600 });
  return fs.readFileSync(target);
}

function recoveryState(content) {
  const bytes = Buffer.from(content, 'utf8');
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    exists: true,
    revision,
    contentHash: revision,
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  });
}

console.log('\nChanges / History native artifact lifecycle verification');

const helper = compile('changes-history-artifact-helper');

test('strict helper is in the signed native build allowlist', () => {
  assert.deepStrictEqual(nativeHelperBuild.NATIVE_HELPERS.changesHistoryArtifact, {
    sourceName: 'changes-history-artifact-helper.c',
    outputName: 'changes-history-artifact-helper',
  });
});

test('development production adapter resolves the built signed helper path', () => {
  fs.accessSync(lifecycleService.HELPER_PATH, fs.constants.R_OK | fs.constants.X_OK);
  const item = fixture(lifecycleService.HELPER_PATH, Buffer.from('default production adapter\n'));
  try {
    const token = item.scoped.cleanup(item.request);
    item.scoped.acknowledge(item.basename, token);
    assert.strictEqual(fs.existsSync(item.target), false);
  } finally { closeFixture(item); }
});

test('cleanup exact-quarantines, reopens, unlinks, fsyncs, then ACKs its receipt', () => {
  const item = fixture(helper);
  try {
    const token = item.scoped.cleanup(item.request);
    assert.strictEqual(fs.existsSync(item.target), false);
    assert.strictEqual(fs.existsSync(path.join(item.recovery, token.quarantine)), false);
    assert.strictEqual(fs.existsSync(path.join(item.recovery, token.receipt)), true);
    assert.deepStrictEqual(item.scoped.reconcile({
      basename: item.basename,
      byteLength: item.request.binding.byteLength,
      sha256: item.request.binding.sha256,
    }), token);
    const binding = {
      basename: item.basename,
      byteLength: item.request.binding.byteLength,
      sha256: item.request.binding.sha256,
    };
    assert.deepStrictEqual(item.scoped.verify(binding, token), token);
    assert.throws(() => item.scoped.verify(binding, {
      ...token,
      receiptDigest: `sha256:${'f'.repeat(64)}`,
    }));
    let getterCalls = 0;
    const accessor = { ...token };
    Object.defineProperty(accessor, 'receiptDigest', {
      enumerable: true,
      get() { getterCalls += 1; return token.receiptDigest; },
    });
    assert.throws(() => item.scoped.verify(binding, accessor));
    assert.strictEqual(getterCalls, 0);
    item.scoped.acknowledge(item.basename, token);
    assert.strictEqual(fs.existsSync(path.join(item.recovery, token.control)), false);
    assert.strictEqual(fs.existsSync(path.join(item.recovery, token.proof)), false);
    assert.strictEqual(fs.existsSync(path.join(item.recovery, token.receipt)), false);
  } finally { closeFixture(item); }
});

for (const [label, definition] of [
  ['open→rename response loss', 'WRITCRAFT_TEST_CRASH_OPEN_RENAME'],
  ['rename→reopen response loss', 'WRITCRAFT_TEST_CRASH_RENAME_REOPEN'],
  ['reopen→unlink response loss', 'WRITCRAFT_TEST_CRASH_REOPEN_UNLINK'],
  ['unlink→directory-fsync response loss', 'WRITCRAFT_TEST_CRASH_UNLINK_FSYNC'],
  ['committed response loss', 'WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE'],
]) {
  test(`${label} reconciles the same exact artifact to committed`, () => {
    const faultHelper = compile(`changes-history-artifact-${definition.toLowerCase()}`, [definition]);
    const item = fixture(faultHelper, Buffer.from(`${label}\n`));
    try {
      const token = item.scoped.cleanup(item.request);
      assert.strictEqual(fs.existsSync(item.target), false);
      assert.strictEqual(fs.existsSync(path.join(item.recovery, token.receipt)), true);
      item.scoped.acknowledge(item.basename, token);
    } finally { closeFixture(item); }
  });
}

test('late replacement is never deleted and leaves exact quarantine authority', () => {
  const faultHelper = compile('changes-history-artifact-late-replacement', [
    'WRITCRAFT_TEST_LATE_REPLACEMENT',
  ]);
  const item = fixture(faultHelper, Buffer.from('late replacement source\n'));
  try {
    assert.throws(() => item.scoped.cleanup(item.request), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.existsSync(item.target), true);
    assert.strictEqual(fs.statSync(item.target).size, 0);
    assert.strictEqual(
      fs.readdirSync(item.recovery).some(name => name.startsWith('.changes-history-cleanup.')),
      true
    );
  } finally { closeFixture(item); }
});

test('same-inode rewrite after sealing fails before quarantine or foreign unlink', () => {
  const item = fixture(helper, Buffer.from('sealed artifact A\n'));
  try {
    fs.writeFileSync(item.target, Buffer.from('sealed artifact B\n'));
    assert.throws(() => item.scoped.cleanup(item.request), error =>
      ['CHANGES_RECOVERY_CONFLICT', 'CHANGES_MANUAL_RECOVERY_REQUIRED'].includes(error?.code));
    assert.strictEqual(fs.readFileSync(item.target, 'utf8'), 'sealed artifact B\n');
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-cleanup')),
      []
    );
  } finally { closeFixture(item); }
});

test('writable held artifact fd fails before control publication', () => {
  const item = fixture(helper, Buffer.from('writable descriptor\n'));
  try {
    fs.closeSync(item.heldFd);
    item.heldFd = fs.openSync(item.target, fs.constants.O_RDWR);
    const request = requestForFd(item, item.heldFd);
    assert.throws(() => item.scoped.cleanup(request));
    assert.strictEqual(fs.readFileSync(item.target, 'utf8'), 'writable descriptor\n');
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-cleanup')),
      []
    );
  } finally { closeFixture(item); }
});

test('non-0600 artifact mode fails before control publication', () => {
  const item = fixture(helper, Buffer.from('unsafe mode\n'));
  try {
    fs.closeSync(item.heldFd);
    fs.chmodSync(item.target, 0o644);
    item.heldFd = fs.openSync(item.target, fs.constants.O_RDONLY);
    const request = requestForFd(item, item.heldFd);
    assert.throws(() => item.scoped.cleanup(request));
    assert.strictEqual(fs.readFileSync(item.target, 'utf8'), 'unsafe mode\n');
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-cleanup')),
      []
    );
  } finally { closeFixture(item); }
});

test('multiply-linked artifact fails before control publication', () => {
  const item = fixture(helper, Buffer.from('linked artifact\n'));
  const secondName = path.join(item.recovery, 'held-artifact-foreign-link');
  try {
    fs.linkSync(item.target, secondName);
    const request = requestForFd(item, item.heldFd);
    assert.throws(() => item.scoped.cleanup(request));
    assert.strictEqual(fs.readFileSync(item.target, 'utf8'), 'linked artifact\n');
    assert.strictEqual(fs.readFileSync(secondName, 'utf8'), 'linked artifact\n');
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-cleanup')),
      []
    );
  } finally { closeFixture(item); }
});

for (const recordKind of ['receipt', 'proof', 'control']) {
  test(`${recordKind} late replacement is never ACK-unlinked`, () => {
    const item = fixture(helper, Buffer.from(`${recordKind} late replacement\n`));
    try {
      const token = item.scoped.cleanup(item.request);
      if (recordKind !== 'receipt') fs.unlinkSync(path.join(item.recovery, token.receipt));
      const foreignPath = path.join(item.recovery, token[recordKind]);
      const foreignBytes = replaceWithSelfHashedForeign(foreignPath, recordKind);
      assert.throws(() => item.scoped.acknowledge(item.basename, token));
      assert.strictEqual(fs.readFileSync(foreignPath).equals(foreignBytes), true,
        'foreign replacement must remain untouched');
    } finally { closeFixture(item); }
  });
}

test('project-root replacement cannot redirect cleanup onto a foreign recovery tree', () => {
  const item = fixture(helper, Buffer.from('original artifact\n'));
  const movedRoot = `${item.project.rootPath}-moved`;
  try {
    fs.renameSync(item.project.rootPath, movedRoot);
    fs.mkdirSync(item.project.rootPath, { mode: 0o700 });
    fs.mkdirSync(path.join(item.project.rootPath, '.writcraft'), { mode: 0o700 });
    fs.mkdirSync(path.join(item.project.rootPath, '.writcraft', 'recovery'), { mode: 0o700 });
    const foreign = path.join(item.project.rootPath, '.writcraft', 'recovery', item.basename);
    fs.writeFileSync(foreign, Buffer.from('foreign artifact!\n'), { mode: 0o600 });
    assert.throws(() => item.scoped.cleanup(item.request));
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign artifact!\n');
    assert.strictEqual(fs.readFileSync(path.join(movedRoot, '.writcraft', 'recovery', item.basename), 'utf8'),
      'original artifact\n');
  } finally { closeFixture(item); }
});

test('rollback uses the same exact lifecycle and acknowledges terminal control authority', () => {
  const item = fixture(helper, Buffer.from('partial artifact'));
  try {
    item.scoped.rollback(item.request);
    assert.strictEqual(fs.existsSync(item.target), false);
    assert.deepStrictEqual(
      fs.readdirSync(item.recovery).filter(name => name.startsWith('.changes-history-cleanup')),
      []
    );
  } finally { closeFixture(item); }
});

test('clear retains marker authority across cleanup commit then marker directory-fsync failure', () => {
  const parent = fs.mkdtempSync(path.join(scratch, 'clear-project-'));
  const project = projectService.createProjectAt(parent, 'Artifact Clear Recovery');
  fs.mkdirSync(path.join(project.rootPath, '.writcraft', 'recovery'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(project.rootPath, '.writcraft', 'recovery'), 0o700);
  fs.writeFileSync(path.join(project.rootPath, 'chapter.md'), 'current chapter\n');
  const lifecycle = lifecycleService.createChangesHistoryArtifactLifecycle({ helperPath: helper });
  const markerFile = path.join(project.rootPath, '.writcraft', 'recovery', 'changes-history-transaction.json');
  let injectClearFsync = false;
  const fileSystem = Object.create(fs);
  fileSystem.fsyncSync = fd => {
    if (injectClearFsync && !fs.existsSync(markerFile)) {
      injectClearFsync = false;
      throw new Error('injected marker directory fsync failure');
    }
    return fs.fsyncSync(fd);
  };
  const reconciliation = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    exactArtifactLifecycle: lifecycle,
    fileSystem,
  });
  const transaction = createChangesHistoryTransaction({
    projectService,
    historyService,
    reconciliationService: reconciliation,
  });
  const before = recoveryState('current chapter\n');
  const after = recoveryState('snapshot chapter\n');
  const result = transaction.snapshotRestore({
    rootPath: project.rootPath,
    projectId: project.projectId,
    files: [{
      path: 'chapter.md',
      summary: '恢复章节',
      before,
      after,
      createdIdentityDigest: null,
    }],
    provenance: {
      schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
      snapshotId: 'snapshot_native_clear',
      snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
      restoreCapabilityId: 'capability_native_clear',
      comparisonDigest: `sha256:${'2'.repeat(64)}`,
      selectedIds: ['selected_native_clear'],
    },
    parentSelectionBinding: publicMarkdownPhaseSchema.assertParentSelectionBinding({
      schema: publicMarkdownPhaseSchema.SELECTION_SCHEMA,
      kind: 'snapshot_restore',
      selected: [{
        selectedId: 'selected_native_clear',
        action: 'EXISTING',
        path: 'chapter.md',
        revision: after.revision,
        ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
      }],
    }),
    execute() { throw new Error('zero-write fixture'); },
  });
  assert.strictEqual(result.outcome, 'zero_write_error');
  injectClearFsync = true;
  assert.throws(() => reconciliation.clear(project.rootPath, project.projectId, result.operationId),
    error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED');
  assert.strictEqual(fs.existsSync(markerFile), true, 'marker must remain the retry entrypoint');
  assert.strictEqual(
    fs.readdirSync(path.dirname(markerFile)).some(name => name.startsWith('.changes-history-cleanup-receipt.')),
    true,
    'terminal cleanup receipt must survive marker-clear failure'
  );
  assert.deepStrictEqual(
    reconciliation.clear(project.rootPath, project.projectId, result.operationId),
    { ok: true, operationId: result.operationId }
  );
  assert.strictEqual(fs.existsSync(markerFile), false);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(markerFile)).filter(name => name.startsWith('.changes-history-cleanup')),
    []
  );
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`Changes / History native artifact lifecycle verification: ${passed}/${passed} passed`);
