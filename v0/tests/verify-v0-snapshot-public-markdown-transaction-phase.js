#!/usr/bin/env node
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
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');
const {
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');
const markerJournalSchema = require('../src/main/changes-history-marker-journal-schema');
const recoveryArtifact = require('../src/main/changes-history-recovery-artifact');
const evidenceSchema = require('../src/main/evidence-delivery-schema');
const nativeSchema = require('../src/main/public-markdown-native-schema');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function state(text) {
  const bytes = Buffer.from(text, 'utf8');
  const revision = digest(bytes);
  return {
    exists: true,
    revision,
    contentHash: revision,
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

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-public-markdown-phase-'));
  const project = projectService.createProjectAt(parent, 'Public Markdown Phase');
  return {
    parent,
    project,
    cleanup() { fs.rmSync(parent, { recursive: true, force: true }); },
  };
}

function provenance() {
  return {
    schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    snapshotId: 'snapshot_phase_a',
    snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
    restoreCapabilityId: 'capability_phase_a',
    comparisonDigest: `sha256:${'2'.repeat(64)}`,
    selectedIds: ['selected_missing'],
  };
}

function parentBinding(kind = 'snapshot_restore') {
  return {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind,
    selected: [{
      selectedId: 'selected_missing',
      action: kind === 'snapshot_restore' ? 'MISSING' : 'CREATED',
      path: 'chapters/new.md',
      revision: state('snapshot new\n').revision,
      ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
    }],
  };
}

// Test-only stand-in. Production has no path-unlink fallback.
function trustedFakeArtifactLifecycle() {
  const exactRemove = request => {
    const held = fs.fstatSync(request.heldFd, { bigint: true });
    const current = fs.lstatSync(path.join(request.directory, request.basename), { bigint: true });
    assert.strictEqual(current.dev, held.dev);
    assert.strictEqual(current.ino, held.ino);
    fs.unlinkSync(path.join(request.directory, request.basename));
    const fd = fs.openSync(request.directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  return Object.freeze({ cleanup: exactRemove, rollback: exactRemove });
}

function durableFakeArtifactLifecycle(calls, options = {}) {
  let token = null;
  let acknowledgeFailures = options.acknowledgeFailures || 0;
  const exactRemove = request => {
    calls.push('artifactCleanup');
    const held = fs.fstatSync(request.heldFd, { bigint: true });
    const file = path.join(request.directory, request.basename);
    const current = fs.lstatSync(file, { bigint: true });
    assert.strictEqual(current.dev, held.dev);
    assert.strictEqual(current.ino, held.ino);
    fs.unlinkSync(file);
    const fd = fs.openSync(request.directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    token = Object.freeze({
      schema: 'writcraft.changes-history-artifact-cleanup-token/v1',
      quarantine: `.changes-history-cleanup.${'1'.repeat(32)}`,
      control: `.changes-history-cleanup-control.${'2'.repeat(64)}`,
      proof: `.changes-history-cleanup-proof.${'3'.repeat(64)}`,
      receipt: `.changes-history-cleanup-receipt.${'4'.repeat(64)}`,
      receiptDigest: `sha256:${'5'.repeat(64)}`,
    });
    if (typeof options.afterCleanup === 'function') options.afterCleanup(token);
    if (options.throwAfterCleanup === true) throw new Error('lost artifact cleanup response');
    return token;
  };
  return Object.freeze({
    cleanup: exactRemove,
    rollback: exactRemove,
    reconcile() {
      calls.push('artifactReconcile');
      if (options.reconcileUnknown === true) throw new Error('artifact cleanup UNKNOWN');
      if (options.reconcileOverride !== undefined) return options.reconcileOverride;
      return token;
    },
    verify(_binding, candidate) {
      calls.push('artifactVerify');
      const descriptors = candidate && Object.getOwnPropertyDescriptors(candidate);
      const keys = [
        'schema', 'quarantine', 'control', 'proof', 'receipt', 'receiptDigest',
      ];
      assert(candidate && Object.getPrototypeOf(candidate) === Object.prototype);
      assert.deepStrictEqual(Reflect.ownKeys(candidate).sort(), [...keys].sort());
      for (const key of keys) {
        const descriptor = descriptors[key];
        assert(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'));
        assert(!Object.hasOwn(descriptor, 'get') && !Object.hasOwn(descriptor, 'set'));
      }
      assert(token);
      assert.deepStrictEqual(candidate, token);
      return token;
    },
    acknowledge() {
      calls.push('artifactAcknowledge');
      if (options.ackCommittedThenThrow === true && token !== null) {
        token = null;
        throw new Error('artifact ACK committed then response lost');
      }
      if (acknowledgeFailures > 0) {
        acknowledgeFailures -= 1;
        throw new Error('lost artifact ACK response');
      }
      token = null;
    },
  });
}

function trustedFakeMarkerLifecycle(calls, options = {}) {
  let responseDropped = false;
  return Object.freeze({
    clear(request) {
      calls.push('markerClear');
      const held = fs.fstatSync(request.heldFd, { bigint: true });
      const current = fs.lstatSync(path.join(request.directory, request.basename), { bigint: true });
      assert.strictEqual(current.dev, held.dev);
      assert.strictEqual(current.ino, held.ino);
      assert.strictEqual(current.size, held.size);
      const heldBytes = Buffer.alloc(Number(held.size));
      assert.strictEqual(
        fs.readSync(request.heldFd, heldBytes, 0, heldBytes.length, 0),
        heldBytes.length
      );
      assert.strictEqual(
        `sha256:${digest(heldBytes)}`,
        request.rawDigest
      );
      fs.unlinkSync(path.join(request.directory, request.basename));
      const fd = fs.openSync(request.directory, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (options.throwAfterClear === true && !responseDropped) {
        responseDropped = true;
        throw new Error('lost exact marker clear response');
      }
      return Object.freeze({
        schema: 'writcraft.changes-history-marker-clear-receipt/v1',
        operationId: request.operationId,
        markerDigest: request.rawDigest,
      });
    },
  });
}

function legacyMarkerJournalLifecycle(calls, rootPath) {
  const legacy = () => {
    calls.push('journalDiscoverLegacy');
    const status = fs.existsSync(path.join(
      rootPath,
      '.writcraft',
      'recovery',
      'changes-history-transaction.json'
    )) ? 'LEGACY' : 'ABSENT';
    return {
      schema: 'writcraft.changes-history-marker-journal-native-result/v1',
      command: 'DISCOVER',
      status,
      olderSlot: null,
      olderHead: null,
      olderPreviousValueDigest: null,
      olderValue: null,
      newerSlot: null,
      newerHead: null,
      newerPreviousValueDigest: null,
      requestDigest: `sha256:${'9'.repeat(64)}`,
    };
  };
  const forbidden = name => () => {
    calls.push(name);
    throw new Error(`${name} must not run for LEGACY compatibility`);
  };
  return Object.freeze({
    schema: 'writcraft.changes-history-marker-journal-native-lifecycle/v1',
    forProject() {
      return Object.freeze({
        schema: 'writcraft.changes-history-marker-journal-native-lifecycle-scoped/v1',
        discover: legacy,
        discoverCurrent: legacy,
        initialize: forbidden('journalInitialize'),
        read: forbidden('journalRead'),
        append: forbidden('journalAppend'),
      });
    },
  });
}

function dormantPublicMarkdownLifecycle(calls) {
  const absentReceipt = request => ({
    schema: 'writcraft.public-markdown-create-receipt/v1',
    status: 'ABSENT',
    operationId: request.operationId,
    projectId: request.projectId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    items: [],
  });
  return Object.freeze({
    create() { calls.push('create'); },
    createMissingJournal() { calls.push('createMissingJournal'); },
    verifyCreate(_request, _native, heldFd, receipt) {
      calls.push('verifyCreate');
      assert(Number.isInteger(heldFd));
      return receipt;
    },
    finalizeCreate() { calls.push('finalizeCreate'); },
    reconcileFinalize() { calls.push('reconcileFinalize'); },
    reconcile(request, _native, heldFd) {
      calls.push('reconcile');
      assert(Number.isInteger(heldFd));
      return absentReceipt(request);
    },
  });
}

function exactOnceCreateLifecycle(calls, options = {}) {
  let receipt = null;
  let finalAck = null;
  let finalRecord = null;
  let currentProjectId = options.projectId || null;
  const absent = request => ({
    schema: 'writcraft.public-markdown-create-receipt/v1',
    status: 'ABSENT',
    operationId: request.operationId,
    projectId: request.projectId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    items: [],
  });
  const created = (request, nativeRequest = null) => ({
    ...absent(request),
    status: 'CREATED',
    items: request.items.map((item, index) => {
      assert(Buffer.isBuffer(item.bytes));
      assert.strictEqual(digest(item.bytes), item.afterRevision);
      return {
        selectedId: item.selectedId,
        path: item.path,
        afterRevision: item.afterRevision,
        ancestorIdentityDigest: item.ancestorIdentityDigest,
        contentDigest: `sha256:${digest(item.bytes)}`,
        createdIdentityDigest: `sha256:${digest(Buffer.from(`identity:${index}:${item.path}`))}`,
        creationReceiptDigest: nativeRequest
          ? nativeSchema.buildReceipt(
            nativeSchema.buildControl(nativeRequest, index),
            `sha256:${digest(Buffer.from(`identity:${index}:${item.path}`))}`
          ).receiptDigest
          : `sha256:${digest(Buffer.from(`receipt:${index}:${item.path}`))}`,
      };
    }),
  });
  return Object.freeze({
    createMissingJournal() {
      calls.push('createMissingJournal');
      throw new Error('journal CREATE is outside this focused fake');
    },
    reconcile(request, _nativeRequest, heldFd) {
      calls.push('reconcile');
      assert(Number.isInteger(heldFd));
      currentProjectId = request.projectId;
      return receipt || absent(request);
    },
    create(request, nativeRequest, heldFd) {
      calls.push('create');
      assert(Number.isInteger(heldFd));
      currentProjectId = request.projectId;
      if (receipt) throw new Error('CREATE replayed');
      receipt = created(request, nativeRequest);
      if (typeof options.afterCreate === 'function') options.afterCreate(request, receipt);
      if (options.throwAfterCreate === true) throw new Error('lost CREATE response');
      return receipt;
    },
    verifyCreate(request, _nativeRequest, heldFd, candidate) {
      calls.push('verifyCreate');
      assert(Number.isInteger(heldFd));
      if (options.verifyError) throw options.verifyError;
      if (typeof options.verifyAuthority === 'function') options.verifyAuthority(request, candidate);
      assert.deepStrictEqual(candidate, receipt);
      return receipt;
    },
    reconcileFinalize(request, createRequest, publicRequest) {
      calls.push('reconcileFinalize');
      assert.strictEqual(publicRequest.projectId, currentProjectId);
      if (finalRecord) {
        if (!fs.existsSync(finalRecord)) return {
          schema: 'writcraft.public-markdown-finalize-ack/v1',
          status: 'ABSENT',
          operationId: request.operationId,
          projectId: currentProjectId,
          authorityDigest: evidenceSchema.digestObject(request.schema, request),
          receiptName: null,
          finalReceiptDigest: null,
        };
        return JSON.parse(fs.readFileSync(finalRecord, 'utf8'));
      }
      if (finalAck) return finalAck;
      return {
        schema: 'writcraft.public-markdown-finalize-ack/v1',
        status: 'ABSENT',
        operationId: request.operationId,
        projectId: currentProjectId,
        authorityDigest: evidenceSchema.digestObject(request.schema, request),
        receiptName: null,
        finalReceiptDigest: null,
      };
    },
    finalizeCreate(request, createRequest, publicRequest) {
      calls.push('finalizeCreate');
      assert.strictEqual(publicRequest.projectId, currentProjectId);
      if (finalAck) throw new Error('FINALIZE replayed');
      const native = request.schema === nativeSchema.SCHEMAS.FINALIZE_REQUEST && createRequest;
      const expected = native ? nativeSchema.buildFinalAck(request, createRequest) : null;
      const receiptName = native
        ? nativeSchema.finalRecordName(request, createRequest)
        : `.public-markdown-finalize-${digest(Buffer.from(`final:${request.operationId}`))}.receipt`;
      finalAck = {
        schema: 'writcraft.public-markdown-finalize-ack/v1',
        status: 'FINALIZED',
        operationId: request.operationId,
        projectId: publicRequest.projectId,
        authorityDigest: evidenceSchema.digestObject(request.schema, request),
        receiptName,
        finalReceiptDigest: expected?.finalAckDigest ||
          `sha256:${digest(Buffer.from(`final-receipt:${receiptName}`))}`,
      };
      if (options.forgeFinalAck === true) {
        finalAck.receiptName = `.public-markdown-finalize-${'f'.repeat(64)}.receipt`;
        finalAck.finalReceiptDigest = `sha256:${'e'.repeat(64)}`;
      }
      if (options.finalRecordDirectory) {
        finalRecord = path.join(options.finalRecordDirectory, receiptName);
        fs.writeFileSync(finalRecord, `${JSON.stringify(finalAck)}\n`, { flag: 'wx', mode: 0o600 });
      }
      if (options.throwAfterFinalize === true) throw new Error('lost FINALIZE response');
      return finalAck;
    },
    finalRecordPath() { return finalRecord; },
  });
}

function privateRecordIdentity(wire, ino) {
  const bytes = Buffer.from(wire, 'utf8');
  return {
    schema: evidenceSchema.SCHEMAS.OBJECT_IDENTITY,
    dev: '9001',
    ino: String(ino),
    uid: process.geteuid(),
    mode: 0o600,
    nlink: 1,
    size: String(bytes.length),
    mtimeNs: '1000000000',
    ctimeNs: '1000000001',
    contentSha256: evidenceSchema.sha256(bytes),
  };
}

function exactOnceUndoLifecycle(calls, options = {}) {
  let committedTokens = null;
  let reconcileMode = options.reconcileMode || 'COMMITTED';
  let afterReconcile = null;
  let restoreTruth = null;
  let restoreResponseDropped = false;
  let restoreCallCount = 0;
  let finalizeTruth = null;
  let finalizeResponseDropped = false;
  let finalizeCallCount = 0;
  let acked = false;
  let ackResponseDropped = false;
  let ackCallCount = 0;
  let ackThrowsRemaining = Number.isSafeInteger(options.throwAfterAckCount)
    ? options.throwAfterAckCount
    : 0;
  const result = (authority, command, state, tokens = []) => nativeSchema.assertUndoResult({
    schema: nativeSchema.SCHEMAS.UNDO_RESULT,
    command,
    state,
    operationId: authority.request.operationId,
    artifactDigest: authority.request.artifactDigest,
    precreatePhaseDigest: authority.request.precreatePhaseDigest,
    selectionDigest: authority.request.selectionDigest,
    preparedHistoryDigest: authority.request.preparedHistoryDigest,
    tokens,
    errorCode: state === 'UNKNOWN' ? 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN' : null,
  }, authority, command);
  const commit = authority => {
    if (committedTokens) throw new Error('QUARANTINE replayed');
    committedTokens = authority.request.items.map((item, index) => {
      const quarantineBasename = `.changes-history-native-undo-quarantine.${String(index + 1).padStart(32, '0')}`;
      const receipt = nativeSchema.buildUndoReceipt(
        authority,
        index,
        quarantineBasename,
        `sha256:${String(index + 6).repeat(64).slice(0, 64)}`
      );
      const control = nativeSchema.buildUndoControl(authority, index);
      return nativeSchema.buildUndoToken(
        authority,
        index,
        receipt,
        privateRecordIdentity(nativeSchema.encodeUndoControlRecord(control, authority, index), 100 + index * 2),
        privateRecordIdentity(nativeSchema.encodeUndoReceiptRecord(receipt, authority, index), 101 + index * 2)
      );
    });
    if (typeof options.quarantinePublic === 'function') options.quarantinePublic();
  };
  return Object.freeze({
    quarantine(authority, heldFd) {
      calls.push('quarantine');
      assert(Number.isInteger(heldFd));
      commit(authority);
      if (options.throwAfterQuarantine === true) throw new Error('lost Q response');
      return result(authority, 'QUARANTINE', 'COMMITTED', committedTokens);
    },
    reconcileUndo(authority, heldFd) {
      calls.push('reconcileUndo');
      assert(Number.isInteger(heldFd));
      const output = reconcileMode === 'UNKNOWN' || restoreTruth !== null || finalizeTruth !== null
        ? result(authority, 'RECONCILE_UNDO', 'UNKNOWN')
        : !committedTokens
          ? result(authority, 'RECONCILE_UNDO', 'UNCOMMITTED')
          : result(authority, 'RECONCILE_UNDO', 'COMMITTED', committedTokens);
      if (afterReconcile !== null) {
        const callback = afterReconcile;
        afterReconcile = null;
        callback();
      }
      return output;
    },
    restoreQuarantine(settle, authority, heldFd) {
      calls.push('restoreQuarantine');
      restoreCallCount += 1;
      assert(Number.isInteger(heldFd));
      settle = nativeSchema.assertUndoSettleRequest(
        settle,
        authority,
        'RESTORE_QUARANTINE'
      );
      if (Array.isArray(options.restoreWires)) {
        options.restoreWires.push(nativeSchema.encodeUndoSettleCommand(
          settle,
          authority,
          'RESTORE_QUARANTINE'
        ));
      }
      if (options.restoreUnknown === true ||
          options.restoreUnknownAtCall === restoreCallCount) {
        return nativeSchema.assertUndoSettleResult({
          schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
          command: 'RESTORE_QUARANTINE',
          state: 'UNKNOWN',
          operationId: settle.operationId,
          finalRecord: null,
          finalRecordIdentity: null,
          errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
        }, settle, authority, 'RESTORE_QUARANTINE');
      }
      if (restoreTruth === null) {
        if (typeof options.restorePublic === 'function') options.restorePublic();
        const finalRecord = nativeSchema.buildUndoFinalRecord(
          settle,
          authority,
          'RESTORE_QUARANTINE'
        );
        const finalRecordIdentity = privateRecordIdentity(
          nativeSchema.encodeUndoFinalRecord(
            finalRecord,
            settle,
            authority,
            'RESTORE_QUARANTINE'
          ),
          900
        );
        restoreTruth = nativeSchema.assertUndoSettleResult({
          schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
          command: 'RESTORE_QUARANTINE',
          state: 'COMMITTED',
          operationId: settle.operationId,
          finalRecord,
          finalRecordIdentity,
          errorCode: null,
        }, settle, authority, 'RESTORE_QUARANTINE');
      }
      if (options.throwAfterRestore === true && !restoreResponseDropped) {
        restoreResponseDropped = true;
        throw new Error('lost B response');
      }
      if (typeof options.afterRestoreReturn === 'function') {
        options.afterRestoreReturn(restoreCallCount);
      }
      return restoreTruth;
    },
    finalizeUndo(settle, authority, heldFd) {
      calls.push('finalizeUndo');
      finalizeCallCount += 1;
      assert(Number.isInteger(heldFd));
      settle = nativeSchema.assertUndoSettleRequest(
        settle,
        authority,
        'FINALIZE_UNDO'
      );
      if (Array.isArray(options.finalizeWires)) {
        options.finalizeWires.push(nativeSchema.encodeUndoSettleCommand(
          settle,
          authority,
          'FINALIZE_UNDO'
        ));
      }
      if (options.finalizeUnknown === true ||
          options.finalizeUnknownAtCall === finalizeCallCount ||
          options.finalizeUnknownCalls?.includes(finalizeCallCount)) {
        return nativeSchema.assertUndoSettleResult({
          schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
          command: 'FINALIZE_UNDO',
          state: 'UNKNOWN',
          operationId: settle.operationId,
          finalRecord: null,
          finalRecordIdentity: null,
          errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
        }, settle, authority, 'FINALIZE_UNDO');
      }
      if (finalizeTruth === null) {
        if (typeof options.finalizePublic === 'function') options.finalizePublic();
        const finalRecord = nativeSchema.buildUndoFinalRecord(
          settle,
          authority,
          'FINALIZE_UNDO'
        );
        const finalRecordIdentity = privateRecordIdentity(
          nativeSchema.encodeUndoFinalRecord(
            finalRecord,
            settle,
            authority,
            'FINALIZE_UNDO'
          ),
          901
        );
        finalizeTruth = nativeSchema.assertUndoSettleResult({
          schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
          command: 'FINALIZE_UNDO',
          state: 'COMMITTED',
          operationId: settle.operationId,
          finalRecord,
          finalRecordIdentity,
          errorCode: null,
        }, settle, authority, 'FINALIZE_UNDO');
      }
      if (options.throwAfterFinalizeUndo === true && !finalizeResponseDropped) {
        finalizeResponseDropped = true;
        throw new Error('lost D response');
      }
      if (typeof options.afterFinalizeReturn === 'function') {
        options.afterFinalizeReturn(finalizeCallCount);
      }
      if (options.driftFinalizeIdentityAtCall === finalizeCallCount) {
        const current = finalizeTruth.finalRecordIdentity;
        const sameInode = options.driftFinalizeIdentityKind === 'same';
        return nativeSchema.assertUndoSettleResult({
          ...finalizeTruth,
          finalRecordIdentity: {
            ...current,
            ino: sameInode ? current.ino : String(Number(current.ino) + 1),
            mtimeNs: String(Number(current.mtimeNs) + 10),
            ctimeNs: String(Number(current.ctimeNs) + 10),
          },
        }, settle, authority, 'FINALIZE_UNDO');
      }
      return finalizeTruth;
    },
    ackUndo(
      ack,
      settle,
      finalRecord,
      finalRecordIdentity,
      authority,
      heldFd,
      expectedCommand
    ) {
      calls.push('ackUndo');
      ackCallCount += 1;
      assert(Number.isInteger(heldFd));
      ack = nativeSchema.assertUndoAckRequest(
        ack,
        settle,
        finalRecord,
        finalRecordIdentity,
        authority,
        expectedCommand
      );
      if (Array.isArray(options.ackWires)) {
        options.ackWires.push(nativeSchema.encodeUndoAckCommand(
          ack,
          settle,
          finalRecord,
          finalRecordIdentity,
          authority,
          expectedCommand
        ));
      }
      if (options.ackUnknown === true || options.ackUnknownAtCall === ackCallCount) {
        return nativeSchema.assertUndoAckResult({
          schema: nativeSchema.SCHEMAS.UNDO_ACK_RESULT,
          command: expectedCommand,
          state: 'UNKNOWN',
          operationId: ack.operationId,
          finalRecordDigest: ack.finalRecordDigest,
          errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
        }, ack, settle, finalRecord, finalRecordIdentity, authority, expectedCommand);
      }
      acked = true;
      if (ackThrowsRemaining > 0) {
        ackThrowsRemaining -= 1;
        throw new Error('lost committed A response');
      }
      if (options.throwAfterAck === true && !ackResponseDropped) {
        ackResponseDropped = true;
        throw new Error('lost A response');
      }
      if (typeof options.afterAckReturn === 'function') {
        options.afterAckReturn(ackCallCount);
      }
      return nativeSchema.assertUndoAckResult({
        schema: nativeSchema.SCHEMAS.UNDO_ACK_RESULT,
        command: expectedCommand,
        state: 'ACKED',
        operationId: ack.operationId,
        finalRecordDigest: ack.finalRecordDigest,
        errorCode: null,
      }, ack, settle, finalRecord, finalRecordIdentity, authority, expectedCommand);
    },
    setReconcileMode(mode) { reconcileMode = mode; },
    setAfterReconcile(callback) { afterReconcile = callback; },
    isAcked() { return acked; },
  });
}

function appliedCreatedSnapshot(item) {
  const after = state('snapshot new\n');
  const createdIdentityDigest = `sha256:${'6'.repeat(64)}`;
  const ancestorIdentityDigest = parentBinding('snapshot_restore_undo')
    .selected[0].ancestorIdentityDigest;
  const target = path.join(item.project.rootPath, 'chapters/new.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(after.data, 'base64'));
  const prepared = historyService.prepareSnapshotRestoreHistory(
    item.project.rootPath,
    [{
      path: 'chapters/new.md',
      summary: 'restore missing',
      before: absent(),
      after,
      createdIdentityDigest,
      ancestorIdentityDigest,
    }],
    provenance()
  );
  historyService.saveHistory(item.project.rootPath, prepared.preparedHistoryState.history, {
    expectedState: prepared.baseHistoryState,
  });
  return Object.freeze({ entryId: prepared.record.id, createdIdentityDigest });
}

function rewriteHistoryAncestor(rootPath, character) {
  const historyPath = path.join(rootPath, historyService.HISTORY_RELATIVE_PATH);
  const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  history.entries[0].files[0].ancestorIdentityDigest = `sha256:${character.repeat(64)}`;
  const { integrity: _integrity, ...payload } = history.entries[0];
  history.entries[0].integrity = digest(Buffer.from(JSON.stringify(payload), 'utf8'));
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  return historyPath;
}

function safeUndoSnapshotStateReader(rootPath, applied) {
  return request => {
    const file = path.join(rootPath, request.path);
    if (!fs.existsSync(file)) return { exists: false };
    const bytes = fs.readFileSync(file);
    return {
      exists: true,
      revision: digest(bytes),
      bytes,
      createdIdentityDigest: applied.createdIdentityDigest,
    };
  };
}

function missingRestoreArgs(item, overrides = {}) {
  return {
    rootPath: item.project.rootPath,
    projectId: item.project.projectId,
    files: [{
      path: 'chapters/new.md',
      summary: 'restore missing',
      before: absent(),
      after: state('snapshot new\n'),
      createdIdentityDigest: null,
    }],
    provenance: provenance(),
    parentSelectionBinding: parentBinding(),
    ...overrides,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nSnapshot public-Markdown transaction phase verification');

test('missing restore requires publicMarkdownLifecycle before History, marker or Markdown', () => {
  const item = fixture();
  let executed = 0;
  try {
    const transaction = createChangesHistoryTransaction({ projectService });
    assert.throws(() => transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: state('snapshot new\n'),
        createdIdentityDigest: null,
      }],
      provenance: provenance(),
      parentSelectionBinding: parentBinding(),
      execute() { executed += 1; },
    }), error => error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
    assert.strictEqual(executed, 0);
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath,
      '.writcraft/recovery/changes-history-transaction.json'
    )), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
  } finally { item.cleanup(); }
});

test('missing reconcileFinalize method fails before PRECREATE marker or artifact', () => {
  const item = fixture();
  const calls = [];
  try {
    const complete = dormantPublicMarkdownLifecycle(calls);
    let getterCalls = 0;
    const incomplete = {
      create: complete.create,
      createMissingJournal: complete.createMissingJournal,
      reconcile: complete.reconcile,
      verifyCreate: complete.verifyCreate,
      finalizeCreate: complete.finalizeCreate,
    };
    Object.defineProperty(incomplete, 'reconcileFinalize', {
      enumerable: true,
      get() { getterCalls += 1; return complete.reconcileFinalize; },
    });
    Object.freeze(incomplete);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: incomplete,
    });
    assert.throws(() => transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: state('snapshot new\n'),
        createdIdentityDigest: null,
      }],
      provenance: provenance(),
      parentSelectionBinding: parentBinding(),
    }), error => error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
    const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
    assert.strictEqual(fs.existsSync(path.join(recovery, 'changes-history-transaction.json')), false);
    assert.strictEqual(fs.existsSync(recovery) && fs.readdirSync(recovery)
      .some(name => name.startsWith('changes-history-chr_')), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
    assert.strictEqual(getterCalls, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo requires publicMarkdownLifecycle before marker or quarantine', () => {
  const item = fixture();
  try {
    const applied = appliedCreatedSnapshot(item);
    const transaction = createChangesHistoryTransaction({ projectService });
    assert.throws(() => transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    }), error => error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath,
      '.writcraft/recovery/changes-history-transaction.json'
    )), false);
  } finally { item.cleanup(); }
});

