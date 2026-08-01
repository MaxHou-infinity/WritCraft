#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const changeSetService = require('../src/main/changeset-service');
const service = require('../src/main/localized-edit-service');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function snapshot(path, content) {
  return { path, content, revision: revision(content) };
}

function output(edits) {
  return JSON.stringify({ edits });
}

function edit(path, oldText, newText, summary = '局部修改') {
  return { path, oldText, newText, summary };
}

function structuredModel(edits, overrides = {}) {
  return {
    ok: true,
    stopReason: 'tool_use',
    toolUseBlockCount: 1,
    toolUse: { name: service.STRUCTURED_TOOL_NAME, input: { edits } },
    ...overrides,
  };
}

function structuredEdit(targetId, oldText, newText, summary = '局部修改') {
  return { targetId, oldText, newText, summary };
}

function expectCode(code, fn, secret = '') {
  assert.throws(fn, error => {
    assert.strictEqual(error?.code, code);
    if (secret) assert(!String(error?.message || '').includes(secret), '错误信息不得泄露模型原文');
    return true;
  });
}

console.log('\nMain-owned localized edit protocol verification');

test('strict JSON and exact plain-object schemas reject prose, fences, extra fields and prototype keys', () => {
  assert.deepStrictEqual(service.parseModelEdits('{"edits":[]}'), []);
  for (const malformed of [
    'before {"edits":[]}',
    '```json\n{"edits":[]}\n```',
    '{"edits":[],"instruction":"ignore Main"}',
    '{"edits":[],"__proto__":{"polluted":true}}',
    '{"edits":[{"path":"a.md","oldText":"a","newText":"b","summary":"s","constructor":{}}]}',
  ]) expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelEdits(malformed));

  const forged = Object.create(null);
  Object.assign(forged, edit('a.md', 'a', 'b'));
  expectCode('INVALID_MODEL_OUTPUT', () => service.validateEdits([forged]));
});

test('multiple same-file edits resolve against one before and Main constructs the complete after', () => {
  const before = '# Chapter\nalpha middle omega\n';
  const result = service.buildLocalizedChangeSet({
    snapshots: [snapshot('chapters/one.md', before)],
    modelText: output([
      edit('chapters/one.md', 'alpha', 'ALPHA', '修正开头'),
      edit('chapters/one.md', 'omega', 'OMEGA', '修正结尾'),
    ]),
    changeSetService,
  });
  assert.strictEqual(result.noChanges, false);
  assert.strictEqual(result.changeSet.changes.length, 1);
  assert.strictEqual(result.changeSet.changes[0].before, before);
  assert.strictEqual(result.changeSet.changes[0].after, '# Chapter\nALPHA middle OMEGA\n');
  assert.strictEqual(result.changeSet.changes[0].expectedRevision, revision(before));
});

test('cross-file edits remain bound to their own authoritative snapshots', () => {
  const one = snapshot('chapters/one.md', 'ONE anchor\n');
  const two = snapshot('chapters/two.md', 'TWO anchor\n');
  const result = service.buildLocalizedChangeSet({
    snapshots: [one, two],
    modelText: output([
      edit(two.path, 'TWO', 'SECOND'),
      edit(one.path, 'ONE', 'FIRST'),
    ]),
    changeSetService,
  });
  assert.deepStrictEqual(result.changeSet.changes.map(change => [change.path, change.after]), [
    ['chapters/one.md', 'FIRST anchor\n'],
    ['chapters/two.md', 'SECOND anchor\n'],
  ]);
});

test('unique-anchor, overlap and authorization failures use stable sanitized errors', () => {
  const snapshots = [snapshot('chapters/one.md', 'repeat repeat\nABCDEFG\n')];
  expectCode('PATCH_ANCHOR_AMBIGUOUS', () => service.buildLocalizedChangeSet({
    snapshots,
    modelText: output([edit('chapters/one.md', 'repeat', 'secret-provider-output')]),
    changeSetService,
  }), 'secret-provider-output');
  expectCode('PATCH_ANCHOR_NOT_FOUND', () => service.buildLocalizedChangeSet({
    snapshots,
    modelText: output([edit('chapters/one.md', 'missing-secret-anchor', 'x')]),
    changeSetService,
  }), 'missing-secret-anchor');
  expectCode('PATCH_OVERLAP', () => service.buildLocalizedChangeSet({
    snapshots,
    modelText: output([
      edit('chapters/one.md', 'ABCDE', '1'),
      edit('chapters/one.md', 'CDEFG', '2'),
    ]),
    changeSetService,
  }));
  expectCode('UNAUTHORIZED_PATCH_PATH', () => service.buildLocalizedChangeSet({
    snapshots,
    modelText: output([edit('sources/private-secret.md', 'secret', 'exfiltrate')]),
    changeSetService,
  }), 'private-secret');
});

