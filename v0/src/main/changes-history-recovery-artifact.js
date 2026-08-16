'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const evidenceDeliverySchema = require('./evidence-delivery-schema');

const MAGIC = Buffer.from('WRCCHRA2', 'ascii');
const MAX_FILES = 300;
const MAX_PATH_BYTES = 4096;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_HISTORY_BYTES = 192 * 1024 * 1024;
const MAX_DELTA_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 384 * 1024 * 1024;
const MAX_AFTER_BYTES = 64 * 1024 * 1024;
const MAX_BEFORE_AND_AFTER_BYTES = 128 * 1024 * 1024;
const BASENAME_RE = /^changes-history-(chr_[a-f0-9]{48})\.bin$/;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

class ChangesHistoryArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryArtifactError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryArtifactError(code, message);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function u64(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact length invalid');
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

function stateBytes(state) {
  if (state.exists === false) return Buffer.alloc(0);
  const bytes = typeof state.content === 'string'
    ? Buffer.from(state.content, 'utf8')
    : Buffer.from(state.data, 'base64');
  const byteLength = state.byteLength === undefined ? bytes.length : state.byteLength;
  const contentHash = state.contentHash === undefined ? state.revision : state.contentHash;
  if (bytes.length !== byteLength || bytes.length > MAX_STATE_BYTES ||
      sha256Buffer(bytes) !== state.revision || contentHash !== state.revision) {
    fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact state does not match History');
  }
  return bytes;
}

function serializedHistoryState(state, historyService) {
  const history = historyService.validateHistory(state.history);
  if (!state.exists && history.entries.length) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'absent History cannot contain entries');
  const bytes = state.exists ? Buffer.from(`${JSON.stringify(history, null, 2)}\n`, 'utf8') : Buffer.alloc(0);
  if (bytes.length > MAX_HISTORY_BYTES) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'History artifact exceeds limit');
  const bindingDigest = sha256Buffer(Buffer.concat([Buffer.from([state.exists ? 1 : 0]), bytes]));
  return { exists: state.exists, bytes, bindingDigest };
}

function serializedHistoryTemplate(template, historyService, baseHistoryDigest) {
  const schemaDescriptor = template && typeof template === 'object'
    ? Object.getOwnPropertyDescriptor(template, 'schema')
    : null;
  if (!schemaDescriptor || !Object.hasOwn(schemaDescriptor, 'value') ||
      Object.hasOwn(schemaDescriptor, 'get') || Object.hasOwn(schemaDescriptor, 'set')) {
    fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'History template schema is not plain data');
  }
  const schema = schemaDescriptor.value;
  let valid;
  if (schema === historyService.SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA) {
    valid = historyService.validateSnapshotRestoreHistoryTemplate(template);
  } else if (schema === historyService.SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA &&
      typeof historyService.validateSnapshotRestoreUndoHistoryTemplate === 'function') {
    valid = historyService.validateSnapshotRestoreUndoHistoryTemplate(template);
    if (valid.baseHistoryState.digest !== baseHistoryDigest) {
      fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'undo template base History binding drifted');
    }
  } else {
    fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'History template schema is unsupported');
  }
  const bytes = Buffer.from(evidenceDeliverySchema.canonicalJson(valid), 'utf8');
  if (bytes.length > MAX_DELTA_BYTES) {
    fail('CHANGES_RECOVERY_ARTIFACT_TOO_LARGE', 'History template exceeds limit');
  }
  const bindingDigest = evidenceDeliverySchema.digestObject(
    schema,
    valid
  );
  return { exists: true, bytes, bindingDigest: bindingDigest.slice(7), schema };
}

function encodeDeltaEntry(entry) {
  if (entry.kind !== 'application') return { ...entry };
  return {
    ...entry,
    files: entry.files.map(file => ({
      ...file,
      before: { ...file.before, data: null },
      after: { ...file.after, data: null },
    })),
  };
}

