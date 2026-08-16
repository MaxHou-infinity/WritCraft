#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');

const sha = value => `sha256:${String(value).repeat(64)}`;
const journalId = `chrj_${'a'.repeat(48)}`;
const operationId = `chr_${'b'.repeat(48)}`;

function markerFixture(
  projectId = 'project-journal-fixture',
  kind = 'snapshot_restore_undo',
  markerOperationId = operationId
) {
  return sealMarker({
    schema: 'writcraft.changes-history-recovery/v1',
    operationId: markerOperationId,
    projectId,
    kind,
    state: 'applying',
    outcome: null,
    files: [{ path: 'chapter.md', beforeRevision: '1'.repeat(64), afterRevision: '2'.repeat(64) }],
    baseHistoryState: { exists: true, digest: '3'.repeat(64) },
    preparedHistoryState: { exists: true, digest: '4'.repeat(64) },
    recoveryWritePending: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
  });
}

function sealMarker(raw) {
  const { integrity: _integrity, ...payload } = raw;
  return {
    ...payload,
    integrity: crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  };
}

function activeAuthority(projectId = 'project-journal-fixture', kind, markerOperationId) {
  const activeMarker = markerFixture(projectId, kind, markerOperationId);
  return { activeMarker, activeMarkerDigest: journal.activeMarkerDigest(activeMarker) };
}

function sealValue(raw) {
  const value = { ...raw, valueDigest: null };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function initialValue() {
  return sealValue({
    schema: journal.SCHEMAS.VALUE,
    journalId,
    generation: '0',
    previousValueDigest: null,
    state: 'IDLE',
    projectId: 'project-journal-fixture',
    activeOperationId: null,
    activeKind: null,
    activeMarker: null,
    activeMarkerDigest: null,
    nativePublication: null,
    existingTerminalPublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
  });
}

function advance(previous, patch) {
  return sealValue({
    ...previous,
    ...patch,
    generation: journal.nextGeneration(previous.generation),
    previousValueDigest: previous.valueDigest,
  });
}

function mutation(state, seed = '4') {
  return {
    schema: journal.SCHEMAS.MUTATION,
    state,
    sourceIdentityDigest: state === 'UNARMED' ? null : sha(seed),
    privateBasename: state === 'UNARMED'
      ? null
      : `.changes-history-native-private.${seed.repeat(32)}`,
    directoryFsyncComplete: state === 'COMMITTED',
  };
}

function identity(seed, digest) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(100 + seed),
    ino: String(200 + seed),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(20 + seed),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: digest,
  };
}

function record(state = 'ARMED', seed = 1) {
  const recordDigest = `sha256:${seed.toString(16).padStart(64, '0')}`;
  return {
    schema: journal.SCHEMAS.RECORD,
    role: 'CONTROL',
    ordinal: seed - 1,
    state,
    stageBasename: `.changes-history-native-stage.${seed.toString(16).padStart(32, '0')}`,
    destinationBasename: `.changes-history-native-control.${seed.toString(16).padStart(64, '0')}`,
    cleanupBasename: ['CLEANUP_ARMED', 'REMOVED'].includes(state)
      ? `.changes-history-native-stage.${(seed + 500).toString(16).padStart(32, '0')}`
      : null,
    recordDigest,
    recordIdentity: identity(seed, recordDigest),
  };
}

function createPrivateRecord(role, state, seed, item, pairSuffix, boundControlDigest = null) {
  const rawSha256 = `sha256:${(seed % 15 + 1).toString(16).repeat(64)}`;
  return {
    schema: journal.SCHEMAS.CREATE_PRIVATE_RECORD,
    role,
    selectedId: item.selectedId,
    path: item.path,
    contentDigest: item.contentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    deterministicBasename: role === 'CONTROL'
      ? `.changes-history-native-create-control.${pairSuffix}`
      : `.changes-history-native-create-receipt.${pairSuffix}`,
    logicalDigest: `sha256:${((seed + 1) % 15 + 1).toString(16).repeat(64)}`,
    boundControlDigest,
    rawSha256,
    recordIdentity: identity(seed + 1000, rawSha256),
    state,
    cleanupBasename: state === 'PUBLISHED'
      ? null
      : `.changes-history-native-create-cleanup.${
        (seed + 5000).toString(16).padStart(64, '0')
      }`,
  };
}

function createCapture(count = 1, state = 'PUBLISHED', removedRecords = 0) {
  let recordOrdinal = 0;
  return {
    schema: journal.SCHEMAS.CREATE_CAPTURE,
    items: Array.from({ length: count }, (_, index) => {
      const contentDigest = `sha256:${((index % 9) + 1).toString().repeat(64)}`;
      const itemAuthority = {
        selectedId: `missing:${index}`,
        path: `chapter-${index}.md`,
        contentDigest,
        ancestorIdentityDigest: sha(((index + 1) % 9) + 1),
      };
      const controlState = recordOrdinal++ < removedRecords ? 'REMOVED' : state;
      const receiptState = recordOrdinal++ < removedRecords ? 'REMOVED' : state;
      const pairSuffix = (index + 1).toString(16).padStart(64, '0');
      const control = createPrivateRecord(
        'CONTROL', controlState, index * 2 + 1, itemAuthority, pairSuffix
      );
      const receipt = createPrivateRecord(
        'RECEIPT', receiptState, index * 2 + 2, itemAuthority, pairSuffix,
        control.logicalDigest
      );
      return {
        schema: journal.SCHEMAS.CREATE_CAPTURE_ITEM,
        ordinal: index,
        ...itemAuthority,
        createdLeafIdentity: identity(index + 2000, contentDigest),
        creationReceiptDigest: receipt.logicalDigest,
        control,
        receipt,
      };
    }),
  };
}

