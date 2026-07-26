(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftPlanHandoffTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'writcraft.plan-task-handoff/v1';

  function normalizeRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !['schema', 'planId', 'taskId'].every(key => keys.includes(key))) return null;
    if (value.schema !== SCHEMA || typeof value.planId !== 'string' || typeof value.taskId !== 'string') return null;
    return Object.freeze({ schema: SCHEMA, planId: value.planId, taskId: value.taskId });
  }

  function create() {
    let epoch = 0;
    let active = null;

    function begin(request, projectInstanceId) {
      const normalized = normalizeRequest(request);
      if (!normalized || typeof projectInstanceId !== 'string' || !projectInstanceId) return null;
      epoch += 1;
      active = Object.freeze({
        epoch,
        projectInstanceId,
        planId: normalized.planId,
        taskId: normalized.taskId,
      });
      return active;
    }

    function invalidate() {
      epoch += 1;
      active = null;
      return epoch;
    }

    function isCurrent(token, projectInstanceId) {
      return Boolean(token && active &&
        token.epoch === epoch && token.epoch === active.epoch &&
        token.projectInstanceId === projectInstanceId && token.projectInstanceId === active.projectInstanceId &&
        token.planId === active.planId && token.taskId === active.taskId);
    }

    async function settle(token, result, options = {}) {
      const current = isCurrent(token, options.projectInstanceId);
      if (!current && result?.ok && typeof result.changeSetId === 'string' && typeof options.discard === 'function') {
        try { await options.discard(result.changeSetId); } catch (_) {}
      }
      return current;
    }

    return Object.freeze({
      begin,
      invalidate,
      isCurrent,
      settle,
      getActive() { return active; },
      getEpoch() { return epoch; },
    });
  }

  return Object.freeze({ SCHEMA, normalizeRequest, create });
});
