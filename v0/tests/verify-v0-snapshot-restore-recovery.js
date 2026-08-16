#!/usr/bin/env node
// 证据级别：COMPONENT + 边界证据。artifact 边界使用自认的测试替身
// trustedFakeArtifactLifecycle，不能作为真实 native 生命周期的签收证据。
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const historyService = require('../src/main/change-history-service');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const {
  MAX_FILES,
  MAX_MARKER_BYTES,
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');
const {
  createChangesHistoryTransaction: createChangesHistoryTransactionImpl,
} = require('../src/main/changes-history-transaction');
const recoveryArtifact = require('../src/main/changes-history-recovery-artifact');

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

function fixture(files = { 'a.md': 'current A\n' }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-recovery-'));
  const project = projectService.createProjectAt(parent, 'Snapshot Recovery');
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(project.rootPath, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
  return {
    parent,
    project,
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}

function markerPath(rootPath) {
  return path.join(rootPath, '.writcraft', 'recovery', 'changes-history-transaction.json');
}

function digestBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function state(content) {
  const bytes = Buffer.from(content, 'utf8');
  const digest = digestBytes(bytes);
  return {
    exists: true,
    revision: digest,
    contentHash: digest,
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

function absent() {
  return {
    exists: false,
    revision: null,
    contentHash: null,
    byteLength: 0,
    encoding: null,
    data: null,
  };
}

function provenance(selectedIds) {
  return {
    schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    snapshotId: 'snapshot_recovery_a',
    snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
    restoreCapabilityId: 'capability_recovery_a',
    comparisonDigest: `sha256:${'2'.repeat(64)}`,
    selectedIds,
  };
}

function withParentSelectionBinding(args) {
  if (args.parentSelectionBinding !== undefined ||
      !Array.isArray(args.files) || !Array.isArray(args.provenance?.selectedIds)) {
    return args;
  }
  return {
    ...args,
    parentSelectionBinding: {
      schema: phaseSchema.SELECTION_SCHEMA,
      kind: 'snapshot_restore',
      selected: args.files.map((file, index) => ({
        selectedId: args.provenance.selectedIds[index],
        action: file.before.exists === false ? 'MISSING' : 'EXISTING',
        path: file.path,
        revision: file.after.revision,
        ancestorIdentityDigest: file.ancestorIdentityDigest || `sha256:${'4'.repeat(64)}`,
      })),
    },
  };
}

function createChangesHistoryTransaction(options) {
  const transaction = createChangesHistoryTransactionImpl(options);
  return Object.freeze({
    ...transaction,
    prepareSnapshotRestore(args) {
      return transaction.prepareSnapshotRestore(withParentSelectionBinding(args));
    },
    snapshotRestore(args) {
      return transaction.snapshotRestore(withParentSelectionBinding(args));
    },
  });
}

function files() {
  return [{
    path: 'a.md',
    summary: '恢复已有章节',
    before: state('current A\n'),
    after: state('snapshot A\n'),
    createdIdentityDigest: null,
  }, {
    path: 'chapters/new.md',
    summary: '恢复缺失章节',
    before: absent(),
    after: state('snapshot new\n'),
    createdIdentityDigest: `sha256:${'3'.repeat(64)}`,
  }];
}

function stateReader(createdIdentityDigest) {
  return ({ rootPath, path: relative }) => {
    const absolute = path.join(rootPath, relative);
    if (!fs.existsSync(absolute)) return { exists: false };
    const bytes = fs.readFileSync(absolute);
    return {
      exists: true,
      revision: digestBytes(bytes),
      bytes,
      createdIdentityDigest: relative === 'chapters/new.md' ? createdIdentityDigest : null,
    };
  };
}

// Test-only stand-in for the native renameatx_np quarantine adapter. Product
// code never falls back to this path-based implementation.
function trustedFakeArtifactLifecycle() {
  const exactRemove = request => {
    const held = fs.fstatSync(request.heldFd, { bigint: true });
    const current = fs.lstatSync(path.join(request.directory, request.basename), { bigint: true });
    assert.strictEqual(held.dev.toString(), request.identity.dev);
    assert.strictEqual(held.ino.toString(), request.identity.ino);
    assert.strictEqual(current.dev, held.dev);
    assert.strictEqual(current.ino, held.ino);
    fs.unlinkSync(path.join(request.directory, request.basename));
    const directoryFd = fs.openSync(request.directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  };
  return Object.freeze({ cleanup: exactRemove, rollback: exactRemove });
}

const artifactLifecycle = trustedFakeArtifactLifecycle();

function writeState(rootPath, relative, nextState, expectedState) {
  const absolute = path.join(rootPath, relative);
  if (!nextState.exists) throw Object.assign(new Error('safe quarantine required'), {
    code: 'SNAPSHOT_RESTORE_QUARANTINE_UNAVAILABLE',
  });
  const content = Buffer.from(nextState.data, 'base64').toString('utf8');
  if (expectedState.exists) {
    projectService.atomicWriteFile(rootPath, relative, content, expectedState.revision);
  } else {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, { flag: 'wx', mode: 0o600 });
  }
}

function commitRestore(operation) {
  for (const file of operation.files) writeState(
    operation.rootPath,
    file.path,
    file.after,
    file.before
  );
  historyService.saveHistory(
    operation.rootPath,
    operation.historyPrepared.preparedHistoryState.history,
    { expectedState: operation.historyPrepared.baseHistoryState }
  );
  return { ok: true, status: 'applied' };
}

console.log('\nSnapshot restore Changes / History recovery verification');

test('failure matrix is bounded for 300 files and the 192 MiB History authority', () => {
  assert.strictEqual(MAX_FILES, 300);
  assert.strictEqual(historyService.MAX_HISTORY_BYTES, 192 * 1024 * 1024);
  assert.strictEqual(MAX_MARKER_BYTES, 96 * 1024 * 1024);
  const sixtyFourMiB = 64 * 1024 * 1024;
  const chunk = Math.floor(sixtyFourMiB / 300);
  const remainder = sixtyFourMiB - (chunk * 300);
  const maximumAccount = recoveryArtifact.accountSnapshotArtifact(
    Array.from({ length: 300 }, (_, index) => ({
      path: `${String(index).padStart(3, '0')}-${'x'.repeat(4086)}.md`,
      before: { exists: true, byteLength: chunk + (index < remainder ? 1 : 0) },
      after: { exists: true, byteLength: chunk + (index < remainder ? 1 : 0) },
      createdIdentityDigest: null,
    })),
    historyService.MAX_HISTORY_BYTES,
    recoveryArtifact.MAX_DELTA_BYTES
  );
  assert(maximumAccount > 320 * 1024 * 1024);
  assert(maximumAccount < recoveryArtifact.MAX_ARTIFACT_BYTES);
  const maximumControl = {
    files: Array.from({ length: 300 }, (_, index) => ({
      path: `${String(index).padStart(3, '0')}-${'x'.repeat(4086)}.md`,
      beforeExists: true,
      beforeRevision: '1'.repeat(64),
      afterExists: true,
      afterRevision: '2'.repeat(64),
      createdIdentityDigest: null,
    })),
  };
  assert(Buffer.byteLength(JSON.stringify(maximumControl), 'utf8') < 2 * 1024 * 1024);
  const maximumDeltaEntry = {
    id: `change_${crypto.randomUUID()}`,
    kind: 'application',
    changeSetId: `cs_${'a'.repeat(24)}`,
    status: 'applied',
    appliedAt: '2026-08-06T00:00:00.000Z',
    files: maximumControl.files.map((file, index) => ({
      path: file.path,
      summary: '😀'.repeat(1024),
      before: {
        exists: true, revision: file.beforeRevision, contentHash: file.beforeRevision,
        byteLength: chunk + (index < remainder ? 1 : 0), encoding: 'base64', data: '',
      },
      after: {
        exists: true, revision: file.afterRevision, contentHash: file.afterRevision,
        byteLength: chunk + (index < remainder ? 1 : 0), encoding: 'base64', data: '',
      },
      createdIdentityDigest: null,
    })),
    provenance: provenance(Array.from({ length: 300 }, (_, index) => `selected_${index}`)),
    integrity: '3'.repeat(64),
  };
  const maximumDelta = recoveryArtifact.preparedHistoryDelta(
    { schema: historyService.HISTORY_SCHEMA, entries: [] },
    { schema: historyService.HISTORY_SCHEMA, entries: [maximumDeltaEntry] }
  );
  assert(maximumDelta.length < recoveryArtifact.MAX_DELTA_BYTES);
  const item = fixture(Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
    `chapters/${String(index).padStart(3, '0')}.md`,
    `current ${index}\n`,
  ])));
  try {
    const maximum = Array.from({ length: 300 }, (_, index) => ({
      path: `chapters/${String(index).padStart(3, '0')}.md`,
      summary: `恢复 ${index}`,
      before: state(`current ${index}\n`),
      after: state(`snapshot ${index}\n`),
      createdIdentityDigest: null,
    }));
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: maximum,
      provenance: provenance(maximum.map((_, index) => `selected_${index}`)),
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: maximum.map((file, index) => ({
          selectedId: `selected_${index}`,
          action: 'EXISTING',
          path: file.path,
          revision: file.after.revision,
          ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
        })),
      },
      execute() { throw new Error('not committed'); },
    });
    assert.strictEqual(prepared.recoveryFiles.length, 300);
    assert(prepared.recoveryFiles.every(file => file.before.encoding === 'base64'));
    transaction.reconciliation.prepare(item.project.rootPath, {
      projectId: item.project.projectId,
      kind: prepared.kind,
      files: prepared.recoveryFiles,
      baseHistoryState: prepared.historyPrepared.baseHistoryState,
      preparedHistoryState: prepared.historyPrepared.preparedHistoryState,
    });
    const marker = JSON.parse(fs.readFileSync(markerPath(item.project.rootPath), 'utf8'));
    assert(Buffer.byteLength(JSON.stringify(marker), 'utf8') < 2 * 1024 * 1024);
    const artifactPath = path.join(
      item.project.rootPath,
      '.writcraft',
      'recovery',
      marker.artifact.basename
    );
    const baseBytes = 0;
    const preparedBytes = recoveryArtifact.preparedHistoryDelta(
      prepared.historyPrepared.baseHistoryState.history,
      prepared.historyPrepared.preparedHistoryState.history
    ).length;
    assert.strictEqual(
      fs.statSync(artifactPath).size,
      recoveryArtifact.accountSnapshotArtifact(maximum, baseBytes, preparedBytes)
    );
    const queried = transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(queried.recovery.outcome, 'zero_write_error');
    transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      queried.recovery.operationId
    );
    assert.strictEqual(fs.existsSync(artifactPath), false);
  } finally { item.cleanup(); }
});

