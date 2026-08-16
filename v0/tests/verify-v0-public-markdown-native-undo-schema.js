#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const schema = require('../src/main/public-markdown-native-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;
const revision = value => String(value).repeat(64);
const digit = value => String(((value - 1) % 9) + 1);
const uniqueDigest = (index, first) => index < 2
  ? digest(first + index)
  : `sha256:${(index + 256).toString(16).padStart(64, '0')}`;
const uniqueQuarantine = index => index < 2
  ? digit(index + 1).repeat(32)
  : (index + 256).toString(16).padStart(32, '0');
const operationId = `chr_${'a'.repeat(48)}`;
const independentWireSha256 = wire => crypto.createHash('sha256')
  .update(Buffer.from(wire, 'utf8'))
  .digest('hex');

function recordIdentity(wire, seed) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(40 + seed),
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

function rootBind(overrides = {}) {
  return {
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: '/private/tmp/safe-undo',
    expectedRootIdentityDigest: digest(1),
    expectedRecoveryIdentityDigest: digest(2),
    ...overrides,
  };
}

function parentSelection(createdCount = 2, pathForIndex = index => `chapter-${index}.md`) {
  return {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore_undo',
    selected: [...(createdCount < schema.LIMITS.maxItems ? [{
      selectedId: 'existing:0',
      action: 'EXISTING',
      path: 'existing.md',
      revision: revision(8),
      ancestorIdentityDigest: digest(8),
    }] : []), ...Array.from({ length: createdCount }, (_, index) => ({
      selectedId: `created:${index}`,
      action: 'CREATED',
      path: pathForIndex(index),
      revision: revision(digit(index + 3)),
      ancestorIdentityDigest: digest(digit(index + 3)),
    }))],
  };
}

function precreatePhase(parent) {
  return {
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore_undo',
    phase: 'PRECREATE',
    artifactDigest: digest(9),
    selectionDigest: phaseSchema.digestSelection(parent),
    items: parent.selected.filter(item => item.action === 'CREATED').map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.revision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: uniqueDigest(index, 5),
      creationReceiptDigest: null,
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: digest(7),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

function undoRequest(root, parent, phase, overrides = {}) {
  return {
    schema: schema.SCHEMAS.UNDO_REQUEST,
    operationId,
    artifactDigest: phase.artifactDigest,
    artifactIdentityDigest: digest(6),
    artifactByteLength: 1024,
    rootIdentityDigest: root.expectedRootIdentityDigest,
    recoveryIdentityDigest: root.expectedRecoveryIdentityDigest,
    precreatePhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, phase),
    selectionDigest: phase.selectionDigest,
    preparedHistoryDigest: phase.preparedHistoryDigest,
    items: phase.items.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      byteLength: index + 1,
      contentDigest: `sha256:${item.afterRevision}`,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: item.createdIdentityDigest,
    })),
    ...overrides,
  };
}

function authority(createdCount = 2, pathForIndex = undefined) {
  const root = rootBind();
  const parent = parentSelection(createdCount, pathForIndex);
  const phase = precreatePhase(parent);
  const request = undoRequest(root, parent, phase);
  const bound = schema.buildUndoAuthority(root, parent, phase, request);
  const receipts = request.items.map((_item, index) => schema.buildUndoReceipt(
    bound,
    index,
    `.changes-history-native-undo-quarantine.${uniqueQuarantine(index)}`,
    uniqueDigest(index, 1)
  ));
  const tokens = receipts.map((receipt, index) => {
    const control = schema.buildUndoControl(bound, index);
    return schema.buildUndoToken(
      bound,
      index,
      receipt,
      recordIdentity(schema.encodeUndoControlRecord(control, bound, index), index * 2 + 1),
      recordIdentity(schema.encodeUndoReceiptRecord(receipt, bound, index), index * 2 + 2)
    );
  });
  const restore = schema.buildUndoSettleRequest(bound, 'RESTORE_QUARANTINE', tokens);
  const finalize = schema.buildUndoSettleRequest(bound, 'FINALIZE_UNDO', tokens, digest(8));
  return { root, parent, phase, request, bound, receipts, tokens, restore, finalize };
}

