'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const evidenceSchema = require('./evidence-delivery-schema');
const nativeSchema = require('./public-markdown-native-schema');
const existingRestoreSchema = require('./snapshot-existing-restore-native-schema');

const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'public-markdown-create-helper')
  : path.join(__dirname, 'native', 'public-markdown-create-helper');
const DEFAULT_TIMEOUT_MS = 30000;
const PUBLIC_CREATE_REQUEST_SCHEMA = 'writcraft.public-markdown-create-request/v1';
const PUBLIC_CREATE_RECEIPT_SCHEMA = 'writcraft.public-markdown-create-receipt/v1';
const PUBLIC_FINALIZE_ACK_SCHEMA = 'writcraft.public-markdown-finalize-ack/v1';
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

class PublicMarkdownNativeLifecycleError extends Error {
  constructor(code, message, transactionState = null) {
    super(message);
    this.name = 'PublicMarkdownNativeLifecycleError';
    this.code = code;
    if (transactionState !== null) {
      Object.defineProperty(this, 'transactionState', { value: transactionState, enumerable: false });
    }
  }
}

function fail(code, message, transactionState = null) {
  throw new PublicMarkdownNativeLifecycleError(code, message, transactionState);
}

function canonicalRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0') ||
      rootPath !== rootPath.normalize('NFC') || path.resolve(rootPath) !== rootPath ||
      Buffer.byteLength(rootPath, 'utf8') > nativeSchema.LIMITS.maxRootBytes) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'canonical project root is required');
  }
  return rootPath;
}

function identityFromStat(stat, contentSha256 = null) {
  const mode = Number(stat.mode & 0o7777n);
  const base = {
    schema: contentSha256 === null
      ? evidenceSchema.SCHEMAS.ROOT_IDENTITY
      : evidenceSchema.SCHEMAS.OBJECT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode,
  };
  if (contentSha256 === null) return Object.freeze(base);
  return Object.freeze({
    ...base,
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    contentSha256,
  });
}

function boundProject(rootPath) {
  const recoveryPath = path.join(rootPath, '.writcraft', 'recovery');
  let rootFd = null;
  let recoveryFd = null;
  try {
    rootFd = fs.openSync(
      rootPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)
    );
    recoveryFd = fs.openSync(
      recoveryPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0)
    );
    const rootStat = fs.fstatSync(rootFd, { bigint: true });
    const recoveryStat = fs.fstatSync(recoveryFd, { bigint: true });
    if (!rootStat.isDirectory() || !recoveryStat.isDirectory() ||
        Number(recoveryStat.uid) !== process.geteuid() ||
        Number(recoveryStat.mode & 0o777n) !== 0o700) {
      fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'private recovery authority is unavailable');
    }
    return Object.freeze({
      rootIdentityDigest: evidenceSchema.digestRootIdentity(identityFromStat(rootStat)),
      recoveryIdentityDigest: evidenceSchema.digestRootIdentity(identityFromStat(recoveryStat)),
    });
  } catch (error) {
    if (error instanceof PublicMarkdownNativeLifecycleError) throw error;
    fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'project filesystem authority is unavailable');
  } finally {
    if (rootFd !== null) try { fs.closeSync(rootFd); } catch (_) {}
    if (recoveryFd !== null) try { fs.closeSync(recoveryFd); } catch (_) {}
  }
}

function artifactIdentityDigest(fd, request) {
  let stat;
  try { stat = fs.fstatSync(fd, { bigint: true }); }
  catch (_) { fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'held artifact authority is invalid'); }
  if (!stat.isFile() || stat.size !== BigInt(request.artifactByteLength) || stat.nlink !== 1n ||
      Number(stat.uid) !== process.geteuid() || Number(stat.mode & 0o777n) !== 0o600) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'held artifact authority is invalid');
  }
  return evidenceSchema.digestObjectIdentity(identityFromStat(stat, request.artifactDigest));
}

function parseToken(fields) {
  if (fields.length !== 8 || fields[0] !== 'T') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native public Markdown result is malformed', 'UNKNOWN');
  }
  return {
    schema: nativeSchema.SCHEMAS.TOKEN,
    selectedId: fields[1],
    controlBasename: fields[2],
    receiptBasename: fields[3],
    controlDigest: fields[4],
    createdIdentityDigest: fields[5],
    contentDigest: fields[6],
    receiptDigest: fields[7],
  };
}

function parseResult(stdout, stderr, request, expectedCommand) {
  const text = nativeSchema.assertResponseEnvelope(stdout, stderr);
  const lines = text.trimEnd().split('\n');
  if (lines.shift() !== 'P\tOK' || lines.length < 1) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native public Markdown bind failed', 'UNKNOWN');
  }
  const header = lines.shift().split('\t');
  const letter = expectedCommand === 'CREATE' ? 'C' : 'R';
  if (header.length !== 9 || header[0] !== letter || header[1] !== 'RESULT' ||
      header[3] !== request.operationId || header[4] !== request.artifactDigest ||
      header[5] !== request.precreatePhaseDigest || header[6] !== request.selectionDigest ||
      !/^(?:0|[1-9][0-9]*)$/u.test(header[7]) || !['-', 'UNKNOWN'].includes(header[8])) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native public Markdown result is malformed', 'UNKNOWN');
  }
  const count = Number(header[7]);
  if (!Number.isSafeInteger(count) || count !== lines.length || count > nativeSchema.LIMITS.maxItems) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native public Markdown result is malformed', 'UNKNOWN');
  }
  const raw = {
    schema: nativeSchema.SCHEMAS.RESULT,
    command: expectedCommand,
    state: header[2],
    operationId: request.operationId,
    artifactDigest: request.artifactDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    tokens: lines.map(line => ({
      ...parseToken(line.split('\t')),
      operationId: request.operationId,
    })),
    errorCode: header[8] === 'UNKNOWN' ? 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN' : null,
  };
  try { return nativeSchema.assertResult(raw, request, expectedCommand); }
  catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native public Markdown result is invalid', 'UNKNOWN');
  }
}

function parseFinalAck(stdout, stderr, finalizeRequest, createRequest) {
  const text = nativeSchema.assertResponseEnvelope(stdout, stderr);
  const lines = text.trimEnd().split('\n');
  if (lines.length !== 2 || lines[0] !== 'P\tOK') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK is malformed', 'COMMITTED');
  }
  const fields = lines[1].split('\t');
  if (fields.length !== 10 || fields[0] !== 'F' || fields[1] !== 'OK' ||
      fields[2] !== 'ACKED' || fields[3] !== finalizeRequest.operationId ||
      fields[4] !== finalizeRequest.artifactDigest || fields[5] !== finalizeRequest.selectionDigest ||
      fields[6] !== finalizeRequest.historyCommittedPhaseDigest ||
      !nativeSchema.FINAL_BASENAME_RE.test(fields[8] || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK is malformed', 'COMMITTED');
  }
  const ack = {
    schema: nativeSchema.SCHEMAS.FINAL_ACK,
    operationId: fields[3],
    artifactDigest: fields[4],
    selectionDigest: fields[5],
    historyCommittedPhaseDigest: fields[6],
    receiptSetDigest: fields[7],
    itemCount: createRequest.items.length,
    recoveryFsyncComplete: true,
    finalAckDigest: fields[9],
  };
  try {
    const validated = nativeSchema.assertFinalAck(ack, finalizeRequest, createRequest);
    if (fields[8] !== nativeSchema.finalRecordName(finalizeRequest, createRequest)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK name is invalid', 'COMMITTED');
    }
    return validated;
  } catch (error) {
    if (error instanceof PublicMarkdownNativeLifecycleError) throw error;
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK is invalid', 'COMMITTED');
  }
}

function parseUnsignedNumber(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is malformed`, 'UNKNOWN');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is malformed`, 'UNKNOWN');
  }
  return number;
}

