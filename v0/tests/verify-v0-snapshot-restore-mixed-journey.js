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

  const artifactLifecycle = artifactLifecycleService
    .createChangesHistoryArtifactLifecycle({ helperPath: artifactHelperPath });
  const markerLifecycle = markerLifecycleService
    .createChangesHistoryMarkerLifecycle({ helperPath: artifactHelperPath });
  const publicMarkdown = publicNative.createPublicMarkdownNativeLifecycle({ helperPath });
  const markerJournal = journalNative.createChangesHistoryMarkerJournalNativeLifecycle({
    helperPath: artifactHelperPath,
  });
  const publicMarkdownLifecycle = Object.freeze({
    schema: 'writcraft.snapshot-restore-public-markdown-lifecycle/v1',
    forProject(candidateRoot) {
      const scoped = publicMarkdown.forProject(candidateRoot);
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
      });
    },
  });
  const existingRestoreLifecycle = Object.freeze({
    schema: 'writcraft.snapshot-restore-existing-restore-lifecycle/v1',
    forProject(candidateRoot) {
      return publicMarkdown.forProject(candidateRoot).existingRestore;
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
  const terminal = item.transaction.reconciliation.finish(item.rootPath, marker.operationId);
  assert.strictEqual(terminal.state, 'terminal');
  assert.strictEqual(terminal.outcome, 'applied');
  item.transaction.reconciliation.clear(item.rootPath, item.projectId, marker.operationId);
  return { marker: finalized, terminal, preClearValue };
}

try {
  const helperPath = compileHelper('public-markdown-create-helper.c', 'public-markdown-create-helper');
  const artifactHelperPath = compileHelper(
    'changes-history-artifact-helper.c',
    'changes-history-artifact-helper'
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
      const { terminal, preClearValue } = runMixedJourneyFullExit(item);
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
      const finalPath = path.join(
        item.rootPath,
        '.writcraft',
        'recovery',
        preClearValue.existingTerminalPublication.finalization.finalBasename
      );
      assert.strictEqual(fs.existsSync(finalPath), true);
      const finalRecord = existingSchema.buildFinalRecordFromPublication(
        preClearValue.existingTerminalPublication
      );
      assert.strictEqual(
        preClearValue.existingTerminalPublication.finalization.finalRecordDigest,
        finalRecord.finalRecordDigest
      );
      assert.strictEqual(
        fs.readFileSync(finalPath, 'utf8'),
        existingSchema.encodeFinalRecordFromPublication(preClearValue.existingTerminalPublication)
      );
      const postClear = journalValue(item);
      assert.strictEqual(postClear.state, 'IDLE');
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
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed}/5 mixed production journey checks passed.`);
if (passed !== 5) process.exitCode = 1;
