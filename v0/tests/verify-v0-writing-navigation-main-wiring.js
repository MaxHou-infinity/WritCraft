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
  assert.match(main, /writingNavigationHandlerService\.createProposeWritingNavigationHandler\(\{/);
  assert.match(main, /projectCallLLM: writingNavigationProjectCallLLM/);
  assert.match(main, /createWritingNavigationProviderAdapter\(\{\s*runAiRequest,\s*callLLM,/);
  assert.match(preload, /proposeWritingNavigation: \(projectInstanceId, request\) =>\s*ipcRenderer\.invoke\('writcraft:project:propose-writing-navigation'/);
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

test('renderer reload and project mutation invalidate cached navigation authority', () => {
  const rendererAdvance = functionBlock('advanceRendererNavigationEpoch()', 'invalidatePendingOnboardingReviews(');
  assert(rendererAdvance.includes('writingNavigationStore.invalidateProject({'));
  assert(rendererAdvance.indexOf('writingNavigationStore.invalidateProject({') <
    rendererAdvance.indexOf('rendererNavigationEpoch += 1;'));

  const mutationAdvance = functionBlock('advanceAiContextGeneration(options = {})', 'rememberOwnMarkdownState(');
  assert(mutationAdvance.includes('writingNavigationStore.invalidateProject({'));
  assert(mutationAdvance.indexOf('writingNavigationStore.invalidateProject({') <
    mutationAdvance.indexOf('projectMutationGeneration += 1;'));

  const switchBlock = functionBlock('setCurrentProject(project)', 'invalidateProjectDerivedState(');
  assert(switchBlock.includes('writingNavigationStore.invalidateProject({'));
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
