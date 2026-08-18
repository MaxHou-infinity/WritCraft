'use strict';

// Pure private schema for the native missing-leaf lifecycle. This module owns
// no filesystem/process authority and exposes no preload/Renderer contract.

const path = require('path');
const evidenceSchema = require('./evidence-delivery-schema');
const phaseSchema = require('./snapshot-public-markdown-phase-schema');
const existingRestoreSchema = require('./snapshot-existing-restore-native-schema');
const markerJournalSchema = require('./changes-history-marker-journal-schema');

const ROLLBACK_CREATE_COMMANDS = Object.freeze({
  QUARANTINE: 'QUARANTINE_CREATE_ROLLBACK',
  RECONCILE: 'RECONCILE_CREATE_ROLLBACK',
  DELETE: 'DELETE_CREATE_ROLLBACK',
  ACK: 'ACK_CREATE_ROLLBACK',
});
const CREATE_CLEANUP_COMMANDS = Object.freeze({
  CLEANUP: 'CLEANUP_CREATE',
  RECONCILE: 'RECONCILE_CREATE_CLEANUP',
  ACK: 'ACK_CREATE_CLEANUP',
});
const CREATE_JOURNAL_RESPONSE_MAGIC = 'WRCCHPC2';

const SCHEMAS = Object.freeze({
  ROOT_BIND: 'writcraft.changes-history-native-root-bind/v1',
  CREATE_REQUEST: 'writcraft.changes-history-native-create-request/v1',
  CONTROL: 'writcraft.changes-history-native-create-control/v1',
  RECEIPT: 'writcraft.changes-history-native-create-receipt/v1',
  TOKEN: 'writcraft.changes-history-native-create-token/v1',
  RESULT: 'writcraft.changes-history-native-create-result/v1',
  FINALIZE_REQUEST: 'writcraft.changes-history-native-create-finalize-request/v1',
  RECEIPT_SET: 'writcraft.changes-history-native-create-receipt-set/v1',
  FINAL_ACK: 'writcraft.changes-history-native-create-final-ack/v1',
  RECORD_KEY: 'writcraft.changes-history-native-create-record-key/v1',
  FINAL_KEY: 'writcraft.changes-history-native-create-final-key/v1',
  UNDO_REQUEST: 'writcraft.changes-history-native-undo-request/v1',
  UNDO_CONTROL: 'writcraft.changes-history-native-undo-control/v1',
  UNDO_RECEIPT: 'writcraft.changes-history-native-undo-receipt/v1',
  UNDO_TOKEN: 'writcraft.changes-history-native-undo-token/v1',
  UNDO_RESULT: 'writcraft.changes-history-native-undo-result/v1',
  UNDO_RECORD_KEY: 'writcraft.changes-history-native-undo-record-key/v1',
  UNDO_SETTLE_REQUEST: 'writcraft.changes-history-native-undo-settle-request/v1',
  UNDO_RECEIPT_SET: 'writcraft.changes-history-native-undo-receipt-set/v1',
  UNDO_FINAL_KEY: 'writcraft.changes-history-native-undo-final-key/v1',
  UNDO_FINAL_RECORD: 'writcraft.changes-history-native-undo-final-record/v1',
  UNDO_SETTLE_RESULT: 'writcraft.changes-history-native-undo-settle-result/v1',
  UNDO_ACK_REQUEST: 'writcraft.changes-history-native-undo-ack-request/v1',
  UNDO_ACK_RESULT: 'writcraft.changes-history-native-undo-ack-result/v1',
  ROLLBACK_CREATE_REQUEST: 'writcraft.changes-history-native-rollback-create-request/v1',
  ROLLBACK_CREATE_AUTHORITY: 'writcraft.changes-history-native-rollback-create-authority/v1',
  ROLLBACK_CREATE_HELD_BINDING: 'writcraft.changes-history-native-rollback-create-held-binding/v1',
  ROLLBACK_CREATE_PUBLICATION: 'writcraft.changes-history-native-create-publication/v1',
  ROLLBACK_CREATE_CONTROL: 'writcraft.changes-history-native-rollback-create-control/v1',
  ROLLBACK_CREATE_RECEIPT: 'writcraft.changes-history-native-rollback-create-receipt/v1',
  ROLLBACK_CREATE_TOKEN: 'writcraft.changes-history-native-rollback-create-token/v1',
  ROLLBACK_CREATE_RESULT: 'writcraft.changes-history-native-rollback-create-result/v1',
  ROLLBACK_CREATE_SETTLE_REQUEST: 'writcraft.changes-history-native-rollback-create-settle-request/v1',
  ROLLBACK_CREATE_RECEIPT_SET: 'writcraft.changes-history-native-rollback-create-receipt-set/v1',
  ROLLBACK_CREATE_FINAL_KEY: 'writcraft.changes-history-native-rollback-create-final-key/v1',
  ROLLBACK_CREATE_FINAL_RECORD: 'writcraft.changes-history-native-rollback-create-final-record/v1',
  ROLLBACK_CREATE_SETTLE_RESULT: 'writcraft.changes-history-native-rollback-create-settle-result/v1',
  ROLLBACK_CREATE_ACK_REQUEST: 'writcraft.changes-history-native-rollback-create-ack-request/v1',
  ROLLBACK_CREATE_ACK_RESULT: 'writcraft.changes-history-native-rollback-create-ack-result/v1',
  ROLLBACK_CREATE_RECORD_KEY: 'writcraft.changes-history-native-rollback-create-record-key/v1',
  JOURNAL_MARKER_BINDING: 'writcraft.public-markdown-journal-marker-binding/v1',
  CREATE_JOURNAL_PHYSICAL_BINDING:
    'writcraft.public-markdown-create-journal-physical-binding/v1',
  CREATE_PUBLICATION_RESULT: 'writcraft.public-markdown-create-publication-result/v1',
  CREATE_PUBLICATION_ITEM: 'writcraft.public-markdown-create-publication-item/v1',
  CREATE_ATTEMPT: 'writcraft.public-markdown-create-attempt/v1',
  CREATE_JOURNAL_AUTHORITY: 'writcraft.public-markdown-create-journal-authority/v1',
  CREATE_CURRENT_PAYLOAD_SLICES: 'writcraft.public-markdown-create-current-payload-slices/v1',
  CREATE_CURRENT_PAYLOAD_SLICE: 'writcraft.public-markdown-create-current-payload-slice/v1',
  CREATE_JOURNAL_COMMAND_TOKEN: 'writcraft.public-markdown-create-journal-command-token/v1',
  CREATE_JOURNAL_RESPONSE: 'writcraft.public-markdown-create-journal-response/v1',
  CREATE_FINALIZATION_AUTHORITY:
    'writcraft.public-markdown-create-finalization-authority/v1',
  CREATE_CLEANUP_NAME_KEY:
    'writcraft.public-markdown-create-cleanup-name-key/v1',
  CREATE_CLEANUP_ITEM:
    'writcraft.public-markdown-create-cleanup-item/v1',
  CREATE_CLEANUP_AUTHORITY:
    'writcraft.public-markdown-create-cleanup-authority/v1',
  CREATE_CLEANUP_RESULT_ITEM:
    'writcraft.public-markdown-create-cleanup-result-item/v1',
  CREATE_CLEANUP_RESULT:
    'writcraft.public-markdown-create-cleanup-result/v1',
});

const LIMITS = Object.freeze({
  maxItems: 300,
  maxRootBytes: 4096,
  maxSelectedIdBytes: 256,
  maxArtifactBytes: 384 * 1024 * 1024,
  maxMarkerBytes: 2 * 96 * 1024 * 1024,
  maxHistoryBytes: 192 * 1024 * 1024,
  maxLineBytes: 16 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 256 * 1024,
  maxRollbackCreateResponseBytes: 512 * 1024,
  maxCreateJournalResponseBytes: 1024 * 1024,
  maxRecordBytes: 16 * 1024,
  maxFinalRecordBytes: 4 * 1024,
});

const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/u;
const SELECTED_ID_RE = /^[A-Za-z0-9:_-]{1,256}$/u;
const CONTROL_BASENAME_RE = /^\.changes-history-native-create-control\.[a-f0-9]{64}$/u;
const RECEIPT_BASENAME_RE = /^\.changes-history-native-create-receipt\.[a-f0-9]{64}$/u;
const FINAL_BASENAME_RE = /^\.changes-history-native-create-final\.[a-f0-9]{64}$/u;
const CREATE_CLEANUP_BASENAME_RE =
  /^\.changes-history-native-create-cleanup\.[a-f0-9]{64}$/u;
const UNDO_CONTROL_BASENAME_RE = /^\.changes-history-native-undo-control\.[a-f0-9]{64}$/u;
const UNDO_RECEIPT_BASENAME_RE = /^\.changes-history-native-undo-receipt\.[a-f0-9]{64}$/u;
const UNDO_QUARANTINE_BASENAME_RE = /^\.changes-history-native-undo-quarantine\.[a-f0-9]{32}$/u;
const UNDO_FINAL_BASENAME_RE = /^\.changes-history-native-undo-final\.[a-f0-9]{64}$/u;
const ROLLBACK_CREATE_CONTROL_BASENAME_RE = /^\.changes-history-native-rollback-create-control\.[a-f0-9]{64}$/u;
const ROLLBACK_CREATE_RECEIPT_BASENAME_RE = /^\.changes-history-native-rollback-create-receipt\.[a-f0-9]{64}$/u;
const ROLLBACK_CREATE_QUARANTINE_BASENAME_RE = /^\.changes-history-native-rollback-create-quarantine\.[a-f0-9]{32}$/u;
const ROLLBACK_CREATE_FINAL_BASENAME_RE = /^\.changes-history-native-rollback-create-final\.[a-f0-9]{64}$/u;
const validatedUndoAuthorities = new WeakSet();
const validatedCreateRequests = new WeakSet();
const validatedRollbackCreateAuthorities = new WeakSet();
const rollbackCreateRequestDigests = new WeakMap();

const KEYS = Object.freeze({
  JOURNAL_MARKER_SLICE: Object.freeze([
    'slot', 'head', 'frameByteLength', 'frameSha256', 'payloadByteLength',
    'payloadSha256', 'activeMarkerOffset', 'activeMarkerByteLength',
    'activeMarkerDigest',
  ]),
  JOURNAL_MARKER_PREIMAGE: Object.freeze(['byteLength', 'rawSha256', 'identity']),
  JOURNAL_MARKER_BINDING: Object.freeze([
    'schema', 'operationId', 'projectId', 'kind', 'slot', 'head',
    'frameByteLength', 'frameSha256', 'payloadByteLength', 'payloadSha256',
    'activeMarkerOffset', 'activeMarkerByteLength', 'activeMarkerDigest',
    'preimage',
  ]),
  CREATE_JOURNAL_PHYSICAL_BINDING: Object.freeze([
    'schema', 'operationId', 'projectId', 'kind', 'slot', 'head',
    'frameByteLength', 'frameSha256', 'payloadByteLength', 'payloadSha256',
    'activeMarkerOffset', 'activeMarkerByteLength', 'activeMarkerDigest',
  ]),
  CREATE_PUBLICATION_RESULT: Object.freeze([
    'schema', 'operationId', 'requestDigest', 'items',
  ]),
  CREATE_PUBLICATION_ITEM: Object.freeze([
    'selectedId', 'createdLeafIdentity', 'controlRecordIdentity',
    'receiptRecordIdentity',
  ]),
  CREATE_JOURNAL_AUTHORITY: Object.freeze([
    'schema', 'request', 'requestDigest', 'preparedPublication',
    'journalPhysicalBinding', 'bindingDigest', 'currentPayloadSlices',
  ]),
  CREATE_CURRENT_PAYLOAD_SLICES: Object.freeze([
    'schema', 'activeOperationId', 'projectId', 'activeKind', 'nativePublication',
    'activeMarkerDigest',
  ]),
  CREATE_CURRENT_PAYLOAD_SLICE: Object.freeze([
    'schema', 'offset', 'byteLength', 'rawSha256',
  ]),
  CREATE_JOURNAL_COMMAND_TOKEN: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest',
    'preparedPublicationDigest', 'bindingDigest', 'currentPayloadSlicesDigest',
    'commandDigest',
  ]),
  CREATE_JOURNAL_RESPONSE: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'commandDigest',
    'publicationResult', 'errorCode',
  ]),
  CREATE_FINALIZATION_AUTHORITY: Object.freeze([
    'schema', 'createRequest', 'committedPublication',
    'historyCommittedPhaseDigest', 'rawPreparedHistoryStateDigest', 'artifactIdentity',
  ]),
  CREATE_CLEANUP_ITEM: Object.freeze([
    'schema', 'ordinal', 'selectedId', 'role', 'sourceBasename',
    'cleanupBasename', 'recordDigest', 'recordIdentity', 'itemDigest',
  ]),
  CREATE_CLEANUP_AUTHORITY: Object.freeze([
    'schema', 'operationId', 'createRequestDigest', 'committedPublicationDigest',
    'finalizeRequestDigest', 'finalAckDigest', 'finalBasename',
    'finalRecordIdentity', 'items',
    'authorityDigest',
  ]),
  CREATE_CLEANUP_RESULT_ITEM: Object.freeze([
    'schema', 'ordinal', 'cleanupBasename', 'cleanupIdentity',
  ]),
  CREATE_CLEANUP_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'authorityDigest', 'items',
    'errorCode',
  ]),
  ROOT_BIND: Object.freeze([
    'schema', 'canonicalRoot', 'expectedRootIdentityDigest', 'expectedRecoveryIdentityDigest',
  ]),
  CREATE_REQUEST: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'artifactIdentityDigest',
    'artifactByteLength', 'precreatePhaseDigest', 'selectionDigest', 'items',
  ]),
  CREATE_ITEM: Object.freeze([
    'selectedId', 'path', 'artifactOffset', 'byteLength', 'contentDigest',
    'ancestorIdentityDigest',
  ]),
  CONTROL: Object.freeze([
    'schema', 'operationId', 'selectedId', 'path', 'artifactDigest',
    'artifactIdentityDigest', 'precreatePhaseDigest', 'selectionDigest',
    'artifactOffset', 'byteLength', 'contentDigest', 'ancestorIdentityDigest',
    'controlDigest',
  ]),
  RECEIPT: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlDigest', 'createdIdentityDigest',
    'contentDigest', 'byteLength', 'fileFsyncComplete', 'parentFsyncComplete',
    'recoveryFsyncComplete', 'receiptDigest',
  ]),
  TOKEN: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlBasename', 'receiptBasename',
    'controlDigest', 'createdIdentityDigest', 'contentDigest', 'receiptDigest',
  ]),
  RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'artifactDigest',
    'precreatePhaseDigest', 'selectionDigest', 'tokens', 'errorCode',
  ]),
  FINALIZE_REQUEST: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'selectionDigest',
    'historyCommittedPhaseDigest', 'tokens',
  ]),
  RECEIPT_SET: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'selectionDigest', 'items',
  ]),
  RECEIPT_SET_ITEM: Object.freeze([
    'selectedId', 'controlDigest', 'createdIdentityDigest', 'receiptDigest',
  ]),
  FINAL_ACK: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'selectionDigest',
    'historyCommittedPhaseDigest', 'receiptSetDigest', 'itemCount',
    'recoveryFsyncComplete', 'finalAckDigest',
  ]),
  UNDO_AUTHORITY: Object.freeze(['rootBind', 'parentSelection', 'precreatePhase', 'request']),
  UNDO_REQUEST: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'artifactIdentityDigest',
    'artifactByteLength', 'rootIdentityDigest', 'recoveryIdentityDigest',
    'precreatePhaseDigest', 'selectionDigest', 'preparedHistoryDigest', 'items',
  ]),
  UNDO_ITEM: Object.freeze([
    'selectedId', 'path', 'byteLength', 'contentDigest', 'ancestorIdentityDigest',
    'createdIdentityDigest',
  ]),
  UNDO_CONTROL: Object.freeze([
    'schema', 'operationId', 'selectedId', 'path', 'artifactDigest',
    'artifactIdentityDigest', 'artifactByteLength', 'rootIdentityDigest',
    'recoveryIdentityDigest', 'precreatePhaseDigest', 'selectionDigest',
    'preparedHistoryDigest', 'byteLength', 'contentDigest', 'ancestorIdentityDigest',
    'createdIdentityDigest', 'controlDigest',
  ]),
  UNDO_RECEIPT: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlDigest', 'quarantineBasename',
    'createdIdentityDigest', 'quarantineIdentityDigest', 'contentDigest', 'byteLength',
    'publicParentFsyncComplete', 'recoveryFsyncComplete', 'receiptDigest',
  ]),
  UNDO_TOKEN: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlBasename', 'receiptBasename',
    'quarantineBasename', 'controlDigest', 'createdIdentityDigest',
    'quarantineIdentityDigest', 'contentDigest', 'receiptDigest',
    'controlRecordIdentity', 'receiptRecordIdentity',
  ]),
  UNDO_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'artifactDigest',
    'precreatePhaseDigest', 'selectionDigest', 'preparedHistoryDigest', 'tokens',
    'errorCode',
  ]),
  UNDO_SETTLE_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'artifactDigest', 'precreatePhaseDigest',
    'selectionDigest', 'preparedHistoryDigest', 'historyCommittedPhaseDigest', 'tokens',
  ]),
  UNDO_RECEIPT_SET: Object.freeze([
    'schema', 'operationId', 'artifactDigest', 'precreatePhaseDigest',
    'selectionDigest', 'preparedHistoryDigest', 'items',
  ]),
  UNDO_RECEIPT_SET_ITEM: Object.freeze([
    'selectedId', 'controlDigest', 'createdIdentityDigest',
    'quarantineIdentityDigest', 'receiptDigest', 'controlRecordIdentityDigest',
    'receiptRecordIdentityDigest',
  ]),
  UNDO_FINAL_RECORD: Object.freeze([
    'schema', 'command', 'operationId', 'artifactDigest', 'precreatePhaseDigest',
    'selectionDigest', 'preparedHistoryDigest', 'historyCommittedPhaseDigest',
    'receiptSetDigest', 'itemCount', 'publicParentFsyncComplete',
    'recoveryFsyncComplete', 'finalRecordDigest',
  ]),
  UNDO_SETTLE_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'finalRecord',
    'finalRecordIdentity', 'errorCode',
  ]),
  UNDO_ACK_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'finalBasename', 'finalRecordDigest',
    'finalRecordIdentity',
  ]),
  UNDO_ACK_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'finalRecordDigest', 'errorCode',
  ]),
  ROLLBACK_CREATE_AUTHORITY: Object.freeze([
    'schema', 'rootBind', 'parentSelection', 'precreatePhase', 'createdReceiptPhase',
    'createRequest', 'createPublications', 'existingAuthority',
    'existingTerminalReceipt', 'heldBinding', 'request',
  ]),
  ROLLBACK_CREATE_HELD_BINDING: Object.freeze([
    'schema', 'markerByteLength', 'markerIdentity',
    'historyParentIdentityDigest', 'baseHistoryExists',
    'baseHistoryContentDigest', 'baseHistoryIdentity',
  ]),
  ROLLBACK_CREATE_PUBLICATION: Object.freeze([
    'schema', 'token', 'controlRecordIdentity', 'receiptRecordIdentity',
  ]),
  ROLLBACK_CREATE_REQUEST: Object.freeze([
    'schema', 'operationId', 'markerDigest', 'artifactDigest',
    'artifactIdentityDigest', 'artifactByteLength', 'rootIdentityDigest',
    'recoveryIdentityDigest', 'createPrecreatePhaseDigest',
    'createdReceiptPhaseDigest', 'selectionDigest', 'preparedHistoryDigest',
    'originalPrecreateUpdatedAt', 'originalCreatedReceiptUpdatedAt',
    'existingTerminalReceiptDigest', 'existingReceiptSetDigest',
    'existingRequestDigest', 'markerByteLength', 'markerIdentityDigest',
    'historyParentIdentityDigest', 'baseHistoryDigest', 'baseHistoryByteLength',
    'baseHistoryExists', 'baseHistoryContentDigest', 'baseHistoryIdentityDigest',
    'journalMarkerDigest', 'items',
  ]),
  ROLLBACK_CREATE_ITEM: Object.freeze([
    'selectedId', 'path', 'artifactOffset', 'byteLength', 'contentDigest',
    'ancestorIdentityDigest',
    'createdIdentityDigest', 'createControlBasename', 'createReceiptBasename',
    'createControlDigest', 'createReceiptDigest', 'createControlRecordIdentity',
    'createReceiptRecordIdentity',
  ]),
  ROLLBACK_CREATE_CONTROL: Object.freeze([
    'schema', 'operationId', 'selectedId', 'requestDigest', 'path',
    'contentDigest', 'ancestorIdentityDigest', 'createdIdentityDigest',
    'createControlDigest', 'createReceiptDigest', 'quarantineBasename',
    'controlDigest',
  ]),
  ROLLBACK_CREATE_RECEIPT: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlDigest',
    'quarantineBasename', 'createdIdentityDigest', 'quarantineIdentityDigest',
    'contentDigest', 'byteLength', 'publicParentFsyncComplete',
    'recoveryFsyncComplete', 'receiptDigest',
  ]),
  ROLLBACK_CREATE_TOKEN: Object.freeze([
    'schema', 'operationId', 'selectedId', 'controlBasename',
    'receiptBasename', 'quarantineBasename', 'controlDigest',
    'createdIdentityDigest', 'quarantineIdentityDigest', 'contentDigest',
    'receiptDigest', 'controlRecordIdentity', 'receiptRecordIdentity',
  ]),
  ROLLBACK_CREATE_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest', 'tokens',
    'errorCode',
  ]),
  ROLLBACK_CREATE_SETTLE_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest',
    'existingTerminalReceiptDigest', 'baseHistoryDigest',
    'createdReceiptPhaseDigest', 'tokens',
  ]),
  ROLLBACK_CREATE_RECEIPT_SET_ITEM: Object.freeze([
    'selectedId', 'controlDigest', 'createdIdentityDigest',
    'quarantineIdentityDigest', 'receiptDigest',
    'controlRecordIdentityDigest', 'receiptRecordIdentityDigest',
  ]),
  ROLLBACK_CREATE_FINAL_RECORD: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest',
    'existingTerminalReceiptDigest', 'baseHistoryDigest',
    'createdReceiptPhaseDigest', 'receiptSetDigest', 'itemCount',
    'publicParentFsyncComplete', 'recoveryFsyncComplete', 'finalRecordDigest',
  ]),
  ROLLBACK_CREATE_SETTLE_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'finalRecord', 'finalRecordIdentity', 'errorCode',
  ]),
  ROLLBACK_CREATE_ACK_REQUEST: Object.freeze([
    'schema', 'command', 'operationId', 'requestDigest', 'finalBasename',
    'finalRecordDigest', 'finalRecordIdentity', 'rolledBackPhaseDigest',
  ]),
  ROLLBACK_CREATE_ACK_RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest',
    'finalRecordDigest', 'errorCode',
  ]),
});

class PublicMarkdownNativeSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicMarkdownNativeSchemaError';
    this.code = 'PUBLIC_MARKDOWN_NATIVE_PROTOCOL';
  }
}

function fail(message) {
  throw new PublicMarkdownNativeSchemaError(message);
}