function createFinalizationFixture(committedPublication, capture) {
  const artifactDigest = sha('c');
  const historyCommittedPhaseDigest = sha('d');
  const finalizeRequest = {
    schema: 'writcraft.changes-history-native-create-finalize-request/v1',
    operationId,
    artifactDigest,
    selectionDigest: sha('e'),
    historyCommittedPhaseDigest,
    tokens: capture.items.map(item => ({
      schema: 'writcraft.changes-history-native-create-token/v1',
      operationId,
      selectedId: item.selectedId,
      controlBasename: item.control.deterministicBasename,
      receiptBasename: item.receipt.deterministicBasename,
      controlDigest: item.control.logicalDigest,
      createdIdentityDigest: evidence.digestObjectIdentity(item.createdLeafIdentity),
      contentDigest: item.contentDigest,
      receiptDigest: item.receipt.logicalDigest,
    })),
  };
  const finalAck = {
    schema: 'writcraft.changes-history-native-create-final-ack/v1',
    operationId,
    artifactDigest,
    selectionDigest: finalizeRequest.selectionDigest,
    historyCommittedPhaseDigest,
    receiptSetDigest: sha('f'),
    itemCount: capture.items.length,
    recoveryFsyncComplete: true,
    finalAckDigest: sha('1'),
  };
  const prepared = {
    schema: journal.SCHEMAS.CREATE_FINALIZATION,
    state: 'PREPARED',
    operationId,
    finalizeRequest,
    finalizeRequestDigest: evidence.digestObject(finalizeRequest.schema, finalizeRequest),
    historyCommittedPhaseDigest,
    rawPreparedHistoryStateDigest: sha('2'),
    artifactByteLength: 10,
    artifactDigest,
    artifactIdentity: { ...identity(9000, artifactDigest), size: '10' },
    committedPublicationDigest: committedPublication.publicationDigest,
    createCaptureDigest: evidence.digestObject(journal.SCHEMAS.CREATE_CAPTURE, capture),
    finalBasename: `.changes-history-native-create-final.${'3'.repeat(64)}`,
    finalAck,
    finalAckDigest: finalAck.finalAckDigest,
    finalRecordIdentity: null,
    previousFinalizationDigest: null,
    finalizationDigest: null,
  };
  prepared.finalizationDigest = journal.createFinalizationDigest(prepared);
  const validPrepared = journal.assertCreateFinalization(prepared);
  const captured = {
    ...validPrepared,
    state: 'CAPTURED',
    finalRecordIdentity: identity(9001, sha('4')),
    previousFinalizationDigest: validPrepared.finalizationDigest,
    finalizationDigest: null,
  };
  captured.finalizationDigest = journal.createFinalizationDigest(captured);
  return {
    prepared: validPrepared,
    captured: journal.assertCreateFinalization(captured),
  };
}

function armCreateCleanup(capture, finalAckDigest) {
  let ordinal = 0;
  return {
    ...capture,
    items: capture.items.map(item => ({
      ...item,
      control: armRecord(item.control, ordinal++),
      receipt: armRecord(item.receipt, ordinal++),
    })),
  };

  function armRecord(record, recordOrdinal) {
    const key = {
      schema: 'writcraft.public-markdown-create-cleanup-name-key/v1',
      operationId,
      finalAckDigest,
      ordinal: recordOrdinal,
      role: record.role,
      sourceBasename: record.deterministicBasename,
      recordDigest: record.rawSha256,
    };
    return {
      ...record,
      state: 'CLEANUP_ARMED',
      cleanupBasename: `.changes-history-native-create-cleanup.${
        evidence.digestObject(key.schema, key).slice(7)
      }`,
    };
  }
}

function removeCreateCleanupRecords(capture, removedRecords) {
  let ordinal = 0;
  return {
    ...capture,
    items: capture.items.map(item => ({
      ...item,
      control: progress(item.control, ordinal++),
      receipt: progress(item.receipt, ordinal++),
    })),
  };

  function progress(record, recordOrdinal) {
    return {
      ...record,
      state: recordOrdinal < removedRecords ? 'REMOVED' : 'CLEANUP_ARMED',
    };
  }
}

function preparedCreatePublication() {
  return sealPublication({
    schema: journal.SCHEMAS.PUBLICATION,
    kind: 'snapshot_restore',
    command: 'CREATE_MISSING',
    state: 'PREPARED',
    operationId,
    requestDigest: sha('a'),
    phaseDigest: sha('b'),
    previousPublicationDigest: null,
    records: [],
    mutation: mutation('UNARMED'),
    createCapture: null,
  });
}

function sealPublication(raw) {
  const value = {
    createAttemptDigest: null,
    createFinalization: null,
    createCleanupFinalBasename: null,
    createCleanupFinalRecordIdentity: null,
    ...raw,
    publicationDigest: null,
  };
  value.publicationDigest = journal.publicationDigest(value);
  return journal.assertPublication(value);
}

function preparedPublication() {
  return sealPublication({
    schema: journal.SCHEMAS.PUBLICATION,
    kind: 'snapshot_restore_undo',
    command: 'QUARANTINE',
    state: 'PREPARED',
    operationId,
    requestDigest: sha('1'),
    phaseDigest: sha('2'),
    previousPublicationDigest: null,
    records: [],
    mutation: mutation('UNARMED'),
    createCapture: null,
  });
}

function advancePublication(previous, patch) {
  return sealPublication({
    ...previous,
    ...patch,
    previousPublicationDigest: previous.publicationDigest,
  });
}

function terminalCleanup(publication) {
  return journal.buildTerminalCleanup({
    schema: journal.SCHEMAS.CLEANUP,
    operationId,
    kind: 'snapshot_restore_undo',
    terminalPhaseDigest: sha('5'),
    historyStateDigest: sha('6'),
    artifactCleanupDigest: sha('7'),
    publicRecordDigests: [sha('8')],
    publicationState: 'ACK_COMMITTED',
    publicationDigest: publication.publicationDigest,
    existingTerminalPublicationState: 'NONE',
    existingTerminalPublicationDigest: null,
    recoveryDirectoryFsyncComplete: true,
  });
}

function existingLeafIdentity(selectedId, seed = '9', index = 0) {
  const revision = seed.repeat(64);
  return {
    schema: 'writcraft.public-markdown-existing-leaf-identity/v1',
    selectedId,
    path: `chapter-${index}.md`,
    revision,
    ancestorIdentityDigest: sha('8'),
    dev: String(1001 + index),
    ino: String(2001 + index),
    uid: 501,
    mode: 0o644,
    nlink: 1,
    size: '64',
    mtimeNs: '3001',
    ctimeNs: '4001',
    contentSha256: `sha256:${revision}`,
  };
}

