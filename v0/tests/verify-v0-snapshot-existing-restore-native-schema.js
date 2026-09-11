#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const schema = require('../src/main/snapshot-existing-restore-native-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;
const revision = value => String(value).repeat(64);
const operationId = `chr_${'a'.repeat(48)}`;
const uniqueDigest = index => `sha256:${(index + 256).toString(16).padStart(64, '0')}`;

function existingLeafBinding(item, index, before = true) {
  const leafRevision = before
    ? uniqueDigest(index + 1000).slice('sha256:'.length)
    : item.revision;
  const byteLength = (before ? 10 : 20) + index;
  return {
    selectedId: item.selectedId,
    path: item.path,
    revision: leafRevision,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    byteLength,
    contentDigest: `sha256:${leafRevision}`,
  };
}

function existingLeafObservation(binding, index, overrides = {}) {
  return {
    dev: String(1000 + index),
    ino: String(2000 + index),
    uid: 501,
    mode: 0o644,
    nlink: 1,
    size: String(binding.byteLength),
    mtimeNs: String(1700000000000000000n + BigInt(index)),
    ctimeNs: String(1700000001000000000n + BigInt(index)),
    contentSha256: binding.contentDigest,
    ...overrides,
  };
}

function requestLeafBinding(item, state) {
  const before = state === 'before';
  return {
    selectedId: item.selectedId,
    path: item.path,
    revision: before ? item.beforeRevision : item.afterRevision,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    byteLength: before ? item.beforeByteLength : item.afterByteLength,
    contentDigest: before ? item.beforeContentDigest : item.afterContentDigest,
  };
}

function observedLeafDigest(item, state, seed) {
  const binding = requestLeafBinding(item, state);
  const identity = schema.buildExistingLeafIdentity(
    binding,
    existingLeafObservation(binding, seed)
  );
  return schema.digestExistingLeafIdentity(identity, binding);
}

function parent(existingCount = 2) {
  return {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [
      ...Array.from({ length: existingCount }, (_, index) => ({
        selectedId: `existing:${index}`,
        action: 'EXISTING',
        path: `chapter-${index}.md`,
        revision: uniqueDigest(index).slice('sha256:'.length),
        ancestorIdentityDigest: uniqueDigest(index + 500),
      })),
      {
        selectedId: 'missing:0',
        action: 'MISSING',
        path: 'new.md',
        revision: revision('f'),
        ancestorIdentityDigest: digest('f'),
      },
    ],
  };
}

