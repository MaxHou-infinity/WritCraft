#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const handshake = require('../src/main/api-handshake-service');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  toggle(name, enabled) {
    if (enabled) this.values.add(name);
    else this.values.delete(name);
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = id === 'api-key-dialog';
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  async emit(type, event = {}) { return this.listeners.get(type)?.(event); }
  async click() {
    if (this.disabled) return undefined;
    return this.emit('click', { preventDefault() {}, stopPropagation() {} });
  }
  focus() { this.focused = true; }
}

function createUiHarness(options = {}) {
  const ids = [
    'activity-settings', 'api-key-dialog', 'api-key-status-line', 'api-key-input',
    'api-key-save', 'api-key-check', 'api-key-clear', 'api-key-close',
    'api-key-feedback', 'api-key-connection', 'api-key-connection-status',
    'api-key-connection-detail',
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  let configured = options.configured !== false;
  let userConfigError = options.userConfigError || null;
  const environmentConfigured = Boolean(options.environmentConfigured);
  const calls = { status: 0, set: 0, check: 0, clear: 0 };
  const bridge = {
    apiKey: {
      async status() {
        calls.status += 1;
        return {
          ok: true,
          configured,
          keyType: configured ? (options.keyType || 'CODING_PLAN') : null,
          ...(userConfigError ? { userConfigError } : {}),
        };
      },
      async set() {
        calls.set += 1;
        configured = true;
        userConfigError = null;
        return { ok: true, configured: true, keyType: 'CODING_PLAN' };
      },
      async check() {
        calls.check += 1;
        return options.checkResult || { ok: true, latencyMs: 42, modelCount: 2, models: ['MiniMax-M3', 'MiniMax-M2.7'], defaultModelAvailable: true };
      },
      async clear() {
        calls.clear += 1;
        userConfigError = null;
        configured = environmentConfigured;
        return { ok: true, configured, keyType: configured ? (options.keyType || 'CODING_PLAN') : null };
      },
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/api-key-settings.js'), 'utf8');
  vm.runInNewContext(source, {
    window: { writCraft: bridge },
    document: { getElementById: id => nodes[id] || null },
    console,
    Number,
    Array,
    Boolean,
    Set,
  }, { filename: 'api-key-settings.js' });
  return { nodes, calls };
}

async function flush() {
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

async function run() {
  console.log('\nWritCraft AI Key handshake verification');

  await test('success exposes only latency and validated model metadata', async () => {
    const secret = `sk-cp-${'S3cret_'.repeat(10)}`;
    const ticks = [100, 137.6];
    const result = await handshake.runApiHandshake({
      apiKey: secret,
      defaultModel: 'MiniMax-M3',
      now: () => ticks.shift(),
      checkModels: async () => ({
        ok: true,
        models: ['MiniMax-M3', 'MiniMax-M2.7'],
        base: 'https://provider.invalid/private',
        body: `REMOTE BODY ${secret}`,
      }),
    });
    assert.deepStrictEqual(result, {
      ok: true,
      latencyMs: 38,
      modelCount: 2,
      models: ['MiniMax-M3', 'MiniMax-M2.7'],
      defaultModelAvailable: true,
    });
    assert(!JSON.stringify(result).includes(secret));
    assert(!JSON.stringify(result).includes('REMOTE BODY'));
    assert(!Object.hasOwn(result, 'base'));
  });

  await test('failure exposes only a stable reason and latency', async () => {
    const ticks = [5, 14];
    const result = await handshake.runApiHandshake({
      apiKey: 'SECRET_KEY',
      now: () => ticks.shift(),
      checkModels: async () => ({ ok: false, error: 'AUTH_FAILED', body: 'SECRET REMOTE BODY' }),
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'AUTH_FAILED', latencyMs: 9 });
    assert.deepStrictEqual(Object.keys(result).sort(), ['latencyMs', 'ok', 'reason']);
  });

  await test('unknown and thrown provider failures collapse to REQUEST_FAILED', async () => {
    for (const checkModels of [
      async () => ({ ok: false, error: 'SECRET_INTERNAL_REASON' }),
      async () => { throw new Error('SECRET_KEY AND REMOTE BODY'); },
    ]) {
      const ticks = [0, 1];
      assert.deepStrictEqual(await handshake.runApiHandshake({ now: () => ticks.shift(), checkModels }), {
        ok: false,
        reason: 'REQUEST_FAILED',
        latencyMs: 1,
      });
    }
  });

  await test('malformed success cannot smuggle secrets through a model identifier', async () => {
    const secret = 'SECRET REMOTE BODY';
    for (const model of [
      `sk-api-${secret.replaceAll(' ', '_')}`,
      `MiniMax-sk-api-${secret.replaceAll(' ', '_')}`,
      `MiniMax-M3-sk-cp-${secret.replaceAll(' ', '_')}`,
      'MiniMax-arbitrary-provider-metadata',
    ]) {
      const ticks = [0, 3];
      assert.deepStrictEqual(await handshake.runApiHandshake({
        now: () => ticks.shift(),
        checkModels: async () => ({ ok: true, models: [model] }),
      }), { ok: false, reason: 'INVALID_RESPONSE', latencyMs: 3 });
    }
  });

  await test('a corrupt local config remains clearable while a valid environment key can be checked', async () => {
    const { nodes, calls } = createUiHarness({
      userConfigError: 'CONFIG_CORRUPT',
      environmentConfigured: true,
      keyType: 'FULL',
    });
    await nodes['activity-settings'].click();
    await flush();
    assert.strictEqual(nodes['api-key-check'].disabled, false);
    assert.strictEqual(nodes['api-key-clear'].disabled, false);
    assert.match(nodes['api-key-status-line'].textContent, /启动环境/);
    assert.match(nodes['api-key-status-line'].textContent, /本机已存配置损坏/);
    await nodes['api-key-check'].click();
    assert.strictEqual(calls.check, 1);
    await nodes['api-key-clear'].click();
    assert.strictEqual(calls.clear, 1);
    assert.strictEqual(nodes['api-key-check'].disabled, false, '清除损坏本地配置后仍可使用环境 Key');
  });

  await test('a corrupt local config without fallback can still be cleared but cannot be checked', async () => {
    const { nodes } = createUiHarness({ configured: false, userConfigError: 'CONFIG_CORRUPT' });
    await nodes['activity-settings'].click();
    await flush();
    assert.strictEqual(nodes['api-key-check'].disabled, true);
    assert.strictEqual(nodes['api-key-clear'].disabled, false);
    assert.match(nodes['api-key-status-line'].textContent, /清除后重新保存/);
  });

  await test('opening settings stays offline; explicit detection renders live metadata', async () => {
    const { nodes, calls } = createUiHarness();
    await nodes['activity-settings'].click();
    await flush();
    assert.strictEqual(calls.status, 1, 'opening may read local status');
    assert.strictEqual(calls.check, 0, 'opening must not make a network handshake');
    assert.strictEqual(nodes['api-key-check'].disabled, false);

    await nodes['api-key-check'].click();
    assert.strictEqual(calls.check, 1);
    assert.strictEqual(nodes['api-key-connection'].dataset.state, 'connected');
    assert.match(nodes['api-key-connection-status'].textContent, /已连接/);
    assert.match(nodes['api-key-connection-detail'].textContent, /42 ms/);
    assert.match(nodes['api-key-connection-detail'].textContent, /2 个模型/);
  });

  await test('saving automatically handshakes once, while clear resets without networking', async () => {
    const { nodes, calls } = createUiHarness();
    await nodes['activity-settings'].click();
    await flush();
    const secret = `sk-cp-${'DontEcho_'.repeat(8)}`;
    nodes['api-key-input'].value = secret;
    await nodes['api-key-save'].click();
    assert.strictEqual(calls.set, 1);
    assert.strictEqual(calls.check, 1, 'successful save must perform exactly one read-only handshake');
    assert.strictEqual(nodes['api-key-input'].value, '');
    assert.strictEqual(nodes['api-key-connection'].dataset.state, 'connected');
    const rendered = Object.values(nodes).map(node => node.textContent).join('\n');
    assert(!rendered.includes(secret), 'key material must never be rendered');

    await nodes['api-key-clear'].click();
    assert.strictEqual(calls.clear, 1);
    assert.strictEqual(calls.check, 1, 'clear must not trigger a network call');
    assert.strictEqual(nodes['api-key-connection'].dataset.state, 'idle');
    assert.strictEqual(nodes['api-key-check'].disabled, true);
  });

  await test('a saved key is not described as verified when the default writing model is unavailable', async () => {
    const { nodes } = createUiHarness({
      checkResult: {
        ok: true,
        latencyMs: 30,
        modelCount: 1,
        models: ['MiniMax-M2.7'],
        defaultModelAvailable: false,
      },
    });
    await nodes['activity-settings'].click();
    await flush();
    nodes['api-key-input'].value = `sk-cp-${'NoM3_'.repeat(12)}`;
    await nodes['api-key-save'].click();
    assert.strictEqual(nodes['api-key-connection'].dataset.state, 'limited');
    assert.match(nodes['api-key-connection-status'].textContent, /默认写作模型不可用/);
    assert.match(nodes['api-key-feedback'].textContent, /尚未通过检测/);
    assert.strictEqual(nodes['api-key-feedback'].classList.contains('is-error'), true);
  });

  console.log(`\n✅ AI Key handshake ${passed}/${passed} checks passed; stub bridge only, 0 real network.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
