#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const nativeSchema = require('../src/main/public-markdown-native-schema');
const settlementSchema = require('../src/main/snapshot-public-markdown-undo-settlement-schema');

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
    canonicalRoot: '/private/tmp/safe-undo-settlement',
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
  return { rootBind, parent, precreate, request, authority, tokens, quarantined };
}

function committedResult(value, prepared, seed = 900) {
  const identity = recordIdentity(nativeSchema.encodeUndoFinalRecord(
    prepared.finalRecord,
    prepared.settleRequest,
    value.authority,
    'RESTORE_QUARANTINE'
  ), seed);
  return {
    schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
    command: 'RESTORE_QUARANTINE',
    state: 'COMMITTED',
    operationId,
    finalRecord: prepared.finalRecord,
    finalRecordIdentity: identity,
    errorCode: null,
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_SNAPSHOT_UNDO_SETTLEMENT');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nSnapshot public-Markdown Safe Undo settlement marker schema verification');

test('PREPARED persists exact B request, full ordered Q tokens and deterministic final authority', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  assert.deepStrictEqual(Reflect.ownKeys(prepared), settlementSchema.KEYS);
  assert.strictEqual(prepared.schema, settlementSchema.SCHEMA);
  assert.strictEqual(prepared.state, 'PREPARED');
  assert.strictEqual(prepared.command, 'RESTORE_QUARANTINE');
  assert.strictEqual(prepared.settleRequest.tokens.length, value.tokens.length);
  assert.deepStrictEqual(prepared.settleRequest.tokens, value.tokens);
  assert.strictEqual(prepared.finalRecordIdentity, null);
  assert.match(prepared.undoRequestDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(prepared.settleRequestDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(prepared.receiptSetDigest, /^sha256:[a-f0-9]{64}$/u);
  assert(nativeSchema.UNDO_FINAL_BASENAME_RE.test(prepared.finalBasename));
  const wire = evidence.canonicalJson(prepared);
  assert.deepStrictEqual({
    bytes: Buffer.byteLength(wire, 'utf8'),
    sha256: crypto.createHash('sha256').update(wire).digest('hex'),
    undoRequestDigest: prepared.undoRequestDigest,
    settleRequestDigest: prepared.settleRequestDigest,
    receiptSetDigest: prepared.receiptSetDigest,
    finalBasename: prepared.finalBasename,
    finalRecordDigest: prepared.finalRecord.finalRecordDigest,
  }, {
    bytes: 5085,
    sha256: 'abf3d06b07161539ebb1183865a050233075982529428dd457b36d5bdbce9cc2',
    undoRequestDigest: 'sha256:21b15a78140cc66b3a974f0fb0a10aece016609e98d2328c11086c641d4ceb36',
    settleRequestDigest: 'sha256:0605f6ca5eba604bc70f139b4fd6444b706f7d5cce8818e070f5739e0d794dce',
    receiptSetDigest: 'sha256:8614a9a0374d76a04141fcbee75d0755303f864861ec4ab5272c40c36dde086a',
    finalBasename: '.changes-history-native-undo-final.3aa671dd1d20d24e8128db948493b97ec058c79711d67c748cf4ecc08356a4b1',
    finalRecordDigest: 'sha256:d258ddd3f0a370c6b0d8c63ae9551b5846f0682afc040f0c016a624ec2a196fd',
  });
  assert(!wire.includes('/private/tmp'));
  assert(!wire.includes('.md'));
  assert(Buffer.byteLength(wire, 'utf8') < settlementSchema.MAX_BYTES);
});

test('authority is descriptor-exact and rejects getter, extra, reorder and digest drift', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  let getterCalls = 0;
  const getter = { ...prepared };
  Object.defineProperty(getter, 'settleRequest', {
    enumerable: true,
    get() { getterCalls += 1; return prepared.settleRequest; },
  });
  invalid(() => settlementSchema.assertAuthority(getter, value.authority));
  invalid(() => settlementSchema.assertAuthority({ ...prepared, extra: true }, value.authority));
  invalid(() => settlementSchema.assertAuthority({
    ...prepared,
    settleRequest: {
      ...prepared.settleRequest,
      tokens: [...prepared.settleRequest.tokens].reverse(),
    },
  }, value.authority));
  invalid(() => settlementSchema.assertAuthority({
    ...prepared,
    undoRequestDigest: digest(4),
  }, value.authority));
  assert.strictEqual(getterCalls, 0);
});

test('only formal B COMMITTED installs exact final identity and permits PREPARED to COMMITTED', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  const result = committedResult(value, prepared);
  const committed = settlementSchema.commit(prepared, result, value.authority);
  assert.strictEqual(committed.state, 'COMMITTED');
  assert.deepStrictEqual(committed.finalRecordIdentity, result.finalRecordIdentity);
  assert.strictEqual(settlementSchema.assertTransition(
    prepared,
    committed,
    value.authority
  ).state, 'COMMITTED');
  invalid(() => settlementSchema.commit(prepared, {
    ...result,
    state: 'UNKNOWN',
    finalRecord: null,
    finalRecordIdentity: null,
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, value.authority));
  invalid(() => settlementSchema.assertAuthority({
    ...committed,
    finalRecordIdentity: {
      ...committed.finalRecordIdentity,
      extra: true,
    },
  }, value.authority));
});

test('marker binding allows one B branch and RESTORED retains committed A authority', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  const committed = settlementSchema.commit(
    prepared,
    committedResult(value, prepared),
    value.authority
  );
  assert.strictEqual(settlementSchema.assertMarkerBinding(
    null,
    value.authority,
    value.quarantined
  ), null);
  assert.strictEqual(settlementSchema.assertMarkerBinding(
    prepared,
    value.authority,
    value.quarantined
  ).state, 'PREPARED');
  invalid(() => settlementSchema.assertMarkerBinding(
    prepared,
    value.authority,
    value.precreate
  ));
  const restored = phaseSchema.assertTransition(value.quarantined, {
    ...value.quarantined,
    phase: 'RESTORED',
    finalReceiptDigest: committed.finalRecord.finalRecordDigest,
    updatedAt: '2026-08-09T00:00:02.000Z',
  }, value.parent);
  assert.strictEqual(settlementSchema.assertMarkerBinding(
    committed,
    value.authority,
    restored
  ).state, 'COMMITTED');
  invalid(() => settlementSchema.assertMarkerBinding(null, value.authority, restored));
  invalid(() => settlementSchema.assertMarkerBinding(prepared, value.authority, restored));
  invalid(() => settlementSchema.assertMarkerBinding(committed, value.authority, value.quarantined));
  const historyCommitted = phaseSchema.assertTransition(value.quarantined, {
    ...value.quarantined,
    phase: 'HISTORY_COMMITTED',
    updatedAt: '2026-08-09T00:00:02.000Z',
  }, value.parent);
  invalid(() => settlementSchema.assertMarkerBinding(prepared, value.authority, historyCommitted));
  assert.strictEqual(settlementSchema.assertMarkerBinding(
    null,
    value.authority,
    historyCommitted
  ), null);
});

