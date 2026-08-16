'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SHARED_MARKED = path.join(ROOT, 'src/shared/marked.umd.js');
const RETIRED_RENDERER_MARKED = path.join(ROOT, 'src/renderer/marked.umd.js');
const EXPECTED_SHA256 = '62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d';
const MARKED_OPTIONS = Object.freeze({
  gfm: true,
  pedantic: false,
  breaks: false,
  async: false
});

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalize(value) {
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(normalize(item));
    for (const key of Object.keys(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) result[key] = normalize(value[key]);
    }
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value)) result[key] = normalize(value[key]);
  return result;
}

test('唯一 marked v18.0.6 字节源位于 shared 且 SHA 保持冻结值', () => {
  assert(fs.existsSync(SHARED_MARKED));
  assert.strictEqual(fs.existsSync(RETIRED_RENDERER_MARKED), false);
  assert.strictEqual(sha256(fs.readFileSync(SHARED_MARKED)), EXPECTED_SHA256);
});

test('Renderer 与 DOM fixture 均加载同一 shared 字节源', () => {
  const index = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const fixture = fs.readFileSync(path.join(ROOT, 'tests/fixtures/dom-sanitizer.html'), 'utf8');
  assert(index.includes('<script src="../shared/marked.umd.js"></script>'));
  assert(!index.includes('<script src="marked.umd.js"></script>'));
  assert(fixture.includes('<script src="../../src/shared/marked.umd.js"></script>'));
  assert(!fixture.includes('../../src/renderer/marked.umd.js'));
});

test('Main require 与 Renderer UMD lexer 在固定选项和代表语料上 token parity', () => {
  const source = [
    '# 标题',
    '',
    '正文 ![direct](assets/a.png "说明") 与 ![ref][pic]。',
    '',
    '```md',
    '![not-image](assets/code.png)',
    '```',
    '',
    '<img src="assets/html.png">',
    '',
    '[pic]: images/%E5%9B%BE.jpg "引用图"',
    ''
  ].join('\n');
  const bytes = fs.readFileSync(SHARED_MARKED);
  const mainMarked = require(SHARED_MARKED);
  const renderer = { console };
  renderer.globalThis = renderer;
  vm.runInNewContext(bytes.toString('utf8'), renderer, { filename: SHARED_MARKED });
  assert(renderer.marked);
  assert.deepStrictEqual(
    normalize(renderer.marked.lexer(source, { ...MARKED_OPTIONS })),
    normalize(mainMarked.lexer(source, { ...MARKED_OPTIONS }))
  );
});

test('npm package allowlist already includes shared and renderer resource trees', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(packageJson.files.includes('src/shared/**/*.js'));
  assert(packageJson.files.includes('src/renderer/**/*'));
});

console.log(`shared marked verification: ${passed}/${passed} passed`);
