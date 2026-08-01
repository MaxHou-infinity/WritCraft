// Integrates the right-side book tabs with authoritative Main services.
(function () {
  'use strict';

  const workArea = document.getElementById('work-area');
  const dockElement = document.getElementById('assistant-dock');
  const navigationHost = document.getElementById('writing-navigation-host');
  const contextHost = document.getElementById('context-inspector-host');
  const bridge = window.writCraft?.project;
  let navigationController = null;
  let contextController = null;

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
      recordNavigationMetric(result?.ok === true ? 'generated' : 'failed', metric);
      return result;
    } catch (error) {
      recordNavigationMetric('failed', metric);
      throw error;
    }
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

  async function runNavigationAction(projectInstanceId, actionId, attemptId) {
    if (!bridge?.runWritingNavigationAction) {
      return { ok: false, error: 'ACTION_UNAVAILABLE' };
    }
    const result = await bridge.runWritingNavigationAction(
      projectInstanceId,
      actionId,
      attemptId
    );
    if (projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      if (result?.kind === 'changes' && result.changeSetId) {
        try { await bridge.discardChanges?.(projectInstanceId, result.changeSetId); } catch (_) {}
      }
      return { ok: false, error: 'PROJECT_CHANGED' };
    }
    if (result?.ok !== true) return result;
    if (result.kind === 'research') {
      const routed = window.__sourcesView?.openWritingNavigation?.(result.handoff);
      return routed?.ok === true
        ? result
        : { ok: false, error: 'RESEARCH_ROUTE_FAILED' };
    }
    if (result.kind === 'changes' && result.noChanges !== true) {
      const accepted = window.__changesView?.acceptProposal?.(result);
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

  if (window.WritCraftWritingNavigationView && navigationHost) {
    navigationController = window.WritCraftWritingNavigationView.mount(navigationHost, {
      stateApi: window.WritCraftWritingNavigationState,
      onGenerate: generateNavigation,
      onCancelGeneration: (projectInstanceId, attemptId) =>
        bridge?.cancelWritingNavigation?.(projectInstanceId, attemptId),
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
      onCancelAction: (projectInstanceId, actionId, attemptId) =>
        bridge?.cancelWritingNavigationAction?.(projectInstanceId, actionId, attemptId),
      onOpenEvidence: openLocator,
      onOpenSettings: () => document.getElementById('activity-settings')?.click(),
      onOpenReview: () => window.__changesView?.open?.(),
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
    beforeOpen() {
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

  document.addEventListener('writcraft:project-entered', () => {
    const workspace = window.__workspace;
    const navigationState = navigationController?.updateProject?.(
      workspace?.state?.project || null,
      workspace?.state?.tree || [],
      workspace?.getCurrentPath?.() || null
    );
    if (navigationState?.mode === 'structure') void navigationController?.recover?.();
    else if (navigationState?.mode === 'navigation') void navigationController?.resume?.();
    contextController?.update?.(
      { scope: 'file', budgetChars: 10000, usedChars: 0, usedBytes: 0, chips: [] },
      []
    );
  });
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
