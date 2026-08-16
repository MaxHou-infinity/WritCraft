'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const bundle = require('../src/main/snapshot-bundle');
const graphCorrection = require('../src/main/graph-correction-service');
const providerModule = require('../src/main/snapshot-delivery-provider-adapter');

const projectInstanceId = 'instance_0123456789abcdef01234567';
const snapshotId = 'snapshot_provider_adapter';
const fileId = 'file_provider_chapter';
const revision = 'a'.repeat(64);

function makeBundle() {
  const content = Buffer.from('# 标题\n正文\n', 'utf8');
  const file = {
    fileId, path: 'chapter.md', kind: 'markdown', mode: 0o600, byteLength: content.length,
    sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    revision, ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`, bundleObjectDigest: null, references: [],
  };
  const header = bundle.entryHeader(file);
  file.bundleObjectDigest = bundle.bundleObjectDigest(Buffer.from(evidence.canonicalJson(header), 'utf8'), content);
  const manifest = {
    schema: evidence.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId,
    createdAt: '2026-08-10T00:00:00.000Z', creationMutationGeneration: 1,
    rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files: [file], fileRevisionSetDigest: null,
    budgets: { limits: { ...bundle.SNAPSHOT_LIMITS }, observed: { markdownFiles: 1, imageFiles: 0, totalItems: 1,
      markdownBytes: content.length, imageBytes: 0, snapshotBytes: content.length, manifestBytes: 0, privateMetadataBytes: 0 } },
    producerVersion: 'provider-adapter-test', snapshotManifestDigest: null,
  };
  manifest.fileRevisionSetDigest = evidence.createFileRevisionSetDigest([{ fileId, path: file.path, revision, sha256: file.sha256 }]).digest;
  for (let index = 0; index < 8; index += 1) {
    manifest.snapshotManifestDigest = evidence.digestObject(evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
    const bytes = Buffer.byteLength(evidence.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === bytes) break;
    manifest.budgets.observed.manifestBytes = bytes;
  }
  manifest.snapshotManifestDigest = evidence.digestObject(evidence.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
  return bundle.createBundle(manifest, [{ fileId, content }]).bundle;
}

function graph() {
  const value = { schema: 'writcraft.graph/v2', manifest: { inputFiles: [{ path: 'chapter.md', revision }] }, nodes: [], edges: [], evidence: [], issues: [] };
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

function sourceIndex() {
  return { schema: 'writcraft.sources/v1', status: 'ready', revision: `sha256:${'4'.repeat(64)}`, sources: [], errors: [] };
}

function provider(overrides = {}) {
  return providerModule.createSnapshotDeliveryProvider({
    readCommittedBundle: async request => {
      assert.deepStrictEqual(Object.keys(request).sort(), ['projectInstanceId', 'snapshotId']);
      assert.strictEqual(request.projectInstanceId, projectInstanceId);
      assert.strictEqual(request.snapshotId, snapshotId);
      return makeBundle();
    },
    buildSnapshotGraph: async context => {
      assert.deepStrictEqual(Object.keys(context).sort(), [
        'bundle', 'creationMutationGeneration', 'fileRevisionSetDigest', 'projectInstanceId',
        'schema', 'snapshotId', 'snapshotManifestDigest',
      ]);
      assert.strictEqual(context.schema, providerModule.SCHEMA);
      assert.strictEqual(Object.hasOwn(context, 'rootPath'), false);
      return graph();
    },
    buildSnapshotSourceIndex: async context => {
      assert.strictEqual(Object.hasOwn(context, 'rootPath'), false);
      return sourceIndex();
    },
    ...overrides,
  });
}

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

(async () => {
  await test('blocks a fresh Graph that has no snapshot-bound correction artifact', async () => {
    const value = provider({ buildSnapshotGraph: async () => ({
      schema: 'writcraft.graph/v2',
      manifest: { inputFiles: [{ path: 'chapter.md', revision }] },
      nodes: [], edges: [], evidence: [], issues: [], correctionState: null,
    }) });
    await assert.rejects(() => value.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
  });

  await test('accepts a Graph only when a matching correction artifact is present', async () => {
    const value = provider();
    const result = await value.read({ projectInstanceId, snapshotId });
    assert.deepStrictEqual(result.graph.manifest.inputFiles, [{ path: 'chapter.md', revision }]);
    assert.strictEqual(result.sourceIndex.status, 'ready');
    evidence.assertDigest(result.sourceIndex.revision, 'snapshot SourceIndex revision');
  });

  await test('constructs Graph/SourceIndex inputs only from an immutable committed bundle context', async () => {
    const value = await provider().read({ projectInstanceId, snapshotId });
    assert.ok(Buffer.isBuffer(value.snapshot.bundle));
    assert.strictEqual(value.graph.schema, 'writcraft.graph/v2');
    assert.strictEqual(value.sourceIndex.schema, 'writcraft.sources/v1');
  });

  await test('rejects renderer path/content fields before any committed bundle read', async () => {
    let reads = 0;
    const value = provider({ readCommittedBundle: async () => { reads += 1; return makeBundle(); } });
    await assert.rejects(() => value.read({ projectInstanceId, snapshotId, rootPath: '/tmp/nope' }), error => error.code === 'DELIVERY_BLOCKED');
    assert.strictEqual(reads, 0);
  });

  await test('fails closed when no snapshot-bound builders exist', async () => {
    const value = provider({ buildSnapshotGraph: null });
    await assert.rejects(() => value.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_SNAPSHOT_DERIVATION_UNAVAILABLE');
  });

  await test('rejects Graph and SourceIndex that are not bound to the committed revision set', async () => {
    const graphProvider = provider({ buildSnapshotGraph: async () => ({ ...graph(), manifest: { inputFiles: [{ path: 'chapter.md', revision: 'b'.repeat(64) }] } }) });
    await assert.rejects(() => graphProvider.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
    const sourceProvider = provider({ buildSnapshotSourceIndex: async () => ({ ...sourceIndex(), sources: [{ id: 'src_1', filePath: 'chapter.md', revision: 'b'.repeat(64) }] }) });
    await assert.rejects(() => sourceProvider.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
  });

  await test('rejects a correction artifact bound to a different Graph identity', async () => {
    const stale = provider({
      buildSnapshotGraph: async () => ({
        ...graph(),
        correctionState: { ...graph().correctionState, graphIdentity: `graph_${'f'.repeat(32)}` },
      }),
    });
    await assert.rejects(() => stale.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
  });

  await test('rejects a Graph carrying an unbound correction status', async () => {
    const base = graph();
    const value = provider({
      buildSnapshotGraph: async () => ({
        ...base,
        correctionState: {
          ...base.correctionState,
          corrections: [{ id: 'corr_aaaaaaaaaaaaaaaaaaaaaaaa', type: 'merge_alias', active: false, evidenceState: 'unbound' }],
        },
      }),
    });
    await assert.rejects(() => value.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
  });

  await test('fails closed when the correction artifact read is absent', async () => {
    const value = provider({ readCorrectionArtifact: async () => null });
    await assert.rejects(() => value.read({ projectInstanceId, snapshotId }), error => error.code === 'DELIVERY_STALE');
  });

  console.log(`Stage B snapshot delivery provider adapter: ${passed}/${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