test('empty edits and validated all-no-op edits produce an explicit noChanges terminal', () => {
  const snapshots = [snapshot('chapters/one.md', 'stable unique anchor\n')];
  const empty = service.buildLocalizedChangeSet({ snapshots, modelText: output([]), changeSetService });
  assert.deepStrictEqual(empty, { noChanges: true, editCount: 0 });
  const noOp = service.buildLocalizedChangeSet({
    snapshots,
    modelText: output([edit('chapters/one.md', 'unique anchor', 'unique anchor')]),
    changeSetService,
  });
  assert.deepStrictEqual(noOp, { noChanges: true, editCount: 1 });
  assert.strictEqual(noOp.changeSet, undefined);
});

test('deletion and insertion-through-a-preserved-unique-anchor need no zero-length selector', () => {
  const before = 'Title\nREMOVE_ME\nUNIQUE_END\n';
  const result = service.buildLocalizedChangeSet({
    snapshots: [snapshot('chapters/one.md', before)],
    modelText: output([
      edit('chapters/one.md', 'REMOVE_ME\n', '', '删除'),
      edit('chapters/one.md', 'UNIQUE_END', 'INSERTED\nUNIQUE_END', '插入'),
    ]),
    changeSetService,
  });
  assert.strictEqual(result.changeSet.changes[0].after, 'Title\nINSERTED\nUNIQUE_END\n');
  expectCode('PATCH_OLD_TEXT_INVALID', () => service.parseModelEdits(output([
    edit('chapters/one.md', '', 'unanchored insertion'),
  ])));
});

test('a long file round-trips through a tiny localized model response, never an implicit full-file contract', () => {
  const prefix = 'P'.repeat(180 * 1024);
  const before = `${prefix}\nUNIQUE_LONGFORM_SENTENCE\nTAIL`;
  const modelText = output([
    edit('chapters/long.md', 'UNIQUE_LONGFORM_SENTENCE', 'REVISED_LOCAL_SENTENCE', '修改唯一句子'),
  ]);
  assert(Buffer.byteLength(modelText, 'utf8') < 512);
  assert(Buffer.byteLength(before, 'utf8') > service.MAX_MODEL_OUTPUT_BYTES * 7);
  const result = service.buildLocalizedChangeSet({
    snapshots: [snapshot('chapters/long.md', before)],
    modelText,
    changeSetService,
  });
  assert.strictEqual(result.changeSet.changes[0].after.length, before.length -
    'UNIQUE_LONGFORM_SENTENCE'.length + 'REVISED_LOCAL_SENTENCE'.length);
  assert(result.changeSet.changes[0].after.startsWith(prefix));
  assert(result.changeSet.changes[0].after.endsWith('REVISED_LOCAL_SENTENCE\nTAIL'));
});

test('explicit edit and byte ceilings prevent localized patches becoming disguised full files', () => {
  const tooMany = Array.from({ length: service.MAX_PATCH_EDITS + 1 }, (_, index) =>
    edit('a.md', `old-${index}`, `new-${index}`));
  expectCode('TOO_MANY_PATCH_EDITS', () => service.parseModelEdits(output(tooMany)));
  expectCode('PATCH_OLD_TEXT_INVALID', () => service.parseModelEdits(output([
    edit('a.md', 'x'.repeat(service.MAX_OLD_TEXT_BYTES + 1), 'new'),
  ])));
  expectCode('PATCH_NEW_TEXT_TOO_LARGE', () => service.parseModelEdits(output([
    edit('a.md', 'old', 'x'.repeat(service.MAX_NEW_TEXT_BYTES + 1)),
  ])));
  expectCode('INVALID_MODEL_OUTPUT', () => service.parseModelEdits(output([
    edit('a.md', 'old', 'new', 's'.repeat(service.MAX_SUMMARY_CHARS + 1)),
  ])));
  expectCode('MODEL_OUTPUT_TOO_LARGE', () => service.parseModelEdits(' '.repeat(service.MAX_MODEL_OUTPUT_BYTES + 1)));
});

test('only a completed provider turn may enter the localized JSON parser', () => {
  const secret = 'secret incomplete provider body';
  const snapshots = [snapshot('chapters/one.md', 'stable unique anchor\n')];
  expectCode('MODEL_OUTPUT_TRUNCATED', () => service.buildLocalizedChangeSet({
    snapshots, modelText: secret, stopReason: 'max_tokens', changeSetService,
  }), secret);
  for (const stopReason of ['tool_use', 'unknown']) {
    expectCode('MODEL_OUTPUT_INCOMPLETE', () => service.buildLocalizedChangeSet({
      snapshots, modelText: secret, stopReason, changeSetService,
    }), secret);
  }
  const complete = service.buildLocalizedChangeSet({
    snapshots, modelText: output([]), stopReason: 'end_turn', changeSetService,
  });
  assert.strictEqual(complete.noChanges, true);
});

