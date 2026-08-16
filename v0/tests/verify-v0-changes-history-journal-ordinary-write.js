#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const historyService = require('../src/main/change-history-service');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');
const nativeJournal = require('../src/main/changes-history-marker-journal-native-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const publicNative = require('../src/main/public-markdown-native-schema');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');
const {
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');

const placeholderDigest = `sha256:${'a'.repeat(64)}`;
const discoverRequestDigest = nativeJournal.assertRequestAuthority({
  schema: nativeJournal.SCHEMAS.DISCOVER,
  command: 'DISCOVER',
}, 'DISCOVER').requestDigest;
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function emptyDiscover(status) {
  return {
    schema: nativeJournal.SCHEMAS.RESULT,
    command: 'DISCOVER',
    status,
    olderSlot: null,
    olderHead: null,
    olderPreviousValueDigest: null,
    olderValue: null,
    newerSlot: null,
    newerHead: null,
    newerPreviousValueDigest: null,
    requestDigest: placeholderDigest,
  };
}

function currentValueResult(value) {
  return {
    schema: nativeJournal.SCHEMAS.RESULT,
    command: 'READ',
    requestDigest: placeholderDigest,
    status: 'VALUE',
    head: journal.expectedHead(value),
    value,
  };
}

function mutationValueResult(command, value, request, forged = false) {
  const original = nativeJournal.assertRequestAuthority(request);
  let requestDigest = original.requestDigest;
  if (command === 'READ') {
    const readRequest = {
      schema: nativeJournal.SCHEMAS.READ,
      command: 'READ',
      expectedHeads: [...original.expectedHeads],
    };
    requestDigest = nativeJournal.assertRequestAuthority(readRequest, 'READ').requestDigest;
  }
  return {
    schema: nativeJournal.SCHEMAS.RESULT,
    command,
    requestDigest: forged ? placeholderDigest : requestDigest,
    status: 'VALUE',
    head: journal.expectedHead(value),
    value,
  };
}

function journalLifecycle(options = {}) {
  let current = null;
  let previous = null;
  let currentUnknown = false;
  let discoverTransform = null;
  const calls = { initialize: 0, append: 0, discoverCurrent: 0 };
  const scoped = {
    discover() {
      let result;
      if (current === null) result = emptyDiscover('ABSENT');
      else if (previous !== null) {
        result = {
          schema: nativeJournal.SCHEMAS.RESULT,
          command: 'DISCOVER',
          status: 'PAIR',
          olderSlot: BigInt(previous.generation) % 2n === 0n ? 'A' : 'B',
          olderHead: journal.expectedHead(previous),
          olderPreviousValueDigest: previous.previousValueDigest,
          olderValue: previous,
          newerSlot: BigInt(current.generation) % 2n === 0n ? 'A' : 'B',
          newerHead: journal.expectedHead(current),
          newerPreviousValueDigest: current.previousValueDigest,
          requestDigest: discoverRequestDigest,
        };
      } else result = currentValueResult(current);
      return typeof discoverTransform === 'function' ? discoverTransform(result) : result;
    },
    discoverCurrent() {
      calls.discoverCurrent += 1;
      if (currentUnknown) return emptyDiscover('UNKNOWN');
      if (current === null) return emptyDiscover('ABSENT');
      if (current.generation === '0') {
        return {
          schema: nativeJournal.SCHEMAS.RESULT,
          command: 'DISCOVER',
          status: 'BASE',
          olderSlot: 'A',
          olderHead: journal.expectedHead(current),
          olderPreviousValueDigest: null,
          olderValue: current,
          newerSlot: null,
          newerHead: null,
          newerPreviousValueDigest: null,
          requestDigest: placeholderDigest,
        };
      }
      return currentValueResult(current);
    },
    initialize(request) {
      calls.initialize += 1;
      nativeJournal.assertRequestAuthority(request, 'INIT');
      assert.strictEqual(current, null);
      current = request.initialValue;
      if (options.init === 'loss') return null;
      if (options.init === 'read-misroute') return mutationValueResult('READ', current, request);
      return mutationValueResult('INIT', current, request, options.init === 'forged');
    },
    append(request) {
      calls.append += 1;
      nativeJournal.assertRequestAuthority(request, 'APPEND');
      assert.strictEqual(current.valueDigest, request.previousValue.valueDigest);
      const appendMode = options.appendAt?.[calls.append] || options.append;
      if (appendMode === 'uncommitted-loss') return null;
      if (appendMode === 'unknown') {
        currentUnknown = true;
        return null;
      }
      previous = current;
      current = request.nextValue;
      if (typeof options.afterAppend === 'function') {
        const replacement = options.afterAppend({ call: calls.append, current, previous, request });
        if (replacement !== undefined) current = replacement;
      }
      if (appendMode === 'unknown-after-commit') {
        currentUnknown = true;
        return null;
      }
      if (appendMode === 'loss') return null;
      if (appendMode === 'high-read') return mutationValueResult('READ', current, request);
      if (appendMode === 'init-misroute') return mutationValueResult('INIT', current, request);
      return mutationValueResult('APPEND', current, request, appendMode === 'forged');
    },
  };
  return {
    lifecycle: { forProject() { return scoped; } },
    current() { return current; },
    calls,
    setCurrentUnknown(value) { currentUnknown = value; },
    setDiscoverTransform(value) { discoverTransform = value; },
  };
}

function ordinaryFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-journal-ordinary-'));
  const project = projectService.createProjectAt(parent, 'Journal Ordinary');
  fs.writeFileSync(path.join(project.rootPath, 'a.md'), 'before');
  const snapshot = projectService.readFileWithRevision(project.rootPath, 'a.md');
  const changeSet = changeSetService.createChangeSet([
    { path: 'a.md', ...snapshot },
  ], [{ path: 'a.md', after: 'after', summary: 'update a' }]);
  return {
    parent,
    project,
    prepared: {
      ...historyService.prepareApplication(project.rootPath, changeSet),
      projectId: project.projectId,
    },
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}

function snapshotState(text) {
  const bytes = Buffer.from(text, 'utf8');
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    exists: true, revision, contentHash: revision, byteLength: bytes.length,
    encoding: 'base64', data: bytes.toString('base64'),
  };
}