test('snapshot artifact creation fails before marker and manuscript without native lifecycle', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    let executed = false;
    assert.throws(() => transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { executed = true; },
    }), error => error?.code === 'ARTIFACT_CLEANUP_UNAVAILABLE');
    assert.strictEqual(executed, false);
    assert.strictEqual(fs.existsSync(markerPath(item.project.rootPath)), false);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'current A\n');
    assert(!fs.readdirSync(path.join(item.project.rootPath, '.writcraft', 'recovery'))
      .some(name => name.endsWith('.bin')));
  } finally { item.cleanup(); }
});

test('cleanup quarantine residue blocks a new artifact transaction without deleting it', () => {
  const item = fixture();
  const recoveryDirectory = path.dirname(markerPath(item.project.rootPath));
  const residue = path.join(recoveryDirectory, `.changes-history-cleanup.${'a'.repeat(32)}`);
  try {
    fs.mkdirSync(recoveryDirectory, { recursive: true });
    fs.writeFileSync(residue, 'unreconciled quarantine');
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    assert.throws(() => transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { throw new Error('must not execute'); },
    }), error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(residue, 'utf8'), 'unreconciled quarantine');
    assert.strictEqual(fs.existsSync(markerPath(item.project.rootPath)), false);
  } finally { item.cleanup(); }
});

