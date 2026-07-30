(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftChangesHistoryPresentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_CONFIRM_PATHS = 5;

  function cleanPath(value) {
    return typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      : '';
  }

  function pathsFor(entry) {
    if (!entry || !Array.isArray(entry.files)) return [];
    return entry.files.map(file => cleanPath(file?.path)).filter(Boolean);
  }

  function target(entry) {
    const paths = pathsFor(entry);
    if (!paths.length) {
      return Object.freeze({ title: '仅审阅记录', detail: '项目文件未改变' });
    }
    if (paths.length === 1 && paths[0] === 'edit.md') {
      return Object.freeze({ title: '项目 Prompt · edit.md', detail: 'edit.md' });
    }
    if (paths.length === 1) {
      return Object.freeze({ title: paths[0], detail: paths[0] });
    }
    const visible = paths.slice(0, 3);
    return Object.freeze({
      title: `${paths.length} 个文件`,
      detail: `${visible.join('、')}${paths.length > visible.length ? ` 等 ${paths.length} 个文件` : ''}`,
    });
  }

  function undoConfirmation(entry, options = {}) {
    const paths = pathsFor(entry);
    if (!paths.length) return null;
    const visible = paths.slice(0, MAX_CONFIRM_PATHS);
    const lines = visible.map(path => `• ${path}`);
    if (paths.length > visible.length) lines.push(`• 另有 ${paths.length - visible.length} 个文件`);
    const warnings = [];
    if (options.isLatest === false) {
      warnings.push('⚠️ 这不是最新修改记录。请确认你要撤销的是下面这条历史。');
    }
    if (paths.includes('edit.md')) {
      warnings.push('⚠️ 其中包含项目 Prompt · edit.md；撤销会改变后续 AI 使用的项目上下文。');
    }
    return [
      ...warnings,
      '确认撤销以下修改记录？',
      ...lines,
      '',
      '撤销前会再次检查所有文件版本。',
    ].join('\n');
  }

  return Object.freeze({ target, undoConfirmation });
});
