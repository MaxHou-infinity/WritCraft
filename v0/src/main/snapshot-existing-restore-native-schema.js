'use strict';

// Pure private schema for the mixed Snapshot restore EXISTING-leaf executor.
// It owns no filesystem/process authority and creates no second recovery marker.

const evidence = require('./evidence-delivery-schema');
const phaseSchema = require('./snapshot-public-markdown-phase-schema');
const journalBindingSchema = require('./snapshot-existing-journal-binding-schema');
const markerJournalSchema = require('./changes-history-marker-journal-schema');

const METHODS = Object.freeze([
  'execute', 'reconcile', 'verify', 'finalize', 'reconcileFinalize',
]);

const COMMANDS = Object.freeze({
  EXECUTE: 'E',
  RECONCILE: 'R',
  VERIFY: 'V',
  FINALIZE: 'F',
});

const STATES = Object.freeze(['COMMITTED', 'UNCOMMITTED', 'UNKNOWN']);

const SCHEMAS = Object.freeze({
  PUBLIC_EXISTING_LEAF_IDENTITY:
    'writcraft.public-markdown-existing-leaf-identity/v1',
  EXISTING_JOURNAL_BINDING: journalBindingSchema.SCHEMA,
  MARKER_AUTHORITY: 'writcraft.changes-history-existing-restore-marker-authority/v1',
  REQUEST: 'writcraft.changes-history-native-existing-restore-request/v1',
  AUTHORITY: 'writcraft.changes-history-native-existing-restore-authority/v1',
  CONTROL: 'writcraft.changes-history-native-existing-restore-control/v1',
  APPLY_RECEIPT: 'writcraft.changes-history-native-existing-apply-receipt/v1',
  ROLLBACK_RECEIPT: 'writcraft.changes-history-native-existing-rollback-receipt/v1',
  APPLY_TOKEN: 'writcraft.changes-history-native-existing-apply-token/v1',
  ROLLBACK_TOKEN: 'writcraft.changes-history-native-existing-rollback-token/v1',
  TERMINAL_RECEIPT: 'writcraft.changes-history-native-existing-terminal-receipt/v1',
  RUN_RESULT: 'writcraft.changes-history-native-existing-run-result/v1',
  VERIFY_REQUEST: 'writcraft.changes-history-native-existing-verify-request/v1',
  VERIFY_RESULT: 'writcraft.changes-history-native-existing-verify-result/v1',
  FINALIZE_REQUEST: 'writcraft.changes-history-native-existing-finalize-request/v1',
  FINAL_RECORD: 'writcraft.changes-history-native-existing-final-record/v1',
  FINAL_RESULT: 'writcraft.changes-history-native-existing-final-result/v1',
  ACK_REQUEST: 'writcraft.changes-history-native-existing-ack-request/v1',
  ACK_RESULT: 'writcraft.changes-history-native-existing-ack-result/v1',
  RECORD_KEY: 'writcraft.changes-history-native-existing-record-key/v1',
  FINAL_KEY: 'writcraft.changes-history-native-existing-final-key/v1',
});

const LIMITS = Object.freeze({
  maxItems: 300,
  maxArtifactBytes: 384 * 1024 * 1024,
  maxHistoryBytes: 192 * 1024 * 1024,
  maxLineBytes: 16 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 768 * 1024,
  maxRunItemBytes: 2048,
  maxRecordBytes: 16 * 1024,
  maxFinalRecordBytes: 4 * 1024,
  maxJournalBindingHeaderBytes: 4096,
  maxJournalFrameBytes: journalBindingSchema.MAX_FRAME_BYTES,
});

const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/u;
const SELECTED_ID_RE = /^[A-Za-z0-9:_-]{1,256}$/u;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const ERROR_CODES = Object.freeze({
  UNKNOWN: 'EXISTING_RESTORE_UNKNOWN',
});

const KEYS = Object.freeze({
  PUBLIC_EXISTING_LEAF_BINDING: Object.freeze([
    'selectedId', 'path', 'revision', 'ancestorIdentityDigest',
    'byteLength', 'contentDigest',
  ]),
  PUBLIC_EXISTING_LEAF_OBSERVATION: Object.freeze([
    'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    'contentSha256',
  ]),
  PUBLIC_EXISTING_LEAF_IDENTITY: Object.freeze([
    'schema', 'selectedId', 'path', 'revision', 'ancestorIdentityDigest',
    'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    'contentSha256',
  ]),
  MARKER_AUTHORITY: Object.freeze([
    'schema', 'operationId', 'markerDigest', 'artifactDigest',
    'artifactIdentityDigest', 'artifactByteLength', 'baseHistoryDigest',
    'baseHistoryByteLength', 'baseHistoryExists', 'baseHistoryContentDigest',
    'historyParentIdentityDigest',
  ]),
  REQUEST: Object.freeze([
    'schema', 'operationId', 'markerDigest', 'artifactDigest',
    'artifactIdentityDigest', 'artifactByteLength', 'createdReceiptPhaseDigest',
    'selectionDigest', 'baseHistoryDigest', 'baseHistoryByteLength',
    'baseHistoryExists', 'baseHistoryContentDigest', 'historyParentIdentityDigest',
    'journalMarkerBinding', 'items',
  ]),
  ITEM: Object.freeze([
    'selectedId', 'path', 'beforeRevision', 'afterRevision',
    'beforeArtifactOffset', 'beforeByteLength', 'beforeContentDigest',
    'afterArtifactOffset', 'afterByteLength', 'afterContentDigest',
    'ancestorIdentityDigest', 'beforeLeafIdentityDigest',
  ]),
  AUTHORITY: Object.freeze([
    'schema', 'markerAuthority', 'parentSelection', 'createdReceiptPhase', 'request',
  ]),
  CONTROL: Object.freeze([
    'schema', 'operationId', 'selectedId', 'path', 'markerDigest',
    'artifactDigest', 'artifactIdentityDigest', 'createdReceiptPhaseDigest',
    'selectionDigest', 'baseHistoryDigest', 'beforeRevision', 'afterRevision',
    'beforeArtifactOffset', 'beforeByteLength', 'beforeContentDigest',
    'afterArtifactOffset', 'afterByteLength', 'afterContentDigest',
    'ancestorIdentityDigest', 'beforeLeafIdentityDigest', 'controlDigest',
  ]),
  APPLY_RECEIPT: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlDigest', 'afterContentDigest',
    'afterLeafIdentityDigest', 'fileFsyncComplete', 'parentFsyncComplete',
    'recoveryFsyncComplete', 'receiptDigest',
  ]),
  ROLLBACK_RECEIPT: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlDigest', 'applyReceiptDigest',
    'beforeContentDigest', 'restoredLeafIdentityDigest', 'fileFsyncComplete',
    'parentFsyncComplete', 'recoveryFsyncComplete', 'receiptDigest',
  ]),
  APPLY_TOKEN: Object.freeze([
    'schema', 'selectedId', 'controlBasename', 'receiptBasename',
    'controlDigest', 'applyReceiptDigest', 'afterLeafIdentityDigest',
    'controlRecordIdentity', 'receiptRecordIdentity',
  ]),
  ROLLBACK_TOKEN: Object.freeze([
    'schema', 'selectedId', 'controlBasename', 'receiptBasename',
    'controlDigest', 'applyReceiptDigest', 'afterLeafIdentityDigest',
    'rollbackReceiptDigest', 'restoredLeafIdentityDigest',
    'controlRecordIdentity', 'applyReceiptRecordIdentity',
    'rollbackReceiptRecordIdentity',
  ]),
  TERMINAL_ITEM: Object.freeze([
    'selectedId', 'applyToken', 'rollbackToken',
    'finalContentDigest', 'finalLeafIdentityDigest',
  ]),
  TERMINAL_RECEIPT: Object.freeze([
    'schema', 'operationId', 'markerDigest', 'artifactDigest',
    'createdReceiptPhaseDigest', 'selectionDigest', 'baseHistoryDigest',
    'state', 'items', 'receiptSetDigest', 'recoveryFsyncComplete',
    'terminalReceiptDigest',
  ]),
  RUN_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'terminalReceipt', 'errorCode',
  ]),
  VERIFY_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest', 'terminalReceipt',
  ]),
  VERIFY_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'terminalReceiptDigest', 'errorCode',
  ]),
  FINALIZE_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest', 'terminalReceipt',
  ]),
  FINAL_RECORD: Object.freeze([
    'schema', 'operationId', 'requestDigest', 'terminalState',
    'terminalReceiptDigest', 'receiptSetDigest', 'itemCount',
    'recoveryFsyncComplete', 'finalRecordDigest',
  ]),
  FINAL_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'finalRecord', 'finalRecordIdentity', 'errorCode',
  ]),
  ACK_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest', 'finalBasename',
    'finalRecordDigest', 'finalRecordIdentity', 'markerPhaseDigest',
  ]),
  ACK_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'finalRecordDigest', 'errorCode',
  ]),
});

class SnapshotExistingRestoreNativeSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotExistingRestoreNativeSchemaError';
    this.code = 'SNAPSHOT_EXISTING_RESTORE_NATIVE_PROTOCOL';
  }
}

function fail(message) {
  throw new SnapshotExistingRestoreNativeSchemaError(message);
}

function valuesOf(raw, keys, label) {
  try { evidence.assertExactKeys(raw, keys, label); }
  catch (_) { fail(`${label} must be a descriptor-exact plain record`); }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const result = Object.create(null);
  for (const key of keys) result[key] = descriptors[key].value;
  return result;
}

