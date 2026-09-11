'use strict';

// Pure schema for the permanent Changes/History recovery journal. It owns no
// filesystem or process authority. The physical writer is deliberately kept
// out of this module so Main and native implementations must both reproduce
// the same descriptor-exact value and slot-frame contract.

const { TextDecoder } = require('util');
const evidence = require('./evidence-delivery-schema');

const SCHEMAS = Object.freeze({
  VALUE: 'writcraft.changes-history-marker-journal-value/v1',
  ACTIVE_MARKER: 'writcraft.changes-history-active-marker/v1',
  HEAD: 'writcraft.changes-history-marker-journal-head/v1',
  PUBLICATION: 'writcraft.changes-history-native-publication-authority/v1',
  RECORD: 'writcraft.changes-history-native-publication-record/v1',
  MUTATION: 'writcraft.changes-history-native-publication-mutation/v1',
  CREATE_CAPTURE: 'writcraft.changes-history-native-create-capture/v1',
  CREATE_CAPTURE_ITEM: 'writcraft.changes-history-native-create-capture-item/v1',
  CREATE_PRIVATE_RECORD: 'writcraft.changes-history-native-create-private-record/v1',
  CREATE_FINALIZATION: 'writcraft.changes-history-native-create-finalization/v1',
  EXISTING_TERMINAL_PUBLICATION:
    'writcraft.changes-history-existing-terminal-publication/v1',
  EXISTING_TERMINAL_ITEM:
    'writcraft.changes-history-existing-terminal-item/v1',
  EXISTING_FINALIZATION:
    'writcraft.changes-history-existing-terminal-finalization/v1',
  ROLLBACK_CREATE_PUBLICATION:
    'writcraft.changes-history-rollback-create-publication/v1',
  ROLLBACK_CREATE_ATTEMPT_PUBLICATION:
    'writcraft.changes-history-rollback-create-attempt-publication/v1',
  CLEANUP: 'writcraft.changes-history-terminal-cleanup-authority/v1',
  PUBLIC_RECORD_SET: 'writcraft.changes-history-terminal-public-record-set/v1',
  PUBLICATION_SET: 'writcraft.changes-history-terminal-publication-set/v1',
});
const RECOVERY_SCHEMA = 'writcraft.changes-history-recovery/v1';
const JOURNAL_MAGIC = 'WRCCHRJ2';
const JOURNAL_BASENAME = 'changes-history-transaction.json';
const SLOTS = Object.freeze(['A', 'B']);
const VALUE_STATES = Object.freeze(['IDLE', 'ACTIVE']);
const PUBLICATION_STATES = Object.freeze([
  'PREPARED', 'ARMED', 'COMMITTED', 'ACK_PREPARED', 'ACK_COMMITTED',
]);
const RECORD_STATES = Object.freeze(['ARMED', 'PUBLISHED', 'CLEANUP_ARMED', 'REMOVED']);
const MUTATION_STATES = Object.freeze(['UNARMED', 'ARMED', 'COMMITTED']);
const EXISTING_CLEANUP_STATES = Object.freeze([
  'PUBLISHED', 'CLEANUP_ARMED', 'REMOVED',
]);
const KINDS = Object.freeze([
  'apply', 'review', 'undo', 'snapshot_restore', 'snapshot_restore_undo',
]);
const PUBLICATION_KINDS = Object.freeze(['snapshot_restore', 'snapshot_restore_undo']);
const COMMANDS = Object.freeze([
  'QUARANTINE', 'RESTORE_QUARANTINE', 'FINALIZE_UNDO',
  'CREATE_MISSING', 'ROLLBACK_CREATE', 'FINALIZE_ROLLBACK_CREATE',
]);
const COMMANDS_BY_KIND = Object.freeze({
  snapshot_restore: Object.freeze([
    'CREATE_MISSING', 'ROLLBACK_CREATE', 'FINALIZE_ROLLBACK_CREATE',
  ]),
  snapshot_restore_undo: Object.freeze([
    'QUARANTINE', 'RESTORE_QUARANTINE', 'FINALIZE_UNDO',
  ]),
});
const MAX_RECORDS = 901;
const MAX_CREATE_CAPTURE_ITEMS = 300;
const MAX_EXISTING_TERMINAL_ITEMS = 299;
const MAX_EXISTING_TERMINAL_PUBLICATION_BYTES = 768 * 1024;
const MAX_VALUE_BYTES = 96 * 1024 * 1024;
const MAX_ACTIVE_MARKER_BYTES = MAX_VALUE_BYTES - (1024 * 1024);
const MAX_ACTIVE_MARKER_DEPTH = 64;
const MAX_ACTIVE_MARKER_NODES = 100000;
const MAX_HEADER_BYTES = 512;
const MAX_FRAME_BYTES = MAX_VALUE_BYTES + MAX_HEADER_BYTES + 1;
const SLOT_CAPACITY = MAX_FRAME_BYTES;
const SLOT_OFFSETS = Object.freeze({ A: 0, B: SLOT_CAPACITY });
const JOURNAL_ID_RE = /^chrj_[a-f0-9]{48}$/u;
const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/u;
const PRIVATE_BASENAME_RE = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const STAGE_BASENAME_RE = /^\.changes-history-native-stage\.[a-f0-9]{32}$/u;
const CREATE_CONTROL_BASENAME_RE = /^\.changes-history-native-create-control\.[a-f0-9]{64}$/u;
const CREATE_RECEIPT_BASENAME_RE = /^\.changes-history-native-create-receipt\.[a-f0-9]{64}$/u;
const CREATE_FINAL_BASENAME_RE = /^\.changes-history-native-create-final\.[a-f0-9]{64}$/u;
const CREATE_CLEANUP_BASENAME_RE = /^\.changes-history-native-create-cleanup\.[a-f0-9]{64}$/u;
const EXISTING_CONTROL_BASENAME_RE =
  /^\.changes-history-native-existing-control\.[a-f0-9]{64}$/u;
const EXISTING_APPLY_BASENAME_RE =
  /^\.changes-history-native-existing-apply\.[a-f0-9]{64}$/u;
const EXISTING_FINAL_BASENAME_RE =
  /^\.changes-history-native-existing-final\.[a-f0-9]{64}$/u;
const EXISTING_LEAF_IDENTITY_SCHEMA =
  'writcraft.public-markdown-existing-leaf-identity/v1';
const CREATE_FINALIZE_REQUEST_SCHEMA =
  'writcraft.changes-history-native-create-finalize-request/v1';
const CREATE_FINAL_ACK_SCHEMA = 'writcraft.changes-history-native-create-final-ack/v1';
const CREATE_TOKEN_SCHEMA = 'writcraft.changes-history-native-create-token/v1';
const CREATE_CLEANUP_NAME_KEY_SCHEMA =
  'writcraft.public-markdown-create-cleanup-name-key/v1';
const GENERATION_RE = /^(?:0|[1-9][0-9]{0,19})$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const MAX_GENERATION = (1n << 64n) - 1n;

const KEYS = Object.freeze({
  VALUE: Object.freeze([
    'schema', 'journalId', 'generation', 'previousValueDigest', 'state',
    'projectId', 'activeOperationId', 'activeKind', 'activeMarker', 'activeMarkerDigest',
    'nativePublication', 'existingTerminalPublication', 'rollbackCreatePublication',
    'terminalCleanup', 'terminalCleanupDigest', 'valueDigest',
  ]),
  HEAD: Object.freeze(['schema', 'journalId', 'generation', 'valueDigest']),
  PUBLICATION: Object.freeze([
    'schema', 'kind', 'command', 'state', 'operationId', 'requestDigest',
    'phaseDigest', 'previousPublicationDigest', 'records', 'mutation',
    'createAttemptDigest', 'createCapture', 'createFinalization',
    'createCleanupFinalBasename', 'createCleanupFinalRecordIdentity', 'publicationDigest',
  ]),
  RECORD: Object.freeze([
    'schema', 'role', 'ordinal', 'state', 'stageBasename',
    'destinationBasename', 'cleanupBasename', 'recordDigest', 'recordIdentity',
  ]),
  MUTATION: Object.freeze([
    'schema', 'state', 'sourceIdentityDigest', 'privateBasename',
    'directoryFsyncComplete',
  ]),
  CREATE_CAPTURE: Object.freeze(['schema', 'items']),
  CREATE_CAPTURE_ITEM: Object.freeze([
    'schema', 'ordinal', 'selectedId', 'path', 'contentDigest',
    'ancestorIdentityDigest', 'createdLeafIdentity', 'creationReceiptDigest',
    'control', 'receipt',
  ]),
  CREATE_PRIVATE_RECORD: Object.freeze([
    'schema', 'role', 'selectedId', 'path', 'contentDigest',
    'ancestorIdentityDigest', 'deterministicBasename', 'logicalDigest',
    'boundControlDigest', 'rawSha256', 'recordIdentity', 'state', 'cleanupBasename',
  ]),
  CREATE_FINALIZATION: Object.freeze([
    'schema', 'state', 'operationId', 'finalizeRequest', 'finalizeRequestDigest',
    'historyCommittedPhaseDigest', 'rawPreparedHistoryStateDigest',
    'artifactByteLength', 'artifactDigest', 'artifactIdentity',
    'committedPublicationDigest', 'createCaptureDigest', 'finalBasename',
    'finalAck', 'finalAckDigest', 'finalRecordIdentity',
    'previousFinalizationDigest', 'finalizationDigest',
  ]),
  EXISTING_TERMINAL_PUBLICATION: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'createdReceiptPhaseDigest', 'markerDigest', 'artifactDigest',
    'artifactIdentityDigest', 'selectionDigest', 'baseHistoryDigest',
    'baseHistoryByteLength', 'baseHistoryExists', 'baseHistoryContentDigest',
    'historyParentIdentityDigest', 'projectRootIdentityDigest',
    'recoveryDirectoryIdentityDigest', 'predecessorValueDigest',
    'installedGeneration', 'items', 'receiptSetDigest', 'terminalReceiptDigest',
    'recoveryFsyncComplete', 'finalization', 'publicationDigest',
  ]),
  EXISTING_TERMINAL_ITEM: Object.freeze([
    'schema', 'ordinal', 'selectedId', 'finalContentDigest', 'finalLeafIdentity',
    'controlBasename', 'controlDigest', 'controlRecordIdentity',
    'controlCleanupState', 'applyBasename', 'applyReceiptDigest',
    'applyRecordIdentity', 'applyCleanupState',
  ]),
  EXISTING_LEAF_IDENTITY: Object.freeze([
    'schema', 'selectedId', 'path', 'revision', 'ancestorIdentityDigest',
    'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    'contentSha256',
  ]),
  EXISTING_FINALIZATION: Object.freeze([
    'schema', 'finalizeRequestDigest', 'historyCommittedPhaseDigest',
    'finalBasename', 'finalRecordDigest', 'finalRecordIdentity',
    'markerFinalizedPhaseDigest', 'cleanupState', 'finalizationDigest',
  ]),
  ROLLBACK_CREATE_PUBLICATION: Object.freeze([
    'schema', 'state', 'operationId', 'requestDigest', 'authorityBase64',
    'quarantineResultBase64', 'settleResultBase64', 'publicationDigest',
  ]),
  ROLLBACK_CREATE_ATTEMPT_PUBLICATION: Object.freeze([
    'schema', 'state', 'operationId', 'requestDigest', 'authorityBase64',
    'predecessorValueDigest', 'installedGeneration', 'publicationDigest',
  ]),
  CLEANUP: Object.freeze([
    'schema', 'operationId', 'kind', 'terminalPhaseDigest', 'historyStateDigest',
    'artifactCleanupDigest', 'publicRecordDigests', 'publicRecordSetDigest', 'publicationState',
    'publicationDigest', 'existingTerminalPublicationState',
    'existingTerminalPublicationDigest', 'publicationSetDigest',
    'recoveryDirectoryFsyncComplete', 'cleanupDigest',
  ]),
  CLEANUP_BUILD: Object.freeze([
    'schema', 'operationId', 'kind', 'terminalPhaseDigest', 'historyStateDigest',
    'artifactCleanupDigest', 'publicRecordDigests', 'publicationState',
    'publicationDigest', 'existingTerminalPublicationState',
    'existingTerminalPublicationDigest', 'recoveryDirectoryFsyncComplete',
  ]),
  PUBLICATION_SET: Object.freeze([
    'schema', 'operationId', 'kind', 'nativePublicationDigest',
    'existingTerminalPublicationDigest',
  ]),
});
const ACTIVE_MARKER_REQUIRED_KEYS = Object.freeze([
  'schema', 'operationId', 'projectId', 'kind', 'state', 'outcome', 'files',
  'baseHistoryState', 'preparedHistoryState', 'recoveryWritePending',
  'createdAt', 'updatedAt', 'integrity',
]);
const ACTIVE_MARKER_OPTIONAL_KEYS = Object.freeze([
  'artifact', 'parentSelectionBinding', 'publicMarkdownPhase', 'artifactCleanup',
  'publicMarkdownUndoSettlement', 'publicMarkdownUndoFinalization',
]);

class ChangesHistoryMarkerJournalSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangesHistoryMarkerJournalSchemaError';
    this.code = 'INVALID_CHANGES_HISTORY_MARKER_JOURNAL';
  }
}

function fail(message) {
  throw new ChangesHistoryMarkerJournalSchemaError(message);
}

function valuesOf(raw, keys, label) {
  try { evidence.assertExactKeys(raw, keys, label); }
  catch (_) { fail(`${label} must be descriptor-exact plain data`); }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of keys) values[key] = descriptors[key].value;
  return values;
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return null;
  try { return evidence.assertDigest(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function boundedString(value, label, maximum = 256) {
  try {
    const result = evidence.assertString(value, label, { minBytes: 1, maxBytes: maximum });
    if (result !== result.normalize('NFC')) fail(`${label} is not NFC`);
    return result;
  } catch (error) {
    if (error instanceof ChangesHistoryMarkerJournalSchemaError) throw error;
    fail(`${label} is invalid`);
  }
}

function cloneActiveMarkerJson(raw) {
  const ancestors = new Set();
  const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
  let nodes = 0;

  function clone(value, depth, label) {
    if (depth > MAX_ACTIVE_MARKER_DEPTH) fail('active marker nesting exceeds limit');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail(`${label} number is not a finite safe integer`);
      return value;
    }
    if (!value || typeof value !== 'object') fail(`${label} contains a non-JSON value`);
    nodes += 1;
    if (nodes > MAX_ACTIVE_MARKER_NODES || ancestors.has(value)) {
      fail('active marker is cyclic or exceeds node limit');
    }
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} array is not plain`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || Reflect.ownKeys(value).length !== length + 1) {
        fail(`${label} array is sparse or extended`);
      }
      result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true ||
            !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
            Object.hasOwn(descriptor, 'set')) fail(`${label}[${index}] is not plain data`);
        result.push(clone(descriptor.value, depth + 1, `${label}[${index}]`));
      }
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} object is not plain`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string' || unsafeKeys.has(key))) {
        fail(`${label} object contains unsafe keys`);
      }
      result = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || descriptor.enumerable !== true ||
            !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
            Object.hasOwn(descriptor, 'set')) fail(`${label}.${key} is not plain data`);
        result[key] = clone(descriptor.value, depth + 1, `${label}.${key}`);
      }
    }
    ancestors.delete(value);
    return Object.freeze(result);
  }

  const marker = clone(raw, 0, 'active marker');
  if (Array.isArray(marker) || marker === null || typeof marker !== 'object') {
    fail('active marker must be one plain JSON object');
  }
  let byteLength;
  try { byteLength = evidence.canonicalJsonByteLength(marker); }
  catch (_) { fail('active marker cannot be canonically encoded'); }
  if (byteLength > MAX_ACTIVE_MARKER_BYTES) fail('active marker exceeds its frozen budget');
  return marker;
}

function activeMarkerDigest(raw) {
  const marker = cloneActiveMarkerJson(raw);
  return evidence.digestObject(SCHEMAS.ACTIVE_MARKER, {
    schema: SCHEMAS.ACTIVE_MARKER,
    marker,
  });
}

function assertActiveMarker(raw, operationId, projectId, kind) {
  const marker = cloneActiveMarkerJson(raw);
  const actualKeys = Object.keys(marker);
  const allowedKeys = new Set([...ACTIVE_MARKER_REQUIRED_KEYS, ...ACTIVE_MARKER_OPTIONAL_KEYS]);
  if (ACTIVE_MARKER_REQUIRED_KEYS.some(key => !Object.hasOwn(marker, key)) ||
      actualKeys.some(key => !allowedKeys.has(key))) {
    fail('active marker keys are not exact');
  }
  if (marker.schema !== RECOVERY_SCHEMA) fail('active marker schema is unsupported');
  if (marker.operationId !== operationId || marker.projectId !== projectId || marker.kind !== kind) {
    fail('active marker top-level authority differs from journal operation');
  }
  if (typeof marker.integrity !== 'string' || !/^[a-f0-9]{64}$/u.test(marker.integrity)) {
    fail('active marker integrity is invalid');
  }
  return marker;
}

function generation(value, label = 'generation') {
  if (typeof value !== 'string' || !GENERATION_RE.test(value) || BigInt(value) > MAX_GENERATION) {
    fail(`${label} is invalid`);
  }
  return value;
}

function nextGeneration(value) {
  const parsed = BigInt(generation(value));
  if (parsed === MAX_GENERATION) fail('journal generation is exhausted');
  return String(parsed + 1n);
}

function basename(value, label, stage = false, nullable = false) {
  if (nullable && value === null) return null;
  const pattern = stage ? STAGE_BASENAME_RE : PRIVATE_BASENAME_RE;
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) {
    fail(`${label} is invalid`);
  }
  return value;
}

function denseArray(raw, label) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECORDS ||
      Reflect.ownKeys(raw).length !== length + 1) fail(`${label} length is invalid`);
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) fail(`${label} must be dense plain data`);
    return descriptor.value;
  });
}

function assertRecord(raw, index = 0) {
  const value = valuesOf(raw, KEYS.RECORD, `records[${index}]`);
  if (value.schema !== SCHEMAS.RECORD || typeof value.role !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,31}$/u.test(value.role) ||
      !Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || value.ordinal >= MAX_RECORDS ||
      !RECORD_STATES.includes(value.state)) fail(`records[${index}] identity is invalid`);
  let identity;
  try { identity = evidence.assertObjectIdentity(value.recordIdentity); }
  catch (_) { fail(`records[${index}] full identity is invalid`); }
  const recordDigest = digest(value.recordDigest, `records[${index}].recordDigest`);
  if (identity.contentSha256 !== recordDigest) {
    fail(`records[${index}] digest does not bind its full identity`);
  }
  const stageBasename = basename(
    value.stageBasename,
    `records[${index}].stageBasename`,
    true
  );
  const destinationBasename = basename(
    value.destinationBasename,
    `records[${index}].destinationBasename`
  );
  const cleanupRequired = ['CLEANUP_ARMED', 'REMOVED'].includes(value.state);
  const cleanupBasename = basename(
    value.cleanupBasename,
    `records[${index}].cleanupBasename`,
    true,
    !cleanupRequired
  );
  if (cleanupRequired !== (cleanupBasename !== null)) {
    fail(`records[${index}] cleanup authority nullability is invalid`);
  }
  return Object.freeze({
    schema: SCHEMAS.RECORD,
    role: value.role,
    ordinal: value.ordinal,
    state: value.state,
    stageBasename,
    destinationBasename,
    cleanupBasename,
    recordDigest,
    recordIdentity: identity,
  });
}

function assertMutation(raw) {
  const value = valuesOf(raw, KEYS.MUTATION, 'native mutation authority');
  if (value.schema !== SCHEMAS.MUTATION || !MUTATION_STATES.includes(value.state) ||
      typeof value.directoryFsyncComplete !== 'boolean') {
    fail('native mutation authority identity is invalid');
  }
  const unarmed = value.state === 'UNARMED';
  if (unarmed !== (value.sourceIdentityDigest === null) ||
      unarmed !== (value.privateBasename === null) ||
      (unarmed && value.directoryFsyncComplete) ||
      (value.state === 'ARMED' && value.directoryFsyncComplete) ||
      (value.state === 'COMMITTED' && !value.directoryFsyncComplete)) {
    fail('native mutation authority nullability is invalid');
  }
  return Object.freeze({
    schema: SCHEMAS.MUTATION,
    state: value.state,
    sourceIdentityDigest: digest(value.sourceIdentityDigest, 'sourceIdentityDigest', true),
    privateBasename: basename(value.privateBasename, 'privateBasename', false, true),
    directoryFsyncComplete: value.directoryFsyncComplete,
  });
}

function assertCreatePrivateRecord(raw, role, label) {
  const value = valuesOf(raw, KEYS.CREATE_PRIVATE_RECORD, label);
  const pattern = role === 'CONTROL'
    ? CREATE_CONTROL_BASENAME_RE
    : CREATE_RECEIPT_BASENAME_RE;
  if (value.schema !== SCHEMAS.CREATE_PRIVATE_RECORD || value.role !== role ||
      !pattern.test(value.deterministicBasename || '') ||
      !['PUBLISHED', 'CLEANUP_ARMED', 'REMOVED'].includes(value.state)) {
    fail(`${label} identity is invalid`);
  }
  const cleanupRequired = value.state !== 'PUBLISHED';
  const cleanupBasename = value.cleanupBasename === null
    ? null
    : CREATE_CLEANUP_BASENAME_RE.test(value.cleanupBasename || '')
      ? value.cleanupBasename
      : fail(`${label}.cleanupBasename is invalid`);
  if (cleanupRequired !== (cleanupBasename !== null)) {
    fail(`${label} cleanup authority is invalid`);
  }
  const logicalDigest = digest(value.logicalDigest, `${label}.logicalDigest`);
  const boundControlDigest = digest(
    value.boundControlDigest,
    `${label}.boundControlDigest`,
    true
  );
  if ((role === 'CONTROL') !== (boundControlDigest === null)) {
    fail(`${label} control binding nullability is invalid`);
  }
  const rawSha256 = digest(value.rawSha256, `${label}.rawSha256`);
  let recordIdentity;
  try { recordIdentity = evidence.assertObjectIdentity(value.recordIdentity); }
  catch (_) { fail(`${label} full identity is invalid`); }
  if (recordIdentity.mode !== 0o600 || recordIdentity.nlink !== 1 ||
      recordIdentity.contentSha256 !== rawSha256) {
    fail(`${label} raw bytes do not bind the full record identity`);
  }
  let recordPath;
  try { recordPath = evidence.assertPublicMarkdownPath(value.path, `${label}.path`); }
  catch (_) { fail(`${label}.path is invalid`); }
  return Object.freeze({
    schema: SCHEMAS.CREATE_PRIVATE_RECORD,
    role,
    selectedId: boundedString(value.selectedId, `${label}.selectedId`),
    path: recordPath,
    contentDigest: digest(value.contentDigest, `${label}.contentDigest`),
    ancestorIdentityDigest: digest(
      value.ancestorIdentityDigest,
      `${label}.ancestorIdentityDigest`
    ),
    deterministicBasename: value.deterministicBasename,
    logicalDigest,
    boundControlDigest,
    rawSha256,
    recordIdentity,
    state: value.state,
    cleanupBasename,
  });
}

function assertCreateCaptureItem(raw, index) {
  const value = valuesOf(raw, KEYS.CREATE_CAPTURE_ITEM, `createCapture.items[${index}]`);
  let path;
  try { path = evidence.assertPublicMarkdownPath(value.path, `createCapture.items[${index}].path`); }
  catch (_) { fail(`createCapture.items[${index}].path is invalid`); }
  let createdLeafIdentity;
  try { createdLeafIdentity = evidence.assertObjectIdentity(value.createdLeafIdentity); }
  catch (_) { fail(`createCapture.items[${index}].createdLeafIdentity is invalid`); }
  const contentDigest = digest(
    value.contentDigest,
    `createCapture.items[${index}].contentDigest`
  );
  if (value.schema !== SCHEMAS.CREATE_CAPTURE_ITEM || value.ordinal !== index ||
      createdLeafIdentity.nlink !== 1 || createdLeafIdentity.contentSha256 !== contentDigest) {
    fail(`createCapture.items[${index}] identity or content is invalid`);
  }
  const selectedId = boundedString(value.selectedId, `createCapture.items[${index}].selectedId`);
  const ancestorIdentityDigest = digest(
    value.ancestorIdentityDigest,
    `createCapture.items[${index}].ancestorIdentityDigest`
  );
  const creationReceiptDigest = digest(
    value.creationReceiptDigest,
    `createCapture.items[${index}].creationReceiptDigest`
  );
  const control = assertCreatePrivateRecord(
    value.control,
    'CONTROL',
    `createCapture.items[${index}].control`
  );
  const receipt = assertCreatePrivateRecord(
    value.receipt,
    'RECEIPT',
    `createCapture.items[${index}].receipt`
  );
  const controlSuffix = control.deterministicBasename.slice(-64);
  const receiptSuffix = receipt.deterministicBasename.slice(-64);
  if ([control, receipt].some(record => record.selectedId !== selectedId ||
      record.path !== path || record.contentDigest !== contentDigest ||
      record.ancestorIdentityDigest !== ancestorIdentityDigest) ||
      receipt.boundControlDigest !== control.logicalDigest ||
      creationReceiptDigest !== receipt.logicalDigest || controlSuffix !== receiptSuffix) {
    fail(`createCapture.items[${index}] private record pair is not exact`);
  }
  return Object.freeze({
    schema: SCHEMAS.CREATE_CAPTURE_ITEM,
    ordinal: index,
    selectedId,
    path,
    contentDigest,
    ancestorIdentityDigest,
    createdLeafIdentity,
    creationReceiptDigest,
    control,
    receipt,
  });
}

