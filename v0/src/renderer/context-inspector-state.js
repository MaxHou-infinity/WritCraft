// WritCraft Context Inspector state (UMD, pure and DOM-free).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftContextInspectorState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 64 Main context chips plus one synthetic, non-removable conversation
  // disclosure derived from the bounded top-level manifest metadata.
  const MAX_CHIPS = 65;
  const MAX_ERRORS = 50;
  const MAX_PROMPT_SECTIONS = 64;
  const CHIP_TYPES = new Set(['scope', 'project_prompt', 'conversation', 'file', 'chapter', 'section', 'folder', 'source', 'entity', 'selection', 'neighbor', 'retrieval']);
  const REQUIRED_TYPES = new Set(['scope', 'project_prompt', 'conversation', 'selection']);

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
    const chipRevision = text(chip.revision, 256) || null;
    const filePaths = Array.isArray(chip.filePaths) ? chip.filePaths.map(path => text(path)).filter(Boolean).slice(0, 40) : [];
    const sections = chip.type === 'project_prompt' && Array.isArray(chip.sections)
      ? chip.sections.slice(0, MAX_PROMPT_SECTIONS).map((section, sectionIndex) => {
        if (!section || typeof section !== 'object') return null;
        const status = section.status === 'used' ? 'used' : section.status === 'omitted' ? 'omitted' : null;
        if (!status) return null;
        const offset = section.locator && typeof section.locator === 'object' ? integer(section.locator.offset) : 0;
        const endOffset = section.locator && typeof section.locator === 'object'
          ? Math.max(offset, integer(section.locator.endOffset)) : 0;
        const locatorRevision = section.locator && typeof section.locator === 'object'
          ? text(section.locator.revision, 256) || null : null;
        return {
          id: text(section.id, 256) || `prompt-section-${sectionIndex}`,
          heading: text(section.heading) || '未命名章节',
          level: Math.min(6, integer(section.level)),
          status,
          reason: text(section.reason, 1000) || null,
          bytes: integer(section.bytes),
          locator: section.locator && typeof section.locator === 'object' &&
            chipRevision && locatorRevision === chipRevision ? {
            filePath: text(section.locator.filePath) || null,
            revision: locatorRevision,
            line: integer(section.locator.line, 1),
            column: integer(section.locator.column, 1),
            offset,
            endOffset,
          } : null,
        };
      }).filter(Boolean) : [];
    const sectionCount = Math.min(MAX_PROMPT_SECTIONS, Math.max(sections.length, integer(chip.sectionCount, sections.length)));
    const usedSectionCount = Math.min(sectionCount, integer(
      chip.usedSectionCount,
      sections.filter(section => section.status === 'used').length,
    ));
    const omittedSectionCount = Math.min(
      sectionCount - usedSectionCount,
      integer(chip.omittedSectionCount, sectionCount - usedSectionCount),
    );
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
      revision: chipRevision,
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
      sectionCount,
      usedSectionCount,
      omittedSectionCount,
      sections,
      includedTurnCount: integer(chip.includedTurnCount),
      totalTurnCount: integer(chip.totalTurnCount),
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

  function normalizeUnified(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
        manifest.schema !== 'writcraft.context-manifest/v2' || manifest.authority !== 'main' ||
        typeof manifest.entry !== 'string' || typeof manifest.editRevision !== 'string' ||
        !Array.isArray(manifest.items) || !manifest.totals || typeof manifest.editCompilation !== 'object') return null;
    const editCompilation = manifest.editCompilation;
    const items = manifest.items.slice(0, 65).map(item => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
          !['included', 'omitted', 'unavailable', 'stale'].includes(item.status)) return null;
      return deepFreeze({
        id: text(item.id, 256), kind: text(item.kind, 64), path: text(item.path, 512) || null,
        revision: text(item.revision, 256) || null, status: item.status,
        rawBytes: item.rawBytes === null ? null : integer(item.rawBytes),
        includedBytes: integer(item.includedBytes), budgetBytes: integer(item.budgetBytes),
        omissionReason: text(item.omissionReason, 64) || null,
        truncationReason: text(item.truncationReason, 64) || null,
      });
    }).filter(Boolean);
    return deepFreeze({
      schema: 'writcraft.context-manifest/v2', authority: 'main', entry: text(manifest.entry, 32),
      editRevision: text(manifest.editRevision, 256),
      editCompilation: deepFreeze({
        status: text(editCompilation.status, 32), rawBytes: integer(editCompilation.rawBytes),
        compiledBytes: integer(editCompilation.compiledBytes), budgetBytes: integer(editCompilation.budgetBytes),
        budgetChars: integer(editCompilation.budgetChars), availableSections: integer(editCompilation.availableSections),
        includedSections: integer(editCompilation.includedSections), omittedSections: integer(editCompilation.omittedSections),
        omissionReason: text(editCompilation.omissionReason, 64) || null,
        truncationReason: text(editCompilation.truncationReason, 64) || null,
        selectionPolicy: text(editCompilation.selectionPolicy, 128),
      }),
      items,
      totals: deepFreeze({
        availableItems: integer(manifest.totals.availableItems), includedItems: integer(manifest.totals.includedItems),
        omittedItems: integer(manifest.totals.omittedItems), rawBytes: manifest.totals.rawBytes === null ? null : integer(manifest.totals.rawBytes),
        includedBytes: integer(manifest.totals.includedBytes), budgetBytes: integer(manifest.totals.budgetBytes),
      }),
      sourceIndexRevision: text(manifest.sourceIndexRevision, 256) || null,
    });
  }

  function normalizeSnapshot(manifest, errors) {
    const source = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {};
    const seen = new Set();
    const chips = [];
    if (source.conversation && typeof source.conversation === 'object' &&
        integer(source.conversation.includedTurnCount) > 0) {
      const includedTurnCount = Math.min(6, integer(source.conversation.includedTurnCount));
      const totalTurnCount = Math.max(includedTurnCount, Math.min(6, integer(source.conversation.totalTurnCount)));
      const conversationChip = normalizeChip({
        id: 'ctx_conversation_recent',
        type: 'conversation',
        label: `最近对话 · ${includedTurnCount} 轮`,
        reason: `Main 有界保存并在本轮实际使用；当前会话共保留 ${totalTurnCount} 轮`,
        bytes: integer(source.conversation.bytes),
        includedTurnCount,
        totalTurnCount,
      }, 0);
      if (conversationChip) {
        seen.add(conversationChip.id);
        chips.push(conversationChip);
      }
    }
    const sourceChipLimit = Math.max(0, MAX_CHIPS - chips.length);
    for (const [index, item] of (Array.isArray(source.chips) ? source.chips : []).slice(0, sourceChipLimit).entries()) {
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
      unified: normalizeUnified(source.unified),
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
      scope: '作用域', conversation: '最近对话', source: '来源', entity: '实体',
      selection: '选段', neighbor: '邻段', retrieval: '检索片段',
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
      unified: state.snapshot.unified,
      usedLabel: state.snapshot.usedBytes ? formatBytes(state.snapshot.usedBytes) : `${state.snapshot.usedChars} 字符`,
      budgetLabel: `${state.snapshot.budgetChars} 字符上限`,
      chips: state.snapshot.chips.map(chip => ({
        ...chip,
        typeLabel: typeLabel(chip.type),
        bytesLabel: chip.bytes ? formatBytes(chip.bytes) : '大小未记录',
        revisionLabel: chip.revision ? chip.revision.slice(0, 10) : '无 revision',
        excluded: excluded.has(chip.id),
        removable: !chip.required,
        sectionSummary: chip.sections.length
          ? `${chip.usedSectionCount}/${chip.sectionCount} 章已使用 · ${chip.omittedSectionCount} 章省略`
          : null,
        sections: chip.sections.map(section => ({
          ...section,
          statusLabel: section.status === 'used' ? '已使用' : '已省略',
          bytesLabel: section.bytes ? formatBytes(section.bytes) : '未进入请求',
        })),
      })),
      errors: state.snapshot.errors,
      excludedCount: state.excludedChipIds.length,
    };
  }

  return {
    MAX_CHIPS, MAX_ERRORS, MAX_PROMPT_SECTIONS, CHIP_TYPES, REQUIRED_TYPES,
    normalizeSnapshot, createState, reduce, replaceSnapshot, requestPolicy, formatBytes, toViewModel,
  };
});
