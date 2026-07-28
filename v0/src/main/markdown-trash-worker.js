'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = (MAX_MANIFEST_BYTES * 2) + (64 * 1024);
const MAX_LINE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 30000;
const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'markdown-trash-helper')
  : path.join(__dirname, 'native', 'markdown-trash-helper');

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rootIdentity(value) {
  if (!value || typeof value.dev !== 'bigint' || typeof value.ino !== 'bigint' ||
      typeof value.mode !== 'bigint') throw failure('MARKDOWN_TRASH_PROTOCOL', 'Missing project root identity');
  return Object.freeze({ dev: value.dev, ino: value.ino, mode: value.mode });
}

function sameRoot(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function safeSource(value) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 255 &&
    !/[\\/\0]/.test(value) && value !== '.' && value !== '..';
}

function safeTarget(value) {
  const parts = typeof value === 'string' ? value.split('/') : [];
  return value && Buffer.byteLength(value) <= 4096 && parts.length <= 128 &&
    parts.every(part => part && part !== '.' && part !== '..' && !/[\\\0]/.test(part));
}

function fileIdentity(value) {
  if (!value || typeof value.dev !== 'bigint' || typeof value.ino !== 'bigint' ||
      typeof value.size !== 'bigint' || value.size < 0n) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Missing source identity');
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size });
}

function encodeRestore(sequence, request) {
  if (!safeSource(request?.sourceName) || !safeTarget(request?.target) ||
      !/^[a-f0-9]{64}$/.test(request?.digest || '') || !/^[a-f0-9]{64}$/.test(request?.manifestDigest || '')) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Invalid Markdown trash restore request');
  }
  const identity = fileIdentity(request.identity);
  const next = Buffer.isBuffer(request.nextManifest) ? request.nextManifest : Buffer.from(String(request.nextManifest || ''), 'utf8');
  if (next.length > MAX_MANIFEST_BYTES) throw failure('MARKDOWN_TRASH_BUDGET', 'Replacement manifest exceeds native bound');
  return `R\t${sequence}\t${Buffer.from(request.sourceName).toString('hex')}\t${Buffer.from(request.target).toString('hex')}\t${request.digest}\t${identity.dev}\t${identity.ino}\t${identity.size}\t${request.manifestDigest}\t${next.toString('hex')}\n`;
}

function encodeTrash(sequence, request) {
  if (!safeTarget(request?.source) || !safeSource(request?.targetName) ||
      !/^[a-f0-9]{64}$/.test(request?.digest || '') ||
      (!/^[a-f0-9]{64}$/.test(request?.manifestDigest || '') && request?.manifestDigest !== 'ABSENT')) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Invalid Markdown trash request');
  }
  const identity = fileIdentity(request.identity);
  const next = Buffer.isBuffer(request.nextManifest) ? request.nextManifest : Buffer.from(String(request.nextManifest || ''), 'utf8');
  if (next.length > MAX_MANIFEST_BYTES) throw failure('MARKDOWN_TRASH_BUDGET', 'Replacement manifest exceeds native bound');
  const manifestDigest = request.manifestDigest === 'ABSENT' ? '0'.repeat(64) : request.manifestDigest;
  return `T\t${sequence}\t${Buffer.from(request.source).toString('hex')}\t${Buffer.from(request.targetName).toString('hex')}\t${request.digest}\t${identity.dev}\t${identity.ino}\t${identity.size}\t${manifestDigest}\t${next.toString('hex')}\n`;
}

function operationFields(request) {
  const operation = request?.operation;
  const source = operation === 'R' ? request.sourceName : request.source;
  const target = operation === 'R' ? request.target : request.targetName;
  if (!['R', 'T'].includes(operation) || !safeTarget(source) || (operation === 'R' ? !safeTarget(target) : !safeSource(target)) ||
      !/^[a-f0-9]{64}$/.test(request?.digest || '') || !/^[a-f0-9]{64}$/.test(request?.manifestDigest || '')) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Invalid Markdown trash operation status request');
  }
  const identity = fileIdentity(request.identity);
  const next = Buffer.isBuffer(request.nextManifest) ? request.nextManifest : Buffer.from(String(request.nextManifest || ''), 'utf8');
  if (next.length > MAX_MANIFEST_BYTES) throw failure('MARKDOWN_TRASH_BUDGET', 'Replacement manifest exceeds native bound');
  return Object.freeze({ operation, source, target, identity, digest: request.digest, manifestDigest: request.manifestDigest, nextDigest: crypto.createHash('sha256').update(next).digest('hex') });
}

