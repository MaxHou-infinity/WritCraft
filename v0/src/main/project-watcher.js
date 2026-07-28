// Project-scoped filesystem invalidation watcher.
//
// fs.watch events are hints. A bounded asynchronous polling pass fills missed
// events without synchronously hashing an entire large writing project.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createProjectHashWorker } = require('./project-hash-worker');

const EVENT_SCHEMA = 'writcraft.external/v1';
const DEFAULT_DEBOUNCE_MS = 140;
const DEFAULT_POLL_INTERVAL_MS = 1200;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const DEFAULT_HASH_FILES_PER_ROUND = 8;
const DEFAULT_HASH_BYTES_PER_ROUND = 10 * 1024 * 1024;
const DEFAULT_FLUSH_HASH_FILES = 5000;
const DEFAULT_FLUSH_HASH_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5000;
const HASH_READ_CHUNK_BYTES = 64 * 1024;
const IGNORED_TOP_LEVEL = new Set(['node_modules']);

function normalizeWatchPath(filename) {
  if (filename === undefined || filename === null) return null;
  const value = Buffer.isBuffer(filename) ? filename.toString('utf8') : String(filename);
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  if (parts.some(part => part.startsWith('.'))) return null;
  if (IGNORED_TOP_LEVEL.has(parts[0])) return null;
  return parts.join('/');
}

function coalesceChanges(changes) {
  const byPath = new Map();
  let projectInvalidated = false;
  for (const change of changes || []) {
    if (!change || !change.path) {
      projectInvalidated = true;
      continue;
    }
    const kind = change.kind === 'renamed' ? 'renamed' : 'changed';
    const previous = byPath.get(change.path);
    byPath.set(change.path, previous === 'renamed' || kind === 'renamed' ? 'renamed' : 'changed');
  }
  const result = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([watchPath, kind]) => ({ path: watchPath, kind }));
  if (projectInvalidated) result.unshift({ path: null, kind: 'invalidated' });
  return result;
}

function visibleDirectories(rootPath, maxDirectories = 2048) {
  const directories = [rootPath];
  for (let index = 0; index < directories.length; index += 1) {
    if (directories.length > maxDirectories) break;
    const directory = directories[index];
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || IGNORED_TOP_LEVEL.has(entry.name)) continue;
      directories.push(path.join(directory, entry.name));
      if (directories.length > maxDirectories) break;
    }
  }
  return directories;
}

function snapshotEntries(snapshot) {
  return snapshot && snapshot.entries instanceof Map ? snapshot.entries : snapshot;
}

function watcherHashError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameFileIdentity(actual, expected) {
  return actual.isFile() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mode === expected.mode &&
    actual.nlink === expected.nlink &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs;
}

function sameReturnedFileIdentity(actual, expected) {
  return actual &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mode === expected.mode &&
    actual.nlink === expected.nlink &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs;
}

function captureDirectoryIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    nlink: stat.nlink,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameRootBindingIdentity(actual, expected) {
  return actual &&
    expected &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.mode === expected.mode;
}

function directoryAncestors(relative, identities) {
  const parts = relative.split('/');
  const result = [];
  let current = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    const identity = identities.get(current);
    if (!identity) return null;
    result.push(Object.freeze({ relative: current, ...identity }));
  }
  return Object.freeze(result);
}

