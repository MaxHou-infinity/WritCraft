(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftChangesReviewState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REVIEW_SCHEMA = 'writcraft.changes-review/v1';
  const DECISION_SCHEMA = 'writcraft.changes-decision/v1';
  // Main may hydrate a current-session public review without exposing the
  // private pc_* capability. Keep this allowlist identical to Main's review
  // contract; review_* is an identity for decisions, never store authority.
  const REVIEW_ID_RE = /^(?:cs_[a-f0-9]{24}|pc_[a-f0-9]{32}|review_[a-f0-9]{32})$/;
  const HUNK_ID_RE = /^hk_[a-f0-9]{24}$/;
  const MAX_FILES = 64;
  const MAX_HUNKS = 1024;
  const DECISIONS = new Set(['pending', 'accepted', 'rejected']);

  function freeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze);
    return Object.freeze(value);
  }

  function normalizeReview(value) {
    if (!value || value.schema !== REVIEW_SCHEMA || !REVIEW_ID_RE.test(value.changeSetId || '') ||
        !['hunk', 'file', 'mixed'].includes(value.selectionPolicy) || !Array.isArray(value.files) ||
        value.files.length > MAX_FILES) return null;
    const paths = new Set();
    const hunkIds = new Set();
    let total = 0;
    const files = [];
    for (const rawFile of value.files) {
      if (!rawFile || typeof rawFile.path !== 'string' || !rawFile.path || paths.has(rawFile.path) ||
          !Array.isArray(rawFile.hunks) || !['hunk', 'file'].includes(rawFile.selectionPolicy)) return null;
      if (value.selectionPolicy !== 'mixed' && rawFile.selectionPolicy !== value.selectionPolicy) return null;
      paths.add(rawFile.path);
      const hunks = [];
      for (const rawHunk of rawFile.hunks) {
        if (!rawHunk || !HUNK_ID_RE.test(rawHunk.id || '') || hunkIds.has(rawHunk.id) ||
            !Array.isArray(rawHunk.lines)) return null;
        const lines = rawHunk.lines.map(line => {
          if (!line || !['add', 'remove', 'context', 'meta'].includes(line.kind) || typeof line.text !== 'string') return null;
          return { kind: line.kind, text: line.text };
        });
        if (lines.some(line => line === null)) return null;
        hunkIds.add(rawHunk.id);
        total += 1;
        if (total > MAX_HUNKS) return null;
        hunks.push({
          id: rawHunk.id,
          oldStart: Number.isSafeInteger(rawHunk.oldStart) ? rawHunk.oldStart : 0,
          oldLines: Number.isSafeInteger(rawHunk.oldLines) ? rawHunk.oldLines : 0,
          newStart: Number.isSafeInteger(rawHunk.newStart) ? rawHunk.newStart : 0,
          newLines: Number.isSafeInteger(rawHunk.newLines) ? rawHunk.newLines : 0,
          lines,
        });
      }
      files.push({
        path: rawFile.path,
        summary: typeof rawFile.summary === 'string' ? rawFile.summary.slice(0, 500) : '',
        selectionPolicy: rawFile.selectionPolicy,
        hunks,
      });
    }
    if (Number.isSafeInteger(value.totalFiles) && value.totalFiles !== files.length) return null;
    if (Number.isSafeInteger(value.totalHunks) && value.totalHunks !== total) return null;
    return freeze({
      schema: REVIEW_SCHEMA,
      changeSetId: value.changeSetId,
      selectionPolicy: value.selectionPolicy,
      totalFiles: files.length,
      totalHunks: total,
      files,
    });
  }

  function create(review) {
    const normalized = normalizeReview(review);
    if (!normalized) return null;
    const decisions = {};
    for (const file of normalized.files) for (const hunk of file.hunks) decisions[hunk.id] = 'pending';
    return freeze({ review: normalized, decisions });
  }

  function fileForHunk(review, hunkId) {
    return review.files.find(file => file.hunks.some(hunk => hunk.id === hunkId)) || null;
  }

  function update(state, hunkId, decision) {
    if (!state || !DECISIONS.has(decision) || !Object.prototype.hasOwnProperty.call(state.decisions || {}, hunkId)) return state;
    const next = { ...state.decisions };
    const file = fileForHunk(state.review, hunkId);
    if (!file) return state;
    const targets = file.selectionPolicy === 'file' ? file.hunks.map(hunk => hunk.id) : [hunkId];
    for (const id of targets) next[id] = decision;
    return freeze({ review: state.review, decisions: next });
  }

  function updateFile(state, path, decision) {
    if (!state || !DECISIONS.has(decision)) return state;
    const file = state.review.files.find(item => item.path === path);
    if (!file) return state;
    const next = { ...state.decisions };
    for (const hunk of file.hunks) next[hunk.id] = decision;
    return freeze({ review: state.review, decisions: next });
  }

  function counts(state) {
    const result = { accepted: 0, rejected: 0, pending: 0, total: 0 };
    if (!state) return result;
    for (const decision of Object.values(state.decisions)) {
      result.total += 1;
      result[decision] += 1;
    }
    return result;
  }

  function toDecision(state) {
    if (!state) return null;
    const acceptHunkIds = [];
    const rejectHunkIds = [];
    for (const file of state.review.files) {
      for (const hunk of file.hunks) {
        if (state.decisions[hunk.id] === 'accepted') acceptHunkIds.push(hunk.id);
        if (state.decisions[hunk.id] === 'rejected') rejectHunkIds.push(hunk.id);
      }
    }
    if (!acceptHunkIds.length && !rejectHunkIds.length) return null;
    return freeze({
      schema: DECISION_SCHEMA,
      changeSetId: state.review.changeSetId,
      acceptHunkIds,
      rejectHunkIds,
    });
  }

  return Object.freeze({
    REVIEW_SCHEMA,
    DECISION_SCHEMA,
    normalizeReview,
    create,
    update,
    updateFile,
    counts,
    toDecision,
  });
});