function assertCreateCapture(raw) {
  const value = valuesOf(raw, KEYS.CREATE_CAPTURE, 'create capture');
  if (value.schema !== SCHEMAS.CREATE_CAPTURE) fail('create capture schema is invalid');
  const rawItems = denseArray(value.items, 'createCapture.items');
  if (rawItems.length < 1 || rawItems.length > MAX_CREATE_CAPTURE_ITEMS) {
    fail('create capture item count is invalid');
  }
  const items = rawItems.map(assertCreateCaptureItem);
  const selectedIds = items.map(item => item.selectedId);
  const paths = items.map(item => item.path);
  const deterministicNames = items.flatMap(item => [
    item.control.deterministicBasename,
    item.receipt.deterministicBasename,
  ]);
  const cleanupNames = items.flatMap(item => [
    item.control.cleanupBasename,
    item.receipt.cleanupBasename,
  ]).filter(name => name !== null);
  const identities = items.flatMap(item => [
    item.createdLeafIdentity,
    item.control.recordIdentity,
    item.receipt.recordIdentity,
  ]).map(identity => `${identity.dev}:${identity.ino}`);
  if (new Set(selectedIds).size !== items.length || new Set(paths).size !== items.length ||
      new Set(deterministicNames).size !== deterministicNames.length ||
      new Set(cleanupNames).size !== cleanupNames.length ||
      new Set([...deterministicNames, ...cleanupNames]).size !==
        deterministicNames.length + cleanupNames.length ||
      new Set(identities).size !== identities.length) {
    fail('create capture contains duplicate path, name or full identity authority');
  }
  return Object.freeze({ schema: SCHEMAS.CREATE_CAPTURE, items: Object.freeze(items) });
}

