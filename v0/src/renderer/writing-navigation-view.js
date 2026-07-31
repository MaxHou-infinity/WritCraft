(function (root, factory) {
  const api = factory(root?.WritCraftWritingNavigationState);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftWritingNavigationView = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (DefaultState) {
  'use strict';

  const ACTION_LABELS = Object.freeze({
    open: '打开章节',
    research: '补充来源',
    changes: '生成修改建议',
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

  function input(document, value, className, action) {
    const node = element(document, 'input', className);
    node.type = 'text';
    node.value = value;
    node.addEventListener('input', action);
    return node;
  }

  function defaultAttemptId() {
    const bytes = new Uint8Array(16);
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!cryptoApi?.getRandomValues) {
      throw new Error('无法建立安全的导航执行轮次');
    }
    cryptoApi.getRandomValues(bytes);
    return `wno_${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  function mount(host, options = {}) {
    if (!host?.ownerDocument) throw new TypeError('写作导航需要 DOM 容器');
    const State = options.stateApi || DefaultState;
    if (!State) throw new Error('缺少 WritCraftWritingNavigationState');
    const document = host.ownerDocument;
    const createAttemptId = options.createAttemptId || defaultAttemptId;
    let state = State.createState();
    let destroyed = false;

    host.classList.add('writing-navigation');
    host.setAttribute('aria-label', '写作导航');

    function dispatch(action) {
      if (destroyed) return state;
      const next = State.reduce(state, action);
      if (next !== state) {
        state = next;
        render();
        options.onStateChange?.(state);
      }
      return state;
    }

    function dispatchEditable(action) {
      if (destroyed) return state;
      const next = State.reduce(state, action);
      if (next === state) return state;
      state = next;
      const generate = host.querySelector('[data-navigation-action="generate"]');
      if (generate) generate.disabled = !State.requestPayload(state);
      const preview = host.querySelector('[data-navigation-action="preview"]');
      if (preview) {
        preview.disabled = state.selectedAlternativeId === null ||
          State.selectedChapters(state).some(chapter => !State.validateChapter(chapter));
      }
      host.querySelectorAll('.writing-navigation__status.is-error')
        .forEach(error => { error.hidden = true; });
      options.onStateChange?.(state);
      return state;
    }

    function failure(raw) {
      return State.publicFailure(raw || {});
    }

    async function request() {
      if (destroyed || state.generation || state.phase === 'recovery' ||
          state.phase === 'recovery-querying') return false;
      const requestValue = State.requestPayload(state);
      if (!requestValue || typeof options.onGenerate !== 'function') {
        dispatch({
          type: 'generation-start',
          attemptId: createAttemptId(),
        });
        if (state.generation) {
          dispatch({
            type: 'generation-error',
            attemptId: state.generation.attemptId,
            error: { error: 'INVALID_REQUEST' },
          });
        }
        return false;
      }
      const attemptId = createAttemptId();
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      dispatch({ type: 'generation-start', attemptId });
      if (state.generation?.attemptId !== attemptId) return false;
      try {
        const result = await options.onGenerate(requestValue, attemptId, projectId);
        if (result?.ok === true) {
          dispatch({ type: 'generation-success', attemptId, result: result.result });
          return state.projectInstanceId === projectId &&
            state.projectEpoch === epoch && state.result?.navigationId === result.result?.navigationId;
        }
        dispatch({ type: 'generation-error', attemptId, error: result });
        return false;
      } catch (error) {
        dispatch({
          type: 'generation-error',
          attemptId,
          error: { error: error?.code || 'NAVIGATION_FAILED' },
        });
        return false;
      } finally {
        dispatch({ type: 'generation-finally', attemptId });
      }
    }

    async function cancelGeneration() {
      const active = state.generation;
      if (!active || active.status !== 'generating' ||
          typeof options.onCancelGeneration !== 'function') return false;
      dispatch({ type: 'generation-cancel-start', attemptId: active.attemptId });
      try {
        const result = await options.onCancelGeneration(
          active.projectInstanceId,
          active.attemptId
        );
        if (result?.ok !== true || result.cancelled !== true) {
          dispatch({
            type: 'generation-error',
            attemptId: active.attemptId,
            error: result || { error: 'CANCEL_FAILED' },
          });
          return false;
        }
        dispatch({ type: 'generation-cancelled', attemptId: active.attemptId });
        return true;
      } catch (error) {
        dispatch({
          type: 'generation-error',
          attemptId: active.attemptId,
          error: { error: error?.code || 'CANCEL_FAILED' },
        });
        return false;
      }
    }

    async function prepareStructure() {
      if (state.phase !== 'structure-ready' ||
          typeof options.onPrepareStructure !== 'function') return false;
      const chapters = State.selectedChapters(state);
      if (!chapters.length || chapters.some(chapter => !State.validateChapter(chapter))) {
        dispatch({ type: 'prepare-error', error: { error: 'INVALID_STRUCTURE_CONFIRMATION' } });
        return false;
      }
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      const navigationId = state.result.navigationId;
      const alternativeId = state.selectedAlternativeId;
      dispatch({ type: 'prepare-start' });
      try {
        const result = await options.onPrepareStructure(
          projectId,
          navigationId,
          alternativeId,
          chapters
        );
        if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        if (result?.ok !== true) {
          dispatch({ type: 'prepare-error', error: result });
          return false;
        }
        dispatch({
          type: 'prepare-success',
          capabilityId: result.capabilityId,
          preview: result.preview,
        });
        return state.phase === 'structure-preview';
      } catch (error) {
        if (state.projectInstanceId === projectId && state.projectEpoch === epoch) {
          dispatch({ type: 'prepare-error', error: { error: error?.code || 'PREPARE_FAILED' } });
        }
        return false;
      }
    }

    async function confirmStructure() {
      if (state.phase !== 'structure-preview' || !state.capabilityId ||
          typeof options.onConfirmStructure !== 'function') return false;
      const capabilityId = state.capabilityId;
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      dispatch({ type: 'confirm-start' });
      try {
        const result = await options.onConfirmStructure(capabilityId);
        if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        dispatch({ type: 'confirm-result', result });
        if (result?.state === 'COMMITTED') {
          void options.onStructureCommitted?.(projectId);
        }
        return result?.state === 'COMMITTED';
      } catch (error) {
        if (state.projectInstanceId === projectId && state.projectEpoch === epoch) {
          dispatch({
            type: 'confirm-result',
            result: {
              ok: false,
              state: 'UNKNOWN',
              error: error?.code || 'WRITING_STRUCTURE_COMMIT_UNKNOWN',
              recoveryRequired: true,
            },
          });
        }
        return false;
      }
    }

    async function recover() {
      if (!state.projectInstanceId || typeof options.onQueryRecovery !== 'function') return false;
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      dispatch({ type: 'recovery-start' });
      try {
        const result = await options.onQueryRecovery(projectId);
        if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        if (result?.ok !== true) {
          dispatch({ type: 'recovery-error', error: result });
          return false;
        }
        dispatch({ type: 'recovery-result', result });
        if (result?.state === 'COMMITTED' && result.recoveryRequired !== true) {
          void options.onStructureCommitted?.(projectId);
        }
        return true;
      } catch (error) {
        if (state.projectInstanceId === projectId && state.projectEpoch === epoch) {
          dispatch({ type: 'recovery-error', error: { error: error?.code || 'RECOVERY_FAILED' } });
        }
        return false;
      }
    }

    async function acknowledgeRecovery() {
      const recovery = state.recovery;
      if (state.phase !== 'recovery' || recovery?.state !== 'COMMITTED' ||
          !recovery.operationId || typeof options.onAcknowledgeRecovery !== 'function') {
        return false;
      }
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      try {
        const result = await options.onAcknowledgeRecovery(projectId, recovery.operationId);
        if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        if (result?.ok !== true || result.acknowledged !== true) {
          dispatch({ type: 'recovery-error', error: result });
          return false;
        }
        dispatch({ type: 'recovery-acknowledged', operationId: recovery.operationId });
        void options.onStructureCommitted?.(projectId);
        return true;
      } catch (error) {
        if (state.projectInstanceId === projectId && state.projectEpoch === epoch) {
          dispatch({ type: 'recovery-error', error: { error: error?.code || 'RECOVERY_FAILED' } });
        }
        return false;
      }
    }

    async function runAction(suggestion) {
      if (state.phase !== 'navigation-ready' || !suggestion?.actionId ||
          typeof options.onRunAction !== 'function') return false;
      const attemptId = createAttemptId();
      const projectId = state.projectInstanceId;
      const epoch = state.projectEpoch;
      dispatch({ type: 'action-start', actionId: suggestion.actionId, attemptId });
      if (state.actions[suggestion.actionId]?.attemptId !== attemptId) return false;
      try {
        const result = await options.onRunAction(projectId, suggestion.actionId, attemptId);
        if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        if (result?.ok === true && result.kind === 'open' && result.handoff?.locator) {
          await options.onOpenEvidence?.(result.handoff.locator, result.handoff.path);
          if (state.projectInstanceId !== projectId || state.projectEpoch !== epoch) return false;
        }
        dispatch({
          type: 'action-result',
          actionId: suggestion.actionId,
          attemptId,
          result,
        });
        return result?.ok === true;
      } catch (error) {
        if (state.projectInstanceId === projectId && state.projectEpoch === epoch) {
          dispatch({
            type: 'action-result',
            actionId: suggestion.actionId,
            attemptId,
            result: { ok: false, error: error?.code || 'ACTION_FAILED' },
          });
        }
        return false;
      } finally {
        dispatch({ type: 'action-finally', actionId: suggestion.actionId, attemptId });
      }
    }

    async function cancelAction(suggestion) {
      const active = state.actions[suggestion?.actionId];
      if (!active || active.status !== 'running' ||
          typeof options.onCancelAction !== 'function') return false;
      dispatch({
        type: 'action-cancel-start',
        actionId: suggestion.actionId,
        attemptId: active.attemptId,
      });
      try {
        const result = await options.onCancelAction(
          state.projectInstanceId,
          suggestion.actionId,
          active.attemptId
        );
        if (result?.ok !== true || result.cancelled !== true) {
          dispatch({
            type: 'action-result',
            actionId: suggestion.actionId,
            attemptId: active.attemptId,
            result,
          });
          return false;
        }
        dispatch({
          type: 'action-cancelled',
          actionId: suggestion.actionId,
          attemptId: active.attemptId,
        });
        return true;
      } catch (error) {
        dispatch({
          type: 'action-result',
          actionId: suggestion.actionId,
          attemptId: active.attemptId,
          result: { ok: false, error: error?.code || 'CANCEL_FAILED' },
        });
        return false;
      }
    }

    function status(title, description, kind = 'status') {
      const section = element(document, 'section', `writing-navigation__status is-${kind}`);
      if (kind === 'error') section.setAttribute('role', 'alert');
      else {
        section.setAttribute('role', 'status');
        section.setAttribute('aria-live', 'polite');
      }
      section.append(
        element(document, 'h2', '', title),
        element(document, 'p', '', description)
      );
      return section;
    }

    function compose(view) {
      const section = element(document, 'section', 'writing-navigation__compose');
      const heading = view.mode === 'structure' ? '这篇作品想怎样展开？' : '这次最想推进什么？';
      const label = element(document, 'label', '', heading);
      const goal = element(document, 'textarea', 'writing-navigation__goal');
      goal.value = view.goal;
      goal.dataset.navigationFocus = 'goal';
      goal.disabled = Boolean(view.generation) || view.phase === 'recovery';
      goal.setAttribute('maxlength', '2000');
      goal.setAttribute('placeholder', view.mode === 'structure'
        ? '例如：比较几种适合这篇作品的组织方式'
        : '例如：找出当前最值得继续推进的一步');
      goal.addEventListener('input', event => {
        dispatchEditable({ type: 'goal-change', value: event.target.value });
      });
      label.append(goal);
      section.append(label);

      if (view.mode === 'navigation') {
        const paths = State.markdownPaths(view.tree);
        const context = element(document, 'details', 'writing-navigation__context-picker');
        const summary = element(document, 'summary', '',
          `补充上下文 · ${view.contextPaths.length}/${view.currentFilePath ? 7 : 8}`
        );
        context.append(summary);
        const list = element(document, 'div', 'writing-navigation__context-options');
        for (const path of paths) {
          if (path === view.currentFilePath) continue;
          const row = element(document, 'label', 'writing-navigation__context-option');
          const control = element(document, 'input');
          control.type = 'checkbox';
          control.checked = view.contextPaths.includes(path);
          control.disabled = Boolean(view.generation);
          control.addEventListener('change', () => {
            const selected = new Set(state.contextPaths);
            if (control.checked) selected.add(path); else selected.delete(path);
            dispatch({ type: 'context-change', paths: [...selected] });
          });
          row.append(control, element(document, 'span', '', path));
          list.append(row);
        }
        context.append(list);
        section.append(context);
      }

      const row = element(document, 'div', 'writing-navigation__compose-actions');
      if (view.generation) {
        const cancel = button(document, view.generation.status === 'cancelling'
          ? '正在停止…' : '停止整理', 'writing-navigation__secondary', cancelGeneration);
        cancel.disabled = view.generation.status === 'cancelling' ||
          typeof options.onCancelGeneration !== 'function';
        row.append(cancel);
      } else {
        const generate = button(document,
          view.mode === 'structure' ? '生成结构方案' : '生成写作导航',
          'writing-navigation__primary',
          request
        );
        generate.dataset.navigationAction = 'generate';
        generate.disabled = !State.requestPayload(state) ||
          ['recovery', 'recovery-querying', 'structure-confirming'].includes(view.phase);
        row.append(generate);
      }
      section.append(row);
      return section;
    }

    function contextDisclosure(view) {
      const section = element(document, 'section', 'writing-navigation__context');
      section.append(
        element(document, 'strong', '', 'Context'),
        element(document, 'span', '', view.context.coverage)
      );
      if (view.context.limitedIntent) {
        section.append(element(document, 'p', 'is-warning',
          'edit.md 项目说明尚不完整，本次只依据已保存内容。'));
      }
      if (view.context.priorityBoundary) {
        section.append(element(document, 'p', 'is-warning', view.context.priorityBoundary));
      }
      const files = element(document, 'ul', 'writing-navigation__context-files');
      for (const file of view.context.files) {
        files.append(element(document, 'li', '',
          file.path === 'edit.md'
            ? `edit.md · 项目意图锚点 · ${file.bytes || 0} B`
            : `${file.path} · ${file.role === 'current_file' ? '当前正文' : '显式上下文'} · ${file.bytes || 0} B`
        ));
      }
      section.append(files);
      if (view.context.omitted) {
        section.append(element(document, 'p', '',
          `另有 ${view.context.omitted} 个正文文件未纳入本次分析。`));
      }
      return section;
    }

    function structureReady(view) {
      const section = element(document, 'section', 'writing-navigation__structure');
      section.append(element(document, 'h2', '', '比较结构方案'));
      const tabs = element(document, 'div', 'writing-navigation__alternatives');
      tabs.setAttribute('role', 'tablist');
      view.result.alternatives.forEach((alternative, index) => {
        const selected = alternative.alternativeId === view.selectedAlternativeId;
        const tab = button(document, `方案 ${index + 1}`, 'writing-navigation__alternative',
          () => dispatch({ type: 'alternative-select', alternativeId: alternative.alternativeId })
        );
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(selected));
        tab.dataset.alternativeId = alternative.alternativeId;
        tabs.append(tab);
      });
      section.append(tabs);
      const alternative = view.selectedAlternative;
      const summary = element(document, 'dl', 'writing-navigation__alternative-summary');
      for (const [label, value] of [
        ['组织逻辑', alternative.organizingLogic],
        ['读者体验', alternative.audienceBenefit],
        ['主要取舍', alternative.tradeoff],
      ]) {
        summary.append(element(document, 'dt', '', label), element(document, 'dd', '', value));
      }
      section.append(summary);
      const chapters = element(document, 'div', 'writing-navigation__chapters');
      view.selectedChapters.forEach((chapter, index) => {
        const card = element(document, 'article', 'writing-navigation__chapter');
        card.append(element(document, 'strong', '', `章节 ${index + 1} · chapters/${String(index + 1).padStart(2, '0')}.md`));
        const titleLabel = element(document, 'label', '', '标题');
        const title = input(document, chapter.title, '', event => dispatchEditable({
          type: 'chapter-edit',
          alternativeId: view.selectedAlternativeId,
          chapterIndex: index,
          field: 'title',
          value: event.target.value,
        }));
        title.dataset.chapterField = 'title';
        title.dataset.navigationFocus =
          `chapter-${view.selectedAlternativeId}-${index}-title`;
        titleLabel.append(title);
        const purposeLabel = element(document, 'label', '', '写作目的');
        const purpose = input(document, chapter.purpose, '', event => dispatchEditable({
          type: 'chapter-edit',
          alternativeId: view.selectedAlternativeId,
          chapterIndex: index,
          field: 'purpose',
          value: event.target.value,
        }));
        purpose.dataset.chapterField = 'purpose';
        purpose.dataset.navigationFocus =
          `chapter-${view.selectedAlternativeId}-${index}-purpose`;
        purposeLabel.append(purpose);
        card.append(titleLabel, purposeLabel);
        chapters.append(card);
      });
      section.append(chapters);
      section.append(element(
        document,
        'p',
        'writing-navigation__next-step',
        '下一步：预览即将创建的文件，确认无误后再创建章节骨架。'
      ));
      const preview = button(document,
        view.phase === 'structure-preparing' ? '正在准备预览…' : '查看创建预览',
        'writing-navigation__primary',
        prepareStructure
      );
      preview.dataset.navigationAction = 'preview';
      preview.disabled = view.phase === 'structure-preparing' ||
        view.selectedChapters.some(chapter => !State.validateChapter(chapter));
      section.append(preview);
      return section;
    }

    function structurePreview(view) {
      const section = element(document, 'section', 'writing-navigation__preview');
      section.append(
        element(document, 'h2', '', '确认章节骨架'),
        element(document, 'p', 'writing-navigation__warning',
          '只创建骨架，不会写章节正文。确认前没有修改任何项目文件。')
      );
      for (const file of view.preview.files) {
        const card = element(document, 'article', 'writing-navigation__preview-file');
        card.append(
          element(document, 'strong', '', file.path),
          element(document, 'p', '', `标题：${file.title}`),
          element(document, 'p', '', `写作目的：${file.purpose}`),
          element(document, 'pre', '', file.content)
        );
        section.append(card);
      }
      const actions = element(document, 'div', 'writing-navigation__preview-actions');
      actions.append(
        button(document, '返回编辑', 'writing-navigation__secondary',
          () => dispatch({ type: 'preview-back' })),
        button(document, '确认创建章节骨架', 'writing-navigation__primary', confirmStructure)
      );
      section.append(actions);
      return section;
    }

    function committed(view) {
      const files = view.recovery?.files || view.preview?.files || [];
      const section = status(
        `已创建 ${files.length} 个章节骨架`,
        '章节标题和写作目的已保存；没有生成章节正文。',
        'success'
      );
      if (view.mode === 'navigation') {
        section.append(button(
          document,
          '进入写作导航',
          'writing-navigation__primary',
          () => dispatch({ type: 'continue-after-structure' })
        ));
      }
      return section;
    }

    function recovery(view) {
      const section = status(
        view.recovery?.state === 'COMMITTED' ? '章节骨架已经创建' : '提交状态正在核对',
        view.recovery?.state === 'COMMITTED'
          ? '文件已提交，正在完成恢复记录；请勿重复创建。'
          : '目前不能确认文件是否已经提交。请勿重复确认。',
        'warning'
      );
      if (view.recovery?.state === 'COMMITTED') {
        section.append(button(document, '完成恢复', 'writing-navigation__primary', acknowledgeRecovery));
      } else {
        section.append(button(document, '重新核对提交状态', 'writing-navigation__primary', recover));
      }
      return section;
    }

    function actionCopy(suggestion, action) {
      if (action?.status === 'running') return '处理中…';
      if (action?.status === 'cancelling') return '正在停止…';
      if (action?.status === 'success') {
        if (suggestion.action === 'open') return '再次打开';
        if (suggestion.action === 'research') return '已进入 Research';
        if (action.result?.noChanges) return '正文无需修改';
        return '已生成待审修改';
      }
      if (action?.status === 'stale') return '建议已过期';
      return ACTION_LABELS[suggestion.action];
    }

    function recoveryAction(error) {
      if (!error?.action) return null;
      if (error.action === 'settings' && typeof options.onOpenSettings === 'function') {
        return button(document, '打开 AI 设置', 'writing-navigation__secondary',
          () => options.onOpenSettings?.());
      }
      if (error.action === 'review' && typeof options.onOpenReview === 'function') {
        return button(document, '前往当前审阅', 'writing-navigation__secondary',
          () => options.onOpenReview?.());
      }
      return null;
    }

    function navigationReady(view) {
      const section = element(document, 'section', 'writing-navigation__suggestions');
      section.append(element(document, 'h2', '', '现在最值得推进什么'));
      view.result.suggestions.forEach((suggestion, index) => {
        const action = view.actions[suggestion.actionId];
        const card = element(document, 'article', 'writing-navigation__suggestion');
        card.append(
          element(document, 'span', 'writing-navigation__ordinal', `建议 ${index + 1}`),
          element(document, 'h3', '', suggestion.finding),
          element(document, 'p', '', `为什么现在处理：${suggestion.whyNow}`),
          element(document, 'p', '', `建议动作：${suggestion.recommendedAction}`),
          element(document, 'p', '', `预期改善：${suggestion.expectedResult}`)
        );
        const evidence = element(document, 'div', 'writing-navigation__evidence');
        evidence.append(element(document, 'strong', '', '原文依据'));
        for (const item of suggestion.evidence) {
          const open = button(document,
            `${item.relativePath} · ${item.sectionHeading} · “${item.quote}”`,
            'writing-navigation__evidence-link',
            () => options.onOpenEvidence?.(item.locator, item.relativePath)
          );
          evidence.append(open);
        }
        card.append(evidence);
        if (action?.error) {
          card.append(element(document, 'p', 'writing-navigation__action-error', action.error.message));
          const errorAction = recoveryAction(action.error);
          if (errorAction) card.append(errorAction);
        }
        const actionRow = element(document, 'div', 'writing-navigation__action-row');
        const run = button(document, actionCopy(suggestion, action),
          'writing-navigation__primary', () => runAction(suggestion));
        run.disabled = ['running', 'cancelling', 'stale'].includes(action?.status) ||
          (action?.status === 'success' && suggestion.action !== 'open');
        actionRow.append(run);
        if (suggestion.action === 'changes' && action?.status === 'running') {
          actionRow.append(button(document, '停止生成修改建议',
            'writing-navigation__secondary', () => cancelAction(suggestion)));
        }
        card.append(actionRow);
        section.append(card);
      });
      return section;
    }

    function render() {
      if (destroyed) return;
      const view = State.toViewModel(state);
      host.replaceChildren();
      if (!view.projectInstanceId) {
        host.append(status('打开写作项目后使用导航', '笔触会优先读取 edit.md。'));
        return;
      }
      if (view.phase === 'recovery-querying') {
        host.append(status('正在核对章节骨架', '正在读取本地恢复记录，请稍候。', 'loading'));
        return;
      }
      if (view.phase === 'recovery') {
        host.append(recovery(view));
        if (view.error) host.append(status('恢复尚未完成', view.error.message, 'error'));
        return;
      }
      if (view.phase === 'structure-committed') {
        host.append(committed(view));
        return;
      }
      host.append(compose(view));
      if (view.phase === 'generating' || view.phase === 'cancelling') {
        host.append(status(
          view.phase === 'cancelling' ? '正在停止整理' :
            view.mode === 'structure' ? '正在整理结构方案' : '正在分析本次已读正文',
          view.phase === 'cancelling'
            ? '本次不会修改项目文件。'
            : view.mode === 'structure'
              ? 'AI 正在比较不同的组织方式；此时不会创建章节。'
              : 'AI 正在根据 edit.md 和已选正文寻找下一步。',
          'loading'
        ));
        return;
      }
      if (view.error && view.phase !== 'failure') {
        const failureView = status('本次没有完成', view.error.message, 'error');
        const errorAction = recoveryAction(view.error);
        if (errorAction) failureView.append(errorAction);
        host.append(failureView);
      }
      if (view.phase === 'structure-ready' || view.phase === 'structure-preparing') {
        host.append(contextDisclosure(view), structureReady(view));
      } else if (view.phase === 'structure-preview' || view.phase === 'structure-confirming') {
        host.append(contextDisclosure(view), structurePreview(view));
        if (view.phase === 'structure-confirming') {
          host.querySelectorAll('button').forEach(control => { control.disabled = true; });
          host.append(status('正在创建章节骨架', '正在安全提交，请勿关闭窗口或重复确认。', 'loading'));
        }
      } else if (view.phase === 'navigation-ready') {
        host.append(contextDisclosure(view), navigationReady(view));
      } else if (view.phase === 'failure') {
        const failureView = status(
          view.mode === 'structure' ? '结构方案没有生成' : '写作导航没有生成',
          view.error?.message || failure().message,
          'error'
        );
        const errorAction = recoveryAction(view.error);
        if (errorAction) failureView.append(errorAction);
        host.append(failureView);
      } else {
        host.append(status(
          view.mode === 'structure' ? '先比较几种结构方案' : '从原文依据找到下一步',
          view.mode === 'structure'
            ? 'AI 只提出章节标题和写作目的，不会生成大篇幅正文。'
            : '每条建议都会说明理由、原文依据和一个可执行动作。'
        ));
      }
    }

    render();
    return Object.freeze({
      updateProject(project, tree, currentFilePath = null) {
        dispatch({
          type: 'project-update',
          projectInstanceId: project?.instanceId,
          tree,
          currentFilePath,
        });
        return state;
      },
      updateTree(tree, currentFilePath = state.currentFilePath) {
        dispatch({ type: 'tree-update', tree, currentFilePath });
        return state;
      },
      request,
      recover,
      getState: () => state,
      destroy() {
        destroyed = true;
        state = State.createState();
        host.replaceChildren();
        host.classList.remove('writing-navigation');
      },
    });
  }

  return Object.freeze({
    ACTION_LABELS,
    mount,
  });
});