function absentState() {
  return {
    exists: false, revision: null, contentHash: null, byteLength: 0,
    encoding: null, data: null,
  };
}

function snapshotFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-journal-snapshot-'));
  const project = projectService.createProjectAt(parent, 'Journal Snapshot');
  const after = snapshotState('snapshot missing\n');
  const selectedId = 'selected_missing';
  return {
    parent,
    project,
    args: {
      rootPath: project.rootPath,
      projectId: project.projectId,
      files: [{
        path: 'chapters/new.md', summary: 'restore missing', before: absentState(),
        after, createdIdentityDigest: null,
      }],
      provenance: {
        schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
        snapshotId: 'snapshot_journal_prepare',
        snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
        restoreCapabilityId: 'capability_journal_prepare',
        comparisonDigest: `sha256:${'2'.repeat(64)}`,
        selectedIds: [selectedId],
      },
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: [{
          selectedId, action: 'MISSING', path: 'chapters/new.md',
          revision: after.revision,
          ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
        }],
      },
    },
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}

function exactArtifactLifecycle() {
  const remove = request => {
    const held = fs.fstatSync(request.heldFd, { bigint: true });
    const target = path.join(request.directory, request.basename);
    const current = fs.lstatSync(target, { bigint: true });
    assert.strictEqual(current.dev, held.dev);
    assert.strictEqual(current.ino, held.ino);
    fs.unlinkSync(target);
    const directoryFd = fs.openSync(request.directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  };
  return Object.freeze({ cleanup: remove, rollback: remove });
}

function driftValidHistory(rootPath) {
  const current = historyService.loadHistoryState(rootPath);
  if (!current.exists) {
    historyService.saveHistory(rootPath, current.history, { expectedState: current });
    return;
  }
  const historyPath = path.join(rootPath, historyService.HISTORY_RELATIVE_PATH);
  const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  fs.writeFileSync(historyPath, JSON.stringify(raw));
}

function driftSnapshotArtifact(rootPath) {
  const recovery = path.join(rootPath, '.writcraft', 'recovery');
  const basename = fs.readdirSync(recovery)
    .find(name => /^changes-history-chr_[a-f0-9]{48}\.bin$/.test(name));
  assert(basename);
  const fd = fs.openSync(path.join(recovery, basename), fs.constants.O_RDWR);
  try {
    const byte = Buffer.alloc(1);
    assert.strictEqual(fs.readSync(fd, byte, 0, 1, 0), 1);
    byte[0] ^= 0x01;
    assert.strictEqual(fs.writeSync(fd, byte, 0, 1, 0), 1);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function dormantPublicLifecycle(calls, options = {}) {
  const method = name => (...args) => { calls[name] += 1; return args[0]; };
  return Object.freeze({
    create: method('create'),
    createMissingJournal(authority, request, value) {
      calls.createMissingJournal += 1;
      const token = publicNative.buildCreateJournalCommandToken(authority, request, value);
      if (options.unknown === true) {
        return {
          schema: publicNative.SCHEMAS.CREATE_JOURNAL_RESPONSE,
          command: 'CREATE_MISSING', state: 'UNKNOWN', operationId: request.operationId,
          commandDigest: token.commandDigest, publicationResult: null,
          errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
        };
      }
      const identity = (ino, contentSha256, mode) => ({
        schema: evidence.SCHEMAS.OBJECT_IDENTITY,
        dev: '9001', ino: String(ino), uid: process.geteuid(), mode, nlink: 1,
        size: '16', mtimeNs: '1000000000', ctimeNs: '1000000001', contentSha256,
      });
      const items = request.items.map((item, index) => {
        const createdLeafIdentity = identity(100 + (index * 3), item.contentDigest, 0o644);
        const control = publicNative.buildControl(request, index);
        const receipt = publicNative.buildReceipt(
          control,
          evidence.digestObjectIdentity(createdLeafIdentity)
        );
        return {
          selectedId: item.selectedId,
          createdLeafIdentity,
          controlRecordIdentity: identity(
            101 + (index * 3), evidence.sha256(publicNative.encodeControlRecord(control)), 0o600
          ),
          receiptRecordIdentity: identity(
            102 + (index * 3), evidence.sha256(
              publicNative.encodeReceiptRecord(receipt, control)
            ), 0o600
          ),
        };
      });
      return {
        schema: publicNative.SCHEMAS.CREATE_JOURNAL_RESPONSE,
        command: 'CREATE_MISSING', state: 'COMMITTED', operationId: request.operationId,
        commandDigest: token.commandDigest,
        publicationResult: {
          schema: publicNative.SCHEMAS.CREATE_PUBLICATION_RESULT,
          operationId: request.operationId,
          requestDigest: publicNative.createRequestDigest(request),
          items,
        },
        errorCode: null,
      };
    },
    reconcile: method('reconcile'),
    verifyCreate: method('verifyCreate'),
    finalizeCreate: method('finalizeCreate'),
    reconcileFinalize: method('reconcileFinalize'),
    cleanupCreate() { return null; },
    reconcileCreateCleanup() { return null; },
    ackCreateCleanup() { return null; },
  });
}

function historyServiceWithRestoreFault(kind) {
  return Object.freeze({
    ...historyService,
    restoreHistoryState(rootPath, state, options) {
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      const originalRename = fs.renameSync;
      let fired = false;
      try {
        if (kind === 'temp-partial') {
          fs.writeFileSync = (fd, content, encoding) => {
            if (!fired && typeof fd === 'number') {
              fired = true;
              const bytes = Buffer.from(content, encoding || 'utf8');
              fs.writeSync(fd, bytes, 0, Math.max(1, Math.floor(bytes.length / 2)), 0);
              throw new Error('injected partial History temp write');
            }
            return originalWrite(fd, content, encoding);
          };
        } else if (kind === 'file-fsync') {
          fs.fsyncSync = fd => {
            if (!fired && fs.fstatSync(fd).isFile()) {
              fired = true;
              throw new Error('injected History file fsync failure');
            }
            return originalFsync(fd);
          };
        } else if (kind === 'rename-loss') {
          fs.renameSync = (source, target) => {
            const result = originalRename(source, target);
            if (!fired) {
              fired = true;
              throw new Error('injected History rename response loss');
            }
            return result;
          };
        } else if (kind === 'parent-fsync') {
          fs.fsyncSync = fd => {
            const stat = fs.fstatSync(fd);
            if (!fired && stat.isDirectory()) {
              fired = true;
              throw new Error('injected History parent fsync failure');
            }
            return originalFsync(fd);
          };
        }
        return historyService.restoreHistoryState(rootPath, state, options);
      } finally {
        fs.writeFileSync = originalWrite;
        fs.fsyncSync = originalFsync;
        fs.renameSync = originalRename;
      }
    },
  });
}

function prepareSnapshotWith(mode = {}, lifecycleOverride = null, serviceOptions = {}) {
  const item = snapshotFixture();
  const resolvedMode = typeof mode === 'function' ? mode(item) : mode;
  const fake = journalLifecycle(resolvedMode);
  const calls = {
    create: 0, createMissingJournal: 0, reconcile: 0,
    verifyCreate: 0, finalizeCreate: 0, reconcileFinalize: 0,
  };
  const publicLifecycle = typeof lifecycleOverride === 'function'
    ? lifecycleOverride(calls)
    : lifecycleOverride || dormantPublicLifecycle(calls);
  const artifactLifecycle = exactArtifactLifecycle();
  const reconciliation = createChangesHistoryReconciliationService({
    projectService,
    historyService: serviceOptions.historyService || historyService,
    markerJournalLifecycle: fake.lifecycle,
    exactArtifactLifecycle: artifactLifecycle,
    publicMarkdownLifecycle: publicLifecycle,
    beforeHistoryJournalAppend: serviceOptions.beforeHistoryJournalAppend,
  });
  const transaction = createChangesHistoryTransaction({
    projectService,
    historyService: serviceOptions.historyService || historyService,
    publicMarkdownLifecycle: publicLifecycle,
    reconciliationService: reconciliation,
  });
  return { item, fake, calls, reconciliation, transaction };
}

function prepareWith(mode = {}) {
  const item = ordinaryFixture();
  const fake = journalLifecycle(mode);
  const service = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: fake.lifecycle,
  });
  return { item, fake, service };
}

function commitPrepared(item) {
  for (const file of item.prepared.files) {
    projectService.atomicWriteFile(
      item.project.rootPath,
      file.path,
      file.after.content,
      file.before.revision
    );
  }
  historyService.saveHistory(
    item.project.rootPath,
    item.prepared.preparedHistoryState.history,
    { expectedState: item.prepared.baseHistoryState }
  );
}

function nextPrepared(item, after = 'after again') {
  const snapshot = projectService.readFileWithRevision(item.project.rootPath, 'a.md');
  const changeSet = changeSetService.createChangeSet([
    { path: 'a.md', ...snapshot },
  ], [{ path: 'a.md', after, summary: 'update a again' }]);
  return {
    ...historyService.prepareApplication(item.project.rootPath, changeSet),
    projectId: item.project.projectId,
  };
}

test('ordinary prepare initializes IDLE and CAS-publishes one exact ACTIVE marker', () => {
  const { item, fake, service } = prepareWith();
  try {
    const marker = service.prepare(item.project.rootPath, item.prepared);
    assert.strictEqual(fake.current().state, 'ACTIVE');
    assert.strictEqual(fake.current().activeOperationId, marker.operationId);
    assert.deepStrictEqual(service.readMarker(item.project.rootPath), marker);
    assert.deepStrictEqual(fake.calls, { initialize: 1, append: 1, discoverCurrent: 5 });
  } finally { item.cleanup(); }
});

test('ordinary finish persists terminal ACTIVE and clear advances cleanup to permanent IDLE', () => {
  const { item, fake, service } = prepareWith();
  try {
    const preparedMarker = service.prepare(item.project.rootPath, item.prepared);
    commitPrepared(item);
    const terminal = service.finish(item.project.rootPath, preparedMarker.operationId);
    assert.strictEqual(terminal.state, 'terminal');
    assert.strictEqual(terminal.outcome, 'applied');
    assert.strictEqual(fake.current().state, 'ACTIVE');
    assert.strictEqual(fake.current().activeMarker.integrity, terminal.integrity);
    assert.deepStrictEqual(
      service.clear(item.project.rootPath, item.project.projectId, terminal.operationId),
      { ok: true, operationId: terminal.operationId }
    );
    assert.strictEqual(fake.current().state, 'IDLE');
    assert.strictEqual(fake.calls.append, 4);
    assert.strictEqual(service.readMarker(item.project.rootPath), null);
    assert.strictEqual(service.hasPending(item.project.rootPath), false);
    assert.deepStrictEqual(service.query(item.project.rootPath, item.project.projectId), {
      ok: true,
      recovery: null,
    });
  } finally { item.cleanup(); }
});

test('finish APPEND response loss converges on the exact terminal value without replay', () => {
  const { item, fake, service } = prepareWith({ appendAt: { 2: 'high-read' } });
  try {
    const marker = service.prepare(item.project.rootPath, item.prepared);
    commitPrepared(item);
    const terminal = service.finish(item.project.rootPath, marker.operationId);
    assert.strictEqual(terminal.outcome, 'applied');
    assert.strictEqual(fake.calls.append, 2);
    assert.strictEqual(fake.current().activeMarker.integrity, terminal.integrity);
  } finally { item.cleanup(); }
});

for (const appendNumber of [3, 4]) {
  test('cleanup and IDLE APPEND response loss use exact fresh READ without replay', () => {
    const { item, fake, service } = prepareWith({
      appendAt: { [appendNumber]: 'high-read' },
    });
    try {
      const marker = service.prepare(item.project.rootPath, item.prepared);
      commitPrepared(item);
      const terminal = service.finish(item.project.rootPath, marker.operationId);
      service.clear(item.project.rootPath, item.project.projectId, terminal.operationId);
      assert.strictEqual(fake.calls.append, 4);
      assert.strictEqual(fake.current().state, 'IDLE');
    } finally { item.cleanup(); }
  });
}

test('History drift blocks before cleanup APPEND and retains terminal ACTIVE', () => {
  const { item, fake, service } = prepareWith();
  try {
    const marker = service.prepare(item.project.rootPath, item.prepared);
    commitPrepared(item);
    const terminal = service.finish(item.project.rootPath, marker.operationId);
    historyService.restoreHistoryState(item.project.rootPath, item.prepared.baseHistoryState, {
      expectedState: item.prepared.preparedHistoryState,
    });
    assert.throws(
      () => service.clear(item.project.rootPath, item.project.projectId, terminal.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fake.calls.append, 2);
    assert.strictEqual(fake.current().state, 'ACTIVE');
    assert.strictEqual(fake.current().terminalCleanup, null);
  } finally { item.cleanup(); }
});

test('fresh clear retry accepts only the exact terminal ACTIVE to IDLE PAIR', () => {
  const { item, fake, service } = prepareWith();
  try {
    const marker = service.prepare(item.project.rootPath, item.prepared);
    commitPrepared(item);
    const terminal = service.finish(item.project.rootPath, marker.operationId);
    service.clear(item.project.rootPath, item.project.projectId, terminal.operationId);
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      historyService,
      markerJournalLifecycle: fake.lifecycle,
    });
    assert.deepStrictEqual(
      restarted.clear(item.project.rootPath, item.project.projectId, terminal.operationId),
      { ok: true, operationId: terminal.operationId }
    );
    assert.strictEqual(fake.calls.append, 4);
    assert.throws(
      () => restarted.clear(
        item.project.rootPath,
        item.project.projectId,
        `chr_${'f'.repeat(48)}`
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    fake.setDiscoverTransform(raw => ({ ...raw, requestDigest: placeholderDigest }));
    assert.throws(
      () => restarted.clear(item.project.rootPath, item.project.projectId, terminal.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
  } finally { item.cleanup(); }
});

test('a new ACTIVE operation supersedes old clear retry as documented availability failure', () => {
  const { item, fake, service } = prepareWith();
  try {
    const marker = service.prepare(item.project.rootPath, item.prepared);
    commitPrepared(item);
    const terminal = service.finish(item.project.rootPath, marker.operationId);
    service.clear(item.project.rootPath, item.project.projectId, terminal.operationId);
    const second = service.prepare(item.project.rootPath, nextPrepared(item));
    assert.notStrictEqual(second.operationId, terminal.operationId);
    assert.throws(
      () => service.clear(item.project.rootPath, item.project.projectId, terminal.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(fake.current().activeOperationId, second.operationId);
  } finally { item.cleanup(); }
});

for (const adapter of ['none', 'legacy']) {
  test(`ordinary ${adapter} marker clear retains legacy compatibility`, () => {
    const item = ordinaryFixture();
    let legacyMutations = 0;
    const legacyMarker = path.join(
      item.project.rootPath,
      '.writcraft/recovery/changes-history-transaction.json'
    );
    const markerJournalLifecycle = adapter === 'none' ? null : {
      forProject() {
        return {
          discover() { return emptyDiscover(fs.existsSync(legacyMarker) ? 'LEGACY' : 'ABSENT'); },
          discoverCurrent() {
            return emptyDiscover(fs.existsSync(legacyMarker) ? 'LEGACY' : 'ABSENT');
          },
          initialize() { legacyMutations += 1; },
          append() { legacyMutations += 1; },
        };
      },
    };
    const service = createChangesHistoryReconciliationService({
      projectService,
      historyService,
      ...(markerJournalLifecycle === null ? {} : { markerJournalLifecycle }),
    });
    try {
      const prepareService = adapter === 'legacy'
        ? createChangesHistoryReconciliationService({ projectService, historyService })
        : service;
      const marker = prepareService.prepare(item.project.rootPath, item.prepared);
      commitPrepared(item);
      const terminal = service.finish(item.project.rootPath, marker.operationId);
      service.clear(item.project.rootPath, item.project.projectId, terminal.operationId);
      assert.strictEqual(service.readMarker(item.project.rootPath), null);
      assert.strictEqual(legacyMutations, 0);
    } finally { item.cleanup(); }
  });
}

for (const [name, mode] of [
  ['INIT response loss', { init: 'loss' }],
  ['APPEND response loss', { append: 'loss' }],
  ['high lifecycle fresh READ', { append: 'high-read' }],
]) {
  test(`${name} reconciles without replaying INIT or APPEND`, () => {
    const { item, fake, service } = prepareWith(mode);
    try {
      const marker = service.prepare(item.project.rootPath, item.prepared);
      assert.strictEqual(fake.current().activeOperationId, marker.operationId);
      assert.strictEqual(fake.calls.initialize, 1);
      assert.strictEqual(fake.calls.append, 1);
    } finally { item.cleanup(); }
  });
}

for (const mode of [
  { init: 'read-misroute' },
  { init: 'forged' },
  { append: 'init-misroute' },
  { append: 'forged' },
]) {
  test('misrouted or forged mutation result is never accepted as authority', () => {
    const { item, service } = prepareWith(mode);
    try {
      assert.throws(
        () => service.prepare(item.project.rootPath, item.prepared),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
    } finally { item.cleanup(); }
  });
}

for (const [name, mode] of [
  ['direct', {}],
  ['INIT response loss', { init: 'loss' }],
  ['marker APPEND response loss', { appendAt: { 1: 'loss' } }],
  ['PREPARED APPEND response loss', { appendAt: { 2: 'loss' } }],
]) {
  test(`snapshot PRECREATE ${name} reaches exact ACTIVE PREPARED without CREATE`, () => {
    const { item, fake, calls, transaction } = prepareSnapshotWith(mode);
    try {
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const marker = transaction.preparePublicMarkdownMarker(prepared);
      const current = fake.current();
      assert.strictEqual(current.state, 'ACTIVE');
      assert.strictEqual(current.activeOperationId, marker.operationId);
      assert.deepStrictEqual(current.activeMarker, marker);
      assert.strictEqual(current.activeMarkerDigest, journal.activeMarkerDigest(marker));
      assert.strictEqual(current.nativePublication.command, 'CREATE_MISSING');
      assert.strictEqual(current.nativePublication.state, 'PREPARED');
      assert.strictEqual(current.nativePublication.createCapture, null);
      assert.strictEqual(fake.calls.initialize, 1);
      assert.strictEqual(fake.calls.append, 2);
      assert.deepStrictEqual(calls, {
        create: 0, createMissingJournal: 0, reconcile: 0,
        verifyCreate: 0, finalizeCreate: 0, reconcileFinalize: 0,
      });
      const artifactPath = path.join(
        item.project.rootPath, '.writcraft', 'recovery', marker.artifact.basename
      );
      assert.strictEqual(fs.existsSync(artifactPath), true);
      assert.strictEqual(fs.statSync(artifactPath).size, marker.artifact.byteLength);
      assert.strictEqual(
        `sha256:${crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')}`,
        marker.artifact.sha256
      );
    } finally { item.cleanup(); }
  });
}

test('snapshot first APPEND proven UNCOMMITTED rolls back only its artifact', () => {
  const { item, fake, transaction } = prepareSnapshotWith({
    appendAt: { 1: 'uncommitted-loss' },
  });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    assert.throws(() => transaction.preparePublicMarkdownMarker(prepared), error =>
      error?.code === 'CHANGES_RECOVERY_WRITE_FAILED');
    assert.strictEqual(fake.current().state, 'IDLE');
    const recovery = path.join(item.project.rootPath, '.writcraft', 'recovery');
    assert.strictEqual(fs.readdirSync(recovery)
      .some(name => name.startsWith('changes-history-chr_')), false);
  } finally { item.cleanup(); }
});

test('snapshot unknown journal truth retains artifact and requires manual recovery', () => {
  const { item, transaction } = prepareSnapshotWith({ appendAt: { 1: 'unknown' } });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    assert.throws(() => transaction.preparePublicMarkdownMarker(prepared), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    const recovery = path.join(item.project.rootPath, '.writcraft', 'recovery');
    assert.strictEqual(fs.readdirSync(recovery)
      .some(name => name.startsWith('changes-history-chr_')), true);
  } finally { item.cleanup(); }
});

test('snapshot CREATE captures once before durable CREATED_RECEIPT marker', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith();
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(created.preparedHistoryState.exists, true);
    assert.strictEqual(fake.current().nativePublication.state, 'COMMITTED');
    assert.deepStrictEqual(fake.current().activeMarker, created);
    assert.strictEqual(fake.calls.append, 6);
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(calls.create, 0);
    assert.strictEqual(calls.reconcile, 0);
    assert.strictEqual(calls.verifyCreate, 0);
  } finally { item.cleanup(); }
});

test('snapshot CREATED_RECEIPT commits exact History and one journal HISTORY_COMMITTED marker', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith();
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(fake.calls.append, 7);
    assert.strictEqual(fake.current().nativePublication.state, 'COMMITTED');
    assert.deepStrictEqual(fake.current().activeMarker, committed);
    const historyPath = path.join(
      item.project.rootPath,
      historyService.HISTORY_RELATIVE_PATH
    );
    const historyBytes = fs.readFileSync(historyPath);
    assert.strictEqual(
      crypto.createHash('sha256').update(Buffer.from([1])).update(historyBytes).digest('hex'),
      committed.preparedHistoryState.digest
    );
    assert.doesNotThrow(() => historyService.validateHistory(JSON.parse(historyBytes)));
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(calls.finalizeCreate, 0);
    assert.strictEqual(calls.reconcileFinalize, 0);
  } finally { item.cleanup(); }
});

test('snapshot HISTORY_COMMITTED APPEND response loss converges by fresh exact READ', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({ appendAt: { 7: 'loss' } });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(fake.calls.append, 7);
    assert.strictEqual(calls.createMissingJournal, 1);
  } finally { item.cleanup(); }
});