function arrayValues(raw, minimum, maximum, label) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < minimum || length > maximum ||
      Reflect.ownKeys(raw).length !== length + 1) {
    fail(`${label} must be a bounded dense array`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail(`${label} must be descriptor-exact dense data`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function immutable(value) {
  return Object.freeze(value);
}

function digest(value, label) {
  try { return evidence.assertDigest(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function ascii(value, label, pattern, maxBytes = 4096) {
  try {
    return evidence.assertString(value, label, {
      ascii: true,
      minBytes: 1,
      maxBytes,
      pattern,
    });
  } catch (_) { fail(`${label} is invalid`); }
}

function operationId(value) {
  return ascii(value, 'operationId', OPERATION_ID_RE, 52);
}

function selectedId(value, label = 'selectedId') {
  return ascii(value, label, SELECTED_ID_RE, 256);
}

function revision(value, label) {
  return ascii(value, label, REVISION_RE, 64);
}

function markdownPath(value, label = 'path') {
  if (typeof value !== 'string' || value !== value.normalize('NFC')) fail(`${label} is invalid`);
  try { return evidence.assertPublicMarkdownPath(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function integer(value, label, minimum, maximum) {
  try { return evidence.assertSafeInteger(value, label, minimum, maximum); }
  catch (_) { fail(`${label} is invalid`); }
}

function canonicalDigest(schema, value, digestField = null) {
  try { return evidence.digestObject(schema, value, digestField); }
  catch (_) { fail(`${schema} cannot be canonically digested`); }
}

function buildBaseHistoryAuthority(rawBytes, exists = true) {
  if (!(rawBytes instanceof Buffer) || rawBytes.length > LIMITS.maxHistoryBytes) {
    fail('base History raw bytes are invalid');
  }
  if (typeof exists !== 'boolean') fail('baseHistoryExists is invalid');
  if (!exists && rawBytes.length !== 0) {
    fail('absent base History cannot carry raw bytes');
  }
  if (exists && rawBytes.length === 0) {
    fail('present base History must contain raw bytes');
  }
  const prefix = Buffer.from([exists ? 0x01 : 0x00]);
  return immutable({
    baseHistoryExists: exists,
    baseHistoryContentDigest: exists ? evidence.sha256(rawBytes) : null,
    baseHistoryDigest: evidence.sha256(Buffer.concat([prefix, rawBytes])),
    baseHistoryByteLength: rawBytes.length,
  });
}

function digestHistoryParentIdentity(rawObservation) {
  try {
    return evidence.digestRootIdentity({
      schema: evidence.SCHEMAS.ROOT_IDENTITY,
      dev: String(rawObservation.dev),
      ino: String(rawObservation.ino),
      uid: rawObservation.uid,
      mode: rawObservation.mode,
    });
  } catch (_) { fail('History parent identity is invalid'); }
}

const MAX_UINT64 = 18446744073709551615n;

function unsigned64(value, label) {
  try { evidence.assertUnsignedDecimal(value, label); }
  catch (_) { fail(`${label} is invalid`); }
  if (value.length > 20) fail(`${label} exceeds uint64`);
  if (BigInt(value) > MAX_UINT64) fail(`${label} exceeds uint64`);
  return value;
}

function assertExistingLeafBinding(raw) {
  const value = valuesOf(
    raw,
    KEYS.PUBLIC_EXISTING_LEAF_BINDING,
    'public existing leaf binding'
  );
  return immutable({
    selectedId: selectedId(value.selectedId, 'public existing leaf binding.selectedId'),
    path: markdownPath(value.path, 'public existing leaf binding.path'),
    revision: revision(value.revision, 'public existing leaf binding.revision'),
    ancestorIdentityDigest: digest(
      value.ancestorIdentityDigest,
      'public existing leaf binding.ancestorIdentityDigest'
    ),
    byteLength: integer(
      value.byteLength,
      'public existing leaf binding.byteLength',
      0,
      LIMITS.maxArtifactBytes
    ),
    contentDigest: digest(
      value.contentDigest,
      'public existing leaf binding.contentDigest'
    ),
  });
}

function assertExistingLeafObservation(raw) {
  const value = valuesOf(
    raw,
    KEYS.PUBLIC_EXISTING_LEAF_OBSERVATION,
    'public existing leaf observation'
  );
  const observation = immutable({
    dev: unsigned64(value.dev, 'public existing leaf observation.dev'),
    ino: unsigned64(value.ino, 'public existing leaf observation.ino'),
    uid: integer(
      value.uid,
      'public existing leaf observation.uid',
      0,
      0xffffffff
    ),
    mode: integer(
      value.mode,
      'public existing leaf observation.mode',
      0,
      0xffff
    ),
    nlink: integer(value.nlink, 'public existing leaf observation.nlink', 1, 1),
    size: unsigned64(value.size, 'public existing leaf observation.size'),
    mtimeNs: unsigned64(value.mtimeNs, 'public existing leaf observation.mtimeNs'),
    ctimeNs: unsigned64(value.ctimeNs, 'public existing leaf observation.ctimeNs'),
    contentSha256: digest(
      value.contentSha256,
      'public existing leaf observation.contentSha256'
    ),
  });
  return observation;
}

function buildExistingLeafIdentity(rawBinding, rawObservation) {
  const binding = assertExistingLeafBinding(rawBinding);
  const observation = assertExistingLeafObservation(rawObservation);
  if (binding.contentDigest !== `sha256:${binding.revision}` ||
      observation.contentSha256 !== binding.contentDigest ||
      observation.size !== String(binding.byteLength)) {
    fail('public existing leaf observation does not bind exact revision bytes');
  }
  return immutable({
    schema: SCHEMAS.PUBLIC_EXISTING_LEAF_IDENTITY,
    selectedId: binding.selectedId,
    path: binding.path,
    revision: binding.revision,
    ancestorIdentityDigest: binding.ancestorIdentityDigest,
    dev: observation.dev,
    ino: observation.ino,
    uid: observation.uid,
    mode: observation.mode,
    nlink: observation.nlink,
    size: observation.size,
    mtimeNs: observation.mtimeNs,
    ctimeNs: observation.ctimeNs,
    contentSha256: observation.contentSha256,
  });
}

function assertExistingLeafIdentity(raw, rawBinding) {
  const value = valuesOf(
    raw,
    KEYS.PUBLIC_EXISTING_LEAF_IDENTITY,
    'public existing leaf identity'
  );
  if (value.schema !== SCHEMAS.PUBLIC_EXISTING_LEAF_IDENTITY) {
    fail('public existing leaf identity schema invalid');
  }
  const expected = buildExistingLeafIdentity(rawBinding, {
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    contentSha256: value.contentSha256,
  });
  for (const key of KEYS.PUBLIC_EXISTING_LEAF_IDENTITY) {
    if (value[key] !== expected[key]) fail('public existing leaf identity is foreign');
  }
  return expected;
}

function digestExistingLeafIdentity(raw, rawBinding) {
  const identity = assertExistingLeafIdentity(raw, rawBinding);
  return canonicalDigest(SCHEMAS.PUBLIC_EXISTING_LEAF_IDENTITY, identity);
}

function assertRecordIdentity(raw, label) {
  try { return evidence.assertObjectIdentity(raw, label); }
  catch (_) { fail(`${label} is invalid`); }
}

const {
  buildExistingJournalBinding,
  assertExistingJournalBinding,
  digestExistingJournalBinding,
} = journalBindingSchema;

function parentBinding(raw) {
  try { return phaseSchema.assertParentSelectionBinding(raw); }
  catch (_) { fail('parent selection authority is invalid'); }
}

function createdReceiptPhase(raw, parent) {
  try { return phaseSchema.assertPhaseRecord(raw, parent); }
  catch (_) { fail('CREATED_RECEIPT phase authority is invalid'); }
}

function assertMarkerAuthority(raw) {
  const value = valuesOf(raw, KEYS.MARKER_AUTHORITY, 'marker authority');
  if (typeof value.baseHistoryExists !== 'boolean') {
    fail('baseHistoryExists is invalid');
  }
  const baseHistoryContentDigest = value.baseHistoryContentDigest === null
    ? null
    : digest(value.baseHistoryContentDigest, 'baseHistoryContentDigest');
  const baseHistoryByteLength = integer(
    value.baseHistoryByteLength,
    'baseHistoryByteLength',
    0,
    LIMITS.maxHistoryBytes
  );
  const historyParentIdentityDigest = digest(
    value.historyParentIdentityDigest,
    'historyParentIdentityDigest'
  );
  if (!value.baseHistoryExists &&
      (baseHistoryByteLength !== 0 || baseHistoryContentDigest !== null ||
       value.baseHistoryDigest !== evidence.sha256(Buffer.from([0x00])))) {
    fail('absent base History authority is invalid');
  }
  if (value.baseHistoryExists &&
      (baseHistoryByteLength === 0 || baseHistoryContentDigest === null)) {
    fail('present base History authority is incomplete');
  }
  const authority = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    markerDigest: digest(value.markerDigest, 'markerDigest'),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    artifactByteLength: integer(
      value.artifactByteLength,
      'artifactByteLength',
      1,
      LIMITS.maxArtifactBytes
    ),
    baseHistoryDigest: digest(value.baseHistoryDigest, 'baseHistoryDigest'),
    baseHistoryByteLength,
    baseHistoryExists: value.baseHistoryExists,
    baseHistoryContentDigest,
    historyParentIdentityDigest,
  });
  if (authority.schema !== SCHEMAS.MARKER_AUTHORITY) {
    fail('marker authority schema invalid');
  }
  return authority;
}

function assertRequestItem(raw, index, expected) {
  const value = valuesOf(raw, KEYS.ITEM, `request.items[${index}]`);
  const item = immutable({
    selectedId: selectedId(value.selectedId, `request.items[${index}].selectedId`),
    path: markdownPath(value.path, `request.items[${index}].path`),
    beforeRevision: revision(value.beforeRevision, `request.items[${index}].beforeRevision`),
    afterRevision: revision(value.afterRevision, `request.items[${index}].afterRevision`),
    beforeArtifactOffset: integer(
      value.beforeArtifactOffset,
      `request.items[${index}].beforeArtifactOffset`,
      0,
      LIMITS.maxArtifactBytes
    ),
    beforeByteLength: integer(
      value.beforeByteLength,
      `request.items[${index}].beforeByteLength`,
      0,
      LIMITS.maxArtifactBytes
    ),
    beforeContentDigest: digest(
      value.beforeContentDigest,
      `request.items[${index}].beforeContentDigest`
    ),
    afterArtifactOffset: integer(
      value.afterArtifactOffset,
      `request.items[${index}].afterArtifactOffset`,
      0,
      LIMITS.maxArtifactBytes
    ),
    afterByteLength: integer(
      value.afterByteLength,
      `request.items[${index}].afterByteLength`,
      0,
      LIMITS.maxArtifactBytes
    ),
    afterContentDigest: digest(
      value.afterContentDigest,
      `request.items[${index}].afterContentDigest`
    ),
    ancestorIdentityDigest: digest(
      value.ancestorIdentityDigest,
      `request.items[${index}].ancestorIdentityDigest`
    ),
    beforeLeafIdentityDigest: digest(
      value.beforeLeafIdentityDigest,
      `request.items[${index}].beforeLeafIdentityDigest`
    ),
  });
  if (item.selectedId !== expected.selectedId || item.path !== expected.path ||
      item.afterRevision !== expected.revision ||
      item.ancestorIdentityDigest !== expected.ancestorIdentityDigest ||
      item.beforeContentDigest !== `sha256:${item.beforeRevision}` ||
      item.afterContentDigest !== `sha256:${item.afterRevision}` ||
      item.beforeArtifactOffset + item.beforeByteLength > LIMITS.maxArtifactBytes ||
      item.afterArtifactOffset + item.afterByteLength > LIMITS.maxArtifactBytes) {
    fail(`request.items[${index}] does not bind parent and exact byte authority`);
  }
  return item;
}

function assertRequest(raw, rawMarkerAuthority, rawParent, rawCreatedReceiptPhase) {
  const marker = assertMarkerAuthority(rawMarkerAuthority);
  const parent = parentBinding(rawParent);
  const phase = createdReceiptPhase(rawCreatedReceiptPhase, parent);
  const phaseIsCreated = phase.phase === 'CREATED_RECEIPT';
  // E requires the exact CREATED_RECEIPT phase; fresh R legitimately carries
  // the evolved EXISTING_COMMITTED marker phase while still binding the
  // original CREATED_RECEIPT phase digest stored in the publication.
  if (parent.kind !== 'snapshot_restore' ||
      (!phaseIsCreated && phase.phase !== 'EXISTING_COMMITTED')) {
    fail('existing restore requires the exact snapshot_restore CREATED_RECEIPT phase');
  }
  const expected = parent.selected.filter(item => item.action === 'EXISTING');
  if (!expected.length) fail('existing restore requires a non-empty EXISTING subset');
  const value = valuesOf(raw, KEYS.REQUEST, 'existing restore request');
  if (typeof value.baseHistoryExists !== 'boolean') {
    fail('request baseHistoryExists is invalid');
  }
  const baseHistoryContentDigest = value.baseHistoryContentDigest === null
    ? null
    : digest(value.baseHistoryContentDigest, 'request baseHistoryContentDigest');
  const baseHistoryByteLength = integer(
    value.baseHistoryByteLength,
    'request baseHistoryByteLength',
    0,
    LIMITS.maxHistoryBytes
  );
  const historyParentIdentityDigest = digest(
    value.historyParentIdentityDigest,
    'request historyParentIdentityDigest'
  );
  const journalMarkerBinding = assertExistingJournalBinding(value.journalMarkerBinding);
  if (!value.baseHistoryExists &&
      (baseHistoryByteLength !== 0 || baseHistoryContentDigest !== null ||
       value.baseHistoryDigest !== evidence.sha256(Buffer.from([0x00])))) {
    fail('request absent base History authority is invalid');
  }
  if (value.baseHistoryExists &&
      (baseHistoryByteLength === 0 || baseHistoryContentDigest === null)) {
    fail('request present base History authority is incomplete');
  }
  const items = arrayValues(value.items, expected.length, expected.length, 'request.items')
    .map((item, index) => assertRequestItem(item, index, expected[index]));
  if (new Set(items.map(item => item.beforeLeafIdentityDigest)).size !== items.length) {
    fail('request before leaf identities must be unique');
  }
  const request = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    markerDigest: digest(value.markerDigest, 'markerDigest'),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    artifactByteLength: integer(
      value.artifactByteLength,
      'artifactByteLength',
      1,
      LIMITS.maxArtifactBytes
    ),
    createdReceiptPhaseDigest: digest(
      value.createdReceiptPhaseDigest,
      'createdReceiptPhaseDigest'
    ),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    baseHistoryDigest: digest(value.baseHistoryDigest, 'baseHistoryDigest'),
    baseHistoryByteLength,
    baseHistoryExists: value.baseHistoryExists,
    baseHistoryContentDigest,
    historyParentIdentityDigest,
    journalMarkerBinding,
    items: immutable(items),
  });
  if (request.schema !== SCHEMAS.REQUEST || request.operationId !== phase.operationId ||
      request.operationId !== marker.operationId ||
      request.markerDigest !== marker.markerDigest ||
      request.artifactDigest !== phase.artifactDigest ||
      request.artifactDigest !== marker.artifactDigest ||
      request.artifactIdentityDigest !== marker.artifactIdentityDigest ||
      request.artifactByteLength !== marker.artifactByteLength ||
      request.baseHistoryDigest !== marker.baseHistoryDigest ||
      request.baseHistoryByteLength !== marker.baseHistoryByteLength ||
      request.baseHistoryExists !== marker.baseHistoryExists ||
      request.baseHistoryContentDigest !== marker.baseHistoryContentDigest ||
      request.historyParentIdentityDigest !== marker.historyParentIdentityDigest ||
      request.selectionDigest !== phase.selectionDigest ||
      (phaseIsCreated &&
       request.createdReceiptPhaseDigest !== canonicalDigest(phaseSchema.SCHEMA, phase)) ||
      items.some(item => item.beforeArtifactOffset + item.beforeByteLength >
        request.artifactByteLength || item.afterArtifactOffset + item.afterByteLength >
        request.artifactByteLength)) {
    fail('existing restore request does not bind marker/artifact/phase authority');
  }
  return request;
}

function buildAuthority(rawMarkerAuthority, rawParent, rawCreatedReceiptPhase, rawRequest) {
  const markerAuthority = assertMarkerAuthority(rawMarkerAuthority);
  const parentSelection = parentBinding(rawParent);
  const phase = createdReceiptPhase(rawCreatedReceiptPhase, parentSelection);
  const request = assertRequest(rawRequest, markerAuthority, parentSelection, phase);
  return immutable({
    schema: SCHEMAS.AUTHORITY,
    markerAuthority,
    parentSelection,
    createdReceiptPhase: phase,
    request,
  });
}

function assertAuthority(raw) {
  const value = valuesOf(raw, KEYS.AUTHORITY, 'existing restore authority');
  if (value.schema !== SCHEMAS.AUTHORITY) fail('existing restore authority schema invalid');
  return buildAuthority(
    value.markerAuthority,
    value.parentSelection,
    value.createdReceiptPhase,
    value.request
  );
}

function requestDigest(rawAuthority) {
  const authority = assertAuthority(rawAuthority);
  return canonicalDigest(SCHEMAS.REQUEST, authority.request);
}

function recordKey(rawAuthority, index, requestDigestOverride = null) {
  const authority = assertAuthority(rawAuthority);
  const item = authority.request.items[index];
  if (!item) fail('record index invalid');
  return canonicalDigest(SCHEMAS.RECORD_KEY, {
    schema: SCHEMAS.RECORD_KEY,
    operationId: authority.request.operationId,
    requestDigest: requestDigestOverride || requestDigest(authority),
    selectedId: item.selectedId,
  }).slice('sha256:'.length);
}

function recordNames(rawAuthority, index, requestDigestOverride = null) {
  const suffix = recordKey(rawAuthority, index, requestDigestOverride);
  return immutable({
    controlBasename: `.changes-history-native-existing-control.${suffix}`,
    applyReceiptBasename: `.changes-history-native-existing-apply.${suffix}`,
    rollbackReceiptBasename: `.changes-history-native-existing-rollback.${suffix}`,
    beforeQuarantineBasename: `.changes-history-native-existing-before.${suffix}`,
    afterStageBasename: `.changes-history-native-existing-stage.${suffix}`,
  });
}

function buildControl(rawAuthority, index) {
  const authority = assertAuthority(rawAuthority);
  const item = authority.request.items[index];
  if (!item) fail('control index invalid');
  const control = {
    schema: SCHEMAS.CONTROL,
    operationId: authority.request.operationId,
    selectedId: item.selectedId,
    path: item.path,
    markerDigest: authority.request.markerDigest,
    artifactDigest: authority.request.artifactDigest,
    artifactIdentityDigest: authority.request.artifactIdentityDigest,
    createdReceiptPhaseDigest: authority.request.createdReceiptPhaseDigest,
    selectionDigest: authority.request.selectionDigest,
    baseHistoryDigest: authority.request.baseHistoryDigest,
    beforeRevision: item.beforeRevision,
    afterRevision: item.afterRevision,
    beforeArtifactOffset: item.beforeArtifactOffset,
    beforeByteLength: item.beforeByteLength,
    beforeContentDigest: item.beforeContentDigest,
    afterArtifactOffset: item.afterArtifactOffset,
    afterByteLength: item.afterByteLength,
    afterContentDigest: item.afterContentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    beforeLeafIdentityDigest: item.beforeLeafIdentityDigest,
  };
  return immutable({
    ...control,
    controlDigest: canonicalDigest(SCHEMAS.CONTROL, control),
  });
}

function assertControl(raw, rawAuthority, index) {
  const value = valuesOf(raw, KEYS.CONTROL, 'existing restore control');
  const expected = buildControl(rawAuthority, index);
  for (const key of KEYS.CONTROL) {
    if (value[key] !== expected[key]) fail('existing restore control is foreign');
  }
  return expected;
}

function buildApplyReceipt(rawAuthority, index, afterLeafIdentityDigest) {
  const authority = assertAuthority(rawAuthority);
  const control = buildControl(authority, index);
  const receipt = {
    schema: SCHEMAS.APPLY_RECEIPT,
    operationId: authority.request.operationId,
    selectedId: control.selectedId,
    controlDigest: control.controlDigest,
    afterContentDigest: control.afterContentDigest,
    afterLeafIdentityDigest: digest(afterLeafIdentityDigest, 'afterLeafIdentityDigest'),
    fileFsyncComplete: true,
    parentFsyncComplete: true,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...receipt,
    receiptDigest: canonicalDigest(SCHEMAS.APPLY_RECEIPT, receipt),
  });
}

function assertApplyReceipt(raw, rawAuthority, index) {
  const value = valuesOf(raw, KEYS.APPLY_RECEIPT, 'apply receipt');
  const expected = buildApplyReceipt(rawAuthority, index, value.afterLeafIdentityDigest);
  for (const key of KEYS.APPLY_RECEIPT) {
    if (value[key] !== expected[key]) fail('apply receipt is foreign');
  }
  return expected;
}

function buildRollbackReceipt(
  rawAuthority,
  index,
  restoredLeafIdentityDigest,
  rawApplyReceipt = null
) {
  const authority = assertAuthority(rawAuthority);
  const control = buildControl(authority, index);
  const apply = rawApplyReceipt === null
    ? null
    : assertApplyReceipt(rawApplyReceipt, authority, index);
  const receipt = {
    schema: SCHEMAS.ROLLBACK_RECEIPT,
    operationId: authority.request.operationId,
    selectedId: control.selectedId,
    controlDigest: control.controlDigest,
    applyReceiptDigest: apply?.receiptDigest || null,
    beforeContentDigest: control.beforeContentDigest,
    restoredLeafIdentityDigest: digest(
      restoredLeafIdentityDigest,
      'restoredLeafIdentityDigest'
    ),
    fileFsyncComplete: true,
    parentFsyncComplete: true,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...receipt,
    receiptDigest: canonicalDigest(SCHEMAS.ROLLBACK_RECEIPT, receipt),
  });
}

function assertRollbackReceipt(raw, rawAuthority, index, rawApplyReceipt = null) {
  const value = valuesOf(raw, KEYS.ROLLBACK_RECEIPT, 'rollback receipt');
  const expected = buildRollbackReceipt(
    rawAuthority,
    index,
    value.restoredLeafIdentityDigest,
    rawApplyReceipt
  );
  for (const key of KEYS.ROLLBACK_RECEIPT) {
    if (value[key] !== expected[key]) fail('rollback receipt is foreign');
  }
  return expected;
}

function encodeControlRecord(raw, rawAuthority, index) {
  const value = assertControl(raw, rawAuthority, index);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, hexUtf8(value.path),
    value.markerDigest, value.artifactDigest, value.artifactIdentityDigest,
    value.createdReceiptPhaseDigest, value.selectionDigest, value.baseHistoryDigest,
    value.beforeRevision, value.afterRevision, String(value.beforeArtifactOffset),
    String(value.beforeByteLength), value.beforeContentDigest,
    String(value.afterArtifactOffset), String(value.afterByteLength),
    value.afterContentDigest, value.ancestorIdentityDigest,
    value.beforeLeafIdentityDigest, value.controlDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'existing control record');
}

function encodeApplyReceiptRecord(raw, rawAuthority, index) {
  const value = assertApplyReceipt(raw, rawAuthority, index);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.controlDigest,
    value.afterContentDigest, value.afterLeafIdentityDigest, '1', '1', '1',
    value.receiptDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'existing apply receipt');
}

function encodeRollbackReceiptRecord(raw, rawAuthority, index, rawApplyReceipt = null) {
  const value = assertRollbackReceipt(raw, rawAuthority, index, rawApplyReceipt);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.controlDigest,
    value.applyReceiptDigest || '-', value.beforeContentDigest,
    value.restoredLeafIdentityDigest, '1', '1', '1', value.receiptDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'existing rollback receipt');
}

