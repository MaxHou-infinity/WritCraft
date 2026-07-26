// WritCraft V0 · preload.js
// Electron 安全的核心：contextIsolation: true 模式下的唯一桥梁
// 通过 contextBridge 暴露最小 API 给 renderer
//
// Day 3: 暴露 ⌘K 改写 + ⌘L 全局对话（IPC 路由到 main 进程 → MiniMax M3）

const { contextBridge, ipcRenderer } = require('electron');

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

  // 项目态 ⌘K：Renderer 只提供 revision + locator proof，Main 重建正文。
  rewrite: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:rewrite', projectInstanceId, request),
  ackRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:ack', projectInstanceId, payload),
  applyRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:apply', projectInstanceId, payload),
  discardRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:discard', projectInstanceId, payload),
  getRewriteReconciliation: (projectInstanceId, payload) =>
    ipcRenderer.invoke('writcraft:rewrite:reconciliation', projectInstanceId, payload),
  clearRewriteReconciliation: (projectInstanceId, payload) =>
    ipcRenderer.invoke('writcraft:rewrite:reconciliation-clear', projectInstanceId, payload),

  // Day 3: ⌘L 全局对话（userMessage + projectContext → M3 → 回答）
  chat: (projectInstanceId, userMessage, projectContext, contextRequest) => ipcRenderer.invoke('writcraft:chat', projectInstanceId, userMessage, projectContext, contextRequest),

  // Project-scoped filesystem. Root paths are owned by the main process; each
  // method accepts only the minimum data needed for its operation.
  project: Object.freeze({
    create: (name) => ipcRenderer.invoke('writcraft:project:create', name),
    open: () => ipcRenderer.invoke('writcraft:project:open'),
    openRecent: () => ipcRenderer.invoke('writcraft:project:open-recent'),
    listTree: () => ipcRenderer.invoke('writcraft:project:list'),
    readFile: (relPath) => ipcRenderer.invoke('writcraft:project:read', relPath),
    writeFile: (relPath, content, expectedRevision) => ipcRenderer.invoke('writcraft:project:write', relPath, content, expectedRevision),
    overwriteConflict: (relPath, content, observedRevision) => ipcRenderer.invoke('writcraft:project:overwrite-conflict', relPath, content, observedRevision),
    recreateDeleted: (relPath, content) => ipcRenderer.invoke('writcraft:project:recreate-deleted', relPath, content),
    createFile: (relPath) => ipcRenderer.invoke('writcraft:project:create-file', relPath),
    createProjectPrompt: () => ipcRenderer.invoke('writcraft:project:create-prompt'),
    renameFile: (sourcePath, targetPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:rename-file', sourcePath, targetPath, expectedRevision),
    moveFile: (sourcePath, targetPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:move-file', sourcePath, targetPath, expectedRevision),
    trashFile: (relPath, expectedRevision) => ipcRenderer.invoke('writcraft:project:trash-file', relPath, expectedRevision),
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
    proposePlan: (projectInstanceId, goal, contextPaths) => ipcRenderer.invoke('writcraft:project:propose-plan', projectInstanceId, goal, contextPaths),
    handoffPlanTask: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:handoff-plan-task', projectInstanceId, request),
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
    generateImage: (projectInstanceId, prompt, aspectRatio) => ipcRenderer.invoke('writcraft:project:generate-image', projectInstanceId, prompt, aspectRatio),
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
