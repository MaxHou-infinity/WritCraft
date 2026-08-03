'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const projectService = require('./project-service');
const inventoryService = require('./workspace-inventory-service');
const graphIndexService = require('./graph-index-service');
const issueStateService = require('./issue-state-service');
const sourceIndexService = require('./source-index-service');

function flattenFiles(tree) {
  const output = [];
  const visit = nodes => {
    for (const node of nodes || []) {
      if (node?.type === 'directory') visit(node.children);
      else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) output.push(node.path);
    }
  };
  visit(tree);
  return output;
}

let collectionPhase = 'bootstrap';
try {
  const { rootPath, authority } = workerData;
  collectionPhase = 'tree';
  const tree = projectService.listTree(rootPath);
  collectionPhase = 'inventory';
  const inventory = inventoryService.buildWorkspaceInventory({
    projectService, rootPath, captureAuthority: () => authority,
  });
  collectionPhase = 'file-times';
  const fileTimes = {};
  for (const filePath of flattenFiles(tree)) {
    try { fileTimes[filePath] = fs.statSync(path.join(rootPath, ...filePath.split('/'))).mtimeMs; } catch (_) {}
  }
  collectionPhase = 'derived-indexes';
  let graph = null;
  let graphReasons = [];
  try {
    graph = graphIndexService.indexProjectGraph(projectService, rootPath).graph;
    graph = { ...graph, issues: issueStateService.reconcileIssueStates(rootPath, graph.issues).issues };
  }
  catch (error) { graphReasons = [error?.code || 'GRAPH_UNAVAILABLE']; }
  let source = { status: 'unavailable', completeness: 'partial', reasonCodes: ['SOURCE_UNAVAILABLE'] };
  try {
    const index = sourceIndexService.buildSourceIndex(rootPath);
    const reasons = [...new Set((index.errors || []).map(error => error.code).filter(code => /^[A-Z0-9_]{1,64}$/.test(code)))];
    source = {
      status: reasons.length ? 'partial' : (index.sources || []).length ? 'ready' : 'empty',
      completeness: reasons.length ? 'partial' : 'complete', reasonCodes: reasons,
    };
  } catch (error) {
    source = { status: 'unavailable', completeness: 'partial', reasonCodes: [error?.code || 'SOURCE_UNAVAILABLE'] };
  }
  collectionPhase = 'workspace';
  // The worker is a read-only collector. Main remains the sole process allowed
  // to persist an atomic v1 -> v2 migration, avoiding two concurrent writers.
  const workspace = projectService.loadWorkspace(rootPath, { migrate: false });
  collectionPhase = 'response';
  parentPort.postMessage({ ok: true, data: {
    inventory, fileTimes, graph, graphReasons, source,
    workspace,
  } });
} catch (error) {
  // Phase labels are fixed diagnostics; never serialize stack traces, paths,
  // file content or arbitrary provider text across this Worker boundary.
  parentPort.postMessage({
    ok: false,
    error: {
      code: error?.code || 'DAILY_WORKSPACE_FAILED',
      message: `工作区数据采集失败（${collectionPhase}）`,
    },
  });
}
