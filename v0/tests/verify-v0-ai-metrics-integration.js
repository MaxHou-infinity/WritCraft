#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const metricsService = require('../src/main/ai-metrics-service');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
const transactionSource = fs.readFileSync(path.join(ROOT, 'src/main/research-judgment-transaction.js'), 'utf8');

let passed = 0;
function test(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function handler(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `${channel} handler missing`);
  const next = main.indexOf('\nipcMain.handle(', start + 20);
  return main.slice(start, next < 0 ? main.length : next);
}

function event(overrides = {}) {
  return {
    operationId: 'a'.repeat(32),
    action: 'inline_rewrite', outcome: 'accepted', style: 'polish', scope: 'selection',
    durationMs: 200, beforeChars: 10, afterChars: 12, ...overrides,
  };
}

console.log('════════ WritCraft V0 · AI metrics integration verify ════════');

test('Main 加载私有 metrics service 并将其错误映射为安全项目错误', () => {
  assert(main.includes("const aiMetricsService = require('./ai-metrics-service')"));
  assert(main.includes('error instanceof aiMetricsService.AiMetricsError'));
});

test('记录 IPC 校验可信 sender 和当前项目，仅传 Main 持有的 root', () => {
  const block = handler('writcraft:project:record-ai-metric');
  assert(block.includes('async (event, projectInstanceId, metric)'));
  assert(block.includes('assertTrustedSender(event)'));
  assert(block.includes('const project = requireMutableProject()'));
  assert(block.includes('projectInstanceId !== project.instanceId'));
  assert(block.includes('aiMetricsService.appendEvent(project.rootPath, metric)'));
  assert(block.includes('return { ok: true, recorded: true }'));
  assert(!block.includes('return { ok: true, event'));
  assert(!block.includes('document:'));
});

test('聚合 IPC 同样受项目约束且只返回 aggregate，不返回原始 document/events', () => {
  const block = handler('writcraft:project:get-ai-metrics-aggregate');
  assert(block.includes('async (event, projectInstanceId)'));
  assert(block.includes('assertTrustedSender(event)'));
  assert(block.includes('const project = requireCurrentProject()'));
  assert(block.includes('projectInstanceId !== project.instanceId'));
  assert(block.includes('aiMetricsService.loadMetrics(project.rootPath)'));
  assert(block.includes('aiMetricsService.aggregateMetrics(document)'));
  assert(block.includes('return { ok: true, aggregate }'));
  assert(!block.includes('return { ok: true, document'));
  assert(!block.includes('events:'));
});

test('preload 仅暴露 instance-bound record 与 aggregate，不接受 root 或指标文件路径', () => {
  assert(preload.includes("recordAiMetric: (projectInstanceId, metric) => ipcRenderer.invoke('writcraft:project:record-ai-metric', projectInstanceId, metric)"));
  assert(preload.includes("getAiMetricsAggregate: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:get-ai-metrics-aggregate', projectInstanceId)"));
  assert(!preload.includes('getAiMetricEvents'));
  assert(!preload.includes('loadAiMetrics'));
  assert(!preload.includes("ipcRenderer.invoke('writcraft:project:record-ai-metric', rootPath"));
  assert(!preload.includes('metrics.json'));
});