test('Safe Undo rejects reconcileUndo accessor before marker with zero getter calls', () => {
  const item = fixture();
  const calls = [];
  let getterCalls = 0;
  try {
    const applied = appliedCreatedSnapshot(item);
    const complete = exactOnceUndoLifecycle(calls);
    const hostile = {
      quarantine: complete.quarantine,
      restoreQuarantine: complete.restoreQuarantine,
      finalizeUndo: complete.finalizeUndo,
      ackUndo: complete.ackUndo,
    };
    Object.defineProperty(hostile, 'reconcileUndo', {
      enumerable: true,
      get() { getterCalls += 1; return complete.reconcileUndo; },
    });
    Object.freeze(hostile);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: hostile,
    });
    assert.throws(() => transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    }), error => error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
    assert.strictEqual(getterCalls, 0);
    assert.deepStrictEqual(calls, []);
    const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
    assert.strictEqual(fs.existsSync(path.join(
      recovery,
      'changes-history-transaction.json'
    )), false);
    assert.strictEqual(fs.existsSync(recovery) && fs.readdirSync(recovery)
      .some(name => name.startsWith('changes-history-chr_')), false);
  } finally { item.cleanup(); }
});

test('Safe Undo rebuilds complete parent and ancestor authority only from sealed History entryId', () => {
  const item = fixture();
  try {
    const applied = appliedCreatedSnapshot(item);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: exactOnceUndoLifecycle([]),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const historyFile = historyService.loadHistory(item.project.rootPath).entries[0].files[0];
    assert.deepStrictEqual(prepared.parentSelectionBinding, {
      schema: phaseSchema.SELECTION_SCHEMA,
      kind: 'snapshot_restore_undo',
      selected: [{
        selectedId: 'selected_missing',
        action: 'CREATED',
        path: historyFile.path,
        revision: historyFile.after.revision,
        ancestorIdentityDigest: historyFile.ancestorIdentityDigest,
      }],
    });
  } finally { item.cleanup(); }
});

test('Safe Undo rejects top-level accessor and extra authority with zero getter or lifecycle calls', () => {
  const item = fixture();
  const calls = [];
  let getterCalls = 0;
  try {
    const applied = appliedCreatedSnapshot(item);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls),
    });
    const accessor = {
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
    };
    Object.defineProperty(accessor, 'entryId', {
      enumerable: true,
      get() { getterCalls += 1; return applied.entryId; },
    });
    assert.throws(() => transaction.prepareSnapshotRestoreUndo(accessor),
      error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.throws(() => transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
      parentSelectionBinding: parentBinding('snapshot_restore_undo'),
    }), error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.strictEqual(getterCalls, 0);
    assert.deepStrictEqual(calls, []);
  } finally { item.cleanup(); }
});

test('Safe Undo publishes PRECREATE then Q/fresh-R CASes exact QUARANTINED without History write', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    assert.strictEqual(marker.publicMarkdownPhase.phase, 'PRECREATE');
    assert.strictEqual(marker.publicMarkdownPhase.items[0].createdIdentityDigest,
      applied.createdIdentityDigest);
    assert.match(marker.publicMarkdownPhase.preparedHistoryDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    const quarantined = transaction.quarantineSnapshotRestoreUndo(prepared, marker);
    assert.strictEqual(quarantined.publicMarkdownPhase.phase, 'QUARANTINED');
    assert.match(quarantined.publicMarkdownPhase.items[0].quarantineReceiptDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    assert.deepStrictEqual(calls, ['quarantine', 'reconcileUndo', 'reconcileUndo']);
    assert(!calls.includes('restoreQuarantine') && !calls.includes('finalizeUndo'));
  } finally { item.cleanup(); }
});

test('Safe Undo rejects valid semantic History authority drift before Q with zero lifecycle calls', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    rewriteHistoryAncestor(item.project.rootPath, '9');
    assert.strictEqual(
      historyService.loadHistory(item.project.rootPath).entries[0].files[0].ancestorIdentityDigest,
      `sha256:${'9'.repeat(64)}`
    );
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'PRECREATE');
  } finally { item.cleanup(); }
});

test('Safe Undo rejects valid History drift injected by the first fresh R callback', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    lifecycle.setAfterReconcile(() => rewriteHistoryAncestor(item.project.rootPath, '8'));
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    assert.deepStrictEqual(calls, ['quarantine', 'reconcileUndo']);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'PRECREATE');
  } finally { item.cleanup(); }
});

test('Safe Undo rechecks valid History drift in the marker-CAS fresh R window', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    lifecycle.setAfterReconcile(() => lifecycle.setAfterReconcile(() =>
      rewriteHistoryAncestor(item.project.rootPath, '7')));
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    assert.deepStrictEqual(calls, ['quarantine', 'reconcileUndo', 'reconcileUndo']);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'PRECREATE');
  } finally { item.cleanup(); }
});

test('Safe Undo rejects raw-only History serialization drift before Q with zero lifecycle calls', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    const historyPath = path.join(item.project.rootPath, historyService.HISTORY_RELATIVE_PATH);
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    fs.writeFileSync(historyPath, JSON.stringify(history));
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    assert.deepStrictEqual(calls, []);
  } finally { item.cleanup(); }
});

