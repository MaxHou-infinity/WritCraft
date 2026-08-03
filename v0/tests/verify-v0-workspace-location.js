'use strict';

const assert = require('assert');
const service = require('../src/main/workspace-location-service');

const projectInstanceId = `instance_${'a'.repeat(24)}`;
const otherProjectInstanceId = `instance_${'c'.repeat(24)}`;
const authority = generation => Object.freeze({
  projectMutationGeneration: generation,
  inventoryGeneration: generation,
  graphGeneration: generation,
  sourceGeneration: generation,
  pendingGeneration: generation,
});
function inventory(revision = 'b'.repeat(64), offset = 11, generation = 1, owner = projectInstanceId) {
  return Object.freeze({
    schema: 'writcraft.workspace-inventory/v1',
    authority: Object.freeze({ projectInstanceId: owner, projectMutationGeneration: generation }),
    files: Object.freeze([Object.freeze({
      path: 'chapters/one.md', name: 'untrusted-name.md', revision, contentLength: 100,
      headings: Object.freeze([
        Object.freeze({ id: `sec_${'1'.repeat(16)}`, heading: '重复', level: 1, occurrence: 1, startOffset: 0, endOffset: 10 }),
        Object.freeze({ id: `sec_${'2'.repeat(16)}`, heading: '重复', level: 2, occurrence: 2, startOffset: offset, endOffset: offset + 9 }),
      ]),
    })]),
  });
}

let current = { projectInstanceId, authority: authority(1), inventory: inventory() };
let nonce = 0;
const adapters = {
  entity: {
    list() {
      return {
        status: 'partial', partialReasons: ['INDEX_BUILDING'],
        items: [{
          locator: { kind: 'entity', nodeId: `node_${'3'.repeat(16)}` },
          label: '林夏', detail: '人物', breadcrumb: 'Graph', badges: ['实体'],
        }],
      };
    },
    resolve() {
      return { action: 'open_file', filePath: 'chapters/one.md', revision: current.inventory.files[0].revision, offset: 2, endOffset: 4 };
    },
  },
  pending_review: {
    list() {
      return {
        status: 'ready', partialReasons: [],
        items: [{ locationId: 'pr_hidden', label: '一项修改', detail: 'one.md', breadcrumb: '待审', badges: [] }],
      };
    },
    resolve({ locationId }) {
      return locationId === 'pr_hidden' ? { action: 'open_review', reviewLocationId: locationId } : null;
    },
  },
};
const locations = service.createWorkspaceLocationService({
  currentStateProvider: () => current,
  adapters,
  randomBytes: () => Buffer.alloc(16, ++nonce),
});

const headings = locations.list(projectInstanceId, { query: '重复', kinds: ['heading'], limit: 10, requestId: 'q1' });
assert.strictEqual(headings.status, 'ready');
assert.strictEqual(headings.items.length, 2);
assert.notStrictEqual(headings.items[0].locationId, headings.items[1].locationId);
assert.ok(!JSON.stringify(headings).includes('revision'));
let resolved = locations.resolve(projectInstanceId, headings.items[1].locationId);
assert.strictEqual(resolved.target.offset, 11);
assert.strictEqual(resolved.target.filePath, 'chapters/one.md');
assert.deepStrictEqual(resolved.target.stableLocator, {
  kind: 'heading', path: 'chapters/one.md', sectionId: `sec_${'2'.repeat(16)}`,
});

// Resolver must obtain current authority/inventory rather than using the list
// snapshot. A moved heading and new revision are returned authoritatively.
current = { projectInstanceId, authority: authority(2), inventory: inventory('d'.repeat(64), 41, 2) };
resolved = locations.resolve(projectInstanceId, headings.items[1].locationId);
assert.strictEqual(resolved.authority.inventoryGeneration, 2);
assert.strictEqual(resolved.target.revision, 'd'.repeat(64));
assert.strictEqual(resolved.target.offset, 41);

// Deletion after list is not repaired from the stale projection.
current = {
  projectInstanceId,
  authority: authority(3),
  inventory: Object.freeze({ schema: 'writcraft.workspace-inventory/v1', authority: Object.freeze({ projectInstanceId, projectMutationGeneration: 3 }), files: Object.freeze([]) }),
};
assert.throws(() => locations.resolve(projectInstanceId, headings.items[1].locationId), error => error.code === 'LOCATION_MISSING');
current = { projectInstanceId, authority: authority(4), inventory: inventory('e'.repeat(64), 51, 4) };
const stableFile = locations.resolveStable(projectInstanceId, { kind: 'file', path: 'chapters/one.md' });
assert.strictEqual(stableFile.target.filePath, 'chapters/one.md');
assert.strictEqual(stableFile.target.revision, 'e'.repeat(64));
const stableEntity = locations.resolveStable(projectInstanceId, {
  kind: 'entity', nodeId: `node_${'3'.repeat(16)}`,
});
assert.strictEqual(stableEntity.target.offset, 2);

