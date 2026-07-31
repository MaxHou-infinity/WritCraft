'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const {
  PLAN_SCHEMA,
  MAX_GOAL_CHARS,
  MAX_CONTEXT_FILES,
  MAX_CONTEXT_BYTES,
  MAX_MODEL_OUTPUT_BYTES,
  MAX_MILESTONES,
  MAX_TASKS_PER_MILESTONE,
  MAX_UNIQUE_TARGETS,
  MAX_TARGET_SNAPSHOT_BYTES,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  parseModelJson,
  parseModelResponse,
  proposeProjectPlan,
} = require('../src/main/project-plan-service');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

async function expectCode(code, fn) {
  await assert.rejects(fn, error => error && error.code === code);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-plan-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, 'edit.md'), [
    '---',
    'schema: writcraft.edit/v1',
    'title: "测试项目"',
    '---',
    '',
    '# 项目主旨',
    '保持克制、准确，先计划后写作。',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n现有正文。\n');
  fs.writeFileSync(path.join(root, 'research', 'facts.md'), '# 资料\n已核验事实。\n');
  return root;
}

function validPlan(overrides = {}) {
  return {
    title: '完成第一部分',
    summary: '先确认结构与资料，再进入章节写作。',
    assumptions: ['第一章是当前优先级最高的章节'],
    openQuestions: ['是否需要补充第二来源'],
    milestones: [{
      id: 'm1',
      title: '结构与证据就绪',
      objective: '锁定第一章的论证结构和证据边界。',
      acceptanceCriteria: ['结构与 edit.md 约束一致'],
      tasks: [{
        id: 't1',
        title: '核对项目约束',
        description: '逐项检查主旨、读者与非目标。',
        scope: 'project',
        targetPaths: ['edit.md'],
        dependsOn: [],
        acceptanceCriteria: ['约束无互相冲突'],
      }, {
        id: 't2',
        title: '设计第一章结构',
        description: '只形成结构任务，不生成章节正文。',
        scope: 'file',
        targetPaths: ['chapters/one.md'],
        dependsOn: ['t1'],
        acceptanceCriteria: ['每一节都有明确写作目的'],
      }],
    }],
    ...overrides,
  };
}

function planWithTargets(targetPaths) {
  const tasks = [];
  for (let offset = 0; offset < targetPaths.length; offset += MAX_CONTEXT_FILES) {
    const index = tasks.length + 1;
    tasks.push({
      id: `bulk_t${index}`,
      title: `目标批次 ${index}`,
      description: '验证项目级目标资源上限。',
      scope: 'file',
      targetPaths: targetPaths.slice(offset, offset + MAX_CONTEXT_FILES),
      dependsOn: [],
      acceptanceCriteria: ['只绑定 revision，不写入文件'],
    });
  }
  return validPlan({
    milestones: [{
      id: 'bulk_m1',
      title: '资源上限',
      objective: '验证目标读取保持有界。',
      acceptanceCriteria: ['超限时安全停止'],
      tasks,
    }],
  });
}

function modelResponse(plan = validPlan(), overrides = {}) {
  return {
    ok: true,
    stopReason: 'end_turn',
    contentBlockCount: 1,
    textBlockCount: 1,
    nonTextBlockCount: 0,
    text: typeof plan === 'string' ? plan : JSON.stringify(plan),
    ...overrides,
  };
}

function llmPlan(plan = validPlan(), overrides = {}) {
  return async () => modelResponse(plan, overrides);
}

function snapshotPublic(root) {
  return {
    edit: fs.readFileSync(path.join(root, 'edit.md'), 'utf8'),
    chapter: fs.readFileSync(path.join(root, 'chapters', 'one.md'), 'utf8'),
    facts: fs.readFileSync(path.join(root, 'research', 'facts.md'), 'utf8'),
  };
}

function snapshotTree(root) {
  const result = [];
  const visit = relativePath => {
    const absolutePath = path.join(root, relativePath);
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.posix.join(relativePath.replaceAll(path.sep, '/'), entry.name).replace(/^\.\//, '');
      if (entry.isDirectory()) {
        result.push({ path: `${child}/`, type: 'directory' });
        visit(child);
      } else {
        result.push({ path: child, type: 'file', bytes: fs.readFileSync(path.join(root, child)).toString('base64') });
      }
    }
  };
  visit('.');
  return result;
}