function existingTerminalItems(count) {
  return Array.from({ length: count }, (_, index) => {
    const selectedId = `existing:${index}`;
    const hex = ((index % 15) + 1).toString(16);
    const suffix = (index + 1).toString(16).padStart(64, '0');
    return {
      schema: journal.SCHEMAS.EXISTING_TERMINAL_ITEM,
      ordinal: index,
      selectedId,
      finalContentDigest: sha(hex),
      finalLeafIdentity: existingLeafIdentity(selectedId, hex, index),
      controlBasename: `.changes-history-native-existing-control.${suffix}`,
      controlDigest: sha(((index + 1) % 15 + 1).toString(16)),
      controlRecordIdentity: identity(3000 + index * 2, sha(hex)),
      applyBasename: `.changes-history-native-existing-apply.${suffix}`,
      applyReceiptDigest: sha(((index + 2) % 15 + 1).toString(16)),
      applyRecordIdentity: identity(3001 + index * 2, sha(hex)),
    };
  });
}

function existingTerminalPublication(previousValue, patch = {}) {
  const publication = {
    schema: journal.SCHEMAS.EXISTING_TERMINAL_PUBLICATION,
    command: 'EXECUTE_EXISTING',
    state: 'COMMITTED',
    operationId,
    requestDigest: sha('1'),
    createdReceiptPhaseDigest: sha('2'),
    markerDigest: sha('3'),
    artifactDigest: sha('4'),
    artifactIdentityDigest: sha('5'),
    selectionDigest: sha('6'),
    baseHistoryDigest: sha('7'),
    baseHistoryByteLength: 2,
    baseHistoryExists: true,
    baseHistoryContentDigest: sha('7'),
    historyParentIdentityDigest: sha('8'),
    projectRootIdentityDigest: sha('9'),
    recoveryDirectoryIdentityDigest: sha('a'),
    predecessorValueDigest: previousValue.valueDigest,
    installedGeneration: journal.nextGeneration(previousValue.generation),
    items: existingTerminalItems(1),
    receiptSetDigest: sha('1'),
    terminalReceiptDigest: sha('2'),
    recoveryFsyncComplete: true,
    finalization: null,
    ...patch,
    publicationDigest: null,
  };
  publication.publicationDigest = journal.existingTerminalPublicationDigest(publication);
  return journal.assertExistingTerminalPublication(publication);
}

function existingFinalization() {
  const finalRecordDigest = sha('3');
  const finalization = {
    schema: journal.SCHEMAS.EXISTING_FINALIZATION,
    finalizeRequestDigest: sha('4'),
    historyCommittedPhaseDigest: sha('5'),
    finalBasename: `.changes-history-native-existing-final.${'6'.repeat(64)}`,
    finalRecordDigest,
    finalRecordIdentity: identity(4000, finalRecordDigest),
    markerFinalizedPhaseDigest: sha('7'),
    finalizationDigest: null,
  };
  finalization.finalizationDigest = journal.existingFinalizationDigest(finalization);
  return journal.assertExistingFinalization(finalization, operationId);
}

function advanceExistingPublication(previous, patch) {
  const publication = {
    ...previous,
    ...patch,
    publicationDigest: null,
  };
  publication.publicationDigest = journal.existingTerminalPublicationDigest(publication);
  return journal.assertExistingTerminalPublication(publication);
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_CHANGES_HISTORY_MARKER_JOURNAL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('CREATE_MISSING exposes durable finalization authority schema', () => {
  assert.strictEqual(typeof journal.assertCreateFinalization, 'function');
  assert.strictEqual(typeof journal.createFinalizationDigest, 'function');
});

console.log('\nChanges/History permanent marker journal pure-schema verification');

assert.strictEqual(journal.SCHEMAS.CREATE_CAPTURE,
  'writcraft.changes-history-native-create-capture/v1');

test('initial IDLE and canonical A/B frames have a hard independent golden', () => {
  const idle = initialValue();
  const frameA = journal.encodeSlotFrame(idle, 'A');
  const frameB = journal.encodeSlotFrame(idle, 'B');
  assert.deepStrictEqual({
    valueDigest: idle.valueDigest,
    bytesA: frameA.length,
    shaA: crypto.createHash('sha256').update(frameA).digest('hex'),
    bytesB: frameB.length,
    shaB: crypto.createHash('sha256').update(frameB).digest('hex'),
  }, {
    valueDigest: 'sha256:2b9f55bf364fb0100d01b7f25aa844a1513a0ad90a3576a49d7c03b8351bec02',
    bytesA: 734,
    shaA: 'b9518ab46066344546d6fb03d4ff8f452f55113f0d15c1dc5e60d555cf1f9896',
    bytesB: 734,
    shaB: '8407625cce247d80997be7c59d75d68a0e09a01d3077cf347c0828f3d4aeb4d8',
  });
  assert.deepStrictEqual(journal.parseSlotFrame(frameA), { slot: 'A', value: idle });
  assert.deepStrictEqual(journal.parseSlotFrame(frameB), { slot: 'B', value: idle });
});

test('IDLE to ACTIVE binds one operation and exact previous value generation', () => {
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    ...activeAuthority(),
  });
  assert.deepStrictEqual(journal.assertTransition(idle, active), active);
  invalid(() => journal.assertTransition(idle, sealValue({
    ...active,
    generation: '2',
    previousValueDigest: idle.valueDigest,
  })));
  invalid(() => journal.assertTransition(idle, sealValue({
    ...active,
    generation: '1',
    previousValueDigest: sha('9'),
  })));
});

test('ACTIVE snapshot restore can durably carry an exact EXISTING terminal publication', () => {
  const idle = initialValue();
  const createdReceiptMarker = sealMarker({
    ...markerFixture('project-journal-fixture', 'snapshot_restore'),
    publicMarkdownPhase: { phase: 'CREATED_RECEIPT' },
  });
  const active = advance(idle, {
    state: 'ACTIVE', activeOperationId: operationId,
    activeKind: 'snapshot_restore',
    activeMarker: createdReceiptMarker,
    activeMarkerDigest: journal.activeMarkerDigest(createdReceiptMarker),
  });
  const existingCommittedMarker = sealMarker({
    ...createdReceiptMarker,
    publicMarkdownPhase: { phase: 'EXISTING_COMMITTED' },
  });
  const publication = existingTerminalPublication(active);
  const next = advance(active, {
    activeMarker: existingCommittedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(existingCommittedMarker),
    existingTerminalPublication: publication,
  });
  assert.deepStrictEqual(journal.assertTransition(active, next), next);
  assert.deepStrictEqual(journal.assertExistingTerminalPublication(publication), publication);
  invalid(() => journal.assertTransition(active, advance(active, {
    activeMarker: existingCommittedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(existingCommittedMarker),
    existingTerminalPublication: existingTerminalPublication(active, {
      predecessorValueDigest: sha('f'),
    }),
  })));
});

