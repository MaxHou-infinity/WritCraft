'use strict';

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 10;
const CAPABILITY_RE = /^pc_[a-f0-9]{32}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const GRAPH_ID_RE = /^graph_[a-f0-9]{32}$/;
const BINDING_ID_RE = /^gih_[a-f0-9]{24}$/;
const ISSUE_ID_RE = /^issue_[A-Za-z0-9_-]{1,120}$/;
const ISSUE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_ID_RE = /^ev_[a-f0-9]{16}$/;
const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const BLOCK_ID_RE = /^blk_[a-f0-9]{16}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const RESEARCH_RUN_ID_RE = /^rr_[a-f0-9]{24}$/;
const RESEARCH_CARD_ID_RE = /^rc_[a-f0-9]{32}$/;
const SOURCE_ID_RE = /^src_[a-f0-9]{20}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const MAX_ISSUE_DEPENDENCIES_BYTES = 64 * 1024;
const MAX_RESEARCH_DEPENDENCIES_BYTES = 32 * 1024;
const MAX_PROJECT_DEPENDENCIES = 17;

class PendingChangeSetStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PendingChangeSetStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PendingChangeSetStoreError(code, message);
}

function normalizeDependencies(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) fail('INVALID_DEPENDENCIES', 'Plan dependencies 必须是数组');
  return Object.freeze(value.map(item => {
    if (!item || typeof item.path !== 'string' || typeof item.revision !== 'string') {
      fail('INVALID_DEPENDENCIES', 'Plan dependency 无效');
    }
    return Object.freeze({ path: item.path, revision: item.revision });
  }));
}

function normalizeProjectDependencies(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || !value.length || value.length > MAX_PROJECT_DEPENDENCIES) {
    fail('INVALID_PROJECT_DEPENDENCIES', '普通 Changes 依赖必须是 1–17 个文件的数组');
  }
  const seen = new Set();
  let targetCount = 0;
  const dependencies = value.map(item => {
    const filePath = markdownPath(item?.path);
    const role = item?.role;
    const lowerPath = String(filePath || '').toLocaleLowerCase('en-US');
    if (!exactKeys(item, ['path', 'revision', 'role']) || !filePath || seen.has(filePath) ||
        !REVISION_RE.test(item.revision || '') || !['project_prompt', 'context', 'target'].includes(role) ||
        (role === 'target' && (lowerPath === 'edit.md' || lowerPath.startsWith('references/') || lowerPath.startsWith('sources/')))) {
      fail('INVALID_PROJECT_DEPENDENCIES', '普通 Changes 依赖文件无效');
    }
    if (role === 'project_prompt' && lowerPath !== 'edit.md') {
      fail('INVALID_PROJECT_DEPENDENCIES', '项目 Prompt 依赖必须是 edit.md');
    }
    seen.add(filePath);
    if (role === 'target') targetCount += 1;
    return Object.freeze({ path: filePath, revision: item.revision, role });
  });
  if (!targetCount || targetCount > 8) {
    fail('INVALID_PROJECT_DEPENDENCIES', '普通 Changes 必须绑定 1–8 个可修改目标');
  }
  return Object.freeze(dependencies);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function markdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.includes('//') ||
      value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return null;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) return null;
  return parts.join('/');
}

function canonicalPathKey(value) {
  return String(value || '').normalize('NFC').toLocaleLowerCase('en-US');
}

