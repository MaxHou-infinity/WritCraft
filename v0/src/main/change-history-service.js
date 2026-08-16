'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const changeSetService = require('./changeset-service');
const evidenceDeliverySchema = require('./evidence-delivery-schema');

const LEGACY_HISTORY_SCHEMA = 'writcraft.changes/v1';
const PREVIOUS_HISTORY_SCHEMA = 'writcraft.changes/v2';
const PREVIOUS_V3_HISTORY_SCHEMA = 'writcraft.changes/v3';
const HISTORY_SCHEMA = 'writcraft.changes/v4';
const TERMINAL_HISTORY_STATE_SCHEMA =
  'writcraft.changes-history-terminal-history-state/v1';
const HISTORY_RELATIVE_PATH = '.writcraft/changes.json';
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_BYTES = 192 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 16 * 1024;
const MAX_SNAPSHOT_PROVENANCE_BYTES = 64 * 1024;
const MAX_SNAPSHOT_UNDO_HISTORY_TEMPLATE_BYTES = 32 * 1024 * 1024;
const RESEARCH_PROVENANCE_SCHEMA = 'writcraft.research-handoff/v1';
const INLINE_REWRITE_PROVENANCE_SCHEMA = 'writcraft.inline-rewrite/v1';
const SNAPSHOT_RESTORE_PROVENANCE_SCHEMA = 'writcraft.snapshot-restore-history/v1';
const SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA = 'writcraft.snapshot-restore-history-template/v1';
const SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA =
  'writcraft.snapshot-restore-undo-history-template/v1';
const REVISION_RE = /^[a-f0-9]{64}$/;
const ENTRY_ID_RE = /^change_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANGESET_ID_RE = /^cs_[a-f0-9]{24}$/;
const HUNK_ID_RE = /^hk_[a-f0-9]{24}$/;
const RESEARCH_RUN_ID_RE = /^rr_[a-f0-9]{24}$/;
const RESEARCH_CARD_ID_RE = /^rc_[a-f0-9]{32}$/;
const SOURCE_ID_RE = /^src_[a-f0-9]{20}$/;
const INLINE_REWRITE_ID_RE = /^ir_[a-f0-9]{32}$/;
const BLOCK_ID_RE = /^block_[a-f0-9]{8}$/;
const BLOCK_FINGERPRINT_RE = /^[a-f0-9]{8}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const INLINE_REWRITE_STYLES = Object.freeze(['general', 'concise', 'vivid', 'academic', 'casual']);
const INLINE_NEIGHBOR_ROLES = Object.freeze(['previous', 'before_selection', 'after_selection', 'next']);

class ChangeHistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangeHistoryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangeHistoryError(code, message);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail('INVALID_HISTORY', '历史文件路径无效');
  if (value !== value.normalize('NFC')) fail('INVALID_HISTORY', '历史文件路径必须使用 NFC Unicode');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\')) {
    fail('INVALID_HISTORY', '历史只允许项目内 POSIX 相对路径');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('INVALID_HISTORY', '历史包含隐藏或越界路径');
  }
  if (!/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) fail('INVALID_HISTORY', '历史只允许 Markdown 路径');
  return parts.join('/');
}

function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('INVALID_HISTORY', `${field} 时间无效`);
  return value;
}

function revision(value, field) {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) fail('INVALID_HISTORY', `${field} revision 无效`);
  return value;
}

function changeSetId(value, field = 'changeSetId') {
  if (typeof value !== 'string' || !CHANGESET_ID_RE.test(value)) fail('INVALID_HISTORY', `${field} 无效`);
  return value;
}

function hunkIds(value, field) {
  if (!Array.isArray(value) || value.length > changeSetService.MAX_CHANGE_HUNKS) {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  const seen = new Set();
  return value.map(id => {
    if (typeof id !== 'string' || !HUNK_ID_RE.test(id) || seen.has(id)) {
      fail('INVALID_HISTORY', `${field} 包含无效或重复修改块`);
    }
    seen.add(id);
    return id;
  });
}

function exactKeys(value, expectedKeys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_HISTORY', `${field} 包含未知或缺失字段`);
  }
}

function exactDataRecord(value, expectedKeys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string') ||
      keys.map(String).sort().some((key, index) => key !== expected[index])) {
    fail('INVALID_HISTORY', `${field} 包含未知或缺失字段`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value') ||
        Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set')) {
      fail('INVALID_HISTORY', `${field}.${key} 必须是普通数据字段`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function boundedString(value, field, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum ||
      /[\u0000-\u001f]/u.test(value) || evidenceDeliverySchema.hasUnpairedSurrogate(value)) {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  return value;
}

function safeInteger(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('INVALID_HISTORY', `${field} 无效`);
  return value;
}

function strictJsonClone(value, field = 'provenance', depth = 0, state = { ancestors: new Set(), nodes: 0 }) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_HISTORY', `${field} 包含非有限数字`);
    return value;
  }
  if (depth > 16 || !value || typeof value !== 'object') {
    fail('INVALID_HISTORY', `${field} 包含不可序列化值`);
  }
  state.nodes += 1;
  if (state.nodes > 2048) fail('INVALID_HISTORY', `${field} 结构过于复杂`);
  if (state.ancestors.has(value)) fail('INVALID_HISTORY', `${field} 包含循环引用`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype) {
    fail('INVALID_HISTORY', `${field} 必须是普通 JSON 对象`);
  }
  if (Object.getOwnPropertySymbols(value).length) {
    fail('INVALID_HISTORY', `${field} 包含非标准 JSON 字段`);
  }
  state.ancestors.add(value);
  let clone;
  if (Array.isArray(value)) {
    if (value.length > 2048 || Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1) {
      fail('INVALID_HISTORY', `${field} 包含稀疏或非标准数组`);
    }
    clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('INVALID_HISTORY', `${field}[${index}] 必须是普通 JSON 值`);
      }
      clone.push(strictJsonClone(descriptor.value, `${field}[${index}]`, depth + 1, state));
    }
  } else {
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length || Object.keys(value).length > 256) {
      fail('INVALID_HISTORY', `${field} 包含非标准或过多 JSON 字段`);
    }
    clone = {};
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail('INVALID_HISTORY', `${field} 包含不安全字段`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('INVALID_HISTORY', `${field}.${key} 必须是普通 JSON 字段`);
      }
      clone[key] = strictJsonClone(descriptor.value, `${field}.${key}`, depth + 1, state);
    }
  }
  state.ancestors.delete(value);
  return clone;
}

function validateResearchProvenance(raw) {
  exactKeys(raw, ['schema', 'kind', 'runId', 'cardId', 'bindingDigest', 'expiresAt', 'evidence', 'targets'], 'provenance');
  if (raw.schema !== RESEARCH_PROVENANCE_SCHEMA || raw.kind !== 'research_card' ||
      !RESEARCH_RUN_ID_RE.test(raw.runId || '') || !RESEARCH_CARD_ID_RE.test(raw.cardId || '') ||
      !SHA256_RE.test(raw.bindingDigest || '')) {
    fail('INVALID_HISTORY', 'Research provenance 身份无效');
  }
  const expiresAt = safeInteger(raw.expiresAt, 'provenance.expiresAt', 1);
  exactKeys(raw.evidence, [
    'sourceId', 'path', 'revision', 'locator', 'grade', 'gradeRule', 'quoteDigest', 'quoteExcerpt',
  ], 'provenance.evidence');
  if (!SOURCE_ID_RE.test(raw.evidence.sourceId || '') || !REVISION_RE.test(raw.evidence.revision || '') ||
      !['A', 'B', 'C', 'D'].includes(raw.evidence.grade) || !SHA256_RE.test(raw.evidence.quoteDigest || '')) {
    fail('INVALID_HISTORY', 'Research provenance 来源身份无效');
  }
  exactKeys(raw.evidence.locator, ['offset', 'end', 'line', 'column'], 'provenance.evidence.locator');
  const offset = safeInteger(raw.evidence.locator.offset, 'provenance.evidence.locator.offset');
  const end = safeInteger(raw.evidence.locator.end, 'provenance.evidence.locator.end');
  if (end < offset) fail('INVALID_HISTORY', 'Research provenance locator 范围无效');
  const locator = {
    offset,
    end,
    line: safeInteger(raw.evidence.locator.line, 'provenance.evidence.locator.line', 1),
    column: safeInteger(raw.evidence.locator.column, 'provenance.evidence.locator.column', 1),
  };
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > 8) {
    fail('INVALID_HISTORY', 'Research provenance 目标范围无效');
  }
  const seenTargets = new Set();
  const targets = raw.targets.map((target, index) => {
    exactKeys(target, ['path', 'revision'], `provenance.targets[${index}]`);
    const targetPath = publicMarkdownPath(target.path);
    if (seenTargets.has(targetPath) || !REVISION_RE.test(target.revision || '')) {
      fail('INVALID_HISTORY', 'Research provenance 包含重复目标或无效 revision');
    }
    seenTargets.add(targetPath);
    return { path: targetPath, revision: target.revision };
  });
  return {
    schema: RESEARCH_PROVENANCE_SCHEMA,
    kind: 'research_card',
    runId: raw.runId,
    cardId: raw.cardId,
    bindingDigest: raw.bindingDigest,
    expiresAt,
    evidence: {
      sourceId: raw.evidence.sourceId,
      path: publicMarkdownPath(raw.evidence.path),
      revision: raw.evidence.revision,
      locator,
      grade: raw.evidence.grade,
      gradeRule: boundedString(raw.evidence.gradeRule, 'provenance.evidence.gradeRule', 1, 256),
      quoteDigest: raw.evidence.quoteDigest,
      quoteExcerpt: boundedString(raw.evidence.quoteExcerpt, 'provenance.evidence.quoteExcerpt', 0, 240),
    },
    targets,
  };
}