test('lost Q response converges only through fresh R and never invokes Q twice', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls, { throwAfterQuarantine: true });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    const quarantined = transaction.quarantineSnapshotRestoreUndo(prepared, marker);
    assert.strictEqual(quarantined.publicMarkdownPhase.phase, 'QUARANTINED');
    transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(calls.filter(call => call === 'quarantine').length, 1);
    assert(calls.filter(call => call === 'reconcileUndo').length >= 2);
  } finally { item.cleanup(); }
});

test('Q UNKNOWN leaves latched PRECREATE and every retry is R-only with zero History mutation', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls, { reconcileMode: 'UNKNOWN' });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.preparePublicMarkdownUndoMarker(prepared);
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const latched = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(latched.publicMarkdownPhase.phase, 'PRECREATE');
    assert.strictEqual(latched.recoveryWritePending, true);
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, latched),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    assert.strictEqual(calls.filter(call => call === 'quarantine').length, 1);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    assert(!calls.includes('restoreQuarantine') && !calls.includes('finalizeUndo'));
  } finally { item.cleanup(); }
});

test('Safe Undo fresh R rejects same-byte marker replacement before returning QUARANTINED', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const lifecycle = exactOnceUndoLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const precreate = transaction.preparePublicMarkdownUndoMarker(prepared);
    transaction.quarantineSnapshotRestoreUndo(prepared, precreate);
    const markerPath = path.join(
      item.project.rootPath,
      '.writcraft/recovery/changes-history-transaction.json'
    );
    lifecycle.setAfterReconcile(() => {
      const replacement = `${markerPath}.replacement`;
      fs.writeFileSync(replacement, fs.readFileSync(markerPath), { flag: 'wx', mode: 0o600 });
      fs.renameSync(replacement, markerPath);
    });
    const before = calls.length;
    assert.throws(
      () => transaction.reconciliation.query(item.project.rootPath, item.project.projectId),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    assert.deepStrictEqual(calls.slice(before), ['reconcileUndo']);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'QUARANTINED');
  } finally { item.cleanup(); }
});

test('Safe Undo fresh R rejects same-path project-root replacement and preserves both marker trees', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const precreate = transaction.preparePublicMarkdownUndoMarker(prepared);
    const movedRoot = `${item.project.rootPath}.held`;
    lifecycle.setAfterReconcile(() => {
      fs.renameSync(item.project.rootPath, movedRoot);
      fs.cpSync(movedRoot, item.project.rootPath, { recursive: true });
      fs.chmodSync(path.join(item.project.rootPath, '.writcraft/recovery'), 0o700);
    });
    assert.throws(
      () => transaction.quarantineSnapshotRestoreUndo(prepared, precreate),
      error => error?.code === 'CHANGES_RECOVERY_STALE'
    );
    const markerRelative = '.writcraft/recovery/changes-history-transaction.json';
    assert.strictEqual(fs.existsSync(path.join(movedRoot, markerRelative)), true);
    assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, markerRelative)), true);
    assert.deepStrictEqual(calls.filter(call =>
      call === 'quarantine' || call === 'reconcileUndo'
    ), ['quarantine', 'reconcileUndo']);
  } finally { item.cleanup(); }
});

test('Safe Undo exposes the isolated prepared-History commit boundary', () => {
  const reconciliation = createChangesHistoryReconciliationService({ projectService });
  assert.strictEqual(typeof reconciliation.commitSnapshotRestoreUndoHistory, 'function');
});

test('Safe Undo QUARANTINED commits exact artifact-materialized undone History only', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
      options: { undoneAt: '2026-08-09T03:04:05.000Z' },
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const committed = transaction.commitSnapshotRestoreUndoHistory(prepared, quarantined);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(committed.publicMarkdownUndoSettlement, undefined);
    assert.strictEqual(fs.existsSync(publicFile), false);
    const record = historyService.loadHistory(item.project.rootPath).entries[0];
    assert.strictEqual(record.status, 'undone');
    assert.strictEqual(record.undoneAt, '2026-08-09T03:04:05.000Z');
    assert.strictEqual(record.files[0].ancestorIdentityDigest,
      prepared.historyPrepared.record.files[0].ancestorIdentityDigest);
    assert.strictEqual(record.provenance.snapshotId,
      prepared.historyPrepared.record.provenance.snapshotId);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 0);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 0);
    const beforeQuery = [...calls];
    transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.deepStrictEqual(calls, beforeQuery);
  } finally { item.cleanup(); }
});

test('Safe Undo History temp, file-fsync and rename failures retain QUARANTINED base truth', () => {
  for (const fault of ['partial', 'file-fsync', 'rename']) {
    const item = fixture();
    const calls = [];
    const originalWriteFile = fs.writeFileSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const quarantined = transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      );
      let injected = false;
      if (fault === 'partial') {
        fs.writeFileSync = (target, data, ...rest) => {
          if (!injected && typeof target === 'number' && typeof data === 'string' &&
              data.includes('"writcraft.changes/v4"')) {
            injected = true;
            originalWriteFile(target, data.slice(0, Math.max(1, Math.floor(data.length / 2))), ...rest);
            throw new Error('injected Safe Undo partial History write');
          }
          return originalWriteFile(target, data, ...rest);
        };
      } else if (fault === 'file-fsync') {
        fs.fsyncSync = fd => {
          if (!injected && fs.fstatSync(fd).isFile()) {
            injected = true;
            throw new Error('injected Safe Undo History file fsync');
          }
          return originalFsync(fd);
        };
      } else {
        fs.renameSync = (source, destination) => {
          if (!injected && destination ===
              path.join(item.project.rootPath, '.writcraft/changes.json')) {
            injected = true;
            throw new Error('injected Safe Undo History rename');
          }
          return originalRename(source, destination);
        };
      }
      assert.throws(() =>
        transaction.commitSnapshotRestoreUndoHistory(prepared, quarantined));
      fs.writeFileSync = originalWriteFile;
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
      assert.strictEqual(injected, true);
      assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'QUARANTINED');
      assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
      assert.strictEqual(fs.existsSync(publicFile), false);
      assert.strictEqual(calls.filter(call => ['restoreQuarantine', 'finalizeUndo', 'ackUndo']
        .includes(call)).length, 0);
    } finally {
      fs.writeFileSync = originalWriteFile;
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
      item.cleanup();
    }
  }
});

test('Safe Undo History parent fsync failure is retried before HISTORY_COMMITTED', () => {
  const item = fixture();
  const calls = [];
  const originalFsync = fs.fsyncSync;
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const parentStat = fs.lstatSync(path.join(item.project.rootPath, '.writcraft'), {
      bigint: true,
    });
    let attempts = 0;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev === parentStat.dev && stat.ino === parentStat.ino) {
        attempts += 1;
        if (attempts === 1) throw new Error('lost Safe Undo History parent fsync response');
      }
      return originalFsync(fd);
    };
    const committed = transaction.commitSnapshotRestoreUndoHistory(prepared, quarantined);
    fs.fsyncSync = originalFsync;
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert(attempts >= 3);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'undone');
    assert.strictEqual(fs.existsSync(publicFile), false);
  } finally {
    fs.fsyncSync = originalFsync;
    item.cleanup();
  }
});

test('Safe Undo prepared History restart converges pre-CAS marker rename and recovery-fsync response loss', () => {
  for (const fault of ['marker-rename', 'recovery-fsync']) {
    const item = fixture();
    const calls = [];
    const originalFsync = fs.fsyncSync;
    let markerRenames = 0;
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      });
      const options = {
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
        beforeMarkerRename() {
          markerRenames += 1;
          if (fault === 'marker-rename' && markerRenames === 4) {
            throw new Error('lost Safe Undo HISTORY_COMMITTED marker rename');
          }
        },
      };
      const reconciliation = createChangesHistoryReconciliationService(options);
      const transaction = createChangesHistoryTransaction({
        ...options,
        reconciliationService: reconciliation,
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const quarantined = transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      );
      let fsyncInjected = false;
      if (fault === 'recovery-fsync') {
        const recoveryStat = fs.lstatSync(
          path.join(item.project.rootPath, '.writcraft/recovery'),
          { bigint: true }
        );
        fs.fsyncSync = fd => {
          const stat = fs.fstatSync(fd, { bigint: true });
          if (!fsyncInjected && stat.dev === recoveryStat.dev && stat.ino === recoveryStat.ino) {
            fsyncInjected = true;
            throw new Error('lost Safe Undo marker recovery fsync response');
          }
          return originalFsync(fd);
        };
      }
      assert.throws(() =>
        transaction.commitSnapshotRestoreUndoHistory(prepared, quarantined));
      fs.fsyncSync = originalFsync;
      assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'undone');
      const restarted = createChangesHistoryReconciliationService({
        ...options,
        beforeMarkerRename: undefined,
      });
      restarted.query(item.project.rootPath, item.project.projectId);
      assert.strictEqual(restarted.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.strictEqual(fs.existsSync(publicFile), false);
      assert.strictEqual(calls.filter(call => ['restoreQuarantine', 'finalizeUndo', 'ackUndo']
        .includes(call)).length, 0);
    } finally {
      fs.fsyncSync = originalFsync;
      item.cleanup();
    }
  }
});

test('Safe Undo committed-marker restart retries the same recovery fsync and stays locked on repeat failure', () => {
  for (const failUntil of [1, 2]) {
    const item = fixture();
    const calls = [];
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      });
      const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
      let recoveryStat = null;
      const fileSystem = Object.create(fs);
      let armed = false;
      let attempts = 0;
      fileSystem.fsyncSync = fd => {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (armed && recoveryStat && stat.dev === recoveryStat.dev &&
            stat.ino === recoveryStat.ino) {
          attempts += 1;
          if (attempts <= failUntil) {
            throw new Error('injected committed marker recovery fsync loss');
          }
        }
        return fs.fsyncSync(fd);
      };
      const options = {
        projectService,
        fileSystem,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      };
      const reconciliation = createChangesHistoryReconciliationService(options);
      const transaction = createChangesHistoryTransaction({
        ...options,
        reconciliationService: reconciliation,
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const quarantined = transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      );
      recoveryStat = fs.lstatSync(recovery, { bigint: true });
      armed = true;
      assert.throws(
        () => transaction.commitSnapshotRestoreUndoHistory(prepared, quarantined),
        error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
      );
      assert.strictEqual(reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      const restarted = createChangesHistoryReconciliationService(options);
      if (failUntil === 1) {
        restarted.query(item.project.rootPath, item.project.projectId);
        assert.strictEqual(attempts, 2);
      } else {
        assert.throws(
          () => restarted.query(item.project.rootPath, item.project.projectId),
          error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
        );
        assert.strictEqual(attempts, 2);
        assert.strictEqual(restarted.readMarker(item.project.rootPath)
          .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      }
      assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'undone');
      assert.strictEqual(fs.existsSync(publicFile), false);
      assert.strictEqual(calls.filter(call => ['restoreQuarantine', 'finalizeUndo', 'ackUndo']
        .includes(call)).length, 0);
    } finally { item.cleanup(); }
  }
});

test('Safe Undo committed durability preserves hostile marker, root and recovery replacements', () => {
  for (const attack of ['marker', 'root', 'recovery']) {
    const item = fixture();
    const calls = [];
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      });
      const baseOptions = {
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      };
      const transaction = createChangesHistoryTransaction(baseOptions);
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const committed = transaction.commitSnapshotRestoreUndoHistory(
        prepared,
        transaction.quarantineSnapshotRestoreUndo(
          prepared,
          transaction.preparePublicMarkdownUndoMarker(prepared)
        )
      );
      assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      const markerRelative = '.writcraft/recovery/changes-history-transaction.json';
      let movedRoot = null;
      let movedRecovery = null;
      let attacked = false;
      const restarted = createChangesHistoryReconciliationService({
        ...baseOptions,
        beforeMarkerDurabilityFsync() {
          if (attacked) return;
          attacked = true;
          const markerPath = path.join(item.project.rootPath, markerRelative);
          if (attack === 'marker') {
            const replacement = `${markerPath}.replacement`;
            fs.writeFileSync(replacement, fs.readFileSync(markerPath), { flag: 'wx', mode: 0o600 });
            fs.renameSync(replacement, markerPath);
          } else if (attack === 'root') {
            movedRoot = `${item.project.rootPath}.durability-held`;
            fs.renameSync(item.project.rootPath, movedRoot);
            fs.cpSync(movedRoot, item.project.rootPath, { recursive: true });
            fs.chmodSync(path.join(item.project.rootPath, '.writcraft/recovery'), 0o700);
          } else {
            const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
            movedRecovery = path.join(item.project.rootPath, '.writcraft/recovery-held');
            fs.renameSync(recovery, movedRecovery);
            fs.cpSync(movedRecovery, recovery, { recursive: true });
            fs.chmodSync(recovery, 0o700);
          }
        },
      });
      assert.throws(
        () => restarted.query(item.project.rootPath, item.project.projectId),
        error => ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED']
          .includes(error?.code)
      );
      assert.strictEqual(attacked, true);
      assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, markerRelative)), true);
      if (movedRoot) assert.strictEqual(fs.existsSync(path.join(movedRoot, markerRelative)), true);
      if (movedRecovery) {
        assert.strictEqual(fs.existsSync(
          path.join(movedRecovery, 'changes-history-transaction.json')
        ), true);
      }
      assert.strictEqual(fs.existsSync(publicFile), false);
      assert.strictEqual(calls.filter(call => ['restoreQuarantine', 'finalizeUndo', 'ackUndo']
        .includes(call)).length, 0);
    } finally { item.cleanup(); }
  }
});

test('Safe Undo History mainline rejects raw, signed ancestor, Q receipt and B-branch drift', () => {
  for (const drift of ['raw-minify', 'ancestor-resign', 'q-unknown', 'settlement']) {
    const item = fixture();
    const calls = [];
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
        restoreUnknown: drift === 'settlement',
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      let marker = transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      );
      if (drift === 'raw-minify') {
        const file = path.join(item.project.rootPath, '.writcraft/changes.json');
        fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))));
      } else if (drift === 'ancestor-resign') {
        const current = historyService.loadHistory(item.project.rootPath);
        const record = current.entries[0];
        const { integrity: _integrity, ...payload } = record;
        const changed = {
          ...payload,
          files: payload.files.map(file => ({
            ...file,
            ancestorIdentityDigest: `sha256:${'f'.repeat(64)}`,
          })),
        };
        const signed = {
          ...changed,
          integrity: crypto.createHash('sha256').update(JSON.stringify(changed)).digest('hex'),
        };
        historyService.saveHistory(item.project.rootPath, {
          schema: historyService.HISTORY_SCHEMA,
          entries: [signed],
        });
      } else if (drift === 'q-unknown') {
        lifecycle.setReconcileMode('UNKNOWN');
      } else {
        assert.throws(() => transaction.reconciliation.restoreSnapshotRestoreUndo(
          item.project.rootPath,
          item.project.projectId,
          marker.operationId
        ));
        marker = transaction.reconciliation.readMarker(item.project.rootPath);
        assert.strictEqual(marker.publicMarkdownUndoSettlement.state, 'PREPARED');
      }
      assert.throws(
        () => transaction.reconciliation.commitSnapshotRestoreUndoHistory(
          item.project.rootPath,
          item.project.projectId,
          marker.operationId
        ),
        error => ['CHANGES_MANUAL_RECOVERY_REQUIRED', 'CHANGES_RECOVERY_CONFLICT']
          .includes(error?.code)
      );
      assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
      assert.strictEqual(fs.existsSync(publicFile), false);
      assert.strictEqual(calls.filter(call => ['finalizeUndo', 'ackUndo'].includes(call)).length, 0);
    } finally { item.cleanup(); }
  }
});

test('Safe Undo B response loss reaches RESTORED, ACKs and exact-cleans without History or D', () => {
  const item = fixture();
  const calls = [];
  const restoreWires = [];
  const ackWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      throwAfterRestore: true,
      throwAfterAck: true,
      restoreWires,
      ackWires,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const precreate = transaction.preparePublicMarkdownUndoMarker(prepared);
    const quarantined = transaction.quarantineSnapshotRestoreUndo(prepared, precreate);
    assert.strictEqual(fs.existsSync(publicFile), false);
    const terminal = transaction.restoreSnapshotRestoreUndo(prepared, quarantined);
    assert.strictEqual(terminal.state, 'terminal');
    assert.strictEqual(terminal.outcome, 'zero_write_error');
    assert.strictEqual(terminal.publicMarkdownPhase.phase, 'RESTORED');
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 3);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 3);
    assert.strictEqual(new Set(restoreWires).size, 1);
    assert.strictEqual(new Set(ackWires).size, 1);
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 0);
    assert(calls.includes('artifactCleanup') && calls.includes('artifactAcknowledge'));
    assert(calls.includes('markerClear'));
    assert.strictEqual(lifecycle.isAcked(), true);
  } finally { item.cleanup(); }
});

