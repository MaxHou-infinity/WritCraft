'use strict';

const crypto = require('crypto');
const schema = require('./evidence-delivery-schema');

const COMPARE_KIND = 'SNAPSHOT_COMPARE';
const DIFF_PAGE_MAX_BYTES = 256 * 1024;
const DIFF_FILE_MAX_BYTES = 32 * 1024 * 1024;
const DIFF_COMPARISON_MAX_BYTES = 256 * 1024 * 1024;
const DIFF_LINE_MAX_BYTES = 64 * 1024;
const DIFF_CONTEXT_LINES = 3;
const DIFF_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_COMPARE_CONTEXTS = 64;
const DIFF_CONTEXT_TOTAL_MAX_BYTES = DIFF_COMPARISON_MAX_BYTES + (8 * 1024 * 1024);
const DIFF_BUILD_PEAK_MAX_BYTES = 672 * 1024 * 1024;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const IMAGE_PATH_RE = /\.(?:png|jpe?g|gif|webp)$/iu;
const FILE_STATES = new Set(['available', 'conflict', 'unavailable']);
const COMPARE_STATUSES = new Set([
  'same', 'modified', 'missing', 'added', 'conflict', 'unavailable',
]);

class SnapshotCompareServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotCompareServiceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotCompareServiceError(code, message);
}

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function exact(value, keys, field) {
  try { return schema.assertExactKeys(value, keys, field); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`); }
}

function assertOwner(value) {
  exact(value, ['ownerId', 'projectInstanceId', 'ownerGeneration'], 'snapshot compare owner');
  if (typeof value.ownerId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.ownerId)) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot compare owner is invalid');
  }
  try {
    schema.assertProjectInstanceId(value.projectInstanceId);
    schema.assertSafeInteger(value.ownerGeneration, 'ownerGeneration');
  } catch (_) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot compare owner is invalid');
  }
  return Object.freeze({ ...value });
}

function assertRelativePath(value, kind, field) {
  try {
    schema.assertString(value, field, { minBytes: 1, maxBytes: 4096, maxScalars: 1024 });
  } catch (_) {
    fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`);
  }
  const segments = value.split('/');
  if (value.startsWith('/') || value.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' ||
        segment.startsWith('.') || segment === '.writcraft') ||
      (kind === 'markdown' && !/\.(?:md|markdown)$/iu.test(value)) ||
      (kind === 'image' && !IMAGE_PATH_RE.test(value))) {
    fail('SNAPSHOT_COMPARE_INVALID', `${field} is not an allowed project-relative path`);
  }
  return value;
}

function assertRevision(value, field) {
  try {
    schema.assertString(value, field, { ascii: true, pattern: REVISION_RE, minBytes: 64, maxBytes: 64 });
  } catch (_) {
    fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`);
  }
  return value;
}

function assertDigest(value, field) {
  try { return schema.assertDigest(value, field); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`); }
}

function assertOpaque(value, field) {
  try { return schema.assertOpaqueId(value, field); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`); }
}

function assertInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  try { return schema.assertSafeInteger(value, field, 0, maximum); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`); }
}