test('snapshot prepared History restart advances journal without replaying CREATE or History body', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({
    appendAt: { 7: 'uncommitted-loss' },
  });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.current().activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    const historyBefore = fs.readFileSync(path.join(
      item.project.rootPath, historyService.HISTORY_RELATIVE_PATH
    ));
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.deepStrictEqual(fs.readFileSync(path.join(
      item.project.rootPath, historyService.HISTORY_RELATIVE_PATH
    )), historyBefore);
    assert.strictEqual(fake.calls.append, 8);
    assert.strictEqual(calls.createMissingJournal, 1);
  } finally { item.cleanup(); }
});

for (const kind of ['temp-partial', 'file-fsync']) {
  test(`snapshot History ${kind} failure remains CREATED_RECEIPT with zero journal advance`, () => {
    const faultHistory = historyServiceWithRestoreFault(kind);
    const { item, fake, calls, transaction } = prepareSnapshotWith(
      {},
      null,
      { historyService: faultHistory }
    );
    try {
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      const created = transaction.createMissingLeaves(prepared, precreate);
      assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created));
      assert.strictEqual(fake.calls.append, 6);
      assert.strictEqual(fake.current().activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.strictEqual(calls.createMissingJournal, 1);
    } finally { item.cleanup(); }
  });
}

