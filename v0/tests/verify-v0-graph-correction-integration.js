'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const main = read('src/main/main.js');
const preload = read('src/main/preload.js');
const view = read('src/renderer/graph-view.js');
const html = read('src/renderer/index.html');
let passed = 0;

function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

console.log('\nGraph correction IPC and renderer verification');

check('preload exposes only project identity plus an opaque correction command', () => {
  assert(preload.includes("applyGraphCorrection: (projectInstanceId, command) => ipcRenderer.invoke('writcraft:project:apply-graph-correction', projectInstanceId, command)"));
  assert(preload.includes("buildGraph: (projectInstanceId) => ipcRenderer.invoke('writcraft:project:build-graph', projectInstanceId)"));
});

check('Main binds graph reads and correction writes to the current project instance', () => {
  assert(main.includes("ipcMain.handle('writcraft:project:build-graph', async (event, projectInstanceId)"));
  assert(main.includes("ipcMain.handle('writcraft:project:apply-graph-correction', async (event, projectInstanceId, command)"));
  const handler = main.slice(main.indexOf("ipcMain.handle('writcraft:project:apply-graph-correction'"), main.indexOf("ipcMain.handle('writcraft:project:set-issue-status'"));
  assert(handler.includes('assertTrustedSender(event)'));
  assert(handler.includes('projectInstanceId !== project.instanceId'));
  assert(handler.includes('indexProjectGraph(projectService, project.rootPath)'));
  assert(handler.includes('submitCorrection(project.rootPath, indexed.graph, command)'));
});

check('renderer submits identifier-only operations against the displayed graph identity', () => {
  assert(view.includes("schema: 'writcraft.graph-correction-command/v1'"));
  assert(view.includes('graphIdentity: graph.correctionState.graphIdentity'));
  assert(view.includes("{ type: 'merge_alias', sourceNodeId: item.id, targetNodeId: aliasSelect.value }"));
  assert(view.includes("{ type: 'decide_fact', edgeId: edge.id, decision }"));
  assert(view.includes("{ type: 'edit_attribute', nodeId: item.id, attribute: attributeName.value, value: attributeValue.value }"));
  assert(view.includes("{ type: 'remove_correction', correctionId: status.id }"));
  assert(!view.includes('rootPath:'));
});

check('author controls are keyboard accessible and explain persistence, source and evidence status', () => {
  for (const marker of ['作者纠错（不修改正文）', '选择别名的主节点', '要编辑的节点属性名', '节点属性值', '原证据已变更']) {
    assert(view.includes(marker));
  }
  assert(view.includes("section.setAttribute('aria-label', '作者纠错')"));
  assert(html.includes('.graph-correction-row button:focus-visible'));
  assert(view.includes('取消合并'));
  assert(view.includes("section.setAttribute('aria-label', '项目作者约束')"));
});

check('renderer refreshes the authoritative corrected graph and never edits manuscript content', () => {
  assert(view.includes('graph = window.WritCraftGraphFilters.freezeGraphSnapshot(result.graph)'));
  assert(view.includes('renderGraph()'));
  assert(view.includes('renderIssues()'));
  assert(!view.includes('writeFile('));
  assert(!view.includes('setContent('));
});

console.log(`\n${passed}/5 graph-correction integration checks passed.`);
