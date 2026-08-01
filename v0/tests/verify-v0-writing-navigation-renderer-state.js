'use strict';

const assert = require('assert');
const State = require('../src/renderer/writing-navigation-state');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PROJECT_A = 'instance_0123456789abcdef01234567';
const PROJECT_B = 'instance_abcdef0123456789abcdef01';
const GENERATION_A = `wno_${'a'.repeat(32)}`;
const GENERATION_B = `wno_${'b'.repeat(32)}`;
const ACTION_A = `wno_${'c'.repeat(32)}`;
const ACTION_B = `wno_${'d'.repeat(32)}`;
const NAVIGATION_ID = `nav_${'e'.repeat(32)}`;
const ACTION_ID = `wna_${'f'.repeat(32)}`;

const tree = (...paths) => paths.map(path => ({ type: 'file', path }));

function manifest(used, available, limited = false) {
  return {
    usedBodyCount: used,
    availableBodyCount: available,
    omittedBodyCount: available - used,
    totalBodyBytes: 1024,
    limitedProjectIntent: limited,
    files: [
      { path: 'edit.md', role: 'project_prompt', revision: '1'.repeat(64), bytes: 12 },
      ...(used ? [{ path: 'chapters/01.md', role: 'current_file', revision: '2'.repeat(64), bytes: 1012 }] : []),
    ],
    omissionReason: used === available ? null : 'not_selected',
    truncationReason: null,
    disclosure: used === available
      ? '已读取当前项目全部正文'
      : `只基于本次已读取的 ${used}/${available} 个正文文件`,
  };
}

function structureResult() {
  return {
    schema: 'writcraft.writing-navigation/v1',
    navigationId: NAVIGATION_ID,
    mode: 'structure',
    alternatives: [
      {
        alternativeId: 'alternative_1',
        organizingLogic: '沿问题推进',
        audienceBenefit: '快速建立理解',
        tradeoff: '案例较少',
        chapters: [
          { path: 'chapters/01.md', title: '问题', purpose: '说明问题' },
          { path: 'chapters/02.md', title: '方法', purpose: '提出方法' },
        ],
      },
      {
        alternativeId: 'alternative_2',
        organizingLogic: '沿案例推进',
        audienceBenefit: '更容易代入',
        tradeoff: '理论较晚出现',
        chapters: [
          { path: 'chapters/01.md', title: '案例', purpose: '建立场景' },
          { path: 'chapters/02.md', title: '总结', purpose: '提炼框架' },
        ],
      },
    ],
    contextManifest: manifest(0, 0, true),
  };
}

function navigationResult() {
  return {
    schema: 'writcraft.writing-navigation/v1',
    navigationId: NAVIGATION_ID,
    mode: 'navigation',
    suggestions: [{
      suggestionId: 'suggestion_1',
      actionId: ACTION_ID,
      actionIds: { research: ACTION_ID, changes: `wna_${'e'.repeat(32)}` },
      finding: '开篇缺少问题边界',
      evidence: [{
        relativePath: 'chapters/01.md',
        revision: '2'.repeat(64),
        sectionHeading: '开篇',
        quote: '团队需要先定义问题。',
        locator: {
          filePath: 'chapters/01.md',
          revision: '2'.repeat(64),
          offset: 8,
          endOffset: 18,
          line: 3,
          column: 1,
          blockAnchor: { schema: 'writcraft.block-anchor/v1' },
        },
      }],
      whyNow: '它影响后续章节',
      recommendedAction: '补充范围说明',
      expectedResult: '读者更容易跟随',
      action: 'changes',
    }],
    contextManifest: manifest(1, 3),
  };
}

console.log('\nWriting Navigation Renderer state verification');

test('project tree selects structure for an empty project and navigation for a manuscript', () => {
  assert.strictEqual(State.modeForTree(tree('edit.md')), 'structure');
  assert.strictEqual(State.modeForTree(tree('edit.md', 'references/a.md', 'sources/b.md')), 'structure');
  assert.strictEqual(State.modeForTree(tree('edit.md', 'chapters/01.md')), 'navigation');
});