test('Safe Undo B pre-CAS UNKNOWN stops at three identical calls and retains PREPARED authority', () => {
  const item = fixture();
  const calls = [];
  const restoreWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      throwAfterRestore: true,
      restoreUnknownAtCall: 3,
      restoreWires,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    assert.throws(
      () => transaction.reconciliation.restoreSnapshotRestoreUndo(
        item.project.rootPath,
        item.project.projectId,
        quarantined.operationId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'QUARANTINED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'PREPARED');
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 3);
    assert.strictEqual(new Set(restoreWires).size, 1);
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
  } finally { item.cleanup(); }
});

test('Safe Undo B rejects same-path recovery replacement after adapter return and preserves records', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
    const heldRecovery = path.join(item.project.rootPath, '.writcraft/recovery-held');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      afterRestoreReturn(callCount) {
        if (callCount !== 1) return;
        fs.renameSync(recovery, heldRecovery);
        fs.cpSync(heldRecovery, recovery, { recursive: true });
        fs.chmodSync(recovery, 0o700);
      },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    assert.throws(
      () => transaction.reconciliation.restoreSnapshotRestoreUndo(
        item.project.rootPath,
        item.project.projectId,
        quarantined.operationId
      ),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const markerName = 'changes-history-transaction.json';
    assert.strictEqual(fs.existsSync(path.join(heldRecovery, markerName)), true);
    assert.strictEqual(fs.existsSync(path.join(recovery, markerName)), true);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 1);
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
  } finally { item.cleanup(); }
});

test('Safe Undo B UNKNOWN retains QUARANTINED PREPARED settlement and exact base History', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restoreUnknown: true,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    assert.throws(
      () => transaction.restoreSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'QUARANTINED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'PREPARED');
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 2);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 0);
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 0);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    assert.strictEqual(fs.existsSync(publicFile), false);
  } finally { item.cleanup(); }
});

test('Safe Undo B fails before settlement or native mutation when exact marker cleanup is absent', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    assert.throws(
      () => transaction.restoreSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'MARKER_CLEAR_UNAVAILABLE'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'QUARANTINED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement, undefined);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    assert.strictEqual(fs.existsSync(publicFile), false);
  } finally { item.cleanup(); }
});

test('Safe Undo PREPARED marker persist failure makes zero B calls and retains null settlement', () => {
  const item = fixture();
  const calls = [];
  let failPreparedPersist = false;
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
    });
    const shared = {
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    };
    const reconciliation = createChangesHistoryReconciliationService({
      ...shared,
      beforeMarkerRename() {
        if (failPreparedPersist) {
          throw Object.assign(new Error('settlement marker rename blocked'), { code: 'EIO' });
        }
      },
    });
    const transaction = createChangesHistoryTransaction({
      ...shared,
      reconciliationService: reconciliation,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const marker = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    failPreparedPersist = true;
    assert.throws(
      () => transaction.restoreSnapshotRestoreUndo(prepared, marker),
      error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
    );
    const retained = reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'QUARANTINED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement, undefined);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    assert.strictEqual(fs.existsSync(publicFile), false);
  } finally { item.cleanup(); }
});

test('Safe Undo RESTORED restart uses stored settlement for A then exact artifact and marker cleanup', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
    });
    const artifactLifecycle = durableFakeArtifactLifecycle(calls);
    const markerLifecycle = trustedFakeMarkerLifecycle(calls);
    const options = {
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      exactMarkerLifecycle: markerLifecycle,
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    };
    const transaction = createChangesHistoryTransaction(options);
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const restored = transaction.reconciliation.restoreSnapshotRestoreUndo(
      item.project.rootPath,
      item.project.projectId,
      quarantined.operationId
    );
    assert.strictEqual(restored.publicMarkdownPhase.phase, 'RESTORED');
    assert.strictEqual(restored.publicMarkdownUndoSettlement.state, 'COMMITTED');
    assert.strictEqual(lifecycle.isAcked(), false);
    const restarted = createChangesHistoryReconciliationService(options);
    assert.deepStrictEqual(restarted.query(item.project.rootPath, item.project.projectId), {
      ok: true,
      recovery: null,
    });
    assert.strictEqual(lifecycle.isAcked(), true);
    assert.strictEqual(restarted.hasPending(item.project.rootPath), false);
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo A UNKNOWN retains restartable RESTORED marker, artifact and complete token authority', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      ackUnknown: true,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const restored = transaction.reconciliation.restoreSnapshotRestoreUndo(
      item.project.rootPath,
      item.project.projectId,
      quarantined.operationId
    );
    const artifactPath = path.join(
      item.project.rootPath,
      '.writcraft/recovery',
      restored.artifact.basename
    );
    assert.throws(
      () => transaction.reconciliation.finish(item.project.rootPath, restored.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.state, 'applying');
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'RESTORED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'COMMITTED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.settleRequest.tokens.length, 1);
    assert.strictEqual(fs.existsSync(artifactPath), true);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 2);
    assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 0);
    assert.strictEqual(calls.filter(call => call === 'markerClear').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo A pre-CAS UNKNOWN stops at three identical calls and retains RESTORED authority', () => {
  const item = fixture();
  const calls = [];
  const ackWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      throwAfterAck: true,
      ackUnknownAtCall: 3,
      ackWires,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const restored = transaction.reconciliation.restoreSnapshotRestoreUndo(
      item.project.rootPath,
      item.project.projectId,
      quarantined.operationId
    );
    assert.throws(
      () => transaction.reconciliation.finish(item.project.rootPath, restored.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.state, 'applying');
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'RESTORED');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'COMMITTED');
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 3);
    assert.strictEqual(new Set(ackWires).size, 1);
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'applied');
  } finally { item.cleanup(); }
});

test('Safe Undo A rejects same-path project-root replacement after adapter return and preserves records', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const movedRoot = `${item.project.rootPath}.ack-held`;
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
      afterAckReturn(callCount) {
        if (callCount !== 1) return;
        fs.renameSync(item.project.rootPath, movedRoot);
        fs.cpSync(movedRoot, item.project.rootPath, { recursive: true });
        fs.chmodSync(path.join(item.project.rootPath, '.writcraft/recovery'), 0o700);
      },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const restored = transaction.reconciliation.restoreSnapshotRestoreUndo(
      item.project.rootPath,
      item.project.projectId,
      quarantined.operationId
    );
    assert.throws(
      () => transaction.reconciliation.finish(item.project.rootPath, restored.operationId),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const markerRelative = '.writcraft/recovery/changes-history-transaction.json';
    assert.strictEqual(fs.existsSync(path.join(movedRoot, markerRelative)), true);
    assert.strictEqual(fs.existsSync(path.join(item.project.rootPath, markerRelative)), true);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 1);
    assert.strictEqual(fs.readFileSync(path.join(movedRoot, 'chapters/new.md'), 'utf8'), 'snapshot new\n');
  } finally { item.cleanup(); }
});

test('Safe Undo artifact-cleanup response loss retains terminal settlement and restart clears exactly', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      restorePublic() {
        fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
      },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls, {
        throwAfterCleanup: true,
      }),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    assert.throws(
      () => transaction.restoreSnapshotRestoreUndo(prepared, quarantined),
      error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.state, 'terminal');
    assert.strictEqual(retained.outcome, 'zero_write_error');
    assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'COMMITTED');
    assert.deepStrictEqual(
      transaction.reconciliation.query(item.project.rootPath, item.project.projectId),
      { ok: true, recovery: null }
    );
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
  } finally { item.cleanup(); }
});

test('Safe Undo exact marker clear preserves same-byte new-inode and same-inode foreign RESTORED marker', () => {
  for (const replacement of ['new-inode', 'same-inode']) {
    const item = fixture();
    const calls = [];
    let attack = true;
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
        restorePublic() {
          fs.writeFileSync(publicFile, 'snapshot new\n', { flag: 'wx', mode: 0o600 });
        },
      });
      const shared = {
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      };
      const reconciliation = createChangesHistoryReconciliationService({
        ...shared,
        beforeClear(location) {
          if (!attack) return;
          attack = false;
          const bytes = fs.readFileSync(location.file);
          if (replacement === 'new-inode') {
            const temporary = `${location.file}.foreign`;
            fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, location.file);
          } else {
            fs.writeFileSync(location.file, bytes);
          }
        },
      });
      const transaction = createChangesHistoryTransaction({
        ...shared,
        reconciliationService: reconciliation,
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const quarantined = transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      );
      assert.throws(
        () => transaction.restoreSnapshotRestoreUndo(prepared, quarantined),
        error => error?.code === 'CHANGES_RECOVERY_STALE'
      );
      const retained = reconciliation.readMarker(item.project.rootPath);
      assert.strictEqual(retained.state, 'terminal');
      assert.strictEqual(retained.publicMarkdownPhase.phase, 'RESTORED');
      assert.strictEqual(retained.publicMarkdownUndoSettlement.state, 'COMMITTED');
      assert.strictEqual(fs.readFileSync(publicFile, 'utf8'), 'snapshot new\n');
    } finally { item.cleanup(); }
  }
});

test('missing restore durably publishes one PRECREATE marker/artifact and restart reads it without mutation replay', () => {
  const item = fixture();
  const calls = [];
  const artifactLifecycle = trustedFakeArtifactLifecycle();
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: dormantPublicMarkdownLifecycle(calls),
    });
    const prepared = transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: state('snapshot new\n'),
        createdIdentityDigest: null,
      }],
      provenance: provenance(),
      parentSelectionBinding: parentBinding(),
    });
    const marker = transaction.preparePublicMarkdownMarker(prepared);
    assert.strictEqual(marker.publicMarkdownPhase.phase, 'PRECREATE');
    assert.strictEqual(marker.publicMarkdownPhase.items[0].createdIdentityDigest, null);
    assert.strictEqual(marker.preparedHistoryState, null);
    assert.strictEqual(marker.artifact.schema, 'writcraft.changes-history-recovery-artifact/v2');
    assert.deepStrictEqual(calls, []);

    const restartedService = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: dormantPublicMarkdownLifecycle(calls),
    });
    const restarted = restartedService.readMarker(item.project.rootPath);
    assert.strictEqual(restarted.operationId, marker.operationId);
    assert.strictEqual(restarted.integrity, marker.integrity);
    assert.strictEqual(restarted.publicMarkdownPhase.phase, 'PRECREATE');
    assert.deepStrictEqual(calls, []);
    const queried = restartedService.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(queried.recovery.state, 'applying');
    assert.strictEqual(
      restartedService.readMarker(item.project.rootPath).publicMarkdownPhase.phase,
      'PRECREATE'
    );
    assert.deepStrictEqual(calls, ['reconcile']);

    const artifact = recoveryArtifact.inspectSnapshotArtifact(
      path.join(item.project.rootPath, '.writcraft/recovery'),
      restarted.artifact,
      () => {},
      { includeHistory: true }
    );
    const template = historyService.validateSnapshotRestoreHistoryTemplate(
      JSON.parse(artifact.preparedDelta.bytes.toString('utf8'))
    );
    assert.strictEqual(template.files[0].createdIdentityDigest, null);
    assert.strictEqual(
      restarted.artifact.historyTemplateDigest,
      prepared.historyPrepared.historyTemplateDigest.slice(7)
    );
  } finally { item.cleanup(); }
});

test('initial CREATE mutates once and CAS-persists typed CREATED_RECEIPT without History write', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const marker = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, marker);
    assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.match(created.publicMarkdownPhase.items[0].createdIdentityDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(created.publicMarkdownPhase.items[0].creationReceiptDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(created.publicMarkdownPhase.preparedHistoryDigest, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(created.preparedHistoryState.digest,
      created.publicMarkdownPhase.preparedHistoryDigest.slice(7));
    assert.deepStrictEqual(calls, ['create', 'verifyCreate', 'verifyCreate']);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
    transaction.createMissingLeaves(prepared, created);
    assert.deepStrictEqual(calls, ['create', 'verifyCreate', 'verifyCreate']);
  } finally { item.cleanup(); }
});

test('CREATED_RECEIPT commits deterministic History and advances HISTORY_COMMITTED without body replay', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    const history = historyService.loadHistory(item.project.rootPath);
    assert.strictEqual(history.entries.length, 1);
    assert.strictEqual(history.entries[0].files[0].createdIdentityDigest,
      created.publicMarkdownPhase.items[0].createdIdentityDigest);
    assert.deepStrictEqual(calls, ['create', 'verifyCreate', 'verifyCreate']);
  } finally { item.cleanup(); }
});

test('HISTORY_COMMITTED finalizes exact create receipts once and CAS-persists FINALIZED', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    const callsBefore = [...calls];
    const finalized = transaction.finalizeMissingRestore(prepared, committed);
    assert.strictEqual(finalized.publicMarkdownPhase.phase, 'FINALIZED');
    assert.match(finalized.publicMarkdownPhase.finalReceiptDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepStrictEqual(calls.slice(callsBefore.length), [
      'reconcileFinalize', 'finalizeCreate', 'reconcileFinalize',
    ]);
    transaction.finalizeMissingRestore(prepared, finalized);
    assert.deepStrictEqual(calls.slice(callsBefore.length), [
      'reconcileFinalize', 'finalizeCreate', 'reconcileFinalize',
    ]);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
  } finally { item.cleanup(); }
});

test('Snapshot finalize and clear retain LEGACY marker compatibility without journal writes', () => {
  const item = fixture();
  const calls = [];
  try {
    const recovery = path.join(item.project.rootPath, '.writcraft', 'recovery');
    const lifecycle = exactOnceCreateLifecycle(calls, {
      finalRecordDirectory: recovery,
    });
    const legacyShared = {
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
    };
    const legacyTransaction = createChangesHistoryTransaction(legacyShared);
    const prepared = legacyTransaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = legacyTransaction.preparePublicMarkdownMarker(prepared);
    const created = legacyTransaction.createMissingLeaves(prepared, precreate);
    const committed = legacyTransaction.commitMissingRestoreHistory(prepared, created);
    const markerJournalLifecycle = legacyMarkerJournalLifecycle(
      calls,
      item.project.rootPath
    );
    const restartedShared = {
      ...legacyShared,
      markerJournalLifecycle,
    };
    const reconciliation = createChangesHistoryReconciliationService(restartedShared);
    const transaction = createChangesHistoryTransaction({
      ...restartedShared,
      reconciliationService: reconciliation,
    });
    const finalized = transaction.finalizeMissingRestore(prepared, committed);
    assert.strictEqual(finalized.publicMarkdownPhase.phase, 'FINALIZED');
    const queried = reconciliation.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(queried.recovery.state, 'terminal');
    assert.strictEqual(queried.recovery.outcome, 'applied');
    assert.deepStrictEqual(reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      finalized.operationId
    ), { ok: true, operationId: finalized.operationId });
    assert.strictEqual(reconciliation.readMarker(item.project.rootPath), null);
    assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, 1);
    assert.strictEqual(calls.filter(call => call === 'markerClear').length, 1);
    assert.strictEqual(calls.filter(call => call === 'journalInitialize').length, 0);
    assert.strictEqual(calls.filter(call => call === 'journalRead').length, 0);
    assert.strictEqual(calls.filter(call => call === 'journalAppend').length, 0);
    assert(calls.filter(call => call === 'journalDiscoverLegacy').length > 0);
  } finally { item.cleanup(); }
});

test('single missing-restore transaction closes PRECREATE through exact terminal cleanup', () => {
  const item = fixture();
  const calls = [];
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls),
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const result = transaction.executeMissingSnapshotRestore(prepared);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'applied');
    assert.strictEqual(Object.hasOwn(result, 'responseRecovered'), false);
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
    assert.strictEqual(calls.filter(call => call === 'create').length, 1);
    assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, 1);
    assert.strictEqual(calls.filter(call => call === 'markerClear').length, 1);
  } finally { item.cleanup(); }
});

test('single missing-restore transaction reconciles lost CREATE response without replay', () => {
  const item = fixture();
  const calls = [];
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls, { throwAfterCreate: true }),
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const result = transaction.executeMissingSnapshotRestore(prepared);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.outcome, 'applied');
    assert.strictEqual(result.responseRecovered, true);
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
    assert.strictEqual(calls.filter(call => call === 'create').length, 1);
    assert(calls.filter(call => call === 'reconcile').length >= 1);
    assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, 1);
  } finally { item.cleanup(); }
});