test('marker publication failure is zero-write and does not consume an unsafe fallback', () => {
  const item = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      beforeMarkerRename() { throw new Error('injected marker failure'); },
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    let executed = false;
    assert.throws(() => transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { executed = true; },
    }), error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED');
    assert.strictEqual(executed, false);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'current A\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
    assert(!fs.readdirSync(path.join(item.project.rootPath, '.writcraft', 'recovery'))
      .some(name => name.endsWith('.bin')));
  } finally { item.cleanup(); }
});

test('an original artifact basename is residue and is never overwritten or removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-artifact-eexist-'));
  const directory = path.join(root, '.writcraft', 'recovery');
  fs.mkdirSync(directory, { recursive: true });
  const operationId = `chr_${'a'.repeat(48)}`;
  const foreignPath = path.join(directory, `changes-history-${operationId}.bin`);
  fs.writeFileSync(foreignPath, 'foreign artifact');
  const empty = { exists: false, history: { schema: historyService.HISTORY_SCHEMA, entries: [] } };
  try {
    assert.throws(() => recoveryArtifact.writeSnapshotArtifact(
      directory,
      operationId,
      [],
      empty,
      { exists: true, history: empty.history },
      historyService,
      artifactLifecycle
    ), error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(foreignPath, 'utf8'), 'foreign artifact');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('forged pre-native created identity is rejected before mixed restore mutation', () => {
  const item = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    let calls = 0;
    assert.throws(() => transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: files(),
      provenance: provenance(['selected_a', 'selected_new']),
      execute(operation) {
        calls += 1;
        commitRestore(operation);
        throw new Error('response lost after manuscript and History commit');
      },
    }), error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.strictEqual(calls, 0);
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'current A\n');
    assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, 'chapters/new.md')), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
    assert.strictEqual(reconciliation.hasPending(item.project.rootPath), false);
  } finally { item.cleanup(); }
});

