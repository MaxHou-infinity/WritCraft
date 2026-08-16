'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'changes-history-artifact-helper')
  : path.join(__dirname, 'native', 'changes-history-artifact-helper');
const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const BASENAME_RE = /^changes-history-chr_[a-f0-9]{48}\.bin$/u;
const QUARANTINE_RE = /^\.changes-history-cleanup\.[a-f0-9]{32}$/u;
const CONTROL_RE = /^\.changes-history-cleanup-control\.[a-f0-9]{64}$/u;
const PROOF_RE = /^\.changes-history-cleanup-proof\.[a-f0-9]{64}$/u;
const RECEIPT_RE = /^\.changes-history-cleanup-receipt\.[a-f0-9]{64}$/u;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;

class ChangesHistoryArtifactLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryArtifactLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryArtifactLifecycleError(code, message);
}

function decimal(value, signed = false) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  const expression = signed ? /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/u : /^(?:0|[1-9][0-9]*)$/u;
  if (!expression.test(text)) fail('ARTIFACT_CLEANUP_PROTOCOL', 'native artifact identity is invalid');
  return text;
}

function boundedRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0') ||
      Buffer.byteLength(rootPath, 'utf8') > 4096 || path.resolve(rootPath) !== rootPath) {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'canonical project root is required');
  }
  return rootPath;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || !BASENAME_RE.test(request.basename || '') ||
      !Number.isInteger(request.heldFd) || request.heldFd < 0 ||
      !request.binding || !DIGEST_RE.test(request.binding.sha256 || '') ||
      !Number.isSafeInteger(request.binding.byteLength) || request.binding.byteLength < 0 ||
      !request.identity || typeof request.identity !== 'object') {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'native artifact cleanup request is invalid');
  }
  const identity = Object.freeze({
    dev: decimal(request.identity.dev),
    ino: decimal(request.identity.ino),
    uid: decimal(request.identity.uid),
    mode: decimal(request.identity.mode),
    nlink: decimal(request.identity.nlink),
    size: decimal(request.identity.size),
    mtimeNs: decimal(request.identity.mtimeNs, true),
    ctimeNs: decimal(request.identity.ctimeNs, true),
  });
  if (identity.size !== String(request.binding.byteLength)) {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact size binding is invalid');
  }
  return Object.freeze({
    basename: request.basename,
    heldFd: request.heldFd,
    binding: Object.freeze({
      byteLength: request.binding.byteLength,
      sha256: request.binding.sha256,
    }),
    identity,
  });
}

function validateToken(fields, command = 'C') {
  if (fields.length !== 8 || fields[0] !== command || fields[1] !== 'OK' ||
      fields[2] !== 'COMMITTED' || !QUARANTINE_RE.test(fields[3]) ||
      !CONTROL_RE.test(fields[4]) || !PROOF_RE.test(fields[5]) ||
      !RECEIPT_RE.test(fields[6]) || !DIGEST_RE.test(fields[7])) {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'native artifact cleanup response is invalid');
  }
  return Object.freeze({
    schema: 'writcraft.changes-history-artifact-cleanup-token/v1',
    quarantine: fields[3],
    control: fields[4],
    proof: fields[5],
    receipt: fields[6],
    receiptDigest: fields[7],
  });
}

function validateTokenRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact cleanup token record is invalid');
  }
  const keys = [
    'schema', 'quarantine', 'control', 'proof', 'receipt', 'receiptDigest',
  ];
  const ownKeys = Reflect.ownKeys(raw);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (ownKeys.length !== keys.length || ownKeys.some(key =>
    typeof key !== 'string' || !keys.includes(key))) {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact cleanup token record is invalid');
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact cleanup token record is invalid');
    }
    values[key] = descriptor.value;
  }
  if (values.schema !== 'writcraft.changes-history-artifact-cleanup-token/v1') {
    fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact cleanup token record is invalid');
  }
  return validateToken([
    'R', 'OK', 'COMMITTED', values.quarantine, values.control, values.proof,
    values.receipt, values.receiptDigest,
  ], 'R');
}