const projected = locations.list(projectInstanceId, {
  query: '', kinds: ['entity', 'pending_review'], limit: 10, requestId: 'q2',
});
assert.strictEqual(projected.status, 'partial');
assert.deepStrictEqual(projected.partialReasons, ['INDEX_BUILDING']);
assert.strictEqual(projected.items.length, 2);
assert.ok(!JSON.stringify(projected).includes('pr_hidden'));
const entity = projected.items.find(item => item.kind === 'entity');
assert.strictEqual(locations.resolve(projectInstanceId, entity.locationId).target.action, 'open_file');
const pending = projected.items.find(item => item.kind === 'pending_review');
assert.strictEqual(locations.resolve(projectInstanceId, pending.locationId).target.action, 'open_review');

const redirect = service.createWorkspaceLocationService({
  currentStateProvider: () => current,
  adapters: {
    pending_review: {
      list: () => ({
        status: 'ready', partialReasons: [],
        items: [{ locationId: 'pr_a', label: 'A', detail: '', breadcrumb: '', badges: [] }],
      }),
      resolve: () => ({ action: 'open_review', reviewLocationId: 'pr_b' }),
    },
  },
  randomBytes: () => Buffer.alloc(16, 8),
});
const redirectItem = redirect.list(projectInstanceId, { query: '', kinds: ['pending_review'], limit: 1, requestId: 'redirect' }).items[0];
assert.throws(() => redirect.resolve(projectInstanceId, redirectItem.locationId), error => error.code === 'LOCATION_STALE');

assert.throws(() => locations.list(projectInstanceId, {
  query: 'x'.repeat(257), kinds: ['file'], limit: 10, requestId: 'bad',
}), error => error.code === 'INVALID_QUERY');
current = { projectInstanceId: otherProjectInstanceId, authority: authority(5), inventory: inventory('b'.repeat(64), 11, 5, otherProjectInstanceId) };
assert.throws(() => locations.resolve(projectInstanceId, headings.items[0].locationId), error => error.code === 'PROJECT_CHANGED');
current = { projectInstanceId, authority: authority(6), inventory: inventory('b'.repeat(64), 11, 6) };

// Adapter list projections are exact-key: capability/root/quote cannot escape
// through a display result.
const badList = service.createWorkspaceLocationService({
  currentStateProvider: () => current,
  adapters: {
    issue: {
      list: () => ({
        status: 'ready', partialReasons: [],
        items: [{
          locator: { kind: 'issue', issueId: `issue_${'4'.repeat(16)}` },
          label: '冲突', detail: '', breadcrumb: '', badges: [], capability: 'pc_secret',
        }],
      }),
    },
  },
});
assert.throws(() => badList.list(projectInstanceId, {
  query: '', kinds: ['issue'], limit: 10, requestId: 'bad-list',
}), error => error.code === 'INVALID_LOCATION');

// Adapter resolved projections are also exact-key and path/revision bounded.
let maliciousTarget = false;
let targetRevisionOverride = null;
const badResolve = service.createWorkspaceLocationService({
  currentStateProvider: () => current,
  adapters: {
    issue: {
      list: () => ({
        status: 'ready', partialReasons: [],
        items: [{
          locator: { kind: 'issue', issueId: `issue_${'5'.repeat(16)}` },
          label: '冲突', detail: '', breadcrumb: '', badges: [],
        }],
      }),
      resolve: () => maliciousTarget
        ? { action: 'open_file', filePath: 'chapters/one.md', revision: targetRevisionOverride || current.inventory.files[0].revision, offset: 0, endOffset: 1, rootPath: '/secret' }
        : { action: 'open_file', filePath: 'chapters/one.md', revision: targetRevisionOverride || current.inventory.files[0].revision, offset: 0, endOffset: 1 },
    },
  },
  randomBytes: () => Buffer.alloc(16, 7),
});
const issue = badResolve.list(projectInstanceId, { query: '', kinds: ['issue'], limit: 1, requestId: 'issue' }).items[0];
assert.strictEqual(badResolve.resolve(projectInstanceId, issue.locationId).target.offset, 0);
const savedRevision = current.inventory.files[0].revision;
badResolve.clearProject();
const staleIssue = badResolve.list(projectInstanceId, { query: '', kinds: ['issue'], limit: 1, requestId: 'stale-issue' }).items[0];
targetRevisionOverride = savedRevision;
current = { projectInstanceId, authority: authority(7), inventory: inventory('f'.repeat(64), 11, 7) };
assert.throws(() => badResolve.resolve(projectInstanceId, staleIssue.locationId), error => error.code === 'LOCATION_STALE');
current = { projectInstanceId, authority: authority(6), inventory: inventory(savedRevision, 11, 6) };
targetRevisionOverride = null;
maliciousTarget = true;
badResolve.clearProject();
const maliciousIssue = badResolve.list(projectInstanceId, { query: '', kinds: ['issue'], limit: 1, requestId: 'malicious-issue' }).items[0];
assert.throws(() => badResolve.resolve(projectInstanceId, maliciousIssue.locationId), error => error.code === 'INVALID_LOCATION');