// Legacy/custom-test hash path. Production snapshots use the native worker
// below so every project-internal ancestor is traversed relative to the bound
// root descriptor. Keep this only for explicit injected open/hash tests that
// exercise the older final-component fd contract.
async function hashFileByIdentity(absolute, expected, options = {}) {
  if (!expected || typeof expected.size !== 'bigint' || typeof expected.dev !== 'bigint' ||
      typeof expected.ino !== 'bigint' || typeof expected.mtimeNs !== 'bigint' ||
      typeof expected.ctimeNs !== 'bigint') {
    throw watcherHashError('PROJECT_WATCHER_HASH_CHANGED', 'Missing authoritative file identity');
  }
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw watcherHashError('PROJECT_WATCHER_HASH_UNSUPPORTED', 'O_NOFOLLOW is unavailable');
  }
  const expectedBytes = Number(expected.size);
  const maxBytes = positiveInteger(options.maxBytes, expectedBytes || 1);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw watcherHashError('PROJECT_WATCHER_HASH_BUDGET', 'File exceeds watcher hash budget');
  }

  const openFile = typeof options.openFile === 'function'
    ? options.openFile
    : (target, flags) => fs.promises.open(target, flags);
  const nonBlock = Number.isInteger(fs.constants.O_NONBLOCK) ? fs.constants.O_NONBLOCK : 0;
  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | nonBlock;
  let handle = null;
  try {
    handle = await openFile(absolute, flags);
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, expected) || Number(opened.size) > maxBytes) {
      throw watcherHashError('PROJECT_WATCHER_HASH_CHANGED', 'File identity changed before hashing');
    }

    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(HASH_READ_CHUNK_BYTES, expectedBytes)));
    let offset = 0;
    while (offset < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > requested) {
        throw watcherHashError('PROJECT_WATCHER_HASH_CHANGED', 'File changed during hashing');
      }
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }

    const afterRead = await handle.stat({ bigint: true });
    let afterPath;
    try {
      afterPath = await fs.promises.lstat(absolute, { bigint: true });
    } catch (_) {
      throw watcherHashError('PROJECT_WATCHER_HASH_CHANGED', 'File path changed during hashing');
    }
    if (!sameFileIdentity(afterRead, expected) || !sameFileIdentity(afterPath, expected)) {
      throw watcherHashError('PROJECT_WATCHER_HASH_CHANGED', 'File identity changed during hashing');
    }
    return digest.digest('hex').slice(0, 16);
  } finally {
    if (handle) await handle.close();
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Build metadata for the whole visible tree, but hash only a rotating budget
// of authoritative Markdown files. `previous` is used solely to carry known
// hashes for files not selected this round.
async function projectSnapshot(rootPath, options = {}) {
  const previous = snapshotEntries(options.previous) instanceof Map ? snapshotEntries(options.previous) : new Map();
  const maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const completeHash = options.completeHash === true;
  const maxHashFiles = completeHash
    ? positiveInteger(options.flushMaxHashFiles, DEFAULT_FLUSH_HASH_FILES)
    : positiveInteger(options.maxHashFiles, DEFAULT_HASH_FILES_PER_ROUND);
  const maxHashBytes = completeHash
    ? positiveInteger(options.flushMaxHashBytes, DEFAULT_FLUSH_HASH_BYTES)
    : positiveInteger(options.maxHashBytes, DEFAULT_HASH_BYTES_PER_ROUND);
  const hashFile = typeof options.hashFile === 'function' ? options.hashFile : null;
  const entries = new Map();
  const identities = new Map();
  const directoryIdentities = new Map();
  const queue = [{ absolute: rootPath, prefix: '' }];
  let scanErrors = 0;
  let rootIdentity = null;
  try {
    const rootStat = await fs.promises.lstat(rootPath, { bigint: true });
    if (!rootStat.isDirectory()) throw watcherHashError('PROJECT_WATCHER_ROOT_CHANGED', 'Project root is not a directory');
    rootIdentity = captureDirectoryIdentity(rootStat);
    directoryIdentities.set('', rootIdentity);
  } catch (_) {
    scanErrors += 1;
  }

  while (rootIdentity && queue.length && entries.size < maxEntries) {
    const { absolute, prefix } = queue.shift();
    let children = [];
    try { children = await fs.promises.readdir(absolute, { withFileTypes: true }); }
    catch (_) {
      scanErrors += 1;
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const child of children) {
      if (child.name.startsWith('.') || IGNORED_TOP_LEVEL.has(child.name)) continue;
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const target = path.join(absolute, child.name);
      let stat;
      try { stat = await fs.promises.lstat(target, { bigint: true }); }
      catch (_) {
        scanErrors += 1;
        continue;
      }
      const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      const old = previous.get(relative);
      const size = stat.size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(stat.size) : Number.MAX_SAFE_INTEGER;
      // Preserve the historical Number Stats rounding contract used by public
      // snapshots while retaining exact nanoseconds in the private identity.
      const mtimeMs = Math.trunc(
        Number(stat.mtimeMs) + (Number(stat.mtimeNs % 1000000n) / 1000000)
      );
      // Metadata changes are already a complete invalidation signal. Do not
      // carry the old hash across them, otherwise a later rotating hash pass
      // would emit the same logical modification a second time.
      const oldHash = old && typeof old === 'object' && old.type === 'file' &&
        old.size === size && old.mtimeMs === mtimeMs ? old.contentHash : undefined;
      entries.set(relative, {
        type,
        size,
        mtimeMs,
        ...(type === 'file' && typeof oldHash === 'string' ? { contentHash: oldHash } : {}),
      });
      if (type === 'file') {
        identities.set(relative, {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mode: stat.mode,
          nlink: stat.nlink,
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        });
      }
      if (type === 'directory') {
        directoryIdentities.set(relative, captureDirectoryIdentity(stat));
      }
      if (type === 'directory' && !stat.isSymbolicLink()) queue.push({ absolute: target, prefix: relative });
      if (entries.size >= maxEntries) break;
    }
  }

  const allMarkdown = [...entries.entries()]
    .filter(([relative, entry]) => entry.type === 'file' && /\.(?:md|markdown)$/i.test(relative))
    .map(([relative, entry]) => ({
      relative,
      entry,
      identity: identities.get(relative),
      ancestors: directoryAncestors(relative, directoryIdentities),
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative, 'zh-CN'));
  const markdown = allMarkdown.filter(candidate => candidate.entry.size <= MAX_MARKDOWN_BYTES);
  const edit = markdown.find(candidate => candidate.relative === 'edit.md');
  const rotating = markdown.filter(candidate => candidate !== edit);
  const rawCursor = Number.isInteger(options.cursor) && options.cursor >= 0 ? options.cursor : 0;
  let cursor = rotating.length ? rawCursor % rotating.length : 0;
  let hashedFiles = 0;
  let hashedBytes = 0;
  const hashedPaths = [];
  const hashErrors = [];
  const selected = [];

  function selectCandidate(candidate) {
    if (!candidate || hashedFiles >= maxHashFiles || hashedBytes + candidate.entry.size > maxHashBytes) return false;
    selected.push(candidate);
    hashedFiles += 1;
    hashedBytes += candidate.entry.size;
    hashedPaths.push(candidate.relative);
    return true;
  }

  // edit.md is the project-level prompt and always receives first claim on
  // each round's budget.
  selectCandidate(edit);

  let considered = 0;
  while (rotating.length && considered < rotating.length && hashedFiles < maxHashFiles) {
    const candidate = rotating[cursor];
    cursor = (cursor + 1) % rotating.length;
    considered += 1;
    // If a file cannot fit the remaining byte budget, advance the cursor so a
    // permanently large neighbor cannot starve smaller files behind it.
    selectCandidate(candidate);
    if (hashedBytes >= maxHashBytes) break;
  }

  const customHash = typeof options.hashFile === 'function' || typeof options.openFile === 'function';
  if (customHash) {
    for (const candidate of selected) {
      try {
        const absolute = path.join(rootPath, ...candidate.relative.split('/'));
        candidate.entry.contentHash = typeof options.hashFile === 'function'
          ? await hashFile(absolute)
          : await hashFileByIdentity(absolute, candidate.identity, {
            maxBytes: candidate.entry.size,
            openFile: options.openFile,
          });
      } catch (_) {
        candidate.entry.contentHash = 'unreadable';
        hashErrors.push(candidate.relative);
      }
    }
  } else {
    let worker = options.hashWorker || null;
    let ownsWorker = false;
    try {
      if (options.hashWorkerError) throw options.hashWorkerError;
      if (!worker) {
        worker = createProjectHashWorker(rootPath, {
          helperPath: options.nativeHashHelperPath,
          spawn: options.spawnHashWorker,
          beforeHashOpen: options.beforeHashOpen,
          timeoutMs: options.hashWorkerTimeoutMs,
        });
        ownsWorker = true;
      }
      if (!sameRootBindingIdentity(worker.rootIdentity, rootIdentity)) {
        throw watcherHashError(
          'PROJECT_WATCHER_ROOT_CHANGED',
          'Project root changed between snapshot scan and native hash binding'
        );
      }
      const valid = selected.filter(candidate => Array.isArray(candidate.ancestors));
      for (const candidate of selected) {
        if (!Array.isArray(candidate.ancestors)) {
          candidate.entry.contentHash = 'unreadable';
          hashErrors.push(candidate.relative);
        }
      }
      const results = await worker.hash(valid.map(candidate => ({
        relative: candidate.relative,
        maxBytes: candidate.entry.size,
        identity: candidate.identity,
        ancestors: candidate.ancestors,
      })));
      results.forEach((result, index) => {
        const candidate = valid[index];
        if (result.ok && sameReturnedFileIdentity(result.identity, candidate.identity)) {
          candidate.entry.contentHash = result.digest;
        } else {
          candidate.entry.contentHash = 'unreadable';
          hashErrors.push(candidate.relative);
        }
      });
    } catch (_) {
      for (const candidate of selected) {
        candidate.entry.contentHash = 'unreadable';
        if (!hashErrors.includes(candidate.relative)) hashErrors.push(candidate.relative);
      }
    } finally {
      if (ownsWorker && worker) worker.close();
    }
  }

  return {
    entries,
    nextCursor: cursor,
    stats: {
      entries: entries.size,
      markdownFiles: allMarkdown.length,
      oversizedMarkdownFiles: allMarkdown.length - markdown.length,
      hashedFiles,
      hashedBytes,
      hashedPaths,
      hashErrors,
      hashCoverageComplete: completeHash
        ? hashedFiles === allMarkdown.length && hashErrors.length === 0
        : false,
      scanErrors,
      entryLimitReached: entries.size >= maxEntries,
    },
  };
}

function entryChanged(previous, current) {
  if (typeof previous === 'string' || typeof current === 'string') return previous !== current;
  if (!previous || !current) return previous !== current;
  if (previous.type !== current.type || previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) return true;
  // An absent hash means "not established this round", never "empty content".
  // Only compare content when both snapshots have a real known state.
  return typeof previous.contentHash === 'string' && typeof current.contentHash === 'string' &&
    previous.contentHash !== current.contentHash;
}

function diffSnapshots(previousSnapshot, currentSnapshot) {
  const previous = snapshotEntries(previousSnapshot) || new Map();
  const current = snapshotEntries(currentSnapshot) || new Map();
  const changes = [];
  for (const [watchPath, signature] of current) {
    if (!previous.has(watchPath)) changes.push({ path: watchPath, kind: 'renamed' });
    else if (entryChanged(previous.get(watchPath), signature)) changes.push({ path: watchPath, kind: 'changed' });
  }
  for (const watchPath of previous.keys()) {
    if (!current.has(watchPath)) changes.push({ path: watchPath, kind: 'renamed' });
  }
  return coalesceChanges(changes);
}

function createProjectWatcher(rootPath, onChange, options = {}) {
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  const root = fs.realpathSync(rootPath);
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(20, options.debounceMs) : DEFAULT_DEBOUNCE_MS;
  const watchFn = options.watchFn || fs.watch;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs)
    ? Math.max(0, options.pollIntervalMs)
    : DEFAULT_POLL_INTERVAL_MS;
  const usesCustomHash = typeof options.hashFile === 'function' || typeof options.openFile === 'function';
  let hashWorker = options.hashWorker || null;
  let hashWorkerError = null;
  if (!usesCustomHash && !hashWorker) {
    try {
      hashWorker = createProjectHashWorker(root, {
        helperPath: options.nativeHashHelperPath,
        spawn: options.spawnHashWorker,
        beforeHashOpen: options.beforeHashOpen,
        timeoutMs: options.hashWorkerTimeoutMs,
      });
    } catch (error) {
      hashWorkerError = error;
    }
  }
  const snapshotOptions = {
    maxEntries: options.maxEntries,
    maxHashFiles: options.maxHashFiles,
    maxHashBytes: options.maxHashBytes,
    flushMaxHashFiles: options.flushMaxHashFiles,
    flushMaxHashBytes: options.flushMaxHashBytes,
    hashFile: options.hashFile,
    openFile: options.openFile,
    hashWorker,
    hashWorkerError,
  };
  let closed = false;
  let timer = null;
  let rebuildTimer = null;
  let pending = [];
  let watchers = [];
  let portableMode = false;
  let pollTimer = null;
  let lastSnapshot = null;
  let scanCursor = 0;
  let pollPromise = null;
  let flushPromise = null;
  let strictBaselinePublished = false;

  function disableNativeWatchers() {
    if (closed) return;
    for (const watcher of watchers) try { watcher.close(); } catch (_) {}
    watchers = [];
    portableMode = false;
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    // The bounded polling pass remains authoritative fallback. Native watcher
    // exhaustion (for example EMFILE) must never become an unhandled EventEmitter
    // error that terminates Electron Main.
  }

  function guardWatcher(nativeWatcher) {
    if (!nativeWatcher || typeof nativeWatcher.on !== 'function') {
      throw new TypeError('watchFn must return an EventEmitter-like watcher');
    }
    nativeWatcher.on('error', disableNativeWatchers);
    return nativeWatcher;
  }

  function emit() {
    timer = null;
    if (closed || !pending.length) return 0;
    const changes = coalesceChanges(pending);
    pending = [];
    if (!changes.length) return 0;
    onChange({
      schema: EVENT_SCHEMA,
      reason: 'filesystem',
      changes,
      emittedAt: new Date().toISOString(),
    });
    return changes.length;
  }

  function enqueue(changes) {
    if (closed || !changes.length) return;
    pending.push(...changes);
    clearTimeout(timer);
    timer = setTimeout(emit, debounceMs);
  }

  function record(eventType, filename, prefix = '') {
    if (closed) return;
    const raw = filename === undefined || filename === null
      ? null
      : prefix ? `${prefix}/${Buffer.isBuffer(filename) ? filename.toString('utf8') : filename}` : filename;
    const watchPath = normalizeWatchPath(raw);
    if (raw !== null && watchPath === null) return;
    enqueue([{ path: watchPath, kind: eventType === 'rename' ? 'renamed' : 'changed' }]);
    if (portableMode && eventType === 'rename') {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuildPortable, debounceMs * 2);
    }
  }

  function attachPortable() {
    const attached = [];
    try {
      for (const directory of visibleDirectories(root)) {
        const prefix = path.relative(root, directory).replace(/\\/g, '/');
        attached.push(guardWatcher(watchFn(directory, (eventType, filename) => record(eventType, filename, prefix))));
      }
      portableMode = true;
      watchers = attached;
      return true;
    } catch (_) {
      for (const nativeWatcher of attached) try { nativeWatcher.close(); } catch (_) {}
      portableMode = false;
      watchers = [];
      return false;
    }
  }

  function rebuildPortable() {
    rebuildTimer = null;
    if (closed || !portableMode) return;
    for (const watcher of watchers) try { watcher.close(); } catch (_) {}
    watchers = [];
    attachPortable();
  }

  function pollOnce(strict = false) {
    if (closed) return Promise.resolve(null);
    if (pollPromise) return pollPromise;
    const active = (async () => {
      const next = await projectSnapshot(root, {
        ...snapshotOptions,
        previous: lastSnapshot,
        cursor: scanCursor,
        completeHash: strict,
      });
      if (closed) return null;
      if (next.stats.scanErrors > 0) {
        if (strict) {
          const error = new Error('Project watcher flush scan was incomplete');
          error.code = 'PROJECT_WATCHER_FLUSH_INCOMPLETE';
          throw error;
        }
        return null;
      }
      if (strict && (next.stats.entryLimitReached || !next.stats.hashCoverageComplete)) {
        const error = new Error('Project watcher flush exceeded its authority bounds');
        error.code = 'PROJECT_WATCHER_FLUSH_INCOMPLETE';
        throw error;
      }
      scanCursor = next.nextCursor;
      if (lastSnapshot) enqueue(diffSnapshots(lastSnapshot, next));
      if (strict && !strictBaselinePublished) {
        enqueue([{ path: null, kind: 'invalidated' }]);
        strictBaselinePublished = true;
      }
      lastSnapshot = next;
      return next;
    })().catch(error => {
      if (strict) throw error;
      // Polling is a fallback. Native watch remains active; a transient scan
      // error must not crash the main process or invent a project deletion.
      return null;
    }).finally(() => {
      if (pollPromise === active) pollPromise = null;
    });
    pollPromise = active;
    return active;
  }

  function flush() {
    if (closed) return Promise.resolve(Object.freeze({ ok: false, reason: 'closed' }));
    if (flushPromise) return flushPromise;
    const active = (async () => {
      // A scheduled fallback may already be reading the tree. Let it finish,
      // then force one newer authoritative pass rather than treating that
      // older in-flight snapshot as the barrier.
      if (pollPromise) await pollPromise;
      if (closed) return Object.freeze({ ok: false, reason: 'closed' });
      const snapshot = await pollOnce(true);
      if (closed || !snapshot) return Object.freeze({ ok: false, reason: 'closed' });
      clearTimeout(timer);
      timer = null;
      const emittedChanges = emit();
      return Object.freeze({
        ok: true,
        emittedChanges,
        entries: snapshot.stats.entries,
        hashedFiles: snapshot.stats.hashedFiles,
      });
    })().finally(() => {
      if (flushPromise === active) flushPromise = null;
    });
    flushPromise = active;
    return active;
  }

  try {
    watchers = [guardWatcher(watchFn(root, { recursive: true }, (eventType, filename) => record(eventType, filename)))];
  } catch (error) {
    if (error && ['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'ERR_INVALID_ARG_VALUE'].includes(error.code)) {
      attachPortable();
    } else {
      // Resource exhaustion and permission errors can be transient. Keep the
      // bounded polling fallback alive instead of leaving the project with no
      // watcher or crashing Main during open.
      watchers = [];
      portableMode = false;
    }
  }

  if (pollIntervalMs > 0) {
    void pollOnce();
    pollTimer = setInterval(() => { void pollOnce(); }, pollIntervalMs);
    pollTimer.unref?.();
  }

  return Object.freeze({
    flush,
    pauseAndFlush() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(rebuildTimer);
      clearInterval(pollTimer);
      const changes = coalesceChanges(pending);
      pending = [];
      for (const watcher of watchers) try { watcher.close(); } catch (_) {}
      watchers = [];
      hashWorker?.close();
      if (changes.length) {
        onChange({
          schema: EVENT_SCHEMA,
          reason: 'filesystem',
          changes,
          emittedAt: new Date().toISOString(),
        });
      }
      return changes.length;
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearTimeout(rebuildTimer);
      clearInterval(pollTimer);
      pending = [];
      for (const watcher of watchers) try { watcher.close(); } catch (_) {}
      watchers = [];
      hashWorker?.close();
    },
  });
}

module.exports = {
  EVENT_SCHEMA,
  MAX_MARKDOWN_BYTES,
  DEFAULT_HASH_FILES_PER_ROUND,
  DEFAULT_HASH_BYTES_PER_ROUND,
  hashFileByIdentity,
  normalizeWatchPath,
  coalesceChanges,
  projectSnapshot,
  diffSnapshots,
  createProjectWatcher,
};
