'use strict';

// Pure private schema for exact recovery-marker removal. It owns no
// filesystem/process authority and exposes no preload/Renderer contract.

const evidenceSchema = require('./evidence-delivery-schema');

const SCHEMAS = Object.freeze({
  REQUEST: 'writcraft.changes-history-native-marker-clear-request/v1',
  CONTROL: 'writcraft.changes-history-native-marker-clear-control/v1',
  RECEIPT: 'writcraft.changes-history-native-marker-clear-receipt/v1',
  RECORD_IDENTITY: 'writcraft.changes-history-native-marker-clear-record-identity/v1',
  TOKEN: 'writcraft.changes-history-native-marker-clear-token/v1',
  RESULT: 'writcraft.changes-history-native-marker-clear-result/v1',
  ACK_REQUEST: 'writcraft.changes-history-native-marker-clear-ack-request/v1',
  ACK_RESULT: 'writcraft.changes-history-native-marker-clear-ack-result/v1',
  RECORD_KEY: 'writcraft.changes-history-native-marker-clear-record-key/v1',
});

const LIMITS = Object.freeze({
  maxMarkerBytes: 96 * 1024 * 1024,
  maxProjectIdBytes: 256,
});

const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/u;
const MARKER_BASENAME = 'changes-history-transaction.json';
const QUARANTINE_RE = /^\.changes-history-marker-clear\.[a-f0-9]{32}$/u;
const CONTROL_RE = /^\.changes-history-marker-clear-control\.[a-f0-9]{64}$/u;
const RECEIPT_RE = /^\.changes-history-marker-clear-receipt\.[a-f0-9]{64}$/u;

const KEYS = Object.freeze({
  REQUEST: Object.freeze([
    'schema', 'operationId', 'projectId', 'markerBasename', 'markerByteLength',
    'markerDigest', 'markerIdentityDigest', 'finalizedPhaseDigest',
    'artifactCleanupDigest', 'trustedRootIdentityDigest',
    'projectChainIdentityDigest', 'recoveryIdentityDigest',
  ]),
  CONTROL: Object.freeze([
    'schema', 'operationId', 'projectId', 'markerBasename', 'markerByteLength',
    'markerDigest', 'markerIdentityDigest', 'finalizedPhaseDigest',
    'artifactCleanupDigest', 'trustedRootIdentityDigest',
    'projectChainIdentityDigest', 'recoveryIdentityDigest', 'quarantineBasename',
    'requestDigest', 'controlDigest',
  ]),
  RECEIPT: Object.freeze([
    'schema', 'operationId', 'requestDigest', 'controlDigest', 'markerDigest',
    'markerIdentityDigest', 'quarantineBasename', 'markerRemoved',
    'recoveryFsyncComplete', 'receiptDigest',
  ]),
  TOKEN: Object.freeze([
    'schema', 'operationId', 'requestDigest', 'trustedRootIdentityDigest',
    'projectChainIdentityDigest', 'recoveryIdentityDigest', 'controlBasename',
    'receiptBasename', 'quarantineBasename', 'controlDigest', 'receiptDigest',
    'controlIdentity', 'receiptIdentity',
  ]),
  RECORD_IDENTITY_INPUT: Object.freeze([
    'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs',
    'recordSha256',
  ]),
  RECORD_IDENTITY: Object.freeze([
    'schema', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs',
    'ctimeNs', 'recordSha256', 'identityDigest',
  ]),
  RESULT: Object.freeze([
    'schema', 'command', 'state', 'operationId', 'requestDigest', 'token',
    'errorCode',
  ]),
  ACK_REQUEST: Object.freeze(['schema', 'operationId', 'requestDigest', 'token']),
  ACK_RESULT: Object.freeze(['schema', 'state', 'operationId', 'requestDigest', 'errorCode']),
});

class ChangesHistoryMarkerLifecycleSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangesHistoryMarkerLifecycleSchemaError';
    this.code = 'MARKER_CLEAR_PROTOCOL';
  }
}

function fail(message) {
  throw new ChangesHistoryMarkerLifecycleSchemaError(message);
}