test('EXISTING terminal publication finalizes, ACKs and binds the ordered cleanup set', () => {
  const idle = initialValue();
  const createdMarker = sealMarker({
    ...markerFixture('project-journal-fixture', 'snapshot_restore'),
    publicMarkdownPhase: { phase: 'CREATED_RECEIPT' },
  });
  const active = advance(idle, {
    state: 'ACTIVE', activeOperationId: operationId, activeKind: 'snapshot_restore',
    activeMarker: createdMarker,
    activeMarkerDigest: journal.activeMarkerDigest(createdMarker),
  });
  const committedMarker = sealMarker({
    ...createdMarker,
    publicMarkdownPhase: { phase: 'EXISTING_COMMITTED' },
  });
  const committedPublication = existingTerminalPublication(active);
  const committed = advance(active, {
    activeMarker: committedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(committedMarker),
    existingTerminalPublication: committedPublication,
  });
  const historyMarker = sealMarker({
    ...committedMarker,
    publicMarkdownPhase: { phase: 'HISTORY_COMMITTED' },
  });
  const history = advance(committed, {
    activeMarker: historyMarker,
    activeMarkerDigest: journal.activeMarkerDigest(historyMarker),
  });
  const finalizedMarker = sealMarker({
    ...historyMarker,
    publicMarkdownPhase: { phase: 'FINALIZED' },
  });
  const finalizedPublication = advanceExistingPublication(committedPublication, {
    state: 'FINALIZED',
    finalization: existingFinalization(),
  });
  const finalized = advance(history, {
    activeMarker: finalizedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(finalizedMarker),
    existingTerminalPublication: finalizedPublication,
  });
  const ackedPublication = advanceExistingPublication(finalizedPublication, {
    state: 'ACK_COMMITTED',
  });
  const acked = advance(finalized, { existingTerminalPublication: ackedPublication });
  assert.deepStrictEqual(journal.assertTransition(committed, history), history);
  assert.deepStrictEqual(journal.assertTransition(history, finalized), finalized);
  assert.deepStrictEqual(journal.assertTransition(finalized, acked), acked);

  const cleanup = journal.buildTerminalCleanup({
    schema: journal.SCHEMAS.CLEANUP,
    operationId,
    kind: 'snapshot_restore',
    terminalPhaseDigest: sha('8'),
    historyStateDigest: sha('9'),
    artifactCleanupDigest: sha('a'),
    publicRecordDigests: [sha('b')],
    publicationState: 'ACK_COMMITTED',
    publicationDigest: sha('c'),
    existingTerminalPublicationState: 'ACK_COMMITTED',
    existingTerminalPublicationDigest: ackedPublication.publicationDigest,
    recoveryDirectoryFsyncComplete: true,
  });
  assert.strictEqual(cleanup.publicationSetDigest, journal.publicationSetDigest(
    operationId,
    'snapshot_restore',
    cleanup.publicationDigest,
    ackedPublication.publicationDigest
  ));
  invalid(() => journal.assertTerminalCleanup({
    ...cleanup,
    existingTerminalPublicationDigest: sha('f'),
  }));
  invalid(() => journal.assertExistingTerminalPublication({
    ...ackedPublication,
    items: [{
      ...ackedPublication.items[0],
      controlRecordIdentity: ackedPublication.items[0].applyRecordIdentity,
    }],
  }));
});

test('EXISTING terminal publication is descriptor-exact, unique and capped at 299 items', () => {
  const active = advance(initialValue(), {
    state: 'ACTIVE', activeOperationId: operationId, activeKind: 'snapshot_restore',
    ...activeAuthority('project-journal-fixture', 'snapshot_restore'),
  });
  const maximum = existingTerminalPublication(active, {
    items: existingTerminalItems(journal.MAX_EXISTING_TERMINAL_ITEMS),
  });
  assert.strictEqual(maximum.items.length, 299);
  assert(evidence.canonicalJsonByteLength(maximum) <=
    journal.MAX_EXISTING_TERMINAL_PUBLICATION_BYTES);
  invalid(() => existingTerminalPublication(active, {
    items: existingTerminalItems(journal.MAX_EXISTING_TERMINAL_ITEMS + 1),
  }));
  invalid(() => journal.assertExistingTerminalPublication({
    ...maximum,
    items: maximum.items.map((item, index) => index === 1
      ? { ...item, controlBasename: maximum.items[0].controlBasename }
      : item),
  }));
  let getterCalls = 0;
  const getter = { ...maximum };
  Object.defineProperty(getter, 'items', {
    enumerable: true,
    get() { getterCalls += 1; return maximum.items; },
  });
  invalid(() => journal.existingTerminalPublicationDigest(getter));
  assert.strictEqual(getterCalls, 0);
});

test('ACTIVE stores one complete marker preimage under an independent hard digest golden', () => {
  const marker = markerFixture();
  assert.deepStrictEqual({
    bytes: evidence.canonicalJsonByteLength(marker),
    integrity: marker.integrity,
    digest: journal.activeMarkerDigest(marker),
  }, {
    bytes: 833,
    integrity: '249b2fd3bade065bd03eb752ccfaf759035c5bd34bfeee77fd570b8ec2aef997',
    digest: 'sha256:4aac84e8c878c81e707ee24c712f5b6562ab8059a9dbac37b1c662909d766fbe',
  });
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    ...activeAuthority(),
  });
  const updatedMarker = sealMarker({ ...marker, updatedAt: '2026-08-10T00:00:02.000Z' });
  const updated = advance(active, {
    activeMarker: updatedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(updatedMarker),
  });
  assert.deepStrictEqual(journal.assertTransition(active, updated), updated);
  for (const patch of [
    { operationId: `chr_${'c'.repeat(48)}` },
    { projectId: 'project-foreign' },
    { kind: 'snapshot_restore' },
  ]) {
    const drifted = sealMarker({ ...marker, ...patch });
    invalid(() => sealValue({
      ...active,
      activeMarker: drifted,
      activeMarkerDigest: journal.activeMarkerDigest(drifted),
    }));
  }
});

