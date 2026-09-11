#!/usr/bin/env node
'use strict';

// Production-boundary mixed EXISTING+MISSING snapshot restore journey.
// Drives the REAL Main transaction + REAL native WRCCHRJ2 journal + REAL
// native public-Markdown/existing-restore helpers (no fake adapters):
//   prepare (PRECREATE) -> commitExistingRestore (native E + journal terminal
//   CAS persisting existingTerminalPublication) -> createMissingLeaves ->
//   commitMissingRestoreHistory -> finalizeMissingRestore -> finish/clear.
// Faults cross the real boundary: a lost E response is rebuilt with a fresh
// native R (response-loss coordination), and journal drift before the terminal
// CAS fails closed without any MISSING write.

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const changeHistoryService = require('../src/main/change-history-service');
const changeSetService = require('../src/main/changeset-service');
const changeSetReviewService = require('../src/main/changeset-review-service');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');
const journalNative = require('../src/main/changes-history-marker-journal-native-lifecycle');
const publicNative = require('../src/main/public-markdown-native-lifecycle');
const artifactLifecycleService = require('../src/main/changes-history-artifact-lifecycle');
const markerLifecycleService = require('../src/main/changes-history-marker-lifecycle');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const existingSchema = require('../src/main/snapshot-existing-restore-native-schema');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-mixed-journey-'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.stack || error.message}`);
    if (error.cause) console.error(`    cause: ${error.cause.stack || error.cause.message}`);
    process.exitCode = 1;
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compileHelper(sourceName, outputName, definitions = []) {
  const output = path.join(scratch, outputName);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-Wframe-larger-than=2097152', '-mmacosx-version-min=11.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`),
    path.join(__dirname, '..', 'native', sourceName), '-o', output,
  ]);
  return output;
}

function contentState(bytes) {
  return Object.freeze({
    exists: true,
    revision: sha256(bytes).slice('sha256:'.length),
    contentHash: sha256(bytes).slice('sha256:'.length),
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  });
}

function absentState() {
  return Object.freeze({
    exists: false,
    revision: null,
    contentHash: null,
    byteLength: 0,
    encoding: null,
    data: null,
  });
}

function writeProjectFile(rootPath, relativePath, bytes) {
  const absolutePath = path.join(rootPath, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(absolutePath, 0o600);
}

function journalPath(rootPath) {
  return path.join(rootPath, '.writcraft', 'recovery', journal.JOURNAL_BASENAME);
}

// Mirrors the production main.js composition: REAL native public-Markdown,
// EXISTING-restore (public-markdown-create-helper) and WRCCHRJ2 journal
// (changes-history-artifact-helper) lifecycles over compiled helpers.
function mixedFixture(options = {}) {
  const helperPath = options.helperPath;
  const artifactHelperPath = options.artifactHelperPath;
  const parent = fs.mkdtempSync(path.join(scratch, 'mixed-project-'));
  const project = projectService.createProjectAt(parent, 'Mixed Journey');
  const rootPath = project.rootPath;

  const beforeBytes = Buffer.from('existing original\n', 'utf8');
  const afterBytes = Buffer.from('existing restored\n', 'utf8');
  const createdBytes = Buffer.from('created missing\n', 'utf8');
  writeProjectFile(rootPath, 'existing.md', beforeBytes);
  assert.strictEqual(fs.existsSync(path.join(rootPath, 'new.md')), false);
  const recoveryPath = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(rootPath, '.writcraft'), 0o700);
  fs.chmodSync(recoveryPath, 0o700);

  const artifactLifecycle = (() => {
    const base = artifactLifecycleService
      .createChangesHistoryArtifactLifecycle({ helperPath: artifactHelperPath });
    return typeof options.wrapArtifactLifecycle === 'function'
      ? options.wrapArtifactLifecycle(base, rootPath)
      : base;
  })();
  const markerLifecycle = markerLifecycleService
    .createChangesHistoryMarkerLifecycle({ helperPath: artifactHelperPath });
  const publicMarkdown = publicNative.createPublicMarkdownNativeLifecycle({
    helperPath,
    ...(typeof options.publicMarkdownSpawnSync === 'function'
      ? { spawnSync: options.publicMarkdownSpawnSync }
      : {}),
  });
  const markerJournal = journalNative.createChangesHistoryMarkerJournalNativeLifecycle({
    helperPath: artifactHelperPath,
    ...(typeof options.journalSpawnSync === 'function'
      ? { spawnSync: options.journalSpawnSync }
      : {}),
  });
  const publicMarkdownLifecycle = Object.freeze({
    schema: 'writcraft.snapshot-restore-public-markdown-lifecycle/v1',
    forProject(candidateRoot) {
      const scoped = publicMarkdown.forProject(candidateRoot);
      const frozen = Object.freeze({
        create: scoped.create,
        createMissingJournal: scoped.createMissingJournal,
        reconcile: scoped.reconcile,
        verifyCreate: scoped.verifyCreate,
        finalizeCreate: scoped.finalizeCreate,
        reconcileFinalize: scoped.reconcileFinalize,
        cleanupCreate: scoped.cleanupCreate,
        reconcileCreateCleanup: scoped.reconcileCreateCleanup,
        ackCreateCleanup: scoped.ackCreateCleanup,
        quarantineCreateRollback: scoped.quarantineCreateRollback,
        reconcileCreateRollback: scoped.reconcileCreateRollback,
        deleteCreateRollback: scoped.deleteCreateRollback,
        ackCreateRollback: scoped.ackCreateRollback,
      });
      return typeof options.wrapScopedPublicMarkdown === 'function'
        ? options.wrapScopedPublicMarkdown(frozen, candidateRoot)
        : frozen;
    },
  });
  const existingRestoreLifecycle = Object.freeze({
    schema: 'writcraft.snapshot-restore-existing-restore-lifecycle/v1',
    forProject(candidateRoot) {
      const scoped = publicMarkdown.forProject(candidateRoot).existingRestore;
      return typeof options.wrapExistingRestore === 'function'
        ? options.wrapExistingRestore(scoped, candidateRoot)
        : scoped;
    },
  });
  const transaction = createChangesHistoryTransaction({
    projectService,
    historyService: changeHistoryService,
    reviewService: changeSetReviewService,
    exactArtifactLifecycle: artifactLifecycle,
    exactMarkerLifecycle: markerLifecycle,
    publicMarkdownLifecycle,
    existingRestoreLifecycle,
    markerJournalLifecycle: markerJournal,
  });
  const projectId = projectService.openProject(rootPath).projectId;

  const existingState = contentState(afterBytes);
  const createdState = contentState(createdBytes);
  const selectedIds = Object.freeze(['existing_0', 'missing_0']);
  const ancestorIdentityDigest = evidence.digestAncestorIdentity({
    schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
    components: [],
  });
  const parentSelectionBinding = phaseSchema.assertParentSelectionBinding({
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [{
      selectedId: 'existing_0', action: 'EXISTING', path: 'existing.md',
      revision: existingState.revision,
      ancestorIdentityDigest,
    }, {
      selectedId: 'missing_0', action: 'MISSING', path: 'new.md',
      revision: createdState.revision,
      ancestorIdentityDigest,
    }],
  });
  const provenance = Object.freeze({
    schema: changeHistoryService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    snapshotId: 'snapshot_mixed_journey',
    snapshotManifestDigest: `sha256:${'3'.repeat(64)}`,
    restoreCapabilityId: 'capability_mixed_journey',
    comparisonDigest: `sha256:${'4'.repeat(64)}`,
    selectedIds,
  });
  const files = Object.freeze([{
    path: 'existing.md',
    summary: 'Restore selected Markdown from Snapshot',
    before: contentState(beforeBytes),
    after: existingState,
    createdIdentityDigest: null,
    ancestorIdentityDigest,
  }, {
    path: 'new.md',
    summary: 'Restore selected Markdown from Snapshot',
    before: absentState(),
    after: createdState,
    createdIdentityDigest: null,
    ancestorIdentityDigest,
  }]);
  const prepared = transaction.prepareSnapshotRestore({
    rootPath,
    projectId,
    files,
    provenance,
    parentSelectionBinding,
  });
  return Object.freeze({
    rootPath,
    projectId,
    transaction,
    prepared,
    args: Object.freeze({ rootPath, projectId, files, provenance, parentSelectionBinding }),
    artifactHelperPath,
    beforeBytes,
    afterBytes,
    createdBytes,
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  });
}

function journalValue(item) {
  const scoped = journalNative.createChangesHistoryMarkerJournalNativeLifecycle({
    helperPath: item.artifactHelperPath,
  }).forProject(item.rootPath);
  return scoped.discoverCurrent().value;
}

// Fault injection at the real native WRCCHJN2 APPEND boundary. The APPEND wire
// request carries the canonical next journal value (request line, frame header,
// then the JSON payload), so a test can fail exactly the CAS it names instead of
// matching a brittle append ordinal. A failed invocation is what "the CAS was
// not durable" looks like to production: `appendSnapshotPreparedJournal` then
// reconciles the on-disk head and reports UNCOMMITTED.
const JOURNAL_APPEND_MARKER = 'WRCCHJN2\tAPPEND';

function appendFailureInjector(predicate) {
  const state = { active: true, failures: 0, attempts: 0 };
  function spawnSync(command, args, options) {
    const lines = String(options?.input || '').split('\n');
    if (state.active && (lines[1] || '').startsWith(JOURNAL_APPEND_MARKER)) {
      let value = null;
      try { value = JSON.parse(lines[3]); } catch (_) { value = null; }
      if (value !== null && predicate(value, state)) {
        state.attempts += 1;
        state.failures += 1;
        return {
          status: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          signal: null,
          error: null,
        };
      }
    }
    return childProcess.spawnSync(command, args, options);
  }
  return Object.freeze({ state, spawnSync });
}

// Counts and faults the native ROLLBACK_CREATE Q/D/A calls and the EXISTING E
// call so each restart test can prove which native command was (or was never)
// replayed.
function rollbackFaults() {
  const faults = {
    q: 0,
    d: 0,
    a: 0,
    e: 0,
    failQuarantine: false,
    failDelete: false,
    failAck: false,
    injected() {
      const error = new Error('injected native fault');
      error.code = 'WRITECRAFT_TEST_INJECTED';
      return error;
    },
    wrapScopedPublicMarkdown(scoped) {
      return Object.freeze({
        ...scoped,
        quarantineCreateRollback(...args) {
          faults.q += 1;
          if (faults.failQuarantine) throw faults.injected();
          return scoped.quarantineCreateRollback(...args);
        },
        deleteCreateRollback(...args) {
          faults.d += 1;
          if (faults.failDelete) throw faults.injected();
          return scoped.deleteCreateRollback(...args);
        },
        ackCreateRollback(...args) {
          faults.a += 1;
          if (faults.failAck) throw faults.injected();
          return scoped.ackCreateRollback(...args);
        },
      });
    },
    wrapExistingRestore(scoped) {
      return Object.freeze({
        ...scoped,
        execute(...args) {
          faults.e += 1;
          return scoped.execute(...args);
        },
      });
    },
  };
  return faults;
}

function driveToCreatedReceipt(item) {
  let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
  marker = item.transaction.createMissingLeaves(item.prepared, marker);
  assert.strictEqual(marker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
  return marker;
}

// The rollback faults thrown out of commitExistingRestore are wrapped by the
// EXISTING authority boundary, so the injected identity is carried as `cause`.
function wasInjected(error) {
  return error?.code === 'WRITECRAFT_TEST_INJECTED' ||
    error?.cause?.code === 'WRITECRAFT_TEST_INJECTED';
}

function faultCounts(faults) {
  return Object.freeze({ q: faults.q, d: faults.d, a: faults.a, e: faults.e });
}

function restartRollback(item, marker, method = 'reconcileExistingRestore') {
  return item.transaction.reconciliation[method](
    item.rootPath,
    item.projectId,
    marker.operationId
  );
}

function runMixedJourney(item, options = {}) {
  let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
  assert.strictEqual(marker.publicMarkdownPhase.phase, 'PRECREATE');
  // The MISSING CREATE advances the marker to CREATED_RECEIPT; the EXISTING
  // E/R then CAS-installs its terminal publication at that phase.
  marker = item.transaction.createMissingLeaves(item.prepared, marker);
  assert.strictEqual(marker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
  let reconciled = false;
  try {
    marker = item.transaction.commitExistingRestore(item.prepared, marker);
  } catch (error) {
    if (options.expectLostResponse !== true) throw error;
    marker = item.transaction.reconcileExistingRestore(item.prepared, marker);
    reconciled = true;
  }
  assert.strictEqual(marker.publicMarkdownPhase.phase, 'EXISTING_COMMITTED');
  const installed = journalValue(item);
  assert(installed.existingTerminalPublication);
  assert.strictEqual(
    installed.existingTerminalPublication.schema,
    journal.SCHEMAS.EXISTING_TERMINAL_PUBLICATION
  );
  assert.strictEqual(installed.existingTerminalPublication.state, 'COMMITTED');
  // The full mixed exit (EXISTING terminal finalization -> HISTORY_COMMITTED ->
  // FINALIZED) runs through finalizeMissingRestore; see runMixedJourneyFullExit.
  return { marker, reconciled };
}

// Full mixed exit: after the EXISTING terminal is CAS-installed, History is
// committed, then the finalize seals the EXISTING terminal (native F), the
// publication transitions to FINALIZED, the marker reaches FINALIZED, and the
// transaction terminates with a terminal marker and cleared recovery state.
function runMixedJourneyFullExit(item) {
  const { marker: committedMarker } = runMixedJourney(item);
  let marker = item.transaction.commitMissingRestoreHistory(
    item.prepared,
    committedMarker
  );
  assert.strictEqual(marker.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
  const finalized = item.transaction.finalizeMissingRestore(item.prepared, marker);
  assert.strictEqual(finalized.publicMarkdownPhase.phase, 'FINALIZED');
  // Capture the journal truth before clear returns it to IDLE.
  const preClearValue = journalValue(item);
  const existingPrivateBasenames = preClearValue.existingTerminalPublication.items.flatMap(
    entry => [entry.controlBasename, entry.applyBasename]
  ).concat([preClearValue.existingTerminalPublication.finalization.finalBasename]);
  const existingPrivateBytes = new Map(existingPrivateBasenames.map(basename => [
    basename,
    fs.readFileSync(path.join(item.rootPath, '.writcraft', 'recovery', basename)),
  ]));
  const terminal = item.transaction.reconciliation.finish(item.rootPath, marker.operationId);
  assert.strictEqual(terminal.state, 'terminal');
  assert.strictEqual(terminal.outcome, 'applied');
  item.transaction.reconciliation.clear(item.rootPath, item.projectId, marker.operationId);
  return { marker: finalized, terminal, preClearValue, existingPrivateBytes };
}

try {
  const helperPath = compileHelper('public-markdown-create-helper.c', 'public-markdown-create-helper');
  const artifactHelperPath = compileHelper(
    'changes-history-artifact-helper.c',
    'changes-history-artifact-helper'
  );
  const rollbackHelperPath = compileHelper(
    'public-markdown-create-helper.c',
    'public-markdown-create-helper-rollback',
    ['WRITCRAFT_TEST_EXISTING_APPLY_PARTIAL_WRITE']
  );

  test('mixed journey CAS-installs existingTerminalPublication after EXISTING E and MISSING CREATE', () => {
    const item = mixedFixture({ helperPath, artifactHelperPath });
    try {
      assert.strictEqual(item.prepared.mixedRestoreMode, true);
      const { reconciled } = runMixedJourney(item);
      assert.strictEqual(reconciled, false);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.afterBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'new.md')), item.createdBytes);
      const value = journalValue(item);
      assert.strictEqual(value.existingTerminalPublication.command, 'EXECUTE_EXISTING');
      assert.strictEqual(value.existingTerminalPublication.receiptSetDigest.slice(0, 7), 'sha256:');
      assert(value.nativePublication);
      assert.strictEqual(value.nativePublication.state, 'COMMITTED');
      // Journal is still readable after the terminal CAS chain.
      const scopedJournal = journalNative
        .createChangesHistoryMarkerJournalNativeLifecycle({ helperPath: artifactHelperPath })
        .forProject(item.rootPath);
      assert(scopedJournal.discoverCurrent());
    } finally { item.cleanup(); }
  });

  test('lost raw E response before the journal CAS remains UNKNOWN/manual and never reconstructs from current records', () => {
    const item = mixedFixture({ helperPath, artifactHelperPath });
    try {
      // Replace the existing-restore lifecycle with the drop wrapper: the
      // reconciliation's executeExistingRestore runs the REAL helper but the
      // E response never arrives. Without a journal-stored publication the
      // fresh R is unavailable and the transaction must stay UNKNOWN/manual
      // with all residue preserved (E is never replayed, current records are
      // never recaptured to invent success).
      const publicMarkdown = publicNative.createPublicMarkdownNativeLifecycle({
        helperPath,
        spawnSync(command, args, options) {
          const commandLine = String(options.input || '').split('\n')[1] || '';
          if (commandLine.startsWith('E\t')) {
            return { ...childProcess.spawnSync(command, args, options), stdout: Buffer.alloc(0) };
          }
          return childProcess.spawnSync(command, args, options);
        },
      });
      const wrappedTransaction = createChangesHistoryTransaction({
        projectService,
        historyService: changeHistoryService,
        reviewService: changeSetReviewService,
        exactArtifactLifecycle: artifactLifecycleService
          .createChangesHistoryArtifactLifecycle({ helperPath: artifactHelperPath }),
        exactMarkerLifecycle: markerLifecycleService
          .createChangesHistoryMarkerLifecycle({ helperPath: artifactHelperPath }),
        publicMarkdownLifecycle: Object.freeze({
          schema: 'writcraft.snapshot-restore-public-markdown-lifecycle/v1',
          forProject(rootPath) {
            const scoped = publicMarkdown.forProject(rootPath);
            return Object.freeze({
              create: scoped.create,
              createMissingJournal: scoped.createMissingJournal,
              reconcile: scoped.reconcile,
              verifyCreate: scoped.verifyCreate,
              finalizeCreate: scoped.finalizeCreate,
              reconcileFinalize: scoped.reconcileFinalize,
              cleanupCreate: scoped.cleanupCreate,
              reconcileCreateCleanup: scoped.reconcileCreateCleanup,
              ackCreateCleanup: scoped.ackCreateCleanup,
              quarantineCreateRollback: scoped.quarantineCreateRollback,
              reconcileCreateRollback: scoped.reconcileCreateRollback,
              deleteCreateRollback: scoped.deleteCreateRollback,
              ackCreateRollback: scoped.ackCreateRollback,
            });
          },
        }),
        existingRestoreLifecycle: Object.freeze({
          schema: 'writcraft.snapshot-restore-existing-restore-lifecycle/v1',
          forProject(rootPath) {
            return publicMarkdown.forProject(rootPath).existingRestore;
          },
        }),
        markerJournalLifecycle: journalNative
          .createChangesHistoryMarkerJournalNativeLifecycle({ helperPath: artifactHelperPath }),
      });
      const item2 = mixedFixture({ helperPath, artifactHelperPath });
      try {
        // Drive the same project shape through the wrapped transaction with
        // the dropped E response.
        const prepared2 = wrappedTransaction.prepareSnapshotRestore({
          rootPath: item2.rootPath,
          projectId: item2.projectId,
          files: item2.args.files,
          provenance: item2.args.provenance,
          parentSelectionBinding: item2.args.parentSelectionBinding,
        });
        let marker = wrappedTransaction.preparePublicMarkdownMarker(prepared2);
        marker = wrappedTransaction.createMissingLeaves(prepared2, marker);
        assert.strictEqual(marker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
        assert.throws(
          () => wrappedTransaction.commitExistingRestore(prepared2, marker),
          error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
        );
        // No stored publication: fresh R is unavailable, so the transaction
        // remains manual UNKNOWN with residue preserved.
        assert.throws(
          () => wrappedTransaction.reconcileExistingRestore(prepared2, marker),
          error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
        );
        // E is never replayed: a retried commit must fail the same way.
        assert.throws(
          () => wrappedTransaction.commitExistingRestore(prepared2, marker),
          error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
        );
        const value = journalValue(item2);
        assert.strictEqual(value.state, 'ACTIVE');
        assert.strictEqual(value.existingTerminalPublication, null);
        assert.strictEqual(
          value.activeMarker.publicMarkdownPhase.phase,
          'CREATED_RECEIPT'
        );
        // The real E mutation and its private records remain on disk as
        // residue; no cleanup or adoption happened.
        assert.deepStrictEqual(fs.readFileSync(path.join(item2.rootPath, 'existing.md')), item2.afterBytes);
        assert.deepStrictEqual(fs.readFileSync(path.join(item2.rootPath, 'new.md')), item2.createdBytes);
      } finally { item2.cleanup(); }
    } finally { item.cleanup(); }
  });

  test('CAS-durable EXISTING publication reconstructs read-only through a fresh native R with the same terminal', () => {
    const item = mixedFixture({ helperPath, artifactHelperPath });
    try {
      const { marker: committedMarker } = runMixedJourney(item);
      assert.strictEqual(committedMarker.publicMarkdownPhase.phase, 'EXISTING_COMMITTED');
      const before = journalValue(item);
      const installed = before.existingTerminalPublication;
      assert(installed);
      // Fresh R consumes the stored publication identities, reproduces the
      // same terminal read-only and never rewrites the journal.
      const marker2 = item.transaction.reconcileExistingRestore(item.prepared, committedMarker);
      assert.strictEqual(marker2.publicMarkdownPhase.phase, 'EXISTING_COMMITTED');
      const after = journalValue(item);
      assert.strictEqual(after.valueDigest, before.valueDigest, 'fresh R must not advance the journal');
      assert.deepStrictEqual(after.existingTerminalPublication, installed);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.afterBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'new.md')), item.createdBytes);
    } finally { item.cleanup(); }
  });

  test('mixed journey exits to FINALIZED with the EXISTING terminal publication FINALIZED', () => {
    const item = mixedFixture({ helperPath, artifactHelperPath });
    try {
      const { terminal, preClearValue, existingPrivateBytes } = runMixedJourneyFullExit(item);
      assert.strictEqual(terminal.files.length, 2);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.afterBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'new.md')), item.createdBytes);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 1);
      // The finalize sealed the terminal (FINALIZED + finalization); clear then
      // ACKs it (ACK_COMMITTED) and returns the journal to IDLE.
      assert.strictEqual(preClearValue.existingTerminalPublication.state, 'FINALIZED');
      assert(preClearValue.existingTerminalPublication.finalization);
      assert.strictEqual(
        preClearValue.existingTerminalPublication.finalization.finalBasename
          .startsWith('.changes-history-native-existing-final.'),
        true
      );
      assert.strictEqual(existingPrivateBytes.has(
        preClearValue.existingTerminalPublication.finalization.finalBasename
      ), true);
      const finalRecord = existingSchema.buildFinalRecordFromPublication(
        preClearValue.existingTerminalPublication
      );
      assert.strictEqual(
        preClearValue.existingTerminalPublication.finalization.finalRecordDigest,
        finalRecord.finalRecordDigest
      );
      assert.strictEqual(
        existingPrivateBytes.get(
          preClearValue.existingTerminalPublication.finalization.finalBasename
        ).toString('utf8'),
        existingSchema.encodeFinalRecordFromPublication(preClearValue.existingTerminalPublication)
      );
      for (const basename of existingPrivateBytes.keys()) {
        assert.strictEqual(
          fs.existsSync(path.join(item.rootPath, '.writcraft', 'recovery', basename)),
          false,
          `${basename} must be absent after ACK_COMMITTED`
        );
      }
      const postClear = journalValue(item);
      assert.strictEqual(postClear.state, 'IDLE');
    } finally { item.cleanup(); }
  });

  test('EXISTING ACK_PREPARED preserves a same-byte new-inode apply replacement', () => {
    let injected = false;
    const item = mixedFixture({
      helperPath,
      artifactHelperPath,
      wrapExistingRestore(scoped, rootPath) {
        return Object.freeze({
          ...scoped,
          ackPublication(publication, markerPhaseDigest, descriptors) {
            if (!injected) {
              injected = true;
              const apply = publication.items[0];
              const recovery = path.join(rootPath, '.writcraft', 'recovery');
              const source = path.join(recovery, apply.applyBasename);
              const held = path.join(recovery, '.test-held-existing-apply');
              fs.renameSync(source, held);
              fs.copyFileSync(held, source, fs.constants.COPYFILE_EXCL);
              fs.chmodSync(source, 0o600);
            }
            return scoped.ackPublication(publication, markerPhaseDigest, descriptors);
          },
        });
      },
    });
    try {
      const { marker: committedMarker } = runMixedJourney(item);
      let marker = item.transaction.commitMissingRestoreHistory(item.prepared, committedMarker);
      marker = item.transaction.finalizeMissingRestore(item.prepared, marker);
      const terminal = item.transaction.reconciliation.finish(item.rootPath, marker.operationId);
      assert.strictEqual(terminal.outcome, 'applied');
      assert.throws(
        () => item.transaction.reconciliation.clear(
          item.rootPath,
          item.projectId,
          marker.operationId
        ),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const value = journalValue(item);
      assert.strictEqual(value.existingTerminalPublication.state, 'ACK_PREPARED');
      const apply = value.existingTerminalPublication.items[0];
      const replacement = path.join(
        item.rootPath,
        '.writcraft',
        'recovery',
        apply.applyBasename
      );
      assert.strictEqual(fs.existsSync(replacement), true);
      assert.strictEqual(
        sha256(fs.readFileSync(replacement)),
        apply.applyRecordIdentity.contentSha256
      );
      assert.notStrictEqual(fs.statSync(replacement).ino.toString(), apply.applyRecordIdentity.ino);
    } finally { item.cleanup(); }
  });

  test('journal drift before the EXISTING terminal CAS fails closed and never installs the publication', () => {
    const item = mixedFixture({ helperPath, artifactHelperPath });
    try {
      // Wrap the journal lifecycle APPEND: after the marker append and the
      // CREATE publication append, replace the journal file with foreign bytes
      // so the EXISTING terminal CAS re-check and the native APPEND both
      // observe drift.
      let appends = 0;
      const driftJournal = journalNative.createChangesHistoryMarkerJournalNativeLifecycle({
        helperPath: artifactHelperPath,
        spawnSync(command, args, options) {
          const commandLine = String(options.input || '').split('\n')[1] || '';
          if (commandLine.startsWith('WRCCHJN2\tAPPEND')) {
            appends += 1;
            // Append #1/#2: prepare (active marker + PREPARED publication);
            // #3/#4/#5: CREATE latch + ARMED + COMMITTED; #6: CREATED_RECEIPT
            // marker; #7: the EXISTING terminal CAS — the drift lands there.
            if (appends === 7 && !driftJournal.__fired) {
              driftJournal.__fired = true;
              const target = journalPath(item.rootPath);
              const bytes = fs.readFileSync(target);
              fs.renameSync(target, `${target}.held`);
              fs.writeFileSync(target, Buffer.concat([bytes, Buffer.from('drift', 'utf8')]), {
                flag: 'wx',
                mode: 0o600,
              });
              fs.chmodSync(target, 0o600);
              fs.rmSync(`${target}.held`);
            }
          }
          return childProcess.spawnSync(command, args, options);
        },
      });
      const wrappedTransaction = createChangesHistoryTransaction({
        projectService,
        historyService: changeHistoryService,
        reviewService: changeSetReviewService,
        exactArtifactLifecycle: artifactLifecycleService
          .createChangesHistoryArtifactLifecycle({ helperPath: artifactHelperPath }),
        exactMarkerLifecycle: markerLifecycleService
          .createChangesHistoryMarkerLifecycle({ helperPath: artifactHelperPath }),
        publicMarkdownLifecycle: Object.freeze({
          schema: 'writcraft.snapshot-restore-public-markdown-lifecycle/v1',
          forProject(rootPath) {
            const scoped = publicNative.createPublicMarkdownNativeLifecycle({
              helperPath,
            }).forProject(rootPath);
            return Object.freeze({
              create: scoped.create,
              createMissingJournal: scoped.createMissingJournal,
              reconcile: scoped.reconcile,
              verifyCreate: scoped.verifyCreate,
              finalizeCreate: scoped.finalizeCreate,
              reconcileFinalize: scoped.reconcileFinalize,
              cleanupCreate: scoped.cleanupCreate,
              reconcileCreateCleanup: scoped.reconcileCreateCleanup,
              ackCreateCleanup: scoped.ackCreateCleanup,
              quarantineCreateRollback: scoped.quarantineCreateRollback,
              reconcileCreateRollback: scoped.reconcileCreateRollback,
              deleteCreateRollback: scoped.deleteCreateRollback,
              ackCreateRollback: scoped.ackCreateRollback,
            });
          },
        }),
        existingRestoreLifecycle: Object.freeze({
          schema: 'writcraft.snapshot-restore-existing-restore-lifecycle/v1',
          forProject(rootPath) {
            return publicNative.createPublicMarkdownNativeLifecycle({
              helperPath,
            }).forProject(rootPath).existingRestore;
          },
        }),
        markerJournalLifecycle: driftJournal,
      });
      const prepared = wrappedTransaction.prepareSnapshotRestore({
        rootPath: item.rootPath,
        projectId: item.projectId,
        files: item.args.files,
        provenance: item.args.provenance,
        parentSelectionBinding: item.args.parentSelectionBinding,
      });
      const marker = wrappedTransaction.preparePublicMarkdownMarker(prepared);
      const createdMarker = wrappedTransaction.createMissingLeaves(prepared, marker);
      assert.strictEqual(createdMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.throws(
        () => wrappedTransaction.commitExistingRestore(prepared, createdMarker),
        error => ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED']
          .includes(error?.code)
      );
      // Fail-closed: the EXISTING terminal publication was never installed and
      // the marker stays at CREATED_RECEIPT (recoverable UNKNOWN). The native
      // E committed its leaf atomically before the CAS, but the journal does
      // not carry the terminal — a fresh R must rebuild it, never replay E.
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), true);
      assert.strictEqual(
        fs.readFileSync(path.join(item.rootPath, 'existing.md'), 'utf8'),
        item.afterBytes.toString('utf8')
      );
      const current = journalNative.createChangesHistoryMarkerJournalNativeLifecycle({
        helperPath: artifactHelperPath,
      }).forProject(item.rootPath).discoverCurrent();
      assert.strictEqual(current.value.existingTerminalPublication, null);
      assert(current.value.nativePublication !== null);
    } finally { item.cleanup(); }
  });

  test('mixed journey formal self-rollback runs ROLLBACK_CREATE Q/R/D/A to ROLLED_BACK', () => {
    const item = mixedFixture({ helperPath: rollbackHelperPath, artifactHelperPath });
    try {
      let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
      marker = item.transaction.createMissingLeaves(item.prepared, marker);
      assert.strictEqual(marker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      // Native E self-rolls-back (apply publication fails) -> formal EXISTING
      // UNCOMMITTED terminal; Main then runs the frozen ROLLBACK_CREATE domain
      // (Q -> fresh R -> D -> A) and advances the marker to ROLLED_BACK with
      // zero public mutation.
      marker = item.transaction.commitExistingRestore(item.prepared, marker);
      assert.strictEqual(marker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      // The ROLLED_BACK phase seals the exact rollback final record digest.
      assert.match(marker.publicMarkdownPhase.rollbackReceiptDigest, /^sha256:[a-f0-9]{64}$/);
      // Every EXISTING leaf and raw History are exactly operation-before; the
      // MISSING leaf was quarantined and deleted.
      assert.deepStrictEqual(
        fs.readFileSync(path.join(item.rootPath, 'existing.md')),
        item.beforeBytes
      );
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
      const value = journalValue(item);
      assert.strictEqual(value.activeMarker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      // The EXISTING terminal was never installed and the staged rollback
      // consumed the CREATE publication authority at the QUARANTINED CAS: the
      // surviving rollback publication is the durable terminal proof.
      assert.strictEqual(value.existingTerminalPublication, null);
      assert.strictEqual(value.nativePublication, null);
      assert.strictEqual(value.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(value.activeMarker.state, 'terminal');
      assert.strictEqual(value.activeMarker.outcome, 'zero_write_error');
      // P1-4: a proven zero-net-write terminal must be CONSUMED, not degraded to
      // UNKNOWN/manual, and must converge to IDLE. Without the rollback clear the
      // project would stay locked in ACTIVE forever and no later restore could
      // begin, so prove the whole exit here rather than only the phase.
      const terminal = item.transaction.reconciliation.finish(
        item.rootPath,
        marker.operationId
      );
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      assert.strictEqual(terminal.publicMarkdownPhase.phase, 'ROLLED_BACK');
      item.transaction.reconciliation.clear(
        item.rootPath,
        item.projectId,
        marker.operationId
      );
      const cleared = journalValue(item);
      assert.strictEqual(cleared.state, 'IDLE');
      assert.strictEqual(cleared.activeOperationId, null);
      assert.strictEqual(cleared.activeKind, null);
      assert.strictEqual(cleared.activeMarker, null);
      assert.strictEqual(cleared.nativePublication, null);
      assert.strictEqual(cleared.existingTerminalPublication, null);
      assert.strictEqual(cleared.rollbackCreatePublication, null);
      assert.strictEqual(cleared.terminalCleanup, null);
      assert.strictEqual(cleared.terminalCleanupDigest, null);
      // Convergence is idempotent: a second clear over an IDLE journal must not
      // throw and must not resurrect any authority.
      item.transaction.reconciliation.clear(
        item.rootPath,
        item.projectId,
        marker.operationId
      );
      assert.strictEqual(journalValue(item).state, 'IDLE');
    } finally { item.cleanup(); }
  });

  // Crash window: the rollback clear durably APPENDs the artifact-cleanup
  // authority into the marker, then the durable acknowledge is lost. Fail
  // closed: the journal stays ACTIVE carrying the cleanup marker but no
  // terminalCleanup, so the crash cannot masquerade as a completed clear.
  test('ROLLED_BACK clear crash after the artifact-cleanup append fails closed and query() converges to IDLE', () => {
    let failAckOnce = true;
    const wrapArtifactLifecycle = base => Object.freeze({
      ...base,
      forProject(root) {
        const scoped = base.forProject(root);
        return Object.freeze({
          ...scoped,
          acknowledge(...args) {
            if (failAckOnce) {
              failAckOnce = false;
              throw new Error('injected acknowledge failure');
            }
            return scoped.acknowledge(...args);
          },
        });
      },
    });
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      wrapArtifactLifecycle,
    });
    try {
      let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
      marker = item.transaction.createMissingLeaves(item.prepared, marker);
      marker = item.transaction.commitExistingRestore(item.prepared, marker);
      assert.strictEqual(marker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      assert.throws(
        () => item.transaction.reconciliation.clear(
          item.rootPath,
          item.projectId,
          marker.operationId
        ),
        error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED' &&
          error.cause instanceof Error
      );
      // The cleanup authority is journaled but unacknowledged: the rollback
      // terminal and its publication stay ACTIVE and no terminalCleanup was
      // written, so no partial convergence is visible.
      const mid = journalValue(item);
      assert.strictEqual(mid.state, 'ACTIVE');
      assert.strictEqual(mid.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert(mid.activeMarker.artifactCleanup);
      assert.strictEqual(mid.terminalCleanup, null);
      assert.strictEqual(mid.terminalCleanupDigest, null);
      // query() auto-clears the durable ROLLED_BACK terminal through the
      // exactPublicTerminal case, reusing the journaled cleanup authority
      // instead of recapturing or replaying any public mutation.
      const queried = item.transaction.reconciliation.query(item.rootPath, item.projectId);
      assert.strictEqual(queried.recovery, null);
      const post = journalValue(item);
      assert.strictEqual(post.state, 'IDLE');
      assert.strictEqual(post.rollbackCreatePublication, null);
      assert.strictEqual(post.terminalCleanup, null);
      // Convergence performed zero public mutation.
      assert.deepStrictEqual(
        fs.readFileSync(path.join(item.rootPath, 'existing.md')),
        item.beforeBytes
      );
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Foreign identity must never inherit a rollback terminal's clear authority.
  test('ROLLED_BACK clear fails closed on a foreign operation identity and drops no authority', () => {
    const item = mixedFixture({ helperPath: rollbackHelperPath, artifactHelperPath });
    try {
      let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
      marker = item.transaction.createMissingLeaves(item.prepared, marker);
      marker = item.transaction.commitExistingRestore(item.prepared, marker);
      assert.strictEqual(marker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const foreignOperationId = `chr_${'9'.repeat(48)}`;
      assert.throws(
        () => item.transaction.reconciliation.clear(
          item.rootPath,
          item.projectId,
          foreignOperationId
        ),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      // The exact terminal is untouched: every authoritative field survives.
      const afterOperation = journalValue(item);
      assert.strictEqual(afterOperation.state, 'ACTIVE');
      assert.strictEqual(afterOperation.activeOperationId, marker.operationId);
      assert.strictEqual(afterOperation.activeKind, 'snapshot_restore');
      assert.strictEqual(afterOperation.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(afterOperation.existingTerminalPublication, null);
      assert.strictEqual(afterOperation.nativePublication, null);
      assert.strictEqual(afterOperation.terminalCleanup, null);
      // A foreign project identity is rejected one layer earlier by the project
      // binding (CHANGES_RECOVERY_STALE) and equally leaves the journal ACTIVE.
      assert.throws(
        () => item.transaction.reconciliation.clear(
          item.rootPath,
          `${item.projectId}-foreign`,
          marker.operationId
        ),
        error => error?.code === 'CHANGES_RECOVERY_STALE'
      );
      const afterProject = journalValue(item);
      assert.strictEqual(afterProject.state, 'ACTIVE');
      assert.strictEqual(afterProject.activeOperationId, marker.operationId);
      assert.strictEqual(afterProject.rollbackCreatePublication.state, 'ACK_COMMITTED');
      // The real owner can still converge through the same journal.
      const cleared = item.transaction.reconciliation.clear(
        item.rootPath,
        item.projectId,
        marker.operationId
      );
      assert.deepStrictEqual(cleared, { ok: true, operationId: marker.operationId });
      assert.strictEqual(journalValue(item).state, 'IDLE');
    } finally { item.cleanup(); }
  });

  // Crash-recovery retry arm for the window between the terminal-cleanup append
  // and the IDLE append: the journal pair must be exactly the ROLLED_BACK
  // terminal value carrying the matching cleanup followed by its IDLE
  // successor, and only the owning identity may consume it.
  test('ROLLED_BACK cleanup-to-IDLE retry arm accepts the exact pair and rejects a foreign identity', () => {
    const item = mixedFixture({ helperPath: rollbackHelperPath, artifactHelperPath });
    try {
      let marker = item.transaction.preparePublicMarkdownMarker(item.prepared);
      marker = item.transaction.createMissingLeaves(item.prepared, marker);
      marker = item.transaction.commitExistingRestore(item.prepared, marker);
      assert.strictEqual(marker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const terminal = item.transaction.reconciliation.finish(item.rootPath, marker.operationId);
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      const cleared = item.transaction.reconciliation.clear(
        item.rootPath,
        item.projectId,
        marker.operationId
      );
      assert.deepStrictEqual(cleared, { ok: true, operationId: marker.operationId });
      // The pair is now (ROLLED_BACK terminal + terminalCleanup) -> IDLE. Only
      // the rollback retry arm can accept it: the Snapshot retry arm requires
      // an ACK_COMMITTED nativePublication that this terminal never carried.
      const retried = item.transaction.reconciliation.clear(
        item.rootPath,
        item.projectId,
        marker.operationId
      );
      assert.deepStrictEqual(retried, { ok: true, operationId: marker.operationId });
      assert.strictEqual(journalValue(item).state, 'IDLE');
      // A foreign identity cannot borrow the same pair: the retry authority is
      // foreign, so clear fails closed and the IDLE journal is not reopened.
      const foreignOperationId = `chr_${'9'.repeat(48)}`;
      assert.throws(
        () => item.transaction.reconciliation.clear(
          item.rootPath,
          item.projectId,
          foreignOperationId
        ),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      assert.strictEqual(journalValue(item).state, 'IDLE');
      assert.deepStrictEqual(
        fs.readFileSync(path.join(item.rootPath, 'existing.md')),
        item.beforeBytes
      );
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  /* ---------------------------------------------------------------------------
   * Staged ROLLBACK_CREATE restart boundaries.
   *
   * Each test drives the production transaction to a durable restart state,
   * abandons it, and then re-enters through the restart router
   * (rollbackUncommittedExistingRestore, reached via
   * reconciliation.reconcileExistingRestore / executeExistingRestore exactly as
   * a restarted Main process would). Faults are injected either at the real
   * native WRCCHJN2 APPEND boundary (a CAS that was not durable) or at the
   * native ROLLBACK_CREATE Q/D/A call boundary.
   * ------------------------------------------------------------------------- */

  // Restart boundary 1: the attempt latch is durable but Q never reached native
  // DURABLE truth. The restart reconciles read-only and never replays Q; fresh R
  // reports UNCOMMITTED, so the operation fails closed instead of re-running the
  // destructive quarantine.
  test('rollback restart after the PREPARED latch never replays Q and fails closed when Q never ran', () => {
    const faults = rollbackFaults();
    faults.failQuarantine = true;
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const latched = journalValue(item);
      assert.strictEqual(latched.state, 'ACTIVE');
      assert.strictEqual(
        latched.rollbackCreatePublication.schema,
        journal.SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION
      );
      assert.strictEqual(latched.rollbackCreatePublication.state, 'PREPARED');
      assert.strictEqual(latched.activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.strictEqual(latched.nativePublication.state, 'COMMITTED');
      assert.strictEqual(latched.existingTerminalPublication, null);
      assert.strictEqual(faults.q, 1);
      // Q never ran: both leaves are exactly as the CREATE left them.
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'new.md')), item.createdBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);

      // Even with Q available again, the restart must only reconcile: it reads
      // the latch and drives fresh R, which stays UNCOMMITTED, so the operation
      // fails closed as CHANGES_MANUAL_RECOVERY_REQUIRED.
      faults.failQuarantine = false;
      const before = faultCounts(faults);
      assert.throws(
        () => restartRollback(item, marker),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      assert.strictEqual(faults.q, before.q, 'restart must never replay Q from the PREPARED latch');
      assert.strictEqual(faults.e, before.e, 'restart must never replay native E');
      assert.strictEqual(faults.d, before.d);
      assert.strictEqual(faults.a, before.a);
      const after = journalValue(item);
      assert.strictEqual(after.valueDigest, latched.valueDigest, 'restart reconcile is read-only');
      assert.strictEqual(after.rollbackCreatePublication.state, 'PREPARED');
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'new.md')), item.createdBytes);
    } finally { item.cleanup(); }
  });

  // Restart boundary 2: Q committed its durable quarantine but the QUARANTINED
  // CAS that seals it was lost. Fresh R must reconcile Q's committed truth,
  // publish the QUARANTINED CAS without replaying Q, and the staged rollback must
  // then complete through D and A.
  test('rollback restart after Q committed before the QUARANTINED CAS reconciles Q truth without replaying Q', () => {
    const faults = rollbackFaults();
    const quarantinedCas = appendFailureInjector(
      value => value.rollbackCreatePublication?.state === 'QUARANTINED'
    );
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      journalSpawnSync: quarantinedCas.spawnSync,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const latched = journalValue(item);
      assert.strictEqual(latched.rollbackCreatePublication.state, 'PREPARED');
      assert.strictEqual(latched.activeMarker.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.strictEqual(latched.nativePublication.state, 'COMMITTED');
      assert.strictEqual(faults.q, 1);
      assert.strictEqual(quarantinedCas.state.failures, 1);
      // Q committed: the MISSING leaf is private, not public.
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);

      // Restart 1: fresh R reconciles Q's committed truth and the QUARANTINED CAS
      // is written without Q. A D fault stops before the ROLLED_BACK CAS so the
      // intermediate QUARANTINED publication stays observable.
      quarantinedCas.state.active = false;
      faults.failDelete = true;
      const afterInitial = faultCounts(faults);
      assert.throws(
        () => restartRollback(item, marker),
        wasInjected
      );
      const quarantined = journalValue(item);
      assert.strictEqual(quarantined.rollbackCreatePublication.state, 'QUARANTINED');
      assert.strictEqual(
        quarantined.activeMarker.publicMarkdownPhase.phase,
        'CREATE_ROLLBACK_QUARANTINED'
      );
      assert.strictEqual(quarantined.nativePublication, null);
      assert.strictEqual(faults.q, afterInitial.q, 'Q must not be replayed by the restart');
      assert.strictEqual(faults.e, afterInitial.e, 'native E must never be replayed');
      assert.strictEqual(faults.d, afterInitial.d + 1);

      // Restart 2: D settles the quarantined identities deterministically and the
      // ROLLED_BACK + ACK CASes reach the zero-write terminal.
      faults.failDelete = false;
      const terminal = restartRollback(item, marker);
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      assert.strictEqual(terminal.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const settled = journalValue(item);
      assert.strictEqual(settled.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(settled.activeMarker.state, 'terminal');
      assert.strictEqual(faults.q, afterInitial.q);
      assert.strictEqual(faults.d, afterInitial.d + 2);
      assert.strictEqual(faults.a, afterInitial.a + 1);
      assert.strictEqual(faults.e, afterInitial.e);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Restart boundary 3a: the QUARANTINED CAS committed but D has not run yet.
  // The restart re-drives D deterministically to ROLLED_BACK.
  test('rollback restart after the QUARANTINED CAS with D not yet run re-drives D to ROLLED_BACK', () => {
    const faults = rollbackFaults();
    faults.failDelete = true;
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        wasInjected
      );
      const quarantined = journalValue(item);
      assert.strictEqual(quarantined.rollbackCreatePublication.state, 'QUARANTINED');
      assert.strictEqual(
        quarantined.activeMarker.publicMarkdownPhase.phase,
        'CREATE_ROLLBACK_QUARANTINED'
      );
      assert.strictEqual(faults.q, 1);
      assert.strictEqual(faults.d, 1);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);

      faults.failDelete = false;
      const before = faultCounts(faults);
      const terminal = restartRollback(item, marker);
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      assert.strictEqual(terminal.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const settled = journalValue(item);
      assert.strictEqual(settled.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(faults.q, before.q);
      assert.strictEqual(faults.d, before.d + 1);
      assert.strictEqual(faults.a, before.a + 1);
      assert.strictEqual(faults.e, before.e);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Restart boundary 3b — KNOWN P1 DEFECT, CHARACTERIZED RED.
  //
  // The QUARANTINED CAS committed and D ran to completion (the quarantined leaf
  // was unlinked and the rollback final record was sealed), but the ROLLED_BACK
  // CAS that would have sealed D's result was lost. Production has no D
  // reconcile: settleRollbackCreate re-issues the raw D command, and native
  // DELETE_CREATE_ROLLBACK requires the exact quarantined record identities
  // (undo_quarantine_state == NAME_EXACT) that its own first pass deleted, so the
  // replay returns UNKNOWN. The restart therefore fails closed as
  // CHANGES_MANUAL_RECOVERY_REQUIRED with the deleted truth and the sealed final
  // record already on disk. The required behaviour is deterministic convergence
  // to ROLLED_BACK; this test pins the observed defect, it does not accept it.
  test('rollback restart after D ran before the ROLLED_BACK CAS settles the sealed truth to ACK_COMMITTED', () => {
    const faults = rollbackFaults();
    const rolledBackCas = appendFailureInjector(
      value => value.rollbackCreatePublication?.state === 'ROLLED_BACK'
    );
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      journalSpawnSync: rolledBackCas.spawnSync,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const afterD = journalValue(item);
      assert.strictEqual(afterD.rollbackCreatePublication.state, 'QUARANTINED');
      assert.strictEqual(
        afterD.activeMarker.publicMarkdownPhase.phase,
        'CREATE_ROLLBACK_QUARANTINED'
      );
      assert.strictEqual(rolledBackCas.state.failures, 1);
      assert.strictEqual(faults.q, 1);
      assert.strictEqual(faults.d, 1, 'D ran before its CAS was lost');
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      // D's own final record is sealed: the deleted truth is already durable.
      const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
      const finalRecords = fs.readdirSync(recovery)
        .filter(name => name.startsWith('.changes-history-native-rollback-create-final.'));
      assert.strictEqual(finalRecords.length, 1, 'D sealed its final record before the lost CAS');

      // The restart re-drives D. Native D now recognises its own committed
      // result (exact sealed final record + clean rollback namespace) and
      // reports FINALIZED, so the deleted truth converges instead of being lost:
      // D -> ROLLED_BACK, then A -> ACK_COMMITTED terminal. Bounded so a
      // non-converging path still fails rather than looping.
      rolledBackCas.state.active = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (journalValue(item).rollbackCreatePublication.state === 'ACK_COMMITTED') break;
        restartRollback(item, marker);
      }
      const converged = journalValue(item);
      assert.strictEqual(converged.state, 'ACTIVE');
      assert.strictEqual(
        converged.rollbackCreatePublication.state,
        'ACK_COMMITTED',
        'D replay must settle the already-sealed truth'
      );
      assert.strictEqual(converged.activeMarker.state, 'terminal');
      assert.strictEqual(converged.activeMarker.outcome, 'zero_write_error');
      assert(faults.d >= 2, 'the restart re-issued the raw D command');
      assert(faults.a >= 1, 'A ran after D converged');
      // Zero public mutation still holds, and History stayed untouched.
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Same boundary, reached through the native D response-loss path instead of a
  // lost journal CAS: the helper commits D and the response is dropped, so
  // deleteCreateRollback's own retry re-issues D. This is the minimal native
  // reproduction of the boundary above.
  test('lost native D response converges through idempotent D replay', () => {
    let dropFirstDeleteResponse = true;
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      publicMarkdownSpawnSync(command, args, options) {
        const input = String(options?.input || '');
        const deletes = input.includes('D\tCREATE_ROLLBACK');
        const result = childProcess.spawnSync(command, args, options);
        if (dropFirstDeleteResponse && deletes) {
          // The helper committed D (it ran above); only the response is lost.
          dropFirstDeleteResponse = false;
          return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signal: null, error: null };
        }
        return result;
      },
    });
    try {
      const marker = driveToCreatedReceipt(item);
      // The helper committed D but its first response was dropped.
      // deleteCreateRollback retries the raw D command; because native D is now
      // idempotent it recognises its own sealed final record and reports
      // FINALIZED, so the rollback completes instead of failing closed. This is
      // the minimal native reproduction of the boundary above.
      const completed = item.transaction.commitExistingRestore(item.prepared, marker);
      assert.strictEqual(completed.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const converged = journalValue(item);
      assert.strictEqual(
        converged.rollbackCreatePublication.state,
        'ACK_COMMITTED',
        'a lost D response must still converge through D -> A'
      );
      assert.strictEqual(converged.activeMarker.state, 'terminal');
      assert.strictEqual(converged.activeMarker.outcome, 'zero_write_error');
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Restart boundary 4: the ROLLED_BACK CAS committed (D truth sealed) but A has
  // not run. The restart must re-drive A to ACK_COMMITTED + the terminal marker.
  // The restart enters through the EXECUTE command on purpose: the router must
  // ignore it and never replay native E.
  test('rollback restart after the ROLLED_BACK CAS before A re-drives A to ACK_COMMITTED', () => {
    const faults = rollbackFaults();
    faults.failAck = true;
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        wasInjected
      );
      const rolled = journalValue(item);
      assert.strictEqual(rolled.rollbackCreatePublication.state, 'ROLLED_BACK');
      assert(rolled.rollbackCreatePublication.settleResultBase64);
      assert.strictEqual(rolled.activeMarker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      assert.strictEqual(faults.q, 1);
      assert.strictEqual(faults.d, 1);
      assert.strictEqual(faults.a, 1);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);

      // EXECUTE routes to the rollback restart: native E must never run.
      faults.failAck = false;
      const before = faultCounts(faults);
      const terminal = restartRollback(item, marker, 'executeExistingRestore');
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      assert.strictEqual(terminal.publicMarkdownPhase.phase, 'ROLLED_BACK');
      const settled = journalValue(item);
      assert.strictEqual(settled.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(settled.activeMarker.state, 'terminal');
      assert.strictEqual(faults.q, before.q);
      assert.strictEqual(faults.d, before.d, 'D must not be replayed by the ACK restart');
      assert.strictEqual(faults.a, before.a + 1);
      assert.strictEqual(faults.e, before.e,
        'native E must never be replayed once the rollback publication exists');
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
    } finally { item.cleanup(); }
  });

  // Restart boundary 5: A consumed the recovered records but the ACK CAS was
  // lost. The restart must settle to ACK_COMMITTED without repeating any
  // destructive work: the native A fast-path sees every private record already
  // absent and acknowledges idempotently.
  test('rollback restart after the A response before the ACK CAS settles to ACK_COMMITTED without duplicate work', () => {
    const faults = rollbackFaults();
    const ackCas = appendFailureInjector(
      value => value.rollbackCreatePublication?.state === 'ACK_COMMITTED' &&
        value.activeMarker?.state === 'terminal'
    );
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      journalSpawnSync: ackCas.spawnSync,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const rolled = journalValue(item);
      assert.strictEqual(rolled.rollbackCreatePublication.state, 'ROLLED_BACK');
      assert.strictEqual(rolled.activeMarker.publicMarkdownPhase.phase, 'ROLLED_BACK');
      assert.strictEqual(ackCas.state.failures, 1);
      assert.strictEqual(faults.q, 1);
      assert.strictEqual(faults.d, 1);
      assert.strictEqual(faults.a, 1, 'A committed before its CAS was lost');
      // A already removed every private rollback record, so the restart's A can
      // only take the absent-record fast path.
      const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
      const rollbackResidue = fs.readdirSync(recovery)
        .filter(name => name.startsWith('.changes-history-native-rollback-create-'));
      assert.deepStrictEqual(rollbackResidue, []);

      ackCas.state.active = false;
      const before = faultCounts(faults);
      const terminal = restartRollback(item, marker);
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      const settled = journalValue(item);
      assert.strictEqual(settled.rollbackCreatePublication.state, 'ACK_COMMITTED');
      assert.strictEqual(settled.activeMarker.state, 'terminal');
      assert.strictEqual(faults.q, before.q);
      assert.strictEqual(faults.d, before.d, 'D must not be replayed by the ACK restart');
      assert.strictEqual(faults.a, before.a + 1);
      assert.strictEqual(faults.e, before.e);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
      assert.strictEqual(changeHistoryService.listHistory(item.rootPath).length, 0);
      assert.deepStrictEqual(
        fs.readdirSync(recovery).filter(name => name.startsWith('.changes-history-native-rollback-create-')),
        []
      );
    } finally { item.cleanup(); }
  });

  // Restart boundary 6: once a rollback publication is durable, neither native E
  // nor native Q/D may be replayed by any restart entry point, and the
  // ACK_COMMITTED terminal is returned read-only.
  test('native E and Q are never replayed once a rollback publication exists', () => {
    const faults = rollbackFaults();
    faults.failAck = true;
    const item = mixedFixture({
      helperPath: rollbackHelperPath,
      artifactHelperPath,
      wrapScopedPublicMarkdown: scoped => faults.wrapScopedPublicMarkdown(scoped),
      wrapExistingRestore: scoped => faults.wrapExistingRestore(scoped),
    });
    try {
      const marker = driveToCreatedReceipt(item);
      assert.throws(
        () => item.transaction.commitExistingRestore(item.prepared, marker),
        wasInjected
      );
      assert.strictEqual(journalValue(item).rollbackCreatePublication.state, 'ROLLED_BACK');

      // First EXECUTE restart: A is re-driven, E and Q are not.
      faults.failAck = false;
      const before = faultCounts(faults);
      const terminal = restartRollback(item, marker, 'executeExistingRestore');
      assert.strictEqual(terminal.state, 'terminal');
      assert.strictEqual(terminal.outcome, 'zero_write_error');
      assert.strictEqual(faults.e, before.e);
      assert.strictEqual(faults.q, before.q);
      assert.strictEqual(faults.d, before.d);
      assert.strictEqual(faults.a, before.a + 1);

      // Second EXECUTE restart on the ACK_COMMITTED terminal: read-only, no
      // native command of any kind.
      const current = journalValue(item);
      const again = restartRollback(item, marker, 'executeExistingRestore');
      assert.strictEqual(again.state, 'terminal');
      assert.strictEqual(again.outcome, 'zero_write_error');
      assert.strictEqual(journalValue(item).valueDigest, current.valueDigest);
      assert.strictEqual(faults.e, before.e);
      assert.strictEqual(faults.q, before.q);
      assert.strictEqual(faults.d, before.d);
      assert.strictEqual(faults.a, before.a + 1);
      assert.deepStrictEqual(fs.readFileSync(path.join(item.rootPath, 'existing.md')), item.beforeBytes);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'new.md')), false);
    } finally { item.cleanup(); }
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed}/18 mixed production journey checks passed.`);
if (passed !== 18) process.exitCode = 1;
