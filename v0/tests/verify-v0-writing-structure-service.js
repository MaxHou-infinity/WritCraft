'use strict';

const assert = require('assert');
const crypto = require('crypto');
const navigationService = require('../src/main/writing-navigation-service');
const navigationStoreModule = require('../src/main/writing-navigation-store');
const structureService = require('../src/main/writing-structure-service');

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

const OWNER = 'webContents:7';
const PROJECT = 'instance_0123456789abcdef01234567';
const ROOT = '/tmp/writcraft-structure-project';
const EDIT = '# 项目主旨\n\n一本由作者主导结构的书。\n';
const EDIT_REVISION = crypto.createHash('sha256').update(EDIT).digest('hex');
const EMPTY_TREE_DIGEST = crypto.createHash('sha256').update('edit.md only').digest('hex');

function fakeProject() {
  return {
    listTree: () => [{ type: 'file', path: 'edit.md' }],
    readFileWithRevision: () => ({ content: EDIT, revision: EDIT_REVISION }),
  };
}

function deterministicBytes() {
  let index = 0;
  return size => {
    index += 1;
    return Buffer.alloc(size, index);
  };
}

async function fixture() {
  const proposal = await navigationService.proposeWritingNavigation({
    projectService: fakeProject(),
    rootPath: ROOT,
    request: {
      schema: navigationService.REQUEST_SCHEMA,
      mode: 'structure',
      goal: '比较两种结构',
      currentFilePath: null,
      contextPaths: [],
    },
    randomBytes: () => Buffer.alloc(16, 7),
    callLLM: async () => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: navigationService.TOOL_NAME,
        input: {
          mode: 'structure',
          alternatives: [{
            organizingLogic: '按问题递进',
            audienceBenefit: '先理解问题',
            tradeoff: '案例稍晚',
            chapters: [
              { title: '第一章', purpose: '解释问题' },
              { title: '第二章', purpose: '给出方法' },
            ],
          }, {
            organizingLogic: '按案例展开',
            audienceBenefit: '容易代入',
            tradeoff: '概念稍晚',
            chapters: [{ title: '开场', purpose: '建立场景' }],
          }],
        },
      },
    }),
  });
  const navigationStore = navigationStoreModule.createWritingNavigationStore({
    randomBytes: deterministicBytes(),
  });
  const binding = {
    ownerId: OWNER,
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 4,
    navigationEpoch: 3,
  };
  navigationStore.install({ ...binding, record: proposal.record });
  return { navigationStore, binding, navigationId: proposal.result.navigationId };
}

function prepare(input, extra = {}) {
  return structureService.prepareWritingStructure({
    navigationStore: input.navigationStore,
    ...input.binding,
    navigationId: input.navigationId,
    alternativeId: 'alternative_1',
    emptyTreeDigest: EMPTY_TREE_DIGEST,
    chapters: [
      { title: '作者修改的一', purpose: '只确定本章写作目的' },
      { title: '作者修改的二', purpose: '继续推进核心论证' },
    ],
    ...extra,
  });
}