test('project switch resets all prior authority and increments the epoch', () => {
  let state = State.createState();
  state = State.reduce(state, { type: 'project-update', projectInstanceId: PROJECT_A, tree: tree('edit.md') });
  state = State.reduce(state, { type: 'goal-change', value: '规划新文章' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'project-update', projectInstanceId: PROJECT_B, tree: tree('edit.md', 'one.md') });
  assert.strictEqual(state.projectInstanceId, PROJECT_B);
  assert.strictEqual(state.projectEpoch, 2);
  assert.strictEqual(state.mode, 'navigation');
  assert.strictEqual(state.goal, '');
  assert.strictEqual(state.generation, null);
  assert.strictEqual(state.result, null);
});

test('old generation results and finally cannot mutate a newer project attempt', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A, tree: tree('edit.md'),
  });
  state = State.reduce(state, { type: 'goal-change', value: '规划新文章' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, {
    type: 'project-update', projectInstanceId: PROJECT_B, tree: tree('edit.md', 'one.md'),
  });
  state = State.reduce(state, { type: 'goal-change', value: '找下一步' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_B });
  const before = state;
  state = State.reduce(state, { type: 'generation-success', attemptId: GENERATION_A, result: structureResult() });
  state = State.reduce(state, { type: 'generation-finally', attemptId: GENERATION_A });
  assert.strictEqual(state, before);
  assert.strictEqual(state.generation.attemptId, GENERATION_B);
});

test('generation cancel is attempt-bound and preserves the author goal', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A, tree: tree('edit.md'),
  });
  state = State.reduce(state, { type: 'goal-change', value: '规划新文章' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'generation-cancel-start', attemptId: GENERATION_B });
  assert.strictEqual(state.generation.status, 'generating');
  state = State.reduce(state, { type: 'generation-cancel-start', attemptId: GENERATION_A });
  assert.strictEqual(state.generation.status, 'cancelling');
  state = State.reduce(state, { type: 'generation-cancelled', attemptId: GENERATION_A });
  assert.strictEqual(state.phase, 'idle');
  assert.strictEqual(state.goal, '规划新文章');
});

test('current-file drift invalidates only an in-flight navigation generation', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update',
    projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md', 'chapters/02.md'),
    currentFilePath: 'chapters/01.md',
  });
  state = State.reduce(state, { type: 'goal-change', value: '找下一步' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  const epoch = state.projectEpoch;
  state = State.reduce(state, {
    type: 'tree-update',
    tree: tree('edit.md', 'chapters/01.md', 'chapters/02.md'),
    currentFilePath: 'chapters/02.md',
  });
  assert.strictEqual(state.phase, 'idle');
  assert.strictEqual(state.generation, null);
  assert.strictEqual(state.goal, '找下一步');
  assert.strictEqual(state.currentFilePath, 'chapters/02.md');
  assert.strictEqual(state.projectEpoch, epoch + 1);
});

test('structure alternatives keep independent editable chapter drafts', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A, tree: tree('edit.md'),
  });
  state = State.reduce(state, { type: 'goal-change', value: '规划新文章' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'generation-success', attemptId: GENERATION_A, result: structureResult() });
  state = State.reduce(state, {
    type: 'chapter-edit', alternativeId: 'alternative_1', chapterIndex: 0,
    field: 'title', value: '作者改写的问题',
  });
  state = State.reduce(state, { type: 'alternative-select', alternativeId: 'alternative_2' });
  assert.strictEqual(State.selectedChapters(state)[0].title, '案例');
  state = State.reduce(state, { type: 'alternative-select', alternativeId: 'alternative_1' });
  assert.strictEqual(State.selectedChapters(state)[0].title, '作者改写的问题');
});

test('author chapter validator rejects controls, whitespace repair and comment escape', () => {
  assert.deepStrictEqual(State.validateChapter({ title: '章节', purpose: '目的' }), {
    title: '章节', purpose: '目的',
  });
  for (const chapter of [
    { title: ' 章节', purpose: '目的' },
    { title: '章\n节', purpose: '目的' },
    { title: '章节', purpose: '关闭 --> 注释' },
    { title: `章节${String.fromCharCode(0xD800)}`, purpose: '目的' },
  ]) assert.strictEqual(State.validateChapter(chapter), null);
  assert.deepStrictEqual(State.validateChapter({ title: '章节😀', purpose: '允许完整代理对' }), {
    title: '章节😀', purpose: '允许完整代理对',
  });
});

