'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const backend = require('../src/main/project-plan-service');
const State = require('../src/renderer/plan-mode-state');
const View = require('../src/renderer/plan-mode-view');

const viewSource = fs.readFileSync(path.join(__dirname, '../src/renderer/plan-mode-view.js'), 'utf8');
const stateSource = fs.readFileSync(path.join(__dirname, '../src/renderer/plan-mode-state.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/renderer/plan-mode.css'), 'utf8');
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function result(overrides = {}) {
  return {
    ok: true,
    plan: {
      schema: 'writcraft.plan/v2',
      planId: 'plan_1234567890abcdef12345678',
      title: '完成第一部分',
      summary: '先结构，后写作。',
      assumptions: ['第一章优先'],
      openQuestions: ['资料是否充分'],
      milestones: [{
        id: 'm1', title: '结构就绪', objective: '锁定论证结构', acceptanceCriteria: ['结构符合 edit.md'],
        tasks: [{
          id: 't1', title: '核对约束', description: '核对项目边界', scope: 'project',
          targets: [{ path: 'edit.md', revision: 'a'.repeat(64) }], dependsOn: [], acceptanceCriteria: ['没有冲突'],
        }, {
          id: 't2', title: '规划第一章', description: '只拆分章节任务', scope: 'file',
          targets: [{ path: 'chapters/one.md', revision: 'c'.repeat(64) }], dependsOn: ['t1'], acceptanceCriteria: ['每节目标明确'],
        }],
      }, {
        id: 'm2', title: '资料就绪', objective: '核验关键事实', acceptanceCriteria: ['事实可追溯'],
        tasks: [{
          id: 't3', title: '核验资料', description: '检查原始来源', scope: 'research',
          targets: [{ path: 'research/facts.md', revision: 'b'.repeat(64) }], dependsOn: ['t2'], acceptanceCriteria: ['来源清晰'],
        }],
      }],
      ...overrides,
    },
    contextManifest: {
      goalChars: 12,
      totalBytes: 2048,
      omitted: [],
      files: [
        { path: 'edit.md', role: 'project_prompt', revision: 'a'.repeat(64), bytes: 1024 },
        { path: 'research/facts.md', role: 'context', revision: 'b'.repeat(64), bytes: 1024 },
      ],
      editPrompt: { revision: 'a'.repeat(64), frontMatterStatus: 'valid', diagnosticCodes: [] },
    },
  };
}

console.log('\nPlan Mode renderer verification');

check('renderer schema and safety caps match the authoritative Plan backend', () => {
  assert.strictEqual(State.PLAN_SCHEMA, backend.PLAN_SCHEMA);
  assert.strictEqual(State.MAX_MILESTONES, backend.MAX_MILESTONES);
  assert.strictEqual(State.MAX_TASKS, backend.MAX_TASKS);
  assert.deepStrictEqual([...State.TASK_SCOPES], backend.TASK_SCOPES);
});

check('creates an immutable ready state with the first bookmark selected', () => {
  const state = State.createState(result());
  assert.strictEqual(state.status, 'ready');
  assert.strictEqual(state.activeMilestoneId, 'm1');
  assert.strictEqual(state.plan.milestones.length, 2);
  assert(Object.isFrozen(state));
  assert(Object.isFrozen(state.plan.milestones[0].tasks[0]));
});

check('represents loading, error, empty and invalid-result states explicitly', () => {
  assert.strictEqual(State.createState().status, 'empty');
  assert.strictEqual(State.createState({ status: 'loading' }).status, 'loading');
  assert.strictEqual(State.createState({ status: 'error', message: '网络不可用' }).error, '网络不可用');
  assert.strictEqual(State.createState({ ok: true, plan: { schema: 'wrong' } }).status, 'error');
});

check('defensively bounds malformed model-facing data for rendering', () => {
  const tooMany = Array.from({ length: State.MAX_MILESTONES + 5 }, (_, index) => ({
    id: `m${index}`, title: `M${index}`, objective: '目标', acceptanceCriteria: ['完成'],
    tasks: [{ id: `t${index}`, title: '任务', description: '说明', scope: 'invalid', targets: [], dependsOn: [], acceptanceCriteria: ['完成'] }],
  }));
  const plan = State.normalizePlan({ ...result().plan, milestones: tooMany });
  assert.strictEqual(plan.milestones.length, State.MAX_MILESTONES);
  assert.strictEqual(plan.milestones[0].tasks[0].scope, 'project');
  const duplicate = State.normalizePlan({ ...result().plan, milestones: [result().plan.milestones[0], result().plan.milestones[0]] });
  assert.strictEqual(duplicate.milestones.length, 1);
});

check('bookmark selection and task disclosure are deterministic state transitions', () => {
  const initial = State.createState(result());
  const selected = State.reduce(initial, { type: 'select-milestone', milestoneId: 'm2' });
  assert.strictEqual(selected.activeMilestoneId, 'm2');
  const opened = State.reduce(selected, { type: 'toggle-task', taskId: 't3' });
  assert.deepStrictEqual(opened.expandedTaskIds, ['t3']);
  const closed = State.reduce(opened, { type: 'toggle-task', taskId: 't3' });
  assert.deepStrictEqual(closed.expandedTaskIds, []);
  assert.strictEqual(State.reduce(closed, { type: 'select-milestone', milestoneId: 'missing' }), closed);
});