function valuesOf(raw, keys, label) {
  try { evidenceSchema.assertExactKeys(raw, keys, label); }
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

function ascii(value, label, pattern, maxBytes = 4096) {
  try {
    evidenceSchema.assertString(value, label, {
      ascii: true,
      minBytes: 1,
      maxBytes,
      pattern,
    });
  } catch (_) { fail(`${label} is invalid`); }
  return value;
}

function digest(value, label) {
  try { return evidenceSchema.assertDigest(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function nullableDigest(value, label) {
  return value === null ? null : digest(value, label);
}

function safeInteger(value, label, minimum, maximum) {
  try { return evidenceSchema.assertSafeInteger(value, label, minimum, maximum); }
  catch (_) { fail(`${label} is invalid`); }
}

function operationId(value) {
  return ascii(value, 'operationId', OPERATION_ID_RE, 52);
}

function selectedId(value, label = 'selectedId') {
  return ascii(value, label, SELECTED_ID_RE, LIMITS.maxSelectedIdBytes);
}

function markdownPath(value, label = 'path') {
  if (typeof value !== 'string' || value !== value.normalize('NFC')) fail(`${label} is invalid`);
  try { return evidenceSchema.assertPublicMarkdownPath(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function immutable(value) {
  return Object.freeze(value);
}

function assertRecordIdentityStructure(raw, label) {
  const value = valuesOf(raw, [
    'schema', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs',
    'ctimeNs', 'contentSha256',
  ], label);
  const identity = immutable({
    schema: value.schema,
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
  try { evidenceSchema.assertObjectIdentity(identity); }
  catch (_) { fail(`${label} is invalid`); }
  return identity;
}

function assertPrivateRecordIdentity(raw, expectedWire, label) {
  const identity = assertRecordIdentityStructure(raw, label);
  const bytes = Buffer.from(expectedWire, 'utf8');
  if (identity.mode !== 0o600 || identity.nlink !== 1 ||
      identity.size !== String(bytes.length) ||
      identity.contentSha256 !== evidenceSchema.sha256(bytes)) {
    fail(`${label} does not bind canonical private record bytes`);
  }
  return identity;
}

function identityWireFields(identity) {
  return [
    identity.dev, identity.ino, String(identity.uid), String(identity.mode),
    String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
    identity.contentSha256,
  ];
}

function activeMarkerSlice(rawValue) {
  let value;
  try { value = markerJournalSchema.assertJournalValue(rawValue); }
  catch (_) { fail('journal marker value is invalid'); }
  if (value.state !== 'ACTIVE' || value.activeMarker === null ||
      value.activeOperationId !== value.activeMarker.operationId ||
      value.projectId !== value.activeMarker.projectId ||
      value.activeKind !== value.activeMarker.kind) {
    fail('journal marker value does not carry one exact ACTIVE marker');
  }
  const slot = BigInt(value.generation) % 2n === 0n ? 'A' : 'B';
  const head = markerJournalSchema.expectedHead(value);
  const payload = Buffer.from(`${evidenceSchema.canonicalJson(value)}\n`, 'utf8');
  const frame = markerJournalSchema.encodeSlotFrame(value, slot);
  const markerBytes = Buffer.from(evidenceSchema.canonicalJson(value.activeMarker), 'utf8');
  const orderedKeys = Object.keys(value).sort(evidenceSchema.compareUnicodeCodePoints);
  let prefix = '{';
  for (const key of orderedKeys) {
    prefix += `${JSON.stringify(key)}:`;
    if (key === 'activeMarker') break;
    prefix += `${evidenceSchema.canonicalJson(value[key])},`;
  }
  const activeMarkerOffset = Buffer.byteLength(prefix, 'utf8');
  if (!payload.subarray(
    activeMarkerOffset,
    activeMarkerOffset + markerBytes.length
  ).equals(markerBytes)) {
    fail('journal marker canonical slice cannot be reproduced');
  }
  return immutable({
    slot,
    head,
    frameByteLength: frame.length,
    frameSha256: evidenceSchema.sha256(frame),
    payloadByteLength: payload.length,
    payloadSha256: evidenceSchema.sha256(payload),
    activeMarkerOffset,
    activeMarkerByteLength: markerBytes.length,
    activeMarkerDigest: value.activeMarkerDigest,
  });
}

function assertUnlinkedPreimageIdentity(raw, byteLength, rawSha256) {
  const value = valuesOf(raw, [
    'schema', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs',
    'ctimeNs', 'contentSha256',
  ], 'journal marker preimage identity');
  const decimalFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  for (const field of decimalFields) {
    try {
      evidenceSchema.assertUnsignedDecimal(value[field], `preimage.identity.${field}`);
      if (BigInt(value[field]) > 0xffffffffffffffffn) throw new Error('overflow');
    } catch (_) { fail(`journal marker preimage identity ${field} is invalid`); }
  }
  const identity = immutable({
    schema: value.schema,
    dev: value.dev,
    ino: value.ino,
    uid: safeInteger(value.uid, 'preimage.identity.uid', 0, 0xffffffff),
    mode: safeInteger(value.mode, 'preimage.identity.mode', 0, 0xffff),
    nlink: safeInteger(value.nlink, 'preimage.identity.nlink', 0, 0xffffffff),
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    contentSha256: digest(value.contentSha256, 'preimage.identity.contentSha256'),
  });
  if (identity.schema !== evidenceSchema.SCHEMAS.OBJECT_IDENTITY ||
      identity.mode !== 0o600 || identity.nlink !== 0 ||
      identity.size !== String(byteLength) || identity.contentSha256 !== rawSha256) {
    fail('journal marker preimage identity does not bind the unlinked canonical bytes');
  }
  return identity;
}

function assertJournalMarkerPreimage(raw, expectedMarker) {
  const value = valuesOf(raw, KEYS.JOURNAL_MARKER_PREIMAGE, 'journal marker preimage');
  const markerBytes = Buffer.from(evidenceSchema.canonicalJson(expectedMarker), 'utf8');
  const byteLength = safeInteger(
    value.byteLength,
    'preimage.byteLength',
    1,
    markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
  );
  const rawSha256 = digest(value.rawSha256, 'preimage.rawSha256');
  if (byteLength !== markerBytes.length || rawSha256 !== evidenceSchema.sha256(markerBytes)) {
    fail('journal marker preimage does not equal the canonical ACTIVE marker');
  }
  return immutable({
    byteLength,
    rawSha256,
    identity: assertUnlinkedPreimageIdentity(value.identity, byteLength, rawSha256),
  });
}

function assertJournalMarkerBindingStructure(raw) {
  const value = valuesOf(raw, KEYS.JOURNAL_MARKER_BINDING, 'journal marker binding');
  let head;
  try { head = markerJournalSchema.assertExpectedHead(value.head); }
  catch (_) { fail('journal marker binding head is invalid'); }
  let projectId;
  try {
    projectId = evidenceSchema.assertString(value.projectId, 'binding.projectId', {
      minBytes: 1,
      maxBytes: 4096,
    });
  } catch (_) { fail('journal marker binding project is invalid'); }
  if (projectId !== projectId.normalize('NFC') || value.kind !== 'snapshot_restore') {
    fail('journal marker binding project or kind is invalid');
  }
  const slot = value.slot === 'A' || value.slot === 'B'
    ? value.slot
    : fail('journal marker binding slot is invalid');
  if (slot !== (BigInt(head.generation) % 2n === 0n ? 'A' : 'B')) {
    fail('journal marker binding slot does not equal generation parity');
  }
  const frameByteLength = safeInteger(
    value.frameByteLength, 'binding.frameByteLength', 1, markerJournalSchema.MAX_FRAME_BYTES
  );
  const payloadByteLength = safeInteger(
    value.payloadByteLength, 'binding.payloadByteLength', 1, markerJournalSchema.MAX_VALUE_BYTES
  );
  const activeMarkerOffset = safeInteger(
    value.activeMarkerOffset, 'binding.activeMarkerOffset', 0, markerJournalSchema.MAX_VALUE_BYTES
  );
  const activeMarkerByteLength = safeInteger(
    value.activeMarkerByteLength,
    'binding.activeMarkerByteLength',
    1,
    markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
  );
  if (frameByteLength <= payloadByteLength ||
      frameByteLength - payloadByteLength > markerJournalSchema.MAX_HEADER_BYTES ||
      activeMarkerOffset + activeMarkerByteLength > payloadByteLength - 1) {
    fail('journal marker binding frame or slice bounds are invalid');
  }
  const preimageValue = valuesOf(
    value.preimage,
    KEYS.JOURNAL_MARKER_PREIMAGE,
    'journal marker preimage'
  );
  const byteLength = safeInteger(
    preimageValue.byteLength,
    'preimage.byteLength',
    1,
    markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
  );
  const rawSha256 = digest(preimageValue.rawSha256, 'preimage.rawSha256');
  if (byteLength !== activeMarkerByteLength) {
    fail('journal marker preimage length does not bind marker slice');
  }
  return immutable({
    schema: value.schema === SCHEMAS.JOURNAL_MARKER_BINDING
      ? value.schema
      : fail('journal marker binding schema is invalid'),
    operationId: operationId(value.operationId),
    projectId,
    kind: 'snapshot_restore',
    slot,
    head,
    frameByteLength,
    frameSha256: digest(value.frameSha256, 'binding.frameSha256'),
    payloadByteLength,
    payloadSha256: digest(value.payloadSha256, 'binding.payloadSha256'),
    activeMarkerOffset,
    activeMarkerByteLength,
    activeMarkerDigest: digest(value.activeMarkerDigest, 'binding.activeMarkerDigest'),
    preimage: immutable({
      byteLength,
      rawSha256,
      identity: assertUnlinkedPreimageIdentity(
        preimageValue.identity,
        byteLength,
        rawSha256
      ),
    }),
  });
}

function buildJournalMarkerBinding(rawValue, rawPreimage) {
  let value;
  try { value = markerJournalSchema.assertJournalValue(rawValue); }
  catch (_) { fail('journal marker value is invalid'); }
  const slice = activeMarkerSlice(value);
  const preimage = assertJournalMarkerPreimage(rawPreimage, value.activeMarker);
  return immutable({
    schema: SCHEMAS.JOURNAL_MARKER_BINDING,
    operationId: value.activeOperationId,
    projectId: value.projectId,
    kind: value.activeKind,
    ...slice,
    preimage,
  });
}

function assertJournalMarkerBinding(raw, rawValue, rawExpectedPreimage) {
  const value = valuesOf(raw, KEYS.JOURNAL_MARKER_BINDING, 'journal marker binding');
  let journalValue;
  let head;
  try {
    journalValue = markerJournalSchema.assertJournalValue(rawValue);
    head = markerJournalSchema.assertExpectedHead(value.head);
  } catch (_) { fail('journal marker binding head or value is invalid'); }
  const actual = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    projectId: typeof value.projectId === 'string'
      ? value.projectId
      : fail('journal marker binding project is invalid'),
    kind: typeof value.kind === 'string'
      ? value.kind
      : fail('journal marker binding kind is invalid'),
    slot: value.slot === 'A' || value.slot === 'B'
      ? value.slot
      : fail('journal marker binding slot is invalid'),
    head,
    frameByteLength: safeInteger(
      value.frameByteLength, 'binding.frameByteLength', 1, markerJournalSchema.MAX_FRAME_BYTES
    ),
    frameSha256: digest(value.frameSha256, 'binding.frameSha256'),
    payloadByteLength: safeInteger(
      value.payloadByteLength, 'binding.payloadByteLength', 1, markerJournalSchema.MAX_VALUE_BYTES
    ),
    payloadSha256: digest(value.payloadSha256, 'binding.payloadSha256'),
    activeMarkerOffset: safeInteger(
      value.activeMarkerOffset, 'binding.activeMarkerOffset', 0, markerJournalSchema.MAX_VALUE_BYTES
    ),
    activeMarkerByteLength: safeInteger(
      value.activeMarkerByteLength,
      'binding.activeMarkerByteLength',
      1,
      markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
    ),
    activeMarkerDigest: digest(value.activeMarkerDigest, 'binding.activeMarkerDigest'),
    preimage: assertJournalMarkerPreimage(value.preimage, journalValue.activeMarker),
  });
  const expected = buildJournalMarkerBinding(rawValue, rawExpectedPreimage);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('journal marker binding does not equal its original journal and fd authority');
  }
  return expected;
}

function assertCreateJournalPhysicalBindingStructure(raw) {
  const value = valuesOf(
    raw,
    KEYS.CREATE_JOURNAL_PHYSICAL_BINDING,
    'CREATE_MISSING journal physical binding'
  );
  let head;
  try { head = markerJournalSchema.assertExpectedHead(value.head); }
  catch (_) { fail('CREATE_MISSING journal physical head is invalid'); }
  let projectId;
  try {
    projectId = evidenceSchema.assertString(value.projectId, 'binding.projectId', {
      minBytes: 1,
      maxBytes: 4096,
    });
  } catch (_) { fail('CREATE_MISSING journal physical project is invalid'); }
  if (projectId !== projectId.normalize('NFC') || value.kind !== 'snapshot_restore') {
    fail('CREATE_MISSING journal physical project or kind is invalid');
  }
  const slot = value.slot === 'A' || value.slot === 'B'
    ? value.slot
    : fail('CREATE_MISSING journal physical slot is invalid');
  if (slot !== (BigInt(head.generation) % 2n === 0n ? 'A' : 'B')) {
    fail('CREATE_MISSING journal physical slot does not equal generation parity');
  }
  const frameByteLength = safeInteger(
    value.frameByteLength, 'binding.frameByteLength', 1, markerJournalSchema.MAX_FRAME_BYTES
  );
  const payloadByteLength = safeInteger(
    value.payloadByteLength, 'binding.payloadByteLength', 1, markerJournalSchema.MAX_VALUE_BYTES
  );
  const activeMarkerOffset = safeInteger(
    value.activeMarkerOffset, 'binding.activeMarkerOffset', 0, markerJournalSchema.MAX_VALUE_BYTES
  );
  const activeMarkerByteLength = safeInteger(
    value.activeMarkerByteLength,
    'binding.activeMarkerByteLength',
    1,
    markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
  );
  if (frameByteLength <= payloadByteLength ||
      frameByteLength - payloadByteLength > markerJournalSchema.MAX_HEADER_BYTES ||
      activeMarkerOffset + activeMarkerByteLength > payloadByteLength - 1) {
    fail('CREATE_MISSING journal physical frame or slice bounds are invalid');
  }
  return immutable({
    schema: value.schema === SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING
      ? value.schema
      : fail('CREATE_MISSING journal physical schema is invalid'),
    operationId: operationId(value.operationId),
    projectId,
    kind: 'snapshot_restore',
    slot,
    head,
    frameByteLength,
    frameSha256: digest(value.frameSha256, 'binding.frameSha256'),
    payloadByteLength,
    payloadSha256: digest(value.payloadSha256, 'binding.payloadSha256'),
    activeMarkerOffset,
    activeMarkerByteLength,
    activeMarkerDigest: digest(value.activeMarkerDigest, 'binding.activeMarkerDigest'),
  });
}

function buildCreateJournalPhysicalBinding(rawValue) {
  let value;
  try { value = markerJournalSchema.assertJournalValue(rawValue); }
  catch (_) { fail('CREATE_MISSING current journal value is invalid'); }
  const slice = activeMarkerSlice(value);
  return assertCreateJournalPhysicalBindingStructure({
    schema: SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING,
    operationId: value.activeOperationId,
    projectId: value.projectId,
    kind: value.activeKind,
    ...slice,
  });
}

function assertCreateJournalPhysicalBinding(raw, rawValue) {
  const actual = assertCreateJournalPhysicalBindingStructure(raw);
  const expected = buildCreateJournalPhysicalBinding(rawValue);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('CREATE_MISSING journal physical binding does not equal current journal');
  }
  return expected;
}

function assertRootBind(raw) {
  const value = valuesOf(raw, KEYS.ROOT_BIND, 'root bind');
  if (value.schema !== SCHEMAS.ROOT_BIND || typeof value.canonicalRoot !== 'string' ||
      value.canonicalRoot !== value.canonicalRoot.normalize('NFC') ||
      !path.isAbsolute(value.canonicalRoot) || path.resolve(value.canonicalRoot) !== value.canonicalRoot) {
    fail('root bind identity is invalid');
  }
  try {
    evidenceSchema.assertString(value.canonicalRoot, 'canonicalRoot', {
      minBytes: 1,
      maxBytes: LIMITS.maxRootBytes,
    });
  } catch (_) { fail('canonicalRoot is invalid'); }
  return immutable({
    schema: SCHEMAS.ROOT_BIND,
    canonicalRoot: value.canonicalRoot,
    expectedRootIdentityDigest: digest(
      value.expectedRootIdentityDigest,
      'expectedRootIdentityDigest'
    ),
    expectedRecoveryIdentityDigest: digest(
      value.expectedRecoveryIdentityDigest,
      'expectedRecoveryIdentityDigest'
    ),
  });
}

function validateCreateItem(raw, index, artifactByteLength) {
  const value = valuesOf(raw, KEYS.CREATE_ITEM, `items[${index}]`);
  const offset = safeInteger(
    value.artifactOffset,
    `items[${index}].artifactOffset`,
    0,
    artifactByteLength - 1
  );
  const byteLength = safeInteger(
    value.byteLength,
    `items[${index}].byteLength`,
    1,
    artifactByteLength
  );
  if (offset + byteLength > artifactByteLength) fail(`items[${index}] range is invalid`);
  return immutable({
    selectedId: selectedId(value.selectedId, `items[${index}].selectedId`),
    path: markdownPath(value.path, `items[${index}].path`),
    artifactOffset: offset,
    byteLength,
    contentDigest: digest(value.contentDigest, `items[${index}].contentDigest`),
    ancestorIdentityDigest: digest(
      value.ancestorIdentityDigest,
      `items[${index}].ancestorIdentityDigest`
    ),
  });
}

function assertCreateRequest(raw) {
  if (raw && typeof raw === 'object' && validatedCreateRequests.has(raw)) return raw;
  const value = valuesOf(raw, KEYS.CREATE_REQUEST, 'create request');
  if (value.schema !== SCHEMAS.CREATE_REQUEST) fail('create request schema is invalid');
  const artifactByteLength = safeInteger(
    value.artifactByteLength,
    'artifactByteLength',
    1,
    LIMITS.maxArtifactBytes
  );
  const items = arrayValues(value.items, 1, LIMITS.maxItems, 'items')
    .map((item, index) => validateCreateItem(item, index, artifactByteLength));
  if (new Set(items.map(item => item.selectedId)).size !== items.length ||
      new Set(items.map(item => item.path)).size !== items.length) {
    fail('create request contains duplicate selectedId or path');
  }
  const ranges = [...items].sort((left, right) => left.artifactOffset - right.artifactOffset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].artifactOffset + ranges[index - 1].byteLength >
        ranges[index].artifactOffset) fail('create request artifact ranges overlap');
  }
  const request = immutable({
    schema: SCHEMAS.CREATE_REQUEST,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    artifactByteLength,
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    items: immutable(items),
  });
  validatedCreateRequests.add(request);
  return request;
}

function createRequestDigest(rawRequest) {
  return evidenceSchema.digestObject(
    SCHEMAS.CREATE_REQUEST,
    assertCreateRequest(rawRequest)
  );
}

function createAttemptDigest(rawRequest) {
  const request = assertCreateRequest(rawRequest);
  return evidenceSchema.digestObject(SCHEMAS.CREATE_ATTEMPT, {
    schema: SCHEMAS.CREATE_ATTEMPT,
    operationId: request.operationId,
    requestDigest: createRequestDigest(request),
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
  });
}

function buildPreparedCreatePublication(rawRequest) {
  const request = assertCreateRequest(rawRequest);
  const publication = {
    schema: markerJournalSchema.SCHEMAS.PUBLICATION,
    kind: 'snapshot_restore',
    command: 'CREATE_MISSING',
    state: 'PREPARED',
    operationId: request.operationId,
    requestDigest: createRequestDigest(request),
    phaseDigest: request.precreatePhaseDigest,
    previousPublicationDigest: null,
    records: [],
    mutation: {
      schema: markerJournalSchema.SCHEMAS.MUTATION,
      state: 'UNARMED',
      sourceIdentityDigest: null,
      privateBasename: null,
      directoryFsyncComplete: false,
    },
    createAttemptDigest: null,
    createCapture: null,
    createFinalization: null,
    createCleanupFinalBasename: null,
    createCleanupFinalRecordIdentity: null,
    publicationDigest: null,
  };
  publication.publicationDigest = markerJournalSchema.publicationDigest(publication);
  return markerJournalSchema.assertPublication(publication);
}

function buildLatchedCreatePublication(rawRequest) {
  const request = assertCreateRequest(rawRequest);
  const prepared = buildPreparedCreatePublication(request);
  const latched = {
    ...prepared,
    previousPublicationDigest: prepared.publicationDigest,
    createAttemptDigest: createAttemptDigest(request),
    publicationDigest: null,
  };
  latched.publicationDigest = markerJournalSchema.publicationDigest(latched);
  return markerJournalSchema.assertPublicationTransition(prepared, latched);
}

function assertLatchedCreatePublication(raw, rawRequest) {
  let actual;
  try { actual = markerJournalSchema.assertPublication(raw); }
  catch (_) { fail('latched CREATE_MISSING publication is invalid'); }
  const expected = buildLatchedCreatePublication(rawRequest);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('latched CREATE_MISSING publication does not bind the exact create attempt');
  }
  return expected;
}

function assertPreparedCreatePublication(raw, rawRequest) {
  let actual;
  try { actual = markerJournalSchema.assertPublication(raw); }
  catch (_) { fail('prepared CREATE_MISSING publication is invalid'); }
  const expected = buildPreparedCreatePublication(rawRequest);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('prepared CREATE_MISSING publication does not bind the exact create request');
  }
  return expected;
}

function assertPublicationIdentity(raw, label, privateRecord = false) {
  let identity;
  try { identity = evidenceSchema.assertObjectIdentity(raw); }
  catch (_) { fail(`${label} is invalid`); }
  if (identity.nlink !== 1 || (privateRecord && identity.mode !== 0o600)) {
    fail(`${label} mode or link authority is invalid`);
  }
  return identity;
}

function createItemFacts(request, index, createdLeafIdentity) {
  const item = request.items[index];
  const createdIdentityDigest = evidenceSchema.digestObjectIdentity(createdLeafIdentity);
  const control = buildControl(request, index);
  const receipt = buildReceipt(control, createdIdentityDigest);
  const names = recordNames(request, index);
  const controlRawSha256 = evidenceSchema.sha256(encodeControlRecord(control));
  const receiptRawSha256 = evidenceSchema.sha256(encodeReceiptRecord(receipt, control));
  return {
    item,
    control,
    receipt,
    names,
    controlRawSha256,
    receiptRawSha256,
  };
}

function assertCreatePublicationResult(raw, rawRequest) {
  const request = assertCreateRequest(rawRequest);
  const value = valuesOf(raw, KEYS.CREATE_PUBLICATION_RESULT, 'create publication result');
  if (value.schema !== SCHEMAS.CREATE_PUBLICATION_RESULT ||
      value.operationId !== request.operationId ||
      value.requestDigest !== createRequestDigest(request)) {
    fail('create publication result authority is invalid');
  }
  const items = arrayValues(
    value.items,
    request.items.length,
    request.items.length,
    'create publication result.items'
  ).map((rawItem, index) => {
    const itemValue = valuesOf(
      rawItem,
      KEYS.CREATE_PUBLICATION_ITEM,
      `create publication result.items[${index}]`
    );
    const requestItem = request.items[index];
    if (itemValue.selectedId !== requestItem.selectedId) {
      fail('create publication result item order or identity is invalid');
    }
    const createdLeafIdentity = assertPublicationIdentity(
      itemValue.createdLeafIdentity,
      `create publication result.items[${index}].createdLeafIdentity`
    );
    if (createdLeafIdentity.contentSha256 !== requestItem.contentDigest) {
      fail('created leaf identity does not bind request content');
    }
    const facts = createItemFacts(request, index, createdLeafIdentity);
    const controlRecordIdentity = assertPublicationIdentity(
      itemValue.controlRecordIdentity,
      `create publication result.items[${index}].controlRecordIdentity`,
      true
    );
    const receiptRecordIdentity = assertPublicationIdentity(
      itemValue.receiptRecordIdentity,
      `create publication result.items[${index}].receiptRecordIdentity`,
      true
    );
    if (controlRecordIdentity.contentSha256 !== facts.controlRawSha256 ||
        receiptRecordIdentity.contentSha256 !== facts.receiptRawSha256) {
      fail('private create record identity does not bind canonical record bytes');
    }
    return immutable({
      selectedId: requestItem.selectedId,
      createdLeafIdentity,
      controlRecordIdentity,
      receiptRecordIdentity,
    });
  });
  const inodeKeys = items.flatMap(item => [
    item.createdLeafIdentity,
    item.controlRecordIdentity,
    item.receiptRecordIdentity,
  ]).map(identity => `${identity.dev}:${identity.ino}`);
  if (new Set(inodeKeys).size !== inodeKeys.length) {
    fail('create publication result reuses one leaf/private inode');
  }
  return immutable({
    schema: SCHEMAS.CREATE_PUBLICATION_RESULT,
    operationId: request.operationId,
    requestDigest: createRequestDigest(request),
    items: immutable(items),
  });
}

function buildCreateCapture(rawRequest, rawPublicationResult) {
  const request = assertCreateRequest(rawRequest);
  const result = assertCreatePublicationResult(rawPublicationResult, request);
  const capture = {
    schema: markerJournalSchema.SCHEMAS.CREATE_CAPTURE,
    items: result.items.map((resultItem, index) => {
      const facts = createItemFacts(request, index, resultItem.createdLeafIdentity);
      const base = {
        selectedId: facts.item.selectedId,
        path: facts.item.path,
        contentDigest: facts.item.contentDigest,
        ancestorIdentityDigest: facts.item.ancestorIdentityDigest,
      };
      return {
        schema: markerJournalSchema.SCHEMAS.CREATE_CAPTURE_ITEM,
        ordinal: index,
        ...base,
        createdLeafIdentity: resultItem.createdLeafIdentity,
        creationReceiptDigest: facts.receipt.receiptDigest,
        control: {
          schema: markerJournalSchema.SCHEMAS.CREATE_PRIVATE_RECORD,
          role: 'CONTROL',
          ...base,
          deterministicBasename: facts.names.controlBasename,
          logicalDigest: facts.control.controlDigest,
          boundControlDigest: null,
          rawSha256: facts.controlRawSha256,
          recordIdentity: resultItem.controlRecordIdentity,
          state: 'PUBLISHED',
          cleanupBasename: null,
        },
        receipt: {
          schema: markerJournalSchema.SCHEMAS.CREATE_PRIVATE_RECORD,
          role: 'RECEIPT',
          ...base,
          deterministicBasename: facts.names.receiptBasename,
          logicalDigest: facts.receipt.receiptDigest,
          boundControlDigest: facts.control.controlDigest,
          rawSha256: facts.receiptRawSha256,
          recordIdentity: resultItem.receiptRecordIdentity,
          state: 'PUBLISHED',
          cleanupBasename: null,
        },
      };
    }),
  };
  try { return markerJournalSchema.assertCreateCapture(capture); }
  catch (_) { fail('create capture cannot be constructed from exact publication authority'); }
}

function assertStoredCreateCapture(rawCapture, rawRequest) {
  const request = assertCreateRequest(rawRequest);
  let capture;
  try { capture = markerJournalSchema.assertCreateCapture(rawCapture); }
  catch (_) { fail('stored create capture is invalid'); }
  if (capture.items.length !== request.items.length) {
    fail('stored create capture item count does not bind request');
  }
  for (let index = 0; index < capture.items.length; index += 1) {
    const captured = capture.items[index];
    const facts = createItemFacts(request, index, captured.createdLeafIdentity);
    const expectedBase = {
      selectedId: facts.item.selectedId,
      path: facts.item.path,
      contentDigest: facts.item.contentDigest,
      ancestorIdentityDigest: facts.item.ancestorIdentityDigest,
    };
    if (captured.ordinal !== index || captured.selectedId !== expectedBase.selectedId ||
        captured.path !== expectedBase.path || captured.contentDigest !== expectedBase.contentDigest ||
        captured.ancestorIdentityDigest !== expectedBase.ancestorIdentityDigest ||
        captured.creationReceiptDigest !== facts.receipt.receiptDigest ||
        captured.control.deterministicBasename !== facts.names.controlBasename ||
        captured.control.logicalDigest !== facts.control.controlDigest ||
        captured.control.rawSha256 !== facts.controlRawSha256 ||
        captured.receipt.deterministicBasename !== facts.names.receiptBasename ||
        captured.receipt.logicalDigest !== facts.receipt.receiptDigest ||
        captured.receipt.boundControlDigest !== facts.control.controlDigest ||
        captured.receipt.rawSha256 !== facts.receiptRawSha256) {
      fail('stored create capture cannot reproduce request and canonical record authority');
    }
  }
  return capture;
}

function committedCreatePublication(rawRequest, rawCapture) {
  const request = assertCreateRequest(rawRequest);
  const capture = assertStoredCreateCapture(rawCapture, request);
  const latched = buildLatchedCreatePublication(request);
  const armed = {
    ...latched,
    state: 'ARMED',
    previousPublicationDigest: latched.publicationDigest,
    createCapture: capture,
    publicationDigest: null,
  };
  armed.publicationDigest = markerJournalSchema.publicationDigest(armed);
  const validArmed = markerJournalSchema.assertPublicationTransition(latched, armed);
  const committed = {
    ...validArmed,
    state: 'COMMITTED',
    previousPublicationDigest: validArmed.publicationDigest,
    publicationDigest: null,
  };
  committed.publicationDigest = markerJournalSchema.publicationDigest(committed);
  return markerJournalSchema.assertPublicationTransition(validArmed, committed);
}

function createFinalizationAuthority(raw) {
  const value = valuesOf(
    raw,
    KEYS.CREATE_FINALIZATION_AUTHORITY,
    'CREATE_MISSING finalization authority'
  );
  if (value.schema !== SCHEMAS.CREATE_FINALIZATION_AUTHORITY) {
    fail('CREATE_MISSING finalization authority schema is invalid');
  }
  const request = assertCreateRequest(value.createRequest);
  const publication = markerJournalSchema.assertPublication(value.committedPublication);
  const capture = assertStoredCreateCapture(publication.createCapture, request);
  const expectedPublication = committedCreatePublication(request, capture);
  if (evidenceSchema.canonicalJson(publication) !==
      evidenceSchema.canonicalJson(expectedPublication)) {
    fail('CREATE_MISSING finalization does not bind exact COMMITTED publication');
  }
  let artifactIdentity;
  try { artifactIdentity = evidenceSchema.assertObjectIdentity(value.artifactIdentity); }
  catch (_) { fail('CREATE_MISSING finalization artifact identity is invalid'); }
  if (artifactIdentity.mode !== 0o600 || artifactIdentity.nlink !== 1 ||
      BigInt(artifactIdentity.size) !== BigInt(request.artifactByteLength) ||
      artifactIdentity.contentSha256 !== request.artifactDigest ||
      evidenceSchema.digestObjectIdentity(artifactIdentity) !== request.artifactIdentityDigest) {
    fail('CREATE_MISSING finalization artifact identity does not bind request');
  }
  return immutable({
    schema: SCHEMAS.CREATE_FINALIZATION_AUTHORITY,
    createRequest: request,
    committedPublication: publication,
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    rawPreparedHistoryStateDigest: digest(
      value.rawPreparedHistoryStateDigest,
      'rawPreparedHistoryStateDigest'
    ),
    artifactIdentity,
  });
}

function buildPreparedCreateFinalization(rawAuthority) {
  const authority = createFinalizationAuthority(rawAuthority);
  const request = authority.createRequest;
  const tokens = authority.committedPublication.createCapture.items.map((item, index) => {
    const control = buildControl(request, index);
    const receipt = buildReceipt(control, evidenceSchema.digestObjectIdentity(
      item.createdLeafIdentity
    ));
    return buildToken(request, index, receipt);
  });
  const finalizeRequest = assertFinalizeRequest({
    schema: SCHEMAS.FINALIZE_REQUEST,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    historyCommittedPhaseDigest: authority.historyCommittedPhaseDigest,
    tokens,
  }, request);
  const finalAck = buildFinalAck(finalizeRequest, request);
  const finalization = {
    schema: markerJournalSchema.SCHEMAS.CREATE_FINALIZATION,
    state: 'PREPARED',
    operationId: request.operationId,
    finalizeRequest,
    finalizeRequestDigest: evidenceSchema.digestObject(
      SCHEMAS.FINALIZE_REQUEST,
      finalizeRequest
    ),
    historyCommittedPhaseDigest: authority.historyCommittedPhaseDigest,
    rawPreparedHistoryStateDigest: authority.rawPreparedHistoryStateDigest,
    artifactByteLength: request.artifactByteLength,
    artifactDigest: request.artifactDigest,
    artifactIdentity: authority.artifactIdentity,
    committedPublicationDigest: authority.committedPublication.publicationDigest,
    createCaptureDigest: evidenceSchema.digestObject(
      markerJournalSchema.SCHEMAS.CREATE_CAPTURE,
      authority.committedPublication.createCapture
    ),
    finalBasename: finalRecordName(finalizeRequest, request),
    finalAck,
    finalAckDigest: finalAck.finalAckDigest,
    finalRecordIdentity: null,
    previousFinalizationDigest: null,
    finalizationDigest: null,
  };
  finalization.finalizationDigest = markerJournalSchema.createFinalizationDigest(finalization);
  return markerJournalSchema.assertCreateFinalization(finalization);
}

function buildCapturedCreateFinalization(rawAuthority, rawFinalRecordIdentity) {
  const authority = createFinalizationAuthority(rawAuthority);
  const prepared = buildPreparedCreateFinalization(authority);
  let identity;
  try { identity = evidenceSchema.assertObjectIdentity(rawFinalRecordIdentity); }
  catch (_) { fail('CREATE_MISSING final record identity is invalid'); }
  const bytes = encodeFinalAckRecord(
    prepared.finalAck,
    prepared.finalizeRequest,
    authority.createRequest
  );
  if (identity.mode !== 0o600 || identity.nlink !== 1 ||
      BigInt(identity.size) !== BigInt(bytes.length) ||
      identity.contentSha256 !== evidenceSchema.sha256(bytes)) {
    fail('CREATE_MISSING final record identity does not bind canonical ACK bytes');
  }
  const captured = {
    ...prepared,
    state: 'CAPTURED',
    finalRecordIdentity: identity,
    previousFinalizationDigest: prepared.finalizationDigest,
    finalizationDigest: null,
  };
  captured.finalizationDigest = markerJournalSchema.createFinalizationDigest(captured);
  return markerJournalSchema.assertCreateFinalization(captured);
}

function assertStoredCreateFinalization(raw, rawAuthority) {
  const authority = createFinalizationAuthority(rawAuthority);
  let actual;
  try { actual = markerJournalSchema.assertCreateFinalization(raw); }
  catch (_) { fail('stored CREATE_MISSING finalization is invalid'); }
  const expected = actual.state === 'PREPARED'
    ? buildPreparedCreateFinalization(authority)
    : buildCapturedCreateFinalization(authority, actual.finalRecordIdentity);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('stored CREATE_MISSING finalization does not bind exact original authority');
  }
  return expected;
}