function preparedHistoryDelta(baseHistory, preparedHistory) {
  const baseById = new Map(baseHistory.entries.map(entry => [entry.id, entry]));
  const delta = {
    schema: 'writcraft.changes-history-recovery-delta/v1',
    entries: preparedHistory.entries.map(entry => {
      const base = baseById.get(entry.id);
      if (base && base.integrity === entry.integrity) return { kind: 'base', id: entry.id };
      return { kind: 'delta', entry: encodeDeltaEntry(entry) };
    }),
  };
  const bytes = Buffer.from(JSON.stringify(delta), 'utf8');
  if (bytes.length > MAX_DELTA_BYTES) fail('CHANGES_RECOVERY_ARTIFACT_TOO_LARGE', 'prepared History delta exceeds limit');
  return bytes;
}

function accountSnapshotArtifact(files, baseHistoryBytes, preparedDeltaBytes) {
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact files invalid');
  }
  accountSnapshotStateBudget(files);
  let total = MAGIC.length + 4 + 1 + 8 + 1 + 8;
  for (const file of files) {
    const pathBytes = Buffer.byteLength(file.path, 'utf8');
    if (pathBytes < 1 || pathBytes > MAX_PATH_BYTES) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact path exceeds limit');
    const beforeBytes = file.before.exists === false
      ? 0
      : file.before.byteLength === undefined
        ? Buffer.byteLength(file.before.content, 'utf8')
        : file.before.byteLength;
    const afterBytes = file.after.exists === false
      ? 0
      : file.after.byteLength === undefined
        ? Buffer.byteLength(file.after.content, 'utf8')
        : file.after.byteLength;
    const identityBytes = file.createdIdentityDigest == null ? 0 : Buffer.byteLength(file.createdIdentityDigest, 'ascii');
    total += 4 + pathBytes + 1 + 8 + beforeBytes + 1 + 8 + afterBytes + 1 + identityBytes;
  }
  total += baseHistoryBytes + preparedDeltaBytes;
  if (!Number.isSafeInteger(total) || total > MAX_ARTIFACT_BYTES) {
    fail('CHANGES_RECOVERY_ARTIFACT_TOO_LARGE', 'Snapshot recovery artifact exceeds safe limit');
  }
  return total;
}

function accountSnapshotStateBudget(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact files invalid');
  }
  let beforeBytes = 0;
  let afterBytes = 0;
  const lengthOf = (state, label) => {
    const length = state?.exists === false
      ? 0
      : state?.byteLength === undefined && typeof state?.content === 'string'
        ? Buffer.byteLength(state.content, 'utf8')
        : state?.byteLength;
    if (!Number.isSafeInteger(length) || length < 0) {
      fail('CHANGES_RECOVERY_ARTIFACT_INVALID', `${label} byteLength invalid`);
    }
    return length;
  };
  for (let index = 0; index < files.length; index += 1) {
    beforeBytes += lengthOf(files[index].before, `files[${index}].before`);
    afterBytes += lengthOf(files[index].after, `files[${index}].after`);
    if (!Number.isSafeInteger(beforeBytes) || !Number.isSafeInteger(afterBytes)) {
      fail('CHANGES_RECOVERY_ARTIFACT_TOO_LARGE', 'Snapshot recovery byte budget overflow');
    }
  }
  if (afterBytes > MAX_AFTER_BYTES ||
      beforeBytes + afterBytes > MAX_BEFORE_AND_AFTER_BYTES) {
    fail('CHANGES_RECOVERY_ARTIFACT_TOO_LARGE', 'Snapshot recovery raw byte budget exceeded');
  }
  return Object.freeze({ beforeBytes, afterBytes });
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function assertNoCleanupResidue(directory) {
  const handle = fs.opendirSync(directory);
  let inspected = 0;
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      inspected += 1;
      if (inspected > 2048) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery directory exceeds bounded discovery');
      if (BASENAME_RE.test(entry.name) ||
          /^\.changes-history-cleanup\.[a-f0-9]{32}$/.test(entry.name) ||
          /^\.changes-history-cleanup-(?:control|proof|receipt)\.[a-f0-9]{64}$/.test(entry.name)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'exact artifact cleanup residue requires reconciliation');
      }
    }
  } finally { handle.closeSync(); }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.nlink === right.nlink && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function requireLifecycle(lifecycle) {
  if (!lifecycle || typeof lifecycle.cleanup !== 'function' ||
      typeof lifecycle.rollback !== 'function') {
    fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'native exact artifact cleanup is unavailable');
  }
  return lifecycle;
}