check('handoff payload is revision-auditable and contains no writing mutation', () => {
  const state = State.createState(result());
  const payload = State.handoffPayload(state, 't2');
  assert.strictEqual(payload.schema, State.HANDOFF_SCHEMA);
  assert.strictEqual(payload.planId, state.plan.planId);
  assert.strictEqual(payload.taskId, 't2');
  assert.deepStrictEqual(Object.keys(payload).sort(), ['planId', 'schema', 'taskId']);
  for (const forbidden of ['after', 'content', 'changes', 'changeSet', 'write']) {
    assert.strictEqual(JSON.stringify(payload).includes(`"${forbidden}"`), false);
  }
  assert(Object.isFrozen(payload));
});

check('empty-target tasks remain visible but cannot produce a handoff payload', () => {
  const value = result();
  value.plan.milestones[0].tasks[0].targets = [];
  const state = State.createState(value);
  assert.strictEqual(State.handoffPayload(state, 't1'), null);
});

check('transfer lifecycle has explicit busy, success and recoverable error states', () => {
  const initial = State.createState(result());
  const loading = State.reduce(initial, { type: 'transfer-start', taskId: 't1' });
  assert.deepStrictEqual(loading.transfer, { taskId: 't1', status: 'loading', message: '正在转交任务…' });
  const success = State.reduce(loading, { type: 'transfer-success', taskId: 't1' });
  assert.strictEqual(success.transfer.status, 'success');
  assert(success.transfer.message.includes('正文仍需单独审阅'));
  const error = State.reduce(success, { type: 'transfer-error', taskId: 't1', message: '执行器离线' });
  assert.deepStrictEqual(error.transfer, { taskId: 't1', status: 'error', message: '执行器离线' });
});

check('view model exposes numbered milestones, active tasks and transparent Context totals', () => {
  const view = State.toViewModel(State.createState(result()));
  assert.strictEqual(view.taskTotal, 3);
  assert.strictEqual(view.milestones[0].index, 1);
  assert.strictEqual(view.milestones[0].active, true);
  assert.strictEqual(view.active.tasks[1].index, 2);
  assert.strictEqual(view.manifest.files[0].revision, 'a'.repeat(64));
  assert.strictEqual(State.formatBytes(view.manifest.totalBytes), '2.0 KB');
});

check('view renders the book-page, bookmark, milestone and task-card vocabulary', () => {
  for (const marker of [
    'plan-mode__page', 'plan-mode__bookmarks', 'plan-mode__bookmark', '第 ${view.active.index} 枚书签',
    'plan-mode__milestone', 'plan-mode__task', '本页完成条件', 'target.revision',
  ]) assert(viewSource.includes(marker), `缺少 ${marker}`);
  assert.strictEqual(View.SCOPE_LABELS.paragraph, '段落级');
});

check('view provides actionable loading, error and empty states', () => {
  for (const copy of [
    '正在整理项目计划', '计划没有生成', '重新生成', '先把写作意图装订成计划', '生成项目计划',
  ]) assert(viewSource.includes(copy), `缺少状态文案 ${copy}`);
  assert(viewSource.includes("setAttribute('aria-busy', 'true')"));
  assert(viewSource.includes("setAttribute('role', 'alert')"));
});

check('Context audit shows full revisions, authority, bytes, prompt diagnostics and omissions', () => {
  for (const marker of [
    'Context 校勘记录', 'Main 权威清单', 'file.revision', 'frontMatterStatus', 'diagnosticCodes',
    '没有静默省略的上下文', 'State.formatBytes',
  ]) assert(viewSource.includes(marker), `缺少 Context 审计项 ${marker}`);
});

check('task execution is callback-only and explicitly warns that prose is not written directly', () => {
  assert(viewSource.includes('State.handoffPayload(state, task.id)'));
  assert(viewSource.includes('options.onHandoff?.(payload)'));
  assert(viewSource.includes('只转交任务，不直接写入正文'));
  for (const forbidden of ['window.writCraft', 'ipcRenderer', 'fetch(', "require('fs')", 'atomicWriteFile', 'createMarkdownFile']) {
    assert(!viewSource.includes(forbidden), `视图不应使用 ${forbidden}`);
    assert(!stateSource.includes(forbidden), `状态模块不应使用 ${forbidden}`);
  }
});

check('all dynamic copy uses textContent and task controls expose accessible semantics', () => {
  assert(viewSource.includes('node.textContent = label'));
  assert(!viewSource.includes('.innerHTML'));
  for (const marker of [
    "setAttribute('role', 'tablist')", "setAttribute('role', 'tab')", "setAttribute('aria-selected'",
    "setAttribute('aria-expanded'", "setAttribute('aria-controls'", "setAttribute('aria-live', 'polite')",
  ]) assert(viewSource.includes(marker), `缺少可访问语义 ${marker}`);
});

check('bookmark keyboard navigation supports arrows, Home and End', () => {
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', "event.key === 'Home'", "event.key === 'End'"]) {
    assert(viewSource.includes(key), `缺少键盘支持 ${key}`);
  }
  assert(viewSource.includes('event.preventDefault()'));
  assert(viewSource.includes('focusBookmark(next)'));
});

check('CSS has a responsive paper/bookmark signature, visible focus and reduced-motion fallback', () => {
  for (const marker of [
    '.plan-mode__page::before', '.plan-mode__bookmark[aria-selected="true"]', '.plan-mode__task',
    ':focus-visible', '@media (max-width: 720px)', '@media (prefers-reduced-motion: no-preference)',
    '@media (prefers-reduced-motion: reduce)', 'animation: none !important',
  ]) assert(css.includes(marker), `CSS 缺少 ${marker}`);
});

console.log(`\nPlan Mode renderer verification passed: ${passed}/16 checks.`);
