#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const blockAnchor = require('../src/shared/block-anchor');
const contextService = require('../src/main/inline-rewrite-context-service');
const service = require('../src/main/inline-rewrite-service');

let passed = 0;
function test(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}
function expectCode(code, run) {
  assert.throws(run, error => error instanceof service.InlineRewriteError && error.code === code);
}
function revision(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-service-'));
  const project = projectService.createProjectAt(parent, 'Inline v1');
  projectService.createMarkdownFile(project.rootPath, 'chapters/01.md');
  const chapter = '# 第一章\n\n上一段。\n\n这是一段需要改写的文字。\n\n下一段。\n';
  const current = projectService.readFileWithRevision(project.rootPath, 'chapters/01.md');
  projectService.atomicWriteFile(project.rootPath, 'chapters/01.md', chapter, current.revision);
  return { parent, project, chapter };
}

function requestFor(item, filePath = 'chapters/01.md', content = item.chapter, selected = '需要改写') {
  const startOffset = content.indexOf(selected);
  const endOffset = startOffset + selected.length;
  const proof = contextService.compactProof(blockAnchor.createBlockAnchor(content, filePath, startOffset, endOffset));
  return {
    schema: contextService.REQUEST_SCHEMA,
    currentFilePath: filePath,
    expectedRevision: projectService.readFileWithRevision(item.project.rootPath, filePath).revision,
    style: 'concise',
    instruction: '压缩重复表达',
    selection: { startOffset, endOffset, proof },
  };
}

function prepare(item, request = requestFor(item), overrides = {}) {
  return service.prepareInlineRewrite({
    projectService,
    rootPath: item.project.rootPath,
    projectId: item.project.projectId,
    projectInstanceId: item.project.instanceId,
    mutationGeneration: 3,
    request,
    rewriteId: `ir_${'1'.repeat(32)}`,
    expiresAt: 2000000000000,
    ...overrides,
  });
}

function model(replacement, summary = '精简表达', overrides = {}) {
  return {
    stopReason: 'end_turn',
    contentBlockCount: 1,
    nonTextBlockCount: 0,
    text: JSON.stringify({ schema: service.RESULT_SCHEMA, replacement, summary }),
    ...overrides,
  };
}

console.log('════════ WritCraft V0 · Inline Rewrite v1 Main service verify ════════');

test('严格校验 stopReason、单 text block、完整 JSON 与重复/原型字段', () => {
  assert.deepStrictEqual(service.parseModelResult(model('新文本')), { replacement: '新文本', summary: '精简表达' });
  for (const [code, value] of [
    ['MODEL_OUTPUT_TRUNCATED', model('x', 'ok', { stopReason: 'max_tokens', text: 'x'.repeat(20000) })],
    ['MODEL_OUTPUT_INCOMPLETE', model('x', 'ok', { stopReason: 'tool_use' })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { contentBlockCount: 2 })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { nonTextBlockCount: 1 })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: '```json\n{}\n```' })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: `${JSON.stringify({ schema: service.RESULT_SCHEMA, replacement: 'x', summary: 'ok' })} trailing` })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: `{"schema":"${service.RESULT_SCHEMA}","replacement":"a","replacement":"b","summary":"ok"}` })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: `{"schema":"${service.RESULT_SCHEMA}","replacement":"a","summary":"ok","__proto__":"x"}` })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: JSON.stringify({ schema: service.RESULT_SCHEMA, replacement: 'x', summary: ' bad ' }) })],
    ['INVALID_MODEL_OUTPUT', model('x', 'ok', { text: JSON.stringify({ schema: service.RESULT_SCHEMA, replacement: 'x', summary: 'bad\nline' }) })],
  ]) expectCode(code, () => service.parseModelResult(value));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResult(null));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResult(undefined));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResult(model('x', 'ok', {
    text: `{\u00a0"schema":"${service.RESULT_SCHEMA}","replacement":"x","summary":"ok"}`,
  })));
});