test('restart streams the artifact and reconstructs committed History after finish-response loss', () => {
  const item = fixture();
  const createdDigest = files()[1].createdIdentityDigest;
  try {
    let markerWrites = 0;
    const firstReconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      snapshotStateReader: stateReader(createdDigest),
      beforeMarkerRename() {
        markerWrites += 1;
        if (markerWrites === 2) throw new Error('terminal marker response lost');
      },
    });
    const first = createChangesHistoryTransaction({
      projectService,
      reconciliationService: firstReconciliation,
    });
    assert.throws(() => first.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute: commitRestore,
    }), error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED');
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      snapshotStateReader: stateReader(createdDigest),
    });
    const recovery = restarted.query(item.project.rootPath, item.project.projectId).recovery;
    assert.strictEqual(recovery.outcome, 'applied');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    restarted.clear(item.project.rootPath, item.project.projectId, recovery.operationId);
  } finally { item.cleanup(); }
});

test('same-size artifact corruption fails closed from the whole-artifact digest', () => {
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const result = transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { throw new Error('precommit failure'); },
    });
    assert.strictEqual(result.outcome, 'zero_write_error');
    const marker = JSON.parse(fs.readFileSync(markerPath(item.project.rootPath), 'utf8'));
    const artifactPath = path.join(
      item.project.rootPath,
      '.writcraft',
      'recovery',
      marker.artifact.basename
    );
    const fd = fs.openSync(artifactPath, 'r+');
    try {
      const original = Buffer.alloc(1);
      fs.readSync(fd, original, 0, 1, 0);
      fs.writeSync(fd, Buffer.from([original[0] ^ 0xff]), 0, 1, 0);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    assert.strictEqual(
      restarted.query(item.project.rootPath, item.project.projectId).recovery.outcome,
      'manual_recovery'
    );
  } finally { item.cleanup(); }
});

test('minified but valid base History keeps exact raw-byte zero-write authority across restart', () => {
  const item = fixture();
  try {
    const historyPath = path.join(item.project.rootPath, historyService.HISTORY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify({
      schema: historyService.HISTORY_SCHEMA,
      entries: [],
    }));
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const result = transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { throw new Error('precommit failure'); },
    });
    assert.strictEqual(result.outcome, 'zero_write_error');
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    assert.strictEqual(
      restarted.query(item.project.rootPath, item.project.projectId).recovery.outcome,
      'zero_write_error'
    );
  } finally { item.cleanup(); }
});

