'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

function route(source, name, nextName = null) {
  const start = source.indexOf(`ipcMain.handle('writcraft:project:${name}'`);
  assert(start >= 0, `missing ${name}`);
  const end = nextName
    ? source.indexOf(`ipcMain.handle('writcraft:project:${nextName}'`, start + 1)
    : source.indexOf("ipcMain.handle('writcraft:project:", start + 1);
  return source.slice(start, end > start ? end : source.length);
}

function extractedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return Function(`"use strict"; return (${source.slice(start, index + 1)});`)();
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const main = read('src/main/main.js');
const preload = read('src/main/preload.js');
const proposeRoute = route(main, 'propose-onboarding', 'confirm-onboarding-files');
const propose = read('src/main/project-onboarding-handler.js');
const confirm = route(main, 'confirm-onboarding-files', 'discard-onboarding-confirmation');
const discardConfirmation = route(main, 'discard-onboarding-confirmation', 'propose-edit-prompt-repair');
const apply = route(main, 'apply-changes', 'list-change-history');
const ordinaryApplyFinalizer = main.slice(
  main.indexOf('function finalizeOrdinaryChanges('),
  main.indexOf('\nfunction finalizeChangesUndo(')
);
const discardChanges = route(main, 'discard-changes', 'build-graph');
const finalizeOnboardingBatchCommit = extractedFunction(main, 'finalizeOnboardingBatchCommit');
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('\nProject onboarding v2 Main/preload integration verification');

check('Main owns authentic v2 proposal, capability and batch coordinator services', () => {
  assert(main.includes("require('./project-onboarding-v2-service')"));
  assert(main.includes("require('./onboarding-capability-store')"));
  assert(main.includes("require('./onboarding-batch-service')"));
  assert(main.includes("require('./project-onboarding-handler')"));
  assert(!main.includes("require('./project-onboarding-service')"));
  assert(main.includes('createOnboardingCapabilityStore()'));
  assert(main.includes('createOnboardingBatchService({'));
  assert(main.includes('capabilityStore: onboardingCapabilityStore'));
  assert(main.includes('bindingValidator: validateOnboardingBatchBinding'));
});

check('projectFailure recognizes every new fail-closed error family', () => {
  assert(main.includes('projectOnboardingV2Service.ProjectOnboardingV2Error'));
  assert(main.includes('onboardingCapabilityStoreService.OnboardingCapabilityError'));
  assert(main.includes('onboardingBatchService.OnboardingBatchError'));
});

check('propose accepts the exact v2 request and revalidates project generation after the model', () => {
  assert(propose.includes('async function proposeOnboardingHandler(event, projectInstanceId, request)'));
  assert(propose.includes('proposeProjectOnboardingV2({'));
  assert(propose.includes('request,'));
  assert(propose.includes('const mutationGeneration = getMutationGeneration()'));
  assert(propose.includes('const rendererNavigationEpoch = getRendererNavigationEpoch()'));
  assert(propose.includes('const currentProject = getCurrentProject()'));
  assert(propose.includes('currentProject.instanceId !== project.instanceId'));
  assert(propose.includes('getMutationGeneration() !== mutationGeneration'));
  assert(propose.includes('getRendererNavigationEpoch() !== rendererNavigationEpoch'));
  assert(propose.includes('生成期间项目状态或页面会话已变化，请重新整理项目卡'));
  assert.strictEqual((propose.match(/assertOnboardingFlowAvailable\(project\)/g) || []).length, 2);
  assert(propose.includes('capabilityStore.activeCountsByProject(project.instanceId, project.rootPath)'));
  assert(propose.includes("capabilityStore.hasActive(record.reviewId, 'review')"));
  assert(propose.includes("'ONBOARDING_PROPOSAL_IN_PROGRESS'"));
  assert(propose.includes('const proposalLease = acquireProposalLease(project)'));
  assert(propose.includes('releaseProposalLease(proposalLease)'));
  assert(propose.includes('proposalLeases.get(lease.key) === lease'));
  assert(proposeRoute.includes("projectOnboardingHandler.createProposeOnboardingHandler({"));
  for (const dependency of [
    'assertTrustedSender', 'requireCurrentProject', 'getCurrentProject: () => currentProject',
    'getMutationGeneration: () => projectMutationGeneration',
    'getRendererNavigationEpoch: () => rendererNavigationEpoch',
    'assertOnboardingFlowAvailable: onboardingAdmission.assertAvailable',
    'projectOnboardingV2Service', 'projectService', 'projectCallLLM',
    'onboardingCapabilityStore', 'cacheReviewedChangeSet', 'pendingChangeSets',
    'pendingOnboardingReviews', 'staleAiProjectResult', 'projectFailure',
  ]) assert(proposeRoute.includes(dependency), dependency);
});