function valuesOf(raw, keys, label) {
  try { evidenceSchema.assertExactKeys(raw, keys, label); }
  catch (_) { fail(`${label} must be a descriptor-exact plain record`); }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of keys) values[key] = descriptors[key].value;
  return values;
}

function digest(value, label) {
  try { return evidenceSchema.assertDigest(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function unsignedDecimal(value, label) {
  try { return evidenceSchema.assertUnsignedDecimal(value, label); }
  catch (_) { fail(`${label} is invalid`); }
}

function safeInteger(value, label, minimum, maximum) {
  try { return evidenceSchema.assertSafeInteger(value, label, minimum, maximum); }
  catch (_) { fail(`${label} is invalid`); }
}

function requestDigest(request) {
  return evidenceSchema.digestObject(SCHEMAS.REQUEST, request);
}

function assertRequest(raw) {
  const value = valuesOf(raw, KEYS.REQUEST, 'marker clear request');
  let projectId;
  try {
    projectId = evidenceSchema.assertString(value.projectId, 'projectId', {
      minBytes: 1,
      maxBytes: LIMITS.maxProjectIdBytes,
    });
  } catch (_) {
    fail('marker clear request project identity is invalid');
  }
  if (value.schema !== SCHEMAS.REQUEST || !OPERATION_ID_RE.test(value.operationId || '') ||
      value.markerBasename !== MARKER_BASENAME ||
      !Number.isSafeInteger(value.markerByteLength) || value.markerByteLength < 1 ||
      value.markerByteLength > LIMITS.maxMarkerBytes ||
      projectId !== projectId.normalize('NFC')) {
    fail('marker clear request identity is invalid');
  }
  return Object.freeze({
    schema: SCHEMAS.REQUEST,
    operationId: value.operationId,
    projectId,
    markerBasename: MARKER_BASENAME,
    markerByteLength: value.markerByteLength,
    markerDigest: digest(value.markerDigest, 'markerDigest'),
    markerIdentityDigest: digest(value.markerIdentityDigest, 'markerIdentityDigest'),
    finalizedPhaseDigest: digest(value.finalizedPhaseDigest, 'finalizedPhaseDigest'),
    artifactCleanupDigest: digest(value.artifactCleanupDigest, 'artifactCleanupDigest'),
    trustedRootIdentityDigest: digest(
      value.trustedRootIdentityDigest,
      'trustedRootIdentityDigest'
    ),
    projectChainIdentityDigest: digest(
      value.projectChainIdentityDigest,
      'projectChainIdentityDigest'
    ),
    recoveryIdentityDigest: digest(value.recoveryIdentityDigest, 'recoveryIdentityDigest'),
  });
}

function recordNames(rawRequest) {
  const request = assertRequest(rawRequest);
  const key = {
    schema: SCHEMAS.RECORD_KEY,
    operationId: request.operationId,
    projectId: request.projectId,
    requestDigest: requestDigest(request),
  };
  const suffix = evidenceSchema.digestObject(SCHEMAS.RECORD_KEY, key).slice(7);
  return Object.freeze({
    controlBasename: `.changes-history-marker-clear-control.${suffix}`,
    receiptBasename: `.changes-history-marker-clear-receipt.${suffix}`,
  });
}

function buildControl(rawRequest, quarantineBasename) {
  const request = assertRequest(rawRequest);
  if (!QUARANTINE_RE.test(quarantineBasename || '')) fail('marker quarantine name is invalid');
  const { schema: _requestSchema, ...requestFields } = request;
  const control = {
    schema: SCHEMAS.CONTROL,
    ...requestFields,
    quarantineBasename,
    requestDigest: requestDigest(request),
    controlDigest: null,
  };
  control.controlDigest = evidenceSchema.digestObject(SCHEMAS.CONTROL, control, 'controlDigest');
  return assertControl(control, request);
}

function assertControl(raw, rawRequest) {
  if (rawRequest === undefined || rawRequest === null) {
    fail('marker clear control requires original request authority');
  }
  const expectedRequest = assertRequest(rawRequest);
  const value = valuesOf(raw, KEYS.CONTROL, 'marker clear control');
  if (value.schema !== SCHEMAS.CONTROL || !QUARANTINE_RE.test(value.quarantineBasename || '')) {
    fail('marker clear control identity is invalid');
  }
  const request = assertRequest({
    schema: SCHEMAS.REQUEST,
    operationId: value.operationId,
    projectId: value.projectId,
    markerBasename: value.markerBasename,
    markerByteLength: value.markerByteLength,
    markerDigest: value.markerDigest,
    markerIdentityDigest: value.markerIdentityDigest,
    finalizedPhaseDigest: value.finalizedPhaseDigest,
    artifactCleanupDigest: value.artifactCleanupDigest,
    trustedRootIdentityDigest: value.trustedRootIdentityDigest,
    projectChainIdentityDigest: value.projectChainIdentityDigest,
    recoveryIdentityDigest: value.recoveryIdentityDigest,
  });
  const { schema: _requestSchema, ...requestFields } = request;
  const control = {
    schema: SCHEMAS.CONTROL,
    ...requestFields,
    quarantineBasename: value.quarantineBasename,
    requestDigest: digest(value.requestDigest, 'requestDigest'),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
  };
  if (control.requestDigest !== requestDigest(request) ||
      control.controlDigest !== evidenceSchema.digestObject(
        SCHEMAS.CONTROL,
        control,
        'controlDigest'
      )) fail('marker clear control digest cannot be reproduced');
  if (requestDigest(expectedRequest) !== control.requestDigest) {
    fail('marker clear control does not bind request');
  }
  return Object.freeze(control);
}

function buildReceipt(rawRequest, rawControl) {
  const request = assertRequest(rawRequest);
  const control = assertControl(rawControl, request);
  const receipt = {
    schema: SCHEMAS.RECEIPT,
    operationId: control.operationId,
    requestDigest: control.requestDigest,
    controlDigest: control.controlDigest,
    markerDigest: control.markerDigest,
    markerIdentityDigest: control.markerIdentityDigest,
    quarantineBasename: control.quarantineBasename,
    markerRemoved: true,
    recoveryFsyncComplete: true,
    receiptDigest: null,
  };
  receipt.receiptDigest = evidenceSchema.digestObject(SCHEMAS.RECEIPT, receipt, 'receiptDigest');
  return assertReceipt(receipt, request, control);
}

function assertReceipt(raw, rawRequest, rawControl) {
  if (rawRequest === undefined || rawRequest === null ||
      rawControl === undefined || rawControl === null) {
    fail('marker clear receipt requires original request and control authority');
  }
  const request = assertRequest(rawRequest);
  const control = assertControl(rawControl, request);
  const value = valuesOf(raw, KEYS.RECEIPT, 'marker clear receipt');
  if (value.schema !== SCHEMAS.RECEIPT || value.markerRemoved !== true ||
      value.recoveryFsyncComplete !== true ||
      !OPERATION_ID_RE.test(value.operationId || '') ||
      !QUARANTINE_RE.test(value.quarantineBasename || '')) {
    fail('marker clear receipt state is invalid');
  }
  const receipt = Object.freeze({
    schema: SCHEMAS.RECEIPT,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'requestDigest'),
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    markerDigest: digest(value.markerDigest, 'markerDigest'),
    markerIdentityDigest: digest(value.markerIdentityDigest, 'markerIdentityDigest'),
    quarantineBasename: value.quarantineBasename,
    markerRemoved: true,
    recoveryFsyncComplete: true,
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
  });
  if (receipt.receiptDigest !== evidenceSchema.digestObject(
    SCHEMAS.RECEIPT,
    receipt,
    'receiptDigest'
  )) fail('marker clear receipt digest cannot be reproduced');
  if (receipt.operationId !== control.operationId ||
      receipt.requestDigest !== control.requestDigest ||
      receipt.controlDigest !== control.controlDigest ||
      receipt.markerDigest !== control.markerDigest ||
      receipt.markerIdentityDigest !== control.markerIdentityDigest ||
      receipt.quarantineBasename !== control.quarantineBasename) {
    fail('marker clear receipt does not bind control');
  }
  return receipt;
}

function buildRecordIdentity(raw) {
  const value = valuesOf(raw, KEYS.RECORD_IDENTITY_INPUT, 'marker clear record identity input');
  const identity = {
    schema: SCHEMAS.RECORD_IDENTITY,
    dev: unsignedDecimal(value.dev, 'record identity.dev'),
    ino: unsignedDecimal(value.ino, 'record identity.ino'),
    uid: safeInteger(value.uid, 'record identity.uid', 0, Number.MAX_SAFE_INTEGER),
    mode: safeInteger(value.mode, 'record identity.mode', 0, 0xffff),
    nlink: safeInteger(value.nlink, 'record identity.nlink', 1, Number.MAX_SAFE_INTEGER),
    size: unsignedDecimal(value.size, 'record identity.size'),
    mtimeNs: unsignedDecimal(value.mtimeNs, 'record identity.mtimeNs'),
    ctimeNs: unsignedDecimal(value.ctimeNs, 'record identity.ctimeNs'),
    recordSha256: digest(value.recordSha256, 'record identity.recordSha256'),
    identityDigest: null,
  };
  if (identity.mode !== 0o600 || identity.nlink !== 1) {
    fail('marker clear record identity metadata is invalid');
  }
  identity.identityDigest = evidenceSchema.digestObject(
    SCHEMAS.RECORD_IDENTITY,
    identity,
    'identityDigest'
  );
  return assertRecordIdentity(identity);
}

function assertRecordIdentity(raw) {
  const value = valuesOf(raw, KEYS.RECORD_IDENTITY, 'marker clear record identity');
  if (value.schema !== SCHEMAS.RECORD_IDENTITY) {
    fail('marker clear record identity schema is invalid');
  }
  const identity = Object.freeze({
    schema: SCHEMAS.RECORD_IDENTITY,
    dev: unsignedDecimal(value.dev, 'record identity.dev'),
    ino: unsignedDecimal(value.ino, 'record identity.ino'),
    uid: safeInteger(value.uid, 'record identity.uid', 0, Number.MAX_SAFE_INTEGER),
    mode: safeInteger(value.mode, 'record identity.mode', 0, 0xffff),
    nlink: safeInteger(value.nlink, 'record identity.nlink', 1, Number.MAX_SAFE_INTEGER),
    size: unsignedDecimal(value.size, 'record identity.size'),
    mtimeNs: unsignedDecimal(value.mtimeNs, 'record identity.mtimeNs'),
    ctimeNs: unsignedDecimal(value.ctimeNs, 'record identity.ctimeNs'),
    recordSha256: digest(value.recordSha256, 'record identity.recordSha256'),
    identityDigest: digest(value.identityDigest, 'record identity.identityDigest'),
  });
  if (identity.mode !== 0o600 || identity.nlink !== 1 ||
      identity.identityDigest !== evidenceSchema.digestObject(
        SCHEMAS.RECORD_IDENTITY,
        identity,
        'identityDigest'
      )) {
    fail('marker clear record identity cannot be reproduced');
  }
  return identity;
}

function encodeControlRecord(rawRequest, rawControl) {
  const request = assertRequest(rawRequest);
  const control = assertControl(rawControl, request);
  return [
    control.schema, control.operationId, control.projectId, control.markerBasename,
    String(control.markerByteLength), control.markerDigest, control.markerIdentityDigest,
    control.finalizedPhaseDigest, control.artifactCleanupDigest,
    control.trustedRootIdentityDigest, control.projectChainIdentityDigest,
    control.recoveryIdentityDigest, control.quarantineBasename,
    control.requestDigest, control.controlDigest,
  ].join('\t') + '\n';
}

function encodeReceiptRecord(rawRequest, rawControl, rawReceipt) {
  const request = assertRequest(rawRequest);
  const control = assertControl(rawControl, request);
  const receipt = assertReceipt(rawReceipt, request, control);
  return [
    receipt.schema, receipt.operationId, receipt.requestDigest,
    receipt.controlDigest, receipt.markerDigest, receipt.markerIdentityDigest,
    receipt.quarantineBasename, '1', '1', receipt.receiptDigest,
  ].join('\t') + '\n';
}

function buildToken(
  rawRequest,
  rawControl,
  rawReceipt,
  rawControlIdentity,
  rawReceiptIdentity
) {
  const request = assertRequest(rawRequest);
  const control = assertControl(rawControl, request);
  const receipt = assertReceipt(rawReceipt, request, control);
  const controlIdentity = assertRecordIdentity(rawControlIdentity);
  const receiptIdentity = assertRecordIdentity(rawReceiptIdentity);
  const controlBytes = Buffer.from(encodeControlRecord(request, control), 'utf8');
  const receiptBytes = Buffer.from(encodeReceiptRecord(request, control, receipt), 'utf8');
  if (controlIdentity.size !== String(controlBytes.length) ||
      receiptIdentity.size !== String(receiptBytes.length) ||
      controlIdentity.recordSha256 !== evidenceSchema.sha256(controlBytes) ||
      receiptIdentity.recordSha256 !== evidenceSchema.sha256(receiptBytes)) {
    fail('marker clear record identity does not bind canonical record bytes');
  }
  const names = recordNames(request);
  return assertToken({
    schema: SCHEMAS.TOKEN,
    operationId: request.operationId,
    requestDigest: control.requestDigest,
    trustedRootIdentityDigest: request.trustedRootIdentityDigest,
    projectChainIdentityDigest: request.projectChainIdentityDigest,
    recoveryIdentityDigest: request.recoveryIdentityDigest,
    controlBasename: names.controlBasename,
    receiptBasename: names.receiptBasename,
    quarantineBasename: control.quarantineBasename,
    controlDigest: control.controlDigest,
    receiptDigest: receipt.receiptDigest,
    controlIdentity,
    receiptIdentity,
  }, request);
}

function assertToken(raw, rawRequest) {
  if (rawRequest === undefined || rawRequest === null) {
    fail('marker clear token requires original request authority');
  }
  const request = assertRequest(rawRequest);
  const value = valuesOf(raw, KEYS.TOKEN, 'marker clear token');
  if (value.schema !== SCHEMAS.TOKEN || !OPERATION_ID_RE.test(value.operationId || '') ||
      !CONTROL_RE.test(value.controlBasename || '') ||
      !RECEIPT_RE.test(value.receiptBasename || '') ||
      !QUARANTINE_RE.test(value.quarantineBasename || '')) {
    fail('marker clear token identity is invalid');
  }
  const token = Object.freeze({
    schema: SCHEMAS.TOKEN,
    operationId: value.operationId,
    requestDigest: digest(value.requestDigest, 'requestDigest'),
    trustedRootIdentityDigest: digest(
      value.trustedRootIdentityDigest,
      'trustedRootIdentityDigest'
    ),
    projectChainIdentityDigest: digest(
      value.projectChainIdentityDigest,
      'projectChainIdentityDigest'
    ),
    recoveryIdentityDigest: digest(value.recoveryIdentityDigest, 'recoveryIdentityDigest'),
    controlBasename: value.controlBasename,
    receiptBasename: value.receiptBasename,
    quarantineBasename: value.quarantineBasename,
    controlDigest: digest(value.controlDigest, 'controlDigest'),
    receiptDigest: digest(value.receiptDigest, 'receiptDigest'),
    controlIdentity: assertRecordIdentity(value.controlIdentity),
    receiptIdentity: assertRecordIdentity(value.receiptIdentity),
  });
  const names = recordNames(request);
  const expectedControl = buildControl(request, token.quarantineBasename);
  const expectedReceipt = buildReceipt(request, expectedControl);
  const controlBytes = Buffer.from(encodeControlRecord(request, expectedControl), 'utf8');
  const receiptBytes = Buffer.from(
    encodeReceiptRecord(request, expectedControl, expectedReceipt),
    'utf8'
  );
  if (token.operationId !== request.operationId ||
      token.requestDigest !== requestDigest(request) ||
      token.trustedRootIdentityDigest !== request.trustedRootIdentityDigest ||
      token.projectChainIdentityDigest !== request.projectChainIdentityDigest ||
      token.recoveryIdentityDigest !== request.recoveryIdentityDigest ||
      token.controlBasename !== names.controlBasename ||
      token.receiptBasename !== names.receiptBasename ||
      token.controlDigest !== expectedControl.controlDigest ||
      token.receiptDigest !== expectedReceipt.receiptDigest ||
      token.controlIdentity.size !== String(controlBytes.length) ||
      token.receiptIdentity.size !== String(receiptBytes.length) ||
      token.controlIdentity.recordSha256 !== evidenceSchema.sha256(controlBytes) ||
      token.receiptIdentity.recordSha256 !== evidenceSchema.sha256(receiptBytes)) {
    fail('marker clear token does not bind request');
  }
  return token;
}

function assertResult(raw, rawRequest, expectedCommand) {
  const request = assertRequest(rawRequest);
  if (!['CLEAR', 'RECONCILE'].includes(expectedCommand)) fail('marker clear command is invalid');
  const value = valuesOf(raw, KEYS.RESULT, 'marker clear result');
  if (value.schema !== SCHEMAS.RESULT || value.command !== expectedCommand ||
      !['COMMITTED', 'UNCOMMITTED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== request.operationId ||
      value.requestDigest !== requestDigest(request)) {
    fail('marker clear result authority is invalid');
  }
  const committed = value.state === 'COMMITTED';
  const token = committed ? assertToken(value.token, request) : value.token;
  if ((!committed && token !== null) ||
      (value.state === 'UNKNOWN'
        ? value.errorCode !== 'MARKER_CLEAR_UNKNOWN'
        : value.errorCode !== null)) {
    fail('marker clear result state matrix is invalid');
  }
  return Object.freeze({
    schema: SCHEMAS.RESULT,
    command: expectedCommand,
    state: value.state,
    operationId: request.operationId,
    requestDigest: requestDigest(request),
    token: committed ? token : null,
    errorCode: value.errorCode,
  });
}

function buildAckRequest(rawRequest, rawToken) {
  const request = assertRequest(rawRequest);
  const token = assertToken(rawToken, request);
  return Object.freeze({
    schema: SCHEMAS.ACK_REQUEST,
    operationId: request.operationId,
    requestDigest: requestDigest(request),
    token,
  });
}

function assertAckRequest(raw, rawRequest) {
  const request = assertRequest(rawRequest);
  const value = valuesOf(raw, KEYS.ACK_REQUEST, 'marker clear ACK request');
  if (value.schema !== SCHEMAS.ACK_REQUEST || value.operationId !== request.operationId ||
      value.requestDigest !== requestDigest(request)) {
    fail('marker clear ACK request authority is invalid');
  }
  return buildAckRequest(request, value.token);
}

function assertAckResult(raw, rawRequest) {
  const request = assertRequest(rawRequest);
  const value = valuesOf(raw, KEYS.ACK_RESULT, 'marker clear ACK result');
  if (value.schema !== SCHEMAS.ACK_RESULT ||
      !['ACKED', 'UNKNOWN'].includes(value.state) ||
      value.operationId !== request.operationId ||
      value.requestDigest !== requestDigest(request) ||
      (value.state === 'UNKNOWN'
        ? value.errorCode !== 'MARKER_CLEAR_UNKNOWN'
        : value.errorCode !== null)) {
    fail('marker clear ACK result authority is invalid');
  }
  return Object.freeze({
    schema: SCHEMAS.ACK_RESULT,
    state: value.state,
    operationId: request.operationId,
    requestDigest: requestDigest(request),
    errorCode: value.errorCode,
  });
}

module.exports = Object.freeze({
  SCHEMAS,
  LIMITS,
  MARKER_BASENAME,
  QUARANTINE_RE,
  CONTROL_RE,
  RECEIPT_RE,
  ChangesHistoryMarkerLifecycleSchemaError,
  assertRequest,
  requestDigest,
  recordNames,
  buildControl,
  assertControl,
  buildReceipt,
  assertReceipt,
  buildRecordIdentity,
  assertRecordIdentity,
  encodeControlRecord,
  encodeReceiptRecord,
  buildToken,
  assertToken,
  assertResult,
  buildAckRequest,
  assertAckRequest,
  assertAckResult,
});