function assertFinalizationToken(raw, index) {
  const value = valuesOf(raw, [
    'schema', 'operationId', 'selectedId', 'controlBasename', 'receiptBasename',
    'controlDigest', 'createdIdentityDigest', 'contentDigest', 'receiptDigest',
  ], `createFinalization.finalizeRequest.tokens[${index}]`);
  if (value.schema !== CREATE_TOKEN_SCHEMA || !OPERATION_ID_RE.test(value.operationId || '') ||
      !CREATE_CONTROL_BASENAME_RE.test(value.controlBasename || '') ||
      !CREATE_RECEIPT_BASENAME_RE.test(value.receiptBasename || '')) {
    fail('create finalization token identity is invalid');
  }
  return Object.freeze({
    schema: CREATE_TOKEN_SCHEMA,
    operationId: value.operationId,
    selectedId: boundedString(value.selectedId, 'create finalization selectedId'),
    controlBasename: value.controlBasename,
    receiptBasename: value.receiptBasename,
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
}

function assertFinalizationRequest(raw) {
  const value = valuesOf(raw, [
    'schema', 'operationId', 'artifactDigest', 'selectionDigest',
    'historyCommittedPhaseDigest', 'tokens',
  ], 'createFinalization.finalizeRequest');
  const tokens = denseArray(value.tokens, 'createFinalization.finalizeRequest.tokens')
    .map(assertFinalizationToken);
  if (value.schema !== CREATE_FINALIZE_REQUEST_SCHEMA ||
      !OPERATION_ID_RE.test(value.operationId || '') || tokens.length < 1 ||
      tokens.length > MAX_CREATE_CAPTURE_ITEMS ||
      tokens.some(token => token.operationId !== value.operationId) ||
      new Set(tokens.map(token => token.selectedId)).size !== tokens.length) {
    fail('create finalization request identity is invalid');
  }
  return Object.freeze({
    schema: CREATE_FINALIZE_REQUEST_SCHEMA,
    operationId: value.operationId,
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    tokens: Object.freeze(tokens),
  });
}

function assertFinalizationAck(raw) {
  const value = valuesOf(raw, [
    'schema', 'operationId', 'artifactDigest', 'selectionDigest',
    'historyCommittedPhaseDigest', 'receiptSetDigest', 'itemCount',
    'recoveryFsyncComplete', 'finalAckDigest',
  ], 'createFinalization.finalAck');
  if (value.schema !== CREATE_FINAL_ACK_SCHEMA ||
      !OPERATION_ID_RE.test(value.operationId || '') ||
      !Number.isSafeInteger(value.itemCount) || value.itemCount < 1 ||
      value.itemCount > MAX_CREATE_CAPTURE_ITEMS || value.recoveryFsyncComplete !== true) {
    fail('create finalization ACK identity is invalid');
  }
  return Object.freeze({
    schema: CREATE_FINAL_ACK_SCHEMA,
    operationId: value.operationId,
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    receiptSetDigest: digest(value.receiptSetDigest, 'receiptSetDigest'),
    itemCount: value.itemCount,
    recoveryFsyncComplete: true,
    finalAckDigest: digest(value.finalAckDigest, 'finalAckDigest'),
  });
}

function createFinalizationDigest(raw) {
  const source = valuesOf(raw, KEYS.CREATE_FINALIZATION, 'create finalization digest input');
  return evidence.digestObject(SCHEMAS.CREATE_FINALIZATION, Object.fromEntries(
    KEYS.CREATE_FINALIZATION.map(key => [key, key === 'finalizationDigest' ? null : source[key]])
  ), 'finalizationDigest');
}

function assertCreateFinalization(raw) {
  const value = valuesOf(raw, KEYS.CREATE_FINALIZATION, 'create finalization authority');
  const request = assertFinalizationRequest(value.finalizeRequest);
  const finalAck = assertFinalizationAck(value.finalAck);
  let artifactIdentity;
  try { artifactIdentity = evidence.assertObjectIdentity(value.artifactIdentity); }
  catch (_) { fail('create finalization artifact identity is invalid'); }
  const finalRecordIdentity = value.finalRecordIdentity === null
    ? null
    : (() => {
      try { return evidence.assertObjectIdentity(value.finalRecordIdentity); }
      catch (_) { fail('create finalization record identity is invalid'); }
    })();
  const valid = Object.freeze({
    schema: value.schema,
    state: value.state,
    operationId: value.operationId,
    finalizeRequest: request,
    finalizeRequestDigest: digest(value.finalizeRequestDigest, 'finalizeRequestDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    rawPreparedHistoryStateDigest: digest(
      value.rawPreparedHistoryStateDigest,
      'rawPreparedHistoryStateDigest'
    ),
    artifactByteLength: Number.isSafeInteger(value.artifactByteLength) &&
      value.artifactByteLength >= 0 ? value.artifactByteLength : fail('artifactByteLength is invalid'),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentity,
    committedPublicationDigest: digest(
      value.committedPublicationDigest,
      'committedPublicationDigest'
    ),
    createCaptureDigest: digest(value.createCaptureDigest, 'createCaptureDigest'),
    finalBasename: CREATE_FINAL_BASENAME_RE.test(value.finalBasename || '')
      ? value.finalBasename : fail('create finalization basename is invalid'),
    finalAck,
    finalAckDigest: digest(value.finalAckDigest, 'finalAckDigest'),
    finalRecordIdentity,
    previousFinalizationDigest: digest(
      value.previousFinalizationDigest,
      'previousFinalizationDigest',
      true
    ),
    finalizationDigest: digest(value.finalizationDigest, 'finalizationDigest'),
  });
  if (valid.schema !== SCHEMAS.CREATE_FINALIZATION ||
      !['PREPARED', 'CAPTURED'].includes(valid.state) ||
      valid.operationId !== request.operationId ||
      valid.operationId !== finalAck.operationId ||
      valid.artifactDigest !== request.artifactDigest ||
      valid.artifactDigest !== finalAck.artifactDigest ||
      valid.historyCommittedPhaseDigest !== request.historyCommittedPhaseDigest ||
      valid.historyCommittedPhaseDigest !== finalAck.historyCommittedPhaseDigest ||
      valid.finalAckDigest !== finalAck.finalAckDigest ||
      artifactIdentity.mode !== 0o600 || artifactIdentity.nlink !== 1 ||
      BigInt(artifactIdentity.size) !== BigInt(valid.artifactByteLength) ||
      artifactIdentity.contentSha256 !== valid.artifactDigest ||
      (valid.state === 'PREPARED'
        ? valid.finalRecordIdentity !== null || valid.previousFinalizationDigest !== null
        : valid.finalRecordIdentity === null || valid.previousFinalizationDigest === null) ||
      (finalRecordIdentity && (finalRecordIdentity.mode !== 0o600 ||
        finalRecordIdentity.nlink !== 1)) ||
      valid.finalizationDigest !== createFinalizationDigest(valid)) {
    fail('create finalization authority is not exact');
  }
  return valid;
}

function publicationDigest(raw) {
  const source = valuesOf(raw, KEYS.PUBLICATION, 'native publication digest input');
  const value = Object.fromEntries(KEYS.PUBLICATION.map(key => [
    key,
    key === 'publicationDigest' ? null : source[key],
  ]));
  return evidence.digestObject(SCHEMAS.PUBLICATION, value, 'publicationDigest');
}

function assertPublication(raw) {
  const value = valuesOf(raw, KEYS.PUBLICATION, 'native publication authority');
  if (value.schema !== SCHEMAS.PUBLICATION || !PUBLICATION_KINDS.includes(value.kind) ||
      !COMMANDS.includes(value.command) || !PUBLICATION_STATES.includes(value.state) ||
      !OPERATION_ID_RE.test(value.operationId || '')) {
    fail('native publication authority identity is invalid');
  }
  if (!COMMANDS_BY_KIND[value.kind].includes(value.command)) {
    fail('native publication command is invalid for kind');
  }
  const records = denseArray(value.records, 'native publication records')
    .map((record, index) => assertRecord(record, index));
  const allBasenames = records.flatMap(record => [
    record.stageBasename,
    record.destinationBasename,
    ...(record.cleanupBasename === null ? [] : [record.cleanupBasename]),
  ]);
  const identityDigests = records.map(record => evidence.digestObjectIdentity(
    record.recordIdentity
  ));
  if (records.some((record, index) => record.ordinal !== index) ||
      new Set(identityDigests).size !== identityDigests.length ||
      new Set(allBasenames).size !== allBasenames.length) {
    fail('native publication record authority is duplicated');
  }
  const mutation = assertMutation(value.mutation);
  const createMissing = value.command === 'CREATE_MISSING';
  const createAttemptDigest = digest(
    value.createAttemptDigest,
    'createAttemptDigest',
    true
  );
  const createCapture = value.createCapture === null
    ? null
    : assertCreateCapture(value.createCapture);
  const createFinalization = value.createFinalization === null
    ? null
    : assertCreateFinalization(value.createFinalization);
  const createCleanupFinalBasename = value.createCleanupFinalBasename === null
    ? null
    : (CREATE_FINAL_BASENAME_RE.test(value.createCleanupFinalBasename || '')
      ? value.createCleanupFinalBasename
      : fail('CREATE_MISSING cleanup final basename is invalid'));
  const createCleanupFinalRecordIdentity = value.createCleanupFinalRecordIdentity === null
    ? null
    : (() => {
      try { return evidence.assertObjectIdentity(value.createCleanupFinalRecordIdentity); }
      catch (_) { fail('CREATE_MISSING cleanup final record identity is invalid'); }
    })();
  if (!createMissing && (createAttemptDigest !== null || createCapture !== null ||
      createFinalization !== null || createCleanupFinalBasename !== null ||
      createCleanupFinalRecordIdentity !== null)) {
    fail('only CREATE_MISSING may carry create attempt/capture authority');
  }
  if (createMissing) {
    if (records.length !== 0 || mutation.state !== 'UNARMED' ||
        ((value.state === 'PREPARED') !== (createCapture === null)) ||
        (value.state !== 'PREPARED' && createAttemptDigest === null) ||
        (createFinalization !== null && value.state !== 'COMMITTED') ||
        (['PREPARED', 'ARMED', 'COMMITTED'].includes(value.state) &&
          (createCleanupFinalBasename !== null || createCleanupFinalRecordIdentity !== null)) ||
        (['ACK_PREPARED', 'ACK_COMMITTED'].includes(value.state) &&
          (createCleanupFinalBasename === null || createCleanupFinalRecordIdentity === null))) {
      fail('CREATE_MISSING must use only its complete post-facto capture authority');
    }
    const privateRecords = createCapture === null ? [] : createCapture.items.flatMap(item => [
      item.control,
      item.receipt,
    ]);
    if (['ARMED', 'COMMITTED'].includes(value.state) &&
        privateRecords.some(record => record.state !== 'PUBLISHED')) {
      fail('captured CREATE_MISSING records must begin fully PUBLISHED');
    }
    if (value.state === 'ACK_PREPARED' && privateRecords.some(record =>
      !['CLEANUP_ARMED', 'REMOVED'].includes(record.state))) {
      fail('CREATE_MISSING ACK_PREPARED requires exact cleanup authority');
    }
    if (value.state === 'ACK_COMMITTED' &&
        privateRecords.some(record => record.state !== 'REMOVED')) {
      fail('CREATE_MISSING ACK_COMMITTED requires every captured record removed');
    }
  } else {
    if (value.state === 'PREPARED' && (records.length !== 0 || mutation.state !== 'UNARMED')) {
      fail('PREPARED cannot claim native publication');
    }
    if (value.state === 'ARMED' && records.length === 0 && mutation.state === 'UNARMED') {
      fail('ARMED requires exact staged record or mutation authority');
    }
    if (value.state === 'ARMED' &&
        records.some(record => !['ARMED', 'PUBLISHED'].includes(record.state))) {
      fail('ARMED cannot begin record cleanup');
    }
    if (value.state === 'COMMITTED' &&
        (records.length === 0 || records.some(record => record.state !== 'PUBLISHED') ||
         mutation.state !== 'COMMITTED')) {
      fail('COMMITTED requires complete publication and mutation durability');
    }
    if (value.state === 'ACK_PREPARED' &&
        (records.some(record => !['CLEANUP_ARMED', 'REMOVED'].includes(record.state)) ||
         mutation.state !== 'COMMITTED')) {
      fail('ACK_PREPARED requires exact per-record cleanup authority');
    }
    if (value.state === 'ACK_COMMITTED' &&
        (records.some(record => record.state !== 'REMOVED') || mutation.state !== 'COMMITTED')) {
      fail('ACK_COMMITTED requires the armed record set to be absent and durable');
    }
  }
  const valid = Object.freeze({
    schema: SCHEMAS.PUBLICATION,
    kind: value.kind,
    command: value.command,
    state: value.state,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'requestDigest'),
    phaseDigest: digest(value.phaseDigest, 'phaseDigest'),
    previousPublicationDigest: digest(
      value.previousPublicationDigest,
      'previousPublicationDigest',
      true
    ),
    records: Object.freeze(records),
    mutation,
    createAttemptDigest,
    createCapture,
    createFinalization,
    createCleanupFinalBasename,
    createCleanupFinalRecordIdentity,
    publicationDigest: digest(value.publicationDigest, 'publicationDigest'),
  });
  const initialPrepared = valid.state === 'PREPARED' && valid.createAttemptDigest === null;
  const latchedPrepared = valid.state === 'PREPARED' && valid.createAttemptDigest !== null;
  if ((initialPrepared && valid.previousPublicationDigest !== null) ||
      (latchedPrepared && valid.previousPublicationDigest === null) ||
      (valid.state !== 'PREPARED' && valid.previousPublicationDigest === null) ||
      valid.publicationDigest !== publicationDigest(valid)) {
    fail('native publication digest chain is invalid');
  }
  return valid;
}

function existingFinalizationDigest(raw) {
  const source = valuesOf(
    raw,
    KEYS.EXISTING_FINALIZATION,
    'EXISTING terminal finalization digest input'
  );
  const value = Object.fromEntries(KEYS.EXISTING_FINALIZATION.map(key => [
    key,
    key === 'finalizationDigest' ? null : source[key],
  ]));
  return evidence.digestObject(SCHEMAS.EXISTING_FINALIZATION, value, 'finalizationDigest');
}

function assertExistingLeafIdentity(raw, selectedId, finalContentDigest, label) {
  const value = valuesOf(raw, KEYS.EXISTING_LEAF_IDENTITY, label);
  let path;
  try { path = evidence.assertPublicMarkdownPath(value.path, `${label}.path`); }
  catch (_) { fail(`${label}.path is invalid`); }
  const unsigned = (entry, field) => {
    try { return evidence.assertUnsignedDecimal(entry, `${label}.${field}`); }
    catch (_) { fail(`${label}.${field} is invalid`); }
  };
  if (value.schema !== EXISTING_LEAF_IDENTITY_SCHEMA ||
      value.selectedId !== selectedId || !/^[a-f0-9]{64}$/u.test(value.revision || '') ||
      `sha256:${value.revision}` !== finalContentDigest ||
      value.contentSha256 !== finalContentDigest || !Number.isSafeInteger(value.uid) ||
      value.uid < 0 || value.uid > 0xffffffff || !Number.isSafeInteger(value.mode) ||
      value.mode < 0 || value.mode > 0xffff || value.nlink !== 1) {
    fail(`${label} does not bind the final EXISTING leaf`);
  }
  const identity = Object.freeze({
    schema: EXISTING_LEAF_IDENTITY_SCHEMA,
    selectedId,
    path,
    revision: value.revision,
    ancestorIdentityDigest: digest(
      value.ancestorIdentityDigest,
      `${label}.ancestorIdentityDigest`
    ),
    dev: unsigned(value.dev, 'dev'),
    ino: unsigned(value.ino, 'ino'),
    uid: value.uid,
    mode: value.mode,
    nlink: value.nlink,
    size: unsigned(value.size, 'size'),
    mtimeNs: unsigned(value.mtimeNs, 'mtimeNs'),
    ctimeNs: unsigned(value.ctimeNs, 'ctimeNs'),
    contentSha256: digest(value.contentSha256, `${label}.contentSha256`),
  });
  return identity;
}

function assertExistingTerminalItem(raw, index) {
  const label = `existingTerminalPublication.items[${index}]`;
  const value = valuesOf(raw, KEYS.EXISTING_TERMINAL_ITEM, label);
  const selectedId = boundedString(value.selectedId, `${label}.selectedId`);
  if (value.schema !== SCHEMAS.EXISTING_TERMINAL_ITEM || value.ordinal !== index ||
      !EXISTING_CONTROL_BASENAME_RE.test(value.controlBasename || '') ||
      !EXISTING_APPLY_BASENAME_RE.test(value.applyBasename || '')) {
    fail(`${label} identity or record name is invalid`);
  }
  const finalContentDigest = digest(value.finalContentDigest, `${label}.finalContentDigest`);
  if (!EXISTING_CLEANUP_STATES.includes(value.controlCleanupState) ||
      !EXISTING_CLEANUP_STATES.includes(value.applyCleanupState)) {
    fail(`${label} cleanup state is invalid`);
  }
  const finalLeafIdentity = assertExistingLeafIdentity(
    value.finalLeafIdentity,
    selectedId,
    finalContentDigest,
    `${label}.finalLeafIdentity`
  );
  let controlRecordIdentity;
  let applyRecordIdentity;
  try {
    controlRecordIdentity = evidence.assertObjectIdentity(value.controlRecordIdentity);
    applyRecordIdentity = evidence.assertObjectIdentity(value.applyRecordIdentity);
  } catch (_) {
    fail(`${label} private record identity is invalid`);
  }
  if (controlRecordIdentity.mode !== 0o600 || controlRecordIdentity.nlink !== 1 ||
      applyRecordIdentity.mode !== 0o600 || applyRecordIdentity.nlink !== 1) {
    fail(`${label} private record identity is not owner-private`);
  }
  return Object.freeze({
    schema: SCHEMAS.EXISTING_TERMINAL_ITEM,
    ordinal: index,
    selectedId,
    finalContentDigest,
    finalLeafIdentity,
    controlBasename: value.controlBasename,
    controlDigest: digest(value.controlDigest, `${label}.controlDigest`),
    controlRecordIdentity,
    controlCleanupState: value.controlCleanupState,
    applyBasename: value.applyBasename,
    applyReceiptDigest: digest(value.applyReceiptDigest, `${label}.applyReceiptDigest`),
    applyRecordIdentity,
    applyCleanupState: value.applyCleanupState,
  });
}

function assertExistingFinalization(raw, operationId) {
  const value = valuesOf(raw, KEYS.EXISTING_FINALIZATION, 'EXISTING terminal finalization');
  if (value.schema !== SCHEMAS.EXISTING_FINALIZATION ||
      !EXISTING_FINAL_BASENAME_RE.test(value.finalBasename || '') ||
      !EXISTING_CLEANUP_STATES.includes(value.cleanupState)) {
    fail('EXISTING terminal finalization identity is invalid');
  }
  let finalRecordIdentity;
  try { finalRecordIdentity = evidence.assertObjectIdentity(value.finalRecordIdentity); }
  catch (_) { fail('EXISTING final record identity is invalid'); }
  if (finalRecordIdentity.mode !== 0o600 || finalRecordIdentity.nlink !== 1) {
    fail('EXISTING final record identity is not owner-private');
  }
  const valid = Object.freeze({
    schema: SCHEMAS.EXISTING_FINALIZATION,
    finalizeRequestDigest: digest(value.finalizeRequestDigest, 'finalizeRequestDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    finalBasename: value.finalBasename,
    finalRecordDigest: digest(value.finalRecordDigest, 'finalRecordDigest'),
    finalRecordIdentity,
    markerFinalizedPhaseDigest: digest(
      value.markerFinalizedPhaseDigest,
      'markerFinalizedPhaseDigest'
    ),
    cleanupState: value.cleanupState,
    finalizationDigest: digest(value.finalizationDigest, 'finalizationDigest'),
  });
  // The final record identity describes the actual owner-private final record
  // file (raw content sha), while finalRecordDigest is the record's domain
  // digest over its canonical JSON; the two are intentionally different. The
  // finalization binds both via its own digest below.
  if (valid.finalizationDigest !== existingFinalizationDigest(valid) ||
      !OPERATION_ID_RE.test(operationId)) {
    fail('EXISTING terminal finalization digest or record binding is invalid');
  }
  return valid;
}

function existingTerminalPublicationDigest(raw) {
  const source = valuesOf(
    raw,
    KEYS.EXISTING_TERMINAL_PUBLICATION,
    'EXISTING terminal publication digest input'
  );
  const value = Object.fromEntries(KEYS.EXISTING_TERMINAL_PUBLICATION.map(key => [
    key,
    key === 'publicationDigest' ? null : source[key],
  ]));
  return evidence.digestObject(
    SCHEMAS.EXISTING_TERMINAL_PUBLICATION,
    value,
    'publicationDigest'
  );
}

function rollbackCreateAttemptPublicationDigest(raw) {
  const source = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION,
    'rollback-create attempt publication digest input'
  );
  const value = Object.fromEntries(KEYS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION.map(key => [
    key,
    key === 'publicationDigest' ? null : source[key],
  ]));
  return evidence.digestObject(
    SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION,
    value,
    'publicationDigest'
  );
}

// The attempt latch is the write-ahead record for the rollback quarantine. Q is
// destructive: it moves the receipt-owned MISSING leaves into private
// quarantine. Without this latch a crash after Q but before the QUARANTINED CAS
// would leave those leaves moved with no journal record of why, which is exactly
// the unrecoverable window this publication exists to close. The latch records
// the full native authority and the exact predecessor/generation it was born
// from, so a restart can reconcile Q's truth without ever replaying Q.
function assertRollbackCreateAttemptPublication(raw) {
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION,
    'rollback-create attempt publication'
  );
  const valid = Object.freeze({
    schema: SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION,
    state: value.state,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'rollback-create attempt requestDigest'),
    authorityBase64: canonicalBase64(value.authorityBase64, 'rollback-create attempt authority'),
    predecessorValueDigest: digest(
      value.predecessorValueDigest,
      'rollback-create attempt predecessorValueDigest'
    ),
    installedGeneration: generation(
      value.installedGeneration,
      'rollback-create attempt installedGeneration'
    ),
    publicationDigest: digest(
      value.publicationDigest,
      'rollback-create attempt publicationDigest'
    ),
  });
  if (valid.schema !== SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION ||
      valid.state !== 'PREPARED' || !OPERATION_ID_RE.test(valid.operationId || '') ||
      valid.publicationDigest !== rollbackCreateAttemptPublicationDigest(valid)) {
    fail('rollback-create attempt publication is invalid');
  }
  return valid;
}

const ROLLBACK_CREATE_PUBLICATION_STATES = Object.freeze([
  'QUARANTINED', 'ROLLED_BACK', 'ACK_COMMITTED',
]);

function canonicalBase64(raw, label) {
  const encoded = boundedString(raw, label, MAX_EXISTING_TERMINAL_PUBLICATION_BYTES);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    fail(`${label} is not canonical base64`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_EXISTING_TERMINAL_PUBLICATION_BYTES ||
      bytes.toString('base64') !== encoded) {
    fail(`${label} budget or encoding is invalid`);
  }
  return encoded;
}

function rollbackCreatePublicationDigest(raw) {
  const source = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_PUBLICATION,
    'rollback-create publication digest input'
  );
  const value = Object.fromEntries(KEYS.ROLLBACK_CREATE_PUBLICATION.map(key => [
    key,
    key === 'publicationDigest' ? null : source[key],
  ]));
  return evidence.digestObject(
    SCHEMAS.ROLLBACK_CREATE_PUBLICATION,
    value,
    'publicationDigest'
  );
}

