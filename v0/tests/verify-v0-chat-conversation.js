#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Conversation = require('../src/main/chat-conversation-service');

let passed = 0;
function check(label, run) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function binding(overrides = {}) {
  return {
    ownerId: 'webcontents:1',
    navigationEpoch: 3,
    projectInstanceId: 'project-a',
    rootPath: '/private/project-a',
    contextGeneration: 7,
    ...overrides,
  };
}

console.log('════════ WritCraft V0 · Chat conversation service ════════');

check('第一轮不伪造历史，提交后第二轮只读取 Main 持有的最近对话', () => {
  const store = Conversation.createChatConversationStore();
  const first = store.begin(binding(), '第一问');
  assert.equal(first.summary.text, '');
  assert.equal(first.summary.includedTurnCount, 0);
  assert.equal(first.resetReason, null);
  assert.deepEqual(store.commit(first, '第一答'), {
    schema: Conversation.PUBLIC_STATE_SCHEMA,
    turnCount: 1,
    resetReason: null,
  });

  const second = store.begin(binding(), '第二问');
  assert.match(second.summary.text, /第 1 轮[\s\S]*用户：第一问[\s\S]*助手：第一答/);
  assert.equal(second.summary.includedTurnCount, 1);
  assert.equal(second.summary.totalTurnCount, 1);
  assert(!Object.keys(second.summary).some(key => /root|path|project|owner|session/i.test(key)));
});

check('最近摘要按轮次和 UTF-8 双预算裁剪，永不返回完整无限历史', () => {
  const store = Conversation.createChatConversationStore();
  for (let index = 0; index < Conversation.MAX_STORED_TURNS + 4; index += 1) {
    const lease = store.begin(binding(), `问题${index}：${'问🚀'.repeat(1000)}`);
    store.commit(lease, `回答${index}：${'答🚀'.repeat(2000)}`);
  }
  const next = store.begin(binding(), '继续');
  assert(next.summary.totalTurnCount <= Conversation.MAX_STORED_TURNS);
  assert(next.summary.includedTurnCount <= next.summary.totalTurnCount);
  assert(Array.from(next.summary.text).length <= Conversation.MAX_SUMMARY_CHARS);
  assert(Buffer.byteLength(next.summary.text, 'utf8') <= Conversation.MAX_SUMMARY_BYTES);
  assert(!next.summary.text.includes('问题0：'));
  assert(next.summary.text.includes(`问题${Conversation.MAX_STORED_TURNS + 3}：`));
});

check('项目、Renderer 导航或上下文 generation 漂移会终止旧请求并创建空白新会话', () => {
  for (const drift of [
    { projectInstanceId: 'project-b', rootPath: '/private/project-b' },
    { navigationEpoch: 4 },
    { contextGeneration: 8 },
  ]) {
    const store = Conversation.createChatConversationStore();
    const first = store.begin(binding(), '旧问题');
    store.commit(first, '旧回答');
    const pending = store.begin(binding(), '旧在途问题');
    const fresh = store.begin(binding(drift), '新问题');
    assert.equal(pending.signal.aborted, true);
    assert.equal(fresh.summary.text, '');
    assert.equal(fresh.summary.includedTurnCount, 0);
    assert.equal(fresh.resetReason, drift.navigationEpoch ? 'chat_reopened'
      : drift.contextGeneration ? 'context_changed' : 'project_changed');
    assert.throws(() => store.commit(pending, '迟到旧回答'), /CHAT_CONVERSATION_STALE/);
  }
});

check('同一会话的新请求抢占旧请求，只有最新 lease 可以提交', () => {
  const store = Conversation.createChatConversationStore();
  const first = store.begin(binding(), '慢问题');
  const second = store.begin(binding(), '快问题');
  assert.equal(first.signal.aborted, true);
  assert.throws(() => store.commit(first, '迟到回答'), /CHAT_CONVERSATION_STALE/);
  assert.deepEqual(store.commit(second, '最新回答'), {
    schema: Conversation.PUBLIC_STATE_SCHEMA,
    turnCount: 1,
    resetReason: null,
  });
  assert.equal(store.inspect(binding()).turns[0].user, '快问题');
});

