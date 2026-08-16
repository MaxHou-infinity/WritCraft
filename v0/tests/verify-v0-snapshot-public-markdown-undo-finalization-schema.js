#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const nativeSchema = require('../src/main/public-markdown-native-schema');
const finalizationSchema = require(
  '../src/main/snapshot-public-markdown-undo-finalization-schema'
);

const digest = value => `sha256:${String(value).repeat(64)}`;
const revision = value => String(value).repeat(64);
const operationId = `chr_${'a'.repeat(48)}`;

function recordIdentity(wire, seed) {
  const bytes = Buffer.from(wire, 'utf8');
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(40 + seed),
    ino: String(1000 + seed),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(bytes.length),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: evidence.sha256(bytes),
  };
}

function fixture(count = 2, pathForIndex = index => `chapter-${index}.md`) {
  const rootBind = {
    schema: nativeSchema.SCHEMAS.ROOT_BIND,
    canonicalRoot: '/private/tmp/safe-undo-finalization',
    expectedRootIdentityDigest: digest(1),
    expectedRecoveryIdentityDigest: digest(2),
  };
  const parent = {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore_undo',
    selected: Array.from({ length: count }, (_, index) => ({
      selectedId: `created:${index}`,
      action: 'CREATED',
      path: pathForIndex(index),
      revision: revision(((index + 2) % 9) + 1),
      ancestorIdentityDigest: `sha256:${(index + 10).toString(16).padStart(64, '0')}`,
    })),
  };
  const precreate = {
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore_undo',
    phase: 'PRECREATE',
    artifactDigest: digest(9),
    selectionDigest: phaseSchema.digestSelection(parent),
    items: parent.selected.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.revision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: `sha256:${(index + 100).toString(16).padStart(64, '0')}`,
      creationReceiptDigest: null,
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: digest(7),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
  const request = {
    schema: nativeSchema.SCHEMAS.UNDO_REQUEST,
    operationId,
    artifactDigest: precreate.artifactDigest,
    artifactIdentityDigest: digest(6),
    artifactByteLength: 1024,
    rootIdentityDigest: rootBind.expectedRootIdentityDigest,
    recoveryIdentityDigest: rootBind.expectedRecoveryIdentityDigest,
    precreatePhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, precreate),
    selectionDigest: precreate.selectionDigest,
    preparedHistoryDigest: precreate.preparedHistoryDigest,
    items: precreate.items.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      byteLength: index + 1,
      contentDigest: `sha256:${item.afterRevision}`,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: item.createdIdentityDigest,
    })),
  };
  const authority = nativeSchema.buildUndoAuthority(rootBind, parent, precreate, request);
  const tokens = request.items.map((_item, index) => {
    const quarantineBasename = `.changes-history-native-undo-quarantine.${(index + 1)
      .toString(16).padStart(32, '0')}`;
    const receipt = nativeSchema.buildUndoReceipt(
      authority,
      index,
      quarantineBasename,
      `sha256:${(index + 200).toString(16).padStart(64, '0')}`
    );
    const control = nativeSchema.buildUndoControl(authority, index);
    return nativeSchema.buildUndoToken(
      authority,
      index,
      receipt,
      recordIdentity(nativeSchema.encodeUndoControlRecord(control, authority, index), index * 2),
      recordIdentity(nativeSchema.encodeUndoReceiptRecord(receipt, authority, index), index * 2 + 1)
    );
  });
  const quarantined = phaseSchema.assertTransition(precreate, {
    ...precreate,
    phase: 'QUARANTINED',
    items: precreate.items.map((item, index) => ({
      ...item,
      quarantineReceiptDigest: tokens[index].receiptDigest,
    })),
    updatedAt: '2026-08-09T00:00:01.000Z',
  }, parent);
  const historyCommitted = phaseSchema.assertTransition(quarantined, {
    ...quarantined,
    phase: 'HISTORY_COMMITTED',
    updatedAt: '2026-08-09T00:00:02.000Z',
  }, parent);
  return { rootBind, parent, precreate, request, authority, tokens, quarantined, historyCommitted };
}

