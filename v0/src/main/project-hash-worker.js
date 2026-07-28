'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_BATCH_ITEMS = 5000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_ITEM_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 30000;
const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'project-hash-helper')
  : path.join(__dirname, 'native', 'project-hash-helper');

function workerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactRootIdentity(actual, expected) {
  return actual.isDirectory() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode;
}

function identityFields(identity) {
  const fields = [
    identity?.dev,
    identity?.ino,
    identity?.size,
    identity?.mode,
    identity?.nlink,
    identity?.mtimeNs,
    identity?.ctimeNs,
  ];
  if (fields.some(value => typeof value !== 'bigint')) {
    throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Missing native hash identity');
  }
  return fields.map(value => value.toString());
}

function parseUnsigned(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value || '')) {
    throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Invalid native hash unsigned field');
  }
  return BigInt(value);
}

function parseSigned(value) {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(value || '')) {
    throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Invalid native hash signed field');
  }
  return BigInt(value);
}

function parseIdentity(fields, offset) {
  return Object.freeze({
    dev: parseUnsigned(fields[offset]),
    ino: parseUnsigned(fields[offset + 1]),
    size: parseUnsigned(fields[offset + 2]),
    mode: parseUnsigned(fields[offset + 3]),
    nlink: parseUnsigned(fields[offset + 4]),
    mtimeNs: parseSigned(fields[offset + 5]),
    ctimeNs: parseSigned(fields[offset + 6]),
  });
}

function normalizeItem(item) {
  const relative = String(item?.relative || '');
  const parts = relative.split('/');
  if (!relative || Buffer.byteLength(relative) > 4096 || parts.length > 128 ||
      parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Invalid native hash path');
  }
  if (!Number.isSafeInteger(item.maxBytes) || item.maxBytes < 0 || item.maxBytes > MAX_ITEM_BYTES ||
      !item.identity || item.identity.size > BigInt(item.maxBytes) ||
      !Array.isArray(item.ancestors) || item.ancestors.length !== parts.length - 1) {
    throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Invalid native hash item');
  }
  identityFields(item.identity);
  for (const ancestor of item.ancestors) identityFields(ancestor);
  return Object.freeze({
    relative,
    maxBytes: item.maxBytes,
    identity: item.identity,
    ancestors: Object.freeze([...item.ancestors]),
  });
}

function encodeBatch(sequence, items) {
  const normalized = items.map(normalizeItem);
  if (normalized.length > MAX_BATCH_ITEMS ||
      normalized.reduce((total, item) => total + item.maxBytes, 0) > MAX_BATCH_BYTES) {
    throw workerError('PROJECT_WATCHER_HASH_BUDGET', 'Native hash batch exceeds bounds');
  }
  const header = `B\t${sequence}\t${normalized.length}`;
  let requestBytes = Buffer.byteLength(header) + 1;
  const lines = [header];
  for (const item of normalized) {
    const fields = [
      'I',
      String(sequence),
      Buffer.from(item.relative, 'utf8').toString('hex'),
      String(item.maxBytes),
      ...identityFields(item.identity),
      String(item.ancestors.length),
    ];
    for (const ancestor of item.ancestors) fields.push(...identityFields(ancestor));
    const line = fields.join('\t');
    const lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > MAX_REQUEST_BYTES - requestBytes) {
      throw workerError(
        'PROJECT_WATCHER_HASH_BUDGET',
        'Native hash request metadata exceeds bounds'
      );
    }
    requestBytes += lineBytes;
    lines.push(line);
  }
  return Object.freeze({
    normalized,
    payload: `${lines.join('\n')}\n`,
  });
}

class ProjectHashWorker {
  constructor(rootPath, options = {}) {
    this.rootPath = rootPath;
    this.beforeHashOpen = typeof options.beforeHashOpen === 'function' ? options.beforeHashOpen : null;
    this.timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.sequence = 0;
    this.pending = null;
    this.failed = null;
    this.closing = false;
    this.closed = false;
    this.responseBytes = 0;
    this.lineBuffer = Buffer.alloc(0);

    const openConstants = options.openConstants || fs.constants;
    if (!Number.isInteger(openConstants.O_RDONLY) ||
        !Number.isInteger(openConstants.O_DIRECTORY) ||
        !Number.isInteger(openConstants.O_NOFOLLOW)) {
      throw workerError(
        'PROJECT_WATCHER_HASH_UNSUPPORTED',
        'Native hash worker requires O_DIRECTORY and O_NOFOLLOW'
      );
    }
    const directoryFlags = openConstants.O_RDONLY |
      openConstants.O_DIRECTORY |
      openConstants.O_NOFOLLOW;
    const rootFd = fs.openSync(rootPath, directoryFlags);
    try {
      const opened = fs.fstatSync(rootFd, { bigint: true });
      const atPath = fs.lstatSync(rootPath, { bigint: true });
      if (!exactRootIdentity(opened, atPath)) {
        throw workerError('PROJECT_WATCHER_ROOT_CHANGED', 'Project root changed while binding native hash worker');
      }
      this.rootIdentity = Object.freeze({
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mode: opened.mode,
        nlink: opened.nlink,
        mtimeNs: opened.mtimeNs,
        ctimeNs: opened.ctimeNs,
      });
      const spawn = options.spawn || childProcess.spawn;
      this.child = spawn(options.helperPath || HELPER_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe', rootFd],
      });
    } finally {
      fs.closeSync(rootFd);
    }

