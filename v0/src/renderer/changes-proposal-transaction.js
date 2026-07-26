(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftChangesProposalTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const MODES = Object.freeze(['normal', 'chapter', 'plan', 'issue', 'research']);

  function normalizeChapterRequest(request) {
    if (!request || request.schema !== 'writcraft.chapter-generation-request/v1' ||
        typeof request.targetPath !== 'string' || !request.targetPath ||
        typeof request.instruction !== 'string' || !request.instruction.trim() ||
        !Array.isArray(request.contextPaths) || request.contextPaths.some(path => typeof path !== 'string' || !path)) {
      return null;
    }
    return Object.freeze({
      schema: request.schema,
      targetPath: request.targetPath,
      instruction: request.instruction.trim(),
      contextPaths: Object.freeze([...request.contextPaths]),
    });
  }

  function sameChapterRequest(left, right) {
    const normalized = normalizeChapterRequest(right);
    return Boolean(left && normalized && left.schema === normalized.schema &&
      left.targetPath === normalized.targetPath && left.instruction === normalized.instruction &&
      left.contextPaths.length === normalized.contextPaths.length &&
      left.contextPaths.every((path, index) => path === normalized.contextPaths[index]));
  }

  function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  async function discardChapterCapability(discard, projectInstanceId, capabilityId) {
    if (typeof discard !== 'function' || typeof projectInstanceId !== 'string' || !projectInstanceId ||
        typeof capabilityId !== 'string' || !capabilityId) return false;
    try {
      const result = await discard(projectInstanceId, capabilityId);
      return result?.ok === true || result?.error === 'CHANGESET_NOT_FOUND';
    } catch (_) {
      return false;
    }
  }

  function classifyChapterResult(result, request) {
    const normalizedRequest = normalizeChapterRequest(request);
    if (!normalizedRequest || !plainRecord(result) ||
        !Object.prototype.hasOwnProperty.call(result, 'ok') || result.ok !== true) {
      return Object.freeze({ ok: false, kind: 'invalid', reason: 'INVALID_RESULT' });
    }
    const capabilityId = typeof result.changeSetId === 'string' && result.changeSetId
      ? result.changeSetId
      : null;
    const provenance = result.provenance;
    const expectedContext = [
      { path: 'edit.md', role: 'project_prompt' },
      ...normalizedRequest.contextPaths.map(path => ({ path, role: 'context' })),
    ];
    const contextMatches = plainRecord(provenance) && Array.isArray(provenance.context) &&
      provenance.context.length === expectedContext.length &&
      provenance.context.every((item, index) => plainRecord(item) &&
        item.path === expectedContext[index].path &&
        item.role === expectedContext[index].role &&
        typeof item.revision === 'string' && item.revision);
    const generation = plainRecord(provenance) ? provenance.generation : null;
    if (!plainRecord(provenance) || !plainRecord(provenance.target) ||
        !Object.prototype.hasOwnProperty.call(provenance, 'schema') ||
        !Object.prototype.hasOwnProperty.call(provenance, 'kind') ||
        !Object.prototype.hasOwnProperty.call(provenance, 'target') ||
        !Object.prototype.hasOwnProperty.call(provenance.target, 'path') ||
        provenance.schema !== normalizedRequest.schema ||
        provenance.kind !== 'chapter_generation' ||
        provenance.target.path !== normalizedRequest.targetPath ||
        typeof provenance.target.revision !== 'string' || !provenance.target.revision ||
        !contextMatches ||
        !plainRecord(generation) ||
        generation.strategy !== 'planned_blocks' ||
        generation.planSchema !== 'writcraft.chapter-generation-plan/v1' ||
        generation.blockSchema !== 'writcraft.chapter-generation-block/v1' ||
        !Number.isSafeInteger(generation.blockCount) || generation.blockCount < 1) {
      return Object.freeze({
        ok: false,
        kind: 'invalid',
        reason: 'INVALID_PROVENANCE',
        capabilityId,
      });
    }
    if (result.noChanges === true) {
      if (result.fileCount !== 0 || Boolean(result.review) || capabilityId) {
        return Object.freeze({
          ok: false,
          kind: 'invalid',
          reason: 'INVALID_NO_CHANGES',
          capabilityId,
        });
      }
      return Object.freeze({ ok: true, kind: 'no_changes', capabilityId: null });
    }
    const review = result.review;
    const reviewFile = plainRecord(review) && Array.isArray(review.files) && review.files.length === 1
      ? review.files[0]
      : null;
    if (result.noChanges !== false || result.fileCount !== 1 || !capabilityId ||
        !plainRecord(review) ||
        review.schema !== 'writcraft.changes-review/v1' ||
        review.changeSetId !== capabilityId ||
        review.selectionPolicy !== 'file' ||
        !plainRecord(reviewFile) ||
        reviewFile.path !== normalizedRequest.targetPath ||
        reviewFile.selectionPolicy !== 'file') {
      return Object.freeze({
        ok: false,
        kind: 'invalid',
        reason: 'INVALID_REVIEW_RESULT',
        capabilityId,
      });
    }
    return Object.freeze({ ok: true, kind: 'review', capabilityId });
  }

  async function supersede(previous, next, options = {}) {
    if (!next || typeof next.id !== 'string' || !next.id || typeof next.projectInstanceId !== 'string' ||
        !next.projectInstanceId || typeof options.discard !== 'function') {
      return Object.freeze({ ok: false, previousDiscarded: false, error: 'INVALID_REPLACEMENT' });
    }
    if (!previous || previous.id === next.id) {
      return Object.freeze({ ok: true, previousDiscarded: false });
    }
    if (typeof previous.id !== 'string' || !previous.id || typeof previous.projectInstanceId !== 'string' || !previous.projectInstanceId) {
      return Object.freeze({ ok: false, previousDiscarded: false, error: 'INVALID_REPLACEMENT' });
    }
    try {
      const discarded = await options.discard(previous.projectInstanceId, previous.id);
      if (discarded?.ok === false && discarded.error !== 'CHANGESET_NOT_FOUND') {
        try { await options.discard(next.projectInstanceId, next.id); } catch (_) {}
        return Object.freeze({ ok: false, previousDiscarded: false, error: discarded.error || 'DISCARD_FAILED' });
      }
      return Object.freeze({ ok: true, previousDiscarded: true });
    } catch (_) {
      // The previous review remains visible and owned. Dispose the newly
      // generated capability instead of creating a renderer ownership gap.
      try { await options.discard(next.projectInstanceId, next.id); } catch (_) {}
      return Object.freeze({ ok: false, previousDiscarded: false, error: 'DISCARD_FAILED' });
    }
  }

  function create() {
    let epoch = 0;
    let active = null;

    function begin(mode, projectInstanceId) {
      if (!MODES.includes(mode) || typeof projectInstanceId !== 'string' || !projectInstanceId) return null;
      epoch += 1;
      active = Object.freeze({ epoch, mode, projectInstanceId });
      return active;
    }

    function invalidate() {
      epoch += 1;
      active = null;
      return epoch;
    }

    function isCurrent(token, projectInstanceId, mode = token?.mode) {
      return Boolean(token && active && MODES.includes(mode) &&
        token.epoch === epoch && token.epoch === active.epoch &&
        token.mode === mode && token.mode === active.mode &&
        token.projectInstanceId === projectInstanceId && token.projectInstanceId === active.projectInstanceId);
    }

    async function settle(token, result, options = {}) {
      const current = isCurrent(token, options.projectInstanceId, options.mode || token?.mode);
      if (!current && result?.ok && typeof result.changeSetId === 'string' && typeof options.discard === 'function') {
        // A stale success still belongs to its origin project. Never send the
        // capability with whichever project happens to be current now.
        try { await options.discard(token?.projectInstanceId || '', result.changeSetId); } catch (_) {}
      }
      return current;
    }

    function finish(token, projectInstanceId) {
      if (!isCurrent(token, projectInstanceId, token?.mode)) return false;
      active = null;
      return true;
    }

    return Object.freeze({
      begin,
      invalidate,
      isCurrent,
      settle,
      finish,
      getActive() { return active; },
      getEpoch() { return epoch; },
    });
  }

  function beginChapter(state, projectInstanceId, request, pendingReview) {
    if (!state || pendingReview !== null) return null;
    const normalizedRequest = normalizeChapterRequest(request);
    if (!normalizedRequest) return null;
    const transaction = state.begin('chapter', projectInstanceId);
    if (!transaction) return null;
    return Object.freeze({
      transaction,
      request: normalizedRequest,
      pendingReview,
    });
  }

  function isChapterCurrent(state, session, current = {}) {
    return Boolean(state && session && current.pendingReview === session.pendingReview &&
      state.isCurrent(session.transaction, current.projectInstanceId, 'chapter') &&
      sameChapterRequest(session.request, current.request));
  }

  async function releaseStaleChapterResult(state, session, result, current = {}, options = {}) {
    if (!state || !session || isChapterCurrent(state, session, current)) return false;
    // Compare against the origin identity, not whichever project is visible
    // now. This invalidates only the old token and cannot cancel a newer run.
    if (state.isCurrent(
      session.transaction,
      session.transaction.projectInstanceId,
      'chapter'
    )) state.invalidate();
    if (result?.ok && typeof result.changeSetId === 'string' && result.changeSetId &&
        typeof options.discard === 'function') {
      try { await options.discard(session.transaction.projectInstanceId, result.changeSetId); } catch (_) {}
    }
    return true;
  }

  async function settleChapter(state, session, result, current = {}, options = {}) {
    if (!state || !session) return false;
    if (!isChapterCurrent(state, session, current)) {
      await releaseStaleChapterResult(state, session, result, current, options);
      return false;
    }
    const settled = await state.settle(session.transaction, result, {
      mode: 'chapter',
      projectInstanceId: current.projectInstanceId,
      discard: options.discard,
    });
    if (!settled) return false;
    // Awaiting even an already-resolved Promise yields to queued microtasks.
    // Re-check after that boundary and dispose a capability if ownership moved.
    if (!isChapterCurrent(state, session, options.getCurrent?.() || current)) {
      await releaseStaleChapterResult(
        state,
        session,
        result,
        options.getCurrent?.() || current,
        options
      );
      return false;
    }
    return true;
  }

  async function replaceChapterReview(state, session, result, options = {}) {
    const current = () => options.getCurrent?.() || {};
    let capabilityReleased = false;
    const releaseCandidate = async () => {
      if (capabilityReleased) return true;
      const discarded = await discardChapterCapability(
        options.discard,
        session.transaction.projectInstanceId,
        result?.changeSetId
      );
      if (discarded) capabilityReleased = true;
      return discarded;
    };
    const stale = async () => {
      if (!capabilityReleased) await releaseStaleChapterResult(state, session, result, current(), options);
      return Object.freeze({ ok: false, stale: true, reason: 'STALE_CHAPTER_RESULT' });
    };
    const fail = reason => {
      options.onFailure?.(reason);
      return Object.freeze({ ok: false, stale: false, reason });
    };

    if (!isChapterCurrent(state, session, current())) return stale();
    let candidate;
    try { candidate = options.prepare?.(); } catch (_) { candidate = null; }
    if (!candidate) {
      if (typeof options.discard === 'function' && typeof result?.changeSetId === 'string') {
        const discarded = await releaseCandidate();
        if (!discarded) {
          if (!isChapterCurrent(state, session, current())) return stale();
          return fail('DISCARD_FAILED');
        }
      }
      if (!isChapterCurrent(state, session, current())) return stale();
      return fail('INVALID_REVIEW');
    }
    if (!isChapterCurrent(state, session, current())) return stale();

    let replacement;
    try { replacement = await options.replace?.(candidate); }
    catch (_) { replacement = Object.freeze({ ok: false, error: 'REPLACE_FAILED' }); }
    if (!isChapterCurrent(state, session, current())) return stale();
    if (!replacement?.ok) {
      if (typeof options.discard === 'function' && typeof result?.changeSetId === 'string') {
        const discarded = await releaseCandidate();
        if (!discarded) {
          if (!isChapterCurrent(state, session, current())) return stale();
          return fail('DISCARD_FAILED');
        }
      }
      if (!isChapterCurrent(state, session, current())) return stale();
      return fail(replacement?.error || 'REPLACE_FAILED');
    }
    // No await is allowed between this final ownership check and Renderer
    // transfer. The callback must synchronously install the review and its UI.
    if (!isChapterCurrent(state, session, current())) return stale();
    try { options.render?.(candidate, replacement); }
    catch (_) {
      if (typeof options.discard === 'function' && typeof result?.changeSetId === 'string') {
        const discarded = await releaseCandidate();
        if (!discarded) {
          if (!isChapterCurrent(state, session, current())) return stale();
          return fail('DISCARD_FAILED');
        }
      }
      if (!isChapterCurrent(state, session, current())) return stale();
      return fail('RENDER_FAILED');
    }
    return Object.freeze({ ok: true, stale: false, replacement });
  }

  function finishChapter(state, session, currentProjectInstanceId) {
    const finished = Boolean(state && session && state.finish(session.transaction, currentProjectInstanceId));
    const newerChapterActive = state?.getActive?.()?.mode === 'chapter';
    return Object.freeze({
      finished,
      releaseBusy: finished,
      resetButton: finished || !newerChapterActive,
    });
  }

  return Object.freeze({
    MODES,
    normalizeChapterRequest,
    sameChapterRequest,
    classifyChapterResult,
    discardChapterCapability,
    beginChapter,
    isChapterCurrent,
    releaseStaleChapterResult,
    settleChapter,
    replaceChapterReview,
    finishChapter,
    supersede,
    create,
  });
});