// The ROLLBACK_CREATE publication is the durable authority for the zero-net-write
// branch. It exists because the rollback domain destroys the MISSING leaves: Q
// quarantines them, D deletes the quarantine, A removes the recovered records.
// Publishing the exact Q result before D, and the exact D result before A, is
// what makes a crash or a lost response at any of those boundaries recoverable
// from the journal instead of unrecoverable residue.
function assertRollbackCreatePublication(raw) {
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_PUBLICATION,
    'rollback-create publication'
  );
  if (value.schema !== SCHEMAS.ROLLBACK_CREATE_PUBLICATION ||
      !ROLLBACK_CREATE_PUBLICATION_STATES.includes(value.state) ||
      !OPERATION_ID_RE.test(value.operationId || '')) {
    fail('rollback-create publication identity is invalid');
  }
  const exactBase64 = (rawValue, label, nullable = false) => {
    if (nullable && rawValue === null) return null;
    return canonicalBase64(rawValue, label);
  };
  const valid = Object.freeze({
    schema: SCHEMAS.ROLLBACK_CREATE_PUBLICATION,
    state: value.state,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'rollback-create requestDigest'),
    authorityBase64: exactBase64(value.authorityBase64, 'rollback-create authority'),
    quarantineResultBase64: exactBase64(
      value.quarantineResultBase64,
      'rollback-create quarantine result'
    ),
    settleResultBase64: exactBase64(
      value.settleResultBase64,
      'rollback-create settle result',
      true
    ),
    publicationDigest: digest(value.publicationDigest, 'rollback-create publicationDigest'),
  });
  if ((valid.state === 'QUARANTINED') !== (valid.settleResultBase64 === null) ||
      valid.publicationDigest !== rollbackCreatePublicationDigest(valid)) {
    fail('rollback-create publication state or digest is invalid');
  }
  return valid;
}

function assertRollbackCreatePublicationTransition(rawPrevious, rawNext) {
  const previous = assertRollbackCreatePublication(rawPrevious);
  const next = assertRollbackCreatePublication(rawNext);
  if (previous.publicationDigest === next.publicationDigest) return next;
  if (previous.operationId !== next.operationId ||
      previous.requestDigest !== next.requestDigest ||
      previous.authorityBase64 !== next.authorityBase64 ||
      previous.quarantineResultBase64 !== next.quarantineResultBase64 ||
      (previous.settleResultBase64 !== next.settleResultBase64 &&
        previous.state !== 'QUARANTINED')) {
    fail('rollback-create publication immutable authority changed');
  }
  if ((previous.state === 'QUARANTINED' && next.state === 'ROLLED_BACK' &&
       next.settleResultBase64 !== null) ||
      (previous.state === 'ROLLED_BACK' && next.state === 'ACK_COMMITTED' &&
       previous.settleResultBase64 === next.settleResultBase64)) return next;
  fail('rollback-create publication transition is invalid');
}

function assertExistingTerminalPublication(raw) {
  const value = valuesOf(
    raw,
    KEYS.EXISTING_TERMINAL_PUBLICATION,
    'EXISTING terminal publication'
  );
  if (value.schema !== SCHEMAS.EXISTING_TERMINAL_PUBLICATION ||
      value.command !== 'EXECUTE_EXISTING' ||
      !['COMMITTED', 'FINALIZED', 'ACK_PREPARED', 'ACK_COMMITTED'].includes(value.state) ||
      !OPERATION_ID_RE.test(value.operationId || '') ||
      value.recoveryFsyncComplete !== true || typeof value.baseHistoryExists !== 'boolean' ||
      !Number.isSafeInteger(value.baseHistoryByteLength) || value.baseHistoryByteLength < 0) {
    fail('EXISTING terminal publication identity is invalid');
  }
  const items = denseArray(value.items, 'EXISTING terminal publication items')
    .map((item, index) => assertExistingTerminalItem(item, index));
  if (items.length < 1 || items.length > MAX_EXISTING_TERMINAL_ITEMS) {
    fail('EXISTING terminal publication item count is invalid');
  }
  const names = items.flatMap(item => [item.controlBasename, item.applyBasename]);
  const selectedIds = items.map(item => item.selectedId);
  const identityDigests = items.flatMap(item => [
    evidence.digestObject(EXISTING_LEAF_IDENTITY_SCHEMA, item.finalLeafIdentity),
    evidence.digestObjectIdentity(item.controlRecordIdentity),
    evidence.digestObjectIdentity(item.applyRecordIdentity),
  ]);
  if (new Set(names).size !== names.length || new Set(selectedIds).size !== selectedIds.length ||
      new Set(identityDigests).size !== identityDigests.length) {
    fail('EXISTING terminal publication item authority is duplicated');
  }
  const baseHistoryContentDigest = digest(
    value.baseHistoryContentDigest,
    'baseHistoryContentDigest',
    true
  );
  if ((!value.baseHistoryExists && (value.baseHistoryByteLength !== 0 ||
      baseHistoryContentDigest !== null)) ||
      (value.baseHistoryExists && (value.baseHistoryByteLength === 0 ||
       baseHistoryContentDigest === null))) {
    fail('EXISTING terminal publication base History authority is invalid');
  }
  const finalization = value.finalization === null
    ? null
    : assertExistingFinalization(value.finalization, value.operationId);
  if ((value.state === 'COMMITTED') !== (finalization === null)) {
    fail('EXISTING terminal finalization state is invalid');
  }
  const cleanupStates = items.flatMap(item => [
    item.controlCleanupState,
    item.applyCleanupState,
  ]).concat(finalization === null ? [] : [finalization.cleanupState]);
  if (['COMMITTED', 'FINALIZED'].includes(value.state) &&
      cleanupStates.some(state => state !== 'PUBLISHED')) {
    fail('EXISTING pre-ACK publication cannot claim cleanup progress');
  }
  if (value.state === 'ACK_PREPARED' && cleanupStates.some(state =>
    !['CLEANUP_ARMED', 'REMOVED'].includes(state))) {
    fail('EXISTING ACK_PREPARED requires exact cleanup authority');
  }
  if (value.state === 'ACK_COMMITTED' && cleanupStates.some(state => state !== 'REMOVED')) {
    fail('EXISTING ACK_COMMITTED requires every private record removed');
  }
  const valid = Object.freeze({
    schema: SCHEMAS.EXISTING_TERMINAL_PUBLICATION,
    command: 'EXECUTE_EXISTING',
    state: value.state,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'existing.requestDigest'),
    createdReceiptPhaseDigest: digest(
      value.createdReceiptPhaseDigest,
      'existing.createdReceiptPhaseDigest'
    ),
    markerDigest: digest(value.markerDigest, 'existing.markerDigest'),
    artifactDigest: digest(value.artifactDigest, 'existing.artifactDigest'),
    artifactIdentityDigest: digest(
      value.artifactIdentityDigest,
      'existing.artifactIdentityDigest'
    ),
    selectionDigest: digest(value.selectionDigest, 'existing.selectionDigest'),
    baseHistoryDigest: digest(value.baseHistoryDigest, 'existing.baseHistoryDigest'),
    baseHistoryByteLength: value.baseHistoryByteLength,
    baseHistoryExists: value.baseHistoryExists,
    baseHistoryContentDigest,
    historyParentIdentityDigest: digest(
      value.historyParentIdentityDigest,
      'existing.historyParentIdentityDigest'
    ),
    projectRootIdentityDigest: digest(
      value.projectRootIdentityDigest,
      'existing.projectRootIdentityDigest'
    ),
    recoveryDirectoryIdentityDigest: digest(
      value.recoveryDirectoryIdentityDigest,
      'existing.recoveryDirectoryIdentityDigest'
    ),
    predecessorValueDigest: digest(
      value.predecessorValueDigest,
      'existing.predecessorValueDigest'
    ),
    installedGeneration: generation(value.installedGeneration, 'existing.installedGeneration'),
    items: Object.freeze(items),
    receiptSetDigest: digest(value.receiptSetDigest, 'existing.receiptSetDigest'),
    terminalReceiptDigest: digest(
      value.terminalReceiptDigest,
      'existing.terminalReceiptDigest'
    ),
    recoveryFsyncComplete: true,
    finalization,
    publicationDigest: digest(value.publicationDigest, 'existing.publicationDigest'),
  });
  if (valid.publicationDigest !== existingTerminalPublicationDigest(valid) ||
      evidence.canonicalJsonByteLength(valid) > MAX_EXISTING_TERMINAL_PUBLICATION_BYTES) {
    fail('EXISTING terminal publication digest or budget is invalid');
  }
  return valid;
}

function valueDigest(raw) {
  const source = valuesOf(raw, KEYS.VALUE, 'marker journal value digest input');
  const value = Object.fromEntries(KEYS.VALUE.map(key => [
    key,
    key === 'valueDigest' ? null : source[key],
  ]));
  return evidence.digestObject(SCHEMAS.VALUE, value, 'valueDigest');
}

function cleanupDigest(raw) {
  const source = valuesOf(raw, KEYS.CLEANUP, 'terminal cleanup digest input');
  const value = Object.fromEntries(KEYS.CLEANUP.map(key => [
    key,
    key === 'cleanupDigest' ? null : source[key],
  ]));
  return evidence.digestObject(SCHEMAS.CLEANUP, value, 'cleanupDigest');
}

function publicationSetDigest(operationId, kind, nativePublicationDigest,
  existingTerminalPublicationDigest) {
  const value = {
    schema: SCHEMAS.PUBLICATION_SET,
    operationId,
    kind,
    nativePublicationDigest,
    existingTerminalPublicationDigest,
  };
  valuesOf(value, KEYS.PUBLICATION_SET, 'terminal publication set digest input');
  if (!OPERATION_ID_RE.test(operationId || '') || !KINDS.includes(kind)) {
    fail('terminal publication set identity is invalid');
  }
  const nativeDigest = digest(
    nativePublicationDigest,
    'publicationSet.nativePublicationDigest',
    true
  );
  const existingDigest = digest(
    existingTerminalPublicationDigest,
    'publicationSet.existingTerminalPublicationDigest',
    true
  );
  if (nativeDigest === null && existingDigest === null) return null;
  return evidence.digestObject(SCHEMAS.PUBLICATION_SET, {
    schema: SCHEMAS.PUBLICATION_SET,
    operationId,
    kind,
    nativePublicationDigest: nativeDigest,
    existingTerminalPublicationDigest: existingDigest,
  });
}

function publicRecordSetDigest(operationId, kind, rawDigests) {
  const records = denseArray(rawDigests, 'terminal public record digests')
    .map((value, index) => digest(value, `publicRecordDigests[${index}]`));
  if (PUBLICATION_KINDS.includes(kind) && records.length === 0) {
    fail('Snapshot terminal cleanup requires public record truth');
  }
  if (new Set(records).size !== records.length) {
    fail('terminal public record truth is duplicated');
  }
  return Object.freeze({
    records: Object.freeze(records),
    digest: evidence.digestObject(SCHEMAS.PUBLIC_RECORD_SET, {
      schema: SCHEMAS.PUBLIC_RECORD_SET,
      operationId,
      kind,
      records,
    }),
  });
}

function assertTerminalCleanup(raw) {
  const value = valuesOf(raw, KEYS.CLEANUP, 'terminal cleanup authority');
  if (value.schema !== SCHEMAS.CLEANUP || !OPERATION_ID_RE.test(value.operationId || '') ||
      !KINDS.includes(value.kind) || !['NONE', 'ACK_COMMITTED'].includes(value.publicationState) ||
      !['NONE', 'ACK_COMMITTED'].includes(value.existingTerminalPublicationState) ||
      value.recoveryDirectoryFsyncComplete !== true) {
    fail('terminal cleanup authority identity is invalid');
  }
  const publicationDigestValue = digest(
    value.publicationDigest,
    'cleanup.publicationDigest',
    true
  );
  if ((value.publicationState === 'NONE') !== (publicationDigestValue === null)) {
    fail('terminal cleanup publication truth is invalid');
  }
  const existingTerminalPublicationDigestValue = digest(
    value.existingTerminalPublicationDigest,
    'cleanup.existingTerminalPublicationDigest',
    true
  );
  if ((value.existingTerminalPublicationState === 'NONE') !==
      (existingTerminalPublicationDigestValue === null)) {
    fail('terminal cleanup EXISTING publication truth is invalid');
  }
  const terminalPhaseDigest = digest(
    value.terminalPhaseDigest,
    'cleanup.terminalPhaseDigest',
    true
  );
  const artifactCleanupDigest = digest(
    value.artifactCleanupDigest,
    'cleanup.artifactCleanupDigest',
    true
  );
  if (PUBLICATION_KINDS.includes(value.kind) &&
      (terminalPhaseDigest === null || artifactCleanupDigest === null)) {
    fail('Snapshot terminal cleanup lacks phase or artifact authority');
  }
  const publicRecords = publicRecordSetDigest(
    value.operationId,
    value.kind,
    value.publicRecordDigests
  );
  if (value.publicRecordSetDigest !== publicRecords.digest) {
    fail('terminal public record set digest cannot be reproduced');
  }
  const expectedPublicationSetDigest = publicationSetDigest(
    value.operationId,
    value.kind,
    publicationDigestValue,
    existingTerminalPublicationDigestValue
  );
  if (value.publicationSetDigest !== expectedPublicationSetDigest) {
    fail('terminal publication set digest cannot be reproduced');
  }
  const valid = Object.freeze({
    schema: SCHEMAS.CLEANUP,
    operationId: value.operationId,
    kind: value.kind,
    terminalPhaseDigest,
    historyStateDigest: digest(value.historyStateDigest, 'cleanup.historyStateDigest'),
    artifactCleanupDigest,
    publicRecordDigests: publicRecords.records,
    publicRecordSetDigest: publicRecords.digest,
    publicationState: value.publicationState,
    publicationDigest: publicationDigestValue,
    existingTerminalPublicationState: value.existingTerminalPublicationState,
    existingTerminalPublicationDigest: existingTerminalPublicationDigestValue,
    publicationSetDigest: expectedPublicationSetDigest,
    recoveryDirectoryFsyncComplete: true,
    cleanupDigest: digest(value.cleanupDigest, 'cleanup.cleanupDigest'),
  });
  if (valid.cleanupDigest !== cleanupDigest(valid)) {
    fail('terminal cleanup authority digest cannot be reproduced');
  }
  return valid;
}

