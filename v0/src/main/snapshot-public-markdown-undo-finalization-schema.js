'use strict';

// Private authority embedded in the existing Changes/History recovery marker.
// It owns no persistence and creates no sidecar. Descriptor-exact validation
// keeps D/A restart authority separate from the pre-History B settlement.

const evidenceSchema = require('./evidence-delivery-schema');
const phaseSchema = require('./snapshot-public-markdown-phase-schema');
const nativeSchema = require('./public-markdown-native-schema');

const SCHEMA = 'writcraft.snapshot-public-markdown-undo-finalization/v1';
const STATES = Object.freeze(['PREPARED', 'COMMITTED']);
const COMMAND = 'FINALIZE_UNDO';
const MAX_BYTES = 512 * 1024;
const KEYS = Object.freeze([
  'schema',
  'state',
  'command',
  'operationId',
  'undoRequestDigest',
  'historyCommittedPhaseDigest',
  'settleRequest',
  'settleRequestDigest',
  'receiptSetDigest',
  'finalBasename',
  'finalRecord',
  'finalRecordIdentity',
  'ackRequest',
  'ackRequestDigest',
]);

class SnapshotPublicMarkdownUndoFinalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotPublicMarkdownUndoFinalizationError';
    this.code = 'INVALID_SNAPSHOT_UNDO_FINALIZATION';
  }
}

function fail(message) {
  throw new SnapshotPublicMarkdownUndoFinalizationError(message);
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
    historyCommittedPhaseDigest: value.historyCommittedPhaseDigest,
    settleRequest: value.settleRequest,
    settleRequestDigest: value.settleRequestDigest,
    receiptSetDigest: value.receiptSetDigest,
    finalBasename: value.finalBasename,
    finalRecord: value.finalRecord,
  };
}

function historyCommittedPhase(rawPhase, authority) {
  const phase = native(
    () => phaseSchema.assertPhaseRecord(rawPhase, authority.parentSelection),
    'finalization requires exact Safe Undo phase authority'
  );
  if (phase.kind !== 'snapshot_restore_undo' ||
      phase.operationId !== authority.request.operationId ||
      !['HISTORY_COMMITTED', 'FINALIZED'].includes(phase.phase)) {
    fail('finalization phase kind or operation is invalid');
  }
  if (phase.phase === 'HISTORY_COMMITTED') return phase;
  return native(
    () => phaseSchema.assertPhaseRecord({
      ...phase,
      phase: 'HISTORY_COMMITTED',
      finalReceiptDigest: null,
    }, authority.parentSelection),
    'FINALIZED cannot reproduce its exact HISTORY_COMMITTED authority'
  );
}

function assertAuthority(raw, rawUndoAuthority) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'finalization requires exact original undo authority'
  );
  const values = valuesOf(raw, KEYS, 'undo finalization authority');
  const settleRequest = native(
    () => nativeSchema.assertUndoSettleRequest(
      values.settleRequest,
      authority,
      COMMAND
    ),
    'finalization request is not bound to original undo authority'
  );
  const finalRecord = native(
    () => nativeSchema.assertUndoFinalRecord(
      values.finalRecord,
      settleRequest,
      authority,
      COMMAND
    ),
    'finalization final record authority is invalid'
  );
  const undoRequestDigest = digestObject(
    nativeSchema.SCHEMAS.UNDO_REQUEST,
    authority.request
  );
  const historyCommittedPhaseDigest = settleRequest.historyCommittedPhaseDigest;
  const settleRequestDigest = digestObject(
    nativeSchema.SCHEMAS.UNDO_SETTLE_REQUEST,
    settleRequest
  );
  const receiptSetDigest = native(
    () => nativeSchema.undoReceiptSetDigest(settleRequest, authority, COMMAND),
    'finalization receipt set is invalid'
  );
  const finalBasename = native(
    () => nativeSchema.undoFinalRecordName(settleRequest, authority, COMMAND),
    'finalization final basename is invalid'
  );
  if (values.schema !== SCHEMA || !STATES.includes(values.state) ||
      values.command !== COMMAND || values.operationId !== authority.request.operationId ||
      values.undoRequestDigest !== undoRequestDigest ||
      values.historyCommittedPhaseDigest !== historyCommittedPhaseDigest ||
      values.settleRequestDigest !== settleRequestDigest ||
      values.receiptSetDigest !== receiptSetDigest ||
      values.finalBasename !== finalBasename) {
    fail('finalization authority does not reproduce its original request');
  }
  let finalRecordIdentity = null;
  let ackRequest = null;
  let ackRequestDigest = null;
  if (values.state === 'PREPARED') {
    if (values.finalRecordIdentity !== null || values.ackRequest !== null ||
        values.ackRequestDigest !== null) {
      fail('prepared finalization cannot claim published final or A authority');
    }
  } else {
    const committed = native(
      () => nativeSchema.assertUndoSettleResult({
        schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
        command: COMMAND,
        state: 'COMMITTED',
        operationId: settleRequest.operationId,
        finalRecord,
        finalRecordIdentity: values.finalRecordIdentity,
        errorCode: null,
      }, settleRequest, authority, COMMAND),
      'committed finalization final identity is invalid'
    );
    finalRecordIdentity = committed.finalRecordIdentity;
    ackRequest = native(
      () => nativeSchema.assertUndoAckRequest(
        values.ackRequest,
        settleRequest,
        finalRecord,
        finalRecordIdentity,
        authority,
        COMMAND
      ),
      'committed finalization A authority is invalid'
    );
    ackRequestDigest = digestObject(nativeSchema.SCHEMAS.UNDO_ACK_REQUEST, ackRequest);
    if (values.ackRequestDigest !== ackRequestDigest) {
      fail('committed finalization A digest is invalid');
    }
  }
  const valid = Object.freeze({
    schema: SCHEMA,
    state: values.state,
    command: COMMAND,
    operationId: authority.request.operationId,
    undoRequestDigest,
    historyCommittedPhaseDigest,
    settleRequest,
    settleRequestDigest,
    receiptSetDigest,
    finalBasename,
    finalRecord,
    finalRecordIdentity,
    ackRequest,
    ackRequestDigest,
  });
  if (evidenceSchema.canonicalJsonByteLength(valid) > MAX_BYTES) {
    fail('finalization marker authority exceeds its frozen budget');
  }
  return valid;
}