function assertPrivateRecordIdentity(raw, wire, label) {
  const identity = assertRecordIdentity(raw, label);
  const bytes = Buffer.from(wire, 'utf8');
  if (identity.mode !== 0o600 || identity.nlink !== 1 ||
      identity.size !== String(bytes.length) ||
      identity.contentSha256 !== evidence.sha256(bytes)) {
    fail(`${label} does not bind canonical private record bytes`);
  }
  return identity;
}

function buildApplyToken(
  rawAuthority,
  index,
  rawApplyReceipt,
  rawControlRecordIdentity,
  rawReceiptRecordIdentity,
  requestDigestOverride = null
) {
  const authority = assertAuthority(rawAuthority);
  const control = buildControl(authority, index);
  const receipt = assertApplyReceipt(rawApplyReceipt, authority, index);
  const names = recordNames(authority, index, requestDigestOverride);
  return immutable({
    schema: SCHEMAS.APPLY_TOKEN,
    selectedId: control.selectedId,
    controlBasename: names.controlBasename,
    receiptBasename: names.applyReceiptBasename,
    controlDigest: control.controlDigest,
    applyReceiptDigest: receipt.receiptDigest,
    afterLeafIdentityDigest: receipt.afterLeafIdentityDigest,
    controlRecordIdentity: assertPrivateRecordIdentity(
      rawControlRecordIdentity,
      encodeControlRecord(control, authority, index),
      'controlRecordIdentity'
    ),
    receiptRecordIdentity: assertPrivateRecordIdentity(
      rawReceiptRecordIdentity,
      encodeApplyReceiptRecord(receipt, authority, index),
      'receiptRecordIdentity'
    ),
  });
}

