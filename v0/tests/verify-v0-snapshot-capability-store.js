'use strict';

const assert = require('assert');
const schema = require('../src/main/evidence-delivery-schema');
const {
  COMPARE_TTL_MS,
  RESTORE_TTL_MS,
  DELETE_TTL_MS,
  DEFAULT_MAX_RECORDS,
  SnapshotCapabilityStoreError,
  createSnapshotCapabilityStore,
} = require('../src/main/snapshot-capability-store');

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

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof SnapshotCapabilityStoreError && error.code === code);
}

const digest = character => `sha256:${character.repeat(64)}`;
const projectInstanceId = `instance_${'a'.repeat(24)}`;

function owner(overrides = {}) {
  return {
    ownerId: 'window_main',
    projectInstanceId,
    ownerGeneration: 7,
    ...overrides,
  };
}

function compareBinding(overrides = {}) {
  return {
    snapshotId: 'snapshot_a',
    snapshotManifestDigest: digest('1'),
    publishedIdentityDigest: digest('2'),
    authorityDigest: digest('3'),
    currentMutationGeneration: 11,
    currentFileRevisionSetDigest: digest('4'),
    comparisonDigest: digest('5'),
    files: [{
      fileId: 'file_markdown_a',
      kind: 'markdown',
      diffId: 'diff_a',
      restorable: true,
      truncated: false,
      diffCursors: ['cursor_a_1', 'cursor_a_2'],
    }, {
      fileId: 'file_image_a',
      kind: 'image',
      diffId: 'diff_image_a',
      restorable: false,
      truncated: false,
      diffCursors: [],
    }],
    ...overrides,
  };
}

function current(overrides = {}) {
  return {
    snapshotId: 'snapshot_a',
    snapshotManifestDigest: digest('1'),
    publishedIdentityDigest: digest('2'),
    currentMutationGeneration: 11,
    currentFileRevisionSetDigest: digest('4'),
    comparisonDigest: digest('5'),
    ...overrides,
  };
}

function restorePrepare(compareCapabilityId, selectedIds = ['file_markdown_a']) {
  return {
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_PREPARE_REQUEST,
    projectInstanceId,
    compareCapabilityId,
    selectedIds,
    confirmation: 'PREPARE_SELECTED_MARKDOWN_RESTORE',
  };
}

console.log('\nSnapshot capability store verification');

test('TTL constants remain frozen by capability kind', () => {
  assert.strictEqual(COMPARE_TTL_MS, 10 * 60 * 1000);
  assert.strictEqual(RESTORE_TTL_MS, 10 * 60 * 1000);
  assert.strictEqual(DELETE_TTL_MS, 5 * 60 * 1000);
});

test('compare capability seals immutable snapshot authority, files and diff cursors', () => {
  let idByte = 1;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const issued = store.issueCompare(owner(), compareBinding());
  assert.match(issued.capabilityId, /^snapshot_cap_[a-f0-9]{32}$/);
  const record = store.inspect(issued.capabilityId);
  assert.deepStrictEqual(Object.keys(record), schema.KEYS.CAPABILITY);
  assert.strictEqual(record.kind, 'SNAPSHOT_COMPARE');
  assert.strictEqual(record.singleUse, false);
  assert.strictEqual(record.consumedAt, null);
  const first = store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: issued.capabilityId,
    diffId: 'diff_a',
    pageToken: null,
  }, current());
  assert.deepStrictEqual(first, {
    capabilityId: issued.capabilityId,
    fileId: 'file_markdown_a',
    diffId: 'diff_a',
    pageToken: null,
    pageIndex: 0,
  });
  assert.strictEqual(store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: issued.capabilityId,
    diffId: 'diff_a',
    pageToken: 'cursor_a_1',
  }, current()).pageIndex, 1);
  assert.strictEqual(store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: issued.capabilityId,
    diffId: 'diff_a',
    pageToken: 'cursor_a_2',
  }, current()).pageIndex, 2);
  expectCode('SNAPSHOT_CAPABILITY_NOT_FOUND', () => store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: issued.capabilityId,
    diffId: 'diff_a',
    pageToken: 'foreign_cursor',
  }, current()));
  assert.strictEqual(store.inspect(issued.capabilityId).capabilityId, issued.capabilityId);
});