test('ACTIVE marker exact keys fail closed while legacy integrity remains service authority', () => {
  const marker = markerFixture();
  const { files: _files, ...withoutFiles } = marker;
  for (const hostile of [
    sealMarker({ ...marker, extra: true }),
    sealMarker(withoutFiles),
    sealMarker({ ...marker, schema: 'writcraft.changes-history-recovery/v0' }),
  ]) invalid(() => journal.assertActiveMarker(
    hostile, operationId, 'project-journal-fixture', 'snapshot_restore_undo'
  ));
  const knownOptional = sealMarker({ ...marker, artifact: { schema: 'opaque-fixture' } });
  assert.deepStrictEqual(journal.assertActiveMarker(
    knownOptional, operationId, 'project-journal-fixture', 'snapshot_restore_undo'
  ), knownOptional);
  const structurallyValidButForged = { ...marker, integrity: '0'.repeat(64) };
  assert.deepStrictEqual(journal.assertActiveMarker(
    structurallyValidButForged, operationId, 'project-journal-fixture', 'snapshot_restore_undo'
  ), structurallyValidButForged);
  assert.notStrictEqual(
    journal.activeMarkerDigest(structurallyValidButForged),
    journal.activeMarkerDigest(marker)
  );
});

test('active marker recursion rejects hostile JSON shapes without invoking getters', () => {
  const marker = markerFixture();
  let getterCalls = 0;
  const getter = { ...marker };
  Object.defineProperty(getter, 'files', {
    enumerable: true,
    get() { getterCalls += 1; return marker.files; },
  });
  invalid(() => journal.assertActiveMarker(
    getter,
    operationId,
    'project-journal-fixture',
    'snapshot_restore_undo'
  ));
  const nestedObjectGetter = markerFixture();
  Object.defineProperty(nestedObjectGetter.baseHistoryState, 'digest', {
    enumerable: true,
    get() { getterCalls += 1; return '3'.repeat(64); },
  });
  invalid(() => journal.assertActiveMarker(
    nestedObjectGetter, operationId, 'project-journal-fixture', 'snapshot_restore_undo'
  ));
  const arrayIndexGetter = markerFixture();
  Object.defineProperty(arrayIndexGetter.files, '0', {
    enumerable: true,
    get() { getterCalls += 1; return marker.files[0]; },
  });
  invalid(() => journal.assertActiveMarker(
    arrayIndexGetter, operationId, 'project-journal-fixture', 'snapshot_restore_undo'
  ));
  const hidden = { ...marker };
  Object.defineProperty(hidden, 'hidden', { enumerable: false, value: true });
  const symbolic = { ...marker, [Symbol('foreign')]: true };
  const sparse = { ...marker, files: [] };
  sparse.files.length = 2;
  const cyclic = { ...marker };
  cyclic.loop = cyclic;
  let deep = { value: true };
  for (let index = 0; index <= journal.MAX_ACTIVE_MARKER_DEPTH; index += 1) deep = { deep };
  for (const hostile of [
    hidden, symbolic, sparse, { ...marker, invalid: undefined },
    { ...marker, invalid: Number.NaN }, { ...marker, invalid: Number.POSITIVE_INFINITY },
    { ...marker, invalid: 1n }, cyclic, { ...marker, deep },
  ]) invalid(() => journal.activeMarkerDigest(hostile));
  assert.strictEqual(getterCalls, 0);
});

test('publication progresses PREPARED through one-at-a-time ARMED records to COMMITTED', () => {
  const prepared = preparedPublication();
  const armed = advancePublication(prepared, {
    state: 'ARMED',
    records: [record('ARMED')],
  });
  const published = advancePublication(armed, {
    records: [record('PUBLISHED')],
    mutation: mutation('ARMED'),
  });
  const committed = advancePublication(published, {
    state: 'COMMITTED',
    mutation: mutation('COMMITTED'),
  });
  assert.deepStrictEqual(journal.assertPublicationTransition(prepared, armed), armed);
  assert.deepStrictEqual(journal.assertPublicationTransition(armed, published), published);
  assert.deepStrictEqual(journal.assertPublicationTransition(published, committed), committed);
});

test('ACK_PREPARED retains full identities and closes a missing subset before IDLE', () => {
  const prepared = preparedPublication();
  const armed = advancePublication(prepared, { state: 'ARMED', records: [record('ARMED')] });
  const published = advancePublication(armed, {
    records: [record('PUBLISHED')], mutation: mutation('ARMED'),
  });
  const committed = advancePublication(published, {
    state: 'COMMITTED', mutation: mutation('COMMITTED'),
  });
  const ackPrepared = advancePublication(committed, {
    state: 'ACK_PREPARED', records: [record('CLEANUP_ARMED')],
  });
  const ackCommitted = advancePublication(ackPrepared, {
    state: 'ACK_COMMITTED', records: [record('REMOVED')],
  });
  assert.deepStrictEqual(journal.assertPublicationTransition(committed, ackPrepared), ackPrepared);
  assert.deepStrictEqual(journal.assertPublicationTransition(ackPrepared, ackCommitted), ackCommitted);
  const idle = initialValue();
  const active0 = advance(idle, {
    state: 'ACTIVE', activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo', ...activeAuthority(),
  });
  const active1 = advance(active0, { nativePublication: prepared });
  const active2 = advance(active1, { nativePublication: armed });
  const active3 = advance(active2, { nativePublication: published });
  const active4 = advance(active3, { nativePublication: committed });
  const active5 = advance(active4, { nativePublication: ackPrepared });
  const cleanup = terminalCleanup(ackCommitted);
  const active6 = advance(active5, {
    nativePublication: ackCommitted,
    terminalCleanup: cleanup,
    terminalCleanupDigest: cleanup.cleanupDigest,
  });
  for (const [left, right] of [
    [active0, active1], [active1, active2], [active2, active3],
    [active3, active4], [active4, active5], [active5, active6],
  ]) assert.deepStrictEqual(journal.assertTransition(left, right), right);
  const finalIdle = advance(active6, {
    state: 'IDLE', activeOperationId: null, activeKind: null,
    activeMarker: null, activeMarkerDigest: null,
    nativePublication: null, terminalCleanup: null, terminalCleanupDigest: null,
  });
  assert.deepStrictEqual(journal.assertTransition(active6, finalIdle), finalIdle);
});

