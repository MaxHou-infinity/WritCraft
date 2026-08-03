'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'daily-workspace-view.js'), 'utf8');
const workspace = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'workspace.js'), 'utf8');
const homeView = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'project-home-view.js'), 'utf8');
const changesView = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'changes-view.js'), 'utf8');
const channels = [
  'writcraft:project:get-daily-workspace',
  'writcraft:project:list-workspace-locations',
  'writcraft:project:list-current-outline',
  'writcraft:project:resolve-workspace-location',
  'writcraft:project:resolve-stable-workspace-location',
  'writcraft:project:hydrate-pending-review',
  'writcraft:project:apply-pending-review',
  'writcraft:project:discard-pending-review',
];
for (const channel of channels) {
  assert.strictEqual((main.match(new RegExp(channel, 'g')) || []).length, 1, `${channel} Main handler missing or duplicated`);
  assert.strictEqual((preload.match(new RegExp(channel, 'g')) || []).length, 1, `${channel} preload bridge missing or duplicated`);
}
assert(preload.includes('dailyWorkspace: Object.freeze({'));
assert(!preload.includes('rootPath => ipcRenderer.invoke'));
assert(html.includes('id="current-outline-list"'));
assert(html.includes('id="quick-open-dialog"'));
assert(html.includes('id="narrow-outline-toggle"'));
assert(html.includes('id="project-home-view"'));
assert(html.includes('data-workspace-view="home"'));
assert(html.indexOf('daily-workspace-state.js') < html.indexOf('daily-workspace-view.js'));
assert(html.indexOf('workspace.js') < html.indexOf('daily-workspace-view.js'));
assert(view.includes("addEventListener('compositionstart'"));
assert(view.includes("addEventListener('compositionend'"));
assert(view.includes("addEventListener('writcraft:project-entering'"));
assert(view.includes("addEventListener('writcraft:current-file-authority-changed'"));
assert(workspace.includes("status: 'saved'"));
assert(workspace.includes("status: 'conflict'"));
assert(workspace.includes("status: 'missing'"));
assert.match(workspace, /function beginProjectEntry\(\)[\s\S]*externalChangeSequence \+= 1/);
assert.match(workspace, /await refreshTree\(owner\)[\s\S]*!owner\.isCurrent\(\)/);
assert.match(workspace, /await bridge\.readFile\(path\)[\s\S]*!owner\.isCurrent\(\)/);
assert(view.includes("workspaceState?.dirty || workspaceState?.conflictRecovery"));
assert(!view.includes("exec(item.breadcrumb"));
assert(homeView.includes('resolveStableLocation(active.instanceId, locator)'));
assert(homeView.includes("writcraft:open-pending-review"));
assert(homeView.includes('savedPosition.revision === target.revision'));
assert(homeView.includes('snapshot.continueLocation'));
assert(homeView.includes('状态只描述空白、骨架或已有正文，不判断是否完成'));
assert(homeView.includes("view.setAttribute('aria-busy', 'false')"));
assert(html.includes('id="project-home-back"'));
assert(html.includes('id="project-home-refresh"'));
assert(!homeView.includes('fetch('));
assert(changesView.includes('let pendingHydrationSequence = 0'));
assert(changesView.includes('hydrationOwner.sequence === pendingHydrationSequence'));
assert(changesView.includes("if (!discarded?.ok)"));
assert(changesView.includes('discardOwner === pendingDiscardSequence && pending === activePending'));
console.log('verify-v0-daily-workspace-wiring: ok');
