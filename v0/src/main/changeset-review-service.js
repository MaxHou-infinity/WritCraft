'use strict';

// Main-owned review orchestration for a ChangeSet. Renderer callers only send
// opaque hunk IDs. All patch material, paths, revisions and manuscript text are
// recovered from the canonical ChangeSet held by Main.

const crypto = require('crypto');
const changeSetService = require('./changeset-service');
const defaultHistoryService = require('./change-history-service');

const REVIEW_SCHEMA = 'writcraft.changes-review/v1';
const DECISION_SCHEMA = 'writcraft.changes-decision/v1';
const MAX_DECISION_BYTES = 64 * 1024;
const HUNK_ID_RE = /^hk_[a-f0-9]{24}$/;
const REVIEW_ID_RE = /^(?:cs_[a-f0-9]{24}|pc_[a-f0-9]{32})$/;

class ChangeSetReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangeSetReviewError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangeSetReviewError(code, message);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DECISION', 'Changes 决策无效');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_DECISION', 'Changes 决策包含未知或缺失字段');
  }
}

function selectionPolicy(options = {}) {
  const policy = options.selectionPolicy === undefined ? 'hunk' : options.selectionPolicy;
  if (!['hunk', 'file'].includes(policy)) fail('INVALID_REVIEW_POLICY', 'Changes 审阅策略无效');
  return policy;
}

function fileSelectionPolicies(validChangeSet, options = {}) {
  const fallback = selectionPolicy(options);
  const raw = options.fileSelectionPolicies;
  if (raw === undefined) return new Map(validChangeSet.changes.map(change => [change.path, fallback]));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    fail('INVALID_REVIEW_POLICY', 'Changes 文件审阅策略无效');
  }
  const paths = new Set(validChangeSet.changes.map(change => change.path));
  for (const [path, policy] of Object.entries(raw)) {
    if (!paths.has(path) || !['hunk', 'file'].includes(policy)) {
      fail('INVALID_REVIEW_POLICY', `Changes 文件审阅策略无效：${path}`);
    }
  }
  return new Map(validChangeSet.changes.map(change => [change.path, raw[change.path] || fallback]));
}

function createReview(changeSet, options = {}) {
  const valid = changeSetService.validateChangeSet(changeSet);
  const policies = fileSelectionPolicies(valid, options);
  const reviewId = options.reviewId === undefined ? valid.id : options.reviewId;
  if (typeof reviewId !== 'string' || !REVIEW_ID_RE.test(reviewId)) {
    fail('INVALID_REVIEW_ID', 'Changes 审阅身份无效');
  }
  const files = changeSetService.preview(valid, { structured: true }).map(file => ({
    ...file,
    selectionPolicy: policies.get(file.path),
  }));
  const uniquePolicies = new Set(files.map(file => file.selectionPolicy));
  const totalHunks = files.reduce((total, file) => total + file.hunks.length, 0);
  if (totalHunks > changeSetService.MAX_CHANGE_HUNKS) {
    fail('TOO_MANY_HUNKS', `单个 ChangeSet 最多包含 ${changeSetService.MAX_CHANGE_HUNKS} 个修改块`);
  }
  const review = {
    schema: REVIEW_SCHEMA,
    // Main may replace the canonical content hash with a one-time pc_* handle.
    // The capability is the only identity Renderer should send back.
    changeSetId: reviewId,
    selectionPolicy: uniquePolicies.size > 1 ? 'mixed' : (uniquePolicies.values().next().value || selectionPolicy(options)),
    totalFiles: files.length,
    totalHunks,
    files,
  };
  if (Buffer.byteLength(JSON.stringify(review), 'utf8') > changeSetService.MAX_REVIEW_BYTES) {
    fail('REVIEW_TOO_LARGE', `Changes 审阅不能超过 ${changeSetService.MAX_REVIEW_BYTES} 字节`);
  }
  return review;
}

function validateIdList(value, field) {
  if (!Array.isArray(value) || value.length > changeSetService.MAX_CHANGE_HUNKS) {
    fail('INVALID_DECISION', `${field} 无效`);
  }
  const seen = new Set();
  return value.map(id => {
    if (typeof id !== 'string' || !HUNK_ID_RE.test(id)) fail('INVALID_HUNK_ID', `${field} 包含无效修改块 ID`);
    if (seen.has(id)) fail('DUPLICATE_HUNK', `修改块重复：${id}`);
    seen.add(id);
    return id;
  });
}