check('renderer navigation, crash and destruction abort AI and advance the authority epoch', () => {
  assert(main.includes('function advanceRendererNavigationEpoch()'));
  const epochAdvance = main.slice(
    main.indexOf('function advanceRendererNavigationEpoch()'),
    main.indexOf('function invalidatePendingOnboardingReviews')
  );
  assert(epochAdvance.includes('abortActiveAiRequests()'));
  assert(epochAdvance.includes('rendererNavigationEpoch += 1'));
  assert(epochAdvance.includes('onboardingAdmission.invalidateProject(currentProject)'));
  for (const eventName of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    const start = main.indexOf(`mainWindow.webContents.on('${eventName}'`);
    assert(start >= 0, eventName);
    const end = main.indexOf('\n  });', start);
    const lifecycle = main.slice(start, end);
    assert(lifecycle.includes('advanceRendererNavigationEpoch()'), eventName);
  }
  assert(main.includes('researchHandoffStore.clearOwner(rendererOwnerId, rendererNavigationEpoch)'));
  assert(main.includes('inlineRewriteStore.clearOwner(inlineRewriteOwnerId, rendererNavigationEpoch)'));
});

check('changed proposals expose an ordinary review but never an onboarding token', () => {
  const changedStart = propose.indexOf('const cached = cacheReviewedChangeSet');
  const changed = propose.slice(changedStart);
  assert(changedStart >= 0);
  assert(changed.includes('onboardingCapabilityStore.createReview({'));
  assert(changed.includes('changeSetId: cached.capability'));
  assert(changed.includes('pendingOnboardingReviews.set(cached.capability'));
  assert(changed.includes("proposalKind: 'onboarding_v2'"));
  assert(!changed.includes('onboardingConfirmation:'));
  assert(!changed.includes('token,'));
});

check('no-op proposals mint an independent explicit confirmation', () => {
  const noOp = propose.slice(propose.indexOf('if (proposal.noChanges)'), propose.indexOf('const cached = cacheReviewedChangeSet'));
  assert(noOp.includes('onboardingCapabilityStore.createNoOp({'));
  assert(noOp.includes('baseEditRevision: proposal.contextManifest.targetRevision'));
  assert(noOp.includes('expectedAppliedRevision: proposal.contextManifest.targetAfterRevision'));
  assert(noOp.includes('onboardingConfirmation:'));
  assert(noOp.includes("source: 'no_op'"));
});

check('apply mints a review confirmation only after exact full edit.md application', () => {
  assert(apply.includes('changesHistoryHandler.applyChanges(projectInstanceId, decision)'));
  assert(ordinaryApplyFinalizer.includes('const onboardingFullyApplied = Boolean(onboardingReview) && !residualChangeSet'));
  assert(ordinaryApplyFinalizer.includes('applied.length === 1'));
  assert(ordinaryApplyFinalizer.includes('applied[0].path === projectService.EDIT_FILE'));
  assert(ordinaryApplyFinalizer.includes('applied[0].revision === onboardingReview.expectedAppliedRevision'));
  assert(ordinaryApplyFinalizer.includes('onboardingCapabilityStore.completeReview(onboardingReview.reviewId'));
  assert(ordinaryApplyFinalizer.includes('mutationGeneration: projectMutationGeneration'));
  assert(ordinaryApplyFinalizer.includes('appliedPaths: [projectService.EDIT_FILE]'));
  assert(ordinaryApplyFinalizer.includes('residual: false'));
});

check('post-commit capability failure remains an ok disk result with explicit unavailability', () => {
  assert(ordinaryApplyFinalizer.includes("error: 'ONBOARDING_CONFIRMATION_UNAVAILABLE'"));
  assert(ordinaryApplyFinalizer.includes('confirmationUnavailable:'));
  const onboardingTransition = ordinaryApplyFinalizer.indexOf('let onboardingTransition = {}');
  const finalTreeResult = ordinaryApplyFinalizer.indexOf('let treeResult = {}', onboardingTransition);
  assert(ordinaryApplyFinalizer.indexOf('onboardingCapabilityStore.completeReview') < finalTreeResult);
  assert(ordinaryApplyFinalizer.includes('...onboardingTransition'));
});

check('reject, residual, error, discard and project switch invalidate review authority', () => {
  assert(ordinaryApplyFinalizer.includes('invalidateOnboardingReview(changeSetId, onboardingReview)'));
  assert(ordinaryApplyFinalizer.includes('preserveOnboardingChangeSetId: onboardingFullyApplied ? changeSetId : null'));
  assert(discardChanges.includes('invalidateOnboardingReview(changeSetId)'));
  assert(main.includes('onboardingCapabilityStore.invalidateByProject(currentProject.instanceId, currentProject.rootPath)'));
  assert(main.includes('invalidatePendingOnboardingReviews(options.preserveOnboardingChangeSetId || null)'));
});

