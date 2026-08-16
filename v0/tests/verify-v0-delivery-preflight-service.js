'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/evidence-delivery-schema');
const bundle = require('../src/main/snapshot-bundle');
const serviceModule = require('../src/main/delivery-preflight-service');
const blockAnchor = require('../src/shared/block-anchor');

const projectInstanceId = 'instance_0123456789abcdef01234567';
const snapshotId = 'snapshot_stage_b_service';
const fileId = 'file_chapter_a';
const revision = 'a'.repeat(64);
const contentHash = `sha256:${'b'.repeat(64)}`;

function sealManifest(manifest) {
  manifest.fileRevisionSetDigest = schema.createFileRevisionSetDigest(manifest.files.map(file => ({
    fileId: file.fileId, path: file.path, revision: file.revision, sha256: file.sha256,
  }))).digest;
  for (let index = 0; index < 8; index += 1) {
    manifest.snapshotManifestDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
    const bytes = Buffer.byteLength(schema.canonicalJson(manifest), 'utf8');
    if (manifest.budgets.observed.manifestBytes === bytes) break;
    manifest.budgets.observed.manifestBytes = bytes;
  }
  manifest.snapshotManifestDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
  return manifest;
}

function makeBundle(text) {
  const content = Buffer.from(text, 'utf8');
  const header = {
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY, fileId, path: 'chapter.md', kind: 'markdown',
    byteLength: content.length, sha256: bundle.digestBytes(content),
  };
  const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
  const file = {
    fileId, path: 'chapter.md', kind: 'markdown', mode: 0o600, byteLength: content.length,
    sha256: header.sha256, revision, ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
    bundleObjectDigest: bundle.bundleObjectDigest(headerBytes, content), references: [],
  };
  const limits = { ...bundle.SNAPSHOT_LIMITS };
  const observed = { markdownFiles: 1, imageFiles: 0, totalItems: 1, markdownBytes: content.length,
    imageBytes: 0, snapshotBytes: content.length, manifestBytes: 0, privateMetadataBytes: 0 };
  const manifest = sealManifest({
    schema: schema.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId, createdAt: '2026-08-10T00:00:00.000Z',
    creationMutationGeneration: 1, rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files: [file],
    fileRevisionSetDigest: null, budgets: { limits, observed }, producerVersion: 'stage-b-test', snapshotManifestDigest: null,
  });
  return bundle.createBundle(manifest, [{ fileId, content }]).bundle;
}

