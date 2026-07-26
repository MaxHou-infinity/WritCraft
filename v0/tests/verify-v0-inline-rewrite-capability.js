#!/usr/bin/env node
'use strict';

const assert = require('assert');
const storeService = require('../src/main/inline-rewrite-capability-store');

let passed = 0;
function test(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}
function expectCode(code, run) {
  assert.throws(run, error => error instanceof storeService.InlineRewriteCapabilityError && error.code === code);
}
function ids(prefix) {
  let value = 0;
  return () => `${prefix}${(++value).toString(16).padStart(32, '0')}`;
}
function binding(ownerId = 'window:1', navigationEpoch = 1, projectDigit = '1') {
  return {
    projectInstanceId: `instance_${projectDigit.repeat(24)}`,
    rootPath: `/project/${projectDigit}`,
    ownerId,
    navigationEpoch,
  };
}
function proposal(rewriteId, replacement = '改写文本') {
  return {
    outcome: 'review', rewriteId, replacement, summary: '改写摘要',
    contextManifest: { schema: 'writcraft.context-manifest/v1' },
    dependencies: { schema: 'writcraft.inline-rewrite-dependencies/v1' },
    provenance: { schema: 'writcraft.inline-rewrite/v1' },
    changeSet: { id: 'cs_test' }, afterContent: replacement, replacementEndOffset: replacement.length,
  };
}
function makeStore(options = {}) {
  return storeService.createInlineRewriteCapabilityStore({
    rewriteIdFactory: ids('ir_'),
    capabilityIdFactory: ids('irc_'),
    applyLeaseIdFactory: ids('iral_'),
    setTimer: callback => callback,
    clearTimer: () => {},
    ...options,
  });
}
function review(store, owner = binding()) {
  const generation = store.beginGeneration(owner);
  const result = store.completeGeneration(generation.rewriteId, proposal(generation.rewriteId));
  return { owner, generation, result };
}

console.log('════════ WritCraft V0 · Inline Rewrite v1 capability store verify ════════');

test('ir_ audit ID 与 irc_ one-time capability 分离且 review 先进入 ACK pending', () => {
  const store = makeStore();
  const item = review(store);
  assert.match(item.result.rewriteId, storeService.REWRITE_ID_RE);
  assert.match(item.result.capabilityId, storeService.CAPABILITY_ID_RE);
  assert.notEqual(item.result.rewriteId, item.result.capabilityId);
  assert.equal(store.inspect(item.result.rewriteId).state, 'REVIEW_PENDING_ACK');
  assert.deepStrictEqual(Object.keys(item.result), [
    'ok', 'schema', 'outcome', 'rewriteId', 'capabilityId', 'expiresAt', 'replacement', 'summary', 'contextManifest',
  ]);
});

test('每 owner 只有一个活动 rewrite，新 generation abort/revoke 旧请求或 review', () => {
  const store = makeStore();
  const owner = binding();
  const first = store.beginGeneration(owner);
  const second = store.beginGeneration(owner);
  assert.equal(first.signal.aborted, true);
  assert.equal(store.inspect(first.rewriteId), null);
  const reviewResult = store.completeGeneration(second.rewriteId, proposal(second.rewriteId));
  const third = store.beginGeneration(owner);
  assert.equal(store.inspect(reviewResult.rewriteId), null);
  expectCode('INLINE_REWRITE_REPLAYED', () => store.acknowledge(owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: reviewResult.rewriteId, capabilityId: reviewResult.capabilityId,
  }));
  assert.equal(store.inspect(third.rewriteId).state, 'GENERATING');
});

test('ACK exact association/owner/navigation 先校验，wrong pair 不烧毁合法 capability', () => {
  const store = makeStore();
  const first = review(store, binding('window:1'));
  const second = review(store, binding('window:2', 1, '2'));
  expectCode('INLINE_REWRITE_NOT_FOUND', () => store.acknowledge(first.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1',
    rewriteId: first.result.rewriteId,
    capabilityId: second.result.capabilityId,
  }));
  assert.equal(store.inspect(first.result.rewriteId).state, 'REVIEW_PENDING_ACK');
  expectCode('INLINE_REWRITE_NOT_FOUND', () => store.acknowledge({ ...first.owner, navigationEpoch: 2 }, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: first.result.rewriteId, capabilityId: first.result.capabilityId,
  }));
  assert.deepStrictEqual(store.acknowledge(first.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: first.result.rewriteId, capabilityId: first.result.capabilityId,
  }), { ok: true, schema: 'writcraft.inline-rewrite-ack-result/v1', status: 'review' });
  assert.equal(store.inspect(first.result.rewriteId).state, 'REVIEW');
});

