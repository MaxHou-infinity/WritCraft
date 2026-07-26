#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const main = read('src/main/main.js');
const changesHistoryHandler = read('src/main/changes-history-handler.js');
const projectPlanHandler = read('src/main/project-plan-handler.js');
const projectOnboardingHandler = read('src/main/project-onboarding-handler.js');
const diagnosticExportHandler = read('src/main/diagnostic-export-handler.js');
const preload = read('src/main/preload.js');
const html = read('src/renderer/index.html');
const image = read('src/main/image-generation-service.js');
const chatContextRequest = read('src/main/chat-context-request-service.js');
const watcherHealthService = require('../src/main/project-watcher-health');
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function handler(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `${channel} handler missing`);
  if (channel === 'writcraft:project:propose-plan') {
    assert(main.slice(start, start + 320).includes('projectPlanHandler.createProposePlanHandler({'));
    return projectPlanHandler;
  }
  if (channel === 'writcraft:project:propose-onboarding') {
    assert(main.slice(start, start + 900).includes('projectOnboardingHandler.createProposeOnboardingHandler({'));
    return projectOnboardingHandler;
  }
  const next = main.indexOf('\nipcMain.handle(', start + 20);
  return main.slice(start, next < 0 ? main.length : next);
}

console.log('════════ WritCraft V0 · Main/renderer network boundary verify ════════');

test('watcher degraded gate is exact-project bound and clears only on reopen/success', () => {
  const health = watcherHealthService.createProjectWatcherHealth();
  const first = { instanceId: 'instance_a', rootPath: '/project' };
  const reopened = { instanceId: 'instance_a', rootPath: '/project' };
  health.markDegraded(first);
  assert.equal(health.isDegraded(first), true);
  assert.equal(health.isDegraded(reopened), true, 'same-root reopen keeps the stable binding degraded until restart');
  health.clear(reopened);
  assert.equal(health.isDegraded(reopened), false);
});

test('degraded watcher blocks every pre-model or direct-write bypass before side effects and reopen restores them', () => {
  const guardedRoutes = [
    ['writcraft:rewrite:apply', 'requireMutableProject()', 'inlineRewriteStore.beginApply'],
    ['writcraft:project:confirm-legacy-edit', 'assertInlineRewriteMutationAvailable(currentProject)', 'migrateLegacyEditFile'],
    ['writcraft:project:handoff-graph-issue', 'requireMutableProject()', 'indexProjectGraph'],
    ['writcraft:rewrite:reconciliation', 'assertProjectWatcherAvailable(project)', 'reconcileApplying'],
    ['writcraft:rewrite:reconciliation-clear', 'assertProjectWatcherAvailable(project)', 'inlineRewriteReconciliation.clear'],
  ];
  for (const [channel, gateName, firstWrite] of guardedRoutes) {
    const route = handler(channel);
    assert(route.includes(gateName), `${channel} lacks watcher gate`);
    assert(route.indexOf(gateName) < route.indexOf(firstWrite), `${channel} gates after ${firstWrite}`);
  }
  const health = watcherHealthService.createProjectWatcherHealth();
  const failed = { instanceId: 'instance_failed', rootPath: '/project' };
  const reopened = { instanceId: 'instance_failed', rootPath: '/project' };
  let writes = 0;
  const invokeMutation = project => {
    health.assertAvailable(project, () => Object.assign(new Error('reopen project'), {
      code: 'PROJECT_WATCHER_UNAVAILABLE',
    }));
    writes += 1;
  };
  health.markDegraded(failed);
  for (let index = 0; index < guardedRoutes.length; index += 1) {
    assert.throws(() => invokeMutation(failed), error => error.code === 'PROJECT_WATCHER_UNAVAILABLE');
  }
  assert.equal(writes, 0);
  health.clear(reopened);
  invokeMutation(reopened);
  assert.equal(writes, 1);
  health.markDegraded(reopened);
  health.clear(reopened);
  invokeMutation(reopened);
  assert.equal(writes, 2);
});