const mismatchedInventory = { projectInstanceId, authority: authority(8), inventory: inventory('a'.repeat(64), 11, 7) };
assert.throws(() => service.createWorkspaceLocationService({
  currentStateProvider: () => mismatchedInventory,
}).list(projectInstanceId, { query: '', kinds: ['file'], limit: 1, requestId: 'mismatch' }), error => error.code === 'PROJECT_CHANGED');

const outline = locations.listOutline(projectInstanceId, { path: 'chapters/one.md', requestId: 'outline-1' });
assert.strictEqual(outline.status, 'ready');
assert.strictEqual(outline.schema, 'writcraft.document-outline/v1');
assert.strictEqual(outline.path, 'chapters/one.md');
assert.strictEqual(outline.items.length, 2);
assert(outline.items.every(item => item.outlineId && Number.isSafeInteger(item.level)));
assert.strictEqual(outline.items[0].parentOutlineId, null);
assert.strictEqual(locations.resolve(projectInstanceId, outline.items[1].locationId).target.offset, 11);
assert.throws(() => locations.listOutline(projectInstanceId, {
  path: 'chapters/missing.md', requestId: 'outline-missing',
}), error => error.code === 'LOCATION_MISSING');
assert.throws(() => locations.listOutline(projectInstanceId, {
  path: 'chapters/one.md', requestId: 'outline-extra', extra: true,
}), error => error.code === 'INVALID_QUERY');

const largeOutlineInventory = Object.freeze({
  schema: 'writcraft.workspace-inventory/v1',
  authority: Object.freeze({ projectInstanceId, projectMutationGeneration: 9 }),
  files: Object.freeze([Object.freeze({
    path: 'chapters/large.md', revision: '9'.repeat(64), contentLength: 1000000,
    headings: Object.freeze(Array.from({ length: 700 }, (_, index) => Object.freeze({
      id: `sec_${index.toString(16).padStart(16, '0')}`,
      heading: `标题 ${index} ${'界'.repeat(950)}`,
      level: 1, occurrence: 1, startOffset: index * 10, endOffset: (index * 10) + 9,
    }))),
  })]),
});
current = { projectInstanceId, authority: authority(9), inventory: largeOutlineInventory };
const boundedOutline = service.createWorkspaceLocationService({ currentStateProvider: () => current })
  .listOutline(projectInstanceId, { path: 'chapters/large.md', requestId: 'outline-budget' });
assert.strictEqual(boundedOutline.status, 'partial');
assert.deepStrictEqual(boundedOutline.partialReasons, ['LOCATION_RESULTS_LIMIT']);
assert(Buffer.byteLength(JSON.stringify(boundedOutline), 'utf8') <= service.MAX_RESPONSE_BYTES);

function outlineInventory(headings, generation = 10) {
  return Object.freeze({
    schema: 'writcraft.workspace-inventory/v1',
    authority: Object.freeze({ projectInstanceId, projectMutationGeneration: generation }),
    files: Object.freeze([Object.freeze({
      path: 'chapters/outline.md', revision: '8'.repeat(64), contentLength: 1000000,
      headings: Object.freeze(headings.map(Object.freeze)),
    })]),
  });
}
const hierarchy = [
  { id: `sec_${'a'.repeat(16)}`, heading: 'H1', level: 1, occurrence: 1, startOffset: 0, endOffset: 9 },
  { id: `sec_${'b'.repeat(16)}`, heading: 'H3', level: 3, occurrence: 1, startOffset: 10, endOffset: 19 },
  { id: `sec_${'c'.repeat(16)}`, heading: 'H4', level: 4, occurrence: 1, startOffset: 20, endOffset: 29 },
  { id: `sec_${'d'.repeat(16)}`, heading: 'H2', level: 2, occurrence: 1, startOffset: 30, endOffset: 39 },
];
current = { projectInstanceId, authority: authority(10), inventory: outlineInventory(hierarchy) };
const jumped = service.createWorkspaceLocationService({ currentStateProvider: () => current })
  .listOutline(projectInstanceId, { path: 'chapters/outline.md', requestId: 'outline-hierarchy' });
assert.deepStrictEqual(jumped.items.map(item => item.parentOutlineId), [null, hierarchy[0].id, hierarchy[1].id, hierarchy[0].id]);