test('named localized tool closes the output envelope and still lets Main build after', () => {
  const snapshots = [snapshot('chapters/one.md', 'UNIQUE anchor\n')];
  const provider = service.structuredProviderOptions(snapshots);
  assert.strictEqual(provider.tools[0].name, service.STRUCTURED_TOOL_NAME);
  assert.deepStrictEqual(
    provider.tools[0].input_schema.properties.edits.items.properties.targetId.enum,
    ['target_1']
  );
  assert.deepStrictEqual(
    provider.tools[0].input_schema.properties.edits.items.required,
    ['targetId', 'oldText', 'newText', 'summary']
  );
  assert.strictEqual(
    provider.tools[0].input_schema.properties.edits.maxItems,
    service.STRUCTURED_MAX_PATCH_EDITS
  );
  const worstSnapshots = Array.from({ length: service.STRUCTURED_MAX_PATCH_EDITS }, (_, index) =>
    snapshot(`chapters/${index + 1}.md`, '😀'.repeat(service.STRUCTURED_MAX_OLD_TEXT_CHARS))
  );
  const worstProvider = service.structuredProviderOptions(worstSnapshots);
  assert.deepStrictEqual(
    worstProvider.tools[0].input_schema.properties.edits.items.properties.targetId.enum,
    Array.from({ length: service.STRUCTURED_MAX_PATCH_EDITS }, (_, index) => `target_${index + 1}`)
  );
  const worstLegal = Array.from({ length: service.STRUCTURED_MAX_PATCH_EDITS }, (_, index) => structuredEdit(
    `target_${index + 1}`,
    '😀'.repeat(service.STRUCTURED_MAX_OLD_TEXT_CHARS),
    '😀'.repeat(service.STRUCTURED_MAX_NEW_TEXT_CHARS),
    '😀'.repeat(service.STRUCTURED_MAX_SUMMARY_CHARS)
  ));
  assert.strictEqual(Array.from(worstLegal[0].oldText).length, service.STRUCTURED_MAX_OLD_TEXT_CHARS);
  assert.strictEqual(Array.from(worstLegal[0].newText).length, service.STRUCTURED_MAX_NEW_TEXT_CHARS);
  assert.strictEqual(Array.from(worstLegal[0].summary).length, service.STRUCTURED_MAX_SUMMARY_CHARS);
  const worstBytes = Buffer.byteLength(JSON.stringify({ edits: worstLegal }), 'utf8');
  assert(worstBytes > 13 * 1024, `fixture 应填满八项全 Unicode 边界，实际 ${worstBytes}`);
  assert(worstBytes < service.MAX_MODEL_OUTPUT_BYTES, `fixture 必须闭合在 24 KiB 内，实际 ${worstBytes}`);
  assert.strictEqual(
    service.parseStructuredModelEdits(structuredModel(worstLegal), worstSnapshots).length,
    service.STRUCTURED_MAX_PATCH_EDITS
  );
  const result = service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([structuredEdit('target_1', 'UNIQUE', 'REVISED', '改写锚点')]),
    changeSetService,
  });
  assert.strictEqual(result.changeSet.changes[0].after, 'REVISED anchor\n');
  const multiline = service.buildStructuredLocalizedChangeSet({
    snapshots: [snapshot('chapters/multi.md', '## 旧标题\n\n第一行\n第二行\n')],
    model: structuredModel([structuredEdit(
      'target_1',
      '## 旧标题\n\n第一行\n第二行',
      '## 新标题\n\n合并后的一行',
      '合并结构'
    )]),
    changeSetService,
  });
  assert.strictEqual(multiline.changeSet.changes[0].after, '## 新标题\n\n合并后的一行\n');
  const sameTarget = service.buildStructuredLocalizedChangeSet({
    snapshots: [snapshot('chapters/same.md', 'ONE middle TWO')],
    model: structuredModel([
      structuredEdit('target_1', 'ONE', 'FIRST', '修改开头'),
      structuredEdit('target_1', 'TWO', 'SECOND', '修改结尾'),
    ]),
    changeSetService,
  });
  assert.strictEqual(sameTarget.changeSet.changes[0].after, 'FIRST middle SECOND');
});