function identityRecord(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: stat.uid.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameIdentityRecord(stat, record) {
  const actual = identityRecord(stat);
  return Object.keys(actual).every(key => actual[key] === record?.[key]);
}

function lifecycleRequest(lifecycle, directory, request) {
  return lifecycle.schema === 'writcraft.changes-history-artifact-lifecycle-scoped/v1'
    ? Object.freeze({ ...request })
    : Object.freeze({ directory, ...request });
}

function assertPathAbsent(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup outcome is unknown');
  }
  try {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup did not remove the bound name');
  } finally { fs.closeSync(fd); }
}

function openRegularNoFollow(file, maximum, expectedSize = null, expectedLinks = 1n) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW); }
  catch (error) {
    const wrapped = new ChangesHistoryArtifactError('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery artifact path is unsafe');
    wrapped.cause = error;
    throw wrapped;
  }
  const stat = fs.fstatSync(fd, { bigint: true });
  if ((stat.mode & BigInt(S_IFMT)) !== BigInt(S_IFREG) || stat.nlink !== expectedLinks ||
      stat.size > BigInt(maximum) || (expectedSize !== null && stat.size !== BigInt(expectedSize))) {
    fs.closeSync(fd);
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery artifact identity invalid');
  }
  return { fd, stat };
}

function hashHeld(fd, stat, prefix = null) {
  const hash = crypto.createHash('sha256');
  if (prefix) hash.update(prefix);
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0n;
  while (offset < stat.size) {
    const size = Number(stat.size - offset > BigInt(chunk.length) ? BigInt(chunk.length) : stat.size - offset);
    const count = fs.readSync(fd, chunk, 0, size, Number(offset));
    if (count <= 0) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery artifact truncated');
    hash.update(chunk.subarray(0, count));
    offset += BigInt(count);
  }
  const after = fs.fstatSync(fd, { bigint: true });
  if (!sameIdentity(stat, after)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery artifact changed during read');
  return hash.digest('hex');
}

function openRawBaseHistory(directory, expectedExists) {
  const file = path.resolve(directory, '..', 'changes.json');
  if (!expectedExists) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
      fs.closeSync(fd);
      fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'base History existence drifted');
    } catch (error) {
      if (error instanceof ChangesHistoryArtifactError) throw error;
      if (error?.code !== 'ENOENT') fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'base History path is unsafe');
    }
    return { exists: false, fd: null, stat: null, bindingDigest: sha256Buffer(Buffer.from([0])) };
  }
  const opened = openRegularNoFollow(file, MAX_HISTORY_BYTES);
  const bindingDigest = hashHeld(opened.fd, opened.stat, Buffer.from([1]));
  return { exists: true, ...opened, bindingDigest };
}

