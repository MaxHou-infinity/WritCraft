#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const V0 = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
const workspace = fs.readFileSync(path.join(V0, 'src/renderer/workspace.js'), 'utf8');
const editor = fs.readFileSync(path.join(V0, 'src/renderer/editor.js'), 'utf8');
const graphView = fs.readFileSync(path.join(V0, 'src/renderer/graph-view.js'), 'utf8');
const changesView = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
const searchView = fs.readFileSync(path.join(V0, 'src/renderer/search-view.js'), 'utf8');
let pass = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('════════ WritCraft V0 · Project workspace verify ════════');

check('页面具备项目导航、中央编辑器与 AI 三栏骨架', () => {
  for (const id of ['project-tree', 'work-area', 'editor', 'chat-panel']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
});
check('项目入口同时存在于侧栏与欢迎页', () => {
  for (const id of ['sidebar-create-project', 'sidebar-open-project', 'welcome-create-project', 'welcome-open-project']) {
    assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
  }
  assert.ok(workspace.includes("document.getElementById('welcome-create-project')"));
  assert.ok(workspace.includes("document.getElementById('welcome-open-project')"));
});
check('具备文件树、多标签和新建 Markdown 文件入口', () => {
  assert.ok(html.includes('id="tab-bar"'));
  assert.ok(html.includes('id="new-file-button"'));
  assert.ok(html.includes('id="file-dialog"'));
});
check('edit.md 被定义为项目启动上下文', () => {
  assert.ok(html.includes('每个 WritCraft 项目都从一个可见的 edit.md 开始'));
  assert.ok(workspace.includes("state.projectPromptMissing ? markdownPaths()[0] || '' : 'edit.md'"));
  assert.ok(workspace.includes('await openFile(initialPath)'));
  assert.ok(workspace.includes("bridge.getContext"));
  assert.ok(workspace.includes('bridge?.createProjectPrompt'));
  assert.ok(workspace.includes('state.editContextRevision.slice(0, 7)'));
});
check('工作台只通过 preload 的 project bridge 访问文件', () => {
  assert.ok(workspace.includes('window.writCraft && window.writCraft.project'));
  assert.ok(!/require\s*\(/.test(workspace));
  assert.ok(!workspace.includes('node:fs'));
});
check('切换文件前先保存当前文件', () => {
  const saveIndex = workspace.indexOf('await persistCurrent(true)', workspace.indexOf('async function openFile'));
  const readIndex = workspace.indexOf('bridge.readFile(path)', workspace.indexOf('async function openFile'));
  assert.ok(saveIndex > 0 && readIndex > saveIndex);
});
check('切换项目先结算 Onboarding 审阅与指标，再释放图片预览', () => {
  for (const name of ['createProject', 'openProject']) {
    const start = workspace.indexOf(`async function ${name}`);
    const end = workspace.indexOf('\n  async function ', start + 1);
    const body = workspace.slice(start, end > start ? end : undefined);
    const changesIndex = body.indexOf('await window.__changesView.discardPending()');
    const imageIndex = body.indexOf('await window.__imageGenerationView?.discardPending?.()');
    const projectCall = body.indexOf(name === 'createProject' ? 'await bridge.create(name)' : 'await bridge.open()');
    assert.ok(changesIndex >= 0 && imageIndex > changesIndex && projectCall > imageIndex,
      `${name} must settle Changes metrics and image preview before switching Main project`);
  }
  assert.ok(changesView.includes('async function discardPending()'));
  assert.ok(changesView.includes('await settleOnboardingMetric'));
});
check('项目文件输入采用防抖保存并支持 Cmd/Ctrl+S', () => {
  assert.ok(workspace.includes('setTimeout(() => persistCurrent(false), 500)'));
  assert.ok(workspace.includes("event.key.toLowerCase() === 's'"));
  assert.ok(workspace.includes('bridge.writeFile(path, content, revision)'));
  assert.ok(workspace.includes('state.editVersion'));
  assert.ok(workspace.includes('state.savePromise'));
});
check('项目 Chat 只上送结构化请求，独立文档上下文与段落改写保持受限', () => {
  assert.ok(editor.includes('window.__workspace.getAIContext()'));
  assert.ok(editor.includes('window.writCraft.rewrite(entry.intent.projectInstanceId, request)'));
  assert.ok(editor.includes('rewriteTransaction.createRequest(prepared.binding)'));
  assert.ok(editor.includes('compactBlockProof'));
  assert.ok(!editor.includes("window.writCraft.rewrite(aiGuard?.projectInstanceId || null, entry.original"));
  assert.ok(editor.includes('contextRequest = chatContextState.createRequest'));
  assert.ok(editor.includes('[projectContext, standaloneDocumentContext]'));
  assert.ok(editor.includes('window.writCraft.chat(aiGuard?.projectInstanceId || null, userMessage, context, contextRequest)'));
});
check('项目模式禁用旧 localStorage 草稿作为真源', () => {
  assert.ok(editor.includes('if (projectManaged) return'));
  assert.ok(editor.includes('setProjectManaged(value)'));
  assert.ok(editor.includes('loadDocument(content)'));
});
check('Inline Rewrite 接受只走 Main apply 与权威重载', () => {
  assert.ok(editor.includes('window.writCraft.applyRewrite'));
  assert.ok(editor.includes('completeInlineRewriteCommit'));
  const acceptBody = editor.slice(editor.indexOf('async function acceptRewrite()'), editor.indexOf('function cancelActiveRewriteForDocumentLoad'));
  assert.ok(!acceptBody.includes('dispatchEvent'));
  assert.ok(!acceptBody.includes('replaceWith(document.createTextNode'));
});
check('项目稿有同步 recovery 快照并按 revision 恢复', () => {
  assert.ok(workspace.includes('writcraft:recovery:'));
  assert.ok(workspace.includes('state.project.instanceId'));
  assert.ok(workspace.includes('conflict: recovery.revision !== diskRevision'));
  assert.ok(workspace.includes('请选择保留本地稿或使用磁盘版本'));
  assert.ok(workspace.includes('bridge?.writeRecovery?.(path, content, revision || null)'));
  assert.ok(workspace.includes('bridge?.overwriteConflict?.(path, content, state.conflictRevision)'));
  assert.ok(workspace.includes('if (state.conflictRecovery)'));
  assert.ok(workspace.includes("document.getElementById('conflict-keep-local')"));
  assert.ok(workspace.includes("document.getElementById('conflict-use-disk')"));
  assert.ok(workspace.includes('saveRecovery()'));
});
check('活动栏预留一致性星图并明确下一阶段状态', () => {
  assert.ok(html.includes('data-view="graph"'));
  assert.ok(html.includes('id="consistency-graph"'));
  assert.ok(graphView.includes('bridge.buildGraph(projectInstanceId)'));
  assert.ok(graphView.includes('await window.__workspace.persistCurrent(true)'));
  assert.ok(graphView.includes('evidenceFor(item)'));
});
check('跨文件 Changes 必须先预览再按修改块决定应用', () => {
  assert.ok(html.includes('id="changes-preview"'));
  assert.ok(changesView.includes('renderNormalScopePlan(request)'));
  assert.ok(changesView.includes('bridge.proposeChanges(metric.originProjectInstanceId, request)'));
  assert.ok(changesView.includes('bridge.applyChanges(projectInstanceId, decision)'));
  assert.ok(changesView.includes('await window.__workspace.persistCurrent(true)'));
});
check('工作区恢复标签、光标和滚动位置', () => {
  assert.ok(workspace.includes('bridge.loadWorkspace()'));
  assert.ok(workspace.includes('bridge.saveWorkspace(workspaceSnapshot())'));
  assert.ok(workspace.includes('cursorOffset'));
  assert.ok(workspace.includes('scrollTop'));
  assert.ok(workspace.includes('bridge.openRecent()'));
});
check('外部变化先比较权威 revision，再自动重载或进入冲突恢复', () => {
  assert.ok(workspace.includes('bridge?.onExternalChange'));
  assert.ok(workspace.includes('await bridge.readFile(path)'));
  assert.ok(workspace.includes('const currentRevisionChanged = result.revision !== state.revision'));
  assert.ok(workspace.includes('if (!currentRevisionChanged) return'));
  assert.ok(workspace.includes("state.externalDeleted = true"));
  assert.ok(workspace.includes('closeExternallyDeletedTab'));
  assert.ok(workspace.includes("changeTouchesPath(payload, 'edit.md')"));
  assert.ok(workspace.includes('state.editContextRevision = result.revision'));
  assert.ok(workspace.includes('AI 操作已暂停'));
  assert.ok(workspace.includes("'writcraft:graph-source-changed'"));
  assert.ok(workspace.includes('graphChangedPaths'));
  assert.ok(workspace.includes(".slice(0, 100)"));
});
check('删除文件恢复稿有显式 manifest、跨重启入口和丢弃动作', () => {
  assert.ok(workspace.includes('writcraft:recovery-manifest:'));
  assert.ok(workspace.includes('maybeOfferOrphanRecovery'));
  assert.ok(workspace.includes("action === 'discard'"));
  assert.ok(workspace.includes("bridge.confirmLegacyDraft(planned.token)"));
  assert.ok(html.includes('id="migration-discard"'));
});
check('页面采用无网络脚本依赖并遵守 CSP', () => {
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
});
check('全文搜索是可交互侧栏而非下一阶段占位', () => {
  assert.ok(html.includes('id="sidebar-search-view"'));
  assert.ok(html.includes('id="project-search-input"'));
  assert.ok(html.includes('search-view.js'));
  assert.ok(searchView.includes('bridge.search(query)'));
  assert.ok(!workspace.includes('全文搜索将在下一阶段开放'));
});

if (!process.exitCode) console.log(`\n✅ 项目工作台结构/集成检查 ${pass}/${pass} 全过`);
