// Main-owned AI task progress. This view deliberately renders only the public
// snapshot; it never infers authority or reads project files itself.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftAiTaskProgress = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 'writcraft.ai-task-progress/v1';
  const ACTIVE_STATUSES = new Set(['running']);
  const PHASE_COPY = Object.freeze({
    preparing_context: '正在准备上下文',
    checking_evidence: '正在核对来源',
    generating_suggestion: '正在生成建议',
    validating_result: '正在校验结果',
    waiting_review: '等待你审阅',
    committing: '正在写入已确认内容',
    completed: '已完成',
    cancelled: '已取消',
    timed_out: '已超时',
    failed: '处理失败',
    stale: '结果已过期',
    conflict: '发现冲突',
  });
  const STATUS_COPY = Object.freeze({
    review: '预览已生成，尚未写入文件',
    needs_sources: '需要补充来源',
    committed: '已写入项目文件',
    rejected: '已拒绝，未写入文件',
    completed: '已完成；本次未写入项目文件',
    cancelled: '已取消，未写入文件',
    timed_out: '已超时，未写入文件',
    failed: '处理失败，未写入文件',
    stale: '项目或内容已变化，结果已丢弃',
    conflict: '检测到冲突，未写入文件',
  });

  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function targetLabel(locator, kind) {
    if (locator && typeof locator === 'object') {
      if (typeof locator.label === 'string' && locator.label.trim()) return locator.label.trim();
      if (typeof locator.filePath === 'string' && locator.filePath.trim()) return locator.filePath.trim();
      if (typeof locator.section === 'string' && locator.section.trim()) return locator.section.trim();
      if (typeof locator.suggestionId === 'string') return `写作建议 ${locator.suggestionId}`;
    }
    return kind ? `AI ${kind}` : '当前写作任务';
  }

  function mount(host, options = {}) {
    if (!host || typeof host.replaceChildren !== 'function') throw new TypeError('AI 任务进度缺少容器');
    let projectInstanceId = null;
    let latest = null;

    function render(snapshot = latest) {
      latest = snapshot;
      host.replaceChildren();
      if (!snapshot || snapshot.schema !== SCHEMA) {
        host.hidden = true;
        return;
      }
      if (projectInstanceId && snapshot.projectInstanceId !== projectInstanceId) {
        host.hidden = true;
        return;
      }
      host.hidden = false;
      host.dataset.status = snapshot.status || 'running';
      const label = document.createElement('strong');
      label.textContent = targetLabel(snapshot.targetLocator, snapshot.kind);
      const phase = document.createElement('span');
      phase.className = 'ai-task-progress-phase';
      phase.textContent = PHASE_COPY[snapshot.phase] || '正在处理';
      const detail = document.createElement('span');
      detail.className = 'ai-task-progress-detail';
      detail.textContent = snapshot.status === 'running'
        ? `${phase.textContent} · ${Math.round(Math.max(0, Number(snapshot.elapsedMs) || 0) / 1000)} 秒`
        : (STATUS_COPY[snapshot.status] || phase.textContent);
      const body = document.createElement('div');
      body.className = 'ai-task-progress-copy';
      body.append(label, detail);
      host.append(body);
      if (snapshot.status === 'running' && snapshot.canCancel === true) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ai-task-progress-cancel';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => options.onCancel?.(snapshot));
        host.append(cancel);
      } else if (snapshot.status !== 'running') {
        const status = document.createElement('span');
        status.className = 'ai-task-progress-status';
        status.textContent = STATUS_COPY[snapshot.status] || text(snapshot.message, '任务已结束');
        host.append(status);
      }
    }

    return Object.freeze({
      setProject(project) {
        projectInstanceId = typeof project === 'string' ? project : project?.instanceId || null;
        if (latest && projectInstanceId && latest.projectInstanceId !== projectInstanceId) render(null);
        else render(latest);
      },
      progress(snapshot) {
        if (!snapshot || snapshot.schema !== SCHEMA) return false;
        if (projectInstanceId && snapshot.projectInstanceId !== projectInstanceId) return false;
        if (latest && latest.taskId === snapshot.taskId && latest.status !== 'running' && snapshot.status === 'running') return false;
        render(snapshot);
        return true;
      },
      clear() { render(null); },
      getSnapshot() { return latest; },
      destroy() { render(null); },
    });
  }

  return Object.freeze({ SCHEMA, PHASE_COPY, STATUS_COPY, mount });
});
