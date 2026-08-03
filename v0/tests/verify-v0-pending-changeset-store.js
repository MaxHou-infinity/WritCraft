#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CAPABILITY_RE,
  MAX_ISSUE_DEPENDENCIES_BYTES,
  MAX_RESEARCH_DEPENDENCIES_BYTES,
  createPendingChangeSetStore,
} = require('../src/main/pending-changeset-store');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPending ChangeSet capability store verification');

test('identical content hashes receive independent unguessable proposal capabilities', () => {
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  const store = createPendingChangeSetStore({ idFactory: () => ids.shift() });
  const same = Object.freeze({ id: 'cs_same_content' });
  const first = store.put(same, '/project');
  const generic = store.put(same, '/project');
  assert.match(first, CAPABILITY_RE);
  assert.match(generic, CAPABILITY_RE);
  assert.notStrictEqual(first, generic);
  assert.strictEqual(store.get(first).changeSet, same);
  assert.strictEqual(store.get(generic).changeSet, same);
});

test('discarding a stale same-content proposal cannot remove the current proposal', () => {
  const ids = [
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const store = createPendingChangeSetStore({ idFactory: () => ids.shift() });
  const same = Object.freeze({ id: 'cs_same_content' });
  const stale = store.put(same, '/project');
  const current = store.put(same, '/project');
  assert.strictEqual(store.delete(stale), true);
  assert.strictEqual(store.get(stale), undefined);
  assert.strictEqual(store.get(current).changeSet, same);
});

test('invalid capability strings never address a record', () => {
  const store = createPendingChangeSetStore({ idFactory: () => '55555555-5555-4555-8555-555555555555' });
  const capability = store.put({ id: 'cs_x' }, '/project');
  assert.strictEqual(store.get('cs_x'), undefined);
  assert.strictEqual(store.get('../' + capability), undefined);
  assert.strictEqual(store.delete('pc_' + '0'.repeat(32)), false);
  assert.strictEqual(store.size, 1);
});

test('root-scoped admission detects only current pending reviews', () => {
  const store = createPendingChangeSetStore({
    idFactory: () => '56565656-5656-4565-8565-565656565656',
  });
  const capability = store.put({ id: 'cs_root' }, '/project-a');
  assert.strictEqual(store.hasForRoot('/project-a'), true);
  assert.strictEqual(store.hasForRoot('/project-b'), false);
  assert.strictEqual(store.hasForRoot(''), false);
  store.delete(capability);
  assert.strictEqual(store.hasForRoot('/project-a'), false);
});

test('bounded FIFO eviction never aliases a newly issued capability', () => {
  const ids = [
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
  ];
  const store = createPendingChangeSetStore({ maxEntries: 1, idFactory: () => ids.shift() });
  const first = store.put({ id: 'cs_1' }, '/project');
  const second = store.put({ id: 'cs_2' }, '/project');
  assert.strictEqual(store.size, 1);
  assert.strictEqual(store.get(first), undefined);
  assert.strictEqual(store.get(second).changeSet.id, 'cs_2');
});

test('preallocated residual capabilities preserve immutable review metadata', () => {
  const store = createPendingChangeSetStore({ idFactory: () => '88888888-8888-4888-8888-888888888888' });
  const capability = store.allocateCapability();
  const provenance = { requestId: 'request-1', targets: [{ path: 'one.md', revision: 'a'.repeat(64) }] };
  store.putWithCapability(capability, { id: 'cs_residual' }, '/project', {
    selectionPolicy: 'hunk',
    fileSelectionPolicies: { 'edit.md': 'file' },
    provenance,
  });
  provenance.targets[0].revision = 'b'.repeat(64);
  const record = store.get(capability);
  assert.deepStrictEqual(record.fileSelectionPolicies, { 'edit.md': 'file' });
  assert.strictEqual(record.provenance.targets[0].revision, 'a'.repeat(64));
  assert(Object.isFrozen(record.fileSelectionPolicies));
  assert(Object.isFrozen(record.provenance.targets));
  assert.throws(() => store.putWithCapability(capability, { id: 'cs_reused' }, '/project'), error => error.code === 'INVALID_CAPABILITY');
});

test('ordinary Changes dependencies are exact, immutable and reject reserved targets', () => {
  const ids = [
    '89898989-8989-4989-8989-898989898989',
    '89898989-8989-4989-8989-898989898988',
  ];
  const store = createPendingChangeSetStore({ idFactory: () => ids.shift() });
  const dependencies = [
    { path: 'edit.md', revision: 'a'.repeat(64), role: 'project_prompt' },
    { path: 'references/r.md', revision: 'b'.repeat(64), role: 'context' },
    { path: 'chapter.md', revision: 'c'.repeat(64), role: 'target' },
  ];
  const capability = store.put({ id: 'cs_project' }, '/project', { projectDependencies: dependencies });
  dependencies[2].revision = 'd'.repeat(64);
  const record = store.get(capability);
  assert.strictEqual(record.projectDependencies[2].revision, 'c'.repeat(64));
  assert(Object.isFrozen(record.projectDependencies));
  assert(Object.isFrozen(record.projectDependencies[0]));
  assert.throws(() => store.put({ id: 'cs_reserved' }, '/project', {
    projectDependencies: [{ path: 'sources/s.md', revision: 'e'.repeat(64), role: 'target' }],
  }), error => error.code === 'INVALID_PROJECT_DEPENDENCIES');
});

function issueDependencies() {
  return {
    schema: 'writcraft.graph-issue-handoff/v1',
    projectInstanceId: `instance_${'1'.repeat(24)}`,
    issueId: 'issue_conflict_1',
    graphIdentity: `graph_${'2'.repeat(32)}`,
    bindingId: `gih_${'3'.repeat(24)}`,
    issueDigest: `sha256:${'4'.repeat(64)}`,
    evidence: [{
      id: `ev_${'5'.repeat(16)}`,
      path: 'chapter.md',
      revision: '6'.repeat(64),
      contentHash: `sha256:${'7'.repeat(64)}`,
      blockId: `blk_${'8'.repeat(16)}`,
      start: 0,
      end: 2,
      quote: '正文',
    }],
    targets: [{ path: 'chapter.md', revision: '6'.repeat(64) }],
  };
}

test('deep-freezes exact Graph Issue dependencies and requires complete decisions', () => {
  const store = createPendingChangeSetStore({ idFactory: () => '99999999-9999-4999-8999-999999999999' });
  const dependencies = issueDependencies();
  const capability = store.put({ id: 'cs_issue' }, '/project', {
    issueDependencies: dependencies,
    requireCompleteDecision: true,
  });
  dependencies.evidence[0].quote = '篡改';
  const record = store.get(capability);
  assert.strictEqual(record.issueDependencies.evidence[0].quote, '正文');
  assert.strictEqual(record.requireCompleteDecision, true);
  assert(Object.isFrozen(record.issueDependencies));
  assert(Object.isFrozen(record.issueDependencies.targets[0]));
  assert.throws(() => createPendingChangeSetStore({ idFactory: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    .put({ id: 'cs_unsafe' }, '/project', { issueDependencies: issueDependencies() }),
  error => error.code === 'INVALID_ISSUE_DEPENDENCIES');
});

test('rejects issue dependency smuggling, edit.md targets and oversized records', () => {
  const makeStore = id => createPendingChangeSetStore({ idFactory: () => id });
  const smuggled = { ...issueDependencies(), instruction: '修改全部' };
  assert.throws(() => makeStore('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').put(
    { id: 'cs_smuggled' }, '/project', { issueDependencies: smuggled, requireCompleteDecision: true },
  ), error => error.code === 'INVALID_ISSUE_DEPENDENCIES');
  const editTarget = issueDependencies();
  editTarget.targets = [{ path: 'edit.md', revision: editTarget.evidence[0].revision }];
  assert.throws(() => makeStore('cccccccc-cccc-4ccc-8ccc-cccccccccccc').put(
    { id: 'cs_edit' }, '/project', { issueDependencies: editTarget, requireCompleteDecision: true },
  ), error => error.code === 'INVALID_ISSUE_DEPENDENCIES');
  const oversized = issueDependencies();
  oversized.evidence = Array.from({ length: 100 }, (_, index) => ({
    ...oversized.evidence[0],
    id: `ev_${index.toString(16).padStart(16, '0')}`,
    quote: 'x'.repeat(240), end: 240,
  }));
  assert(Buffer.byteLength(JSON.stringify(oversized), 'utf8') < MAX_ISSUE_DEPENDENCIES_BYTES,
    '100 bounded graph evidence records should stay under the aggregate cap');
  oversized.issueDigest = `sha256:${'f'.repeat(64)}`;
  oversized.evidence[0] = { ...oversized.evidence[0], quote: 'x'.repeat(241), end: 241 };
  assert.throws(() => makeStore('dddddddd-dddd-4ddd-8ddd-dddddddddddd').put(
    { id: 'cs_quote' }, '/project', { issueDependencies: oversized, requireCompleteDecision: true },
  ), error => error.code === 'INVALID_ISSUE_DEPENDENCIES');
});

function researchDependencies(capability, overrides = {}) {
  const base = {
    schema: 'writcraft.research-handoff/v1',
    projectInstanceId: `instance_${'1'.repeat(24)}`,
    rootPath: '/project',
    runId: `rr_${'2'.repeat(24)}`,
    cardId: `rc_${'3'.repeat(32)}`,
    bindingDigest: `sha256:${'4'.repeat(64)}`,
    source: {
      id: `src_${'5'.repeat(20)}`,
      path: 'references/source.md',
      revision: '6'.repeat(64),
      offset: 0,
      end: 2,
      quote: '证据',
      gradeDigest: `sha256:${'7'.repeat(64)}`,
    },
    edit: { path: 'edit.md', revision: '8'.repeat(64) },
    targets: [{ path: 'chapters/one.md', revision: '9'.repeat(64) }],
    expiresAt: 2000,
    issuedCapability: capability,
  };
  return { ...base, ...overrides };
}

test('strictly freezes Research authority and binds it to the issued capability and root', () => {
  const uuid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const capability = `pc_${uuid.replace(/-/g, '')}`;
  const store = createPendingChangeSetStore({ idFactory: () => uuid, clock: () => 1000 });
  const dependencies = researchDependencies(capability);
  const issued = store.put({ id: 'cs_research' }, '/project', { researchDependencies: dependencies });
  dependencies.source.quote = '篡改';
  dependencies.targets[0].revision = 'a'.repeat(64);
  const record = store.get(issued);
  assert.strictEqual(issued, capability);
  assert.strictEqual(record.researchDependencies.source.quote, '证据');
  assert.strictEqual(record.researchDependencies.targets[0].revision, '9'.repeat(64));
  assert.strictEqual(record.expiresAt, 2000);
  assert(Object.isFrozen(record.researchDependencies));
  assert(Object.isFrozen(record.researchDependencies.source));
  assert(Object.isFrozen(record.researchDependencies.targets[0]));
  assert(Buffer.byteLength(JSON.stringify(record.researchDependencies), 'utf8') < MAX_RESEARCH_DEPENDENCIES_BYTES);
});

test('Research dependencies reject smuggling, mismatched capability/root and source-target aliases', () => {
  const ids = [
    'abababab-abab-4bab-8bab-abababababab',
    'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc',
    'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
    'dededede-dede-4ded-8ded-dededededede',
  ];
  const capabilityFor = uuid => `pc_${uuid.replace(/-/g, '')}`;
  const store = createPendingChangeSetStore({ idFactory: () => ids.shift(), clock: () => 1000 });
  const first = capabilityFor(ids[0]);
  assert.throws(() => store.put({ id: 'cs_smuggled_research' }, '/project', {
    researchDependencies: { ...researchDependencies(first), instruction: '改写全部' },
  }), error => error.code === 'INVALID_RESEARCH_DEPENDENCIES');
  const second = capabilityFor(ids[0]);
  assert.throws(() => store.put({ id: 'cs_wrong_root' }, '/project', {
    researchDependencies: researchDependencies(second, { rootPath: '/other' }),
  }), error => error.code === 'INVALID_RESEARCH_DEPENDENCIES');
  const third = capabilityFor(ids[0]);
  assert.throws(() => store.put({ id: 'cs_wrong_cap' }, '/project', {
    researchDependencies: researchDependencies(`pc_${'f'.repeat(32)}`),
  }), error => error.code === 'INVALID_RESEARCH_DEPENDENCIES');
  const fourth = capabilityFor(ids[0]);
  assert.throws(() => store.put({ id: 'cs_source_target' }, '/project', {
    researchDependencies: researchDependencies(fourth, {
      source: { ...researchDependencies(fourth).source, path: 'Chapters/One.md' },
      targets: [{ path: 'chapters/one.md', revision: '9'.repeat(64) }],
    }),
  }), error => error.code === 'SOURCE_TARGET_CONFLICT');
});

test('Research capabilities and residuals keep an absolute expiry and notify reverse owners', () => {
  let now = 1000;
  const removals = [];
  const ids = [
    '12121212-1212-4212-8212-121212121212',
    '34343434-3434-4434-8434-343434343434',
  ];
  const store = createPendingChangeSetStore({
    idFactory: () => ids.shift(),
    clock: () => now,
    onRemove: event => removals.push({ capability: event.capability, reason: event.reason }),
  });
  const first = store.allocateCapability();
  store.putWithCapability(first, { id: 'cs_first' }, '/project', {
    researchDependencies: researchDependencies(first, { expiresAt: 1500 }),
  });
  const residual = store.allocateCapability();
  store.putWithCapability(residual, { id: 'cs_residual' }, '/project', {
    researchDependencies: researchDependencies(residual, { expiresAt: 1500 }),
  });
  now = 1500;
  assert.strictEqual(store.get(first), undefined);
  assert.strictEqual(store.get(residual), undefined);
  assert.deepStrictEqual(removals.map(item => item.reason), ['expired', 'expired']);
  assert.throws(() => store.putWithCapability(`pc_${'f'.repeat(32)}`, { id: 'cs_expired' }, '/project', {
    researchDependencies: researchDependencies(`pc_${'f'.repeat(32)}`, { expiresAt: 1400 }),
  }), error => error.code === 'RESEARCH_CAPABILITY_EXPIRED');
});

test('clearExcept preserves the in-flight authority while invalidating every sibling', () => {
  const removals = [];
  const ids = [
    '56565656-5656-4656-8656-565656565656',
    '78787878-7878-4878-8878-787878787878',
  ];
  const store = createPendingChangeSetStore({
    idFactory: () => ids.shift(),
    onRemove: event => removals.push({ capability: event.capability, reason: event.reason }),
  });
  const preserved = store.put({ id: 'cs_preserved' }, '/project');
  const sibling = store.put({ id: 'cs_sibling' }, '/project');
  store.clearExcept(preserved);
  assert.strictEqual(store.has(preserved), true);
  assert.strictEqual(store.has(sibling), false);
  assert.deepStrictEqual(removals, [{ capability: sibling, reason: 'cleared' }]);
});

test('pending generation advances only for real put, remove, expiry, eviction and clear mutations', () => {
  let now = 1000;
  const ids = [
    '10101010-1010-4010-8010-101010101010',
    '20202020-2020-4020-8020-202020202020',
    '30303030-3030-4030-8030-303030303030',
  ];
  const store = createPendingChangeSetStore({
    maxEntries: 1,
    clock: () => now,
    idFactory: () => ids.shift(),
  });
  assert.strictEqual(store.pendingGeneration, 0);
  const first = store.put({ id: 'cs_generation_1' }, '/project');
  assert.strictEqual(store.pendingGeneration, 1);
  assert.strictEqual(store.get(first).changeSet.id, 'cs_generation_1');
  assert.strictEqual(store.pendingGeneration, 1);
  const second = store.put({ id: 'cs_generation_2' }, '/project');
  assert.strictEqual(store.pendingGeneration, 3, 'second put and FIFO eviction are distinct mutations');
  assert.strictEqual(store.delete(first), false);
  assert.strictEqual(store.pendingGeneration, 3);
  assert.strictEqual(store.delete(second), true);
  assert.strictEqual(store.pendingGeneration, 4);

  const expiring = store.allocateCapability();
  store.putWithCapability(expiring, { id: 'cs_generation_expiring' }, '/project', {
    researchDependencies: researchDependencies(expiring),
  });
  assert.strictEqual(store.pendingGeneration, 5);
  now = 2000;
  assert.strictEqual(store.size, 0);
  assert.strictEqual(store.pendingGeneration, 6);

  const clearIds = [
    '40404040-4040-4040-8040-404040404040',
    '50505050-5050-4050-8050-505050505050',
  ];
  const clearStore = createPendingChangeSetStore({ maxEntries: 2, idFactory: () => clearIds.shift() });
  clearStore.put({ id: 'cs_clear_1' }, '/project');
  clearStore.put({ id: 'cs_clear_2' }, '/project');
  assert.strictEqual(clearStore.pendingGeneration, 2);
  clearStore.clear();
  assert.strictEqual(clearStore.pendingGeneration, 4);
  clearStore.clear();
  assert.strictEqual(clearStore.pendingGeneration, 4, 'empty clear is not a store mutation');
});

console.log(`\nPending ChangeSet capability store ${passed}/${passed} passed.`);
