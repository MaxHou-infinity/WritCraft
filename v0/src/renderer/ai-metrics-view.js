// A quiet margin-note view of aggregate collaboration metrics; never receives raw events.
(function () {
  'use strict';

  function percent(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
  }

  function duration(value) {
    if (!Number.isFinite(value)) return '—';
    if (value < 1000) return `${Math.round(value)} ms`;
    return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  }

  function evidenceValue(item, mode = 'acceptance') {
    if (!item) return '0 次';
    if (mode === 'failure') return `${item.attempts || 0} 次 · 失败 ${percent(item.failureRate)}`;
    return `${item.decisionSampleSize || 0} 次决策 · 采纳 ${percent(item.acceptanceRate)}`;
  }

  function researchAccuracyValue(item) {
    if (!item) return '0 次判断';
    return `${item.sampleSize || 0} 次判断 · 匹配 ${percent(item.matchRate)}`;
  }

  function render(host, state) {
    if (!host) return;
    host.replaceChildren();
    if (state?.status === 'loading') {
      const loading = document.createElement('p');
      loading.className = 'ai-metrics-empty';
      loading.textContent = '正在读取本项目的协作回顾…';
      host.append(loading);
      return;
    }
    if (state?.status === 'error') {
      const error = document.createElement('p');
      error.className = 'ai-metrics-error';
      error.textContent = state.message || '协作回顾暂时无法读取';
      host.append(error);
      return;
    }
    const metrics = state?.status === 'ready' ? state.metrics : null;
    if (!metrics || !metrics.sampleSize) {
      const empty = document.createElement('p');
      empty.className = 'ai-metrics-empty';
      empty.textContent = '完成一次 AI 改写或项目提案后，这里会出现仅存于本项目的协作回顾。';
      host.append(empty);
      return;
    }
    const grid = document.createElement('dl');
    grid.className = 'ai-metrics-grid';
    const rows = [
      ['已记录', `${metrics.sampleSize} 次`],
      ['建议接受率', percent(metrics.acceptanceRate)],
      ['Inline', evidenceValue(metrics.authorEvidence?.inline)],
      ['Plan 生成', evidenceValue(metrics.authorEvidence?.planRun, 'failure')],
      ['Plan task', evidenceValue(metrics.authorEvidence?.planTask)],
      ['Research 修改', evidenceValue(metrics.authorEvidence?.research)],
      ['Research 主张', researchAccuracyValue(metrics.authorEvidence?.researchAccuracy)],
      ['图片', evidenceValue(metrics.authorEvidence?.image)],
      ['Onboarding', evidenceValue(metrics.authorEvidence?.onboarding, 'failure')],
      ['结构失败率', `${metrics.authorEvidence?.onboarding?.structuredFailures || 0} 次 · ${percent(metrics.authorEvidence?.onboarding?.structuredFailureRate)}`],
      ['人工重试', `${metrics.authorEvidence?.onboarding?.retryResults || 0} 次有结果 · 成功 ${percent(metrics.authorEvidence?.onboarding?.retrySuccessRate)}`],
      ['响应中位数', duration(metrics.durationMs?.median)],
      ['响应 P95', duration(metrics.durationMs?.p95)],
      ['审阅中位数', duration(metrics.reviewDurationMs?.median)],
    ];
    for (const [label, value] of rows) {
      const item = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      item.append(dt, dd);
      grid.append(item);
    }
    host.append(grid);
    const note = document.createElement('p');
    note.className = 'ai-metrics-note';
    note.textContent = metrics.decisionSampleNote || metrics.sampleNote || '分项样本达到 20 次后再用于方向判断。';
    host.append(note);
    if (metrics.authorEvidence?.researchAccuracy?.sampleSize) {
      const accuracyNote = document.createElement('p');
      accuracyNote.className = 'ai-metrics-note';
      accuracyNote.textContent = metrics.authorEvidence.researchAccuracy.note ||
        'Research 匹配率是作者对 AI 主张与当次来源摘录的判断，不是平台事实评分。';
      host.append(accuracyNote);
    }
  }

  window.WritCraftAiMetricsView = Object.freeze({ percent, duration, researchAccuracyValue, render });
})();