function validateDecision(changeSet, decision, options = {}) {
  const review = createReview(changeSet, options);
  let serialized;
  try { serialized = JSON.stringify(decision); } catch (_) { fail('INVALID_DECISION', 'Changes 决策不可序列化'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_DECISION_BYTES) {
    fail('DECISION_TOO_LARGE', `Changes 决策不能超过 ${MAX_DECISION_BYTES} 字节`);
  }
  exactObject(decision, ['schema', 'changeSetId', 'acceptHunkIds', 'rejectHunkIds']);
  if (decision.schema !== DECISION_SCHEMA || !REVIEW_ID_RE.test(decision.changeSetId || '')) {
    fail('INVALID_DECISION', 'Changes 决策 schema 或 ChangeSet ID 无效');
  }
  if (decision.changeSetId !== review.changeSetId) fail('STALE_CHANGESET', 'Changes 决策不属于当前 ChangeSet');
  const acceptHunkIds = validateIdList(decision.acceptHunkIds, 'acceptHunkIds');
  const rejectHunkIds = validateIdList(decision.rejectHunkIds, 'rejectHunkIds');
  if (!acceptHunkIds.length && !rejectHunkIds.length && options.requireCompleteDecision !== true) {
    fail('NO_DECISIONS', '请至少接受或拒绝一个修改块');
  }

  const accepted = new Set(acceptHunkIds);
  for (const id of rejectHunkIds) {
    if (accepted.has(id)) fail('DECISION_OVERLAP', `同一修改块不能同时接受和拒绝：${id}`);
  }
  const hunkToPath = new Map();
  const hunksByPath = new Map();
  for (const file of review.files) {
    const ids = file.hunks.map(hunk => hunk.id);
    hunksByPath.set(file.path, ids);
    for (const id of ids) hunkToPath.set(id, file.path);
  }
  for (const id of [...acceptHunkIds, ...rejectHunkIds]) {
    if (!hunkToPath.has(id)) fail('HUNK_NOT_FOUND', `修改块不属于当前 ChangeSet：${id}`);
  }
  if (options.requireCompleteDecision === true && acceptHunkIds.length + rejectHunkIds.length !== hunkToPath.size) {
    fail('ISSUE_REVIEW_INCOMPLETE', '图谱问题修改必须先对所有修改块做出接受或拒绝决策');
  }

  for (const [path, allIds] of hunksByPath) {
    const file = review.files.find(item => item.path === path);
    if (file?.selectionPolicy === 'file') {
      const acceptedIds = allIds.filter(id => accepted.has(id));
      const rejectedIds = allIds.filter(id => rejectHunkIds.includes(id));
      if (!acceptedIds.length && !rejectedIds.length) continue;
      if (acceptedIds.length !== allIds.length && rejectedIds.length !== allIds.length) {
        fail('PARTIAL_SELECTION_FORBIDDEN', `${path} 必须整文件接受或拒绝`);
      }
    }
  }

  return {
    schema: DECISION_SCHEMA,
    changeSetId: review.changeSetId,
    acceptHunkIds,
    rejectHunkIds,
    review,
    hunkToPath,
  };
}

function groupedSelection(ids, hunkToPath) {
  const byPath = new Map();
  for (const id of ids) {
    const path = hunkToPath.get(id);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(id);
  }
  return [...byPath].map(([path, hunkIds]) => ({ path, hunkIds }));
}

function selectedChangeSet(changeSet, ids, hunkToPath) {
  if (!ids.length) return null;
  return changeSetService.selectHunks(changeSet, {
    schema: changeSetService.CHANGE_SELECTION_SCHEMA,
    files: groupedSelection(ids, hunkToPath),
  });
}

function resolveDecision(changeSet, decision, options = {}) {
  const valid = changeSetService.validateChangeSet(changeSet);
  const validated = validateDecision(valid, decision, options);
  const acceptedIds = new Set(validated.acceptHunkIds);
  const rejectedIds = new Set(validated.rejectHunkIds);
  const allIds = validated.review.files.flatMap(file => file.hunks.map(hunk => hunk.id));
  const pendingIds = allIds.filter(id => !acceptedIds.has(id) && !rejectedIds.has(id));
  const acceptedChangeSet = selectedChangeSet(valid, validated.acceptHunkIds, validated.hunkToPath);
  const desiredIds = allIds.filter(id => !rejectedIds.has(id));
  const desiredChangeSet = selectedChangeSet(valid, desiredIds, validated.hunkToPath);
  const acceptedByPath = new Map((acceptedChangeSet?.changes || []).map(change => [change.path, change]));
  const desiredByPath = new Map((desiredChangeSet?.changes || []).map(change => [change.path, change]));
  const residualSnapshots = [];
  const residualProposals = [];

  for (const original of valid.changes) {
    const acceptedContent = acceptedByPath.get(original.path)?.after ?? original.before;
    const desiredContent = desiredByPath.get(original.path)?.after ?? original.before;
    if (desiredContent === acceptedContent) continue;
    residualSnapshots.push({
      path: original.path,
      content: acceptedContent,
      revision: sha256(acceptedContent),
    });
    residualProposals.push({
      path: original.path,
      after: desiredContent,
      summary: original.summary,
    });
  }

  const residualChangeSet = residualProposals.length
    ? changeSetService.createChangeSet(residualSnapshots, residualProposals)
    : null;
  const capabilityMode = typeof options.reviewId === 'string' && options.reviewId.startsWith('pc_');
  if (residualChangeSet && capabilityMode && options.residualReviewId === undefined) {
    fail('RESIDUAL_REVIEW_ID_REQUIRED', '部分接受前必须为剩余建议分配新的审阅身份');
  }
  if (residualChangeSet && options.residualReviewId !== undefined && options.residualReviewId === options.reviewId) {
    fail('RESIDUAL_REVIEW_ID_REUSED', '剩余建议必须使用新的审阅身份');
  }
  return {
    sourceChangeSetId: valid.id,
    selectionPolicy: validated.review.selectionPolicy,
    acceptedHunkIds: validated.acceptHunkIds,
    rejectedHunkIds: validated.rejectHunkIds,
    pendingHunkIds: pendingIds,
    acceptedChangeSet,
    residualChangeSet,
    review: residualChangeSet
      ? createReview(residualChangeSet, {
        ...(options.selectionPolicy !== undefined ? { selectionPolicy: options.selectionPolicy } : {}),
        ...(options.fileSelectionPolicies !== undefined ? { fileSelectionPolicies: Object.fromEntries(
          Object.entries(options.fileSelectionPolicies).filter(([path]) =>
            residualChangeSet.changes.some(change => change.path === path)),
        ) } : {}),
        ...(options.residualReviewId !== undefined ? { reviewId: options.residualReviewId } : {}),
      })
      : null,
  };
}

function reviewAudit(resolution) {
  return {
    sourceChangeSetId: resolution.sourceChangeSetId,
    acceptedHunkIds: resolution.acceptedHunkIds,
    rejectedHunkIds: resolution.rejectedHunkIds,
  };
}

function prepareDecision(projectService, rootPath, changeSet, decision, options = {}) {
  const historyService = options.historyService || defaultHistoryService;
  const resolution = resolveDecision(changeSet, decision, options);
  const audit = reviewAudit(resolution);
  let historyPrepared;
  if (resolution.acceptedChangeSet) {
    if (typeof options.validateAcceptedChangeSet === 'function') {
      options.validateAcceptedChangeSet(resolution.acceptedChangeSet);
    }
    historyPrepared = historyService.prepareApplication(rootPath, resolution.acceptedChangeSet, {
      review: audit,
      provenance: options.provenance === undefined ? null : options.provenance,
    });
  } else {
    historyPrepared = historyService.prepareReviewDecision(rootPath, resolution.sourceChangeSetId, audit, {
      provenance: options.provenance === undefined ? null : options.provenance,
    });
  }
  return { resolution, audit, historyPrepared };
}

function executePreparedDecision(projectService, rootPath, prepared, options = {}) {
  const historyService = options.historyService || defaultHistoryService;
  const { resolution, historyPrepared } = prepared;
  let result;
  if (resolution.acceptedChangeSet) {
    result = historyService.executePreparedApplication(projectService, rootPath, historyPrepared, {
      ...(typeof options.saveHistory === 'function' ? { saveHistory: options.saveHistory } : {}),
    });
    if (!result.ok) return { ...result, consumed: false };
  } else {
    try {
      const historyEntry = historyService.executePreparedReview(rootPath, historyPrepared, {
        ...(typeof options.saveHistory === 'function' ? { saveHistory: options.saveHistory } : {}),
      });
      result = { ok: true, applied: [], rolledBack: [], historyEntry };
    } catch (error) {
      return { ok: false, status: 'history_failed', error, applied: [], rolledBack: [], consumed: false };
    }
  }
  const hasResidual = Boolean(resolution.residualChangeSet);
  return {
    ...result,
    status: hasResidual
      ? (resolution.acceptedChangeSet ? 'applied_partial' : 'review_updated')
      : 'completed',
    consumed: true,
    sourceChangeSetId: resolution.sourceChangeSetId,
    acceptedHunkCount: resolution.acceptedHunkIds.length,
    rejectedHunkCount: resolution.rejectedHunkIds.length,
    remainingHunkCount: resolution.pendingHunkIds.length,
    residualChangeSet: resolution.residualChangeSet,
    review: resolution.review,
  };
}

function applyDecision(projectService, rootPath, changeSet, decision, options = {}) {
  const prepared = prepareDecision(projectService, rootPath, changeSet, decision, options);
  return executePreparedDecision(projectService, rootPath, prepared, options);
}

module.exports = {
  REVIEW_SCHEMA,
  DECISION_SCHEMA,
  MAX_DECISION_BYTES,
  ChangeSetReviewError,
  createReview,
  validateDecision,
  resolveDecision,
  prepareDecision,
  executePreparedDecision,
  applyDecision,
};
