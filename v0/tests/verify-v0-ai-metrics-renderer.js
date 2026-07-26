#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const clientSource = read('src/renderer/ai-metrics-client.js');
const serviceSource = read('src/main/ai-metrics-service.js');
const viewSource = read('src/renderer/ai-metrics-view.js');
const editor = read('src/renderer/editor.js');
const changes = read('src/renderer/changes-view.js');
const plan = read('src/renderer/assistant-workspace.js');
const imageSource = read('src/renderer/image-generation-view.js');
const html = read('src/renderer/index.html');

let passed = 0;
async function check(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function loadClient(overrides = {}) {
  const calls = [];
  const window = {
    __workspace: { state: { project: { projectId: 'p1', instanceId: 'instance-1' } } },
    writCraft: { project: {
      recordAiMetric: async (instanceId, metric) => { calls.push({ instanceId, metric }); return { ok: true }; },
      getAiMetricsAggregate: async instanceId => ({ ok: instanceId === 'instance-1', aggregate: { sampleSize: 3 } }),
    } },
    ...overrides,
  };
  const context = { window, document: { dispatchEvent() {}, addEventListener() {} }, CustomEvent: class {}, crypto: { randomUUID: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, console };
  vm.runInNewContext(clientSource, context, { filename: 'ai-metrics-client.js' });
  return { api: window.WritCraftAiMetrics, calls, window };
}

function setValues(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[(.*?)\\]\\)`, 's'));
  assert(match, `${name} contract missing`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `${name} missing`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} unterminated`);
}

class ImageNode {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  async dispatch(name) {
    for (const listener of this.listeners.get(name) || []) await listener({ target: this });
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) { this.children = []; this.textContent = ''; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() {}
}

function imageButton(root, label) {
  if (root.textContent === label) return root;
  for (const child of root.children || []) {
    const found = imageButton(child, label);
    if (found) return found;
  }
  return null;
}

function imageClass(root, className) {
  if (String(root.className || '').split(/\s+/).includes(className)) return root;
  for (const child of root.children || []) {
    const found = imageClass(child, className);
    if (found) return found;
  }
  return null;
}

function nodeText(root) {
  return [root.textContent, ...(root.children || []).map(nodeText)].filter(Boolean).join(' ');
}

function loadImageHarness({
  generateImage,
  insertGeneratedImage = async () => ({
    ok: true,
    targetPath: 'chapters/01.md',
    revision: 'a'.repeat(64),
  }),
  settleImageReview = async () => ({ ok: true }),
}) {
  const ids = ['image-toggle', 'image-compose', 'image-prompt', 'image-aspect', 'image-generate', 'image-result'];
  const nodes = Object.fromEntries(ids.map(id => [id, new ImageNode(id === 'image-prompt' ? 'textarea' : id === 'image-aspect' ? 'select' : id === 'image-generate' ? 'button' : 'div', id)]));
  nodes['image-compose'].hidden = false;
  nodes['image-prompt'].value = '合成图片提示';
  nodes['image-aspect'].value = '16:9';
  const documentListeners = new Map();
  const document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => new ImageNode(tag),
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) || [];
      listeners.push(listener);
      documentListeners.set(name, listeners);
    },
    dispatchEvent() { return true; },
  };
  const metricCalls = [];
  const settleCalls = [];
  let insertCalls = 0;
  let generateCalls = 0;
  const workspace = {
    state: { project: { instanceId: 'instance-1' } },
    insertGeneratedImage: async (...args) => { insertCalls += 1; return insertGeneratedImage(...args); },
  };
  const window = {
    __workspace: workspace,
    writCraft: { project: {
      generateImage: async (...args) => { generateCalls += 1; return generateImage(...args); },
      settleImageReview: async (...args) => {
        settleCalls.push(args);
        return settleImageReview(...args);
      },
      recordAiMetric: async (instanceId, metric) => { metricCalls.push({ instanceId, metric }); return { ok: true }; },
    } },
  };
  let operation = 0;
  const context = {
    window, document, console, Date, Object, Promise, CustomEvent: class {},
    crypto: { randomUUID: () => (++operation).toString(16).padStart(8, '0') + '-0000-0000-0000-000000000000' },
  };
  vm.runInNewContext(clientSource, context, { filename: 'ai-metrics-client.js' });
  vm.runInNewContext(imageSource, context, { filename: 'image-generation-view.js' });
  return {
    nodes, window, workspace, metricCalls, settleCalls,
    getInsertCalls: () => insertCalls,
    getGenerateCalls: () => generateCalls,
  };
}

