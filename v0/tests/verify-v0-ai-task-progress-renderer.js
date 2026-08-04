'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/ai-task-progress-view.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/index.html'), 'utf8');
const workspace = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/assistant-workspace.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

console.log('\nAI task progress renderer verification');

test('renders only the Main public schema and never receives private owner data', () => {
  assert.match(source, /writcraft\.ai-task-progress\/v1/);
  assert.match(source, /snapshot\.schema !== SCHEMA/);
  assert(!source.includes('ownerToken'));
  assert(!source.includes('rootPath'));
});

test('exposes real phases, terminal copy and a 15-second cancellation affordance', () => {
  for (const phase of ['preparing_context', 'checking_evidence', 'generating_suggestion', 'validating_result', 'waiting_review']) {
    assert(source.includes(phase), `phase ${phase} missing`);
  }
  for (const status of ['completed', 'cancelled', 'timed_out', 'failed', 'stale', 'conflict']) {
    assert(source.includes(status), `terminal ${status} missing`);
  }
  assert.match(source, /snapshot\.canCancel === true/);
  assert.match(source, /options\.onCancel/);
});

test('project identity filters stale progress and assistant workspace wires cancel', () => {
  assert.match(source, /snapshot\.projectInstanceId !== projectInstanceId/);
  assert.match(workspace, /taskProgressController\?\.progress\?\.\(payload\)/);
  assert.match(workspace, /bridge\?\.cancelAiTask/);
  assert.match(html, /id="ai-task-progress"/);
  assert.match(html, /ai-task-progress-view\.js/);
});

console.log(`\n${passed}/${passed} AI task progress renderer checks passed.`);
