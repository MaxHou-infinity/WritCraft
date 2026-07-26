#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../src/renderer/diagnostic-export-view.js'),
  'utf8'
);
const HTML = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const PREVIEW_SCHEMA = 'writcraft.diagnostic-preview/v1';
const EXPORT_SCHEMA = 'writcraft.diagnostic-export/v1';
const TOKEN = 'diagnostic_token_abcdefghijklmnop';
let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.isConnected = true;
    this.classList = {
      values: new Set(),
      toggle: (name, force) => {
        if (force) this.classList.values.add(name);
        else this.classList.values.delete(name);
      },
      contains: name => this.classList.values.has(name),
    };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, overrides = {}) {
    const event = {
      type,
      target: this,
      currentTarget: this,
      key: '',
      shiftKey: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }

  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function previewResult(serialized = '{"schema":"writcraft.diagnostics/v1"}', overrides = {}) {
  return {
    ok: true,
    schema: PREVIEW_SCHEMA,
    token: TOKEN,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    serialized,
    ...overrides,
  };
}

function harness(options = {}) {
  const ids = [
    'diagnostic-preview-open', 'diagnostic-dialog', 'diagnostic-close',
    'diagnostic-refresh', 'diagnostic-export', 'diagnostic-serialized',
    'diagnostic-feedback',
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const card = new FakeElement('diagnostic-card');
  const document = {
    activeElement: null,
    getElementById(id) { return elements.get(id) || null; },
  };
  for (const element of [...elements.values(), card]) element.ownerDocument = document;
  const dialog = elements.get('diagnostic-dialog');
  dialog.hidden = true;
  dialog.querySelector = selector => selector === '.diagnostic-card' ? card : null;
  card.querySelectorAll = () => [
    elements.get('diagnostic-close'),
    elements.get('diagnostic-serialized'),
    elements.get('diagnostic-refresh'),
    elements.get('diagnostic-export'),
  ];
  const calls = { previews: 0, exports: [] };
  const previewQueue = [...(options.previews || [previewResult()])];
  const exportQueue = [...(options.exports || [])];
  const diagnostics = {
    async preview() {
      calls.previews += 1;
      const value = previewQueue.length > 1 ? previewQueue.shift() : previewQueue[0];
      return typeof value === 'function' ? value() : value;
    },
    async export(token) {
      calls.exports.push(token);
      const value = exportQueue.length > 1 ? exportQueue.shift() : exportQueue[0];
      return typeof value === 'function' ? value() : value;
    },
  };
  const window = { writCraft: { diagnostics } };
  const timers = new Set();
  const context = vm.createContext({
    window,
    document,
    HTMLElement: FakeElement,
    TextEncoder,
    Date,
    console,
    clearTimeout(timer) { timers.delete(timer); },
    setTimeout(callback) {
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
  });
  vm.runInContext(SOURCE, context, { filename: 'diagnostic-export-view.js' });
  return { window, document, elements, card, calls, timers };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  console.log('\nDiagnostic Export Renderer verification');

  await test('Settings exposes the visible privacy journey and loads its controller', async () => {
    assert(HTML.includes('id="diagnostic-settings-title">诊断与隐私'));
    assert(HTML.includes('id="diagnostic-preview-open"'));
    assert(HTML.includes('id="diagnostic-dialog"'));
    assert(HTML.includes('id="diagnostic-serialized"'));
    assert(HTML.includes('id="diagnostic-export"'));
    assert(HTML.includes('<script src="diagnostic-export-view.js"></script>'));
  });

  await test('opening fetches a preview and displays Main serialized bytes with textContent', async () => {
    const serialized = '{"literal":"<img src=x onerror=alert(1)>","line":"正文不会解析"}';
    const item = harness({ previews: [previewResult(serialized)] });
    item.elements.get('diagnostic-preview-open').focus();
    item.elements.get('diagnostic-preview-open').click();
    assert.strictEqual(item.elements.get('diagnostic-dialog').hidden, false);
    assert.strictEqual(item.document.activeElement, item.elements.get('diagnostic-close'));
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, true);
    await settle();
    assert.strictEqual(item.elements.get('diagnostic-serialized').textContent, serialized);
    assert.strictEqual(item.elements.get('diagnostic-serialized').dataset.empty, 'false');
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, false);
  });

  await test('export sends only the live token and successful write consumes the preview', async () => {
    const item = harness({
      exports: [{ ok: true, schema: EXPORT_SCHEMA, basename: 'writcraft-diagnostic.json' }],
    });
    item.elements.get('diagnostic-preview-open').click();
    await settle();
    item.elements.get('diagnostic-export').click();
    await settle();
    assert.deepStrictEqual(item.calls.exports, [TOKEN]);
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, true);
    assert.match(item.elements.get('diagnostic-feedback').textContent, /writcraft-diagnostic\.json/);
    assert.strictEqual(item.document.activeElement, item.elements.get('diagnostic-refresh'));
  });

  await test('native cancel writes nothing in Renderer and keeps the exact preview retryable', async () => {
    const item = harness({
      exports: [
        { ok: false, canceled: true },
        { ok: true, schema: EXPORT_SCHEMA, basename: 'retry.json' },
      ],
    });
    item.elements.get('diagnostic-preview-open').click();
    await settle();
    const exact = item.elements.get('diagnostic-serialized').textContent;
    item.elements.get('diagnostic-export').click();
    await settle();
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, false);
    assert.strictEqual(item.elements.get('diagnostic-serialized').textContent, exact);
    assert.match(item.elements.get('diagnostic-feedback').textContent, /已取消导出/);
    item.elements.get('diagnostic-export').click();
    await settle();
    assert.deepStrictEqual(item.calls.exports, [TOKEN, TOKEN]);
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, true);
  });

  await test('refresh invalidates the old token while loading and ignores a late preview', async () => {
    let release;
    const late = new Promise(resolve => { release = resolve; });
    const fresh = previewResult('{"generation":2}', { token: `${TOKEN}_2` });
    const item = harness({ previews: [() => late, fresh] });
    item.elements.get('diagnostic-preview-open').click();
    item.elements.get('diagnostic-refresh').click();
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, true);
    await settle();
    assert.strictEqual(item.elements.get('diagnostic-serialized').textContent, fresh.serialized);
    release(previewResult('{"generation":1}'));
    await settle();
    assert.strictEqual(item.elements.get('diagnostic-serialized').textContent, fresh.serialized);
  });

  await test('export error remains visible and allows retry without changing preview bytes', async () => {
    const item = harness({
      exports: [{ ok: false, message: '保存失败' }],
    });
    item.elements.get('diagnostic-preview-open').click();
    await settle();
    const exact = item.elements.get('diagnostic-serialized').textContent;
    item.elements.get('diagnostic-export').click();
    await settle();
    assert.strictEqual(item.elements.get('diagnostic-serialized').textContent, exact);
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, false);
    assert.strictEqual(item.elements.get('diagnostic-export').textContent, '重试导出');
    assert.strictEqual(item.elements.get('diagnostic-feedback').classList.contains('is-error'), true);
  });

  await test('Escape closes without export and restores focus to the Settings trigger', async () => {
    const item = harness();
    const trigger = item.elements.get('diagnostic-preview-open');
    trigger.focus();
    trigger.click();
    await settle();
    const close = item.elements.get('diagnostic-close');
    const exportButton = item.elements.get('diagnostic-export');
    close.focus();
    item.elements.get('diagnostic-dialog').dispatch('keydown', { key: 'Tab', shiftKey: true });
    assert.strictEqual(item.document.activeElement, exportButton);
    exportButton.focus();
    item.elements.get('diagnostic-dialog').dispatch('keydown', { key: 'Tab' });
    assert.strictEqual(item.document.activeElement, close);
    const event = item.elements.get('diagnostic-dialog').dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(event.defaultPrevented, true);
    assert.strictEqual(item.elements.get('diagnostic-dialog').hidden, true);
    assert.strictEqual(item.document.activeElement, trigger);
    assert.deepStrictEqual(item.calls.exports, []);
    assert.strictEqual(item.elements.get('diagnostic-export').disabled, true);
  });

  console.log(`\nDiagnostic Export Renderer: ${passed}/${passed} passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
