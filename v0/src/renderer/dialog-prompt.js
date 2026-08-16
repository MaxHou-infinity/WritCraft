// WritCraft V0 · 通用对话框助手（替换原生 window.prompt / window.confirm）
// 由 index.html 在 workspace.js / changes-view.js / image-generation-view.js
// 之前加载，暴露 window.WritCraftDialogs。缺失 <dialog> 能力时回退到原生 API。

'use strict';

(function () {
  const CONFIRM_DIALOG = document.getElementById('confirm-dialog');
  const CONFIRM_TITLE = document.getElementById('confirm-title');
  const CONFIRM_MESSAGE = document.getElementById('confirm-message');
  const CONFIRM_OK = document.getElementById('confirm-ok');
  const CONFIRM_CANCEL = document.getElementById('confirm-cancel');

  const INPUT_DIALOG = document.getElementById('input-dialog');
  const INPUT_TITLE = document.getElementById('input-title');
  const INPUT_FIELD = document.getElementById('input-field');
  const INPUT_OK = document.getElementById('input-ok');
  const INPUT_CANCEL = document.getElementById('input-cancel');

  function confirmDialog(message, options = {}) {
    if (!CONFIRM_DIALOG || typeof CONFIRM_DIALOG.showModal !== 'function') {
      return Promise.resolve(window.confirm(message));
    }
    return new Promise(resolve => {
      CONFIRM_TITLE.textContent = options.title || '确认';
      CONFIRM_MESSAGE.textContent = String(message || '');
      const settle = value => {
        CONFIRM_OK.removeEventListener('click', onOk);
        CONFIRM_CANCEL.removeEventListener('click', onCancel);
        CONFIRM_DIALOG.removeEventListener('cancel', onCancel);
        try { CONFIRM_DIALOG.close(); } catch (_) {}
        resolve(value);
      };
      const onOk = () => settle(true);
      const onCancel = () => settle(false);
      CONFIRM_OK.addEventListener('click', onOk);
      CONFIRM_CANCEL.addEventListener('click', onCancel);
      CONFIRM_DIALOG.addEventListener('cancel', onCancel, { once: true });
      CONFIRM_DIALOG.showModal();
    });
  }

  function inputDialog(title, placeholder, initial = '') {
    if (!INPUT_DIALOG || typeof INPUT_DIALOG.showModal !== 'function') {
      const value = window.prompt(String(placeholder || ''), String(initial || ''));
      return Promise.resolve(value === null ? null : value.trim());
    }
    return new Promise(resolve => {
      INPUT_TITLE.textContent = String(title || '输入');
      INPUT_FIELD.placeholder = String(placeholder || '');
      INPUT_FIELD.value = String(initial || '');
      const settle = value => {
        INPUT_OK.removeEventListener('click', onOk);
        INPUT_CANCEL.removeEventListener('click', onCancel);
        INPUT_DIALOG.removeEventListener('cancel', onCancel);
        INPUT_FIELD.removeEventListener('keydown', onEnter);
        try { INPUT_DIALOG.close(); } catch (_) {}
        resolve(value);
      };
      const onOk = () => settle(INPUT_FIELD.value.trim() || null);
      const onCancel = () => settle(null);
      const onEnter = event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          onOk();
        }
      };
      INPUT_OK.addEventListener('click', onOk);
      INPUT_CANCEL.addEventListener('click', onCancel);
      INPUT_DIALOG.addEventListener('cancel', onCancel, { once: true });
      INPUT_FIELD.addEventListener('keydown', onEnter);
      INPUT_DIALOG.showModal();
      INPUT_FIELD.focus();
      INPUT_FIELD.select();
    });
  }

  window.WritCraftDialogs = Object.freeze({
    confirm: confirmDialog,
    input: inputDialog,
  });
})();