function assertTimestamp(value, field) {
  try { return schema.assertTimestamp(value, field); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is invalid`); }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function asMarkdownBytes(value, byteLength, digest, revision, field) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    fail('SNAPSHOT_COMPARE_INVALID', `${field} content is invalid`);
  }
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'utf8');
  if (bytes.length !== byteLength || sha256(bytes) !== digest || digest.slice(7) !== revision) {
    fail('SNAPSHOT_COMPARE_STALE', `${field} content authority drifted`);
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { fail('SNAPSHOT_COMPARE_INVALID', `${field} is not strict UTF-8 Markdown`); }
  return bytes;
}

function validateSnapshotFile(value, index) {
  exact(value, [
    'fileId', 'path', 'kind', 'byteLength', 'sha256', 'revision', 'content',
  ], `snapshot files[${index}]`);
  assertOpaque(value.fileId, `snapshot files[${index}].fileId`);
  if (!['markdown', 'image'].includes(value.kind)) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot file kind is invalid');
  }
  assertRelativePath(value.path, value.kind, `snapshot files[${index}].path`);
  assertInteger(value.byteLength, `snapshot files[${index}].byteLength`, schema.SNAPSHOT_LIMITS.maxImageFileBytes);
  assertDigest(value.sha256, `snapshot files[${index}].sha256`);
  assertRevision(value.revision, `snapshot files[${index}].revision`);
  let bytes = null;
  if (value.kind === 'markdown') {
    if (value.byteLength > schema.SNAPSHOT_LIMITS.maxMarkdownFileBytes) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot Markdown exceeds the frozen snapshot budget');
    }
    bytes = asMarkdownBytes(value.content, value.byteLength, value.sha256, value.revision,
      `snapshot files[${index}]`);
  } else if (value.content !== null) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot image bytes must remain inside the snapshot reader');
  }
  return Object.freeze({
    fileId: value.fileId,
    path: value.path,
    kind: value.kind,
    byteLength: value.byteLength,
    sha256: value.sha256,
    revision: value.revision,
    bytes,
  });
}

function validateSnapshot(value, expectedProjectId, expectedSnapshotId) {
  exact(value, [
    'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
    'publishedIdentityDigest', 'createdAt', 'files',
  ], 'snapshot compare sealed snapshot');
  try { schema.assertProjectInstanceId(value.projectInstanceId); } catch (_) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot project identity is invalid');
  }
  assertOpaque(value.snapshotId, 'snapshotId');
  assertDigest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  assertDigest(value.publishedIdentityDigest, 'publishedIdentityDigest');
  assertTimestamp(value.createdAt, 'snapshot createdAt');
  if (value.projectInstanceId !== expectedProjectId || value.snapshotId !== expectedSnapshotId ||
      !Array.isArray(value.files) || value.files.length > schema.SNAPSHOT_LIMITS.maxTotalItems) {
    fail('SNAPSHOT_COMPARE_STALE', 'Snapshot authority does not match the request');
  }
  const ids = new Set();
  const paths = new Set();
  let previousPath = null;
  let markdownCount = 0;
  let imageCount = 0;
  let markdownBytes = 0;
  let totalBytes = 0;
  const files = value.files.map((file, index) => {
    const validated = validateSnapshotFile(file, index);
    if (ids.has(validated.fileId) || paths.has(validated.path) ||
        (previousPath !== null && schema.compareUtf8Bytes(previousPath, validated.path) >= 0)) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot file identities are duplicate or unsorted');
    }
    ids.add(validated.fileId);
    paths.add(validated.path);
    previousPath = validated.path;
    totalBytes += validated.byteLength;
    if (validated.kind === 'markdown') {
      markdownCount += 1;
      markdownBytes += validated.byteLength;
    }
    else imageCount += 1;
    return validated;
  });
  if (markdownCount > schema.SNAPSHOT_LIMITS.maxMarkdownFiles ||
      imageCount > schema.SNAPSHOT_LIMITS.maxImageFiles ||
      markdownBytes > schema.SNAPSHOT_LIMITS.maxMarkdownTotalBytes ||
      totalBytes > schema.SNAPSHOT_LIMITS.maxSnapshotBytes) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot files exceed the frozen budget');
  }
  return Object.freeze({ ...value, files: Object.freeze(files), markdownBytes });
}

function validateCurrentFile(value, index) {
  exact(value, [
    'fileId', 'path', 'kind', 'state', 'byteLength', 'sha256', 'revision', 'content',
  ], `current files[${index}]`);
  assertOpaque(value.fileId, `current files[${index}].fileId`);
  if (!['markdown', 'image'].includes(value.kind) || !FILE_STATES.has(value.state)) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Current file kind/state is invalid');
  }
  assertRelativePath(value.path, value.kind, `current files[${index}].path`);
  if (value.state !== 'available') {
    if (value.byteLength !== null || value.sha256 !== null || value.revision !== null ||
        value.content !== null) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Unavailable current file leaked untrusted metadata');
    }
    return Object.freeze({
      fileId: value.fileId,
      path: value.path,
      kind: value.kind,
      state: value.state,
      byteLength: null,
      sha256: null,
      revision: null,
      bytes: null,
    });
  }
  assertInteger(value.byteLength, `current files[${index}].byteLength`, DIFF_FILE_MAX_BYTES);
  assertDigest(value.sha256, `current files[${index}].sha256`);
  assertRevision(value.revision, `current files[${index}].revision`);
  let bytes = null;
  if (value.kind === 'markdown') {
    bytes = asMarkdownBytes(value.content, value.byteLength, value.sha256, value.revision,
      `current files[${index}]`);
  } else if (value.content !== null) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Current image bytes must remain inside the trusted reader');
  }
  return Object.freeze({
    fileId: value.fileId,
    path: value.path,
    kind: value.kind,
    state: value.state,
    byteLength: value.byteLength,
    sha256: value.sha256,
    revision: value.revision,
    bytes,
  });
}

function validateCurrent(value, expectedProjectId, expectedGeneration,
  maxMarkdownTotalBytes = schema.SNAPSHOT_LIMITS.maxMarkdownTotalBytes) {
  exact(value, [
    'projectInstanceId', 'mutationGeneration', 'fileRevisionSetDigest', 'files',
  ], 'snapshot compare current project');
  try { schema.assertProjectInstanceId(value.projectInstanceId); } catch (_) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Current project identity is invalid');
  }
  assertInteger(value.mutationGeneration, 'current mutationGeneration');
  assertDigest(value.fileRevisionSetDigest, 'current fileRevisionSetDigest');
  if (value.projectInstanceId !== expectedProjectId ||
      value.mutationGeneration !== expectedGeneration || !Array.isArray(value.files) ||
      value.files.length > schema.SNAPSHOT_LIMITS.maxTotalItems) {
    fail('SNAPSHOT_COMPARE_STALE', 'Current project authority drifted across the watcher barrier');
  }
  const ids = new Set();
  const paths = new Set();
  let previousPath = null;
  let markdownCount = 0;
  let imageCount = 0;
  let markdownBytes = 0;
  const files = value.files.map((file, index) => {
    const validated = validateCurrentFile(file, index);
    if (ids.has(validated.fileId) || paths.has(validated.path) ||
        (previousPath !== null && schema.compareUtf8Bytes(previousPath, validated.path) >= 0)) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Current file identities are duplicate or unsorted');
    }
    ids.add(validated.fileId);
    paths.add(validated.path);
    previousPath = validated.path;
    if (validated.kind === 'markdown') {
      markdownCount += 1;
      if (validated.state === 'available') markdownBytes += validated.byteLength;
    } else {
      imageCount += 1;
    }
    return validated;
  });
  if (markdownCount > schema.SNAPSHOT_LIMITS.maxMarkdownFiles ||
      imageCount > schema.SNAPSHOT_LIMITS.maxImageFiles ||
      markdownBytes > maxMarkdownTotalBytes) {
    fail('SNAPSHOT_COMPARE_INVALID', 'Current project files exceed the frozen comparison budget');
  }
  return Object.freeze({ ...value, files: Object.freeze(files), markdownBytes });
}

function allocateOpaque(prefix, randomBytes, occupied) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let bytes;
    try { bytes = randomBytes(16); } catch (_) {
      fail('SNAPSHOT_COMPARE_ID_UNAVAILABLE', 'Snapshot compare identity is unavailable');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
      fail('SNAPSHOT_COMPARE_ID_UNAVAILABLE', 'Snapshot compare identity is unavailable');
    }
    const value = `${prefix}${bytes.toString('hex')}`;
    if (!occupied.has(value)) {
      occupied.add(value);
      return value;
    }
  }
  fail('SNAPSHOT_COMPARE_ID_UNAVAILABLE', 'Snapshot compare identity collided');
}

async function commonPrefixBytes(before, after, runtime) {
  const limit = Math.min(before.length, after.length);
  let offset = 0;
  while (offset < limit) {
    const end = Math.min(limit, offset + DIFF_SCAN_CHUNK_BYTES);
    const left = before.subarray(offset, end);
    const right = after.subarray(offset, end);
    if (!left.equals(right)) {
      for (let index = offset; index < end; index += 1) {
        if (before[index] !== after[index]) return index;
      }
    }
    offset = end;
    await runtime.checkpoint();
  }
  return limit;
}

async function commonSuffixBytes(before, after, prefixBytes, runtime) {
  const limit = Math.min(before.length, after.length) - prefixBytes;
  let matched = 0;
  while (matched < limit) {
    const size = Math.min(DIFF_SCAN_CHUNK_BYTES, limit - matched);
    const leftStart = before.length - matched - size;
    const rightStart = after.length - matched - size;
    const left = before.subarray(leftStart, leftStart + size);
    const right = after.subarray(rightStart, rightStart + size);
    if (!left.equals(right)) {
      for (let index = 1; index <= size; index += 1) {
        if (before[before.length - matched - index] !== after[after.length - matched - index]) {
          return matched + index - 1;
        }
      }
    }
    matched += size;
    await runtime.checkpoint();
  }
  return matched;
}

function lineStart(buffer, offset) {
  if (offset <= 0) return 0;
  const newline = buffer.lastIndexOf(0x0a, offset - 1);
  return newline < 0 ? 0 : newline + 1;
}

function lineEnd(buffer, offset) {
  if (offset >= buffer.length) return buffer.length;
  const newline = buffer.indexOf(0x0a, offset);
  return newline < 0 ? buffer.length : newline + 1;
}

function contextStart(buffer, offset) {
  let result = offset;
  for (let count = 0; count < DIFF_CONTEXT_LINES && result > 0; count += 1) {
    result = lineStart(buffer, Math.max(0, result - 1));
  }
  return result;
}

function contextEnd(buffer, offset) {
  let result = offset;
  for (let count = 0; count < DIFF_CONTEXT_LINES && result < buffer.length; count += 1) {
    result = lineEnd(buffer, result);
  }
  return result;
}

async function countNewlines(buffer, end, runtime) {
  let count = 0;
  for (let offset = 0; offset < end; offset += DIFF_SCAN_CHUNK_BYTES) {
    const limit = Math.min(end, offset + DIFF_SCAN_CHUNK_BYTES);
    for (let index = offset; index < limit; index += 1) {
      if (buffer[index] === 0x0a) count += 1;
    }
    await runtime.checkpoint();
  }
  return count;
}

async function collectDiffLines(buffer, start, end, kind, runtime, budget) {
  const lines = [];
  let cursor = start;
  while (cursor < end) {
    const newline = buffer.indexOf(0x0a, cursor);
    const hasNewline = newline >= 0 && newline < end;
    const lineEndOffset = hasNewline ? newline + 1 : end;
    const byteLength = lineEndOffset - cursor;
    if (byteLength > DIFF_LINE_MAX_BYTES) return null;
    const text = buffer.subarray(cursor, lineEndOffset).toString('utf8');
    const line = Object.freeze({ kind, text });
    budget.bytes += Buffer.byteLength(JSON.stringify(line), 'utf8') + 1;
    if (budget.bytes > DIFF_FILE_MAX_BYTES) return null;
    lines.push(line);
    cursor = lineEndOffset;
    if (lines.length % 64 === 0) await runtime.checkpoint();
  }
  return lines;
}

async function diffHunks(before, after, runtime) {
  const prefix = await commonPrefixBytes(before, after, runtime);
  const suffix = await commonSuffixBytes(before, after, prefix, runtime);
  const beforeChangeStart = lineStart(before, prefix);
  const afterChangeStart = lineStart(after, prefix);
  const beforeChangeEnd = lineEnd(before, before.length - suffix);
  const afterChangeEnd = lineEnd(after, after.length - suffix);
  const beforeContextStart = contextStart(before, beforeChangeStart);
  const afterContextStart = contextStart(after, afterChangeStart);
  const beforeContextEnd = contextEnd(before, beforeChangeEnd);
  const afterContextEnd = contextEnd(after, afterChangeEnd);
  const oldStart = (await countNewlines(before, beforeContextStart, runtime)) + 1;
  const newStart = (await countNewlines(after, afterContextStart, runtime)) + 1;
  const budget = { bytes: 128 };
  const prefixLines = await collectDiffLines(
    before, beforeContextStart, beforeChangeStart, 'context', runtime, budget
  );
  const deletedLines = await collectDiffLines(
    before, beforeChangeStart, beforeChangeEnd, 'delete', runtime, budget
  );
  const insertedLines = await collectDiffLines(
    after, afterChangeStart, afterChangeEnd, 'insert', runtime, budget
  );
  const suffixLines = await collectDiffLines(
    before, beforeChangeEnd, beforeContextEnd, 'context', runtime, budget
  );
  if (!prefixLines || !deletedLines || !insertedLines || !suffixLines) {
    return Object.freeze({ hunks: [], truncated: true });
  }
  const lines = Object.freeze([...prefixLines, ...deletedLines, ...insertedLines, ...suffixLines]);
  const hunk = Object.freeze({
    oldStart,
    oldLines: prefixLines.length + deletedLines.length + suffixLines.length,
    newStart,
    newLines: prefixLines.length + insertedLines.length + suffixLines.length,
    lines,
  });
  return Object.freeze({ hunks: Object.freeze([hunk]), truncated: false });
}

function diffBodyBytes(hunks) {
  return Buffer.byteLength(JSON.stringify({ hunks }), 'utf8');
}

function advanceLine(position, line) {
  return {
    oldLine: position.oldLine + (line.kind === 'insert' ? 0 : 1),
    newLine: position.newLine + (line.kind === 'delete' ? 0 : 1),
  };
}

function pageByteLength(projectInstanceId, snapshotId, diffId, fileId, hunks, truncated) {
  return Buffer.byteLength(JSON.stringify({
    schema: schema.SCHEMAS.SNAPSHOT_DIFF,
    projectInstanceId,
    snapshotId,
    diffId,
    fileId,
    pageIndex: 9999,
    pageCount: 9999,
    hunks,
    nextPageToken: `diff_cursor_${'f'.repeat(32)}`,
    truncated,
  }), 'utf8');
}

function paginateHunks(projectInstanceId, snapshotId, diffId, fileId, hunks) {
  if (!hunks.length) return [[]];
  const pages = [];
  for (const hunk of hunks) {
    let position = { oldLine: hunk.oldStart, newLine: hunk.newStart };
    let fragment = {
      oldStart: position.oldLine,
      oldLines: 0,
      newStart: position.newLine,
      newLines: 0,
      lines: [],
    };
    let estimatedBytes = 1024;
    for (const line of hunk.lines) {
      const lineBytes = Buffer.byteLength(JSON.stringify(line), 'utf8') + 1;
      if (fragment.lines.length > 0 && estimatedBytes + lineBytes > DIFF_PAGE_MAX_BYTES - 512) {
        const page = [fragment];
        if (pageByteLength(projectInstanceId, snapshotId, diffId, fileId, page, false) >
            DIFF_PAGE_MAX_BYTES) return null;
        pages.push(page);
        fragment = {
          oldStart: position.oldLine,
          oldLines: 0,
          newStart: position.newLine,
          newLines: 0,
          lines: [],
        };
        estimatedBytes = 1024;
      }
      fragment.lines.push(line);
      fragment.oldLines += line.kind === 'insert' ? 0 : 1;
      fragment.newLines += line.kind === 'delete' ? 0 : 1;
      estimatedBytes += lineBytes;
      position = advanceLine(position, line);
    }
    if (fragment.lines.length) {
      const page = [fragment];
      if (pageByteLength(projectInstanceId, snapshotId, diffId, fileId, page, false) >
          DIFF_PAGE_MAX_BYTES) return null;
      pages.push(page);
    }
  }
  if (pages.length > 4097) return null;
  return pages;
}

function freezePage(value) {
  for (const hunk of value.hunks) {
    for (const line of hunk.lines) Object.freeze(line);
    Object.freeze(hunk.lines);
    Object.freeze(hunk);
  }
  Object.freeze(value.hunks);
  return Object.freeze(value);
}

function createSnapshotCompareService(options = {}) {
  const localOperations = options.localOperations;
  const capabilityStore = options.capabilityStore;
  if (!localOperations || typeof localOperations.begin !== 'function') {
    throw new TypeError('localOperations.begin is required');
  }
  if (!capabilityStore || typeof capabilityStore.issueCompare !== 'function' ||
      typeof capabilityStore.resolveDiff !== 'function' ||
      typeof capabilityStore.invalidateProject !== 'function') {
    throw new TypeError('snapshot capability store is required');
  }
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : crypto.randomBytes;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const monotonicClock = typeof options.monotonicClock === 'function'
    ? options.monotonicClock
    : Date.now;
  const comparisonDeadlineMs = Number.isSafeInteger(options.comparisonDeadlineMs) &&
      options.comparisonDeadlineMs > 0
    ? Math.min(options.comparisonDeadlineMs, 60000)
    : 60000;
  const currentMarkdownTotalBudgetBytes = Number.isSafeInteger(
    options.currentMarkdownTotalBudgetBytes
  ) && options.currentMarkdownTotalBudgetBytes > 0
    ? Math.min(options.currentMarkdownTotalBudgetBytes, schema.SNAPSHOT_LIMITS.maxMarkdownTotalBytes)
    : schema.SNAPSHOT_LIMITS.maxMarkdownTotalBytes;
  const yieldControl = typeof options.yieldControl === 'function'
    ? options.yieldControl
    : () => new Promise(resolve => setImmediate(resolve));
  const maxContextBytes = Number.isSafeInteger(options.contextBudgetBytes) &&
      options.contextBudgetBytes > 0
    ? Math.min(options.contextBudgetBytes, DIFF_CONTEXT_TOTAL_MAX_BYTES)
    : DIFF_CONTEXT_TOTAL_MAX_BYTES;
  const setExpiryTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearExpiryTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  const acquireLease = typeof options.acquireLease === 'function'
    ? options.acquireLease
    : async () => fail('SNAPSHOT_LEASE_UNAVAILABLE', 'Snapshot compare lease is unavailable');
  const releaseLease = typeof options.releaseLease === 'function'
    ? options.releaseLease
    : async () => {};
  const assertOwnerCurrent = typeof options.assertOwnerCurrent === 'function'
    ? options.assertOwnerCurrent
    : () => fail('SNAPSHOT_OWNER_UNAVAILABLE', 'Snapshot compare owner is unavailable');
  const assertProjectCurrent = typeof options.assertProjectCurrent === 'function'
    ? options.assertProjectCurrent
    : () => fail('SNAPSHOT_OWNER_UNAVAILABLE', 'Snapshot project owner is unavailable');
  const settleWatcherBarrier = typeof options.settleWatcherBarrier === 'function'
    ? options.settleWatcherBarrier
    : async () => fail('SNAPSHOT_BARRIER_UNAVAILABLE', 'Snapshot watcher barrier is unavailable');
  const readSnapshot = typeof options.readSnapshot === 'function'
    ? options.readSnapshot
    : async () => fail('SNAPSHOT_READER_UNAVAILABLE', 'Snapshot reader is unavailable');
  const readCurrent = typeof options.readCurrent === 'function'
    ? options.readCurrent
    : async () => fail('PROJECT_READER_UNAVAILABLE', 'Trusted current project reader is unavailable');
  const readSnapshotAuthority = typeof options.readSnapshotAuthority === 'function'
    ? options.readSnapshotAuthority
    : async () => fail('SNAPSHOT_READER_UNAVAILABLE', 'Snapshot authority reader is unavailable');
  const readCurrentAuthority = typeof options.readCurrentAuthority === 'function'
    ? options.readCurrentAuthority
    : async () => fail('PROJECT_READER_UNAVAILABLE', 'Current revision authority is unavailable');
  const listSnapshots = typeof options.listSnapshots === 'function'
    ? options.listSnapshots
    : async () => fail('SNAPSHOT_READER_UNAVAILABLE', 'Snapshot list reader is unavailable');
  const acquireReadLease = typeof options.acquireReadLease === 'function'
    ? options.acquireReadLease
    : async () => fail('SNAPSHOT_READ_LEASE_UNAVAILABLE', 'Snapshot read lease is unavailable');
  const releaseReadLease = typeof options.releaseReadLease === 'function'
    ? options.releaseReadLease
    : async () => fail('SNAPSHOT_READ_LEASE_UNAVAILABLE', 'Snapshot read lease is unavailable');
  const assertReadLeaseCurrent = typeof options.assertReadLeaseCurrent === 'function'
    ? options.assertReadLeaseCurrent
    : () => fail('SNAPSHOT_READ_LEASE_UNAVAILABLE', 'Snapshot read lease is unavailable');
  const contexts = new Map();
  let usedContextBytes = 0;

  async function callAdapter(fn, request, fallback, label) {
    try {
      return await fn(request);
    } catch (error) {
      throw new SnapshotCompareServiceError(stableCode(error, fallback), `${label} failed closed`);
    }
  }

  function callSyncAdapter(fn, request, fallback, label) {
    try {
      return fn(request);
    } catch (error) {
      throw new SnapshotCompareServiceError(stableCode(error, fallback), `${label} failed closed`);
    }
  }

  function parseContextMetadata(context) {
    try {
      const value = JSON.parse(context.metadataBuffer.toString('utf8'));
      exact(value, [
        'schema', 'capabilityId', 'expiresAt', 'ownerId', 'projectInstanceId',
        'ownerGeneration', 'snapshotId', 'snapshotManifestDigest',
        'publishedIdentityDigest', 'currentMutationGeneration',
        'currentFileRevisionSetDigest', 'comparisonDigest', 'binding', 'pages',
      ], 'snapshot diff context metadata');
      if (value.schema !== 'writcraft.snapshot-diff-context/v1') {
        fail('SNAPSHOT_DIFF_UNAVAILABLE', 'Snapshot diff context metadata is invalid');
      }
      return value;
    } catch (error) {
      if (error instanceof SnapshotCompareServiceError) throw error;
      fail('SNAPSHOT_DIFF_UNAVAILABLE', 'Snapshot diff context metadata is invalid');
    }
  }

  function removeContext(capabilityId, releaseCapability = true) {
    const context = contexts.get(capabilityId);
    if (!context) return false;
    contexts.delete(capabilityId);
    usedContextBytes = Math.max(0, usedContextBytes - context.contextBytes);
    if (context.expiryTimer) clearExpiryTimer(context.expiryTimer);
    if (releaseCapability) {
      try {
        const metadata = parseContextMetadata(context);
        capabilityStore.release({
          ownerId: metadata.ownerId,
          projectInstanceId: metadata.projectInstanceId,
          ownerGeneration: metadata.ownerGeneration,
        }, { capabilityId });
      } catch (_) {}
    }
    return true;
  }

  function removeExactContext(capabilityId, expectedContext, releaseCapability = true) {
    if (contexts.get(capabilityId) !== expectedContext) return false;
    return removeContext(capabilityId, releaseCapability);
  }

  function pruneDeadContexts() {
    if (typeof capabilityStore.inspect !== 'function') return;
    for (const capabilityId of [...contexts.keys()]) {
      let alive = false;
      try { alive = capabilityStore.inspect(capabilityId) !== null; } catch (_) {}
      if (!alive) removeContext(capabilityId, false);
    }
  }

  function cleanupTombstonedContext(capabilityId) {
    if (typeof capabilityStore.inspect !== 'function') return false;
    let alive = false;
    try { alive = capabilityStore.inspect(capabilityId) !== null; } catch (_) {}
    if (!alive) return removeContext(capabilityId, false);
    return false;
  }

  function reserveContextBytes(byteLength) {
    assertInteger(byteLength, 'snapshot compare context bytes', DIFF_CONTEXT_TOTAL_MAX_BYTES);
    pruneDeadContexts();
    while (contexts.size >= MAX_COMPARE_CONTEXTS ||
        usedContextBytes + byteLength > maxContextBytes) {
      const oldest = contexts.keys().next().value;
      if (!oldest) break;
      removeContext(oldest, true);
    }
    if (usedContextBytes + byteLength > maxContextBytes) {
      fail('SNAPSHOT_DIFF_BUDGET_EXCEEDED', 'Snapshot diff context memory budget is exhausted');
    }
  }

  function isoNow() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot compare clock is invalid');
    }
    return new Date(value).toISOString();
  }

  function compareRequest(value, owner) {
    exact(value, ['schema', 'projectInstanceId', 'snapshotId'], 'snapshot compare request');
    if (value.schema !== schema.SCHEMAS.SNAPSHOT_COMPARE_REQUEST ||
        value.projectInstanceId !== owner.projectInstanceId) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot compare request is invalid');
    }
    assertOpaque(value.snapshotId, 'snapshotId');
    return Object.freeze({ ...value });
  }

  function listRequest(value, owner) {
    exact(value, ['schema', 'projectInstanceId'], 'snapshot list request');
    if (value.schema !== schema.SCHEMAS.SNAPSHOT_LIST_REQUEST ||
        value.projectInstanceId !== owner.projectInstanceId) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot list request is invalid');
    }
    return Object.freeze({ ...value });
  }

  function validateList(value, owner) {
    exact(value, ['items', 'unavailableCount', 'capacity'], 'snapshot list authority');
    if (!Array.isArray(value.items) || value.items.length > 256) {
      fail('SNAPSHOT_LIST_INVALID', 'Snapshot list items are invalid');
    }
    const seen = new Set();
    const items = value.items.map((item, index) => {
      exact(item, [
        'snapshotId', 'createdAt', 'status', 'markdownCount', 'imageCount',
        'totalBytes', 'snapshotManifestDigest',
      ], `snapshot list items[${index}]`);
      assertOpaque(item.snapshotId, `snapshot list items[${index}].snapshotId`);
      assertTimestamp(item.createdAt, `snapshot list items[${index}].createdAt`);
      if (!['available', 'unavailable'].includes(item.status) || seen.has(item.snapshotId)) {
        fail('SNAPSHOT_LIST_INVALID', 'Snapshot list item is invalid or duplicate');
      }
      seen.add(item.snapshotId);
      assertInteger(item.markdownCount, 'markdownCount', schema.SNAPSHOT_LIMITS.maxMarkdownFiles);
      assertInteger(item.imageCount, 'imageCount', schema.SNAPSHOT_LIMITS.maxImageFiles);
      assertInteger(item.totalBytes, 'totalBytes', schema.SNAPSHOT_LIMITS.maxSnapshotBytes);
      assertDigest(item.snapshotManifestDigest, 'snapshotManifestDigest');
      return Object.freeze({ ...item });
    });
    assertInteger(value.unavailableCount, 'unavailableCount', 1000000);
    exact(value.capacity, [
      'maxSnapshots', 'maxPrivateBytes', 'usedSnapshots', 'usedPrivateBytes',
    ], 'snapshot list capacity');
    for (const key of Object.keys(value.capacity)) assertInteger(value.capacity[key], `capacity.${key}`);
    const result = {
      schema: schema.SCHEMAS.SNAPSHOT_LIST,
      projectInstanceId: owner.projectInstanceId,
      items,
      unavailableCount: value.unavailableCount,
      capacity: Object.freeze({ ...value.capacity }),
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4 * 1024 * 1024) {
      fail('SNAPSHOT_LIST_INVALID', 'Snapshot list public projection exceeds its budget');
    }
    return Object.freeze(result);
  }

  async function list(rawOwner, rawRequest) {
    pruneDeadContexts();
    const owner = assertOwner(rawOwner);
    const request = listRequest(rawRequest, owner);
    const value = await callAdapter(
      listSnapshots,
      Object.freeze({ projectInstanceId: request.projectInstanceId }),
      'SNAPSHOT_LIST_FAILED',
      'Snapshot list adapter'
    );
    callSyncAdapter(assertOwnerCurrent, owner, 'PROJECT_CHANGED', 'Snapshot list owner check');
    callSyncAdapter(assertProjectCurrent, owner, 'PROJECT_CHANGED', 'Snapshot list owner check');
    const result = validateList(value, owner);
    callSyncAdapter(assertOwnerCurrent, owner, 'PROJECT_CHANGED', 'Snapshot list final owner check');
    callSyncAdapter(assertProjectCurrent, owner, 'PROJECT_CHANGED', 'Snapshot list final owner check');
    return result;
  }

  function serializeDiffPages(snapshot, fileId, diffId, pages, truncated, cursorIds) {
    const diffCursors = pages.slice(1).map(() =>
      allocateOpaque('diff_cursor_', randomBytes, cursorIds));
    const pageBuffers = pages.map((hunks, pageIndex) => {
      const page = freezePage({
        schema: schema.SCHEMAS.SNAPSHOT_DIFF,
        projectInstanceId: snapshot.projectInstanceId,
        snapshotId: snapshot.snapshotId,
        diffId,
        fileId,
        pageIndex,
        pageCount: pages.length,
        hunks: hunks.map(hunk => ({ ...hunk, lines: hunk.lines.map(line => ({ ...line })) })),
        nextPageToken: pageIndex + 1 < pages.length ? diffCursors[pageIndex] : null,
        truncated,
      });
      const bytes = Buffer.from(JSON.stringify(page), 'utf8');
      if (bytes.length > DIFF_PAGE_MAX_BYTES) {
        fail('SNAPSHOT_DIFF_BUDGET_EXCEEDED', 'Snapshot diff page exceeds its frozen budget');
      }
      return bytes;
    });
    return Object.freeze({
      diffCursors: Object.freeze(diffCursors),
      pageBuffers: Object.freeze(pageBuffers),
    });
  }

  async function createDiff(snapshot, current, snapshotFile, currentFile, status, occupied,
    cursorIds, runtime) {
    if (snapshotFile?.kind !== 'markdown' && currentFile?.kind !== 'markdown') {
      return Object.freeze({
        diffId: null, truncated: false, diffCursors: Object.freeze([]), pageBuffers: Object.freeze([]),
      });
    }
    if (!['same', 'modified', 'missing', 'added'].includes(status)) {
      return Object.freeze({
        diffId: null, truncated: false, diffCursors: Object.freeze([]), pageBuffers: Object.freeze([]),
      });
    }
    const diffId = allocateOpaque('snapshot_diff_', randomBytes, occupied);
    const fileId = snapshotFile?.fileId || currentFile.fileId;
    if (status === 'same') {
      return Object.freeze({
        diffId,
        truncated: false,
        ...serializeDiffPages(snapshot, fileId, diffId, [[]], false, cursorIds),
      });
    }
    const before = snapshotFile?.bytes || Buffer.alloc(0);
    const after = currentFile?.bytes || Buffer.alloc(0);
    const generated = await diffHunks(before, after, runtime);
    const bodyBytes = generated.truncated ? DIFF_FILE_MAX_BYTES + 1 : diffBodyBytes(generated.hunks);
    if (generated.truncated || bodyBytes > DIFF_FILE_MAX_BYTES) {
      return Object.freeze({
        diffId,
        truncated: true,
        bodyBytes,
        ...serializeDiffPages(snapshot, fileId, diffId, [[]], true, cursorIds),
      });
    }
    const pages = paginateHunks(
      snapshot.projectInstanceId, snapshot.snapshotId, diffId,
      snapshotFile?.fileId || currentFile.fileId, generated.hunks
    );
    if (!pages) {
      return Object.freeze({
        diffId,
        truncated: true,
        bodyBytes: DIFF_FILE_MAX_BYTES + 1,
        ...serializeDiffPages(snapshot, fileId, diffId, [[]], true, cursorIds),
      });
    }
    return Object.freeze({
      diffId,
      truncated: false,
      bodyBytes,
      ...serializeDiffPages(snapshot, fileId, diffId, pages, false, cursorIds),
    });
  }

  async function buildComparison(snapshot, current, runtime) {
    const snapshotByPath = new Map(snapshot.files.map(file => [file.path, file]));
    const currentByPath = new Map(current.files.map(file => [file.path, file]));
    const paths = [...new Set([...snapshotByPath.keys(), ...currentByPath.keys()])]
      .sort(schema.compareUtf8Bytes);
    const fileIds = new Set();
    for (const file of [...snapshot.files, ...current.files]) {
      if (fileIds.has(file.fileId) && snapshotByPath.get(file.path)?.fileId !== file.fileId) {
        fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot/current file IDs collide');
      }
      fileIds.add(file.fileId);
    }
    const occupied = new Set(fileIds);
    const cursorIds = new Set();
    const privateItems = [];
    let comparisonDiffBytes = 0;
    for (const path of paths) {
      await runtime.checkpoint(true);
      const snapshotFile = snapshotByPath.get(path) || null;
      const currentFile = currentByPath.get(path) || null;
      let status;
      if (!snapshotFile) status = currentFile.state === 'available' ? 'added' : currentFile.state;
      else if (!currentFile) status = 'missing';
      else if (currentFile.state !== 'available') status = currentFile.state;
      else if (snapshotFile.kind !== currentFile.kind) status = 'conflict';
      else if (snapshotFile.sha256 === currentFile.sha256 &&
          snapshotFile.revision === currentFile.revision &&
          snapshotFile.byteLength === currentFile.byteLength) status = 'same';
      else status = 'modified';
      if (!COMPARE_STATUSES.has(status)) fail('SNAPSHOT_COMPARE_INVALID', 'Comparison status is invalid');
      let diff;
      try {
        diff = await createDiff(
          snapshot, current, snapshotFile, currentFile, status, occupied, cursorIds, runtime
        );
      } catch (error) {
        if (error?.code !== 'SNAPSHOT_DIFF_UNAVAILABLE') throw error;
        status = 'unavailable';
        diff = Object.freeze({
          diffId: null,
          truncated: false,
          diffCursors: Object.freeze([]),
          pageBuffers: Object.freeze([]),
        });
      }
      if (!diff.truncated && Number.isSafeInteger(diff.bodyBytes)) {
        if (comparisonDiffBytes + diff.bodyBytes > DIFF_COMPARISON_MAX_BYTES) {
          diff = Object.freeze({
            diffId: diff.diffId,
            truncated: true,
            bodyBytes: diff.bodyBytes,
            ...serializeDiffPages(
              snapshot, snapshotFile?.fileId || currentFile.fileId,
              diff.diffId, [[]], true, cursorIds
            ),
          });
        } else {
          comparisonDiffBytes += diff.bodyBytes;
        }
      }
      const fileId = snapshotFile?.fileId || currentFile.fileId;
      const kind = snapshotFile?.kind || currentFile.kind;
      const byteDelta = ['conflict', 'unavailable'].includes(status)
        ? null
        : (currentFile?.byteLength || 0) - (snapshotFile?.byteLength || 0);
      privateItems.push({
        fileId,
        path,
        kind,
        status,
        snapshotRevision: snapshotFile?.revision || null,
        currentRevision: currentFile?.state === 'available' ? currentFile.revision : null,
        snapshotSha256: snapshotFile?.sha256 || null,
        currentSha256: currentFile?.state === 'available' ? currentFile.sha256 : null,
        byteDelta,
        diffId: diff.diffId,
        truncated: diff.truncated,
        diffCursors: diff.diffCursors,
        pageBuffers: diff.pageBuffers,
        restorable: kind === 'markdown' && ['modified', 'missing'].includes(status) && !diff.truncated,
      });
    }
    return Object.freeze({ privateItems: Object.freeze(privateItems), comparisonDiffBytes });
  }

  function assertComparisonItem(item, index) {
    exact(item, schema.KEYS.COMPARISON_ITEM, `comparison items[${index}]`);
    assertOpaque(item.fileId, `comparison items[${index}].fileId`);
    if (!['markdown', 'image'].includes(item.kind) || !COMPARE_STATUSES.has(item.status)) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Comparison item kind/status is invalid');
    }
    for (const [name, value] of [
      ['snapshotRevision', item.snapshotRevision], ['currentRevision', item.currentRevision],
    ]) {
      if (value !== null) assertRevision(value, `comparison items[${index}].${name}`);
    }
    for (const [name, value] of [
      ['snapshotSha256', item.snapshotSha256], ['currentSha256', item.currentSha256],
    ]) {
      if (value !== null) assertDigest(value, `comparison items[${index}].${name}`);
    }
    if (item.byteDelta !== null && !Number.isSafeInteger(item.byteDelta)) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Comparison byteDelta is invalid');
    }
    if (item.diffId !== null) assertOpaque(item.diffId, `comparison items[${index}].diffId`);
    if (item.kind === 'image' && item.diffId !== null) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Image comparison must not expose a body diff identity');
    }
  }

  function sealComparison(snapshot, current, built, createdAt) {
    const items = built.privateItems.map(item => Object.freeze({
      fileId: item.fileId,
      kind: item.kind,
      status: item.status,
      snapshotRevision: item.snapshotRevision,
      currentRevision: item.currentRevision,
      snapshotSha256: item.snapshotSha256,
      currentSha256: item.currentSha256,
      byteDelta: item.byteDelta,
      diffId: item.diffId,
    }));
    const comparison = {
      schema: schema.SCHEMAS.SNAPSHOT_COMPARISON,
      projectInstanceId: snapshot.projectInstanceId,
      snapshotId: snapshot.snapshotId,
      snapshotManifestDigest: snapshot.snapshotManifestDigest,
      currentMutationGeneration: current.mutationGeneration,
      currentFileRevisionSetDigest: current.fileRevisionSetDigest,
      items,
      createdAt,
      comparisonDigest: null,
    };
    exact(comparison, schema.KEYS.COMPARISON, 'snapshot comparison');
    comparison.items.forEach(assertComparisonItem);
    comparison.comparisonDigest = schema.digestObject(
      schema.SCHEMAS.SNAPSHOT_COMPARISON, comparison, 'comparisonDigest'
    );
    const authorityPayload = {
      schema: 'writcraft.snapshot-compare-authority/v1',
      projectInstanceId: snapshot.projectInstanceId,
      snapshotId: snapshot.snapshotId,
      snapshotManifestDigest: snapshot.snapshotManifestDigest,
      publishedIdentityDigest: snapshot.publishedIdentityDigest,
      currentMutationGeneration: current.mutationGeneration,
      currentFileRevisionSetDigest: current.fileRevisionSetDigest,
      comparisonDigest: comparison.comparisonDigest,
      files: built.privateItems.map(item => ({
        fileId: item.fileId,
        path: item.path,
        kind: item.kind,
        status: item.status,
        diffId: item.diffId,
      })),
    };
    const authorityDigest = schema.digestObject(authorityPayload.schema, authorityPayload);
    return Object.freeze({ comparison: Object.freeze(comparison), authorityDigest });
  }

  function issueContext(owner, snapshot, current, built, sealed) {
    const bindingFiles = built.privateItems.map(item => ({
      fileId: item.fileId,
      kind: item.kind,
      diffId: item.diffId,
      restorable: item.restorable,
      truncated: item.truncated,
      diffCursors: item.diffCursors,
    }));
    const pageBuffers = [];
    const pageRecords = [];
    let storedPageBytes = 0;
    for (let index = 0; index < built.privateItems.length; index += 1) {
      const item = built.privateItems[index];
      if (item.diffId === null) continue;
      const descriptors = [];
      item.pageBuffers.forEach(bytes => {
        if (bytes.length > DIFF_PAGE_MAX_BYTES) {
          fail('SNAPSHOT_DIFF_BUDGET_EXCEEDED', 'Snapshot diff page exceeds its frozen budget');
        }
        storedPageBytes += bytes.length;
        descriptors.push(Object.freeze({ offset: storedPageBytes - bytes.length, length: bytes.length }));
        pageBuffers.push(bytes);
      });
      pageRecords.push(Object.freeze({
        diffId: item.diffId,
        fileId: item.fileId,
        pages: Object.freeze(descriptors),
      }));
    }
    const capabilityBinding = {
      snapshotId: snapshot.snapshotId,
      snapshotManifestDigest: snapshot.snapshotManifestDigest,
      publishedIdentityDigest: snapshot.publishedIdentityDigest,
      authorityDigest: sealed.authorityDigest,
      currentMutationGeneration: current.mutationGeneration,
      currentFileRevisionSetDigest: current.fileRevisionSetDigest,
      comparisonDigest: sealed.comparison.comparisonDigest,
      files: bindingFiles,
    };
    const capabilityBindingBuffer = Buffer.from(schema.canonicalJson(capabilityBinding), 'utf8');
    let issued = null;
    try {
      issued = capabilityStore.issueCompare(owner, capabilityBinding);
      const expiresAtMs = Date.parse(issued.expiresAt);
      const nowMs = clock();
      if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(nowMs) || expiresAtMs < nowMs) {
        fail('SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot compare expiry is invalid');
      }
      const metadata = {
        schema: 'writcraft.snapshot-diff-context/v1',
        capabilityId: issued.capabilityId,
        expiresAt: issued.expiresAt,
        ownerId: owner.ownerId,
        projectInstanceId: owner.projectInstanceId,
        ownerGeneration: owner.ownerGeneration,
        snapshotId: snapshot.snapshotId,
        snapshotManifestDigest: snapshot.snapshotManifestDigest,
        publishedIdentityDigest: snapshot.publishedIdentityDigest,
        currentMutationGeneration: current.mutationGeneration,
        currentFileRevisionSetDigest: current.fileRevisionSetDigest,
        comparisonDigest: sealed.comparison.comparisonDigest,
        binding: capabilityBinding,
        pages: pageRecords,
      };
      const metadataBuffer = Buffer.from(schema.canonicalJson(metadata), 'utf8');
      const builtMetadataBuffer = Buffer.from(schema.canonicalJson({
        schema: 'writcraft.snapshot-diff-build-metadata/v1',
        files: built.privateItems.map(item => ({
          fileId: item.fileId,
          path: item.path,
          kind: item.kind,
          status: item.status,
          diffId: item.diffId,
          truncated: item.truncated,
          restorable: item.restorable,
          diffCursors: item.diffCursors,
          pageLengths: item.pageBuffers.map(bytes => bytes.length),
        })),
      }), 'utf8');
      const buildPeakBytes = snapshot.markdownBytes + current.markdownBytes +
        (storedPageBytes * 2) + metadataBuffer.length + capabilityBindingBuffer.length +
        builtMetadataBuffer.length;
      if (buildPeakBytes > DIFF_BUILD_PEAK_MAX_BYTES) {
        fail('SNAPSHOT_DIFF_BUDGET_EXCEEDED', 'Snapshot diff build peak exceeds its frozen budget');
      }
      const pageArchive = Buffer.concat(pageBuffers, storedPageBytes);
      const contextBytes = metadataBuffer.length + pageArchive.length + capabilityBindingBuffer.length;
      reserveContextBytes(contextBytes);
      const context = {
        metadataBuffer,
        pageArchive,
        contextBytes,
        expiryTimer: null,
      };
      contexts.set(issued.capabilityId, context);
      usedContextBytes += contextBytes;
      context.expiryTimer = setExpiryTimer(() => {
        context.expiryTimer = null;
        removeExactContext(issued.capabilityId, context, true);
      }, expiresAtMs - nowMs);
      context.expiryTimer?.unref?.();
      return issued;
    } catch (error) {
      if (issued) {
        if (contexts.has(issued.capabilityId)) removeContext(issued.capabilityId, true);
        else {
          try { capabilityStore.release(owner, { capabilityId: issued.capabilityId }); } catch (_) {}
        }
      }
      throw error;
    }
  }

  async function compare(rawOwner, rawRequest) {
    pruneDeadContexts();
    const owner = assertOwner(rawOwner);
    const request = compareRequest(rawRequest, owner);
    const operation = localOperations.begin({
      projectInstanceId: owner.projectInstanceId,
      kind: COMPARE_KIND,
      ownerGeneration: owner.ownerGeneration,
    });
    operation.start();
    const taskOwner = Object.freeze({
      ...owner,
      taskId: operation.taskId,
      kind: COMPARE_KIND,
    });
    let lease = null;
    let terminal = false;
    let issuedCapabilityId = null;
    let deadlineAt = null;

    function assertDeadline() {
      const value = callSyncAdapter(
        monotonicClock, undefined, 'SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot monotonic clock'
      );
      if (!Number.isFinite(value) || value < 0) {
        fail('SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot compare monotonic clock is invalid');
      }
      if (deadlineAt !== null && value >= deadlineAt) {
        fail('LOCAL_TASK_TIMEOUT', 'Snapshot compare aggregate deadline elapsed');
      }
    }

    function assertCurrent() {
      operation.assertCurrentOwner();
      callSyncAdapter(
        assertOwnerCurrent,
        Object.freeze({ ...taskOwner, lease }),
        'SNAPSHOT_OWNER_UNAVAILABLE',
        'Snapshot compare owner check'
      );
      if (operation.signal.aborted) {
        fail(stableCode({ code: operation.abortCode() }, 'REQUEST_ABORTED'),
          'Snapshot compare was aborted');
      }
      assertDeadline();
    }

    function assertFinalOwner() {
      operation.assertCurrentOwner();
      callSyncAdapter(
        assertOwnerCurrent, owner, 'PROJECT_CHANGED', 'Snapshot compare final owner check'
      );
      callSyncAdapter(
        assertProjectCurrent, owner, 'PROJECT_CHANGED', 'Snapshot compare final owner check'
      );
      if (operation.signal.aborted) {
        fail(stableCode({ code: operation.abortCode() }, 'REQUEST_ABORTED'),
          'Snapshot compare was aborted');
      }
      assertDeadline();
    }

    async function release(truth) {
      if (!lease) return;
      const exactLease = lease;
      await callAdapter(
        request => releaseLease(request.lease, request.binding),
        Object.freeze({ lease: exactLease, binding: Object.freeze({ ...taskOwner, terminalTruth: truth }) }),
        'SNAPSHOT_LEASE_RELEASE_FAILED',
        'Snapshot compare lease release'
      );
      lease = null;
    }

    const runtime = Object.freeze({
      async checkpoint(force = false) {
        assertCurrent();
        if (!force) {
          // Every caller reaches this only after a bounded 64 KiB scan unit.
        }
        await callAdapter(
          async () => yieldControl(),
          null,
          'SNAPSHOT_DIFF_UNAVAILABLE',
          'Snapshot diff cooperative yield'
        );
        assertCurrent();
      },
    });

    try {
      const startedMonotonic = callSyncAdapter(
        monotonicClock, undefined, 'SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot monotonic clock'
      );
      if (!Number.isFinite(startedMonotonic) || startedMonotonic < 0) {
        fail('SNAPSHOT_COMPARE_CLOCK_INVALID', 'Snapshot compare monotonic clock is invalid');
      }
      deadlineAt = startedMonotonic + comparisonDeadlineMs;
      lease = await callAdapter(
        acquireLease, taskOwner, 'SNAPSHOT_LEASE_UNAVAILABLE', 'Snapshot compare lease acquisition'
      );
      assertCurrent();
      operation.stage('settling_watcher');
      const barrier = await callAdapter(
        settleWatcherBarrier,
        Object.freeze({ ...taskOwner, lease, signal: operation.signal }),
        'SNAPSHOT_BARRIER_UNAVAILABLE',
        'Snapshot watcher barrier'
      );
      assertCurrent();
      exact(barrier, ['projectInstanceId', 'mutationGeneration'], 'snapshot compare barrier');
      if (barrier.projectInstanceId !== owner.projectInstanceId) {
        fail('PROJECT_CHANGED', 'Snapshot compare barrier belongs to another project');
      }
      assertInteger(barrier.mutationGeneration, 'barrier mutationGeneration');
      operation.stage('reading_snapshot');
      const snapshot = validateSnapshot(await callAdapter(
        readSnapshot,
        Object.freeze({
          projectInstanceId: owner.projectInstanceId,
          snapshotId: request.snapshotId,
          lease,
          signal: operation.signal,
        }),
        'SNAPSHOT_READER_UNAVAILABLE',
        'Snapshot reader'
      ), owner.projectInstanceId, request.snapshotId);
      assertCurrent();
      const current = validateCurrent(await callAdapter(
        readCurrent,
        Object.freeze({
          projectInstanceId: owner.projectInstanceId,
          mutationGeneration: barrier.mutationGeneration,
          lease,
          signal: operation.signal,
        }),
        'PROJECT_READER_UNAVAILABLE',
        'Trusted current project reader'
      ), owner.projectInstanceId, barrier.mutationGeneration, currentMarkdownTotalBudgetBytes);
      assertCurrent();
      operation.stage('comparing');
      const built = await buildComparison(snapshot, current, runtime);
      assertCurrent();
      const sealed = sealComparison(snapshot, current, built, isoNow());
      assertCurrent();
      const issued = issueContext(owner, snapshot, current, built, sealed);
      issuedCapabilityId = issued.capabilityId;
      const publicItems = built.privateItems.map(item => Object.freeze({
        fileId: item.fileId,
        displayPath: item.path,
        kind: item.kind,
        status: item.status,
        byteDelta: item.byteDelta,
        diffId: item.diffId,
      }));
      const result = Object.freeze({
        schema: schema.SCHEMAS.SNAPSHOT_COMPARISON_PUBLIC,
        projectInstanceId: owner.projectInstanceId,
        snapshotId: snapshot.snapshotId,
        items: Object.freeze(publicItems),
        createdAt: sealed.comparison.createdAt,
        comparisonDigest: sealed.comparison.comparisonDigest,
        compareCapabilityId: issued.capabilityId,
      });
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4 * 1024 * 1024) {
        removeContext(issued.capabilityId, true);
        fail('SNAPSHOT_COMPARE_BUDGET_EXCEEDED', 'Snapshot comparison exceeds its public budget');
      }
      await release('COMMITTED');
      assertFinalOwner();
      operation.terminal('COMMITTED');
      terminal = true;
      return result;
    } catch (error) {
      const code = stableCode(error, 'SNAPSHOT_COMPARE_FAILED');
      if (issuedCapabilityId) removeContext(issuedCapabilityId, true);
      try { await release('UNCOMMITTED'); } catch (_) {}
      if (!terminal) {
        try { operation.terminal('UNCOMMITTED', code); } catch (_) {}
      }
      if (error instanceof SnapshotCompareServiceError) throw error;
      throw new SnapshotCompareServiceError(code, 'Snapshot compare failed closed');
    }
  }

  function validateSnapshotAuthority(value, context) {
    exact(value, [
      'snapshotId', 'snapshotManifestDigest', 'publishedIdentityDigest',
    ], 'snapshot compare live snapshot authority');
    assertOpaque(value.snapshotId, 'live snapshotId');
    assertDigest(value.snapshotManifestDigest, 'live snapshotManifestDigest');
    assertDigest(value.publishedIdentityDigest, 'live publishedIdentityDigest');
    if (value.snapshotId !== context.snapshotId) {
      fail('STALE_SNAPSHOT_CAPABILITY', 'Snapshot identity changed');
    }
    return value;
  }

  function validateCurrentAuthority(value, context) {
    exact(value, [
      'projectInstanceId', 'mutationGeneration', 'fileRevisionSetDigest',
    ], 'snapshot compare live current authority');
    try { schema.assertProjectInstanceId(value.projectInstanceId); } catch (_) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Live project identity is invalid');
    }
    assertInteger(value.mutationGeneration, 'live mutationGeneration');
    assertDigest(value.fileRevisionSetDigest, 'live fileRevisionSetDigest');
    if (value.projectInstanceId !== context.projectInstanceId) {
      fail('PROJECT_CHANGED', 'Snapshot comparison project changed');
    }
    return value;
  }

  async function readDiff(rawOwner, rawRequest) {
    pruneDeadContexts();
    const owner = assertOwner(rawOwner);
    exact(rawRequest, [
      'schema', 'projectInstanceId', 'compareCapabilityId', 'diffId', 'pageToken',
    ], 'snapshot diff request');
    if (rawRequest.schema !== schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST ||
        rawRequest.projectInstanceId !== owner.projectInstanceId) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot diff request is invalid');
    }
    assertOpaque(rawRequest.compareCapabilityId, 'compareCapabilityId');
    assertOpaque(rawRequest.diffId, 'diffId');
    if (rawRequest.pageToken !== null) assertOpaque(rawRequest.pageToken, 'pageToken');
    const context = contexts.get(rawRequest.compareCapabilityId);
    if (!context) {
      fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff context is unavailable');
    }
    const metadata = parseContextMetadata(context);
    if (metadata.capabilityId !== rawRequest.compareCapabilityId ||
        metadata.ownerId !== owner.ownerId ||
        metadata.projectInstanceId !== owner.projectInstanceId ||
        metadata.ownerGeneration !== owner.ownerGeneration) {
      fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff context is unavailable');
    }
    let capabilityRecord = null;
    try {
      capabilityRecord = typeof capabilityStore.inspect === 'function'
        ? capabilityStore.inspect(rawRequest.compareCapabilityId)
        : null;
    } catch (_) {
      capabilityRecord = null;
    }
    if (capabilityRecord === null) {
      removeExactContext(rawRequest.compareCapabilityId, context, false);
      fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff capability is unavailable');
    }
    let readLease = null;
    let page = null;
    let diffResolved = false;

    function assertDiffContextLive() {
      if (contexts.get(rawRequest.compareCapabilityId) !== context) {
        fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff context expired during read');
      }
      let liveRecord = null;
      try {
        liveRecord = typeof capabilityStore.inspect === 'function'
          ? capabilityStore.inspect(rawRequest.compareCapabilityId)
          : null;
      } catch (_) {
        liveRecord = null;
      }
      if (liveRecord !== capabilityRecord) {
        removeExactContext(rawRequest.compareCapabilityId, context, false);
        fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff capability expired during read');
      }
    }

    function assertReadCurrent() {
      assertDiffContextLive();
      callSyncAdapter(assertOwnerCurrent, owner, 'PROJECT_CHANGED', 'Snapshot diff owner check');
      callSyncAdapter(assertProjectCurrent, owner, 'PROJECT_CHANGED', 'Snapshot diff owner check');
      callSyncAdapter(assertReadLeaseCurrent, Object.freeze({
        owner,
        lease: readLease,
        compareCapabilityId: rawRequest.compareCapabilityId,
        snapshotId: metadata.snapshotId,
      }), 'SNAPSHOT_READ_LEASE_STALE', 'Snapshot diff read lease check');
    }

    async function releaseReadLeaseExact() {
      if (!readLease) return;
      const exactLease = readLease;
      await callAdapter(
        request => releaseReadLease(request.lease, request.binding),
        Object.freeze({
          lease: exactLease,
          binding: Object.freeze({ owner, compareCapabilityId: rawRequest.compareCapabilityId }),
        }),
        'SNAPSHOT_READ_LEASE_RELEASE_FAILED',
        'Snapshot diff read lease release'
      );
      readLease = null;
    }

    try {
      readLease = await callAdapter(
        acquireReadLease,
        Object.freeze({
          owner,
          compareCapabilityId: rawRequest.compareCapabilityId,
          snapshotId: metadata.snapshotId,
        }),
        'SNAPSHOT_READ_LEASE_UNAVAILABLE',
        'Snapshot diff read lease acquisition'
      );
      assertReadCurrent();
      const snapshotAuthorityValue = await callAdapter(
        readSnapshotAuthority,
        Object.freeze({
          projectInstanceId: owner.projectInstanceId,
          snapshotId: metadata.snapshotId,
          lease: readLease,
        }),
        'SNAPSHOT_AUTHORITY_READ_FAILED',
        'Snapshot authority reader'
      );
      assertReadCurrent();
      const snapshotAuthority = validateSnapshotAuthority(snapshotAuthorityValue, metadata);
      const currentAuthorityValue = await callAdapter(
        readCurrentAuthority,
        Object.freeze({ projectInstanceId: owner.projectInstanceId, lease: readLease }),
        'PROJECT_AUTHORITY_READ_FAILED',
        'Current revision authority reader'
      );
      assertReadCurrent();
      const currentAuthority = validateCurrentAuthority(currentAuthorityValue, metadata);
      let resolved;
      try {
        resolved = capabilityStore.resolveDiff(owner, rawRequest, {
          snapshotId: snapshotAuthority.snapshotId,
          snapshotManifestDigest: snapshotAuthority.snapshotManifestDigest,
          publishedIdentityDigest: snapshotAuthority.publishedIdentityDigest,
          currentMutationGeneration: currentAuthority.mutationGeneration,
          currentFileRevisionSetDigest: currentAuthority.fileRevisionSetDigest,
          comparisonDigest: metadata.comparisonDigest,
        });
        diffResolved = true;
        assertDiffContextLive();
      } catch (error) {
        cleanupTombstonedContext(rawRequest.compareCapabilityId);
        throw error;
      }
      const secondSnapshotValue = await callAdapter(
        readSnapshotAuthority,
        Object.freeze({
          projectInstanceId: owner.projectInstanceId,
          snapshotId: metadata.snapshotId,
          lease: readLease,
        }),
        'SNAPSHOT_AUTHORITY_READ_FAILED',
        'Snapshot authority recheck'
      );
      assertReadCurrent();
      const secondSnapshot = validateSnapshotAuthority(secondSnapshotValue, metadata);
      const secondCurrentValue = await callAdapter(
        readCurrentAuthority,
        Object.freeze({ projectInstanceId: owner.projectInstanceId, lease: readLease }),
        'PROJECT_AUTHORITY_READ_FAILED',
        'Current revision authority recheck'
      );
      assertReadCurrent();
      const secondCurrent = validateCurrentAuthority(secondCurrentValue, metadata);
      if (schema.canonicalJson(secondSnapshot) !== schema.canonicalJson(snapshotAuthority) ||
          schema.canonicalJson(secondCurrent) !== schema.canonicalJson(currentAuthority)) {
        removeContext(rawRequest.compareCapabilityId, true);
        fail('STALE_SNAPSHOT_CAPABILITY', 'Snapshot diff authority drifted during read');
      }
      assertDiffContextLive();
      const filePages = metadata.pages.find(item => item.diffId === resolved.diffId);
      const descriptor = filePages?.pages?.[resolved.pageIndex];
      if (!descriptor || !Number.isSafeInteger(descriptor.offset) ||
          !Number.isSafeInteger(descriptor.length) || descriptor.offset < 0 ||
          descriptor.length < 1 || descriptor.offset + descriptor.length > context.pageArchive.length) {
        fail('SNAPSHOT_CAPABILITY_NOT_FOUND', 'Snapshot diff page is unavailable');
      }
      const pageBytes = context.pageArchive.subarray(
        descriptor.offset, descriptor.offset + descriptor.length
      );
      page = JSON.parse(pageBytes.toString('utf8'));
      exact(page, [
        'schema', 'projectInstanceId', 'snapshotId', 'diffId', 'fileId',
        'pageIndex', 'pageCount', 'hunks', 'nextPageToken', 'truncated',
      ], 'sealed snapshot diff page');
      page = freezePage(page);
      assertDiffContextLive();
      await releaseReadLeaseExact();
      assertDiffContextLive();
      callSyncAdapter(
        assertOwnerCurrent, owner, 'PROJECT_CHANGED', 'Snapshot diff final owner check'
      );
      callSyncAdapter(assertProjectCurrent, owner, 'PROJECT_CHANGED', 'Snapshot diff final owner check');
      return page;
    } catch (error) {
      if (diffResolved) {
        removeExactContext(rawRequest.compareCapabilityId, context, true);
      }
      else cleanupTombstonedContext(rawRequest.compareCapabilityId);
      try { await releaseReadLeaseExact(); } catch (_) {}
      if (error instanceof SnapshotCompareServiceError || error?.name === 'SnapshotCapabilityStoreError') {
        throw error;
      }
      throw new SnapshotCompareServiceError(
        stableCode(error, 'SNAPSHOT_DIFF_UNAVAILABLE'),
        'Snapshot diff read failed closed'
      );
    }
  }

  function invalidateProject(request) {
    exact(request, ['projectInstanceId'], 'snapshot compare project invalidation');
    try { schema.assertProjectInstanceId(request.projectInstanceId); } catch (_) {
      fail('SNAPSHOT_COMPARE_INVALID', 'Snapshot project invalidation is invalid');
    }
    const count = capabilityStore.invalidateProject(request);
    for (const [capabilityId, context] of contexts) {
      let metadata = null;
      try { metadata = parseContextMetadata(context); } catch (_) {}
      if (metadata?.projectInstanceId === request.projectInstanceId) removeContext(capabilityId, false);
    }
    return count;
  }

  return Object.freeze({ list, compare, readDiff, invalidateProject });
}

module.exports = Object.freeze({
  COMPARE_KIND,
  DIFF_PAGE_MAX_BYTES,
  DIFF_FILE_MAX_BYTES,
  DIFF_COMPARISON_MAX_BYTES,
  DIFF_LINE_MAX_BYTES,
  DIFF_SCAN_CHUNK_BYTES,
  DIFF_CONTEXT_TOTAL_MAX_BYTES,
  DIFF_BUILD_PEAK_MAX_BYTES,
  MAX_COMPARE_CONTEXTS,
  SnapshotCompareServiceError,
  createSnapshotCompareService,
});
