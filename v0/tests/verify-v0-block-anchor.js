#!/usr/bin/env node
const assert = require('assert');
const anchor = require('../src/shared/block-anchor');
let pass = 0;
function check(label, fn) { try { fn(); pass += 1; console.log(`  ✓ ${label}`); } catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; } }
console.log('════════ WritCraft V0 · Block anchor verify ════════');
check('按标题层级拆分可定位 Markdown 块', () => {
  const blocks = anchor.parseBlocks('# 一\n\n正文。\n\n## 二\n\n- 项目\n', 'chapters/a.md');
  assert.deepStrictEqual(blocks.map(item => item.type), ['heading', 'paragraph', 'heading', 'list']);
  assert.equal(blocks.at(-1).headingKey, '一 / 二');
});
check('选段锚点包含项目路径、章节语境与相对位置', () => {
  const text = '# 章\n\n这是关键段落。\n'; const start = text.indexOf('关键');
  const made = anchor.createBlockAnchor(text, 'a.md', start, start + 2);
  assert.equal(made.schema, anchor.SCHEMA); assert.equal(made.headingKey, '章'); assert.equal(made.quote, '关键');
});
check('前方插入内容后用唯一原文精确重定位', () => {
  const original = '# 章\n\n关键事实。\n'; const start = original.indexOf('关键');
  const made = anchor.createBlockAnchor(original, 'a.md', start, start + 4);
  const result = anchor.resolveBlockAnchor(made, '前言\n\n' + original);
  assert.equal(result.ok, true); assert.equal(result.method, 'exact_quote'); assert.equal(result.start, start + 4);
});
check('轻微编辑后只在同章节同序号高相似块回退定位', () => {
  const original = '# 章\n\n这是一个非常关键且明确的事实段落。\n';
  const start = original.indexOf('这是'); const made = anchor.createBlockAnchor(original, 'a.md', start, original.trimEnd().length);
  const result = anchor.resolveBlockAnchor(made, '# 章\n\n这是一个非常关键并且明确的事实段落。\n');
  assert.equal(result.ok, true); assert.equal(result.method, 'section_ordinal_similarity');
});
check('重复原文不会静默猜测', () => {
  const original = '# 一\n\n重复句。\n'; const start = original.indexOf('重复');
  const made = anchor.createBlockAnchor(original, 'a.md', start, start + 4);
  assert.equal(anchor.resolveBlockAnchor(made, '# 一\n\n重复句。\n\n# 二\n\n重复句。\n').reason, 'ambiguous_quote');
});
check('原章节删除后不跳到其他章节由重复变唯一的副本', () => {
  const original = '# A\n\n重复关键句。\n\n# B\n\n重复关键句。\n';
  const start = original.indexOf('重复关键句');
  const made = anchor.createBlockAnchor(original, 'a.md', start, start + 5);
  const result = anchor.resolveBlockAnchor(made, '# B\n\n重复关键句。\n');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'quote_context_changed');
});
check('跨块选择和危险路径被拒绝', () => {
  assert.throws(() => anchor.createBlockAnchor('甲\n\n乙', 'a.md', 0, 4));
  assert.throws(() => anchor.parseBlocks('x', '../a.md'));
});
if (!process.exitCode) console.log(`\n✅ Block anchor ${pass}/${pass} 全过`);
