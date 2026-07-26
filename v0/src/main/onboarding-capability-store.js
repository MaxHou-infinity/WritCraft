'use strict';

const crypto = require('crypto');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 8;
const REVIEW_ID_RE = /^obr_[a-f0-9]{32}$/;
const CONFIRMATION_TOKEN_RE = /^oct_[a-f0-9]{32}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const CHANGESET_ID_RE = /^pc_[a-f0-9]{32}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const MAX_FILE_SUGGESTIONS = 12;
const MAX_PATH_BYTES = 512;
const MAX_TITLE_CHARS = 120;
const MAX_TITLE_BYTES = 256;
const MAX_REASON_CHARS = 500;
const MAX_REASON_BYTES = 1024;
const CAPABILITY_STORES = new WeakSet();

class OnboardingCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnboardingCapabilityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnboardingCapabilityError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactObject(value, keys, code = 'INVALID_RECORD') {
  if (!isPlainObject(value)) fail(code, '项目建立授权记录无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, '项目建立授权记录包含未知或缺失字段');
  }
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_ROOT', '项目根目录无效');
  }
  return path.resolve(value);
}

function normalizeProjectInstanceId(value) {
  if (typeof value !== 'string' || !PROJECT_INSTANCE_ID_RE.test(value)) {
    fail('INVALID_PROJECT', '项目实例标识无效');
  }
  return value;
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_GENERATION', '项目修改世代无效');
  return value;
}

function normalizeRevision(value, field) {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) fail('INVALID_REVISION', `${field} revision 无效`);
  return value;
}

function normalizeDigest(value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('INVALID_DIGEST', '项目提案摘要无效');
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function normalizeChangeSetId(value) {
  if (typeof value !== 'string' || !CHANGESET_ID_RE.test(value)) fail('INVALID_CHANGESET', 'ChangeSet capability 无效');
  return value;
}

function safeSuggestionPath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value !== value.normalize('NFC') ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(value) || value.includes('\\') || value.includes('//') ||
      Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
      value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    fail('INVALID_SUGGESTION_PATH', '初始文件必须使用 NFC 规范的项目内 POSIX 相对路径');
  }
  const parts = value.split('/');
  const normalized = parts.join('/');
  const lower = normalized.toLocaleLowerCase('en-US');
  if (lower === 'edit.md' || lower.startsWith('.writcraft/') || lower.startsWith('references/') || lower.startsWith('sources/')) {
    fail('PROTECTED_SUGGESTION_PATH', '初始文件建议不得指向项目 Prompt、私有目录或来源目录');
  }
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('INVALID_SUGGESTION_PATH', '初始文件路径必须是非隐藏 Markdown 文件');
  }
  return normalized;
}

function boundedText(value, field, maxChars, maxBytes) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0') || /[\r\n]/.test(value) ||
      Array.from(value).length > maxChars || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail('INVALID_SUGGESTION', `${field} 为空或超过大小限制`);
  }
  return value;
}

function normalizeSuggestions(value) {
  if (!Array.isArray(value) || value.length > MAX_FILE_SUGGESTIONS) {
    fail('INVALID_SUGGESTIONS', `初始文件建议必须是最多 ${MAX_FILE_SUGGESTIONS} 项的数组`);
  }
  const seen = new Set();
  return Object.freeze(value.map((raw, index) => {
    exactObject(raw, ['path', 'title', 'reason'], 'INVALID_SUGGESTION');
    const filePath = safeSuggestionPath(raw.path);
    const identity = filePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(identity)) fail('DUPLICATE_SUGGESTION', `初始文件建议路径重复：${filePath}`);
    for (const prior of seen) {
      if (identity.startsWith(`${prior}/`) || prior.startsWith(`${identity}/`)) {
        fail('DUPLICATE_SUGGESTION', '初始文件建议存在文件/父目录冲突');
      }
    }
    seen.add(identity);
    return Object.freeze({
      path: filePath,
      title: boundedText(raw.title, `fileSuggestions[${index}].title`, MAX_TITLE_CHARS, MAX_TITLE_BYTES),
      reason: boundedText(raw.reason, `fileSuggestions[${index}].reason`, MAX_REASON_CHARS, MAX_REASON_BYTES),
    });
  }));
}

function normalizeBinding(raw, options = {}) {
  const keys = [
    'projectInstanceId', 'rootPath', 'mutationGeneration', 'baseEditRevision',
    'expectedAppliedRevision', 'proposalDigest', 'fileSuggestions',
  ];
  if (options.withChangeSet) keys.push('changeSetId');
  exactObject(raw, keys);
  const baseEditRevision = normalizeRevision(raw.baseEditRevision, 'base edit.md');
  const expectedAppliedRevision = normalizeRevision(raw.expectedAppliedRevision, 'expected edit.md');
  if (options.noOp && baseEditRevision !== expectedAppliedRevision) {
    fail('INVALID_NOOP', 'no-op 授权的 edit.md revision 必须保持不变');
  }
  return Object.freeze({
    projectInstanceId: normalizeProjectInstanceId(raw.projectInstanceId),
    rootPath: normalizeRoot(raw.rootPath),
    mutationGeneration: normalizeGeneration(raw.mutationGeneration),
    baseEditRevision,
    expectedAppliedRevision,
    proposalDigest: normalizeDigest(raw.proposalDigest),
    fileSuggestions: normalizeSuggestions(raw.fileSuggestions),
    ...(options.withChangeSet ? { changeSetId: normalizeChangeSetId(raw.changeSetId) } : {}),
  });
}

