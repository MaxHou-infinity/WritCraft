// WritCraft V0 · main.js
// Electron main process — 负责窗口创建、IPC 通信
// 严格遵循 v0 路线图 Day 1-2 任务
//
// API 协议修正（2026-07-15）：主人 Coding Plan Key 走 Anthropic 协议
// 端点: https://api.minimaxi.com/anthropic/v1/messages
// 模型: MiniMax-M3 / MiniMax-M2.7 / MiniMax-M2.7-highspeed

const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const fs = require('fs');
const projectService = require('./project-service');
const projectWatcher = require('./project-watcher');
const watcherInvalidationPolicy = require('./watcher-invalidation-policy');
const projectWatcherHealthService = require('./project-watcher-health');
const projectWatcherFlushHandlerService = require('./project-watcher-flush-handler');
const projectSearchService = require('./project-search-service');
const changeSetService = require('./changeset-service');
const changeSetReviewService = require('./changeset-review-service');
const pendingChangeSetStoreService = require('./pending-changeset-store');
const changeHistoryService = require('./change-history-service');
const changesHistoryReconciliationService = require('./changes-history-reconciliation-service');
const changesHistoryTransactionService = require('./changes-history-transaction');
const changesHistoryHandlerService = require('./changes-history-handler');
const chapterProposalService = require('./chapter-proposal-service');
const projectOnboardingV2Service = require('./project-onboarding-v2-service');
const onboardingCapabilityStoreService = require('./onboarding-capability-store');
const onboardingBatchService = require('./onboarding-batch-service');
const projectOnboardingHandler = require('./project-onboarding-handler');
const projectPlanService = require('./project-plan-service');
const projectPlanHandler = require('./project-plan-handler');
const projectPlanHandoffService = require('./project-plan-handoff-service');
const projectChangesProposalService = require('./project-changes-proposal-service');
const localizedEditService = require('./localized-edit-service');
const graphIndexService = require('./graph-index-service');
const graphCorrectionService = require('./graph-correction-service');
const graphIssueHandoffService = require('./graph-issue-handoff-service');
const issueStateService = require('./issue-state-service');
const sourceIndexService = require('./source-index-service');
const referenceImportService = require('./reference-import-service');
const apiKeyConfigService = require('./api-key-config-service');
const userDataService = require('./user-data-service');
const apiHandshakeService = require('./api-handshake-service');
const contextResolverService = require('./context-resolver-service');
const contextPolicyService = require('./context-policy-service');
const aiMetricsService = require('./ai-metrics-service');
const minimaxTextService = require('./minimax-text-service');
const researchService = require('./research-service');
const researchHandoffService = require('./research-handoff-service');
const researchJudgmentTransaction = require('./research-judgment-transaction');
const researchApplyTransactionService = require('./research-apply-transaction');
const refreshedResidualMetadata = researchApplyTransactionService.refreshedResidualMetadata;
const imageGenerationService = require('./image-generation-service');
const imageReviewServiceModule = require('./image-review-service');
const imageReviewHandlerModule = require('./image-review-handler');
const imageTrashServiceModule = require('./image-trash-service');
const imageTrashHandlerModule = require('./image-trash-handler');
const markdownTrashServiceModule = require('./markdown-trash-service');
const markdownTrashHandlerModule = require('./markdown-trash-handler');
const inlineRewriteContextService = require('./inline-rewrite-context-service');
const inlineRewriteService = require('./inline-rewrite-service');
const inlineRewriteCapabilityStoreService = require('./inline-rewrite-capability-store');
const inlineRewriteApplyServiceModule = require('./inline-rewrite-apply-service');
const inlineRewriteMutationGuardService = require('./inline-rewrite-mutation-guard');
const chatContextRequestService = require('./chat-context-request-service');
const chatConversationService = require('./chat-conversation-service');
const diagnosticExportService = require('./diagnostic-export-service');
const diagnosticExportHandlerService = require('./diagnostic-export-handler');

// Establish one identity-independent profile before Main reads userData. The
// deterministic GUI E2E keeps its explicitly supplied disposable profile;
// packaged builds can never activate that exception.
const isElectronAiFixture = !app.isPackaged && process.env.WRITCRAFT_E2E_AI_FIXTURE === '1';
const isElectronE2eUserData = !app.isPackaged && process.env.WRITCRAFT_E2E_USER_DATA === '1';
const isElectronWatcherFailureFixture = isElectronAiFixture &&
  process.env.WRITCRAFT_E2E_WATCHER_FAILURE === '1';
const e2eUserDataArgument = isElectronE2eUserData
  ? process.argv.find(argument => argument.startsWith('--user-data-dir='))
  : null;
const isNpmPreview = !app.isPackaged && process.env.WRITCRAFT_NPM_PREVIEW === '1';
const npmPreviewProfile = isNpmPreview &&
  typeof process.env.WRITCRAFT_NPM_PREVIEW_PROFILE === 'string'
  ? process.env.WRITCRAFT_NPM_PREVIEW_PROFILE
  : null;
userDataService.configureUserData(app, {
  isolatedTestDirectory: e2eUserDataArgument ? e2eUserDataArgument.slice('--user-data-dir='.length) : null,
  isolatedPreviewDirectory: npmPreviewProfile,
});

// A deterministic provider exists only for the real GUI E2E. Production and
// packaged builds cannot activate it, even if an environment variable is set.
const electronAiFixture = isElectronAiFixture
  ? require(path.join(__dirname, '..', '..', 'tests', 'fixtures', 'electron-ai-provider')).createElectronAiProvider()
  : null;

// MiniMax API 端点（Anthropic 协议）

let mainWindow = null;
let currentProject = null;
let currentProjectWatcher = null;
const projectWatcherHealth = projectWatcherHealthService.createProjectWatcherHealth();
const diagnosticRecorder = diagnosticExportService.createDiagnosticRecorder();
const diagnosticPreviewStore = diagnosticExportService.createDiagnosticPreviewStore();
const imageReviewService = imageReviewServiceModule.createImageReviewService();
const imageTrashService = imageTrashServiceModule.createImageTrashService();
const activeImageGenerations = new Set();
const imageReviewHandler = imageReviewHandlerModule.createImageReviewHandler({
  assertTrustedSender,
  getCurrentProject: () => currentProject,
  getMutationGeneration: () => projectMutationGeneration,
  getNavigationEpoch: () => rendererNavigationEpoch,
  projectService,
  reviewService: imageReviewService,
});
const imageTrashHandler = imageTrashHandlerModule.createImageTrashHandler({
  assertTrustedSender,
  getCurrentProject: () => currentProject,
  getMutationGeneration: () => projectMutationGeneration,
  getNavigationEpoch: () => rendererNavigationEpoch,
  trashService: imageTrashService,
});
const markdownTrashService = markdownTrashServiceModule.createMarkdownTrashService({ projectService });
const markdownTrashHandler = markdownTrashHandlerModule.createMarkdownTrashHandler({
  assertTrustedSender,
  getCurrentProject: () => currentProject,
  getMutationGeneration: () => projectMutationGeneration,
  getNavigationEpoch: () => rendererNavigationEpoch,
  settleListAuthority: settleMarkdownTrashListAuthority,
  trashService: markdownTrashService,
});
let projectMutationGeneration = 0;
let rendererNavigationEpoch = 0;
let internalMutationEpoch = 0;
let pendingChangeSets = null;
const researchHandoffStore = researchHandoffService.createResearchHandoffStore({
  revokeCapability(capability) {
    pendingChangeSets?.delete(capability, 'research-owner-revoked');
  },
});
pendingChangeSets = pendingChangeSetStoreService.createPendingChangeSetStore({
  maxEntries: 10,
  onRemove({ record, reason }) {
    const dependencies = record?.researchDependencies;
    if (!dependencies || !['expired', 'evicted', 'cleared'].includes(reason)) return;
    try {
      researchHandoffStore.discard({
        projectInstanceId: dependencies.projectInstanceId,
        rootPath: dependencies.rootPath,
        cardId: dependencies.cardId,
      });
    } catch (_) {}
  },
});
const pendingPlanRecords = projectPlanHandoffService.createPlanHandoffStore();
const pendingOnboardingReviews = new Map();
const onboardingCapabilityStore = onboardingCapabilityStoreService.createOnboardingCapabilityStore();
const onboardingAdmission = projectOnboardingHandler.createOnboardingAdmission({
  capabilityStore: onboardingCapabilityStore,
  pendingOnboardingReviews,
  pendingChangeSets,
});
const onboardingBatchCoordinator = onboardingBatchService.createOnboardingBatchService({
  capabilityStore: onboardingCapabilityStore,
  bindingValidator: validateOnboardingBatchBinding,
});
const changesHistoryTransaction = changesHistoryTransactionService.createChangesHistoryTransaction({
  projectService,
  historyService: changeHistoryService,
  reviewService: changeSetReviewService,
});
const inlineRewriteStore = inlineRewriteCapabilityStoreService.createInlineRewriteCapabilityStore();
const researchApplyTransaction = researchApplyTransactionService.createResearchApplyTransaction({
  changeSetReviewService,
  researchHandoffService,
  researchHandoffStore,
  pendingChangeSets,
  projectService,
  sourceIndex: rootPath => sourceIndexService.buildSourceIndex(rootPath),
  rememberApplied: rememberOwnFileMutation,
  invalidateDerivedState: changeSetId => invalidateProjectDerivedState({
    preserveResearchChangeSetId: changeSetId,
  }),
  executeDecision({
    project,
    pending,
    changeSetId,
    decision,
    decisionOptions,
    residualReviewId,
    onBegin,
  }) {
    return changesHistoryTransaction.review({
      rootPath: project.rootPath,
      projectId: project.projectId,
      changeSet: pending.changeSet,
      decision,
      options: {
        ...decisionOptions,
        residualReviewId,
        provenance: pending.provenance,
      },
      onBegin,
    });
  },
});
const inlineRewriteReconciliation = inlineRewriteService.createInlineRewriteReconciliationService();
const inlineRewriteApplyService = inlineRewriteApplyServiceModule.createInlineRewriteApplyService();
const inlineRewriteOnlyMutationGuard = inlineRewriteMutationGuardService.createInlineRewriteMutationGuard({
  readMarker: rootPath => inlineRewriteReconciliation.read(rootPath),
});
const inlineRewriteMutationGuard = inlineRewriteMutationGuardService.createInlineRewriteMutationGuard({
  readMarker: rootPath => inlineRewriteReconciliation.read(rootPath),
  readChangesMarker: rootPath => changesHistoryTransaction.reconciliation.readMarker(rootPath),
});
const changesHistoryOnlyMutationGuard = inlineRewriteMutationGuardService.createInlineRewriteMutationGuard({
  readMarker: () => null,
  readChangesMarker: rootPath => changesHistoryTransaction.reconciliation.readMarker(rootPath),
});
const pendingLegacyEditMigrations = new Map();
const pendingLegacyDraftImports = new Map();
const activeAiRequests = new Set();
const ownMarkdownWatcherStates = new Map();
const deferredWatcherPayloadsByRoot = new Map();
const internalMutationDepthByRoot = new Map();
const internalMutationLeaseByRoot = new Map();
const chatConversationStore = chatConversationService.createChatConversationStore();
let lastContextResponse = null;
const RENDERER_ENTRY = path.join(__dirname, '..', 'renderer', 'index.html');
const TRUSTED_RENDERER_URL = pathToFileURL(RENDERER_ENTRY).href;
const MAX_CHAT_MESSAGE_CHARS = 4000;
const MAX_CHAT_MESSAGE_BYTES = 16 * 1024;
const MAX_RENDERER_CONTEXT_BYTES = 64 * 1024;
const MAX_OWN_WATCHER_STATES = 1024;
const INLINE_REWRITE_ERROR_CODES = new Set([
  'INVALID_INLINE_REWRITE', 'INLINE_REWRITE_TOO_LARGE', 'INLINE_REWRITE_BUSY',
  'INLINE_REWRITE_NOT_FOUND', 'INLINE_REWRITE_ACK_TIMEOUT',
  'INLINE_REWRITE_NOT_ACKNOWLEDGED', 'INLINE_REWRITE_STALE',
  'INLINE_REWRITE_EXPIRED', 'INLINE_REWRITE_REPLAYED',
  'INLINE_REWRITE_PROTECTED_TARGET', 'MODEL_OUTPUT_TRUNCATED',
  'MODEL_OUTPUT_INCOMPLETE', 'INVALID_MODEL_OUTPUT',
  'INLINE_REWRITE_WRITE_FAILED', 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED',
  'PROJECT_WATCHER_UNAVAILABLE',
]);

function inlineRewriteFailure(error, fallbackMessage = 'Inline Rewrite 未完成，请重新选中后再试') {
  const safe = error instanceof inlineRewriteService.InlineRewriteError ||
    error instanceof inlineRewriteCapabilityStoreService.InlineRewriteCapabilityError ||
    error instanceof projectService.ProjectServiceError;
  const code = safe && INLINE_REWRITE_ERROR_CODES.has(error.code)
    ? error.code
    : 'INVALID_INLINE_REWRITE';
  const message = safe && typeof error.message === 'string' && error.message &&
      Buffer.byteLength(error.message, 'utf8') <= 1024
    ? error.message
    : fallbackMessage;
  return {
    ok: false,
    schema: 'writcraft.inline-rewrite-error/v1',
    error: {
      code,
      message,
      recoverable: code !== 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED' && error?.recoverable !== false,
    },
  };
}

function inlineRewriteProviderFailure(result) {
  const code = result?.stopReason === 'max_tokens'
    ? 'MODEL_OUTPUT_TRUNCATED'
    : result?.stopReason && result.stopReason !== 'end_turn'
      ? 'MODEL_OUTPUT_INCOMPLETE'
      : result?.error === 'NO_TEXT_BLOCK'
        ? 'INVALID_MODEL_OUTPUT'
        : result?.error === 'REQUEST_ABORTED'
          ? 'INLINE_REWRITE_NOT_FOUND'
          : 'INVALID_INLINE_REWRITE';
  const error = new inlineRewriteService.InlineRewriteError(
    code,
    result?.error === 'NO_KEY'
      ? '请先在设置中配置 MiniMax API Key'
      : result?.error === 'REQUEST_ABORTED'
        ? 'Inline Rewrite 已取消'
        : code === 'MODEL_OUTPUT_TRUNCATED'
          ? 'AI 改写输出被 token 上限截断'
          : code === 'MODEL_OUTPUT_INCOMPLETE'
            ? 'AI 改写输出未正常结束'
        : 'AI 改写服务暂时不可用，请稍后重试'
  );
  return inlineRewriteFailure(error);
}

