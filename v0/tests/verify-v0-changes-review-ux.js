'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const V0 = path.join(__dirname, '..');
const view = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');

let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}

test('review copy separates local decisions from the disk commit', () => {
  assert(view.includes('“接受 / 拒绝”只记录你的选择'));
  assert(view.includes('确认决定并更新 edit.md'));
  assert(view.includes('确认决定并写入文件'));
  assert(view.includes('尚未写入项目文件'));
});

test('complete-decision reviews retain their blocking message after a choice', () => {
  assert(view.includes('function setReviewDecisionStatus'));
  assert(view.includes('请先处理全部修改块；还剩 ${counts.pending} 项'));
  assert(view.includes('setReviewDecisionStatus(`已${next'));
});

test('single-hunk files do not render a redundant bulk toolbar', () => {
  assert(view.includes('if (file.hunks.length > 1)'));
  assert(!view.includes("['全部接受', 'accepted']"));
  assert(view.includes('本文件全接受'));
});

test('selected review decisions become explicit non-clickable states', () => {
  assert(view.includes("button.disabled = reviewCommitInFlight || active"));
  assert(view.includes("button.setAttribute('aria-pressed', String(active))"));
  assert(view.includes("? '已接受'"));
  assert(html.includes('.change-decision:disabled[aria-pressed="true"]'));
});

test('decided hunks collapse into a truthful pre-commit summary', () => {
  assert(view.includes("result.className = 'change-hunk-result'"));
  assert(view.includes('已选择接受 · 尚未写入'));
  assert(view.includes("revise.textContent = '修改决定'"));
  assert(view.includes('expandedReviewHunks.delete(hunk.id)'));
  assert(html.includes('.change-hunk-result'));
});

test('chapter generation owns only its own busy label', () => {
  assert(view.includes("function setBusy(busy, label = 'general', owner = null)"));
  assert(view.includes("busy && label !== 'chapter'"));
  assert(view.includes("busy && label === 'chapter' ? '生成中…'"));
  assert(view.includes("setBusy(true, 'chapter', progressOwner)"));
  assert(view.includes("setBusy(false, 'chapter', progressOwner)"));
});

test('long-running generation replaces stale results with elapsed progress', () => {
  assert(view.includes('function startGenerationProgress'));
  assert(view.includes('generationProgressOwner !== owner'));
  assert(view.includes("typeof options.longWaitingMessage === 'function'"));
  assert(view.includes('已等待 ${seconds} 秒'));
  assert(view.includes('请不要重复提交'));
  assert(view.includes('startGenerationProgress('));
  assert(html.includes('.changes-generation-progress'));
});

test('history undo names its exact target and warns on older records', () => {
  assert(view.includes("undo.textContent = '撤销此记录'"));
  assert(view.includes("undo.setAttribute('aria-label', `安全撤销：${target.title}`)"));
  assert(view.includes('undoHistory(entry, { isLatest: index === 0 })'));
  assert(view.includes('historyPresentation?.undoConfirmation?.(entry, options)'));
  assert(view.includes("'正在安全撤销'"));
  assert(view.includes('不会调用 AI。'));
  assert(view.includes('安全撤销仍在核对，已等待 ${seconds} 秒'));
  assert(view.includes('generationProgressOwner === progressOwner'));
  assert(view.includes('if (historyUndoOwner !== undoOwner) return'));
  assert(view.includes("'安全撤销已结束；结果已在状态栏和修改历史中确认。'"));
  assert(view.includes("title.className = 'history-card-title'"));
  assert(html.includes('changes-history-presentation.js'));
  assert(html.includes('.history-card.is-latest'));
});

console.log(`\nChanges review UX verification: ${passed}/8 passed.`);
