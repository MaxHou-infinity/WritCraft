// Right-side Context bookmark page. It only emits exclusion IDs; it never creates context chips.
(function (root, factory) {
  const api = factory(root?.WritCraftContextInspectorState);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftContextInspector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (State) {
  'use strict';

  function element(document, tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function mount(container, options = {}) {
    if (!container || !container.ownerDocument) throw new TypeError('Context Inspector 需要 DOM 容器');
    if (!State) throw new Error('缺少 WritCraftContextInspectorState');
    const document = container.ownerDocument;
    let state = State.createState(options.manifest, options.errors);

    container.classList.add('context-inspector');
    container.setAttribute('aria-label', 'AI 上下文检查器');

    function dispatch(action) {
      const next = State.reduce(state, action);
      if (next === state) return;
      state = next;
      render();
      if (action.type === 'exclude' || action.type === 'restore') {
        options.onPolicyChange?.(State.requestPolicy(state));
      }
    }

    function metadataRow(chip) {
      const row = element(document, 'div', 'context-inspector__meta');
      row.append(
        element(document, 'span', '', chip.revisionLabel),
        element(document, 'span', '', chip.bytesLabel),
      );
      return row;
    }

    function chipCard(chip, interactive) {
      const card = element(document, 'article', `context-inspector__card context-inspector__card--${chip.type}`);
      if (chip.excluded) card.classList.add('is-excluded');
      const head = element(document, 'div', 'context-inspector__card-head');
      const title = element(document, 'div', 'context-inspector__card-title');
      title.append(
        element(document, 'span', 'context-inspector__kind', chip.typeLabel),
        element(document, 'strong', '', chip.label),
      );
      head.append(title);
      if (chip.required) {
        const lock = element(document, 'span', 'context-inspector__required', '固定');
        lock.title = chip.type === 'selection'
          ? '当前精确选段是选区作用域的固定上下文，不能在此移除'
          : '作用域与项目提示由 Main 自动加入，不能在此移除';
        head.append(lock);
      } else if (interactive) {
        const button = element(document, 'button', 'context-inspector__toggle', chip.excluded ? '恢复' : '移除');
        button.type = 'button';
        button.setAttribute('aria-label', `${chip.excluded ? '恢复' : '移除'}上下文 ${chip.label}`);
        button.addEventListener('click', () => dispatch({ type: chip.excluded ? 'restore' : 'exclude', chipId: chip.id }));
        head.append(button);
      }
      card.append(head);
      const path = chip.filePath || chip.folderPath || (chip.filePaths.length ? `${chip.filePaths.length} 个文件` : '');
      if (path) card.append(element(document, 'div', 'context-inspector__path', path));
      if (chip.heading) card.append(element(document, 'div', 'context-inspector__heading-path', chip.heading));
      if (chip.reason) card.append(element(document, 'p', 'context-inspector__reason', chip.reason));
      card.append(metadataRow(chip));
      if (chip.stale) card.append(element(document, 'p', 'context-inspector__warning', '△ 证据已过期，不会猜测新位置'));
      if (chip.truncated) {
        const warning = element(document, 'p', 'context-inspector__warning', chip.truncationReason || '上下文已截断');
        warning.prepend(element(document, 'span', '', '△ '));
        card.append(warning);
      }
      if (chip.locator && typeof options.onOpenLocator === 'function') {
        card.tabIndex = 0;
        card.classList.add('is-locatable');
        const open = () => options.onOpenLocator(chip.locator);
        card.addEventListener('dblclick', open);
        card.addEventListener('keydown', event => {
          if (event.key === 'Enter') open();
        });
      }
      return card;
    }

    function render() {
      const view = State.toViewModel(state);
      const fragment = document.createDocumentFragment();
      const header = element(document, 'header', 'context-inspector__header');
      const heading = element(document, 'div', 'context-inspector__heading');
      heading.append(element(document, 'span', 'context-inspector__bookmark', '▮'), element(document, 'h2', '', '上下文书签'));
      const authority = element(document, 'span', 'context-inspector__authority', view.authorityLabel);
      header.append(heading, authority);

      const tabs = element(document, 'div', 'context-inspector__tabs');
      tabs.setAttribute('role', 'tablist');
      const tabEntries = [['actual', '本次回复'], ['next', `下次提问${view.excludedCount ? ` −${view.excludedCount}` : ''}`]];
      for (const [index, [tab, label]] of tabEntries.entries()) {
        const button = element(document, 'button', '', label);
        button.type = 'button';
        button.id = `context-inspector-tab-${tab}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(view.tab === tab));
        button.setAttribute('aria-controls', 'context-inspector-content');
        button.tabIndex = view.tab === tab ? 0 : -1;
        button.addEventListener('click', () => dispatch({ type: 'set-tab', tab }));
        button.addEventListener('keydown', event => {
          let nextIndex = index;
          if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabEntries.length;
          else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabEntries.length) % tabEntries.length;
          else if (event.key === 'Home') nextIndex = 0;
          else if (event.key === 'End') nextIndex = tabEntries.length - 1;
          else return;
          event.preventDefault();
          const nextTab = tabEntries[nextIndex][0];
          dispatch({ type: 'set-tab', tab: nextTab });
          const focus = () => host.querySelector(`#context-inspector-tab-${nextTab}`)?.focus();
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
          else focus();
        });
        tabs.append(button);
      }

      const summary = element(document, 'section', 'context-inspector__summary');
      const scope = element(document, 'div', 'context-inspector__scope');
      scope.append(element(document, 'strong', '', view.currentFilePath || '未绑定文件'), element(document, 'span', '', view.scopeLabel));
      summary.append(scope, element(document, 'div', 'context-inspector__usage', `${view.usedLabel} / ${view.budgetLabel}`));
      if (view.currentRevision) summary.append(element(document, 'code', 'context-inspector__revision', `rev ${view.currentRevision.slice(0, 12)}`));

      const body = element(document, 'div', 'context-inspector__body');
      if (!view.chips.length) {
        body.append(element(document, 'p', 'context-inspector__empty', '这条回复没有可展示的上下文记录。'));
      } else {
        for (const chip of view.chips) body.append(chipCard(chip, view.tab === 'next'));
      }
      if (view.errors.length) {
        const issues = element(document, 'section', 'context-inspector__errors');
        issues.append(element(document, 'h3', '', `未纳入 · ${view.errors.length}`));
        for (const error of view.errors) {
          const item = element(document, 'div', 'context-inspector__error');
          item.append(element(document, 'code', '', error.code), element(document, 'p', '', error.message));
          issues.append(item);
        }
        body.append(issues);
      }
      const content = element(document, 'section', 'context-inspector__content');
      content.id = 'context-inspector-content';
      content.setAttribute('role', 'tabpanel');
      content.setAttribute('aria-labelledby', `context-inspector-tab-${view.tab}`);
      content.append(summary, body);
      fragment.append(header, tabs, content);
      container.replaceChildren(fragment);
    }

    render();
    return Object.freeze({
      update(manifest, errors) {
        state = State.replaceSnapshot(state, manifest, errors);
        render();
      },
      getState() { return state; },
      getRequestPolicy() { return State.requestPolicy(state); },
      destroy() { container.replaceChildren(); container.classList.remove('context-inspector'); },
    });
  }

  return { mount };
});