for (const kind of ['rename-loss', 'parent-fsync']) {
  test(`snapshot History ${kind} response loss is durably reconciled before journal advance`, () => {
    const faultHistory = historyServiceWithRestoreFault(kind);
    const { item, fake, calls, transaction } = prepareSnapshotWith(
      {},
      null,
      { historyService: faultHistory }
    );
    try {
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      const created = transaction.createMissingLeaves(prepared, precreate);
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.strictEqual(fake.calls.append, 7);
      assert.strictEqual(calls.createMissingJournal, 1);
    } finally { item.cleanup(); }
  });
}

test('snapshot foreign History remains manual and does not advance CREATED_RECEIPT', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith();
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    driftValidHistory(item.project.rootPath);
    assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.calls.append, 6);
    assert.strictEqual(fake.current().activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(calls.createMissingJournal, 1);
  } finally { item.cleanup(); }
});

test('snapshot artifact drift after durable History blocks the journal CAS and preserves evidence', () => {
  let drifted = false;
  const { item, fake, calls, transaction } = prepareSnapshotWith(
    {},
    null,
    {
      beforeHistoryJournalAppend({ rootPath }) {
        drifted = true;
        driftSnapshotArtifact(rootPath);
      },
    }
  );
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(drifted, true);
    assert.strictEqual(fake.calls.append, 6);
    assert.strictEqual(fake.current().activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath, historyService.HISTORY_RELATIVE_PATH
    )), true);
  } finally { item.cleanup(); }
});

