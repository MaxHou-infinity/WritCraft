'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const schema = require('./evidence-delivery-schema');
const snapshotBundle = require('./snapshot-bundle');
const marked = require('../shared/marked.umd');
const snapshotImageTokenizer = require('../shared/snapshot-image-tokenizer');

const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'snapshot-storage-helper')
  : path.join(__dirname, 'native', 'snapshot-storage-helper');
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 4096;
const MAX_CAPTURE_WIRE_BYTES = (64 * 1024 * 1024 * 2) + (1024 * 1024);
const MAX_CAPTURE_LINE_BYTES = (64 * 1024 * 2) + 512;
const MAX_CAPTURE_METADATA_BYTES = 512 * 1024;
const MAX_CAPTURE_CANDIDATES = 300;
const MAX_CAPTURE_IMAGES = 200;
const MAX_CAPTURE_MARKDOWN_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_MARKDOWN_BYTES = 64 * 1024 * 1024;
// Memory note (P2-28): the capture wire (128MiB), C-side stage assembly
// (520MiB) and JS Buffer materialization make the peak working set of a
// snapshot capture roughly 1.5GiB on a large project. This is documented
// so the settings page can hint at it before a heavy capture.
const MAX_WRITE_CHUNK_BYTES = 64 * 1024;
const MAX_STAGE_BYTES = 520 * 1024 * 1024;
const MAX_COMMITTED_READ_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_COMMITTED_READ_CONTENT_WIRE_BYTES = MAX_STAGE_BYTES * 2;
const MAX_COMMITTED_READ_WIRE_BYTES =
  MAX_COMMITTED_READ_CONTENT_WIRE_BYTES + MAX_COMMITTED_READ_METADATA_BYTES;
const MAX_COMMITTED_READ_LINE_BYTES = (MAX_WRITE_CHUNK_BYTES * 2) + 512;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DESTROY_TIMEOUT_MS = 5000;
const CONTINUE_RESPONSE = Symbol('continue-response');

const tokenizer = snapshotImageTokenizer.createAdapter({
  marked,
  sha256Bytes(bytes) {
    return `sha256:${crypto.createHash('sha256').update(Buffer.from(
      bytes.buffer, bytes.byteOffset, bytes.byteLength
    )).digest('hex')}`;
  },
});

class SnapshotStorageWorkerError extends Error {
  constructor(code, message, captureOutcome = null) {
    super(message);
    this.name = 'SnapshotStorageWorkerError';
    this.code = code;
    if (captureOutcome) this.captureOutcome = captureOutcome;
  }
}

function failure(code, message, captureOutcome = null) {
  return new SnapshotStorageWorkerError(code, message, captureOutcome);
}

function productionFailure(code, message, captureOutcome) {
  return failure(code, message, captureOutcome);
}

function unsigned(value, field) {
  return schema.assertUnsignedDecimal(value, field);
}

function safeNumber(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw failure('SNAPSHOT_STORAGE_PROTOCOL', `${field} 无效`);
  const number = Number(value);
  try {
    return schema.assertSafeInteger(number, field, 0, maximum);
  } catch (_) {
    throw failure('SNAPSHOT_STORAGE_PROTOCOL', `${field} 无效`);
  }
}

function exactFields(fields, length, command) {
  if (fields.length !== length || fields[0] !== command || fields[1] !== 'OK') {
    throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response is malformed');
  }
}

function stableNativeError(command, code, activeStage) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code || '')) {
    return failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper returned an invalid error');
  }
  const provenPrecreate = command === 'S' &&
    ['PATH', 'ROOT', 'PRIVATE_PARENT', 'STAGE_EXISTS', 'PROTOCOL'].includes(code);
  if (command === 'O' && !['ROOT', 'PROTOCOL'].includes(code)) {
    return failure('SNAPSHOT_UNAVAILABLE', `Committed snapshot is unavailable: ${code}`);
  }
  if (activeStage && !['C'].includes(command) && !provenPrecreate) {
    return failure('SNAPSHOT_RECOVERY_REQUIRED', 'Snapshot stage outcome requires reconciliation');
  }
  const mapping = {
    PATH: 'SNAPSHOT_ROOT_CHANGED',
    ROOT: 'SNAPSHOT_ROOT_CHANGED',
    PRIVATE_PARENT: 'SNAPSHOT_PRIVATE_STORAGE_UNSAFE',
    STAGE_EXISTS: 'SNAPSHOT_STAGE_CONFLICT',
    IDENTITY: activeStage ? 'SNAPSHOT_RECOVERY_REQUIRED' : 'SNAPSHOT_IDENTITY_CHANGED',
    IO: activeStage ? 'SNAPSHOT_RECOVERY_REQUIRED' : 'SNAPSHOT_STORAGE_IO',
    UNKNOWN: 'SNAPSHOT_RECOVERY_REQUIRED',
    PROTOCOL: 'SNAPSHOT_STORAGE_PROTOCOL',
  };
  return failure(mapping[code] || 'SNAPSHOT_STORAGE_FAILED', `Native snapshot helper failed: ${code}`);
}

function stableProductionNativeError(command, code) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code || '')) {
    return productionFailure(
      'SNAPSHOT_RECOVERY_REQUIRED',
      'Native snapshot helper returned an invalid production error',
      'STAGE_MAY_EXIST'
    );
  }
  if (['G', 'T', 'U', 'K'].includes(command)) {
    const mapping = {
      ROOT: 'SNAPSHOT_ROOT_CHANGED',
      SOURCE_IO: 'SNAPSHOT_SOURCE_IO',
      SOURCE_BUDGET: 'SNAPSHOT_CAPACITY_EXCEEDED',
      TOKEN_BUDGET: 'SNAPSHOT_CAPACITY_EXCEEDED',
      TOKEN_PASS: 'SNAPSHOT_TOKEN_PASS_INVALID',
      PROTOCOL: 'SNAPSHOT_STORAGE_PROTOCOL',
    };
    return productionFailure(
      mapping[code] || 'SNAPSHOT_CAPTURE_FAILED',
      `Native snapshot capture failed: ${code}`,
      'PROVEN_PRECREATE'
    );
  }
  return productionFailure(
    'SNAPSHOT_RECOVERY_REQUIRED',
    `Native snapshot build requires exact reconciliation: ${code}`,
    'STAGE_MAY_EXIST'
  );
}

function validateRootPath(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) ||
      Buffer.byteLength(rootPath, 'utf8') > 4096 || rootPath.includes('\0')) {
    throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'A bounded absolute project root is required');
  }
  return rootPath;
}

function timestamp(value, field) {
  schema.assertString(value, field, { ascii: true, minBytes: 1, maxBytes: 96 });
  if (Number.isNaN(Date.parse(value))) {
    throw failure('SNAPSHOT_STORAGE_PROTOCOL', `${field} 无效`);
  }
  return value;
}

function stageBasename(value) {
  return schema.assertString(value, 'stageBasename', {
    ascii: true, minBytes: 1, maxBytes: 96, pattern: /^stage-[a-f0-9]{64}\.wcsb$/,
  });
}

function finalBasename(value) {
  return schema.assertString(value, 'finalBasename', {
    ascii: true, minBytes: 1, maxBytes: 96, pattern: /^bundle-[a-f0-9]{64}\.wcsb$/,
  });
}

