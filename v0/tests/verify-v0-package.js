'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'package-macos.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

console.log('\nmacOS packaging verification');

test('provides a local macOS release command without adding an installer dependency', () => {
  assert.strictEqual(packageJson.scripts['package:mac'], 'node scripts/package-macos.js');
  assert(!/electron-builder|electron-packager|electron-forge/.test(JSON.stringify(packageJson)));
});

test('packages only production app sources and a sanitized production manifest', () => {
  assert.match(script, /fs\.cpSync\(path\.join\(root, 'src'\)/);
  assert.match(script, /productionPackage/);
  assert.doesNotMatch(script, /fs\.cpSync\([^\n]*(?:\.env|tests)/);
});

test('removes the Electron default app and assigns WritCraft bundle identity', () => {
  assert.match(script, /default_app\.asar/);
  assert.match(script, /verbatimSymlinks: true/);
  assert.match(script, /com\.maxhou\.writcraft/);
  assert.match(script, /CFBundleExecutable/);
});

test('ad-hoc signs, verifies, archives and records a SHA-256 release manifest', () => {
  assert.match(script, /codesign/);
  assert.match(script, /--verify/);
  assert.match(script, /ditto/);
  assert.match(script, /archiveSha256/);
  assert.match(script, /notarized: false/);
});

test('bundles the self-contained PDF runtime (pdfjs legacy build + standard fonts)', () => {
  assert.match(script, /pdfjs-dist/);
  assert.match(script, /legacy',\s*'build'/);
  assert.match(script, /standard_fonts/);
  // 提取服务不再依赖外部 python
  const service = fs.readFileSync(path.join(root, 'src', 'main', 'reference-import-service.js'), 'utf8');
  assert(!/execFile|python3|pypdf|pdfplumber\b/.test(service.replace(/\/\/[^\n]*/g, '')));
  assert.match(service, /require\('\.\/pdf-extract'\)/);
  // 独立提取模块存在且为 Node 内实现
  const extractor = fs.readFileSync(path.join(root, 'src', 'main', 'pdf-extract.js'), 'utf8');
  assert.match(extractor, /pdfjs-dist\/legacy\/build\/pdf\.mjs/);
  assert.match(extractor, /standardFontDataUrl/);
  // 旧 python helper 已删除
  assert(!fs.existsSync(path.join(root, 'src', 'main', 'pdf-extract-helper.py')));
});

console.log(`\n${passed}/5 macOS packaging checks passed.`);