const baseHeading = { id: `sec_${'e'.repeat(16)}`, heading: '', level: 1, occurrence: 1, startOffset: 0, endOffset: 1 };
current = { projectInstanceId, authority: authority(10), inventory: outlineInventory([baseHeading]) };
const deterministic = () => Buffer.alloc(16, 7);
const baseEnvelope = service.createWorkspaceLocationService({ currentStateProvider: () => current, randomBytes: deterministic })
  .listOutline(projectInstanceId, { path: 'chapters/outline.md', requestId: 'outline-exact' });
const pessimisticBase = { ...baseEnvelope, status: 'partial', partialReasons: ['LOCATION_RESULTS_LIMIT'] };
const labelBytes = service.MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(pessimisticBase), 'utf8');
current = { projectInstanceId, authority: authority(10), inventory: outlineInventory([{ ...baseHeading, heading: 'x'.repeat(labelBytes) }]) };
const exactOutline = service.createWorkspaceLocationService({ currentStateProvider: () => current, randomBytes: deterministic })
  .listOutline(projectInstanceId, { path: 'chapters/outline.md', requestId: 'outline-exact' });
assert.strictEqual(exactOutline.items.length, 1);
assert.strictEqual(Buffer.byteLength(JSON.stringify({ ...exactOutline, status: 'partial', partialReasons: ['LOCATION_RESULTS_LIMIT'] }), 'utf8'), service.MAX_RESPONSE_BYTES);
current = { projectInstanceId, authority: authority(10), inventory: outlineInventory([{ ...baseHeading, heading: 'x'.repeat(labelBytes + 1) }]) };
const overOutline = service.createWorkspaceLocationService({ currentStateProvider: () => current, randomBytes: deterministic })
  .listOutline(projectInstanceId, { path: 'chapters/outline.md', requestId: 'outline-exact' });
assert.strictEqual(overOutline.status, 'partial');
assert.strictEqual(overOutline.items.length, 0);
current = { projectInstanceId, authority: authority(6), inventory: inventory(savedRevision, 11, 6) };

// A 300-file project must remain an in-memory location lookup. Repeated
// keystroke-style queries consume the already frozen inventory and never gain
// a filesystem/scanner dependency in this service.
let largeProviderCalls = 0;
const largeFiles = Object.freeze(Array.from({ length: 300 }, (_, fileIndex) => Object.freeze({
  path: `chapters/chapter-${String(fileIndex).padStart(3, '0')}.md`,
  revision: fileIndex.toString(16).padStart(64, '0'),
  contentLength: 4096,
  headings: Object.freeze(Array.from({ length: 3 }, (_, headingIndex) => Object.freeze({
    id: `sec_${((fileIndex * 3) + headingIndex).toString(16).padStart(16, '0')}`,
    heading: `章节 ${fileIndex} 小节 ${headingIndex}`,
    level: headingIndex + 1,
    occurrence: 1,
    startOffset: headingIndex * 100,
    endOffset: (headingIndex * 100) + 99,
  }))),
})));
const largeInventory = Object.freeze({
  schema: 'writcraft.workspace-inventory/v1',
  authority: Object.freeze({ projectInstanceId, projectMutationGeneration: 11 }),
  files: largeFiles,
});
const largeState = Object.freeze({ projectInstanceId, authority: authority(11), inventory: largeInventory });
const largeLocations = service.createWorkspaceLocationService({
  currentStateProvider() { largeProviderCalls += 1; return largeState; },
});
const performanceStarted = process.hrtime.bigint();
for (let index = 0; index < 100; index += 1) {
  const result = largeLocations.list(projectInstanceId, {
    query: `chapter-${String(index % 300).padStart(3, '0')}`,
    kinds: ['file', 'heading'],
    limit: 60,
    requestId: `perf-${index}`,
  });
  assert(result.items.some(item => item.kind === 'file'));
}
const performanceMs = Number(process.hrtime.bigint() - performanceStarted) / 1e6;
assert.strictEqual(largeProviderCalls, 100);
assert(performanceMs < 1500, `300-file in-memory quick-open queries took ${performanceMs.toFixed(1)}ms`);

// A broken RNG cannot spin forever or silently reuse an opaque identity.
const collisions = service.createWorkspaceLocationService({
  currentStateProvider: () => current,
  randomBytes: () => Buffer.alloc(16, 9),
});
collisions.list(projectInstanceId, { query: '', kinds: ['file'], limit: 1, requestId: 'first' });
assert.throws(() => collisions.list(projectInstanceId, {
  query: '', kinds: ['file'], limit: 1, requestId: 'second',
}), error => error.code === 'LOCATION_ID_COLLISION');

locations.clearProject();
assert.strictEqual(locations.size, 0);

console.log('verify-v0-workspace-location: ok');
