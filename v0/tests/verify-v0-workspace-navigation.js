#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const html = read('src/renderer/index.html');
const workspace = read('src/renderer/workspace.js');
const graph = read('src/renderer/graph-view.js');
const search = read('src/renderer/search-view.js');
const sources = read('src/renderer/sources-view.js');
let passed = 0;

function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('\nWorkspace navigation ownership verification');

check('four project workspaces have one semantic activity route each', () => {
  for (const view of ['explorer', 'search', 'sources', 'graph']) {
    assert.strictEqual((html.match(new RegExp(`<button[^>]+data-workspace-view="${view}"`, 'g')) || []).length, 1);
  }
  assert.strictEqual((html.match(/aria-current="page"/g) || []).length, 1);
  assert(html.includes('<svg viewBox="0 0 24 24" aria-hidden="true">'));
});

check('workspace owns every primary route transition and exact selected state', () => {
  assert(workspace.includes("const WORKSPACE_VIEWS = new Set(['explorer', 'search', 'sources', 'graph'])"));
  assert(workspace.includes("document.querySelectorAll('.activity-button[data-workspace-view]').forEach"));
  assert.strictEqual((workspace.match(/querySelectorAll\('\.activity-button\[data-workspace-view\]'\)/g) || []).length, 2);
  assert(workspace.includes("button.classList.toggle('is-active', selected)"));
  assert(workspace.includes("button.setAttribute('aria-current', 'page')"));
  assert(workspace.includes("button.removeAttribute('aria-current')"));
  assert(workspace.includes("appShell.dataset.workspaceView = name"));
});

check('secondary renderers expose lifecycle hooks instead of competing click owners', () => {
  assert(!search.includes("button?.addEventListener('click'"));
  assert(!sources.includes("button?.addEventListener('click'"));
  assert(!graph.includes("graphButton?.addEventListener('click'"));
  assert(search.includes('window.__searchView = { activate: openSearch }'));
  assert(sources.includes('window.__sourcesView = { activate: open, openWritingNavigation }'));
  assert(graph.includes('activate: activateGraph'));
  assert(graph.includes('deactivate: deactivateGraph'));
});

check('graph is a complete workspace rather than a source-sidebar hybrid', () => {
  assert(html.includes('.app-shell[data-workspace-view="graph"] .project-sidebar { display: none; }'));
  assert(workspace.includes("const sidebarVisible = name !== 'graph'"));
  assert(workspace.includes("if (name === 'graph') window.__graphView?.activate?.()"));
  assert(workspace.includes("else window.__graphView?.deactivate?.()"));
});

check('project creation is a low-frequency title menu and remains in the empty welcome state', () => {
  const headingStart = html.indexOf('<div class="project-heading">');
  const headingEnd = html.indexOf('</aside>', headingStart);
  const heading = html.slice(headingStart, headingEnd);
  assert(heading.includes('id="project-menu"'));
  assert(heading.includes('id="sidebar-create-project"'));
  assert(heading.includes('id="sidebar-open-project"'));
  assert(!html.includes('<div class="project-actions">'));
  assert(html.includes('id="welcome-create-project"'));
  assert(html.includes('id="welcome-open-project"'));
  assert(workspace.includes('projectMenu.open = false'));
  assert(workspace.includes("!event.target.closest?.('#project-menu')"));
  assert(workspace.includes("event.key !== 'Escape' || !projectMenu.open"));
});

console.log(`\n${passed}/${passed} workspace-navigation checks passed.`);
