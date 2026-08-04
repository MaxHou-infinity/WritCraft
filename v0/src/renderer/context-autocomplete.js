// Main-owned @ context completion.  The input node is never replaced: only a
// detached popup is updated, preserving focus, caret and IME composition.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftContextAutocomplete = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function mount(document, options = {}) {
    if (!document || typeof document.addEventListener !== 'function') return { destroy() {} };
    const list = document.createElement('div');
    list.className = 'context-autocomplete';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    document.body.appendChild(list);
    let activeInput = null;
    let activeCandidates = [];
    let activeIndex = 0;
    let sequence = 0;
    let tokenStart = -1;
    let tokenEnd = -1;

    function hide() {
      activeInput = null;
      activeCandidates = [];
      list.hidden = true;
      list.replaceChildren();
    }

    function inputToken(input) {
      const caret = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
      const before = input.value.slice(0, caret);
      const at = before.lastIndexOf('@');
      if (at < 0) return null;
      const token = before.slice(at + 1);
      if (/\n/.test(token) || (/[\s]/.test(token) && !/^(?:file|folder|chapter|section|source|entity)\s*:\s*[^\n]*$/iu.test(token))) return null;
      if (token.length > 120) return null;
      tokenStart = at;
      tokenEnd = caret;
      return token.trim();
    }

    function position(input) {
      const rect = input.getBoundingClientRect();
      list.style.left = `${Math.max(8, Math.round(rect.left))}px`;
      list.style.top = `${Math.round(rect.bottom + 5)}px`;
      list.style.width = `${Math.max(230, Math.min(420, Math.round(rect.width)))}px`;
    }

    function render(input, candidates) {
      activeInput = input;
      activeCandidates = candidates;
      activeIndex = 0;
      list.replaceChildren();
      candidates.forEach((candidate, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'context-autocomplete__item';
        button.setAttribute('role', 'option');
        button.dataset.index = String(index);
        button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
        const label = document.createElement('strong');
        label.textContent = `${candidate.kind} · ${candidate.label}`;
        const token = document.createElement('span');
        token.textContent = candidate.insertText;
        button.append(label, token);
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          insert(candidate);
        });
        list.appendChild(button);
      });
      list.hidden = candidates.length === 0;
      if (!list.hidden) position(input);
    }

    function setActive(index) {
      activeIndex = Math.max(0, Math.min(activeCandidates.length - 1, index));
      [...list.querySelectorAll('[role="option"]')].forEach((node, itemIndex) => {
        node.setAttribute('aria-selected', itemIndex === activeIndex ? 'true' : 'false');
      });
    }

    function insert(candidate) {
      if (!activeInput || !(candidate?.referenceToken || candidate?.insertText)) return;
      const input = activeInput;
      const value = input.value;
      const end = tokenEnd >= 0 ? tokenEnd : input.selectionStart;
      // Submit only the request-bound opaque token. Main resolves it against
      // the catalog/revision; insertText remains display/fallback metadata.
      const insertion = candidate.referenceToken || candidate.insertText;
      const next = [value.slice(0, tokenStart), insertion, ' ', value.slice(end)].join('');
      const caret = tokenStart + insertion.length + 1;
      input.value = next;
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      input.focus();
    }

    async function update(input) {
      if (!input.matches?.('[data-context-input]')) return;
      const query = inputToken(input);
      if (query === null || typeof options.listCandidates !== 'function') return hide();
      const projectInstanceId = options.getProjectInstanceId?.();
      if (!projectInstanceId) return hide();
      const requestId = ++sequence;
      try {
        const response = await options.listCandidates(projectInstanceId, {
          query,
          currentFilePath: options.getCurrentFilePath?.() || null,
        });
        if (requestId !== sequence || document.activeElement !== input) return;
        if (response?.ok !== true || response.projectInstanceId !== projectInstanceId) return hide();
        render(input, Array.isArray(response.candidates) ? response.candidates : []);
      } catch (_) {
        if (requestId === sequence) hide();
      }
    }

    function onInput(event) { void update(event.target); }
    function onKeydown(event) {
      if (event.target !== activeInput || list.hidden) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(activeIndex + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(activeIndex - 1); }
      else if (event.key === 'Enter' && activeCandidates[activeIndex]) { event.preventDefault(); insert(activeCandidates[activeIndex]); }
      else if (event.key === 'Escape') { event.preventDefault(); hide(); }
    }
    function onBlur(event) {
      if (event.target === activeInput && !list.contains(event.relatedTarget)) setTimeout(hide, 0);
    }
    function onResize() { if (activeInput && !list.hidden) position(activeInput); }
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('blur', onBlur, true);
    window.addEventListener('resize', onResize);
    return {
      destroy() {
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('blur', onBlur, true);
        window.removeEventListener('resize', onResize);
        list.remove();
      },
      hide,
    };
  }

  return Object.freeze({ mount });
});
