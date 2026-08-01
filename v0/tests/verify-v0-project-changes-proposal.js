#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const service = require('../src/main/project-changes-proposal-service');
const changeSetService = require('../src/main/changeset-service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error.stack || error.message}`); process.exitCode = 1; }
}

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function fakeProject(initial) {
  const files = new Map(Object.entries(initial));
  const reads = [];
  return {
    files,
    reads,
    listTree() { return [...files.keys()].map(filePath => ({ type: 'file', path: filePath })); },
    readFileWithRevision(_root, filePath) {
      reads.push(filePath);
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      const content = files.get(filePath);
      return { content, revision: revision(content) };
    },
  };
}

function request(targetPaths, contextPaths = [], instruction = '统一术语并保留论证') {
  return { schema: service.REQUEST_SCHEMA, instruction, targetPaths, contextPaths };
}

function expectCode(code, fn) {
  assert.throws(fn, error => error?.code === code, `expected ${code}`);
}

console.log('\nProject Changes proposal verification');

test('请求必须 exact schema 且明确给出 target，不再默认全项目', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'a.md': '# A' });
  expectCode('NO_EXPLICIT_TARGETS', () => service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request([]),
  }));
  expectCode('INVALID_PROJECT_CHANGES_REQUEST', () => service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: { ...request(['a.md']), extra: true },
  }));
});

test('edit.md 缺失时 fail-closed，不得绕过项目 Prompt 生成修改', () => {
  const project = fakeProject({ 'a.md': '# A' });
  expectCode('PROJECT_PROMPT_REQUIRED', () => service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md']),
  }));
  assert.deepStrictEqual(project.reads, []);
  const unreadable = fakeProject({ 'edit.md': '# Prompt', 'a.md': '# A' });
  unreadable.readFileWithRevision = (_root, filePath) => {
    unreadable.reads.push(filePath);
    if (filePath === 'edit.md') throw new Error('denied');
    return { content: '# A', revision: revision('# A') };
  };
  expectCode('PROJECT_PROMPT_REQUIRED', () => service.prepareProjectChangesProposal({
    projectService: unreadable, rootPath: '/project', request: request(['a.md']),
  }));
});

test('edit.md、references/ 和 sources/ 不得成为可写目标', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'references/r.md': '# R', 'sources/s.md': '# S', 'a.md': '# A' });
  for (const filePath of ['edit.md', 'references/r.md', 'sources/s.md']) {
    expectCode('RESERVED_TARGET', () => service.prepareProjectChangesProposal({
      projectService: project, rootPath: '/project', request: request([filePath]),
    }));
  }
});

test('Main 必然单独带入 edit.md，context 只读，目标重叠时只读取一次且 target 优先', () => {
  const project = fakeProject({
    'edit.md': '# 项目主旨',
    'chapters/a.md': 'A OLD',
    'references/r.md': 'R ONLY',
    'sources/s.md': 'S ONLY',
  });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project,
    rootPath: '/project',
    request: request(['chapters/a.md'], ['references/r.md', 'sources/s.md', 'chapters/a.md']),
  });
  assert.deepStrictEqual(prepared.request.contextPaths, ['references/r.md', 'sources/s.md']);
  assert.deepStrictEqual(prepared.dependencies.map(item => [item.path, item.role]), [
    ['edit.md', 'project_prompt'], ['references/r.md', 'context'], ['sources/s.md', 'context'], ['chapters/a.md', 'target'],
  ]);
  assert.strictEqual(project.reads.filter(filePath => filePath === 'chapters/a.md').length, 1);
  assert.deepStrictEqual(prepared.snapshots.map(item => item.path), ['chapters/a.md']);
  assert(prepared.messages[0].content.includes('R ONLY'));
  assert(prepared.messages[0].content.includes('S ONLY'));
});

test('超过 16 个文件的项目不再被默认截断，明确目标时只读目标与 edit.md', () => {
  const files = { 'edit.md': '# Prompt' };
  for (let index = 0; index < 20; index += 1) files[`chapters/${index}.md`] = `# ${index}`;
  const project = fakeProject(files);
  const prepared = service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['chapters/19.md']),
  });
  assert.deepStrictEqual(project.reads, ['edit.md', 'chapters/19.md']);
  assert.deepStrictEqual(prepared.snapshots.map(item => item.path), ['chapters/19.md']);
});

test('首个超大文件立即 fail-fast，不会 break 或生成空 snapshot', () => {
  const project = fakeProject({ 'edit.md': 'x'.repeat(service.MAX_CONTEXT_BYTES + 1), 'a.md': '# A' });
  expectCode('PROJECT_PROMPT_REQUIRED', () => service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md']),
  }));
  assert.deepStrictEqual(project.reads, ['edit.md']);
});

test('正文合计未超限但完整模型消息超限时也 fail-fast', () => {
  const project = fakeProject({
    'edit.md': 'P'.repeat(61_000),
    'a.md': 'A'.repeat(61_000),
  });
  expectCode('PROJECT_CHANGES_CONTEXT_TOO_LARGE', () => service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md']),
  }));
});

