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
});

test('changes converts validated IDs to Main-owned localized input', () => {
  const result = service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', newText: '## 开篇\n\n更清晰的作者原文。\n', summary: '精简开篇' }],
    reason: '', question: '' }), snapshots, ranges);
  assert.strictEqual(result.kind, 'changes');
  assert.strictEqual(result.model.toolUse.name, localized.STRUCTURED_TOOL_NAME);
});

test('needs-sources returns one focused recovery question and no edit', () => {
  const result = service.parseResult(model({ status: 'needs_sources', edits: [],
    reason: '缺少支持该数字的来源', question: '请选择该数字的原始出处' }), snapshots, ranges);
  assert.deepStrictEqual(result, { kind: 'needs_sources', reason: '缺少支持该数字的来源',
    question: '请选择该数字的原始出处' });
});

test('mixed changes and source recovery is rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', newText: content, summary: '保持原文' }],
    reason: '仍缺来源', question: '' }), snapshots, ranges));
});

test('zero-edit changes and more than three edits are rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'changes', edits: [], reason: '', question: '' }), snapshots, ranges));
  const edits = Array.from({ length: 4 }, () => ({ rangeId: 'range_1', newText: content, summary: '保持原文' }));
  expectCode('TOO_MANY_PATCH_EDITS', () => service.parseResult(model({
    status: 'changes', edits, reason: '', question: '' }), snapshots, ranges));
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
