'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const pendingStoreService = require('../src/main/pending-changeset-store');
const projectChangesService = require('../src/main/project-changes-proposal-service');
const service = require('../src/main/chapter-proposal-service');

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

function makeProject(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-chapter-generation-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.mkdirSync(path.join(root, 'references'));
  fs.mkdirSync(path.join(root, 'sources'));
  if (options.edit !== false) fs.writeFileSync(path.join(root, 'edit.md'), options.edit || '# 项目主旨\n保持克制、准确。\n');
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), options.target ?? '# 第一章\n旧正文。\n');
  fs.writeFileSync(path.join(root, 'chapters', 'blank.md'), '');
  fs.writeFileSync(path.join(root, 'chapters', 'context.md'), '# 背景\n上下文证据。\n');
  fs.writeFileSync(path.join(root, 'references', 'source.md'), '# 只读来源\n原始证据。\n');
  fs.writeFileSync(path.join(root, 'sources', 'source.md'), '# 只读素材\n素材证据。\n');
  return root;
}

function request(overrides = {}) {
  return {
    schema: service.REQUEST_SCHEMA,
    targetPath: 'chapters/one.md',
    instruction: '整体重写当前章节',
    contextPaths: [],
    ...overrides,
  };
}

function plan(blocks = [{ id: 'b1', heading: '第一节', goal: '完成正文', targetChars: 800 }], summary = '完整生成当前章节') {
  return { schema: service.PLAN_SCHEMA, summary, blocks };
}

function block(blockId, content) {
  return { schema: service.BLOCK_SCHEMA, blockId, content };
}

function response(payload, stopReason = 'end_turn') {
  return { ok: true, text: typeof payload === 'string' ? payload : JSON.stringify(payload), stopReason };
}

function queuedLLM(responses, capture = []) {
  let index = 0;
  const fn = async (messages, model, maxTokens) => {
    capture.push({ messages, model, maxTokens });
    const item = responses[index++];
    if (typeof item === 'function') return item({ messages, model, maxTokens, index });
    return item;
  };
  fn.calls = () => index;
  return fn;
}

function propose(root, callLLM, overrides = {}) {
  return service.proposeChapter({
    projectService,
    rootPath: root,
    request: request(overrides),
    callLLM,
    changeSetService,
  });
}