function buildTerminalCleanup(raw) {
  const inputKeys = KEYS.CLEANUP_BUILD;
  const value = valuesOf(raw, inputKeys, 'terminal cleanup builder input');
  const cleanup = Object.fromEntries(inputKeys.map(key => [key, value[key]]));
  cleanup.publicRecordSetDigest = publicRecordSetDigest(
    cleanup.operationId,
    cleanup.kind,
    cleanup.publicRecordDigests
  ).digest;
  cleanup.publicationSetDigest = publicationSetDigest(
    cleanup.operationId,
    cleanup.kind,
    cleanup.publicationDigest,
    cleanup.existingTerminalPublicationDigest
  );
  cleanup.cleanupDigest = null;
  cleanup.cleanupDigest = cleanupDigest(cleanup);
  return assertTerminalCleanup(cleanup);
}

function assertJournalValue(raw) {
  const value = valuesOf(raw, KEYS.VALUE, 'marker journal value');
  if (value.schema !== SCHEMAS.VALUE || !JOURNAL_ID_RE.test(value.journalId || '') ||
      !VALUE_STATES.includes(value.state)) fail('marker journal value identity is invalid');
  const state = value.state;
  const idle = state === 'IDLE';
  const projectId = boundedString(value.projectId, 'projectId');
  const activeOperationId = idle
    ? value.activeOperationId
    : (OPERATION_ID_RE.test(value.activeOperationId || '')
      ? value.activeOperationId
      : fail('active operation identity is invalid'));
  const activeKind = idle
    ? value.activeKind
    : (KINDS.includes(value.activeKind) ? value.activeKind : fail('active kind is invalid'));
  const activeMarker = idle
    ? value.activeMarker
    : assertActiveMarker(value.activeMarker, activeOperationId, projectId, activeKind);
  const activeMarkerDigestValue = digest(
    value.activeMarkerDigest,
    'activeMarkerDigest',
    true
  );
  const nativePublication = value.nativePublication === null
    ? null
    : assertPublication(value.nativePublication);
  const existingTerminalPublication = value.existingTerminalPublication === null
    ? null
    : assertExistingTerminalPublication(value.existingTerminalPublication);
  const rollbackCreatePublication = value.rollbackCreatePublication === null
    ? null
    : (value.rollbackCreatePublication.schema ===
        SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION
      ? assertRollbackCreateAttemptPublication(value.rollbackCreatePublication)
      : assertRollbackCreatePublication(value.rollbackCreatePublication));
  const terminalCleanup = value.terminalCleanup === null
    ? null
    : assertTerminalCleanup(value.terminalCleanup);
  const terminalCleanupDigest = digest(
    value.terminalCleanupDigest,
    'terminalCleanupDigest',
    true
  );
  if (idle && (activeOperationId !== null || activeKind !== null ||
      activeMarker !== null || activeMarkerDigestValue !== null || nativePublication !== null ||
      existingTerminalPublication !== null || rollbackCreatePublication !== null ||
      terminalCleanup !== null || terminalCleanupDigest !== null)) {
    fail('IDLE journal retains active authority');
  }
  if (!idle && (activeMarker === null || activeMarkerDigestValue === null ||
      activeMarkerDigestValue !== activeMarkerDigest(activeMarker))) {
    fail('ACTIVE journal lacks an exact marker preimage');
  }
  if (nativePublication && nativePublication.operationId !== activeOperationId) {
    fail('native publication operation does not bind ACTIVE value');
  }
  if (nativePublication && nativePublication.kind !== activeKind) {
    fail('native publication kind does not bind ACTIVE value');
  }
  if (existingTerminalPublication && (activeKind !== 'snapshot_restore' ||
      existingTerminalPublication.operationId !== activeOperationId ||
      BigInt(existingTerminalPublication.installedGeneration) > BigInt(value.generation))) {
    fail('EXISTING terminal publication does not bind ACTIVE Snapshot value');
  }
  if (existingTerminalPublication) {
    const phase = activeMarker?.publicMarkdownPhase?.phase;
    const phaseValid = existingTerminalPublication.state === 'COMMITTED'
      ? ['EXISTING_COMMITTED', 'HISTORY_COMMITTED'].includes(phase)
      : phase === 'FINALIZED';
    if (!phaseValid) {
      fail('EXISTING terminal publication state does not bind marker phase authority');
    }
  }
  if (rollbackCreatePublication && (activeKind !== 'snapshot_restore' ||
      rollbackCreatePublication.operationId !== activeOperationId)) {
    fail('rollback-create publication does not bind ACTIVE Snapshot value');
  }
  if (rollbackCreatePublication) {
    const phase = activeMarker?.publicMarkdownPhase?.phase;
    const expectedPhase = rollbackCreatePublication.state === 'PREPARED'
      ? 'CREATED_RECEIPT'
      : (rollbackCreatePublication.state === 'QUARANTINED'
        ? 'CREATE_ROLLBACK_QUARANTINED'
        : 'ROLLED_BACK');
    if (phase !== expectedPhase) {
      fail('rollback-create publication state does not bind marker phase authority');
    }
  }
  if (nativePublication && nativePublication.createFinalization !== null &&
      activeMarker?.publicMarkdownPhase?.phase !== 'HISTORY_COMMITTED') {
    fail('CREATE_MISSING finalization requires exact HISTORY_COMMITTED marker authority');
  }
  if ((terminalCleanup === null) !== (terminalCleanupDigest === null) ||
      (terminalCleanup && (terminalCleanup.cleanupDigest !== terminalCleanupDigest ||
       terminalCleanup.operationId !== activeOperationId || terminalCleanup.kind !== activeKind))) {
    fail('terminal cleanup authority does not bind ACTIVE value');
  }
  if (terminalCleanup &&
      (terminalCleanup.publicationState === 'ACK_COMMITTED'
        ? (!nativePublication || nativePublication.state !== 'ACK_COMMITTED' ||
           terminalCleanup.publicationDigest !== nativePublication.publicationDigest)
        : nativePublication !== null)) {
    fail('terminal cleanup does not bind exact publication cleanup truth');
  }
  if (terminalCleanup &&
      (terminalCleanup.existingTerminalPublicationState === 'ACK_COMMITTED'
        ? (!existingTerminalPublication ||
           existingTerminalPublication.state !== 'ACK_COMMITTED' ||
           terminalCleanup.existingTerminalPublicationDigest !==
             existingTerminalPublication.publicationDigest)
        : existingTerminalPublication !== null)) {
    fail('terminal cleanup does not bind exact EXISTING publication cleanup truth');
  }
  const valid = Object.freeze({
    schema: SCHEMAS.VALUE,
    journalId: value.journalId,
    generation: generation(value.generation),
    previousValueDigest: digest(value.previousValueDigest, 'previousValueDigest', true),
    state,
    projectId,
    activeOperationId,
    activeKind,
    activeMarker,
    activeMarkerDigest: activeMarkerDigestValue,
    nativePublication,
    existingTerminalPublication,
    rollbackCreatePublication,
    terminalCleanup,
    terminalCleanupDigest,
    valueDigest: digest(value.valueDigest, 'valueDigest'),
  });
  if ((valid.generation === '0') !== (valid.previousValueDigest === null) ||
      valid.valueDigest !== valueDigest(valid) ||
      evidence.canonicalJsonByteLength(valid) > MAX_VALUE_BYTES) {
    fail('marker journal value digest chain or budget is invalid');
  }
  return valid;
}

function immutablePublicationEqual(previous, next) {
  return previous.kind === next.kind && previous.command === next.command &&
    previous.operationId === next.operationId && previous.requestDigest === next.requestDigest &&
    previous.phaseDigest === next.phaseDigest &&
    previous.createAttemptDigest === next.createAttemptDigest &&
    previous.createCleanupFinalBasename === next.createCleanupFinalBasename &&
    evidence.canonicalJson(previous.createCleanupFinalRecordIdentity) ===
      evidence.canonicalJson(next.createCleanupFinalRecordIdentity) &&
    evidence.canonicalJson(previous.createFinalization) ===
      evidence.canonicalJson(next.createFinalization);
}

function assertRecordProgress(previousRecords, nextRecords, previousState, nextState) {
  if (nextRecords.length < previousRecords.length || nextRecords.length > previousRecords.length + 1) {
    fail('publication may arm at most one new record per journal generation');
  }
  const rank = { ARMED: 0, PUBLISHED: 1, CLEANUP_ARMED: 2, REMOVED: 3 };
  for (let index = 0; index < previousRecords.length; index += 1) {
    const previous = previousRecords[index];
    const next = nextRecords[index];
    if (!next || previous.role !== next.role || previous.ordinal !== next.ordinal ||
        previous.stageBasename !== next.stageBasename ||
        previous.destinationBasename !== next.destinationBasename ||
        previous.recordDigest !== next.recordDigest ||
        evidence.canonicalJson(previous.recordIdentity) !== evidence.canonicalJson(next.recordIdentity) ||
        rank[next.state] < rank[previous.state] || rank[next.state] > rank[previous.state] + 1 ||
        (previous.cleanupBasename !== null && previous.cleanupBasename !== next.cleanupBasename)) {
      fail('native record publication authority was replaced or skipped');
    }
  }
  if (nextRecords.length === previousRecords.length + 1 && nextState !== 'ARMED') {
    fail('new record authority may only be appended while ARMED');
  }
  if (nextRecords.length === previousRecords.length + 1 &&
      nextRecords[nextRecords.length - 1].state !== 'ARMED') {
    fail('new record authority must begin at ARMED');
  }
  if (['COMMITTED', 'ACK_PREPARED', 'ACK_COMMITTED'].includes(previousState) &&
      nextRecords.length !== previousRecords.length) fail('committed record set is immutable');
}

function assertMutationProgress(previous, next) {
  const rank = { UNARMED: 0, ARMED: 1, COMMITTED: 2 };
  if (rank[next.state] < rank[previous.state] || rank[next.state] > rank[previous.state] + 1 ||
      (previous.state !== 'UNARMED' &&
       (previous.sourceIdentityDigest !== next.sourceIdentityDigest ||
        previous.privateBasename !== next.privateBasename))) {
    fail('native mutation authority was replaced or skipped');
  }
}

function assertCreatePrivateRecordProgress(previous, next, transition) {
  const immutableKeys = [
    'schema', 'role', 'selectedId', 'path', 'contentDigest',
    'ancestorIdentityDigest', 'deterministicBasename', 'logicalDigest',
    'boundControlDigest', 'rawSha256', 'recordIdentity',
  ];
  const previousImmutable = Object.fromEntries(immutableKeys.map(key => [key, previous[key]]));
  const nextImmutable = Object.fromEntries(immutableKeys.map(key => [key, next[key]]));
  if (evidence.canonicalJson(previousImmutable) !== evidence.canonicalJson(nextImmutable)) {
    fail('captured CREATE_MISSING private record authority was replaced');
  }
  if (transition === 'COMMIT' &&
      (previous.state !== 'PUBLISHED' || next.state !== 'PUBLISHED' ||
       next.cleanupBasename !== null)) {
    fail('CREATE_MISSING commit must preserve exact captured records');
  }
  if (transition === 'ARM_CLEANUP' &&
      (previous.state !== 'PUBLISHED' || next.state !== 'CLEANUP_ARMED' ||
       next.cleanupBasename === null)) {
    fail('CREATE_MISSING cleanup must arm every exact private record once');
  }
  if (transition === 'REMOVE' && !(
    (previous.state === 'CLEANUP_ARMED' &&
      ['CLEANUP_ARMED', 'REMOVED'].includes(next.state) &&
      previous.cleanupBasename === next.cleanupBasename) ||
    (previous.state === 'REMOVED' && next.state === 'REMOVED' &&
      previous.cleanupBasename === next.cleanupBasename)
  )) fail('CREATE_MISSING record removal progress is invalid');
}