test('ACK 30 秒超时、10 分钟 TTL 和 replay 均为 terminal', () => {
  let now = 1000;
  const timers = [];
  const store = makeStore({
    clock: () => now,
    ttlMs: 999999999,
    ackTtlMs: 999999999,
    setTimer(callback, delay) { timers.push({ callback, delay }); return callback; },
    clearTimer() {},
  });
  const pending = review(store);
  assert.equal(timers[0].delay, storeService.DEFAULT_ACK_TTL_MS);
  now += storeService.DEFAULT_ACK_TTL_MS;
  timers[0].callback();
  assert.equal(store.inspect(pending.result.rewriteId), null);
  expectCode('INLINE_REWRITE_ACK_TIMEOUT', () => store.acknowledge(pending.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: pending.result.rewriteId, capabilityId: pending.result.capabilityId,
  }));
  const generating = store.beginGeneration(binding());
  now += storeService.DEFAULT_TTL_MS;
  store.prune();
  assert.equal(generating.signal.aborted, true);
  assert.equal(store.inspect(generating.rewriteId), null);
});

test('ACK deadline 不依赖 timer callback 调度', () => {
  let now = 5000;
  const store = makeStore({
    clock: () => now,
    setTimer: () => ({ delayed: true }),
    clearTimer() {},
  });
  const pending = review(store);
  now += storeService.DEFAULT_ACK_TTL_MS;
  expectCode('INLINE_REWRITE_ACK_TIMEOUT', () => store.acknowledge(pending.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1',
    rewriteId: pending.result.rewriteId,
    capabilityId: pending.result.capabilityId,
  }));
  assert.equal(store.inspect(pending.result.rewriteId), null);
});

test('discard exact payload 支持 GENERATING null IDs 与关联 review，且保留外国记录', () => {
  const store = makeStore();
  const owner1 = binding('window:1');
  const generating = store.beginGeneration(owner1);
  assert.deepStrictEqual(store.discard(owner1, {
    schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: null, capabilityId: null,
  }), { ok: true, schema: 'writcraft.inline-rewrite-discard-result/v1', status: 'discarded' });
  assert.equal(generating.signal.aborted, true);
  const first = review(store, owner1);
  const other = review(store, binding('window:2', 1, '2'));
  expectCode('INLINE_REWRITE_NOT_FOUND', () => store.discard(owner1, {
    schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: first.result.rewriteId, capabilityId: other.result.capabilityId,
  }));
  assert(store.inspect(first.result.rewriteId));
  store.discard(owner1, {
    schema: 'writcraft.inline-rewrite-discard/v1', rewriteId: first.result.rewriteId, capabilityId: first.result.capabilityId,
  });
  assert.equal(store.inspect(first.result.rewriteId), null);
  assert(store.inspect(other.result.rewriteId));
});

test('no-op 保留 rewriteId 但无 capability/TTL，并立即 terminal', () => {
  const store = makeStore();
  const generation = store.beginGeneration(binding());
  const base = proposal(generation.rewriteId, '原文');
  const result = store.completeGeneration(generation.rewriteId, {
    outcome: 'no_op', rewriteId: generation.rewriteId, replacement: '原文', summary: '无需改写',
    contextManifest: base.contextManifest, provenance: base.provenance,
  });
  assert.deepStrictEqual([result.outcome, result.capabilityId, result.expiresAt], ['no_op', null, null]);
  assert.equal(store.inspect(generation.rewriteId), null);
});