function validateInlineRewriteSummary(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || /[\r\n]/.test(value) ||
      Array.from(value).length > 240 || Buffer.byteLength(value, 'utf8') > 1024) {
    fail('INVALID_HISTORY', 'Inline Rewrite provenance summary 无效');
  }
  return value;
}

function validateInlineRewriteProvenance(raw) {
  exactKeys(raw, [
    'schema', 'kind', 'rewriteId', 'style', 'summary', 'target', 'selection',
    'projectPrompt', 'neighbors', 'expiresAt',
  ], 'provenance');
  if (raw.schema !== INLINE_REWRITE_PROVENANCE_SCHEMA || raw.kind !== 'inline_rewrite' ||
      !INLINE_REWRITE_ID_RE.test(raw.rewriteId || '') || !INLINE_REWRITE_STYLES.includes(raw.style)) {
    fail('INVALID_HISTORY', 'Inline Rewrite provenance 身份无效');
  }

  exactKeys(raw.target, ['path', 'revision'], 'provenance.target');
  const target = {
    path: publicMarkdownPath(raw.target.path),
    revision: revision(raw.target.revision, 'provenance.target.revision'),
  };

  exactKeys(raw.selection, [
    'startOffset', 'endOffset', 'blockId', 'blockFingerprint', 'quoteDigest',
  ], 'provenance.selection');
  const startOffset = safeInteger(raw.selection.startOffset, 'provenance.selection.startOffset');
  const endOffset = safeInteger(raw.selection.endOffset, 'provenance.selection.endOffset');
  if (endOffset <= startOffset || !BLOCK_ID_RE.test(raw.selection.blockId || '') ||
      !BLOCK_FINGERPRINT_RE.test(raw.selection.blockFingerprint || '') ||
      !SHA256_RE.test(raw.selection.quoteDigest || '')) {
    fail('INVALID_HISTORY', 'Inline Rewrite provenance selection 无效');
  }
  const selection = {
    startOffset,
    endOffset,
    blockId: raw.selection.blockId,
    blockFingerprint: raw.selection.blockFingerprint,
    quoteDigest: raw.selection.quoteDigest,
  };

  let projectPrompt = null;
  if (target.path === 'edit.md') {
    if (raw.projectPrompt !== null) {
      fail('INVALID_HISTORY', 'edit.md Inline Rewrite provenance 不得重复声明项目 Prompt');
    }
  } else {
    exactKeys(raw.projectPrompt, ['path', 'revision'], 'provenance.projectPrompt');
    if (raw.projectPrompt.path !== 'edit.md') {
      fail('INVALID_HISTORY', 'Inline Rewrite provenance 项目 Prompt 路径无效');
    }
    projectPrompt = {
      path: 'edit.md',
      revision: revision(raw.projectPrompt.revision, 'provenance.projectPrompt.revision'),
    };
  }

  if (!Array.isArray(raw.neighbors) || raw.neighbors.length > INLINE_NEIGHBOR_ROLES.length) {
    fail('INVALID_HISTORY', 'Inline Rewrite provenance neighbors 无效');
  }
  let previousRoleIndex = -1;
  let previousEndOffset = -1;
  const neighbors = raw.neighbors.map((neighbor, index) => {
    exactKeys(neighbor, ['role', 'path', 'revision', 'offset', 'endOffset', 'digest'], `provenance.neighbors[${index}]`);
    const roleIndex = INLINE_NEIGHBOR_ROLES.indexOf(neighbor.role);
    const offset = safeInteger(neighbor.offset, `provenance.neighbors[${index}].offset`);
    const neighborEndOffset = safeInteger(neighbor.endOffset, `provenance.neighbors[${index}].endOffset`);
    const neighborPath = publicMarkdownPath(neighbor.path);
    if (roleIndex <= previousRoleIndex || neighborEndOffset <= offset || offset < previousEndOffset ||
        neighborPath !== target.path || neighbor.revision !== target.revision || !SHA256_RE.test(neighbor.digest || '')) {
      fail('INVALID_HISTORY', 'Inline Rewrite provenance neighbors 顺序或依赖无效');
    }
    previousRoleIndex = roleIndex;
    previousEndOffset = neighborEndOffset;
    return {
      role: neighbor.role,
      path: neighborPath,
      revision: revision(neighbor.revision, `provenance.neighbors[${index}].revision`),
      offset,
      endOffset: neighborEndOffset,
      digest: neighbor.digest,
    };
  });

  return {
    schema: INLINE_REWRITE_PROVENANCE_SCHEMA,
    kind: 'inline_rewrite',
    rewriteId: raw.rewriteId,
    style: raw.style,
    summary: validateInlineRewriteSummary(raw.summary),
    target,
    selection,
    projectPrompt,
    neighbors,
    expiresAt: safeInteger(raw.expiresAt, 'provenance.expiresAt', 1),
  };
}

function validateProvenance(raw, field = 'provenance') {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_HISTORY', `${field} 无效`);
  const strictClone = strictJsonClone(raw, field);
  let clone = strictClone;
  if (strictClone.schema === RESEARCH_PROVENANCE_SCHEMA || strictClone.kind === 'research_card') {
    clone = validateResearchProvenance(strictClone);
  } else if (strictClone.schema === INLINE_REWRITE_PROVENANCE_SCHEMA || strictClone.kind === 'inline_rewrite') {
    clone = validateInlineRewriteProvenance(strictClone);
  } else if (strictClone.schema === SNAPSHOT_RESTORE_PROVENANCE_SCHEMA) {
    try {
      evidenceDeliverySchema.assertSnapshotRestoreHistoryProvenance(
        strictClone,
        strictClone.selectedIds?.length
      );
    } catch (error) {
      if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
        fail('INVALID_HISTORY', `${field} snapshot restore provenance 无效`);
      }
      throw error;
    }
  }
  let serialized;
  try { serialized = JSON.stringify(clone); } catch (_) { fail('INVALID_HISTORY', `${field} 不可序列化`); }
  const maxBytes = clone?.schema === SNAPSHOT_RESTORE_PROVENANCE_SCHEMA
    ? MAX_SNAPSHOT_PROVENANCE_BYTES
    : MAX_PROVENANCE_BYTES;
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    fail('INVALID_HISTORY', `${field} 不能超过 ${maxBytes} 字节`);
  }
  return clone;
}

function validateReviewAudit(raw, field = 'review') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_HISTORY', `${field} 无效`);
  const keys = Object.keys(raw).sort();
  const expectedKeys = ['acceptedHunkIds', 'rejectedHunkIds', 'sourceChangeSetId'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    fail('INVALID_HISTORY', `${field} 包含未知或缺失字段`);
  }
  const acceptedHunkIds = hunkIds(raw.acceptedHunkIds, `${field}.acceptedHunkIds`);
  const rejectedHunkIds = hunkIds(raw.rejectedHunkIds, `${field}.rejectedHunkIds`);
  const accepted = new Set(acceptedHunkIds);
  if (acceptedHunkIds.length + rejectedHunkIds.length > changeSetService.MAX_CHANGE_HUNKS ||
      rejectedHunkIds.some(id => accepted.has(id)) || (!acceptedHunkIds.length && !rejectedHunkIds.length)) {
    fail('INVALID_HISTORY', `${field} 决策为空或相互冲突`);
  }
  return {
    sourceChangeSetId: changeSetId(raw.sourceChangeSetId, `${field}.sourceChangeSetId`),
    acceptedHunkIds,
    rejectedHunkIds,
  };
}

function historyLocation(rootPath, createMetadataDirectory = false) {
  if (typeof rootPath !== 'string' || !rootPath) fail('INVALID_ROOT', '项目目录无效');
  const absolute = path.resolve(rootPath);
  let stat;
  try { stat = fs.statSync(absolute); } catch (_) { fail('INVALID_ROOT', '项目目录不存在'); }
  if (!stat.isDirectory()) fail('INVALID_ROOT', '项目路径不是目录');
  const root = fs.realpathSync(absolute);
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    if (!createMetadataDirectory) return { file: path.join(metadata, 'changes.json'), exists: false };
    fs.mkdirSync(metadata, { mode: 0o700 });
  }
  const metadataStat = fs.lstatSync(metadata);
  if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory() || fs.realpathSync(metadata) !== metadata) {
    fail('UNSAFE_HISTORY_PATH', '.writcraft 必须是项目内普通目录');
  }
  const file = path.join(metadata, 'changes.json');
  if (fs.existsSync(file)) {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
      fail('UNSAFE_HISTORY_PATH', 'changes.json 必须是独占普通文件');
    }
  }
  return { file, exists: fs.existsSync(file) };
}

