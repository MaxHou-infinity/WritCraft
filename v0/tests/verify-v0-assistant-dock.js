#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'assistant-dock.js'), 'utf8');
const dock = require('../src/renderer/assistant-dock');
let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✅ ${name}`); }
  catch (error) { console.error(`  ❌ ${name}: ${error.message}`); process.exitCode = 1; }
}

console.log('WritCraft Assistant Dock verification\n');
test('只定义四个权威模式', () => assert.deepStrictEqual(dock.MODES, ['chat', 'navigation', 'context', 'changes']));
test('模块不访问 Node、网络或 preload', () => {
  assert.ok(!/require\(['"](?:fs|path|electron|https?)/.test(source));
  assert.ok(!/fetch\s*\(|XMLHttpRequest|ipcRenderer/.test(source));
});
test('使用 aria-selected 与 roving tabindex', () => {
  assert.ok(source.includes("setAttribute('aria-selected'"));
  assert.ok(source.includes('button.tabIndex = active ? 0 : -1'));
});
test('外层页签与 panel 建立 aria-controls / aria-labelledby', () => {
  assert.ok(source.includes("button.setAttribute('aria-controls', panel.id)"));
  assert.ok(source.includes("panel.setAttribute('aria-labelledby', button.id)"));
});
test('支持左右/Home/End 键切换', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(source.includes(`event.key === '${key}'`));
});
test('Escape 只关闭 Dock', () => assert.ok(source.includes("event.key === 'Escape'")));
test('不存在 innerHTML 注入', () => assert.ok(!source.includes('innerHTML')));

if (!process.exitCode) console.log(`\n${passed}/${passed} passed`);
