'use strict';

const assert = require('assert');
const crypto = require('crypto');
const service = require('../src/main/unified-writing-task-service');
const localized = require('../src/main/localized-edit-service');

const content = '## 开篇\n\n作者原文。\n';
const snapshots = [{ path: 'chapters/01.md', content,
  revision: crypto.createHash('sha256').update(content).digest('hex') }];
const ranges = localized.buildStructuredRangeCatalog(snapshots);

function model(input, overrides = {}) {
  return { ok: true, stopReason: 'tool_use', toolUseBlockCount: 1,
    toolUse: { name: service.TOOL_NAME, input }, ...overrides };
}
function expectCode(code, fn) {
  assert.throws(fn, error => error?.code === code, `应拒绝为 ${code}`);
}

console.log('\nUnified writing task service verification');
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`✓ ${name}`); }

test('provider forces one named tool with a 1–3 edit ceiling', () => {
  const options = service.providerOptions(ranges);
  assert.strictEqual(options.tools[0].name, service.TOOL_NAME);
  assert.deepStrictEqual(options.toolChoice, { type: 'tool', name: service.TOOL_NAME });
  assert.strictEqual(options.tools[0].input_schema.properties.edits.maxItems, 3);
  assert.deepStrictEqual(options.tools[0].input_schema.properties.edits.items.properties.rangeId.enum, ['range_1']);
  assert.strictEqual(options.tools[0].input_schema.properties.edits.items.required.includes('oldText'), true);
});

test('changes converts a unique bounded anchor to Main-owned exact offsets', () => {
  const result = service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', oldText: '作者原文。', newText: '更清晰的作者原文。', summary: '精简开篇' }],
    reason: '', question: '' }), snapshots, ranges);
  assert.strictEqual(result.kind, 'changes');
  assert.deepStrictEqual(result.edits[0], {
    path: 'chapters/01.md', revision: snapshots[0].revision,
    start: content.indexOf('作者原文。'), end: content.indexOf('作者原文。') + '作者原文。'.length,
    newText: '更清晰的作者原文。', summary: '精简开篇',
  });
});

test('needs-sources returns one focused recovery question and no edit', () => {
  const result = service.parseResult(model({ status: 'needs_sources', edits: [],
    reason: '缺少支持该数字的来源', question: '请选择该数字的原始出处' }), snapshots, ranges);
  assert.deepStrictEqual(result, { kind: 'needs_sources', reason: '缺少支持该数字的来源',
    question: '请选择该数字的原始出处' });
});

test('mixed changes and source recovery is rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', oldText: '作者原文。', newText: '作者原文。', summary: '保持原文' }],
    reason: '仍缺来源', question: '' }), snapshots, ranges));
});

test('zero-edit changes and more than three edits are rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'changes', edits: [], reason: '', question: '' }), snapshots, ranges));
  const edits = Array.from({ length: 4 }, () => ({ rangeId: 'range_1', oldText: '作者原文。', newText: '作者原文。', summary: '保持原文' }));
  expectCode('TOO_MANY_PATCH_EDITS', () => service.parseResult(model({
    status: 'changes', edits, reason: '', question: '' }), snapshots, ranges));
});

test('long ranges accept a short local replacement without reproducing the range', () => {
  const longContent = `## 长章节\n\n${'很长的正文。'.repeat(300)}唯一锚点。\n`;
  const longSnapshots = [{ path: 'chapters/long.md', content: longContent, revision: crypto.createHash('sha256').update(longContent).digest('hex') }];
  const longRanges = localized.buildStructuredRangeCatalog(longSnapshots);
  const parsed = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', oldText: '唯一锚点。', newText: '精简锚点。', summary: '精简局部',
  }], reason: '', question: '' }), longSnapshots, longRanges);
  const built = service.buildChangeSet({ snapshots: longSnapshots, edits: parsed.edits,
    changeSetService: { createChangeSet: (_snapshots, proposals) => ({ changes: proposals }) } });
  assert.strictEqual(built.noChanges, false);
  assert(built.changeSet.changes[0].after.includes('精简锚点。'));
  assert(!built.changeSet.changes[0].after.includes('唯一锚点。'));
});

test('missing, repeated and overlapping anchors fail closed', () => {
  expectCode('PATCH_ANCHOR_NOT_FOUND', () => service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', oldText: '不存在', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges));
  const repeatedContent = '## 开篇\n\n重复原文。重复原文。\n';
  const repeatedSnapshots = [{ path: 'chapters/repeated.md', content: repeatedContent,
    revision: crypto.createHash('sha256').update(repeatedContent).digest('hex') }];
  const repeatedRanges = localized.buildStructuredRangeCatalog(repeatedSnapshots);
  expectCode('PATCH_ANCHOR_NOT_UNIQUE', () => service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', oldText: '重复原文。', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), repeatedSnapshots, repeatedRanges));
  expectCode('PATCH_OVERLAP', () => service.parseResult(model({ status: 'changes', edits: [
    { rangeId: 'range_1', oldText: '作者原文。', newText: '替换', summary: '修改一' },
    { rangeId: 'range_1', oldText: '原文。', newText: '替换', summary: '修改二' },
  ], reason: '', question: '' }), snapshots, ranges));
});

test('free text, multiple tools and max-token partial output never become authority', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult({ ok: true, stopReason: 'end_turn' }, snapshots, ranges));
  const recovery = { status: 'needs_sources', edits: [], reason: '缺来源', question: '补来源' };
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model(recovery, { toolUseBlockCount: 2 }), snapshots, ranges));
  expectCode('MODEL_OUTPUT_TRUNCATED', () => service.parseResult(model(recovery, { stopReason: 'max_tokens' }), snapshots, ranges));
});

test('unknown keys, controls and unpaired surrogates fail closed', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'needs_sources', edits: [], reason: '缺来源', question: '补来源', extra: true }), snapshots, ranges));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'needs_sources', edits: [], reason: '缺\u0001来源', question: '补来源' }), snapshots, ranges));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'needs_sources', edits: [], reason: '\ud800', question: '补来源' }), snapshots, ranges));
});

test('emoji remains valid inside the bounded recovery envelope', () => {
  const result = service.parseResult(model({ status: 'needs_sources', edits: [],
    reason: '缺少访谈😀', question: '请选择原始访谈😀' }), snapshots, ranges);
  assert.strictEqual(result.kind, 'needs_sources');
});

console.log(`\n${passed}/${passed} unified writing task service checks passed.`);
