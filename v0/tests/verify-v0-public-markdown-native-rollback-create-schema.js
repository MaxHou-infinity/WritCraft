#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const existingSchema = require('../src/main/snapshot-existing-restore-native-schema');
const existingJournalBinding = require('../src/main/snapshot-existing-journal-binding-schema');
const schema = require('../src/main/public-markdown-native-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;
const revision = value => String(value).repeat(64);
const operationId = `chr_${'a'.repeat(48)}`;

function recordIdentity(wire, seed) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(100 + seed),
    ino: String(1000 + seed),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(Buffer.byteLength(wire, 'utf8')),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: evidence.sha256(Buffer.from(wire, 'utf8')),
  };
}

function heldIdentity(byteLength, contentSha256, seed) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(500 + seed),
    ino: String(5000 + seed),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(byteLength),
    mtimeNs: String(3000000000 + seed),
    ctimeNs: String(4000000000 + seed),
    contentSha256,
  };
}

// WRCCHRJ2 single-authority journal binding carried on the EXISTING sub-request.
// Synthetic but descriptor-exact: journalFileIdentity.contentSha256 is the held
// journal whole-content sha the rollback request binds as journalMarkerDigest.
function journalBinding() {
  return existingJournalBinding.buildExistingJournalBinding({
    schema: existingJournalBinding.SCHEMA,
    journalBasename: existingJournalBinding.JOURNAL_BASENAME,
    journalMagic: existingJournalBinding.JOURNAL_MAGIC,
    journalFileIdentity: {
      schema: evidence.SCHEMAS.OBJECT_IDENTITY,
      dev: '700', ino: '7000', uid: 501, mode: 0o600, nlink: 1,
      size: '4096', mtimeNs: '5000000000', ctimeNs: '6000000000',
      contentSha256: digest('d'),
    },
    rootIdentityDigest: digest('1'),
    recoveryDirectoryIdentityDigest: digest('2'),
    activeSlot: 'A',
    head: {
      schema: existingJournalBinding.HEAD_SCHEMA,
      journalId: `chrj_${'d'.repeat(48)}`,
      generation: '0',
      valueDigest: digest('e'),
    },
    previousValueDigest: null,
    frameByteLength: 2048,
    frameSha256: digest('c'),
    payloadOffset: 100,
    payloadByteLength: 1948,
    payloadSha256: digest('b'),
    activeMarkerOffset: 100,
    activeMarkerByteLength: 100,
    activeMarkerDigest: digest('9'),
    activeMarkerCanonicalSha256: digest('a'),
    bindingDigest: null,
  });
}

function rootBind() {
  return {
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: '/private/tmp/rollback-create',
    expectedRootIdentityDigest: digest('1'),
    expectedRecoveryIdentityDigest: digest('2'),
  };
}

function parent(missingCount = 1, pathFactory = null) {
  const pathAt = index => pathFactory ? pathFactory(index) :
    (index === 0 ? 'existing.md' : `new-${index - 1}.md`);
  return {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [{
      selectedId: 'existing:0',
      action: 'EXISTING',
      path: pathAt(0),
      revision: revision('3'),
      ancestorIdentityDigest: digest('3'),
    }, ...Array.from({ length: missingCount }, (_, index) => ({
      selectedId: `missing:${index}`,
      action: 'MISSING',
      path: pathAt(index + 1),
      revision: (index + 256).toString(16).padStart(64, '0'),
      ancestorIdentityDigest: `sha256:${(index + 512).toString(16).padStart(64, '0')}`,
    }))],
  };
}

function phase(authority, state, overrides = {}) {
  const missing = authority.selected.filter(item => item.action === 'MISSING');
  const created = state !== 'PRECREATE';
  const quarantined = ['CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK'].includes(state);
  return {
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore',
    phase: state,
    artifactDigest: digest('4'),
    selectionDigest: phaseSchema.digestSelection(authority),
    items: missing.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.revision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: created
        ? `sha256:${(index + 768).toString(16).padStart(64, '0')}`
        : null,
      creationReceiptDigest: created
        ? `sha256:${(index + 1024).toString(16).padStart(64, '0')}`
        : null,
      quarantineReceiptDigest: quarantined
        ? `sha256:${(index + 1280).toString(16).padStart(64, '0')}`
        : null,
    })),
    preparedHistoryDigest: created ? digest('5') : null,
    finalReceiptDigest: null,
    existingReceiptSetDigest: ['CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK'].includes(state)
      ? digest('6')
      : null,
    rollbackReceiptDigest: state === 'ROLLED_BACK' ? digest('7') : null,
    updatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

function createRequest(authority, precreate) {
  const missing = authority.selected.filter(item => item.action === 'MISSING');
  return {
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId,
    artifactDigest: digest('4'),
    artifactIdentityDigest: digest('8'),
    artifactByteLength: 8 * 1024 * 1024,
    precreatePhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, precreate),
    selectionDigest: phaseSchema.digestSelection(authority),
    items: missing.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      artifactOffset: index * 1024,
      byteLength: (index % 16) + 1,
      contentDigest: `sha256:${item.revision}`,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
    })),
  };
}

function createPublications(nativeRequest, created) {
  return nativeRequest.items.map((_item, index) => {
    const control = schema.buildControl(nativeRequest, index);
    const receipt = schema.buildReceipt(control, created.items[index].createdIdentityDigest);
    assert.strictEqual(receipt.receiptDigest, created.items[index].creationReceiptDigest);
    return {
      schema: schema.SCHEMAS.ROLLBACK_CREATE_PUBLICATION,
      token: schema.buildToken(nativeRequest, index, receipt),
      controlRecordIdentity: recordIdentity(schema.encodeControlRecord(control), index * 2 + 1),
      receiptRecordIdentity: recordIdentity(
        schema.encodeReceiptRecord(receipt, control),
        index * 2 + 2
      ),
    };
  });
}