test('renderer CSP blocks every remote connection and remote embedded asset', () => {
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /media-src 'none'/);
  assert(!/img-src[^;]*https?:/.test(csp));
});

test('BrowserWindow session denies browser permissions and HTTP(S)/WebSocket before requests', () => {
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]{0,160}callback\(false\)/);
  assert.match(main, /setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(main, /onBeforeRequest\([\s\S]{0,260}'http:\/\/\*\/\*'[\s\S]{0,80}'https:\/\/\*\/\*'[\s\S]{0,80}'ws:\/\/\*\/\*'[\s\S]{0,80}'wss:\/\/\*\/\*'[\s\S]{0,180}cancel: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test('first-run key detection and API check require the trusted renderer sender', () => {
  assert.match(handler('writcraft:detect-key-type'), /assertTrustedSender\(event\)/);
  assert.match(handler('writcraft:check-api'), /assertTrustedSender\(event\)/);
});

test('diagnostic preview/export keeps content, paths and serialization authority in Main', () => {
  const diagnosticBridge = preload.slice(
    preload.indexOf('diagnostics: Object.freeze({'),
    preload.indexOf('\n  // 项目态', preload.indexOf('diagnostics: Object.freeze({'))
  );
  assert.match(preload, /diagnostics: Object\.freeze\(\{/);
  assert.match(preload, /preview: \(\) => ipcRenderer\.invoke\('writcraft:diagnostics:preview'\)/);
  assert.match(preload, /export: \(token\) => ipcRenderer\.invoke\('writcraft:diagnostics:export', \{\s*schema: 'writcraft\.diagnostic-export\/v1',\s*token,\s*\}\)/);
  assert.doesNotMatch(diagnosticBridge, /(?:filePath|serialized|content|rootPath)/);
  assert.match(handler('writcraft:diagnostics:preview'), /diagnosticExportHandler\.preview\(event\)/);
  assert.match(handler('writcraft:diagnostics:export'), /diagnosticExportHandler\.exportPreview\(event, request\)/);
  assert.match(diagnosticExportHandler, /async function preview\(event\) \{\s*assertTrustedSender\(event\)/);
  assert.match(diagnosticExportHandler, /async function exportPreview\(event, rawRequest\) \{\s*assertTrustedSender\(event\);\s*const request = exactRequest\(rawRequest\)/);
  assert.match(diagnosticExportHandler, /const selected = await showSaveDialog\(/);
  assert(diagnosticExportHandler.indexOf('const currentBinding = captureBinding(event)') <
    diagnosticExportHandler.indexOf('writeFile(selected.filePath, currentRecord.serialized)'));
});

test('rewrite/chat carry their origin project instance through the narrow preload bridge', () => {
  assert.match(preload, /rewrite: \(projectInstanceId, request\)/);
  assert.match(preload, /chat: \(projectInstanceId, userMessage, projectContext, contextRequest\)/);
  for (const channel of ['writcraft:rewrite', 'writcraft:chat']) {
    const block = handler(channel);
    assert(block.indexOf('matchesAiProjectOrigin(projectInstanceId)') < block.indexOf('callLLM('));
    assert(block.indexOf('callLLM(') < block.indexOf('isAiProjectOriginCurrent(origin)'));
  }
  assert.match(handler('writcraft:rewrite'), /inlineRewriteService\.prepareInlineRewrite/);
  assert.match(handler('writcraft:rewrite'), /prepared\.messages/);
  assert.match(handler('writcraft:rewrite'), /inlineRewriteService\.finalizeInlineRewrite/);
  assert.match(handler('writcraft:rewrite'), /inlineRewriteStore\.completeGeneration/);
  assert.doesNotMatch(handler('writcraft:rewrite'), /buildProjectContext|projectContext|rendererContext|\btext\s*,\s*style/);
  assert.match(main, /MAX_CHAT_MESSAGE_CHARS = 4000/);
  assert.match(main, /validateRendererContext\(projectContext, contextRequest\)/);
  assert.match(html, /id="chat-input"[^>]+maxlength="4000"/);
});

test('renderer context IPC is schema-checked and byte-bounded before project reads', () => {
  assert.match(main, /MAX_RENDERER_CONTEXT_BYTES = 64 \* 1024/);
  assert.match(chatContextRequest, /MAX_SELECTION_BYTES = 9 \* 1024/);
  assert.match(chatContextRequest, /MAX_EXCLUDED_IDS = 128/);
  assert.match(chatContextRequest, /REQUEST_KEYS = Object\.freeze\(\['schema', 'scope', 'message', 'currentFilePath', 'selection', 'contextPolicy'\]\)/);
  assert.match(chatContextRequest, /exactObject\(request, REQUEST_KEYS\)/);
  assert.match(preload, /resolveContext: \(projectInstanceId, request\)/);
  for (const channel of ['writcraft:chat', 'writcraft:project:resolve-context']) {
    const block = handler(channel);
    const validation = block.indexOf('validateRendererContext(');
    const projectRead = Math.max(block.indexOf('requireCurrentProject()'), block.indexOf('resolveProjectContext({'));
    assert(validation >= 0, `${channel} lacks context validation`);
    assert(projectRead < 0 || validation < projectRead, `${channel} validates context after project reads`);
  }
  const resolveBlock = handler('writcraft:project:resolve-context');
  assert(resolveBlock.indexOf('matchesAiProjectOrigin(projectInstanceId)') < resolveBlock.indexOf('requireCurrentProject()'));
  assert.match(handler('writcraft:chat'), /contextRequest\.message !== userMessage/);
});

test('every project AI generation handler rejects a foreign instance before model work', () => {
  for (const channel of [
    'writcraft:project:propose-plan',
    'writcraft:project:handoff-plan-task',
    'writcraft:project:propose-chapter',
    'writcraft:project:propose-onboarding',
    'writcraft:project:propose-edit-prompt-repair',
    'writcraft:project:propose-changes',
    'writcraft:project:research',
    'writcraft:project:generate-image',
  ]) {
    const block = handler(channel);
    const gate = block.indexOf('projectInstanceId !== project.instanceId');
    const model = Math.max(block.indexOf('projectCallLLM('), block.indexOf('generateAndSaveImage({'));
    assert(gate >= 0, `${channel} lacks origin gate`);
    assert(model < 0 || gate < model, `${channel} gates after model work`);
  }
  const handoff = handler('writcraft:project:handoff-plan-task');
  assert(handoff.indexOf('projectInstanceId !== project.instanceId') < handoff.indexOf('preparePlanTaskHandoff({'));
  assert(handoff.indexOf('preparePlanTaskHandoff({') < handoff.indexOf('callLLM('));
  assert(handoff.indexOf('callLLM(') < handoff.indexOf('isAiProjectOriginCurrent(origin)'));
  assert(handoff.indexOf('isAiProjectOriginCurrent(origin)') < handoff.indexOf('finalizePlanTaskHandoff({'));
  assert.match(main, /abortActiveAiRequests\(\)[\s\S]{0,500}request\.controller\.abort\(\)/);
  assert.match(main, /function advanceAiContextGeneration\(options = \{\}\) \{\s*abortActiveAiRequests\(\);\s*projectMutationGeneration \+= 1;\s*lastContextResponse = null;\s*pendingPlanRecords\.clear\(\);\s*invalidatePendingOnboardingReviews\(options\.preserveOnboardingChangeSetId \|\| null\);\s*\}/);
  assert.match(main, /function invalidateProjectDerivedState\(options = \{\}\) \{[\s\S]{0,300}advanceAiContextGeneration\(\{ preserveOnboardingChangeSetId: preserveChangeSetId \}\)/);
  const callMessages = main.slice(main.indexOf('minimaxTextService.callMessages({'), main.indexOf('});', main.indexOf('minimaxTextService.callMessages({')) + 3);
  for (const field of ['apiKey', 'messages', 'model', 'maxTokens', 'signal', 'fetchImpl: electronAiFixture?.textFetch']) {
    assert(callMessages.includes(field), `text call is missing ${field}`);
  }
});

test('Electron AI fixture is unreachable in packaged builds and has no renderer control surface', () => {
  assert.match(main, /const isElectronAiFixture = !app\.isPackaged && process\.env\.WRITCRAFT_E2E_AI_FIXTURE === '1'/);
  assert.match(main, /const electronAiFixture = isElectronAiFixture\s*\?/);
  assert.match(main, /electron-ai-provider'\)\)\.createElectronAiProvider\(\)[\s\S]{0,40}: null/);
  assert.strictEqual(preload.includes('WRITCRAFT_E2E_AI_FIXTURE'), false);
  assert.strictEqual(html.includes('WRITCRAFT_E2E_AI_FIXTURE'), false);
  assert.match(handler('writcraft:check-api'), /runApiHandshake\(\{[\s\S]{0,180}fetchImpl: electronAiFixture\?\.textFetch,[\s\S]{0,80}checkModels: minimaxTextService\.checkModels/);
});

test('authoritative project mutations abort in-flight AI and advance the generation', () => {
  assert.match(main, /function markdownStateMatchesOwnCommit\(/);
  assert.match(main, /function namedWatcherChangeAffectsAiContext\([\s\S]{0,180}markdownStateMatchesOwnCommit/);
  assert.match(main, /watcherInvalidationPolicy\.watcherPayloadAffectsAiContext\([\s\S]{0,260}namedWatcherChangeAffectsAiContext/);
  const watcherSetup = main.slice(main.indexOf('projectWatcher.createProjectWatcher('), main.indexOf('function invalidateProjectDerivedState'));
  assert(watcherSetup.includes('publishWatcherPayload(project, payload)'));
  assert.match(main, /for \(const item of pending\)[\s\S]{0,300}publishWatcherPayload\(project, item\);/);
  assert.strictEqual(main.includes('filterVerifiedInternalMetadataEcho'), false);
  assert.match(main, /function publicContextFingerprint\(project\)[\s\S]{0,700}readFileWithRevision\(project\.rootPath, node\.path\)[\s\S]{0,300}createHash\('sha256'\)/);
  assert.strictEqual(main.includes('deferredDuringInternalMutation'), false);
  assert.match(main, /beginInternalMutation\(project\)[\s\S]{0,700}referenceImportService\.importReference[\s\S]{0,700}endInternalMutation\(mutationLease, project\)/);
  assert.match(main, /internalMutationDepthByRoot/);
  assert.match(main, /function assertInlineRewriteMutationAvailable\(project\)[\s\S]{0,300}assertProjectWatcherAvailable\(project\)/);
  assert.match(main, /async function runAiRequest\(projectInstanceId[\s\S]{0,260}assertProjectWatcherAvailable\(currentProject\)/);
  assert.match(main, /function startProjectWatcher\(project\)[\s\S]{0,900}projectWatcherHealth\.clear\(project\)[\s\S]{0,180}projectWatcherHealth\.markDegraded\(project\)/);
  assert.match(main, /function restartProjectWatcher\(project\)[\s\S]{0,600}PROJECT_WATCHER_UNAVAILABLE/);
  const setCurrentProject = main.slice(main.indexOf('function setCurrentProject(project)'), main.indexOf('function invalidateProjectDerivedState'));
  assert(setCurrentProject.includes('projectWatcherHealth.reset()'));
  assert(setCurrentProject.includes('projectWatcherHealth.needsRecovery(project, Boolean(currentProjectWatcher))'));
  assert(setCurrentProject.indexOf('projectWatcherHealth.reset()') < setCurrentProject.indexOf('} else if (recoverSameProjectWatcher)'));
  assert(setCurrentProject.indexOf('} else if (recoverSameProjectWatcher)') < setCurrentProject.lastIndexOf('restartProjectWatcher(project)'));
  assert.match(handler('writcraft:project:apply-changes'), /changesHistoryHandler\.applyChanges\(projectInstanceId, decision\)/);
  assert(changesHistoryHandler.indexOf('const project = current(projectInstanceId)') <
    changesHistoryHandler.indexOf('assertMutationAvailable(project)'));
  assert.match(main, /MAX_OWN_WATCHER_STATES = 1024/);
  for (const channel of [
    'writcraft:project:write',
    'writcraft:project:overwrite-conflict',
    'writcraft:project:recreate-deleted',
    'writcraft:project:create-file',
    'writcraft:project:create-prompt',
    'writcraft:project:confirm-legacy-draft',
    'writcraft:project:apply-changes',
    'writcraft:project:undo-change',
    'writcraft:project:import-reference',
  ]) {
    let block = handler(channel);
    if (channel === 'writcraft:project:apply-changes') {
      block += main.slice(
        main.indexOf('function finalizeOrdinaryChanges('),
        main.indexOf('\nfunction finalizeChangesUndo(')
      );
    }
    if (channel === 'writcraft:project:undo-change') {
      block += main.slice(
        main.indexOf('function finalizeChangesUndo('),
        main.indexOf('\nconst changesHistoryHandler =')
      );
    }
    assert(/invalidateProjectDerivedState\(|lifecycleSuccess\(/.test(block), `${channel} does not invalidate AI context after commit`);
  }
});

test('unknown project errors are logged only through a bounded stable code', () => {
  assert.match(main, /\^\[A-Z\]\[A-Z0-9_\]\{0,63\}\$/);
  assert.match(main, /console\.error\('\[project\]', diagnosticCode\)/);
  assert.doesNotMatch(main, /console\.error\('\[project\]', error && error\.message/);
});

test('renderer console and load failures log stable codes without raw browser content', () => {
  assert.match(main, /webContents\.on\('console-message', \(_event, level\) =>/);
  assert.match(main, /console\.log\('\[renderer\]', code\)/);
  assert.doesNotMatch(main, /webContents\.on\('console-message', \(_event, level, message/);
  assert.match(main, /webContents\.on\('did-fail-load', \(\) =>/);
  assert.match(main, /console\.error\('\[renderer\]', 'RENDERER_LOAD_FAILED'\)/);
});

test('image generation fixes the official host and rejects redirects without retrying', () => {
  assert.match(image, /const ENDPOINT = 'https:\/\/api\.minimax\.io\/v1\/image_generation'/);
  assert.match(image, /redirect: 'error'/);
  assert.strictEqual((image.match(/request\(ENDPOINT/g) || []).length, 1);
  assert.match(image, /AbortController/);
  assert.match(image, /MAX_RESPONSE_CHARS/);
});

test('auth material remains Main-only and renderer source has no network primitive', () => {
  assert(!preload.includes('WRITCRAFT_MINIMAX_KEY'));
  assert(!preload.includes('Authorization'));
  assert(!preload.includes('x-api-key'));
  const rendererDir = path.join(root, 'src', 'renderer');
  const sourceFiles = fs.readdirSync(rendererDir)
    .filter(name => /\.(?:js|html)$/.test(name) && !['marked.umd.js', 'diff.min.js'].includes(name));
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(rendererDir, file), 'utf8');
    for (const forbidden of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\s*\(/, /\bEventSource\s*\(/, /sendBeacon\s*\(/]) {
      assert(!forbidden.test(source), `${file} exposes renderer network primitive ${forbidden}`);
    }
  }
});

console.log(`\n✅ Main/renderer network boundary ${passed}/${passed} checks passed.`);