test('same canonical value clone is equivalent while stale or different generation is rejected', () => {
  const value = initialValue();
  const clone = JSON.parse(JSON.stringify(value));
  assert.deepStrictEqual(journal.assertTransition(value, clone), value);
  invalid(() => journal.assertTransition(value, sealValue({
    ...value,
    generation: '1',
    previousValueDigest: value.valueDigest,
    journalId: `chrj_${'c'.repeat(48)}`,
  })));
});

test('descriptor accessors, extras, sparse arrays and duplicate records fail without getter execution', () => {
  const value = initialValue();
  let getterCalls = 0;
  const getter = { ...value };
  Object.defineProperty(getter, 'state', {
    enumerable: true,
    get() { getterCalls += 1; return 'IDLE'; },
  });
  invalid(() => journal.assertJournalValue(getter));
  invalid(() => journal.assertJournalValue({ ...value, absolutePath: '/private/tmp/leak' }));
  const prepared = preparedPublication();
  const sparse = [];
  sparse.length = 1;
  invalid(() => journal.assertPublication({ ...prepared, records: sparse }));
  const duplicate = [record('ARMED'), { ...record('ARMED'), role: 'RECEIPT' }];
  invalid(() => journal.assertPublication(sealPublication({
    ...prepared, state: 'ARMED', previousPublicationDigest: prepared.publicationDigest,
    records: duplicate,
  })));
  const digestValueGetter = { ...value };
  Object.defineProperty(digestValueGetter, 'activeMarkerDigest', {
    enumerable: true,
    get() { getterCalls += 1; return null; },
  });
  invalid(() => journal.valueDigest(digestValueGetter));
  const digestPublicationGetter = { ...prepared };
  Object.defineProperty(digestPublicationGetter, 'requestDigest', {
    enumerable: true,
    get() { getterCalls += 1; return prepared.requestDigest; },
  });
  invalid(() => journal.publicationDigest(digestPublicationGetter));
  assert.strictEqual(getterCalls, 0);
});

test('record authority rejects new-inode clones, digest drift and unsafe basenames', () => {
  const exact = record('ARMED');
  assert.deepStrictEqual(journal.assertRecord(exact), exact);
  const prepared = preparedPublication();
  const armed = advancePublication(prepared, { state: 'ARMED', records: [exact] });
  invalid(() => journal.assertPublicationTransition(armed, sealPublication({
    ...armed,
    previousPublicationDigest: armed.publicationDigest,
    records: [{
      ...record('PUBLISHED'),
      recordIdentity: { ...exact.recordIdentity, ino: '9999' },
    }],
  })));
  invalid(() => journal.assertRecord({ ...exact, recordDigest: sha('7') }));
  invalid(() => journal.assertRecord({ ...exact, destinationBasename: '../foreign' }));
});

test('cross-command, skipped state, dropped authority and two-record ARM all fail closed', () => {
  const prepared = preparedPublication();
  const armed = advancePublication(prepared, {
    state: 'ARMED', records: [record('ARMED')],
  });
  invalid(() => journal.assertPublicationTransition(prepared, sealPublication({
    ...armed, command: 'FINALIZE_UNDO',
  })));
  invalid(() => journal.assertPublicationTransition(prepared, sealPublication({
    ...armed, state: 'COMMITTED', records: [record('PUBLISHED')],
    mutation: mutation('COMMITTED'),
  })));
  invalid(() => journal.assertPublicationTransition(prepared, sealPublication({
    ...armed,
    records: [record('ARMED'), record('ARMED', 2)],
  })));
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE', activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo', ...activeAuthority(),
  });
  const withPrepared = advance(active, { nativePublication: prepared });
  invalid(() => journal.assertTransition(withPrepared, advance(withPrepared, {
    nativePublication: null,
  })));
});

test('ARMED publication cannot add published records or enter cleanup before COMMITTED', () => {
  const prepared = preparedPublication();
  invalid(() => journal.assertPublicationTransition(prepared, sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records: [record('PUBLISHED')],
  })));
  const armed = advancePublication(prepared, {
    state: 'ARMED',
    records: [record('ARMED')],
  });
  invalid(() => journal.assertPublicationTransition(armed, sealPublication({
    ...armed,
    previousPublicationDigest: armed.publicationDigest,
    records: [record('CLEANUP_ARMED')],
  })));
});

test('terminal IDLE is forbidden before ACK and exact terminal cleanup authority', () => {
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE', activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo', ...activeAuthority(),
    nativePublication: preparedPublication(),
  });
  const nextIdle = advance(active, {
    state: 'IDLE', activeOperationId: null, activeKind: null,
    activeMarker: null, activeMarkerDigest: null,
    nativePublication: null, terminalCleanup: null, terminalCleanupDigest: null,
  });
  invalid(() => journal.assertTransition(active, nextIdle));
});

test('terminal cleanup is descriptor-exact business truth rather than an arbitrary digest', () => {
  const prepared = preparedPublication();
  const armed = advancePublication(prepared, { state: 'ARMED', records: [record('ARMED')] });
  const published = advancePublication(armed, {
    records: [record('PUBLISHED')], mutation: mutation('ARMED'),
  });
  const committed = advancePublication(published, {
    state: 'COMMITTED', mutation: mutation('COMMITTED'),
  });
  const ackPrepared = advancePublication(committed, {
    state: 'ACK_PREPARED', records: [record('CLEANUP_ARMED')],
  });
  const ackCommitted = advancePublication(ackPrepared, {
    state: 'ACK_COMMITTED', records: [record('REMOVED')],
  });
  const cleanup = terminalCleanup(ackCommitted);
  assert.deepStrictEqual(Reflect.ownKeys(cleanup), journal.KEYS.CLEANUP);
  assert.deepStrictEqual(journal.assertTerminalCleanup(cleanup), cleanup);
  invalid(() => journal.assertTerminalCleanup({
    ...cleanup,
    historyStateDigest: sha('9'),
  }));
  invalid(() => journal.assertTerminalCleanup({ ...cleanup, absolutePath: '/private/tmp/leak' }));
  let getterCalls = 0;
  const getter = Object.fromEntries(journal.KEYS.CLEANUP_BUILD.map(key => [key, cleanup[key]]));
  Object.defineProperty(getter, 'historyStateDigest', {
    enumerable: true,
    get() { getterCalls += 1; return cleanup.historyStateDigest; },
  });
  invalid(() => journal.buildTerminalCleanup(getter));
  assert.strictEqual(getterCalls, 0);
});

