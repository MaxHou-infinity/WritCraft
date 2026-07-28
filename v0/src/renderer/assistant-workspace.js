// Integrates the right-side book tabs with authoritative Main services.
(function () {
  'use strict';

  const workArea = document.getElementById('work-area');
  const dockElement = document.getElementById('assistant-dock');
  const planHost = document.getElementById('plan-mode-host');
  const contextHost = document.getElementById('context-inspector-host');
  const planGoal = document.getElementById('plan-goal');
  const planGenerate = document.getElementById('plan-generate');
  const planContextToggle = document.getElementById('plan-context-toggle');
  const planContextList = document.getElementById('plan-context-list');
  const bridge = window.writCraft?.project;
  let selectedPlanContext = [];
  let planController = null;
  let contextController = null;
  let projectEpoch = 0;

  function recordPlanMetric(outcome, startedAt, operationId, originProjectInstanceId) {
    if (!operationId || !originProjectInstanceId) return;
    void window.WritCraftAiMetrics?.record?.(originProjectInstanceId, {
      operationId,
      action: 'plan', outcome, style: 'none', scope: 'project',
      durationMs: Math.max(0, Date.now() - startedAt),
      beforeChars: 0, afterChars: 0,
    });
  }

  function markdownPaths(nodes, output = []) {
    for (const node of nodes || []) {
      if (node?.type === 'directory') markdownPaths(node.children, output);
      else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || '')) && node.path !== 'edit.md') output.push(node.path);
    }
    return output;
  }

  function availablePlanContext() {
    return markdownPaths(window.__workspace?.state?.tree || []);
  }

  function renderPlanContext() {
    if (!planContextList || !planContextToggle) return;
    const available = availablePlanContext();
    selectedPlanContext = selectedPlanContext.filter(path => available.includes(path)).slice(0, 8);
    planContextToggle.textContent = `补充上下文 · ${selectedPlanContext.length}/8`;
    planContextList.replaceChildren();
    if (!available.length) {
      const empty = document.createElement('div');
      empty.className = 'plan-context-empty';
      empty.textContent = '项目里还没有可选的正文 Markdown。';
      planContextList.append(empty);
      return;
    }
    for (const filePath of available) {
      const label = document.createElement('label');
      label.className = 'plan-context-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selectedPlanContext.includes(filePath);
      input.disabled = selectedPlanContext.length >= 8 && !input.checked;
      input.addEventListener('change', () => {
        if (input.checked && selectedPlanContext.length < 8) selectedPlanContext.push(filePath);
        if (!input.checked) selectedPlanContext = selectedPlanContext.filter(path => path !== filePath);
        renderPlanContext();
      });
      const text = document.createElement('span');
      text.textContent = filePath;
      label.append(input, text);
      planContextList.append(label);
    }
  }

  async function requestPlan() {
    const requestEpoch = projectEpoch;
    const startedAt = Date.now();
    const operationId = window.WritCraftAiMetrics?.createOperationId?.();
    const originProjectInstanceId = window.__workspace?.state?.project?.instanceId || null;
    const goal = planGoal?.value.trim() || '';
    if (!goal) return { ok: false, message: '先写下这次想完成的目标' };
    if (!bridge?.proposePlan) return { ok: false, message: 'Plan Mode 尚未连接 Main' };
    if (!window.__workspace?.canUseAI?.()) return { ok: false, message: '请先恢复 edit.md 或处理文件冲突' };
    const saved = await window.__workspace.persistCurrent(true);
    if (!saved) return { ok: false, message: '当前文件未能安全保存，计划生成已停止' };
    try {
      const result = await bridge.proposePlan(originProjectInstanceId, goal, selectedPlanContext);
      const currentResult = requestEpoch === projectEpoch ? result : { canceled: true };
      if (!currentResult.canceled) recordPlanMetric(result?.ok ? 'generated' : 'failed', startedAt, operationId, originProjectInstanceId);
      return currentResult;
    } catch (error) {
      if (requestEpoch === projectEpoch) recordPlanMetric('failed', startedAt, operationId, originProjectInstanceId);
      return { ok: false, message: error.message || '项目计划生成中断' };
    }
  }

  async function handoffPlanTask(payload) {
    if (!payload || payload.schema !== 'writcraft.plan-task-handoff/v1') {
      return { ok: false, message: '任务卡交接数据无效' };
    }
    if (!window.__changesView?.openPlanTask) return { ok: false, message: 'Changes 执行器尚未连接' };
    return window.__changesView.openPlanTask(payload);
  }

  async function openLocator(locator) {
    if (!locator?.filePath) return false;
    return window.__workspace?.revealContextChip?.({
      revision: locator.revision || null,
      locator,
    }) || false;
  }

  if (window.WritCraftPlanModeView && planHost) {
    planController = window.WritCraftPlanModeView.mount(planHost, {
      stateApi: window.WritCraftPlanModeState,
      onRequestPlan: requestPlan,
      onHandoff: handoffPlanTask,
      onOpenPath: path => window.__workspace?.openFile?.(path),
    });
  }

  if (window.WritCraftContextInspector && contextHost) {
    contextController = window.WritCraftContextInspector.mount(contextHost, {
      manifest: { scope: 'file', budgetChars: 10000, usedChars: 0, usedBytes: 0, chips: [] },
      errors: [],
      onOpenLocator: openLocator,
    });
  }

  const dockController = window.WritCraftAssistantDock?.mount({
    workArea,
    dock: dockElement,
    beforeOpen(mode) {
      if (!window.__workspace?.state?.project) {
        const status = document.getElementById('save-state');
        if (status) status.textContent = '请先创建或打开写作项目';
        return false;
      }
      window.__graphView?.close?.();
      workArea.classList.remove('has-ai', 'has-changes');
      return true;
    },
    onOpen(mode) {
      document.getElementById('activity-ai')?.setAttribute('aria-pressed', String(mode === 'chat'));
      document.getElementById('activity-changes')?.setAttribute('aria-pressed', String(mode === 'changes'));
      if (mode === 'plan') renderPlanContext();
    },
    onClose() {
      document.getElementById('activity-ai')?.setAttribute('aria-pressed', 'false');
      document.getElementById('activity-changes')?.setAttribute('aria-pressed', 'false');
    },
  });

  planGenerate?.addEventListener('click', () => planController?.request?.());
  planContextToggle?.addEventListener('click', () => {
    const open = planContextList.hidden;
    planContextList.hidden = !open;
    planContextToggle.setAttribute('aria-expanded', String(open));
    if (open) renderPlanContext();
  });

  document.addEventListener('writcraft:project-entered', () => {
    projectEpoch += 1;
    selectedPlanContext = [];
    if (planGoal) planGoal.value = '';
    planController?.update?.({ status: 'empty' });
    contextController?.update?.({ scope: 'file', budgetChars: 10000, usedChars: 0, usedBytes: 0, chips: [] }, []);
    renderPlanContext();
  });
  document.addEventListener('writcraft:tree-changed', renderPlanContext);

  window.__assistantDock = dockController;
  window.__planModeView = planController;
  window.__contextInspectorView = Object.freeze({
    open: () => dockController?.open('context'),
    update(manifest, errors) {
      contextController?.update?.(manifest, errors || manifest?.errors || []);
    },
    getState: () => contextController?.getState?.() || null,
    getRequestPolicy: () => contextController?.getRequestPolicy?.() || { excludedChipIds: [] },
  });
})();