function prepare(rawUndoAuthority, rawTokens, rawHistoryCommittedPhase) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'finalization requires exact original undo authority'
  );
  const phase = historyCommittedPhase(rawHistoryCommittedPhase, authority);
  if (phase.phase !== 'HISTORY_COMMITTED') {
    fail('finalization prepare requires exact HISTORY_COMMITTED phase');
  }
  const historyCommittedPhaseDigest = digestObject(phaseSchema.SCHEMA, phase);
  const settleRequest = native(
    () => nativeSchema.buildUndoSettleRequest(
      authority,
      COMMAND,
      rawTokens,
      historyCommittedPhaseDigest
    ),
    'finalization tokens do not bind the original undo authority'
  );
  const finalRecord = native(
    () => nativeSchema.buildUndoFinalRecord(settleRequest, authority, COMMAND),
    'finalization final record cannot be derived'
  );
  return assertAuthority({
    schema: SCHEMA,
    state: 'PREPARED',
    command: COMMAND,
    operationId: authority.request.operationId,
    undoRequestDigest: digestObject(nativeSchema.SCHEMAS.UNDO_REQUEST, authority.request),
    historyCommittedPhaseDigest,
    settleRequest,
    settleRequestDigest: digestObject(nativeSchema.SCHEMAS.UNDO_SETTLE_REQUEST, settleRequest),
    receiptSetDigest: nativeSchema.undoReceiptSetDigest(settleRequest, authority, COMMAND),
    finalBasename: nativeSchema.undoFinalRecordName(settleRequest, authority, COMMAND),
    finalRecord,
    finalRecordIdentity: null,
    ackRequest: null,
    ackRequestDigest: null,
  }, authority);
}

function commit(rawPrepared, rawResult, rawUndoAuthority) {
  const authority = native(
    () => nativeSchema.assertUndoAuthority(rawUndoAuthority),
    'finalization commit requires exact original undo authority'
  );
  const prepared = assertAuthority(rawPrepared, authority);
  if (prepared.state !== 'PREPARED') fail('only a prepared finalization may commit');
  const result = native(
    () => nativeSchema.assertUndoSettleResult(
      rawResult,
      prepared.settleRequest,
      authority,
      COMMAND
    ),
    'finalization result is not exact formal D truth'
  );
  if (result.state !== 'COMMITTED') fail('only formal D COMMITTED may advance finalization');
  const ackRequest = native(
    () => nativeSchema.buildUndoAckRequest(
      prepared.settleRequest,
      prepared.finalRecord,
      result.finalRecordIdentity,
      authority,
      COMMAND
    ),
    'formal D truth cannot derive exact A authority'
  );
  return assertTransition(prepared, {
    ...prepared,
    state: 'COMMITTED',
    finalRecordIdentity: result.finalRecordIdentity,
    ackRequest,
    ackRequestDigest: digestObject(nativeSchema.SCHEMAS.UNDO_ACK_REQUEST, ackRequest),
  }, authority);
}

