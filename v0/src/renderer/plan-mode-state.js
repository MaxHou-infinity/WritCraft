(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftPlanModeState = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const PLAN_SCHEMA = 'writcraft.plan/v2';
  const HANDOFF_SCHEMA = 'writcraft.plan-task-handoff/v1';
  const MAX_MILESTONES = 2;
  const MAX_TASKS = 4;
  const MAX_TASKS_PER_MILESTONE = 2;
  const TASK_SCOPES = new Set(['project', 'file', 'paragraph', 'research']);

  function text(value, limit = 2000) {
    return typeof value === 'string'
      ? Array.from(value.trim()).slice(0, limit).join('')
      : '';
  }

  function integer(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function stringList(value, max = 20, limit = 500) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const item of value.slice(0, max)) {
      const normalized = text(item, limit);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
    return result;
  }

  function normalizeTargets(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const targets = [];
    for (const raw of value.slice(0, 2)) {
      if (!raw || typeof raw !== 'object') continue;
      const path = text(raw.path, 80);
      const revision = text(raw.revision, 256);
      if (!path || !/^[a-f0-9]{64}$/.test(revision) || seen.has(path)) continue;
      seen.add(path);
      targets.push({ path, revision });
    }
    return targets;
  }

  function normalizeTask(raw, index, knownIds) {
    if (!raw || typeof raw !== 'object') return null;
    const id = text(raw.id, 32) || `task-${index + 1}`;
    if (knownIds.has(id)) return null;
    knownIds.add(id);
    return {
      id,
      title: text(raw.title, 24) || `任务 ${index + 1}`,
      description: text(raw.description, 24) || '尚未提供任务说明。',
      scope: TASK_SCOPES.has(raw.scope) ? raw.scope : 'project',
      targets: normalizeTargets(raw.targets),
      dependsOn: stringList(raw.dependsOn, 2, 32),
      acceptanceCriteria: stringList(raw.acceptanceCriteria, 2, 16),
    };
  }

  function normalizePlan(raw) {
    if (!raw || typeof raw !== 'object' || raw.schema !== PLAN_SCHEMA) return null;
    const knownIds = new Set();
    let taskCount = 0;
    const milestones = [];
    for (const [index, item] of (Array.isArray(raw.milestones) ? raw.milestones : []).slice(0, MAX_MILESTONES).entries()) {
      if (!item || typeof item !== 'object') continue;
      const id = text(item.id, 32) || `milestone-${index + 1}`;
      if (knownIds.has(id)) continue;
      knownIds.add(id);
      const tasks = [];
      for (const task of (Array.isArray(item.tasks) ? item.tasks : []).slice(0, MAX_TASKS_PER_MILESTONE)) {
        if (taskCount >= MAX_TASKS) break;
        const normalized = normalizeTask(task, taskCount, knownIds);
        if (normalized) {
          tasks.push(normalized);
          taskCount += 1;
        }
      }
      if (!tasks.length) continue;
      milestones.push({
        id,
        title: text(item.title, 24) || `里程碑 ${index + 1}`,
        objective: text(item.objective, 24) || '尚未提供里程碑目标。',
        acceptanceCriteria: stringList(item.acceptanceCriteria, 2, 16),
        tasks,
      });
    }
    if (!milestones.length) return null;
    return {
      schema: PLAN_SCHEMA,
      planId: text(raw.planId, 128) || 'unversioned-plan',
      title: text(raw.title, 24) || '未命名计划',
      summary: text(raw.summary, 48) || '尚未提供计划摘要。',
      assumptions: stringList(raw.assumptions, 2, 16),
      openQuestions: stringList(raw.openQuestions, 2, 16),
      milestones,
    };
  }

  function normalizeManifest(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const files = [];
    for (const item of (Array.isArray(source.files) ? source.files : []).slice(0, 16)) {
      if (!item || typeof item !== 'object') continue;
      const path = text(item.path, 512);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push({
        path,
        role: item.role === 'project_prompt' ? 'project_prompt' : 'context',
        revision: text(item.revision, 256) || null,
        bytes: integer(item.bytes),
      });
    }
    const prompt = source.editPrompt && typeof source.editPrompt === 'object' ? source.editPrompt : {};
    return {
      authority: 'main-manifest',
      goalChars: integer(source.goalChars),
      totalBytes: integer(source.totalBytes),
      omitted: Array.isArray(source.omitted) ? source.omitted.slice(0, 20).map(item => text(item, 512)).filter(Boolean) : [],
      files,
      editPrompt: {
        revision: text(prompt.revision, 256) || null,
        frontMatterStatus: ['valid', 'warning', 'invalid', 'missing'].includes(prompt.frontMatterStatus)
          ? prompt.frontMatterStatus
          : 'unknown',
        diagnosticCodes: stringList(prompt.diagnosticCodes, 20, 100),
      },
    };
  }

  function base(status, additions = {}) {
    return deepFreeze({
      status,
      plan: null,
      manifest: normalizeManifest(),
      activeMilestoneId: null,
      expandedTaskIds: [],
      transfer: null,
      error: null,
      ...additions,
    });
  }

  function createState(payload) {
    if (!payload || payload.status === 'empty') return base('empty');
    if (payload.status === 'loading') return base('loading');
    if (payload.status === 'error' || payload.ok === false) {
      return base('error', { error: text(payload.message || payload.error, 1000) || '计划生成失败，请检查项目说明后重试。' });
    }
    const result = payload.result && typeof payload.result === 'object' ? payload.result : payload;
    const plan = normalizePlan(result.plan);
    if (!result.ok || !plan) return base('error', { error: '计划数据不完整，请重新生成。' });
    return base('ready', {
      plan,
      manifest: normalizeManifest(result.contextManifest),
      activeMilestoneId: plan.milestones[0].id,
    });
  }

  function reduce(state, action) {
    if (!state || !action || typeof action.type !== 'string') return state;
    if (action.type === 'load-start') return base('loading');
    if (action.type === 'load-result') return createState(action.result);
    if (action.type === 'load-error') return createState({ status: 'error', message: action.message });
    if (state.status !== 'ready') return state;
    if (action.type === 'select-milestone') {
      if (!state.plan.milestones.some(item => item.id === action.milestoneId) || state.activeMilestoneId === action.milestoneId) return state;
      return deepFreeze({ ...state, activeMilestoneId: action.milestoneId, expandedTaskIds: [] });
    }
    const task = state.plan.milestones.flatMap(item => item.tasks).find(item => item.id === action.taskId);
    if (!task) return state;
    if (action.type === 'toggle-task') {
      const expanded = state.expandedTaskIds.includes(task.id);
      return deepFreeze({
        ...state,
        expandedTaskIds: expanded ? state.expandedTaskIds.filter(id => id !== task.id) : [...state.expandedTaskIds, task.id],
      });
    }
    if (action.type === 'transfer-start') {
      return deepFreeze({ ...state, transfer: { taskId: task.id, status: 'loading', message: '正在转交任务…' } });
    }
    if (action.type === 'transfer-success') {
      return deepFreeze({ ...state, transfer: { taskId: task.id, status: 'success', message: text(action.message, 500) || '任务已转交，正文仍需单独审阅。' } });
    }
    if (action.type === 'transfer-error') {
      return deepFreeze({ ...state, transfer: { taskId: task.id, status: 'error', message: text(action.message, 500) || '任务转交失败，请重试。' } });
    }
    return state;
  }

  function formatBytes(value) {
    const bytes = integer(value);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function handoffPayload(state, taskId) {
    if (state?.status !== 'ready') return null;
    const milestone = state.plan.milestones.find(item => item.tasks.some(task => task.id === taskId));
    const task = milestone?.tasks.find(item => item.id === taskId);
    if (!milestone || !task || !task.targets.length) return null;
    return deepFreeze({
      schema: HANDOFF_SCHEMA,
      planId: state.plan.planId,
      taskId: task.id,
    });
  }

  function toViewModel(state) {
    if (state.status !== 'ready') return { status: state.status, error: state.error };
    const activeIndex = Math.max(0, state.plan.milestones.findIndex(item => item.id === state.activeMilestoneId));
    const active = state.plan.milestones[activeIndex];
    const taskTotal = state.plan.milestones.reduce((total, item) => total + item.tasks.length, 0);
    return {
      status: 'ready',
      plan: state.plan,
      milestones: state.plan.milestones.map((item, index) => ({ ...item, index: index + 1, active: index === activeIndex })),
      active: {
        ...active,
        index: activeIndex + 1,
        tasks: active.tasks.map((task, index) => ({
          ...task,
          index: index + 1,
          expanded: state.expandedTaskIds.includes(task.id),
          transferring: state.transfer?.taskId === task.id && state.transfer.status === 'loading',
        })),
      },
      taskTotal,
      manifest: state.manifest,
      transfer: state.transfer,
    };
  }

  return {
    PLAN_SCHEMA,
    HANDOFF_SCHEMA,
    MAX_MILESTONES,
    MAX_TASKS,
    MAX_TASKS_PER_MILESTONE,
    TASK_SCOPES,
    createState,
    reduce,
    normalizePlan,
    normalizeManifest,
    formatBytes,
    handoffPayload,
    toViewModel,
  };
});