function assertCreateCaptureProgress(previous, next, transition) {
  if (!previous || !next || previous.items.length !== next.items.length) {
    fail('CREATE_MISSING capture set was omitted or resized');
  }
  for (let index = 0; index < previous.items.length; index += 1) {
    const left = previous.items[index];
    const right = next.items[index];
    const immutableKeys = [
      'schema', 'ordinal', 'selectedId', 'path', 'contentDigest',
      'ancestorIdentityDigest', 'createdLeafIdentity', 'creationReceiptDigest',
    ];
    if (evidence.canonicalJson(Object.fromEntries(immutableKeys.map(key => [key, left[key]]))) !==
        evidence.canonicalJson(Object.fromEntries(immutableKeys.map(key => [key, right[key]])))) {
      fail('CREATE_MISSING captured leaf authority was replaced or reordered');
    }
    assertCreatePrivateRecordProgress(left.control, right.control, transition);
    assertCreatePrivateRecordProgress(left.receipt, right.receipt, transition);
  }
}

function createCleanupBasename(operationId, finalAckDigest, ordinal, record) {
  const key = {
    schema: CREATE_CLEANUP_NAME_KEY_SCHEMA,
    operationId,
    finalAckDigest,
    ordinal,
    role: record.role,
    sourceBasename: record.deterministicBasename,
    recordDigest: record.rawSha256,
  };
  return `.changes-history-native-create-cleanup.${
    evidence.digestObject(CREATE_CLEANUP_NAME_KEY_SCHEMA, key).slice(7)
  }`;
}

function assertCreateCleanupArmTransition(previous, next) {
  const finalization = previous.createFinalization;
  if (finalization?.state !== 'CAPTURED' || next.createFinalization !== null ||
      !immutablePublicationEqual({
        ...previous,
        createFinalization: null,
        createCleanupFinalBasename: finalization.finalBasename,
        createCleanupFinalRecordIdentity: finalization.finalRecordIdentity,
      }, next) ||
      next.createCleanupFinalBasename !== finalization.finalBasename ||
      evidence.canonicalJson(next.createCleanupFinalRecordIdentity) !==
        evidence.canonicalJson(finalization.finalRecordIdentity) ||
      next.previousPublicationDigest !== previous.publicationDigest) {
    fail('CREATE_MISSING cleanup must consume exact CAPTURED finalization authority');
  }
  assertCreateCaptureProgress(previous.createCapture, next.createCapture, 'ARM_CLEANUP');
  let ordinal = 0;
  for (let index = 0; index < previous.createCapture.items.length; index += 1) {
    const before = previous.createCapture.items[index];
    const after = next.createCapture.items[index];
    for (const role of ['control', 'receipt']) {
      const expected = createCleanupBasename(
        previous.operationId,
        finalization.finalAckDigest,
        ordinal,
        before[role]
      );
      if (after[role].cleanupBasename !== expected) {
        fail('CREATE_MISSING cleanup basename does not bind captured finalization authority');
      }
      ordinal += 1;
    }
  }
  return next;
}

function assertPublicationTransition(rawPrevious, rawNext) {
  const previous = assertPublication(rawPrevious);
  const next = assertPublication(rawNext);
  if (evidence.canonicalJson(previous) === evidence.canonicalJson(next)) return next;
  if (previous.command === 'CREATE_MISSING' && previous.state === 'PREPARED' &&
      next.state === 'PREPARED') {
    if (previous.createAttemptDigest !== null || next.createAttemptDigest === null ||
        !immutablePublicationEqual(
          { ...previous, createAttemptDigest: next.createAttemptDigest },
          next
        ) || next.previousPublicationDigest !== previous.publicationDigest ||
        previous.createCapture !== null || next.createCapture !== null) {
      fail('CREATE_MISSING attempt latch transition is invalid');
    }
    return next;
  }
  if (previous.command === 'CREATE_MISSING' && previous.state === 'COMMITTED' &&
      next.state === 'COMMITTED' &&
      evidence.canonicalJson(previous.createFinalization) !==
        evidence.canonicalJson(next.createFinalization)) {
    const left = previous.createFinalization;
    const right = next.createFinalization;
    const allowed = (left === null && right?.state === 'PREPARED') ||
      (left?.state === 'PREPARED' && right?.state === 'CAPTURED' &&
       right.previousFinalizationDigest === left.finalizationDigest);
    if (!allowed || !immutablePublicationEqual(
      { ...previous, createFinalization: right },
      next
    ) || next.previousPublicationDigest !== previous.publicationDigest) {
      fail('CREATE_MISSING finalization transition is invalid');
    }
    return next;
  }
  if (previous.command === 'CREATE_MISSING' && previous.state === 'COMMITTED' &&
      next.state === 'ACK_PREPARED') {
    return assertCreateCleanupArmTransition(previous, next);
  }
  const allowed = {
    PREPARED: ['ARMED'],
    ARMED: ['ARMED', 'COMMITTED'],
    COMMITTED: ['ACK_PREPARED'],
    ACK_PREPARED: ['ACK_PREPARED', 'ACK_COMMITTED'],
    ACK_COMMITTED: [],
  };
  if (!immutablePublicationEqual(previous, next) || !allowed[previous.state].includes(next.state) ||
      next.previousPublicationDigest !== previous.publicationDigest) {
    fail('native publication transition is invalid');
  }
  if (previous.command === 'CREATE_MISSING') {
    if (previous.state === 'PREPARED' && next.state === 'ARMED') {
      if (previous.createAttemptDigest === null || previous.createCapture !== null ||
          next.createCapture === null) {
        fail('CREATE_MISSING success capture installation is invalid');
      }
      return next;
    }
    const transition = previous.state === 'ARMED' && next.state === 'COMMITTED'
      ? 'COMMIT'
      : previous.state === 'COMMITTED' && next.state === 'ACK_PREPARED'
        ? 'ARM_CLEANUP'
        : 'REMOVE';
    assertCreateCaptureProgress(previous.createCapture, next.createCapture, transition);
    return next;
  }
  assertRecordProgress(previous.records, next.records, previous.state, next.state);
  assertMutationProgress(previous.mutation, next.mutation);
  return next;
}

function immutableExistingTerminalPublicationEqual(previous, next, options = {}) {
  const ignoreState = options.ignoreState === true;
  const ignoreFinalization = options.ignoreFinalization === true;
  const ignoreCleanupState = options.ignoreCleanupState === true;
  const existingItems = ignoreCleanupState
    ? previous.items.map(item => ({
      ...item,
      controlCleanupState: null,
      applyCleanupState: null,
    }))
    : previous.items;
  const nextItems = ignoreCleanupState
    ? next.items.map(item => ({
      ...item,
      controlCleanupState: null,
      applyCleanupState: null,
    }))
    : next.items;
  const existingFinalization = ignoreCleanupState && previous.finalization !== null
    ? { ...previous.finalization, cleanupState: null }
    : previous.finalization;
  const nextFinalization = ignoreCleanupState && next.finalization !== null
    ? { ...next.finalization, cleanupState: null }
    : next.finalization;
  return (ignoreState || previous.state === next.state) &&
    previous.command === next.command && previous.operationId === next.operationId &&
    previous.requestDigest === next.requestDigest &&
    previous.createdReceiptPhaseDigest === next.createdReceiptPhaseDigest &&
    previous.markerDigest === next.markerDigest &&
    previous.artifactDigest === next.artifactDigest &&
    previous.artifactIdentityDigest === next.artifactIdentityDigest &&
    previous.selectionDigest === next.selectionDigest &&
    previous.baseHistoryDigest === next.baseHistoryDigest &&
    previous.baseHistoryByteLength === next.baseHistoryByteLength &&
    previous.baseHistoryExists === next.baseHistoryExists &&
    previous.baseHistoryContentDigest === next.baseHistoryContentDigest &&
    previous.historyParentIdentityDigest === next.historyParentIdentityDigest &&
    previous.projectRootIdentityDigest === next.projectRootIdentityDigest &&
    previous.recoveryDirectoryIdentityDigest === next.recoveryDirectoryIdentityDigest &&
    previous.predecessorValueDigest === next.predecessorValueDigest &&
    previous.installedGeneration === next.installedGeneration &&
    previous.receiptSetDigest === next.receiptSetDigest &&
    previous.terminalReceiptDigest === next.terminalReceiptDigest &&
    previous.recoveryFsyncComplete === next.recoveryFsyncComplete &&
    evidence.canonicalJson(existingItems) === evidence.canonicalJson(nextItems) &&
    (ignoreFinalization || evidence.canonicalJson(existingFinalization) ===
      evidence.canonicalJson(nextFinalization));
}

function assertExistingCleanupProgress(previous, next, transition) {
  const rank = { PUBLISHED: 0, CLEANUP_ARMED: 1, REMOVED: 2 };
  const left = previous.items.flatMap(item => [
    item.controlCleanupState,
    item.applyCleanupState,
  ]).concat([previous.finalization.cleanupState]);
  const right = next.items.flatMap(item => [
    item.controlCleanupState,
    item.applyCleanupState,
  ]).concat([next.finalization.cleanupState]);
  if (left.length !== right.length) fail('EXISTING cleanup authority set was resized');
  for (let index = 0; index < left.length; index += 1) {
    if (transition === 'ARM') {
      if (left[index] !== 'PUBLISHED' || right[index] !== 'CLEANUP_ARMED') {
        fail('EXISTING cleanup authority must arm every exact record once');
      }
    } else if (!(
      (left[index] === 'CLEANUP_ARMED' &&
        ['CLEANUP_ARMED', 'REMOVED'].includes(right[index])) ||
      (left[index] === 'REMOVED' && right[index] === 'REMOVED')
    ) || rank[right[index]] < rank[left[index]]) {
      fail('EXISTING cleanup removal progress is invalid');
    }
  }
}

function immutableExistingFinalizationEqual(previous, next) {
  if (previous === null || next === null) return previous === next;
  return evidence.canonicalJson({
    ...previous,
    cleanupState: null,
    finalizationDigest: null,
  }) === evidence.canonicalJson({
    ...next,
    cleanupState: null,
    finalizationDigest: null,
  });
}

function assertExistingTerminalPublicationTransition(rawPrevious, rawNext) {
  const previous = assertExistingTerminalPublication(rawPrevious);
  const next = assertExistingTerminalPublication(rawNext);
  if (evidence.canonicalJson(previous) === evidence.canonicalJson(next)) return next;
  if (!immutableExistingTerminalPublicationEqual(previous, next, {
    ignoreState: true,
    ignoreFinalization: true,
    ignoreCleanupState: true,
  })) {
    fail('EXISTING terminal publication immutable authority changed');
  }
  if (previous.state === 'COMMITTED' && next.state === 'FINALIZED') {
    if (previous.finalization !== null || next.finalization === null) {
      fail('EXISTING terminal finalization install is invalid');
    }
    return next;
  }
  if (previous.state === 'FINALIZED' && next.state === 'ACK_PREPARED') {
    if (!immutableExistingFinalizationEqual(previous.finalization, next.finalization)) {
      fail('EXISTING cleanup changed finalization authority');
    }
    assertExistingCleanupProgress(previous, next, 'ARM');
    return next;
  }
  if (previous.state === 'ACK_PREPARED' &&
      ['ACK_PREPARED', 'ACK_COMMITTED'].includes(next.state)) {
    if (!immutableExistingFinalizationEqual(previous.finalization, next.finalization)) {
      fail('EXISTING cleanup changed finalization authority');
    }
    assertExistingCleanupProgress(previous, next, 'REMOVE');
    return next;
  }
  fail('EXISTING terminal publication transition is invalid');
}