async function run() {
  console.log('\nChapter generation contract verification');

  await test('plans, generates multiple bounded blocks and assembles one file ChangeSet without writing', async () => {
    const root = makeProject();
    try {
      const calls = [];
      const llm = queuedLLM([
        response(plan([
          { id: 'opening', heading: '开场', goal: '建立冲突', targetChars: 900 },
          { id: 'turn', heading: '转折', goal: '推进决定', targetChars: 1100 },
        ], '重写为两段式章节')),
        response(block('opening', '# 第一章\n\n新的开场。')),
        response(block('turn', '## 转折\n\n新的决定。')),
      ], calls);
      const before = projectService.readFileWithRevision(root, 'chapters/one.md');
      const result = await propose(root, llm, { contextPaths: ['chapters/context.md', 'references/source.md'] });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.noChanges, false);
      assert.strictEqual(result.fileCount, 1);
      assert.strictEqual(result.changeSet.changes[0].after, '# 第一章\n\n新的开场。\n\n## 转折\n\n新的决定。\n');
      assert.strictEqual(result.changeSet.changes[0].expectedRevision, before.revision);
      assert.strictEqual(projectService.readFileWithRevision(root, 'chapters/one.md').revision, before.revision);
      assert.deepStrictEqual(changeSetService.validateChangeSet(result.changeSet), result.changeSet);
      assert.deepStrictEqual(result.contextManifest.files.map(file => [file.path, file.role]), [
        ['edit.md', 'project_prompt'],
        ['chapters/one.md', 'target'],
        ['chapters/context.md', 'context'],
        ['references/source.md', 'context'],
      ]);
      assert.strictEqual(result.provenance.kind, 'chapter_generation');
      assert.strictEqual(result.provenance.generation.strategy, 'planned_blocks');
      assert.strictEqual(result.provenance.generation.blockCount, 2);
      assert.strictEqual(result.provenance.generation.blockRetryCount, 0);
      assert.strictEqual(result.contextManifest.blockRetryCount, 0);
      assert.deepStrictEqual(calls.map(item => item.maxTokens), [
        service.PLAN_MAX_TOKENS,
        service.blockTokenBudget({ targetChars: 900 }),
        service.blockTokenBudget({ targetChars: 1100 }),
      ]);
      assert(calls[1].maxTokens < calls[2].maxTokens && calls[2].maxTokens <= service.BLOCK_MAX_TOKENS);
      assert(calls[0].messages[0].content.includes('完整章节生成规划器'));
      assert(calls[1].messages[0].content.includes('完整章节区块生成器'));
      assert(calls[2].messages[0].content.includes('新的开场。'));
      assert(calls.every(item => item.model === 'MiniMax-M3'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('canonicalizes transport line endings and outer blank lines without retrying or changing Markdown meaning', async () => {
    const root = makeProject();
    try {
      const llm = queuedLLM([
        response(plan()),
        response(block('b1', '\r\n# 第一章\r\n\r\n精简正文。  \r\n')),
      ]);
      const result = await propose(root, llm);
      assert.strictEqual(result.changeSet.changes[0].after, '# 第一章\n\n精简正文。  \n');
      assert.strictEqual(result.contextManifest.blockRetryCount, 0);
      assert.strictEqual(llm.calls(), 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('retries one content-boundary failure without echoing rejected model output', async () => {
    const root = makeProject();
    try {
      const calls = [];
      const privateRejectedOutput = `DO_NOT_ECHO_${'中'.repeat(service.MAX_BLOCK_OUTPUT_CHARS + 1)}`;
      const llm = queuedLLM([
        response(plan()),
        response(block('b1', privateRejectedOutput)),
        response(block('b1', '# 第一章\n\n重新生成的精简正文。')),
      ], calls);
      const result = await propose(root, llm);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.changeSet.changes[0].after, '# 第一章\n\n重新生成的精简正文。\n');
      assert.strictEqual(result.provenance.generation.blockRetryCount, 1);
      assert.strictEqual(result.contextManifest.blockRetryCount, 1);
      assert.strictEqual(llm.calls(), 3);
      assert(calls[2].messages[0].content.includes('唯一一次区块重试'));
      assert(calls[2].messages[0].content.includes('character_limit'));
      assert(!calls[2].messages[0].content.includes('DO_NOT_ECHO'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('fails closed after the single bounded retry and never creates a partial ChangeSet', async () => {
    const root = makeProject();
    try {
      const before = projectService.readFileWithRevision(root, 'chapters/one.md');
      const llm = queuedLLM([
        response(plan()),
        response(block('b1', '')),
        response(block('b1', '   \n')),
      ]);
      await assert.rejects(
        () => propose(root, llm),
        error => error?.code === 'INVALID_MODEL_OUTPUT' &&
          /连续两次未生成可安全审阅/.test(error.message)
      );
      assert.strictEqual(llm.calls(), 3);
      assert.deepStrictEqual(projectService.readFileWithRevision(root, 'chapters/one.md'), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('revalidates frozen dependencies before the content retry', async () => {
    const root = makeProject();
    try {
      const llm = queuedLLM([
        response(plan()),
        async () => {
          const current = projectService.readFileWithRevision(root, 'chapters/one.md');
          projectService.atomicWriteFile(root, 'chapters/one.md', `${current.content}\n外部变化`, current.revision);
          return response(block('b1', ''));
        },
      ]);
      await expectCode('CHAPTER_DEPENDENCY_STALE', () => propose(root, llm));
      assert.strictEqual(llm.calls(), 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('supports a blank new chapter and still produces a complete file review', async () => {
    const root = makeProject();
    try {
      const result = await propose(root, queuedLLM([
        response(plan([{ id: 'draft', heading: '初稿', goal: '从零成稿', targetChars: 1000 }], '生成空白章节')),
        response(block('draft', '# 新章节\n\n从空白开始。')),
      ]), { targetPath: 'chapters/blank.md', instruction: '从零生成章节' });
      assert.strictEqual(result.changeSet.changes[0].before, '');
      assert.strictEqual(result.changeSet.changes[0].after, '# 新章节\n\n从空白开始。\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects edit.md, references, sources, private, missing and non-Markdown targets before network use', async () => {
    const root = makeProject();
    try {
      fs.writeFileSync(path.join(root, 'notes.txt'), 'not markdown');
      let calls = 0;
      const llm = async () => { calls += 1; return response(plan()); };
      for (const targetPath of ['edit.md', 'references/source.md', 'sources/source.md']) {
        await expectCode('RESERVED_TARGET', () => propose(root, llm, { targetPath }));
      }
      for (const targetPath of ['missing.md', 'notes.txt', '../outside.md', '/tmp/a.md', '.writcraft/state.md']) {
        await expectCode('INVALID_TARGET', () => propose(root, llm, { targetPath }));
      }
      assert.strictEqual(calls, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('requires a readable bounded edit.md as an immutable project prompt', async () => {
    const missing = makeProject({ edit: false });
    const large = makeProject();
    try {
      let calls = 0;
      const llm = async () => { calls += 1; return response(plan()); };
      await expectCode('PROJECT_PROMPT_REQUIRED', () => propose(missing, llm));
      fs.writeFileSync(path.join(large, 'edit.md'), '中'.repeat(Math.ceil(service.MAX_FILE_BYTES / 3) + 1));
      await expectCode('PROJECT_PROMPT_REQUIRED', () => propose(large, llm));
      assert.strictEqual(calls, 0);
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
      fs.rmSync(large, { recursive: true, force: true });
    }
  });

  await test('enforces an exact bounded renderer request and unique explicit readonly contexts', async () => {
    const root = makeProject();
    try {
      const llm = queuedLLM([response(plan())]);
      await expectCode('INVALID_CHAPTER_REQUEST', () => service.proposeChapter({
        projectService, rootPath: root,
        request: { ...request(), extra: true }, callLLM: llm, changeSetService,
      }));
      const polluted = Object.create({ inherited: true });
      Object.assign(polluted, request());
      await expectCode('INVALID_CHAPTER_REQUEST', () => service.proposeChapter({
        projectService, rootPath: root, request: polluted, callLLM: llm, changeSetService,
      }));
      await expectCode('INVALID_INSTRUCTION', () => propose(root, llm, { instruction: ' 中心 ' }));
      await expectCode('INVALID_INSTRUCTION', () => propose(root, llm, { instruction: '中'.repeat(3000) }));
      await expectCode('INVALID_CONTEXT', () => propose(root, llm, { contextPaths: ['edit.md'] }));
      await expectCode('INVALID_CONTEXT', () => propose(root, llm, { contextPaths: ['chapters/one.md'] }));
      await expectCode('INVALID_CONTEXT', () => propose(root, llm, { contextPaths: ['chapters/context.md', 'chapters/context.md'] }));
      await expectCode('INVALID_CONTEXT', () => propose(root, llm, { contextPaths: Array(service.MAX_CONTEXT_FILES + 1).fill('chapters/context.md') }));
      assert.strictEqual(llm.calls(), 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects fenced, peripheral, extra-field and prototype-key plan JSON', async () => {
    const root = makeProject();
    try {
      for (const text of [
        `\`\`\`json\n${JSON.stringify(plan())}\n\`\`\``,
        `说明\n${JSON.stringify(plan())}`,
        JSON.stringify({ ...plan(), extra: true }),
        '{"schema":"writcraft.chapter-generation-plan/v1","summary":"摘要","blocks":[],"__proto__":{}}',
        '{"schema":"writcraft.chapter-generation-plan/v1","summary":"摘要一","summary":"摘要二","blocks":[]}',
      ]) {
        await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([response(text)])));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('validates plan summary, item schema, ids, per-item and aggregate character/byte bounds', async () => {
    const root = makeProject();
    try {
      const badPlans = [
        plan([], '摘要'),
        { ...plan(), summary: '中'.repeat(400) },
        plan([{ id: 'b1', heading: '标题', goal: '目标', targetChars: 1, extra: true }]),
        plan([{ id: 'B 1', heading: '标题', goal: '目标', targetChars: 1 }]),
        plan([{ id: 'b1', heading: '标题', goal: '目标', targetChars: 1 }, { id: 'b1', heading: '标题', goal: '目标', targetChars: 1 }]),
        plan([{ id: 'b1', heading: '中'.repeat(100), goal: '目标', targetChars: 1 }]),
        plan([{ id: 'b1', heading: '标题', goal: '中'.repeat(700), targetChars: 1 }]),
        plan([{ id: 'b1', heading: '标题', goal: '目标', targetChars: service.MAX_BLOCK_TARGET_CHARS + 1 }]),
        plan(Array.from({ length: service.MAX_PLAN_BLOCKS }, (_, index) => ({
          id: `b${index}`, heading: '标题', goal: '目标', targetChars: service.MAX_BLOCK_TARGET_CHARS,
        }))),
      ];
      for (const bad of badPlans) {
        await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([response(bad)])));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('fails closed on every incomplete plan stop reason including missing and unknown', async () => {
    const root = makeProject();
    try {
      await expectCode('MODEL_OUTPUT_TRUNCATED', () => propose(root, queuedLLM([response(plan(), 'max_tokens')])));
      for (const stopReason of ['tool_use', 'unknown', undefined]) {
        const model = response(plan(), stopReason);
        if (stopReason === undefined) delete model.stopReason;
        await expectCode('MODEL_OUTPUT_INCOMPLETE', () => propose(root, queuedLLM([model])));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('fails closed on incomplete or malformed later blocks without producing a partial ChangeSet', async () => {
    const root = makeProject();
    try {
      const before = fs.readFileSync(path.join(root, 'chapters', 'one.md'), 'utf8');
      const two = plan([
        { id: 'b1', heading: '一', goal: '一', targetChars: 500 },
        { id: 'b2', heading: '二', goal: '二', targetChars: 500 },
      ]);
      await expectCode('MODEL_OUTPUT_TRUNCATED', () => propose(root, queuedLLM([
        response(two), response(block('b1', '# 完整第一块')), response(block('b2', '第二块不完整'), 'max_tokens'),
      ])));
      await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([
        response(two), response(block('b1', '# 完整第一块')), response({ ...block('b2', '第二块'), extra: true }),
      ])));
      await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([
        response(two), response(block('wrong', '# 错块')),
      ])));
      assert.strictEqual(fs.readFileSync(path.join(root, 'chapters', 'one.md'), 'utf8'), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('revalidates target, edit.md and explicit context after model stages', async () => {
    for (const changedPath of ['chapters/one.md', 'edit.md', 'chapters/context.md']) {
      const root = makeProject();
      try {
        const llm = queuedLLM([
          async () => {
            const snapshot = projectService.readFileWithRevision(root, changedPath);
            projectService.atomicWriteFile(root, changedPath, `${snapshot.content}\n外部变化`, snapshot.revision);
            return response(plan());
          },
        ]);
        await expectCode('CHAPTER_DEPENDENCY_STALE', () => propose(root, llm, { contextPaths: ['chapters/context.md'] }));
        assert.strictEqual(llm.calls(), 1);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  await test('revalidates all dependencies after each generated block and never exposes partial output', async () => {
    const root = makeProject();
    try {
      const llm = queuedLLM([
        response(plan([
          { id: 'b1', heading: '一', goal: '一', targetChars: 500 },
          { id: 'b2', heading: '二', goal: '二', targetChars: 500 },
        ])),
        async () => {
          const current = projectService.readFileWithRevision(root, 'chapters/context.md');
          projectService.atomicWriteFile(root, 'chapters/context.md', `${current.content}\n变化`, current.revision);
          return response(block('b1', '# 第一块'));
        },
      ]);
      await expectCode('CHAPTER_DEPENDENCY_STALE', () => propose(root, llm, { contextPaths: ['chapters/context.md'] }));
      assert.strictEqual(llm.calls(), 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('binds target, edit and all contexts into the pending transaction and blocks each stale apply-time dependency', async () => {
    for (const changedPath of ['edit.md', 'chapters/one.md', 'chapters/context.md', 'references/source.md']) {
      const root = makeProject();
      try {
        const result = await propose(root, queuedLLM([
          response(plan()), response(block('b1', '# 第一章\n重写内容。')),
        ]), { contextPaths: ['chapters/context.md', 'references/source.md'] });
        const store = pendingStoreService.createPendingChangeSetStore({ idFactory: () => '12345678-1234-1234-1234-123456789abc' });
        const capability = store.put(result.changeSet, root, {
          projectDependencies: result.contextManifest.files,
          provenance: result.provenance,
          selectionPolicy: 'file',
        });
        const pending = store.get(capability);
        assert.deepStrictEqual(pending.projectDependencies.map(item => item.path), [
          'edit.md', 'chapters/one.md', 'chapters/context.md', 'references/source.md',
        ]);
        assert.strictEqual(pending.selectionPolicy, 'file');
        const snapshot = projectService.readFileWithRevision(root, changedPath);
        projectService.atomicWriteFile(root, changedPath, `${snapshot.content}\n外部变化`, snapshot.revision);
        assert.throws(() => projectChangesService.validateProjectDependencies({
          projectService, rootPath: root, dependencies: pending.projectDependencies,
        }), error => error?.code === 'PROJECT_CHANGES_STALE', changedPath);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  await test('returns a clean noChanges result without a ChangeSet or capability-shaped field', async () => {
    const root = makeProject();
    try {
      const result = await propose(root, queuedLLM([
        response(plan([{ id: 'same', heading: '原文', goal: '保持不变', targetChars: 20 }], '无需调整')),
        response(block('same', '# 第一章\n旧正文。')),
      ]));
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.noChanges, true);
      assert.strictEqual(result.fileCount, 0);
      assert.strictEqual(result.changeSet, undefined);
      assert.strictEqual(result.changeSetId, undefined);
      assert.strictEqual(result.review, undefined);
      assert.strictEqual(result.provenance.kind, 'chapter_generation');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('enforces UTF-8 byte limits on paths, model summaries and block content', async () => {
    const root = makeProject();
    try {
      assert.strictEqual(service.publicMarkdownPath(`${'中'.repeat(170)}.md`), null);
      await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([
        response(plan(undefined, '中'.repeat(400))),
      ])));
      const oversizedBlock = response(block('b1', '中'.repeat(5500)));
      await expectCode('INVALID_MODEL_OUTPUT', () => propose(root, queuedLLM([
        response(plan([{ id: 'b1', heading: '正文', goal: '生成长区块', targetChars: service.MAX_BLOCK_TARGET_CHARS }])),
        oversizedBlock,
        oversizedBlock,
      ])));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('fails before network when aggregate source or complete prompt exceeds its byte budget', async () => {
    const root = makeProject();
    try {
      fs.writeFileSync(path.join(root, 'chapters', 'one.md'), 'a'.repeat(service.MAX_FILE_BYTES - 100));
      fs.writeFileSync(path.join(root, 'chapters', 'context.md'), 'b'.repeat(service.MAX_FILE_BYTES - 100));
      fs.writeFileSync(path.join(root, 'references', 'source.md'), 'c'.repeat(1000));
      let calls = 0;
      await expectCode('CHAPTER_CONTEXT_TOO_LARGE', () => propose(root, async () => { calls += 1; return response(plan()); }, {
        contextPaths: ['chapters/context.md', 'references/source.md'],
      }));
      assert.strictEqual(calls, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('Main and preload use an exact request, post-model dependency gate, no-op exit and file-level cached review', () => {
    const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
    const start = main.indexOf("ipcMain.handle('writcraft:project:propose-chapter'");
    const end = main.indexOf("ipcMain.handle('writcraft:project:propose-onboarding'", start);
    const route = main.slice(start, end);
    assert(start >= 0);
    for (const marker of [
      'assertTrustedSender(event)', 'requireCurrentProject()', 'request,', 'changeSetService,',
      'validateChapterDependencies', 'if (proposal.noChanges) return proposal',
      'projectDependencies: proposal.contextManifest.files', "selectionPolicy: 'file'", 'provenance: proposal.provenance',
    ]) assert(route.includes(marker), `Main Chapter route 缺少 ${marker}`);
    assert(route.indexOf('if (proposal.noChanges) return proposal') < route.indexOf('cacheReviewedChangeSet'));
    assert(!route.includes('atomicWriteFile'));
    assert(preload.includes("proposeChapter: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:propose-chapter', projectInstanceId, request)"));
  });

  await test('Renderer sends the exact schema, blocks reserved targets and handles safe no-op before review replacement', () => {
    const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/changes-view.js'), 'utf8');
    const start = renderer.indexOf('async function proposeChapter()');
    const end = renderer.indexOf('async function applySelected()', start);
    const route = renderer.slice(start, end);
    assert(route.includes("schema: 'writcraft.chapter-generation-request/v1'"));
    assert(route.includes('bridge.proposeChapter(metric.originProjectInstanceId, chapterSession.request)'));
    assert(route.includes('WritCraftChangesProposalTransaction?.beginChapter?.('));
    assert(route.includes('WritCraftChangesProposalTransaction.settleChapter('));
    assert(route.includes('WritCraftChangesProposalTransaction.releaseStaleChapterResult('));
    assert(route.includes('pendingReview: pending'));
    assert(route.includes('replaceGeneratedChapterReview(result, metric, chapterSession, currentBinding, contextPaths)'));
    assert(route.includes("normalizedTarget.startsWith('references/')"));
    assert(route.includes("normalizedTarget.startsWith('sources/')"));
    assert(route.includes('WritCraftChangesProposalTransaction.classifyChapterResult('));
    assert(route.includes("if (classified.kind === 'no_changes') return await finishNoChanges('chapter', result, metric, {"));
    assert(route.includes('isCurrent: () => window.WritCraftChangesProposalTransaction.isChapterCurrent('));
    assert(route.indexOf("classified.kind === 'no_changes'") < route.indexOf('replaceGeneratedChapterReview'));
  });

  console.log(`\n${passed}/21 chapter-generation checks passed.\n`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