function existingAuthority(authority, created, nativeCreateRequest, baseHistoryExists = true) {
  const existingSelection = authority.selected.find(item => item.action === 'EXISTING');
  const marker = {
    schema: existingSchema.SCHEMAS.MARKER_AUTHORITY,
    operationId,
    markerDigest: digest('9'),
    artifactDigest: nativeCreateRequest.artifactDigest,
    artifactIdentityDigest: nativeCreateRequest.artifactIdentityDigest,
    artifactByteLength: nativeCreateRequest.artifactByteLength,
    baseHistoryDigest: baseHistoryExists
      ? digest('a')
      : evidence.sha256(Buffer.from([0])),
    baseHistoryByteLength: baseHistoryExists ? 4096 : 0,
    baseHistoryExists,
    baseHistoryContentDigest: baseHistoryExists ? digest('e') : null,
    historyParentIdentityDigest: digest('f'),
  };
  const nativeRequest = {
    schema: existingSchema.SCHEMAS.REQUEST,
    operationId,
    markerDigest: marker.markerDigest,
    artifactDigest: marker.artifactDigest,
    artifactIdentityDigest: marker.artifactIdentityDigest,
    artifactByteLength: marker.artifactByteLength,
    createdReceiptPhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, created),
    selectionDigest: created.selectionDigest,
    baseHistoryDigest: marker.baseHistoryDigest,
    baseHistoryByteLength: marker.baseHistoryByteLength,
    baseHistoryExists,
    baseHistoryContentDigest: marker.baseHistoryContentDigest,
    historyParentIdentityDigest: marker.historyParentIdentityDigest,
    journalMarkerBinding: journalBinding(),
    items: [{
      selectedId: 'existing:0',
      path: existingSelection.path,
      beforeRevision: revision('b'),
      afterRevision: existingSelection.revision,
      beforeArtifactOffset: 1024,
      beforeByteLength: 8,
      beforeContentDigest: digest('b'),
      afterArtifactOffset: 2048,
      afterByteLength: 9,
      afterContentDigest: `sha256:${existingSelection.revision}`,
      ancestorIdentityDigest: existingSelection.ancestorIdentityDigest,
      beforeLeafIdentityDigest: digest('c'),
    }],
  };
  const bound = existingSchema.buildAuthority(marker, authority, created, nativeRequest);
  const control = existingSchema.buildControl(bound, 0);
  const rollbackReceipt = existingSchema.buildRollbackReceipt(bound, 0, digest('d'));
  const rollbackToken = existingSchema.buildRollbackToken(
    bound,
    0,
    rollbackReceipt,
    recordIdentity(existingSchema.encodeControlRecord(control, bound, 0), 40),
    recordIdentity(
      existingSchema.encodeRollbackReceiptRecord(rollbackReceipt, bound, 0),
      41
    )
  );
  return {
    bound,
    terminal: existingSchema.buildTerminalReceipt(bound, 'UNCOMMITTED', [rollbackToken]),
  };
}

function fixture(missingCount = 1, baseHistoryExists = true, pathFactory = null) {
  const root = rootBind();
  const selection = parent(missingCount, pathFactory);
  const precreate = phase(selection, 'PRECREATE');
  const nativeCreateRequest = schema.assertCreateRequest(createRequest(selection, precreate));
  const controls = nativeCreateRequest.items.map((_item, index) =>
    schema.buildControl(nativeCreateRequest, index));
  const receipts = controls.map((control, index) => {
    const identity = `sha256:${(index + 768).toString(16).padStart(64, '0')}`;
    const built = schema.buildReceipt(control, identity);
    return built;
  });
  const created = phase(selection, 'CREATED_RECEIPT', {
    items: phase(selection, 'CREATED_RECEIPT').items.map((item, index) => ({
      ...item,
      creationReceiptDigest: receipts[index].receiptDigest,
    })),
  });
  const publications = createPublications(nativeCreateRequest, created);
  const existing = existingAuthority(
    selection,
    created,
    nativeCreateRequest,
    baseHistoryExists
  );
  // The held binding carries the STRUCTURED journal binding now, so the request
  // digest stays fixed while the journal frame advances.
  const held = schema.buildRollbackCreateHeldBinding(
    journalBinding(),
    digest('f'),
    baseHistoryExists,
    baseHistoryExists ? digest('e') : null,
    baseHistoryExists
      ? heldIdentity(existing.bound.request.baseHistoryByteLength, digest('e'), 2)
      : null,
    existing.bound
  );
  const request = schema.buildRollbackCreateRequest(
    root,
    selection,
    precreate,
    created,
    nativeCreateRequest,
    publications,
    existing.bound,
    existing.terminal,
    held
  );
  const bound = schema.buildRollbackCreateAuthority(
    root,
    selection,
    precreate,
    created,
    nativeCreateRequest,
    publications,
    existing.bound,
    existing.terminal,
    held,
    request
  );
  const qControls = request.items.map((_item, index) => schema.buildRollbackCreateControl(
    bound,
    index,
    `.changes-history-native-rollback-create-quarantine.${(index + 1)
      .toString(16).padStart(32, '0')}`
  ));
  const qReceipts = qControls.map((control, index) => schema.buildRollbackCreateReceipt(
    bound,
    index,
    control,
    `sha256:${(index + 1536).toString(16).padStart(64, '0')}`
  ));
  const tokens = qReceipts.map((receipt, index) => schema.buildRollbackCreateToken(
    bound,
    index,
    qControls[index],
    receipt,
    recordIdentity(
      schema.encodeRollbackCreateControlRecord(qControls[index], bound, index),
      100 + index * 2
    ),
    recordIdentity(
      schema.encodeRollbackCreateReceiptRecord(receipt, bound, index, qControls[index]),
      101 + index * 2
    )
  ));
  const settle = schema.buildRollbackCreateSettleRequest(bound, tokens);
  const finalRecord = schema.buildRollbackCreateFinalRecord(settle, bound);
  const finalIdentity = recordIdentity(
    schema.encodeRollbackCreateFinalRecord(finalRecord, settle, bound),
    200
  );
  const rollbackQuarantined = phase(selection, 'CREATE_ROLLBACK_QUARANTINED', {
    items: created.items.map((item, index) => ({
      ...item,
      quarantineReceiptDigest: tokens[index].receiptDigest,
    })),
    existingReceiptSetDigest: existing.terminal.receiptSetDigest,
  });
  const rolledBack = phase(selection, 'ROLLED_BACK', {
    items: rollbackQuarantined.items,
    existingReceiptSetDigest: existing.terminal.receiptSetDigest,
    rollbackReceiptDigest: finalRecord.finalRecordDigest,
  });
  return {
    root, selection, precreate, created, nativeCreateRequest, publications,
    existing, held, request, bound, qControls, qReceipts, tokens, settle,
    finalRecord, finalIdentity, rollbackQuarantined, rolledBack,
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'PUBLIC_MARKDOWN_NATIVE_PROTOCOL');
}