function committedResult(value, prepared, seed = 900) {
  const identity = recordIdentity(nativeSchema.encodeUndoFinalRecord(
    prepared.finalRecord,
    prepared.settleRequest,
    value.authority,
    'FINALIZE_UNDO'
  ), seed);
  return {
    schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
    command: 'FINALIZE_UNDO',
    state: 'COMMITTED',
    operationId,
    finalRecord: prepared.finalRecord,
    finalRecordIdentity: identity,
    errorCode: null,
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_SNAPSHOT_UNDO_FINALIZATION');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nSnapshot public-Markdown Safe Undo finalization marker schema verification');

test('PREPARED persists exact D request, ordered Q publications and history phase authority', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(
    value.authority,
    value.tokens,
    value.historyCommitted
  );
  assert.deepStrictEqual(Reflect.ownKeys(prepared), finalizationSchema.KEYS);
  assert.strictEqual(prepared.schema, finalizationSchema.SCHEMA);
  assert.strictEqual(prepared.state, 'PREPARED');
  assert.strictEqual(prepared.command, 'FINALIZE_UNDO');
  assert.deepStrictEqual(prepared.settleRequest.tokens, value.tokens);
  assert.strictEqual(prepared.historyCommittedPhaseDigest,
    evidence.digestObject(phaseSchema.SCHEMA, value.historyCommitted));
  assert.strictEqual(prepared.finalRecordIdentity, null);
  assert.strictEqual(prepared.ackRequest, null);
  assert.strictEqual(prepared.ackRequestDigest, null);
  const wire = evidence.canonicalJson(prepared);
  assert.deepStrictEqual({
    bytes: Buffer.byteLength(wire, 'utf8'),
    sha256: crypto.createHash('sha256').update(wire).digest('hex'),
    historyCommittedPhaseDigest: prepared.historyCommittedPhaseDigest,
    settleRequestDigest: prepared.settleRequestDigest,
    receiptSetDigest: prepared.receiptSetDigest,
    finalBasename: prepared.finalBasename,
    finalRecordDigest: prepared.finalRecord.finalRecordDigest,
  }, {
    bytes: 5356,
    sha256: 'e688161f71b2852a6eb81fa075c2282f38a1ab50c1afed2e8ac9b9d97bd1b52f',
    historyCommittedPhaseDigest: 'sha256:810893cca51b2b5c97d893d88fa0b0f21c473761d87ec00a6442be64f44dc5ce',
    settleRequestDigest: 'sha256:ce687ec09e650a73eb48a7fee40ea793e47ff565baf6102eaa4217cd8b6536ee',
    receiptSetDigest: 'sha256:8614a9a0374d76a04141fcbee75d0755303f864861ec4ab5272c40c36dde086a',
    finalBasename: '.changes-history-native-undo-final.f5136757d414a7339182aedfbf939f9495ed6a16dd8dc04328cc45efdd260d81',
    finalRecordDigest: 'sha256:f563d554fea89c218d0d4f43e41376814cbabf7f301307e326fb6d0bc146930c',
  });
  assert(!wire.includes('/private/tmp'));
  assert(!wire.includes('.md'));
  assert(Buffer.byteLength(wire, 'utf8') < finalizationSchema.MAX_BYTES);
});

test('authority is descriptor-exact and rejects getter, extra, reorder and digest drift', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(value.authority, value.tokens, value.historyCommitted);
  let getterCalls = 0;
  const getter = { ...prepared };
  Object.defineProperty(getter, 'settleRequest', {
    enumerable: true,
    get() { getterCalls += 1; return prepared.settleRequest; },
  });
  invalid(() => finalizationSchema.assertAuthority(getter, value.authority));
  invalid(() => finalizationSchema.assertAuthority({ ...prepared, extra: true }, value.authority));
  invalid(() => finalizationSchema.assertAuthority({
    ...prepared,
    settleRequest: {
      ...prepared.settleRequest,
      tokens: [...prepared.settleRequest.tokens].reverse(),
    },
  }, value.authority));
  invalid(() => finalizationSchema.assertAuthority({
    ...prepared,
    historyCommittedPhaseDigest: digest(4),
  }, value.authority));
  assert.strictEqual(getterCalls, 0);
});

