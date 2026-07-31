'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  computeStructureProposalDigest,
  isAuthenticWritingStructurePreparedRecord,
} = require('./writing-structure-service');

const MARKER_RELATIVE = path.join(
  '.writcraft', 'recovery', 'writing-structure-transaction.json'
);
const RECEIPT_RELATIVE = path.join(
  '.writcraft', 'recovery', 'writing-structure-stage-receipt.json'
);
const MARKER_SCHEMA = 'writcraft.writing-structure-transaction/v1';
const RECEIPT_SCHEMA = 'writcraft.structure-stage-receipt/v1';
const TARGET_NAME = 'chapters';
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_HELPER_BYTES = 8 * 1024;
const MAX_RECEIPT_BYTES = 512;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'
  ? fs.constants.O_NOFOLLOW
  : 0;
const DIRECTORY = typeof fs.constants.O_DIRECTORY === 'number'
  ? fs.constants.O_DIRECTORY
  : 0;
const DEFAULT_HELPER = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'writing-structure-helper')
  : path.join(__dirname, 'native', 'writing-structure-helper');

class WritingStructureTransactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingStructureTransactionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingStructureTransactionError(code, message);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function markerIntegrity(marker) {
  const copy = { ...marker };
  delete copy.integrity;
  return digest(Buffer.from(JSON.stringify(copy), 'utf8'));
}

function encodeMarker(marker) {
  const complete = Object.freeze({
    ...marker,
    integrity: markerIntegrity(marker),
  });
  const bytes = Buffer.from(`${JSON.stringify(complete)}\n`, 'utf8');
  if (bytes.length > MAX_MARKER_BYTES) {
    fail('STRUCTURE_MARKER_TOO_LARGE', '结构创建恢复记录超过安全上限');
  }
  return bytes;
}

function parseMarker(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MARKER_BYTES) return null;
  let parsed;
  try {
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
    parsed = JSON.parse(text.slice(0, -1));
  } catch (_) {
    return null;
  }
  if (!exactKeys(parsed, [
    'schema', 'operationId', 'projectId', 'stage', 'target', 'phase',
    'projectInstanceId', 'navigationId', 'mutationGeneration', 'navigationEpoch',
    'editRevision', 'emptyTreeDigest', 'proposalDigest', 'files',
    'stageIdentity', 'rootIdentity', 'integrity',
  ]) ||
      parsed.schema !== MARKER_SCHEMA ||
      !/^wst_[a-f0-9]{48}$/.test(parsed.operationId) ||
      parsed.stage !== `.writcraft-structure-stage-${parsed.operationId.slice(4)}` ||
      parsed.target !== TARGET_NAME ||
      !['PREPARING', 'RESERVED', 'COMMITTING', 'COMMITTED'].includes(parsed.phase) ||
      typeof parsed.projectId !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(parsed.projectId) ||
      typeof parsed.projectInstanceId !== 'string' ||
      !/^instance_[a-f0-9]{24}$/.test(parsed.projectInstanceId) ||
      typeof parsed.navigationId !== 'string' ||
      !/^nav_[a-f0-9]{32}$/.test(parsed.navigationId) ||
      !Number.isSafeInteger(parsed.mutationGeneration) ||
      parsed.mutationGeneration < 0 ||
      !Number.isSafeInteger(parsed.navigationEpoch) ||
      parsed.navigationEpoch < 0 ||
      !/^[a-f0-9]{64}$/.test(parsed.editRevision) ||
      !/^[a-f0-9]{64}$/.test(parsed.emptyTreeDigest) ||
      !/^[a-f0-9]{64}$/.test(parsed.proposalDigest) ||
      !Array.isArray(parsed.files) ||
      !identityValid(parsed.rootIdentity) ||
      !(parsed.stageIdentity === null || identityValid(parsed.stageIdentity)) ||
      parsed.integrity !== markerIntegrity(parsed)) {
    return null;
  }
  for (const file of parsed.files) {
    if (!exactKeys(file, ['name', 'bytes', 'sha256', 'contentBase64', 'identity']) ||
        !/^(?:0[1-8])\.md$/.test(file.name) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.contentBase64 !== 'string' ||
        !(file.identity === null || identityValid(file.identity)) ||
        (file.identity && file.identity.mode !== 0o600)) {
      return null;
    }
    const content = Buffer.from(file.contentBase64, 'base64');
    if (content.length !== file.bytes || digest(content) !== file.sha256 ||
        content.toString('base64') !== file.contentBase64) {
      return null;
    }
  }
  return parsed;
}

