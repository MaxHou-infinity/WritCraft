'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/evidence-delivery-schema');
const changeHistoryService = require('../src/main/change-history-service');
const publicMarkdownPhaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const {
  createSnapshotRestoreService,
} = require('../src/main/snapshot-restore-service');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');

const PROJECT_INSTANCE_ID = `instance_${'a'.repeat(24)}`;
const SNAPSHOT_ID = 'snapshot_restore_a';
const RESTORE_CAPABILITY_ID = 'snapshot_cap_restore_a';
const MANIFEST_DIGEST = `sha256:${'1'.repeat(64)}`;
const PUBLISHED_DIGEST = `sha256:${'2'.repeat(64)}`;
const COMPARISON_DIGEST = `sha256:${'3'.repeat(64)}`;
const REVISION_SET_DIGEST = `sha256:${'4'.repeat(64)}`;
const ANCESTOR_DIGEST = `sha256:${'5'.repeat(64)}`;
const LEAF_DIGEST = `sha256:${'6'.repeat(64)}`;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function owner() {
  return Object.freeze({
    ownerId: 'window:restore',
    projectInstanceId: PROJECT_INSTANCE_ID,
    ownerGeneration: 7,
  });
}

function request(overrides = {}) {
  return Object.freeze({
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
    projectInstanceId: PROJECT_INSTANCE_ID,
    restoreCapabilityId: RESTORE_CAPABILITY_ID,
    confirmation: 'RESTORE_SELECTED_MARKDOWN',
    ...overrides,
  });
}

function snapshotFile(fileId = 'selected_a', relativePath = 'chapters/a.md', text = 'snapshot A\n') {
  const bytes = Buffer.from(text, 'utf8');
  const hash = digest(bytes);
  return Object.freeze({
    fileId,
    path: relativePath,
    byteLength: bytes.length,
    sha256: hash,
    revision: hash.slice(7),
    content: bytes,
  });
}

function currentFile(fileId = 'selected_a', relativePath = 'chapters/a.md', text = 'current A\n') {
  const bytes = Buffer.from(text, 'utf8');
  const hash = digest(bytes);
  return Object.freeze({
    fileId,
    path: relativePath,
    state: 'available',
    byteLength: bytes.length,
    sha256: hash,
    revision: hash.slice(7),
    content: bytes,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: LEAF_DIGEST,
  });
}

function snapshotAuthority(files = [snapshotFile()]) {
  return Object.freeze({
    projectInstanceId: PROJECT_INSTANCE_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotManifestDigest: MANIFEST_DIGEST,
    publishedIdentityDigest: PUBLISHED_DIGEST,
    comparisonDigest: COMPARISON_DIGEST,
    selectedIds: Object.freeze(files.map(file => file.fileId)),
    files: Object.freeze(files),
  });
}

function currentAuthority(files = [currentFile()]) {
  return Object.freeze({
    projectInstanceId: PROJECT_INSTANCE_ID,
    projectId: 'project-private-a',
    rootPath: '/trusted/private/project-a',
    mutationGeneration: 22,
    fileRevisionSetDigest: REVISION_SET_DIGEST,
    files: Object.freeze(files),
  });
}

function multiConsumed(files) {
  const selectedIds = Object.freeze(files.map(file => file.fileId));
  return Object.freeze({
    record: Object.freeze({ capabilityId: RESTORE_CAPABILITY_ID }),
    selection: Object.freeze({
      compareCapabilityId: 'snapshot_cap_compare_a',
      comparisonDigest: COMPARISON_DIGEST,
      selectedIds,
      currentMutationGeneration: 22,
      currentFileRevisionSetDigest: REVISION_SET_DIGEST,
    }),
    snapshotId: SNAPSHOT_ID,
    snapshotManifestDigest: MANIFEST_DIGEST,
    publishedIdentityDigest: PUBLISHED_DIGEST,
    selected: Object.freeze(files.map(file => Object.freeze({ fileId: file.fileId }))),
  });
}

function terminalTask(truth, code = null) {
  return Object.freeze({
    schema: schema.SCHEMAS.LOCAL_TASK,
    taskId: 'local_restore_a',
    projectInstanceId: PROJECT_INSTANCE_ID,
    kind: 'SNAPSHOT_RESTORE',
    stage: 'completed',
    status: truth === 'COMMITTED' ? 'completed' : 'failed',
    startedAt: '2026-08-08T00:00:00.000Z',
    elapsedMs: 3,
    cancelAvailable: false,
    terminalTruth: truth,
    errorCode: code,
  });
}

function runningTask() {
  return Object.freeze({
    schema: schema.SCHEMAS.LOCAL_TASK,
    taskId: 'local_restore_a',
    projectInstanceId: PROJECT_INSTANCE_ID,
    kind: 'SNAPSHOT_RESTORE',
    stage: 'restoring_markdown',
    status: 'running',
    startedAt: '2026-08-08T00:00:00.000Z',
    elapsedMs: 2,
    cancelAvailable: false,
    terminalTruth: null,
    errorCode: null,
  });
}