test('prepare preview and all three transaction states are explicit', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A, tree: tree('edit.md'),
  });
  state = State.reduce(state, { type: 'goal-change', value: '规划新文章' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'generation-success', attemptId: GENERATION_A, result: structureResult() });
  state = State.reduce(state, {
    type: 'prepare-success',
    capabilityId: `wsc_${'3'.repeat(32)}`,
    preview: {
      schema: 'writcraft.writing-structure-preview/v1',
      navigationId: NAVIGATION_ID,
      alternativeId: 'alternative_1',
      chapterCount: 2,
      createsProse: false,
      disclosure: '只创建章节标题与写作目的注释，不会生成正文。',
      files: [
        { path: 'chapters/01.md', title: '问题', purpose: '说明问题', content: '# 问题\n\n<!-- 写作目的：说明问题 -->\n', bytes: 53, sha256: '4'.repeat(64) },
        { path: 'chapters/02.md', title: '方法', purpose: '提出方法', content: '# 方法\n\n<!-- 写作目的：提出方法 -->\n', bytes: 53, sha256: '5'.repeat(64) },
      ],
      proposalDigest: '6'.repeat(64),
    },
  });
  assert.strictEqual(state.phase, 'structure-preview');
  state = State.reduce(state, {
    type: 'confirm-result',
    result: { ok: false, state: 'UNKNOWN', operationId: 'wst_1', recoveryRequired: true },
  });
  assert.strictEqual(state.phase, 'recovery');
  assert.strictEqual(state.recovery.state, 'UNKNOWN');
  state = State.reduce(state, {
    type: 'recovery-result',
    result: { ok: true, state: 'COMMITTED', operationId: 'wst_1', files: [{ path: 'chapters/01.md' }], recoveryRequired: true },
  });
  assert.strictEqual(state.recovery.state, 'COMMITTED');
  state = State.reduce(state, {
    type: 'recovery-acknowledged',
    operationId: 'wst_1',
  });
  assert.strictEqual(state.phase, 'structure-committed');
  state = State.reduce(state, {
    type: 'tree-update',
    tree: tree('edit.md', 'chapters/01.md'),
    currentFilePath: 'chapters/01.md',
  });
  assert.strictEqual(state.mode, 'navigation');
  assert.strictEqual(state.phase, 'structure-committed');
  assert.strictEqual(state.recovery.state, 'COMMITTED');
  state = State.reduce(state, { type: 'continue-after-structure' });
  assert.strictEqual(state.phase, 'idle');
  assert.strictEqual(state.mode, 'navigation');
  assert.strictEqual(state.recovery, null);
});

test('navigation view model discloses X/Y scope and user-facing limited wording', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md', 'chapters/02.md', 'chapters/03.md'),
    currentFilePath: 'chapters/01.md',
  });
  state = State.reduce(state, { type: 'goal-change', value: '找下一步' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'generation-success', attemptId: GENERATION_A, result: navigationResult() });
  const view = State.toViewModel(state);
  assert.strictEqual(view.context.coverage, '基于本次已读取的 1/3 个正文文件');
  assert.strictEqual(view.context.priorityBoundary, '以下建议仅在本次已读范围内优先');
  assert.strictEqual(view.context.limitedIntent, false);
});

test('same-epoch restore installs navigation truth but cannot replace a new generation', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md'), currentFilePath: 'chapters/01.md',
  });
  const epoch = state.projectEpoch;
  state = State.reduce(state, { type: 'restore-start' });
  state = State.reduce(state, { type: 'restore-success', projectEpoch: epoch, result: navigationResult() });
  assert.strictEqual(state.phase, 'navigation-ready');
  assert.strictEqual(state.result.navigationId, NAVIGATION_ID);

  state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md'), currentFilePath: 'chapters/01.md',
  });
  state = State.reduce(state, { type: 'goal-change', value: '重新整理' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  const busy = State.reduce(state, {
    type: 'restore-success', projectEpoch: state.projectEpoch, result: navigationResult(),
  });
  assert.strictEqual(busy, state);
});

test('invalid restored authority releases restoring into an explicit retryable failure', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md'), currentFilePath: 'chapters/01.md',
  });
  const epoch = state.projectEpoch;
  state = State.reduce(state, { type: 'restore-start' });
  state = State.reduce(state, {
    type: 'restore-success', projectEpoch: epoch, result: { schema: 'invalid' },
  });
  assert.strictEqual(state.phase, 'failure');
  assert.strictEqual(state.result, null);
  assert.strictEqual(state.error.code, 'INVALID_NAVIGATION_RESULT');
});

