// WritCraft V0 · exact diagnostic preview before Main-owned export.
(function () {
  'use strict';

  const PREVIEW_SCHEMA = 'writcraft.diagnostic-preview/v1';
  const EXPORT_SCHEMA = 'writcraft.diagnostic-export/v1';
  const MAX_SERIALIZED_BYTES = 512 * 1024;
  const bridge = window.writCraft?.diagnostics;
  const openButton = document.getElementById('diagnostic-preview-open');
  const dialog = document.getElementById('diagnostic-dialog');
  const card = dialog?.querySelector('.diagnostic-card');
  const closeButton = document.getElementById('diagnostic-close');
  const refreshButton = document.getElementById('diagnostic-refresh');
  const exportButton = document.getElementById('diagnostic-export');
  const preview = document.getElementById('diagnostic-serialized');
  const feedback = document.getElementById('diagnostic-feedback');
  if (!openButton || !dialog || !card || !closeButton || !refreshButton ||
      !exportButton || !preview || !feedback) return;

  let livePreview = null;
  let requestGeneration = 0;
  let returnFocus = null;
  let exporting = false;
  let expiryTimer = null;

  function byteLength(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function validToken(value) {
    return typeof value === 'string' && value.length >= 16 && value.length <= 256 &&
      /^[A-Za-z0-9_-]+$/.test(value);
  }

  function normalizePreview(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.ok !== true || value.schema !== PREVIEW_SCHEMA ||
        !validToken(value.token) || typeof value.serialized !== 'string' ||
        !value.serialized || byteLength(value.serialized) > MAX_SERIALIZED_BYTES ||
        typeof value.expiresAt !== 'string' || Number.isNaN(Date.parse(value.expiresAt))) return null;
    return Object.freeze({
      token: value.token,
      expiresAt: value.expiresAt,
      serialized: value.serialized,
    });
  }

  function setFeedback(message = '', isError = false) {
    feedback.textContent = message;
    feedback.classList.toggle('is-error', Boolean(isError));
  }

  function setBusy(busy) {
    refreshButton.disabled = Boolean(busy || exporting);
    exportButton.disabled = Boolean(busy || exporting || !livePreview);
    dialog.setAttribute('aria-busy', String(Boolean(busy || exporting)));
  }

  function invalidatePreview(message = '正在生成只读预览…') {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    livePreview = null;
    preview.textContent = message;
    preview.dataset.empty = 'true';
    exportButton.disabled = true;
  }

  async function refreshPreview(options = {}) {
    const generation = ++requestGeneration;
    invalidatePreview();
    setFeedback('正在从应用读取经过筛选的诊断信息…');
    setBusy(true);
    let result = null;
    try {
      result = await bridge?.preview?.();
    } catch (_) {}
    if (generation !== requestGeneration || dialog.hidden) return false;
    const normalized = normalizePreview(result);
    if (!normalized) {
      invalidatePreview('诊断预览暂时不可用。没有内容可以导出。');
      setFeedback(result?.message || '无法生成安全诊断预览，请稍后重试。', true);
      setBusy(false);
      if (options.focusPreview) refreshButton.focus();
      return false;
    }
    livePreview = normalized;
    // Deliberately do not parse, format, or rebuild this string. It is the
    // exact Main-owned UTF-8 payload that the token may export.
    preview.textContent = normalized.serialized;
    preview.dataset.empty = 'false';
    const remainingMs = Date.parse(normalized.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      invalidatePreview('这份诊断预览已经过期。请刷新后再导出。');
      setFeedback('诊断预览已经过期；没有内容可以导出。', true);
      setBusy(false);
      return false;
    }
    expiryTimer = setTimeout(() => {
      if (livePreview !== normalized) return;
      invalidatePreview('这份诊断预览已经过期。请刷新后再导出。');
      setFeedback('诊断预览已经过期；请刷新后再导出。', true);
    }, Math.min(remainingMs, 0x7fffffff));
    setFeedback(`预览有效至 ${new Date(normalized.expiresAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    })}。导出前可以再次刷新。`);
    setBusy(false);
    if (options.focusPreview) preview.focus();
    return true;
  }

  function openDialog() {
    if (!dialog.hidden) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
    dialog.hidden = false;
    exporting = false;
    closeButton.focus();
    void refreshPreview();
  }

  function closeDialog() {
    if (dialog.hidden || exporting) return;
    ++requestGeneration;
    livePreview = null;
    dialog.hidden = true;
    invalidatePreview();
    setFeedback();
    const target = returnFocus?.isConnected ? returnFocus : openButton;
    returnFocus = null;
    target?.focus?.();
  }

  async function exportPreview() {
    if (exporting || !livePreview || typeof bridge?.export !== 'function') return;
    const previewAtStart = livePreview;
    if (Date.parse(previewAtStart.expiresAt) <= Date.now()) {
      invalidatePreview('这份诊断预览已经过期。请刷新后再导出。');
      setFeedback('诊断预览已经过期；请刷新后再导出。', true);
      refreshButton.focus();
      return;
    }
    exporting = true;
    setBusy(true);
    setFeedback('正在等待你选择本机保存位置…');
    let result = null;
    try {
      result = await bridge.export(previewAtStart.token);
    } catch (_) {}
    exporting = false;
    if (dialog.hidden || livePreview !== previewAtStart) return;
    if (result?.canceled === true) {
      setFeedback('已取消导出；没有写入任何文件。你仍可导出当前预览。');
      setBusy(false);
      exportButton.focus();
      return;
    }
    if (result?.ok === true && result.schema === EXPORT_SCHEMA &&
        typeof result.basename === 'string' && result.basename &&
        !result.basename.includes('/') && !result.basename.includes('\\')) {
      livePreview = null;
      setFeedback(`已导出 ${result.basename}。如需再次导出，请刷新预览。`);
      setBusy(false);
      refreshButton.focus();
      return;
    }
    setFeedback(result?.message || '导出未完成；当前预览仍保留，可以重试或刷新。', true);
    setBusy(false);
    exportButton.textContent = '重试导出';
    exportButton.focus();
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
      .filter(node => !node.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  openButton.addEventListener('click', openDialog);
  closeButton.addEventListener('click', closeDialog);
  refreshButton.addEventListener('click', () => {
    exportButton.textContent = '导出这份诊断';
    void refreshPreview({ focusPreview: true });
  });
  exportButton.addEventListener('click', exportPreview);
  dialog.addEventListener('click', event => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDialog();
      return;
    }
    trapFocus(event);
  });

  window.WritCraftDiagnosticExportView = Object.freeze({
    open: openDialog,
    close: closeDialog,
    refresh: refreshPreview,
  });
})();
