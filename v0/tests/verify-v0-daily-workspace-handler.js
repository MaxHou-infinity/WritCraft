'use strict';

const assert = require('assert');
const { createDailyWorkspaceHandler } = require('../src/main/daily-workspace-handler');

const PROJECT_ID = `instance_${'a'.repeat(24)}`;
let project = { instanceId: PROJECT_ID, rootPath: '/project' };
let generation = 3;
let trustedCalls = 0;
let settles = 0;
const home = { schema: 'writcraft.project-home/v1' };
const listed = { schema: 'writcraft.workspace-location-list/v1' };
const resolved = { schema: 'writcraft.workspace-location-resolved/v1' };
const outline = { schema: 'writcraft.workspace-locations/v1', items: [] };
let duringHome = null;
const handler = createDailyWorkspaceHandler({
  assertTrustedSender() { trustedCalls += 1; },
  getCurrentProject: () => project,
  getMutationGeneration: () => generation,
  async settleReadAuthority() { settles += 1; },
  homeSnapshotService: { async build(request) { duringHome?.(); assert.strictEqual(request.rootPath, '/project'); return home; } },
  prepareHomeData: async () => ({ inventory: {}, captureHomeState: () => ({}) }),
  ensureLocationState: async () => {},
  captureProjectAuthority: () => ({}),
  locationService: {
    list(id, request) { assert.strictEqual(id, PROJECT_ID); assert.strictEqual(request.requestId, 'q1'); return listed; },
    listOutline(id, request) { assert.strictEqual(id, PROJECT_ID); assert.strictEqual(request.path, 'chapter.md'); return outline; },
    resolve(id, locationId) { assert.strictEqual(id, PROJECT_ID); assert.strictEqual(locationId, 'wl_1'); return resolved; },
    resolveStable(id, locator) { assert.strictEqual(id, PROJECT_ID); assert.strictEqual(locator.path, 'chapter.md'); return resolved; },
  },
});

async function main() {
  assert.strictEqual(await handler.getHome({}, PROJECT_ID), home);
  assert.strictEqual(await handler.listLocations({}, PROJECT_ID, { requestId: 'q1' }), listed);
  assert.strictEqual(await handler.listOutline({}, PROJECT_ID, { path: 'chapter.md', requestId: 'o1' }), outline);
  assert.strictEqual(await handler.resolveLocation({}, PROJECT_ID, 'wl_1'), resolved);
  assert.strictEqual(await handler.resolveStableLocation({}, PROJECT_ID, { kind: 'file', path: 'chapter.md' }), resolved);
  assert.strictEqual(trustedCalls, 5);
  assert.strictEqual(settles, 10);

  duringHome = () => { generation += 1; };
  await assert.rejects(handler.getHome({}, PROJECT_ID), error => error.code === 'PROJECT_CHANGED');
  duringHome = null;
  const old = project;
  project = { instanceId: `instance_${'b'.repeat(24)}`, rootPath: '/other' };
  await assert.rejects(handler.listLocations({}, old.instanceId, { requestId: 'q1' }), error => error.code === 'PROJECT_CHANGED');
  console.log('verify-v0-daily-workspace-handler: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
