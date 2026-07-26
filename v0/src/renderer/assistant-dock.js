// WritCraft right-side Chat / Plan / Context / Changes book-tab controller.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftAssistantDock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODES = Object.freeze(['chat', 'plan', 'context', 'changes']);

  function mount(options = {}) {
    const workArea = options.workArea;
    const dock = options.dock;
    if (!workArea || !dock) throw new TypeError('Assistant Dock 缺少工作区容器');
    const buttons = [...dock.querySelectorAll('[data-assistant-mode]')];
    const panels = new Map(MODES.map(mode => [mode, dock.querySelector(`[data-assistant-panel="${mode}"]`)]));
    for (const button of buttons) {
      const mode = button.dataset.assistantMode;
      const panel = panels.get(mode);
      if (!panel) continue;
      button.id ||= `assistant-tab-${mode}`;
      panel.id ||= `assistant-panel-${mode}`;
      button.setAttribute('aria-controls', panel.id);
      panel.setAttribute('aria-labelledby', button.id);
    }
    let currentMode = null;

    function render(focus = false) {
      workArea.classList.toggle('has-assistant', Boolean(currentMode));
      dock.hidden = !currentMode;
      for (const button of buttons) {
        const active = button.dataset.assistantMode === currentMode;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        if (active && focus) button.focus();
      }
      for (const [mode, panel] of panels) {
        if (!panel) continue;
        const active = mode === currentMode;
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
        panel.tabIndex = active ? 0 : -1;
      }
      dock.dataset.mode = currentMode || '';
      document.dispatchEvent(new CustomEvent('writcraft:assistant-mode-changed', { detail: { mode: currentMode } }));
    }

    function open(mode, openOptions = {}) {
      if (!MODES.includes(mode) || !panels.get(mode)) return false;
      if (options.beforeOpen?.(mode) === false || openOptions.beforeOpen?.(mode) === false) return false;
      currentMode = mode;
      render(Boolean(openOptions.focusTab));
      options.onOpen?.(mode);
      openOptions.onOpen?.(mode);
      return true;
    }

    function close(mode) {
      if (mode && currentMode !== mode) return false;
      const prior = currentMode;
      currentMode = null;
      render();
      options.onClose?.(prior);
      return true;
    }

    function moveTab(delta) {
      const currentIndex = Math.max(0, MODES.indexOf(currentMode));
      const next = MODES[(currentIndex + delta + MODES.length) % MODES.length];
      open(next, { focusTab: true });
    }

    for (const button of buttons) {
      button.addEventListener('click', () => open(button.dataset.assistantMode));
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); moveTab(1); }
        if (event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1); }
        if (event.key === 'Home') { event.preventDefault(); open(MODES[0], { focusTab: true }); }
        if (event.key === 'End') { event.preventDefault(); open(MODES[MODES.length - 1], { focusTab: true }); }
      });
    }
    dock.querySelector('[data-assistant-close]')?.addEventListener('click', () => close());
    dock.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    });
    render();
    return Object.freeze({
      open,
      close,
      getMode: () => currentMode,
      isOpen: mode => Boolean(currentMode && (!mode || currentMode === mode)),
      destroy() {
        currentMode = null;
        render();
      },
    });
  }

  return { MODES, mount };
});