function writeSnapshotArtifact(
  directory,
  operationId,
  files,
  baseHistoryState,
  preparedHistoryState,
  historyService,
  lifecycle,
  historyTemplate = null
) {
  const exactLifecycle = requireLifecycle(lifecycle);
  assertNoCleanupResidue(directory);
  // This metadata-only aggregate gate runs before base History is opened,
  // template JSON is encoded, or any artifact byte is copied.
  accountSnapshotStateBudget(files);
  const basename = `changes-history-${operationId}.bin`;
  if (!BASENAME_RE.test(basename)) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact identity invalid');
  const finalPath = path.join(directory, basename);
  const base = openRawBaseHistory(directory, baseHistoryState.exists);
  const templateMode = historyTemplate !== null;
  const prepared = templateMode
    ? serializedHistoryTemplate(historyTemplate, historyService, base.bindingDigest)
    : serializedHistoryState(preparedHistoryState, historyService);
  const delta = templateMode
    ? prepared.bytes
    : prepared.exists
      ? preparedHistoryDelta(baseHistoryState.history, preparedHistoryState.history)
      : Buffer.alloc(0);
  const baseByteLength = base.stat ? Number(base.stat.size) : 0;
  const expectedBytes = accountSnapshotArtifact(files, baseByteLength, delta.length);
  const hash = crypto.createHash('sha256');
  let written = 0;
  let fd;
  let createdStat;
  const write = buffer => {
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (count <= 0) fail('CHANGES_RECOVERY_ARTIFACT_WRITE_FAILED', 'Snapshot recovery artifact write truncated');
      offset += count;
    }
    hash.update(buffer);
    written += buffer.length;
  };
  try {
    // Claim the final basename atomically. A crash may leave this unreferenced
    // inode behind; bounded residue discovery then blocks every later
    // transaction until the native lifecycle reconciles it. Production code
    // never performs a path-based unlink of this name.
    fd = fs.openSync(finalPath, 'wx', 0o600);
    createdStat = fs.fstatSync(fd, { bigint: true });
    if ((createdStat.mode & BigInt(S_IFMT)) !== BigInt(S_IFREG) || createdStat.nlink !== 1n) {
      fail('CHANGES_RECOVERY_ARTIFACT_WRITE_FAILED', 'created artifact identity invalid');
    }
    write(MAGIC);
    write(u32(files.length));
    for (const file of files) {
      const pathBytes = Buffer.from(file.path, 'utf8');
      const before = stateBytes(file.before);
      const after = stateBytes(file.after);
      const identity = file.createdIdentityDigest == null
        ? Buffer.alloc(0)
        : Buffer.from(file.createdIdentityDigest, 'ascii');
      write(u32(pathBytes.length)); write(pathBytes);
      write(Buffer.from([file.before.exists === false ? 0 : 1])); write(u64(before.length)); write(before);
      write(Buffer.from([file.after.exists === false ? 0 : 1])); write(u64(after.length)); write(after);
      write(Buffer.from([identity.length])); write(identity);
    }
    write(Buffer.from([base.exists ? 1 : 0])); write(u64(baseByteLength));
    if (base.exists) {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < baseByteLength) {
        const count = fs.readSync(base.fd, chunk, 0, Math.min(chunk.length, baseByteLength - position), position);
        if (count <= 0) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'base History truncated during copy');
        write(chunk.subarray(0, count));
        position += count;
      }
      const afterCopyDigest = hashHeld(base.fd, base.stat, Buffer.from([1]));
      if (afterCopyDigest !== base.bindingDigest) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'base History changed during artifact copy');
    }
    write(Buffer.from([prepared.exists ? 1 : 0])); write(u64(delta.length)); write(delta);
    if (written !== expectedBytes) fail('CHANGES_RECOVERY_ARTIFACT_INVALID', 'artifact accountant mismatch');
    fs.fsyncSync(fd);
    const finalStat = fs.fstatSync(fd, { bigint: true });
    if (finalStat.dev !== createdStat.dev || finalStat.ino !== createdStat.ino ||
        finalStat.size !== BigInt(written) || finalStat.nlink !== 1n) {
      fail('CHANGES_RECOVERY_ARTIFACT_WRITE_FAILED', 'persisted artifact identity mismatch');
    }
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(directory);
    return Object.freeze({
      schema: templateMode
        ? 'writcraft.changes-history-recovery-artifact/v2'
        : 'writcraft.changes-history-recovery-artifact/v1',
      basename,
      byteLength: written,
      sha256: `sha256:${hash.digest('hex')}`,
      baseHistoryDigest: base.bindingDigest,
      ...(templateMode
        ? {
          historyTemplateDigest: prepared.bindingDigest,
          identity: identityRecord(finalStat),
        }
        : { preparedHistoryDigest: prepared.bindingDigest }),
    });
  } catch (error) {
    if (base.fd !== null) try { fs.closeSync(base.fd); base.fd = null; } catch (_) {}
    let rollbackError = null;
    if (createdStat) {
      try {
        const rollbackStat = fs.fstatSync(fd, { bigint: true });
        const rollbackSha256 = hashHeld(fd, rollbackStat);
        exactLifecycle.rollback(lifecycleRequest(exactLifecycle, directory, {
          basename,
          identity: identityRecord(rollbackStat),
          heldFd: fd,
          binding: Object.freeze({
            byteLength: Number(rollbackStat.size),
            sha256: `sha256:${rollbackSha256}`,
          }),
        }));
        assertPathAbsent(finalPath);
      } catch (cleanupError) { rollbackError = cleanupError; }
    }
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    if (rollbackError) {
      const wrapped = new ChangesHistoryArtifactError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'artifact rollback requires exact reconciliation'
      );
      wrapped.cause = rollbackError;
      throw wrapped;
    }
    if (error instanceof ChangesHistoryArtifactError) throw error;
    const wrapped = new ChangesHistoryArtifactError('CHANGES_RECOVERY_ARTIFACT_WRITE_FAILED', 'Snapshot recovery artifact cannot be persisted');
    wrapped.cause = error;
    throw wrapped;
  } finally {
    if (base.fd !== null) try { fs.closeSync(base.fd); } catch (_) {}
  }
}

