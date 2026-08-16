'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultProjectService = require('./project-service');
const defaultHistoryService = require('./change-history-service');
const recoveryArtifact = require('./changes-history-recovery-artifact');
const publicMarkdownPhaseSchema = require('./snapshot-public-markdown-phase-schema');
const undoSettlementSchema = require('./snapshot-public-markdown-undo-settlement-schema');
const undoFinalizationSchema = require('./snapshot-public-markdown-undo-finalization-schema');
const evidenceDeliverySchema = require('./evidence-delivery-schema');
const publicMarkdownNativeSchema = require('./public-markdown-native-schema');
const markerJournalSchema = require('./changes-history-marker-journal-schema');
const markerJournalNativeSchema = require('./changes-history-marker-journal-native-schema');
const existingRestoreSchema = require('./snapshot-existing-restore-native-schema');
const existingJournalBindingSchema = require('./snapshot-existing-journal-binding-schema');

const RECOVERY_SCHEMA = 'writcraft.changes-history-recovery/v1';
const RECOVERY_RELATIVE_PATH = '.writcraft/recovery/changes-history-transaction.json';
// Snapshot restore uses a small control marker plus a separately fsynced,
// hash-bound binary artifact. Legacy v1 markers retain their original cap.
const MAX_MARKER_BYTES = 96 * 1024 * 1024;
const MAX_FILES = 300;
const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const KINDS = Object.freeze(['apply', 'review', 'undo', 'snapshot_restore', 'snapshot_restore_undo']);
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
const CREATE_REQUEST_SCHEMA = 'writcraft.public-markdown-create-request/v1';
const CREATE_RECEIPT_SCHEMA = 'writcraft.public-markdown-create-receipt/v1';
const FINALIZE_ACK_SCHEMA = 'writcraft.public-markdown-finalize-ack/v1';
const ARTIFACT_CLEANUP_AUTHORITY_SCHEMA =
  'writcraft.changes-history-artifact-cleanup-authority/v1';

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

function descriptorValues(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} structure invalid`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} keys invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') ||
        Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label}.${key} must be plain data`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function descriptorArray(value, length, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.length?.value !== length || Reflect.ownKeys(value).length !== length + 1) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} length invalid`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') ||
        Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} must be dense plain data`);
    }
    return descriptor.value;
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
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
  return evidenceDeliverySchema.canonicalJson(value);
}

