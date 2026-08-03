// WritCraft V0 · Project workspace controller

(function () {
  const bridge = window.writCraft && window.writCraft.project;
  const rewriteBridge = window.writCraft;
  const inlineRewriteTransaction = window.WritCraftInlineRewriteTransaction;
  const externalSyncState = window.WritCraftExternalSyncState?.createExternalSyncState();
  const projectTitle = document.getElementById('project-title');
  const projectTree = document.getElementById('project-tree');
  const tabBar = document.getElementById('tab-bar');
  const editor = document.getElementById('editor');
  const documentTitle = document.getElementById('document-title');
  const documentPath = document.getElementById('document-path');
  const editContextChip = document.getElementById('edit-context-chip');
  const workspaceReturn = document.getElementById('workspace-return');
  const editDiagnosticPanel = document.getElementById('edit-diagnostic-panel');
  const editDiagnosticList = document.getElementById('edit-diagnostic-list');
  const editDiagnosticRepair = document.getElementById('edit-diagnostic-repair');
  const editDiagnosticFeedback = document.getElementById('edit-diagnostic-feedback');
  const saveState = document.getElementById('save-state');
  const welcome = document.getElementById('welcome');
  const appShell = document.querySelector('.app-shell');
  const workArea = document.getElementById('work-area');
  const chatPanel = document.getElementById('chat-panel');
  const editorScroll = document.querySelector('.editor-scroll');
  const createButtons = [
    document.getElementById('sidebar-create-project'),
    document.getElementById('welcome-create-project'),
  ].filter(Boolean);
  const openButtons = [
    document.getElementById('sidebar-open-project'),
    document.getElementById('welcome-open-project'),
  ].filter(Boolean);
  const newFileButton = document.getElementById('new-file-button');
  const markdownTrash = document.getElementById('markdown-trash');
  const markdownTrashToggle = document.getElementById('markdown-trash-toggle');
  const markdownTrashPanel = document.getElementById('markdown-trash-panel');
  const markdownTrashStatus = document.getElementById('markdown-trash-status');
  const markdownTrashList = document.getElementById('markdown-trash-list');
  const markdownTrashRefresh = document.getElementById('markdown-trash-refresh');
  const createDialog = document.getElementById('project-dialog');
  const createForm = document.getElementById('project-form');
  const projectNameInput = document.getElementById('project-name-input');
  const newFileDialog = document.getElementById('file-dialog');
  const newFileForm = document.getElementById('file-form');
  const newFileInput = document.getElementById('file-path-input');
  const conflictActions = document.getElementById('conflict-actions');
  const conflictKeepLocal = document.getElementById('conflict-keep-local');
  const conflictUseDisk = document.getElementById('conflict-use-disk');
  const explorerView = document.getElementById('sidebar-explorer-view');
  const searchView = document.getElementById('sidebar-search-view');
  const sourcesView = document.getElementById('sidebar-sources-view');
  const migrationDialog = document.getElementById('migration-dialog');
  const migrationForm = document.getElementById('migration-form');
  const migrationTitle = document.getElementById('migration-title');
  const migrationDescription = document.getElementById('migration-description');
  const migrationTarget = document.getElementById('migration-target');
  const migrationPreview = document.getElementById('migration-preview');
  const migrationWarnings = document.getElementById('migration-warnings');
  const migrationLater = document.getElementById('migration-later');
  const migrationDiscard = document.getElementById('migration-discard');
  const migrationConfirm = document.getElementById('migration-confirm');
  const onboardingHost = document.getElementById('project-onboarding-host');
  const startOnboardingButton = document.getElementById('start-project-onboarding');
  const projectMenu = document.getElementById('project-menu');
  const WORKSPACE_VIEWS = new Set(['home', 'explorer', 'search', 'sources', 'graph']);
  let activeWorkspaceView = 'explorer';
  let migrationResolver = null;
  let legacyDraftSnoozed = false;
  let treeOpenTimer = null;
  let markdownTrashSequence = 0;
  let externalChangeSequence = 0;
  let markdownTrashBusy = false;
  let markdownTrashOwner = null;

  const state = {
    project: null,
    projectReady: false,
    tree: [],
    tabs: [],
    previewPath: null,
    currentPath: '',
    editContext: '',
    editContextRevision: '',
    projectPromptMissing: false,
    promptFrontMatter: null,
    revision: null,
    editVersion: 0,
    aiContextGeneration: 0,
    activeChatRequestToken: 0,
    dirty: false,
    saveTimer: null,
    savePromise: null,
    workspaceTimer: null,
    workspaceSavePromise: null,
    returnOperationGeneration: 0,
    views: {},
    returnStack: [],
    conflictRecovery: false,
    conflictRevision: null,
    externalDeleted: false,
    loading: false,
    openGeneration: 0,
    projectEntryGeneration: 0,
    projectEntryRequestGeneration: 0,
    projectEntryRequestOwner: null,
    onboardingController: null,
    onboardingDraft: null,
    inlineMutationBlocked: false,
    inlineMutationBlockReason: '',
    mutationBlockers: {},
    inlineRecoveryGeneration: 0,
    changesHistoryRecoveryGeneration: 0,
    changesHistoryRecovery: null,
  };

  function beginProjectEntry() {
    state.projectEntryGeneration += 1;
    // A watcher callback can already be inside an awaited tree/file read when
    // the author starts switching projects. Invalidate that callback before
    // any project-entry await, not only after the new descriptor is installed.
    externalChangeSequence += 1;
    state.returnOperationGeneration += 1;
    clearTimeout(state.workspaceTimer);
    state.workspaceTimer = null;
    return state.projectEntryGeneration;
  }

  function isProjectEntryCurrent(entryGeneration, projectInstanceId = null) {
    return entryGeneration === state.projectEntryGeneration &&
      (!projectInstanceId || state.project?.instanceId === projectInstanceId);
  }

  function failProjectEntry(entryGeneration, projectInstanceId) {
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    state.projectReady = false;
    document.dispatchEvent(new CustomEvent('writcraft:project-entry-failed', {
      detail: { projectInstanceId },
    }));
    return true;
  }

  function beginProjectEntryRequest() {
    if (state.projectEntryRequestOwner !== null) return null;
    state.projectEntryRequestGeneration += 1;
    state.projectEntryRequestOwner = state.projectEntryRequestGeneration;
    return state.projectEntryRequestOwner;
  }

  function isProjectEntryRequestCurrent(requestOwner) {
    return requestOwner !== null && state.projectEntryRequestOwner === requestOwner;
  }

  function finishProjectEntryRequest(requestOwner) {
    if (!isProjectEntryRequestCurrent(requestOwner)) return false;
    state.projectEntryRequestOwner = null;
    return true;
  }

  function projectEntryOwner(entryGeneration, projectInstanceId) {
    return { entryGeneration, projectInstanceId };
  }

  function isOwnedProjectEntryCurrent(owner) {
    if (!owner) return true;
    if (typeof owner.isCurrent === 'function') return owner.isCurrent();
    return isProjectEntryCurrent(owner.entryGeneration, owner.projectInstanceId);
  }

  const INLINE_RECONCILIATION_REQUEST = Object.freeze({
    schema: 'writcraft.inline-rewrite-reconciliation/v1',
  });
  const INLINE_RECONCILIATION_POLL_LIMIT = 12;
  const INLINE_RECONCILIATION_POLL_MS = 250;

  function setMutationBlocked(key, blocked, message = '') {
    if (blocked) {
      state.mutationBlockers[key] = message || '项目写入状态待核对；请完成恢复后继续';
    } else {
      delete state.mutationBlockers[key];
    }
    const active = Object.entries(state.mutationBlockers);
    state.inlineMutationBlocked = active.length > 0;
    state.inlineMutationBlockReason = active[0]?.[1] || '';
    if (state.inlineMutationBlocked) {
      clearTimeout(state.saveTimer);
      clearTimeout(state.workspaceTimer);
      state.saveTimer = null;
      state.workspaceTimer = null;
    }
    if (editor) {
      editor.contentEditable = state.inlineMutationBlocked ? 'false' : 'true';
      editor.setAttribute('aria-disabled', String(state.inlineMutationBlocked));
    }
    if (newFileButton) newFileButton.disabled = state.inlineMutationBlocked || !state.project;
    if (state.inlineMutationBlocked) setSaveState(`⚠ ${state.inlineMutationBlockReason}`, 'error');
    return !state.inlineMutationBlocked;
  }

  function setInlineMutationBlocked(blocked, message = '') {
    return setMutationBlocked(
      'inline-rewrite',
      Boolean(blocked),
      message || 'Inline Rewrite 提交状态待核对；请重开项目后继续'
    );
  }

  function setChangesHistoryMutationBlocked(blocked, message = '') {
    return setMutationBlocked(
      'changes-history',
      Boolean(blocked),
      message || 'Changes / History 提交状态待核对；请完成恢复后继续'
    );
  }

  function setMarkdownTrashMutationBlocked(blocked, message = '') {
    return setMutationBlocked(
      'markdown-trash',
      Boolean(blocked),
      message || '项目回收区事务需要人工恢复；当前项目保持只读，请先备份并重新打开'
    );
  }

  function inlineRecoveryFailure(message) {
    setInlineMutationBlocked(true, message || '提交状态无法安全核对；请重开项目，不要重试');
    return Object.freeze({
      ok: false,
      status: 'reopen-required',
      safeToRestore: false,
      authoritativeReloaded: false,
      message: state.inlineMutationBlockReason,
    });
  }

  function validClearResult(value) {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype?.constructor?.name !== 'Object') return false;
    const keys = Object.keys(value).sort();
    return keys.length === 3 && keys[0] === 'ok' && keys[1] === 'schema' && keys[2] === 'status' &&
      value.ok === true && value.schema === 'writcraft.inline-rewrite-reconciliation-clear-result/v1' &&
      value.status === 'cleared';
  }

  function waitForInlineRecoveryPoll() {
    return new Promise(resolve => setTimeout(resolve, INLINE_RECONCILIATION_POLL_MS));
  }

  function setSaveState(label, kind) {
    if (!saveState) return;
    saveState.textContent = label;
    saveState.dataset.state = kind || '';
  }

  function normalizeResult(result) {
    if (!result) return { ok: false, error: '项目服务没有返回结果' };
    return result;
  }

  function showError(message) {
    setSaveState(`⚠ ${message}`, 'error');
  }

  function resultMessage(result, fallback) {
    return result && (result.message || result.error) || fallback;
  }

  async function releaseProposalResult(projectInstanceId, result) {
    const confirmation = result?.onboardingConfirmation;
    const releases = [];
    if (typeof result?.changeSetId === 'string' && result.changeSetId && bridge?.discardChanges) {
      releases.push(Promise.resolve().then(() => bridge.discardChanges(projectInstanceId, result.changeSetId)));
    }
    if (typeof confirmation?.token === 'string' && confirmation.token && bridge?.discardOnboardingConfirmation) {
      releases.push(Promise.resolve().then(() =>
        bridge.discardOnboardingConfirmation(projectInstanceId, confirmation.token)));
    }
    if (releases.length) await Promise.allSettled(releases);
  }

  function recoveryKey(path = state.currentPath) {
    if (!state.project || !path) return '';
    return `writcraft:recovery:${state.project.instanceId}:${path}`;
  }

  function recoveryManifestKey() {
    return state.project ? `writcraft:recovery-manifest:${state.project.instanceId}` : '';
  }

  function isPublicMarkdownPath(value) {
    return typeof value === 'string'
      && /\.(?:md|markdown)$/i.test(value)
      && !value.startsWith('/')
      && !value.includes('\\')
      && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
  }

  function loadRecoveryManifest() {
    const key = recoveryManifestKey();
    if (!key) return [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(parsed)) return [];
      return [...new Set(parsed.filter(isPublicMarkdownPath))].slice(0, 100);
    } catch (_) { return []; }
  }

  function saveRecoveryManifest(paths) {
    const key = recoveryManifestKey();
    if (!key) return;
    const safe = [...new Set((paths || []).filter(isPublicMarkdownPath))].slice(0, 100);
    try {
      if (safe.length) localStorage.setItem(key, JSON.stringify(safe));
      else localStorage.removeItem(key);
    } catch (_) {}
  }

  function showConflictActions(visible) {
    if (conflictActions) conflictActions.hidden = !visible;
    if (conflictKeepLocal) conflictKeepLocal.textContent = state.externalDeleted ? '重新创建文件' : '用本地稿覆盖';
    if (conflictUseDisk) conflictUseDisk.textContent = state.externalDeleted ? '关闭标签' : '使用磁盘版本';
  }

  function writeRecoveryEntry(path, content, revision) {
    const key = recoveryKey(path);
    if (!key || typeof content !== 'string') return false;
    let localWritten = false;
    try {
      const paths = loadRecoveryManifest();
      if (!paths.includes(path) && paths.length >= 100) {
        setSaveState('⚠ 恢复稿数量已达 100 条上限；请先处理旧恢复稿', 'error');
      } else {
        localStorage.setItem(key, JSON.stringify({
          revision: revision || null,
          content,
          savedAt: new Date().toISOString(),
        }));
        if (!paths.includes(path)) saveRecoveryManifest([...paths, path]);
        localWritten = true;
      }
    } catch (_) {}
    // Main owns the durable project-scoped copy. localStorage remains a
    // synchronous compatibility fallback for older builds and beforeunload.
    const mainWrite = bridge?.writeRecovery?.(path, content, revision || null);
    if (mainWrite && typeof mainWrite.catch === 'function') mainWrite.catch(() => {});
    return localWritten || Boolean(mainWrite);
  }

  function saveRecovery() {
    if (state.inlineMutationBlocked || !state.dirty) return;
    writeRecoveryEntry(
      state.currentPath,
      window.__editor?.getContent?.() || editor.innerText || '',
      state.revision
    );
  }

  function clearRecovery(path = state.currentPath) {
    const key = recoveryKey(path);
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
    saveRecoveryManifest(loadRecoveryManifest().filter(entry => entry !== path));
    Promise.resolve(bridge?.clearRecovery?.(path)).catch(() => {});
  }

  async function recoverContent(path, diskContent, diskRevision) {
    const recovery = await readRecoveryEntry(path);
    if (!recovery) return null;
    if (recovery.content === diskContent) {
      clearRecovery(path);
      return null;
    }
    return { content: recovery.content, conflict: recovery.revision !== diskRevision };
  }

  function fileName(filePath) {
    return filePath.split('/').filter(Boolean).pop() || filePath;
  }

  function getCursorOffset() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)) return 0;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  }

  function nodeOffset(node, offset) {
    if (!node || !editor.contains(node)) return 0;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  function getSelectionOffsets() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode) ||
        !editor.contains(selection.focusNode)) {
      const caretOffset = getCursorOffset();
      return { caretOffset, selectionAnchorOffset: caretOffset, selectionFocusOffset: caretOffset };
    }
    return {
      caretOffset: nodeOffset(selection.focusNode, selection.focusOffset),
      selectionAnchorOffset: nodeOffset(selection.anchorNode, selection.anchorOffset),
      selectionFocusOffset: nodeOffset(selection.focusNode, selection.focusOffset),
    };
  }

  function textPoint(offset) {
    let remaining = Math.max(0, Number(offset) || 0);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node;
    let last = null;
    while ((node = walker.nextNode())) {
      last = node;
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
    }
    return last ? { node: last, offset: last.data.length } : null;
  }

  function restoreSelection(anchorOffset, focusOffset) {
    const anchor = textPoint(anchorOffset);
    const focus = textPoint(focusOffset);
    if (!anchor || !focus) return false;
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (typeof selection.setBaseAndExtent === 'function') {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else {
      const range = document.createRange();
      range.setStart(anchor.node, anchor.offset);
      range.setEnd(focus.node, focus.offset);
      selection.addRange(range);
    }
    editor.focus();
    return true;
  }

  function getFirstVisibleOffset() {
    if (!editorScroll || typeof document.caretRangeFromPoint !== 'function') return null;
    const bounds = editorScroll.getBoundingClientRect();
    const range = document.caretRangeFromPoint(bounds.left + 12, bounds.top + 12);
    if (!range || !editor.contains(range.startContainer)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(editor);
    prefix.setEnd(range.startContainer, range.startOffset);
    return prefix.toString().length;
  }

  function restoreCursor(offset) {
    const target = Math.max(0, Number(offset) || 0);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      remaining -= node.data.length;
    }
    editor.focus();
  }

  function revealRange(offset, length = 0) {
    const startTarget = Math.max(0, Number(offset) || 0);
    const endTarget = startTarget + Math.max(0, Number(length) || 0);
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    let start = null;
    let end = null;
    let node;
    while ((node = walker.nextNode())) {
      const next = consumed + node.data.length;
      if (!start && startTarget <= next) start = { node, offset: Math.max(0, startTarget - consumed) };
      if (endTarget <= next) {
        end = { node, offset: Math.max(0, endTarget - consumed) };
        break;
      }
      consumed = next;
    }
    if (!start) return false;
    if (!end) end = start;
    const range = document.createRange();
    range.setStart(start.node, Math.min(start.offset, start.node.data.length));
    range.setEnd(end.node, Math.min(end.offset, end.node.data.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    start.node.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    editor.focus();
    return true;
  }

  function captureCurrentView() {
    if (!state.currentPath) return;
    const selection = getSelectionOffsets();
    state.views[state.currentPath] = {
      ...(state.views[state.currentPath] || {}),
      ...selection,
      scrollTop: editorScroll ? Math.max(0, editorScroll.scrollTop) : 0,
      activeOutlineId: state.views[state.currentPath]?.activeOutlineId || null,
      collapsedOutlineIds: [...(state.views[state.currentPath]?.collapsedOutlineIds || [])],
    };
  }

  function workspaceSnapshot() {
    captureCurrentView();
    return {
      tabs: [...state.tabs],
      activePath: state.currentPath,
      files: Object.fromEntries(state.tabs.map(path => [path, state.views[path] || {
        caretOffset: 0,
        selectionAnchorOffset: 0,
        selectionFocusOffset: 0,
        scrollTop: 0,
        activeOutlineId: null,
        collapsedOutlineIds: [],
      }])),
      returnStack: state.returnStack.map(entry => structuredClone(entry)),
    };
  }

  function updateWorkspaceReturnControl() {
    if (!workspaceReturn) return;
    workspaceReturn.hidden = state.returnStack.length === 0;
    workspaceReturn.textContent = state.returnStack.at(-1)?.view === 'project_home'
      ? '返回项目首页'
      : '返回上一位置';
  }

  function captureEditorReturnState() {
    if (!state.currentPath || !/^[a-f0-9]{64}$/.test(state.revision || '')) return null;
    const selection = getSelectionOffsets();
    return {
      path: state.currentPath,
      ...selection,
      scrollTop: editorScroll ? Math.max(0, editorScroll.scrollTop) : 0,
      revision: state.revision,
    };
  }

  function pushReturnLocation(entry) {
    if (!entry || !state.project) return false;
    const previous = state.returnStack.at(-1);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(entry)) state.returnStack.push(structuredClone(entry));
    if (state.returnStack.length > 32) state.returnStack.splice(0, state.returnStack.length - 32);
    updateWorkspaceReturnControl();
    scheduleWorkspaceSave();
    return true;
  }

  async function returnToPreviousLocation() {
    if (!state.project || !state.returnStack.length) return false;
    const projectInstanceId = state.project.instanceId;
    const operationGeneration = ++state.returnOperationGeneration;
    const isCurrent = entry => state.project?.instanceId === projectInstanceId &&
      state.returnOperationGeneration === operationGeneration && state.returnStack.at(-1) === entry;
    while (state.returnStack.length) {
      const entry = state.returnStack.at(-1);
      try {
        if (!isCurrent(entry)) return false;
        if (entry.view === 'project_home') {
          setWorkspaceView('home');
        } else if (entry.editorReturnState) {
          setWorkspaceView('explorer');
          const returned = entry.editorReturnState;
          const opened = await openFile(returned.path, { pin: true });
          if (!isCurrent(entry)) return false;
          if (opened === false) throw new Error('原写作位置已经不可用');
          const exactRevision = state.revision === returned.revision;
          if (exactRevision) {
            restoreSelection(returned.selectionAnchorOffset, returned.selectionFocusOffset);
            if (editorScroll) editorScroll.scrollTop = returned.scrollTop;
          } else {
            restoreSelection(returned.caretOffset, returned.caretOffset);
            if (editorScroll) editorScroll.scrollTop = Math.max(0, returned.scrollTop);
            setSaveState('正文已变化，已返回当前版本的安全位置', 'saved');
          }
        } else if (entry.stableLocator) {
          const response = await bridge?.dailyWorkspace?.resolveStableLocation?.(
            projectInstanceId,
            entry.stableLocator
          );
          if (!isCurrent(entry)) return false;
          const target = response?.result?.target;
          if (!response?.ok || target?.action !== 'open_file') throw new Error('返回位置已经失效');
          setWorkspaceView('explorer');
          const opened = await openFile(target.filePath, { pin: true });
          if (!isCurrent(entry)) return false;
          if (opened === false || state.revision !== target.revision) throw new Error('返回位置正在变化');
          revealRange(target.offset, Math.max(0, target.endOffset - target.offset));
        } else {
          const view = ({ editor: 'explorer', graph: 'graph', sources: 'sources', changes: 'explorer' })[entry.view];
          if (!view || !setWorkspaceView(view)) throw new Error('返回视图已经失效');
          if (entry.view === 'changes') window.__assistantDock?.open?.('changes');
        }
        if (!isCurrent(entry)) return false;
        state.returnStack.pop();
        updateWorkspaceReturnControl();
        scheduleWorkspaceSave();
        return true;
      } catch (_) {
        // A stale entry cannot block older safe history. Drop it and continue,
        // matching the v2 contract instead of reconstructing authority locally.
        if (!isCurrent(entry)) return false;
        state.returnStack.pop();
      }
    }
    updateWorkspaceReturnControl();
    scheduleWorkspaceSave();
    setSaveState('之前的位置已经失效', 'error');
    return false;
  }

  function updateOutlineViewState(next) {
    if (!state.currentPath || !next || typeof next !== 'object') return;
    const current = state.views[state.currentPath] || {
      ...getSelectionOffsets(), scrollTop: editorScroll ? Math.max(0, editorScroll.scrollTop) : 0,
    };
    state.views[state.currentPath] = {
      ...current,
      activeOutlineId: typeof next.activeOutlineId === 'string' ? next.activeOutlineId : null,
      collapsedOutlineIds: Array.isArray(next.collapsedOutlineIds) ? [...next.collapsedOutlineIds] : [],
    };
    scheduleWorkspaceSave();
  }

  async function saveWorkspaceNow() {
    clearTimeout(state.workspaceTimer);
    if (state.inlineMutationBlocked || !state.project || !bridge?.saveWorkspace) return;
    const projectInstanceId = state.project.instanceId;
    const snapshot = workspaceSnapshot();
    const pending = Promise.resolve(bridge.saveWorkspace(projectInstanceId, snapshot)).catch(() => {});
    state.workspaceSavePromise = pending;
    try { await pending; } finally {
      if (state.workspaceSavePromise === pending) state.workspaceSavePromise = null;
    }
  }

  function scheduleWorkspaceSave() {
    clearTimeout(state.workspaceTimer);
    if (state.inlineMutationBlocked) return;
    state.workspaceTimer = setTimeout(saveWorkspaceNow, 250);
  }

  function isMarkdown(node) {
    const path = node.path || node.relativePath || '';
    return node.type === 'file' && /\.(?:md|markdown)$/i.test(path);
  }

  function nodePath(node) {
    return node.path || node.relativePath || node.name || '';
  }

  function markdownPaths(nodes = state.tree, result = []) {
    for (const node of nodes || []) {
      if (isMarkdown(node)) result.push(nodePath(node));
      if (node.children) markdownPaths(node.children, result);
    }
    return result;
  }

  function supersedeChatRequest(requestToken) {
    if (!Number.isSafeInteger(requestToken) || requestToken < 1 || requestToken <= state.activeChatRequestToken) return false;
    state.activeChatRequestToken = requestToken;
    return true;
  }

  function captureChatRequestIntent(requestToken, contextRequest) {
    return window.__aiRequestGuard?.captureChatIntent(state, contextRequest, requestToken) || null;
  }

  function beginChatRequest(requestToken, aiGuard, contextRequest) {
    if (requestToken !== state.activeChatRequestToken) return null;
    const guard = window.__aiRequestGuard?.captureChat(aiGuard, contextRequest, requestToken) || null;
    if (!guard || !isAIRequestCurrent(aiGuard)) return null;
    return guard;
  }

  function isChatRequestCurrent(guard, interaction) {
    return canUseAI() && Boolean(window.__aiRequestGuard?.matchesChat(
      guard,
      state,
      state.activeChatRequestToken,
      interaction,
    ));
  }

  async function resolveContextSelections(contextRequest, chatGuard) {
    if (!state.project || !state.currentPath || !bridge?.resolveContext) {
      return { ok: false, error: 'CONTEXT_SERVICE_UNAVAILABLE', message: 'Main 上下文服务未连接' };
    }
    if (!isChatRequestCurrent(chatGuard, contextRequest)) {
      return { ok: false, stale: true, error: 'CHAT_REQUEST_STALE', message: '对话上下文已变化，请重新发起' };
    }
    try {
      const originProjectInstanceId = state.project.instanceId;
      const authoritative = normalizeResult(await bridge.resolveContext(originProjectInstanceId, contextRequest));
      if (state.project?.instanceId !== originProjectInstanceId || !isChatRequestCurrent(chatGuard, contextRequest)) {
        return { ok: false, stale: true, error: 'CHAT_REQUEST_STALE', message: '项目、文件或对话上下文已变化，请重新发起' };
      }
      return authoritative;
    } catch (error) {
      return { ok: false, error: 'CONTEXT_SERVICE_INTERRUPTED', message: error?.message || 'Main 上下文服务中断' };
    }
  }

  async function revealContextChip(chip) {
    if (chip?.stale) {
      setSaveState('⚠ 该上下文证据已过期，未猜测新位置', 'error');
      return false;
    }
    const locator = window.WritCraftChatContextState?.locatorForChip?.(chip) || null;
    if (!locator) {
      const explanation = chip?.reason || chip?.truncationReason || '该上下文项没有可验证的文件位置';
      setSaveState(`上下文说明：${explanation}`, 'future');
      return false;
    }
    if (!await openFile(locator.filePath)) {
      setSaveState('⚠ 上下文来源文件无法打开', 'error');
      return false;
    }
    if (chip.revision && state.revision && chip.revision !== state.revision) {
      setSaveState('⚠ 上下文 revision 已过期，未猜测新段落位置', 'error');
      return false;
    }
    let start = locator.offset;
    let end = locator.endOffset;
    if (chip.anchor && window.WritCraftBlockAnchor) {
      const content = window.__editor?.getContent?.() || editor.innerText || '';
      const resolved = window.WritCraftBlockAnchor.resolveBlockAnchor(chip.anchor, content);
      if (!resolved.ok) {
        setSaveState('⚠ 上下文锚点已过期，未猜测新的段落位置', 'error');
        return false;
      }
      start = resolved.start;
      end = resolved.end;
    }
    return revealRange(start, Math.max(0, end - start));
  }

  async function insertSourceCitation(source, style) {
    if (!state.project || !state.currentPath) return { ok: false, message: '请先打开一个正文文件' };
    if (state.currentPath === 'edit.md') return { ok: false, message: '项目 Prompt 不插入正文脚注' };
    if (!await persistCurrent(true)) return { ok: false, message: '当前文件未能保存' };
    const result = window.__editor?.insertCitation?.(source, style) || { ok: false, message: '编辑器未连接' };
    if (!result.ok) return result;
    const saved = await persistCurrent(true);
    return saved ? result : { ok: false, message: '脚注已进入恢复稿，但尚未写入磁盘' };
  }

  function relativeAssetPath(documentPath, assetPath) {
    const from = String(documentPath || '').split('/').slice(0, -1);
    const to = String(assetPath || '').split('/');
    let common = 0;
    while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
    return `${'../'.repeat(from.length - common)}${to.slice(common).join('/')}`;
  }

  async function insertGeneratedImage(image) {
    if (!state.project || !state.currentPath) return { ok: false, message: '请先打开一个正文文件' };
    if (state.currentPath === 'edit.md') return { ok: false, message: '项目 Prompt 不插入配图' };
    const filePath = image?.filePath;
    if (typeof filePath !== 'string' || !/^assets\/generated\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/i.test(filePath)) {
      return { ok: false, message: '配图路径不在项目生成资产目录' };
    }
    if (!await persistCurrent(true)) return { ok: false, message: '当前文件未能保存' };
    const markdown = `![章节配图](${encodeURI(relativeAssetPath(state.currentPath, filePath))})`;
    const inserted = window.__editor?.insertMarkdown?.(markdown) || { ok: false, message: '编辑器未连接' };
    if (!inserted.ok) return inserted;
    const saved = await persistCurrent(true);
    return saved
      ? {
        ok: true,
        markdown,
        targetPath: state.currentPath,
        revision: state.revision,
      }
      : { ok: false, message: '配图引用已进入恢复稿，但尚未写入磁盘' };
  }

  function closeFileMenus(except = null) {
    projectTree?.querySelectorAll('.tree-file-menu[open]').forEach(menu => {
      if (menu !== except) menu.open = false;
    });
  }

  function lifecycleRevision(path) {
    return path === state.currentPath ? state.revision : null;
  }

  function relocateWorkspacePath(sourcePath, targetPath) {
    const next = window.WritCraftFileLifecycleState.relocate(state, sourcePath, targetPath);
    state.tabs = next.tabs;
    state.views = next.views;
    state.previewPath = next.previewPath;
    clearRecovery(sourcePath);
    state.currentPath = next.currentPath;
  }

  function pinTab(path = state.currentPath) {
    if (!path) return false;
    const next = window.WritCraftFileLifecycleState.pin(state, path);
    const changed = state.previewPath !== next.previewPath || state.tabs.length !== next.tabs.length;
    state.tabs = next.tabs;
    state.previewPath = next.previewPath;
    if (changed) {
      renderTabs();
      scheduleWorkspaceSave();
    }
    return changed;
  }

  function applyTabOpenMode(path, options = {}) {
    if (options.preview === true) {
      const next = window.WritCraftFileLifecycleState.preview(state, path);
      state.tabs = next.tabs;
      state.previewPath = next.previewPath;
      return;
    }
    if (options.pin === true || !state.tabs.includes(path)) {
      const next = window.WritCraftFileLifecycleState.pin(state, path);
      state.tabs = next.tabs;
      state.previewPath = next.previewPath;
    }
  }

  function invalidateDerivedViews(kind, sourcePath, targetPath = null) {
    window.__graphView?.close?.();
    document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
      detail: { reason: kind, sourcePath, targetPath },
    }));
    document.dispatchEvent(new CustomEvent('writcraft:file-lifecycle-changed', {
      detail: { kind, sourcePath, targetPath },
    }));
  }

  function formatMarkdownTrashBytes(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '未知大小';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function setMarkdownTrashStatus(message, error = false) {
    if (!markdownTrashStatus) return;
    markdownTrashStatus.textContent = message;
    markdownTrashStatus.className = `markdown-trash-status${error ? ' is-error' : ''}`;
  }

  function applyMarkdownTrashFailure(result) {
    if (result?.error !== 'MARKDOWN_TRASH_RECOVERY_REQUIRED') return false;
    setMarkdownTrashMutationBlocked(
      true,
      result.message || '项目回收区事务需要人工恢复；当前项目保持只读'
    );
    return true;
  }

  function resetMarkdownTrash() {
    markdownTrashSequence += 1;
    markdownTrashBusy = false;
    markdownTrashOwner = null;
    markdownTrashList?.replaceChildren();
    if (markdownTrashToggle) markdownTrashToggle.textContent = '项目回收区 · 0';
    if (markdownTrashPanel) markdownTrashPanel.setAttribute('aria-busy', 'false');
    if (markdownTrashRefresh) markdownTrashRefresh.disabled = !state.project;
    setMarkdownTrashStatus('长期保留，不会自动删除；可恢复到原位置。');
  }

  function safeMarkdownTrashResult(result) {
    if (!result?.ok || result.schema !== 'writcraft.markdown-trash-list/v1' ||
        !Number.isSafeInteger(result.totalCount) || result.totalCount < 0 ||
        !Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0 ||
        !Array.isArray(result.items) || result.items.length !== result.totalCount) return null;
    const items = [];
    for (const item of result.items) {
      if (!item || typeof item.token !== 'string' || !/^mti_[a-f0-9]{48}$/.test(item.token) ||
          typeof item.originalPath !== 'string' || !/^(?!\.)(?!.*\/\.)[^\\]+\.(?:md|markdown)$/i.test(item.originalPath) ||
          item.originalPath === 'edit.md' || Number.isNaN(Date.parse(item.deletedAt)) ||
          !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return null;
      const keys = Object.keys(item).sort().join(',');
      if (keys !== 'deletedAt,originalPath,sizeBytes,token') return null;
      items.push(Object.freeze({ ...item }));
    }
    if (items.reduce((sum, item) => sum + item.sizeBytes, 0) !== result.totalBytes) return null;
    return Object.freeze({ totalCount: result.totalCount, totalBytes: result.totalBytes, items });
  }

  function renderMarkdownTrash(owner) {
    if (!markdownTrashList || !markdownTrashToggle) return;
    markdownTrashList.replaceChildren();
    markdownTrashToggle.textContent = `项目回收区 · ${owner.totalCount}`;
    markdownTrashPanel?.setAttribute('aria-busy', String(markdownTrashBusy));
    if (markdownTrashRefresh) markdownTrashRefresh.disabled = markdownTrashBusy;
    setMarkdownTrashStatus(owner.totalCount
      ? `共 ${owner.totalCount} 个文件，${formatMarkdownTrashBytes(owner.totalBytes)}。恢复不会自动打开文件。`
      : '项目回收区为空。');
    for (const item of owner.items) {
      const row = document.createElement('article');
      row.className = 'markdown-trash-item';
      const title = document.createElement('strong');
      title.textContent = item.originalPath;
      const detail = document.createElement('span');
      detail.textContent = `${formatMarkdownTrashBytes(item.sizeBytes)} · ${new Date(item.deletedAt).toLocaleString('zh-CN')}`;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = '恢复到原位置';
      restore.setAttribute('aria-label', `恢复 ${item.originalPath} 到原位置`);
      restore.disabled = markdownTrashBusy;
      restore.addEventListener('click', () => restoreMarkdownTrashItem(owner, item));
      row.append(title, detail, restore);
      markdownTrashList.appendChild(row);
    }
  }

  async function refreshMarkdownTrash() {
    const projectInstanceId = state.project?.instanceId;
    if (!projectInstanceId || !bridge?.getMarkdownTrash || markdownTrashBusy) {
      if (!projectInstanceId) resetMarkdownTrash();
      return false;
    }
    const sequence = ++markdownTrashSequence;
    markdownTrashBusy = true;
    if (markdownTrashOwner) renderMarkdownTrash(markdownTrashOwner);
    else markdownTrashPanel?.setAttribute('aria-busy', 'true');
    if (markdownTrashRefresh) markdownTrashRefresh.disabled = true;
    setMarkdownTrashStatus('正在核验项目回收区…');
    let result;
    try { result = normalizeResult(await bridge.getMarkdownTrash(projectInstanceId)); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (sequence !== markdownTrashSequence || state.project?.instanceId !== projectInstanceId) return false;
    markdownTrashBusy = false;
    const safe = safeMarkdownTrashResult(result);
    if (!safe) {
      markdownTrashOwner = null;
      markdownTrashList?.replaceChildren();
      markdownTrashPanel?.setAttribute('aria-busy', 'false');
      if (markdownTrashRefresh) markdownTrashRefresh.disabled = false;
      applyMarkdownTrashFailure(result);
      setMarkdownTrashStatus(result?.message || '项目回收区读取失败；未改变任何文件。', true);
      return false;
    }
    setMarkdownTrashMutationBlocked(false);
    markdownTrashOwner = Object.freeze({ projectInstanceId, ...safe });
    renderMarkdownTrash(markdownTrashOwner);
    return true;
  }

  async function restoreMarkdownTrashItem(owner, item) {
    if (markdownTrashBusy || markdownTrashOwner !== owner || !bridge?.restoreMarkdownTrash) return false;
    markdownTrashBusy = true;
    renderMarkdownTrash(owner);
    setMarkdownTrashStatus(`正在恢复 ${item.originalPath}…`);
    let result;
    try { result = normalizeResult(await bridge.restoreMarkdownTrash(owner.projectInstanceId, item.token)); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (markdownTrashOwner !== owner || state.project?.instanceId !== owner.projectInstanceId) {
      markdownTrashBusy = false;
      return false;
    }
    markdownTrashBusy = false;
    if (!result.ok || result.file?.path !== item.originalPath ||
        (!Array.isArray(result.tree) && !result.treeRefreshRequired)) {
      renderMarkdownTrash(owner);
      applyMarkdownTrashFailure(result);
      setMarkdownTrashStatus(result?.message || '恢复失败；回收区文件保持不变。', true);
      return false;
    }
    if (Array.isArray(result.tree)) state.tree = result.tree;
    else await refreshTree();
    state.aiContextGeneration += 1;
    invalidateDerivedViews('restore', item.originalPath, item.originalPath);
    renderTree();
    document.dispatchEvent(new CustomEvent('writcraft:tree-changed'));
    setSaveState(`已恢复 ${item.originalPath}`, 'saved');
    const refreshed = await refreshMarkdownTrash();
    if (refreshed && markdownTrashOwner?.totalCount === 0) markdownTrashToggle?.focus();
    return refreshed;
  }

  async function relocateFile(sourcePath, targetPath, method, label) {
    if (!state.project || !bridge?.[method] || sourcePath === 'edit.md') return false;
    if (!targetPath || targetPath === sourcePath) return false;
    if (!(await persistCurrent(true))) return false;
    closeFileMenus();
    setSaveState(`正在${label}…`, 'saving');
    let result;
    try {
      result = normalizeResult(await bridge[method](sourcePath, targetPath, lifecycleRevision(sourcePath)));
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (!result.ok) {
      showError(resultMessage(result, `${label}失败`));
      return false;
    }
    relocateWorkspacePath(sourcePath, result.file?.path || targetPath);
    state.tree = result.tree || state.tree;
    state.aiContextGeneration += 1;
    invalidateDerivedViews(method === 'renameFile' ? 'rename' : 'move', sourcePath, result.file?.path || targetPath);
    updateDocumentChrome(state.currentPath);
    scheduleWorkspaceSave();
    document.dispatchEvent(new CustomEvent('writcraft:tree-changed'));
    document.dispatchEvent(new CustomEvent('writcraft:current-file-changed', {
      detail: { path: state.currentPath },
    }));
    setSaveState(`${label}完成`, 'saved');
    return true;
  }

  async function promptRenameFile(sourcePath) {
    const currentName = fileName(sourcePath);
    const nextName = window.prompt('输入新的 Markdown 文件名', currentName);
    if (nextName === null) return;
    const cleanName = nextName.trim();
    if (!cleanName || cleanName.includes('/') || cleanName.includes('\\')) {
      showError('文件名不能包含路径分隔符');
      return;
    }
    const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) : '';
    await relocateFile(sourcePath, `${directory}${cleanName}`, 'renameFile', '重命名');
  }

  async function promptMoveFile(sourcePath) {
    const targetPath = window.prompt('输入移动后的项目内 Markdown 路径', sourcePath);
    if (targetPath === null) return;
    await relocateFile(sourcePath, targetPath.trim().replace(/\\/g, '/'), 'moveFile', '移动');
  }

  async function trashFile(sourcePath) {
    if (!state.project || !bridge?.trashFile || sourcePath === 'edit.md') return false;
    const confirmed = window.confirm(`将“${sourcePath}”移到项目回收区？\n\n文件不会永久删除，可根据 .writcraft/trash/manifest.json 恢复。`);
    if (!confirmed) return false;
    if (!(await persistCurrent(true))) return false;
    closeFileMenus();
    setSaveState('正在移到回收区…', 'saving');
    let result;
    try {
      result = normalizeResult(await bridge.trashFile(sourcePath, lifecycleRevision(sourcePath)));
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (!result.ok) {
      applyMarkdownTrashFailure(result);
      showError(resultMessage(result, '移到回收区失败'));
      return false;
    }

    const nextWorkspace = window.WritCraftFileLifecycleState.trash(state, sourcePath);
    const wasCurrent = nextWorkspace.wasCurrent;
    state.tabs = nextWorkspace.tabs;
    state.views = nextWorkspace.views;
    state.previewPath = nextWorkspace.previewPath;
    clearRecovery(sourcePath);
    state.tree = result.tree || state.tree;
    state.aiContextGeneration += 1;
    invalidateDerivedViews('trash', sourcePath);
    if (wasCurrent) {
      state.currentPath = '';
      state.revision = null;
      state.dirty = false;
      state.conflictRecovery = false;
      state.conflictRevision = null;
      state.externalDeleted = false;
      showConflictActions(false);
      await openFile(nextWorkspace.currentPath);
    } else {
      updateDocumentChrome(state.currentPath);
      document.dispatchEvent(new CustomEvent('writcraft:current-file-changed', {
        detail: { path: state.currentPath },
      }));
    }
    scheduleWorkspaceSave();
    document.dispatchEvent(new CustomEvent('writcraft:tree-changed'));
    setSaveState('已移到项目回收区', 'saved');
    await refreshMarkdownTrash();
    return true;
  }

  function appendFileMenu(row, fileButton, path) {
    if (path === 'edit.md') {
      fileButton.title = 'edit.md 是项目级 Prompt，不能重命名、移动或删除';
      return;
    }
    const menu = document.createElement('details');
    menu.className = 'tree-file-menu';
    const trigger = document.createElement('summary');
    trigger.setAttribute('aria-label', `管理 ${fileName(path)}`);
    trigger.title = '文件操作';
    trigger.textContent = '•••';
    const actions = document.createElement('div');
    actions.className = 'tree-file-menu-actions';
    const actionSpecs = [
      ['重命名', () => promptRenameFile(path)],
      ['移动到…', () => promptMoveFile(path)],
      ['移到回收区', () => trashFile(path), 'is-danger'],
    ];
    for (const [label, handler, className] of actionSpecs) {
      const action = document.createElement('button');
      action.type = 'button';
      action.textContent = label;
      if (className) action.className = className;
      action.addEventListener('click', event => {
        event.stopPropagation();
        menu.open = false;
        handler();
      });
      actions.appendChild(action);
    }
    trigger.addEventListener('click', () => closeFileMenus(menu));
    fileButton.addEventListener('contextmenu', event => {
      event.preventDefault();
      closeFileMenus(menu);
      menu.open = true;
      trigger.focus();
    });
    menu.append(trigger, actions);
    row.appendChild(menu);
  }

  function renderTreeNodes(nodes, parent) {
    for (const node of nodes || []) {
      const path = nodePath(node);
      if (node.type === 'directory' || node.type === 'folder') {
        const group = document.createElement('details');
        group.className = 'tree-folder';
        group.open = true;
        const summary = document.createElement('summary');
        summary.textContent = node.name || fileName(path);
        group.appendChild(summary);
        const children = document.createElement('div');
        children.className = 'tree-children';
        renderTreeNodes(node.children || [], children);
        group.appendChild(children);
        parent.appendChild(group);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'tree-file-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tree-file';
      button.dataset.path = path;
      button.dataset.active = String(path === state.currentPath);
      const editable = isMarkdown(node);
      button.innerHTML = `<span aria-hidden="true">${path === 'edit.md' ? '✦' : editable ? '◇' : '·'}</span><span></span>`;
      button.lastElementChild.textContent = node.name || fileName(path);
      if (path === 'edit.md') button.classList.add('is-project-prompt');
      if (editable) {
        button.addEventListener('click', event => {
          if (event.detail > 1) return;
          clearTimeout(treeOpenTimer);
          treeOpenTimer = setTimeout(() => openFile(path, { preview: true }), 180);
        });
        button.addEventListener('dblclick', event => {
          event.preventDefault();
          clearTimeout(treeOpenTimer);
          openFile(path, { pin: true });
        });
      }
      else {
        button.disabled = true;
        button.classList.add('is-readonly');
        button.title = '当前版本仅支持编辑 Markdown 文件';
      }
      row.appendChild(button);
      if (editable) appendFileMenu(row, button, path);
      parent.appendChild(row);
    }
  }

  function renderTree() {
    if (!projectTree) return;
    projectTree.replaceChildren();
    if (!state.project) {
      const empty = document.createElement('p');
      empty.className = 'tree-empty';
      empty.textContent = '打开一个项目后，这里会显示写作文件。';
      projectTree.appendChild(empty);
      return;
    }
    renderTreeNodes(state.tree, projectTree);
  }

  function renderTabs() {
    if (!tabBar) return;
    tabBar.replaceChildren();
    for (const path of state.tabs) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'document-tab';
      tab.dataset.active = String(path === state.currentPath);
      const isPreview = path === state.previewPath;
      const isDirty = path === state.currentPath && state.dirty;
      tab.classList.toggle('is-preview', isPreview);
      tab.classList.toggle('is-dirty', isDirty);
      tab.title = isPreview ? `${path} · 预览标签，双击固定` : path;
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = fileName(path);
      const dirty = document.createElement('span');
      dirty.className = 'tab-dirty';
      dirty.textContent = '●';
      dirty.setAttribute('aria-hidden', 'true');
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '关闭标签';
      close.addEventListener('click', event => {
        event.stopPropagation();
        closeTab(path);
      });
      tab.append(label, dirty, close);
      tab.addEventListener('click', () => openFile(path));
      tab.addEventListener('dblclick', event => {
        if (event.target === close) return;
        pinTab(path);
      });
      tab.setAttribute('aria-label', `${fileName(path)}${isPreview ? '，预览' : '，已固定'}${isDirty ? '，未保存' : ''}`);
      tabBar.appendChild(tab);
    }
  }

  function updateDocumentChrome(path) {
    const name = fileName(path);
    documentTitle.textContent = name || '未打开文件';
    documentPath.textContent = state.project && path ? `${state.project.name} / ${path}` : '选择或创建写作项目';
    editContextChip.hidden = !state.project;
    const revisionLabel = state.editContextRevision ? ` · ${state.editContextRevision.slice(0, 7)}` : '';
    editContextChip.dataset.missing = String(state.projectPromptMissing);
    const promptDiagnostics = Array.isArray(state.promptFrontMatter?.diagnostics) ? state.promptFrontMatter.diagnostics : [];
    const promptHasDiagnostics = !state.projectPromptMissing && promptDiagnostics.length > 0;
    const promptRepairable = promptDiagnostics.some(item => [
      'FRONT_MATTER_MISSING', 'EDIT_SCHEMA_MISSING', 'EDIT_SCHEMA_UNSUPPORTED',
    ].includes(item.code));
    const promptInvalid = promptDiagnostics.some(item => item.severity === 'error');
    editContextChip.dataset.invalid = String(promptInvalid || promptRepairable);
    editContextChip.title = promptDiagnostics.map(item => `${item.code}: ${item.message}`).join('\n');
    editContextChip.textContent = state.projectPromptMissing
      ? '⚠ edit.md 缺失 · 可创建项目说明'
      : promptInvalid || promptRepairable
        ? `⚠ edit.md Front Matter 需修复${revisionLabel}`
        : promptHasDiagnostics
          ? `edit.md Front Matter 有提示${revisionLabel}`
        : path === 'edit.md' ? `正在编辑项目 Prompt${revisionLabel}` : `edit.md 已载入${revisionLabel}`;
    renderEditDiagnostics(promptDiagnostics, promptHasDiagnostics, promptRepairable);
    if (startOnboardingButton) startOnboardingButton.disabled = !state.project || state.projectPromptMissing;
    renderTree();
    renderTabs();
  }

  function renderEditDiagnostics(diagnostics, hasDiagnostics, repairable) {
    if (!editDiagnosticPanel || !editDiagnosticList || !editDiagnosticRepair) return;
    editDiagnosticList.replaceChildren();
    for (const diagnostic of diagnostics || []) {
      const item = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = `${diagnostic.code} · 第 ${diagnostic.line || 1} 行`;
      const message = document.createElement('span');
      message.textContent = diagnostic.message || 'Front Matter 格式无效';
      item.append(code, message);
      editDiagnosticList.appendChild(item);
    }
    const manualOnly = (diagnostics || []).some(item => [
      'FRONT_MATTER_UNCLOSED', 'FRONT_MATTER_INVALID_LINE', 'FRONT_MATTER_DUPLICATE_KEY',
    ].includes(item.code));
    editDiagnosticRepair.disabled = !repairable || state.projectPromptMissing || manualOnly;
    editDiagnosticRepair.title = manualOnly ? '请先按诊断行修复 Front Matter 结构' : '';
    if (!hasDiagnostics || state.projectPromptMissing) {
      editDiagnosticPanel.hidden = true;
      editContextChip?.setAttribute('aria-expanded', 'false');
    }
    if (editDiagnosticFeedback) {
      editDiagnosticFeedback.textContent = manualOnly
        ? '结构存在歧义，请先按上方行号手动修复，再生成提案。'
        : hasDiagnostics && !repairable ? '这是兼容性提示，不需要生成修复提案。' : '';
    }
  }

  async function proposeEditPromptRepair() {
    if (!bridge?.proposeEditPromptRepair || !state.project) return;
    editDiagnosticRepair.disabled = true;
    editDiagnosticFeedback.textContent = '正在生成只包含 Front Matter 的修复 Diff…';
    try {
      if (!(await persistCurrent(true))) {
        editDiagnosticFeedback.textContent = '当前文件未能安全保存，修复提案已停止。';
        return;
      }
      const result = normalizeResult(await bridge.proposeEditPromptRepair(state.project.instanceId));
      if (!result.ok) {
        editDiagnosticFeedback.textContent = resultMessage(result, '无法生成修复提案');
        return;
      }
      editDiagnosticPanel.hidden = true;
      editContextChip.setAttribute('aria-expanded', 'false');
      const accepted = window.__changesView?.acceptProposal?.(result);
      if (accepted?.ok === false) {
        await releaseProposalResult(state.project.instanceId, result);
        editDiagnosticFeedback.textContent = accepted.message || '已有待处理审阅，修复提案已安全释放。';
      }
    } catch (error) {
      editDiagnosticFeedback.textContent = error.message || '生成修复提案失败';
    } finally {
      const diagnostics = Array.isArray(state.promptFrontMatter?.diagnostics) ? state.promptFrontMatter.diagnostics : [];
      const manualOnly = diagnostics.some(item => [
        'FRONT_MATTER_UNCLOSED', 'FRONT_MATTER_INVALID_LINE', 'FRONT_MATTER_DUPLICATE_KEY',
      ].includes(item.code));
      const repairable = diagnostics.some(item => [
        'FRONT_MATTER_MISSING', 'EDIT_SCHEMA_MISSING', 'EDIT_SCHEMA_UNSUPPORTED',
      ].includes(item.code));
      editDiagnosticRepair.disabled = manualOnly || !repairable;
    }
  }

  async function persistCurrent(flush = false) {
    clearTimeout(state.saveTimer);
    if (state.inlineMutationBlocked) {
      state.saveTimer = null;
      setSaveState(`⚠ ${state.inlineMutationBlockReason || '提交状态待核对；请重开项目'}`, 'error');
      return false;
    }
    if (state.savePromise) {
      await state.savePromise;
      if (flush && state.dirty) return persistCurrent(true);
      return !state.dirty;
    }
    if (!state.project || !state.currentPath || state.loading || !state.dirty) return true;
    if (state.conflictRecovery) {
      showConflictActions(true);
      setSaveState('⚠ 冲突草稿等待你的选择；普通导航和 AI 操作不会覆盖磁盘', 'error');
      return false;
    }
    if (!bridge || !bridge.writeFile) return false;
    setSaveState('正在保存…', 'saving');
    const path = state.currentPath;
    const projectInstanceId = state.project.instanceId;
    const revision = state.revision;
    const version = state.editVersion;
    const content = window.__editor && window.__editor.getContent
      ? window.__editor.getContent()
      : editor.innerText;
    let result;
    try {
      state.savePromise = bridge.writeFile(path, content, revision);
      result = normalizeResult(await state.savePromise);
    } catch (error) {
      showError(error.message);
      return false;
    } finally {
      state.savePromise = null;
    }
    if (!result.ok) {
      showError(resultMessage(result, '保存失败'));
      return false;
    }
    if (path === state.currentPath) state.revision = result.file?.revision || state.revision;
    if (path === 'edit.md') {
      state.editContext = content;
      state.editContextRevision = result.file?.revision || state.editContextRevision;
      state.projectPromptMissing = false;
      state.promptFrontMatter = result.file?.frontMatter || state.promptFrontMatter;
      if (path === state.currentPath) updateDocumentChrome(path);
    }
    if (path === state.currentPath && version === state.editVersion) {
      state.dirty = false;
      state.conflictRecovery = false;
      state.conflictRevision = null;
      state.externalDeleted = false;
      showConflictActions(false);
      clearRecovery(path);
      renderTabs();
      setSaveState('已保存', 'saved');
      if (state.project?.instanceId === projectInstanceId) {
        document.dispatchEvent(new CustomEvent('writcraft:current-file-authority-changed', {
          detail: {
            projectInstanceId,
            path,
            revision: state.revision,
            status: 'saved',
          },
        }));
      }
      return true;
    }
    state.dirty = true;
    saveRecovery();
    setSaveState('有新修改待保存', 'dirty');
    if (flush) return persistCurrent(true);
    state.saveTimer = setTimeout(() => persistCurrent(false), 500);
    return false;
  }

  function scheduleProjectSave() {
    if (state.inlineMutationBlocked || !state.project || state.loading) return;
    state.editVersion += 1;
    state.dirty = true;
    pinTab(state.currentPath);
    renderTabs();
    setSaveState('未保存', 'dirty');
    saveRecovery();
    clearTimeout(state.saveTimer);
    if (!state.conflictRecovery) state.saveTimer = setTimeout(() => persistCurrent(false), 500);
  }

  async function openFile(path, options = {}) {
    if (state.inlineMutationBlocked || !state.project || !path) return false;
    const openGeneration = ++state.openGeneration;
    if (path === state.currentPath) {
      applyTabOpenMode(path, options);
      renderTabs();
      return true;
    }
    captureCurrentView();
    const saved = await persistCurrent(true);
    if (!saved && state.dirty) return false;
    setSaveState('正在读取…', 'saving');
    let result;
    try {
      result = normalizeResult(await bridge.readFile(path));
    } catch (error) {
      showError(error.message);
      return false;
    }
    if (!result.ok) {
      showError(resultMessage(result, '无法读取文件'));
      return false;
    }
    if (openGeneration !== state.openGeneration) return false;
    const diskContent = typeof result.content === 'string' ? result.content : '';
    const recovered = await recoverContent(path, diskContent, result.revision || null);
    if (openGeneration !== state.openGeneration) return false;
    const content = recovered === null ? diskContent : recovered.content;
    state.loading = true;
    applyTabOpenMode(path, options);
    state.currentPath = path;
    if (window.__editor && window.__editor.loadDocument) window.__editor.loadDocument(content);
    else editor.textContent = content;
    if (path === 'edit.md') {
      state.editContext = content;
      state.editContextRevision = result.revision || '';
      state.projectPromptMissing = false;
      state.promptFrontMatter = result.frontMatter || null;
    }
    state.revision = result.revision || null;
    state.editVersion += 1;
    state.dirty = recovered !== null;
    if (state.dirty) pinTab(path);
    state.conflictRecovery = Boolean(recovered?.conflict);
    state.conflictRevision = recovered?.conflict ? result.revision || null : null;
    state.externalDeleted = false;
    showConflictActions(state.conflictRecovery);
    state.loading = false;
    updateDocumentChrome(path);
    const recoveryLabel = recovered?.conflict
      ? '⚠ 外部文件已变化；请选择保留本地稿或使用磁盘版本'
      : '已恢复未保存内容';
    setSaveState(recovered === null ? '已保存' : recoveryLabel, recovered === null ? 'saved' : recovered.conflict ? 'error' : 'dirty');
    if (recovered !== null && !recovered.conflict) state.saveTimer = setTimeout(() => persistCurrent(false), 500);
    const view = state.views[path] || {};
    // `openFile()` is a completion boundary used by evidence navigation.
    // Resolve only after deferred view restoration has run, otherwise a
    // caller's revealRange() is overwritten by this next-frame cursor restore.
    await new Promise(resolve => requestAnimationFrame(() => {
      if (openGeneration === state.openGeneration && state.currentPath === path) {
        const caretOffset = Number.isSafeInteger(view.caretOffset)
          ? view.caretOffset
          : Number.isSafeInteger(view.cursorOffset) ? view.cursorOffset : 0;
        const anchorOffset = Number.isSafeInteger(view.selectionAnchorOffset)
          ? view.selectionAnchorOffset
          : caretOffset;
        const focusOffset = Number.isSafeInteger(view.selectionFocusOffset)
          ? view.selectionFocusOffset
          : caretOffset;
        restoreSelection(anchorOffset, focusOffset);
        if (editorScroll) editorScroll.scrollTop = Math.max(0, Number(view.scrollTop) || 0);
      }
      resolve();
    }));
    if (openGeneration !== state.openGeneration || state.currentPath !== path) return false;
    scheduleWorkspaceSave();
    document.dispatchEvent(new CustomEvent('writcraft:current-file-changed', { detail: { path } }));
    return true;
  }

  async function closeTab(path) {
    if (path === state.currentPath) {
      const saved = await persistCurrent(true);
      if (!saved && state.dirty) return;
    }
    const index = state.tabs.indexOf(path);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (state.previewPath === path) state.previewPath = null;
    if (path === state.currentPath) {
      state.currentPath = '';
      state.revision = null;
      const fallback = state.tabs[Math.min(index, state.tabs.length - 1)];
      if (fallback) await openFile(fallback);
      else {
        state.loading = true;
        window.__editor && window.__editor.loadDocument
          ? window.__editor.loadDocument('')
          : editor.replaceChildren();
        state.loading = false;
        updateDocumentChrome('');
      }
    }
    renderTabs();
    scheduleWorkspaceSave();
    document.dispatchEvent(new CustomEvent('writcraft:current-file-changed', { detail: { path: state.currentPath } }));
  }

  async function refreshTree(owner = null) {
    if (!bridge || !bridge.listTree) return;
    const result = normalizeResult(await bridge.listTree());
    if (owner && !owner.isCurrent()) return false;
    if (result.ok) {
      state.tree = result.tree || [];
      renderTree();
      document.dispatchEvent(new CustomEvent('writcraft:tree-changed'));
    }
    return true;
  }

  async function loadEditContext(owner = null) {
    if (!isOwnedProjectEntryCurrent(owner)) return false;
    if (bridge && bridge.getContext) {
      const result = normalizeResult(await bridge.getContext());
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      if (result.ok) {
        state.editContext = result.editPrompt || result.content || '';
        state.editContextRevision = result.editRevision || '';
        state.projectPromptMissing = Boolean(result.projectPromptMissing);
        state.promptFrontMatter = result.editFrontMatter || null;
        return true;
      }
    }
    const result = normalizeResult(await bridge.readFile('edit.md'));
    if (!isOwnedProjectEntryCurrent(owner)) return false;
    if (result.ok) {
      state.editContext = result.content || '';
      state.editContextRevision = result.revision || '';
      state.projectPromptMissing = false;
      state.promptFrontMatter = result.frontMatter || null;
    } else {
      state.projectPromptMissing = true;
      state.promptFrontMatter = null;
    }
    return true;
  }

  async function queryInlineRewriteReconciliation(expectedRewriteId, recoveryGeneration) {
    if (!state.project || !rewriteBridge?.getRewriteReconciliation || !inlineRewriteTransaction) return null;
    const projectInstanceId = state.project.instanceId;
    for (let attempt = 0; attempt < INLINE_RECONCILIATION_POLL_LIMIT; attempt += 1) {
      let raw;
      try {
        raw = await rewriteBridge.getRewriteReconciliation(projectInstanceId, INLINE_RECONCILIATION_REQUEST);
      } catch (_) {
        return null;
      }
      if (recoveryGeneration !== state.inlineRecoveryGeneration ||
          state.project?.instanceId !== projectInstanceId) return null;
      const action = inlineRewriteTransaction.reconciliationAction(raw, expectedRewriteId || null);
      if (!action || action.action === 'reopen-required') return null;
      if (action.action !== 'poll') return action;
      if (attempt + 1 >= INLINE_RECONCILIATION_POLL_LIMIT) return null;
      await waitForInlineRecoveryPoll();
    }
    return null;
  }

  async function loadInlineRewriteAuthority(marker, recoveryGeneration) {
    if (!marker || !bridge?.readFile || !bridge?.listTree || !bridge?.listChangeHistory) return null;
    const projectInstanceId = state.project?.instanceId;
    let target;
    let tree;
    let history;
    try {
      target = normalizeResult(await bridge.readFile(marker.path));
      tree = normalizeResult(await bridge.listTree());
      history = normalizeResult(await bridge.listChangeHistory());
    } catch (_) {
      return null;
    }
    if (recoveryGeneration !== state.inlineRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId) return null;
    if (!target.ok || typeof target.content !== 'string' || target.revision !== marker.revision ||
        !tree.ok || !Array.isArray(tree.tree) || !history.ok || !Array.isArray(history.history)) return null;
    if (marker.historyEntryId && !history.history.some(entry => entry?.id === marker.historyEntryId)) return null;
    return Object.freeze({
      target: Object.freeze({
        path: marker.path,
        content: target.content,
        revision: target.revision,
        frontMatter: target.frontMatter || null,
      }),
      tree: tree.tree,
      history: history.history,
    });
  }

  async function clearInlineRewriteMarker(marker, recoveryGeneration) {
    const payload = inlineRewriteTransaction?.reconciliationClearPayload?.(marker);
    const projectInstanceId = state.project?.instanceId;
    if (!payload || !projectInstanceId || !rewriteBridge?.clearRewriteReconciliation) return false;
    let result;
    try { result = await rewriteBridge.clearRewriteReconciliation(projectInstanceId, payload); }
    catch (_) { return false; }
    return recoveryGeneration === state.inlineRecoveryGeneration &&
      state.project?.instanceId === projectInstanceId && validClearResult(result);
  }

  function installInlineRewriteAuthority(snapshot, marker, installTarget) {
    state.tree = snapshot.tree;
    if (installTarget && marker.path === state.currentPath) {
      state.loading = true;
      try {
        if (window.__editor?.loadDocument) window.__editor.loadDocument(snapshot.target.content);
        else editor.textContent = snapshot.target.content;
      } finally {
        state.loading = false;
      }
      state.revision = snapshot.target.revision;
      state.openGeneration += 1;
      state.editVersion += 1;
      state.dirty = false;
      state.conflictRecovery = false;
      state.conflictRevision = null;
      state.externalDeleted = false;
      showConflictActions(false);
      clearRecovery(marker.path);
      if (marker.path === 'edit.md') {
        state.editContext = snapshot.target.content;
        state.editContextRevision = snapshot.target.revision;
        state.projectPromptMissing = false;
        state.promptFrontMatter = snapshot.target.frontMatter;
      }
      updateDocumentChrome(marker.path);
    } else {
      renderTree();
      renderTabs();
    }
    state.aiContextGeneration += 1;
    document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
      detail: { reason: 'inline-rewrite-reconciled', path: marker.path },
    }));
    document.dispatchEvent(new CustomEvent('writcraft:inline-rewrite-reconciled', {
      detail: {
        rewriteId: marker.rewriteId,
        path: marker.path,
        outcome: marker.outcome,
        revision: marker.revision,
        history: snapshot.history,
      },
    }));
  }

  async function finishInlineRewriteTerminal(marker, recoveryGeneration, options = {}) {
    const entryOwner = options.entryOwner || null;
    if (!isOwnedProjectEntryCurrent(entryOwner)) {
      return Object.freeze({ ok: false, status: 'stale', safeToRestore: false, authoritativeReloaded: false });
    }
    if (marker.outcome === 'manual_recovery') {
      return inlineRecoveryFailure('Inline Rewrite 需要人工恢复；请重开项目，不要重试');
    }
    if (options.expected) {
      const expected = options.expected;
      if (marker.path !== expected.path || marker.revision !== expected.revision ||
          marker.historyEntryId !== expected.historyEntryId ||
          marker.outcome !== expected.status ||
          !['applied', 'committed_warning'].includes(marker.outcome)) {
        return inlineRecoveryFailure('提交结果与恢复记录不一致；请重开项目，不要重试');
      }
    }
    if (options.requireZeroWrite && marker.outcome !== 'zero_write_error') {
      return inlineRecoveryFailure('零写入结果与恢复记录不一致；请重开项目，不要重试');
    }
    const snapshot = await loadInlineRewriteAuthority(marker, recoveryGeneration);
    if (!isOwnedProjectEntryCurrent(entryOwner)) {
      return Object.freeze({ ok: false, status: 'stale', safeToRestore: false, authoritativeReloaded: false });
    }
    if (!snapshot) return inlineRecoveryFailure('无法完整重载文件、文件树和历史；请重开项目，不要重试');
    const zeroWriteBindingCurrent = Boolean(options.requireZeroWrite &&
      marker.path === state.currentPath && marker.revision === state.revision);
    const cleared = await clearInlineRewriteMarker(marker, recoveryGeneration);
    if (!isOwnedProjectEntryCurrent(entryOwner)) {
      return Object.freeze({ ok: false, status: 'stale', safeToRestore: false, authoritativeReloaded: false });
    }
    if (!cleared) {
      return inlineRecoveryFailure('恢复记录无法安全清除；请重开项目，不要重试');
    }
    try {
      const installTarget = options.requireZeroWrite
        ? marker.path === state.currentPath && !zeroWriteBindingCurrent
        : options.installTarget !== false;
      installInlineRewriteAuthority(snapshot, marker, installTarget);
    } catch (_) {
      return inlineRecoveryFailure('磁盘结果已确认，但界面刷新失败；请重开项目，不要重试');
    }
    setInlineMutationBlocked(false);
    const reconciledMessage = options.message ||
      '提交结果曾中断，已按磁盘和历史重新同步；请核对后继续';
    setSaveState(reconciledMessage, marker.outcome === 'committed_warning' ? 'future' : 'saved');
    return Object.freeze({
      ok: true,
      status: marker.outcome,
      safeToRestore: zeroWriteBindingCurrent,
      authoritativeReloaded: true,
      marker,
      message: reconciledMessage,
    });
  }

  async function reconcileInlineRewriteOnProjectEnter(entryOwner = null) {
    if (!isOwnedProjectEntryCurrent(entryOwner)) {
      return Object.freeze({ ok: false, status: 'stale', safeToRestore: false, authoritativeReloaded: false });
    }
    const recoveryGeneration = ++state.inlineRecoveryGeneration;
    setInlineMutationBlocked(true, '正在核对上次 Inline Rewrite 提交状态…');
    const action = await queryInlineRewriteReconciliation(null, recoveryGeneration);
    if (!isOwnedProjectEntryCurrent(entryOwner)) {
      return Object.freeze({ ok: false, status: 'stale', safeToRestore: false, authoritativeReloaded: false });
    }
    if (!action) return inlineRecoveryFailure('无法查询上次提交状态；请重开项目，不要继续编辑');
    if (action.action === 'ready') {
      setInlineMutationBlocked(false);
      return Object.freeze({ ok: true, status: 'ready', safeToRestore: false, authoritativeReloaded: false });
    }
    if (action.action === 'manual-recovery') {
      return inlineRecoveryFailure('Inline Rewrite 需要人工恢复；请重开项目，不要重试');
    }
    if (action.action !== 'reload-and-clear' || !action.marker) {
      return inlineRecoveryFailure('提交状态无法完成核对；请重开项目，不要继续编辑');
    }
    return finishInlineRewriteTerminal(action.marker, recoveryGeneration, {
      installTarget: true,
      entryOwner,
    });
  }

  async function beginInlineRewriteRecovery(value = {}) {
    const kind = value?.kind;
    const rewriteId = typeof value?.rewriteId === 'string' ? value.rewriteId : null;
    ++state.inlineRecoveryGeneration;
    setInlineMutationBlocked(true, value?.message || '正在核对 Inline Rewrite 提交状态…');
    if (kind === 'manual_recovery') {
      return inlineRecoveryFailure(value?.message || 'Inline Rewrite 需要人工恢复；请重开项目，不要重试');
    }
    if (kind === 'trusted_success' || kind === 'known_zero_write_error') {
      return Object.freeze({ ok: true, status: 'blocked', safeToRestore: false, authoritativeReloaded: false });
    }
    if (kind !== 'outcome_unknown' || !rewriteId) {
      return inlineRecoveryFailure('Inline Rewrite 恢复请求无效；请重开项目，不要重试');
    }
    const recoveryGeneration = state.inlineRecoveryGeneration;
    const action = await queryInlineRewriteReconciliation(rewriteId, recoveryGeneration);
    if (!action || action.action !== 'reload-and-clear' || !action.marker) {
      return inlineRecoveryFailure('提交结果无法权威确认；请重开项目，不要重试');
    }
    return finishInlineRewriteTerminal(action.marker, recoveryGeneration, { installTarget: true });
  }

  async function completeInlineRewriteCommit(value = {}) {
    const expected = {
      status: value?.status,
      path: value?.path,
      revision: value?.revision,
      historyEntryId: value?.historyEntryId === undefined ? null : value.historyEntryId,
    };
    const rewriteId = typeof value?.rewriteId === 'string' ? value.rewriteId : null;
    const recoveryGeneration = ++state.inlineRecoveryGeneration;
    setInlineMutationBlocked(true, '已应用，正在从磁盘和历史同步结果…');
    if (!rewriteId) return inlineRecoveryFailure('提交结果缺少恢复标识；请重开项目，不要重试');
    const action = await queryInlineRewriteReconciliation(rewriteId, recoveryGeneration);
    if (!action || action.action !== 'reload-and-clear' || !action.marker) {
      return inlineRecoveryFailure('已应用结果无法权威同步；请重开项目，不要重试');
    }
    return finishInlineRewriteTerminal(action.marker, recoveryGeneration, {
      expected,
      installTarget: true,
      message: '已按磁盘、文件树和历史同步 Inline Rewrite',
    });
  }

  async function restoreInlineRewriteAfterZeroWrite(value = {}) {
    const rewriteId = typeof value?.rewriteId === 'string' ? value.rewriteId : null;
    const recoveryGeneration = ++state.inlineRecoveryGeneration;
    setInlineMutationBlocked(true, '正在确认 Inline Rewrite 未写入磁盘…');
    if (!rewriteId) return inlineRecoveryFailure('零写入结果缺少恢复标识；请重开项目，不要重试');
    const action = await queryInlineRewriteReconciliation(rewriteId, recoveryGeneration);
    if (!action) return inlineRecoveryFailure('无法核对零写入状态；请重开项目，不要重试');
    if (action.action === 'ready') {
      setInlineMutationBlocked(false);
      setSaveState('未写入磁盘，可恢复当前选区', 'saved');
      return Object.freeze({
        ok: true,
        status: 'zero_write_error',
        safeToRestore: true,
        authoritativeReloaded: false,
        marker: null,
      });
    }
    if (action.action !== 'reload-and-clear' || !action.marker) {
      return inlineRecoveryFailure('零写入状态无法权威确认；请重开项目，不要重试');
    }
    return finishInlineRewriteTerminal(action.marker, recoveryGeneration, {
      requireZeroWrite: true,
      installTarget: false,
      message: '已确认未写入磁盘，可恢复当前选区',
    });
  }

  function showChangesHistoryRecovery(value) {
    window.__changesView?.setRecoveryState?.(value);
  }

  function changesHistoryRecoveryFailure(message, recovery = null) {
    state.changesHistoryRecovery = recovery;
    setChangesHistoryMutationBlocked(true, message);
    showChangesHistoryRecovery({
      blocked: true,
      state: 'error',
      title: '项目写入状态无法安全确认',
      message,
      affectedPaths: recovery?.affectedPaths || [],
    });
    return Object.freeze({
      ok: false,
      status: 'reopen-required',
      mutationTrusted: false,
      authoritativeReloaded: false,
      recovery,
      message,
    });
  }

  function changesHistoryRecoveryStale() {
    return Object.freeze({
      ok: false,
      status: 'stale',
      canceled: true,
      mutationTrusted: false,
      authoritativeReloaded: false,
      recovery: null,
      message: '项目已经切换；旧项目的恢复结果已忽略',
    });
  }

  async function queryChangesHistoryRecovery(recoveryGeneration) {
    const helper = window.WritCraftChangesHistoryRecovery;
    const projectInstanceId = state.project?.instanceId;
    if (!helper || !projectInstanceId || !bridge?.queryChangesHistoryRecovery) return null;
    let raw;
    try {
      raw = await bridge.queryChangesHistoryRecovery(projectInstanceId);
    } catch (_) {
      return null;
    }
    if (recoveryGeneration !== state.changesHistoryRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId) {
      return Object.freeze({ action: 'stale', recovery: null });
    }
    return helper.routeQueryResult(raw);
  }

  async function loadChangesHistoryAuthority(recovery, recoveryGeneration) {
    const projectInstanceId = state.project?.instanceId;
    if (!projectInstanceId || !bridge?.listTree || !bridge?.listChangeHistory) return null;
    const touchesCurrent = Boolean(state.currentPath &&
      recovery.affectedPaths.includes(state.currentPath));
    let tree;
    let history;
    let current = null;
    try {
      tree = normalizeResult(await bridge.listTree());
      history = normalizeResult(await bridge.listChangeHistory());
      if (touchesCurrent) current = normalizeResult(await bridge.readFile(state.currentPath));
    } catch (_) {
      return null;
    }
    if (recoveryGeneration !== state.changesHistoryRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId ||
        !tree.ok || !Array.isArray(tree.tree) ||
        !history.ok || !Array.isArray(history.history) ||
        (touchesCurrent && (!current?.ok || typeof current.content !== 'string' ||
          typeof current.revision !== 'string'))) return null;
    return Object.freeze({
      tree: tree.tree,
      history: history.history,
      current: touchesCurrent ? Object.freeze({
        path: state.currentPath,
        content: current.content,
        revision: current.revision,
        frontMatter: current.frontMatter || null,
      }) : null,
    });
  }

  function installChangesHistoryAuthority(snapshot, recovery) {
    state.tree = snapshot.tree;
    renderTree();
    window.__changesView?.renderHistory?.(snapshot.history);
    if (snapshot.current) {
      state.loading = true;
      try {
        if (window.__editor?.loadDocument) window.__editor.loadDocument(snapshot.current.content);
        else editor.textContent = snapshot.current.content;
      } finally {
        state.loading = false;
      }
      state.revision = snapshot.current.revision;
      state.editVersion += 1;
      state.openGeneration += 1;
      state.dirty = false;
      state.conflictRecovery = false;
      state.conflictRevision = null;
      state.externalDeleted = false;
      showConflictActions(false);
      clearRecovery(snapshot.current.path);
      if (snapshot.current.path === 'edit.md') {
        state.editContext = snapshot.current.content;
        state.editContextRevision = snapshot.current.revision;
        state.projectPromptMissing = false;
        state.promptFrontMatter = snapshot.current.frontMatter;
      }
      updateDocumentChrome(snapshot.current.path);
      renderTabs();
    }
    state.aiContextGeneration += 1;
    document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
      detail: { reason: 'changes-history-reconciled', paths: [...recovery.affectedPaths] },
    }));
    document.dispatchEvent(new CustomEvent('writcraft:changes-history-reconciled', {
      detail: {
        operationId: recovery.operationId,
        kind: recovery.kind,
        outcome: recovery.outcome,
        affectedPaths: [...recovery.affectedPaths],
      },
    }));
  }

  async function finishChangesHistoryTerminal(recovery, recoveryGeneration, options = {}) {
    const helper = window.WritCraftChangesHistoryRecovery;
    const entryOwner = options.entryOwner || null;
    if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
    const projectInstanceId = state.project?.instanceId;
    const snapshot = await loadChangesHistoryAuthority(recovery, recoveryGeneration);
    if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
    if (recoveryGeneration !== state.changesHistoryRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId) return changesHistoryRecoveryStale();
    if (!snapshot) {
      return changesHistoryRecoveryFailure(
        '无法完整重载文件树、当前文件和修改历史；项目仍保持锁定，请重新打开项目。',
        recovery
      );
    }
    try {
      installChangesHistoryAuthority(snapshot, recovery);
    } catch (_) {
      return changesHistoryRecoveryFailure(
        '磁盘状态已读取，但界面无法安全安装权威结果；项目仍保持锁定，请重新打开项目。',
        recovery
      );
    }
    let cleared;
    try {
      cleared = await bridge.clearChangesHistoryRecovery(projectInstanceId, recovery.operationId);
    } catch (_) {
      if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
      return changesHistoryRecoveryFailure(
        '权威结果已重载，但恢复记录无法清除；项目仍保持锁定，请重新打开项目。',
        recovery
      );
    }
    if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
    if (recoveryGeneration !== state.changesHistoryRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId) return changesHistoryRecoveryStale();
    if (!helper?.clearMatchesRecovery?.(cleared, recovery)) {
      return changesHistoryRecoveryFailure(
        '恢复记录的清除确认与当前操作不一致；项目仍保持锁定，请重新打开项目。',
        recovery
      );
    }
    state.changesHistoryRecovery = null;
    window.__changesView?.clearRecoveryState?.();
    setChangesHistoryMutationBlocked(false);
    const message = options.message ||
      (options.mutationTrusted
        ? '已按磁盘、文件树和修改历史确认本次操作'
        : '操作响应曾中断，已按磁盘和修改历史恢复真实结果');
    setSaveState(message, recovery.outcome === 'zero_write_error' ? 'future' : 'saved');
    return Object.freeze({
      ok: true,
      status: recovery.outcome,
      mutationTrusted: options.mutationTrusted === true,
      authoritativeReloaded: true,
      recovery,
      message,
    });
  }

  function presentManualChangesHistoryRecovery(recovery, message = '') {
    state.changesHistoryRecovery = recovery;
    const detail = message ||
      '文件与修改历史没有同时完成。请选择恢复到操作前，或保留操作后并补齐历史。';
    setChangesHistoryMutationBlocked(true, detail);
    showChangesHistoryRecovery({
      blocked: true,
      state: 'manual',
      title: '需要你确认项目的最终状态',
      message: detail,
      affectedPaths: recovery.affectedPaths,
      operationId: recovery.operationId,
    });
    return Object.freeze({
      ok: false,
      status: recovery.outcome,
      mutationTrusted: false,
      authoritativeReloaded: false,
      recovery,
      message: detail,
    });
  }

  async function reconcileChangesHistoryOnProjectEnter(entryOwner = null) {
    if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
    const recoveryGeneration = ++state.changesHistoryRecoveryGeneration;
    state.changesHistoryRecovery = null;
    setChangesHistoryMutationBlocked(true, '正在核对上次 Changes / History 写入状态…');
    showChangesHistoryRecovery({
      blocked: true,
      state: 'checking',
      title: '正在核对上次项目写入',
      message: '核对完成前，编辑、保存和 AI 写入均已暂停。',
    });
    const action = await queryChangesHistoryRecovery(recoveryGeneration);
    if (!isOwnedProjectEntryCurrent(entryOwner)) return changesHistoryRecoveryStale();
    if (!action) {
      return changesHistoryRecoveryFailure('无法查询上次项目写入状态；请重新打开项目，不要继续编辑。');
    }
    if (action.action === 'stale') return changesHistoryRecoveryStale();
    if (action.action === 'ready') {
      window.__changesView?.clearRecoveryState?.();
      setChangesHistoryMutationBlocked(false);
      return Object.freeze({
        ok: true,
        status: 'ready',
        mutationTrusted: false,
        authoritativeReloaded: false,
      });
    }
    if (action.action === 'manual-recovery' && action.recovery) {
      return presentManualChangesHistoryRecovery(action.recovery);
    }
    if (action.action === 'reload-and-clear' && action.recovery) {
      return finishChangesHistoryTerminal(action.recovery, recoveryGeneration, {
        mutationTrusted: false,
        entryOwner,
      });
    }
    return changesHistoryRecoveryFailure(
      '项目写入恢复记录无法安全识别；请重新打开项目，不要继续编辑。',
      action.recovery || null
    );
  }

  function beginChangesHistoryMutation(message = '') {
    ++state.changesHistoryRecoveryGeneration;
    state.changesHistoryRecovery = null;
    setChangesHistoryMutationBlocked(true, message || '正在核对 Changes / History 写入状态…');
    showChangesHistoryRecovery({
      blocked: true,
      state: 'checking',
      title: '正在确认项目写入',
      message: message || '操作返回后将重新读取磁盘、文件树和修改历史。',
    });
    return state.changesHistoryRecoveryGeneration;
  }

  async function reconcileChangesHistoryAfterMutation(kind, mutationResult) {
    const helper = window.WritCraftChangesHistoryRecovery;
    const recoveryGeneration = state.changesHistoryRecoveryGeneration;
    const action = await queryChangesHistoryRecovery(recoveryGeneration);
    if (!action) {
      return changesHistoryRecoveryFailure('操作结果无法向 Main 核对；项目仍保持锁定，请重新打开项目。');
    }
    if (action.action === 'stale') return changesHistoryRecoveryStale();
    if (action.action === 'ready') {
      const normalized = helper?.normalizeMutationResult?.(mutationResult);
      if (normalized?.ok === true) {
        return changesHistoryRecoveryFailure('Main 返回成功，但没有对应的恢复记录；项目仍保持锁定。');
      }
      state.changesHistoryRecovery = null;
      window.__changesView?.clearRecoveryState?.();
      setChangesHistoryMutationBlocked(false);
      return Object.freeze({
        ok: true,
        status: 'ready',
        mutationTrusted: false,
        authoritativeReloaded: false,
        recovery: null,
      });
    }
    if (action.action === 'manual-recovery' && action.recovery) {
      return presentManualChangesHistoryRecovery(action.recovery);
    }
    if (action.action !== 'reload-and-clear' || !action.recovery) {
      return changesHistoryRecoveryFailure(
        '操作恢复记录无法安全识别；项目仍保持锁定，请重新打开项目。',
        action.recovery || null
      );
    }
    const mutationTrusted = helper?.mutationMatchesRecovery?.(
      kind,
      mutationResult,
      action.recovery
    ) === true;
    return finishChangesHistoryTerminal(action.recovery, recoveryGeneration, {
      mutationTrusted,
    });
  }

  async function resolveChangesHistoryRecovery(operationId, action) {
    const helper = window.WritCraftChangesHistoryRecovery;
    const recovery = state.changesHistoryRecovery;
    const projectInstanceId = state.project?.instanceId;
    const recoveryGeneration = ++state.changesHistoryRecoveryGeneration;
    if (!helper || !recovery || recovery.operationId !== operationId ||
        !['restore_before', 'keep_after'].includes(action) || !projectInstanceId ||
        !bridge?.resolveChangesHistoryRecovery) {
      return changesHistoryRecoveryFailure('恢复操作身份已失效；请重新打开项目。', recovery);
    }
    setChangesHistoryMutationBlocked(true, '正在执行人工恢复并核对磁盘…');
    let result;
    try {
      result = await bridge.resolveChangesHistoryRecovery(projectInstanceId, operationId, action);
    } catch (_) {
      result = null;
    }
    if (recoveryGeneration !== state.changesHistoryRecoveryGeneration ||
        state.project?.instanceId !== projectInstanceId) return changesHistoryRecoveryStale();
    const queried = await queryChangesHistoryRecovery(recoveryGeneration);
    if (!queried) {
      return changesHistoryRecoveryFailure('人工恢复结果无法重新查询；项目仍保持锁定。', recovery);
    }
    if (queried.action === 'stale') return changesHistoryRecoveryStale();
    if (queried.action === 'manual-recovery' && queried.recovery) {
      return presentManualChangesHistoryRecovery(
        queried.recovery,
        result
          ? '恢复未能完成持久化核对；你可以重试同一选择，或重新打开项目。'
          : '恢复调用中断；磁盘状态已重新核对，项目仍保持锁定。'
      );
    }
    const expectedOutcome = action === 'restore_before'
      ? 'zero_write_error'
      : recovery.kind === 'apply'
        ? 'applied'
        : recovery.kind === 'review' ? 'reviewed' : 'undone';
    if (queried.action !== 'reload-and-clear' || !queried.recovery ||
        queried.recovery.operationId !== operationId ||
        queried.recovery.outcome !== expectedOutcome) {
      return changesHistoryRecoveryFailure(
        '人工恢复确认与权威记录不一致；项目仍保持锁定，请重新打开项目。',
        queried.recovery || recovery
      );
    }
    return finishChangesHistoryTerminal(queried.recovery, recoveryGeneration, {
      mutationTrusted: false,
      message: action === 'restore_before'
        ? '已恢复到操作前，并重新同步文件树与修改历史'
        : '已保留操作后，并重新同步文件树与修改历史',
    });
  }

  async function enterProject(result, entryGeneration) {
    if (!isProjectEntryCurrent(entryGeneration)) return false;
    if (result.canceled) return false;
    if (!result.ok || !result.project) {
      showError(resultMessage(result, '无法打开项目'));
      return false;
    }
    if (migrationResolver) finishMigrationDialog('later');
    closeProjectOnboarding();
    state.onboardingDraft = null;
    resetMarkdownTrash();
    externalSyncState?.reset();
    window.__assistantDock?.close?.();
    state.project = result.project;
    state.projectReady = false;
    state.openGeneration += 1;
    const projectInstanceId = result.project.instanceId;
    const owner = projectEntryOwner(entryGeneration, projectInstanceId);
    document.dispatchEvent(new CustomEvent('writcraft:project-entering', {
      detail: { projectInstanceId },
    }));
    ++state.inlineRecoveryGeneration;
    ++state.changesHistoryRecoveryGeneration;
    state.mutationBlockers = {};
    state.changesHistoryRecovery = null;
    setMarkdownTrashMutationBlocked(Boolean(result.markdownTrashRecoveryRequired));
    setChangesHistoryMutationBlocked(true, '正在核对上次 Changes / History 写入状态…');
    setSidebarView('explorer');
    state.editContext = '';
    state.editContextRevision = '';
    state.projectPromptMissing = Boolean(result.projectPromptMissing);
    state.promptFrontMatter = result.promptFrontMatter || null;
    state.tree = result.tree || [];
    state.tabs = [];
    state.previewPath = null;
    state.currentPath = '';
    state.revision = null;
    state.views = {};
    state.returnStack = [];
    updateWorkspaceReturnControl();
    state.conflictRecovery = false;
    state.conflictRevision = null;
    state.externalDeleted = false;
    showConflictActions(false);
    state.dirty = false;
    projectTitle.textContent = result.project.name;
    newFileButton.disabled = state.inlineMutationBlocked;
    welcome.hidden = true;
    workArea.classList.add('has-project');
    if (window.__editor && window.__editor.setProjectManaged) {
      window.__editor.setProjectManaged(true);
    }
    renderTree();
    const changesHistoryRecovery = await reconcileChangesHistoryOnProjectEnter(owner);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    if (!changesHistoryRecovery.ok) {
      failProjectEntry(entryGeneration, projectInstanceId);
      return false;
    }
    const inlineRecovery = await reconcileInlineRewriteOnProjectEnter(owner);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    if (!inlineRecovery.ok) {
      failProjectEntry(entryGeneration, projectInstanceId);
      return false;
    }
    await loadEditContext(owner);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    let initialPath = state.projectPromptMissing ? markdownPaths()[0] || '' : 'edit.md';
    if (bridge?.loadWorkspace) {
      let saved = null;
      try {
        saved = normalizeResult(await bridge.loadWorkspace(projectInstanceId));
      } catch (_) {}
      if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
      if (saved?.ok && saved.workspace) {
        state.tabs = Array.isArray(saved.workspace.tabs) ? [...saved.workspace.tabs] : [];
        state.views = saved.workspace.files && typeof saved.workspace.files === 'object'
          ? { ...saved.workspace.files }
          : {};
        state.returnStack = Array.isArray(saved.workspace.returnStack)
          ? saved.workspace.returnStack.map(entry => structuredClone(entry))
          : [];
        updateWorkspaceReturnControl();
        initialPath = saved.workspace.activePath || initialPath;
      }
    }
    const initialOpened = await openFile(initialPath);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    if (!initialOpened) {
      failProjectEntry(entryGeneration, projectInstanceId);
      return false;
    }
    if (result.migrationNotice?.kind === 'legacy-edit-conflict') {
      const notice = result.migrationNotice;
      await presentMigration({
        title: '检测到两个项目 Prompt',
        description: 'editor.md 与 edit.md 同时存在。WritCraft 不会自动合并或覆盖；当前继续以 edit.md 为权威 Prompt，你可以稍后在编辑器中人工对照。',
        target: 'edit.md（保持不变）',
        preview: `[editor.md]\n${notice.source?.content || ''}\n\n[edit.md]\n${notice.target?.content || ''}`,
        confirmLabel: '继续使用 edit.md',
        laterLabel: '稍后处理',
      });
      if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    }
    await maybeOfferOrphanRecovery(owner);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    await maybeOfferLegacyDraft(owner);
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    if (state.projectPromptMissing) {
      updateDocumentChrome(state.currentPath);
      const action = await presentMigration({
        title: '创建项目说明 edit.md',
        description: '这个普通 Markdown 文件夹可以直接浏览和写作。创建 edit.md 后，AI 才会获得项目主旨、结构与约束；稍后创建不会影响现有文件。',
        target: 'edit.md（项目根目录）',
        preview: '将创建 WritCraft 项目说明模板，不会修改已有 Markdown。',
        confirmLabel: '创建项目说明',
        laterLabel: '暂不创建，继续写作',
      });
      if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
      if (action === 'confirm' && bridge?.createProjectPrompt) {
        let created;
        try { created = normalizeResult(await bridge.createProjectPrompt()); }
        catch (error) { created = { ok: false, message: error.message }; }
        if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
        if (created.ok) {
          state.tree = created.tree || state.tree;
          state.projectPromptMissing = false;
          state.promptFrontMatter = created.file?.frontMatter || null;
          await loadEditContext(owner);
          if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
          const promptOpened = await openFile('edit.md');
          if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
          if (!promptOpened) {
            failProjectEntry(entryGeneration, projectInstanceId);
            return false;
          }
          setSaveState('已创建项目说明 edit.md', 'saved');
          if (startOnboardingButton) startOnboardingButton.disabled = false;
          openProjectOnboarding();
        } else {
          showError(resultMessage(created, '创建 edit.md 失败，现有文件未修改'));
        }
      } else {
        setSaveState('⚠ 当前没有项目 Prompt；仍可浏览和编辑 Markdown', 'future');
      }
    }
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    state.projectReady = true;
    document.dispatchEvent(new CustomEvent('writcraft:project-entered'));
    await refreshMarkdownTrash();
    if (!isProjectEntryCurrent(entryGeneration, projectInstanceId)) return false;
    if (startOnboardingButton) startOnboardingButton.disabled = state.projectPromptMissing;
    if (result.onboardingRecommended && !state.projectPromptMissing) openProjectOnboarding();
    return true;
  }

  function closeProjectOnboarding() {
    state.onboardingController?.destroy?.();
    state.onboardingController = null;
    if (onboardingHost) onboardingHost.hidden = true;
    startOnboardingButton?.classList.remove('is-active');
    startOnboardingButton?.setAttribute('aria-pressed', 'false');
  }

  function openProjectOnboarding() {
    if (!state.project || state.projectPromptMissing || !onboardingHost || !window.WritCraftProjectOnboarding) return false;
    const availability = window.__changesView?.canStartOnboarding?.();
    if (availability?.ok === false) {
      window.__changesView?.open?.();
      setSaveState(`⚠ ${availability.message || '请先处理当前 Changes 审阅或初始文件确认'}`, 'error');
      return false;
    }
    window.__graphView?.close?.();
    window.__changesView?.close?.();
    setAIVisible(false);
    closeProjectOnboarding();
    onboardingHost.hidden = false;
    startOnboardingButton?.classList.add('is-active');
    startOnboardingButton?.setAttribute('aria-pressed', 'true');
    const onboardingDraft = state.onboardingDraft?.projectInstanceId === state.project.instanceId
      ? state.onboardingDraft.session
      : undefined;
    state.onboardingController = window.WritCraftProjectOnboarding.mount(onboardingHost, {
      stateApi: window.WritCraftOnboardingState,
      session: onboardingDraft,
      onSessionChange: session => {
        if (!state.project) return;
        state.onboardingDraft = { projectInstanceId: state.project.instanceId, session };
      },
      onGenerate: async (request, _session, onboardingAttempt) => {
        const projectInstanceId = state.project?.instanceId || null;
        const controller = state.onboardingController;
        if (!(await persistCurrent(true))) return { ok: false, message: '当前文件未能安全保存，项目提案已停止' };
        let result;
        try { result = normalizeResult(await bridge.proposeOnboarding(projectInstanceId, request)); }
        catch (error) { result = { ok: false, message: error.message }; }
        if (!result.ok) return result;
        if (state.project?.instanceId !== projectInstanceId || state.onboardingController !== controller) {
          await releaseProposalResult(projectInstanceId, result);
          return { ok: false, message: '项目或项目卡会话已变化，迟到提案已安全释放' };
        }
        const accepted = window.__changesView?.acceptProposal?.(result, { onboardingAttempt });
        if (accepted?.ok !== true) {
          await releaseProposalResult(projectInstanceId, result);
          return { ok: false, message: accepted?.message || '已有待处理审阅，项目提案未覆盖当前状态' };
        }
        return result;
      },
      onComplete: () => {
        state.onboardingDraft = null;
        closeProjectOnboarding();
      },
      onOpenSettings: session => {
        if (state.project) {
          state.onboardingDraft = { projectInstanceId: state.project.instanceId, session };
        }
        closeProjectOnboarding();
        document.getElementById('activity-settings')?.click();
      },
      onCancel: () => closeProjectOnboarding(),
    });
    return true;
  }

  function presentMigration(config) {
    if (migrationResolver) {
      migrationResolver('later');
      migrationResolver = null;
      if (migrationDialog.open) migrationDialog.close();
    }
    migrationTitle.textContent = config.title;
    migrationDescription.textContent = config.description;
    migrationTarget.textContent = config.target || '';
    migrationPreview.textContent = config.preview || '';
    const warnings = (config.warnings || []).filter(Boolean);
    migrationWarnings.hidden = !warnings.length;
    migrationWarnings.textContent = warnings.join('\n');
    migrationConfirm.textContent = config.confirmLabel || '确认迁移';
    migrationLater.textContent = config.laterLabel || '稍后处理';
    migrationDiscard.hidden = !config.allowDiscard;
    migrationDiscard.textContent = config.discardLabel || '丢弃恢复稿';
    migrationDialog.showModal();
    return new Promise(resolve => { migrationResolver = resolve; });
  }

  function finishMigrationDialog(action) {
    if (!migrationResolver) return;
    const resolve = migrationResolver;
    migrationResolver = null;
    migrationDialog.close();
    resolve(action);
  }

  async function handleProjectResult(result, entryGeneration, entryKind = 'existing') {
    if (!isProjectEntryCurrent(entryGeneration)) return false;
    result = normalizeResult(result);
    if (result.migration?.kind === 'legacy-edit') {
      const migration = result.migration;
      const action = await presentMigration({
        title: '迁移旧项目 Prompt',
        description: '检测到旧名 editor.md。确认后会安全改名为 edit.md；取消、失败或预览后文件变化都不会覆盖原稿。',
        target: migration.targetPath,
        preview: migration.source?.content || '',
        warnings: migration.source?.truncated ? ['预览已截断，迁移仍会保留完整文件。'] : [],
        confirmLabel: '确认改名并打开',
      });
      if (!isProjectEntryCurrent(entryGeneration)) {
        await releaseEntryMigration(migration.token);
        return false;
      }
      if (action !== 'confirm') {
        await bridge?.discardMigration?.(migration.token);
        if (!isProjectEntryCurrent(entryGeneration)) return false;
        setSaveState('旧项目未迁移，原文件保持不变', 'future');
        return false;
      }
      setSaveState('正在迁移旧项目 Prompt…', 'saving');
      let next;
      try { next = normalizeResult(await bridge.confirmLegacyEdit(migration.token)); }
      catch (error) { next = { ok: false, message: error.message }; }
      if (!isProjectEntryCurrent(entryGeneration)) return false;
      if (!next.ok && !next.migration) {
        showError(resultMessage(next, '迁移失败，原文件保持不变'));
        return false;
      }
      return handleProjectResult(next, entryGeneration, entryKind);
    }
    const entered = await enterProject(result, entryGeneration);
    if (entered && entryKind === 'created') setWorkspaceView('home');
    return entered;
  }

  function markdownTreePaths(nodes, output = new Set()) {
    for (const node of nodes || []) {
      if (node.type === 'directory') markdownTreePaths(node.children, output);
      else if (node.type === 'file' && isPublicMarkdownPath(nodePath(node))) output.add(nodePath(node));
    }
    return output;
  }

  async function readRecoveryEntry(path) {
    const key = recoveryKey(path);
    if (!key) return null;
    const candidates = [];
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (value && typeof value.content === 'string') candidates.push(value);
    } catch (_) {}
    if (bridge?.readRecovery) {
      try {
        const result = normalizeResult(await bridge.readRecovery(path));
        if (result.ok && result.recovery && typeof result.recovery.content === 'string') {
          candidates.push({
            content: result.recovery.content,
            revision: result.recovery.baseRevision || null,
            savedAt: result.recovery.savedAt,
          });
        }
      } catch (_) {}
    }
    candidates.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    return candidates[0] || null;
  }

  async function releaseEntryMigration(token) {
    if (!token || !bridge?.discardMigration) return;
    try { await bridge.discardMigration(token); } catch (_) {}
  }

  async function maybeOfferOrphanRecovery(owner = null) {
    if (!isOwnedProjectEntryCurrent(owner)) return false;
    if (!state.project || !bridge?.previewLegacyDraft) return true;
    const existing = markdownTreePaths(state.tree);
    const recoveryPaths = new Set(loadRecoveryManifest());
    if (bridge.listRecoveries) {
      try {
        const result = normalizeResult(await bridge.listRecoveries());
        if (!isOwnedProjectEntryCurrent(owner)) return false;
        if (result.ok) for (const entry of result.recoveries || []) {
          if (isPublicMarkdownPath(entry.path)) recoveryPaths.add(entry.path);
        }
      } catch (_) {}
    }
    for (const path of [...recoveryPaths].slice(0, 100)) {
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      if (existing.has(path)) continue;
      const recovery = await readRecoveryEntry(path);
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      if (!recovery) {
        clearRecovery(path);
        continue;
      }
      let planned;
      try { planned = normalizeResult(await bridge.previewLegacyDraft(recovery.content, path)); }
      catch (error) { planned = { ok: false, message: error.message }; }
      if (!isOwnedProjectEntryCurrent(owner)) {
        await releaseEntryMigration(planned?.token);
        return false;
      }
      if (!planned.ok) {
        showError(resultMessage(planned, '无法准备被删除文件的恢复预览'));
        return false;
      }
      const action = await presentMigration({
        title: path === 'edit.md' ? '恢复缺失的项目 Prompt' : '发现被外部删除的未保存稿',
        description: '恢复清单中仍保留这份内存稿，但磁盘文件已经不存在。你可以安全恢复为新文件、暂不处理，或明确丢弃恢复稿。',
        target: planned.plan.targetPath,
        preview: recovery.content.slice(0, 60000),
        warnings: recovery.content.length > 60000 ? ['预览已截断，恢复仍使用完整内容。'] : [],
        confirmLabel: '恢复为项目文件',
        laterLabel: '暂不处理',
        allowDiscard: true,
        discardLabel: '丢弃恢复稿',
      });
      if (!isOwnedProjectEntryCurrent(owner)) {
        await releaseEntryMigration(planned.token);
        return false;
      }
      if (action === 'discard') {
        await bridge.discardMigration?.(planned.token);
        if (!isOwnedProjectEntryCurrent(owner)) return false;
        clearRecovery(path);
        setSaveState('已丢弃所选恢复稿，磁盘文件未改动', 'future');
        continue;
      }
      if (action !== 'confirm') {
        await bridge.discardMigration?.(planned.token);
        if (!isOwnedProjectEntryCurrent(owner)) return false;
        setSaveState('恢复稿继续保留，可稍后处理', 'future');
        return true;
      }
      if (!isOwnedProjectEntryCurrent(owner)) {
        await releaseEntryMigration(planned.token);
        return false;
      }
      let restored;
      try { restored = normalizeResult(await bridge.confirmLegacyDraft(planned.token)); }
      catch (error) { restored = { ok: false, message: error.message }; }
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      if (!restored.ok) {
        showError(resultMessage(restored, '恢复失败；恢复稿仍保留'));
        return false;
      }
      clearRecovery(path);
      state.tree = restored.tree || state.tree;
      if (state.currentPath === restored.file.path) {
        clearTimeout(state.saveTimer);
        state.dirty = false;
        state.conflictRecovery = false;
        state.conflictRevision = null;
        state.externalDeleted = false;
        state.revision = restored.file.revision || null;
        showConflictActions(false);
        state.currentPath = '';
      }
      if (restored.file.path === 'edit.md') {
        state.projectPromptMissing = false;
        if (!(await loadEditContext(owner))) return false;
      }
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      renderTree();
      const opened = await openFile(restored.file.path);
      if (!isOwnedProjectEntryCurrent(owner) || !opened) return false;
      setSaveState('已从恢复清单重建文件', 'saved');
      continue;
    }
    return true;
  }

  async function maybeOfferLegacyDraft(owner = null) {
    if (!isOwnedProjectEntryCurrent(owner)) return false;
    if (legacyDraftSnoozed || !state.project || !window.__legacyDraft || !bridge?.previewLegacyDraft) return true;
    let raw = null;
    try { raw = localStorage.getItem(window.__legacyDraft.STORAGE_KEY); } catch (_) {}
    const legacy = window.__legacyDraft.inspect(raw, document);
    if (!legacy) return true;
    let planned;
    try { planned = normalizeResult(await bridge.previewLegacyDraft(legacy.markdown, 'chapters/imported-draft.md')); }
    catch (error) { planned = { ok: false, message: error.message }; }
    if (!isOwnedProjectEntryCurrent(owner)) {
      await releaseEntryMigration(planned?.token);
      return false;
    }
    if (!planned.ok) {
      showError(resultMessage(planned, '旧草稿预览失败，草稿仍保留在本机'));
      return false;
    }
    const marker = `writcraft:v0:draft-migrated:${planned.plan.revision}`;
    try {
      if (localStorage.getItem(marker)) {
        await bridge.discardMigration?.(planned.token);
        return isOwnedProjectEntryCurrent(owner);
      }
    } catch (_) {}
    const warnings = [...legacy.warnings];
    if (legacy.savedAt) warnings.push(`旧草稿保存时间：${new Date(legacy.savedAt).toLocaleString()}`);
    if (planned.plan.renamed) warnings.push('建议文件名已存在，系统已生成不冲突的新文件名。');
    const action = await presentMigration({
      title: '发现旧版单文档草稿',
      description: '这份 localStorage 草稿尚未进入项目。确认后会新建 Markdown 文件并校验内容；原始草稿至少保留一个发布周期。',
      target: planned.plan.targetPath,
      preview: legacy.markdown.slice(0, 60000),
      warnings: legacy.markdown.length > 60000 ? [...warnings, '预览已截断，导入仍使用完整草稿。'] : warnings,
      confirmLabel: '导入为项目文件',
    });
    if (!isOwnedProjectEntryCurrent(owner)) {
      await releaseEntryMigration(planned.token);
      return false;
    }
    if (action !== 'confirm') {
      await bridge.discardMigration?.(planned.token);
      if (!isOwnedProjectEntryCurrent(owner)) return false;
      legacyDraftSnoozed = true;
      setSaveState('旧草稿已保留，可稍后再次迁移', 'future');
      return true;
    }
    if (!isOwnedProjectEntryCurrent(owner)) {
      await releaseEntryMigration(planned.token);
      return false;
    }
    let imported;
    try { imported = normalizeResult(await bridge.confirmLegacyDraft(planned.token)); }
    catch (error) { imported = { ok: false, message: error.message }; }
    if (!isOwnedProjectEntryCurrent(owner)) return false;
    if (!imported.ok) {
      showError(resultMessage(imported, '草稿导入失败；旧草稿仍保留'));
      return false;
    }
    try { localStorage.setItem(marker, JSON.stringify({ importedAt: Date.now(), path: imported.file.path })); } catch (_) {}
    state.tree = imported.tree || state.tree;
    renderTree();
    const opened = await openFile(imported.file.path);
    if (!isOwnedProjectEntryCurrent(owner) || !opened) return false;
    setSaveState('旧草稿已导入；原始备份仍保留', 'saved');
    return true;
  }

  async function createProject(name) {
    if (!bridge || !bridge.create) return showError('项目服务未连接');
    const requestOwner = beginProjectEntryRequest();
    if (requestOwner === null) return showError('项目正在安全打开中，请稍候');
    const entryGeneration = beginProjectEntry();
    try {
      if (!(await persistCurrent(true))) return;
      if (!isProjectEntryCurrent(entryGeneration)) return;
      if (window.__changesView?.discardPending && !(await window.__changesView.discardPending())) {
        return showError('当前 Onboarding 审阅未能安全结算，已停止切换项目');
      }
      if (!isProjectEntryCurrent(entryGeneration)) return;
      if (window.__imageGenerationView?.discardPending &&
          !(await window.__imageGenerationView.discardPending())) {
        return showError('请先对当前生成图片选择插入、保留或移入废纸篓，再切换项目');
      }
      if (!isProjectEntryCurrent(entryGeneration)) return;
      await saveWorkspaceNow();
      if (!isProjectEntryCurrent(entryGeneration)) return;
      setSaveState('正在创建项目…', 'saving');
      const result = await bridge.create(name);
      if (!isProjectEntryCurrent(entryGeneration)) return;
      await handleProjectResult(result, entryGeneration, 'created');
    } catch (error) {
      if (isProjectEntryCurrent(entryGeneration)) showError(error.message);
    } finally {
      finishProjectEntryRequest(requestOwner);
    }
  }

  async function openProject() {
    if (!bridge || !bridge.open) return showError('项目服务未连接');
    const requestOwner = beginProjectEntryRequest();
    if (requestOwner === null) return showError('项目正在安全打开中，请稍候');
    const entryGeneration = beginProjectEntry();
    try {
      if (!state.inlineMutationBlocked && !(await persistCurrent(true))) return;
      if (!isProjectEntryCurrent(entryGeneration)) return;
      if (window.__changesView?.discardPending && !(await window.__changesView.discardPending())) {
        return showError('当前 Onboarding 审阅未能安全结算，已停止切换项目');
      }
      if (!isProjectEntryCurrent(entryGeneration)) return;
      if (window.__imageGenerationView?.discardPending &&
          !(await window.__imageGenerationView.discardPending())) {
        return showError('请先对当前生成图片选择插入、保留或移入废纸篓，再切换项目');
      }
      if (!isProjectEntryCurrent(entryGeneration)) return;
      await saveWorkspaceNow();
      if (!isProjectEntryCurrent(entryGeneration)) return;
      setSaveState('正在打开项目…', 'saving');
      const result = await bridge.open();
      if (!isProjectEntryCurrent(entryGeneration)) return;
      await handleProjectResult(result, entryGeneration);
    } catch (error) {
      if (isProjectEntryCurrent(entryGeneration)) showError(error.message);
    } finally {
      finishProjectEntryRequest(requestOwner);
    }
  }

  async function createFile(path) {
    if (!state.project || !bridge || !bridge.createFile) return;
    if (!(await persistCurrent(true))) return;
    const normalized = path.trim().replace(/\\/g, '/');
    const markdownPath = /\.(?:md|markdown)$/i.test(normalized) ? normalized : `${normalized}.md`;
    let result;
    try {
      result = normalizeResult(await bridge.createFile(markdownPath));
    } catch (error) {
      showError(error.message);
      return;
    }
    if (!result.ok) return showError(resultMessage(result, '创建文件失败'));
    await refreshTree();
    await openFile(result.file?.path || result.path || markdownPath);
  }

  function setAIVisible(visible) {
    if (window.__assistantDock) {
      if (visible) window.__assistantDock.open('chat');
      else window.__assistantDock.close('chat');
    } else {
      workArea.classList.toggle('has-ai', visible);
      chatPanel.hidden = !visible;
    }
    document.getElementById('activity-ai')?.setAttribute('aria-pressed', String(visible));
  }

  function setWorkspaceView(name) {
    if (!WORKSPACE_VIEWS.has(name)) return false;
    if (name === 'graph' && !state.project) {
      setSaveState('请先创建或打开写作项目', 'error');
      return false;
    }

    const previous = activeWorkspaceView;
    activeWorkspaceView = name;
    if (appShell) appShell.dataset.workspaceView = name;

    const sidebarVisible = !['graph', 'home'].includes(name);
    if (explorerView) explorerView.hidden = !sidebarVisible || name !== 'explorer';
    if (searchView) searchView.hidden = !sidebarVisible || name !== 'search';
    if (sourcesView) sourcesView.hidden = !sidebarVisible || name !== 'sources';

    for (const button of document.querySelectorAll('.activity-button[data-workspace-view]')) {
      const selected = button.dataset.workspaceView === name;
      button.classList.toggle('is-active', selected);
      if (selected) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }

    if (name === 'graph') window.__graphView?.activate?.();
    else window.__graphView?.deactivate?.();
    if (name === 'search') window.__searchView?.activate?.();
    if (name === 'sources') window.__sourcesView?.activate?.();

    document.dispatchEvent(new CustomEvent('writcraft:sidebar-view-changed', { detail: name }));
    document.dispatchEvent(new CustomEvent('writcraft:workspace-view-changed', {
      detail: { view: name, previous },
    }));
    return true;
  }

  function setSidebarView(name) {
    return setWorkspaceView(name);
  }

  function getAIContext() {
    if (!state.project) return '';
    const sections = [
      `[写作项目]\n${state.project.name}`,
      state.projectPromptMissing
        ? '[项目级 Prompt · edit.md]\n缺失：本次 AI 操作已被工作区阻止'
        : `[项目级 Prompt · edit.md · ${state.editContextRevision.slice(0, 12)}]\n${state.editContext || '尚未填写'}`,
      `[当前文件]\n${state.currentPath || '未打开文件'}`,
    ];
    return sections.join('\n\n');
  }

  async function reloadCurrent() {
    const path = state.currentPath;
    if (!path || state.dirty) return false;
    state.currentPath = '';
    await openFile(path);
    return state.currentPath === path;
  }

  function changeTouchesCurrent(payload) {
    if (!payload || payload.projectInstanceId !== state.project?.instanceId) return false;
    return (payload.changes || []).some(change => !change.path || change.path === state.currentPath);
  }

  function changeTouchesPath(payload, path) {
    return (payload?.changes || []).some(change => !change.path || change.path === path);
  }

  function canUseAI() {
    return Boolean(state.project && state.projectReady && !state.inlineMutationBlocked && !state.projectPromptMissing &&
      !state.conflictRecovery && !state.externalDeleted && externalSyncState?.available());
  }

  function captureAIRequestGuard() {
    return window.__aiRequestGuard?.capture(state) || null;
  }

  function isAIRequestCurrent(guard) {
    return canUseAI() && Boolean(window.__aiRequestGuard?.matches(guard, state));
  }

  async function flushExternalChanges() {
    const projectInstanceId = state.project?.instanceId;
    if (!projectInstanceId || typeof bridge?.flushExternalChanges !== 'function') {
      throw new Error('项目文件同步服务未连接，请重新打开项目');
    }
    const result = normalizeResult(await bridge.flushExternalChanges(projectInstanceId));
    if (!result.ok) {
      const message = resultMessage(result, '项目文件同步失败，请重新打开项目');
      setSaveState(`⚠ ${message}`, 'error');
      throw new Error(message);
    }
    if (state.project?.instanceId !== projectInstanceId ||
        result.projectInstanceId !== projectInstanceId) {
      throw new Error('项目状态已变化，请重新发起 AI 请求');
    }
    if (!externalSyncState) throw new Error('项目文件同步服务未连接，请重新打开项目');
    await externalSyncState.drain();
    if (state.project?.instanceId !== projectInstanceId) {
      throw new Error('项目状态已变化，请重新发起 AI 请求');
    }
    return result;
  }

  async function settleOwnWriteEcho() {
    return flushExternalChanges();
  }

  async function refreshExternalEditContext(payload, owner) {
    if (state.currentPath === 'edit.md' || !changeTouchesPath(payload, 'edit.md')) return false;
    let result;
    try { result = normalizeResult(await bridge.readFile('edit.md')); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (!owner.isCurrent()) return false;
    if (!result.ok) {
      if (state.editContext) writeRecoveryEntry('edit.md', state.editContext, state.editContextRevision);
      state.editContext = '';
      state.editContextRevision = '';
      state.projectPromptMissing = true;
      state.promptFrontMatter = null;
      updateDocumentChrome(state.currentPath);
      setSaveState('⚠ edit.md 已从磁盘删除；AI 操作已暂停', 'error');
      await maybeOfferOrphanRecovery(owner);
      if (!owner.isCurrent()) return false;
      return true;
    }
    if (result.revision === state.editContextRevision) return false;
    state.editContext = result.content || '';
    state.editContextRevision = result.revision || '';
    state.projectPromptMissing = false;
    state.promptFrontMatter = result.frontMatter || null;
    updateDocumentChrome(state.currentPath);
    if (!state.dirty) setSaveState('项目 Prompt 已同步外部修改', 'saved');
    return true;
  }

  async function handleExternalChange(payload) {
    if (!state.project || payload?.projectInstanceId !== state.project.instanceId) return;
    if (state.inlineMutationBlocked) return;
    const projectInstanceId = state.project.instanceId;
    const currentPath = state.currentPath;
    const sequence = ++externalChangeSequence;
    const owner = Object.freeze({
      projectInstanceId,
      currentPath,
      sequence,
      isCurrent() {
        return sequence === externalChangeSequence &&
          state.project?.instanceId === projectInstanceId && state.currentPath === currentPath;
      },
    });
    const authoritativeExternal = payload.aiContextChanged !== false;
    const changes = payload.changes || [];
    const graphChangedPaths = authoritativeExternal
      ? [...new Set(changes.map(change => change?.path).filter(isPublicMarkdownPath))].slice(0, 100)
      : [];
    const graphInvalidated = authoritativeExternal && changes.some(change => !change?.path);
    if (graphChangedPaths.length || graphInvalidated) {
      document.dispatchEvent(new CustomEvent('writcraft:graph-source-changed', {
        detail: { projectInstanceId, paths: graphChangedPaths, invalidateAll: graphInvalidated },
      }));
    }
    const projectInvalidated = changes.some(change => !change.path);
    const otherPathChanged = changes.some(change => change.path
      && change.path !== currentPath && change.path !== 'edit.md');
    if (await refreshTree(owner) === false || !owner.isCurrent()) return;
    const editContextChanged = await refreshExternalEditContext(payload, owner);
    if (!owner.isCurrent()) return;
    if (!currentPath || !changeTouchesPath(payload, currentPath)) {
      if (authoritativeExternal && window.__aiRequestGuard?.shouldAdvanceContext({ editContextChanged, otherPathChanged, projectInvalidated })) {
        state.aiContextGeneration += 1;
        document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
          detail: { reason: 'external-project-context' },
        }));
      }
      return;
    }
    // Our own atomic save also produces a filesystem event. Wait for it to
    // settle, then compare revisions; matching revisions are a harmless echo.
    if (state.savePromise) {
      try { await state.savePromise; } catch (_) {}
      if (!owner.isCurrent()) return;
    }
    const path = currentPath;
    let result;
    try { result = normalizeResult(await bridge.readFile(path)); }
    catch (error) { result = { ok: false, error: error.message }; }
    if (!owner.isCurrent()) return;

    if (!result.ok) {
      if (authoritativeExternal) state.aiContextGeneration += 1;
      state.editVersion += 1;
      state.dirty = true;
      pinTab(path);
      renderTabs();
      state.conflictRecovery = true;
      state.conflictRevision = null;
      state.externalDeleted = true;
      state.revision = null;
      if (path === 'edit.md') {
        state.editContext = '';
        state.editContextRevision = '';
        state.projectPromptMissing = true;
        state.promptFrontMatter = null;
      }
      saveRecovery();
      showConflictActions(true);
      setSaveState('⚠ 文件已从磁盘删除；可用当前内容重新创建，或关闭标签', 'error');
      document.dispatchEvent(new CustomEvent('writcraft:current-file-authority-changed', {
        detail: {
          projectInstanceId,
          path,
          revision: null,
          status: 'missing',
        },
      }));
      document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
        detail: { reason: 'external-current-file-deleted', path },
      }));
      await maybeOfferOrphanRecovery(owner);
      if (!owner.isCurrent()) return;
      return;
    }
    const currentRevisionChanged = result.revision !== state.revision;
    if (authoritativeExternal && window.__aiRequestGuard?.shouldAdvanceContext({ currentRevisionChanged, editContextChanged, otherPathChanged, projectInvalidated })) {
      state.aiContextGeneration += 1;
      document.dispatchEvent(new CustomEvent('writcraft:chat-context-invalidated', {
        detail: { reason: 'external-current-file-changed', path },
      }));
    }
    // A matching authoritative revision is the delayed watcher echo from our
    // own save. It must not invalidate a guard captured after that save.
    if (!currentRevisionChanged) return;
    if (state.dirty) {
      state.conflictRecovery = true;
      state.conflictRevision = result.revision || null;
      state.externalDeleted = false;
      saveRecovery();
      showConflictActions(true);
      setSaveState('⚠ 外部文件已变化；请选择保留本地稿或使用磁盘版本', 'error');
      document.dispatchEvent(new CustomEvent('writcraft:current-file-authority-changed', {
        detail: {
          projectInstanceId,
          path,
          revision: result.revision || null,
          status: 'conflict',
        },
      }));
      return;
    }
    captureCurrentView();
    state.currentPath = '';
    await openFile(path);
    if (state.project?.instanceId === projectInstanceId && state.currentPath === path) {
      setSaveState('已重新载入外部修改', 'saved');
    }
  }

  async function closeExternallyDeletedTab() {
    const path = state.currentPath;
    const index = state.tabs.indexOf(path);
    clearRecovery(path);
    state.dirty = false;
    state.conflictRecovery = false;
    state.conflictRevision = null;
    state.externalDeleted = false;
    showConflictActions(false);
    state.currentPath = '';
    state.revision = null;
    if (index >= 0) state.tabs.splice(index, 1);
    if (state.previewPath === path) state.previewPath = null;
    const fallback = state.tabs[Math.min(Math.max(index, 0), state.tabs.length - 1)];
    if (fallback) await openFile(fallback);
    else {
      state.loading = true;
      window.__editor?.loadDocument ? window.__editor.loadDocument('') : editor.replaceChildren();
      state.loading = false;
      updateDocumentChrome('');
      setSaveState('文件已从磁盘删除', 'error');
    }
    scheduleWorkspaceSave();
  }

  async function keepLocalConflictDraft() {
    if (!state.conflictRecovery || !state.currentPath) return false;
    const path = state.currentPath;
    const content = window.__editor?.getContent?.() || editor.innerText || '';
    const version = state.editVersion;
    setSaveState(state.externalDeleted ? '正在重新创建文件…' : '正在确认覆盖磁盘版本…', 'saving');
    let result;
    try {
      if (state.externalDeleted) {
        result = normalizeResult(await bridge?.recreateDeleted?.(path, content));
      } else {
        if (!state.conflictRevision) {
          showError('缺少已审阅的磁盘版本，请先选择使用磁盘版本再重新编辑');
          return false;
        }
        result = normalizeResult(await bridge?.overwriteConflict?.(path, content, state.conflictRevision));
      }
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (!result?.ok) {
      showConflictActions(true);
      showError(resultMessage(result, '磁盘再次变化，未覆盖任何内容'));
      return false;
    }
    state.revision = result.file?.revision || null;
    state.dirty = version !== state.editVersion;
    if (state.dirty) pinTab(path);
    state.conflictRecovery = false;
    state.conflictRevision = null;
    state.externalDeleted = false;
    state.tree = result.tree || state.tree;
    if (path === 'edit.md') {
      state.editContext = content;
      state.editContextRevision = state.revision || '';
      state.projectPromptMissing = false;
      state.promptFrontMatter = result.file?.frontMatter || state.promptFrontMatter;
    }
    showConflictActions(false);
    renderTabs();
    if (!state.dirty) {
      clearRecovery(path);
      setSaveState('已按确认保留本地稿', 'saved');
    } else {
      saveRecovery();
      state.saveTimer = setTimeout(() => persistCurrent(false), 500);
      setSaveState('已处理冲突；仍有新修改待保存', 'dirty');
    }
    updateDocumentChrome(path);
    return true;
  }

  createButtons.forEach(button => button.addEventListener('click', () => {
    if (projectMenu) projectMenu.open = false;
    projectNameInput.value = '';
    createDialog.showModal();
    projectNameInput.focus();
  }));
  openButtons.forEach(button => button.addEventListener('click', () => {
    if (projectMenu) projectMenu.open = false;
    openProject();
  }));
  startOnboardingButton?.addEventListener('click', openProjectOnboarding);
  document.querySelectorAll('.activity-button[data-workspace-view]').forEach(button => {
    button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView));
  });
  newFileButton.addEventListener('click', () => {
    newFileInput.value = '';
    newFileDialog.showModal();
    newFileInput.focus();
  });
  createForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = projectNameInput.value.trim();
    if (!name) return;
    createDialog.close();
    createProject(name);
  });
  newFileForm.addEventListener('submit', event => {
    event.preventDefault();
    const path = newFileInput.value.trim();
    if (!path) return;
    newFileDialog.close();
    createFile(path);
  });
  document.querySelectorAll('dialog button[value="cancel"]').forEach(button => {
    button.type = 'button';
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  document.getElementById('toggle-ai')?.addEventListener('click', () => {
    setAIVisible(!window.__assistantDock?.isOpen?.('chat') && chatPanel.hidden);
  });
  document.getElementById('activity-ai')?.addEventListener('click', () => setAIVisible(true));
  editor.addEventListener('input', scheduleProjectSave);
  editor.addEventListener('keyup', scheduleWorkspaceSave);
  editor.addEventListener('mouseup', scheduleWorkspaceSave);
  editorScroll?.addEventListener('scroll', scheduleWorkspaceSave, { passive: true });
  workspaceReturn?.addEventListener('click', () => { void returnToPreviousLocation(); });
  conflictKeepLocal?.addEventListener('click', async () => {
    await keepLocalConflictDraft();
  });
  conflictUseDisk?.addEventListener('click', async () => {
    if (state.externalDeleted) return closeExternallyDeletedTab();
    const path = state.currentPath;
    clearTimeout(state.saveTimer);
    clearRecovery(path);
    state.dirty = false;
    state.conflictRecovery = false;
    state.conflictRevision = null;
    state.externalDeleted = false;
    showConflictActions(false);
    state.currentPath = '';
    await openFile(path);
  });
  migrationForm?.addEventListener('submit', event => {
    event.preventDefault();
    finishMigrationDialog('confirm');
  });
  migrationLater?.addEventListener('click', () => finishMigrationDialog('later'));
  migrationDiscard?.addEventListener('click', () => finishMigrationDialog('discard'));
  migrationDialog?.addEventListener('cancel', event => {
    event.preventDefault();
    finishMigrationDialog('later');
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      persistCurrent(true);
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest?.('.tree-file-menu')) closeFileMenus();
    if (projectMenu?.open && !event.target.closest?.('#project-menu')) projectMenu.open = false;
  });
  projectMenu?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !projectMenu.open) return;
    event.preventDefault();
    projectMenu.open = false;
    projectMenu.querySelector('summary')?.focus();
  });
  markdownTrash?.addEventListener('toggle', () => {
    markdownTrashToggle?.setAttribute('aria-expanded', String(markdownTrash.open));
    if (markdownTrash.open) refreshMarkdownTrash();
  });
  markdownTrashRefresh?.addEventListener('click', refreshMarkdownTrash);
  markdownTrash?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !markdownTrash.open) return;
    event.preventDefault();
    markdownTrash.open = false;
    markdownTrashToggle?.focus();
  });
  window.addEventListener('beforeunload', () => {
    saveRecovery();
    clearTimeout(state.workspaceTimer);
    state.workspaceTimer = null;
    // A close event cannot wait for Promise-based IPC. Use the narrow Main
    // close-flush bridge so the latest caret/selection/scroll state is durable.
    try {
      if (state.project) bridge?.saveWorkspaceBeforeClose?.(
        state.project.instanceId,
        workspaceSnapshot()
      );
    } catch (_) {}
  });

  editContextChip?.addEventListener('click', () => {
    const diagnostics = Array.isArray(state.promptFrontMatter?.diagnostics) ? state.promptFrontMatter.diagnostics : [];
    if (state.projectPromptMissing || !diagnostics.length || !editDiagnosticPanel) return;
    editDiagnosticPanel.hidden = !editDiagnosticPanel.hidden;
    editContextChip.setAttribute('aria-expanded', String(!editDiagnosticPanel.hidden));
  });
  editDiagnosticRepair?.addEventListener('click', proposeEditPromptRepair);
  document.addEventListener('click', event => {
    if (!editDiagnosticPanel || editDiagnosticPanel.hidden) return;
    if (editDiagnosticPanel.contains(event.target) || editContextChip?.contains(event.target)) return;
    editDiagnosticPanel.hidden = true;
    editContextChip?.setAttribute('aria-expanded', 'false');
  });

  if (!bridge) showError('项目服务未连接；编辑器仍可使用本地草稿模式');
  renderTree();
  setAIVisible(false);

  if (bridge?.openRecent) {
    const requestOwner = beginProjectEntryRequest();
    if (requestOwner !== null) {
      const entryGeneration = beginProjectEntry();
      bridge.openRecent()
        .then(result => handleProjectResult(result, entryGeneration))
        .catch(() => {})
        .finally(() => finishProjectEntryRequest(requestOwner));
    }
  }

  const unsubscribeExternalChanges = bridge?.onExternalChange?.(payload => {
    externalSyncState?.enqueue(
      () => handleExternalChange(payload),
      error => showError(error.message)
    );
  });
  window.addEventListener('unload', () => unsubscribeExternalChanges?.(), { once: true });

  const workspaceApi = {
    getAIContext,
    canUseAI,
    captureAIRequestGuard,
    isAIRequestCurrent,
    supersedeChatRequest,
    captureChatRequestIntent,
    beginChatRequest,
    isChatRequestCurrent,
    flushExternalChanges,
    settleOwnWriteEcho,
    getCurrentPath: () => state.currentPath,
    getCursorOffset,
    getFirstVisibleOffset,
    persistCurrent,
    refreshTree,
    reloadCurrent,
    openFile,
    revealRange,
    captureEditorReturnState,
    pushReturnLocation,
    returnToPreviousLocation,
    updateOutlineViewState,
    resolveContextSelections,
    revealContextChip,
    insertSourceCitation,
    insertGeneratedImage,
    setWorkspaceView,
    setSidebarView,
    setAIVisible,
    openProjectOnboarding,
    beginInlineRewriteRecovery,
    completeInlineRewriteCommit,
    restoreInlineRewriteAfterZeroWrite,
    reconcileInlineRewriteOnProjectEnter,
    setInlineMutationBlocked,
    setChangesHistoryMutationBlocked,
    beginChangesHistoryMutation,
    reconcileChangesHistoryAfterMutation,
    reconcileChangesHistoryOnProjectEnter,
    resolveChangesHistoryRecovery,
    state,
  };
  window.WritCraftWorkspace = workspaceApi;
  window.__workspace = workspaceApi;
})();