test('restore capability accepts only unique sealed restorable Markdown IDs and burns once', () => {
  let idByte = 10;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const compare = store.issueCompare(owner(), compareBinding());
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(), restorePrepare(compare.capabilityId, ['file_markdown_a', 'file_markdown_a']), current()
  ));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(), restorePrepare(compare.capabilityId, ['file_image_a']), current()
  ));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueRestore(owner(), {
    ...restorePrepare(compare.capabilityId),
    path: 'chapter.md',
  }, current()));
  const restore = store.issueRestore(owner(), restorePrepare(compare.capabilityId), current());
  const record = store.inspect(restore.capabilityId);
  assert.strictEqual(record.kind, 'SNAPSHOT_RESTORE');
  assert.strictEqual(record.singleUse, true);
  expectCode('SNAPSHOT_CAPABILITY_NOT_FOUND', () => store.consumeRestore(
    owner({ ownerId: 'window_foreign' }),
    {
      schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
      projectInstanceId,
      restoreCapabilityId: restore.capabilityId,
      confirmation: 'RESTORE_SELECTED_MARKDOWN',
    },
    current()
  ));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.consumeRestore(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
    projectInstanceId,
    restoreCapabilityId: restore.capabilityId,
    confirmation: 'WRONG_PHRASE',
  }, current()));
  assert(store.inspect(restore.capabilityId));
  const consumed = store.consumeRestore(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
    projectInstanceId,
    restoreCapabilityId: restore.capabilityId,
    confirmation: 'RESTORE_SELECTED_MARKDOWN',
  }, current());
  assert(consumed.record.consumedAt);
  assert.deepStrictEqual(consumed.selection.selectedIds, ['file_markdown_a']);
  assert.strictEqual(consumed.selected[0].fileId, 'file_markdown_a');
  assert(!Object.hasOwn(consumed.selected[0], 'path'));
  expectCode('SNAPSHOT_CAPABILITY_REPLAYED', () => store.consumeRestore(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
    projectInstanceId,
    restoreCapabilityId: restore.capabilityId,
    confirmation: 'RESTORE_SELECTED_MARKDOWN',
  }, current()));
});

test('delete capability binds exact published identity, confirmation and current revision authority', () => {
  let idByte = 30;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const binding = {
    snapshotId: 'snapshot_a',
    snapshotManifestDigest: digest('1'),
    publishedIdentityDigest: digest('2'),
    currentMutationGeneration: 11,
    currentFileRevisionSetDigest: digest('4'),
  };
  const issued = store.issueDelete(owner(), binding);
  const peeked = store.peekDelete(owner(), { deleteCapabilityId: issued.capabilityId });
  assert.strictEqual(peeked.record.capabilityId, issued.capabilityId);
  assert.strictEqual(peeked.record.consumedAt, null);
  assert.deepStrictEqual(peeked.binding, binding);
  assert.strictEqual(store.inspect(issued.capabilityId).consumedAt, null);
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.peekDelete(owner(), {
    deleteCapabilityId: issued.capabilityId,
    path: '/tmp/secret',
  }));
  assert(store.inspect(issued.capabilityId));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.consumeDelete(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST,
    projectInstanceId,
    deleteCapabilityId: issued.capabilityId,
    confirmation: 'WRONG_PHRASE',
  }, binding));
  assert(store.inspect(issued.capabilityId));
  const consumed = store.consumeDelete(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST,
    projectInstanceId,
    deleteCapabilityId: issued.capabilityId,
    confirmation: 'DELETE_SNAPSHOT',
  }, binding);
  assert.strictEqual(consumed.binding.publishedIdentityDigest, digest('2'));
  assert(consumed.record.consumedAt);
});

