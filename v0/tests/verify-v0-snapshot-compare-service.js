'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/evidence-delivery-schema');
const { createLocalOperationService } = require('../src/main/local-operation-service');
const {
  SnapshotCapabilityStoreError,
  createSnapshotCapabilityStore,
} = require('../src/main/snapshot-capability-store');
const {
  DIFF_BUILD_PEAK_MAX_BYTES,
  DIFF_CONTEXT_TOTAL_MAX_BYTES,
  DIFF_PAGE_MAX_BYTES,
  SnapshotCompareServiceError,
  createSnapshotCompareService,
} = require('../src/main/snapshot-compare-service');

const PROJECT_ID = `instance_${'a'.repeat(24)}`;
const SNAPSHOT_ID = 'snapshot_compare_a';
const MANIFEST = `sha256:${'1'.repeat(64)}`;
const PUBLISHED = `sha256:${'2'.repeat(64)}`;
const CURRENT_SET = `sha256:${'3'.repeat(64)}`;
const CREATED_AT = '2026-08-08T08:00:00.000Z';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function digest(content) {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function markdown(fileId, filePath, content, state = 'available') {
  if (state !== 'available') {
    return {
      fileId, path: filePath, kind: 'markdown', state,
      byteLength: null, sha256: null, revision: null, content: null,
    };
  }
  const sha256 = digest(content);
  return {
    fileId, path: filePath, kind: 'markdown', state,
    byteLength: Buffer.byteLength(content, 'utf8'), sha256,
    revision: sha256.slice(7), content,
  };
}

function snapshotMarkdown(fileId, filePath, content) {
  const { state, ...file } = markdown(fileId, filePath, content);
  return file;
}

function image(fileId, filePath, content, state = 'available') {
  if (state !== 'available') {
    return {
      fileId, path: filePath, kind: 'image', state,
      byteLength: null, sha256: null, revision: null, content: null,
    };
  }
  const sha256 = digest(content);
  return {
    fileId, path: filePath, kind: 'image', state,
    byteLength: Buffer.byteLength(content), sha256,
    revision: sha256.slice(7), content: null,
  };
}

function snapshotImage(fileId, filePath, content) {
  const { state, ...file } = image(fileId, filePath, content);
  return file;
}

function owner(overrides = {}) {
  return {
    ownerId: 'window_main',
    projectInstanceId: PROJECT_ID,
    ownerGeneration: 7,
    ...overrides,
  };
}

function compareRequest(overrides = {}) {
  return {
    schema: schema.SCHEMAS.SNAPSHOT_COMPARE_REQUEST,
    projectInstanceId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    ...overrides,
  };
}

function diffRequest(comparison, diffId, pageToken = null, overrides = {}) {
  return {
    schema: schema.SCHEMAS.SNAPSHOT_DIFF_REQUEST,
    projectInstanceId: PROJECT_ID,
    compareCapabilityId: comparison.compareCapabilityId,
    diffId,
    pageToken,
    ...overrides,
  };
}

function defaultSnapshot() {
  return {
    projectInstanceId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotManifestDigest: MANIFEST,
    publishedIdentityDigest: PUBLISHED,
    createdAt: CREATED_AT,
    files: [
      snapshotMarkdown('file_conflict', 'conflict.md', 'snapshot conflict\n'),
      snapshotImage('file_image', 'images/cover.png', 'old-image'),
      snapshotMarkdown('file_missing', 'missing.md', 'restore me\n'),
      snapshotMarkdown('file_modified', 'modified.md', 'old line\n'),
      snapshotMarkdown('file_same', 'same.md', 'same\n'),
      snapshotMarkdown('file_unavailable', 'unavailable.md', 'snapshot unavailable\n'),
    ],
  };
}

function defaultCurrent() {
  return {
    projectInstanceId: PROJECT_ID,
    mutationGeneration: 19,
    fileRevisionSetDigest: CURRENT_SET,
    files: [
      markdown('file_added', 'added.md', 'new file\n'),
      markdown('file_conflict', 'conflict.md', '', 'conflict'),
      image('file_image', 'images/cover.png', 'new-image'),
      markdown('file_modified', 'modified.md', 'new line\n'),
      markdown('file_same', 'same.md', 'same\n'),
      markdown('file_unavailable', 'unavailable.md', '', 'unavailable'),
    ],
  };
}

function setup(overrides = {}) {
  let now = 1_800_000_000_000;
  let randomValue = 1;
  let liveSnapshot = {
    snapshotId: SNAPSHOT_ID,
    snapshotManifestDigest: MANIFEST,
    publishedIdentityDigest: PUBLISHED,
  };
  let liveCurrent = {
    projectInstanceId: PROJECT_ID,
    mutationGeneration: 19,
    fileRevisionSetDigest: CURRENT_SET,
  };
  let activeProject = PROJECT_ID;
  let activeOwnerGeneration = 7;
  const calls = [];
  const issuedBindings = [];
  const localOperations = createLocalOperationService({
    clock: () => now,
    randomBytes: size => Buffer.alloc(size, randomValue++),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  const rawStore = createSnapshotCapabilityStore({
    clock: () => now,
    randomBytes: size => Buffer.alloc(size, randomValue++),
  });
  const capabilityStore = {
    issueCompare(bindingOwner, binding) {
      issuedBindings.push(binding);
      return rawStore.issueCompare(bindingOwner, binding);
    },
    resolveDiff: (...args) => rawStore.resolveDiff(...args),
    invalidateProject: (...args) => rawStore.invalidateProject(...args),
    release: (...args) => rawStore.release(...args),
    inspect: (...args) => rawStore.inspect(...args),
  };
  const service = createSnapshotCompareService({
    localOperations,
    capabilityStore,
    clock: () => now,
    randomBytes: size => Buffer.alloc(size, randomValue++),
    async acquireLease(binding) {
      calls.push(['lease', binding]);
      return Object.freeze({ leaseId: 'compare-lease' });
    },
    async releaseLease(lease, binding) { calls.push(['release', lease, binding]); },
    assertOwnerCurrent(binding) {
      calls.push(['assert', binding]);
      if (binding.projectInstanceId !== activeProject ||
          binding.ownerGeneration !== activeOwnerGeneration) {
        throw Object.assign(new Error('project changed'), { code: 'PROJECT_CHANGED' });
      }
    },
    assertProjectCurrent(binding) {
      calls.push(['assertProject', binding]);
      if (binding.projectInstanceId !== activeProject) {
        throw Object.assign(new Error('project changed'), { code: 'PROJECT_CHANGED' });
      }
    },
    async settleWatcherBarrier(binding) {
      calls.push(['barrier', binding]);
      return { projectInstanceId: PROJECT_ID, mutationGeneration: 19 };
    },
    async readSnapshot(binding) {
      calls.push(['snapshot', binding]);
      return overrides.snapshot ? overrides.snapshot() : defaultSnapshot();
    },
    async readCurrent(binding) {
      calls.push(['current', binding]);
      return overrides.current ? overrides.current() : defaultCurrent();
    },
    async readSnapshotAuthority(binding) {
      calls.push(['snapshotAuthority', binding]);
      return liveSnapshot;
    },
    async readCurrentAuthority(binding) {
      calls.push(['currentAuthority', binding]);
      return liveCurrent;
    },
    async acquireReadLease(binding) {
      calls.push(['acquireReadLease', binding]);
      return Object.freeze({ leaseId: 'read-lease' });
    },
    async releaseReadLease(lease, binding) {
      calls.push(['releaseReadLease', lease, binding]);
    },
    assertReadLeaseCurrent(binding) {
      calls.push(['assertReadLease', binding]);
      if (binding.owner.projectInstanceId !== activeProject) {
        throw Object.assign(new Error('project changed'), { code: 'PROJECT_CHANGED' });
      }
    },
    async listSnapshots(binding) {
      calls.push(['list', binding]);
      return {
        items: [{
          snapshotId: SNAPSHOT_ID,
          createdAt: CREATED_AT,
          status: 'available',
          markdownCount: 5,
          imageCount: 1,
          totalBytes: 1234,
          snapshotManifestDigest: MANIFEST,
        }],
        unavailableCount: 2,
        capacity: {
          maxSnapshots: 20,
          maxPrivateBytes: 1024 * 1024,
          usedSnapshots: 1,
          usedPrivateBytes: 1234,
        },
      };
    },
    ...overrides.options,
  });
  return {
    service,
    calls,
    issuedBindings,
    rawStore,
    setNow(value) { now = value; },
    setLiveSnapshot(value) { liveSnapshot = value; },
    setLiveCurrent(value) { liveCurrent = value; },
    switchProject(value) { activeProject = value; },
    switchOwnerGeneration(value) { activeOwnerGeneration = value; },
  };
}

function expectServiceCode(code, promise) {
  return assert.rejects(promise, error =>
    error instanceof SnapshotCompareServiceError && error.code === code);
}

(async () => {
  console.log('\nSnapshot compare service verification');

  await test('list returns only the bounded public summary and preserves unavailable truth', async () => {
    const state = setup();
    const result = await state.service.list(owner(), {
      schema: schema.SCHEMAS.SNAPSHOT_LIST_REQUEST,
      projectInstanceId: PROJECT_ID,
    });
    assert.strictEqual(result.schema, schema.SCHEMAS.SNAPSHOT_LIST);
    assert.strictEqual(result.unavailableCount, 2);
    assert.deepStrictEqual(Object.keys(result.items[0]), [
      'snapshotId', 'createdAt', 'status', 'markdownCount', 'imageCount',
      'totalBytes', 'snapshotManifestDigest',
    ]);
    assert(!JSON.stringify(result).includes('/Users/'));
  });

  await test('exact comparison covers same/modified/missing/added/conflict/unavailable and image identity only', async () => {
    const state = setup();
    const result = await state.service.compare(owner(), compareRequest());
    assert.deepStrictEqual(Object.keys(result), [
      'schema', 'projectInstanceId', 'snapshotId', 'items', 'createdAt',
      'comparisonDigest', 'compareCapabilityId',
    ]);
    const statuses = Object.fromEntries(result.items.map(item => [item.displayPath, item.status]));
    assert.deepStrictEqual(statuses, {
      'added.md': 'added',
      'conflict.md': 'conflict',
      'images/cover.png': 'modified',
      'missing.md': 'missing',
      'modified.md': 'modified',
      'same.md': 'same',
      'unavailable.md': 'unavailable',
    });
    const imageItem = result.items.find(item => item.kind === 'image');
    assert.strictEqual(imageItem.diffId, null);
    assert.strictEqual(JSON.stringify(result).includes('old-image'), false);
    assert.strictEqual(JSON.stringify(result).includes('new-image'), false);
    const binding = state.issuedBindings[0];
    assert.strictEqual(binding.snapshotManifestDigest, MANIFEST);
    assert.strictEqual(binding.publishedIdentityDigest, PUBLISHED);
    assert.strictEqual(binding.currentMutationGeneration, 19);
    assert.strictEqual(binding.currentFileRevisionSetDigest, CURRENT_SET);
    assert.strictEqual(binding.comparisonDigest, result.comparisonDigest);
    assert.strictEqual(binding.files.length, result.items.length);
    assert.match(binding.authorityDigest, /^sha256:[a-f0-9]{64}$/);
  });

  await test('comparisonDigest is the exact frozen private comparison digest', async () => {
    const state = setup();
    const result = await state.service.compare(owner(), compareRequest());
    const snapshot = defaultSnapshot();
    const current = defaultCurrent();
    const byPath = new Map(result.items.map(item => [item.displayPath, item]));
    const snapshotByPath = new Map(snapshot.files.map(item => [item.path, item]));
    const currentByPath = new Map(current.files.map(item => [item.path, item]));
    const privateComparison = {
      schema: schema.SCHEMAS.SNAPSHOT_COMPARISON,
      projectInstanceId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotManifestDigest: MANIFEST,
      currentMutationGeneration: 19,
      currentFileRevisionSetDigest: CURRENT_SET,
      items: result.items.map(publicItem => {
        const snap = snapshotByPath.get(publicItem.displayPath);
        const currentFile = currentByPath.get(publicItem.displayPath);
        return {
          fileId: publicItem.fileId,
          kind: publicItem.kind,
          status: publicItem.status,
          snapshotRevision: snap?.revision || null,
          currentRevision: currentFile?.state === 'available' ? currentFile.revision : null,
          snapshotSha256: snap?.sha256 || null,
          currentSha256: currentFile?.state === 'available' ? currentFile.sha256 : null,
          byteDelta: publicItem.byteDelta,
          diffId: byPath.get(publicItem.displayPath).diffId,
        };
      }),
      createdAt: new Date(1_800_000_000_000).toISOString(),
      comparisonDigest: null,
    };
    assert.strictEqual(result.comparisonDigest, schema.digestObject(
      schema.SCHEMAS.SNAPSHOT_COMPARISON, privateComparison, 'comparisonDigest'
    ));
  });

  await test('Markdown diff is Main-owned, bounded, paginated and rejects cursor replay', async () => {
    const before = 'header\nfooter\n';
    const inserted = Array.from({ length: 12000 }, (_, index) => `new-${index}`).join('\n');
    const after = `header\n${inserted}\nfooter\n`;
    const state = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [snapshotMarkdown('file_large', 'large.md', before)],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files: [markdown('file_large', 'large.md', after)],
      }),
    });
    const comparison = await state.service.compare(owner(), compareRequest());
    const diffId = comparison.items[0].diffId;
    const first = await state.service.readDiff(owner(), diffRequest(comparison, diffId));
    assert(first.pageCount > 1);
    assert.strictEqual(first.pageIndex, 0);
    assert(first.nextPageToken);
    assert(Buffer.byteLength(JSON.stringify(first), 'utf8') <= DIFF_PAGE_MAX_BYTES);
    const second = await state.service.readDiff(owner(), diffRequest(
      comparison, diffId, first.nextPageToken
    ));
    assert.strictEqual(second.pageIndex, 1);
    await assert.rejects(
      state.service.readDiff(owner(), diffRequest(comparison, diffId, first.nextPageToken)),
      error => error instanceof SnapshotCapabilityStoreError &&
        error.code === 'SNAPSHOT_CAPABILITY_NOT_FOUND'
    );
  });

  await test('line/output truncation remains visible and makes Markdown non-restorable', async () => {
    const before = `${'a'.repeat(64 * 1024 + 1)}\n`;
    const after = `${'b'.repeat(64 * 1024 + 1)}\n`;
    const state = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [snapshotMarkdown('file_truncated', 'truncated.md', before)],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files: [markdown('file_truncated', 'truncated.md', after)],
      }),
    });
    const comparison = await state.service.compare(owner(), compareRequest());
    const page = await state.service.readDiff(owner(), diffRequest(
      comparison, comparison.items[0].diffId
    ));
    assert.strictEqual(page.truncated, true);
    assert.deepStrictEqual(page.hunks, []);
    assert.strictEqual(state.issuedBindings[0].files[0].restorable, false);
    assert.strictEqual(state.issuedBindings[0].files[0].truncated, true);
  });

  await test('same-size revision/mutation drift revokes compare capability before body release', async () => {
    const state = setup();
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    state.setLiveCurrent({
      projectInstanceId: PROJECT_ID,
      mutationGeneration: 20,
      fileRevisionSetDigest: `sha256:${'9'.repeat(64)}`,
    });
    await assert.rejects(
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)),
      error => error instanceof SnapshotCapabilityStoreError &&
        error.code === 'STALE_SNAPSHOT_CAPABILITY'
    );
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND',
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)));
  });

  await test('snapshot manifest/published identity drift revokes compare capability', async () => {
    const state = setup();
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    state.setLiveSnapshot({
      snapshotId: SNAPSHOT_ID,
      snapshotManifestDigest: `sha256:${'8'.repeat(64)}`,
      publishedIdentityDigest: PUBLISHED,
    });
    await assert.rejects(
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)),
      error => error instanceof SnapshotCapabilityStoreError &&
        error.code === 'STALE_SNAPSHOT_CAPABILITY'
    );
  });

  await test('TTL expiry and project switch both invalidate sealed diff context', async () => {
    const expired = setup();
    const comparison = await expired.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    expired.setNow(1_800_000_000_000 + 10 * 60 * 1000);
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND',
      expired.service.readDiff(owner(), diffRequest(comparison, modified.diffId)));

    const switched = setup();
    const second = await switched.service.compare(owner(), compareRequest());
    const secondModified = second.items.find(item => item.displayPath === 'modified.md');
    assert.strictEqual(switched.service.invalidateProject({ projectInstanceId: PROJECT_ID }), 1);
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND',
      switched.service.readDiff(owner(), diffRequest(second, secondModified.diffId)));
  });

  await test('global byte budget evicts and releases old diff bytes instead of retaining count-bounded GiBs', async () => {
    const state = setup({ options: { contextBudgetBytes: 10 * 1024 } });
    const first = await state.service.compare(owner(), compareRequest());
    const firstModified = first.items.find(item => item.displayPath === 'modified.md');
    const second = await state.service.compare(owner(), compareRequest());
    assert.notStrictEqual(second.compareCapabilityId, first.compareCapabilityId);
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND',
      state.service.readDiff(owner(), diffRequest(first, firstModified.diffId)));
    assert.strictEqual(state.rawStore.inspect(first.compareCapabilityId), null);
  });

  await test('an old expiry callback cannot remove a same-ID replacement context/capability/timer', async () => {
    const reusedCapabilityId = `snapshot_cap_${'e'.repeat(32)}`;
    const scheduled = [];
    const activeTimers = new Set();
    let liveRecord = null;
    let liveBinding = null;
    let generation = 0;
    const hostileStore = {
      issueCompare(_bindingOwner, binding) {
        generation += 1;
        liveBinding = binding;
        liveRecord = Object.freeze({ capabilityId: reusedCapabilityId, generation });
        return Object.freeze({
          capabilityId: reusedCapabilityId,
          expiresAt: '2027-01-15T08:01:00.000Z',
        });
      },
      resolveDiff(_bindingOwner, request) {
        if (!liveRecord) throw Object.assign(new Error('missing'), {
          name: 'SnapshotCapabilityStoreError', code: 'SNAPSHOT_CAPABILITY_NOT_FOUND',
        });
        const file = liveBinding.files.find(item => item.diffId === request.diffId);
        if (!file) throw Object.assign(new Error('missing'), {
          name: 'SnapshotCapabilityStoreError', code: 'SNAPSHOT_CAPABILITY_NOT_FOUND',
        });
        return Object.freeze({
          capabilityId: reusedCapabilityId,
          fileId: file.fileId,
          diffId: file.diffId,
          pageToken: request.pageToken,
          pageIndex: 0,
        });
      },
      invalidateProject() {
        liveRecord = null;
        liveBinding = null;
        return 1;
      },
      release(_bindingOwner, request) {
        if (request.capabilityId === reusedCapabilityId) {
          liveRecord = null;
          liveBinding = null;
          return true;
        }
        return false;
      },
      inspect(capabilityId) {
        return capabilityId === reusedCapabilityId ? liveRecord : null;
      },
    };
    const state = setup({ options: {
      capabilityStore: hostileStore,
      setTimer(callback) {
        const timer = { callback, unref() {} };
        scheduled.push(timer);
        activeTimers.add(timer);
        return timer;
      },
      clearTimer(timer) { activeTimers.delete(timer); },
    } });
    const first = await state.service.compare(owner(), compareRequest());
    const oldTimer = scheduled[0];
    assert.strictEqual(first.compareCapabilityId, reusedCapabilityId);
    assert.strictEqual(state.service.invalidateProject({ projectInstanceId: PROJECT_ID }), 1);
    assert.strictEqual(activeTimers.has(oldTimer), false);

    const replacement = await state.service.compare(owner(), compareRequest());
    const replacementRecord = hostileStore.inspect(reusedCapabilityId);
    const replacementTimer = scheduled[1];
    assert.strictEqual(replacement.compareCapabilityId, reusedCapabilityId);
    assert.strictEqual(activeTimers.has(replacementTimer), true);

    oldTimer.callback();
    assert.strictEqual(hostileStore.inspect(reusedCapabilityId), replacementRecord);
    assert.strictEqual(activeTimers.has(replacementTimer), true);
    const modified = replacement.items.find(item => item.displayPath === 'modified.md');
    const page = await state.service.readDiff(
      owner(), diffRequest(replacement, modified.diffId)
    );
    assert.strictEqual(page.diffId, modified.diffId);
    assert.strictEqual(activeTimers.has(replacementTimer), true);
  });

  await test('hostile high-edit-distance Markdown uses the bounded linear coarse diff path', async () => {
    const before = Array.from({ length: 55000 }, (_, index) => `old-${index}`).join('\n');
    const after = Array.from({ length: 55000 }, (_, index) => `new-${index}`).join('\n');
    const state = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [snapshotMarkdown('file_hostile', 'hostile.md', before)],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files: [markdown('file_hostile', 'hostile.md', after)],
      }),
    });
    const comparison = await state.service.compare(owner(), compareRequest());
    assert.strictEqual(comparison.items[0].status, 'modified');
    assert(comparison.items[0].diffId);
    const first = await state.service.readDiff(owner(), diffRequest(
      comparison, comparison.items[0].diffId
    ));
    assert(Buffer.byteLength(JSON.stringify(first), 'utf8') <= DIFF_PAGE_MAX_BYTES);
  });

  await test('requests accept only opaque IDs/cursors and never accept path or body', async () => {
    const state = setup();
    await expectServiceCode('SNAPSHOT_COMPARE_INVALID', state.service.compare(owner(), {
      ...compareRequest(),
      path: 'modified.md',
    }));
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    await expectServiceCode('SNAPSHOT_COMPARE_INVALID', state.service.readDiff(owner(), {
      ...diffRequest(comparison, modified.diffId),
      body: 'injected author text',
    }));
    assert(state.calls.every(call => !JSON.stringify(call).includes('/Users/')));
  });

  await test('missing production snapshot/current adapters fail closed without filesystem fallback', async () => {
    const state = setup({ options: { readSnapshot: undefined } });
    await expectServiceCode('SNAPSHOT_READER_UNAVAILABLE',
      state.service.compare(owner(), compareRequest()));
    assert.strictEqual(state.calls.filter(call => call[0] === 'current').length, 0);
  });

  await test('current authority enforces 300 Markdown and a frozen aggregate content-byte budget', async () => {
    const tooMany = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files: Array.from({ length: 301 }, (_, index) =>
          markdown(`current_${String(index).padStart(3, '0')}`,
            `file-${String(index).padStart(3, '0')}.md`, '')),
      }),
    });
    await expectServiceCode('SNAPSHOT_COMPARE_INVALID',
      tooMany.service.compare(owner(), compareRequest()));

    const aggregate = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files: [
          markdown('current_a', 'a.md', 'a'.repeat(800)),
          markdown('current_b', 'b.md', 'b'.repeat(800)),
        ],
      }),
      options: { currentMarkdownTotalBudgetBytes: 1024 },
    });
    await expectServiceCode('SNAPSHOT_COMPARE_INVALID',
      aggregate.service.compare(owner(), compareRequest()));
  });

  await test('cooperative aggregate deadline yields to a 10ms hostile timer instead of blocking Main', async () => {
    let timerFired = false;
    const files = Array.from({ length: 80 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      return markdown(`current_${suffix}`, `file-${suffix}.md`,
        `header\n${Array.from({ length: 200 }, (_, line) => `line-${line}`).join('\n')}\n`);
    });
    const state = setup({
      snapshot: () => ({
        projectInstanceId: PROJECT_ID,
        snapshotId: SNAPSHOT_ID,
        snapshotManifestDigest: MANIFEST,
        publishedIdentityDigest: PUBLISHED,
        createdAt: CREATED_AT,
        files: [],
      }),
      current: () => ({
        projectInstanceId: PROJECT_ID,
        mutationGeneration: 19,
        fileRevisionSetDigest: CURRENT_SET,
        files,
      }),
      options: {
        comparisonDeadlineMs: 10,
        async yieldControl() {
          await new Promise(resolve => setTimeout(resolve, 1));
          timerFired = true;
        },
      },
    });
    await expectServiceCode('LOCAL_TASK_TIMEOUT',
      state.service.compare(owner(), compareRequest()));
    assert.strictEqual(timerFired, true);
  });

  await test('post-await owner drift fails list/compare/readDiff and releases issued capabilities', async () => {
    let state;
    state = setup({
      options: {
        async releaseLease() {
          state.switchProject(`instance_${'b'.repeat(24)}`);
        },
      },
    });
    await expectServiceCode('PROJECT_CHANGED', state.service.compare(owner(), compareRequest()));
    assert.strictEqual(state.rawStore.stats().capabilities, 0);

    let generationState;
    const generationTimers = new Set();
    let generationTimersCleared = 0;
    generationState = setup({
      options: {
        setTimer(callback) {
          const timer = { callback, unref() {} };
          generationTimers.add(timer);
          return timer;
        },
        clearTimer(timer) {
          if (generationTimers.delete(timer)) generationTimersCleared += 1;
        },
        async releaseLease() {
          generationState.switchOwnerGeneration(8);
        },
      },
    });
    await expectServiceCode('PROJECT_CHANGED',
      generationState.service.compare(owner(), compareRequest()));
    assert.strictEqual(generationState.rawStore.stats().capabilities, 0);
    assert.strictEqual(generationTimersCleared, 1);

    let listState;
    listState = setup({ options: {
      async listSnapshots() {
        listState.switchProject(`instance_${'b'.repeat(24)}`);
        return { items: [], unavailableCount: 0, capacity: {
          maxSnapshots: 20, maxPrivateBytes: 1024, usedSnapshots: 0, usedPrivateBytes: 0,
        } };
      },
    } });
    await expectServiceCode('PROJECT_CHANGED', listState.service.list(owner(), {
      schema: schema.SCHEMAS.SNAPSHOT_LIST_REQUEST,
      projectInstanceId: PROJECT_ID,
    }));

    let diffState;
    diffState = setup({ options: {
      async releaseReadLease() {
        diffState.switchProject(`instance_${'b'.repeat(24)}`);
      },
    } });
    const comparison = await diffState.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    await expectServiceCode('PROJECT_CHANGED',
      diffState.service.readDiff(owner(), diffRequest(comparison, modified.diffId)));
    assert.strictEqual(diffState.rawStore.inspect(comparison.compareCapabilityId), null);
  });

  await test('post-resolve expiry cannot return a page from a detached diff context', async () => {
    const timers = [];
    let authorityReads = 0;
    let readLeaseReleased = 0;
    const state = setup({ options: {
      setTimer(callback) {
        const timer = { callback, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer() {},
      async readSnapshotAuthority() {
        authorityReads += 1;
        if (authorityReads === 2) timers[0].callback();
        return {
          snapshotId: SNAPSHOT_ID,
          snapshotManifestDigest: MANIFEST,
          publishedIdentityDigest: PUBLISHED,
        };
      },
      async releaseReadLease() { readLeaseReleased += 1; },
    } });
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND',
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)));
    assert.strictEqual(readLeaseReleased, 1);
    assert.strictEqual(state.rawStore.inspect(comparison.compareCapabilityId), null);

    let evictionState;
    let evictionAuthorityReads = 0;
    let evictionLeaseReleased = 0;
    evictionState = setup({ options: {
      contextBudgetBytes: 10 * 1024,
      async readSnapshotAuthority() {
        evictionAuthorityReads += 1;
        if (evictionAuthorityReads === 2) {
          await evictionState.service.compare(owner(), compareRequest());
        }
        return {
          snapshotId: SNAPSHOT_ID,
          snapshotManifestDigest: MANIFEST,
          publishedIdentityDigest: PUBLISHED,
        };
      },
      async releaseReadLease() { evictionLeaseReleased += 1; },
    } });
    const evictedComparison = await evictionState.service.compare(owner(), compareRequest());
    const evictedModified = evictedComparison.items.find(
      item => item.displayPath === 'modified.md'
    );
    await expectServiceCode('SNAPSHOT_CAPABILITY_NOT_FOUND', evictionState.service.readDiff(
      owner(), diffRequest(evictedComparison, evictedModified.diffId)
    ));
    assert.strictEqual(evictionLeaseReleased, 1);
    assert.strictEqual(evictionState.rawStore.inspect(evictedComparison.compareCapabilityId), null);
  });

  await test('coarse diff preserves multi-segment bytes, final newline and cross-page line numbers', async () => {
    async function pagesFor(before, after) {
      const state = setup({
        snapshot: () => ({
          projectInstanceId: PROJECT_ID,
          snapshotId: SNAPSHOT_ID,
          snapshotManifestDigest: MANIFEST,
          publishedIdentityDigest: PUBLISHED,
          createdAt: CREATED_AT,
          files: [snapshotMarkdown('file_semantic', 'semantic.md', before)],
        }),
        current: () => ({
          projectInstanceId: PROJECT_ID,
          mutationGeneration: 19,
          fileRevisionSetDigest: CURRENT_SET,
          files: [markdown('file_semantic', 'semantic.md', after)],
        }),
      });
      const comparison = await state.service.compare(owner(), compareRequest());
      const item = comparison.items[0];
      const pages = [];
      let token = null;
      do {
        const page = await state.service.readDiff(
          owner(), diffRequest(comparison, item.diffId, token)
        );
        pages.push(page);
        token = page.nextPageToken;
      } while (token !== null);
      return pages;
    }

    const segmented = await pagesFor(
      'head\nold-a\nshared\nold-b\ntail\n',
      'head\nnew-a\nshared\nnew-b\ntail\n'
    );
    const segmentedLines = segmented.flatMap(page => page.hunks.flatMap(hunk => hunk.lines));
    assert.strictEqual(
      segmentedLines.filter(line => line.kind === 'delete').map(line => line.text).join(''),
      'old-a\nshared\nold-b\n'
    );
    assert.strictEqual(
      segmentedLines.filter(line => line.kind === 'insert').map(line => line.text).join(''),
      'new-a\nshared\nnew-b\n'
    );

    const finalNewline = await pagesFor('same\n', 'same');
    const finalLines = finalNewline.flatMap(page => page.hunks.flatMap(hunk => hunk.lines));
    assert.strictEqual(finalLines.find(line => line.kind === 'delete').text, 'same\n');
    assert.strictEqual(finalLines.find(line => line.kind === 'insert').text, 'same');

    const lineCount = 30000;
    const before = Array.from({ length: lineCount }, (_, index) => `old-${index}\n`).join('');
    const after = Array.from({ length: lineCount }, (_, index) => `new-${index}\n`).join('');
    const paged = await pagesFor(before, after);
    assert(paged.length > 1);
    let expectedOldStart = 1;
    let expectedNewStart = 1;
    for (const page of paged) {
      for (const hunk of page.hunks) {
        assert.strictEqual(hunk.oldStart, expectedOldStart);
        assert.strictEqual(hunk.newStart, expectedNewStart);
        const oldLines = hunk.lines.filter(line => line.kind !== 'insert').length;
        const newLines = hunk.lines.filter(line => line.kind !== 'delete').length;
        assert.strictEqual(hunk.oldLines, oldLines);
        assert.strictEqual(hunk.newLines, newLines);
        expectedOldStart += oldLines;
        expectedNewStart += newLines;
      }
    }
    assert.strictEqual(expectedOldStart, lineCount + 1);
    assert.strictEqual(expectedNewStart, lineCount + 1);
  });

  await test('readDiff uses a shared read lease and exact second snapshot/current recheck before body release', async () => {
    let snapshotReads = 0;
    let currentReads = 0;
    let readLeaseAcquired = 0;
    let readLeaseReleased = 0;
    const state = setup({
      options: {
        async acquireReadLease() {
          readLeaseAcquired += 1;
          return Object.freeze({ leaseId: 'readonly' });
        },
        async releaseReadLease() { readLeaseReleased += 1; },
        assertReadLeaseCurrent() {},
        async readSnapshotAuthority() {
          snapshotReads += 1;
          return {
            snapshotId: SNAPSHOT_ID,
            snapshotManifestDigest: snapshotReads === 1 ? MANIFEST : `sha256:${'8'.repeat(64)}`,
            publishedIdentityDigest: PUBLISHED,
          };
        },
        async readCurrentAuthority() {
          currentReads += 1;
          return {
            projectInstanceId: PROJECT_ID,
            mutationGeneration: 19,
            fileRevisionSetDigest: CURRENT_SET,
          };
        },
      },
    });
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    await expectServiceCode('STALE_SNAPSHOT_CAPABILITY',
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)));
    assert.strictEqual(readLeaseAcquired, 1);
    assert.strictEqual(readLeaseReleased, 1);
    assert.strictEqual(snapshotReads, 2);
    assert.strictEqual(currentReads, 2);
  });

  await test('all adapter failures are wrapped into stable path/body-free errors', async () => {
    const leaked = '/Users/private/novel.md SECRET_BODY';
    const listState = setup({ options: {
      async listSnapshots() { throw Object.assign(new Error(leaked), { code: 'bad/path' }); },
    } });
    await assert.rejects(listState.service.list(owner(), {
      schema: schema.SCHEMAS.SNAPSHOT_LIST_REQUEST,
      projectInstanceId: PROJECT_ID,
    }), error => error instanceof SnapshotCompareServiceError &&
      error.code === 'SNAPSHOT_LIST_FAILED' && !error.message.includes('/Users') &&
      !error.message.includes('SECRET_BODY'));

    const diffState = setup({ options: {
      async readSnapshotAuthority() {
        throw Object.assign(new Error(leaked), { code: 'bad/path' });
      },
    } });
    const comparison = await diffState.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    await assert.rejects(
      diffState.service.readDiff(owner(), diffRequest(comparison, modified.diffId)),
      error => error instanceof SnapshotCompareServiceError &&
        error.code === 'SNAPSHOT_AUTHORITY_READ_FAILED' &&
        !error.message.includes('/Users') && !error.message.includes('SECRET_BODY')
    );
  });

  await test('tombstone cleanup clears expiry immediately and build peak has an explicit production cap', async () => {
    const timers = new Set();
    let cleared = 0;
    const state = setup({ options: {
      setTimer(callback) {
        const timer = { callback, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearTimer(timer) {
        if (timers.delete(timer)) cleared += 1;
      },
    } });
    const comparison = await state.service.compare(owner(), compareRequest());
    const modified = comparison.items.find(item => item.displayPath === 'modified.md');
    state.setLiveCurrent({
      projectInstanceId: PROJECT_ID,
      mutationGeneration: 20,
      fileRevisionSetDigest: `sha256:${'9'.repeat(64)}`,
    });
    await assert.rejects(
      state.service.readDiff(owner(), diffRequest(comparison, modified.diffId)),
      error => error instanceof SnapshotCapabilityStoreError &&
        error.code === 'STALE_SNAPSHOT_CAPABILITY'
    );
    assert.strictEqual(cleared, 1);
    assert.strictEqual(state.rawStore.inspect(comparison.compareCapabilityId), null);
    assert.strictEqual(DIFF_CONTEXT_TOTAL_MAX_BYTES, 264 * 1024 * 1024);
    assert.strictEqual(DIFF_BUILD_PEAK_MAX_BYTES, 672 * 1024 * 1024);
  });

  console.log(`Snapshot compare service checks passed: ${passed}/21`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
