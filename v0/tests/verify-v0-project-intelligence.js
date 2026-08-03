#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
const workspace = fs.readFileSync(path.join(V0, 'src/renderer/workspace.js'), 'utf8');
const searchView = fs.readFileSync(path.join(V0, 'src/renderer/search-view.js'), 'utf8');
const graphView = fs.readFileSync(path.join(V0, 'src/renderer/graph-view.js'), 'utf8');
const editor = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf8');
const changesView = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
const sourcesView = fs.readFileSync(path.join(V0, 'src/renderer/sources-view.js'), 'utf8');
const projectChanges = fs.readFileSync(path.join(V0, 'src/main/project-changes-proposal-service.js'), 'utf8');
const changesHistoryHandler = fs.readFileSync(path.join(V0, 'src/main/changes-history-handler.js'), 'utf8');
let pass = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); pass += 1; }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

console.log('════════ WritCraft V0 · Project intelligence integration ════════');
check('Main 集成 ChangeSet 与一致性引擎', () => {
  assert.ok(main.includes("require('./changeset-service')"));
  assert.ok(main.includes("require('./graph-index-service')"));
  assert.ok(main.includes("require('./source-index-service')"));
});
check('跨文件修改具有 propose/apply/discard 三阶段 IPC', () => {
  for (const route of ['propose-changes', 'apply-changes', 'discard-changes']) {
    assert.ok(main.includes(`ipcMain.handle('writcraft:project:${route}'`));
  }
  assert.ok(main.includes('projectChangesProposalService.finalizeProjectChangesProposal'));
  assert.ok(main.includes('projectDependencies: prepared.dependencies'));
  assert.ok(main.includes('changesHistoryHandler.applyChanges(projectInstanceId, decision)'));
  assert.ok(changesHistoryHandler.includes('transaction.review({'));
  assert.ok(main.includes('pending.rootPath !== project.rootPath'));
  assert.ok(main.includes("require('./pending-changeset-store')"));
  assert.ok(main.includes('pendingChangeSets.putWithCapability(capability, changeSet, project.rootPath, metadata)'));
  assert.ok(main.includes('currentProject.rootPath !== project.rootPath'));
  assert.ok(main.includes('pendingChangeSets.clear()'));
  assert.ok(changesView.includes("if (!saved) return setStatus('当前文件未能保存，已停止应用'"));
});
check('章节 Composer 只生成当前文件的可审阅 ChangeSet', () => {
  assert.ok(main.includes("ipcMain.handle('writcraft:project:propose-chapter'"));
  assert.ok(preload.includes('proposeChapter:'));
  assert.ok(html.includes('id="changes-chapter"'));
  assert.ok(changesView.includes('async function proposeChapter'));
  assert.ok(changesView.includes("schema: 'writcraft.chapter-generation-request/v1'"));
  assert.ok(changesView.includes('bridge.proposeChapter(metric.originProjectInstanceId, chapterSession.request)'));
});
check('AI 只能修改 Main 生成快照中的公开 Markdown', () => {
  assert.ok(projectChanges.includes('validateRequest(request, available)'));
  assert.ok(projectChanges.includes('isReservedReadonlyPath(targetPath)'));
  assert.ok(projectChanges.includes('localizedEditService.validateAuthorizedSnapshots'));
  assert.ok(projectChanges.includes('if (totalBytes > MAX_CONTEXT_BYTES)'));
});
check('一致性星图由项目权威文件快照生成', () => {
  assert.ok(main.includes("ipcMain.handle('writcraft:project:build-graph'"));
  assert.ok(main.includes('graphIndexService.indexProjectGraph(projectService, project.rootPath)'));
  assert.ok(main.includes('analyzedPaths: indexed.analyzedPaths'));
});
check('Preload 仅暴露固定智能项目方法', () => {
  for (const method of ['proposeChanges:', 'applyChanges:', 'discardChanges:', 'buildGraph:', 'buildSourceIndex:']) {
    assert.ok(preload.includes(method), `缺少 ${method}`);
  }
});
check('来源视图使用 Main 本地索引并可跳转证据', () => {
  assert.ok(main.includes("ipcMain.handle('writcraft:project:build-source-index'"));
  assert.ok(html.includes('id="sidebar-sources-view"'));
  assert.ok(html.includes('sources-view.js'));
});
check('来源可按 APA7、MLA9、Chicago17 插入 Markdown 脚注', () => {
  assert.ok(html.includes('citation-formatter.js'));
  assert.ok(html.includes('id="source-citation-style"'));
  assert.ok(sourcesView.includes("cite.textContent = '插入脚注'"));
  assert.ok(workspace.includes('async function insertSourceCitation'));
  assert.ok(editor.includes('insertCitation,'));
});
check('外部文件变化通过窄订阅接口触发权威重读', () => {
  assert.ok(main.includes("require('./project-watcher')"));
  assert.ok(main.includes("webContents.send('writcraft:project:external-change'"));
  assert.ok(preload.includes('onExternalChange:'));
  assert.ok(preload.includes("ipcRenderer.removeListener('writcraft:project:external-change', listener)"));
});
check('缺失 edit.md 的普通 Markdown 目录可进入受限写作模式', () => {
  assert.ok(main.includes(
    'const project = attachPrivateProjectRootIdentity(projectService.openProject(rootPath))'
  ));
  assert.ok(main.includes('await markdownTrashService.bindProject(project)'));
  assert.ok(main.includes('projectPromptMissing: promptMissing'));
  assert.ok(main.includes("ipcMain.handle('writcraft:project:create-prompt'"));
  assert.ok(workspace.includes('projectPromptMissing'));
  assert.ok(workspace.includes('暂不创建，继续写作'));
  assert.ok(workspace.includes('canUseAI'));
});
check('Renderer 有独立 Changes 审阅与星图视图', () => {
  for (const id of ['changes-panel', 'changes-preview', 'graph-view', 'consistency-graph', 'issue-list']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.ok(html.includes('changes-view.js'));
  assert.ok(html.includes('graph-view.js'));
});
check('Changes 历史可列出并执行 revision 安全撤销', () => {
  assert.ok(main.includes("ipcMain.handle('writcraft:project:list-change-history'"));
  assert.ok(main.includes("ipcMain.handle('writcraft:project:undo-change'"));
  assert.ok(preload.includes('listChangeHistory:'));
  assert.ok(preload.includes('undoChange:'));
  assert.ok(html.includes('id="changes-history-list"'));
  assert.ok(changesView.includes('async function undoHistory'));
  assert.ok(changesView.includes('await window.__workspace.persistCurrent(true)'));
  assert.ok(changesView.includes("if (!saved) return setStatus('当前文件未能保存，已停止撤销'"));
});
check('星图支持类型筛选并可回到精确原文证据', () => {
  assert.ok(html.includes('id="graph-filter"'));
  assert.ok(graphView.includes('function visibleNodes()'));
  assert.ok(graphView.includes('window.__workspace?.openFile?.(evidence.path)'));
  assert.ok(graphView.includes('window.__workspace?.revealRange?.(start'));
});
check('一致性问题状态可审阅并通过受限 IPC 持久化', () => {
  assert.ok(main.includes("ipcMain.handle('writcraft:project:set-issue-status'"));
  assert.ok(preload.includes('setIssueStatus: (projectInstanceId, issueId, status)'));
  assert.ok(html.includes('id="issue-filter"'));
  assert.ok(graphView.includes('bridge?.setIssueStatus?.(window.__workspace?.state?.project?.instanceId, issue.id, status)'));
});
check('六类显式引用与选段由 Main 权威解析并绑定到 AI 回复', () => {
  assert.ok(html.includes('../shared/context-selection.js'));
  assert.ok(html.includes('../shared/block-anchor.js'));
  assert.ok(html.includes('id="chat-context-chips"'));
  assert.ok(main.includes("require('./context-resolver-service')"));
  assert.ok(main.includes("ipcMain.handle('writcraft:project:resolve-context'"));
  assert.ok(main.includes('contextResolverService.resolveProjectContext'));
  assert.ok(preload.includes('resolveContext:'));
  assert.ok(workspace.includes('async function resolveContextSelections'));
  assert.ok(workspace.includes('bridge.resolveContext(originProjectInstanceId, contextRequest)'));
  assert.ok(workspace.includes('isChatRequestCurrent(chatGuard, contextRequest)'));
  assert.ok(editor.includes('resolveContextSelections?.(contextRequest, chatGuard)'));
  assert.ok(editor.includes('renderContextChips(selectedContext?.chips || [], {'));
  assert.ok(editor.includes('currentFilePath: window.__workspace.getCurrentPath'));
  assert.ok(editor.includes('manifestChips(result.contextManifest)'));
  assert.ok(editor.includes('bindResponseContext(response, actualChips)'));
  assert.ok(workspace.includes('window.WritCraftBlockAnchor.resolveBlockAnchor'));
  assert.ok(workspace.includes('async function revealContextChip'));
});
check('项目搜索由 Main 权威快照驱动并可跳转正文证据', () => {
  assert.ok(main.includes("require('./project-search-service')"));
  assert.ok(main.includes("ipcMain.handle('writcraft:project:search'"));
  assert.ok(main.includes('searchProject(projectService, project.rootPath, query)'));
  assert.ok(preload.includes('search: (query)'));
  assert.ok(html.includes('id="project-search-results"'));
  assert.ok(searchView.includes('window.__workspace?.revealRange?.(item.offset, item.length)'));
});
check('旧 Prompt 与 localStorage 草稿都经过预览确认迁移', () => {
  for (const route of ['confirm-legacy-edit', 'preview-legacy-draft', 'confirm-legacy-draft']) {
    assert.ok(main.includes(`ipcMain.handle('writcraft:project:${route}'`));
  }
  assert.ok(html.includes('id="migration-dialog"'));
  assert.ok(workspace.includes('window.__legacyDraft.inspect(raw, document)'));
  assert.ok(workspace.includes('await bridge.confirmLegacyDraft(planned.token)'));
  assert.ok(workspace.includes('原始备份仍保留'));
});

if (!process.exitCode) console.log(`\n✅ 项目智能集成检查 ${pass}/${pass} 全过`);
