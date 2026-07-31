// WritCraft V0 · preload.js
// Electron 安全的核心：contextIsolation: true 模式下的唯一桥梁
// 通过 contextBridge 暴露最小 API 给 renderer
//
// Day 3: 暴露 ⌘K 改写 + ⌘L 全局对话（IPC 路由到 main 进程 → MiniMax M3）

const { contextBridge, ipcRenderer } = require('electron');

const WATCHER_FLUSH_RESULT_SCHEMA = 'writcraft.watcher-flush-result/v1';
const WATCHER_FLUSH_BARRIER_SCHEMA = 'writcraft.watcher-flush-barrier/v1';
const WATCHER_FLUSH_BARRIER_CHANNEL = 'writcraft:project:watcher-flushed';
const WATCHER_FLUSH_TIMEOUT_MS = 15_000;

function watcherFlushFailure(error, message) {
  return Object.freeze({ ok: false, error, message });
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validWatcherFlushResult(value, projectInstanceId) {
  return exactKeys(value, ['ok', 'schema', 'flushId', 'projectInstanceId', 'mutationGeneration']) &&
    value.ok === true &&
    value.schema === WATCHER_FLUSH_RESULT_SCHEMA &&
    typeof value.flushId === 'string' && value.flushId.length > 0 &&
    value.projectInstanceId === projectInstanceId &&
    Number.isSafeInteger(value.mutationGeneration) && value.mutationGeneration >= 0;
}

function validWatcherFlushBarrier(value) {
  return exactKeys(value, ['schema', 'flushId', 'projectInstanceId', 'mutationGeneration']) &&
    value.schema === WATCHER_FLUSH_BARRIER_SCHEMA &&
    typeof value.flushId === 'string' && value.flushId.length > 0 &&
    typeof value.projectInstanceId === 'string' && value.projectInstanceId.length > 0 &&
    Number.isSafeInteger(value.mutationGeneration) && value.mutationGeneration >= 0;
}

function flushExternalChanges(projectInstanceId) {
  if (typeof projectInstanceId !== 'string' || !projectInstanceId) {
    return Promise.resolve(watcherFlushFailure(
      'PROJECT_CHANGED',
      '项目状态已变化，请重新发起 AI 请求'
    ));
  }
  return new Promise(resolve => {
    let response = null;
    let settled = false;
    const seenBarriers = new Map();
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcRenderer.removeListener(WATCHER_FLUSH_BARRIER_CHANNEL, onBarrier);
      resolve(result);
    };
    const maybeFinish = () => {
      if (!response) return;
      const barrier = seenBarriers.get(response.flushId);
      if (!barrier ||
          barrier.projectInstanceId !== response.projectInstanceId ||
          barrier.mutationGeneration !== response.mutationGeneration) return;
      finish(response);
    };
    const onBarrier = (_event, payload) => {
      if (!validWatcherFlushBarrier(payload)) return;
      seenBarriers.set(payload.flushId, payload);
      while (seenBarriers.size > 16) seenBarriers.delete(seenBarriers.keys().next().value);
      maybeFinish();
    };

    // Install the exact-barrier listener before invoke. Main sends the
    // barrier before returning success, so the reverse order would race.
    ipcRenderer.on(WATCHER_FLUSH_BARRIER_CHANNEL, onBarrier);
    const timeout = setTimeout(() => finish(watcherFlushFailure(
      'PROJECT_WATCHER_BARRIER_TIMEOUT',
      '项目文件同步确认超时，请重新打开项目'
    )), WATCHER_FLUSH_TIMEOUT_MS);
    Promise.resolve()
      .then(() => ipcRenderer.invoke('writcraft:project:flush-external-changes', projectInstanceId))
      .then(result => {
        if (!result || result.ok !== true) {
          finish(result || watcherFlushFailure(
            'PROJECT_WATCHER_UNAVAILABLE',
            '项目文件监控没有返回结果'
          ));
          return;
        }
        if (!validWatcherFlushResult(result, projectInstanceId)) {
          finish(watcherFlushFailure(
            'PROJECT_WATCHER_BARRIER_INVALID',
            '项目文件同步确认无效，请重新打开项目'
          ));
          return;
        }
        response = result;
        maybeFinish();
      })
      .catch(() => finish(watcherFlushFailure(
        'PROJECT_WATCHER_UNAVAILABLE',
        '项目文件监控不可用，请重新打开项目'
      )));
  });
}