test('snapshot project replacement after HISTORY_COMMITTED APPEND remains manual with evidence', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith(snapshot => ({
    afterAppend({ call }) {
      if (call !== 7) return undefined;
      const projectFile = path.join(
        snapshot.project.rootPath,
        projectService.META_FILE
      );
      const metadata = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      metadata.projectId = 'foreign-project-after-history-append';
      fs.writeFileSync(projectFile, `${JSON.stringify(metadata, null, 2)}\n`);
      return undefined;
    },
  }));
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created), error =>
      ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED'].includes(error?.code));
    assert.strictEqual(fake.calls.append, 7);
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath, historyService.HISTORY_RELATIVE_PATH
    )), true);
    assert.strictEqual(fs.readdirSync(path.join(
      item.project.rootPath, '.writcraft', 'recovery'
    )).some(name => name.startsWith('changes-history-chr_')), true);
  } finally { item.cleanup(); }
});

test('snapshot current-head replacement after HISTORY_COMMITTED APPEND remains manual', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({
    afterAppend({ call, previous }) {
      return call === 7 ? previous : undefined;
    },
  });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.calls.append, 7);
    assert.strictEqual(fake.current().activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath, historyService.HISTORY_RELATIVE_PATH
    )), true);
    assert.strictEqual(fs.readdirSync(path.join(
      item.project.rootPath, '.writcraft', 'recovery'
    )).some(name => name.startsWith('changes-history-chr_')), true);
  } finally { item.cleanup(); }
});

