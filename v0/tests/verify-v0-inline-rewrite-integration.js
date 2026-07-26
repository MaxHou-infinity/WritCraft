#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const blockAnchor = require('../src/renderer/block-anchor');
const contextService = require('../src/main/inline-rewrite-context-service');
const rewriteService = require('../src/main/inline-rewrite-service');
const storeService = require('../src/main/inline-rewrite-capability-store');
const applyServiceModule = require('../src/main/inline-rewrite-apply-service');
const mutationGuardService = require('../src/main/inline-rewrite-mutation-guard');
const changeSetService = require('../src/main/changeset-service');
const historyService = require('../src/main/change-history-service');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
const changesHistoryHandler = fs.readFileSync(
  path.join(ROOT, 'src/main/changes-history-handler.js'),
  'utf8'
);
let passed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error.stack || error.message}`); process.exitCode = 1; }
}

function handler(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `missing ${channel}`);
  const end = main.indexOf('\nipcMain.handle(', start + 20);
  return main.slice(start, end < 0 ? main.length : end);
}

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

console.log('\nInline Rewrite Main/preload integration verification');

test('generation seals Main authority and revalidates after the model before capability publication', () => {
  const route = handler('writcraft:rewrite');
  for (const fragment of [
    'assertTrustedSender(event)', 'inlineRewriteStore.beginGeneration(binding)',
    'inlineRewriteService.prepareInlineRewrite({', 'generation.signal',
    'inlineRewriteService.finalizeInlineRewrite({', 'mutationGeneration: projectMutationGeneration',
    'inlineRewriteStore.completeGeneration(generation.rewriteId, proposal)',
  ]) assert(route.includes(fragment), `missing ${fragment}`);
  assert(!route.includes('result.text'));
  assert(!route.includes('stylePrompts'));
});

test('ACK/discard/apply routes bind trusted BrowserWindow, project instance and one-time capability', () => {
  for (const [channel, call] of [
    ['writcraft:rewrite:ack', 'inlineRewriteStore.acknowledge'],
    ['writcraft:rewrite:discard', 'inlineRewriteStore.discard'],
    ['writcraft:rewrite:apply', 'inlineRewriteStore.beginApply'],
  ]) {
    const route = handler(channel);
    assert(route.includes('assertTrustedSender(event)'));
    assert(route.includes('project.instanceId !== projectInstanceId'));
    assert(route.includes('inlineRewriteBinding(event, project)'));
    assert(route.includes(call));
  }
  const apply = handler('writcraft:rewrite:apply');
  assert(apply.indexOf('inlineRewriteReconciliation.beginApply') < apply.indexOf('inlineRewriteApplyService.apply'));
  assert(apply.includes('inlineRewriteStore.finishApply(lease.rewriteId, lease.applyLeaseId, outcome.terminalState)'));
  assert(!/atomicWriteFile|writeFile\(/.test(apply));
});

test('navigation/project teardown revokes only pre-apply owner state and durable reconciliation remains queryable', () => {
  assert(main.includes('inlineRewriteStore.clearOwner(inlineRewriteOwnerId, rendererNavigationEpoch)'));
  assert(main.includes('inlineRewriteStore.clearOwner(`browserwindow:${mainWindow.id}`)'));
  const query = handler('writcraft:rewrite:reconciliation');
  assert(query.includes("marker?.state === 'applying'"));
  assert(query.includes("inlineRewriteStore.inspect(marker.rewriteId)?.state !== 'APPLYING'"));
  assert(query.includes('changeHistoryService.listHistory(project.rootPath)'));
  assert(query.includes("item.provenance?.kind === 'inline_rewrite'"));
});

test('every public project/History mutation route passes the Main recovery guard', () => {
  assert(main.includes("'PROJECT_WATCHER_UNAVAILABLE',"));
  assert(main.includes('error instanceof projectService.ProjectServiceError'));
  for (const channel of [
    'writcraft:project:write', 'writcraft:project:overwrite-conflict',
    'writcraft:project:recreate-deleted', 'writcraft:project:create-file',
    'writcraft:project:create-prompt', 'writcraft:project:rename-file',
    'writcraft:project:move-file', 'writcraft:project:trash-file',
    'writcraft:project:confirm-legacy-draft', 'writcraft:project:confirm-onboarding-files',
    'writcraft:project:build-graph', 'writcraft:project:apply-graph-correction',
    'writcraft:project:set-issue-status', 'writcraft:project:import-reference',
    'writcraft:project:generate-image', 'writcraft:project:record-ai-metric',
    'writcraft:project:save-workspace', 'writcraft:project:write-recovery',
    'writcraft:project:clear-recovery',
  ]) {
    assert(handler(channel).includes('requireMutableProject()'), `${channel} bypasses recovery guard`);
  }
  assert(handler('writcraft:project:apply-changes').includes(
    'changesHistoryHandler.applyChanges(projectInstanceId, decision)'
  ));
  assert(handler('writcraft:project:undo-change').includes(
    'changesHistoryHandler.undoChange(projectInstanceId, historyEntryId)'
  ));
  assert(changesHistoryHandler.indexOf('assertMutationAvailable(project);') <
    changesHistoryHandler.indexOf('transaction.review({'));
  assert(changesHistoryHandler.indexOf('assertMutationAvailable(project);',
    changesHistoryHandler.indexOf('function undoChange')) <
    changesHistoryHandler.indexOf('transaction.undo({'));
  const legacyEdit = handler('writcraft:project:confirm-legacy-edit');
  assert(legacyEdit.includes("typeof pending.rootPath !== 'string'"));
  assert(legacyEdit.includes('currentProject && currentProject.rootPath === pending.rootPath'));
  assert(legacyEdit.includes('assertInlineRewriteMutationAvailable(currentProject)'));
  assert(legacyEdit.indexOf('assertInlineRewriteMutationAvailable(currentProject)') < legacyEdit.indexOf('migrateLegacyEditFile'));
  assert(handler('writcraft:rewrite:apply').includes('requireMutableProject()'));
  assert(!handler('writcraft:rewrite:reconciliation').includes('requireMutableProject()'));
  assert(!handler('writcraft:rewrite:reconciliation-clear').includes('requireMutableProject()'));
  assert(handler('writcraft:rewrite:reconciliation').includes('assertProjectWatcherAvailable(project)'));
  assert(handler('writcraft:rewrite:reconciliation-clear').includes('assertProjectWatcherAvailable(project)'));
});

test('dynamic Main mutation guard fails closed for applying, terminal and unreadable markers', () => {
  let marker = null;
  const guard = mutationGuardService.createInlineRewriteMutationGuard({
    readMarker() {
      if (marker === 'throw') throw new Error('corrupt');
      return marker;
    },
  });
  assert.equal(guard.assertAvailable('/project'), true);
  for (const blocked of [
    { state: 'applying', rewriteId: 'ir_a' },
    { state: 'terminal', rewriteId: 'ir_b' },
    'throw',
  ]) {
    marker = blocked;
    assert.throws(() => guard.assertAvailable('/project'), error =>
      error.code === 'INLINE_REWRITE_RECOVERY_PENDING' && !error.message.includes('/project'));
  }
});

test('preload exposes only narrow rewrite lifecycle calls and never root/content authority', () => {
  for (const signature of [
    "rewrite: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:rewrite', projectInstanceId, request)",
    "ackRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:ack', projectInstanceId, payload)",
    "applyRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:apply', projectInstanceId, payload)",
    "discardRewrite: (projectInstanceId, payload) => ipcRenderer.invoke('writcraft:rewrite:discard', projectInstanceId, payload)",
  ]) assert(preload.includes(signature), `missing ${signature}`);
  assert(!preload.includes('rewrite: (rootPath'));
  assert(!preload.includes('applyRewrite: (projectInstanceId, content'));
});

test('dynamic preview → ACK → marker → apply → History → undo preserves exact manuscript truth', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-integration-'));
  try {
    const project = projectService.createProjectAt(scratch, 'Inline Integration');
    projectService.createMarkdownFile(project.rootPath, 'chapters/01.md');
    const before = '# 第一章\n\n这是一段需要精简的文字。\n';
    projectService.atomicWriteFile(project.rootPath, 'chapters/01.md', before);
    const start = before.indexOf('需要精简');
    const end = start + '需要精简'.length;
    const request = {
      schema: contextService.REQUEST_SCHEMA,
      currentFilePath: 'chapters/01.md',
      expectedRevision: revision(before),
      style: 'concise',
      selection: {
        startOffset: start,
        endOffset: end,
        proof: contextService.compactProof(blockAnchor.createBlockAnchor(before, 'chapters/01.md', start, end)),
      },
    };
    const binding = {
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      ownerId: 'browserwindow:1',
      navigationEpoch: 1,
    };
    const store = storeService.createInlineRewriteCapabilityStore();
    const generation = store.beginGeneration(binding);
    const prepared = rewriteService.prepareInlineRewrite({
      projectService, rootPath: project.rootPath, projectId: project.projectId,
      projectInstanceId: project.instanceId, mutationGeneration: 1, request,
      rewriteId: generation.rewriteId, expiresAt: generation.expiresAt,
    });
    const replacement = '精简';
    const proposal = rewriteService.finalizeInlineRewrite({
      prepared,
      model: {
        ok: true,
        text: JSON.stringify({ schema: rewriteService.RESULT_SCHEMA, replacement, summary: '精简表达' }),
        stopReason: 'end_turn', contentBlockCount: 1, textBlockCount: 1, nonTextBlockCount: 0,
      },
      projectService,
      changeSetService,
      mutationGeneration: 1,
    });
    const review = store.completeGeneration(generation.rewriteId, proposal);
    assert.equal(projectService.readFileWithRevision(project.rootPath, 'chapters/01.md').content, before);
    store.acknowledge(binding, {
      schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: review.rewriteId, capabilityId: review.capabilityId,
    });
    const reconciliation = rewriteService.createInlineRewriteReconciliationService();
    const lease = store.beginApply(binding, {
      schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: review.rewriteId, capabilityId: review.capabilityId,
    }, sealed => {
      const change = sealed.changeSet.changes[0];
      reconciliation.beginApply({
        rootPath: project.rootPath, projectId: project.projectId, rewriteId: sealed.rewriteId,
        path: change.path, beforeRevision: change.expectedRevision, expectedAfterRevision: revision(change.after),
      });
    });
    const applied = applyServiceModule.createInlineRewriteApplyService().apply({
      lease, projectService, rootPath: project.rootPath, projectId: project.projectId,
      projectInstanceId: project.instanceId, mutationGeneration: 1, reconciliationService: reconciliation,
    });
    store.finishApply(lease.rewriteId, lease.applyLeaseId, applied.terminalState);
    assert.equal(applied.result.status, 'applied');
    assert.equal(projectService.readFileWithRevision(project.rootPath, 'chapters/01.md').content,
      before.replace('需要精简', replacement));
    const entry = historyService.listHistory(project.rootPath)[0];
    assert.equal(entry.provenance.kind, 'inline_rewrite');
    assert.equal(entry.provenance.rewriteId, review.rewriteId);
    const undone = historyService.undoChange(projectService, project.rootPath, entry.id);
    assert.equal(undone.ok, true);
    assert.equal(projectService.readFileWithRevision(project.rootPath, 'chapters/01.md').content, before);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

if (!process.exitCode) console.log(`\n${passed}/${passed} Inline Rewrite integration checks passed.\n`);
