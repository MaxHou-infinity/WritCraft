'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const {
  QUESTIONS,
  MAX_ANSWER_CHARS,
  MAX_FILE_SUGGESTIONS,
  MAX_REPAIR_SOURCE_BYTES,
  normalizeAnswers,
  parseModelJson,
  repairPrompt,
  proposeProjectOnboarding,
} = require('../src/main/project-onboarding-service');

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

function makeProject(withEdit = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-'));
  fs.mkdirSync(path.join(root, 'chapters'));
  if (withEdit) fs.writeFileSync(path.join(root, 'edit.md'), '# 项目主旨\n旧项目规则。\n');
  fs.writeFileSync(path.join(root, 'chapters', 'existing.md'), '# 已有章节\n');
  return root;
}

function llmJson(overrides = {}) {
  return async () => ({ ok: true, text: JSON.stringify({
    editContent: '---\nschema: writcraft.edit/v1\ntitle: "产品书"\n---\n\n# 项目主旨\n写一本克制的产品书。\n',
    summary: '完善项目主旨和结构',
    fileSuggestions: [{ path: 'chapters/01-intro.md', reason: '承接主旨', content: '# 第一章\n' }],
    ...overrides,
  }) });
}

async function run() {
  console.log('\nProject onboarding service verification');

  await test('defines the complete project-level guided question sequence', async () => {
    assert.deepStrictEqual(QUESTIONS.map(question => question.id), [
      'premise', 'audience', 'objective', 'scope', 'structure', 'voice',
      'invariants', 'timeline', 'sources', 'openQuestions',
    ]);
    assert(QUESTIONS.every(question => question.label && question.prompt));
  });

  await test('normalizes optional answers and rejects unknown, empty or oversized input', async () => {
    assert.deepStrictEqual(normalizeAnswers({ premise: '  核心观点  ', audience: '', scope: null }), { premise: '核心观点' });
    assert.throws(() => normalizeAnswers({ unknown: 'x' }), error => error.code === 'UNKNOWN_ANSWER');
    assert.throws(() => normalizeAnswers({ premise: ' ' }), error => error.code === 'EMPTY_ANSWERS');
    assert.throws(() => normalizeAnswers({ premise: 'x'.repeat(MAX_ANSWER_CHARS + 1) }), error => error.code === 'ANSWER_TOO_LONG');
  });

  await test('returns only a reviewable edit.md ChangeSet and never writes automatically', async () => {
    const root = makeProject();
    try {
      const before = projectService.readFileWithRevision(root, 'edit.md');
      const result = await proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '写一本产品书', structure: '三章' }, callLLM: llmJson(),
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.changeSet.changes.map(change => change.path), ['edit.md']);
      assert.strictEqual(result.changeSet.changes[0].expectedRevision, before.revision);
      assert.deepStrictEqual(changeSetService.validateChangeSet(result.changeSet), result.changeSet);
      assert.strictEqual(projectService.readFileWithRevision(root, 'edit.md').content, before.content);
      assert.deepStrictEqual(result.fileSuggestions.map(item => item.path), ['chapters/01-intro.md']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('extracts one bounded JSON object and narrowly repairs trailing commas', async () => {
    const available = new Set(['edit.md', 'chapters/existing.md']);
    const payload = JSON.stringify({
      editContent: '---\nschema: writcraft.edit/v1\n---\n\n# 主旨\n正文\n',
      summary: '摘要', fileSuggestions: [],
    });
    assert.equal(parseModelJson(`说明文字\n\`\`\`json\n${payload}\n\`\`\``, available, projectService).summary, '摘要');
    const trailing = payload.replace('"fileSuggestions":[]', '"fileSuggestions":[],');
    assert.equal(parseModelJson(trailing, available, projectService).summary, '摘要');
    const protectedText = payload
      .replace('正文', '正文,} 与 ,] 必须逐字保留')
      .replace('"fileSuggestions":[]', '"fileSuggestions":[],');
    assert(parseModelJson(protectedText, available, projectService).editContent.includes('正文,} 与 ,] 必须逐字保留'));
    assert.throws(() => parseModelJson('{"editContent":"x"}{"summary":"y"}', available, projectService), error => error.code === 'INVALID_MODEL_OUTPUT');
    assert.throws(() => parseModelJson('x'.repeat(512 * 1024 + 1), available, projectService), error => error.code === 'INVALID_MODEL_OUTPUT');
  });

  await test('requires generated edit.md schema v1 before creating a ChangeSet', async () => {
    const root = makeProject();
    try {
      let calls = 0;
      await expectCode('INVALID_EDIT_PROMPT', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: async () => {
          calls += 1;
          return { ok: true, text: JSON.stringify({ editContent: '# 无 Front Matter', summary: '摘要', fileSuggestions: [] }) };
        },
      }));
      assert.equal(calls, 2, 'invalid edit.md should receive exactly one repair attempt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('repairs malformed output once while preserving the review-only boundary', async () => {
    const root = makeProject();
    try {
      const before = fs.readFileSync(path.join(root, 'edit.md'), 'utf8');
      let calls = 0;
      const valid = await llmJson()();
      const result = await proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: async messages => {
          calls += 1;
          if (calls === 1) return { ok: true, text: '{bad json' };
          assert.match(messages[0].content, /格式修复器/);
          return valid;
        },
      });
      assert.equal(calls, 2);
      assert.equal(result.repaired, true);
      assert.equal(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('repair prompt is bounded and never retries oversized model text', async () => {
    assert.equal(repairPrompt('x'.repeat(MAX_REPAIR_SOURCE_BYTES + 1)), null);
    assert.match(repairPrompt('{bad'), /untrusted-model-output/);
  });

  await test('binds the prompt to authoritative edit.md and exposes a transparent answer manifest', async () => {
    const root = makeProject();
    try {
      let captured;
      const callLLM = async (messages, model, maxTokens) => {
        captured = { messages, model, maxTokens };
        return llmJson()();
      };
      const result = await proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点', audience: '专业作者' }, callLLM,
      });
      assert.strictEqual(captured.model, 'MiniMax-M3');
      assert.strictEqual(captured.maxTokens, 4096);
      assert(captured.messages[0].content.includes('revision='));
      assert(captured.messages[0].content.includes('你不能创建文件'));
      assert.deepStrictEqual(result.contextManifest.answered.map(item => item.id), ['premise', 'audience']);
      assert(/^[a-f0-9]{64}$/.test(result.contextManifest.targetRevision));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('requires edit.md before proposing project-level changes', async () => {
    const root = makeProject(false);
    try {
      let calls = 0;
      await expectCode('MISSING_EDIT_PROMPT', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' }, callLLM: async () => { calls += 1; },
      }));
      assert.strictEqual(calls, 0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects model attempts to redirect the edit.md target without writing', async () => {
    const root = makeProject();
    try {
      const before = fs.readFileSync(path.join(root, 'edit.md'), 'utf8');
      let calls = 0;
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: async () => {
          calls += 1;
          return llmJson({ path: '../outside.md' })();
        },
      }));
      assert.strictEqual(calls, 2);
      assert.strictEqual(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), before);
      assert.strictEqual(fs.existsSync(path.join(root, 'outside.md')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects unsafe, hidden, non-Markdown and edit.md file suggestions', async () => {
    const root = makeProject();
    try {
      for (const badPath of ['../outside.md', '/tmp/a.md', '.secret/a.md', 'notes.txt', 'edit.md']) {
        await expectCode('INVALID_SUGGESTION_PATH', () => proposeProjectOnboarding({
          projectService, rootPath: root, answers: { premise: '核心观点' },
          callLLM: llmJson({ fileSuggestions: [{ path: badPath, reason: 'bad' }] }),
        }));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects existing, duplicate and excessive file suggestions', async () => {
    const root = makeProject();
    try {
      await expectCode('DUPLICATE_SUGGESTION_PATH', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: llmJson({ fileSuggestions: [{ path: 'chapters/existing.md', reason: 'exists' }] }),
      }));
      await expectCode('DUPLICATE_SUGGESTION_PATH', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: llmJson({ fileSuggestions: [
          { path: 'a.md', reason: 'a' }, { path: 'a.md', reason: 'again' },
        ] }),
      }));
      await expectCode('INVALID_FILE_SUGGESTIONS', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: llmJson({ fileSuggestions: Array.from({ length: MAX_FILE_SUGGESTIONS + 1 }, (_, i) => ({ path: `${i}.md`, reason: 'x' })) }),
      }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('rejects malformed output after exactly one repair attempt without touching files', async () => {
    const root = makeProject();
    try {
      const before = fs.readFileSync(path.join(root, 'edit.md'), 'utf8');
      let calls = 0;
      await expectCode('INVALID_MODEL_OUTPUT', () => proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: async () => { calls += 1; return { ok: true, text: '{bad json' }; },
      }));
      assert.equal(calls, 2);
      assert.strictEqual(fs.readFileSync(path.join(root, 'edit.md'), 'utf8'), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('propagates model failure without inventing a proposal', async () => {
    const root = makeProject();
    try {
      const result = await proposeProjectOnboarding({
        projectService, rootPath: root, answers: { premise: '核心观点' },
        callLLM: async () => ({ ok: false, error: 'STUB_FAILURE' }),
      });
      assert.deepStrictEqual(result, { ok: false, error: 'STUB_FAILURE', message: '项目建立提案生成失败' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  console.log(`\n${passed}/${passed} project-onboarding checks passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
