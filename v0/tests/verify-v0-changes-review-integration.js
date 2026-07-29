#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main/main.js');
const changesHistoryHandler = read('src/main/changes-history-handler.js');
const onboardingHandler = read('src/main/project-onboarding-handler.js');
const preload = read('src/main/preload.js');
const view = read('src/renderer/changes-view.js');
const workspace = read('src/renderer/workspace.js');
const html = read('src/renderer/index.html');

function handler(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `${channel} handler missing`);
  const end = main.indexOf('\nipcMain.handle(', start + 20);
  return main.slice(start, end < 0 ? main.length : end);
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

console.log('\nChanges review Main/Renderer integration verification');

test('every proposal caches a Main-created pc review and edit.md is whole-file protected', () => {
  assert(main.includes("require('./changeset-review-service')"));
  assert(main.includes('changeSetReviewService.createReview(changeSet, {'));
  assert(main.includes('pendingChangeSets.putWithCapability(capability, changeSet, project.rootPath, metadata)'));
  assert((main.match(/review: cached\.review/g) || []).length >= 4);
  assert(main.includes("fileSelectionPolicies[projectService.EDIT_FILE] = 'file'"));
  assert(onboardingHandler.includes(
    "cacheReviewedChangeSet(proposal.changeSet, project, { selectionPolicy: 'file' })"
  ));
  assert(main.includes('createProposeOnboardingHandler({'));
  assert(main.includes('cacheReviewedChangeSet,'));
});

test('apply IPC is project-bound, ID-only and preallocates a distinct residual capability', () => {
  const apply = handler('writcraft:project:apply-changes');
  assert.match(apply, /async \(event, projectInstanceId, decision\)/);
  assert(apply.indexOf('projectInstanceId !== project.instanceId') < apply.indexOf('pendingChangeSets.get(changeSetId)'));
  assert(apply.includes('changesHistoryHandler.applyChanges(projectInstanceId, decision)'));
  assert(changesHistoryHandler.indexOf('pendingChangeSets.allocateCapability()') <
    changesHistoryHandler.indexOf('transaction.review({'));
  assert(changesHistoryHandler.includes('reviewId: changeSetId'));
  assert(changesHistoryHandler.includes('residualReviewId: residualCapability'));
  assert(!apply.includes('selectedPaths'));
  assert.match(preload, /applyChanges: \(projectInstanceId, decision\) => ipcRenderer\.invoke\('writcraft:project:apply-changes', projectInstanceId, decision\)/);
});

test('pre-marker failures retain review; marker begin consumes it and success may publish residual', () => {
  assert(changesHistoryHandler.indexOf('validateDependencies({') <
    changesHistoryHandler.indexOf('transaction.review({'));
  const begin = changesHistoryHandler.indexOf('onBegin()');
  assert(begin >= 0);
  assert(changesHistoryHandler.slice(begin, begin + 420).includes(
    "pendingChangeSets.delete(changeSetId, 'changes-history-begin')"
  ));
  assert(changesHistoryHandler.includes('if (!result.ok)'));
  assert(changesHistoryHandler.includes('abortHiddenAuthority({ project, pending, changeSetId, result })'));
  assert(main.includes('const { residualChangeSet, ...publicResult } = result'));
  assert(main.includes('changeSetId: result.review?.changeSetId || null'));
  assert(main.includes('treeRefreshRequired: true'));
  const ordinaryResidual = main.indexOf('if (residualChangeSet) {');
  const onboardingTransition = main.indexOf('let onboardingTransition = {}', ordinaryResidual);
  assert(ordinaryResidual >= 0 && onboardingTransition > ordinaryResidual);
  assert(main.slice(ordinaryResidual, onboardingTransition).includes(
    'pendingChangeSets.putWithCapability('
  ));
});

