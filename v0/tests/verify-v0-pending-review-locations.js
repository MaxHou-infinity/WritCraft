#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const changeSetService = require('../src/main/changeset-service');
const {
  MAX_PUBLIC_REVIEW_LOCATIONS,
  PUBLIC_REVIEW_LOCATION_RE,
  createPendingChangeSetStore,
} = require('../src/main/pending-changeset-store');

const PROJECT_A = `instance_${'a'.repeat(24)}`;
const PROJECT_B = `instance_${'b'.repeat(24)}`;

function revision(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function changeSet(path = 'chapter.md', before = '旧内容\n', after = '新内容\n') {
  return changeSetService.createChangeSet(
    [{ path, content: before, revision: revision(before) }],
    [{ path, after, summary: '局部修改' }],
  );
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPending public review location verification');

test('publishes a bounded capability-free projection and resolves only inside Main', () => {
  const store = createPendingChangeSetStore({
    idFactory: () => '11111111-1111-4111-8111-111111111111',
    locationPrefixFactory: () => '2'.repeat(24),
  });
  store.bindPublicReviewProject(PROJECT_A, '/project');
  const capability = store.put(changeSet(), '/project');
  const pendingGeneration = store.pendingGeneration;
  const projection = store.publishPublicReviewLocation(capability, PROJECT_A, { label: '第一章待审修改' });
  assert.strictEqual(store.pendingGeneration, pendingGeneration,
    'publishing a public mapping is not a pending store mutation');
  assert(store.publicReviewGeneration > 0);
  assert.deepStrictEqual(Object.keys(projection), [
    'locationId', 'label', 'targetPaths', 'fileCount', 'hunkCount', 'expiresAt',
  ]);
  assert.match(projection.locationId, PUBLIC_REVIEW_LOCATION_RE);
  assert.deepStrictEqual(projection.targetPaths, ['chapter.md']);
  assert.strictEqual(projection.fileCount, 1);
  assert.strictEqual(projection.hunkCount, 1);
  assert.strictEqual(projection.expiresAt, null);
  assert(Object.isFrozen(projection));
  assert(Object.isFrozen(projection.targetPaths));
  const publicJson = JSON.stringify(store.listPublicReviewLocations(PROJECT_A));
  assert(!publicJson.includes(capability));
  assert(!publicJson.includes('changeSet'));
  assert.strictEqual(store.resolvePublicReviewLocationForMain(
    PROJECT_A, projection.locationId,
  ).capability, capability);
  expectCode('REVIEW_NOT_AVAILABLE', () => store.resolvePublicReviewLocationForMain(
    PROJECT_B, projection.locationId,
  ));
});

test('accept, reject and delete terminal reasons destroy the opaque mapping', () => {
  const reasons = ['accepted', 'rejected', 'deleted'];
  reasons.forEach((reason, index) => {
    const hex = (index + 3).toString(16);
    const store = createPendingChangeSetStore({
      idFactory: () => `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`,
      locationPrefixFactory: () => hex.repeat(24),
    });
    store.bindPublicReviewProject(PROJECT_A, '/project');
    const capability = store.put(changeSet(), '/project');
    const location = store.publishPublicReviewLocation(capability, PROJECT_A);
    assert.strictEqual(store.delete(capability, reason), true);
    assert.deepStrictEqual(store.listPublicReviewLocations(PROJECT_A), []);
    expectCode('REVIEW_NOT_AVAILABLE', () => store.resolvePublicReviewLocationForMain(
      PROJECT_A, location.locationId,
    ));
  });
});

test('expiry, FIFO eviction and project switch cannot resurrect old locations', () => {
  let now = 1000;
  const ids = [
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ];
  const store = createPendingChangeSetStore({
    maxEntries: 1,
    clock: () => now,
    idFactory: () => ids.shift(),
    locationPrefixFactory: () => '8'.repeat(24),
  });
  store.bindPublicReviewProject(PROJECT_A, '/project');
  const firstCapability = store.allocateCapability();
  store.putWithCapability(firstCapability, changeSet(), '/project', {
    researchDependencies: {
      schema: 'writcraft.research-handoff/v1',
      projectInstanceId: PROJECT_A,
      rootPath: '/project',
      runId: `rr_${'1'.repeat(24)}`,
      cardId: `rc_${'2'.repeat(32)}`,
      bindingDigest: `sha256:${'3'.repeat(64)}`,
      source: {
        id: `src_${'4'.repeat(20)}`,
        path: 'references/source.md',
        revision: '5'.repeat(64),
        offset: 0,
        end: 2,
        quote: '证据',
        gradeDigest: `sha256:${'6'.repeat(64)}`,
      },
      edit: { path: 'edit.md', revision: '7'.repeat(64) },
      targets: [{ path: 'chapter.md', revision: '8'.repeat(64) }],
      expiresAt: 2000,
      issuedCapability: firstCapability,
    },
  });
  const firstLocation = store.publishPublicReviewLocation(firstCapability, PROJECT_A);
  now = 2000;
  assert.deepStrictEqual(store.listPublicReviewLocations(PROJECT_A), []);
  expectCode('REVIEW_NOT_AVAILABLE', () => store.resolvePublicReviewLocationForMain(
    PROJECT_A, firstLocation.locationId,
  ));

  now = 3000;
  const secondCapability = store.put(changeSet('second.md'), '/project');
  const secondLocation = store.publishPublicReviewLocation(secondCapability, PROJECT_A);
  store.bindPublicReviewProject(PROJECT_B, '/project-b');
  expectCode('REVIEW_NOT_AVAILABLE', () => store.resolvePublicReviewLocationForMain(
    PROJECT_A, secondLocation.locationId,
  ));
  assert.deepStrictEqual(store.listPublicReviewLocations(PROJECT_B), []);
  store.bindPublicReviewProject(PROJECT_A, '/project');
  expectCode('REVIEW_NOT_AVAILABLE', () => store.publishPublicReviewLocation(
    secondCapability, PROJECT_A,
  ));

  const evictIds = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ];
  const evictStore = createPendingChangeSetStore({
    maxEntries: 1,
    idFactory: () => evictIds.shift(),
    locationPrefixFactory: () => 'c'.repeat(24),
  });
  evictStore.bindPublicReviewProject(PROJECT_A, '/project');
  const evictedCapability = evictStore.put(changeSet('first.md'), '/project');
  const evictedLocation = evictStore.publishPublicReviewLocation(evictedCapability, PROJECT_A);
  evictStore.put(changeSet('replacement.md'), '/project');
  expectCode('REVIEW_NOT_AVAILABLE', () => evictStore.resolvePublicReviewLocationForMain(
    PROJECT_A, evictedLocation.locationId,
  ));
});

test('the public projection limit is frozen at ten', () => {
  assert.strictEqual(MAX_PUBLIC_REVIEW_LOCATIONS, 10);
  const store = createPendingChangeSetStore({
    maxEntries: 20,
    locationPrefixFactory: () => '9'.repeat(24),
  });
  store.bindPublicReviewProject(PROJECT_A, '/project');
  const capabilities = [];
  for (let index = 0; index < 11; index += 1) {
    const capability = store.put(changeSet(`chapter-${index}.md`), '/project');
    capabilities.push(capability);
    store.publishPublicReviewLocation(capability, PROJECT_A);
  }
  assert.strictEqual(store.listPublicReviewLocations(PROJECT_A).length, 10);
  assert.strictEqual(store.size, 11, 'projection eviction must not delete the underlying ChangeSet');
  assert.strictEqual(store.has(capabilities[0]), true);
});

test('publish verifies the pending record canonical root binding', () => {
  const store = createPendingChangeSetStore({
    idFactory: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    locationPrefixFactory: () => 'e'.repeat(24),
  });
  store.bindPublicReviewProject(PROJECT_A, '/project');
  const capability = store.put(changeSet(), '/other-project');
  expectCode('REVIEW_NOT_AVAILABLE', () => store.publishPublicReviewLocation(
    capability, PROJECT_A,
  ));
  assert.deepStrictEqual(store.listPublicReviewLocations(PROJECT_A), []);
  expectCode('PROJECT_CHANGED', () => store.bindPublicReviewProject(PROJECT_A, '/project/../project'));
});

test('session prefix plus monotonic sequence never reuses a retired location ID', () => {
  const ids = [
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ];
  const store = createPendingChangeSetStore({
    idFactory: () => ids.shift(),
    locationPrefixFactory: () => '1'.repeat(24),
  });
  store.bindPublicReviewProject(PROJECT_A, '/project');
  const firstCapability = store.put(changeSet(), '/project');
  const firstLocation = store.publishPublicReviewLocation(firstCapability, PROJECT_A).locationId;
  store.delete(firstCapability, 'accepted');
  const secondCapability = store.put(changeSet('second.md'), '/project');
  const secondLocation = store.publishPublicReviewLocation(secondCapability, PROJECT_A).locationId;
  assert.notStrictEqual(firstLocation, secondLocation);
  assert.strictEqual(firstLocation.slice(0, -8), secondLocation.slice(0, -8));
  assert.strictEqual(parseInt(secondLocation.slice(-8), 16), parseInt(firstLocation.slice(-8), 16) + 1);
  expectCode('REVIEW_NOT_AVAILABLE', () => store.resolvePublicReviewLocationForMain(
    PROJECT_A, firstLocation,
  ));
});

console.log(`\n${passed}/${passed} pending public review location checks passed.`);