function createdReceiptPhase(authority) {
  const missing = authority.selected.filter(item => item.action === 'MISSING');
  return {
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore',
    phase: 'CREATED_RECEIPT',
    artifactDigest: digest('a'),
    selectionDigest: phaseSchema.digestSelection(authority),
    items: missing.map(item => ({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.revision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: digest('b'),
      creationReceiptDigest: digest('c'),
      quarantineReceiptDigest: null,
    })),
    preparedHistoryDigest: digest('d'),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

function journalBinding() {
  const frame = Buffer.from('WRCCHRJ2\nACTIVE\n', 'utf8');
  return schema.buildExistingJournalBinding({
    schema: schema.SCHEMAS.EXISTING_JOURNAL_BINDING,
    journalBasename: 'changes-history-transaction.json',
    journalMagic: 'WRCCHRJ2',
    journalFileIdentity: {
      schema: evidence.SCHEMAS.OBJECT_IDENTITY,
      dev: '30', ino: '40', uid: 501, mode: 0o600, nlink: 1,
      size: '4096', mtimeNs: '3000000000', ctimeNs: '3000000001',
      contentSha256: evidence.sha256(frame),
    },
    rootIdentityDigest: digest('8'),
    recoveryDirectoryIdentityDigest: digest('e'),
    activeSlot: 'B',
    head: {
      schema: 'writcraft.changes-history-marker-journal-head/v1',
      journalId: `chrj_${'b'.repeat(48)}`,
      generation: '7',
      valueDigest: digest('7'),
    },
    previousValueDigest: digest('6'),
    frameByteLength: 4096,
    frameSha256: evidence.sha256(frame),
    payloadOffset: 128,
    payloadByteLength: 3968,
    payloadSha256: digest('5'),
    activeMarkerOffset: 160,
    activeMarkerByteLength: 64,
    activeMarkerDigest: digest('4'),
    activeMarkerCanonicalSha256: digest('c'),
    bindingDigest: null,
  });
}

function request(authority, phase, overrides = {}) {
  const existing = authority.selected.filter(item => item.action === 'EXISTING');
  const baseHistory = schema.buildBaseHistoryAuthority(Buffer.from('{}\n', 'utf8'));
  const historyParentIdentityDigest = schema.digestHistoryParentIdentity({
    dev: '10', ino: '20', uid: 501, mode: 0o700,
  });
  return {
    schema: schema.SCHEMAS.REQUEST,
    operationId,
    markerDigest: digest('1'),
    artifactDigest: phase.artifactDigest,
    artifactIdentityDigest: digest('2'),
    artifactByteLength: 8 * 1024 * 1024,
    createdReceiptPhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, phase),
    selectionDigest: phase.selectionDigest,
    ...baseHistory,
    historyParentIdentityDigest,
    journalMarkerBinding: journalBinding(),
    items: existing.map((item, index) => {
      const beforeBinding = existingLeafBinding(item, index, true);
      const beforeIdentity = schema.buildExistingLeafIdentity(
        beforeBinding,
        existingLeafObservation(beforeBinding, index)
      );
      return {
        selectedId: item.selectedId,
        path: item.path,
        beforeRevision: beforeBinding.revision,
        afterRevision: item.revision,
        beforeArtifactOffset: index * 2048,
        beforeByteLength: beforeBinding.byteLength,
        beforeContentDigest: beforeBinding.contentDigest,
        afterArtifactOffset: 512 * 1024 + index * 2048,
        afterByteLength: 20 + index,
        afterContentDigest: `sha256:${item.revision}`,
        ancestorIdentityDigest: item.ancestorIdentityDigest,
        beforeLeafIdentityDigest: schema.digestExistingLeafIdentity(
          beforeIdentity,
          beforeBinding
        ),
      };
    }),
    ...overrides,
  };
}

function markerAuthority(nativeRequest) {
  return {
    schema: schema.SCHEMAS.MARKER_AUTHORITY,
    operationId: nativeRequest.operationId,
    markerDigest: nativeRequest.markerDigest,
    artifactDigest: nativeRequest.artifactDigest,
    artifactIdentityDigest: nativeRequest.artifactIdentityDigest,
    artifactByteLength: nativeRequest.artifactByteLength,
    baseHistoryDigest: nativeRequest.baseHistoryDigest,
    baseHistoryByteLength: nativeRequest.baseHistoryByteLength,
    baseHistoryExists: nativeRequest.baseHistoryExists,
    baseHistoryContentDigest: nativeRequest.baseHistoryContentDigest,
    historyParentIdentityDigest: nativeRequest.historyParentIdentityDigest,
  };
}

function authority(existingCount = 2) {
  const selection = parent(existingCount);
  const phase = createdReceiptPhase(selection);
  const nativeRequest = request(selection, phase);
  const marker = markerAuthority(nativeRequest);
  const bound = schema.buildAuthority(marker, selection, phase, nativeRequest);
  const applies = nativeRequest.items.map((_item, index) => schema.buildApplyReceipt(
    bound,
    index,
    observedLeafDigest(nativeRequest.items[index], 'after', index + 3000)
  ));
  const controlIdentities = nativeRequest.items.map((_item, index) => identityForWire(
    schema.encodeControlRecord(schema.buildControl(bound, index), bound, index),
    index * 10 + 1
  ));
  const applyTokens = applies.map((apply, index) => schema.buildApplyToken(
    bound,
    index,
    apply,
    controlIdentities[index],
    identityForWire(schema.encodeApplyReceiptRecord(apply, bound, index), index * 10 + 2)
  ));
  const committed = schema.buildTerminalReceipt(bound, 'COMMITTED', applyTokens);
  const rollbackTokens = nativeRequest.items.map((_item, index) => {
    const applyToken = index === 0 ? applyTokens[index] : null;
    const applyReceipt = index === 0 ? applies[index] : null;
    const rollbackReceipt = schema.buildRollbackReceipt(
      bound,
      index,
      observedLeafDigest(nativeRequest.items[index], 'before', index + 4000),
      applyReceipt
    );
    return schema.buildRollbackToken(
      bound,
      index,
      rollbackReceipt,
      controlIdentities[index],
      identityForWire(
        schema.encodeRollbackReceiptRecord(rollbackReceipt, bound, index, applyReceipt),
        index * 10 + 3
      ),
      applyToken
    );
  });
  const uncommitted = schema.buildTerminalReceipt(bound, 'UNCOMMITTED', rollbackTokens);
  return {
    marker,
    selection,
    phase,
    nativeRequest,
    bound,
    applies,
    applyTokens,
    committed,
    rollbackTokens,
    uncommitted,
  };
}

function identityForWire(wire, seed = 1) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(10 + seed),
    ino: String(100 + seed),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(Buffer.byteLength(wire, 'utf8')),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: evidence.sha256(Buffer.from(wire, 'utf8')),
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'SNAPSHOT_EXISTING_RESTORE_NATIVE_PROTOCOL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nSnapshot existing-restore native schema verification');

test('module exposes the frozen five-method E/R/V/F lifecycle', () => {
  assert.deepStrictEqual(schema.METHODS, [
    'execute', 'reconcile', 'verify', 'finalize', 'reconcileFinalize',
  ]);
  assert.deepStrictEqual(schema.COMMANDS, {
    EXECUTE: 'E', RECONCILE: 'R', VERIFY: 'V', FINALIZE: 'F',
  });
});

test('EXISTING journal binding has an exact descriptor schema and digest', () => {
  assert.strictEqual(
    schema.SCHEMAS.EXISTING_JOURNAL_BINDING,
    'writcraft.public-markdown-existing-journal-binding/v1'
  );
  assert.strictEqual(typeof schema.buildExistingJournalBinding, 'function');
  assert.strictEqual(typeof schema.digestExistingJournalBinding, 'function');
});