function fixture(overrides = {}) {
  const calls = [];
  const operation = {
    taskId: 'local_restore_a',
    signal: new AbortController().signal,
    abortCode: () => null,
    start() { calls.push('start'); },
    stage(value) { calls.push(`stage:${value}`); },
    assertCurrentOwner() { calls.push('assert-operation'); },
    snapshot() { return runningTask(); },
    terminal(truth, code = null) {
      calls.push(`terminal:${truth}:${code}`);
      return terminalTask(truth, code);
    },
  };
  const consumed = Object.freeze({
    record: Object.freeze({ capabilityId: RESTORE_CAPABILITY_ID }),
    selection: Object.freeze({
      compareCapabilityId: 'snapshot_cap_compare_a',
      comparisonDigest: COMPARISON_DIGEST,
      selectedIds: Object.freeze(['selected_a']),
      currentMutationGeneration: 22,
      currentFileRevisionSetDigest: REVISION_SET_DIGEST,
    }),
    snapshotId: SNAPSHOT_ID,
    snapshotManifestDigest: MANIFEST_DIGEST,
    publishedIdentityDigest: PUBLISHED_DIGEST,
    selected: Object.freeze([Object.freeze({ fileId: 'selected_a' })]),
  });
  const prepared = {
    historyEntryId: 'change_restore_a',
    historyPrepared: { record: { id: 'change_restore_a' } },
  };
  const dependencies = {
    localOperations: { begin(value) { calls.push(['begin', value]); return operation; } },
    capabilityStore: {
      consumeRestore(_owner, _request, authority) {
        calls.push(['consume', authority]);
        return consumed;
      },
    },
    acquireLease(value) { calls.push(['acquire', value]); return Object.freeze({ token: 'lease-a' }); },
    releaseLease(_lease, value) { calls.push(['release', value]); return true; },
    assertOwnerCurrent() { calls.push('assert-owner'); },
    settleWatcherBarrier() {
      calls.push('barrier');
      return { projectInstanceId: PROJECT_INSTANCE_ID, mutationGeneration: 22 };
    },
    readSnapshotAuthority() { calls.push('read-snapshot'); return snapshotAuthority(); },
    readCurrentAuthority() { calls.push('read-current'); return currentAuthority(); },
    exactRestoreExecutor(value) {
      calls.push(['execute-native', value]);
      return { ok: true, status: 'applied' };
    },
    reconcileExistingRestore(value) {
      calls.push(['reconcile-existing', value]);
      throw new Error('must not reconcile a normal response');
    },
    transaction: {
      prepareSnapshotRestore(value) {
        calls.push(['prepare', value]);
        return { ...prepared, execute: value.execute };
      },
      execute(value) {
        calls.push(['transaction-execute', value]);
        value.execute();
        return {
          operationId: 'chr_restore_a',
          outcome: 'applied',
          status: 'applied',
          affectedPaths: ['chapters/a.md'],
          recoveryRequired: false,
          responseRecovered: false,
        };
      },
      executeMissingSnapshotRestore(value) {
        calls.push(['transaction-execute-missing', value]);
        return {
          operationId: 'chr_restore_missing_a',
          outcome: 'applied',
          status: 'applied',
          affectedPaths: ['chapters/a.md'],
          recoveryRequired: false,
          responseRecovered: false,
        };
      },
    },
    ...overrides,
  };
  return { service: createSnapshotRestoreService(dependencies), calls, dependencies, consumed, prepared };
}

function realTransactionFixture(overrides = {}) {
  let marker = null;
  const reconciliationService = {
    prepare(_rootPath, value) {
      marker = {
        operationId: 'chr_restore_real',
        projectId: value.projectId,
        kind: value.kind,
        files: value.files,
        outcome: 'pending',
      };
      return marker;
    },
    finish() {
      return { ...marker, outcome: 'applied' };
    },
  };
  const historyService = {
    prepareSnapshotRestoreHistory(_rootPath, files) {
      return {
        record: { id: 'change_restore_real', files },
        baseHistoryState: { exists: false, history: { schema: 'writcraft.changes/v4', entries: [] } },
        preparedHistoryState: { exists: true, history: { schema: 'writcraft.changes/v4', entries: [] } },
      };
    },
  };
  return createChangesHistoryTransaction({
    projectService: { atomicWriteFile() {} },
    historyService,
    reconciliationService,
    ...overrides,
  });
}

