'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const service = require('../src/main/project-onboarding-v2-service');

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

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code, `expected ${code}`);
}

async function expectCodeAsync(code, fn) {
  await assert.rejects(fn, error => error && error.code === code, `expected ${code}`);
}

function request(answers = [{ id: 'premise', text: '写一本克制的产品书' }]) {
  return { schema: service.REQUEST_SCHEMA, answers };
}

function proposal(overrides = {}) {
  return {
    summary: '整理项目主旨与初始结构',
    sections: [{ id: 'premise', content: '用可验证的案例解释产品决策。' }],
    fileSuggestions: [{ path: 'chapters/01-intro.md', title: '第一章', reason: '承接项目主旨' }],
    ...overrides,
  };
}

function model(value = proposal(), overrides = {}) {
  return { ok: true, text: JSON.stringify(value), stopReason: 'end_turn', ...overrides };
}

function makeProject(editContent = null) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-v2-'));
  const descriptor = projectService.createProjectAt(parent, '项目卡 v2 验证');
  if (editContent !== null) fs.writeFileSync(path.join(descriptor.rootPath, 'edit.md'), editContent, 'utf8');
  return { parent, root: descriptor.rootPath };
}

function cleanup(project) {
  fs.rmSync(project.parent, { recursive: true, force: true });
}

function frontMatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? match[0] : '';
}

function treeFile(name, filePath = name, size = 0) {
  return { name, path: filePath, type: 'file', size };
}

function treeDirectory(name, directoryPath = name, children = []) {
  return { name, path: directoryPath, type: 'directory', children };
}