function assertTransition(rawPrevious, rawNext) {
  const previous = assertJournalValue(rawPrevious);
  const next = assertJournalValue(rawNext);
  if (evidence.canonicalJson(previous) === evidence.canonicalJson(next)) return next;
  if (next.journalId !== previous.journalId || next.projectId !== previous.projectId ||
      next.generation !== nextGeneration(previous.generation) ||
      next.previousValueDigest !== previous.valueDigest) {
    fail('journal transition does not CAS the exact preceding value');
  }
  if (previous.state === 'IDLE') {
    if (next.state !== 'ACTIVE' || previous.generation !== '0' &&
        previous.terminalCleanupDigest !== null || next.nativePublication !== null ||
        next.existingTerminalPublication !== null ||
        next.rollbackCreatePublication !== null ||
        next.terminalCleanup !== null || next.terminalCleanupDigest !== null) {
      fail('IDLE may only begin one clean ACTIVE operation');
    }
    return next;
  }
  if (next.state === 'IDLE') {
    if (previous.terminalCleanup === null || previous.terminalCleanupDigest === null ||
        (previous.nativePublication !== null &&
         previous.nativePublication.state !== 'ACK_COMMITTED') ||
        (previous.rollbackCreatePublication !== null &&
         previous.rollbackCreatePublication.state !== 'ACK_COMMITTED') ||
        (previous.existingTerminalPublication !== null &&
         previous.existingTerminalPublication.state !== 'ACK_COMMITTED')) {
      fail('ACTIVE may return to IDLE only after exact terminal cleanup');
    }
    return next;
  }
  if (next.activeOperationId !== previous.activeOperationId) {
    fail('ACTIVE journal operation identity cannot change');
  }
  if (next.activeKind !== previous.activeKind) fail('ACTIVE journal kind cannot change');
  if (previous.nativePublication === null) {
    if (next.nativePublication !== null && next.nativePublication.state !== 'PREPARED') {
      fail('native authority must begin at PREPARED');
    }
    if (previous.rollbackCreatePublication !== null && next.nativePublication !== null) {
      fail('rollback-create authority cannot resurrect the CREATE publication');
    }
  } else if (next.nativePublication === null) {
    // The CREATE publication is the only authority for the created MISSING
    // leaves, so it may be dropped only at the single CAS where the durable
    // rollback publication takes that authority over: the attempt latch must
    // already exist, the quarantine result must be published, and the phase must
    // have advanced to CREATE_ROLLBACK_QUARANTINED.
    if (next.rollbackCreatePublication === null ||
        next.rollbackCreatePublication.schema !== SCHEMAS.ROLLBACK_CREATE_PUBLICATION ||
        next.rollbackCreatePublication.state !== 'QUARANTINED' ||
        previous.rollbackCreatePublication?.schema !==
          SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION ||
        next.rollbackCreatePublication.operationId !== previous.activeOperationId) {
      fail('a surviving ACTIVE value cannot drop native publication authority');
    }
  } else {
    assertPublicationTransition(previous.nativePublication, next.nativePublication);
  }
  if (previous.rollbackCreatePublication === null) {
    if (next.rollbackCreatePublication !== null) {
      if (previous.activeKind !== 'snapshot_restore' ||
          next.rollbackCreatePublication.schema !==
            SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION ||
          next.rollbackCreatePublication.state !== 'PREPARED' ||
          next.rollbackCreatePublication.predecessorValueDigest !== previous.valueDigest ||
          next.rollbackCreatePublication.installedGeneration !== next.generation ||
          next.rollbackCreatePublication.operationId !== previous.activeOperationId ||
          next.nativePublication === null ||
          previous.activeMarker?.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT' ||
          next.activeMarker?.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT') {
        fail('rollback-create attempt install CAS is invalid');
      }
    }
  } else if (next.rollbackCreatePublication === null) {
    fail('a surviving ACTIVE value cannot drop rollback-create publication authority');
  } else if (previous.rollbackCreatePublication.schema ===
      SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION) {
    if (next.rollbackCreatePublication.schema === SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION) {
      if (evidence.canonicalJson(previous.rollbackCreatePublication) !==
          evidence.canonicalJson(next.rollbackCreatePublication)) {
        fail('rollback-create attempt publication cannot change');
      }
    } else if (next.rollbackCreatePublication.schema ===
        SCHEMAS.ROLLBACK_CREATE_PUBLICATION) {
      if (next.rollbackCreatePublication.state !== 'QUARANTINED' ||
          next.rollbackCreatePublication.operationId !==
            previous.rollbackCreatePublication.operationId ||
          next.rollbackCreatePublication.requestDigest !==
            previous.rollbackCreatePublication.requestDigest ||
          next.nativePublication !== null ||
          previous.activeMarker?.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT' ||
          next.activeMarker?.publicMarkdownPhase?.phase !== 'CREATE_ROLLBACK_QUARANTINED') {
        fail('rollback-create attempt settlement CAS is invalid');
      }
    } else {
      fail('rollback-create attempt settlement CAS is invalid');
    }
  } else if (next.rollbackCreatePublication.schema !== SCHEMAS.ROLLBACK_CREATE_PUBLICATION) {
    fail('rollback-create publication cannot return to an attempt latch');
  } else {
    assertRollbackCreatePublicationTransition(
      previous.rollbackCreatePublication,
      next.rollbackCreatePublication
    );
  }
  if (previous.existingTerminalPublication === null) {
    if (next.existingTerminalPublication !== null) {
      if (previous.activeKind !== 'snapshot_restore' ||
          next.existingTerminalPublication.state !== 'COMMITTED' ||
          next.existingTerminalPublication.predecessorValueDigest !== previous.valueDigest ||
          next.existingTerminalPublication.installedGeneration !== next.generation ||
          previous.activeMarker?.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT' ||
          next.activeMarker?.publicMarkdownPhase?.phase !== 'EXISTING_COMMITTED') {
        fail('EXISTING terminal publication install CAS is invalid');
      }
    }
  } else if (next.existingTerminalPublication === null) {
    fail('a surviving ACTIVE value cannot drop EXISTING terminal publication authority');
  } else {
    assertExistingTerminalPublicationTransition(
      previous.existingTerminalPublication,
      next.existingTerminalPublication
    );
  }
  if (previous.terminalCleanupDigest !== null &&
      (next.terminalCleanupDigest !== previous.terminalCleanupDigest ||
       evidence.canonicalJson(next.terminalCleanup) !==
         evidence.canonicalJson(previous.terminalCleanup))) {
    fail('terminal cleanup authority cannot be rewritten or dropped');
  }
  if (previous.terminalCleanupDigest === null && next.terminalCleanupDigest !== null &&
      next.nativePublication !== null && next.nativePublication.state !== 'ACK_COMMITTED') {
    fail('terminal cleanup authority requires committed native ACK truth');
  }
  if (previous.terminalCleanupDigest === null && next.terminalCleanupDigest !== null &&
      next.existingTerminalPublication !== null &&
      next.existingTerminalPublication.state !== 'ACK_COMMITTED') {
    fail('terminal cleanup authority requires committed EXISTING ACK truth');
  }
  return next;
}

function encodeSlotFrame(rawValue, slot) {
  const value = assertJournalValue(rawValue);
  if (!SLOTS.includes(slot)) fail('journal slot is invalid');
  const payload = Buffer.from(`${evidence.canonicalJson(value)}\n`, 'utf8');
  const rawSha256 = evidence.sha256(payload);
  const header = `${JOURNAL_MAGIC}\t${slot}\t${value.journalId}\t${value.generation}\t${payload.length}` +
    `\t${value.valueDigest}\t${value.previousValueDigest === null ? '-' : value.previousValueDigest}` +
    `\t${rawSha256}\n`;
  if (Buffer.byteLength(header, 'utf8') > MAX_HEADER_BYTES ||
      payload.length > MAX_VALUE_BYTES || Buffer.byteLength(header, 'utf8') + payload.length > MAX_FRAME_BYTES) {
    fail('journal slot frame exceeds its frozen budget');
  }
  return Buffer.concat([Buffer.from(header, 'utf8'), payload]);
}

function parseSlotFrame(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_FRAME_BYTES) {
    fail('journal slot frame bytes are invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch (_) { fail('journal slot frame is not valid UTF-8'); }
  if (text.includes('\0')) fail('journal slot frame contains NUL');
  const newline = text.indexOf('\n');
  if (newline < 0 || Buffer.byteLength(text.slice(0, newline + 1), 'utf8') > MAX_HEADER_BYTES) {
    fail('journal slot header is invalid');
  }
  const fields = text.slice(0, newline).split('\t');
  if (fields.length !== 8 || fields[0] !== JOURNAL_MAGIC || !SLOTS.includes(fields[1]) ||
      !JOURNAL_ID_RE.test(fields[2]) || !GENERATION_RE.test(fields[3]) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(fields[4]) || !DIGEST_RE.test(fields[5]) ||
      !(fields[6] === '-' || DIGEST_RE.test(fields[6])) || !DIGEST_RE.test(fields[7])) {
    fail('journal slot header fields are invalid');
  }
  const payload = Buffer.from(text.slice(newline + 1), 'utf8');
  if (payload.length !== Number(fields[4]) || payload[payload.length - 1] !== 0x0a ||
      evidence.sha256(payload) !== fields[7]) fail('journal slot payload bytes are invalid');
  let parsed;
  try { parsed = JSON.parse(payload.toString('utf8')); }
  catch (_) { fail('journal slot payload JSON is invalid'); }
  const value = assertJournalValue(parsed);
  if (value.journalId !== fields[2] || value.generation !== fields[3] ||
      value.valueDigest !== fields[5] ||
      (value.previousValueDigest === null ? '-' : value.previousValueDigest) !== fields[6] ||
      !encodeSlotFrame(value, fields[1]).equals(raw)) {
    fail('journal slot frame is not canonical or does not bind its value');
  }
  return Object.freeze({ slot: fields[1], value });
}

function assertExpectedHead(raw) {
  const value = valuesOf(raw, KEYS.HEAD, 'expected journal head');
  if (value.schema !== SCHEMAS.HEAD || !JOURNAL_ID_RE.test(value.journalId || '')) {
    fail('expected journal head identity is invalid');
  }
  return Object.freeze({
    schema: SCHEMAS.HEAD,
    journalId: value.journalId,
    generation: generation(value.generation, 'expected generation'),
    valueDigest: digest(value.valueDigest, 'expected valueDigest'),
  });
}

function expectedHead(rawValue) {
  const value = assertJournalValue(rawValue);
  return Object.freeze({
    schema: SCHEMAS.HEAD,
    journalId: value.journalId,
    generation: value.generation,
    valueDigest: value.valueDigest,
  });
}

function selectJournalHead(rawFrameA, rawFrameB, rawExpectedHead = null) {
  const parsed = [];
  for (const [expectedSlot, raw] of [['A', rawFrameA], ['B', rawFrameB]]) {
    try {
      const frame = parseSlotFrame(raw);
      if (frame.slot !== expectedSlot) fail('journal frame occupies the wrong fixed slot');
      parsed.push(frame);
    } catch (error) {
      if (!(error instanceof ChangesHistoryMarkerJournalSchemaError)) throw error;
    }
  }
  if (parsed.length === 0) fail('permanent marker journal has no valid slot');
  if (parsed.length === 1) {
    if (rawExpectedHead === null) {
      fail('single valid journal slot requires exact expected head authority');
    }
    const expected = assertExpectedHead(rawExpectedHead);
    const value = parsed[0].value;
    if (expected.journalId !== value.journalId || expected.generation !== value.generation ||
        expected.valueDigest !== value.valueDigest) {
      fail('single valid journal slot does not equal the expected durable head');
    }
    return value;
  }
  const [left, right] = parsed;
  const leftGeneration = BigInt(left.value.generation);
  const rightGeneration = BigInt(right.value.generation);
  if (leftGeneration === rightGeneration) {
    if (left.value.valueDigest !== right.value.valueDigest ||
        evidence.canonicalJson(left.value) !== evidence.canonicalJson(right.value)) {
      fail('equal-generation journal slots disagree');
    }
    return left.value;
  }
  const newer = leftGeneration > rightGeneration ? left.value : right.value;
  const older = leftGeneration > rightGeneration ? right.value : left.value;
  if (BigInt(newer.generation) !== BigInt(older.generation) + 1n ||
      newer.journalId !== older.journalId || newer.projectId !== older.projectId ||
      newer.previousValueDigest !== older.valueDigest) {
    fail('journal slots do not form one exact predecessor chain');
  }
  return assertTransition(older, newer);
}

module.exports = Object.freeze({
  SCHEMAS,
  KEYS,
  JOURNAL_MAGIC,
  JOURNAL_BASENAME,
  SLOTS,
  VALUE_STATES,
  PUBLICATION_STATES,
  RECORD_STATES,
  MUTATION_STATES,
  KINDS,
  PUBLICATION_KINDS,
  COMMANDS,
  COMMANDS_BY_KIND,
  MAX_RECORDS,
  MAX_CREATE_CAPTURE_ITEMS,
  MAX_EXISTING_TERMINAL_ITEMS,
  MAX_EXISTING_TERMINAL_PUBLICATION_BYTES,
  MAX_VALUE_BYTES,
  MAX_ACTIVE_MARKER_BYTES,
  MAX_ACTIVE_MARKER_DEPTH,
  ACTIVE_MARKER_REQUIRED_KEYS,
  ACTIVE_MARKER_OPTIONAL_KEYS,
  MAX_HEADER_BYTES,
  MAX_FRAME_BYTES,
  SLOT_CAPACITY,
  SLOT_OFFSETS,
  ChangesHistoryMarkerJournalSchemaError,
  nextGeneration,
  publicationDigest,
  valueDigest,
  activeMarkerDigest,
  cleanupDigest,
  publicationSetDigest,
  existingFinalizationDigest,
  existingTerminalPublicationDigest,
  rollbackCreatePublicationDigest,
  assertRollbackCreatePublication,
  assertRollbackCreatePublicationTransition,
  rollbackCreateAttemptPublicationDigest,
  assertRollbackCreateAttemptPublication,
  assertRecord,
  assertMutation,
  assertCreatePrivateRecord,
  assertCreateCaptureItem,
  assertCreateCapture,
  createFinalizationDigest,
  assertCreateFinalization,
  assertPublication,
  assertExistingTerminalItem,
  assertExistingFinalization,
  assertExistingTerminalPublication,
  assertActiveMarker,
  assertJournalValue,
  assertTerminalCleanup,
  buildTerminalCleanup,
  assertPublicationTransition,
  assertExistingTerminalPublicationTransition,
  assertTransition,
  encodeSlotFrame,
  parseSlotFrame,
  assertExpectedHead,
  expectedHead,
  selectJournalHead,
});