test('formal D COMMITTED persists full final identity and independently reproducible A request', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(value.authority, value.tokens, value.historyCommitted);
  const result = committedResult(value, prepared);
  const committed = finalizationSchema.commit(prepared, result, value.authority);
  assert.strictEqual(committed.state, 'COMMITTED');
  assert.deepStrictEqual(committed.finalRecordIdentity, result.finalRecordIdentity);
  assert.deepStrictEqual(committed.ackRequest, nativeSchema.buildUndoAckRequest(
    committed.settleRequest,
    committed.finalRecord,
    committed.finalRecordIdentity,
    value.authority,
    'FINALIZE_UNDO'
  ));
  assert.strictEqual(committed.ackRequestDigest,
    evidence.digestObject(nativeSchema.SCHEMAS.UNDO_ACK_REQUEST, committed.ackRequest));
  const committedWire = evidence.canonicalJson(committed);
  assert.deepStrictEqual({
    bytes: Buffer.byteLength(committedWire, 'utf8'),
    sha256: crypto.createHash('sha256').update(committedWire).digest('hex'),
    ackRequestDigest: committed.ackRequestDigest,
  }, {
    bytes: 6305,
    sha256: '5e157ee38f113acf2f3f342cfbdc834ea69ed7be7f64dc5ef66900480dffa7d9',
    ackRequestDigest: 'sha256:61d67bcaf3e08312b69f43ca21098aabfaa45420ff21578623992e07064bc659',
  });
  assert.strictEqual(finalizationSchema.assertTransition(
    prepared,
    committed,
    value.authority
  ).state, 'COMMITTED');
  invalid(() => finalizationSchema.commit(prepared, {
    ...result,
    state: 'UNKNOWN',
    finalRecord: null,
    finalRecordIdentity: null,
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, value.authority));
  invalid(() => finalizationSchema.assertAuthority({
    ...committed,
    ackRequestDigest: digest(5),
  }, value.authority));
});

test('marker binding retains PREPARED at HISTORY_COMMITTED and COMMITTED at FINALIZED', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(value.authority, value.tokens, value.historyCommitted);
  const committed = finalizationSchema.commit(
    prepared,
    committedResult(value, prepared),
    value.authority
  );
  const finalized = phaseSchema.assertTransition(value.historyCommitted, {
    ...value.historyCommitted,
    phase: 'FINALIZED',
    finalReceiptDigest: committed.finalRecord.finalRecordDigest,
  }, value.parent);
  assert.strictEqual(finalizationSchema.assertMarkerBinding(
    null, value.authority, value.historyCommitted, null
  ), null);
  assert.strictEqual(finalizationSchema.assertMarkerBinding(
    prepared, value.authority, value.historyCommitted, null
  ).state, 'PREPARED');
  assert.strictEqual(finalizationSchema.assertMarkerBinding(
    committed, value.authority, finalized, null
  ).state, 'COMMITTED');
  invalid(() => finalizationSchema.assertMarkerBinding(
    committed, value.authority, value.historyCommitted, null
  ));
  invalid(() => finalizationSchema.assertMarkerBinding(
    null, value.authority, finalized, null
  ));
  invalid(() => finalizationSchema.assertMarkerBinding(
    prepared, value.authority, value.historyCommitted, { state: 'PREPARED' }
  ));
  invalid(() => finalizationSchema.assertMarkerBinding(
    prepared,
    value.authority,
    { ...value.historyCommitted, updatedAt: '2026-08-09T00:00:03.000Z' },
    null
  ));
});

