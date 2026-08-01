(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftWritingNavigationState = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const RESULT_SCHEMA = 'writcraft.writing-navigation/v1';
  const REQUEST_SCHEMA = 'writcraft.writing-navigation-request/v1';
  const PREVIEW_SCHEMA = 'writcraft.writing-structure-preview/v1';
  const PROJECT_ID_RE = /^instance_[a-f0-9]{24}$/;
  const NAVIGATION_ID_RE = /^nav_[a-f0-9]{32}$/;
  const ACTION_ID_RE = /^wna_[a-f0-9]{32}$/;
  const ATTEMPT_ID_RE = /^wno_[a-f0-9]{32}$/;
  const CAPABILITY_ID_RE = /^wsc_[a-f0-9]{32}$/;
  const ALTERNATIVE_ID_RE = /^alternative_[1-3]$/;
  const SAFE_TEXT = /^(?:[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u;
  const ACTIONS = new Set(['open', 'research', 'changes']);

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  }

  function safeText(value, max, options = {}) {
    if (typeof value !== 'string' || !value || value !== value.trim() ||
        !SAFE_TEXT.test(value) || Array.from(value).length > max ||
        (options.noCommentClose && value.includes('--'))) return null;
    return value;
  }

  function validateChapter(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const title = safeText(value.title, 40);
    const purpose = safeText(value.purpose, 120, { noCommentClose: true });
    return title && purpose ? Object.freeze({ title, purpose }) : null;
  }

  function bodyPath(value) {
    if (typeof value !== 'string' || !/\.(?:md|markdown)$/i.test(value) ||
        value.startsWith('.') || value.split('/').some(part => !part || part.startsWith('.'))) {
      return null;
    }
    const lower = value.normalize('NFC').toLocaleLowerCase('en-US');
    if (lower === 'edit.md' || lower.startsWith('references/') || lower.startsWith('sources/')) {
      return null;
    }
    return value;
  }

  function markdownPaths(tree) {
    const result = [];
    const stack = Array.isArray(tree) ? [...tree].reverse() : [];
    let count = 0;
    while (stack.length && count < 4096) {
      const node = stack.pop();
      count += 1;
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'directory' && Array.isArray(node.children) &&
          !String(node.path || '').split('/').some(part => part.startsWith('.'))) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          stack.push(node.children[index]);
        }
      } else if (node.type === 'file') {
        const path = bodyPath(node.path);
        if (path) result.push(path);
      }
    }
    return result;
  }

  function modeForTree(tree) {
    return markdownPaths(tree).length ? 'navigation' : 'structure';
  }

  function base() {
    return deepFreeze({
      projectInstanceId: null,
      projectEpoch: 0,
      tree: [],
      mode: null,
      currentFilePath: null,
      goal: '',
      contextPaths: [],
      phase: 'idle',
      generation: null,
      result: null,
      selectedAlternativeId: null,
      chapterDrafts: {},
      preview: null,
      capabilityId: null,
      recovery: null,
      actions: {},
      error: null,
    });
  }

  function createState() {
    return base();
  }

  function validManifest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        !Number.isSafeInteger(raw.usedBodyCount) || raw.usedBodyCount < 0 ||
        !Number.isSafeInteger(raw.availableBodyCount) ||
        raw.availableBodyCount < raw.usedBodyCount ||
        !Array.isArray(raw.files)) return null;
    return clone(raw);
  }

  function validResult(raw, expectedMode) {
    if (!raw || typeof raw !== 'object' || raw.schema !== RESULT_SCHEMA ||
        raw.mode !== expectedMode || !NAVIGATION_ID_RE.test(raw.navigationId || '') ||
        !validManifest(raw.contextManifest)) return null;
    const copy = clone(raw);
    if (!copy) return null;
    if (expectedMode === 'structure') {
      if (!Array.isArray(copy.alternatives) || copy.alternatives.length < 2 ||
          copy.alternatives.length > 3) return null;
      for (const alternative of copy.alternatives) {
        if (!ALTERNATIVE_ID_RE.test(alternative?.alternativeId || '') ||
            !safeText(alternative.organizingLogic, 120) ||
            !safeText(alternative.audienceBenefit, 100) ||
            !safeText(alternative.tradeoff, 100) ||
            !Array.isArray(alternative.chapters) || !alternative.chapters.length ||
            alternative.chapters.length > 8 ||
            alternative.chapters.some(chapter => !validateChapter(chapter))) return null;
      }
    } else {
      if (!Array.isArray(copy.suggestions) || !copy.suggestions.length ||
          copy.suggestions.length > 3) return null;
      for (const suggestion of copy.suggestions) {
        if (!ACTION_ID_RE.test(suggestion?.actionId || '') ||
            !ACTIONS.has(suggestion.action) ||
            !safeText(suggestion.finding, 160) ||
            !safeText(suggestion.whyNow, 160) ||
            !safeText(suggestion.recommendedAction, 80) ||
            !safeText(suggestion.expectedResult, 160) ||
            !Array.isArray(suggestion.evidence) || !suggestion.evidence.length ||
            suggestion.evidence.length > 3) return null;
      }
    }
    return deepFreeze(copy);
  }

  function chapterDrafts(result) {
    const drafts = {};
    for (const alternative of result.alternatives) {
      drafts[alternative.alternativeId] = alternative.chapters.map(chapter =>
        ({ title: chapter.title, purpose: chapter.purpose })
      );
    }
    return drafts;
  }

  function sameAttempt(state, attemptId) {
    return Boolean(state.generation && state.generation.attemptId === attemptId);
  }

  function publicFailure(raw = {}) {
    const code = typeof raw.error === 'string' ? raw.error : 'NAVIGATION_FAILED';
    if (code === 'NO_KEY') {
      return Object.freeze({
        code,
        message: '尚未配置 AI。未联网，也未修改项目文件。',
        action: 'settings',
      });
    }
    if (code === 'PROJECT_CHANGED' || /STALE/.test(code)) {
      return Object.freeze({
        code,
        message: '项目内容已经变化，本次结果已作废。请重新生成。',
        action: 'regenerate',
      });
    }
    if (code === 'REVIEW_IN_PROGRESS') {
      return Object.freeze({
        code,
        message: '当前已有一份修改建议等待审阅。现有审阅保持不变。',
        action: 'review',
      });
    }
    if (code === 'REQUEST_ABORTED') {
      return Object.freeze({
        code,
        message: '整理已停止；本次没有修改项目文件。',
        action: 'retry',
      });
    }
    if (code === 'INVALID_MODEL_EVIDENCE') {
      return Object.freeze({
        code,
        message: 'AI 选择的原文依据没有通过核对；本次没有修改项目文件。请重新生成。',
        action: 'retry',
      });
    }
    if (['MODEL_OUTPUT_TOO_LARGE', 'TOO_MANY_PATCH_EDITS', 'PATCH_TEXT_TOO_LARGE',
      'PATCH_NEW_TEXT_TOO_LARGE'].includes(code)) {
      return Object.freeze({
        code,
        message: 'AI 返回的修改建议超过单次安全范围；本次没有修改项目文件。请直接重试；如果再次出现，请重新生成写作导航。',
        action: 'retry',
      });
    }
    return Object.freeze({
      code,
      message: 'AI 没有完成本次整理；没有修改项目文件。请调整目标或上下文后重试。',
      action: 'retry',
    });
  }

  function selectedChapters(state) {
    const list = state?.chapterDrafts?.[state.selectedAlternativeId];
    return Array.isArray(list) ? list.map(chapter => ({ ...chapter })) : [];
  }

  function requestPayload(state) {
    if (!state.projectInstanceId || !state.mode || !safeText(state.goal, 2000)) return null;
    const current = state.mode === 'navigation' && bodyPath(state.currentFilePath)
      ? state.currentFilePath : null;
    return deepFreeze({
      schema: REQUEST_SCHEMA,
      mode: state.mode,
      goal: state.goal,
      currentFilePath: current,
      contextPaths: state.mode === 'navigation'
        ? [...new Set(state.contextPaths.filter(path => bodyPath(path) && path !== current))]
          .slice(0, current ? 7 : 8)
        : [],
    });
  }

  function updateAction(state, actionId, value) {
    return deepFreeze({
      ...state,
      actions: { ...state.actions, [actionId]: value },
    });
  }

  function reduce(state, action) {
    if (!state || !action || typeof action.type !== 'string') return state;
    if (action.type === 'project-update') {
      if (!PROJECT_ID_RE.test(action.projectInstanceId || '')) return state;
      const nextTree = clone(Array.isArray(action.tree) ? action.tree : []) || [];
      return deepFreeze({
        ...base(),
        projectInstanceId: action.projectInstanceId,
        projectEpoch: state.projectEpoch + 1,
        tree: nextTree,
        mode: modeForTree(nextTree),
        currentFilePath: bodyPath(action.currentFilePath) || null,
      });
    }
    if (!state.projectInstanceId) return state;
    if (action.type === 'tree-update') {
      const nextTree = clone(Array.isArray(action.tree) ? action.tree : []) || [];
      const nextMode = modeForTree(nextTree);
      const nextCurrentFilePath = bodyPath(action.currentFilePath) || state.currentFilePath;
      const committedTerminal = state.phase === 'structure-committed' ||
        (state.phase === 'recovery' &&
          state.recovery?.state === 'COMMITTED' &&
          state.recovery?.recoveryRequired === true);
      if (nextMode !== state.mode && committedTerminal) {
        return deepFreeze({
          ...state,
          tree: nextTree,
          mode: nextMode,
          currentFilePath: nextCurrentFilePath,
        });
      }
      if (nextMode !== state.mode) {
        return deepFreeze({
          ...base(),
          projectInstanceId: state.projectInstanceId,
          projectEpoch: state.projectEpoch + 1,
          tree: nextTree,
          mode: nextMode,
          currentFilePath: nextCurrentFilePath,
        });
      }
      if (state.generation && nextCurrentFilePath !== state.currentFilePath) {
        return deepFreeze({
          ...state,
          phase: 'idle',
          projectEpoch: state.projectEpoch + 1,
          tree: nextTree,
          currentFilePath: nextCurrentFilePath,
          generation: null,
          result: null,
          actions: {},
          error: null,
        });
      }
      return deepFreeze({
        ...state,
        tree: nextTree,
        currentFilePath: nextCurrentFilePath,
      });
    }
    if (action.type === 'goal-change' && !state.generation) {
      const value = typeof action.value === 'string' ? action.value : '';
      return deepFreeze({ ...state, goal: value, error: null });
    }
    if (action.type === 'context-change' && !state.generation && state.mode === 'navigation') {
      const available = new Set(markdownPaths(state.tree));
      const maxAdditional = bodyPath(state.currentFilePath) ? 7 : 8;
      const paths = Array.isArray(action.paths)
        ? [...new Set(action.paths.filter(path =>
          available.has(path) && path !== state.currentFilePath
        ))].slice(0, maxAdditional)
        : [];
      return deepFreeze({ ...state, contextPaths: paths, error: null });
    }
    if (action.type === 'generation-start') {
      if (state.generation || !ATTEMPT_ID_RE.test(action.attemptId || '') ||
          !requestPayload(state) || state.phase === 'recovery') return state;
      return deepFreeze({
        ...state,
        phase: 'generating',
        generation: {
          attemptId: action.attemptId,
          projectInstanceId: state.projectInstanceId,
          projectEpoch: state.projectEpoch,
          status: 'generating',
        },
        result: null,
        preview: null,
        capabilityId: null,
        actions: {},
        error: null,
      });
    }
    if (action.type === 'generation-cancel-start') {
      if (!sameAttempt(state, action.attemptId)) return state;
      return deepFreeze({
        ...state,
        phase: 'cancelling',
        generation: { ...state.generation, status: 'cancelling' },
      });
    }
    if (action.type === 'generation-cancelled') {
      if (!sameAttempt(state, action.attemptId)) return state;
      return deepFreeze({ ...state, phase: 'idle', generation: null, error: null });
    }
    if (action.type === 'generation-success') {
      if (!sameAttempt(state, action.attemptId)) return state;
      const result = validResult(action.result, state.mode);
      if (!result) {
        return deepFreeze({
          ...state,
          phase: 'failure',
          generation: null,
          error: publicFailure({ error: 'INVALID_NAVIGATION_RESULT' }),
        });
      }
      return deepFreeze({
        ...state,
        phase: state.mode === 'structure' ? 'structure-ready' : 'navigation-ready',
        generation: null,
        result,
        selectedAlternativeId: state.mode === 'structure'
          ? result.alternatives[0].alternativeId : null,
        chapterDrafts: state.mode === 'structure' ? chapterDrafts(result) : {},
        actions: {},
        error: null,
      });
    }
    if (action.type === 'generation-error') {
      if (!sameAttempt(state, action.attemptId)) return state;
      return deepFreeze({
        ...state,
        phase: 'failure',
        generation: null,
        error: publicFailure(action.error),
      });
    }
    if (action.type === 'generation-finally') return state;
    if (action.type === 'alternative-select' && state.phase === 'structure-ready' &&
        state.chapterDrafts[action.alternativeId]) {
      return deepFreeze({ ...state, selectedAlternativeId: action.alternativeId });
    }
    if (action.type === 'chapter-edit' && state.phase === 'structure-ready' &&
        ['title', 'purpose'].includes(action.field)) {
      const chapters = state.chapterDrafts[action.alternativeId];
      if (!Array.isArray(chapters) || !Number.isSafeInteger(action.chapterIndex) ||
          action.chapterIndex < 0 || action.chapterIndex >= chapters.length ||
          typeof action.value !== 'string') return state;
      const next = chapters.map((chapter, index) =>
        index === action.chapterIndex ? { ...chapter, [action.field]: action.value } : { ...chapter }
      );
      return deepFreeze({
        ...state,
        chapterDrafts: { ...state.chapterDrafts, [action.alternativeId]: next },
        error: null,
      });
    }
    if (action.type === 'prepare-start' && state.phase === 'structure-ready') {
      return deepFreeze({ ...state, phase: 'structure-preparing', error: null });
    }
    if (action.type === 'prepare-error') {
      return deepFreeze({ ...state, phase: 'structure-ready', error: publicFailure(action.error) });
    }
    if (action.type === 'prepare-success') {
      const preview = clone(action.preview);
      if (!preview || preview.schema !== PREVIEW_SCHEMA ||
          !CAPABILITY_ID_RE.test(action.capabilityId || '') ||
          preview.createsProse !== false || !Array.isArray(preview.files)) {
        return deepFreeze({
          ...state,
          phase: 'structure-ready',
          error: publicFailure({ error: 'INVALID_STRUCTURE_PREVIEW' }),
        });
      }
      return deepFreeze({
        ...state,
        phase: 'structure-preview',
        preview,
        capabilityId: action.capabilityId,
        error: null,
      });
    }
    if (action.type === 'preview-back' && state.phase === 'structure-preview') {
      return deepFreeze({
        ...state,
        phase: 'structure-ready',
        preview: null,
        capabilityId: null,
      });
    }
    if (action.type === 'confirm-start' && state.phase === 'structure-preview') {
      return deepFreeze({ ...state, phase: 'structure-confirming', error: null });
    }
    if (action.type === 'confirm-result') {
      const result = action.result || {};
      if (result.state === 'COMMITTED' && result.recoveryRequired !== true) {
        return deepFreeze({
          ...state,
          phase: 'structure-committed',
          capabilityId: null,
          recovery: { ...clone(result), state: 'COMMITTED' },
          error: null,
        });
      }
      if (['UNKNOWN', 'COMMITTED'].includes(result.state) && result.recoveryRequired === true) {
        return deepFreeze({
          ...state,
          phase: 'recovery',
          capabilityId: null,
          recovery: clone(result),
          error: null,
        });
      }
      if (result.state === 'UNCOMMITTED') {
        return deepFreeze({
          ...state,
          phase: 'failure',
          capabilityId: null,
          preview: null,
          error: {
            code: result.error || 'WRITING_STRUCTURE_NOT_COMMITTED',
            message: '没有创建任何章节骨架。请重新预览后再确认。',
            action: 'retry',
          },
        });
      }
      return deepFreeze({
        ...state,
        phase: 'recovery',
        capabilityId: null,
        recovery: { ...clone(result), state: 'UNKNOWN', recoveryRequired: true },
      });
    }
    if (action.type === 'recovery-start') {
      return deepFreeze({ ...state, phase: 'recovery-querying', error: null });
    }
    if (action.type === 'recovery-result') {
      const result = clone(action.result);
      if (!result || !['UNKNOWN', 'COMMITTED', 'UNCOMMITTED'].includes(result.state)) {
        return deepFreeze({ ...state, phase: 'recovery', error: publicFailure(action.result) });
      }
      if (result.state === 'UNCOMMITTED') {
        return deepFreeze({ ...state, phase: 'idle', recovery: null, error: null });
      }
      if (result.state === 'COMMITTED' && result.recoveryRequired !== true) {
        return deepFreeze({ ...state, phase: 'structure-committed', recovery: result, error: null });
      }
      return deepFreeze({ ...state, phase: 'recovery', recovery: result, error: null });
    }
    if (action.type === 'recovery-error') {
      return deepFreeze({ ...state, phase: 'recovery', error: publicFailure(action.error) });
    }
    if (action.type === 'recovery-acknowledged' &&
        state.recovery?.operationId === action.operationId) {
      return deepFreeze({
        ...state,
        phase: 'structure-committed',
        recovery: { ...state.recovery, state: 'COMMITTED', recoveryRequired: false },
        error: null,
      });
    }
    if (action.type === 'continue-after-structure' &&
        state.phase === 'structure-committed' && state.mode === 'navigation') {
      return deepFreeze({
        ...state,
        goal: '',
        contextPaths: [],
        phase: 'idle',
        result: null,
        selectedAlternativeId: null,
        chapterDrafts: {},
        preview: null,
        capabilityId: null,
        recovery: null,
        actions: {},
        error: null,
      });
    }
    if (action.type === 'action-start') {
      if (state.phase !== 'navigation-ready' || !ACTION_ID_RE.test(action.actionId || '') ||
          !ATTEMPT_ID_RE.test(action.attemptId || '') ||
          state.actions[action.actionId]?.status === 'running') return state;
      return updateAction(state, action.actionId, {
        status: 'running',
        attemptId: action.attemptId,
        result: null,
        error: null,
      });
    }
    if (action.type === 'action-cancel-start') {
      const current = state.actions[action.actionId];
      if (!current || current.attemptId !== action.attemptId || current.status !== 'running') return state;
      return updateAction(state, action.actionId, { ...current, status: 'cancelling' });
    }
    if (action.type === 'action-result') {
      const current = state.actions[action.actionId];
      if (!current || current.attemptId !== action.attemptId) return state;
      const result = clone(action.result) || {};
      if (result.ok === true) {
        return updateAction(state, action.actionId, {
          status: 'success', attemptId: null, result, error: null,
        });
      }
      const failure = publicFailure(result);
      const terminal = /(?:STALE|PROJECT_CHANGED|ACTION_REPLAYED|ACTION_NOT_FOUND)/.test(
        String(result.error || '')
      );
      return updateAction(state, action.actionId, {
        status: terminal ? 'stale' : 'retryable',
        attemptId: null,
        result: null,
        error: failure,
      });
    }
    if (action.type === 'action-cancelled') {
      const current = state.actions[action.actionId];
      if (!current || current.attemptId !== action.attemptId) return state;
      return updateAction(state, action.actionId, {
        status: 'retryable',
        attemptId: null,
        result: null,
        error: publicFailure({ error: 'REQUEST_ABORTED' }),
      });
    }
    if (action.type === 'action-finally') return state;
    return state;
  }

  function contextView(manifest) {
    const used = manifest?.usedBodyCount || 0;
    const available = manifest?.availableBodyCount || 0;
    return Object.freeze({
      used,
      available,
      coverage: `基于本次已读取的 ${used}/${available} 个正文文件`,
      priorityBoundary: used < available
        ? '以下建议仅在本次已读范围内优先'
        : '',
      limitedIntent: manifest?.limitedProjectIntent === true,
      files: Array.isArray(manifest?.files) ? manifest.files : [],
      omitted: Math.max(0, available - used),
    });
  }

  function toViewModel(state) {
    return Object.freeze({
      ...state,
      selectedChapters: selectedChapters(state),
      selectedAlternative: state.result?.alternatives?.find(
        alternative => alternative.alternativeId === state.selectedAlternativeId
      ) || null,
      context: contextView(state.result?.contextManifest),
    });
  }

  return Object.freeze({
    RESULT_SCHEMA,
    REQUEST_SCHEMA,
    PREVIEW_SCHEMA,
    modeForTree,
    markdownPaths,
    validateChapter,
    createState,
    reduce,
    selectedChapters,
    requestPayload,
    publicFailure,
    toViewModel,
  });
});