console.log('════════ WritCraft V0 · AI metrics renderer verify ════════');

(async () => {
  await check('renderer 只构造固定八字段隐私事件', () => {
    const { api } = loadClient();
    const event = api.sanitizeEvent({ operationId: 'a'.repeat(32), action: 'inline_rewrite', outcome: 'accepted', style: 'general', scope: 'selection', durationMs: 12, beforeChars: 10, afterChars: 11, prompt: 'secret' });
    assert.deepStrictEqual(Object.keys(event), ['operationId', 'action', 'outcome', 'style', 'scope', 'durationMs', 'beforeChars', 'afterChars']);
    assert(!JSON.stringify(event).includes('secret'));
  });

  await check('operationId 与数值非法时直接拒绝而不静默 clamp', () => {
    const { api } = loadClient();
    const base = { operationId: 'a'.repeat(32), action: 'plan', outcome: 'generated', style: 'none', scope: 'project', durationMs: 20, beforeChars: 0, afterChars: 0 };
    for (const bad of ['', 'short', 'z'.repeat(32)]) assert.equal(api.sanitizeEvent({ ...base, operationId: bad }), null);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER]) assert.equal(api.sanitizeEvent({ ...base, durationMs: value }), null);
    assert.equal(api.createOperationId(), 'a'.repeat(32));
  });

  await check('record 只把清洗事件送入窄 preload 方法', async () => {
    const { api, calls } = loadClient();
    assert(await api.record('instance-1', { operationId: 'a'.repeat(32), action: 'plan', outcome: 'generated', style: 'none', scope: 'project', durationMs: 20, beforeChars: 0, afterChars: 0 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instanceId, 'instance-1');
    assert.equal(calls[0].metric.operationId, 'a'.repeat(32));
    assert(!Object.prototype.hasOwnProperty.call(calls[0].metric, 'filePath'));
  });

  await check('Onboarding 成功生成指标等待审阅能力终结后再原序落盘', async () => {
    const { api, calls } = loadClient();
    const generated = {
      operationId: 'b'.repeat(32), action: 'onboarding', outcome: 'generated',
      style: 'none', scope: 'project', durationMs: 20, beforeChars: 0, afterChars: 0,
    };
    assert(await api.record('instance-1', generated));
    assert.equal(calls.length, 0, 'live Onboarding capability must not be invalidated by project-local metrics');
    assert(await api.record('instance-1', {
      ...generated, outcome: 'accepted', durationMs: 30,
    }));
    assert.deepStrictEqual(calls.map(item => item.metric.outcome), ['generated', 'accepted']);
    assert.deepStrictEqual(calls.map(item => item.metric.operationId), ['b'.repeat(32), 'b'.repeat(32)]);
  });

  await check('Onboarding 延迟指标只由同 operation 终态释放', async () => {
    const { api, calls } = loadClient();
    const base = {
      action: 'onboarding', style: 'none', scope: 'project', durationMs: 20,
      beforeChars: 0, afterChars: 0,
    };
    assert(await api.record('instance-1', { ...base, operationId: 'd'.repeat(32), outcome: 'generated' }));
    assert(await api.record('instance-1', { ...base, operationId: 'e'.repeat(32), outcome: 'accepted' }));
    assert.deepStrictEqual(calls.map(item => item.metric.operationId), ['e'.repeat(32)]);
    assert(await api.record('instance-1', { ...base, operationId: 'd'.repeat(32), outcome: 'discarded' }));
    assert.deepStrictEqual(calls.map(item => item.metric.outcome), ['accepted', 'generated', 'discarded']);
    assert.deepStrictEqual(calls.slice(1).map(item => item.metric.operationId), ['d'.repeat(32), 'd'.repeat(32)]);
  });

  await check('新增 workflow 通过真实 sanitize→record 边界且不携带内容字段', async () => {
    const { api, calls } = loadClient();
    const actions = ['onboarding', 'research', 'image', 'graph_issue', 'plan_task'];
    for (let index = 0; index < actions.length; index += 1) {
      const input = {
        operationId: (index + 1).toString(16).padStart(32, '0'),
        action: actions[index], outcome: index === 0 ? 'retried' : 'generated',
        style: 'none', scope: index === 2 ? 'file' : 'multi_file',
        durationMs: 10, beforeChars: 0, afterChars: 0,
        prompt: '不得进入指标', filePath: '/private/path',
      };
      assert(await api.record('instance-1', input));
    }
    assert.deepStrictEqual(calls.map(item => item.metric.action), actions);
    for (const { metric } of calls) {
      assert.deepStrictEqual(Object.keys(metric), [
        'operationId', 'action', 'outcome', 'style', 'scope', 'durationMs', 'beforeChars', 'afterChars',
      ]);
      assert(!JSON.stringify(metric).includes('不得进入指标'));
      assert(!Object.prototype.hasOwnProperty.call(metric, 'filePath'));
    }
  });

  await check('Changes workflow 动态保留 Research、Plan task 与 Graph action', async () => {
    const { api, calls, window } = loadClient();
    window.WritCraftAiMetrics = api;
    const source = extractFunction(changes, 'recordChangeMetric');
    const context = { window, pending: null, Date };
    const recordChangeMetric = vm.runInNewContext(`(() => { ${source}; return recordChangeMetric; })()`, context);
    for (const [index, action] of ['research', 'plan_task', 'graph_issue'].entries()) {
      recordChangeMetric('generated', {
        operationId: (index + 10).toString(16).padStart(32, '0'),
        originProjectInstanceId: 'instance-1', action, scope: 'multi_file',
        startedAt: Date.now(), beforeChars: 0, afterChars: 0,
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.deepStrictEqual(calls.map(item => item.metric.action), ['research', 'plan_task', 'graph_issue']);
    assert(calls.every(item => item.metric.scope === 'multi_file'));
  });

  await check('A→B 后延迟成功与失败都不会落入 B 项目', async () => {
    const { api, calls, window } = loadClient();
    async function finishAfterSwitch(outcome, operationId) {
      const originProjectInstanceId = window.__workspace.state.project.instanceId;
      let release;
      const delayed = new Promise(resolve => { release = resolve; });
      const completion = delayed.then(() => api.record(originProjectInstanceId, {
        operationId, action: 'changeset', outcome, style: 'none', scope: 'multi_file',
        durationMs: 25, beforeChars: 10, afterChars: outcome === 'generated' ? 12 : 10,
      }));
      window.__workspace.state.project = { projectId: 'p2', instanceId: 'instance-2' };
      release();
      assert.equal(await completion, false);
    }
    await finishAfterSwitch('generated', 'b'.repeat(32));
    window.__workspace.state.project = { projectId: 'p1', instanceId: 'instance-1' };
    await finishAfterSwitch('failed', 'c'.repeat(32));
    assert.deepStrictEqual(calls, [], 'B 项目不得收到 A 的延迟事件');
  });

  await check('图片审阅必须评分，并覆盖 inserted、kept 与 deleted 三种结算', async () => {
    const generated = {
      ok: true,
      image: {
        filePath: 'assets/generated/test.png',
        previewDataUrl: 'data:image/png;base64,AA==',
        width: 1600,
        height: 900,
        requestedAspectRatio: '16:9',
      },
      review: { token: `irv_${'b'.repeat(48)}` },
    };

    const kept = loadImageHarness({ generateImage: async () => generated });
    await kept.nodes['image-generate'].dispatch('click');
    assert(nodeText(kept.nodes['image-result']).includes('1600×900 · 16:9 · 已解码'));
    await imageButton(kept.nodes['image-result'], '保留素材').dispatch('click');
    assert.equal(kept.settleCalls.length, 0, 'missing rating must not settle review');
    assert(nodeText(kept.nodes['image-result']).includes('请先给这张图片打 1–5 分'));
    imageClass(kept.nodes['image-result'], 'image-rating').value = '4';
    await imageButton(kept.nodes['image-result'], '保留素材').dispatch('click');
    assert.deepStrictEqual(kept.metricCalls.map(item => item.metric.outcome), ['generated', 'discarded']);
    assert.equal(kept.settleCalls[0][1].decision, 'kept');
    assert.equal(kept.settleCalls[0][1].qualityRating, 4);
    assert.equal(kept.settleCalls[0][2], null);

    const deleted = loadImageHarness({ generateImage: async () => generated });
    await deleted.nodes['image-generate'].dispatch('click');
    imageClass(deleted.nodes['image-result'], 'image-rating').value = '2';
    imageClass(deleted.nodes['image-result'], 'image-cost').value = '1.25';
    imageClass(deleted.nodes['image-result'], 'image-currency').value = 'CNY';
    await imageButton(deleted.nodes['image-result'], '移入废纸篓').dispatch('click');
    assert.equal(deleted.settleCalls[0][1].decision, 'deleted');
    assert.equal(deleted.settleCalls[0][1].costMinorUnits, 125);
    assert.equal(deleted.settleCalls[0][1].currency, 'CNY');
    assert.deepStrictEqual(deleted.metricCalls.map(item => item.metric.outcome), ['generated', 'discarded']);

    const inserted = loadImageHarness({ generateImage: async () => generated });
    await inserted.nodes['image-generate'].dispatch('click');
    imageClass(inserted.nodes['image-result'], 'image-rating').value = '5';
    await imageButton(inserted.nodes['image-result'], '插入当前正文').dispatch('click');
    assert.equal(inserted.getInsertCalls(), 1);
    assert.equal(inserted.settleCalls[0][1].decision, 'inserted');
    assert.equal(inserted.settleCalls[0][2].targetPath, 'chapters/01.md');
    assert.equal(inserted.settleCalls[0][2].revision, 'a'.repeat(64));
    assert.deepStrictEqual(inserted.metricCalls.map(item => item.metric.outcome), ['generated', 'accepted']);
    assert(inserted.metricCalls.every(item => item.metric.action === 'image' && item.metric.scope === 'file'));
  });

  await check('图片 pending 阻止切项目，插入结算失败重试不会二次插入', async () => {
    const generated = {
      ok: true,
      image: {
        filePath: 'assets/generated/test.png',
        previewDataUrl: 'data:image/png;base64,AA==',
        width: 1024,
        height: 1024,
        requestedAspectRatio: '1:1',
      },
      review: { token: `irv_${'c'.repeat(48)}` },
    };
    let settleAttempts = 0;
    const harness = loadImageHarness({
      generateImage: async () => generated,
      settleImageReview: async () => {
        settleAttempts += 1;
        return settleAttempts === 1
          ? { ok: false, message: '插入证据尚未提交' }
          : { ok: true };
      },
    });
    await harness.nodes['image-generate'].dispatch('click');
    assert.equal(await harness.window.__imageGenerationView.discardPending(), false);
    if (await harness.window.__imageGenerationView.discardPending()) {
      harness.workspace.state.project = { instanceId: 'instance-2' };
    }
    assert.equal(harness.workspace.state.project.instanceId, 'instance-1',
      'unsettled review must block project switch');
    assert.equal(harness.nodes['image-generate'].disabled, true);

    imageClass(harness.nodes['image-result'], 'image-rating').value = '5';
    const insert = imageButton(harness.nodes['image-result'], '插入当前正文');
    await insert.dispatch('click');
    assert.equal(harness.getInsertCalls(), 1);
    assert.equal(harness.settleCalls.length, 1);
    assert(nodeText(harness.nodes['image-result']).includes('插入证据尚未提交'));
    assert.equal(await harness.window.__imageGenerationView.discardPending(), false);
    await insert.dispatch('click');
    assert.equal(harness.getInsertCalls(), 1, 'settlement retry must reuse insertion proof');
    assert.equal(harness.settleCalls.length, 2);
    assert.deepStrictEqual(harness.metricCalls.map(item => item.metric.outcome), ['generated', 'accepted']);
    assert.equal(await harness.window.__imageGenerationView.discardPending(), true);
  });

  await check('图片生成的 A→B 迟到结果不渲染也不污染 B 指标', async () => {
    let resolveGeneration;
    const switched = loadImageHarness({
      generateImage: () => new Promise(resolve => { resolveGeneration = resolve; }),
    });
    const running = switched.nodes['image-generate'].dispatch('click');
    await Promise.resolve();
    switched.workspace.state.project = { instanceId: 'instance-2' };
    resolveGeneration({
      ok: true,
      image: {
        filePath: 'assets/generated/late.png',
        previewDataUrl: 'data:image/png;base64,AA==',
        width: 1600,
        height: 900,
        requestedAspectRatio: '16:9',
      },
      review: { token: `irv_${'d'.repeat(48)}` },
    });
    await running;
    assert.deepStrictEqual(switched.metricCalls, [], 'A 的迟到图片结果不得写入 B 指标');
    assert.equal(imageClass(switched.nodes['image-result'], 'image-review'), null);
    assert.equal(switched.settleCalls.length, 0);
  });

  await check('aggregate 只消费 Main 返回的聚合对象', async () => {
    const { api } = loadClient();
    assert.equal(JSON.stringify(await api.aggregate()), JSON.stringify({ status: 'ready', metrics: { sampleSize: 3 } }));
    assert(!clientSource.includes('.events'));
  });

  await check('协作回顾动态显示五类作者证据、结构失败率与小样本提示', () => {
    const document = { createElement: tag => new ImageNode(tag) };
    const window = {};
    vm.runInNewContext(viewSource, { window, document, console, Number, Math }, { filename: 'ai-metrics-view.js' });
    const host = new ImageNode('section');
    window.WritCraftAiMetricsView.render(host, {
      status: 'ready',
      metrics: {
        sampleSize: 8, acceptanceRate: 0.5,
        durationMs: { median: 100, p95: 200 }, reviewDurationMs: { median: 300 },
        decisionSampleNote: '接受/拒绝决策样本少于 20，比例仅供方向参考',
        authorEvidence: {
          inline: { decisionSampleSize: 2, acceptanceRate: 0.5 },
          planRun: { attempts: 2, failureRate: 0.5 },
          planTask: { decisionSampleSize: 1, acceptanceRate: 1 },
          research: { decisionSampleSize: 1, acceptanceRate: 0 },
          researchAccuracy: { sampleSize: 2, matched: 1, mismatched: 1, matchRate: 0.5, note: '作者判断，不是平台事实评分。' },
          image: { decisionSampleSize: 1, acceptanceRate: 1 },
          onboarding: { attempts: 2, failureRate: 0.5, structuredFailures: 1, structuredFailureRate: 0.5, retryResults: 1, retrySuccessRate: 1 },
        },
      },
    });
    const text = nodeText(host);
    for (const label of ['Inline', 'Plan 生成', 'Plan task', 'Research 修改', 'Research 主张', '图片', 'Onboarding', '结构失败率', '人工重试']) assert(text.includes(label));
    assert(text.includes('2 次判断 · 匹配 50%'));
    assert(text.includes('作者判断，不是平台事实评分'));
    assert(text.includes('样本少于 20'));
  });

  await check('Inline Rewrite 只记录成功决策或真实失败', () => {
    assert.match(editor, /recordRewriteMetric\('accepted'/);
    assert.match(editor, /recordRewriteMetric\('rejected'/);
    assert.match(editor, /recordRewriteMetric\('failed'/);
    assert.match(editor, /recordRewriteMetric\('generated'/);
    assert.match(editor, /if \(announce\) \{[\s\S]*recordRewriteMetric\('rejected'/);
    const unknownBranch = editor.slice(editor.indexOf("const recoveryKind = route.kind === 'manual_recovery'"),
      editor.indexOf('function cancelActiveRewriteForDocumentLoad'));
    assert.match(unknownBranch, /if \(route\.kind === 'manual_recovery'\) recordRewriteMetric\('failed'/);
    assert(!unknownBranch.match(/route\.kind === 'outcome_unknown'[\s\S]{0,300}recordRewriteMetric\('failed'/));
  });

  await check('Changes 记录生成、应用、丢弃与失败，Plan 记录生成和失败', () => {
    for (const outcome of ['generated', 'accepted', 'discarded', 'failed']) assert(changes.includes(`recordChangeMetric('${outcome}'`));
    assert.match(plan, /recordPlanMetric\(result\?\.ok \? 'generated' : 'failed',[\s\S]*originProjectInstanceId/);
    assert.match(plan, /requestEpoch === projectEpoch \? result : \{ canceled: true \}/);
  });

  await check('Inline、Changes、Plan 都在操作创建时捕获 origin 并贯穿所有 outcome', () => {
    assert.match(clientSource, /async function record\(originProjectInstanceId, input\)/);
    assert.match(clientSource, /currentProjectInstanceId !== originProjectInstanceId/);
    assert.match(editor, /originProjectInstanceId: frozen\.intent\.projectInstanceId/);
    assert.match(editor, /record\(entry\.originProjectInstanceId, \{/);
    assert.match(changes, /record\?\.\(metric\.originProjectInstanceId, \{/);
    assert((changes.match(/originProjectInstanceId: window\.__workspace\?\.state\?\.project\?\.instanceId/g) || []).length >= 3);
    const planCapture = plan.indexOf('const originProjectInstanceId = window.__workspace?.state?.project?.instanceId');
    assert(planCapture >= 0 && planCapture < plan.indexOf('await window.__workspace.persistCurrent(true)'));
    assert.match(plan, /record\?\.\(originProjectInstanceId, \{/);
    for (const outcome of ['generated', 'accepted', 'rejected', 'discarded', 'failed']) {
      assert(editor.includes(`recordRewriteMetric('${outcome}'`) || changes.includes(`recordChangeMetric('${outcome}'`) || plan.includes(`recordPlanMetric('${outcome}'`));
    }
  });

  await check('协作回顾保持四书签结构且只显示聚合值', () => {
    assert.match(html, /id="ai-metrics-review"/);
    assert.match(html, /协作回顾 · 仅记录操作指标/);
    assert.equal((html.match(/<button[^>]+data-assistant-mode=/g) || []).length, 4);
    assert(!viewSource.includes('innerHTML'));
    assert.match(viewSource, /metrics\.decisionSampleNote \|\| metrics\.sampleNote/);
    assert.match(viewSource, /reviewDurationMs/);
    assert.match(viewSource, /state\?\.status === 'error'/);
  });

  await check('指标脚本在使用者之前加载', () => {
    assert(html.indexOf('ai-metrics-client.js') < html.indexOf('editor.js'));
    assert(html.indexOf('ai-metrics-view.js') < html.indexOf('changes-view.js'));
  });

  await check('renderer 与 Main 的枚举契约保持完全一致', () => {
    for (const name of ['ACTIONS', 'OUTCOMES', 'STYLES', 'SCOPES']) {
      assert.deepStrictEqual(setValues(clientSource, name), setValues(serviceSource, name));
    }
    assert(!serviceSource.match(/EVENT_KEYS[^\n]*filePath/));
  });

  await check('项目切换清空旧 Changes，聚合异步结果由 instance 与 sequence 双重门禁', () => {
    assert.match(changes, /metricsRequestSequence/);
    assert.match(changes, /requestId !== metricsRequestSequence \|\| projectInstanceId !== window\.__workspace/);
    assert.match(changes, /writcraft:project-entered[\s\S]*pending = null/);
    assert.match(changes, /metric\.decisionRecorded/);
  });

  if (!process.exitCode) console.log(`\n✅ AI metrics renderer ${passed}/${passed} 全过`);
})();