async function run() {
  console.log('\nProject Plan Mode service verification');

  await test('returns a revision-bound structured plan without writing manuscript files', async () => {
    const root = makeProject();
    try {
      const before = snapshotPublic(root);
      const result = await proposeProjectPlan({
        projectService, rootPath: root, goal: '完成第一章的可执行写作计划', callLLM: llmPlan(),
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.plan.schema, PLAN_SCHEMA);
      assert.match(result.plan.planId, /^plan_[a-f0-9]{24}$/);
      assert.deepStrictEqual(result.plan.milestones[0].tasks.map(task => task.id), ['t1', 't2']);
      assert.deepStrictEqual(result.plan.milestones[0].tasks[1].targets, [{
        path: 'chapters/one.md',
        revision: projectService.readFileWithRevision(root, 'chapters/one.md').revision,
      }]);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(result.plan.milestones[0].tasks[1], 'targetPaths'), false);
      assert.deepStrictEqual(snapshotPublic(root), before);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'changeSet'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('uses authoritative edit.md first and only user-explicit context snapshots', async () => {
    const root = makeProject();
    try {
      let captured;
      const callLLM = async (messages, model, maxTokens) => {
        captured = { messages, model, maxTokens };
        return modelResponse();
      };
      const result = await proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划第一章',
        contextPaths: ['research/facts.md', 'research/facts.md', 'edit.md'],
        callLLM,
      });
      assert.deepStrictEqual(result.contextManifest.files.map(file => [file.path, file.role]), [
        ['edit.md', 'project_prompt'],
        ['research/facts.md', 'context'],
      ]);
      assert(result.contextManifest.files.every(file => /^[a-f0-9]{64}$/.test(file.revision)));
      assert.strictEqual(result.contextManifest.omitted.length, 0);
      assert.strictEqual(result.contextManifest.editPrompt.frontMatterStatus, 'valid');
      assert.strictEqual(captured.model, 'MiniMax-M3');
      assert.strictEqual(captured.maxTokens, 8192);
      const prompt = captured.messages[0].content;
      assert(prompt.includes('edit.md 是权威项目 Prompt'));
      assert(prompt.includes('research/facts.md'));
      assert(prompt.includes('不能创建、修改、删除或移动文件'));
      assert(prompt.includes('首个非空白字符必须是 {'));
      assert(prompt.includes('不得包含 Markdown 代码围栏、JSON 前后的解释'));
      assert(prompt.includes('每一项都必须遵守同一结构'));
      assert(prompt.includes('targetPaths/dependsOn/acceptanceCriteria 必须始终是 JSON 数组'));
      assert(prompt.includes('不确定时必须返回 []'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('retries peripheral text once without echoing model output or relaxing strict JSON', async () => {
    const root = makeProject();
    try {
      const before = snapshotTree(root);
      const calls = [];
      const invalid = `LEAK_MARKER\n${JSON.stringify(validPlan())}`;
      const result = await proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划第一章',
        callLLM: async messages => {
          calls.push(messages[0].content);
          return calls.length === 1 ? modelResponse(invalid) : modelResponse();
        },
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 2);
      assert(calls[1].includes('唯一一次结构重试'));
      assert(!calls[1].includes('LEAK_MARKER'));
      assert.deepStrictEqual(snapshotTree(root), before);

      let rejectedCalls = 0;
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '验证有界格式重试',
        callLLM: async () => {
          rejectedCalls += 1;
          return modelResponse(invalid);
        },
      }));
      assert.strictEqual(rejectedCalls, 2);
      assert.deepStrictEqual(snapshotTree(root), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('retries an invalid task array shape once without coercing or echoing model output', async () => {
    const root = makeProject();
    try {
      const before = snapshotTree(root);
      const malformed = validPlan();
      malformed.milestones[0].tasks[1].targetPaths = 'LEAK_TARGET_PATH';
      const calls = [];
      const result = await proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划第一章',
        callLLM: async messages => {
          calls.push(messages[0].content);
          return calls.length === 1 ? modelResponse(malformed) : modelResponse();
        },
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(calls.length, 2);
      assert(calls[1].includes('唯一一次结构重试'));
      assert(calls[1].includes('每一个任务，而不只是第一个任务'));
      assert(!calls[1].includes('LEAK_TARGET_PATH'));
      assert.deepStrictEqual(snapshotTree(root), before);

      let rejectedCalls = 0;
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '验证有界结构重试',
        callLLM: async () => {
          rejectedCalls += 1;
          return modelResponse(malformed);
        },
      }));
      assert.strictEqual(rejectedCalls, 2, 'one operation must never make a third provider call');

      let mixedCalls = 0;
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '验证共享重试预算',
        callLLM: async () => {
          mixedCalls += 1;
          return mixedCalls === 1
            ? modelResponse(`说明：${JSON.stringify(validPlan())}`)
            : modelResponse(malformed);
        },
      }));
      assert.strictEqual(mixedCalls, 2, 'peripheral and structure failures share one retry budget');
      assert.deepStrictEqual(snapshotTree(root), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('fails closed before bounded model-output retry when project authority changed', async () => {
    const root = makeProject();
    try {
      const beforeEdit = fs.readFileSync(path.join(root, 'edit.md'), 'utf8');
      let calls = 0;
      await expectCode('PLAN_DEPENDENCY_STALE', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划第一章',
        callLLM: async () => {
          calls += 1;
          fs.writeFileSync(path.join(root, 'edit.md'), `${beforeEdit}\n外部变化\n`);
          return modelResponse(`说明：${JSON.stringify(validPlan())}`);
        },
      }));
      assert.strictEqual(calls, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('creates a deterministic plan ID from the goal, revisions and validated plan', async () => {
    const root = makeProject();
    try {
      const input = { projectService, rootPath: root, goal: '规划第一章', callLLM: llmPlan() };
      const first = await proposeProjectPlan(input);
      const second = await proposeProjectPlan(input);
      assert.strictEqual(first.plan.planId, second.plan.planId);
      const changed = await proposeProjectPlan({ ...input, goal: '规划第一章并核对证据' });
      assert.notStrictEqual(first.plan.planId, changed.plan.planId);
      fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n目标文件已变化。\n');
      const changedTarget = await proposeProjectPlan(input);
      assert.notStrictEqual(first.plan.planId, changedTarget.plan.planId);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('requires authoritative edit.md and a bounded non-empty goal before model use', async () => {
    const root = makeProject();
    try {
      let calls = 0;
      const callLLM = async () => { calls += 1; return { ok: true, text: '{}' }; };
      for (const goal of ['', '   ', 'x'.repeat(MAX_GOAL_CHARS + 1), null]) {
        await expectCode('INVALID_GOAL', () => proposeProjectPlan({ projectService, rootPath: root, goal, callLLM }));
      }
      fs.unlinkSync(path.join(root, 'edit.md'));
      await expectCode('MISSING_EDIT_PROMPT', () => proposeProjectPlan({
        projectService, rootPath: root, goal: '规划', callLLM,
      }));
      assert.strictEqual(calls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('rejects invalid or excessive context paths before model use', async () => {
    const root = makeProject();
    try {
      let calls = 0;
      const callLLM = async () => { calls += 1; return { ok: true, text: '{}' }; };
      for (const contextPaths of [
        ['missing.md'],
        ['../outside.md'],
        Array(MAX_CONTEXT_FILES + 1).fill('research/facts.md'),
        'research/facts.md',
      ]) {
        await expectCode('INVALID_CONTEXT', () => proposeProjectPlan({
          projectService, rootPath: root, goal: '规划', contextPaths, callLLM,
        }));
      }
      assert.strictEqual(calls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('enforces aggregate context byte limits before model use', async () => {
    const root = makeProject();
    try {
      fs.writeFileSync(path.join(root, 'edit.md'), 'x'.repeat(MAX_CONTEXT_BYTES + 1));
      let calls = 0;
      await expectCode('CONTEXT_TOO_LARGE', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划',
        callLLM: async () => { calls += 1; return { ok: true, text: '{}' }; },
      }));
      assert.strictEqual(calls, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('preflights the exact serialized provider request before dispatch', async () => {
    const longPaths = Array.from({ length: 5000 }, (_, index) =>
      `chapters/${String(index).padStart(4, '0')}-${'x'.repeat(210)}.md`);
    let calls = 0;
    const boundedProjectService = {
      listTree() {
        return [{ type: 'file', path: 'edit.md' }, ...longPaths.map(filePath => ({ type: 'file', path: filePath }))];
      },
      readFileWithRevision(_rootPath, relPath) {
        assert.strictEqual(relPath, 'edit.md');
        return { content: '# Prompt\n', revision: 'a'.repeat(64), frontMatter: { status: 'valid', diagnostics: [] } };
      },
    };
    await expectCode('PLAN_PROMPT_TOO_LARGE', () => proposeProjectPlan({
      projectService: boundedProjectService,
      rootPath: '/bounded-prompt-fixture',
      goal: '验证最终请求上限',
      callLLM: async () => { calls += 1; return modelResponse(); },
    }));
    assert.strictEqual(calls, 0);
    const serialized = JSON.stringify({
      model: 'MiniMax-M3', max_tokens: 8192,
      messages: [{ role: 'user', content: longPaths.join('\n') }],
    });
    assert(Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_REQUEST_BYTES);
  });

  await test('validates completion metadata before provider status or model text', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const truncatedSecret = modelResponse('secret, not JSON', { ok: false, stopReason: 'max_tokens' });
    assert.throws(() => parseModelResponse(truncatedSecret, available), error =>
      error.code === 'MODEL_OUTPUT_TRUNCATED' && !error.message.includes('secret'));
    for (const stopReason of ['tool_use', 'unknown', '', null]) {
      assert.throws(
        () => parseModelResponse(modelResponse(validPlan(), { ok: false, stopReason }), available),
        error => error.code === 'MODEL_OUTPUT_INCOMPLETE'
      );
    }
    assert.throws(
      () => parseModelResponse(modelResponse(validPlan(), { ok: false, contentBlockCount: 2 }), available),
      error => error.code === 'INVALID_MODEL_OUTPUT'
    );
    assert.strictEqual(parseModelResponse(modelResponse(validPlan(), { ok: false }), available).title, '完成第一部分');
    assert.throws(
      () => parseModelResponse({ ok: true, text: JSON.stringify(validPlan()) }, available),
      error => error.code === 'MODEL_OUTPUT_INCOMPLETE'
    );
  });

  await test('requires exactly one text block and no additional content blocks', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    for (const overrides of [
      { contentBlockCount: 0 },
      { contentBlockCount: 2, textBlockCount: 2 },
      { textBlockCount: 0 },
      { nonTextBlockCount: 1, contentBlockCount: 2 },
      { contentBlockCount: '1' },
    ]) {
      assert.throws(
        () => parseModelResponse(modelResponse(validPlan(), overrides), available),
        error => error.code === 'INVALID_MODEL_OUTPUT'
      );
    }
    const inherited = Object.create(modelResponse());
    inherited.stopReason = 'end_turn';
    assert.throws(
      () => parseModelResponse(inherited, available),
      error => error.code === 'INVALID_MODEL_OUTPUT'
    );
  });

  await test('rejects malformed, oversized and schema-smuggling model output', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    assert.throws(() => parseModelJson('{bad', available), error => error.code === 'INVALID_MODEL_OUTPUT');
    assert.throws(
      () => parseModelJson('x'.repeat(MAX_MODEL_OUTPUT_BYTES + 1), available),
      error => error.code === 'MODEL_OUTPUT_TOO_LARGE'
    );
    assert.throws(
      () => parseModelJson(JSON.stringify({ ...validPlan(), changes: [{ path: 'chapters/one.md', after: '正文' }] }), available),
      error => error.code === 'INVALID_MODEL_OUTPUT'
    );
    const injected = validPlan();
    injected.milestones[0].tasks[0].after = '偷偷改正文';
    assert.throws(() => parseModelJson(JSON.stringify(injected), available), error => error.code === 'INVALID_MODEL_OUTPUT');
  });

  await test('strict raw JSON rejects fences, peripheral data, NUL, duplicate and dangerous keys', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const valid = JSON.stringify(validPlan());
    const duplicate = valid.replace('"title":"完成第一部分"', '"title":"甲","title":"乙"');
    const dangerous = valid.replace('"description":"逐项检查主旨、读者与非目标。"',
      '"description":"逐项检查主旨、读者与非目标。","\\u005f\\u005fproto__":{}');
    for (const text of [
      `\`\`\`json\n${valid}\n\`\`\``,
      `说明：${valid}`,
      `${valid} trailing`,
      `${valid}${valid}`,
      `${valid}\0`,
      duplicate,
      dangerous,
    ]) {
      assert.throws(() => parseModelJson(text, available), error => error.code === 'INVALID_MODEL_OUTPUT');
    }
  });

  await test('bounds JSON depth and nodes before materializing the complete model tree', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const deep = `{"title":"x","summary":"x","assumptions":[],"openQuestions":[],"milestones":[],"x":${'['.repeat(MAX_JSON_DEPTH + 2)}0${']'.repeat(MAX_JSON_DEPTH + 2)}}`;
    const wide = `{"title":"x","summary":"x","assumptions":[],"openQuestions":[],"milestones":[],"x":[${'0,'.repeat(MAX_JSON_NODES)}0]}`;
    const fullParseLengths = [];
    const originalParse = JSON.parse;
    JSON.parse = value => {
      fullParseLengths.push(value.length);
      return originalParse(value);
    };
    try {
      assert.throws(() => parseModelJson(deep, available), error => error.code === 'INVALID_MODEL_OUTPUT');
      assert.throws(() => parseModelJson(wide, available), error => error.code === 'INVALID_MODEL_OUTPUT');
    } finally {
      JSON.parse = originalParse;
    }
    assert(!fullParseLengths.includes(deep.length), 'deep model tree must fail before complete JSON.parse');
    assert(!fullParseLengths.includes(wide.length), 'wide model tree must fail before complete JSON.parse');
  });

  await test('requires every key at top-level, milestone and task depth', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const missingTop = validPlan();
    delete missingTop.assumptions;
    const missingMilestone = validPlan();
    delete missingMilestone.milestones[0].objective;
    const missingTask = validPlan();
    delete missingTask.milestones[0].tasks[0].targetPaths;
    for (const plan of [missingTop, missingMilestone, missingTask]) {
      assert.throws(() => parseModelJson(JSON.stringify(plan), available), error => error.code === 'INVALID_MODEL_OUTPUT');
    }
  });

  await test('requires bounded non-empty milestones, tasks and acceptance criteria', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    for (const plan of [
      validPlan({ milestones: [] }),
      validPlan({ milestones: Array(MAX_MILESTONES + 1).fill(validPlan().milestones[0]) }),
      validPlan({ milestones: [{ ...validPlan().milestones[0], tasks: [] }] }),
      validPlan({ milestones: [{ ...validPlan().milestones[0], tasks: Array(MAX_TASKS_PER_MILESTONE + 1).fill(validPlan().milestones[0].tasks[0]) }] }),
      validPlan({ milestones: [{ ...validPlan().milestones[0], acceptanceCriteria: [] }] }),
    ]) {
      assert.throws(() => parseModelJson(JSON.stringify(plan), available), error => error.code === 'INVALID_MODEL_OUTPUT');
    }
  });

  await test('bounds unique targets and aggregate target snapshot reads without retaining content', async () => {
    const root = makeProject();
    try {
      const paths = Array.from({ length: MAX_UNIQUE_TARGETS + 1 }, (_, index) => `chapters/bulk-${index}.md`);
      for (const relPath of paths) fs.writeFileSync(path.join(root, relPath), '# target\n');
      const before = snapshotTree(root);
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '验证目标数量上限',
        callLLM: llmPlan(planWithTargets(paths)),
      }));
      assert.deepStrictEqual(snapshotTree(root), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    const targetPaths = Array.from({ length: 5 }, (_, index) => `chapters/large-${index}.md`);
    const large = 'x'.repeat(Math.floor(MAX_TARGET_SNAPSHOT_BYTES / 4) + 1);
    let targetReads = 0;
    const fakeProjectService = {
      listTree() {
        return [
          { type: 'file', path: 'edit.md' },
          ...targetPaths.map(targetPath => ({ type: 'file', path: targetPath })),
        ];
      },
      readFileWithRevision(_rootPath, relPath) {
        if (relPath === 'edit.md') {
          return { content: '# Prompt\n', revision: 'a'.repeat(64), frontMatter: { status: 'valid', diagnostics: [] } };
        }
        targetReads += 1;
        return { content: large, revision: String(targetReads).padStart(64, '0') };
      },
    };
    await expectCode('PLAN_TARGETS_TOO_LARGE', () => proposeProjectPlan({
      projectService: fakeProjectService,
      rootPath: '/bounded-plan-fixture',
      goal: '验证目标字节上限',
      callLLM: llmPlan(planWithTargets(targetPaths)),
    }));
    assert.strictEqual(targetReads, 4, 'target reads stop immediately after crossing the 16 MiB budget');
  });

  await test('rejects duplicate IDs, invalid scopes and nonexistent target paths', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const duplicate = validPlan();
    duplicate.milestones[0].tasks[1].id = 't1';
    const scope = validPlan();
    scope.milestones[0].tasks[0].scope = 'write-now';
    const target = validPlan();
    target.milestones[0].tasks[0].targetPaths = ['chapters/missing.md'];
    const badId = validPlan();
    badId.milestones[0].id = '../m1';
    for (const plan of [duplicate, scope, badId]) {
      assert.throws(() => parseModelJson(JSON.stringify(plan), available), error => error.code === 'INVALID_MODEL_OUTPUT');
    }
    assert.throws(
      () => parseModelJson(JSON.stringify(target), available),
      error => error.code === 'INVALID_MODEL_OUTPUT' && !error.message.includes('chapters/missing.md')
    );
  });

  await test('allows dependencies only on earlier tasks and rejects self, missing or forward edges', async () => {
    const available = new Set(['edit.md', 'chapters/one.md']);
    const self = validPlan();
    self.milestones[0].tasks[0].dependsOn = ['t1'];
    const missing = validPlan();
    missing.milestones[0].tasks[1].dependsOn = ['missing'];
    const forward = validPlan();
    forward.milestones[0].tasks[0].dependsOn = ['t2'];
    for (const plan of [self, missing, forward]) {
      assert.throws(() => parseModelJson(JSON.stringify(plan), available), error => error.code === 'INVALID_MODEL_OUTPUT');
    }
    assert.deepStrictEqual(parseModelJson(JSON.stringify(validPlan()), available).milestones[0].tasks[1].dependsOn, ['t1']);
  });

  await test('proves success and rejection leave every project byte unchanged and expose no write capability', async () => {
    const root = makeProject();
    try {
      const mutationCalls = [];
      const guardedService = {
        listTree: projectService.listTree,
        readFileWithRevision: projectService.readFileWithRevision,
        atomicWriteFile() { mutationCalls.push('atomicWriteFile'); throw new Error('write must never be called'); },
        createMarkdownFile() { mutationCalls.push('createMarkdownFile'); throw new Error('create must never be called'); },
        deletePath() { mutationCalls.push('deletePath'); throw new Error('delete must never be called'); },
        movePath() { mutationCalls.push('movePath'); throw new Error('move must never be called'); },
      };
      const before = snapshotTree(root);
      const success = await proposeProjectPlan({
        projectService: guardedService,
        rootPath: root,
        goal: '只生成计划',
        callLLM: llmPlan(),
      });
      assert.strictEqual(success.ok, true);
      assert.deepStrictEqual(snapshotTree(root), before);
      const hostile = { ...validPlan(), executed: true, after: '# overwritten' };
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectPlan({
        projectService: guardedService,
        rootPath: root,
        goal: '规划',
        callLLM: llmPlan(hostile),
      }));
      assert.deepStrictEqual(snapshotTree(root), before);
      assert.deepStrictEqual(mutationCalls, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('propagates model failure as a safe result without inventing a plan', async () => {
    const root = makeProject();
    try {
      const result = await proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划',
        callLLM: async () => ({ ok: false, error: 'STUB_FAILURE' }),
      });
      assert.deepStrictEqual(result, { ok: false, error: 'STUB_FAILURE', message: '项目计划生成失败' });
      const hostile = await proposeProjectPlan({
        projectService,
        rootPath: root,
        goal: '规划',
        callLLM: async () => ({ ok: false, error: 'secret path /Users/max/key=' + 'x'.repeat(5000) }),
      });
      assert.deepStrictEqual(hostile, { ok: false, error: 'LLM_FAILED', message: '项目计划生成失败' });
      assert.strictEqual(Object.prototype.hasOwnProperty.call(hostile, 'plan'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(hostile, 'handoffRecord'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  console.log(`\nProject Plan Mode service verification passed: ${passed} tests.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
