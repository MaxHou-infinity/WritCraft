'use strict';

const assert = require('assert');
const crypto = require('crypto');
const navigationService = require('../src/main/writing-navigation-service');
const navigationStoreService = require('../src/main/writing-navigation-store');
const handoffService = require('../src/main/writing-navigation-handoff-service');
const handlerModule = require('../src/main/writing-navigation-action-handler');
const changeSetService = require('../src/main/changeset-service');
const localizedEditService = require('../src/main/localized-edit-service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

const PROJECT = Object.freeze({
  instanceId: 'instance_0123456789abcdef01234567',
  rootPath: '/tmp/writcraft-navigation-action',
});
const EVENT = Object.freeze({ sender: Object.freeze({ id: 7 }) });
const OWNER = 'webcontents:7';
const CHAPTER = '# 第一章\n\n这是作者已经写下的正文证据。\n';

function revision(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function structuredModel(edits) {
  return {
    ok: true,
    stopReason: 'tool_use',
    toolUseBlockCount: 1,
    toolUse: {
      name: 'submit_unified_writing_task',
      input: { status: 'changes', edits, reason: '', question: '' },
    },
  };
}

function noopModel() {
  return structuredModel([{
    rangeId: 'range_1',
    oldText: '这是作者已经写下的正文证据。',
    newText: '这是作者已经写下的正文证据。',
    summary: '保持原文',
  }]);
}

function needsSourcesModel() {
  return {
    ok: true,
    stopReason: 'tool_use',
    toolUseBlockCount: 1,
    toolUse: {
      name: 'submit_unified_writing_task',
      input: {
        status: 'needs_sources',
        edits: [],
        reason: '缺少支持该事实的来源',
        question: '请选择一项能够支持该事实的来源',
      },
    },
  };
}

function fakeProject() {
  const files = new Map([
    ['edit.md', '# 项目说明\n\n项目 Prompt。\n'],
    ['chapters/01.md', CHAPTER],
    ['references/source.md', '# 来源\n\n一项可核对的事实。\n'],
  ]);
  return {
    files,
    listTree: () => [
      { type: 'file', path: 'edit.md' },
      {
        type: 'directory',
        path: 'chapters',
        children: [{ type: 'file', path: 'chapters/01.md' }],
      },
      {
        type: 'directory',
        path: 'references',
        children: [{ type: 'file', path: 'references/source.md' }],
      },
    ],
    readFileWithRevision(_root, filePath) {
      if (!files.has(filePath)) throw new Error('NOT_FOUND');
      const content = files.get(filePath);
      return { content, revision: revision(content) };
    },
  };
}

async function setup(action, overrides = {}) {
  const projectService = fakeProject();
  const store = navigationStoreService.createWritingNavigationStore();
  const proposal = await navigationService.proposeWritingNavigation({
    projectService,
    rootPath: PROJECT.rootPath,
    request: {
      schema: navigationService.REQUEST_SCHEMA,
      mode: 'navigation',
      goal: '告诉我下一步',
      currentFilePath: 'chapters/01.md',
      contextPaths: [],
    },
    callLLM: async (_messages, _model, _tokens, options) => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: navigationService.TOOL_NAME,
        input: {
          mode: 'navigation',
          suggestions: [{
            finding: '当前段落还缺少具体例子。',
            evidenceRefs: [
              options.tools[0].input_schema.properties.suggestions.items.properties
                .evidenceRefs.items.enum[0],
            ],
            whyNow: '现在补充便于后文展开。',
            recommendedAction: '补充一个具体例子。',
            expectedResult: '读者更容易理解。',
            action,
          }],
        },
      },
    }),
  });
  let currentProject = PROJECT;
  let generation = 5;
  let navigationEpoch = 2;
  let pending = false;
  let modelCalls = 0;
  let cacheCalls = 0;
  let providerOptionsSeen = null;
  let maxTokensSeen = null;
  const discarded = [];
  const installed = store.install({
    ownerId: OWNER,
    projectInstanceId: PROJECT.instanceId,
    rootPath: PROJECT.rootPath,
    mutationGeneration: generation,
    navigationEpoch,
    record: proposal.record,
  });
  const options = {
    assertTrustedSender() {},
    requireCurrentProject: () => currentProject,
    getCurrentProject: () => currentProject,
    getMutationGeneration: () => generation,
    getRendererNavigationEpoch: () => navigationEpoch,
    settleProjectAuthority: async () => {},
    writingNavigationStore: store,
    handoffService,
    projectService,
    projectCallLLM: () => async (_messages, _model, tokens, providerOptions) => {
        modelCalls += 1;
        maxTokensSeen = tokens;
        providerOptionsSeen = providerOptions;
        return structuredModel([{
              rangeId: 'range_1',
              oldText: '这是作者已经写下的正文证据。',
              newText: '这是作者已经写下的正文证据，例如一次真实访谈。',
              summary: '补充例子',
            }]);
      },
    changeSetService,
    sourceIndexService: {
      buildSourceIndex: () => ({
        sources: [{ id: `src_${'b'.repeat(20)}`, filePath: 'references/source.md' }],
      }),
    },
    pendingChangeSets: {
      hasForRoot: () => pending,
    },
    cacheReview(changeSet, _project, metadata) {
      cacheCalls += 1;
      return {
        capability: `pc_${'a'.repeat(32)}`,
        review: {
          changeSetId: `pc_${'a'.repeat(32)}`,
          files: changeSet.changes.map(change => ({ path: change.path })),
        },
        metadata,
      };
    },
    discardReview(capability, reason) {
      discarded.push({ capability, reason });
    },
    staleAiProjectResult: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({
      ok: false,
      error: typeof error?.code === 'string' ? error.code : 'NAVIGATION_ACTION_FAILED',
      message: '动作没有完成',
    }),
    ...overrides,
  };
  const rawHandler = handlerModule.createWritingNavigationActionHandler(options);
  const rawCancelHandler = handlerModule.createCancelWritingNavigationActionHandler(options);
  let attemptSequence = 0;
  const nextAttempt = () => {
    attemptSequence += 1;
    return `wno_${attemptSequence.toString(16).padStart(32, '0')}`;
  };
  return {
    handler: (event, projectInstanceId, actionId, attemptId = nextAttempt(), adjustment = '', sourceIds = []) =>
      rawHandler(event, projectInstanceId, actionId, attemptId, adjustment, sourceIds),
    cancelHandler: (event, projectInstanceId, actionId, attemptId) =>
      rawCancelHandler(event, projectInstanceId, actionId, attemptId),
    nextAttempt,
    store,
    actionId: installed.suggestions[0].actionIds[action],
    projectService,
    get modelCalls() { return modelCalls; },
    get cacheCalls() { return cacheCalls; },
    get providerOptionsSeen() { return providerOptionsSeen; },
    get maxTokensSeen() { return maxTokensSeen; },
    discarded,
    setPending(value) { pending = value; },
    setGeneration(value) { generation = value; },
    setProject(value) { currentProject = value; },
    binding(extra = {}) {
      return {
        ownerId: OWNER,
        projectInstanceId: PROJECT.instanceId,
        rootPath: PROJECT.rootPath,
        mutationGeneration: generation,
        navigationEpoch,
        ...extra,
      };
    },
  };
}

