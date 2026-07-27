#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'image-generation-view.js'),
  'utf8'
);
const html = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
  'utf8'
);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

class Node {
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
    for (const listener of this.listeners.get(name) || []) {
      await listener({ target: this });
    }
  }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  replaceChildren(...nodes) {
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() {}
}

function findButton(root, text) {
  if (root.tagName === 'BUTTON' && root.textContent === text) return root;
  for (const child of root.children || []) {
    const found = findButton(child, text);
    if (found) return found;
  }
  return null;
}

function allText(root) {
  return [root.textContent, ...(root.children || []).map(allText)]
    .filter(Boolean)
    .join(' ');
}

function publicList(overrides = {}) {
  return {
    ok: true,
    schema: 'writcraft.image-trash/v1',
    policy: 'manual_until_restore_or_empty',
    totalCount: 1,
    totalBytes: 2048,
    items: [{
      token: `iti_${'a'.repeat(48)}`,
      createdAt: '2026-07-27T01:00:00.000Z',
      sizeBytes: 2048,
    }],
    snapshotToken: `its_${'b'.repeat(48)}`,
    ...overrides,
  };
}

function harness(options = {}) {
  const ids = [
    'image-toggle', 'image-compose', 'image-prompt', 'image-aspect',
    'image-generate', 'image-result', 'image-review-summary',
    'image-trash-toggle', 'image-trash-panel', 'image-trash-status',
    'image-trash-list', 'image-trash-refresh', 'image-trash-empty',
  ];
  const nodes = Object.fromEntries(ids.map(id => [id, new Node('div', id)]));
  nodes['image-compose'].hidden = false;
  nodes['image-trash-panel'].hidden = true;
  nodes['image-prompt'].value = '';
  const documentListeners = new Map();
  const document = {
    getElementById: id => nodes[id] || null,
    createElement: tag => new Node(tag),
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) || [];
      listeners.push(listener);
      documentListeners.set(name, listeners);
    },
  };
  const calls = { list: [], restore: [], empty: [] };
  let list = options.list || (async () => publicList());
  let confirm = options.confirm ?? true;
  const project = { instanceId: 'project-a' };
  const window = {
    __workspace: { state: { project } },
    confirm: () => confirm,
    writCraft: { project: {
      getImageTrash: async (...args) => {
        calls.list.push(args);
        return list(...args);
      },
      restoreImageTrash: async (...args) => {
        calls.restore.push(args);
        return options.restore?.(...args) || {
          ok: true,
          schema: 'writcraft.image-trash/v1',
          restored: true,
          assetPath: `assets/generated/image-${'c'.repeat(64)}.png`,
          responseRecovered: false,
        };
      },
      emptyImageTrash: async (...args) => {
        calls.empty.push(args);
        return options.empty?.(...args) || {
          ok: true,
          schema: 'writcraft.image-trash/v1',
          emptiedCount: 1,
          remainingCount: 0,
          responseRecovered: false,
        };
      },
    } },
  };
  vm.runInNewContext(source, {
    window,
    document,
    console,
    Date,
    Number,
    Object,
    Promise,
  }, { filename: 'image-generation-view.js' });
  return {
    nodes,
    calls,
    window,
    project,
    api: window.__imageGenerationView,
    setList(next) { list = next; },
    setConfirm(next) { confirm = next; },
  };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

console.log('\nWritCraft image trash Renderer verification');

(async () => {
  await test('visible UI states manual retention and requires explicit permanent empty', () => {
    assert.match(html, /id="image-trash-toggle"/);
    assert.match(html, /长期保留 · 不会自动删除/);
    assert.match(html, /id="image-trash-empty"[^>]+is-danger/);
    assert.match(source, /window\.confirm\?\.\(/);
    assert.match(source, /该操作无法撤销/);
    assert.doesNotMatch(source, /setTimeout\([^)]*(?:emptyImageTrash|restoreImageTrash)/s);
  });

  await test('list renders only bounded public metadata and opaque capabilities', async () => {
    const item = harness();
    assert.strictEqual(await item.api.refreshTrash(), true);
    assert.deepStrictEqual(item.calls.list, [['project-a']]);
    assert.strictEqual(item.nodes['image-trash-toggle'].textContent, '图片废纸篓 · 1');
    assert.match(allText(item.nodes['image-trash-list']), /2\.0 KB/);
    assert(!allText(item.nodes['image-trash-list']).includes('/private/project'));
    assert(!allText(item.nodes['image-trash-list']).includes('digest'));
    assert.strictEqual(item.nodes['image-trash-empty'].disabled, false);
  });

  await test('restore sends only project and opaque item token then refreshes', async () => {
    const item = harness();
    await item.api.refreshTrash();
    const button = findButton(item.nodes['image-trash-list'], '恢复到素材区');
    assert(button);
    await button.dispatch('click');
    assert.deepStrictEqual(item.calls.restore, [[
      'project-a',
      `iti_${'a'.repeat(48)}`,
    ]]);
    assert.strictEqual(item.calls.list.length, 2);
  });

  await test('cancelled empty makes zero IPC call; confirmed empty sends only snapshot token', async () => {
    const item = harness();
    await item.api.refreshTrash();
    item.setConfirm(false);
    await item.nodes['image-trash-empty'].dispatch('click');
    await flush();
    assert.strictEqual(item.calls.empty.length, 0);
    item.setConfirm(true);
    await item.nodes['image-trash-empty'].dispatch('click');
    await flush();
    await flush();
    assert.deepStrictEqual(item.calls.empty, [[
      'project-a',
      `its_${'b'.repeat(48)}`,
    ]]);
    assert.strictEqual(item.calls.list.length, 2);
  });

  await test('malformed or privacy-expanded list fails closed without enabling actions', async () => {
    const item = harness({
      list: async () => publicList({
        items: [{
          token: `iti_${'a'.repeat(48)}`,
          createdAt: 'not-a-date',
          sizeBytes: 2048,
          rootPath: '/private/project',
        }],
      }),
    });
    assert.strictEqual(await item.api.refreshTrash(), false);
    assert.strictEqual(item.nodes['image-trash-empty'].disabled, true);
    assert.match(item.nodes['image-trash-status'].textContent, /读取失败/);
    assert.strictEqual(item.calls.restore.length, 0);
    assert.strictEqual(item.calls.empty.length, 0);
  });

  await test('late project-A list cannot render into project B', async () => {
    let resolve;
    const item = harness({
      list: () => new Promise(done => { resolve = done; }),
    });
    const pending = item.api.refreshTrash();
    item.window.__workspace.state.project = { instanceId: 'project-b' };
    resolve(publicList());
    assert.strictEqual(await pending, false);
    assert.strictEqual(item.nodes['image-trash-toggle'].textContent, '');
    assert.strictEqual(item.nodes['image-trash-list'].children.length, 0);
  });

  await test('Renderer bridge calls contain no root, path, digest, inode or item arrays', async () => {
    const item = harness();
    await item.api.refreshTrash();
    await findButton(item.nodes['image-trash-list'], '恢复到素材区').dispatch('click');
    item.setConfirm(true);
    await item.api.refreshTrash();
    await item.nodes['image-trash-empty'].dispatch('click');
    await flush();
    const serialized = JSON.stringify(item.calls);
    for (const forbidden of ['rootPath', 'trashPath', 'digest', 'inode', 'operationId']) {
      assert(!serialized.includes(forbidden));
    }
  });

  if (!process.exitCode) {
    console.log(`\n✅ image trash Renderer ${passed}/${passed} checks passed.\n`);
  }
})();
