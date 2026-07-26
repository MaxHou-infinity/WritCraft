#!/usr/bin/env node
const assert = require('assert');
const citation = require('../src/renderer/citation-formatter');
let pass = 0;
function check(label, fn) { try { fn(); pass++; console.log(`  ✓ ${label}`); } catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; } }
const source = { title: '写作研究', filePath: 'references/research.md', metadata: { author: '张三', published: '2025-03-01', citationKey: 'zhang2025', url: 'https://example.com/paper' } };
console.log('════════ WritCraft V0 · Citation formatter verify ════════');
check('APA7、MLA9、Chicago17 均输出人类可读引文', () => {
  assert.equal(citation.formatCitation(source, 'apa7'), '张三. (2025). 写作研究. https://example.com/paper');
  assert.match(citation.formatCitation(source, 'mla9'), /张三.*“写作研究\.”.*2025/);
  assert.match(citation.formatCitation(source, 'chicago17'), /张三.*写作研究.*2025/);
});
check('显式 citation key 被安全规范化', () => { assert.equal(citation.citationKey({ ...source, metadata: { citationKey: '../bad key' } }), '..-bad-key'); });
check('在光标处插入引用并在文末生成定义', () => {
  const result = citation.insertFootnote('正文。', 2, source, 'apa7');
  assert.equal(result.content.startsWith('正文[^zhang2025]。'), true);
  assert.match(result.content, /\[\^zhang2025\]: 张三/);
});
check('已有脚注定义不会重复追加', () => {
  const content = '正文。\n\n[^zhang2025]: 已有定义\n';
  const result = citation.insertFootnote(content, 0, source, 'apa7');
  assert.equal((result.content.match(/\[\^zhang2025\]:/g) || []).length, 1);
});
check('不同来源使用同一 citation key 时不会串到旧脚注（P1-2 回归）', () => {
  // 先插入来源 A（带指纹标记）
  const first = citation.insertFootnote('正文一。', 3, source, 'apa7');
  assert.equal(first.key, 'zhang2025');
  // 来源 B：显式声明相同 citationKey，但作者/文件/URL 完全不同
  const otherSource = { title: '另一研究', filePath: 'references/other.md', metadata: { author: '李四', published: '2024-08-01', citationKey: 'zhang2025', url: 'https://example.com/other' } };
  const second = citation.insertFootnote(first.content, 3, otherSource, 'apa7');
  // 必须分配后缀 key，不能复用 zhang2025
  assert.notEqual(second.key, 'zhang2025');
  assert.match(second.key, /^zhang2025-\d+$/);
  // 旧定义原样保留且只有一条；新定义独立存在
  assert.equal((second.content.match(/\[\^zhang2025\]: 张三/g) || []).length, 1);
  assert.match(second.content, new RegExp(`\\[\\^${second.key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]: 李四`));
  // 引用标记也使用新 key，不指向旧脚注
  assert(second.content.includes(`[^${second.key}]`));
});
check('同一来源重复插入时复用既有 key 且不新增定义（P1-2 对照）', () => {
  const first = citation.insertFootnote('正文一。', 3, source, 'apa7');
  const again = citation.insertFootnote(first.content, 0, source, 'apa7');
  assert.equal(again.key, 'zhang2025');
  assert.equal((again.content.match(/\[\^zhang2025\]:/g) || []).length, 1);
});
check('旧 32-bit FNV 碰撞的两个真实 SourceIndex ID 不会串引（P1-2 确定性回归）', () => {
  // 这两个 SHA-256 截断 ID 在旧实现中都会压缩为 FNV-1a `159d93d4`。
  const collisionA = {
    id: 'src_30c327c3b34ee8571727',
    title: '来源 A',
    filePath: 'references/d45b968b5ebfa604.md',
    metadata: { citationKey: 'same-key', author: '作者 A' },
  };
  const collisionB = {
    id: 'src_ef3e8e523967d15b41d7',
    title: '来源 B',
    filePath: 'references/9aed159ebec6eaaa.md',
    metadata: { citationKey: 'same-key', author: '作者 B' },
  };
  assert.notEqual(citation.sourceFingerprint(collisionA), citation.sourceFingerprint(collisionB));
  assert.equal(citation.sourceFingerprint(collisionA), collisionA.id);
  assert.equal(citation.sourceFingerprint(collisionB), collisionB.id);
  const first = citation.insertFootnote('正文。', 2, collisionA, 'apa7');
  const second = citation.insertFootnote(first.content, 0, collisionB, 'apa7');
  assert.equal(first.key, 'same-key');
  assert.equal(second.key, 'same-key-2');
  assert.match(second.content, /\[\^same-key\]: 作者 A/);
  assert.match(second.content, /\[\^same-key-2\]: 作者 B/);
});
check('没有 SourceIndex ID 的同一来源仍稳定复用双 64-bit 指纹', () => {
  const withoutId = { ...source };
  const first = citation.insertFootnote('正文。', 2, withoutId, 'apa7');
  const again = citation.insertFootnote(first.content, 0, { ...withoutId }, 'apa7');
  assert.match(citation.sourceFingerprint(withoutId), /^fp_[a-f0-9]{32}$/);
  assert.equal(again.key, first.key);
  assert.equal((again.content.match(/\[\^zhang2025\]:/g) || []).length, 1);
});
check('旧 8 位 marker 不再作为身份凭据，升级后保守分配新 key', () => {
  const legacy = '正文。\n\n[^zhang2025]: 旧定义 <!-- writcraft-source:159d93d4 -->\n';
  const result = citation.insertFootnote(legacy, 0, source, 'apa7');
  assert.equal(result.key, 'zhang2025-2');
  assert.match(result.content, /\[\^zhang2025\]: 旧定义/);
  assert.match(result.content, /\[\^zhang2025-2\]: 张三/);
});
check('危险 URL 不进入引文且未知风格被拒绝', () => {
  const unsafe = { ...source, metadata: { ...source.metadata, url: 'javascript:alert(1)' } };
  assert(!citation.formatCitation(unsafe, 'apa7').includes('javascript'));
  assert.throws(() => citation.formatCitation(source, 'unknown'));
});
if (!process.exitCode) console.log(`\n✅ Citation formatter ${pass}/${pass} 全过`);
