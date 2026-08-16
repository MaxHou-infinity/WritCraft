'use strict';

const evidenceSchema = require('./evidence-delivery-schema');
const phaseSchema = require('./snapshot-public-markdown-phase-schema');
const nativeSchema = require('./public-markdown-native-schema');

const SCHEMA = 'writcraft.snapshot-public-markdown-undo-settlement/v1';
const STATES = Object.freeze(['PREPARED', 'COMMITTED']);
const COMMAND = 'RESTORE_QUARANTINE';
const MAX_BYTES = 512 * 1024;
const KEYS = Object.freeze([
  'schema',
  'state',
  'command',
  'operationId',
  'undoRequestDigest',
  'settleRequest',
  'settleRequestDigest',
  'receiptSetDigest',
  'finalBasename',
  'finalRecord',
  'finalRecordIdentity',
]);

class SnapshotPublicMarkdownUndoSettlementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotPublicMarkdownUndoSettlementError';
    this.code = 'INVALID_SNAPSHOT_UNDO_SETTLEMENT';
  }
}

function fail(message) {
  throw new SnapshotPublicMarkdownUndoSettlementError(message);
}

function valuesOf(raw, keys, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    fail(`${label} must be a plain record`);
  }
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== keys.length ||
      ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    fail(`${label} keys are invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail(`${label}.${key} must be enumerable plain data`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function native(call, message) {
  try { return call(); }
  catch (_) { fail(message); }
}

function digestObject(schema, value) {
  return evidenceSchema.digestObject(schema, value);
}

function stablePayload(value) {
  return {
    schema: value.schema,
    command: value.command,
    operationId: value.operationId,
    undoRequestDigest: value.undoRequestDigest,
    settleRequest: value.settleRequest,
    settleRequestDigest: value.settleRequestDigest,
    receiptSetDigest: value.receiptSetDigest,
    finalBasename: value.finalBasename,
    finalRecord: value.finalRecord,
  };
}

function assertAuthority(raw, rawUndoAuthority) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'settlement requires exact original undo authority'
  );
  const values = valuesOf(raw, KEYS, 'undo settlement authority');
  const settleRequest = native(
    () => nativeSchema.assertUndoSettleRequest(
      values.settleRequest,
      authority,
      COMMAND
    ),
    'settlement request is not bound to original undo authority'
  );
  const finalRecord = native(
    () => nativeSchema.assertUndoFinalRecord(
      values.finalRecord,
      settleRequest,
      authority,
      COMMAND
    ),
    'settlement final record authority is invalid'
  );
  const undoRequestDigest = digestObject(
    nativeSchema.SCHEMAS.UNDO_REQUEST,
    authority.request
  );
  const settleRequestDigest = digestObject(
    nativeSchema.SCHEMAS.UNDO_SETTLE_REQUEST,
    settleRequest
  );
  const receiptSetDigest = native(
    () => nativeSchema.undoReceiptSetDigest(settleRequest, authority, COMMAND),
    'settlement receipt set is invalid'
  );
  const finalBasename = native(
    () => nativeSchema.undoFinalRecordName(settleRequest, authority, COMMAND),
    'settlement final basename is invalid'
  );
  if (values.schema !== SCHEMA || !STATES.includes(values.state) ||
      values.command !== COMMAND || values.operationId !== authority.request.operationId ||
      values.undoRequestDigest !== undoRequestDigest ||
      values.settleRequestDigest !== settleRequestDigest ||
      values.receiptSetDigest !== receiptSetDigest ||
      values.finalBasename !== finalBasename) {
    fail('settlement authority does not reproduce its original request');
  }
  let finalRecordIdentity = null;
  if (values.state === 'PREPARED') {
    if (values.finalRecordIdentity !== null) {
      fail('prepared settlement cannot claim a published final identity');
    }
  } else {
    finalRecordIdentity = native(
      () => nativeSchema.assertUndoSettleResult({
        schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
        command: COMMAND,
        state: 'COMMITTED',
        operationId: settleRequest.operationId,
        finalRecord,
        finalRecordIdentity: values.finalRecordIdentity,
        errorCode: null,
      }, settleRequest, authority, COMMAND).finalRecordIdentity,
      'committed settlement final identity is invalid'
    );
  }
  const valid = Object.freeze({
    schema: SCHEMA,
    state: values.state,
    command: COMMAND,
    operationId: authority.request.operationId,
    undoRequestDigest,
    settleRequest,
    settleRequestDigest,
    receiptSetDigest,
    finalBasename,
    finalRecord,
    finalRecordIdentity,
  });
  if (evidenceSchema.canonicalJsonByteLength(valid) > MAX_BYTES) {
    fail('settlement marker authority exceeds its frozen budget');
  }
  return valid;
}

function prepare(rawUndoAuthority, rawTokens) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'settlement requires exact original undo authority'
  );
  const settleRequest = native(
    () => nativeSchema.buildUndoSettleRequest(
      authority,
      COMMAND,
      rawTokens,
      null
    ),
    'settlement tokens do not bind the original undo authority'
  );
  const finalRecord = native(
    () => nativeSchema.buildUndoFinalRecord(settleRequest, authority, COMMAND),
    'settlement final record cannot be derived'
  );
  return assertAuthority({
    schema: SCHEMA,
    state: 'PREPARED',
    command: COMMAND,
    operationId: authority.request.operationId,
    undoRequestDigest: digestObject(nativeSchema.SCHEMAS.UNDO_REQUEST, authority.request),
    settleRequest,
    settleRequestDigest: digestObject(nativeSchema.SCHEMAS.UNDO_SETTLE_REQUEST, settleRequest),
    receiptSetDigest: nativeSchema.undoReceiptSetDigest(settleRequest, authority, COMMAND),
    finalBasename: nativeSchema.undoFinalRecordName(settleRequest, authority, COMMAND),
    finalRecord,
    finalRecordIdentity: null,
  }, authority);
}

function commit(rawPrepared, rawResult, rawUndoAuthority) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'settlement commit requires exact original undo authority'
  );
  const prepared = assertAuthority(rawPrepared, authority);
  if (prepared.state !== 'PREPARED') fail('only a prepared settlement may commit');
  const result = native(
    () => nativeSchema.assertUndoSettleResult(
      rawResult,
      prepared.settleRequest,
      authority,
      COMMAND
    ),
    'settlement result is not exact formal B truth'
  );
  if (result.state !== 'COMMITTED') fail('only formal B COMMITTED may advance settlement');
  return assertTransition(prepared, {
    ...prepared,
    state: 'COMMITTED',
    finalRecordIdentity: result.finalRecordIdentity,
  }, authority);
}

function assertTransition(rawPrevious, rawNext, rawUndoAuthority) {
  const previous = assertAuthority(rawPrevious, rawUndoAuthority);
  const next = assertAuthority(rawNext, rawUndoAuthority);
  if (previous.state !== 'PREPARED' || next.state !== 'COMMITTED' ||
      evidenceSchema.canonicalJson(stablePayload(previous)) !==
        evidenceSchema.canonicalJson(stablePayload(next))) {
    fail('settlement authority transition is invalid');
  }
  return next;
}

function assertMarkerBinding(rawSettlement, rawUndoAuthority, rawPhase) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'marker binding requires exact original undo authority'
  );
  const phase = native(
    () => phaseSchema.assertPhaseRecord(rawPhase, authority.parentSelection),
    'marker binding requires exact Safe Undo phase authority'
  );
  if (phase.kind !== 'snapshot_restore_undo' ||
      phase.operationId !== authority.request.operationId) {
    fail('settlement marker kind or operation is invalid');
  }
  if (rawSettlement === null) {
    if (phase.phase === 'RESTORED') {
      fail('RESTORED marker cannot omit committed settlement authority');
    }
    return null;
  }
  const settlement = assertAuthority(rawSettlement, authority);
  if (phase.phase === 'QUARANTINED') {
    if (settlement.state !== 'PREPARED' || phase.finalReceiptDigest !== null) {
      fail('QUARANTINED settlement marker must retain only prepared B authority');
    }
  } else if (phase.phase === 'RESTORED') {
    if (settlement.state !== 'COMMITTED' ||
        phase.finalReceiptDigest !== settlement.finalRecord.finalRecordDigest) {
      fail('RESTORED marker must retain committed B final authority');
    }
  } else {
    fail('settlement authority is forbidden outside the B branch');
  }
  if (phase.items.some((item, index) =>
    item.quarantineReceiptDigest !== settlement.settleRequest.tokens[index]?.receiptDigest)) {
    fail('settlement token order does not match phase quarantine receipts');
  }
  return settlement;
}

function assertMarkerTransition(
  rawPreviousSettlement,
  rawNextSettlement,
  rawUndoAuthority,
  rawPreviousPhase,
  rawNextPhase
) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'marker transition requires exact original undo authority'
  );
  const previousPhase = native(
    () => phaseSchema.assertPhaseRecord(rawPreviousPhase, authority.parentSelection),
    'marker transition previous phase is invalid'
  );
  const nextPhase = native(
    () => phaseSchema.assertPhaseRecord(rawNextPhase, authority.parentSelection),
    'marker transition next phase is invalid'
  );
  const previous = assertMarkerBinding(
    rawPreviousSettlement,
    authority,
    previousPhase
  );
  const next = assertMarkerBinding(rawNextSettlement, authority, nextPhase);
  const samePhase = evidenceSchema.canonicalJson(previousPhase) ===
    evidenceSchema.canonicalJson(nextPhase);
  if (previousPhase.phase === 'QUARANTINED' && previous === null &&
      nextPhase.phase === 'QUARANTINED' && next?.state === 'PREPARED' && samePhase) {
    return next;
  }
  if (previousPhase.phase === 'QUARANTINED' && previous?.state === 'PREPARED' &&
      nextPhase.phase === 'RESTORED' && next?.state === 'COMMITTED') {
    native(
      () => phaseSchema.assertTransition(
        previousPhase,
        nextPhase,
        authority.parentSelection
      ),
      'marker transition does not bind exact QUARANTINED to RESTORED phase authority'
    );
    return assertTransition(previous, next, authority);
  }
  if (previousPhase.phase === 'RESTORED' && previous?.state === 'COMMITTED' &&
      nextPhase.phase === 'RESTORED' && next?.state === 'COMMITTED' && samePhase &&
      evidenceSchema.canonicalJson(previous) === evidenceSchema.canonicalJson(next)) {
    return next;
  }
  fail('settlement marker transition is invalid');
}

module.exports = Object.freeze({
  SCHEMA,
  STATES,
  COMMAND,
  MAX_BYTES,
  KEYS,
  SnapshotPublicMarkdownUndoSettlementError,
  prepare,
  commit,
  assertAuthority,
  assertTransition,
  assertMarkerBinding,
  assertMarkerTransition,
});
