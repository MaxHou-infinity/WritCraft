'use strict';

// Project Home renders only Main-owned facts. It never scans the Renderer tree
// or editor text, and every card resolves again through Main before navigation.
(function () {
  const bridge = window.writCraft?.project?.dailyWorkspace;
  const view = document.getElementById('project-home-view');
  const title = document.getElementById('project-home-title');
  const status = document.getElementById('project-home-status');
  const summary = document.getElementById('project-home-summary');
  const grid = document.getElementById('project-home-grid');
  const refreshButton = document.getElementById('project-home-refresh');
  const backButton = document.getElementById('project-home-back');
  if (!bridge || !view || !status || !summary || !grid) return;

  let requestSequence = 0;
  let navigationSequence = 0;
  let origin = null;

  function project() { return window.__workspace?.state?.project || null; }
  function beginNavigation() {
    const active = project();
    if (!active) throw new Error('请先打开项目');
    const sequence = ++navigationSequence;
    return Object.freeze({
      projectInstanceId: active.instanceId,
      sequence,
      isCurrent() {
        return sequence === navigationSequence && project()?.instanceId === active.instanceId;
      },
    });
  }
  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('is-error', error);
  }
  function captureOrigin() {
    const path = window.__workspace?.getCurrentPath?.() || '';
    origin = path ? {
      projectInstanceId: project()?.instanceId || null,
      path,
      caretOffset: window.__workspace?.getCursorOffset?.() || 0,
      scrollTop: window.__workspace?.state?.views?.[path]?.scrollTop || 0,
    } : null;
  }

  function stat(value, label) {
    const item = document.createElement('div');
    item.className = 'project-home-stat';
    const count = document.createElement('strong');
    count.textContent = new Intl.NumberFormat('zh-CN').format(value || 0);
    const copy = document.createElement('span');
    copy.textContent = label;
    item.append(count, copy);
    return item;
  }

  function createCard(kind, heading, note) {
    const card = document.createElement('section');
    card.className = 'project-home-card';
    card.dataset.homeCard = kind;
    const h2 = document.createElement('h2');
    h2.textContent = heading;
    const p = document.createElement('p');
    p.textContent = note;
    const list = document.createElement('div');
    list.className = 'project-home-list';
    card.append(h2, p, list);
    return { card, list };
  }

  function appendEmpty(list, text) {
    const empty = document.createElement('div');
    empty.className = 'project-home-empty';
    empty.textContent = text;
    list.appendChild(empty);
  }

  function appendAction(list, label, detail, action, primary = false) {
    const row = document.createElement('div');
    row.className = 'project-home-item';
    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = detail;
    copy.append(strong, small);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.classList.toggle('is-primary', primary);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await action.run(); }
      catch (error) { setStatus(error.message || '项目位置暂时无法打开', true); }
      finally { button.disabled = false; }
    });
    row.append(copy, button);
    list.appendChild(row);
  }

  async function resolveTarget(active, locator) {
    const response = await bridge.resolveStableLocation(active.instanceId, locator);
    if (!response?.ok) throw new Error(response?.message || '项目位置已经变化');
    const target = response.result?.target;
    if (target?.action !== 'open_file') throw new Error('项目位置当前无法打开');
    return target;
  }

  async function openResolved(locator, savedPosition = null) {
    const owner = beginNavigation();
    const active = { instanceId: owner.projectInstanceId };
    let target = await resolveTarget(active, locator);
    if (!owner.isCurrent()) return;
    // Establish the recovery path before leaving Home. File opening may await
    // save/reload work that legitimately publishes authority events; delaying
    // this push until the whole chain finishes can strand the author in the
    // destination without a return action. If opening later fails, Home is
    // still a safe and truthful recovery target. Project switch resets it.
    window.__workspace?.pushReturnLocation?.({
      view: 'project_home', stableLocator: null, scrollTop: view.scrollTop, editorReturnState: null,
    });
    window.__workspace?.setWorkspaceView?.('explorer');
    let opened = await window.__workspace?.openFile?.(target.filePath, { pin: true });
    if (!owner.isCurrent() || opened === false) return;
    if (window.__workspace?.state?.revision !== target.revision) {
      // A watcher may publish a newer revision between resolve and open. Re-resolve
      // exactly once through Main; never guess an offset from stale Renderer state.
      target = await resolveTarget(active, locator);
      if (!owner.isCurrent()) return;
      opened = await window.__workspace?.openFile?.(target.filePath, { pin: true });
      if (!owner.isCurrent() || opened === false) return;
      if (window.__workspace?.state?.revision !== target.revision) {
        throw new Error('正文持续变化，暂时无法安全定位');
      }
    }
    if (!owner.isCurrent()) return;
    // `openFile` publishes the ordinary current-file event, but that listener
    // is intentionally asynchronous. Home navigation is a stronger UX
    // boundary: do not expose the destination while its sidebar can still
    // describe the previous document. A second owner-bound refresh supersedes
    // any event-started request and settles before the final reveal.
    await window.__dailyWorkspaceView?.refreshOutline?.();
    if (!owner.isCurrent()) return;
    const offset = savedPosition && savedPosition.revision === target.revision
      ? savedPosition.caretOffset
      : target.offset;
    window.__workspace?.revealRange?.(offset, savedPosition ? 0 : Math.max(0, target.endOffset - target.offset));
    if (savedPosition && savedPosition.revision !== target.revision) {
      setStatus('正文已变化，已打开当前版本的安全位置。');
    }
  }

  function openPending(reviewLocationId) {
    const owner = beginNavigation();
    window.__workspace?.setWorkspaceView?.('explorer');
    let accepted = false;
    document.dispatchEvent(new CustomEvent('writcraft:open-pending-review', {
      detail: { reviewLocationId, accept() { accepted = true; } },
    }));
    if (accepted && owner.isCurrent()) {
      window.__workspace?.pushReturnLocation?.({
        view: 'project_home', stableLocator: null, scrollTop: view.scrollTop, editorReturnState: null,
      });
    }
  }

  function render(snapshot) {
    title.textContent = `${project()?.name || '写作项目'} · 今日工作台`;
    summary.replaceChildren(
      stat(snapshot.summary?.manuscriptWordCount, '正文词数'),
      stat(snapshot.summary?.manuscriptFileCount, '正文文件'),
      stat(snapshot.pendingReviews?.length, '当前会话待审 Diff')
    );
    grid.replaceChildren();

    const continueCard = createCard('continue', '继续写作', '回到 Main 保存的真实写作位置，不猜测你“应该”写哪里。');
    if (snapshot.continueLocation) {
      appendAction(continueCard.list, snapshot.continueLocation.path,
        `光标 ${snapshot.continueLocation.caretOffset} · 已保存位置`, {
          label: '继续写', run: () => openResolved(
            { kind: 'file', path: snapshot.continueLocation.path },
            snapshot.continueLocation
          ),
        }, true);
    } else appendEmpty(continueCard.list, '还没有可恢复的写作位置。请从项目文件开始。');
    grid.appendChild(continueCard.card);

    const pendingCard = createCard('pending', '待审修改', '只显示当前会话仍有效的 Diff；接受前不会写入正文。');
    if (snapshot.pendingReviews?.length) {
      snapshot.pendingReviews.forEach(item => appendAction(pendingCard.list, item.label,
        `${item.fileCount} 个文件 · ${item.hunkCount} 项修改`, {
          label: '审阅 Diff', run: async () => openPending(item.locationId),
        }, true));
    } else appendEmpty(pendingCard.list, '当前没有待审 Diff。');
    grid.appendChild(pendingCard.card);

    const recentCard = createCard('recent', '最近修改', '依据磁盘修改时间稳定排序，不读取未保存草稿。');
    if (snapshot.recentFiles?.length) {
      snapshot.recentFiles.forEach(item => appendAction(recentCard.list, item.path,
        new Date(item.mtimeMs).toLocaleString('zh-CN'), {
          label: '打开', run: () => openResolved(item.stableLocator),
        }));
    } else appendEmpty(recentCard.list, '尚无可确认的最近正文。');
    grid.appendChild(recentCard.card);

    const issueCard = createCard('issues', '需要核对', '只列 Graph 中仍为 open 的一致性问题与正文显式来源缺口。');
    const issues = [
      ...(snapshot.openIssues || []).map(item => ({ ...item, detail: item.severity || '一致性问题' })),
      ...(snapshot.explicitSourceGaps || []).map(item => ({ ...item, detail: '显式来源缺口' })),
    ];
    if (issues.length) {
      issues.forEach(item => appendAction(issueCard.list, item.title, item.detail, {
        label: '查看依据', run: () => openResolved(item.stableLocator),
      }));
    } else appendEmpty(issueCard.list, '没有已确认的 open 问题或显式来源缺口。');
    grid.appendChild(issueCard.card);

    const chapterCard = createCard('chapters', '正文一览', '状态只描述空白、骨架或已有正文，不判断是否完成。');
    if (snapshot.chapterStates?.length) {
      snapshot.chapterStates.slice(0, 12).forEach(item => appendAction(chapterCard.list, item.path,
        `${({ blank: '空白', skeleton: '章节骨架', body: '已有正文' })[item.baseState] || '正文'} · ${item.wordCount} 词${item.flags?.length ? ` · ${item.flags.join(' / ')}` : ''}`, {
          label: '打开', run: () => openResolved(item.stableLocator),
        }));
    } else appendEmpty(chapterCard.list, '项目中还没有正文文件。');
    grid.appendChild(chapterCard.card);
  }

  async function refresh() {
    const active = project();
    const owner = ++requestSequence;
    summary.replaceChildren();
    grid.replaceChildren();
    view.setAttribute('aria-busy', 'true');
    refreshButton.disabled = true;
    setStatus('正在核对项目文件、待审修改与本地索引…');
    try {
      if (!active) throw new Error('请先创建或打开项目');
      const response = await bridge.snapshot(active.instanceId);
      if (owner !== requestSequence || project()?.instanceId !== active.instanceId) return;
      if (!response?.ok || !response.snapshot) throw new Error(response?.message || '项目首页暂时不可用');
      render(response.snapshot);
      setStatus(response.snapshot.status === 'partial'
        ? '部分本地索引暂不可用；已验证的入口仍可使用。'
        : '已根据当前项目事实更新。');
    } catch (error) {
      if (owner === requestSequence) setStatus(error.message, true);
    } finally {
      if (owner === requestSequence) {
        view.setAttribute('aria-busy', 'false');
        refreshButton.disabled = false;
      }
    }
  }

  async function returnToOrigin() {
    const target = origin;
    if (!target || project()?.instanceId !== target.projectInstanceId) return;
    const owner = beginNavigation();
    window.__workspace?.setWorkspaceView?.('explorer');
    const opened = await window.__workspace?.openFile?.(target.path, { pin: true });
    if (!owner.isCurrent()) return;
    if (opened !== false) window.__workspace?.revealRange?.(target.caretOffset, 0);
  }
  backButton.addEventListener('click', returnToOrigin);
  refreshButton.addEventListener('click', refresh);
  document.addEventListener('writcraft:workspace-view-changed', event => {
    if (event.detail?.view !== 'home') return;
    if (event.detail?.previous !== 'home') captureOrigin();
    void refresh();
  });
  document.addEventListener('writcraft:project-entering', () => {
    requestSequence += 1;
    navigationSequence += 1;
    origin = null;
  });
  document.addEventListener('writcraft:project-entered', () => {
    requestSequence += 1;
    navigationSequence += 1;
    if (document.querySelector('.app-shell')?.dataset.workspaceView === 'home') void refresh();
  });
  ['writcraft:tree-changed', 'writcraft:current-file-authority-changed'].forEach(eventName => {
    document.addEventListener(eventName, () => {
      if (document.querySelector('.app-shell')?.dataset.workspaceView === 'home') void refresh();
    });
  });
  window.__projectHomeView = Object.freeze({ refresh });
})();
