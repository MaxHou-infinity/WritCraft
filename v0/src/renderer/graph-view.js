// WritCraft V0 · Consistency constellation renderer

(function () {
  const bridge = window.writCraft && window.writCraft.project;
  const workArea = document.getElementById('work-area');
  const graphView = document.getElementById('graph-view');
  const svg = document.getElementById('consistency-graph');
  const empty = document.getElementById('graph-empty');
  const issueList = document.getElementById('issue-list');
  const detail = document.getElementById('graph-detail');
  const summary = document.getElementById('graph-summary');
  const graphButton = document.querySelector('[data-view="graph"]');
  const graphFilter = document.getElementById('graph-filter');
  const graphScope = document.getElementById('graph-scope');
  const graphFile = document.getElementById('graph-file-filter');
  const graphTime = document.getElementById('graph-time-filter');
  const graphTimeEnd = document.getElementById('graph-time-end-filter');
  const graphSearch = document.getElementById('graph-search');
  const issueFilter = document.getElementById('issue-filter');
  const NS = 'http://www.w3.org/2000/svg';
  let graph = null;
  let positions = new Map();
  let selectedNodeId = '';
  let selectedDetail = null;
  let changedSourcePaths = new Set();
  let allSourcesChanged = false;
  let transform = { x: 0, y: 0, scale: 1 };
  let drag = null;
  let filter = 'all';
  let correctionBusy = false;
  let correctionSequence = 0;
  let refreshSequence = 0;
  let allSceneCache = null;
  let graphLayoutCache = null;

  function issueActionLabel(action, issue, title) {
    const issueTitle = title || issue?.title || issue?.type || '一致性冲突';
    const issueId = issue?.id ? `（${issue.id}）` : '';
    return `${action}：${issueTitle}${issueId}`;
  }

  function failureMessage(prefix, resultOrError, fallback) {
    const detail = typeof resultOrError === 'string'
      ? resultOrError
      : resultOrError?.message || resultOrError?.error;
    return detail ? `${prefix}：${detail}` : fallback;
  }

  function rejectInvalidGraphSnapshot(error) {
    if (error?.code !== 'INVALID_GRAPH_SNAPSHOT') return;
    graph = null;
    positions = new Map();
    selectedNodeId = '';
    selectedDetail = null;
    allSceneCache = null;
    graphLayoutCache = null;
    svg.replaceChildren();
    issueList.replaceChildren();
    detail.replaceChildren();
    empty.hidden = false;
  }

  const colors = {
    time: '#f39a4b', person: '#55c7d9', entity: '#55c7d9', organization: '#42b6c8',
    concept: '#a987ed', variable: '#84d29a', section: '#727983', place: '#e07ab3', location: '#e07ab3',
    default: '#8fa1b3', issue: '#ee6d7a',
  };

  function svgElement(name, attributes = {}) {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }

  function nodeId(value) {
    if (!value) return '';
    return typeof value === 'string' ? value : value.id || '';
  }

  function edgeEnds(edge) {
    return [
      edge.sourceId || edge.from || nodeId(edge.source),
      edge.targetId || edge.to || nodeId(edge.target),
    ];
  }

  function issueNodeIds(issue) {
    const values = issue.nodeIds || issue.relatedNodeIds || issue.nodes || [];
    return values.map(nodeId).filter(Boolean);
  }

  function evidenceFor(item) {
    if (Array.isArray(item.evidence)) return item.evidence;
    if (item.evidenceId && graph?.evidence) return graph.evidence.filter(entry => entry.id === item.evidenceId);
    const ids = item.evidenceIds || [];
    return graph?.evidence ? graph.evidence.filter(entry => ids.includes(entry.id)) : [];
  }

  function correctionStatuses(item) {
    const ids = new Set([...(item.correctionIds || []), item.correctionId].filter(Boolean));
    return (graph?.correctionState?.corrections || []).filter(correction => ids.has(correction.id));
  }

  function evidenceIsMarkedStale(evidence) {
    return allSourcesChanged || Boolean(evidence?.path && changedSourcePaths.has(evidence.path)) || Boolean(
      window.WritCraftGraphFilters?.evidenceIsStale?.(
        evidence,
        window.__workspace?.getCurrentPath?.(),
        window.__workspace?.state?.revision
      )
    );
  }

  function itemHasStaleEvidence(item) {
    return evidenceFor(item).some(evidenceIsMarkedStale);
  }

  function selectDetail(item, kind) {
    selectedDetail = item?.id ? { id: item.id, kind } : null;
    showDetail(item, kind);
  }

  function refreshSelectedDetail() {
    if (!selectedDetail || !graph) return;
    const collection = selectedDetail.kind === '冲突' ? graph.issues : graph.nodes;
    const item = (collection || []).find(entry => entry.id === selectedDetail.id);
    if (item) showDetail(item, selectedDetail.kind);
  }

  function aliasTypesCompatible(sourceType, targetType) {
    if (sourceType === targetType) return true;
    const entitySpecific = new Set(['person', 'organization', 'place', 'concept']);
    return sourceType === 'entity' && entitySpecific.has(targetType)
      || targetType === 'entity' && entitySpecific.has(sourceType);
  }

  async function applyCorrection(command, feedback) {
    if (correctionBusy || !graph?.correctionState?.graphIdentity) return false;
    correctionBusy = true;
    const correctionId = ++correctionSequence;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    const originSequence = refreshSequence;
    const requestIsCurrent = () => originSequence === refreshSequence &&
      projectInstanceId === window.__workspace?.state?.project?.instanceId;
    if (feedback) feedback.textContent = '正在保存项目纠错约束…';
    summary.textContent = '正在保存项目纠错约束…';
    try {
      const result = await bridge?.applyGraphCorrection?.(projectInstanceId, {
        schema: 'writcraft.graph-correction-command/v1',
        graphIdentity: graph.correctionState.graphIdentity,
        ...command,
      });
      if (!requestIsCurrent()) return false;
      if (!result?.ok) {
        const message = failureMessage('纠错保存失败', result, '纠错保存失败');
        if (feedback) feedback.textContent = message;
        summary.textContent = message;
        return false;
      }
      graph = window.WritCraftGraphFilters.freezeGraphSnapshot(result.graph);
      if (!graph.nodes?.some(node => node.id === selectedNodeId) && command.type === 'merge_alias') {
        selectedNodeId = command.targetNodeId;
      }
      populateGraphFilters();
      renderGraph();
      renderIssues();
      const selected = graph.nodes?.find(node => node.id === selectedNodeId);
      if (selected) showDetail(selected, selected.type || '节点');
      summary.textContent = `纠错已保存到当前项目 · ${graph.correctionState?.corrections?.length || 0} 条作者约束`;
      return true;
    } catch (error) {
      if (requestIsCurrent()) {
        rejectInvalidGraphSnapshot(error);
        const message = `纠错保存中断：${error?.message || '未知错误'}`;
        if (feedback) feedback.textContent = message;
        summary.textContent = message;
      }
      return false;
    } finally {
      // A project reset may already have started a new correction. The late
      // request that belonged to the old project must not unlock that newer
      // operation.
      if (correctionId === correctionSequence) correctionBusy = false;
    }
  }

  function appendCorrectionControls(item, relations) {
    if (!item?.id || !item.key) return;
    const section = document.createElement('section');
    section.className = 'graph-correction-controls';
    section.setAttribute('aria-label', '作者纠错');
    const title = document.createElement('strong');
    title.textContent = '作者纠错（不修改正文）';
    const source = document.createElement('p');
    source.className = 'graph-correction-source';
    const firstEvidence = evidenceFor(item)[0];
    source.textContent = firstEvidence
      ? `来源：${firstEvidence.path} · revision ${String(firstEvidence.revision || '').slice(0, 8)}…`
      : '来源：当前项目图谱（无直接证据）';
    section.append(title, source);
    if (graph?.correctionState?.persistenceBlocked) {
      const blocked = document.createElement('p');
      blocked.className = 'graph-correction-status';
      blocked.textContent = '项目纠错存储不可用；当前仅显示图谱，不会假装已保存。';
      section.appendChild(blocked);
      detail.appendChild(section);
      return;
    }

    for (const status of correctionStatuses(item)) {
      const statusRow = document.createElement('div');
      statusRow.className = 'graph-correction-status-row';
      const badge = document.createElement('p');
      badge.className = 'graph-correction-status';
      badge.textContent = `${status.active ? '已生效' : status.superseded ? '已被较新约束取代' : '待对应'} · ${status.evidenceState === 'stale' ? '原证据已变更' : '证据当前有效'} · ${status.label}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = status.type === 'merge_alias' ? '取消合并' : '撤销约束';
      remove.setAttribute('aria-label', `${remove.textContent}：${status.label}`);
      remove.addEventListener('click', () => applyCorrection({ type: 'remove_correction', correctionId: status.id }, source));
      statusRow.append(badge, remove);
      section.appendChild(statusRow);
    }

    const aliasRow = document.createElement('div');
    aliasRow.className = 'graph-correction-row';
    const aliasLabel = document.createElement('label');
    aliasLabel.textContent = '将此节点作为别名并入';
    const aliasSelect = document.createElement('select');
    aliasSelect.setAttribute('aria-label', '选择别名的主节点');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '选择主节点…';
    aliasSelect.appendChild(placeholder);
    for (const candidate of (graph.nodes || []).filter(node => node.id !== item.id && aliasTypesCompatible(item.type, node.type)).slice(0, 500)) {
      const option = document.createElement('option');
      option.value = candidate.id;
      option.textContent = `${candidate.label} · ${candidate.type}`;
      aliasSelect.appendChild(option);
    }
    const aliasButton = document.createElement('button');
    aliasButton.type = 'button';
    aliasButton.textContent = '合并别名';
    aliasButton.addEventListener('click', () => {
      if (!aliasSelect.value) return;
      applyCorrection({ type: 'merge_alias', sourceNodeId: item.id, targetNodeId: aliasSelect.value }, source);
    });
    aliasRow.append(aliasLabel, aliasSelect, aliasButton);
    section.appendChild(aliasRow);

    const attributeRow = document.createElement('form');
    attributeRow.className = 'graph-correction-row';
    const attributeName = document.createElement('input');
    attributeName.required = true;
    attributeName.maxLength = 80;
    attributeName.placeholder = '属性名';
    attributeName.setAttribute('aria-label', '要编辑的节点属性名');
    const attributeValue = document.createElement('input');
    attributeValue.maxLength = 500;
    attributeValue.placeholder = '作者确认值';
    attributeValue.setAttribute('aria-label', '节点属性值');
    const attributeButton = document.createElement('button');
    attributeButton.type = 'submit';
    attributeButton.textContent = '保存属性';
    attributeRow.append(attributeName, attributeValue, attributeButton);
    attributeRow.addEventListener('submit', event => {
      event.preventDefault();
      applyCorrection({ type: 'edit_attribute', nodeId: item.id, attribute: attributeName.value, value: attributeValue.value }, source);
    });
    section.appendChild(attributeRow);

    if (relations.length) {
      const factTitle = document.createElement('span');
      factTitle.className = 'graph-correction-label';
      factTitle.textContent = '关系事实';
      section.appendChild(factTitle);
      for (const edge of relations) {
        const row = document.createElement('div');
        row.className = 'graph-fact-decision';
        const label = document.createElement('span');
        label.textContent = edge.label || edge.relation || '关联';
        row.appendChild(label);
        for (const [decision, text] of [['confirmed', '确认'], ['rejected', '否定']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = text;
          button.setAttribute('aria-label', `${text}事实：${label.textContent}`);
          button.classList.toggle('is-current', edge.status === decision);
          button.addEventListener('click', () => applyCorrection({ type: 'decide_fact', edgeId: edge.id, decision }, source));
          row.appendChild(button);
        }
        if (edge.correctionId) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '撤销决定';
          remove.setAttribute('aria-label', `撤销事实决定：${label.textContent}`);
          remove.addEventListener('click', () => applyCorrection({ type: 'remove_correction', correctionId: edge.correctionId }, source));
          row.appendChild(remove);
        }
        section.appendChild(row);
      }
    }
    detail.appendChild(section);
  }

  function appendCorrectionLedger() {
    const records = graph?.correctionState?.corrections || [];
    if (!records.length) return;
    const section = document.createElement('section');
    section.className = 'graph-correction-ledger';
    section.setAttribute('aria-label', '项目作者约束');
    const title = document.createElement('strong');
    title.textContent = `项目作者约束 · ${records.length}`;
    const feedback = document.createElement('p');
    feedback.className = 'graph-correction-source';
    feedback.textContent = '约束保存于项目内，重启和重新索引后继续生效。';
    section.append(title, feedback);
    for (const record of records) {
      const row = document.createElement('div');
      row.className = 'graph-correction-status-row';
      const label = document.createElement('span');
      label.textContent = `${record.active ? '已生效' : record.superseded ? '已被较新约束取代' : '待对应'} · ${record.evidenceState === 'stale' ? '证据已变更' : '证据当前有效'} · ${record.label}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = record.type === 'merge_alias' ? '取消合并' : '撤销';
      remove.setAttribute('aria-label', `${remove.textContent}：${record.label}`);
      remove.addEventListener('click', () => applyCorrection({ type: 'remove_correction', correctionId: record.id }, feedback));
      row.append(label, remove);
      section.appendChild(row);
    }
    detail.appendChild(section);
  }

  function showDetail(item, kind) {
    detail.replaceChildren();
    const label = item.label || item.name || item.title || item.message || item.id;
    const heading = document.createElement('div');
    heading.className = 'graph-detail-title';
    heading.textContent = `${kind} · ${label}`;
    detail.appendChild(heading);
    if (item.description || item.message) {
      const description = document.createElement('p');
      description.className = 'graph-detail-description';
      description.textContent = item.description || item.message;
      detail.appendChild(description);
    }
    const attributes = item.attributes && typeof item.attributes === 'object' ? item.attributes : null;
    if (item.aliases?.length || attributes || Number.isFinite(item.confidence)) {
      const facts = document.createElement('dl');
      facts.className = 'graph-detail-facts';
      const rows = [];
      if (item.aliases?.length) rows.push(['别名', item.aliases.join('、')]);
      if (Number.isFinite(item.confidence)) rows.push(['置信度', `${Math.round(item.confidence * 100)}%`]);
      for (const [key, value] of Object.entries(attributes || {}).slice(0, 8)) rows.push([key, String(value)]);
      for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = term;
        dd.textContent = value;
        facts.append(dt, dd);
      }
      detail.appendChild(facts);
    }
    let relations = [];
    if (item.id && graph?.edges?.length) {
      const nodeLabels = new Map((graph.nodes || []).map(node => [node.id, node.label || node.name || node.id]));
      relations = graph.edges.filter(edge => edgeEnds(edge).includes(item.id)).slice(0, 10);
      if (relations.length) {
        const list = document.createElement('div');
        list.className = 'graph-relations';
        for (const edge of relations) {
          const [from, to] = edgeEnds(edge);
          const row = document.createElement('div');
          row.textContent = `${nodeLabels.get(from) || from} — ${edge.label || edge.relation || '关联'} → ${nodeLabels.get(to) || to}`;
          if (edge.evolution && Number.isFinite(edge.evolution.evidenceCount)) {
            const evolution = document.createElement('small');
            evolution.className = 'graph-relation-evolution';
            evolution.textContent = window.WritCraftGraphFilters?.formatEdgeEvolution?.(edge.evolution) || '';
            if (evolution.textContent) row.appendChild(evolution);
          }
          list.appendChild(row);
        }
        detail.appendChild(list);
      }
    }
    for (const evidence of evidenceFor(item).slice(0, 3)) {
      const confidence = Number.isFinite(evidence.confidence) ? ` · 置信度 ${Math.round(evidence.confidence * 100)}%` : '';
      const stale = evidenceIsMarkedStale(evidence) ? ' · 证据已过期' : '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'graph-evidence';
      button.title = '打开原文证据';
      const locator = document.createElement('span');
      locator.textContent = `${evidence.path || '未知文件'}${confidence}${stale}`;
      if (stale) button.dataset.stale = 'true';
      const quote = document.createElement('q');
      quote.textContent = String(evidence.quote || '').slice(0, 100);
      button.append(locator, quote);
      button.addEventListener('click', async () => {
        if (!evidence.path) return;
        const opened = await window.__workspace?.openFile?.(evidence.path);
        if (!opened) return;
        closeGraph();
        let start = evidence.start || 0;
        let end = evidence.end || start;
        if (evidence.revision && evidence.revision !== window.__workspace?.state?.revision) {
          const content = window.__editor?.getContent?.() || '';
          const quote = String(evidence.quote || '');
          const first = quote ? content.indexOf(quote) : -1;
          if (first < 0 || content.indexOf(quote, first + 1) >= 0) {
            const save = document.getElementById('save-state');
            if (save) save.textContent = '⚠ 图谱证据已过期；请重新分析后再定位';
            return;
          }
          start = first;
          end = first + quote.length;
        }
        window.__workspace?.revealRange?.(start, Math.max(0, end - start));
      });
      detail.appendChild(button);
    }
    if (kind === '冲突' && item.type === 'evidence_gap') {
      const missing = document.createElement('p');
      missing.className = 'graph-evidence-missing';
      missing.textContent = '缺失来源：该论点的支撑证据待补充。';
      detail.appendChild(missing);
    }
    appendCorrectionControls(item, relations);
    appendCorrectionLedger();
  }

  function visibleNodes() {
    if (window.WritCraftGraphFilters) return window.WritCraftGraphFilters.visibleNodes(graph, activeFilters());
    const nodes = graph?.nodes || [];
    if (filter === 'all') return nodes;
    const issueIds = new Set((graph?.issues || []).filter(issue => !['dismissed', 'resolved'].includes(issue.status)).flatMap(issueNodeIds));
    if (filter === 'issues') return nodes.filter(node => issueIds.has(node.id));
    if (filter === 'entity') return nodes.filter(node => ['person', 'entity', 'organization', 'place', 'location'].includes(node.type));
    if (filter === 'concept') return nodes.filter(node => ['concept', 'variable', 'value'].includes(node.type));
    return nodes.filter(node => node.type === filter);
  }

  function activeFilters() {
    return {
      type: filter,
      scope: graphScope?.value || 'current',
      currentPath: window.__workspace?.getCurrentPath?.() || '',
      filePath: graphFile?.value || '',
      timeStartNodeId: graphTime?.value || '',
      timeEndNodeId: graphTimeEnd?.value || '',
      query: graphSearch?.value || '',
    };
  }

  function replaceSelectOptions(select, placeholder, items) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const all = document.createElement('option');
    all.value = '';
    all.textContent = placeholder;
    select.appendChild(all);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = typeof item === 'string' ? item : item.id;
      option.textContent = typeof item === 'string' ? item : item.label;
      select.appendChild(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function populateGraphFilters() {
    const helper = window.WritCraftGraphFilters;
    if (!helper) return;
    replaceSelectOptions(graphFile, '全部文件', helper.fileOptions(graph));
    replaceSelectOptions(graphTime, '起点不限', helper.timeOptions(graph));
    replaceSelectOptions(graphTimeEnd, '终点不限', helper.timeOptions(graph));
  }

  function resetForProject() {
    // Graph controls are project-scoped UI state. Carrying a file, time or
    // node filter into another project can make the new project appear empty
    // and, worse, briefly expose cards from the previous graph.
    refreshSequence += 1;
    graph = null;
    positions = new Map();
    selectedNodeId = '';
    selectedDetail = null;
    changedSourcePaths = new Set();
    allSourcesChanged = false;
    transform = { x: 0, y: 0, scale: 1 };
    drag = null;
    filter = 'all';
    allSceneCache = null;
    graphLayoutCache = null;
    correctionSequence += 1;
    correctionBusy = false;
    if (graphFilter) graphFilter.value = 'all';
    if (graphScope) graphScope.value = 'current';
    if (graphSearch) graphSearch.value = '';
    if (issueFilter) issueFilter.value = 'active';
    replaceSelectOptions(graphFile, '全部文件', []);
    replaceSelectOptions(graphTime, '起点不限', []);
    replaceSelectOptions(graphTimeEnd, '终点不限', []);
    if (graphFile) graphFile.value = '';
    if (graphTime) graphTime.value = '';
    if (graphTimeEnd) graphTimeEnd.value = '';
    svg.replaceChildren();
    issueList.replaceChildren();
    detail.replaceChildren();
    empty.hidden = false;
    summary.textContent = '已切换项目；星图将按当前文件范围重新分析';
  }

  function updateTransform(scene) {
    scene.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
  }

  function renderIssues() {
    issueList.replaceChildren();
    const selectedStatus = issueFilter?.value || 'active';
    const scopedIssues = window.WritCraftGraphFilters
      ? window.WritCraftGraphFilters.visibleIssues(graph, activeFilters())
      : (graph?.issues || []);
    const issues = scopedIssues.filter(issue => selectedStatus === 'all'
      || selectedStatus === 'active' && ['open', 'acknowledged'].includes(issue.status || 'open')
      || issue.status === selectedStatus);
    if (!issues.length) {
      const message = document.createElement('p');
      message.className = 'tree-empty';
      message.textContent = '目前没有高置信度冲突。星图只报告有原文证据的问题。';
      issueList.appendChild(message);
      return;
    }
    for (const issue of issues) {
      const card = document.createElement('div');
      card.className = 'issue-card';
      const staleEvidence = itemHasStaleEvidence(issue);
      if (staleEvidence) card.dataset.stale = 'true';
      const severity = document.createElement('span');
      severity.className = 'severity';
      severity.textContent = `${String(issue.severity || 'warning').toUpperCase()} · ${issue.status || 'open'}`;
      const title = document.createElement('strong');
      title.textContent = issue.title || issue.type || '一致性冲突';
      const body = document.createElement('p');
      body.textContent = issue.message || issue.description || '查看证据并决定是否修订。';
      card.append(severity, title, body);
      if (staleEvidence) {
        const stale = document.createElement('p');
        stale.className = 'issue-stale-warning';
        stale.textContent = '证据已变更；请重新分析后再生成修复。';
        card.appendChild(stale);
      }
      const detailButton = document.createElement('button');
      detailButton.type = 'button';
      detailButton.className = 'issue-detail-trigger';
      detailButton.textContent = '查看证据与详情';
      detailButton.setAttribute('aria-label', issueActionLabel('查看问题详情', issue, title.textContent));
      detailButton.addEventListener('click', () => {
        const ids = issueNodeIds(issue);
        setSelectedNode(ids[0] || '');
        renderGraph({ preserveAll: true });
        selectDetail(issue, '冲突');
      });
      card.appendChild(detailButton);
      const actions = document.createElement('div');
      actions.className = 'issue-actions';
      for (const [status, label] of [['acknowledged', '知悉'], ['dismissed', '忽略'], ['resolved', '解决'], ['open', '重开']]) {
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = label;
        action.setAttribute('aria-label', issueActionLabel(label, issue, title.textContent));
        action.classList.toggle('is-current', (issue.status || 'open') === status);
        action.addEventListener('click', async event => {
          event.stopPropagation();
          const result = await bridge?.setIssueStatus?.(window.__workspace?.state?.project?.instanceId, issue.id, status);
          if (!result?.ok) {
            summary.textContent = result?.message || result?.error || '问题状态保存失败';
            return;
          }
          // Status participates in the Main-owned handoff binding. Rebuild the
          // decorated graph instead of retaining a stale Renderer capability.
          summary.textContent = '问题状态已保存，正在刷新修复绑定…';
          await refreshGraph();
        });
        actions.appendChild(action);
      }
      if (issue.changesHandoff) {
        const suggest = document.createElement('button');
        suggest.type = 'button';
        suggest.className = 'issue-suggest-fix';
        suggest.textContent = '生成可审阅修复';
        suggest.setAttribute('aria-label', issueActionLabel('生成可审阅修复', issue, title.textContent));
        suggest.disabled = staleEvidence;
        if (staleEvidence) suggest.title = '证据已变更，请重新分析';
        suggest.addEventListener('click', async event => {
          event.stopPropagation();
          const result = await window.__changesView?.openGraphIssue?.(issue.changesHandoff);
          if (!result?.ok && !result?.canceled) {
            summary.textContent = result?.message || '图谱问题交接失败';
          }
        });
        actions.appendChild(suggest);
      } else if (['open', 'acknowledged'].includes(issue.status || 'open')) {
        const unavailable = document.createElement('button');
        unavailable.type = 'button';
        unavailable.className = 'issue-suggest-fix';
        unavailable.disabled = true;
        unavailable.textContent = issue.changesHandoffUnavailableReason === 'NO_ISSUE_TARGETS'
          ? '无可修改正文' : '当前无法生成修复';
        unavailable.setAttribute('aria-label', issueActionLabel(unavailable.textContent, issue, title.textContent));
        actions.appendChild(unavailable);
      }
      card.appendChild(actions);
      issueList.appendChild(card);
    }
  }

  function graphSceneOwnershipFingerprint() {
    const active = activeFilters();
    return [active.scope, active.currentPath, selectedNodeId].join('\u0000');
  }

  function graphSceneOwner() {
    const active = activeFilters();
    return { scope: active.scope, currentPath: active.currentPath };
  }

  function isBaselineGraphScene() {
    const active = activeFilters();
    // The reusable scene belongs to one exact scope/current-file/selection
    // baseline. File, time and search results are transient projections and
    // must never replace it; clearing those controls should restore the
    // original DOM scene instead of rebuilding every project node.
    return filter === 'all' && !active.filePath && !active.timeStartNodeId &&
      !active.timeEndNodeId && !active.query;
  }

  function stableGraphLayout(issueIds) {
    const issueFingerprint = [...issueIds].sort().join('\u0000');
    if (graphLayoutCache?.graph === graph && graphLayoutCache.issueFingerprint === issueFingerprint) {
      return graphLayoutCache.positions;
    }
    const allNodes = graph?.nodes || [];
    const next = window.WritCraftGraphLayout?.layoutGraph?.(allNodes, { issueIds }) || new Map();
    graphLayoutCache = { graph, issueFingerprint, positions: next };
    return next;
  }

  function restoreBaselineScene(cache) {
    if (!cache?.scene || !Array.isArray(cache.elements)) return;
    cache.scene.setAttribute('data-type-filter', 'all');
    for (const element of cache.secondaryHiddenElements || []) {
      element.removeAttribute('data-secondary-hidden');
    }
    cache.secondaryHiddenElements = [];
    if (cache.scene.parentNode !== svg) svg.replaceChildren(cache.scene);
  }

  function syncCachedSelection() {
    if (allSceneCache?.graph !== graph || !(allSceneCache.nodeElements instanceof Map)) return;
    const previous = allSceneCache.selectedNodeId || '';
    if (previous !== selectedNodeId) {
      allSceneCache.nodeElements.get(previous)?.classList.remove('is-selected');
      allSceneCache.nodeElements.get(selectedNodeId)?.classList.add('is-selected');
    }
    allSceneCache.selectedNodeId = selectedNodeId;
    allSceneCache.fingerprint = graphSceneOwnershipFingerprint();
  }

  function setSelectedNode(nodeId) {
    selectedNodeId = nodeId || '';
    syncCachedSelection();
  }

  function canProjectBaseline(fingerprint, nodes) {
    return allSceneCache?.graph === graph && allSceneCache.fingerprint === fingerprint &&
      allSceneCache.nodeElements instanceof Map && Array.isArray(allSceneCache.edgeElements) &&
      nodes.every(node => allSceneCache.nodeElements.has(node.id));
  }

  function projectBaselineScene(nodes, visibleNodeIds, bounds) {
    const scene = allSceneCache.scene;
    const active = activeFilters();
    const hasSecondaryProjection = Boolean(active.filePath || active.timeStartNodeId ||
      active.timeEndNodeId || active.query);
    for (const element of allSceneCache.secondaryHiddenElements || []) {
      element.removeAttribute('data-secondary-hidden');
    }
    const secondaryHiddenElements = [];
    if (hasSecondaryProjection) {
      for (const [nodeId, element] of allSceneCache.nodeElements) {
        if (visibleNodeIds.has(nodeId)) continue;
        element.setAttribute('data-secondary-hidden', 'true');
        secondaryHiddenElements.push(element);
      }
      for (const edge of allSceneCache.edgeElements) {
        if (visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId)) continue;
        edge.element.setAttribute('data-secondary-hidden', 'true');
        secondaryHiddenElements.push(edge.element);
      }
    }
    allSceneCache.secondaryHiddenElements = secondaryHiddenElements;
    scene.setAttribute('data-type-filter', filter);
    updateTransform(scene);
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    if (scene.parentNode !== svg) svg.replaceChildren(scene);
  }

  function renderGraph(options = {}) {
    const owner = graphSceneOwner();
    if (allSceneCache?.graph === graph &&
        (allSceneCache.scope !== owner.scope || allSceneCache.currentPath !== owner.currentPath)) {
      allSceneCache = null;
    }
    const fingerprint = graphSceneOwnershipFingerprint();
    if (options.reuseAll === true && isBaselineGraphScene() && allSceneCache?.graph === graph &&
        allSceneCache.fingerprint === fingerprint) {
      restoreBaselineScene(allSceneCache);
      positions = allSceneCache.positions;
      svg.setAttribute('viewBox', allSceneCache.viewBox);
      updateTransform(allSceneCache.scene);
      if (allSceneCache.scene.parentNode !== svg) svg.replaceChildren(allSceneCache.scene);
      empty.hidden = true;
      return;
    }
    if (options.preserveAll !== true) allSceneCache = null;
    const nodes = visibleNodes();
    const edges = graph?.edges || [];
    empty.hidden = nodes.length > 0;
    const issueIds = new Set((graph.issues || []).filter(issue => !['dismissed', 'resolved'].includes(issue.status)).flatMap(issueNodeIds));
    positions = stableGraphLayout(issueIds);
    const visibleNodeIds = new Set(nodes.map(node => node.id));
    const visiblePositions = new Map(nodes.map(node => [node.id, positions.get(node.id)]).filter(([, point]) => point));
    const bounds = window.WritCraftGraphLayout?.layoutBounds?.(visiblePositions) || { x: 0, y: 0, width: 1000, height: 700 };
    if (options.preserveAll === true && canProjectBaseline(fingerprint, nodes)) {
      projectBaselineScene(nodes, visibleNodeIds, bounds);
      return;
    }
    svg.replaceChildren();
    if (!nodes.length) return;
    svg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
    const scene = svgElement('g', { class: 'graph-scene' });
    updateTransform(scene);

    const edgeElements = [];
    const nodeElements = new Map();
    const nodeTypes = new Map((graph.nodes || []).map(node => [node.id, node.type || '']));

    for (const edge of edges) {
      const [sourceId, targetId] = edgeEnds(edge);
      if (!visibleNodeIds.has(sourceId) || !visibleNodeIds.has(targetId)) continue;
      const source = positions.get(sourceId);
      const target = positions.get(targetId);
      if (!source || !target) continue;
      const element = svgElement('line', {
        x1: source.x, y1: source.y, x2: target.x, y2: target.y,
        class: `graph-edge${issueIds.has(sourceId) && issueIds.has(targetId) ? ' is-issue' : ''}`,
        'data-source-type': nodeTypes.get(sourceId) || '',
        'data-target-type': nodeTypes.get(targetId) || '',
        'data-source-issue': issueIds.has(sourceId) ? 'true' : 'false',
        'data-target-issue': issueIds.has(targetId) ? 'true' : 'false',
      });
      scene.appendChild(element);
      edgeElements.push({ element, sourceId, targetId });
    }

    nodes.forEach((node, index) => {
      const position = positions.get(node.id);
      const group = svgElement('g', {
        class: `graph-node${selectedNodeId === node.id ? ' is-selected' : ''}`,
        transform: `translate(${position.x} ${position.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `查看${node.type || '图谱'}节点：${node.label || node.name || node.id}`,
        'data-node-type': node.type || '',
        'data-issue': issueIds.has(node.id) ? 'true' : 'false',
      });
      const hasIssue = issueIds.has(node.id);
      const radius = hasIssue ? 8 : node.type === 'section' ? 4 : 6;
      group.appendChild(svgElement('circle', { r: 12, class: 'graph-node-hit', 'aria-hidden': 'true' }));
      group.appendChild(svgElement('circle', { r: 13, class: 'graph-node-focus', 'aria-hidden': 'true' }));
      group.appendChild(svgElement('circle', {
        r: radius,
        fill: hasIssue ? colors.issue : colors[node.type] || colors.default,
        'aria-hidden': 'true',
      }));
      if (window.WritCraftGraphLayout?.shouldShowLabel?.(node, index, nodes.length, hasIssue || node.type === 'time') !== false) {
        const label = svgElement('text', { x: radius + 5, y: 3, 'aria-hidden': 'true' });
        label.textContent = String(node.label || node.name || node.id).slice(0, 22);
        group.appendChild(label);
      }
      const activate = event => {
        event.stopPropagation();
        setSelectedNode(node.id);
        renderGraph({ preserveAll: true });
        selectDetail(node, node.type || '节点');
      };
      group.addEventListener('click', activate);
      group.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate(event);
      });
      scene.appendChild(group);
      nodeElements.set(node.id, group);
    });
    svg.appendChild(scene);
    if (isBaselineGraphScene()) {
      allSceneCache = {
        graph,
        fingerprint,
        scope: owner.scope,
        currentPath: owner.currentPath,
        selectedNodeId,
        positions,
        viewBox: svg.getAttribute('viewBox') || '0 0 1000 700',
        scene,
        elements: [...scene.children],
        nodeElements,
        edgeElements,
        secondaryHiddenElements: [],
      };
    }
  }

  function renderGraphForFilterControl() {
    const canReuseAll = isBaselineGraphScene() && allSceneCache?.graph === graph &&
      allSceneCache.fingerprint === graphSceneOwnershipFingerprint();
    renderGraph(canReuseAll ? { reuseAll: true } : { preserveAll: true });
    renderIssues();
  }

  async function refreshGraph() {
    if (!window.__workspace?.state?.project) return;
    const projectInstanceId = window.__workspace.state.project.instanceId;
    const requestId = ++refreshSequence;
    const requestIsCurrent = () => requestId === refreshSequence &&
      projectInstanceId === window.__workspace?.state?.project?.instanceId;
    summary.textContent = '正在读取项目文件并建立证据关系…';
    try {
      const saved = await window.__workspace.persistCurrent(true);
      if (!requestIsCurrent()) return;
      if (!saved) {
        summary.textContent = '当前文件未能保存，已停止分析，避免使用过期内容';
        return;
      }
      const result = bridge?.buildGraph
        ? await bridge.buildGraph(projectInstanceId)
        : { ok: false, message: '一致性引擎尚未连接' };
      if (!requestIsCurrent()) return;
      if (!result?.ok) {
        summary.textContent = failureMessage('分析失败', result, '分析失败');
        return;
      }
      graph = window.WritCraftGraphFilters.freezeGraphSnapshot(result.graph);
      changedSourcePaths = new Set();
      allSourcesChanged = false;
      selectedNodeId = '';
      selectedDetail = null;
      transform = { x: 0, y: 0, scale: 1 };
      const nodeCount = graph.nodes?.length || 0;
      const issueCount = graph.issues?.length || 0;
      const indexLabel = result.index?.status === 'cache_hit' ? '索引未变化'
        : result.index?.status === 'incremental' ? `增量分析 ${result.index.analyzedPaths?.length || 0} 个文件`
        : '已重建索引';
      summary.textContent = `${nodeCount} 个节点 · ${graph.edges?.length || 0} 条关系 · ${issueCount} 个高置信问题 · ${indexLabel}`;
      populateGraphFilters();
      renderGraph();
      renderIssues();
    } catch (error) {
      if (requestIsCurrent()) {
        rejectInvalidGraphSnapshot(error);
        summary.textContent = failureMessage('分析中断', error, '分析中断：未知错误');
      }
    }
  }

  function openGraph() {
    if (!window.__workspace?.state?.project) {
      const status = document.getElementById('save-state');
      if (status) status.textContent = '请先创建或打开写作项目';
      return;
    }
    window.__changesView?.close?.();
    workArea.classList.add('graph-active');
    graphButton?.classList.add('is-active');
    refreshGraph();
  }

  function closeGraph() {
    workArea.classList.remove('graph-active');
    graphButton?.classList.remove('is-active');
  }

  graphButton?.addEventListener('click', openGraph);
  document.getElementById('graph-back')?.addEventListener('click', closeGraph);
  document.getElementById('graph-refresh')?.addEventListener('click', refreshGraph);
  graphFilter?.addEventListener('change', () => {
    const nextFilter = graphFilter.value || 'all';
    if (nextFilter === filter) return;
    filter = nextFilter;
    setSelectedNode('');
    renderGraph(isBaselineGraphScene() ? { reuseAll: true } : { preserveAll: true });
    renderIssues();
  });
  graphScope?.addEventListener('change', renderGraphForFilterControl);
  graphFile?.addEventListener('change', renderGraphForFilterControl);
  graphTime?.addEventListener('change', renderGraphForFilterControl);
  graphTimeEnd?.addEventListener('change', renderGraphForFilterControl);
  graphSearch?.addEventListener('input', renderGraphForFilterControl);
  issueFilter?.addEventListener('change', renderIssues);
  document.addEventListener('writcraft:project-entered', () => {
    const reopen = workArea.classList.contains('graph-active');
    resetForProject();
    if (reopen) refreshGraph();
  });
  document.addEventListener('writcraft:current-file-changed', () => {
    if (!graph) return;
    renderGraph();
    renderIssues();
    refreshSelectedDetail();
  });
  document.addEventListener('writcraft:graph-source-changed', event => {
    if (!graph || event?.detail?.projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    changedSourcePaths = new Set([
      ...changedSourcePaths,
      ...(Array.isArray(event.detail.paths) ? event.detail.paths : []),
    ].filter(path => typeof path === 'string' && /\.(?:md|markdown)$/i.test(path)).slice(-100));
    allSourcesChanged = allSourcesChanged || event.detail.invalidateAll === true;
    renderGraph();
    renderIssues();
    refreshSelectedDetail();
    summary.textContent = '图谱证据已变更；请重新分析后再生成修复';
  });
  svg.addEventListener('wheel', event => {
    event.preventDefault();
    transform.scale = Math.max(.55, Math.min(2.4, transform.scale * (event.deltaY > 0 ? .9 : 1.1)));
    const scene = svg.querySelector('.graph-scene');
    if (scene) updateTransform(scene);
  }, { passive: false });
  svg.addEventListener('keydown', event => {
    if (event.target !== svg) return;
    const panStep = event.shiftKey ? 90 : 36;
    let handled = true;
    if (event.key === 'ArrowLeft') transform.x += panStep;
    else if (event.key === 'ArrowRight') transform.x -= panStep;
    else if (event.key === 'ArrowUp') transform.y += panStep;
    else if (event.key === 'ArrowDown') transform.y -= panStep;
    else if (event.key === '+' || event.key === '=') transform.scale = Math.min(2.4, transform.scale * 1.1);
    else if (event.key === '-' || event.key === '_') transform.scale = Math.max(.55, transform.scale * .9);
    else if (event.key === 'Home') transform = { x: 0, y: 0, scale: 1 };
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    const scene = svg.querySelector('.graph-scene');
    if (scene) updateTransform(scene);
  });
  svg.addEventListener('pointerdown', event => {
    svg.focus({ preventScroll: true });
    drag = { x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y, moved: false };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', event => {
    if (!drag) return;
    if (Math.abs(event.clientX - drag.x) > 2 || Math.abs(event.clientY - drag.y) > 2) drag.moved = true;
    transform.x = drag.originX + (event.clientX - drag.x);
    transform.y = drag.originY + (event.clientY - drag.y);
    const scene = svg.querySelector('.graph-scene');
    if (scene) updateTransform(scene);
  });
  svg.addEventListener('pointerup', () => {
    const moved = drag?.moved === true;
    drag = null;
    if (moved) svg.focus({ preventScroll: true });
  });
  svg.addEventListener('click', () => {
    setSelectedNode('');
    renderGraph({ preserveAll: true });
  });

  window.__graphView = { open: openGraph, close: closeGraph, refresh: refreshGraph };
})();
