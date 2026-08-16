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
  const held = schema.buildRollbackCreateHeldBinding(
    4096,
    heldIdentity(4096, digest('d'), 1),
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

function independentlyRebuildRollbackWireAuthority(qWire, aWire) {
  const qLines = qWire.trimEnd().split('\n').map(line => line.split('\t'));
  const aLines = aWire.trimEnd().split('\n').map(line => line.split('\t'));
  const header = qLines[0];
  const existing = qLines.filter(fields => fields[0] === 'E');
  const missing = qLines.filter(fields => fields[0] === 'I');
  assert.strictEqual(header.length, 30);
  assert.strictEqual(existing.length, Number(header[27]));
  assert.strictEqual(missing.length, Number(header[28]));
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
  assert.strictEqual(phaseSchema.digestSelection(selection), header[14]);
  const create = schema.assertCreateRequest({
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId: header[2],
    artifactDigest: header[7],
    artifactIdentityDigest: header[8],
    artifactByteLength: Number(header[9]),
    precreatePhaseDigest: header[12],
    selectionDigest: header[14],
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
    operationId: header[2],
    kind: 'snapshot_restore',
    phase: 'PRECREATE',
    artifactDigest: header[7],
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
    updatedAt: decodeHexUtf8(header[16]),
  };
  phaseSchema.assertPhaseRecord(precreate, selection);
  assert.strictEqual(evidence.digestObject(phaseSchema.SCHEMA, precreate), header[12]);
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
    operationId: header[2],
    kind: 'snapshot_restore',
    phase: 'CREATED_RECEIPT',
    artifactDigest: header[7],
    selectionDigest: header[14],
    items: missing.map(fields => ({
      selectedId: fields[2],
      path: decodeHexUtf8(fields[3]),
      afterRevision: fields[6].slice('sha256:'.length),
      ancestorIdentityDigest: fields[7],
      createdIdentityDigest: fields[8],
      creationReceiptDigest: fields[12],
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: header[15],
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: decodeHexUtf8(header[17]),
  };
  phaseSchema.assertPhaseRecord(created, selection);
  assert.strictEqual(evidence.digestObject(phaseSchema.SCHEMA, created), header[13]);
  const aHeader = aLines[0];
  const tokens = aLines.filter(fields => fields[0] === 'T');
  assert.strictEqual(aHeader.length, 44);
  assert.deepStrictEqual(aHeader.slice(2, 30), header.slice(2));
  assert.deepStrictEqual(
    aLines.filter(fields => ['E', 'I'].includes(fields[0])),
    qLines.filter(fields => ['E', 'I'].includes(fields[0]))
  );
  assert.strictEqual(tokens.length, Number(aHeader[43]));
  assert.ok(Date.parse(decodeHexUtf8(aHeader[33])) >= Date.parse(created.updatedAt));
  const rolledBack = {
    ...created,
    phase: 'ROLLED_BACK',
    items: created.items.map((item, index) => ({
      ...item,
      quarantineReceiptDigest: tokens[index][9],
    })),
    existingReceiptSetDigest: aHeader[20],
    rollbackReceiptDigest: aHeader[31],
    updatedAt: decodeHexUtf8(aHeader[33]),
  };
  phaseSchema.assertPhaseRecord(rolledBack, selection);
  assert.strictEqual(evidence.digestObject(phaseSchema.SCHEMA, rolledBack), aHeader[32]);
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

test('held marker and raw History descriptors are explicit rollback-create authority', () => {
  const value = fixture();
  assert.deepStrictEqual(
    schema.assertRollbackCreateHeldBinding(value.held, value.existing.bound),
    value.held
  );
  assert.strictEqual(value.request.markerIdentityDigest,
    evidence.digestObjectIdentity(value.held.markerIdentity));
  assert.strictEqual(value.request.baseHistoryIdentityDigest,
    evidence.digestObjectIdentity(value.held.baseHistoryIdentity));
  let getters = 0;
  const hostile = { ...value.held };
  Object.defineProperty(hostile, 'markerIdentity', {
    enumerable: true,
    get() { getters += 1; return value.held.markerIdentity; },
  });
  invalid(() => schema.assertRollbackCreateHeldBinding(hostile, value.existing.bound));
  for (const markerIdentity of [
    { ...value.held.markerIdentity, mode: 0o644 },
    { ...value.held.markerIdentity, nlink: 2 },
  ]) {
    invalid(() => schema.assertRollbackCreateHeldBinding({
      ...value.held,
      markerIdentity,
    }, value.existing.bound));
  }
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
    'sha256:d58c74d16de1e02a28b8499eca404e598bcd23193967568993a74f5696f4a039'
  );
  assert.strictEqual(
    schema.rollbackCreateRecordNames(value.bound, 0).controlBasename,
    '.changes-history-native-rollback-create-control.e1a899ea57f9321fbe03789ab10e3dc6fb8f4f873af69147225dfa49e6794047'
  );
  assert.strictEqual(
    value.qControls[0].controlDigest,
    'sha256:dfae4e6f1f006793896b07b8dcad7b6643c0cd43fefeb8f54c094004e443548b'
  );
  assert.strictEqual(
    value.qReceipts[0].receiptDigest,
    'sha256:bc315254d4a1737cefa52702422bd65a71cab04a1a9005e65fd735ae1a935aa3'
  );
  assert.strictEqual(
    schema.rollbackCreateReceiptSetDigest(value.settle, value.bound),
    'sha256:e14115693e50789700f3ac9ccc2d96830d019cee11fb4891cc7b9b9191717114'
  );
  assert.strictEqual(
    schema.rollbackCreateFinalRecordName(value.settle, value.bound),
    '.changes-history-native-rollback-create-final.ff2987144537178fff958d59c31ee1c4a11ab8cf847ea74561e498fad8f36954'
  );
  assert.strictEqual(
    value.finalRecord.finalRecordDigest,
    'sha256:6ae7055a905ebf8d990be05f31e1f43229f6a8414a1b19e71253a523aacb9381'
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
    assert.ok(wire.includes(value.request.markerIdentityDigest));
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
    mutate(lines => { lines[0][16] = Buffer.from('2026-08-08T23:59:59.000Z').toString('hex'); }),
    mutate(lines => { lines[0][17] = Buffer.from('2026-08-09T00:00:01.000Z').toString('hex'); }),
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
      sha256: 'fd9420c1b1e340ab0760df9bb1d6d6469039d3ab770c985f7f247d3bee2309ca',
    },
    {
      bytes: 274527,
      sha256: '4ca26df61122802da60aa1b69704207de437a55187295247b607cc14d1bb5b41',
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
      bytes: 2703309,
      maxLine: 9452,
      sha256: '9e109d1c535b64564fd79cb542d84dda7e83e9d0941f67cf060d20721aa7a25e',
    },
    {
      bytes: 2703309,
      maxLine: 9452,
      sha256: '698b39388681f15706ff5ee1e86f90a3502c69a08b9d269333f2fc16efebea84',
    },
    {
      bytes: 2977984,
      maxLine: 9452,
      sha256: '3772400ea432ee3942b0df0a472ad524244620bfa19221004b9486ce960132c4',
    },
    {
      bytes: 2978405,
      maxLine: 9452,
      sha256: '859702567f140fd066caec96eb20cc8de41526fc97a3ecc3c34c9e9dd430f924',
    },
  ]);
  assert.throws(
    () => phaseSchema.assertParentSelectionBinding(parent(300, maximumUnicodePath)),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/${passed} ROLLBACK_CREATE schema checks passed.`);