check('confirm binds token to current Main-owned project, generation, revision and digest', () => {
  assert(confirm.includes('assertTrustedSender(event)'));
  assert(confirm.includes('requireMutableProject()'));
  assert(confirm.includes('projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE)'));
  assert(confirm.includes('onboardingBatchCoordinator.confirmAndCreate({'));
  assert(confirm.includes('confirmationToken,'));
  assert(confirm.includes('projectInstanceId: project.instanceId'));
  assert(confirm.includes('rootPath: project.rootPath'));
  assert(confirm.includes('mutationGeneration: projectMutationGeneration'));
  assert(confirm.includes('editRevision: edit.revision'));
  assert(confirm.includes('proposalDigest,'));
  assert(confirm.includes('selectedPaths,'));
  assert(main.includes('function validateOnboardingBatchBinding(binding)'));
  assert(main.includes('projectMutationGeneration !== binding.mutationGeneration'));
  assert(main.includes('edit.revision === binding.editRevision'));
  assert(!preload.includes('bindingValidator'));
});

check('file confirmation is one leased all-or-nothing commit with honest tree refresh semantics', () => {
  assert(confirm.includes('const mutationLease = beginInternalMutation(project)'));
  assert(confirm.includes('return finalizeOnboardingBatchCommit(result, {'));
  assert(confirm.includes('remember: rememberOwnFileMutation'));
  assert(confirm.includes('invalidate: invalidateProjectDerivedState'));
  assert(confirm.includes('endMutation: () => endInternalMutation(mutationLease, project)'));
  assert(main.includes("warning: 'ONBOARDING_POST_COMMIT_REFRESH_REQUIRED'"));
  assert(main.includes('refreshRequired: true'));
  assert(main.includes('treeRefreshRequired: true'));
  assert(confirm.includes('onboardingCapabilityStore.invalidate(confirmationToken)'));
  for (const legacyField of ['editCommitted', 'partialSuccess', 'remainingSuggestions', 'remainingPaths', 'retryToken']) {
    assert(!confirm.includes(legacyField));
  }
  assert(!main.includes("writcraft:project:create-onboarding-files"));
});

check('every post-commit bookkeeping failure preserves ok:true and authoritative files', () => {
  const files = Object.freeze([Object.freeze({ path: 'chapters/01.md', revision: 'a'.repeat(64), bytes: 8 })]);
  const base = {
    remember() {}, invalidate() {}, endMutation() {}, listTree() { return [{ path: 'chapters/01.md' }]; },
    log() { throw new Error('logging must not alter commit truth'); },
  };
  const clean = finalizeOnboardingBatchCommit({ files }, base);
  assert.strictEqual(clean.ok, true);
  assert.strictEqual(clean.files, files);
  assert(Array.isArray(clean.tree));
  assert.strictEqual(clean.warning, undefined);

  const faults = [
    ['remember', 'WATCHER_STATE_REFRESH_FAILED'],
    ['invalidate', 'DERIVED_STATE_REFRESH_FAILED'],
    ['endMutation', 'MUTATION_LEASE_RELEASE_FAILED'],
    ['listTree', 'TREE_REFRESH_FAILED'],
  ];
  for (const [operation, expectedCode] of faults) {
    const operations = { ...base, [operation]: () => { throw new Error(`${operation} injected`); } };
    const result = finalizeOnboardingBatchCommit({ files }, operations);
    assert.strictEqual(result.ok, true, operation);
    assert.strictEqual(result.files, files, operation);
    assert.strictEqual(result.warning, 'ONBOARDING_POST_COMMIT_REFRESH_REQUIRED', operation);
    assert.strictEqual(result.refreshRequired, true, operation);
    assert(result.warningCodes.includes(expectedCode), operation);
    assert.strictEqual(result.treeRefreshRequired, operation === 'listTree' ? true : undefined, operation);
  }
});

check('confirmation discard is project-scoped and explicitly consumes the token', () => {
  assert(discardConfirmation.includes('assertTrustedSender(event)'));
  assert(discardConfirmation.includes('requireCurrentProject()'));
  assert(discardConfirmation.includes('onboardingCapabilityStore.invalidate(confirmationToken)'));
});

check('preload exposes only the narrow v2 onboarding bridge', () => {
  assert(preload.includes('proposeOnboarding: (projectInstanceId, request)'));
  assert(preload.includes('confirmOnboardingFiles: (projectInstanceId, token, proposalDigest, selectedPaths)'));
  assert(preload.includes('discardOnboardingConfirmation: (projectInstanceId, token)'));
  assert(!preload.includes('createOnboardingFiles:'));
  assert(!preload.includes('rootPath, token'));
  assert(!preload.includes('fileSuggestions) =>'));
});

console.log(`\n${passed}/${passed} project-onboarding v2 integration checks passed.`);