test('snapshot CREATE UNKNOWN retains PREPARED journal and never calls legacy reconcile', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith(
    {},
    values => dormantPublicLifecycle(values, { unknown: true })
  );
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.current().nativePublication.state, 'PREPARED');
    assert.notStrictEqual(fake.current().nativePublication.createAttemptDigest, null);
    assert.strictEqual(fake.calls.append, 3);
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(calls.reconcile, 0);
    assert.strictEqual(calls.create, 0);
    assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(calls.createMissingJournal, 1);
  } finally { item.cleanup(); }
});

test('snapshot CREATE latch APPEND response loss converges before one native attempt', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({ appendAt: { 3: 'loss' } });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(fake.calls.append, 6);
    assert.strictEqual(calls.createMissingJournal, 1);
  } finally { item.cleanup(); }
});

test('snapshot CREATE crash after durable latch remains manual without native replay', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({
    appendAt: { 3: 'unknown-after-commit' },
  });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.notStrictEqual(fake.current().nativePublication.createAttemptDigest, null);
    assert.strictEqual(calls.createMissingJournal, 0);
    fake.setCurrentUnknown(false);
    assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(calls.createMissingJournal, 0);
  } finally { item.cleanup(); }
});

test('snapshot CREATE rejects a self-consistent foreign latch before native', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith(snapshot => ({
    afterAppend({ call, current }) {
      if (call !== 3) return undefined;
      const publication = {
        ...current.nativePublication,
        createAttemptDigest: `sha256:${'8'.repeat(64)}`,
        publicationDigest: null,
      };
      publication.publicationDigest = journal.publicationDigest(publication);
      const foreign = { ...current, nativePublication: publication, valueDigest: null };
      foreign.valueDigest = journal.valueDigest(foreign);
      return journal.assertJournalValue(foreign);
    },
  }));
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.calls.append, 3);
    assert.strictEqual(calls.createMissingJournal, 0);
  } finally { item.cleanup(); }
});