function realMissingTransactionFixture(calls) {
  let marker = null;
  const phase = value => ({
    operationId: 'chr_restore_missing_real',
    projectId: 'project-private-a',
    kind: 'snapshot_restore',
    state: value === 'FINALIZED' ? 'terminal' : 'applying',
    outcome: value === 'FINALIZED' ? 'applied' : 'pending',
    files: [{ path: 'chapters/a.md' }],
    publicMarkdownPhase: { phase: value },
  });
  const reconciliationService = {
    prepare() { calls.push('real:precreate'); marker = phase('PRECREATE'); return marker; },
    createMissingLeaves() {
      calls.push('real:create'); marker = phase('CREATED_RECEIPT'); return marker;
    },
    commitMissingRestoreHistory() {
      calls.push('real:history'); marker = phase('HISTORY_COMMITTED'); return marker;
    },
    finalizeMissingRestore() {
      calls.push('real:finalize'); marker = phase('FINALIZED'); marker.state = 'applying'; return marker;
    },
    finish() { calls.push('real:finish'); marker = phase('FINALIZED'); return marker; },
    clear() { calls.push('real:clear'); },
    readMarker() { return marker; },
    query() { return { ok: true, recovery: marker }; },
  };
  const historyTemplate = {
    schema: 'writcraft.snapshot-restore-history-template/v1',
    id: 'change_restore_missing_real',
  };
  const historyService = {
    validateProvenance: changeHistoryService.validateProvenance,
    SNAPSHOT_RESTORE_PROVENANCE_SCHEMA: changeHistoryService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    prepareSnapshotRestoreHistoryTemplate(_rootPath, files) {
      return {
        kind: 'snapshot_restore_template',
        files,
        baseHistoryState: { exists: false, digest: digest(Buffer.alloc(0)).slice(7) },
        historyTemplate,
        historyTemplateDigest: digest(Buffer.from('template')),
      };
    },
  };
  const publicMarkdownLifecycle = {
    create() {},
    finalizeCreate() {},
    reconcile() {},
  };
  return createChangesHistoryTransaction({
    projectService: { atomicWriteFile() {} },
    historyService,
    reconciliationService,
    publicMarkdownLifecycle,
  });
}

test('constructor fails closed when an exact dependency is unavailable', () => {
  assert.throws(() => createSnapshotRestoreService({}), error =>
    error?.message.includes('localOperations'));
});

test('existing Markdown commit seals bytes, consumes once immediately before transaction, and returns the only v1 envelope', async () => {
  const state = fixture();
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.historyEntryId, 'change_restore_a');
  assert.deepStrictEqual(result.history.affectedPaths, ['chapters/a.md']);
  const order = state.calls.map(call => Array.isArray(call) ? call[0] : call);
  assert(order.indexOf('prepare') < order.indexOf('consume'));
  assert(order.indexOf('consume') < order.indexOf('transaction-execute'));
  assert.strictEqual(order.filter(item => item === 'consume').length, 1);
  const preparedArgs = state.calls.find(call => Array.isArray(call) && call[0] === 'prepare')[1];
  const preparedFileForPublicSchema = { ...preparedArgs.files[0] };
  delete preparedFileForPublicSchema.ancestorIdentityDigest;
  schema.assertSnapshotRestoreHistoryFile(preparedFileForPublicSchema);
  assert.match(preparedArgs.files[0].ancestorIdentityDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.strictEqual(preparedArgs.files[0].before.encoding, 'base64');
  assert.strictEqual(preparedArgs.files[0].after.encoding, 'base64');
  assert.strictEqual(Buffer.from(preparedArgs.files[0].after.data, 'base64').toString(), 'snapshot A\n');
  assert.strictEqual(Object.hasOwn(preparedArgs, 'rootPath'), true);
  assert.strictEqual(Object.hasOwn(result, 'rootPath'), false);
});