test('current正文 occupies one of eight context slots before request serialization', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree(
      'edit.md',
      'chapters/01.md', 'chapters/02.md', 'chapters/03.md', 'chapters/04.md',
      'chapters/05.md', 'chapters/06.md', 'chapters/07.md', 'chapters/08.md',
      'chapters/09.md'
    ),
    currentFilePath: 'chapters/01.md',
  });
  state = State.reduce(state, { type: 'goal-change', value: '找下一步' });
  state = State.reduce(state, {
    type: 'context-change',
    paths: [
      'chapters/01.md', 'chapters/02.md', 'chapters/03.md', 'chapters/04.md',
      'chapters/05.md', 'chapters/06.md', 'chapters/07.md', 'chapters/08.md',
      'chapters/09.md',
    ],
  });
  assert.strictEqual(state.contextPaths.length, 7);
  assert(!state.contextPaths.includes('chapters/01.md'));
  const request = State.requestPayload(state);
  assert.strictEqual(request.schema, State.REQUEST_SCHEMA);
  assert.strictEqual(request.contextPaths.length, 7);
  assert.strictEqual(new Set([request.currentFilePath, ...request.contextPaths]).size, 8);
});

test('action attempts are isolated and retryable outcomes keep the action available', () => {
  let state = State.reduce(State.createState(), {
    type: 'project-update', projectInstanceId: PROJECT_A,
    tree: tree('edit.md', 'chapters/01.md'), currentFilePath: 'chapters/01.md',
  });
  state = State.reduce(state, { type: 'goal-change', value: '找下一步' });
  state = State.reduce(state, { type: 'generation-start', attemptId: GENERATION_A });
  state = State.reduce(state, { type: 'generation-success', attemptId: GENERATION_A, result: navigationResult() });
  state = State.reduce(state, { type: 'action-start', actionId: ACTION_ID, attemptId: ACTION_A });
  state = State.reduce(state, { type: 'action-start', actionId: ACTION_ID, attemptId: ACTION_B });
  assert.strictEqual(state.actions[ACTION_ID].attemptId, ACTION_A);
  state = State.reduce(state, {
    type: 'action-result', actionId: ACTION_ID, attemptId: ACTION_A,
    result: { ok: false, error: 'TIMEOUT', message: 'timeout' },
  });
  assert.strictEqual(state.actions[ACTION_ID].status, 'retryable');
  state = State.reduce(state, { type: 'action-start', actionId: ACTION_ID, attemptId: ACTION_B });
  state = State.reduce(state, { type: 'action-finally', actionId: ACTION_ID, attemptId: ACTION_A });
  assert.strictEqual(state.actions[ACTION_ID].attemptId, ACTION_B);
});

test('public error mapping never exposes structured transport vocabulary', () => {
  for (const error of ['INVALID_MODEL_OUTPUT', 'INVALID_MODEL_EVIDENCE', 'MODEL_OUTPUT_TOO_LARGE']) {
    const copy = State.publicFailure({ error, message: 'AI JSON Schema 字段错误' });
    assert(!/JSON|Schema|字段|tool_use/i.test(copy.message));
    assert(copy.message.includes('没有修改项目文件'));
  }
  const noKey = State.publicFailure({ error: 'NO_KEY' });
  assert.strictEqual(noKey.action, 'settings');
  assert(noKey.message.includes('未联网'));
  const evidence = State.publicFailure({ error: 'INVALID_MODEL_EVIDENCE' });
  assert(evidence.message.includes('原文依据没有通过核对'));
  assert.strictEqual(evidence.action, 'retry');
  const oversized = State.publicFailure({ error: 'MODEL_OUTPUT_TOO_LARGE' });
  assert(oversized.message.includes('安全审阅范围'));
  assert(oversized.message.includes('自动重新整理一次'));
  assert(oversized.message.includes('不要继续重复点击'));
  const route = State.publicFailure({ error: 'RESEARCH_ROUTE_FAILED' });
  assert.strictEqual(route.action, 'retry');
  assert(route.message.includes('建议仍然保留'));
  const pending = State.publicFailure({ error: 'CHANGES_RECOVERY_PENDING' });
  assert.strictEqual(pending.action, 'review');
  assert(pending.message.includes('先完成或丢弃审阅'));
  assert(pending.message.includes('本次能力未消费'));
  assert(pending.message.includes('仍在有效期内'));
  assert(!pending.message.includes('不会过期'));
});

console.log(`\nWriting Navigation Renderer state passed: ${passed}/${passed}.`);
