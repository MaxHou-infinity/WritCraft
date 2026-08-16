'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer/sources-view.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const adapter = fs.readFileSync(path.join(root, 'src/main/delivery-preflight-main-adapter.js'), 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('WritCraft 0.4.0 Stage B delivery IPC boundary tests');

test('Main registers only the opaque request delivery channels', () => {
  assert.match(main, /writcraft:project:delivery-preflight/);
  assert.match(main, /writcraft:project:list-delivery-snapshots/);
  assert.match(main, /writcraft:project:list-delivery-snapshot-files/);
  assert.match(main, /createDeliveryPreflightMainAdapter/);
  assert.match(main, /createSnapshotStorageWorkerForRoot/);
  const routeStart = main.indexOf("ipcMain.handle('writcraft:project:delivery-preflight'");
  const routeEnd = main.indexOf("ipcMain.handle('writcraft:project:list-delivery-snapshots'", routeStart);
  const route = main.slice(routeStart, routeEnd);
  assert(route.indexOf('assertTrustedSender(event)') >= 0);
  assert.doesNotMatch(route, /request\.projectInstanceId/u);
  assert.match(route, /deliveryIpcFailure/);
});

test('preload exposes the narrow delivery bridge', () => {
  assert.match(preload, /deliveryPreflight:\s*\(projectInstanceId, request\)/u);
  assert.match(preload, /listDeliverySnapshots:/u);
  assert.match(preload, /listDeliverySnapshotFiles:/u);
});

test('Renderer sends only snapshot/file opaque ids and the warning decision', () => {
  assert.match(renderer, /writcraft\.delivery-preflight-request\/v1/u);
  assert.match(renderer, /orderedFiles:/u);
  assert.match(renderer, /warningDecision:/u);
  assert.doesNotMatch(renderer, /deliveryPreflight\([^\n]*rootPath/u);
  assert.doesNotMatch(renderer, /deliveryPreflight\([^\n]*content/u);
  assert.match(html, /delivery-snapshot-select/);
  assert.match(html, /delivery-preflight-run/);
});

test('Main adapter contains no live-root Graph/SourceIndex call path', () => {
  assert.doesNotMatch(adapter, /indexProjectGraph|buildSourceIndex\(/u);
  assert.match(adapter, /snapshot-delivery-provider-adapter/u);
  assert.match(adapter, /requestScoped|createService|issuedBindings/u);
});

console.log(`Stage B delivery IPC boundary: ${passed}/${passed} passed`);