test('real changes-history transaction normal applied shape commits without redundant service reconciliation', async () => {
  let reconciled = 0;
  const state = fixture({
    transaction: realTransactionFixture(),
    reconcileExistingRestore() {
      reconciled += 1;
      throw new Error('normal result must not reach service reconciliation');
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.historyEntryId, 'change_restore_real');
  assert.strictEqual(result.history.responseRecovered, false);
  assert.strictEqual(reconciled, 0);
});

test('real changes-history response-loss shape is projected once without a second service reconciliation', async () => {
  let executorCalls = 0;
  let reconciled = 0;
  const state = fixture({
    transaction: realTransactionFixture(),
    exactRestoreExecutor() {
      executorCalls += 1;
      throw Object.assign(new Error('native response lost after commit'), {
        code: 'SNAPSHOT_RESTORE_RESPONSE_LOST',
      });
    },
    reconcileExistingRestore() {
      reconciled += 1;
      throw new Error('transaction already returned reconciled marker truth');
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.responseRecovered, true);
  assert.strictEqual(executorCalls, 1);
  assert.strictEqual(reconciled, 0);
});

test('real changes-history committed-warning shape preserves committed risk without redundant service reconciliation', async () => {
  let marker = null;
  let reconciled = 0;
  const transaction = realTransactionFixture({
    reconciliationService: {
      prepare(_rootPath, value) {
        marker = {
          operationId: 'chr_restore_warning',
          projectId: value.projectId,
          kind: value.kind,
          files: value.files,
          outcome: 'pending',
        };
        return marker;
      },
      finish() {
        return { ...marker, outcome: 'committed_warning' };
      },
    },
  });
  const state = fixture({
    transaction,
    reconcileExistingRestore() {
      reconciled += 1;
      throw new Error('committed warning must not reach service reconciliation');
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(result.history.committedWarning, true);
  assert.strictEqual(result.history.recoveryRequired, true);
  assert.strictEqual(reconciled, 0);
  assert.strictEqual(
    state.calls.some(call => Array.isArray(call) && call[0] === 'release'),
    false
  );
});

function crossShapeFixture(rawResult) {
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return rawResult;
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  return { state, reconciled: () => reconciled };
}

async function assertCrossShapeRisk(rawResult) {
  const item = crossShapeFixture(rawResult);
  const result = await item.state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(item.reconciled(), 1);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(result.task.errorCode, 'SNAPSHOT_RESTORE_RESULT_MATRIX_INVALID');
  assert.strictEqual(result.history.committedWarning, true);
  assert.strictEqual(
    item.state.calls.some(call => Array.isArray(call) && call[0] === 'release'),
    false
  );
}

test('production applied key-shape cannot smuggle committed-warning semantics', async () => {
  await assertCrossShapeRisk({
    affectedPaths: ['chapters/a.md'],
    ok: true,
    operationId: 'chr_restore_a',
    outcome: 'committed_warning',
    recoveryRequired: true,
    status: 'committed_warning',
  });
});

test('production recovered key-shape cannot smuggle warning semantics', async () => {
  await assertCrossShapeRisk({
    affectedPaths: ['chapters/a.md'],
    confirmationUnavailable: true,
    ok: true,
    operationId: 'chr_restore_a',
    outcome: 'committed_warning',
    recoveryRequired: true,
    residualUnavailable: false,
    responseRecovered: true,
    status: 'committed_warning',
  });
});

test('production warning key-shape cannot smuggle applied semantics', async () => {
  await assertCrossShapeRisk({
    affectedPaths: ['chapters/a.md'],
    confirmationUnavailable: true,
    ok: true,
    operationId: 'chr_restore_a',
    outcome: 'applied',
    recoveryRequired: false,
    residualUnavailable: false,
    status: 'applied',
    warning: true,
  });
});

test('snapshot authority drift fails before capability consumption or transaction preparation', async () => {
  const state = fixture({
    readSnapshotAuthority() {
      return snapshotAuthority([snapshotFile('selected_b')]);
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_AUTHORITY_INVALID');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'prepare'), false);
});

test('current revision-set drift fails before capability consumption and leaves the transaction untouched', async () => {
  const state = fixture({
    readCurrentAuthority() {
      return { ...currentAuthority(), mutationGeneration: 23 };
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_STALE');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'prepare'), false);
});

test('complete missing selection uses the dedicated transaction without existing-file executor', async () => {
  const missing = {
    fileId: 'selected_a',
    path: 'chapters/a.md',
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  };
  const state = fixture({
    exactRestoreExecutor: null,
    readCurrentAuthority() { return currentAuthority([missing]); },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.historyEntryId, 'change_restore_a');
  const order = state.calls.map(call => Array.isArray(call) ? call[0] : call);
  assert(order.indexOf('prepare') < order.indexOf('consume'));
  assert(order.indexOf('consume') < order.indexOf('transaction-execute-missing'));
  assert.strictEqual(order.filter(item => item === 'consume').length, 1);
  assert.strictEqual(order.filter(item => item === 'execute-native').length, 0);
  assert.strictEqual(order.filter(item => item === 'transaction-execute').length, 0);
  const preparedArgs = state.calls.find(call => Array.isArray(call) && call[0] === 'prepare')[1];
  const binding = publicMarkdownPhaseSchema.assertParentSelectionBinding(
    preparedArgs.parentSelectionBinding
  );
  assert.deepStrictEqual(binding.selected.map(item => item.selectedId), ['selected_a']);
  assert.deepStrictEqual(binding.selected.map(item => item.action), ['MISSING']);
});

test('service consumes and executes the real transaction sealed missing History template identity', async () => {
  const missing = {
    fileId: 'selected_a',
    path: 'chapters/a.md',
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  };
  const integrationCalls = [];
  const state = fixture({
    exactRestoreExecutor: null,
    readCurrentAuthority() { return currentAuthority([missing]); },
    transaction: realMissingTransactionFixture(integrationCalls),
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.historyEntryId, 'change_restore_missing_real');
  assert.deepStrictEqual(integrationCalls, [
    'real:precreate', 'real:create', 'real:history', 'real:finalize', 'real:finish', 'real:clear',
  ]);
  assert.strictEqual(state.calls.filter(call => Array.isArray(call) &&
    call[0] === 'consume').length, 1);
});

test('multi-file missing selection binds every selected ID in exact order to one transaction', async () => {
  const snapshotFiles = [
    snapshotFile('selected_a', 'chapters/a.md', 'snapshot A\n'),
    snapshotFile('selected_b', 'chapters/b.md', 'snapshot B\n'),
  ];
  const missingFiles = snapshotFiles.map(file => ({
    fileId: file.fileId,
    path: file.path,
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  }));
  const state = fixture({
    exactRestoreExecutor: null,
    readSnapshotAuthority() { return snapshotAuthority(snapshotFiles); },
    readCurrentAuthority() { return currentAuthority(missingFiles); },
    capabilityStore: {
      consumeRestore(_owner, _request, authority) {
        state.calls.push(['consume', authority]);
        return multiConsumed(snapshotFiles);
      },
    },
    transaction: {
      prepareSnapshotRestore(value) {
        state.calls.push(['prepare', value]);
        return {
          historyEntryId: 'change_restore_multi',
          historyPrepared: { record: { id: 'change_restore_multi' } },
        };
      },
      execute() { throw new Error('generic execute is forbidden'); },
      executeMissingSnapshotRestore(value) {
        state.calls.push(['transaction-execute-missing', value]);
        return {
          operationId: 'chr_restore_missing_multi',
          outcome: 'applied',
          status: 'applied',
          affectedPaths: snapshotFiles.map(file => file.path),
          recoveryRequired: false,
          responseRecovered: false,
        };
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  const preparedArgs = state.calls.find(call => Array.isArray(call) && call[0] === 'prepare')[1];
  const binding = publicMarkdownPhaseSchema.assertParentSelectionBinding(
    preparedArgs.parentSelectionBinding
  );
  assert.deepStrictEqual(binding.selected.map(item => item.selectedId),
    ['selected_a', 'selected_b']);
  assert.deepStrictEqual(preparedArgs.provenance.selectedIds, ['selected_a', 'selected_b']);
  assert.strictEqual(state.calls.filter(call => Array.isArray(call) &&
    call[0] === 'transaction-execute-missing').length, 1);
});

test('mixed existing and missing selection fails before capability or either executor', async () => {
  const snapshotFiles = [
    snapshotFile('selected_a', 'chapters/a.md', 'snapshot A\n'),
    snapshotFile('selected_b', 'chapters/b.md', 'snapshot B\n'),
  ];
  const missing = {
    fileId: 'selected_b',
    path: 'chapters/b.md',
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  };
  const currents = [currentFile(), missing];
  const state = fixture({
    readSnapshotAuthority() { return snapshotAuthority(snapshotFiles); },
    readCurrentAuthority() { return currentAuthority(currents); },
    capabilityStore: {
      consumeRestore() {
        state.calls.push(['consume', null]);
        return multiConsumed(snapshotFiles);
      },
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_MIXED_SELECTION_UNAVAILABLE');
  for (const forbidden of [
    'consume', 'prepare', 'transaction-execute', 'transaction-execute-missing', 'execute-native',
  ]) {
    assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === forbidden), false);
  }
});

test('post-attempt hostile missing result never falls back to generic execute or reconciliation', async () => {
  const missing = {
    fileId: 'selected_a',
    path: 'chapters/a.md',
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  };
  let getterCalls = 0;
  let genericReconcileCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'operationId', {
    enumerable: true,
    get() { getterCalls += 1; return 'chr_hostile_missing'; },
  });
  const state = fixture({
    exactRestoreExecutor: null,
    readCurrentAuthority() { return currentAuthority([missing]); },
    reconcileExistingRestore() {
      genericReconcileCalls += 1;
      throw new Error('generic reconciliation is forbidden for missing restore');
    },
    transaction: {
      prepareSnapshotRestore(value) {
        state.calls.push(['prepare', value]);
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } } };
      },
      execute() {
        state.calls.push(['transaction-execute']);
        throw new Error('generic execute is forbidden for missing restore');
      },
      executeMissingSnapshotRestore() {
        state.calls.push(['transaction-execute-missing']);
        return hostile;
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'UNKNOWN');
  assert.strictEqual(result.task.errorCode, 'SNAPSHOT_RESTORE_UNKNOWN');
  assert.strictEqual(getterCalls, 0);
  assert.strictEqual(genericReconcileCalls, 0);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) &&
    call[0] === 'transaction-execute'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) &&
    call[0] === 'execute-native'), false);
});

test('owner drift immediately after missing capability consumption performs no transaction mutation', async () => {
  const missing = {
    fileId: 'selected_a',
    path: 'chapters/a.md',
    state: 'missing',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    ancestorIdentityDigest: ANCESTOR_DIGEST,
    leafIdentityDigest: null,
  };
  let consumed = false;
  const state = fixture({
    exactRestoreExecutor: null,
    readCurrentAuthority() { return currentAuthority([missing]); },
    capabilityStore: {
      consumeRestore(_owner, _request, authority) {
        state.calls.push(['consume', authority]);
        consumed = true;
        return state.consumed;
      },
    },
    assertOwnerCurrent() {
      state.calls.push('assert-owner');
      if (consumed) throw Object.assign(new Error('owner changed'), { code: 'PROJECT_CHANGED' });
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'PROJECT_CHANGED');
  assert.strictEqual(consumed, true);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) &&
    call[0] === 'transaction-execute-missing'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) &&
    call[0] === 'transaction-execute'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) &&
    call[0] === 'execute-native'), false);
});

test('conflict authority fails before capability consumption and exact executor', async () => {
  const conflict = {
    ...currentFile(),
    state: 'conflict',
    byteLength: null,
    sha256: null,
    revision: null,
    content: null,
    leafIdentityDigest: null,
  };
  const state = fixture({ readCurrentAuthority() { return currentAuthority([conflict]); } });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_CONFLICT');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
});

test('capability selection mismatch cannot redirect sealed snapshot bytes', async () => {
  const state = fixture({
    capabilityStore: {
      consumeRestore() {
        return { ...state?.consumed, selection: { ...state?.consumed?.selection, selectedIds: ['selected_b'] } };
      },
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_STALE');
  assert.strictEqual(
    state.calls.some(call => Array.isArray(call) && call[0] === 'transaction-execute'),
    false
  );
});

test('native exact executor is mandatory before marker/History preparation', async () => {
  const state = fixture({ exactRestoreExecutor: null });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_EXECUTOR_UNAVAILABLE');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'prepare'), false);
});

test('committed warning maps to COMMITTED_RISK without replay and keeps recovery truth', async () => {
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'committed_warning', status: 'committed_warning',
          affectedPaths: ['chapters/a.md'], recoveryRequired: true, responseRecovered: true,
        };
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(result.history.committedWarning, true);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'execute-native'), true);
});

test('lost execute response reconciles only the existing marker and never replays the mutation', async () => {
  let executeCalls = 0;
  let reconcileCalls = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return {
          historyEntryId: 'change_restore_a',
          historyPrepared: { record: { id: 'change_restore_a' } },
          execute: value.execute,
        };
      },
      execute(prepared) {
        executeCalls += 1;
        prepared.execute();
        throw Object.assign(new Error('response lost'), { code: 'CHANGES_RECOVERY_WRITE_FAILED' });
      },
    },
    reconcileExistingRestore(value) {
      reconcileCalls += 1;
      assert.strictEqual(value.restoreCapabilityId, RESTORE_CAPABILITY_ID);
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(result.history.responseRecovered, true);
  assert.strictEqual(executeCalls, 1);
  assert.strictEqual(reconcileCalls, 1);
  assert.strictEqual(
    state.calls.filter(call => Array.isArray(call) && call[0] === 'execute-native').length,
    1
  );
});

test('manual recovery maps to UNKNOWN and never releases the exact lease as uncommitted', async () => {
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'manual_recovery', status: 'manual_recovery',
          affectedPaths: ['chapters/a.md'], recoveryRequired: true, responseRecovered: false,
        };
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'UNKNOWN');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'release'), false);
});

test('zero-write transaction result maps to UNCOMMITTED and does not claim a History entry', async () => {
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'zero_write_error', status: 'zero_write_error',
          affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: false,
        };
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'UNCOMMITTED');
  assert.strictEqual(result.history.historyEntryId, null);
});

test('project switch after snapshot read fails before current read/consume/marker and releases only its lease', async () => {
  let checks = 0;
  const state = fixture({
    assertOwnerCurrent() {
      checks += 1;
      if (checks >= 3) {
        const error = new Error('switched');
        error.code = 'PROJECT_CHANGED';
        throw error;
      }
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error => error?.code === 'PROJECT_CHANGED');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'release'), true);
});

test('zero exact-executor calls cannot self-certify COMMITTED and reconcile the exact marker once', async () => {
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore() { return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } } }; },
      execute() {
        return {
          operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
          affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: false,
        };
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(reconciled, 1);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
});

test('two exact-executor calls force one exact reconciliation and never return COMMITTED', async () => {
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
          affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: false,
        };
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(reconciled, 1);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(
    state.calls.filter(call => Array.isArray(call) && call[0] === 'execute-native').length,
    1
  );
});

test('post-attempt getter/extra result is never read and routes to marker reconciliation once', async () => {
  let getterReads = 0;
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        const hostile = {
          operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
          affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: false,
          extra: 'forbidden',
        };
        Object.defineProperty(hostile, 'status', { enumerable: true, get() { getterReads += 1; return 'applied'; } });
        return hostile;
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(getterReads, 0);
  assert.strictEqual(reconciled, 1);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
});

test('malformed terminal adapter cannot obscure committed disk truth and returns committed-risk envelope', async () => {
  const broken = fixture({
    localOperations: {
      begin() {
        return {
          taskId: 'local_restore_a',
          signal: new AbortController().signal,
          abortCode: () => null,
          start() {}, stage() {}, assertCurrentOwner() {},
          snapshot() { return runningTask(); },
          terminal() { return { malformed: true }; },
        };
      },
    },
  });
  const result = await broken.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED_RISK');
  assert.strictEqual(result.history.committedWarning, true);
  assert.strictEqual(broken.calls.some(call => Array.isArray(call) && call[0] === 'release'), false);
});

test('sparse affectedPaths result is rejected without element access and reconciled once', async () => {
  let reconciled = 0;
  const sparse = new Array(1);
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
          affectedPaths: sparse, recoveryRequired: false, responseRecovered: false,
        };
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(reconciled, 1);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
});

test('sealed historyEntryId getter is rejected without invocation before capability or marker', async () => {
  let getterReads = 0;
  const prepared = { historyPrepared: { record: { id: 'change_restore_a' } } };
  Object.defineProperty(prepared, 'historyEntryId', {
    enumerable: true,
    get() { getterReads += 1; return 'change_restore_a'; },
  });
  const state = fixture({
    transaction: {
      prepareSnapshotRestore() { return prepared; },
      execute() { throw new Error('must not execute'); },
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_TRANSACTION_INVALID');
  assert.strictEqual(getterReads, 0);
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
});

test('post-attempt path drift is discarded and exact marker authority wins once', async () => {
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
          affectedPaths: ['secret.md'], recoveryRequired: false, responseRecovered: false,
        };
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      return {
        operationId: 'chr_restore_a', outcome: 'applied', status: 'applied',
        affectedPaths: ['chapters/a.md'], recoveryRequired: false, responseRecovered: true,
      };
    },
  });
  const result = await state.service.restore(owner(), request());
  assert.strictEqual(reconciled, 1);
  assert.deepStrictEqual(result.history.affectedPaths, ['chapters/a.md']);
});

