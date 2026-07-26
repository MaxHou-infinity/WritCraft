// WritCraft Chat scope/request state (UMD, pure and DOM-free).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftChatContextState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUEST_SCHEMA = 'writcraft.chat-context/v1';
  const SCOPES = Object.freeze(['project', 'file', 'selection']);

  function validSelection(selection) {
    return Boolean(selection && typeof selection === 'object' && !Array.isArray(selection) &&
      typeof selection.filePath === 'string' && selection.filePath &&
      typeof selection.text === 'string' && selection.text.trim() &&
      Number.isSafeInteger(selection.startOffset) && Number.isSafeInteger(selection.endOffset) &&
      selection.startOffset >= 0 && selection.endOffset > selection.startOffset &&
      selection.endOffset - selection.startOffset === selection.text.length);
  }

  function defaultScope(selection) {
    return validSelection(selection) ? 'selection' : 'file';
  }

  function normalizeScope(scope, selection) {
    if (scope === 'project' || scope === 'file') return scope;
    return scope === 'selection' && validSelection(selection) ? 'selection' : defaultScope(selection);
  }

  function cleanPolicy(policy) {
    const source = Array.isArray(policy?.excludedChipIds) ? policy.excludedChipIds : [];
    return Object.freeze({ excludedChipIds: Object.freeze(source.filter(id => typeof id === 'string' && id).slice(0, 128)) });
  }

  function createRequest({ scope, message, currentFilePath, selection, contextPolicy }) {
    if (typeof message !== 'string' || typeof currentFilePath !== 'string' || !currentFilePath) {
      throw new TypeError('Chat 结构化请求缺少问题或当前文件');
    }
    const normalizedScope = normalizeScope(scope, selection);
    if (scope === 'selection' && normalizedScope !== 'selection') {
      throw new TypeError('选区作用域需要精确选段');
    }
    const exactSelection = normalizedScope === 'selection' ? Object.freeze({
      filePath: selection.filePath,
      text: selection.text,
      startOffset: selection.startOffset,
      endOffset: selection.endOffset,
    }) : null;
    return Object.freeze({
      schema: REQUEST_SCHEMA,
      scope: normalizedScope,
      message,
      currentFilePath,
      selection: exactSelection,
      contextPolicy: cleanPolicy(contextPolicy),
    });
  }

  function locatorForChip(chip) {
    if (!chip || typeof chip !== 'object' || chip.stale) return null;
    const candidates = [chip.locator, ...(Array.isArray(chip.evidence) ? chip.evidence : [])];
    for (const candidate of candidates) {
      if (!candidate || candidate.stale) continue;
      const filePath = candidate.filePath || candidate.path || chip.filePath;
      const offset = Number.isSafeInteger(candidate.offset) ? candidate.offset
        : Number.isSafeInteger(candidate.start) ? candidate.start : null;
      const endOffset = Number.isSafeInteger(candidate.endOffset) ? candidate.endOffset
        : Number.isSafeInteger(candidate.end) ? candidate.end : offset;
      if (typeof filePath === 'string' && filePath && offset !== null && endOffset !== null && offset >= 0 && endOffset >= offset) {
        return Object.freeze({ filePath, offset, endOffset });
      }
    }
    return null;
  }

  function chipLabel(chip) {
    if (!chip) return '上下文';
    if (chip.type === 'scope') return chip.scope === 'project' ? '◎ 项目' : chip.scope === 'selection' ? '◎ 选区' : '◎ 文件';
    if (chip.type === 'project_prompt') return '✦ edit.md';
    if (chip.type === 'folder') return `🗂 ${chip.folderPath}`;
    if (chip.type === 'entity') return `◈ ${chip.label}`;
    if (chip.type === 'source') return `⌘ ${chip.label}`;
    if (chip.type === 'section') return `§ ${chip.label}`;
    if (chip.type === 'selection') return '🎯 选段';
    if (chip.type === 'neighbor') return `≈ ${chip.label}`;
    if (chip.type === 'retrieval') return `⌕ ${chip.label}`;
    if (chip.type === 'chapter') return `◇ ${chip.label}`;
    return `@ ${chip.filePath || chip.label || chip.type}`;
  }

  function bindChipButton(button, chip, onReveal) {
    if (!button || typeof button.addEventListener !== 'function') throw new TypeError('Context Chip 需要可交互按钮');
    button.type = 'button';
    button.dataset ||= {};
    button.dataset.type = chip?.type || 'unknown';
    button.textContent = chipLabel(chip);
    button.title = chip?.truncationReason || chip?.reason ||
      `${chip?.filePath || chip?.label || chip?.type || '上下文'}${chip?.revision ? ` · ${chip.revision.slice(0, 12)}` : ''}`;
    if (chip?.truncated) button.dataset.truncated = 'true';
    button.addEventListener('click', () => onReveal?.(chip));
    return button;
  }

  function createChipOwnership() {
    let owner = null;
    return Object.freeze({
      publish(requestToken, phase) {
        if (!Number.isSafeInteger(requestToken) || requestToken < 1 ||
            !['preflight', 'actual'].includes(phase)) {
          throw new TypeError('Chat Context Chips 所有权无效');
        }
        owner = Object.freeze({ requestToken, phase });
        return owner;
      },
      clearPreflight(requestToken = null) {
        if (owner?.phase !== 'preflight') return false;
        if (requestToken !== null && owner.requestToken !== requestToken) return false;
        owner = null;
        return true;
      },
      clearAll() {
        const changed = owner !== null;
        owner = null;
        return changed;
      },
      get: () => owner,
    });
  }

  function isAuthoritativeCancellation(result) {
    return Boolean(result && typeof result === 'object' && !Array.isArray(result) &&
      result.ok === false && result.error === 'PROJECT_CHANGED');
  }

  return Object.freeze({
    REQUEST_SCHEMA,
    SCOPES,
    validSelection,
    defaultScope,
    normalizeScope,
    createRequest,
    locatorForChip,
    chipLabel,
    bindChipButton,
    createChipOwnership,
    isAuthoritativeCancellation,
  });
});
