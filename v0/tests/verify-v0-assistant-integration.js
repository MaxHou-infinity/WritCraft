#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('src/renderer/index.html');
const preload = read('src/main/preload.js');
const workspace = read('src/renderer/workspace.js');
const changes = read('src/renderer/changes-view.js');
const sources = read('src/renderer/sources-view.js');
const integration = read('src/renderer/assistant-workspace.js');
let passed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('════════ WritCraft V0 · Writing Navigation integration ════════');

check('右栏只有 Chat / 导航 / Context / Changes 四枚权威书签', () => {
  for (const mode of ['chat', 'navigation', 'context', 'changes']) {
    assert.match(html, new RegExp(`data-assistant-mode="${mode}"`));
    assert.match(html, new RegExp(`data-assistant-panel="${mode}"`));
  }
  assert.doesNotMatch(html, /data-assistant-(?:mode|panel)="plan"/);
});

check('导航状态、视图和样式只从本地 CSP 入口加载', () => {
  for (const asset of [
    'writing-navigation.css',
    'writing-navigation-state.js',
    'writing-navigation-view.js',
    'assistant-dock.js',
    'assistant-workspace.js',
  ]) assert(html.includes(asset), asset);
  for (const retired of [
    'plan-mode.css',
    'plan-mode-state.js',
    'plan-mode-view.js',
    'plan-handoff-transaction.js',
  ]) assert(!html.includes(retired), retired);
});

check('Renderer 生成请求先安全保存并绑定项目和 opaque attempt', () => {
  assert.match(integration, /await window\.__workspace\.persistCurrent\(true\)/);
  assert.match(integration, /bridge\.proposeWritingNavigation\(\s*projectInstanceId,\s*request,\s*attemptId\s*\)/);
  assert.match(preload, /proposeWritingNavigation: \(projectInstanceId, request, attemptId\)/);
  assert.match(preload, /cancelWritingNavigation: \(projectInstanceId, attemptId\)/);
});

check('结构预览与确认只调用 Main capability，提交后刷新失败不覆盖 committed truth', () => {
  assert.match(integration, /bridge\?\.prepareWritingStructure\?\.\(/);
  assert.match(integration, /bridge\.confirmWritingStructure\(capabilityId\)/);
  assert.match(integration, /onStructureCommitted: async \(\) =>/);
  assert.match(integration, /try \{ await window\.__workspace\?\.refreshTree\?\.\(\); \} catch \(_\) \{\}/);
});

check('结构恢复在每次进入项目时查询并只由 Main ack', () => {
  assert.match(integration, /writcraft:project-entered/);
  assert.match(integration, /void navigationController\?\.recover\?\.\(\)/);
  assert.match(integration, /queryWritingStructureRecovery/);
  assert.match(integration, /acknowledgeWritingStructureRecovery/);
});

check('打开章节先打开文件再交给权威 locator 定位', () => {
  assert.match(integration, /await window\.__workspace\?\.openFile\?\.\(filePath\)/);
  assert.match(integration, /window\.__workspace\?\.revealContextChip\?\.\(\{/);
});

check('补充来源进入 Sources 专用入口且不会自动运行 Research', () => {
  assert.match(integration, /__sourcesView\?\.openWritingNavigation\?\.\(result\.handoff\)/);
  assert.match(sources, /window\.__workspace\?\.setSidebarView\?\.\('sources'\)/);
  assert.doesNotMatch(integration, /bridge\.(?:research|recordResearchJudgment)/);
});

check('生成修改建议只把 Main review 交给 Changes，路由失败回收新 capability', () => {
  assert.match(integration, /__changesView\?\.acceptProposal\?\.\(result\)/);
  assert.match(integration, /bridge\.discardChanges\?\.\(projectInstanceId, result\.changeSetId\)/);
  assert.doesNotMatch(integration, /writeFile|applyChanges|createFile|innerHTML/);
});

check('项目和文件变化只用当前 workspace 权威状态更新导航', () => {
  for (const event of [
    'writcraft:project-entered',
    'writcraft:tree-changed',
    'writcraft:current-file-changed',
  ]) assert(integration.includes(event), event);
  assert.match(integration, /workspace\?\.state\?\.project/);
  assert.match(integration, /window\.__workspace\?\.state\?\.tree/);
});

check('Chat 与 Changes 仍统一通过 Dock 切换', () => {
  assert.match(workspace, /window\.__assistantDock\.open\('chat'\)/);
  assert.match(changes, /window\.__assistantDock\.open\('changes'\)/);
  assert.match(integration, /WritCraftAssistantDock\?\.mount/);
});

if (!process.exitCode) console.log(`\n✅ Writing Navigation integration ${passed}/${passed} 全过`);
