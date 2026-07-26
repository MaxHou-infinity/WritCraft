// Pure Composer context-file selection helpers (UMD, no DOM/IPC).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftComposerContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_CONTEXT_FILES = 8;

  function isPublicMarkdownPath(value) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= 512
      && !value.includes('\0')
      && !value.startsWith('/')
      && !value.startsWith('\\')
      && !/^[A-Za-z]:/.test(value)
      && !value.includes('\\')
      && /\.(?:md|markdown)$/i.test(value)
      && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
  }

  function collectMarkdownPaths(nodes, output = []) {
    for (const node of nodes || []) {
      const filePath = node && (node.path || node.relativePath || '');
      if (node?.type === 'file' && isPublicMarkdownPath(filePath)) output.push(filePath);
      if (node?.type === 'directory' || Array.isArray(node?.children)) collectMarkdownPaths(node.children || [], output);
    }
    return output;
  }

  function availableContextPaths(tree, targetPath) {
    const target = isPublicMarkdownPath(targetPath) ? targetPath : '';
    return [...new Set(collectMarkdownPaths(tree))]
      .filter(filePath => filePath !== target && filePath.toLocaleLowerCase('en-US') !== 'edit.md')
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  function reconcileSelection(selected, available, max = MAX_CONTEXT_FILES) {
    const allowed = new Set((available || []).filter(isPublicMarkdownPath));
    const limit = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_CONTEXT_FILES) : MAX_CONTEXT_FILES;
    return [...new Set((selected || []).filter(path => allowed.has(path)))].slice(0, limit);
  }

  function updateSelection(selected, filePath, checked, available) {
    const candidates = Array.isArray(available) ? available : [];
    const safe = reconcileSelection(selected, candidates);
    if (!candidates.includes(filePath) || !isPublicMarkdownPath(filePath)) {
      return { selected: safe, ok: false, error: 'CONTEXT_PATH_UNAVAILABLE' };
    }
    if (!checked) return { selected: safe.filter(path => path !== filePath), ok: true, error: null };
    if (safe.includes(filePath)) return { selected: safe, ok: true, error: null };
    if (safe.length >= MAX_CONTEXT_FILES) {
      return { selected: safe, ok: false, error: 'CONTEXT_LIMIT' };
    }
    return { selected: [...safe, filePath], ok: true, error: null };
  }

  return Object.freeze({
    MAX_CONTEXT_FILES,
    isPublicMarkdownPath,
    collectMarkdownPaths,
    availableContextPaths,
    reconcileSelection,
    updateSelection,
  });
});
