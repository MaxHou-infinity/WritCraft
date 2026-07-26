// WritCraft Context Inspector state (UMD, pure and DOM-free).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftContextInspectorState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_CHIPS = 64;
  const MAX_ERRORS = 50;
  const CHIP_TYPES = new Set(['scope', 'project_prompt', 'file', 'chapter', 'section', 'folder', 'source', 'entity', 'selection', 'neighbor', 'retrieval']);
  const REQUIRED_TYPES = new Set(['scope', 'project_prompt', 'selection']);

  function text(value, limit = 512) {
    return typeof value === 'string' ? value.slice(0, limit) : '';
  }

  function integer(value, fallback = 0) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function normalizeChip(chip, index) {
    if (!chip || !CHIP_TYPES.has(chip.type)) return null;
    const id = text(chip.id, 256) || `context-${chip.type}-${index}`;
    const filePaths = Array.isArray(chip.filePaths) ? chip.filePaths.map(path => text(path)).filter(Boolean).slice(0, 40) : [];
    return deepFreeze({
      id,
      type: chip.type,
      scope: ['project', 'file', 'selection'].includes(chip.scope) ? chip.scope : null,
      label: text(chip.label) || text(chip.filePath) || chip.type,
      filePath: text(chip.filePath) || null,
      filePaths,
      folderPath: text(chip.folderPath) || null,
      sourceId: text(chip.sourceId) || null,
      entityId: text(chip.entityId) || null,
      revision: text(chip.revision, 256) || null,
      locator: chip.locator && typeof chip.locator === 'object' ? deepFreeze({
        filePath: text(chip.locator.filePath) || null,
        line: integer(chip.locator.line, 1),
        column: integer(chip.locator.column, 1),
        offset: integer(chip.locator.offset),
        endOffset: integer(chip.locator.endOffset),
      }) : null,
      bytes: integer(chip.bytes),
      heading: text(chip.heading) || null,
      reason: text(chip.reason, 1000) || null,
      stale: Boolean(chip.stale),
      truncated: Boolean(chip.truncated),
      truncationReason: text(chip.truncationReason, 1000) || null,
      omittedCount: integer(chip.omittedCount),
      required: REQUIRED_TYPES.has(chip.type),
    });
  }

  function normalizeError(error, index) {
    if (!error || typeof error !== 'object') return null;
    return deepFreeze({
      id: `${text(error.code, 100) || 'CONTEXT_ERROR'}-${index}`,
      code: text(error.code, 100) || 'CONTEXT_ERROR',
      message: text(error.message, 1000) || '上下文未能解析',
      token: text(error.token, 256) || null,
      omittedCount: integer(error.omittedCount),
    });
  }

  function normalizeSnapshot(manifest, errors) {
    const source = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
    const seen = new Set();
    const chips = [];
    for (const [index, item] of (Array.isArray(source.chips) ? source.chips : []).slice(0, MAX_CHIPS).entries()) {
      const chip = normalizeChip(item, index);
      if (!chip || seen.has(chip.id)) continue;
      seen.add(chip.id);
      chips.push(chip);
    }
    const normalizedErrors = (Array.isArray(errors) ? errors : [])
      .slice(0, MAX_ERRORS)
      .map(normalizeError)
      .filter(Boolean);
    return deepFreeze({
      authority: 'main-manifest',
      scope: ['project', 'file', 'selection'].includes(source.scope) ? source.scope : 'file',
      currentFilePath: text(source.currentFilePath) || null,
      currentRevision: text(source.currentRevision, 256) || null,
      budgetChars: integer(source.budgetChars),
      budgetBytes: integer(source.budgetBytes),
      usedChars: integer(source.usedChars),
      usedBytes: integer(source.usedBytes),
      chips,
      errors: normalizedErrors,
    });
  }

  function createState(manifest, errors) {
    return deepFreeze({
      tab: 'actual',
      snapshot: normalizeSnapshot(manifest, errors),
      excludedChipIds: [],
    });
  }

  function reduce(state, action) {
    if (!state || !state.snapshot || !action || typeof action.type !== 'string') return state;
    if (action.type === 'set-tab') {
      if (action.tab !== 'actual' && action.tab !== 'next') return state;
      return action.tab === state.tab ? state : deepFreeze({ ...state, tab: action.tab });
    }
    const chip = state.snapshot.chips.find(item => item.id === action.chipId);
    if (!chip || chip.required) return state;
    if (action.type === 'exclude') {
      if (state.excludedChipIds.includes(chip.id)) return state;
      return deepFreeze({ ...state, excludedChipIds: [...state.excludedChipIds, chip.id] });
    }
    if (action.type === 'restore') {
      if (!state.excludedChipIds.includes(chip.id)) return state;
      return deepFreeze({ ...state, excludedChipIds: state.excludedChipIds.filter(id => id !== chip.id) });
    }
    return state;
  }

  function replaceSnapshot(state, manifest, errors) {
    const snapshot = normalizeSnapshot(manifest, errors);
    const optionalIds = new Set(snapshot.chips.filter(chip => !chip.required).map(chip => chip.id));
    return deepFreeze({
      tab: state?.tab === 'next' ? 'next' : 'actual',
      snapshot,
      excludedChipIds: (state?.excludedChipIds || []).filter(id => optionalIds.has(id)),
    });
  }

  function requestPolicy(state) {
    return deepFreeze({ excludedChipIds: [...(state?.excludedChipIds || [])] });
  }

  function formatBytes(value) {
    const bytes = integer(value);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function typeLabel(type) {
    return ({
      project_prompt: '项目提示', file: '文件', chapter: '章节', section: '段落', folder: '文件夹',
      scope: '作用域', source: '来源', entity: '实体', selection: '选段', neighbor: '邻段', retrieval: '检索片段',
    })[type] || type;
  }

  function toViewModel(state) {
    const excluded = new Set(state.excludedChipIds);
    return {
      tab: state.tab,
      authorityLabel: 'Main 已验证',
      scopeLabel: state.snapshot.scope === 'project' ? '项目范围'
        : state.snapshot.scope === 'selection' ? '选区范围' : '文件范围',
      currentFilePath: state.snapshot.currentFilePath,
      currentRevision: state.snapshot.currentRevision,
      usedLabel: state.snapshot.usedBytes ? formatBytes(state.snapshot.usedBytes) : `${state.snapshot.usedChars} 字符`,
      budgetLabel: `${state.snapshot.budgetChars} 字符上限`,
      chips: state.snapshot.chips.map(chip => ({
        ...chip,
        typeLabel: typeLabel(chip.type),
        bytesLabel: chip.bytes ? formatBytes(chip.bytes) : '大小未记录',
        revisionLabel: chip.revision ? chip.revision.slice(0, 10) : '无 revision',
        excluded: excluded.has(chip.id),
        removable: !chip.required,
      })),
      errors: state.snapshot.errors,
      excludedCount: state.excludedChipIds.length,
    };
  }

  return {
    MAX_CHIPS, MAX_ERRORS, CHIP_TYPES, REQUIRED_TYPES,
    normalizeSnapshot, createState, reduce, replaceSnapshot, requestPolicy, formatBytes, toViewModel,
  };
});
