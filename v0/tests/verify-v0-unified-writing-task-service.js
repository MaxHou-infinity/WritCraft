'use strict';

const assert = require('assert');
const crypto = require('crypto');
const service = require('../src/main/unified-writing-task-service');
const localized = require('../src/main/localized-edit-service');

const content = '## 开篇\n\n作者原文。\n';
const snapshots = [{ path: 'chapters/01.md', content,
  revision: crypto.createHash('sha256').update(content).digest('hex') }];
const ranges = localized.buildSelectedStructuredRangeCatalog(snapshots, [{
  path: snapshots[0].path,
  revision: snapshots[0].revision,
  start: content.indexOf('作者原文。'),
  end: content.indexOf('作者原文。') + '作者原文。'.length,
}]);

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
  const [changes, needsSources] = options.tools[0].input_schema.oneOf;
  assert.strictEqual(changes.properties.status.const, 'changes');
  assert.strictEqual(changes.properties.edits.minItems, 1);
  assert.strictEqual(changes.properties.edits.maxItems, 3);
  assert.deepStrictEqual(changes.properties.edits.items.required, ['rangeId', 'newText', 'summary']);
  assert.deepStrictEqual(changes.properties.edits.items.properties.rangeId.enum, ['range_1']);
  assert.strictEqual(changes.properties.reason.const, '');
  assert.strictEqual(changes.properties.question.const, '');
  assert.strictEqual(needsSources.properties.status.const, 'needs_sources');
  assert.strictEqual(needsSources.properties.edits.maxItems, 0);
  assert.strictEqual(needsSources.properties.reason.minLength, 1);
  assert.strictEqual(needsSources.properties.question.minLength, 1);
  assert.strictEqual(needsSources.properties.reason.pattern, changes.properties.edits.items.properties.summary.pattern);
  assert(options.tools[0].description.includes('不得返回路径、原文'));
});

test('changes resolves a Main-owned evidence range without model-authored source text', () => {
  const result = service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', newText: '更清晰的作者原文。', summary: '精简开篇' }],
    reason: '', question: '' }), snapshots, ranges);
  assert.strictEqual(result.kind, 'changes');
  assert.deepStrictEqual(result.edits[0], {
    path: 'chapters/01.md', revision: snapshots[0].revision,
    start: content.indexOf('作者原文。'), end: content.indexOf('作者原文。') + '作者原文。'.length,
    oldText: '作者原文。',
    newText: '更清晰的作者原文。', summary: '精简开篇',
  });
});

test('needs-sources returns one focused recovery question and no edit', () => {
  const result = service.parseResult(model({ status: 'needs_sources', edits: [],
    reason: '缺少支持该数字的来源', question: '请选择该数字的原始出处' }), snapshots, ranges);
  assert.deepStrictEqual(result, { kind: 'needs_sources', reason: '缺少支持该数字的来源',
    question: '请选择该数字的原始出处' });
});

test('needs-sources schema and Main reject the same leading or trailing whitespace', () => {
  const pattern = new RegExp(service.providerOptions(ranges).tools[0].input_schema.oneOf[1]
    .properties.reason.pattern, 'u');
  assert.strictEqual(pattern.test('缺少来源'), true);
  assert.strictEqual(pattern.test(' 缺少来源'), false);
  assert.strictEqual(pattern.test('缺少来源 '), false);
  for (const reason of [' 缺少来源', '缺少来源 ']) {
    expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
      status: 'needs_sources', edits: [], reason, question: '请选择来源',
    }), snapshots, ranges));
  }
});

test('mixed changes and source recovery is rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({ status: 'changes',
    edits: [{ rangeId: 'range_1', newText: '作者原文。', summary: '保持原文' }],
    reason: '仍缺来源', question: '' }), snapshots, ranges));
});

test('zero-edit changes and more than three edits are rejected', () => {
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseResult(model({
    status: 'changes', edits: [], reason: '', question: '' }), snapshots, ranges));
  const edits = Array.from({ length: 4 }, () => ({ rangeId: 'range_1', newText: '作者原文。', summary: '保持原文' }));
  expectCode('TOO_MANY_PATCH_EDITS', () => service.parseResult(model({
    status: 'changes', edits, reason: '', question: '' }), snapshots, ranges));
});

