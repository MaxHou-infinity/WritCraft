'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
const navigationHandler = fs.readFileSync(path.join(root, 'src/main/writing-navigation-handler.js'), 'utf8');
const assistantWorkspace = fs.readFileSync(path.join(root, 'src/renderer/assistant-workspace.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function functionBlock(name, nextName) {
  const start = main.indexOf(`function ${name}`);
  const end = main.indexOf(`function ${nextName}`, start + 1);
  assert(start >= 0 && end > start, `${name} source block missing`);
  return main.slice(start, end);
}

console.log('\nWriting navigation Main/preload wiring verification');

test('trusted IPC uses the dedicated handler and abort-aware provider adapter', () => {
  assert.match(main, /ipcMain\.handle\('writcraft:project:propose-writing-navigation'/);
  assert.match(main, /writingNavigationHandlerService\.createWritingNavigationHandlers\(\{/);
  assert.match(main, /ipcMain\.handle\(\s*'writcraft:project:cancel-writing-navigation',\s*writingNavigationHandlers\.cancel/);
  assert.match(main, /projectCallLLM: writingNavigationProjectCallLLM/);
  assert.match(main, /createWritingNavigationProviderAdapter\(\{\s*runAiRequest,\s*callLLM,/);
  assert.match(preload, /proposeWritingNavigation: \(projectInstanceId, request, attemptId\) =>[\s\S]{0,220}'writcraft:project:propose-writing-navigation',[\s\S]{0,120}attemptId/);
  assert.match(preload, /cancelWritingNavigation: \(projectInstanceId, attemptId\) =>[\s\S]{0,220}'writcraft:project:cancel-writing-navigation',[\s\S]{0,120}attemptId/);
  assert(!/proposeWritingNavigation: \([^)]*(?:content|revision|rootPath)/.test(preload));
});

test('all Main-owned task snapshots have a narrow, cancellable preload path', () => {
  assert.match(main, /aiTaskStateService\.createAiTaskStateService\(\{/);
  assert.match(main, /ipcMain\.handle\('writcraft:ai-task:cancel'/);
  assert.match(main, /aiTaskState\.cancelByAttempt\(\{ projectInstanceId, attemptId \}\)/);
  assert.match(preload, /cancelAiTask: \(projectInstanceId, attemptId\) =>[\s\S]{0,150}'writcraft:ai-task:cancel'/);
  assert.match(navigationHandler, /ownerToken:\s*`navigation_\$\{lease\.attemptId\}`/);
});

test('non-navigation AI entrances declare a bounded task kind and target', () => {
  for (const kind of ['inline_rewrite', 'chat', 'graph_issue_handoff', 'project_changes', 'research_handoff', 'image_generation']) {
    assert.match(main, new RegExp(`kind: '${kind}'`), `${kind} task metadata missing`);
  }
  assert.match(main, /kind: kind \|\| 'project_llm'/);
  assert.match(main, /targetLocator: targetLocator \|\| \{ kind: 'project_llm' \}/);
});

test('context candidates are request-bound and Research receives Main-owned edit.md', () => {
  assert.match(main, /registerContextCatalog\(catalog\)/);
  assert.match(main, /resolveContextReferenceText\(userMessage\)/);
  assert.match(main, /referenceToken: `@ref:/);
  assert.match(main, /compiledProjectPrompt = contextResolverService\.compileEditPrompt/);
  assert.match(main, /projectPrompt: \{/);
});

test('opaque actions use one Main-owned handler plus bounded adjustment and source IDs', () => {
  assert.match(main, /ipcMain\.handle\('writcraft:project:run-writing-navigation-action'/);
  assert.match(main, /writingNavigationActionHandlerService\.createWritingNavigationActionHandler\(\{/);
  assert.match(main, /ipcMain\.handle\('writcraft:project:cancel-writing-navigation-action'/);
  assert.match(main, /createCancelWritingNavigationActionHandler\(\{/);
  assert.match(main, /changeSetService,\s*sourceIndexService,\s*pendingChangeSets,/);
  assert.match(preload, /runWritingNavigationAction: \(projectInstanceId, actionId, attemptId, adjustment = '', sourceIds = \[\]\) =>[\s\S]{0,260}'writcraft:project:run-writing-navigation-action',[\s\S]{0,180}sourceIds/);
  assert(!/runWritingNavigationAction: \([^)]*(?:content|revision|rootPath|suggestion)/.test(preload));
  assert.match(preload, /cancelWritingNavigationAction: \(projectInstanceId, actionId, attemptId\) =>[\s\S]{0,220}'writcraft:project:cancel-writing-navigation-action',[\s\S]{0,120}attemptId/);
});

test('renderer reload parks navigation while project mutation hard-invalidates it', () => {
  const rendererAdvance = functionBlock('advanceRendererNavigationEpoch()', 'invalidatePendingOnboardingReviews(');
  assert(rendererAdvance.includes('writingNavigationStore.parkProject({'));
  assert(rendererAdvance.indexOf('writingNavigationStore.parkProject({') <
    rendererAdvance.indexOf('rendererNavigationEpoch += 1;'));

  const mutationAdvance = functionBlock('advanceAiContextGeneration(options = {})', 'rememberOwnMarkdownState(');
  assert(mutationAdvance.includes('writingNavigationStore.invalidateProject({'));
  assert(mutationAdvance.indexOf('writingNavigationStore.invalidateProject({') <
    mutationAdvance.indexOf('projectMutationGeneration += 1;'));

  const switchBlock = functionBlock('setCurrentProject(project)', 'invalidateProjectDerivedState(');
  assert(switchBlock.includes('writingNavigationStore.parkProject({'));
  assert.match(main, /'writcraft:project:resume-writing-navigation',\s*writingNavigationHandlers\.resume/);
  assert.match(preload, /resumeWritingNavigation: projectInstanceId =>[\s\S]{0,180}'writcraft:project:resume-writing-navigation'/);
});

test('model protocol errors are mapped before generic safe-error passthrough', () => {
  const failure = functionBlock('projectFailure(error)', 'requireCurrentProject(');
  const navigationMap = failure.indexOf('publicWritingNavigationFailure(error)');
  const genericMessage = failure.indexOf('isSafeProjectError || isSafeDailyWorkspaceError');
  assert(navigationMap >= 0);
  assert(genericMessage > navigationMap);
  assert(failure.includes('writingNavigationHandoffService.WritingNavigationHandoffError'));
});

test('bounded cancellation stays cancelled instead of becoming generic task failure', () => {
  const run = functionBlock('runAiRequest(projectInstanceId, task, externalSignal = null, metadata = {})', 'researchRendererOwner(');
  assert(run.includes("if (result.error === 'REQUEST_ABORTED') taskHandle.cancel();"));
  assert.match(assistantWorkspace, /result\?\.error === 'REQUEST_ABORTED'\s*\? 'cancelled'/);
  assert.match(fs.readFileSync(path.join(root, 'src/main/writing-navigation-service.js'), 'utf8'),
    /error\.code === 'REQUEST_ABORTED'/);
});

console.log(`\n${passed}/${passed} writing-navigation Main/preload wiring checks passed.`);
