#!/usr/bin/env node
'use strict';

// verify:syntax — run `node --check` over every project JavaScript file so
// syntax health is enforced by one gate instead of personal discipline.
// Vendored bundles (diff.min.js, marked.umd.js) are excluded.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'tests', 'scripts', 'bin'];
const EXCLUDE = /\.(?:min|umd)\.js$/;

const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
      walk(target);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !EXCLUDE.test(entry.name)) {
      files.push(target);
    }
  }
}
for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`✗ ${path.relative(ROOT, file)}\n${result.stderr || ''}`);
  }
}

console.log(`\nverify:syntax ${files.length - failed}/${files.length} files OK`);
process.exitCode = failed === 0 ? 0 : 1;
