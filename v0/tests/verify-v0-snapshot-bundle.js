'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/evidence-delivery-schema');
const bundleService = require('../src/main/snapshot-bundle');

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

function sealManifest(manifest) {
  const revisionSet = schema.createFileRevisionSetDigest(manifest.files.map(file => ({
    fileId: file.fileId,
    path: file.path,
    revision: file.revision,
    sha256: file.sha256,
  })));
  manifest.fileRevisionSetDigest = revisionSet.digest;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    manifest.snapshotManifestDigest = schema.digestObject(
      schema.SCHEMAS.SNAPSHOT,
      manifest,
      'snapshotManifestDigest'
    );
    const length = Buffer.byteLength(schema.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === length) break;
    manifest.budgets.observed.manifestBytes = length;
  }
  manifest.snapshotManifestDigest = schema.digestObject(
    schema.SCHEMAS.SNAPSHOT,
    manifest,
    'snapshotManifestDigest'
  );
  assert.strictEqual(
    manifest.budgets.observed.manifestBytes,
    Buffer.byteLength(schema.canonicalJson(manifest), 'utf8')
  );
  return manifest;
}

function fixture() {
  const content = Buffer.from('# 第一章\n\n正文 😀\n', 'utf8');
  const header = {
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: 'file_markdown_a',
    path: 'chapters/一.md',
    kind: 'markdown',
    byteLength: content.length,
    sha256: bundleService.digestBytes(content),
  };
  const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
  const file = {
    fileId: header.fileId,
    path: header.path,
    kind: header.kind,
    mode: 0o600,
    byteLength: content.length,
    sha256: header.sha256,
    revision: header.sha256.slice('sha256:'.length),
    ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
    bundleObjectDigest: bundleService.bundleObjectDigest(headerBytes, content),
    references: [],
  };
  const limits = { ...bundleService.SNAPSHOT_LIMITS };
  const observed = {
    markdownFiles: 1,
    imageFiles: 0,
    totalItems: 1,
    markdownBytes: content.length,
    imageBytes: 0,
    snapshotBytes: content.length,
    manifestBytes: 0,
    privateMetadataBytes: 0,
  };
  let manifest = {
    schema: schema.SCHEMAS.SNAPSHOT,
    projectInstanceId: `instance_${'a'.repeat(24)}`,
    snapshotId: 'snapshot_fixture_a',
    createdAt: '2026-08-06T00:00:00.000Z',
    creationMutationGeneration: 7,
    rootIdentityDigest: `sha256:${'3'.repeat(64)}`,
    files: [file],
    fileRevisionSetDigest: null,
    budgets: { limits, observed },
    producerVersion: '0.3.0-stage-a',
    snapshotManifestDigest: null,
  };
  sealManifest(manifest);
  return { content, file, manifest };
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function uint64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value), 0);
  return buffer;
}

function forgeBundle(manifest, entries) {
  const manifestBytes = Buffer.from(schema.canonicalJson(manifest), 'utf8');
  const pieces = [bundleService.MAGIC, uint32(manifestBytes.length), manifestBytes,
    uint32(entries.length)];
  for (const { file, content } of entries) {
    const headerBytes = Buffer.from(schema.canonicalJson(bundleService.entryHeader(file)), 'utf8');
    pieces.push(uint32(headerBytes.length), headerBytes, uint64(content.length), content);
  }
  const payload = Buffer.concat(pieces);
  return Buffer.concat([
    payload,
    crypto.createHash('sha256').update(payload).digest(),
    bundleService.FOOTER,
  ]);
}

console.log('WritCraft 0.4.0 snapshot bundle tests');

test('writes and parses the frozen bundle framing exactly', () => {
  const { content, file, manifest } = fixture();
  const created = bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]);
  assert(created.bundle.subarray(0, 8).equals(bundleService.MAGIC));
  assert(created.bundle.subarray(-8).equals(bundleService.FOOTER));
  const parsed = bundleService.parseBundle(created.bundle);
  assert.strictEqual(parsed.manifest.snapshotManifestDigest, manifest.snapshotManifestDigest);
  assert.strictEqual(parsed.bundlePayloadSha256, created.bundlePayloadSha256);
  assert.strictEqual(parsed.bindings.length, 1);
  assert.strictEqual(parsed.bindings[0].contentLength, content.length);
  assert(schema.SHA256_RE.test(parsed.bindings[0].entryBindingDigest));
});

