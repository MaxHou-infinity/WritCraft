#!/usr/bin/env node
'use strict';

const assert = require('assert');
const handlerModule = require('../src/main/image-trash-handler');
const serviceModule = require('../src/main/image-trash-service');

console.log('\nWritCraft image trash Main handler verification');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fixture() {
  const state = {
    project: { instanceId: 'project-a', rootPath: '/canonical/project-a' },
    generation: 3,
    navigation: 5,
    senderId: 7,
    calls: [],
  };
  const trashService = {
    list(binding) {
      state.calls.push(['list', binding]);
      return {
        ok: true,
        schema: serviceModule.TRASH_SCHEMA,
        policy: 'manual_until_restore_or_empty',
        totalCount: 0,
        totalBytes: 0,
        items: [],
        snapshotToken: null,
      };
    },
    restore(binding, token) {
      state.calls.push(['restore', binding, token]);
      return {
        ok: true,
        schema: serviceModule.TRASH_SCHEMA,
        restored: true,
        assetPath: `assets/generated/image-${'a'.repeat(64)}.png`,
        responseRecovered: false,
      };
    },
    empty(binding, token) {
      state.calls.push(['empty', binding, token]);
      return {
        ok: true,
        schema: serviceModule.TRASH_SCHEMA,
        emptiedCount: 1,
        remainingCount: 0,
        responseRecovered: false,
      };
    },
  };
  const handler = handlerModule.createImageTrashHandler({
    assertTrustedSender(event) {
      if (event?.sender?.trusted !== true) throw new Error('UNTRUSTED');
    },
    getCurrentProject: () => state.project,
    getMutationGeneration: () => state.generation,
    getNavigationEpoch: () => state.navigation,
    trashService,
  });
  return {
    state,
    handler,
    itemToken: `iti_${'b'.repeat(48)}`,
    snapshotToken: `its_${'c'.repeat(48)}`,
    event() {
      return { sender: { id: state.senderId, trusted: true } };
    },
  };
}

function exactBinding(item) {
  return {
    webContentsId: 7,
    projectInstanceId: 'project-a',
    rootPath: '/canonical/project-a',
    mutationGeneration: 3,
    navigationEpoch: 5,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, error =>
    error instanceof serviceModule.ImageTrashError && error.code === code);
}

test('list derives all authority in Main and returns only service public data', () => {
  const item = fixture();
  const result = item.handler.list(item.event(), 'project-a');
  assert.deepStrictEqual(item.state.calls, [['list', exactBinding(item)]]);
  assert.deepStrictEqual(result, {
    ok: true,
    schema: serviceModule.TRASH_SCHEMA,
    policy: 'manual_until_restore_or_empty',
    totalCount: 0,
    totalBytes: 0,
    items: [],
    snapshotToken: null,
  });
});

test('restore accepts only an opaque token and forwards the exact current binding', () => {
  const item = fixture();
  const result = item.handler.restore(item.event(), 'project-a', item.itemToken);
  assert.strictEqual(result.restored, true);
  assert.deepStrictEqual(item.state.calls, [
    ['restore', exactBinding(item), item.itemToken],
  ]);
});

test('empty accepts only an opaque snapshot token and forwards no item list', () => {
  const item = fixture();
  const result = item.handler.empty(item.event(), 'project-a', item.snapshotToken);
  assert.strictEqual(result.emptiedCount, 1);
  assert.deepStrictEqual(item.state.calls, [
    ['empty', exactBinding(item), item.snapshotToken],
  ]);
});

test('foreign project and stale project state fail before filesystem service calls', () => {
  for (const mutate of [
    item => { item.state.project = null; },
    item => { item.state.project = { instanceId: 'project-b', rootPath: '/canonical/project-b' }; },
    item => { item.state.generation = -1; },
    item => { item.state.navigation = Number.MAX_SAFE_INTEGER + 1; },
    item => { item.state.senderId = 0; },
  ]) {
    const item = fixture();
    mutate(item);
    expectCode('IMAGE_TRASH_STALE', () =>
      item.handler.list(item.event(), 'project-a'));
    assert.strictEqual(item.state.calls.length, 0);
  }
});

test('malformed, smuggled and non-string capabilities never reach the service', () => {
  for (const token of [
    null,
    '',
    `irv_${'a'.repeat(48)}`,
    `iti_${'a'.repeat(47)}`,
    `its_${'a'.repeat(48)}`,
    { token: `iti_${'a'.repeat(48)}`, rootPath: '/smuggled' },
  ]) {
    const item = fixture();
    expectCode('IMAGE_TRASH_REQUEST_INVALID', () =>
      item.handler.restore(item.event(), 'project-a', token));
    assert.strictEqual(item.state.calls.length, 0);
  }
});

test('untrusted callers never reach list, restore or empty authority', () => {
  const item = fixture();
  const event = { sender: { id: 7, trusted: false } };
  for (const invoke of [
    () => item.handler.list(event, 'project-a'),
    () => item.handler.restore(event, 'project-a', item.itemToken),
    () => item.handler.empty(event, 'project-a', item.snapshotToken),
  ]) {
    assert.throws(invoke, /UNTRUSTED/);
  }
  assert.strictEqual(item.state.calls.length, 0);
});

test('constructor rejects incomplete authority dependencies', () => {
  assert.throws(() => handlerModule.createImageTrashHandler({}), /assertTrustedSender/);
  assert.throws(() => handlerModule.createImageTrashHandler({
    assertTrustedSender() {},
    getCurrentProject() {},
    getMutationGeneration() {},
    getNavigationEpoch() {},
    trashService: { list() {}, restore() {} },
  }), /trashService/);
});

console.log(`\n✅ image trash handler ${passed}/${passed} checks passed.\n`);
