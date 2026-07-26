#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const metrics = require('../src/main/ai-metrics-service');

let passed = 0;
let operationSequence = 0;
function test(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function expectCode(code, run) {
  assert.throws(run, error => error instanceof metrics.AiMetricsError && error.code === code);
}

function root() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-ai-metrics-'));
  fs.mkdirSync(path.join(directory, '.writcraft'));
  fs.writeFileSync(path.join(directory, 'chapter.md'), '# 正文\n绝不能进入指标文件。\n');
  return directory;
}

function event(overrides = {}) {
  return {
    operationId: (++operationSequence).toString(16).padStart(32, '0'),
    action: 'inline_rewrite',
    outcome: 'accepted',
    style: 'polish',
    scope: 'selection',
    durationMs: 820,
    beforeChars: 120,
    afterChars: 132,
    ...overrides,
  };
}

function metricsPath(directory) {
  return path.join(directory, '.writcraft', 'metrics.json');
}

console.log('════════ WritCraft V0 · Private AI metrics verify ════════');

test('原子持久化严格 schema 且事件只含隐私安全 allowlist', () => {
  const directory = root();
  try {
    const now = new Date('2026-07-17T08:00:00.000Z');
    const result = metrics.appendEvent(directory, event(), { now });
    const persisted = JSON.parse(fs.readFileSync(metricsPath(directory), 'utf8'));
    assert.equal(persisted.schema, metrics.METRICS_SCHEMA);
    assert.deepStrictEqual(Object.keys(persisted.events[0]), [
      'operationId', 'action', 'outcome', 'style', 'scope', 'durationMs', 'beforeChars', 'afterChars', 'time',
    ]);
    assert.equal(persisted.events[0].time, now.toISOString());
    assert.deepStrictEqual(result.event, persisted.events[0]);
    assert.equal(fs.statSync(metricsPath(directory)).mode & 0o777, 0o600);
    assert(!fs.readdirSync(path.join(directory, '.writcraft')).some(name => name.endsWith('.tmp')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('正文、Prompt、API Key 或任何额外字段使整条事件 fail closed', () => {
  const directory = root();
  try {
    for (const forbidden of ['content', 'text', 'prompt', 'projectPrompt', 'apiKey', 'response']) {
      expectCode('INVALID_EVENT', () => metrics.appendEvent(directory, { ...event(), [forbidden]: 'sk-api-secret 正文' }));
    }
    assert.equal(fs.existsSync(metricsPath(directory)), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('action/outcome/style/scope 与数值全部严格有界', () => {
  const directory = root();
  try {
    for (const [field, value] of [
      ['action', 'chat'], ['outcome', 'clicked'], ['style', '用户的完整提示词'], ['scope', 'disk'],
      ['durationMs', -1], ['beforeChars', 1.5], ['afterChars', Number.MAX_SAFE_INTEGER],
    ]) expectCode('INVALID_EVENT', () => metrics.appendEvent(directory, event({ [field]: value })));
    assert.equal(fs.existsSync(metricsPath(directory)), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('指标不接收项目路径，operationId 严格且重复事件幂等', () => {
  const directory = root();
  try {
    expectCode('INVALID_EVENT', () => metrics.appendEvent(directory, event({ filePath: 'chapters/人物名.md' })));
    for (const bad of ['', 'short', 'z'.repeat(32), 'a'.repeat(64)]) expectCode('INVALID_EVENT', () => metrics.appendEvent(directory, event({ operationId: bad })));
    const input = event({ operationId: 'a'.repeat(32) });
    assert.equal(metrics.appendEvent(directory, input).duplicate, false);
    assert.equal(metrics.appendEvent(directory, input).duplicate, true);
    assert.equal(metrics.loadMetrics(directory).events.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('事件数量超限时只保留最新的有界窗口', () => {
  const directory = root();
  try {
    const seed = {
      schema: metrics.METRICS_SCHEMA,
      updatedAt: '2026-07-17T00:00:00.000Z',
      events: Array.from({ length: metrics.MAX_EVENTS }, (_, index) => ({
        ...event({ beforeChars: index, afterChars: index + 1 }),
        time: new Date(1720000000000 + index).toISOString(),
      })),
    };
    fs.writeFileSync(metricsPath(directory), JSON.stringify(seed));
    metrics.appendEvent(directory, event({ beforeChars: 9999, afterChars: 10000 }), { now: new Date('2026-07-17T09:00:00.000Z') });
    const loaded = metrics.loadMetrics(directory);
    assert.equal(loaded.events.length, metrics.MAX_EVENTS);
    assert.equal(loaded.events[0].beforeChars, 1);
    assert.equal(loaded.events.at(-1).beforeChars, 9999);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('损坏、旧 schema、未知持久化字段和超大文件全部拒绝覆盖', () => {
  const duplicate = { ...event({ operationId: 'd'.repeat(32) }), time: new Date().toISOString() };
  const cases = [
    ['{broken', 'METRICS_CORRUPT'],
    [JSON.stringify({ schema: 'writcraft.ai-metrics/v0', updatedAt: new Date().toISOString(), events: [] }), 'INVALID_METRICS_FILE'],
    [JSON.stringify({ schema: metrics.METRICS_SCHEMA, updatedAt: new Date().toISOString(), events: [], prompt: 'secret' }), 'INVALID_METRICS_FILE'],
    [JSON.stringify({ schema: metrics.METRICS_SCHEMA, updatedAt: new Date().toISOString(), events: [duplicate, duplicate] }), 'INVALID_METRICS_FILE'],
    ['x'.repeat(metrics.MAX_METRICS_BYTES + 1), 'METRICS_TOO_LARGE'],
  ];
  for (const [body, code] of cases) {
    const directory = root();
    try {
      fs.writeFileSync(metricsPath(directory), body);
      expectCode(code, () => metrics.appendEvent(directory, event()));
      assert.equal(fs.readFileSync(metricsPath(directory), 'utf8'), body);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test('metrics.json 符号链接会阻止读取和写入且不触碰外部目标', () => {
  const directory = root();
  const outside = path.join(os.tmpdir(), `writcraft-metrics-outside-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(outside, 'external sentinel');
    fs.symlinkSync(outside, metricsPath(directory));
    expectCode('UNSAFE_METRICS_PATH', () => metrics.loadMetrics(directory));
    expectCode('UNSAFE_METRICS_PATH', () => metrics.appendEvent(directory, event()));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'external sentinel');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch (_) {}
  }
});

test('.writcraft 目录符号链接会在创建 metrics.json 前 fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-metrics-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-metrics-target-'));
  try {
    fs.symlinkSync(outside, path.join(directory, '.writcraft'));
    expectCode('UNSAFE_METRICS_PATH', () => metrics.appendEvent(directory, event()));
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('原子替换失败不会破坏旧指标且会清理临时文件', () => {
  const directory = root();
  try {
    metrics.appendEvent(directory, event(), { now: new Date('2026-07-17T08:00:00.000Z') });
    const before = fs.readFileSync(metricsPath(directory), 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated rename failure'); };
    try { assert.throws(() => metrics.appendEvent(directory, event({ outcome: 'rejected' }))); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(metricsPath(directory), 'utf8'), before);
    assert(!fs.readdirSync(path.join(directory, '.writcraft')).some(name => name.endsWith('.tmp')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('聚合接受率、拒绝率与耗时口径稳定，小样本明确提示', () => {
  const events = [
    event({ action: 'inline_rewrite', outcome: 'generated', durationMs: 100 }),
    event({ action: 'inline_rewrite', outcome: 'accepted', durationMs: 300 }),
    event({ action: 'changeset', outcome: 'generated', scope: 'multi_file', durationMs: 200 }),
    event({ action: 'plan', outcome: 'failed', scope: 'project', style: 'none', durationMs: 1000 }),
  ].map((item, index) => ({ ...item, time: new Date(1720000000000 + index).toISOString() }));
  const aggregate = metrics.aggregateMetrics(events);
  assert.equal(aggregate.sampleSize, 4);
  assert.equal(aggregate.smallSample, true);
  assert.match(aggregate.sampleNote, /少于 20/);
  assert.equal(aggregate.decisionSampleSize, 1);
  assert.equal(aggregate.decisionSmallSample, true);
  assert.match(aggregate.decisionSampleNote, /决策样本少于 20/);
  assert.equal(aggregate.acceptanceRate, 1);
  assert.equal(aggregate.rejectionRate, 0);
  assert.deepStrictEqual(aggregate.durationMs, { average: 433, median: 200, p95: 1000 });
  assert.deepStrictEqual(aggregate.reviewDurationMs, { average: 300, median: 300, p95: 300 });
  assert.equal(aggregate.outcomes.generated, 2);
  assert.equal(aggregate.outcomes.failed, 1);
  assert.equal(aggregate.byAction.inline_rewrite.acceptanceRate, 1);
  assert.equal(aggregate.byAction.inline_rewrite.decisionSmallSample, true);
  assert.equal(aggregate.byAction.plan.acceptanceRate, null);
});

test('达到样本阈值后取消小样本标记，无决策样本时比例保持 null', () => {
  const events = Array.from({ length: metrics.SMALL_SAMPLE_THRESHOLD }, (_, index) => ({
    ...event({ action: 'plan', outcome: 'generated', scope: 'project', style: 'none', durationMs: index }),
    time: new Date(1720000000000 + index).toISOString(),
  }));
  const aggregate = metrics.aggregateMetrics(events);
  assert.equal(aggregate.smallSample, false);
  assert.equal(aggregate.sampleNote, null);
  assert.equal(aggregate.decisionSmallSample, true);
  assert.match(aggregate.decisionSampleNote, /决策样本少于 20/);
  assert.equal(aggregate.acceptanceRate, null);
  assert.equal(aggregate.rejectionRate, null);
});

test('旧 v1 文件可继续读取并追加新的隐私安全 workflow 事件', () => {
  const directory = root();
  try {
    const legacy = {
      schema: 'writcraft.ai-metrics/v1',
      updatedAt: '2026-07-17T00:00:00.000Z',
      events: [{
        ...event({ operationId: '1'.repeat(32), action: 'inline_rewrite', outcome: 'accepted' }),
        time: '2026-07-17T00:00:00.000Z',
      }],
    };
    fs.writeFileSync(metricsPath(directory), JSON.stringify(legacy));
    metrics.appendEvent(directory, event({
      operationId: '2'.repeat(32), action: 'image', outcome: 'generated', style: 'none', scope: 'file',
    }));
    const loaded = metrics.loadMetrics(directory);
    assert.equal(loaded.schema, 'writcraft.ai-metrics/v1');
    assert.deepStrictEqual(loaded.events.map(item => item.action), ['inline_rewrite', 'image']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('作者证据聚合区分 workflow 并关联 Onboarding 人工重试结果', () => {
  const at = index => new Date(1720000100000 + index).toISOString();
  const records = [
    event({ operationId: 'a'.repeat(32), action: 'onboarding', outcome: 'retried', style: 'none', scope: 'project' }),
    event({ operationId: 'a'.repeat(32), action: 'onboarding', outcome: 'generated', style: 'none', scope: 'project' }),
    event({ operationId: 'b'.repeat(32), action: 'onboarding', outcome: 'structured_failed', style: 'none', scope: 'project' }),
    event({ operationId: 'f'.repeat(32), action: 'onboarding', outcome: 'retried', style: 'none', scope: 'project' }),
    event({ operationId: 'f'.repeat(32), action: 'onboarding', outcome: 'structured_failed', style: 'none', scope: 'project' }),
    event({ operationId: 'c'.repeat(32), action: 'image', outcome: 'generated', style: 'none', scope: 'file' }),
    event({ operationId: 'c'.repeat(32), action: 'image', outcome: 'accepted', style: 'none', scope: 'file' }),
    event({ operationId: 'd'.repeat(32), action: 'plan_task', outcome: 'accepted', style: 'none', scope: 'multi_file' }),
    event({ operationId: 'e'.repeat(32), action: 'research', outcome: 'rejected', style: 'none', scope: 'multi_file' }),
    event({ operationId: '9'.repeat(32), action: 'plan', outcome: 'generated', style: 'none', scope: 'project' }),
    event({ operationId: '8'.repeat(32), action: 'plan', outcome: 'failed', style: 'none', scope: 'project' }),
  ].map((item, index) => ({ ...item, time: at(index) }));
  const aggregate = metrics.aggregateMetrics(records);
  assert.equal(aggregate.authorEvidence.onboarding.attempts, 3);
  assert.equal(aggregate.authorEvidence.onboarding.failureRate, 2 / 3);
  assert.equal(aggregate.authorEvidence.onboarding.retries, 2);
  assert.equal(aggregate.authorEvidence.onboarding.retryResults, 2);
  assert.equal(aggregate.authorEvidence.onboarding.retrySuccessRate, 0.5);
  assert.equal(aggregate.authorEvidence.onboarding.structuredFailures, 2);
  assert.equal(aggregate.authorEvidence.onboarding.structuredFailureRate, 2 / 3);
  assert.equal(aggregate.authorEvidence.image.acceptanceRate, 1);
  assert.equal(aggregate.authorEvidence.planTask.acceptanceRate, 1);
  assert.equal(aggregate.authorEvidence.planRun.attempts, 2);
  assert.equal(aggregate.authorEvidence.planRun.failureRate, 0.5);
  assert.equal(aggregate.authorEvidence.research.acceptanceRate, 0);
  assert.deepStrictEqual(aggregate.authorEvidence.researchAccuracy, {
    sampleSize: 0, matched: 0, mismatched: 0, matchRate: null, smallSample: true,
    sampleNote: 'Research 判断样本少于 20，匹配率仅供方向参考',
    note: '作者对 AI 主张与当次来源摘录是否匹配的判断，不是来源真实性、权威性或平台事实评分。',
  });
});

test('Research 判断请求严格 schema 且普通指标入口不能伪造准确率', () => {
  const cardId = `rc_${'a'.repeat(32)}`;
  assert.deepStrictEqual(metrics.normalizeResearchJudgmentRequest({
    schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'matched',
  }), { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'matched' });
  for (const request of [
    null,
    { schema: 'writcraft.research-judgment/v0', cardId, verdict: 'matched' },
    { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId: 'rc_short', verdict: 'matched' },
    { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'unknown' },
    { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'matched', claim: '正文' },
  ]) expectCode('INVALID_RESEARCH_JUDGMENT', () => metrics.normalizeResearchJudgmentRequest(request));
  const directory = root();
  try {
    expectCode('INVALID_EVENT', () => metrics.appendEvent(directory, event({
      action: 'research_accuracy', outcome: 'matched', style: 'none', scope: 'project',
    })));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Research 同卡同判断幂等，改判断原子替换且磁盘不含 cardId 或证据内容', () => {
  const directory = root();
  const cardId = `rc_${'b'.repeat(32)}`;
  try {
    const matched = { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'matched' };
    assert.equal(metrics.recordResearchAccuracy(directory, matched, { now: new Date('2026-07-22T01:00:00.000Z') }).duplicate, false);
    assert.equal(metrics.recordResearchAccuracy(directory, matched, { now: new Date('2026-07-22T02:00:00.000Z') }).duplicate, true);
    const corrected = metrics.recordResearchAccuracy(directory, { ...matched, verdict: 'mismatched' }, {
      now: new Date('2026-07-22T03:00:00.000Z'),
    });
    assert.equal(corrected.replaced, true);
    const persisted = JSON.parse(fs.readFileSync(metricsPath(directory), 'utf8'));
    assert.equal(persisted.events.length, 1);
    assert.deepStrictEqual(persisted.events[0], {
      operationId: 'b'.repeat(32), action: 'research_accuracy', outcome: 'mismatched',
      style: 'none', scope: 'project', durationMs: 0, beforeChars: 0, afterChars: 0,
      time: '2026-07-22T03:00:00.000Z',
    });
    const disk = fs.readFileSync(metricsPath(directory), 'utf8');
    assert(!disk.includes('rc_'));
    assert(!/cardId|claim|quote|filePath|chapter\.md|绝不能进入指标文件/.test(disk));
    assert(!fs.readdirSync(path.join(directory, '.writcraft')).some(name => name.endsWith('.tmp')));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Research 改判写入失败保留旧样本，损坏文件与冲突双样本均拒绝覆盖', () => {
  const directory = root();
  const cardId = `rc_${'f'.repeat(32)}`;
  const request = { schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId, verdict: 'matched' };
  try {
    metrics.recordResearchAccuracy(directory, request, { now: new Date('2026-07-22T04:00:00.000Z') });
    const before = fs.readFileSync(metricsPath(directory), 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('simulated correction rename failure'); };
    try { assert.throws(() => metrics.recordResearchAccuracy(directory, { ...request, verdict: 'mismatched' })); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(metricsPath(directory), 'utf8'), before);
    assert(!fs.readdirSync(path.join(directory, '.writcraft')).some(name => name.endsWith('.tmp')));

    const stored = JSON.parse(before);
    stored.events.push({ ...stored.events[0], outcome: 'mismatched', time: '2026-07-22T05:00:00.000Z' });
    const conflicting = JSON.stringify(stored);
    fs.writeFileSync(metricsPath(directory), conflicting);
    expectCode('INVALID_METRICS_FILE', () => metrics.recordResearchAccuracy(directory, request));
    assert.equal(fs.readFileSync(metricsPath(directory), 'utf8'), conflicting);

    fs.writeFileSync(metricsPath(directory), '{broken');
    expectCode('METRICS_CORRUPT', () => metrics.recordResearchAccuracy(directory, request));
    assert.equal(fs.readFileSync(metricsPath(directory), 'utf8'), '{broken');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Research 提交边界重验失败零样本，通用 appendEvent 不开放提交钩子', () => {
  const directory = root();
  const request = {
    schema: metrics.RESEARCH_JUDGMENT_SCHEMA,
    cardId: `rc_${'7'.repeat(32)}`,
    verdict: 'matched',
  };
  try {
    assert.throws(() => metrics.recordResearchAccuracy(directory, request, {
      beforeRename() {
        fs.appendFileSync(path.join(directory, 'chapter.md'), '提交前来源变化\n');
        const error = new Error('stale authority');
        error.code = 'RESEARCH_HANDOFF_STALE';
        throw error;
      },
    }), /stale authority/);
    assert.equal(fs.existsSync(metricsPath(directory)), false);
    assert(!fs.readdirSync(path.join(directory, '.writcraft')).some(name => name.endsWith('.tmp')));

    let genericHookCalled = false;
    metrics.appendEvent(directory, event({ operationId: '6'.repeat(32) }), {
      beforeRename() { genericHookCalled = true; },
    });
    assert.equal(genericHookCalled, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Research 准确率独立聚合且不污染全局接受率与审阅耗时', () => {
  const directory = root();
  try {
    metrics.appendEvent(directory, event({ operationId: 'c'.repeat(32), outcome: 'accepted', durationMs: 900 }));
    metrics.recordResearchAccuracy(directory, {
      schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId: `rc_${'d'.repeat(32)}`, verdict: 'matched',
    });
    metrics.recordResearchAccuracy(directory, {
      schema: metrics.RESEARCH_JUDGMENT_SCHEMA, cardId: `rc_${'e'.repeat(32)}`, verdict: 'mismatched',
    });
    const aggregate = metrics.aggregateMetrics(metrics.loadMetrics(directory));
    assert.equal(aggregate.decisionSampleSize, 1);
    assert.equal(aggregate.acceptanceRate, 1);
    assert.deepStrictEqual(aggregate.reviewDurationMs, { average: 900, median: 900, p95: 900 });
    assert.deepStrictEqual(aggregate.authorEvidence.researchAccuracy, {
      sampleSize: 2, matched: 1, mismatched: 1, matchRate: 0.5, smallSample: true,
      sampleNote: 'Research 判断样本少于 20，匹配率仅供方向参考',
      note: '作者对 AI 主张与当次来源摘录是否匹配的判断，不是来源真实性、权威性或平台事实评分。',
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`\n✅ Private AI metrics ${passed}/${passed} 全过`);