function assertApplyToken(raw, rawAuthority, index, requestDigestOverride = null) {
  const value = valuesOf(raw, KEYS.APPLY_TOKEN, 'apply token');
  const authority = assertAuthority(rawAuthority);
  const receipt = buildApplyReceipt(authority, index, value.afterLeafIdentityDigest);
  const expected = buildApplyToken(
    authority,
    index,
    receipt,
    value.controlRecordIdentity,
    value.receiptRecordIdentity,
    requestDigestOverride
  );
  for (const key of KEYS.APPLY_TOKEN) {
    if (['controlRecordIdentity', 'receiptRecordIdentity'].includes(key)) continue;
    if (value[key] !== expected[key]) fail('apply token is foreign');
  }
  return expected;
}

function buildRollbackToken(
  rawAuthority,
  index,
  rawRollbackReceipt,
  rawControlRecordIdentity,
  rawRollbackReceiptRecordIdentity,
  rawApplyToken = null
) {
  const authority = assertAuthority(rawAuthority);
  const control = buildControl(authority, index);
  const applyToken = rawApplyToken === null
    ? null
    : assertApplyToken(rawApplyToken, authority, index);
  const applyReceipt = applyToken === null
    ? null
    : buildApplyReceipt(authority, index, applyToken.afterLeafIdentityDigest);
  const rollback = assertRollbackReceipt(
    rawRollbackReceipt,
    authority,
    index,
    applyReceipt
  );
  const names = recordNames(authority, index);
  return immutable({
    schema: SCHEMAS.ROLLBACK_TOKEN,
    selectedId: control.selectedId,
    controlBasename: names.controlBasename,
    receiptBasename: names.rollbackReceiptBasename,
    controlDigest: control.controlDigest,
    applyReceiptDigest: applyToken?.applyReceiptDigest || null,
    afterLeafIdentityDigest: applyToken?.afterLeafIdentityDigest || null,
    rollbackReceiptDigest: rollback.receiptDigest,
    restoredLeafIdentityDigest: rollback.restoredLeafIdentityDigest,
    controlRecordIdentity: assertPrivateRecordIdentity(
      rawControlRecordIdentity,
      encodeControlRecord(control, authority, index),
      'controlRecordIdentity'
    ),
    applyReceiptRecordIdentity: applyToken?.receiptRecordIdentity || null,
    rollbackReceiptRecordIdentity: assertPrivateRecordIdentity(
      rawRollbackReceiptRecordIdentity,
      encodeRollbackReceiptRecord(rollback, authority, index, applyReceipt),
      'rollbackReceiptRecordIdentity'
    ),
  });
}

function assertRollbackToken(raw, rawAuthority, index) {
  const value = valuesOf(raw, KEYS.ROLLBACK_TOKEN, 'rollback token');
  const authority = assertAuthority(rawAuthority);
  const applyToken = value.applyReceiptDigest === null
    ? (value.afterLeafIdentityDigest === null && value.applyReceiptRecordIdentity === null
      ? null
      : fail('rollback token partial apply authority invalid'))
    : assertApplyToken({
      schema: SCHEMAS.APPLY_TOKEN,
      selectedId: value.selectedId,
      controlBasename: value.controlBasename,
      receiptBasename: recordNames(authority, index).applyReceiptBasename,
      controlDigest: value.controlDigest,
      applyReceiptDigest: value.applyReceiptDigest,
      afterLeafIdentityDigest: value.afterLeafIdentityDigest,
      controlRecordIdentity: value.controlRecordIdentity,
      receiptRecordIdentity: value.applyReceiptRecordIdentity,
    }, authority, index);
  const applyReceipt = applyToken === null
    ? null
    : buildApplyReceipt(authority, index, applyToken.afterLeafIdentityDigest);
  const rollbackReceipt = buildRollbackReceipt(
    authority,
    index,
    value.restoredLeafIdentityDigest,
    applyReceipt
  );
  const expected = buildRollbackToken(
    authority,
    index,
    rollbackReceipt,
    value.controlRecordIdentity,
    value.rollbackReceiptRecordIdentity,
    applyToken
  );
  for (const key of KEYS.ROLLBACK_TOKEN) {
    if (['controlRecordIdentity', 'applyReceiptRecordIdentity',
      'rollbackReceiptRecordIdentity'].includes(key)) continue;
    if (value[key] !== expected[key]) fail('rollback token is foreign');
  }
  return expected;
}

function receiptSet(rawAuthority, state, rawReceipts, requestDigestOverride = null) {
  const authority = assertAuthority(rawAuthority);
  if (!['COMMITTED', 'UNCOMMITTED'].includes(state)) fail('terminal state invalid');
  const receipts = arrayValues(
    rawReceipts,
    authority.request.items.length,
    authority.request.items.length,
    'terminal receipts'
  );
  const items = receipts.map((raw, index) => {
    const item = authority.request.items[index];
    if (state === 'COMMITTED') {
      const apply = assertApplyToken(raw, authority, index, requestDigestOverride);
      return immutable({
        selectedId: item.selectedId,
        applyToken: apply,
        rollbackToken: null,
        finalContentDigest: item.afterContentDigest,
        finalLeafIdentityDigest: apply.afterLeafIdentityDigest,
      });
    }
    const rollback = assertRollbackToken(raw, authority, index);
    return immutable({
      selectedId: item.selectedId,
      applyToken: rollback.applyReceiptDigest === null
        ? null
        : immutable({
          schema: SCHEMAS.APPLY_TOKEN,
          selectedId: rollback.selectedId,
          controlBasename: rollback.controlBasename,
          receiptBasename: recordNames(authority, index).applyReceiptBasename,
          controlDigest: rollback.controlDigest,
          applyReceiptDigest: rollback.applyReceiptDigest,
          afterLeafIdentityDigest: rollback.afterLeafIdentityDigest,
          controlRecordIdentity: rollback.controlRecordIdentity,
          receiptRecordIdentity: rollback.applyReceiptRecordIdentity,
        }),
      rollbackToken: rollback,
      finalContentDigest: item.beforeContentDigest,
      finalLeafIdentityDigest: rollback.restoredLeafIdentityDigest,
    });
  });
  return immutable(items);
}

function receiptSetDigest(rawAuthority, state, rawReceipts, requestDigestOverride = null) {
  const authority = assertAuthority(rawAuthority);
  const items = receiptSet(authority, state, rawReceipts, requestDigestOverride);
  return canonicalDigest(SCHEMAS.TERMINAL_RECEIPT, {
    schema: SCHEMAS.TERMINAL_RECEIPT,
    operationId: authority.request.operationId,
    requestDigest: requestDigestOverride || requestDigest(authority),
    state,
    items,
  });
}

function buildTerminalReceipt(rawAuthority, state, rawReceipts, requestDigestOverride = null) {
  const authority = assertAuthority(rawAuthority);
  const items = receiptSet(authority, state, rawReceipts, requestDigestOverride);
  const base = {
    schema: SCHEMAS.TERMINAL_RECEIPT,
    operationId: authority.request.operationId,
    markerDigest: authority.request.markerDigest,
    artifactDigest: authority.request.artifactDigest,
    createdReceiptPhaseDigest: authority.request.createdReceiptPhaseDigest,
    selectionDigest: authority.request.selectionDigest,
    baseHistoryDigest: authority.request.baseHistoryDigest,
    state,
    items,
    receiptSetDigest: receiptSetDigest(
      authority,
      state,
      rawReceipts,
      requestDigestOverride
    ),
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...base,
    terminalReceiptDigest: canonicalDigest(SCHEMAS.TERMINAL_RECEIPT, base),
  });
}

