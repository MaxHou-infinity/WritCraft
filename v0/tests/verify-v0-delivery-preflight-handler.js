'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const snapshotBundle = require('../src/main/snapshot-bundle');
const handlerModule = require('../src/main/delivery-preflight-handler');

const projectInstanceId = 'instance_0123456789abcdef01234567';
const snapshotId = 'snapshot_stage_b_handler';
const fileId = 'file_chapter_handler';
const revision = 'a'.repeat(64);

function makeBundle() {
  const content = Buffer.from('# 标题\n正文\n', 'utf8');
  const file = {
    fileId, path: 'chapter.md', kind: 'markdown', mode: 0o600,
    byteLength: content.length, sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    revision, ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`, references: [],
  };
  const header = snapshotBundle.entryHeader(file);
  file.bundleObjectDigest = snapshotBundle.bundleObjectDigest(
    Buffer.from(evidence.canonicalJson(header), 'utf8'), content
  );
  const limits = { ...snapshotBundle.SNAPSHOT_LIMITS };
  const observed = { markdownFiles: 1, imageFiles: 0, totalItems: 1,
    markdownBytes: content.length, imageBytes: 0, snapshotBytes: content.length,
    manifestBytes: 0, privateMetadataBytes: 0 };
  const manifest = {
    schema: evidence.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId,
    createdAt: '2026-08-10T00:00:00.000Z', creationMutationGeneration: 1,
    rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files: [file],
    fileRevisionSetDigest: null, budgets: { limits, observed },
    producerVersion: 'stage-b-handler-test', snapshotManifestDigest: null,
  };
  manifest.fileRevisionSetDigest = evidence.createFileRevisionSetDigest([{
    fileId, path: file.path, revision, sha256: file.sha256,
  }]).digest;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    manifest.snapshotManifestDigest = evidence.digestObject(evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
    const manifestBytes = Buffer.byteLength(evidence.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === manifestBytes) break;
    manifest.budgets.observed.manifestBytes = manifestBytes;
  }
  manifest.snapshotManifestDigest = evidence.digestObject(evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
  return snapshotBundle.createBundle(manifest, [{ fileId, content }]).bundle;
}

function graph() {
  return { schema: 'writcraft.graph/v2', manifest: { inputFiles: [{ path: 'chapter.md', revision }] }, nodes: [], edges: [], evidence: [], issues: [], correctionState: null };
}

function sourceIndex() {
  return { schema: 'writcraft.sources/v1', status: 'ready', revision: `sha256:${'4'.repeat(64)}`, sources: [], errors: [] };
}

function request() {
  return { schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId, orderedFiles: [{ fileId, pageBreakBefore: false }], warningDecision: 'REVIEW_ONLY' };
}

function harness(overrides = {}) {
  let binding = { webContentsId: 7, projectInstanceId, ownerGeneration: 1, mutationGeneration: 2, navigationEpoch: 3 };
  let reads = 0;
  let capabilityCalls = 0;
  let revokeCalls = 0;
  const handler = handlerModule.createDeliveryPreflightHandler({
    assertTrustedSender(event) {
      if (event?.trusted !== true) {
        const error = new Error('untrusted'); error.code = 'UNTRUSTED_SENDER'; throw error;
      }
    },
    captureBinding: () => ({ ...binding }),
    settleAuthority: async () => {},
    revokeDeliveryCapability: async () => { revokeCalls += 1; return true; },
    readSnapshot: async () => { reads += 1; return { bundle: makeBundle() }; },
    readGraph: async () => graph(),
    readSourceIndex: async () => sourceIndex(),
    issueDeliveryCapability: () => { capabilityCalls += 1; return { capabilityId: 'delivery_capability_handler' }; },
    ...overrides,
  });
  return {
    handler,
    setBinding(next) { binding = { ...binding, ...next }; },
    get reads() { return reads; },
    get capabilityCalls() { return capabilityCalls; },
    get revokeCalls() { return revokeCalls; },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn(); passed += 1; console.log(`  ✓ ${name}`);
}

(async () => {
  await test('trusted handler uses Main-owned readers and returns public projection', async () => {
    const run = harness();
    const result = await run.handler.preflight({ trusted: true }, request());
    assert.strictEqual(result.public.canExport, true);
    assert.strictEqual(result.public.exportCapabilityId, 'delivery_capability_handler');
    assert.strictEqual(run.reads, 1);
    assert.strictEqual(run.capabilityCalls, 1);
  });

  await test('untrusted sender and renderer authority fields fail before readers', async () => {
    let reads = 0;
    const run = harness({ readSnapshot: async () => { reads += 1; return { bundle: makeBundle() }; } });
    await assert.rejects(() => run.handler.preflight({ trusted: false }, request()), error => error.code === 'DELIVERY_BLOCKED');
    await assert.rejects(() => run.handler.preflight({ trusted: true }, { ...request(), rootPath: '/tmp/secret' }), error => error.code === 'DELIVERY_BLOCKED');
    assert.strictEqual(reads, 0);
  });

  await test('project drift during Main-owned reads fails closed without capability', async () => {
    const run = harness({ readGraph: async () => { run.setBinding({ mutationGeneration: 3 }); return graph(); } });
    await assert.rejects(() => run.handler.preflight({ trusted: true }, request()), error => error.code === 'DELIVERY_STALE');
    assert.strictEqual(run.capabilityCalls, 0);
  });

  await test('watcher barrier failure blocks before any snapshot read', async () => {
    let reads = 0;
    const run = harness({
      settleAuthority: async () => { const error = new Error('watcher unavailable'); error.code = 'PROJECT_WATCHER_UNAVAILABLE'; throw error; },
      readSnapshot: async () => { reads += 1; return { bundle: makeBundle() }; },
    });
    await assert.rejects(() => run.handler.preflight({ trusted: true }, request()), error => error.code === 'DELIVERY_BLOCKED');
    assert.strictEqual(reads, 0);
    assert.strictEqual(run.capabilityCalls, 0);
  });

  await test('unavailable snapshot authority is a stable blocked result', async () => {
    const run = harness({ readSnapshot: async () => { const error = new Error('storage unavailable'); error.code = 'SNAPSHOT_UNAVAILABLE'; throw error; } });
    await assert.rejects(() => run.handler.preflight({ trusted: true }, request()), error => error.code === 'DELIVERY_BLOCKED');
    assert.strictEqual(run.capabilityCalls, 0);
  });

  await test('capability is revoked when owner binding drifts after issue', async () => {
    let captures = 0;
    const run = harness({
      captureBinding: () => ({ webContentsId: 7, projectInstanceId, ownerGeneration: 1, mutationGeneration: (++captures >= 4 ? 4 : 2), navigationEpoch: 3 }),
    });
    await assert.rejects(() => run.handler.preflight({ trusted: true }, request()), error => error.code === 'DELIVERY_STALE');
    assert.strictEqual(run.capabilityCalls, 1);
    assert.strictEqual(run.revokeCalls, 1);
  });

  await test('owner deadline aborts a stalled watcher barrier before reading snapshot', async () => {
    const run = harness({
      deadlineMs: 1000,
      settleAuthority: async () => new Promise(resolve => setTimeout(resolve, 1100)),
    });
    await assert.rejects(() => run.handler.preflight({ trusted: true }, request()), error => error.code === 'LOCAL_OPERATION_TIMEOUT');
    assert.strictEqual(run.reads, 0);
    assert.strictEqual(run.capabilityCalls, 0);
  });

  console.log(`Stage B delivery preflight handler: ${passed}/7 passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