function syncDirectory(directory) {
  const directoryFd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function atomicWrite(filePath, content, options = {}) {
  const temporary = path.join(
    path.dirname(filePath),
    `.changes.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (typeof options.beforeRename === 'function') options.beforeRename();
    fs.renameSync(temporary, filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function recordPayload(record) {
  const { integrity: _integrity, ...payload } = record;
  return payload;
}

function integrityFor(record) {
  return sha256(JSON.stringify(recordPayload(record)));
}

function validateLegacyFileState(state, field) {
  if (!state || typeof state !== 'object' || typeof state.content !== 'string') {
    fail('INVALID_HISTORY', `${field} 回滚正文无效`);
  }
  const normalized = {
    revision: revision(state.revision, `${field}.revision`),
    contentHash: revision(state.contentHash, `${field}.contentHash`),
    content: state.content,
  };
  const actual = sha256(normalized.content);
  if (actual !== normalized.contentHash || actual !== normalized.revision) {
    fail('INVALID_HISTORY', `${field} 正文、哈希与 revision 不一致`);
  }
  return normalized;
}

function v4FileStateFromContent(content, expectedRevision = sha256(content)) {
  const contentHash = sha256(content);
  if (expectedRevision !== contentHash) fail('INVALID_HISTORY', 'v4 文件 revision 与正文不一致');
  return {
    exists: true,
    revision: expectedRevision,
    contentHash,
    byteLength: Buffer.byteLength(content, 'utf8'),
    encoding: 'utf8',
    data: content,
  };
}

function validateV4FileState(state, field, options = {}) {
  exactKeys(state, ['exists', 'revision', 'contentHash', 'byteLength', 'encoding', 'data'], field);
  if (state.exists === false) {
    if (state.revision !== null || state.contentHash !== null || state.byteLength !== 0 ||
        state.encoding !== null || state.data !== null) {
      fail('INVALID_HISTORY', `${field} 缺失状态无效`);
    }
    return {
      exists: false,
      revision: null,
      contentHash: null,
      byteLength: 0,
      encoding: null,
      data: null,
    };
  }
  if (state.exists !== true || !['utf8', 'base64'].includes(state.encoding)) {
    fail('INVALID_HISTORY', `${field} 存在状态或 encoding 无效`);
  }
  if (options.snapshotRestore === true && state.encoding !== 'base64') {
    fail('INVALID_HISTORY', `${field} snapshot restore 必须使用 base64`);
  }
  let content;
  if (state.encoding === 'base64') {
    try {
      evidenceDeliverySchema.assertSnapshotRestoreHistoryState(state, field);
      content = Buffer.from(state.data, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
        fail('INVALID_HISTORY', `${field} base64 raw bytes 无效`);
      }
      throw error;
    }
  } else {
    if (typeof state.data !== 'string' || Buffer.byteLength(state.data, 'utf8') !== state.byteLength) {
      fail('INVALID_HISTORY', `${field} utf8 data/byteLength 无效`);
    }
    const actual = sha256(state.data);
    if (revision(state.revision, `${field}.revision`) !== actual ||
        revision(state.contentHash, `${field}.contentHash`) !== actual) {
      fail('INVALID_HISTORY', `${field} utf8 data/hash 无效`);
    }
    content = state.data;
  }
  return {
    exists: true,
    revision: state.revision,
    contentHash: state.contentHash,
    byteLength: state.byteLength,
    encoding: state.encoding,
    data: state.data,
    content,
  };
}

function persistedV4State(state) {
  const { content: _content, ...persisted } = state;
  return persisted;
}

function stateContent(state) {
  if (state.exists === false) return null;
  if (typeof state.content === 'string') return state.content;
  if (state.encoding === 'base64') return Buffer.from(state.data, 'base64').toString('utf8');
  return state.data;
}

function validateApplicationRecord(raw, schema = HISTORY_SCHEMA) {
  if (!raw || typeof raw !== 'object' || !ENTRY_ID_RE.test(raw.id || '')) {
    fail('INVALID_HISTORY', '历史记录身份无效');
  }
  if (!['applied', 'undone'].includes(raw.status) || !Array.isArray(raw.files) || !raw.files.length) {
    fail('INVALID_HISTORY', '历史记录状态或文件列表无效');
  }
  const snapshotRestore = schema === HISTORY_SCHEMA &&
    raw.provenance?.schema === SNAPSHOT_RESTORE_PROVENANCE_SCHEMA;
  const legacyOrdinaryV4 = schema === HISTORY_SCHEMA && !snapshotRestore &&
    raw.files.every(file => file && typeof file === 'object' && !Array.isArray(file) &&
      Object.getPrototypeOf(file) === Object.prototype &&
      !Object.hasOwn(file, 'ancestorIdentityDigest'));
  if (schema === HISTORY_SCHEMA) {
    const expectedKeys = [
      'id', 'kind', 'changeSetId', 'status', 'appliedAt', 'files', 'provenance', 'integrity',
      ...(raw.review !== undefined ? ['review'] : []),
      ...(raw.undoneAt !== undefined ? ['undoneAt'] : []),
    ];
    exactKeys(raw, expectedKeys, 'v4 application entry');
    if (snapshotRestore && (raw.review !== undefined ||
        (raw.status === 'applied' && raw.undoneAt !== undefined) ||
        (raw.status === 'undone' && raw.undoneAt === undefined))) {
      fail('INVALID_HISTORY', 'snapshot restore entry status/undoneAt 无效');
    }
  }
  const seen = new Set();
  const files = raw.files.map(file => {
    if (!file || typeof file !== 'object') fail('INVALID_HISTORY', '历史文件记录无效');
    const fileData = schema === HISTORY_SCHEMA
      ? (() => {
        const cloned = exactDataRecord(file, [
        'path', 'summary', 'before', 'after', 'createdIdentityDigest', 'ancestorIdentityDigest',
        ].filter(key => !legacyOrdinaryV4 || key !== 'ancestorIdentityDigest'), 'v4 file');
        return legacyOrdinaryV4 ? { ...cloned, ancestorIdentityDigest: null } : cloned;
      })()
      : file;
    const filePath = publicMarkdownPath(fileData.path);
    if (seen.has(filePath)) fail('INVALID_HISTORY', '历史记录包含重复文件');
    seen.add(filePath);
    if (schema === HISTORY_SCHEMA) {
      if (snapshotRestore) {
        if (!SHA256_RE.test(fileData.ancestorIdentityDigest || '')) {
          fail('INVALID_HISTORY', `${filePath} snapshot restore 缺少 ancestorIdentityDigest`);
        }
        try {
          evidenceDeliverySchema.assertSnapshotRestoreHistoryFile({
            path: fileData.path,
            summary: fileData.summary,
            before: fileData.before,
            after: fileData.after,
            createdIdentityDigest: fileData.createdIdentityDigest,
          }, `${filePath} snapshot restore file`);
        } catch (error) {
          if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
            fail('INVALID_HISTORY', `${filePath} snapshot restore file 无效`);
          }
          throw error;
        }
      } else if (fileData.createdIdentityDigest !== null || fileData.ancestorIdentityDigest !== null) {
        fail('INVALID_HISTORY', `${filePath} 普通 Changes identity digests 必须为 null`);
      }
      const before = validateV4FileState(fileData.before, `${filePath}.before`, { snapshotRestore });
      const after = validateV4FileState(fileData.after, `${filePath}.after`, { snapshotRestore });
      if (!after.exists) fail('INVALID_HISTORY', `${filePath}.after 必须存在`);
      return {
        path: filePath,
        summary: snapshotRestore
          ? fileData.summary
          : boundedString(fileData.summary, `${filePath}.summary`, 0, 500),
        before: persistedV4State(before),
        after: persistedV4State(after),
        createdIdentityDigest: fileData.createdIdentityDigest,
        ancestorIdentityDigest: fileData.ancestorIdentityDigest,
      };
    }
    const before = validateLegacyFileState(file.before, `${filePath}.before`);
    const after = validateLegacyFileState(file.after, `${filePath}.after`);
    const result = {
      path: filePath,
      summary: typeof file.summary === 'string' ? file.summary.slice(0, 500) : '',
      before,
      after,
    };
    if (file.undoRevision !== undefined) result.undoRevision = revision(file.undoRevision, `${filePath}.undoRevision`);
    return result;
  });
  const provenanceRequired = [PREVIOUS_V3_HISTORY_SCHEMA, HISTORY_SCHEMA].includes(schema);
  const provenance = provenanceRequired
    ? (() => {
      if (!Object.hasOwn(raw, 'provenance')) fail('INVALID_HISTORY', '历史记录缺少 provenance');
      return validateProvenance(raw.provenance);
    })()
    : null;
  if (snapshotRestore && provenance.selectedIds.length !== files.length) {
    fail('INVALID_HISTORY', 'snapshot restore provenance 与 files 数量不一致');
  }
  const baseRecord = {
    id: raw.id,
    kind: 'application',
    changeSetId: changeSetId(raw.changeSetId),
    status: raw.status,
    appliedAt: timestamp(raw.appliedAt, 'appliedAt'),
    files,
    ...(raw.review !== undefined ? { review: validateReviewAudit(raw.review) } : {}),
    provenance,
    ...(raw.undoneAt !== undefined ? { undoneAt: timestamp(raw.undoneAt, 'undoneAt') } : {}),
  };
  if (baseRecord.status === 'undone' && !baseRecord.undoneAt) fail('INVALID_HISTORY', '已撤销记录缺少时间');
  const integrityPayload = schema === LEGACY_HISTORY_SCHEMA ? (() => {
    const { kind: _kind, review: _review, provenance: _provenance, ...v1 } = baseRecord;
    return v1;
  })() : schema === PREVIOUS_HISTORY_SCHEMA ? (() => {
    const { provenance: _provenance, ...v2 } = baseRecord;
    return v2;
  })() : legacyOrdinaryV4 ? {
    ...baseRecord,
    files: baseRecord.files.map(file => {
      const { ancestorIdentityDigest: _ancestorIdentityDigest, ...legacyFile } = file;
      return legacyFile;
    }),
  } : baseRecord;
  if (raw.integrity !== integrityFor(integrityPayload)) fail('INVALID_HISTORY', '历史记录完整性校验失败');
  if (schema === HISTORY_SCHEMA) {
    const record = legacyOrdinaryV4
      ? withIntegrity(baseRecord)
      : { ...baseRecord, integrity: raw.integrity };
    if (snapshotRestore) {
      const evidenceFiles = record.files.map(file => ({
        path: file.path,
        summary: file.summary,
        before: file.before,
        after: file.after,
        createdIdentityDigest: file.createdIdentityDigest,
      }));
      const evidenceRecord = { ...record, files: evidenceFiles };
      try { evidenceDeliverySchema.assertSnapshotRestoreHistoryBudget(evidenceFiles, evidenceRecord); } catch (error) {
        if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
          fail('INVALID_HISTORY', 'snapshot restore History 预算或结构无效');
        }
        throw error;
      }
      const proof = { schema: HISTORY_SCHEMA, entries: [record] };
      if (evidenceDeliverySchema.canonicalJsonByteLength(proof) >
          evidenceDeliverySchema.SNAPSHOT_RESTORE_HISTORY_LIMITS.maxCanonicalRecordBytes) {
        fail('INVALID_HISTORY', 'snapshot restore History canonical record 超过安全上限');
      }
    }
    return record;
  }
  const migrated = {
    ...baseRecord,
    files: baseRecord.files.map(file => ({
      path: file.path,
      summary: file.summary,
      before: v4FileStateFromContent(file.before.content, file.before.revision),
      after: v4FileStateFromContent(file.after.content, file.after.revision),
      createdIdentityDigest: null,
      ancestorIdentityDigest: null,
    })),
  };
  return withIntegrity(migrated);
}

function validateReviewRecord(raw, schema = HISTORY_SCHEMA) {
  if (!raw || typeof raw !== 'object' || !ENTRY_ID_RE.test(raw.id || '') || raw.kind !== 'review' ||
      raw.status !== 'reviewed' || !Array.isArray(raw.files) || raw.files.length) {
    fail('INVALID_HISTORY', '审阅历史结构无效');
  }
  const review = validateReviewAudit(raw.review);
  if (review.acceptedHunkIds.length || !review.rejectedHunkIds.length) {
    fail('INVALID_HISTORY', '仅拒绝审阅历史的决策无效');
  }
  if (schema === HISTORY_SCHEMA) {
    exactKeys(raw, [
      'id', 'kind', 'changeSetId', 'status', 'reviewedAt', 'files',
      'review', 'provenance', 'integrity',
    ], 'v4 review entry');
  }
  const provenanceRequired = [PREVIOUS_V3_HISTORY_SCHEMA, HISTORY_SCHEMA].includes(schema);
  const record = {
    id: raw.id,
    kind: 'review',
    changeSetId: changeSetId(raw.changeSetId),
    status: 'reviewed',
    reviewedAt: timestamp(raw.reviewedAt, 'reviewedAt'),
    files: [],
    review,
    provenance: provenanceRequired
      ? (() => {
        if (!Object.hasOwn(raw, 'provenance')) fail('INVALID_HISTORY', '历史记录缺少 provenance');
        return validateProvenance(raw.provenance);
      })()
      : null,
  };
  if (record.changeSetId !== review.sourceChangeSetId) fail('INVALID_HISTORY', '审阅历史 ChangeSet 身份不一致');
  const integrityPayload = schema === PREVIOUS_HISTORY_SCHEMA ? (() => {
    const { provenance: _provenance, ...v2 } = record;
    return v2;
  })() : record;
  if (raw.integrity !== integrityFor(integrityPayload)) fail('INVALID_HISTORY', '历史记录完整性校验失败');
  return schema === HISTORY_SCHEMA ? { ...record, integrity: raw.integrity } : withIntegrity(record);
}

function validateRecord(raw, schema = HISTORY_SCHEMA) {
  if (raw?.kind === 'application') return validateApplicationRecord(raw, schema);
  if (raw?.kind === 'review') return validateReviewRecord(raw, schema);
  fail('INVALID_HISTORY', '历史记录类型无效');
}

function emptyHistory() {
  return { schema: HISTORY_SCHEMA, entries: [] };
}

function validateHistory(raw) {
  if (!raw || typeof raw !== 'object' ||
      ![HISTORY_SCHEMA, PREVIOUS_V3_HISTORY_SCHEMA, PREVIOUS_HISTORY_SCHEMA, LEGACY_HISTORY_SCHEMA].includes(raw.schema) ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > MAX_HISTORY_ENTRIES) {
    fail('INVALID_HISTORY', 'Changes 历史 schema 或结构无效');
  }
  if (raw.schema === HISTORY_SCHEMA) {
    exactKeys(raw, ['schema', 'entries'], 'changes/v4 document');
  } else {
    exactKeys(raw, ['schema', 'updatedAt', 'entries'], 'legacy changes document');
    timestamp(raw.updatedAt, 'updatedAt');
  }
  const seen = new Set();
  const validateEntry = entry => {
    const valid = raw.schema === LEGACY_HISTORY_SCHEMA
      ? validateApplicationRecord(entry, LEGACY_HISTORY_SCHEMA)
      : validateRecord(entry, raw.schema);
    if (seen.has(valid.id)) fail('INVALID_HISTORY', 'Changes 历史 ID 重复');
    seen.add(valid.id);
    return valid;
  };
  let entries;
  if (raw.schema === HISTORY_SCHEMA && raw.entries.length) {
    entries = raw.entries.map(validateEntry);
    const normalized = { schema: HISTORY_SCHEMA, entries };
    try {
      evidenceDeliverySchema.assertChangesV4DocumentEnvelope(normalized, entry => {
        validateRecord(entry, HISTORY_SCHEMA);
        return true;
      });
    } catch (error) {
      if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
        fail(error.code === 'CHANGES_V4_BUDGET_EXCEEDED' ? 'HISTORY_TOO_LARGE' : 'INVALID_HISTORY',
          'changes/v4 document envelope 无效');
      }
      throw error;
    }
  } else {
    entries = raw.entries.map(validateEntry);
    if (raw.schema === HISTORY_SCHEMA &&
        evidenceDeliverySchema.canonicalJsonByteLength(raw) > MAX_HISTORY_BYTES) {
      fail('HISTORY_TOO_LARGE', 'Changes 历史超过安全上限');
    }
  }
  return { schema: HISTORY_SCHEMA, entries };
}

function loadHistory(rootPath) {
  const location = historyLocation(rootPath, false);
  if (!location.exists) return emptyHistory();
  const stat = fs.statSync(location.file);
  if (stat.size > MAX_HISTORY_BYTES) fail('HISTORY_TOO_LARGE', 'Changes 历史超过安全上限');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(location.file, 'utf8')); } catch (_) {
    fail('HISTORY_CORRUPT', 'Changes 历史损坏，已阻止修改以保护撤销链');
  }
  return validateHistory(raw);
}

function loadHistoryState(rootPath) {
  const location = historyLocation(rootPath, false);
  return {
    exists: location.exists,
    history: location.exists ? loadHistory(rootPath) : emptyHistory(),
  };
}

function validateHistoryState(state, field = 'historyState') {
  if (!state || typeof state !== 'object' || typeof state.exists !== 'boolean') {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  const history = validateHistory(state.history);
  if (!state.exists && history.entries.length) {
    fail('INVALID_HISTORY', `${field} 不存在却包含记录`);
  }
  return { exists: state.exists, history };
}

function digestHistoryState(rawState) {
  const state = exactDataRecord(
    rawState,
    ['exists', 'history'],
    'terminalHistoryState'
  );
  const valid = validateHistoryState(state, 'terminalHistoryState');
  const historyDigest = evidenceDeliverySchema.digestObject(
    HISTORY_SCHEMA,
    valid.history
  );
  return evidenceDeliverySchema.digestObject(TERMINAL_HISTORY_STATE_SCHEMA, {
    schema: TERMINAL_HISTORY_STATE_SCHEMA,
    exists: valid.exists,
    historyDigest,
  });
}

function sameHistoryState(left, right) {
  return left.exists === right.exists &&
    (!left.exists || JSON.stringify(left.history) === JSON.stringify(right.history));
}

function assertExpectedHistoryState(rootPath, expectedState) {
  const expected = validateHistoryState(expectedState, 'expectedHistoryState');
  const current = loadHistoryState(rootPath);
  if (!sameHistoryState(current, expected)) {
    fail('HISTORY_CONFLICT', 'Changes 历史已被其他操作修改');
  }
  return current;
}

function serializedHistory(history) {
  const valid = validateHistory(history);
  const serialized = `${JSON.stringify(valid, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HISTORY_BYTES) fail('HISTORY_TOO_LARGE', 'Changes 历史超过安全上限');
  return { valid, serialized };
}

function saveHistory(rootPath, history, options = {}) {
  const { valid, serialized } = serializedHistory(history);
  const expectedState = options.expectedState;
  if (expectedState !== undefined) assertExpectedHistoryState(rootPath, expectedState);
  const location = historyLocation(rootPath, true);
  atomicWrite(location.file, serialized, {
    beforeRename: expectedState === undefined
      ? options.beforeRenameAuthority
      : () => {
        assertExpectedHistoryState(rootPath, expectedState);
        if (typeof options.beforeRenameAuthority === 'function') {
          options.beforeRenameAuthority();
        }
      },
  });
  return valid;
}

function restoreHistoryState(rootPath, state, options = {}) {
  const target = validateHistoryState(state);
  const expectedState = options.expectedState;
  if (expectedState !== undefined) assertExpectedHistoryState(rootPath, expectedState);
  if (target.exists) return saveHistory(rootPath, target.history, {
    expectedState,
    beforeRenameAuthority: options.beforeRenameAuthority,
  });
  const location = historyLocation(rootPath, false);
  if (!location.exists) {
    // A recovery retry may be proving a prior deletion whose directory fsync
    // failed. Re-fsync the containing metadata directory even when the target
    // is already absent; visible absence alone is not a durability proof.
    if (fs.existsSync(path.dirname(location.file))) {
      syncDirectory(path.dirname(location.file));
    }
    return { exists: false, history: emptyHistory() };
  }
  const stat = fs.lstatSync(location.file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail('UNSAFE_HISTORY_PATH', 'changes.json 必须是独占普通文件');
  }
  const backup = fs.readFileSync(location.file, 'utf8');
  try {
    if (expectedState !== undefined) assertExpectedHistoryState(rootPath, expectedState);
    const latest = fs.lstatSync(location.file);
    if (latest.dev !== stat.dev || latest.ino !== stat.ino || latest.nlink !== 1) {
      fail('HISTORY_CONFLICT', 'Changes 历史在删除前发生变化');
    }
    fs.unlinkSync(location.file);
    syncDirectory(path.dirname(location.file));
  } catch (error) {
    if (!fs.existsSync(location.file)) {
      try { atomicWrite(location.file, backup); } catch (_) {}
    }
    throw error;
  }
  return { exists: false, history: emptyHistory() };
}

function withIntegrity(record) {
  return { ...record, integrity: integrityFor(record) };
}

function appendBounded(history, record) {
  let entries = [...history.entries, withIntegrity(record)];
  if (entries.length > MAX_HISTORY_ENTRIES) entries = entries.slice(entries.length - MAX_HISTORY_ENTRIES);
  let candidate = { schema: HISTORY_SCHEMA, entries };
  while (entries.length > 1) {
    try {
      serializedHistory(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof ChangeHistoryError) || error.code !== 'HISTORY_TOO_LARGE') throw error;
      entries = entries.slice(1);
      candidate = { schema: HISTORY_SCHEMA, entries };
    }
  }
  serializedHistory(candidate);
  return candidate;
}

function rollbackWrites(projectService, rootPath, written, targetField) {
  const rolledBack = [];
  const rollbackFailed = [];
  for (const item of [...written].reverse()) {
    try {
      const target = item.file[targetField];
      const result = projectService.atomicWriteFile(rootPath, item.file.path, stateContent(target), item.revision);
      rolledBack.push({ path: item.file.path, revision: result.revision });
    } catch (error) {
      rollbackFailed.push({ path: item.file.path, error });
    }
  }
  return { rolledBack, rollbackFailed };
}

function prepareApplication(rootPath, changeSet, options = {}) {
  const baseHistoryState = loadHistoryState(rootPath);
  const history = baseHistoryState.history; // fail closed before touching正文
  const validChangeSet = changeSetService.validateChangeSet(changeSet);
  const review = options.review !== undefined ? validateReviewAudit(options.review) : null;
  const provenance = validateProvenance(options.provenance === undefined ? null : options.provenance);
  if (review && !review.acceptedHunkIds.length) {
    fail('INVALID_HISTORY', '正文应用历史必须包含已接受的修改块');
  }
  const record = {
    id: `change_${crypto.randomUUID()}`,
    kind: 'application',
    changeSetId: validChangeSet.id,
    status: 'applied',
    appliedAt: new Date().toISOString(),
    files: validChangeSet.changes.map(change => ({
      path: change.path,
      summary: change.summary,
      before: {
        ...v4FileStateFromContent(change.before, change.expectedRevision),
      },
      after: {
        // ProjectService revisions are SHA-256 content hashes, so the final
        // revision is known before applying and history capacity can be
        // checked without touching manuscript files.
        ...v4FileStateFromContent(change.after),
      },
      createdIdentityDigest: null,
      ancestorIdentityDigest: null,
    })),
    ...(review ? { review } : {}),
    provenance,
  };
  const nextHistory = appendBounded(history, record);
  // Serialization is the exact size/integrity gate used by saveHistory.
  serializedHistory(nextHistory);
  return {
    kind: 'apply',
    files: record.files.map(file => ({
      path: file.path,
      before: { revision: file.before.revision, content: stateContent(file.before) },
      after: { revision: file.after.revision, content: stateContent(file.after) },
    })),
    changeSet: validChangeSet,
    baseHistoryState,
    preparedHistoryState: { exists: true, history: nextHistory },
    record: withIntegrity(record),
  };
}

function prepareSnapshotRestoreHistory(rootPath, files, provenance, options = {}) {
  const baseHistoryState = loadHistoryState(rootPath);
  const history = baseHistoryState.history;
  if (!Array.isArray(files)) fail('INVALID_HISTORY', 'snapshot restore History files 无效');
  const sealedFiles = files.map((file, index) => exactDataRecord(file, [
    'path', 'summary', 'before', 'after', 'createdIdentityDigest', 'ancestorIdentityDigest',
  ], `snapshot restore History files[${index}]`));
  const record = {
    id: options.id || `change_${crypto.randomUUID()}`,
    kind: 'application',
    changeSetId: options.changeSetId || `cs_${crypto.randomBytes(12).toString('hex')}`,
    status: 'applied',
    appliedAt: options.appliedAt || new Date().toISOString(),
    files: sealedFiles,
    provenance,
  };
  const validRecord = validateApplicationRecord(withIntegrity(record), HISTORY_SCHEMA);
  const nextHistory = appendBounded(history, recordPayload(validRecord));
  serializedHistory(nextHistory);
  return {
    kind: 'snapshot_restore',
    files: validRecord.files,
    baseHistoryState,
    preparedHistoryState: { exists: true, history: nextHistory },
    record: validRecord,
  };
}

function validateSnapshotRestoreHistoryTemplate(raw) {
  exactKeys(raw, [
    'schema', 'id', 'changeSetId', 'appliedAt', 'files', 'provenance',
  ], 'snapshot restore History template');
  if (raw.schema !== SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA ||
      !ENTRY_ID_RE.test(raw.id || '') || !CHANGESET_ID_RE.test(raw.changeSetId || '') ||
      !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 300) {
    fail('INVALID_HISTORY', 'snapshot restore History template identity invalid');
  }
  timestamp(raw.appliedAt, 'appliedAt');
  const placeholder = `sha256:${'0'.repeat(64)}`;
  const normalizedFiles = raw.files.map((file, index) => {
    const fileData = exactDataRecord(file, [
      'path', 'summary', 'before', 'after', 'createdIdentityDigest', 'ancestorIdentityDigest',
    ], `snapshot restore History template files[${index}]`);
    if (fileData.createdIdentityDigest !== null) {
      fail('INVALID_HISTORY', 'snapshot restore History template identity must be null');
    }
    if (!SHA256_RE.test(fileData.ancestorIdentityDigest || '')) {
      fail('INVALID_HISTORY', 'snapshot restore History template ancestor identity invalid');
    }
    const candidate = {
      path: fileData.path,
      summary: fileData.summary,
      before: fileData.before,
      after: fileData.after,
      createdIdentityDigest: fileData.before?.exists === false ? placeholder : null,
    };
    try {
      evidenceDeliverySchema.assertSnapshotRestoreHistoryFile(
        candidate,
        `snapshot restore History template files[${index}]`
      );
    } catch (error) {
      if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
        fail('INVALID_HISTORY', 'snapshot restore History template file invalid');
      }
      throw error;
    }
    return {
      path: publicMarkdownPath(candidate.path),
      summary: candidate.summary,
      before: persistedV4State(validateV4FileState(
        candidate.before,
        `snapshot restore History template files[${index}].before`,
        { snapshotRestore: true }
      )),
      after: persistedV4State(validateV4FileState(
        candidate.after,
        `snapshot restore History template files[${index}].after`,
        { snapshotRestore: true }
      )),
      createdIdentityDigest: candidate.createdIdentityDigest,
      ancestorIdentityDigest: fileData.ancestorIdentityDigest,
    };
  });
  const normalizedProvenance = validateProvenance(raw.provenance);
  const provisional = withIntegrity({
    id: raw.id,
    kind: 'application',
    changeSetId: raw.changeSetId,
    status: 'applied',
    appliedAt: raw.appliedAt,
    files: normalizedFiles,
    provenance: normalizedProvenance,
  });
  const valid = validateApplicationRecord(provisional, HISTORY_SCHEMA);
  return Object.freeze({
    schema: SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA,
    id: valid.id,
    changeSetId: valid.changeSetId,
    appliedAt: valid.appliedAt,
    files: Object.freeze(valid.files.map(file => Object.freeze({
      ...file,
      createdIdentityDigest: null,
    }))),
    provenance: valid.provenance,
  });
}

function prepareSnapshotRestoreHistoryTemplate(rootPath, files, provenance, options = {}) {
  const baseHistoryState = loadHistoryState(rootPath);
  const template = validateSnapshotRestoreHistoryTemplate({
    schema: SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA,
    id: options.id || `change_${crypto.randomUUID()}`,
    changeSetId: options.changeSetId || `cs_${crypto.randomBytes(12).toString('hex')}`,
    appliedAt: options.appliedAt || new Date().toISOString(),
    files,
    provenance,
  });
  return Object.freeze({
    kind: 'snapshot_restore_template',
    files: template.files,
    baseHistoryState,
    historyTemplate: template,
    historyTemplateDigest: evidenceDeliverySchema.digestObject(
      SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA,
      template
    ),
  });
}

function materializeSnapshotRestoreHistoryTemplate(baseHistoryState, rawTemplate, rawIdentities) {
  const template = validateSnapshotRestoreHistoryTemplate(rawTemplate);
  if (!baseHistoryState || typeof baseHistoryState.exists !== 'boolean') {
    fail('INVALID_HISTORY', 'snapshot restore template base History invalid');
  }
  const baseHistory = validateHistory(baseHistoryState.history);
  if (!baseHistoryState.exists && baseHistory.entries.length) {
    fail('INVALID_HISTORY', 'absent template base History cannot contain entries');
  }
  if (!Array.isArray(rawIdentities) || Object.getPrototypeOf(rawIdentities) !== Array.prototype) {
    fail('INVALID_HISTORY', 'created identities invalid');
  }
  const arrayDescriptors = Object.getOwnPropertyDescriptors(rawIdentities);
  const identityCount = arrayDescriptors.length?.value;
  if (!Number.isSafeInteger(identityCount) || identityCount < 0 || identityCount > 300 ||
      Reflect.ownKeys(rawIdentities).length !== identityCount + 1) {
    fail('INVALID_HISTORY', 'created identities must be a dense plain array');
  }
  const identities = new Map();
  for (let index = 0; index < identityCount; index += 1) {
    const arrayDescriptor = arrayDescriptors[String(index)];
    if (!arrayDescriptor || arrayDescriptor.enumerable !== true ||
        !Object.hasOwn(arrayDescriptor, 'value') || Object.hasOwn(arrayDescriptor, 'get') ||
        Object.hasOwn(arrayDescriptor, 'set')) {
      fail('INVALID_HISTORY', 'created identities must be dense plain data');
    }
    const item = arrayDescriptor.value;
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.getPrototypeOf(item) !== Object.prototype) {
      fail('INVALID_HISTORY', 'created identity must be a plain record');
    }
    const itemKeys = Reflect.ownKeys(item);
    if (itemKeys.length !== 2 || itemKeys.some(key => typeof key !== 'string') ||
        !itemKeys.includes('path') || !itemKeys.includes('createdIdentityDigest')) {
      fail('INVALID_HISTORY', 'created identity fields invalid');
    }
    const itemDescriptors = Object.getOwnPropertyDescriptors(item);
    const readData = key => {
      const descriptor = itemDescriptors[key];
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
          Object.hasOwn(descriptor, 'set')) {
        fail('INVALID_HISTORY', `created identity.${key} must be plain data`);
      }
      return descriptor.value;
    };
    const filePath = publicMarkdownPath(readData('path'));
    const createdIdentityDigest = readData('createdIdentityDigest');
    if (!SHA256_RE.test(createdIdentityDigest || '') || identities.has(filePath)) {
      fail('INVALID_HISTORY', 'created identity invalid or duplicate');
    }
    identities.set(filePath, createdIdentityDigest);
  }
  const files = template.files.map(file => {
    const creates = file.before.exists === false;
    const createdIdentityDigest = identities.get(file.path) || null;
    if (creates !== (createdIdentityDigest !== null)) {
      fail('INVALID_HISTORY', 'created identity set does not match missing leaves');
    }
    return { ...file, createdIdentityDigest };
  });
  if (identities.size !== files.filter(file => file.before.exists === false).length) {
    fail('INVALID_HISTORY', 'created identity set contains foreign path');
  }
  const validRecord = validateApplicationRecord(withIntegrity({
    id: template.id,
    kind: 'application',
    changeSetId: template.changeSetId,
    status: 'applied',
    appliedAt: template.appliedAt,
    files,
    provenance: template.provenance,
  }), HISTORY_SCHEMA);
  const nextHistory = appendBounded(baseHistory, recordPayload(validRecord));
  serializedHistory(nextHistory);
  return Object.freeze({
    kind: 'snapshot_restore',
    files: validRecord.files,
    baseHistoryState: { exists: baseHistoryState.exists, history: baseHistory },
    preparedHistoryState: { exists: true, history: nextHistory },
    record: validRecord,
  });
}

