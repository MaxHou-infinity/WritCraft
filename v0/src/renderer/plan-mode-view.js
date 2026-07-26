(function (root, factory) {
  const api = factory(root?.WritCraftPlanModeState);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftPlanModeView = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (DefaultState) {
  'use strict';

  const SCOPE_LABELS = Object.freeze({
    project: '项目级', file: '文件级', paragraph: '段落级', research: '资料核验',
  });

  function element(document, tag, className, label) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    return node;
  }

  function button(document, label, className, action) {
    const node = element(document, 'button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function mount(host, options = {}) {
    if (!host || !host.ownerDocument) throw new TypeError('Plan Mode 需要 DOM 容器');
    const State = options.stateApi || DefaultState;
    if (!State) throw new Error('缺少 WritCraftPlanModeState');
    const document = host.ownerDocument;
    let state = State.createState(options.initialState || options.result);

    host.classList.add('plan-mode');
    host.setAttribute('aria-label', '项目计划');

    function dispatch(action) {
      const next = State.reduce(state, action);
      if (next === state) return;
      state = next;
      render();
      options.onStateChange?.(state);
    }

    async function requestPlan() {
      if (state.status === 'loading') return;
      dispatch({ type: 'load-start' });
      try {
        const result = await options.onRequestPlan?.();
        if (!result) throw new Error('计划生成器没有返回结果');
        if (result.canceled) return;
        if (result.ok === false) throw new Error(result.message || '计划生成失败');
        dispatch({ type: 'load-result', result });
      } catch (error) {
        dispatch({ type: 'load-error', message: error?.message });
      }
    }

    function statusView(kind, title, description, actionLabel) {
      const section = element(document, 'section', `plan-mode__status plan-mode__status--${kind}`);
      if (kind === 'loading') {
        section.setAttribute('aria-busy', 'true');
        section.append(element(document, 'div', 'plan-mode__loading-mark', '•••'));
      } else {
        section.append(element(document, 'div', 'plan-mode__status-mark', kind === 'error' ? '!' : '＋'));
      }
      section.append(element(document, 'h2', '', title), element(document, 'p', '', description));
      if (actionLabel) section.append(button(document, actionLabel, 'plan-mode__primary', requestPlan));
      if (kind === 'error') section.setAttribute('role', 'alert');
      return section;
    }

    function focusBookmark(index) {
      const tabs = [...host.querySelectorAll('.plan-mode__bookmark')];
      const target = tabs[Math.max(0, Math.min(index, tabs.length - 1))];
      if (target && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => target.focus());
      else target?.focus();
    }

    function bookmarkRail(view) {
      const rail = element(document, 'nav', 'plan-mode__bookmarks');
      rail.setAttribute('aria-label', '计划里程碑');
      rail.setAttribute('role', 'tablist');
      view.milestones.forEach((milestone, index) => {
        const tab = button(document, '', 'plan-mode__bookmark', () => {
          dispatch({ type: 'select-milestone', milestoneId: milestone.id });
        });
        tab.id = `plan-bookmark-${milestone.id}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(milestone.active));
        tab.setAttribute('aria-controls', 'plan-milestone-page');
        tab.tabIndex = milestone.active ? 0 : -1;
        tab.title = `${milestone.index}. ${milestone.title}`;
        tab.append(
          element(document, 'span', 'plan-mode__bookmark-number', String(milestone.index).padStart(2, '0')),
          element(document, 'span', 'plan-mode__bookmark-title', milestone.title),
        );
        tab.addEventListener('keydown', event => {
          let next = index;
          if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % view.milestones.length;
          else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + view.milestones.length) % view.milestones.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = view.milestones.length - 1;
          else return;
          event.preventDefault();
          dispatch({ type: 'select-milestone', milestoneId: view.milestones[next].id });
          focusBookmark(next);
        });
        rail.append(tab);
      });
      return rail;
    }

    function criterionList(items, className) {
      const list = element(document, 'ul', className);
      for (const item of items) list.append(element(document, 'li', '', item));
      return list;
    }

    async function handoff(task) {
      if (state.transfer?.status === 'loading') return;
      const payload = State.handoffPayload(state, task.id);
      if (!payload) return;
      dispatch({ type: 'transfer-start', taskId: task.id });
      try {
        const result = await options.onHandoff?.(payload);
        if (!options.onHandoff) throw new Error('尚未连接任务执行器');
        if (result?.ok === false) throw new Error(result.message || '任务转交失败');
        dispatch({ type: 'transfer-success', taskId: task.id, message: result?.message });
      } catch (error) {
        dispatch({ type: 'transfer-error', taskId: task.id, message: error?.message });
      }
    }

    function taskCard(task) {
      const card = element(document, 'article', 'plan-mode__task');
      if (task.expanded) card.classList.add('is-expanded');
      card.dataset.taskId = task.id;
      const header = button(document, '', 'plan-mode__task-toggle', () => dispatch({ type: 'toggle-task', taskId: task.id }));
      header.setAttribute('aria-expanded', String(task.expanded));
      header.setAttribute('aria-controls', `plan-task-${task.id}`);
      const ordinal = element(document, 'span', 'plan-mode__task-number', String(task.index).padStart(2, '0'));
      const copy = element(document, 'span', 'plan-mode__task-copy');
      copy.append(element(document, 'strong', '', task.title), element(document, 'small', '', SCOPE_LABELS[task.scope] || task.scope));
      header.append(ordinal, copy, element(document, 'span', 'plan-mode__task-caret', '⌄'));
      card.append(header);

      const detail = element(document, 'div', 'plan-mode__task-detail');
      detail.id = `plan-task-${task.id}`;
      detail.hidden = !task.expanded;
      detail.append(element(document, 'p', 'plan-mode__task-description', task.description));
      if (task.targets.length) {
        const paths = element(document, 'div', 'plan-mode__paths');
        paths.append(element(document, 'span', '', '目标'));
        for (const target of task.targets) {
          const code = element(document, 'code', '', `${target.path} · rev ${target.revision}`);
          code.title = target.revision;
          paths.append(code);
        }
        detail.append(paths);
      } else {
        detail.append(element(document, 'p', 'plan-mode__dependencies', '未绑定目标文件；请重新生成计划后再交接。'));
      }
      if (task.dependsOn.length) detail.append(element(document, 'p', 'plan-mode__dependencies', `依赖：${task.dependsOn.join('、')}`));
      if (task.acceptanceCriteria.length) {
        detail.append(element(document, 'h4', '', '完成标准'), criterionList(task.acceptanceCriteria, 'plan-mode__criteria plan-mode__criteria--task'));
      }
      const transferButton = button(document, task.transferring ? '正在转交…' : '交给 AI', 'plan-mode__handoff', () => handoff(task));
      transferButton.disabled = task.transferring || !task.targets.length;
      transferButton.setAttribute('aria-label', `将任务“${task.title}”交给 AI`);
      const safety = element(document, 'span', 'plan-mode__handoff-note', '只转交任务，不直接写入正文');
      const footer = element(document, 'div', 'plan-mode__task-footer');
      footer.append(safety, transferButton);
      detail.append(footer);
      card.append(detail);
      return card;
    }

    function contextAudit(view) {
      const audit = element(document, 'details', 'plan-mode__audit');
      const summary = element(document, 'summary', '');
      summary.append(
        element(document, 'span', '', 'Context 校勘记录'),
        element(document, 'span', 'plan-mode__audit-count', `${view.manifest.files.length} 个文件 · ${State.formatBytes(view.manifest.totalBytes)}`),
      );
      audit.append(summary);
      const authority = element(document, 'p', 'plan-mode__authority', 'Main 权威清单 · 每个 revision 都可追溯');
      audit.append(authority);
      const files = element(document, 'div', 'plan-mode__audit-files');
      for (const file of view.manifest.files) {
        const row = element(document, 'button', 'plan-mode__audit-file');
        row.type = 'button';
        row.disabled = typeof options.onOpenPath !== 'function';
        row.addEventListener('click', () => options.onOpenPath?.(file.path, file.revision));
        const name = element(document, 'span', '', file.path);
        const meta = element(document, 'span', '', `${file.role === 'project_prompt' ? '项目 Prompt' : '显式上下文'} · ${State.formatBytes(file.bytes)}`);
        const revision = element(document, 'code', '', file.revision ? `rev ${file.revision}` : 'revision 未记录');
        row.append(name, meta, revision);
        files.append(row);
      }
      audit.append(files);
      const prompt = view.manifest.editPrompt;
      const promptState = element(document, 'p', `plan-mode__prompt-state is-${prompt.frontMatterStatus}`,
        `edit.md Front Matter：${prompt.frontMatterStatus}${prompt.diagnosticCodes.length ? ` · ${prompt.diagnosticCodes.join('、')}` : ''}`);
      audit.append(promptState);
      if (view.manifest.omitted.length) {
        audit.append(element(document, 'p', 'plan-mode__omitted', `未纳入：${view.manifest.omitted.join('、')}`));
      } else {
        audit.append(element(document, 'p', 'plan-mode__omitted', '没有静默省略的上下文。'));
      }
      return audit;
    }

    function readyView(view) {
      const shell = element(document, 'section', 'plan-mode__shell');
      shell.append(bookmarkRail(view));
      const page = element(document, 'div', 'plan-mode__page');
      const header = element(document, 'header', 'plan-mode__header');
      const heading = element(document, 'div', 'plan-mode__heading');
      heading.append(
        element(document, 'span', 'plan-mode__eyebrow', `PLAN MODE · ${view.plan.planId}`),
        element(document, 'h2', '', view.plan.title),
        element(document, 'p', '', view.plan.summary),
      );
      const count = element(document, 'div', 'plan-mode__count');
      count.append(element(document, 'strong', '', String(view.taskTotal).padStart(2, '0')), element(document, 'span', '', '任务卡'));
      header.append(heading, count);
      page.append(header);

      if (view.plan.assumptions.length || view.plan.openQuestions.length) {
        const notes = element(document, 'div', 'plan-mode__notes');
        if (view.plan.assumptions.length) notes.append(element(document, 'p', '', `假设 · ${view.plan.assumptions.join('；')}`));
        if (view.plan.openQuestions.length) notes.append(element(document, 'p', '', `待确认 · ${view.plan.openQuestions.join('；')}`));
        page.append(notes);
      }

      const milestone = element(document, 'section', 'plan-mode__milestone');
      milestone.id = 'plan-milestone-page';
      milestone.setAttribute('role', 'tabpanel');
      milestone.setAttribute('aria-labelledby', `plan-bookmark-${view.active.id}`);
      const title = element(document, 'div', 'plan-mode__milestone-title');
      title.append(
        element(document, 'span', '', `第 ${view.active.index} 枚书签`),
        element(document, 'h3', '', view.active.title),
        element(document, 'p', '', view.active.objective),
      );
      milestone.append(title);
      if (view.active.acceptanceCriteria.length) {
        const contract = element(document, 'div', 'plan-mode__contract');
        contract.append(element(document, 'strong', '', '本页完成条件'), criterionList(view.active.acceptanceCriteria, 'plan-mode__criteria'));
        milestone.append(contract);
      }
      const tasks = element(document, 'div', 'plan-mode__tasks');
      for (const task of view.active.tasks) tasks.append(taskCard(task));
      milestone.append(tasks);
      page.append(milestone, contextAudit(view));

      const live = element(document, 'p', 'plan-mode__live');
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      live.textContent = view.transfer?.message || '';
      page.append(live);
      shell.append(page);
      return shell;
    }

    function render() {
      const view = State.toViewModel(state);
      host.replaceChildren();
      if (view.status === 'loading') {
        host.append(statusView('loading', '正在整理项目计划', 'AI 正在依据 edit.md 和显式上下文拆分里程碑。'));
      } else if (view.status === 'error') {
        host.append(statusView('error', '计划没有生成', view.error, '重新生成'));
      } else if (view.status === 'empty') {
        host.append(statusView('empty', '先把写作意图装订成计划', '从 edit.md 的主旨、目标和结构出发，生成可审阅的任务卡。', '生成项目计划'));
      } else {
        host.append(readyView(view));
      }
    }

    render();
    return Object.freeze({
      request: requestPlan,
      update(result) { state = State.createState(result); render(); },
      setLoading() { dispatch({ type: 'load-start' }); },
      setError(message) { dispatch({ type: 'load-error', message }); },
      getState() { return state; },
      destroy() { host.replaceChildren(); host.classList.remove('plan-mode'); },
    });
  }

  return { SCOPE_LABELS, mount };
});