function finalIdentity(value, settle, expectedCommand, seed = 900) {
  const finalRecord = schema.buildUndoFinalRecord(settle, value.bound, expectedCommand);
  return recordIdentity(schema.encodeUndoFinalRecord(
    finalRecord,
    settle,
    value.bound,
    expectedCommand
  ), seed);
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'PUBLIC_MARKDOWN_NATIVE_PROTOCOL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPrivate public-Markdown Safe Undo schema verification');

test('request binds root, artifact, History, phase and the complete ordered CREATED subset', () => {
  const value = authority();
  assert.strictEqual(schema.assertUndoAuthority(value.bound).request.items.length, 2);
  invalid(() => schema.assertUndoRequest(value.request));
  invalid(() => schema.assertUndoRequest(
    { ...value.request, items: value.request.items.slice(1) },
    value.root,
    value.parent,
    value.phase
  ));
  invalid(() => schema.assertUndoRequest(
    { ...value.request, items: [...value.request.items].reverse() },
    value.root,
    value.parent,
    value.phase
  ));
  invalid(() => schema.assertUndoRequest(
    { ...value.request, rootIdentityDigest: digest(4) },
    value.root,
    value.parent,
    value.phase
  ));
  invalid(() => schema.assertUndoRequest(
    { ...value.request, preparedHistoryDigest: digest(4) },
    value.root,
    value.parent,
    value.phase
  ));
});

test('3.1.4 control, receipt, set and final names have frozen deterministic goldens', () => {
  const value = authority();
  const control = schema.buildUndoControl(value.bound, 0);
  assert.deepStrictEqual(schema.undoRecordNames(value.bound, 0), {
    controlBasename: '.changes-history-native-undo-control.cd5ed4c4f3fef7e4337174e3c6639db0b895e9d7c2eb61e56fda42ae79a7b94a',
    receiptBasename: '.changes-history-native-undo-receipt.cd5ed4c4f3fef7e4337174e3c6639db0b895e9d7c2eb61e56fda42ae79a7b94a',
  });
  assert.strictEqual(
    control.controlDigest,
    'sha256:4c61d7cf092d4713b1c8d0de4f3070c51e764d37c88482f98346078e5ab32df4'
  );
  assert.strictEqual(
    value.receipts[0].receiptDigest,
    'sha256:e8a275cc22d20a4ac8dcc067cfc9e9730855e14a32a8e6fa11143cad7466db45'
  );
  assert.strictEqual(
    schema.undoReceiptSetDigest(value.finalize, value.bound, 'FINALIZE_UNDO'),
    'sha256:7027d52c0db779d61fcc422eabd6c9803a1fff9f780412694520f70a08cce62f'
  );
  assert.strictEqual(
    schema.undoFinalRecordName(value.finalize, value.bound, 'FINALIZE_UNDO'),
    '.changes-history-native-undo-final.510db8215d893c186541e21a35aa823c08943dcc358f6f72d409169069d638ae'
  );
});

test('getter, extra, hidden, sparse and named-array authority fails without getter invocation', () => {
  const value = authority();
  let getters = 0;
  const hostile = { ...value.request };
  Object.defineProperty(hostile, 'artifactDigest', {
    enumerable: true,
    get() { getters += 1; return value.request.artifactDigest; },
  });
  invalid(() => schema.assertUndoRequest(hostile, value.root, value.parent, value.phase));
  assert.strictEqual(getters, 0);
  invalid(() => schema.assertUndoRequest(
    { ...value.request, absolutePath: '/private/tmp/body' },
    value.root,
    value.parent,
    value.phase
  ));
  const hidden = { ...value.bound };
  Object.defineProperty(hidden, 'hidden', { value: true });
  invalid(() => schema.assertUndoAuthority(hidden));
  const sparse = { ...value.request, items: new Array(2) };
  invalid(() => schema.assertUndoRequest(sparse, value.root, value.parent, value.phase));
  const named = { ...value.request, items: [...value.request.items] };
  named.items.extra = true;
  invalid(() => schema.assertUndoRequest(named, value.root, value.parent, value.phase));
});