test('base History authority freezes present/absent existence-prefixed digests', () => {
  const raw = Buffer.from('{}\n', 'utf8');
  const present = schema.buildBaseHistoryAuthority(raw, true);
  assert.deepStrictEqual(present, {
    baseHistoryExists: true,
    baseHistoryContentDigest: evidence.sha256(raw),
    baseHistoryDigest: evidence.sha256(Buffer.concat([Buffer.from([0x01]), raw])),
    baseHistoryByteLength: raw.length,
  });
  assert.strictEqual(present.baseHistoryContentDigest, 'sha256:ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356');
  assert.strictEqual(present.baseHistoryDigest, 'sha256:e895629867c357f19053f7f069e020b71b1bb31c778a78d709d59f1eab17ec5a');
  const absent = schema.buildBaseHistoryAuthority(Buffer.alloc(0), false);
  assert.deepStrictEqual(absent, {
    baseHistoryExists: false,
    baseHistoryContentDigest: null,
    baseHistoryDigest: evidence.sha256(Buffer.from([0x00])),
    baseHistoryByteLength: 0,
  });
  assert.strictEqual(absent.baseHistoryDigest, 'sha256:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
  invalid(() => schema.buildBaseHistoryAuthority(Buffer.from('x'), false));
  invalid(() => schema.buildBaseHistoryAuthority(Buffer.alloc(0), true));
  const value = authority();
  invalid(() => schema.assertMarkerAuthority({
    ...value.marker,
    baseHistoryContentDigest: digest('foreign'),
  }));
  invalid(() => schema.assertMarkerAuthority({
    ...value.marker,
    baseHistoryExists: false,
  }));
  invalid(() => schema.assertRequest({
    ...value.nativeRequest,
    baseHistoryContentDigest: null,
  }, value.marker, value.selection, value.phase));
});

test('public existing leaf identity has one canonical domain and hardcoded Unicode golden', () => {
  assert.strictEqual(
    schema.SCHEMAS.PUBLIC_EXISTING_LEAF_IDENTITY,
    'writcraft.public-markdown-existing-leaf-identity/v1'
  );
  const binding = {
    selectedId: 'existing:unicode',
    path: '章节/证据😀.md',
    revision: 'a'.repeat(64),
    ancestorIdentityDigest: `sha256:${'b'.repeat(64)}`,
    byteLength: 12,
    contentDigest: `sha256:${'a'.repeat(64)}`,
  };
  const observation = {
    dev: '18446744073709551615',
    ino: '42',
    uid: 501,
    mode: 0o644,
    nlink: 1,
    size: '12',
    mtimeNs: '1700000000000000000',
    ctimeNs: '1700000001000000000',
    contentSha256: binding.contentDigest,
  };
  const identity = schema.buildExistingLeafIdentity(binding, observation);
  const preimage = 'writcraft-digest/v1\0writcraft.public-markdown-existing-leaf-identity/v1\0' +
    '{"ancestorIdentityDigest":"sha256:' + 'b'.repeat(64) + '",' +
    '"contentSha256":"sha256:' + 'a'.repeat(64) + '",' +
    '"ctimeNs":"1700000001000000000","dev":"18446744073709551615",' +
    '"ino":"42","mode":420,"mtimeNs":"1700000000000000000","nlink":1,' +
    '"path":"章节/证据😀.md","revision":"' + 'a'.repeat(64) + '",' +
    '"schema":"writcraft.public-markdown-existing-leaf-identity/v1",' +
    '"selectedId":"existing:unicode","size":"12","uid":501}';
  assert.strictEqual(evidence.digestPreimage(
    schema.SCHEMAS.PUBLIC_EXISTING_LEAF_IDENTITY,
    identity
  ).toString('utf8'), preimage);
  assert.strictEqual(
    crypto.createHash('sha256').update(Buffer.from(preimage, 'utf8')).digest('hex'),
    'f240dd20e9d0c3a114cdb7922fc2c66fbb4320fb7551a63b2ce2c1136387e84b'
  );
  assert.strictEqual(
    schema.digestExistingLeafIdentity(identity, binding),
    'sha256:f240dd20e9d0c3a114cdb7922fc2c66fbb4320fb7551a63b2ce2c1136387e84b'
  );
});

test('public existing leaf identity binds fd observation, path, revision and ancestor exactly', () => {
  const item = parent(1).selected[0];
  const binding = existingLeafBinding(item, 0, true);
  const observation = existingLeafObservation(binding, 0);
  const identity = schema.buildExistingLeafIdentity(binding, observation);
  const original = schema.digestExistingLeafIdentity(identity, binding);
  const replacement = schema.buildExistingLeafIdentity(binding, {
    ...observation,
    ino: '9999',
  });
  assert.notStrictEqual(schema.digestExistingLeafIdentity(replacement, binding), original);
  const sameInodeRewriteBinding = {
    ...binding,
    revision: '9'.repeat(64),
    contentDigest: `sha256:${'9'.repeat(64)}`,
  };
  const sameInodeRewrite = schema.buildExistingLeafIdentity(sameInodeRewriteBinding, {
    ...observation,
    contentSha256: sameInodeRewriteBinding.contentDigest,
    mtimeNs: '1700000000000000999',
    ctimeNs: '1700000001000000999',
  });
  assert.notStrictEqual(
    schema.digestExistingLeafIdentity(sameInodeRewrite, sameInodeRewriteBinding),
    original
  );
  for (const drift of [
    { ...binding, path: 'foreign.md' },
    { ...binding, revision: '8'.repeat(64), contentDigest: `sha256:${'8'.repeat(64)}` },
    { ...binding, ancestorIdentityDigest: digest('8') },
  ]) invalid(() => schema.assertExistingLeafIdentity(identity, drift));
  invalid(() => schema.buildExistingLeafIdentity(binding, { ...observation, nlink: 2 }));
  invalid(() => schema.buildExistingLeafIdentity(binding, { ...observation, dev: '01' }));
  invalid(() => schema.buildExistingLeafIdentity(binding, { ...observation, dev: 1n }));
  invalid(() => schema.buildExistingLeafIdentity(binding, {
    ...observation,
    ino: '18446744073709551616',
  }));
  invalid(() => schema.buildExistingLeafIdentity(binding, {
    ...observation,
    ino: '1'.repeat(1024),
  }));
  invalid(() => schema.buildExistingLeafIdentity(binding, { ...observation, size: '11' }));
  invalid(() => schema.buildExistingLeafIdentity({ ...binding, path: 'cafe\u0301.md' }, observation));
  invalid(() => schema.buildExistingLeafIdentity({ ...binding, path: 'bad\ud800.md' }, observation));
});

test('public existing leaf identity rejects extra/accessor inputs without invoking getters', () => {
  const item = parent(1).selected[0];
  const binding = existingLeafBinding(item, 0, true);
  const observation = existingLeafObservation(binding, 0);
  const identity = schema.buildExistingLeafIdentity(binding, observation);
  let getters = 0;
  for (const [target, invoke] of [
    [{ ...binding }, hostile => schema.buildExistingLeafIdentity(hostile, observation)],
    [{ ...observation }, hostile => schema.buildExistingLeafIdentity(binding, hostile)],
    [{ ...identity }, hostile => schema.assertExistingLeafIdentity(hostile, binding)],
  ]) {
    const key = Object.keys(target)[0];
    Object.defineProperty(target, key, {
      enumerable: true,
      get() { getters += 1; return 'hostile'; },
    });
    invalid(() => invoke(target));
  }
  invalid(() => schema.buildExistingLeafIdentity({ ...binding, extra: true }, observation));
  invalid(() => schema.buildExistingLeafIdentity(binding, { ...observation, extra: true }));
  invalid(() => schema.assertExistingLeafIdentity({ ...identity, extra: true }, binding));
  const hidden = { ...identity };
  Object.defineProperty(hidden, 'foreign', { enumerable: false, value: true });
  invalid(() => schema.assertExistingLeafIdentity(hidden, binding));
  invalid(() => schema.assertExistingLeafIdentity({
    ...identity,
    [Symbol('foreign')]: true,
  }, binding));
  assert.strictEqual(getters, 0);
});

test('request binds the same marker, artifact, CREATED_RECEIPT and exact History base', () => {
  const value = authority();
  assert.strictEqual(schema.assertAuthority(value.bound).request.items.length, 2);
  const reject = (
    nativeRequest = value.nativeRequest,
    marker = value.marker,
    selection = value.selection,
    phase = value.phase
  ) => invalid(() => schema.assertRequest(nativeRequest, marker, selection, phase));
  reject({ ...value.nativeRequest, markerDigest: digest('9') });
  reject({ ...value.nativeRequest, artifactDigest: digest('9') });
  reject({ ...value.nativeRequest, artifactIdentityDigest: digest('9') });
  reject({ ...value.nativeRequest, artifactByteLength: value.nativeRequest.artifactByteLength + 1 });
  reject({ ...value.nativeRequest, createdReceiptPhaseDigest: digest('9') });
  reject({ ...value.nativeRequest, selectionDigest: digest('9') });
  reject({ ...value.nativeRequest, baseHistoryDigest: digest('9') });
  reject({ ...value.nativeRequest, baseHistoryByteLength: 4097 });
  reject(value.nativeRequest, value.marker, value.selection, {
    ...value.phase,
    updatedAt: '2026-08-09T00:00:01.000Z',
  });
  reject(value.nativeRequest, value.marker, {
    ...value.selection,
    selected: [...value.selection.selected].reverse(),
  }, value.phase);
});

test('request derives the complete ordered EXISTING subset and exact before/after bytes', () => {
  const value = authority();
  invalid(() => schema.assertRequest(
    { ...value.nativeRequest, items: value.nativeRequest.items.slice(1) },
    value.marker,
    value.selection,
    value.phase
  ));
  invalid(() => schema.assertRequest(
    { ...value.nativeRequest, items: [...value.nativeRequest.items].reverse() },
    value.marker,
    value.selection,
    value.phase
  ));
  invalid(() => schema.assertRequest({
    ...value.nativeRequest,
    items: value.nativeRequest.items.map((item, index) => index
      ? item
      : { ...item, afterContentDigest: digest('9') }),
  }, value.marker, value.selection, value.phase));
  invalid(() => schema.assertRequest({
    ...value.nativeRequest,
    items: value.nativeRequest.items.map((item, index) => index
      ? item
      : { ...item, beforeLeafIdentityDigest: value.nativeRequest.items[1].beforeLeafIdentityDigest }),
  }, value.marker, value.selection, value.phase));
});

test('control/apply receipts bind one item and deterministic record names', () => {
  const value = authority();
  const control = schema.buildControl(value.bound, 0);
  const names = schema.recordNames(value.bound, 0);
  assert.deepStrictEqual(schema.assertControl(control, value.bound, 0), control);
  assert.deepStrictEqual(
    schema.assertApplyReceipt(value.applies[0], value.bound, 0),
    value.applies[0]
  );
  assert.deepStrictEqual(Object.keys(names).sort(), [
    'afterStageBasename', 'applyReceiptBasename', 'beforeQuarantineBasename',
    'controlBasename', 'rollbackReceiptBasename',
  ]);
  assert.match(names.controlBasename,
    /^\.changes-history-native-existing-control\.[a-f0-9]{64}$/u);
  assert.match(names.beforeQuarantineBasename,
    /^\.changes-history-native-existing-before\.[a-f0-9]{64}$/u);
  assert.match(names.afterStageBasename,
    /^\.changes-history-native-existing-stage\.[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(names));
  assert.notStrictEqual(names.beforeQuarantineBasename, names.afterStageBasename);
  assert.notStrictEqual(names.beforeQuarantineBasename,
    schema.recordNames(value.bound, 1).beforeQuarantineBasename);
  const allNames = value.bound.request.items.flatMap((_item, index) =>
    Object.values(schema.recordNames(value.bound, index)));
  assert.strictEqual(new Set(allNames).size, allNames.length,
    'all five locator names must be globally unique across two items');
  for (const [index, itemNames] of value.bound.request.items.map((_item, index) =>
    schema.recordNames(value.bound, index)).entries()) {
    const suffixes = Object.values(itemNames).map(name => name.slice(name.lastIndexOf('.') + 1));
    assert.ok(suffixes.every(suffix => suffix === suffixes[0]),
      `locator suffix mismatch at item ${index}`);
  }
  invalid(() => schema.assertApplyReceipt(value.applies[0], value.bound, 1));
  invalid(() => schema.assertControl({ ...control, controlDigest: digest('9') }, value.bound, 0));
});

test('COMMITTED requires all per-item apply receipts and one aggregate receipt', () => {
  const value = authority();
  assert.strictEqual(
    schema.assertTerminalReceipt(value.committed, value.bound).state,
    'COMMITTED'
  );
  assert.ok(value.committed.items.every(item =>
    item.applyToken !== null && item.rollbackToken === null));
  invalid(() => schema.buildTerminalReceipt(
    value.bound,
    'COMMITTED',
    value.applyTokens.slice(1)
  ));
  invalid(() => schema.assertTerminalReceipt({
    ...value.committed,
    items: [...value.committed.items].reverse(),
  }, value.bound));
});

test('formal UNCOMMITTED binds partial apply plus complete durable self-rollback', () => {
  const value = authority();
  const terminal = schema.assertTerminalReceipt(value.uncommitted, value.bound);
  assert.strictEqual(terminal.state, 'UNCOMMITTED');
  assert.notStrictEqual(terminal.items[0].applyToken, null);
  assert.strictEqual(terminal.items[1].applyToken, null);
  assert.ok(terminal.items.every(item => item.rollbackToken !== null));
  const foreign = value.rollbackTokens.map((token, index) => index
    ? token
    : { ...token, rollbackReceiptDigest: digest('9') });
  invalid(() => schema.buildTerminalReceipt(value.bound, 'UNCOMMITTED', foreign));
});

test('UNCOMMITTED rejects cross-publication apply authority even with recomputed self digests', () => {
  const value = authority();
  const original = value.uncommitted.items[0];
  const crossPublicationApply = {
    ...original.applyToken,
    controlRecordIdentity: {
      ...original.applyToken.controlRecordIdentity,
      dev: '9001',
      ino: '9002',
      mtimeNs: '9003',
      ctimeNs: '9004',
    },
    receiptRecordIdentity: {
      ...original.applyToken.receiptRecordIdentity,
      dev: '9011',
      ino: '9012',
      mtimeNs: '9013',
      ctimeNs: '9014',
    },
  };
  const items = [
    { ...original, applyToken: crossPublicationApply },
    ...value.uncommitted.items.slice(1),
  ];
  const receiptSetDigest = evidence.digestObject(schema.SCHEMAS.TERMINAL_RECEIPT, {
    schema: schema.SCHEMAS.TERMINAL_RECEIPT,
    operationId,
    requestDigest: schema.requestDigest(value.bound),
    state: 'UNCOMMITTED',
    items,
  });
  const base = {
    ...value.uncommitted,
    items,
    receiptSetDigest,
  };
  delete base.terminalReceiptDigest;
  const forged = {
    ...base,
    terminalReceiptDigest: evidence.digestObject(schema.SCHEMAS.TERMINAL_RECEIPT, base),
  };
  invalid(() => schema.assertTerminalReceipt(forged, value.bound));
});

test('UNKNOWN is path-free, carries no terminal receipt and never masquerades as uncommitted', () => {
  const value = authority();
  const unknown = schema.buildRunResult(value.bound, 'R', 'UNKNOWN');
  assert.strictEqual(unknown.terminalReceipt, null);
  assert.strictEqual(unknown.errorCode, schema.ERROR_CODES.UNKNOWN);
  invalid(() => schema.assertRunResult({ ...unknown, errorCode: 'ENOENT /private/tmp/book.md' },
    value.bound, 'R'));
  invalid(() => schema.buildRunResult(value.bound, 'R', 'UNKNOWN', value.uncommitted));
  invalid(() => schema.buildRunResult(value.bound, 'E', 'UNCOMMITTED', value.committed));
});

test('E/R results are command-bound and reject cross-command or partial foreign truth', () => {
  const value = authority();
  const execute = schema.buildRunResult(value.bound, 'E', 'COMMITTED', value.committed);
  const reconcile = schema.buildRunResult(value.bound, 'R', 'UNCOMMITTED', value.uncommitted);
  schema.assertRunResult(execute, value.bound, 'E');
  schema.assertRunResult(reconcile, value.bound, 'R');
  invalid(() => schema.assertRunResult(execute, value.bound, 'R'));
  invalid(() => schema.assertRunResult({ ...reconcile, terminalReceipt: {
    ...reconcile.terminalReceipt,
    receiptSetDigest: digest('9'),
  } }, value.bound, 'R'));
});

test('E COMMITTED response wire round-trips complete tokens and rejects hostile authority', () => {
  const value = authority();
  const committed = schema.buildRunResult(value.bound, 'E', 'COMMITTED', value.committed);
  const wire = schema.encodeRunResponse(committed, value.bound, 'E');
  assert.deepStrictEqual(schema.parseRunResponse(wire, value.bound, 'E'), committed);
  const unknown = schema.buildRunResult(value.bound, 'E', 'UNKNOWN');
  assert.deepStrictEqual(
    schema.parseRunResponse(schema.encodeRunResponse(unknown, value.bound, 'E'), value.bound, 'E'),
    unknown
  );
  const lines = wire.trimEnd().split('\n');
  for (const mutate of [
    rows => { rows[1] = rows[1].replace('\tCOMMITTED\t', '\tUNKNOWN\t'); },
    rows => { rows[1] = rows[1].replace(value.committed.terminalReceiptDigest, digest('9')); },
    rows => { rows[2] = rows[2].replace(value.applyTokens[0].controlDigest, digest('8')); },
    rows => { rows.push(rows[2]); },
    rows => { rows[2] += '\textra'; },
  ]) {
    const hostile = [...lines];
    mutate(hostile);
    invalid(() => schema.parseRunResponse(`${hostile.join('\n')}\n`, value.bound, 'E'));
  }
  invalid(() => schema.parseRunResponse(wire, value.bound, 'R'));
});

test('E response identity wire rejects non-canonical uid/mode/nlink decimals', () => {
  const value = authority();
  const committed = schema.buildRunResult(value.bound, 'E', 'COMMITTED', value.committed);
  const wire = schema.encodeRunResponse(committed, value.bound, 'E');
  const cases = [
    [12, '0501'],
    [12, '+501'],
    [12, '5e2'],
    [13, '0384'],
    [13, ' 384'],
    [14, '01'],
  ];
  for (const [field, hostileValue] of cases) {
    const rows = wire.trimEnd().split('\n');
    const item = rows[2].split('\t');
    item[field] = hostileValue;
    rows[2] = item.join('\t');
    invalid(() => schema.parseRunResponse(`${rows.join('\n')}\n`, value.bound, 'E'));
  }
});

test('V fresh terminal verification is exact and UNKNOWN stays locked', () => {
  const value = authority();
  const verify = schema.buildVerifyRequest(value.bound, value.committed);
  schema.assertVerifyRequest(verify, value.bound);
  schema.assertVerifyResult(
    schema.buildVerifyResult(value.bound, 'COMMITTED', value.committed),
    value.bound,
    value.committed
  );
  schema.assertVerifyResult(
    schema.buildVerifyResult(value.bound, 'UNKNOWN'),
    value.bound
  );
  invalid(() => schema.assertVerifyResult(
    { ...schema.buildVerifyResult(value.bound, 'COMMITTED', value.committed), command: 'R' },
    value.bound,
    value.committed
  ));
});

test('F final record and ACK result bind full terminal authority and identity', () => {
  const value = authority();
  const finalize = schema.buildFinalizeRequest(value.bound, value.committed);
  const record = schema.buildFinalRecord(finalize, value.bound);
  const recordIdentity = identityForWire(
    schema.encodeFinalRecord(record, finalize, value.bound),
    9
  );
  const result = schema.buildFinalResult(
    value.bound,
    finalize,
    'COMMITTED',
    record,
    recordIdentity
  );
  schema.assertFinalResult(result, value.bound, finalize);
  schema.assertAckResult(schema.buildAckResult(value.bound, finalize, 'ACKED'), value.bound, finalize);
  invalid(() => schema.assertAckResult({
    ...schema.buildAckResult(value.bound, finalize, 'ACKED'),
    errorCode: schema.ERROR_CODES.UNKNOWN,
  }, value.bound, finalize));
  // P1-5: an EXISTING ACK may only follow a durable ACK_PREPARED publication,
  // because that publication is the only proof of the exact control/apply/final
  // removals. The item-less FINALIZED-only ACK surface is retired rather than
  // merely unused, so no encoder, request validator or parser may exist for it,
  // and anything that is not a publication fails closed.
  for (const retired of [
    'buildAckRequest', 'assertAckRequest', 'encodeAckCommand', 'parseAckResponse',
  ]) {
    assert.strictEqual(schema[retired], undefined, `${retired} must stay retired`);
  }
  for (const notAPublication of [null, Object.freeze({}), finalize]) {
    assert.throws(
      () => schema.encodeAckPublicationCommand(notAPublication, digest('8')),
      error => error?.code === 'INVALID_CHANGES_HISTORY_MARKER_JOURNAL'
    );
  }
});

test('final record names and canonical authority are deterministic', () => {
  const value = authority();
  const finalize = schema.buildFinalizeRequest(value.bound, value.committed);
  assert.strictEqual(
    schema.requestDigest(value.bound),
    'sha256:fd09f997d329146c990cf9358c682d4a9a80dd91a3ee62b0bb8661e3287d65f9'
  );
  assert.strictEqual(
    schema.recordNames(value.bound, 0).controlBasename,
    '.changes-history-native-existing-control.e0f6a3ba8bab48a81c39477e24faaae0678e9d7855d271247ced60f1a64d55c2'
  );
  assert.strictEqual(
    schema.recordNames(value.bound, 0).beforeQuarantineBasename,
    '.changes-history-native-existing-before.e0f6a3ba8bab48a81c39477e24faaae0678e9d7855d271247ced60f1a64d55c2'
  );
  assert.strictEqual(
    schema.recordNames(value.bound, 0).afterStageBasename,
    '.changes-history-native-existing-stage.e0f6a3ba8bab48a81c39477e24faaae0678e9d7855d271247ced60f1a64d55c2'
  );
  assert.strictEqual(
    schema.buildControl(value.bound, 0).controlDigest,
    'sha256:f17125a3269e468e0f299c34c8a952c64299dd38096c487b2cb6adc2e95ec99b'
  );
  assert.strictEqual(
    value.applies[0].receiptDigest,
    'sha256:9b9660e33e14afc9efaba825965fc21db6163fc614fd4c25c0c42976979e0bf8'
  );
  assert.strictEqual(
    value.committed.receiptSetDigest,
    'sha256:6383c82bdffac69ec99a6ef8e03c1bc4fc7ca328e99d1afc2e5764e94af21992'
  );
  assert.strictEqual(
    value.committed.terminalReceiptDigest,
    'sha256:f3b34b4c1218d380d0fe1e9d266415912e58a5c0db293b853bf5a8e4e375a75e'
  );
  assert.strictEqual(
    schema.finalRecordName(finalize, value.bound),
    '.changes-history-native-existing-final.01fcf68daf7790170ddf164d07882f7e33c8d59b68aaf946ab296a88cfa45156'
  );
  assert.strictEqual(
    schema.buildFinalRecord(finalize, value.bound).finalRecordDigest,
    'sha256:dee274b2fcec60ab39f46922801a79422e8069d89018eba59e5bf64eb516c581'
  );
});

test('wire commands are bounded, command-tagged and never carry a decoded path/body', () => {
  const value = authority();
  const executeWire = schema.encodeExecuteCommand(value.bound);
  const reconcileIdentities = value.applyTokens.map(token => ({
    controlRecordIdentity: token.controlRecordIdentity,
    applyRecordIdentity: token.receiptRecordIdentity,
  }));
  const reconcileWire = schema.encodeReconcileCommand(
    value.bound,
    reconcileIdentities,
    value.committed.markerDigest,
    schema.requestDigest(value.bound)
  );
  const wires = [
    executeWire,
    reconcileWire,
    schema.encodeVerifyCommand(value.bound, value.committed),
    schema.encodeFinalizeCommand(value.bound, value.committed),
  ];
  assert.deepStrictEqual(wires.map(wire => wire[0]), ['E', 'R', 'V', 'F']);
  const executeLines = executeWire.split('\n').filter(Boolean);
  const reconcileLines = reconcileWire.split('\n').filter(Boolean);
  assert.strictEqual(reconcileLines[0], `R${executeLines[0].slice(1)}`,
    'R must carry the complete original E authority header');
  assert.strictEqual(reconcileLines.length, executeLines.length,
    'R must carry the same ordered item line count');
  for (let index = 1; index < executeLines.length; index += 1) {
    const executeItem = executeLines[index].split('\t');
    const reconcileItem = reconcileLines[index].split('\t');
    assert.deepStrictEqual(reconcileItem.slice(0, 13), executeItem,
      'R item must carry the complete original E item fields');
    assert.strictEqual(reconcileItem.length, 34,
      'R item must append the stored control/apply publication identities and marker digest');
    const token = value.applyTokens[index - 1];
    assert.strictEqual(
      reconcileItem[13],
      evidence.assertObjectIdentity(token.controlRecordIdentity).schema
    );
    assert.strictEqual(
      reconcileItem[23],
      evidence.assertObjectIdentity(token.receiptRecordIdentity).schema
    );
    assert.strictEqual(reconcileItem[33], value.committed.markerDigest,
      'R item must carry the E-time publication marker digest');
  }
  const bindingValue = value.bound.request.journalMarkerBinding;
  const header = executeWire.split('\n', 1)[0];
  const request = value.bound.request;
  assert.deepStrictEqual(header.split('\t'), [
    'E', request.operationId, schema.requestDigest(value.bound), bindingValue.bindingDigest,
    bindingValue.journalBasename, bindingValue.journalMagic, bindingValue.activeSlot,
    bindingValue.head.journalId, bindingValue.head.generation,
    bindingValue.previousValueDigest, bindingValue.head.valueDigest,
    String(bindingValue.frameByteLength), bindingValue.frameSha256,
    String(bindingValue.payloadOffset), String(bindingValue.payloadByteLength),
    bindingValue.payloadSha256, String(bindingValue.activeMarkerOffset),
    String(bindingValue.activeMarkerByteLength), bindingValue.activeMarkerDigest,
    bindingValue.activeMarkerCanonicalSha256, bindingValue.rootIdentityDigest,
    bindingValue.recoveryDirectoryIdentityDigest,
    // Held-descriptor authorities the native helper verifies against its fds.
    request.artifactDigest, request.artifactIdentityDigest, String(request.artifactByteLength),
    request.createdReceiptPhaseDigest, request.selectionDigest,
    request.baseHistoryDigest, String(request.baseHistoryByteLength),
    request.baseHistoryExists ? '1' : '0',
    request.baseHistoryExists ? request.baseHistoryContentDigest : '-',
    request.historyParentIdentityDigest,
    String(request.items.length),
  ]);
  assert.ok(Buffer.byteLength(`${header}\n`, 'ascii') <=
    schema.LIMITS.maxJournalBindingHeaderBytes);
  assert.strictEqual(
    evidence.sha256(Buffer.from(executeWire, 'ascii')),
    'sha256:c183196d43b220506f0c37adf9257f4487c107507996a1406d885470c9edf08a'
  );
  assert.strictEqual(
    reconcileWire.split('\n').filter(Boolean).length,
    value.bound.request.items.length + 1
  );
  for (const wire of wires) {
    assert.ok(Buffer.byteLength(wire) <= schema.LIMITS.maxRequestBytes);
    assert.ok(!wire.includes('chapter-0.md'));
    assert.ok(!wire.includes('/private/tmp'));
  }
  assert.strictEqual(schema.assertResponseEnvelope('R\tUNKNOWN\n'), 'R\tUNKNOWN\n');
  invalid(() => schema.assertResponseEnvelope('R\tUNKNOWN\n', 'foreign path'));
  invalid(() => schema.assertResponseEnvelope(`R\t${'x'.repeat(schema.LIMITS.maxLineBytes)}\n`));
  invalid(() => schema.assertResponseEnvelope('R\tUNKNOWN\u0000\n'));
  invalid(() => schema.assertResponseEnvelope('R\t未知\n'));
  invalid(() => schema.encodeReconcileCommand({
    ...value.bound,
    request: {
      ...value.bound.request,
      items: [...value.bound.request.items].reverse(),
    },
  }, reconcileIdentities, value.committed.markerDigest, schema.requestDigest(value.bound)));
  invalid(() => schema.encodeReconcileCommand({
    ...value.bound,
    request: {
      ...value.bound.request,
      items: value.bound.request.items.map((item, index) => index
        ? item
        : { ...item, ancestorIdentityDigest: digest('foreign') }),
    },
  }, reconcileIdentities, value.committed.markerDigest, schema.requestDigest(value.bound)));
  invalid(() => schema.encodeReconcileCommand(
    value.bound, null, value.committed.markerDigest, schema.requestDigest(value.bound)
  ));
  invalid(() => schema.encodeReconcileCommand(
    value.bound, [], value.committed.markerDigest, schema.requestDigest(value.bound)
  ));
  invalid(() => schema.encodeReconcileCommand(
    value.bound,
    reconcileIdentities.map(identity => ({ ...identity, controlRecordIdentity: null })),
    value.committed.markerDigest,
    schema.requestDigest(value.bound)
  ));
  invalid(() => schema.encodeReconcileCommand(
    value.bound, reconcileIdentities, 'not-a-digest', schema.requestDigest(value.bound)
  ));
  invalid(() => schema.encodeReconcileCommand(
    value.bound, reconcileIdentities, value.committed.markerDigest, 'not-a-digest'
  ));
});

test('canonical production bundle binds names, control/apply wires and terminal digests', () => {
  const value = authority();
  const bundle = schema.buildCanonicalBundle(value.bound, value.committed);
  assert.strictEqual(bundle.requestDigest, schema.requestDigest(value.bound));
  assert.strictEqual(bundle.terminalState, 'COMMITTED');
  assert.strictEqual(bundle.terminalReceiptDigest, value.committed.terminalReceiptDigest);
  assert.strictEqual(bundle.receiptSetDigest, value.committed.receiptSetDigest);
  assert.strictEqual(bundle.records.length, value.bound.request.items.length);
  for (const [index, record] of bundle.records.entries()) {
    assert.deepStrictEqual(record.names, schema.recordNames(value.bound, index));
    assert.deepStrictEqual(record.control, schema.buildControl(value.bound, index));
    assert.strictEqual(
      record.controlRecord,
      schema.encodeControlRecord(record.control, value.bound, index)
    );
    assert.ok(record.applyReceipt);
    assert.strictEqual(
      record.applyRecord,
      schema.encodeApplyReceiptRecord(record.applyReceipt, value.bound, index)
    );
  }
});

test('records, items and arrays reject accessors/hidden/Symbol/sparse with getter zero', () => {
  const value = authority();
  let getters = 0;
  for (const { kind, target } of [
    { kind: 'request', target: { ...value.nativeRequest } },
    { kind: 'requestItem', target: { ...value.nativeRequest.items[0] } },
    { kind: 'terminal', target: { ...value.committed } },
    { kind: 'terminalItem', target: { ...value.committed.items[0] } },
  ]) {
    const key = Object.keys(target)[0];
    Object.defineProperty(target, key, {
      enumerable: true,
      get() { getters += 1; return 'hostile'; },
    });
    if (kind === 'request') {
      invalid(() => schema.assertRequest(target, value.marker, value.selection, value.phase));
    } else if (kind === 'requestItem') {
      const items = [target, ...value.nativeRequest.items.slice(1)];
      invalid(() => schema.assertRequest(
        { ...value.nativeRequest, items },
        value.marker,
        value.selection,
        value.phase
      ));
    } else if (kind === 'terminal') {
      invalid(() => schema.assertTerminalReceipt(target, value.bound));
    } else {
      invalid(() => schema.assertTerminalReceipt({
        ...value.committed,
        items: [target, ...value.committed.items.slice(1)],
      }, value.bound));
    }
  }
  const symbolic = { ...value.nativeRequest, [Symbol('foreign')]: true };
  invalid(() => schema.assertRequest(symbolic, value.marker, value.selection, value.phase));
  const sparse = new Array(2);
  invalid(() => schema.assertRequest(
    { ...value.nativeRequest, items: sparse },
    value.marker,
    value.selection,
    value.phase
  ));
  assert.strictEqual(getters, 0);
});

test('the complete 300-selection budget closes with 299 EXISTING plus one MISSING', () => {
  const selection = parent(299);
  const phase = createdReceiptPhase(selection);
  const nativeRequest = request(selection, phase);
  const marker = markerAuthority(nativeRequest);
  const bound = schema.buildAuthority(marker, selection, phase, nativeRequest);
  assert.strictEqual(bound.parentSelection.selected.length, 300);
  assert.strictEqual(bound.request.items.length, 299);
  assert.ok(Buffer.byteLength(schema.encodeExecuteCommand(bound)) <=
    schema.LIMITS.maxRequestBytes);
  assert.ok(
    schema.LIMITS.maxItems * schema.LIMITS.maxRunItemBytes +
      schema.LIMITS.maxLineBytes * 2 <= schema.LIMITS.maxResponseBytes
  );
  const overflow = parent(300);
  assert.throws(
    () => phaseSchema.assertParentSelectionBinding(overflow),
    error => error?.code === 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE'
  );
});

console.log(`\n${passed}/${passed} Snapshot existing-restore native schema checks passed.`);
