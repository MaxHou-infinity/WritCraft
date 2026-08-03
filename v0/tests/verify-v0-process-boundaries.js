#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const mainRoot = path.join(root, 'src', 'main');
const sharedRoot = path.join(root, 'src', 'shared');
const rendererRoot = path.join(root, 'src', 'renderer');
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

console.log('\nWritCraft process-boundary verification');

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function localRequireTargets(file, source) {
  const targets = [];
  for (const match of source.matchAll(/require\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    if (!match[2].startsWith('.')) continue;
    const unresolved = path.resolve(path.dirname(file), match[2]);
    const candidates = [unresolved, `${unresolved}.js`, path.join(unresolved, 'index.js')];
    const target = candidates.find(candidate => fs.existsSync(candidate));
    assert(target, `${path.relative(root, file)} has unresolved local require ${match[2]}`);
    targets.push(fs.realpathSync(target));
  }
  return targets;
}

test('Main never imports Renderer implementation files', () => {
  const violations = javascriptFiles(mainRoot).flatMap(file => {
    const source = fs.readFileSync(file, 'utf8');
    return localRequireTargets(file, source)
      .filter(target => isInside(rendererRoot, target))
      .map(target => `${path.relative(root, file)} -> ${path.relative(root, target)}`);
  });
  assert.deepStrictEqual(violations, []);
});

test('shared modules are pure and contain no process authority', () => {
  // Match authority-bearing expressions, not harmless prose such as
  // "cross-process" in comments. UMD's `module.exports` is intentionally
  // allowed so the same pure implementation can load in Node and Renderer.
  const forbidden = /\brequire\s*\(|\bprocess\s*[.[]|\bwindow\s*[.[]|\bdocument\s*[.[]|\bfetch\s*\(|\bXMLHttpRequest\b|['"]electron['"]/;
  for (const file of javascriptFiles(sharedRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    assert(!forbidden.test(source), `${path.relative(root, file)} acquires process authority`);
  }
});

test('Renderer loads the exact shared UMD modules shipped to npm', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert(html.includes('<script src="../shared/context-selection.js"></script>'));
  assert(html.includes('<script src="../shared/block-anchor.js"></script>'));
  const files = require(path.join(root, 'package.json')).files;
  assert(files.includes('src/shared/**/*.js'));
});

test('Node and Renderer UMD entrypoints expose behavior-equivalent APIs', () => {
  for (const [name, globalName, fixture] of [
    ['block-anchor.js', 'WritCraftBlockAnchor', api => api.parseBlocks('# 章\n\n正文。\n', 'chapters/a.md')],
    ['context-selection.js', 'WritCraftContext', api => api.parseMarkdownSections('# 章\n\n正文。\n', 'chapters/a.md')],
  ]) {
    const file = path.join(sharedRoot, name);
    const source = fs.readFileSync(file, 'utf8');
    const sandbox = {};
    vm.runInNewContext(source, sandbox, { filename: file });
    const nodeApi = require(file);
    assert(sandbox[globalName], `${name} did not expose ${globalName}`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fixture(sandbox[globalName]))), JSON.parse(JSON.stringify(fixture(nodeApi))));
  }
});

console.log(`\n${passed}/${passed} process-boundary checks passed.`);