test('slot parser rejects invalid UTF-8, noncanonical bytes, wrong digest and trailing data', () => {
  const frame = journal.encodeSlotFrame(initialValue(), 'A');
  invalid(() => journal.parseSlotFrame(Buffer.from([0xff, 0xfe])));
  const changed = Buffer.from(frame);
  changed[changed.length - 2] ^= 1;
  invalid(() => journal.parseSlotFrame(changed));
  invalid(() => journal.parseSlotFrame(Buffer.concat([frame, Buffer.from('x')])));
  invalid(() => journal.parseSlotFrame(Buffer.from(frame.toString('utf8').replace(
    'WRCCHRJ2\tA',
    'WRCCHRJ2\tC'
  ), 'utf8')));
});

test('double-slot selection accepts a torn inactive slot only beside one exact valid head', () => {
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    ...activeAuthority(),
  });
  assert.deepStrictEqual(journal.selectJournalHead(
    journal.encodeSlotFrame(idle, 'A'),
    journal.encodeSlotFrame(active, 'B')
  ), active);
  assert.deepStrictEqual(journal.selectJournalHead(
    journal.encodeSlotFrame(idle, 'A'),
    Buffer.from([0xff]),
    journal.expectedHead(idle)
  ), idle);
  invalid(() => journal.selectJournalHead(
    journal.encodeSlotFrame(idle, 'A'),
    Buffer.from([0xff])
  ));
  const disconnected = sealValue({
    ...active,
    previousValueDigest: sha('9'),
  });
  invalid(() => journal.selectJournalHead(
    journal.encodeSlotFrame(idle, 'A'),
    journal.encodeSlotFrame(disconnected, 'B')
  ));
  invalid(() => journal.selectJournalHead(Buffer.from([0xff]), Buffer.from([0xfe])));
});

test('adjacent valid slot frames must also pass the complete logical transition gate', () => {
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    ...activeAuthority(),
  });
  const crossOperation = advance(active, {
    activeOperationId: `chr_${'c'.repeat(48)}`,
    ...activeAuthority(
      'project-journal-fixture',
      'snapshot_restore_undo',
      `chr_${'c'.repeat(48)}`
    ),
  });
  invalid(() => journal.selectJournalHead(
    journal.encodeSlotFrame(active, 'A'),
    journal.encodeSlotFrame(crossOperation, 'B')
  ));
});

test('records are ordered 0..n-1 with unique full identities and one global basename namespace', () => {
  const prepared = preparedPublication();
  const first = record('ARMED', 1);
  const second = record('ARMED', 2);
  invalid(() => journal.assertPublication(sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records: [{ ...first, ordinal: 1 }],
  })));
  invalid(() => journal.assertPublication(sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records: [first, {
      ...second,
      recordIdentity: first.recordIdentity,
      recordDigest: first.recordDigest,
    }],
  })));
  invalid(() => journal.assertPublication(sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records: [first, { ...second, destinationBasename: first.stageBasename }],
  })));
});

test('CREATE_MISSING post-facto capture progresses atomically and rejects replacement authority', () => {
  const prepared = preparedCreatePublication();
  const latched = advancePublication(prepared, {
    state: 'PREPARED',
    createAttemptDigest: sha('9'),
  });
  const armed = advancePublication(latched, {
    state: 'ARMED',
    createCapture: createCapture(2),
  });
  const committed = advancePublication(armed, { state: 'COMMITTED' });
  const finalization = createFinalizationFixture(committed, committed.createCapture);
  const finalPrepared = advancePublication(committed, {
    createFinalization: finalization.prepared,
  });
  const finalCaptured = advancePublication(finalPrepared, {
    createFinalization: finalization.captured,
  });
  const ackPrepared = advancePublication(finalCaptured, {
    state: 'ACK_PREPARED',
    createCapture: armCreateCleanup(
      finalCaptured.createCapture,
      finalization.captured.finalAckDigest
    ),
    createFinalization: null,
    createCleanupFinalBasename: finalization.captured.finalBasename,
    createCleanupFinalRecordIdentity: finalization.captured.finalRecordIdentity,
  });
  const partial = advancePublication(ackPrepared, {
    createCapture: removeCreateCleanupRecords(ackPrepared.createCapture, 1),
  });
  const acked = advancePublication(partial, {
    state: 'ACK_COMMITTED',
    createCapture: removeCreateCleanupRecords(partial.createCapture, 4),
  });
  assert.strictEqual(journal.assertPublicationTransition(prepared, latched).state, 'PREPARED');
  assert.strictEqual(journal.assertPublicationTransition(latched, armed).state, 'ARMED');
  assert.strictEqual(journal.assertPublicationTransition(armed, committed).state, 'COMMITTED');
  assert.strictEqual(journal.assertPublicationTransition(committed, finalPrepared)
    .createFinalization.state, 'PREPARED');
  assert.strictEqual(journal.assertPublicationTransition(finalPrepared, finalCaptured)
    .createFinalization.state, 'CAPTURED');
  assert.strictEqual(journal.assertPublicationTransition(finalCaptured, ackPrepared).state,
    'ACK_PREPARED');
  assert.strictEqual(journal.assertPublicationTransition(ackPrepared, partial).state, 'ACK_PREPARED');
  assert.strictEqual(journal.assertPublicationTransition(partial, acked).state, 'ACK_COMMITTED');
  invalid(() => journal.assertPublicationTransition(committed, advancePublication(committed, {
    state: 'ACK_PREPARED',
    createCapture: armCreateCleanup(committed.createCapture, sha('1')),
  })));
  invalid(() => journal.assertPublicationTransition(finalPrepared, advancePublication(
    finalPrepared,
    {
      state: 'ACK_PREPARED',
      createCapture: armCreateCleanup(finalPrepared.createCapture, sha('1')),
      createFinalization: null,
      createCleanupFinalBasename: finalization.prepared.finalBasename,
      createCleanupFinalRecordIdentity: finalization.prepared.finalRecordIdentity,
    }
  )));
  const wrongCleanup = armCreateCleanup(
    finalCaptured.createCapture,
    finalization.captured.finalAckDigest
  );
  wrongCleanup.items[0] = {
    ...wrongCleanup.items[0],
    control: {
      ...wrongCleanup.items[0].control,
      cleanupBasename: `.changes-history-native-create-cleanup.${'f'.repeat(64)}`,
    },
  };
  invalid(() => journal.assertPublicationTransition(finalCaptured, advancePublication(
    finalCaptured,
    {
      state: 'ACK_PREPARED',
      createCapture: wrongCleanup,
      createFinalization: null,
      createCleanupFinalBasename: finalization.captured.finalBasename,
      createCleanupFinalRecordIdentity: finalization.captured.finalRecordIdentity,
    }
  )));
  invalid(() => journal.assertPublicationTransition(finalCaptured, advancePublication(
    finalCaptured,
    {
      state: 'ACK_PREPARED',
      createCapture: armCreateCleanup(
        finalCaptured.createCapture,
        finalization.captured.finalAckDigest
      ),
      createFinalization: null,
      createCleanupFinalBasename: finalization.captured.finalBasename,
      createCleanupFinalRecordIdentity: {
        ...finalization.captured.finalRecordIdentity,
        ino: '999999',
      },
    }
  )));
  invalid(() => journal.assertPublicationTransition(armed, sealPublication({
    ...committed,
    createCapture: {
      ...committed.createCapture,
      items: [{ ...committed.createCapture.items[0], path: 'foreign.md' },
        committed.createCapture.items[1]],
    },
  })));
  invalid(() => journal.assertPublication(sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    createCapture: null,
  })));
  invalid(() => journal.assertPublicationTransition(prepared, advancePublication(prepared, {
    state: 'ARMED',
    createAttemptDigest: sha('9'),
    createCapture: createCapture(2),
  })));
  invalid(() => journal.assertPublicationTransition(latched, advancePublication(latched, {
    state: 'PREPARED',
    createAttemptDigest: sha('8'),
  })));
  invalid(() => journal.assertPublication(sealPublication({
    ...armed,
    createAttemptDigest: null,
  })));
  invalid(() => journal.assertPublication(sealPublication({
    ...preparedPublication(),
    createAttemptDigest: sha('9'),
  })));
  let getterCalls = 0;
  const hostile = { ...latched };
  Object.defineProperty(hostile, 'createAttemptDigest', {
    enumerable: true,
    get() { getterCalls += 1; return sha('9'); },
  });
  invalid(() => journal.assertPublication(hostile));
  assert.strictEqual(getterCalls, 0);
});

