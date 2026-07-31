// Local source and citation index view.
(function () {
  const bridge = window.writCraft?.project;
  const list = document.getElementById('source-index-list');
  const status = document.getElementById('source-index-status');
  const refreshButton = document.getElementById('source-index-refresh');
  const importButton = document.getElementById('source-import');
  const citationStyle = document.getElementById('source-citation-style');
  const researchQuestion = document.getElementById('source-research-question');
  const researchRun = document.getElementById('source-research-run');
  const researchCount = document.getElementById('source-research-count');
  const researchResults = document.getElementById('source-research-results');
  let active = false;
  let indexLoading = false;
  let importing = false;
  let researching = false;
  let currentIndex = null;
  let selectedSourceIds = [];
  let researchRequestSequence = 0;
  let indexRequestSequence = 0;
  let importRequestSequence = 0;
  let navigationHandoff = null;

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);
  }

  function validNavigationEvidence(value) {
    return exactKeys(value, ['path', 'revision', 'sectionHeading', 'quote', 'locator']) &&
      typeof value.path === 'string' &&
      typeof value.sectionHeading === 'string' &&
      typeof value.quote === 'string' &&
      value.locator?.filePath === value.path;
  }

  function normalizeNavigationHandoff(value) {
    if (!exactKeys(value, [
      'schema', 'navigationId', 'suggestionId', 'question', 'finding', 'evidence',
    ]) || value.schema !== 'writcraft.writing-navigation-research/v1' ||
        typeof value.question !== 'string' || !value.question ||
        typeof value.finding !== 'string' || !value.finding ||
        !Array.isArray(value.evidence) || value.evidence.length < 1 ||
        value.evidence.length > 3 || !value.evidence.every(validNavigationEvidence)) {
      return null;
    }
    return Object.freeze({
      question: value.question,
      finding: value.finding,
      evidence: Object.freeze(value.evidence.map(item => Object.freeze({
        path: item.path,
        sectionHeading: item.sectionHeading,
        quote: item.quote,
        locator: item.locator,
      }))),
    });
  }

  function setStatus(text, error = false) {
    status.textContent = text;
    status.style.color = error ? '#a3473e' : '';
  }

  function empty(text) {
    list.replaceChildren();
    const node = document.createElement('div');
    node.className = 'tree-empty';
    node.textContent = text;
    list.appendChild(node);
  }

  function syncResearchControls() {
    const hasQuestion = Boolean(researchQuestion?.value.trim());
    if (researchCount) researchCount.textContent = `${selectedSourceIds.length} / 8`;
    if (researchRun) researchRun.disabled = researching || !hasQuestion || selectedSourceIds.length === 0;
  }

  function clearResearchResults() {
    researchRequestSequence += 1;
    if (!researchResults) return;
    researchResults.hidden = true;
    researchResults.replaceChildren();
  }

  async function openResearchSource(source) {
    const opened = await window.__workspace?.openFile?.(source.locator.filePath);
    if (opened !== false) {
      window.__workspace?.revealRange?.(
        source.locator.offset,
        Math.max(0, source.locator.end - source.locator.offset)
      );
    }
    return opened !== false;
  }

  async function resolveResearchCard(card) {
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    const handoff = card?.handoff;
    if (!projectInstanceId || !bridge?.resolveResearchCard ||
        handoff?.schema !== 'writcraft.research-handoff/v1' || typeof handoff.cardId !== 'string') {
      return { ok: false, message: '证据卡解析服务不可用' };
    }
    // Identifier-only: Main reconstructs the canonical source, quote and locator.
    const result = await bridge.resolveResearchCard(projectInstanceId, handoff.cardId);
    if (projectInstanceId !== window.__workspace?.state?.project?.instanceId) return { ok: false, message: '项目已切换' };
    return result;
  }

  function researchState(text, error = false) {
    if (!researchResults) return;
    researchResults.hidden = false;
    researchResults.replaceChildren();
    const node = document.createElement('div');
    node.className = 'research-state';
    node.textContent = text;
    if (error) node.style.color = '#a3473e';
    researchResults.appendChild(node);
  }

  function renderNavigationHandoff() {
    if (!researchResults || !navigationHandoff) return;
    researchResults.hidden = false;
    researchResults.replaceChildren();
    const card = document.createElement('article');
    card.className = 'research-card navigation-research-handoff';
    const label = document.createElement('span');
    label.className = 'research-card-label';
    label.textContent = '写作导航带来的研究线索';
    const finding = document.createElement('p');
    finding.className = 'research-claim';
    finding.textContent = navigationHandoff.finding;
    const note = document.createElement('p');
    note.className = 'research-boundary';
    note.textContent = '以下摘录只用于保留写作现场。请在来源列表中选择要研究的资料，再由你明确启动 Research。';
    card.append(label, finding, note);
    for (const evidence of navigationHandoff.evidence) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'research-source';
      const heading = document.createElement('strong');
      heading.textContent = `${evidence.path} · ${evidence.sectionHeading}`;
      const quote = document.createElement('small');
      quote.textContent = `“${evidence.quote}”`;
      open.append(heading, quote);
      open.addEventListener('click', async () => {
        const opened = await window.__workspace?.openFile?.(evidence.path);
        if (opened !== false) {
          window.__workspace?.revealContextChip?.({
            revision: evidence.locator?.revision || null,
            locator: evidence.locator,
          });
        }
      });
      card.appendChild(open);
    }
    researchResults.appendChild(card);
  }

  function renderResearchCards(cards, warnings = []) {
    if (!researchResults) return;
    researchResults.hidden = false;
    researchResults.replaceChildren();
    if (!cards?.length) {
      researchState('没有形成可核验的证据卡。可以缩小问题范围或补充来源。');
      return;
    }
    for (const warning of Array.isArray(warnings) ? warnings : []) {
      if (warning?.code !== 'UNVERIFIED_QUOTES_DROPPED' || typeof warning.message !== 'string') continue;
      const note = document.createElement('div');
      note.className = 'research-state is-warning';
      note.textContent = warning.message;
      researchResults.appendChild(note);
    }
    for (const card of cards) {
      const article = document.createElement('article');
      article.className = 'research-card';
      const claimLabel = document.createElement('span');
      claimLabel.className = 'research-card-label';
      claimLabel.textContent = 'CLAIM · AI 提议主张';
      const claim = document.createElement('p');
      claim.className = 'research-claim';
      claim.textContent = card.claim;
      const sourceLabel = document.createElement('span');
      sourceLabel.className = 'research-card-label';
      sourceLabel.textContent = 'SOURCE · 原文位置已核验';
      const sourceButton = document.createElement('button');
      sourceButton.type = 'button';
      sourceButton.className = 'research-source';
      const sourceTitle = document.createElement('strong');
      sourceTitle.textContent = `${card.source.grade} 级（用户声明类型）· ${card.source.title || card.source.filePath}`;
      const sourceReason = document.createElement('small');
      sourceReason.textContent = `${card.source.gradeReason}。等级依据项目元数据，不等于独立事实核验。`;
      const sourceQuote = document.createElement('small');
      sourceQuote.textContent = `“${card.source.quote}”`;
      sourceButton.append(sourceTitle, sourceReason, sourceQuote);
      const staleNote = document.createElement('p');
      staleNote.className = 'research-boundary';
      staleNote.hidden = true;
      let sourceOpened = false;
      let recordedVerdict = null;
      let judgmentInFlight = false;
      let judgmentSequence = 0;
      const cardProjectInstanceId = window.__workspace?.state?.project?.instanceId || '';
      const cardRenderSequence = researchRequestSequence;
      async function resolve() {
        let resolution;
        try { resolution = await resolveResearchCard(card); }
        catch (error) { resolution = { ok: false, message: error.message }; }
        if (!resolution?.ok) {
          sourceOpened = false;
          staleNote.hidden = false;
          staleNote.textContent = resolution?.message || resolution?.error || '来源已变化，请重新 Research。';
          sourceButton.disabled = true;
          toChanges.disabled = true;
          matchButton.disabled = true;
          mismatchButton.disabled = true;
          return null;
        }
        return resolution.card || resolution;
      }
      sourceButton.addEventListener('click', async () => {
        const resolvedCard = await resolve();
        const resolvedSource = resolvedCard?.source;
        if (resolvedSource) {
          const opened = await openResearchSource(resolvedSource);
          sourceOpened = opened !== false;
          matchButton.disabled = !sourceOpened;
          mismatchButton.disabled = !sourceOpened;
          toChanges.disabled = !sourceOpened || recordedVerdict !== 'matched';
        }
      });
      const boundaryLabel = document.createElement('span');
      boundaryLabel.className = 'research-card-label';
      boundaryLabel.textContent = 'BOUNDARY · 不能外推的边界';
      const boundary = document.createElement('p');
      boundary.className = 'research-boundary';
      boundary.textContent = card.boundary;
      const actions = document.createElement('div');
      actions.className = 'research-card-actions';
      const judgment = document.createElement('div');
      judgment.className = 'research-judgment';
      judgment.setAttribute('role', 'group');
      judgment.setAttribute('aria-label', '作者判断 AI 主张与来源摘录是否匹配');
      const matchButton = document.createElement('button');
      matchButton.type = 'button';
      matchButton.className = 'research-judgment-option';
      matchButton.textContent = '主张匹配';
      matchButton.disabled = true;
      matchButton.setAttribute('aria-pressed', 'false');
      const mismatchButton = document.createElement('button');
      mismatchButton.type = 'button';
      mismatchButton.className = 'research-judgment-option';
      mismatchButton.textContent = '主张不匹配';
      mismatchButton.disabled = true;
      mismatchButton.setAttribute('aria-pressed', 'false');
      const judgmentStatus = document.createElement('span');
      judgmentStatus.className = 'research-judgment-status';
      judgmentStatus.setAttribute('aria-live', 'polite');
      judgmentStatus.textContent = '先打开原文，再判断主张是否匹配';
      judgment.append(matchButton, mismatchButton, judgmentStatus);
      const toChanges = document.createElement('button');
      toChanges.type = 'button';
      toChanges.className = 'research-to-changes';
      toChanges.textContent = '核对后带入修改';
      toChanges.disabled = true;
      async function recordJudgment(verdict) {
        if (judgmentInFlight || !sourceOpened || !cardProjectInstanceId || !bridge?.recordResearchJudgment ||
            !['matched', 'mismatched'].includes(verdict)) return;
        const sequence = ++judgmentSequence;
        judgmentInFlight = true;
        matchButton.disabled = true;
        mismatchButton.disabled = true;
        toChanges.disabled = true;
        judgmentStatus.textContent = '正在保存作者判断…';
        let result;
        try {
          result = await bridge.recordResearchJudgment(cardProjectInstanceId, {
            schema: 'writcraft.research-judgment/v1',
            cardId: card.handoff.cardId,
            verdict,
          });
        } catch (_) {
          result = { ok: false, message: '作者判断暂时无法保存' };
        }
        if (sequence !== judgmentSequence || cardRenderSequence !== researchRequestSequence ||
            cardProjectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
        judgmentInFlight = false;
        const handoffAvailable = result?.ok === true && result?.recorded === true &&
          result?.handoffAvailable === true && result?.evidenceChanged === false;
        if (!handoffAvailable) {
          recordedVerdict = null;
          matchButton.setAttribute('aria-pressed', 'false');
          mismatchButton.setAttribute('aria-pressed', 'false');
          const recordedButLocked = result?.ok === true && result?.recorded === true;
          if (recordedButLocked) {
            sourceOpened = false;
            sourceButton.disabled = true;
            matchButton.disabled = true;
            mismatchButton.disabled = true;
            staleNote.hidden = false;
            const message = result?.message || '判断已记录但证据随后变化，请重新 Research';
            staleNote.textContent = message;
            judgmentStatus.textContent = message;
            document.dispatchEvent?.(new CustomEvent('writcraft:ai-metrics-changed'));
          } else {
            matchButton.disabled = !sourceOpened;
            mismatchButton.disabled = !sourceOpened;
            judgmentStatus.textContent = result?.message || result?.error || '判断未保存，请重试或重新 Research';
          }
          toChanges.disabled = true;
          return;
        }
        matchButton.disabled = !sourceOpened;
        mismatchButton.disabled = !sourceOpened;
        recordedVerdict = verdict;
        matchButton.setAttribute('aria-pressed', String(verdict === 'matched'));
        mismatchButton.setAttribute('aria-pressed', String(verdict === 'mismatched'));
        judgmentStatus.textContent = verdict === 'matched'
          ? '已记录：主张匹配（作者判断，不是事实核验）'
          : '已记录：主张不匹配（作者判断，不是事实核验）';
        toChanges.disabled = verdict !== 'matched';
        document.dispatchEvent?.(new CustomEvent('writcraft:ai-metrics-changed'));
      }
      matchButton.addEventListener('click', () => recordJudgment('matched'));
      mismatchButton.addEventListener('click', () => recordJudgment('mismatched'));
      toChanges.addEventListener('click', async () => {
        if (!sourceOpened || recordedVerdict !== 'matched') return;
        const opened = await window.__changesView?.openResearchCard?.(card.handoff);
        if (opened?.ok === false) {
          staleNote.hidden = false;
          staleNote.textContent = opened.message || '证据卡已无法进入修改，请重新 Research。';
        }
      });
      actions.append(judgment, toChanges);
      article.append(claimLabel, claim, sourceLabel, sourceButton, boundaryLabel, boundary, staleNote, actions);
      researchResults.appendChild(article);
    }
  }

  function updateSelection(sourceId, checked) {
    if (checked) {
      if (!selectedSourceIds.includes(sourceId) && selectedSourceIds.length < 8) selectedSourceIds.push(sourceId);
    } else {
      selectedSourceIds = selectedSourceIds.filter(id => id !== sourceId);
    }
    syncResearchControls();
    render(currentIndex);
  }

  function render(index) {
    currentIndex = index;
    const available = new Set((index.sources || []).map(source => source.id));
    selectedSourceIds = selectedSourceIds.filter(id => available.has(id));
    list.replaceChildren();
    for (const source of index.sources || []) {
      const card = document.createElement('article');
      card.className = 'source-card';
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'source-open';
      const title = document.createElement('strong');
      title.textContent = source.title || source.filePath;
      const sourcePath = document.createElement('div');
      sourcePath.className = 'source-path';
      sourcePath.textContent = source.filePath;
      const meta = document.createElement('div');
      meta.className = 'source-meta';
      const citation = document.createElement('span');
      citation.textContent = source.isReferenced ? `被引用 ${source.citationCount}` : '尚未引用';
      const state = document.createElement('span');
      state.textContent = source.indexStatus === 'indexed' ? '索引正常' : '需要复核';
      meta.append(citation, state);
      if (source.metadata?.author) {
        const author = document.createElement('span');
        author.textContent = source.metadata.author;
        meta.appendChild(author);
      }
      openButton.append(title, sourcePath, meta);
      if (source.metadata?.url) {
        const url = document.createElement('div');
        url.className = 'source-url';
        url.textContent = source.metadata.url;
        openButton.appendChild(url);
      }
      openButton.addEventListener('click', async () => {
        const opened = await window.__workspace?.openFile?.(source.locator.filePath);
        if (opened !== false) {
          window.__workspace?.revealRange?.(
            source.locator.offset,
            Math.max(0, source.locator.end - source.locator.offset)
          );
        }
      });
      const actions = document.createElement('div');
      actions.className = 'source-actions';
      const select = document.createElement('label');
      select.className = 'source-select';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedSourceIds.includes(source.id);
      checkbox.disabled = selectedSourceIds.length >= 8 && !checkbox.checked;
      checkbox.setAttribute('aria-label', `选择 ${source.title || source.filePath} 用于 Research`);
      checkbox.addEventListener('change', () => updateSelection(source.id, checkbox.checked));
      const selectText = document.createElement('span');
      selectText.textContent = '用于 Research';
      select.append(checkbox, selectText);
      const cite = document.createElement('button');
      cite.type = 'button';
      cite.className = 'source-cite';
      cite.textContent = '插入脚注';
      cite.addEventListener('click', async () => {
        const result = await window.__workspace?.insertSourceCitation?.(source, citationStyle?.value || 'apa7');
        setStatus(result?.ok ? `已插入 ${String(citationStyle?.value || 'apa7').toUpperCase()} 脚注` : result?.message || '脚注插入失败', !result?.ok);
      });
      actions.append(select, cite);
      card.append(openButton, actions);
      list.appendChild(card);
    }
    if (!index.sources?.length) empty('尚未发现来源文件。可在 references/ 中创建 Markdown，或用 Front Matter 标记 type: source。');
    const counts = index.counts || {};
    setStatus(`${counts.sources || 0} 个来源 · ${counts.referenced || 0} 个已引用${counts.errors ? ` · ${counts.errors} 个提示` : ''}`);
    syncResearchControls();
  }

  async function runResearch() {
    if (researching || !bridge?.research) return;
    const question = researchQuestion?.value.trim() || '';
    if (!question || !selectedSourceIds.length) return;
    const requestId = ++researchRequestSequence;
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    const sourceIds = [...selectedSourceIds];
    researching = true;
    syncResearchControls();
    researchState('正在只读分析所选来源…');
    let result;
    try {
      await window.__changesView?.cancelResearchForRerun?.();
      if (requestId !== researchRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
      result = await bridge.research(projectInstanceId, question, sourceIds);
    }
    catch (error) { result = { ok: false, message: error.message }; }
    if (requestId !== researchRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    researching = false;
    syncResearchControls();
    if (!result?.ok) {
      researchState(result?.message || result?.error || '本地证据研究失败，项目文件没有被修改。', true);
      return;
    }
    renderResearchCards(result.cards, result.warnings);
  }

  function openWritingNavigation(value) {
    const handoff = normalizeNavigationHandoff(value);
    if (!handoff) return { ok: false, message: '这条研究线索已经失效，请重新生成写作导航。' };
    researchRequestSequence += 1;
    researching = false;
    navigationHandoff = handoff;
    if (researchQuestion) researchQuestion.value = handoff.question;
    window.__workspace?.setSidebarView?.('sources');
    active = true;
    syncResearchControls();
    renderNavigationHandoff();
    researchQuestion?.focus?.();
    return { ok: true };
  }

  async function refresh() {
    if (indexLoading || !active) return;
    if (!window.__workspace?.state?.project) {
      empty('请先创建或打开一个项目。');
      setStatus('没有打开的项目', true);
      return;
    }
    const requestId = ++indexRequestSequence;
    const projectInstanceId = window.__workspace.state.project.instanceId;
    indexLoading = true;
    refreshButton.disabled = true;
    setStatus('正在建立本地来源索引…');
    let result;
    try { result = await bridge.buildSourceIndex(projectInstanceId); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (requestId !== indexRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    indexLoading = false;
    refreshButton.disabled = false;
    if (!result?.ok) {
      empty('来源索引失败，项目正文没有被修改。');
      setStatus(result?.message || result?.error || '索引失败', true);
      return;
    }
    render(result.index);
  }

  async function importReference() {
    if (importing) return;
    if (!window.__workspace?.state?.project) {
      setStatus('请先创建或打开一个项目', true);
      return;
    }
    const requestId = ++importRequestSequence;
    const projectInstanceId = window.__workspace.state.project.instanceId;
    importing = true;
    refreshButton.disabled = true;
    importButton.disabled = true;
    setStatus('请选择 PDF、TXT 或 Markdown 来源…');
    let result;
    try { result = await bridge.importReference(projectInstanceId); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (requestId !== importRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    importing = false;
    refreshButton.disabled = false;
    importButton.disabled = false;
    if (result?.canceled) {
      setStatus('已取消导入');
      return;
    }
    if (!result?.ok) {
      setStatus(result?.message || result?.error || '来源导入失败；现有文件未被覆盖', true);
      return;
    }
    render(result.index);
    await window.__workspace?.refreshTree?.();
    if (requestId !== importRequestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    setStatus(`已导入：${result.reference?.title || result.reference?.sidecarPath || '来源附件'}`);
  }

  function open() {
    active = true;
    refresh();
  }

  importButton?.addEventListener('click', importReference);
  refreshButton?.addEventListener('click', refresh);
  researchQuestion?.addEventListener('input', syncResearchControls);
  researchRun?.addEventListener('click', runResearch);
  document.addEventListener('writcraft:tree-changed', () => { if (active) refresh(); });
  document.addEventListener('writcraft:project-entered', () => {
    indexRequestSequence += 1;
    importRequestSequence += 1;
    indexLoading = false;
    importing = false;
    refreshButton.disabled = false;
    importButton.disabled = false;
    selectedSourceIds = [];
    currentIndex = null;
    navigationHandoff = null;
    researching = false;
    clearResearchResults();
    syncResearchControls();
    if (active) refresh();
  });
  document.addEventListener('writcraft:sidebar-view-changed', event => {
    active = event.detail === 'sources';
  });

  window.__sourcesView = { activate: open, openWritingNavigation };
})();
