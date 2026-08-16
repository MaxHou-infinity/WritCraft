// WritCraft V0 · 纯路径/树辅助函数（自 workspace.js 抽取，无 DOM/状态依赖）
// 由 index.html 在 workspace.js 之前加载，暴露 window.WritCraftWorkspaceHelpers。

'use strict';

(function () {
  function isPublicMarkdownPath(value) {
    return typeof value === 'string'
      && /\.(?:md|markdown)$/i.test(value)
      && !value.startsWith('/')
      && !value.includes('\\')
      && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
  }

  function fileName(filePath) {
    return filePath.split('/').filter(Boolean).pop() || filePath;
  }

  function isMarkdown(node) {
    const path = node.path || node.relativePath || '';
    return node.type === 'file' && /\.(?:md|markdown)$/i.test(path);
  }

  function nodePath(node) {
    return node.path || node.relativePath || node.name || '';
  }

  function markdownPaths(nodes, result = []) {
    for (const node of nodes || []) {
      if (isMarkdown(node)) result.push(nodePath(node));
      if (node.children) markdownPaths(node.children, result);
    }
    return result;
  }

  function relativeAssetPath(documentPath, assetPath) {
    const from = String(documentPath || '').split('/').slice(0, -1);
    const to = String(assetPath || '').split('/');
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
    return `${'../'.repeat(from.length - common)}${to.slice(common).join('/')}`;
  }

  window.WritCraftWorkspaceHelpers = Object.freeze({
    isPublicMarkdownPath,
    fileName,
    isMarkdown,
    nodePath,
    markdownPaths,
    relativeAssetPath,
  });
})();
