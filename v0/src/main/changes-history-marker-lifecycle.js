'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const evidenceSchema = require('./evidence-delivery-schema');
const markerSchema = require('./changes-history-marker-lifecycle-schema');

const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'changes-history-artifact-helper')
  : path.join(__dirname, 'native', 'changes-history-artifact-helper');
const SCOPED_SCHEMA = 'writcraft.changes-history-marker-lifecycle-scoped/v1';
const LIFECYCLE_SCHEMA = 'writcraft.changes-history-marker-lifecycle/v1';
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const BINDING_KEYS = Object.freeze(['request', 'heldFd', 'identity']);

class ChangesHistoryMarkerLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryMarkerLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryMarkerLifecycleError(code, message);
}

function descriptorValues(raw, keys, label) {
  try { evidenceSchema.assertExactKeys(raw, keys, label); }
  catch (_) { fail('MARKER_CLEAR_PROTOCOL', `${label} is invalid`); }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of keys) values[key] = descriptors[key].value;
  return values;
}

function boundedRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0') ||
      Buffer.byteLength(rootPath, 'utf8') > 4096 || path.resolve(rootPath) !== rootPath) {
    fail('MARKER_CLEAR_PROTOCOL', 'canonical project root is required');
  }
  return rootPath;
}

function validateBinding(raw) {
  const value = descriptorValues(raw, BINDING_KEYS, 'marker clear binding');
  const request = markerSchema.assertRequest(value.request);
  if (!Number.isSafeInteger(value.heldFd) || value.heldFd < 0) {
    fail('MARKER_CLEAR_PROTOCOL', 'held marker descriptor is invalid');
  }
  let identity;
  try { identity = evidenceSchema.assertObjectIdentity(value.identity); }
  catch (_) { fail('MARKER_CLEAR_PROTOCOL', 'held marker identity is invalid'); }
  if (identity.size !== String(request.markerByteLength) || identity.contentSha256 !== request.markerDigest ||
      identity.nlink !== 1 || identity.mode !== 0o600 ||
      evidenceSchema.digestObjectIdentity(identity) !== request.markerIdentityDigest) {
    fail('MARKER_CLEAR_PROTOCOL', 'held marker authority does not bind request');
  }
  return Object.freeze({ request, heldFd: value.heldFd, identity: Object.freeze({ ...identity }) });
}

function encodeRequest(command, binding) {
  const { request, identity } = binding;
  const fields = [
    'M', command, request.operationId,
    Buffer.from(request.projectId, 'utf8').toString('hex'), request.markerBasename,
    String(request.markerByteLength), request.markerDigest, request.markerIdentityDigest,
    request.finalizedPhaseDigest, request.artifactCleanupDigest,
    markerSchema.requestDigest(request), request.trustedRootIdentityDigest,
    request.projectChainIdentityDigest, request.recoveryIdentityDigest,
    identity.dev, identity.ino, String(identity.uid), String(identity.mode),
    String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
  ];
  return fields.join('\t');
}

function encodeRecordIdentity(identity) {
  return [
    identity.dev, identity.ino, String(identity.uid), String(identity.mode),
    String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
    identity.recordSha256, identity.identityDigest,
  ];
}

function parseSafeIntegerField(value) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value || '')) throw new Error('invalid integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) throw new Error('invalid integer');
  return parsed;
}

function encodeAck(binding, token) {
  return [
    encodeRequest('ACK', binding), token.controlBasename, token.receiptBasename,
    token.quarantineBasename, token.controlDigest, token.receiptDigest,
    ...encodeRecordIdentity(token.controlIdentity),
    ...encodeRecordIdentity(token.receiptIdentity),
  ].join('\t');
}