function createChangesHistoryArtifactLifecycle(options = {}) {
  const helperPath = options.helperPath || HELPER_PATH;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function forProject(rootPath) {
    const projectRoot = boundedRoot(rootPath);
    const rootLine = `P\t${Buffer.from(projectRoot, 'utf8').toString('hex')}\n`;

    function invoke(command, heldFd) {
      let trustedRootFd;
      try { trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY); }
      catch (_) { fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'trusted filesystem root is unavailable'); }
      let result;
      try {
        result = spawnSync(helperPath, [], {
          input: `${rootLine}${command}\n`,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          stdio: ['pipe', 'pipe', 'pipe', trustedRootFd, heldFd ?? trustedRootFd],
        });
      } catch (_) {
        fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'native artifact lifecycle helper is unavailable');
      } finally {
        try { fs.closeSync(trustedRootFd); } catch (_) {}
      }
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      if (stderr.length || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES || stdout.includes('\0')) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native artifact lifecycle output is unsafe');
      }
      const lines = stdout.split('\n').filter(Boolean);
      if (lines[0] !== 'P\tOK') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native artifact root binding failed');
      }
      return Object.freeze({
        status: result.status,
        signal: result.signal,
        fields: lines.length === 2 ? lines[1].split('\t') : null,
      });
    }

    function operation(kind, rawRequest) {
      const request = validateRequest(rawRequest);
      const command = [
        'C', kind, request.basename, String(request.binding.byteLength), request.binding.sha256,
        request.identity.dev, request.identity.ino, request.identity.uid, request.identity.mode,
        request.identity.nlink, request.identity.size, request.identity.mtimeNs, request.identity.ctimeNs,
      ].join('\t');
      let last;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        last = invoke(command, request.heldFd);
        if (last.fields?.[0] === 'C' && last.fields?.[1] === 'OK') {
          return validateToken(last.fields);
        }
        const errorCode = last.fields?.[0] === 'C' && last.fields?.[1] === 'ERR'
          ? last.fields[2]
          : null;
        if (errorCode && !['UNKNOWN', 'UNCOMMITTED'].includes(errorCode)) break;
        // A C retry must always retain the original one-link, read-only held-fd
        // precondition. Once exact unlink may have committed, reconcile from
        // the immutable control/proof records instead of relaxing fd 4 to a
        // zero-link descriptor.
        const reconciliation = invoke([
          'R', request.basename, String(request.binding.byteLength), request.binding.sha256,
        ].join('\t'), null);
        if (reconciliation.fields?.[0] === 'R' && reconciliation.fields?.[1] === 'OK') {
          return validateToken(reconciliation.fields, 'R');
        }
      }
      const code = last?.fields?.[0] === 'C' && last.fields?.[1] === 'ERR'
        ? last.fields[2]
        : null;
      const error = new ChangesHistoryArtifactLifecycleError(
        code === 'IDENTITY' ? 'CHANGES_RECOVERY_CONFLICT' : 'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'native artifact cleanup requires exact reconciliation'
      );
      Object.defineProperty(error, 'nativeCode', { value: code, enumerable: false });
      throw error;
    }

    function acknowledge(basename, token) {
      if (!BASENAME_RE.test(basename || '') || !token ||
          !QUARANTINE_RE.test(token.quarantine || '') || !CONTROL_RE.test(token.control || '') ||
          !PROOF_RE.test(token.proof || '') || !RECEIPT_RE.test(token.receipt || '') ||
          !DIGEST_RE.test(token.receiptDigest || '')) {
        fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact cleanup token is invalid');
      }
      const command = [
        'A', basename, token.quarantine, token.control, token.proof, token.receipt,
        token.receiptDigest,
      ].join('\t');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = invoke(command, null);
        if (result.fields?.length === 3 && result.fields[0] === 'A' &&
            result.fields[1] === 'OK' && result.fields[2] === 'ACKED') return;
      }
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup receipt acknowledgement is unknown');
    }

    function reconcile(binding) {
      if (!binding || !BASENAME_RE.test(binding.basename || '') ||
          !Number.isSafeInteger(binding.byteLength) || binding.byteLength < 0 ||
          !DIGEST_RE.test(binding.sha256 || '')) {
        fail('ARTIFACT_CLEANUP_PROTOCOL', 'artifact reconciliation binding is invalid');
      }
      const command = ['R', binding.basename, String(binding.byteLength), binding.sha256].join('\t');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = invoke(command, null);
        if (result.fields?.[0] === 'R' && result.fields?.[1] === 'OK') {
          return validateToken(result.fields, 'R');
        }
        if (result.fields?.[0] === 'R' && result.fields?.[1] === 'ERR' &&
            result.fields[2] === 'UNCOMMITTED') return null;
      }
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup receipt requires reconciliation');
    }

    function verify(binding, rawToken) {
      const token = validateTokenRecord(rawToken);
      const current = reconcile(binding);
      if (!current || JSON.stringify(current) !== JSON.stringify(token)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup token is foreign or stale');
      }
      return token;
    }

    return Object.freeze({
      schema: 'writcraft.changes-history-artifact-lifecycle-scoped/v1',
      cleanup: request => operation('cleanup', request),
      rollback(request) {
        const token = operation('rollback', request);
        acknowledge(request.basename, token);
        return token;
      },
      reconcile,
      verify,
      acknowledge,
    });
  }

  return Object.freeze({
    schema: 'writcraft.changes-history-artifact-lifecycle/v1',
    forProject,
  });
}

module.exports = Object.freeze({
  HELPER_PATH,
  ChangesHistoryArtifactLifecycleError,
  createChangesHistoryArtifactLifecycle,
});