(async () => {
  console.log('\nWriting structure preview verification');

  await test('prepares exact deterministic skeleton bytes without prose', async () => {
    const input = await fixture();
    const result = prepare(input);
    const expected = '# 作者修改的一\n\n<!-- 写作目的：只确定本章写作目的 -->\n';
    assert.strictEqual(result.preview.createsProse, false);
    assert.match(result.preview.disclosure, /不会生成正文/);
    assert.deepStrictEqual(result.preview.files.map(file => file.path), [
      'chapters/01.md', 'chapters/02.md',
    ]);
    assert.strictEqual(result.preview.files[0].content, expected);
    assert.strictEqual(result.preview.files[0].bytes, Buffer.byteLength(expected, 'utf8'));
    assert.strictEqual(
      result.preview.files[0].sha256,
      crypto.createHash('sha256').update(expected).digest('hex')
    );
    assert.strictEqual(
      result.preview.proposalDigest,
      structureService.computeStructureProposalDigest(result.preview.files)
    );
    assert.strictEqual(result.prepared.editRevision, EDIT_REVISION);
    assert.strictEqual(result.prepared.emptyTreeDigest, EMPTY_TREE_DIGEST);
  });

  await test('accepts maximum legal Unicode and valid surrogate pairs', async () => {
    const input = await fixture();
    const title = '😀'.repeat(navigationService.LIMITS.title);
    const purpose = '𠮷'.repeat(navigationService.LIMITS.purpose);
    const result = prepare(input, {
      alternativeId: 'alternative_2',
      chapters: [{ title, purpose }],
    });
    assert.strictEqual(result.preview.files[0].title, title);
    assert.strictEqual(result.preview.files[0].purpose, purpose);
    assert.strictEqual(
      result.preview.files[0].bytes,
      Buffer.byteLength(`# ${title}\n\n<!-- 写作目的：${purpose} -->\n`, 'utf8')
    );
  });

  await test('rejects chapter count drift and renderer-supplied extra fields', async () => {
    const input = await fixture();
    assert.throws(
      () => prepare(input, { chapters: [{ title: '一', purpose: '说明一' }] }),
      error => error.code === 'CHAPTER_COUNT_MISMATCH'
    );
    assert.throws(
      () => prepare(input, {
        chapters: [
          { title: '一', purpose: '说明一', path: 'outside.md' },
          { title: '二', purpose: '说明二' },
        ],
      }),
      error => error.code === 'INVALID_STRUCTURE_CONFIRMATION'
    );
  });

  await test('rejects every C0 class, isolated surrogates and double hyphen purpose', async () => {
    const input = await fixture();
    for (const unsafe of ['含\r回车', '含\n换行', '含\0空字节', '含\u0008退格', '含\u001f控制']) {
      assert.throws(
        () => prepare(input, {
          chapters: [
            { title: unsafe, purpose: '说明一' },
            { title: '二', purpose: '说明二' },
          ],
        }),
        error => error.code === 'INVALID_STRUCTURE_CONFIRMATION'
      );
    }
    for (const unsafe of ['孤\uD800代理', '孤\uDC00代理']) {
      assert.throws(
        () => prepare(input, {
          chapters: [
            { title: '一', purpose: unsafe },
            { title: '二', purpose: '说明二' },
          ],
        }),
        error => error.code === 'INVALID_STRUCTURE_CONFIRMATION'
      );
    }
    assert.throws(
      () => prepare(input, {
        chapters: [
          { title: '一', purpose: '禁止--关闭注释' },
          { title: '二', purpose: '说明二' },
        ],
      }),
      error => error.code === 'INVALID_STRUCTURE_CONFIRMATION'
    );
  });

  await test('does not trim or coerce author metadata', async () => {
    const input = await fixture();
    for (const title of [' 带前空格', '带后空格 ', 123]) {
      assert.throws(
        () => prepare(input, {
          chapters: [
            { title, purpose: '说明一' },
            { title: '二', purpose: '说明二' },
          ],
        }),
        error => error.code === 'INVALID_STRUCTURE_CONFIRMATION'
      );
    }
  });

  await test('rejects a navigation result or missing alternative', async () => {
    const input = await fixture();
    assert.throws(
      () => prepare(input, { alternativeId: 'alternative_3' }),
      error => error.code === 'ALTERNATIVE_NOT_FOUND'
    );
    assert.throws(
      () => structureService.prepareWritingStructure({
        navigationStore: { get: () => ({ mode: 'navigation', navigationId: input.navigationId }) },
        ...input.binding,
        navigationId: input.navigationId,
        alternativeId: 'alternative_1',
        emptyTreeDigest: EMPTY_TREE_DIGEST,
        chapters: [{ title: '一', purpose: '说明' }],
      }),
      error => error.code === 'INVALID_NAVIGATION_RESULT'
    );
  });

  console.log(`\n${passed}/${passed} writing-structure preview checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