function createCleanupItemDigest(raw) {
  const value = valuesOf(raw, KEYS.CREATE_CLEANUP_ITEM, 'CREATE cleanup item digest input');
  return evidenceSchema.digestObject(SCHEMAS.CREATE_CLEANUP_ITEM, Object.fromEntries(
    KEYS.CREATE_CLEANUP_ITEM.map(key => [key, key === 'itemDigest' ? null : value[key]])
  ), 'itemDigest');
}

function createCleanupAuthorityDigest(raw) {
  const value = valuesOf(
    raw,
    KEYS.CREATE_CLEANUP_AUTHORITY,
    'CREATE cleanup authority digest input'
  );
  return evidenceSchema.digestObject(SCHEMAS.CREATE_CLEANUP_AUTHORITY, Object.fromEntries(
    KEYS.CREATE_CLEANUP_AUTHORITY.map(key => [
      key,
      key === 'authorityDigest' ? null : value[key],
    ])
  ), 'authorityDigest');
}

function createCleanupBasename(fields) {
  const key = {
    schema: SCHEMAS.CREATE_CLEANUP_NAME_KEY,
    operationId: operationId(fields.operationId),
    finalAckDigest: digest(fields.finalAckDigest, 'cleanup finalAckDigest'),
    ordinal: safeInteger(fields.ordinal, 'cleanup ordinal', 0, LIMITS.maxItems * 2 - 1),
    role: fields.role,
    sourceBasename: fields.sourceBasename,
    recordDigest: digest(fields.recordDigest, 'cleanup recordDigest'),
  };
  if (!['CONTROL', 'RECEIPT'].includes(key.role) ||
      !(key.role === 'CONTROL' ? CONTROL_BASENAME_RE : RECEIPT_BASENAME_RE)
        .test(key.sourceBasename || '')) {
    fail('CREATE cleanup name authority is invalid');
  }
  return `.changes-history-native-create-cleanup.${
    evidenceSchema.digestObject(SCHEMAS.CREATE_CLEANUP_NAME_KEY, key).slice(7)
  }`;
}

function assertCreateCleanupAuthority(raw, rawFinalizationAuthority = null) {
  const value = valuesOf(raw, KEYS.CREATE_CLEANUP_AUTHORITY, 'CREATE cleanup authority');
  const items = arrayValues(
    value.items,
    2,
    LIMITS.maxItems * 2,
    'CREATE cleanup authority.items'
  ).map((rawItem, index) => {
    const item = valuesOf(rawItem, KEYS.CREATE_CLEANUP_ITEM, `CREATE cleanup items[${index}]`);
    let recordIdentity;
    try { recordIdentity = evidenceSchema.assertObjectIdentity(item.recordIdentity); }
    catch (_) { fail(`CREATE cleanup items[${index}] record identity is invalid`); }
    const normalized = immutable({
      schema: item.schema,
      ordinal: safeInteger(item.ordinal, `CREATE cleanup items[${index}].ordinal`, 0,
        LIMITS.maxItems * 2 - 1),
      selectedId: selectedId(item.selectedId, `CREATE cleanup items[${index}].selectedId`),
      role: item.role,
      sourceBasename: item.sourceBasename,
      cleanupBasename: item.cleanupBasename,
      recordDigest: digest(item.recordDigest, `CREATE cleanup items[${index}].recordDigest`),
      recordIdentity,
      itemDigest: digest(item.itemDigest, `CREATE cleanup items[${index}].itemDigest`),
    });
    if (normalized.schema !== SCHEMAS.CREATE_CLEANUP_ITEM || normalized.ordinal !== index ||
        !['CONTROL', 'RECEIPT'].includes(normalized.role) ||
        !(normalized.role === 'CONTROL' ? CONTROL_BASENAME_RE : RECEIPT_BASENAME_RE)
          .test(normalized.sourceBasename || '') ||
        !CREATE_CLEANUP_BASENAME_RE.test(normalized.cleanupBasename || '') ||
        normalized.cleanupBasename !== createCleanupBasename({
          operationId: value.operationId,
          finalAckDigest: value.finalAckDigest,
          ordinal: normalized.ordinal,
          role: normalized.role,
          sourceBasename: normalized.sourceBasename,
          recordDigest: normalized.recordDigest,
        }) ||
        normalized.recordIdentity.mode !== 0o600 || normalized.recordIdentity.nlink !== 1 ||
        normalized.recordIdentity.contentSha256 !== normalized.recordDigest ||
        normalized.itemDigest !== createCleanupItemDigest(normalized)) {
      fail(`CREATE cleanup items[${index}] authority is invalid`);
    }
    return normalized;
  });
  const sourceNames = items.map(item => item.sourceBasename);
  const cleanupNames = items.map(item => item.cleanupBasename);
  if (new Set(sourceNames).size !== items.length || new Set(cleanupNames).size !== items.length ||
      new Set([...sourceNames, value.finalBasename, ...cleanupNames]).size !==
        (items.length * 2) + 1) {
    fail('CREATE cleanup namespace is not globally disjoint');
  }
  let finalRecordIdentity;
  try { finalRecordIdentity = evidenceSchema.assertObjectIdentity(value.finalRecordIdentity); }
  catch (_) { fail('CREATE cleanup final record identity is invalid'); }
  const normalized = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    createRequestDigest: digest(value.createRequestDigest, 'cleanup createRequestDigest'),
    committedPublicationDigest: digest(
      value.committedPublicationDigest,
      'cleanup committedPublicationDigest'
    ),
    finalizeRequestDigest: digest(value.finalizeRequestDigest, 'cleanup finalizeRequestDigest'),
    finalAckDigest: digest(value.finalAckDigest, 'cleanup finalAckDigest'),
    finalBasename: FINAL_BASENAME_RE.test(value.finalBasename || '')
      ? value.finalBasename
      : fail('CREATE cleanup final basename is invalid'),
    finalRecordIdentity,
    items: immutable(items),
    authorityDigest: digest(value.authorityDigest, 'cleanup authorityDigest'),
  });
  if (normalized.schema !== SCHEMAS.CREATE_CLEANUP_AUTHORITY ||
      normalized.finalRecordIdentity.mode !== 0o600 ||
      normalized.finalRecordIdentity.nlink !== 1 ||
      normalized.authorityDigest !== createCleanupAuthorityDigest(normalized)) {
    fail('CREATE cleanup authority digest is invalid');
  }
  if (rawFinalizationAuthority !== null &&
      evidenceSchema.canonicalJson(normalized) !== evidenceSchema.canonicalJson(
        buildCreateCleanupAuthority(rawFinalizationAuthority, normalized.finalRecordIdentity)
      )) {
    fail('CREATE cleanup authority does not bind finalization authority');
  }
  return normalized;
}

function buildCreateCleanupAuthority(rawFinalizationAuthority, rawFinalRecordIdentity) {
  const authority = createFinalizationAuthority(rawFinalizationAuthority);
  const prepared = buildPreparedCreateFinalization(authority);
  const captured = buildCapturedCreateFinalization(authority, rawFinalRecordIdentity);
  const request = authority.createRequest;
  const items = authority.committedPublication.createCapture.items.flatMap((captureItem, index) =>
    [['CONTROL', captureItem.control], ['RECEIPT', captureItem.receipt]].map(
      ([role, record], roleIndex) => {
        const ordinal = (index * 2) + roleIndex;
        const item = {
          schema: SCHEMAS.CREATE_CLEANUP_ITEM,
          ordinal,
          selectedId: captureItem.selectedId,
          role,
          sourceBasename: record.deterministicBasename,
          cleanupBasename: createCleanupBasename({
            operationId: request.operationId,
            finalAckDigest: prepared.finalAckDigest,
            ordinal,
            role,
            sourceBasename: record.deterministicBasename,
            recordDigest: record.rawSha256,
          }),
          recordDigest: record.rawSha256,
          recordIdentity: record.recordIdentity,
          itemDigest: null,
        };
        item.itemDigest = createCleanupItemDigest(item);
        return immutable(item);
      }
    )
  );
  const cleanup = {
    schema: SCHEMAS.CREATE_CLEANUP_AUTHORITY,
    operationId: request.operationId,
    createRequestDigest: createRequestDigest(request),
    committedPublicationDigest: authority.committedPublication.publicationDigest,
    finalizeRequestDigest: prepared.finalizeRequestDigest,
    finalAckDigest: prepared.finalAckDigest,
    finalBasename: prepared.finalBasename,
    finalRecordIdentity: captured.finalRecordIdentity,
    items: immutable(items),
    authorityDigest: null,
  };
  cleanup.authorityDigest = createCleanupAuthorityDigest(cleanup);
  return assertCreateCleanupAuthority(cleanup);
}

function assertCreateCleanupResult(raw, rawAuthority, expectedCommand) {
  const authority = assertCreateCleanupAuthority(rawAuthority);
  if (!Object.values(CREATE_CLEANUP_COMMANDS).includes(expectedCommand)) {
    fail('CREATE cleanup result command is invalid');
  }
  const value = valuesOf(raw, KEYS.CREATE_CLEANUP_RESULT, 'CREATE cleanup result');
  const committed = value.state === 'COMMITTED';
  const items = arrayValues(
    value.items,
    committed ? authority.items.length : 0,
    committed ? authority.items.length : 0,
    'CREATE cleanup result.items'
  ).map((rawItem, index) => {
    const item = valuesOf(
      rawItem,
      KEYS.CREATE_CLEANUP_RESULT_ITEM,
      `CREATE cleanup result.items[${index}]`
    );
    let cleanupIdentity;
    try { cleanupIdentity = evidenceSchema.assertObjectIdentity(item.cleanupIdentity); }
    catch (_) { fail(`CREATE cleanup result.items[${index}] identity is invalid`); }
    const source = authority.items[index];
    if (item.schema !== SCHEMAS.CREATE_CLEANUP_RESULT_ITEM || item.ordinal !== index ||
        item.cleanupBasename !== source.cleanupBasename ||
        cleanupIdentity.dev !== source.recordIdentity.dev ||
        cleanupIdentity.ino !== source.recordIdentity.ino ||
        cleanupIdentity.uid !== source.recordIdentity.uid ||
        cleanupIdentity.mode !== source.recordIdentity.mode ||
        cleanupIdentity.nlink !== source.recordIdentity.nlink ||
        cleanupIdentity.size !== source.recordIdentity.size ||
        cleanupIdentity.mtimeNs !== source.recordIdentity.mtimeNs ||
        cleanupIdentity.contentSha256 !== source.recordDigest) {
      fail(`CREATE cleanup result.items[${index}] does not bind moved record`);
    }
    return immutable({
      schema: SCHEMAS.CREATE_CLEANUP_RESULT_ITEM,
      ordinal: index,
      cleanupBasename: item.cleanupBasename,
      cleanupIdentity,
    });
  });
  const validStates = expectedCommand === CREATE_CLEANUP_COMMANDS.ACK
    ? ['ACKED', 'UNKNOWN']
    : ['UNCOMMITTED', 'COMMITTED', 'UNKNOWN'];
  const errorCode = value.errorCode;
  const normalized = immutable({
    schema: value.schema,
    command: value.command,
    state: value.state,
    operationId: operationId(value.operationId),
    authorityDigest: digest(value.authorityDigest, 'cleanup result authorityDigest'),
    items: immutable(items),
    errorCode,
  });
  if (normalized.schema !== SCHEMAS.CREATE_CLEANUP_RESULT ||
      normalized.command !== expectedCommand || !validStates.includes(normalized.state) ||
      normalized.operationId !== authority.operationId ||
      normalized.authorityDigest !== authority.authorityDigest ||
      committed !== (items.length === authority.items.length) ||
      (normalized.state === 'UNKNOWN'
        ? normalized.errorCode !== 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN'
        : normalized.errorCode !== null)) {
    fail('CREATE cleanup result authority is invalid');
  }
  return normalized;
}

function encodeCreateCleanupCommand(command, rawAuthority) {
  const authority = assertCreateCleanupAuthority(rawAuthority);
  const letter = command === CREATE_CLEANUP_COMMANDS.CLEANUP
    ? 'G'
    : command === CREATE_CLEANUP_COMMANDS.RECONCILE
      ? 'R'
      : command === CREATE_CLEANUP_COMMANDS.ACK
        ? 'A'
        : fail('CREATE cleanup command is invalid');
  const lines = [[
    letter,
    'CREATE_CLEANUP',
    authority.operationId,
    authority.createRequestDigest,
    authority.committedPublicationDigest,
    authority.finalizeRequestDigest,
    authority.finalAckDigest,
    authority.finalBasename,
    ...identityWireFields(authority.finalRecordIdentity),
    authority.authorityDigest,
    String(authority.items.length),
  ].join('\t')];
  for (const item of authority.items) {
    lines.push([
      'K', String(item.ordinal), item.selectedId, item.role, item.sourceBasename,
      item.cleanupBasename, item.recordDigest, item.itemDigest,
      ...identityWireFields(item.recordIdentity),
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'CREATE cleanup request');
}

function parseCreateCleanupResult(stdout, stderr, rawAuthority, expectedCommand) {
  const authority = assertCreateCleanupAuthority(rawAuthority);
  const text = assertResponseEnvelope(stdout, stderr);
  const lines = text.trimEnd().split('\n');
  const header = lines[1]?.split('\t') || [];
  const expectedLetter = expectedCommand === CREATE_CLEANUP_COMMANDS.ACK ? 'A' :
    expectedCommand === CREATE_CLEANUP_COMMANDS.CLEANUP ? 'G' : 'R';
  if (lines[0] !== 'P\tOK' || header.length !== 7 || header[0] !== expectedLetter ||
      header[1] !== 'OK' || header[3] !== authority.operationId ||
      header[4] !== authority.authorityDigest ||
      !/^(?:0|[1-9][0-9]*)$/u.test(header[5] || '') ||
      Number(header[5]) > authority.items.length || lines.length !== Number(header[5]) + 2) {
    fail('CREATE cleanup native result envelope is invalid');
  }
  const state = header[2];
  const items = lines.slice(2).map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 12 || fields[0] !== 'K' || fields[1] !== String(index) ||
        fields[2] !== authority.items[index]?.cleanupBasename) {
      fail(`CREATE cleanup native result item[${index}] is invalid`);
    }
    const integer = (value, label) => {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value || '')) fail(`${label} is invalid`);
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) fail(`${label} is invalid`);
      return parsed;
    };
    return {
      schema: SCHEMAS.CREATE_CLEANUP_RESULT_ITEM,
      ordinal: index,
      cleanupBasename: fields[2],
      cleanupIdentity: {
        schema: evidenceSchema.SCHEMAS.OBJECT_IDENTITY,
        dev: fields[3],
        ino: fields[4],
        uid: integer(fields[5], `cleanup result item[${index}].uid`),
        mode: integer(fields[6], `cleanup result item[${index}].mode`),
        nlink: integer(fields[7], `cleanup result item[${index}].nlink`),
        size: fields[8],
        mtimeNs: fields[9],
        ctimeNs: fields[10],
        contentSha256: fields[11],
      },
    };
  });
  return assertCreateCleanupResult({
    schema: SCHEMAS.CREATE_CLEANUP_RESULT,
    command: expectedCommand,
    state,
    operationId: header[3],
    authorityDigest: header[4],
    items,
    errorCode: header[6] === '-' ? null : header[6],
  }, authority, expectedCommand);
}

function createJournalBindingDigest(rawBinding, rawValue) {
  const binding = assertCreateJournalPhysicalBinding(rawBinding, rawValue);
  return evidenceSchema.digestObject(SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING, binding);
}

function canonicalTopValueSlice(value, key) {
  const orderedKeys = Object.keys(value).sort(evidenceSchema.compareUnicodeCodePoints);
  let prefix = '{';
  let found = false;
  for (const current of orderedKeys) {
    prefix += `${JSON.stringify(current)}:`;
    if (current === key) {
      found = true;
      break;
    }
    prefix += `${evidenceSchema.canonicalJson(value[current])},`;
  }
  if (!found) fail(`current journal payload lacks ${key}`);
  const bytes = Buffer.from(evidenceSchema.canonicalJson(value[key]), 'utf8');
  return immutable({
    schema: SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICE,
    offset: Buffer.byteLength(prefix, 'utf8'),
    byteLength: bytes.length,
    rawSha256: evidenceSchema.sha256(bytes),
  });
}

