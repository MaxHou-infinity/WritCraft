'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');

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

test('opaque actions use one Main-owned handler and the preload exposes no trusted content', () => {
  assert.match(main, /ipcMain\.handle\('writcraft:project:run-writing-navigation-action'/);
  assert.match(main, /writingNavigationActionHandlerService\.createWritingNavigationActionHandler\(\{/);
  assert.match(main, /ipcMain\.handle\('writcraft:project:cancel-writing-navigation-action'/);
  assert.match(main, /createCancelWritingNavigationActionHandler\(\{/);
  assert.match(main, /pendingChangeSets,\s*cacheReview: cacheReviewedChangeSet,/);
  assert.match(preload, /runWritingNavigationAction: \(projectInstanceId, actionId, attemptId\) =>[\s\S]{0,220}'writcraft:project:run-writing-navigation-action',[\s\S]{0,120}attemptId/);
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
  const genericMessage = failure.indexOf('isSafeProjectError && error.message');
  assert(navigationMap >= 0);
  assert(genericMessage > navigationMap);
  assert(failure.includes('writingNavigationHandoffService.WritingNavigationHandoffError'));
});

console.log(`\n${passed}/${passed} writing-navigation Main/preload wiring checks passed.`);