check('新提交只取消 Main 在途轮次，不清除已确认历史', () => {
  const store = Conversation.createChatConversationStore();
  const committed = store.begin(binding(), '已确认问题');
  store.commit(committed, '已确认回答');
  const hidden = store.begin(binding(), '不可见在途问题');
  assert.equal(store.cancelPending(binding()), true);
  assert.equal(hidden.signal.aborted, true);
  assert.throws(() => store.commit(hidden, '不可见回答'), /CHAT_CONVERSATION_STALE/);
  const next = store.begin(binding(), '新问题');
  assert.equal(next.summary.includedTurnCount, 1);
  assert(next.summary.text.includes('已确认问题'));
  assert(!next.summary.text.includes('不可见在途问题'));
});

check('失败请求只释放 lease，不写入伪历史；显式新对话会清空并中止在途请求', () => {
  const store = Conversation.createChatConversationStore();
  const failed = store.begin(binding(), '失败问题');
  assert.equal(store.finish(failed), true);
  assert.equal(store.inspect(binding()).turns.length, 0);
  const committed = store.begin(binding(), '保留问题');
  store.commit(committed, '保留回答');
  const pending = store.begin(binding(), '在途问题');
  assert.equal(store.reset(binding()), true);
  assert.equal(pending.signal.aborted, true);
  assert.equal(store.inspect(binding()), null);
  const fresh = store.begin(binding(), '新会话问题');
  assert.equal(fresh.summary.text, '');
  assert.equal(fresh.resetReason, 'user_reset');
});

check('Main Manifest 只披露有界轮数和大小，不泄露摘要正文或内部 session ID', () => {
  const base = Object.freeze({
    scope: 'file',
    currentFilePath: 'chapters/01.md',
    budgetChars: 10000,
    budgetBytes: 32768,
    usedChars: 500,
    usedBytes: 800,
    chips: Object.freeze([{ id: 'scope:file', type: 'scope' }]),
  });
  const summary = Object.freeze({
    text: '第 1 轮\n用户：问题\n助手：回答',
    includedTurnCount: 1,
    totalTurnCount: 2,
    chars: 21,
    bytes: 45,
  });
  const manifest = Conversation.attachSummaryToManifest(base, summary);
  assert.equal(manifest.conversation.includedTurnCount, 1);
  assert.equal(manifest.conversation.totalTurnCount, 2);
  assert.equal(manifest.conversation.bytes, 45);
  assert.equal(manifest.usedChars, 521);
  assert.equal(manifest.usedBytes, 845);
  assert.equal(manifest.budgetChars, 10000 + Conversation.MAX_SUMMARY_CHARS);
  assert.equal(manifest.budgetBytes, 32768 + Conversation.MAX_SUMMARY_BYTES);
  assert(!JSON.stringify(manifest).includes('问题'));
  assert(!JSON.stringify(manifest).includes('回答'));
  assert(Object.isFrozen(manifest.conversation));
  assert.strictEqual(Conversation.attachSummaryToManifest(base, { ...summary, text: '' }), base);
});

check('公开状态固定为最小字段，不包含正文、路径、owner、generation 或内部标识', () => {
  const store = Conversation.createChatConversationStore();
  const lease = store.begin(binding(), '隐私问题');
  const state = store.commit(lease, '隐私回答');
  assert.deepEqual(Object.keys(state), ['schema', 'turnCount', 'resetReason']);
  const serialized = JSON.stringify(state);
  for (const forbidden of ['隐私问题', '隐私回答', '/private', 'project-a', 'webcontents', 'generation', 'session']) {
    assert(!serialized.includes(forbidden), forbidden);
  }
});

assert.strictEqual(passed, 8);
if (!process.exitCode) console.log(`\n✅ Chat Conversation ${passed}/8 全过`);
