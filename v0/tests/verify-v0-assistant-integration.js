#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('src/renderer/index.html');
const main = read('src/main/main.js');
const planHandler = read('src/main/project-plan-handler.js');
const preload = read('src/main/preload.js');
const editor = read('src/renderer/editor.js');
const workspace = read('src/renderer/workspace.js');
const changes = read('src/renderer/changes-view.js');
const planTransaction = read('src/renderer/plan-handoff-transaction.js');
const integration = read('src/renderer/assistant-workspace.js');
let passed = 0;
function check(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

console.log('════════ WritCraft V0 · Assistant stack integration ════════');

check('右栏只有 Chat / Plan / Context / Changes 四枚权威书签', () => {
  for (const mode of ['chat', 'plan', 'context', 'changes']) {
    assert.match(html, new RegExp(`data-assistant-mode="${mode}"`));
    assert.match(html, new RegExp(`data-assistant-panel="${mode}"`));
  }
  assert.match(html, /role="tablist" aria-label="AI 协作模式"/);
});

check('Plan 与 Context 资源全部从本地受 CSP 约束的入口加载', () => {
  for (const asset of ['plan-mode.css', 'context-inspector.css', 'assistant-dock.js', 'plan-mode-state.js', 'plan-mode-view.js', 'plan-handoff-transaction.js', 'changes-proposal-transaction.js', 'context-inspector-state.js', 'context-inspector.js', 'assistant-workspace.js']) {
    assert(html.includes(asset), asset);
  }
  assert.match(html, /#plan-panel \.plan-mode__shell \{ display: flex; flex-direction: column/);
});

check('Plan Main IPC 使用权威 service 且 preload 只暴露窄方法', () => {
  assert.match(main, /require\('\.\/project-plan-service'\)/);
  assert.match(main, /require\('\.\/project-plan-handler'\)/);
  assert.match(main, /require\('\.\/project-plan-handoff-service'\)/);
  assert.match(main, /ipcMain\.handle\('writcraft:project:propose-plan'/);
  assert.match(main, /projectPlanHandler\.createProposePlanHandler\(\{/);
  assert.match(planHandler, /projectPlanService\.proposeProjectPlan\(\{/);
  assert.match(planHandler, /getMutationGeneration\(\) !== mutationGeneration/);
  assert.match(preload, /proposePlan: \(projectInstanceId, goal, contextPaths\) => ipcRenderer\.invoke\('writcraft:project:propose-plan'/);
  assert.match(preload, /handoffPlanTask: \(projectInstanceId, request\) => ipcRenderer\.invoke\('writcraft:project:handoff-plan-task'/);
});

check('Plan UI 仅转交到 Changes，不直接写正文或文件', () => {
  assert.match(integration, /__changesView\.openPlanTask\(payload\)/);
  assert.doesNotMatch(integration, /writeFile|applyChanges|createFile|innerHTML/);
  assert.match(integration, /当前文件未能安全保存/);
});

check('Plan→Changes 只上送不可编辑标识，并由 Main provenance 覆盖展示', () => {
  assert.match(changes, /bridge\.handoffPlanTask\(metric\.originProjectInstanceId, request\)/);
  assert.match(planTransaction, /\['schema', 'planId', 'taskId'\]/);
  assert.match(changes, /instruction\.readOnly = Boolean\(activePlanRequest \|\| activeIssueRequest\)/);
  assert.match(changes, /contextPicker\.hidden = Boolean\(activePlanRequest \|\| activeIssueRequest\)/);
  assert.match(changes, /脱离 Plan/);
  assert.match(changes, /result\.provenance\?\.targets/);
  assert.match(changes, /proposalTransactions\.settle\(transaction, result/);
  assert.doesNotMatch(integration, /task\.description|task\.targetPaths|openWithInstruction/);
});

check('Context 排除策略由 Main 缓存的权威 Manifest 建立', () => {
  assert.match(main, /contextPolicyService\.createExclusionPolicy\(lastContextResponse\.manifest/);
  assert.match(main, /lastContextResponse = \{ rootPath: currentProject\.rootPath, manifest: resolvedContext\.contextManifest \}/);
  assert.match(main, /policy: contextPolicy/);
});

check('Renderer 只传 excludedChipIds，并把实际 response Manifest 送入 Inspector', () => {
  assert.match(editor, /contextPolicy: window\.__contextInspectorView\?\.getRequestPolicy/);
  assert.match(editor, /__contextInspectorView\?\.update\?\.\(result\.contextManifest/);
  assert.match(integration, /getRequestPolicy: \(\) => contextController\?\.getRequestPolicy/);
  assert.doesNotMatch(integration, /contextManifest\s*:\s*window/);
});

check('Chat 与 Changes 统一通过 Dock 切换，旧入口仍兼容', () => {
  assert.match(workspace, /window\.__assistantDock\.open\('chat'\)/);
  assert.match(changes, /window\.__assistantDock\.open\('changes'\)/);
  assert.match(integration, /WritCraftAssistantDock\?\.mount/);
  assert.match(integration, /onClose\(\)[\s\S]*activity-changes/);
  assert.doesNotMatch(changes, /panel\.style\.display = 'none'/);
});

check('在途 Plan 请求在项目切换后静默失效，不污染新项目状态', () => {
  assert.match(integration, /const requestEpoch = projectEpoch/);
  assert.match(integration, /requestEpoch === projectEpoch \? result : \{ canceled: true \}/);
  assert.match(integration, /projectEpoch \+= 1/);
});

check('计划最多选择 8 个现存 Markdown 上下文', () => {
  assert.match(integration, /selectedPlanContext\.length < 8/);
  assert.match(integration, /selectedPlanContext = selectedPlanContext\.filter\(path => available\.includes\(path\)\)\.slice\(0, 8\)/);
  assert.match(integration, /bridge\.proposePlan\(originProjectInstanceId, goal, selectedPlanContext\)/);
});

check('项目切换会清空计划与上下文快照', () => {
  assert.match(integration, /writcraft:project-entered/);
  assert.match(integration, /planController\?\.update\?\.\(\{ status: 'empty' \}\)/);
  assert.match(integration, /contextController\?\.update/);
});

if (!process.exitCode) console.log(`\n✅ Assistant stack ${passed}/${passed} 全过`);