async function run() {
  console.log('\nProject onboarding v2 service verification');

  await test('freezes question and template orders without changing the established guided flow', () => {
    assert.deepStrictEqual(service.QUESTION_ORDER, [
      'premise', 'audience', 'objective', 'scope', 'structure', 'voice',
      'invariants', 'timeline', 'sources', 'openQuestions',
    ]);
    assert.deepStrictEqual(service.TEMPLATE_ORDER, [
      'premise', 'objective', 'audience', 'scope', 'structure', 'voice',
      'invariants', 'timeline', 'sources', 'openQuestions',
    ]);
  });

  await test('accepts only the exact bounded v2 request and fixed ordered answer records', () => {
    assert.deepStrictEqual(service.normalizeRequest(request()), request());
    for (const invalid of [
      { answers: request().answers },
      { ...request(), extra: true },
      { schema: 'writcraft.onboarding-request/v1', answers: request().answers },
      { schema: service.REQUEST_SCHEMA, answers: [] },
      request([{ id: 'unknown', text: 'x' }]),
      request([{ id: 'premise', text: 'x' }, { id: 'premise', text: 'y' }]),
      request([{ id: 'objective', text: 'x' }, { id: 'audience', text: 'y' }]),
      request([{ id: 'premise', text: ' x ' }]),
    ]) expectCode('INVALID_ONBOARDING_REQUEST', () => service.normalizeRequest(invalid));
    expectCode('INVALID_ONBOARDING_REQUEST', () => service.normalizeRequest(request([
      { id: 'premise', text: '😀'.repeat(2049) },
    ])));
    expectCode('ONBOARDING_REQUEST_TOO_LARGE', () => service.normalizeRequest(request([
      { id: 'premise', text: 'x'.repeat(4000) },
      { id: 'audience', text: 'x'.repeat(4000) },
      { id: 'objective', text: 'x'.repeat(4000) },
      { id: 'scope', text: 'x'.repeat(4000) },
      { id: 'structure', text: 'x' },
    ])));
  });

  await test('accepts metadata-only exact model output and exposes no model-authored file body', () => {
    const parsed = service.parseModelResponse(model(), new Set(['premise']));
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.proposal.fileSuggestions, [
      { path: 'chapters/01-intro.md', title: '第一章', reason: '承接项目主旨' },
    ]);
    assert(!Object.hasOwn(parsed.proposal, 'editContent'));
    assert(!Object.hasOwn(parsed.proposal.fileSuggestions[0], 'content'));
  });

  await test('requires end_turn and propagates provider failure without parsing or repair', () => {
    assert.deepStrictEqual(service.parseModelResponse({ ok: false, error: 'STUB_FAILED' }, new Set(['premise'])), {
      ok: false, error: 'STUB_FAILED', message: '项目卡提案生成失败',
    });
    expectCode('MODEL_OUTPUT_TRUNCATED', () => service.parseModelResponse(model(proposal(), { stopReason: 'max_tokens' }), new Set(['premise'])));
    expectCode('MODEL_OUTPUT_INCOMPLETE', () => service.parseModelResponse(model(proposal(), { stopReason: 'tool_use' }), new Set(['premise'])));
    expectCode('MODEL_OUTPUT_INCOMPLETE', () => service.parseModelResponse({ ok: true, text: '{}'}, new Set(['premise'])));
  });

  await test('strict JSON rejects fences, surrounding text, trailing commas, missing/extra keys and file bodies', () => {
    const valid = JSON.stringify(proposal());
    for (const text of [
      `\`\`\`json\n${valid}\n\`\`\``,
      `explanation\n${valid}`,
      valid.replace('"fileSuggestions":', '"extra":true,"fileSuggestions":'),
      valid.replace(/}$/, ',}'),
      JSON.stringify({ summary: 'x', sections: [] }),
      JSON.stringify({ ...proposal(), editContent: '# forbidden' }),
    ]) expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse({ ok: true, text, stopReason: 'end_turn' }, new Set(['premise'])));
    expectCode('INVALID_FILE_SUGGESTIONS', () => service.parseModelResponse(model(proposal({
      fileSuggestions: [{ path: 'a.md', title: 'A', reason: 'r', content: '# body' }],
    })), new Set(['premise'])));
  });

  await test('duplicate, dangerous and deeply nested JSON all fail closed within explicit resource bounds', () => {
    const duplicate = '{"summary":"a","summary":"b","sections":[],"fileSuggestions":[]}';
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse({ ok: true, text: duplicate, stopReason: 'end_turn' }, new Set(['premise'])));
    const dangerous = '{"summary":"a","sections":[],"fileSuggestions":[{"path":"a.md","title":"A","reason":"r","__proto__":{}}]}';
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse({ ok: true, text: dangerous, stopReason: 'end_turn' }, new Set(['premise'])));
    const deep = `{"summary":"a","sections":[],"fileSuggestions":[],"x":${'['.repeat(service.MAX_JSON_DEPTH + 2)}0${']'.repeat(service.MAX_JSON_DEPTH + 2)}}`;
    const fullParseLengths = [];
    const originalJsonParse = JSON.parse;
    JSON.parse = value => {
      fullParseLengths.push(value.length);
      return originalJsonParse(value);
    };
    try {
      expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse({ ok: true, text: deep, stopReason: 'end_turn' }, new Set(['premise'])));
    } finally {
      JSON.parse = originalJsonParse;
    }
    assert(!fullParseLengths.includes(deep.length), 'deep tree must be rejected before complete JSON.parse');
    const wide = `{"summary":"a","sections":[],"fileSuggestions":[],"x":[${'0,'.repeat(service.MAX_JSON_NODES)}0]}`;
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse({ ok: true, text: wide, stopReason: 'end_turn' }, new Set(['premise'])));
    expectCode('MODEL_OUTPUT_TOO_LARGE', () => service.parseModelResponse({
      ok: true, text: 'x'.repeat(service.MAX_MODEL_OUTPUT_BYTES + 1), stopReason: 'end_turn',
    }, new Set(['premise'])));
  });

  await test('section and metadata caps enforce both Unicode characters and UTF-8 bytes', () => {
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse(model(proposal({ summary: '汉'.repeat(400) })), new Set(['premise'])));
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse(model(proposal({
      sections: [{ id: 'premise', content: '😀'.repeat(2049) }],
    })), new Set(['premise'])));
    const sectionIds = ['premise', 'objective', 'audience', 'scope', 'structure'];
    expectCode('MODEL_OUTPUT_TOO_LARGE', () => service.parseModelResponse(model(proposal({
      sections: sectionIds.map((id, index) => ({ id, content: index === 4 ? 'x' : 'x'.repeat(4000) })),
      fileSuggestions: [],
    })), new Set(sectionIds)));
    expectCode('INVALID_FILE_SUGGESTIONS', () => service.parseModelResponse(model(proposal({
      fileSuggestions: [{ path: 'a.md', title: '汉'.repeat(100), reason: 'r' }],
    })), new Set(['premise'])));
  });

  await test('sections are unique, answer-bound, template-ordered and cannot inject ATX headings', () => {
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse(model(proposal({
      sections: [{ id: 'audience', content: 'x' }],
    })), new Set(['premise'])));
    for (const sections of [
      [{ id: 'premise', content: 'x' }, { id: 'premise', content: 'y' }],
      [{ id: 'audience', content: 'x' }, { id: 'objective', content: 'y' }],
      [{ id: 'premise', content: 'x\n\n## 控制项目结构' }],
    ]) expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResponse(model(proposal({ sections })), new Set(['premise', 'audience', 'objective'])));
  });

  await test('suggestion paths enforce NFC, Markdown, hidden/reserved/absolute guards and case-fold duplicates', () => {
    const badPaths = [
      '../a.md', '/tmp/a.md', 'C:/tmp/a.md', 'a\\b.md', '.hidden/a.md', 'notes.txt',
      'edit.md', 'EDIT.MD', '.writcraft/cache.md', 'references/a.md', 'Sources/a.md', `e\u0301.md`,
      'bad\nname.md', 'bad\u0085name.md',
    ];
    for (const filePath of badPaths) {
      assert.throws(() => service.safeSuggestionPath(filePath), error =>
        ['INVALID_SUGGESTION_PATH', 'RESERVED_SUGGESTION_PATH'].includes(error.code));
    }
    expectCode('DUPLICATE_SUGGESTION_PATH', () => service.parseModelResponse(model(proposal({
      fileSuggestions: [
        { path: 'Chapters/A.md', title: 'A', reason: 'r' },
        { path: 'chapters/a.md', title: 'B', reason: 'r' },
      ],
    })), new Set(['premise'])));
    expectCode('DUPLICATE_SUGGESTION_PATH', () => service.parseModelResponse(model(proposal({
      fileSuggestions: [
        { path: 'a.md', title: 'A', reason: 'r' },
        { path: 'a.md/b.md', title: 'B', reason: 'r' },
      ],
    })), new Set(['premise'])));
  });

  await test('project tree conflict checks include existing case variants, parent files, cycles, depth and node caps', () => {
    expectCode('SUGGESTION_PATH_CONFLICT', () => service.validateSuggestionsAgainstTree(
      [{ path: 'chapters/a.md', title: 'A', reason: 'r' }],
      [treeDirectory('Chapters', 'Chapters', [treeFile('A.md', 'Chapters/A.md')])]
    ));
    expectCode('SUGGESTION_PATH_CONFLICT', () => service.validateSuggestionsAgainstTree(
      [{ path: 'chapters/a.md', title: 'A', reason: 'r' }],
      [treeFile('chapters')]
    ));
    const cyclic = treeDirectory('a');
    cyclic.children.push(cyclic);
    expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], [cyclic]));
    const deep = treeDirectory('d0');
    let cursor = deep;
    let prefix = 'd0';
    for (let index = 1; index <= service.MAX_TREE_DEPTH; index += 1) {
      prefix += `/d${index}`;
      const child = treeDirectory(`d${index}`, prefix);
      cursor.children.push(child);
      cursor = child;
    }
    expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], [deep]));
    expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], Array.from(
      { length: service.MAX_TREE_NODES + 1 }, (_, index) => treeFile(`${index}.md`)
    )));
  });

  await test('oversized lazy sibling arrays fail before indexed reads and never fill an eager node stack', () => {
    let rootReads = 0;
    const oversizedRoot = new Proxy(new Array(service.MAX_TREE_NODES + 1), {
      get(target, property, receiver) {
        if (/^(?:0|[1-9]\d*)$/.test(String(property))) rootReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], oversizedRoot));
    assert.strictEqual(rootReads, 0, 'root siblings must be bounded from length before element reads');

    let childReads = 0;
    const oversizedChildren = new Proxy(new Array(service.MAX_TREE_NODES), {
      get(target, property, receiver) {
        if (/^(?:0|[1-9]\d*)$/.test(String(property))) childReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const root = [treeDirectory('huge', 'huge', oversizedChildren)];
    expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], root));
    assert.strictEqual(childReads, 0, 'children must be counted when scheduled, before indexed reads');
  });

  await test('project tree nodes require exact bounded NFC paths, consistent parents and unique identities', () => {
    for (const invalidTree of [
      [{ ...treeFile('a.md'), extra: true }],
      [treeFile('e\u0301.md')],
      [treeFile('bad\nname.md')],
      [treeFile('bad\u0085name.md', 'safe.md')],
      [treeFile('safe.md', 'bad\u0085path.md')],
      [treeFile('a.md', 'a.md', -1)],
      [treeFile('a.md'), treeFile('A.md')],
      [treeDirectory('chapters', 'chapters', [treeFile('a.md', 'wrong/a.md')])],
    ]) expectCode('INVALID_PROJECT_TREE', () => service.validateSuggestionsAgainstTree([], invalidTree));
  });

  await test('merge replaces only empty/template placeholder direct bodies and preserves Front Matter bytes', () => {
    const project = makeProject();
    try {
      const before = projectService.readFile(project.root, 'edit.md');
      const merged = service.mergeEditDocument(before, [{ id: 'premise', content: '新的项目主旨。' }], projectService);
      assert.strictEqual(frontMatter(merged), frontMatter(before));
      assert(merged.includes('# 项目主旨\n\n新的项目主旨。'));
      assert(!merged.includes('用一句话写下这个项目最重要的命题。'));
      const empty = before.replace('用一句话写下这个项目最重要的命题。', '');
      assert(service.mergeEditDocument(empty, [{ id: 'premise', content: '填入空栏目。' }], projectService).includes('填入空栏目。'));
    } finally { cleanup(project); }
  });

  await test('merge appends after user prose, avoids an identical paragraph, and preserves nested/custom headings byte-for-byte', () => {
    const custom = `---\nschema: writcraft.edit/v1\ntitle: "自定义"\nunknown: keep\n---\n\n# 项目主旨\n\n作者已有主旨。\n\n## 目标读者\n\n作者已有读者。\n\n### 用户画像\n\n这是嵌套标题下的原文。\n\n## 自定义章节\n\n完整保留。\n`;
    const project = makeProject(custom);
    try {
      const addition = '新增读者补充。';
      const merged = service.mergeEditDocument(custom, [{ id: 'audience', content: addition }], projectService);
      assert(merged.includes('作者已有读者。'));
      assert(merged.indexOf(addition) > merged.indexOf('作者已有读者。'));
      assert(merged.indexOf(addition) < merged.indexOf('### 用户画像'));
      assert(merged.includes('### 用户画像\n\n这是嵌套标题下的原文。'));
      assert(merged.includes('## 自定义章节\n\n完整保留。'));
      assert.strictEqual(service.mergeEditDocument(merged, [{ id: 'audience', content: addition }], projectService), merged);
    } finally { cleanup(project); }
  });

  await test('merge ignores heading-looking text in fences, rejects duplicate canonical headings and inserts missing sections in template order', () => {
    const base = `---\nschema: writcraft.edit/v1\n---\n\n# 项目主旨\n\n作者主旨。\n\n\`\`\`md\n## 目标读者\n\`\`\`\n\n## 目标读者\n\n作者读者。\n`;
    const project = makeProject(base);
    try {
      const inserted = service.mergeEditDocument(base, [{ id: 'objective', content: '新的写作目标。' }], projectService);
      assert(inserted.indexOf('## 写作目标') < inserted.lastIndexOf('## 目标读者'));
      const duplicate = `${base}\n## 目标读者\n\n另一处。\n`;
      expectCode('AMBIGUOUS_EDIT_PROMPT', () => service.mergeEditDocument(duplicate, [{ id: 'audience', content: 'x' }], projectService));
    } finally { cleanup(project); }
  });

  await test('Front Matter boundary matches the authority for BOM and ignores indented delimiter-like YAML lines', () => {
    const bom = `\uFEFF---\nschema: writcraft.edit/v1\ntitle: BOM\n---\n\n# 项目主旨\n\n旧内容。\n`;
    assert.strictEqual(projectService.inspectEditFrontMatter(bom).status, 'valid');
    const bomPrefixEnd = bom.indexOf('\n---\n') + '\n---\n'.length;
    const mergedBom = service.mergeEditDocument(bom, [{ id: 'premise', content: '新增 BOM 主旨。' }], projectService);
    assert.strictEqual(mergedBom.slice(0, bomPrefixEnd), bom.slice(0, bomPrefixEnd));
    assert(mergedBom.includes('新增 BOM 主旨。'));

    const indented = `---\nschema: writcraft.edit/v1\nnotes: |\n  ---\n  # 项目主旨\n  YAML 内文字\n---\n\n## 写作目标\n\n原目标。\n`;
    assert.strictEqual(projectService.inspectEditFrontMatter(indented).diagnostics.some(item => item.severity === 'error'), false);
    const prefixEnd = indented.indexOf('\n---\n\n##') + '\n---\n'.length;
    const mergedIndented = service.mergeEditDocument(indented, [{ id: 'premise', content: '真实正文主旨。' }], projectService);
    assert.strictEqual(mergedIndented.slice(0, prefixEnd), indented.slice(0, prefixEnd));
    assert(mergedIndented.slice(prefixEnd).includes('# 项目主旨\n\n真实正文主旨。'));
  });

  await test('proposal produces one validated edit.md ChangeSet, digest and transparent manifest without writing', async () => {
    const project = makeProject();
    try {
      const before = projectService.readFileWithRevision(project.root, 'edit.md');
      let captured;
      const result = await service.proposeProjectOnboardingV2({
        projectService, rootPath: project.root, request: request(),
        callLLM: async (messages, modelName, maxTokens) => {
          captured = { messages, modelName, maxTokens };
          return model();
        },
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.noChanges, false);
      assert.deepStrictEqual(changeSetService.validateChangeSet(result.changeSet), result.changeSet);
      assert.deepStrictEqual(result.changeSet.changes.map(change => change.path), ['edit.md']);
      assert(result.changeSet.changes[0].after.includes('用可验证的案例'));
      assert.strictEqual(projectService.readFileWithRevision(project.root, 'edit.md').content, before.content);
      assert.match(result.proposalDigest, /^[a-f0-9]{64}$/);
      assert.strictEqual(result.contextManifest.schema, service.CONTEXT_SCHEMA);
      assert.strictEqual(result.contextManifest.targetRevision, before.revision);
      assert.match(result.contextManifest.treeDigest, /^[a-f0-9]{64}$/);
      assert.strictEqual(result.contextManifest.proposalDigest, result.proposalDigest);
      assert.deepStrictEqual(result.contextManifest.sectionIds, ['premise']);
      assert.deepStrictEqual(result.contextManifest.suggestionPaths, ['chapters/01-intro.md']);
      assert.strictEqual(result.proposalDigest, service.proposalDigest(
        before.revision,
        result.contextManifest.targetAfterRevision,
        result.contextManifest.treeDigest,
        proposal()
      ));
      assert.strictEqual(captured.modelName, service.MODEL);
      assert.strictEqual(captured.maxTokens, service.MAX_TOKENS);
      assert(captured.messages[0].content.includes('严禁返回完整 edit.md'));
    } finally { cleanup(project); }
  });

  await test('identical content is an explicit no-op that preserves metadata suggestions and writes nothing', async () => {
    const project = makeProject();
    try {
      const before = projectService.readFileWithRevision(project.root, 'edit.md');
      const result = await service.proposeProjectOnboardingV2({
        projectService, rootPath: project.root, request: request(),
        callLLM: async () => model(proposal({
          sections: [{ id: 'premise', content: '用一句话写下这个项目最重要的命题。' }],
        })),
      });
      assert.strictEqual(result.noChanges, true);
      assert.strictEqual(result.changeSet, null);
      assert.strictEqual(result.preview, null);
      assert.strictEqual(result.fileSuggestions.length, 1);
      assert.strictEqual(projectService.readFileWithRevision(project.root, 'edit.md').revision, before.revision);
    } finally { cleanup(project); }
  });

  await test('malformed output is attempted once only and keeps disk byte-identical', async () => {
    const project = makeProject();
    try {
      const before = fs.readFileSync(path.join(project.root, 'edit.md'));
      let calls = 0;
      await expectCodeAsync('INVALID_MODEL_OUTPUT', () => service.proposeProjectOnboardingV2({
        projectService, rootPath: project.root, request: request(),
        callLLM: async () => { calls += 1; return { ok: true, text: '{bad', stopReason: 'end_turn' }; },
      }));
      assert.strictEqual(calls, 1);
      assert.deepStrictEqual(fs.readFileSync(path.join(project.root, 'edit.md')), before);
    } finally { cleanup(project); }
  });

  await test('post-model edit revision drift fails closed with no proposal and no overwrite', async () => {
    const project = makeProject();
    try {
      const before = projectService.readFile(project.root, 'edit.md');
      await expectCodeAsync('ONBOARDING_DEPENDENCY_STALE', () => service.proposeProjectOnboardingV2({
        projectService, rootPath: project.root, request: request(),
        callLLM: async () => {
          fs.writeFileSync(path.join(project.root, 'edit.md'), `${before}\n外部权威修改。\n`, 'utf8');
          return model();
        },
      }));
      assert(projectService.readFile(project.root, 'edit.md').includes('外部权威修改'));
    } finally { cleanup(project); }
  });

  await test('post-model unrelated tree add, delete and rename all invalidate the complete snapshot', async () => {
    for (const mutation of ['add', 'delete', 'rename']) {
      const project = makeProject();
      try {
        const originalPath = path.join(project.root, 'existing.md');
        if (mutation !== 'add') fs.writeFileSync(originalPath, '# existing\n', 'utf8');
        const before = projectService.readFile(project.root, 'edit.md');
        await expectCodeAsync('ONBOARDING_DEPENDENCY_STALE', () => service.proposeProjectOnboardingV2({
          projectService, rootPath: project.root, request: request(),
          callLLM: async () => {
            if (mutation === 'add') fs.writeFileSync(path.join(project.root, 'unrelated.md'), '# added\n', 'utf8');
            if (mutation === 'delete') fs.unlinkSync(originalPath);
            if (mutation === 'rename') fs.renameSync(originalPath, path.join(project.root, 'renamed.md'));
            return model();
          },
        }));
        assert.strictEqual(projectService.readFile(project.root, 'edit.md'), before);
      } finally { cleanup(project); }
    }
  });

  await test('invalid Front Matter fails before the model and never synthesizes a replacement document', async () => {
    const project = makeProject('# 项目主旨\n\n用户正文\n');
    try {
      let calls = 0;
      await expectCodeAsync('INVALID_EDIT_PROMPT', () => service.proposeProjectOnboardingV2({
        projectService, rootPath: project.root, request: request(),
        callLLM: async () => { calls += 1; return model(); },
      }));
      assert.strictEqual(calls, 0);
      assert.strictEqual(projectService.readFile(project.root, 'edit.md'), '# 项目主旨\n\n用户正文\n');
    } finally { cleanup(project); }
  });

  console.log(`\n${passed}/${passed} project-onboarding-v2 checks passed.`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
