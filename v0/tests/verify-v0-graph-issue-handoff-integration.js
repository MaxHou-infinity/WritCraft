#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
const changesHistoryHandler = fs.readFileSync(
  path.join(__dirname, '../src/main/changes-history-handler.js'),
  'utf8'
);
const graphView = fs.readFileSync(path.join(__dirname, '../src/renderer/graph-view.js'), 'utf8');
const changesView = fs.readFileSync(path.join(__dirname, '../src/renderer/changes-view.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

console.log('\nGraph Issue → Changes integration verification');

test('Main owns the complete re-indexed and reconciled identifier handoff', () => {
  assert(main.includes("require('./graph-issue-handoff-service')"));
  const start = main.indexOf("ipcMain.handle('writcraft:project:handoff-graph-issue'");
  const end = main.indexOf('// Project filesystem IPC', start);
  const route = main.slice(start, end);
  assert(start >= 0);
  assert(route.includes('assertTrustedSender(event)'));
  assert(route.includes('const project = requireMutableProject()'));
  assert(route.includes('projectInstanceId !== project.instanceId'));
  assert(route.includes('indexProjectGraph(projectService, project.rootPath)'));
  assert(route.includes('reconcileIssueStates(project.rootPath, indexed.graph.issues)'));
  assert(route.includes('prepareGraphIssueHandoff'));
  assert(route.includes('validateIssueDependencies'));
  assert(route.indexOf('validateIssueDependencies') > route.indexOf('await runAiRequest'));
  assert(route.includes('issueDependencies: prepared.dependencies'));
  assert(route.includes('requireCompleteDecision: true'));
  assert(route.includes("proposalKind: 'graph_issue'"));
  assert(route.includes('minimaxTextService.MAX_MAX_TOKENS'));
  assert(route.indexOf('requireMutableProject()') < route.indexOf('indexProjectGraph(projectService, project.rootPath)'));
  assert(route.indexOf('if (result.noChanges)') < route.indexOf('cacheReviewedChangeSet(result.changeSet, project,'));
});

test('apply revalidates active graph dependencies and enforces complete review in Main', () => {
  const validation = main.slice(main.indexOf('function validateOrdinaryChangesDependencies'),
    main.indexOf('\nfunction terminateOrdinaryChangesAuthority'));
  assert(validation.includes('if (pending.issueDependencies)'));
  assert(validation.includes('reconcileIssueStates(project.rootPath, indexed.graph.issues)'));
  assert(validation.includes('dependencies: pending.issueDependencies'));
  assert(changesHistoryHandler.includes('requireCompleteDecision: pending.requireCompleteDecision'));
  assert(changesHistoryHandler.indexOf('validateDependencies({') <
    changesHistoryHandler.indexOf('transaction.review({'));
  const begin = changesHistoryHandler.indexOf('onBegin()');
  assert(changesHistoryHandler.slice(begin, begin + 420).includes(
    "pendingChangeSets.delete(changeSetId, 'changes-history-begin')"
  ));
});

test('preload and Graph UI expose identifiers only, never issue prose as authority', () => {
  assert(preload.includes("handoffGraphIssue: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:handoff-graph-issue', projectInstanceId, request)"));
  assert(graphView.includes('issue.changesHandoff'));
  assert(graphView.includes('openGraphIssue?.(issue.changesHandoff)'));
  assert(!graphView.includes('openWithInstruction?.(`根据一致性问题'));
  assert(graphView.includes("['open', 'acknowledged'].includes(issue.status || 'open')"));
});

test('Renderer uses shared issue epoch, blocks unrelated pending review and exposes cancelable locked mode', () => {
  assert(changesView.includes("proposalTransactions?.begin('issue'"));
  assert(changesView.includes("mode: 'issue'"));
  assert(changesView.includes('if (pending)'));
  assert(changesView.includes('请先应用或丢弃，再处理星图问题'));
  assert(changesView.includes('星图问题专用审阅'));
  assert(changesView.includes('instruction.readOnly = Boolean(activeIssueRequest)'));
  assert(changesView.includes('proposalTransactions?.invalidate()'));
  assert(changesView.includes('leaveIssueMode'));
  assert(changesView.includes('issueModeLeaveButton.disabled = reviewCommitInFlight'));
  assert(changesView.includes("discard: (originProjectInstanceId, changeSetId) => bridge.discardChanges?.(originProjectInstanceId, changeSetId)"));
});

test('Graph Issue review cannot submit pending hunks and exits on every terminal lifecycle', () => {
  assert(changesView.includes('pending.requireCompleteDecision === true && Boolean(counts?.pending)'));
  assert(changesView.includes('请先处理全部修改块'));
  assert(changesView.includes('result.requireCompleteDecision !== true'));
  assert(changesView.includes('const completedIssue = completeIssueModeAfterReview()'));
  assert((changesView.match(/completeIssueModeAfterReview\(\)/g) || []).length >= 4);
  assert(changesView.includes('activeIssueRequest = null'));
  assert(changesView.includes("finishNoChanges('issue', result, metric)"));
  assert(changesView.includes('Boolean(result?.review) || Boolean(leakedCapability)'));
});

test('strict handoff parser loads before Changes view', () => {
  assert(html.includes('graph-issue-handoff-transaction.js'));
  assert(html.indexOf('graph-issue-handoff-transaction.js') < html.indexOf('changes-view.js'));
});

console.log(`\nGraph Issue handoff integration ${passed}/${passed} passed.`);
