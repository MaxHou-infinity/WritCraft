'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native', 'author-copy-helper.c');
const outputDirectory = path.join(root, 'src', 'main', 'native');
const output = path.join(outputDirectory, 'author-copy-helper');

if (process.platform !== 'darwin') {
  throw new Error('author-copy-helper 只能在 macOS 构建');
}
if (!fs.existsSync(source)) {
  throw new Error('author-copy-helper 源码不存在');
}

fs.mkdirSync(outputDirectory, { recursive: true });
childProcess.execFileSync(
  'xcrun',
  [
    '--sdk',
    'macosx',
    'clang',
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-Os',
    '-mmacosx-version-min=11.0',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    source,
    '-o',
    output,
  ],
  { stdio: 'inherit' }
);
fs.chmodSync(output, 0o755);
childProcess.execFileSync('lipo', [output, '-verify_arch', 'arm64', 'x86_64']);
console.log(output);