function opaqueId(prefix, randomBytes) {
  const value = `${prefix}${randomBytes(16).toString('hex')}`;
  const pattern = prefix === 'obr_' ? REVIEW_ID_RE : CONFIRMATION_TOKEN_RE;
  if (!pattern.test(value)) fail('ID_FACTORY_FAILED', '无法生成不透明项目建立授权');
  return value;
}

function createOnboardingCapabilityStore(options = {}) {
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const records = new Map();

  function purgeExpired() {
    const timestamp = now();
    for (const [id, record] of records) {
      if (timestamp - record.createdAt >= ttlMs) records.delete(id);
    }
  }

  function insert(id, record) {
    purgeExpired();
    if (records.has(id)) fail('CAPABILITY_COLLISION', '项目建立授权发生冲突');
    records.set(id, Object.freeze({ ...record, createdAt: now() }));
    while (records.size > maxEntries) records.delete(records.keys().next().value);
    return id;
  }

  function take(id, kind, pattern) {
    purgeExpired();
    if (typeof id !== 'string' || !pattern.test(id)) fail('INVALID_CAPABILITY', '项目建立授权格式无效');
    const record = records.get(id);
    if (!record || record.kind !== kind) fail('CAPABILITY_NOT_FOUND', '项目建立授权不存在、已过期或已使用');
    records.delete(id);
    records.set(id, record);
    return record;
  }

  function bindingMatches(record, raw, options = {}) {
    const rootPath = normalizeRoot(raw.rootPath);
    const projectInstanceId = normalizeProjectInstanceId(raw.projectInstanceId);
    const mutationGeneration = normalizeGeneration(raw.mutationGeneration);
    const proposalDigest = normalizeDigest(raw.proposalDigest);
    const editRevision = normalizeRevision(raw.editRevision, 'current edit.md');
    const matches = record.projectInstanceId === projectInstanceId && record.rootPath === rootPath &&
      record.mutationGeneration === mutationGeneration && record.proposalDigest === proposalDigest &&
      record.expectedAppliedRevision === editRevision;
    if (!matches && options.invalidateId) records.delete(options.invalidateId);
    return matches;
  }

  function createReview(raw) {
    const binding = normalizeBinding(raw, { withChangeSet: true });
    if (binding.baseEditRevision === binding.expectedAppliedRevision) {
      fail('NOOP_REQUIRES_TOKEN', 'no-op 提案必须使用独立授权入口');
    }
    const id = opaqueId('obr_', randomBytes);
    return insert(id, { kind: 'review', ...binding });
  }

  function completeReview(reviewId, raw) {
    exactObject(raw, [
      'projectInstanceId', 'rootPath', 'mutationGeneration', 'changeSetId',
      'editRevision', 'proposalDigest', 'appliedPaths', 'residual',
    ], 'INVALID_APPLICATION');
    const record = take(reviewId, 'review', REVIEW_ID_RE);
    let valid = false;
    try {
      const appliedPaths = raw.appliedPaths;
      const appliedProject = normalizeProjectInstanceId(raw.projectInstanceId);
      const appliedRoot = normalizeRoot(raw.rootPath);
      const appliedGeneration = normalizeGeneration(raw.mutationGeneration);
      const appliedRevision = normalizeRevision(raw.editRevision, 'applied edit.md');
      const appliedDigest = normalizeDigest(raw.proposalDigest);
      valid = raw.residual === false && Array.isArray(appliedPaths) && appliedPaths.length === 1 &&
        appliedPaths[0] === 'edit.md' && normalizeChangeSetId(raw.changeSetId) === record.changeSetId &&
        appliedProject === record.projectInstanceId && appliedRoot === record.rootPath &&
        appliedGeneration === record.mutationGeneration + 1 &&
        appliedRevision === record.expectedAppliedRevision && appliedDigest === record.proposalDigest;
    } catch (error) {
      records.delete(reviewId);
      throw error;
    }
    records.delete(reviewId);
    if (!valid) fail('INCOMPLETE_APPLICATION', 'edit.md 提案未被精确、完整应用，授权已失效');
    const token = opaqueId('oct_', randomBytes);
    return insert(token, {
      kind: 'confirmation',
      projectInstanceId: record.projectInstanceId,
      rootPath: record.rootPath,
      // Applying edit.md is one authoritative Main mutation. Confirmation is
      // bound to that post-commit generation, not to the generation at which
      // the review was prepared.
      mutationGeneration: raw.mutationGeneration,
      baseEditRevision: record.baseEditRevision,
      expectedAppliedRevision: record.expectedAppliedRevision,
      proposalDigest: record.proposalDigest,
      fileSuggestions: record.fileSuggestions,
      source: 'review',
    });
  }

  function createNoOp(raw) {
    const binding = normalizeBinding(raw, { noOp: true });
    const token = opaqueId('oct_', randomBytes);
    return insert(token, { kind: 'confirmation', ...binding, source: 'no_op' });
  }

  function consume(token, raw) {
    exactObject(raw, [
      'projectInstanceId', 'rootPath', 'mutationGeneration', 'editRevision',
      'proposalDigest', 'selectedPaths',
    ], 'INVALID_CONFIRMATION');
    const record = take(token, 'confirmation', CONFIRMATION_TOKEN_RE);
    let current;
    try { current = bindingMatches(record, raw, { invalidateId: token }); }
    catch (error) {
      records.delete(token);
      throw error;
    }
    if (!current) fail('STALE_CONFIRMATION', '项目、revision 或提案已变化，确认授权已失效');
    if (!Array.isArray(raw.selectedPaths) || raw.selectedPaths.length > record.fileSuggestions.length) {
      fail('INVALID_SELECTION', '初始文件选择无效');
    }
    const selectedIdentities = new Set();
    const byPath = new Map(record.fileSuggestions.map(item => [item.path, item]));
    const selected = [];
    for (const selectedPath of raw.selectedPaths) {
      if (typeof selectedPath !== 'string') fail('INVALID_SELECTION', '初始文件选择无效');
      const identity = selectedPath.toLocaleLowerCase('en-US');
      if (selectedIdentities.has(identity) || !byPath.has(selectedPath)) {
        fail('INVALID_SELECTION', '初始文件选择必须唯一且属于当前提案');
      }
      selectedIdentities.add(identity);
      selected.push(byPath.get(selectedPath));
    }
    records.delete(token);
    return Object.freeze({
      source: record.source,
      projectInstanceId: record.projectInstanceId,
      rootPath: record.rootPath,
      mutationGeneration: record.mutationGeneration,
      // This is the actual edit.md revision revalidated by consume. Review
      // confirmations bind it to expectedAppliedRevision; no-op bindings make
      // base and expected revisions identical.
      editRevision: record.expectedAppliedRevision,
      proposalDigest: record.proposalDigest,
      fileSuggestions: Object.freeze(selected),
    });
  }

  function invalidate(id) {
    if (typeof id !== 'string') return false;
    return records.delete(id);
  }

  function invalidateByProject(projectInstanceId, rootPath = null) {
    const project = normalizeProjectInstanceId(projectInstanceId);
    const root = rootPath === null ? null : normalizeRoot(rootPath);
    let count = 0;
    for (const [id, record] of records) {
      if (record.projectInstanceId === project && (root === null || record.rootPath === root)) {
        records.delete(id);
        count += 1;
      }
    }
    return count;
  }

  function invalidateByChangeSet(changeSetId) {
    const capability = normalizeChangeSetId(changeSetId);
    let count = 0;
    for (const [id, record] of records) {
      if (record.kind === 'review' && record.changeSetId === capability) {
        records.delete(id);
        count += 1;
      }
    }
    return count;
  }

  function hasActive(id, kind) {
    purgeExpired();
    const pattern = kind === 'review' ? REVIEW_ID_RE
      : kind === 'confirmation' ? CONFIRMATION_TOKEN_RE
        : null;
    if (!pattern || typeof id !== 'string' || !pattern.test(id)) return false;
    return records.get(id)?.kind === kind;
  }

  function activeCountsByProject(projectInstanceId, rootPath) {
    const project = normalizeProjectInstanceId(projectInstanceId);
    const root = normalizeRoot(rootPath);
    purgeExpired();
    let review = 0;
    let confirmation = 0;
    for (const record of records.values()) {
      if (record.projectInstanceId !== project || record.rootPath !== root) continue;
      if (record.kind === 'review') review += 1;
      else if (record.kind === 'confirmation') confirmation += 1;
    }
    return Object.freeze({ review, confirmation });
  }

  const store = Object.freeze({
    createReview,
    completeReview,
    createNoOp,
    consume,
    invalidate,
    invalidateByProject,
    invalidateByChangeSet,
    hasActive,
    activeCountsByProject,
    purgeExpired,
    get size() { purgeExpired(); return records.size; },
  });
  CAPABILITY_STORES.add(store);
  return store;
}

function isOnboardingCapabilityStore(value) {
  return Boolean(value && typeof value === 'object' && CAPABILITY_STORES.has(value));
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MAX_FILE_SUGGESTIONS,
  MAX_PATH_BYTES,
  MAX_TITLE_CHARS,
  MAX_TITLE_BYTES,
  MAX_REASON_CHARS,
  MAX_REASON_BYTES,
  REVIEW_ID_RE,
  CONFIRMATION_TOKEN_RE,
  OnboardingCapabilityError,
  normalizeSuggestions,
  createOnboardingCapabilityStore,
  isOnboardingCapabilityStore,
};