test('Research accuracy 使用独立 owner-bound Main IPC，通用指标入口不能绕过卡片权威', () => {
  const block = handler('writcraft:project:record-research-judgment');
  assert(block.includes('async (event, projectInstanceId, request)'));
  assert(block.includes('assertTrustedSender(event)'));
  assert(block.includes('const project = requireMutableProject()'));
  assert(block.includes('normalizeResearchJudgmentRequest(request)'));
  assert(block.includes('researchRendererOwner(event)'));
  assert(block.includes('resolveResearchCardAuthority('));
  assert(block.includes('recordResearchAccuracy(project.rootPath, judgment, { beforeRename })'));
  assert(block.includes('advanceGeneration: advanceAiContextGeneration'));
  assert(block.includes('researchHandoffStore.beginJudgment({'));
  assert(block.includes('currentProjectWatcher.pauseAndFlush()'));
  assert(block.includes('recordMetric: beforeRename =>'));
  assert(block.includes('restartProjectWatcher(project)'));
  assert(block.includes('researchHandoffStore.finishJudgment({'));
  assert(block.includes('internalMutationDepthByRoot.get(project.rootPath)'));
  assert(transactionSource.includes('handoffAvailable: false'));
  assert(transactionSource.includes('evidenceChanged: true'));
  assert(transactionSource.includes('Object.freeze({ ok: true, recorded: true, handoffAvailable: true, evidenceChanged: false })'));
  assert(preload.includes("recordResearchJudgment: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:record-research-judgment', projectInstanceId, request)"));
  const generic = handler('writcraft:project:record-ai-metric');
  assert(generic.includes('aiMetricsService.appendEvent(project.rootPath, metric)'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-ai-metrics-authority-'));
  try {
    fs.mkdirSync(path.join(directory, '.writcraft'));
    assert.throws(() => metricsService.appendEvent(directory, event({
      action: 'research_accuracy', outcome: 'matched', style: 'none', scope: 'project',
    })), error => error.code === 'INVALID_EVENT');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Research metrics 使用同步 stop/重验/rename/restart，不过滤任何 filename-less 事件', () => {
  const barrierStart = main.indexOf('function publicContextFingerprint(');
  const barrierEnd = main.indexOf('\nasync function runAiRequest(', barrierStart);
  const barrier = main.slice(barrierStart, barrierEnd);
  assert(barrier.includes("projectService.readFileWithRevision(project.rootPath, node.path)"));
  assert(barrier.includes("crypto.createHash('sha256')"));
  assert(!main.includes('filterVerifiedInternalMetadataEcho'));
  assert.match(main, /for \(const item of pending\)[\s\S]{0,300}publishWatcherPayload\(project, item\);/);
  const block = handler('writcraft:project:record-research-judgment');
  assert(block.includes('pauseWatcher()'));
  assert(block.includes('currentProjectWatcher.pauseAndFlush()'));
  assert(block.includes('restartWatcher: () => restartProjectWatcher(project)'));
  assert(block.includes('fingerprint: () => publicContextFingerprint(project)'));
  assert(block.includes('resolveAuthority: () => resolveResearchCardAuthority('));
  assert(!transactionSource.includes('await '), 'stop → rename → restart window must remain synchronous');
  const prepare = transactionSource.indexOf('fingerprintBefore = fingerprint()');
  const record = transactionSource.indexOf('recordMetric(() =>');
  const restart = transactionSource.indexOf('restartWatcher()');
  const postcheck = transactionSource.indexOf("throw changedError('postcommit_context_changed')");
  assert(prepare >= 0 && prepare < record && record < restart && restart < postcheck);
});

test('renderer 可达的聚合结果不含 events、正文、Prompt、Key 或路径字段', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-ai-metrics-integration-'));
  try {
    fs.mkdirSync(path.join(directory, '.writcraft'));
    metricsService.appendEvent(directory, event());
    metricsService.appendEvent(directory, event({ operationId: 'b'.repeat(32), outcome: 'rejected' }));
    const aggregate = metricsService.aggregateMetrics(metricsService.loadMetrics(directory));
    const serialized = JSON.stringify(aggregate);
    assert(!Object.prototype.hasOwnProperty.call(aggregate, 'events'));
    assert(!/chapter\.md|private-name\.md/.test(serialized));
    assert(!/content|prompt|apiKey|rootPath/i.test(serialized));
    assert.deepStrictEqual(Object.keys(aggregate).sort(), [
      'acceptanceRate', 'authorEvidence', 'byAction', 'decisionSampleNote', 'decisionSampleSize', 'decisionSmallSample',
      'durationMs', 'outcomes', 'rejectionRate', 'reviewDurationMs', 'sampleNote', 'sampleSize', 'smallSample',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('失败响应由统一 projectFailure 生成，不回显 metric payload', () => {
  for (const channel of ['writcraft:project:record-ai-metric', 'writcraft:project:get-ai-metrics-aggregate']) {
    const block = handler(channel);
    assert(block.includes('catch (error)'));
    assert(block.includes('return projectFailure(error)'));
    assert(!block.includes('message: error.message'));
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-ai-metrics-errors-'));
  try {
    fs.mkdirSync(path.join(directory, '.writcraft'));
    const secretAsKey = 'sk-api-secret-material';
    assert.throws(
      () => metricsService.appendEvent(directory, { ...event(), [secretAsKey]: true }),
      error => error.code === 'INVALID_EVENT' && !error.message.includes(secretAsKey),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (!process.exitCode) console.log(`\n✅ AI metrics integration ${passed}/${passed} 全过`);