function projectFailure(error) {
  // Unknown failures can contain provider output, absolute paths, or secrets.
  // Log only a stable diagnostic label; the renderer receives a bounded code.
  const diagnosticCode = error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : 'PROJECT_OPERATION_FAILED';
  diagnosticRecorder.record('project', diagnosticCode);
  console.error('[project]', diagnosticCode);
  const graphFailure = graphIndexService.publicGraphIndexFailure(error);
  if (graphFailure) return graphFailure;
  const isSafeProjectError = error instanceof projectService.ProjectServiceError ||
    error instanceof issueStateService.IssueStateError ||
    error instanceof changeHistoryService.ChangeHistoryError ||
    error instanceof chapterProposalService.ChapterProposalError ||
    error instanceof projectOnboardingV2Service.ProjectOnboardingV2Error ||
    error instanceof onboardingCapabilityStoreService.OnboardingCapabilityError ||
    error instanceof onboardingBatchService.OnboardingBatchError ||
    error instanceof projectPlanService.ProjectPlanError ||
    error instanceof projectPlanHandoffService.ProjectPlanHandoffError ||
    error instanceof projectChangesProposalService.ProjectChangesProposalError ||
    error instanceof localizedEditService.LocalizedEditError ||
    error instanceof changeSetService.ChangeSetError ||
    error instanceof changeSetReviewService.ChangeSetReviewError ||
    error instanceof pendingChangeSetStoreService.PendingChangeSetStoreError ||
    error instanceof graphCorrectionService.GraphCorrectionError ||
    error instanceof graphIssueHandoffService.GraphIssueHandoffError ||
    error instanceof contextResolverService.ContextResolverError ||
    error instanceof contextPolicyService.ContextPolicyError ||
    error instanceof aiMetricsService.AiMetricsError ||
    error instanceof researchService.ResearchError ||
    error instanceof researchHandoffService.ResearchHandoffError ||
    error instanceof imageGenerationService.ImageGenerationError ||
    error instanceof imageReviewServiceModule.ImageReviewError ||
    error instanceof imageTrashServiceModule.ImageTrashError ||
    error instanceof markdownTrashServiceModule.MarkdownTrashError ||
    error instanceof inlineRewriteContextService.InlineRewriteContextError ||
    error instanceof inlineRewriteMutationGuardService.InlineRewriteMutationGuardError ||
    error instanceof inlineRewriteMutationGuardService.ChangesHistoryMutationGuardError ||
    error instanceof changesHistoryHandlerService.ChangesHistoryHandlerError ||
    error instanceof changesHistoryReconciliationService.ChangesHistoryRecoveryError ||
    error instanceof referenceImportService.ReferenceImportError ||
    error instanceof diagnosticExportService.DiagnosticExportError;
  return {
    ok: false,
    error: isSafeProjectError && error.code ? error.code : 'PROJECT_OPERATION_FAILED',
    message: isSafeProjectError && error.message ? error.message : '文件系统操作失败，请检查权限或稍后重试',
  };
}

function requireCurrentProject() {
  if (!currentProject) {
    throw new projectService.ProjectServiceError('NO_PROJECT', '请先创建或打开一个写作项目');
  }
  return currentProject;
}

function assertInternalMutationAvailable(project, allowedLease = null) {
  const active = internalMutationLeaseByRoot.get(project.rootPath);
  if (active && active !== allowedLease) {
    throw new projectService.ProjectServiceError(
      'PROJECT_MUTATION_IN_PROGRESS',
      '项目文件正在提交，请稍后重试'
    );
  }
}

function assertInlineRewriteMutationAvailable(project, allowedLease = null) {
  if (!project || typeof project.rootPath !== 'string') {
    throw new projectService.ProjectServiceError('NO_PROJECT', '请先创建或打开一个写作项目');
  }
  assertInternalMutationAvailable(project, allowedLease);
  assertProjectWatcherAvailable(project);
  markdownTrashService.assertMutationAvailable(project);
  inlineRewriteMutationGuard.assertAvailable(project.rootPath);
  return project;
}

function assertChangesHistoryRecoveryAvailable(project) {
  if (!project || typeof project.rootPath !== 'string') {
    throw new projectService.ProjectServiceError('NO_PROJECT', '请先创建或打开一个写作项目');
  }
  assertInternalMutationAvailable(project);
  assertProjectWatcherAvailable(project);
  // Changes recovery must bypass its own marker while still refusing to race
  // an unresolved Inline Rewrite transaction.
  markdownTrashService.assertMutationAvailable(project);
  inlineRewriteOnlyMutationGuard.assertAvailable(project.rootPath);
  return project;
}

function assertProjectWatcherAvailable(project) {
  return projectWatcherHealth.assertAvailable(project, () => new projectService.ProjectServiceError(
      'PROJECT_WATCHER_UNAVAILABLE',
      '项目文件监控不可用；请重新打开项目后再继续 AI 或文件修改'
  ));
}

async function settleMarkdownTrashListAuthority(project) {
  assertProjectWatcherAvailable(project);
  const watcher = currentProjectWatcher;
  const navigationEpoch = rendererNavigationEpoch;
  const mutationEpoch = internalMutationEpoch;
  if (!watcher || typeof watcher.flush !== 'function') {
    throw new projectService.ProjectServiceError(
      'PROJECT_WATCHER_UNAVAILABLE',
      '项目文件监控不可用；请重新打开项目'
    );
  }
  if ((internalMutationDepthByRoot.get(project.rootPath) || 0) > 0) {
    throw new projectService.ProjectServiceError(
      'PROJECT_MUTATION_IN_PROGRESS',
      '项目文件正在提交，请稍后刷新回收区'
    );
  }
  let flushed;
  try {
    flushed = await watcher.flush();
  } catch (_) {
    projectWatcherHealth.markDegraded(project);
    throw new projectService.ProjectServiceError(
      'PROJECT_WATCHER_UNAVAILABLE',
      '项目文件监控无法完成一致性扫描；请重新打开项目'
    );
  }
  if (!currentProject || currentProject.instanceId !== project.instanceId ||
      currentProject.rootPath !== project.rootPath ||
      currentProjectWatcher !== watcher ||
      rendererNavigationEpoch !== navigationEpoch) {
    throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目状态已变化，请重新刷新回收区');
  }
  if (!flushed?.ok || internalMutationEpoch !== mutationEpoch ||
      (internalMutationDepthByRoot.get(project.rootPath) || 0) > 0) {
    throw new projectService.ProjectServiceError(
      'PROJECT_MUTATION_IN_PROGRESS',
      '项目文件状态尚未收敛，请稍后刷新回收区'
    );
  }
  assertProjectWatcherAvailable(project);
}

function requireMutableProject() {
  return assertInlineRewriteMutationAvailable(requireCurrentProject());
}

function publicProject(project) {
  return { name: project.name, projectId: project.projectId, instanceId: project.instanceId };
}

function attachPrivateProjectRootIdentity(project) {
  if (!project || typeof project.rootPath !== 'string') {
    throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目根目录身份无效');
  }
  const directoryFlags = fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY || 0) |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);
  let descriptor = null;
  try {
    descriptor = fs.openSync(project.rootPath, directoryFlags);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目根目录身份已经变化');
    }
    Object.defineProperty(project, 'rootIdentity', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode }),
    });
    return project;
  } catch (error) {
    if (error instanceof projectService.ProjectServiceError) throw error;
    throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目根目录无法建立可信身份');
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
  }
}

function abortActiveAiRequests() {
  for (const request of activeAiRequests) request.controller.abort();
  activeAiRequests.clear();
}

function advanceRendererNavigationEpoch() {
  abortActiveAiRequests();
  rendererNavigationEpoch += 1;
  if (currentProject) onboardingAdmission.invalidateProject(currentProject);
}

function invalidatePendingOnboardingReviews(preserveChangeSetId = null) {
  for (const [changeSetId, record] of pendingOnboardingReviews) {
    if (changeSetId === preserveChangeSetId) continue;
    onboardingCapabilityStore.invalidate(record.reviewId);
    pendingOnboardingReviews.delete(changeSetId);
    pendingChangeSets.delete(changeSetId);
  }
}

function validateOnboardingBatchBinding(binding) {
  if (!currentProject || currentProject.instanceId !== binding.projectInstanceId ||
      currentProject.rootPath !== binding.rootPath ||
      projectMutationGeneration !== binding.mutationGeneration) return false;
  try {
    const edit = projectService.readFileWithRevision(currentProject.rootPath, projectService.EDIT_FILE);
    return edit.revision === binding.editRevision;
  } catch (_) {
    return false;
  }
}

function finalizeOnboardingBatchCommit(result, operations) {
  const warningCodes = new Set();
  const warn = code => {
    warningCodes.add(code);
    try { operations.log?.(code); } catch (_) {}
  };
  for (const file of result.files) {
    try { operations.remember(file); }
    catch (_) { warn('WATCHER_STATE_REFRESH_FAILED'); }
  }
  if (result.files.length) {
    try { operations.invalidate(); }
    catch (_) { warn('DERIVED_STATE_REFRESH_FAILED'); }
  }
  try { operations.endMutation(); }
  catch (_) { warn('MUTATION_LEASE_RELEASE_FAILED'); }

  let tree;
  try { tree = operations.listTree(); }
  catch (_) { warn('TREE_REFRESH_FAILED'); }
  const warnings = [...warningCodes];
  return {
    ok: true,
    files: result.files,
    ...(tree ? { tree } : {}),
    ...(warnings.length ? {
      warning: 'ONBOARDING_POST_COMMIT_REFRESH_REQUIRED',
      warningCodes: warnings,
      refreshRequired: true,
      ...(warningCodes.has('TREE_REFRESH_FAILED') ? { treeRefreshRequired: true } : {}),
    } : {}),
  };
}

function advanceAiContextGeneration(options = {}) {
  abortActiveAiRequests();
  const ownerId = currentChatConversationOwnerId();
  if (ownerId) chatConversationStore.invalidateOwner(ownerId, 'context_changed');
  projectMutationGeneration += 1;
  lastContextResponse = null;
  pendingPlanRecords.clear();
  invalidatePendingOnboardingReviews(options.preserveOnboardingChangeSetId || null);
}

function rememberOwnMarkdownState(relPath, revision) {
  if (typeof relPath !== 'string' || !/\.(?:md|markdown)$/i.test(relPath)) return;
  function remember(watchPath, state) {
    ownMarkdownWatcherStates.delete(watchPath);
    ownMarkdownWatcherStates.set(watchPath, state);
    while (ownMarkdownWatcherStates.size > MAX_OWN_WATCHER_STATES) {
      ownMarkdownWatcherStates.delete(ownMarkdownWatcherStates.keys().next().value);
    }
  }
  remember(relPath, {
    kind: 'markdown',
    revision: typeof revision === 'string' ? revision : null,
  });
  const parts = relPath.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    remember(parts.slice(0, index).join('/'), {
      kind: 'directory',
      revision: null,
    });
  }
}

function rememberOwnFileMutation(file) {
  if (!file || typeof file !== 'object') return;
  rememberOwnMarkdownState(file.path, file.revision);
  if (typeof file.fromPath === 'string' && file.fromPath !== file.path) {
    rememberOwnMarkdownState(file.fromPath, null);
  }
}

function markdownStateMatchesOwnCommit(project, change) {
  const expected = ownMarkdownWatcherStates.get(change.path);
  if (!expected) return false;
  try {
    if (expected.kind === 'directory') {
      const absolute = path.join(project.rootPath, ...change.path.split('/'));
      const matches = fs.lstatSync(absolute).isDirectory();
      if (!matches) ownMarkdownWatcherStates.delete(change.path);
      return matches;
    }
    const current = projectService.readFileWithRevision(project.rootPath, change.path);
    const matches = expected.revision !== null && current.revision === expected.revision;
    if (!matches) ownMarkdownWatcherStates.delete(change.path);
    return matches;
  } catch (error) {
    const matches = expected.revision === null && error && error.code === 'NOT_FOUND';
    if (!matches) ownMarkdownWatcherStates.delete(change.path);
    return matches;
  }
}

function namedWatcherChangeAffectsAiContext(project, change) {
  if (markdownStateMatchesOwnCommit(project, change)) return false;
  if (/\.(?:md|markdown)$/i.test(change.path)) {
    // Record the authoritative state after the first external invalidation,
    // so native fs.watch and the later polling pass cannot publish the same
    // revision as two independent mutations.
    try {
      const current = projectService.readFileWithRevision(project.rootPath, change.path);
      rememberOwnMarkdownState(change.path, current.revision);
    } catch (error) {
      if (error && error.code === 'NOT_FOUND') rememberOwnMarkdownState(change.path, null);
    }
    return true;
  }
  // Generated/imported binary assets do not enter text context. Directory
  // changes can alter the public Markdown tree and remain conservative.
  try {
    const absolute = path.join(project.rootPath, ...String(change.path).split('/'));
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory()) {
      if (change.kind === 'renamed') return true;
      // Directory metadata changes accompany atomic child writes in polling
      // snapshots. Child file diffs carry the actual context semantics.
      return false;
    }
    if (change.kind === 'renamed' && !path.posix.extname(change.path)) return true;
  } catch (_) {
    return true;
  }
  return false;
}

function watcherChangeAffectsAiContext(project, payload) {
  return watcherInvalidationPolicy.watcherPayloadAffectsAiContext(payload, {
    namedChangeAffectsContext: change => namedWatcherChangeAffectsAiContext(project, change),
  });
}

function publishWatcherPayload(project, payload) {
  if (!currentProject || currentProject.rootPath !== project.rootPath) return;
  const aiContextChanged = watcherChangeAffectsAiContext(project, payload);
  if (aiContextChanged) advanceAiContextGeneration();
  // Renderer already received the authoritative result of a Main commit.
  // Replaying its filesystem echo would refresh/replace tree controls and can
  // race a user's immediate next click without adding any new information.
  if (!aiContextChanged) return;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('writcraft:project:external-change', {
    ...payload,
    projectInstanceId: project.instanceId,
    aiContextChanged,
  });
}

