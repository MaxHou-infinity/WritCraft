#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('src/renderer/index.html');
const view = read('src/renderer/image-generation-view.js');
const workspace = read('src/renderer/workspace.js');
const editor = read('src/renderer/editor.js');

let passed = 0;
function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

console.log('════════ WritCraft V0 · image-01 renderer verify ════════');

test('配图是 Chat 内的次级工具，不增加第五个 Assistant 书签', () => {
  assert.match(html, /id="image-toggle"/);
  assert.match(html, /id="image-compose"[^>]+hidden/);
  assert.equal((html.match(/<button[^>]+data-assistant-mode=/g) || []).length, 4);
});

test('只提供官方支持的有界比例与 1500 字符 Prompt', () => {
  assert.match(html, /id="image-prompt" maxlength="1500"/);
  for (const ratio of ['16:9', '4:3', '1:1', '3:4', '9:16']) assert(html.includes(`value="${ratio}"`));
});

test('renderer 只通过窄桥接传 origin、operationId 与 prompt/aspect，不传 Key、root 或输出路径', () => {
  assert.match(view, /bridge\.generateImage\(\s*projectInstanceId,\s*metric\.operationId,\s*value,\s*aspect\?\.value \|\| '16:9'\s*\)/);
  assert.doesNotMatch(view, /bridge\.generateImage\([^\n]*(?:apiKey|rootPath|outputPath|filePath)/);
});

test('生成结果先预览并展示尺寸证明，且只接受内嵌 PNG/JPEG data URL', () => {
  assert.match(view, /safePreviewDataUrl/);
  assert.match(view, /\^data:image\\\/\(\?:png\|jpeg\);base64/);
  assert.match(view, /请选择评分和最终动作/);
  assert.match(view, /owner\.image\?\.width/);
  assert.match(view, /owner\.image\?\.height/);
  assert.match(view, /requestedAspectRatio/);
  assert(!view.includes('innerHTML'));
});

test('评分后必须显式选择插入、保留或移入废纸篓', () => {
  assert.match(view, /插入当前正文/);
  assert.match(view, /保留素材/);
  assert.match(view, /移入废纸篓/);
  assert.match(view, /可在本面板中恢复/);
  assert.match(view, /qualityRating/);
  assert.match(view, /settleImageReview/);
  assert.match(view, /getImageReviewAggregate/);
  assert.match(view, /本项目 \$\{total\} 次评审/);
  assert.match(view, /insertGeneratedImage\?\.\(\s*owner\.image\s*\)/);
  assert.match(view, /pendingOwner !== owner/);
  assert.match(view, /reviewBusy/);
  assert.doesNotMatch(view, /(?:writeFile|atomicWrite|applyChanges)\s*\(/);
  assert.doesNotMatch(view, /(?:unlink|deleteAsset|trashFile|removeGeneratedImage)\s*\(/);
});

test('工作区拒绝 edit.md 和非 assets/generated 图片路径', () => {
  assert.match(workspace, /state\.currentPath === 'edit\.md'/);
  assert.match(workspace, /\^assets\\\/generated\\\//);
  assert.match(workspace, /insertMarkdown\?\.\(markdown\)/);
  assert.match(workspace, /!\[章节配图\]/);
  assert.doesNotMatch(workspace, /String\(altText/);
});

test('插入 Markdown 前后都经过现有项目保存门', () => {
  const start = workspace.indexOf('async function insertGeneratedImage');
  const end = workspace.indexOf('\n  function ', start + 20);
  const block = workspace.slice(start, end);
  assert((block.match(/await persistCurrent\(true\)/g) || []).length >= 2);
  assert.match(editor, /function insertMarkdown\(markdown\)/);
  assert.match(editor, /dispatchEvent\(new InputEvent\('input'/);
});

test('项目切换时通过 instanceId 和 sequence 丢弃旧图像结果', () => {
  assert.match(view, /requestSequence/);
  assert.match(view, /projectInstanceId !== window\.__workspace\?\.state\?\.project\?\.instanceId/);
  assert.match(view, /writcraft:project-entered/);
  assert.match(view, /clearResult\(\)/);
  assert.match(view, /window\.__imageGenerationView = Object\.freeze\(\{ discardPending, refreshTrash \}\)/);
  assert((workspace.match(/window\.__imageGenerationView\.discardPending\(\)/g) || []).length >= 2);
  assert.match(workspace, /请先对当前生成图片选择插入、保留或移入废纸篓/);
});

if (!process.exitCode) console.log(`\n✅ image-01 renderer ${passed}/8 全过`);
