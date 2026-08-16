#!/usr/bin/env node
'use strict';

const assert = require('assert');
const evidence = require('../src/main/evidence-delivery-schema');
const binding = require('../src/main/snapshot-existing-journal-binding-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;

function fixture(overrides = {}) {
  const bytes = Buffer.alloc(4096, 0x61);
  return {
    schema: binding.SCHEMA,
    journalBasename: 'changes-history-transaction.json',
    journalMagic: 'WRCCHRJ2',
    journalFileIdentity: {
      schema: evidence.SCHEMAS.OBJECT_IDENTITY,
      dev: '30', ino: '40', uid: 501, mode: 0o600, nlink: 1,
      size: String(bytes.length), mtimeNs: '3000000000', ctimeNs: '3000000001',
      contentSha256: evidence.sha256(bytes),
    },
    rootIdentityDigest: digest('a'),
    recoveryDirectoryIdentityDigest: digest('b'),
    activeSlot: 'B',
    head: {
      schema: binding.HEAD_SCHEMA,
      journalId: `chrj_${'b'.repeat(48)}`,
      generation: '7',
      valueDigest: digest('c'),
    },
    previousValueDigest: digest('d'),
    frameByteLength: 4096,
    frameSha256: digest('f'),
    payloadOffset: 128,
    payloadByteLength: 3968,
    payloadSha256: digest('e'),
    activeMarkerOffset: 160,
    activeMarkerByteLength: 64,
    activeMarkerDigest: digest('f'),
    activeMarkerCanonicalSha256: digest('a'),
    bindingDigest: null,
    ...overrides,
  };
}

assert.strictEqual(binding.SCHEMA, 'writcraft.public-markdown-existing-journal-binding/v1');
assert.strictEqual(binding.HEAD_SCHEMA, 'writcraft.changes-history-marker-journal-head/v1');
assert.deepStrictEqual(binding.KEYS, [
  'schema', 'journalBasename', 'journalMagic', 'journalFileIdentity',
  'rootIdentityDigest', 'recoveryDirectoryIdentityDigest', 'activeSlot', 'head',
  'previousValueDigest', 'frameByteLength', 'frameSha256', 'payloadOffset',
  'payloadByteLength', 'payloadSha256', 'activeMarkerOffset',
  'activeMarkerByteLength', 'activeMarkerDigest', 'activeMarkerCanonicalSha256',
  'bindingDigest',
]);
assert.deepStrictEqual(binding.HEAD_KEYS, [
  'schema', 'journalId', 'generation', 'valueDigest',
]);
const built = binding.buildExistingJournalBinding(fixture());
assert.match(built.bindingDigest, /^sha256:[a-f0-9]{64}$/u);
assert.strictEqual(
  built.bindingDigest,
  'sha256:3cb627fade8ac5c06f8af763acba5a97388fe21cc974e0671141c457774826fa'
);
assert.deepStrictEqual(binding.assertExistingJournalBinding(built), built);
assert.strictEqual(binding.digestExistingJournalBinding(built), built.bindingDigest);
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), extra: true }));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), activeSlot: 'C' }));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), journalBasename: 'foreign.json',
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), journalMagic: 'WRCCHRJ1',
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), activeSlot: 'A',
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), head: { ...fixture().head, generation: '07' },
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), head: { ...fixture().head, journalId: `foreign_${'b'.repeat(48)}` },
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), head: { ...fixture().head, valueDigest: digest('foreign') },
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), head: { ...fixture().head, generation: '18446744073709551616' },
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), previousValueDigest: null,
}));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), frameByteLength: 4097 }));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), payloadOffset: 3840 }));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), payloadByteLength: 3969 }));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), activeMarkerOffset: 120 }));
assert.throws(() => binding.buildExistingJournalBinding({ ...fixture(), activeMarkerOffset: 4033 }));
assert.throws(() => binding.buildExistingJournalBinding({
  ...fixture(), activeMarkerByteLength: binding.MAX_ACTIVE_MARKER_BYTES + 1,
}));
assert.strictEqual(binding.MAX_FRAME_BYTES,
  binding.MAX_VALUE_BYTES + binding.MAX_HEADER_BYTES + 1);