function assertTerminalReceipt(raw, rawAuthority, requestDigestOverride = null) {
  const value = valuesOf(raw, KEYS.TERMINAL_RECEIPT, 'terminal receipt');
  const authority = assertAuthority(rawAuthority);
  if (!['COMMITTED', 'UNCOMMITTED'].includes(value.state)) fail('terminal receipt state invalid');
  const items = arrayValues(
    value.items,
    authority.request.items.length,
    authority.request.items.length,
    'terminal receipt.items'
  ).map((rawItem, index) => {
    const itemValue = valuesOf(rawItem, KEYS.TERMINAL_ITEM, `terminal receipt.items[${index}]`);
    const source = authority.request.items[index];
    const committed = value.state === 'COMMITTED';
    const apply = itemValue.applyToken === null
      ? null
      : assertApplyToken(itemValue.applyToken, authority, index, requestDigestOverride);
    const rollback = itemValue.rollbackToken === null
      ? null
      : assertRollbackToken(itemValue.rollbackToken, authority, index);
    const rollbackApply = rollback?.applyReceiptDigest
      ? immutable({
        schema: SCHEMAS.APPLY_TOKEN,
        selectedId: rollback.selectedId,
        controlBasename: rollback.controlBasename,
        receiptBasename: recordNames(authority, index, requestDigestOverride).applyReceiptBasename,
        controlDigest: rollback.controlDigest,
        applyReceiptDigest: rollback.applyReceiptDigest,
        afterLeafIdentityDigest: rollback.afterLeafIdentityDigest,
        controlRecordIdentity: rollback.controlRecordIdentity,
        receiptRecordIdentity: rollback.applyReceiptRecordIdentity,
      })
      : null;
    const item = immutable({
      selectedId: selectedId(itemValue.selectedId),
      applyToken: apply,
      rollbackToken: rollback,
      finalContentDigest: digest(itemValue.finalContentDigest, 'finalContentDigest'),
      finalLeafIdentityDigest: digest(
        itemValue.finalLeafIdentityDigest,
        'finalLeafIdentityDigest'
      ),
    });
    if (item.selectedId !== source.selectedId ||
        (committed && item.applyToken === null) ||
        (!committed && item.rollbackToken === null) ||
        (committed && item.rollbackToken !== null) ||
        (!committed && ((item.applyToken === null) !==
          (item.rollbackToken.applyReceiptDigest === null))) ||
        (!committed && item.applyToken !== null &&
          canonicalDigest(SCHEMAS.APPLY_TOKEN, item.applyToken) !==
          canonicalDigest(SCHEMAS.APPLY_TOKEN, rollbackApply)) ||
        item.finalContentDigest !== (committed
          ? source.afterContentDigest
          : source.beforeContentDigest) ||
        item.finalLeafIdentityDigest !== (committed
          ? item.applyToken.afterLeafIdentityDigest
          : item.rollbackToken.restoredLeafIdentityDigest)) {
      fail('terminal receipt item does not bind terminal state');
    }
    return item;
  });
  const canonicalSet = canonicalDigest(SCHEMAS.TERMINAL_RECEIPT, {
    schema: SCHEMAS.TERMINAL_RECEIPT,
    operationId: authority.request.operationId,
    requestDigest: requestDigestOverride || requestDigest(authority),
    state: value.state,
    items,
  });
  if (new Set(items.map(item => item.finalLeafIdentityDigest)).size !== items.length) {
    fail('terminal receipt final leaf identities must be unique');
  }
  const base = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    markerDigest: digest(value.markerDigest, 'markerDigest'),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    createdReceiptPhaseDigest: digest(
      value.createdReceiptPhaseDigest,
      'createdReceiptPhaseDigest'
    ),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    baseHistoryDigest: digest(value.baseHistoryDigest, 'baseHistoryDigest'),
    state: value.state,
    items: immutable(items),
    receiptSetDigest: digest(value.receiptSetDigest, 'receiptSetDigest'),
    recoveryFsyncComplete: value.recoveryFsyncComplete,
  });
  if (base.schema !== SCHEMAS.TERMINAL_RECEIPT ||
      base.operationId !== authority.request.operationId ||
      base.markerDigest !== authority.request.markerDigest ||
      base.artifactDigest !== authority.request.artifactDigest ||
      base.createdReceiptPhaseDigest !== authority.request.createdReceiptPhaseDigest ||
      base.selectionDigest !== authority.request.selectionDigest ||
      base.baseHistoryDigest !== authority.request.baseHistoryDigest ||
      base.receiptSetDigest !== canonicalSet || base.recoveryFsyncComplete !== true ||
      value.terminalReceiptDigest !== canonicalDigest(SCHEMAS.TERMINAL_RECEIPT, base)) {
    fail('terminal receipt is foreign');
  }
  return immutable({ ...base, terminalReceiptDigest: value.terminalReceiptDigest });
}

function buildRunResult(rawAuthority, command, state, rawTerminalReceipt = null, requestDigestOverride = null) {
  const authority = assertAuthority(rawAuthority);
  if (![COMMANDS.EXECUTE, COMMANDS.RECONCILE].includes(command) || !STATES.includes(state)) {
    fail('run result command/state invalid');
  }
  const terminalReceipt = state === 'UNKNOWN'
    ? (rawTerminalReceipt === null ? null : fail('UNKNOWN cannot carry terminal authority'))
    : assertTerminalReceipt(rawTerminalReceipt, authority, requestDigestOverride);
  if (terminalReceipt && terminalReceipt.state !== state) fail('run result state mismatch');
  return immutable({
    schema: SCHEMAS.RUN_RESULT,
    command,
    state,
    operationId: authority.request.operationId,
    requestDigest: requestDigestOverride || requestDigest(authority),
    terminalReceipt,
    errorCode: state === 'UNKNOWN' ? ERROR_CODES.UNKNOWN : null,
  });
}

function assertRunResult(raw, rawAuthority, expectedCommand, requestDigestOverride = null) {
  const value = valuesOf(raw, KEYS.RUN_RESULT, 'run result');
  const expected = buildRunResult(
    rawAuthority,
    expectedCommand,
    value.state,
    value.terminalReceipt,
    requestDigestOverride
  );
  for (const key of KEYS.RUN_RESULT) {
    if (key === 'terminalReceipt') continue;
    if (value[key] !== expected[key]) fail('run result is foreign or cross-command');
  }
  return expected;
}

function buildVerifyRequest(rawAuthority, rawTerminalReceipt) {
  const authority = assertAuthority(rawAuthority);
  return immutable({
    schema: SCHEMAS.VERIFY_REQUEST,
    command: COMMANDS.VERIFY,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    terminalReceipt: assertTerminalReceipt(rawTerminalReceipt, authority),
  });
}

function assertVerifyRequest(raw, rawAuthority) {
  const value = valuesOf(raw, KEYS.VERIFY_REQUEST, 'verify request');
  const expected = buildVerifyRequest(rawAuthority, value.terminalReceipt);
  for (const key of KEYS.VERIFY_REQUEST) {
    if (key === 'terminalReceipt') continue;
    if (value[key] !== expected[key]) fail('verify request is foreign');
  }
  return expected;
}

function buildVerifyResult(rawAuthority, state, rawTerminalReceipt = null) {
  const authority = assertAuthority(rawAuthority);
  if (!STATES.includes(state)) fail('verify state invalid');
  const terminal = state === 'UNKNOWN'
    ? (rawTerminalReceipt === null ? null : fail('UNKNOWN verify cannot carry terminal authority'))
    : assertTerminalReceipt(rawTerminalReceipt, authority);
  if (terminal && terminal.state !== state) fail('verify state mismatch');
  return immutable({
    schema: SCHEMAS.VERIFY_RESULT,
    command: COMMANDS.VERIFY,
    state,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    terminalReceiptDigest: terminal?.terminalReceiptDigest || null,
    errorCode: state === 'UNKNOWN' ? ERROR_CODES.UNKNOWN : null,
  });
}

function assertVerifyResult(raw, rawAuthority, rawTerminalReceipt = null) {
  const value = valuesOf(raw, KEYS.VERIFY_RESULT, 'verify result');
  const expected = buildVerifyResult(rawAuthority, value.state, rawTerminalReceipt);
  for (const key of KEYS.VERIFY_RESULT) {
    if (value[key] !== expected[key]) fail('verify result is foreign');
  }
  return expected;
}

function buildFinalizeRequest(rawAuthority, rawTerminalReceipt) {
  const authority = assertAuthority(rawAuthority);
  return immutable({
    schema: SCHEMAS.FINALIZE_REQUEST,
    command: COMMANDS.FINALIZE,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    terminalReceipt: assertTerminalReceipt(rawTerminalReceipt, authority),
  });
}

function assertFinalizeRequest(raw, rawAuthority) {
  const value = valuesOf(raw, KEYS.FINALIZE_REQUEST, 'finalize request');
  const expected = buildFinalizeRequest(rawAuthority, value.terminalReceipt);
  for (const key of KEYS.FINALIZE_REQUEST) {
    if (key === 'terminalReceipt') continue;
    if (value[key] !== expected[key]) fail('finalize request is foreign');
  }
  return expected;
}

function buildFinalRecord(rawFinalizeRequest, rawAuthority) {
  const authority = assertAuthority(rawAuthority);
  const request = assertFinalizeRequest(rawFinalizeRequest, authority);
  const terminal = request.terminalReceipt;
  const base = {
    schema: SCHEMAS.FINAL_RECORD,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    terminalState: terminal.state,
    terminalReceiptDigest: terminal.terminalReceiptDigest,
    receiptSetDigest: terminal.receiptSetDigest,
    itemCount: terminal.items.length,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...base,
    finalRecordDigest: canonicalDigest(SCHEMAS.FINAL_RECORD, base),
  });
}

function assertFinalRecord(raw, rawFinalizeRequest, rawAuthority) {
  const value = valuesOf(raw, KEYS.FINAL_RECORD, 'final record');
  const expected = buildFinalRecord(rawFinalizeRequest, rawAuthority);
  for (const key of KEYS.FINAL_RECORD) {
    if (value[key] !== expected[key]) fail('final record is foreign');
  }
  return expected;
}

function encodeFinalRecord(raw, rawFinalizeRequest, rawAuthority) {
  const value = assertFinalRecord(raw, rawFinalizeRequest, rawAuthority);
  return boundedWire([[
    value.schema, value.operationId, value.requestDigest, value.terminalState,
    value.terminalReceiptDigest, value.receiptSetDigest, String(value.itemCount),
    '1', value.finalRecordDigest,
  ].join('\t')], LIMITS.maxFinalRecordBytes, 'existing final record');
}

function finalRecordName(rawFinalizeRequest, rawAuthority) {
  const record = buildFinalRecord(rawFinalizeRequest, rawAuthority);
  return `.changes-history-native-existing-final.${canonicalDigest(SCHEMAS.FINAL_KEY, {
    schema: SCHEMAS.FINAL_KEY,
    operationId: record.operationId,
    requestDigest: record.requestDigest,
    terminalReceiptDigest: record.terminalReceiptDigest,
  }).slice('sha256:'.length)}`;
}

