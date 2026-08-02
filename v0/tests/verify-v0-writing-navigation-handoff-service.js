'use strict';

const assert = require('assert');
const crypto = require('crypto');
const navigationService = require('../src/main/writing-navigation-service');
const handoffService = require('../src/main/writing-navigation-handoff-service');
const unifiedWritingTaskService = require('../src/main/unified-writing-task-service');
const changeSetService = require('../src/main/changeset-service');

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

const ROOT = '/tmp/writcraft-navigation-handoff';
const CHAPTER = '# 第一章\n\n这是作者已经写下的正文证据。\n';

function revision(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fakeProject(chapter = CHAPTER) {
  const files = new Map([
    ['edit.md', '# 项目说明\n\n这是项目 Prompt。\n'],
    ['chapters/01.md', chapter],
  ]);
  return {
    files,
    listTree: () => [
      { type: 'file', path: 'edit.md' },
      {
        type: 'directory',
        path: 'chapters',
        children: [...files.keys()]
          .filter(filePath => filePath.startsWith('chapters/'))
          .map(filePath => ({ type: 'file', path: filePath })),
      },
    ],
    readFileWithRevision(_root, filePath) {
      if (!files.has(filePath)) throw new Error('NOT_FOUND');
      const content = files.get(filePath);
      return { content, revision: revision(content) };
    },
  };
}

async function authority(chapter = CHAPTER) {
  const project = fakeProject(chapter);
  const proposal = await navigationService.proposeWritingNavigation({
    projectService: project,
    rootPath: ROOT,
    request: {
      schema: navigationService.REQUEST_SCHEMA,
      mode: 'navigation',
      goal: '告诉我下一步',
      currentFilePath: 'chapters/01.md',
      contextPaths: [],
    },
    randomBytes: size => Buffer.alloc(size, 3),
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
            whyNow: '现在补充能让后文更容易展开。',
            editIntent: 'strengthen_evidence',
            expectedResult: '读者更容易理解。',
            action: 'changes',
          }],
        },
      },
    }),
  });
  return {
    project,
    value: {
      navigationId: proposal.record.navigationId,
      suggestion: proposal.record.result.suggestions[0],
      record: proposal.record,
    },
  };
}

(async () => {
  console.log('\nWriting navigation handoff service verification');

  await test('revalidates every bound revision and exact evidence anchor', async () => {
    const item = await authority();
    assert.strictEqual(handoffService.revalidateAuthority({
      projectService: item.project,
      rootPath: ROOT,
      authority: item.value,
    }), true);
    item.project.files.set('chapters/01.md', `${CHAPTER}\n变化`);
    assert.throws(() => handoffService.revalidateAuthority({
      projectService: item.project,
      rootPath: ROOT,
      authority: item.value,
    }), error => error.code === 'NAVIGATION_STALE');
  });

  await test('record resume rejects an added manuscript that changes Context coverage', async () => {
    const item = await authority();
    item.project.files.set('chapters/02.md', '# 第二章\n\n新增正文。\n');
    assert.throws(() => handoffService.revalidateRecord({
      projectService: item.project,
      rootPath: ROOT,
      record: item.value.record,
    }), error => error.code === 'NAVIGATION_STALE');
  });

  await test('resume shares generation tree rules through the 5000-entry project boundary', async () => {
    const item = await authority();
    const bodyFiles = Array.from({ length: 4998 }, (_, index) => ({
      type: 'file', path: `chapters/extra-${String(index).padStart(4, '0')}.txt`,
    }));
    item.project.listTree = () => [
      { type: 'file', path: 'edit.md' },
      { type: 'directory', path: 'chapters', children: [
        { type: 'file', path: 'chapters/01.md' }, ...bodyFiles,
      ] },
    ];
    assert.strictEqual(handoffService.revalidateRecord({
      projectService: item.project, rootPath: ROOT, record: item.value.record,
    }), true);
    item.project.listTree = () => [
      { type: 'file', path: 'edit.md' },
      { type: 'directory', path: 'chapters', children: [
        { type: 'file', path: 'chapters/01.md' }, ...bodyFiles,
        { type: 'symlink', path: 'chapters/linked.md' },
      ] },
    ];
    assert.throws(() => handoffService.revalidateRecord({
      projectService: item.project, rootPath: ROOT, record: item.value.record,
    }), error => error.code === 'NAVIGATION_STALE');
  });

  await test('headingless evidence keeps its display label separate from the empty anchor key', async () => {
    const headingless = '这是没有 Markdown 标题的文首正文证据。\n';
    const item = await authority(headingless);
    assert.strictEqual(item.value.suggestion.evidence[0].sectionHeading, '文首');
    assert.strictEqual(
      item.value.suggestion.evidence[0].locator.blockAnchor.headingKey,
      ''
    );
    assert.strictEqual(handoffService.revalidateAuthority({
      projectService: item.project,
      rootPath: ROOT,
      authority: item.value,
    }), true);
    assert(handoffService.prepareChangesHandoff({
      projectService: item.project,
      rootPath: ROOT,
      authority: item.value,
    }).prepared);
  });

  await test('changes handoff derives exact targets and produces a reviewable ChangeSet', async () => {
    const item = await authority();
    const prepared = handoffService.prepareChangesHandoff({
      projectService: item.project,
      rootPath: ROOT,
      authority: item.value,
    });
    assert.deepStrictEqual(prepared.prepared.request.targetPaths, ['chapters/01.md']);
    assert.deepStrictEqual(prepared.prepared.request.contextPaths, []);
    assert.match(prepared.prepared.request.instruction, /当前段落还缺少具体例子/);
    assert.strictEqual(prepared.prepared.structuredOutput, true);
    assert.match(prepared.prepared.messages[0].content, /submit_unified_writing_task/);
    assert.match(prepared.prepared.messages[0].content, /1–3 个 edits/);
    assert(!prepared.prepared.messages[0].content.includes('chapters/01.md'));
    assert(!prepared.prepared.messages[0].content.includes(item.value.suggestion.evidence[0].revision));
    assert.match(prepared.prepared.messages[0].content, /beforeContext=/);
    assert.match(prepared.prepared.messages[0].content, /afterContext=/);
    assert.strictEqual(prepared.prepared.structuredRanges[0].content,
      '这是作者已经写下的正文证据。');
    const parsed = unifiedWritingTaskService.parseResult({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: unifiedWritingTaskService.TOOL_NAME,
        input: {
          status: 'changes',
          edits: [{
            rangeId: prepared.prepared.structuredRanges[0].rangeId,
            newText: '这是作者已经写下的正文证据，例如一次真实访谈。',
            summary: '补充例子',
          }],
          reason: '',
          question: '',
        },
      },
    }, prepared.prepared.snapshots, prepared.prepared.structuredRanges);
    const result = handoffService.finalizeChangesHandoff({
      preparedHandoff: prepared,
      parsed,
      changeSetService,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.noChanges, false);
    assert.strictEqual(result.fileCount, 1);
    assert.strictEqual(result.changeSet.changes[0].path, 'chapters/01.md');
    assert.strictEqual(result.provenance.schema, handoffService.CHANGES_PROVENANCE_SCHEMA);
    assert.throws(() => handoffService.finalizeChangesHandoff({
      preparedHandoff: prepared,
      parsed: Object.freeze({ kind: 'changes', edits: parsed.edits }),
      changeSetService,
    }), error => error.code === 'INVALID_MODEL_OUTPUT');
  });

  console.log(`\n${passed}/${passed} writing-navigation handoff service checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