test('rejects payload corruption even when footer remains present', () => {
  const { content, file, manifest } = fixture();
  const created = bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]);
  const corrupt = Buffer.from(created.bundle);
  corrupt[corrupt.length - 41] ^= 0x01;
  assert.throws(() => bundleService.parseBundle(corrupt), /payload digest/);
});

test('rejects non-canonical manifest bytes and trailing payload bytes', () => {
  const { content, file, manifest } = fixture();
  const created = bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]);
  const payloadEnd = created.bundle.length - 40;
  const payload = created.bundle.subarray(0, payloadEnd);
  const withTrailing = Buffer.concat([
    payload,
    Buffer.from([0]),
  ]);
  const forged = Buffer.concat([
    withTrailing,
    Buffer.from(bundleService.digestBytes(withTrailing).slice(7), 'hex'),
    bundleService.FOOTER,
  ]);
  assert.throws(() => bundleService.parseBundle(forged), /trailing bytes/);
});

test('rejects manifest digest and observed-budget drift', () => {
  const { content, file, manifest } = fixture();
  assert.throws(() => bundleService.createBundle(
    { ...manifest, snapshotManifestDigest: `sha256:${'f'.repeat(64)}` },
    [{ fileId: file.fileId, content }]
  ), /manifest digest/);
  const drift = {
    ...manifest,
    budgets: {
      limits: manifest.budgets.limits,
      observed: { ...manifest.budgets.observed, snapshotBytes: content.length + 1 },
    },
  };
  drift.snapshotManifestDigest = schema.digestObject(
    schema.SCHEMAS.SNAPSHOT,
    drift,
    'snapshotManifestDigest'
  );
  assert.throws(() => bundleService.createBundle(drift, [{ fileId: file.fileId, content }]), /observed/);
});

test('rejects self-reported budget widening and private metadata overflow', () => {
  const { manifest } = fixture();
  const widened = {
    ...manifest,
    budgets: {
      limits: { ...manifest.budgets.limits, maxMarkdownFiles: 500 },
      observed: { ...manifest.budgets.observed },
    },
  };
  sealManifest(widened);
  assert.throws(() => bundleService.assertManifest(widened), /不是冻结值/);

  const metadataOverflow = {
    ...manifest,
    budgets: {
      limits: { ...manifest.budgets.limits },
      observed: {
        ...manifest.budgets.observed,
        privateMetadataBytes: bundleService.SNAPSHOT_LIMITS.maxPrivateMetadataBytes + 1,
      },
    },
  };
  sealManifest(metadataOverflow);
  assert.throws(() => bundleService.assertManifest(metadataOverflow), /冻结预算/);
});

test('accepts exactly 300 Markdown items and rejects item 301', () => {
  const empty = Buffer.alloc(0);
  const files = Array.from({ length: 301 }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    const header = {
      schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
      fileId: `file_${suffix}`,
      path: `chapters/${suffix}.md`,
      kind: 'markdown',
      byteLength: 0,
      sha256: bundleService.digestBytes(empty),
    };
    return {
      fileId: header.fileId,
      path: header.path,
      kind: header.kind,
      mode: 0o600,
      byteLength: 0,
      sha256: header.sha256,
      revision: header.sha256.slice(7),
      ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
      sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
      bundleObjectDigest: bundleService.bundleObjectDigest(
        Buffer.from(schema.canonicalJson(header), 'utf8'),
        empty
      ),
      references: [],
    };
  });
  const { manifest } = fixture();
  const maximum = {
    ...manifest,
    files: files.slice(0, 300),
    budgets: {
      limits: { ...manifest.budgets.limits },
      observed: {
        ...manifest.budgets.observed,
        markdownFiles: 300,
        totalItems: 300,
        markdownBytes: 0,
        snapshotBytes: 0,
      },
    },
  };
  sealManifest(maximum);
  assert.strictEqual(bundleService.assertManifest(maximum).manifest.files.length, 300);

  const overflow = {
    ...maximum,
    files,
    budgets: {
      limits: { ...maximum.budgets.limits },
      observed: {
        ...maximum.budgets.observed,
        markdownFiles: 301,
        totalItems: 301,
      },
    },
  };
  sealManifest(overflow);
  assert.throws(() => bundleService.assertManifest(overflow), /冻结预算/);
});