(async () => {
  console.log('\nWriting navigation action handler verification');

  await test('research returns one evidence-bound handoff and remains safely repeatable', async () => {
    const state = await setup('research');
    const first = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(first.kind, 'research');
    assert.strictEqual(first.handoff.evidence[0].path, 'chapters/01.md');
    const replay = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(replay.kind, 'research');
    assert.deepStrictEqual(replay.handoff, first.handoff);
    assert.strictEqual(state.modelCalls, 0);
  });

  await test('an existing Changes review is preserved and the same action can retry', async () => {
    const state = await setup('changes');
    state.setPending(true);
    const blocked = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(blocked.error, 'REVIEW_IN_PROGRESS');
    assert.strictEqual(state.modelCalls, 0);
    state.setPending(false);
    const retry = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.noChanges, false);
  });

  await test('changes makes one model call and installs one review', async () => {
    const state = await setup('changes');
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.fileCount, 1);
    assert.strictEqual(result.changeSetId, `pc_${'a'.repeat(32)}`);
    assert.strictEqual(state.modelCalls, 1);
    assert.strictEqual(state.cacheCalls, 1);
    assert.strictEqual(state.providerOptionsSeen.tools[0].name, 'submit_unified_writing_task');
    assert.deepStrictEqual(
      state.providerOptionsSeen.tools[0].input_schema.properties.edits.items.properties.rangeId.enum,
      ['range_1']
    );
    assert.deepStrictEqual(state.providerOptionsSeen.toolChoice, {
      type: 'tool', name: 'submit_unified_writing_task',
    });
  });

  await test('needs-sources keeps the same action reusable and creates no review', async () => {
    let calls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        calls += 1;
        return calls === 1 ? needsSourcesModel() : noopModel();
      },
    });
    const first = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(first.kind, 'needs_sources');
    assert.strictEqual(first.handoff.suggestionId, 'suggestion_1');
    assert.strictEqual(state.cacheCalls, 0);
    const second = await state.handler(
      EVENT,
      PROJECT.instanceId,
      state.actionId,
      state.nextAttempt(),
      '',
      [`src_${'b'.repeat(20)}`]
    );
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.noChanges, true);
    assert.strictEqual(calls, 2);
  });

  await test('author adjustment and selected source stay read-only context in one explicit retry', async () => {
    let prompt = null;
    const state = await setup('changes', {
      projectCallLLM: () => async messages => {
        prompt = messages.map(message => message.content).join('\n');
        return noopModel();
      },
    });
    const result = await state.handler(
      EVENT,
      PROJECT.instanceId,
      state.actionId,
      state.nextAttempt(),
      '保留作者语气',
      [`src_${'b'.repeat(20)}`]
    );
    assert.strictEqual(result.ok, true);
    assert.match(prompt, /作者继续调整：保留作者语气/);
    assert.match(prompt, /references\/source\.md/);
  });

  await test('Main emits bounded real stages before the Diff capability is returned', async () => {
    const phases = [];
    const event = { sender: { id: 7, send: (_channel, payload) => phases.push(payload.phase) } };
    const state = await setup('changes');
    const result = await state.handler(event, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(phases, ['checking_evidence', 'generating_changes', 'preparing_diff']);
  });

  await test('Main provider work ends before the Renderer-wide 60 second terminal', async () => {
    const delays = [];
    const state = await setup('changes', {
      setTimer(_callback, delay) {
        delays.push(delay);
        return delays.length;
      },
      clearTimer() {},
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(delays, [50_000]);
  });

  await test('a pending review arriving during generation wins without replacement', async () => {
    let state;
    state = await setup('changes', {
      projectCallLLM: () => async () => {
        state.setPending(true);
        return structuredModel([{
            rangeId: 'range_1',
            oldText: '这是作者已经写下的正文证据。',
            newText: '新的内容。',
            summary: '修改',
          }]);
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'REVIEW_IN_PROGRESS');
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('generation drift cannot install a late Changes review', async () => {
    let state;
    state = await setup('changes', {
      projectCallLLM: () => async () => {
        state.setGeneration(6);
        return noopModel();
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'PROJECT_CHANGED');
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('changes deadline aborts the innermost provider and leaves no review', async () => {
    let providerSignal = null;
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async (_messages, _model, _maxTokens, options) => {
        providerCalls += 1;
        providerSignal = options.signal;
        return new Promise(() => {});
      },
      deadlineMs: 1,
      setTimer(callback) {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer() {},
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'TIMEOUT');
    assert.strictEqual(providerSignal.aborted, true);
    assert.strictEqual(state.cacheCalls, 0);
    const retry = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(retry.error, 'TIMEOUT');
    assert.strictEqual(providerCalls, 2);
  });

  await test('explicit owner-bound cancel aborts one request and preserves a retry', async () => {
    let providerCalls = 0;
    let firstSignal = null;
    const state = await setup('changes', {
      projectCallLLM: () => async (_messages, _model, _maxTokens, options) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          firstSignal = options.signal;
          return new Promise(() => {});
        }
        return noopModel();
      },
    });
    const attemptId = state.nextAttempt();
    const running = state.handler(EVENT, PROJECT.instanceId, state.actionId, attemptId);
    while (!firstSignal) await new Promise(resolve => setImmediate(resolve));
    const foreign = await state.cancelHandler(
      { sender: { id: 8 } },
      PROJECT.instanceId,
      state.actionId,
      attemptId
    );
    assert.strictEqual(foreign.error, 'ACTION_NOT_FOUND');
    assert.strictEqual(firstSignal.aborted, false);
    const cancelled = await state.cancelHandler(
      EVENT,
      PROJECT.instanceId,
      state.actionId,
      attemptId
    );
    assert.deepStrictEqual(cancelled, { ok: true, cancelled: true });
    const first = await running;
    assert.strictEqual(first.error, 'REQUEST_ABORTED');
    assert.strictEqual(firstSignal.aborted, true);
    const retry = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.noChanges, true);
  });

  await test('provider failure preserves the current action for an explicit retry', async () => {
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? { ok: false, error: 'LLM_FAILED' }
          : noopModel();
      },
    });
    const failed = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(failed.error, 'LLM_FAILED');
    const retry = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.noChanges, true);
  });

  await test('oversized output is terminal without a hidden paid retry', async () => {
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        return structuredModel([{
          rangeId: 'range_1',
          oldText: '这是作者已经写下的正文证据。',
          newText: 'x'.repeat(641),
          summary: '超大结果',
        }]);
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'PATCH_NEW_TEXT_TOO_LARGE');
    assert.strictEqual(state.cacheCalls, 0);
    assert.strictEqual(providerCalls, 1);
  });

  await test('the Changes model uses the dedicated bounded structured token budget', async () => {
    const state = await setup('changes');
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(state.maxTokensSeen, localizedEditService.STRUCTURED_MAX_TOKENS);
  });

  await test('invalid provider tool result is terminal without a hidden paid retry', async () => {
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        return { ok: false, error: 'INVALID_TOOL_USE' };
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'INVALID_TOOL_USE');
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('repeated invalid provider behavior still costs only the explicit attempt', async () => {
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        return { ok: false, error: 'INVALID_TOOL_USE' };
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'INVALID_TOOL_USE');
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('malformed structure is terminal after one paid call', async () => {
    let providerCalls = 0;
    const state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        return structuredModel([{
          rangeId: 'range_1',
          oldText: '这是作者已经写下的正文证据。',
          newText: 'x'.repeat(641),
          summary: '仍然超限',
        }]);
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'PATCH_NEW_TEXT_TOO_LARGE');
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('dependency drift after the first structure failure blocks the paid retry', async () => {
    let state;
    let providerCalls = 0;
    state = await setup('changes', {
      projectCallLLM: () => async () => {
        providerCalls += 1;
        state.projectService.files.set('chapters/01.md', `${CHAPTER}\n外部变化`);
        return structuredModel([{
          rangeId: 'range_1',
          oldText: '这是作者已经写下的正文证据。',
          newText: 'x'.repeat(641),
          summary: '超限',
        }]);
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.error, 'NAVIGATION_STALE');
    assert.strictEqual(providerCalls, 1);
    assert.strictEqual(state.cacheCalls, 0);
  });

  await test('attempt A late cancel cannot abort active retry B', async () => {
    let providerCalls = 0;
    let retrySignal = null;
    const state = await setup('changes', {
      projectCallLLM: () => async (_messages, _model, _maxTokens, options) => {
        providerCalls += 1;
        if (providerCalls === 1) return { ok: false, error: 'LLM_FAILED' };
        retrySignal = options.signal;
        return new Promise(() => {});
      },
    });
    const attemptA = `wno_${'d'.repeat(32)}`;
    const attemptB = `wno_${'e'.repeat(32)}`;
    const first = await state.handler(EVENT, PROJECT.instanceId, state.actionId, attemptA);
    assert.strictEqual(first.error, 'LLM_FAILED');
    const retry = state.handler(EVENT, PROJECT.instanceId, state.actionId, attemptB);
    while (!retrySignal) await new Promise(resolve => setImmediate(resolve));
    const staleCancel = await state.cancelHandler(
      EVENT,
      PROJECT.instanceId,
      state.actionId,
      attemptA
    );
    assert.strictEqual(staleCancel.error, 'ATTEMPT_NOT_ACTIVE');
    assert.strictEqual(retrySignal.aborted, false);
    const currentCancel = await state.cancelHandler(
      EVENT,
      PROJECT.instanceId,
      state.actionId,
      attemptB
    );
    assert.strictEqual(currentCancel.ok, true);
    assert.strictEqual((await retry).error, 'REQUEST_ABORTED');
  });

  await test('a lost lease after cache rolls back the pending review', async () => {
    let state;
    state = await setup('changes', {
      cacheReview(changeSet) {
        state.store.invalidateProject({
          ownerId: OWNER,
          projectInstanceId: PROJECT.instanceId,
        });
        return {
          capability: `pc_${'b'.repeat(32)}`,
          review: {
            changeSetId: `pc_${'b'.repeat(32)}`,
            files: changeSet.changes.map(change => ({ path: change.path })),
          },
        };
      },
    });
    const result = await state.handler(EVENT, PROJECT.instanceId, state.actionId);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(state.discarded.length, 1);
    assert.strictEqual(state.discarded[0].capability, `pc_${'b'.repeat(32)}`);
  });

  console.log(`\n${passed}/${passed} writing-navigation action handler checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
