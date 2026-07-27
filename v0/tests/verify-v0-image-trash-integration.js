#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'main', 'preload.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function route(channel, nextChannel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `${channel} route missing`);
  const end = nextChannel
    ? main.indexOf(`ipcMain.handle('${nextChannel}'`, start + 1)
    : main.indexOf('\nipcMain.handle(', start + 1);
  assert(end > start, `${channel} route boundary missing`);
  return main.slice(start, end);
}

console.log('\nWritCraft image trash Main/preload integration verification');

test('Main constructs one service and one handler with Main-owned authority', () => {
  assert.match(main, /require\('\.\/image-trash-service'\)/);
  assert.match(main, /require\('\.\/image-trash-handler'\)/);
  assert.match(main, /createImageTrashService\(\)/);
  assert.match(main, /createImageTrashHandler\(\{[\s\S]*?assertTrustedSender,[\s\S]*?getCurrentProject:[\s\S]*?getMutationGeneration:[\s\S]*?getNavigationEpoch:[\s\S]*?trashService: imageTrashService/);
  assert.match(main, /error instanceof imageTrashServiceModule\.ImageTrashError/);
});

test('list is read-only but still binds the exact current project', () => {
  const block = route(
    'writcraft:project:get-image-trash',
    'writcraft:project:restore-image-trash'
  );
  assert.match(block, /requireCurrentProject\(\)/);
  assert.match(block, /imageTrashHandler\.list\(event, projectInstanceId\)/);
  assert.doesNotMatch(block, /requireMutableProject/);
});

test('restore and empty both pass the normal mutable-project gate', () => {
  const restore = route(
    'writcraft:project:restore-image-trash',
    'writcraft:project:empty-image-trash'
  );
  const empty = route(
    'writcraft:project:empty-image-trash',
    'writcraft:project:record-ai-metric'
  );
  assert.match(restore, /requireMutableProject\(\)/);
  assert.match(restore, /imageTrashHandler\.restore\(event, projectInstanceId, token\)/);
  assert.match(empty, /requireMutableProject\(\)/);
  assert.match(empty, /imageTrashHandler\.empty\(event, projectInstanceId, token\)/);
  for (const block of [restore, empty]) {
    assert.doesNotMatch(block, /rootPath|trashPath|assetPath|digest|inode|items/);
  }
});

test('preload exposes only project plus opaque token for mutating routes', () => {
  assert.match(preload, /getImageTrash: \(projectInstanceId\) =>\s*ipcRenderer\.invoke\('writcraft:project:get-image-trash', projectInstanceId\)/);
  assert.match(preload, /restoreImageTrash: \(projectInstanceId, token\) =>\s*ipcRenderer\.invoke\('writcraft:project:restore-image-trash', projectInstanceId, token\)/);
  assert.match(preload, /emptyImageTrash: \(projectInstanceId, token\) =>\s*ipcRenderer\.invoke\('writcraft:project:empty-image-trash', projectInstanceId, token\)/);
  assert.doesNotMatch(preload, /(?:restoreImageTrash|emptyImageTrash): \([^)]*(?:root|path|digest|inode|items)/i);
});

console.log(`\n✅ image trash integration ${passed}/${passed} checks passed.\n`);