function decodeHexUtf8(value) {
  return Buffer.from(value, 'hex').toString('utf8');
}

// Positional Q/R/D/A header layout:
//   [0] command letter, [1] 'CREATE_ROLLBACK', then the fields emitted by
//   rollbackCreateAuthorityHeaderFields() in source order.
// This table mirrors that returned array order one-for-one, so AUTHORITY[name]
// is the wire index of `name` and a future schema change only edits this table.
const AUTHORITY_HEADER_PREFIX = 2; // [0] letter, [1] magic
const ROLLBACK_AUTHORITY_FIELDS = Object.freeze([
  'operationId',                          // [2]
  'requestDigest',                        // [3]
  'markerDigest',                         // [4]
  'artifactDigest',                       // [5]
  'artifactIdentityDigest',               // [6]
  'artifactByteLength',                   // [7]
  'rootIdentityDigest',                   // [8]
  'recoveryIdentityDigest',               // [9]
  'createPrecreatePhaseDigest',           // [10]
  'createdReceiptPhaseDigest',            // [11]
  'selectionDigest',                      // [12]
  'preparedHistoryDigest',                // [13]
  'originalPrecreateUpdatedAt',           // [14]
  'originalCreatedReceiptUpdatedAt',      // [15]
  'existingRequestDigest',                // [16]
  'existingJournalMarkerBinding',         // [17]
  'existingTerminalReceiptDigest',        // [18]
  'existingReceiptSetDigest',             // [19]
  'baseHistoryDigest',                    // [20]
  'baseHistoryByteLength',                // [21]
  'baseHistoryExists',                    // [22]
  'baseHistoryContentDigest',             // [23]
  'baseHistoryIdentityDigest',            // [24]
  'historyParentIdentityDigest',          // [25]
  'journalBindingDigest',                 // [26]
  'journalBasename',                      // [27]
  'journalMagic',                         // [28]
  'journalActiveSlot',                    // [29]
  'journalHeadId',                        // [30]
  'journalHeadGeneration',                // [31]
  'journalPreviousValueDigest',           // [32]
  'journalHeadValueDigest',               // [33]
  'journalFrameByteLength',               // [34]
  'journalFrameSha256',                   // [35]
  'journalPayloadOffset',                 // [36]
  'journalPayloadByteLength',             // [37]
  'journalPayloadSha256',                 // [38]
  'journalActiveMarkerOffset',            // [39]
  'journalActiveMarkerByteLength',        // [40]
  'journalActiveMarkerDigest',            // [41]
  'journalActiveMarkerCanonicalSha256',   // [42]
  'journalBindingRootIdentityDigest',     // [43]
  'journalBindingRecoveryIdentityDigest', // [44]
  'existingItemCount',                    // [45]
  'missingItemCount',                     // [46]
]);
const AUTHORITY = Object.freeze(Object.fromEntries(
  ROLLBACK_AUTHORITY_FIELDS.map((name, index) => [name, index + AUTHORITY_HEADER_PREFIX])
));
const AUTHORITY_HEADER_LENGTH = AUTHORITY_HEADER_PREFIX + ROLLBACK_AUTHORITY_FIELDS.length;

