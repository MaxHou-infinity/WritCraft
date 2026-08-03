#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const scope = require('../src/renderer/project-changes-scope');

const V0 = path.join(__dirname, '..');
const view = fs.readFileSync(path.join(V0, 'src/renderer/changes-view.js'), 'utf8');
const html = fs.readFileSync(path.join(V0, 'src/renderer/index.html'), 'utf8');
const preload = fs.readFileSync(path.join(V0, 'src/main/preload.js'), 'utf8');
const main = fs.readFileSync(path.join(V0, 'src/main/main.js'), 'utf8');
const changesHistoryHandler = fs.readFileSync(
  path.join(V0, 'src/main/changes-history-handler.js'),
  'utf8'
);
let passed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}: ${error.stack || error.message}`); process.exitCode = 1; }
}

const tree = [
  { type: 'file', path: 'edit.md' },
  { type: 'file', path: 'root.md' },
  { type: 'file', path: '.hidden.md' },
  { type: 'file', path: 'not.txt' },
  { type: 'directory', path: 'chapters', children: [
    { type: 'file', path: 'chapters/a.md' },
    { type: 'file', path: 'chapters/b.markdown' },
    { type: 'file', path: 'chapters/.private.md' },
  ] },
  { type: 'directory', path: 'references', children: [{ type: 'file', path: 'references/r.md' }] },
  { type: 'directory', path: 'sources', children: [{ type: 'file', path: 'sources/s.md' }] },
  { type: 'symlink', path: 'linked.md' },
];

console.log('\nProject Changes scope verification');

test('可修改选择器只列公开正文，排除 Prompt、来源、隐藏与非 Markdown', () => {
  assert.deepStrictEqual(scope.availableTargetPaths(tree), [
    'chapters/a.md', 'chapters/b.markdown', 'root.md',
  ]);
});

test('首次打开默认当前正文，上限 8 且允许用户明确取消全部', () => {
  const available = Array.from({ length: 10 }, (_, index) => `c/${index}.md`);
  assert.deepStrictEqual(scope.reconcileTargets([], available, 'c/3.md', true), ['c/3.md']);
  let selected = [];
  for (const filePath of available.slice(0, 8)) selected = scope.updateTargets(selected, filePath, true, available).selected;
  const ninth = scope.updateTargets(selected, available[8], true, available);
  assert.strictEqual(ninth.ok, false);
  assert.strictEqual(ninth.error, 'TARGET_LIMIT');
  assert.strictEqual(scope.updateTargets(['c/3.md'], 'c/3.md', false, available).selected.length, 0);
  assert(view.includes('targetSelectionTouched = true'));
  assert.match(view, /targetSelectionTouched\s*\? helper\.reconcileTargets[\s\S]*?false\)[\s\S]*?: helper\.reconcileTargets\(\[\], availableTargetPaths, currentPath, true\)/);
});

test('Renderer 建立 exact request，target 与 context 重叠时 target 优先', () => {
  const request = scope.createRequest('  修改术语 \n', ['chapters/a.md'], ['references/r.md', 'chapters/a.md']);
  assert.deepStrictEqual(request, {
    schema: 'writcraft.project-changes-request/v1',
    instruction: '修改术语',
    targetPaths: ['chapters/a.md'],
    contextPaths: ['references/r.md'],
  });
  assert.strictEqual(scope.createRequest('指令', [], []), null);
  assert.strictEqual(scope.createRequest('指令', ['edit.md'], []), null);
});

test('范围确认仅在 instruction/targets/context 完全一致时有效', () => {
  const before = scope.createRequest('修改', ['a.md', 'b.md'], ['references/r.md']);
  assert.strictEqual(scope.sameRequest(before, scope.createRequest('修改', ['a.md', 'b.md'], ['references/r.md'])), true);
  assert.strictEqual(scope.sameRequest(before, scope.createRequest('修改了', ['a.md', 'b.md'], ['references/r.md'])), false);
  assert.strictEqual(scope.sameRequest(before, scope.createRequest('修改', ['b.md', 'a.md'], ['references/r.md'])), false);
  assert.strictEqual(scope.sameRequest(before, scope.createRequest('修改', ['a.md', 'b.md'], [])), false);
});

test('Main response capability、review 与 provenance 必须精确绑定已确认范围', () => {
  const request = scope.createRequest('统一术语', ['chapters/a.md', 'chapters/b.md'], ['references/r.md']);
  const revision = 'a'.repeat(64);
  const base = {
    ok: true, noChanges: false, changeSetId: 'capability-1', fileCount: 2,
    review: { changeSetId: 'capability-1', files: [{ path: 'chapters/a.md' }, { path: 'chapters/b.md' }] },
    provenance: {
      schema: scope.REQUEST_SCHEMA, kind: 'project_changes',
      targets: request.targetPaths.map(filePath => ({ path: filePath, revision })),
      context: [
        { path: 'edit.md', revision, role: 'project_prompt' },
        { path: 'references/r.md', revision, role: 'context' },
      ],
    },
  };
  assert.strictEqual(scope.responseMatchesRequest(base, request), true);
  assert.strictEqual(scope.responseMatchesRequest({ ...base, changeSetId: 'other' }, request), false);
  assert.strictEqual(scope.responseMatchesRequest({ ...base, provenance: { ...base.provenance, kind: 'plan' } }, request), false);
  assert.strictEqual(scope.responseMatchesRequest({ ...base, review: { ...base.review, files: [{ path: 'outside.md' }] }, fileCount: 1 }, request), false);
  const noChanges = { ...base, noChanges: true, fileCount: 0, review: undefined, changeSetId: undefined };
  assert.strictEqual(scope.responseMatchesRequest(noChanges, request), true);
  assert.strictEqual(scope.responseMatchesRequest({ ...noChanges, changeSetId: 'leaked' }, request), false);
});

test('页面明确分开可修改目标和只读附加上下文', () => {
  for (const id of ['project-changes-target-picker', 'project-changes-target-count', 'project-changes-target-list',
    'composer-context-picker', 'composer-context-count', 'composer-context-list']) {
    assert(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert(html.includes('只有在这里明确勾选的正文才可被修改'));
  assert(html.includes('这些文件只用于理解，不会被修改'));
  assert(html.indexOf('project-changes-scope.js') < html.indexOf('changes-view.js'));
});

test('第一次点击只展示本地权威范围，第二次才调用 Main', () => {
  const start = view.indexOf('async function propose()');
  const end = view.indexOf('function researchSessionCurrent(', start);
  const propose = view.slice(start, end);
  assert(propose.includes('renderNormalScopePlan(request)'));
  assert(propose.includes('return { ok: true, scopePlanned: true }'));
  assert(propose.includes('window.WritCraftProjectChangesScope.sameRequest(normalScopePlan, request)'));
  assert(propose.indexOf('renderNormalScopePlan(request)') < propose.indexOf('bridge.proposeChanges(metric.originProjectInstanceId, request)'));
  assert(view.includes("normalScopePlan ? '确认范围并生成 Diff' : '跨文件修改'"));
});

test('指令、选择、项目、当前文件和文件生命周期均使范围计划失效', () => {
  assert(view.includes("instruction?.addEventListener('input'"));
  assert((view.match(/invalidateNormalScopePlan\(/g) || []).length >= 7);
  assert.match(view, /document\.addEventListener\('writcraft:project-entered',[\s\S]*?normalScopePlan = null/);
  assert.match(view, /document\.addEventListener\('writcraft:tree-changed',[\s\S]*?invalidateNormalScopePlan/);
  assert.match(view, /document\.addEventListener\('writcraft:current-file-changed',[\s\S]*?invalidateNormalScopePlan/);
  assert(view.includes("document.addEventListener('writcraft:file-lifecycle-changed', invalidatePendingForFileLifecycle)"));
});

test('IPC 仅传递 exact request，Main 生成后与 apply 前都重验只读依赖', () => {
  assert(preload.includes("proposeChanges: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:propose-changes', projectInstanceId, request)"));
  const route = main.slice(main.indexOf("ipcMain.handle('writcraft:project:propose-changes'"),
    main.indexOf("ipcMain.handle('writcraft:project:apply-changes'"));
  assert(route.includes('prepareProjectChangesProposal'));
  assert(route.includes('minimaxTextService.MAX_MAX_TOKENS'));
  assert(route.includes('validateProjectDependencies'));
  assert(route.includes('if (result.noChanges) return result;'));
  assert(route.indexOf('if (result.noChanges) return result;') < route.indexOf('cacheReviewedChangeSet'));
  const validation = main.slice(main.indexOf('function validateOrdinaryChangesDependencies'),
    main.indexOf('\nfunction terminateOrdinaryChangesAuthority'));
  assert(validation.includes('if (pending.projectDependencies)'));
  assert(validation.includes('projectChangesProposalService.validateProjectDependencies'));
  assert(changesHistoryHandler.indexOf('validateDependencies({') <
    changesHistoryHandler.indexOf('transaction.review({'));
  assert(main.includes('validateDependencies: validateOrdinaryChangesDependencies'));
});

if (!process.exitCode) console.log(`\nProject Changes scope ${passed}/${passed} passed.`);