function publicContextFingerprint(project) {
  const records = [];
  const visit = nodes => {
    for (const node of nodes) {
      if (node.type === 'directory') {
        records.push(`d\0${node.path}`);
        visit(node.children || []);
      } else if (node.type === 'file' && /\.(?:md|markdown)$/i.test(node.path)) {
        const snapshot = projectService.readFileWithRevision(project.rootPath, node.path);
        records.push(`m\0${node.path}\0${snapshot.revision}`);
      } else if (node.type === 'symlink' && /\.(?:md|markdown)$/i.test(node.path)) {
        records.push(`s\0${node.path}`);
      }
    }
  };
  visit(projectService.listTree(project.rootPath));
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

function beginInternalMutation(project) {
  const token = Object.freeze({ rootPath: project.rootPath, instanceId: project.instanceId, id: crypto.randomUUID() });
  if (internalMutationLeaseByRoot.has(token.rootPath)) {
    throw new projectService.ProjectServiceError(
      'PROJECT_MUTATION_IN_PROGRESS',
      '项目文件正在提交，请稍后重试'
    );
  }
  internalMutationEpoch += 1;
  internalMutationLeaseByRoot.set(token.rootPath, token);
  internalMutationDepthByRoot.set(token.rootPath, 1);
  return token;
}

function endInternalMutation(token, project) {
  if (!token || token.rootPath !== project.rootPath) return;
  const active = internalMutationLeaseByRoot.get(token.rootPath);
  if (active !== token) return;
  internalMutationLeaseByRoot.delete(token.rootPath);
  internalMutationDepthByRoot.delete(token.rootPath);
  const pending = deferredWatcherPayloadsByRoot.get(token.rootPath) || [];
  deferredWatcherPayloadsByRoot.delete(token.rootPath);
  for (const item of pending) {
    // Deferral avoids publishing half-written state, but does not prove an
    // event came from Main. Filename-less payloads therefore remain fail-closed.
    publishWatcherPayload(project, item);
  }
}

async function runAiRequest(projectInstanceId, task, externalSignal = null) {
  if (currentProject && projectInstanceId === currentProject.instanceId) {
    assertProjectWatcherAvailable(currentProject);
  }
  const request = { projectInstanceId, controller: new AbortController() };
  const relayAbort = () => request.controller.abort();
  if (externalSignal?.aborted) request.controller.abort();
  else externalSignal?.addEventListener?.('abort', relayAbort, { once: true });
  activeAiRequests.add(request);
  try {
    return await task(request.controller.signal);
  } finally {
    externalSignal?.removeEventListener?.('abort', relayAbort);
    activeAiRequests.delete(request);
  }
}

function researchRendererOwner(event) {
  return {
    ownerId: `webcontents:${event.sender.id}`,
    navigationEpoch: rendererNavigationEpoch,
  };
}

function inlineRewriteBinding(event, project = requireCurrentProject()) {
  return {
    projectInstanceId: project.instanceId,
    rootPath: project.rootPath,
    ownerId: `browserwindow:${mainWindow.id}`,
    navigationEpoch: rendererNavigationEpoch,
  };
}

function projectCallLLM(projectInstanceId) {
  return (messages, model, maxTokens) => runAiRequest(
    projectInstanceId,
    signal => callLLM(messages, model, maxTokens, signal)
  );
}

function startProjectWatcher(project) {
  try {
    // A real-Main/IPC regression harness uses this unpackaged, double-gated
    // fixture; packaged builds and Renderer cannot activate it.
    if (isElectronWatcherFailureFixture) throw new Error('E2E persistent watcher failure');
    const watcher = projectWatcher.createProjectWatcher(project.rootPath, payload => {
      if (!currentProject || currentProject.rootPath !== project.rootPath ||
          currentProject.instanceId !== project.instanceId) return;
      if ((internalMutationDepthByRoot.get(project.rootPath) || 0) > 0) {
        const deferred = deferredWatcherPayloadsByRoot.get(project.rootPath) || [];
        deferred.push(payload);
        deferredWatcherPayloadsByRoot.set(project.rootPath, deferred);
        return;
      }
      publishWatcherPayload(project, payload);
    });
    currentProjectWatcher = watcher;
    projectWatcherHealth.clear(project);
    return watcher;
  } catch (error) {
    projectWatcherHealth.markDegraded(project);
    throw error;
  }
}

function restartProjectWatcher(project) {
  if (!currentProject || currentProject.rootPath !== project.rootPath ||
      currentProject.instanceId !== project.instanceId) {
    throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，无法恢复文件监控');
  }
  if (currentProjectWatcher) currentProjectWatcher.close();
  currentProjectWatcher = null;
  try { return startProjectWatcher(project); }
  catch (_) {
    projectWatcherHealth.markDegraded(project);
    throw new projectService.ProjectServiceError(
      'PROJECT_WATCHER_UNAVAILABLE',
      '项目文件监控恢复失败；请重新打开项目'
    );
  }
}

function setCurrentProject(project) {
  const changedProject = !currentProject || currentProject.rootPath !== project.rootPath ||
    currentProject.instanceId !== project.instanceId;
  const recoverSameProjectWatcher = !changedProject &&
    projectWatcherHealth.needsRecovery(project, Boolean(currentProjectWatcher));
  if (changedProject) {
    abortActiveAiRequests();
    const chatOwnerId = currentChatConversationOwnerId();
    if (chatOwnerId) chatConversationStore.invalidateOwner(chatOwnerId, 'project_changed');
    if (mainWindow && !mainWindow.isDestroyed()) {
      inlineRewriteStore.clearOwner(`browserwindow:${mainWindow.id}`);
    }
    if (currentProject) {
      onboardingCapabilityStore.invalidateByProject(currentProject.instanceId, currentProject.rootPath);
      researchHandoffStore.clearProject(currentProject.instanceId, currentProject.rootPath);
    }
    pendingChangeSets.clear();
    pendingPlanRecords.clear();
    invalidatePendingOnboardingReviews();
    ownMarkdownWatcherStates.clear();
    lastContextResponse = null;
    if (currentProjectWatcher) currentProjectWatcher.close();
    currentProjectWatcher = null;
    projectWatcherHealth.reset();
  }
  currentProject = project;
  if (changedProject) projectMutationGeneration += 1;
  if (changedProject) {
    try {
      startProjectWatcher(project);
    } catch (error) {
      // A watcher failure keeps read-only access available, but the degraded
      // gate blocks AI and every mutable path until the project is reopened.
      diagnosticRecorder.record('project', 'PROJECT_WATCHER_START_FAILED');
      console.error('[project:watcher]', 'PROJECT_WATCHER_START_FAILED');
    }
  } else if (recoverSameProjectWatcher) {
    // instanceId is a stable canonical-root hash. Reopening the same root is
    // therefore not a project change, but it is an explicit recovery action.
    // A successful restart clears the exact degraded binding; failure keeps it.
    try {
      restartProjectWatcher(project);
    } catch (error) {
      diagnosticRecorder.record('project', 'PROJECT_WATCHER_RESTART_FAILED');
      console.error('[project:watcher:reopen]', 'PROJECT_WATCHER_RESTART_FAILED');
    }
  }
}

function invalidateProjectDerivedState(options = {}) {
  const preserveChangeSetId = options.preserveOnboardingChangeSetId || null;
  const preserveResearchChangeSetId = options.preserveResearchChangeSetId || null;
  const preservedOnboarding = preserveChangeSetId
    ? pendingOnboardingReviews.get(preserveChangeSetId)
    : null;
  advanceAiContextGeneration({ preserveOnboardingChangeSetId: preserveChangeSetId });
  if (preserveResearchChangeSetId) pendingChangeSets.clearExcept(preserveResearchChangeSetId);
  else pendingChangeSets.clear();
  invalidatePendingOnboardingReviews(preserveChangeSetId);
  if (preservedOnboarding) pendingOnboardingReviews.set(preserveChangeSetId, preservedOnboarding);
}

function validateOrdinaryChangesDependencies({ project, pending }) {
  if (pending.planDependencies) {
    projectPlanHandoffService.validatePlanDependencies({
      projectService,
      rootPath: project.rootPath,
      dependencies: pending.planDependencies,
    });
  }
  if (pending.projectDependencies) {
    projectChangesProposalService.validateProjectDependencies({
      projectService,
      rootPath: project.rootPath,
      dependencies: pending.projectDependencies,
    });
  }
  if (pending.issueDependencies) {
    const indexed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const issueState = issueStateService.reconcileIssueStates(project.rootPath, indexed.graph.issues);
    graphIssueHandoffService.validateIssueDependencies({
      graph: { ...indexed.graph, issues: issueState.issues },
      projectService,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      dependencies: pending.issueDependencies,
    });
  }
}

function terminateOrdinaryChangesAuthority({ changeSetId }) {
  try { pendingChangeSets.delete(changeSetId, 'changes-history-terminal'); } catch (_) {}
  try { invalidateOnboardingReview(changeSetId); } catch (_) {}
}

function finalizeOrdinaryChanges({
  project,
  pending,
  changeSetId,
  residualCapability,
  result,
}) {
  const onboardingReview = pendingOnboardingReviews.get(changeSetId) || null;
  const { residualChangeSet, ...publicResult } = result;
  const applied = result.applied || [];
  const onboardingFullyApplied = Boolean(onboardingReview) && !residualChangeSet &&
    applied.length === 1 && applied[0].path === projectService.EDIT_FILE &&
    applied[0].revision === onboardingReview.expectedAppliedRevision;

  if (applied.length) {
    applied.forEach(rememberOwnFileMutation);
    invalidateProjectDerivedState({
      preserveOnboardingChangeSetId: onboardingFullyApplied ? changeSetId : null,
    });
  } else if (onboardingReview) {
    invalidateOnboardingReview(changeSetId, onboardingReview);
  }

  const residualMetadata = refreshedResidualMetadata(
    pending,
    applied,
    residualChangeSet,
    residualChangeSet ? residualCapability : null
  );
  if (residualChangeSet) {
    pendingChangeSets.putWithCapability(
      residualCapability,
      residualChangeSet,
      project.rootPath,
      residualMetadata
    );
  }

  let onboardingTransition = {};
  if (onboardingReview) {
    if (onboardingFullyApplied) {
      try {
        const committedEdit = projectService.readFileWithRevision(
          project.rootPath,
          projectService.EDIT_FILE
        );
        const token = onboardingCapabilityStore.completeReview(onboardingReview.reviewId, {
          projectInstanceId: project.instanceId,
          rootPath: project.rootPath,
          mutationGeneration: projectMutationGeneration,
          changeSetId,
          editRevision: committedEdit.revision,
          proposalDigest: onboardingReview.proposalDigest,
          appliedPaths: [projectService.EDIT_FILE],
          residual: false,
        });
        onboardingTransition = {
          onboardingConfirmation: publicOnboardingConfirmation(token, onboardingReview, 'review'),
        };
      } catch (error) {
        onboardingTransition = {
          confirmationUnavailable: {
            error: 'ONBOARDING_CONFIRMATION_UNAVAILABLE',
            reason: error?.code || 'CAPABILITY_TRANSITION_FAILED',
          },
        };
      } finally {
        invalidateOnboardingReview(changeSetId, onboardingReview);
      }
    } else {
      invalidateOnboardingReview(changeSetId, onboardingReview);
    }
  }

  let treeResult = {};
  if (applied.length) {
    try { treeResult = { tree: projectService.listTree(project.rootPath) }; }
    catch (error) {
      treeResult = {
        treeRefreshRequired: true,
        treeError: error?.code || 'TREE_REFRESH_FAILED',
      };
    }
  }
  return {
    ...publicResult,
    changeSetId: result.review?.changeSetId || null,
    ...(residualChangeSet && residualMetadata.provenance
      ? { provenance: residualMetadata.provenance }
      : {}),
    ...onboardingTransition,
    ...treeResult,
  };
}

function finalizeChangesUndo({ project, result }) {
  const applied = result.applied || [];
  applied.forEach(rememberOwnFileMutation);
  if (applied.length) invalidateProjectDerivedState();
  try {
    return {
      ...result,
      tree: applied.length ? projectService.listTree(project.rootPath) : undefined,
    };
  } catch (error) {
    return {
      ...result,
      treeRefreshRequired: true,
      treeError: error?.code || 'TREE_REFRESH_FAILED',
    };
  }
}

const changesHistoryHandler = changesHistoryHandlerService.createChangesHistoryHandler({
  transaction: changesHistoryTransaction,
  pendingChangeSets,
  getCurrentProject: () => currentProject,
  assertMutationAvailable: assertInlineRewriteMutationAvailable,
  assertRecoveryAvailable: assertChangesHistoryRecoveryAvailable,
  validateDependencies: validateOrdinaryChangesDependencies,
  finalizeApply: finalizeOrdinaryChanges,
  finalizeUndo: finalizeChangesUndo,
  abortHiddenAuthority: terminateOrdinaryChangesAuthority,
  onRecoveryResolved() {
    invalidateProjectDerivedState();
  },
});

function lifecycleSuccess(project, file, publicFile = file) {
  rememberOwnFileMutation(file);
  invalidateProjectDerivedState();
  try {
    return { ok: true, file: publicFile, tree: projectService.listTree(project.rootPath) };
  } catch (error) {
    // The file operation is already committed. Never report it as failed and
    // tempt the renderer to repeat it merely because a later tree refresh hit
    // an unrelated limit or external filesystem change.
    return {
      ok: true,
      file: publicFile,
      treeRefreshRequired: true,
      treeError: error && error.code ? error.code : 'TREE_REFRESH_FAILED',
    };
  }
}

function rememberRecentProject(project) {
  try {
    projectService.saveRecentProject(app.getPath('userData'), project.rootPath);
  } catch (error) {
    // A failure to remember UI convenience state must not make a successfully
    // opened writing project appear to have failed.
    diagnosticRecorder.record('project', 'RECENT_PROJECT_SAVE_FAILED');
    console.error('[project:recent]', 'RECENT_PROJECT_SAVE_FAILED');
  }
}

function assertTrustedSender(event) {
  const senderUrl = event && event.senderFrame ? event.senderFrame.url : '';
  if (!mainWindow || !event || event.sender !== mainWindow.webContents || senderUrl !== TRUSTED_RENDERER_URL) {
    const error = new Error('拒绝来自非主编辑器窗口的项目文件操作');
    error.code = 'UNTRUSTED_SENDER';
    throw error;
  }
}

function chatConversationOwnerId(event) {
  return event?.sender && Number.isSafeInteger(event.sender.id)
    ? `webcontents:${event.sender.id}`
    : null;
}

function currentChatConversationOwnerId() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents ||
      !Number.isSafeInteger(mainWindow.webContents.id)) return null;
  return `webcontents:${mainWindow.webContents.id}`;
}

function chatConversationBinding(event, project = requireCurrentProject()) {
  const ownerId = chatConversationOwnerId(event);
  if (!ownerId) {
    throw new chatConversationService.ChatConversationError(
      'INVALID_CHAT_CONVERSATION_BINDING',
      'Chat 会话来源无效'
    );
  }
  return {
    ownerId,
    navigationEpoch: rendererNavigationEpoch,
    projectInstanceId: project.instanceId,
    rootPath: project.rootPath,
    contextGeneration: projectMutationGeneration,
  };
}