function identityValid(value) {
  return Boolean(value && exactKeys(value, ['dev', 'ino', 'mode']) &&
    /^(?:0|[1-9][0-9]*)$/.test(value.dev) &&
    /^(?:0|[1-9][0-9]*)$/.test(value.ino) &&
    Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777);
}

function helperIdentityValid(value) {
  return value === null || Boolean(value &&
    exactKeys(value, ['type', 'dev', 'ino', 'mode']) &&
    (value.type === 'directory' || value.type === 'other') &&
    /^(?:0|[1-9][0-9]*)$/.test(value.dev) &&
    /^(?:0|[1-9][0-9]*)$/.test(value.ino) &&
    Number.isSafeInteger(value.mode));
}

function sameIdentity(left, right) {
  return Boolean(left && right &&
    String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino));
}

function readStrictOwnedFile(fileSystem, filename, maximum) {
  const before = fileSystem.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.geteuid === 'function' && before.uid !== process.geteuid()) ||
      before.size > maximum) return null;
  const fd = fileSystem.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fileSystem.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        (typeof process.geteuid === 'function' && opened.uid !== process.geteuid()) ||
        opened.size !== before.size || !sameIdentity(before, opened)) return null;
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) return null;
      offset += count;
    }
    const after = fileSystem.fstatSync(fd);
    const atPath = fileSystem.lstatSync(filename);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, atPath) ||
        after.size !== opened.size || atPath.size !== opened.size) return null;
    return bytes;
  } finally {
    fileSystem.closeSync(fd);
  }
}

function strictControlIdentity(fileSystem, filename) {
  const before = fileSystem.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      (typeof process.geteuid === 'function' && before.uid !== process.geteuid())) {
    return null;
  }
  const fd = fileSystem.openSync(filename, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fileSystem.fstatSync(fd);
    const atPath = fileSystem.lstatSync(filename);
    if (!opened.isFile() || opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        !sameIdentity(before, opened) || !sameIdentity(opened, atPath)) {
      return null;
    }
    return Object.freeze({
      dev: String(opened.dev),
      ino: String(opened.ino),
      mode: opened.mode & 0o777,
    });
  } finally {
    fileSystem.closeSync(fd);
  }
}