function verifyArtifact(directory, binding) {
  const file = path.join(directory, binding.basename);
  const opened = openRegularNoFollow(file, MAX_ARTIFACT_BYTES, binding.byteLength);
  if (binding.identity && !sameIdentityRecord(opened.stat, binding.identity)) {
    fs.closeSync(opened.fd);
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery artifact identity changed');
  }
  const digest = hashHeld(opened.fd, opened.stat);
  if (`sha256:${digest}` !== binding.sha256) {
    fs.closeSync(opened.fd);
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery artifact digest invalid');
  }
  return { file, ...opened };
}

function withVerifiedArtifactFd(directory, binding, callback) {
  if (typeof callback !== 'function') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'held artifact callback is required');
  }
  const held = verifyArtifact(directory, binding);
  let result;
  let callbackError = null;
  try {
    try { result = callback(held.fd); }
    catch (error) { callbackError = error; }
    let after;
    try { after = fs.fstatSync(held.fd, { bigint: true }); }
    catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'held recovery artifact fd was invalidated');
    }
    if (!sameIdentity(held.stat, after)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'held recovery artifact changed during callback');
    }
  } finally {
    try { fs.closeSync(held.fd); } catch (_) {}
  }
  if (callbackError) throw callbackError;
  return result;
}

function readExact(fd, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (count <= 0) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery artifact truncated');
    offset += count;
  }
  return buffer;
}