test('one marker transition authority closes null, prepared, committed and replay CAS', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  const committed = settlementSchema.commit(
    prepared,
    committedResult(value, prepared),
    value.authority
  );
  const restored = phaseSchema.assertTransition(value.quarantined, {
    ...value.quarantined,
    phase: 'RESTORED',
    finalReceiptDigest: committed.finalRecord.finalRecordDigest,
    updatedAt: '2026-08-09T00:00:02.000Z',
  }, value.parent);
  assert.strictEqual(settlementSchema.assertMarkerTransition(
    null,
    prepared,
    value.authority,
    value.quarantined,
    value.quarantined
  ).state, 'PREPARED');
  assert.strictEqual(settlementSchema.assertMarkerTransition(
    prepared,
    committed,
    value.authority,
    value.quarantined,
    restored
  ).state, 'COMMITTED');
  assert.strictEqual(settlementSchema.assertMarkerTransition(
    committed,
    committed,
    value.authority,
    restored,
    restored
  ).state, 'COMMITTED');
  invalid(() => settlementSchema.assertMarkerTransition(
    null,
    committed,
    value.authority,
    value.quarantined,
    restored
  ));
  invalid(() => settlementSchema.assertMarkerTransition(
    prepared,
    null,
    value.authority,
    value.quarantined,
    value.quarantined
  ));
  invalid(() => settlementSchema.assertMarkerTransition(
    committed,
    null,
    value.authority,
    restored,
    restored
  ));
  invalid(() => settlementSchema.assertMarkerTransition(
    null,
    prepared,
    value.authority,
    value.precreate,
    value.quarantined
  ));
  invalid(() => settlementSchema.assertMarkerTransition(
    committed,
    {
      ...committed,
      finalRecordIdentity: {
        ...committed.finalRecordIdentity,
        ino: String(Number(committed.finalRecordIdentity.ino) + 1),
      },
    },
    value.authority,
    restored,
    restored
  ));
  invalid(() => settlementSchema.assertMarkerTransition(
    committed,
    committed,
    value.authority,
    restored,
    { ...restored, updatedAt: '2026-08-09T00:00:03.000Z' }
  ));
});

test('cross-command, stale original authority and partial final truth fail closed', () => {
  const value = fixture();
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  invalid(() => settlementSchema.assertAuthority({
    ...prepared,
    command: 'FINALIZE_UNDO',
  }, value.authority));
  const other = fixture();
  other.request.artifactIdentityDigest = digest(4);
  const otherAuthority = nativeSchema.buildUndoAuthority(
    other.rootBind,
    other.parent,
    other.precreate,
    other.request
  );
  invalid(() => settlementSchema.assertAuthority(prepared, otherAuthority));
  const result = committedResult(value, prepared);
  invalid(() => settlementSchema.commit(prepared, {
    ...result,
    finalRecordIdentity: null,
  }, value.authority));
});

test('maximum 300-item authority remains below marker budget and 301 is rejected', () => {
  const maximumPath = index => `${String.fromCodePoint(0x10000 + index)}${'😀'.repeat(1020)}.md`;
  const value = fixture(nativeSchema.LIMITS.maxItems, maximumPath);
  const prepared = settlementSchema.prepare(value.authority, value.tokens);
  assert.strictEqual(prepared.settleRequest.tokens.length, nativeSchema.LIMITS.maxItems);
  assert.strictEqual(evidence.canonicalJsonByteLength(prepared), 454311);
  assert(454311 < settlementSchema.MAX_BYTES);
  assert.throws(
    () => fixture(nativeSchema.LIMITS.maxItems + 1, maximumPath),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/7 Safe Undo settlement marker schema checks passed.`);
