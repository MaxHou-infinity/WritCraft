(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__aiRequestGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function capture(state) {
    if (!state?.project) return null;
    return Object.freeze({
      projectInstanceId: state.project.instanceId,
      editContextRevision: state.editContextRevision,
      currentPath: state.currentPath,
      currentRevision: state.revision,
      editVersion: state.editVersion,
      aiContextGeneration: state.aiContextGeneration || 0,
    });
  }

  function matches(guard, state) {
    if (!guard || !state?.project) return false;
    return guard.projectInstanceId === state.project.instanceId
      && guard.editContextRevision === state.editContextRevision
      && guard.currentPath === state.currentPath
      && guard.currentRevision === state.revision
      && guard.editVersion === state.editVersion
      && guard.aiContextGeneration === (state.aiContextGeneration || 0);
  }

  function normalizeSelection(selection) {
    if (!selection || typeof selection !== 'object') return null;
    if (typeof selection.filePath !== 'string' || typeof selection.text !== 'string' ||
        !Number.isSafeInteger(selection.startOffset) || !Number.isSafeInteger(selection.endOffset)) return null;
    return Object.freeze({
      filePath: selection.filePath,
      text: selection.text,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    });
  }

  function sameSelection(left, right) {
    if (left === null || left === undefined) return right === null || right === undefined;
    if (right === null || right === undefined) return false;
    return left.filePath === right.filePath
      && left.text === right.text
      && left.startOffset === right.startOffset
      && left.endOffset === right.endOffset;
  }

  function captureChatIntent(state, contextRequest, requestToken) {
    const base = capture(state);
    if (!base || !contextRequest || !Number.isSafeInteger(requestToken) || requestToken < 1 ||
        state.activeChatRequestToken !== requestToken || contextRequest.currentFilePath !== base.currentPath ||
        !['project', 'file', 'selection'].includes(contextRequest.scope)) return null;
    const selection = contextRequest.scope === 'selection'
      ? normalizeSelection(contextRequest.selection)
      : null;
    if (contextRequest.scope === 'selection' && !selection) return null;
    return Object.freeze({
      ...base,
      requestToken,
      scope: contextRequest.scope,
      selection,
      message: contextRequest.message,
      neededFlush: Boolean(state.dirty || state.savePromise),
      dirty: Boolean(state.dirty),
      openGeneration: state.openGeneration || 0,
    });
  }

  function intentIdentityMatches(intent, state, interaction) {
    if (!intent || !state?.project || !interaction) return false;
    const selection = interaction.scope === 'selection'
      ? normalizeSelection(interaction.selection)
      : null;
    return intent.requestToken === state.activeChatRequestToken
      && intent.projectInstanceId === state.project.instanceId
      && intent.currentPath === state.currentPath
      && intent.editVersion === state.editVersion
      && intent.aiContextGeneration === (state.aiContextGeneration || 0)
      && intent.openGeneration === (state.openGeneration || 0)
      && intent.scope === interaction.scope
      && intent.currentPath === interaction.currentFilePath
      && sameSelection(intent.selection, selection);
  }

  function intentMatchesBeforePrepare(intent, state, interaction) {
    return intentIdentityMatches(intent, state, interaction)
      && intent.currentRevision === state.revision
      && intent.editContextRevision === state.editContextRevision;
  }

  function intentMatchesAfterOwnFlush(intent, state, interaction) {
    if (!intentIdentityMatches(intent, state, interaction)) return false;
    if (state.dirty || state.savePromise) return false;
    if (!intent.neededFlush) {
      return intent.currentRevision === state.revision
        && intent.editContextRevision === state.editContextRevision;
    }
    // A successful persist(expectedRevision) is the authority for the one
    // allowed revision transition. It may advance the current file revision;
    // only saving edit.md may also advance the project-prompt revision.
    if (state.currentPath === 'edit.md') {
      return typeof state.revision === 'string' && state.revision
        && state.editContextRevision === state.revision;
    }
    return state.editContextRevision === intent.editContextRevision
      && typeof state.revision === 'string' && Boolean(state.revision);
  }

  /**
   * Production Chat preparation transaction. Tests inject controlled promises
   * into this exact function; the renderer supplies real persistence/state
   * adapters. No post-await state is ever recaptured as a replacement intent.
   */
  async function prepareChatIntent(intent, adapters) {
    if (!intent || !adapters || typeof adapters.getState !== 'function' ||
        typeof adapters.getInteraction !== 'function' || typeof adapters.persist !== 'function') {
      return Object.freeze({ ok: false, reason: 'CHAT_INTENT_INVALID' });
    }
    const stateBefore = adapters.getState();
    if (!intentMatchesBeforePrepare(intent, stateBefore, adapters.getInteraction())) {
      return Object.freeze({ ok: false, reason: 'CHAT_INTENT_STALE' });
    }
    const saved = await adapters.persist();
    if (!saved) return Object.freeze({ ok: false, reason: 'CHAT_SAVE_FAILED' });
    if (!intentMatchesAfterOwnFlush(intent, adapters.getState(), adapters.getInteraction())) {
      return Object.freeze({ ok: false, reason: 'CHAT_INTENT_STALE' });
    }
    if (intent.neededFlush && typeof adapters.settle === 'function') await adapters.settle();
    const stateAfter = adapters.getState();
    if (!intentMatchesAfterOwnFlush(intent, stateAfter, adapters.getInteraction()) ||
        (typeof adapters.canUseAI === 'function' && !adapters.canUseAI())) {
      return Object.freeze({ ok: false, reason: 'CHAT_INTENT_STALE' });
    }
    const aiGuard = capture(stateAfter);
    return aiGuard
      ? Object.freeze({ ok: true, aiGuard })
      : Object.freeze({ ok: false, reason: 'CHAT_INTENT_STALE' });
  }

  /**
   * Bind all Chat phases to one renderer-owned monotonic request token and to
   * the exact project/file/revision/selection snapshot used to build the Main
   * context request. The token is deliberately not sent over IPC: it controls
   * renderer publication and cannot become model input.
   */
  function captureChat(aiGuard, contextRequest, requestToken) {
    if (!aiGuard || !contextRequest || !Number.isSafeInteger(requestToken) || requestToken < 1) return null;
    if (!['project', 'file', 'selection'].includes(contextRequest.scope) ||
        contextRequest.currentFilePath !== aiGuard.currentPath) return null;
    const selection = contextRequest.scope === 'selection'
      ? normalizeSelection(contextRequest.selection)
      : null;
    if (contextRequest.scope === 'selection' && !selection) return null;
    return Object.freeze({
      ...aiGuard,
      requestToken,
      scope: contextRequest.scope,
      selection,
    });
  }

  function matchesChat(guard, state, activeRequestToken, interaction) {
    if (!guard || !interaction || guard.requestToken !== activeRequestToken || !matches(guard, state)) return false;
    const scope = interaction.scope;
    const currentPath = interaction.currentFilePath;
    const selection = scope === 'selection' ? normalizeSelection(interaction.selection) : null;
    return guard.scope === scope
      && guard.currentPath === currentPath
      && sameSelection(guard.selection, selection);
  }

  function shouldAdvanceContext(change) {
    if (!change || typeof change !== 'object') return false;
    return change.currentRevisionChanged === true
      || change.editContextChanged === true
      || change.otherPathChanged === true
      || change.projectInvalidated === true;
  }

  return Object.freeze({
    capture,
    matches,
    captureChat,
    matchesChat,
    captureChatIntent,
    prepareChatIntent,
    intentMatchesBeforePrepare,
    intentMatchesAfterOwnFlush,
    sameSelection,
    shouldAdvanceContext,
  });
});