test('Apply 必须 REVIEW；marker 失败零写入但永久消费 capability', () => {
  const store = makeStore();
  const item = review(store);
  const payload = {
    schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId,
  };
  expectCode('INLINE_REWRITE_NOT_ACKNOWLEDGED', () => store.beginApply(item.owner, payload, () => {}));
  store.acknowledge(item.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId,
  });
  expectCode('INLINE_REWRITE_WRITE_FAILED', () => store.beginApply(item.owner, payload, () => {
    throw new storeService.InlineRewriteCapabilityError('INLINE_REWRITE_BUSY', 'marker fault');
  }));
  assert.equal(store.inspect(item.result.rewriteId), null);
  expectCode('INLINE_REWRITE_REPLAYED', () => store.beginApply(item.owner, payload, () => {}));

  const retry = review(store);
  store.acknowledge(retry.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: retry.result.rewriteId, capabilityId: retry.result.capabilityId,
  });
  const retryPayload = {
    schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: retry.result.rewriteId, capabilityId: retry.result.capabilityId,
  };
  const events = [];
  const apply = store.beginApply(retry.owner, retryPayload, (_proposal, record) => {
    events.push(`marker:${record.capabilityId}`);
    assert.equal(store.inspect(record.rewriteId).state, 'REVIEW');
  });
  events.push(`apply:${store.inspect(retry.result.rewriteId).state}`);
  assert.deepStrictEqual(events, [`marker:${retry.result.capabilityId}`, 'apply:APPLYING']);
  expectCode('INLINE_REWRITE_REPLAYED', () => store.beginApply(retry.owner, retryPayload, () => {}));
  store.clearOwner(retry.owner.ownerId, retry.owner.navigationEpoch);
  assert.equal(store.inspect(retry.result.rewriteId).state, 'APPLYING');
  assert.equal(store.finishApply(retry.result.rewriteId, apply.applyLeaseId), true);
  assert.equal(store.inspect(retry.result.rewriteId), null);
  expectCode('INLINE_REWRITE_REPLAYED', () => store.finishApply(retry.result.rewriteId, apply.applyLeaseId));
});

test('apply lease 分配失败发生在 marker 之前且 capability 仍永久消费', () => {
  const store = makeStore({ applyLeaseIdFactory: () => 'invalid-lease' });
  const item = review(store);
  store.acknowledge(item.owner, {
    schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId,
  });
  let markerCalls = 0;
  expectCode('INLINE_REWRITE_BUSY', () => store.beginApply(item.owner, {
    schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId,
  }, () => { markerCalls += 1; }));
  assert.equal(markerCalls, 0);
  assert.equal(store.inspect(item.result.rewriteId), null);
  expectCode('INLINE_REWRITE_REPLAYED', () => store.beginApply(item.owner, {
    schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId,
  }, () => {}));
});

test('global LRU 只淘汰其他 owner 非 APPLYING；全槽 APPLYING 时 admission busy', () => {
  const store = makeStore({ maxRecords: 2 });
  const one = review(store, binding('window:1', 1, '1'));
  store.acknowledge(one.owner, { schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: one.result.rewriteId, capabilityId: one.result.capabilityId });
  store.beginApply(one.owner, { schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: one.result.rewriteId, capabilityId: one.result.capabilityId }, () => {});
  const two = review(store, binding('window:2', 1, '2'));
  const three = store.beginGeneration(binding('window:3', 1, '3'));
  assert(store.inspect(one.result.rewriteId));
  assert.equal(store.inspect(two.result.rewriteId), null);
  assert(store.inspect(three.rewriteId));

  const allApplying = makeStore({ maxRecords: 1 });
  const active = review(allApplying, binding('window:a'));
  allApplying.acknowledge(active.owner, { schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: active.result.rewriteId, capabilityId: active.result.capabilityId });
  allApplying.beginApply(active.owner, { schema: 'writcraft.inline-rewrite-apply/v1', rewriteId: active.result.rewriteId, capabilityId: active.result.capabilityId }, () => {});
  expectCode('INLINE_REWRITE_BUSY', () => allApplying.beginGeneration(binding('window:b', 1, '2')));
});

test('payload exact-key/size/ID 校验在任何状态变更前执行', () => {
  const store = makeStore();
  const item = review(store);
  for (const invalid of [
    { schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: item.result.rewriteId, capabilityId: item.result.capabilityId, claim: 'inject' },
    { schema: 'writcraft.inline-rewrite-ack/v1', rewriteId: 'ir_bad', capabilityId: item.result.capabilityId },
  ]) expectCode('INVALID_INLINE_REWRITE', () => store.acknowledge(item.owner, invalid));
  assert.equal(store.inspect(item.result.rewriteId).state, 'REVIEW_PENDING_ACK');
});

if (!process.exitCode) console.log(`\n✅ Inline Rewrite v1 capability store ${passed}/${passed} 全过`);