function normalizeResearchDependencies(value, capability, rootPath) {
  if (value == null) return null;
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { serialized = null; }
  const keys = ['schema', 'projectInstanceId', 'rootPath', 'runId', 'cardId', 'bindingDigest', 'source', 'edit', 'targets', 'expiresAt', 'issuedCapability'];
  if (!exactKeys(value, keys) || value.schema !== 'writcraft.research-handoff/v1' ||
      typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_RESEARCH_DEPENDENCIES_BYTES ||
      !PROJECT_INSTANCE_ID_RE.test(value.projectInstanceId || '') || value.rootPath !== rootPath ||
      !RESEARCH_RUN_ID_RE.test(value.runId || '') || !RESEARCH_CARD_ID_RE.test(value.cardId || '') ||
      !SHA256_RE.test(value.bindingDigest || '') || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0 ||
      value.issuedCapability !== capability || !CAPABILITY_RE.test(value.issuedCapability || '')) {
    fail('INVALID_RESEARCH_DEPENDENCIES', 'Research 依赖无效');
  }
  const sourceKeys = ['id', 'path', 'revision', 'offset', 'end', 'quote', 'gradeDigest'];
  const sourcePath = markdownPath(value.source?.path);
  if (!exactKeys(value.source, sourceKeys) || !SOURCE_ID_RE.test(value.source.id || '') || !sourcePath ||
      !REVISION_RE.test(value.source.revision || '') || !Number.isSafeInteger(value.source.offset) ||
      !Number.isSafeInteger(value.source.end) || value.source.offset < 0 || value.source.end <= value.source.offset ||
      typeof value.source.quote !== 'string' || !value.source.quote || value.source.quote.length > 2000 ||
      value.source.end - value.source.offset !== value.source.quote.length || !SHA256_RE.test(value.source.gradeDigest || '')) {
    fail('INVALID_RESEARCH_DEPENDENCIES', 'Research 来源依赖无效');
  }
  const editPath = markdownPath(value.edit?.path);
  if (!exactKeys(value.edit, ['path', 'revision']) || canonicalPathKey(editPath) !== 'edit.md' ||
      !REVISION_RE.test(value.edit.revision || '')) {
    fail('INVALID_RESEARCH_DEPENDENCIES', 'Research edit.md 依赖无效');
  }
  if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 8) {
    fail('INVALID_RESEARCH_DEPENDENCIES', 'Research 目标依赖无效');
  }
  const seen = new Set();
  const sourceKey = canonicalPathKey(sourcePath);
  const targets = value.targets.map(item => {
    const targetPath = markdownPath(item?.path);
    const key = canonicalPathKey(targetPath);
    if (!exactKeys(item, ['path', 'revision']) || !targetPath || !REVISION_RE.test(item.revision || '') ||
        seen.has(key) || key === sourceKey || key === 'edit.md' || key.startsWith('references/') || key.startsWith('sources/')) {
      fail(key === sourceKey ? 'SOURCE_TARGET_CONFLICT' : 'INVALID_RESEARCH_DEPENDENCIES',
        key === sourceKey ? 'Research 来源不能同时作为写入目标' : 'Research 目标依赖无效');
    }
    seen.add(key);
    return Object.freeze({ path: targetPath.normalize('NFC'), revision: item.revision });
  });
  return Object.freeze({
    schema: 'writcraft.research-handoff/v1',
    projectInstanceId: value.projectInstanceId,
    rootPath: value.rootPath,
    runId: value.runId,
    cardId: value.cardId,
    bindingDigest: value.bindingDigest,
    source: Object.freeze({
      id: value.source.id,
      path: sourcePath.normalize('NFC'),
      revision: value.source.revision,
      offset: value.source.offset,
      end: value.source.end,
      quote: value.source.quote,
      gradeDigest: value.source.gradeDigest,
    }),
    edit: Object.freeze({ path: editPath.normalize('NFC'), revision: value.edit.revision }),
    targets: Object.freeze(targets),
    expiresAt: value.expiresAt,
    issuedCapability: value.issuedCapability,
  });
}