function chatConversationFailure(error) {
  const code = error instanceof chatConversationService.ChatConversationError
    ? error.code
    : 'CHAT_CONVERSATION_FAILED';
  return {
    ok: false,
    error: code,
    message: code === 'CHAT_CONVERSATION_STALE'
      ? '对话会话已由更新请求取代，请继续使用最新回复'
      : '最近对话摘要不可用，请新建对话后重试',
  };
}

function matchesAiProjectOrigin(projectInstanceId) {
  if (!currentProject) return projectInstanceId === null;
  return typeof projectInstanceId === 'string' && projectInstanceId === currentProject.instanceId;
}

function staleAiProjectResult() {
  return { ok: false, error: 'PROJECT_CHANGED', message: '项目状态已变化，请重新发起 AI 请求' };
}

function captureAiProjectOrigin() {
  return currentProject
    ? { instanceId: currentProject.instanceId, rootPath: currentProject.rootPath, mutationGeneration: projectMutationGeneration }
    : { instanceId: null, rootPath: null, mutationGeneration: projectMutationGeneration };
}

function isAiProjectOriginCurrent(origin) {
  if (!origin || projectMutationGeneration !== origin.mutationGeneration) return false;
  if (!origin.instanceId) return currentProject === null;
  return Boolean(currentProject && currentProject.instanceId === origin.instanceId && currentProject.rootPath === origin.rootPath);
}

function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function validateRendererContext(projectContext, contextRequest) {
  if (typeof projectContext !== 'string' || utf8Bytes(projectContext) > MAX_RENDERER_CONTEXT_BYTES) {
    return { ok: false, error: 'CONTEXT_TOO_LARGE', message: '编辑器上下文不能超过 64 KiB' };
  }
  if (contextRequest === null || contextRequest === undefined) return { ok: true };
  return chatContextRequestService.validate(contextRequest);
}

function createWindow() {
  let npmPreviewReady = false;
  const sendNpmPreviewStatus = status => {
    if (!isNpmPreview || typeof process.send !== 'function' || !process.connected) return;
    try {
      process.send({
        schema: 'writcraft.npm-preview-renderer/v1',
        status,
      });
    } catch (_) {}
  };
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: '笔触 · WritCraft',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const rendererOwnerId = `webcontents:${mainWindow.webContents.id}`;
  const inlineRewriteOwnerId = `browserwindow:${mainWindow.id}`;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    researchHandoffStore.clearOwner(rendererOwnerId, rendererNavigationEpoch);
    inlineRewriteStore.clearOwner(inlineRewriteOwnerId, rendererNavigationEpoch);
    chatConversationStore.invalidateOwner(rendererOwnerId, 'chat_reopened');
    advanceRendererNavigationEpoch();
  });
  mainWindow.webContents.on('render-process-gone', () => {
    researchHandoffStore.clearOwner(rendererOwnerId);
    inlineRewriteStore.clearOwner(inlineRewriteOwnerId);
    chatConversationStore.invalidateOwner(rendererOwnerId, 'chat_reopened');
    advanceRendererNavigationEpoch();
    if (isNpmPreview && !npmPreviewReady) {
      sendNpmPreviewStatus('failed');
      app.exit(1);
    }
  });
  mainWindow.webContents.on('destroyed', () => {
    researchHandoffStore.clearOwner(rendererOwnerId);
    inlineRewriteStore.clearOwner(inlineRewriteOwnerId);
    chatConversationStore.invalidateOwner(rendererOwnerId, 'chat_reopened');
    advanceRendererNavigationEpoch();
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== TRUSTED_RENDERER_URL) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', event => event.preventDefault());

  // Renderer is a local, offline document surface. Deny every browser-level
  // permission and every HTTP(S)/WebSocket request at the session boundary; Main-owned
  // MiniMax calls use Node fetch and are unaffected by this Chromium policy.
  const rendererSession = mainWindow.webContents.session;
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  rendererSession.setDevicePermissionHandler(() => false);
  rendererSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  );

  mainWindow.loadFile(RENDERER_ENTRY);
  mainWindow.webContents.once('did-finish-load', () => {
    npmPreviewReady = true;
    sendNpmPreviewStatus('ready');
  });

  // 仅开发命令自动打开 DevTools，正常启动保持写作心流
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Renderer messages may contain manuscript text, prompts, source URLs or
  // paths. Keep only a stable level code in process logs and diagnostics.
  mainWindow.webContents.on('console-message', (_event, level) => {
    const lvl = ['LOG', 'WARN', 'ERROR', 'INFO'][level] || 'LOG';
    const code = `RENDERER_CONSOLE_${lvl}`;
    diagnosticRecorder.record('renderer', code);
    console.log('[renderer]', code);
  });

  // The raw Chromium description and URL are deliberately not logged.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    diagnosticRecorder.record('window', 'RENDERER_LOAD_FAILED');
    console.error('[renderer]', 'RENDERER_LOAD_FAILED');
    if (isElectronAiFixture) {
      console.error('[renderer-e2e]', `RENDERER_LOAD_FAILED_${errorCode}_${isMainFrame ? 'MAIN' : 'SUB'}`);
    }
    if (isNpmPreview && !npmPreviewReady) {
      sendNpmPreviewStatus('failed');
      app.exit(1);
    }
  });
}

function summarizeDiagnosticTree(nodes) {
  const stack = Array.isArray(nodes) ? [...nodes] : [];
  let fileCount = 0;
  let markdownFileCount = 0;
  let visited = 0;
  while (stack.length && visited < 10000) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'directory' && Array.isArray(node.children)) {
      stack.push(...node.children);
    } else if (node.type === 'file') {
      fileCount += 1;
      if (typeof node.path === 'string' && /\.(?:md|markdown)$/i.test(node.path)) {
        markdownFileCount += 1;
      }
    }
  }
  return { fileCount, markdownFileCount };
}

function diagnosticMetricsSummary(aggregate) {
  const evidence = aggregate?.authorEvidence || {};
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    sampleSize: count(aggregate?.sampleSize),
    smallSample: aggregate?.smallSample !== false,
    inlineDecisions: count(evidence.inline?.decisionSampleSize),
    planAttempts: count(evidence.planRun?.attempts),
    researchJudgments: count(evidence.researchAccuracy?.sampleSize),
    imageAttempts: count(evidence.image?.attempts),
    onboardingAttempts: count(evidence.onboarding?.attempts),
  };
}

function createDiagnosticBundleInput() {
  const project = {
    open: Boolean(currentProject),
    fileCount: 0,
    markdownFileCount: 0,
    promptStatus: currentProject ? 'unavailable' : 'not_open',
    promptDiagnosticCodes: [],
    watcherStatus: currentProject
      ? projectWatcherHealth.isDegraded(currentProject)
        ? 'degraded'
        : currentProjectWatcher
          ? 'healthy'
          : 'unavailable'
      : 'not_open',
    metrics: diagnosticMetricsSummary(null),
  };
  if (currentProject) {
    try {
      Object.assign(project, summarizeDiagnosticTree(projectService.listTree(currentProject.rootPath)));
    } catch (_) {
      diagnosticRecorder.record('diagnostic', 'DIAGNOSTIC_TREE_UNAVAILABLE');
    }
    try {
      const edit = projectService.readFileWithRevision(currentProject.rootPath, projectService.EDIT_FILE);
      project.promptStatus = edit.frontMatter?.status || 'unavailable';
      project.promptDiagnosticCodes = Array.isArray(edit.frontMatter?.diagnostics)
        ? edit.frontMatter.diagnostics.map(item => item?.code).filter(code =>
          typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)).slice(0, 20)
        : [];
    } catch (_) {
      project.promptStatus = 'missing';
      diagnosticRecorder.record('diagnostic', 'DIAGNOSTIC_PROMPT_UNAVAILABLE');
    }
    try {
      const metrics = aiMetricsService.aggregateMetrics(
        aiMetricsService.loadMetrics(currentProject.rootPath)
      );
      project.metrics = diagnosticMetricsSummary(metrics);
    } catch (_) {
      diagnosticRecorder.record('diagnostic', 'DIAGNOSTIC_METRICS_UNAVAILABLE');
    }
  }
  return {
    generatedAt: new Date(),
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron || 'unknown',
      node: process.versions.node || 'unknown',
    },
    project,
    diagnostics: diagnosticRecorder.list(),
  };
}

function captureDiagnosticBinding(event) {
  return {
    webContentsId: event?.sender?.id,
    projectInstanceId: currentProject?.instanceId || null,
    mutationGeneration: projectMutationGeneration,
    navigationEpoch: rendererNavigationEpoch,
  };
}

// Key 只来自应用 userData 配置或启动环境。Main 不读取项目/仓库根
// .env，避免把写作项目中的文件误当作应用秘密配置。
function resolveActiveApiKey() {
  if (electronAiFixture) return electronAiFixture.apiKey;
  try {
    const resolved = apiKeyConfigService.resolveApiKey(app.getPath('userData'), process.env.WRITCRAFT_MINIMAX_KEY);
    return resolved ? resolved.apiKey : null;
  } catch (_) {
    // 配置损坏/权限问题时只回退由启动环境显式注入且通过同一
    // 格式校验的变量。图片路径也复用此返回值，不能把任意环境
    // 字符串作为 Authorization 发送给远端。
    try {
      return apiKeyConfigService.validateKey(process.env.WRITCRAFT_MINIMAX_KEY).key;
    } catch (_) {
      return null;
    }
  }
}

const diagnosticExportHandler = diagnosticExportHandlerService.createDiagnosticExportHandler({
  assertTrustedSender,
  captureBinding: captureDiagnosticBinding,
  createBundleInput: createDiagnosticBundleInput,
  previewStore: diagnosticPreviewStore,
  showSaveDialog: ({ defaultName }) => dialog.showSaveDialog(mainWindow, {
    title: '导出 WritCraft 诊断信息',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    buttonLabel: '导出诊断',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }),
});

// IPC 桥接（V0 Day 1 占位）
ipcMain.handle('writcraft:detect-key-type', (event, key) => {
  assertTrustedSender(event);
  if (!key || typeof key !== 'string') return 'INVALID';
  // Key 前缀只标识计费/额度来源；文本和 image-01 的实际能力
  // 由 MiniMax 服务端套餐权益、Credits 与当前额度决定。
  if (key.startsWith('sk-cp-')  || key.startsWith('SK-cp-'))  return 'CODING_PLAN';
  if (key.startsWith('sk-api-') || key.startsWith('SK-api-')) return 'FULL';
  if (key.startsWith('sk-'))                                  return 'UNKNOWN';
  return 'INVALID';
});

