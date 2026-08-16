'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const bundle = require('../src/main/snapshot-bundle');
const graphCorrection = require('../src/main/graph-correction-service');
const capability = require('../src/main/delivery-capability-store');
const adapterModule = require('../src/main/delivery-preflight-main-adapter');

const projectInstanceId = 'instance_0123456789abcdef01234567';
const snapshotId = 'snapshot_main_adapter';
const fileId = 'file_main_adapter';
const revision = 'a'.repeat(64);
const content = Buffer.from('# 标题\n正文\n', 'utf8');

function makeBundle() {
  const file = {
    fileId, path: 'chapter.md', kind: 'markdown', mode: 0o600,
    byteLength: content.length,
    sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    revision, ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
    bundleObjectDigest: null, references: [],
  };
  const header = bundle.entryHeader(file);
  file.bundleObjectDigest = bundle.bundleObjectDigest(
    Buffer.from(evidence.canonicalJson(header), 'utf8'), content
  );
  const manifest = {
    schema: evidence.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId,
    createdAt: '2026-08-10T00:00:00.000Z', creationMutationGeneration: 1,
    rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files: [file],
    fileRevisionSetDigest: null,
    budgets: { limits: { ...bundle.SNAPSHOT_LIMITS }, observed: {
      markdownFiles: 1, imageFiles: 0, totalItems: 1,
      markdownBytes: content.length, imageBytes: 0, snapshotBytes: content.length,
      manifestBytes: 0, privateMetadataBytes: 0,
    } },
    producerVersion: 'main-adapter-test', snapshotManifestDigest: null,
  };
  manifest.fileRevisionSetDigest = evidence.createFileRevisionSetDigest([
    { fileId, path: file.path, revision, sha256: file.sha256 },
  ]).digest;
  for (let index = 0; index < 8; index += 1) {
    manifest.snapshotManifestDigest = evidence.digestObject(
      evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest'
    );
    const bytes = Buffer.byteLength(evidence.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === bytes) break;
    manifest.budgets.observed.manifestBytes = bytes;
  }
  manifest.snapshotManifestDigest = evidence.digestObject(
    evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest'
  );
  return bundle.createBundle(manifest, [{ fileId, content }]).bundle;
}

function makeStore() {
  let counter = 0;
  return capability.createDeliveryCapabilityStore({
    randomBytes: () => {
      const value = Buffer.alloc(16);
      value.writeUInt32BE(++counter, 12);
      return value;
    },
  });
}

function makeGraph() {
  const value = {
    schema: 'writcraft.graph/v2',
    manifest: { inputFiles: [{ path: 'chapter.md', revision }] },
    nodes: [], edges: [], evidence: [], issues: [],
  };
  return {
    ...value,
    correctionState: {
      schema: graphCorrection.CORRECTIONS_SCHEMA,
      graphIdentity: graphCorrection.graphIdentity(value),
      persistenceBlocked: false,
      recoveryReason: null,
      corrections: [],
    },
  };
}

function makeAdapter(state, store) {
  return adapterModule.createDeliveryPreflightMainAdapter({
    assertTrustedSender() {},
    captureBinding() {
      return {
        webContentsId: 42,
        projectInstanceId,
        ownerGeneration: 9,
        mutationGeneration: state.mutationGeneration,
        navigationEpoch: state.navigationEpoch,
      };
    },
    settleAuthority: async () => {},
    readCommittedBundle: async request => {
      assert.deepStrictEqual(request, { projectInstanceId, snapshotId });
      return makeBundle();
    },
    buildSnapshotGraph: async () => makeGraph(),
    buildSnapshotSourceIndex: async () => ({
      schema: 'writcraft.sources/v1', status: 'ready',
      revision: `sha256:${'4'.repeat(64)}`, sources: [], errors: [],
    }),
    capabilityStore: store,
  });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  console.log('WritCraft 0.4.0 Stage B Main delivery adapter tests');
  await test('issues export capability with the complete request-scoped owner binding', async () => {
    const state = { mutationGeneration: 11, navigationEpoch: 5 };
    const store = makeStore();
    const adapter = makeAdapter(state, store);
    const result = await adapter.preflight({}, {
      schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId,
      orderedFiles: [{ fileId, pageBreakBefore: false }], warningDecision: 'REVIEW_ONLY',
    });
    assert.strictEqual(result.public.canExport, true);
    const record = store.inspect({ capabilityId: result.public.exportCapabilityId });
    assert.strictEqual(record.ownerGeneration, 9);
    assert.strictEqual(adapter.pendingSize(), 0);
  });

  await test('revoke after owner drift uses the originally issued full binding', async () => {
    const state = { mutationGeneration: 12, navigationEpoch: 6 };
    const store = makeStore();
    const adapter = makeAdapter(state, store);
    const result = await adapter.preflight({}, {
      schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId,
      orderedFiles: [{ fileId, pageBreakBefore: false }], warningDecision: 'REVIEW_ONLY',
    });
    assert.strictEqual(adapter.revokeDeliveryCapability({
      capabilityId: result.public.exportCapabilityId,
      projectInstanceId,
      ownerGeneration: 9,
    }), true);
    assert.strictEqual(store.inspect({ capabilityId: result.public.exportCapabilityId }), null);
  });

  await test('rejects renderer authority fields before any committed read', async () => {
    let reads = 0;
    const state = { mutationGeneration: 13, navigationEpoch: 7 };
    const store = makeStore();
    const adapter = adapterModule.createDeliveryPreflightMainAdapter({
      assertTrustedSender() {}, captureBinding: () => ({
        webContentsId: 42, projectInstanceId, ownerGeneration: 9,
        mutationGeneration: state.mutationGeneration, navigationEpoch: state.navigationEpoch,
      }), settleAuthority: async () => {}, capabilityStore: store,
      readCommittedBundle: async () => { reads += 1; return makeBundle(); },
      buildSnapshotSourceIndex: async () => ({
        schema: 'writcraft.sources/v1', status: 'ready',
        revision: `sha256:${'4'.repeat(64)}`, sources: [], errors: [],
      }),
    });
    await assert.rejects(() => adapter.preflight({}, {
      schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId,
      rootPath: '/tmp/forbidden', orderedFiles: [{ fileId, pageBreakBefore: false }],
      warningDecision: 'REVIEW_ONLY',
    }), error => error.code === 'DELIVERY_BLOCKED');
    assert.strictEqual(reads, 0);
  });

  console.log(`Stage B Main delivery adapter: ${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