test('transaction rejects mixed existing and missing leaves before PRECREATE or native mutation', () => {
  const item = fixture();
  const calls = [];
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls),
    });
    const existingAfter = state('snapshot existing\n');
    const missingAfter = state('snapshot new\n');
    assert.throws(() => transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/existing.md',
        summary: 'restore existing',
        before: state('current existing\n'),
        after: existingAfter,
        createdIdentityDigest: null,
      }, {
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: missingAfter,
        createdIdentityDigest: null,
      }],
      provenance: provenance(),
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: [{
          selectedId: 'selected_existing',
          action: 'EXISTING',
          path: 'chapters/existing.md',
          revision: existingAfter.revision,
          ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
        }, {
          selectedId: 'selected_missing',
          action: 'MISSING',
          path: 'chapters/new.md',
          revision: missingAfter.revision,
          ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
        }],
      },
    }), error => error?.code === 'SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
  } finally { item.cleanup(); }
});

test('A1b production transaction boundary accepts mixed existing and missing authority', () => {
  const item = fixture();
  const calls = [];
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls),
      existingRestoreLifecycle: {
        forProject() {
          return {
            execute() {},
            reconcile() {},
            verify() {},
            finalize() {},
            reconcileFinalize() {},
          };
        },
      },
    });
    const existingAfter = state('snapshot existing\n');
    const missingAfter = state('snapshot new\n');
    assert.doesNotThrow(() => transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/existing.md',
        summary: 'restore existing',
        before: state('current existing\n'),
        after: existingAfter,
        createdIdentityDigest: null,
      }, {
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: missingAfter,
        createdIdentityDigest: null,
      }],
      provenance: {
        ...provenance(),
        selectedIds: ['selected_existing', 'selected_missing'],
      },
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: [{
          selectedId: 'selected_existing',
          action: 'EXISTING',
          path: 'chapters/existing.md',
          revision: existingAfter.revision,
          ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
        }, {
          selectedId: 'selected_missing',
          action: 'MISSING',
          path: 'chapters/new.md',
          revision: missingAfter.revision,
          ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
        }],
      },
    }));
  } finally { item.cleanup(); }
});

test('A1b mixed transaction exposes one Main-owned post-E journal CAS boundary', () => {
  const transaction = createChangesHistoryTransaction({
    projectService,
    existingRestoreLifecycle: {
      forProject() {
        return {
          execute() {},
          reconcile() {},
          verify() {},
          finalize() {},
          reconcileFinalize() {},
        };
      },
    },
  });
  assert.strictEqual(
    typeof transaction.commitExistingRestore,
    'function',
    'mixed EXISTING must install its terminal only through one Main journal CAS'
  );
});

test('mixed post-E CAS installs one stored existing publication and phase', () => {
  const item = fixture();
  const calls = [];
  const existingAfter = state('snapshot existing\n');
  const missingAfter = state('snapshot new\n');
  const existingTerminal = {
    schema: 'writcraft.public-markdown-existing-terminal-receipt/v1',
    command: 'EXECUTE_EXISTING',
    state: 'COMMITTED',
    operationId: 'existing-post-e-operation',
    requestDigest: `sha256:${'1'.repeat(64)}`,
    receiptSetDigest: `sha256:${'2'.repeat(64)}`,
    terminalReceiptDigest: `sha256:${'3'.repeat(64)}`,
    items: [{
      selectedId: 'selected_existing',
      path: 'chapters/existing.md',
      afterRevision: existingAfter.revision,
      afterLeafIdentityDigest: `sha256:${'4'.repeat(64)}`,
      controlBasename: `.changes-history-native-existing-control.${'5'.repeat(64)}`,
      applyBasename: `.changes-history-native-existing-apply.${'6'.repeat(64)}`,
    }],
  };
  try {
    const committedMarker = Object.freeze({
      kind: 'snapshot_restore',
      operationId: 'chr_0123456789abcdef0123456789abcdef0123456789abcdef',
      publicMarkdownPhase: Object.freeze({ phase: 'EXISTING_COMMITTED' }),
      existingTerminalPublication: Object.freeze({
        schema: markerJournalSchema.SCHEMAS.EXISTING_TERMINAL_PUBLICATION,
      }),
    });
    const reconciliationService = {
      executeExistingRestore(...args) {
        calls.push({ name: 'executeExistingRestore', args });
        assert.deepStrictEqual(args, [
          item.project.rootPath,
          item.project.projectId,
          committedMarker.operationId,
        ]);
        return committedMarker;
      },
    };
    const existingLifecycle = {
      forProject() {
        return {
          execute(request) {
            calls.push({ name: 'executeExisting', request });
            return { state: 'COMMITTED', terminalReceipt: existingTerminal };
          },
          reconcile() { calls.push({ name: 'reconcileExisting' }); return existingTerminal; },
          verify() { calls.push({ name: 'verifyExisting' }); return existingTerminal; },
          finalize() { calls.push({ name: 'finalizeExisting' }); return existingTerminal; },
          reconcileFinalize() {
            calls.push({ name: 'reconcileFinalizeExisting' });
            return existingTerminal;
          },
        };
      },
    };
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls),
      existingRestoreLifecycle: existingLifecycle,
      reconciliationService,
    });
    const prepared = transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'chapters/existing.md',
        summary: 'restore existing',
        before: state('current existing\n'),
        after: existingAfter,
        createdIdentityDigest: null,
      }, {
        path: 'chapters/new.md',
        summary: 'restore missing',
        before: absent(),
        after: missingAfter,
        createdIdentityDigest: null,
      }],
      provenance: {
        ...provenance(),
        selectedIds: ['selected_existing', 'selected_missing'],
      },
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: [{
          selectedId: 'selected_existing',
          action: 'EXISTING',
          path: 'chapters/existing.md',
          revision: existingAfter.revision,
          ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
        }, {
          selectedId: 'selected_missing',
          action: 'MISSING',
          path: 'chapters/new.md',
          revision: missingAfter.revision,
          ancestorIdentityDigest: `sha256:${'3'.repeat(64)}`,
        }],
      },
    });
    assert.strictEqual(prepared.mixedRestoreMode, true);

    // The production-shaped terminal is intentionally journal-bound. The
    // missing API is the first red boundary; once implemented this assertion
    // must prove one E call and one marker-journal CAS installation.
    assert.strictEqual(typeof transaction.commitExistingRestore, 'function');
    const created = Object.freeze({
      kind: 'snapshot_restore',
      operationId: committedMarker.operationId,
      publicMarkdownPhase: Object.freeze({ phase: 'CREATED_RECEIPT' }),
    });
    const result = transaction.commitExistingRestore(
      prepared,
      created,
      { schema: 'caller-minted-authority-must-be-ignored' },
      { artifactFd: -1, journalFd: -1, historyParentFd: -1, historyFd: -1 }
    );
    assert.strictEqual(calls.filter(call => call.name === 'executeExisting').length, 0);
    assert.strictEqual(calls.filter(call => call.name === 'executeExistingRestore').length, 1);
    assert.strictEqual(result.publicMarkdownPhase.phase, 'EXISTING_COMMITTED');
    assert(result.existingTerminalPublication);
    assert.strictEqual(
      result.existingTerminalPublication.schema,
      markerJournalSchema.SCHEMAS.EXISTING_TERMINAL_PUBLICATION
    );
  } finally { item.cleanup(); }
});

test('transaction rejects forged pre-native created identity before lifecycle or History', () => {
  const item = fixture();
  const calls = [];
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceCreateLifecycle(calls),
    });
    const args = missingRestoreArgs(item);
    args.files = [{
      ...args.files[0],
      createdIdentityDigest: `sha256:${'9'.repeat(64)}`,
    }];
    assert.throws(() => transaction.prepareSnapshotRestore(args), error =>
      error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
  } finally { item.cleanup(); }
});

test('FINALIZED rejects a forged final record name and self digest', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls, {
      forgeFinalAck: true,
      projectId: item.project.projectId,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.throws(() => transaction.finalizeMissingRestore(prepared, committed), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
  } finally { item.cleanup(); }
});

for (const mode of ['delete', 'replace', 'rewrite']) {
  test(`FINALIZED marker rename fresh-reconciles and rejects final record ${mode}`, () => {
    const item = fixture();
    const calls = [];
    try {
      const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
      const lifecycle = exactOnceCreateLifecycle(calls, {
        finalRecordDirectory: recovery,
        projectId: item.project.projectId,
      });
      let armed = false;
      const reconciliationService = createChangesHistoryReconciliationService({
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
        beforeMarkerRename() {
          if (!armed) return;
          const record = lifecycle.finalRecordPath();
          if (mode === 'delete') fs.unlinkSync(record);
          if (mode === 'replace') {
            fs.renameSync(record, `${record}.held`);
            fs.writeFileSync(record, '{}\n', { flag: 'wx', mode: 0o600 });
          }
          if (mode === 'rewrite') fs.writeFileSync(record, '{}\n');
        },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        publicMarkdownLifecycle: lifecycle,
        reconciliationService,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      const created = transaction.createMissingLeaves(prepared, precreate);
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      armed = true;
      assert.throws(() => transaction.finalizeMissingRestore(prepared, committed));
      assert.strictEqual(reconciliationService.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, 1);
      assert.strictEqual(calls.filter(call => call === 'reconcileFinalize').length, 2);
    } finally { item.cleanup(); }
  });
}

test('restart query converges a formal final record without replaying finalize mutation', () => {
  const item = fixture();
  const calls = [];
  try {
    const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
    const lifecycle = exactOnceCreateLifecycle(calls, {
      finalRecordDirectory: recovery,
      projectId: item.project.projectId,
    });
    let dropFinalMarker = false;
    const firstService = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
      beforeMarkerRename() {
        if (dropFinalMarker) throw new Error('lost FINALIZED marker response');
      },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      publicMarkdownLifecycle: lifecycle,
      reconciliationService: firstService,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    dropFinalMarker = true;
    assert.throws(() => transaction.finalizeMissingRestore(prepared, committed));
    assert.strictEqual(firstService.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    const finalizeCalls = calls.filter(call => call === 'finalizeCreate').length;

    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    restarted.query(item.project.rootPath, item.project.projectId);
    const marker = restarted.readMarker(item.project.rootPath);
    assert.strictEqual(marker.publicMarkdownPhase.phase, 'FINALIZED');
    assert.strictEqual(marker.state, 'terminal');
    assert.strictEqual(marker.outcome, 'applied');
    assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, finalizeCalls);
  } finally { item.cleanup(); }
});

test('artifact ACK response loss retains the FINALIZED marker and restart converges clear', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
    const artifactLifecycle = durableFakeArtifactLifecycle(calls, { acknowledgeFailures: 1 });
    const markerLifecycle = trustedFakeMarkerLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      exactMarkerLifecycle: markerLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    transaction.finalizeMissingRestore(prepared, committed);
    transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    const terminal = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(terminal.state, 'terminal');
    assert.throws(() => transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      terminal.operationId
    ));
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);

    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      exactMarkerLifecycle: markerLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    restarted.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(restarted.hasPending(item.project.rootPath), false);
    assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 1);
    assert.strictEqual(calls.filter(call => call === 'artifactAcknowledge').length, 2);
  } finally { item.cleanup(); }
});

test('ACK committed then response loss persists exact token for idempotent restart clear', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
    const artifactLifecycle = durableFakeArtifactLifecycle(calls, {
      ackCommittedThenThrow: true,
    });
    const markerLifecycle = trustedFakeMarkerLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      exactMarkerLifecycle: markerLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const created = transaction.createMissingLeaves(
      prepared,
      transaction.preparePublicMarkdownMarker(prepared)
    );
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    transaction.finalizeMissingRestore(prepared, committed);
    transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    const terminal = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.throws(() => transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      terminal.operationId
    ));
    const pending = transaction.reconciliation.readMarker(item.project.rootPath);
    assert(pending.artifactCleanup);
    assert.strictEqual(fs.existsSync(path.join(
      item.project.rootPath,
      '.writcraft/recovery',
      pending.artifact.basename
    )), false);

    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      exactMarkerLifecycle: markerLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    restarted.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(restarted.hasPending(item.project.rootPath), false);
    assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 1);
    assert.strictEqual(calls.filter(call => call === 'artifactAcknowledge').length, 2);
  } finally { item.cleanup(); }
});