function createWritingStructureTransactionService(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const helperPath = options.helperPath || DEFAULT_HELPER;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const hooks = options.hooks || {};

  function markerPath(rootPath) {
    return path.join(rootPath, MARKER_RELATIVE);
  }

  function receiptPath(rootPath) {
    return path.join(rootPath, RECEIPT_RELATIVE);
  }

  function ensureRecoveryDirectory(rootPath) {
    const metadataPath = path.join(rootPath, '.writcraft');
    const recoveryPath = path.join(metadataPath, 'recovery');
    const metadata = fileSystem.lstatSync(metadataPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid())) {
      fail('STRUCTURE_RECOVERY_INVALID', '结构创建恢复目录不可用');
    }
    try {
      fileSystem.mkdirSync(recoveryPath, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const recovery = fileSystem.lstatSync(recoveryPath);
    if (!recovery.isDirectory() || recovery.isSymbolicLink() ||
        (recovery.mode & 0o777) !== 0o700 ||
        (typeof process.geteuid === 'function' && recovery.uid !== process.geteuid())) {
      fail('STRUCTURE_RECOVERY_INVALID', '结构创建恢复目录不可用');
    }
    const canonicalRoot = fileSystem.realpathSync(rootPath);
    const canonicalRecovery = fileSystem.realpathSync(recoveryPath);
    const relative = path.relative(canonicalRoot, canonicalRecovery);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
      fail('STRUCTURE_RECOVERY_INVALID', '结构创建恢复目录不可用');
    }
    const fd = fileSystem.openSync(
      recoveryPath, fs.constants.O_RDONLY | DIRECTORY | NO_FOLLOW
    );
    const opened = fileSystem.fstatSync(fd);
    if (!opened.isDirectory() || (opened.mode & 0o777) !== 0o700 ||
        (typeof process.geteuid === 'function' && opened.uid !== process.geteuid()) ||
        !sameIdentity(opened, recovery)) {
      fileSystem.closeSync(fd);
      fail('STRUCTURE_RECOVERY_CHANGED', '结构创建恢复目录状态已变化');
    }
    return fd;
  }

  function readReceipt(rootPath, operationId, stage) {
    let bytes;
    try {
      bytes = readStrictOwnedFile(
        fileSystem,
        receiptPath(rootPath),
        MAX_RECEIPT_BYTES
      );
    } catch (_) {
      return null;
    }
    if (!bytes) return null;
    let receipt;
    try {
      const text = bytes.toString('utf8');
      if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
      receipt = JSON.parse(text.slice(0, -1));
    } catch (_) {
      return null;
    }
    if (!exactKeys(receipt, [
      'schema', 'operationId', 'stage', 'dev', 'ino', 'mode',
    ]) ||
        receipt.schema !== RECEIPT_SCHEMA ||
        receipt.operationId !== operationId ||
        receipt.stage !== stage ||
        !identityValid({ dev: receipt.dev, ino: receipt.ino, mode: receipt.mode }) ||
        receipt.mode !== 0o700) {
      return null;
    }
    return Object.freeze({
      dev: receipt.dev,
      ino: receipt.ino,
      mode: receipt.mode,
    });
  }

  function writeOwned(fd, bytes) {
    fileSystem.ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) {
        fail('STRUCTURE_WRITE_STALLED', '结构创建恢复记录写入失败');
      }
      offset += count;
    }
    fileSystem.fsyncSync(fd);
  }

  function openRoot(rootPath) {
    const before = fileSystem.lstatSync(rootPath);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail('STRUCTURE_ROOT_INVALID', '项目目录不可用于结构创建');
    }
    const fd = fileSystem.openSync(rootPath, fs.constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
    const opened = fileSystem.fstatSync(fd);
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      fileSystem.closeSync(fd);
      fail('STRUCTURE_ROOT_CHANGED', '项目状态已变化，请重新预览章节骨架');
    }
    return {
      fd,
      identity: Object.freeze({
        dev: String(opened.dev),
        ino: String(opened.ino),
        mode: opened.mode & 0o777,
      }),
    };
  }

  function parseHelper(execution, kind) {
    if (!execution || typeof execution.stdout !== 'string' ||
        Buffer.byteLength(execution.stdout, 'utf8') > MAX_HELPER_BYTES) return null;
    let value;
    try {
      const text = execution.stdout;
      if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) return null;
      value = JSON.parse(text.slice(0, -1));
    } catch (_) {
      return null;
    }
    if (kind === 'reserve') {
      return exactKeys(value, ['ok', 'operationId', 'stage', 'dev', 'ino', 'mode']) &&
        value.ok === true && identityValid({ dev: value.dev, ino: value.ino, mode: value.mode })
        ? value : null;
    }
    if (kind === 'inspect') {
      return exactKeys(value, ['ok', 'stage', 'target']) && value.ok === true &&
        helperIdentityValid(value.stage) && helperIdentityValid(value.target) ? value : null;
    }
    if (kind === 'write') {
      return exactKeys(value, ['ok', 'dev', 'ino', 'mode', 'bytes']) &&
        value.ok === true &&
        identityValid({ dev: value.dev, ino: value.ino, mode: value.mode }) &&
        value.mode === 0o600 &&
        Number.isSafeInteger(value.bytes) && value.bytes > 0 ? value : null;
    }
    if (kind === 'simple') {
      return exactKeys(value, ['ok']) && value.ok === true ? value : null;
    }
    return exactKeys(value, ['ok', 'errno', 'stage', 'target', 'expected']) &&
      typeof value.ok === 'boolean' && Number.isSafeInteger(value.errno) &&
      typeof value.expected === 'boolean' &&
      helperIdentityValid(value.stage) && helperIdentityValid(value.target) ? value : null;
  }

  function runHelper(rootFd, receiptFd, request, kind) {
    if (typeof hooks.beforeHelper === 'function') hooks.beforeHelper(kind, request);
    const stdio = ['pipe', 'pipe', 'pipe', rootFd];
    if (receiptFd !== null && receiptFd !== undefined) stdio.push(receiptFd);
    const execution = spawnSync(helperPath, [], {
      input: JSON.stringify(request),
      encoding: 'utf8',
      maxBuffer: MAX_HELPER_BYTES,
      stdio,
    });
    return { execution, report: parseHelper(execution, kind) };
  }

  function inspect(rootFd, marker) {
    const result = runHelper(rootFd, null, {
      mode: 'inspect',
      stage: marker.stage,
      target: TARGET_NAME,
    }, 'inspect');
    if (result.execution?.status !== 0) return null;
    return result.report;
  }

  function exactTree(rootFd, directoryName, directoryIdentity, marker) {
    if (!directoryIdentity || marker.files.some(file => !file.identity)) return false;
    for (const file of marker.files) {
      const verified = runHelper(rootFd, null, {
        mode: 'verify',
        directory: directoryName,
        dev: directoryIdentity.dev,
        ino: directoryIdentity.ino,
        name: file.name,
        contentBase64: file.contentBase64,
      }, 'simple');
      if (verified.execution?.status !== 0 || !verified.report) return false;
    }
    const sealed = runHelper(rootFd, null, {
      mode: 'seal',
      directory: directoryName,
      dev: directoryIdentity.dev,
      ino: directoryIdentity.ino,
      count: marker.files.length,
    }, 'simple');
    return sealed.execution?.status === 0 && Boolean(sealed.report);
  }

  function removeExactArtifacts(rootFd, rootPath, marker) {
    if (!marker.stageIdentity || marker.files.some(file => !file.identity)) return false;
    for (const file of marker.files) {
      const removed = runHelper(rootFd, null, {
        mode: 'remove',
        stage: marker.stage,
        dev: marker.stageIdentity.dev,
        ino: marker.stageIdentity.ino,
        name: file.name,
        fileDev: file.identity.dev,
        fileIno: file.identity.ino,
        contentBase64: file.contentBase64,
      }, 'simple');
      if (removed.execution?.status !== 0 || !removed.report) return false;
    }
    const removedStage = runHelper(rootFd, null, {
      mode: 'cleanupStage',
      stage: marker.stage,
      dev: marker.stageIdentity.dev,
      ino: marker.stageIdentity.ino,
    }, 'simple');
    if (removedStage.execution?.status !== 0 || !removedStage.report) return false;
    return clearControlFiles(rootFd, rootPath);
  }

  function removeEmptyStage(rootFd, rootPath, marker) {
    if (!marker.stageIdentity) return false;
    const removedStage = runHelper(rootFd, null, {
      mode: 'cleanupStage',
      stage: marker.stage,
      dev: marker.stageIdentity.dev,
      ino: marker.stageIdentity.ino,
    }, 'simple');
    return removedStage.execution?.status === 0 &&
      Boolean(removedStage.report) &&
      clearControlFiles(rootFd, rootPath);
  }

  function clearControlFiles(rootFd, rootPath) {
    let markerIdentity;
    let receiptIdentity;
    let recoveryFd;
    try {
      markerIdentity = strictControlIdentity(fileSystem, markerPath(rootPath));
      receiptIdentity = strictControlIdentity(fileSystem, receiptPath(rootPath));
      if (!markerIdentity || !receiptIdentity) return false;
      recoveryFd = ensureRecoveryDirectory(rootPath);
    } catch (_) {
      return false;
    }
    try {
      const cleared = runHelper(rootFd, recoveryFd, {
        mode: 'cleanupControls',
        markerDev: markerIdentity.dev,
        markerIno: markerIdentity.ino,
        receiptDev: receiptIdentity.dev,
        receiptIno: receiptIdentity.ino,
      }, 'simple');
      return cleared.execution?.status === 0 && Boolean(cleared.report);
    } finally {
      fileSystem.closeSync(recoveryFd);
    }
  }

  function readMarker(rootPath) {
    try {
      return parseMarker(readStrictOwnedFile(
        fileSystem,
        markerPath(path.resolve(rootPath)),
        MAX_MARKER_BYTES
      ));
    } catch (_) {
      return null;
    }
  }

  function reconcile(rootPath, marker) {
    const root = openRoot(rootPath);
    try {
      if (!sameIdentity(root.identity, marker.rootIdentity)) {
        return Object.freeze({ ok: false, state: 'UNKNOWN', operationId: marker.operationId });
      }
      if (marker.stageIdentity === null && marker.phase === 'PREPARING') {
        const durableReservation = readReceipt(
          rootPath, marker.operationId, marker.stage
        );
        if (durableReservation) marker.stageIdentity = durableReservation;
      }
      const report = inspect(root.fd, marker);
      if (!report) {
        return Object.freeze({ ok: false, state: 'UNKNOWN', operationId: marker.operationId });
      }
      if (report.stage === null && report.target &&
          sameIdentity(report.target, marker.stageIdentity) &&
          exactTree(root.fd, TARGET_NAME, marker.stageIdentity, marker)) {
        marker.phase = 'COMMITTED';
        try {
          const markerFd = fileSystem.openSync(markerPath(rootPath), fs.constants.O_RDWR | NO_FOLLOW);
          try { writeOwned(markerFd, encodeMarker(marker)); } finally { fileSystem.closeSync(markerFd); }
          fileSystem.fsyncSync(root.fd);
        } catch (_) {
          // Disk identity proves commit even if durable terminal bookkeeping still needs retry.
        }
        return Object.freeze({
          ok: true,
          state: 'COMMITTED',
          operationId: marker.operationId,
          files: marker.files.map(file => Object.freeze({
            path: `${TARGET_NAME}/${file.name}`,
            revision: file.sha256,
          })),
        });
      }
      if (report.target === null &&
          (report.stage === null ||
           (marker.stageIdentity && sameIdentity(report.stage, marker.stageIdentity)))) {
        if (report.stage !== null &&
            removeExactArtifacts(root.fd, rootPath, marker)) {
          return Object.freeze({
            ok: false,
            state: 'UNCOMMITTED',
            operationId: marker.operationId,
          });
        }
        if (report.stage === null &&
            clearControlFiles(root.fd, rootPath)) {
          return Object.freeze({
            ok: false,
            state: 'UNCOMMITTED',
            operationId: marker.operationId,
          });
        }
      }
      return Object.freeze({ ok: false, state: 'UNKNOWN', operationId: marker.operationId });
    } finally {
      fileSystem.closeSync(root.fd);
    }
  }

  function commit({ rootPath: rawRootPath, projectId, prepared, beforePublish }) {
    const rootPath = path.resolve(rawRootPath);
    if (!isAuthenticWritingStructurePreparedRecord(prepared) ||
        prepared.rootPath !== rootPath ||
        computeStructureProposalDigest(prepared.files) !== prepared.proposalDigest) {
      fail('STRUCTURE_CAPABILITY_INVALID', '结构确认能力无效或已过期');
    }
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(projectId)) {
      fail('STRUCTURE_PROJECT_INVALID', '项目标识无效');
    }
    if (hasPending(rootPath)) {
      const existing = query({ rootPath, projectId });
      if (existing.state !== 'UNCOMMITTED') return existing;
    }
    const root = openRoot(rootPath);
    try {
      const recoveryDirectoryFd = ensureRecoveryDirectory(rootPath);
      fileSystem.closeSync(recoveryDirectoryFd);
    } catch (error) {
      fileSystem.closeSync(root.fd);
      throw error;
    }
    const operationId = `wst_${randomBytes(24).toString('hex')}`;
    const stage = `.writcraft-structure-stage-${operationId.slice(4)}`;
    const files = prepared.files.map(file => ({
      name: path.posix.basename(file.path),
      bytes: file.bytes,
      sha256: file.sha256,
      contentBase64: Buffer.from(file.content, 'utf8').toString('base64'),
      identity: null,
    }));
    const marker = {
      schema: MARKER_SCHEMA,
      operationId,
      projectId,
      projectInstanceId: prepared.projectInstanceId,
      navigationId: prepared.navigationId,
      mutationGeneration: prepared.mutationGeneration,
      navigationEpoch: prepared.navigationEpoch,
      editRevision: prepared.editRevision,
      emptyTreeDigest: prepared.emptyTreeDigest,
      stage,
      target: TARGET_NAME,
      phase: 'PREPARING',
      proposalDigest: prepared.proposalDigest,
      files,
      stageIdentity: null,
      rootIdentity: root.identity,
    };
    let markerFd;
    let receiptFd;
    let publishInvoked = false;
    try {
      markerFd = fileSystem.openSync(
        markerPath(rootPath),
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      fileSystem.fchmodSync(markerFd, 0o600);
      writeOwned(markerFd, encodeMarker(marker));
      receiptFd = fileSystem.openSync(
        receiptPath(rootPath),
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      fileSystem.fchmodSync(receiptFd, 0o600);
      fileSystem.fsyncSync(receiptFd);
      const recoveryFd = fileSystem.openSync(
        path.dirname(markerPath(rootPath)), fs.constants.O_RDONLY | DIRECTORY | NO_FOLLOW
      );
      try { fileSystem.fsyncSync(recoveryFd); } finally { fileSystem.closeSync(recoveryFd); }
      const reserved = runHelper(root.fd, receiptFd, {
        mode: 'reserve',
        operationId,
        stage,
      }, 'reserve');
      if (reserved.execution?.status === 2) {
        if (clearControlFiles(root.fd, rootPath)) {
          return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
        }
        return Object.freeze({ ok: false, state: 'UNKNOWN', operationId });
      }
      const durableReservation = readReceipt(rootPath, operationId, stage);
      const reportedReservation = reserved.report && {
        dev: reserved.report.dev,
        ino: reserved.report.ino,
        mode: reserved.report.mode,
      };
      if (!durableReservation ||
          (reserved.report && (
            reserved.report.operationId !== operationId ||
            reserved.report.stage !== stage ||
            reserved.report.mode !== 0o700 ||
            !sameIdentity(durableReservation, reportedReservation)
          ))) {
        return reconcile(rootPath, marker);
      }
      marker.stageIdentity = durableReservation;
      marker.phase = 'RESERVED';
      writeOwned(markerFd, encodeMarker(marker));
      for (const file of files) {
        const written = runHelper(root.fd, null, {
          mode: 'write',
          directory: stage,
          dev: marker.stageIdentity.dev,
          ino: marker.stageIdentity.ino,
          name: file.name,
          contentBase64: file.contentBase64,
        }, 'write');
        if (written.execution?.status !== 0 || !written.report ||
            written.report.bytes !== file.bytes) {
          fail('STRUCTURE_STAGE_WRITE_FAILED', '章节骨架暂存写入失败');
        }
        file.identity = Object.freeze({
          dev: written.report.dev,
          ino: written.report.ino,
          mode: written.report.mode,
        });
        writeOwned(markerFd, encodeMarker(marker));
      }
      if (!exactTree(root.fd, stage, marker.stageIdentity, marker)) {
        fail('STRUCTURE_STAGE_CHANGED', '章节骨架暂存区状态不一致');
      }
      marker.phase = 'COMMITTING';
      writeOwned(markerFd, encodeMarker(marker));
      if (typeof beforePublish === 'function') {
        const check = beforePublish(Object.freeze({
          operationId,
          proposalDigest: marker.proposalDigest,
        }));
        if (check && typeof check.then === 'function') {
          fail('STRUCTURE_ASYNC_PRECOMMIT', '结构创建最终确认必须同步完成');
        }
      }
      publishInvoked = true;
      const published = runHelper(root.fd, null, {
        mode: 'publish',
        stage,
        target: TARGET_NAME,
        dev: marker.stageIdentity.dev,
        ino: marker.stageIdentity.ino,
      }, 'publish');
      if (published.execution?.status === 2 && published.report &&
          published.report.ok === false &&
          published.report.errno === 17 &&
          published.report.expected === false &&
          published.report.stage &&
          sameIdentity(published.report.stage, marker.stageIdentity) &&
          published.report.target !== null &&
          exactTree(root.fd, stage, marker.stageIdentity, marker) &&
          removeExactArtifacts(root.fd, rootPath, marker)) {
        return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
      }
      if (published.execution?.status !== 0 || !published.report ||
          published.report.ok !== true || published.report.expected !== true) {
        return reconcile(rootPath, marker);
      }
      marker.phase = 'COMMITTED';
      writeOwned(markerFd, encodeMarker(marker));
      try {
        fileSystem.fsyncSync(root.fd);
      } catch (_) {
        return Object.freeze({
          ok: true,
          state: 'COMMITTED',
          operationId,
          files: files.map(file => Object.freeze({
            path: `${TARGET_NAME}/${file.name}`,
            revision: file.sha256,
          })),
          warning: 'STRUCTURE_DURABILITY_PENDING',
        });
      }
      return Object.freeze({
        ok: true,
        state: 'COMMITTED',
        operationId,
        files: files.map(file => Object.freeze({
          path: `${TARGET_NAME}/${file.name}`,
          revision: file.sha256,
        })),
      });
    } catch (error) {
      if (publishInvoked) return reconcile(rootPath, marker);
      if (marker.stageIdentity &&
          exactTree(root.fd, stage, marker.stageIdentity, marker) &&
          removeExactArtifacts(root.fd, rootPath, marker)) {
        return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
      }
      const knownFiles = marker.files.filter(file => file.identity);
      if (marker.stageIdentity && knownFiles.length > 0 &&
          removeExactArtifacts(root.fd, rootPath, {
            ...marker,
            files: knownFiles,
          })) {
        return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
      }
      if (marker.stageIdentity && knownFiles.length === 0 &&
          removeEmptyStage(root.fd, rootPath, marker)) {
        return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
      }
      if (!marker.stageIdentity && clearControlFiles(root.fd, rootPath)) {
        return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId });
      }
      return Object.freeze({ ok: false, state: 'UNKNOWN', operationId });
    } finally {
      if (receiptFd !== undefined) fileSystem.closeSync(receiptFd);
      if (markerFd !== undefined) fileSystem.closeSync(markerFd);
      fileSystem.closeSync(root.fd);
    }
  }

  function query({ rootPath: rawRootPath, projectId }) {
    const rootPath = path.resolve(rawRootPath);
    const marker = readMarker(rootPath);
    if (!marker) {
      if (hasPending(rootPath)) {
        return Object.freeze({ ok: false, state: 'UNKNOWN', operationId: null });
      }
      return Object.freeze({ ok: false, state: 'UNCOMMITTED', operationId: null });
    }
    if (marker.projectId !== projectId) {
      return Object.freeze({ ok: false, state: 'UNKNOWN', operationId: marker.operationId });
    }
    return reconcile(rootPath, marker);
  }

  function acknowledge({ rootPath: rawRootPath, projectId, operationId }) {
    const rootPath = path.resolve(rawRootPath);
    const marker = readMarker(rootPath);
    if (!marker || marker.projectId !== projectId || marker.operationId !== operationId) {
      fail('STRUCTURE_RECOVERY_STALE', '结构创建恢复记录已变化');
    }
    const state = reconcile(rootPath, marker);
    if (state.state !== 'COMMITTED') return state;
    let cleared = false;
    let root;
    try {
      root = openRoot(rootPath);
      cleared = clearControlFiles(root.fd, rootPath);
    } catch (_) {
      cleared = false;
    } finally {
      if (root) fileSystem.closeSync(root.fd);
    }
    return Object.freeze({ ...state, acknowledged: cleared });
  }

  function hasPending(rawRootPath) {
    try {
      fileSystem.lstatSync(markerPath(path.resolve(rawRootPath)));
      return true;
    } catch (error) {
      return error.code !== 'ENOENT';
    }
  }

  return Object.freeze({
    commit,
    query,
    acknowledge,
    hasPending,
    readMarker,
  });
}

module.exports = Object.freeze({
  MARKER_RELATIVE,
  RECEIPT_RELATIVE,
  MARKER_SCHEMA,
  RECEIPT_SCHEMA,
  WritingStructureTransactionError,
  createWritingStructureTransactionService,
});
