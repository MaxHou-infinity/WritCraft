'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const dock = fs.readFileSync(path.join(root, 'src/renderer/assistant-dock.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'src/renderer/assistant-workspace.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

console.log('\nWriting navigation public surface verification');

check('Main no longer loads or registers the superseded Plan authority', () => {
  for (const token of [
    "require('./project-plan-service')",
    "require('./project-plan-handler')",
    "require('./project-plan-handoff-service')",
    'pendingPlanRecords',
    'planDependencies',
    'ProjectPlanError',
    'ProjectPlanHandoffError',
    "'writcraft:project:propose-plan'",
    "'writcraft:project:handoff-plan-task'",
  ]) {
    assert(!main.includes(token), `Main still exposes legacy Plan token: ${token}`);
  }
});

check('preload exposes no superseded Plan bridge', () => {
  for (const token of [
    'proposePlan:',
    'handoffPlanTask:',
    "'writcraft:project:propose-plan'",
    "'writcraft:project:handoff-plan-task'",
  ]) {
    assert(!preload.includes(token), `preload still exposes legacy Plan token: ${token}`);
  }
});

check('Renderer exposes one Navigation workflow and loads no legacy Plan assets', () => {
  assert(html.includes('data-assistant-mode="navigation"'));
  assert(html.includes('data-assistant-panel="navigation"'));
  assert(html.includes('writing-navigation-state.js'));
  assert(html.includes('writing-navigation-view.js'));
  for (const token of [
    'data-assistant-mode="plan"',
    'data-assistant-panel="plan"',
    'plan-mode.css',
    'plan-mode-state.js',
    'plan-mode-view.js',
    'plan-handoff-transaction.js',
    'id="plan-goal"',
    'id="plan-generate"',
  ]) {
    assert(!html.includes(token), `Renderer still exposes legacy Plan token: ${token}`);
  }
  assert(!dock.includes("'plan'"), 'Assistant Dock still registers Plan mode');
  assert(!workspace.includes('proposePlan'), 'Assistant workspace still calls legacy Plan');
  assert(!workspace.includes('openPlanTask'), 'Assistant workspace still routes legacy Plan');
});

check('active verification chains exclude legacy Plan while historical Main evidence stays isolated', () => {
  const scripts = packageJson.scripts || {};
  assert.strictEqual(scripts['verify:plan'], undefined);
  const historical = scripts['verify:plan:historical'];
  assert.strictEqual(typeof historical, 'string');
  assert(historical.includes('verify-v0-project-plan.js'));
  assert(!historical.includes('verify-v0-plan-handoff.js'));
  assert(!historical.includes('verify-v0-plan-handoff-transaction.js'));
  assert(!historical.includes('verify-v0-plan-mode-ui.js'));
  assert(!historical.includes('verify-v0-assistant-integration.js'));

  for (const name of ['pretest', 'preverify', 'test', 'verify', 'posttest', 'postverify']) {
    const command = scripts[name] || '';
    for (const token of [
      'verify:plan',
      'verify-v0-project-plan.js',
      'verify-v0-plan-handoff.js',
      'verify-v0-plan-handoff-transaction.js',
      'verify-v0-plan-mode-ui.js',
      'verify-v0-assistant-integration.js',
    ]) {
      assert(!command.includes(token), `${name} still invokes legacy Plan evidence: ${token}`);
    }
  }
});

console.log(`\n${passed}/${passed} writing-navigation public surface checks passed.`);