function assertCurrentPayloadSlice(raw, label, payloadByteLength) {
  const value = valuesOf(raw, KEYS.CREATE_CURRENT_PAYLOAD_SLICE, label);
  const offset = safeInteger(value.offset, `${label}.offset`, 0, payloadByteLength - 1);
  const byteLength = safeInteger(
    value.byteLength,
    `${label}.byteLength`,
    1,
    payloadByteLength
  );
  if (offset + byteLength > payloadByteLength - 1) fail(`${label} range is invalid`);
  return immutable({
    schema: value.schema === SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICE
      ? value.schema
      : fail(`${label} schema is invalid`),
    offset,
    byteLength,
    rawSha256: digest(value.rawSha256, `${label}.rawSha256`),
  });
}

function assertCreateCurrentPayloadSlices(raw, payloadByteLength) {
  const value = valuesOf(
    raw,
    KEYS.CREATE_CURRENT_PAYLOAD_SLICES,
    'CREATE_MISSING current payload slices'
  );
  const slices = immutable({
    schema: value.schema === SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES
      ? value.schema
      : fail('CREATE_MISSING current payload slices schema is invalid'),
    activeOperationId: assertCurrentPayloadSlice(
      value.activeOperationId, 'currentPayloadSlices.activeOperationId', payloadByteLength
    ),
    projectId: assertCurrentPayloadSlice(
      value.projectId, 'currentPayloadSlices.projectId', payloadByteLength
    ),
    activeKind: assertCurrentPayloadSlice(
      value.activeKind, 'currentPayloadSlices.activeKind', payloadByteLength
    ),
    nativePublication: assertCurrentPayloadSlice(
      value.nativePublication, 'currentPayloadSlices.nativePublication', payloadByteLength
    ),
    activeMarkerDigest: assertCurrentPayloadSlice(
      value.activeMarkerDigest, 'currentPayloadSlices.activeMarkerDigest', payloadByteLength
    ),
  });
  const ranges = [
    'activeOperationId', 'projectId', 'activeKind', 'nativePublication', 'activeMarkerDigest',
  ]
    .map(key => ({ key, start: slices[key].offset, end: slices[key].offset + slices[key].byteLength }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) {
      fail('CREATE_MISSING current payload slices overlap');
    }
  }
  return slices;
}

function assertCurrentPayloadSlicesExcludeActiveMarker(slices, binding) {
  const ranges = [
    'activeOperationId', 'projectId', 'activeKind', 'nativePublication', 'activeMarkerDigest',
  ]
    .map(key => ({ key, start: slices[key].offset, end: slices[key].offset + slices[key].byteLength }));
  ranges.push({
    key: 'activeMarker',
    start: binding.activeMarkerOffset,
    end: binding.activeMarkerOffset + binding.activeMarkerByteLength,
  });
  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end > ranges[index].start) {
      fail('CREATE_MISSING current payload slices overlap activeMarker authority');
    }
  }
  return slices;
}

function buildCreateCurrentPayloadSlices(rawValue) {
  let value;
  try { value = markerJournalSchema.assertJournalValue(rawValue); }
  catch (_) { fail('CREATE_MISSING current journal value is invalid'); }
  return assertCreateCurrentPayloadSlices({
    schema: SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES,
    activeOperationId: canonicalTopValueSlice(value, 'activeOperationId'),
    projectId: canonicalTopValueSlice(value, 'projectId'),
    activeKind: canonicalTopValueSlice(value, 'activeKind'),
    nativePublication: canonicalTopValueSlice(value, 'nativePublication'),
    activeMarkerDigest: canonicalTopValueSlice(value, 'activeMarkerDigest'),
  }, Buffer.byteLength(`${evidenceSchema.canonicalJson(value)}\n`, 'utf8'));
}

function buildCreateJournalAuthority(rawRequest, rawValue) {
  const request = assertCreateRequest(rawRequest);
  let value;
  try { value = markerJournalSchema.assertJournalValue(rawValue); }
  catch (_) { fail('CREATE_MISSING current journal value is invalid'); }
  const preparedPublication = buildLatchedCreatePublication(request);
  if (value.state !== 'ACTIVE' || value.activeOperationId !== request.operationId ||
      value.activeKind !== 'snapshot_restore' || value.nativePublication === null ||
      evidenceSchema.canonicalJson(value.nativePublication) !==
        evidenceSchema.canonicalJson(preparedPublication)) {
    fail('CREATE_MISSING current ACTIVE journal does not carry exact PREPARED authority');
  }
  const journalPhysicalBinding = buildCreateJournalPhysicalBinding(value);
  const currentPayloadSlices = assertCurrentPayloadSlicesExcludeActiveMarker(
    buildCreateCurrentPayloadSlices(value),
    journalPhysicalBinding
  );
  const requestDigest = createRequestDigest(request);
  return immutable({
    schema: SCHEMAS.CREATE_JOURNAL_AUTHORITY,
    request,
    requestDigest,
    preparedPublication,
    journalPhysicalBinding,
    bindingDigest: evidenceSchema.digestObject(
      SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING,
      journalPhysicalBinding
    ),
    currentPayloadSlices,
  });
}

function assertCreateJournalAuthority(raw, rawRequest, rawValue) {
  const value = valuesOf(raw, KEYS.CREATE_JOURNAL_AUTHORITY, 'CREATE_MISSING journal authority');
  const journalPhysicalBinding = assertCreateJournalPhysicalBinding(
    value.journalPhysicalBinding,
    rawValue
  );
  const actual = immutable({
    schema: value.schema,
    request: assertCreateRequest(value.request),
    requestDigest: digest(value.requestDigest, 'journal authority.requestDigest'),
    preparedPublication: (() => {
      try { return markerJournalSchema.assertPublication(value.preparedPublication); }
      catch (_) { fail('journal authority prepared publication is invalid'); }
    })(),
    journalPhysicalBinding,
    bindingDigest: digest(value.bindingDigest, 'journal authority.bindingDigest'),
    currentPayloadSlices: assertCurrentPayloadSlicesExcludeActiveMarker(
      assertCreateCurrentPayloadSlices(
        value.currentPayloadSlices,
        journalPhysicalBinding.payloadByteLength
      ),
      journalPhysicalBinding
    ),
  });
  const expected = buildCreateJournalAuthority(rawRequest, rawValue);
  if (evidenceSchema.canonicalJson(actual) !== evidenceSchema.canonicalJson(expected)) {
    fail('CREATE_MISSING journal authority does not equal original request/current head');
  }
  return expected;
}

function buildCreateJournalCommandToken(rawAuthority, rawRequest, rawValue) {
  const authority = assertCreateJournalAuthority(
    rawAuthority,
    rawRequest,
    rawValue
  );
  return createJournalCommandToken(authority);
}

function createJournalCommandToken(authority) {
  const token = {
    schema: SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN,
    command: 'CREATE_MISSING',
    operationId: authority.request.operationId,
    requestDigest: authority.requestDigest,
    preparedPublicationDigest: authority.preparedPublication.publicationDigest,
    bindingDigest: authority.bindingDigest,
    currentPayloadSlicesDigest: evidenceSchema.digestObject(
      SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES,
      authority.currentPayloadSlices
    ),
    commandDigest: null,
  };
  token.commandDigest = evidenceSchema.digestObject(
    SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN,
    token,
    'commandDigest'
  );
  return immutable(token);
}

