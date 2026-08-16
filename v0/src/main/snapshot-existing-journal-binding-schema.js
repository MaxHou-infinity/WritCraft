'use strict';

// Pure descriptor-exact authority for the permanent WRCCHRJ2 journal bridge
// used by mixed EXISTING E/R. It owns no filesystem or process authority.

const evidence = require('./evidence-delivery-schema');
const markerJournalSchema = require('./changes-history-marker-journal-schema');

const SCHEMA = 'writcraft.public-markdown-existing-journal-binding/v1';
const HEAD_SCHEMA = 'writcraft.changes-history-marker-journal-head/v1';
const JOURNAL_BASENAME = 'changes-history-transaction.json';
const JOURNAL_MAGIC = 'WRCCHRJ2';
const JOURNAL_ID_RE = /^chrj_[a-f0-9]{48}$/u;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/u;
const UINT64_MAX = 18446744073709551615n;
const MAX_VALUE_BYTES = markerJournalSchema.MAX_VALUE_BYTES;
const MAX_ACTIVE_MARKER_BYTES = markerJournalSchema.MAX_ACTIVE_MARKER_BYTES;
const MAX_HEADER_BYTES = markerJournalSchema.MAX_HEADER_BYTES;
const MAX_FRAME_BYTES = markerJournalSchema.MAX_FRAME_BYTES;
const MAX_PAYLOAD_OFFSET = MAX_FRAME_BYTES - MAX_VALUE_BYTES;
const MAX_BINDING_HEADER_BYTES = 1024;

const KEYS = Object.freeze([
  'schema', 'journalBasename', 'journalMagic', 'journalFileIdentity',
  'rootIdentityDigest', 'recoveryDirectoryIdentityDigest', 'activeSlot', 'head',
  'previousValueDigest', 'frameByteLength', 'frameSha256', 'payloadOffset',
  'payloadByteLength', 'payloadSha256', 'activeMarkerOffset',
  'activeMarkerByteLength', 'activeMarkerDigest', 'activeMarkerCanonicalSha256',
  'bindingDigest',
]);

const HEAD_KEYS = Object.freeze(['schema', 'journalId', 'generation', 'valueDigest']);

class ExistingJournalBindingSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExistingJournalBindingSchemaError';
    this.code = 'SNAPSHOT_EXISTING_JOURNAL_BINDING_PROTOCOL';
  }
}

function fail(message) {
  throw new ExistingJournalBindingSchemaError(message);
}