test('discard is project-instance bound and verifies pending ownership before deletion', () => {
  const discard = handler('writcraft:project:discard-changes');
  assert.match(discard, /async \(event, projectInstanceId, changeSetId\)/);
  assert(discard.indexOf('projectInstanceId !== project.instanceId') < discard.indexOf('pendingChangeSets.get(changeSetId)'));
  assert(discard.indexOf('pending.rootPath !== project.rootPath') < discard.indexOf('pendingChangeSets.delete(changeSetId)'));
  assert.match(preload, /discardChanges: \(projectInstanceId, changeSetId\) => ipcRenderer\.invoke\('writcraft:project:discard-changes', projectInstanceId, changeSetId\)/);
});

test('Renderer begins pending, sends exact decisions, supports bulk/reset and continues residual in place', () => {
  assert(html.indexOf('changes-review-state.js') < html.indexOf('changes-view.js'));
  assert(view.includes('WritCraftChangesReviewState?.create?.(result.review)'));
  assert(view.includes("[['本文件全接受', 'accepted'], ['本文件全拒绝', 'rejected'], ['清除本文件决定', 'pending']]"));
  assert(view.includes('if (file.hunks.length > 1)'));
  assert(view.includes('State.updateFile(pending.reviewState, file.path, decision)'));
  assert(view.includes('WritCraftChangesReviewState?.toDecision?.(pending.reviewState)'));
  assert(view.includes('bridge.applyChanges(projectInstanceId, decision)'));
  assert(view.includes('if (result.review)'));
  assert(view.includes('pending.reviewState = nextState'));
  assert(view.includes('reviewCommitInFlight'));
  assert(view.includes('discardButton.disabled = controlsBusy'));
  assert(view.includes('if (planModeLeaveButton) planModeLeaveButton.disabled = reviewCommitInFlight'));
  assert(view.includes('if (reviewCommitInFlight || !activePlanRequest) return'));
  assert(view.includes('if (recoveryBlocked || historyUndoInFlight || !bridge?.undoChange'));
  assert(view.includes("historyList.querySelectorAll('.history-undo')"));
  assert(view.includes("preview.querySelectorAll('.change-decision, [data-onboarding-path]')"));
  assert(view.includes('pending.provenance = result.provenance || pending.provenance'));
  assert(view.includes("entry.kind === 'review'"));
  assert(html.includes('.change-hunk-card.is-accepted'));
  assert(html.includes('.change-hunk-card.is-rejected'));
});

test('Renderer routes apply, undo, bootstrap and manual recovery through one authority gate', () => {
  assert(html.indexOf('changes-history-recovery-transaction.js') < html.indexOf('workspace.js'));
  assert(html.includes('id="changes-recovery"'));
  assert(html.includes('data-action="restore_before"'));
  assert(html.includes('data-action="keep_after"'));
  assert(preload.includes('queryChangesHistoryRecovery: (projectInstanceId) =>'));
  assert(preload.includes('resolveChangesHistoryRecovery: (projectInstanceId, operationId, action) =>'));
  assert(preload.includes('clearChangesHistoryRecovery: (projectInstanceId, operationId) =>'));
  assert(view.includes("beginChangesHistoryMutation?.('正在应用并核对文件与修改历史…')"));
  assert(view.includes("reconcileChangesHistoryAfterMutation?.(\n        'apply'"));
  assert(view.includes("beginChangesHistoryMutation?.('正在撤销并核对文件与修改历史…')"));
  assert(view.includes("reconcileChangesHistoryAfterMutation?.(\n        'undo'"));
  assert(view.includes('resolveChangesHistoryRecovery?.(operationId, action)'));
  assert(view.includes('setRecoveryState: renderRecoveryState'));
  assert(view.includes('clearRecoveryState: () => renderRecoveryState(null)'));
  const enterStart = workspace.indexOf('async function enterProject(result)');
  const enterEnd = workspace.indexOf('\n  function closeProjectOnboarding()', enterStart);
  const enterProject = workspace.slice(enterStart, enterEnd);
  assert(enterProject.indexOf('reconcileChangesHistoryOnProjectEnter()') <
    enterProject.indexOf('reconcileInlineRewriteOnProjectEnter()'));
  assert(enterProject.indexOf('reconcileInlineRewriteOnProjectEnter()') <
    enterProject.indexOf('await loadEditContext()'));
});

console.log(`\nChanges review integration ${passed}/${passed} passed.`);