function exactDenseArrayValues(value, field, maximum = 300) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('INVALID_HISTORY', `${field} 必须是稠密普通数组`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > maximum ||
      Reflect.ownKeys(value).length !== length + 1) {
    fail('INVALID_HISTORY', `${field} 数量或结构无效`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      fail('INVALID_HISTORY', `${field}[${index}] 必须是普通数据项`);
    }
    return descriptor.value;
  });
}

function exactSnapshotState(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_HISTORY', `${field} 无效`);
  }
  const existsDescriptor = Object.getOwnPropertyDescriptor(value, 'exists');
  if (!existsDescriptor || !Object.hasOwn(existsDescriptor, 'value')) {
    fail('INVALID_HISTORY', `${field}.exists 必须是普通数据字段`);
  }
  return exactDataRecord(value, existsDescriptor.value === true
    ? ['exists', 'revision', 'contentHash', 'byteLength', 'encoding', 'data']
    : ['exists', 'revision', 'contentHash', 'byteLength', 'encoding', 'data'], field);
}

function rawHistoryAuthority(rawBytes, expectedExists = true) {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length > MAX_HISTORY_BYTES ||
      (!expectedExists && rawBytes.length !== 0)) {
    fail('INVALID_HISTORY', 'raw base History authority invalid');
  }
  let history;
  if (expectedExists) {
    try { history = validateHistory(JSON.parse(rawBytes.toString('utf8'))); }
    catch (error) {
      if (error instanceof ChangeHistoryError) throw error;
      fail('INVALID_HISTORY', 'raw base History is invalid');
    }
  } else {
    history = emptyHistory();
  }
  return Object.freeze({
    exists: expectedExists,
    history,
    digest: sha256(Buffer.concat([Buffer.from([expectedExists ? 1 : 0]), rawBytes])),
  });
}

