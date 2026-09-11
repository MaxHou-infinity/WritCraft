#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');
const native = require('../src/main/public-markdown-native-schema');

const journalId = `chrj_${'a'.repeat(48)}`;
const operationId = `chr_${'b'.repeat(48)}`;
const projectId = 'project-journal-marker-binding';

function marker() {
  return {
    schema: 'writcraft.changes-history-recovery/v1',
    operationId,
    projectId,
    kind: 'snapshot_restore',
    state: 'applying',
    outcome: null,
    files: [{ path: '章节-📚.md', beforeRevision: '1'.repeat(64), afterRevision: '2'.repeat(64) }],
    baseHistoryState: { exists: true, digest: '3'.repeat(64) },
    preparedHistoryState: { exists: true, digest: '4'.repeat(64) },
    recoveryWritePending: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
    integrity: '5'.repeat(64),
  };
}

function sealValue(raw) {
  const value = { ...raw, valueDigest: null };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function activeValue() {
  const activeMarker = marker();
  return sealValue({
    schema: journal.SCHEMAS.VALUE,
    journalId,
    generation: '1',
    previousValueDigest: `sha256:${'6'.repeat(64)}`,
    state: 'ACTIVE',
    projectId,
    activeOperationId: operationId,
    activeKind: 'snapshot_restore',
    activeMarker,
    activeMarkerDigest: journal.activeMarkerDigest(activeMarker),
    nativePublication: null,
    existingTerminalPublication: null,
    rollbackCreatePublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
  });
}

function preimage(active = activeValue(), seed = 1) {
  const bytes = Buffer.from(evidence.canonicalJson(active.activeMarker), 'utf8');
  const rawSha256 = evidence.sha256(bytes);
  return {
    byteLength: bytes.length,
    rawSha256,
    identity: {
      schema: evidence.SCHEMAS.OBJECT_IDENTITY,
      dev: String(100 + seed),
      ino: String(200 + seed),
      uid: 501,
      mode: 0o600,
      nlink: 0,
      size: String(bytes.length),
      mtimeNs: String(1000000000 + seed),
      ctimeNs: String(2000000000 + seed),
      contentSha256: rawSha256,
    },
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'PUBLIC_MARKDOWN_NATIVE_PROTOCOL');
}

function replace(raw, patch) {
  return { ...raw, ...patch };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPublic Markdown journal-marker binding pure-schema verification');

test('ACTIVE canonical payload slice and binding have an independent hard golden', () => {
  const active = activeValue();
  const fdPreimage = preimage(active);
  const slice = native.activeMarkerSlice(active);
  const binding = native.buildJournalMarkerBinding(active, fdPreimage);
  assert.deepStrictEqual(native.assertJournalMarkerBinding(binding, active, fdPreimage), binding);
  assert.deepStrictEqual({
    ...slice,
    head: slice.head,
    bindingSha256: crypto.createHash('sha256')
      .update(evidence.canonicalJson(binding), 'utf8').digest('hex'),
  }, {
    slot: 'B',
    head: {
      schema: 'writcraft.changes-history-marker-journal-head/v1',
      journalId,
      generation: '1',
      valueDigest: 'sha256:8cb44f335725f88a1b3f987f266b0a3c7fd251a050d330e2e3e162e064a80c74',
    },
    frameByteLength: 1884,
    frameSha256: 'sha256:c87943298f428d57adfedbca1d2626aa168041cfcaccf044b8bffe05d1af6790',
    payloadByteLength: 1596,
    payloadSha256: 'sha256:4b7291c2166e536c2fe902dac7eea6979cf79a5fc096b7cb50d78951b82abd77',
    activeMarkerOffset: 48,
    activeMarkerByteLength: 839,
    activeMarkerDigest: 'sha256:df1019e3ba6acef480f2da94fbd3fbb327ddee6ede1ca6c2b447d175fefa62ef',
    bindingSha256: '733fc7e71f3ca51b26422ab10129dd5aac552d77765a0d13c49cda771be84b6f',
  });
});

test('slot, head, frame, payload and slice drift are rejected', () => {
  const active = activeValue();
  const authority = preimage(active);
  const binding = native.buildJournalMarkerBinding(active, authority);
  const attacks = [
    { slot: 'A' },
    { head: replace(binding.head, { generation: '2' }) },
    { frameByteLength: binding.frameByteLength + 1 },
    { frameSha256: `sha256:${'7'.repeat(64)}` },
    { payloadByteLength: binding.payloadByteLength + 1 },
    { payloadSha256: `sha256:${'8'.repeat(64)}` },
    { activeMarkerOffset: binding.activeMarkerOffset + 1 },
    { activeMarkerByteLength: binding.activeMarkerByteLength - 1 },
    { activeMarkerDigest: `sha256:${'9'.repeat(64)}` },
  ];
  for (const patch of attacks) {
    invalid(() => native.assertJournalMarkerBinding(replace(binding, patch), active, authority));
  }
});

test('operation, project and kind are exact CAS over the ACTIVE marker', () => {
  const active = activeValue();
  const authority = preimage(active);
  const binding = native.buildJournalMarkerBinding(active, authority);
  for (const patch of [
    { operationId: `chr_${'c'.repeat(48)}` },
    { projectId: 'foreign-project' },
    { kind: 'snapshot_restore_undo' },
  ]) invalid(() => native.assertJournalMarkerBinding(replace(binding, patch), active, authority));
});

test('transient preimage requires canonical bytes and exact unlinked 0600 identity', () => {
  const active = activeValue();
  const authority = preimage(active);
  const binding = native.buildJournalMarkerBinding(active, authority);
  for (const patch of [
    { byteLength: authority.byteLength + 1 },
    { rawSha256: `sha256:${'a'.repeat(64)}` },
    { identity: replace(authority.identity, { mode: 0o644 }) },
    { identity: replace(authority.identity, { nlink: 1 }) },
    { identity: replace(authority.identity, { size: String(authority.byteLength + 1) }) },
  ]) invalid(() => native.buildJournalMarkerBinding(active, replace(authority, patch)));
  const replacement = preimage(active, 2);
  const replacementBinding = native.buildJournalMarkerBinding(active, replacement);
  invalid(() => native.assertJournalMarkerBinding(replacementBinding, active, authority));
  assert.deepStrictEqual(native.assertJournalMarkerBinding(binding, active, authority), binding);
});

test('descriptor-hostile binding and preimage shapes fail with zero getter calls', () => {
  const active = activeValue();
  const authority = preimage(active);
  const binding = native.buildJournalMarkerBinding(active, authority);
  let getterCalls = 0;
  const accessor = { ...binding };
  Object.defineProperty(accessor, 'slot', {
    enumerable: true,
    get() { getterCalls += 1; return 'B'; },
  });
  invalid(() => native.assertJournalMarkerBinding(accessor, active, authority));
  assert.strictEqual(getterCalls, 0);
  const nested = { ...authority };
  Object.defineProperty(nested, 'identity', {
    enumerable: true,
    get() { getterCalls += 1; return authority.identity; },
  });
  invalid(() => native.buildJournalMarkerBinding(active, nested));
  assert.strictEqual(getterCalls, 0);
  invalid(() => native.assertJournalMarkerBinding({ ...binding, extra: true }, active, authority));
  const symbolic = { ...authority, [Symbol('foreign')]: true };
  invalid(() => native.buildJournalMarkerBinding(active, symbolic));
});

test('common binding contains no path or marker body and inherits the 95 MiB cap', () => {
  const active = activeValue();
  const binding = native.buildJournalMarkerBinding(active, preimage(active));
  assert.strictEqual(Object.hasOwn(binding, 'path'), false);
  assert.strictEqual(Object.hasOwn(binding, 'activeMarker'), false);
  assert.strictEqual(Object.hasOwn(binding, 'payload'), false);
  assert.strictEqual(journal.MAX_ACTIVE_MARKER_BYTES, 95 * 1024 * 1024);
  assert(binding.activeMarkerByteLength <= journal.MAX_ACTIVE_MARKER_BYTES);
});

console.log(`\n${passed} public Markdown journal-marker binding verifications passed.`);
