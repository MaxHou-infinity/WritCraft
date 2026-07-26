// WritCraft V0 · Diff 高亮渲染（Day 4.2）
// 用 word-level diff 显示 AI 修改/删除/新增
// 依赖: diff.min.js (window.diff) 全局挂载

(function () {
  /**
   * 渲染 word-level diff HTML
   * @param {string} oldText - 原文（⌘K 选中段）
   * @param {string} newText - AI 改写建议
   * @returns {string} HTML 字符串（带 <span class="diff-add/remove/eq">）
   */
  function renderDiff(oldText, newText) {
    const diffApi = window.Diff || window.diff;
    if (!diffApi) {
      // 降级方案：单纯显示新文本
      return `<span class="diff-eq">${escapeHtml(newText || '')}</span>`;
    }

    // word-level diff（中文以单字为单位）
    const fragments = diffApi.diffWords(oldText || '', newText || '');
    return fragments.map(f => {
      const cls = f.added ? 'diff-add'
                : f.removed ? 'diff-remove'
                : 'diff-eq';
      return `<span class="${cls}">${escapeHtml(f.value)}</span>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 暴露给 editor.js
  window.__diffRender = { renderDiff };
})();