for (const [label, drift] of [
  ['History', rootPath => driftValidHistory(rootPath)],
  ['artifact', rootPath => driftSnapshotArtifact(rootPath)],
]) {
  test(`snapshot CREATE ${label} drift after latch blocks native`, () => {
    const { item, fake, calls, transaction } = prepareSnapshotWith(snapshot => ({
      afterAppend({ call }) {
        if (call === 3) drift(snapshot.project.rootPath);
      },
    }));
    try {
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fake.calls.append, 3);
      assert.notStrictEqual(fake.current().nativePublication.createAttemptDigest, null);
      assert.strictEqual(calls.createMissingJournal, 0);
      assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(calls.createMissingJournal, 0);
    } finally { item.cleanup(); }
  });
}

test('snapshot PREPARED read reconciliation never invokes CREATE', () => {
  const { item, fake, calls, reconciliation, transaction } = prepareSnapshotWith();
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    transaction.preparePublicMarkdownMarker(prepared);
    assert.throws(() => reconciliation.query(item.project.rootPath, item.project.projectId), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fake.current().nativePublication.state, 'PREPARED');
    assert.strictEqual(calls.createMissingJournal, 0);
    assert.strictEqual(calls.create, 0);
    assert.strictEqual(calls.reconcile, 0);
  } finally { item.cleanup(); }
});

for (const [appendCall, durableState] of [[4, 'ARMED'], [5, 'COMMITTED']]) {
  test(`snapshot CREATE restart converges durable ${durableState} without replay`, () => {
    const { item, fake, calls, transaction } = prepareSnapshotWith({
      appendAt: { [appendCall]: 'unknown-after-commit' },
    });
    try {
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fake.current().nativePublication.state, durableState);
      assert.strictEqual(calls.createMissingJournal, 1);
      fake.setCurrentUnknown(false);
      const created = transaction.createMissingLeaves(prepared, precreate);
      assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.strictEqual(fake.current().nativePublication.state, 'COMMITTED');
      assert.deepStrictEqual(fake.current().activeMarker, created);
      assert.strictEqual(calls.createMissingJournal, 1);
      assert.strictEqual(calls.create, 0);
      assert.strictEqual(calls.reconcile, 0);
    } finally { item.cleanup(); }
  });
}