// The ACK header appends these after the shared authority fields; the D (settle)
// header appends only the trailing token count, and Q/R append nothing.
const ROLLBACK_ACK_TAIL_FIELDS = Object.freeze([
  'finalBasename',                 // ACK only
  'finalRecordDigest',             // ACK only
  'rolledBackPhaseDigest',         // ACK only
  'rolledBackPhaseUpdatedAt',      // ACK only
  ...['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    'contentSha256'].map(name => `finalRecordIdentity.${name}`),
  'settleTokenCount',              // ACK only (D carries it too)
]);
const ROLLBACK_ACK = Object.freeze(Object.fromEntries(
  ROLLBACK_ACK_TAIL_FIELDS.map((name, index) => [name, AUTHORITY_HEADER_LENGTH + index])
));
const ROLLBACK_ACK_HEADER_LENGTH = AUTHORITY_HEADER_LENGTH + ROLLBACK_ACK_TAIL_FIELDS.length;

function independentlyRebuildRollbackWireAuthority(qWire, aWire) {
  const qLines = qWire.trimEnd().split('\n').map(line => line.split('\t'));
  const aLines = aWire.trimEnd().split('\n').map(line => line.split('\t'));
  const header = qLines[0];
  const existing = qLines.filter(fields => fields[0] === 'E');
  const missing = qLines.filter(fields => fields[0] === 'I');
  assert.strictEqual(AUTHORITY_HEADER_LENGTH, 47);
  assert.strictEqual(header.length, AUTHORITY_HEADER_LENGTH);
  assert.strictEqual(existing.length, Number(header[AUTHORITY.existingItemCount]));
  assert.strictEqual(missing.length, Number(header[AUTHORITY.missingItemCount]));
  assert.strictEqual(qLines.length, 1 + existing.length + missing.length);
  const indexed = [...existing, ...missing].map(fields => ({
    fields,
    parentIndex: Number(fields[1]),
  }));
  const total = indexed.length;
  assert(indexed.every(value => Number.isSafeInteger(value.parentIndex) &&
    value.parentIndex >= 0 && value.parentIndex < total));
  assert.strictEqual(new Set(indexed.map(value => value.parentIndex)).size, total);
  assert.deepStrictEqual(
    indexed.map(value => value.parentIndex).sort((left, right) => left - right),
    Array.from({ length: total }, (_, index) => index)
  );
  for (const subset of [existing, missing]) {
    const indexes = subset.map(fields => Number(fields[1]));
    assert.deepStrictEqual(indexes, [...indexes].sort((left, right) => left - right));
  }
  const selection = phaseSchema.assertParentSelectionBinding({
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: indexed.sort((left, right) => left.parentIndex - right.parentIndex)
      .map(({ fields }) => fields[0] === 'E'
        ? {
          selectedId: fields[2],
          action: 'EXISTING',
          path: decodeHexUtf8(fields[3]),
          revision: fields[5],
          ancestorIdentityDigest: fields[12],
        }
        : {
          selectedId: fields[2],
          action: 'MISSING',
          path: decodeHexUtf8(fields[3]),
          revision: fields[6].slice('sha256:'.length),
          ancestorIdentityDigest: fields[7],
        }),
  });
  assert.strictEqual(phaseSchema.digestSelection(selection), header[AUTHORITY.selectionDigest]);
  const create = schema.assertCreateRequest({
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId: header[AUTHORITY.operationId],
    artifactDigest: header[AUTHORITY.artifactDigest],
    artifactIdentityDigest: header[AUTHORITY.artifactIdentityDigest],
    artifactByteLength: Number(header[AUTHORITY.artifactByteLength]),
    precreatePhaseDigest: header[AUTHORITY.createPrecreatePhaseDigest],
    selectionDigest: header[AUTHORITY.selectionDigest],
    items: missing.map(fields => ({
      selectedId: fields[2],
      path: decodeHexUtf8(fields[3]),
      artifactOffset: Number(fields[4]),
      byteLength: Number(fields[5]),
      contentDigest: fields[6],
      ancestorIdentityDigest: fields[7],
    })),
  });
  const precreate = {
    schema: phaseSchema.SCHEMA,
    operationId: header[AUTHORITY.operationId],
    kind: 'snapshot_restore',
    phase: 'PRECREATE',
    artifactDigest: header[AUTHORITY.artifactDigest],
    selectionDigest: phaseSchema.digestSelection(selection),
    items: missing.map(fields => ({
      selectedId: fields[2],
      path: decodeHexUtf8(fields[3]),
      afterRevision: fields[6].slice('sha256:'.length),
      ancestorIdentityDigest: fields[7],
      createdIdentityDigest: null,
      creationReceiptDigest: null,
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: null,
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: decodeHexUtf8(header[AUTHORITY.originalPrecreateUpdatedAt]),
  };
  phaseSchema.assertPhaseRecord(precreate, selection);
  assert.strictEqual(
    evidence.digestObject(phaseSchema.SCHEMA, precreate),
    header[AUTHORITY.createPrecreatePhaseDigest]
  );
  missing.forEach((fields, index) => {
    assert.strictEqual(fields.length, 31);
    const control = schema.buildControl(create, index);
    const receipt = schema.buildReceipt(control, fields[8]);
    assert.strictEqual(schema.recordNames(create, index).controlBasename, fields[9]);
    assert.strictEqual(schema.recordNames(create, index).receiptBasename, fields[10]);
    assert.strictEqual(control.controlDigest, fields[11]);
    assert.strictEqual(receipt.receiptDigest, fields[12]);
    const controlWire = schema.encodeControlRecord(control);
    const receiptWire = schema.encodeReceiptRecord(receipt, control);
    assert.strictEqual(String(Buffer.byteLength(controlWire, 'utf8')), fields[18]);
    assert.strictEqual(evidence.sha256(Buffer.from(controlWire, 'utf8')), fields[21]);
    assert.strictEqual(String(Buffer.byteLength(receiptWire, 'utf8')), fields[27]);
    assert.strictEqual(evidence.sha256(Buffer.from(receiptWire, 'utf8')), fields[30]);
  });
  const created = {
    schema: phaseSchema.SCHEMA,
    operationId: header[AUTHORITY.operationId],
    kind: 'snapshot_restore',
    phase: 'CREATED_RECEIPT',
    artifactDigest: header[AUTHORITY.artifactDigest],
    selectionDigest: header[AUTHORITY.selectionDigest],
    items: missing.map(fields => ({
      selectedId: fields[2],
      path: decodeHexUtf8(fields[3]),
      afterRevision: fields[6].slice('sha256:'.length),
      ancestorIdentityDigest: fields[7],
      createdIdentityDigest: fields[8],
      creationReceiptDigest: fields[12],
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: header[AUTHORITY.preparedHistoryDigest],
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: decodeHexUtf8(header[AUTHORITY.originalCreatedReceiptUpdatedAt]),
  };
  phaseSchema.assertPhaseRecord(created, selection);
  assert.strictEqual(
    evidence.digestObject(phaseSchema.SCHEMA, created),
    header[AUTHORITY.createdReceiptPhaseDigest]
  );
  const aHeader = aLines[0];
  const tokens = aLines.filter(fields => fields[0] === 'T');
  assert.strictEqual(ROLLBACK_ACK_HEADER_LENGTH, 61);
  assert.strictEqual(aHeader.length, ROLLBACK_ACK_HEADER_LENGTH);
  assert.deepStrictEqual(
    aHeader.slice(AUTHORITY_HEADER_PREFIX, AUTHORITY_HEADER_LENGTH),
    header.slice(AUTHORITY_HEADER_PREFIX)
  );
  assert.deepStrictEqual(
    aLines.filter(fields => ['E', 'I'].includes(fields[0])),
    qLines.filter(fields => ['E', 'I'].includes(fields[0]))
  );
  assert.strictEqual(tokens.length, Number(aHeader[ROLLBACK_ACK.settleTokenCount]));
  assert.ok(
    Date.parse(decodeHexUtf8(aHeader[ROLLBACK_ACK.rolledBackPhaseUpdatedAt])) >=
      Date.parse(created.updatedAt)
  );
  const rolledBack = {
    ...created,
    phase: 'ROLLED_BACK',
    items: created.items.map((item, index) => ({
      ...item,
      quarantineReceiptDigest: tokens[index][9],
    })),
    existingReceiptSetDigest: aHeader[AUTHORITY.existingReceiptSetDigest],
    rollbackReceiptDigest: aHeader[ROLLBACK_ACK.finalRecordDigest],
    updatedAt: decodeHexUtf8(aHeader[ROLLBACK_ACK.rolledBackPhaseUpdatedAt]),
  };
  phaseSchema.assertPhaseRecord(rolledBack, selection);
  assert.strictEqual(
    evidence.digestObject(phaseSchema.SCHEMA, rolledBack),
    aHeader[ROLLBACK_ACK.rolledBackPhaseDigest]
  );
  return { selection, precreate, create, created, rolledBack };
}

function manualRollbackCommittedResponse(value, letter) {
  const identity = raw => [
    raw.dev, raw.ino, String(raw.uid), String(raw.mode), String(raw.nlink),
    raw.size, raw.mtimeNs, raw.ctimeNs, raw.contentSha256,
  ];
  const lines = [
    'P\tOK',
    [
      letter, 'RESULT', 'COMMITTED', value.request.operationId,
      schema.rollbackCreateRequestDigest(value.bound), String(value.tokens.length), '-',
    ].join('\t'),
    ...value.tokens.map(token => [
      'K', token.selectedId, token.controlBasename, token.receiptBasename,
      token.quarantineBasename, token.controlDigest, token.createdIdentityDigest,
      token.quarantineIdentityDigest, token.contentDigest, token.receiptDigest,
      ...identity(token.controlRecordIdentity), ...identity(token.receiptRecordIdentity),
    ].join('\t')),
  ];
  return `${lines.join('\n')}\n`;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPrivate public-Markdown ROLLBACK_CREATE schema verification');

test('held journal binding and raw History descriptors are explicit rollback-create authority', () => {
  const value = fixture();
  assert.deepStrictEqual(
    schema.assertRollbackCreateHeldBinding(value.held, value.existing.bound),
    value.held
  );
  // The request binds the STORED EXISTING-era journal binding. That is what
  // keeps the request digest — and therefore Q's record basenames — fixed while
  // the live journal frame advances, which is the precondition for the staged
  // rollback CAS. The live held journal binding travels separately in the
  // heldBinding.
  assert.strictEqual(
    evidence.canonicalJson(value.request.existingJournalMarkerBinding),
    evidence.canonicalJson(value.existing.bound.request.journalMarkerBinding)
  );
  assert.notStrictEqual(value.held.journalMarkerBinding, undefined);
  assert.strictEqual(value.request.baseHistoryIdentityDigest,
    evidence.digestObjectIdentity(value.held.baseHistoryIdentity));
  let getters = 0;
  const hostile = { ...value.held };
  Object.defineProperty(hostile, 'journalMarkerBinding', {
    enumerable: true,
    get() { getters += 1; return value.held.journalMarkerBinding; },
  });
  invalid(() => schema.assertRollbackCreateHeldBinding(hostile, value.existing.bound));
  // A tampered held journal binding must fail closed. It is rejected by the
  // journal-binding schema itself, so accept either protocol code here.
  assert.throws(() => schema.assertRollbackCreateHeldBinding({
    ...value.held,
    journalMarkerBinding: {
      ...value.held.journalMarkerBinding,
      frameSha256: digest('9'),
    },
  }, value.existing.bound), error => [
    'PUBLIC_MARKDOWN_NATIVE_PROTOCOL',
    'SNAPSHOT_EXISTING_JOURNAL_BINDING_PROTOCOL',
  ].includes(error?.code));
  for (const baseHistoryIdentity of [
    { ...value.held.baseHistoryIdentity, mode: 0o644 },
    { ...value.held.baseHistoryIdentity, nlink: 2 },
  ]) {
    invalid(() => schema.assertRollbackCreateHeldBinding({
      ...value.held,
      baseHistoryIdentity,
    }, value.existing.bound));
  }
  const absent = fixture(1, false);
  assert.strictEqual(absent.held.baseHistoryExists, false);
  assert.strictEqual(absent.held.baseHistoryContentDigest, null);
  assert.strictEqual(absent.held.baseHistoryIdentity, null);
  assert.strictEqual(absent.request.baseHistoryIdentityDigest, null);
  invalid(() => schema.assertRollbackCreateHeldBinding({
    ...absent.held,
    baseHistoryContentDigest: digest('e'),
  }, absent.existing.bound));
  assert.strictEqual(getters, 0);
});

test('module exposes the frozen Q/R/D/A domain with no B command', () => {
  assert.deepStrictEqual(schema.ROLLBACK_CREATE_COMMANDS, {
    QUARANTINE: 'QUARANTINE_CREATE_ROLLBACK',
    RECONCILE: 'RECONCILE_CREATE_ROLLBACK',
    DELETE: 'DELETE_CREATE_ROLLBACK',
    ACK: 'ACK_CREATE_ROLLBACK',
  });
  assert.ok(!Object.values(schema.ROLLBACK_CREATE_COMMANDS).some(command => command.startsWith('B')));
});

test('request binds root/recovery, marker/artifact, CREATED_RECEIPT, History and EXISTING UNCOMMITTED', () => {
  const value = fixture();
  assert.strictEqual(schema.assertRollbackCreateAuthority(value.bound).request.items.length, 1);
  for (const drift of [
    { markerDigest: digest('f') },
    { artifactDigest: digest('f') },
    { rootIdentityDigest: digest('f') },
    { recoveryIdentityDigest: digest('f') },
    { createPrecreatePhaseDigest: digest('f') },
    { createdReceiptPhaseDigest: digest('f') },
    { preparedHistoryDigest: digest('f') },
    { originalPrecreateUpdatedAt: '2026-08-08T23:59:59.000Z' },
    { originalCreatedReceiptUpdatedAt: '2026-08-08T23:59:59.000Z' },
    { existingTerminalReceiptDigest: digest('f') },
    { baseHistoryDigest: digest('f') },
  ]) {
    invalid(() => schema.assertRollbackCreateRequest(
      { ...value.request, ...drift },
      value.root,
      value.selection,
      value.precreate,
      value.created,
      value.nativeCreateRequest,
      value.publications,
      value.existing.bound,
      value.existing.terminal,
      value.held
    ));
  }
  for (const key of [
    'createPrecreatePhaseDigest',
    'preparedHistoryDigest',
    'originalPrecreateUpdatedAt',
    'originalCreatedReceiptUpdatedAt',
  ]) {
    const missing = { ...value.request };
    delete missing[key];
    invalid(() => schema.assertRollbackCreateRequest(
      missing,
      value.root,
      value.selection,
      value.precreate,
      value.created,
      value.nativeCreateRequest,
      value.publications,
      value.existing.bound,
      value.existing.terminal,
      value.held
    ));
  }
  for (const item of [
    Object.fromEntries(Object.entries(value.request.items[0])
      .filter(([key]) => key !== 'artifactOffset')),
    { ...value.request.items[0], artifactOffset: value.request.items[0].artifactOffset + 1 },
  ]) {
    invalid(() => schema.assertRollbackCreateRequest({
      ...value.request,
      items: [item],
    }, value.root, value.selection, value.precreate, value.created, value.nativeCreateRequest,
    value.publications, value.existing.bound, value.existing.terminal, value.held));
  }
});

test('create receipt publication identities are complete and replacement-sensitive', () => {
  const value = fixture();
  const foreign = {
    ...value.request,
    items: [{
      ...value.request.items[0],
      createReceiptRecordIdentity: {
        ...value.request.items[0].createReceiptRecordIdentity,
        ino: '999999',
      },
    }],
  };
  invalid(() => schema.assertRollbackCreateRequest(
    foreign,
    value.root,
    value.selection,
    value.precreate,
    value.created,
    value.nativeCreateRequest,
    value.publications,
    value.existing.bound,
    value.existing.terminal,
    value.held
  ));
});

test('formal EXISTING COMMITTED or foreign terminal cannot authorize rollback-create', () => {
  const value = fixture();
  const control = existingSchema.buildControl(value.existing.bound, 0);
  const apply = existingSchema.buildApplyReceipt(value.existing.bound, 0, digest('e'));
  const applyToken = existingSchema.buildApplyToken(
    value.existing.bound,
    0,
    apply,
    recordIdentity(existingSchema.encodeControlRecord(control, value.existing.bound, 0), 300),
    recordIdentity(existingSchema.encodeApplyReceiptRecord(apply, value.existing.bound, 0), 301)
  );
  const committed = existingSchema.buildTerminalReceipt(
    value.existing.bound,
    'COMMITTED',
    [applyToken]
  );
  invalid(() => schema.buildRollbackCreateRequest(
    value.root,
    value.selection,
    value.precreate,
    value.created,
    value.nativeCreateRequest,
    value.publications,
    value.existing.bound,
    committed,
    value.held
  ));
});

test('Q receipts bind exact created identities and private quarantine publication', () => {
  const value = fixture();
  assert.deepStrictEqual(
    schema.assertRollbackCreateToken(value.tokens[0], value.bound, 0),
    value.tokens[0]
  );
  invalid(() => schema.assertRollbackCreateToken({
    ...value.tokens[0],
    createdIdentityDigest: digest('f'),
  }, value.bound, 0));
  invalid(() => schema.assertRollbackCreateToken({
    ...value.tokens[0],
    receiptRecordIdentity: {
      ...value.tokens[0].receiptRecordIdentity,
      contentSha256: digest('f'),
    },
  }, value.bound, 0));
});

test('R has exact COMMITTED/UNCOMMITTED/UNKNOWN truth and command separation', () => {
  const value = fixture();
  const committed = schema.buildRollbackCreateResult(
    value.bound,
    schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
    'COMMITTED',
    value.tokens
  );
  schema.assertRollbackCreateResult(
    committed,
    value.bound,
    schema.ROLLBACK_CREATE_COMMANDS.RECONCILE
  );
  schema.assertRollbackCreateResult(schema.buildRollbackCreateResult(
    value.bound,
    schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
    'UNCOMMITTED'
  ), value.bound, schema.ROLLBACK_CREATE_COMMANDS.RECONCILE);
  const unknown = schema.buildRollbackCreateResult(
    value.bound,
    schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
    'UNKNOWN'
  );
  assert.strictEqual(unknown.errorCode, 'ROLLBACK_CREATE_UNKNOWN');
  invalid(() => schema.assertRollbackCreateResult(
    committed,
    value.bound,
    schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE
  ));
});

test('D binds all quarantine tokens and exact unchanged upstream authority', () => {
  const value = fixture();
  assert.strictEqual(
    schema.assertRollbackCreateSettleRequest(value.settle, value.bound).tokens.length,
    1
  );
  invalid(() => schema.assertRollbackCreateSettleRequest({
    ...value.settle,
    tokens: [],
  }, value.bound));
  invalid(() => schema.assertRollbackCreateSettleRequest({
    ...value.settle,
    baseHistoryDigest: digest('f'),
  }, value.bound));
});

test('D final record and A ACK bind publication identity plus exact ROLLED_BACK phase', () => {
  const value = fixture();
  const result = schema.buildRollbackCreateSettleResult(
    value.bound,
    value.settle,
    'FINALIZED',
    value.finalRecord,
    value.finalIdentity
  );
  schema.assertRollbackCreateSettleResult(result, value.bound, value.settle);
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  schema.assertRollbackCreateAckRequest(
    ack,
    value.bound,
    value.settle,
    value.rolledBack
  );
  schema.assertRollbackCreateAckResult(
    schema.buildRollbackCreateAckResult(value.bound, value.settle, 'ACKED'),
    value.bound,
    value.settle
  );
  invalid(() => schema.assertRollbackCreateAckRequest(
    ack,
    value.bound,
    value.settle,
    value.rollbackQuarantined
  ));
  const foreignReceiptPhase = {
    ...value.rolledBack,
    items: value.rolledBack.items.map((item, index) => index
      ? item
      : { ...item, quarantineReceiptDigest: digest('f') }),
  };
  phaseSchema.assertPhaseRecord(foreignReceiptPhase, value.selection);
  invalid(() => schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    foreignReceiptPhase
  ));
  invalid(() => schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    { ...value.rolledBack, updatedAt: '2026-08-08T23:59:59.000Z' }
  ));
});

test('deterministic names/digests are frozen in the CREATE_ROLLBACK domain', () => {
  const value = fixture();
  assert.strictEqual(
    schema.rollbackCreateRequestDigest(value.bound),
    'sha256:efe6311f22a4aa85856e49f05ecb9b6c5b247e2949b5fa5d093f30f52c837345'
  );
  assert.strictEqual(
    schema.rollbackCreateRecordNames(value.bound, 0).controlBasename,
    '.changes-history-native-rollback-create-control.10043d3ab103d2357942320a9cd2a0370a497fc88ce87a25f63323f094c8ec45'
  );
  assert.strictEqual(
    value.qControls[0].controlDigest,
    'sha256:1d6f6ff01e8d7a24e7db2b7913296e4b81342ea7680cccff771c422e80851262'
  );
  assert.strictEqual(
    value.qReceipts[0].receiptDigest,
    'sha256:af5353d7b47f71e66cdfac6ac5f85ac38360b77c864ecbbe8720857dd0ec524a'
  );
  assert.strictEqual(
    schema.rollbackCreateReceiptSetDigest(value.settle, value.bound),
    'sha256:f04f7d985cb9eaae2e102c299ec21595f874ffe707c957ac649f59e85161caf4'
  );
  assert.strictEqual(
    schema.rollbackCreateFinalRecordName(value.settle, value.bound),
    '.changes-history-native-rollback-create-final.4a0cfd409669184137609e1b8263b85693262807a71c81357530ab2a555bf482'
  );
  assert.strictEqual(
    value.finalRecord.finalRecordDigest,
    'sha256:7084b095c2d97c6a2c867d22c442f3cb671a4a66809b9be8bc18917be1615f5a'
  );
});

test('Q/R/D/A wire is bounded, domain-tagged and path/body redacted', () => {
  const value = fixture();
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  const wires = [
    schema.encodeRollbackCreateCommand(
      schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
      value.bound
    ),
    schema.encodeRollbackCreateCommand(
      schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
      value.bound
    ),
    schema.encodeRollbackCreateSettleCommand(value.bound, value.settle),
    schema.encodeRollbackCreateAckCommand(ack, value.bound, value.settle, value.rolledBack),
  ];
  assert.deepStrictEqual(wires.map(wire => wire[0]), ['Q', 'R', 'D', 'A']);
  for (const wire of wires) {
    assert.ok(wire.includes('CREATE_ROLLBACK'));
    assert.ok(Buffer.byteLength(wire) <= schema.LIMITS.maxRequestBytes);
    assert.ok(wire.split('\n').some(line => line.startsWith('E\t')));
    assert.ok(wire.includes(value.existing.terminal.items[0]
      .rollbackToken.rollbackReceiptDigest));
    assert.ok(wire.includes(value.existing.terminal.items[0]
      .rollbackToken.rollbackReceiptRecordIdentity.ino));
    assert.ok(wire.includes(Buffer.from(
      evidence.canonicalJson(value.request.existingJournalMarkerBinding), 'utf8'
    ).toString('hex')));
    assert.ok(wire.includes(value.request.baseHistoryIdentityDigest));
    assert.ok(!wire.includes('new-0.md'));
    assert.ok(!wire.includes('/private/tmp'));
  }
});

test('complete wire independently rebuilds CREATE publications and both phase digests', () => {
  const value = fixture();
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  const rebuilt = independentlyRebuildRollbackWireAuthority(
    schema.encodeRollbackCreateCommand(
      schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
      value.bound
    ),
    schema.encodeRollbackCreateAckCommand(
      ack,
      value.bound,
      value.settle,
      value.rolledBack
    )
  );
  assert.deepStrictEqual(rebuilt.selection, value.selection);
  assert.deepStrictEqual(rebuilt.precreate, value.precreate);
  assert.strictEqual(rebuilt.create.precreatePhaseDigest,
    value.nativeCreateRequest.precreatePhaseDigest);
  assert.deepStrictEqual(rebuilt.created, value.created);
  assert.deepStrictEqual(rebuilt.rolledBack, value.rolledBack);
});

test('wire parent indexes and original timestamps reject omission, reorder and forgery', () => {
  const value = fixture(2);
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  const qWire = schema.encodeRollbackCreateCommand(
    schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
    value.bound
  );
  const aWire = schema.encodeRollbackCreateAckCommand(
    ack,
    value.bound,
    value.settle,
    value.rolledBack
  );
  const mutate = callback => {
    const lines = qWire.trimEnd().split('\n').map(line => line.split('\t'));
    callback(lines);
    return `${lines.map(fields => fields.join('\t')).join('\n')}\n`;
  };
  const cases = [
    mutate(lines => { lines.splice(1, 1); }),
    mutate(lines => { lines[2][1] = lines[1][1]; }),
    mutate(lines => { lines[2][1] = '3'; }),
    mutate(lines => { [lines[2], lines[3]] = [lines[3], lines[2]]; }),
    mutate(lines => {
      lines[0][AUTHORITY.originalPrecreateUpdatedAt] =
        Buffer.from('2026-08-08T23:59:59.000Z').toString('hex');
    }),
    mutate(lines => {
      lines[0][AUTHORITY.originalCreatedReceiptUpdatedAt] =
        Buffer.from('2026-08-09T00:00:01.000Z').toString('hex');
    }),
  ];
  for (const hostile of cases) {
    assert.throws(() => independentlyRebuildRollbackWireAuthority(hostile, aWire));
  }
});

test('records/arrays reject accessor, extra, Symbol and sparse data with getter zero', () => {
  const value = fixture();
  let getters = 0;
  const hostile = { ...value.request };
  Object.defineProperty(hostile, 'markerDigest', {
    enumerable: true,
    get() { getters += 1; return digest('9'); },
  });
  invalid(() => schema.assertRollbackCreateRequest(
    hostile,
    value.root,
    value.selection,
    value.precreate,
    value.created,
    value.nativeCreateRequest,
    value.publications,
    value.existing.bound,
    value.existing.terminal,
    value.held
  ));
  const symbolic = { ...value.request, [Symbol('foreign')]: true };
  invalid(() => schema.assertRollbackCreateRequest(
    symbolic,
    value.root,
    value.selection,
    value.precreate,
    value.created,
    value.nativeCreateRequest,
    value.publications,
    value.existing.bound,
    value.existing.terminal,
    value.held
  ));
  const sparse = new Array(1);
  invalid(() => schema.buildRollbackCreateSettleRequest(value.bound, sparse));
  invalid(() => schema.assertRollbackCreateHeldBinding({
    ...value.held,
    extra: true,
  }, value.existing.bound));
  invalid(() => schema.assertRollbackCreateRequest({
    ...value.request,
    extra: true,
  }, value.root, value.selection, value.precreate, value.created, value.nativeCreateRequest,
  value.publications, value.existing.bound, value.existing.terminal, value.held));
  const foreignAuthority = { ...value.bound, extra: true };
  invalid(() => schema.encodeRollbackCreateSettleCommand(
    foreignAuthority,
    value.settle
  ));
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  invalid(() => schema.encodeRollbackCreateAckCommand(
    ack,
    foreignAuthority,
    value.settle,
    value.rolledBack
  ));
  const hostileAuthority = { ...value.bound };
  Object.defineProperty(hostileAuthority, 'existingTerminalReceipt', {
    enumerable: true,
    get() { getters += 1; return value.existing.terminal; },
  });
  invalid(() => schema.encodeRollbackCreateCommand(
    schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
    hostileAuthority
  ));
  const hostilePrecreate = { ...value.precreate };
  Object.defineProperty(hostilePrecreate, 'updatedAt', {
    enumerable: true,
    get() { getters += 1; return value.precreate.updatedAt; },
  });
  invalid(() => schema.assertRollbackCreateAuthority({
    ...value.bound,
    precreatePhase: hostilePrecreate,
  }));
  assert.strictEqual(getters, 0);
});

test('maximum COMMITTED Q/R response has an independent frozen 512 KiB envelope', () => {
  const value = fixture(299);
  const responses = [
    manualRollbackCommittedResponse(value, 'Q'),
    manualRollbackCommittedResponse(value, 'R'),
  ];
  for (const response of responses) {
    const bytes = Buffer.from(response, 'utf8');
    assert(bytes.length > schema.LIMITS.maxResponseBytes);
    assert(bytes.length <= schema.LIMITS.maxRollbackCreateResponseBytes);
    assert.strictEqual(schema.assertRollbackCreateResponseEnvelope(bytes), response);
    invalid(() => schema.assertResponseEnvelope(bytes));
  }
  assert.deepStrictEqual(responses.map(response => ({
    bytes: Buffer.byteLength(response, 'utf8'),
    sha256: crypto.createHash('sha256').update(Buffer.from(response, 'utf8')).digest('hex'),
  })), [
    {
      bytes: 274527,
      sha256: 'cfbe0a53d89652e1ce925d1eb9fe8824315d193494f8d483c6da98d0f618e674',
    },
    {
      bytes: 274527,
      sha256: '4511e82a16eb1e961729755f57ee696a0bed9479ad29b864b7b26692ba9679c4',
    },
  ]);
  const overflow = Buffer.alloc(schema.LIMITS.maxRollbackCreateResponseBytes + 1, 0x61);
  overflow[overflow.length - 1] = 0x0a;
  invalid(() => schema.assertRollbackCreateResponseEnvelope(overflow));
  invalid(() => schema.assertRollbackCreateResponseEnvelope(
    Buffer.from(responses[0].slice(0, -1), 'utf8')
  ));
  invalid(() => schema.assertRollbackCreateResponseEnvelope(
    Buffer.from(responses[0], 'utf8'),
    Buffer.from('foreign stderr', 'utf8')
  ));
  invalid(() => schema.assertRollbackCreateResponseEnvelope(
    Buffer.from([0x50, 0x09, 0x4f, 0x4b, 0x0a, 0xc3, 0x28, 0x0a])
  ));
  invalid(() => schema.assertRollbackCreateResponseEnvelope(
    Buffer.from(`${Array.from({ length: schema.LIMITS.maxItems + 3 }, () => 'P')
      .join('\n')}\n`, 'utf8')
  ));
});

test('maximum Unicode 1E+299I authority freezes every Q/R/D/A wire budget', () => {
  const maximumUnicodePath = index =>
    `${String.fromCodePoint(0x10000 + index)}${'😀'.repeat(1020)}.md`;
  const value = fixture(299, true, maximumUnicodePath);
  assert.strictEqual(value.bound.parentSelection.selected.length, 300);
  assert.strictEqual(value.bound.request.items.length, 299);
  assert(value.bound.parentSelection.selected.every(item =>
    Buffer.byteLength(item.path, 'utf8') === 4087 &&
    Array.from(item.path).length === 1024));
  const ack = schema.buildRollbackCreateAckRequest(
    value.bound,
    value.settle,
    value.finalIdentity,
    value.rolledBack
  );
  const wires = [
    schema.encodeRollbackCreateCommand(
      schema.ROLLBACK_CREATE_COMMANDS.QUARANTINE,
      value.bound
    ),
    schema.encodeRollbackCreateCommand(
      schema.ROLLBACK_CREATE_COMMANDS.RECONCILE,
      value.bound
    ),
    schema.encodeRollbackCreateSettleCommand(value.bound, value.settle),
    schema.encodeRollbackCreateAckCommand(ack, value.bound, value.settle, value.rolledBack),
  ];
  assert.deepStrictEqual(wires.map(wire => wire[0]), ['Q', 'R', 'D', 'A']);
  assert.ok(wires.every(wire => Buffer.byteLength(wire) <= schema.LIMITS.maxRequestBytes));
  for (const wire of wires) {
    const lines = wire.trimEnd().split('\n');
    assert.strictEqual(lines.filter(line => line.startsWith('E\t')).length, 1);
    assert.strictEqual(lines.filter(line => line.startsWith('I\t')).length, 299);
  }
  assert.strictEqual(wires[2].trimEnd().split('\n')
    .filter(line => line.startsWith('T\t')).length, 299);
  assert.strictEqual(wires[3].trimEnd().split('\n')
    .filter(line => line.startsWith('T\t')).length, 299);
  assert.deepStrictEqual(wires.map(wire => ({
    bytes: Buffer.byteLength(wire, 'utf8'),
    maxLine: Math.max(...wire.trimEnd().split('\n')
      .map(line => Buffer.byteLength(`${line}\n`, 'utf8'))),
    sha256: crypto.createHash('sha256').update(Buffer.from(wire, 'utf8')).digest('hex'),
  })), [
    {
      bytes: 2706847,
      maxLine: 9452,
      sha256: '8ae544ebc52cf955376d64b33ab0fa5eca1c94605940ebf98f784bca8af5659b',
    },
    {
      bytes: 2706847,
      maxLine: 9452,
      sha256: 'fd96c640dfcf4c49cdb1ad677e97ee3c0556d746f9c7c5078ef35572334668e4',
    },
    {
      bytes: 2981522,
      maxLine: 9452,
      sha256: '1f4d8445a8d68f7ed324b26bb221853a1bf6ad86a9a3d0f677b17e0c35d459ed',
    },
    {
      bytes: 2981943,
      maxLine: 9452,
      sha256: '09f387fabb219dce4048f55df45f88326335659397dcd68633bbc1d3954732a5',
    },
  ]);
  assert.throws(
    () => phaseSchema.assertParentSelectionBinding(parent(300, maximumUnicodePath)),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/${passed} ROLLBACK_CREATE schema checks passed.`);