// WRCCHRJ2 single-authority finalize: the CAS-installed EXISTING terminal
// publication already binds requestDigest + the terminal digests, so the
// finalize can be driven from the publication alone (the native finalize
// seals exactly those digests). The phase object is not recoverable after the
// marker transitions (updatedAt moves), so the authority is not rebuilt here.
function buildFinalRecordFromPublication(rawPublication) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  const base = {
    schema: SCHEMAS.FINAL_RECORD,
    operationId: publication.operationId,
    requestDigest: publication.requestDigest,
    terminalState: 'COMMITTED',
    terminalReceiptDigest: publication.terminalReceiptDigest,
    receiptSetDigest: publication.receiptSetDigest,
    itemCount: publication.items.length,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...base,
    finalRecordDigest: canonicalDigest(SCHEMAS.FINAL_RECORD, base),
  });
}

function finalRecordNameFromPublication(rawPublication) {
  const record = buildFinalRecordFromPublication(rawPublication);
  return `.changes-history-native-existing-final.${canonicalDigest(SCHEMAS.FINAL_KEY, {
    schema: SCHEMAS.FINAL_KEY,
    operationId: record.operationId,
    requestDigest: record.requestDigest,
    terminalReceiptDigest: record.terminalReceiptDigest,
  }).slice('sha256:'.length)}`;
}

function encodeFinalizePublicationCommand(rawPublication) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  const record = buildFinalRecordFromPublication(publication);
  return boundedWire([[
    COMMANDS.FINALIZE, 'PUBLISH', record.operationId, record.requestDigest,
    record.terminalState, record.terminalReceiptDigest, record.receiptSetDigest,
    String(record.itemCount),
  ].join('\t')], LIMITS.maxRequestBytes, 'publication finalize request');
}

function encodeFinalRecordFromPublication(rawPublication) {
  const record = buildFinalRecordFromPublication(rawPublication);
  return boundedWire([[
    record.schema, record.operationId, record.requestDigest, record.terminalState,
    record.terminalReceiptDigest, record.receiptSetDigest, String(record.itemCount),
    '1', record.finalRecordDigest,
  ].join('\t')], LIMITS.maxFinalRecordBytes, 'existing final record');
}

function buildFinalResult(
  rawAuthority,
  rawFinalizeRequest,
  state,
  rawFinalRecord = null,
  rawFinalRecordIdentity = null
) {
  const authority = assertAuthority(rawAuthority);
  if (!['COMMITTED', 'UNKNOWN'].includes(state)) fail('final result state invalid');
  const finalRecord = state === 'COMMITTED'
    ? assertFinalRecord(rawFinalRecord, rawFinalizeRequest, authority)
    : (rawFinalRecord === null ? null : fail('UNKNOWN final result cannot carry record'));
  const finalRecordIdentity = state === 'COMMITTED'
    ? assertPrivateRecordIdentity(
      rawFinalRecordIdentity,
      encodeFinalRecord(finalRecord, rawFinalizeRequest, authority),
      'finalRecordIdentity'
    )
    : (rawFinalRecordIdentity === null ? null : fail('UNKNOWN final result cannot carry identity'));
  return immutable({
    schema: SCHEMAS.FINAL_RESULT,
    command: COMMANDS.FINALIZE,
    state,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    finalRecord,
    finalRecordIdentity,
    errorCode: state === 'UNKNOWN' ? ERROR_CODES.UNKNOWN : null,
  });
}

function assertFinalResult(raw, rawAuthority, rawFinalizeRequest) {
  const value = valuesOf(raw, KEYS.FINAL_RESULT, 'final result');
  const expected = buildFinalResult(
    rawAuthority,
    rawFinalizeRequest,
    value.state,
    value.finalRecord,
    value.finalRecordIdentity
  );
  for (const key of KEYS.FINAL_RESULT) {
    if (['finalRecord', 'finalRecordIdentity'].includes(key)) continue;
    if (value[key] !== expected[key]) fail('final result is foreign');
  }
  return expected;
}

function buildAckRequest(
  rawAuthority,
  rawFinalizeRequest,
  rawFinalRecordIdentity,
  markerPhaseDigest
) {
  const authority = assertAuthority(rawAuthority);
  const finalRecord = buildFinalRecord(rawFinalizeRequest, authority);
  return immutable({
    schema: SCHEMAS.ACK_REQUEST,
    command: COMMANDS.FINALIZE,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    finalBasename: finalRecordName(rawFinalizeRequest, authority),
    finalRecordDigest: finalRecord.finalRecordDigest,
    finalRecordIdentity: assertPrivateRecordIdentity(
      rawFinalRecordIdentity,
      encodeFinalRecord(finalRecord, rawFinalizeRequest, authority),
      'finalRecordIdentity'
    ),
    markerPhaseDigest: digest(markerPhaseDigest, 'markerPhaseDigest'),
  });
}

function assertAckRequest(
  raw,
  rawAuthority,
  rawFinalizeRequest,
  expectedMarkerPhaseDigest
) {
  const value = valuesOf(raw, KEYS.ACK_REQUEST, 'ACK request');
  const expected = buildAckRequest(
    rawAuthority,
    rawFinalizeRequest,
    value.finalRecordIdentity,
    expectedMarkerPhaseDigest
  );
  for (const key of KEYS.ACK_REQUEST) {
    if (key === 'finalRecordIdentity') continue;
    if (value[key] !== expected[key]) fail('ACK request is foreign');
  }
  return expected;
}

function buildAckResult(rawAuthority, rawFinalizeRequest, state) {
  const authority = assertAuthority(rawAuthority);
  if (!['ACKED', 'UNKNOWN'].includes(state)) fail('ACK state invalid');
  return immutable({
    schema: SCHEMAS.ACK_RESULT,
    command: COMMANDS.FINALIZE,
    state,
    operationId: authority.request.operationId,
    requestDigest: requestDigest(authority),
    finalRecordDigest: buildFinalRecord(rawFinalizeRequest, authority).finalRecordDigest,
    errorCode: state === 'UNKNOWN' ? ERROR_CODES.UNKNOWN : null,
  });
}

function assertAckResult(raw, rawAuthority, rawFinalizeRequest) {
  const value = valuesOf(raw, KEYS.ACK_RESULT, 'ACK result');
  const expected = buildAckResult(rawAuthority, rawFinalizeRequest, value.state);
  for (const key of KEYS.ACK_RESULT) {
    if (value[key] !== expected[key]) fail('ACK result is foreign');
  }
  return expected;
}

function hexUtf8(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function boundedWire(lines, maximum, label) {
  const wire = `${lines.join('\n')}\n`;
  for (const line of lines) {
    if (Buffer.byteLength(`${line}\n`, 'utf8') > LIMITS.maxLineBytes) {
      fail(`${label} line exceeds budget`);
    }
  }
  if (Buffer.byteLength(wire, 'utf8') > maximum) fail(`${label} exceeds budget`);
  return wire;
}

function assertResponseEnvelope(stdout, stderr = Buffer.alloc(0)) {
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'utf8');
  const errors = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '', 'utf8');
  if (errors.length !== 0 || output.length === 0 ||
      output.length > LIMITS.maxResponseBytes || output.includes(0) ||
      output[output.length - 1] !== 0x0a || output.some(byte => byte > 0x7f)) {
    fail('native response envelope is invalid');
  }
  const lines = output.toString('ascii').slice(0, -1).split('\n');
  if (lines.length > LIMITS.maxItems + 2 || lines.some(line =>
    !line || Buffer.byteLength(line, 'ascii') > LIMITS.maxLineBytes)) {
    fail('native response line budget is invalid');
  }
  return output.toString('ascii');
}

function identityWireFields(raw, label) {
  const value = assertRecordIdentity(raw, label);
  return [
    value.schema, value.dev, value.ino, String(value.uid), String(value.mode),
    String(value.nlink), value.size, value.mtimeNs, value.ctimeNs,
    value.contentSha256,
  ];
}