    if (!this.child || !this.child.stdin || !this.child.stdout || !this.child.stderr) {
      throw workerError('PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE', 'Native hash worker did not expose bounded pipes');
    }
    this.child.stdout.on('data', chunk => this.#onData(chunk));
    this.child.stderr.on('data', chunk => {
      if (chunk.length > 0) this.#fail(workerError(
        'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE',
        'Native hash worker wrote unexpected stderr'
      ));
    });
    this.child.on('error', () => this.#fail(workerError(
      'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE',
      'Native hash worker failed to start'
    )));
    this.child.on('close', code => {
      this.closed = true;
      if (!this.closing || code !== 0 || this.pending) {
        this.#fail(workerError(
          'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE',
          'Native hash worker exited unexpectedly'
        ));
      }
    });
  }

  async #assertRootCurrent() {
    let current;
    try {
      current = await fs.promises.lstat(this.rootPath, { bigint: true });
    } catch (_) {
      throw workerError('PROJECT_WATCHER_ROOT_CHANGED', 'Project root path is unavailable');
    }
    if (!exactRootIdentity(current, this.rootIdentity)) {
      throw workerError('PROJECT_WATCHER_ROOT_CHANGED', 'Project root identity changed');
    }
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
    if (!Buffer.isBuffer(chunk) || chunk.length === 0 || this.failed) return;
    this.responseBytes += chunk.length;
    if (this.responseBytes > MAX_RESPONSE_BYTES || chunk.includes(0)) {
      this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response exceeded bounds'));
      return;
    }
    this.lineBuffer = Buffer.concat([this.lineBuffer, chunk]);
    while (true) {
      const newline = this.lineBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.lineBuffer.length > MAX_RESPONSE_LINE_BYTES) {
          this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response line exceeded bounds'));
        }
        return;
      }
      const lineBytes = this.lineBuffer.subarray(0, newline);
      this.lineBuffer = this.lineBuffer.subarray(newline + 1);
      if (!lineBytes.length || lineBytes.includes(0x0d) || lineBytes.length > MAX_RESPONSE_LINE_BYTES) {
        this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response line is malformed'));
        return;
      }
      try {
        this.#onLine(lineBytes.toString('utf8'));
      } catch (_) {
        this.#fail(workerError(
          'PROJECT_WATCHER_HASH_PROTOCOL',
          'Native hash response identity is malformed'
        ));
      }
      if (this.failed) return;
    }
  }

  #onLine(line) {
    const pending = this.pending;
    if (!pending) {
      this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response has no owner'));
      return;
    }
    const fields = line.split('\t');
    if (fields[0] === 'R' && fields[1] === String(pending.sequence)) {
      if (pending.results.length >= pending.expected) {
        this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response has extra items'));
        return;
      }
      if (fields[2] === 'ERR' && fields.length === 4 &&
          ['PATH', 'IDENTITY', 'BUDGET', 'IO'].includes(fields[3])) {
        pending.results.push(Object.freeze({ ok: false, reason: fields[3] }));
        return;
      }
      if (fields[2] === 'OK' && fields.length === 11 && /^[a-f0-9]{64}$/.test(fields[3])) {
        pending.results.push(Object.freeze({
          ok: true,
          digest: fields[3].slice(0, 16),
          identity: parseIdentity(fields, 4),
        }));
        return;
      }
    }
    if (fields[0] === 'E' && fields[1] === String(pending.sequence) &&
        fields[2] === 'OK' && fields.length === 3 &&
        pending.results.length === pending.expected) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(Object.freeze([...pending.results]));
      return;
    }
    if (fields[0] === 'E' && fields[1] === String(pending.sequence) &&
        fields[2] === 'ERR' && fields[3] === 'BUDGET' && fields.length === 4) {
      this.#fail(workerError(
        'PROJECT_WATCHER_HASH_BUDGET',
        'Native hash helper rejected request metadata bounds'
      ));
      return;
    }
    this.#fail(workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash response is malformed'));
  }

  async hash(items) {
    if (this.failed) throw this.failed;
    if (this.closed || this.closing || !this.child || this.child.killed) {
      throw workerError('PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE', 'Native hash worker is closed');
    }
    if (this.pending) {
      throw workerError('PROJECT_WATCHER_HASH_PROTOCOL', 'Native hash worker already owns a batch');
    }
    await this.#assertRootCurrent();
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    const encoded = encodeBatch(sequence, items);
    if (this.beforeHashOpen) {
      for (const item of encoded.normalized) await this.beforeHashOpen(Object.freeze({
        relative: item.relative,
        sequence,
      }));
    }
    await this.#assertRootCurrent();
    this.responseBytes = 0;
    const results = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(workerError('PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE', 'Native hash worker timed out'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = {
        sequence,
        expected: encoded.normalized.length,
        results: [],
        resolve,
        reject,
        timer,
      };
      this.child.stdin.write(encoded.payload, error => {
        if (error) this.#fail(workerError(
          'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE',
          'Native hash worker request failed'
        ));
      });
    });
    await this.#assertRootCurrent();
    return results;
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    if (this.pending) this.#fail(workerError(
      'PROJECT_WATCHER_HASH_HELPER_UNAVAILABLE',
      'Native hash worker closed during a batch'
    ));
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.closed && !this.child.killed) this.child.kill();
    }, 1000);
    timer.unref?.();
  }
}

function createProjectHashWorker(rootPath, options = {}) {
  return new ProjectHashWorker(rootPath, options);
}

module.exports = Object.freeze({
  HELPER_PATH,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
  MAX_ITEM_BYTES,
  MAX_REQUEST_BYTES,
  createProjectHashWorker,
  encodeBatch,
  exactRootIdentity,
});