function parsePrivateObjectIdentity(fields, offset, label) {
  if (fields.length < offset + 9) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is malformed`, 'UNKNOWN');
  }
  return {
    schema: evidenceSchema.SCHEMAS.OBJECT_IDENTITY,
    dev: fields[offset],
    ino: fields[offset + 1],
    uid: parseUnsignedNumber(fields[offset + 2], `${label}.uid`),
    mode: parseUnsignedNumber(fields[offset + 3], `${label}.mode`),
    nlink: parseUnsignedNumber(fields[offset + 4], `${label}.nlink`),
    size: fields[offset + 5],
    mtimeNs: fields[offset + 6],
    ctimeNs: fields[offset + 7],
    contentSha256: fields[offset + 8],
  };
}

function parseUndoToken(fields, operationId) {
  if (fields.length !== 28 || fields[0] !== 'U') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native Safe Undo token is malformed', 'UNKNOWN');
  }
  return {
    schema: nativeSchema.SCHEMAS.UNDO_TOKEN,
    operationId,
    selectedId: fields[1],
    controlBasename: fields[2],
    receiptBasename: fields[3],
    quarantineBasename: fields[4],
    controlDigest: fields[5],
    createdIdentityDigest: fields[6],
    quarantineIdentityDigest: fields[7],
    contentDigest: fields[8],
    receiptDigest: fields[9],
    controlRecordIdentity: parsePrivateObjectIdentity(fields, 10, 'undo control identity'),
    receiptRecordIdentity: parsePrivateObjectIdentity(fields, 19, 'undo receipt identity'),
  };
}

function parseUndoResult(stdout, stderr, authority, expectedCommand) {
  try {
    const text = nativeSchema.assertResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.shift() !== 'P\tOK' || lines.length < 1) throw new Error('bind');
    const header = lines.shift().split('\t');
    const letter = expectedCommand === 'QUARANTINE' ? 'Q' : 'R';
    const request = authority.request;
    if (header.length !== 10 || header[0] !== letter || header[1] !== 'RESULT' ||
        header[3] !== request.operationId || header[4] !== request.artifactDigest ||
        header[5] !== request.precreatePhaseDigest || header[6] !== request.selectionDigest ||
        header[7] !== request.preparedHistoryDigest ||
        !['-', 'UNKNOWN'].includes(header[9])) throw new Error('header');
    const count = parseUnsignedNumber(header[8], 'undo result count');
    if (count !== lines.length || count > nativeSchema.LIMITS.maxItems) throw new Error('count');
    return nativeSchema.assertUndoResult({
      schema: nativeSchema.SCHEMAS.UNDO_RESULT,
      command: expectedCommand,
      state: header[2],
      operationId: request.operationId,
      artifactDigest: request.artifactDigest,
      precreatePhaseDigest: request.precreatePhaseDigest,
      selectionDigest: request.selectionDigest,
      preparedHistoryDigest: request.preparedHistoryDigest,
      tokens: lines.map(line => parseUndoToken(line.split('\t'), request.operationId)),
      errorCode: header[9] === 'UNKNOWN' ? 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN' : null,
    }, authority, expectedCommand);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native Safe Undo result is invalid', 'UNKNOWN');
  }
}

function parseUndoSettleResult(stdout, stderr, settle, authority, expectedCommand) {
  try {
    const text = nativeSchema.assertResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.shift() !== 'P\tOK' || lines.length < 1) throw new Error('bind');
    const header = lines.shift().split('\t');
    const letter = expectedCommand === 'RESTORE_QUARANTINE' ? 'B' : 'D';
    if (header.length !== 6 || header[0] !== letter || header[1] !== 'RESULT' ||
        header[3] !== settle.operationId || !['-', 'UNKNOWN'].includes(header[5])) {
      throw new Error('header');
    }
    const count = parseUnsignedNumber(header[4], 'undo settle result count');
    if (count !== lines.length || count > 1) throw new Error('count');
    let finalRecord = null;
    let finalRecordIdentity = null;
    if (count === 1) {
      const fields = lines[0].split('\t');
      if (fields.length !== 12 || fields[0] !== 'V' ||
          fields[1] !== nativeSchema.undoFinalRecordName(settle, authority, expectedCommand)) {
        throw new Error('final');
      }
      finalRecord = nativeSchema.buildUndoFinalRecord(settle, authority, expectedCommand);
      if (fields[2] !== finalRecord.finalRecordDigest) throw new Error('final digest');
      finalRecordIdentity = parsePrivateObjectIdentity(fields, 3, 'undo final identity');
    }
    return nativeSchema.assertUndoSettleResult({
      schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
      command: expectedCommand,
      state: header[2],
      operationId: settle.operationId,
      finalRecord,
      finalRecordIdentity,
      errorCode: header[5] === 'UNKNOWN' ? 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN' : null,
    }, settle, authority, expectedCommand);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native Safe Undo settlement is invalid', 'UNKNOWN');
  }
}

function parseUndoAckResult(
  stdout,
  stderr,
  ack,
  settle,
  finalRecord,
  finalRecordIdentity,
  authority,
  expectedCommand
) {
  try {
    const text = nativeSchema.assertResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.length !== 2 || lines[0] !== 'P\tOK') throw new Error('bind');
    const fields = lines[1].split('\t');
    if (fields.length !== 6 || fields[0] !== 'A' || fields[1] !== 'RESULT' ||
        fields[3] !== ack.operationId || fields[4] !== ack.finalRecordDigest ||
        !['-', 'UNKNOWN'].includes(fields[5])) throw new Error('header');
    return nativeSchema.assertUndoAckResult({
      schema: nativeSchema.SCHEMAS.UNDO_ACK_RESULT,
      command: expectedCommand,
      state: fields[2],
      operationId: ack.operationId,
      finalRecordDigest: ack.finalRecordDigest,
      errorCode: fields[5] === 'UNKNOWN' ? 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN' : null,
    }, ack, settle, finalRecord, finalRecordIdentity, authority, expectedCommand);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native Safe Undo ACK is invalid', 'UNKNOWN');
  }
}

function parseRollbackCreateToken(fields, operationId) {
  if (fields.length !== 28 || fields[0] !== 'K') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native rollback-create token is malformed', 'UNKNOWN');
  }
  return {
    schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_TOKEN,
    operationId,
    selectedId: fields[1],
    controlBasename: fields[2],
    receiptBasename: fields[3],
    quarantineBasename: fields[4],
    controlDigest: fields[5],
    createdIdentityDigest: fields[6],
    quarantineIdentityDigest: fields[7],
    contentDigest: fields[8],
    receiptDigest: fields[9],
    controlRecordIdentity: parsePrivateObjectIdentity(
      fields,
      10,
      'rollback-create control identity'
    ),
    receiptRecordIdentity: parsePrivateObjectIdentity(
      fields,
      19,
      'rollback-create receipt identity'
    ),
  };
}

function parseRollbackCreateResult(stdout, stderr, authority, expectedCommand) {
  try {
    const text = nativeSchema.assertRollbackCreateResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.shift() !== 'P\tOK' || lines.length < 1) throw new Error('bind');
    const header = lines.shift().split('\t');
    const letter = expectedCommand ===
      nativeSchema.ROLLBACK_CREATE_COMMANDS.QUARANTINE ? 'Q' : 'R';
    const requestDigest = nativeSchema.rollbackCreateRequestDigest(authority);
    if (header.length !== 7 || header[0] !== letter || header[1] !== 'RESULT' ||
        header[3] !== authority.request.operationId || header[4] !== requestDigest ||
        !['-', 'UNKNOWN'].includes(header[6])) throw new Error('header');
    const count = parseUnsignedNumber(header[5], 'rollback-create result count');
    if (count !== lines.length || count > nativeSchema.LIMITS.maxItems) throw new Error('count');
    return nativeSchema.assertRollbackCreateResult({
      schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_RESULT,
      command: expectedCommand,
      state: header[2],
      operationId: authority.request.operationId,
      requestDigest,
      tokens: lines.map(line => parseRollbackCreateToken(
        line.split('\t'),
        authority.request.operationId
      )),
      errorCode: header[6] === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
    }, authority, expectedCommand);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native rollback-create result is invalid', 'UNKNOWN');
  }
}

function parseRollbackCreateSettleResult(stdout, stderr, authority, settle) {
  try {
    const text = nativeSchema.assertRollbackCreateResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.shift() !== 'P\tOK' || lines.length < 1) throw new Error('bind');
    const header = lines.shift().split('\t');
    const requestDigest = nativeSchema.rollbackCreateRequestDigest(authority);
    if (header.length !== 7 || header[0] !== 'D' || header[1] !== 'RESULT' ||
        header[3] !== settle.operationId || header[4] !== requestDigest ||
        !['-', 'UNKNOWN'].includes(header[6])) throw new Error('header');
    const count = parseUnsignedNumber(header[5], 'rollback-create settle result count');
    if (count !== lines.length || count > 1) throw new Error('count');
    let finalRecord = null;
    let finalRecordIdentity = null;
    if (count === 1) {
      const fields = lines[0].split('\t');
      if (fields.length !== 12 || fields[0] !== 'V' ||
          fields[1] !== nativeSchema.rollbackCreateFinalRecordName(settle, authority)) {
        throw new Error('final');
      }
      finalRecord = nativeSchema.buildRollbackCreateFinalRecord(settle, authority);
      if (fields[2] !== finalRecord.finalRecordDigest) throw new Error('final digest');
      finalRecordIdentity = parsePrivateObjectIdentity(
        fields,
        3,
        'rollback-create final identity'
      );
    }
    return nativeSchema.assertRollbackCreateSettleResult({
      schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_SETTLE_RESULT,
      command: nativeSchema.ROLLBACK_CREATE_COMMANDS.DELETE,
      state: header[2],
      operationId: settle.operationId,
      requestDigest,
      finalRecord,
      finalRecordIdentity,
      errorCode: header[6] === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
    }, authority, settle);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native rollback-create settlement is invalid', 'UNKNOWN');
  }
}

function parseRollbackCreateAckResult(stdout, stderr, authority, settle) {
  try {
    const text = nativeSchema.assertRollbackCreateResponseEnvelope(stdout, stderr);
    const lines = text.trimEnd().split('\n');
    if (lines.length !== 2 || lines[0] !== 'P\tOK') throw new Error('bind');
    const fields = lines[1].split('\t');
    const requestDigest = nativeSchema.rollbackCreateRequestDigest(authority);
    const finalRecord = nativeSchema.buildRollbackCreateFinalRecord(settle, authority);
    if (fields.length !== 7 || fields[0] !== 'A' || fields[1] !== 'RESULT' ||
        fields[3] !== settle.operationId || fields[4] !== requestDigest ||
        fields[5] !== finalRecord.finalRecordDigest ||
        !['-', 'UNKNOWN'].includes(fields[6])) throw new Error('header');
    return nativeSchema.assertRollbackCreateAckResult({
      schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_ACK_RESULT,
      command: nativeSchema.ROLLBACK_CREATE_COMMANDS.ACK,
      state: fields[2],
      operationId: settle.operationId,
      requestDigest,
      finalRecordDigest: finalRecord.finalRecordDigest,
      errorCode: fields[6] === 'UNKNOWN' ? 'ROLLBACK_CREATE_UNKNOWN' : null,
    }, authority, settle);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native rollback-create ACK is invalid', 'UNKNOWN');
  }
}

function assertProcessSuccess(result, transactionState) {
  if (!result || result.status !== 0 || result.signal !== null || result.error != null) {
    fail(
      'CHANGES_MANUAL_RECOVERY_REQUIRED',
      'native public Markdown process outcome requires reconciliation',
      transactionState
    );
  }
  return result;
}

function createPublicMarkdownNativeTransport(options = {}) {
  const helperPath = options.helperPath || HELPER_PATH;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function forProject(rawRootPath) {
    const rootPath = canonicalRoot(rawRootPath);
    const binding = boundProject(rootPath);
    const rootBind = nativeSchema.assertRootBind({
      schema: nativeSchema.SCHEMAS.ROOT_BIND,
      canonicalRoot: rootPath,
      expectedRootIdentityDigest: binding.rootIdentityDigest,
      expectedRecoveryIdentityDigest: binding.recoveryIdentityDigest,
    });
    const bindWire = nativeSchema.encodeRootBind(rootBind);

    function invoke(commandWire, heldArtifactFd = null, extraFds = null) {
      let trustedRootFd = null;
      try { trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY); }
      catch (_) { fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'trusted filesystem root is unavailable'); }
      try {
        const stdio = ['pipe', 'pipe', 'pipe', trustedRootFd, heldArtifactFd ?? trustedRootFd];
        if (extraFds !== null) stdio.push(
          extraFds.markerFd,
          extraFds.historyParentFd,
          extraFds.historyFd
        );
        return spawnSync(helperPath, [], {
          input: `${bindWire}${commandWire}`,
          timeout: timeoutMs,
          maxBuffer: extraFds === null
            ? nativeSchema.LIMITS.maxResponseBytes
            : nativeSchema.LIMITS.maxRollbackCreateResponseBytes,
          stdio,
        });
      } catch (_) {
        fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'native public Markdown helper is unavailable');
      } finally {
        try { fs.closeSync(trustedRootFd); } catch (_) {}
      }
    }

    function invokeCreateJournal(commandWire, heldArtifactFd) {
      let trustedRootFd = null;
      try { trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY); }
      catch (_) { fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'trusted filesystem root is unavailable'); }
      try {
        return spawnSync(helperPath, [], {
          input: `${bindWire}${commandWire}`,
          timeout: timeoutMs,
          maxBuffer: nativeSchema.LIMITS.maxCreateJournalResponseBytes,
          stdio: ['pipe', 'pipe', 'pipe', trustedRootFd, heldArtifactFd],
        });
      } catch (_) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native CREATE_MISSING journal is unknown', 'UNKNOWN');
      } finally {
        try { fs.closeSync(trustedRootFd); } catch (_) {}
      }
    }

    function createMissingJournal(
      rawAuthority,
      rawRequest,
      rawValue,
      heldArtifactFd
    ) {
      const authority = nativeSchema.assertCreateJournalAuthority(
        rawAuthority, rawRequest, rawValue
      );
      const token = nativeSchema.buildCreateJournalCommandToken(
        authority, rawRequest, rawValue
      );
      const unknown = () => nativeSchema.assertCreateMissingJournalResponse({
        schema: nativeSchema.SCHEMAS.CREATE_JOURNAL_RESPONSE,
        command: 'CREATE_MISSING',
        state: 'UNKNOWN',
        operationId: authority.request.operationId,
        commandDigest: token.commandDigest,
        publicationResult: null,
        errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
      }, authority, rawRequest, rawValue);
      if (!Number.isInteger(heldArtifactFd) || heldArtifactFd < 0) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'held CREATE_MISSING journal fds are invalid');
      }
      try {
        const result = assertProcessSuccess(invokeCreateJournal(
          nativeSchema.encodeCreateMissingJournalCommand(
            authority, rawRequest, rawValue
          ),
          heldArtifactFd
        ), 'UNKNOWN');
        const prefix = Buffer.from('P\tOK\n');
        if (!Buffer.isBuffer(result.stdout) || result.stdout.length <= prefix.length ||
            !result.stdout.subarray(0, prefix.length).equals(prefix)) return unknown();
        return nativeSchema.parseCreateMissingJournalResponse(
          result.stdout.subarray(prefix.length),
          result.stderr,
          authority,
          rawRequest,
          rawValue
        );
      } catch (_) {
        return unknown();
      }
    }

    function reconcile(rawRequest) {
      const request = nativeSchema.assertCreateRequest(rawRequest);
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeCreateCommand('RECONCILE', request)),
          'UNKNOWN'
        );
        return parseResult(result.stdout, result.stderr, request, 'RECONCILE');
      }
      catch (_) {
        return Object.freeze({
          schema: nativeSchema.SCHEMAS.RESULT,
          command: 'RECONCILE',
          state: 'UNKNOWN',
          operationId: request.operationId,
          artifactDigest: request.artifactDigest,
          precreatePhaseDigest: request.precreatePhaseDigest,
          selectionDigest: request.selectionDigest,
          tokens: Object.freeze([]),
          errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
        });
      }
    }

    function create(rawRequest, heldArtifactFd) {
      const request = nativeSchema.assertCreateRequest(rawRequest);
      if (!Number.isInteger(heldArtifactFd) || heldArtifactFd < 0 ||
          artifactIdentityDigest(heldArtifactFd, request) !== request.artifactIdentityDigest) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'held artifact binding is invalid');
      }
      let primary = null;
      let createAttempted = false;
      try {
        createAttempted = true;
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeCreateCommand('CREATE', request), heldArtifactFd),
          'UNKNOWN'
        );
        primary = parseResult(result.stdout, result.stderr, request, 'CREATE');
      } catch (_) {}
      if (primary && primary.state !== 'UNKNOWN') return primary;
      const truth = reconcile(request);
      if (truth.state === 'UNKNOWN') {
        fail(
          createAttempted ? 'CHANGES_MANUAL_RECOVERY_REQUIRED' : 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE',
          'native create requires exact reconciliation',
          createAttempted ? 'UNKNOWN' : null
        );
      }
      return truth;
    }

    function finalizeCreate(rawFinalizeRequest, rawCreateRequest) {
      const createRequest = nativeSchema.assertCreateRequest(rawCreateRequest);
      const finalizeRequest = nativeSchema.assertFinalizeRequest(rawFinalizeRequest, createRequest);
      const command = nativeSchema.encodeFinalizeCommand(finalizeRequest, createRequest);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = assertProcessSuccess(invoke(command), 'COMMITTED');
          return parseFinalAck(result.stdout, result.stderr, finalizeRequest, createRequest);
        } catch (_) {}
      }
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK requires reconciliation', 'COMMITTED');
    }

    function reconcileFinalize(rawFinalizeRequest, rawCreateRequest) {
      const createRequest = nativeSchema.assertCreateRequest(rawCreateRequest);
      const finalizeRequest = nativeSchema.assertFinalizeRequest(rawFinalizeRequest, createRequest);
      const finalName = nativeSchema.finalRecordName(finalizeRequest, createRequest);
      const finalPath = path.join(rootPath, '.writcraft', 'recovery', finalName);
      let fd;
      try {
        fd = fs.openSync(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || Number(stat.uid) !== process.geteuid() ||
            Number(stat.mode & 0o777n) !== 0o600 || stat.size < 1n || stat.size > 4096n) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK authority is foreign', 'COMMITTED');
        }
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (error instanceof PublicMarkdownNativeLifecycleError) throw error;
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native final ACK requires reconciliation', 'COMMITTED');
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
      }
      return finalizeCreate(finalizeRequest, createRequest);
    }

    function unknownCreateCleanup(rawAuthority, command) {
      const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
      return nativeSchema.assertCreateCleanupResult({
        schema: nativeSchema.SCHEMAS.CREATE_CLEANUP_RESULT,
        command,
        state: 'UNKNOWN',
        operationId: authority.operationId,
        authorityDigest: authority.authorityDigest,
        items: [],
        errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
      }, authority, command);
    }

    function invokeCreateCleanup(rawAuthority, command) {
      const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeCreateCleanupCommand(command, authority)),
          command === nativeSchema.CREATE_CLEANUP_COMMANDS.ACK ? 'ACK_PREPARED' : 'COMMITTED'
        );
        return nativeSchema.parseCreateCleanupResult(
          result.stdout,
          result.stderr,
          authority,
          command
        );
      } catch (_) {
        return unknownCreateCleanup(authority, command);
      }
    }

    function reconcileCreateCleanup(rawAuthority) {
      return invokeCreateCleanup(
        rawAuthority,
        nativeSchema.CREATE_CLEANUP_COMMANDS.RECONCILE
      );
    }

    function cleanupCreate(rawAuthority) {
      const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
      const direct = invokeCreateCleanup(
        authority,
        nativeSchema.CREATE_CLEANUP_COMMANDS.CLEANUP
      );
      if (direct.state === 'COMMITTED') return direct;
      const reconciled = reconcileCreateCleanup(authority);
      return reconciled.state === 'COMMITTED' ? reconciled : direct;
    }

    function ackCreateCleanup(rawAuthority) {
      const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
      let result = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        result = invokeCreateCleanup(
          authority,
          nativeSchema.CREATE_CLEANUP_COMMANDS.ACK
        );
        if (result.state === 'ACKED') return result;
      }
      return result || unknownCreateCleanup(
        authority,
        nativeSchema.CREATE_CLEANUP_COMMANDS.ACK
      );
    }

    function undoAuthority(rawAuthority, heldArtifactFd) {
      const authority = nativeSchema.assertUndoAuthority(rawAuthority);
      if (authority.rootBind.canonicalRoot !== rootBind.canonicalRoot ||
          authority.rootBind.expectedRootIdentityDigest !== rootBind.expectedRootIdentityDigest ||
          authority.rootBind.expectedRecoveryIdentityDigest !==
            rootBind.expectedRecoveryIdentityDigest) {
        fail('PUBLIC_MARKDOWN_AUTHORITY_CONFLICT', 'Safe Undo project authority drifted');
      }
      if (!Number.isInteger(heldArtifactFd) || heldArtifactFd < 0 ||
          artifactIdentityDigest(heldArtifactFd, authority.request) !==
            authority.request.artifactIdentityDigest) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'Safe Undo held artifact binding is invalid');
      }
      return authority;
    }

    function unknownUndoResult(authority, command) {
      const request = authority.request;
      return Object.freeze({
        schema: nativeSchema.SCHEMAS.UNDO_RESULT,
        command,
        state: 'UNKNOWN',
        operationId: request.operationId,
        artifactDigest: request.artifactDigest,
        precreatePhaseDigest: request.precreatePhaseDigest,
        selectionDigest: request.selectionDigest,
        preparedHistoryDigest: request.preparedHistoryDigest,
        tokens: Object.freeze([]),
        errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
      });
    }

    function reconcileUndo(rawAuthority, heldArtifactFd) {
      const authority = undoAuthority(rawAuthority, heldArtifactFd);
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeUndoCommand('RECONCILE_UNDO', authority), heldArtifactFd),
          'UNKNOWN'
        );
        return parseUndoResult(result.stdout, result.stderr, authority, 'RECONCILE_UNDO');
      } catch (_) {
        return unknownUndoResult(authority, 'RECONCILE_UNDO');
      }
    }

    function quarantine(rawAuthority, heldArtifactFd) {
      const authority = undoAuthority(rawAuthority, heldArtifactFd);
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeUndoCommand('QUARANTINE', authority), heldArtifactFd),
          'UNKNOWN'
        );
        const primary = parseUndoResult(result.stdout, result.stderr, authority, 'QUARANTINE');
        if (primary.state !== 'UNKNOWN') return primary;
      } catch (_) {}
      const truth = reconcileUndo(authority, heldArtifactFd);
      if (truth.state === 'UNKNOWN') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo requires exact reconciliation', 'UNKNOWN');
      }
      return truth;
    }

    function settleUndo(rawSettle, rawAuthority, heldArtifactFd, expectedCommand) {
      const authority = undoAuthority(rawAuthority, heldArtifactFd);
      const settle = nativeSchema.assertUndoSettleRequest(
        rawSettle,
        authority,
        expectedCommand
      );
      const wire = nativeSchema.encodeUndoSettleCommand(settle, authority, expectedCommand);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = assertProcessSuccess(invoke(wire, heldArtifactFd), 'UNKNOWN');
          const truth = parseUndoSettleResult(
            result.stdout,
            result.stderr,
            settle,
            authority,
            expectedCommand
          );
          return truth;
        } catch (_) {}
      }
      return Object.freeze({
        schema: nativeSchema.SCHEMAS.UNDO_SETTLE_RESULT,
        command: expectedCommand,
        state: 'UNKNOWN',
        operationId: settle.operationId,
        finalRecord: null,
        finalRecordIdentity: null,
        errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
      });
    }

    function restoreQuarantine(rawSettle, rawAuthority, heldArtifactFd) {
      return settleUndo(
        rawSettle,
        rawAuthority,
        heldArtifactFd,
        'RESTORE_QUARANTINE'
      );
    }

    function finalizeUndo(rawSettle, rawAuthority, heldArtifactFd) {
      return settleUndo(rawSettle, rawAuthority, heldArtifactFd, 'FINALIZE_UNDO');
    }

    function ackUndo(
      rawAck,
      rawSettle,
      rawFinalRecord,
      rawFinalRecordIdentity,
      rawAuthority,
      heldArtifactFd,
      expectedCommand
    ) {
      const authority = undoAuthority(rawAuthority, heldArtifactFd);
      const settle = nativeSchema.assertUndoSettleRequest(
        rawSettle,
        authority,
        expectedCommand
      );
      const finalRecord = nativeSchema.assertUndoFinalRecord(
        rawFinalRecord,
        settle,
        authority,
        expectedCommand
      );
      const ack = nativeSchema.assertUndoAckRequest(
        rawAck,
        settle,
        finalRecord,
        rawFinalRecordIdentity,
        authority,
        expectedCommand
      );
      const wire = nativeSchema.encodeUndoAckCommand(
        ack,
        settle,
        finalRecord,
        rawFinalRecordIdentity,
        authority,
        expectedCommand
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = assertProcessSuccess(invoke(wire, heldArtifactFd), 'UNKNOWN');
          const truth = parseUndoAckResult(
            result.stdout,
            result.stderr,
            ack,
            settle,
            finalRecord,
            rawFinalRecordIdentity,
            authority,
            expectedCommand
          );
          return truth;
        } catch (_) {}
      }
      return Object.freeze({
        schema: nativeSchema.SCHEMAS.UNDO_ACK_RESULT,
        command: expectedCommand,
        state: 'UNKNOWN',
        operationId: ack.operationId,
        finalRecordDigest: ack.finalRecordDigest,
        errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
      });
    }

    function rollbackCreateAuthority(rawAuthority, rawDescriptors) {
      const authority = nativeSchema.assertRollbackCreateAuthority(rawAuthority);
      if (authority.rootBind.canonicalRoot !== rootBind.canonicalRoot ||
          authority.rootBind.expectedRootIdentityDigest !== rootBind.expectedRootIdentityDigest ||
          authority.rootBind.expectedRecoveryIdentityDigest !==
            rootBind.expectedRecoveryIdentityDigest) {
        fail('PUBLIC_MARKDOWN_AUTHORITY_CONFLICT', 'rollback-create project authority drifted');
      }
      const descriptors = descriptorValues(rawDescriptors, [
        'artifactFd', 'markerFd', 'historyParentFd', 'historyFd',
      ], 'rollback-create held descriptors');
      if (Object.values(descriptors).some(fd => !Number.isInteger(fd) || fd < 0) ||
          artifactIdentityDigest(descriptors.artifactFd, authority.request) !==
            authority.request.artifactIdentityDigest) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'rollback-create held descriptor binding is invalid');
      }
      return Object.freeze({ authority, descriptors: Object.freeze({ ...descriptors }) });
    }

    function existingRestoreAuthority(rawAuthority, rawDescriptors) {
      const authority = existingRestoreSchema.assertAuthority(rawAuthority);
      const descriptors = descriptorValues(rawDescriptors, [
        'artifactFd', 'markerFd', 'historyParentFd', 'historyFd',
      ], 'existing restore held descriptors');
      if (Object.values(descriptors).some(fd => !Number.isInteger(fd) || fd < 0) ||
          artifactIdentityDigest(descriptors.artifactFd, authority.request) !==
            authority.request.artifactIdentityDigest) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL',
          'existing restore held descriptor binding is invalid');
      }
      return Object.freeze({ authority, descriptors: Object.freeze({ ...descriptors }) });
    }

    function unknownExistingRunResult(authority, command) {
      return existingRestoreSchema.buildRunResult(
        authority,
        command,
        'UNKNOWN'
      );
    }

    function unknownExistingVerifyResult(authority) {
      return existingRestoreSchema.buildVerifyResult(authority, 'UNKNOWN');
    }

    function unknownExistingFinalizeResult(authority, finalizeRequest) {
      return existingRestoreSchema.buildFinalResult(
        authority,
        finalizeRequest,
        'UNKNOWN'
      );
    }

    function unknownExistingAckResult(authority, finalizeRequest) {
      return existingRestoreSchema.buildAckResult(authority, finalizeRequest, 'UNKNOWN');
    }

    function invokeExisting(commandWire, descriptors) {
      return invoke(
        commandWire,
        descriptors.artifactFd,
        descriptors
      );
    }

    function executeExisting(rawAuthority, rawDescriptors) {
      const value = existingRestoreAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      try {
        const result = assertProcessSuccess(
          invokeExisting(existingRestoreSchema.encodeExecuteCommand(authority), descriptors),
          'UNKNOWN'
        );
        return existingRestoreSchema.parseRunResponse(
          result.stdout, authority, existingRestoreSchema.COMMANDS.EXECUTE
        );
      } catch (_) {
        return unknownExistingRunResult(authority, existingRestoreSchema.COMMANDS.EXECUTE);
      }
    }

    function reconcileExisting(rawAuthority, rawDescriptors) {
      const value = existingRestoreAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      try {
        const result = assertProcessSuccess(
          invokeExisting(existingRestoreSchema.encodeReconcileCommand(authority), descriptors),
          'UNKNOWN'
        );
        return existingRestoreSchema.parseRunResponse(
          result.stdout, authority, existingRestoreSchema.COMMANDS.RECONCILE
        );
      } catch (_) {
        return unknownExistingRunResult(authority, existingRestoreSchema.COMMANDS.RECONCILE);
      }
    }

    function verifyExisting(rawAuthority, rawTerminalReceipt, rawDescriptors) {
      const value = existingRestoreAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const request = existingRestoreSchema.buildVerifyRequest(authority, rawTerminalReceipt);
      try {
        const result = assertProcessSuccess(
          invokeExisting(existingRestoreSchema.encodeVerifyCommand(authority, rawTerminalReceipt), descriptors),
          'UNKNOWN'
        );
        existingRestoreSchema.assertResponseEnvelope(result.stdout, result.stderr);
        return unknownExistingVerifyResult(authority);
      } catch (_) {
        return unknownExistingVerifyResult(authority);
      }
    }

    function finalizeExisting(rawAuthority, rawTerminalReceipt, rawDescriptors) {
      const value = existingRestoreAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const request = existingRestoreSchema.buildFinalizeRequest(authority, rawTerminalReceipt);
      try {
        const result = assertProcessSuccess(
          invokeExisting(existingRestoreSchema.encodeFinalizeCommand(authority, rawTerminalReceipt), descriptors),
          'UNKNOWN'
        );
        existingRestoreSchema.assertResponseEnvelope(result.stdout, result.stderr);
        return unknownExistingFinalizeResult(authority, request);
      } catch (_) {
        return unknownExistingFinalizeResult(authority, request);
      }
    }

    function reconcileFinalizeExisting(rawAuthority, rawTerminalReceipt, rawDescriptors) {
      return finalizeExisting(rawAuthority, rawTerminalReceipt, rawDescriptors);
    }

    function ackExisting(
      rawAuthority,
      rawFinalizeRequest,
      rawFinalRecordIdentity,
      markerPhaseDigest,
      rawDescriptors
    ) {
      const value = existingRestoreAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const request = existingRestoreSchema.buildAckRequest(
        authority,
        rawFinalizeRequest,
        rawFinalRecordIdentity,
        markerPhaseDigest
      );
      try {
        const result = assertProcessSuccess(
          invokeExisting(
            existingRestoreSchema.encodeAckCommand(
              request,
              authority,
              rawFinalizeRequest,
              markerPhaseDigest
            ),
            descriptors
          ),
          'UNKNOWN'
        );
        existingRestoreSchema.assertResponseEnvelope(result.stdout, result.stderr);
        return unknownExistingAckResult(authority, rawFinalizeRequest);
      } catch (_) {
        return unknownExistingAckResult(authority, rawFinalizeRequest);
      }
    }

    function unknownRollbackCreateResult(authority, command) {
      return Object.freeze({
        schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_RESULT,
        command,
        state: 'UNKNOWN',
        operationId: authority.request.operationId,
        requestDigest: nativeSchema.rollbackCreateRequestDigest(authority),
        tokens: Object.freeze([]),
        errorCode: 'ROLLBACK_CREATE_UNKNOWN',
      });
    }

    function reconcileCreateRollback(rawAuthority, rawDescriptors) {
      const value = rollbackCreateAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const command = nativeSchema.ROLLBACK_CREATE_COMMANDS.RECONCILE;
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeRollbackCreateCommand(command, authority),
            descriptors.artifactFd, descriptors),
          'UNKNOWN'
        );
        return parseRollbackCreateResult(result.stdout, result.stderr, authority, command);
      } catch (_) {
        return unknownRollbackCreateResult(authority, command);
      }
    }

    function quarantineCreateRollback(rawAuthority, rawDescriptors) {
      const value = rollbackCreateAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const command = nativeSchema.ROLLBACK_CREATE_COMMANDS.QUARANTINE;
      try {
        const result = assertProcessSuccess(
          invoke(nativeSchema.encodeRollbackCreateCommand(command, authority),
            descriptors.artifactFd, descriptors),
          'UNKNOWN'
        );
        const primary = parseRollbackCreateResult(
          result.stdout,
          result.stderr,
          authority,
          command
        );
        if (primary.state !== 'UNKNOWN') return primary;
      } catch (_) {}
      const truth = reconcileCreateRollback(authority, descriptors);
      if (truth.state === 'UNKNOWN') {
        fail(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'rollback-create requires exact reconciliation',
          'UNKNOWN'
        );
      }
      return truth;
    }

    function deleteCreateRollback(rawSettle, rawAuthority, rawDescriptors) {
      const value = rollbackCreateAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const settle = nativeSchema.assertRollbackCreateSettleRequest(rawSettle, authority);
      const wire = nativeSchema.encodeRollbackCreateSettleCommand(authority, settle);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = assertProcessSuccess(
            invoke(wire, descriptors.artifactFd, descriptors),
            'UNKNOWN'
          );
          return parseRollbackCreateSettleResult(
            result.stdout,
            result.stderr,
            authority,
            settle
          );
        } catch (_) {}
      }
      return Object.freeze({
        schema: nativeSchema.SCHEMAS.ROLLBACK_CREATE_SETTLE_RESULT,
        command: nativeSchema.ROLLBACK_CREATE_COMMANDS.DELETE,
        state: 'UNKNOWN',
        operationId: settle.operationId,
        requestDigest: nativeSchema.rollbackCreateRequestDigest(authority),
        finalRecord: null,
        finalRecordIdentity: null,
        errorCode: 'ROLLBACK_CREATE_UNKNOWN',
      });
    }

    function ackCreateRollback(
      rawAck,
      rawSettle,
      rawRolledBackPhase,
      rawAuthority,
      rawDescriptors
    ) {
      const value = rollbackCreateAuthority(rawAuthority, rawDescriptors);
      const { authority, descriptors } = value;
      const settle = nativeSchema.assertRollbackCreateSettleRequest(rawSettle, authority);
      const ack = nativeSchema.assertRollbackCreateAckRequest(
        rawAck,
        authority,
        settle,
        rawRolledBackPhase
      );
      const wire = nativeSchema.encodeRollbackCreateAckCommand(
        ack,
        authority,
        settle,
        rawRolledBackPhase
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = assertProcessSuccess(
            invoke(wire, descriptors.artifactFd, descriptors),
            'UNKNOWN'
          );
          return parseRollbackCreateAckResult(
            result.stdout,
            result.stderr,
            authority,
            settle
          );
        } catch (_) {}
      }
      return nativeSchema.buildRollbackCreateAckResult(
        authority,
        settle,
        'UNKNOWN'
      );
    }

    return Object.freeze({
      schema: 'writcraft.changes-history-native-create-lifecycle-scoped/v1',
      createMissingJournal,
      create,
      reconcile,
      finalizeCreate,
      reconcileFinalize,
      cleanupCreate,
      reconcileCreateCleanup,
      ackCreateCleanup,
      quarantine,
      reconcileUndo,
      restoreQuarantine,
      finalizeUndo,
      ackUndo,
      quarantineCreateRollback,
      reconcileCreateRollback,
      deleteCreateRollback,
      ackCreateRollback,
      executeExisting,
      reconcileExisting,
      verifyExisting,
      finalizeExisting,
      reconcileFinalizeExisting,
      ackExisting,
    });
  }

  return Object.freeze({
    schema: 'writcraft.changes-history-native-create-lifecycle/v1',
    forProject,
  });
}

function descriptorValues(raw, keys, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== keys.length || ownKeys.some(key =>
    typeof key !== 'string' || !keys.includes(key))) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function descriptorArray(raw, expectedLength, label) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (descriptors.length?.value !== expectedLength ||
      Reflect.ownKeys(raw).length !== expectedLength + 1) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
  }
  return Array.from({ length: expectedLength }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', `${label} is invalid`);
    }
    return descriptor.value;
  });
}

function descriptorMethod(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const descriptor = Object.getOwnPropertyDescriptor(raw, name);
  if (!descriptor || descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
      Object.hasOwn(descriptor, 'set') || typeof descriptor.value !== 'function') return null;
  return descriptor.value;
}

function validatePublicCreateRequest(raw, expectedLength = null) {
  const value = descriptorValues(raw, [
    'schema', 'operationId', 'projectId', 'artifactDigest', 'selectionDigest', 'items',
  ], 'public create request');
  let projectId;
  try {
    projectId = evidenceSchema.assertString(value.projectId, 'projectId', {
      minBytes: 1,
      maxBytes: 256,
    });
  } catch (_) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create project authority is invalid');
  }
  if (value.schema !== PUBLIC_CREATE_REQUEST_SCHEMA ||
      !/^chr_[a-f0-9]{48}$/u.test(value.operationId || '') ||
      projectId !== projectId.normalize('NFC') ||
      !DIGEST_RE.test(value.artifactDigest || '') ||
      !DIGEST_RE.test(value.selectionDigest || '')) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create request authority is invalid');
  }
  const length = expectedLength === null
    ? (() => {
      if (!Array.isArray(value.items)) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create items are invalid');
      }
      return value.items.length;
    })()
    : expectedLength;
  if (length < 1 || length > nativeSchema.LIMITS.maxItems) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create item count is invalid');
  }
  const items = descriptorArray(value.items, length, 'public create request.items')
    .map((rawItem, index) => {
      const item = descriptorValues(rawItem, [
        'selectedId', 'path', 'afterRevision', 'ancestorIdentityDigest', 'bytes',
      ], `public create request.items[${index}]`);
      if (!Buffer.isBuffer(item.bytes) || item.bytes.length < 1 ||
          !/^[a-f0-9]{64}$/u.test(item.afterRevision || '') ||
          !DIGEST_RE.test(item.ancestorIdentityDigest || '')) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create item authority is invalid');
      }
      return Object.freeze({ ...item });
    });
  return Object.freeze({
    schema: PUBLIC_CREATE_REQUEST_SCHEMA,
    operationId: value.operationId,
    projectId,
    artifactDigest: value.artifactDigest,
    selectionDigest: value.selectionDigest,
    items: Object.freeze(items),
  });
}

function createAuthorityPair(rawPublicRequest, rawNativeRequest) {
  const nativeRequest = nativeSchema.assertCreateRequest(rawNativeRequest);
  const publicRequest = validatePublicCreateRequest(rawPublicRequest, nativeRequest.items.length);
  if (publicRequest.operationId !== nativeRequest.operationId ||
      publicRequest.artifactDigest !== nativeRequest.artifactDigest ||
      publicRequest.selectionDigest !== nativeRequest.selectionDigest) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public/native create authority drifted');
  }
  for (let index = 0; index < nativeRequest.items.length; index += 1) {
    const publicItem = publicRequest.items[index];
    const nativeItem = nativeRequest.items[index];
    const contentDigest = `sha256:${crypto.createHash('sha256').update(publicItem.bytes).digest('hex')}`;
    if (publicItem.selectedId !== nativeItem.selectedId ||
        publicItem.path !== nativeItem.path ||
        publicItem.afterRevision !== nativeItem.contentDigest.slice(7) ||
        publicItem.ancestorIdentityDigest !== nativeItem.ancestorIdentityDigest ||
        publicItem.bytes.length !== nativeItem.byteLength || contentDigest !== nativeItem.contentDigest) {
      fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public/native create item drifted');
    }
  }
  return Object.freeze({ publicRequest, nativeRequest });
}

function publicCreateReceipt(pair, privateResult, expectedCommands) {
  let result = null;
  for (const command of expectedCommands) {
    try {
      result = nativeSchema.assertResult(privateResult, pair.nativeRequest, command);
      break;
    } catch (_) {}
  }
  if (result === null) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native create result command is invalid', 'UNKNOWN');
  }
  if (result.state === 'UNKNOWN') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native create authority is unknown', 'UNKNOWN');
  }
  const created = result.state === 'COMMITTED';
  return Object.freeze({
    schema: PUBLIC_CREATE_RECEIPT_SCHEMA,
    status: created ? 'CREATED' : 'ABSENT',
    operationId: pair.publicRequest.operationId,
    projectId: pair.publicRequest.projectId,
    artifactDigest: pair.publicRequest.artifactDigest,
    selectionDigest: pair.publicRequest.selectionDigest,
    items: Object.freeze(created ? pair.publicRequest.items.map((item, index) => Object.freeze({
      selectedId: item.selectedId,
      path: item.path,
      afterRevision: item.afterRevision,
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      contentDigest: result.tokens[index].contentDigest,
      createdIdentityDigest: result.tokens[index].createdIdentityDigest,
      creationReceiptDigest: result.tokens[index].receiptDigest,
    })) : []),
  });
}

function assertPublicCreateReceipt(raw, pair) {
  const value = descriptorValues(raw, [
    'schema', 'status', 'operationId', 'projectId', 'artifactDigest',
    'selectionDigest', 'items',
  ], 'public create receipt');
  if (value.schema !== PUBLIC_CREATE_RECEIPT_SCHEMA ||
      !['ABSENT', 'CREATED'].includes(value.status) ||
      value.operationId !== pair.publicRequest.operationId ||
      value.projectId !== pair.publicRequest.projectId ||
      value.artifactDigest !== pair.publicRequest.artifactDigest ||
      value.selectionDigest !== pair.publicRequest.selectionDigest) {
    fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create receipt authority is invalid');
  }
  const length = value.status === 'CREATED' ? pair.publicRequest.items.length : 0;
  const items = descriptorArray(value.items, length, 'public create receipt.items').map(
    (rawItem, index) => {
      const item = descriptorValues(rawItem, [
        'selectedId', 'path', 'afterRevision', 'ancestorIdentityDigest', 'contentDigest',
        'createdIdentityDigest', 'creationReceiptDigest',
      ], `public create receipt.items[${index}]`);
      const expected = pair.publicRequest.items[index];
      if (!expected || item.selectedId !== expected.selectedId || item.path !== expected.path ||
          item.afterRevision !== expected.afterRevision ||
          item.ancestorIdentityDigest !== expected.ancestorIdentityDigest ||
          item.contentDigest !== `sha256:${expected.afterRevision}` ||
          !DIGEST_RE.test(item.createdIdentityDigest || '') ||
          !DIGEST_RE.test(item.creationReceiptDigest || '')) {
        fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'public create receipt item is invalid');
      }
      return Object.freeze({ ...item });
    }
  );
  return Object.freeze({ ...value, items: Object.freeze(items) });
}

function publicFinalizeEnvelope(pair, finalizeRequest, privateAck) {
  const ack = privateAck === null
    ? null
    : nativeSchema.assertFinalAck(privateAck, finalizeRequest, pair.nativeRequest);
  const authorityDigest = evidenceSchema.digestObject(finalizeRequest.schema, finalizeRequest);
  return Object.freeze({
    schema: PUBLIC_FINALIZE_ACK_SCHEMA,
    status: ack === null ? 'ABSENT' : 'FINALIZED',
    operationId: finalizeRequest.operationId,
    projectId: pair.publicRequest.projectId,
    authorityDigest,
    receiptName: ack === null
      ? null
      : nativeSchema.finalRecordName(finalizeRequest, pair.nativeRequest),
    finalReceiptDigest: ack === null ? null : ack.finalAckDigest,
  });
}

function createPublicMarkdownNativeLifecycle(options = {}) {
  const transport = options.transportLifecycle || createPublicMarkdownNativeTransport(options);
  return Object.freeze({
    schema: 'writcraft.changes-history-public-markdown-lifecycle/v1',
    forProject(rootPath) {
      const factory = descriptorMethod(transport, 'forProject');
      const rawScoped = factory
        ? factory(rootPath)
        : transport;
      const scoped = Object.freeze({
        create: descriptorMethod(rawScoped, 'create'),
        createMissingJournal: descriptorMethod(rawScoped, 'createMissingJournal'),
        reconcile: descriptorMethod(rawScoped, 'reconcile'),
        finalizeCreate: descriptorMethod(rawScoped, 'finalizeCreate'),
        reconcileFinalize: descriptorMethod(rawScoped, 'reconcileFinalize'),
        cleanupCreate: descriptorMethod(rawScoped, 'cleanupCreate'),
        reconcileCreateCleanup: descriptorMethod(rawScoped, 'reconcileCreateCleanup'),
        ackCreateCleanup: descriptorMethod(rawScoped, 'ackCreateCleanup'),
        quarantine: descriptorMethod(rawScoped, 'quarantine'),
        reconcileUndo: descriptorMethod(rawScoped, 'reconcileUndo'),
        restoreQuarantine: descriptorMethod(rawScoped, 'restoreQuarantine'),
        finalizeUndo: descriptorMethod(rawScoped, 'finalizeUndo'),
        ackUndo: descriptorMethod(rawScoped, 'ackUndo'),
      });
      const existingRestore = Object.freeze({
        execute: descriptorMethod(rawScoped, 'executeExisting'),
        reconcile: descriptorMethod(rawScoped, 'reconcileExisting'),
        verify: descriptorMethod(rawScoped, 'verifyExisting'),
        finalize: descriptorMethod(rawScoped, 'finalizeExisting'),
        reconcileFinalize: descriptorMethod(rawScoped, 'reconcileFinalizeExisting'),
        ack: descriptorMethod(rawScoped, 'ackExisting'),
      });
      if (Object.values(scoped).some(value => value === null)) {
        fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'native public Markdown transport is unavailable');
      }
      if (Object.values(existingRestore).some(value => value === null)) {
        fail('PUBLIC_MARKDOWN_EXISTING_LIFECYCLE_UNAVAILABLE',
          'native existing Markdown transport is unavailable');
      }
      const requireHeld = (fd, nativeRequest) => {
        if (!Number.isInteger(fd) || fd < 0 ||
            artifactIdentityDigest(fd, nativeRequest) !== nativeRequest.artifactIdentityDigest) {
          fail('PUBLIC_MARKDOWN_NATIVE_PROTOCOL', 'held artifact binding is invalid');
        }
      };
      const reconcile = (rawPublic, rawNative, heldFd) => {
        const pair = createAuthorityPair(rawPublic, rawNative);
        requireHeld(heldFd, pair.nativeRequest);
        return publicCreateReceipt(pair, scoped.reconcile(pair.nativeRequest), ['RECONCILE']);
      };
      const create = (rawPublic, rawNative, heldFd) => {
        const pair = createAuthorityPair(rawPublic, rawNative);
        requireHeld(heldFd, pair.nativeRequest);
        return publicCreateReceipt(
          pair,
          scoped.create(pair.nativeRequest, heldFd),
          ['CREATE', 'RECONCILE']
        );
      };
      const verifyCreate = (rawPublic, rawNative, heldFd, rawCandidate) => {
        const pair = createAuthorityPair(rawPublic, rawNative);
        requireHeld(heldFd, pair.nativeRequest);
        const candidate = assertPublicCreateReceipt(rawCandidate, pair);
        const truth = publicCreateReceipt(
          pair,
          scoped.reconcile(pair.nativeRequest),
          ['RECONCILE']
        );
        if (JSON.stringify(candidate) !== JSON.stringify(truth)) {
          fail('PUBLIC_MARKDOWN_AUTHORITY_CONFLICT', 'public create receipt is stale');
        }
        return truth;
      };
      const finalizePair = (rawFinalize, rawNative, rawPublic) => {
        const pair = createAuthorityPair(rawPublic, rawNative);
        const finalizeRequest = nativeSchema.assertFinalizeRequest(rawFinalize, pair.nativeRequest);
        return Object.freeze({ pair, finalizeRequest });
      };
      const undoPair = (rawAuthority, heldFd) => {
        const authority = nativeSchema.assertUndoAuthority(rawAuthority);
        requireHeld(heldFd, authority.request);
        return authority;
      };
      const settlePair = (rawSettle, rawAuthority, heldFd, expectedCommand) => {
        const authority = undoPair(rawAuthority, heldFd);
        const settle = nativeSchema.assertUndoSettleRequest(
          rawSettle,
          authority,
          expectedCommand
        );
        return Object.freeze({ authority, settle });
      };
      return Object.freeze({
        schema: 'writcraft.changes-history-public-markdown-lifecycle-scoped/v1',
        existingRestore: Object.freeze({
          execute(rawAuthority, rawDescriptors) {
            const authority = existingRestoreSchema.assertAuthority(rawAuthority);
            return existingRestoreSchema.assertRunResult(
              existingRestore.execute(authority, rawDescriptors),
              authority,
              existingRestoreSchema.COMMANDS.EXECUTE
            );
          },
          reconcile(rawAuthority, rawDescriptors) {
            const authority = existingRestoreSchema.assertAuthority(rawAuthority);
            return existingRestoreSchema.assertRunResult(
              existingRestore.reconcile(authority, rawDescriptors),
              authority,
              existingRestoreSchema.COMMANDS.RECONCILE
            );
          },
          verify(rawAuthority, rawTerminalReceipt, rawDescriptors) {
            const authority = existingRestoreSchema.assertAuthority(rawAuthority);
            const terminal = existingRestoreSchema.assertTerminalReceipt(
              rawTerminalReceipt,
              authority
            );
            return existingRestoreSchema.assertVerifyResult(
              existingRestore.verify(authority, terminal, rawDescriptors),
              authority,
              terminal
            );
          },
          finalize(rawAuthority, rawTerminalReceipt, rawDescriptors) {
            const authority = existingRestoreSchema.assertAuthority(rawAuthority);
            const terminal = existingRestoreSchema.assertTerminalReceipt(
              rawTerminalReceipt,
              authority
            );
            const finalizeRequest = existingRestoreSchema.buildFinalizeRequest(
              authority,
              terminal
            );
            return existingRestoreSchema.assertFinalResult(
              existingRestore.finalize(authority, terminal, rawDescriptors),
              authority,
              finalizeRequest
            );
          },
          reconcileFinalize(rawAuthority, rawTerminalReceipt, rawDescriptors) {
            const authority = existingRestoreSchema.assertAuthority(rawAuthority);
            const terminal = existingRestoreSchema.assertTerminalReceipt(
              rawTerminalReceipt,
              authority
            );
            const finalizeRequest = existingRestoreSchema.buildFinalizeRequest(
              authority,
              terminal
            );
            return existingRestoreSchema.assertFinalResult(
              existingRestore.reconcileFinalize(authority, terminal, rawDescriptors),
              authority,
              finalizeRequest
            );
          },
          ack: existingRestore.ack,
        }),
        create,
        createMissingJournal(rawAuthority, rawRequest, rawValue, heldArtifactFd) {
          return scoped.createMissingJournal(
            rawAuthority,
            rawRequest,
            rawValue,
            heldArtifactFd
          );
        },
        reconcile,
        verifyCreate,
        finalizeCreate(rawFinalize, rawNative, rawPublic) {
          const value = finalizePair(rawFinalize, rawNative, rawPublic);
          const ack = scoped.finalizeCreate(value.finalizeRequest, value.pair.nativeRequest);
          return publicFinalizeEnvelope(value.pair, value.finalizeRequest, ack);
        },
        reconcileFinalize(rawFinalize, rawNative, rawPublic) {
          const value = finalizePair(rawFinalize, rawNative, rawPublic);
          const ack = scoped.reconcileFinalize(value.finalizeRequest, value.pair.nativeRequest);
          return publicFinalizeEnvelope(value.pair, value.finalizeRequest, ack);
        },
        cleanupCreate(rawAuthority) {
          const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
          return nativeSchema.assertCreateCleanupResult(
            scoped.cleanupCreate(authority),
            authority,
            nativeSchema.CREATE_CLEANUP_COMMANDS.CLEANUP
          );
        },
        reconcileCreateCleanup(rawAuthority) {
          const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
          return nativeSchema.assertCreateCleanupResult(
            scoped.reconcileCreateCleanup(authority),
            authority,
            nativeSchema.CREATE_CLEANUP_COMMANDS.RECONCILE
          );
        },
        ackCreateCleanup(rawAuthority) {
          const authority = nativeSchema.assertCreateCleanupAuthority(rawAuthority);
          return nativeSchema.assertCreateCleanupResult(
            scoped.ackCreateCleanup(authority),
            authority,
            nativeSchema.CREATE_CLEANUP_COMMANDS.ACK
          );
        },
        quarantine(rawAuthority, heldFd) {
          const authority = undoPair(rawAuthority, heldFd);
          const rawResult = scoped.quarantine(authority, heldFd);
          try {
            return nativeSchema.assertUndoResult(rawResult, authority, 'QUARANTINE');
          } catch (primaryError) {
            try {
              return nativeSchema.assertUndoResult(
                rawResult,
                authority,
                'RECONCILE_UNDO'
              );
            } catch (_) {
              throw primaryError;
            }
          }
        },
        reconcileUndo(rawAuthority, heldFd) {
          const authority = undoPair(rawAuthority, heldFd);
          return nativeSchema.assertUndoResult(
            scoped.reconcileUndo(authority, heldFd),
            authority,
            'RECONCILE_UNDO'
          );
        },
        restoreQuarantine(rawSettle, rawAuthority, heldFd) {
          const value = settlePair(
            rawSettle,
            rawAuthority,
            heldFd,
            'RESTORE_QUARANTINE'
          );
          return nativeSchema.assertUndoSettleResult(
            scoped.restoreQuarantine(value.settle, value.authority, heldFd),
            value.settle,
            value.authority,
            'RESTORE_QUARANTINE'
          );
        },
        finalizeUndo(rawSettle, rawAuthority, heldFd) {
          const value = settlePair(rawSettle, rawAuthority, heldFd, 'FINALIZE_UNDO');
          return nativeSchema.assertUndoSettleResult(
            scoped.finalizeUndo(value.settle, value.authority, heldFd),
            value.settle,
            value.authority,
            'FINALIZE_UNDO'
          );
        },
        ackUndo(
          rawAck,
          rawSettle,
          rawFinalRecord,
          rawFinalRecordIdentity,
          rawAuthority,
          heldFd,
          expectedCommand
        ) {
          const value = settlePair(rawSettle, rawAuthority, heldFd, expectedCommand);
          const finalRecord = nativeSchema.assertUndoFinalRecord(
            rawFinalRecord,
            value.settle,
            value.authority,
            expectedCommand
          );
          const ack = nativeSchema.assertUndoAckRequest(
            rawAck,
            value.settle,
            finalRecord,
            rawFinalRecordIdentity,
            value.authority,
            expectedCommand
          );
          return nativeSchema.assertUndoAckResult(
            scoped.ackUndo(
              ack,
              value.settle,
              finalRecord,
              rawFinalRecordIdentity,
              value.authority,
              heldFd,
              expectedCommand
            ),
            ack,
            value.settle,
            finalRecord,
            rawFinalRecordIdentity,
            value.authority,
            expectedCommand
          );
        },
      });
    },
  });
}

module.exports = Object.freeze({
  HELPER_PATH,
  PublicMarkdownNativeLifecycleError,
  createPublicMarkdownNativeTransport,
  createPublicMarkdownNativeLifecycle,
});
