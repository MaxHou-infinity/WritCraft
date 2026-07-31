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

console.log('\nWriting structure Main/preload wiring verification');

test('four trusted IPC routes share one dedicated Main handler', () => {
  assert(main.includes(
    'writingStructureHandlerService.createWritingStructureHandlers({'
  ));
  for (const channel of [
    'prepare-writing-structure',
    'confirm-writing-structure',
    'query-writing-structure-recovery',
    'ack-writing-structure-recovery',
  ]) {
    assert(main.includes(`'writcraft:project:${channel}'`), `${channel} IPC missing`);
  }
  assert(main.includes('transaction: writingStructureTransaction'));
  assert(main.includes('assertMutationAvailable: assertInlineRewriteMutationAvailable'));
  assert(main.includes('assertCommitAvailable: assertWritingStructureRecoveryAvailable'));
  assert(main.includes('assertRecoveryAvailable: assertWritingStructureRecoveryAvailable'));
});

test('Main derives empty-project truth instead of accepting renderer authority', () => {
  const fingerprint = functionBlock(
    'writingStructureTreeFingerprint(project, tree)',
    'deriveWritingStructureAuthority(project)'
  );
  const derive = functionBlock(
    'deriveWritingStructureAuthority(project)',
    'beginInternalMutation(project)'
  );
  assert(fingerprint.includes('projectService.readFileWithRevision(project.rootPath, node.path)'));
  assert(fingerprint.includes("crypto.createHash('sha256')"));
  assert(derive.includes('projectService.listTree(project.rootPath)'));
  assert(derive.includes('writingNavigationService.markdownPaths(tree)'));
  assert(derive.includes('projectService.readFileWithRevision(project.rootPath, projectService.EDIT_FILE)'));
  assert(derive.includes('writingStructureTreeFingerprint(project, tree)'));
  assert(derive.includes('chaptersAbsent'));
  assert(derive.includes('emptyBody: bodyPaths.length === 0'));
});

test('structure recovery marker participates in every non-structure mutation guard', () => {
  const fullGuard = main.match(
    /const inlineRewriteMutationGuard =[\s\S]*?\n\}\);/
  )?.[0] || '';
  const inlineRecoveryGuard = main.match(
    /const inlineRewriteOnlyMutationGuard =[\s\S]*?\n\}\);/
  )?.[0] || '';
  const changesRecoveryGuard = main.match(
    /const changesHistoryOnlyMutationGuard =[\s\S]*?\n\}\);/
  )?.[0] || '';
  for (const block of [fullGuard, inlineRecoveryGuard, changesRecoveryGuard]) {
    assert(block.includes('readStructureMarker: readWritingStructureRecoveryMarker'));
  }
  const structureGuard = main.match(
    /const writingStructureRecoveryMutationGuard =[\s\S]*?\n  \}\);/
  )?.[0] || '';
  assert(structureGuard.includes('readMarker: rootPath => inlineRewriteReconciliation.read(rootPath)'));
  assert(structureGuard.includes('readChangesMarker: rootPath => changesHistoryTransaction.reconciliation.readMarker(rootPath)'));
  assert(!structureGuard.includes('readStructureMarker'));
  assert.match(
    main,
    /function readWritingStructureRecoveryMarker\(rootPath\) \{[\s\S]{0,260}hasPending\(rootPath\)[\s\S]{0,260}STRUCTURE_RECOVERY_CORRUPT/
  );
});

test('preload exposes only author edits for prepare and opaque IDs for mutation/recovery', () => {
  assert.match(
    preload,
    /prepareWritingStructure: \(projectInstanceId, navigationId, alternativeId, chapters\) =>[\s\S]{0,260}'writcraft:project:prepare-writing-structure'/
  );
  assert.match(
    preload,
    /confirmWritingStructure: capabilityId =>\s*ipcRenderer\.invoke\('writcraft:project:confirm-writing-structure', capabilityId\)/
  );
  assert.match(
    preload,
    /queryWritingStructureRecovery: projectInstanceId =>\s*ipcRenderer\.invoke\('writcraft:project:query-writing-structure-recovery', projectInstanceId\)/
  );
  assert.match(
    preload,
    /acknowledgeWritingStructureRecovery: \(projectInstanceId, operationId\) =>/
  );
  assert(!/confirmWritingStructure: \([^)]*(?:rootPath|files|content|revision)/.test(preload));
});

test('reload, mutation, project switch and public error mapping include structure authority', () => {
  const rendererAdvance = functionBlock(
    'advanceRendererNavigationEpoch()',
    'invalidatePendingOnboardingReviews('
  );
  const mutationAdvance = functionBlock(
    'advanceAiContextGeneration(options = {})',
    'rememberOwnMarkdownState('
  );
  const switchBlock = functionBlock('setCurrentProject(project)', 'invalidateProjectDerivedState(');
  for (const block of [rendererAdvance, mutationAdvance, switchBlock]) {
    assert(block.includes('writingStructureCapabilityStore.invalidateProject({'));
  }
  const failure = functionBlock('projectFailure(error)', 'requireCurrentProject(');
  assert(failure.includes('writingStructureService.WritingStructureError'));
  assert(failure.includes(
    'writingStructureCapabilityStoreService.WritingStructureCapabilityStoreError'
  ));
  assert(failure.includes('writingStructureHandlerService.WritingStructureHandlerError'));
  assert(failure.includes('writingStructureTransactionService.WritingStructureTransactionError'));
  assert(failure.includes('inlineRewriteMutationGuardService.WritingStructureMutationGuardError'));
});

console.log(`\n${passed}/${passed} writing-structure Main/preload wiring checks passed.`);