function makeMultiBundle(items) {
  const prepared = items.map(item => ({
    fileId: item.fileId,
    path: item.path,
    revision: item.revision,
    content: Buffer.from(item.text, 'utf8'),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const files = prepared.map((item, index) => {
    const header = {
      schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY, fileId: item.fileId, path: item.path, kind: 'markdown',
      byteLength: item.content.length, sha256: bundle.digestBytes(item.content),
    };
    const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
    return {
      fileId: item.fileId, path: item.path, kind: 'markdown', mode: 0o600, byteLength: item.content.length,
      sha256: header.sha256, revision: item.revision,
      ancestorIdentityDigest: `sha256:${String(index + 11).repeat(64).slice(0, 64)}`,
      sourceObjectIdentityDigest: `sha256:${String(index + 21).repeat(64).slice(0, 64)}`,
      bundleObjectDigest: bundle.bundleObjectDigest(headerBytes, item.content), references: [],
    };
  });
  const limits = { ...bundle.SNAPSHOT_LIMITS };
  const observed = {
    markdownFiles: files.length, imageFiles: 0, totalItems: files.length,
    markdownBytes: prepared.reduce((sum, item) => sum + item.content.length, 0), imageBytes: 0,
    snapshotBytes: prepared.reduce((sum, item) => sum + item.content.length, 0), manifestBytes: 0, privateMetadataBytes: 0,
  };
  const manifest = sealManifest({
    schema: schema.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId, createdAt: '2026-08-10T00:00:00.000Z',
    creationMutationGeneration: 1, rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files,
    fileRevisionSetDigest: null, budgets: { limits, observed }, producerVersion: 'stage-b-test', snapshotManifestDigest: null,
  });
  return bundle.createBundle(manifest, prepared.map(item => ({ fileId: item.fileId, content: item.content }))).bundle;
}

function makeImageBundle(text = '# 标题\n![图](assets/pic.png)\n', imageOverride = null, imagePath = 'assets/pic.png', referencesOverride = null) {
  const markdown = Buffer.from(text, 'utf8');
  const image = imageOverride || Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const markdownId = fileId;
  const imageId = 'file_image_a';
  const imageReference = { fromFileId: markdownId, tokenOrdinal: 3, locatorDigest: `sha256:${'5'.repeat(64)}` };
  const imageReferences = referencesOverride || [imageReference];
  const markdownHeader = { schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY, fileId: markdownId, path: 'chapter.md', kind: 'markdown', byteLength: markdown.length, sha256: bundle.digestBytes(markdown) };
  const imageHeader = { schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY, fileId: imageId, path: imagePath, kind: 'image', byteLength: image.length, sha256: bundle.digestBytes(image) };
  const markdownHeaderBytes = Buffer.from(schema.canonicalJson(markdownHeader), 'utf8');
  const imageHeaderBytes = Buffer.from(schema.canonicalJson(imageHeader), 'utf8');
  const files = [
    { fileId: imageId, path: imagePath, kind: 'image', mode: 0o600, byteLength: image.length, sha256: imageHeader.sha256, revision: 'b'.repeat(64), ancestorIdentityDigest: `sha256:${'6'.repeat(64)}`, sourceObjectIdentityDigest: `sha256:${'7'.repeat(64)}`, bundleObjectDigest: bundle.bundleObjectDigest(imageHeaderBytes, image), references: imageReferences },
    { fileId: markdownId, path: 'chapter.md', kind: 'markdown', mode: 0o600, byteLength: markdown.length, sha256: markdownHeader.sha256, revision, ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`, sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`, bundleObjectDigest: bundle.bundleObjectDigest(markdownHeaderBytes, markdown), references: [] },
  ];
  const limits = { ...bundle.SNAPSHOT_LIMITS };
  const observed = { markdownFiles: 1, imageFiles: 1, totalItems: 2, markdownBytes: markdown.length, imageBytes: image.length, snapshotBytes: markdown.length + image.length, manifestBytes: 0, privateMetadataBytes: 0 };
  const manifest = sealManifest({ schema: schema.SCHEMAS.SNAPSHOT, projectInstanceId, snapshotId, createdAt: '2026-08-10T00:00:00.000Z', creationMutationGeneration: 1, rootIdentityDigest: `sha256:${'3'.repeat(64)}`, files, fileRevisionSetDigest: null, budgets: { limits, observed }, producerVersion: 'stage-b-test', snapshotManifestDigest: null });
  return bundle.createBundle(manifest, [{ fileId: imageId, content: image }, { fileId: markdownId, content: markdown }]).bundle;
}

function graph() {
  return {
    schema: 'writcraft.graph/v2',
    manifest: { inputFiles: [{ path: 'chapter.md', revision }] },
    nodes: [], edges: [], evidence: [], issues: [], correctionState: null,
  };
}

function graphForImageBundle() {
  return {
    schema: 'writcraft.graph/v2',
    manifest: { inputFiles: [{ path: 'chapter.md', revision }] },
    nodes: [], edges: [], evidence: [], issues: [], correctionState: null,
  };
}

function graphForFiles(files) {
  return {
    schema: 'writcraft.graph/v2',
    manifest: { inputFiles: files.map(item => ({ path: item.path, revision: item.revision })) },
    nodes: [], edges: [], evidence: [], issues: [], correctionState: null,
  };
}

function sourceIndex() {
  return { schema: 'writcraft.sources/v1', status: 'ready', revision: `sha256:${'4'.repeat(64)}`, sources: [], errors: [] };
}

function sourceIndexWithLocator(overrides = {}) {
  return {
    schema: 'writcraft.sources/v1', status: 'ready', revision: `sha256:${'4'.repeat(64)}`, errors: [],
    sources: [{ id: 'source_1', filePath: 'chapter.md', revision, contentSha256: bundle.digestBytes(Buffer.from('# 标题\n正文\n')), title: '标题', metadata: { url: 'https://example.com/a' }, locator: {
      filePath: 'chapter.md', offset: 2, end: 4, line: 1, column: 3, quote: '# 标题',
    }, ...overrides }],
  };
}

function request(warningDecision = 'REVIEW_ONLY') {
  return {
    schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId,
    orderedFiles: [{ fileId, pageBreakBefore: false }], warningDecision,
  };
}

function requestForFiles(files, warningDecision = 'REVIEW_ONLY') {
  return {
    schema: 'writcraft.delivery-preflight-request/v1', projectInstanceId, snapshotId,
    orderedFiles: files.map(item => ({ fileId: item.fileId, pageBreakBefore: false })), warningDecision,
  };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

test('offline preflight returns public projection and issues only one capability', () => {
  const original = makeBundle('# 标题\n正文\n');
  let calls = 0;
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability(input) {
    calls += 1;
    assert.strictEqual(input.projectInstanceId, projectInstanceId);
    return { capabilityId: 'delivery_capability_1' };
  } });
  const result = service.preflight({ snapshot: { bundle: original }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.canExport, true);
  assert.strictEqual(result.public.exportCapabilityId, 'delivery_capability_1');
  assert.strictEqual(calls, 1);
  assert.strictEqual(Object.hasOwn(result.public.health.items[0] || {}, 'revisionBinding'), false);
  assert.strictEqual(Buffer.compare(original, makeBundle('# 标题\n正文\n')), 0);
});

test('explicit marker is warning-only and REVIEW_ONLY cannot mint capability', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n【待补来源】\n') }, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.canExport, false);
  assert.strictEqual(result.public.exportCapabilityId, null);
  assert.ok(result.public.warnings.length > 0);
});

test('stale graph evidence is a blocker and fails closed before capability', () => {
  const staleGraph = graph();
  staleGraph.evidence = [{ id: 'ev_aaaaaaaaaaaaaaaa', path: 'chapter.md', revision: 'c'.repeat(64), start: 0, end: 3, quote: '# 标' }];
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('CONTINUE_WITH_WARNINGS'), graph: staleGraph, sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.canExport, false);
  assert.ok(result.public.blockers.length > 0);
  assert.strictEqual(result.public.exportCapabilityId, null);
});

test('shared Markdown token authority ignores front matter and fenced code diagnostics', () => {
  const content = '---\nmarker: 【待补来源】\n---\n`【待补来源】`\n```md\n【待补来源】 [^missing]\n```\n# 正文\n';
  let capabilityCalls = 0;
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { capabilityCalls += 1; return { capabilityId: 'delivery_capability_clean' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle(content) }, ownerGeneration: 1, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.warnings.length, 0);
  assert.strictEqual(result.public.blockers.length, 0);
  assert.strictEqual(result.public.health.items.length, 0);
  assert.strictEqual(capabilityCalls, 1);
});

test('shared Markdown token authority also masks nested blockquote code', () => {
  const content = '> ```md\n> 【待补来源】 [^missing]\n> ```\n# 正文\n';
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_nested' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle(content) }, ownerGeneration: 1, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.health.items.length, 0);
  assert.strictEqual(result.public.canExport, true);
});

test('footnote definition without a body reference is surfaced as a broken footnote', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n[^unused]: 来源\n') }, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.ok(result.public.warnings.some(item => item.reasonCode === 'DEFINITION_UNUSED'));
  assert.strictEqual(result.public.canExport, false);
});

