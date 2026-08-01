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
const navigationCss = fs.readFileSync(path.join(root, 'src/renderer/writing-navigation.css'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function contrastRatio(left, right) {
  const luminance = value => {
    const channels = value.match(/[a-f0-9]{2}/gi).map(part => parseInt(part, 16) / 255)
      .map(channel => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

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

check('suggestion actions use one compact editorial toolbar treatment', () => {
  assert.match(navigationCss, /\.writing-navigation__action-row \{[\s\S]*?flex-wrap: wrap;[\s\S]*?gap: 6px;/);
  assert.match(navigationCss, /\.writing-navigation__action-row \.writing-navigation__primary,[\s\S]*?min-height: 28px;[\s\S]*?padding: 4px 9px;[\s\S]*?border-radius: 999px;[\s\S]*?font-size: 11px;/);
  assert.match(navigationCss, /\.writing-navigation__action-row button:disabled \{[\s\S]*?opacity: 1;/);
  const primary = navigationCss.match(
    /\.writing-navigation__action-row \.writing-navigation__primary \{[\s\S]*?background: (#[a-f0-9]{6});/i
  );
  assert(primary, 'compact primary action background is missing');
  assert(contrastRatio(primary[1], '#ffffff') >= 4.5, 'compact primary action text contrast is too low');
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
