// WritCraft V0 · Cross-file ChangeSet review panel

(function () {
  const bridge = window.writCraft && window.writCraft.project;
  const workArea = document.getElementById('work-area');
  const panel = document.getElementById('changes-panel');
  const panelTitle = document.getElementById('changes-panel-title');
  const instruction = document.getElementById('changes-instruction');
  const preview = document.getElementById('changes-preview');
  const commitNotice = document.getElementById('changes-commit-notice');
  const status = document.getElementById('changes-status');
  const proposeButton = document.getElementById('changes-propose');
  const chapterButton = document.getElementById('changes-chapter');
  const applyButton = document.getElementById('changes-apply');
  const discardButton = document.getElementById('changes-discard');
  const activityButton = document.getElementById('activity-changes');
  const historyList = document.getElementById('changes-history-list');
  const recoveryHost = document.getElementById('changes-recovery');
  const recoveryTitle = document.getElementById('changes-recovery-title');
  const recoveryMessage = document.getElementById('changes-recovery-message');
  const recoveryPaths = document.getElementById('changes-recovery-paths');
  const recoveryActions = document.getElementById('changes-recovery-actions');
  const metricsHost = document.getElementById('ai-metrics-view');
  const contextPicker = document.getElementById('composer-context-picker');
  const contextCount = document.getElementById('composer-context-count');
  const contextList = document.getElementById('composer-context-list');
  const targetPicker = document.getElementById('project-changes-target-picker');
  const targetCount = document.getElementById('project-changes-target-count');
  const targetList = document.getElementById('project-changes-target-list');
  let pending = null;
  let confirmationMode = null;
  let selectedContextPaths = [];
  let availableContextPaths = [];
  let selectedTargetPaths = [];
  let availableTargetPaths = [];
  let targetSelectionTouched = false;
  let normalScopePlan = null;
  let metricsRequestSequence = 0;
  let activePlanRequest = null;
  let activeIssueRequest = null;
  let activeResearchRequest = null;
  let researchOpenSequence = 0;
  let planModeBanner = null;
  let planModeLeaveButton = null;
  let issueModeBanner = null;
  let issueModeLeaveButton = null;
  let researchModeBanner = null;
  let researchModeLeaveButton = null;
  let reviewCommitInFlight = false;
  let historyUndoInFlight = false;
  let recoveryBlocked = false;
  let recoveryActionInFlight = false;
  let generationProgressTimer = null;
  const expandedReviewHunks = new Set();
  let onboardingMetricSettlement = null;
  let unsettledOnboardingMetric = null;
  let unsettledOnboardingConfirmationRelease = null;
  const proposalTransactions = window.WritCraftChangesProposalTransaction?.create?.();

  function ensurePlanModeBanner() {
    if (planModeBanner) return planModeBanner;
    planModeBanner = document.createElement('section');
    planModeBanner.className = 'changes-plan-mode';
    planModeBanner.hidden = true;
    const copy = document.createElement('div');
    copy.className = 'changes-plan-mode__copy';
    const title = document.createElement('strong');
    title.textContent = 'Plan 任务专用模式';
    const detail = document.createElement('span');
    detail.dataset.planProvenance = 'true';
    copy.append(title, detail);
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = '脱离 Plan';
    planModeLeaveButton = leave;
    leave.addEventListener('click', () => { void leavePlanMode(); });
    planModeBanner.append(copy, leave);
    instruction.parentElement.insertBefore(planModeBanner, instruction);
    return planModeBanner;
  }

  function renderPlanMode(provenance = null) {
    const banner = ensurePlanModeBanner();
    banner.hidden = !activePlanRequest;
    instruction.readOnly = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) instruction.readOnly = true;
    instruction.hidden = Boolean(activeResearchRequest);
    contextPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) contextPicker.hidden = true;
    targetPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    chapterButton.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) chapterButton.hidden = true;
    if (!activePlanRequest) return;
    instruction.value = `Plan ${activePlanRequest.planId} / Task ${activePlanRequest.taskId}`;
    const targets = provenance?.targets || pending?.provenance?.targets || [];
    const detail = banner.querySelector('[data-plan-provenance]');
    if (detail) detail.textContent = targets.length
      ? `${activePlanRequest.planId} · ${activePlanRequest.taskId} · ${targets.map(target => `${target.path} @ ${target.revision}`).join('、')}`
      : `${activePlanRequest.planId} · ${activePlanRequest.taskId} · 等待 Main 核验目标`;
  }

  function ensureIssueModeBanner() {
    if (issueModeBanner) return issueModeBanner;
    issueModeBanner = document.createElement('section');
    issueModeBanner.className = 'changes-plan-mode changes-issue-mode';
    issueModeBanner.hidden = true;
    const copy = document.createElement('div');
    copy.className = 'changes-plan-mode__copy';
    const title = document.createElement('strong');
    title.textContent = '星图问题专用审阅';
    const detail = document.createElement('span');
    detail.dataset.issueProvenance = 'true';
    copy.append(title, detail);
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = '退出星图审阅';
    issueModeLeaveButton = leave;
    leave.addEventListener('click', () => { void leaveIssueMode(); });
    issueModeBanner.append(copy, leave);
    instruction.parentElement.insertBefore(issueModeBanner, instruction);
    return issueModeBanner;
  }

  function renderIssueMode(provenance = null) {
    const banner = ensureIssueModeBanner();
    banner.hidden = !activeIssueRequest;
    instruction.readOnly = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) instruction.readOnly = true;
    instruction.hidden = Boolean(activeResearchRequest);
    contextPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) contextPicker.hidden = true;
    targetPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    chapterButton.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) chapterButton.hidden = true;
    if (!activeIssueRequest) return;
    instruction.value = `Graph Issue ${activeIssueRequest.issueId}`;
    const targets = provenance?.targets || pending?.provenance?.targets || [];
    const detail = banner.querySelector('[data-issue-provenance]');
    if (detail) detail.textContent = targets.length
      ? `${activeIssueRequest.issueId} · Main 目标 ${targets.map(target => `${target.path} @ ${target.revision}`).join('、')}`
      : `${activeIssueRequest.issueId} · 等待 Main 重新核验证据与目标`;
  }

  async function leaveIssueMode() {
    if (reviewCommitInFlight || !activeIssueRequest) return;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
    const discardId = pending?.id || null;
    proposalTransactions?.invalidate();
    stopGenerationProgress();
    pending = null;
    activeIssueRequest = null;
    instruction.value = '';
    renderIssueMode();
    setBusy(false);
    preview.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'tree-empty', textContent: '已退出星图问题审阅；旧结果将被安全丢弃。',
    }));
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    setStatus('已返回普通 Changes 模式');
    instruction.focus();
    if (discardId && bridge?.discardChanges) await bridge.discardChanges(projectInstanceId, discardId);
  }

  function completeIssueModeAfterReview() {
    if (!activeIssueRequest) return false;
    proposalTransactions?.invalidate();
    activeIssueRequest = null;
    instruction.value = '';
    renderIssueMode();
    return true;
  }

  function ensureResearchModeBanner() {
    if (researchModeBanner) return researchModeBanner;
    researchModeBanner = document.createElement('section');
    researchModeBanner.className = 'changes-plan-mode changes-research-mode';
    researchModeBanner.hidden = true;
    const copy = document.createElement('div');
    copy.className = 'changes-plan-mode__copy';
    const title = document.createElement('strong');
    title.textContent = 'Research 证据卡专用模式';
    const locks = document.createElement('span');
    locks.className = 'changes-research-locks';
    locks.textContent = '来源只读 · 当前仅生成预览 · 自由指令已锁定';
    const card = document.createElement('div');
    card.className = 'changes-research-card';
    card.dataset.researchCard = 'true';
    copy.append(title, locks, card);
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = '退出 Research';
    researchModeLeaveButton = leave;
    leave.addEventListener('click', () => { void leaveResearchMode(); });
    researchModeBanner.append(copy, leave);
    instruction.parentElement.insertBefore(researchModeBanner, instruction);
    return researchModeBanner;
  }

  function renderResearchMode() {
    const banner = ensureResearchModeBanner();
    banner.hidden = !activeResearchRequest;
    instruction.hidden = Boolean(activeResearchRequest);
    instruction.readOnly = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) instruction.readOnly = true;
    contextPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) contextPicker.hidden = true;
    targetPicker.hidden = Boolean(activePlanRequest || activeIssueRequest);
    chapterButton.hidden = Boolean(activePlanRequest || activeIssueRequest);
    if (activeResearchRequest) chapterButton.hidden = true;
    if (!activeResearchRequest) return;
    const host = banner.querySelector('[data-research-card]');
    host.replaceChildren();
    const card = activeResearchRequest.card || {};
    const source = card.source || {};
    for (const [label, value] of [
      ['CLAIM · AI 提议主张', card.claim],
      ['SOURCE · 来源只读', `${source.grade || ''} 级 · ${source.title || source.filePath || source.path || '已由 Main 锁定来源'}\n${source.quote || ''}`],
      ['BOUNDARY · 不能外推的边界', card.boundary],
    ]) {
      const key = document.createElement('span');
      key.textContent = label;
      const text = document.createElement('p');
      text.textContent = String(value || '');
      host.append(key, text);
    }
  }

  async function leavePlanMode() {
    if (reviewCommitInFlight || !activePlanRequest) return;
    const discardId = pending?.id || null;
    proposalTransactions?.invalidate();
    pending = null;
    activePlanRequest = null;
    instruction.value = '';
    renderPlanMode();
    setBusy(false);
    preview.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'tree-empty', textContent: '已脱离 Plan；现在可自由输入跨文件修订目标。',
    }));
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    setStatus('已进入普通 Changes 自由模式');
    instruction.focus();
    if (discardId && bridge?.discardChanges) {
      await bridge.discardChanges(window.__workspace?.state?.project?.instanceId || null, discardId);
    }
  }

  function completePlanModeAfterWrite() {
    if (!activePlanRequest) return false;
    proposalTransactions?.invalidate();
    activePlanRequest = null;
    instruction.value = '';
    renderPlanMode();
    return true;
  }

  async function releaseResearchOwnership(snapshot, options = {}) {
    if (!snapshot) return [];
    const projectInstanceId = snapshot.projectInstanceId;
    const cardId = snapshot.handoff.cardId;
    const changeSetId = snapshot.changeSetId || null;
    const tasks = [];
    if (bridge?.cancelResearchHandoff) {
      tasks.push(Promise.resolve().then(() => bridge.cancelResearchHandoff(projectInstanceId, cardId)));
    }
    if (changeSetId && bridge?.discardChanges) {
      tasks.push(Promise.resolve().then(() => bridge.discardChanges(projectInstanceId, changeSetId)));
    }
    if (options.discardCard && bridge?.discardResearchCard) {
      tasks.push(Promise.resolve().then(() => bridge.discardResearchCard(projectInstanceId, cardId)));
    }
    return Promise.allSettled(tasks);
  }

  function snapshotResearchOwnership() {
    if (!activeResearchRequest) return null;
    return {
      projectInstanceId: activeResearchRequest.projectInstanceId,
      handoff: activeResearchRequest.handoff,
      changeSetId: pending?.proposalKind === 'research_card' ? pending.id : null,
    };
  }

  function clearResearchRendererState(snapshot, message = '') {
    if (!snapshot || activeResearchRequest?.handoff?.cardId !== snapshot.handoff.cardId ||
        activeResearchRequest.projectInstanceId !== snapshot.projectInstanceId) return false;
    proposalTransactions?.invalidate();
    if (pending?.proposalKind === 'research_card') pending = null;
    activeResearchRequest = null;
    instruction.value = '';
    renderResearchMode();
    renderPlanMode();
    renderIssueMode();
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    setBusy(false);
    if (message) {
      preview.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'tree-empty', textContent: message,
      }));
    }
    return true;
  }

  async function leaveResearchMode(options = {}) {
    if (reviewCommitInFlight || !activeResearchRequest) return { ok: false, message: '当前没有可退出的 Research 交接' };
    const snapshot = snapshotResearchOwnership();
    clearResearchRendererState(snapshot, options.message || '已退出 Research 专用模式；旧生成结果将被安全回收。');
    await releaseResearchOwnership(snapshot, { discardCard: options.discardCard === true });
    setStatus(options.status || '已返回普通 Changes 模式');
    return { ok: true };
  }

  async function cancelResearchForRerun() {
    // A rerun also invalidates a card whose Main resolution has not returned
    // yet, before activeResearchRequest exists in Renderer state.
    researchOpenSequence += 1;
    if (!activeResearchRequest) return { ok: true, canceled: false };
    const snapshot = snapshotResearchOwnership();
    clearResearchRendererState(snapshot, '新的 Research 已开始；旧证据交接已终止。');
    await releaseResearchOwnership(snapshot, { discardCard: false });
    return { ok: true, canceled: true };
  }

  async function finishNoChanges(mode, result, metric, ownership = {}) {
    const stillOwned = () => typeof ownership.isCurrent !== 'function' || ownership.isCurrent();
    if (!stillOwned()) return { ok: false, canceled: true, message: '旧生成结果已取消' };
    const projectInstanceId = metric?.originProjectInstanceId ||
      window.__workspace?.state?.project?.instanceId || null;
    const leakedCapability = typeof result?.changeSetId === 'string' && result.changeSetId
      ? result.changeSetId : null;
    const invalid = result?.noChanges !== true || result?.fileCount !== 0 ||
      Boolean(result?.review) || Boolean(leakedCapability);
    if (leakedCapability && bridge?.discardChanges) {
      try { await bridge.discardChanges(projectInstanceId, leakedCapability); } catch (_) {}
    }
    if (!stillOwned()) return { ok: false, canceled: true, message: '旧生成结果已取消' };
    if (invalid) {
      recordChangeMetric('failed', metric);
      setStatus('AI 返回的无变更结果不符合安全契约，已阻止进入审阅', true);
      return { ok: false, message: '无变更结果不符合安全契约' };
    }

    stopGenerationProgress();
    pending = null;
    if (mode === 'plan') activePlanRequest = null;
    if (mode === 'issue') activeIssueRequest = null;
    if (mode === 'normal') normalScopePlan = null;
    instruction.value = '';
    renderPlanMode();
    renderIssueMode();
    preview.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'tree-empty',
      textContent: mode === 'issue'
        ? 'AI 没有生成可安全应用的局部修复；项目文件未变化，已退出星图专用审阅。'
        : mode === 'plan'
          ? 'AI 没有生成可安全应用的局部修改；项目文件未变化，已退出 Plan 专用审阅。'
          : mode === 'chapter'
            ? 'AI 分阶段生成的完整章节与当前文件一致；项目文件未变化。'
          : 'AI 没有生成可安全应用的局部修改；项目文件未变化，本地范围计划已清空。',
    }));
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    recordChangeMetric('generated', metric);
    const message = mode === 'issue'
      ? '星图问题本次未产生修改；请调整正文或重新分析后再试。'
      : mode === 'plan'
        ? 'Plan 任务本次未产生修改；任务未写入正文，可从 Plan 调整后重新执行。'
        : mode === 'chapter'
          ? '本次生成的完整章节与当前正文一致；未创建审阅能力，磁盘没有变化。'
        : '本次范围未产生实际修改；项目文件未变化，可调整指令后重新确认范围。';
    setStatus(message);
    return { ok: true, noChanges: true, message };
  }

  function resetCommitControls() {
    if (commitNotice) commitNotice.hidden = true;
    if (panel) {
      delete panel.dataset.onboardingPhase;
      delete panel.dataset.onboardingEmpty;
    }
    if (panelTitle) panelTitle.textContent = '⇄ Project Changes';
    applyButton.textContent = '应用所选';
    discardButton.textContent = '丢弃';
  }

  function showCommitNotice(title, copy) {
    if (!commitNotice) return;
    commitNotice.hidden = false;
    const titleNode = commitNotice.querySelector('strong');
    const copyNode = commitNotice.querySelector('span');
    if (titleNode) titleNode.textContent = title;
    if (copyNode) copyNode.textContent = copy;
  }

  function recordChangeMetric(outcome, metric = pending?.metric) {
    if (!metric?.operationId || !window.__workspace?.state?.project) return Promise.resolve(false);
    const decision = ['accepted', 'rejected', 'discarded'].includes(outcome);
    if (decision && metric.decisionRecorded) return Promise.resolve(false);
    if (decision && metric.decisionPromise) return metric.decisionPromise;
    const phaseStartedAt = decision ? metric.reviewStartedAt : metric.startedAt;
    const persistence = Promise.resolve(window.WritCraftAiMetrics?.record?.(metric.originProjectInstanceId, {
      operationId: metric.operationId,
      action: metric.action || 'changeset', outcome, style: 'none', scope: metric.scope || 'multi_file',
      durationMs: Math.max(0, Date.now() - (phaseStartedAt || Date.now())),
      beforeChars: metric.beforeChars || 0,
      afterChars: metric.afterChars || 0,
    })).catch(() => false);
    if (!decision) return persistence;
    metric.decisionPromise = persistence.then(recorded => {
      if (recorded) metric.decisionRecorded = true;
      return recorded;
    }).finally(() => { metric.decisionPromise = null; });
    return metric.decisionPromise;
  }

  async function settleOnboardingMetric(outcome, metric) {
    if (!metric?.operationId) return true;
    if (metric.decisionRecorded) {
      if (unsettledOnboardingMetric?.metric === metric) unsettledOnboardingMetric = null;
      return true;
    }
    const unsettled = { metric, outcome };
    unsettledOnboardingMetric = unsettled;
    let recorded = await recordChangeMetric(outcome, metric);
    if (!recorded) {
      await new Promise(resolve => setTimeout(resolve, 120));
      recorded = await recordChangeMetric(outcome, metric);
    }
    if (recorded && unsettledOnboardingMetric === unsettled) unsettledOnboardingMetric = null;
    return recorded;
  }

  async function releaseOnboardingReview(active) {
    if (!active?.id || active.proposalKind !== 'onboarding_v2') return false;
    if (!active.capabilityReleased) {
      if (!bridge?.discardChanges) return false;
      if (!active.releasePromise) {
        const originProjectInstanceId = active.metric?.originProjectInstanceId ||
          window.__workspace?.state?.project?.instanceId || null;
        const release = Promise.resolve()
          .then(() => bridge.discardChanges(originProjectInstanceId, active.id))
          .then(result => {
            if (result?.ok === false) return false;
            active.capabilityReleased = true;
            return true;
          })
          .catch(() => false);
        const trackedRelease = release.finally(() => {
          if (active.releasePromise === trackedRelease) active.releasePromise = null;
        });
        active.releasePromise = trackedRelease;
      }
      if (!await active.releasePromise) return false;
    }
    return settleOnboardingMetric('discarded', active.metric);
  }

  async function releaseAbandonedOnboardingConfirmation(projectInstanceId, token) {
    if (typeof token !== 'string' || !token) return true;
    let active = unsettledOnboardingConfirmationRelease;
    if (!active || active.projectInstanceId !== projectInstanceId || active.token !== token) {
      active = { projectInstanceId, token, released: false, releasePromise: null };
      unsettledOnboardingConfirmationRelease = active;
    }
    if (active.released) return true;
    if (!bridge?.discardOnboardingConfirmation) return false;
    if (!active.releasePromise) {
      const release = Promise.resolve()
        .then(() => bridge.discardOnboardingConfirmation(active.projectInstanceId, active.token))
        .then(result => {
          if (result?.ok === false) return false;
          active.released = true;
          if (unsettledOnboardingConfirmationRelease === active) unsettledOnboardingConfirmationRelease = null;
          return true;
        })
        .catch(() => false);
      const trackedRelease = release.finally(() => {
        if (active.releasePromise === trackedRelease) active.releasePromise = null;
      });
      active.releasePromise = trackedRelease;
    }
    return active.releasePromise;
  }

  async function loadMetrics() {
    const requestId = ++metricsRequestSequence;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    window.WritCraftAiMetricsView?.render?.(metricsHost, { status: 'loading' });
    const result = await window.WritCraftAiMetrics?.aggregate?.();
    if (requestId !== metricsRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    window.WritCraftAiMetricsView?.render?.(metricsHost, result || { status: 'error' });
  }

  function setStatus(text, error = false) {
    status.textContent = text;
    status.style.color = error ? '#a3473e' : '';
    if (error && panel?.dataset.generationState === 'active') {
      stopGenerationProgress();
      preview.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'changes-generation-error',
        textContent: `本次没有生成可审阅内容：${text}`,
      }));
    }
  }

  function stopGenerationProgress() {
    if (generationProgressTimer) clearInterval(generationProgressTimer);
    generationProgressTimer = null;
    if (panel) delete panel.dataset.generationState;
  }

  function startGenerationProgress(title, detail) {
    stopGenerationProgress();
    const card = document.createElement('section');
    card.className = 'changes-generation-progress';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    const indicator = document.createElement('span');
    indicator.className = 'changes-generation-progress__indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const message = document.createElement('p');
    message.textContent = detail;
    const elapsed = document.createElement('small');
    const startedAt = Date.now();
    const updateElapsed = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      elapsed.textContent = seconds < 10
        ? '正在准备项目上下文…'
        : `AI 正在处理，已等待 ${seconds} 秒。可以继续等待，请不要重复提交。`;
    };
    updateElapsed();
    generationProgressTimer = setInterval(updateElapsed, 1000);
    copy.append(heading, message, elapsed);
    card.append(indicator, copy);
    preview.replaceChildren(card);
    if (panel) panel.dataset.generationState = 'active';
  }

  function setBusy(busy, owner = 'general') {
    const controlsBusy = Boolean(busy || recoveryBlocked);
    proposeButton.disabled = controlsBusy;
    chapterButton.disabled = controlsBusy;
    applyButton.disabled = controlsBusy;
    discardButton.disabled = controlsBusy;
    if (planModeLeaveButton) planModeLeaveButton.disabled = reviewCommitInFlight;
    if (issueModeLeaveButton) issueModeLeaveButton.disabled = reviewCommitInFlight;
    if (researchModeLeaveButton) researchModeLeaveButton.disabled = reviewCommitInFlight || busy;
    preview.querySelectorAll('.change-decision, [data-onboarding-path]').forEach(control => { control.disabled = controlsBusy; });
    historyList.querySelectorAll('.history-undo').forEach(control => {
      control.disabled = controlsBusy || historyUndoInFlight;
    });
    proposeButton.textContent = busy && owner !== 'chapter' ? '处理中…'
      : activeResearchRequest ? activeResearchRequest.phase === 'review' ? 'Research 提案待审阅' : '依据核对卡生成 Diff'
        : activePlanRequest ? '重新生成此 Plan 任务'
        : activeIssueRequest ? '重新生成此星图问题'
          : normalScopePlan ? '确认范围并生成 Diff' : '跨文件修改';
    chapterButton.textContent = busy && owner === 'chapter' ? '生成中…' : '生成当前章节';
    contextPicker?.setAttribute('aria-busy', String(controlsBusy));
    targetPicker?.setAttribute('aria-busy', String(controlsBusy));
    if (controlsBusy) contextList?.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = true; });
    if (controlsBusy) targetList?.querySelectorAll('input[type="checkbox"]').forEach(input => { input.disabled = true; });
    else {
      renderContextPicker();
      renderTargetPicker();
      syncApplyButton();
    }
  }

  function renderRecoveryState(value = null) {
    if (!recoveryHost) return;
    if (!value) {
      recoveryBlocked = false;
      recoveryActionInFlight = false;
      recoveryHost.hidden = true;
      recoveryPaths.replaceChildren();
      recoveryActions.hidden = true;
      setBusy(reviewCommitInFlight || historyUndoInFlight);
      return;
    }
    recoveryBlocked = value.blocked !== false;
    recoveryHost.hidden = false;
    recoveryHost.dataset.state = value.state || 'checking';
    recoveryTitle.textContent = value.title || '正在核对项目写入状态';
    recoveryMessage.textContent = value.message || '核对完成前，编辑、保存和 AI 写入均已暂停。';
    recoveryPaths.replaceChildren();
    for (const path of value.affectedPaths || []) {
      const item = document.createElement('li');
      item.textContent = path;
      recoveryPaths.appendChild(item);
    }
    const manual = value.state === 'manual' && typeof value.operationId === 'string';
    recoveryActions.hidden = !manual;
    recoveryActions.querySelectorAll('button[data-action]').forEach(button => {
      button.disabled = recoveryActionInFlight || !manual;
      button.dataset.operationId = manual ? value.operationId : '';
    });
    if (manual) openPanel();
    setBusy(reviewCommitInFlight || historyUndoInFlight);
  }

  async function runRecoveryAction(event) {
    const button = event.currentTarget;
    const action = button?.dataset?.action;
    const operationId = button?.dataset?.operationId;
    if (recoveryActionInFlight || !['restore_before', 'keep_after'].includes(action) ||
        typeof operationId !== 'string' || !operationId) return;
    recoveryActionInFlight = true;
    recoveryActions.querySelectorAll('button').forEach(control => { control.disabled = true; });
    renderRecoveryState({
      blocked: true,
      state: 'checking',
      title: action === 'restore_before' ? '正在恢复到操作前' : '正在保留操作后',
      message: 'WritCraft 正在重新写入全部受影响文件并核对 History；请不要关闭项目。',
    });
    try {
      await window.__workspace?.resolveChangesHistoryRecovery?.(operationId, action);
    } finally {
      recoveryActionInFlight = false;
      if (!recoveryActions.hidden) {
        recoveryActions.querySelectorAll('button[data-action]').forEach(control => {
          control.disabled = false;
        });
      }
    }
  }

  recoveryActions?.querySelectorAll('button[data-action]').forEach(button => {
    button.addEventListener('click', runRecoveryAction);
  });

  function invalidateEditableProposal(message = '') {
    const active = proposalTransactions?.getActive?.();
    if (!active || !['normal', 'chapter'].includes(active.mode)) return false;
    proposalTransactions.invalidate();
    stopGenerationProgress();
    setBusy(false);
    if (active.mode === 'chapter') chapterButton.textContent = '生成当前章节';
    if (message) setStatus(message);
    return true;
  }

  function currentNormalRequest() {
    return window.WritCraftProjectChangesScope?.createRequest?.(
      instruction.value,
      selectedTargetPaths,
      selectedContextPaths
    ) || null;
  }

  function invalidateNormalScopePlan(message = '') {
    if (!normalScopePlan) return false;
    normalScopePlan = null;
    setBusy(false);
    if (!pending && preview.querySelector('.project-changes-scope-plan')) {
      preview.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'tree-empty',
        textContent: '修改范围已变化。请重新点击“跨文件修改”确认权威范围。',
      }));
    }
    if (message) setStatus(message);
    return true;
  }

  function renderNormalScopePlan(request) {
    const scopeInstruction = request.instruction.length > 120
      ? `${request.instruction.slice(0, 119)}…`
      : request.instruction;
    const host = document.createElement('section');
    host.className = 'project-changes-scope-plan';
    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = '本地权威修改范围';
    const note = document.createElement('span');
    note.textContent = `本次只允许修改 ${request.targetPaths.length} 个正文文件；edit.md 和 ${request.contextPaths.length} 个附加文件仅供阅读。此步尚未调用 AI。`;
    head.append(title, note);
    host.appendChild(head);
    for (const filePath of request.targetPaths) {
      const card = document.createElement('article');
      card.className = 'project-changes-scope-file';
      const name = document.createElement('strong');
      name.textContent = filePath;
      const reason = document.createElement('p');
      reason.textContent = `显式可写目标：仅按用户指令“${scopeInstruction}”在此文件中生成可审阅的局部 Diff。`;
      card.append(name, reason);
      host.appendChild(card);
    }
    preview.replaceChildren(host);
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    normalScopePlan = request;
    setBusy(false);
    setStatus('请核对可修改目标；再次点击“确认范围并生成 Diff”才会调用 AI。');
  }

  function renderTargetPicker() {
    if (!targetList || !targetCount) return;
    targetCount.textContent = `${selectedTargetPaths.length} / 8`;
    targetList.replaceChildren();
    if (!availableTargetPaths.length) {
      targetList.appendChild(Object.assign(document.createElement('div'), {
        className: 'composer-context-empty', textContent: '当前项目没有可修改的公开 Markdown 正文。',
      }));
      return;
    }
    const atLimit = selectedTargetPaths.length >= 8;
    for (const filePath of availableTargetPaths) {
      const label = document.createElement('label');
      label.className = 'composer-context-item';
      label.title = filePath;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedTargetPaths.includes(filePath);
      checkbox.disabled = Boolean(activePlanRequest || activeIssueRequest ||
        (activeResearchRequest && activeResearchRequest.phase !== 'ready')) || (atLimit && !checkbox.checked);
      checkbox.dataset.path = filePath;
      const pathText = document.createElement('span');
      pathText.textContent = filePath;
      checkbox.addEventListener('change', () => {
        targetSelectionTouched = true;
        const result = window.WritCraftProjectChangesScope.updateTargets(
          selectedTargetPaths, filePath, checkbox.checked, availableTargetPaths
        );
        selectedTargetPaths = result.selected;
        selectedContextPaths = selectedContextPaths.filter(contextPath => !selectedTargetPaths.includes(contextPath));
        if (!result.ok) setStatus('可修改目标最多选择 8 个正文文件', true);
        invalidateEditableProposal('章节上下文或普通 Changes 范围已变化，旧生成请求已取消。');
        invalidateNormalScopePlan('可修改目标已变化，需要重新确认范围。');
        renderTargetPicker();
        renderContextPicker();
      });
      label.append(checkbox, pathText);
      targetList.appendChild(label);
    }
  }

  function refreshTargetPicker(reset = false) {
    const helper = window.WritCraftProjectChangesScope;
    if (!helper) return [];
    availableTargetPaths = helper.availableTargetPaths(window.__workspace?.state?.tree || []);
    if (reset) {
      selectedTargetPaths = [];
      targetSelectionTouched = false;
    }
    const currentPath = window.__workspace?.getCurrentPath?.() || '';
    selectedTargetPaths = targetSelectionTouched
      ? helper.reconcileTargets(selectedTargetPaths, availableTargetPaths, currentPath, false)
      : helper.reconcileTargets([], availableTargetPaths, currentPath, true);
    renderTargetPicker();
    return [...selectedTargetPaths];
  }

  function renderContextPicker() {
    if (!contextList || !contextCount) return;
    contextCount.textContent = `${selectedContextPaths.length} / 8`;
    contextList.replaceChildren();
    if (!availableContextPaths.length) {
      const empty = document.createElement('div');
      empty.className = 'composer-context-empty';
      empty.textContent = window.__workspace?.getCurrentPath?.()
        ? '当前项目没有其他可选 Markdown 文件。'
        : '打开正文文件后可选择项目内其他 Markdown。';
      contextList.appendChild(empty);
      return;
    }
    const atLimit = selectedContextPaths.length >= 8;
    for (const filePath of availableContextPaths) {
      const label = document.createElement('label');
      label.className = 'composer-context-item';
      label.title = filePath;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedContextPaths.includes(filePath);
      checkbox.disabled = Boolean(activePlanRequest || activeIssueRequest) || selectedTargetPaths.includes(filePath) ||
        (atLimit && !checkbox.checked);
      checkbox.dataset.path = filePath;
      const pathText = document.createElement('span');
      pathText.textContent = filePath;
      checkbox.addEventListener('change', () => {
        const result = window.WritCraftComposerContext.updateSelection(
          selectedContextPaths, filePath, checkbox.checked, availableContextPaths
        );
        selectedContextPaths = result.selected;
        if (!result.ok) setStatus('章节上下文最多选择 8 个文件', true);
        invalidateEditableProposal('章节上下文已变化，旧生成请求已取消。');
        invalidateNormalScopePlan('只读上下文已变化，需要重新确认范围。');
        renderContextPicker();
      });
      label.append(checkbox, pathText);
      contextList.appendChild(label);
    }
  }

  function refreshContextPicker(reset = false) {
    const helper = window.WritCraftComposerContext;
    if (!helper) return [];
    if (reset) selectedContextPaths = [];
    availableContextPaths = helper.availableContextPaths(
      window.__workspace?.state?.tree || [],
      window.__workspace?.getCurrentPath?.() || ''
    );
    selectedContextPaths = helper.reconcileSelection(selectedContextPaths, availableContextPaths);
    selectedContextPaths = selectedContextPaths.filter(filePath => !selectedTargetPaths.includes(filePath));
    renderContextPicker();
    return [...selectedContextPaths];
  }

  function openPanel() {
    if (!window.__workspace?.state?.project) {
      const save = document.getElementById('save-state');
      if (save) save.textContent = '请先创建或打开写作项目';
      return;
    }
    window.__graphView?.close?.();
    if (window.__assistantDock) window.__assistantDock.open('changes');
    else {
      window.__workspace?.setAIVisible?.(false);
      workArea.classList.add('has-changes');
      panel.hidden = false;
    }
    refreshTargetPicker();
    refreshContextPicker();
    if (!activePlanRequest && !activeIssueRequest && !activeResearchRequest) instruction.focus();
    loadHistory();
    loadMetrics();
  }

  function closePanel() {
    if (activeResearchRequest) void leaveResearchMode({
      message: 'Research 面板已关闭；未应用的提案已安全回收。',
      status: 'Research 交接已取消',
    });
    if (window.__assistantDock) window.__assistantDock.close('changes');
    else {
      workArea.classList.remove('has-changes');
      panel.hidden = true;
    }
  }

  function diffBlock(hunk) {
    const pre = document.createElement('pre');
    pre.className = 'change-hunk';
    const coordinates = document.createElement('span');
    coordinates.className = 'change-line-meta';
    coordinates.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    pre.appendChild(coordinates);
    (hunk.lines || []).forEach(line => {
      const span = document.createElement('span');
      span.className = `change-line-${line.kind}`;
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : '';
      span.textContent = `${prefix}${line.text}\n`;
      pre.appendChild(span);
    });
    return pre;
  }

  function decisionButton(label, decision, onClick, active = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `change-decision change-decision--${decision}`;
    button.textContent = active
      ? decision === 'accepted' ? '已接受'
        : decision === 'rejected' ? '已拒绝' : '未决定'
      : label;
    button.setAttribute('aria-pressed', String(active));
    button.disabled = reviewCommitInFlight || active;
    button.addEventListener('click', onClick);
    return button;
  }

  function syncApplyButton() {
    if (confirmationMode) {
      applyButton.disabled = reviewCommitInFlight;
      return;
    }
    if (!pending) return;
    const counts = window.WritCraftChangesReviewState?.counts?.(pending.reviewState);
    const incompleteIssue = pending.requireCompleteDecision === true && Boolean(counts?.pending);
    applyButton.disabled = reviewCommitInFlight || !counts || incompleteIssue ||
      (counts.accepted === 0 && counts.rejected === 0);
  }

  function setReviewDecisionStatus(message) {
    const counts = window.WritCraftChangesReviewState?.counts?.(pending?.reviewState);
    if (pending?.requireCompleteDecision === true && counts?.pending) {
      setStatus(`${message} 请先处理全部修改块；还剩 ${counts.pending} 项，完成前不能写入。`);
      return;
    }
    setStatus(message);
  }

  function renderPendingReview() {
    stopGenerationProgress();
    const existingOnboardingInputs = [...preview.querySelectorAll('[data-onboarding-path]')];
    const selectedOnboardingPaths = existingOnboardingInputs.length
      ? new Set(existingOnboardingInputs.filter(input => input.checked).map(input => input.dataset.onboardingPath))
      : null;
    preview.replaceChildren();
    if (!pending?.reviewState) return;
    const State = window.WritCraftChangesReviewState;
    for (const file of pending.reviewState.review.files) {
      const card = document.createElement('article');
      card.className = 'change-file';
      const head = document.createElement('div');
      head.className = 'change-file-head';
      const name = document.createElement('strong');
      name.textContent = file.path;
      const policy = document.createElement('span');
      policy.className = 'change-policy';
      policy.textContent = `${file.hunks.length} 项修改`;
      const bulk = document.createElement('div');
      bulk.className = 'change-file-actions';
      if (file.hunks.length > 1) {
        const fileDecisions = file.hunks.map(hunk => pending.reviewState.decisions[hunk.id]);
        for (const [label, decision] of [['本文件全接受', 'accepted'], ['本文件全拒绝', 'rejected'], ['清除本文件决定', 'pending']]) {
          const active = fileDecisions.every(value => value === decision);
          bulk.appendChild(decisionButton(label, decision, () => {
            pending.reviewState = State.updateFile(pending.reviewState, file.path, decision);
            file.hunks.forEach(hunk => expandedReviewHunks.delete(hunk.id));
            renderPendingReview();
            setReviewDecisionStatus(`已${decision === 'accepted' ? '接受' : decision === 'rejected' ? '拒绝' : '清除'}本文件 ${file.hunks.length} 项修改；尚未写入项目文件。`);
          }, active));
        }
      }
      head.append(name, policy, bulk);
      const summary = document.createElement('p');
      summary.textContent = file.summary || 'AI 建议修改';
      card.append(head, summary);
      for (const hunk of file.hunks) {
        const decision = pending.reviewState.decisions[hunk.id];
        const hunkCard = document.createElement('section');
        hunkCard.className = `change-hunk-card is-${decision}`;
        const toolbar = document.createElement('div');
        toolbar.className = 'change-hunk-actions';
        const location = document.createElement('span');
        location.textContent = `原文 ${hunk.oldStart} 行 → 新文 ${hunk.newStart} 行 · ${decision === 'pending' ? '待决定' : decision === 'accepted' ? '已接受' : '已拒绝'}`;
        if (decision !== 'pending' && !expandedReviewHunks.has(hunk.id)) {
          const result = document.createElement('div');
          result.className = 'change-hunk-result';
          const resultCopy = document.createElement('span');
          resultCopy.textContent = decision === 'accepted'
            ? '已选择接受 · 尚未写入'
            : '已选择拒绝 · 文件不会采用此项修改';
          const revise = document.createElement('button');
          revise.type = 'button';
          revise.textContent = '修改决定';
          revise.disabled = reviewCommitInFlight;
          revise.addEventListener('click', () => {
            expandedReviewHunks.add(hunk.id);
            renderPendingReview();
          });
          result.append(resultCopy, revise);
          hunkCard.appendChild(result);
          card.appendChild(hunkCard);
          continue;
        }
        toolbar.appendChild(location);
        for (const [label, next] of [['接受', 'accepted'], ['拒绝', 'rejected'], ['清除决定', 'pending']]) {
          const action = decisionButton(label, next, () => {
            pending.reviewState = State.update(pending.reviewState, hunk.id, next);
            expandedReviewHunks.delete(hunk.id);
            renderPendingReview();
            setReviewDecisionStatus(`已${next === 'accepted' ? '接受' : next === 'rejected' ? '拒绝' : '清除'}这项修改；尚未写入项目文件。`);
          }, decision === next);
          toolbar.appendChild(action);
        }
        hunkCard.append(toolbar, diffBlock(hunk));
        card.appendChild(hunkCard);
      }
      preview.appendChild(card);
    }
    renderOnboardingSuggestions(pending.fileSuggestions, selectedOnboardingPaths, 'selection');
    const counts = State.counts(pending.reviewState);
    const isOnboardingProposal = pending.proposalKind === 'onboarding_v2';
    const isEditPromptProposal = isOnboardingProposal || pending.proposalKind === 'edit_prompt_repair';
    if (panelTitle) panelTitle.textContent = isOnboardingProposal
      ? '项目初始化 · 第 1 步'
      : '⇄ Project Changes';
    if (commitNotice) commitNotice.hidden = !isEditPromptProposal;
    if (isOnboardingProposal) showCommitNotice(
      '第一阶段 · 先选择，再写入',
      '“接受 / 拒绝”只记录你的选择；点击底部“确认决定并更新 edit.md”后，才会真正写入文件。初始文件仍需下一步单独确认。'
    );
    if (panel) {
      if (isOnboardingProposal) panel.dataset.onboardingPhase = 'review';
      else delete panel.dataset.onboardingPhase;
    }
    applyButton.textContent = isEditPromptProposal ? '确认决定并更新 edit.md' : '确认决定并写入文件';
    applyButton.hidden = counts.total === 0;
    discardButton.hidden = false;
    syncApplyButton();
    setStatus(counts.total
      ? pending.requireCompleteDecision && counts.pending
        ? `图谱问题修复需完整决策：已接受 ${counts.accepted} · 已拒绝 ${counts.rejected} · 待决定 ${counts.pending}；请先处理全部修改块`
        : counts.pending
          ? `还需决定 ${counts.pending} 项；当前选择尚未写入文件`
          : `审阅选择已完成：接受 ${counts.accepted} 项、拒绝 ${counts.rejected} 项；请在下方确认写入`
      : 'AI 未提出需要修改的文件');
  }

  function renderOnboardingSuggestions(suggestions, selectedPaths = null, mode = 'selection') {
    if (!suggestions?.length) return;
    const section = document.createElement('section');
    section.className = 'onboarding-file-suggestions';
    section.dataset.mode = mode;
    section.setAttribute('aria-label', mode === 'confirmation' ? '确认创建初始文件' : '初始文件建议预选');
    const heading = document.createElement('h3');
    heading.textContent = mode === 'confirmation' ? '选择要创建的文件' : '初始文件建议 · 仅预选';
    const note = document.createElement('p');
    note.textContent = mode === 'confirmation'
      ? '勾选只是选择；只有点击下方“创建所选文件”才会真正创建。'
      : '当前仅选择建议。提交 edit.md 不会创建文件；完成审阅后还需要一次独立确认。';
    section.append(heading, note);
    for (const item of suggestions) {
      const label = document.createElement('label');
      label.className = 'onboarding-file-suggestion';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedPaths ? selectedPaths.has(item.path) : true;
      checkbox.disabled = reviewCommitInFlight;
      checkbox.dataset.onboardingPath = item.path;
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = item.path;
      const reason = document.createElement('small');
      reason.textContent = item.reason;
      copy.append(name, reason);
      label.append(checkbox, copy);
      section.appendChild(label);
    }
    preview.appendChild(section);
  }

  function renderChangeSet(result, metric = null, preparedReviewState = null) {
    const reviewState = preparedReviewState || window.WritCraftChangesReviewState?.create?.(result.review);
    if (!reviewState) {
      pending = null;
      setStatus('Changes 审阅数据无效，已阻止应用', true);
      return false;
    }
    if (metric) metric.reviewStartedAt = Date.now();
    expandedReviewHunks.clear();
    pending = {
      id: reviewState.review.changeSetId,
      reviewState,
      proposalKind: result.proposalKind || null,
      proposalDigest: result.proposalDigest || null,
      fileSuggestions: result.fileSuggestions || [],
      provenance: result.provenance || null,
      requireCompleteDecision: result.requireCompleteDecision === true,
      metric,
    };
    renderPendingReview();
    if (activePlanRequest) renderPlanMode(result.provenance);
    if (activeIssueRequest) renderIssueMode(result.provenance);
    return true;
  }

  async function replaceGeneratedReview(result, metric) {
    const previous = pending;
    const originProjectInstanceId = metric?.originProjectInstanceId || window.__workspace?.state?.project?.instanceId || '';
    const candidateReviewState = window.WritCraftChangesReviewState?.create?.(result.review);
    if (!candidateReviewState) {
      try { await bridge.discardChanges(originProjectInstanceId, result.changeSetId); } catch (_) {}
      setStatus('Main 返回的新审阅数据无效，已取消新提案；旧审阅保持不变。', true);
      return false;
    }
    const replacement = await window.WritCraftChangesProposalTransaction?.supersede?.(
      previous ? {
        id: previous.id,
        projectInstanceId: previous.metric?.originProjectInstanceId || originProjectInstanceId,
      } : null,
      { id: result.changeSetId, projectInstanceId: originProjectInstanceId },
      { discard: (projectInstanceId, changeSetId) => bridge.discardChanges(projectInstanceId, changeSetId) }
    );
    if (!replacement?.ok) {
      setStatus('旧审阅未能安全释放，新提案已取消；当前审阅保持不变。', true);
      return false;
    }
    if (replacement.previousDiscarded) recordChangeMetric('discarded', previous?.metric);
    // Keep the previous review rendered until its Main capability is gone;
    // only then transfer Renderer ownership to the already-created new one.
    renderChangeSet(result, metric, candidateReviewState);
    return true;
  }

  async function replaceGeneratedChapterReview(result, metric, chapterSession, currentBinding, contextPaths) {
    const originProjectInstanceId = metric.originProjectInstanceId;
    return window.WritCraftChangesProposalTransaction.replaceChapterReview(
      proposalTransactions,
      chapterSession,
      result,
      {
        getCurrent: currentBinding,
        discard: (projectInstanceId, changeSetId) => bridge.discardChanges?.(projectInstanceId, changeSetId),
        prepare: () => window.WritCraftChangesReviewState?.create?.(result.review),
        replace: () => window.WritCraftChangesProposalTransaction.supersede(
          null,
          { id: result.changeSetId, projectInstanceId: originProjectInstanceId },
          { discard: (projectInstanceId, changeSetId) => bridge.discardChanges(projectInstanceId, changeSetId) }
        ),
        onFailure: reason => {
          recordChangeMetric('failed', metric);
          setStatus(reason === 'DISCARD_FAILED'
            ? '无效章节审阅的能力回收未获确认；请切换项目或重启笔触后再试。'
            : reason === 'INVALID_REVIEW'
              ? 'Main 返回的新章节审阅数据无效，已安全取消。'
              : '章节审阅能力未能安全接管，旧结果已取消。', true);
        },
        render: candidateReviewState => {
          renderChangeSet(result, metric, candidateReviewState);
          recordChangeMetric('generated', metric);
          const contextSummary = contextPaths.length
            ? ` · 上下文 ${contextPaths.length} 个：${contextPaths.join('、')}`
            : ' · 无额外上下文';
          setStatus(`章节提案已生成 · 目标 ${chapterSession.request.targetPath}${contextSummary} · 应用前请审阅 Diff`);
        },
      }
    );
  }

  async function refreshCommittedEdit(options = {}) {
    const authoritativeReloaded = options.authoritativeReloaded === true;
    if (!authoritativeReloaded) await window.__workspace.refreshTree();
    const currentIsEdit = window.__workspace.getCurrentPath?.() === 'edit.md';
    const refreshed = authoritativeReloaded && currentIsEdit
      ? true
      : currentIsEdit
        ? await window.__workspace.reloadCurrent()
        : await window.__workspace.openFile('edit.md', { pin: true });
    if (!refreshed) throw new Error('edit.md 已写入磁盘，但编辑器刷新失败；请重新打开文件');
    if (!authoritativeReloaded) await loadHistory();
  }

  function normalizedOnboardingConfirmation(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        typeof raw.token !== 'string' || !raw.token ||
        typeof raw.proposalDigest !== 'string' || !raw.proposalDigest ||
        !Array.isArray(raw.fileSuggestions)) return null;
    const suggestions = raw.fileSuggestions.filter(item => item && typeof item === 'object' &&
      typeof item.path === 'string' && item.path && typeof item.reason === 'string');
    if (suggestions.length !== raw.fileSuggestions.length) return null;
    return {
      token: raw.token,
      proposalDigest: raw.proposalDigest,
      fileSuggestions: suggestions,
      source: typeof raw.source === 'string' ? raw.source : '',
    };
  }

  function validateConfirmedFiles(files, selectedPaths) {
    if (!Array.isArray(files) || files.length !== selectedPaths.length) return null;
    const expected = new Set(selectedPaths);
    const seen = new Set();
    const confirmed = [];
    for (const file of files) {
      if (!file || typeof file !== 'object' || typeof file.path !== 'string' ||
          !expected.has(file.path) || seen.has(file.path)) return null;
      seen.add(file.path);
      confirmed.push(Object.freeze({
        path: file.path,
        ...(Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? { bytes: file.bytes } : {}),
        ...(typeof file.revision === 'string' ? { revision: file.revision } : {}),
      }));
    }
    return seen.size === expected.size ? Object.freeze(confirmed) : null;
  }

  function enterOnboardingConfirmation(raw, selectedPaths = null, options = {}) {
    const confirmation = normalizedOnboardingConfirmation(raw);
    if (!confirmation) return false;
    const available = new Set(confirmation.fileSuggestions.map(item => item.path));
    const requested = selectedPaths instanceof Set ? selectedPaths : new Set(available);
    confirmationMode = {
      ...confirmation,
      projectInstanceId: options.projectInstanceId || window.__workspace?.state?.project?.instanceId || null,
      editNoChanges: options.editNoChanges === true,
      metric: options.metric || null,
      selectedPaths: new Set([...requested].filter(filePath => available.has(filePath))),
    };
    if (panel) panel.dataset.onboardingPhase = 'confirmation';
    if (panelTitle) panelTitle.textContent = '项目初始化 · 第 2 步';
    const hasSuggestions = confirmation.fileSuggestions.length > 0;
    if (panel) panel.dataset.onboardingEmpty = String(!hasSuggestions);
    pending = null;
    preview.replaceChildren();
    const flow = document.createElement('div');
    flow.className = 'onboarding-confirmation-flow';
    flow.tabIndex = -1;
    const completedStep = document.createElement('div');
    completedStep.className = 'onboarding-confirmation-step is-complete';
    const completedLabel = document.createElement('small');
    completedLabel.textContent = '第 1 步 · 已完成';
    const completedTitle = document.createElement('strong');
    completedTitle.textContent = confirmationMode.editNoChanges ? '项目说明无需改动' : '项目说明已写入 edit.md';
    completedStep.append(completedLabel, completedTitle);
    const arrow = document.createElement('span');
    arrow.className = 'onboarding-confirmation-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    const currentStep = document.createElement('div');
    currentStep.className = 'onboarding-confirmation-step is-current';
    const currentLabel = document.createElement('small');
    currentLabel.textContent = '第 2 步 · 由你决定';
    const currentTitle = document.createElement('strong');
    currentTitle.textContent = hasSuggestions ? '是否创建建议文件' : '确认项目卡完成';
    currentStep.append(currentLabel, currentTitle);
    flow.append(completedStep, arrow, currentStep);
    const explainer = document.createElement('p');
    explainer.className = 'onboarding-confirmation-explainer';
    const explainerLead = document.createElement('strong');
    explainerLead.textContent = hasSuggestions
      ? '这一页只决定要不要新建文件。'
      : 'AI 没有提出需要新建的文件。';
    const explainerDetail = document.createElement('span');
    explainerDetail.textContent = hasSuggestions
      ? ' 勾选的文件会在点击“创建所选文件”后一次创建；取消勾选或选择“跳过文件创建”都不会撤销已经完成的 edit.md。'
      : ' edit.md 已经处理完成；点击“完成项目卡”即可返回写作。';
    explainer.append(
      explainerLead,
      explainerDetail
    );
    preview.append(flow, explainer);
    renderOnboardingSuggestions(confirmationMode.fileSuggestions, confirmationMode.selectedPaths, 'confirmation');
    showCommitNotice(
      '项目卡 · 第 2 步（共 2 步）',
      confirmationMode.editNoChanges
        ? hasSuggestions
          ? '项目说明已经符合本次项目卡；下面只确认是否创建建议文件。'
          : '项目说明已经符合本次项目卡，且没有需要新建的文件。'
        : hasSuggestions
          ? '项目说明已经写入 edit.md；下面只确认是否创建建议文件。'
          : '项目说明已经写入 edit.md，且没有需要新建的文件。'
    );
    applyButton.hidden = !hasSuggestions;
    applyButton.textContent = '创建所选文件';
    discardButton.hidden = false;
    discardButton.textContent = hasSuggestions ? '跳过文件创建' : '完成项目卡';
    syncApplyButton();
    setStatus(hasSuggestions
      ? '尚未创建任何文件。请勾选要创建的建议文件，或直接跳过。'
      : '项目说明已经完成；本次没有建议创建的文件。');
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      if (confirmationMode) flow.focus();
    });
    return true;
  }

  function renderHistory(entries) {
    historyList.replaceChildren();
    if (!entries?.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '还没有已应用的跨文件修改。';
      historyList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const card = document.createElement('article');
      card.className = 'history-card';
      const head = document.createElement('div');
      head.className = 'history-card-head';
      const title = document.createElement('strong');
      const accepted = entry.review?.acceptedHunkIds?.length || 0;
      const rejected = entry.review?.rejectedHunkIds?.length || 0;
      title.textContent = entry.kind === 'review'
        ? `仅审阅 · 已拒绝 ${rejected} 个修改块`
        : `${entry.files.length} 个文件 · ${entry.status === 'undone' ? '已撤销' : '已应用'}${entry.review ? ` · 接受 ${accepted} / 拒绝 ${rejected}` : ''}`;
      const time = document.createElement('time');
      const timestamp = entry.reviewedAt || entry.appliedAt || '';
      time.dateTime = timestamp;
      time.textContent = timestamp ? new Date(timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      head.append(title, time);
      if (entry.status === 'applied') {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'history-undo';
        undo.textContent = '安全撤销';
        undo.disabled = historyUndoInFlight;
        undo.addEventListener('click', () => undoHistory(entry));
        head.appendChild(undo);
      }
      const files = document.createElement('p');
      files.textContent = entry.kind === 'review'
        ? '项目文件未改变；审阅决定已写入审计历史。'
        : entry.files.map(file => file.path).join('、');
      card.append(head, files);
      historyList.appendChild(card);
    }
  }

  async function loadHistory() {
    if (!bridge?.listChangeHistory || !window.__workspace?.state?.project) return;
    const result = await bridge.listChangeHistory();
    if (!result?.ok) return setStatus(result?.message || result?.error || '历史读取失败', true);
    renderHistory(result.history || []);
  }

  async function undoHistory(entry) {
    if (recoveryBlocked || historyUndoInFlight || !bridge?.undoChange || entry.status !== 'applied') return;
    const accepted = window.confirm(`撤销这次对 ${entry.files.length} 个文件的修改？\n撤销前会再次检查所有文件版本。`);
    if (!accepted) return;
    historyUndoInFlight = true;
    setBusy(true);
    startGenerationProgress(
      '正在生成跨文件修改',
      '笔触正在读取已确认范围和项目 Prompt，并生成可逐项审阅的 Diff。'
    );
    setStatus('正在检查版本并安全撤销…');
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!saved) return setStatus('当前文件未能保存，已停止撤销', true);
      const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
      window.__workspace?.beginChangesHistoryMutation?.('正在撤销并核对文件与修改历史…');
      let result = null;
      let failure = null;
      try {
        result = await bridge.undoChange(projectInstanceId, entry.id);
      } catch (error) {
        failure = error;
      }
      const reconciled = await window.__workspace?.reconcileChangesHistoryAfterMutation?.(
        'undo',
        result
      );
      if (reconciled?.canceled) return;
      if (!reconciled?.ok) {
        return setStatus(reconciled?.message || '撤销结果需要人工恢复，项目写入已暂停', true);
      }
      if (reconciled.status === 'ready') {
        const message = result?.status === 'conflict'
          ? `文件 ${result.path || ''} 已变化，未执行撤销`
          : result?.message || result?.error?.message || failure?.message || '撤销失败';
        return setStatus(message, true);
      }
      if (reconciled.status === 'zero_write_error') {
        return setStatus('撤销未写入文件，项目状态已重新核对', true);
      }
      setStatus(`已撤销 ${result?.applied?.length || reconciled.recovery?.affectedPaths?.length || entry.files.length} 个文件`);
    } finally {
      historyUndoInFlight = false;
      setBusy(false);
    }
  }

  async function propose() {
    if (recoveryBlocked) return setStatus('项目写入状态正在恢复，暂不能生成新的修改', true);
    if (activeResearchRequest) return proposeResearchCard();
    if (activePlanRequest) return proposePlanTask();
    if (activeIssueRequest) return proposeGraphIssueTask();
    const value = instruction.value.trim();
    if (!value) return setStatus('请先描述跨文件修订目标', true);
    if (!bridge?.proposeChanges) return setStatus('ChangeSet 服务尚未连接', true);
    refreshTargetPicker();
    refreshContextPicker();
    const request = currentNormalRequest();
    if (!request) return setStatus('请先明确选择至少一个可修改正文文件', true);
    if (!normalScopePlan || !window.WritCraftProjectChangesScope.sameRequest(normalScopePlan, request)) {
      if (pending) return setStatus('当前还有待审阅修改；请先应用或丢弃，再确认新范围。', true);
      renderNormalScopePlan(request);
      return { ok: true, scopePlanned: true };
    }
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: window.__workspace?.state?.project?.instanceId || null,
      startedAt: Date.now(), scope: 'multi_file', beforeChars: 0, afterChars: 0,
    };
    const transaction = proposalTransactions?.begin('normal', metric.originProjectInstanceId);
    if (!transaction) return setStatus('Changes 提案事务无效', true);
    setBusy(true);
    setStatus('范围已确认；正在读取权威快照并生成局部 Diff…');
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'normal')) {
        return;
      }
      if (!saved) return setStatus('当前文件未能保存，已停止生成修改', true);
      if (!window.WritCraftProjectChangesScope.sameRequest(normalScopePlan, currentNormalRequest())) {
        return setStatus('指令或范围已变化，未调用 AI；请重新确认。', true);
      }
      const result = await bridge.proposeChanges(metric.originProjectInstanceId, request);
      const current = await proposalTransactions.settle(transaction, result, {
        mode: 'normal',
        projectInstanceId: window.__workspace?.state?.project?.instanceId || null,
        discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId),
      });
      if (!current) return;
      if (!result?.ok) {
        recordChangeMetric('failed', metric);
        return setStatus(result?.message || result?.error || '生成失败', true);
      }
      if (!window.WritCraftProjectChangesScope.responseMatchesRequest(result, request)) {
        const leakedCapability = typeof result.changeSetId === 'string' && result.changeSetId ? result.changeSetId : null;
        if (leakedCapability && bridge?.discardChanges) {
          try { await bridge.discardChanges(metric.originProjectInstanceId, leakedCapability); } catch (_) {}
        }
        recordChangeMetric('failed', metric);
        return setStatus('Main 返回的审阅与已确认范围不一致，已安全丢弃', true);
      }
      if (result.noChanges === true) return finishNoChanges('normal', result, metric);
      if (!(await replaceGeneratedReview(result, metric))) {
        recordChangeMetric('failed', metric);
        return;
      }
      normalScopePlan = null;
      setBusy(false);
      recordChangeMetric('generated', metric);
      setStatus(`${result.fileCount || 0} 个文件待审阅 · 可写范围已由 Main 绑定`);
    } catch (error) {
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'normal')) return;
      recordChangeMetric('failed', metric);
      setStatus(`生成中断：${error.message}`, true);
    } finally {
      if (proposalTransactions.finish(transaction, window.__workspace?.state?.project?.instanceId || null)) setBusy(false);
    }
  }

  function researchSessionCurrent(session) {
    return Boolean(session && activeResearchRequest === session.owner &&
      proposalTransactions?.isCurrent?.(session.transaction, session.projectInstanceId, 'research') &&
      window.WritCraftResearchHandoffTransaction?.bindingMatches?.(
        session.binding,
        window.__workspace?.state,
        selectedTargetPaths
      ));
  }

  async function disposeResearchResult(session, result, message = '') {
    const snapshot = {
      projectInstanceId: session.projectInstanceId,
      handoff: session.request,
      changeSetId: typeof result?.changeSetId === 'string' ? result.changeSetId : null,
    };
    if (activeResearchRequest === session.owner) clearResearchRendererState(snapshot,
      message || '编辑器或修改范围已变化；旧 Research 结果已安全回收。');
    await releaseResearchOwnership(snapshot, { discardCard: false });
  }

  async function proposeResearchCard() {
    const owner = activeResearchRequest;
    const helper = window.WritCraftResearchHandoffTransaction;
    if (!owner || !helper || !bridge?.handoffResearchCard || !bridge?.ackResearchReview) {
      return { ok: false, message: 'Research→Changes 服务尚未连接' };
    }
    if (pending) return setStatus('当前 Research 提案正在审阅；请先提交或丢弃。', true);
    refreshTargetPicker();
    const request = helper.createRequest(owner.handoff, selectedTargetPaths);
    if (!request) return setStatus('请明确选择 1–8 个可修改正文文件', true);
    const transaction = proposalTransactions?.begin('research', owner.projectInstanceId);
    if (!transaction) return setStatus('Research 交接事务无效', true);
    owner.phase = 'generating';
    owner.request = request;
    renderResearchMode();
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: owner.projectInstanceId,
      action: 'research', startedAt: Date.now(), scope: 'multi_file', beforeChars: 0, afterChars: 0,
    };
    setBusy(true);
    setStatus('正在保存当前文件，并由 Main 重建证据与目标快照…');
    let session = null;
    let result = null;
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (activeResearchRequest !== owner ||
          !proposalTransactions.isCurrent(transaction, owner.projectInstanceId, 'research')) return;
      if (!saved) {
        owner.phase = 'ready';
        return setStatus('当前文件未能安全保存，Research 交接已停止', true);
      }
      const binding = helper.captureBinding(window.__workspace?.state, request.targetPaths);
      session = { owner, transaction, projectInstanceId: owner.projectInstanceId, request, binding };
      if (!binding || !researchSessionCurrent(session)) {
        await disposeResearchResult(session, null);
        return { ok: true, canceled: true };
      }
      result = await bridge.handoffResearchCard(owner.projectInstanceId, request);
      const settled = await proposalTransactions.settle(transaction, result, {
        mode: 'research',
        projectInstanceId: window.__workspace?.state?.project?.instanceId || null,
        discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId),
      });
      if (!settled || !researchSessionCurrent(session)) {
        await disposeResearchResult(session, settled ? result : null);
        return { ok: true, canceled: true, message: '旧 Research 结果已丢弃' };
      }
      if (!result?.ok) {
        owner.phase = 'ready';
        recordChangeMetric('failed', metric);
        setStatus(result?.message || result?.error || 'Research 交接失败', true);
        return { ok: false, message: result?.message || 'Research 交接失败' };
      }
      if (!helper.responseMatches(result, request)) {
        await disposeResearchResult(session, result, 'Main 返回的 Research 审阅与当前证据卡不一致，已安全回收。');
        recordChangeMetric('failed', metric);
        setStatus('Research 响应绑定不一致，已阻止审阅', true);
        return { ok: false, message: 'Research 响应绑定不一致' };
      }
      if (result.noChanges === true) {
        activeResearchRequest = null;
        renderResearchMode();
        proposalTransactions.finish(transaction, owner.projectInstanceId);
        return finishNoChanges('research', result, metric);
      }
      const reviewState = window.WritCraftChangesReviewState?.create?.(result.review);
      if (!reviewState || !researchSessionCurrent(session)) {
        await disposeResearchResult(session, result, 'Research 审阅数据无效，已安全回收。');
        return { ok: false, message: 'Research 审阅数据无效' };
      }
      // Transfer is synchronous: pending identity and its UI become active
      // before Main receives the delivery acknowledgement.
      if (!renderChangeSet(result, metric, reviewState) || pending?.id !== result.changeSetId) {
        await disposeResearchResult(session, result, 'Research 审阅未能安全接管，已回收能力。');
        return { ok: false, message: 'Research 审阅未能安全接管' };
      }
      owner.phase = 'review';
      owner.binding = binding;
      owner.changeSetId = result.changeSetId;
      renderResearchMode();
      if (!researchSessionCurrent(session) || pending?.id !== result.changeSetId) {
        await disposeResearchResult(session, result);
        return { ok: true, canceled: true };
      }
      const ack = await bridge.ackResearchReview(owner.projectInstanceId, request.cardId, result.changeSetId);
      if (!ack?.ok || !researchSessionCurrent(session) || pending?.id !== result.changeSetId) {
        await disposeResearchResult(session, result,
          ack?.ok ? '编辑器在审阅确认期间发生变化；Research 提案已回收。' : 'Research 审阅确认失败，提案已回收。');
        setStatus(ack?.message || ack?.error || 'Research 审阅确认失败', true);
        return { ok: false, message: ack?.message || 'Research 审阅确认失败' };
      }
      proposalTransactions.finish(transaction, owner.projectInstanceId);
      recordChangeMetric('generated', metric);
      setStatus(`${result.fileCount || 0} 个文件待审阅 · 来源只读 · 当前仅为预览`);
      return { ok: true, message: 'Research 已生成可审阅 Changes，正文尚未写入。' };
    } catch (error) {
      if (session) await disposeResearchResult(session, result);
      else if (activeResearchRequest === owner) owner.phase = 'ready';
      recordChangeMetric('failed', metric);
      setStatus(`Research 交接中断：${error.message}`, true);
      return { ok: false, message: error.message };
    } finally {
      if (proposalTransactions.finish(transaction, owner.projectInstanceId)) setBusy(false);
      else if (activeResearchRequest === owner && owner.phase !== 'generating') setBusy(false);
    }
  }

  async function proposePlanTask() {
    if (!activePlanRequest) return { ok: false, message: '当前没有已绑定的 Plan 任务' };
    if (!bridge?.handoffPlanTask) {
      const message = 'Plan→Changes 服务尚未连接';
      setStatus(message, true);
      return { ok: false, message };
    }
    const request = activePlanRequest;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
    const transaction = proposalTransactions?.begin('plan', projectInstanceId);
    if (!transaction) {
      const message = 'Plan 任务交接事务无效';
      setStatus(message, true);
      return { ok: false, message };
    }
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: projectInstanceId,
      action: 'plan_task', startedAt: Date.now(), scope: 'multi_file', beforeChars: 0, afterChars: 0,
    };
    setBusy(true);
    setStatus('正在由 Main 核验 Plan、目标路径与 revision…');
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'plan')) {
        return { ok: true, canceled: true, message: '旧 Plan 任务已取消' };
      }
      if (!saved) {
        const message = '当前文件未能安全保存，Plan 交接已停止';
        setStatus(message, true);
        return { ok: false, message };
      }
      // The payload is intentionally identifier-only. Instruction, target
      // paths and revisions are recovered from Main's canonical plan record.
      const result = await bridge.handoffPlanTask(metric.originProjectInstanceId, request);
      const current = await proposalTransactions.settle(transaction, result, {
        mode: 'plan',
        projectInstanceId: window.__workspace?.state?.project?.instanceId || null,
        discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId),
      });
      if (!current) return { ok: true, canceled: true, message: '旧 Plan 任务结果已丢弃' };
      if (!result?.ok) {
        recordChangeMetric('failed', metric);
        const message = result?.message || result?.error || 'Plan 任务交接失败';
        setStatus(message, true);
        return { ok: false, message };
      }
      if (result.noChanges === true) {
        const provenance = result.provenance;
        if (provenance?.schema !== 'writcraft.plan-task-handoff/v1' ||
            provenance?.planId !== request.planId || provenance?.taskId !== request.taskId) {
          recordChangeMetric('failed', metric);
          const message = 'Plan 无变更响应与当前任务绑定不一致，已阻止处理';
          setStatus(message, true);
          return { ok: false, message };
        }
        return finishNoChanges('plan', result, metric);
      }
      if (!(await replaceGeneratedReview(result, metric))) {
        recordChangeMetric('failed', metric);
        return { ok: false, message: '旧审阅未能安全释放，新提案已取消' };
      }
      recordChangeMetric('generated', metric);
      const paths = (result.provenance?.targets || []).map(target => target.path).join('、');
      const message = `${result.fileCount || 0} 个文件待审阅 · Main 已绑定 ${paths || '计划目标'}`;
      setStatus(message);
      return { ok: true, message: 'Plan 任务已生成可审阅 Changes，正文尚未写入。' };
    } catch (error) {
      const current = proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'plan');
      if (!current) return { ok: true, canceled: true, message: '旧 Plan 任务已取消' };
      recordChangeMetric('failed', metric);
      const message = `Plan 任务生成中断：${error.message}`;
      setStatus(message, true);
      return { ok: false, message };
    } finally {
      if (proposalTransactions.finish(transaction, window.__workspace?.state?.project?.instanceId || null)) setBusy(false);
    }
  }

  async function proposeChapter() {
    if (pending) return setStatus('当前还有待审阅 Changes；请先应用或丢弃，再生成当前章节。', true);
    const value = instruction.value.trim();
    const targetPath = window.__workspace?.getCurrentPath?.();
    if (!value) return setStatus('请先描述章节生成目标', true);
    const normalizedTarget = String(targetPath || '').toLocaleLowerCase('en-US');
    if (!targetPath || normalizedTarget === 'edit.md' || normalizedTarget.startsWith('references/') ||
        normalizedTarget.startsWith('sources/') || normalizedTarget.startsWith('.writcraft/')) {
      return setStatus('请先打开一个可写的正文 Markdown 文件', true);
    }
    if (!bridge?.proposeChapter) return setStatus('章节 Composer 尚未连接', true);
    const contextPaths = refreshContextPicker();
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: window.__workspace?.state?.project?.instanceId || null,
      startedAt: Date.now(), scope: 'file', beforeChars: 0, afterChars: 0,
    };
    const request = {
      schema: 'writcraft.chapter-generation-request/v1',
      targetPath,
      instruction: value,
      contextPaths,
    };
    const chapterSession = window.WritCraftChangesProposalTransaction?.beginChapter?.(
      proposalTransactions, metric.originProjectInstanceId, request, pending
    );
    if (!chapterSession) return setStatus('章节提案事务无效或已有待审阅 Changes', true);
    const transaction = chapterSession.transaction;
    const currentBinding = () => ({
      projectInstanceId: window.__workspace?.state?.project?.instanceId || null,
      pendingReview: pending,
      request: {
        schema: request.schema,
        targetPath: window.__workspace?.getCurrentPath?.() || '',
        instruction: instruction.value.trim(),
        contextPaths: [...selectedContextPaths],
      },
    });
    setBusy(true, 'chapter');
    const contextLabel = contextPaths.length ? `，并参考 ${contextPaths.length} 个文件` : '';
    setStatus(`正在依据 edit.md${contextLabel} 生成 ${targetPath} 的完整提案…`);
    startGenerationProgress(
      `正在生成 ${targetPath}`,
      `笔触正在依据 edit.md${contextLabel}组织完整章节；完成后会进入逐项审阅，不会自动写入。`
    );
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!window.WritCraftChangesProposalTransaction.isChapterCurrent(
        proposalTransactions, chapterSession, currentBinding()
      )) {
        return;
      }
      if (!saved) return setStatus('当前文件未能保存，已停止章节生成', true);
      const result = await bridge.proposeChapter(metric.originProjectInstanceId, chapterSession.request);
      const current = await window.WritCraftChangesProposalTransaction.settleChapter(
        proposalTransactions, chapterSession, result, currentBinding(), {
        getCurrent: currentBinding,
        discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId),
        }
      );
      if (!current) return;
      if (!window.WritCraftChangesProposalTransaction.isChapterCurrent(
        proposalTransactions, chapterSession, currentBinding()
      )) {
        await window.WritCraftChangesProposalTransaction.releaseStaleChapterResult(
          proposalTransactions,
          chapterSession,
          result,
          currentBinding(),
          { discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId) }
        );
        return;
      }
      if (!result?.ok) {
        recordChangeMetric('failed', metric);
        return setStatus(result?.message || result?.error || '章节生成失败', true);
      }
      const classified = window.WritCraftChangesProposalTransaction.classifyChapterResult(
        result,
        chapterSession.request
      );
      if (!classified.ok) {
        if (classified.capabilityId && bridge?.discardChanges) {
          const discarded = await window.WritCraftChangesProposalTransaction.discardChapterCapability(
            (projectInstanceId, changeSetId) => bridge.discardChanges(projectInstanceId, changeSetId),
            metric.originProjectInstanceId,
            classified.capabilityId
          );
          if (!discarded) {
            if (!window.WritCraftChangesProposalTransaction.isChapterCurrent(
              proposalTransactions, chapterSession, currentBinding()
            )) return;
            recordChangeMetric('failed', metric);
            return setStatus('无效章节响应的审阅能力回收未获确认；请切换项目或重启笔触后再试。', true);
          }
        }
        if (!window.WritCraftChangesProposalTransaction.isChapterCurrent(
          proposalTransactions, chapterSession, currentBinding()
        )) return;
        recordChangeMetric('failed', metric);
        return setStatus(classified.reason === 'INVALID_PROVENANCE'
          ? '章节生成响应与当前目标绑定不一致，已阻止处理'
          : '章节生成响应不符合 no-op/review 安全契约，已阻止处理', true);
      }
      if (classified.kind === 'no_changes') return await finishNoChanges('chapter', result, metric, {
        isCurrent: () => window.WritCraftChangesProposalTransaction.isChapterCurrent(
          proposalTransactions, chapterSession, currentBinding()
        ),
      });
      await replaceGeneratedChapterReview(result, metric, chapterSession, currentBinding, contextPaths);
      return;
    } catch (error) {
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'chapter')) return;
      recordChangeMetric('failed', metric);
      setStatus(`章节生成中断：${error.message}`, true);
    } finally {
      const finish = window.WritCraftChangesProposalTransaction.finishChapter(
        proposalTransactions,
        chapterSession,
        window.__workspace?.state?.project?.instanceId || null
      );
      if (finish.releaseBusy) {
        stopGenerationProgress();
        setBusy(false);
      }
    }
  }

  function settleRecoveredReviewState(message) {
    proposalTransactions?.invalidate?.();
    pending = null;
    confirmationMode = null;
    activePlanRequest = null;
    activeIssueRequest = null;
    activeResearchRequest = null;
    renderPlanMode();
    renderIssueMode();
    renderResearchMode();
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    preview.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'tree-empty',
      textContent: message,
    }));
  }

  async function applySelected() {
    if (recoveryBlocked) return setStatus('项目写入状态正在恢复，暂不能应用修改', true);
    if (reviewCommitInFlight) return;
    if (onboardingMetricSettlement) return setStatus('项目文件结构已变化，正在回收旧项目卡授权', true);
    if (confirmationMode) {
      if (!bridge?.confirmOnboardingFiles) return setStatus('初始文件确认服务未连接', true);
      const activeConfirmation = confirmationMode;
      const selectedPaths = [...preview.querySelectorAll('[data-onboarding-path]:checked')]
        .map(box => box.dataset.onboardingPath);
      reviewCommitInFlight = true;
      setBusy(true);
      setStatus('正在保存当前文件并创建所选文件…');
      let commitAcknowledged = false;
      let committedFiles = null;
      try {
        const saved = await window.__workspace.persistCurrent(true);
        if (!saved) return setStatus('当前文件未能保存，已停止初始文件确认', true);
        const result = await bridge.confirmOnboardingFiles(
          activeConfirmation.projectInstanceId,
          activeConfirmation.token,
          activeConfirmation.proposalDigest,
          selectedPaths
        );
        confirmationMode = null;
        await settleOnboardingMetric(result?.ok || !activeConfirmation.editNoChanges ? 'accepted' : 'discarded', activeConfirmation.metric);
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
        if (!result?.ok) {
          preview.replaceChildren(Object.assign(document.createElement('div'), {
            className: 'tree-empty',
            textContent: '本次确认按零部分创建处理：没有保留可重试令牌。请重新整理项目卡后再创建初始文件。',
          }));
          setStatus(result?.message || '初始文件确认失败；零部分创建，需重新整理项目卡', true);
          return;
        }
        commitAcknowledged = true;
        committedFiles = validateConfirmedFiles(result.files, selectedPaths);
        if (!committedFiles) {
          throw new Error('Main 返回的已创建文件清单与确认选择不一致');
        }
        const mainRefreshRequired = result.refreshRequired === true ||
          (typeof result.warning === 'string' && result.warning.length > 0);
        if (mainRefreshRequired) {
          const knownPaths = committedFiles.map(file => file.path);
          preview.replaceChildren(Object.assign(document.createElement('div'), {
            className: 'tree-empty',
            textContent: knownPaths.length
              ? `Main 已确认创建：${knownPaths.join('、')}。Main 状态刷新异常，请重新打开当前项目核对文件；不要重复确认。`
              : 'Main 已确认本次提交，但状态刷新异常。请重新打开当前项目核对；不要重复确认。',
          }));
          setStatus('初始文件已提交，但 Main 状态刷新异常；请重新打开当前项目', true);
          return;
        }
        await refreshCommittedEdit();
        const createdCount = committedFiles.length;
        preview.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'tree-empty',
          textContent: createdCount
            ? `已创建 ${createdCount} 个初始文件；edit.md 已重新聚焦。`
            : '没有选择初始文件；edit.md 保持为当前项目说明。',
        }));
        setStatus(createdCount ? `已确认并创建 ${createdCount} 个初始文件` : '项目卡已完成，没有创建初始文件');
      } catch (error) {
        confirmationMode = null;
        await settleOnboardingMetric(activeConfirmation.editNoChanges ? 'discarded' : 'accepted', activeConfirmation.metric);
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
        if (commitAcknowledged) {
          const knownPaths = committedFiles?.map(file => file.path) || [];
          preview.replaceChildren(Object.assign(document.createElement('div'), {
            className: 'tree-empty',
            textContent: knownPaths.length
              ? `Main 已确认创建：${knownPaths.join('、')}。界面刷新失败，请重新打开当前项目核对文件。`
              : 'Main 已确认提交，但返回的文件清单无法安全核对。请重新打开当前项目查看实际文件；不要重复确认。',
          }));
          setStatus(`初始文件已提交，但界面刷新未完成：${error.message}`, true);
        } else {
          preview.replaceChildren(Object.assign(document.createElement('div'), {
            className: 'tree-empty',
            textContent: '确认调用失败且令牌已终结。按零部分创建处理；请重新整理项目卡后再试。',
          }));
          setStatus(`初始文件确认失败：${error.message}；零部分创建，需重新整理`, true);
        }
      } finally {
        reviewCommitInFlight = false;
        setBusy(false);
      }
      return;
    }
    if (!pending || !bridge?.applyChanges) return;
    const isOnboardingProposal = pending.proposalKind === 'onboarding_v2';
    const isEditPromptProposal = isOnboardingProposal || pending.proposalKind === 'edit_prompt_repair';
    const onboardingMetric = isOnboardingProposal ? pending.metric || null : null;
    const selectedInitialFiles = new Set([...preview.querySelectorAll('[data-onboarding-path]:checked')]
      .map(box => box.dataset.onboardingPath));
    const decisionCounts = window.WritCraftChangesReviewState?.counts?.(pending.reviewState);
    if (pending.requireCompleteDecision === true && decisionCounts?.pending) {
      return setStatus('请先处理全部修改块；图谱问题修复不会保留未决定的残余提案', true);
    }
    const decision = window.WritCraftChangesReviewState?.toDecision?.(pending.reviewState);
    if (!decision) return setStatus('请先接受或拒绝至少一个修改块', true);
    reviewCommitInFlight = true;
    setBusy(true);
    setStatus('正在核验修改块 ID、文件版本与审阅策略…');
    let committedResult = null;
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!saved) return setStatus('当前文件未能保存，已停止应用', true);
      if (pending?.proposalKind === 'research_card' && activeResearchRequest &&
          !window.WritCraftResearchHandoffTransaction?.bindingMatches?.(
            activeResearchRequest.binding,
            window.__workspace?.state,
            activeResearchRequest.request?.targetPaths || []
          )) {
        const snapshot = snapshotResearchOwnership();
        clearResearchRendererState(snapshot, '编辑器或目标范围已变化；Research 提案已取消，未写入磁盘。');
        await releaseResearchOwnership(snapshot, { discardCard: false });
        return setStatus('当前草稿与 Research 审阅绑定不一致，已阻止应用', true);
      }
      const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
      window.__workspace?.beginChangesHistoryMutation?.('正在应用并核对文件与修改历史…');
      let result = null;
      let mutationFailure = null;
      try {
        result = await bridge.applyChanges(projectInstanceId, decision);
      } catch (error) {
        mutationFailure = error;
      }
      const reconciled = await window.__workspace?.reconcileChangesHistoryAfterMutation?.(
        'apply',
        result
      );
      if (reconciled?.canceled) return;
      if (!reconciled?.ok) {
        if (reconciled?.recovery) {
          settleRecoveredReviewState(
            '旧审阅授权已经终结。请先完成上方恢复，再根据恢复后的正文重新生成修改。'
          );
        }
        return setStatus(
          reconciled?.message || mutationFailure?.message || '应用结果需要恢复核对，项目写入已暂停',
          true
        );
      }
      if (reconciled.status === 'ready') {
        const message = result?.status === 'conflict'
          ? `文件 ${result.path || ''} 已变化，ChangeSet 未应用`
          : result?.message || result?.error?.message || mutationFailure?.message || '应用失败';
        return setStatus(message, true);
      }
      if (!reconciled.mutationTrusted) {
        const applied = ['applied', 'reviewed'].includes(reconciled.status);
        settleRecoveredReviewState(
          applied
            ? '操作响应曾中断；WritCraft 已从磁盘和修改历史恢复真实结果。旧的剩余审阅或初始文件确认不会恢复，请重新生成。'
            : '已确认本次操作没有完整写入；旧审阅授权已终结，请根据当前正文重新生成修改。'
        );
        return setStatus(reconciled.message, !applied);
      }
      if (reconciled.status === 'zero_write_error') {
        settleRecoveredReviewState(
          '已确认本次操作没有写入项目；原审阅授权已安全终结，请重新生成修改。'
        );
        return setStatus('修改未写入磁盘，项目状态已重新核对', true);
      }
      const authoritativeReloaded = reconciled.authoritativeReloaded === true;
      if (!result?.ok) {
        const message = result?.status === 'conflict'
          ? `文件 ${result.path || ''} 已变化，ChangeSet 未应用`
          : result?.message || result?.error || '应用失败';
        if (pending?.proposalKind === 'research_card' && activeResearchRequest) {
          const snapshot = snapshotResearchOwnership();
          clearResearchRendererState(snapshot, 'Research 应用授权已终结；请回到 Sources 重新核对证据。');
          await releaseResearchOwnership(snapshot, { discardCard: false });
        }
        return setStatus(message, true);
      }
      committedResult = result;
      const appliedCount = result.applied?.length || 0;
      const completedPlan = appliedCount > 0 && completePlanModeAfterWrite();
      if (result.residualUnavailable === true) {
        const snapshot = snapshotResearchOwnership();
        clearResearchRendererState(snapshot,
          appliedCount
            ? '本轮 Research 修改已经提交，但剩余建议未能安全保留。请刷新项目后重新 Research；不要重复提交旧审阅。'
            : '本轮 Research 审阅决定已经记录，但剩余建议未能安全保留。请重新 Research；不要重复提交旧审阅。');
        if (appliedCount && !authoritativeReloaded) {
          await window.__workspace.refreshTree();
          await window.__workspace.reloadCurrent();
        }
        if (!authoritativeReloaded) await loadHistory();
        setStatus('Research 提交已生效；剩余审阅已回收，请重新 Research', true);
        return;
      }
      if (result.review) {
        const nextState = window.WritCraftChangesReviewState?.create?.(result.review);
        if (!nextState) throw new Error('Main 返回的剩余审阅数据无效');
        pending.id = nextState.review.changeSetId;
        pending.reviewState = nextState;
        pending.provenance = result.provenance || pending.provenance;
        renderPendingReview();
        if (activePlanRequest) renderPlanMode(pending.provenance);
        const researchResidual = pending.proposalKind === 'research_card' && activeResearchRequest
          ? activeResearchRequest : null;
        if (researchResidual) researchResidual.phase = 'refreshing';
        if (appliedCount && !authoritativeReloaded) {
          await window.__workspace.refreshTree();
          await window.__workspace.reloadCurrent();
        }
        if (researchResidual && pending?.proposalKind === 'research_card' && activeResearchRequest === researchResidual) {
          researchResidual.changeSetId = pending.id;
          researchResidual.binding = window.WritCraftResearchHandoffTransaction?.captureBinding?.(
            window.__workspace?.state,
            researchResidual.request?.targetPaths || []
          );
          researchResidual.phase = 'review';
        }
        if (!authoritativeReloaded) await loadHistory();
        setStatus(completedPlan
          ? `Plan 任务已写入正文；原 Plan 已完成，请处理剩余 ${result.remainingHunkCount || nextState.review.totalHunks} 个修改块，后续任务请新建 Plan。`
          : `本轮已接受 ${result.acceptedHunkCount || 0}、拒绝 ${result.rejectedHunkCount || 0}；剩余 ${result.remainingHunkCount || nextState.review.totalHunks} 个待决定`);
        return;
      }
      const completedIssue = completeIssueModeAfterReview();
      const completedResearch = pending?.proposalKind === 'research_card' && Boolean(activeResearchRequest);
      if (!isOnboardingProposal) {
        if (appliedCount) recordChangeMetric('accepted');
        else recordChangeMetric('rejected');
      } else if (!appliedCount) {
        await settleOnboardingMetric('rejected', onboardingMetric);
      }
      pending = null;
      if (completedResearch) {
        activeResearchRequest = null;
        renderResearchMode();
        renderPlanMode();
        renderIssueMode();
      }
      if (isOnboardingProposal && result.onboardingConfirmation) {
        if (appliedCount) await refreshCommittedEdit({ authoritativeReloaded });
        if (!enterOnboardingConfirmation(result.onboardingConfirmation, selectedInitialFiles, {
          projectInstanceId,
          editNoChanges: false,
          metric: onboardingMetric,
        })) throw new Error('Main 返回的初始文件确认数据无效');
        return;
      }
      if (isOnboardingProposal && appliedCount &&
          (result.confirmationUnavailable || !result.onboardingConfirmation)) {
        let refreshWarning = '';
        try { await refreshCommittedEdit({ authoritativeReloaded }); }
        catch (error) { refreshWarning = ` 界面刷新未完成：${error.message}；请重新打开当前项目。`; }
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
        preview.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'tree-empty',
          textContent: 'edit.md 已安全写入磁盘，但初始文件确认授权未能建立，因此没有创建任何初始文件。请重新整理项目卡后再试。',
        }));
        await settleOnboardingMetric('accepted', onboardingMetric);
        setStatus(`edit.md 已落盘；初始文件未创建，需重新整理项目卡。${refreshWarning}`, true);
        return;
      }
      applyButton.hidden = true;
      discardButton.hidden = true;
      if (isEditPromptProposal && appliedCount) await refreshCommittedEdit({ authoritativeReloaded });
      else {
        if (appliedCount && !authoritativeReloaded) {
          await window.__workspace.refreshTree();
          await window.__workspace.reloadCurrent();
        }
        if (!authoritativeReloaded) await loadHistory();
      }
      discardButton.textContent = '丢弃';
      resetCommitControls();
      setStatus(completedResearch
        ? appliedCount
          ? `Research 修改已安全应用 ${appliedCount} 个文件；来源保持只读。`
          : `已拒绝 ${result.rejectedHunkCount || 0} 个 Research 修改块，项目文件没有变化`
        : completedIssue
        ? appliedCount
          ? '星图问题修复已安全写入；请重新分析星图确认问题是否消除。'
          : `已完整拒绝 ${result.rejectedHunkCount || 0} 个星图修复块，项目文件没有变化`
        : completedPlan
        ? 'Plan 任务已安全写入并完成；如需继续规划，请新建 Plan。'
        : !appliedCount
        ? `已记录拒绝 ${result.rejectedHunkCount || 0} 个修改块，项目文件没有变化`
        : isEditPromptProposal
        ? '已更新磁盘中的 edit.md；没有创建初始文件'
        : `已安全应用 ${appliedCount} 个文件`);
    } catch (error) {
      if (isOnboardingProposal && (committedResult?.applied?.length || 0) > 0) {
        const abandonedConfirmation = committedResult?.onboardingConfirmation;
        if (typeof abandonedConfirmation?.token === 'string' && abandonedConfirmation.token) {
          if (confirmationMode?.token === abandonedConfirmation.token) confirmationMode = null;
          await releaseAbandonedOnboardingConfirmation(
            onboardingMetric?.originProjectInstanceId || null,
            abandonedConfirmation.token
          );
        }
        await settleOnboardingMetric('accepted', onboardingMetric);
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
      }
      if (committedResult && activeResearchRequest) {
        const snapshot = snapshotResearchOwnership();
        clearResearchRendererState(snapshot,
          'Research 修改已经提交，但界面刷新未完成；剩余审阅已回收，请重新打开项目核对。');
        await releaseResearchOwnership(snapshot, { discardCard: false });
      }
      if (committedResult && pending?.id === decision.changeSetId) {
        pending = null;
        applyButton.hidden = true;
        discardButton.hidden = true;
      }
      setStatus(committedResult
        ? `修改已经提交，但界面刷新未完成：${error.message}。请重新打开当前项目查看最新文件。`
        : `应用中断：${error.message}`, true);
    } finally {
      reviewCommitInFlight = false;
      setBusy(false);
    }
  }

  async function discard() {
    if (recoveryBlocked || reviewCommitInFlight) return;
    if (confirmationMode) {
      const activeConfirmation = confirmationMode;
      if (!bridge?.discardOnboardingConfirmation) return setStatus('初始文件确认释放服务未连接', true);
      reviewCommitInFlight = true;
      setBusy(true);
      try {
        const result = await bridge.discardOnboardingConfirmation(
          activeConfirmation.projectInstanceId,
          activeConfirmation.token
        );
        if (result?.ok === false) return setStatus(result.message || '未能释放初始文件确认，请重试', true);
      } catch (error) {
        return setStatus(`未能释放初始文件确认：${error.message}`, true);
      } finally {
        reviewCommitInFlight = false;
        setBusy(false);
      }
      confirmationMode = null;
      await settleOnboardingMetric(activeConfirmation.editNoChanges ? 'discarded' : 'accepted', activeConfirmation.metric);
      preview.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'tree-empty', textContent: '已放弃初始文件创建；edit.md 的结果保持不变。',
      }));
      applyButton.hidden = true;
      discardButton.hidden = true;
      resetCommitControls();
      setStatus('已结束项目卡确认，没有创建初始文件');
      return;
    }
    if (pending?.proposalKind === 'research_card' && activeResearchRequest) {
      const snapshot = snapshotResearchOwnership();
      recordChangeMetric('discarded');
      clearResearchRendererState(snapshot, 'Research 提案与证据卡已丢弃，项目文件没有变化。');
      await releaseResearchOwnership(snapshot, { discardCard: true });
      setStatus('Research 提案已丢弃');
      return;
    }
    if (pending?.proposalKind === 'onboarding_v2') {
      const active = pending;
      const released = await releaseOnboardingReview(active);
      if (!released) {
        setStatus(active.capabilityReleased
          ? '项目卡授权已释放，但终态指标尚未落盘；请重试后再切换项目'
          : '项目卡审阅授权未能安全释放；请重试', true);
        return;
      }
      if (pending === active) pending = null;
      preview.innerHTML = '<div class="tree-empty">待审阅项目卡已丢弃，项目文件没有变化。</div>';
      applyButton.hidden = true;
      discardButton.hidden = true;
      resetCommitControls();
      setStatus('尚无待审阅修改');
      return;
    }
    if (pending?.id && bridge?.discardChanges) {
      await bridge.discardChanges(window.__workspace?.state?.project?.instanceId || null, pending.id);
    }
    recordChangeMetric('discarded');
    completeIssueModeAfterReview();
    pending = null;
    preview.innerHTML = '<div class="tree-empty">待审阅修改已丢弃，项目文件没有变化。</div>';
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    setStatus('尚无待审阅修改');
  }

  function invalidatePendingForFileLifecycle(event) {
    if (activeResearchRequest) {
      void leaveResearchMode({
        message: '项目文件结构已变化；Research 交接已取消，请重新核对证据与目标。',
        status: '项目文件结构已变化，Research 交接已失效',
      });
      return;
    }
    invalidateNormalScopePlan('项目文件结构已变化，普通 Changes 范围需要重新确认。');
    proposalTransactions?.invalidate();
    refreshTargetPicker();
    refreshContextPicker();
    const invalidatedConfirmation = Boolean(confirmationMode);
    if (confirmationMode) {
      const stale = confirmationMode;
      confirmationMode = null;
      const metricOutcome = stale.editNoChanges ? 'discarded' : 'accepted';
      const settlement = (async () => {
        try { await bridge?.discardOnboardingConfirmation?.(stale.projectInstanceId, stale.token); }
        catch (_) {}
        return settleOnboardingMetric(metricOutcome, stale.metric);
      })();
      const trackedSettlement = settlement.finally(() => {
        if (onboardingMetricSettlement === trackedSettlement) onboardingMetricSettlement = null;
      });
      onboardingMetricSettlement = trackedSettlement;
    }
    if (!pending) {
      if (invalidatedConfirmation) {
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
        preview.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'tree-empty', textContent: '项目文件结构已变化。旧初始文件确认已释放，请重新整理项目卡。',
        }));
        setStatus('项目文件结构已变化，旧初始文件确认已失效');
      }
      return;
    }
    if (pending.proposalKind === 'onboarding_v2') {
      const stale = pending;
      stale.lifecycleInvalidated = true;
      applyButton.hidden = true;
      discardButton.hidden = true;
      resetCommitControls();
      preview.innerHTML = '<div class="tree-empty">项目文件结构已变化。正在回收旧项目卡审阅，完成前不会切换项目。</div>';
      setStatus('项目文件结构已变化，正在安全释放旧项目卡');
      const settlement = releaseOnboardingReview(stale).then(released => {
        if (released && pending === stale) pending = null;
        return released;
      });
      const trackedSettlement = settlement.finally(() => {
        if (onboardingMetricSettlement === trackedSettlement) onboardingMetricSettlement = null;
      });
      onboardingMetricSettlement = trackedSettlement;
      return;
    }
    completeIssueModeAfterReview();
    pending = null;
    preview.innerHTML = '<div class="tree-empty">项目文件结构已变化。旧提案已失效，请基于当前文件重新生成。</div>';
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    setStatus(event?.detail?.kind === 'trash' ? '文件已移到回收区，旧提案已失效' : '文件路径已变化，旧提案已失效');
  }

  activityButton?.addEventListener('click', openPanel);
  document.getElementById('changes-close')?.addEventListener('click', closePanel);
  proposeButton?.addEventListener('click', propose);
  chapterButton?.addEventListener('click', proposeChapter);
  applyButton?.addEventListener('click', applySelected);
  discardButton?.addEventListener('click', discard);
  instruction?.addEventListener('input', () => {
    if (activePlanRequest || activeIssueRequest) return;
    invalidateEditableProposal('指令已变化，旧生成请求已取消。');
    invalidateNormalScopePlan('指令已变化，需要重新确认可修改范围。');
  });
  document.addEventListener('writcraft:project-entered', () => {
    const stalePending = pending;
    const staleConfirmation = confirmationMode;
    const staleResearch = snapshotResearchOwnership();
    confirmationMode = null;
    if (stalePending?.id && stalePending.proposalKind !== 'research_card') {
      const originProjectInstanceId = stalePending.metric?.originProjectInstanceId || null;
      void Promise.resolve(bridge?.discardChanges?.(originProjectInstanceId, stalePending.id)).catch(() => {});
    }
    if (staleConfirmation) {
      void Promise.resolve(bridge?.discardOnboardingConfirmation?.(
        staleConfirmation.projectInstanceId,
        staleConfirmation.token
      )).catch(() => {});
    }
    pending = null;
    proposalTransactions?.invalidate();
    activePlanRequest = null;
    activeIssueRequest = null;
    activeResearchRequest = null;
    normalScopePlan = null;
    stopGenerationProgress();
    selectedTargetPaths = [];
    targetSelectionTouched = false;
    instruction.value = '';
    renderPlanMode();
    renderIssueMode();
    renderResearchMode();
    setBusy(false);
    applyButton.hidden = true;
    discardButton.hidden = true;
    resetCommitControls();
    preview.replaceChildren(Object.assign(document.createElement('div'), { className: 'tree-empty', textContent: '新项目尚无待审阅修改。' }));
    refreshContextPicker(true);
    refreshTargetPicker(true);
    loadMetrics();
    if (staleResearch) void releaseResearchOwnership(staleResearch, { discardCard: false });
  });
  document.addEventListener('writcraft:ai-metrics-changed', loadMetrics);
  document.addEventListener('writcraft:tree-changed', () => {
    const beforeResearchTargets = window.WritCraftResearchHandoffTransaction?.targetFingerprint?.(selectedTargetPaths) || '';
    invalidateEditableProposal('项目文件树已变化，旧生成请求已取消。');
    invalidateNormalScopePlan('项目文件树已变化，需要重新确认修改范围。');
    refreshTargetPicker();
    refreshContextPicker();
    const afterResearchTargets = window.WritCraftResearchHandoffTransaction?.targetFingerprint?.(selectedTargetPaths) || '';
    if (['generating', 'review'].includes(activeResearchRequest?.phase) && beforeResearchTargets !== afterResearchTargets) {
      void leaveResearchMode({
        message: '可修改目标已变化；Research 提案已取消。',
        status: 'Research 目标范围已变化',
      });
    }
  });
  document.addEventListener('writcraft:current-file-changed', () => {
    invalidateEditableProposal('当前文件已切换，旧生成请求已取消。');
    invalidateNormalScopePlan('当前文件已切换，需要重新确认修改范围。');
    refreshTargetPicker();
    refreshContextPicker();
    if (['generating', 'review'].includes(activeResearchRequest?.phase)) {
      void leaveResearchMode({
        message: '当前文件已切换；Research 提案已取消。',
        status: 'Research 编辑器绑定已变化',
      });
    }
  });
  document.addEventListener('writcraft:file-lifecycle-changed', invalidatePendingForFileLifecycle);
  document.getElementById('editor')?.addEventListener('input', () => {
    if (!['generating', 'review'].includes(activeResearchRequest?.phase)) return;
    const currentPath = window.__workspace?.getCurrentPath?.() || '';
    if (!activeResearchRequest.request?.targetPaths?.includes(currentPath)) return;
    void leaveResearchMode({
      message: '目标正文在 Research 事务期间被编辑；旧提案已取消，磁盘未被 AI 覆盖。',
      status: '目标草稿已变化，Research 提案已取消',
    });
  });
  window.addEventListener('unload', () => {
    const snapshot = snapshotResearchOwnership();
    if (snapshot) void releaseResearchOwnership(snapshot, { discardCard: false });
  }, { once: true });

  function canStartOnboarding() {
    if (onboardingMetricSettlement || unsettledOnboardingMetric || unsettledOnboardingConfirmationRelease ||
        pending || confirmationMode || activePlanRequest || activeIssueRequest || activeResearchRequest) {
      return { ok: false, message: confirmationMode
        ? '请先确认或放弃当前初始文件创建'
        : onboardingMetricSettlement || unsettledOnboardingMetric || unsettledOnboardingConfirmationRelease
          ? '正在结算上一轮项目卡，请稍候'
        : '请先处理或丢弃当前 Changes 审阅' };
    }
    return { ok: true };
  }

  async function discardPending() {
    if (reviewCommitInFlight) return false;
    if (unsettledOnboardingConfirmationRelease) {
      const active = unsettledOnboardingConfirmationRelease;
      const released = await releaseAbandonedOnboardingConfirmation(active.projectInstanceId, active.token);
      if (!released) return false;
    }
    if (onboardingMetricSettlement) {
      try {
        await onboardingMetricSettlement;
      } catch (_) {
        // The retry below remains bound to the original sanitized metric.
      }
    }
    if (unsettledOnboardingMetric) {
      const unsettled = unsettledOnboardingMetric;
      const recorded = await recordChangeMetric(unsettled.outcome, unsettled.metric);
      if (!recorded) return false;
      if (unsettledOnboardingMetric === unsettled) unsettledOnboardingMetric = null;
    }
    if (confirmationMode) {
      const active = confirmationMode;
      if (!bridge?.discardOnboardingConfirmation) return false;
      reviewCommitInFlight = true;
      setBusy(true);
      try {
        const result = await bridge.discardOnboardingConfirmation(active.projectInstanceId, active.token);
        if (result?.ok === false) return false;
        const settled = await settleOnboardingMetric(active.editNoChanges ? 'discarded' : 'accepted', active.metric);
        if (active.metric?.operationId && settled !== true) return false;
        confirmationMode = null;
        applyButton.hidden = true;
        discardButton.hidden = true;
        resetCommitControls();
        return true;
      } catch (_) {
        return false;
      } finally {
        reviewCommitInFlight = false;
        setBusy(false);
      }
    }
    if (pending?.proposalKind === 'onboarding_v2') {
      const active = pending;
      const settled = await releaseOnboardingReview(active);
      if (!settled) return false;
      if (pending === active) pending = null;
      applyButton.hidden = true;
      discardButton.hidden = true;
      resetCommitControls();
      return true;
    }
    return true;
  }

  function acceptProposal(result, options = {}) {
    if (pending || confirmationMode || activePlanRequest || activeIssueRequest || activeResearchRequest) {
      openPanel();
      const availability = canStartOnboarding();
      setStatus(availability.message, true);
      return availability;
    }
    invalidateEditableProposal();
    invalidateNormalScopePlan();
    openPanel();
    const onboardingAttempt = result?.proposalKind === 'onboarding_v2' &&
      /^[a-f0-9]{32}$/i.test(options?.onboardingAttempt?.operationId || '')
      ? options.onboardingAttempt : null;
    const metric = {
      operationId: onboardingAttempt?.operationId || window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: window.__workspace?.state?.project?.instanceId || null,
      action: result?.proposalKind === 'onboarding_v2' ? 'onboarding' : 'changeset',
      startedAt: Number.isSafeInteger(onboardingAttempt?.startedAt) ? onboardingAttempt.startedAt : Date.now(),
      scope: 'project', beforeChars: 0, afterChars: 0,
    };
    if (result?.noChanges === true && result?.onboardingConfirmation) {
      const entered = enterOnboardingConfirmation(result.onboardingConfirmation, null, {
        projectInstanceId: metric.originProjectInstanceId,
        editNoChanges: true,
        metric,
      });
      if (!entered) {
        setStatus('Main 返回的初始文件确认数据无效，已阻止进入确认', true);
        return { ok: false, message: '初始文件确认数据无效' };
      }
      return { ok: true, mode: 'onboarding_confirmation' };
    }
    if (result?.proposalKind === 'onboarding_v2' && result?.onboardingConfirmation) {
      setStatus('项目卡提案提前携带创建令牌，已阻止进入审阅', true);
      return { ok: false, message: '项目卡两阶段契约无效' };
    }
    if (!renderChangeSet(result, metric)) return { ok: false, message: 'Changes 审阅数据无效' };
    setStatus(result?.proposalKind === 'onboarding_v2'
      ? '项目卡已整理：先审阅 edit.md；当前选择不会创建文件'
      : `${result.fileCount || 0} 个文件待审阅`);
    return { ok: true, mode: 'review' };
  }

  function openWithInstruction(value) {
    openPanel();
    if (activePlanRequest || activeIssueRequest || activeResearchRequest) {
      setStatus(activePlanRequest
        ? '当前仍绑定 Plan 任务；请先点击“脱离 Plan”再使用自由指令。'
        : activeIssueRequest
          ? '当前仍绑定星图问题；请先退出专用审阅再使用自由指令。'
          : '当前仍绑定 Research 证据卡；请先退出专用模式再使用自由指令。', true);
      return;
    }
    invalidateEditableProposal();
    invalidateNormalScopePlan();
    instruction.value = String(value || '').slice(0, 2000);
    instruction.focus();
    setStatus('一致性问题已带入；确认目标后生成可审阅 Changes');
  }

  async function openResearchCard(value) {
    const handoff = window.WritCraftResearchHandoffTransaction?.normalizeCardHandoff?.(value);
    const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
    if (!handoff || !projectInstanceId || !bridge?.resolveResearchCard) {
      return { ok: false, message: 'Research 证据卡请求无效或服务未连接' };
    }
    if (pending || confirmationMode || activePlanRequest || activeIssueRequest) {
      openPanel();
      setStatus('当前存在其他专用模式或待审阅 Changes；请先完成或丢弃。', true);
      return { ok: false, message: '请先处理当前 Changes 审阅' };
    }
    if (activeResearchRequest) {
      openPanel();
      return activeResearchRequest.handoff.cardId === handoff.cardId
        ? { ok: true, alreadyOpen: true }
        : { ok: false, message: '请先退出当前 Research 证据卡' };
    }
    const openSequence = ++researchOpenSequence;
    let resolved;
    try { resolved = await bridge.resolveResearchCard(projectInstanceId, handoff.cardId); }
    catch (error) { return { ok: false, message: error.message }; }
    if (openSequence !== researchOpenSequence ||
        projectInstanceId !== window.__workspace?.state?.project?.instanceId ||
        pending || confirmationMode || activePlanRequest || activeIssueRequest || activeResearchRequest) {
      return { ok: false, message: '项目已切换，证据卡未打开' };
    }
    const card = resolved?.card || resolved;
    const resolvedHandoff = window.WritCraftResearchHandoffTransaction.normalizeCardHandoff(card?.handoff || handoff);
    if (!resolved?.ok || !resolvedHandoff || resolvedHandoff.cardId !== handoff.cardId ||
        typeof card?.claim !== 'string' || typeof card?.boundary !== 'string' || !card?.source) {
      return { ok: false, message: resolved?.message || resolved?.error || 'Main 返回的证据卡无效' };
    }
    proposalTransactions?.invalidate();
    invalidateNormalScopePlan();
    activeResearchRequest = {
      projectInstanceId,
      handoff,
      card,
      phase: 'ready',
      request: null,
      binding: null,
      changeSetId: null,
    };
    selectedTargetPaths = [];
    targetSelectionTouched = false;
    renderResearchMode();
    renderPlanMode();
    renderIssueMode();
    openPanel();
    setBusy(false);
    setStatus('Research 专用模式：核对锁定证据，并选择 1–8 个可修改正文。');
    return { ok: true };
  }

  async function openGraphIssue(value) {
    const request = window.WritCraftGraphIssueHandoffTransaction?.normalizeRequest?.(value);
    if (!request || !proposalTransactions || !bridge?.handoffGraphIssue) {
      return { ok: false, message: '图谱问题交接请求无效或服务未连接' };
    }
    if (activePlanRequest) {
      openPanel();
      setStatus('当前仍绑定 Plan 任务；请先点击“脱离 Plan”再处理图谱问题。', true);
      return { ok: false, message: '请先脱离当前 Plan 任务' };
    }
    if (activeResearchRequest) {
      openPanel();
      setStatus('当前仍绑定 Research 证据卡；请先退出 Research 再处理图谱问题。', true);
      return { ok: false, message: '请先退出 Research 专用模式' };
    }
    if (pending) {
      openPanel();
      setStatus('当前还有待审阅 Changes；请先应用或丢弃，再处理星图问题。', true);
      return { ok: false, message: '请先处理当前待审阅 Changes' };
    }
    if (activeIssueRequest) {
      openPanel();
      setStatus('当前已在处理一个星图问题；请先退出当前专用审阅。', true);
      return { ok: false, message: '星图问题专用审阅已锁定' };
    }
    invalidateNormalScopePlan();
    activeIssueRequest = request;
    renderIssueMode();
    openPanel();
    setStatus('星图问题专用模式：问题、证据和目标由 Main 权威绑定。');
    return proposeGraphIssueTask();
  }

  async function proposeGraphIssueTask() {
    const request = activeIssueRequest;
    if (!request || !proposalTransactions || !bridge?.handoffGraphIssue) {
      return { ok: false, message: '当前没有已绑定的星图问题' };
    }
    const projectInstanceId = window.__workspace?.state?.project?.instanceId || null;
    const transaction = proposalTransactions?.begin('issue', projectInstanceId);
    if (!transaction) return { ok: false, message: '图谱问题交接事务无效' };
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: projectInstanceId,
      action: 'graph_issue', startedAt: Date.now(), scope: 'multi_file', beforeChars: 0, afterChars: 0,
    };
    setBusy(true);
    setStatus('正在由 Main 重新核验问题、证据范围、只读来源与正文 revision…');
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'issue')) {
        return { ok: true, canceled: true, message: '旧图谱问题交接已取消' };
      }
      if (!saved) {
        const message = '当前文件未能安全保存，图谱问题交接已停止';
        setStatus(message, true);
        return { ok: false, message };
      }
      // Identifier-only: Main reconstructs issue prose, evidence, targets and
      // all revisions from the current corrected/reconciled graph.
      const result = await bridge.handoffGraphIssue(projectInstanceId, request);
      const current = await proposalTransactions.settle(transaction, result, {
        mode: 'issue',
        projectInstanceId: window.__workspace?.state?.project?.instanceId || null,
        discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId),
      });
      if (!current) return { ok: true, canceled: true, message: '旧图谱问题结果已丢弃' };
      if (!result?.ok) {
        recordChangeMetric('failed', metric);
        const message = result?.message || result?.error || '图谱问题修复生成失败';
        setStatus(message, true);
        return { ok: false, message };
      }
      const provenance = result.provenance;
      if (result.requireCompleteDecision !== true || result.proposalKind !== 'graph_issue' ||
          provenance?.kind !== 'graph_issue' || provenance?.issueId !== request.issueId ||
          provenance?.graphIdentity !== request.graphIdentity || provenance?.bindingId !== request.bindingId) {
        try { await bridge.discardChanges(projectInstanceId, result.changeSetId); } catch (_) {}
        recordChangeMetric('failed', metric);
        const message = '图谱问题修复响应与当前绑定不一致，已阻止审阅';
        setStatus(message, true);
        return { ok: false, message };
      }
      if (result.noChanges === true) return finishNoChanges('issue', result, metric);
      if (!(await replaceGeneratedReview(result, metric))) {
        recordChangeMetric('failed', metric);
        return { ok: false, message: '旧审阅未能安全释放，新提案已取消' };
      }
      recordChangeMetric('generated', metric);
      const paths = (provenance.targets || []).map(target => target.path).join('、');
      const message = `图谱问题已生成 ${result.fileCount || 0} 个文件的可审阅修复 · 目标 ${paths || '正文'} · 需处理全部修改块`;
      setStatus(message);
      return { ok: true, message };
    } catch (error) {
      if (!proposalTransactions.isCurrent(transaction, window.__workspace?.state?.project?.instanceId || null, 'issue')) {
        return { ok: true, canceled: true, message: '旧图谱问题交接已取消' };
      }
      recordChangeMetric('failed', metric);
      const message = `图谱问题修复生成中断：${error.message}`;
      setStatus(message, true);
      return { ok: false, message };
    } finally {
      if (proposalTransactions.finish(transaction, window.__workspace?.state?.project?.instanceId || null)) setBusy(false);
    }
  }

  async function openPlanTask(value) {
    const normalized = window.WritCraftPlanHandoffTransaction?.normalizeRequest?.(value);
    if (!normalized || !proposalTransactions) {
      return { ok: false, message: 'Plan 任务交接请求无效' };
    }
    if (pending) {
      openPanel();
      setStatus('当前还有待审阅 Changes；请先应用或丢弃，再交接 Plan 任务。', true);
      return { ok: false, message: '请先处理当前待审阅 Changes' };
    }
    if (activeIssueRequest) {
      openPanel();
      setStatus('当前仍绑定星图问题；请先退出星图审阅再交接 Plan 任务。', true);
      return { ok: false, message: '请先退出星图问题审阅' };
    }
    if (activeResearchRequest) {
      openPanel();
      setStatus('当前仍绑定 Research 证据卡；请先退出 Research 再交接 Plan 任务。', true);
      return { ok: false, message: '请先退出 Research 专用模式' };
    }
    // Entering Plan is a mode transition, not just another button click. Any
    // ordinary/chapter proposal still in flight becomes stale immediately.
    proposalTransactions.invalidate();
    invalidateNormalScopePlan();
    activePlanRequest = normalized;
    renderPlanMode();
    openPanel();
    setStatus('Plan 专用模式：指令和目标范围由 Main 权威记录锁定。');
    return proposePlanTask();
  }

  window.__changesView = {
    open: openPanel,
    close: closePanel,
    refreshContextPicker,
    acceptProposal,
    canStartOnboarding,
    discardPending,
    openWithInstruction,
    openResearchCard,
    leaveResearchMode,
    cancelResearchForRerun,
    openGraphIssue,
    openPlanTask,
    leavePlanMode,
    leaveIssueMode,
    loadHistory,
    renderHistory,
    setRecoveryState: renderRecoveryState,
    clearRecoveryState: () => renderRecoveryState(null),
  };
})();