test('inline code is not treated as a footnote reference', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_codespan' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文 `[^missing]`\n') }, ownerGeneration: 1, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.health.items.length, 0);
  assert.strictEqual(result.public.warnings.length, 0);
  assert.strictEqual(result.public.canExport, true);
});

test('inline HTML and image alt text are not treated as footnote references', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_inline_mask' }; } });
  const content = '# 标题\n<span>[^html]</span> ![alt [^image]](missing.png)\n';
  const result = service.preflight({ snapshot: { bundle: makeBundle(content) }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.health.items.length, 0);
  assert.strictEqual(result.public.canExport, true);
});

test('footnote definition binds a source marker from the source line', () => {
  const content = '# 标题\n正文 [^note]\n\n[^note]: 来源 <!-- writcraft-source:source_1 -->\n';
  const current = sourceIndexWithLocator({ contentSha256: bundle.digestBytes(Buffer.from(content)) });
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_source_marker' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle(content) }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: graph(), sourceIndex: current });
  assert.strictEqual(result.manifest.footnotes.length, 1);
  assert.strictEqual(result.manifest.footnotes[0].sourceId, 'source_1');
  assert.strictEqual(result.public.health.items.some(item => item.reasonCode === 'SOURCE_ID_UNBOUND'), false);
  assert.strictEqual(result.public.canExport, true);
});

test('footnote definitions are duplicate across selected files, not scoped to one file', () => {
  const files = [
    { fileId: 'file_chapter_a', path: 'chapter.md', revision, text: '# A\n正文 [^dup]\n\n[^dup]: 来源 A\n' },
    { fileId: 'file_chapter_b', path: 'chapter-b.md', revision: 'b'.repeat(64), text: '# B\n[^dup]: 来源 B\n' },
  ];
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeMultiBundle(files) }, request: requestForFiles(files, 'CONTINUE_WITH_WARNINGS'), graph: graphForFiles(files), sourceIndex: sourceIndex() });
  assert.ok(result.public.blockers.some(item => item.reasonCode === 'DEFINITION_DUPLICATE'));
  assert.strictEqual(result.public.canExport, false);
});