test('两文件 localized edits 由 Main 在权威 before 上构造 after', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'a.md': 'A OLD\nkeep', 'b.md': 'B OLD\nkeep' });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md', 'b.md']),
  });
  const result = service.finalizeProjectChangesProposal({
    prepared,
    model: { ok: true, stopReason: 'end_turn', text: JSON.stringify({ edits: [
      { path: 'a.md', oldText: 'A OLD', newText: 'A NEW', summary: '更新 A' },
      { path: 'b.md', oldText: 'B OLD', newText: 'B NEW', summary: '更新 B' },
    ] }) },
    changeSetService,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.noChanges, false);
  assert.strictEqual(result.fileCount, 2);
  assert.deepStrictEqual(result.changeSet.changes.map(item => [item.path, item.after]), [
    ['a.md', 'A NEW\nkeep'], ['b.md', 'B NEW\nkeep'],
  ]);
});

test('结构化范围编号在 prompt 与 Main 恢复中保持同一顺序', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'a.md': 'A OLD', 'b.md': 'B OLD' });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project,
    rootPath: '/project',
    request: request(['a.md', 'b.md']),
    structuredOutput: true,
  });
  assert(prepared.messages[0].content.includes('targetId="target_1" path="a.md"'));
  assert(prepared.messages[0].content.includes('targetId="target_2" path="b.md"'));
  assert(prepared.messages[0].content.includes('<editable-range rangeId="range_1"'));
  assert(prepared.messages[0].content.includes('<editable-range rangeId="range_2"'));
  const result = service.finalizeProjectChangesProposal({
    prepared,
    model: {
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        name: 'submit_localized_edits',
        input: { edits: [{
          rangeId: 'range_2',
          newText: 'B NEW',
          summary: '修改第二个目标',
        }] },
      },
    },
    changeSetService,
  });
  assert.deepStrictEqual(result.changeSet.changes.map(change => [change.path, change.after]), [
    ['b.md', 'B NEW'],
  ]);
});

test('重复重叠局部修改与越权路径都被拒绝', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'a.md': 'UNIQUE' });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md']),
  });
  const finalize = edits => service.finalizeProjectChangesProposal({
    prepared, model: { ok: true, stopReason: 'end_turn', text: JSON.stringify({ edits }) }, changeSetService,
  });
  expectCode('PATCH_OVERLAP', () => finalize([
    { path: 'a.md', oldText: 'UNIQUE', newText: 'ONE', summary: '一' },
    { path: 'a.md', oldText: 'UNIQUE', newText: 'TWO', summary: '二' },
  ]));
  expectCode('UNAUTHORIZED_PATCH_PATH', () => finalize([
    { path: 'edit.md', oldText: 'UNIQUE', newText: 'BAD', summary: '越权' },
  ]));
});

test('生成后任一 target/edit/context revision 漂移都会阻止', () => {
  const project = fakeProject({ 'edit.md': 'Prompt', 'a.md': 'A', 'references/r.md': 'R' });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md'], ['references/r.md']),
  });
  assert.strictEqual(service.validateProjectDependencies({ projectService: project, rootPath: '/project', dependencies: prepared.dependencies }), true);
  for (const filePath of ['edit.md', 'a.md', 'references/r.md']) {
    const original = project.files.get(filePath);
    project.files.set(filePath, `${original}!`);
    expectCode('PROJECT_CHANGES_STALE', () => service.validateProjectDependencies({
      projectService: project, rootPath: '/project', dependencies: prepared.dependencies,
    }));
    project.files.set(filePath, original);
  }
});

test('空/no-op 局部结果返回 noChanges，截断输出返回明确错误', () => {
  const project = fakeProject({ 'edit.md': '# Prompt', 'a.md': 'SAME' });
  const prepared = service.prepareProjectChangesProposal({
    projectService: project, rootPath: '/project', request: request(['a.md']),
  });
  const empty = service.finalizeProjectChangesProposal({
    prepared, model: { ok: true, stopReason: 'end_turn', text: '{"edits":[]}' }, changeSetService,
  });
  assert.deepStrictEqual({ ok: empty.ok, noChanges: empty.noChanges, fileCount: empty.fileCount },
    { ok: true, noChanges: true, fileCount: 0 });
  const noOp = service.finalizeProjectChangesProposal({
    prepared,
    model: { ok: true, stopReason: 'end_turn', text: JSON.stringify({ edits: [
      { path: 'a.md', oldText: 'SAME', newText: 'SAME', summary: '无变化' },
    ] }) },
    changeSetService,
  });
  assert.strictEqual(noOp.noChanges, true);
  expectCode('MODEL_OUTPUT_TRUNCATED', () => service.finalizeProjectChangesProposal({
    prepared, model: { ok: true, stopReason: 'max_tokens', text: '{"edits":[]}' }, changeSetService,
  }));
});

if (!process.exitCode) console.log(`\nProject Changes proposal ${passed}/${passed} passed.`);