test('FINALIZED marker rename fsync response loss converges without finalize replay', () => {
  const item = fixture();
  const calls = [];
  let failNextRecoveryFsync = false;
  let injected = false;
  try {
    const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
    let recoveryStat = null;
    const fileSystem = new Proxy(fs, {
      get(target, key) {
        if (key === 'renameSync') return (source, destination) => {
          const bytes = destination.endsWith('changes-history-transaction.json')
            ? fs.readFileSync(source, 'utf8')
            : '';
          const result = fs.renameSync(source, destination);
          if (!injected && bytes.includes('"phase": "FINALIZED"') &&
              bytes.includes('"state": "applying"')) {
            failNextRecoveryFsync = true;
          }
          return result;
        };
        if (key === 'fsyncSync') return fd => {
          const stat = fs.fstatSync(fd, { bigint: true });
          if (failNextRecoveryFsync && recoveryStat && stat.dev === recoveryStat.dev &&
              stat.ino === recoveryStat.ino) {
            failNextRecoveryFsync = false;
            injected = true;
            throw Object.assign(new Error('lost FINALIZED marker dir fsync'), { code: 'EIO' });
          }
          return fs.fsyncSync(fd);
        };
        return target[key];
      },
    });
    const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
    const first = createChangesHistoryReconciliationService({
      projectService,
      fileSystem,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      reconciliationService: first,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    recoveryStat = fs.lstatSync(recovery, { bigint: true });
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.throws(() => transaction.finalizeMissingRestore(prepared, committed), error =>
      error?.code === 'CHANGES_RECOVERY_WRITE_FAILED');
    assert.strictEqual(first.readMarker(item.project.rootPath).publicMarkdownPhase.phase, 'FINALIZED');
    const finalizeCalls = calls.filter(call => call === 'finalizeCreate').length;
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    restarted.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(restarted.readMarker(item.project.rootPath).state, 'terminal');
    assert.strictEqual(calls.filter(call => call === 'finalizeCreate').length, finalizeCalls);
  } finally { item.cleanup(); }
});

for (const fault of ['cleanup-response', 'marker-fsync']) {
  test(`FINALIZED cleanup ${fault} retains retry marker and converges once`, () => {
    const item = fixture();
    const calls = [];
    let armMarkerFsync = false;
    let markerFsyncInjected = false;
    try {
      const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
      let recoveryStat = null;
      const fileSystem = new Proxy(fs, {
        get(target, key) {
          if (key === 'fsyncSync') return fd => {
            const stat = fs.fstatSync(fd, { bigint: true });
            if (fault === 'marker-fsync' && recoveryStat && armMarkerFsync && !markerFsyncInjected &&
                stat.dev === recoveryStat.dev && stat.ino === recoveryStat.ino) {
              markerFsyncInjected = true;
              throw Object.assign(new Error('lost marker clear dir fsync'), { code: 'EIO' });
            }
            return fs.fsyncSync(fd);
          };
          return target[key];
        },
      });
      const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
      const artifactLifecycle = durableFakeArtifactLifecycle(calls, {
        throwAfterCleanup: fault === 'cleanup-response',
        afterCleanup() { armMarkerFsync = true; },
      });
      const markerLifecycle = trustedFakeMarkerLifecycle(calls);
      const service = createChangesHistoryReconciliationService({
        projectService,
        fileSystem,
        exactArtifactLifecycle: artifactLifecycle,
        exactMarkerLifecycle: markerLifecycle,
        publicMarkdownLifecycle: lifecycle,
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        reconciliationService: service,
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      recoveryStat = fs.lstatSync(recovery, { bigint: true });
      const created = transaction.createMissingLeaves(prepared, precreate);
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      transaction.finalizeMissingRestore(prepared, committed);
      service.query(item.project.rootPath, item.project.projectId);
      const terminal = service.readMarker(item.project.rootPath);
      assert.throws(() => service.clear(
        item.project.rootPath,
        item.project.projectId,
        terminal.operationId
      ));
      assert.strictEqual(service.hasPending(item.project.rootPath), true);
      const restarted = createChangesHistoryReconciliationService({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        exactMarkerLifecycle: markerLifecycle,
        publicMarkdownLifecycle: lifecycle,
      });
      restarted.query(item.project.rootPath, item.project.projectId);
      assert.strictEqual(restarted.hasPending(item.project.rootPath), false);
      assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 1);
    } finally { item.cleanup(); }
  });
}

test('artifact cleanup UNKNOWN preserves FINALIZED marker and artifact without mutation replay', () => {
  const item = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
    const artifactLifecycle = durableFakeArtifactLifecycle(calls, { reconcileUnknown: true });
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const created = transaction.createMissingLeaves(
      prepared,
      transaction.preparePublicMarkdownMarker(prepared)
    );
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    transaction.finalizeMissingRestore(prepared, committed);
    transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
    const terminal = transaction.reconciliation.readMarker(item.project.rootPath);
    const artifactPath = path.join(
      item.project.rootPath,
      '.writcraft/recovery',
      terminal.artifact.basename
    );
    assert.throws(() => transaction.reconciliation.clear(
      item.project.rootPath,
      item.project.projectId,
      terminal.operationId
    ));
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
    assert.strictEqual(fs.existsSync(artifactPath), true);
    assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 0);
  } finally { item.cleanup(); }
});

test('foreign cleanup tokens cannot bypass exact artifact removal or clear FINALIZED marker', () => {
  for (const attack of ['foreign', 'stale', 'extra', 'accessor']) {
    const item = fixture();
    const calls = [];
    let getterCalls = 0;
    try {
      const baseToken = {
        schema: 'writcraft.changes-history-artifact-cleanup-token/v1',
        quarantine: `.changes-history-cleanup.${'a'.repeat(32)}`,
        control: `.changes-history-cleanup-control.${'b'.repeat(64)}`,
        proof: `.changes-history-cleanup-proof.${'c'.repeat(64)}`,
        receipt: `.changes-history-cleanup-receipt.${'d'.repeat(64)}`,
        receiptDigest: `sha256:${(attack === 'stale' ? 'e' : 'f').repeat(64)}`,
      };
      let hostile = baseToken;
      if (attack === 'extra') hostile = { ...baseToken, foreign: true };
      if (attack === 'accessor') {
        hostile = { ...baseToken };
        Object.defineProperty(hostile, 'receiptDigest', {
          enumerable: true,
          get() { getterCalls += 1; return `sha256:${'f'.repeat(64)}`; },
        });
      }
      const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
      const artifactLifecycle = durableFakeArtifactLifecycle(calls, {
        reconcileOverride: hostile,
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      transaction.finalizeMissingRestore(prepared, committed);
      transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
      const marker = transaction.reconciliation.readMarker(item.project.rootPath);
      const artifact = path.join(
        item.project.rootPath,
        '.writcraft/recovery',
        marker.artifact.basename
      );
      assert.throws(() => transaction.reconciliation.query(
        item.project.rootPath,
        item.project.projectId
      ));
      assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
      assert.strictEqual(fs.existsSync(artifact), true);
      assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 0);
      assert.strictEqual(calls.filter(call => call === 'artifactAcknowledge').length, 0);
      assert.strictEqual(getterCalls, 0);
    } finally { item.cleanup(); }
  }
});

test('exact marker clear preserves late new-inode and same-inode foreign marker authority', () => {
  for (const attack of ['new-inode', 'same-inode']) {
    const item = fixture();
    const calls = [];
    try {
      const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
      const artifactLifecycle = durableFakeArtifactLifecycle(calls);
      const markerLifecycle = trustedFakeMarkerLifecycle(calls);
      let armed = false;
      const service = createChangesHistoryReconciliationService({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        exactMarkerLifecycle: markerLifecycle,
        publicMarkdownLifecycle: lifecycle,
        beforeClear(location) {
          if (!armed) return;
          const bytes = fs.readFileSync(location.file);
          if (attack === 'new-inode') {
            fs.renameSync(location.file, `${location.file}.owned`);
            fs.writeFileSync(location.file, bytes, { flag: 'wx', mode: 0o600 });
          } else {
            fs.writeFileSync(location.file, bytes);
          }
        },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        reconciliationService: service,
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      transaction.finalizeMissingRestore(prepared, committed);
      service.query(item.project.rootPath, item.project.projectId);
      const terminal = service.readMarker(item.project.rootPath);
      armed = true;
      assert.throws(() => service.clear(
        item.project.rootPath,
        item.project.projectId,
        terminal.operationId
      ));
      assert.strictEqual(service.hasPending(item.project.rootPath), true);
      assert.strictEqual(calls.filter(call => call === 'markerClear').length, 0);
      assert.strictEqual(calls.filter(call => call === 'artifactAcknowledge').length, 0);
      assert.strictEqual(fs.existsSync(path.join(
        item.project.rootPath,
        '.writcraft/recovery',
        terminal.artifact.basename
      )), false);
    } finally { item.cleanup(); }
  }
});

test('missing or hostile exact marker lifecycle fails before cleanup and marker mutation', () => {
  for (const attack of ['missing', 'partial', 'accessor']) {
    const item = fixture();
    const calls = [];
    let getterCalls = 0;
    try {
      const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
      const artifactLifecycle = durableFakeArtifactLifecycle(calls);
      let markerLifecycle = null;
      if (attack === 'partial') markerLifecycle = Object.freeze({});
      if (attack === 'accessor') {
        markerLifecycle = {};
        Object.defineProperty(markerLifecycle, 'clear', {
          enumerable: true,
          get() { getterCalls += 1; return () => {}; },
        });
      }
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        ...(markerLifecycle ? { exactMarkerLifecycle: markerLifecycle } : {}),
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      transaction.finalizeMissingRestore(prepared, committed);
      transaction.reconciliation.query(item.project.rootPath, item.project.projectId);
      const marker = transaction.reconciliation.readMarker(item.project.rootPath);
      const markerPath = path.join(
        item.project.rootPath,
        '.writcraft/recovery/changes-history-transaction.json'
      );
      const artifactPath = path.join(
        item.project.rootPath,
        '.writcraft/recovery',
        marker.artifact.basename
      );
      const markerBytes = fs.readFileSync(markerPath);
      const artifactBytes = fs.readFileSync(artifactPath);
      const markerStat = fs.lstatSync(markerPath, { bigint: true });
      const artifactStat = fs.lstatSync(artifactPath, { bigint: true });
      assert.throws(() => transaction.reconciliation.clear(
        item.project.rootPath,
        item.project.projectId,
        marker.operationId
      ), error => error?.code === 'MARKER_CLEAR_UNAVAILABLE');
      assert(fs.readFileSync(markerPath).equals(markerBytes));
      assert(fs.readFileSync(artifactPath).equals(artifactBytes));
      const markerAfter = fs.lstatSync(markerPath, { bigint: true });
      const artifactAfter = fs.lstatSync(artifactPath, { bigint: true });
      assert.strictEqual(markerAfter.ino, markerStat.ino);
      assert.strictEqual(markerAfter.mtimeNs, markerStat.mtimeNs);
      assert.strictEqual(artifactAfter.ino, artifactStat.ino);
      assert.strictEqual(artifactAfter.mtimeNs, artifactStat.mtimeNs);
      assert.strictEqual(calls.filter(call => call === 'artifactReconcile').length, 0);
      assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 0);
      assert.strictEqual(calls.filter(call => call === 'artifactAcknowledge').length, 0);
      assert.strictEqual(getterCalls, 0);
    } finally { item.cleanup(); }
  }
});

test('FINALIZED durability rejects late marker/artifact rewrite or replacement', () => {
  for (const attack of ['marker-replacement', 'artifact-replacement', 'artifact-rewrite']) {
    const item = fixture();
    const calls = [];
    try {
      const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
      const options = {
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      };
      const transaction = createChangesHistoryTransaction(options);
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      const committed = transaction.commitMissingRestoreHistory(prepared, created);
      transaction.finalizeMissingRestore(prepared, committed);
      const restarted = createChangesHistoryReconciliationService({
        ...options,
        beforeMarkerDurabilityFsync({ marker, location }) {
          if (marker.publicMarkdownPhase.phase !== 'FINALIZED') return;
          if (attack === 'marker-replacement') {
            const bytes = fs.readFileSync(location.file);
            fs.unlinkSync(location.file);
            fs.writeFileSync(location.file, bytes, { flag: 'wx', mode: 0o600 });
            return;
          }
          const artifact = path.join(location.directory, marker.artifact.basename);
          const bytes = fs.readFileSync(artifact);
          if (attack === 'artifact-replacement') {
            fs.unlinkSync(artifact);
            fs.writeFileSync(artifact, bytes, { flag: 'wx', mode: 0o600 });
          } else {
            fs.writeFileSync(artifact, bytes);
          }
        },
      });
      const callsBefore = [...calls];
      assert.throws(() => restarted.query(item.project.rootPath, item.project.projectId), error =>
        ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'CHANGES_RECOVERY_WRITE_FAILED'].includes(error?.code));
      assert.strictEqual(restarted.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'FINALIZED');
      assert.deepStrictEqual(calls, callsBefore);
    } finally { item.cleanup(); }
  }
});

test('FINALIZED project switch fails closed without lifecycle or cleanup mutation', () => {
  const item = fixture();
  const other = fixture();
  const calls = [];
  try {
    const lifecycle = exactOnceCreateLifecycle(calls, { projectId: item.project.projectId });
    const artifactLifecycle = durableFakeArtifactLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const created = transaction.createMissingLeaves(
      prepared,
      transaction.preparePublicMarkdownMarker(prepared)
    );
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    transaction.finalizeMissingRestore(prepared, committed);
    const before = [...calls];
    assert.throws(() => transaction.reconciliation.query(
      item.project.rootPath,
      other.project.projectId
    ));
    assert.deepStrictEqual(calls, before);
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), true);
  } finally {
    other.cleanup();
    item.cleanup();
  }
});

test('History template identity materialization rejects hostile descriptors with zero getters', () => {
  const item = fixture();
  let getterCalls = 0;
  try {
    const prepared = historyService.prepareSnapshotRestoreHistoryTemplate(
      item.project.rootPath,
      missingRestoreArgs(item).files.map((file, index) => ({
        ...file,
        ancestorIdentityDigest: parentBinding().selected[index].ancestorIdentityDigest,
      })),
      provenance()
    );
    const identity = { path: 'chapters/new.md' };
    Object.defineProperty(identity, 'createdIdentityDigest', {
      enumerable: true,
      get() { getterCalls += 1; return `sha256:${'6'.repeat(64)}`; },
    });
    assert.throws(() => historyService.materializeSnapshotRestoreHistoryTemplate(
      prepared.baseHistoryState,
      prepared.historyTemplate,
      [identity]
    ), error => error?.code === 'INVALID_HISTORY');
    const hidden = { path: 'chapters/new.md' };
    Object.defineProperty(hidden, 'createdIdentityDigest', {
      enumerable: false,
      value: `sha256:${'6'.repeat(64)}`,
    });
    const symbol = {
      path: 'chapters/new.md',
      createdIdentityDigest: `sha256:${'6'.repeat(64)}`,
      [Symbol('foreign')]: true,
    };
    const extra = {
      path: 'chapters/new.md',
      createdIdentityDigest: `sha256:${'6'.repeat(64)}`,
      foreign: true,
    };
    const sparse = new Array(1);
    for (const hostile of [[hidden], [symbol], [extra], sparse]) {
      assert.throws(() => historyService.materializeSnapshotRestoreHistoryTemplate(
        prepared.baseHistoryState,
        prepared.historyTemplate,
        hostile
      ), error => error?.code === 'INVALID_HISTORY');
    }
    assert.strictEqual(getterCalls, 0);
  } finally { item.cleanup(); }
});

test('History rename plus first parent fsync EIO retries the exact parent before HISTORY_COMMITTED', () => {
  const item = fixture();
  const calls = [];
  const originalFsync = fs.fsyncSync;
  try {
    const lifecycle = exactOnceCreateLifecycle(calls);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const parentStat = fs.lstatSync(path.join(item.project.rootPath, '.writcraft'), { bigint: true });
    let parentFsyncAttempts = 0;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev === parentStat.dev && stat.ino === parentStat.ino) {
        parentFsyncAttempts += 1;
        if (parentFsyncAttempts === 1) {
          throw Object.assign(new Error('injected History parent fsync EIO'), { code: 'EIO' });
        }
      }
      return originalFsync(fd);
    };
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    fs.fsyncSync = originalFsync;
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(parentFsyncAttempts, 3);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
  } finally {
    fs.fsyncSync = originalFsync;
    item.cleanup();
  }
});

