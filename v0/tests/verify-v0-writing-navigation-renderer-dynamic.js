'use strict';

const assert = require('assert');
const State = require('../src/renderer/writing-navigation-state');
const View = require('../src/renderer/writing-navigation-view');

class ClassList {
  constructor(node) { this.node = node; }
  list() { return new Set(String(this.node.className || '').split(/\s+/).filter(Boolean)); }
  write(values) { this.node.className = [...values].join(' '); }
  add(...names) { const values = this.list(); names.forEach(name => values.add(name)); this.write(values); }
  remove(...names) { const values = this.list(); names.forEach(name => values.delete(name)); this.write(values); }
  contains(name) { return this.list().has(name); }
  toggle(name, force) {
    const values = this.list();
    const enabled = force === undefined ? !values.has(name) : Boolean(force);
    if (enabled) values.add(name); else values.delete(name);
    this.write(values);
    return enabled;
  }
}

class Node {
  constructor(document, tag = 'div') {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.classList = new ClassList(this);
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.disabled = false;
    this.hidden = false;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parentElement = null; });
    this.children = [];
    this.textContent = '';
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  addEventListener(name, listener) {
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
  }
  async dispatch(name, detail = {}) {
    const event = { target: this, preventDefault() {}, ...detail };
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  click() { return this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end, direction = 'none') {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  querySelectorAll(selector) {
    const output = [];
    const matches = node => {
      if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
      if (selector.startsWith('[data-')) {
        const match = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
        if (!match) return false;
        const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return match[2] === undefined ? key in node.dataset : node.dataset[key] === match[2];
      }
      return node.tagName === selector.toUpperCase();
    };
    const visit = node => {
      for (const child of node.children) {
        if (matches(child)) output.push(child);
        visit(child);
      }
    };
    visit(this);
    return output;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class Document {
  constructor() {
    this.body = new Node(this, 'body');
    this.activeElement = this.body;
  }
  createElement(tag) { return new Node(this, tag); }
}

function text(node) {
  return [node.textContent, ...node.children.map(text)].filter(Boolean).join(' ');
}

function byText(node, value) {
  if (node.textContent === value) return node;
  for (const child of node.children) {
    const found = byText(child, value);
    if (found) return found;
  }
  return null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const PROJECT = { instanceId: 'instance_0123456789abcdef01234567' };
const NAVIGATION_ID = `nav_${'a'.repeat(32)}`;
const CAPABILITY_ID = `wsc_${'b'.repeat(32)}`;
const CHANGES_ACTION_ID = `wna_${'d'.repeat(32)}`;
let id = 0;
const nextId = () => `wno_${String(++id).padStart(32, '0')}`;

function editPrompt(revision = '1'.repeat(64), rawBytes = 0, compiledBytes = rawBytes) {
  return {
    schema: 'writcraft.edit-prompt-manifest/v1', path: 'edit.md', revision,
    rawChars: rawBytes, rawBytes, compiledChars: compiledBytes, compiledBytes,
    budgetChars: 6000, budgetBytes: 18 * 1024,
    selectionPolicy: 'required_sections_then_source_order',
    totalSectionCount: 0, usedSectionCount: 0, omittedSectionCount: 0,
    omissionReason: null, truncated: false, truncationReason: null, fallbackToRaw: false,
  };
}

function unified(used, available, revision = '1'.repeat(64), rawBytes = 0, compiledBytes = rawBytes) {
  const items = [{
    id: 'nav_edit_prompt', kind: 'project_prompt', path: 'edit.md', revision,
    status: 'included', rawBytes, includedBytes: compiledBytes, budgetBytes: 240 * 1024,
    omissionReason: null, truncationReason: null,
  }];
  for (let index = 0; index < used; index += 1) items.push({
    id: `nav_current_file_chapters_01_md_${index}`, kind: 'current_file', path: 'chapters/01.md',
    revision: '2'.repeat(64), status: 'included', rawBytes: 1000, includedBytes: 1000,
    budgetBytes: 240 * 1024, omissionReason: null, truncationReason: null,
  });
  for (let index = used; index < available; index += 1) items.push({
    id: `nav_omitted_body_${index + 1}`, kind: 'context', path: null, revision: null,
    status: 'omitted', rawBytes: null, includedBytes: 0, budgetBytes: 240 * 1024,
    omissionReason: 'not_selected', truncationReason: null,
  });
  return {
    schema: 'writcraft.context-manifest/v2', authority: 'main', entry: 'navigation', editRevision: revision,
    editCompilation: {
      status: 'complete', rawBytes, compiledBytes, budgetBytes: 18 * 1024, budgetChars: 6000,
      availableSections: 0, includedSections: 0, omittedSections: 0, omissionReason: null,
      truncationReason: null, selectionPolicy: 'required_sections_then_source_order',
    },
    items,
    totals: {
      availableItems: items.length, includedItems: used + 1, omittedItems: available - used,
      rawBytes: available === used ? rawBytes + used * 1000 : null,
      includedBytes: compiledBytes + used * 1000, budgetBytes: 240 * 1024,
    },
    sourceIndexRevision: null,
  };
}

function structure() {
  return {
    ok: true,
    result: {
      schema: 'writcraft.writing-navigation/v1',
      navigationId: NAVIGATION_ID,
      mode: 'structure',
      alternatives: [
        {
          alternativeId: 'alternative_1', organizingLogic: '沿问题推进',
          audienceBenefit: '快速理解', tradeoff: '案例较少',
          chapters: [{ path: 'chapters/01.md', title: '问题', purpose: '说明问题' }],
        },
        {
          alternativeId: 'alternative_2', organizingLogic: '沿案例推进',
          audienceBenefit: '容易代入', tradeoff: '框架较晚',
          chapters: [{ path: 'chapters/01.md', title: '案例', purpose: '建立场景' }],
        },
      ],
      contextManifest: {
        usedBodyCount: 0, availableBodyCount: 0, omittedBodyCount: 0,
        totalBodyBytes: 0, limitedProjectIntent: true,
        editPrompt: editPrompt(),
        unified: unified(0, 0),
        files: [{ path: 'edit.md', role: 'project_prompt', revision: '1'.repeat(64), bytes: 0 }],
        omissionReason: null, truncationReason: null, disclosure: '已读取当前项目全部正文',
      },
    },
  };
}

function navigation(action = 'changes') {
  return {
    ok: true,
    result: {
      schema: 'writcraft.writing-navigation/v1',
      navigationId: NAVIGATION_ID,
      mode: 'navigation',
      suggestions: [{
        actionId: CHANGES_ACTION_ID,
        finding: '开篇缺少边界',
        evidence: [{
          relativePath: 'chapters/01.md', revision: '2'.repeat(64),
          sectionHeading: '开篇', quote: '先定义问题。',
          locator: {
            filePath: 'chapters/01.md', revision: '2'.repeat(64),
            offset: 8, endOffset: 14, line: 3, column: 1,
            blockAnchor: { schema: 'writcraft.block-anchor/v1' },
          },
        }],
        whyNow: '影响后续章节', recommendedAction: '补充范围',
        expectedResult: '读者更容易跟随', action,
      }],
      contextManifest: {
        usedBodyCount: 1, availableBodyCount: 3, omittedBodyCount: 2,
        totalBodyBytes: 1200, limitedProjectIntent: false,
        editPrompt: editPrompt('1'.repeat(64), 200, 200),
        unified: unified(1, 3, '1'.repeat(64), 200, 200),
        files: [
          { path: 'edit.md', role: 'project_prompt', revision: '1'.repeat(64), bytes: 200 },
          { path: 'chapters/01.md', role: 'current_file', revision: '2'.repeat(64), bytes: 1000 },
        ],
        omissionReason: 'not_selected', truncationReason: null,
        disclosure: '只基于本次已读取的 1/3 个正文文件',
      },
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

(async () => {
  console.log('\nWriting Navigation Renderer dynamic verification');
  let passed = 0;
  async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  }

  await test('structure journey compares, edits, previews exact bytes and confirms once', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const calls = { generate: 0, prepare: 0, confirm: 0 };
    let controller;
    controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async () => { calls.generate += 1; return structure(); },
      onPrepareStructure: async (_projectId, _navigationId, _alternativeId, chapters) => {
        calls.prepare += 1;
        assert.strictEqual(chapters[0].title, '作者标题');
        return {
          ok: true, capabilityId: CAPABILITY_ID, expiresAt: 99,
          preview: {
            schema: 'writcraft.writing-structure-preview/v1',
            navigationId: NAVIGATION_ID, alternativeId: 'alternative_1',
            chapterCount: 1, createsProse: false,
            disclosure: '只创建章节标题与写作目的注释，不会生成正文。',
            files: [{
              path: 'chapters/01.md', title: '作者标题', purpose: '说明问题',
              content: '# 作者标题\n\n<!-- 写作目的：说明问题 -->\n',
              bytes: 60, sha256: '4'.repeat(64),
            }],
            proposalDigest: '5'.repeat(64),
          },
        };
      },
      onConfirmStructure: async capabilityId => {
        calls.confirm += 1;
        assert.strictEqual(capabilityId, CAPABILITY_ID);
        return { ok: true, state: 'COMMITTED', operationId: 'wst_1', files: [{ path: 'chapters/01.md' }] };
      },
      onStructureCommitted: () => controller.updateTree([
        { type: 'file', path: 'edit.md' },
        { type: 'file', path: 'chapters/01.md' },
      ], 'chapters/01.md'),
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    host.querySelector('textarea').value = '规划新文章';
    await host.querySelector('textarea').dispatch('input');
    await byText(host, '生成结构方案').click();
    await flush();
    assert.strictEqual(calls.generate, 1);
    const title = host.querySelector('[data-chapter-field="title"]');
    title.value = '作者标题';
    await title.dispatch('input');
    await byText(host, '查看创建预览').click();
    await flush();
    assert.strictEqual(calls.prepare, 1);
    assert(text(host).includes('只创建骨架，不会写章节正文'));
    assert(text(host).includes('# 作者标题'));
    await byText(host, '确认创建章节骨架').click();
    await flush();
    assert.strictEqual(calls.confirm, 1);
    assert(text(host).includes('已创建 1 个章节骨架'));
    assert.strictEqual(controller.getState().mode, 'navigation');
    assert.strictEqual(controller.getState().phase, 'structure-committed');
    await byText(host, '进入写作导航').click();
    assert.strictEqual(controller.getState().phase, 'idle');
    assert(text(host).includes('生成写作导航'));
  });

  await test('goal and chapter inputs keep the same DOM node, focus and caret while typing', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async () => structure(),
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);

    let goal = host.querySelector('[data-navigation-focus="goal"]');
    const originalGoal = goal;
    goal.focus();
    goal.value = 'C';
    goal.setSelectionRange(1, 1);
    await goal.dispatch('input');
    goal = host.querySelector('[data-navigation-focus="goal"]');
    assert.strictEqual(goal, originalGoal);
    assert.strictEqual(document.activeElement, goal);
    assert.strictEqual(goal.selectionStart, 1);
    goal.value = 'COPE方';
    goal.setSelectionRange(5, 5);
    await goal.dispatch('input', { isComposing: true });
    goal = host.querySelector('[data-navigation-focus="goal"]');
    assert.strictEqual(goal, originalGoal);
    assert.strictEqual(document.activeElement, goal);
    assert.strictEqual(controller.getState().goal, 'COPE方');
    assert.strictEqual(goal.selectionStart, 5);

    await byText(host, '生成结构方案').click();
    await flush();
    let title = host.querySelector('[data-navigation-focus="chapter-alternative_1-0-title"]');
    const originalTitle = title;
    title.focus();
    title.value = '作者';
    title.setSelectionRange(2, 2);
    await title.dispatch('input');
    title = host.querySelector('[data-navigation-focus="chapter-alternative_1-0-title"]');
    assert.strictEqual(title, originalTitle);
    assert.strictEqual(document.activeElement, title);
    title.value = '作者标题';
    title.setSelectionRange(4, 4);
    await title.dispatch('input');
    title = host.querySelector('[data-navigation-focus="chapter-alternative_1-0-title"]');
    assert.strictEqual(title, originalTitle);
    assert.strictEqual(document.activeElement, title);
    assert.strictEqual(controller.getState().chapterDrafts.alternative_1[0].title, '作者标题');
    assert.strictEqual(title.selectionStart, 4);
    let purpose = host.querySelector('[data-navigation-focus="chapter-alternative_1-0-purpose"]');
    const originalPurpose = purpose;
    purpose.focus();
    purpose.value = '说明';
    purpose.setSelectionRange(2, 2);
    await purpose.dispatch('input', { isComposing: true });
    purpose = host.querySelector('[data-navigation-focus="chapter-alternative_1-0-purpose"]');
    assert.strictEqual(purpose, originalPurpose);
    assert.strictEqual(document.activeElement, purpose);
    assert.strictEqual(controller.getState().chapterDrafts.alternative_1[0].purpose, '说明');
    assert.strictEqual(purpose.selectionStart, 2);
    assert(text(host).includes('下一步：预览即将创建的文件，确认无误后再创建章节骨架。'));
  });

  await test('edit.md without explicit正文 blocks generation and explains the recovery', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    let calls = 0;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async request => {
        calls += 1;
        assert.strictEqual(request.currentFilePath, null);
        assert.deepStrictEqual(request.contextPaths, ['chapters/01.md']);
        return navigation();
      },
    });
    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'edit.md');
    const goal = host.querySelector('[data-navigation-focus="goal"]');
    goal.value = '精简当前文章';
    await goal.dispatch('input');
    const generate = byText(host, '生成写作导航');
    assert.strictEqual(generate.disabled, true);
    assert(text(host).includes('请先打开一篇正文'));
    assert(text(host).includes('选择前不会调用 AI'));
    await generate.click();
    await flush();
    assert.strictEqual(calls, 0);
    const context = host.querySelector('input');
    context.checked = true;
    await context.dispatch('change');
    assert(!text(host).includes('选择前不会调用 AI'));
    const recoveredGenerate = byText(host, '生成写作导航');
    assert.strictEqual(recoveredGenerate.disabled, false);
    await recoveredGenerate.click();
    await flush();
    assert.strictEqual(calls, 1);
  });

  await test('generation cancellation is attempt-bound and preserves the goal', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const pending = deferred();
    let attempted;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: (_request, attemptId) => { attempted = attemptId; return pending.promise; },
      onCancelGeneration: async (_projectId, attemptId) => {
        assert.strictEqual(attemptId, attempted);
        return { ok: true, cancelled: true };
      },
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    const goal = host.querySelector('textarea');
    goal.value = '规划新文章';
    await goal.dispatch('input');
    void byText(host, '生成结构方案').click();
    await flush();
    assert(text(host).includes('正在整理结构方案'));
    await byText(host, '停止整理').click();
    await flush();
    assert.strictEqual(controller.getState().goal, '规划新文章');
    assert.strictEqual(controller.getState().phase, 'idle');
    pending.resolve({ ok: false, error: 'REQUEST_ABORTED' });
    await flush();
    assert.strictEqual(controller.getState().phase, 'idle');
  });

  await test('the complete navigation generation reaches a retryable terminal by 60 seconds', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const pending = deferred();
    const timers = [];
    const cancelled = [];
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      setTimer(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length - 1; },
      clearTimer(timerId) { if (timers[timerId]) timers[timerId].cleared = true; },
      onGenerate: () => pending.promise,
      onCancelGeneration: async (...args) => {
        cancelled.push(args);
        return { ok: true, cancelled: true };
      },
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    const goal = host.querySelector('textarea');
    goal.value = '规划新文章';
    await goal.dispatch('input');
    void byText(host, '生成结构方案').click();
    await flush();
    const timeout = timers.find(timer => timer.delay === 60_000);
    assert(timeout);
    timeout.callback();
    await flush();
    assert.strictEqual(cancelled.length, 1);
    assert.strictEqual(controller.getState().phase, 'failure');
    assert(text(host).includes('已在 60 秒时自动停止'));
    pending.resolve(structure());
    await flush();
    assert.strictEqual(controller.getState().phase, 'failure');
  });

  await test('navigation discloses X/Y and exposes one unified primary action', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    let actionCalls = 0;
    let evidenceOpens = 0;
    let adjustmentSeen = null;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async () => navigation('changes'),
      onRunAction: async (_projectId, actionId, attemptId, _onStage, taskInput) => {
        actionCalls += 1;
        adjustmentSeen = taskInput?.adjustment || null;
        assert.strictEqual(actionId, CHANGES_ACTION_ID);
        assert.match(attemptId, /^wno_[a-f0-9]{32}$/);
        return {
          ok: true,
          kind: 'changes',
          noChanges: false,
          changeSetId: `pc_${'f'.repeat(32)}`,
        };
      },
      onOpenEvidence: async (value, filePath) => {
        evidenceOpens += 1;
        assert.strictEqual(value.filePath, 'chapters/01.md');
        assert.strictEqual(filePath, 'chapters/01.md');
      },
      onAdjustReview: async () => true,
    });
    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
      { type: 'file', path: 'chapters/02.md' },
      { type: 'file', path: 'chapters/03.md' },
    ], 'chapters/01.md');
    const goal = host.querySelector('textarea');
    goal.value = '找下一步';
    await goal.dispatch('input');
    await byText(host, '生成写作导航').click();
    await flush();
    assert(text(host).includes('基于本次已读取的 1/3 个正文文件'));
    assert(text(host).includes('以下建议仅在本次已读范围内优先'));
    assert(text(host).includes('开篇缺少边界'));
    await host.querySelector('.writing-navigation__evidence-link').click();
    await flush();
    assert.strictEqual(evidenceOpens, 1);
    assert.strictEqual(actionCalls, 0);
    assert.strictEqual(host.querySelectorAll('.writing-navigation__primary').filter(
      node => node.textContent === '处理这个建议'
    ).length, 1);
    assert(!text(host).includes('生成修改建议'));
    await byText(host, '处理这个建议').click();
    await flush();
    assert.strictEqual(actionCalls, 1);
    assert(text(host).includes('Diff 已显示在正文编辑区'));
    const adjustment = host.querySelector('.writing-navigation__adjustment');
    adjustment.value = '保留作者的口语感';
    await adjustment.dispatch('input');
    await byText(host, '重新生成 Diff').click();
    await flush();
    assert.strictEqual(actionCalls, 2);
    assert.strictEqual(adjustmentSeen, '保留作者的口语感');
  });

  await test('no-change and failed review adjustment stay inside the same visible task', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const adjustments = [];
    let actionCalls = 0;
    let discardFails = false;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async () => navigation('changes'),
      onRunAction: async (_projectId, _actionId, _attemptId, _onStage, taskInput) => {
        actionCalls += 1;
        adjustments.push(taskInput?.adjustment || '');
        return actionCalls < 2
          ? { ok: true, kind: 'changes', noChanges: true }
          : { ok: true, kind: 'changes', noChanges: false, changeSetId: `pc_${'e'.repeat(32)}` };
      },
      onAdjustReview: async () => {
        if (discardFails) throw Object.assign(new Error('blocked'), { code: 'REVIEW_DISCARD_FAILED' });
        return true;
      },
    });
    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    const goal = host.querySelector('textarea');
    goal.value = '找下一步';
    await goal.dispatch('input');
    await byText(host, '生成写作导航').click();
    await flush();
    await byText(host, '处理这个建议').click();
    await flush();
    assert(text(host).includes('没有形成有效的局部修改'));
    const retryAdjustment = host.querySelector('.writing-navigation__adjustment');
    retryAdjustment.value = '只精简前三段';
    await retryAdjustment.dispatch('input');
    await byText(host, '按调整重试').click();
    await flush();
    assert.strictEqual(adjustments[1], '只精简前三段');
    assert(text(host).includes('Diff 已显示在正文编辑区'));

    discardFails = true;
    const reviewAdjustment = host.querySelector('.writing-navigation__adjustment');
    reviewAdjustment.value = '保留原意';
    await reviewAdjustment.dispatch('input');
    await byText(host, '重新生成 Diff').click();
    await flush();
    assert.strictEqual(controller.getState().actions[CHANGES_ACTION_ID].status, 'review');
    assert(text(host).includes('当前 Diff 还没有安全退出'));
    assert.strictEqual(actionCalls, 2, '退出审阅失败后不得启动新的付费请求');
  });

  await test('resume owns the UI until Main returns and does not permit a competing generation', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const pending = deferred();
    let generations = 0;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onResume: () => pending.promise,
      onGenerate: async () => { generations += 1; return navigation('changes'); },
    });
    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    const restoring = controller.resume();
    assert.strictEqual(controller.getState().phase, 'restoring');
    assert(text(host).includes('不会再次调用 AI'));
    assert.strictEqual(await controller.request(), false);
    assert.strictEqual(generations, 0);
    pending.resolve(navigation('changes'));
    assert.strictEqual(await restoring, true);
    assert.strictEqual(controller.getState().phase, 'navigation-ready');
    assert(text(host).includes('处理这个建议'));
    assert(!text(host).includes('生成修改建议'));
  });

  await test('a unified action exposes cancel after 15 seconds and hard-stops at 60 seconds', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const pending = deferred();
    const timers = [];
    const cancelled = [];
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      setTimer(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length - 1; },
      clearTimer(id) { if (timers[id]) timers[id].cleared = true; },
      onGenerate: async () => navigation('changes'),
      onRunAction: () => pending.promise,
      onCancelAction: async (...args) => { cancelled.push(args); return { ok: true, cancelled: true }; },
    });
    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    const goal = host.querySelector('textarea');
    goal.value = '找下一步';
    await goal.dispatch('input');
    await byText(host, '生成写作导航').click();
    await flush();
    void byText(host, '处理这个建议').click();
    await flush();
    const cancelTimer = timers.find(timer => timer.delay === 15_000);
    const timeoutTimer = timers.find(timer => timer.delay === 60_000 && timer.cleared === false);
    assert(cancelTimer && timeoutTimer);
    cancelTimer.callback();
    assert(text(host).includes('取消'));
    timeoutTimer.callback();
    await flush();
    assert(text(host).includes('已在 60 秒时自动停止'));
    assert.strictEqual(cancelled.length, 1);
    pending.resolve({ ok: true, kind: 'changes', noChanges: false, changeSetId: `pc_${'1'.repeat(32)}` });
    await flush();
    assert.strictEqual(controller.getState().actions[CHANGES_ACTION_ID].status, 'retryable');
  });

  await test('NO_KEY and REVIEW_IN_PROGRESS expose executable recovery actions', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    let settings = 0;
    let review = 0;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: async request => request.mode === 'structure'
        ? { ok: false, error: 'NO_KEY' }
        : navigation('changes'),
      onRunAction: async () => ({
        ok: false,
        error: 'REVIEW_IN_PROGRESS',
        message: 'internal copy must not be rendered',
      }),
      onOpenSettings: () => { settings += 1; },
      onOpenReview: () => { review += 1; },
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    let goal = host.querySelector('textarea');
    goal.value = '规划新文章';
    await goal.dispatch('input');
    await byText(host, '生成结构方案').click();
    await flush();
    assert(text(host).includes('未联网'));
    await byText(host, '打开 AI 设置').click();
    assert.strictEqual(settings, 1);

    controller.updateProject(PROJECT, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    goal = host.querySelector('textarea');
    goal.value = '找下一步';
    await goal.dispatch('input');
    await byText(host, '生成写作导航').click();
    await flush();
    await byText(host, '处理这个建议').click();
    await flush();
    assert(text(host).includes('现有审阅保持不变'));
    assert(!text(host).includes('internal copy'));
    await byText(host, '前往当前审阅').click();
    assert.strictEqual(review, 1);
  });

  await test('UNKNOWN recovery blocks normal operations and only queries before acknowledgement', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    let queries = 0;
    let acknowledgements = 0;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onQueryRecovery: async () => {
        queries += 1;
        return queries === 1
          ? { ok: true, state: 'UNKNOWN', operationId: 'wst_1', recoveryRequired: true }
          : { ok: true, state: 'COMMITTED', operationId: 'wst_1', files: [{ path: 'chapters/01.md' }], recoveryRequired: true };
      },
      onAcknowledgeRecovery: async () => {
        acknowledgements += 1;
        return { ok: true, state: 'COMMITTED', operationId: 'wst_1', acknowledged: true };
      },
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    await controller.recover();
    assert(text(host).includes('提交状态正在核对'));
    assert.strictEqual(acknowledgements, 0);
    await byText(host, '重新核对提交状态').click();
    await flush();
    assert(text(host).includes('章节骨架已经创建'));
    await byText(host, '完成恢复').click();
    await flush();
    assert.strictEqual(acknowledgements, 1);
    assert(text(host).includes('已创建 1 个章节骨架'));
  });

  await test('late recovery acknowledgement failure cannot mutate the next project', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const pending = deferred();
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onQueryRecovery: async () => ({
        ok: true,
        state: 'COMMITTED',
        operationId: 'wst_late',
        files: [{ path: 'chapters/01.md' }],
        recoveryRequired: true,
      }),
      onAcknowledgeRecovery: () => pending.promise,
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    await controller.recover();
    void byText(host, '完成恢复').click();
    await flush();
    controller.updateProject({ instanceId: 'instance_abcdef0123456789abcdef01' }, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    pending.reject(Object.assign(new Error('late'), { code: 'RECOVERY_FAILED' }));
    await flush();
    assert.strictEqual(controller.getState().projectInstanceId, 'instance_abcdef0123456789abcdef01');
    assert.strictEqual(controller.getState().phase, 'idle');
    assert.strictEqual(controller.getState().error, null);
  });

  await test('project switch and old finally cannot clear the new busy owner', async () => {
    const document = new Document();
    const host = document.createElement('div');
    document.body.append(host);
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const controller = View.mount(host, {
      stateApi: State,
      createAttemptId: nextId,
      onGenerate: () => (++calls === 1 ? first.promise : second.promise),
    });
    controller.updateProject(PROJECT, [{ type: 'file', path: 'edit.md' }]);
    let goal = host.querySelector('textarea');
    goal.value = '规划 A';
    await goal.dispatch('input');
    void byText(host, '生成结构方案').click();
    await flush();
    controller.updateProject({ instanceId: 'instance_abcdef0123456789abcdef01' }, [
      { type: 'file', path: 'edit.md' },
      { type: 'file', path: 'chapters/01.md' },
    ], 'chapters/01.md');
    goal = host.querySelector('textarea');
    goal.value = '导航 B';
    await goal.dispatch('input');
    void byText(host, '生成写作导航').click();
    await flush();
    first.resolve(structure());
    await flush();
    assert.strictEqual(controller.getState().generation.attemptId.startsWith('wno_'), true);
    assert.strictEqual(controller.getState().projectInstanceId, 'instance_abcdef0123456789abcdef01');
    second.resolve(navigation());
    await flush();
    assert.strictEqual(controller.getState().phase, 'navigation-ready');
  });

  console.log(`\nWriting Navigation Renderer dynamic passed: ${passed}/${passed}.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
