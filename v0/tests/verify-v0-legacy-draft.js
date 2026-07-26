#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const helper = require('../src/renderer/legacy-draft');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/legacy-draft.js'), 'utf8');
let pass = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass += 1; }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}
console.log('════════ WritCraft V0 · Legacy draft renderer verify ════════');
check('只识别旧版 v1 草稿载荷', () => {
  assert.deepStrictEqual(helper.parsePayload('{"version":1,"html":"<p>稿</p>","savedAt":7}'), { html: '<p>稿</p>', savedAt: 7 });
  assert.strictEqual(helper.parsePayload('{"version":2,"html":"x"}'), null);
  assert.strictEqual(helper.parsePayload('broken'), null);
});
check('转换器恢复旧 Diff 原文且不自动接受新增文字', () => {
  assert.ok(source.includes("querySelectorAll('.inline-diff-remove,.inline-diff-equal')"));
  assert.ok(source.includes('没有自动接受 AI 建议'));
  assert.ok(!source.includes("querySelectorAll('.inline-diff-add,.inline-diff-equal')"));
});
check('危险元素和链接协议不会进入 Markdown', () => {
  assert.ok(source.includes("['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'input']"));
  assert.ok(source.includes('safeLink'));
});
if (!process.exitCode) console.log(`\n✅ Legacy draft renderer ${pass}/${pass} 全过`);