test('partial write rolled back before History remains a terminal zero-write', () => {
  const item = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    const result = transaction.snapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute(operation) {
        writeState(operation.rootPath, 'a.md', operation.files[0].after, operation.files[0].before);
        writeState(operation.rootPath, 'a.md', operation.files[0].before, operation.files[0].after);
        return { ok: false, status: 'rolled_back' };
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'zero_write_error');
    assert.strictEqual(fs.readFileSync(path.join(item.project.rootPath, 'a.md'), 'utf8'), 'current A\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
  } finally { item.cleanup(); }
});

test('an unrolled partial write or created-identity mismatch remains manual recovery', () => {
  const partial = fixture({ 'a.md': 'current A\n', 'b.md': 'current B\n' });
  try {
    const restoreFiles = [{
      path: 'a.md', summary: '恢复 A', before: state('current A\n'), after: state('snapshot A\n'),
      createdIdentityDigest: null,
    }, {
      path: 'b.md', summary: '恢复 B', before: state('current B\n'), after: state('snapshot B\n'),
      createdIdentityDigest: null,
    }];
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const result = transaction.snapshotRestore({
      rootPath: partial.project.rootPath,
      projectId: partial.project.projectId,
      files: restoreFiles,
      provenance: provenance(['selected_a', 'selected_b']),
      execute(operation) {
        writeState(operation.rootPath, 'a.md', operation.files[0].after, operation.files[0].before);
        throw new Error('second write failed and rollback failed');
      },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'manual_recovery');
    assert.strictEqual(fs.readFileSync(path.join(partial.project.rootPath, 'a.md'), 'utf8'), 'snapshot A\n');
    assert.strictEqual(fs.readFileSync(path.join(partial.project.rootPath, 'b.md'), 'utf8'), 'current B\n');
  } finally { partial.cleanup(); }

  const identity = fixture();
  try {
    const expectedCreated = files()[1].createdIdentityDigest;
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      snapshotStateReader: stateReader(`sha256:${'9'.repeat(64)}`),
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    assert.throws(() => transaction.snapshotRestore({
      rootPath: identity.project.rootPath,
      projectId: identity.project.projectId,
      files: files(),
      provenance: provenance(['selected_a', 'selected_new']),
      execute: commitRestore,
    }), error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.strictEqual(expectedCreated, `sha256:${'3'.repeat(64)}`);
    assert.strictEqual(reconciliation.hasPending(identity.project.rootPath), false);
    assert.strictEqual(historyService.loadHistory(identity.project.rootPath).entries.length, 0);
  } finally { identity.cleanup(); }
});

test('Safe Undo fails closed when its History entry is absent', () => {
  const item = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    const entryId = `change_${crypto.randomUUID()}`;
    assert.throws(() => transaction.snapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId,
    }), error => error?.code === 'HISTORY_NOT_FOUND');
    assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, 'chapters/new.md')), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);

    assert.throws(() => transaction.snapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId,
      execute() { throw new Error('must not run'); },
    }), error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.strictEqual(reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, 'chapters/new.md')), false);
  } finally { item.cleanup(); }
});

test('project drift rejects query and leaves the original project marker isolated', () => {
  const a = fixture();
  const b = fixture();
  try {
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
    });
    const transaction = createChangesHistoryTransaction({ projectService, reconciliationService: reconciliation });
    const result = transaction.snapshotRestore({
      rootPath: a.project.rootPath,
      projectId: a.project.projectId,
      files: [files()[0]],
      provenance: provenance(['selected_a']),
      execute() { throw new Error('precommit failure'); },
    });
    assert.strictEqual(result.outcome, 'zero_write_error');
    assert.throws(() => reconciliation.query(a.project.rootPath, b.project.projectId),
      error => error?.code === 'CHANGES_RECOVERY_STALE');
    assert.strictEqual(reconciliation.query(b.project.rootPath, b.project.projectId).recovery, null);
    assert.strictEqual(reconciliation.hasPending(a.project.rootPath), true);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

console.log(`\n${passed}/13 Snapshot restore recovery checks passed.`);
