#!/usr/bin/env node
'use strict';

const assert = require('assert');
const service = require('../src/main/minimax-text-service');

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function response(payload, options = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 500 : 200),
    headers: { get: name => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    async text() { return text; },
  };
}

const CP_KEY = `sk-cp-${'A1_-'.repeat(20)}`;
const API_KEY = `sk-api-${'B2_-'.repeat(20)}`;
const TEST_TOOL = {
  name: 'submit_project_plan',
  description: 'Submit one structured project plan.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['milestones'],
    properties: {
      milestones: {
        type: 'array',
        items: { type: 'object' },
      },
    },
  },
};
const TEST_TOOL_CHOICE = { type: 'tool', name: TEST_TOOL.name };

async function run() {
  console.log('\nWritCraft MiniMax text network boundary verification');

  await test('pins the official China Anthropic host and exact models endpoint', async () => {
    let captured;
    const result = await service.checkModels({
      apiKey: CP_KEY,
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return response({ data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }] });
      },
    });
    assert.strictEqual(service.BASE_URL, 'https://api.minimaxi.com/anthropic/v1');
    assert.strictEqual(captured.url, 'https://api.minimaxi.com/anthropic/v1/models');
    assert.strictEqual(captured.options.method, 'GET');
    assert.strictEqual(captured.options.redirect, 'error');
    assert.strictEqual(captured.options.cache, 'no-store');
    assert.deepStrictEqual(result, {
      ok: true,
      models: ['MiniMax-M3', 'MiniMax-M2.7'],
      base: service.BASE_URL,
    });
  });

  await test('uses Bearer Authorization for sk-cp and never duplicates it into x-api-key', async () => {
    let headers;
    await service.checkModels({
      apiKey: CP_KEY,
      fetchImpl: async (_url, options) => { headers = options.headers; return response({ data: [] }); },
    });
    assert.strictEqual(headers.Authorization, `Bearer ${CP_KEY}`);
    assert.strictEqual(headers['x-api-key'], undefined);
    assert.strictEqual(headers['anthropic-version'], '2023-06-01');
  });

  await test('uses x-api-key for sk-api and never duplicates it into Authorization', async () => {
    let captured;
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: '改写这一段' }],
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return response({
          model: 'MiniMax-M3',
          content: [{ type: 'thinking', thinking: '不返回' }, { type: 'text', text: '改写结果' }],
          usage: { input_tokens: 12, output_tokens: 4, secret: API_KEY },
          stop_reason: 'end_turn',
        });
      },
    });
    assert.strictEqual(captured.url, service.MESSAGES_ENDPOINT);
    assert.strictEqual(captured.options.headers['x-api-key'], API_KEY);
    assert.strictEqual(captured.options.headers.Authorization, undefined);
    assert.strictEqual(captured.options.headers['Content-Type'], 'application/json');
    assert.strictEqual(captured.options.redirect, 'error');
    assert.deepStrictEqual(JSON.parse(captured.options.body), {
      model: 'MiniMax-M3',
      max_tokens: 1024,
      messages: [{ role: 'user', content: '改写这一段' }],
    });
    assert.deepStrictEqual(result, {
      ok: true,
      text: '改写结果',
      contentBlockCount: 2,
      textBlockCount: 1,
      nonTextBlockCount: 1,
      usage: { input_tokens: 12, output_tokens: 4 },
      model: 'MiniMax-M3',
      stopReason: 'end_turn',
    });
  });

  await test('sends one forced tool schema and exposes only one bounded matching tool input', async () => {
    let captured;
    const input = { milestones: [{ id: 'm1' }] };
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: '生成项目计划' }],
      maxTokens: 8_192,
      tools: [TEST_TOOL],
      toolChoice: TEST_TOOL_CHOICE,
      fetchImpl: async (_url, options) => {
        captured = JSON.parse(options.body);
        return response({
          model: 'MiniMax-M3',
          content: [
            { type: 'thinking', thinking: '不作为计划 authority' },
            { type: 'text', text: '已提交。' },
            { type: 'tool_use', id: 'call_plan_1', name: TEST_TOOL.name, input },
          ],
          stop_reason: 'tool_use',
        });
      },
    });
    assert.deepStrictEqual(captured, {
      model: 'MiniMax-M3',
      max_tokens: 8_192,
      messages: [{ role: 'user', content: '生成项目计划' }],
      tools: [TEST_TOOL],
      tool_choice: TEST_TOOL_CHOICE,
    });
    assert.deepStrictEqual(result, {
      ok: true,
      text: '已提交。',
      toolUse: { id: 'call_plan_1', name: TEST_TOOL.name, input },
      contentBlockCount: 3,
      textBlockCount: 1,
      toolUseBlockCount: 1,
      nonTextBlockCount: 2,
      usage: undefined,
      model: 'MiniMax-M3',
      stopReason: 'tool_use',
    });

    const noText = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: '只调用工具' }],
      tools: [TEST_TOOL],
      toolChoice: TEST_TOOL_CHOICE,
      fetchImpl: async () => response({
        model: 'MiniMax-M3',
        content: [{ type: 'tool_use', id: 'call_plan_2', name: TEST_TOOL.name, input }],
        stop_reason: 'tool_use',
      }),
    });
    assert.strictEqual(noText.ok, true);
    assert.strictEqual(noText.text, null);
    assert.deepStrictEqual(noText.toolUse.input, input);
  });

  await test('fails closed on missing, wrong, multiple or malformed tool results', async () => {
    const payloads = [
      { content: [], stop_reason: 'end_turn' },
      {
        content: [{ type: 'tool_use', id: 'call_1', name: 'wrong_tool', input: {} }],
        stop_reason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: TEST_TOOL.name, input: {} },
          { type: 'tool_use', id: 'call_2', name: TEST_TOOL.name, input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: TEST_TOOL.name, input: {} },
          { type: 'tool_use', id: 'call_2', name: 'wrong_tool', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'call_1', name: TEST_TOOL.name, input: {} },
          { type: 'tool_use', id: 'call_2', name: TEST_TOOL.name, input: 'not-an-object' },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'call_1', name: TEST_TOOL.name, input: 'not-an-object' }],
        stop_reason: 'tool_use',
      },
    ];
    for (const payload of payloads) {
      const result = await service.callMessages({
        apiKey: API_KEY,
        messages: [{ role: 'user', content: 'x' }],
        tools: [TEST_TOOL],
        toolChoice: TEST_TOOL_CHOICE,
        fetchImpl: async () => response(payload),
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'INVALID_TOOL_USE');
      assert.strictEqual(result.toolUse, null);
    }
  });

  await test('preserves the allowlisted max_tokens stop reason for truncation handling', async () => {
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: '生成结构化修改' }],
      fetchImpl: async () => response({
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: '{"edits":[' }],
        stop_reason: 'max_tokens',
      }),
    });
    assert.deepStrictEqual(result, {
      ok: true,
      text: '{"edits":[',
      contentBlockCount: 1,
      textBlockCount: 1,
      nonTextBlockCount: 0,
      usage: undefined,
      model: 'MiniMax-M3',
      stopReason: 'max_tokens',
    });
    const empty = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'truncate without text' }],
      fetchImpl: async () => response({
        model: 'MiniMax-M3', content: [], stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, 'NO_TEXT_BLOCK');
    assert.equal(empty.text, null);
    assert.equal(empty.stopReason, 'max_tokens');
    assert.equal(empty.contentBlockCount, 0);
  });

  await test('redacts unknown or malicious stop reasons behind a fixed safe value', async () => {
    const malicious = `future_reason:${API_KEY}:SUPER_SECRET_MANUSCRIPT`;
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'SUPER_SECRET_MANUSCRIPT' }],
      fetchImpl: async () => response({
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: '安全正文' }],
        stop_reason: malicious,
      }),
    });
    assert.deepStrictEqual(result, {
      ok: true,
      text: '安全正文',
      contentBlockCount: 1,
      textBlockCount: 1,
      nonTextBlockCount: 0,
      usage: undefined,
      model: 'MiniMax-M3',
      stopReason: service.UNKNOWN_STOP_REASON,
    });
    assert.strictEqual(result.stopReason, 'unknown');
    assert(!JSON.stringify(result).includes(malicious));
    assert(!JSON.stringify(result).includes(API_KEY));
    assert(!JSON.stringify(result).includes('SUPER_SECRET_MANUSCRIPT'));
  });

  await test('reports every provider content block without changing first-text compatibility', async () => {
    const multipleText = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => response({
        content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
        stop_reason: 'end_turn',
      }),
    });
    assert.strictEqual(multipleText.text, 'first');
    assert.deepStrictEqual({
      contentBlockCount: multipleText.contentBlockCount,
      textBlockCount: multipleText.textBlockCount,
      nonTextBlockCount: multipleText.nonTextBlockCount,
    }, { contentBlockCount: 2, textBlockCount: 2, nonTextBlockCount: 0 });

    const toolBlock = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => response({
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'unsafe', input: {} },
          { type: 'text', text: 'compatible text' },
        ],
        stop_reason: 'tool_use',
      }),
    });
    assert.strictEqual(toolBlock.text, 'compatible text');
    assert.deepStrictEqual({
      contentBlockCount: toolBlock.contentBlockCount,
      textBlockCount: toolBlock.textBlockCount,
      nonTextBlockCount: toolBlock.nonTextBlockCount,
    }, { contentBlockCount: 2, textBlockCount: 1, nonTextBlockCount: 1 });

    const malformedBlocks = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => response({
        content: [null, 'not-a-block', { type: 'text', text: 42 }, { text: 'missing-type' }, { type: 'text', text: 'valid' }],
        stop_reason: 'end_turn',
      }),
    });
    assert.strictEqual(malformedBlocks.text, 'valid');
    assert.deepStrictEqual({
      contentBlockCount: malformedBlocks.contentBlockCount,
      textBlockCount: malformedBlocks.textBlockCount,
      nonTextBlockCount: malformedBlocks.nonTextBlockCount,
    }, { contentBlockCount: 5, textBlockCount: 1, nonTextBlockCount: 4 });
  });

  await test('rejects invalid keys and request inputs before any network call', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return response({}); };
    const cases = [
      [service.checkModels, { apiKey: 'sk-other-secret', fetchImpl }, 'NO_KEY'],
      [service.callMessages, { apiKey: API_KEY, messages: [], fetchImpl }, 'INVALID_MESSAGES'],
      [service.callMessages, { apiKey: API_KEY, messages: [{ role: 'system', content: 'x' }], fetchImpl }, 'INVALID_MESSAGES'],
      [service.callMessages, { apiKey: API_KEY, messages: [{ role: 'user', content: 'x', apiKey: API_KEY }], fetchImpl }, 'INVALID_MESSAGES'],
      [service.callMessages, { apiKey: API_KEY, messages: [{ role: 'user', content: 'x' }], model: '../escape', fetchImpl }, 'INVALID_MODEL'],
      [service.callMessages, { apiKey: API_KEY, messages: [{ role: 'user', content: 'x' }], maxTokens: 0, fetchImpl }, 'INVALID_MAX_TOKENS'],
      [service.callMessages, { apiKey: API_KEY, messages: [{ role: 'user', content: 'x' }], maxTokens: service.MAX_MAX_TOKENS + 1, fetchImpl }, 'INVALID_MAX_TOKENS'],
      [service.callMessages, {
        apiKey: API_KEY, messages: [{ role: 'user', content: 'x' }],
        tools: [{ ...TEST_TOOL, name: '../escape' }], toolChoice: TEST_TOOL_CHOICE, fetchImpl,
      }, 'INVALID_TOOLS'],
      [service.callMessages, {
        apiKey: API_KEY, messages: [{ role: 'user', content: 'x' }],
        tools: [TEST_TOOL], toolChoice: { type: 'tool', name: 'other' }, fetchImpl,
      }, 'INVALID_TOOL_CHOICE'],
    ];
    for (const [fn, options, error] of cases) assert.deepStrictEqual(await fn(options), { ok: false, error });
    assert.strictEqual(calls, 0);
  });

  await test('bounds serialized request bytes before dispatch', async () => {
    let calls = 0;
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: '中'.repeat(service.MAX_REQUEST_BYTES) }],
      fetchImpl: async () => { calls += 1; return response({}); },
    });
    assert.deepStrictEqual(result, { ok: false, error: 'REQUEST_TOO_LARGE' });
    assert.strictEqual(calls, 0);
  });

  await test('bounds declared and actual response bytes', async () => {
    const declared = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-length' ? String(service.MAX_RESPONSE_BYTES + 1) : null },
        async text() { throw new Error('must not read'); },
      }),
    });
    assert.deepStrictEqual(declared, { ok: false, error: 'RESPONSE_TOO_LARGE' });

    const actual = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async text() { return 'x'.repeat(service.MAX_RESPONSE_BYTES + 1); },
      }),
    });
    assert.deepStrictEqual(actual, { ok: false, error: 'RESPONSE_TOO_LARGE' });
  });

  await test('rejects an explicitly non-JSON response before parsing provider text', async () => {
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/html' : null },
        async text() { return JSON.stringify({ content: [{ type: 'text', text: 'not accepted' }] }); },
      }),
    });
    assert.deepStrictEqual(result, { ok: false, error: 'INVALID_RESPONSE' });
  });

  await test('keeps the timeout active through fetch and response-body reads', async () => {
    const fetchTimeout = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    });
    assert.deepStrictEqual(fetchTimeout, { ok: false, error: 'TIMEOUT' });

    let canceled = false;
    const bodyTimeout = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { async cancel() { canceled = true; } },
        async text() { return new Promise(() => {}); },
      }),
    });
    assert.deepStrictEqual(bodyTimeout, { ok: false, error: 'TIMEOUT' });
    assert.strictEqual(canceled, true);
  });

  await test('never retries a failed request', async () => {
    let calls = 0;
    const result = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      fetchImpl: async () => { calls += 1; throw new Error('offline'); },
    });
    assert.deepStrictEqual(result, { ok: false, error: 'REQUEST_FAILED' });
    assert.strictEqual(calls, 1);
  });

  await test('honors an owner abort separately from the service deadline', async () => {
    const controller = new AbortController();
    let requestSignal;
    const pending = service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 1000,
      signal: controller.signal,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal;
        return new Promise(() => {});
      },
    });
    controller.abort();
    assert.deepStrictEqual(await pending, { ok: false, error: 'REQUEST_ABORTED' });
    assert.strictEqual(requestSignal.aborted, true);
  });

  await test('maps HTTP failures without exposing key, prompt, or remote payload', async () => {
    const prompt = 'SUPER_SECRET_MANUSCRIPT';
    for (const [status, expected] of [[401, 'AUTH_FAILED'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE'], [400, 'API_FAILED']]) {
      const result = await service.callMessages({
        apiKey: API_KEY,
        messages: [{ role: 'user', content: prompt }],
        fetchImpl: async () => response({ error: { message: `${API_KEY} ${prompt}` } }, { ok: false, status }),
      });
      assert.deepStrictEqual(result, { ok: false, error: expected });
      assert(!JSON.stringify(result).includes(API_KEY));
      assert(!JSON.stringify(result).includes(prompt));
    }
  });

  await test('fully redacts thrown errors and malformed successful responses', async () => {
    const network = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'secret prompt' }],
      fetchImpl: async () => { throw new Error(`${API_KEY} secret prompt`); },
    });
    assert.deepStrictEqual(network, { ok: false, error: 'REQUEST_FAILED' });
    const malformed = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'secret prompt' }],
      fetchImpl: async () => response('{not-json'),
    });
    assert.deepStrictEqual(malformed, { ok: false, error: 'INVALID_RESPONSE' });
    const noText = await service.callMessages({
      apiKey: API_KEY,
      messages: [{ role: 'user', content: 'secret prompt' }],
      fetchImpl: async () => response({ content: [{ type: 'thinking', thinking: API_KEY }] }),
    });
    assert.deepStrictEqual(noText, {
      ok: false,
      error: 'NO_TEXT_BLOCK',
      text: null,
      contentBlockCount: 1,
      textBlockCount: 0,
      nonTextBlockCount: 1,
      usage: undefined,
      model: 'MiniMax-M3',
      stopReason: 'unknown',
    });
  });

  console.log(`\n✅ MiniMax text boundary ${passed}/${passed} checks passed; stub fetch only, 0 real network.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