function legacyMarkerCanonical(value) {
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

function validateLegacyFile(raw, index) {
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

function validateSnapshotFile(raw, index, kind, phaseBacked = false) {
  exactKeys(raw, [
    'path', 'beforeExists', 'beforeRevision', 'afterExists', 'afterRevision',
    'createdIdentityDigest',
  ], `files[${index}]`);
  const filePath = publicMarkdownPath(raw.path);
  if (typeof raw.beforeExists !== 'boolean' || typeof raw.afterExists !== 'boolean' ||
      (raw.beforeExists ? !REVISION_RE.test(raw.beforeRevision || '') : raw.beforeRevision !== null) ||
      (raw.afterExists ? !REVISION_RE.test(raw.afterRevision || '') : raw.afterRevision !== null)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery file binding 无效');
  }
  if (!raw.beforeExists && !raw.afterExists) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记不得包含双端缺失文件');
  }
  if ((kind === 'snapshot_restore' && !raw.afterExists) ||
      (kind === 'snapshot_restore_undo' && !raw.beforeExists)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot restore/undo 方向无效');
  }
  if (raw.createdIdentityDigest !== null &&
      (typeof raw.createdIdentityDigest !== 'string' ||
       !/^sha256:[a-f0-9]{64}$/.test(raw.createdIdentityDigest))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'createdIdentityDigest 无效');
  }
  const createsOrDeletesLeaf = kind === 'snapshot_restore'
    ? !raw.beforeExists
    : !raw.afterExists;
  if (createsOrDeletesLeaf !== (raw.createdIdentityDigest !== null) &&
      !(phaseBacked && kind === 'snapshot_restore' && createsOrDeletesLeaf &&
        raw.createdIdentityDigest === null)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '缺失 leaf 事务必须绑定 createdIdentityDigest');
  }
  return {
    path: filePath,
    beforeExists: raw.beforeExists,
    beforeRevision: raw.beforeRevision,
    afterExists: raw.afterExists,
    afterRevision: raw.afterRevision,
    createdIdentityDigest: raw.createdIdentityDigest,
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

function validateHistoryBinding(raw, label) {
  exactKeys(raw, ['exists', 'digest'], label);
  if (typeof raw.exists !== 'boolean' || !REVISION_RE.test(raw.digest || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} History binding 无效`);
  }
  return { exists: raw.exists, digest: raw.digest };
}

function validateArtifactBinding(raw) {
  const template = raw?.schema === 'writcraft.changes-history-recovery-artifact/v2';
  exactKeys(raw, [
    'schema', 'basename', 'byteLength', 'sha256', 'baseHistoryDigest',
    template ? 'historyTemplateDigest' : 'preparedHistoryDigest',
    ...(template ? ['identity'] : []),
  ], 'artifact');
  if (![
    'writcraft.changes-history-recovery-artifact/v1',
    'writcraft.changes-history-recovery-artifact/v2',
  ].includes(raw.schema) ||
      !/^changes-history-chr_[a-f0-9]{48}\.bin$/.test(raw.basename || '') ||
      !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 1 ||
      raw.byteLength > recoveryArtifact.MAX_ARTIFACT_BYTES ||
      !/^sha256:[a-f0-9]{64}$/.test(raw.sha256 || '') ||
      !REVISION_RE.test(raw.baseHistoryDigest || '') ||
      !REVISION_RE.test(template ? raw.historyTemplateDigest || '' : raw.preparedHistoryDigest || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery artifact binding 无效');
  }
  let identity;
  if (template) {
    exactKeys(raw.identity, [
      'dev', 'ino', 'uid', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs',
    ], 'artifact.identity');
    if (Object.values(raw.identity).some(value => typeof value !== 'string' || !/^[0-9]+$/.test(value)) ||
        raw.identity.size !== String(raw.byteLength) || raw.identity.nlink !== '1') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery artifact identity binding 无效');
    }
    identity = {
      dev: raw.identity.dev,
      ino: raw.identity.ino,
      uid: raw.identity.uid,
      size: raw.identity.size,
      mode: raw.identity.mode,
      nlink: raw.identity.nlink,
      mtimeNs: raw.identity.mtimeNs,
      ctimeNs: raw.identity.ctimeNs,
    };
  }
  return {
    schema: raw.schema,
    basename: raw.basename,
    byteLength: raw.byteLength,
    sha256: raw.sha256,
    baseHistoryDigest: raw.baseHistoryDigest,
    ...(template
      ? { historyTemplateDigest: raw.historyTemplateDigest, identity }
      : { preparedHistoryDigest: raw.preparedHistoryDigest }),
  };
}

function compactSnapshotFiles(files) {
  return files.map(file => ({
    path: file.path,
    beforeExists: file.before.exists !== false,
    beforeRevision: file.before.revision,
    afterExists: file.after.exists !== false,
    afterRevision: file.after.revision,
    createdIdentityDigest: file.createdIdentityDigest || null,
  }));
}

function assertTemplateSelectionBinding(rawTemplate, rawParent, historyService) {
  const parent = publicMarkdownPhaseSchema.assertParentSelectionBinding(rawParent);
  const template = parent.kind === 'snapshot_restore_undo'
    ? historyService.validateSnapshotRestoreUndoHistoryTemplate(rawTemplate)
    : historyService.validateSnapshotRestoreHistoryTemplate(rawTemplate);
  const selectedIds = template.provenance.selectedIds;
  if (template.files.length !== parent.selected.length ||
      selectedIds.length !== parent.selected.length) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template/selection cardinality drifted');
  }
  for (let index = 0; index < parent.selected.length; index += 1) {
    const selected = parent.selected[index];
    const file = template.files[index];
    const action = parent.kind === 'snapshot_restore_undo'
      ? (file.before.exists === false ? 'CREATED' : 'EXISTING')
      : (file.before.exists === false ? 'MISSING' : 'EXISTING');
    if (selectedIds[index] !== selected.selectedId || selected.path !== file.path ||
        selected.revision !== file.after.revision || selected.action !== action ||
        (parent.kind === 'snapshot_restore' && file.createdIdentityDigest !== null)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template/selection mapping drifted');
    }
  }
  return Object.freeze({ template, parent });
}

function validateCreateReceipt(raw, marker, request) {
  const values = descriptorValues(raw, [
    'schema', 'status', 'operationId', 'projectId', 'artifactDigest',
    'selectionDigest', 'items',
  ], 'create receipt');
  if (values.schema !== CREATE_RECEIPT_SCHEMA || !['ABSENT', 'CREATED'].includes(values.status) ||
      values.operationId !== marker.operationId || values.projectId !== marker.projectId ||
      values.artifactDigest !== marker.artifact.sha256 ||
      values.selectionDigest !== marker.publicMarkdownPhase.selectionDigest) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'create receipt authority mismatch');
  }
  const expectedLength = values.status === 'ABSENT' ? 0 : request.items.length;
  const rawItems = descriptorArray(values.items, expectedLength, 'create receipt.items');
  if (values.status === 'ABSENT') return Object.freeze({ ...values, items: Object.freeze([]) });
  const items = rawItems.map((rawItem, index) => {
    const item = descriptorValues(rawItem, [
      'selectedId', 'path', 'afterRevision', 'ancestorIdentityDigest', 'contentDigest',
      'createdIdentityDigest', 'creationReceiptDigest',
    ], `create receipt.items[${index}]`);
    const expected = request.items[index];
    if (item.selectedId !== expected.selectedId || item.path !== expected.path ||
        item.afterRevision !== expected.afterRevision ||
        item.ancestorIdentityDigest !== expected.ancestorIdentityDigest ||
        item.contentDigest !== `sha256:${expected.afterRevision}` ||
        !/^sha256:[a-f0-9]{64}$/.test(item.createdIdentityDigest || '') ||
        !/^sha256:[a-f0-9]{64}$/.test(item.creationReceiptDigest || '')) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'create receipt item authority mismatch');
    }
    return Object.freeze({ ...item });
  });
  if (new Set(items.map(item => item.createdIdentityDigest)).size !== items.length ||
      new Set(items.map(item => item.creationReceiptDigest)).size !== items.length) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'create receipt identities must be unique');
  }
  return Object.freeze({ ...values, items: Object.freeze(items) });
}

function validateFinalizeAck(raw, marker, request, createAuthority) {
  const values = descriptorValues(raw, [
    'schema', 'status', 'operationId', 'projectId', 'authorityDigest',
    'receiptName', 'finalReceiptDigest',
  ], 'finalize ACK');
  let expected;
  let expectedName;
  try {
    expected = publicMarkdownNativeSchema.buildFinalAck(request, createAuthority);
    expectedName = publicMarkdownNativeSchema.finalRecordName(request, createAuthority);
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize authority cannot be reproduced');
  }
  const authorityDigest = evidenceDeliverySchema.digestObject(request.schema, request);
  if (values.schema !== FINALIZE_ACK_SCHEMA || !['ABSENT', 'FINALIZED'].includes(values.status) ||
      values.operationId !== marker.operationId || values.projectId !== marker.projectId ||
      values.authorityDigest !== authorityDigest) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize ACK authority mismatch');
  }
  if (values.status === 'ABSENT') {
    if (values.receiptName !== null || values.finalReceiptDigest !== null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'absent finalize ACK carries receipt authority');
    }
  } else if (values.receiptName !== expectedName ||
      values.finalReceiptDigest !== expected.finalAckDigest) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize ACK receipt identity invalid');
  }
  return Object.freeze({ ...values });
}

function validateArtifactCleanupToken(raw) {
  const values = descriptorValues(raw, [
    'schema', 'quarantine', 'control', 'proof', 'receipt', 'receiptDigest',
  ], 'artifact cleanup token');
  if (values.schema !== 'writcraft.changes-history-artifact-cleanup-token/v1' ||
      !/^\.changes-history-cleanup\.[a-f0-9]{32}$/.test(values.quarantine || '') ||
      !/^\.changes-history-cleanup-control\.[a-f0-9]{64}$/.test(values.control || '') ||
      !/^\.changes-history-cleanup-proof\.[a-f0-9]{64}$/.test(values.proof || '') ||
      !/^\.changes-history-cleanup-receipt\.[a-f0-9]{64}$/.test(values.receipt || '') ||
      !/^sha256:[a-f0-9]{64}$/.test(values.receiptDigest || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup token is invalid');
  }
  return Object.freeze({ ...values });
}

function validateArtifactCleanupAuthority(raw, marker, artifact) {
  const values = descriptorValues(raw, [
    'schema', 'operationId', 'projectId', 'artifactBasename', 'artifactByteLength',
    'artifactDigest', 'artifactIdentity', 'token',
  ], 'artifact cleanup authority');
  const token = validateArtifactCleanupToken(values.token);
  const identity = descriptorValues(values.artifactIdentity, [
    'dev', 'ino', 'uid', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs',
  ], 'artifact cleanup identity');
  if (values.schema !== ARTIFACT_CLEANUP_AUTHORITY_SCHEMA ||
      values.operationId !== marker.operationId || values.projectId !== marker.projectId ||
      values.artifactBasename !== artifact.basename ||
      values.artifactByteLength !== artifact.byteLength ||
      values.artifactDigest !== artifact.sha256 ||
      canonical({ ...identity }) !== canonical({ ...artifact.identity })) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup authority does not bind marker');
  }
  return Object.freeze({
    schema: ARTIFACT_CLEANUP_AUTHORITY_SCHEMA,
    operationId: values.operationId,
    projectId: values.projectId,
    artifactBasename: values.artifactBasename,
    artifactByteLength: values.artifactByteLength,
    artifactDigest: values.artifactDigest,
    artifactIdentity: Object.freeze({ ...identity }),
    token,
  });
}

function cloneUndoSettlementEnvelope(raw) {
  try {
    evidenceDeliverySchema.assertExactKeys(
      raw,
      undoSettlementSchema.KEYS,
      'publicMarkdownUndoSettlement'
    );
    if (evidenceDeliverySchema.canonicalJsonByteLength(raw) > undoSettlementSchema.MAX_BYTES) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo settlement marker exceeds budget');
    }
    return Object.freeze({ ...raw });
  } catch (error) {
    if (error instanceof ChangesHistoryRecoveryError) throw error;
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo settlement marker is malformed');
  }
}

function cloneUndoFinalizationEnvelope(raw) {
  try {
    evidenceDeliverySchema.assertExactKeys(
      raw,
      undoFinalizationSchema.KEYS,
      'publicMarkdownUndoFinalization'
    );
    if (evidenceDeliverySchema.canonicalJsonByteLength(raw) > undoFinalizationSchema.MAX_BYTES) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo finalization marker exceeds budget');
    }
    return Object.freeze({ ...raw });
  } catch (error) {
    if (error instanceof ChangesHistoryRecoveryError) throw error;
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo finalization marker is malformed');
  }
}

function markerPayload(marker) {
  const { integrity: _integrity, ...payload } = marker;
  return payload;
}

function validateMarker(raw, projectService, historyService, options = {}) {
  const snapshotKind = ['snapshot_restore', 'snapshot_restore_undo'].includes(raw?.kind);
  const artifactBacked = raw?.artifact !== undefined;
  const phaseBacked = raw?.publicMarkdownPhase !== undefined ||
    raw?.parentSelectionBinding !== undefined;
  const cleanupBacked = raw?.artifactCleanup !== undefined;
  const undoSettlementBacked = raw?.publicMarkdownUndoSettlement !== undefined;
  const undoFinalizationBacked = raw?.publicMarkdownUndoFinalization !== undefined;
  if (snapshotKind && !artifactBacked) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot recovery 缺少 artifact');
  if (phaseBacked && !snapshotKind) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'public Markdown phase kind 无效');
  }
  exactKeys(raw, [
    'schema', 'operationId', 'projectId', 'kind', 'state', 'outcome', 'files',
    'baseHistoryState', 'preparedHistoryState', 'recoveryWritePending',
    'createdAt', 'updatedAt', 'integrity', ...(artifactBacked ? ['artifact'] : []),
    ...(phaseBacked ? ['parentSelectionBinding', 'publicMarkdownPhase'] : []),
    ...(cleanupBacked ? ['artifactCleanup'] : []),
    ...(undoSettlementBacked ? ['publicMarkdownUndoSettlement'] : []),
    ...(undoFinalizationBacked ? ['publicMarkdownUndoFinalization'] : []),
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
    const valid = artifactBacked
      ? validateSnapshotFile(file, index, raw.kind, phaseBacked)
      : validateLegacyFile(file, index);
    if (seen.has(valid.path)) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记包含重复文件');
    seen.add(valid.path);
    return valid;
  });
  const artifact = artifactBacked ? validateArtifactBinding(raw.artifact) : null;
  if (phaseBacked && artifact?.schema !== 'writcraft.changes-history-recovery-artifact/v2') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'PRECREATE 必须绑定 History template artifact');
  }
  if (!phaseBacked && artifact?.schema === 'writcraft.changes-history-recovery-artifact/v2') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template artifact 缺少 phase authority');
  }
  const parentSelectionBinding = phaseBacked
    ? publicMarkdownPhaseSchema.assertParentSelectionBinding(raw.parentSelectionBinding)
    : null;
  const publicMarkdownPhase = phaseBacked
    ? publicMarkdownPhaseSchema.assertPhaseRecord(raw.publicMarkdownPhase, parentSelectionBinding)
    : null;
  const artifactCleanup = cleanupBacked
    ? validateArtifactCleanupAuthority(raw.artifactCleanup, raw, artifact)
    : null;
  const publicMarkdownUndoSettlement = undoSettlementBacked
    ? cloneUndoSettlementEnvelope(raw.publicMarkdownUndoSettlement)
    : null;
  const publicMarkdownUndoFinalization = undoFinalizationBacked
    ? cloneUndoFinalizationEnvelope(raw.publicMarkdownUndoFinalization)
    : null;
  if (phaseBacked) {
    if (parentSelectionBinding.kind !== raw.kind ||
        parentSelectionBinding.selected.length !== files.length ||
        publicMarkdownPhase.operationId !== raw.operationId ||
        publicMarkdownPhase.kind !== raw.kind ||
        publicMarkdownPhase.artifactDigest !== artifact.sha256) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'public Markdown phase/control authority 不一致');
    }
    for (let index = 0; index < files.length; index += 1) {
      const selected = parentSelectionBinding.selected[index];
      const file = files[index];
      const expectedAction = raw.kind === 'snapshot_restore'
        ? (file.beforeExists ? 'EXISTING' : 'MISSING')
        : (file.afterExists ? 'EXISTING' : 'CREATED');
      const selectedRevision = raw.kind === 'snapshot_restore_undo'
        ? file.beforeRevision
        : file.afterRevision;
      if (selected.path !== file.path || selected.revision !== selectedRevision ||
          selected.action !== expectedAction) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'parent selection/file authority 不一致');
      }
    }
  }
  const valid = {
    schema: RECOVERY_SCHEMA,
    operationId: raw.operationId,
    projectId: raw.projectId,
    kind: raw.kind,
    state: raw.state,
    outcome: raw.outcome,
    files,
    baseHistoryState: artifactBacked
      ? validateHistoryBinding(raw.baseHistoryState, 'baseHistoryState')
      : validateHistoryState(raw.baseHistoryState, historyService, 'baseHistoryState'),
    preparedHistoryState: artifactBacked
      ? (phaseBacked && raw.preparedHistoryState === null
        ? null
        : validateHistoryBinding(raw.preparedHistoryState, 'preparedHistoryState'))
      : validateHistoryState(raw.preparedHistoryState, historyService, 'preparedHistoryState'),
    recoveryWritePending: raw.recoveryWritePending,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    ...(artifactBacked ? { artifact } : {}),
    ...(phaseBacked ? { parentSelectionBinding, publicMarkdownPhase } : {}),
    ...(undoSettlementBacked ? { publicMarkdownUndoSettlement } : {}),
    ...(undoFinalizationBacked ? { publicMarkdownUndoFinalization } : {}),
    ...(cleanupBacked ? { artifactCleanup } : {}),
  };
  if (artifactBacked &&
      (valid.artifact.basename !== `changes-history-${valid.operationId}.bin` ||
       valid.artifact.baseHistoryDigest !== valid.baseHistoryState.digest ||
       (!phaseBacked &&
        valid.artifact.preparedHistoryDigest !== valid.preparedHistoryState.digest))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Recovery artifact/control authority 不一致');
  }
  if (phaseBacked &&
      ((raw.kind === 'snapshot_restore' &&
        ((valid.publicMarkdownPhase.phase === 'PRECREATE') !==
          (valid.preparedHistoryState === null))) ||
       (raw.kind === 'snapshot_restore_undo' && valid.preparedHistoryState === null) ||
       (valid.preparedHistoryState !== null &&
        valid.publicMarkdownPhase.preparedHistoryDigest !==
          `sha256:${valid.preparedHistoryState.digest}`))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'public Markdown prepared History binding 不一致');
  }
  if (undoSettlementBacked && (!phaseBacked || raw.kind !== 'snapshot_restore_undo' ||
      !['QUARANTINED', 'RESTORED'].includes(publicMarkdownPhase.phase))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo settlement marker phase is invalid');
  }
  if (phaseBacked && raw.kind === 'snapshot_restore_undo' &&
      publicMarkdownPhase.phase === 'RESTORED' && !undoSettlementBacked) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'RESTORED marker lacks settlement authority');
  }
  if (undoFinalizationBacked && (!phaseBacked || raw.kind !== 'snapshot_restore_undo' ||
      !['HISTORY_COMMITTED', 'FINALIZED'].includes(publicMarkdownPhase.phase) ||
      undoSettlementBacked)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo finalization marker phase is invalid');
  }
  if (phaseBacked && raw.kind === 'snapshot_restore_undo' &&
      publicMarkdownPhase.phase === 'FINALIZED' && !undoFinalizationBacked) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'FINALIZED marker lacks finalization authority');
  }
  const safeCleanupPhase = phaseBacked && raw.state === 'terminal' && (
    (raw.kind === 'snapshot_restore' && raw.outcome === 'applied' &&
      publicMarkdownPhase.phase === 'FINALIZED') ||
    (raw.kind === 'snapshot_restore_undo' && raw.outcome === 'zero_write_error' &&
      publicMarkdownPhase.phase === 'RESTORED' && undoSettlementBacked) ||
    (raw.kind === 'snapshot_restore_undo' && raw.outcome === 'undone' &&
      publicMarkdownPhase.phase === 'FINALIZED' && undoFinalizationBacked)
  );
  if (cleanupBacked && !safeCleanupPhase) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup marker phase is invalid');
  }
  if (options.skipIntegrity !== true && raw.integrity !== sha256(legacyMarkerCanonical(valid))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记完整性校验失败');
  }
  return { ...valid, integrity: raw.integrity };
}

function sealValidatedMarker(payload, projectService, historyService) {
  const provisional = validateMarker({
    ...payload,
    integrity: '0'.repeat(64),
  }, projectService, historyService, { skipIntegrity: true });
  const normalized = markerPayload(provisional);
  return validateMarker({
    ...normalized,
    integrity: sha256(legacyMarkerCanonical(normalized)),
  }, projectService, historyService);
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
  if (Object.hasOwn(right, 'digest')) {
    return left.exists === right.exists && sha256(canonical(left.history)) === right.digest;
  }
  return left.exists === right.exists &&
    (!left.exists || canonical(left.history) === canonical(right.history));
}

function compactHistoryBinding(state, historyService) {
  const history = historyService.validateHistory(state.history);
  if (!state.exists && history.entries.length) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'absent prepared History contains entries');
  }
  const bytes = state.exists
    ? Buffer.from(`${JSON.stringify(history, null, 2)}\n`, 'utf8')
    : Buffer.alloc(0);
  const digest = crypto.createHash('sha256')
    .update(Buffer.from([state.exists ? 1 : 0]))
    .update(bytes)
    .digest('hex');
  return Object.freeze({ exists: state.exists, digest });
}

function publicMarker(marker) {
  const snapshotKind = ['snapshot_restore', 'snapshot_restore_undo'].includes(marker.kind);
  return Object.freeze({
    schema: RECOVERY_SCHEMA,
    operationId: marker.operationId,
    projectId: marker.projectId,
    kind: marker.kind,
    state: marker.state,
    outcome: marker.outcome,
    ...(snapshotKind ? { publicMarkdownPhase: marker.publicMarkdownPhase } : {}),
    affectedPaths: Object.freeze(marker.files.map(file => file.path)),
    createdAt: marker.createdAt,
    updatedAt: marker.updatedAt,
    actions: Object.freeze(
      !snapshotKind && ['committed_warning', 'manual_recovery'].includes(marker.outcome)
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
  const beforeMarkerDurabilityFsync = options.beforeMarkerDurabilityFsync;
  const beforeClear = options.beforeClear;
  const beforeHistoryJournalAppend = options.beforeHistoryJournalAppend;
  const exactArtifactLifecycle = options.exactArtifactLifecycle || null;
  const exactMarkerLifecycle = options.exactMarkerLifecycle || null;
  const publicMarkdownLifecycle = options.publicMarkdownLifecycle || null;
  const existingRestoreLifecycle = options.existingRestoreLifecycle || null;
  const markerJournalLifecycle = options.markerJournalLifecycle || null;
  const snapshotStateReader = typeof options.snapshotStateReader === 'function'
    ? options.snapshotStateReader
    : null;

  function artifactLifecycleFor(rootPath) {
    if (exactArtifactLifecycle && typeof exactArtifactLifecycle.forProject === 'function') {
      return exactArtifactLifecycle.forProject(rootPath);
    }
    return exactArtifactLifecycle;
  }

  function markerJournalFor(rootPath, requireWrite = false) {
    if (markerJournalLifecycle === null) return null;
    const methodObject = (raw, method, label, allowedMethods = [method]) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Object.prototype ||
          Object.getOwnPropertySymbols(raw).length !== 0) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is unavailable`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      const keys = Reflect.ownKeys(raw);
      const allowed = new Set(['schema', ...allowedMethods]);
      if (!Object.hasOwn(descriptors, method) ||
          keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
          keys.some(key => {
            const descriptor = descriptors[key];
            return !descriptor || descriptor.enumerable !== true ||
              !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
              Object.hasOwn(descriptor, 'set');
          }) || typeof descriptors[method].value !== 'function') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is unavailable`);
      }
      return descriptors[method].value;
    };
    const factory = methodObject(markerJournalLifecycle, 'forProject', 'marker journal lifecycle');
    let scoped;
    try { scoped = factory(rootPath); }
    catch (error) {
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'marker journal project binding failed'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const scopedMethods = ['discover', 'discoverCurrent', 'initialize', 'read', 'append'];
    const discoverCurrent = methodObject(
      scoped,
      'discoverCurrent',
      'marker journal reader',
      scopedMethods
    );
    if (!requireWrite) return Object.freeze({ discoverCurrent });
    const discover = methodObject(scoped, 'discover', 'marker journal discoverer', scopedMethods);
    const initialize = methodObject(scoped, 'initialize', 'marker journal initializer', scopedMethods);
    const append = methodObject(scoped, 'append', 'marker journal appender', scopedMethods);
    return Object.freeze({ discover, discoverCurrent, initialize, append });
  }

  function journalReadResult(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.getPrototypeOf(raw) !== Object.prototype ||
        Object.getOwnPropertySymbols(raw).length !== 0) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal result is malformed');
    }
    const statusDescriptor = Object.getOwnPropertyDescriptor(raw, 'status');
    if (!statusDescriptor || statusDescriptor.enumerable !== true ||
        !Object.hasOwn(statusDescriptor, 'value') || statusDescriptor.get || statusDescriptor.set) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal result is malformed');
    }
    const status = statusDescriptor.value;
    if (status === 'VALUE') {
      const values = descriptorValues(raw, [
        'schema', 'command', 'requestDigest', 'status', 'head', 'value',
      ], 'marker journal VALUE result');
      if (values.schema !== 'writcraft.changes-history-marker-journal-native-result/v1' ||
          values.command !== 'READ' || !/^sha256:[a-f0-9]{64}$/.test(values.requestDigest)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal VALUE identity is malformed');
      }
      const value = markerJournalSchema.assertJournalValue(values.value);
      const head = markerJournalSchema.assertExpectedHead(values.head);
      const expected = markerJournalSchema.expectedHead(value);
      if (head.journalId !== expected.journalId || head.generation !== expected.generation ||
          head.valueDigest !== expected.valueDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal VALUE head is malformed');
      }
      return Object.freeze({ status, value });
    }
    const values = descriptorValues(raw, [
      'schema', 'command', 'status',
      'olderSlot', 'olderHead', 'olderPreviousValueDigest', 'olderValue',
      'newerSlot', 'newerHead', 'newerPreviousValueDigest', 'requestDigest',
    ], 'marker journal DISCOVER result');
    if (values.schema !== 'writcraft.changes-history-marker-journal-native-result/v1' ||
        values.command !== 'DISCOVER' || !/^sha256:[a-f0-9]{64}$/.test(values.requestDigest) ||
        !['ABSENT', 'LEGACY', 'BASE', 'UNKNOWN'].includes(status)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal DISCOVER identity is malformed');
    }
    if (['ABSENT', 'LEGACY', 'UNKNOWN'].includes(status)) {
      if (values.olderSlot !== null || values.olderHead !== null ||
          values.olderPreviousValueDigest !== null || values.olderValue !== null ||
          values.newerSlot !== null || values.newerHead !== null ||
          values.newerPreviousValueDigest !== null) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal empty result retains authority');
      }
      return Object.freeze({ status, value: null });
    }
    const value = markerJournalSchema.assertJournalValue(values.olderValue);
    const head = markerJournalSchema.assertExpectedHead(values.olderHead);
    const expected = markerJournalSchema.expectedHead(value);
    if (values.olderSlot !== 'A' || head.generation !== '0' ||
        values.olderPreviousValueDigest !== null || value.previousValueDigest !== null ||
        value.state !== 'IDLE' ||
        head.journalId !== expected.journalId || head.generation !== expected.generation ||
        head.valueDigest !== expected.valueDigest || values.newerSlot !== null ||
        values.newerHead !== null || values.newerPreviousValueDigest !== null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal BASE authority is malformed');
    }
    return Object.freeze({ status, value });
  }

  function journalInitialValue(projectId) {
    const value = {
      schema: markerJournalSchema.SCHEMAS.VALUE,
      journalId: `chrj_${crypto.randomBytes(24).toString('hex')}`,
      generation: '0',
      previousValueDigest: null,
      state: 'IDLE',
      projectId,
      activeOperationId: null,
      activeKind: null,
      activeMarker: null,
      activeMarkerDigest: null,
      nativePublication: null,
      existingTerminalPublication: null,
      terminalCleanup: null,
      terminalCleanupDigest: null,
      valueDigest: null,
    };
    value.valueDigest = markerJournalSchema.valueDigest(value);
    return markerJournalSchema.assertJournalValue(value);
  }

  function journalNextValue(previous, fields) {
    const value = {
      ...previous,
      generation: markerJournalSchema.nextGeneration(previous.generation),
      previousValueDigest: previous.valueDigest,
      ...fields,
      valueDigest: null,
    };
    value.valueDigest = markerJournalSchema.valueDigest(value);
    return markerJournalSchema.assertTransition(previous, value);
  }

  function journalMutationResult(raw, originalRequest, expected) {
    const original = markerJournalNativeSchema.assertRequestAuthority(originalRequest);
    const values = descriptorValues(raw, [
      'schema', 'command', 'requestDigest', 'status', 'head', 'value',
    ], 'marker journal mutation result');
    let expectedRequestDigest = original.requestDigest;
    if (values.command === 'READ' && original.command === 'APPEND') {
      const readRequest = {
        schema: markerJournalNativeSchema.SCHEMAS.READ,
        command: 'READ',
        expectedHeads: [...original.expectedHeads],
      };
      expectedRequestDigest = markerJournalNativeSchema.assertRequestAuthority(
        readRequest,
        'READ'
      ).requestDigest;
    } else if (values.command !== original.command) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal mutation command is misrouted');
    }
    if (values.schema !== markerJournalNativeSchema.SCHEMAS.RESULT ||
        values.requestDigest !== expectedRequestDigest || values.status !== 'VALUE') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal mutation result is malformed');
    }
    const value = markerJournalSchema.assertJournalValue(values.value);
    const head = markerJournalSchema.assertExpectedHead(values.head);
    const expectedHead = markerJournalSchema.expectedHead(expected);
    if (head.journalId !== expectedHead.journalId || head.generation !== expectedHead.generation ||
        head.valueDigest !== expectedHead.valueDigest ||
        canonical(value) !== canonical(expected)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal mutation did not reach exact value');
    }
    return value;
  }

  function journalCurrent(scoped) {
    let result;
    try { result = journalReadResult(scoped.discoverCurrent()); }
    catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'marker journal current authority is unavailable'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return result;
  }

  function initializeJournal(scoped, projectId) {
    const initial = journalInitialValue(projectId);
    const request = {
      schema: markerJournalNativeSchema.SCHEMAS.INIT,
      command: 'INIT',
      initialValue: initial,
    };
    let direct = null;
    try { direct = scoped.initialize(request); } catch (_) {}
    if (direct !== null) return journalMutationResult(direct, request, initial);
    const reconciled = journalCurrent(scoped);
    if (!['BASE', 'VALUE'].includes(reconciled.status) || reconciled.value?.state !== 'IDLE' ||
        canonical(reconciled.value) !== canonical(initial)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal INIT requires exact reconciliation');
    }
    return initial;
  }

  function appendJournal(scoped, previous, next, beforeAppend = null) {
    const request = {
      schema: markerJournalNativeSchema.SCHEMAS.APPEND,
      command: 'APPEND',
      previousValue: previous,
      nextValue: next,
    };
    markerJournalNativeSchema.assertRequestAuthority(request, 'APPEND');
    if (typeof beforeAppend === 'function') beforeAppend();
    let direct = null;
    try { direct = scoped.append(request); } catch (_) {}
    if (direct !== null) return journalMutationResult(direct, request, next);
    const reconciled = journalCurrent(scoped);
    if (reconciled.status !== 'VALUE' || canonical(reconciled.value) !== canonical(next)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal APPEND requires exact reconciliation');
    }
    return next;
  }

  function appendSnapshotPreparedJournal(scoped, previous, next, beforeAppend = null) {
    const request = {
      schema: markerJournalNativeSchema.SCHEMAS.APPEND,
      command: 'APPEND',
      previousValue: previous,
      nextValue: next,
    };
    markerJournalNativeSchema.assertRequestAuthority(request, 'APPEND');
    if (typeof beforeAppend === 'function') beforeAppend();
    let direct = null;
    try { direct = scoped.append(request); } catch (_) {}
    if (direct !== null) {
      journalMutationResult(direct, request, next);
      return 'COMMITTED';
    }
    const reconciled = journalCurrent(scoped);
    if (reconciled.status === 'VALUE' &&
        canonical(reconciled.value) === canonical(next)) return 'COMMITTED';
    if (['BASE', 'VALUE'].includes(reconciled.status) &&
        canonical(reconciled.value) === canonical(previous)) return 'UNCOMMITTED';
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot journal APPEND requires exact reconciliation');
  }

  function discoverJournalPair(scoped) {
    const request = { schema: markerJournalNativeSchema.SCHEMAS.DISCOVER, command: 'DISCOVER' };
    const authority = markerJournalNativeSchema.assertRequestAuthority(request, 'DISCOVER');
    let raw;
    try { raw = scoped.discover(); }
    catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal DISCOVER is unavailable'); }
    const value = descriptorValues(raw, [
      'schema', 'command', 'status',
      'olderSlot', 'olderHead', 'olderPreviousValueDigest', 'olderValue',
      'newerSlot', 'newerHead', 'newerPreviousValueDigest', 'requestDigest',
    ], 'marker journal DISCOVER result');
    if (value.schema !== markerJournalNativeSchema.SCHEMAS.RESULT ||
        value.command !== 'DISCOVER' || value.status !== 'PAIR' ||
        value.requestDigest !== authority.requestDigest ||
        !markerJournalSchema.SLOTS.includes(value.olderSlot) ||
        !markerJournalSchema.SLOTS.includes(value.newerSlot) ||
        value.olderSlot === value.newerSlot) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal lacks terminal PAIR authority');
    }
    const older = markerJournalSchema.assertJournalValue(value.olderValue);
    const olderHead = markerJournalSchema.assertExpectedHead(value.olderHead);
    const newerHead = markerJournalSchema.assertExpectedHead(value.newerHead);
    const expectedOlder = markerJournalSchema.expectedHead(older);
    if (canonical(olderHead) !== canonical(expectedOlder) ||
        value.olderPreviousValueDigest !== older.previousValueDigest ||
        newerHead.journalId !== olderHead.journalId ||
        BigInt(newerHead.generation) !== BigInt(olderHead.generation) + 1n ||
        value.newerPreviousValueDigest !== older.valueDigest ||
        value.olderSlot !== (BigInt(older.generation) % 2n === 0n ? 'A' : 'B') ||
        value.newerSlot !== (BigInt(newerHead.generation) % 2n === 0n ? 'A' : 'B')) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal terminal PAIR is disconnected');
    }
    const current = journalCurrent(scoped);
    if (current.status !== 'VALUE') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal terminal current value is unavailable');
    }
    const expectedNewer = markerJournalSchema.expectedHead(current.value);
    if (canonical(newerHead) !== canonical(expectedNewer)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal terminal PAIR changed before READ');
    }
    markerJournalSchema.assertTransition(older, current.value);
    return Object.freeze({ older, current: current.value });
  }

  function markerLifecycleFor(rootPath) {
    const validate = (raw, allowFactory) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Object.prototype) {
        fail('MARKER_CLEAR_UNAVAILABLE', 'native exact marker clear is unavailable');
      }
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      const keys = Reflect.ownKeys(raw);
      const method = allowFactory && Object.hasOwn(descriptors, 'forProject')
        ? 'forProject'
        : 'clear';
      const allowed = new Set([method, 'schema']);
      if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
          !Object.hasOwn(descriptors, method) ||
          keys.some(key => {
            const descriptor = descriptors[key];
            return !descriptor || descriptor.enumerable !== true ||
              !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
              Object.hasOwn(descriptor, 'set');
          }) || typeof descriptors[method].value !== 'function') {
        fail('MARKER_CLEAR_UNAVAILABLE', 'native exact marker clear is unavailable');
      }
      return Object.freeze({
        ...(descriptors.schema ? { schema: descriptors.schema.value } : {}),
        [method]: descriptors[method].value,
      });
    };
    const outer = validate(exactMarkerLifecycle, true);
    if (outer.forProject) return validate(outer.forProject(rootPath), false);
    return outer;
  }

  function verifiedArtifactCleanupToken(lifecycle, marker, rawToken) {
    const token = validateArtifactCleanupToken(rawToken);
    if (!lifecycle || typeof lifecycle.verify !== 'function') {
      fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'exact artifact cleanup token verifier is unavailable');
    }
    let verified;
    try { verified = validateArtifactCleanupToken(lifecycle.verify(marker.artifact, token)); }
    catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'artifact cleanup token verification failed'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (canonical(verified) !== canonical(token)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact cleanup token changed during verify');
    }
    return token;
  }

  function publicMarkdownLifecycleFor(
    rootPath,
    kind,
    requireJournalCreate = false,
    requireCreateCleanup = false
  ) {
    const method = (raw, name) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Object.prototype) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
          Object.hasOwn(descriptor, 'set') || typeof descriptor.value !== 'function') return null;
      return descriptor.value;
    };
    const factory = method(publicMarkdownLifecycle, 'forProject');
    const scoped = factory ? factory(rootPath) : publicMarkdownLifecycle;
    const methods = kind === 'snapshot_restore'
      ? [
        'create', ...(requireJournalCreate ? ['createMissingJournal'] : []),
        'reconcile', 'verifyCreate', 'finalizeCreate', 'reconcileFinalize',
        ...(requireCreateCleanup
          ? ['cleanupCreate', 'reconcileCreateCleanup', 'ackCreateCleanup']
          : []),
      ]
      : ['quarantine', 'restoreQuarantine', 'finalizeUndo', 'ackUndo', 'reconcileUndo'];
    const bound = Object.create(null);
    for (const name of methods) bound[name] = method(scoped, name);
    if (methods.some(name => bound[name] === null)) {
      fail('PUBLIC_MARKDOWN_HELPER_UNAVAILABLE', 'native public Markdown lifecycle is unavailable');
    }
    return Object.freeze(bound);
  }

  function sameMarkerIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
      left.nlink === right.nlink && left.mode === right.mode &&
      left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  }

  function sameDirectoryIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
  }

  function readHeldMarker(fd, stat) {
    const bytes = fileSystem.readFileSync(fd);
    const after = fileSystem.fstatSync(fd, { bigint: true });
    if (bytes.length !== Number(stat.size) || !sameMarkerIdentity(stat, after)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery marker changed during held read');
    }
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); }
    catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记损坏'); }
    return {
      marker: validateMarker(raw, projectService, historyService),
      digest: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }

  function captureMarkerAuthority(rootPath) {
    const location = markerLocation(rootPath, false, fileSystem);
    if (!location.exists) fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    let fd;
    try {
      fd = fileSystem.openSync(location.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fileSystem.fstatSync(fd, { bigint: true });
      if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink !== 1n ||
          stat.size > BigInt(MAX_MARKER_BYTES)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery marker identity invalid');
      }
      const held = readHeldMarker(fd, stat);
      return { ...held, fd, stat, location };
    } catch (error) {
      if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
      throw error;
    }
  }

  function assertMarkerAuthority(authority) {
    const heldAfter = fileSystem.fstatSync(authority.fd, { bigint: true });
    if (!sameMarkerIdentity(authority.stat, heldAfter)) {
      fail('CHANGES_RECOVERY_STALE', 'held recovery marker authority changed');
    }
    let fd;
    try {
      fd = fileSystem.openSync(
        authority.location.file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const stat = fileSystem.fstatSync(fd, { bigint: true });
      if (!sameMarkerIdentity(authority.stat, stat)) {
        fail('CHANGES_RECOVERY_STALE', 'recovery marker inode was replaced');
      }
      const current = readHeldMarker(fd, stat);
      if (current.digest !== authority.digest ||
          current.marker.operationId !== authority.marker.operationId ||
          current.marker.integrity !== authority.marker.integrity) {
        fail('CHANGES_RECOVERY_STALE', 'recovery marker bytes changed');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') fail('CHANGES_RECOVERY_STALE', 'recovery marker disappeared');
      throw error;
    } finally {
      if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    }
  }

  function historyAuthorityPath(rootPath) {
    return path.join(rootPath, historyService.HISTORY_RELATIVE_PATH);
  }

  function captureHistoryAuthority(rootPath, expected) {
    const file = historyAuthorityPath(rootPath);
    const directory = path.dirname(file);
    const directoryFd = fileSystem.openSync(directory, fs.constants.O_RDONLY);
    const directoryStat = fileSystem.fstatSync(directoryFd, { bigint: true });
    let fd = null;
    let stat = null;
    try {
      if (expected.exists) {
        fd = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        stat = fileSystem.fstatSync(fd, { bigint: true });
        if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink !== 1n ||
            stat.size > BigInt(historyService.MAX_HISTORY_BYTES)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'base History identity invalid');
        }
        const digest = crypto.createHash('sha256')
          .update(Buffer.from([1]))
          .update(fileSystem.readFileSync(fd))
          .digest('hex');
        const after = fileSystem.fstatSync(fd, { bigint: true });
        if (!sameMarkerIdentity(stat, after) || digest !== expected.digest) {
          fail('CHANGES_RECOVERY_STALE', 'base History raw authority changed');
        }
      } else {
        try {
          fd = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          fail('CHANGES_RECOVERY_STALE', 'base History unexpectedly exists');
        } catch (error) {
          if (error instanceof ChangesHistoryRecoveryError) throw error;
          if (error?.code !== 'ENOENT') throw error;
        }
        if (expected.digest !== sha256(Buffer.from([0]))) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'absent base History digest invalid');
        }
      }
      return { file, directory, directoryFd, directoryStat, fd, stat, expected };
    } catch (error) {
      if (fd !== null) try { fileSystem.closeSync(fd); } catch (_) {}
      try { fileSystem.closeSync(directoryFd); } catch (_) {}
      throw error;
    }
  }

  function assertHistoryAuthority(authority) {
    const directoryAfter = fileSystem.fstatSync(authority.directoryFd, { bigint: true });
    if (!sameDirectoryIdentity(authority.directoryStat, directoryAfter)) {
      fail('CHANGES_RECOVERY_STALE', 'History directory authority changed');
    }
    let currentDirectoryFd;
    try {
      currentDirectoryFd = fileSystem.openSync(authority.directory, fs.constants.O_RDONLY);
      const currentDirectoryStat = fileSystem.fstatSync(currentDirectoryFd, { bigint: true });
      if (!sameDirectoryIdentity(authority.directoryStat, currentDirectoryStat)) {
        fail('CHANGES_RECOVERY_STALE', 'History directory path was replaced');
      }
    } finally {
      if (currentDirectoryFd !== undefined) {
        try { fileSystem.closeSync(currentDirectoryFd); } catch (_) {}
      }
    }
    if (authority.expected.exists) {
      const heldAfter = fileSystem.fstatSync(authority.fd, { bigint: true });
      if (!sameMarkerIdentity(authority.stat, heldAfter)) {
        fail('CHANGES_RECOVERY_STALE', 'held base History changed');
      }
    }
    const current = currentHistoryBinding(path.dirname(authority.directory));
    if (current.exists !== authority.expected.exists || current.digest !== authority.expected.digest) {
      fail('CHANGES_RECOVERY_STALE', 'base History path authority changed');
    }
  }

  function closeHistoryAuthority(authority) {
    if (!authority) return;
    if (authority.fd !== null) try { fileSystem.closeSync(authority.fd); } catch (_) {}
    try { fileSystem.closeSync(authority.directoryFd); } catch (_) {}
  }

  function ensurePreparedHistoryDurable(rootPath, preparedBinding, priorAuthority = null) {
    const preparedAuthority = captureHistoryAuthority(rootPath, preparedBinding);
    try {
      if (priorAuthority && !sameDirectoryIdentity(
        priorAuthority.directoryStat,
        preparedAuthority.directoryStat
      )) {
        fail('CHANGES_RECOVERY_STALE', 'History parent directory was replaced after rename');
      }
      // Visible prepared bytes are not durable proof. Always fsync the exact
      // held History parent once more before allowing the marker to advance;
      // this is the retry boundary for rename-committed/first-fsync-failed.
      fileSystem.fsyncSync(preparedAuthority.directoryFd);
      assertHistoryAuthority(preparedAuthority);
      return Object.freeze({
        current: currentHistoryBinding(rootPath),
        authority: preparedAuthority,
      });
    } catch (error) {
      closeHistoryAuthority(preparedAuthority);
      throw error;
    }
  }

  function verifyPublicMarkdownPhaseArtifact(rootPath, marker) {
    const location = markerLocation(rootPath, false, fileSystem);
    const artifactFiles = [];
    let artifact;
    try {
      artifact = recoveryArtifact.inspectSnapshotArtifact(
        location.directory,
        marker.artifact,
        file => artifactFiles.push(file),
        { includeHistory: true, historyService }
      );
    } catch (error) {
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'public Markdown recovery artifact cannot be verified'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (artifactFiles.length !== marker.files.length ||
        artifact.baseHistory.digest !== marker.artifact.baseHistoryDigest ||
        artifact.preparedDelta.exists !== true) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'public Markdown artifact/control binding drifted');
    }
    for (let index = 0; index < marker.files.length; index += 1) {
      const control = marker.files[index];
      const file = artifactFiles[index];
      if (file.path !== control.path || file.before.exists !== control.beforeExists ||
          file.before.revision !== control.beforeRevision ||
          file.after.exists !== control.afterExists ||
          file.after.revision !== control.afterRevision ||
          file.createdIdentityDigest !== control.createdIdentityDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'public Markdown artifact file binding drifted');
      }
    }
    const expectedTemplateSchema = marker.kind === 'snapshot_restore_undo'
      ? historyService.SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA
      : historyService.SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA;
    if (artifact.preparedDelta.templateSchema !== expectedTemplateSchema ||
        !artifact.historyTemplate) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template artifact kind drifted');
    }
    const binding = assertTemplateSelectionBinding(
      artifact.historyTemplate,
      marker.parentSelectionBinding,
      historyService
    );
    const canonicalBytes = Buffer.from(evidenceDeliverySchema.canonicalJson(binding.template), 'utf8');
    const digest = evidenceDeliverySchema.digestObject(
      expectedTemplateSchema,
      binding.template
    );
    if (!canonicalBytes.equals(artifact.preparedDelta.bytes) ||
        digest.slice(7) !== marker.artifact.historyTemplateDigest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History template artifact digest drifted');
    }
    if (marker.kind === 'snapshot_restore_undo' &&
        binding.template.baseHistoryState.digest !== marker.baseHistoryState.digest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo template raw base binding drifted');
    }
    return Object.freeze({
      ...binding,
      artifactFiles: Object.freeze(artifactFiles),
      artifactHistory: artifact,
    });
  }

  function withPublicMarkdownArtifactFd(directory, marker, callback) {
    try {
      return recoveryArtifact.withVerifiedArtifactFd(directory, marker.artifact, callback);
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      if (!(error instanceof recoveryArtifact.ChangesHistoryArtifactError)) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'public Markdown held artifact authority is unavailable'
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  function createRequest(marker, verified) {
    const filesByPath = new Map(verified.artifactFiles.map(file => [file.path, file]));
    return Object.freeze({
      schema: CREATE_REQUEST_SCHEMA,
      operationId: marker.operationId,
      projectId: marker.projectId,
      artifactDigest: marker.artifact.sha256,
      selectionDigest: marker.publicMarkdownPhase.selectionDigest,
      items: Object.freeze(marker.publicMarkdownPhase.items.map(item => {
        const file = filesByPath.get(item.path);
        if (!file || !file.after.exists || file.after.revision !== item.afterRevision) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'create request artifact bytes mismatch');
        }
        return Object.freeze({
          selectedId: item.selectedId,
          path: item.path,
          afterRevision: item.afterRevision,
          ancestorIdentityDigest: item.ancestorIdentityDigest,
          bytes: Buffer.from(file.after.bytes),
        });
      })),
    });
  }

  function precreatePhaseDigest(marker) {
    const precreate = publicMarkdownPhaseSchema.assertPhaseRecord({
      ...marker.publicMarkdownPhase,
      phase: 'PRECREATE',
      items: marker.publicMarkdownPhase.items.map(item => ({
        ...item,
        createdIdentityDigest: marker.kind === 'snapshot_restore'
          ? null
          : item.createdIdentityDigest,
        creationReceiptDigest: null,
        quarantineReceiptDigest: null,
      })),
      preparedHistoryDigest: marker.kind === 'snapshot_restore'
        ? null
        : marker.publicMarkdownPhase.preparedHistoryDigest,
      finalReceiptDigest: null,
      updatedAt: marker.createdAt,
    }, marker.parentSelectionBinding);
    return evidenceDeliverySchema.digestObject(publicMarkdownPhaseSchema.SCHEMA, precreate);
  }

  function artifactIdentityDigest(marker) {
    const identity = marker.artifact.identity;
    try {
      return evidenceDeliverySchema.digestObjectIdentity({
        schema: evidenceDeliverySchema.SCHEMAS.OBJECT_IDENTITY,
        dev: identity.dev,
        ino: identity.ino,
        uid: Number(identity.uid),
        mode: Number(BigInt(identity.mode) & 0o7777n),
        nlink: Number(identity.nlink),
        size: identity.size,
        mtimeNs: identity.mtimeNs,
        ctimeNs: identity.ctimeNs,
        contentSha256: marker.artifact.sha256,
      });
    } catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'artifact native identity cannot be reproduced');
    }
  }

  function nativeCreateAuthority(marker, verified) {
    const filesByPath = new Map(verified.artifactFiles.map(file => [file.path, file]));
    try {
      return publicMarkdownNativeSchema.assertCreateRequest({
        schema: publicMarkdownNativeSchema.SCHEMAS.CREATE_REQUEST,
        operationId: marker.operationId,
        artifactDigest: marker.artifact.sha256,
        artifactIdentityDigest: artifactIdentityDigest(marker),
        artifactByteLength: marker.artifact.byteLength,
        precreatePhaseDigest: precreatePhaseDigest(marker),
        selectionDigest: marker.publicMarkdownPhase.selectionDigest,
        items: marker.publicMarkdownPhase.items.map(item => {
          const file = filesByPath.get(item.path);
          if (!file || !file.after.exists || file.after.revision !== item.afterRevision ||
              !Number.isSafeInteger(file.after.offset)) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native create artifact range is unavailable');
          }
          return {
            selectedId: item.selectedId,
            path: item.path,
            artifactOffset: file.after.offset,
            byteLength: file.after.bytes.length,
            contentDigest: `sha256:${item.afterRevision}`,
            ancestorIdentityDigest: item.ancestorIdentityDigest,
          };
        }),
      });
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native create authority cannot be reproduced');
    }
  }

  function assertSnapshotPrepareAuthority(rootPath, rawMarker) {
    projectIdentity(projectService, rootPath, rawMarker.projectId);
    const marker = validateMarker(rawMarker, projectService, historyService);
    if (canonical(marker) !== canonical(rawMarker)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot marker authority drifted');
    }
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    const current = currentHistoryBinding(rootPath);
    if (current.exists !== marker.baseHistoryState.exists ||
        current.digest !== marker.baseHistoryState.digest ||
        marker.artifact.baseHistoryDigest !== marker.baseHistoryState.digest ||
        verified.artifactHistory.baseHistory.digest !== marker.baseHistoryState.digest ||
        verified.artifactHistory.baseHistory.exists !== marker.baseHistoryState.exists) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot base History authority drifted');
    }
    return verified;
  }

  function rootIdentityFromStat(stat) {
    return Object.freeze({
      schema: evidenceDeliverySchema.SCHEMAS.ROOT_IDENTITY,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
    });
  }

  function currentUndoRootBind(rootPath) {
    let rootFd;
    let recoveryFd;
    try {
      const location = markerLocation(rootPath, false, fileSystem);
      if (!location.exists) fail('CHANGES_RECOVERY_STALE', 'Safe Undo marker is absent');
      rootFd = fileSystem.openSync(
        location.root,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) |
          (fs.constants.O_NOFOLLOW || 0)
      );
      recoveryFd = fileSystem.openSync(
        location.directory,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) |
          (fs.constants.O_NOFOLLOW || 0)
      );
      const rootStat = fileSystem.fstatSync(rootFd, { bigint: true });
      const recoveryStat = fileSystem.fstatSync(recoveryFd, { bigint: true });
      if ((rootStat.mode & 0o170000n) !== 0o040000n ||
          (recoveryStat.mode & 0o170000n) !== 0o040000n ||
          Number(recoveryStat.uid) !== process.geteuid() ||
          Number(recoveryStat.mode & 0o777n) !== 0o700) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo root authority is unsafe');
      }
      return publicMarkdownNativeSchema.assertRootBind({
        schema: publicMarkdownNativeSchema.SCHEMAS.ROOT_BIND,
        canonicalRoot: location.root,
        expectedRootIdentityDigest: evidenceDeliverySchema.digestRootIdentity(
          rootIdentityFromStat(rootStat)
        ),
        expectedRecoveryIdentityDigest: evidenceDeliverySchema.digestRootIdentity(
          rootIdentityFromStat(recoveryStat)
        ),
      });
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo root authority cannot be reproduced');
    } finally {
      if (recoveryFd !== undefined) try { fileSystem.closeSync(recoveryFd); } catch (_) {}
      if (rootFd !== undefined) try { fileSystem.closeSync(rootFd); } catch (_) {}
    }
  }

  function nativeUndoAuthority(rootPath, marker, verified) {
    try {
      const rootBind = currentUndoRootBind(rootPath);
      const filesByPath = new Map(verified.artifactFiles.map(file => [file.path, file]));
      const precreatePhase = publicMarkdownPhaseSchema.assertPhaseRecord({
        ...marker.publicMarkdownPhase,
        phase: 'PRECREATE',
        items: marker.publicMarkdownPhase.items.map(item => ({
          ...item,
          quarantineReceiptDigest: null,
        })),
        finalReceiptDigest: null,
        updatedAt: marker.createdAt,
      }, marker.parentSelectionBinding);
      const request = publicMarkdownNativeSchema.assertUndoRequest({
        schema: publicMarkdownNativeSchema.SCHEMAS.UNDO_REQUEST,
        operationId: marker.operationId,
        artifactDigest: marker.artifact.sha256,
        artifactIdentityDigest: artifactIdentityDigest(marker),
        artifactByteLength: marker.artifact.byteLength,
        rootIdentityDigest: rootBind.expectedRootIdentityDigest,
        recoveryIdentityDigest: rootBind.expectedRecoveryIdentityDigest,
        precreatePhaseDigest: evidenceDeliverySchema.digestObject(
          publicMarkdownPhaseSchema.SCHEMA,
          precreatePhase
        ),
        selectionDigest: marker.publicMarkdownPhase.selectionDigest,
        preparedHistoryDigest: marker.publicMarkdownPhase.preparedHistoryDigest,
        items: marker.publicMarkdownPhase.items.map(item => {
          const file = filesByPath.get(item.path);
          if (!file || !file.before.exists ||
              file.before.revision !== item.afterRevision ||
              file.before.bytes.length < 1) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo artifact item is foreign');
          }
          return {
            selectedId: item.selectedId,
            path: item.path,
            byteLength: file.before.bytes.length,
            contentDigest: `sha256:${item.afterRevision}`,
            ancestorIdentityDigest: item.ancestorIdentityDigest,
            createdIdentityDigest: item.createdIdentityDigest,
          };
        }),
      }, rootBind, marker.parentSelectionBinding, precreatePhase);
      return publicMarkdownNativeSchema.buildUndoAuthority(
        rootBind,
        marker.parentSelectionBinding,
        precreatePhase,
        request
      );
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo native authority cannot be reproduced');
    }
  }

  function validateUndoResult(raw, authority, expectedCommand) {
    try {
      return publicMarkdownNativeSchema.assertUndoResult(raw, authority, expectedCommand);
    } catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo native result is malformed');
    }
  }

  function validateUndoSettleResult(
    raw,
    settle,
    authority,
    expectedCommand = 'RESTORE_QUARANTINE'
  ) {
    try {
      return publicMarkdownNativeSchema.assertUndoSettleResult(
        raw,
        settle,
        authority,
        expectedCommand
      );
    } catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `Safe Undo ${expectedCommand} result is malformed`);
    }
  }

  function validateUndoAckResult(
    raw,
    ack,
    terminalAuthority,
    authority,
    expectedCommand = 'RESTORE_QUARANTINE'
  ) {
    try {
      return publicMarkdownNativeSchema.assertUndoAckResult(
        raw,
        ack,
        terminalAuthority.settleRequest,
        terminalAuthority.finalRecord,
        terminalAuthority.finalRecordIdentity,
        authority,
        expectedCommand
      );
    } catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `Safe Undo ${expectedCommand} A result is malformed`);
    }
  }

  function persistCreatedReceipt(
    rootPath,
    marker,
    verified,
    rawReceipt,
    markerAuthority,
    beforeExpectedRename
  ) {
    const request = createRequest(marker, verified);
    const receipt = validateCreateReceipt(rawReceipt, marker, request);
    if (receipt.status !== 'CREATED') return marker;
    const prepared = historyService.materializeSnapshotRestoreHistoryTemplate(
      marker.baseHistoryState.exists
        ? {
          exists: true,
          history: (() => {
            let raw;
            try { raw = JSON.parse(verified.artifactHistory.baseHistory.bytes.toString('utf8')); }
            catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'base History artifact invalid'); }
            return historyService.validateHistory(raw);
          })(),
        }
        : { exists: false, history: historyService.validateHistory({ schema: historyService.HISTORY_SCHEMA, entries: [] }) },
      verified.template,
      receipt.items.map(item => ({
        path: item.path,
        createdIdentityDigest: item.createdIdentityDigest,
      }))
    );
    const preparedBytes = Buffer.from(`${JSON.stringify(prepared.preparedHistoryState.history, null, 2)}\n`, 'utf8');
    const preparedDigest = crypto.createHash('sha256')
      .update(Buffer.from([1]))
      .update(preparedBytes)
      .digest('hex');
    const nextPhase = publicMarkdownPhaseSchema.assertTransition(
      marker.publicMarkdownPhase,
      {
        ...marker.publicMarkdownPhase,
        phase: 'CREATED_RECEIPT',
        items: marker.publicMarkdownPhase.items.map((item, index) => ({
          ...item,
          createdIdentityDigest: receipt.items[index].createdIdentityDigest,
          creationReceiptDigest: receipt.items[index].creationReceiptDigest,
        })),
        preparedHistoryDigest: `sha256:${preparedDigest}`,
        updatedAt: now(),
      },
      marker.parentSelectionBinding
    );
    return persist(rootPath, {
      ...markerPayload(marker),
      preparedHistoryState: { exists: true, digest: preparedDigest },
      publicMarkdownPhase: nextPhase,
      updatedAt: nextPhase.updatedAt,
    }, marker, markerAuthority, beforeExpectedRename);
  }

  function materializeJournalCreatedReceipt(marker, verified, rawReceipt) {
    const request = createRequest(marker, verified);
    const receipt = validateCreateReceipt(rawReceipt, marker, request);
    if (receipt.status !== 'CREATED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'stored CREATE capture is incomplete');
    }
    const prepared = historyService.materializeSnapshotRestoreHistoryTemplate(
      marker.baseHistoryState.exists
        ? {
          exists: true,
          history: (() => {
            try {
              return historyService.validateHistory(JSON.parse(
                verified.artifactHistory.baseHistory.bytes.toString('utf8')
              ));
            } catch (_) {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'base History artifact invalid');
            }
          })(),
        }
        : {
          exists: false,
          history: historyService.validateHistory({ schema: historyService.HISTORY_SCHEMA, entries: [] }),
        },
      verified.template,
      receipt.items.map(item => ({
        path: item.path,
        createdIdentityDigest: item.createdIdentityDigest,
      }))
    );
    const bytes = Buffer.from(`${JSON.stringify(prepared.preparedHistoryState.history, null, 2)}\n`);
    const preparedDigest = crypto.createHash('sha256')
      .update(Buffer.from([1]))
      .update(bytes)
      .digest('hex');
    const nextPhase = publicMarkdownPhaseSchema.assertTransition(
      marker.publicMarkdownPhase,
      {
        ...marker.publicMarkdownPhase,
        phase: 'CREATED_RECEIPT',
        items: marker.publicMarkdownPhase.items.map((item, index) => ({
          ...item,
          createdIdentityDigest: receipt.items[index].createdIdentityDigest,
          creationReceiptDigest: receipt.items[index].creationReceiptDigest,
        })),
        preparedHistoryDigest: `sha256:${preparedDigest}`,
        updatedAt: now(),
      },
      marker.parentSelectionBinding
    );
    const payload = {
      ...markerPayload(marker),
      preparedHistoryState: { exists: true, digest: preparedDigest },
      publicMarkdownPhase: nextPhase,
      updatedAt: nextPhase.updatedAt,
    };
    return sealValidatedMarker(payload, projectService, historyService);
  }

  function publicationTransition(previous, state, capture) {
    const candidate = {
      ...previous,
      state,
      previousPublicationDigest: previous.publicationDigest,
      createCapture: capture,
      publicationDigest: null,
    };
    candidate.publicationDigest = markerJournalSchema.publicationDigest(candidate);
    return markerJournalSchema.assertPublicationTransition(previous, candidate);
  }

  function assertSnapshotJournalCurrent(rootPath, scoped, expected, marker) {
    const current = journalCurrent(scoped);
    if (current.status !== 'VALUE' || canonical(current.value) !== canonical(expected) ||
        current.value.state !== 'ACTIVE' || current.value.activeOperationId !== marker.operationId ||
        current.value.activeKind !== 'snapshot_restore' ||
        canonical(current.value.activeMarker) !== canonical(marker)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot journal current authority drifted');
    }
    assertSnapshotPrepareAuthority(rootPath, marker);
    return current.value;
  }

  function materializePreparedHistory(marker, verified) {
    let baseHistory;
    if (marker.baseHistoryState.exists) {
      try {
        baseHistory = historyService.validateHistory(JSON.parse(
          verified.artifactHistory.baseHistory.bytes.toString('utf8')
        ));
      } catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'base History artifact invalid'); }
    } else {
      baseHistory = historyService.validateHistory({ schema: historyService.HISTORY_SCHEMA, entries: [] });
    }
    const prepared = historyService.materializeSnapshotRestoreHistoryTemplate(
      { exists: marker.baseHistoryState.exists, history: baseHistory },
      verified.template,
      marker.publicMarkdownPhase.items.map(item => ({
        path: item.path,
        createdIdentityDigest: item.createdIdentityDigest,
      }))
    );
    const bytes = Buffer.from(`${JSON.stringify(prepared.preparedHistoryState.history, null, 2)}\n`, 'utf8');
    const digest = crypto.createHash('sha256')
      .update(Buffer.from([1]))
      .update(bytes)
      .digest('hex');
    if (!marker.preparedHistoryState || marker.preparedHistoryState.exists !== true ||
        marker.preparedHistoryState.digest !== digest ||
        marker.publicMarkdownPhase.preparedHistoryDigest !== `sha256:${digest}`) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'receipt-derived prepared History drifted');
    }
    return Object.freeze({ prepared, bytes, digest });
  }

  function assertCommittedCreatePublication(marker, verified, publication) {
    const request = nativeCreateAuthority(marker, verified);
    const latched = publicMarkdownNativeSchema.buildLatchedCreatePublication(request);
    const capture = publicMarkdownNativeSchema.assertStoredCreateCapture(
      publication?.createCapture,
      request
    );
    const armed = publicationTransition(latched, 'ARMED', capture);
    const committed = publicationTransition(armed, 'COMMITTED', capture);
    if (canonical(publication) !== canonical(committed)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication is not exact COMMITTED truth');
    }
    return Object.freeze({ request, capture, committed });
  }

  function assertSnapshotHistoryJournalCurrent(
    rootPath,
    scoped,
    expectedValue,
    expectedMarker,
    expectedHistory
  ) {
    const current = journalCurrent(scoped);
    if (current.status !== 'VALUE' || canonical(current.value) !== canonical(expectedValue) ||
        current.value.state !== 'ACTIVE' ||
        current.value.activeOperationId !== expectedMarker.operationId ||
        current.value.activeKind !== 'snapshot_restore' ||
        canonical(current.value.activeMarker) !== canonical(expectedMarker)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History journal authority drifted');
    }
    projectIdentity(projectService, rootPath, expectedMarker.projectId);
    const marker = validateMarker(expectedMarker, projectService, historyService);
    if (canonical(marker) !== canonical(expectedMarker)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History marker authority drifted');
    }
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    if (marker.artifact.baseHistoryDigest !== marker.baseHistoryState.digest ||
        verified.artifactHistory.baseHistory.digest !== marker.baseHistoryState.digest ||
        verified.artifactHistory.baseHistory.exists !== marker.baseHistoryState.exists) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History artifact base authority drifted');
    }
    const history = currentHistoryBinding(rootPath);
    if (history.exists !== expectedHistory.exists || history.digest !== expectedHistory.digest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History raw authority drifted');
    }
    assertCommittedCreatePublication(marker, verified, current.value.nativePublication);
    return Object.freeze({ value: current.value, marker, verified, history });
  }

  function commitMissingRestoreHistoryJournal(rootPath, projectId, operationId, scoped, current) {
    if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE' ||
        current.value.activeOperationId !== operationId ||
        current.value.activeKind !== 'snapshot_restore') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History journal authority is unavailable');
    }
    let value = current.value;
    let marker = validateMarker(value.activeMarker, projectService, historyService);
    if (marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore') {
      fail('CHANGES_RECOVERY_STALE', 'Snapshot History journal operation is stale');
    }
    if (!['CREATED_RECEIPT', 'HISTORY_COMMITTED'].includes(marker.publicMarkdownPhase?.phase)) {
      fail('CHANGES_RECOVERY_CONFLICT', 'Snapshot History journal phase is invalid');
    }

    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    assertCommittedCreatePublication(marker, verified, value.nativePublication);
    const materialized = materializePreparedHistory(marker, verified);
    const preparedBinding = { exists: true, digest: materialized.digest };
    if (marker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED') {
      assertSnapshotHistoryJournalCurrent(
        rootPath,
        scoped,
        value,
        marker,
        preparedBinding
      );
      return marker;
    }

    let baseHistoryAuthority = null;
    let preparedHistoryAuthority = null;
    try {
      let history = currentHistoryBinding(rootPath);
      let writeError = null;
      if (history.exists === marker.baseHistoryState.exists &&
          history.digest === marker.baseHistoryState.digest) {
        assertSnapshotHistoryJournalCurrent(
          rootPath,
          scoped,
          value,
          marker,
          marker.baseHistoryState
        );
        baseHistoryAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
        try {
          historyService.restoreHistoryState(
            rootPath,
            materialized.prepared.preparedHistoryState,
            {
              expectedState: materialized.prepared.baseHistoryState,
              beforeRenameAuthority() {
                assertSnapshotHistoryJournalCurrent(
                  rootPath,
                  scoped,
                  value,
                  marker,
                  marker.baseHistoryState
                );
                assertHistoryAuthority(baseHistoryAuthority);
              },
            }
          );
        } catch (error) { writeError = error; }
        history = currentHistoryBinding(rootPath);
      }
      if (history.exists !== preparedBinding.exists || history.digest !== preparedBinding.digest) {
        if (history.exists === marker.baseHistoryState.exists &&
            history.digest === marker.baseHistoryState.digest && writeError) throw writeError;
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot History commit state is foreign');
      }

      const durable = ensurePreparedHistoryDurable(
        rootPath,
        preparedBinding,
        baseHistoryAuthority
      );
      preparedHistoryAuthority = durable.authority;
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'HISTORY_COMMITTED',
          updatedAt: now(),
        },
        marker.parentSelectionBinding
      );
      const nextPayload = {
        ...markerPayload(marker),
        publicMarkdownPhase: nextPhase,
        updatedAt: nextPhase.updatedAt,
      };
      const nextMarker = sealValidatedMarker(nextPayload, projectService, historyService);
      const nextValue = journalNextValue(value, {
        activeMarker: nextMarker,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(nextMarker),
      });
      const beforeAppend = () => {
        if (typeof beforeHistoryJournalAppend === 'function') {
          beforeHistoryJournalAppend({ rootPath, marker, nextMarker });
        }
        fileSystem.fsyncSync(preparedHistoryAuthority.directoryFd);
        assertHistoryAuthority(preparedHistoryAuthority);
        assertSnapshotHistoryJournalCurrent(
          rootPath,
          scoped,
          value,
          marker,
          preparedBinding
        );
      };
      if (appendSnapshotPreparedJournal(scoped, value, nextValue, beforeAppend) !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot HISTORY_COMMITTED journal truth is unknown');
      }
      value = nextValue;
      marker = nextMarker;
      assertHistoryAuthority(preparedHistoryAuthority);
      assertSnapshotHistoryJournalCurrent(
        rootPath,
        scoped,
        value,
        marker,
        preparedBinding
      );
      return marker;
    } finally {
      closeHistoryAuthority(preparedHistoryAuthority);
      closeHistoryAuthority(baseHistoryAuthority);
    }
  }

  function commitMissingRestoreHistory(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    if (markerJournalLifecycle !== null) {
      const scoped = markerJournalFor(rootPath, true);
      const current = journalCurrent(scoped);
      if (current.status !== 'LEGACY') {
        return commitMissingRestoreHistoryJournal(
          rootPath,
          projectId,
          operationId,
          scoped,
          current
        );
      }
    }
    const authority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    let preparedHistoryAuthority = null;
    try {
      let marker = authority.marker;
      if (marker.operationId !== operationId || marker.projectId !== projectId ||
          marker.kind !== 'snapshot_restore' || !marker.publicMarkdownPhase) {
        fail('CHANGES_RECOVERY_STALE', 'History commit authority is stale');
      }
      if (marker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED') return marker;
      if (marker.publicMarkdownPhase.phase !== 'CREATED_RECEIPT') {
        fail('CHANGES_RECOVERY_CONFLICT', 'History commit phase is invalid');
      }
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const materialized = materializePreparedHistory(marker, verified);
      const preparedBinding = { exists: true, digest: materialized.digest };
      let current = currentHistoryBinding(rootPath);
      const preparedHistoryAlreadyVisible = current.exists === preparedBinding.exists &&
        current.digest === preparedBinding.digest;
      if (preparedHistoryAlreadyVisible) {
        // A lost post-rename response leaves the prepared History visible while
        // the marker still says CREATED_RECEIPT. Reconcile that exact state
        // without applying the base-History precondition again.
        assertMarkerAuthority(authority);
      } else {
        assertSnapshotPrepareAuthority(rootPath, marker);
      }
      let writeError = null;
      if (current.exists === marker.baseHistoryState.exists &&
          current.digest === marker.baseHistoryState.digest) {
        historyAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
        try {
          historyService.restoreHistoryState(
            rootPath,
            materialized.prepared.preparedHistoryState,
            {
              expectedState: materialized.prepared.baseHistoryState,
              beforeRenameAuthority() {
                const location = markerLocation(rootPath, false, fileSystem);
                if (!location.exists || location.root !== authority.location.root) {
                  fail('CHANGES_RECOVERY_STALE', 'canonical root changed before History rename');
                }
                projectIdentity(projectService, rootPath, marker.projectId);
                verifyPublicMarkdownPhaseArtifact(rootPath, marker);
                assertMarkerAuthority(authority);
                assertHistoryAuthority(historyAuthority);
              },
            }
          );
        } catch (error) { writeError = error; }
        current = currentHistoryBinding(rootPath);
      }
      if (current.exists !== preparedBinding.exists || current.digest !== preparedBinding.digest) {
        if (current.exists === marker.baseHistoryState.exists &&
            current.digest === marker.baseHistoryState.digest && writeError) throw writeError;
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'History commit state is foreign');
      }
      projectIdentity(projectService, rootPath, marker.projectId);
      verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      assertMarkerAuthority(authority);
      const durablePrepared = ensurePreparedHistoryDurable(
        rootPath,
        preparedBinding,
        historyAuthority
      );
      current = durablePrepared.current;
      preparedHistoryAuthority = durablePrepared.authority;
      if (current.exists !== preparedBinding.exists || current.digest !== preparedBinding.digest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'durable prepared History authority drifted');
      }
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'HISTORY_COMMITTED',
          updatedAt: now(),
        },
        marker.parentSelectionBinding
      );
      const beforeExpectedRename = () => {
        const location = markerLocation(rootPath, false, fileSystem);
        if (!location.exists || location.root !== authority.location.root) {
          fail('CHANGES_RECOVERY_STALE', 'canonical root changed before History marker transition');
        }
        projectIdentity(projectService, rootPath, marker.projectId);
        verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        fileSystem.fsyncSync(preparedHistoryAuthority.directoryFd);
        assertHistoryAuthority(preparedHistoryAuthority);
        const latest = currentHistoryBinding(rootPath);
        if (latest.exists !== preparedBinding.exists || latest.digest !== preparedBinding.digest) {
          fail('CHANGES_RECOVERY_STALE', 'prepared History changed before marker transition');
        }
      };
      marker = persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: nextPhase,
        updatedAt: nextPhase.updatedAt,
      }, marker, authority, beforeExpectedRename);
      return marker;
    } finally {
      closeHistoryAuthority(preparedHistoryAuthority);
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(authority.fd); } catch (_) {}
    }
  }

  function finalizeAuthority(marker, verified) {
    const createAuthority = nativeCreateAuthority(marker, verified);
    const publicCreateAuthority = createRequest(marker, verified);
    const tokens = marker.publicMarkdownPhase.items.map((item, index) => {
      if (item.createdIdentityDigest === null || item.creationReceiptDigest === null) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize create receipt authority incomplete');
      }
      let control;
      let receipt;
      let token;
      try {
        control = publicMarkdownNativeSchema.buildControl(createAuthority, index);
        receipt = publicMarkdownNativeSchema.buildReceipt(control, item.createdIdentityDigest);
        token = publicMarkdownNativeSchema.buildToken(createAuthority, index, receipt);
      } catch (_) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize create receipt cannot be reproduced');
      }
      if (receipt.receiptDigest !== item.creationReceiptDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize create receipt digest drifted');
      }
      return token;
    });
    try {
      const historyCommittedPhase = marker.publicMarkdownPhase.phase === 'FINALIZED'
        ? publicMarkdownPhaseSchema.assertPhaseRecord({
          ...marker.publicMarkdownPhase,
          phase: 'HISTORY_COMMITTED',
          finalReceiptDigest: null,
        }, marker.parentSelectionBinding)
        : marker.publicMarkdownPhase;
      const request = publicMarkdownNativeSchema.assertFinalizeRequest({
        schema: publicMarkdownNativeSchema.SCHEMAS.FINALIZE_REQUEST,
        operationId: marker.operationId,
        artifactDigest: marker.artifact.sha256,
        selectionDigest: marker.publicMarkdownPhase.selectionDigest,
        historyCommittedPhaseDigest: evidenceDeliverySchema.digestObject(
          publicMarkdownPhaseSchema.SCHEMA,
          historyCommittedPhase
        ),
        tokens,
      }, createAuthority);
      return Object.freeze({ createAuthority, publicCreateAuthority, request });
    } catch (_) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'finalize authority cannot be reproduced');
    }
  }

  function createFinalizationAuthority(marker, verified, publication) {
    const createAuthority = nativeCreateAuthority(marker, verified);
    const storedCapture = publicMarkdownNativeSchema.assertStoredCreateCapture(
      publication.createCapture,
      createAuthority
    );
    const capture = {
      ...storedCapture,
      items: storedCapture.items.map(item => ({
        ...item,
        control: { ...item.control, state: 'PUBLISHED', cleanupBasename: null },
        receipt: { ...item.receipt, state: 'PUBLISHED', cleanupBasename: null },
      })),
    };
    const latched = publicMarkdownNativeSchema.buildLatchedCreatePublication(createAuthority);
    const armed = publicationTransition(latched, 'ARMED', capture);
    const committed = publicationTransition(armed, 'COMMITTED', capture);
    const nativeAuthority = finalizeAuthority(marker, verified);
    const identity = marker.artifact.identity;
    const artifactIdentity = {
      schema: evidenceDeliverySchema.SCHEMAS.OBJECT_IDENTITY,
      dev: identity.dev,
      ino: identity.ino,
      uid: Number(identity.uid),
      mode: Number(BigInt(identity.mode) & 0o7777n),
      nlink: Number(identity.nlink),
      size: identity.size,
      mtimeNs: identity.mtimeNs,
      ctimeNs: identity.ctimeNs,
      contentSha256: marker.artifact.sha256,
    };
    const finalizationAuthority = {
      schema: publicMarkdownNativeSchema.SCHEMAS.CREATE_FINALIZATION_AUTHORITY,
      createRequest: createAuthority,
      committedPublication: committed,
      historyCommittedPhaseDigest: nativeAuthority.request.historyCommittedPhaseDigest,
      rawPreparedHistoryStateDigest: `sha256:${marker.preparedHistoryState.digest}`,
      artifactIdentity,
    };
    return Object.freeze({ finalizationAuthority, nativeAuthority });
  }

  function publicationWithFinalization(publication, finalization) {
    const next = {
      ...publication,
      previousPublicationDigest: publication.publicationDigest,
      createFinalization: finalization,
      publicationDigest: null,
    };
    next.publicationDigest = markerJournalSchema.publicationDigest(next);
    return markerJournalSchema.assertPublicationTransition(publication, next);
  }

  function createCleanupCapture(capture, cleanupAuthority, state) {
    let ordinal = 0;
    return {
      ...capture,
      items: capture.items.map(item => ({
        ...item,
        control: progress(item.control, 'CONTROL'),
        receipt: progress(item.receipt, 'RECEIPT'),
      })),
    };

    function progress(record, role) {
      const cleanup = cleanupAuthority.items[ordinal];
      if (!cleanup || cleanup.ordinal !== ordinal || cleanup.role !== role ||
          cleanup.sourceBasename !== record.deterministicBasename ||
          cleanup.recordDigest !== record.rawSha256 ||
          canonical(cleanup.recordIdentity) !== canonical(record.recordIdentity)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot cleanup authority is reordered');
      }
      ordinal += 1;
      return {
        ...record,
        state,
        cleanupBasename: cleanup.cleanupBasename,
      };
    }
  }

  function publicationWithCreateCleanup(publication, cleanupAuthority, state) {
    const next = {
      ...publication,
      state,
      previousPublicationDigest: publication.publicationDigest,
      createCapture: createCleanupCapture(
        publication.createCapture,
        cleanupAuthority,
        state === 'ACK_PREPARED' ? 'CLEANUP_ARMED' : 'REMOVED'
      ),
      createFinalization: null,
      createCleanupFinalBasename: cleanupAuthority.finalBasename,
      createCleanupFinalRecordIdentity: cleanupAuthority.finalRecordIdentity,
      publicationDigest: null,
    };
    next.publicationDigest = markerJournalSchema.publicationDigest(next);
    return markerJournalSchema.assertPublicationTransition(publication, next);
  }

  function journalMarker(marker, fields) {
    const payload = { ...markerPayload(marker), ...fields };
    return sealValidatedMarker(payload, projectService, historyService);
  }

  function readFinalRecordIdentity(rootPath, finalBasename) {
    if (!/^\.changes-history-native-create-final\.[a-f0-9]{64}$/.test(
      finalBasename || ''
    )) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE final ACK basename is invalid');
    }
    const location = markerLocation(rootPath, false, fileSystem);
    const finalPath = path.join(location.directory, finalBasename);
    let fd;
    try {
      fd = fileSystem.openSync(
        finalPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const stat = fileSystem.fstatSync(fd, { bigint: true });
      if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink !== 1n ||
          Number(stat.uid) !== process.geteuid() || Number(stat.mode & 0o777n) !== 0o600) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE final ACK identity is invalid');
      }
      const bytes = fileSystem.readFileSync(fd);
      const after = fileSystem.fstatSync(fd, { bigint: true });
      if (!sameMarkerIdentity(stat, after) || BigInt(bytes.length) !== stat.size) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE final ACK changed during capture');
      }
      return Object.freeze({
        schema: evidenceDeliverySchema.SCHEMAS.OBJECT_IDENTITY,
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        uid: Number(stat.uid),
        mode: Number(stat.mode & 0o7777n),
        nlink: Number(stat.nlink),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        contentSha256: evidenceDeliverySchema.sha256(bytes),
      });
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'CREATE final ACK identity cannot be captured'
      );
      wrapped.cause = error;
      throw wrapped;
    } finally {
      if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    }
  }

  function captureFinalRecordIdentity(rootPath, finalization) {
    const expected = Buffer.from(publicMarkdownNativeSchema.encodeFinalAckRecord(
      finalization.finalAck,
      finalization.finalizeRequest,
      finalization.createRequest
    ), 'utf8');
    const identity = readFinalRecordIdentity(rootPath, finalization.finalBasename);
    if (identity.size !== String(expected.length) ||
        identity.contentSha256 !== evidenceDeliverySchema.sha256(expected)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'CREATE final ACK does not bind canonical bytes');
    }
    return identity;
  }

  function assertPersistedFinalRecordIdentity(rootPath, publication) {
    const expected = publication.createCleanupFinalRecordIdentity;
    const actual = readFinalRecordIdentity(
      rootPath,
      publication.createCleanupFinalBasename
    );
    if (expected === null || canonical(actual) !== canonical(expected)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot CREATE final ACK drifted after cleanup');
    }
    return expected;
  }

  function reconcileSnapshotJournalFinalization(rootPath, marker, allowFinalize) {
    const scopedJournal = markerJournalFor(rootPath, true);
    let current = journalCurrent(scopedJournal);
    if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE' ||
        current.value.activeOperationId !== marker.operationId ||
        current.value.activeKind !== 'snapshot_restore' ||
        canonical(current.value.activeMarker) !== canonical(marker) ||
        !['COMMITTED', 'ACK_PREPARED', 'ACK_COMMITTED']
          .includes(current.value.nativePublication?.state)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot FINALIZE journal authority is unavailable');
    }
    let value = current.value;
    let publication = value.nativePublication;
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    const authority = createFinalizationAuthority(marker, verified, publication);
    let finalization = publication.createFinalization;
    if (['ACK_PREPARED', 'ACK_COMMITTED'].includes(publication.state)) {
      finalization = publicMarkdownNativeSchema.buildPreparedCreateFinalization(
        authority.finalizationAuthority
      );
    }
    if (finalization === null) {
      finalization = publicMarkdownNativeSchema.buildPreparedCreateFinalization(
        authority.finalizationAuthority
      );
      const nextPublication = publicationWithFinalization(publication, finalization);
      const nextValue = journalNextValue(value, { nativePublication: nextPublication });
      if (appendSnapshotPreparedJournal(scopedJournal, value, nextValue) !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot FINALIZE preparation is unknown');
      }
      value = nextValue;
      publication = nextPublication;
    } else {
      finalization = publicMarkdownNativeSchema.assertStoredCreateFinalization(
        finalization,
        authority.finalizationAuthority
      );
    }
    const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind, false, true);
    const nativeAuthority = authority.nativeAuthority;
    if (publication.state === 'COMMITTED' && finalization.state !== 'CAPTURED') {
      let ack = validateFinalizeAck(
        lifecycle.reconcileFinalize(
          finalization.finalizeRequest,
          nativeAuthority.createAuthority,
          nativeAuthority.publicCreateAuthority
        ),
        marker,
        finalization.finalizeRequest,
        nativeAuthority.createAuthority
      );
      if (ack.status === 'ABSENT' && allowFinalize) {
        try {
          ack = validateFinalizeAck(
            lifecycle.finalizeCreate(
              finalization.finalizeRequest,
              nativeAuthority.createAuthority,
              nativeAuthority.publicCreateAuthority
            ),
            marker,
            finalization.finalizeRequest,
            nativeAuthority.createAuthority
          );
        } catch (_) {
          // The durable PREPARED slot is the only truth after an unavailable F
          // response. Restart must reconcile the immutable final record before
          // any marker or cleanup transition may advance.
          return marker;
        }
      }
      if (ack.status === 'ABSENT') return marker;
      const finalIdentity = captureFinalRecordIdentity(rootPath, {
        ...finalization,
        createRequest: authority.finalizationAuthority.createRequest,
      });
      const captured = publicMarkdownNativeSchema.buildCapturedCreateFinalization(
        authority.finalizationAuthority,
        finalIdentity
      );
      const capturedPublication = publicationWithFinalization(publication, captured);
      const capturedValue = journalNextValue(value, { nativePublication: capturedPublication });
      if (appendSnapshotPreparedJournal(scopedJournal, value, capturedValue) !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot FINALIZE capture is unknown');
      }
      value = capturedValue;
      publication = capturedPublication;
      finalization = captured;
    }
    const capturedFinalRecordIdentity = publication.state === 'COMMITTED'
      ? finalization.finalRecordIdentity
      : publication.createCleanupFinalRecordIdentity;
    if (capturedFinalRecordIdentity === null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot CREATE cleanup lacks captured final ACK identity');
    }
    const currentFinalRecordIdentity = captureFinalRecordIdentity(rootPath, {
      ...finalization,
      createRequest: authority.finalizationAuthority.createRequest,
    });
    if (canonical(currentFinalRecordIdentity) !== canonical(capturedFinalRecordIdentity)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot CREATE final ACK drifted before cleanup');
    }
    const cleanupAuthority = publicMarkdownNativeSchema.buildCreateCleanupAuthority(
      authority.finalizationAuthority,
      capturedFinalRecordIdentity
    );
    if (publication.state === 'COMMITTED') {
      const ackPreparedPublication = publicationWithCreateCleanup(
        publication,
        cleanupAuthority,
        'ACK_PREPARED'
      );
      const ackPreparedValue = journalNextValue(value, {
        nativePublication: ackPreparedPublication,
      });
      if (appendSnapshotPreparedJournal(scopedJournal, value, ackPreparedValue) !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE cleanup arm is unknown');
      }
      value = ackPreparedValue;
      publication = ackPreparedPublication;
    }
    if (publication.state !== 'ACK_COMMITTED') {
      let cleanupResult = lifecycle.reconcileCreateCleanup(cleanupAuthority);
      let ackResult = null;
      if (cleanupResult.state === 'UNKNOWN') {
        // Exact A is the reconciliation command after ACK removed both source
        // and quarantine names but its response was unavailable. R cannot
        // distinguish that terminal absence from foreign pre-cleanup absence.
        ackResult = lifecycle.ackCreateCleanup(cleanupAuthority);
      } else {
        if (cleanupResult.state === 'UNCOMMITTED') {
          cleanupResult = lifecycle.cleanupCreate(cleanupAuthority);
        }
        if (cleanupResult.state !== 'COMMITTED') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE cleanup is unknown');
        }
        ackResult = lifecycle.ackCreateCleanup(cleanupAuthority);
      }
      if (ackResult.state !== 'ACKED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE cleanup ACK is unknown');
      }
      const ackCommittedPublication = publicationWithCreateCleanup(
        publication,
        cleanupAuthority,
        'ACK_COMMITTED'
      );
      const ackCommittedValue = journalNextValue(value, {
        nativePublication: ackCommittedPublication,
      });
      if (appendSnapshotPreparedJournal(
        scopedJournal,
        value,
        ackCommittedValue,
        () => assertPersistedFinalRecordIdentity(rootPath, publication)
      ) !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE cleanup commit is unknown');
      }
      value = ackCommittedValue;
      publication = ackCommittedPublication;
    }
    if (marker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED') {
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'FINALIZED',
          finalReceiptDigest: finalization.finalAckDigest,
          updatedAt: marker.publicMarkdownPhase.updatedAt,
        },
        marker.parentSelectionBinding
      );
      marker = journalMarker(marker, {
        publicMarkdownPhase: nextPhase,
        updatedAt: now(),
      });
      const markerValue = journalNextValue(value, {
        activeMarker: marker,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(marker),
      });
      appendJournal(
        scopedJournal,
        value,
        markerValue,
        () => assertPersistedFinalRecordIdentity(rootPath, publication)
      );
      value = markerValue;
    } else if (marker.publicMarkdownPhase.phase !== 'FINALIZED' ||
        marker.publicMarkdownPhase.finalReceiptDigest !== finalization.finalAckDigest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot FINALIZED marker authority is foreign');
    }
    if (marker.state === 'applying') {
      marker = journalMarker(marker, {
        state: 'terminal',
        outcome: 'applied',
        recoveryWritePending: false,
        updatedAt: now(),
      });
      const markerValue = journalNextValue(value, {
        activeMarker: marker,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(marker),
      });
      appendJournal(
        scopedJournal,
        value,
        markerValue,
        () => assertPersistedFinalRecordIdentity(rootPath, publication)
      );
    } else if (marker.state !== 'terminal' || marker.outcome !== 'applied') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot terminal marker authority is foreign');
    }
    return marker;
  }

  function reconcilePublicMarkdownFinalize(rootPath, marker, allowFinalize) {
    if (!['HISTORY_COMMITTED', 'FINALIZED'].includes(marker.publicMarkdownPhase.phase)) return marker;
    if (markerJournalLifecycle !== null) {
      const current = journalCurrent(markerJournalFor(rootPath, true));
      if (current.status !== 'LEGACY') {
        return reconcileSnapshotJournalFinalization(rootPath, marker, allowFinalize);
      }
    }
    if (marker.publicMarkdownPhase.phase === 'FINALIZED') return marker;
    marker = acknowledgePublicMarkdownMarkerDurability(
      rootPath,
      marker,
      'HISTORY_COMMITTED'
    );
    const authority = captureMarkerAuthority(rootPath);
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity) {
        fail('CHANGES_RECOVERY_STALE', 'FINALIZE marker authority changed');
      }
      marker = authority.marker;
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const finalizedAuthority = finalizeAuthority(marker, verified);
      const request = finalizedAuthority.request;
      const createAuthority = finalizedAuthority.createAuthority;
      const publicCreateAuthority = finalizedAuthority.publicCreateAuthority;
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      let ack = validateFinalizeAck(
        lifecycle.reconcileFinalize(request, createAuthority, publicCreateAuthority),
        marker,
        request,
        createAuthority
      );
      if (ack.status === 'ABSENT' && allowFinalize) {
        ack = validateFinalizeAck(
          lifecycle.finalizeCreate(request, createAuthority, publicCreateAuthority),
          marker,
          request,
          createAuthority
        );
        if (ack.status !== 'FINALIZED') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'FINALIZE returned no durable ACK');
        }
      }
      if (ack.status === 'ABSENT') return marker;
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'FINALIZED',
          finalReceiptDigest: ack.finalReceiptDigest,
          // Keep the HISTORY_COMMITTED phase timestamp as part of the exact
          // native final-record key so restart can reconstruct the same
          // immutable finalize request from the FINALIZED marker.
          updatedAt: marker.publicMarkdownPhase.updatedAt,
        },
        marker.parentSelectionBinding
      );
      const beforeExpectedRename = () => {
        acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'HISTORY_COMMITTED');
        const latestAck = validateFinalizeAck(
          lifecycle.reconcileFinalize(request, createAuthority, publicCreateAuthority),
          marker,
          request,
          createAuthority
        );
        if (latestAck.status !== 'FINALIZED' || canonical(latestAck) !== canonical(ack)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'FINALIZE ACK changed before marker transition');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: nextPhase,
        updatedAt: now(),
      }, marker, authority, beforeExpectedRename);
    } finally { try { fileSystem.closeSync(authority.fd); } catch (_) {} }
  }

  function finalizeMissingRestore(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore' || !marker.publicMarkdownPhase) {
      fail('CHANGES_RECOVERY_STALE', 'FINALIZE authority is stale');
    }
    if (marker.publicMarkdownPhase.phase === 'FINALIZED') return marker;
    if (marker.publicMarkdownPhase.phase !== 'HISTORY_COMMITTED') {
      fail('CHANGES_RECOVERY_CONFLICT', 'FINALIZE phase is invalid');
    }
    return reconcilePublicMarkdownFinalize(rootPath, marker, true);
  }

  function reconcilePublicMarkdownCreate(rootPath, marker, allowCreate) {
    if (markerJournalLifecycle !== null) {
      const scopedJournal = markerJournalFor(rootPath, true);
      const current = journalCurrent(scopedJournal);
      if (current.status !== 'LEGACY') {
        if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE' ||
            current.value.activeOperationId !== marker.operationId ||
            current.value.activeKind !== 'snapshot_restore' ||
            canonical(current.value.activeMarker) !== canonical(marker)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE journal authority is unavailable');
        }
        let value = current.value;
        if (marker.publicMarkdownPhase.phase !== 'PRECREATE') return marker;
        let verified = assertSnapshotPrepareAuthority(rootPath, marker);
        const nativeRequest = nativeCreateAuthority(marker, verified);
        const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind, true);
        let publication = value.nativePublication;
        if (!publication || publication.command !== 'CREATE_MISSING') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication is missing');
        }
        const preparedPublication = publicMarkdownNativeSchema.buildPreparedCreatePublication(
          nativeRequest
        );
        const latchedPublication = publicMarkdownNativeSchema.buildLatchedCreatePublication(
          nativeRequest
        );
        let latchedByThisCall = false;
        if (publication.state === 'PREPARED') {
          if (canonical(publication) === canonical(preparedPublication)) {
            if (!allowCreate) {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE requires explicit author retry');
            }
            assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
            const latchedValue = journalNextValue(value, {
              nativePublication: latchedPublication,
            });
            if (appendSnapshotPreparedJournal(scopedJournal, value, latchedValue) !== 'COMMITTED') {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE attempt latch is unknown');
            }
            value = latchedValue;
            publication = latchedPublication;
            assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
            latchedByThisCall = true;
          } else if (canonical(publication) === canonical(latchedPublication)) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE attempt was already latched');
          } else {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE PREPARED authority drifted');
          }
        }
        if (publication.state === 'ARMED' || publication.state === 'COMMITTED') {
          const storedCapture = publicMarkdownNativeSchema.assertStoredCreateCapture(
            publication.createCapture,
            nativeRequest
          );
          const expectedArmed = publicationTransition(
            latchedPublication,
            'ARMED',
            storedCapture
          );
          const expectedPublication = publication.state === 'ARMED'
            ? expectedArmed
            : publicationTransition(expectedArmed, 'COMMITTED', storedCapture);
          if (canonical(publication) !== canonical(expectedPublication)) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication authority drifted');
          }
        } else if (publication.state !== 'PREPARED') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication state is invalid');
        }
        if (publication.state === 'PREPARED') {
          if (!latchedByThisCall || canonical(publication) !== canonical(latchedPublication)) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE attempt authority is not live');
          }
          assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
          let rawResult;
          rawResult = withPublicMarkdownArtifactFd(
            markerLocation(rootPath, false, fileSystem).directory,
            marker,
            heldArtifactFd => lifecycle.createMissingJournal(
              publicMarkdownNativeSchema.buildCreateJournalAuthority(nativeRequest, value),
              nativeRequest,
              value,
              heldArtifactFd
            )
          );
          let result;
          try {
            result = publicMarkdownNativeSchema.assertCreateMissingJournalResponse(
              rawResult,
              publicMarkdownNativeSchema.buildCreateJournalAuthority(nativeRequest, value),
              nativeRequest,
              value
            );
          } catch (_) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE result is malformed');
          }
          if (result.state !== 'COMMITTED') {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE returned UNKNOWN');
          }
          const capture = publicMarkdownNativeSchema.buildCreateCapture(
            nativeRequest,
            result.publicationResult
          );
          assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
          const armedPublication = publicationTransition(publication, 'ARMED', capture);
          const armedValue = journalNextValue(value, { nativePublication: armedPublication });
          if (appendSnapshotPreparedJournal(scopedJournal, value, armedValue) !== 'COMMITTED') {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE capture was not committed');
          }
          value = armedValue;
          publication = armedPublication;
          assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
        }
        if (publication.state === 'ARMED') {
          assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
          const committedPublication = publicationTransition(
            publication,
            'COMMITTED',
            publication.createCapture
          );
          const committedValue = journalNextValue(value, { nativePublication: committedPublication });
          if (appendSnapshotPreparedJournal(scopedJournal, value, committedValue) !== 'COMMITTED') {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication commit is unknown');
          }
          value = committedValue;
          publication = committedPublication;
          assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
        }
        if (publication.state !== 'COMMITTED') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATE publication state is invalid');
        }
        const capture = publicMarkdownNativeSchema.assertStoredCreateCapture(
          publication.createCapture,
          nativeRequest
        );
        const publicRequest = createRequest(marker, verified);
        const receipt = validateCreateReceipt({
          schema: CREATE_RECEIPT_SCHEMA,
          status: 'CREATED',
          operationId: marker.operationId,
          projectId: marker.projectId,
          artifactDigest: marker.artifact.sha256,
          selectionDigest: marker.publicMarkdownPhase.selectionDigest,
          items: capture.items.map((item, index) => ({
            selectedId: item.selectedId,
            path: item.path,
            afterRevision: publicRequest.items[index].afterRevision,
            ancestorIdentityDigest: item.ancestorIdentityDigest,
            contentDigest: item.contentDigest,
            createdIdentityDigest: evidenceDeliverySchema.digestObjectIdentity(
              item.createdLeafIdentity
            ),
            creationReceiptDigest: item.creationReceiptDigest,
          })),
        }, marker, publicRequest);
        const nextMarker = materializeJournalCreatedReceipt(marker, verified, receipt);
        assertSnapshotJournalCurrent(rootPath, scopedJournal, value, marker);
        const nextValue = journalNextValue(value, {
          activeMarker: nextMarker,
          activeMarkerDigest: markerJournalSchema.activeMarkerDigest(nextMarker),
        });
        if (appendSnapshotPreparedJournal(scopedJournal, value, nextValue) !== 'COMMITTED') {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot CREATED_RECEIPT marker is unknown');
        }
        assertSnapshotJournalCurrent(rootPath, scopedJournal, nextValue, nextMarker);
        return nextMarker;
      }
    }
    const authority = captureMarkerAuthority(rootPath);
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity) {
        fail('CHANGES_RECOVERY_STALE', 'recovery marker authority changed before CREATE');
      }
      marker = authority.marker;
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      if (marker.publicMarkdownPhase.phase !== 'PRECREATE') return marker;
      const request = createRequest(marker, verified);
      const nativeAuthority = nativeCreateAuthority(marker, verified);
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const finalReceipt = withPublicMarkdownArtifactFd(
        authority.location.directory,
        marker,
        heldArtifactFd => {
          const receipt = validateCreateReceipt(
            allowCreate
              ? lifecycle.create(request, nativeAuthority, heldArtifactFd)
              : lifecycle.reconcile(request, nativeAuthority, heldArtifactFd),
            marker,
            request
          );
          if (allowCreate && receipt.status === 'ABSENT') {
            // A proven native UNCOMMITTED result is safe but does not mint a
            // second CREATE attempt inside the same operation window.
            return receipt;
          }
          if (receipt.status === 'ABSENT') return receipt;
          if (receipt.status !== 'CREATED') {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE returned no durable receipt');
          }
          const verifiedReceipt = validateCreateReceipt(
            lifecycle.verifyCreate(request, nativeAuthority, heldArtifactFd, receipt),
            marker,
            request
          );
          if (verifiedReceipt.status !== 'CREATED' ||
              canonical(verifiedReceipt) !== canonical(receipt)) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE final authority receipt drifted');
          }
          return verifiedReceipt;
        }
      );
      if (finalReceipt.status !== 'CREATED') return marker;
      projectIdentity(projectService, rootPath, marker.projectId);
      const finalVerified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      assertMarkerAuthority(authority);
      const beforeExpectedRename = () => {
        const currentLocation = markerLocation(rootPath, false, fileSystem);
        if (!currentLocation.exists || currentLocation.root !== authority.location.root) {
          fail('CHANGES_RECOVERY_STALE', 'canonical project root changed before marker transition');
        }
        projectIdentity(projectService, rootPath, marker.projectId);
        let commitReceiptRaw;
        try {
          commitReceiptRaw = withPublicMarkdownArtifactFd(
            authority.location.directory,
            marker,
            heldArtifactFd => lifecycle.verifyCreate(
              request,
              nativeAuthority,
              heldArtifactFd,
              finalReceipt
            )
          );
        }
        catch (error) {
          if (error?.code === 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT') {
            fail('PUBLIC_MARKDOWN_AUTHORITY_CONFLICT', 'public Markdown root/ancestor authority drifted');
          }
          throw error;
        }
        const commitReceipt = validateCreateReceipt(commitReceiptRaw, marker, request);
        if (commitReceipt.status !== 'CREATED' ||
            canonical(commitReceipt) !== canonical(finalReceipt)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATE commit-window receipt drifted');
        }
        verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      };
      return persistCreatedReceipt(
        rootPath,
        marker,
        finalVerified,
        finalReceipt,
        authority,
        beforeExpectedRename
      );
    } finally {
      try { fileSystem.closeSync(authority.fd); } catch (_) {}
    }
  }

  function createMissingLeaves(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore' || !marker.publicMarkdownPhase) {
      fail('CHANGES_RECOVERY_STALE', 'public Markdown CREATE authority is stale');
    }
    return reconcilePublicMarkdownCreate(rootPath, marker, true);
  }

  function reconcilePublicMarkdownUndoQuarantine(rootPath, marker, allowQuarantine) {
    if (marker.publicMarkdownPhase.phase === 'QUARANTINED') {
      const committedAuthority = captureMarkerAuthority(rootPath);
      let baseHistoryAuthority = null;
      try {
        if (committedAuthority.marker.operationId !== marker.operationId ||
            committedAuthority.marker.integrity !== marker.integrity) {
          fail('CHANGES_RECOVERY_STALE', 'Safe Undo QUARANTINED marker authority changed');
        }
        marker = committedAuthority.marker;
        baseHistoryAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
        assertHistoryAuthority(baseHistoryAuthority);
        const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
        const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
        const truth = withPublicMarkdownArtifactFd(
          committedAuthority.location.directory,
          marker,
          heldArtifactFd => validateUndoResult(
            lifecycle.reconcileUndo(undoAuthority, heldArtifactFd),
            undoAuthority,
            'RECONCILE_UNDO'
          )
        );
        assertUndoSettlementWindow(
          rootPath,
          marker,
          committedAuthority,
          baseHistoryAuthority,
          undoAuthority
        );
        if (truth.state !== 'COMMITTED' || truth.tokens.length !== marker.publicMarkdownPhase.items.length ||
            truth.tokens.some((token, index) =>
              token.receiptDigest !==
                marker.publicMarkdownPhase.items[index].quarantineReceiptDigest)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo QUARANTINED receipt is absent or foreign');
        }
        return marker;
      } finally {
        closeHistoryAuthority(baseHistoryAuthority);
        try { fileSystem.closeSync(committedAuthority.fd); } catch (_) {}
      }
    }
    if (marker.publicMarkdownPhase.phase !== 'PRECREATE') return marker;
    let baseHistoryAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
    let mayQuarantine = allowQuarantine === true && marker.recoveryWritePending === false;
    if (mayQuarantine) {
      const latchAuthority = captureMarkerAuthority(rootPath);
      try {
        if (latchAuthority.marker.operationId !== marker.operationId ||
            latchAuthority.marker.integrity !== marker.integrity) {
          fail('CHANGES_RECOVERY_STALE', 'Safe Undo Q latch authority changed');
        }
        marker = persist(rootPath, {
          ...markerPayload(marker),
          recoveryWritePending: true,
          updatedAt: now(),
        }, marker, latchAuthority, () => {
          projectIdentity(projectService, rootPath, marker.projectId);
          verifyPublicMarkdownPhaseArtifact(rootPath, marker);
          assertHistoryAuthority(baseHistoryAuthority);
        });
      } catch (error) {
        closeHistoryAuthority(baseHistoryAuthority);
        baseHistoryAuthority = null;
        throw error;
      } finally { try { fileSystem.closeSync(latchAuthority.fd); } catch (_) {} }
    } else {
      mayQuarantine = false;
    }

    let authority;
    try {
      authority = captureMarkerAuthority(rootPath);
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity ||
          authority.marker.publicMarkdownPhase?.phase !== 'PRECREATE') {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo Q/R marker authority changed');
      }
      marker = authority.marker;
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const truth = withPublicMarkdownArtifactFd(
        authority.location.directory,
        marker,
        heldArtifactFd => {
          assertHistoryAuthority(baseHistoryAuthority);
          if (mayQuarantine) {
            try {
              validateUndoResult(
                lifecycle.quarantine(undoAuthority, heldArtifactFd),
                undoAuthority,
                'QUARANTINE'
              );
            } catch (_) {
              // A direct Q result is never commit truth. Always use fresh R.
            } finally {
              assertUndoSettlementWindow(
                rootPath,
                marker,
                authority,
                baseHistoryAuthority,
                undoAuthority
              );
            }
          }
          const reconciled = validateUndoResult(
            lifecycle.reconcileUndo(undoAuthority, heldArtifactFd),
            undoAuthority,
            'RECONCILE_UNDO'
          );
          assertUndoSettlementWindow(
            rootPath,
            marker,
            authority,
            baseHistoryAuthority,
            undoAuthority
          );
          return reconciled;
        }
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        authority,
        baseHistoryAuthority,
        undoAuthority
      );
      if (truth.state === 'UNCOMMITTED') return marker;
      if (truth.state !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo quarantine truth is UNKNOWN');
      }
      projectIdentity(projectService, rootPath, marker.projectId);
      verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      assertMarkerAuthority(authority);
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'QUARANTINED',
          items: marker.publicMarkdownPhase.items.map((item, index) => ({
            ...item,
            quarantineReceiptDigest: truth.tokens[index].receiptDigest,
          })),
          updatedAt: now(),
        },
        marker.parentSelectionBinding
      );
      const beforeExpectedRename = () => {
        projectIdentity(projectService, rootPath, marker.projectId);
        verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        const latest = withPublicMarkdownArtifactFd(
          authority.location.directory,
          marker,
          heldArtifactFd => validateUndoResult(
            lifecycle.reconcileUndo(undoAuthority, heldArtifactFd),
            undoAuthority,
            'RECONCILE_UNDO'
          )
        );
        assertUndoSettlementWindow(
          rootPath,
          marker,
          authority,
          baseHistoryAuthority,
          undoAuthority
        );
        if (latest.state !== 'COMMITTED' || canonical(latest) !== canonical(truth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo Q receipt changed before marker CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: nextPhase,
        recoveryWritePending: false,
        updatedAt: nextPhase.updatedAt,
      }, marker, authority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(baseHistoryAuthority);
      if (authority) try { fileSystem.closeSync(authority.fd); } catch (_) {}
    }
  }

  function requireUndoTerminalCleanup(rootPath) {
    const markerLifecycle = markerLifecycleFor(rootPath);
    const artifactLifecycle = artifactLifecycleFor(rootPath);
    if (!artifactLifecycle || [
      'cleanup', 'rollback', 'reconcile', 'verify', 'acknowledge',
    ].some(method => typeof artifactLifecycle[method] !== 'function')) {
      fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'durable artifact cleanup lifecycle is unavailable');
    }
    return Object.freeze({ markerLifecycle, artifactLifecycle });
  }

  function assertUndoSettlementWindow(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    expectedUndoAuthority = null
  ) {
    const currentLocation = markerLocation(rootPath, false, fileSystem);
    if (!currentLocation.exists || currentLocation.root !== markerAuthority.location.root ||
        currentLocation.directory !== markerAuthority.location.directory) {
      fail('CHANGES_RECOVERY_STALE', 'Safe Undo canonical project authority changed');
    }
    projectIdentity(projectService, rootPath, marker.projectId);
    if (expectedUndoAuthority !== null) {
      const currentRootBind = currentUndoRootBind(rootPath);
      if (canonical(currentRootBind) !== canonical(expectedUndoAuthority.rootBind)) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo root or recovery identity changed');
      }
    }
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    assertMarkerAuthority(markerAuthority);
    assertHistoryAuthority(historyAuthority);
    if (expectedUndoAuthority !== null) {
      const currentUndoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      if (canonical(currentUndoAuthority) !== canonical(expectedUndoAuthority)) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo root or recovery identity changed');
      }
    }
    return verified;
  }

  function freshCommittedUndoTokens(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    verified,
    undoAuthority,
    lifecycle
  ) {
    assertUndoSettlementWindow(
      rootPath,
      marker,
      markerAuthority,
      historyAuthority,
      undoAuthority
    );
    const truth = withPublicMarkdownArtifactFd(
      markerAuthority.location.directory,
      marker,
      heldArtifactFd => validateUndoResult(
        lifecycle.reconcileUndo(undoAuthority, heldArtifactFd),
        undoAuthority,
        'RECONCILE_UNDO'
      )
    );
    assertUndoSettlementWindow(
      rootPath,
      marker,
      markerAuthority,
      historyAuthority,
      undoAuthority
    );
    if (truth.state !== 'COMMITTED' ||
        truth.tokens.length !== marker.publicMarkdownPhase.items.length ||
        truth.tokens.some((token, index) => token.receiptDigest !==
          marker.publicMarkdownPhase.items[index].quarantineReceiptDigest)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo Q receipt truth is unavailable');
    }
    return truth;
  }

  function invokeRestoreQuarantine(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    settlement,
    undoAuthority,
    lifecycle,
    allowRetry = true
  ) {
    const invokeOnce = () => {
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const result = withPublicMarkdownArtifactFd(
        markerAuthority.location.directory,
        marker,
        heldArtifactFd => validateUndoSettleResult(
          lifecycle.restoreQuarantine(
            settlement.settleRequest,
            undoAuthority,
            heldArtifactFd
          ),
          settlement.settleRequest,
          undoAuthority
        )
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      return result;
    };
    let truth = null;
    try { truth = invokeOnce(); } catch (_) {}
    if (allowRetry && (truth === null || truth.state === 'UNKNOWN')) {
      try { truth = invokeOnce(); } catch (_) { truth = null; }
    }
    if (!truth || truth.state !== 'COMMITTED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo B truth is UNKNOWN or uncommitted');
    }
    return truth;
  }

  function persistUndoSettlementPrepared(rootPath, marker) {
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'QUARANTINED' ||
          markerAuthority.marker.publicMarkdownUndoSettlement !== undefined) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo B preparation authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const truth = freshCommittedUndoTokens(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        verified,
        undoAuthority,
        lifecycle
      );
      const settlement = undoSettlementSchema.prepare(undoAuthority, truth.tokens);
      undoSettlementSchema.assertMarkerTransition(
        null,
        settlement,
        undoAuthority,
        marker.publicMarkdownPhase,
        marker.publicMarkdownPhase
      );
      const beforeExpectedRename = () => {
        const latest = freshCommittedUndoTokens(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          verified,
          undoAuthority,
          lifecycle
        );
        if (canonical(latest) !== canonical(truth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo Q tokens changed before B CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownUndoSettlement: settlement,
        updatedAt: now(),
      }, marker, markerAuthority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function restoreSnapshotRestoreUndo(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    // These production cleanup authorities must exist before B can restore a
    // public leaf. Missing cleanup cannot create an uncloseable RESTORED state.
    requireUndoTerminalCleanup(rootPath);
    let marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore_undo' ||
        marker.publicMarkdownPhase?.phase !== 'QUARANTINED') {
      fail('CHANGES_RECOVERY_CONFLICT', 'Safe Undo B requires exact QUARANTINED authority');
    }
    if (marker.publicMarkdownUndoSettlement === undefined) {
      marker = persistUndoSettlementPrepared(rootPath, marker);
    }
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'QUARANTINED') {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo B marker authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const settlement = undoSettlementSchema.assertMarkerBinding(
        marker.publicMarkdownUndoSettlement,
        undoAuthority,
        marker.publicMarkdownPhase
      );
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const truth = invokeRestoreQuarantine(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        settlement,
        undoAuthority,
        lifecycle
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const committedSettlement = undoSettlementSchema.commit(
        settlement,
        truth,
        undoAuthority
      );
      const restoredPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'RESTORED',
          finalReceiptDigest: committedSettlement.finalRecord.finalRecordDigest,
          updatedAt: now(),
        },
        marker.parentSelectionBinding
      );
      undoSettlementSchema.assertMarkerTransition(
        settlement,
        committedSettlement,
        undoAuthority,
        marker.publicMarkdownPhase,
        restoredPhase
      );
      const beforeExpectedRename = () => {
        const latest = invokeRestoreQuarantine(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          settlement,
          undoAuthority,
          lifecycle,
          false
        );
        assertHistoryAuthority(historyAuthority);
        projectIdentity(projectService, rootPath, marker.projectId);
        verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        if (canonical(latest) !== canonical(truth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo B truth changed before RESTORED CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: restoredPhase,
        publicMarkdownUndoSettlement: committedSettlement,
        recoveryWritePending: false,
        updatedAt: restoredPhase.updatedAt,
      }, marker, markerAuthority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function invokeUndoAck(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    settlement,
    undoAuthority,
    lifecycle,
    allowRetry = true
  ) {
    const ack = publicMarkdownNativeSchema.buildUndoAckRequest(
      settlement.settleRequest,
      settlement.finalRecord,
      settlement.finalRecordIdentity,
      undoAuthority,
      'RESTORE_QUARANTINE'
    );
    const invokeOnce = () => {
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const result = withPublicMarkdownArtifactFd(
        markerAuthority.location.directory,
        marker,
        heldArtifactFd => validateUndoAckResult(
          lifecycle.ackUndo(
            ack,
            settlement.settleRequest,
            settlement.finalRecord,
            settlement.finalRecordIdentity,
            undoAuthority,
            heldArtifactFd,
            'RESTORE_QUARANTINE'
          ),
          ack,
          settlement,
          undoAuthority
        )
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      return result;
    };
    let truth = null;
    try { truth = invokeOnce(); } catch (_) {}
    if (allowRetry && (truth === null || truth.state === 'UNKNOWN')) {
      try { truth = invokeOnce(); } catch (_) { truth = null; }
    }
    if (!truth || truth.state !== 'ACKED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo A truth is UNKNOWN');
    }
    return truth;
  }

  function terminalizeRestoredUndoMarker(rootPath, marker) {
    requireUndoTerminalCleanup(rootPath);
    const alreadyTerminal = marker.state === 'terminal';
    if (alreadyTerminal && (marker.outcome !== 'zero_write_error' ||
        marker.publicMarkdownPhase?.phase !== 'RESTORED' ||
        marker.publicMarkdownUndoSettlement === undefined)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'RESTORED terminal marker is invalid');
    }
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'RESTORED') {
        fail('CHANGES_RECOVERY_STALE', 'RESTORED marker authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.baseHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const settlement = undoSettlementSchema.assertMarkerBinding(
        marker.publicMarkdownUndoSettlement,
        undoAuthority,
        marker.publicMarkdownPhase
      );
      const state = authoritativeState(rootPath, marker);
      if (state.history !== 'base' || state.fileStates.some(value => value !== 'before')) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'RESTORED public or History authority is foreign');
      }
      if (alreadyTerminal) return marker;
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const ackTruth = invokeUndoAck(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        settlement,
        undoAuthority,
        lifecycle
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const beforeExpectedRename = () => {
        const latest = invokeUndoAck(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          settlement,
          undoAuthority,
          lifecycle,
          false
        );
        assertHistoryAuthority(historyAuthority);
        projectIdentity(projectService, rootPath, marker.projectId);
        verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        if (canonical(latest) !== canonical(ackTruth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo A truth changed before terminal CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        state: 'terminal',
        outcome: 'zero_write_error',
        recoveryWritePending: false,
        updatedAt: now(),
      }, marker, markerAuthority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function invokeFinalizationAck(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    finalization,
    undoAuthority,
    lifecycle,
    allowRetry = true
  ) {
    const invokeOnce = () => {
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const result = withPublicMarkdownArtifactFd(
        markerAuthority.location.directory,
        marker,
        heldArtifactFd => validateUndoAckResult(
          lifecycle.ackUndo(
            finalization.ackRequest,
            finalization.settleRequest,
            finalization.finalRecord,
            finalization.finalRecordIdentity,
            undoAuthority,
            heldArtifactFd,
            'FINALIZE_UNDO'
          ),
          finalization.ackRequest,
          finalization,
          undoAuthority,
          'FINALIZE_UNDO'
        )
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      return result;
    };
    let truth = null;
    try { truth = invokeOnce(); } catch (_) {}
    if (allowRetry && (truth === null || truth.state === 'UNKNOWN')) {
      try { truth = invokeOnce(); } catch (_) { truth = null; }
    }
    if (!truth || truth.state !== 'ACKED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo FINALIZE_UNDO A truth is UNKNOWN');
    }
    return truth;
  }

  function terminalizeFinalizedUndoMarker(rootPath, marker) {
    requireUndoTerminalCleanup(rootPath);
    marker = acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'FINALIZED');
    const alreadyTerminal = marker.state === 'terminal';
    if (alreadyTerminal && (marker.outcome !== 'undone' ||
        marker.publicMarkdownPhase?.phase !== 'FINALIZED' ||
        marker.publicMarkdownUndoSettlement !== undefined ||
        marker.publicMarkdownUndoFinalization === undefined)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo FINALIZED terminal marker is invalid');
    }
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'FINALIZED' ||
          markerAuthority.marker.publicMarkdownUndoSettlement !== undefined) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo FINALIZED marker authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.preparedHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const finalization = undoFinalizationSchema.assertMarkerBinding(
        marker.publicMarkdownUndoFinalization,
        undoAuthority,
        marker.publicMarkdownPhase,
        null
      );
      if (alreadyTerminal) return marker;
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const ackTruth = invokeFinalizationAck(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        finalization,
        undoAuthority,
        lifecycle
      );
      const beforeExpectedRename = () => {
        const latest = invokeFinalizationAck(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          finalization,
          undoAuthority,
          lifecycle,
          false
        );
        if (canonical(latest) !== canonical(ackTruth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo A truth changed before terminal CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        state: 'terminal',
        outcome: 'undone',
        recoveryWritePending: false,
        updatedAt: now(),
      }, marker, markerAuthority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function quarantineSnapshotRestoreUndo(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore_undo' || !marker.publicMarkdownPhase) {
      fail('CHANGES_RECOVERY_STALE', 'Safe Undo quarantine authority is stale');
    }
    if (marker.publicMarkdownPhase.phase === 'QUARANTINED') return marker;
    if (marker.publicMarkdownPhase.phase !== 'PRECREATE') {
      fail('CHANGES_RECOVERY_CONFLICT', 'Safe Undo quarantine phase is invalid');
    }
    return reconcilePublicMarkdownUndoQuarantine(rootPath, marker, true);
  }

  function materializeSnapshotRestoreUndoHistory(marker, verified) {
    if (marker.kind !== 'snapshot_restore_undo' ||
        verified.template.schema !==
          historyService.SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo History template kind is invalid');
    }
    let materialized;
    try {
      materialized = historyService.materializeSnapshotRestoreUndoHistoryTemplate(
        verified.artifactHistory.baseHistory.bytes,
        verified.template
      );
    } catch (error) {
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Safe Undo prepared History cannot be materialized'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (marker.preparedHistoryState?.exists !== true ||
        marker.preparedHistoryState.digest !== materialized.preparedHistoryDigest ||
        marker.publicMarkdownPhase.preparedHistoryDigest !==
          `sha256:${materialized.preparedHistoryDigest}`) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo prepared History digest drifted');
    }
    return materialized;
  }

  function commitSnapshotRestoreUndoHistory(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const markerAuthority = captureMarkerAuthority(rootPath);
    let baseHistoryAuthority = null;
    let currentHistoryAuthority = null;
    let preparedHistoryAuthority = null;
    try {
      let marker = markerAuthority.marker;
      if (marker.operationId !== operationId || marker.projectId !== projectId ||
          marker.kind !== 'snapshot_restore_undo' ||
          marker.publicMarkdownPhase?.phase !== 'QUARANTINED' ||
          marker.publicMarkdownUndoSettlement !== undefined) {
        fail('CHANGES_RECOVERY_CONFLICT',
          'Safe Undo History commit requires exact QUARANTINED mainline authority');
      }
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const materialized = materializeSnapshotRestoreUndoHistory(marker, verified);
      const preparedBinding = {
        exists: true,
        digest: materialized.preparedHistoryDigest,
      };
      let current = currentHistoryBinding(rootPath);
      const isBase = current.exists === marker.baseHistoryState.exists &&
        current.digest === marker.baseHistoryState.digest;
      const isPrepared = current.exists === preparedBinding.exists &&
        current.digest === preparedBinding.digest;
      if (!isBase && !isPrepared) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo History state is foreign');
      }

      currentHistoryAuthority = captureHistoryAuthority(
        rootPath,
        isBase ? marker.baseHistoryState : preparedBinding
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const initialTruth = freshCommittedUndoTokens(
        rootPath,
        marker,
        markerAuthority,
        currentHistoryAuthority,
        verified,
        undoAuthority,
        lifecycle
      );

      let writeError = null;
      if (isBase) {
        baseHistoryAuthority = currentHistoryAuthority;
        currentHistoryAuthority = null;
        try {
          historyService.restoreHistoryState(
            rootPath,
            materialized.preparedHistoryState,
            {
              expectedState: materialized.baseHistoryState,
              beforeRenameAuthority() {
                assertUndoSettlementWindow(
                  rootPath,
                  marker,
                  markerAuthority,
                  baseHistoryAuthority,
                  undoAuthority
                );
              },
            }
          );
        } catch (error) { writeError = error; }
        current = currentHistoryBinding(rootPath);
        if (current.exists !== preparedBinding.exists ||
            current.digest !== preparedBinding.digest) {
          if (current.exists === marker.baseHistoryState.exists &&
              current.digest === marker.baseHistoryState.digest && writeError) {
            throw writeError;
          }
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo History commit state is foreign');
        }
      }

      projectIdentity(projectService, rootPath, marker.projectId);
      verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      assertMarkerAuthority(markerAuthority);
      const durable = ensurePreparedHistoryDurable(
        rootPath,
        preparedBinding,
        baseHistoryAuthority || currentHistoryAuthority
      );
      preparedHistoryAuthority = durable.authority;
      if (durable.current.exists !== preparedBinding.exists ||
          durable.current.digest !== preparedBinding.digest) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo durable History authority drifted');
      }
      const committedTruth = freshCommittedUndoTokens(
        rootPath,
        marker,
        markerAuthority,
        preparedHistoryAuthority,
        verified,
        undoAuthority,
        lifecycle
      );
      if (canonical(committedTruth) !== canonical(initialTruth)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo Q truth changed after History commit');
      }
      const nextPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'HISTORY_COMMITTED',
          updatedAt: now(),
        },
        marker.parentSelectionBinding
      );
      const beforeExpectedRename = () => {
        fileSystem.fsyncSync(preparedHistoryAuthority.directoryFd);
        const latest = freshCommittedUndoTokens(
          rootPath,
          marker,
          markerAuthority,
          preparedHistoryAuthority,
          verified,
          undoAuthority,
          lifecycle
        );
        if (canonical(latest) !== canonical(initialTruth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
            'Safe Undo Q truth changed before HISTORY_COMMITTED CAS');
        }
      };
      marker = persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: nextPhase,
        recoveryWritePending: false,
        updatedAt: nextPhase.updatedAt,
      }, marker, markerAuthority, beforeExpectedRename);
      return marker;
    } finally {
      closeHistoryAuthority(preparedHistoryAuthority);
      closeHistoryAuthority(currentHistoryAuthority);
      closeHistoryAuthority(baseHistoryAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function persistUndoFinalizationPrepared(rootPath, marker) {
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'HISTORY_COMMITTED' ||
          markerAuthority.marker.publicMarkdownUndoSettlement !== undefined ||
          markerAuthority.marker.publicMarkdownUndoFinalization !== undefined) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo D preparation authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.preparedHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const truth = freshCommittedUndoTokens(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        verified,
        undoAuthority,
        lifecycle
      );
      const finalization = undoFinalizationSchema.prepare(
        undoAuthority,
        truth.tokens,
        marker.publicMarkdownPhase
      );
      undoFinalizationSchema.assertMarkerTransition(
        null,
        finalization,
        undoAuthority,
        marker.publicMarkdownPhase,
        marker.publicMarkdownPhase,
        null,
        null
      );
      const beforeExpectedRename = () => {
        const latest = freshCommittedUndoTokens(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          verified,
          undoAuthority,
          lifecycle
        );
        if (canonical(latest) !== canonical(truth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo Q tokens changed before D CAS');
        }
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownUndoFinalization: finalization,
        updatedAt: now(),
      }, marker, markerAuthority, beforeExpectedRename);
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function invokeFinalizeUndo(
    rootPath,
    marker,
    markerAuthority,
    historyAuthority,
    finalization,
    undoAuthority,
    lifecycle,
    allowRetry = true
  ) {
    const invokeOnce = () => {
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      const result = withPublicMarkdownArtifactFd(
        markerAuthority.location.directory,
        marker,
        heldArtifactFd => validateUndoSettleResult(
          lifecycle.finalizeUndo(
            finalization.settleRequest,
            undoAuthority,
            heldArtifactFd
          ),
          finalization.settleRequest,
          undoAuthority,
          'FINALIZE_UNDO'
        )
      );
      assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        undoAuthority
      );
      return result;
    };
    let truth = null;
    try { truth = invokeOnce(); } catch (_) {}
    if (allowRetry && (truth === null || truth.state === 'UNKNOWN')) {
      try { truth = invokeOnce(); } catch (_) { truth = null; }
    }
    if (!truth || truth.state !== 'COMMITTED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo D truth is UNKNOWN or uncommitted');
    }
    return truth;
  }

  function reconcilePublicMarkdownUndoFinalize(rootPath, marker) {
    if (marker.publicMarkdownPhase.phase === 'FINALIZED') {
      return acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'FINALIZED');
    }
    if (marker.publicMarkdownPhase.phase !== 'HISTORY_COMMITTED' ||
        marker.publicMarkdownUndoSettlement !== undefined ||
        marker.publicMarkdownUndoFinalization === undefined) {
      fail('CHANGES_RECOVERY_CONFLICT', 'Safe Undo D requires prepared HISTORY_COMMITTED authority');
    }
    marker = acknowledgePublicMarkdownMarkerDurability(
      rootPath,
      marker,
      'HISTORY_COMMITTED'
    );
    const markerAuthority = captureMarkerAuthority(rootPath);
    let historyAuthority = null;
    try {
      if (markerAuthority.marker.operationId !== marker.operationId ||
          markerAuthority.marker.integrity !== marker.integrity ||
          markerAuthority.marker.publicMarkdownPhase?.phase !== 'HISTORY_COMMITTED' ||
          markerAuthority.marker.publicMarkdownUndoSettlement !== undefined) {
        fail('CHANGES_RECOVERY_STALE', 'Safe Undo D marker authority changed');
      }
      marker = markerAuthority.marker;
      historyAuthority = captureHistoryAuthority(rootPath, marker.preparedHistoryState);
      const verified = assertUndoSettlementWindow(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority
      );
      const undoAuthority = nativeUndoAuthority(rootPath, marker, verified);
      const finalization = undoFinalizationSchema.assertMarkerBinding(
        marker.publicMarkdownUndoFinalization,
        undoAuthority,
        marker.publicMarkdownPhase,
        null
      );
      const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
      const truth = invokeFinalizeUndo(
        rootPath,
        marker,
        markerAuthority,
        historyAuthority,
        finalization,
        undoAuthority,
        lifecycle
      );
      const committedFinalization = undoFinalizationSchema.commit(
        finalization,
        truth,
        undoAuthority
      );
      const finalizedPhase = publicMarkdownPhaseSchema.assertTransition(
        marker.publicMarkdownPhase,
        {
          ...marker.publicMarkdownPhase,
          phase: 'FINALIZED',
          finalReceiptDigest: committedFinalization.finalRecord.finalRecordDigest,
          // Frozen D/A authority includes this exact HISTORY_COMMITTED phase.
          updatedAt: marker.publicMarkdownPhase.updatedAt,
        },
        marker.parentSelectionBinding
      );
      undoFinalizationSchema.assertMarkerTransition(
        finalization,
        committedFinalization,
        undoAuthority,
        marker.publicMarkdownPhase,
        finalizedPhase,
        null,
        null
      );
      const beforeExpectedRename = () => {
        const latest = invokeFinalizeUndo(
          rootPath,
          marker,
          markerAuthority,
          historyAuthority,
          finalization,
          undoAuthority,
          lifecycle,
          false
        );
        if (canonical(latest) !== canonical(truth)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo D truth changed before FINALIZED CAS');
        }
      };
      const finalized = persist(rootPath, {
        ...markerPayload(marker),
        publicMarkdownPhase: finalizedPhase,
        publicMarkdownUndoFinalization: committedFinalization,
        recoveryWritePending: false,
        updatedAt: now(),
      }, marker, markerAuthority, beforeExpectedRename);
      return acknowledgePublicMarkdownMarkerDurability(rootPath, finalized, 'FINALIZED');
    } finally {
      closeHistoryAuthority(historyAuthority);
      try { fileSystem.closeSync(markerAuthority.fd); } catch (_) {}
    }
  }

  function finalizeSnapshotRestoreUndo(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    requireUndoTerminalCleanup(rootPath);
    let marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore_undo' ||
        !['HISTORY_COMMITTED', 'FINALIZED'].includes(marker.publicMarkdownPhase?.phase) ||
        marker.publicMarkdownUndoSettlement !== undefined) {
      fail('CHANGES_RECOVERY_CONFLICT', 'Safe Undo D requires exact HISTORY_COMMITTED authority');
    }
    if (marker.publicMarkdownPhase.phase === 'FINALIZED') {
      return acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'FINALIZED');
    }
    if (marker.publicMarkdownUndoFinalization === undefined) {
      marker = persistUndoFinalizationPrepared(rootPath, marker);
    }
    return reconcilePublicMarkdownUndoFinalize(rootPath, marker);
  }

  function acknowledgePublicMarkdownMarkerDurability(
    rootPath,
    marker,
    expectedPhase = 'HISTORY_COMMITTED'
  ) {
    const authority = captureMarkerAuthority(rootPath);
    let directoryFd;
    const publicDirectories = [];
    const capturePublicDirectory = directory => {
      try {
        const stat = fileSystem.lstatSync(directory, { bigint: true });
        if ((stat.mode & 0o170000n) !== 0o040000n) {
          fail('CHANGES_RECOVERY_STALE', 'public ancestor is not a directory');
        }
        const fd = fileSystem.openSync(
          directory,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        const held = fileSystem.fstatSync(fd, { bigint: true });
        if (!sameDirectoryIdentity(stat, held)) {
          fileSystem.closeSync(fd);
          fail('CHANGES_RECOVERY_STALE', 'public ancestor changed during capture');
        }
        publicDirectories.push({ directory, exists: true, fd, stat: held });
      } catch (error) {
        if (error instanceof ChangesHistoryRecoveryError) throw error;
        if (error?.code !== 'ENOENT') throw error;
        publicDirectories.push({ directory, exists: false, fd: null, stat: null });
      }
    };
    const verifyPublicDirectories = () => {
      for (const item of publicDirectories) {
        if (!item.exists) {
          try {
            const stat = fileSystem.lstatSync(item.directory);
            if (stat) fail('CHANGES_RECOVERY_STALE', 'absent public ancestor appeared');
          } catch (error) {
            if (error instanceof ChangesHistoryRecoveryError) throw error;
            if (error?.code !== 'ENOENT') throw error;
          }
          continue;
        }
        const heldAfter = fileSystem.fstatSync(item.fd, { bigint: true });
        if (!sameDirectoryIdentity(item.stat, heldAfter)) {
          fail('CHANGES_RECOVERY_STALE', 'held public ancestor changed');
        }
        let reopened;
        try {
          reopened = fileSystem.openSync(
            item.directory,
            fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
          );
          const current = fileSystem.fstatSync(reopened, { bigint: true });
          if (!sameDirectoryIdentity(item.stat, current)) {
            fail('CHANGES_RECOVERY_STALE', 'public ancestor path was replaced');
          }
        } finally {
          if (reopened !== undefined) try { fileSystem.closeSync(reopened); } catch (_) {}
        }
      }
    };
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity ||
          authority.marker.publicMarkdownPhase?.phase !== expectedPhase) {
        fail('CHANGES_RECOVERY_STALE', `${expectedPhase} marker authority changed`);
      }
      marker = authority.marker;
      capturePublicDirectory(authority.location.root);
      const seenAncestors = new Set([authority.location.root]);
      for (const selected of marker.parentSelectionBinding.selected) {
        const parts = selected.path.split('/').slice(0, -1);
        let current = authority.location.root;
        for (const part of parts) {
          current = path.join(current, part);
          if (!seenAncestors.has(current)) {
            seenAncestors.add(current);
            capturePublicDirectory(current);
          }
        }
      }
      const location = markerLocation(rootPath, false, fileSystem);
      if (!location.exists || location.root !== authority.location.root ||
          location.directory !== authority.location.directory) {
        fail('CHANGES_RECOVERY_STALE', 'recovery directory authority changed');
      }
      directoryFd = fileSystem.openSync(location.directory, fs.constants.O_RDONLY);
      const directoryStat = fileSystem.fstatSync(directoryFd, { bigint: true });
      projectIdentity(projectService, rootPath, marker.projectId);
      verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const current = currentHistoryBinding(rootPath);
      if (!marker.preparedHistoryState || current.exists !== marker.preparedHistoryState.exists ||
          current.digest !== marker.preparedHistoryState.digest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'HISTORY_COMMITTED History authority is foreign');
      }
      if (typeof beforeMarkerDurabilityFsync === 'function') {
        beforeMarkerDurabilityFsync({ rootPath, marker, location });
      }
      try { fileSystem.fsyncSync(directoryFd); }
      catch (error) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_RECOVERY_WRITE_FAILED',
          `${expectedPhase} marker directory durability is pending`
        );
        wrapped.cause = error;
        throw wrapped;
      }
      const directoryAfter = fileSystem.fstatSync(directoryFd, { bigint: true });
      if (!sameDirectoryIdentity(directoryStat, directoryAfter)) {
        fail('CHANGES_RECOVERY_STALE', 'held recovery directory changed during fsync');
      }
      verifyPublicDirectories();
      projectIdentity(projectService, rootPath, marker.projectId);
      let reopenedFd;
      try {
        reopenedFd = fileSystem.openSync(location.directory, fs.constants.O_RDONLY);
        const reopenedStat = fileSystem.fstatSync(reopenedFd, { bigint: true });
        if (!sameDirectoryIdentity(directoryStat, reopenedStat)) {
          fail('CHANGES_RECOVERY_STALE', 'recovery directory path was replaced');
        }
      } finally {
        if (reopenedFd !== undefined) try { fileSystem.closeSync(reopenedFd); } catch (_) {}
      }
      assertMarkerAuthority(authority);
      verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const afterHistory = currentHistoryBinding(rootPath);
      if (afterHistory.exists !== marker.preparedHistoryState.exists ||
          afterHistory.digest !== marker.preparedHistoryState.digest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${expectedPhase} History changed after fsync`);
      }
      return marker;
    } finally {
      for (const item of publicDirectories) {
        if (item.fd !== null) try { fileSystem.closeSync(item.fd); } catch (_) {}
      }
      if (directoryFd !== undefined) try { fileSystem.closeSync(directoryFd); } catch (_) {}
      try { fileSystem.closeSync(authority.fd); } catch (_) {}
    }
  }

  function verifyFinalizedReceipt(rootPath, marker) {
    if (marker.kind !== 'snapshot_restore' ||
        marker.publicMarkdownPhase?.phase !== 'FINALIZED') {
      fail('CHANGES_RECOVERY_CONFLICT', 'FINALIZED receipt phase is invalid');
    }
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    const finalizedAuthority = finalizeAuthority(marker, verified);
    const lifecycle = publicMarkdownLifecycleFor(rootPath, marker.kind);
    const ack = validateFinalizeAck(
      lifecycle.reconcileFinalize(
        finalizedAuthority.request,
        finalizedAuthority.createAuthority,
        finalizedAuthority.publicCreateAuthority
      ),
      marker,
      finalizedAuthority.request,
      finalizedAuthority.createAuthority
    );
    if (ack.status !== 'FINALIZED' ||
        ack.finalReceiptDigest !== marker.publicMarkdownPhase.finalReceiptDigest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'FINALIZED formal receipt is absent or foreign');
    }
    return ack;
  }

  function terminalizeFinalizedMarker(rootPath, marker) {
    marker = acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'FINALIZED');
    verifyFinalizedReceipt(rootPath, marker);
    if (marker.state === 'terminal') {
      if (marker.outcome !== 'applied') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'FINALIZED terminal outcome is invalid');
      }
      return marker;
    }
    const authority = captureMarkerAuthority(rootPath);
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity ||
          authority.marker.publicMarkdownPhase?.phase !== 'FINALIZED') {
        fail('CHANGES_RECOVERY_STALE', 'FINALIZED terminal marker authority changed');
      }
      const beforeExpectedRename = () => {
        acknowledgePublicMarkdownMarkerDurability(rootPath, marker, 'FINALIZED');
        verifyFinalizedReceipt(rootPath, marker);
      };
      return persist(rootPath, {
        ...markerPayload(marker),
        state: 'terminal',
        outcome: 'applied',
        recoveryWritePending: false,
        updatedAt: now(),
      }, marker, authority, beforeExpectedRename);
    } finally { try { fileSystem.closeSync(authority.fd); } catch (_) {} }
  }

  function readLegacyMarker(rootPath, required = false) {
    const location = markerLocation(rootPath, false, fileSystem);
    if (!location.exists) {
      if (required) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'legacy recovery marker is unavailable');
      return null;
    }
    const stat = fileSystem.lstatSync(location.file);
    if (stat.size > MAX_MARKER_BYTES) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记超过安全上限');
    }
    let raw;
    try { raw = JSON.parse(fileSystem.readFileSync(location.file, 'utf8')); }
    catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复标记损坏'); }
    return validateMarker(raw, projectService, historyService);
  }

  function readMarker(rootPath) {
    const lifecycle = markerJournalFor(rootPath);
    if (lifecycle === null) return readLegacyMarker(rootPath);
    let rawResult;
    try { rawResult = lifecycle.discoverCurrent(); }
    catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'marker journal discovery failed'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    let result;
    try { result = journalReadResult(rawResult); }
    catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'marker journal authority is malformed'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    if (result.status === 'ABSENT') return null;
    if (result.status === 'LEGACY') return readLegacyMarker(rootPath, true);
    if (result.status === 'UNKNOWN') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal requires manual recovery');
    }
    if (result.value.state === 'IDLE') return null;
    if (result.value.state !== 'ACTIVE' || result.value.activeMarker === null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'marker journal active authority is malformed');
    }
    return validateMarker(result.value.activeMarker, projectService, historyService);
  }

  function persistOrdinaryJournal(
    rootPath,
    nextMarker,
    expectedMarker,
    beforeExpectedAppend
  ) {
    const scoped = markerJournalFor(rootPath, true);
    let current = journalCurrent(scoped);
    let previous;
    if (expectedMarker === null) {
      if (current.status === 'ABSENT') {
        previous = initializeJournal(scoped, nextMarker.projectId);
      } else if (['BASE', 'VALUE'].includes(current.status) &&
          current.value?.state === 'IDLE' && current.value.projectId === nextMarker.projectId) {
        previous = current.value;
      } else {
        fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
      }
    } else {
      if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE' ||
          current.value.projectId !== nextMarker.projectId) {
        fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
      }
      const currentMarker = validateMarker(
        current.value.activeMarker,
        projectService,
        historyService
      );
      if (currentMarker.operationId !== expectedMarker.operationId ||
          currentMarker.integrity !== expectedMarker.integrity) {
        fail('CHANGES_RECOVERY_STALE', '恢复标记已被其他操作更新');
      }
      previous = current.value;
    }
    const nextValue = journalNextValue(previous, {
      state: 'ACTIVE',
      activeOperationId: nextMarker.operationId,
      activeKind: nextMarker.kind,
      activeMarker: nextMarker,
      activeMarkerDigest: markerJournalSchema.activeMarkerDigest(nextMarker),
      nativePublication: null,
      existingTerminalPublication: null,
      terminalCleanup: null,
      terminalCleanupDigest: null,
    });
    appendJournal(scoped, previous, nextValue, () => {
      if (typeof beforeMarkerRename === 'function') {
        beforeMarkerRename(markerLocation(rootPath, true, fileSystem));
      }
      if (typeof beforeExpectedAppend === 'function') beforeExpectedAppend();
      current = journalCurrent(scoped);
      if (!['BASE', 'VALUE'].includes(current.status) ||
          canonical(current.value) !== canonical(previous)) {
        fail('CHANGES_RECOVERY_STALE', 'marker journal changed before APPEND');
      }
    });
    return nextMarker;
  }

  function persist(
    rootPath,
    marker,
    expectedMarker = null,
    expectedAuthority = null,
    beforeExpectedRename = null
  ) {
    const next = sealValidatedMarker(markerPayload(marker), projectService, historyService);
    if (markerJournalLifecycle !== null &&
        ['apply', 'review', 'undo'].includes(next.kind)) {
      const scoped = markerJournalFor(rootPath, true);
      const current = journalCurrent(scoped);
      if (current.status !== 'LEGACY') {
        return persistOrdinaryJournal(
          rootPath,
          next,
          expectedMarker,
          beforeExpectedRename
        );
      }
    }
    const location = markerLocation(rootPath, true, fileSystem);
    if (expectedMarker === null && location.exists) {
      fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
    }
    if (expectedMarker !== null && !location.exists) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    const serialized = serializeMarker(next, projectService, historyService);
    atomicWriteMarker(location, serialized, fileSystem, () => {
      if (typeof beforeMarkerRename === 'function') beforeMarkerRename(location);
      if (typeof beforeExpectedRename === 'function') beforeExpectedRename();
      if (expectedAuthority) assertMarkerAuthority(expectedAuthority);
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
    if (!sealedTransaction || typeof sealedTransaction !== 'object' ||
        !KINDS.includes(sealedTransaction.kind)) {
      fail('CHANGES_RECOVERY_WRITE_FAILED', '待恢复事务无效');
    }
    const snapshotKind = ['snapshot_restore', 'snapshot_restore_undo']
      .includes(sealedTransaction.kind);
    let legacyJournal = markerJournalLifecycle === null;
    let snapshotJournal = null;
    let snapshotJournalCurrent = null;
    if (markerJournalLifecycle !== null) {
      const scoped = markerJournalFor(rootPath, true);
      const current = journalCurrent(scoped);
      legacyJournal = current.status === 'LEGACY';
      if (sealedTransaction.kind === 'snapshot_restore_undo' && !legacyJournal) {
        fail(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'Snapshot recovery is not yet journal-backed'
        );
      }
      if (sealedTransaction.kind === 'snapshot_restore' && !legacyJournal) {
        if (!((current.status === 'ABSENT') ||
            (['BASE', 'VALUE'].includes(current.status) && current.value?.state === 'IDLE'))) {
          fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
        }
        snapshotJournal = scoped;
        snapshotJournalCurrent = current;
      }
      if (!snapshotKind && !legacyJournal &&
          !((current.status === 'ABSENT') ||
            (['BASE', 'VALUE'].includes(current.status) && current.value?.state === 'IDLE'))) {
        fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
      }
    }
    const location = markerLocation(rootPath, true, fileSystem);
    if (legacyJournal && location.exists) {
      fail('CHANGES_RECOVERY_PENDING', '项目存在未完成的 Changes/History 恢复');
    }
    const timestamp = now();
    const operationId = `chr_${crypto.randomBytes(24).toString('hex')}`;
    recoveryArtifact.assertNoCleanupResidue(location.directory);
    if (!['snapshot_restore', 'snapshot_restore_undo'].includes(sealedTransaction.kind)) {
      let currentBase;
      try { currentBase = historyService.loadHistoryState(rootPath); }
      catch (error) { throw error; }
      if (!sameHistoryState(currentBase, sealedTransaction.baseHistoryState)) {
        fail('CHANGES_RECOVERY_STALE', 'Changes History changed during marker preparation');
      }
      const inlinePayload = {
        schema: RECOVERY_SCHEMA,
        operationId,
        projectId: project.projectId,
        kind: sealedTransaction.kind,
        state: 'applying',
        outcome: null,
        files: sealedTransaction.files,
        baseHistoryState: sealedTransaction.baseHistoryState,
        preparedHistoryState: sealedTransaction.preparedHistoryState,
        recoveryWritePending: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const candidate = sealValidatedMarker(inlinePayload, projectService, historyService);
      if (Buffer.byteLength(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8') > MAX_MARKER_BYTES) {
        fail(
          'ARTIFACT_CLEANUP_UNAVAILABLE',
          'large ordinary recovery requires native exact artifact cleanup'
        );
      }
      return persist(rootPath, inlinePayload);
    }
    const artifactLifecycle = artifactLifecycleFor(rootPath);
    if (!artifactLifecycle || typeof artifactLifecycle.cleanup !== 'function' ||
        typeof artifactLifecycle.rollback !== 'function') {
      fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'native exact artifact cleanup is unavailable');
    }
    const phaseBacked = sealedTransaction.historyTemplate !== undefined ||
      sealedTransaction.parentSelectionBinding !== undefined;
    let parentSelectionBinding = null;
    if (phaseBacked) {
      const restorePrecreate = sealedTransaction.kind === 'snapshot_restore' &&
        sealedTransaction.historyTemplate != null &&
        sealedTransaction.preparedHistoryState === null;
      const undoPrecreate = sealedTransaction.kind === 'snapshot_restore_undo' &&
        sealedTransaction.historyTemplate != null &&
        sealedTransaction.preparedHistoryState != null;
      if (!restorePrecreate && !undoPrecreate) {
        fail('CHANGES_RECOVERY_WRITE_FAILED', 'public Markdown PRECREATE transaction is invalid');
      }
      publicMarkdownLifecycleFor(
        rootPath,
        sealedTransaction.kind,
        sealedTransaction.kind === 'snapshot_restore' && snapshotJournal !== null
      );
      parentSelectionBinding = publicMarkdownPhaseSchema.assertParentSelectionBinding(
        sealedTransaction.parentSelectionBinding
      );
      assertTemplateSelectionBinding(
        sealedTransaction.historyTemplate,
        parentSelectionBinding,
        historyService
      );
    }
    const artifact = recoveryArtifact.writeSnapshotArtifact(
      location.directory,
      operationId,
      sealedTransaction.files,
      sealedTransaction.baseHistoryState,
      sealedTransaction.preparedHistoryState,
      historyService,
      artifactLifecycle,
      phaseBacked ? sealedTransaction.historyTemplate : null
    );
    let currentBase;
    try { currentBase = historyService.loadHistoryState(rootPath); }
    catch (error) {
      try {
        recoveryArtifact.rollbackArtifact(location.directory, artifact, artifactLifecycle);
      } catch (cleanupError) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'Snapshot artifact rollback requires reconciliation'
        );
        wrapped.cause = cleanupError;
        throw wrapped;
      }
      throw error;
    }
    if (!sameHistoryState(currentBase, sealedTransaction.baseHistoryState)) {
      try {
        recoveryArtifact.rollbackArtifact(location.directory, artifact, artifactLifecycle);
      } catch (cleanupError) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'Snapshot artifact rollback requires reconciliation'
        );
        wrapped.cause = cleanupError;
        throw wrapped;
      }
      fail('CHANGES_RECOVERY_STALE', 'Changes History changed during artifact preparation');
    }
    const publicMarkdownPhase = phaseBacked
      ? publicMarkdownPhaseSchema.assertPhaseRecord({
        schema: publicMarkdownPhaseSchema.SCHEMA,
        operationId,
        kind: sealedTransaction.kind,
        phase: 'PRECREATE',
        artifactDigest: artifact.sha256,
        selectionDigest: publicMarkdownPhaseSchema.digestSelection(parentSelectionBinding),
        items: parentSelectionBinding.selected
          .filter(item => item.action === (sealedTransaction.kind === 'snapshot_restore'
            ? 'MISSING'
            : 'CREATED'))
          .map(item => ({
            selectedId: item.selectedId,
            path: item.path,
            afterRevision: item.revision,
            ancestorIdentityDigest: item.ancestorIdentityDigest,
            createdIdentityDigest: sealedTransaction.kind === 'snapshot_restore'
              ? null
              : sealedTransaction.files.find(file => file.path === item.path)
                ?.createdIdentityDigest,
            creationReceiptDigest: null,
            quarantineReceiptDigest: null,
          })),
        preparedHistoryDigest: sealedTransaction.kind === 'snapshot_restore'
          ? null
          : `sha256:${compactHistoryBinding(
            sealedTransaction.preparedHistoryState,
            historyService
          ).digest}`,
        finalReceiptDigest: null,
        existingReceiptSetDigest: null,
        rollbackReceiptDigest: null,
        updatedAt: timestamp,
      }, parentSelectionBinding)
      : null;
    const payload = {
      schema: RECOVERY_SCHEMA,
      operationId,
      projectId: project.projectId,
      kind: sealedTransaction.kind,
      state: 'applying',
      outcome: null,
      files: compactSnapshotFiles(sealedTransaction.files),
      baseHistoryState: {
        exists: sealedTransaction.baseHistoryState.exists,
        digest: artifact.baseHistoryDigest,
      },
      preparedHistoryState: phaseBacked
        ? sealedTransaction.kind === 'snapshot_restore'
          ? null
          : compactHistoryBinding(sealedTransaction.preparedHistoryState, historyService)
        : {
          exists: sealedTransaction.preparedHistoryState.exists,
          digest: artifact.preparedHistoryDigest,
        },
      recoveryWritePending: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      artifact,
      ...(phaseBacked ? { parentSelectionBinding, publicMarkdownPhase } : {}),
    };
    if (snapshotJournal !== null) {
      const marker = sealValidatedMarker(payload, projectService, historyService);
      const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
      const nativeAuthority = nativeCreateAuthority(marker, verified);
      const nativePublication = publicMarkdownNativeSchema.buildPreparedCreatePublication(
        nativeAuthority
      );
      let previous;
      if (snapshotJournalCurrent.status === 'ABSENT') {
        previous = initializeJournal(snapshotJournal, project.projectId);
      } else {
        previous = snapshotJournalCurrent.value;
      }
      if (!previous || previous.state !== 'IDLE' || previous.projectId !== project.projectId) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot journal IDLE authority drifted');
      }
      const activeMarkerValue = journalNextValue(previous, {
        state: 'ACTIVE',
        activeOperationId: marker.operationId,
        activeKind: marker.kind,
        activeMarker: marker,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(marker),
        nativePublication: null,
        existingTerminalPublication: null,
        terminalCleanup: null,
        terminalCleanupDigest: null,
      });
      const markerAppend = appendSnapshotPreparedJournal(
        snapshotJournal,
        previous,
        activeMarkerValue
      );
      if (markerAppend === 'UNCOMMITTED') {
        try {
          recoveryArtifact.rollbackArtifact(location.directory, artifact, artifactLifecycle);
        } catch (cleanupError) {
          const wrapped = new ChangesHistoryRecoveryError(
            'CHANGES_MANUAL_RECOVERY_REQUIRED',
            'Snapshot artifact rollback requires reconciliation'
          );
          wrapped.cause = cleanupError;
          throw wrapped;
        }
        fail('CHANGES_RECOVERY_WRITE_FAILED', 'Snapshot journal APPEND was not committed');
      }
      assertSnapshotPrepareAuthority(rootPath, marker);
      const preparedValue = journalNextValue(activeMarkerValue, { nativePublication });
      const publicationAppend = appendSnapshotPreparedJournal(
        snapshotJournal,
        activeMarkerValue,
        preparedValue
      );
      if (publicationAppend === 'UNCOMMITTED') {
        fail(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'Snapshot PREPARED publication was not committed'
        );
      }
      assertSnapshotPrepareAuthority(rootPath, marker);
      return marker;
    }
    try {
      return persist(rootPath, payload);
    } catch (error) {
      try {
        recoveryArtifact.rollbackArtifact(location.directory, artifact, artifactLifecycle);
      } catch (cleanupError) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_MANUAL_RECOVERY_REQUIRED',
          'Snapshot artifact rollback requires reconciliation'
        );
        wrapped.cause = cleanupError;
        throw wrapped;
      }
      throw error;
    }
  }

  function currentHistoryBinding(rootPath) {
    const file = path.join(rootPath, historyService.HISTORY_RELATIVE_PATH);
    let fd;
    try { fd = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
    catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, digest: sha256(Buffer.from([0])) };
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Changes History authority path 无效');
    }
    const stat = fileSystem.fstatSync(fd, { bigint: true });
    if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink !== 1n ||
        stat.size > BigInt(historyService.MAX_HISTORY_BYTES)) {
      fileSystem.closeSync(fd);
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Changes History authority 无效');
    }
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from([1]));
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    try {
      let offset = 0n;
      while (offset < stat.size) {
        const remaining = stat.size - offset;
        const size = Number(remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining);
        const count = fileSystem.readSync(fd, chunk, 0, size, Number(offset));
        if (count <= 0) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Changes History authority 截断');
        hash.update(chunk.subarray(0, count));
        offset += BigInt(count);
      }
      const after = fileSystem.fstatSync(fd, { bigint: true });
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
          after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || after.nlink !== 1n) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Changes History authority changed during read');
      }
    } finally { fileSystem.closeSync(fd); }
    return { exists: true, digest: hash.digest('hex') };
  }

  function existingLifecycleFor(rootPath) {
    const method = (raw, name) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
          Object.getPrototypeOf(raw) !== Object.prototype) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, name);
      return descriptor && descriptor.enumerable === true &&
        Object.hasOwn(descriptor, 'value') && !descriptor.get && !descriptor.set &&
        typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
    };
    const factory = method(existingRestoreLifecycle, 'forProject');
    const rawScoped = factory ? factory(rootPath) : existingRestoreLifecycle;
    const scopedDescriptor = rawScoped && Object.getOwnPropertyDescriptor(
      rawScoped,
      'existingRestore'
    );
    const scoped = scopedDescriptor && scopedDescriptor.enumerable === true &&
      Object.hasOwn(scopedDescriptor, 'value')
      ? scopedDescriptor.value
      : rawScoped;
    const execute = method(scoped, 'execute');
    if (execute === null) {
      fail('SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE',
        'formal existing Markdown lifecycle is unavailable');
    }
    return Object.freeze({ execute });
  }

  function identityFromStat(stat, contentSha256) {
    return evidenceDeliverySchema.assertObjectIdentity({
      schema: evidenceDeliverySchema.SCHEMAS.OBJECT_IDENTITY,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
      nlink: Number(stat.nlink),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      contentSha256,
    });
  }

  function readExactLeaf(rootPath, binding) {
    const file = path.join(rootPath, binding.path);
    let fd;
    try {
      fd = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fileSystem.fstatSync(fd, { bigint: true });
      if ((stat.mode & 0o170000n) !== 0o100000n || stat.nlink !== 1n ||
          stat.size !== BigInt(binding.byteLength)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING public leaf identity is invalid');
      }
      const bytes = fileSystem.readFileSync(fd);
      const after = fileSystem.fstatSync(fd, { bigint: true });
      if (!sameMarkerIdentity(stat, after)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING public leaf changed during read');
      }
      const contentSha256 = evidenceDeliverySchema.sha256(bytes);
      if (contentSha256 !== binding.contentDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING public leaf revision is foreign');
      }
      const identity = existingRestoreSchema.buildExistingLeafIdentity(binding, {
        dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
        mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink),
        size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(), contentSha256,
      });
      return Object.freeze({ identity, digest: existingRestoreSchema.digestExistingLeafIdentity(
        identity,
        binding
      ) });
    } finally {
      if (fd !== undefined) try { fileSystem.closeSync(fd); } catch (_) {}
    }
  }

  function withExistingJournalBinding(rootPath, value, callback) {
    const location = markerLocation(rootPath, false, fileSystem);
    const journalPath = path.join(location.directory, markerJournalSchema.JOURNAL_BASENAME);
    let rootFd;
    let recoveryFd;
    let journalFd;
    try {
      rootFd = fileSystem.openSync(location.root,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      recoveryFd = fileSystem.openSync(location.directory,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
      journalFd = fileSystem.openSync(journalPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const rootStat = fileSystem.fstatSync(rootFd, { bigint: true });
      const recoveryStat = fileSystem.fstatSync(recoveryFd, { bigint: true });
      const journalStat = fileSystem.fstatSync(journalFd, { bigint: true });
      if ((rootStat.mode & 0o170000n) !== 0o040000n ||
          (recoveryStat.mode & 0o170000n) !== 0o040000n ||
          (journalStat.mode & 0o170000n) !== 0o100000n || journalStat.nlink !== 1n ||
          Number(journalStat.uid) !== process.geteuid() ||
          Number(journalStat.mode & 0o777n) !== 0o600) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING journal descriptor is unsafe');
      }
      const journalBytes = fileSystem.readFileSync(journalFd);
      const journalAfter = fileSystem.fstatSync(journalFd, { bigint: true });
      if (!sameMarkerIdentity(journalStat, journalAfter)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING journal changed during binding');
      }
      const slot = BigInt(value.generation) % 2n === 0n ? 'A' : 'B';
      const frame = markerJournalSchema.encodeSlotFrame(value, slot);
      const slotOffset = markerJournalSchema.SLOT_OFFSETS[slot];
      if (!journalBytes.subarray(slotOffset, slotOffset + frame.length).equals(frame)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING journal frame is not current');
      }
      const payloadOffset = frame.indexOf(0x0a) + 1;
      const payload = frame.subarray(payloadOffset);
      const markerBytes = Buffer.from(
        evidenceDeliverySchema.canonicalJson(value.activeMarker),
        'utf8'
      );
      const activeMarkerOffset = frame.indexOf(markerBytes, payloadOffset);
      if (payloadOffset < 1 || activeMarkerOffset < payloadOffset) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'EXISTING marker slice is unavailable');
      }
      const rootIdentityDigest = evidenceDeliverySchema.digestRootIdentity(
        rootIdentityFromStat(rootStat)
      );
      const recoveryDirectoryIdentityDigest = evidenceDeliverySchema.digestRootIdentity(
        rootIdentityFromStat(recoveryStat)
      );
      const binding = existingJournalBindingSchema.buildExistingJournalBinding({
        schema: existingJournalBindingSchema.SCHEMA,
        journalBasename: existingJournalBindingSchema.JOURNAL_BASENAME,
        journalMagic: existingJournalBindingSchema.JOURNAL_MAGIC,
        journalFileIdentity: identityFromStat(
          journalStat,
          evidenceDeliverySchema.sha256(journalBytes)
        ),
        rootIdentityDigest,
        recoveryDirectoryIdentityDigest,
        activeSlot: slot,
        head: markerJournalSchema.expectedHead(value),
        previousValueDigest: value.previousValueDigest,
        frameByteLength: frame.length,
        frameSha256: evidenceDeliverySchema.sha256(frame),
        payloadOffset,
        payloadByteLength: payload.length,
        payloadSha256: evidenceDeliverySchema.sha256(payload),
        activeMarkerOffset,
        activeMarkerByteLength: markerBytes.length,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(value.activeMarker),
        activeMarkerCanonicalSha256: evidenceDeliverySchema.sha256(markerBytes),
        bindingDigest: null,
      });
      return callback(Object.freeze({ binding, journalFd }));
    } finally {
      if (journalFd !== undefined) try { fileSystem.closeSync(journalFd); } catch (_) {}
      if (recoveryFd !== undefined) try { fileSystem.closeSync(recoveryFd); } catch (_) {}
      if (rootFd !== undefined) try { fileSystem.closeSync(rootFd); } catch (_) {}
    }
  }

  function executeExistingRestore(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    const scopedJournal = markerJournalFor(rootPath, true);
    const current = journalCurrent(scopedJournal);
    if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE' ||
        current.value.projectId !== projectId ||
        current.value.activeOperationId !== operationId ||
        current.value.activeKind !== 'snapshot_restore' ||
        current.value.existingTerminalPublication !== null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'EXISTING journal authority is unavailable');
    }
    const value = current.value;
    const marker = validateMarker(value.activeMarker, projectService, historyService);
    if (marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.kind !== 'snapshot_restore' ||
        marker.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT') {
      fail('CHANGES_RECOVERY_CONFLICT', 'EXISTING execute requires CREATED_RECEIPT');
    }
    const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
    const baseHistory = captureHistoryAuthority(rootPath, marker.baseHistoryState);
    const lifecycle = existingLifecycleFor(rootPath);
    try {
      assertHistoryAuthority(baseHistory);
      const baseHistoryBytes = baseHistory.fd === null
        ? Buffer.alloc(0)
        : fileSystem.readFileSync(baseHistory.fd);
      const baseHistoryAuthority = existingRestoreSchema.buildBaseHistoryAuthority(
        baseHistoryBytes,
        marker.baseHistoryState.exists
      );
      const historyParentIdentityDigest = existingRestoreSchema.digestHistoryParentIdentity({
        dev: baseHistory.directoryStat.dev.toString(),
        ino: baseHistory.directoryStat.ino.toString(),
        uid: Number(baseHistory.directoryStat.uid),
        mode: Number(baseHistory.directoryStat.mode & 0o7777n),
      });
      const filesByPath = new Map(verified.artifactFiles.map(file => [file.path, file]));
      return withExistingJournalBinding(rootPath, value, ({ binding, journalFd }) =>
        withPublicMarkdownArtifactFd(
          markerLocation(rootPath, false, fileSystem).directory,
          marker,
          artifactFd => {
            const existingParentItems = marker.parentSelectionBinding.selected.filter(
              item => item.action === 'EXISTING'
            );
            const requestItems = existingParentItems.map(item => {
              const file = filesByPath.get(item.path);
              if (!file || !file.before.exists || !file.after.exists ||
                  file.before.revision === null ||
                  file.before.revision !== marker.files.find(entry => entry.path === item.path)?.beforeRevision ||
                  file.after.revision !== item.revision ||
                  !Number.isSafeInteger(file.before.offset) ||
                  !Number.isSafeInteger(file.after.offset)) {
                fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
                  'EXISTING artifact subset authority is incomplete');
              }
              const leafBinding = {
                selectedId: item.selectedId,
                path: item.path,
                revision: file.before.revision,
                ancestorIdentityDigest: item.ancestorIdentityDigest,
                byteLength: file.before.bytes.length,
                contentDigest: `sha256:${file.before.revision}`,
              };
              const beforeLeaf = readExactLeaf(rootPath, leafBinding);
              return Object.freeze({
                selectedId: item.selectedId,
                path: item.path,
                beforeRevision: file.before.revision,
                afterRevision: file.after.revision,
                beforeArtifactOffset: file.before.offset,
                beforeByteLength: file.before.bytes.length,
                beforeContentDigest: `sha256:${file.before.revision}`,
                afterArtifactOffset: file.after.offset,
                afterByteLength: file.after.bytes.length,
                afterContentDigest: `sha256:${file.after.revision}`,
                ancestorIdentityDigest: item.ancestorIdentityDigest,
                beforeLeafIdentityDigest: beforeLeaf.digest,
              });
            });
            const request = {
              schema: existingRestoreSchema.SCHEMAS.REQUEST,
              operationId,
              markerDigest: binding.activeMarkerDigest,
              artifactDigest: marker.artifact.sha256,
              artifactIdentityDigest: artifactIdentityDigest(marker),
              artifactByteLength: marker.artifact.byteLength,
              createdReceiptPhaseDigest: evidenceDeliverySchema.digestObject(
                publicMarkdownPhaseSchema.SCHEMA,
                marker.publicMarkdownPhase
              ),
              selectionDigest: marker.publicMarkdownPhase.selectionDigest,
              ...baseHistoryAuthority,
              historyParentIdentityDigest,
              journalMarkerBinding: binding,
              items: requestItems,
            };
            const markerAuthority = {
              schema: existingRestoreSchema.SCHEMAS.MARKER_AUTHORITY,
              operationId,
              markerDigest: request.markerDigest,
              artifactDigest: request.artifactDigest,
              artifactIdentityDigest: request.artifactIdentityDigest,
              artifactByteLength: request.artifactByteLength,
              baseHistoryDigest: request.baseHistoryDigest,
              baseHistoryByteLength: request.baseHistoryByteLength,
              baseHistoryExists: request.baseHistoryExists,
              baseHistoryContentDigest: request.baseHistoryContentDigest,
              historyParentIdentityDigest,
            };
            const authority = existingRestoreSchema.buildAuthority(
              markerAuthority,
              marker.parentSelectionBinding,
              marker.publicMarkdownPhase,
              request
            );
            const descriptors = Object.freeze({
              artifactFd,
              journalFd,
              historyParentFd: baseHistory.directoryFd,
              historyFd: baseHistory.fd === null ? baseHistory.directoryFd : baseHistory.fd,
            });
            const result = existingRestoreSchema.assertRunResult(
              lifecycle.execute(authority, descriptors),
              authority,
              existingRestoreSchema.COMMANDS.EXECUTE
            );
            if (result.state !== 'COMMITTED' || result.terminalReceipt === null) {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
                'EXISTING execute is not durably committed');
            }
            const terminal = result.terminalReceipt;
            const terminalItems = terminal.items.map((terminalItem, index) => {
              const source = authority.request.items[index];
              const finalLeaf = readExactLeaf(rootPath, {
                selectedId: source.selectedId,
                path: source.path,
                revision: source.afterRevision,
                ancestorIdentityDigest: source.ancestorIdentityDigest,
                byteLength: source.afterByteLength,
                contentDigest: source.afterContentDigest,
              });
              if (finalLeaf.digest !== terminalItem.finalLeafIdentityDigest) {
                fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
                  'EXISTING terminal leaf identity is foreign');
              }
              return Object.freeze({
                schema: markerJournalSchema.SCHEMAS.EXISTING_TERMINAL_ITEM,
                ordinal: index,
                selectedId: source.selectedId,
                finalContentDigest: source.afterContentDigest,
                finalLeafIdentity: finalLeaf.identity,
                controlBasename: terminalItem.applyToken.controlBasename,
                controlDigest: terminalItem.applyToken.controlDigest,
                controlRecordIdentity: terminalItem.applyToken.controlRecordIdentity,
                applyBasename: terminalItem.applyToken.receiptBasename,
                applyReceiptDigest: terminalItem.applyToken.applyReceiptDigest,
                applyRecordIdentity: terminalItem.applyToken.receiptRecordIdentity,
              });
            });
            const nextPhase = publicMarkdownPhaseSchema.assertTransition(
              marker.publicMarkdownPhase,
              {
                ...marker.publicMarkdownPhase,
                phase: 'EXISTING_COMMITTED',
                existingReceiptSetDigest: terminal.receiptSetDigest,
                updatedAt: now(),
              },
              marker.parentSelectionBinding
            );
            const nextMarker = journalMarker(marker, {
              publicMarkdownPhase: nextPhase,
              updatedAt: nextPhase.updatedAt,
            });
            const publication = {
              schema: markerJournalSchema.SCHEMAS.EXISTING_TERMINAL_PUBLICATION,
              command: 'EXECUTE_EXISTING',
              state: 'COMMITTED',
              operationId,
              requestDigest: existingRestoreSchema.requestDigest(authority),
              createdReceiptPhaseDigest: request.createdReceiptPhaseDigest,
              markerDigest: request.markerDigest,
              artifactDigest: request.artifactDigest,
              artifactIdentityDigest: request.artifactIdentityDigest,
              selectionDigest: request.selectionDigest,
              baseHistoryDigest: request.baseHistoryDigest,
              baseHistoryByteLength: request.baseHistoryByteLength,
              baseHistoryExists: request.baseHistoryExists,
              baseHistoryContentDigest: request.baseHistoryContentDigest,
              historyParentIdentityDigest,
              projectRootIdentityDigest: binding.rootIdentityDigest,
              recoveryDirectoryIdentityDigest: binding.recoveryDirectoryIdentityDigest,
              predecessorValueDigest: value.valueDigest,
              installedGeneration: markerJournalSchema.nextGeneration(value.generation),
              items: Object.freeze(terminalItems),
              receiptSetDigest: terminal.receiptSetDigest,
              terminalReceiptDigest: terminal.terminalReceiptDigest,
              recoveryFsyncComplete: true,
              finalization: null,
              publicationDigest: null,
            };
            publication.publicationDigest = markerJournalSchema.existingTerminalPublicationDigest(
              publication
            );
            const storedPublication = markerJournalSchema.assertExistingTerminalPublication(
              publication
            );
            const nextValue = journalNextValue(value, {
              activeMarker: nextMarker,
              activeMarkerDigest: markerJournalSchema.activeMarkerDigest(nextMarker),
              existingTerminalPublication: storedPublication,
            });
            const appendState = appendSnapshotPreparedJournal(
              scopedJournal,
              value,
              nextValue,
              () => {
                assertHistoryAuthority(baseHistory);
                const latest = journalCurrent(scopedJournal);
                if (latest.status !== 'VALUE' || canonical(latest.value) !== canonical(value)) {
                  fail('CHANGES_RECOVERY_STALE',
                    'EXISTING journal changed before terminal CAS');
                }
              }
            );
            if (appendState !== 'COMMITTED') {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
                'EXISTING terminal CAS is uncommitted after execute');
            }
            return nextMarker;
          }
        ));
    } catch (error) {
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_MANUAL_RECOVERY_REQUIRED',
        'EXISTING execute authority cannot be completed'
      );
      wrapped.cause = error;
      throw wrapped;
    } finally {
      closeHistoryAuthority(baseHistory);
    }
  }

  function authoritativeState(rootPath, marker) {
    const snapshotKind = ['snapshot_restore', 'snapshot_restore_undo'].includes(marker.kind);
    if (marker.artifact) {
      const fileStates = [];
      let artifactHistory;
      try {
        const location = markerLocation(rootPath, false, fileSystem);
        artifactHistory = recoveryArtifact.inspectSnapshotArtifact(
          location.directory,
          marker.artifact,
          (artifactFile, index, count) => {
            const file = marker.files[index];
            if (!file || count !== marker.files.length || artifactFile.path !== file.path ||
                artifactFile.before.exists !== file.beforeExists ||
                artifactFile.before.revision !== file.beforeRevision ||
                artifactFile.after.exists !== file.afterExists ||
                artifactFile.after.revision !== file.afterRevision ||
                artifactFile.createdIdentityDigest !== file.createdIdentityDigest) {
              fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot artifact/control binding 不一致');
            }
            let current;
            try {
              if (snapshotKind && snapshotStateReader) {
                current = snapshotStateReader({
                  rootPath,
                  projectId: marker.projectId,
                  kind: marker.kind,
                  path: file.path,
                  createdIdentityDigest: file.createdIdentityDigest,
                });
              } else {
                try {
                  const read = projectService.readFileWithRevision(rootPath, file.path);
                  current = {
                    exists: true,
                    revision: read.revision,
                    bytes: Buffer.from(read.content, 'utf8'),
                    createdIdentityDigest: null,
                  };
                } catch (error) {
                  if (['ENOENT', 'FILE_NOT_FOUND', 'INVALID_PATH'].includes(error?.code)) current = { exists: false };
                  else throw error;
                }
              }
            } catch (_) {
              fileStates.push('foreign');
              return;
            }
            const matches = expected => {
              if (!expected.exists) return current?.exists === false;
              if (!current || current.exists !== true) return false;
              const bytes = Buffer.isBuffer(current.bytes)
                ? current.bytes
                : typeof current.content === 'string' ? Buffer.from(current.content, 'utf8') : null;
              if (!bytes || current.revision !== expected.revision ||
                  !bytes.equals(expected.bytes)) return false;
              if (file.createdIdentityDigest !== null &&
                  current.createdIdentityDigest !== file.createdIdentityDigest) return false;
              return true;
            };
            fileStates.push(matches(artifactFile.before)
              ? 'before'
              : matches(artifactFile.after) ? 'after' : 'foreign');
          }
        );
      } catch (_) {
        return { fileStates: marker.files.map(() => 'foreign'), history: 'foreign' };
      }
      if (artifactHistory.baseHistory.digest !== marker.artifact.baseHistoryDigest) {
        return { fileStates: marker.files.map(() => 'foreign'), history: 'foreign' };
      }
      let currentHistory;
      try { currentHistory = currentHistoryBinding(rootPath); } catch (_) { currentHistory = null; }
      const history = currentHistory === null
        ? 'foreign'
        : currentHistory.exists === marker.baseHistoryState.exists &&
            currentHistory.digest === marker.baseHistoryState.digest
          ? 'base'
          : currentHistory.exists === marker.preparedHistoryState.exists &&
              currentHistory.digest === marker.preparedHistoryState.digest
            ? 'prepared'
            : 'foreign';
      return { fileStates, history };
    }
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
      return ['apply', 'snapshot_restore'].includes(marker.kind)
        ? 'applied'
        : marker.kind === 'review' ? 'reviewed' : 'undone';
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
    // public Markdown phases are reconciled only through their native receipt
    // state machine. Generic byte/History classification must not collapse a
    // durable PRECREATE marker into an ordinary terminal outcome.
    if (marker.publicMarkdownPhase) {
      if (marker.kind === 'snapshot_restore' &&
          marker.publicMarkdownPhase.phase === 'FINALIZED') {
        if (markerJournalLifecycle !== null) {
          const current = journalCurrent(markerJournalFor(rootPath, true));
          if (current.status !== 'LEGACY') {
            return reconcileSnapshotJournalFinalization(rootPath, marker, false);
          }
        }
        return terminalizeFinalizedMarker(rootPath, marker);
      }
      if (marker.kind === 'snapshot_restore_undo' &&
          marker.publicMarkdownPhase.phase === 'RESTORED') {
        return terminalizeRestoredUndoMarker(rootPath, marker);
      }
      if (marker.kind === 'snapshot_restore_undo' &&
          marker.publicMarkdownPhase.phase === 'FINALIZED') {
        return terminalizeFinalizedUndoMarker(rootPath, marker);
      }
      if (marker.state !== 'applying') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'non-final public Markdown marker is terminal');
      }
      if (marker.kind === 'snapshot_restore' &&
          marker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED') {
        const finalized = reconcilePublicMarkdownFinalize(rootPath, marker, false);
        if (finalized.publicMarkdownPhase.phase !== 'FINALIZED') return finalized;
        if (markerJournalLifecycle !== null) {
          const current = journalCurrent(markerJournalFor(rootPath, true));
          if (current.status !== 'LEGACY') return finalized;
        }
        return terminalizeFinalizedMarker(rootPath, finalized);
      }
      if (marker.kind === 'snapshot_restore' &&
          marker.publicMarkdownPhase.phase === 'CREATED_RECEIPT') {
        const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
        const materialized = materializePreparedHistory(marker, verified);
        const current = currentHistoryBinding(rootPath);
        if (current.exists === marker.preparedHistoryState.exists &&
            current.digest === materialized.digest) {
          return commitMissingRestoreHistory(
            rootPath,
            marker.projectId,
            marker.operationId
          );
        }
        if (current.exists === marker.baseHistoryState.exists &&
            current.digest === marker.baseHistoryState.digest) {
          return marker;
        }
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'CREATED_RECEIPT History authority is foreign');
      }
      if (marker.kind === 'snapshot_restore_undo') {
        if (marker.publicMarkdownPhase.phase === 'PRECREATE') {
          return reconcilePublicMarkdownUndoQuarantine(rootPath, marker, false);
        }
        if (marker.publicMarkdownPhase.phase === 'QUARANTINED') {
          if (marker.publicMarkdownUndoSettlement !== undefined) {
            return reconcilePublicMarkdownUndoQuarantine(rootPath, marker, false);
          }
          const current = currentHistoryBinding(rootPath);
          if (current.exists === marker.preparedHistoryState.exists &&
              current.digest === marker.preparedHistoryState.digest) {
            return commitSnapshotRestoreUndoHistory(
              rootPath,
              marker.projectId,
              marker.operationId
            );
          }
          if (current.exists === marker.baseHistoryState.exists &&
              current.digest === marker.baseHistoryState.digest) {
            return reconcilePublicMarkdownUndoQuarantine(rootPath, marker, false);
          }
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo History authority is foreign');
        }
        if (marker.publicMarkdownPhase.phase === 'HISTORY_COMMITTED') {
          if (marker.publicMarkdownUndoSettlement !== undefined) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
              'Safe Undo HISTORY_COMMITTED cannot carry B settlement authority');
          }
          const verified = verifyPublicMarkdownPhaseArtifact(rootPath, marker);
          const materialized = materializeSnapshotRestoreUndoHistory(marker, verified);
          const current = currentHistoryBinding(rootPath);
          if (current.exists !== true ||
              current.digest !== materialized.preparedHistoryDigest) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
              'Safe Undo HISTORY_COMMITTED History authority is foreign');
          }
          const durableMarker = acknowledgePublicMarkdownMarkerDurability(
            rootPath,
            marker,
            'HISTORY_COMMITTED'
          );
          if (durableMarker.publicMarkdownUndoFinalization !== undefined) {
            const finalized = reconcilePublicMarkdownUndoFinalize(rootPath, durableMarker);
            return terminalizeFinalizedUndoMarker(rootPath, finalized);
          }
          return durableMarker;
        }
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Safe Undo phase is not yet continuable');
      }
      return marker.kind === 'snapshot_restore'
        ? reconcilePublicMarkdownCreate(rootPath, marker, false)
        : (verifyPublicMarkdownPhaseArtifact(rootPath, marker), marker);
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
    const exactPublicTerminal = marker.state === 'terminal' && (
      (marker.kind === 'snapshot_restore' &&
        marker.publicMarkdownPhase?.phase === 'FINALIZED') ||
      (marker.kind === 'snapshot_restore_undo' && marker.outcome === 'zero_write_error' &&
        marker.publicMarkdownPhase?.phase === 'RESTORED') ||
      (marker.kind === 'snapshot_restore_undo' && marker.outcome === 'undone' &&
        marker.publicMarkdownPhase?.phase === 'FINALIZED')
    );
    if (exactPublicTerminal) {
      markerLifecycleFor(rootPath);
      const lifecycle = artifactLifecycleFor(rootPath);
      if (lifecycle && typeof lifecycle.reconcile === 'function' &&
          typeof lifecycle.verify === 'function' &&
          typeof lifecycle.acknowledge === 'function') {
        if (marker.artifactCleanup) {
          clear(rootPath, project.projectId, marker.operationId);
          return { ok: true, recovery: null };
        }
        const rawCleanupToken = lifecycle.reconcile(marker.artifact);
        const cleanupToken = rawCleanupToken
          ? verifiedArtifactCleanupToken(lifecycle, marker, rawCleanupToken)
          : null;
        if (cleanupToken) {
          clear(rootPath, project.projectId, marker.operationId);
          return { ok: true, recovery: null };
        }
      }
    }
    const classified = classify(rootPath, marker.operationId, project.projectId);
    if (classified?.state === 'terminal' &&
        classified.kind === 'snapshot_restore_undo' &&
        ((classified.outcome === 'zero_write_error' &&
          classified.publicMarkdownPhase?.phase === 'RESTORED') ||
         (classified.outcome === 'undone' &&
          classified.publicMarkdownPhase?.phase === 'FINALIZED'))) {
      clear(rootPath, project.projectId, classified.operationId);
      return { ok: true, recovery: null };
    }
    return { ok: true, recovery: publicMarker(classified) };
  }

  function finish(rootPath, operationId) {
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    return classify(rootPath, operationId, marker.projectId);
  }

  function materializeArtifactAuthority(rootPath, marker) {
    const location = markerLocation(rootPath, false, fileSystem);
    const files = [];
    const artifact = recoveryArtifact.inspectSnapshotArtifact(
      location.directory,
      marker.artifact,
      file => files.push(file),
      { includeHistory: true }
    );
    const parseHistory = (item, label) => {
      if (!item.exists) return historyService.validateHistory({ schema: historyService.HISTORY_SCHEMA, entries: [] });
      let raw;
      try { raw = JSON.parse(item.bytes.toString('utf8')); }
      catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} artifact History 损坏`); }
      return historyService.validateHistory(raw);
    };
    const baseHistory = parseHistory(artifact.baseHistory, 'base');
    let delta;
    try { delta = JSON.parse(artifact.preparedDelta.bytes.toString('utf8')); }
    catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'prepared History delta 损坏'); }
    exactKeys(delta, ['schema', 'entries'], 'prepared History delta');
    if (delta.schema !== 'writcraft.changes-history-recovery-delta/v1' ||
        !Array.isArray(delta.entries) || delta.entries.length > historyService.MAX_HISTORY_ENTRIES) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'prepared History delta 无效');
    }
    const baseById = new Map(baseHistory.entries.map(entry => [entry.id, entry]));
    const filesByPath = new Map(files.map(file => [file.path, file]));
    const injectEntry = encoded => {
      if (encoded.kind !== 'application') return encoded;
      return {
        ...encoded,
        files: encoded.files.map(file => {
          const artifactFile = filesByPath.get(file.path);
          if (!artifactFile) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'delta file 缺少 artifact bytes');
          const injectState = state => {
            if (state.exists === false) return state;
            const source = [artifactFile.before, artifactFile.after].find(candidate =>
              candidate.exists && candidate.revision === state.revision);
            if (!source) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'delta state revision 缺少 artifact bytes');
            return {
              ...state,
              data: state.encoding === 'base64'
                ? source.bytes.toString('base64')
                : source.bytes.toString('utf8'),
            };
          };
          return { ...file, before: injectState(file.before), after: injectState(file.after) };
        }),
      };
    };
    const preparedEntries = delta.entries.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `delta.entries[${index}] 无效`);
      }
      if (item.kind === 'base') {
        exactKeys(item, ['kind', 'id'], `delta.entries[${index}]`);
        const base = baseById.get(item.id);
        if (!base) fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'delta base entry 不存在');
        return base;
      }
      exactKeys(item, ['kind', 'entry'], `delta.entries[${index}]`);
      if (item.kind !== 'delta') fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'delta entry kind 无效');
      return injectEntry(item.entry);
    });
    const preparedHistory = historyService.validateHistory({
      schema: historyService.HISTORY_SCHEMA,
      entries: preparedEntries,
    });
    const preparedBytes = artifact.preparedDelta.exists
      ? Buffer.from(`${JSON.stringify(preparedHistory, null, 2)}\n`, 'utf8')
      : Buffer.alloc(0);
    const preparedDigest = crypto.createHash('sha256')
      .update(Buffer.from([artifact.preparedDelta.exists ? 1 : 0]))
      .update(preparedBytes)
      .digest('hex');
    if (preparedDigest !== marker.artifact.preparedHistoryDigest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'prepared History delta digest 不一致');
    }
    return {
      files,
      baseHistoryState: { exists: artifact.baseHistory.exists, history: baseHistory },
      preparedHistoryState: { exists: artifact.preparedDelta.exists, history: preparedHistory },
    };
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
    if (['snapshot_restore', 'snapshot_restore_undo'].includes(marker.kind)) {
      fail(
        'SNAPSHOT_RESTORE_SAFE_RECOVERY_REQUIRED',
        'Snapshot 恢复必须通过 exact-identity quarantine 事务协调，不得按路径改写或删除'
      );
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
    let operationFiles = marker.files;
    let baseHistoryState = marker.baseHistoryState;
    let preparedHistoryState = marker.preparedHistoryState;
    if (marker.artifact) {
      const materialized = materializeArtifactAuthority(rootPath, marker);
      operationFiles = materialized.files;
      baseHistoryState = materialized.baseHistoryState;
      preparedHistoryState = materialized.preparedHistoryState;
    }
    const targetHistory = action === 'restore_before' ? baseHistoryState : preparedHistoryState;
    const expectedHistory = authority.history === 'base' ? baseHistoryState : preparedHistoryState;
    const lockedMarker = persist(rootPath, {
      ...markerPayload(marker),
      state: 'terminal',
      outcome: 'manual_recovery',
      recoveryWritePending: true,
      updatedAt: now(),
    }, marker);
    let writeError = null;
    try {
      for (let index = 0; index < operationFiles.length; index += 1) {
        const file = operationFiles[index];
        const state = authority.fileStates[index];
        const expected = file[state].revision;
        if (state !== targetField || lockedMarker.recoveryWritePending) {
          projectService.atomicWriteFile(
            rootPath,
            file.path,
            Buffer.isBuffer(file[targetField].bytes)
              ? file[targetField].bytes.toString('utf8')
              : file[targetField].content,
            expected
          );
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

  function cleanupAuthority(marker, token) {
    return validateArtifactCleanupAuthority({
      schema: ARTIFACT_CLEANUP_AUTHORITY_SCHEMA,
      operationId: marker.operationId,
      projectId: marker.projectId,
      artifactBasename: marker.artifact.basename,
      artifactByteLength: marker.artifact.byteLength,
      artifactDigest: marker.artifact.sha256,
      artifactIdentity: { ...marker.artifact.identity },
      token,
    }, marker, marker.artifact);
  }

  function persistCleanupAuthority(rootPath, marker, lifecycle, token) {
    const authority = captureMarkerAuthority(rootPath);
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity) {
        fail('CHANGES_RECOVERY_STALE', 'cleanup marker authority changed');
      }
      token = verifiedArtifactCleanupToken(lifecycle, marker, token);
      const artifactCleanup = cleanupAuthority(marker, token);
      return persist(rootPath, {
        ...markerPayload(marker),
        artifactCleanup,
        updatedAt: now(),
      }, marker, authority, () => {
        projectIdentity(projectService, rootPath, marker.projectId);
        assertMarkerAuthority(authority);
        verifiedArtifactCleanupToken(lifecycle, marker, token);
      });
    } finally { try { fileSystem.closeSync(authority.fd); } catch (_) {} }
  }

  function markerIdentityRecord(stat) {
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

  function exactClearFinalizedMarker(rootPath, marker, lifecycle) {
    const authority = captureMarkerAuthority(rootPath);
    try {
      if (authority.marker.operationId !== marker.operationId ||
          authority.marker.integrity !== marker.integrity ||
          canonical(authority.marker.artifactCleanup) !== canonical(marker.artifactCleanup)) {
        fail('CHANGES_RECOVERY_STALE', 'exact marker clear authority changed');
      }
      if (typeof beforeClear === 'function') beforeClear(authority.location);
      projectIdentity(projectService, rootPath, marker.projectId);
      assertMarkerAuthority(authority);
      lifecycle.clear(Object.freeze({
        operationId: marker.operationId,
        projectId: marker.projectId,
        directory: authority.location.directory,
        basename: path.basename(authority.location.file),
        heldFd: authority.fd,
        identity: markerIdentityRecord(authority.stat),
        rawDigest: `sha256:${authority.digest}`,
      }));
      if (markerLocation(rootPath, false, fileSystem).exists) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'exact marker clear did not remove marker');
      }
      return authority.location;
    } finally { try { fileSystem.closeSync(authority.fd); } catch (_) {} }
  }

  function republishCleanupMarker(location, serialized) {
    if (markerLocation(location.root, true, fileSystem).exists) {
      fail('CHANGES_RECOVERY_PENDING', 'foreign marker appeared during exact clear');
    }
    atomicWriteMarker(location, serialized, fileSystem, () => {
      if (markerLocation(location.root, true, fileSystem).exists) {
        fail('CHANGES_RECOVERY_PENDING', 'foreign marker appeared during retry publication');
      }
    }, true);
  }

  function clearFinalized(rootPath, marker) {
    // This descriptor-safe gate is deliberately the first operation in the
    // clear path. Missing/partial/accessor adapters fail while both marker and
    // artifact retain their exact bytes and identities; no cleanup reconcile
    // is allowed to run before it.
    const markerLifecycle = markerLifecycleFor(rootPath);
    const artifactLifecycle = artifactLifecycleFor(rootPath);
    if (!artifactLifecycle || typeof artifactLifecycle.reconcile !== 'function' ||
        typeof artifactLifecycle.verify !== 'function' ||
        typeof artifactLifecycle.acknowledge !== 'function') {
      fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'durable artifact cleanup lifecycle is unavailable');
    }
    if (marker.artifactCleanup) {
      const token = marker.artifactCleanup.token;
      // This is the ACK-response-loss retry branch. The persisted token is the
      // exact idempotency authority even after ACK removed its source records.
      artifactLifecycle.acknowledge(marker.artifact.basename, token);
      exactClearFinalizedMarker(rootPath, marker, markerLifecycle);
      return { ok: true, operationId: marker.operationId };
    }
    let token = artifactLifecycle.reconcile(marker.artifact);
    if (token) token = verifiedArtifactCleanupToken(artifactLifecycle, marker, token);
    if (!token) {
      // Validate terminal author/file/History truth while the exact artifact
      // still exists. No truthy unverified token may bypass this boundary.
      marker = classify(rootPath, marker.operationId, marker.projectId);
      const location = markerLocation(rootPath, false, fileSystem);
      try {
        token = recoveryArtifact.removeArtifact(
          location.directory,
          marker.artifact,
          artifactLifecycle
        );
      } catch (error) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_RECOVERY_WRITE_FAILED',
          'Snapshot artifact cleanup requires reconciliation'
        );
        wrapped.cause = error;
        throw wrapped;
      }
      token = verifiedArtifactCleanupToken(artifactLifecycle, marker, token);
    }
    marker = persistCleanupAuthority(rootPath, marker, artifactLifecycle, token);
    const location = markerLocation(rootPath, false, fileSystem);
    const serialized = fileSystem.readFileSync(location.file, 'utf8');
    try {
      exactClearFinalizedMarker(rootPath, marker, markerLifecycle);
    } catch (error) {
      if (!markerLocation(rootPath, false, fileSystem).exists) {
        republishCleanupMarker(location, serialized);
      }
      if (error instanceof ChangesHistoryRecoveryError) throw error;
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        'exact marker cleanup requires reconciliation'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    try {
      artifactLifecycle.acknowledge(marker.artifact.basename, token);
    } catch (error) {
      if (!markerLocation(rootPath, false, fileSystem).exists) {
        republishCleanupMarker(location, serialized);
      }
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        'Snapshot artifact cleanup receipt requires reconciliation'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    return { ok: true, operationId: marker.operationId };
  }

  function clearOrdinaryJournal(rootPath, projectId, operationId, initialCurrent) {
    const scoped = markerJournalFor(rootPath, true);
    let current = initialCurrent || journalCurrent(scoped);
    if (current.status !== 'VALUE' || current.value?.state !== 'ACTIVE') {
      const pair = discoverJournalPair(scoped);
      if (pair.current.state !== 'IDLE' || pair.older.state !== 'ACTIVE' ||
          pair.older.terminalCleanup === null) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'ordinary terminal journal truth is unavailable');
      }
      const marker = validateMarker(
        pair.older.activeMarker,
        projectService,
        historyService
      );
      const cleanup = markerJournalSchema.assertTerminalCleanup(pair.older.terminalCleanup);
      if (marker.operationId !== operationId || marker.projectId !== projectId ||
          !['apply', 'review', 'undo'].includes(marker.kind) ||
          !SAFE_CLEAR_OUTCOMES.has(marker.outcome) || marker.state !== 'terminal' ||
          cleanup.operationId !== marker.operationId || cleanup.kind !== marker.kind ||
          cleanup.publicationState !== 'NONE' ||
          cleanup.historyStateDigest !== historyService.digestHistoryState(
            historyService.loadHistoryState(rootPath)
          )) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'ordinary terminal retry authority is foreign');
      }
      return { ok: true, operationId };
    }
    let marker = validateMarker(current.value.activeMarker, projectService, historyService);
    if (marker.operationId !== operationId || marker.projectId !== projectId ||
        !['apply', 'review', 'undo'].includes(marker.kind)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'ordinary terminal operation was superseded');
    }
    if (marker.state !== 'terminal') marker = classify(rootPath, operationId, projectId);
    if (!marker || marker.state !== 'terminal' || !SAFE_CLEAR_OUTCOMES.has(marker.outcome)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复尚未达到可清理状态');
    }
    const expectedHistory = marker.outcome === 'zero_write_error'
      ? marker.baseHistoryState
      : marker.preparedHistoryState;
    const currentHistory = historyService.loadHistoryState(rootPath);
    if (!sameHistoryState(currentHistory, expectedHistory)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'ordinary terminal History truth is foreign');
    }
    const historyStateDigest = historyService.digestHistoryState(currentHistory);
    const cleanup = markerJournalSchema.buildTerminalCleanup({
      schema: markerJournalSchema.SCHEMAS.CLEANUP,
      operationId: marker.operationId,
      kind: marker.kind,
      terminalPhaseDigest: null,
      historyStateDigest,
      artifactCleanupDigest: null,
      publicRecordDigests: [],
      publicationState: 'NONE',
      publicationDigest: null,
      existingTerminalPublicationState: 'NONE',
      existingTerminalPublicationDigest: null,
      recoveryDirectoryFsyncComplete: true,
    });
    current = journalCurrent(scoped);
    if (current.status !== 'VALUE' || current.value.state !== 'ACTIVE' ||
        current.value.activeOperationId !== marker.operationId ||
        current.value.activeMarkerDigest !== markerJournalSchema.activeMarkerDigest(marker)) {
      fail('CHANGES_RECOVERY_STALE', 'ordinary terminal marker changed before cleanup');
    }
    const cleanupValue = journalNextValue(current.value, {
      activeMarker: marker,
      activeMarkerDigest: markerJournalSchema.activeMarkerDigest(marker),
      terminalCleanup: cleanup,
      terminalCleanupDigest: cleanup.cleanupDigest,
    });
    if (typeof beforeClear === 'function') beforeClear(markerLocation(rootPath, false, fileSystem));
    appendJournal(scoped, current.value, cleanupValue);
    const idleValue = journalNextValue(cleanupValue, {
      state: 'IDLE',
      activeOperationId: null,
      activeKind: null,
      activeMarker: null,
      activeMarkerDigest: null,
      nativePublication: null,
      existingTerminalPublication: null,
      terminalCleanup: null,
      terminalCleanupDigest: null,
    });
    appendJournal(scoped, cleanupValue, idleValue);
    return { ok: true, operationId };
  }

  function clearSnapshotRestoreJournal(rootPath, projectId, operationId, initialCurrent) {
    const scoped = markerJournalFor(rootPath, true);
    let value = initialCurrent.value;
    if (initialCurrent.status !== 'VALUE' || value?.state !== 'ACTIVE' ||
        value.activeOperationId !== operationId || value.activeKind !== 'snapshot_restore' ||
        value.nativePublication?.state !== 'ACK_COMMITTED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot terminal journal authority is unavailable');
    }
    let marker = validateMarker(value.activeMarker, projectService, historyService);
    if (marker.projectId !== projectId || marker.operationId !== operationId ||
        marker.state !== 'terminal' || marker.outcome !== 'applied' ||
        marker.publicMarkdownPhase?.phase !== 'FINALIZED') {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot terminal marker is incomplete');
    }
    const currentHistoryBindingValue = currentHistoryBinding(rootPath);
    if (currentHistoryBindingValue.exists !== marker.preparedHistoryState.exists ||
        currentHistoryBindingValue.digest !== marker.preparedHistoryState.digest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'Snapshot terminal History truth is foreign');
    }
    const currentHistory = historyService.loadHistoryState(rootPath);
    assertPersistedFinalRecordIdentity(rootPath, value.nativePublication);
    const artifactLifecycle = artifactLifecycleFor(rootPath);
    if (!artifactLifecycle || typeof artifactLifecycle.reconcile !== 'function' ||
        typeof artifactLifecycle.verify !== 'function' ||
        typeof artifactLifecycle.acknowledge !== 'function') {
      fail('ARTIFACT_CLEANUP_UNAVAILABLE', 'durable artifact cleanup lifecycle is unavailable');
    }
    let token;
    if (marker.artifactCleanup) {
      token = verifiedArtifactCleanupToken(
        artifactLifecycle,
        marker,
        marker.artifactCleanup.token
      );
    } else {
      token = artifactLifecycle.reconcile(marker.artifact);
      if (token) token = verifiedArtifactCleanupToken(artifactLifecycle, marker, token);
      if (!token) {
        if (typeof beforeClear === 'function') {
          beforeClear(markerLocation(rootPath, false, fileSystem));
        }
        assertPersistedFinalRecordIdentity(rootPath, value.nativePublication);
        token = recoveryArtifact.removeArtifact(
          markerLocation(rootPath, false, fileSystem).directory,
          marker.artifact,
          artifactLifecycle
        );
        token = verifiedArtifactCleanupToken(artifactLifecycle, marker, token);
      }
      const artifactCleanup = cleanupAuthority(marker, token);
      marker = journalMarker(marker, { artifactCleanup, updatedAt: now() });
      const cleanupMarkerValue = journalNextValue(value, {
        activeMarker: marker,
        activeMarkerDigest: markerJournalSchema.activeMarkerDigest(marker),
      });
      appendJournal(
        scoped,
        value,
        cleanupMarkerValue,
        () => assertPersistedFinalRecordIdentity(rootPath, value.nativePublication)
      );
      value = cleanupMarkerValue;
    }
    try {
      assertPersistedFinalRecordIdentity(rootPath, value.nativePublication);
      artifactLifecycle.acknowledge(marker.artifact.basename, token);
    } catch (error) {
      const wrapped = new ChangesHistoryRecoveryError(
        'CHANGES_RECOVERY_WRITE_FAILED',
        'Snapshot artifact cleanup receipt requires reconciliation'
      );
      wrapped.cause = error;
      throw wrapped;
    }
    const capture = value.nativePublication.createCapture;
    const publicRecordDigests = capture.items.flatMap(item => [
      item.control.rawSha256,
      item.receipt.rawSha256,
    ]);
    publicRecordDigests.push(marker.publicMarkdownPhase.finalReceiptDigest);
    const terminalCleanup = markerJournalSchema.buildTerminalCleanup({
      schema: markerJournalSchema.SCHEMAS.CLEANUP,
      operationId,
      kind: marker.kind,
      terminalPhaseDigest: evidenceDeliverySchema.digestObject(
        publicMarkdownPhaseSchema.SCHEMA,
        marker.publicMarkdownPhase
      ),
      historyStateDigest: historyService.digestHistoryState(currentHistory),
      artifactCleanupDigest: evidenceDeliverySchema.digestObject(
        ARTIFACT_CLEANUP_AUTHORITY_SCHEMA,
        marker.artifactCleanup
      ),
      publicRecordDigests,
      publicationState: 'ACK_COMMITTED',
      publicationDigest: value.nativePublication.publicationDigest,
      existingTerminalPublicationState: 'NONE',
      existingTerminalPublicationDigest: null,
      recoveryDirectoryFsyncComplete: true,
    });
    const cleanupValue = journalNextValue(value, {
      terminalCleanup,
      terminalCleanupDigest: terminalCleanup.cleanupDigest,
    });
    appendJournal(
      scoped,
      value,
      cleanupValue,
      () => assertPersistedFinalRecordIdentity(rootPath, value.nativePublication)
    );
    const idleValue = journalNextValue(cleanupValue, {
      state: 'IDLE',
      activeOperationId: null,
      activeKind: null,
      activeMarker: null,
      activeMarkerDigest: null,
      nativePublication: null,
      existingTerminalPublication: null,
      terminalCleanup: null,
      terminalCleanupDigest: null,
    });
    appendJournal(
      scoped,
      cleanupValue,
      idleValue,
      () => assertPersistedFinalRecordIdentity(rootPath, cleanupValue.nativePublication)
    );
    return { ok: true, operationId };
  }

  function clearSnapshotRestoreJournalRetry(rootPath, projectId, operationId) {
    const scoped = markerJournalFor(rootPath, true);
    const pair = discoverJournalPair(scoped);
    const older = pair.older;
    const current = pair.current;
    if (older.activeKind !== 'snapshot_restore') return null;
    if (current.state !== 'IDLE' || current.projectId !== projectId ||
        older.state !== 'ACTIVE' || older.projectId !== projectId ||
        older.activeOperationId !== operationId ||
        older.nativePublication?.state !== 'ACK_COMMITTED' ||
        older.terminalCleanup === null) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot terminal clear retry authority is unavailable');
    }
    const marker = validateMarker(older.activeMarker, projectService, historyService);
    const cleanup = markerJournalSchema.assertTerminalCleanup(older.terminalCleanup);
    if (marker.operationId !== operationId || marker.projectId !== projectId ||
        marker.state !== 'terminal' || marker.outcome !== 'applied' ||
        marker.publicMarkdownPhase?.phase !== 'FINALIZED' ||
        cleanup.operationId !== operationId || cleanup.kind !== 'snapshot_restore' ||
        cleanup.publicationState !== 'ACK_COMMITTED' ||
        cleanup.publicationDigest !== older.nativePublication.publicationDigest ||
        cleanup.cleanupDigest !== older.terminalCleanupDigest) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED',
        'Snapshot terminal clear retry authority is foreign');
    }
    return { ok: true, operationId };
  }

  function clear(rootPath, projectId, operationId) {
    projectIdentity(projectService, rootPath, projectId);
    if (markerJournalLifecycle !== null) {
      const scoped = markerJournalFor(rootPath, true);
      const current = journalCurrent(scoped);
      if (current.status !== 'LEGACY') {
        if (current.status === 'VALUE' && current.value?.state === 'IDLE') {
          const snapshotRetry = clearSnapshotRestoreJournalRetry(
            rootPath,
            projectId,
            operationId
          );
          if (snapshotRetry !== null) return snapshotRetry;
        }
        if (current.status === 'VALUE' &&
            current.value?.activeKind === 'snapshot_restore') {
          return clearSnapshotRestoreJournal(rootPath, projectId, operationId, current);
        }
        return clearOrdinaryJournal(rootPath, projectId, operationId, current);
      }
    }
    const marker = readMarker(rootPath);
    if (!marker || marker.operationId !== operationId || marker.projectId !== projectId) {
      fail('CHANGES_RECOVERY_STALE', '恢复操作身份已失效');
    }
    if (marker.state === 'terminal' && (
      (marker.kind === 'snapshot_restore' && marker.outcome === 'applied' &&
        marker.publicMarkdownPhase?.phase === 'FINALIZED') ||
      (marker.kind === 'snapshot_restore_undo' && marker.outcome === 'zero_write_error' &&
        marker.publicMarkdownPhase?.phase === 'RESTORED') ||
      (marker.kind === 'snapshot_restore_undo' && marker.outcome === 'undone' &&
        marker.publicMarkdownPhase?.phase === 'FINALIZED')
    )) {
      return clearFinalized(rootPath, marker);
    }
    const artifactLifecycle = marker.artifact ? artifactLifecycleFor(rootPath) : null;
    const durableArtifactLifecycle = marker.artifact && artifactLifecycle &&
      typeof artifactLifecycle.reconcile === 'function' &&
      typeof artifactLifecycle.verify === 'function' &&
      typeof artifactLifecycle.acknowledge === 'function';
    let cleanupToken = null;
    if (durableArtifactLifecycle) {
      const rawCleanupToken = artifactLifecycle.reconcile(marker.artifact);
      cleanupToken = rawCleanupToken
        ? verifiedArtifactCleanupToken(artifactLifecycle, marker, rawCleanupToken)
        : null;
    }
    const classified = cleanupToken
      ? marker
      : classify(rootPath, operationId, projectId);
    if (!SAFE_CLEAR_OUTCOMES.has(classified.outcome)) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', '恢复尚未达到可清理状态');
    }
    const location = markerLocation(rootPath, false, fileSystem);
    if (durableArtifactLifecycle && cleanupToken === null) {
      try {
        cleanupToken = recoveryArtifact.removeArtifact(
          location.directory,
          marker.artifact,
          artifactLifecycle
        );
        cleanupToken = verifiedArtifactCleanupToken(
          artifactLifecycle,
          marker,
          cleanupToken
        );
      } catch (error) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_RECOVERY_WRITE_FAILED',
          'Snapshot artifact cleanup requires reconciliation'
        );
        wrapped.cause = error;
        throw wrapped;
      }
    }
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
    if (marker.artifact && !durableArtifactLifecycle) {
      try {
        recoveryArtifact.removeArtifact(
          location.directory,
          marker.artifact,
          artifactLifecycleFor(rootPath)
        );
      } catch (error) {
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_RECOVERY_WRITE_FAILED',
          'Snapshot artifact cleanup requires reconciliation'
        );
        wrapped.cause = error;
        throw wrapped;
      }
    }
    if (cleanupToken) {
      try {
        artifactLifecycle.acknowledge(marker.artifact.basename, cleanupToken);
      } catch (error) {
        // ACK is deliberately after exact marker removal. If its response is
        // unavailable, republish the exact terminal marker as the retry key;
        // restart can reconcile the already-committed cleanup token without
        // re-running artifact removal, History, CREATE, or FINALIZE.
        if (!fileSystem.existsSync(location.file)) {
          try {
            atomicWriteMarker(location, serialized, fileSystem, () => {
              if (markerLocation(location.root, true, fileSystem).exists) {
                fail('CHANGES_RECOVERY_PENDING', '恢复标记已被其他操作恢复');
              }
            }, true);
          } catch (restoreError) {
            const wrapped = new ChangesHistoryRecoveryError(
              'CHANGES_MANUAL_RECOVERY_REQUIRED',
              'artifact cleanup ACK failed and marker retry authority could not be restored'
            );
            wrapped.cause = restoreError;
            throw wrapped;
          }
        }
        const wrapped = new ChangesHistoryRecoveryError(
          'CHANGES_RECOVERY_WRITE_FAILED',
          'Snapshot artifact cleanup receipt requires reconciliation'
        );
        wrapped.cause = error;
        throw wrapped;
      }
    }
    return { ok: true, operationId };
  }

  function hasPending(rootPath) {
    if (markerJournalLifecycle === null) {
      return markerLocation(rootPath, false, fileSystem).exists;
    }
    return readMarker(rootPath) !== null;
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
    createMissingLeaves,
    executeExistingRestore,
    commitMissingRestoreHistory,
    finalizeMissingRestore,
    quarantineSnapshotRestoreUndo,
    commitSnapshotRestoreUndoHistory,
    restoreSnapshotRestoreUndo,
    finalizeSnapshotRestoreUndo,
  });
}

module.exports = {
  RECOVERY_SCHEMA,
  RECOVERY_RELATIVE_PATH,
  MAX_MARKER_BYTES,
  MAX_FILES,
  ChangesHistoryRecoveryError,
  createChangesHistoryReconciliationService,
};
