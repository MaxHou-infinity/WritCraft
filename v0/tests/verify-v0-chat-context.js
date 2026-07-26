#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Request = require('../src/main/chat-context-request-service');
const ChatState = require('../src/renderer/chat-context-state');
const InspectorState = require('../src/renderer/context-inspector-state');
const AiRequestGuard = require('../src/renderer/ai-request-guard');

let passed = 0;
function check(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function request(scope = 'file', selection = null) {
  return {
    schema: Request.REQUEST_SCHEMA,
    scope,
    message: '检查项目',
    currentFilePath: 'chapters/01.md',
    selection,
    contextPolicy: { excludedChipIds: [] },
  };
}

console.log('════════ WritCraft V0 · Chat scope contract ════════');

check('Renderer 默认作用域只能是可证明选区或文件，项目可显式选择', () => {
  const selection = { filePath: 'chapters/01.md', text: '精确选段', startOffset: 10, endOffset: 14 };
  assert.equal(ChatState.defaultScope(selection), 'selection');
  assert.equal(ChatState.defaultScope(null), 'file');
  assert.equal(ChatState.normalizeScope('project', null), 'project');
  assert.equal(ChatState.normalizeScope('selection', null), 'file');
});

check('Renderer 仅生成六字段 exact request，非选区作用域不上送选段', () => {
  const built = ChatState.createRequest({
    scope: 'project', message: '项目问题', currentFilePath: 'chapters/01.md',
    selection: { filePath: 'chapters/01.md', text: '忽略', startOffset: 0, endOffset: 2 },
    contextPolicy: { excludedChipIds: ['ctx_a'] },
  });
  assert.deepEqual(Object.keys(built), ['schema', 'scope', 'message', 'currentFilePath', 'selection', 'contextPolicy']);
  assert.equal(built.selection, null);
  assert.deepEqual(built.contextPolicy.excludedChipIds, ['ctx_a']);
  assert(Object.isFrozen(built));
});

check('Main exact request 拒绝未知字段、原型伪造、错误枚举与 scope/selection 混用', () => {
  assert.equal(Request.validate({ ...request(), injectedBody: '伪造正文' }).ok, false);
  const forged = Object.create({ hiddenPrompt: '伪造指令' });
  Object.assign(forged, request());
  assert.equal(Request.validate(forged).ok, false);
  assert.equal(Request.validate({ ...request(), scope: 'whole-project' }).ok, false);
  assert.equal(Request.validate({ ...request(), selection: { filePath: 'chapters/01.md', text: '混入', startOffset: 0, endOffset: 2 } }).ok, false);
  assert.equal(Request.validate({ ...request('selection'), selection: null }).ok, false);
});

check('Main 精确选段要求 start/end/text 一致且受 Unicode 字节上限约束', () => {
  const valid = { filePath: 'chapters/01.md', text: '🚀中文', startOffset: 2, endOffset: 6 };
  assert.equal(Request.validate(request('selection', valid)).ok, true);
  assert.equal(Request.validate(request('selection', { ...valid, endOffset: 7 })).ok, false);
  const oversized = '🚀'.repeat(2305);
  assert.equal(Request.validate(request('selection', {
    filePath: 'chapters/01.md', text: oversized, startOffset: 0, endOffset: oversized.length,
  })).ok, false);
});

check('Context inspector 正确显示 project/file/selection 且 scope/retrieval/neighbor 类型完整', () => {
  const manifest = {
    scope: 'project', currentFilePath: 'chapters/01.md', budgetChars: 10000, budgetBytes: 32768,
    usedChars: 1200, usedBytes: 2400,
    chips: [
      { id: 'scope', type: 'scope', scope: 'project', label: '项目作用域', reason: '受限检索', bytes: 30 },
      { id: 'prompt', type: 'project_prompt', label: 'edit.md', filePath: 'edit.md', bytes: 300 },
      { id: 'retrieval', type: 'retrieval', label: '线索', filePath: 'chapters/02.md', heading: '证据', reason: '匹配关键词', bytes: 200 },
      { id: 'neighbor', type: 'neighbor', label: '下一个相邻段落', filePath: 'chapters/01.md', bytes: 100 },
    ],
  };
  const view = InspectorState.toViewModel(InspectorState.createState(manifest, []));
  assert.equal(view.scopeLabel, '项目范围');
  assert.deepEqual(view.chips.map(chip => chip.type), ['scope', 'project_prompt', 'retrieval', 'neighbor']);
  assert.equal(view.chips[0].removable, false);
  assert.equal(view.chips[2].reason, '匹配关键词');
});

check('Reply Context Chip 是可点击 button，entity/source/retrieval/neighbor 只使用 locator 或首条 evidence', () => {
  const listeners = {};
  const button = {
    dataset: {},
    addEventListener(type, handler) { listeners[type] = handler; },
  };
  const chip = {
    type: 'entity', label: '林舟', evidence: [{ path: 'chapters/03.md', start: 42, end: 46 }],
  };
  let revealed = null;
  ChatState.bindChipButton(button, chip, value => { revealed = ChatState.locatorForChip(value); });
  assert.equal(button.type, 'button');
  assert.equal(button.dataset.type, 'entity');
  listeners.click();
  assert.deepEqual(revealed, { filePath: 'chapters/03.md', offset: 42, endOffset: 46 });
  assert.equal(ChatState.locatorForChip({ ...chip, stale: true }), null);
  assert.equal(ChatState.locatorForChip({ type: 'scope', reason: '项目作用域' }), null);
});

check('preflight Chips 具有 request 所有权，迟到请求不能清除新请求或实际回复', () => {
  const ownership = ChatState.createChipOwnership();
  assert.equal(ownership.get(), null);
  assert.deepEqual(ownership.publish(1, 'preflight'), { requestToken: 1, phase: 'preflight' });
  assert.equal(ownership.clearPreflight(2), false);
  assert.deepEqual(ownership.get(), { requestToken: 1, phase: 'preflight' });
  assert.equal(ownership.clearPreflight(1), true);
  assert.equal(ownership.get(), null);

  ownership.publish(2, 'preflight');
  ownership.publish(3, 'preflight');
  assert.equal(ownership.clearPreflight(2), false,
    '迟到的旧请求不能清除更新请求的 preflight Chips');
  assert.equal(ownership.clearPreflight(), true,
    '主动开始新请求可清除当前 preflight 预览');

  ownership.publish(4, 'actual');
  assert.equal(ownership.clearPreflight(4), false,
    'scope/selection/editVersion 失效只能清除 preflight，不能抹掉已发布回复的实际上下文');
  assert.deepEqual(ownership.get(), { requestToken: 4, phase: 'actual' });
  assert.equal(ownership.clearAll(), true);
  assert.throws(() => ownership.publish(0, 'preflight'), /所有权无效/);
  assert.throws(() => ownership.publish(5, 'pending'), /所有权无效/);
});

check('Main 的 PROJECT_CHANGED 权威结果归类为取消，不暴露为普通调用失败', () => {
  assert.equal(ChatState.isAuthoritativeCancellation({ ok: false, error: 'PROJECT_CHANGED' }), true);
  assert.equal(ChatState.isAuthoritativeCancellation({ ok: false, error: 'REQUEST_ABORTED' }), false);
  assert.equal(ChatState.isAuthoritativeCancellation({ ok: true, error: 'PROJECT_CHANGED' }), false);
  assert.equal(ChatState.isAuthoritativeCancellation(null), false);
});

check('Editor 回复上下文创建 button 并将点击交给 workspace 的 fail-closed reveal', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/editor.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/workspace.js'), 'utf8');
  assert.match(editor, /bindResponseContext[\s\S]*createElement\('button'\)[\s\S]*bindChipButton/);
  assert.match(workspace, /locatorForChip\?\.\(chip\)/);
  assert.match(workspace, /上下文 revision 已过期/);
  assert.match(workspace, /未猜测新段落位置/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function checkAsync(label, run) {
  try { await run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}

async function verifyConcurrentLifecycle() {
  const state = {
    project: { instanceId: 'project-a' },
    editContextRevision: 'prompt-r1',
    currentPath: 'chapters/01.md',
    revision: 'file-r1',
    editVersion: 4,
    aiContextGeneration: 2,
  };
  const selectionA = { filePath: state.currentPath, text: '精确选段 A', startOffset: 10, endOffset: 16 };
  const selectionB = { filePath: state.currentPath, text: '精确选段 B', startOffset: 20, endOffset: 26 };
  const interaction = selection => ({ scope: 'selection', currentFilePath: state.currentPath, selection });
  const requestFor = selection => request('selection', selection);
  let activeToken = 1;
  let modelCalls = 0;
  let inspectorWrites = 0;
  let chipWrites = 0;
  let answerWrites = 0;

  function capture(token, selection) {
    return AiRequestGuard.captureChat(AiRequestGuard.capture(state), requestFor(selection), token);
  }

  async function runPipeline(guard, selection, preflightPromise, modelPromise) {
    await preflightPromise;
    if (!AiRequestGuard.matchesChat(guard, state, activeToken, interaction(selection))) return 'stale-before-model';
    modelCalls += 1;
    const result = await modelPromise;
    if (!AiRequestGuard.matchesChat(guard, state, activeToken, interaction(selection))) return 'stale-before-publish';
    inspectorWrites += 1;
    chipWrites += 1;
    answerWrites += 1;
    return result;
  }

  const firstGuard = capture(1, selectionA);
  assert.equal(firstGuard.requestToken, 1);
  assert.equal(firstGuard.projectInstanceId, 'project-a');
  assert.equal(firstGuard.currentPath, 'chapters/01.md');
  assert.equal(firstGuard.currentRevision, 'file-r1');
  assert.deepEqual(firstGuard.selection, selectionA);

  // A newer request supersedes a slow preflight. The old request must stop at
  // the actual model-call boundary and must publish nothing.
  const slowPreflight = deferred();
  const firstRun = runPipeline(firstGuard, selectionA, slowPreflight.promise, Promise.resolve('old'));
  activeToken = 2;
  const secondGuard = capture(2, selectionA);
  slowPreflight.resolve({ ok: true });
  assert.equal(await firstRun, 'stale-before-model');
  assert.equal(modelCalls, 0);
  assert.equal(inspectorWrites + chipWrites + answerWrites, 0);

  // The newest request may complete and atomically own all reply surfaces.
  assert.equal(await runPipeline(secondGuard, selectionA, Promise.resolve(), Promise.resolve('new')), 'new');
  assert.deepEqual([modelCalls, inspectorWrites, chipWrites, answerWrites], [1, 1, 1, 1]);

  // If a newer request starts after the old model call, the old result is
  // still forbidden from overwriting Inspector, chips or answer UI.
  activeToken = 3;
  const thirdGuard = capture(3, selectionA);
  const slowModel = deferred();
  const thirdRun = runPipeline(thirdGuard, selectionA, Promise.resolve(), slowModel.promise);
  await Promise.resolve();
  assert.equal(modelCalls, 2);
  activeToken = 4;
  capture(4, selectionA);
  slowModel.resolve('late-old');
  assert.equal(await thirdRun, 'stale-before-publish');
  assert.deepEqual([inspectorWrites, chipWrites, answerWrites], [1, 1, 1]);

  // Same-project file/revision switches and exact-selection changes are part
  // of the guard, not merely the project instance ID.
  const selectionGuard = capture(5, selectionA);
  activeToken = 5;
  assert.equal(AiRequestGuard.matchesChat(selectionGuard, state, activeToken, interaction(selectionB)), false);
  state.currentPath = 'chapters/02.md';
  state.revision = 'file-r2';
  assert.equal(AiRequestGuard.matchesChat(selectionGuard, state, activeToken, {
    scope: 'selection', currentFilePath: state.currentPath,
    selection: { ...selectionA, filePath: state.currentPath },
  }), false);
}

async function verifyPreAwaitIntentFreeze() {
  const selectionA = { filePath: 'chapters/01.md', text: '精确选段 A', startOffset: 10, endOffset: 16 };
  const selectionB = { filePath: 'chapters/01.md', text: '精确选段 B', startOffset: 20, endOffset: 26 };
  const state = {
    project: { instanceId: 'project-a' }, editContextRevision: 'prompt-r1',
    currentPath: 'chapters/01.md', revision: 'file-r1', editVersion: 4,
    aiContextGeneration: 2, openGeneration: 7,
    activeChatRequestToken: 11, dirty: true, savePromise: null,
  };
  let liveSelection = selectionA;
  const interaction = () => ({ scope: 'selection', currentFilePath: state.currentPath, selection: liveSelection });
  const originalRequest = request('selection', selectionA);
  const intent = AiRequestGuard.captureChatIntent(state, originalRequest, 11);
  assert(intent);
  assert.equal(intent.message, originalRequest.message);
  assert.equal(intent.currentPath, 'chapters/01.md');
  assert.equal(intent.currentRevision, 'file-r1');
  assert.equal(intent.openGeneration, 7);
  assert.deepEqual(intent.selection, selectionA);

  // Exercise the production preparation transaction with a controlled slow
  // persist. Switching A -> B before it resolves must not recapture B.
  const saveGate = deferred();
  let settleCalls = 0;
  const pathDrift = AiRequestGuard.prepareChatIntent(intent, {
    getState: () => state,
    getInteraction: interaction,
    persist: async () => {
      await saveGate.promise;
      state.revision = 'file-r1-own-save';
      state.dirty = false;
      return true;
    },
    settle: async () => { settleCalls += 1; },
    canUseAI: () => true,
  });
  // openFile increments this synchronously before it awaits the same dirty
  // save, so even a not-yet-committed A -> B navigation is observable.
  state.openGeneration += 1;
  saveGate.resolve(true);
  assert.deepEqual(await pathDrift, { ok: false, reason: 'CHAT_INTENT_STALE' });
  assert.equal(settleCalls, 0);
  assert.equal(intent.currentPath, 'chapters/01.md');

  // Reset and prove that a selection change during watcher settling is also
  // rejected after the successful own-save revision transition.
  Object.assign(state, {
    currentPath: 'chapters/01.md', revision: 'file-r1', editVersion: 4,
    aiContextGeneration: 2, openGeneration: 7,
    activeChatRequestToken: 12, dirty: true,
  });
  liveSelection = selectionA;
  const selectionIntent = AiRequestGuard.captureChatIntent(state, originalRequest, 12);
  const settleGate = deferred();
  const selectionDrift = AiRequestGuard.prepareChatIntent(selectionIntent, {
    getState: () => state,
    getInteraction: interaction,
    persist: async () => { state.revision = 'file-r1-saved'; state.dirty = false; return true; },
    settle: () => settleGate.promise,
    canUseAI: () => true,
  });
  await Promise.resolve();
  liveSelection = selectionB;
  settleGate.resolve();
  assert.deepEqual(await selectionDrift, { ok: false, reason: 'CHAT_INTENT_STALE' });

  // The only permitted drift is the revision produced by persistence of the
  // frozen file; with all identity fields unchanged preparation succeeds.
  Object.assign(state, {
    currentPath: 'chapters/01.md', revision: 'file-r1', editVersion: 4,
    aiContextGeneration: 2, openGeneration: 7,
    activeChatRequestToken: 13, dirty: true,
  });
  liveSelection = selectionA;
  const ownSaveIntent = AiRequestGuard.captureChatIntent(state, originalRequest, 13);
  const prepared = await AiRequestGuard.prepareChatIntent(ownSaveIntent, {
    getState: () => state,
    getInteraction: interaction,
    persist: async () => { state.revision = 'file-r1-own-save'; state.dirty = false; return true; },
    settle: async () => {},
    canUseAI: () => true,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.aiGuard.currentPath, 'chapters/01.md');
  assert.equal(prepared.aiGuard.currentRevision, 'file-r1-own-save');
  assert.equal(ownSaveIntent.currentRevision, 'file-r1');
}

check('Editor/Workspace 把同一 token guard 贯穿 preflight、模型边界与回复发布', () => {
  const editor = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/editor.js'), 'utf8');
  const workspace = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/workspace.js'), 'utf8');
  assert.match(editor, /beginChatRequest\?\.\(requestToken, aiGuard, contextRequest\)/);
  assert.match(editor, /supersedeChatRequest\?\.\(requestToken\)/);
  assert.match(editor, /captureChatRequestIntent\?\.\(requestToken, contextRequest\)/);
  assert(editor.indexOf('captureChatRequestIntent?.(requestToken, contextRequest)') < editor.indexOf('await prepareChatRequestGuard(chatIntent)'));
  assert.match(editor, /resolveContextSelections\?\.\(contextRequest, chatGuard\)/);
  assert(editor.indexOf('if (stopIfStale()) return;\n    let result;') < editor.indexOf('await window.writCraft.chat'));
  assert.match(editor, /markChatRequestCanceled\(userMessageNode/);
  assert.match(editor, /if \(chatContextState\.isAuthoritativeCancellation\?\.\(result\)\)[\s\S]*markChatRequestCanceled/);
  assert.doesNotMatch(editor, /contextRequest && chatContextState\.isAuthoritativeCancellation/);
  assert.match(workspace, /matchesChat\([\s\S]*state\.activeChatRequestToken/);
  assert.match(editor, /renderContextChips\(selectedContext\?\.chips \|\| \[\], \{[\s\S]*phase: 'preflight',[\s\S]*chatGuard/);
  assert.match(editor, /renderContextChips\(actualChips, \{ requestToken, phase: 'actual' \}\)/);
  assert.match(editor, /clearPreflightContextChips\(requestToken\);[\s\S]*markChatRequestCanceled/);
  assert.match(editor, /chatScope = normalized;[\s\S]*clearStalePreflightContextChips\(\)/);
  assert.match(editor, /queueMicrotask\(clearStalePreflightContextChips\)/);
  assert.match(editor, /if \(chatScope === 'selection'\) clearStalePreflightContextChips\(\)/);
});

checkAsync('预保存 intent、后发请求、文件切换与选段变化会在真实生产异步边界废弃旧 Chat', async () => {
  await verifyPreAwaitIntentFreeze();
  await verifyConcurrentLifecycle();
})
  .then(() => {
    if (!process.exitCode) console.log(`\n✅ Chat context ${passed}/${passed} 全过`);
  });