test('quarantine token rederives canonical record bytes and rejects nested identity hostility', () => {
  const value = authority();
  const control = schema.buildUndoControl(value.bound, 0);
  const receipt = value.receipts[0];
  const token = value.tokens[0];
  assert.strictEqual(schema.assertBoundUndoToken(token, value.bound, 0).receiptDigest,
    receipt.receiptDigest);
  invalid(() => schema.assertUndoControl(control));
  invalid(() => schema.assertUndoReceipt(receipt));
  invalid(() => schema.assertBoundUndoToken(token));
  invalid(() => schema.assertBoundUndoToken({
    ...token,
    quarantineIdentityDigest: digest(9),
  }, value.bound, 0));
  const extraIdentity = { ...token.controlRecordIdentity, extra: true };
  invalid(() => schema.assertBoundUndoToken({
    ...token,
    controlRecordIdentity: extraIdentity,
  }, value.bound, 0));
  invalid(() => schema.assertBoundUndoToken({
    ...token,
    controlRecordIdentity: {
      ...token.controlRecordIdentity,
      contentSha256: digest(9),
    },
  }, value.bound, 0));
  let getters = 0;
  const getterIdentity = { ...token.receiptRecordIdentity };
  Object.defineProperty(getterIdentity, 'ino', {
    enumerable: true,
    get() { getters += 1; return token.receiptRecordIdentity.ino; },
  });
  invalid(() => schema.assertBoundUndoToken({
    ...token,
    receiptRecordIdentity: getterIdentity,
  }, value.bound, 0));
  assert.strictEqual(getters, 0);
  invalid(() => schema.assertBoundUndoToken({
    ...token,
    receiptBasename: `.changes-history-native-undo-receipt.${'f'.repeat(64)}`,
  }, value.bound, 0));
  invalid(() => schema.parseUndoTokenStructure(schema.buildToken(
    schema.assertCreateRequest({
      schema: schema.SCHEMAS.CREATE_REQUEST,
      operationId,
      artifactDigest: digest(1),
      artifactIdentityDigest: digest(2),
      artifactByteLength: 10,
      precreatePhaseDigest: digest(3),
      selectionDigest: digest(4),
      items: [{ selectedId: 'x', path: 'x.md', artifactOffset: 0, byteLength: 1,
        contentDigest: digest(5), ancestorIdentityDigest: digest(6) }],
    }),
    0,
    schema.buildReceipt(schema.buildControl({
      schema: schema.SCHEMAS.CREATE_REQUEST,
      operationId,
      artifactDigest: digest(1),
      artifactIdentityDigest: digest(2),
      artifactByteLength: 10,
      precreatePhaseDigest: digest(3),
      selectionDigest: digest(4),
      items: [{ selectedId: 'x', path: 'x.md', artifactOffset: 0, byteLength: 1,
        contentDigest: digest(5), ancestorIdentityDigest: digest(6) }],
    }, 0), digest(7))
  )));
});