function validateSnapshotRestoreUndoHistoryTemplate(raw) {
  const value = exactDataRecord(raw, [
    'schema', 'id', 'changeSetId', 'status', 'appliedAt', 'undoneAt',
    'files', 'provenance', 'baseHistoryState',
  ], 'snapshot restore undo History template');
  if (value.schema !== SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA ||
      value.status !== 'undone' || !ENTRY_ID_RE.test(value.id || '') ||
      !CHANGESET_ID_RE.test(value.changeSetId || '')) {
    fail('INVALID_HISTORY', 'snapshot restore undo History template identity invalid');
  }
  timestamp(value.appliedAt, 'appliedAt');
  timestamp(value.undoneAt, 'undoneAt');
  const baseHistoryState = exactDataRecord(
    value.baseHistoryState,
    ['exists', 'digest'],
    'snapshot restore undo History template.baseHistoryState'
  );
  if (baseHistoryState.exists !== true || !REVISION_RE.test(baseHistoryState.digest || '')) {
    fail('INVALID_HISTORY', 'snapshot restore undo base History binding invalid');
  }
  const files = exactDenseArrayValues(value.files, 'snapshot restore undo History template.files')
    .map((rawFile, index) => {
      const file = exactDataRecord(rawFile, [
        'path', 'summary', 'before', 'after', 'createdIdentityDigest',
        'ancestorIdentityDigest',
      ], `snapshot restore undo History template.files[${index}]`);
      const before = exactSnapshotState(
        file.before,
        `snapshot restore undo History template.files[${index}].before`
      );
      const after = exactSnapshotState(
        file.after,
        `snapshot restore undo History template.files[${index}].after`
      );
      const snapshotFile = {
        path: file.path,
        summary: file.summary,
        before,
        after,
        createdIdentityDigest: file.createdIdentityDigest,
      };
      try {
        evidenceDeliverySchema.assertSnapshotRestoreHistoryFile(
          snapshotFile,
          `snapshot restore undo History template.files[${index}]`
        );
      } catch (error) {
        if (error instanceof evidenceDeliverySchema.EvidenceDeliverySchemaError) {
          fail('INVALID_HISTORY', 'snapshot restore undo History template file invalid');
        }
        throw error;
      }
      if (!SHA256_RE.test(file.ancestorIdentityDigest || '')) {
        fail('INVALID_HISTORY', 'snapshot restore undo ancestor identity invalid');
      }
      return {
        path: publicMarkdownPath(file.path),
        summary: file.summary,
        before: persistedV4State(validateV4FileState(before, `undo template.files[${index}].before`, {
          snapshotRestore: true,
        })),
        after: persistedV4State(validateV4FileState(after, `undo template.files[${index}].after`, {
          snapshotRestore: true,
        })),
        createdIdentityDigest: file.createdIdentityDigest,
        ancestorIdentityDigest: file.ancestorIdentityDigest,
      };
    });
  const provenance = validateProvenance(value.provenance);
  const valid = validateApplicationRecord(withIntegrity({
    id: value.id,
    kind: 'application',
    changeSetId: value.changeSetId,
    status: 'undone',
    appliedAt: value.appliedAt,
    files,
    provenance,
    undoneAt: value.undoneAt,
  }), HISTORY_SCHEMA);
  const template = Object.freeze({
    schema: SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA,
    id: valid.id,
    changeSetId: valid.changeSetId,
    status: 'undone',
    appliedAt: valid.appliedAt,
    undoneAt: valid.undoneAt,
    files: Object.freeze(valid.files.map(file => Object.freeze({ ...file }))),
    provenance: valid.provenance,
    baseHistoryState: Object.freeze({ ...baseHistoryState }),
  });
  if (evidenceDeliverySchema.canonicalJsonByteLength(template) >
      MAX_SNAPSHOT_UNDO_HISTORY_TEMPLATE_BYTES) {
    fail('INVALID_HISTORY', 'snapshot restore undo History template exceeds preparedDelta budget');
  }
  return template;
}