test('snapshot CREATED_RECEIPT APPEND response loss converges without replay', () => {
  const { item, fake, calls, transaction } = prepareSnapshotWith({ appendAt: { 6: 'loss' } });
  try {
    const prepared = transaction.prepareSnapshotRestore(item.args);
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(fake.calls.append, 6);
    assert.strictEqual(calls.createMissingJournal, 1);
    assert.strictEqual(calls.create, 0);
    assert.strictEqual(calls.reconcile, 0);
  } finally { item.cleanup(); }
});

for (const [appendCall, durableState] of [[4, 'ARMED'], [5, 'COMMITTED']]) {
  test(`snapshot History drift after ${durableState} publication blocks the next transition`, () => {
    const { item, fake, calls, transaction } = prepareSnapshotWith(snapshot => ({
      afterAppend({ call }) {
        if (call === appendCall) driftValidHistory(snapshot.project.rootPath);
      },
    }));
    try {
      const base = historyService.loadHistoryState(item.project.rootPath);
      historyService.saveHistory(item.project.rootPath, base.history, { expectedState: base });
      const prepared = transaction.prepareSnapshotRestore(item.args);
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      assert.throws(() => transaction.createMissingLeaves(prepared, precreate), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fake.current().nativePublication.state, durableState);
      assert.strictEqual(fake.calls.append, appendCall);
      assert.strictEqual(calls.createMissingJournal, 1);
      assert.strictEqual(calls.create, 0);
      assert.strictEqual(calls.reconcile, 0);
    } finally { item.cleanup(); }
  });
}

for (const appendCall of [1, 2]) {
  test(`snapshot History drift after APPEND ${appendCall} never reaches CREATE or success`, () => {
    const { item, fake, calls, transaction } = prepareSnapshotWith(snapshot => ({
      afterAppend({ call }) {
        if (call === appendCall) driftValidHistory(snapshot.project.rootPath);
      },
    }));
    try {
      if (appendCall === 2) {
        const base = historyService.loadHistoryState(item.project.rootPath);
        historyService.saveHistory(item.project.rootPath, base.history, { expectedState: base });
      }
      const prepared = transaction.prepareSnapshotRestore(item.args);
      assert.throws(() => transaction.preparePublicMarkdownMarker(prepared), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fake.calls.append, appendCall);
      assert.strictEqual(fake.current().state, 'ACTIVE');
      assert.strictEqual(fake.current().nativePublication === null, appendCall === 1);
      assert.strictEqual(fs.readdirSync(path.join(
        item.project.rootPath, '.writcraft', 'recovery'
      )).some(name => name.startsWith('changes-history-chr_')), true);
      assert.deepStrictEqual(calls, {
        create: 0, createMissingJournal: 0, reconcile: 0,
        verifyCreate: 0, finalizeCreate: 0, reconcileFinalize: 0,
      });
    } finally { item.cleanup(); }
  });
}

test('snapshot createMissingJournal accessor fails before artifact with getter zero', () => {
  let getterCalls = 0;
  const calls = {
    create: 0, createMissingJournal: 0, reconcile: 0,
    verifyCreate: 0, finalizeCreate: 0, reconcileFinalize: 0,
  };
  const hostile = { ...dormantPublicLifecycle(calls) };
  Object.defineProperty(hostile, 'createMissingJournal', {
    enumerable: true,
    get() { getterCalls += 1; return () => null; },
  });
  Object.freeze(hostile);
  const { item, transaction } = prepareSnapshotWith({}, hostile);
  try {
    assert.throws(() => transaction.prepareSnapshotRestore(item.args), error =>
      error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
    assert.strictEqual(getterCalls, 0);
    const recovery = path.join(item.project.rootPath, '.writcraft', 'recovery');
    assert.strictEqual(fs.existsSync(recovery) && fs.readdirSync(recovery)
      .some(name => name.startsWith('changes-history-chr_')), false);
  } finally { item.cleanup(); }
});

test('Safe Undo non-legacy journal remains gated before artifact lifecycle mutation', () => {
  const item = ordinaryFixture();
  let artifactCalls = 0;
  const fake = journalLifecycle();
  const service = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: fake.lifecycle,
    exactArtifactLifecycle: {
      cleanup() { artifactCalls += 1; },
      rollback() { artifactCalls += 1; },
    },
  });
  try {
    assert.throws(
      () => service.prepare(item.project.rootPath, {
        projectId: item.project.projectId,
        kind: 'snapshot_restore_undo',
      }),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(artifactCalls, 0);
    assert.strictEqual(fake.calls.initialize, 0);
    assert.strictEqual(fake.calls.append, 0);
  } finally { item.cleanup(); }
});

test('write method accessors fail without invoking getters', () => {
  const item = ordinaryFixture();
  let getterCalls = 0;
  const scoped = {
    discover() { return emptyDiscover('ABSENT'); },
    discoverCurrent() { return emptyDiscover('ABSENT'); },
    initialize() { throw new Error('must not call'); },
  };
  Object.defineProperty(scoped, 'append', {
    enumerable: true,
    get() { getterCalls += 1; return () => null; },
  });
  const service = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: { forProject() { return scoped; } },
  });
  try {
    assert.throws(
      () => service.prepare(item.project.rootPath, item.prepared),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(getterCalls, 0);
  } finally { item.cleanup(); }
});

console.log(`Changes/History ordinary journal write verification: ${passed}/${passed} passed`);
