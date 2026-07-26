// Privacy-preserving renderer client for project-scoped AI collaboration metrics.
(function () {
  'use strict';

  const ACTIONS = new Set([
    'inline_rewrite', 'changeset', 'plan', 'onboarding', 'research', 'image',
    'graph_issue', 'plan_task',
  ]);
  const OUTCOMES = new Set(['accepted', 'rejected', 'generated', 'discarded', 'failed', 'structured_failed', 'retried']);
  const STYLES = new Set(['general', 'concise', 'expand', 'polish', 'formal', 'casual', 'vivid', 'academic', 'creative', 'neutral', 'none']);
  const SCOPES = new Set(['selection', 'file', 'multi_file', 'project']);
  const MAX_DEFERRED_ONBOARDING_EVENTS = 8;
  const deferredOnboardingGenerated = new Map();

  function createOperationId() {
    return crypto.randomUUID().replace(/-/g, '');
  }

  function strictInteger(value, maximum) {
    return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  }

  function sanitizeEvent(input) {
    const durationMs = strictInteger(input?.durationMs, 24 * 60 * 60 * 1000);
    const beforeChars = strictInteger(input?.beforeChars, 100 * 1024 * 1024);
    const afterChars = strictInteger(input?.afterChars, 100 * 1024 * 1024);
    if (!/^[a-f0-9]{32}$/i.test(input?.operationId || '') || durationMs === null || beforeChars === null || afterChars === null ||
        !ACTIONS.has(input?.action) || !OUTCOMES.has(input?.outcome) ||
        !STYLES.has(input?.style) || !SCOPES.has(input?.scope)) return null;
    return Object.freeze({
      operationId: input.operationId.toLowerCase(),
      action: input.action,
      outcome: input.outcome,
      style: input.style,
      scope: input.scope,
      durationMs,
      beforeChars,
      afterChars,
    });
  }

  async function persist(originProjectInstanceId, event) {
    const bridge = window.writCraft?.project;
    try {
      const result = await bridge.recordAiMetric(originProjectInstanceId, event);
      if (result?.ok) document.dispatchEvent(new CustomEvent('writcraft:ai-metrics-changed'));
      return Boolean(result?.ok);
    } catch (_) { return false; }
  }

  async function record(originProjectInstanceId, input) {
    const event = sanitizeEvent(input);
    const bridge = window.writCraft?.project;
    const currentProjectInstanceId = window.__workspace?.state?.project?.instanceId;
    if (!originProjectInstanceId || currentProjectInstanceId !== originProjectInstanceId) return false;
    if (!event || !bridge?.recordAiMetric) return false;
    // A successful Onboarding generation already owns a live Main review
    // capability. Persisting project-local metrics at that instant can produce
    // a filename-less fs.watch echo and correctly invalidate that capability.
    // Keep only the fixed eight-field event in memory until the edit review or
    // initial-file confirmation reaches a terminal author decision.
    if (event.action === 'onboarding' && event.outcome === 'generated') {
      deferredOnboardingGenerated.set(`${originProjectInstanceId}:${event.operationId}`, event);
      while (deferredOnboardingGenerated.size > MAX_DEFERRED_ONBOARDING_EVENTS) {
        deferredOnboardingGenerated.delete(deferredOnboardingGenerated.keys().next().value);
      }
      return true;
    }
    if (event.action === 'onboarding' && ['accepted', 'rejected', 'discarded'].includes(event.outcome)) {
      const key = `${originProjectInstanceId}:${event.operationId}`;
      const generated = deferredOnboardingGenerated.get(key);
      if (generated) {
        if (!(await persist(originProjectInstanceId, generated))) return false;
        deferredOnboardingGenerated.delete(key);
      }
    }
    return persist(originProjectInstanceId, event);
  }

  async function aggregate() {
    const bridge = window.writCraft?.project;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    if (!bridge?.getAiMetricsAggregate || !projectInstanceId) return { status: 'unavailable' };
    try {
      const result = await bridge.getAiMetricsAggregate(projectInstanceId);
      return result?.ok
        ? { status: 'ready', metrics: result.aggregate }
        : { status: 'error', message: '协作回顾暂时无法读取' };
    } catch (_) { return { status: 'error', message: '协作回顾暂时无法读取' }; }
  }

  document.addEventListener('writcraft:project-entered', () => {
    const current = window.__workspace?.state?.project?.instanceId || '';
    for (const key of deferredOnboardingGenerated.keys()) {
      if (!key.startsWith(`${current}:`)) deferredOnboardingGenerated.delete(key);
    }
  });

  window.WritCraftAiMetrics = Object.freeze({ createOperationId, sanitizeEvent, record, aggregate });
})();
