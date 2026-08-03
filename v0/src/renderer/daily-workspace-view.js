'use strict';

// Renderer owns presentation only. Main returns opaque locations and resolves
// them again at activation time under the current project authority.
(function () {
  const State = window.WritCraftDailyWorkspaceState;
  const bridge = window.writCraft?.project?.dailyWorkspace;
  const outlineList = document.getElementById('current-outline-list');
  const outlineStatus = document.getElementById('current-outline-status');
  const dialog = document.getElementById('quick-open-dialog');
  const input = document.getElementById('quick-open-input');
  const results = document.getElementById('quick-open-results');
  const quickStatus = document.getElementById('quick-open-status');
  const narrowOutlineToggle = document.getElementById('narrow-outline-toggle');
  const projectSidebar = document.querySelector('.project-sidebar');
  if (!State || !bridge || !outlineList || !dialog || !input || !results) return;

  const outlineState = State.create();
  const quickState = State.create();
  const collapsedOutlineIds = new Set();
  let queryTimer = null;
  let activationSequence = 0;
  let outlineRevision = '';

  function persistOutlineState(activeOutlineId = null) {
    window.__workspace?.updateOutlineViewState?.({
      activeOutlineId,
      collapsedOutlineIds: [...collapsedOutlineIds],
    });
  }

  function closeNarrowOutline() {
    projectSidebar?.classList.remove('is-narrow-outline-open');
    narrowOutlineToggle?.setAttribute('aria-expanded', 'false');
  }

  function project() { return window.__workspace?.state?.project || null; }
  function unwrap(response) { return response?.ok ? response.result : null; }
  function safeMessage(response, fallback) { return response?.message || response?.error || fallback; }

  async function activate(item) {
    const active = project();
    if (!active || !item?.locationId) return false;
    const owner = Object.freeze({ projectInstanceId: active.instanceId, sequence: ++activationSequence });
    const isCurrent = () => owner.sequence === activationSequence && project()?.instanceId === owner.projectInstanceId;
    let response = await bridge.resolveLocation(active.instanceId, item.locationId);
    if (!isCurrent()) return false;
    if (!response?.ok) throw new Error(safeMessage(response, '这个位置已经变化，请重新打开。'));
    let resolved = response.result;
    if (resolved?.target?.action === 'open_review') {
      const editorReturnState = window.__workspace?.captureEditorReturnState?.();
      let accepted = false;
      document.dispatchEvent(new CustomEvent('writcraft:open-pending-review', {
        detail: {
          reviewLocationId: resolved.target.reviewLocationId,
          activationSequence: owner.sequence,
          accept: () => { accepted = true; },
        },
      }));
      if (!isCurrent() || !accepted) throw new Error('这份待审修改无法在当前页面恢复，请回到原任务重新生成。');
      if (editorReturnState) window.__workspace?.pushReturnLocation?.({
        view: 'editor',
        stableLocator: { kind: 'file', path: editorReturnState.path },
        scrollTop: editorReturnState.scrollTop,
        editorReturnState,
      });
      closeQuickOpen();
      return true;
    }
    let target = resolved?.target;
    if (!target || target.action !== 'open_file') throw new Error('这个位置当前无法打开。');
    const workspaceState = window.__workspace?.state;
    if (target.filePath === window.__workspace?.getCurrentPath?.() &&
        (workspaceState?.dirty || workspaceState?.conflictRecovery || workspaceState?.externalDeleted)) {
      throw new Error('请先保存当前文稿或处理外部冲突，再定位标题。');
    }
    const editorReturnState = window.__workspace?.captureEditorReturnState?.();
    const opened = await window.__workspace?.openFile?.(target.filePath, { pin: true });
    if (!isCurrent()) return false;
    if (opened === false) return false;
    if (window.__workspace?.state?.revision !== target.revision) {
      response = await bridge.resolveLocation(active.instanceId, item.locationId);
      if (!isCurrent()) return false;
      if (!response?.ok) throw new Error(safeMessage(response, '文稿已变化，请重新选择位置。'));
      resolved = response.result;
      target = resolved?.target;
      if (!target || target.action !== 'open_file' || target.revision !== window.__workspace?.state?.revision) {
        throw new Error('文稿仍在变化，本次没有跳转。请稍后重试。');
      }
    }
    if (editorReturnState) window.__workspace?.pushReturnLocation?.({
      view: 'editor',
      stableLocator: { kind: 'file', path: editorReturnState.path },
      scrollTop: editorReturnState.scrollTop,
      editorReturnState,
    });
    window.__workspace?.revealRange?.(target.offset, Math.max(0, target.endOffset - target.offset));
    closeNarrowOutline();
    closeQuickOpen();
    return true;
  }

  function outlineMessage(text, error = false) {
    outlineStatus.textContent = text;
    outlineStatus.classList.toggle('is-error', error);
  }

  function syncOutlineCurrent() {
    const workspaceState = window.__workspace?.state;
    if (!outlineState.items.length || outlineState.currentPath !== window.__workspace?.getCurrentPath?.()) return;
    const safe = !workspaceState?.dirty && !workspaceState?.conflictRecovery && !workspaceState?.externalDeleted &&
      workspaceState?.revision === outlineRevision;
    const offset = safe ? (window.__workspace?.getFirstVisibleOffset?.() ?? window.__workspace?.getCursorOffset?.()) : null;
    let current = null;
    for (const item of outlineState.items) {
      if (item.startOffset <= offset && offset <= item.endOffset) current = item.outlineId;
    }
    outlineList.querySelectorAll('.outline-item').forEach(row => {
      if (Number.isSafeInteger(offset) && row.dataset.outlineId === current) row.setAttribute('aria-current', 'location');
      else row.removeAttribute('aria-current');
    });
    const stored = window.__workspace?.state?.views?.[outlineState.currentPath]?.activeOutlineId || null;
    if (stored !== current) persistOutlineState(current);
  }

  function renderOutline() {
    outlineList.replaceChildren();
    if (!outlineState.items.length) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = outlineState.status === 'error' ? '暂时无法读取大纲' : '当前文稿没有标题';
      outlineList.appendChild(empty);
      return;
    }
    const itemById = new Map(outlineState.items.map(item => [item.outlineId, item]));
    const hasChildren = new Set(outlineState.items.map(item => item.parentOutlineId).filter(Boolean));
    const hiddenByAncestor = item => {
      let parentId = item.parentOutlineId;
      while (parentId) {
        if (collapsedOutlineIds.has(parentId)) return true;
        parentId = itemById.get(parentId)?.parentOutlineId || null;
      }
      return false;
    };
    for (const [index, item] of outlineState.items.entries()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'outline-item';
      row.dataset.outlineIndex = String(index);
      row.dataset.outlineId = item.outlineId;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(item.level));
      row.tabIndex = index === 0 ? 0 : -1;
      row.hidden = hiddenByAncestor(item);
      if (hasChildren.has(item.outlineId)) row.setAttribute('aria-expanded', String(!collapsedOutlineIds.has(item.outlineId)));
      const level = Number(item.level) || 1;
      row.style.setProperty('--outline-depth', String(Math.max(0, level - 1)));
      row.textContent = item.label;
      row.title = item.occurrence > 1 ? `${item.label} · 同名标题 ${item.occurrence}` : item.label;
      row.addEventListener('click', () => activate(item).catch(error => outlineMessage(error.message, true)));
      outlineList.appendChild(row);
    }
    syncOutlineCurrent();
  }

  function visibleOutlineRows() {
    return [...outlineList.querySelectorAll('.outline-item')].filter(row => !row.hidden);
  }

  outlineList.addEventListener('keydown', event => {
    const row = event.target.closest?.('.outline-item');
    if (!row) return;
    const rows = visibleOutlineRows();
    const index = rows.indexOf(row);
    let target = null;
    if (event.key === 'ArrowDown') target = rows[Math.min(rows.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') target = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') target = rows[0];
    else if (event.key === 'End') target = rows[rows.length - 1];
    else if (event.key === 'ArrowRight' && row.hasAttribute('aria-expanded')) {
      const id = row.dataset.outlineId;
      if (collapsedOutlineIds.delete(id)) { persistOutlineState(id); renderOutline(); target = outlineList.querySelector(`[data-outline-id="${id}"]`); }
      else target = rows[index + 1];
    } else if (event.key === 'ArrowLeft') {
      const item = outlineState.items[Number(row.dataset.outlineIndex)];
      if (row.getAttribute('aria-expanded') === 'true') {
        collapsedOutlineIds.add(item.outlineId);
        persistOutlineState(item.outlineId);
        renderOutline();
        target = outlineList.querySelector(`[data-outline-id="${item.outlineId}"]`);
      } else if (item?.parentOutlineId) target = outlineList.querySelector(`[data-outline-id="${item.parentOutlineId}"]`);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      row.click();
      return;
    } else return;
    event.preventDefault();
    if (target) {
      outlineList.querySelectorAll('.outline-item').forEach(item => { item.tabIndex = item === target ? 0 : -1; });
      target.focus();
    }
  });

  async function refreshOutline() {
    const active = project();
    const path = window.__workspace?.getCurrentPath?.() || '';
    collapsedOutlineIds.clear();
    for (const id of window.__workspace?.state?.views?.[path]?.collapsedOutlineIds || []) {
      collapsedOutlineIds.add(id);
    }
    State.bind(outlineState, active?.instanceId, path);
    if (!active || !path || !/\.(?:md|markdown)$/i.test(path)) {
      outlineMessage('打开 Markdown 后显示章节标题');
      renderOutline();
      return;
    }
    const owner = State.begin(outlineState);
    outlineMessage('正在读取当前文稿…');
    let response;
    try { response = await bridge.listOutline(active.instanceId, { path, requestId: owner.requestId }); }
    catch (error) { response = { ok: false, message: error.message }; }
    if (!response?.ok || !State.settle(outlineState, owner, unwrap(response))) {
      if (response?.ok) return;
      State.fail(outlineState, owner);
      outlineMessage(safeMessage(response, '大纲读取失败'), true);
      renderOutline();
      return;
    }
    outlineRevision = unwrap(response)?.revision || '';
    const validOutlineIds = new Set(outlineState.items.map(item => item.outlineId));
    let outlineStateChanged = false;
    for (const id of [...collapsedOutlineIds]) {
      if (validOutlineIds.has(id)) continue;
      collapsedOutlineIds.delete(id);
      outlineStateChanged = true;
    }
    const savedActiveId = window.__workspace?.state?.views?.[path]?.activeOutlineId || null;
    if (savedActiveId && !validOutlineIds.has(savedActiveId)) outlineStateChanged = true;
    if (outlineStateChanged) {
      window.__workspace?.updateOutlineViewState?.(path, {
        activeOutlineId: validOutlineIds.has(savedActiveId) ? savedActiveId : null,
        collapsedOutlineIds: [...collapsedOutlineIds],
      });
    }
    outlineMessage(`${outlineState.items.length} 个标题${outlineState.status === 'partial' ? ' · 结果已截断' : ''}`);
    renderOutline();
  }

  function renderQuick() {
    results.replaceChildren();
    let previousKind = null;
    quickState.items.forEach((item, index) => {
      if (item.kind !== previousKind) {
        previousKind = item.kind;
        const group = document.createElement('div');
        group.className = 'quick-open-group';
        group.setAttribute('role', 'presentation');
        group.textContent = ({ file: '文件', heading: '标题', entity: '人物与概念', issue: '一致性问题', pending_review: '待审 Diff' })[item.kind] || item.kind;
        results.appendChild(group);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'quick-open-item';
      row.id = `quick-open-option-${index}`;
      row.role = 'option';
      row.setAttribute('aria-selected', String(index === quickState.selectedIndex));
      const kind = document.createElement('span');
      kind.className = 'quick-open-kind';
      kind.textContent = ({ file: '文件', heading: '标题', entity: '人物/概念', issue: '一致性问题', pending_review: '待审 Diff' })[item.kind] || item.kind;
      const copy = document.createElement('span');
      copy.className = 'quick-open-copy';
      const title = document.createElement('strong');
      title.textContent = item.label;
      const detail = document.createElement('small');
      detail.textContent = item.breadcrumb || item.detail;
      copy.append(title, detail);
      row.append(kind, copy);
      row.addEventListener('mouseenter', () => { quickState.selectedIndex = index; renderQuick(); });
      row.addEventListener('click', () => activate(item).catch(error => { quickStatus.textContent = error.message; }));
      results.appendChild(row);
    });
    const selected = quickState.selectedIndex >= 0 ? `quick-open-option-${quickState.selectedIndex}` : '';
    if (selected) input.setAttribute('aria-activedescendant', selected);
    else input.removeAttribute('aria-activedescendant');
    if (!quickState.items.length) {
      const empty = document.createElement('div');
      empty.className = 'quick-open-empty';
      empty.textContent = quickState.status === 'querying' ? '正在整理位置…' : quickState.status === 'error' ? '暂时无法读取项目位置' : '没有匹配位置';
      results.appendChild(empty);
    }
    if (selected) document.getElementById(selected)?.scrollIntoView?.({ block: 'nearest' });
  }

  function groupQuickItems() {
    const order = new Map(State.KINDS.map((kind, index) => [kind, index]));
    quickState.items.sort((left, right) => (order.get(left.kind) ?? 99) - (order.get(right.kind) ?? 99));
  }

  async function queryQuick() {
    clearTimeout(queryTimer);
    if (quickState.composing) return;
    const active = project();
    if (!active) return;
    const owner = State.begin(quickState);
    quickStatus.textContent = '正在定位…';
    renderQuick();
    let response;
    try {
      response = await bridge.listLocations(active.instanceId, {
        query: input.value,
        kinds: State.KINDS,
        limit: 60,
        requestId: owner.requestId,
      });
    } catch (error) { response = { ok: false, message: error.message }; }
    if (!response?.ok) {
      if (!State.fail(quickState, owner)) return;
      quickStatus.textContent = safeMessage(response, '快速打开失败');
      renderQuick();
      return;
    }
    if (!State.settle(quickState, owner, unwrap(response))) return;
    groupQuickItems();
    quickStatus.textContent = `${quickState.items.length} 个位置${quickState.status === 'partial' ? ' · 结果已截断' : ''}`;
    renderQuick();
  }

  function openQuickOpen() {
    const active = project();
    if (!active) return;
    State.bind(quickState, active.instanceId, window.__workspace?.getCurrentPath?.() || '');
    quickState.open = true;
    dialog.showModal();
    input.setAttribute('aria-expanded', 'true');
    input.value = '';
    input.focus();
    queryQuick();
  }

  function closeQuickOpen() {
    clearTimeout(queryTimer);
    quickState.querySequence += 1;
    quickState.open = false;
    activationSequence += 1;
    if (dialog.open) dialog.close();
    input.setAttribute('aria-expanded', 'false');
  }

  input.addEventListener('compositionstart', () => {
    clearTimeout(queryTimer);
    quickState.composing = true;
    // Invalidate a pre-composition request as well: its late result must not
    // rebuild the list while the author's IME owns the input session.
    quickState.querySequence += 1;
  });
  input.addEventListener('compositionend', () => { quickState.composing = false; queryQuick(); });
  input.addEventListener('input', () => {
    if (quickState.composing) return;
    clearTimeout(queryTimer);
    queryTimer = setTimeout(queryQuick, 120);
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || quickState.composing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      State.move(quickState, event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key.toLowerCase());
      renderQuick();
      return;
    }
    if (event.key === 'Enter' && quickState.selectedIndex >= 0) {
      event.preventDefault();
      activate(quickState.items[quickState.selectedIndex]).catch(error => { quickStatus.textContent = error.message; });
    }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeQuickOpen(); });
  document.getElementById('quick-open-close')?.addEventListener('click', closeQuickOpen);
  narrowOutlineToggle?.addEventListener('click', () => {
    const open = !projectSidebar?.classList.contains('is-narrow-outline-open');
    projectSidebar?.classList.toggle('is-narrow-outline-open', open);
    narrowOutlineToggle.setAttribute('aria-expanded', String(open));
    if (open) visibleOutlineRows()[0]?.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && projectSidebar?.classList.contains('is-narrow-outline-open')) {
      closeNarrowOutline();
      narrowOutlineToggle?.focus();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      if (dialog.open) closeQuickOpen(); else openQuickOpen();
    }
  });
  document.addEventListener('writcraft:project-entering', () => { outlineRevision = ''; State.bind(outlineState, null); State.bind(quickState, null); closeNarrowOutline(); closeQuickOpen(); });
  document.addEventListener('writcraft:project-entry-failed', () => { outlineRevision = ''; State.bind(outlineState, null); State.bind(quickState, null); closeNarrowOutline(); closeQuickOpen(); });
  document.addEventListener('writcraft:project-entered', refreshOutline);
  document.addEventListener('writcraft:current-file-changed', refreshOutline);
  document.addEventListener('writcraft:current-file-authority-changed', event => {
    const detail = event.detail || {};
    const active = project();
    if (!active || detail.projectInstanceId !== active.instanceId ||
        detail.path !== window.__workspace?.getCurrentPath?.()) return;
    if (detail.status === 'saved') {
      refreshOutline();
      return;
    }
    if (detail.status === 'conflict' || detail.status === 'missing') {
      outlineRevision = '';
      syncOutlineCurrent();
      outlineMessage(detail.status === 'missing'
        ? '文件已从磁盘删除 · 大纲暂停更新'
        : '外部修改待处理 · 大纲暂停更新', true);
    }
  });
  document.addEventListener('selectionchange', syncOutlineCurrent);
  document.querySelector('.editor-scroll')?.addEventListener('scroll', syncOutlineCurrent, { passive: true });

  window.__dailyWorkspaceView = Object.freeze({ refreshOutline, openQuickOpen, closeQuickOpen });
})();
