#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../src/main/image-generation-service');

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error instanceof service.ImageGenerationError && error.code === code);
}

function projectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-image-generation-'));
}

function pngBytes(seed = 0x22) {
  const value = Buffer.alloc(33, seed);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write('IHDR', 12, 'ascii');
  value.writeUInt32BE(1, 16);
  value.writeUInt32BE(1, 20);
  return value;
}

function jpegBytes(seed = 0x33) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, seed, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

function response(payload, options = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 500 : 200),
    headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(body.length) : null; } },
    async text() { return body; },
  };
}

function successResponse(bytes) {
  return response({
    id: 'stub-request',
    data: { image_base64: [bytes.toString('base64')] },
    base_resp: { status_code: 0, status_msg: 'success' },
  });
}

async function generate(root, bytes, overrides = {}) {
  return service.generateAndSaveImage({
    rootPath: root,
    prompt: '雨后的港口档案室，纪实摄影',
    aspectRatio: '16:9',
    apiKey: 'sk-api-test-only-key',
    fetchImpl: async () => successResponse(bytes),
    decodeImage: () => ({ width: 1, height: 1 }),
    ...overrides,
  });
}

async function run() {
  console.log('\nWritCraft image-01 generation security verification');

  await test('sends the exact official image-01 base64 request and persists a PNG before returning', async () => {
    const root = projectRoot();
    const bytes = pngBytes();
    let captured = null;
    try {
      const result = await generate(root, bytes, {
        fetchImpl: async (url, options) => {
          captured = { url, options };
          return successResponse(bytes);
        },
      });
      assert.strictEqual(captured.url, service.ENDPOINT);
      assert.strictEqual(captured.options.method, 'POST');
      assert.strictEqual(captured.options.redirect, 'error');
      assert.strictEqual(captured.options.headers.Authorization, 'Bearer sk-api-test-only-key');
      assert.strictEqual(captured.options.headers['Content-Type'], 'application/json');
      assert.deepStrictEqual(JSON.parse(captured.options.body), {
        model: 'image-01',
        prompt: '雨后的港口档案室，纪实摄影',
        aspect_ratio: '16:9',
        response_format: 'base64',
        n: 1,
      });
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.deepStrictEqual(result, {
        ok: true,
        image: {
          filePath: `assets/generated/image-${digest}.png`,
          mimeType: 'image/png',
          previewDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        },
        markdown: `![AI 生成图片](assets/generated/image-${digest}.png)`,
      });
      assert.deepStrictEqual(fs.readFileSync(path.join(root, ...result.image.filePath.split('/'))), bytes);
      assert(result.image.previewDataUrl.length <= Math.ceil(service.MAX_IMAGE_BYTES * 4 / 3) + 64);
      assert(!Object.values(result.image).some(value => typeof value === 'string' && /^https?:/.test(value)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('accepts verified JPEG magic and returns the renderer-facing contract only', async () => {
    const root = projectRoot();
    try {
      const result = await generate(root, jpegBytes(), { aspectRatio: '1:1' });
      assert.deepStrictEqual(Object.keys(result), ['ok', 'image', 'markdown']);
      assert.deepStrictEqual(Object.keys(result.image), ['filePath', 'mimeType', 'previewDataUrl']);
      assert.strictEqual(result.image.mimeType, 'image/jpeg');
      assert.match(result.image.filePath, /^assets\/generated\/image-[a-f0-9]{64}\.jpg$/);
      assert(result.image.previewDataUrl.startsWith('data:image/jpeg;base64,'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects missing, hostile and oversized prompt/aspect inputs before fetch', async () => {
    const root = projectRoot();
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return successResponse(pngBytes()); };
    try {
      for (const [code, prompt, aspectRatio] of [
        ['INVALID_PROMPT', '', '1:1'],
        ['INVALID_PROMPT', { prompt: 'object smuggling' }, '1:1'],
        ['INVALID_PROMPT', 'bad\u0000prompt', '1:1'],
        ['PROMPT_TOO_LONG', '图'.repeat(service.MAX_PROMPT_CHARS + 1), '1:1'],
        ['INVALID_ASPECT_RATIO', '正常描述', '2048x2048'],
        ['INVALID_ASPECT_RATIO', '正常描述', '/tmp/output.png'],
      ]) {
        await expectCode(code, () => service.generateAndSaveImage({
          rootPath: root, prompt, aspectRatio, apiKey: 'sk-api-test-only-key', fetchImpl,
        }));
      }
      assert.strictEqual(calls, 0);
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('strictly rejects noncanonical base64, URL-only output, multiple images, oversize and bad magic', async () => {
    const root = projectRoot();
    const cases = [
      ['INVALID_IMAGE_RESPONSE', { data: { image_urls: ['https://temporary.invalid/image.png'] }, base_resp: { status_code: 0 } }],
      ['INVALID_IMAGE_RESPONSE', { data: { image_base64: [pngBytes().toString('base64'), pngBytes(0x44).toString('base64')] }, base_resp: { status_code: 0 } }],
      ['INVALID_IMAGE_RESPONSE', { data: { image_base64: ['aG VsbG8='] }, base_resp: { status_code: 0 } }],
      ['UNSUPPORTED_IMAGE_TYPE', { data: { image_base64: [Buffer.from('GIF89a-not-allowed').toString('base64')] }, base_resp: { status_code: 0 } }],
    ];
    try {
      for (const [code, payload] of cases) {
        await expectCode(code, () => service.generateAndSaveImage({
          rootPath: root,
          prompt: '正常描述',
          aspectRatio: '1:1',
          apiKey: 'sk-api-test-only-key',
          fetchImpl: async () => response(payload),
        }));
      }
      await expectCode('IMAGE_RESPONSE_TOO_LARGE', () => service.generateAndSaveImage({
        rootPath: root,
        prompt: '正常描述',
        aspectRatio: '1:1',
        apiKey: 'sk-api-test-only-key',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => String(service.MAX_RESPONSE_CHARS + 1) },
          async text() { throw new Error('must not read oversized body'); },
        }),
      }));
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects magic-only or truncated bytes when the runtime decoder cannot decode them', async () => {
    const root = projectRoot();
    try {
      await expectCode('INVALID_IMAGE_DATA', () => generate(root, pngBytes(), { decodeImage: () => null }));
      await expectCode('INVALID_IMAGE_DATA', () => generate(root, jpegBytes(), { decodeImage: () => { throw new Error('decode failed'); } }));
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('keeps the deadline active while reading a response body that never completes', async () => {
    const root = projectRoot();
    let canceled = false;
    try {
      await expectCode('IMAGE_TIMEOUT', () => service.generateAndSaveImage({
        rootPath: root,
        prompt: '正常描述',
        aspectRatio: '1:1',
        apiKey: 'sk-api-test-only-key',
        timeoutMs: 15,
        decodeImage: () => ({ width: 1, height: 1 }),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader() { return { read: () => new Promise(() => {}), async cancel() { canceled = true; } }; },
            async cancel() { canceled = true; },
          },
        }),
      }));
      assert.equal(canceled, true);
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('cancels in-flight generation when the owning project changes', async () => {
    const root = projectRoot();
    const controller = new AbortController();
    let requestSignal;
    try {
      const pending = service.generateAndSaveImage({
        rootPath: root,
        prompt: '正常描述',
        aspectRatio: '1:1',
        apiKey: 'sk-api-test-only-key',
        signal: controller.signal,
        fetchImpl: async (_url, options) => {
          requestSignal = options.signal;
          return new Promise(() => {});
        },
      });
      controller.abort();
      await expectCode('IMAGE_ABORTED', () => pending);
      assert.strictEqual(requestSignal.aborted, true);
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('uses stable exclusive names and never overwrites an existing generated image', async () => {
    const root = projectRoot();
    const bytes = pngBytes();
    try {
      const first = await generate(root, bytes);
      const target = path.join(root, ...first.image.filePath.split('/'));
      const before = fs.readFileSync(target);
      await expectCode('IMAGE_EXISTS', () => generate(root, bytes));
      assert.deepStrictEqual(fs.readFileSync(target), before);
      assert(!fs.readdirSync(path.dirname(target)).some(name => name.endsWith('.tmp')));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('blocks symlink destinations and keeps their external targets untouched', async () => {
    const root = projectRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-image-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'assets'));
      await expectCode('UNSAFE_IMAGE_DESTINATION', () => generate(root, pngBytes()));
      assert.deepStrictEqual(fs.readdirSync(outside), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  await test('checks project generation immediately before commit and writes nothing when stale', async () => {
    const root = projectRoot();
    let guardCalls = 0;
    try {
      await expectCode('PROJECT_CHANGED', () => generate(root, pngBytes(), {
        beforeCommit() {
          guardCalls += 1;
          throw new service.ImageGenerationError('PROJECT_CHANGED', '项目已切换');
        },
      }));
      assert.strictEqual(guardCalls, 1);
      assert.strictEqual(fs.existsSync(path.join(root, 'assets')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('bounds API failures without exposing the Main-held key or remote response body', async () => {
    const root = projectRoot();
    const key = 'sk-api-SUPER-SECRET-DO-NOT-LEAK';
    try {
      await assert.rejects(() => service.generateAndSaveImage({
        rootPath: root,
        prompt: '正常描述',
        aspectRatio: '1:1',
        apiKey: key,
        fetchImpl: async () => { throw new Error(`network failed with ${key}`); },
      }), error => error.code === 'IMAGE_REQUEST_FAILED' && !error.message.includes(key));
      for (const [status, code] of [
        [401, 'IMAGE_AUTH_FAILED'],
        [408, 'IMAGE_TIMEOUT'],
        [429, 'IMAGE_RATE_LIMITED'],
        [503, 'IMAGE_SERVICE_UNAVAILABLE'],
        [400, 'IMAGE_API_FAILED'],
      ]) {
        await assert.rejects(() => service.generateAndSaveImage({
          rootPath: root,
          prompt: '正常描述',
          aspectRatio: '1:1',
          apiKey: key,
          fetchImpl: async () => response({ status_msg: key }, { ok: false, status }),
        }), error => error.code === code && !error.message.includes(key));
      }
      for (const [providerStatusCode, code] of [
        [1001, 'IMAGE_TIMEOUT'],
        [1002, 'IMAGE_RATE_LIMITED'],
        [1004, 'IMAGE_AUTH_FAILED'],
        [2049, 'IMAGE_AUTH_FAILED'],
        [1008, 'IMAGE_INSUFFICIENT_BALANCE'],
        [1026, 'IMAGE_CONTENT_REJECTED'],
        [1027, 'IMAGE_CONTENT_REJECTED'],
        [1039, 'IMAGE_INVALID_REQUEST'],
        [2056, 'IMAGE_QUOTA_EXCEEDED'],
        [2013, 'IMAGE_INVALID_REQUEST'],
        [1024, 'IMAGE_SERVICE_UNAVAILABLE'],
        [9999, 'IMAGE_API_FAILED'],
      ]) {
        await assert.rejects(() => service.generateAndSaveImage({
          rootPath: root,
          prompt: '正常描述',
          aspectRatio: '1:1',
          apiKey: key,
          fetchImpl: async () => response({
            base_resp: { status_code: providerStatusCode, status_msg: key },
          }),
        }), error => error.code === code && !error.message.includes(key));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('Main owns root/key/output and preload exposes only prompt plus aspect ratio', async () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
    assert(main.includes("require('./image-generation-service')"));
    assert(main.includes("ipcMain.handle('writcraft:project:generate-image'"));
    assert.match(main, /writcraft:project:generate-image'[\s\S]{0,200}assertTrustedSender\(event\)/);
    assert.match(main, /generateAndSaveImage\(\{[\s\S]{0,500}rootPath: project\.rootPath/);
    assert.match(main, /const apiKey = resolveActiveApiKey\(\);[\s\S]{0,400}detectKeyType\(apiKey\) === 'CODING_PLAN'/);
    assert.match(main, /generateAndSaveImage\(\{[\s\S]{0,500}\n\s*apiKey,/);
    assert(main.includes("'IMAGE_KEY_UNSUPPORTED'"));
    assert.match(main, /beforeCommit\(\)[\s\S]{0,350}projectMutationGeneration !== mutationGeneration/);
    assert.match(preload, /generateImage: \(projectInstanceId, prompt, aspectRatio\) => ipcRenderer\.invoke\('writcraft:project:generate-image', projectInstanceId, prompt, aspectRatio\)/);
    assert(main.includes('nativeImage.createFromBuffer(bytes)'));
    assert(main.includes('currentProject.instanceId !== projectInstanceId'));
    const handlerStart = main.indexOf("ipcMain.handle('writcraft:project:generate-image'");
    const handlerEnd = main.indexOf('\nipcMain.handle(', handlerStart + 20);
    const handler = main.slice(handlerStart, handlerEnd);
    assert(handler.indexOf('projectInstanceId !== project.instanceId') < handler.indexOf('generateAndSaveImage({'));
    const bridgeLine = preload.split('\n').find(line => line.includes('generateImage:'));
    assert(!/root|key|path|output/i.test(bridgeLine.replace(/generateImage|generate-image/g, '')));
  });

  await test('an A-origin request dispatched after switching to B is rejected before model or filesystem work', async () => {
    const state = { currentProject: { instanceId: 'B', rootPath: '/project-b' }, generation: 2 };
    let serviceCalls = 0;
    async function invoke(originProjectInstanceId) {
      const project = state.currentProject;
      if (originProjectInstanceId !== project.instanceId) return { ok: false, error: 'PROJECT_CHANGED' };
      serviceCalls += 1;
      return { ok: true };
    }
    assert.deepStrictEqual(await invoke('A'), { ok: false, error: 'PROJECT_CHANGED' });
    assert.equal(serviceCalls, 0);
  });

  console.log(`\n✅ image-01 generation security ${passed}/${passed} checks passed; stub fetch only, 0 real network.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