function assertCreateMissingJournalResponse(
  raw,
  rawAuthority,
  rawRequest,
  rawValue
) {
  const authority = assertCreateJournalAuthority(
    rawAuthority,
    rawRequest,
    rawValue
  );
  const token = buildCreateJournalCommandToken(
    authority,
    rawRequest,
    rawValue
  );
  const value = valuesOf(raw, KEYS.CREATE_JOURNAL_RESPONSE, 'CREATE_MISSING journal response');
  if (value.schema !== SCHEMAS.CREATE_JOURNAL_RESPONSE || value.command !== 'CREATE_MISSING' ||
      !['COMMITTED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== authority.request.operationId ||
      value.commandDigest !== token.commandDigest ||
      ((value.state === 'COMMITTED') !== (value.publicationResult !== null)) ||
      (value.state === 'COMMITTED' ? value.errorCode !== null :
        value.errorCode !== 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN')) {
    fail('CREATE_MISSING journal response truth is invalid');
  }
  const publicationResult = value.publicationResult === null
    ? null
    : assertCreatePublicationResult(value.publicationResult, authority.request);
  return immutable({
    schema: SCHEMAS.CREATE_JOURNAL_RESPONSE,
    command: 'CREATE_MISSING',
    state: value.state,
    operationId: authority.request.operationId,
    commandDigest: token.commandDigest,
    publicationResult,
    errorCode: value.errorCode,
  });
}

function encodeCreateMissingJournalCommand(
  rawAuthority,
  rawRequest,
  rawValue
) {
  const authority = assertCreateJournalAuthority(
    rawAuthority,
    rawRequest,
    rawValue
  );
  const token = buildCreateJournalCommandToken(
    authority,
    rawRequest,
    rawValue
  );
  const binding = authority.journalPhysicalBinding;
  const lines = [[
    'CJ', token.command, token.commandDigest, authority.request.operationId,
    hexUtf8(binding.projectId), binding.kind,
    authority.requestDigest, authority.preparedPublication.publicationDigest,
    authority.bindingDigest, binding.slot, binding.head.journalId,
    binding.head.generation, binding.head.valueDigest,
    String(binding.frameByteLength), binding.frameSha256,
    String(binding.payloadByteLength), binding.payloadSha256,
    String(binding.activeMarkerOffset), String(binding.activeMarkerByteLength),
    binding.activeMarkerDigest,
    authority.request.artifactDigest, authority.request.artifactIdentityDigest,
    String(authority.request.artifactByteLength), authority.request.precreatePhaseDigest,
    authority.request.selectionDigest, String(authority.request.items.length),
    ...[
      'activeOperationId', 'projectId', 'activeKind', 'nativePublication', 'activeMarkerDigest',
    ].flatMap(key => [
      String(authority.currentPayloadSlices[key].offset),
      String(authority.currentPayloadSlices[key].byteLength),
      authority.currentPayloadSlices[key].rawSha256,
    ]),
  ].join('\t')];
  for (const item of authority.request.items) {
    lines.push([
      'I', item.selectedId, hexUtf8(item.path), String(item.artifactOffset),
      String(item.byteLength), item.contentDigest, item.ancestorIdentityDigest,
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'CREATE_MISSING journal request');
}

function decodeWireHex(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 ||
      !/^[a-f0-9]+$/u.test(value) || value.length / 2 > maximumBytes) {
    fail(`${label} hex is invalid`);
  }
  const bytes = Buffer.from(value, 'hex');
  let decoded;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { fail(`${label} UTF-8 is invalid`); }
  if (decoded.includes('\0') || Buffer.from(decoded, 'utf8').toString('hex') !== value) {
    fail(`${label} is not canonical UTF-8 hex`);
  }
  return decoded;
}

function wireInteger(value, label, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    fail(`${label} decimal is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    fail(`${label} decimal exceeds its budget`);
  }
  return parsed;
}

function parseCreateMissingJournalCommand(rawWire) {
  if (!Buffer.isBuffer(rawWire) && typeof rawWire !== 'string') {
    fail('CREATE_MISSING journal command must be raw bytes or text');
  }
  const bytes = Buffer.isBuffer(rawWire) ? rawWire : Buffer.from(rawWire, 'utf8');
  if (bytes.length === 0 || bytes.length > LIMITS.maxRequestBytes || bytes.includes(0) ||
      bytes[bytes.length - 1] !== 0x0a) {
    fail('CREATE_MISSING journal command envelope is invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { fail('CREATE_MISSING journal command UTF-8 is invalid'); }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2 || lines.length > LIMITS.maxItems + 1 ||
      lines.some(line => line.length === 0 ||
        Buffer.byteLength(line, 'utf8') > LIMITS.maxLineBytes)) {
    fail('CREATE_MISSING journal command line budget is invalid');
  }
  const fields = lines[0].split('\t');
  if (fields.length !== 41 || fields[0] !== 'CJ' || fields[1] !== 'CREATE_MISSING' ||
      !/^sha256:[a-f0-9]{64}$/u.test(fields[2])) {
    fail('CREATE_MISSING journal command header is invalid');
  }
  const operation = operationId(fields[3]);
  const projectId = decodeWireHex(fields[4], 'projectId', 4096);
  if (projectId !== projectId.normalize('NFC') || fields[5] !== 'snapshot_restore') {
    fail('CREATE_MISSING journal project/kind authority is invalid');
  }
  const itemCount = wireInteger(fields[25], 'itemCount', LIMITS.maxItems);
  if (itemCount < 1 || lines.length !== itemCount + 1) {
    fail('CREATE_MISSING journal item count is invalid');
  }
  const request = assertCreateRequest({
    schema: SCHEMAS.CREATE_REQUEST,
    operationId: operation,
    artifactDigest: fields[20],
    artifactIdentityDigest: fields[21],
    artifactByteLength: wireInteger(
      fields[22], 'artifactByteLength', LIMITS.maxArtifactBytes
    ),
    precreatePhaseDigest: fields[23],
    selectionDigest: fields[24],
    items: lines.slice(1).map((line, index) => {
      const item = line.split('\t');
      if (item.length !== 7 || item[0] !== 'I') {
        fail(`CREATE_MISSING journal item ${index} is invalid`);
      }
      return {
        selectedId: item[1],
        path: decodeWireHex(item[2], `items[${index}].path`, LIMITS.maxRootBytes),
        artifactOffset: wireInteger(
          item[3], `items[${index}].artifactOffset`, LIMITS.maxArtifactBytes
        ),
        byteLength: wireInteger(
          item[4], `items[${index}].byteLength`, LIMITS.maxArtifactBytes
        ),
        contentDigest: item[5],
        ancestorIdentityDigest: item[6],
      };
    }),
  });
  const requestDigestValue = createRequestDigest(request);
  if (fields[6] !== requestDigestValue) {
    fail('CREATE_MISSING journal request digest cannot be reproduced');
  }
  const preparedPublication = buildLatchedCreatePublication(request);
  if (fields[7] !== preparedPublication.publicationDigest) {
    fail('CREATE_MISSING PREPARED publication digest cannot be reproduced');
  }
  const journalPhysicalBinding = assertCreateJournalPhysicalBindingStructure({
    schema: SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING,
    operationId: operation,
    projectId,
    kind: 'snapshot_restore',
    slot: fields[9],
    head: {
      schema: markerJournalSchema.SCHEMAS.HEAD,
      journalId: fields[10],
      generation: fields[11],
      valueDigest: fields[12],
    },
    frameByteLength: wireInteger(
      fields[13], 'frameByteLength', markerJournalSchema.MAX_FRAME_BYTES
    ),
    frameSha256: fields[14],
    payloadByteLength: wireInteger(
      fields[15], 'payloadByteLength', markerJournalSchema.MAX_VALUE_BYTES
    ),
    payloadSha256: fields[16],
    activeMarkerOffset: wireInteger(
      fields[17], 'activeMarkerOffset', markerJournalSchema.MAX_VALUE_BYTES
    ),
    activeMarkerByteLength: wireInteger(
      fields[18], 'activeMarkerByteLength', markerJournalSchema.MAX_ACTIVE_MARKER_BYTES
    ),
    activeMarkerDigest: fields[19],
  });
  const bindingDigest = evidenceSchema.digestObject(
    SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING,
    journalPhysicalBinding
  );
  if (fields[8] !== bindingDigest) {
    fail('CREATE_MISSING journal binding digest cannot be reproduced');
  }
  const sliceKeys = [
    'activeOperationId', 'projectId', 'activeKind', 'nativePublication', 'activeMarkerDigest',
  ];
  const rawSlices = { schema: SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES };
  sliceKeys.forEach((key, index) => {
    const offset = 26 + (index * 3);
    rawSlices[key] = {
      schema: SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICE,
      offset: wireInteger(
        fields[offset], `currentPayloadSlices.${key}.offset`, journalPhysicalBinding.payloadByteLength
      ),
      byteLength: wireInteger(
        fields[offset + 1],
        `currentPayloadSlices.${key}.byteLength`,
        journalPhysicalBinding.payloadByteLength
      ),
      rawSha256: fields[offset + 2],
    };
  });
  const currentPayloadSlices = assertCurrentPayloadSlicesExcludeActiveMarker(
    assertCreateCurrentPayloadSlices(rawSlices, journalPhysicalBinding.payloadByteLength),
    journalPhysicalBinding
  );
  const authority = immutable({
    schema: SCHEMAS.CREATE_JOURNAL_AUTHORITY,
    request,
    requestDigest: requestDigestValue,
    preparedPublication,
    journalPhysicalBinding,
    bindingDigest,
    currentPayloadSlices,
  });
  const token = createJournalCommandToken(authority);
  if (fields[2] !== token.commandDigest) {
    fail('CREATE_MISSING journal command digest cannot be reproduced');
  }
  return authority;
}

function verifyCreateMissingJournalPhysicalAuthority(
  rawWire,
  rawFrame
) {
  const authority = parseCreateMissingJournalCommand(rawWire);
  if (!Buffer.isBuffer(rawFrame)) fail('CREATE_MISSING physical authority requires exact frame');
  const binding = authority.journalPhysicalBinding;
  if (rawFrame.length !== binding.frameByteLength ||
      evidenceSchema.sha256(rawFrame) !== binding.frameSha256) {
    fail('CREATE_MISSING physical journal frame does not bind command');
  }
  const newline = rawFrame.indexOf(0x0a);
  if (newline < 0 || newline + 1 > markerJournalSchema.MAX_HEADER_BYTES) {
    fail('CREATE_MISSING physical journal header is invalid');
  }
  let header;
  try {
    header = new TextDecoder('utf-8', { fatal: true })
      .decode(rawFrame.subarray(0, newline)).split('\t');
  } catch (_) { fail('CREATE_MISSING physical journal header UTF-8 is invalid'); }
  if (header.length !== 8 || header[0] !== markerJournalSchema.JOURNAL_MAGIC ||
      header[1] !== binding.slot || header[2] !== binding.head.journalId ||
      header[3] !== binding.head.generation || header[5] !== binding.head.valueDigest ||
      !/^(?:-|sha256:[a-f0-9]{64})$/u.test(header[6]) ||
      header[7] !== binding.payloadSha256 ||
      wireInteger(header[4], 'physical payloadByteLength', markerJournalSchema.MAX_VALUE_BYTES) !==
        binding.payloadByteLength) {
    fail('CREATE_MISSING physical journal header does not bind expected head');
  }
  const payload = rawFrame.subarray(newline + 1);
  if (payload.length !== binding.payloadByteLength ||
      evidenceSchema.sha256(payload) !== binding.payloadSha256 ||
      payload[payload.length - 1] !== 0x0a) {
    fail('CREATE_MISSING physical journal payload is invalid');
  }
  const markerBytes = payload.subarray(
    binding.activeMarkerOffset,
    binding.activeMarkerOffset + binding.activeMarkerByteLength
  );
  const activeMarkerDigestPayload = Buffer.concat([
    Buffer.from('{"marker":', 'utf8'),
    markerBytes,
    Buffer.from(`,"schema":${JSON.stringify(markerJournalSchema.SCHEMAS.ACTIVE_MARKER)}}`, 'utf8'),
  ]);
  const physicalActiveMarkerDigest = evidenceSchema.sha256(Buffer.concat([
    evidenceSchema.DIGEST_DOMAIN,
    Buffer.from([0]),
    Buffer.from(markerJournalSchema.SCHEMAS.ACTIVE_MARKER, 'utf8'),
    Buffer.from([0]),
    activeMarkerDigestPayload,
  ]));
  if (physicalActiveMarkerDigest !== binding.activeMarkerDigest) {
    fail('CREATE_MISSING physical activeMarker digest is foreign');
  }
  const expected = {
    activeOperationId: authority.request.operationId,
    projectId: binding.projectId,
    activeKind: 'snapshot_restore',
    nativePublication: authority.preparedPublication,
    activeMarkerDigest: physicalActiveMarkerDigest,
  };
  for (const key of Object.keys(expected)) {
    const slice = authority.currentPayloadSlices[key];
    const expectedBytes = Buffer.from(evidenceSchema.canonicalJson(expected[key]), 'utf8');
    const actualBytes = payload.subarray(slice.offset, slice.offset + slice.byteLength);
    if (expectedBytes.length !== slice.byteLength || !actualBytes.equals(expectedBytes) ||
        evidenceSchema.sha256(actualBytes) !== slice.rawSha256) {
      fail(`CREATE_MISSING physical ${key} slice is foreign`);
    }
  }
  return authority;
}

function recordKey(request, item) {
  const key = {
    schema: SCHEMAS.RECORD_KEY,
    operationId: request.operationId,
    selectedId: item.selectedId,
    artifactDigest: request.artifactDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
  };
  return evidenceSchema.digestObject(SCHEMAS.RECORD_KEY, key).slice('sha256:'.length);
}

function recordNames(rawRequest, index) {
  const request = assertCreateRequest(rawRequest);
  safeInteger(index, 'item index', 0, request.items.length - 1);
  const suffix = recordKey(request, request.items[index]);
  return immutable({
    controlBasename: `.changes-history-native-create-control.${suffix}`,
    receiptBasename: `.changes-history-native-create-receipt.${suffix}`,
  });
}

function buildControl(rawRequest, index) {
  const request = assertCreateRequest(rawRequest);
  safeInteger(index, 'item index', 0, request.items.length - 1);
  const item = request.items[index];
  const control = {
    schema: SCHEMAS.CONTROL,
    operationId: request.operationId,
    selectedId: item.selectedId,
    path: item.path,
    artifactDigest: request.artifactDigest,
    artifactIdentityDigest: request.artifactIdentityDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    artifactOffset: item.artifactOffset,
    byteLength: item.byteLength,
    contentDigest: item.contentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    controlDigest: null,
  };
  control.controlDigest = evidenceSchema.digestObject(SCHEMAS.CONTROL, control, 'controlDigest');
  return assertControl(control);
}

function assertControl(raw) {
  const value = valuesOf(raw, KEYS.CONTROL, 'create control');
  if (value.schema !== SCHEMAS.CONTROL) fail('create control schema is invalid');
  const control = {
    schema: SCHEMAS.CONTROL,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    path: markdownPath(value.path),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    artifactOffset: safeInteger(
      value.artifactOffset,
      'artifactOffset',
      0,
      LIMITS.maxArtifactBytes - 1
    ),
    byteLength: safeInteger(value.byteLength, 'byteLength', 1, LIMITS.maxArtifactBytes),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    ancestorIdentityDigest: digest(value.ancestorIdentityDigest, 'ancestorIdentityDigest'),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
  };
  const expected = evidenceSchema.digestObject(SCHEMAS.CONTROL, control, 'controlDigest');
  if (control.controlDigest !== expected) fail('controlDigest cannot be reproduced');
  return immutable(control);
}

function buildReceipt(rawControl, createdIdentityDigest) {
  const control = assertControl(rawControl);
  const receipt = {
    schema: SCHEMAS.RECEIPT,
    operationId: control.operationId,
    selectedId: control.selectedId,
    controlDigest: control.controlDigest,
    createdIdentityDigest: digest(createdIdentityDigest, 'createdIdentityDigest'),
    contentDigest: control.contentDigest,
    byteLength: control.byteLength,
    fileFsyncComplete: true,
    parentFsyncComplete: true,
    recoveryFsyncComplete: true,
    receiptDigest: null,
  };
  receipt.receiptDigest = evidenceSchema.digestObject(SCHEMAS.RECEIPT, receipt, 'receiptDigest');
  return assertReceipt(receipt, control);
}

function assertReceipt(raw, rawControl = null) {
  const value = valuesOf(raw, KEYS.RECEIPT, 'create receipt');
  if (value.schema !== SCHEMAS.RECEIPT || value.fileFsyncComplete !== true ||
      value.parentFsyncComplete !== true || value.recoveryFsyncComplete !== true) {
    fail('create receipt state is invalid');
  }
  const receipt = {
    schema: SCHEMAS.RECEIPT,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    byteLength: safeInteger(value.byteLength, 'byteLength', 1, LIMITS.maxArtifactBytes),
    fileFsyncComplete: true,
    parentFsyncComplete: true,
    recoveryFsyncComplete: true,
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  };
  const expected = evidenceSchema.digestObject(SCHEMAS.RECEIPT, receipt, 'receiptDigest');
  if (receipt.receiptDigest !== expected) fail('receiptDigest cannot be reproduced');
  if (rawControl) {
    const control = assertControl(rawControl);
    if (receipt.operationId !== control.operationId || receipt.selectedId !== control.selectedId ||
        receipt.controlDigest !== control.controlDigest ||
        receipt.contentDigest !== control.contentDigest || receipt.byteLength !== control.byteLength) {
      fail('create receipt does not bind its exact control');
    }
  }
  return immutable(receipt);
}

function buildToken(rawRequest, index, rawReceipt) {
  const request = assertCreateRequest(rawRequest);
  const control = buildControl(request, index);
  const receipt = assertReceipt(rawReceipt, control);
  const names = recordNames(request, index);
  return assertToken({
    schema: SCHEMAS.TOKEN,
    operationId: request.operationId,
    selectedId: control.selectedId,
    controlBasename: names.controlBasename,
    receiptBasename: names.receiptBasename,
    controlDigest: control.controlDigest,
    createdIdentityDigest: receipt.createdIdentityDigest,
    contentDigest: receipt.contentDigest,
    receiptDigest: receipt.receiptDigest,
  }, request.items[index]);
}

function assertToken(raw, expectedItem = null) {
  const value = valuesOf(raw, KEYS.TOKEN, 'create token');
  if (value.schema !== SCHEMAS.TOKEN || !CONTROL_BASENAME_RE.test(value.controlBasename || '') ||
      !RECEIPT_BASENAME_RE.test(value.receiptBasename || '')) {
    fail('create token identity is invalid');
  }
  const token = {
    schema: SCHEMAS.TOKEN,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    controlBasename: value.controlBasename,
    receiptBasename: value.receiptBasename,
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  };
  if (expectedItem && (token.selectedId !== expectedItem.selectedId ||
      token.contentDigest !== expectedItem.contentDigest)) {
    fail('create token does not bind its expected item');
  }
  return immutable(token);
}

function assertBoundToken(raw, rawRequest, index) {
  const request = assertCreateRequest(rawRequest);
  safeInteger(index, 'token index', 0, request.items.length - 1);
  const token = assertToken(raw, request.items[index]);
  const control = buildControl(request, index);
  const names = recordNames(request, index);
  const receipt = buildReceipt(control, token.createdIdentityDigest);
  if (token.operationId !== request.operationId ||
      token.controlBasename !== names.controlBasename ||
      token.receiptBasename !== names.receiptBasename ||
      token.controlDigest !== control.controlDigest ||
      token.receiptDigest !== receipt.receiptDigest) {
    fail('create token does not reproduce its exact record authority');
  }
  return token;
}

function assertResult(raw, rawRequest, expectedCommand) {
  const request = assertCreateRequest(rawRequest);
  if (!['CREATE', 'RECONCILE'].includes(expectedCommand)) {
    fail('expected native create command is required');
  }
  const value = valuesOf(raw, KEYS.RESULT, 'create result');
  if (value.schema !== SCHEMAS.RESULT || value.command !== expectedCommand ||
      !['COMMITTED', 'UNCOMMITTED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== request.operationId || value.artifactDigest !== request.artifactDigest ||
      value.precreatePhaseDigest !== request.precreatePhaseDigest ||
      value.selectionDigest !== request.selectionDigest) {
    fail('create result authority is invalid');
  }
  const tokens = arrayValues(
    value.tokens,
    value.state === 'COMMITTED' ? request.items.length : 0,
    value.state === 'COMMITTED' ? request.items.length : 0,
    'result.tokens'
  ).map((token, index) => assertBoundToken(token, request, index));
  if (tokens.some(token => token.operationId !== request.operationId) ||
      new Set(tokens.map(token => token.controlDigest)).size !== tokens.length ||
      new Set(tokens.map(token => token.createdIdentityDigest)).size !== tokens.length ||
      new Set(tokens.map(token => token.receiptDigest)).size !== tokens.length) {
    fail('create result token authority is invalid');
  }
  if ((value.state === 'UNKNOWN') !==
      (value.errorCode === 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN') ||
      (value.state !== 'UNKNOWN' && value.errorCode !== null)) {
    fail('create result truth/error matrix is invalid');
  }
  return immutable({
    schema: SCHEMAS.RESULT,
    command: value.command,
    state: value.state,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    tokens: immutable(tokens),
    errorCode: value.errorCode,
  });
}

function assertFinalizeRequest(raw, rawCreateRequest) {
  const createRequest = assertCreateRequest(rawCreateRequest);
  const value = valuesOf(raw, KEYS.FINALIZE_REQUEST, 'finalize request');
  if (value.schema !== SCHEMAS.FINALIZE_REQUEST) fail('finalize request schema is invalid');
  const tokens = arrayValues(value.tokens, 1, LIMITS.maxItems, 'tokens')
    .map(token => assertToken(token));
  const result = {
    schema: SCHEMAS.FINALIZE_REQUEST,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    tokens: immutable(tokens),
  };
  if (tokens.some(token => token.operationId !== result.operationId) ||
      new Set(tokens.map(token => token.selectedId)).size !== tokens.length ||
      new Set(tokens.map(token => token.receiptDigest)).size !== tokens.length) {
    fail('finalize token set is invalid');
  }
  if (result.operationId !== createRequest.operationId ||
      result.artifactDigest !== createRequest.artifactDigest ||
      result.selectionDigest !== createRequest.selectionDigest ||
      tokens.length !== createRequest.items.length) {
    fail('finalize request is not the complete create authority');
  }
  tokens.forEach((token, index) => assertBoundToken(token, createRequest, index));
  return immutable(result);
}

function receiptSet(rawFinalizeRequest, rawCreateRequest) {
  const request = assertFinalizeRequest(rawFinalizeRequest, rawCreateRequest);
  return immutable({
    schema: SCHEMAS.RECEIPT_SET,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    items: immutable(request.tokens.map(token => immutable({
      selectedId: token.selectedId,
      controlDigest: token.controlDigest,
      createdIdentityDigest: token.createdIdentityDigest,
      receiptDigest: token.receiptDigest,
    }))),
  });
}

function receiptSetDigest(rawFinalizeRequest, rawCreateRequest) {
  return evidenceSchema.digestObject(
    SCHEMAS.RECEIPT_SET,
    receiptSet(rawFinalizeRequest, rawCreateRequest)
  );
}

function finalRecordName(rawFinalizeRequest, rawCreateRequest) {
  const request = assertFinalizeRequest(rawFinalizeRequest, rawCreateRequest);
  const setDigest = receiptSetDigest(request, rawCreateRequest);
  const key = {
    schema: SCHEMAS.FINAL_KEY,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    historyCommittedPhaseDigest: request.historyCommittedPhaseDigest,
    receiptSetDigest: setDigest,
  };
  return `.changes-history-native-create-final.${evidenceSchema.digestObject(
    SCHEMAS.FINAL_KEY,
    key
  ).slice('sha256:'.length)}`;
}

function buildFinalAck(rawFinalizeRequest, rawCreateRequest) {
  const request = assertFinalizeRequest(rawFinalizeRequest, rawCreateRequest);
  const ack = {
    schema: SCHEMAS.FINAL_ACK,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    historyCommittedPhaseDigest: request.historyCommittedPhaseDigest,
    receiptSetDigest: receiptSetDigest(request, rawCreateRequest),
    itemCount: request.tokens.length,
    recoveryFsyncComplete: true,
    finalAckDigest: null,
  };
  ack.finalAckDigest = evidenceSchema.digestObject(SCHEMAS.FINAL_ACK, ack, 'finalAckDigest');
  return assertFinalAck(ack, request, rawCreateRequest);
}

function assertFinalAck(raw, rawFinalizeRequest, rawCreateRequest) {
  const request = assertFinalizeRequest(rawFinalizeRequest, rawCreateRequest);
  const value = valuesOf(raw, KEYS.FINAL_ACK, 'final ack');
  if (value.schema !== SCHEMAS.FINAL_ACK || value.recoveryFsyncComplete !== true) {
    fail('final ack state is invalid');
  }
  const ack = {
    schema: SCHEMAS.FINAL_ACK,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    historyCommittedPhaseDigest: digest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    receiptSetDigest: digest(value.receiptSetDigest, 'receiptSetDigest'),
    itemCount: safeInteger(value.itemCount, 'itemCount', 1, LIMITS.maxItems),
    recoveryFsyncComplete: true,
    finalAckDigest: digest(value.finalAckDigest, 'finalAckDigest'),
  };
  if (ack.finalAckDigest !== evidenceSchema.digestObject(
    SCHEMAS.FINAL_ACK,
    ack,
    'finalAckDigest'
  )) fail('finalAckDigest cannot be reproduced');
  if (ack.operationId !== request.operationId || ack.artifactDigest !== request.artifactDigest ||
      ack.selectionDigest !== request.selectionDigest ||
      ack.historyCommittedPhaseDigest !== request.historyCommittedPhaseDigest ||
      ack.itemCount !== request.tokens.length ||
      ack.receiptSetDigest !== receiptSetDigest(request, rawCreateRequest)) {
    fail('final ack does not bind the exact receipt set');
  }
  return immutable(ack);
}

function assertUndoRequest(raw, rawRootBind, rawParentSelection, rawPrecreatePhase) {
  if (rawRootBind === undefined || rawParentSelection === undefined ||
      rawPrecreatePhase === undefined) {
    fail('undo request requires complete root/selection/phase authority');
  }
  const rootBind = assertRootBind(rawRootBind);
  let parent;
  let phase;
  try {
    parent = phaseSchema.assertParentSelectionBinding(rawParentSelection);
    phase = phaseSchema.assertPhaseRecord(rawPrecreatePhase, parent);
  } catch (_) { fail('undo request parent phase authority is invalid'); }
  if (parent.kind !== 'snapshot_restore_undo' || phase.kind !== 'snapshot_restore_undo' ||
      phase.phase !== 'PRECREATE') fail('undo request requires PRECREATE Safe Undo authority');
  const value = valuesOf(raw, KEYS.UNDO_REQUEST, 'undo request');
  if (value.schema !== SCHEMAS.UNDO_REQUEST) fail('undo request schema is invalid');
  const artifactByteLength = safeInteger(
    value.artifactByteLength,
    'artifactByteLength',
    1,
    LIMITS.maxArtifactBytes
  );
  const expectedItems = phase.items;
  const items = arrayValues(
    value.items,
    expectedItems.length,
    expectedItems.length,
    'undo items'
  ).map((rawItem, index) => {
    const item = valuesOf(rawItem, KEYS.UNDO_ITEM, `undo items[${index}]`);
    const normalized = immutable({
      selectedId: selectedId(item.selectedId, `undo items[${index}].selectedId`),
      path: markdownPath(item.path, `undo items[${index}].path`),
      byteLength: safeInteger(
        item.byteLength,
        `undo items[${index}].byteLength`,
        1,
        artifactByteLength
      ),
      contentDigest: digest(item.contentDigest, `undo items[${index}].contentDigest`),
      ancestorIdentityDigest: digest(
        item.ancestorIdentityDigest,
        `undo items[${index}].ancestorIdentityDigest`
      ),
      createdIdentityDigest: digest(
        item.createdIdentityDigest,
        `undo items[${index}].createdIdentityDigest`
      ),
    });
    const expected = expectedItems[index];
    if (normalized.selectedId !== expected.selectedId || normalized.path !== expected.path ||
        normalized.contentDigest !== `sha256:${expected.afterRevision}` ||
        normalized.ancestorIdentityDigest !== expected.ancestorIdentityDigest ||
        normalized.createdIdentityDigest !== expected.createdIdentityDigest) {
      fail('undo items do not equal the complete ordered CREATED subset');
    }
    return normalized;
  });
  if (new Set(items.map(item => item.selectedId)).size !== items.length ||
      new Set(items.map(item => item.path)).size !== items.length ||
      new Set(items.map(item => item.createdIdentityDigest)).size !== items.length) {
    fail('undo request contains duplicate item authority');
  }
  const request = immutable({
    schema: SCHEMAS.UNDO_REQUEST,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    artifactByteLength,
    rootIdentityDigest: digest(value.rootIdentityDigest, 'rootIdentityDigest'),
    recoveryIdentityDigest: digest(value.recoveryIdentityDigest, 'recoveryIdentityDigest'),
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    preparedHistoryDigest: digest(value.preparedHistoryDigest, 'preparedHistoryDigest'),
    items: immutable(items),
  });
  const expectedPhaseDigest = evidenceSchema.digestObject(phaseSchema.SCHEMA, phase);
  if (request.operationId !== phase.operationId ||
      request.artifactDigest !== phase.artifactDigest ||
      request.rootIdentityDigest !== rootBind.expectedRootIdentityDigest ||
      request.recoveryIdentityDigest !== rootBind.expectedRecoveryIdentityDigest ||
      request.precreatePhaseDigest !== expectedPhaseDigest ||
      request.selectionDigest !== phase.selectionDigest ||
      request.preparedHistoryDigest !== phase.preparedHistoryDigest) {
    fail('undo request does not bind original root/artifact/History/phase authority');
  }
  return request;
}

function buildUndoAuthority(rawRootBind, rawParentSelection, rawPrecreatePhase, rawRequest) {
  const rootBind = assertRootBind(rawRootBind);
  let parentSelection;
  let precreatePhase;
  try {
    parentSelection = phaseSchema.assertParentSelectionBinding(rawParentSelection);
    precreatePhase = phaseSchema.assertPhaseRecord(rawPrecreatePhase, parentSelection);
  } catch (_) { fail('undo authority phase binding is invalid'); }
  const request = assertUndoRequest(rawRequest, rootBind, parentSelection, precreatePhase);
  const authority = immutable({ rootBind, parentSelection, precreatePhase, request });
  validatedUndoAuthorities.add(authority);
  return authority;
}

function assertUndoAuthority(raw) {
  if (validatedUndoAuthorities.has(raw)) return raw;
  const value = valuesOf(raw, KEYS.UNDO_AUTHORITY, 'undo authority');
  return buildUndoAuthority(
    value.rootBind,
    value.parentSelection,
    value.precreatePhase,
    value.request
  );
}

function undoRecordKey(authority, item) {
  return evidenceSchema.digestObject(SCHEMAS.UNDO_RECORD_KEY, {
    schema: SCHEMAS.UNDO_RECORD_KEY,
    operationId: authority.request.operationId,
    selectedId: item.selectedId,
    artifactDigest: authority.request.artifactDigest,
    precreatePhaseDigest: authority.request.precreatePhaseDigest,
    selectionDigest: authority.request.selectionDigest,
    preparedHistoryDigest: authority.request.preparedHistoryDigest,
    createdIdentityDigest: item.createdIdentityDigest,
  }).slice('sha256:'.length);
}

function undoRecordNames(rawAuthority, index) {
  const authority = assertUndoAuthority(rawAuthority);
  safeInteger(index, 'undo item index', 0, authority.request.items.length - 1);
  const suffix = undoRecordKey(authority, authority.request.items[index]);
  return immutable({
    controlBasename: `.changes-history-native-undo-control.${suffix}`,
    receiptBasename: `.changes-history-native-undo-receipt.${suffix}`,
  });
}

function buildUndoControl(rawAuthority, index) {
  const authority = assertUndoAuthority(rawAuthority);
  safeInteger(index, 'undo item index', 0, authority.request.items.length - 1);
  const request = authority.request;
  const item = request.items[index];
  const control = {
    schema: SCHEMAS.UNDO_CONTROL,
    operationId: request.operationId,
    selectedId: item.selectedId,
    path: item.path,
    artifactDigest: request.artifactDigest,
    artifactIdentityDigest: request.artifactIdentityDigest,
    artifactByteLength: request.artifactByteLength,
    rootIdentityDigest: request.rootIdentityDigest,
    recoveryIdentityDigest: request.recoveryIdentityDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    preparedHistoryDigest: request.preparedHistoryDigest,
    byteLength: item.byteLength,
    contentDigest: item.contentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    createdIdentityDigest: item.createdIdentityDigest,
    controlDigest: null,
  };
  control.controlDigest = evidenceSchema.digestObject(
    SCHEMAS.UNDO_CONTROL,
    control,
    'controlDigest'
  );
  return assertUndoControl(control, authority, index);
}

function assertUndoControl(raw, rawAuthority, index) {
  if (rawAuthority === undefined) fail('undo control requires original authority');
  const authority = assertUndoAuthority(rawAuthority);
  safeInteger(index, 'undo item index', 0, authority.request.items.length - 1);
  const value = valuesOf(raw, KEYS.UNDO_CONTROL, 'undo control');
  const control = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    path: markdownPath(value.path),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    artifactIdentityDigest: digest(value.artifactIdentityDigest, 'artifactIdentityDigest'),
    artifactByteLength: safeInteger(
      value.artifactByteLength,
      'artifactByteLength',
      1,
      LIMITS.maxArtifactBytes
    ),
    rootIdentityDigest: digest(value.rootIdentityDigest, 'rootIdentityDigest'),
    recoveryIdentityDigest: digest(value.recoveryIdentityDigest, 'recoveryIdentityDigest'),
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    preparedHistoryDigest: digest(value.preparedHistoryDigest, 'preparedHistoryDigest'),
    byteLength: safeInteger(value.byteLength, 'byteLength', 1, LIMITS.maxArtifactBytes),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    ancestorIdentityDigest: digest(value.ancestorIdentityDigest, 'ancestorIdentityDigest'),
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
  });
  if (control.schema !== SCHEMAS.UNDO_CONTROL ||
      control.controlDigest !== evidenceSchema.digestObject(
        SCHEMAS.UNDO_CONTROL,
        control,
        'controlDigest'
      )) fail('undo control digest cannot be reproduced');
  const request = authority.request;
  const item = request.items[index];
  const { controlDigest: _digest, schema: _schema, ...bound } = control;
  const expected = {
    operationId: request.operationId,
    selectedId: item.selectedId,
    path: item.path,
    artifactDigest: request.artifactDigest,
    artifactIdentityDigest: request.artifactIdentityDigest,
    artifactByteLength: request.artifactByteLength,
    rootIdentityDigest: request.rootIdentityDigest,
    recoveryIdentityDigest: request.recoveryIdentityDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    preparedHistoryDigest: request.preparedHistoryDigest,
    byteLength: item.byteLength,
    contentDigest: item.contentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    createdIdentityDigest: item.createdIdentityDigest,
  };
  if (Object.keys(expected).some(key => bound[key] !== expected[key])) {
    fail('undo control does not bind original authority');
  }
  return control;
}

function buildUndoReceipt(rawAuthority, index, quarantineBasename, quarantineIdentityDigest) {
  const authority = assertUndoAuthority(rawAuthority);
  if (!UNDO_QUARANTINE_BASENAME_RE.test(quarantineBasename || '')) {
    fail('undo quarantine basename is invalid');
  }
  const control = buildUndoControl(authority, index);
  const receipt = {
    schema: SCHEMAS.UNDO_RECEIPT,
    operationId: control.operationId,
    selectedId: control.selectedId,
    controlDigest: control.controlDigest,
    quarantineBasename,
    createdIdentityDigest: control.createdIdentityDigest,
    quarantineIdentityDigest: digest(quarantineIdentityDigest, 'quarantineIdentityDigest'),
    contentDigest: control.contentDigest,
    byteLength: control.byteLength,
    publicParentFsyncComplete: true,
    recoveryFsyncComplete: true,
    receiptDigest: null,
  };
  receipt.receiptDigest = evidenceSchema.digestObject(
    SCHEMAS.UNDO_RECEIPT,
    receipt,
    'receiptDigest'
  );
  return assertUndoReceipt(receipt, authority, index);
}

function assertUndoReceipt(raw, rawAuthority, index) {
  if (rawAuthority === undefined) fail('undo receipt requires original authority');
  const authority = assertUndoAuthority(rawAuthority);
  const control = buildUndoControl(authority, index);
  const value = valuesOf(raw, KEYS.UNDO_RECEIPT, 'undo receipt');
  const receipt = immutable({
    schema: value.schema,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    quarantineBasename: value.quarantineBasename,
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    quarantineIdentityDigest: digest(value.quarantineIdentityDigest, 'quarantineIdentityDigest'),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    byteLength: safeInteger(value.byteLength, 'byteLength', 1, LIMITS.maxArtifactBytes),
    publicParentFsyncComplete: value.publicParentFsyncComplete,
    recoveryFsyncComplete: value.recoveryFsyncComplete,
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (receipt.schema !== SCHEMAS.UNDO_RECEIPT ||
      !UNDO_QUARANTINE_BASENAME_RE.test(receipt.quarantineBasename || '') ||
      receipt.publicParentFsyncComplete !== true || receipt.recoveryFsyncComplete !== true ||
      receipt.receiptDigest !== evidenceSchema.digestObject(
        SCHEMAS.UNDO_RECEIPT,
        receipt,
        'receiptDigest'
      ) || receipt.operationId !== control.operationId ||
      receipt.selectedId !== control.selectedId ||
      receipt.controlDigest !== control.controlDigest ||
      receipt.createdIdentityDigest !== control.createdIdentityDigest ||
      receipt.contentDigest !== control.contentDigest || receipt.byteLength !== control.byteLength) {
    fail('undo receipt does not bind exact quarantine authority');
  }
  return receipt;
}

function buildUndoToken(
  rawAuthority,
  index,
  rawReceipt,
  rawControlRecordIdentity,
  rawReceiptRecordIdentity
) {
  const authority = assertUndoAuthority(rawAuthority);
  const control = buildUndoControl(authority, index);
  const receipt = assertUndoReceipt(rawReceipt, authority, index);
  const names = undoRecordNames(authority, index);
  const controlRecordIdentity = assertPrivateRecordIdentity(
    rawControlRecordIdentity,
    encodeUndoControlRecord(control, authority, index),
    'undo control record identity'
  );
  const receiptRecordIdentity = assertPrivateRecordIdentity(
    rawReceiptRecordIdentity,
    encodeUndoReceiptRecord(receipt, authority, index),
    'undo receipt record identity'
  );
  return assertBoundUndoToken({
    schema: SCHEMAS.UNDO_TOKEN,
    operationId: control.operationId,
    selectedId: control.selectedId,
    controlBasename: names.controlBasename,
    receiptBasename: names.receiptBasename,
    quarantineBasename: receipt.quarantineBasename,
    controlDigest: control.controlDigest,
    createdIdentityDigest: receipt.createdIdentityDigest,
    quarantineIdentityDigest: receipt.quarantineIdentityDigest,
    contentDigest: receipt.contentDigest,
    receiptDigest: receipt.receiptDigest,
    controlRecordIdentity,
    receiptRecordIdentity,
  }, authority, index);
}

function parseUndoTokenStructure(raw) {
  const value = valuesOf(raw, KEYS.UNDO_TOKEN, 'undo token');
  if (value.schema !== SCHEMAS.UNDO_TOKEN ||
      !UNDO_CONTROL_BASENAME_RE.test(value.controlBasename || '') ||
      !UNDO_RECEIPT_BASENAME_RE.test(value.receiptBasename || '') ||
      !UNDO_QUARANTINE_BASENAME_RE.test(value.quarantineBasename || '')) {
    fail('undo token identity is invalid');
  }
  return immutable({
    schema: SCHEMAS.UNDO_TOKEN,
    operationId: operationId(value.operationId),
    selectedId: selectedId(value.selectedId),
    controlBasename: value.controlBasename,
    receiptBasename: value.receiptBasename,
    quarantineBasename: value.quarantineBasename,
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    createdIdentityDigest: digest(value.createdIdentityDigest, 'createdIdentityDigest'),
    quarantineIdentityDigest: digest(
      value.quarantineIdentityDigest,
      'quarantineIdentityDigest'
    ),
    contentDigest: digest(value.contentDigest, 'contentDigest'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
    controlRecordIdentity: assertRecordIdentityStructure(
      value.controlRecordIdentity,
      'undo control record identity structure'
    ),
    receiptRecordIdentity: assertRecordIdentityStructure(
      value.receiptRecordIdentity,
      'undo receipt record identity structure'
    ),
  });
}

function assertBoundUndoToken(raw, rawAuthority, index) {
  if (rawAuthority === undefined) fail('undo token requires original authority');
  const authority = assertUndoAuthority(rawAuthority);
  const token = parseUndoTokenStructure(raw);
  const control = buildUndoControl(authority, index);
  const receipt = buildUndoReceipt(
    authority,
    index,
    token.quarantineBasename,
    token.quarantineIdentityDigest
  );
  const names = undoRecordNames(authority, index);
  const controlRecordIdentity = assertPrivateRecordIdentity(
    token.controlRecordIdentity,
    encodeUndoControlRecord(control, authority, index),
    'undo control record identity'
  );
  const receiptRecordIdentity = assertPrivateRecordIdentity(
    token.receiptRecordIdentity,
    encodeUndoReceiptRecord(receipt, authority, index),
    'undo receipt record identity'
  );
  if (token.operationId !== control.operationId || token.selectedId !== control.selectedId ||
      token.controlBasename !== names.controlBasename ||
      token.receiptBasename !== names.receiptBasename ||
      token.controlDigest !== control.controlDigest ||
      token.createdIdentityDigest !== control.createdIdentityDigest ||
      token.contentDigest !== control.contentDigest ||
      token.receiptDigest !== receipt.receiptDigest) {
    fail('undo token does not reproduce exact record authority');
  }
  return immutable({ ...token, controlRecordIdentity, receiptRecordIdentity });
}

function assertUndoResult(raw, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  if (!['QUARANTINE', 'RECONCILE_UNDO'].includes(expectedCommand)) {
    fail('expected native undo command is required');
  }
  const request = authority.request;
  const value = valuesOf(raw, KEYS.UNDO_RESULT, 'undo result');
  if (value.schema !== SCHEMAS.UNDO_RESULT || value.command !== expectedCommand ||
      !['COMMITTED', 'UNCOMMITTED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== request.operationId || value.artifactDigest !== request.artifactDigest ||
      value.precreatePhaseDigest !== request.precreatePhaseDigest ||
      value.selectionDigest !== request.selectionDigest ||
      value.preparedHistoryDigest !== request.preparedHistoryDigest) {
    fail('undo result authority is invalid');
  }
  const committed = value.state === 'COMMITTED';
  const tokens = arrayValues(
    value.tokens,
    committed ? request.items.length : 0,
    committed ? request.items.length : 0,
    'undo result tokens'
  ).map((token, index) => assertBoundUndoToken(token, authority, index));
  if ((value.state === 'UNKNOWN') !==
      (value.errorCode === 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN') ||
      (value.state !== 'UNKNOWN' && value.errorCode !== null) ||
      new Set(tokens.map(token => token.quarantineBasename)).size !== tokens.length ||
      new Set(tokens.map(token => token.quarantineIdentityDigest)).size !== tokens.length ||
      new Set(tokens.map(token => evidenceSchema.digestObjectIdentity(
        token.controlRecordIdentity
      ))).size !== tokens.length ||
      new Set(tokens.map(token => evidenceSchema.digestObjectIdentity(
        token.receiptRecordIdentity
      ))).size !== tokens.length ||
      new Set(tokens.flatMap(token => [
        `${token.controlRecordIdentity.dev}:${token.controlRecordIdentity.ino}`,
        `${token.receiptRecordIdentity.dev}:${token.receiptRecordIdentity.ino}`,
      ])).size !== tokens.length * 2) {
    fail('undo result state matrix is invalid');
  }
  return immutable({
    schema: SCHEMAS.UNDO_RESULT,
    command: expectedCommand,
    state: value.state,
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    preparedHistoryDigest: request.preparedHistoryDigest,
    tokens: immutable(tokens),
    errorCode: value.errorCode,
  });
}

function assertUndoSettleRequest(raw, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  if (!['RESTORE_QUARANTINE', 'FINALIZE_UNDO'].includes(expectedCommand)) {
    fail('expected undo settlement command is required');
  }
  const request = authority.request;
  const value = valuesOf(raw, KEYS.UNDO_SETTLE_REQUEST, 'undo settle request');
  const tokens = arrayValues(
    value.tokens,
    request.items.length,
    request.items.length,
    'undo settle tokens'
  ).map((token, index) => assertBoundUndoToken(token, authority, index));
  const settle = immutable({
    schema: value.schema,
    command: value.command,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    preparedHistoryDigest: digest(value.preparedHistoryDigest, 'preparedHistoryDigest'),
    historyCommittedPhaseDigest: nullableDigest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    tokens: immutable(tokens),
  });
  if (settle.schema !== SCHEMAS.UNDO_SETTLE_REQUEST || settle.command !== expectedCommand ||
      settle.operationId !== request.operationId || settle.artifactDigest !== request.artifactDigest ||
      settle.precreatePhaseDigest !== request.precreatePhaseDigest ||
      settle.selectionDigest !== request.selectionDigest ||
      settle.preparedHistoryDigest !== request.preparedHistoryDigest ||
      (expectedCommand === 'RESTORE_QUARANTINE'
        ? settle.historyCommittedPhaseDigest !== null
        : settle.historyCommittedPhaseDigest === null)) {
    fail('undo settlement does not bind exact phase authority');
  }
  return settle;
}

function buildUndoSettleRequest(rawAuthority, command, rawTokens, historyCommittedPhaseDigest = null) {
  const authority = assertUndoAuthority(rawAuthority);
  return assertUndoSettleRequest({
    schema: SCHEMAS.UNDO_SETTLE_REQUEST,
    command,
    operationId: authority.request.operationId,
    artifactDigest: authority.request.artifactDigest,
    precreatePhaseDigest: authority.request.precreatePhaseDigest,
    selectionDigest: authority.request.selectionDigest,
    preparedHistoryDigest: authority.request.preparedHistoryDigest,
    historyCommittedPhaseDigest,
    tokens: rawTokens,
  }, authority, command);
}

function undoReceiptSet(rawSettleRequest, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  return immutable({
    schema: SCHEMAS.UNDO_RECEIPT_SET,
    operationId: settle.operationId,
    artifactDigest: settle.artifactDigest,
    precreatePhaseDigest: settle.precreatePhaseDigest,
    selectionDigest: settle.selectionDigest,
    preparedHistoryDigest: settle.preparedHistoryDigest,
    items: immutable(settle.tokens.map(token => immutable({
      selectedId: token.selectedId,
      controlDigest: token.controlDigest,
      createdIdentityDigest: token.createdIdentityDigest,
      quarantineIdentityDigest: token.quarantineIdentityDigest,
      receiptDigest: token.receiptDigest,
      controlRecordIdentityDigest: evidenceSchema.digestObjectIdentity(
        token.controlRecordIdentity
      ),
      receiptRecordIdentityDigest: evidenceSchema.digestObjectIdentity(
        token.receiptRecordIdentity
      ),
    }))),
  });
}

function undoReceiptSetDigest(rawSettleRequest, rawAuthority, expectedCommand) {
  return evidenceSchema.digestObject(
    SCHEMAS.UNDO_RECEIPT_SET,
    undoReceiptSet(rawSettleRequest, rawAuthority, expectedCommand)
  );
}

function undoFinalRecordName(rawSettleRequest, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const key = {
    schema: SCHEMAS.UNDO_FINAL_KEY,
    command: settle.command,
    operationId: settle.operationId,
    artifactDigest: settle.artifactDigest,
    precreatePhaseDigest: settle.precreatePhaseDigest,
    selectionDigest: settle.selectionDigest,
    preparedHistoryDigest: settle.preparedHistoryDigest,
    historyCommittedPhaseDigest: settle.historyCommittedPhaseDigest,
    receiptSetDigest: undoReceiptSetDigest(settle, authority, expectedCommand),
  };
  return `.changes-history-native-undo-final.${evidenceSchema.digestObject(
    SCHEMAS.UNDO_FINAL_KEY,
    key
  ).slice('sha256:'.length)}`;
}

function buildUndoFinalRecord(rawSettleRequest, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const record = {
    schema: SCHEMAS.UNDO_FINAL_RECORD,
    command: settle.command,
    operationId: settle.operationId,
    artifactDigest: settle.artifactDigest,
    precreatePhaseDigest: settle.precreatePhaseDigest,
    selectionDigest: settle.selectionDigest,
    preparedHistoryDigest: settle.preparedHistoryDigest,
    historyCommittedPhaseDigest: settle.historyCommittedPhaseDigest,
    receiptSetDigest: undoReceiptSetDigest(settle, authority, expectedCommand),
    itemCount: settle.tokens.length,
    publicParentFsyncComplete: true,
    recoveryFsyncComplete: true,
    finalRecordDigest: null,
  };
  record.finalRecordDigest = evidenceSchema.digestObject(
    SCHEMAS.UNDO_FINAL_RECORD,
    record,
    'finalRecordDigest'
  );
  return assertUndoFinalRecord(record, settle, authority, expectedCommand);
}

function assertUndoFinalRecord(raw, rawSettleRequest, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const value = valuesOf(raw, KEYS.UNDO_FINAL_RECORD, 'undo final record');
  const record = immutable({
    schema: value.schema,
    command: value.command,
    operationId: operationId(value.operationId),
    artifactDigest: digest(value.artifactDigest, 'artifactDigest'),
    precreatePhaseDigest: digest(value.precreatePhaseDigest, 'precreatePhaseDigest'),
    selectionDigest: digest(value.selectionDigest, 'selectionDigest'),
    preparedHistoryDigest: digest(value.preparedHistoryDigest, 'preparedHistoryDigest'),
    historyCommittedPhaseDigest: nullableDigest(
      value.historyCommittedPhaseDigest,
      'historyCommittedPhaseDigest'
    ),
    receiptSetDigest: digest(value.receiptSetDigest, 'receiptSetDigest'),
    itemCount: safeInteger(value.itemCount, 'itemCount', 1, LIMITS.maxItems),
    publicParentFsyncComplete: value.publicParentFsyncComplete,
    recoveryFsyncComplete: value.recoveryFsyncComplete,
    finalRecordDigest: digest(value.finalRecordDigest, 'finalRecordDigest'),
  });
  if (record.schema !== SCHEMAS.UNDO_FINAL_RECORD || record.command !== settle.command ||
      record.operationId !== settle.operationId || record.artifactDigest !== settle.artifactDigest ||
      record.precreatePhaseDigest !== settle.precreatePhaseDigest ||
      record.selectionDigest !== settle.selectionDigest ||
      record.preparedHistoryDigest !== settle.preparedHistoryDigest ||
      record.historyCommittedPhaseDigest !== settle.historyCommittedPhaseDigest ||
      record.receiptSetDigest !== undoReceiptSetDigest(settle, authority, expectedCommand) ||
      record.itemCount !== settle.tokens.length ||
      record.publicParentFsyncComplete !== true || record.recoveryFsyncComplete !== true ||
      record.finalRecordDigest !== evidenceSchema.digestObject(
        SCHEMAS.UNDO_FINAL_RECORD,
        record,
        'finalRecordDigest'
      )) fail('undo final record does not bind exact terminal authority');
  return record;
}

function assertUndoSettleResult(raw, rawSettleRequest, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const value = valuesOf(raw, KEYS.UNDO_SETTLE_RESULT, 'undo settle result');
  if (value.schema !== SCHEMAS.UNDO_SETTLE_RESULT ||
      value.command !== expectedCommand || !['COMMITTED', 'UNCOMMITTED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== settle.operationId) fail('undo settle result authority is invalid');
  const committed = value.state === 'COMMITTED';
  const finalRecord = committed
    ? assertUndoFinalRecord(value.finalRecord, settle, authority, expectedCommand)
    : value.finalRecord;
  const finalRecordIdentity = committed
    ? assertPrivateRecordIdentity(
      value.finalRecordIdentity,
      encodeUndoFinalRecord(finalRecord, settle, authority, expectedCommand),
      'undo final record identity'
    )
    : value.finalRecordIdentity;
  const priorRecordInodes = new Set(settle.tokens.flatMap(token => [
    `${token.controlRecordIdentity.dev}:${token.controlRecordIdentity.ino}`,
    `${token.receiptRecordIdentity.dev}:${token.receiptRecordIdentity.ino}`,
  ]));
  if ((!committed && (finalRecord !== null || finalRecordIdentity !== null)) ||
      (committed && priorRecordInodes.has(
        `${finalRecordIdentity.dev}:${finalRecordIdentity.ino}`
      )) ||
      (value.state === 'UNKNOWN') !==
        (value.errorCode === 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN') ||
      (value.state !== 'UNKNOWN' && value.errorCode !== null)) {
    fail('undo settle result state matrix is invalid');
  }
  return immutable({
    schema: value.schema,
    command: expectedCommand,
    state: value.state,
    operationId: settle.operationId,
    finalRecord: committed ? finalRecord : null,
    finalRecordIdentity: committed ? finalRecordIdentity : null,
    errorCode: value.errorCode,
  });
}

function buildUndoAckRequest(
  rawSettleRequest,
  rawFinalRecord,
  rawFinalRecordIdentity,
  rawAuthority,
  expectedCommand
) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const finalRecord = assertUndoFinalRecord(
    rawFinalRecord,
    settle,
    authority,
    expectedCommand
  );
  const finalRecordIdentity = assertPrivateRecordIdentity(
    rawFinalRecordIdentity,
    encodeUndoFinalRecord(finalRecord, settle, authority, expectedCommand),
    'undo final record identity'
  );
  return assertUndoAckRequest({
    schema: SCHEMAS.UNDO_ACK_REQUEST,
    command: settle.command,
    operationId: settle.operationId,
    finalBasename: undoFinalRecordName(settle, authority, expectedCommand),
    finalRecordDigest: finalRecord.finalRecordDigest,
    finalRecordIdentity,
  }, settle, finalRecord, finalRecordIdentity, authority, expectedCommand);
}

function assertUndoAckRequest(
  raw,
  rawSettleRequest,
  rawFinalRecord,
  rawFinalRecordIdentity,
  rawAuthority,
  expectedCommand
) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(rawSettleRequest, authority, expectedCommand);
  const finalRecord = assertUndoFinalRecord(
    rawFinalRecord,
    settle,
    authority,
    expectedCommand
  );
  const expectedFinalRecordIdentity = assertPrivateRecordIdentity(
    rawFinalRecordIdentity,
    encodeUndoFinalRecord(finalRecord, settle, authority, expectedCommand),
    'expected undo final record identity'
  );
  const value = valuesOf(raw, KEYS.UNDO_ACK_REQUEST, 'undo ACK request');
  const finalRecordIdentity = assertPrivateRecordIdentity(
    value.finalRecordIdentity,
    encodeUndoFinalRecord(finalRecord, settle, authority, expectedCommand),
    'undo ACK final record identity'
  );
  const ack = immutable({
    schema: value.schema,
    command: value.command,
    operationId: operationId(value.operationId),
    finalBasename: value.finalBasename,
    finalRecordDigest: digest(value.finalRecordDigest, 'finalRecordDigest'),
    finalRecordIdentity,
  });
  if (ack.schema !== SCHEMAS.UNDO_ACK_REQUEST || ack.command !== settle.command ||
      ack.operationId !== settle.operationId ||
      !UNDO_FINAL_BASENAME_RE.test(ack.finalBasename || '') ||
      ack.finalBasename !== undoFinalRecordName(settle, authority, expectedCommand) ||
      ack.finalRecordDigest !== finalRecord.finalRecordDigest ||
      evidenceSchema.digestObjectIdentity(ack.finalRecordIdentity) !==
        evidenceSchema.digestObjectIdentity(expectedFinalRecordIdentity) ||
      settle.tokens.some(token => [
        token.controlRecordIdentity,
        token.receiptRecordIdentity,
      ].some(identity => identity.dev === ack.finalRecordIdentity.dev &&
        identity.ino === ack.finalRecordIdentity.ino))) {
    fail('undo ACK request does not bind exact final authority');
  }
  return ack;
}

function assertUndoAckResult(
  raw,
  rawAckRequest,
  rawSettleRequest,
  rawFinalRecord,
  rawFinalRecordIdentity,
  rawAuthority,
  expectedCommand
) {
  const authority = assertUndoAuthority(rawAuthority);
  const ackRequest = assertUndoAckRequest(
    rawAckRequest,
    rawSettleRequest,
    rawFinalRecord,
    rawFinalRecordIdentity,
    authority,
    expectedCommand
  );
  const value = valuesOf(raw, KEYS.UNDO_ACK_RESULT, 'undo ACK result');
  if (value.schema !== SCHEMAS.UNDO_ACK_RESULT || value.command !== ackRequest.command ||
      !['ACKED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== ackRequest.operationId ||
      value.finalRecordDigest !== ackRequest.finalRecordDigest ||
      (value.state === 'UNKNOWN'
        ? value.errorCode !== 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN'
        : value.errorCode !== null)) fail('undo ACK result authority is invalid');
  return immutable({
    schema: SCHEMAS.UNDO_ACK_RESULT,
    command: ackRequest.command,
    state: value.state,
    operationId: ackRequest.operationId,
    finalRecordDigest: ackRequest.finalRecordDigest,
    errorCode: value.errorCode,
  });
}

function hexUtf8(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

function boundedWire(lines, limit, label) {
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > LIMITS.maxLineBytes) fail(`${label} line budget exceeded`);
  }
  const wire = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(wire, 'utf8') > limit) fail(`${label} wire budget exceeded`);
  return wire;
}

function assertResponseEnvelopeWithin(stdout, stderr, maxBytes) {
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'utf8');
  const errors = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '', 'utf8');
  if (errors.length !== 0 || output.length === 0 || output.length > maxBytes ||
      output.includes(0) || output[output.length - 1] !== 0x0a) {
    fail('native response envelope is invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch (_) { fail('native response UTF-8 is invalid'); }
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > LIMITS.maxItems + 2 ||
      lines.some(line => !line || Buffer.byteLength(line, 'utf8') > LIMITS.maxLineBytes)) {
    fail('native response line budget is invalid');
  }
  return text;
}

function assertResponseEnvelope(stdout, stderr = Buffer.alloc(0)) {
  return assertResponseEnvelopeWithin(stdout, stderr, LIMITS.maxResponseBytes);
}

function assertRollbackCreateResponseEnvelope(stdout, stderr = Buffer.alloc(0)) {
  return assertResponseEnvelopeWithin(
    stdout,
    stderr,
    LIMITS.maxRollbackCreateResponseBytes
  );
}

function encodeCreateMissingJournalResponse(
  rawResponse,
  rawAuthority,
  rawRequest,
  rawValue
) {
  const response = assertCreateMissingJournalResponse(
    rawResponse,
    rawAuthority,
    rawRequest,
    rawValue
  );
  const payload = Buffer.from(`${evidenceSchema.canonicalJson(response)}\n`, 'utf8');
  const header = Buffer.from(
    `${CREATE_JOURNAL_RESPONSE_MAGIC}\t${payload.length}\t${evidenceSchema.sha256(payload)}\n`,
    'utf8'
  );
  const envelope = Buffer.concat([header, payload]);
  if (envelope.length > LIMITS.maxCreateJournalResponseBytes) {
    fail('CREATE_MISSING journal response exceeds its dedicated budget');
  }
  return envelope;
}

function parseCreateMissingJournalResponse(
  stdout,
  stderr,
  rawAuthority,
  rawRequest,
  rawValue
) {
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '', 'utf8');
  const errors = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '', 'utf8');
  if (errors.length !== 0 || output.length === 0 ||
      output.length > LIMITS.maxCreateJournalResponseBytes || output.includes(0)) {
    fail('CREATE_MISSING journal response envelope is invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch (_) { fail('CREATE_MISSING journal response UTF-8 is invalid'); }
  const newline = text.indexOf('\n');
  if (newline < 0) fail('CREATE_MISSING journal response header is incomplete');
  const fields = text.slice(0, newline).split('\t');
  if (fields.length !== 3 || fields[0] !== CREATE_JOURNAL_RESPONSE_MAGIC ||
      !/^(?:0|[1-9][0-9]*)$/u.test(fields[1]) ||
      !/^sha256:[a-f0-9]{64}$/u.test(fields[2])) {
    fail('CREATE_MISSING journal response header is invalid');
  }
  const headerBytes = Buffer.byteLength(text.slice(0, newline + 1), 'utf8');
  const payload = output.subarray(headerBytes);
  if (payload.length !== Number(fields[1]) || payload.length < 2 ||
      payload[payload.length - 1] !== 0x0a || evidenceSchema.sha256(payload) !== fields[2]) {
    fail('CREATE_MISSING journal response payload authority is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(payload.subarray(0, -1).toString('utf8')); }
  catch (_) { fail('CREATE_MISSING journal response JSON is invalid'); }
  const response = assertCreateMissingJournalResponse(
    parsed,
    rawAuthority,
    rawRequest,
    rawValue
  );
  const canonicalPayload = Buffer.from(`${evidenceSchema.canonicalJson(response)}\n`, 'utf8');
  if (!canonicalPayload.equals(payload)) {
    fail('CREATE_MISSING journal response is noncanonical or has trailing bytes');
  }
  return response;
}

function encodeRootBind(raw) {
  const bind = assertRootBind(raw);
  return boundedWire([[
    'P',
    hexUtf8(bind.canonicalRoot),
    bind.expectedRootIdentityDigest,
    bind.expectedRecoveryIdentityDigest,
  ].join('\t')], LIMITS.maxRequestBytes, 'root bind');
}

function encodeCreateCommand(command, raw) {
  if (!['CREATE', 'RECONCILE'].includes(command)) fail('native create command is invalid');
  const request = assertCreateRequest(raw);
  const letter = command === 'CREATE' ? 'C' : 'R';
  const lines = [[
    letter,
    request.operationId,
    request.artifactDigest,
    request.artifactIdentityDigest,
    String(request.artifactByteLength),
    request.precreatePhaseDigest,
    request.selectionDigest,
    String(request.items.length),
  ].join('\t')];
  for (const item of request.items) {
    lines.push([
      'I', item.selectedId, hexUtf8(item.path), String(item.artifactOffset),
      String(item.byteLength), item.contentDigest, item.ancestorIdentityDigest,
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'create request');
}

function encodeFinalizeCommand(raw, rawCreateRequest) {
  const request = assertFinalizeRequest(raw, rawCreateRequest);
  const setDigest = receiptSetDigest(request, rawCreateRequest);
  const lines = [[
    'F', request.operationId, request.artifactDigest, request.selectionDigest,
    request.historyCommittedPhaseDigest, setDigest, String(request.tokens.length),
  ].join('\t')];
  for (const token of request.tokens) {
    lines.push([
      'T', token.selectedId, token.controlBasename, token.receiptBasename,
      token.controlDigest, token.createdIdentityDigest, token.contentDigest,
      token.receiptDigest,
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'finalize request');
}

function encodeControlRecord(raw) {
  const value = assertControl(raw);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, hexUtf8(value.path),
    value.artifactDigest, value.artifactIdentityDigest, value.precreatePhaseDigest,
    value.selectionDigest, String(value.artifactOffset), String(value.byteLength),
    value.contentDigest, value.ancestorIdentityDigest, value.controlDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'control record');
}

function encodeReceiptRecord(raw, rawControl = null) {
  const value = assertReceipt(raw, rawControl);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.controlDigest,
    value.createdIdentityDigest, value.contentDigest, String(value.byteLength),
    '1', '1', '1', value.receiptDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'receipt record');
}

function encodeFinalAckRecord(raw, rawFinalizeRequest, rawCreateRequest) {
  const value = assertFinalAck(raw, rawFinalizeRequest, rawCreateRequest);
  return boundedWire([[
    value.schema, value.operationId, value.artifactDigest, value.selectionDigest,
    value.historyCommittedPhaseDigest, value.receiptSetDigest, String(value.itemCount),
    '1', value.finalAckDigest,
  ].join('\t')], LIMITS.maxFinalRecordBytes, 'final ack record');
}

function encodeUndoCommand(command, rawAuthority) {
  if (!['QUARANTINE', 'RECONCILE_UNDO'].includes(command)) {
    fail('native undo command is invalid');
  }
  const authority = assertUndoAuthority(rawAuthority);
  const request = authority.request;
  const lines = [[
    command === 'QUARANTINE' ? 'Q' : 'R', 'UNDO', request.operationId,
    request.artifactDigest, request.artifactIdentityDigest,
    String(request.artifactByteLength), request.rootIdentityDigest,
    request.recoveryIdentityDigest, request.precreatePhaseDigest,
    request.selectionDigest, request.preparedHistoryDigest, String(request.items.length),
  ].join('\t')];
  for (const item of request.items) {
    lines.push([
      'J', item.selectedId, hexUtf8(item.path), String(item.byteLength),
      item.contentDigest, item.ancestorIdentityDigest, item.createdIdentityDigest,
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'undo request');
}

function encodeUndoSettleCommand(raw, rawAuthority, expectedCommand) {
  const authority = assertUndoAuthority(rawAuthority);
  const request = assertUndoSettleRequest(raw, authority, expectedCommand);
  const original = authority.request;
  const lines = [[
    expectedCommand === 'RESTORE_QUARANTINE' ? 'B' : 'D', 'UNDO', request.operationId,
    original.artifactDigest, original.artifactIdentityDigest,
    String(original.artifactByteLength), original.rootIdentityDigest,
    original.recoveryIdentityDigest, request.precreatePhaseDigest, request.selectionDigest,
    request.preparedHistoryDigest, request.historyCommittedPhaseDigest || '-',
    undoReceiptSetDigest(request, authority, expectedCommand), String(request.tokens.length),
  ].join('\t')];
  for (let index = 0; index < request.tokens.length; index += 1) {
    const token = request.tokens[index];
    const item = original.items[index];
    lines.push([
      'U', token.selectedId, hexUtf8(item.path), String(item.byteLength),
      item.contentDigest, item.ancestorIdentityDigest, item.createdIdentityDigest,
      token.controlBasename, token.receiptBasename, token.quarantineBasename,
      token.controlDigest, token.quarantineIdentityDigest, token.receiptDigest,
      ...identityWireFields(token.controlRecordIdentity),
      ...identityWireFields(token.receiptRecordIdentity),
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'undo settlement request');
}

function encodeUndoAckCommand(
  rawAckRequest,
  rawSettleRequest,
  rawFinalRecord,
  rawFinalRecordIdentity,
  rawAuthority,
  expectedCommand
) {
  const authority = assertUndoAuthority(rawAuthority);
  const settle = assertUndoSettleRequest(
    rawSettleRequest,
    authority,
    expectedCommand
  );
  const ack = assertUndoAckRequest(
    rawAckRequest,
    rawSettleRequest,
    rawFinalRecord,
    rawFinalRecordIdentity,
    authority,
    expectedCommand
  );
  const original = authority.request;
  const lines = [[
    'A', 'UNDO', ack.command, ack.operationId, original.artifactDigest,
    original.artifactIdentityDigest, String(original.artifactByteLength),
    original.rootIdentityDigest, original.recoveryIdentityDigest,
    original.precreatePhaseDigest, original.selectionDigest,
    original.preparedHistoryDigest, settle.historyCommittedPhaseDigest || '-',
    undoReceiptSetDigest(settle, authority, expectedCommand), ack.finalBasename,
    ack.finalRecordDigest, ...identityWireFields(ack.finalRecordIdentity),
    String(settle.tokens.length),
  ].join('\t')];
  for (let index = 0; index < settle.tokens.length; index += 1) {
    const token = settle.tokens[index];
    const item = original.items[index];
    lines.push([
      'U', token.selectedId, hexUtf8(item.path), String(item.byteLength),
      item.contentDigest, item.ancestorIdentityDigest, item.createdIdentityDigest,
      token.controlBasename, token.receiptBasename, token.quarantineBasename,
      token.controlDigest, token.quarantineIdentityDigest, token.receiptDigest,
      ...identityWireFields(token.controlRecordIdentity),
      ...identityWireFields(token.receiptRecordIdentity),
    ].join('\t'));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'undo ACK request');
}

function encodeUndoControlRecord(raw, rawAuthority, index) {
  const value = assertUndoControl(raw, rawAuthority, index);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, hexUtf8(value.path),
    value.artifactDigest, value.artifactIdentityDigest, String(value.artifactByteLength),
    value.rootIdentityDigest, value.recoveryIdentityDigest, value.precreatePhaseDigest,
    value.selectionDigest, value.preparedHistoryDigest, String(value.byteLength),
    value.contentDigest, value.ancestorIdentityDigest, value.createdIdentityDigest,
    value.controlDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'undo control record');
}

function encodeUndoReceiptRecord(raw, rawAuthority, index) {
  const value = assertUndoReceipt(raw, rawAuthority, index);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.controlDigest,
    value.quarantineBasename, value.createdIdentityDigest,
    value.quarantineIdentityDigest, value.contentDigest, String(value.byteLength),
    '1', '1', value.receiptDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'undo receipt record');
}

function encodeUndoFinalRecord(raw, rawSettleRequest, rawAuthority, expectedCommand) {
  const value = assertUndoFinalRecord(
    raw,
    rawSettleRequest,
    rawAuthority,
    expectedCommand
  );
  return boundedWire([[
    value.schema, value.command, value.operationId, value.artifactDigest,
    value.precreatePhaseDigest, value.selectionDigest, value.preparedHistoryDigest,
    value.historyCommittedPhaseDigest || '-', value.receiptSetDigest,
    String(value.itemCount), '1', '1', value.finalRecordDigest,
  ].join('\t')], LIMITS.maxFinalRecordBytes, 'undo final record');
}

function rollbackCreatePhase(raw, parent) {
  try { return phaseSchema.assertPhaseRecord(raw, parent); }
  catch (_) { fail('rollback-create CREATED_RECEIPT phase is invalid'); }
}

function rollbackCreateParent(raw) {
  try { return phaseSchema.assertParentSelectionBinding(raw); }
  catch (_) { fail('rollback-create parent selection is invalid'); }
}

function rollbackCreateExistingAuthority(raw) {
  try { return existingRestoreSchema.assertAuthority(raw); }
  catch (_) { fail('rollback-create EXISTING authority is invalid'); }
}

function rollbackCreateExistingTerminal(raw, authority) {
  let terminal;
  try { terminal = existingRestoreSchema.assertTerminalReceipt(raw, authority); }
  catch (_) { fail('rollback-create EXISTING terminal receipt is invalid'); }
  if (terminal.state !== 'UNCOMMITTED') {
    fail('rollback-create requires formal EXISTING UNCOMMITTED authority');
  }
  return terminal;
}

function buildRollbackCreateHeldBinding(
  markerByteLength,
  rawMarkerIdentity,
  historyParentIdentityDigest,
  baseHistoryExists,
  baseHistoryContentDigest,
  rawBaseHistoryIdentity,
  rawExistingAuthority
) {
  const existingAuthority = rollbackCreateExistingAuthority(rawExistingAuthority);
  const markerIdentity = assertRecordIdentityStructure(
    rawMarkerIdentity,
    'rollback-create held marker identity'
  );
  const markerLength = safeInteger(
    markerByteLength,
    'rollback-create markerByteLength',
    1,
    LIMITS.maxMarkerBytes
  );
  // WRCCHRJ2 single-authority journal: the held marker IS the journal file.
  // Its whole-content sha must equal the journal file identity the EXISTING
  // sub-request binds, not the active-marker domain digest.
  const journalContentSha256 =
    existingAuthority.request.journalMarkerBinding.journalFileIdentity.contentSha256;
  if (markerIdentity.mode !== 0o600 || markerIdentity.nlink !== 1 ||
      markerIdentity.size !== String(markerLength) ||
      markerIdentity.contentSha256 !== journalContentSha256) {
    fail('rollback-create held marker identity is foreign');
  }
  const parentDigest = digest(
    historyParentIdentityDigest,
    'rollback-create historyParentIdentityDigest'
  );
  if (typeof baseHistoryExists !== 'boolean') {
    fail('rollback-create baseHistoryExists is invalid');
  }
  let historyContent = null;
  let historyIdentity = null;
  if (baseHistoryExists) {
    historyContent = digest(
      baseHistoryContentDigest,
      'rollback-create baseHistoryContentDigest'
    );
    historyIdentity = assertRecordIdentityStructure(
      rawBaseHistoryIdentity,
      'rollback-create held base History identity'
    );
    if (historyIdentity.mode !== 0o600 || historyIdentity.nlink !== 1 ||
        historyIdentity.size !== String(existingAuthority.request.baseHistoryByteLength) ||
        historyIdentity.contentSha256 !== historyContent) {
      fail('rollback-create held base History identity is foreign');
    }
  } else if (baseHistoryContentDigest !== null || rawBaseHistoryIdentity !== null ||
      existingAuthority.request.baseHistoryByteLength !== 0 ||
      existingAuthority.request.baseHistoryDigest !== evidenceSchema.sha256(Buffer.from([0]))) {
    fail('rollback-create absent base History authority is foreign');
  }
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_HELD_BINDING,
    markerByteLength: markerLength,
    markerIdentity,
    historyParentIdentityDigest: parentDigest,
    baseHistoryExists,
    baseHistoryContentDigest: historyContent,
    baseHistoryIdentity: historyIdentity,
  });
}

function assertRollbackCreateHeldBinding(raw, rawExistingAuthority) {
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_HELD_BINDING,
    'rollback-create held binding'
  );
  if (value.schema !== SCHEMAS.ROLLBACK_CREATE_HELD_BINDING) {
    fail('rollback-create held binding schema is invalid');
  }
  const expected = buildRollbackCreateHeldBinding(
    value.markerByteLength,
    value.markerIdentity,
    value.historyParentIdentityDigest,
    value.baseHistoryExists,
    value.baseHistoryContentDigest,
    value.baseHistoryIdentity,
    rawExistingAuthority
  );
  return expected;
}

function assertRollbackCreatePublication(raw, rawCreateRequest, index) {
  const request = assertCreateRequest(rawCreateRequest);
  safeInteger(index, 'rollback-create publication index', 0, request.items.length - 1);
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_PUBLICATION,
    `rollback-create publications[${index}]`
  );
  if (value.schema !== SCHEMAS.ROLLBACK_CREATE_PUBLICATION) {
    fail('rollback-create publication schema is invalid');
  }
  const token = assertBoundToken(value.token, request, index);
  const control = buildControl(request, index);
  const receipt = buildReceipt(control, token.createdIdentityDigest);
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_PUBLICATION,
    token,
    controlRecordIdentity: assertPrivateRecordIdentity(
      value.controlRecordIdentity,
      encodeControlRecord(control),
      'create control publication identity'
    ),
    receiptRecordIdentity: assertPrivateRecordIdentity(
      value.receiptRecordIdentity,
      encodeReceiptRecord(receipt, control),
      'create receipt publication identity'
    ),
  });
}

function rollbackCreateRequestContext(
  rawRootBind,
  rawParent,
  rawPrecreatePhase,
  rawCreatedReceiptPhase,
  rawCreateRequest,
  rawCreatePublications,
  rawExistingAuthority,
  rawExistingTerminal,
  rawHeldBinding
) {
  const rootBind = assertRootBind(rawRootBind);
  const parentSelection = rollbackCreateParent(rawParent);
  const precreatePhase = rollbackCreatePhase(rawPrecreatePhase, parentSelection);
  const createdReceiptPhase = rollbackCreatePhase(rawCreatedReceiptPhase, parentSelection);
  const createRequest = assertCreateRequest(rawCreateRequest);
  const existingAuthority = rollbackCreateExistingAuthority(rawExistingAuthority);
  const existingTerminalReceipt = rollbackCreateExistingTerminal(
    rawExistingTerminal,
    existingAuthority
  );
  const heldBinding = assertRollbackCreateHeldBinding(rawHeldBinding, existingAuthority);
  if (parentSelection.kind !== 'snapshot_restore' ||
      precreatePhase.phase !== 'PRECREATE' ||
      createdReceiptPhase.phase !== 'CREATED_RECEIPT') {
    fail('rollback-create is bound to snapshot_restore CREATED_RECEIPT');
  }
  const missing = parentSelection.selected.filter(item => item.action === 'MISSING');
  const existing = parentSelection.selected.filter(item => item.action === 'EXISTING');
  if (!missing.length || !existing.length || missing.length !== createRequest.items.length) {
    fail('rollback-create requires one complete mixed selection');
  }
  const publications = arrayValues(
    rawCreatePublications,
    missing.length,
    missing.length,
    'rollback-create publications'
  ).map((publication, index) => assertRollbackCreatePublication(
    publication,
    createRequest,
    index
  ));
  for (let index = 0; index < missing.length; index += 1) {
    const expected = missing[index];
    const item = createRequest.items[index];
    const phaseItem = createdReceiptPhase.items[index];
    const publication = publications[index];
    if (item.selectedId !== expected.selectedId || item.path !== expected.path ||
        item.contentDigest !== `sha256:${expected.revision}` ||
        item.ancestorIdentityDigest !== expected.ancestorIdentityDigest ||
        phaseItem.selectedId !== expected.selectedId ||
        phaseItem.createdIdentityDigest !== publication.token.createdIdentityDigest ||
        phaseItem.creationReceiptDigest !== publication.token.receiptDigest) {
      fail('rollback-create publication does not equal the parent-derived MISSING subset');
    }
  }
  const existingRequest = existingAuthority.request;
  if (createRequest.operationId !== precreatePhase.operationId ||
      createRequest.precreatePhaseDigest !== evidenceSchema.digestObject(
        phaseSchema.SCHEMA,
        precreatePhase
      ) ||
      precreatePhase.operationId !== createdReceiptPhase.operationId ||
      precreatePhase.artifactDigest !== createdReceiptPhase.artifactDigest ||
      precreatePhase.selectionDigest !== createdReceiptPhase.selectionDigest ||
      Date.parse(precreatePhase.updatedAt) > Date.parse(createdReceiptPhase.updatedAt) ||
      createRequest.artifactDigest !== createdReceiptPhase.artifactDigest ||
      createRequest.selectionDigest !== createdReceiptPhase.selectionDigest ||
      existingRequest.operationId !== createdReceiptPhase.operationId ||
      existingRequest.artifactDigest !== createdReceiptPhase.artifactDigest ||
      existingRequest.selectionDigest !== createdReceiptPhase.selectionDigest ||
      existingRequest.artifactIdentityDigest !== createRequest.artifactIdentityDigest ||
      existingRequest.artifactByteLength !== createRequest.artifactByteLength ||
      existingAuthority.parentSelection.selected.length !== parentSelection.selected.length ||
      phaseSchema.digestSelection(existingAuthority.parentSelection) !==
        phaseSchema.digestSelection(parentSelection)) {
    fail('rollback-create create/existing/phase authorities do not share one transaction');
  }
  return immutable({
    rootBind,
    parentSelection,
    precreatePhase,
    createdReceiptPhase,
    createRequest,
    createPublications: immutable(publications),
    existingAuthority,
    existingTerminalReceipt,
    heldBinding,
  });
}

function buildRollbackCreateRequest(
  rawRootBind,
  rawParent,
  rawPrecreatePhase,
  rawCreatedReceiptPhase,
  rawCreateRequest,
  rawCreatePublications,
  rawExistingAuthority,
  rawExistingTerminal,
  rawHeldBinding
) {
  const context = rollbackCreateRequestContext(
    rawRootBind,
    rawParent,
    rawPrecreatePhase,
    rawCreatedReceiptPhase,
    rawCreateRequest,
    rawCreatePublications,
    rawExistingAuthority,
    rawExistingTerminal,
    rawHeldBinding
  );
  const existingRequest = context.existingAuthority.request;
  // WRCCHRJ2 single-authority journal. Two distinct marker digests:
  // - markerDigest stays the EXISTING sub-request's active-marker domain digest
  //   (the native rebuilds the EXISTING records/terminal with it);
  // - journalMarkerDigest is the whole-content sha of the held journal file,
  //   which the native rollback_held_authority recomputes over HELD_MARKER_FD
  //   (the changes-history-transaction.json descriptor).
  const journalMarkerDigest =
    existingRequest.journalMarkerBinding.journalFileIdentity.contentSha256;
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_REQUEST,
    operationId: context.createdReceiptPhase.operationId,
    markerDigest: existingRequest.markerDigest,
    journalMarkerDigest,
    artifactDigest: context.createRequest.artifactDigest,
    artifactIdentityDigest: context.createRequest.artifactIdentityDigest,
    artifactByteLength: context.createRequest.artifactByteLength,
    rootIdentityDigest: context.rootBind.expectedRootIdentityDigest,
    recoveryIdentityDigest: context.rootBind.expectedRecoveryIdentityDigest,
    createPrecreatePhaseDigest: context.createRequest.precreatePhaseDigest,
    createdReceiptPhaseDigest: evidenceSchema.digestObject(
      phaseSchema.SCHEMA,
      context.createdReceiptPhase
    ),
    selectionDigest: context.createdReceiptPhase.selectionDigest,
    preparedHistoryDigest: context.createdReceiptPhase.preparedHistoryDigest,
    originalPrecreateUpdatedAt: context.precreatePhase.updatedAt,
    originalCreatedReceiptUpdatedAt: context.createdReceiptPhase.updatedAt,
    existingTerminalReceiptDigest:
      context.existingTerminalReceipt.terminalReceiptDigest,
    existingReceiptSetDigest: context.existingTerminalReceipt.receiptSetDigest,
    existingRequestDigest: existingRestoreSchema.requestDigest(context.existingAuthority),
    markerByteLength: context.heldBinding.markerByteLength,
    markerIdentityDigest: evidenceSchema.digestObjectIdentity(
      context.heldBinding.markerIdentity
    ),
    historyParentIdentityDigest: context.heldBinding.historyParentIdentityDigest,
    baseHistoryDigest: existingRequest.baseHistoryDigest,
    baseHistoryByteLength: existingRequest.baseHistoryByteLength,
    baseHistoryExists: context.heldBinding.baseHistoryExists,
    baseHistoryContentDigest: context.heldBinding.baseHistoryContentDigest,
    baseHistoryIdentityDigest: context.heldBinding.baseHistoryIdentity === null
      ? null
      : evidenceSchema.digestObjectIdentity(context.heldBinding.baseHistoryIdentity),
    items: immutable(context.createPublications.map((publication, index) => {
      const createItem = context.createRequest.items[index];
      return immutable({
        selectedId: createItem.selectedId,
        path: createItem.path,
        artifactOffset: createItem.artifactOffset,
        byteLength: createItem.byteLength,
        contentDigest: createItem.contentDigest,
        ancestorIdentityDigest: createItem.ancestorIdentityDigest,
        createdIdentityDigest: publication.token.createdIdentityDigest,
        createControlBasename: publication.token.controlBasename,
        createReceiptBasename: publication.token.receiptBasename,
        createControlDigest: publication.token.controlDigest,
        createReceiptDigest: publication.token.receiptDigest,
        createControlRecordIdentity: publication.controlRecordIdentity,
        createReceiptRecordIdentity: publication.receiptRecordIdentity,
      });
    })),
  });
}

function assertRollbackCreateRequest(
  raw,
  rawRootBind,
  rawParent,
  rawPrecreatePhase,
  rawCreatedReceiptPhase,
  rawCreateRequest,
  rawCreatePublications,
  rawExistingAuthority,
  rawExistingTerminal,
  rawHeldBinding
) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_REQUEST, 'rollback-create request');
  const expected = buildRollbackCreateRequest(
    rawRootBind,
    rawParent,
    rawPrecreatePhase,
    rawCreatedReceiptPhase,
    rawCreateRequest,
    rawCreatePublications,
    rawExistingAuthority,
    rawExistingTerminal,
    rawHeldBinding
  );
  const items = arrayValues(
    value.items,
    expected.items.length,
    expected.items.length,
    'rollback-create request.items'
  );
  const normalized = { ...value, items };
  for (const key of KEYS.ROLLBACK_CREATE_REQUEST) {
    if (key === 'items') continue;
    if (normalized[key] !== expected[key]) fail('rollback-create request authority is foreign');
  }
  items.forEach((rawItem, index) => {
    const item = valuesOf(rawItem, KEYS.ROLLBACK_CREATE_ITEM, `request.items[${index}]`);
    const expectedItem = expected.items[index];
    for (const key of KEYS.ROLLBACK_CREATE_ITEM) {
      if (['createControlRecordIdentity', 'createReceiptRecordIdentity'].includes(key)) {
        if (evidenceSchema.digestObjectIdentity(item[key]) !==
            evidenceSchema.digestObjectIdentity(expectedItem[key])) {
          fail('rollback-create request publication identity is foreign');
        }
      } else if (item[key] !== expectedItem[key]) {
        fail('rollback-create request item is foreign');
      }
    }
  });
  return expected;
}

function buildRollbackCreateAuthority(
  rawRootBind,
  rawParent,
  rawPrecreatePhase,
  rawCreatedReceiptPhase,
  rawCreateRequest,
  rawCreatePublications,
  rawExistingAuthority,
  rawExistingTerminal,
  rawHeldBinding,
  rawRequest
) {
  const context = rollbackCreateRequestContext(
    rawRootBind,
    rawParent,
    rawPrecreatePhase,
    rawCreatedReceiptPhase,
    rawCreateRequest,
    rawCreatePublications,
    rawExistingAuthority,
    rawExistingTerminal,
    rawHeldBinding
  );
  const request = assertRollbackCreateRequest(
    rawRequest,
    context.rootBind,
    context.parentSelection,
    context.precreatePhase,
    context.createdReceiptPhase,
    context.createRequest,
    context.createPublications,
    context.existingAuthority,
    context.existingTerminalReceipt,
    context.heldBinding
  );
  const authority = immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_AUTHORITY,
    rootBind: context.rootBind,
    parentSelection: context.parentSelection,
    precreatePhase: context.precreatePhase,
    createdReceiptPhase: context.createdReceiptPhase,
    createRequest: context.createRequest,
    createPublications: context.createPublications,
    existingAuthority: context.existingAuthority,
    existingTerminalReceipt: context.existingTerminalReceipt,
    heldBinding: context.heldBinding,
    request,
  });
  validatedRollbackCreateAuthorities.add(authority);
  return authority;
}

function assertRollbackCreateAuthority(raw) {
  if (raw && typeof raw === 'object' && validatedRollbackCreateAuthorities.has(raw)) return raw;
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_AUTHORITY,
    'rollback-create authority'
  );
  if (value.schema !== SCHEMAS.ROLLBACK_CREATE_AUTHORITY) {
    fail('rollback-create authority schema is invalid');
  }
  return buildRollbackCreateAuthority(
    value.rootBind,
    value.parentSelection,
    value.precreatePhase,
    value.createdReceiptPhase,
    value.createRequest,
    value.createPublications,
    value.existingAuthority,
    value.existingTerminalReceipt,
    value.heldBinding,
    value.request
  );
}

function rollbackCreateRequestDigest(rawAuthority) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const cached = rollbackCreateRequestDigests.get(authority);
  if (cached) return cached;
  const value = evidenceSchema.digestObject(SCHEMAS.ROLLBACK_CREATE_REQUEST, authority.request);
  rollbackCreateRequestDigests.set(authority, value);
  return value;
}

function rollbackCreateRecordNames(rawAuthority, index) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  safeInteger(index, 'rollback-create item index', 0, authority.request.items.length - 1);
  const item = authority.request.items[index];
  const suffix = evidenceSchema.digestObject(SCHEMAS.ROLLBACK_CREATE_RECORD_KEY, {
    schema: SCHEMAS.ROLLBACK_CREATE_RECORD_KEY,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    selectedId: item.selectedId,
  }).slice('sha256:'.length);
  return immutable({
    controlBasename: `.changes-history-native-rollback-create-control.${suffix}`,
    receiptBasename: `.changes-history-native-rollback-create-receipt.${suffix}`,
  });
}

function buildRollbackCreateControl(rawAuthority, index, quarantineBasename) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  safeInteger(index, 'rollback-create item index', 0, authority.request.items.length - 1);
  if (!ROLLBACK_CREATE_QUARANTINE_BASENAME_RE.test(quarantineBasename || '')) {
    fail('rollback-create quarantine basename is invalid');
  }
  const item = authority.request.items[index];
  const base = {
    schema: SCHEMAS.ROLLBACK_CREATE_CONTROL,
    operationId: authority.request.operationId,
    selectedId: item.selectedId,
    requestDigest: rollbackCreateRequestDigest(authority),
    path: item.path,
    contentDigest: item.contentDigest,
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    createdIdentityDigest: item.createdIdentityDigest,
    createControlDigest: item.createControlDigest,
    createReceiptDigest: item.createReceiptDigest,
    quarantineBasename,
  };
  return immutable({
    ...base,
    controlDigest: evidenceSchema.digestObject(SCHEMAS.ROLLBACK_CREATE_CONTROL, base),
  });
}

function assertRollbackCreateControl(raw, rawAuthority, index) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_CONTROL, 'rollback-create control');
  const expected = buildRollbackCreateControl(rawAuthority, index, value.quarantineBasename);
  for (const key of KEYS.ROLLBACK_CREATE_CONTROL) {
    if (value[key] !== expected[key]) fail('rollback-create control is foreign');
  }
  return expected;
}

function buildRollbackCreateReceipt(rawAuthority, index, rawControl, quarantineIdentityDigest) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const control = assertRollbackCreateControl(rawControl, authority, index);
  const item = authority.request.items[index];
  const base = {
    schema: SCHEMAS.ROLLBACK_CREATE_RECEIPT,
    operationId: authority.request.operationId,
    selectedId: item.selectedId,
    controlDigest: control.controlDigest,
    quarantineBasename: control.quarantineBasename,
    createdIdentityDigest: item.createdIdentityDigest,
    quarantineIdentityDigest: digest(quarantineIdentityDigest, 'quarantineIdentityDigest'),
    contentDigest: item.contentDigest,
    byteLength: item.byteLength,
    publicParentFsyncComplete: true,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...base,
    receiptDigest: evidenceSchema.digestObject(SCHEMAS.ROLLBACK_CREATE_RECEIPT, base),
  });
}

function assertRollbackCreateReceipt(raw, rawAuthority, index, rawControl) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_RECEIPT, 'rollback-create receipt');
  const expected = buildRollbackCreateReceipt(
    rawAuthority,
    index,
    rawControl,
    value.quarantineIdentityDigest
  );
  for (const key of KEYS.ROLLBACK_CREATE_RECEIPT) {
    if (value[key] !== expected[key]) fail('rollback-create receipt is foreign');
  }
  return expected;
}

function encodeRollbackCreateControlRecord(raw, rawAuthority, index) {
  const value = assertRollbackCreateControl(raw, rawAuthority, index);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.requestDigest,
    hexUtf8(value.path), value.contentDigest, value.ancestorIdentityDigest,
    value.createdIdentityDigest, value.createControlDigest,
    value.createReceiptDigest, value.quarantineBasename, value.controlDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'rollback-create control record');
}

function encodeRollbackCreateReceiptRecord(raw, rawAuthority, index, rawControl) {
  const value = assertRollbackCreateReceipt(raw, rawAuthority, index, rawControl);
  return boundedWire([[
    value.schema, value.operationId, value.selectedId, value.controlDigest,
    value.quarantineBasename, value.createdIdentityDigest,
    value.quarantineIdentityDigest, value.contentDigest, String(value.byteLength),
    '1', '1', value.receiptDigest,
  ].join('\t')], LIMITS.maxRecordBytes, 'rollback-create receipt record');
}

function buildRollbackCreateToken(
  rawAuthority,
  index,
  rawControl,
  rawReceipt,
  rawControlRecordIdentity,
  rawReceiptRecordIdentity
) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const control = assertRollbackCreateControl(rawControl, authority, index);
  const receipt = assertRollbackCreateReceipt(rawReceipt, authority, index, control);
  const names = rollbackCreateRecordNames(authority, index);
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_TOKEN,
    operationId: authority.request.operationId,
    selectedId: receipt.selectedId,
    controlBasename: names.controlBasename,
    receiptBasename: names.receiptBasename,
    quarantineBasename: receipt.quarantineBasename,
    controlDigest: control.controlDigest,
    createdIdentityDigest: receipt.createdIdentityDigest,
    quarantineIdentityDigest: receipt.quarantineIdentityDigest,
    contentDigest: receipt.contentDigest,
    receiptDigest: receipt.receiptDigest,
    controlRecordIdentity: assertPrivateRecordIdentity(
      rawControlRecordIdentity,
      encodeRollbackCreateControlRecord(control, authority, index),
      'rollback-create control identity'
    ),
    receiptRecordIdentity: assertPrivateRecordIdentity(
      rawReceiptRecordIdentity,
      encodeRollbackCreateReceiptRecord(receipt, authority, index, control),
      'rollback-create receipt identity'
    ),
  });
}

function assertRollbackCreateToken(raw, rawAuthority, index) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_TOKEN, 'rollback-create token');
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const control = buildRollbackCreateControl(authority, index, value.quarantineBasename);
  const receipt = buildRollbackCreateReceipt(
    authority,
    index,
    control,
    value.quarantineIdentityDigest
  );
  const expected = buildRollbackCreateToken(
    authority,
    index,
    control,
    receipt,
    value.controlRecordIdentity,
    value.receiptRecordIdentity
  );
  for (const key of KEYS.ROLLBACK_CREATE_TOKEN) {
    if (['controlRecordIdentity', 'receiptRecordIdentity'].includes(key)) continue;
    if (value[key] !== expected[key]) fail('rollback-create token is foreign');
  }
  return expected;
}

function buildRollbackCreateResult(rawAuthority, command, state, rawTokens = []) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  if (![ROLLBACK_CREATE_COMMANDS.QUARANTINE,
    ROLLBACK_CREATE_COMMANDS.RECONCILE].includes(command) ||
      !['COMMITTED', 'UNCOMMITTED', 'UNKNOWN'].includes(state)) {
    fail('rollback-create result command/state invalid');
  }
  const tokens = arrayValues(
    rawTokens,
    state === 'COMMITTED' ? authority.request.items.length : 0,
    state === 'COMMITTED' ? authority.request.items.length : 0,
    'rollback-create result.tokens'
  ).map((token, index) => assertRollbackCreateToken(token, authority, index));
  if (new Set(tokens.map(token => token.quarantineIdentityDigest)).size !== tokens.length) {
    fail('rollback-create quarantine identities must be unique');
  }
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_RESULT,
    command,
    state,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    tokens: immutable(tokens),
    errorCode: state === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
  });
}

function assertRollbackCreateResult(raw, rawAuthority, expectedCommand) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_RESULT, 'rollback-create result');
  const expected = buildRollbackCreateResult(
    rawAuthority,
    expectedCommand,
    value.state,
    value.tokens
  );
  for (const key of KEYS.ROLLBACK_CREATE_RESULT) {
    if (key === 'tokens') continue;
    if (value[key] !== expected[key]) fail('rollback-create result is foreign');
  }
  return expected;
}

function buildRollbackCreateSettleRequest(rawAuthority, rawTokens) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const tokens = arrayValues(
    rawTokens,
    authority.request.items.length,
    authority.request.items.length,
    'rollback-create settle tokens'
  ).map((token, index) => assertRollbackCreateToken(token, authority, index));
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_SETTLE_REQUEST,
    command: ROLLBACK_CREATE_COMMANDS.DELETE,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    existingTerminalReceiptDigest: authority.request.existingTerminalReceiptDigest,
    baseHistoryDigest: authority.request.baseHistoryDigest,
    createdReceiptPhaseDigest: authority.request.createdReceiptPhaseDigest,
    tokens: immutable(tokens),
  });
}

function assertRollbackCreateSettleRequest(raw, rawAuthority) {
  const value = valuesOf(
    raw,
    KEYS.ROLLBACK_CREATE_SETTLE_REQUEST,
    'rollback-create settle request'
  );
  const expected = buildRollbackCreateSettleRequest(rawAuthority, value.tokens);
  for (const key of KEYS.ROLLBACK_CREATE_SETTLE_REQUEST) {
    if (key === 'tokens') continue;
    if (value[key] !== expected[key]) fail('rollback-create settle request is foreign');
  }
  return expected;
}

function rollbackCreateReceiptSet(rawSettleRequest, rawAuthority) {
  const request = assertRollbackCreateSettleRequest(rawSettleRequest, rawAuthority);
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_RECEIPT_SET,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    items: immutable(request.tokens.map(token => immutable({
      selectedId: token.selectedId,
      controlDigest: token.controlDigest,
      createdIdentityDigest: token.createdIdentityDigest,
      quarantineIdentityDigest: token.quarantineIdentityDigest,
      receiptDigest: token.receiptDigest,
      controlRecordIdentityDigest: evidenceSchema.digestObjectIdentity(
        token.controlRecordIdentity
      ),
      receiptRecordIdentityDigest: evidenceSchema.digestObjectIdentity(
        token.receiptRecordIdentity
      ),
    }))),
  });
}

function rollbackCreateReceiptSetDigest(rawSettleRequest, rawAuthority) {
  return evidenceSchema.digestObject(
    SCHEMAS.ROLLBACK_CREATE_RECEIPT_SET,
    rollbackCreateReceiptSet(rawSettleRequest, rawAuthority)
  );
}

function buildRollbackCreateFinalRecord(rawSettleRequest, rawAuthority) {
  const request = assertRollbackCreateSettleRequest(rawSettleRequest, rawAuthority);
  const base = {
    schema: SCHEMAS.ROLLBACK_CREATE_FINAL_RECORD,
    command: ROLLBACK_CREATE_COMMANDS.DELETE,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    existingTerminalReceiptDigest: request.existingTerminalReceiptDigest,
    baseHistoryDigest: request.baseHistoryDigest,
    createdReceiptPhaseDigest: request.createdReceiptPhaseDigest,
    receiptSetDigest: rollbackCreateReceiptSetDigest(request, rawAuthority),
    itemCount: request.tokens.length,
    publicParentFsyncComplete: true,
    recoveryFsyncComplete: true,
  };
  return immutable({
    ...base,
    finalRecordDigest: evidenceSchema.digestObject(
      SCHEMAS.ROLLBACK_CREATE_FINAL_RECORD,
      base
    ),
  });
}

function assertRollbackCreateFinalRecord(raw, rawSettleRequest, rawAuthority) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_FINAL_RECORD, 'rollback-create final record');
  const expected = buildRollbackCreateFinalRecord(rawSettleRequest, rawAuthority);
  for (const key of KEYS.ROLLBACK_CREATE_FINAL_RECORD) {
    if (value[key] !== expected[key]) fail('rollback-create final record is foreign');
  }
  return expected;
}

function rollbackCreateFinalRecordName(rawSettleRequest, rawAuthority) {
  const record = buildRollbackCreateFinalRecord(rawSettleRequest, rawAuthority);
  return `.changes-history-native-rollback-create-final.${evidenceSchema.digestObject(
    SCHEMAS.ROLLBACK_CREATE_FINAL_KEY,
    {
      schema: SCHEMAS.ROLLBACK_CREATE_FINAL_KEY,
      operationId: record.operationId,
      requestDigest: record.requestDigest,
      finalRecordDigest: record.finalRecordDigest,
    }
  ).slice('sha256:'.length)}`;
}

function encodeRollbackCreateFinalRecord(raw, rawSettleRequest, rawAuthority) {
  const value = assertRollbackCreateFinalRecord(raw, rawSettleRequest, rawAuthority);
  return boundedWire([[
    value.schema, value.command, value.operationId, value.requestDigest,
    value.existingTerminalReceiptDigest, value.baseHistoryDigest,
    value.createdReceiptPhaseDigest, value.receiptSetDigest, String(value.itemCount),
    '1', '1', value.finalRecordDigest,
  ].join('\t')], LIMITS.maxFinalRecordBytes, 'rollback-create final record');
}

function buildRollbackCreateSettleResult(
  rawAuthority,
  rawSettleRequest,
  state,
  rawFinalRecord = null,
  rawFinalRecordIdentity = null
) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const request = assertRollbackCreateSettleRequest(rawSettleRequest, authority);
  if (!['FINALIZED', 'UNKNOWN'].includes(state)) fail('rollback-create settle state invalid');
  const finalRecord = state === 'FINALIZED'
    ? assertRollbackCreateFinalRecord(rawFinalRecord, request, authority)
    : (rawFinalRecord === null ? null : fail('UNKNOWN cannot carry final record'));
  const finalRecordIdentity = state === 'FINALIZED'
    ? assertPrivateRecordIdentity(
      rawFinalRecordIdentity,
      encodeRollbackCreateFinalRecord(finalRecord, request, authority),
      'rollback-create final record identity'
    )
    : (rawFinalRecordIdentity === null ? null : fail('UNKNOWN cannot carry final identity'));
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_SETTLE_RESULT,
    command: ROLLBACK_CREATE_COMMANDS.DELETE,
    state,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    finalRecord,
    finalRecordIdentity,
    errorCode: state === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
  });
}

function assertRollbackCreateSettleResult(raw, rawAuthority, rawSettleRequest) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_SETTLE_RESULT, 'rollback-create settle result');
  const expected = buildRollbackCreateSettleResult(
    rawAuthority,
    rawSettleRequest,
    value.state,
    value.finalRecord,
    value.finalRecordIdentity
  );
  for (const key of KEYS.ROLLBACK_CREATE_SETTLE_RESULT) {
    if (['finalRecord', 'finalRecordIdentity'].includes(key)) continue;
    if (value[key] !== expected[key]) fail('rollback-create settle result is foreign');
  }
  return expected;
}

function buildRollbackCreateAckRequest(
  rawAuthority,
  rawSettleRequest,
  rawFinalRecordIdentity,
  rawRolledBackPhase
) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const settle = assertRollbackCreateSettleRequest(rawSettleRequest, authority);
  const finalRecord = buildRollbackCreateFinalRecord(settle, authority);
  const rolledBackPhase = rollbackCreatePhase(
    rawRolledBackPhase,
    authority.parentSelection
  );
  const expectedRolledBackPhase = immutable({
    schema: phaseSchema.SCHEMA,
    operationId: authority.createdReceiptPhase.operationId,
    kind: authority.createdReceiptPhase.kind,
    phase: 'ROLLED_BACK',
    artifactDigest: authority.createdReceiptPhase.artifactDigest,
    selectionDigest: authority.createdReceiptPhase.selectionDigest,
    items: immutable(authority.createdReceiptPhase.items.map((item, index) => immutable({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.afterRevision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      createdIdentityDigest: item.createdIdentityDigest,
      creationReceiptDigest: item.creationReceiptDigest,
      quarantineReceiptDigest: settle.tokens[index].receiptDigest,
    }))),
    preparedHistoryDigest: authority.createdReceiptPhase.preparedHistoryDigest,
    finalReceiptDigest: null,
    existingReceiptSetDigest: authority.request.existingReceiptSetDigest,
    rollbackReceiptDigest: finalRecord.finalRecordDigest,
    updatedAt: rolledBackPhase.updatedAt,
  });
  if (Date.parse(rolledBackPhase.updatedAt) <
      Date.parse(authority.createdReceiptPhase.updatedAt) ||
      evidenceSchema.digestObject(phaseSchema.SCHEMA, rolledBackPhase) !==
      evidenceSchema.digestObject(phaseSchema.SCHEMA, expectedRolledBackPhase)) {
    fail('rollback-create ACK requires the exact consuming ROLLED_BACK phase');
  }
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_ACK_REQUEST,
    command: ROLLBACK_CREATE_COMMANDS.ACK,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    finalBasename: rollbackCreateFinalRecordName(settle, authority),
    finalRecordDigest: finalRecord.finalRecordDigest,
    finalRecordIdentity: assertPrivateRecordIdentity(
      rawFinalRecordIdentity,
      encodeRollbackCreateFinalRecord(finalRecord, settle, authority),
      'rollback-create final record identity'
    ),
    rolledBackPhaseDigest: evidenceSchema.digestObject(
      phaseSchema.SCHEMA,
      rolledBackPhase
    ),
  });
}

function assertRollbackCreateAckRequest(
  raw,
  rawAuthority,
  rawSettleRequest,
  rawRolledBackPhase
) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_ACK_REQUEST, 'rollback-create ACK request');
  const expected = buildRollbackCreateAckRequest(
    rawAuthority,
    rawSettleRequest,
    value.finalRecordIdentity,
    rawRolledBackPhase
  );
  for (const key of KEYS.ROLLBACK_CREATE_ACK_REQUEST) {
    if (key === 'finalRecordIdentity') continue;
    if (value[key] !== expected[key]) fail('rollback-create ACK request is foreign');
  }
  return expected;
}

function buildRollbackCreateAckResult(rawAuthority, rawSettleRequest, state) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  if (!['ACKED', 'UNKNOWN'].includes(state)) fail('rollback-create ACK state invalid');
  return immutable({
    schema: SCHEMAS.ROLLBACK_CREATE_ACK_RESULT,
    command: ROLLBACK_CREATE_COMMANDS.ACK,
    state,
    operationId: authority.request.operationId,
    requestDigest: rollbackCreateRequestDigest(authority),
    finalRecordDigest: buildRollbackCreateFinalRecord(
      rawSettleRequest,
      authority
    ).finalRecordDigest,
    errorCode: state === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
  });
}

function assertRollbackCreateAckResult(raw, rawAuthority, rawSettleRequest) {
  const value = valuesOf(raw, KEYS.ROLLBACK_CREATE_ACK_RESULT, 'rollback-create ACK result');
  const expected = buildRollbackCreateAckResult(rawAuthority, rawSettleRequest, value.state);
  for (const key of KEYS.ROLLBACK_CREATE_ACK_RESULT) {
    if (value[key] !== expected[key]) fail('rollback-create ACK result is foreign');
  }
  return expected;
}

function nullableIdentityWireFields(identity) {
  return identity === null ? Array(9).fill('-') : identityWireFields(identity);
}

function rollbackCreateAuthorityHeaderFields(rawAuthority) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const request = authority.request;
  return [
    request.operationId, rollbackCreateRequestDigest(authority),
    request.markerDigest, String(request.markerByteLength), request.markerIdentityDigest,
    request.artifactDigest, request.artifactIdentityDigest,
    String(request.artifactByteLength), request.rootIdentityDigest,
    request.recoveryIdentityDigest, request.createPrecreatePhaseDigest,
    request.createdReceiptPhaseDigest, request.selectionDigest,
    request.preparedHistoryDigest, hexUtf8(request.originalPrecreateUpdatedAt),
    hexUtf8(request.originalCreatedReceiptUpdatedAt),
    request.existingRequestDigest,
    request.existingTerminalReceiptDigest, request.existingReceiptSetDigest,
    request.baseHistoryDigest, String(request.baseHistoryByteLength),
    request.baseHistoryExists ? '1' : '0', request.baseHistoryContentDigest || '-',
    request.baseHistoryIdentityDigest || '-', request.historyParentIdentityDigest,
    String(authority.existingAuthority.request.items.length),
    String(request.items.length),
    request.journalMarkerDigest,
  ];
}

function rollbackCreateExistingItemWireLine(authority, index) {
  const requestItem = authority.existingAuthority.request.items[index];
  const parentIndex = authority.parentSelection.selected.findIndex(item =>
    item.selectedId === requestItem.selectedId);
  const terminalItem = authority.existingTerminalReceipt.items[index];
  const rollback = terminalItem.rollbackToken;
  return [
    'E', String(parentIndex), requestItem.selectedId, hexUtf8(requestItem.path),
    requestItem.beforeRevision, requestItem.afterRevision,
    String(requestItem.beforeArtifactOffset), String(requestItem.beforeByteLength),
    requestItem.beforeContentDigest, String(requestItem.afterArtifactOffset),
    String(requestItem.afterByteLength), requestItem.afterContentDigest,
    requestItem.ancestorIdentityDigest, requestItem.beforeLeafIdentityDigest,
    terminalItem.finalContentDigest, terminalItem.finalLeafIdentityDigest,
    rollback.controlBasename, rollback.receiptBasename, rollback.controlDigest,
    rollback.applyReceiptDigest || '-', rollback.afterLeafIdentityDigest || '-',
    rollback.rollbackReceiptDigest, rollback.restoredLeafIdentityDigest,
    ...identityWireFields(rollback.controlRecordIdentity),
    ...nullableIdentityWireFields(rollback.applyReceiptRecordIdentity),
    ...identityWireFields(rollback.rollbackReceiptRecordIdentity),
  ].join('\t');
}

function rollbackCreateMissingItemWireLine(authority, item) {
  const parentIndex = authority.parentSelection.selected.findIndex(value =>
    value.selectedId === item.selectedId);
  return [
    'I', String(parentIndex), item.selectedId, hexUtf8(item.path), String(item.artifactOffset),
    String(item.byteLength),
    item.contentDigest, item.ancestorIdentityDigest, item.createdIdentityDigest,
    item.createControlBasename, item.createReceiptBasename,
    item.createControlDigest, item.createReceiptDigest,
    ...identityWireFields(item.createControlRecordIdentity),
    ...identityWireFields(item.createReceiptRecordIdentity),
  ].join('\t');
}

function rollbackCreateAuthorityItemLines(rawAuthority) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  return [
    ...authority.existingAuthority.request.items.map((_item, index) =>
      rollbackCreateExistingItemWireLine(authority, index)),
    ...authority.request.items.map(item => rollbackCreateMissingItemWireLine(authority, item)),
  ];
}

function rollbackCreateTokenWireLine(token) {
  return [
    'T', token.selectedId, token.controlBasename, token.receiptBasename,
    token.quarantineBasename, token.controlDigest, token.createdIdentityDigest,
    token.quarantineIdentityDigest, token.contentDigest, token.receiptDigest,
    ...identityWireFields(token.controlRecordIdentity),
    ...identityWireFields(token.receiptRecordIdentity),
  ].join('\t');
}

function encodeRollbackCreateCommand(command, rawAuthority) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  if (![ROLLBACK_CREATE_COMMANDS.QUARANTINE,
    ROLLBACK_CREATE_COMMANDS.RECONCILE].includes(command)) {
    fail('rollback-create Q/R command invalid');
  }
  const letter = command === ROLLBACK_CREATE_COMMANDS.QUARANTINE ? 'Q' : 'R';
  const lines = [[
    letter, 'CREATE_ROLLBACK', ...rollbackCreateAuthorityHeaderFields(authority),
  ].join('\t'), ...rollbackCreateAuthorityItemLines(authority)];
  return boundedWire(lines, LIMITS.maxRequestBytes, 'rollback-create Q/R request');
}

function encodeRollbackCreateSettleCommand(rawAuthority, rawSettleRequest) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const request = assertRollbackCreateSettleRequest(rawSettleRequest, authority);
  const lines = [[
    'D', 'CREATE_ROLLBACK', ...rollbackCreateAuthorityHeaderFields(authority),
    String(request.tokens.length),
  ].join('\t'), ...rollbackCreateAuthorityItemLines(authority)];
  for (const token of request.tokens) {
    lines.push(rollbackCreateTokenWireLine(token));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'rollback-create D request');
}

function encodeRollbackCreateAckCommand(
  raw,
  rawAuthority,
  rawSettleRequest,
  rawRolledBackPhase
) {
  const authority = assertRollbackCreateAuthority(rawAuthority);
  const settle = assertRollbackCreateSettleRequest(rawSettleRequest, authority);
  const request = assertRollbackCreateAckRequest(
    raw,
    authority,
    settle,
    rawRolledBackPhase
  );
  const phase = rollbackCreatePhase(rawRolledBackPhase, authority.parentSelection);
  const lines = [[
    'A', 'CREATE_ROLLBACK', ...rollbackCreateAuthorityHeaderFields(authority),
    request.finalBasename, request.finalRecordDigest, request.rolledBackPhaseDigest,
    hexUtf8(phase.updatedAt), ...identityWireFields(request.finalRecordIdentity),
    String(settle.tokens.length),
  ].join('\t'), ...rollbackCreateAuthorityItemLines(authority)];
  for (const token of settle.tokens) {
    lines.push(rollbackCreateTokenWireLine(token));
  }
  return boundedWire(lines, LIMITS.maxRequestBytes, 'rollback-create A request');
}

module.exports = Object.freeze({
  ROLLBACK_CREATE_COMMANDS,
  CREATE_CLEANUP_COMMANDS,
  CREATE_JOURNAL_RESPONSE_MAGIC,
  SCHEMAS,
  LIMITS,
  CONTROL_BASENAME_RE,
  RECEIPT_BASENAME_RE,
  FINAL_BASENAME_RE,
  CREATE_CLEANUP_BASENAME_RE,
  UNDO_CONTROL_BASENAME_RE,
  UNDO_RECEIPT_BASENAME_RE,
  UNDO_QUARANTINE_BASENAME_RE,
  UNDO_FINAL_BASENAME_RE,
  PublicMarkdownNativeSchemaError,
  activeMarkerSlice,
  buildJournalMarkerBinding,
  assertJournalMarkerBinding,
  buildCreateJournalPhysicalBinding,
  assertCreateJournalPhysicalBinding,
  createRequestDigest,
  createAttemptDigest,
  buildPreparedCreatePublication,
  assertPreparedCreatePublication,
  buildLatchedCreatePublication,
  assertLatchedCreatePublication,
  assertCreatePublicationResult,
  buildCreateCapture,
  assertStoredCreateCapture,
  buildPreparedCreateFinalization,
  buildCapturedCreateFinalization,
  assertStoredCreateFinalization,
  buildCreateCleanupAuthority,
  assertCreateCleanupAuthority,
  assertCreateCleanupResult,
  encodeCreateCleanupCommand,
  parseCreateCleanupResult,
  buildCreateJournalAuthority,
  assertCreateJournalAuthority,
  buildCreateJournalCommandToken,
  assertCreateMissingJournalResponse,
  encodeCreateMissingJournalCommand,
  parseCreateMissingJournalCommand,
  verifyCreateMissingJournalPhysicalAuthority,
  assertRootBind,
  assertCreateRequest,
  recordNames,
  buildControl,
  assertControl,
  buildReceipt,
  assertReceipt,
  buildToken,
  assertToken,
  assertBoundToken,
  assertResult,
  assertFinalizeRequest,
  receiptSet,
  receiptSetDigest,
  finalRecordName,
  buildFinalAck,
  assertFinalAck,
  encodeRootBind,
  assertResponseEnvelope,
  assertRollbackCreateResponseEnvelope,
  encodeCreateMissingJournalResponse,
  parseCreateMissingJournalResponse,
  encodeCreateCommand,
  encodeFinalizeCommand,
  encodeControlRecord,
  encodeReceiptRecord,
  encodeFinalAckRecord,
  assertUndoRequest,
  buildUndoAuthority,
  assertUndoAuthority,
  undoRecordNames,
  buildUndoControl,
  assertUndoControl,
  buildUndoReceipt,
  assertUndoReceipt,
  buildUndoToken,
  parseUndoTokenStructure,
  assertBoundUndoToken,
  assertUndoResult,
  buildUndoSettleRequest,
  assertUndoSettleRequest,
  undoReceiptSet,
  undoReceiptSetDigest,
  undoFinalRecordName,
  buildUndoFinalRecord,
  assertUndoFinalRecord,
  assertUndoSettleResult,
  buildUndoAckRequest,
  assertUndoAckRequest,
  assertUndoAckResult,
  encodeUndoCommand,
  encodeUndoSettleCommand,
  encodeUndoAckCommand,
  encodeUndoControlRecord,
  encodeUndoReceiptRecord,
  encodeUndoFinalRecord,
  buildRollbackCreateHeldBinding,
  assertRollbackCreateHeldBinding,
  buildRollbackCreateRequest,
  assertRollbackCreateRequest,
  buildRollbackCreateAuthority,
  assertRollbackCreateAuthority,
  rollbackCreateRequestDigest,
  rollbackCreateRecordNames,
  buildRollbackCreateControl,
  assertRollbackCreateControl,
  buildRollbackCreateReceipt,
  assertRollbackCreateReceipt,
  buildRollbackCreateToken,
  assertRollbackCreateToken,
  buildRollbackCreateResult,
  assertRollbackCreateResult,
  buildRollbackCreateSettleRequest,
  assertRollbackCreateSettleRequest,
  rollbackCreateReceiptSetDigest,
  buildRollbackCreateFinalRecord,
  assertRollbackCreateFinalRecord,
  rollbackCreateFinalRecordName,
  buildRollbackCreateSettleResult,
  assertRollbackCreateSettleResult,
  buildRollbackCreateAckRequest,
  assertRollbackCreateAckRequest,
  buildRollbackCreateAckResult,
  assertRollbackCreateAckResult,
  encodeRollbackCreateCommand,
  encodeRollbackCreateSettleCommand,
  encodeRollbackCreateAckCommand,
  encodeRollbackCreateControlRecord,
  encodeRollbackCreateReceiptRecord,
  encodeRollbackCreateFinalRecord,
});