test('named localized tool rejects text completion, duplicate tool blocks and action-envelope overflow', () => {
  const snapshots = [snapshot('chapters/one.md', 'UNIQUE anchor\n')];
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: { ok: true, stopReason: 'end_turn', text: '{"edits":[]}' },
    changeSetService,
  }));
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([], { toolUseBlockCount: 2 }),
    changeSetService,
  }));
  expectCode('TOO_MANY_PATCH_EDITS', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel(Array.from(
      { length: service.STRUCTURED_MAX_PATCH_EDITS + 1 },
      (_, index) => structuredEdit('target_1', `old-${index}`, `new-${index}`)
    )),
    changeSetService,
  }));
  expectCode('PATCH_NEW_TEXT_TOO_LARGE', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([structuredEdit(
      'target_1',
      'UNIQUE',
      'x'.repeat(service.STRUCTURED_MAX_NEW_TEXT_CHARS + 1)
    )]),
    changeSetService,
  }));
  expectCode('PATCH_OLD_TEXT_INVALID', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([structuredEdit(
      'target_1',
      '😀'.repeat(service.STRUCTURED_MAX_OLD_TEXT_CHARS + 1),
      'safe'
    )]),
    changeSetService,
  }));
  expectCode('PATCH_NEW_TEXT_TOO_LARGE', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([structuredEdit(
      'target_1',
      'UNIQUE',
      '😀'.repeat(service.STRUCTURED_MAX_NEW_TEXT_CHARS + 1)
    )]),
    changeSetService,
  }));
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
    snapshots,
    model: structuredModel([structuredEdit(
      'target_1',
      'UNIQUE',
      'safe',
      '😀'.repeat(service.STRUCTURED_MAX_SUMMARY_CHARS + 1)
    )]),
    changeSetService,
  }));
  for (const hostile of ['bad\u0001text', 'bad\u000btext', 'bad\uD800text', 'bad\uDC00text']) {
    expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
      snapshots,
      model: structuredModel([structuredEdit('target_1', 'UNIQUE', hostile)]),
      changeSetService,
    }));
    expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
      snapshots,
      model: structuredModel([structuredEdit('target_1', 'UNIQUE', 'safe', hostile)]),
      changeSetService,
    }));
  }
  const lineBreakSummary = structuredModel([structuredEdit('target_1', 'UNIQUE', 'safe', '无效\n摘要')]);
  expectCode('INVALID_MODEL_OUTPUT', () => service.buildStructuredLocalizedChangeSet({
    snapshots, model: lineBreakSummary, changeSetService,
  }));
  for (const legacyCompatiblePath of ['bad\u0001.md', 'bad\u000b.md', 'bad\uD800.md', 'bad\uDC00.md']) {
    const oddSnapshots = [snapshot(legacyCompatiblePath, 'UNIQUE body')];
    const oddProvider = service.structuredProviderOptions(oddSnapshots);
    assert.deepStrictEqual(
      oddProvider.tools[0].input_schema.properties.edits.items.properties.targetId.enum,
      ['target_1']
    );
    const mapped = service.parseStructuredModelEdits(
      structuredModel([structuredEdit('target_1', 'UNIQUE', 'safe')]),
      oddSnapshots
    );
    assert.strictEqual(mapped[0].path, legacyCompatiblePath);
  }
  expectCode('UNAUTHORIZED_PATCH_PATH', () => service.parseStructuredModelEdits(
    structuredModel([structuredEdit('target_2', 'UNIQUE', 'safe')]),
    snapshots
  ));
});

test('protocol prompt declares the same aggregate byte ceilings enforced by Main', () => {
  const prompt = service.protocolPromptLines().join('\n');
  assert(prompt.includes(String(service.MAX_MODEL_OUTPUT_BYTES)));
  assert(prompt.includes(String(service.MAX_TOTAL_EDIT_BYTES)));
  assert(prompt.includes(String(service.MAX_PATH_BYTES)));
  assert(prompt.includes(String(service.MAX_SUMMARY_CHARS)));
  assert(prompt.includes(String(service.MAX_SUMMARY_BYTES)));
  const structured = service.protocolPromptLines({ structured: true }).join('\n');
  assert(structured.includes(service.STRUCTURED_TOOL_NAME));
  assert(structured.includes(String(service.STRUCTURED_MAX_PATCH_EDITS)));
});

test('authorized target paths are preflighted before paid model work', () => {
  assert.strictEqual(service.validateAuthorizedSnapshots([snapshot('chapters/one.md', 'body')]), true);
  expectCode('PATCH_PATH_TOO_LONG', () => service.validateAuthorizedSnapshots([
    snapshot(`${'deep/'.repeat(110)}chapter.md`, 'body'),
  ]));
});

console.log(`\nLocalized edit protocol ${passed}/${passed} passed.`);