test('unavailable exact-marker reconciliation returns a valid UNKNOWN envelope instead of an exception', async () => {
  let reconciled = 0;
  const state = fixture({
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        throw Object.assign(new Error('/private/body response lost'), {
          code: 'CHANGES_RECOVERY_WRITE_FAILED',
        });
      },
    },
    reconcileExistingRestore() {
      reconciled += 1;
      throw new Error('/private/body reconciliation unavailable');
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(reconciled, 1);
  assert.strictEqual(result.task.terminalTruth, 'UNKNOWN');
  assert.strictEqual(result.task.errorCode, 'SNAPSHOT_RESTORE_UNKNOWN');
  assert.strictEqual(result.history.recoveryRequired, true);
});

test('invalid digest and invalid UTF-8 are preconsume zero-write authority failures', async () => {
  const badDigest = fixture({
    readSnapshotAuthority() {
      return { ...snapshotAuthority(), snapshotManifestDigest: 'sha256:bad' };
    },
  });
  await assert.rejects(badDigest.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_AUTHORITY_INVALID');
  assert.strictEqual(badDigest.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);

  const bytes = Buffer.from([0xc3, 0x28]);
  const hash = digest(bytes);
  const badUtf8 = snapshotFile();
  const hostile = Object.freeze({
    ...badUtf8,
    byteLength: bytes.length,
    sha256: hash,
    revision: hash.slice(7),
    content: bytes,
  });
  const utf8 = fixture({ readSnapshotAuthority() { return snapshotAuthority([hostile]); } });
  await assert.rejects(utf8.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_AUTHORITY_INVALID');
  assert.strictEqual(utf8.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
});

test('Markdown byte budget rejects one byte above the frozen per-file limit before copying bytes', async () => {
  const normal = snapshotFile();
  const oversized = Object.freeze({
    ...normal,
    byteLength: schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes + 1,
  });
  const state = fixture({ readSnapshotAuthority() { return snapshotAuthority([oversized]); } });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_AUTHORITY_INVALID');
  assert.strictEqual(state.calls.some(call => Array.isArray(call) && call[0] === 'consume'), false);
});

test('64 MiB aggregate plus one byte fails before any clone or base64 encoding', async () => {
  let clones = 0;
  let encodes = 0;
  const emptyHash = digest(Buffer.alloc(0));
  const files = [];
  for (let index = 0; index < 17; index += 1) {
    const byteLength = index < 16 ? schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes : 1;
    files.push(Object.freeze({
      fileId: `selected_${index}`,
      path: `chapters/${index}.md`,
      byteLength,
      sha256: emptyHash,
      revision: emptyHash.slice(7),
      content: Buffer.alloc(0),
    }));
  }
  const state = fixture({
    cloneBytes(value) { clones += 1; return Buffer.from(value); },
    encodeBase64(value) { encodes += 1; return value.toString('base64'); },
    readSnapshotAuthority() { return snapshotAuthority(files); },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_BUDGET_EXCEEDED');
  assert.strictEqual(clones, 0);
  assert.strictEqual(encodes, 0);
});

test('128 MiB combined aggregate plus one fails before snapshot/current clone or encoding', async () => {
  let clones = 0;
  let encodes = 0;
  const emptyHash = digest(Buffer.alloc(0));
  const snapshots = [];
  const currents = [];
  for (let index = 0; index < 17; index += 1) {
    const fileId = `selected_${index}`;
    const relativePath = `chapters/${index}.md`;
    snapshots.push(Object.freeze({
      fileId,
      path: relativePath,
      byteLength: 1,
      sha256: emptyHash,
      revision: emptyHash.slice(7),
      content: Buffer.alloc(0),
    }));
    currents.push(Object.freeze({
      fileId,
      path: relativePath,
      state: 'available',
      byteLength: index < 16 ? 8 * 1024 * 1024 : 1,
      sha256: emptyHash,
      revision: emptyHash.slice(7),
      content: Buffer.alloc(0),
      ancestorIdentityDigest: ANCESTOR_DIGEST,
      leafIdentityDigest: LEAF_DIGEST,
    }));
  }
  const state = fixture({
    cloneBytes(value) { clones += 1; return Buffer.from(value); },
    encodeBase64(value) { encodes += 1; return value.toString('base64'); },
    readSnapshotAuthority() { return snapshotAuthority(snapshots); },
    readCurrentAuthority() { return currentAuthority(currents); },
  });
  await assert.rejects(state.service.restore(owner(), request()), error =>
    error?.code === 'SNAPSHOT_RESTORE_BUDGET_EXCEEDED');
  assert.strictEqual(clones, 0);
  assert.strictEqual(encodes, 0);
});

test('exact maximum-size Markdown remains inside the frozen restore envelope', async () => {
  const bytes = Buffer.alloc(schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes, 0x61);
  const hash = digest(bytes);
  const maximum = Object.freeze({
    fileId: 'selected_a',
    path: 'chapters/a.md',
    byteLength: bytes.length,
    sha256: hash,
    revision: hash.slice(7),
    content: bytes,
  });
  const state = fixture({ readSnapshotAuthority() { return snapshotAuthority([maximum]); } });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  const native = state.calls.find(call => Array.isArray(call) && call[0] === 'execute-native')[1];
  assert.strictEqual(native.bindings[0].after.byteLength, schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes);
});

test('exact 64 MiB multi-file aggregate seals once per snapshot/current file and commits', async () => {
  let clones = 0;
  let encodes = 0;
  const bytes = Buffer.alloc(schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes, 0x61);
  const hash = digest(bytes);
  const empty = Buffer.alloc(0);
  const emptyHash = digest(empty);
  const snapshots = [];
  const currents = [];
  for (let index = 0; index < 16; index += 1) {
    const fileId = `selected_${index}`;
    const relativePath = `chapters/${index}.md`;
    snapshots.push(Object.freeze({
      fileId,
      path: relativePath,
      byteLength: bytes.length,
      sha256: hash,
      revision: hash.slice(7),
      content: bytes,
    }));
    currents.push(currentFile(fileId, relativePath, ''));
  }
  const state = fixture({
    cloneBytes(value) { clones += 1; return Buffer.from(value); },
    encodeBase64(value) { encodes += 1; return value.toString('base64'); },
    readSnapshotAuthority() { return snapshotAuthority(snapshots); },
    readCurrentAuthority() { return currentAuthority(currents); },
    capabilityStore: {
      consumeRestore(_owner, _request, authority) {
        assert.strictEqual(authority.currentFileRevisionSetDigest, REVISION_SET_DIGEST);
        return multiConsumed(snapshots);
      },
    },
    transaction: {
      prepareSnapshotRestore(value) {
        return { historyEntryId: 'change_restore_a', historyPrepared: { record: { id: 'change_restore_a' } }, execute: value.execute };
      },
      execute(prepared) {
        prepared.execute();
        return {
          operationId: 'chr_restore_a',
          outcome: 'applied',
          status: 'applied',
          affectedPaths: snapshots.map(file => file.path),
          recoveryRequired: false,
          responseRecovered: false,
        };
      },
    },
  });
  const result = await state.service.restore(owner(), request());
  schema.assertSnapshotRestoreResult(result);
  assert.strictEqual(result.task.terminalTruth, 'COMMITTED');
  assert.strictEqual(clones, 32);
  assert.strictEqual(encodes, 32);
  assert.strictEqual(emptyHash, digest(empty));
});

test('adapter messages and bodies are never exposed through the public service error', async () => {
  const state = fixture({
    readSnapshotAuthority() {
      throw Object.assign(new Error('/Users/private/project/secret.md BODY-CONTENT'), {
        code: 'PROJECT_CHANGED',
      });
    },
  });
  await assert.rejects(state.service.restore(owner(), request()), error => {
    assert.strictEqual(error.code, 'PROJECT_CHANGED');
    assert.strictEqual(error.message.includes('/Users/private'), false);
    assert.strictEqual(error.message.includes('BODY-CONTENT'), false);
    return true;
  });
});

(async () => {
  let passed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`  OK ${item.name}`);
    } catch (error) {
      console.error(`  FAIL ${item.name}`);
      throw error;
    }
  }
  console.log(`\n${passed}/${tests.length} Snapshot restore service checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