test('one marker transition gate permits only null to PREPARED, D commit and exact replay', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(value.authority, value.tokens, value.historyCommitted);
  const committed = finalizationSchema.commit(
    prepared,
    committedResult(value, prepared),
    value.authority
  );
  const finalized = phaseSchema.assertTransition(value.historyCommitted, {
    ...value.historyCommitted,
    phase: 'FINALIZED',
    finalReceiptDigest: committed.finalRecord.finalRecordDigest,
  }, value.parent);
  assert.strictEqual(finalizationSchema.assertMarkerTransition(
    null, prepared, value.authority, value.historyCommitted, value.historyCommitted
  ).state, 'PREPARED');
  assert.strictEqual(finalizationSchema.assertMarkerTransition(
    prepared, committed, value.authority, value.historyCommitted, finalized
  ).state, 'COMMITTED');
  assert.strictEqual(finalizationSchema.assertMarkerTransition(
    committed, committed, value.authority, finalized, finalized
  ).state, 'COMMITTED');
  invalid(() => finalizationSchema.assertMarkerTransition(
    null, committed, value.authority, value.historyCommitted, finalized
  ));
  invalid(() => finalizationSchema.assertMarkerTransition(
    prepared, null, value.authority, value.historyCommitted, value.historyCommitted
  ));
  invalid(() => finalizationSchema.assertMarkerTransition(
    committed, null, value.authority, finalized, finalized
  ));
  invalid(() => finalizationSchema.assertMarkerTransition(
    committed,
    { ...committed, ackRequestDigest: digest(8) },
    value.authority,
    finalized,
    finalized
  ));
  invalid(() => finalizationSchema.assertMarkerTransition(
    null,
    prepared,
    value.authority,
    value.historyCommitted,
    value.historyCommitted,
    null,
    { state: 'PREPARED' }
  ));
});

test('cross-command, stale original authority and partial final truth fail closed', () => {
  const value = fixture();
  const prepared = finalizationSchema.prepare(value.authority, value.tokens, value.historyCommitted);
  invalid(() => finalizationSchema.assertAuthority({
    ...prepared,
    command: 'RESTORE_QUARANTINE',
  }, value.authority));
  const other = fixture();
  other.request.artifactIdentityDigest = digest(4);
  const otherAuthority = nativeSchema.buildUndoAuthority(
    other.rootBind,
    other.parent,
    other.precreate,
    other.request
  );
  invalid(() => finalizationSchema.assertAuthority(prepared, otherAuthority));
  const result = committedResult(value, prepared);
  invalid(() => finalizationSchema.commit(prepared, {
    ...result,
    finalRecordIdentity: null,
  }, value.authority));
});

test('maximum 300-item Unicode authority stays under marker budget and 301 is rejected', () => {
  const maximumPath = index => `${String.fromCodePoint(0x10000 + index)}${'😀'.repeat(1020)}.md`;
  const value = fixture(nativeSchema.LIMITS.maxItems, maximumPath);
  const prepared = finalizationSchema.prepare(
    value.authority,
    value.tokens,
    value.historyCommitted
  );
  const committed = finalizationSchema.commit(
    prepared,
    committedResult(value, prepared),
    value.authority
  );
  assert.strictEqual(prepared.settleRequest.tokens.length, nativeSchema.LIMITS.maxItems);
  assert.deepStrictEqual({
    preparedBytes: evidence.canonicalJsonByteLength(prepared),
    committedBytes: evidence.canonicalJsonByteLength(committed),
  }, {
    preparedBytes: 454582,
    committedBytes: 455531,
  });
  assert(evidence.canonicalJsonByteLength(committed) < finalizationSchema.MAX_BYTES);
  assert.throws(
    () => fixture(nativeSchema.LIMITS.maxItems + 1, maximumPath),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/7 Safe Undo finalization marker schema checks passed.`);
