// Integrates the right-side book tabs with authoritative Main services.
(function () {
  'use strict';

  const workArea = document.getElementById('work-area');
  const dockElement = document.getElementById('assistant-dock');
  const navigationHost = document.getElementById('writing-navigation-host');
  const contextHost = document.getElementById('context-inspector-host');
  const taskProgressHost = document.getElementById('ai-task-progress');
  const bridge = window.writCraft?.project;
  let navigationController = null;
  const cancelledNavigationGenerations = new Set();
  const cancelledNavigationActions = new Set();
  let contextController = null;
  const taskProgressController = window.WritCraftAiTaskProgress && taskProgressHost
    ? window.WritCraftAiTaskProgress.mount(taskProgressHost, {
      onCancel: async snapshot => {
        await bridge?.cancelAiTask?.(
          snapshot.projectInstanceId,
          snapshot.attemptId
        );
        // A canceled Graph handoff owns a dedicated Changes mode. Release
        // that Renderer capability with the same task cancellation boundary
        // so a late result cannot leave the author trapped in a stale mode.
        if (snapshot.kind === 'graph_issue_handoff') {
          window.__changesView?.leaveIssueMode?.();
        }
      },
    })
    : null;
  const contextAutocomplete = window.WritCraftContextAutocomplete?.mount(document, {
    listCandidates: (projectInstanceId, request) => bridge?.listContextCandidates?.(projectInstanceId, request),
    getProjectInstanceId: () => window.__workspace?.state?.project?.instanceId || null,
    getCurrentFilePath: () => window.__workspace?.getCurrentPath?.() || null,
  });

  function recordNavigationMetric(outcome, metric) {
    if (!metric?.operationId || !metric.originProjectInstanceId) return;
    void window.WritCraftAiMetrics?.record?.(metric.originProjectInstanceId, {
      operationId: metric.operationId,
      action: 'plan',
      outcome,
      style: 'none',
      scope: 'project',
      durationMs: Math.max(0, Date.now() - metric.startedAt),
      beforeChars: 0,
      afterChars: 0,
    });
  }

  async function openLocator(locator, path) {
    const filePath = typeof path === 'string' && path ? path : locator?.filePath;
    if (!filePath) return false;
    const opened = await window.__workspace?.openFile?.(filePath);
    if (opened === false) return false;
    if (locator) {
      return window.__workspace?.revealContextChip?.({
        revision: locator.revision || null,
        locator,
      }) || false;
    }
    return true;
  }

  async function generateNavigation(request, attemptId, projectInstanceId) {
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: projectInstanceId,
      startedAt: Date.now(),
    };
    if (!bridge?.proposeWritingNavigation) {
      recordNavigationMetric('failed', metric);
      return { ok: false, error: 'NAVIGATION_UNAVAILABLE' };
    }
    if (!window.__workspace?.canUseAI?.()) {
      recordNavigationMetric('failed', metric);
      return { ok: false, error: 'PROJECT_CHANGED' };
    }
    const saved = await window.__workspace.persistCurrent(true);
    if (!saved) {
      recordNavigationMetric('failed', metric);
      return { ok: false, error: 'PROJECT_SAVE_FAILED' };
    }
    if (cancelledNavigationGenerations.has(attemptId)) {
      cancelledNavigationGenerations.delete(attemptId);
      recordNavigationMetric('failed', metric);
      return { ok: false, error: 'REQUEST_ABORTED' };
    }
    if (projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      recordNavigationMetric('failed', metric);
      return { ok: false, error: 'PROJECT_CHANGED' };
    }
    try {
      const result = await bridge.proposeWritingNavigation(
        projectInstanceId,
        request,
        attemptId
      );
      const outcome = result?.ok === true
        ? 'generated'
        : result?.error === 'REQUEST_ABORTED'
          ? 'cancelled'
          : 'failed';
      recordNavigationMetric(outcome, metric);
      return result;
    } catch (error) {
      recordNavigationMetric('failed', metric);
      throw error;
    } finally {
      cancelledNavigationGenerations.delete(attemptId);
    }
  }

  async function cancelNavigationGeneration(projectInstanceId, attemptId) {
    cancelledNavigationGenerations.add(attemptId);
    if (!bridge?.cancelWritingNavigation) return { ok: false, error: 'CANCEL_UNAVAILABLE' };
    const result = await bridge.cancelWritingNavigation(projectInstanceId, attemptId);
    if (result?.error === 'NAVIGATION_ATTEMPT_NOT_FOUND') {
      return { ok: true, cancelled: true };
    }
    return result;
  }

  async function confirmStructure(capabilityId) {
    if (!bridge?.confirmWritingStructure) {
      return { ok: false, state: 'UNKNOWN', recoveryRequired: true };
    }
    return bridge.confirmWritingStructure(capabilityId);
  }

  async function queryStructureRecovery(projectInstanceId) {
    if (!bridge?.queryWritingStructureRecovery) {
      return { ok: false, error: 'RECOVERY_UNAVAILABLE' };
    }
    return bridge.queryWritingStructureRecovery(projectInstanceId);
  }

  async function runNavigationAction(projectInstanceId, actionId, attemptId, onStage, taskInput = {}) {
    if (!bridge?.runWritingNavigationAction) {
      return { ok: false, error: 'ACTION_UNAVAILABLE' };
    }
    onStage?.('saving_current_content');
    const saved = await window.__workspace?.persistCurrent?.(true);
    if (!saved) return { ok: false, error: 'PROJECT_SAVE_FAILED' };
    if (cancelledNavigationActions.has(attemptId)) {
      cancelledNavigationActions.delete(attemptId);
      return { ok: false, error: 'REQUEST_ABORTED' };
    }
    if (projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      return { ok: false, error: 'PROJECT_CHANGED' };
    }
    onStage?.('checking_evidence');
    let result;
    try {
      result = await bridge.runWritingNavigationAction(
        projectInstanceId,
        actionId,
        attemptId,
        taskInput.adjustment || '',
        Array.isArray(taskInput.sourceIds) ? taskInput.sourceIds : []
      );
    } finally {
      cancelledNavigationActions.delete(attemptId);
    }
    if (projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      if (result?.kind === 'changes' && result.changeSetId) {
        try { await bridge.discardChanges?.(projectInstanceId, result.changeSetId); } catch (_) {}
      }
      return { ok: false, error: 'PROJECT_CHANGED' };
    }
    if (result?.ok !== true) return result;
    if (result.kind === 'changes' && result.noChanges !== true) {
      const targetPath = result.provenance?.evidence?.[0]?.path || result.review?.files?.[0]?.path;
      if (targetPath && window.__workspace?.getCurrentPath?.() !== targetPath) {
        const opened = await window.__workspace?.openFile?.(targetPath);
        if (!opened) {
          try { await bridge.discardChanges?.(projectInstanceId, result.changeSetId); } catch (_) {}
          return { ok: false, error: 'TARGET_OPEN_FAILED' };
        }
      }
      const accepted = window.__changesView?.acceptProposal?.(result, {
        inlineReview: {
          onSettled: outcome => navigationController?.reviewSettled?.(result.changeSetId, outcome),
        },
      });
      if (accepted?.ok !== true) {
        try { await bridge.discardChanges?.(projectInstanceId, result.changeSetId); } catch (_) {}
        return {
          ok: false,
          error: accepted?.error || 'REVIEW_IN_PROGRESS',
          message: accepted?.message,
        };
      }
    }
    return result;
  }

  async function cancelNavigationAction(projectInstanceId, actionId, attemptId) {
    cancelledNavigationActions.add(attemptId);
    if (!bridge?.cancelWritingNavigationAction) {
      return { ok: false, error: 'CANCEL_UNAVAILABLE' };
    }
    return bridge.cancelWritingNavigationAction(projectInstanceId, actionId, attemptId);
  }

  if (window.WritCraftWritingNavigationView && navigationHost) {
    navigationController = window.WritCraftWritingNavigationView.mount(navigationHost, {
      stateApi: window.WritCraftWritingNavigationState,
      onGenerate: generateNavigation,
      onCancelGeneration: cancelNavigationGeneration,
      onResume: projectInstanceId =>
        bridge?.resumeWritingNavigation?.(projectInstanceId),
      onPrepareStructure: (projectInstanceId, navigationId, alternativeId, chapters) =>
        bridge?.prepareWritingStructure?.(
          projectInstanceId,
          navigationId,
          alternativeId,
          chapters
        ),
      onConfirmStructure: confirmStructure,
      onQueryRecovery: queryStructureRecovery,
      onStructureCommitted: async () => {
        try { await window.__workspace?.refreshTree?.(); } catch (_) {}
      },
      onAcknowledgeRecovery: (projectInstanceId, operationId) =>
        bridge?.acknowledgeWritingStructureRecovery?.(projectInstanceId, operationId),
      onRunAction: runNavigationAction,
      onCancelAction: cancelNavigationAction,
      onOpenEvidence: openLocator,
      onAddSources: handoff => window.__sourcesView?.openWritingNavigation?.(
        handoff,
        sourceIds => navigationController?.resumeWithSources?.(handoff?.suggestionId, sourceIds)
      ),
      onAdjustReview: () => window.__changesView?.discardInlineReview?.(),
      onOpenSettings: () => document.getElementById('activity-settings')?.click(),
      onOpenReview: () => window.__changesView?.open?.(),
    });
  }

  bridge?.onWritingTaskProgress?.(payload => {
    navigationController?.progress?.(payload);
    taskProgressController?.progress?.(payload);
  });

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
    beforeOpen() {
      if (!window.__workspace?.state?.project || window.__workspace?.state?.projectReady !== true) {
        const status = document.getElementById('save-state');
        if (status) status.textContent = window.__workspace?.state?.project
          ? '项目仍在安全打开中，请稍候'
          : '请先创建或打开写作项目';
        return false;
      }
      window.__graphView?.close?.();
      workArea.classList.remove('has-ai', 'has-changes');
      return true;
    },
    onOpen(mode) {
      document.getElementById('activity-ai')?.setAttribute('aria-pressed', String(mode === 'chat'));
      document.getElementById('activity-changes')?.setAttribute('aria-pressed', String(mode === 'changes'));
      if (mode === 'navigation') {
        navigationController?.updateTree?.(
          window.__workspace?.state?.tree || [],
          window.__workspace?.getCurrentPath?.() || null
        );
      }
    },
    onClose() {
      document.getElementById('activity-ai')?.setAttribute('aria-pressed', 'false');
      document.getElementById('activity-changes')?.setAttribute('aria-pressed', 'false');
    },
  });

  function syncEnteredProject() {
    const workspace = window.__workspace;
    const navigationState = navigationController?.updateProject?.(
      workspace?.state?.project || null,
      workspace?.state?.tree || [],
      workspace?.getCurrentPath?.() || null
    );
    taskProgressController?.setProject?.(workspace?.state?.project?.instanceId || null);
    if (navigationState?.mode === 'structure') void navigationController?.recover?.();
    else if (navigationState?.mode === 'navigation') void navigationController?.resume?.();
    contextController?.update?.(
      { scope: 'file', budgetChars: 10000, usedChars: 0, usedBytes: 0, chips: [] },
      []
    );
  }
  function clearEnteringProject() {
    navigationController?.updateProject?.(null, [], null);
    taskProgressController?.setProject?.(null);
    contextController?.update?.(
      { scope: 'file', budgetChars: 10000, usedChars: 0, usedBytes: 0, chips: [] },
      []
    );
  }
  document.addEventListener('writcraft:project-entering', clearEnteringProject);
  document.addEventListener('writcraft:project-entry-failed', clearEnteringProject);
  document.addEventListener('writcraft:project-entered', syncEnteredProject);
  if (window.__workspace?.state?.projectReady === true) syncEnteredProject();
  document.addEventListener('writcraft:tree-changed', () => {
    navigationController?.updateTree?.(
      window.__workspace?.state?.tree || [],
      window.__workspace?.getCurrentPath?.() || null
    );
  });
  document.addEventListener('writcraft:current-file-changed', () => {
    navigationController?.updateTree?.(
      window.__workspace?.state?.tree || [],
      window.__workspace?.getCurrentPath?.() || null
    );
  });
  document.addEventListener('writcraft:history-undone', event => {
    navigationController?.historyUndone?.(event?.detail || null);
  });

  window.__assistantDock = dockController;
  window.__writingNavigationView = navigationController;
  window.__contextInspectorView = Object.freeze({
    open: () => dockController?.open('context'),
    update(manifest, errors) {
      contextController?.update?.(manifest, errors || manifest?.errors || []);
    },
    getState: () => contextController?.getState?.() || null,
    getRequestPolicy: () => contextController?.getRequestPolicy?.() || { excludedChipIds: [] },
  });
})();