test('CREATE_MISSING capture is descriptor-exact, unique and bounded at 300 items', () => {
  assert.strictEqual(journal.assertCreateCapture(createCapture(300)).items.length, 300);
  invalid(() => journal.assertCreateCapture(createCapture(301)));
  const duplicate = createCapture(2);
  duplicate.items[1] = {
    ...duplicate.items[1],
    control: duplicate.items[0].control,
  };
  invalid(() => journal.assertCreateCapture(duplicate));
  const crossPair = createCapture(2);
  crossPair.items[1] = { ...crossPair.items[1], receipt: crossPair.items[0].receipt };
  invalid(() => journal.assertCreateCapture(crossPair));
  const sameInode = createCapture();
  sameInode.items[0] = {
    ...sameInode.items[0],
    receipt: {
      ...sameInode.items[0].receipt,
      recordIdentity: {
        ...sameInode.items[0].receipt.recordIdentity,
        dev: sameInode.items[0].control.recordIdentity.dev,
        ino: sameInode.items[0].control.recordIdentity.ino,
      },
    },
  };
  invalid(() => journal.assertCreateCapture(sameInode));
  for (const identityPatch of [{ mode: 0o644 }, { nlink: 2 }]) {
    const hostileIdentity = createCapture();
    hostileIdentity.items[0] = {
      ...hostileIdentity.items[0],
      control: {
        ...hostileIdentity.items[0].control,
        recordIdentity: {
          ...hostileIdentity.items[0].control.recordIdentity,
          ...identityPatch,
        },
      },
    };
    invalid(() => journal.assertCreateCapture(hostileIdentity));
  }
  let getterCalls = 0;
  const hostile = createCapture();
  Object.defineProperty(hostile.items[0], 'path', {
    enumerable: true,
    get() { getterCalls += 1; return 'chapter-0.md'; },
  });
  invalid(() => journal.assertCreateCapture(hostile));
  assert.strictEqual(getterCalls, 0);
});

test('generation exhaustion, 902 records and malformed controls stay inside frozen budgets', () => {
  invalid(() => journal.nextGeneration('18446744073709551615'));
  const prepared = preparedPublication();
  const records = Array.from({ length: journal.MAX_RECORDS + 1 }, (_, index) => ({
    ...record('ARMED', (index % 899) + 1),
    ordinal: index,
    stageBasename: `.changes-history-native-stage.${(index + 1).toString(16).padStart(32, '0')}`,
    destinationBasename: `.changes-history-native-control.${(index + 1).toString(16).padStart(64, '0')}`,
  }));
  invalid(() => journal.assertPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records,
  }));
  assert(journal.encodeSlotFrame(initialValue(), 'A').length < journal.MAX_FRAME_BYTES);
});

test('maximum 901-record publication has a persisted canonical budget golden', () => {
  const records = Array.from({ length: journal.MAX_RECORDS }, (_, index) =>
    record('ARMED', index + 1));
  const prepared = preparedPublication();
  const maximum = sealPublication({
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    records,
  });
  const idle = initialValue();
  const active = advance(idle, {
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    ...activeAuthority(),
  });
  const backed = advance(active, { nativePublication: maximum });
  const canonical = evidence.canonicalJson(backed);
  assert.deepStrictEqual({
    bytes: Buffer.byteLength(canonical, 'utf8'),
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  }, {
    bytes: 625881,
    sha256: '1c8e1fca994311afda39cd6f7d5925c2e0d8b234cf524154f369ed481406caf1',
  });
  assert(Buffer.byteLength(canonical, 'utf8') < journal.MAX_VALUE_BYTES);
});

console.log(`Changes/History permanent marker journal schema verification: ${passed}/${passed} passed`);