test('HISTORY_COMMITTED marker rename holds exact prepared History file and parent authority', () => {
  for (const attack of ['history-replacement', 'history-rewrite', 'parent-replacement']) {
    const item = fixture();
    const calls = [];
    let markerRenames = 0;
    let oldMetadata = null;
    try {
      const lifecycle = exactOnceCreateLifecycle(calls);
      const artifactLifecycle = trustedFakeArtifactLifecycle();
      const reconciliation = createChangesHistoryReconciliationService({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        publicMarkdownLifecycle: lifecycle,
        beforeMarkerRename() {
          markerRenames += 1;
          if (markerRenames !== 3) return;
          const metadata = path.join(item.project.rootPath, '.writcraft');
          const historyPath = path.join(metadata, 'changes.json');
          const bytes = fs.readFileSync(historyPath);
          if (attack === 'history-replacement') {
            fs.unlinkSync(historyPath);
            fs.writeFileSync(historyPath, bytes, { flag: 'wx', mode: 0o600 });
          } else if (attack === 'history-rewrite') {
            fs.writeFileSync(historyPath, bytes);
          } else {
            oldMetadata = path.join(item.project.rootPath, '.writcraft-old');
            fs.renameSync(metadata, oldMetadata);
            fs.mkdirSync(metadata, { mode: 0o700 });
            fs.renameSync(path.join(oldMetadata, 'recovery'), path.join(metadata, 'recovery'));
            fs.writeFileSync(historyPath, bytes, { flag: 'wx', mode: 0o600 });
          }
        },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        reconciliationService: reconciliation,
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const precreate = transaction.preparePublicMarkdownMarker(prepared);
      const created = transaction.createMissingLeaves(prepared, precreate);
      assert.throws(
        () => transaction.commitMissingRestoreHistory(prepared, created),
        error => ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'CHANGES_RECOVERY_WRITE_FAILED'].includes(error?.code)
      );
      assert.strictEqual(reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    } finally {
      if (oldMetadata) fs.rmSync(oldMetadata, { recursive: true, force: true });
      item.cleanup();
    }
  }
});

test('restart query converges durable prepared History from CREATED_RECEIPT without adapter replay', () => {
  const item = fixture();
  const calls = [];
  let markerRenames = 0;
  try {
    const lifecycle = exactOnceCreateLifecycle(calls);
    const artifactLifecycle = trustedFakeArtifactLifecycle();
    const reconciliation = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: lifecycle,
      beforeMarkerRename() {
        markerRenames += 1;
        if (markerRenames === 3) throw new Error('lost HISTORY_COMMITTED marker response');
      },
    });
    const transaction = createChangesHistoryTransaction({
      projectService,
      reconciliationService: reconciliation,
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    assert.throws(
      () => transaction.commitMissingRestoreHistory(prepared, created),
      error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
    );
    assert.strictEqual(reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
    const callsBeforeRestart = [...calls];
    const restarted = createChangesHistoryReconciliationService({
      projectService,
      exactArtifactLifecycle: artifactLifecycle,
      publicMarkdownLifecycle: lifecycle,
    });
    restarted.query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(restarted.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.deepStrictEqual(calls, callsBeforeRestart);
  } finally { item.cleanup(); }
});

test('restart query keeps exact base continuable and rejects foreign History without adapter calls', () => {
  for (const mode of ['base', 'foreign']) {
    const item = fixture();
    const calls = [];
    try {
      const lifecycle = exactOnceCreateLifecycle(calls);
      const options = {
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      };
      const transaction = createChangesHistoryTransaction(options);
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      if (mode === 'foreign') {
        fs.writeFileSync(
          path.join(item.project.rootPath, '.writcraft/changes.json'),
          '{"schema":"writcraft.changes/v4","entries":[]}\n',
          'utf8'
        );
      }
      const callsBefore = [...calls];
      const restarted = createChangesHistoryReconciliationService(options);
      if (mode === 'base') {
        restarted.query(item.project.rootPath, item.project.projectId);
        assert.strictEqual(restarted.readMarker(item.project.rootPath)
          .publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      } else {
        assert.throws(
          () => restarted.query(item.project.rootPath, item.project.projectId),
          error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
        );
      }
      assert.deepStrictEqual(calls, callsBefore);
      assert.strictEqual(created.publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    } finally { item.cleanup(); }
  }
});

test('minified exact base History remains valid through receipt-derived commit', () => {
  const item = fixture();
  try {
    const minified = '{"schema":"writcraft.changes/v4","entries":[]}';
    fs.writeFileSync(path.join(item.project.rootPath, '.writcraft/changes.json'), minified, 'utf8');
    const lifecycle = exactOnceCreateLifecycle([]);
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    });
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const precreate = transaction.preparePublicMarkdownMarker(prepared);
    const created = transaction.createMissingLeaves(prepared, precreate);
    const committed = transaction.commitMissingRestoreHistory(prepared, created);
    assert.strictEqual(committed.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 1);
  } finally { item.cleanup(); }
});

test('History temp partial, file fsync and rename failures retain CREATED_RECEIPT/base truth', () => {
  for (const fault of ['partial', 'file-fsync', 'rename']) {
    const item = fixture();
    const originalWriteFile = fs.writeFileSync;
    const originalFsync = fs.fsyncSync;
    const originalRename = fs.renameSync;
    try {
      const adapterCalls = [];
      const lifecycle = exactOnceCreateLifecycle(adapterCalls);
      const serviceOptions = {
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      };
      const transaction = createChangesHistoryTransaction(serviceOptions);
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      let injected = false;
      if (fault === 'partial') {
        fs.writeFileSync = (target, data, ...rest) => {
          if (!injected && typeof target === 'number' && typeof data === 'string' &&
              data.includes('"writcraft.changes/v4"')) {
            injected = true;
            originalWriteFile(target, data.slice(0, Math.max(1, Math.floor(data.length / 2))), ...rest);
            throw new Error('injected partial History temp write');
          }
          return originalWriteFile(target, data, ...rest);
        };
      } else if (fault === 'file-fsync') {
        fs.fsyncSync = fd => {
          if (!injected && fs.fstatSync(fd).isFile()) {
            injected = true;
            throw new Error('injected History temp file fsync');
          }
          return originalFsync(fd);
        };
      } else {
        fs.renameSync = (source, destination) => {
          if (!injected && destination === path.join(item.project.rootPath, '.writcraft/changes.json')) {
            injected = true;
            throw new Error('injected History rename');
          }
          return originalRename(source, destination);
        };
      }
      assert.throws(() => transaction.commitMissingRestoreHistory(prepared, created));
      fs.writeFileSync = originalWriteFile;
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
      assert.strictEqual(injected, true);
      assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
      const callsBeforeRestart = [...adapterCalls];
      const restarted = createChangesHistoryReconciliationService(serviceOptions);
      restarted.query(item.project.rootPath, item.project.projectId);
      assert.strictEqual(restarted.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'CREATED_RECEIPT');
      assert.deepStrictEqual(adapterCalls, callsBeforeRestart);
    } finally {
      fs.writeFileSync = originalWriteFile;
      fs.fsyncSync = originalFsync;
      fs.renameSync = originalRename;
      item.cleanup();
    }
  }
});

test('HISTORY_COMMITTED marker directory fsync response loss preserves committed restart truth', () => {
  const item = fixture();
  const originalFsync = fs.fsyncSync;
  try {
    const lifecycle = exactOnceCreateLifecycle([]);
    const options = {
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: lifecycle,
    };
    const transaction = createChangesHistoryTransaction(options);
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const created = transaction.createMissingLeaves(
      prepared,
      transaction.preparePublicMarkdownMarker(prepared)
    );
    const recoveryStat = fs.lstatSync(
      path.join(item.project.rootPath, '.writcraft/recovery'),
      { bigint: true }
    );
    let injected = false;
    let recoveryDirectoryFsyncAttempts = 0;
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.dev === recoveryStat.dev && stat.ino === recoveryStat.ino) {
        recoveryDirectoryFsyncAttempts += 1;
        if (!injected) {
          injected = true;
          throw new Error('lost marker directory fsync response');
        }
      }
      return originalFsync(fd);
    };
    assert.throws(
      () => transaction.commitMissingRestoreHistory(prepared, created),
      error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
    );
    assert.strictEqual(injected, true);
    const restarted = createChangesHistoryReconciliationService(options);
    assert.strictEqual(restarted.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    restarted.query(item.project.rootPath, item.project.projectId);
    fs.fsyncSync = originalFsync;
    assert.strictEqual(recoveryDirectoryFsyncAttempts, 2);
  } finally {
    fs.fsyncSync = originalFsync;
    item.cleanup();
  }
});

test('restart marker durability rejects marker rewrite/replacement and recovery-dir replacement', () => {
  for (const attack of ['marker-rewrite', 'marker-replacement', 'directory-replacement']) {
    const item = fixture();
    let oldRecovery = null;
    try {
      const adapterCalls = [];
      const lifecycle = exactOnceCreateLifecycle(adapterCalls);
      const baseOptions = {
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      };
      const transaction = createChangesHistoryTransaction(baseOptions);
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      transaction.commitMissingRestoreHistory(prepared, created);
      const callsBefore = [...adapterCalls];
      const restarted = createChangesHistoryReconciliationService({
        ...baseOptions,
        beforeMarkerDurabilityFsync({ marker, location }) {
          const markerPath = location.file;
          const bytes = fs.readFileSync(markerPath);
          if (attack === 'marker-rewrite') {
            fs.writeFileSync(markerPath, bytes);
          } else if (attack === 'marker-replacement') {
            fs.unlinkSync(markerPath);
            fs.writeFileSync(markerPath, bytes, { flag: 'wx', mode: 0o600 });
          } else {
            oldRecovery = `${location.directory}-old`;
            fs.renameSync(location.directory, oldRecovery);
            fs.mkdirSync(location.directory, { mode: 0o700 });
            fs.renameSync(
              path.join(oldRecovery, marker.artifact.basename),
              path.join(location.directory, marker.artifact.basename)
            );
            fs.renameSync(
              path.join(oldRecovery, 'changes-history-transaction.json'),
              path.join(location.directory, 'changes-history-transaction.json')
            );
          }
        },
      });
      assert.throws(
        () => restarted.query(item.project.rootPath, item.project.projectId),
        error => ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'CHANGES_RECOVERY_WRITE_FAILED'].includes(error?.code)
      );
      assert.strictEqual(restarted.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.deepStrictEqual(adapterCalls, callsBefore);
    } finally {
      if (oldRecovery) fs.rmSync(oldRecovery, { recursive: true, force: true });
      item.cleanup();
    }
  }
});

test('restart marker durability rechecks project, root and public ancestor after fsync hook', () => {
  for (const attack of ['project', 'root', 'ancestor']) {
    const item = fixture();
    let movedRoot = null;
    let movedAncestor = null;
    try {
      if (attack === 'ancestor') {
        fs.mkdirSync(path.join(item.project.rootPath, 'chapters'), { recursive: true });
      }
      const adapterCalls = [];
      const lifecycle = exactOnceCreateLifecycle(adapterCalls);
      const baseOptions = {
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      };
      const transaction = createChangesHistoryTransaction(baseOptions);
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      const created = transaction.createMissingLeaves(
        prepared,
        transaction.preparePublicMarkdownMarker(prepared)
      );
      transaction.commitMissingRestoreHistory(prepared, created);
      const callsBefore = [...adapterCalls];
      const restarted = createChangesHistoryReconciliationService({
        ...baseOptions,
        beforeMarkerDurabilityFsync() {
          if (attack === 'project') {
            const metadataPath = path.join(item.project.rootPath, '.writcraft/project.json');
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            fs.writeFileSync(metadataPath, `${JSON.stringify({
              ...metadata,
              projectId: crypto.randomUUID(),
            }, null, 2)}\n`, 'utf8');
          } else if (attack === 'root') {
            movedRoot = `${item.project.rootPath}-old`;
            fs.renameSync(item.project.rootPath, movedRoot);
            fs.mkdirSync(item.project.rootPath, { mode: 0o700 });
            fs.renameSync(
              path.join(movedRoot, '.writcraft'),
              path.join(item.project.rootPath, '.writcraft')
            );
          } else {
            const ancestor = path.join(item.project.rootPath, 'chapters');
            movedAncestor = path.join(item.project.rootPath, 'chapters-old');
            fs.renameSync(ancestor, movedAncestor);
            fs.mkdirSync(ancestor);
          }
        },
      });
      assert.throws(
        () => restarted.query(item.project.rootPath, item.project.projectId),
        error => ['CHANGES_RECOVERY_STALE', 'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'CHANGES_RECOVERY_WRITE_FAILED'].includes(error?.code)
      );
      assert.strictEqual(restarted.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.deepStrictEqual(adapterCalls, callsBefore);
    } finally {
      if (movedAncestor) fs.rmSync(movedAncestor, { recursive: true, force: true });
      item.cleanup();
      if (movedRoot) fs.rmSync(movedRoot, { recursive: true, force: true });
    }
  }
});

test('lost CREATE response restarts through reconcile and never calls create twice', () => {
  const item = fixture();
  const calls = [];
  const lifecycle = exactOnceCreateLifecycle(calls, { throwAfterCreate: true });
  const options = {
    projectService,
    exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
    publicMarkdownLifecycle: lifecycle,
  };
  try {
    const transaction = createChangesHistoryTransaction(options);
    const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
    const marker = transaction.preparePublicMarkdownMarker(prepared);
    assert.throws(() => transaction.createMissingLeaves(prepared, marker), /lost CREATE response/);
    assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
      .publicMarkdownPhase.phase, 'PRECREATE');
    const recovered = createChangesHistoryReconciliationService(options)
      .query(item.project.rootPath, item.project.projectId);
    assert.strictEqual(recovered.recovery.state, 'applying');
    assert.strictEqual(createChangesHistoryReconciliationService(options)
      .readMarker(item.project.rootPath).publicMarkdownPhase.phase, 'CREATED_RECEIPT');
    assert.deepStrictEqual(calls, [
      'create', 'reconcile', 'verifyCreate', 'verifyCreate',
    ]);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries.length, 0);
  } finally { item.cleanup(); }
});

test('post-receipt marker/artifact/root drift fails closed before CREATED_RECEIPT', () => {
  for (const attack of ['marker-replacement', 'artifact-rewrite', 'artifact-replacement', 'root-drift']) {
    const item = fixture();
    const calls = [];
    try {
      let marker;
      const afterCreate = () => {
        const recoveryDirectory = path.join(item.project.rootPath, '.writcraft/recovery');
        if (attack === 'marker-replacement') {
          const markerPath = path.join(recoveryDirectory, 'changes-history-transaction.json');
          const bytes = fs.readFileSync(markerPath);
          fs.unlinkSync(markerPath);
          fs.writeFileSync(markerPath, bytes, { flag: 'wx', mode: 0o600 });
        }
        if (attack === 'artifact-rewrite') {
          const artifactPath = path.join(recoveryDirectory, marker.artifact.basename);
          const bytes = fs.readFileSync(artifactPath);
          bytes[bytes.length - 1] ^= 1;
          fs.writeFileSync(artifactPath, bytes);
        }
        if (attack === 'artifact-replacement') {
          const artifactPath = path.join(recoveryDirectory, marker.artifact.basename);
          const bytes = fs.readFileSync(artifactPath);
          fs.unlinkSync(artifactPath);
          fs.writeFileSync(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
        }
      };
      const lifecycle = exactOnceCreateLifecycle(calls, {
        afterCreate,
        ...(attack === 'root-drift' ? {
          verifyError: Object.assign(new Error('root/ancestor drift'), {
            code: 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT',
          }),
        } : {}),
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      marker = transaction.preparePublicMarkdownMarker(prepared);
      assert.throws(
        () => transaction.createMissingLeaves(prepared, marker),
        error => ['CHANGES_MANUAL_RECOVERY_REQUIRED', 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT',
          'CHANGES_RECOVERY_STALE'].includes(error?.code)
      );
      assert.strictEqual(transaction.reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'PRECREATE');
    } finally { item.cleanup(); }
  }
});

test('before-marker-rename rechecks artifact and canonical ancestor authority in the commit window', () => {
  for (const attack of ['artifact-rewrite', 'artifact-replacement', 'ancestor-replacement']) {
    const item = fixture();
    const calls = [];
    let marker;
    let renameWindow = 0;
    let ancestorStat = null;
    let movedAncestor = null;
    try {
      if (attack === 'ancestor-replacement') {
        const ancestor = path.join(item.project.rootPath, 'chapters');
        fs.mkdirSync(ancestor, { recursive: true });
        ancestorStat = fs.lstatSync(ancestor, { bigint: true });
      }
      const lifecycle = exactOnceCreateLifecycle(calls, {
        verifyAuthority() {
          if (!ancestorStat) return;
          const current = fs.lstatSync(path.join(item.project.rootPath, 'chapters'), { bigint: true });
          if (current.dev !== ancestorStat.dev || current.ino !== ancestorStat.ino) {
            throw Object.assign(new Error('ancestor replaced'), {
              code: 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT',
            });
          }
        },
      });
      const artifactLifecycle = trustedFakeArtifactLifecycle();
      const reconciliation = createChangesHistoryReconciliationService({
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        publicMarkdownLifecycle: lifecycle,
        beforeMarkerRename() {
          renameWindow += 1;
          if (renameWindow !== 2) return;
          const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
          if (attack.startsWith('artifact-')) {
            const artifactPath = path.join(recovery, marker.artifact.basename);
            const bytes = fs.readFileSync(artifactPath);
            if (attack === 'artifact-rewrite') {
              bytes[bytes.length - 1] ^= 1;
              fs.writeFileSync(artifactPath, bytes);
            } else {
              fs.unlinkSync(artifactPath);
              fs.writeFileSync(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
            }
          } else {
            const ancestor = path.join(item.project.rootPath, 'chapters');
            movedAncestor = path.join(item.project.rootPath, 'chapters-old');
            fs.renameSync(ancestor, movedAncestor);
            fs.mkdirSync(ancestor);
          }
        },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        reconciliationService: reconciliation,
        publicMarkdownLifecycle: lifecycle,
      });
      const prepared = transaction.prepareSnapshotRestore(missingRestoreArgs(item));
      marker = transaction.preparePublicMarkdownMarker(prepared);
      assert.throws(
        () => transaction.createMissingLeaves(prepared, marker),
        error => ['CHANGES_MANUAL_RECOVERY_REQUIRED', 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT',
          'CHANGES_RECOVERY_STALE'].includes(error?.code)
      );
      assert.strictEqual(reconciliation.readMarker(item.project.rootPath)
        .publicMarkdownPhase.phase, 'PRECREATE');
    } finally {
      if (movedAncestor) fs.rmSync(movedAncestor, { recursive: true, force: true });
      item.cleanup();
    }
  }
});

test('restart query rejects same-length corruption and same-byte inode replacement', () => {
  for (const attack of ['corrupt', 'replace']) {
    const item = fixture();
    const calls = [];
    try {
      const artifactLifecycle = trustedFakeArtifactLifecycle();
      const options = {
        projectService,
        exactArtifactLifecycle: artifactLifecycle,
        publicMarkdownLifecycle: dormantPublicMarkdownLifecycle(calls),
      };
      const transaction = createChangesHistoryTransaction(options);
      const marker = transaction.preparePublicMarkdownMarker(
        transaction.prepareSnapshotRestore(missingRestoreArgs(item))
      );
      const artifactPath = path.join(
        item.project.rootPath,
        '.writcraft/recovery',
        marker.artifact.basename
      );
      const bytes = fs.readFileSync(artifactPath);
      if (attack === 'corrupt') {
        fs.writeFileSync(artifactPath, Buffer.alloc(bytes.length));
      } else {
        fs.unlinkSync(artifactPath);
        fs.writeFileSync(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
      }
      const restarted = createChangesHistoryReconciliationService(options);
      assert.throws(
        () => restarted.query(item.project.rootPath, item.project.projectId),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      assert.strictEqual(restarted.readMarker(item.project.rootPath).publicMarkdownPhase.phase, 'PRECREATE');
      assert.deepStrictEqual(calls, []);
    } finally { item.cleanup(); }
  }
});

test('PRECREATE rejects provenance selectedId/order/mapping drift before marker publication', () => {
  const cases = [
    { selectedIds: ['selected_other'], selectedId: 'selected_missing', path: 'chapters/new.md' },
    { selectedIds: ['selected_missing'], selectedId: 'selected_other', path: 'chapters/new.md' },
    { selectedIds: ['selected_missing'], selectedId: 'selected_missing', path: 'other.md' },
  ];
  for (const drift of cases) {
    const item = fixture();
    try {
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
        publicMarkdownLifecycle: dormantPublicMarkdownLifecycle([]),
      });
      const args = missingRestoreArgs(item);
      args.provenance = { ...args.provenance, selectedIds: drift.selectedIds };
      args.parentSelectionBinding = {
        ...args.parentSelectionBinding,
        selected: [{
          ...args.parentSelectionBinding.selected[0],
          selectedId: drift.selectedId,
          path: drift.path,
        }],
      };
      assert.throws(
        () => transaction.prepareSnapshotRestore(args),
        error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT'
      );
      assert.strictEqual(fs.existsSync(path.join(
        item.project.rootPath,
        '.writcraft/recovery/changes-history-transaction.json'
      )), false);
      const recoveryDirectory = path.join(item.project.rootPath, '.writcraft/recovery');
      assert.strictEqual(
        fs.existsSync(recoveryDirectory) &&
          fs.readdirSync(recoveryDirectory).some(name => name.endsWith('.bin')),
        false
      );
    } finally { item.cleanup(); }
  }
  const item = fixture();
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: trustedFakeArtifactLifecycle(),
      publicMarkdownLifecycle: dormantPublicMarkdownLifecycle([]),
    });
    const existingAfter = state('snapshot existing\n');
    const missingAfter = state('snapshot missing\n');
    assert.throws(() => transaction.prepareSnapshotRestore({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      files: [{
        path: 'existing.md', summary: 'existing', before: state('current\n'),
        after: existingAfter, createdIdentityDigest: null,
      }, {
        path: 'missing.md', summary: 'missing', before: absent(),
        after: missingAfter, createdIdentityDigest: null,
      }],
      provenance: { ...provenance(), selectedIds: ['selected_existing', 'selected_missing'] },
      parentSelectionBinding: {
        schema: phaseSchema.SELECTION_SCHEMA,
        kind: 'snapshot_restore',
        selected: [{
          selectedId: 'selected_missing', action: 'MISSING', path: 'missing.md',
          revision: missingAfter.revision, ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
        }, {
          selectedId: 'selected_existing', action: 'EXISTING', path: 'existing.md',
          revision: existingAfter.revision, ancestorIdentityDigest: `sha256:${'5'.repeat(64)}`,
        }],
      },
    }), error => error?.code === 'SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE');
    const recoveryDirectory = path.join(item.project.rootPath, '.writcraft/recovery');
    assert.strictEqual(fs.existsSync(recoveryDirectory) &&
      fs.readdirSync(recoveryDirectory).some(name => name.endsWith('.bin')), false);
  } finally { item.cleanup(); }
});

test('artifact raw-byte accountant rejects 80/160 MiB envelopes before encoding or copying', () => {
  const metadataState = byteLength => ({ exists: true, byteLength });
  assert.throws(() => recoveryArtifact.accountSnapshotStateBudget([{
    before: { exists: false, byteLength: 0 },
    after: metadataState(80 * 1024 * 1024),
  }]), error => error?.code === 'CHANGES_RECOVERY_ARTIFACT_TOO_LARGE');
  assert.throws(() => recoveryArtifact.accountSnapshotStateBudget([{
    before: metadataState(64 * 1024 * 1024),
    after: metadataState(64 * 1024 * 1024),
  }, {
    before: metadataState(16 * 1024 * 1024),
    after: metadataState(16 * 1024 * 1024),
  }]), error => error?.code === 'CHANGES_RECOVERY_ARTIFACT_TOO_LARGE');
});

test('prepareSnapshotRestore rejects accessor, hidden and sparse files with zero getter calls', () => {
  const item = fixture();
  let getterCalls = 0;
  try {
    const transaction = createChangesHistoryTransaction({
      projectService,
      publicMarkdownLifecycle: dormantPublicMarkdownLifecycle([]),
    });
    const base = missingRestoreArgs(item);
    const accessorFile = { ...base.files[0] };
    Object.defineProperty(accessorFile, 'before', {
      enumerable: true,
      get() { getterCalls += 1; return absent(); },
    });
    assert.throws(() => transaction.prepareSnapshotRestore({ ...base, files: [accessorFile] }),
      error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    const hiddenFile = { ...base.files[0] };
    Object.defineProperty(hiddenFile, 'before', { enumerable: false, value: absent() });
    assert.throws(() => transaction.prepareSnapshotRestore({ ...base, files: [hiddenFile] }),
      error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    const identityAccessor = { ...base.files[0] };
    Object.defineProperty(identityAccessor, 'createdIdentityDigest', {
      enumerable: true,
      get() { getterCalls += 1; return null; },
    });
    assert.throws(() => transaction.prepareSnapshotRestore({ ...base, files: [identityAccessor] }),
      error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    const sparse = new Array(1);
    assert.throws(() => transaction.prepareSnapshotRestore({ ...base, files: sparse }),
      error => error?.code === 'INVALID_SNAPSHOT_RESTORE_INPUT');
    assert.strictEqual(getterCalls, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo exposes exact HISTORY_COMMITTED to FINALIZED transaction step', () => {
  const item = fixture();
  const calls = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      }),
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const quarantined = transaction.quarantineSnapshotRestoreUndo(
      prepared,
      transaction.preparePublicMarkdownUndoMarker(prepared)
    );
    const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
      prepared,
      quarantined
    );
    assert.strictEqual(historyCommitted.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(typeof transaction.finalizeSnapshotRestoreUndo, 'function');
    const terminal = transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted);
    assert.strictEqual(terminal.state, 'terminal');
    assert.strictEqual(terminal.outcome, 'undone');
    assert.strictEqual(terminal.publicMarkdownPhase.phase, 'FINALIZED');
    assert.strictEqual(transaction.reconciliation.hasPending(item.project.rootPath), false);
    assert.strictEqual(fs.existsSync(publicFile), false);
    assert.strictEqual(historyService.loadHistory(item.project.rootPath).entries[0].status, 'undone');
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 2);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 2);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    assert.strictEqual(calls.filter(call => call === 'artifactCleanup').length, 1);
    assert.strictEqual(calls.filter(call => call === 'markerClear').length, 1);
  } finally { item.cleanup(); }
});

test('Safe Undo D first response loss retries one exact wire and stops at three calls', () => {
  const item = fixture();
  const calls = [];
  const finalizeWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const transaction = createChangesHistoryTransaction({
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
        throwAfterFinalizeUndo: true,
        finalizeWires,
      }),
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
      prepared,
      transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      )
    );
    const terminal = transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted);
    assert.strictEqual(terminal.outcome, 'undone');
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 3);
    assert.strictEqual(new Set(finalizeWires).size, 1);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo D UNKNOWN at primary and pre-CAS restarts from PREPARED without fresh Q', () => {
  const item = fixture();
  const calls = [];
  const finalizeWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      finalizeUnknownCalls: [1, 3],
      finalizeWires,
    });
    const options = {
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    };
    const transaction = createChangesHistoryTransaction(options);
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
      prepared,
      transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      )
    );
    assert.throws(
      () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
    assert.strictEqual(retained.publicMarkdownUndoFinalization.state, 'PREPARED');
    const qReconcileCalls = calls.filter(call => call === 'reconcileUndo').length;
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 3);
    assert.deepStrictEqual(
      createChangesHistoryReconciliationService(options).query(
        item.project.rootPath,
        item.project.projectId
      ),
      { ok: true, recovery: null }
    );
    assert.strictEqual(calls.filter(call => call === 'reconcileUndo').length, qReconcileCalls);
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 5);
    assert.strictEqual(new Set(finalizeWires).size, 1);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo A committed response loss restarts only from stored FINALIZED authority', () => {
  const item = fixture();
  const calls = [];
  const ackWires = [];
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const lifecycle = exactOnceUndoLifecycle(calls, {
      quarantinePublic() { fs.unlinkSync(publicFile); },
      throwAfterAckCount: 2,
      ackWires,
    });
    const options = {
      projectService,
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: lifecycle,
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    };
    const transaction = createChangesHistoryTransaction(options);
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
      prepared,
      transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      )
    );
    assert.throws(
      () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
      error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'FINALIZED');
    assert.strictEqual(retained.publicMarkdownUndoFinalization.state, 'COMMITTED');
    assert(retained.publicMarkdownUndoFinalization.finalRecordIdentity);
    assert(retained.publicMarkdownUndoFinalization.ackRequest);
    const dCalls = calls.filter(call => call === 'finalizeUndo').length;
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 2);
    assert.deepStrictEqual(
      createChangesHistoryReconciliationService(options).query(
        item.project.rootPath,
        item.project.projectId
      ),
      { ok: true, recovery: null }
    );
    assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, dCalls);
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 4);
    assert.strictEqual(new Set(ackWires).size, 1);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo FINALIZED rename durability loss re-fsyncs on restart before A or cleanup', () => {
  const item = fixture();
  const calls = [];
  let armFinalizedFsync = false;
  let finalizedFsyncAttempts = 0;
  try {
    const applied = appliedCreatedSnapshot(item);
    const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
    const fileSystem = Object.create(fs);
    fileSystem.fsyncSync = fd => {
      if (armFinalizedFsync) {
        armFinalizedFsync = false;
        finalizedFsyncAttempts += 1;
        if (finalizedFsyncAttempts === 1) throw Object.assign(new Error('lost FINALIZED dir fsync'), { code: 'EIO' });
      }
      return fs.fsyncSync(fd);
    };
    const options = {
      projectService,
      fileSystem,
      beforeMarkerDurabilityFsync({ marker }) {
        if (marker.publicMarkdownPhase.phase === 'FINALIZED') armFinalizedFsync = true;
      },
      exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
      exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
      publicMarkdownLifecycle: exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
      }),
      snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
    };
    const reconciliation = createChangesHistoryReconciliationService(options);
    const transaction = createChangesHistoryTransaction({
      ...options,
      reconciliationService: reconciliation,
    });
    const prepared = transaction.prepareSnapshotRestoreUndo({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      entryId: applied.entryId,
    });
    const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
      prepared,
      transaction.quarantineSnapshotRestoreUndo(
        prepared,
        transaction.preparePublicMarkdownUndoMarker(prepared)
      )
    );
    assert.throws(
      () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
      error => error?.code === 'CHANGES_RECOVERY_WRITE_FAILED'
    );
    const retained = transaction.reconciliation.readMarker(item.project.rootPath);
    assert.strictEqual(retained.publicMarkdownPhase.phase, 'FINALIZED');
    assert.strictEqual(retained.state, 'applying');
    assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 0);
    assert.deepStrictEqual(
      createChangesHistoryReconciliationService(options).query(
        item.project.rootPath,
        item.project.projectId
      ),
      { ok: true, recovery: null }
    );
    // Attempt 1 is the lost FINALIZED publication proof, attempt 2 is restart
    // terminalization, and attempt 3 reholds the terminal marker immediately
    // before artifact cleanup. All three target the same recovery authority.
    assert.strictEqual(finalizedFsyncAttempts, 3);
    assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
  } finally { item.cleanup(); }
});