test('citation health roots bind footnoteKey instead of collapsing same-file causes', () => {
  const common = {
    snapshotId, type: 'broken_footnote', subjectId: fileId,
    reasonCode: 'REFERENCE_MISSING_DEFINITION', evidence: [],
  };
  const roots = [
    serviceModule.healthRootDigest({ ...common, subjectLabel: '[^alpha]' }),
    serviceModule.healthRootDigest({ ...common, subjectLabel: '[^beta]' }),
  ];
  assert.strictEqual(new Set(roots).size, 2);
});

test('invalid footnote keys are ignored rather than normalized into authority', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_invalid_footnote' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文 [^bad key]\n\n[^bad key]: 来源\n') }, ownerGeneration: 1, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.manifest.footnotes.length, 0);
  assert.strictEqual(result.public.health.items.length, 0);
  assert.strictEqual(result.public.canExport, true);
});

test('source revision mismatch is partial and never mints export capability', () => {
  const staleSource = { ...sourceIndex(), sources: [{ id: 'source_1', filePath: 'missing.md', revision, title: '来源', metadata: { url: 'https://example.com/a' } }] };
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('CONTINUE_WITH_WARNINGS'), graph: graph(), sourceIndex: staleSource });
  assert.strictEqual(result.public.health.status, 'partial');
  assert.strictEqual(result.public.canExport, false);
  assert.strictEqual(result.public.exportCapabilityId, null);
});

test('valid SourceIndex locator binds the snapshot line and duplicate identity evidence', () => {
  const duplicate = sourceIndexWithLocator();
  duplicate.sources.push({ ...duplicate.sources[0], id: 'source_2', title: '同一来源' });
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: duplicate });
  assert.ok(result.public.warnings.some(item => item.reasonCode === 'DUPLICATE_IDENTITY_URL'));
  assert.ok(result.manifest.sources.every(item => item.sourceIndexRevision.startsWith('sha256:')));
  const stale = sourceIndexWithLocator({ contentSha256: `sha256:${'f'.repeat(64)}` });
  assert.throws(() => service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('REVIEW_ONLY'), graph: graph(), sourceIndex: stale }), /content digest|DELIVERY_STALE/);
});

test('claims without a bound source cannot silently become exportable', () => {
  const unboundClaimGraph = { ...graph(), nodes: [{ id: 'claim_unbound', type: 'claim', label: '无来源论点', evidenceIds: [] }] };
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  assert.throws(() => service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('CONTINUE_WITH_WARNINGS'), graph: unboundClaimGraph, sourceIndex: sourceIndex() }), /来源证据|DELIVERY_STALE/);
});

test('current Graph evidence must carry block and content digest authority', () => {
  const invalidEvidenceGraph = { ...graph(), evidence: [{ id: 'ev_invalid', path: 'chapter.md', revision, start: 0, end: 3, quote: '# 标' }] };
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  assert.throws(() => service.preflight({ snapshot: { bundle: makeBundle('# 标题\n正文\n') }, request: request('CONTINUE_WITH_WARNINGS'), graph: invalidEvidenceGraph, sourceIndex: sourceIndex() }), /block|digest|DELIVERY_STALE/);
});

test('current Graph evidence with a real block anchor reaches the health projection', () => {
  const content = '# 标题\n正文\n';
  const blocks = blockAnchor.parseBlocks(content, 'chapter.md');
  const block = blocks[0];
  const duplicateOrdinal = blocks.filter(item => item.start <= block.start && item.headingKey === block.headingKey && item.type === block.type && item.fingerprint === block.fingerprint).length;
  const blockId = `blk_${crypto.createHash('sha256').update(`${block.path}\0${block.headingKey}\0${block.type}\0${block.fingerprint}\0${duplicateOrdinal}`, 'utf8').digest('hex').slice(0, 16)}`;
  const contentHashForBlock = `sha256:${crypto.createHash('sha256').update(Buffer.from(block.text, 'utf8')).digest('hex')}`;
  const validGraph = {
    ...graph(),
    nodes: [{ id: 'claim_valid', type: 'claim', label: '有证据但未绑定来源', evidenceIds: ['ev_aaaaaaaaaaaaaaaa'] }],
    evidence: [{ id: 'ev_aaaaaaaaaaaaaaaa', path: 'chapter.md', revision, start: block.start, end: block.end, quote: content.slice(block.start, block.end), blockId, contentHash: contentHashForBlock }],
  };
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_graph' }; } });
  const result = service.preflight({ snapshot: { bundle: makeBundle(content) }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: validGraph, sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.canExport, true);
  assert.ok(result.public.health.items.some(item => item.reasonCode === 'CLAIM_WITHOUT_SOURCE_BINDING'));
  assert.ok(result.public.health.items.some(item => item.reasonCode === 'CLAIM_SINGLE_VALID_EVIDENCE'));
});

test('referenced image is represented in manifest and its warning participates in capability gate', () => {
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { return { capabilityId: 'delivery_capability_image' }; } });
  const reviewOnly = service.preflight({ snapshot: { bundle: makeImageBundle() }, request: request('REVIEW_ONLY'), graph: graphForImageBundle(), sourceIndex: sourceIndex() });
  assert.strictEqual(reviewOnly.manifest.images.length, 1);
  assert.strictEqual(reviewOnly.manifest.resources.length, 1);
  assert.strictEqual(reviewOnly.public.canExport, false);
  assert.ok(reviewOnly.public.warnings.some(item => item.reasonCode === 'IMAGE_ALT_OR_CAPTION_MISSING'));
  const continued = service.preflight({ snapshot: { bundle: makeImageBundle() }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: graphForImageBundle(), sourceIndex: sourceIndex() });
  assert.strictEqual(continued.public.canExport, true);
});