test('QUARANTINE and fresh RECONCILE_UNDO have command-bound three-state truth', () => {
  const value = authority();
  const base = {
    schema: schema.SCHEMAS.UNDO_RESULT,
    command: 'QUARANTINE',
    state: 'COMMITTED',
    operationId,
    artifactDigest: value.request.artifactDigest,
    precreatePhaseDigest: value.request.precreatePhaseDigest,
    selectionDigest: value.request.selectionDigest,
    preparedHistoryDigest: value.request.preparedHistoryDigest,
    tokens: value.tokens,
    errorCode: null,
  };
  assert.strictEqual(schema.assertUndoResult(base, value.bound, 'QUARANTINE').state, 'COMMITTED');
  assert.strictEqual(schema.assertUndoResult({
    ...base, command: 'RECONCILE_UNDO', state: 'UNCOMMITTED', tokens: [],
  }, value.bound, 'RECONCILE_UNDO').state, 'UNCOMMITTED');
  assert.strictEqual(schema.assertUndoResult({
    ...base,
    command: 'RECONCILE_UNDO',
    state: 'UNKNOWN',
    tokens: [],
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, value.bound, 'RECONCILE_UNDO').state, 'UNKNOWN');
  invalid(() => schema.assertUndoResult({ ...base, command: 'RECONCILE_UNDO' },
    value.bound, 'QUARANTINE'));
  invalid(() => schema.assertUndoResult(base, value.bound));
  invalid(() => schema.assertUndoResult({ ...base, tokens: [] }, value.bound, 'QUARANTINE'));
});

test('RESTORE_QUARANTINE and FINALIZE_UNDO enforce opposite History phase authority', () => {
  const value = authority();
  assert.strictEqual(value.restore.historyCommittedPhaseDigest, null);
  assert.strictEqual(value.finalize.historyCommittedPhaseDigest, digest(8));
  invalid(() => schema.assertUndoSettleRequest(value.restore, value.bound, 'FINALIZE_UNDO'));
  invalid(() => schema.assertUndoSettleRequest(value.finalize, value.bound, 'RESTORE_QUARANTINE'));
  invalid(() => schema.buildUndoSettleRequest(
    value.bound,
    'FINALIZE_UNDO',
    value.tokens,
    null
  ));
  invalid(() => schema.assertUndoSettleRequest(value.finalize));
  invalid(() => schema.assertUndoSettleRequest({
    ...value.finalize,
    tokens: [...value.finalize.tokens].reverse(),
  }, value.bound, 'FINALIZE_UNDO'));
});

test('terminal record and ACK require exact original authority and cannot cross commands', () => {
  const value = authority();
  invalid(() => schema.undoReceiptSetDigest(value.finalize, value.bound));
  invalid(() => schema.buildUndoFinalRecord(value.finalize, value.bound));
  for (const settle of [value.restore, value.finalize]) {
    const expectedCommand = settle.command;
    const finalRecord = schema.buildUndoFinalRecord(settle, value.bound, expectedCommand);
    const finalRecordIdentity = finalIdentity(value, settle, expectedCommand);
    const ack = schema.buildUndoAckRequest(
      settle,
      finalRecord,
      finalRecordIdentity,
      value.bound,
      expectedCommand
    );
    invalid(() => schema.buildUndoAckRequest(
      settle,
      finalRecord,
      finalRecordIdentity,
      value.bound
    ));
    assert(schema.UNDO_FINAL_BASENAME_RE.test(ack.finalBasename));
    assert.strictEqual(schema.assertUndoAckRequest(
      ack, settle, finalRecord, finalRecordIdentity, value.bound, expectedCommand
    ).finalRecordDigest, finalRecord.finalRecordDigest);
    invalid(() => schema.assertUndoAckRequest({
      ...ack,
      command: settle === value.restore ? 'FINALIZE_UNDO' : 'RESTORE_QUARANTINE',
    }, settle, finalRecord, finalRecordIdentity, value.bound, expectedCommand));
    invalid(() => schema.assertUndoAckRequest(ack, settle, {
      ...finalRecord,
      finalRecordDigest: digest(9),
    }, finalRecordIdentity, value.bound, expectedCommand));
    // Same canonical bytes at a replacement inode cannot authorize ACK.
    invalid(() => schema.assertUndoAckRequest(
      ack,
      settle,
      finalRecord,
      { ...finalRecordIdentity, ino: String(Number(finalRecordIdentity.ino) + 1) },
      value.bound,
      expectedCommand
    ));
  }
});

test('settlement and ACK truth never turn partial or foreign evidence into success', () => {
  const value = authority();
  const finalRecord = schema.buildUndoFinalRecord(
    value.finalize,
    value.bound,
    'FINALIZE_UNDO'
  );
  const finalRecordIdentity = finalIdentity(value, value.finalize, 'FINALIZE_UNDO');
  const committed = {
    schema: schema.SCHEMAS.UNDO_SETTLE_RESULT,
    command: 'FINALIZE_UNDO',
    state: 'COMMITTED',
    operationId,
    finalRecord,
    finalRecordIdentity,
    errorCode: null,
  };
  assert.strictEqual(schema.assertUndoSettleResult(
    committed,
    value.finalize,
    value.bound,
    'FINALIZE_UNDO'
  ).state, 'COMMITTED');
  assert.strictEqual(schema.assertUndoSettleResult({
    ...committed,
    state: 'UNKNOWN',
    finalRecord: null,
    finalRecordIdentity: null,
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, value.finalize, value.bound, 'FINALIZE_UNDO').state, 'UNKNOWN');
  invalid(() => schema.assertUndoSettleResult({
    ...committed,
    state: 'UNCOMMITTED',
  }, value.finalize, value.bound, 'FINALIZE_UNDO'));
  const ack = schema.buildUndoAckRequest(
    value.finalize,
    finalRecord,
    finalRecordIdentity,
    value.bound,
    'FINALIZE_UNDO'
  );
  assert.strictEqual(schema.assertUndoAckResult({
    schema: schema.SCHEMAS.UNDO_ACK_RESULT,
    command: 'FINALIZE_UNDO',
    state: 'UNKNOWN',
    operationId,
    finalRecordDigest: finalRecord.finalRecordDigest,
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, ack, value.finalize, finalRecord, finalRecordIdentity,
  value.bound, 'FINALIZE_UNDO').state, 'UNKNOWN');
});

test('Q/R/B/D/A wires are bounded, command-distinct and path/body/output free', () => {
  const value = authority();
  const q = schema.encodeUndoCommand('QUARANTINE', value.bound);
  const r = schema.encodeUndoCommand('RECONCILE_UNDO', value.bound);
  const b = schema.encodeUndoSettleCommand(value.restore, value.bound, 'RESTORE_QUARANTINE');
  const d = schema.encodeUndoSettleCommand(value.finalize, value.bound, 'FINALIZE_UNDO');
  const finalRecord = schema.buildUndoFinalRecord(
    value.finalize,
    value.bound,
    'FINALIZE_UNDO'
  );
  const finalRecordIdentity = finalIdentity(value, value.finalize, 'FINALIZE_UNDO');
  const ack = schema.buildUndoAckRequest(
    value.finalize,
    finalRecord,
    finalRecordIdentity,
    value.bound,
    'FINALIZE_UNDO'
  );
  const a = schema.encodeUndoAckCommand(
    ack,
    value.finalize,
    finalRecord,
    finalRecordIdentity,
    value.bound,
    'FINALIZE_UNDO'
  );
  assert.deepStrictEqual({
    Q: [Buffer.byteLength(q, 'utf8'), independentWireSha256(q)],
    R: [Buffer.byteLength(r, 'utf8'), independentWireSha256(r)],
    B: [Buffer.byteLength(b, 'utf8'), independentWireSha256(b)],
    D: [Buffer.byteLength(d, 'utf8'), independentWireSha256(d)],
    A: [Buffer.byteLength(a, 'utf8'), independentWireSha256(a)],
  }, {
    Q: [1081, '1610972b6b21fee81149ba9a1044ca21deacc6de59b2924e25d4aeb3c9cad360'],
    R: [1081, '8f9836423e02e5be7efd7e96a2874bba4fc16911dd7435e3b2fd08b56e72dc5f'],
    B: [2605, 'f2d9a7b08f76b59525eecf954839e82e6a1e6ee5a1b32cf0dfd3d45656b3b283'],
    D: [2675, '319f0b1abed507c51f53cd048325dbfd0d62ef89c0520e34be758973ce43ca5b'],
    A: [2978, '91428100e20f4a9c232781b7086a581dc8b36ae2ab063e4b3113591fb7e3eeba'],
  });
  assert(q.startsWith('Q\tUNDO\t'));
  assert(r.startsWith('R\tUNDO\t'));
  assert(b.startsWith('B\tUNDO\t'));
  assert(d.startsWith('D\tUNDO\t'));
  assert(a.startsWith('A\tUNDO\t'));
  for (const wire of [q, r, b, d, a]) {
    assert(!wire.includes('/private/tmp'));
    assert(!wire.includes('chapter-0.md'));
    assert(!wire.includes('markdown body'));
    assert(!wire.includes('outputPath'));
  }
});

test('maximum 300-item authority and every private record remain inside frozen budgets', () => {
  const maximumUnicodePath = index =>
    `${String.fromCodePoint(0x10000 + index)}${'😀'.repeat(1020)}.md`;
  const value = authority(schema.LIMITS.maxItems, maximumUnicodePath);
  assert(value.request.items.every(item =>
    Buffer.byteLength(item.path, 'utf8') === 4087 && Array.from(item.path).length === 1024));
  const q = schema.encodeUndoCommand('QUARANTINE', value.bound);
  const settle = schema.encodeUndoSettleCommand(value.finalize, value.bound, 'FINALIZE_UNDO');
  const finalRecord = schema.buildUndoFinalRecord(
    value.finalize,
    value.bound,
    'FINALIZE_UNDO'
  );
  const finalRecordIdentity = finalIdentity(value, value.finalize, 'FINALIZE_UNDO');
  const ack = schema.buildUndoAckRequest(
    value.finalize,
    finalRecord,
    finalRecordIdentity,
    value.bound,
    'FINALIZE_UNDO'
  );
  const ackWire = schema.encodeUndoAckCommand(
    ack,
    value.finalize,
    finalRecord,
    finalRecordIdentity,
    value.bound,
    'FINALIZE_UNDO'
  );
  const control = schema.buildUndoControl(value.bound, 0);
  const controlWire = schema.encodeUndoControlRecord(control, value.bound, 0);
  assert.deepStrictEqual({
    Q: [Buffer.byteLength(q, 'utf8'), independentWireSha256(q)],
    D: [Buffer.byteLength(settle, 'utf8'), independentWireSha256(settle)],
    A: [Buffer.byteLength(ackWire, 'utf8'), independentWireSha256(ackWire)],
    CONTROL: [Buffer.byteLength(controlWire, 'utf8'), independentWireSha256(controlWire)],
  }, {
    Q: [2523055, '1ba6f55fd4042d9d314cc8363b2d7153fb84df05c09d688d0cdc1bff8c4afcfd'],
    D: [2741540, 'e90e9853e3831b0ef20b878baeaaccb0231f98f8fd63073379df37c9fce2fb21'],
    A: [2741843, '4f8f1ae1929c63d6201cd04285a64dfbe807e152c8e8cb770db9a8a6235d1688'],
    CONTROL: [9086, '7788fa14dd354d7f083c75e7227acbb922c43461776b474a140d07ccab1332c3'],
  });
  assert(Buffer.byteLength(q, 'utf8') < schema.LIMITS.maxRequestBytes);
  assert(Buffer.byteLength(settle, 'utf8') < schema.LIMITS.maxRequestBytes);
  assert(Buffer.byteLength(ackWire, 'utf8') < schema.LIMITS.maxRequestBytes);
  assert.strictEqual(q.split('\n').filter(Boolean).length, schema.LIMITS.maxItems + 1);
  assert(Buffer.byteLength(controlWire, 'utf8') < schema.LIMITS.maxRecordBytes);
  assert(Buffer.byteLength(schema.encodeUndoReceiptRecord(
    value.receipts[0], value.bound, 0
  ), 'utf8') < schema.LIMITS.maxRecordBytes);
  assert(Buffer.byteLength(schema.encodeUndoFinalRecord(
    finalRecord, value.finalize, value.bound, 'FINALIZE_UNDO'
  ), 'utf8') < schema.LIMITS.maxFinalRecordBytes);
  assert.throws(
    () => authority(schema.LIMITS.maxItems + 1, maximumUnicodePath),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/${passed} private Safe Undo schema checks passed`);