test('replacement 保留空白并允许删除，但受 12 KiB/NUL；summary 按 code point/byte 限制', () => {
  assert.equal(service.parseModelResult(model('')).replacement, '');
  assert.equal(service.parseModelResult(model('  保留空白  ')).replacement, '  保留空白  ');
  for (const value of [
    model('\0'),
    model('x'.repeat(service.MAX_REPLACEMENT_BYTES + 1)),
    model('x', '🚀'.repeat(service.MAX_SUMMARY_CODE_POINTS + 1)),
    model('x', '汉'.repeat(400)),
    model('x', 'ok', { text: 'x'.repeat(service.MAX_MODEL_OUTPUT_BYTES + 1) }),
  ]) expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelResult(value));
});

test('Main 重建 target/edit/neighbors，冻结依赖和隐私有界 provenance', () => {
  const item = fixture();
  try {
    const prepared = prepare(item);
    assert.match(prepared.messages[0].content, /安全规则与输出 JSON 契约/);
    assert.match(prepared.messages[0].content, /作者改写要求/);
    assert.match(prepared.messages[0].content, /冲突.*作者改写要求为准/);
    assert.match(prepared.messages[0].content, /不可信写作资料/);
    assert(prepared.messages[0].content.indexOf('作者改写要求：') <
      prepared.messages[0].content.indexOf('辅助风格：'));
    assert(prepared.messages[0].content.includes('需要改写'));
    assert.equal(prepared.dependencies.instruction, '压缩重复表达');
    assert.equal(prepared.dependencies.target.path, 'chapters/01.md');
    assert.match(prepared.dependencies.selection.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.dependencies.projectPrompt.path, 'edit.md');
    assert(prepared.dependencies.neighbors.length <= 4);
    assert.deepStrictEqual(prepared.dependencies.neighbors.map(item => item.role),
      prepared.dependencies.neighbors.map(item => item.role).sort((a, b) =>
        ['previous', 'before_selection', 'after_selection', 'next'].indexOf(a) -
        ['previous', 'before_selection', 'after_selection', 'next'].indexOf(b)));
    const finalized = service.finalizeInlineRewrite({
      prepared, model: model('应改写'), projectService, changeSetService, mutationGeneration: 3,
    });
    assert.equal(finalized.outcome, 'review');
    assert.equal(finalized.changeSet.changes.length, 1);
    assert.equal(finalized.changeSet.changes[0].after, item.chapter.replace('需要改写', '应改写'));
    const serialized = JSON.stringify(finalized.provenance);
    assert(!serialized.includes(item.project.rootPath));
    assert(!serialized.includes('需要改写'));
    assert(!serialized.includes('应改写'));
    assert(!serialized.includes('压缩重复表达'));
    assert(!serialized.includes('irc_'));
    assert(Buffer.byteLength(serialized) <= service.MAX_PROVENANCE_BYTES);
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('preview/no-op/delete 全部零写入，ChangeSet 仅包含一个目标', () => {
  const item = fixture();
  try {
    const prepared = prepare(item);
    const before = fs.readFileSync(path.join(item.project.rootPath, 'chapters/01.md'), 'utf8');
    const noop = service.finalizeInlineRewrite({ prepared, model: model('需要改写'), projectService, changeSetService, mutationGeneration: 3 });
    assert.equal(noop.outcome, 'no_op');
    assert.equal(noop.capabilityId, undefined);
    const deletion = service.finalizeInlineRewrite({ prepared, model: model('', '删除选段'), projectService, changeSetService, mutationGeneration: 3 });
    assert.equal(deletion.outcome, 'review');
    assert.equal(deletion.replacement, '');
    assert.equal(deletion.changeSet.changes[0].after, before.replace('需要改写', ''));
    assert.equal(fs.readFileSync(path.join(item.project.rootPath, 'chapters/01.md'), 'utf8'), before);
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('references/sources/symlink/hard-link edit alias 与 path identity fail closed', () => {
  const item = fixture();
  try {
    fs.mkdirSync(path.join(item.project.rootPath, 'references'));
    fs.writeFileSync(path.join(item.project.rootPath, 'references/source.md'), '# 来源\n');
    const sourceContent = '# 来源\n';
    const sourceRequest = requestFor(item, 'references/source.md', sourceContent, '来源');
    expectCode('INLINE_REWRITE_PROTECTED_TARGET', () => prepare(item, sourceRequest));

    fs.linkSync(path.join(item.project.rootPath, 'edit.md'), path.join(item.project.rootPath, 'chapters/edit-alias.md'));
    const aliasContent = fs.readFileSync(path.join(item.project.rootPath, 'chapters/edit-alias.md'), 'utf8');
    const aliasRequest = requestFor(item, 'chapters/edit-alias.md', aliasContent, '项目主旨');
    expectCode('INLINE_REWRITE_PROTECTED_TARGET', () => prepare(item, aliasRequest));

    fs.symlinkSync(path.join(item.project.rootPath, 'chapters/01.md'), path.join(item.project.rootPath, 'chapters/link.md'));
    const linkStart = item.chapter.indexOf('需要改写');
    const linkRequest = {
      schema: contextService.REQUEST_SCHEMA,
      currentFilePath: 'chapters/link.md',
      expectedRevision: revision(item.chapter),
      style: 'concise',
      instruction: '压缩重复表达',
      selection: {
        startOffset: linkStart,
        endOffset: linkStart + '需要改写'.length,
        proof: contextService.compactProof(blockAnchor.createBlockAnchor(
          item.chapter, 'chapters/link.md', linkStart, linkStart + '需要改写'.length,
        )),
      },
    };
    expectCode('INLINE_REWRITE_PROTECTED_TARGET', () => prepare(item, linkRequest));
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('edit.md 可改正文但 Front Matter 选区/变化/错误全部拒绝', () => {
  const item = fixture();
  try {
    const edit = projectService.readFileWithRevision(item.project.rootPath, 'edit.md').content;
    const bodyRequest = requestFor(item, 'edit.md', edit, '用一句话写下这个项目最重要的命题。');
    const bodyPrepared = prepare(item, bodyRequest);
    const valid = service.finalizeInlineRewrite({
      prepared: bodyPrepared, model: model('明确项目最重要的命题。'), projectService, changeSetService, mutationGeneration: 3,
    });
    assert.equal(service.frontMatterSlice(valid.changeSet.changes[0].after), service.frontMatterSlice(edit));
    const frontRequest = requestFor(item, 'edit.md', edit, 'writcraft.edit/v1');
    expectCode('INLINE_REWRITE_PROTECTED_TARGET', () => prepare(item, frontRequest));
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('target/edit/selection/proof/neighbor/inode drift 在 apply 前均 stale', () => {
  const item = fixture();
  try {
    const prepared = prepare(item);
    assert.equal(service.validateInlineRewriteDependencies({
      projectService, rootPath: item.project.rootPath, projectId: item.project.projectId, projectInstanceId: item.project.instanceId,
      mutationGeneration: 3, dependencies: prepared.dependencies,
    }), true);
    const snapshot = projectService.readFileWithRevision(item.project.rootPath, 'chapters/01.md');
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/01.md', `${snapshot.content}漂移`, snapshot.revision);
    expectCode('INLINE_REWRITE_STALE', () => service.validateInlineRewriteDependencies({
      projectService, rootPath: item.project.rootPath, projectId: item.project.projectId, projectInstanceId: item.project.instanceId,
      mutationGeneration: 3, dependencies: prepared.dependencies,
    }));
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('模型 await 后的 finalize 强制复核依赖，漂移不能获得 proposal', () => {
  const item = fixture();
  try {
    const prepared = prepare(item);
    const edit = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', `${edit.content}\n新约束`, edit.revision);
    expectCode('INLINE_REWRITE_STALE', () => service.finalizeInlineRewrite({
      prepared, model: model('已改写'), projectService, changeSetService, mutationGeneration: 3,
    }));
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('context 构建后 edit.md 二次读取竞态 fail closed，不冻结新 revision 配旧 prompt', () => {
  const item = fixture();
  try {
    let editReads = 0;
    const racingProjectService = {
      ...projectService,
      readFileWithRevision(rootPath, filePath) {
        const snapshot = projectService.readFileWithRevision(rootPath, filePath);
        if (filePath === projectService.EDIT_FILE && ++editReads === 2) {
          return { ...snapshot, revision: '0'.repeat(64) };
        }
        return snapshot;
      },
    };
    expectCode('INLINE_REWRITE_STALE', () => prepare(item, requestFor(item), { projectService: racingProjectService }));
    assert.equal(editReads, 2);
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('durable marker 原子 applying→terminal，支持 authoritative reconciliation 与 exact clear', () => {
  const item = fixture();
  try {
    let now = 1000;
    const markers = service.createInlineRewriteReconciliationService({ clock: () => now });
    const before = projectService.readFileWithRevision(item.project.rootPath, 'chapters/01.md');
    const afterContent = item.chapter.replace('需要改写', '已改写');
    const applying = markers.beginApply({
      rootPath: item.project.rootPath, projectId: item.project.projectId,
      rewriteId: `ir_${'a'.repeat(32)}`, path: 'chapters/01.md',
      beforeRevision: before.revision, expectedAfterRevision: revision(afterContent),
    });
    assert.equal(applying.state, 'applying');
    const raw = fs.readFileSync(path.join(item.project.rootPath, service.RECONCILIATION_PATH), 'utf8');
    for (const secret of ['irc_', item.project.rootPath, '已改写', '需要改写']) assert(!raw.includes(secret));
    assert(raw.includes(item.project.projectId));
    assert(!raw.includes('projectInstanceId'));
    const reopened = projectService.openProject(item.project.rootPath);
    assert.equal(reopened.projectId, item.project.projectId);
    assert.equal(markers.publicStatus({ rootPath: item.project.rootPath, projectId: item.project.projectId }).status, 'applying');
    expectCode('INLINE_REWRITE_STALE', () => markers.clear({
      rootPath: item.project.rootPath, projectId: item.project.projectId, rewriteId: applying.rewriteId,
    }));
    now = 1100;
    const reconciled = markers.reconcileApplying({
      rootPath: item.project.rootPath, projectId: item.project.projectId,
      projectService, findHistory: () => null,
    });
    assert.equal(reconciled.status, 'terminal');
    assert.equal(reconciled.marker.outcome, 'zero_write_error');
    assert.deepStrictEqual(markers.clear({
      rootPath: item.project.rootPath, projectId: item.project.projectId, rewriteId: applying.rewriteId,
    }), { ok: true, schema: 'writcraft.inline-rewrite-reconciliation-clear-result/v1', status: 'cleared' });
    assert.equal(markers.read(item.project.rootPath), null);
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

test('重启 reconciliation 只信任与 marker path/revision/provenance 全匹配的 History', () => {
  const item = fixture();
  try {
    const markers = service.createInlineRewriteReconciliationService({ clock: () => 2000 });
    const before = projectService.readFileWithRevision(item.project.rootPath, 'chapters/01.md');
    const afterContent = item.chapter.replace('需要改写', '已改写');
    const rewriteId = `ir_${'b'.repeat(32)}`;
    markers.beginApply({
      rootPath: item.project.rootPath, projectId: item.project.projectId, rewriteId,
      path: 'chapters/01.md', beforeRevision: before.revision, expectedAfterRevision: revision(afterContent),
    });
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/01.md', afterContent, before.revision);
    const reconciled = markers.reconcileApplying({
      rootPath: item.project.rootPath,
      projectId: item.project.projectId,
      projectService,
      findHistory: () => ({
        id: 'change_123e4567-e89b-42d3-a456-426614174000',
        rewriteId,
        provenance: null,
        files: [],
      }),
    });
    assert.equal(reconciled.marker.outcome, 'manual_recovery');
    assert.equal(reconciled.marker.errorCode, 'INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED');
  } finally { fs.rmSync(item.parent, { recursive: true, force: true }); }
});

if (!process.exitCode) console.log(`\n✅ Inline Rewrite v1 Main service ${passed}/${passed} 全过`);