function normalizeIssueDependencies(value) {
  if (value == null) return null;
  let serialized;
  try { serialized = JSON.stringify(value); } catch (_) { serialized = null; }
  const keys = ['schema', 'projectInstanceId', 'issueId', 'graphIdentity', 'bindingId', 'issueDigest', 'evidence', 'targets'];
  if (!exactKeys(value, keys) || value.schema !== 'writcraft.graph-issue-handoff/v1' ||
      typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_ISSUE_DEPENDENCIES_BYTES ||
      !PROJECT_INSTANCE_ID_RE.test(value.projectInstanceId || '') ||
      !ISSUE_ID_RE.test(value.issueId || '') || !GRAPH_ID_RE.test(value.graphIdentity || '') ||
      !BINDING_ID_RE.test(value.bindingId || '') || !ISSUE_DIGEST_RE.test(value.issueDigest || '') ||
      !Array.isArray(value.evidence) || value.evidence.length > 100 ||
      !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 16) {
    fail('INVALID_ISSUE_DEPENDENCIES', '图谱问题依赖无效');
  }
  const evidenceIds = new Set();
  const evidence = value.evidence.map(item => {
    const path = markdownPath(item?.path);
    if (!exactKeys(item, ['id', 'path', 'revision', 'contentHash', 'blockId', 'start', 'end', 'quote']) ||
        !EVIDENCE_ID_RE.test(item.id || '') || evidenceIds.has(item.id) || !path ||
        !REVISION_RE.test(item.revision || '') || !CONTENT_HASH_RE.test(item.contentHash || '') ||
        !BLOCK_ID_RE.test(item.blockId || '') || !Number.isSafeInteger(item.start) ||
        !Number.isSafeInteger(item.end) || item.start < 0 || item.end < item.start ||
        typeof item.quote !== 'string' || item.quote.length > 240 || item.end - item.start !== item.quote.length) {
      fail('INVALID_ISSUE_DEPENDENCIES', '图谱问题证据依赖无效');
    }
    evidenceIds.add(item.id);
    return Object.freeze({
      id: item.id, path, revision: item.revision, contentHash: item.contentHash,
      blockId: item.blockId, start: item.start, end: item.end, quote: item.quote,
    });
  });
  const targetPaths = new Set();
  const targets = value.targets.map(item => {
    const path = markdownPath(item?.path);
    const lowerPath = String(path || '').toLocaleLowerCase('en-US');
    if (!exactKeys(item, ['path', 'revision']) || !path || lowerPath === 'edit.md' ||
        lowerPath.startsWith('references/') || lowerPath.startsWith('sources/') ||
        targetPaths.has(path) || !REVISION_RE.test(item.revision || '')) {
      fail('INVALID_ISSUE_DEPENDENCIES', '图谱问题目标依赖无效');
    }
    targetPaths.add(path);
    return Object.freeze({ path, revision: item.revision });
  });
  const evidencePaths = new Map(evidence.map(item => [item.path, item.revision]));
  if (targets.some(target => evidencePaths.get(target.path) !== target.revision)) {
    fail('INVALID_ISSUE_DEPENDENCIES', '图谱问题目标未与证据 revision 绑定');
  }
  return Object.freeze({
    schema: 'writcraft.graph-issue-handoff/v1',
    projectInstanceId: value.projectInstanceId,
    issueId: value.issueId,
    graphIdentity: value.graphIdentity,
    bindingId: value.bindingId,
    issueDigest: value.issueDigest,
    evidence: Object.freeze(evidence),
    targets: Object.freeze(targets),
  });
}

function normalizeFileSelectionPolicies(value) {
  if (value == null) return Object.freeze({});
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('INVALID_SELECTION_POLICIES', '文件审阅策略必须是普通对象');
  }
  const normalized = {};
  for (const [filePath, policy] of Object.entries(value)) {
    if (typeof filePath !== 'string' || !filePath || !['hunk', 'file'].includes(policy)) {
      fail('INVALID_SELECTION_POLICIES', '文件审阅策略无效');
    }
    normalized[filePath] = policy;
  }
  return Object.freeze(normalized);
}

function cloneMetadata(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object') fail('INVALID_PROVENANCE', 'Changes 来源信息无效');
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    const freeze = item => {
      if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
      Object.values(item).forEach(freeze);
      return Object.freeze(item);
    };
    return freeze(cloned);
  } catch (_) {
    fail('INVALID_PROVENANCE', 'Changes 来源信息不可序列化');
  }
}

function capabilityFromUuid(value) {
  const compact = String(value || '').replace(/-/g, '').toLocaleLowerCase('en-US');
  const capability = `pc_${compact}`;
  if (!CAPABILITY_RE.test(capability)) fail('INVALID_CAPABILITY_SOURCE', '无法创建待审阅能力令牌');
  return capability;
}