function materializeSnapshotRestoreUndoHistoryTemplate(rawBaseHistoryBytes, rawTemplate) {
  const template = validateSnapshotRestoreUndoHistoryTemplate(rawTemplate);
  const base = rawHistoryAuthority(rawBaseHistoryBytes, template.baseHistoryState.exists);
  if (base.digest !== template.baseHistoryState.digest) {
    fail('INVALID_HISTORY', 'snapshot restore undo raw base History drifted');
  }
  const index = base.history.entries.findIndex(entry => entry.id === template.id);
  const entry = base.history.entries[index];
  if (!entry || entry.kind !== 'application' || entry.status !== 'applied' ||
      entry.changeSetId !== template.changeSetId || entry.appliedAt !== template.appliedAt ||
      evidenceDeliverySchema.canonicalJson(entry.files) !==
        evidenceDeliverySchema.canonicalJson(template.files) ||
      evidenceDeliverySchema.canonicalJson(entry.provenance) !==
        evidenceDeliverySchema.canonicalJson(template.provenance)) {
    fail('INVALID_HISTORY', 'snapshot restore undo template does not match base record');
  }
  const record = validateApplicationRecord(withIntegrity({
    ...recordPayload(entry),
    status: 'undone',
    undoneAt: template.undoneAt,
  }), HISTORY_SCHEMA);
  const preparedHistory = {
    schema: HISTORY_SCHEMA,
    entries: base.history.entries.map((item, itemIndex) =>
      itemIndex === index ? record : item),
  };
  const serialized = serializedHistory(preparedHistory);
  const bytes = Buffer.from(serialized.serialized, 'utf8');
  const digest = sha256(Buffer.concat([Buffer.from([1]), bytes]));
  return Object.freeze({
    kind: 'snapshot_restore_undo_history',
    entryId: record.id,
    record,
    baseHistoryState: Object.freeze({ exists: true, history: base.history }),
    preparedHistoryState: Object.freeze({ exists: true, history: serialized.valid }),
    preparedHistoryBytes: bytes,
    preparedHistoryDigest: digest,
  });
}