test('mutation, revision, manifest and identity drift revoke stale capabilities fail closed', () => {
  let idByte = 40;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const compare = store.issueCompare(owner(), compareBinding());
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(),
    restorePrepare(compare.capabilityId),
    current({ currentFileRevisionSetDigest: digest('9') })
  ));
  expectCode('SNAPSHOT_CAPABILITY_REPLAYED', () => store.issueRestore(
    owner(), restorePrepare(compare.capabilityId), current()
  ));
  const mutationDrift = store.issueCompare(owner(), compareBinding());
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(),
    restorePrepare(mutationDrift.capabilityId),
    current({ currentMutationGeneration: 12 })
  ));
  const manifestDrift = store.issueCompare(owner(), compareBinding());
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(),
    restorePrepare(manifestDrift.capabilityId),
    current({ snapshotManifestDigest: digest('6') })
  ));
  const publishedDrift = store.issueCompare(owner(), compareBinding());
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(),
    restorePrepare(publishedDrift.capabilityId),
    current({ publishedIdentityDigest: digest('7') })
  ));
  const comparisonDrift = store.issueCompare(owner(), compareBinding());
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.issueRestore(
    owner(),
    restorePrepare(comparisonDrift.capabilityId),
    current({ comparisonDigest: digest('8') })
  ));
  const deletion = store.issueDelete(owner(), {
    snapshotId: 'snapshot_a', snapshotManifestDigest: digest('1'),
    publishedIdentityDigest: digest('2'), currentMutationGeneration: 11,
    currentFileRevisionSetDigest: digest('4'),
  });
  expectCode('STALE_SNAPSHOT_CAPABILITY', () => store.consumeDelete(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST,
    projectInstanceId,
    deleteCapabilityId: deletion.capabilityId,
    confirmation: 'DELETE_SNAPSHOT',
  }, {
    snapshotId: 'snapshot_a', snapshotManifestDigest: digest('1'),
    publishedIdentityDigest: digest('8'), currentMutationGeneration: 11,
    currentFileRevisionSetDigest: digest('4'),
  }));
});

test('TTL expiry, bounded capacity and project switch revoke without reissuing IDs', () => {
  let time = 1_800_000_000_000;
  let idByte = 50;
  const store = createSnapshotCapabilityStore({
    clock: () => time,
    compareTtlMs: 1000,
    maxRecords: 2,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const first = store.issueCompare(owner(), compareBinding({ snapshotId: 'snapshot_1' }));
  const second = store.issueCompare(owner(), compareBinding({ snapshotId: 'snapshot_2' }));
  const third = store.issueCompare(owner(), compareBinding({ snapshotId: 'snapshot_3' }));
  assert.strictEqual(store.stats().capabilities, 2);
  assert.strictEqual(store.inspect(first.capabilityId), null);
  assert(store.inspect(second.capabilityId));
  assert.strictEqual(store.invalidateProject({ projectInstanceId }), 2);
  assert.strictEqual(store.stats().capabilities, 0);
  const expiring = store.issueCompare(owner(), compareBinding());
  time += 1000;
  expectCode('SNAPSHOT_CAPABILITY_EXPIRED', () => store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: expiring.capabilityId,
    diffId: 'diff_a',
    pageToken: null,
  }, current()));
  assert.notStrictEqual(third.capabilityId, expiring.capabilityId);
});

test('owner-specific release prevents an old finally from releasing a newer owner generation', () => {
  let idByte = 70;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  const oldOwner = owner({ ownerGeneration: 1 });
  const newOwner = owner({ ownerGeneration: 2 });
  const oldCapability = store.issueCompare(oldOwner, compareBinding());
  const newCapability = store.issueCompare(newOwner, compareBinding());
  assert.strictEqual(store.releaseOwner(oldOwner), 1);
  assert.strictEqual(store.inspect(oldCapability.capabilityId), null);
  assert(store.inspect(newCapability.capabilityId));
  expectCode('SNAPSHOT_CAPABILITY_NOT_FOUND', () => store.release(oldOwner, {
    capabilityId: newCapability.capabilityId,
  }));
  assert(store.inspect(newCapability.capabilityId));
  assert.strictEqual(store.release(newOwner, { capabilityId: newCapability.capabilityId }), true);
});

test('more than 2000 issue/release cycles keep auxiliary state bounded and IDs unique', () => {
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    maxRecords: 4,
    randomBytes(size) { return Buffer.alloc(size, 0xab); },
  });
  const issuedIds = new Set();
  let firstCapabilityId = null;
  for (let index = 0; index < 2048; index += 1) {
    const issued = store.issueCompare(owner(), compareBinding({ snapshotId: `snapshot_${index}` }));
    if (firstCapabilityId === null) firstCapabilityId = issued.capabilityId;
    assert(!issuedIds.has(issued.capabilityId));
    issuedIds.add(issued.capabilityId);
    assert.strictEqual(store.release(owner(), { capabilityId: issued.capabilityId }), true);
  }
  const stats = store.stats();
  assert.strictEqual(issuedIds.size, 2048);
  assert.strictEqual(stats.capabilities, 0);
  assert.strictEqual(stats.allocatedCount, 2048);
  assert(stats.tombstones <= DEFAULT_MAX_RECORDS * 8);
  const recreatedStore = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, 0xab); },
  });
  const afterRecreate = recreatedStore.issueCompare(owner(), compareBinding());
  assert(!issuedIds.has(afterRecreate.capabilityId));
  assert.strictEqual(recreatedStore.release(owner(), {
    capabilityId: afterRecreate.capabilityId,
  }), true);
  assert.throws(() => store.resolveDiff(owner(), {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId,
    compareCapabilityId: firstCapabilityId,
    diffId: 'diff_a',
    pageToken: null,
  }, current()), error => error instanceof SnapshotCapabilityStoreError &&
    ['SNAPSHOT_CAPABILITY_NOT_FOUND', 'SNAPSHOT_CAPABILITY_REPLAYED'].includes(error.code));
});