function parseResult(fields, request, expectedCommand) {
  if (!Array.isArray(fields) || fields[0] !== 'M' || fields[1] !== 'OK' ||
      fields[2] !== expectedCommand) return null;
  const requestDigest = markerSchema.requestDigest(request);
  try {
    if (expectedCommand === 'ACK') {
      if (fields.length !== 7) return null;
      return markerSchema.assertAckResult({
        schema: markerSchema.SCHEMAS.ACK_RESULT,
        state: fields[3],
        operationId: fields[4],
        requestDigest: fields[5],
        errorCode: fields[6] === '-' ? null : fields[6],
      }, request);
    }
    if (fields.length === 31 && fields[3] === 'COMMITTED') {
      const control = markerSchema.buildControl(request, fields[6]);
      const receipt = markerSchema.buildReceipt(request, control);
      const recordIdentity = offset => markerSchema.assertRecordIdentity({
        schema: markerSchema.SCHEMAS.RECORD_IDENTITY,
        dev: fields[offset],
        ino: fields[offset + 1],
        uid: parseSafeIntegerField(fields[offset + 2]),
        mode: parseSafeIntegerField(fields[offset + 3]),
        nlink: parseSafeIntegerField(fields[offset + 4]),
        size: fields[offset + 5],
        mtimeNs: fields[offset + 6],
        ctimeNs: fields[offset + 7],
        recordSha256: fields[offset + 8],
        identityDigest: fields[offset + 9],
      });
      const token = markerSchema.buildToken(
        request,
        control,
        receipt,
        recordIdentity(11),
        recordIdentity(21)
      );
      if (fields[4] !== request.operationId || fields[5] !== requestDigest ||
          fields[7] !== token.controlBasename || fields[8] !== token.receiptBasename ||
          fields[9] !== token.controlDigest || fields[10] !== token.receiptDigest) return null;
      return markerSchema.assertResult({
        schema: markerSchema.SCHEMAS.RESULT,
        command: expectedCommand,
        state: 'COMMITTED',
        operationId: fields[4],
        requestDigest: fields[5],
        token,
        errorCode: null,
      }, request, expectedCommand);
    }
    if (fields.length !== 7) return null;
    return markerSchema.assertResult({
      schema: markerSchema.SCHEMAS.RESULT,
      command: expectedCommand,
      state: fields[3],
      operationId: fields[4],
      requestDigest: fields[5],
      token: null,
      errorCode: fields[6] === '-' ? null : fields[6],
    }, request, expectedCommand);
  } catch (_) {
    return null;
  }
}

function createChangesHistoryMarkerLifecycle(options = {}) {
  const helperPath = options.helperPath || HELPER_PATH;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function forProject(rootPath) {
    const projectRoot = boundedRoot(rootPath);
    const rootLine = `P\t${Buffer.from(projectRoot, 'utf8').toString('hex')}`;

    function invoke(command, heldFd, request, expectedCommand) {
      let trustedRootFd;
      try { trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY); }
      catch (_) { return null; }
      let result;
      try {
        result = spawnSync(helperPath, [], {
          input: `${rootLine}\n${command}\n`,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          stdio: ['pipe', 'pipe', 'pipe', trustedRootFd, heldFd ?? trustedRootFd],
        });
      } catch (_) {
        return null;
      } finally {
        try { fs.closeSync(trustedRootFd); } catch (_) {}
      }
      const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
      if (result?.status !== 0 || stderr.length !== 0 || stdout.includes('\0') ||
          Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) return null;
      const lines = stdout.split('\n');
      if (lines.length !== 3 || lines[0] !== 'P\tOK' || lines[2] !== '') return null;
      return parseResult(lines[1].split('\t'), request, expectedCommand);
    }

    function clear(rawBinding) {
      const binding = validateBinding(rawBinding);
      const request = binding.request;
      let result = invoke(encodeRequest('CLEAR', binding), binding.heldFd, request, 'CLEAR');
      if (!result || result.state === 'UNKNOWN') {
        result = invoke(encodeRequest('RECONCILE', binding), null, request, 'RECONCILE');
      }
      if (!result || result.state !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'exact marker clear requires reconciliation');
      }
      const ackRequest = markerSchema.buildAckRequest(request, result.token);
      let ack = null;
      for (let attempt = 0; attempt < 3 && (!ack || ack.state !== 'ACKED'); attempt += 1) {
        ack = invoke(encodeAck(binding, ackRequest.token), null, request, 'ACK');
        if (ack?.state === 'UNKNOWN') break;
      }
      if (!ack || ack.state !== 'ACKED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'exact marker clear acknowledgement is unknown');
      }
      return ack;
    }

    return Object.freeze({ schema: SCOPED_SCHEMA, clear });
  }

  return Object.freeze({ schema: LIFECYCLE_SCHEMA, forProject });
}

module.exports = Object.freeze({
  HELPER_PATH,
  ChangesHistoryMarkerLifecycleError,
  createChangesHistoryMarkerLifecycle,
});