function canonicalWireInteger(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${label} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function identityFromWire(fields, offset, label) {
  if (fields.length < offset + 10) fail(`${label} wire is truncated`);
  return assertRecordIdentity({
    schema: fields[offset], dev: fields[offset + 1], ino: fields[offset + 2],
    uid: canonicalWireInteger(fields[offset + 3], `${label}.uid`),
    mode: canonicalWireInteger(fields[offset + 4], `${label}.mode`),
    nlink: canonicalWireInteger(fields[offset + 5], `${label}.nlink`),
    size: fields[offset + 6],
    mtimeNs: fields[offset + 7], ctimeNs: fields[offset + 8],
    contentSha256: fields[offset + 9],
  }, label);
}

function encodeRunResponse(rawResult, rawAuthority, expectedCommand) {
  const authority = assertAuthority(rawAuthority);
  const result = assertRunResult(rawResult, authority, expectedCommand);
  const terminal = result.terminalReceipt;
  const lines = [[
    expectedCommand, 'RESULT', result.state, result.operationId,
    result.requestDigest, terminal?.markerDigest || '-', terminal?.artifactDigest || '-',
    terminal?.createdReceiptPhaseDigest || '-', terminal?.selectionDigest || '-',
    terminal?.baseHistoryDigest || '-', terminal?.receiptSetDigest || '-',
    terminal?.terminalReceiptDigest || '-', String(terminal?.items.length || 0),
    result.errorCode || '-',
  ].join('\t')];
  if (terminal) {
    terminal.items.forEach(item => {
      if (terminal.state !== 'COMMITTED' || item.applyToken === null || item.rollbackToken !== null) {
        fail('only COMMITTED apply-token response wire is frozen');
      }
      const token = item.applyToken;
      lines.push([
        'T', item.selectedId, item.finalContentDigest, item.finalLeafIdentityDigest,
        token.controlBasename, token.receiptBasename, token.controlDigest,
        token.applyReceiptDigest, token.afterLeafIdentityDigest,
        ...identityWireFields(token.controlRecordIdentity, 'controlRecordIdentity'),
        ...identityWireFields(token.receiptRecordIdentity, 'receiptRecordIdentity'),
      ].join('\t'));
      if (Buffer.byteLength(`${lines[lines.length - 1]}\n`, 'ascii') > LIMITS.maxRunItemBytes) {
        fail('run response item exceeds budget');
      }
    });
  }
  return `P\tOK\n${boundedWire(lines, LIMITS.maxResponseBytes, 'run response')}`;
}

function parseRunResponse(stdout, rawAuthority, expectedCommand, rawStoredRequestDigest = null) {
  const authority = assertAuthority(rawAuthority);
  const storedRequestDigest = expectedCommand === COMMANDS.RECONCILE
    ? digest(rawStoredRequestDigest, 'fresh R stored request digest')
    : null;
  const expectedRequestDigest = storedRequestDigest || requestDigest(authority);
  const envelope = assertResponseEnvelope(stdout);
  const lines = envelope.slice(0, -1).split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length === 0) fail('run response bind missing');
  const header = lines.shift().split('\t');
  if (header.length !== 14 || header[0] !== expectedCommand || header[1] !== 'RESULT' ||
      !STATES.includes(header[2]) || header[3] !== authority.request.operationId ||
      header[4] !== expectedRequestDigest || !/^(0|[1-9][0-9]*)$/.test(header[12])) {
    fail('run response header invalid');
  }
  const count = Number(header[12]);
  if (!Number.isSafeInteger(count) || count !== lines.length || count > LIMITS.maxItems) {
    fail('run response item count invalid');
  }
  if (header[2] === 'UNKNOWN') {
    if (count !== 0 || header.slice(5, 12).some(value => value !== '-') ||
        header[13] !== ERROR_CODES.UNKNOWN) fail('UNKNOWN response authority invalid');
    return buildRunResult(authority, expectedCommand, 'UNKNOWN', null, storedRequestDigest);
  }
  if (!['COMMITTED', 'UNCOMMITTED'].includes(header[2]) ||
      count !== authority.request.items.length || header[13] !== '-') {
    fail('terminal response state invalid');
  }
  if (header[2] === 'UNCOMMITTED') {
    const rollbackTokens = lines.map((line, index) => {
      const fields = line.split('\t');
      if (Buffer.byteLength(`${line}\n`, 'ascii') > LIMITS.maxRunItemBytes ||
          fields.length !== 31 || fields[0] !== 'T') fail('rollback terminal item invalid');
      const rollback = buildRollbackToken(
        authority,
        index,
        buildRollbackReceipt(authority, index, fields[3]),
        identityFromWire(fields, 9, 'controlRecordIdentity'),
        identityFromWire(fields, 19, 'rollbackReceiptRecordIdentity')
      );
      if (fields[1] !== authority.request.items[index].selectedId ||
          fields[2] !== authority.request.items[index].beforeContentDigest ||
          fields[3] !== rollback.restoredLeafIdentityDigest ||
          fields[4] !== rollback.controlBasename ||
          fields[5] !== rollback.receiptBasename ||
          fields[6] !== rollback.controlDigest ||
          fields[7] !== rollback.rollbackReceiptDigest) {
        fail('rollback terminal item is foreign');
      }
      return rollback;
    });
    const terminal = buildTerminalReceipt(authority, 'UNCOMMITTED', rollbackTokens);
    if ([terminal.markerDigest, terminal.artifactDigest, terminal.createdReceiptPhaseDigest,
      terminal.selectionDigest, terminal.baseHistoryDigest, terminal.receiptSetDigest,
      terminal.terminalReceiptDigest].some((value, index) => value !== header[index + 5])) {
      fail('rollback terminal digest authority invalid');
    }
    return buildRunResult(authority, expectedCommand, 'UNCOMMITTED', terminal);
  }
  const tokens = lines.map((line, index) => {
    const fields = line.split('\t');
    if (Buffer.byteLength(`${line}\n`, 'ascii') > LIMITS.maxRunItemBytes ||
        fields.length !== 29 || fields[0] !== 'T') fail('terminal response item invalid');
    const receipt = buildApplyReceipt(authority, index, fields[8]);
    const token = buildApplyToken(
      authority, index, receipt,
      identityFromWire(fields, 9, 'controlRecordIdentity'),
      identityFromWire(fields, 19, 'receiptRecordIdentity'),
      storedRequestDigest
    );
    if (fields[1] !== authority.request.items[index].selectedId ||
        fields[2] !== authority.request.items[index].afterContentDigest ||
        fields[3] !== token.afterLeafIdentityDigest || fields[4] !== token.controlBasename ||
        fields[5] !== token.receiptBasename || fields[6] !== token.controlDigest ||
        fields[7] !== token.applyReceiptDigest) fail('terminal response item is foreign');
    return token;
  });
  const terminal = buildTerminalReceipt(
    authority, 'COMMITTED', tokens, storedRequestDigest
  );
  if ([terminal.markerDigest, terminal.artifactDigest, terminal.createdReceiptPhaseDigest,
    terminal.selectionDigest, terminal.baseHistoryDigest, terminal.receiptSetDigest,
    terminal.terminalReceiptDigest].some((value, index) => value !== header[index + 5])) {
    fail('terminal response digest authority invalid');
  }
  return buildRunResult(
    authority, expectedCommand, 'COMMITTED', terminal, storedRequestDigest
  );
}

function encodeExistingCommand(rawAuthority, command, rawReconcileIdentities = null, rawPublicationMarkerDigest = null, rawStoredRequestDigest = null) {
  const authority = assertAuthority(rawAuthority);
  const request = authority.request;
  const binding = assertExistingJournalBinding(request.journalMarkerBinding);
  const head = binding.head;
  if (![COMMANDS.EXECUTE, COMMANDS.RECONCILE].includes(command)) {
    fail('existing command is invalid');
  }
  const reconcile = command === COMMANDS.RECONCILE;
  const wireRequestDigest = reconcile
    ? digest(rawStoredRequestDigest, 'fresh R stored request digest')
    : requestDigest(authority);
  if (reconcile) {
    if (!Array.isArray(rawReconcileIdentities) ||
        rawReconcileIdentities.length !== request.items.length ||
        typeof rawPublicationMarkerDigest !== 'string') {
      fail('fresh R requires the stored publication identities and marker digest');
    }
    digest(rawPublicationMarkerDigest, 'fresh R publication marker digest');
  }
  const lines = [[
    command, request.operationId, wireRequestDigest, binding.bindingDigest,
    binding.journalBasename, binding.journalMagic, binding.activeSlot,
    head.journalId, head.generation, binding.previousValueDigest || '-', head.valueDigest,
    String(binding.frameByteLength), binding.frameSha256,
    String(binding.payloadOffset), String(binding.payloadByteLength), binding.payloadSha256,
    String(binding.activeMarkerOffset), String(binding.activeMarkerByteLength),
    binding.activeMarkerDigest, binding.activeMarkerCanonicalSha256,
    binding.rootIdentityDigest, binding.recoveryDirectoryIdentityDigest,
    // Held-descriptor authorities the native helper verifies against its
    // artifact/history fds: the journal binding is the marker authority; these
    // fields carry the artifact/selection/base-history authorities that the
    // recovery marker itself does not (it only carries artifactDigest via the
    // public-markdown phase).
    request.artifactDigest, request.artifactIdentityDigest, String(request.artifactByteLength),
    request.createdReceiptPhaseDigest, request.selectionDigest,
    request.baseHistoryDigest, String(request.baseHistoryByteLength),
    request.baseHistoryExists ? '1' : '0',
    request.baseHistoryExists ? request.baseHistoryContentDigest : '-',
    request.historyParentIdentityDigest,
    String(request.items.length),
  ].join('\t')];
  for (let index = 0; index < request.items.length; index += 1) {
    const item = request.items[index];
    const itemLine = [
      'I', item.selectedId, hexUtf8(item.path), item.beforeRevision, item.afterRevision,
      String(item.beforeArtifactOffset), String(item.beforeByteLength),
      item.beforeContentDigest, String(item.afterArtifactOffset),
      String(item.afterByteLength), item.afterContentDigest,
      item.ancestorIdentityDigest, item.beforeLeafIdentityDigest,
    ];
    if (reconcile) {
      // Fresh R carries the E-time stored publication identities (control then
      // apply) plus the E-time publication marker digest so the native reopen
      // never recaptures identity or marker from current records; any same-byte
      // new inode, same-inode rewrite or digest drift is UNKNOWN.
      const stored = rawReconcileIdentities[index];
      if (!stored || typeof stored !== 'object' || stored === null) {
        fail('fresh R stored identity is invalid');
      }
      itemLine.push(
        ...identityWireFields(stored.controlRecordIdentity, 'reconcile control identity'),
        ...identityWireFields(stored.applyRecordIdentity, 'reconcile apply identity'),
        rawPublicationMarkerDigest
      );
    }
    lines.push(itemLine.join('\t'));
  }
  return boundedWire(
    lines,
    LIMITS.maxRequestBytes,
    command === COMMANDS.EXECUTE ? 'execute request' : 'reconcile request'
  );
}

function encodeExecuteCommand(rawAuthority) {
  return encodeExistingCommand(rawAuthority, COMMANDS.EXECUTE);
}

function encodeReconcileCommand(rawAuthority, rawReconcileIdentities, rawPublicationMarkerDigest, rawStoredRequestDigest) {
  return encodeExistingCommand(
    rawAuthority,
    COMMANDS.RECONCILE,
    rawReconcileIdentities,
    rawPublicationMarkerDigest,
    rawStoredRequestDigest
  );
}

function encodeVerifyCommand(rawAuthority, rawTerminalReceipt) {
  const request = buildVerifyRequest(rawAuthority, rawTerminalReceipt);
  return boundedWire([[
    COMMANDS.VERIFY, request.operationId, request.requestDigest,
    request.terminalReceipt.state, request.terminalReceipt.terminalReceiptDigest,
    request.terminalReceipt.receiptSetDigest, String(request.terminalReceipt.items.length),
  ].join('\t')], LIMITS.maxRequestBytes, 'verify request');
}

function encodeFinalizeCommand(rawAuthority, rawTerminalReceipt) {
  const request = buildFinalizeRequest(rawAuthority, rawTerminalReceipt);
  return boundedWire([[
    COMMANDS.FINALIZE, 'PUBLISH', request.operationId, request.requestDigest,
    request.terminalReceipt.state, request.terminalReceipt.terminalReceiptDigest,
    request.terminalReceipt.receiptSetDigest, String(request.terminalReceipt.items.length),
  ].join('\t')], LIMITS.maxRequestBytes, 'finalize request');
}

function encodeAckCommand(rawAckRequest, rawAuthority, rawFinalizeRequest, markerPhaseDigest) {
  const request = assertAckRequest(
    rawAckRequest,
    rawAuthority,
    rawFinalizeRequest,
    markerPhaseDigest
  );
  return boundedWire([[
    COMMANDS.FINALIZE, 'ACK', request.operationId, request.requestDigest,
    request.finalBasename, request.finalRecordDigest, request.markerPhaseDigest,
    request.finalRecordIdentity.dev, request.finalRecordIdentity.ino,
    String(request.finalRecordIdentity.uid), String(request.finalRecordIdentity.mode),
    String(request.finalRecordIdentity.nlink), request.finalRecordIdentity.size,
    request.finalRecordIdentity.mtimeNs, request.finalRecordIdentity.ctimeNs,
    request.finalRecordIdentity.contentSha256,
  ].join('\t')], LIMITS.maxRequestBytes, 'ACK request');
}

