#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const helper = require(path.join(V0, 'src/renderer/rewrite-state.js'));
const aiGuard = require(path.join(V0, 'src/renderer/ai-request-guard.js'));
const editor = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf8');
const sanitizer = fs.readFileSync(path.join(V0, 'src/renderer/html-sanitizer.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
let pass = 0;
function check(label, fn) {
  try { fn(); console.log('  ✓ ' + label); pass++; }
  catch (error) { console.error('  ✗ ' + label + ': ' + error.message); process.exitCode = 1; }
}

console.log('════════ WritCraft V0 · Day 5 behavior verify ════════');
check('接受只产生 proposal，不拼接原文', () => {
  assert.equal(helper.resolveRewrite('accept', '原文', '新文'), '新文');
});
check('拒绝精确恢复原文', () => {
  assert.equal(helper.resolveRewrite('reject', '两个相同句。两个相同句。', '新文'), '两个相同句。两个相同句。');
});
check('稳定正文可以持久化', () => {
  const payload = JSON.parse(helper.createStoragePayload('<p>正文</p>'));
  assert.equal(payload.html, '<p>正文</p>');
});
check('过期 API 响应会被忽略', () => {
  assert.equal(helper.isLatestRequest(3, 2), false);
  assert.equal(helper.isLatestRequest(3, 3), true);
});
check('AI 响应绑定项目、Prompt、文件 revision 与编辑版本', () => {
  const state = {
    project: { instanceId: 'project-a' }, editContextRevision: 'prompt-1',
    currentPath: 'chapter.md', revision: 'file-1', editVersion: 3,
  };
  const guard = aiGuard.capture(state);
  assert.equal(aiGuard.matches(guard, state), true);
  assert.equal(aiGuard.matches(guard, { ...state, editContextRevision: 'prompt-2' }), false);
  assert.equal(aiGuard.matches(guard, { ...state, editVersion: 4 }), false);
  assert.equal(aiGuard.matches(guard, { ...state, project: { instanceId: 'project-b' } }), false);
  assert.equal(aiGuard.shouldAdvanceContext({ currentRevisionChanged: false, editContextChanged: false, otherPathChanged: false }), false);
  assert.equal(aiGuard.shouldAdvanceContext({ currentRevisionChanged: true }), true);
  assert.equal(aiGuard.shouldAdvanceContext({ editContextChanged: true }), true);
  assert.equal(aiGuard.shouldAdvanceContext({ otherPathChanged: true }), true);
  assert.equal(aiGuard.shouldAdvanceContext({ projectInvalidated: true }), true);
  assert.ok(editor.includes('rewriteTransaction?.captureIntent'));
  assert.ok(editor.includes('const prepared = await rewriteTransaction.prepareIntent'));
  assert.ok(editor.includes('window.__workspace?.persistCurrent?.(true)'));
  assert.ok(editor.includes('window.__workspace?.settleOwnWriteEcho?.()'));
  assert.ok(editor.indexOf('const frozen = freezeRewriteIntent(style)') < editor.indexOf('await runRewrite(entry)'));
  assert.ok(editor.indexOf('await window.writCraft.rewrite') < editor.indexOf('const placed = placeRewriteAnchor'));
});
check('Markdown 原始 HTML 被转义', () => {
  assert.equal(helper.escapeMarkdownSource('<img onerror="boom">'), '&lt;img onerror="boom"&gt;');
});
check('Markdown 危险 URL 协议被拒绝', () => {
  assert.equal(helper.isSafeUrl('javascript:alert(1)'), false);
  assert.equal(helper.isSafeUrl('data:text/html,boom'), false);
  assert.equal(helper.isSafeUrl('https://example.com'), true);
  assert.equal(helper.isSafeUrl('#chapter-1'), true);
  assert.equal(helper.isSafeEmbeddedUrl('https://example.com/tracker.png'), false);
  assert.equal(helper.isSafeEmbeddedUrl('../../private.png'), false);
  assert.equal(helper.isSafeEmbeddedUrl('data:image/png;base64,aGVsbG8='), true);
  assert.equal(helper.isSafeEmbeddedUrl('data:image/svg+xml,<svg/>'), false);
  assert.ok(sanitizer.includes('ALLOWED_ELEMENTS'));
  assert.ok(sanitizer.includes('DROP_WITH_CONTENT'));
  assert.ok(sanitizer.includes('node.namespaceURI !== HTML_NAMESPACE'));
});
check('使用 DOM Range 锚点，不再全文字符串替换', () => {
  assert(editor.includes('cloneRange()'));
  assert(editor.includes('range.insertNode(wrapper)'));
  assert(editor.includes('entry.wrapper.replaceWith'));
  assert(!editor.includes('fullText.replace(oldText'));
});
check('Inline Diff 有接受/拒绝/重载和键盘路径', () => {
  assert(editor.includes("makeButton('接受', 'accept'"));
  assert(editor.includes("makeButton('拒绝', 'reject'"));
  assert(editor.includes("makeButton('重载', 'regenerate'"));
  assert(editor.includes("event.key === 'Tab'"));
  assert(editor.includes("event.ctrlKey && event.key === 'Enter'"));
  assert(editor.includes("['general', '润色']"));
  assert(editor.includes("entry.style || 'general'"));
});
check('页面包含红绿 Inline Diff 与自动保存资源', () => {
  assert(html.includes('.inline-diff-add'));
  assert(html.includes('.inline-diff-remove'));
  assert(html.includes('rewrite-state.js'));
  assert(html.includes('Content-Security-Policy'));
  assert(editor.includes('localStorage.setItem'));
  assert(editor.includes('restoreDraft()'));
  assert(editor.includes('getStableHtml()'));
  assert(editor.includes('htmlSanitizer.sanitizeFragment(template.content, state)'));
  assert(editor.includes('window.WritCraftBlockAnchor.createBlockAnchor'));
  assert(editor.includes('rewriteTransaction.createRequest(prepared.binding)'));
  assert(editor.includes('function readRenderedInnerText(clone)'));
  assert(editor.includes('function rangeOffsets(range, stableText)'));
  assert(editor.includes('if (withoutMarkers !== stableText) return null'));
  assert(editor.includes('const original = offsets ? stableText.slice(offsets.startOffset, offsets.endOffset)'));
  assert(!editor.includes('stableText.indexOf(selected.text'));
  assert(editor.includes('Object.freeze(proof)'));
  assert(editor.includes('window.Diff || window.diff'));
});

if (!process.exitCode) console.log(`\n✅ Day 5 行为/结构检查 ${pass}/${pass} 全过`);