function inspectSnapshotArtifact(directory, binding, onFile, options = {}) {
  const held = verifyArtifact(directory, binding);
  const fd = held.fd;
  let position = 0;
  const read = length => { const value = readExact(fd, length, position); position += length; return value; };
  const length64 = () => {
    const value = Number(read(8).readBigUInt64BE(0));
    if (!Number.isSafeInteger(value)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact length invalid');
    return value;
  };
  try {
    if (!read(MAGIC.length).equals(MAGIC)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact magic invalid');
    const count = read(4).readUInt32BE(0);
    if (count > MAX_FILES) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact file count invalid');
    for (let index = 0; index < count; index += 1) {
      const pathLength = read(4).readUInt32BE(0);
      if (pathLength < 1 || pathLength > MAX_PATH_BYTES) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact path length invalid');
      const relative = read(pathLength).toString('utf8');
      const readState = () => {
        const exists = read(1)[0];
        const byteLength = length64();
        if (![0, 1].includes(exists) || byteLength > MAX_STATE_BYTES || (!exists && byteLength !== 0)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact state length invalid');
        }
        const offset = position;
        const bytes = read(byteLength);
        return {
          exists: exists === 1,
          bytes,
          offset,
          revision: exists ? sha256Buffer(bytes) : null,
        };
      };
      const before = readState();
      const after = readState();
      const identityLength = read(1)[0];
      if (![0, 71].includes(identityLength)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact created identity length invalid');
      const createdIdentityDigest = identityLength ? read(identityLength).toString('ascii') : null;
      onFile({ path: relative, before, after, createdIdentityDigest }, index, count);
    }
    const readSection = (maximum, label) => {
      const exists = read(1)[0];
      const byteLength = length64();
      if (![0, 1].includes(exists) || byteLength > maximum) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `artifact ${label} length invalid`);
      }
      const start = position;
      const hash = crypto.createHash('sha256');
      hash.update(Buffer.from([exists]));
      const materialized = options.includeHistory === true ? Buffer.allocUnsafe(byteLength) : null;
      let materializedOffset = 0;
      let remaining = byteLength;
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, remaining)));
      while (remaining > 0) {
        const size = Math.min(chunk.length, remaining);
        const count = fs.readSync(fd, chunk, 0, size, position);
        if (count <= 0) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `artifact ${label} truncated`);
        hash.update(chunk.subarray(0, count));
        if (materialized) {
          chunk.copy(materialized, materializedOffset, 0, count);
          materializedOffset += count;
        }
        position += count;
        remaining -= count;
      }
      return {
        exists: exists === 1,
        byteLength,
        offset: start,
        digest: hash.digest('hex'),
        ...(materialized ? { bytes: materialized } : {}),
      };
    };
    const baseHistory = readSection(MAX_HISTORY_BYTES, 'base History');
    if (!baseHistory.exists && baseHistory.byteLength !== 0) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'absent base History has bytes');
    }
    const preparedDelta = readSection(MAX_DELTA_BYTES, 'prepared delta');
    if (!preparedDelta.exists && preparedDelta.byteLength !== 0) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'absent prepared History has delta bytes');
    }
    if (position !== binding.byteLength) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact trailing bytes invalid');
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(held.stat, after)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact identity changed during parse');
    let historyTemplate = null;
    if (binding.schema === 'writcraft.changes-history-recovery-artifact/v2' &&
        options.includeHistory === true) {
      let rawTemplate;
      try { rawTemplate = JSON.parse(preparedDelta.bytes.toString('utf8')); }
      catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template JSON is invalid'); }
      const schema = rawTemplate?.schema;
      if (![
        'writcraft.snapshot-restore-history-template/v1',
        'writcraft.snapshot-restore-undo-history-template/v1',
      ].includes(schema)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template schema is invalid');
      }
      if (options.historyService) {
        try {
          historyTemplate = schema === options.historyService.SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA
            ? options.historyService.validateSnapshotRestoreHistoryTemplate(rawTemplate)
            : options.historyService.validateSnapshotRestoreUndoHistoryTemplate(rawTemplate);
        } catch (error) {
          const wrapped = new ChangesHistoryArtifactError(
            'CHANGES_MANUAL_RECOVERY_REQUIRED',
            'History template authority is invalid'
          );
          wrapped.cause = error;
          throw wrapped;
        }
      }
      preparedDelta.templateSchema = schema;
    }
    return {
      baseHistory,
      preparedDelta,
      ...(historyTemplate === null ? {} : { historyTemplate }),
    };
  } finally { fs.closeSync(fd); }
}

function exactRemoveArtifact(directory, binding, lifecycle, method) {
  const exactLifecycle = requireLifecycle(lifecycle);
  const held = verifyArtifact(directory, binding);
  try {
    const result = exactLifecycle[method](lifecycleRequest(exactLifecycle, directory, {
      basename: binding.basename,
      identity: identityRecord(held.stat),
      heldFd: held.fd,
      binding: Object.freeze({ ...binding }),
    }));
    assertPathAbsent(held.file);
    return result;
  } finally { try { fs.closeSync(held.fd); } catch (_) {} }
}

function removeArtifact(directory, binding, lifecycle) {
  return exactRemoveArtifact(directory, binding, lifecycle, 'cleanup');
}

function rollbackArtifact(directory, binding, lifecycle) {
  return exactRemoveArtifact(directory, binding, lifecycle, 'rollback');
}

module.exports = {
  MAX_ARTIFACT_BYTES,
  MAX_DELTA_BYTES,
  ChangesHistoryArtifactError,
  accountSnapshotArtifact,
  accountSnapshotStateBudget,
  assertNoCleanupResidue,
  preparedHistoryDelta,
  writeSnapshotArtifact,
  withVerifiedArtifactFd,
  inspectSnapshotArtifact,
  removeArtifact,
  rollbackArtifact,
};