test('closes image reference graph over Markdown items in the same manifest', () => {
  const { file, manifest } = fixture();
  const markdownWithReferences = {
    ...file,
    references: [{
      fromFileId: file.fileId,
      tokenOrdinal: 0,
      locatorDigest: `sha256:${'8'.repeat(64)}`,
    }],
  };
  const invalidMarkdown = {
    ...manifest,
    files: [markdownWithReferences],
    budgets: {
      limits: { ...manifest.budgets.limits },
      observed: { ...manifest.budgets.observed },
    },
  };
  sealManifest(invalidMarkdown);
  assert.throws(() => bundleService.assertManifest(invalidMarkdown), /Markdown 文件不得/);

  const imageContent = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const imageHeader = {
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: 'file_image_a',
    path: 'images/a.png',
    kind: 'image',
    byteLength: imageContent.length,
    sha256: bundleService.digestBytes(imageContent),
  };
  const imageHeaderBytes = Buffer.from(schema.canonicalJson(imageHeader), 'utf8');
  const imageFile = {
    fileId: imageHeader.fileId,
    path: imageHeader.path,
    kind: imageHeader.kind,
    mode: 0o600,
    byteLength: imageContent.length,
    sha256: imageHeader.sha256,
    revision: imageHeader.sha256.slice(7),
    ancestorIdentityDigest: `sha256:${'4'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'5'.repeat(64)}`,
    bundleObjectDigest: bundleService.bundleObjectDigest(imageHeaderBytes, imageContent),
    references: [{
      fromFileId: 'missing_markdown',
      tokenOrdinal: 0,
      locatorDigest: `sha256:${'6'.repeat(64)}`,
    }],
  };
  const invalidImage = {
    ...manifest,
    files: [file, imageFile],
    budgets: {
      limits: { ...manifest.budgets.limits },
      observed: {
        ...manifest.budgets.observed,
        imageFiles: 1,
        totalItems: 2,
        imageBytes: imageContent.length,
        snapshotBytes: file.byteLength + imageContent.length,
      },
    },
  };
  sealManifest(invalidImage);
  assert.throws(() => bundleService.assertManifest(invalidImage), /同一 manifest/);
});

test('rejects invalid UTF-8 Markdown on write and read', () => {
  const { file, manifest } = fixture();
  const content = Buffer.from([0xc3, 0x28]);
  const header = {
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: file.fileId,
    path: file.path,
    kind: file.kind,
    byteLength: content.length,
    sha256: bundleService.digestBytes(content),
  };
  const invalidFile = {
    ...file,
    byteLength: content.length,
    sha256: header.sha256,
    revision: header.sha256.slice(7),
    bundleObjectDigest: bundleService.bundleObjectDigest(
      Buffer.from(schema.canonicalJson(header), 'utf8'),
      content
    ),
  };
  const invalidManifest = {
    ...manifest,
    files: [invalidFile],
    budgets: {
      limits: { ...manifest.budgets.limits },
      observed: {
        ...manifest.budgets.observed,
        markdownBytes: content.length,
        snapshotBytes: content.length,
      },
    },
  };
  sealManifest(invalidManifest);
  assert.throws(
    () => bundleService.createBundle(invalidManifest, [{ fileId: invalidFile.fileId, content }]),
    /严格 UTF-8/
  );
  const forged = forgeBundle(invalidManifest, [{ file: invalidFile, content }]);
  assert.throws(() => bundleService.parseBundle(forged), /严格 UTF-8/);
});

test('returns a deeply frozen verified manifest projection', () => {
  const { content, file, manifest } = fixture();
  const parsed = bundleService.parseBundle(
    bundleService.createBundle(manifest, [{ fileId: file.fileId, content }]).bundle
  );
  assert(Object.isFrozen(parsed.manifest));
  assert(Object.isFrozen(parsed.manifest.files));
  assert(Object.isFrozen(parsed.manifest.files[0]));
  assert(Object.isFrozen(parsed.manifest.files[0].references));
  assert(Object.isFrozen(parsed.manifest.budgets));
  assert.throws(() => { parsed.manifest.files[0].path = 'changed.md'; }, /read only|Cannot assign/);
});

test('rejects duplicate or unsorted manifest file identities', () => {
  const { file, manifest } = fixture();
  const duplicate = {
    ...manifest,
    files: [file, { ...file }],
    budgets: {
      limits: manifest.budgets.limits,
      observed: { ...manifest.budgets.observed, markdownFiles: 2, totalItems: 2,
        markdownBytes: file.byteLength * 2, snapshotBytes: file.byteLength * 2 },
    },
  };
  duplicate.snapshotManifestDigest = schema.digestObject(
    schema.SCHEMAS.SNAPSHOT,
    duplicate,
    'snapshotManifestDigest'
  );
  assert.throws(() => bundleService.assertManifest(duplicate), /重复或排序/);
});

console.log(`\n${passed}/10 snapshot bundle tests passed.`);