function valuesOf(raw, keys, label) {
  try { evidence.assertExactKeys(raw, keys, label); }
  catch (_) { fail(`${label} must be a descriptor-exact plain record`); }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label}.${key} must be a data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function digest(value, label) {
  try { return evidence.assertDigest(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function integer(value, label, minimum, maximum) {
  try { return evidence.assertSafeInteger(value, label, minimum, maximum); }
  catch (_) { fail(`${label} is invalid`); }
}

function decimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) fail(`${label} is invalid`);
  try {
    if (BigInt(value) > UINT64_MAX) fail(`${label} is invalid`);
  } catch (_) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertHead(raw) {
  const value = valuesOf(raw, HEAD_KEYS, 'journal head');
  if (value.schema !== HEAD_SCHEMA || typeof value.journalId !== 'string' ||
      !JOURNAL_ID_RE.test(value.journalId)) fail('journal head is invalid');
  return Object.freeze({
    schema: HEAD_SCHEMA,
    journalId: value.journalId,
    generation: decimal(value.generation, 'journal head.generation'),
    valueDigest: digest(value.valueDigest, 'journal head.valueDigest'),
  });
}

function assertRecordIdentity(raw) {
  try { return evidence.assertObjectIdentity(raw); }
  catch (_) { fail('journalFileIdentity is invalid'); }
}

function bindingDigest(value) {
  try { return evidence.digestObject(SCHEMA, value, 'bindingDigest'); }
  catch (_) { fail('existing journal binding digest cannot be built'); }
}

function assertExistingJournalBinding(raw) {
  const value = valuesOf(raw, KEYS, 'existing journal binding');
  if (value.schema !== SCHEMA || value.journalBasename !== JOURNAL_BASENAME ||
      value.journalMagic !== JOURNAL_MAGIC || !['A', 'B'].includes(value.activeSlot)) {
    fail('existing journal binding header is invalid');
  }
  const journalFileIdentity = assertRecordIdentity(value.journalFileIdentity);
  if (journalFileIdentity.mode !== 0o600 || journalFileIdentity.nlink !== 1) {
    fail('journal file identity permissions are invalid');
  }
  const journalFileByteLength = BigInt(journalFileIdentity.size);
  const head = assertHead(value.head);
  const generation = BigInt(head.generation);
  if ((generation % 2n === 0n && value.activeSlot !== 'A') ||
      (generation % 2n === 1n && value.activeSlot !== 'B')) {
    fail('journal slot does not match generation parity');
  }
  const previousValueDigest = value.previousValueDigest === null
    ? null
    : digest(value.previousValueDigest, 'previousValueDigest');
  if ((generation === 0n && previousValueDigest !== null) ||
      (generation > 0n && previousValueDigest === null)) {
    fail('journal predecessor binding is invalid');
  }
  const frameByteLength = integer(value.frameByteLength, 'frameByteLength', 1, MAX_FRAME_BYTES);
  const frameSha256 = digest(value.frameSha256, 'frameSha256');
  const payloadOffset = integer(value.payloadOffset, 'payloadOffset', 1, MAX_PAYLOAD_OFFSET);
  const payloadByteLength = integer(
    value.payloadByteLength, 'payloadByteLength', 1, MAX_VALUE_BYTES
  );
  const payloadSha256 = digest(value.payloadSha256, 'payloadSha256');
  const activeMarkerOffset = integer(
    value.activeMarkerOffset, 'activeMarkerOffset', payloadOffset, frameByteLength
  );
  const activeMarkerByteLength = integer(
    value.activeMarkerByteLength, 'activeMarkerByteLength', 1, MAX_ACTIVE_MARKER_BYTES
  );
  if (payloadOffset + payloadByteLength !== frameByteLength ||
      activeMarkerOffset + activeMarkerByteLength > frameByteLength - 1 ||
      BigInt(frameByteLength) > journalFileByteLength) {
    fail('journal binding frame range is invalid');
  }
  const normalized = {
    schema: SCHEMA,
    journalBasename: JOURNAL_BASENAME,
    journalMagic: JOURNAL_MAGIC,
    journalFileIdentity,
    rootIdentityDigest: digest(value.rootIdentityDigest, 'rootIdentityDigest'),
    recoveryDirectoryIdentityDigest: digest(
      value.recoveryDirectoryIdentityDigest,
      'recoveryDirectoryIdentityDigest'
    ),
    activeSlot: value.activeSlot,
    head,
    previousValueDigest,
    frameByteLength,
    frameSha256,
    payloadOffset,
    payloadByteLength,
    payloadSha256,
    activeMarkerOffset,
    activeMarkerByteLength,
    activeMarkerDigest: digest(value.activeMarkerDigest, 'activeMarkerDigest'),
    activeMarkerCanonicalSha256: digest(
      value.activeMarkerCanonicalSha256,
      'activeMarkerCanonicalSha256'
    ),
    bindingDigest: null,
  };
  const expected = bindingDigest(normalized);
  if (value.bindingDigest !== expected) fail('existing journal binding digest is invalid');
  normalized.bindingDigest = expected;
  return Object.freeze(normalized);
}

function buildExistingJournalBinding(raw) {
  const value = valuesOf(raw, KEYS, 'existing journal binding');
  if (value.bindingDigest !== null && value.bindingDigest !== undefined) {
    return assertExistingJournalBinding(value);
  }
  const input = { ...value, bindingDigest: null };
  const digestValue = bindingDigest(input);
  return assertExistingJournalBinding({ ...input, bindingDigest: digestValue });
}

function digestExistingJournalBinding(raw) {
  return assertExistingJournalBinding(raw).bindingDigest;
}

module.exports = Object.freeze({
  SCHEMA,
  HEAD_SCHEMA,
  JOURNAL_BASENAME,
  JOURNAL_MAGIC,
  KEYS,
  HEAD_KEYS,
  MAX_FRAME_BYTES,
  MAX_VALUE_BYTES,
  MAX_ACTIVE_MARKER_BYTES,
  MAX_HEADER_BYTES,
  MAX_PAYLOAD_OFFSET,
  MAX_BINDING_HEADER_BYTES,
  ExistingJournalBindingSchemaError,
  buildExistingJournalBinding,
  assertExistingJournalBinding,
  digestExistingJournalBinding,
});