assert.strictEqual(binding.MAX_ACTIVE_MARKER_BYTES, 95 * 1024 * 1024);
assert.strictEqual(binding.MAX_PAYLOAD_OFFSET, binding.MAX_HEADER_BYTES + 1);
const maxFrame = binding.MAX_FRAME_BYTES;
const maxBinding = fixture({
  journalFileIdentity: { ...fixture().journalFileIdentity, size: String(maxFrame) },
  frameByteLength: maxFrame,
  payloadOffset: binding.MAX_PAYLOAD_OFFSET,
  payloadByteLength: binding.MAX_VALUE_BYTES,
  activeMarkerOffset: binding.MAX_PAYLOAD_OFFSET,
  activeMarkerByteLength: binding.MAX_ACTIVE_MARKER_BYTES,
});
assert.ok(binding.buildExistingJournalBinding(maxBinding).bindingDigest);
assert.throws(() => binding.buildExistingJournalBinding({
  ...maxBinding, frameByteLength: maxFrame + 1,
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...maxBinding, payloadByteLength: binding.MAX_VALUE_BYTES + 1,
}));
assert.throws(() => binding.buildExistingJournalBinding({
  ...maxBinding, activeMarkerByteLength: binding.MAX_ACTIVE_MARKER_BYTES + 1,
}));
for (const field of [
  'rootIdentityDigest', 'recoveryDirectoryIdentityDigest', 'frameSha256',
  'payloadSha256', 'activeMarkerDigest', 'activeMarkerCanonicalSha256',
  'bindingDigest',
]) {
  const tampered = { ...built, [field]: digest('foreign') };
  assert.throws(() => binding.assertExistingJournalBinding(tampered));
}
assert.throws(() => binding.buildExistingJournalBinding({
  ...built, bindingDigest: digest('foreign'),
}));
assert.throws(() => binding.assertExistingJournalBinding({
  ...built,
  journalFileIdentity: { ...built.journalFileIdentity, mode: 0o644 },
}));
assert.throws(() => binding.assertExistingJournalBinding({
  ...built,
  journalFileIdentity: { ...built.journalFileIdentity, nlink: 2 },
}));
assert.throws(() => binding.assertExistingJournalBinding({
  ...built,
  journalFileIdentity: { ...built.journalFileIdentity, size: '4095' },
}));
assert.throws(() => binding.assertExistingJournalBinding({
  ...built,
  journalFileIdentity: {
    ...built.journalFileIdentity,
    contentSha256: digest('drift'),
  },
}));
const zeroGeneration = fixture({
  activeSlot: 'A',
  head: { ...fixture().head, generation: '0' },
  previousValueDigest: null,
});
assert.match(binding.buildExistingJournalBinding(zeroGeneration).bindingDigest, /^sha256:/u);
assert.throws(() => binding.buildExistingJournalBinding({
  ...zeroGeneration, previousValueDigest: digest('bad'),
}));
let getters = 0;
const hostile = fixture();
Object.defineProperty(hostile, 'journalMagic', {
  enumerable: true,
  get() { getters += 1; return 'WRCCHRJ2'; },
});
assert.throws(() => binding.buildExistingJournalBinding(hostile));
assert.strictEqual(getters, 0);
const hidden = fixture();
Object.defineProperty(hidden, 'foreign', { value: true, enumerable: false });
assert.throws(() => binding.buildExistingJournalBinding(hidden));
const symbol = { ...fixture(), [Symbol('foreign')]: true };
assert.throws(() => binding.buildExistingJournalBinding(symbol));
const alteredPrototype = Object.assign(Object.create({ foreign: true }), fixture());
assert.throws(() => binding.buildExistingJournalBinding(alteredPrototype));
console.log('  ✓ existing journal binding pure schema');
