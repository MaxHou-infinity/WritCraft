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

function nodeText(root) {
  return [root.textContent, ...(root.children || []).map(nodeText)].filter(Boolean).join(' ');
}

function loadImageHarness(generateImage, insertGeneratedImage = async () => ({ ok: true })) {
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
    nodes, window, workspace, metricCalls,
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

  await check('图片动态记录生成、显式插入与重新生成丢弃，并保持 A→B 隔离', async () => {
    const image = { filePath: 'assets/generated/test.png', previewDataUrl: 'data:image/png;base64,AA==' };
    const accepted = loadImageHarness(async () => ({ ok: true, image }));
    await accepted.nodes['image-generate'].dispatch('click');
    await imageButton(accepted.nodes['image-result'], '插入当前正文').dispatch('click');
    assert.deepStrictEqual(accepted.metricCalls.map(item => item.metric.outcome), ['generated', 'accepted']);
    assert.equal(accepted.getInsertCalls(), 1);
    assert(accepted.metricCalls.every(item => item.metric.action === 'image' && item.metric.scope === 'file'));

    const regenerated = loadImageHarness(async () => ({ ok: true, image }));
    await regenerated.nodes['image-generate'].dispatch('click');
    await regenerated.nodes['image-generate'].dispatch('click');
    assert.deepStrictEqual(regenerated.metricCalls.map(item => item.metric.outcome), ['generated', 'discarded', 'generated']);

    const abandoned = loadImageHarness(async () => ({ ok: true, image }));
    await abandoned.nodes['image-generate'].dispatch('click');
    await imageButton(abandoned.nodes['image-result'], '放弃插入').dispatch('click');
    assert.deepStrictEqual(abandoned.metricCalls.map(item => item.metric.outcome), ['generated', 'discarded']);
    assert(nodeText(abandoned.nodes['image-result']).includes('生成资产仍保留在项目中'));
    assert(nodeText(abandoned.nodes['image-result']).includes('正文没有修改'));
    assert.equal(abandoned.getInsertCalls(), 0, 'abandon must not insert or mutate manuscript');

    const failed = loadImageHarness(async () => ({ ok: false, error: 'LLM_FAILED' }));
    await failed.nodes['image-generate'].dispatch('click');
    assert.deepStrictEqual(failed.metricCalls.map(item => item.metric.outcome), ['failed']);

    let resolveInsert;
    const contested = loadImageHarness(
      async () => ({ ok: true, image }),
      () => new Promise(resolve => { resolveInsert = resolve; }),
    );
    await contested.nodes['image-generate'].dispatch('click');
    const contestedInsert = imageButton(contested.nodes['image-result'], '插入当前正文');
    const contestedAbandon = imageButton(contested.nodes['image-result'], '放弃插入');
    const contestedRegenerate = imageButton(contested.nodes['image-result'], '重新生成');
    const insertion = contestedInsert.dispatch('click');
    await Promise.resolve();
    assert(contestedInsert.disabled && contestedAbandon.disabled && contestedRegenerate.disabled,
      'all controls for the exact preview owner must lock during insertion');
    await contestedAbandon.dispatch('click');
    await contestedRegenerate.dispatch('click');
    assert.equal(contested.getGenerateCalls(), 1, 'regenerate during insert must be rejected');
    assert(nodeText(contested.nodes['image-result']).includes('尚未插入正文'), 'old owner preview must remain while insert settles');
    let switchSettled = false;
    const projectSwitch = (async () => {
      await contested.window.__imageGenerationView.discardPending();
      contested.workspace.state.project = { instanceId: 'instance-2' };
      switchSettled = true;
    })();
    await Promise.resolve();
    assert.equal(switchSettled, false, 'project switch must wait for the insertion owner');
    resolveInsert({ ok: true });
    await Promise.all([insertion, projectSwitch]);
    assert.equal(contested.getInsertCalls(), 1, 'exact image may be inserted only once');
    assert.deepStrictEqual(contested.metricCalls.map(item => item.metric.outcome), ['generated', 'accepted']);
    assert.equal(contested.metricCalls[1].metric.operationId, contested.metricCalls[0].metric.operationId,
      'accepted must terminate the original preview metric');
    assert(!contested.metricCalls.some(item => item.metric.outcome === 'discarded'), 'waiting switch must not invent discard');
    assert(nodeText(contested.nodes['image-result']).includes('已在当前光标位置插入'));

    let resolveGeneration;
    const switched = loadImageHarness(() => new Promise(resolve => { resolveGeneration = resolve; }));
    const running = switched.nodes['image-generate'].dispatch('click');
    await Promise.resolve();
    switched.workspace.state.project = { instanceId: 'instance-2' };
    resolveGeneration({ ok: true, image });
    await running;
    assert.deepStrictEqual(switched.metricCalls, [], 'A 的迟到图片结果不得写入 B 指标');
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