test('duplicate sealed IDs/cursors, extra fields and unsafe capability inputs are rejected', () => {
  let idByte = 90;
  const store = createSnapshotCapabilityStore({
    clock: () => 1_800_000_000_000,
    randomBytes(size) { return Buffer.alloc(size, idByte++); },
  });
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueCompare(owner(), {
    ...compareBinding(),
    rootPath: '/private/manuscript',
  }));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueCompare(owner(), compareBinding({
    files: [compareBinding().files[0], {
      ...compareBinding().files[1],
      fileId: 'file_markdown_a',
    }],
  })));
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueCompare(owner(), compareBinding({
    files: [compareBinding().files[0], {
      ...compareBinding().files[1],
      diffCursors: ['cursor_a_1'],
    }],
  })));
  const accessor = owner();
  Object.defineProperty(accessor, 'extra', { enumerable: true, get() { throw new Error('must not run'); } });
  expectCode('INVALID_SNAPSHOT_CAPABILITY', () => store.issueCompare(accessor, compareBinding()));
  let ownerGetterInvocations = 0;
  const ownerAccessor = { ownerId: 'window_main', ownerGeneration: 7 };
  Object.defineProperty(ownerAccessor, 'projectInstanceId', {
    enumerable: true,
    get() {
      ownerGetterInvocations += 1;
      throw new Error('owner getter must not run');
    },
  });
  const compare = store.issueCompare(owner(), compareBinding());
  const invalidOwnerEntries = [
    () => store.issueCompare(ownerAccessor, compareBinding()),
    () => store.resolveDiff(ownerAccessor, {
      schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
      projectInstanceId,
      compareCapabilityId: compare.capabilityId,
      diffId: 'diff_a',
      pageToken: null,
    }, current()),
    () => store.issueRestore(
      ownerAccessor,
      restorePrepare(compare.capabilityId),
      current()
    ),
    () => store.consumeRestore(ownerAccessor, {
      schema: schema.SCHEMAS.SNAPSHOT_RESTORE_REQUEST,
      projectInstanceId,
      restoreCapabilityId: `snapshot_cap_${'a'.repeat(32)}`,
      confirmation: 'RESTORE_SELECTED_MARKDOWN',
    }, current()),
    () => store.issueDelete(ownerAccessor, {
      snapshotId: 'snapshot_a',
      snapshotManifestDigest: digest('1'),
      publishedIdentityDigest: digest('2'),
      currentMutationGeneration: 11,
      currentFileRevisionSetDigest: digest('4'),
    }),
    () => store.consumeDelete(ownerAccessor, {
      schema: schema.SCHEMAS.SNAPSHOT_DELETE_REQUEST,
      projectInstanceId,
      deleteCapabilityId: `snapshot_cap_${'b'.repeat(32)}`,
      confirmation: 'DELETE_SNAPSHOT',
    }, {
      snapshotId: 'snapshot_a',
      snapshotManifestDigest: digest('1'),
      publishedIdentityDigest: digest('2'),
      currentMutationGeneration: 11,
      currentFileRevisionSetDigest: digest('4'),
    }),
    () => store.peekDelete(ownerAccessor, {
      deleteCapabilityId: `snapshot_cap_${'b'.repeat(32)}`,
    }),
    () => store.release(ownerAccessor, { capabilityId: compare.capabilityId }),
    () => store.releaseOwner(ownerAccessor),
  ];
  for (const invoke of invalidOwnerEntries) {
    expectCode('INVALID_SNAPSHOT_CAPABILITY', invoke);
  }
  assert.strictEqual(ownerGetterInvocations, 0);
});

console.log(`\n${passed}/${passed} snapshot capability checks passed.\n`);