test('every selected reference to one image must carry its own marked image metadata', () => {
  const content = '# 标题\n![有 alt](assets/pic.png)\n\n![缺 caption](assets/pic.png)\n';
  const references = [
    { fromFileId: fileId, tokenOrdinal: 3, locatorDigest: `sha256:${'5'.repeat(64)}` },
    { fromFileId: fileId, tokenOrdinal: 7, locatorDigest: `sha256:${'6'.repeat(64)}` },
  ];
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeImageBundle(content, null, 'assets/pic.png', references) }, ownerGeneration: 1, request: request('REVIEW_ONLY'), graph: graphForImageBundle(), sourceIndex: sourceIndex() });
  assert.ok(result.public.warnings.some(item => item.reasonCode === 'IMAGE_ALT_OR_CAPTION_MISSING'));
  assert.strictEqual(result.public.canExport, false);
});

test('corrupt image remains a blocker even when alt and caption are present', () => {
  const corrupt = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  corrupt[corrupt.length - 1] ^= 0xff;
  const service = serviceModule.createDeliveryPreflightService({ issueDeliveryCapability() { throw new Error('must not issue'); } });
  const result = service.preflight({ snapshot: { bundle: makeImageBundle('# 标题\n![图](assets/pic.png "说明")\n', corrupt) }, ownerGeneration: 1, request: request('CONTINUE_WITH_WARNINGS'), graph: graphForImageBundle(), sourceIndex: sourceIndex() });
  assert.strictEqual(result.public.canExport, false);
  assert.ok(result.public.blockers.some(item => item.reasonCode === 'IMAGE_DECODE_INVALID'));
});

test('Main native image decoder failures remain blockers after structural parsing', () => {
  const service = serviceModule.createDeliveryPreflightService({
    decodeImage() { throw new Error('native decoder rejected pixels'); },
    issueDeliveryCapability() { throw new Error('must not issue'); },
  });
  const result = service.preflight({
    snapshot: { bundle: makeImageBundle('# 标题\n![图](assets/pic.png "说明")\n') },
    ownerGeneration: 1,
    request: request('CONTINUE_WITH_WARNINGS'),
    graph: graphForImageBundle(),
    sourceIndex: sourceIndex(),
  });
  assert.strictEqual(result.public.canExport, false);
  assert.ok(result.public.blockers.some(item => item.reasonCode === 'IMAGE_DECODE_INVALID'));
});

test('production image path prefers the bound snapshot-entry decoder', () => {
  let calls = 0;
  const service = serviceModule.createDeliveryPreflightService({
    issueDeliveryCapability() { return { capabilityId: 'delivery_capability_entry' }; },
  });
  const result = service.preflight({
    snapshot: {
      bundle: makeImageBundle('# 标题\n![图](assets/pic.png "说明")\n'),
      decodeImageEntry({ binding, headerBytes, contentSha256, mimeType }) {
        calls += 1;
        assert.strictEqual(binding.fileId, 'file_image_a');
        assert.ok(Buffer.isBuffer(headerBytes));
        assert.match(contentSha256, /^sha256:[a-f0-9]{64}$/u);
        assert.strictEqual(mimeType, 'image/png');
        return { width: 1, height: 1, contentSha256 };
      },
    },
    ownerGeneration: 1,
    request: request('CONTINUE_WITH_WARNINGS'),
    graph: graphForImageBundle(),
    sourceIndex: sourceIndex(),
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(result.public.canExport, true);
});

console.log(`Stage B delivery preflight service: ${passed}/22 passed`);