function assertTransition(rawPrevious, rawNext, rawUndoAuthority) {
  const previous = assertAuthority(rawPrevious, rawUndoAuthority);
  const next = assertAuthority(rawNext, rawUndoAuthority);
  if (previous.state !== 'PREPARED' || next.state !== 'COMMITTED' ||
      evidenceSchema.canonicalJson(stablePayload(previous)) !==
        evidenceSchema.canonicalJson(stablePayload(next))) {
    fail('finalization authority transition is invalid');
  }
  return next;
}

function assertMarkerBinding(
  rawFinalization,
  rawUndoAuthority,
  rawPhase,
  rawSettlement = null
) {
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
    fail('finalization marker kind or operation is invalid');
  }
  if (rawSettlement !== null) {
    fail('D finalization cannot coexist or cross with B settlement authority');
  }
  if (rawFinalization === null) {
    if (phase.phase === 'FINALIZED') {
      fail('FINALIZED marker cannot omit committed finalization authority');
    }
    if (phase.phase !== 'HISTORY_COMMITTED') {
      fail('null finalization is outside the D branch');
    }
    return null;
  }
  const finalization = assertAuthority(rawFinalization, authority);
  const committedPhase = historyCommittedPhase(phase, authority);
  if (finalization.historyCommittedPhaseDigest !==
      digestObject(phaseSchema.SCHEMA, committedPhase)) {
    fail('finalization does not bind exact HISTORY_COMMITTED phase');
  }
  if (phase.phase === 'HISTORY_COMMITTED') {
    if (finalization.state !== 'PREPARED' || phase.finalReceiptDigest !== null) {
      fail('HISTORY_COMMITTED marker may retain only prepared D authority');
    }
  } else if (phase.phase === 'FINALIZED') {
    if (finalization.state !== 'COMMITTED' ||
        phase.finalReceiptDigest !== finalization.finalRecord.finalRecordDigest) {
      fail('FINALIZED marker must retain committed D and A authority');
    }
  } else {
    fail('finalization authority is forbidden outside the D branch');
  }
  if (phase.items.some((item, index) =>
    item.quarantineReceiptDigest !== finalization.settleRequest.tokens[index]?.receiptDigest)) {
    fail('finalization token order does not match phase quarantine receipts');
  }
  return finalization;
}

function assertMarkerTransition(
  rawPreviousFinalization,
  rawNextFinalization,
  rawUndoAuthority,
  rawPreviousPhase,
  rawNextPhase,
  rawPreviousSettlement = null,
  rawNextSettlement = null
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
    rawPreviousFinalization,
    authority,
    previousPhase,
    rawPreviousSettlement
  );
  const next = assertMarkerBinding(
    rawNextFinalization,
    authority,
    nextPhase,
    rawNextSettlement
  );
  const samePhase = evidenceSchema.canonicalJson(previousPhase) ===
    evidenceSchema.canonicalJson(nextPhase);
  if (previousPhase.phase === 'HISTORY_COMMITTED' && previous === null &&
      nextPhase.phase === 'HISTORY_COMMITTED' && next?.state === 'PREPARED' && samePhase) {
    return next;
  }
  if (previousPhase.phase === 'HISTORY_COMMITTED' && previous?.state === 'PREPARED' &&
      nextPhase.phase === 'FINALIZED' && next?.state === 'COMMITTED') {
    native(
      () => phaseSchema.assertTransition(
        previousPhase,
        nextPhase,
        authority.parentSelection
      ),
      'marker transition does not bind exact HISTORY_COMMITTED to FINALIZED phase authority'
    );
    return assertTransition(previous, next, authority);
  }
  if (previousPhase.phase === 'FINALIZED' && previous?.state === 'COMMITTED' &&
      nextPhase.phase === 'FINALIZED' && next?.state === 'COMMITTED' && samePhase &&
      evidenceSchema.canonicalJson(previous) === evidenceSchema.canonicalJson(next)) {
    return next;
  }
  fail('finalization marker transition is invalid');
}

module.exports = Object.freeze({
  SCHEMA,
  STATES,
  COMMAND,
  MAX_BYTES,
  KEYS,
  SnapshotPublicMarkdownUndoFinalizationError,
  prepare,
  commit,
  assertAuthority,
  assertTransition,
  assertMarkerBinding,
  assertMarkerTransition,
});