test('a canonical evidence slice becomes the only replaced source text', () => {
  const longContent = `## 长章节\n\n${'很长的正文。'.repeat(300)}唯一锚点。\n`;
  const longSnapshots = [{ path: 'chapters/long.md', content: longContent, revision: crypto.createHash('sha256').update(longContent).digest('hex') }];
  const anchorStart = longContent.indexOf('唯一锚点。');
  const longRanges = localized.buildSelectedStructuredRangeCatalog(longSnapshots, [{
    path: longSnapshots[0].path, revision: longSnapshots[0].revision,
    start: anchorStart, end: anchorStart + '唯一锚点。'.length,
  }]);
  const parsed = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: '精简锚点。', summary: '精简局部',
  }], reason: '', question: '' }), longSnapshots, longRanges);
  const built = service.buildChangeSet({ snapshots: longSnapshots, ranges: longRanges, parsed,
    changeSetService: { createChangeSet: (_snapshots, proposals) => ({ changes: proposals }) } });
  assert.strictEqual(built.noChanges, false);
  assert.strictEqual(built.fileCount, 1);
  assert(built.changeSet.changes[0].after.includes('精简锚点。'));
  assert(!built.changeSet.changes[0].after.includes('唯一锚点。'));
});

test('unknown, duplicate and overlapping evidence ranges fail closed', () => {
  expectCode('UNAUTHORIZED_PATCH_RANGE', () => service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_2', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges));
  expectCode('DUPLICATE_PATCH_RANGE', () => service.parseResult(model({ status: 'changes', edits: [
    { rangeId: 'range_1', newText: '替换', summary: '修改一' },
    { rangeId: 'range_1', newText: '替换', summary: '修改二' },
  ], reason: '', question: '' }), snapshots, ranges));
  expectCode('PATCH_OVERLAP', () => localized.buildSelectedStructuredRangeCatalog(snapshots, [
    { path: snapshots[0].path, revision: snapshots[0].revision, start: 0, end: 8 },
    { path: snapshots[0].path, revision: snapshots[0].revision, start: 4, end: 12 },
  ]));
  const forgedRanges = ranges.map(range => ({ ...range, extra: true }));
  expectCode('INVALID_PATCH_RANGES', () => service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, forgedRanges));
});

test('selected evidence boundaries never split a Unicode scalar', () => {
  const emojiContent = '甲😀乙';
  const emojiSnapshots = [{ path: 'chapters/emoji.md', content: emojiContent,
    revision: crypto.createHash('sha256').update(emojiContent).digest('hex') }];
  for (const selection of [
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]) {
    expectCode('INVALID_PATCH_RANGES', () => localized.buildSelectedStructuredRangeCatalog(
      emojiSnapshots,
      [{ path: emojiSnapshots[0].path, revision: emojiSnapshots[0].revision, ...selection }],
    ));
  }
  const accepted = localized.buildSelectedStructuredRangeCatalog(emojiSnapshots, [{
    path: emojiSnapshots[0].path, revision: emojiSnapshots[0].revision, start: 1, end: 3,
  }]);
  assert.strictEqual(accepted[0].content, '😀');
});

test('schema envelope accepts the exact Unicode replacement maximum and rejects one scalar beyond it', () => {
  const exactNewText = '😀'.repeat(localized.STRUCTURED_MAX_NEW_TEXT_CHARS);
  const exactParsed = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: exactNewText, summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges);
  assert.strictEqual(exactParsed.edits[0].newText, exactNewText);
  const exactBuilt = service.buildChangeSet({ snapshots, ranges,
    parsed: exactParsed, changeSetService: { createChangeSet: (_snapshots, proposals) => ({ changes: proposals }) } });
  assert.strictEqual(exactBuilt.fileCount, 1);

  const oversized = '😀'.repeat(localized.STRUCTURED_MAX_NEW_TEXT_CHARS + 1);
  expectCode('PATCH_NEW_TEXT_TOO_LARGE', () => service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: oversized, summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges));
});

test('ChangeSet boundary binds one private parse result to one exact request and consumes it once', () => {
  const parsed = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges);
  const forged = Object.freeze({ kind: 'changes', edits: Object.freeze([{ ...parsed.edits[0] }]) });
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildChangeSet({ snapshots, ranges, parsed: forged,
    changeSetService: { createChangeSet: () => ({ changes: [] }) } }));

  const crossRequest = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges);
  const clonedSnapshots = snapshots.map(snapshot => ({ ...snapshot }));
  const clonedRanges = localized.buildSelectedStructuredRangeCatalog(clonedSnapshots, [{
    path: clonedSnapshots[0].path, revision: clonedSnapshots[0].revision,
    start: ranges[0].start, end: ranges[0].end,
  }]);
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildChangeSet({
    snapshots: clonedSnapshots,
    ranges: clonedRanges,
    parsed: crossRequest,
    changeSetService: { createChangeSet: (_snapshots, proposals) => ({ changes: proposals }) },
  }));

  const singleUse = service.parseResult(model({ status: 'changes', edits: [{
    rangeId: 'range_1', newText: '替换', summary: '修改',
  }], reason: '', question: '' }), snapshots, ranges);
  const request = { snapshots, ranges, parsed: singleUse,
    changeSetService: { createChangeSet: (_snapshots, proposals) => ({ changes: proposals }) } };
  assert.strictEqual(service.buildChangeSet(request).fileCount, 1);
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildChangeSet(request));
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
