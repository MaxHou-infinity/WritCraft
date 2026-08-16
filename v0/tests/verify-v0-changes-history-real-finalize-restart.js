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
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const evidence = require('../src/main/evidence-delivery-schema');
const artifactLifecycleService = require('../src/main/changes-history-artifact-lifecycle');
const markerLifecycleService = require('../src/main/changes-history-marker-lifecycle');
const markerJournalLifecycleService =
  require('../src/main/changes-history-marker-journal-native-lifecycle');
const publicMarkdownLifecycleService = require('../src/main/public-markdown-native-lifecycle');
const {
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-real-finalize-restart-'));

function compile(sourceName, outputName) {
  const source = path.join(__dirname, '..', 'native', sourceName);
  const output = path.join(scratch, outputName);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-Wframe-larger-than=2097152', '-mmacosx-version-min=11.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', source, '-o', output,
  ]);
  return output;
}

function snapshotState(text) {
  const bytes = Buffer.from(text, 'utf8');
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

function snapshotOnly(lifecycle) {
  return Object.freeze({
    schema: 'writcraft.snapshot-restore-public-markdown-lifecycle/v1',
    forProject(rootPath) {
      const scoped = lifecycle.forProject(rootPath);
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
}

function faultedMarkerJournalLifecycle(lifecycle, fault) {
  if (!fault) return lifecycle;
  return Object.freeze({
    schema: lifecycle.schema,
    forProject(rootPath) {
      const scoped = lifecycle.forProject(rootPath);
      let unavailableDiscoverCurrent = 0;
      return Object.freeze({
        schema: scoped.schema,
        discover: request => scoped.discover(request),
        discoverCurrent() {
          if (unavailableDiscoverCurrent > 0) {
            unavailableDiscoverCurrent -= 1;
            throw new Error('injected post-commit journal read loss');
          }
          return scoped.discoverCurrent();
        },
        initialize: request => scoped.initialize(request),
        read: request => scoped.read(request),
        append(request) {
          const result = scoped.append(request);
          if (!fault.fired && fault.matches(request.previousValue, request.nextValue)) {
            fault.fired = true;
            if (typeof fault.afterAppend === 'function') {
              fault.afterAppend(request.previousValue, request.nextValue, result);
            }
            if (fault.returnResultAfterAppend === true) return result;
            unavailableDiscoverCurrent = 1;
            throw new Error('injected committed journal APPEND response loss');
          }
          return result;
        },
      });
    },
  });
}

function faultedArtifactLifecycle(lifecycle, fault) {
  if (!fault) return lifecycle;
  return Object.freeze({
    schema: lifecycle.schema,
    forProject(rootPath) {
      const scoped = lifecycle.forProject(rootPath);
      return Object.freeze({
        ...scoped,
        acknowledge(basename, token) {
          const result = scoped.acknowledge(basename, token);
          if (!fault.fired) {
            fault.fired = true;
            fault.afterAcknowledge(rootPath, basename, token);
          }
          return result;
        },
      });
    },
  });
}

function faultedPublicMarkdownLifecycle(lifecycle, fault) {
  if (!fault) return lifecycle;
  return Object.freeze({
    schema: lifecycle.schema,
    forProject(rootPath) {
      const scoped = lifecycle.forProject(rootPath);
      return Object.freeze({
        ...scoped,
        ackCreateCleanup(authority) {
          const result = scoped.ackCreateCleanup(authority);
          if (!fault.fired && result.state === 'ACKED') {
            fault.fired = true;
            fault.afterAck(rootPath, authority, result);
          }
          return result;
        },
      });
    },
  });
}

function productionTransaction(
  rootPath,
  helperPaths,
  spawnSync,
  journalFault = null,
  publicFault = null,
  artifactFault = null
) {
  const nativePublicLifecycle = faultedPublicMarkdownLifecycle(
    publicMarkdownLifecycleService.createPublicMarkdownNativeLifecycle({
      helperPath: helperPaths.publicMarkdown,
      ...(spawnSync ? { spawnSync } : {}),
    }),
    publicFault
  );
  const nativePublicScoped = nativePublicLifecycle.forProject(rootPath);
  for (const method of [
    'cleanupCreate',
    'reconcileCreateCleanup',
    'ackCreateCleanup',
  ]) {
    assert.strictEqual(
      typeof nativePublicScoped[method],
      'function',
      `production CREATE finalize cleanup lifecycle lacks ${method}`
    );
  }
  const publicLifecycle = snapshotOnly(nativePublicLifecycle);
  const markerJournalLifecycle = faultedMarkerJournalLifecycle(
    markerJournalLifecycleService.createChangesHistoryMarkerJournalNativeLifecycle({
      helperPath: helperPaths.artifact,
    }),
    journalFault
  );
  const exactArtifactLifecycle = faultedArtifactLifecycle(
    artifactLifecycleService.createChangesHistoryArtifactLifecycle({
      helperPath: helperPaths.artifact,
    }),
    artifactFault
  );
  const exactMarkerLifecycle = markerLifecycleService.createChangesHistoryMarkerLifecycle({
    helperPath: helperPaths.artifact,
  });
  const reconciliationService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    publicMarkdownLifecycle: publicLifecycle,
    markerJournalLifecycle,
    exactArtifactLifecycle,
    exactMarkerLifecycle,
  });
  return Object.freeze({
    markerJournalLifecycle,
    reconciliationService,
    transaction: createChangesHistoryTransaction({
      projectService,
      historyService,
      publicMarkdownLifecycle: publicLifecycle,
      reconciliationService,
    }),
    rootPath,
  });
}

try {
  const helperPaths = {
    publicMarkdown: compile(
      'public-markdown-create-helper.c',
      'public-markdown-create-helper'
    ),
    artifact: compile(
      'changes-history-artifact-helper.c',
      'changes-history-artifact-helper'
    ),
  };
  const projectParent = path.join(scratch, 'workspace');
  fs.mkdirSync(projectParent);
  const project = projectService.createProjectAt(projectParent, 'Real Finalize Restart');
  const recoveryDirectory = path.join(project.rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(recoveryDirectory), 0o700);
  fs.chmodSync(recoveryDirectory, 0o700);
  const after = snapshotState('created through the real native helper\n');
  const selectedId = 'real_missing_leaf';
  const args = {
    rootPath: project.rootPath,
    projectId: project.projectId,
    files: [{
      path: 'recovered.md',
      summary: 'restore missing leaf',
      before: {
        exists: false,
        revision: null,
        contentHash: null,
        byteLength: 0,
        encoding: null,
        data: null,
      },
      after,
      createdIdentityDigest: null,
    }],
    provenance: {
      schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
      snapshotId: 'snapshot_real_finalize_restart',
      snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
      restoreCapabilityId: 'capability_real_finalize_restart',
      comparisonDigest: `sha256:${'2'.repeat(64)}`,
      selectedIds: [selectedId],
    },
    parentSelectionBinding: {
      schema: phaseSchema.SELECTION_SCHEMA,
      kind: 'snapshot_restore',
      selected: [{
        selectedId,
        action: 'MISSING',
        path: 'recovered.md',
        revision: after.revision,
        ancestorIdentityDigest: evidence.digestAncestorIdentity({
          schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
          components: [],
        }),
      }],
    },
  };

  let lostFinalizeResponses = 0;
  const responseLossSpawnSync = (binary, argv, options) => {
    const result = childProcess.spawnSync(binary, argv, options);
    const input = Buffer.isBuffer(options.input)
      ? options.input
      : Buffer.from(options.input, 'utf8');
    if (input.includes(Buffer.from('\nF\t', 'utf8'))) {
      lostFinalizeResponses += 1;
      return {
        ...result,
        status: 17,
        signal: null,
        error: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    return result;
  };

  const first = productionTransaction(project.rootPath, helperPaths, responseLossSpawnSync);
  const prepared = first.transaction.prepareSnapshotRestore(args);
  const precreate = first.transaction.preparePublicMarkdownMarker(prepared);
  const created = first.transaction.createMissingLeaves(prepared, precreate);
  const historyCommitted = first.transaction.commitMissingRestoreHistory(prepared, created);
  assert.strictEqual(historyCommitted.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
  first.transaction.finalizeMissingRestore(prepared, historyCommitted);
  assert.strictEqual(lostFinalizeResponses, 2);
  const afterLoss = first.markerJournalLifecycle.forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(afterLoss.status, 'VALUE');
  assert.strictEqual(afterLoss.value.state, 'ACTIVE');
  assert.strictEqual(
    afterLoss.value.activeMarker.publicMarkdownPhase.phase,
    'HISTORY_COMMITTED'
  );

  let lostAckResponses = 0;
  const ackLossSpawnSync = (binary, argv, options) => {
    const result = childProcess.spawnSync(binary, argv, options);
    const input = Buffer.isBuffer(options.input)
      ? options.input
      : Buffer.from(options.input, 'utf8');
    if (input.includes(Buffer.from('\nA\tCREATE_CLEANUP\t', 'utf8')) &&
        lostAckResponses < 2) {
      lostAckResponses += 1;
      return {
        ...result,
        status: 17,
        signal: null,
        error: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    }
    return result;
  };
  const ackLossRestart = productionTransaction(
    project.rootPath,
    helperPaths,
    ackLossSpawnSync
  );
  assert.throws(
    () => ackLossRestart.reconciliationService.query(project.rootPath, project.projectId),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(lostAckResponses, 2);
  const afterAckLoss = ackLossRestart.markerJournalLifecycle
    .forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(afterAckLoss.value.nativePublication.state, 'ACK_PREPARED');

  const ackCommittedFault = {
    fired: false,
    matches(previous, next) {
      return previous.nativePublication?.state === 'ACK_PREPARED' &&
        next.nativePublication?.state === 'ACK_COMMITTED' &&
        next.activeMarker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED';
    },
  };
  const ackCommittedCrash = productionTransaction(
    project.rootPath,
    helperPaths,
    null,
    ackCommittedFault
  );
  assert.throws(
    () => ackCommittedCrash.reconciliationService.query(
      project.rootPath,
      project.projectId
    ),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(ackCommittedFault.fired, true);
  const afterAckCommittedCrash = ackCommittedCrash.markerJournalLifecycle
    .forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(afterAckCommittedCrash.value.nativePublication.state, 'ACK_COMMITTED');
  assert.strictEqual(
    afterAckCommittedCrash.value.activeMarker.publicMarkdownPhase.phase,
    'HISTORY_COMMITTED'
  );

  const finalizedApplyingFault = {
    fired: false,
    matches(previous, next) {
      return previous.activeMarker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED' &&
        next.activeMarker.publicMarkdownPhase.phase === 'FINALIZED' &&
        next.activeMarker.state === 'applying';
    },
  };
  const finalizedApplyingCrash = productionTransaction(
    project.rootPath,
    helperPaths,
    null,
    finalizedApplyingFault
  );
  assert.throws(
    () => finalizedApplyingCrash.reconciliationService.query(
      project.rootPath,
      project.projectId
    ),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(finalizedApplyingFault.fired, true);
  const afterFinalizedCrash = finalizedApplyingCrash.markerJournalLifecycle
    .forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(afterFinalizedCrash.value.nativePublication.state, 'ACK_COMMITTED');
  assert.strictEqual(afterFinalizedCrash.value.activeMarker.state, 'applying');
  assert.strictEqual(
    afterFinalizedCrash.value.activeMarker.publicMarkdownPhase.phase,
    'FINALIZED'
  );

  const restarted = productionTransaction(project.rootPath, helperPaths);
  const recovery = restarted.reconciliationService.query(project.rootPath, project.projectId);
  assert.strictEqual(recovery.recovery.state, 'terminal');
  assert.strictEqual(recovery.recovery.outcome, 'applied');
  assert.strictEqual(recovery.recovery.publicMarkdownPhase.phase, 'FINALIZED');
  const terminal = restarted.markerJournalLifecycle.forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(terminal.value.state, 'ACTIVE');
  assert.strictEqual(terminal.value.activeMarker.state, 'terminal');
  assert.strictEqual(terminal.value.activeMarker.publicMarkdownPhase.phase, 'FINALIZED');

  const idleFault = {
    fired: false,
    matches(previous, next) {
      return previous.state === 'ACTIVE' && previous.terminalCleanup !== null &&
        next.state === 'IDLE';
    },
  };
  const clearCrash = productionTransaction(project.rootPath, helperPaths, null, idleFault);
  assert.throws(
    () => clearCrash.reconciliationService.clear(
      project.rootPath,
      project.projectId,
      terminal.value.activeOperationId
    ),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(idleFault.fired, true);
  const afterClearCrash = clearCrash.markerJournalLifecycle
    .forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(afterClearCrash.value.state, 'IDLE');

  const clearRestart = productionTransaction(project.rootPath, helperPaths);
  const firstRetry = clearRestart.reconciliationService.clear(
    project.rootPath,
    project.projectId,
    terminal.value.activeOperationId
  );
  assert.deepStrictEqual(firstRetry, {
    ok: true,
    operationId: terminal.value.activeOperationId,
  });
  const secondRetry = clearRestart.reconciliationService.clear(
    project.rootPath,
    project.projectId,
    terminal.value.activeOperationId
  );
  assert.deepStrictEqual(secondRetry, firstRetry);
  const idle = clearRestart.markerJournalLifecycle.forProject(project.rootPath).discoverCurrent();
  assert.strictEqual(idle.value.state, 'IDLE');
  assert.strictEqual(clearRestart.reconciliationService.readMarker(project.rootPath), null);
  assert.strictEqual(
    fs.existsSync(path.join(
      project.rootPath,
      '.writcraft',
      'recovery',
      terminal.value.activeMarker.artifact.basename
    )),
    false
  );
  assert.strictEqual(
    fs.readFileSync(path.join(project.rootPath, 'recovered.md'), 'utf8'),
    'created through the real native helper\n'
  );
  assert.strictEqual(historyService.loadHistoryState(project.rootPath).exists, true);

  for (const mutation of ['same-inode-rewrite', 'new-inode-exact', 'delete']) {
    const driftProject = projectService.createProjectAt(
      projectParent,
      `Final ACK Drift ${mutation}`
    );
    const driftRecovery = path.join(driftProject.rootPath, '.writcraft', 'recovery');
    fs.mkdirSync(driftRecovery, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(driftRecovery), 0o700);
    fs.chmodSync(driftRecovery, 0o700);
    const driftSelectedId = `final_ack_${mutation.replaceAll('-', '_')}`;
    const driftArgs = {
      ...args,
      rootPath: driftProject.rootPath,
      projectId: driftProject.projectId,
      files: [{
        ...args.files[0],
        path: 'drift.md',
      }],
      provenance: {
        ...args.provenance,
        snapshotId: `snapshot_${driftSelectedId}`,
        restoreCapabilityId: `capability_${driftSelectedId}`,
        selectedIds: [driftSelectedId],
      },
      parentSelectionBinding: {
        ...args.parentSelectionBinding,
        selected: [{
          ...args.parentSelectionBinding.selected[0],
          selectedId: driftSelectedId,
          path: 'drift.md',
        }],
      },
    };
    const beforeCapture = productionTransaction(driftProject.rootPath, helperPaths);
    const driftPrepared = beforeCapture.transaction.prepareSnapshotRestore(driftArgs);
    const driftPrecreate = beforeCapture.transaction.preparePublicMarkdownMarker(driftPrepared);
    const driftCreated = beforeCapture.transaction.createMissingLeaves(
      driftPrepared,
      driftPrecreate
    );
    const driftHistory = beforeCapture.transaction.commitMissingRestoreHistory(
      driftPrepared,
      driftCreated
    );
    const capturedFault = {
      fired: false,
      matches(previous, next) {
        return previous.nativePublication?.createFinalization?.state === 'PREPARED' &&
          next.nativePublication?.createFinalization?.state === 'CAPTURED';
      },
    };
    const captureCrash = productionTransaction(
      driftProject.rootPath,
      helperPaths,
      null,
      capturedFault
    );
    assert.throws(
      () => captureCrash.transaction.finalizeMissingRestore(driftPrepared, driftHistory),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(capturedFault.fired, true);
    const capturedCurrent = captureCrash.markerJournalLifecycle
      .forProject(driftProject.rootPath).discoverCurrent();
    const capturedFinalization = capturedCurrent.value.nativePublication.createFinalization;
    assert.strictEqual(capturedFinalization.state, 'CAPTURED');
    const finalPath = path.join(driftRecovery, capturedFinalization.finalBasename);
    const finalBytes = fs.readFileSync(finalPath);
    if (mutation === 'same-inode-rewrite') {
      const fd = fs.openSync(finalPath, 'r+');
      fs.writeSync(fd, Buffer.alloc(finalBytes.length, 0x78), 0, finalBytes.length, 0);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } else if (mutation === 'new-inode-exact') {
      fs.renameSync(finalPath, `${finalPath}.old`);
      fs.writeFileSync(finalPath, finalBytes, { flag: 'wx', mode: 0o600 });
    } else {
      fs.unlinkSync(finalPath);
    }
    const driftRestart = productionTransaction(driftProject.rootPath, helperPaths);
    assert.throws(
      () => driftRestart.reconciliationService.query(
        driftProject.rootPath,
        driftProject.projectId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = driftRestart.markerJournalLifecycle
      .forProject(driftProject.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.nativePublication.state, 'COMMITTED');
    assert.strictEqual(retained.value.nativePublication.createFinalization.state, 'CAPTURED');
    for (const item of retained.value.nativePublication.createCapture.items) {
      for (const record of [item.control, item.receipt]) {
        assert.strictEqual(record.state, 'PUBLISHED');
        assert.strictEqual(record.cleanupBasename, null);
        assert.strictEqual(
          fs.existsSync(path.join(driftRecovery, record.deterministicBasename)),
          true
        );
      }
    }
  }

  function historyCommittedScenario(label) {
    const scenarioProject = projectService.createProjectAt(projectParent, label);
    const scenarioRecovery = path.join(
      scenarioProject.rootPath,
      '.writcraft',
      'recovery'
    );
    fs.mkdirSync(scenarioRecovery, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(scenarioRecovery), 0o700);
    fs.chmodSync(scenarioRecovery, 0o700);
    const suffix = label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
    const scenarioSelectedId = `post_ack_${suffix}`;
    const scenarioArgs = {
      ...args,
      rootPath: scenarioProject.rootPath,
      projectId: scenarioProject.projectId,
      files: [{ ...args.files[0], path: 'post-ack.md' }],
      provenance: {
        ...args.provenance,
        snapshotId: `snapshot_${scenarioSelectedId}`,
        restoreCapabilityId: `capability_${scenarioSelectedId}`,
        selectedIds: [scenarioSelectedId],
      },
      parentSelectionBinding: {
        ...args.parentSelectionBinding,
        selected: [{
          ...args.parentSelectionBinding.selected[0],
          selectedId: scenarioSelectedId,
          path: 'post-ack.md',
        }],
      },
    };
    const initial = productionTransaction(scenarioProject.rootPath, helperPaths);
    const scenarioPrepared = initial.transaction.prepareSnapshotRestore(scenarioArgs);
    const scenarioPrecreate = initial.transaction.preparePublicMarkdownMarker(
      scenarioPrepared
    );
    const scenarioCreated = initial.transaction.createMissingLeaves(
      scenarioPrepared,
      scenarioPrecreate
    );
    const scenarioHistory = initial.transaction.commitMissingRestoreHistory(
      scenarioPrepared,
      scenarioCreated
    );
    return {
      project: scenarioProject,
      recovery: scenarioRecovery,
      prepared: scenarioPrepared,
      history: scenarioHistory,
    };
  }

  function rewriteFinalSameInode(finalPath) {
    const before = fs.statSync(finalPath, { bigint: true });
    const bytes = fs.readFileSync(finalPath);
    const foreign = Buffer.alloc(bytes.length, 0x7a);
    const fd = fs.openSync(finalPath, 'r+');
    fs.writeSync(fd, foreign, 0, foreign.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const afterStat = fs.statSync(finalPath, { bigint: true });
    assert.strictEqual(afterStat.ino, before.ino);
    assert.deepStrictEqual(fs.readFileSync(finalPath), foreign);
    return foreign;
  }

  {
    const scenario = historyCommittedScenario('ACK Return Drift');
    const armFault = {
      fired: false,
      matches(previous, next) {
        return previous.nativePublication?.state === 'COMMITTED' &&
          next.nativePublication?.state === 'ACK_PREPARED';
      },
    };
    const armCrash = productionTransaction(
      scenario.project.rootPath,
      helperPaths,
      null,
      armFault
    );
    assert.throws(
      () => armCrash.transaction.finalizeMissingRestore(
        scenario.prepared,
        scenario.history
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(armFault.fired, true);
    const armed = armCrash.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(armed.value.nativePublication.state, 'ACK_PREPARED');
    const publicFault = {
      fired: false,
      afterAck(_rootPath, authority) {
        rewriteFinalSameInode(path.join(scenario.recovery, authority.finalBasename));
      },
    };
    const ackReturnDrift = productionTransaction(
      scenario.project.rootPath,
      helperPaths,
      null,
      null,
      publicFault
    );
    assert.throws(
      () => ackReturnDrift.reconciliationService.query(
        scenario.project.rootPath,
        scenario.project.projectId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(publicFault.fired, true);
    const retained = ackReturnDrift.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.nativePublication.state, 'ACK_PREPARED');
    assert.strictEqual(
      retained.value.activeMarker.publicMarkdownPhase.phase,
      'HISTORY_COMMITTED'
    );
    for (const item of retained.value.nativePublication.createCapture.items) {
      for (const record of [item.control, item.receipt]) {
        assert.strictEqual(record.state, 'CLEANUP_ARMED');
        assert.strictEqual(
          fs.existsSync(path.join(scenario.recovery, record.deterministicBasename)),
          false
        );
        assert.strictEqual(
          fs.existsSync(path.join(scenario.recovery, record.cleanupBasename)),
          false
        );
      }
    }
  }

  {
    const scenario = historyCommittedScenario('ACK Committed Drift');
    const commitFault = {
      fired: false,
      matches(previous, next) {
        return previous.nativePublication?.state === 'ACK_PREPARED' &&
          next.nativePublication?.state === 'ACK_COMMITTED';
      },
    };
    const commitCrash = productionTransaction(
      scenario.project.rootPath,
      helperPaths,
      null,
      commitFault
    );
    assert.throws(
      () => commitCrash.transaction.finalizeMissingRestore(
        scenario.prepared,
        scenario.history
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(commitFault.fired, true);
    const committed = commitCrash.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(committed.value.nativePublication.state, 'ACK_COMMITTED');
    const finalPath = path.join(
      scenario.recovery,
      committed.value.nativePublication.createCleanupFinalBasename
    );
    rewriteFinalSameInode(finalPath);
    const restart = productionTransaction(scenario.project.rootPath, helperPaths);
    assert.throws(
      () => restart.reconciliationService.query(
        scenario.project.rootPath,
        scenario.project.projectId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = restart.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.nativePublication.state, 'ACK_COMMITTED');
    assert.strictEqual(
      retained.value.activeMarker.publicMarkdownPhase.phase,
      'HISTORY_COMMITTED'
    );
    assert.deepStrictEqual(fs.readFileSync(finalPath), Buffer.alloc(
      fs.statSync(finalPath).size,
      0x7a
    ));
  }

  {
    const scenario = historyCommittedScenario('Terminal Final Drift');
    const complete = productionTransaction(scenario.project.rootPath, helperPaths);
    complete.transaction.finalizeMissingRestore(scenario.prepared, scenario.history);
    const terminalCurrent = complete.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(terminalCurrent.value.activeMarker.state, 'terminal');
    const finalPath = path.join(
      scenario.recovery,
      terminalCurrent.value.nativePublication.createCleanupFinalBasename
    );
    const foreign = rewriteFinalSameInode(finalPath);
    assert.throws(
      () => complete.reconciliationService.clear(
        scenario.project.rootPath,
        scenario.project.projectId,
        terminalCurrent.value.activeOperationId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = complete.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.state, 'ACTIVE');
    assert.strictEqual(retained.value.activeMarker.state, 'terminal');
    assert.strictEqual(retained.value.terminalCleanup, null);
    assert.strictEqual(
      fs.existsSync(path.join(
        scenario.recovery,
        retained.value.activeMarker.artifact.basename
      )),
      true
    );
    assert.deepStrictEqual(fs.readFileSync(finalPath), foreign);
  }

  {
    const scenario = historyCommittedScenario('Terminal Cleanup Pre Append Drift');
    const complete = productionTransaction(scenario.project.rootPath, helperPaths);
    complete.transaction.finalizeMissingRestore(scenario.prepared, scenario.history);
    const terminal = complete.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(terminal.value.activeMarker.state, 'terminal');
    const finalPath = path.join(
      scenario.recovery,
      terminal.value.nativePublication.createCleanupFinalBasename
    );
    const artifactAckFault = {
      fired: false,
      afterAcknowledge() {
        rewriteFinalSameInode(finalPath);
      },
    };
    const clearCrash = productionTransaction(
      scenario.project.rootPath,
      helperPaths,
      null,
      null,
      null,
      artifactAckFault
    );
    assert.throws(
      () => clearCrash.reconciliationService.clear(
        scenario.project.rootPath,
        scenario.project.projectId,
        terminal.value.activeOperationId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(artifactAckFault.fired, true);
    const retained = clearCrash.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.state, 'ACTIVE');
    assert.strictEqual(retained.value.activeMarker.state, 'terminal');
    assert(retained.value.activeMarker.artifactCleanup);
    assert.strictEqual(retained.value.terminalCleanup, null);
    assert.strictEqual(fs.existsSync(path.join(
      scenario.recovery,
      retained.value.activeMarker.artifact.basename
    )), false);
    assert.deepStrictEqual(
      fs.readFileSync(finalPath),
      Buffer.alloc(fs.statSync(finalPath).size, 0x7a)
    );
  }

  {
    const scenario = historyCommittedScenario('Terminal Cleanup Post Append Drift');
    const complete = productionTransaction(scenario.project.rootPath, helperPaths);
    complete.transaction.finalizeMissingRestore(scenario.prepared, scenario.history);
    const terminal = complete.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(terminal.value.activeMarker.state, 'terminal');
    const finalPath = path.join(
      scenario.recovery,
      terminal.value.nativePublication.createCleanupFinalBasename
    );
    const terminalCleanupFault = {
      fired: false,
      returnResultAfterAppend: true,
      matches(previous, next) {
        return previous.state === 'ACTIVE' && previous.terminalCleanup === null &&
          next.state === 'ACTIVE' && next.terminalCleanup !== null;
      },
      afterAppend() {
        rewriteFinalSameInode(finalPath);
      },
    };
    const clearCrash = productionTransaction(
      scenario.project.rootPath,
      helperPaths,
      null,
      terminalCleanupFault
    );
    assert.throws(
      () => clearCrash.reconciliationService.clear(
        scenario.project.rootPath,
        scenario.project.projectId,
        terminal.value.activeOperationId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(terminalCleanupFault.fired, true);
    const retained = clearCrash.markerJournalLifecycle
      .forProject(scenario.project.rootPath).discoverCurrent();
    assert.strictEqual(retained.value.state, 'ACTIVE');
    assert.strictEqual(retained.value.activeMarker.state, 'terminal');
    assert(retained.value.activeMarker.artifactCleanup);
    assert(retained.value.terminalCleanup);
    assert.strictEqual(
      retained.value.terminalCleanup.publicationState,
      'ACK_COMMITTED'
    );
    assert.strictEqual(fs.existsSync(path.join(
      scenario.recovery,
      retained.value.activeMarker.artifact.basename
    )), false);
    assert.deepStrictEqual(
      fs.readFileSync(finalPath),
      Buffer.alloc(fs.statSync(finalPath).size, 0x7a)
    );
  }

  console.log(
    '1/1 real permanent-journal CREATE finalize APPEND-loss/restart ACK/IDLE verification passed'
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