function prepareSnapshotRestoreUndoHistory(rootPath, entryId, options = {}) {
  if (typeof entryId !== 'string' || !ENTRY_ID_RE.test(entryId)) {
    fail('INVALID_HISTORY_ID', '撤销记录 ID 无效');
  }
  const location = historyLocation(rootPath, false);
  if (!location.exists) fail('HISTORY_NOT_FOUND', '找不到这条 Changes 历史');
  const rawBaseHistoryBytes = fs.readFileSync(location.file);
  const rawBase = rawHistoryAuthority(rawBaseHistoryBytes, true);
  const baseHistoryState = { exists: true, history: rawBase.history };
  const history = rawBase.history;
  const index = history.entries.findIndex(entry => entry.id === entryId);
  if (index === -1) fail('HISTORY_NOT_FOUND', '找不到这条 Changes 历史');
  const entry = history.entries[index];
  if (entry.kind !== 'application' ||
      entry.provenance?.schema !== SNAPSHOT_RESTORE_PROVENANCE_SCHEMA) {
    fail('HISTORY_NOT_UNDOABLE', '这不是 Snapshot 恢复记录');
  }
  if (entry.status !== 'applied') fail('HISTORY_ALREADY_UNDONE', '这条修改已经撤销');
  const undoneAt = options.undoneAt || new Date().toISOString();
  timestamp(undoneAt, 'undoneAt');
  const historyTemplate = validateSnapshotRestoreUndoHistoryTemplate({
    schema: SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA,
    id: entry.id,
    changeSetId: entry.changeSetId,
    status: 'undone',
    appliedAt: entry.appliedAt,
    undoneAt,
    files: entry.files,
    provenance: entry.provenance,
    baseHistoryState: { exists: true, digest: rawBase.digest },
  });
  const materialized = materializeSnapshotRestoreUndoHistoryTemplate(
    rawBaseHistoryBytes,
    historyTemplate
  );
  return Object.freeze({
    kind: 'snapshot_restore_undo_history',
    entryId,
    record: materialized.record,
    baseHistoryState,
    preparedHistoryState: materialized.preparedHistoryState,
    historyTemplate,
    historyTemplateDigest: evidenceDeliverySchema.digestObject(
      SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA,
      historyTemplate
    ),
    preparedHistoryDigest: materialized.preparedHistoryDigest,
  });
}

function executePreparedApplication(projectService, rootPath, prepared, options = {}) {
  const result = changeSetService.applyAll(projectService, rootPath, prepared.changeSet);
  if (!result.ok) return result;
  try {
    if (typeof options.saveHistory === 'function') {
      options.saveHistory(rootPath, prepared.preparedHistoryState.history);
    } else {
      saveHistory(rootPath, prepared.preparedHistoryState.history, {
        expectedState: prepared.baseHistoryState,
      });
    }
  } catch (error) {
    const written = prepared.record.files.map(file => ({ file, revision: file.after.revision }));
    const rollback = rollbackWrites(projectService, rootPath, written, 'before');
    return {
      ok: false,
      status: rollback.rollbackFailed.length ? 'history_failed_rollback_failed' : 'history_failed_rolled_back',
      error,
      applied: result.applied,
      ...rollback,
    };
  }
  return {
    ...result,
    historyEntry: publicRecord(prepared.record),
  };
}

