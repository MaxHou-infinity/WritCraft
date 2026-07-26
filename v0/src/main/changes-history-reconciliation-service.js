'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultProjectService = require('./project-service');
const defaultHistoryService = require('./change-history-service');

const RECOVERY_SCHEMA = 'writcraft.changes-history-recovery/v1';
const RECOVERY_RELATIVE_PATH = '.writcraft/recovery/changes-history-transaction.json';
const MAX_MARKER_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 64;
const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const KINDS = Object.freeze(['apply', 'review', 'undo']);
const STATES = Object.freeze(['applying', 'terminal']);
const OUTCOMES = Object.freeze([
  'applied',
  'reviewed',
  'undone',
  'zero_write_error',
  'committed_warning',
  'manual_recovery',
]);
const SAFE_CLEAR_OUTCOMES = new Set(['applied', 'reviewed', 'undone', 'zero_write_error']);

class ChangesHistoryRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryRecoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryRecoveryError(code, message);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} 结构无效`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} 字段无效`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
      value.includes('\0') || value.includes('\\') || value.startsWith('/') ||
      /^[A-Za-z]:/.test(value)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复文件路径无效');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复文件路径无效');
  }
  return parts.join('/');
}

function canonical(value) {
  return JSON.stringify(value);
}

function projectIdentity(projectService, rootPath, expectedProjectId) {
  let project;
  try { project = projectService.openProjectForRecovery(rootPath); }
  catch (_) { project = projectService.openProject(rootPath); }
  if (!project || typeof project.projectId !== 'string' || !project.projectId ||
      project.projectId.length > 256 || /[\0\r\n]/.test(project.projectId)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '项目身份无效');
  }
  if (expectedProjectId !== undefined && expectedProjectId !== project.projectId) {
    fail('CHANGES_RECOVERY_STALE', '恢复操作不属于当前项目');
  }
  return project;
}

function markerLocation(rootPath, create, fileSystem = fs) {
  const root = fileSystem.realpathSync(path.resolve(rootPath));
  const rootStat = fileSystem.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '项目目录不安全');
  }
  const metadata = path.join(root, '.writcraft');
  if (!fileSystem.existsSync(metadata)) {
    if (!create) return { root, directory: path.join(metadata, 'recovery'), file: path.join(root, RECOVERY_RELATIVE_PATH), exists: false };
    fileSystem.mkdirSync(metadata, { mode: 0o700 });
  }
  const metadataStat = fileSystem.lstatSync(metadata);
  if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink() ||
      fileSystem.realpathSync(metadata) !== metadata) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '.writcraft 目录不安全');
  }
  const directory = path.join(metadata, 'recovery');
  if (!fileSystem.existsSync(directory)) {
    if (create) fileSystem.mkdirSync(directory, { mode: 0o700 });
  }
  if (fileSystem.existsSync(directory)) {
    const directoryStat = fileSystem.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        fileSystem.realpathSync(directory) !== directory) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复目录不安全');
    }
  }
  const file = path.join(directory, 'changes-history-transaction.json');
  if (fileSystem.existsSync(file)) {
    const stat = fileSystem.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记必须是独占普通文件');
    }
    return { root, directory, file, exists: true };
  }
  return { root, directory, file, exists: false };
}

function syncDirectory(directory, fileSystem = fs) {
  const fd = fileSystem.openSync(directory, 'r');
  try { fileSystem.fsyncSync(fd); } finally { fileSystem.closeSync(fd); }
}

function atomicWriteMarker(location, serialized, fileSystem = fs, beforeRename, createExclusive = false) {
  const temporary = path.join(
    location.directory,
    `.changes-history.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fileSystem.openSync(temporary, 'wx', 0o600);
    fileSystem.writeFileSync(fd, serialized, 'utf8');
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;
    if (typeof beforeRename === 'function') beforeRename(location);
    if (createExclusive) {
      // link(2) publishes a fully-fsynced inode only if the destination does
      // not exist. Unlike rename, it cannot overwrite a marker concurrently
      // created by another WritCraft process.
      try {
        fileSystem.linkSync(temporary, location.file);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          fail('CHANGES_RECOVERY_PENDING', '项目存在并发 Changes/History 恢复');
        }
        throw error;
      }
      fileSystem.unlinkSync(temporary);
    } else {
      fileSystem.renameSync(temporary, location.file);
    }
    syncDirectory(location.directory, fileSystem);
    const final = markerLocation(location.root, false, fileSystem);
    if (!final.exists) fail('CHANGES_RECOVERY_WRITE_FAILED', '恢复标记未持久化');
  } catch (error) {
    if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    try { fileSystem.unlinkSync(temporary); } catch (_) {}
    if (error instanceof ChangesHistoryRecoveryError) throw error;
    const wrapped = new ChangesHistoryRecoveryError(
      'CHANGES_RECOVERY_WRITE_FAILED',
      '恢复标记无法安全持久化'
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function validateFile(raw, projectService, index) {
  exactKeys(raw, ['path', 'before', 'after'], `files[${index}]`);
  const filePath = publicMarkdownPath(raw.path);
  const validateState = (state, label) => {
    exactKeys(state, ['revision', 'content'], label);
    if (typeof state.content !== 'string' || !REVISION_RE.test(state.revision || '') ||
        sha256(state.content) !== state.revision) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} 正文与 revision 不一致`);
    }
    return { revision: state.revision, content: state.content };
  };
  return {
    path: filePath,
    before: validateState(raw.before, `files[${index}].before`),
    after: validateState(raw.after, `files[${index}].after`),
  };
}