function encodeInspect(sequence, relative, maxBytes) {
  if (!safeTarget(relative) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Invalid native Markdown inspection request');
  }
  return `I\t${sequence}\t${Buffer.from(relative).toString('hex')}\t${maxBytes}\n`;
}

function encodeStatus(sequence, request) {
  const value = operationFields(request);
  return `S\t${sequence}\t${value.operation}\t${Buffer.from(value.source).toString('hex')}\t${Buffer.from(value.target).toString('hex')}\t${value.digest}\t${value.identity.dev}\t${value.identity.ino}\t${value.identity.size}\t${value.manifestDigest}\t${value.nextDigest}\n`;
}

class MarkdownTrashWorker {
  constructor(options = {}) {
    if (!Number.isInteger(options.rootFd) || options.rootFd < 0) {
      throw failure('MARKDOWN_TRASH_PROTOCOL', 'A Main-owned project root descriptor is required');
    }
    const stat = fs.fstatSync(options.rootFd, { bigint: true });
    if (!stat.isDirectory()) throw failure('MARKDOWN_TRASH_ROOT_CHANGED', 'Project root descriptor is not a directory');
    this.rootIdentity = rootIdentity(options.expectedRootIdentity || stat);
    if (!sameRoot(rootIdentity(stat), this.rootIdentity)) {
      throw failure('MARKDOWN_TRASH_ROOT_CHANGED', 'Project root descriptor identity changed before helper spawn');
    }
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.beforeRequest = typeof options.beforeRequest === 'function' ? options.beforeRequest : null;
    this.sequence = 0; this.pending = null; this.binding = null; this.failed = null; this.closed = false; this.closing = false;
    this.buffer = Buffer.alloc(0); this.responseBytes = 0;
    this.child = (options.spawn || childProcess.spawn)(options.helperPath || HELPER_PATH, [], {
      stdio: ['pipe', 'pipe', 'pipe', options.rootFd],
      env: options.env || process.env,
    });
    if (!this.child?.stdin || !this.child?.stdout || !this.child?.stderr) {
      throw failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper pipes are unavailable');
    }
    this.bindingPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper bind timed out')), this.timeoutMs);
      timer.unref?.(); this.binding = { resolve, reject, timer };
    });
    this.bindingPromise.catch(() => {});
    this.child.stdout.on('data', data => this.#onData(data));
    this.child.stderr.on('data', data => { if (data.length) this.#fail(failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper wrote stderr')); });
    this.child.on('error', () => this.#fail(failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper failed to start')));
    this.child.on('close', () => {
      this.closed = true;
      if (!this.closing || this.pending) this.#fail(['restore', 'trash'].includes(this.pending?.kind)
        ? failure('MARKDOWN_TRASH_RECOVERY_REQUIRED', 'Restore response was lost; reconcile before retrying')
        : failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper exited unexpectedly'));
    });
    this.child.stdin.write('P\n', error => { if (error) this.#fail(failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash helper bind write failed')); });
  }

  #fail(error) {
    if (!this.failed) this.failed = error;
    if (this.binding) { const binding = this.binding; this.binding = null; clearTimeout(binding.timer); binding.reject(this.failed); }
    if (this.pending) { const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.reject(error); }
    if (!this.closing && this.child && !this.child.killed) this.child.kill();
  }

  #onData(chunk) {
    if (!Buffer.isBuffer(chunk) || !chunk.length || this.failed) return;
    this.responseBytes += chunk.length;
    if (this.responseBytes > MAX_RESPONSE_BYTES || chunk.includes(0)) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response exceeds bounds'));
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) { if (this.buffer.length > MAX_LINE_BYTES) this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response line exceeds bounds')); return; }
      const bytes = this.buffer.subarray(0, index); this.buffer = this.buffer.subarray(index + 1);
      if (!bytes.length || bytes.length > MAX_LINE_BYTES || bytes.includes(0x0d)) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response is malformed'));
      try { this.#line(bytes.toString('utf8')); }
      catch (_) { this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response is malformed')); }
      if (this.failed) return;
    }
  }

  #line(line) {
    const fields = line.split('\t');
    if (this.binding) {
      if (fields[0] !== 'P' || fields[1] !== 'OK' || fields.length !== 5) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash bind response is malformed'));
      const bound = rootIdentity({ dev: BigInt(fields[2]), ino: BigInt(fields[3]), mode: BigInt(fields[4]) });
      if (!sameRoot(bound, this.rootIdentity)) return this.#fail(failure('MARKDOWN_TRASH_ROOT_CHANGED', 'Project root changed while binding native helper'));
      const binding = this.binding; this.binding = null; clearTimeout(binding.timer); binding.resolve(bound); return;
    }
    const pending = this.pending;
    if (!pending || fields[1] !== String(pending.sequence)) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response has no owner'));
    if (pending.kind === 'list') {
      if (fields[0] === 'L' && fields[2] === 'EMPTY' && fields.length === 3) { pending.empty = true; return; }
      if (fields[0] === 'L' && fields[2] === 'OK' && fields.length === 8 && /^[a-f0-9]{64}$/.test(fields[4])) {
        pending.length = Number(fields[3]); pending.digest = fields[4]; pending.identity = Object.freeze({ dev: BigInt(fields[5]), ino: BigInt(fields[6]), size: BigInt(fields[7]) });
        if (!Number.isSafeInteger(pending.length) || pending.length < 0 || pending.length > MAX_MANIFEST_BYTES || BigInt(pending.length) !== pending.identity.size) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown manifest metadata is invalid'));
        return;
      }
      if (fields[0] === 'D' && fields.length === 3 && /^[a-f0-9]*$/.test(fields[2]) && fields[2].length <= 2048 && (fields[2].length % 2) === 0) { pending.chunks.push(Buffer.from(fields[2], 'hex')); return; }
      if (fields[0] === 'E' && fields[2] === 'OK' && fields.length === 3 && (pending.empty || pending.digest)) {
        const current = this.pending; this.pending = null; clearTimeout(current.timer);
        const body = Buffer.concat(current.chunks);
        if (current.empty) { if (body.length) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Empty manifest returned data')); current.resolve(Object.freeze({ empty: true, entries: Buffer.alloc(0) })); return; }
        if (body.length !== current.length) return this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Manifest body length changed'));
        current.resolve(Object.freeze({ empty: false, manifest: body, digest: current.digest, identity: current.identity })); return;
      }
    }
    if (pending.kind === 'inspect' && fields[0] === 'I') {
      if (fields.length === 7 && fields[2] === 'OK' && /^[a-f0-9]{64}$/.test(fields[3])) {
        const current = this.pending; this.pending = null; clearTimeout(current.timer);
        current.resolve(Object.freeze({ ok: true, digest: fields[3], identity: Object.freeze({ dev: BigInt(fields[4]), ino: BigInt(fields[5]), size: BigInt(fields[6]) }) })); return;
      }
      if (fields.length === 3 && fields[2] === 'SOURCE_STALE') {
        const current = this.pending; this.pending = null; clearTimeout(current.timer); current.resolve(Object.freeze({ ok: false, reason: 'SOURCE_STALE' })); return;
      }
    }
    if (['restore', 'trash'].includes(pending.kind) && fields[0] === (pending.kind === 'restore' ? 'R' : 'T') &&
        fields.length === 4 && ['UNCOMMITTED', 'COMMITTED', 'RECOVERY_REQUIRED'].includes(fields[2]) &&
        ['TARGET_EXISTS', 'SOURCE_STALE', 'MANIFEST_STALE', 'REQUEST_INVALID', 'NONE', 'UNKNOWN'].includes(fields[3])) {
      const current = this.pending; this.pending = null; clearTimeout(current.timer); current.resolve(Object.freeze({ state: fields[2], reason: fields[3] })); return;
    }
    if (pending.kind === 'status' && fields[0] === 'S' && fields.length === 4 &&
        ['UNCOMMITTED', 'COMMITTED', 'RECOVERY_REQUIRED'].includes(fields[2]) &&
        ['REQUEST_INVALID', 'NONE', 'UNKNOWN'].includes(fields[3])) {
      const current = this.pending; this.pending = null; clearTimeout(current.timer); current.resolve(Object.freeze({ state: fields[2], reason: fields[3] })); return;
    }
    if (pending.kind === 'recover' && fields[0] === 'A' && fields.length === 3 &&
        ['CLEAR', 'UNCOMMITTED', 'COMMITTED', 'RECOVERY_REQUIRED'].includes(fields[2])) {
      const current = this.pending; this.pending = null; clearTimeout(current.timer); current.resolve(Object.freeze({ state: fields[2] })); return;
    }
    this.#fail(failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash response is malformed'));
  }

  async ready() { if (this.failed) throw this.failed; if (this.binding) await this.bindingPromise; if (this.failed) throw this.failed; return this.rootIdentity; }
  #assertOpen() { if (this.failed) throw this.failed; if (this.closed || this.closing || this.child.killed || this.child.stdin.destroyed) throw failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash worker is closed'); }
  async #request(kind, payload) {
    this.#assertOpen(); if (this.pending) throw failure('MARKDOWN_TRASH_PROTOCOL', 'Native Markdown trash worker is single-flight');
    await this.ready(); this.#assertOpen(); const sequence = ++this.sequence;
    if (this.beforeRequest) { await this.beforeRequest({ kind, sequence }); this.#assertOpen(); }
    this.responseBytes = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(['restore', 'trash'].includes(kind)
        ? failure('MARKDOWN_TRASH_RECOVERY_REQUIRED', 'Restore timed out; reconcile before retrying')
        : failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash list timed out')), this.timeoutMs);
      timer.unref?.(); this.pending = { kind, sequence, resolve, reject, timer, chunks: [] };
      this.child.stdin.write(payload(sequence), error => { if (error) this.#fail(['restore', 'trash'].includes(kind)
        ? failure('MARKDOWN_TRASH_RECOVERY_REQUIRED', 'Restore request delivery is unknown')
        : failure('MARKDOWN_TRASH_HELPER_UNAVAILABLE', 'Native Markdown trash request delivery failed')); });
    });
  }
  list() { return this.#request('list', sequence => `L\t${sequence}\n`); }
  inspect(relative, maxBytes) { return this.#request('inspect', sequence => encodeInspect(sequence, relative, maxBytes)); }
  restore(request) { return this.#request('restore', sequence => encodeRestore(sequence, request)); }
  trash(request) { return this.#request('trash', sequence => encodeTrash(sequence, request)); }
  status(request) { return this.#request('status', sequence => encodeStatus(sequence, request)); }
  reconcile() { return this.#request('recover', sequence => `A\t${sequence}\n`); }
  close() { if (this.closing) return; this.closing = true; if (this.child?.stdin && !this.child.stdin.destroyed) this.child.stdin.end(); setTimeout(() => { if (!this.closed && !this.child.killed) this.child.kill(); }, 1000).unref?.(); }
}

function createMarkdownTrashWorker(options) { return new MarkdownTrashWorker(options); }

function createMarkdownTrashWorkerForRoot(rootPath, expectedRootIdentity, options = {}) {
  if (typeof rootPath !== 'string' || !rootPath || rootPath.includes('\0') || !path.isAbsolute(rootPath) || path.resolve(rootPath) !== rootPath) {
    throw failure('MARKDOWN_TRASH_PROTOCOL', 'Invalid project root path for native Markdown trash worker');
  }
  const constants = options.openConstants || fs.constants;
  if (!Number.isInteger(constants.O_RDONLY) || !Number.isInteger(constants.O_DIRECTORY) ||
      !Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw failure('MARKDOWN_TRASH_UNSUPPORTED', 'Native Markdown trash worker requires directory no-follow flags');
  }
  const fd = fs.openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = rootIdentity(fs.fstatSync(fd, { bigint: true }));
    const expected = rootIdentity(expectedRootIdentity);
    if (!sameRoot(actual, expected)) throw failure('MARKDOWN_TRASH_ROOT_CHANGED', 'Project root identity changed before native helper spawn');
    return createMarkdownTrashWorker({ ...options, rootFd: fd, expectedRootIdentity: expected });
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { HELPER_PATH, MAX_MANIFEST_BYTES, MarkdownTrashWorker, createMarkdownTrashWorker, createMarkdownTrashWorkerForRoot, encodeRestore, encodeTrash, encodeInspect, encodeStatus };