// One descriptor-exact production bundle keeps the canonical record inputs and
// their bounded wire bytes together for cross-language/native parity checks.
// It does not grant mutation authority or infer a terminal state.
function buildCanonicalBundle(rawAuthority, rawTerminalReceipt) {
  const authority = assertAuthority(rawAuthority);
  const terminal = assertTerminalReceipt(rawTerminalReceipt, authority);
  const records = authority.request.items.map((_item, index) => {
    const control = buildControl(authority, index);
    const terminalItem = terminal.items[index];
    const applyReceipt = terminalItem.applyToken === null
      ? null
      : buildApplyReceipt(
        authority,
        index,
        terminalItem.applyToken.afterLeafIdentityDigest
      );
    return immutable({
      selectedId: authority.request.items[index].selectedId,
      names: recordNames(authority, index),
      control,
      controlRecord: encodeControlRecord(control, authority, index),
      applyReceipt,
      applyRecord: applyReceipt === null
        ? null
        : encodeApplyReceiptRecord(applyReceipt, authority, index),
    });
  });
  return immutable({
    requestDigest: requestDigest(authority),
    terminalState: terminal.state,
    terminalReceiptDigest: terminal.terminalReceiptDigest,
    receiptSetDigest: terminal.receiptSetDigest,
    records: immutable(records),
  });
}

// Parse the native EXISTING finalize (F) response. The C seals the terminal
// with an owner-private final record and reports its exact identity.
function parseFinalizeResponse(stdout, rawAuthority, rawFinalizeRequest) {
  const authority = assertAuthority(rawAuthority);
  const request = assertFinalizeRequest(rawFinalizeRequest, authority);
  const envelope = assertResponseEnvelope(stdout);
  const lines = envelope.slice(0, -1).split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length === 0) fail('finalize response bind missing');
  const header = lines.shift().split('\t');
  if (header.length !== 18 || header[0] !== COMMANDS.FINALIZE || header[1] !== 'RESULT' ||
      header[3] !== authority.request.operationId ||
      header[4] !== requestDigest(authority)) {
    fail('finalize response header invalid');
  }
  if (header[2] === 'UNKNOWN') {
    if (header.slice(5).some(value => value !== '-')) fail('UNKNOWN finalize authority invalid');
    return buildFinalResult(authority, request, 'UNKNOWN');
  }
  if (header[2] !== 'COMMITTED') fail('finalize response state invalid');
  const finalRecord = buildFinalRecord(request, authority);
  if (header[5] !== finalRecord.finalRecordDigest ||
      header[6] !== finalRecordName(request, authority) ||
      header[7] !== finalRecord.terminalState ||
      header[8] !== finalRecord.terminalReceiptDigest) {
    fail('finalize response record authority invalid');
  }
  const finalWire = encodeFinalRecord(finalRecord, request, authority);
  const finalRecordIdentity = assertPrivateRecordIdentity({
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: header[9], ino: header[10],
    uid: canonicalWireInteger(header[11], 'finalRecordIdentity.uid'),
    mode: canonicalWireInteger(header[12], 'finalRecordIdentity.mode'),
    nlink: canonicalWireInteger(header[13], 'finalRecordIdentity.nlink'),
    size: header[14],
    mtimeNs: header[15], ctimeNs: header[16],
    contentSha256: header[17],
  }, finalWire, 'finalRecordIdentity');
  return buildFinalResult(authority, request, 'COMMITTED', finalRecord, finalRecordIdentity);
}

// Publication-driven finalize parse: same native envelope, rebuilt from the
// CAS-installed publication instead of a reconstructed authority.
function parseFinalizePublicationResponse(stdout, rawPublication) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  const envelope = assertResponseEnvelope(stdout);
  const lines = envelope.slice(0, -1).split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length === 0) fail('finalize response bind missing');
  const header = lines.shift().split('\t');
  if (header.length !== 18 || header[0] !== COMMANDS.FINALIZE || header[1] !== 'RESULT' ||
      header[3] !== publication.operationId ||
      header[4] !== publication.requestDigest) {
    fail('finalize response header invalid');
  }
  if (header[2] === 'UNKNOWN') {
    if (header.slice(5).some(value => value !== '-')) fail('UNKNOWN finalize authority invalid');
    return buildFinalResultFromPublication(publication, 'UNKNOWN');
  }
  if (header[2] !== 'COMMITTED') fail('finalize response state invalid');
  const finalRecord = buildFinalRecordFromPublication(publication);
  const finalWire = encodeFinalRecordFromPublication(publication);
  if (header[5] !== finalRecord.finalRecordDigest ||
      header[6] !== finalRecordNameFromPublication(publication) ||
      header[7] !== finalRecord.terminalState ||
      header[8] !== finalRecord.terminalReceiptDigest) {
    fail('finalize response record authority invalid');
  }
  const finalRecordIdentity = assertPrivateRecordIdentity({
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: header[9], ino: header[10],
    uid: canonicalWireInteger(header[11], 'finalRecordIdentity.uid'),
    mode: canonicalWireInteger(header[12], 'finalRecordIdentity.mode'),
    nlink: canonicalWireInteger(header[13], 'finalRecordIdentity.nlink'),
    size: header[14],
    mtimeNs: header[15], ctimeNs: header[16],
    contentSha256: header[17],
  }, finalWire, 'finalRecordIdentity');
  return buildFinalResultFromPublication(
    publication,
    'COMMITTED',
    finalRecord,
    finalRecordIdentity
  );
}

function buildFinalResultFromPublication(
  rawPublication,
  state,
  rawFinalRecord = null,
  rawFinalRecordIdentity = null
) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  if (!['COMMITTED', 'UNKNOWN'].includes(state)) fail('final result state invalid');
  const finalRecord = state === 'COMMITTED'
    ? buildFinalRecordFromPublication(publication)
    : null;
  const finalRecordIdentity = state === 'COMMITTED'
    ? assertPrivateRecordIdentity(
      rawFinalRecordIdentity,
      encodeFinalRecordFromPublication(publication),
      'finalRecordIdentity'
    )
    : null;
  return immutable({
    schema: SCHEMAS.FINAL_RESULT,
    command: COMMANDS.FINALIZE,
    state,
    operationId: publication.operationId,
    requestDigest: publication.requestDigest,
    finalRecord: state === 'COMMITTED' ? finalRecord : null,
    finalRecordIdentity,
    errorCode: state === 'UNKNOWN' ? ERROR_CODES.UNKNOWN : null,
  });
}

function encodeAckPublicationCommand(rawPublication, markerPhaseDigest) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  const finalization = publication.finalization;
  const identity = finalization.finalRecordIdentity;
  return boundedWire([[
    COMMANDS.FINALIZE, 'ACK', publication.operationId, publication.requestDigest,
    finalization.finalBasename, finalization.finalRecordDigest,
    digest(markerPhaseDigest, 'markerPhaseDigest'),
    identity.dev, identity.ino, String(identity.uid), String(identity.mode),
    String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
    identity.contentSha256,
  ].join('\t')], LIMITS.maxRequestBytes, 'publication ACK request');
}

function parseAckPublicationResponse(stdout, rawPublication) {
  const publication = markerJournalSchema.assertExistingTerminalPublication(rawPublication);
  const envelope = assertResponseEnvelope(stdout);
  const lines = envelope.slice(0, -1).split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length === 0) fail('ACK response bind missing');
  const header = lines.shift().split('\t');
  if (header.length !== 6 || header[0] !== COMMANDS.FINALIZE || header[1] !== 'RESULT' ||
      header[2] !== 'ACKED' || header[3] !== publication.operationId ||
      header[4] !== publication.requestDigest ||
      header[5] !== publication.finalization.finalRecordDigest) {
    fail('ACK response header invalid');
  }
  return immutable({
    schema: SCHEMAS.ACK_RESULT,
    command: COMMANDS.FINALIZE,
    state: 'ACKED',
    operationId: publication.operationId,
    requestDigest: publication.requestDigest,
    finalRecordDigest: publication.finalization.finalRecordDigest,
    errorCode: null,
  });
}

// Parse the native EXISTING ACK (A) response.
function parseAckResponse(stdout, rawAuthority, rawFinalizeRequest) {
  const authority = assertAuthority(rawAuthority);
  const request = assertFinalizeRequest(rawFinalizeRequest, authority);
  const envelope = assertResponseEnvelope(stdout);
  const lines = envelope.slice(0, -1).split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length === 0) fail('ACK response bind missing');
  const header = lines.shift().split('\t');
  if (header.length !== 6 || header[0] !== COMMANDS.FINALIZE || header[1] !== 'RESULT' ||
      header[2] !== 'ACKED' || header[3] !== authority.request.operationId ||
      header[4] !== requestDigest(authority) ||
      header[5] !== buildFinalRecord(request, authority).finalRecordDigest) {
    fail('ACK response header invalid');
  }
  return buildAckResult(authority, request, 'ACKED');
}

module.exports = Object.freeze({
  METHODS,
  COMMANDS,
  STATES,
  SCHEMAS,
  LIMITS,
  ERROR_CODES,
  SnapshotExistingRestoreNativeSchemaError,
  buildBaseHistoryAuthority,
  digestHistoryParentIdentity,
  buildExistingLeafIdentity,
  assertExistingLeafIdentity,
  digestExistingLeafIdentity,
  buildExistingJournalBinding,
  assertExistingJournalBinding,
  digestExistingJournalBinding,
  assertMarkerAuthority,
  assertRequest,
  buildAuthority,
  assertAuthority,
  requestDigest,
  recordNames,
  buildControl,
  assertControl,
  buildApplyReceipt,
  assertApplyReceipt,
  buildRollbackReceipt,
  assertRollbackReceipt,
  buildApplyToken,
  assertApplyToken,
  buildRollbackToken,
  assertRollbackToken,
  receiptSetDigest,
  buildTerminalReceipt,
  assertTerminalReceipt,
  buildRunResult,
  assertRunResult,
  buildVerifyRequest,
  assertVerifyRequest,
  buildVerifyResult,
  assertVerifyResult,
  buildFinalizeRequest,
  assertFinalizeRequest,
  buildFinalRecord,
  assertFinalRecord,
  encodeFinalRecord,
  finalRecordName,
  buildFinalResult,
  assertFinalResult,
  buildAckRequest,
  assertAckRequest,
  buildAckResult,
  assertAckResult,
  encodeExecuteCommand,
  encodeReconcileCommand,
  encodeVerifyCommand,
  encodeFinalizeCommand,
  encodeAckCommand,
  buildCanonicalBundle,
  assertResponseEnvelope,
  encodeRunResponse,
  parseRunResponse,
  parseFinalizeResponse,
  parseFinalizePublicationResponse,
  parseAckResponse,
  buildFinalRecordFromPublication,
  finalRecordNameFromPublication,
  encodeFinalizePublicationCommand,
  encodeFinalRecordFromPublication,
  buildFinalResultFromPublication,
  encodeAckPublicationCommand,
  parseAckPublicationResponse,
  encodeControlRecord,
  encodeApplyReceiptRecord,
  encodeRollbackReceiptRecord,
});