function expectedBasename(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}.wcsb`;
}

function abortError() {
  return productionFailure(
    'SNAPSHOT_CAPTURE_ABORTED',
    'Snapshot capture owner was invalidated',
    'STAGE_MAY_EXIST'
  );
}

function captureMetadataFramingBytes(fields) {
  if (!Array.isArray(fields) || fields.length < 2 || fields[0] !== 'G' ||
      fields.some(field => typeof field !== 'string' || /[^\x20-\x7e]/u.test(field))) {
    throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot capture metadata framing is invalid');
  }
  if (fields[1] === 'BYTES') {
    if (fields.length !== 6) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot capture byte framing is invalid');
    }
    // G<TAB>BYTES<TAB>captureId<TAB>candidateId<TAB>offset<TAB><hex><LF>.
    // The exact candidate content hex is wire/content accounting; every other
    // byte, including the separator before it and the terminal LF, is metadata.
    return Buffer.byteLength(fields.slice(0, 5).join('\t'), 'ascii') + 2;
  }
  return Buffer.byteLength(fields.join('\t'), 'ascii') + 1;
}

class SnapshotStorageWorker {
  constructor(options = {}) {
    this.rootPath = validateRootPath(options.rootPath);
    this.expectedRootIdentity = options.expectedRootIdentity || null;
    this.initializeStorage = options.initializeStorage === true;
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.destroyTimeoutMs = Number.isSafeInteger(options.destroyTimeoutMs) &&
      options.destroyTimeoutMs > 0
      ? options.destroyTimeoutMs
      : DEFAULT_DESTROY_TIMEOUT_MS;
    this.beforeRequest = typeof options.beforeRequest === 'function' ? options.beforeRequest : null;
    this.testOnlyKernel = options.testOnlyKernel === true;
    this.ownsTrustedRootFd = !Number.isInteger(options.trustedRootFd);
    try {
      this.trustedRootFd = this.ownsTrustedRootFd
        ? fs.openSync('/', fs.constants.O_RDONLY)
        : options.trustedRootFd;
    } catch (_) {
      throw failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Trusted filesystem root is unavailable');
    }
    let trusted;
    try { trusted = fs.fstatSync(this.trustedRootFd, { bigint: true }); }
    catch (_) {
      if (this.ownsTrustedRootFd) {
        try { fs.closeSync(this.trustedRootFd); } catch (_) {}
      }
      throw failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Trusted filesystem root descriptor is unavailable');
    }
    if (!trusted.isDirectory()) {
      if (this.ownsTrustedRootFd) fs.closeSync(this.trustedRootFd);
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Trusted filesystem root descriptor is not a directory');
    }
    try {
      this.child = (options.spawn || childProcess.spawn)(options.helperPath || HELPER_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe', this.trustedRootFd],
        env: options.env || process.env,
      });
    } catch (_) {
      this.#closeTrustedRoot();
      throw failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper failed to start');
    }
    if (!this.child?.stdin || !this.child?.stdout || !this.child?.stderr) {
      this.#closeTrustedRoot();
      throw failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper pipes are unavailable');
    }
    this.buffer = Buffer.alloc(0);
    this.totalResponseBytes = 0;
    this.pending = null;
    this.failed = null;
    this.closed = false;
    this.exited = false;
    this.closing = false;
    this.closePromise = null;
    this.destroyPromise = null;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.activeStage = null;
    this.rootIdentity = null;
    this.parentIdentities = null;
    this.productionOperation = null;
    this.child.stdout.on('data', chunk => this.#onData(chunk));
    this.child.stdin.on('error', () => {
      if (this.closing && !this.pending && !this.activeStage && !this.productionOperation) return;
      this.#fail(this.productionOperation
        ? productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Native snapshot helper input failed after sealed capture began',
          'STAGE_MAY_EXIST'
        )
        : this.activeStage
        ? failure('SNAPSHOT_RECOVERY_REQUIRED', 'Native snapshot helper input failed with a live stage')
        : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper input failed'));
    });
    this.child.stderr.on('data', chunk => {
      if (chunk.length) this.#fail(this.productionOperation
        ? productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Native snapshot helper wrote stderr after sealed capture began',
          'STAGE_MAY_EXIST'
        )
        : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper wrote stderr'));
    });
    this.child.on('error', () => this.#fail(this.productionOperation
      ? productionFailure(
        'SNAPSHOT_RECOVERY_REQUIRED',
        'Native snapshot helper failed after sealed capture began',
        'STAGE_MAY_EXIST'
      )
      : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper failed to start')));
    this.child.on('close', () => {
      this.exited = true;
      this.closed = true;
      this.#closeTrustedRoot();
      this.resolveExit?.();
      if (!this.closing || this.pending || this.activeStage || this.productionOperation) {
        this.#fail(this.productionOperation
          ? productionFailure(
            'SNAPSHOT_RECOVERY_REQUIRED',
            'Native snapshot helper exited after sealed capture began',
            'STAGE_MAY_EXIST'
          )
          : this.activeStage
          ? failure('SNAPSHOT_RECOVERY_REQUIRED', 'Native snapshot helper exited with a live stage')
          : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper exited unexpectedly'));
      }
    });
    this.readyPromise = this.#bind();
    this.readyPromise.catch(() => {});
  }

  #closeTrustedRoot() {
    if (!this.ownsTrustedRootFd || this.trustedRootFd < 0) return;
    try { fs.closeSync(this.trustedRootFd); } catch (_) {}
    this.trustedRootFd = -1;
  }

  #fail(error) {
    if (!this.failed) this.failed = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(this.failed);
    }
    if (!this.closing && this.child && !this.child.killed) this.child.kill();
  }

  #onData(chunk) {
    if (!Buffer.isBuffer(chunk) || !chunk.length || this.failed) return;
    try {
      this.totalResponseBytes += chunk.length;
      const responseLimit = this.pending?.maxResponseBytes || MAX_RESPONSE_BYTES;
      const lineLimit = this.pending?.maxLineBytes || MAX_RESPONSE_LINE_BYTES;
      if (this.totalResponseBytes > responseLimit || chunk.includes(0)) {
        throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response exceeds bounds');
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline < 0) {
          if (this.buffer.length > lineLimit) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response line exceeds bounds');
          }
          break;
        }
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line.length || line.length > lineLimit || line.includes(0x0d)) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response is malformed');
        }
        for (const byte of line) {
          if (byte !== 0x09 && (byte < 0x20 || byte > 0x7e)) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response is not strict ASCII');
          }
        }
        this.#onLine(line.toString('utf8'));
      }
    } catch (error) {
      const parsed = error instanceof SnapshotStorageWorkerError
        ? error
        : failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response is malformed');
      this.#fail(this.productionOperation
        ? productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Native snapshot helper protocol failed after sealed capture began',
          'STAGE_MAY_EXIST'
        )
        : this.activeStage
        ? failure('SNAPSHOT_RECOVERY_REQUIRED', 'Native snapshot helper protocol failed with a live stage')
        : parsed);
    }
  }

  #onLine(line) {
    const pending = this.pending;
    if (!pending) throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response has no owner');
    const fields = line.split('\t');
    if (fields[0] !== pending.command) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response command is stale');
    }
    if (fields[1] === 'ERR') {
      this.pending = null;
      clearTimeout(pending.timer);
      this.totalResponseBytes = 0;
      if (fields.length !== 3) return pending.reject(failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper error is malformed'));
      return pending.reject(this.productionOperation
        ? stableProductionNativeError(fields[0], fields[2])
        : stableNativeError(fields[0], fields[2], Boolean(this.activeStage)));
    }
    try {
      const parsed = pending.parse(fields);
      if (parsed === CONTINUE_RESPONSE) return;
      this.pending = null;
      clearTimeout(pending.timer);
      this.totalResponseBytes = 0;
      pending.resolve(parsed);
    } catch (error) {
      this.pending = null;
      clearTimeout(pending.timer);
      this.totalResponseBytes = 0;
      if (this.productionOperation) {
        pending.reject(productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Snapshot production response requires exact reconciliation',
          'STAGE_MAY_EXIST'
        ));
      } else if (this.activeStage) {
        const recovery = failure('SNAPSHOT_RECOVERY_REQUIRED', 'Snapshot stage response requires reconciliation');
        Object.defineProperty(recovery, 'protocolCode', {
          value: error instanceof SnapshotStorageWorkerError ? error.code : 'SNAPSHOT_STORAGE_PROTOCOL',
          enumerable: false,
        });
        pending.reject(recovery);
      } else {
        pending.reject(error instanceof SnapshotStorageWorkerError
          ? error
          : failure('SNAPSHOT_STORAGE_PROTOCOL', 'Native snapshot helper response is malformed'));
      }
    }
  }

  async #bind() {
    const root = await this.#send('P', `P\t${Buffer.from(this.rootPath, 'utf8').toString('hex')}\n`, fields => {
      exactFields(fields, 6, 'P');
      const value = {
        schema: schema.SCHEMAS.ROOT_IDENTITY,
        dev: unsigned(fields[2], 'root.dev'),
        ino: unsigned(fields[3], 'root.ino'),
        uid: safeNumber(fields[4], 'root.uid'),
        mode: safeNumber(fields[5], 'root.mode', 0xffff),
      };
      schema.assertRootIdentity(value);
      return Object.freeze(value);
    }, true);
    if (this.expectedRootIdentity &&
        (String(this.expectedRootIdentity.dev) !== root.dev ||
         String(this.expectedRootIdentity.ino) !== root.ino)) {
      throw failure('SNAPSHOT_ROOT_CHANGED', 'Snapshot project root identity changed');
    }
    this.rootIdentity = root;
    const storageCommand = this.initializeStorage ? 'I' : 'D';
    const parents = await this.#send(storageCommand, `${storageCommand}\n`, fields => {
      exactFields(fields, 17, storageCommand);
      const roles = ['control', 'bundles', 'quarantine'];
      const starts = [2, 7, 12];
      const result = {};
      for (let index = 0; index < roles.length; index += 1) {
        const start = starts[index];
        if (fields[start] !== roles[index]) throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Private parent role drifted');
        const value = {
          schema: schema.SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY,
          role: roles[index],
          rootIdentityDigest: schema.digestRootIdentity(root),
          dev: unsigned(fields[start + 1], `${roles[index]}.dev`),
          ino: unsigned(fields[start + 2], `${roles[index]}.ino`),
          uid: safeNumber(fields[start + 3], `${roles[index]}.uid`),
          mode: safeNumber(fields[start + 4], `${roles[index]}.mode`, 0xffff),
        };
        schema.assertSnapshotPrivateParentIdentity(value);
        result[roles[index]] = Object.freeze(value);
      }
      return Object.freeze(result);
    }, true);
    this.parentIdentities = parents;
    return Object.freeze({ rootIdentity: root, parentIdentities: parents });
  }

  #send(command, line, parse, allowWhileClosing = false, responseBounds = null) {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed || (this.closing && !allowWhileClosing) || !this.child?.stdin?.writable) {
      return Promise.reject(failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper is closed'));
    }
    if (this.pending) return Promise.reject(failure('SNAPSHOT_STORAGE_BUSY', 'Native snapshot helper request already pending'));
    this.totalResponseBytes = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending) return;
        this.pending = null;
        const error = this.productionOperation
          ? productionFailure(
            'SNAPSHOT_RECOVERY_REQUIRED',
            'Native snapshot helper timed out after sealed capture began',
            'STAGE_MAY_EXIST'
          )
          : this.activeStage
          ? failure('SNAPSHOT_RECOVERY_REQUIRED', 'Native snapshot helper response timed out with a live stage')
          : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper response timed out');
        reject(error);
        this.#fail(error);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = {
        command,
        parse,
        resolve,
        reject,
        timer,
        maxResponseBytes: responseBounds?.maxResponseBytes,
        maxLineBytes: responseBounds?.maxLineBytes,
      };
      this.child.stdin.write(line, error => {
        if (!error) return;
        if (this.pending?.timer !== timer) return;
        this.pending = null;
        clearTimeout(timer);
        const writeError = this.productionOperation
          ? productionFailure(
            'SNAPSHOT_RECOVERY_REQUIRED',
            'Native snapshot helper write failed after sealed capture began',
            'STAGE_MAY_EXIST'
          )
          : this.activeStage
          ? failure('SNAPSHOT_RECOVERY_REQUIRED', 'Native snapshot helper write failed with a live stage')
          : failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper write failed');
        reject(writeError);
        this.#fail(writeError);
      });
    });
  }

  async #request(command, line, parse, kind, beforeSend = null, responseBounds = null) {
    await this.readyPromise;
    if (this.beforeRequest) await this.beforeRequest({ kind, command });
    if (this.failed) throw this.failed;
    if (this.closed || this.closing) throw failure('SNAPSHOT_HELPER_UNAVAILABLE', 'Native snapshot helper closed before request');
    if (beforeSend) beforeSend();
    return this.#send(command, line, parse, false, responseBounds);
  }

  ready() {
    return this.readyPromise;
  }

  async createProductionSnapshot(request) {
    schema.assertExactKeys(request, [
      'transactionId', 'projectInstanceId', 'snapshotId', 'ownerGeneration',
      'creationMutationGeneration', 'createdAt', 'stageBasename', 'finalBasename', 'signal',
    ], 'production snapshot request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertProjectInstanceId(request.projectInstanceId);
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    schema.assertSafeInteger(request.ownerGeneration, 'ownerGeneration', 0);
    schema.assertSafeInteger(request.creationMutationGeneration, 'creationMutationGeneration', 0);
    timestamp(request.createdAt, 'createdAt');
    stageBasename(request.stageBasename);
    finalBasename(request.finalBasename);
    if (request.stageBasename !== expectedBasename('stage', request.transactionId) ||
        request.finalBasename !== expectedBasename('bundle', request.snapshotId)) {
      throw productionFailure(
        'SNAPSHOT_STORAGE_PROTOCOL',
        'Production snapshot basenames are not authority-derived',
        'PROVEN_PRECREATE'
      );
    }
    const signal = request.signal;
    if (signal !== null && (!signal || typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean')) {
      throw productionFailure(
        'SNAPSHOT_STORAGE_PROTOCOL',
        'Production snapshot signal is invalid',
        'PROVEN_PRECREATE'
      );
    }
    if (this.testOnlyKernel || this.activeStage || this.productionOperation) {
      throw failure('SNAPSHOT_STORAGE_BUSY', 'Production snapshot capture is unavailable on this worker');
    }
    if (signal?.aborted) {
      throw productionFailure(
        'SNAPSHOT_CAPTURE_ABORTED',
        'Snapshot capture was already aborted',
        'PROVEN_PRECREATE'
      );
    }

    const operation = {
      transactionId: request.transactionId,
      projectInstanceId: request.projectInstanceId,
      snapshotId: request.snapshotId,
      phase: 'G',
    };
    const candidates = [];
    const candidateIds = new Set();
    const fileIds = new Set();
    let captureId = null;
    let metadataBytes = 0;
    let totalMarkdownBytes = 0;

    const assertOwner = () => {
      if (this.productionOperation !== operation || signal?.aborted) throw abortError();
      if (this.failed) throw this.failed;
      if (this.closed || this.closing) throw abortError();
    };
    const reserveMetadata = fields => {
      const addition = captureMetadataFramingBytes(fields);
      if (addition > MAX_CAPTURE_METADATA_BYTES - metadataBytes) {
        throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot capture metadata exceeds bounds');
      }
      metadataBytes += addition;
    };

    try {
      this.productionOperation = operation;
      const sealed = await this.#request(
        'G',
        `G\t${request.transactionId}\t${request.projectInstanceId}\t${request.snapshotId}` +
          `\t${request.ownerGeneration}\t${request.creationMutationGeneration}\t${request.createdAt}\n`,
        fields => {
          if (fields[1] === 'MARKDOWN') {
            if (fields.length !== 8 || candidates.length >= MAX_CAPTURE_CANDIDATES) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown metadata is malformed');
            }
            reserveMetadata(fields);
            schema.assertString(fields[2], 'captureId', {
              ascii: true, pattern: /^capture_[a-f0-9]{64}$/u, maxBytes: 72,
            });
            schema.assertString(fields[3], 'candidateId', {
              ascii: true, pattern: /^candidate_[a-f0-9]{64}$/u, maxBytes: 74,
            });
            schema.assertOpaqueId(fields[4], 'fileId');
            const byteLength = safeNumber(
              fields[5], 'markdown byteLength', MAX_CAPTURE_MARKDOWN_BYTES
            );
            const digest = schema.assertDigest(fields[6], 'markdown sha256');
            if (!/^[a-f0-9]{64}$/u.test(fields[7]) || fields[7] !== digest.slice(7) ||
                candidateIds.has(fields[3]) || fileIds.has(fields[4]) ||
                (captureId !== null && fields[2] !== captureId)) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown identity drifted');
            }
            captureId = fields[2];
            candidateIds.add(fields[3]);
            fileIds.add(fields[4]);
            candidates.push({
              candidateId: fields[3],
              fileId: fields[4],
              byteLength,
              digest,
              revision: fields[7],
              receivedBytes: 0,
              chunks: [],
              hash: crypto.createHash('sha256'),
            });
            totalMarkdownBytes += byteLength;
            if (totalMarkdownBytes > MAX_CAPTURE_TOTAL_MARKDOWN_BYTES) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown aggregate exceeds bounds');
            }
            return CONTINUE_RESPONSE;
          }
          if (fields[1] === 'BYTES') {
            if (fields.length !== 6 || captureId === null || fields[2] !== captureId ||
                !/^(?:[a-f0-9]{2})+$/u.test(fields[5]) ||
                fields[5].length > MAX_WRITE_CHUNK_BYTES * 2) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown chunk is malformed');
            }
            reserveMetadata(fields);
            const candidate = candidates.find(value => value.candidateId === fields[3]);
            const offset = safeNumber(fields[4], 'markdown offset', MAX_CAPTURE_TOTAL_MARKDOWN_BYTES);
            if (!candidate || offset !== candidate.receivedBytes) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown chunk offset drifted');
            }
            const chunk = Buffer.from(fields[5], 'hex');
            if (chunk.length < 1 || candidate.receivedBytes + chunk.length > candidate.byteLength) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown chunk exceeds its seal');
            }
            candidate.chunks.push(chunk);
            candidate.hash.update(chunk);
            candidate.receivedBytes += chunk.length;
            return CONTINUE_RESPONSE;
          }
          reserveMetadata(fields);
          if (captureId === null && fields[1] === 'OK') {
            schema.assertString(fields[3], 'captureId', {
              ascii: true, pattern: /^capture_[a-f0-9]{64}$/u, maxBytes: 72,
            });
            captureId = fields[3];
          }
          if (fields[1] !== 'OK' || fields.length !== 7 ||
              fields[2] !== request.transactionId || fields[3] !== captureId) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot capture terminal is malformed');
          }
          const captureDigest = schema.assertDigest(fields[4], 'captureDigest');
          if (safeNumber(fields[5], 'markdown count', MAX_CAPTURE_CANDIDATES) !== candidates.length ||
              safeNumber(fields[6], 'markdown bytes', MAX_CAPTURE_TOTAL_MARKDOWN_BYTES) !==
                totalMarkdownBytes) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot capture terminal count drifted');
          }
          const inputs = candidates.map(candidate => {
            if (candidate.receivedBytes !== candidate.byteLength ||
                `sha256:${candidate.hash.digest('hex')}` !== candidate.digest) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot Markdown exact bytes drifted');
            }
            return Object.freeze({
              candidateId: candidate.candidateId,
              captureDigest,
              fileId: candidate.fileId,
              revision: candidate.revision,
              markdownBytes: Buffer.concat(candidate.chunks, candidate.byteLength),
            });
          });
          return Object.freeze({ captureDigest, candidates: Object.freeze(inputs) });
        },
        'production_capture',
        assertOwner,
        {
          maxResponseBytes: MAX_CAPTURE_WIRE_BYTES,
          maxLineBytes: MAX_CAPTURE_LINE_BYTES,
        }
      );
      assertOwner();

      let pass;
      try {
        pass = tokenizer.createTokenPass({
          transactionId: request.transactionId,
          candidates: sealed.candidates,
        });
      } catch (_) {
        throw productionFailure(
          'SNAPSHOT_TOKEN_PASS_INVALID',
          'Shared Markdown token pass rejected the sealed capture',
          'PROVEN_PRECREATE'
        );
      }
      const canonical = Buffer.from(tokenizer.canonicalJson(pass), 'utf8');
      operation.phase = 'T';
      const expected = await this.#request(
        'T',
        `T\t${request.transactionId}\t${canonical.length}\n`,
        fields => {
          exactFields(fields, 4, 'T');
          if (fields[2] !== request.transactionId) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot token-pass owner drifted');
          }
          return safeNumber(fields[3], 'token-pass expected bytes', tokenizer.LIMITS.maxCanonicalBytes);
        },
        'production_token_begin',
        assertOwner
      );
      if (expected !== canonical.length) {
        throw productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Native token-pass length drifted',
          'STAGE_MAY_EXIST'
        );
      }
      assertOwner();
      let written = 0;
      for (let offset = 0; offset < canonical.length; offset += MAX_WRITE_CHUNK_BYTES) {
        assertOwner();
        const chunk = canonical.subarray(offset, offset + MAX_WRITE_CHUNK_BYTES);
        written = await this.#request(
          'U',
          `U\t${request.transactionId}\t${chunk.toString('hex')}\n`,
          fields => {
            exactFields(fields, 4, 'U');
            if (fields[2] !== request.transactionId) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot token chunk owner drifted');
            }
            return safeNumber(fields[3], 'token-pass written bytes', tokenizer.LIMITS.maxCanonicalBytes);
          },
          'production_token_chunk',
          assertOwner
        );
        if (written !== offset + chunk.length) {
          throw productionFailure(
            'SNAPSHOT_RECOVERY_REQUIRED',
            'Native token-pass write count drifted',
            'STAGE_MAY_EXIST'
          );
        }
      }
      assertOwner();
      operation.phase = 'K';
      await this.#request(
        'K',
        `K\t${request.transactionId}\n`,
        fields => {
          exactFields(fields, 5, 'K');
          if (fields[2] !== request.transactionId) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot token-pass terminal owner drifted');
          }
          safeNumber(fields[3], 'image reference count', 10000);
          safeNumber(fields[4], 'selected image count', MAX_CAPTURE_IMAGES);
          return true;
        },
        'production_token_finish',
        assertOwner
      );
      assertOwner();
      operation.phase = 'B';
      operation.buildSent = false;
      const truth = await this.#request(
        'B',
        `B\t${request.transactionId}\n`,
        fields => {
          if (fields[0] !== 'B' || fields[1] !== 'OK' || fields[2] !== request.transactionId) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot production truth is malformed');
          }
          if (fields[3] === 'UNCOMMITTED') {
            if (fields.length !== 6 || !/^[A-Z][A-Z0-9_]*$/u.test(fields[5])) {
              throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot uncommitted truth is malformed');
            }
            return Object.freeze({
              state: 'UNCOMMITTED',
              snapshotManifestDigest: schema.assertDigest(fields[4], 'snapshotManifestDigest'),
              reason: fields[5],
            });
          }
          if (fields[3] !== 'COMMITTED' || fields.length !== 7) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot committed truth is malformed');
          }
          return Object.freeze({
            state: 'COMMITTED',
            snapshotManifestDigest: schema.assertDigest(fields[4], 'snapshotManifestDigest'),
            publishedIdentityDigest: schema.assertDigest(fields[5], 'publishedIdentityDigest'),
            receiptDigest: schema.assertDigest(fields[6], 'receiptDigest'),
          });
        },
        'production_build',
        () => {
          assertOwner();
          operation.buildSent = true;
        }
      );
      this.productionOperation = null;
      return Object.freeze({
        transactionId: request.transactionId,
        snapshotId: request.snapshotId,
        stageBasename: request.stageBasename,
        finalBasename: request.finalBasename,
        ...truth,
        ...(truth.state === 'COMMITTED'
          ? { expectedPublishedIdentityDigest: truth.publishedIdentityDigest }
          : {}),
      });
    } catch (error) {
      if (error?.code === 'SNAPSHOT_CAPTURE_ABORTED' &&
          (operation.phase !== 'B' || operation.buildSent !== true) &&
          this.productionOperation === operation && !this.failed && !this.closed) {
        try {
          await this.#send('X', 'X\n', fields => {
            exactFields(fields, 2, 'X');
            return true;
          });
          this.productionOperation = null;
          this.closing = true;
          this.child.stdin.end();
          this.#closeTrustedRoot();
          this.closed = true;
          throw productionFailure(
            'SNAPSHOT_CAPTURE_ABORTED',
            'Snapshot capture was cancelled before private transaction creation',
            'PROVEN_UNCOMMITTED'
          );
        } catch (settleError) {
          if (settleError?.captureOutcome === 'PROVEN_UNCOMMITTED') throw settleError;
          throw productionFailure(
            'SNAPSHOT_RECOVERY_REQUIRED',
            'Snapshot cancellation could not prove precommit cleanup',
            'STAGE_MAY_EXIST'
          );
        }
      }
      if (error?.captureOutcome === 'PROVEN_PRECREATE' || error?.captureOutcome === 'PROVEN_UNCOMMITTED') {
        this.productionOperation = null;
      }
      throw error;
    }
  }

  async reconcileProductionCreate(request) {
    schema.assertExactKeys(request, [
      'transactionId', 'snapshotId', 'stageBasename', 'finalBasename', 'observedAt',
    ], 'production snapshot reconciliation request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    stageBasename(request.stageBasename);
    finalBasename(request.finalBasename);
    timestamp(request.observedAt, 'observedAt');
    if (request.stageBasename !== expectedBasename('stage', request.transactionId) ||
        request.finalBasename !== expectedBasename('bundle', request.snapshotId)) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Production reconciliation basenames drifted');
    }
    if (this.activeStage || this.productionOperation) {
      throw failure('SNAPSHOT_STORAGE_BUSY', 'Production reconciliation requires a fresh worker');
    }
    return this.#request(
      'R',
      `R\t${request.transactionId}\t${request.snapshotId}\t${request.stageBasename}` +
        `\t${request.finalBasename}\t${request.observedAt}\n`,
      fields => {
        if (fields[0] !== 'R' || fields[1] !== 'OK' || fields[2] !== request.transactionId) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot reconciliation truth is malformed');
        }
        if (fields[3] === 'UNCOMMITTED' && fields.length === 4) {
          return Object.freeze({ state: 'UNCOMMITTED' });
        }
        if (fields[3] !== 'COMMITTED' || fields.length !== 6) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot reconciliation truth is malformed');
        }
        return Object.freeze({
          state: 'COMMITTED',
          publishedIdentityDigest: schema.assertDigest(fields[4], 'publishedIdentityDigest'),
          receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
        });
      },
      'production_reconcile'
    );
  }

  async deleteCommittedSnapshot(request) {
    schema.assertExactKeys(request, [
      'transactionId', 'projectInstanceId', 'snapshotId', 'ownerGeneration',
      'snapshotManifestDigest', 'publishedIdentityDigest', 'committedAt',
    ], 'snapshot delete storage request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertProjectInstanceId(request.projectInstanceId);
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    schema.assertSafeInteger(request.ownerGeneration, 'ownerGeneration', 0);
    schema.assertDigest(request.snapshotManifestDigest, 'snapshotManifestDigest');
    schema.assertDigest(request.publishedIdentityDigest, 'publishedIdentityDigest');
    timestamp(request.committedAt, 'committedAt');
    if (this.testOnlyKernel || this.activeStage || this.productionOperation) {
      throw failure('SNAPSHOT_STORAGE_BUSY', 'Snapshot delete storage transaction is unavailable');
    }
    const operation = Object.freeze({
      transactionId: request.transactionId,
      projectInstanceId: request.projectInstanceId,
      snapshotId: request.snapshotId,
      phase: 'Y',
    });
    this.productionOperation = operation;
    try {
      const truth = await this.#request(
        'Y',
        `Y\t${request.transactionId}\t${request.projectInstanceId}\t${request.snapshotId}` +
          `\t${request.ownerGeneration}\t${request.snapshotManifestDigest}` +
          `\t${request.publishedIdentityDigest}\t${request.committedAt}\n`,
        fields => {
          if (fields[0] !== 'Y' || fields[1] !== 'OK' ||
              fields[2] !== request.transactionId) {
            throw failure(
              'SNAPSHOT_STORAGE_PROTOCOL',
              'Snapshot delete terminal truth is malformed'
            );
          }
          if (fields[3] === 'UNCOMMITTED') {
            if (fields.length !== 5 || !/^[A-Z][A-Z0-9_]*$/u.test(fields[4])) {
              throw failure(
                'SNAPSHOT_STORAGE_PROTOCOL',
                'Snapshot delete uncommitted truth is malformed'
              );
            }
            return Object.freeze({ state: 'UNCOMMITTED', reason: fields[4] });
          }
          if (fields[3] !== 'COMMITTED' || fields.length !== 6) {
            throw failure(
              'SNAPSHOT_STORAGE_PROTOCOL',
              'Snapshot delete committed truth is malformed'
            );
          }
          return Object.freeze({
            state: 'COMMITTED',
            deletedIdentityDigest: schema.assertDigest(
              fields[4], 'deletedIdentityDigest'
            ),
            receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
          });
        },
        'delete_committed_snapshot'
      );
      if (this.productionOperation !== operation) {
        throw productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Snapshot delete owner drifted before terminal installation',
          'STAGE_MAY_EXIST'
        );
      }
      this.productionOperation = null;
      return Object.freeze({
        transactionId: request.transactionId,
        projectInstanceId: request.projectInstanceId,
        snapshotId: request.snapshotId,
        snapshotManifestDigest: request.snapshotManifestDigest,
        sourceIdentityDigest: request.publishedIdentityDigest,
        ...truth,
      });
    } catch (error) {
      if (error?.captureOutcome === 'PROVEN_PRECREATE' ||
          error?.captureOutcome === 'PROVEN_UNCOMMITTED') {
        this.productionOperation = null;
      }
      throw error;
    }
  }

  async reconcileDelete(request) {
    schema.assertExactKeys(request, [
      'transactionId', 'projectInstanceId', 'snapshotId', 'ownerGeneration',
      'snapshotManifestDigest', 'publishedIdentityDigest', 'observedAt',
    ], 'snapshot delete storage reconciliation request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertProjectInstanceId(request.projectInstanceId);
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    schema.assertSafeInteger(request.ownerGeneration, 'ownerGeneration', 0);
    schema.assertDigest(request.snapshotManifestDigest, 'snapshotManifestDigest');
    schema.assertDigest(request.publishedIdentityDigest, 'publishedIdentityDigest');
    timestamp(request.observedAt, 'observedAt');
    if (this.testOnlyKernel || this.activeStage || this.productionOperation) {
      throw failure(
        'SNAPSHOT_STORAGE_BUSY',
        'Snapshot delete reconciliation requires a fresh production worker'
      );
    }
    const operation = Object.freeze({
      transactionId: request.transactionId,
      projectInstanceId: request.projectInstanceId,
      snapshotId: request.snapshotId,
      phase: 'Z',
    });
    this.productionOperation = operation;
    try {
      const truth = await this.#request(
        'Z',
        `Z\t${request.transactionId}\t${request.projectInstanceId}\t${request.snapshotId}` +
          `\t${request.ownerGeneration}\t${request.snapshotManifestDigest}` +
          `\t${request.publishedIdentityDigest}\t${request.observedAt}\n`,
        fields => {
          if (fields[0] !== 'Z' || fields[1] !== 'OK' ||
              fields[2] !== request.transactionId) {
            throw failure(
              'SNAPSHOT_STORAGE_PROTOCOL',
              'Snapshot delete reconciliation truth is malformed'
            );
          }
          if (fields[3] === 'UNCOMMITTED') {
            if (fields.length !== 5 || !/^[A-Z][A-Z0-9_]*$/u.test(fields[4])) {
              throw failure(
                'SNAPSHOT_STORAGE_PROTOCOL',
                'Snapshot delete reconciliation uncommitted truth is malformed'
              );
            }
            return Object.freeze({
              transactionId: request.transactionId,
              snapshotId: request.snapshotId,
              state: 'UNCOMMITTED',
              reason: fields[4],
            });
          }
          if (fields[3] !== 'COMMITTED' || fields.length !== 6) {
            throw failure(
              'SNAPSHOT_STORAGE_PROTOCOL',
              'Snapshot delete reconciliation committed truth is malformed'
            );
          }
          return Object.freeze({
            transactionId: request.transactionId,
            snapshotId: request.snapshotId,
            state: 'COMMITTED',
            deletedIdentityDigest: schema.assertDigest(
              fields[4], 'deletedIdentityDigest'
            ),
            receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
          });
        },
        'reconcile_delete'
      );
      if (this.productionOperation !== operation) {
        throw productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Snapshot delete reconciliation owner drifted before terminal installation',
          'STAGE_MAY_EXIST'
        );
      }
      this.productionOperation = null;
      return truth;
    } catch (error) {
      throw error;
    }
  }

  #assertTestOnlyKernel() {
    if (!this.testOnlyKernel) {
      throw failure('SNAPSHOT_TEST_KERNEL_DISABLED', 'Legacy snapshot stage kernel is test-only');
    }
  }

  async createStage(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, [
      'transactionId', 'snapshotId', 'stageBasename', 'expectedBytes',
    ], 'snapshot create stage request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    stageBasename(request.stageBasename);
    schema.assertSafeInteger(request.expectedBytes, 'expectedBytes', 0, MAX_STAGE_BYTES);
    if (this.activeStage) throw failure('SNAPSHOT_STORAGE_BUSY', 'A snapshot stage is already active');
    const provisional = {
      transactionId: request.transactionId,
      snapshotId: request.snapshotId,
      stageBasename: request.stageBasename,
      expectedBytes: request.expectedBytes,
      writtenBytes: 0,
      provisional: true,
    };
    let result;
    try {
      result = await this.#request(
      'S',
      `S\t${request.transactionId}\t${request.snapshotId}\t${request.stageBasename}\t${request.expectedBytes}\n`,
      fields => {
        exactFields(fields, 10, 'S');
        if (fields[2] !== request.transactionId || fields[3] !== request.snapshotId) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot stage identity owner drifted');
        }
        const identity = Object.freeze({
          dev: unsigned(fields[4], 'stage.dev'),
          ino: unsigned(fields[5], 'stage.ino'),
          uid: safeNumber(fields[6], 'stage.uid'),
          mode: safeNumber(fields[7], 'stage.mode', 0xffff),
          nlink: safeNumber(fields[8], 'stage.nlink'),
          size: unsigned(fields[9], 'stage.size'),
        });
        if (identity.mode !== 0o600 || identity.nlink !== 1 || identity.size !== '0') {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot stage initial identity is invalid');
        }
        return identity;
      },
      'create_stage',
        () => { this.activeStage = provisional; }
      );
    } catch (error) {
      if (this.activeStage === provisional && [
        'SNAPSHOT_ROOT_CHANGED', 'SNAPSHOT_PRIVATE_STORAGE_UNSAFE',
        'SNAPSHOT_STAGE_CONFLICT', 'SNAPSHOT_STORAGE_PROTOCOL',
      ].includes(error?.code)) {
        this.activeStage = null;
      }
      throw error;
    }
    provisional.provisional = false;
    return result;
  }

  async writeStage(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, ['transactionId', 'chunk'], 'snapshot stage write request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    if (!Buffer.isBuffer(request.chunk) || request.chunk.length < 1 ||
        request.chunk.length > MAX_WRITE_CHUNK_BYTES) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot stage chunk is invalid');
    }
    const active = this.activeStage;
    if (!active || active.transactionId !== request.transactionId) {
      throw failure('SNAPSHOT_STORAGE_NOT_OWNER', 'Snapshot stage is not owned by this request');
    }
    if (active.writtenBytes + request.chunk.length > active.expectedBytes) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot stage write exceeds expected bytes');
    }
    const written = await this.#request(
      'W',
      `W\t${request.transactionId}\t${request.chunk.toString('hex')}\n`,
      fields => {
        exactFields(fields, 4, 'W');
        if (fields[2] !== request.transactionId) throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot write owner drifted');
        return safeNumber(fields[3], 'writtenBytes', MAX_STAGE_BYTES);
      },
      'write_stage'
    );
    if (written !== active.writtenBytes + request.chunk.length) {
      throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot helper write count drifted');
    }
    active.writtenBytes = written;
    return written;
  }

  async finalizeStage(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, ['transactionId', 'snapshotManifestDigest'], 'snapshot stage finalize request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertDigest(request.snapshotManifestDigest, 'snapshotManifestDigest');
    const active = this.activeStage;
    if (!active || active.transactionId !== request.transactionId ||
        active.writtenBytes !== active.expectedBytes) {
      throw failure('SNAPSHOT_STORAGE_NOT_OWNER', 'Snapshot stage is incomplete or not owned');
    }
    const identity = await this.#request(
      'F',
      `F\t${request.transactionId}\t${request.snapshotManifestDigest}\n`,
      fields => {
        exactFields(fields, 12, 'F');
        if (fields[2] !== active.transactionId || fields[3] !== active.snapshotId ||
            fields[11] !== request.snapshotManifestDigest) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Final snapshot stage owner drifted');
        }
        const identity = {
          schema: schema.SCHEMAS.SNAPSHOT_STAGE_IDENTITY,
          transactionId: active.transactionId,
          snapshotId: active.snapshotId,
          parentIdentityDigest: schema.digestSnapshotPrivateParentIdentity(this.parentIdentities.control),
          stageBasenameSha256: schema.sha256(active.stageBasename),
          dev: unsigned(fields[4], 'stage.dev'),
          ino: unsigned(fields[5], 'stage.ino'),
          uid: safeNumber(fields[6], 'stage.uid'),
          mode: safeNumber(fields[7], 'stage.mode', 0xffff),
          nlink: safeNumber(fields[8], 'stage.nlink'),
          size: unsigned(fields[9], 'stage.size'),
          bundlePayloadSha256: schema.assertDigest(fields[10], 'bundlePayloadSha256'),
          snapshotManifestDigest: request.snapshotManifestDigest,
        };
        schema.assertSnapshotStageIdentity(identity, this.parentIdentities.control);
        if (identity.size !== String(active.expectedBytes)) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Final snapshot stage size drifted');
        }
        return Object.freeze(identity);
      },
      'finalize_stage'
    );
    active.finalizedIdentity = identity;
    return identity;
  }

  async publishStage(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, ['transactionId', 'finalBasename', 'committedAt'],
      'snapshot stage publish request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    finalBasename(request.finalBasename);
    timestamp(request.committedAt, 'committedAt');
    const active = this.activeStage;
    if (!active || active.transactionId !== request.transactionId || !active.finalizedIdentity) {
      throw failure('SNAPSHOT_STORAGE_NOT_OWNER', 'Snapshot stage is not finalized or owned');
    }
    const result = await this.#request(
      'A',
      `A\t${request.transactionId}\t${request.finalBasename}\t${request.committedAt}\n`,
      fields => {
        if (fields[0] !== 'A' || fields[1] !== 'OK' || fields[2] !== request.transactionId) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot publish truth is malformed');
        }
        if (fields[3] === 'UNCOMMITTED') {
          if (fields.length !== 5 || !/^[A-Z][A-Z0-9_]*$/u.test(fields[4])) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot uncommitted truth is malformed');
          }
          return Object.freeze({ state: 'UNCOMMITTED', reason: fields[4] });
        }
        if (fields[3] !== 'COMMITTED' || fields.length !== 6) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot committed truth is malformed');
        }
        const publishedIdentity = {
          schema: schema.SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY,
          snapshotId: active.snapshotId,
          parentIdentityDigest: schema.digestSnapshotPrivateParentIdentity(this.parentIdentities.bundles),
          finalBasenameSha256: schema.sha256(request.finalBasename),
          dev: active.finalizedIdentity.dev,
          ino: active.finalizedIdentity.ino,
          uid: active.finalizedIdentity.uid,
          mode: active.finalizedIdentity.mode,
          nlink: active.finalizedIdentity.nlink,
          size: active.finalizedIdentity.size,
          bundlePayloadSha256: active.finalizedIdentity.bundlePayloadSha256,
          snapshotManifestDigest: active.finalizedIdentity.snapshotManifestDigest,
        };
        schema.assertSnapshotPublishedIdentity(publishedIdentity, this.parentIdentities.bundles);
        if (schema.digestSnapshotPublishedIdentity(
          publishedIdentity,
          this.parentIdentities.bundles
        ) !==
            schema.assertDigest(fields[4], 'publishedIdentityDigest')) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot published identity digest drifted');
        }
        return Object.freeze({
          state: 'COMMITTED',
          publishedIdentity: Object.freeze(publishedIdentity),
          publishedIdentityDigest: fields[4],
          receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
        });
      },
      'publish_stage'
    );
    this.activeStage = null;
    return result;
  }

  async reconcileCreate(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, [
      'transactionId', 'snapshotId', 'stageBasename', 'finalBasename', 'observedAt',
      'expectedPublishedIdentityDigest',
    ], 'snapshot create reconciliation request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    stageBasename(request.stageBasename);
    finalBasename(request.finalBasename);
    timestamp(request.observedAt, 'observedAt');
    schema.assertDigest(request.expectedPublishedIdentityDigest, 'expectedPublishedIdentityDigest');
    if (this.activeStage) throw failure('SNAPSHOT_STORAGE_BUSY', 'A live stage cannot be reconciled in place');
    return this.#request(
      'R',
      `R\t${request.transactionId}\t${request.snapshotId}\t${request.stageBasename}` +
        `\t${request.finalBasename}\t${request.observedAt}\n`,
      fields => {
        if (fields[0] !== 'R' || fields[1] !== 'OK' || fields[2] !== request.transactionId) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot reconciliation truth is malformed');
        }
        if (fields[3] === 'UNCOMMITTED' && fields.length === 4) {
          return Object.freeze({ state: 'UNCOMMITTED' });
        }
        if (fields[3] !== 'COMMITTED' || fields.length !== 6 ||
            schema.assertDigest(fields[4], 'publishedIdentityDigest') !==
              request.expectedPublishedIdentityDigest) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot reconciliation identity drifted');
        }
        return Object.freeze({
          state: 'COMMITTED',
          publishedIdentityDigest: fields[4],
          receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
        });
      },
      'reconcile_create'
    );
  }

  async listCommitted() {
    if (this.activeStage || this.productionOperation) {
      throw failure('SNAPSHOT_STORAGE_BUSY', 'A live snapshot operation blocks committed listing');
    }
    const items = [];
    const unavailableItems = [];
    return this.#request('L', 'L\n', fields => {
      if (fields[0] !== 'L') throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot list response is malformed');
      if (fields[1] === 'ITEM') {
        if (fields.length !== 7 || items.length >= 256) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot list item is malformed');
        }
        schema.assertOpaqueId(fields[2], 'snapshotId');
        const item = Object.freeze({
          snapshotId: fields[2],
          snapshotManifestDigest: schema.assertDigest(fields[3], 'snapshotManifestDigest'),
          publishedIdentityDigest: schema.assertDigest(fields[4], 'publishedIdentityDigest'),
          receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
          size: safeNumber(fields[6], 'snapshot size', MAX_STAGE_BYTES),
        });
        if (items.some(existing => existing.snapshotId === item.snapshotId)) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot list contains duplicate identity');
        }
        items.push(item);
        return CONTINUE_RESPONSE;
      }
      if (fields[1] === 'UNAVAILABLE') {
        if (fields.length !== 4 || unavailableItems.length >= 256 ||
            !/^[A-Z][A-Z0-9_]*$/u.test(fields[3])) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot unavailable list item is malformed');
        }
        const unavailable = Object.freeze({
          itemDigest: schema.assertDigest(fields[2], 'unavailable item digest'),
          reason: fields[3],
        });
        if (unavailableItems.some(existing => existing.itemDigest === unavailable.itemDigest)) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot unavailable list contains duplicate identity');
        }
        unavailableItems.push(unavailable);
        return CONTINUE_RESPONSE;
      }
      if (fields[1] !== 'OK' || fields.length !== 5) {
        throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot list terminal is malformed');
      }
      const count = safeNumber(fields[2], 'snapshot count', 256);
      const unavailableCount = safeNumber(fields[3], 'unavailable count', 1000000);
      const unavailableDetailCount = safeNumber(fields[4], 'unavailable detail count', 256);
      if (count !== items.length || unavailableDetailCount !== unavailableItems.length ||
          unavailableDetailCount > unavailableCount) {
        throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot list count drifted');
      }
      return Object.freeze({
        items: Object.freeze(items),
        unavailableItems: Object.freeze(unavailableItems),
        unavailableCount,
        unavailableTruncated: unavailableDetailCount < unavailableCount,
      });
    }, 'list_committed');
  }

  async readCommittedSnapshot(request) {
    schema.assertExactKeys(request, ['snapshotId'], 'committed snapshot read request');
    schema.assertOpaqueId(request.snapshotId, 'snapshotId');
    if (this.activeStage || this.productionOperation) {
      throw failure('SNAPSHOT_STORAGE_BUSY', 'A live snapshot operation blocks committed reading');
    }
    let started = null;
    let assembled = null;
    let expectedOffset = 0;
    let wireMetadataBytes = 0;
    let wireContentBytes = 0;
    return this.#request(
      'O',
      `O\t${request.snapshotId}\n`,
      fields => {
        if (fields[0] !== 'O') {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot response is malformed');
        }
        if (fields[1] === 'START') {
          if (started || fields.length !== 8 || fields[2] !== request.snapshotId) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot start is malformed');
          }
          started = Object.freeze({
            snapshotId: fields[2],
            snapshotManifestDigest: schema.assertDigest(fields[3], 'snapshotManifestDigest'),
            publishedIdentityDigest: schema.assertDigest(fields[4], 'publishedIdentityDigest'),
            receiptDigest: schema.assertDigest(fields[5], 'receiptDigest'),
            bundlePayloadSha256: schema.assertDigest(fields[6], 'bundlePayloadSha256'),
            size: safeNumber(fields[7], 'committed snapshot size', MAX_STAGE_BYTES),
          });
          try { assembled = Buffer.allocUnsafe(started.size); }
          catch (_) {
            throw failure('SNAPSHOT_UNAVAILABLE', 'Committed snapshot read capacity is unavailable');
          }
          wireMetadataBytes += Buffer.byteLength(fields.join('\t'), 'ascii') + 1;
          if (wireMetadataBytes > MAX_COMMITTED_READ_METADATA_BYTES) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot metadata exceeds bounds');
          }
          return CONTINUE_RESPONSE;
        }
        if (fields[1] === 'BYTES') {
          if (!started || fields.length !== 4 || fields[3].length < 2 ||
              fields[3].length > MAX_WRITE_CHUNK_BYTES * 2 ||
              (fields[3].length % 2) !== 0 || !/^[a-f0-9]+$/u.test(fields[3]) ||
              safeNumber(fields[2], 'committed snapshot offset', MAX_STAGE_BYTES) !== expectedOffset) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot byte frame is malformed');
          }
          const chunk = Buffer.from(fields[3], 'hex');
          if (chunk.length * 2 !== fields[3].length ||
              expectedOffset + chunk.length > started.size) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot bytes exceed bounds');
          }
          chunk.copy(assembled, expectedOffset);
          expectedOffset += chunk.length;
          wireMetadataBytes += Buffer.byteLength(fields.slice(0, 3).join('\t'), 'ascii') + 2;
          wireContentBytes += fields[3].length;
          if (wireMetadataBytes > MAX_COMMITTED_READ_METADATA_BYTES ||
              wireContentBytes > MAX_COMMITTED_READ_CONTENT_WIRE_BYTES) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot wire budgets exceed bounds');
          }
          return CONTINUE_RESPONSE;
        }
        if (fields[1] !== 'OK' || fields.length !== 3 || !started ||
            safeNumber(fields[2], 'committed snapshot terminal size', MAX_STAGE_BYTES) !== expectedOffset ||
            expectedOffset !== started.size) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot terminal is malformed');
        }
        wireMetadataBytes += Buffer.byteLength(fields.join('\t'), 'ascii') + 1;
        if (wireMetadataBytes > MAX_COMMITTED_READ_METADATA_BYTES) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot metadata exceeds bounds');
        }
        const bundle = assembled;
        let parsed;
        try {
          parsed = snapshotBundle.parseBundle(bundle);
        } catch (_) {
          throw failure('SNAPSHOT_UNAVAILABLE', 'Committed snapshot bundle failed shared validation');
        }
        if (parsed.manifest.snapshotId !== started.snapshotId ||
            parsed.manifest.snapshotManifestDigest !== started.snapshotManifestDigest ||
            parsed.bundlePayloadSha256 !== started.bundlePayloadSha256 ||
            parsed.bindings.length !== parsed.manifest.files.length) {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot authority drifted');
        }
        let markdownBytes = 0;
        let imageBytes = 0;
        const entries = parsed.bindings.map((binding, index) => {
          const file = parsed.manifest.files[index];
          if (binding.fileId !== file.fileId || binding.contentLength !== file.byteLength) {
            throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Committed snapshot entry binding drifted');
          }
          if (file.kind === 'markdown') markdownBytes += binding.contentLength;
          else imageBytes += binding.contentLength;
          return Object.freeze({
            fileId: file.fileId,
            kind: file.kind,
            headerBytes: Buffer.from(schema.canonicalJson(snapshotBundle.entryHeader(file)), 'utf8'),
            // Keep an exact bounded view over the one preallocated bundle.
            // Copying every entry would double the 520 MiB read ceiling.
            content: bundle.subarray(
              binding.contentOffset,
              binding.contentOffset + binding.contentLength
            ),
            binding,
          });
        });
        const decodedMetadataBytes = bundle.length - markdownBytes - imageBytes;
        if (markdownBytes > MAX_CAPTURE_TOTAL_MARKDOWN_BYTES ||
            markdownBytes + imageBytes > snapshotBundle.MAX_CONTENT_BYTES ||
            decodedMetadataBytes > MAX_COMMITTED_READ_METADATA_BYTES) {
          throw failure('SNAPSHOT_UNAVAILABLE', 'Committed snapshot content exceeds frozen read bounds');
        }
        const manifestBytes = Buffer.from(schema.canonicalJson(parsed.manifest), 'utf8');
        return Object.freeze({
          ...started,
          manifest: parsed.manifest,
          manifestBytes,
          entries: Object.freeze(entries),
          bindings: parsed.bindings,
          readBudget: Object.freeze({
            decodedMetadataBytes,
            decodedContentBytes: markdownBytes + imageBytes,
            markdownBytes,
            imageBytes,
            wireMetadataBytes,
            wireContentBytes,
          }),
        });
      },
      'read_committed',
      null,
      {
        maxResponseBytes: MAX_COMMITTED_READ_WIRE_BYTES,
        maxLineBytes: MAX_COMMITTED_READ_LINE_BYTES,
      }
    );
  }

  async cancelStage(request) {
    this.#assertTestOnlyKernel();
    schema.assertExactKeys(request, ['transactionId'], 'snapshot stage cancel request');
    schema.assertOpaqueId(request.transactionId, 'transactionId');
    const active = this.activeStage;
    if (!active || active.transactionId !== request.transactionId) {
      throw failure('SNAPSHOT_STORAGE_NOT_OWNER', 'Snapshot stage is not owned by this request');
    }
    const result = await this.#request(
      'C',
      `C\t${request.transactionId}\n`,
      fields => {
        exactFields(fields, 4, 'C');
        if (fields[2] !== request.transactionId || fields[3] !== 'UNCOMMITTED') {
          throw failure('SNAPSHOT_STORAGE_PROTOCOL', 'Snapshot cancel truth is invalid');
        }
        return Object.freeze({ state: 'UNCOMMITTED' });
      },
      'cancel_stage'
    );
    this.activeStage = null;
    return result;
  }

  close() {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    if (this.pending) throw failure('SNAPSHOT_STORAGE_BUSY', 'Cannot close snapshot helper during a live request');
    if (this.activeStage) throw failure('SNAPSHOT_RECOVERY_REQUIRED', 'Cannot close snapshot helper with a live stage');
    if (this.productionOperation) {
      throw productionFailure(
        'SNAPSHOT_RECOVERY_REQUIRED',
        'Cannot close snapshot helper after production capture began',
        'STAGE_MAY_EXIST'
      );
    }
    this.closePromise = (async () => {
      await this.readyPromise;
      if (this.pending) {
        this.closePromise = null;
        throw failure('SNAPSHOT_STORAGE_BUSY', 'Cannot close snapshot helper during a live request');
      }
      this.closing = true;
      try {
        await this.#send('X', 'X\n', fields => {
          exactFields(fields, 2, 'X');
          return true;
        }, true);
      } finally {
        this.child.stdin.end();
        if (!this.child.killed) this.child.kill();
        this.#closeTrustedRoot();
        this.closed = true;
      }
    })();
    return this.closePromise;
  }

  destroyForReconciliation() {
    if (this.destroyPromise) return this.destroyPromise;
    if (this.exited) return Promise.resolve(true);
    // This is a transport teardown only. It never sends X/C or removes any
    // stage/control record; a fresh worker must resolve the exact transaction.
    this.destroyPromise = (async () => {
      this.closing = true;
      this.productionOperation = null;
      this.activeStage = null;
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        pending.reject(productionFailure(
          'SNAPSHOT_RECOVERY_REQUIRED',
          'Snapshot worker was replaced for exact reconciliation',
          'STAGE_MAY_EXIST'
        ));
      }
      try { this.child?.stdin?.destroy(); } catch (_) {}
      if (this.child && !this.child.killed) {
        let signalled = false;
        try { signalled = this.child.kill() !== false; } catch (_) {}
        if (!signalled && !this.exited) {
          throw productionFailure(
            'SNAPSHOT_PRODUCTION_WORKER_DESTROY_FAILED',
            'Snapshot helper termination could not be requested',
            'STAGE_MAY_EXIST'
          );
        }
      }
      this.#closeTrustedRoot();
      if (this.exited) return true;
      let timer = null;
      const timedOut = await Promise.race([
        this.exitPromise.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(true), this.destroyTimeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut || !this.exited) {
        throw productionFailure(
          'SNAPSHOT_PRODUCTION_WORKER_DESTROY_FAILED',
          'Snapshot helper did not exit before reconciliation deadline',
          'STAGE_MAY_EXIST'
        );
      }
      return true;
    })();
    return this.destroyPromise;
  }
}

function createSnapshotStorageWorkerForRoot(rootPath, options = {}) {
  let canonical;
  try { canonical = fs.realpathSync(validateRootPath(rootPath)); }
  catch (error) {
    if (error instanceof SnapshotStorageWorkerError) throw error;
    throw failure('SNAPSHOT_ROOT_CHANGED', 'Snapshot project root is unavailable');
  }
  return new SnapshotStorageWorker({ ...options, rootPath: canonical });
}

module.exports = Object.freeze({
  HELPER_PATH,
  MAX_RESPONSE_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  MAX_CAPTURE_WIRE_BYTES,
  MAX_CAPTURE_LINE_BYTES,
  MAX_CAPTURE_METADATA_BYTES,
  MAX_CAPTURE_CANDIDATES,
  MAX_CAPTURE_IMAGES,
  MAX_CAPTURE_MARKDOWN_BYTES,
  MAX_CAPTURE_TOTAL_MARKDOWN_BYTES,
  MAX_WRITE_CHUNK_BYTES,
  MAX_STAGE_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_DESTROY_TIMEOUT_MS,
  SnapshotStorageWorkerError,
  SnapshotStorageWorker,
  captureMetadataFramingBytes,
  createSnapshotStorageWorkerForRoot,
});
