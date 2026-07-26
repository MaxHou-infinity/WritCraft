'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mainOnboarding = require('../src/main/project-onboarding-v2-service');
const view = require('../src/renderer/project-onboarding-view');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/project-onboarding-view.js'), 'utf8');
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

console.log('\nProject onboarding UI verification');

check('UI schema and question order match the authoritative Main v2 contract', () => {
  assert.strictEqual(view.REQUEST_SCHEMA, mainOnboarding.REQUEST_SCHEMA);
  assert.deepStrictEqual(view.QUESTIONS.map(question => question.id), [...mainOnboarding.QUESTION_ORDER]);
  assert.deepStrictEqual(
    [...view.STRUCTURED_OUTPUT_ERROR_CODES],
    [...mainOnboarding.STRUCTURED_OUTPUT_ERROR_CODES],
    'Renderer structured failure classification must stay synchronized with Main',
  );
});
check('uses DOM textContent and never injects project answers through innerHTML', () => {
  assert(source.includes('node.textContent = text'));
  assert(!source.includes('.innerHTML'));
});
check('renders a question, explicit skip path and final review before generation', () => {
  for (const marker of ['onboarding-question', '暂时跳过', '检查项目卡', '生成 edit.md 提案']) assert(source.includes(marker));
});
check('explains that generation creates a Diff and does not write directly', () => {
  assert(source.includes('只会生成 edit.md Diff 和初始文件建议'));
  assert(source.includes('逐项接受、拒绝'));
});
check('provides progress navigation, keyboard buttons and accessible current step', () => {
  assert(source.includes("setAttribute('aria-current', 'step')"));
  assert(source.includes("node.type = 'button'"));
  assert(source.includes('onboarding-marker'));
});
check('provides live status and focuses the active writing field', () => {
  assert(source.includes("setAttribute('aria-live', 'polite')"));
  assert(source.includes('textarea.focus()'));
});
check('can be dismissed without generating through a close button or Escape', () => {
  assert(source.includes("close.setAttribute('aria-label', '关闭项目卡')"));
  assert(source.includes("event.key === 'Escape'"));
  assert(source.includes('options.onCancel?.'));
});
check('submits only normalized state answers through the injected callback', () => {
  assert(source.includes('stateApi.submission(session)'));
  assert(source.includes('schema: REQUEST_SCHEMA'));
  assert(source.includes(".map(question => Object.freeze({ id: question.id, text:"));
  assert(source.includes('options.onGenerate?.(request'));
});
check('keeps answers after failure and exposes an explicit retry action', () => {
  assert(source.includes("generationFailed ? '重新整理 edit.md'"));
  assert(source.includes('项目卡答案已保留，可以重新整理'));
  assert(!source.includes('session = stateApi.createSession()'));
});
check('behaves as an accessible modal with trapped focus and restored background', () => {
  assert(source.includes("host.setAttribute('role', 'dialog')"));
  assert(source.includes("host.setAttribute('aria-modal', 'true')"));
  assert(source.includes("host.setAttribute('aria-labelledby', 'onboarding-dialog-title')"));
  assert(source.includes("event.key !== 'Tab'"));
  assert(source.includes("sibling.setAttribute('inert', '')"));
  assert(source.includes('focusBeforeOpen.focus()'));
});
check('contains no network, filesystem or preload access of its own', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', "require('fs')", 'window.writCraft']) assert(!source.includes(forbidden));
});

console.log(`\n${passed}/11 project-onboarding UI checks passed.`);