test('Safe Undo D final record identity drift blocks FINALIZED CAS for same and new inode', () => {
  for (const kind of ['same', 'new']) {
    const item = fixture();
    const calls = [];
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: exactOnceUndoLifecycle(calls, {
          quarantinePublic() { fs.unlinkSync(publicFile); },
          driftFinalizeIdentityAtCall: 2,
          driftFinalizeIdentityKind: kind,
        }),
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
        prepared,
        transaction.quarantineSnapshotRestoreUndo(
          prepared,
          transaction.preparePublicMarkdownUndoMarker(prepared)
        )
      );
      assert.throws(
        () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
        error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
      );
      const retained = transaction.reconciliation.readMarker(item.project.rootPath);
      assert.strictEqual(retained.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.strictEqual(retained.publicMarkdownUndoFinalization.state, 'PREPARED');
      assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 0);
      assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    } finally { item.cleanup(); }
  }
});

test('Safe Undo D post-adapter window rejects History, root, recovery, artifact and marker drift', () => {
  for (const drift of ['history', 'root', 'recovery', 'artifact', 'marker']) {
    const item = fixture();
    const calls = [];
    let heldRoot = null;
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const recovery = path.join(item.project.rootPath, '.writcraft/recovery');
      const markerPath = path.join(recovery, 'changes-history-transaction.json');
      const lifecycle = exactOnceUndoLifecycle(calls, {
        quarantinePublic() { fs.unlinkSync(publicFile); },
        afterFinalizeReturn(callCount) {
          if (callCount !== 1) return;
          if (drift === 'history') {
            const historyPath = path.join(item.project.rootPath, historyService.HISTORY_RELATIVE_PATH);
            const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            fs.writeFileSync(historyPath, JSON.stringify(parsed));
            return;
          }
          if (drift === 'root') {
            heldRoot = `${item.project.rootPath}.d-held`;
            fs.renameSync(item.project.rootPath, heldRoot);
            fs.cpSync(heldRoot, item.project.rootPath, { recursive: true });
            fs.chmodSync(path.join(item.project.rootPath, '.writcraft/recovery'), 0o700);
            return;
          }
          if (drift === 'recovery') {
            const held = path.join(item.project.rootPath, '.writcraft/recovery-d-held');
            fs.renameSync(recovery, held);
            fs.cpSync(held, recovery, { recursive: true });
            fs.chmodSync(recovery, 0o700);
            return;
          }
          const target = drift === 'artifact'
            ? path.join(recovery, fs.readdirSync(recovery).find(name => name.endsWith('.bin')))
            : markerPath;
          const held = `${target}.d-held`;
          const replacement = `${target}.d-replacement`;
          fs.copyFileSync(target, replacement);
          fs.chmodSync(replacement, 0o600);
          fs.renameSync(target, held);
          fs.renameSync(replacement, target);
        },
      });
      const transaction = createChangesHistoryTransaction({
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls),
        publicMarkdownLifecycle: lifecycle,
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      });
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
        prepared,
        transaction.quarantineSnapshotRestoreUndo(
          prepared,
          transaction.preparePublicMarkdownUndoMarker(prepared)
        )
      );
      assert.throws(
        () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
        error => ['CHANGES_MANUAL_RECOVERY_REQUIRED', 'CHANGES_RECOVERY_STALE']
          .includes(error?.code)
      );
      const retained = transaction.reconciliation.readMarker(item.project.rootPath);
      assert.strictEqual(retained.publicMarkdownPhase.phase, 'HISTORY_COMMITTED');
      assert.strictEqual(retained.publicMarkdownUndoFinalization.state, 'PREPARED');
      assert.strictEqual(calls.filter(call => call === 'finalizeUndo').length, 1);
      assert.strictEqual(calls.filter(call => call === 'ackUndo').length, 0);
      assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    } finally {
      item.cleanup();
      if (heldRoot && fs.existsSync(heldRoot)) fs.rmSync(heldRoot, { recursive: true, force: true });
    }
  }
});

test('Safe Undo cleanup response loss retains terminal D/A authority for exact restart', () => {
  for (const loss of ['artifact', 'marker']) {
    const item = fixture();
    const calls = [];
    try {
      const applied = appliedCreatedSnapshot(item);
      const publicFile = path.join(item.project.rootPath, 'chapters/new.md');
      const options = {
        projectService,
        exactArtifactLifecycle: durableFakeArtifactLifecycle(calls, {
          throwAfterCleanup: loss === 'artifact',
        }),
        exactMarkerLifecycle: trustedFakeMarkerLifecycle(calls, {
          throwAfterClear: loss === 'marker',
        }),
        publicMarkdownLifecycle: exactOnceUndoLifecycle(calls, {
          quarantinePublic() { fs.unlinkSync(publicFile); },
        }),
        snapshotStateReader: safeUndoSnapshotStateReader(item.project.rootPath, applied),
      };
      const transaction = createChangesHistoryTransaction(options);
      const prepared = transaction.prepareSnapshotRestoreUndo({
        rootPath: item.project.rootPath,
        projectId: item.project.projectId,
        entryId: applied.entryId,
      });
      const historyCommitted = transaction.commitSnapshotRestoreUndoHistory(
        prepared,
        transaction.quarantineSnapshotRestoreUndo(
          prepared,
          transaction.preparePublicMarkdownUndoMarker(prepared)
        )
      );
      assert.throws(
        () => transaction.finalizeSnapshotRestoreUndo(prepared, historyCommitted),
        error => ['CHANGES_RECOVERY_WRITE_FAILED', 'CHANGES_MANUAL_RECOVERY_REQUIRED']
          .includes(error?.code)
      );
      const retained = transaction.reconciliation.readMarker(item.project.rootPath);
      assert.strictEqual(retained.state, 'terminal');
      assert.strictEqual(retained.outcome, 'undone');
      assert.strictEqual(retained.publicMarkdownPhase.phase, 'FINALIZED');
      assert.strictEqual(retained.publicMarkdownUndoFinalization.state, 'COMMITTED');
      assert.deepStrictEqual(
        createChangesHistoryReconciliationService(options).query(
          item.project.rootPath,
          item.project.projectId
        ),
        { ok: true, recovery: null }
      );
      assert.strictEqual(calls.filter(call => call === 'restoreQuarantine').length, 0);
    } finally { item.cleanup(); }
  }
});

assert.strictEqual(passed, 88);
console.log(`\n${passed}/88 Snapshot public-Markdown transaction phase checks passed.`);