function applyAndRecord(projectService, rootPath, changeSet, options = {}) {
  const prepared = prepareApplication(rootPath, changeSet, options);
  return executePreparedApplication(projectService, rootPath, prepared, options);
}

function publicRecord(record) {
  if (record.kind === 'review') {
    return {
      id: record.id,
      kind: 'review',
      changeSetId: record.changeSetId,
      status: record.status,
      reviewedAt: record.reviewedAt,
      files: [],
      review: record.review,
      provenance: validateProvenance(record.provenance),
    };
  }
  return {
    id: record.id,
    kind: 'application',
    changeSetId: record.changeSetId,
    status: record.status,
    appliedAt: record.appliedAt,
    ...(record.undoneAt ? { undoneAt: record.undoneAt } : {}),
    ...(record.review ? { review: record.review } : {}),
    provenance: validateProvenance(record.provenance),
    files: record.files.map(file => ({
      path: file.path,
      summary: file.summary,
      beforeRevision: file.before.revision,
      beforeHash: file.before.contentHash,
      afterRevision: file.after.revision,
      afterHash: file.after.contentHash,
      ...(file.undoRevision ? { undoRevision: file.undoRevision } : {}),
      ...(record.status === 'undone' ? { undoRevision: file.before.revision } : {}),
    })),
  };
}

function prepareReviewDecision(rootPath, sourceChangeSetId, review, options = {}) {
  const baseHistoryState = loadHistoryState(rootPath);
  const history = baseHistoryState.history;
  const validSourceId = changeSetId(sourceChangeSetId, 'sourceChangeSetId');
  const validReview = validateReviewAudit(review);
  const provenance = validateProvenance(options.provenance === undefined ? null : options.provenance);
  if (validReview.sourceChangeSetId !== validSourceId || validReview.acceptedHunkIds.length ||
      !validReview.rejectedHunkIds.length) {
    fail('INVALID_HISTORY', '仅拒绝审阅记录无效');
  }
  const record = {
    id: `change_${crypto.randomUUID()}`,
    kind: 'review',
    changeSetId: validSourceId,
    status: 'reviewed',
    reviewedAt: new Date().toISOString(),
    files: [],
    review: validReview,
    provenance,
  };
  const nextHistory = appendBounded(history, record);
  serializedHistory(nextHistory);
  return {
    kind: 'review',
    files: [],
    baseHistoryState,
    preparedHistoryState: { exists: true, history: nextHistory },
    record: withIntegrity(record),
  };
}

function executePreparedReview(rootPath, prepared, options = {}) {
  if (typeof options.saveHistory === 'function') {
    options.saveHistory(rootPath, prepared.preparedHistoryState.history);
  } else {
    saveHistory(rootPath, prepared.preparedHistoryState.history, {
      expectedState: prepared.baseHistoryState,
    });
  }
  return publicRecord(prepared.record);
}

function recordReviewDecision(rootPath, sourceChangeSetId, review, options = {}) {
  const prepared = prepareReviewDecision(rootPath, sourceChangeSetId, review, options);
  return executePreparedReview(rootPath, prepared, options);
}

function listHistory(rootPath) {
  const history = loadHistory(rootPath);
  return history.entries.slice().reverse().map(publicRecord);
}

function prepareUndo(projectService, rootPath, entryId) {
  if (typeof entryId !== 'string' || !ENTRY_ID_RE.test(entryId)) fail('INVALID_HISTORY_ID', '撤销记录 ID 无效');
  const baseHistoryState = loadHistoryState(rootPath);
  const history = baseHistoryState.history;
  const index = history.entries.findIndex(entry => entry.id === entryId);
  if (index === -1) fail('HISTORY_NOT_FOUND', '找不到这条 Changes 历史');
  const entry = history.entries[index];
  if (entry.kind !== 'application') fail('HISTORY_NOT_UNDOABLE', '审阅决定不包含可撤销的正文修改');
  if (entry.status !== 'applied') fail('HISTORY_ALREADY_UNDONE', '这条修改已经撤销');
  if (entry.provenance?.schema === SNAPSHOT_RESTORE_PROVENANCE_SCHEMA) {
    fail('SNAPSHOT_RESTORE_UNDO_REQUIRED', 'Snapshot 恢复必须通过专用安全撤销事务');
  }

  const snapshots = [];
  for (const file of entry.files) {
    let current;
    try { current = projectService.readFileWithRevision(rootPath, file.path); } catch (error) {
      return { ok: false, status: 'preflight_failed', path: file.path, error, applied: [], rolledBack: [] };
    }
    if (current.revision !== file.after.revision || sha256(current.content) !== file.after.contentHash) {
      return { ok: false, status: 'conflict', path: file.path, applied: [], rolledBack: [] };
    }
    snapshots.push({ path: file.path, content: current.content, revision: current.revision });
  }
  const reverse = changeSetService.createChangeSet(snapshots, entry.files.map(file => ({
    path: file.path,
    after: stateContent(file.before),
    summary: `撤销：${file.summary || file.path}`,
  })));
  const updated = {
    ...entry,
    status: 'undone',
    undoneAt: new Date().toISOString(),
    files: entry.files.map(file => ({ ...file })),
  };
  const preparedHistory = {
    ...history,
    entries: history.entries.map((item, itemIndex) =>
      itemIndex === index ? withIntegrity(recordPayload(updated)) : item),
  };
  serializedHistory(preparedHistory);
  return {
    kind: 'undo',
    files: entry.files.map(file => ({
      path: file.path,
      before: { revision: file.after.revision, content: stateContent(file.after) },
      after: { revision: file.before.revision, content: stateContent(file.before) },
    })),
    changeSet: reverse,
    baseHistoryState,
    preparedHistoryState: { exists: true, history: preparedHistory },
    entryId,
  };
}

function executePreparedUndo(projectService, rootPath, prepared, options = {}) {
  const result = changeSetService.applyAll(projectService, rootPath, prepared.changeSet);
  if (!result.ok) return result;

  const history = prepared.preparedHistoryState.history;
  const index = history.entries.findIndex(entry => entry.id === prepared.entryId);
  const entry = history.entries[index];
  const updated = withIntegrity(recordPayload({ ...entry }));
  history.entries[index] = updated;
  try {
    if (typeof options.saveHistory === 'function') {
      options.saveHistory(rootPath, history);
    } else {
      saveHistory(rootPath, history, {
        expectedState: prepared.baseHistoryState,
      });
    }
  } catch (error) {
    // Restore the applied content if marking the audit record as undone cannot
    // be committed. This preserves agreement between disk and history.
    const written = updated.files.map(file => ({ file, revision: file.before.revision }));
    const rollback = rollbackWrites(projectService, rootPath, written, 'after');
    return {
      ok: false,
      status: rollback.rollbackFailed.length ? 'history_failed_rollback_failed' : 'history_failed_rolled_back',
      error,
      applied: result.applied,
      ...rollback,
    };
  }
  return {
    ...result,
    status: 'undone',
    historyEntry: publicRecord(history.entries[index]),
  };
}

function undoChange(projectService, rootPath, entryId, options = {}) {
  const prepared = prepareUndo(projectService, rootPath, entryId);
  if (prepared && prepared.ok === false) return prepared;
  return executePreparedUndo(projectService, rootPath, prepared, options);
}

module.exports = {
  LEGACY_HISTORY_SCHEMA,
  PREVIOUS_HISTORY_SCHEMA,
  PREVIOUS_V3_HISTORY_SCHEMA,
  HISTORY_SCHEMA,
  TERMINAL_HISTORY_STATE_SCHEMA,
  HISTORY_RELATIVE_PATH,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_BYTES,
  MAX_PROVENANCE_BYTES,
  MAX_SNAPSHOT_UNDO_HISTORY_TEMPLATE_BYTES,
  RESEARCH_PROVENANCE_SCHEMA,
  INLINE_REWRITE_PROVENANCE_SCHEMA,
  SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
  SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA,
  SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA,
  ChangeHistoryError,
  validateProvenance,
  validateHistory,
  digestHistoryState,
  loadHistory,
  loadHistoryState,
  saveHistory,
  restoreHistoryState,
  listHistory,
  applyAndRecord,
  prepareApplication,
  prepareSnapshotRestoreHistory,
  validateSnapshotRestoreHistoryTemplate,
  prepareSnapshotRestoreHistoryTemplate,
  materializeSnapshotRestoreHistoryTemplate,
  validateSnapshotRestoreUndoHistoryTemplate,
  materializeSnapshotRestoreUndoHistoryTemplate,
  prepareSnapshotRestoreUndoHistory,
  executePreparedApplication,
  recordReviewDecision,
  prepareReviewDecision,
  executePreparedReview,
  undoChange,
  prepareUndo,
  executePreparedUndo,
};