ipcMain.handle('writcraft:diagnostics:preview', async event => {
  try {
    return await diagnosticExportHandler.preview(event);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:diagnostics:export', async (event, request) => {
  try {
    return await diagnosticExportHandler.exportPreview(event, request);
  } catch (error) {
    return projectFailure(error);
  }
});

// IPC: Key 配置（P1-4）——renderer 只能 set / clear / status，绝不读取明文
ipcMain.handle('writcraft:api-key:status', event => {
  assertTrustedSender(event);
  try {
    return { ok: true, ...apiKeyConfigService.publicStatus(app.getPath('userData'), process.env.WRITCRAFT_MINIMAX_KEY) };
  } catch (error) {
    return { ok: false, error: error.code || 'STATUS_FAILED', configured: false, keyType: null };
  }
});

ipcMain.handle('writcraft:api-key:set', (event, key) => {
  assertTrustedSender(event);
  try {
    const saved = apiKeyConfigService.saveUserKey(app.getPath('userData'), key);
    return { ok: true, ...saved };
  } catch (error) {
    return { ok: false, error: error.code || 'SAVE_FAILED' };
  }
});

ipcMain.handle('writcraft:api-key:clear', event => {
  assertTrustedSender(event);
  try {
    const cleared = apiKeyConfigService.clearUserKey(app.getPath('userData'));
    return { ok: true, ...cleared };
  } catch (error) {
    return { ok: false, error: error.code || 'CLEAR_FAILED' };
  }
});

// IPC: 检测 API 配置是否可用
ipcMain.handle('writcraft:check-api', async event => {
  assertTrustedSender(event);
  const apiKey = resolveActiveApiKey();
  return apiHandshakeService.runApiHandshake({
    apiKey,
    fetchImpl: electronAiFixture?.textFetch,
    checkModels: minimaxTextService.checkModels,
    defaultModel: minimaxTextService.DEFAULT_MODEL,
  });
});

// IPC: ⌘K 改写（Day 3 默认用 M3 + max_tokens 1024 稳）
async function callLLM(messages, model = 'MiniMax-M3', maxTokens = 1024, signal) {
  const apiKey = resolveActiveApiKey();
  return minimaxTextService.callMessages({
    apiKey, messages, model, maxTokens, signal,
    fetchImpl: electronAiFixture?.textFetch,
  });
}

function buildProjectContext(rendererContext) {
  const sections = [];
  const manifest = [];
  if (currentProject) {
    try {
      const editPrompt = projectService.readFileWithRevision(currentProject.rootPath, projectService.EDIT_FILE);
      sections.push(`[权威项目 Prompt · edit.md]\n${editPrompt.content.slice(0, 18000)}`);
      manifest.push({ path: projectService.EDIT_FILE, revision: editPrompt.revision, role: 'project-prompt' });
    } catch (_) {}
  }
  if (typeof rendererContext === 'string' && rendererContext.trim()) {
    sections.push(`[当前编辑器上下文]\n${rendererContext.slice(0, 12000)}`);
  }
  return { text: sections.join('\n\n'), manifest };
}

function markdownPaths(tree, output = []) {
  for (const node of tree || []) {
    if (node.type === 'directory') markdownPaths(node.children, output);
    else if (node.type === 'file' && /\.(?:md|markdown)$/i.test(node.path || '')) output.push(node.path);
  }
  return output;
}

function parseModelJson(text) {
  if (typeof text !== 'string') throw new Error('AI 没有返回文本');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(source);
}

function reviewMetadata(changeSet, options = {}) {
  const fileSelectionPolicies = { ...(options.fileSelectionPolicies || {}) };
  if (changeSet.changes.some(change => change.path === projectService.EDIT_FILE)) {
    fileSelectionPolicies[projectService.EDIT_FILE] = 'file';
  }
  return {
    planDependencies: options.planDependencies || null,
    projectDependencies: options.projectDependencies || null,
    issueDependencies: options.issueDependencies || null,
    researchDependencies: options.researchDependencies || null,
    requireCompleteDecision: options.requireCompleteDecision === true,
    provenance: options.provenance || null,
    selectionPolicy: options.selectionPolicy === 'file' ? 'file' : 'hunk',
    fileSelectionPolicies,
  };
}

function cacheReviewedChangeSet(changeSet, project, options = {}) {
  const metadata = reviewMetadata(changeSet, options);
  const capability = options.capability || pendingChangeSets.allocateCapability();
  const review = changeSetReviewService.createReview(changeSet, {
    reviewId: capability,
    selectionPolicy: metadata.selectionPolicy,
    fileSelectionPolicies: metadata.fileSelectionPolicies,
  });
  pendingChangeSets.putWithCapability(capability, changeSet, project.rootPath, metadata);
  return { capability, review };
}

function invalidateOnboardingReview(changeSetId, record = pendingOnboardingReviews.get(changeSetId)) {
  if (record) onboardingCapabilityStore.invalidate(record.reviewId);
  pendingOnboardingReviews.delete(changeSetId);
}

function publicOnboardingConfirmation(token, record, source = 'review') {
  return {
    token,
    proposalDigest: record.proposalDigest,
    fileSuggestions: record.fileSuggestions,
    source,
  };
}

function boundedMigrationPreview(file) {
  if (!file) return null;
  const limit = 60000;
  return {
    path: file.path,
    content: file.content.slice(0, limit),
    bytes: file.bytes,
    revision: file.revision,
    truncated: file.content.length > limit,
  };
}

function cacheWithLimit(cache, token, entry, limit = 8) {
  cache.set(token, entry);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

async function openProjectRoot(rootPath) {
  const preview = projectService.previewLegacyEditMigration(rootPath);
  if (preview.status === 'ready') {
    const token = crypto.randomUUID();
    cacheWithLimit(pendingLegacyEditMigrations, token, {
      rootPath: fs.realpathSync(rootPath),
      expectedRevision: preview.confirmationRevision,
      createdAt: Date.now(),
    });
    return {
      ok: false,
      migration: {
        kind: 'legacy-edit',
        token,
        source: boundedMigrationPreview(preview.source),
        targetPath: preview.targetPath,
      },
    };
  }
  const promptMissing = preview.status === 'missing';
  const project = attachPrivateProjectRootIdentity(projectService.openProject(rootPath));
  const markdownTrashRecovery = await markdownTrashService.bindProject(project);
  const reopenedSameProject = Boolean(currentProject &&
    currentProject.rootPath === project.rootPath &&
    currentProject.instanceId === project.instanceId);
  const tree = projectService.listTree(project.rootPath);
  const promptFrontMatter = promptMissing
    ? projectService.inspectEditFrontMatter('')
    : projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE).frontMatter;
  if (reopenedSameProject) {
    abortActiveAiRequests();
    const chatOwnerId = currentChatConversationOwnerId();
    if (chatOwnerId) chatConversationStore.invalidateOwner(chatOwnerId, 'chat_reopened');
  }
  setCurrentProject(project);
  rememberRecentProject(project);
  return {
    ok: true,
    project: publicProject(project),
    tree,
    projectPromptMissing: promptMissing,
    promptFrontMatter,
    markdownTrashRecoveryRequired: markdownTrashRecovery.ok !== true,
    migrationNotice: preview.status === 'conflict' ? {
      kind: 'legacy-edit-conflict',
      source: boundedMigrationPreview(preview.source),
      target: boundedMigrationPreview(preview.target),
      message: preview.message,
    } : undefined,
  };
}

ipcMain.handle('writcraft:rewrite', async (event, projectInstanceId, request) => {
  assertTrustedSender(event);
  let generation = null;
  try {
    const project = requireCurrentProject();
    if (!matchesAiProjectOrigin(projectInstanceId)) {
      throw new inlineRewriteService.InlineRewriteError('INLINE_REWRITE_STALE', '项目状态已变化，请重新发起改写');
    }
    // Reject malformed or legacy requests before replacing an active
    // generation. Validation itself must not spend tokens or mutate state.
    inlineRewriteContextService.validateRequest(request);
    const origin = captureAiProjectOrigin();
    const binding = inlineRewriteBinding(event, project);
    generation = inlineRewriteStore.beginGeneration(binding);
    const prepared = inlineRewriteService.prepareInlineRewrite({
      projectService,
      rootPath: project.rootPath,
      projectId: project.projectId,
      projectInstanceId: project.instanceId,
      mutationGeneration: origin.mutationGeneration,
      request,
      rewriteId: generation.rewriteId,
      expiresAt: generation.expiresAt,
    });
    const model = await runAiRequest(
      project.instanceId,
      signal => callLLM(prepared.messages, 'MiniMax-M3', 4096, signal),
      generation.signal
    );
    if (!isAiProjectOriginCurrent(origin)) {
      throw new inlineRewriteService.InlineRewriteError('INLINE_REWRITE_STALE', '项目或改写上下文已变化');
    }
    if (!model?.ok) {
      inlineRewriteStore.failGeneration(generation.rewriteId);
      generation = null;
      return inlineRewriteProviderFailure(model);
    }
    const proposal = inlineRewriteService.finalizeInlineRewrite({
      prepared,
      model,
      projectService,
      changeSetService,
      mutationGeneration: projectMutationGeneration,
    });
    const result = inlineRewriteStore.completeGeneration(generation.rewriteId, proposal);
    generation = null;
    return result;
  } catch (error) {
    if (generation) inlineRewriteStore.failGeneration(generation.rewriteId);
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:rewrite:ack', async (event, projectInstanceId, payload) => {
  assertTrustedSender(event);
  try {
    const project = requireCurrentProject();
    if (project.instanceId !== projectInstanceId) {
      throw new inlineRewriteService.InlineRewriteError('INLINE_REWRITE_STALE', '项目状态已变化，请重新发起改写');
    }
    return inlineRewriteStore.acknowledge(inlineRewriteBinding(event, project), payload);
  } catch (error) {
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:rewrite:discard', async (event, projectInstanceId, payload) => {
  assertTrustedSender(event);
  try {
    const project = requireCurrentProject();
    if (project.instanceId !== projectInstanceId) {
      throw new inlineRewriteService.InlineRewriteError('INLINE_REWRITE_STALE', '项目状态已变化，请重新发起改写');
    }
    return inlineRewriteStore.discard(inlineRewriteBinding(event, project), payload);
  } catch (error) {
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:rewrite:apply', async (event, projectInstanceId, payload) => {
  assertTrustedSender(event);
  let lease = null;
  let mutationToken = null;
  let mutationEnded = false;
  try {
    const project = requireMutableProject();
    if (project.instanceId !== projectInstanceId) {
      throw new inlineRewriteService.InlineRewriteError('INLINE_REWRITE_STALE', '项目状态已变化，请重新发起改写');
    }
    lease = inlineRewriteStore.beginApply(
      inlineRewriteBinding(event, project),
      payload,
      proposal => {
        const change = proposal.changeSet.changes[0];
        inlineRewriteReconciliation.beginApply({
          rootPath: project.rootPath,
          projectId: project.projectId,
          rewriteId: proposal.rewriteId,
          path: change.path,
          beforeRevision: change.expectedRevision,
          expectedAfterRevision: crypto.createHash('sha256').update(change.after, 'utf8').digest('hex'),
        });
      }
    );
    mutationToken = beginInternalMutation(project);
    const outcome = inlineRewriteApplyService.apply({
      lease,
      projectService,
      rootPath: project.rootPath,
      projectId: project.projectId,
      projectInstanceId: project.instanceId,
      mutationGeneration: projectMutationGeneration,
      reconciliationService: inlineRewriteReconciliation,
      refreshCommitted({ path: committedPath, revision }) {
        rememberOwnMarkdownState(committedPath, revision);
        invalidateProjectDerivedState();
        projectService.listTree(project.rootPath);
        mutationEnded = true;
        endInternalMutation(mutationToken, project);
      },
    });
    if (!mutationEnded) {
      mutationEnded = true;
      endInternalMutation(mutationToken, project);
    }
    inlineRewriteStore.finishApply(lease.rewriteId, lease.applyLeaseId, outcome.terminalState);
    lease = null;
    return outcome.result;
  } catch (error) {
    if (mutationToken && !mutationEnded) {
      try { endInternalMutation(mutationToken, currentProject || { rootPath: mutationToken.rootPath }); } catch (_) {}
    }
    if (lease) {
      try { inlineRewriteStore.finishApply(lease.rewriteId, lease.applyLeaseId, 'MANUAL_RECOVERY'); } catch (_) {}
    }
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:rewrite:reconciliation', async (event, projectInstanceId, payload) => {
  assertTrustedSender(event);
  try {
    const project = requireCurrentProject();
    if (project.instanceId !== projectInstanceId || !payload || Array.isArray(payload) ||
        Object.getPrototypeOf(payload) !== Object.prototype || Object.keys(payload).length !== 1 ||
        payload.schema !== 'writcraft.inline-rewrite-reconciliation/v1') {
      throw new inlineRewriteService.InlineRewriteError('INVALID_INLINE_REWRITE', 'Inline Rewrite 恢复查询无效');
    }
    // Reconciliation can repair/clear the durable marker and therefore must
    // not write while the exact project watcher is degraded. It deliberately
    // bypasses the inline marker guard because repairing that marker is its job.
    assertProjectWatcherAvailable(project);
    changesHistoryOnlyMutationGuard.assertAvailable(project.rootPath);
    const marker = inlineRewriteReconciliation.read(project.rootPath);
    if (marker?.state === 'applying' && inlineRewriteStore.inspect(marker.rewriteId)?.state !== 'APPLYING') {
      return inlineRewriteReconciliation.reconcileApplying({
        rootPath: project.rootPath,
        projectId: project.projectId,
        projectService,
        findHistory(rewriteId) {
          const entry = changeHistoryService.listHistory(project.rootPath).find(item =>
            item.provenance?.kind === 'inline_rewrite' && item.provenance.rewriteId === rewriteId);
          return entry || null;
        },
      });
    }
    return inlineRewriteReconciliation.publicStatus({ rootPath: project.rootPath, projectId: project.projectId });
  } catch (error) {
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:rewrite:reconciliation-clear', async (event, projectInstanceId, payload) => {
  assertTrustedSender(event);
  try {
    const project = requireCurrentProject();
    if (project.instanceId !== projectInstanceId || !payload || Array.isArray(payload) ||
        Object.getPrototypeOf(payload) !== Object.prototype ||
        Object.keys(payload).sort().join(',') !== 'rewriteId,schema' ||
        payload.schema !== 'writcraft.inline-rewrite-reconciliation-clear/v1' ||
        !inlineRewriteService.REWRITE_ID_RE.test(payload.rewriteId || '')) {
      throw new inlineRewriteService.InlineRewriteError('INVALID_INLINE_REWRITE', 'Inline Rewrite 恢复清理无效');
    }
    assertProjectWatcherAvailable(project);
    changesHistoryOnlyMutationGuard.assertAvailable(project.rootPath);
    return inlineRewriteReconciliation.clear({
      rootPath: project.rootPath,
      projectId: project.projectId,
      rewriteId: payload.rewriteId,
    });
  } catch (error) {
    return inlineRewriteFailure(error);
  }
});

ipcMain.handle('writcraft:chat', async (event, projectInstanceId, userMessage, projectContext = '', contextRequest = null) => {
  assertTrustedSender(event);
  if (!matchesAiProjectOrigin(projectInstanceId)) return staleAiProjectResult();
  const origin = captureAiProjectOrigin();
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return { ok: false, error: 'EMPTY_MESSAGE' };
  }
  if (Array.from(userMessage).length > MAX_CHAT_MESSAGE_CHARS || Buffer.byteLength(userMessage, 'utf8') > MAX_CHAT_MESSAGE_BYTES) {
    return { ok: false, error: 'INPUT_TOO_LARGE', message: '单次对话问题不能超过 4000 个字符' };
  }
  // Once a project is active, only Main may resolve the model context from the
  // authoritative filesystem. A missing request must never fall back to a
  // renderer-supplied projectContext snapshot.
  if (currentProject && (contextRequest === null || contextRequest === undefined)) {
    return { ok: false, error: 'INVALID_CONTEXT_REQUEST', message: '项目对话缺少结构化上下文请求' };
  }
  if (currentProject && projectContext !== '') {
    return { ok: false, error: 'INVALID_CONTEXT_REQUEST', message: '项目对话正文只能由 Main 从磁盘快照重建' };
  }
  const contextValidation = validateRendererContext(projectContext, contextRequest);
  if (!contextValidation.ok) return contextValidation;
  if (contextRequest && contextRequest.message !== undefined && contextRequest.message !== userMessage) {
    return { ok: false, error: 'INVALID_CONTEXT_REQUEST', message: '上下文问题必须与对话问题一致' };
  }
  const originalUserMessage = userMessage;
  let resolvedContext = null;
  if (currentProject) {
    try {
      let contextPolicy = null;
      const excludedChipIds = contextRequest.contextPolicy?.excludedChipIds;
      if (Array.isArray(excludedChipIds) && excludedChipIds.length) {
        if (!lastContextResponse || lastContextResponse.rootPath !== currentProject.rootPath) {
          return { ok: false, error: 'CONTEXT_POLICY_EXPIRED', message: '上次上下文记录已失效，请重新选择' };
        }
        contextPolicy = contextPolicyService.createExclusionPolicy(lastContextResponse.manifest, excludedChipIds);
      }
      resolvedContext = contextResolverService.resolveProjectContext({
        projectService,
        rootPath: currentProject.rootPath,
        message: typeof contextRequest.message === 'string' ? contextRequest.message : userMessage,
        currentFilePath: contextRequest.currentFilePath,
        scope: contextRequest.scope,
        selection: contextRequest.selection,
        policy: contextPolicy,
      });
      userMessage = resolvedContext.query || userMessage;
      projectContext = resolvedContext.contextText;
    } catch (error) {
      return projectFailure(error);
    }
  }
  // A resolved project context already contains the authoritative edit.md and
  // every included chip. Feeding it through buildProjectContext() would prepend
  // edit.md again and make the actual model prompt diverge from the manifest.
  const boundedContext = resolvedContext
    ? { text: resolvedContext.contextText, manifest: resolvedContext.contextManifest }
    : buildProjectContext(projectContext);
  const systemContext = boundedContext.text
    ? `当前项目背景：\n${boundedContext.text}\n\n请基于此回答用户的写作相关问题。`
    : '你是中文写作助手，专门帮助用户规划、改进、润色文章。请用简洁、专业、温暖的语气回答。';
  let conversationLease = null;
  if (currentProject) {
    try {
      conversationLease = chatConversationStore.begin(
        chatConversationBinding(event, currentProject),
        originalUserMessage
      );
    } catch (error) {
      return chatConversationFailure(error);
    }
  }
  const conversationContext = conversationLease?.summary?.text
    ? [
      '最近对话摘要（由 Main 有界保存，仅用于保持当前会话连续；当前 edit.md、当前文件和本轮问题优先）：',
      conversationLease.summary.text,
    ].join('\n')
    : '';
  const prompt = [systemContext, conversationContext, `问题：${userMessage}`].filter(Boolean).join('\n\n');
  let result;
  try {
    result = await runAiRequest(projectInstanceId, signal => callLLM(
      [{ role: 'user', content: prompt }],
      'MiniMax-M3',
      1024,
      signal
    ), conversationLease?.signal || null);
  } catch (error) {
    if (conversationLease) chatConversationStore.finish(conversationLease);
    throw error;
  }
  if (!isAiProjectOriginCurrent(origin)) {
    if (conversationLease) chatConversationStore.finish(conversationLease);
    return staleAiProjectResult();
  }
  let conversation = null;
  if (conversationLease) {
    if (result?.ok === true && typeof result.text === 'string') {
      try {
        conversation = chatConversationStore.commit(conversationLease, result.text);
      } catch (error) {
        return chatConversationFailure(error);
      }
    } else {
      chatConversationStore.finish(conversationLease);
    }
  }
  const actualManifest = resolvedContext
    ? chatConversationService.attachSummaryToManifest({
      ...resolvedContext.contextManifest,
      errors: resolvedContext.errors,
    }, conversationLease?.summary)
    : chatConversationService.attachSummaryToManifest(boundedContext.manifest, conversationLease?.summary);
  if (resolvedContext && currentProject) {
    lastContextResponse = { rootPath: currentProject.rootPath, manifest: actualManifest };
  }
  return {
    ...result,
    contextManifest: actualManifest,
    ...(conversation ? { conversation } : {}),
  };
});

ipcMain.handle('writcraft:chat:reset', async (event, projectInstanceId) => {
  assertTrustedSender(event);
  if (!matchesAiProjectOrigin(projectInstanceId) || !currentProject) return staleAiProjectResult();
  try {
    chatConversationStore.reset(chatConversationBinding(event, currentProject));
    return {
      ok: true,
      conversation: {
        schema: chatConversationService.PUBLIC_STATE_SCHEMA,
        turnCount: 0,
        resetReason: 'user_reset',
      },
    };
  } catch (error) {
    return chatConversationFailure(error);
  }
});

ipcMain.handle('writcraft:chat:cancel-pending', async (event, projectInstanceId) => {
  assertTrustedSender(event);
  if (!matchesAiProjectOrigin(projectInstanceId) || !currentProject) return staleAiProjectResult();
  try {
    chatConversationStore.cancelPending(chatConversationBinding(event, currentProject));
    return { ok: true };
  } catch (error) {
    return chatConversationFailure(error);
  }
});

ipcMain.handle('writcraft:project:propose-plan', projectPlanHandler.createProposePlanHandler({
  assertTrustedSender,
  requireCurrentProject,
  getCurrentProject: () => currentProject,
  getMutationGeneration: () => projectMutationGeneration,
  projectPlanService,
  projectService,
  projectCallLLM,
  pendingPlanRecords,
  staleAiProjectResult,
  projectFailure,
}));

ipcMain.handle('writcraft:project:handoff-plan-task', async (event, projectInstanceId, request) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const origin = captureAiProjectOrigin();
    const prepared = projectPlanHandoffService.preparePlanTaskHandoff({
      store: pendingPlanRecords,
      projectService,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: projectMutationGeneration,
      request,
    });
    const model = await runAiRequest(project.instanceId, signal => callLLM(
      prepared.messages,
      'MiniMax-M3',
      minimaxTextService.MAX_MAX_TOKENS,
      signal
    ));
    if (!isAiProjectOriginCurrent(origin)) return staleAiProjectResult();
    projectPlanHandoffService.validatePlanDependencies({
      projectService,
      rootPath: project.rootPath,
      dependencies: prepared.dependencies,
    });
    const result = projectPlanHandoffService.finalizePlanTaskHandoff({
      prepared,
      model,
      changeSetService,
    });
    if (!result.ok) return result;
    if (result.noChanges) return result;
    const cached = cacheReviewedChangeSet(result.changeSet, project, {
      planDependencies: prepared.dependencies,
      provenance: result.provenance,
    });
    const { changeSet, changeSetId: _contentId, preview: _preview, ...publicResult } = result;
    return { ...publicResult, changeSetId: cached.capability, review: cached.review };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:handoff-graph-issue', async (event, projectInstanceId, request) => {
  try {
    assertTrustedSender(event);
    // Graph indexing and issue reconciliation persist private graph metadata
    // before model admission, so the watcher gate belongs at handler entry.
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const origin = captureAiProjectOrigin();
    // Bind against the corrected graph after persistent issue states have
    // been reconciled. Renderer prose, paths and evidence are never accepted.
    const indexed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const issueState = issueStateService.reconcileIssueStates(project.rootPath, indexed.graph.issues);
    const authoritativeGraph = { ...indexed.graph, issues: issueState.issues };
    const prepared = graphIssueHandoffService.prepareGraphIssueHandoff({
      graph: authoritativeGraph,
      projectService,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      request,
    });
    const model = await runAiRequest(project.instanceId, signal => callLLM(
      prepared.messages,
      'MiniMax-M3',
      minimaxTextService.MAX_MAX_TOKENS,
      signal
    ));
    if (!isAiProjectOriginCurrent(origin)) return staleAiProjectResult();

    // Rebuild and reconcile immediately after generation. This catches file,
    // correction and user-status changes even when the raw graph identity is
    // unchanged, before a capability is issued.
    const refreshed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const refreshedIssueState = issueStateService.reconcileIssueStates(project.rootPath, refreshed.graph.issues);
    const refreshedGraph = { ...refreshed.graph, issues: refreshedIssueState.issues };
    graphIssueHandoffService.validateIssueDependencies({
      graph: refreshedGraph,
      projectService,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      dependencies: prepared.dependencies,
    });
    const result = graphIssueHandoffService.finalizeGraphIssueHandoff({ prepared, model, changeSetService });
    if (!result.ok) return result;
    if (result.noChanges) {
      return {
        ...result,
        proposalKind: 'graph_issue',
        requireCompleteDecision: true,
      };
    }
    const cached = cacheReviewedChangeSet(result.changeSet, project, {
      issueDependencies: prepared.dependencies,
      requireCompleteDecision: true,
      provenance: result.provenance,
    });
    const { changeSet, changeSetId: _contentId, preview: _preview, ...publicResult } = result;
    return {
      ...publicResult,
      proposalKind: 'graph_issue',
      requireCompleteDecision: true,
      changeSetId: cached.capability,
      review: cached.review,
    };
  } catch (error) {
    return projectFailure(error);
  }
});

// Project filesystem IPC. The renderer never passes a root path for file
// operations: it can only work inside the project selected by the user here.
ipcMain.handle('writcraft:project:create', async (event, name) => {
  try {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择新项目的保存位置',
      buttonLabel: '在这里创建',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const project = attachPrivateProjectRootIdentity(
      projectService.createProjectAt(result.filePaths[0], name)
    );
    const markdownTrashRecovery = await markdownTrashService.bindProject(project);
    const tree = projectService.listTree(project.rootPath);
    setCurrentProject(project);
    rememberRecentProject(project);
    return {
      ok: true,
      project: publicProject(project),
      tree,
      onboardingRecommended: true,
      markdownTrashRecoveryRequired: markdownTrashRecovery.ok !== true,
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:open', async (event) => {
  try {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 WritCraft 项目',
      buttonLabel: '打开项目',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return await openProjectRoot(result.filePaths[0]);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:open-recent', async (event) => {
  try {
    assertTrustedSender(event);
    const rootPath = projectService.loadRecentProject(app.getPath('userData'), {
      // Only the deterministic, unpackaged GUI fixture may auto-restore its
      // intentionally temporary project. User-driven Open remains unrestricted.
      allowEphemeral: Boolean(electronAiFixture),
    });
    if (!rootPath) {
      return { ok: false, error: 'NO_RECENT_PROJECT', message: '没有可恢复的最近项目' };
    }
    // Persisted roots are untrusted input. Re-open through the same project
    // validation boundary before it can become the authority for later IPC.
    return await openProjectRoot(rootPath);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:list', async (event) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, project: publicProject(project), tree: projectService.listTree(project.rootPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle(
  'writcraft:project:flush-external-changes',
  projectWatcherFlushHandlerService.createProjectWatcherFlushHandler({
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject: () => currentProject,
    getCurrentWatcher: () => currentProjectWatcher,
    assertWatcherAvailable: assertProjectWatcherAvailable,
    markWatcherDegraded: project => projectWatcherHealth.markDegraded(project),
    getMutationDepth: rootPath => internalMutationDepthByRoot.get(rootPath) || 0,
    getInternalMutationEpoch: () => internalMutationEpoch,
    getMutationGeneration: () => projectMutationGeneration,
    getNavigationEpoch: () => rendererNavigationEpoch,
    createError: (code, message) => new projectService.ProjectServiceError(code, message),
    createId: () => crypto.randomUUID(),
    projectChanged: staleAiProjectResult,
    projectFailure,
    sendBarrier: (event, channel, payload) => event.sender.send(channel, payload),
  })
);

ipcMain.handle('writcraft:project:resolve-context', async (event, projectInstanceId, contextRequest) => {
  try {
    assertTrustedSender(event);
    if (!matchesAiProjectOrigin(projectInstanceId)) return staleAiProjectResult();
    if (contextRequest === null || contextRequest === undefined) {
      return { ok: false, error: 'INVALID_CONTEXT_REQUEST', message: '缺少结构化上下文请求' };
    }
    const contextValidation = validateRendererContext('', contextRequest);
    if (!contextValidation.ok) return contextValidation;
    const project = requireCurrentProject();
    let contextPolicy = null;
    if (contextRequest.contextPolicy.excludedChipIds.length) {
      if (!lastContextResponse || lastContextResponse.rootPath !== project.rootPath) {
        return { ok: false, error: 'CONTEXT_POLICY_EXPIRED', message: '上次上下文记录已失效，请重新选择' };
      }
      contextPolicy = contextPolicyService.createExclusionPolicy(
        lastContextResponse.manifest,
        contextRequest.contextPolicy.excludedChipIds,
      );
    }
    return {
      ok: true,
      ...contextResolverService.resolveProjectContext({
        projectService,
        rootPath: project.rootPath,
        message: contextRequest.message,
        currentFilePath: contextRequest.currentFilePath,
        scope: contextRequest.scope,
        selection: contextRequest.selection,
        policy: contextPolicy,
      }),
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:read', async (event, relPath) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    const file = projectService.readFileWithRevision(project.rootPath, relPath);
    return { ok: true, path: relPath, ...file };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:write', async (event, relPath, content, expectedRevision) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.atomicWriteFile(project.rootPath, relPath, content, expectedRevision);
    rememberOwnFileMutation(file);
    invalidateProjectDerivedState();
    return { ok: true, file };
  } catch (error) {
    return projectFailure(error);
  }
});

// Deliberate conflict resolution is a separate capability from ordinary save.
// It still binds to the exact disk revision the user reviewed, so a second
// external edit after confirmation cannot be overwritten.
ipcMain.handle('writcraft:project:overwrite-conflict', async (event, relPath, content, observedRevision) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.overwriteConflictedFile(project.rootPath, relPath, content, observedRevision);
    rememberOwnFileMutation(file);
    invalidateProjectDerivedState();
    return { ok: true, file };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:recreate-deleted', async (event, relPath, content) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.createMarkdownFile(project.rootPath, relPath, content);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:create-file', async (event, relPath) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.createMarkdownFile(project.rootPath, relPath);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:create-prompt', async (event) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.createEditPrompt(project.rootPath);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:rename-file', async (event, sourcePath, targetPath, expectedRevision) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.moveMarkdownFile(project.rootPath, sourcePath, targetPath, expectedRevision);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:move-file', async (event, sourcePath, targetPath, expectedRevision) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const file = projectService.moveMarkdownFile(project.rootPath, sourcePath, targetPath, expectedRevision);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:trash-file', async (event, relPath, expectedRevision) => {
  let mutationLease = null;
  let mutationProject = null;
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    mutationProject = project;
    mutationLease = beginInternalMutation(project);
    const file = await markdownTrashHandler.trash(event, relPath, expectedRevision);
    return lifecycleSuccess(project, file, {
      fromPath: file.fromPath,
      bytes: file.bytes,
      trashed: true,
    });
  } catch (error) {
    return projectFailure(error);
  } finally {
    if (mutationLease && mutationProject) endInternalMutation(mutationLease, mutationProject);
  }
});

ipcMain.handle('writcraft:project:get-markdown-trash', async (event, projectInstanceId) => {
  try {
    requireCurrentProject();
    return await markdownTrashHandler.list(event, projectInstanceId);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:restore-markdown-trash', async (
  event,
  projectInstanceId,
  token
) => {
  let mutationLease = null;
  let mutationProject = null;
  try {
    const project = requireMutableProject();
    mutationProject = project;
    mutationLease = beginInternalMutation(project);
    const restored = await markdownTrashHandler.restore(event, projectInstanceId, token);
    return {
      ...restored,
      ...lifecycleSuccess(project, restored.file),
    };
  } catch (error) {
    return projectFailure(error);
  } finally {
    if (mutationLease && mutationProject) endInternalMutation(mutationLease, mutationProject);
  }
});

ipcMain.handle('writcraft:project:confirm-legacy-edit', async (event, token) => {
  try {
    assertTrustedSender(event);
    const pending = pendingLegacyEditMigrations.get(token);
    if (!pending || typeof pending.rootPath !== 'string' || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      return { ok: false, error: 'MIGRATION_EXPIRED', message: '迁移预览已过期，请重新打开项目预览' };
    }
    // The first legacy migration may be confirmed before any project becomes
    // current. If this exact root is already current, however, its degraded
    // watcher must block the write. A different/no current root is opened via
    // openProjectRoot after the atomic migration and establishes its watcher.
    if (currentProject && currentProject.rootPath === pending.rootPath) {
      assertInlineRewriteMutationAvailable(currentProject);
    } else {
      // Even before this legacy root becomes current, either durable recovery
      // marker owns all mutation authority for the folder.
      inlineRewriteMutationGuard.assertAvailable(pending.rootPath);
      const recoveryProbe = attachPrivateProjectRootIdentity({
        instanceId: `legacy-migration:${token}`,
        rootPath: pending.rootPath,
      });
      await markdownTrashService.bindProject(recoveryProbe);
      markdownTrashService.assertMutationAvailable(recoveryProbe);
    }
    const migration = projectService.migrateLegacyEditFile(pending.rootPath, {
      confirmed: true,
      expectedRevision: pending.expectedRevision,
    });
    rememberOwnFileMutation(migration.file);
    rememberOwnMarkdownState('editor.md', null);
    pendingLegacyEditMigrations.delete(token);
    invalidateProjectDerivedState();
    return await openProjectRoot(pending.rootPath);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:preview-legacy-draft', async (event, content, requestedPath) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    const occupied = markdownPaths(projectService.listTree(project.rootPath));
    const plan = projectService.planLegacyDraftImport(content, requestedPath, occupied);
    const token = crypto.randomUUID();
    cacheWithLimit(pendingLegacyDraftImports, token, {
      rootPath: project.rootPath,
      content: plan.content,
      targetPath: plan.targetPath,
      revision: plan.revision,
      createdAt: Date.now(),
    });
    const { content: _content, ...publicPlan } = plan;
    return { ok: true, token, plan: publicPlan };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:confirm-legacy-draft', async (event, token) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    const pending = pendingLegacyDraftImports.get(token);
    if (!pending || pending.rootPath !== project.rootPath || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      return { ok: false, error: 'MIGRATION_EXPIRED', message: '草稿导入预览已过期，请重新预览' };
    }
    const file = projectService.createMarkdownFile(project.rootPath, pending.targetPath, pending.content);
    const verified = projectService.readFileWithRevision(project.rootPath, pending.targetPath);
    if (verified.revision !== pending.revision || file.revision !== pending.revision) {
      const error = new Error('草稿写入后的内容校验失败');
      error.code = 'MIGRATION_VERIFY_FAILED';
      throw error;
    }
    pendingLegacyDraftImports.delete(token);
    return lifecycleSuccess(project, file);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:discard-migration', async (event, token) => {
  try {
    assertTrustedSender(event);
    pendingLegacyEditMigrations.delete(token);
    pendingLegacyDraftImports.delete(token);
    return { ok: true };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:search', async (event, query) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, ...projectSearchService.searchProject(projectService, project.rootPath, query) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:get-context', async (event) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    const preview = projectService.previewLegacyEditMigration(project.rootPath);
    if (preview.status === 'missing') {
      return {
        ok: true,
        project: publicProject(project),
        projectPromptMissing: true,
        editPrompt: '',
        editRevision: '',
        editFrontMatter: projectService.inspectEditFrontMatter(''),
        tree: projectService.listTree(project.rootPath),
      };
    }
    const editPrompt = projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE);
    return {
      ok: true,
      project: publicProject(project),
      projectPromptMissing: false,
      editPrompt: editPrompt.content,
      editRevision: editPrompt.revision,
      editFrontMatter: editPrompt.frontMatter,
      tree: projectService.listTree(project.rootPath),
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:propose-chapter', async (event, projectInstanceId, request) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const origin = captureAiProjectOrigin();
    const proposal = await chapterProposalService.proposeChapter({
      projectService,
      rootPath: project.rootPath,
      request,
      callLLM: projectCallLLM(project.instanceId),
      changeSetService,
    });
    if (!proposal.ok) return proposal;
    if (!isAiProjectOriginCurrent(origin)) return staleAiProjectResult();
    // The service checks all frozen inputs throughout block generation. Check
    // once more immediately before capability allocation; projectDependencies
    // repeats the same revision gate when the user later applies the review.
    chapterProposalService.validateChapterDependencies({
      projectService,
      rootPath: project.rootPath,
      dependencies: proposal.contextManifest.files,
    });
    if (proposal.noChanges) return proposal;
    const cached = cacheReviewedChangeSet(proposal.changeSet, project, {
      projectDependencies: proposal.contextManifest.files,
      provenance: proposal.provenance,
      selectionPolicy: 'file',
    });
    return {
      ok: true,
      noChanges: false,
      changeSetId: cached.capability,
      review: cached.review,
      fileCount: proposal.fileCount,
      contextManifest: proposal.contextManifest,
      provenance: proposal.provenance,
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:propose-onboarding', projectOnboardingHandler.createProposeOnboardingHandler({
  assertTrustedSender,
  requireCurrentProject,
  getCurrentProject: () => currentProject,
  getMutationGeneration: () => projectMutationGeneration,
  getRendererNavigationEpoch: () => rendererNavigationEpoch,
  assertOnboardingFlowAvailable: onboardingAdmission.assertAvailable,
  projectOnboardingV2Service,
  projectService,
  projectCallLLM,
  onboardingCapabilityStore,
  cacheReviewedChangeSet,
  pendingChangeSets,
  pendingOnboardingReviews,
  staleAiProjectResult,
  projectFailure,
}));

ipcMain.handle('writcraft:project:confirm-onboarding-files', async (
  event,
  projectInstanceId,
  confirmationToken,
  proposalDigest,
  selectedPaths
) => {
  let trusted = false;
  try {
    assertTrustedSender(event);
    trusted = true;
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) {
      onboardingCapabilityStore.invalidate(confirmationToken);
      return staleAiProjectResult();
    }
    const edit = projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE);
    const mutationLease = beginInternalMutation(project);
    let result;
    try {
      result = onboardingBatchCoordinator.confirmAndCreate({
        confirmationToken,
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        mutationGeneration: projectMutationGeneration,
        editRevision: edit.revision,
        proposalDigest,
        selectedPaths,
      });
    } catch (error) {
      // No batch result means no publication succeeded. Lease cleanup must not
      // replace the original fail-closed error if watcher delivery also fails.
      try { endInternalMutation(mutationLease, project); }
      catch (_) { console.error('[project:onboarding-confirm]', 'PRECOMMIT_LEASE_RELEASE_FAILED'); }
      throw error;
    }

    // From this point onward the batch is durably published. Every remaining
    // operation is bookkeeping or refresh only and must never turn a committed
    // result into ok:false, which could tempt the Renderer to repeat creation.
    return finalizeOnboardingBatchCommit(result, {
      remember: rememberOwnFileMutation,
      invalidate: invalidateProjectDerivedState,
      endMutation: () => endInternalMutation(mutationLease, project),
      listTree: () => projectService.listTree(project.rootPath),
      log: code => console.error('[project:onboarding-confirm]', code),
    });
  } catch (error) {
    if (trusted) onboardingCapabilityStore.invalidate(confirmationToken);
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:discard-onboarding-confirmation', async (event, projectInstanceId, confirmationToken) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) {
      onboardingCapabilityStore.invalidate(confirmationToken);
      return staleAiProjectResult();
    }
    return { ok: true, discarded: onboardingCapabilityStore.invalidate(confirmationToken) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:propose-edit-prompt-repair', async (event, projectInstanceId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const edit = projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE);
    const repair = projectService.proposeEditFrontMatterRepair(edit.content);
    if (repair.status !== 'ready') {
      return { ok: false, error: 'EDIT_PROMPT_REPAIR_NOT_NEEDED', message: 'edit.md Front Matter 当前不需要修复' };
    }
    const changeSet = changeSetService.createChangeSet(
      [{ path: projectService.EDIT_FILE, content: edit.content, revision: edit.revision }],
      [{ path: projectService.EDIT_FILE, after: repair.content, summary: '迁移 edit.md Front Matter，并保留原有字段与正文' }]
    );
    const cached = cacheReviewedChangeSet(changeSet, project, { selectionPolicy: 'file' });
    return {
      ok: true,
      proposalKind: 'edit_prompt_repair',
      changeSetId: cached.capability,
      review: cached.review,
      fileCount: 1,
      diagnostics: repair.diagnostics,
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:propose-changes', async (event, projectInstanceId, request) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const origin = captureAiProjectOrigin();
    const prepared = projectChangesProposalService.prepareProjectChangesProposal({
      projectService,
      rootPath: project.rootPath,
      request,
    });
    const model = await runAiRequest(project.instanceId, signal => callLLM(
      prepared.messages,
      'MiniMax-M3',
      minimaxTextService.MAX_MAX_TOKENS,
      signal
    ));
    if (!isAiProjectOriginCurrent(origin)) return staleAiProjectResult();
    // Revalidate targets, edit.md and every explicit readonly context before a
    // capability is allocated. The same dependencies are checked again at
    // apply time so a stale context can never authorize an old diff.
    projectChangesProposalService.validateProjectDependencies({
      projectService,
      rootPath: project.rootPath,
      dependencies: prepared.dependencies,
    });
    const result = projectChangesProposalService.finalizeProjectChangesProposal({
      prepared,
      model,
      changeSetService,
    });
    if (!result.ok) return result;
    if (result.noChanges) return result;
    const cached = cacheReviewedChangeSet(result.changeSet, project, {
      projectDependencies: prepared.dependencies,
      provenance: result.provenance,
    });
    return {
      ok: true,
      noChanges: false,
      changeSetId: cached.capability,
      review: cached.review,
      fileCount: result.fileCount,
      provenance: result.provenance,
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:apply-changes', async (event, projectInstanceId, decision) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const descriptor = Object.getOwnPropertyDescriptor(decision || {}, 'changeSetId');
    const changeSetId = descriptor && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : '';
    const pending = pendingChangeSets.get(changeSetId);
    if (pending?.rootPath === project.rootPath && pending.researchDependencies) {
      assertInlineRewriteMutationAvailable(project);
      return researchApplyTransaction.apply({
        project,
        pending,
        changeSetId,
        decision,
      });
    }
    return changesHistoryHandler.applyChanges(projectInstanceId, decision);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:list-change-history', async event => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, history: changeHistoryService.listHistory(project.rootPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:undo-change', async (event, projectInstanceId, historyEntryId) => {
  try {
    assertTrustedSender(event);
    return changesHistoryHandler.undoChange(projectInstanceId, historyEntryId);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:query-changes-history-recovery',
  async (event, projectInstanceId, request) => {
    assertTrustedSender(event);
    return changesHistoryHandler.queryRecovery(projectInstanceId, request);
  });

ipcMain.handle('writcraft:project:resolve-changes-history-recovery',
  async (event, projectInstanceId, request) => {
    assertTrustedSender(event);
    return changesHistoryHandler.resolveRecovery(projectInstanceId, request);
  });

ipcMain.handle('writcraft:project:clear-changes-history-recovery',
  async (event, projectInstanceId, request) => {
    assertTrustedSender(event);
    return changesHistoryHandler.clearRecovery(projectInstanceId, request);
  });

ipcMain.handle('writcraft:project:discard-changes', async (event, projectInstanceId, changeSetId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const pending = pendingChangeSets.get(changeSetId);
    if (!pending || pending.rootPath !== project.rootPath) {
      return { ok: false, error: 'CHANGESET_NOT_FOUND', message: '待审阅修改不属于当前项目，请重新生成' };
    }
    if (pending.researchDependencies) {
      researchHandoffStore.discard({
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        cardId: pending.researchDependencies.cardId,
      });
    } else {
      pendingChangeSets.delete(changeSetId);
    }
    invalidateOnboardingReview(changeSetId);
    return { ok: true };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:build-graph', async (event, projectInstanceId) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const indexed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const issueState = issueStateService.reconcileIssueStates(project.rootPath, indexed.graph.issues);
    const graph = graphIssueHandoffService.decorateGraphIssues({
      graph: { ...indexed.graph, issues: issueState.issues },
      projectInstanceId: project.instanceId,
    });
    return {
      ok: true,
      graph,
      index: {
        status: indexed.status,
        analyzedPaths: indexed.analyzedPaths,
        reusedPaths: indexed.reusedPaths,
        removedPaths: indexed.removedPaths,
        cacheReason: indexed.cacheReason,
      },
      issueState: {
        recovered: issueState.recovered,
        recoveryReason: issueState.recoveryReason,
        pruned: issueState.pruned,
        persistenceBlocked: issueState.persistenceBlocked,
      },
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:apply-graph-correction', async (event, projectInstanceId, command) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    // Re-index immediately before accepting identifiers. The renderer never
    // supplies labels, evidence snapshots, paths, or revisions as authority.
    const indexed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const submitted = graphCorrectionService.submitCorrection(project.rootPath, indexed.graph, command);
    const refreshed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const issueState = issueStateService.reconcileIssueStates(project.rootPath, refreshed.graph.issues);
    const graph = graphIssueHandoffService.decorateGraphIssues({
      graph: { ...refreshed.graph, issues: issueState.issues },
      projectInstanceId: project.instanceId,
    });
    return {
      ok: true,
      correction: submitted.correction,
      graph,
      index: { status: refreshed.status },
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:set-issue-status', async (event, projectInstanceId, issueId, status) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    // Re-index against authoritative project snapshots before accepting a
    // renderer-supplied issue ID; stale or foreign IDs are rejected below.
    const indexed = graphIndexService.indexProjectGraph(projectService, project.rootPath);
    const result = issueStateService.setIssueStatus(project.rootPath, indexed.graph.issues, issueId, status);
    return {
      ok: true,
      issue: result.issue,
      issueState: {
        recovered: result.recovered,
        recoveryReason: result.recoveryReason,
        pruned: result.pruned,
      },
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:import-reference', async (event, projectInstanceId) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，未导入来源');
    }
    const mutationGeneration = projectMutationGeneration;
    let mutationLease = null;
    const assertGeneration = () => {
      if (!currentProject || currentProject.rootPath !== project.rootPath ||
          currentProject.instanceId !== project.instanceId ||
          currentProject.instanceId !== projectInstanceId ||
          projectMutationGeneration !== mutationGeneration) {
        throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，未导入来源');
      }
      assertInlineRewriteMutationAvailable(project, mutationLease);
    };
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地来源附件',
      buttonLabel: '导入来源',
      properties: ['openFile'],
      filters: [
        { name: '来源文件', extensions: ['pdf', 'txt', 'md', 'markdown'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: '文本与 Markdown', extensions: ['txt', 'md', 'markdown'] },
      ],
    });
    if (selected.canceled || !selected.filePaths[0]) return { ok: false, canceled: true };
    assertGeneration();
    // The absolute source path originates only from the native dialog. The
    // renderer never supplies a filesystem path or project root.
    let reference;
    mutationLease = beginInternalMutation(project);
    try {
      reference = await referenceImportService.importReference(project.rootPath, selected.filePaths[0], {
        beforeCommit: assertGeneration,
      });
      // Defense in depth: service commit guards make stale imports zero-or-full;
      // Main still refuses to publish a result into a different project state.
      assertGeneration();
      const sidecar = projectService.readFileWithRevision(project.rootPath, reference.sidecarPath);
      rememberOwnMarkdownState(reference.sidecarPath, sidecar.revision);
    } finally {
      endInternalMutation(mutationLease, project);
    }
    invalidateProjectDerivedState();
    return {
      ok: true,
      reference,
      tree: projectService.listTree(project.rootPath),
      index: sourceIndexService.buildSourceIndex(project.rootPath),
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:build-source-index', async (event, projectInstanceId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，请重新建立来源索引');
    }
    return { ok: true, index: sourceIndexService.buildSourceIndex(project.rootPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:research', async (event, projectInstanceId, question, sourceIds) => {
  let admission = null;
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const mutationGeneration = projectMutationGeneration;
    admission = researchHandoffStore.admitRun({
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration,
      ...researchRendererOwner(event),
    });
    // Source Index is Main-owned authority. Renderer may submit only the
    // research question and IDs it selected from the public Sources view.
    const sourceIndex = sourceIndexService.buildSourceIndex(project.rootPath);
    const result = await researchService.research({
      projectService,
      rootPath: project.rootPath,
      question,
      sourceIds,
      sourceIndex,
      callLLM: projectCallLLM(project.instanceId),
    });
    if (!result.ok) {
      researchHandoffStore.failRun(admission);
      return result;
    }
    if (!currentProject || currentProject.rootPath !== project.rootPath || projectMutationGeneration !== mutationGeneration) {
      researchHandoffStore.failRun(admission);
      return { ok: false, error: 'PROJECT_CHANGED', message: '研究期间项目已变化，请重新生成证据卡片' };
    }
    const { canonicalRun, canonicalCards: _canonicalCards, cards: _legacyCards, ...publicResult } = result;
    const installed = researchHandoffStore.installRun(admission, canonicalRun);
    return { ...publicResult, cards: installed.cards };
  } catch (error) {
    if (admission) {
      try { researchHandoffStore.failRun(admission); } catch (_) {}
    }
    return projectFailure(error);
  }
});

function resolveResearchCardAuthority(project, projectInstanceId, cardId, owner) {
  const card = researchHandoffStore.resolveCardForOwner({
    projectInstanceId,
    rootPath: project.rootPath,
    cardId,
    ...owner,
  });
  const sourceIndex = sourceIndexService.buildSourceIndex(project.rootPath);
  const source = sourceIndex.sources.find(item => item.id === card.source.id);
  const grade = source ? researchService.gradeSource(source) : null;
  if (!source || source.filePath !== card.source.filePath || source.revision !== card.source.revision ||
      grade.grade !== card.source.grade || grade.rule !== card.source.gradeRule) {
    researchHandoffStore.discard({ projectInstanceId, rootPath: project.rootPath, cardId });
    throw new researchHandoffService.ResearchHandoffError('RESEARCH_HANDOFF_STALE', '来源已变化，请重新 Research');
  }
  const snapshot = projectService.readFileWithRevision(project.rootPath, source.filePath);
  const locator = card.source.locator;
  if (snapshot.revision !== card.source.revision || locator.end > snapshot.content.length ||
      snapshot.content.slice(locator.offset, locator.end) !== card.source.quote) {
    researchHandoffStore.discard({ projectInstanceId, rootPath: project.rootPath, cardId });
    throw new researchHandoffService.ResearchHandoffError('RESEARCH_HANDOFF_STALE', '原文位置已变化，请重新 Research');
  }
  return card;
}

ipcMain.handle('writcraft:project:resolve-research-card', async (event, projectInstanceId, cardId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    // Keep the real-Electron fixture asynchronous enough to exercise the
    // Renderer open-card → authoritative rerun race. Production never takes
    // this branch and the Renderer receives no knob for controlling it.
    if (isElectronAiFixture) {
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const card = resolveResearchCardAuthority(project, projectInstanceId, cardId, researchRendererOwner(event));
    return { ok: true, card };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:record-research-judgment', async (event, projectInstanceId, request) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const judgment = aiMetricsService.normalizeResearchJudgmentRequest(request);
    const owner = researchRendererOwner(event);
    return researchJudgmentTransaction.recordResearchJudgmentTransaction({
      hasActiveMutation: () => (internalMutationDepthByRoot.get(project.rootPath) || 0) > 0,
      busyError: () => new projectService.ProjectServiceError('PROJECT_BUSY', '项目正在提交其他修改，请稍后再记录判断'),
      advanceGeneration: advanceAiContextGeneration,
      getGeneration: () => projectMutationGeneration,
      beginLease: () => researchHandoffStore.beginJudgment({
        projectInstanceId, rootPath: project.rootPath, cardId: judgment.cardId, ...owner,
      }),
      resolveAuthority: () => resolveResearchCardAuthority(project, projectInstanceId, judgment.cardId, owner),
      pauseWatcher() {
        if (!currentProjectWatcher?.pauseAndFlush) {
          throw new projectService.ProjectServiceError('PROJECT_WATCHER_UNAVAILABLE', '项目监控不可用，未记录判断');
        }
        try { currentProjectWatcher.pauseAndFlush(); }
        finally { currentProjectWatcher = null; }
      },
      restartWatcher: () => restartProjectWatcher(project),
      fingerprint: () => publicContextFingerprint(project),
      changedError: reason => new projectService.ProjectServiceError(
        'PROJECT_CHANGED',
        reason === 'postcommit_context_changed'
          ? '判断记录后项目内容发生变化'
          : '项目内容已变化，未记录判断'
      ),
      recordMetric: beforeRename => aiMetricsService.recordResearchAccuracy(project.rootPath, judgment, { beforeRename }),
      finishLease: (lease, mutationGeneration) => researchHandoffStore.finishJudgment({
        projectInstanceId, rootPath: project.rootPath, cardId: judgment.cardId,
        leaseId: lease.leaseId, mutationGeneration, ...owner,
      }),
      abortLease: lease => researchHandoffStore.abortJudgment({
        projectInstanceId, rootPath: project.rootPath, cardId: judgment.cardId, leaseId: lease.leaseId,
      }),
      publishInvalidation: () => publishWatcherPayload(project, {
        schema: projectWatcher.EVENT_SCHEMA,
        reason: 'filesystem',
        changes: [{ path: null, kind: 'invalidated' }],
        emittedAt: new Date().toISOString(),
      }),
    });
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:handoff-research-card', async (event, projectInstanceId, request) => {
  let prepared = null;
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    const origin = captureAiProjectOrigin();
    prepared = researchHandoffService.prepareResearchHandoff({
      store: researchHandoffStore,
      projectService,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: projectMutationGeneration,
      ...researchRendererOwner(event),
      request,
      sourceIndex: sourceIndexService.buildSourceIndex(project.rootPath),
    });
    const model = await runAiRequest(project.instanceId, signal => callLLM(
      prepared.messages,
      'MiniMax-M3',
      minimaxTextService.MAX_MAX_TOKENS,
      signal
    ), prepared.signal);
    if (!isAiProjectOriginCurrent(origin)) {
      try {
        researchHandoffStore.cancel({
          projectInstanceId: project.instanceId,
          rootPath: project.rootPath,
          cardId: request?.cardId,
          ...researchRendererOwner(event),
        });
      } catch (_) {}
      return staleAiProjectResult();
    }
    return researchHandoffService.finalizeResearchHandoff({
      store: researchHandoffStore,
      prepared,
      projectService,
      rootPath: project.rootPath,
      sourceIndex: sourceIndexService.buildSourceIndex(project.rootPath),
      model,
      changeSetService,
      cacheReview(changeSet, metadata) {
        const capability = pendingChangeSets.allocateCapability();
        const researchDependencies = metadata.researchDependencies(capability);
        return cacheReviewedChangeSet(changeSet, project, {
          capability,
          researchDependencies,
          provenance: metadata.provenance,
        });
      },
      discardReview(capability) {
        pendingChangeSets.delete(capability, 'research-finalize-rollback');
      },
    });
  } catch (error) {
    if (prepared) {
      let dependenciesCurrent = false;
      try {
        dependenciesCurrent = researchHandoffService.validateResearchDependencies({
          store: researchHandoffStore,
          projectService,
          projectInstanceId: prepared.dependencies.projectInstanceId,
          rootPath: prepared.dependencies.rootPath,
          sourceIndex: () => sourceIndexService.buildSourceIndex(prepared.dependencies.rootPath),
          dependencies: prepared.dependencies,
        });
      } catch (_) {}
      try {
        researchHandoffStore.failure(
          prepared.request.cardId,
          prepared.leaseId,
          researchHandoffService.RETRYABLE_ERRORS.has(error?.code)
            ? error.code
            : 'RESEARCH_HANDOFF_FAILED',
          dependenciesCurrent
        );
      } catch (_) {}
    }
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:ack-research-review', async (event, projectInstanceId, cardId, changeSetId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    researchHandoffStore.ackReview({
      projectInstanceId,
      rootPath: project.rootPath,
      cardId,
      capability: changeSetId,
      ...researchRendererOwner(event),
    });
    return { ok: true };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:cancel-research-handoff', async (event, projectInstanceId, cardId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    return researchHandoffService.cancelResearchHandoff({
      store: researchHandoffStore,
      projectService,
      projectInstanceId,
      rootPath: project.rootPath,
      cardId,
      ...researchRendererOwner(event),
      sourceIndex: () => sourceIndexService.buildSourceIndex(project.rootPath),
    });
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:discard-research-card', async (event, projectInstanceId, cardId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
    researchHandoffStore.discard({ projectInstanceId, rootPath: project.rootPath, cardId });
    return { ok: true };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:generate-image', async (event, projectInstanceId, operationId, prompt, aspectRatio) => {
  let generationLease = null;
  let generationLeaseAcquired = false;
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，未生成配图');
    }
    const apiKey = resolveActiveApiKey();
    if (typeof operationId !== 'string' ||
        !imageReviewServiceModule.OPERATION_ID_RE.test(operationId)) {
      throw new imageReviewServiceModule.ImageReviewError(
        'IMAGE_REVIEW_ISSUE_INVALID',
        '图片生成操作身份无效'
      );
    }
    generationLease = `${project.instanceId}\0${project.rootPath}`;
    if (activeImageGenerations.has(generationLease)) {
      throw new imageReviewServiceModule.ImageReviewError(
        'IMAGE_REVIEW_PENDING',
        '当前项目已有图片正在生成或等待审阅'
      );
    }
    imageReviewHandler.assertCanIssue(event, project, operationId);
    activeImageGenerations.add(generationLease);
    generationLeaseAcquired = true;
    const mutationGeneration = projectMutationGeneration;
    const result = await runAiRequest(projectInstanceId, signal => imageGenerationService.generateAndSaveImage({
        rootPath: project.rootPath,
        prompt,
        aspectRatio,
        apiKey,
        signal,
        fetchImpl: electronAiFixture?.imageFetch,
        decodeImage(bytes) {
          const decoded = nativeImage.createFromBuffer(bytes);
          if (decoded.isEmpty()) return null;
          return decoded.getSize();
        },
        beforeCommit() {
          if (!currentProject || currentProject.rootPath !== project.rootPath ||
              currentProject.instanceId !== projectInstanceId || projectMutationGeneration !== mutationGeneration) {
            throw new imageGenerationService.ImageGenerationError(
              'PROJECT_CHANGED',
              '生成图片期间项目已变化，未保存图片'
            );
          }
          assertInlineRewriteMutationAvailable(project);
        },
      }));
    invalidateProjectDerivedState();
    const review = imageReviewHandler.issue(event, currentProject, operationId, result.image);
    return { ...result, review };
  } catch (error) {
    return projectFailure(error);
  } finally {
    if (generationLeaseAcquired) activeImageGenerations.delete(generationLease);
  }
});

ipcMain.handle('writcraft:project:settle-image-review', async (
  event,
  projectInstanceId,
  review,
  insertionProof
) => {
  try {
    const result = imageReviewHandler.settle(
      event,
      projectInstanceId,
      review,
      insertionProof
    );
    if (result.ok && result.decision === 'deleted' && !result.responseRecovered) {
      invalidateProjectDerivedState();
    }
    return result;
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:get-image-review-aggregate', async (
  event,
  projectInstanceId
) => {
  try {
    return {
      ok: true,
      aggregate: imageReviewHandler.aggregate(event, projectInstanceId),
    };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:get-image-trash', async (
  event,
  projectInstanceId
) => {
  try {
    requireCurrentProject();
    return imageTrashHandler.list(event, projectInstanceId);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:restore-image-trash', async (
  event,
  projectInstanceId,
  token
) => {
  try {
    requireMutableProject();
    return imageTrashHandler.restore(event, projectInstanceId, token);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:empty-image-trash', async (
  event,
  projectInstanceId,
  token
) => {
  try {
    requireMutableProject();
    return imageTrashHandler.empty(event, projectInstanceId, token);
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:record-ai-metric', async (event, projectInstanceId, metric) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    if (projectInstanceId !== project.instanceId) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，本次指标未记录');
    }
    aiMetricsService.appendEvent(project.rootPath, metric);
    return { ok: true, recorded: true };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:get-ai-metrics-aggregate', async (event, projectInstanceId) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    if (projectInstanceId !== project.instanceId) {
      throw new projectService.ProjectServiceError('PROJECT_CHANGED', '项目已切换，请重新读取协作回顾');
    }
    const document = aiMetricsService.loadMetrics(project.rootPath);
    const aggregate = aiMetricsService.aggregateMetrics(document);
    return { ok: true, aggregate };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:load-workspace', async (event) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, workspace: projectService.loadWorkspace(project.rootPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:save-workspace', async (event, workspace) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    return { ok: true, workspace: projectService.saveWorkspace(project.rootPath, workspace) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:write-recovery', async (event, relPath, content, baseRevision) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    return { ok: true, recovery: projectService.writeRecovery(project.rootPath, relPath, content, baseRevision) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:read-recovery', async (event, relPath) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, recovery: projectService.readRecovery(project.rootPath, relPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:list-recoveries', async (event) => {
  try {
    assertTrustedSender(event);
    const project = requireCurrentProject();
    return { ok: true, recoveries: projectService.listRecoveries(project.rootPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

ipcMain.handle('writcraft:project:clear-recovery', async (event, relPath) => {
  try {
    assertTrustedSender(event);
    const project = requireMutableProject();
    return { ok: true, ...projectService.clearRecovery(project.rootPath, relPath) };
  } catch (error) {
    return projectFailure(error);
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentProjectWatcher) {
    currentProjectWatcher.close();
    currentProjectWatcher = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