function validateHistoryState(raw, historyService, label) {
  exactKeys(raw, ['exists', 'history'], label);
  if (typeof raw.exists !== 'boolean') fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label}.exists 无效`);
  const history = historyService.validateHistory(raw.history);
  if (!raw.exists && history.entries.length) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} 不存在却包含历史记录`);
  }
  return { exists: raw.exists, history };
}

function markerPayload(marker) {
  const { integrity: _integrity, ...payload } = marker;
  return payload;
}

function validateMarker(raw, projectService, historyService) {
  exactKeys(raw, [
    'schema', 'operationId', 'projectId', 'kind', 'state', 'outcome', 'files',
    'baseHistoryState', 'preparedHistoryState', 'recoveryWritePending',
    'createdAt', 'updatedAt', 'integrity',
  ], 'marker');
  if (raw.schema !== RECOVERY_SCHEMA || !OPERATION_ID_RE.test(raw.operationId || '') ||
      typeof raw.projectId !== 'string' || !raw.projectId || raw.projectId.length > 256 ||
      /[\0\r\n]/.test(raw.projectId) || !KINDS.includes(raw.kind) || !STATES.includes(raw.state) ||
      (raw.state === 'applying' ? raw.outcome !== null : !OUTCOMES.includes(raw.outcome)) ||
      !Array.isArray(raw.files) || raw.files.length > MAX_FILES ||
      (raw.kind === 'review' ? raw.files.length !== 0 : raw.files.length === 0) ||
      typeof raw.recoveryWritePending !== 'boolean' ||
      typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt)) ||
      typeof raw.updatedAt !== 'string' || Number.isNaN(Date.parse(raw.updatedAt)) ||
      !REVISION_RE.test(raw.integrity || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记身份或状态无效');
  }
  const seen = new Set();
  const files = raw.files.map((file, index) => {
    const valid = validateFile(file, projectService, index);
    if (seen.has(valid.path)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记包含重复文件');
    seen.add(valid.path);
    return valid;
  });
  const valid = {
    schema: RECOVERY_SCHEMA,
    operationId: raw.operationId,
    projectId: raw.projectId,
    kind: raw.kind,
    state: raw.state,
    outcome: raw.outcome,
    files,
    baseHistoryState: validateHistoryState(raw.baseHistoryState, historyService, 'baseHistoryState'),
    preparedHistoryState: validateHistoryState(raw.preparedHistoryState, historyService, 'preparedHistoryState'),
    recoveryWritePending: raw.recoveryWritePending,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  if (raw.integrity !== sha256(canonical(valid))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记完整性校验失败');
  }
  return { ...valid, integrity: raw.integrity };
}

function serializeMarker(marker, projectService, historyService) {
  const valid = validateMarker(marker, projectService, historyService);
  const serialized = `${JSON.stringify(valid, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MARKER_BYTES) {
    fail('CHANGES_RECOVERY_WRITE_FAILED', '恢复标记超过安全上限');
  }
  return serialized;
}

function sameHistoryState(left, right) {
  return left.exists === right.exists &&
    (!left.exists || canonical(left.history) === canonical(right.history));
}

function publicMarker(marker) {
  return Object.freeze({
    schema: RECOVERY_SCHEMA,
    operationId: marker.operationId,
    projectId: marker.projectId,
    kind: marker.kind,
    state: marker.state,
    outcome: marker.outcome,
    affectedPaths: Object.freeze(marker.files.map(file => file.path)),
    createdAt: marker.createdAt,
    updatedAt: marker.updatedAt,
    actions: Object.freeze(
      ['committed_warning', 'manual_recovery'].includes(marker.outcome)
        ? ['restore_before', 'keep_after']
        : []
    ),
  });
}

function createChangesHistoryReconciliationService(options = {}) {
  const projectService = options.projectService || defaultProjectService;
  const historyService = options.historyService || defaultHistoryService;
  const fileSystem = options.fileSystem || fs;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const beforeMarkerRename = options.beforeMarkerRename;
  const beforeClear = options.beforeClear;

  function readMarker(rootPath) {
    const location = markerLocation(rootPath, false, fileSystem);
    if (!location.exists) return null;
    const stat = fileSystem.lstatSync(location.file);
    if (stat.size > MAX_MARKER_BYTES) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记超过安全上限');
    }
    let raw;
    try { raw = JSON.parse(fileSystem.readFileSync(location.file, 'utf8')); }
    catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记损坏'); }
    return validateMarker(raw, projectService, historyService);
  }

  function persist(rootPath, marker, expectedMarker = null) {
    const location = markerLocation(rootPath, true, fileSystem);
    if (expectedMarker === null && location.exists) {
      fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
    }
    if (expectedMarker !== null && !location.exists) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    const next = {
      ...markerPayload(marker),
      integrity: sha256(canonical(markerPayload(marker))),
    };
    const serialized = serializeMarker(next, projectService, historyService);
    atomicWriteMarker(location, serialized, fileSystem, () => {
      if (typeof beforeMarkerRename === 'function') beforeMarkerRename(location);
      const currentLocation = markerLocation(location.root, true, fileSystem);
      if (expectedMarker === null) {
        if (currentLocation.exists) {
          fail('CHANGES_RECOVERY_PENDING', '项目存在并发 Changes/History 恢复');
        }
        return;
      }
      if (!currentLocation.exists) fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
      const current = readMarker(rootPath);
      if (current.operationId !== expectedMarker.operationId ||
          current.integrity !== expectedMarker.integrity) {
        fail('CHANGES_RECOVERY_STALE', '恢复标记已被其他操作更新');
      }
    }, expectedMarker === null);
    return next;
  }

  function prepare(rootPath, sealedTransaction) {
    const project = projectIdentity(projectService, rootPath, sealedTransaction?.projectId);
    const location = markerLocation(rootPath, true, fileSystem);
    if (location.exists) fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
    if (!sealedTransaction || typeof sealedTransaction !== 'object' ||
        !KINDS.includes(sealedTransaction.kind)) {
      fail('CHANGES_RECOVERY_WRITE_FAILED', '待恢复事务无效');
    }
    const timestamp = now();
    const payload = {
      schema: RECOVERY_SCHEMA,
      operationId: `chr_${crypto.randomBytes(24).toString('hex')}`,
      projectId: project.projectId,
      kind: sealedTransaction.kind,
      state: 'applying',
      outcome: null,
      files: cloneJson(sealedTransaction.files),
      baseHistoryState: cloneJson(sealedTransaction.baseHistoryState),
      preparedHistoryState: cloneJson(sealedTransaction.preparedHistoryState),
      recoveryWritePending: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return persist(rootPath, payload);
  }

  function authoritativeState(rootPath, marker) {
    const fileStates = marker.files.map(file => {
      try {
        const current = projectService.readFileWithRevision(rootPath, file.path);
        const actualHash = sha256(current.content);
        if (current.revision !== actualHash) return 'foreign';
        if (current.revision === file.before.revision && current.content === file.before.content) return 'before';
        if (current.revision === file.after.revision && current.content === file.after.content) return 'after';
        return 'foreign';
      } catch (_) {
        return 'foreign';
      }
    });
    let historyState;
    try { historyState = historyService.loadHistoryState(rootPath); }
    catch (_) { historyState = null; }
    const history = historyState === null
      ? 'foreign'
      : sameHistoryState(historyState, marker.baseHistoryState)
        ? 'base'
        : sameHistoryState(historyState, marker.preparedHistoryState)
          ? 'prepared'
          : 'foreign';
    return { fileStates, history };
  }

  function outcomeFor(marker, authority) {
    const allBefore = authority.fileStates.every(state => state === 'before');
    const allAfter = authority.fileStates.every(state => state === 'after');
    if (allBefore && authority.history === 'base') return 'zero_write_error';
    if (allAfter && authority.history === 'prepared') {
      return marker.kind === 'apply' ? 'applied' : marker.kind === 'review' ? 'reviewed' : 'undone';
    }
    if (allAfter && authority.history === 'base') return 'committed_warning';
    return 'manual_recovery';
  }

  function classify(rootPath, operationId, projectId, options = {}) {
    projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker) return null;
    if (marker.operationId !== operationId || (projectId !== undefined && marker.projectId !== projectId)) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    // A recovery action persists this lock before rewriting any authority.
    // Current bytes alone cannot clear it: a prior rename may have been
    // followed by a failed directory fsync. Only a successful retry may ask
    // classification to release the durability lock.
    if (marker.recoveryWritePending && options.releaseRecoveryWrite !== true) {
      return marker;
    }
    const outcome = outcomeFor(marker, authoritativeState(rootPath, marker));
    return persist(rootPath, {
      ...markerPayload(marker),
      state: 'terminal',
      outcome,
      recoveryWritePending: false,
      updatedAt: now(),
    }, marker);
  }

  function query(rootPath, projectId) {
    const project = projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker) return { ok: true, recovery: null };
    if (marker.projectId !== project.projectId) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记属于其他项目');
    }
    const classified = classify(rootPath, marker.operationId, project.projectId);
    return { ok: true, recovery: publicMarker(classified) };
  }

  function finish(rootPath, operationId) {
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    return classify(rootPath, operationId, marker.projectId);
  }

  function resolve(rootPath, projectId, operationId, action) {
    projectIdentity(projectService, rootPath, projectId);
    if (!['restore_before', 'keep_after'].includes(action)) {
      fail('CHANGES_RECOVERY_CONFLICT', '恢复选择无效');
    }
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    if (marker.state !== 'terminal' ||
        !['committed_warning', 'manual_recovery'].includes(marker.outcome)) {
      fail('CHANGES_RECOVERY_CONFLICT', '当前恢复状态不允许人工改写');
    }
    const authority = authoritativeState(rootPath, marker);
    if (authority.fileStates.some(state => !['before', 'after'].includes(state)) ||
        !['base', 'prepared'].includes(authority.history)) {
      fail('CHANGES_RECOVERY_CONFLICT', '文件或 History 已发生第三方变化');
    }
    const targetField = action === 'restore_before' ? 'before' : 'after';
    const targetHistory = action === 'restore_before'
      ? marker.baseHistoryState
      : marker.preparedHistoryState;
    const expectedHistory = authority.history === 'base'
      ? marker.baseHistoryState
      : marker.preparedHistoryState;
    const lockedMarker = persist(rootPath, {
      ...markerPayload(marker),
      state: 'terminal',
      outcome: 'manual_recovery',
      recoveryWritePending: true,
      updatedAt: now(),
    }, marker);
    let writeError = null;
    try {
      for (let index = 0; index < lockedMarker.files.length; index += 1) {
        const file = lockedMarker.files[index];
        const state = authority.fileStates[index];
        const expected = file[state].revision;
        if (state !== targetField || lockedMarker.recoveryWritePending) {
          projectService.atomicWriteFile(rootPath, file.path, file[targetField].content, expected);
        }
      }
      historyService.restoreHistoryState(rootPath, targetHistory, {
        expectedState: expectedHistory,
      });
    } catch (error) {
      writeError = error;
    }
    if (writeError) {
      const error = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        '恢复写入未能完成持久化证明'
      );
      error.cause = writeError;
      throw error;
    }
    const classified = classify(rootPath, operationId, projectId, {
      releaseRecoveryWrite: true,
    });
    const expectedOutcome = action === 'restore_before'
      ? 'zero_write_error'
      : marker.kind === 'apply' ? 'applied' : marker.kind === 'review' ? 'reviewed' : 'undone';
    if (classified.outcome !== expectedOutcome) {
      const error = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        '恢复写入未能达到选定状态'
      );
      error.cause = writeError;
      throw error;
    }
    return { ok: true, recovery: publicMarker(classified) };
  }

  function clear(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    const classified = classify(rootPath, operationId, projectId);
    if (!SAFE_CLEAR_OUTCOMES.has(classified.outcome)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复尚未达到可清理状态');
    }
    const location = markerLocation(rootPath, false, fileSystem);
    const serialized = fileSystem.readFileSync(location.file, 'utf8');
    try {
      if (typeof beforeClear === 'function') beforeClear(location);
      fileSystem.unlinkSync(location.file);
      syncDirectory(location.directory, fileSystem);
    } catch (error) {
      // If unlink succeeded but the directory durability proof failed, restore
      // the exact terminal marker before reporting failure. The project must
      // remain locked until a later exact-clear can prove durable removal.
      if (!fileSystem.existsSync(location.file)) {
        try {
          atomicWriteMarker(location, serialized, fileSystem, () => {
            if (markerLocation(location.root, true, fileSystem).exists) {
              fail('CHANGES_RECOVERY_PENDING', '恢复标记已被其他操作恢复');
            }
          });
        } catch (_) {
          // atomicWriteMarker renames the fully fsynced temporary before its
          // directory sync. Even if the injected durability check still
          // fails, retain any restored marker and return the original error.
        }
      }
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        '恢复标记无法安全清理'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return { ok: true, operationId };
  }

  function hasPending(rootPath) {
    return markerLocation(rootPath, false, fileSystem).exists;
  }

  return Object.freeze({
    prepare,
    finish,
    query,
    classify,
    resolve,
    clear,
    hasPending,
    readMarker,
  });
}

module.exports = {
  RECOVERY_SCHEMA,
  RECOVERY_RELATIVE_PATH,
  MAX_MARKER_BYTES,
  ChangesHistoryRecoveryError,
  createChangesHistoryReconciliationService,
};