contextBridge.exposeInMainWorld('writCraft', {
  // Day 1: Key 类型检测
  detectKeyType: (key) => ipcRenderer.invoke('writcraft:detect-key-type', key),

  // Day 2: API 健康检查
  checkApi: () => ipcRenderer.invoke('writcraft:check-api'),

  // P1-4: AI Key 配置——renderer 只能 set / clear / status，绝不能读取明文 Key
  apiKey: Object.freeze({
    status: () => ipcRenderer.invoke('writcraft:api-key:status'),
    set: (key) => ipcRenderer.invoke('writcraft:api-key:set', key),
    clear: () => ipcRenderer.invoke('writcraft:api-key:clear'),
    check: () => ipcRenderer.invoke('writcraft:check-api'),
  }),

  // Privacy-safe diagnostics. Renderer can request the exact Main-owned
  // preview and later return only its short-lived token; it never supplies
  // diagnostic content or a filesystem path.
  diagnostics: Object.freeze({
    preview: () => ipcRenderer.invoke('writcraft:diagnostics:preview'),
    export: (token) => ipcRenderer.invoke('writcraft:diagnostics:export', {
      schema: 'writcraft.diagnostic-export/v1',
      token,
    }),
  }),

  // 项目态 ⌘K：Renderer 只提供 revision + locator proof，Main 重建正文。
  rewrite: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:rewrite', projectInstanceId, request),
  ackRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:ack', projectInstanceId, payload),
  applyRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:apply', projectInstanceId, payload),
  discardRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:discard', projectInstanceId, payload),
  getRewriteReconciliation: (projectInstanceId, payload) =>
    ipcRenderer.invoke('writcraft:rewrite:reconciliation', projectInstanceId, payload),
  clearRewriteReconciliation: (projectInstanceId, payload) =>
    ipcRenderer.invoke('writcraft:rewrite:reconciliation-clear', projectInstanceId, payload),

  // Chat 正文和最近轮次均由 Main 持有；Renderer 只提交本轮问题与
  // 结构化 Context request，并可显式要求清空当前 Main 会话。
  chat: (projectInstanceId, userMessage, projectContext, contextRequest) => ipcRenderer.invoke('writcraft:chat', projectInstanceId, userMessage, projectContext, contextRequest),
  chatConversation: Object.freeze({
    reset: (projectInstanceId) => ipcRenderer.invoke('writcraft:chat:reset', projectInstanceId),
    cancelPending: (projectInstanceId) => ipcRenderer.invoke('writcraft:chat:cancel-pending', projectInstanceId),
  }),

  // Project-scoped filesystem. Root paths are owned by the main process; each
  // method accepts only the minimum data needed for its operation.
  project: Object.freeze({
    create: (name) => ipcRenderer.invoke('writcraft:project:create', name),
    open: () => ipcRenderer.invoke('writcraft:project:open'),
    openRecent: () => ipcRenderer.invoke('writcraft:project:open-recent'),
    listTree: () => ipcRenderer.invoke('writcraft:project:list'),
    flushExternalChanges,
    readFile: (relPath) => ipcRenderer.invoke('writcraft:project:read', relPath),
    writeFile: (relPath, content, expectedRevision) => ipcRenderer.invoke('writcraft:project:write', relPath, content, expectedRevision),
    overwriteConflict: (relPath, content, observedRevision) => ipcRenderer.invoke('writcraft:project:overwrite-conflict', relPath, content, observedRevision),
    recreateDeleted: (relPath, content) => ipcRenderer.invoke('writcraft:project:recreate-deleted', relPath, content),
    createFile: (relPath) => ipcRenderer.invoke('writcraft:project:create-file', relPath),
    createProjectPrompt: () => ipcRenderer.invoke('writcraft:project:create-prompt'),
    renameFile: (sourcePath, targetPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:rename-file', sourcePath, targetPath, expectedRevision),
    moveFile: (sourcePath, targetPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:move-file', sourcePath, targetPath, expectedRevision),
    trashFile: (relPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:trash-file', relPath, expectedRevision),
    getMarkdownTrash: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:get-markdown-trash', projectInstanceId),
    restoreMarkdownTrash: (projectInstanceId, token) =>
      ipcRenderer.invoke('writcraft:project:restore-markdown-trash', projectInstanceId, token),
    confirmLegacyEdit: (token) => ipcRenderer.invoke('writcraft:project:confirm-legacy-edit', token),
    previewLegacyDraft: (content, requestedPath) => ipcRenderer.invoke('writcraft:project:preview-legacy-draft', content, requestedPath),
    confirmLegacyDraft: (token) => ipcRenderer.invoke('writcraft:project:confirm-legacy-draft', token),
    discardMigration: (token) => ipcRenderer.invoke('writcraft:project:discard-migration', token),
    search: (query) => ipcRenderer.invoke('writcraft:project:search', query),
    getContext: () => ipcRenderer.invoke('writcraft:project:get-context'),
    resolveContext: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:resolve-context', projectInstanceId, request),
    proposeChanges: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:propose-changes', projectInstanceId, request),
    proposeChapter: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:propose-chapter', projectInstanceId, request),
    proposeOnboarding: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:propose-onboarding', projectInstanceId, request),
    proposeEditPromptRepair: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:propose-edit-prompt-repair', projectInstanceId),
    proposeWritingNavigation: (projectInstanceId, request, attemptId) =>
      ipcRenderer.invoke(
        'writcraft:project:propose-writing-navigation',
        projectInstanceId,
        request,
        attemptId
      ),
    cancelWritingNavigation: (projectInstanceId, attemptId) =>
      ipcRenderer.invoke(
        'writcraft:project:cancel-writing-navigation',
        projectInstanceId,
        attemptId
      ),
    runWritingNavigationAction: (projectInstanceId, actionId, attemptId) =>
      ipcRenderer.invoke(
        'writcraft:project:run-writing-navigation-action',
        projectInstanceId,
        actionId,
        attemptId
      ),
    cancelWritingNavigationAction: (projectInstanceId, actionId, attemptId) =>
      ipcRenderer.invoke(
        'writcraft:project:cancel-writing-navigation-action',
        projectInstanceId,
        actionId,
        attemptId
      ),
    prepareWritingStructure: (projectInstanceId, navigationId, alternativeId, chapters) =>
      ipcRenderer.invoke(
        'writcraft:project:prepare-writing-structure',
        projectInstanceId,
        navigationId,
        alternativeId,
        chapters
      ),
    confirmWritingStructure: capabilityId =>
      ipcRenderer.invoke('writcraft:project:confirm-writing-structure', capabilityId),
    queryWritingStructureRecovery: projectInstanceId =>
      ipcRenderer.invoke('writcraft:project:query-writing-structure-recovery', projectInstanceId),
    acknowledgeWritingStructureRecovery: (projectInstanceId, operationId) =>
      ipcRenderer.invoke(
        'writcraft:project:ack-writing-structure-recovery',
        projectInstanceId,
        operationId
      ),
    handoffGraphIssue: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:handoff-graph-issue', projectInstanceId, request),
    confirmOnboardingFiles: (projectInstanceId, token, proposalDigest, selectedPaths) =>
      ipcRenderer.invoke('writcraft:project:confirm-onboarding-files', projectInstanceId, token, proposalDigest, selectedPaths),
    discardOnboardingConfirmation: (projectInstanceId, token) =>
      ipcRenderer.invoke('writcraft:project:discard-onboarding-confirmation', projectInstanceId, token),
    applyChanges: (projectInstanceId, decision) => ipcRenderer.invoke('writcraft:project:apply-changes', projectInstanceId, decision),
    discardChanges: (projectInstanceId, changeSetId) => ipcRenderer.invoke('writcraft:project:discard-changes', projectInstanceId, changeSetId),
    listChangeHistory: () => ipcRenderer.invoke('writcraft:project:list-change-history'),
    undoChange: (projectInstanceId, historyEntryId) =>
      ipcRenderer.invoke('writcraft:project:undo-change', projectInstanceId, historyEntryId),
    queryChangesHistoryRecovery: (projectInstanceId) =>
      ipcRenderer.invoke('writcraft:project:query-changes-history-recovery', projectInstanceId, {
        schema: 'writcraft.changes-history-recovery-query/v1',
      }),
    resolveChangesHistoryRecovery: (projectInstanceId, operationId, action) =>
      ipcRenderer.invoke('writcraft:project:resolve-changes-history-recovery', projectInstanceId, {
        schema: 'writcraft.changes-history-recovery-resolve/v1',
        operationId,
        action,
      }),
    clearChangesHistoryRecovery: (projectInstanceId, operationId) =>
      ipcRenderer.invoke('writcraft:project:clear-changes-history-recovery', projectInstanceId, {
        schema: 'writcraft.changes-history-recovery-clear/v1',
        operationId,
      }),
    buildGraph: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:build-graph', projectInstanceId),
    applyGraphCorrection: (projectInstanceId, command) => ipcRenderer.invoke('writcraft:project:apply-graph-correction', projectInstanceId, command),
    setIssueStatus: (projectInstanceId, issueId, status) => ipcRenderer.invoke('writcraft:project:set-issue-status', projectInstanceId, issueId, status),
    importReference: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:import-reference', projectInstanceId),
    buildSourceIndex: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:build-source-index', projectInstanceId),
    research: (projectInstanceId, question, sourceIds) => ipcRenderer.invoke('writcraft:project:research', projectInstanceId, question, sourceIds),
    resolveResearchCard: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:resolve-research-card', projectInstanceId, cardId),
    recordResearchJudgment: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:record-research-judgment', projectInstanceId, request),
    handoffResearchCard: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:handoff-research-card', projectInstanceId, request),
    ackResearchReview: (projectInstanceId, cardId, changeSetId) => ipcRenderer.invoke('writcraft:project:ack-research-review', projectInstanceId, cardId, changeSetId),
    cancelResearchHandoff: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:cancel-research-handoff', projectInstanceId, cardId),
    discardResearchCard: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:discard-research-card', projectInstanceId, cardId),
    generateImage: (projectInstanceId, operationId, prompt, aspectRatio) =>
      ipcRenderer.invoke('writcraft:project:generate-image', projectInstanceId, operationId, prompt, aspectRatio),
    settleImageReview: (projectInstanceId, review, insertionProof) =>
      ipcRenderer.invoke('writcraft:project:settle-image-review', projectInstanceId, review, insertionProof),
    getImageReviewAggregate: (projectInstanceId) =>
      ipcRenderer.invoke('writcraft:project:get-image-review-aggregate', projectInstanceId),
    getImageTrash: (projectInstanceId) =>
      ipcRenderer.invoke('writcraft:project:get-image-trash', projectInstanceId),
    restoreImageTrash: (projectInstanceId, token) =>
      ipcRenderer.invoke('writcraft:project:restore-image-trash', projectInstanceId, token),
    emptyImageTrash: (projectInstanceId, token) =>
      ipcRenderer.invoke('writcraft:project:empty-image-trash', projectInstanceId, token),
    recordAiMetric: (projectInstanceId, metric) => ipcRenderer.invoke('writcraft:project:record-ai-metric', projectInstanceId, metric),
    getAiMetricsAggregate: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:get-ai-metrics-aggregate', projectInstanceId),
    onExternalChange: (handler) => {
      if (typeof handler !== 'function') return () => {};
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('writcraft:project:external-change', listener);
      return () => ipcRenderer.removeListener('writcraft:project:external-change', listener);
    },
    loadWorkspace: () => ipcRenderer.invoke('writcraft:project:load-workspace'),
    saveWorkspace: (workspace) => ipcRenderer.invoke('writcraft:project:save-workspace', workspace),
    writeRecovery: (relPath, content, baseRevision) => ipcRenderer.invoke('writcraft:project:write-recovery', relPath, content, baseRevision),
    readRecovery: (relPath) => ipcRenderer.invoke('writcraft:project:read-recovery', relPath),
    listRecoveries: () => ipcRenderer.invoke('writcraft:project:list-recoveries'),
    clearRecovery: (relPath) => ipcRenderer.invoke('writcraft:project:clear-recovery', relPath),
  }),

  // 未来: image, RAG ...
  // - generateImage: (prompt) => ipcRenderer.invoke('writcraft:generate-image', prompt),
});