function createPendingChangeSetStore(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : DEFAULT_MAX_ENTRIES;
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID();
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const onRemove = typeof options.onRemove === 'function' ? options.onRemove : null;
  const records = new Map();

  function notifyRemove(capability, record, reason) {
    if (!onRemove || !record) return;
    try { onRemove({ capability, record, reason }); } catch (_) {}
  }

  function remove(capability, reason) {
    const record = records.get(capability);
    if (!record || !records.delete(capability)) return false;
    notifyRemove(capability, record, reason);
    return true;
  }

  function pruneExpired() {
    const now = clock();
    for (const [capability, record] of records) {
      if (Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now) remove(capability, 'expired');
    }
  }

  function allocateCapability() {
    pruneExpired();
    let capability;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      capability = capabilityFromUuid(idFactory());
      if (!records.has(capability)) break;
      capability = null;
    }
    if (!capability) fail('CAPABILITY_COLLISION', '无法分配唯一待审阅能力令牌');
    return capability;
  }

  function putWithCapability(capability, changeSet, rootPath, metadata = {}) {
    pruneExpired();
    if (!CAPABILITY_RE.test(String(capability || '')) || records.has(capability)) {
      fail('INVALID_CAPABILITY', '待审阅能力令牌无效或已被使用');
    }
    if (!changeSet || typeof changeSet.id !== 'string' || typeof rootPath !== 'string' || !rootPath) {
      fail('INVALID_PENDING_CHANGESET', '待审阅 ChangeSet 无效');
    }
    const issueDependencies = normalizeIssueDependencies(metadata.issueDependencies);
    const researchDependencies = normalizeResearchDependencies(metadata.researchDependencies, capability, rootPath);
    if (researchDependencies && researchDependencies.expiresAt <= clock()) {
      fail('RESEARCH_CAPABILITY_EXPIRED', 'Research 审阅能力已过期');
    }
    if (issueDependencies && metadata.requireCompleteDecision !== true) {
      fail('INVALID_ISSUE_DEPENDENCIES', '图谱问题修改必须完整决策所有修改块');
    }
    records.set(capability, Object.freeze({
      changeSet,
      rootPath,
      planDependencies: normalizeDependencies(metadata.planDependencies),
      projectDependencies: normalizeProjectDependencies(metadata.projectDependencies),
      issueDependencies,
      researchDependencies,
      expiresAt: researchDependencies?.expiresAt || null,
      requireCompleteDecision: metadata.requireCompleteDecision === true,
      selectionPolicy: metadata.selectionPolicy === 'file' ? 'file' : 'hunk',
      fileSelectionPolicies: normalizeFileSelectionPolicies(metadata.fileSelectionPolicies),
      provenance: cloneMetadata(metadata.provenance),
    }));
    while (records.size > maxEntries) remove(records.keys().next().value, 'evicted');
    return capability;
  }

  function put(changeSet, rootPath, metadata = {}) {
    return putWithCapability(allocateCapability(), changeSet, rootPath, metadata);
  }

  return Object.freeze({
    allocateCapability,
    putWithCapability,
    put,
    get(capability) { pruneExpired(); return CAPABILITY_RE.test(String(capability || '')) ? records.get(capability) : undefined; },
    delete(capability, reason = 'deleted') { return CAPABILITY_RE.test(String(capability || '')) && remove(capability, reason); },
    clear(reason = 'cleared') { for (const capability of [...records.keys()]) remove(capability, reason); },
    clearExcept(capability, reason = 'cleared') {
      for (const candidate of [...records.keys()]) {
        if (candidate !== capability) remove(candidate, reason);
      }
    },
    has(capability) { pruneExpired(); return CAPABILITY_RE.test(String(capability || '')) && records.has(capability); },
    get size() { pruneExpired(); return records.size; },
  });
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  CAPABILITY_RE,
  MAX_ISSUE_DEPENDENCIES_BYTES,
  MAX_RESEARCH_DEPENDENCIES_BYTES,
  MAX_PROJECT_DEPENDENCIES,
  PendingChangeSetStoreError,
  capabilityFromUuid,
  normalizeProjectDependencies,
  normalizeIssueDependencies,
  normalizeResearchDependencies,
  createPendingChangeSetStore,
};
