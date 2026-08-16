'use strict';

// This is an internal Main-only adapter. It deliberately does not import the
// live-root Graph/SourceIndex services: both currently take a root path and
// therefore cannot certify an exact committed snapshot.
const snapshotBundle = require('./snapshot-bundle');
const evidence = require('./evidence-delivery-schema');
const consistency = require('./consistency-engine');
const graphCorrectionService = require('./graph-correction-service');
const sourceIndexService = require('./source-index-service');
const crypto = require('crypto');

const SCHEMA = 'writcraft.snapshot-delivery-input/v1';
const GRAPH_SCHEMA = 'writcraft.graph/v2';
const SOURCE_INDEX_SCHEMA = 'writcraft.sources/v1';
const REVISION_RE = /^[a-f0-9]{64}$/u;

class SnapshotDeliveryProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotDeliveryProviderError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotDeliveryProviderError(code, message);
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactRequest(raw) {
  try {
    evidence.assertExactKeys(raw, ['projectInstanceId', 'snapshotId'], 'snapshot delivery provider request');
    evidence.assertProjectInstanceId(raw.projectInstanceId);
    evidence.assertOpaqueId(raw.snapshotId, 'snapshotId');
    return Object.freeze({ projectInstanceId: raw.projectInstanceId, snapshotId: raw.snapshotId });
  } catch (_) {
    fail('DELIVERY_BLOCKED', 'snapshot delivery provider 请求无效');
  }
}

function sameInputFiles(graph, manifest) {
  const expected = manifest.files.filter(file => file.kind === 'markdown')
    .map(file => ({ path: file.path, revision: file.revision })).sort((a, b) => compare(a.path, b.path));
  const actual = Array.isArray(graph?.manifest?.inputFiles)
    ? graph.manifest.inputFiles.map(item => ({ path: item.path, revision: item.revision }))
      .sort((a, b) => compare(a.path, b.path))
    : null;
  return actual !== null && JSON.stringify(actual) === JSON.stringify(expected);
}

function assertSnapshotGraph(raw, manifest) {
  try {
    evidence.assertPlainRecord(raw, 'snapshot Graph');
    if (raw.schema !== GRAPH_SCHEMA || !raw.manifest || !Array.isArray(raw.nodes) ||
        !Array.isArray(raw.edges) || !Array.isArray(raw.evidence) || !Array.isArray(raw.issues) ||
        !sameInputFiles(raw, manifest)) {
      fail('DELIVERY_STALE', 'Graph 未绑定已提交 snapshot');
    }
    return raw;
  } catch (error) {
    if (error instanceof SnapshotDeliveryProviderError) throw error;
    fail('DELIVERY_STALE', 'Graph snapshot binding 无效');
  }
}

function correctionDocumentDigest(document) {
  return evidence.digestObject('writcraft.graph-corrections/v1', document);
}

function emptyCorrectionArtifact() {
  const document = Object.freeze({
    schema: graphCorrectionService.CORRECTIONS_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    updatedAt: '1970-01-01T00:00:00.000Z',
    corrections: Object.freeze([]),
  });
  return Object.freeze({ document, digest: correctionDocumentDigest(document) });
}

function assertCorrectionArtifact(raw) {
  try {
    evidence.assertPlainRecord(raw, 'snapshot Graph correction artifact');
    evidence.assertPlainRecord(raw.document, 'snapshot Graph correction document');
    if (raw.document.schema !== graphCorrectionService.CORRECTIONS_SCHEMA ||
        raw.document.graphSchema !== GRAPH_SCHEMA || !Array.isArray(raw.document.corrections)) {
      fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact schema 无效');
    }
    evidence.assertDigest(raw.digest, 'snapshot Graph correction artifact digest');
    if (correctionDocumentDigest(raw.document) !== raw.digest) {
      fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact digest 不匹配');
    }
    return raw;
  } catch (error) {
    if (error instanceof SnapshotDeliveryProviderError) throw error;
    fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 不可用');
  }
}

function assertCorrectionRecordsBound(document, graphIdentity) {
  for (const correction of document.corrections) {
    if (!correction || typeof correction !== 'object' || Array.isArray(correction) ||
        correction.createdAgainst !== graphIdentity) {
      fail('DELIVERY_STALE', 'Graph correction 未绑定当前 Graph identity');
    }
  }
}

function assertSnapshotCorrectionArtifact(graph) {
  const correctionState = graph?.correctionState;
  if (!correctionState || typeof correctionState !== 'object' || Array.isArray(correctionState) ||
      correctionState.schema !== graphCorrectionService.CORRECTIONS_SCHEMA ||
      correctionState.persistenceBlocked === true || !Array.isArray(correctionState.corrections)) {
    fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 不可用');
  }
  let expectedGraphIdentity;
  try { expectedGraphIdentity = graphCorrectionService.graphIdentity(graph); }
  catch (_) { fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 不可用'); }
  if (correctionState.graphIdentity !== expectedGraphIdentity) {
    fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 未绑定当前 Graph');
  }
  for (const correction of correctionState.corrections) {
    if (!correction || typeof correction !== 'object' || Array.isArray(correction) ||
        typeof correction.id !== 'string' || correction.active !== true ||
        correction.evidenceState !== 'current') {
      fail('DELIVERY_STALE', 'Graph correction 存在未绑定或 stale 记录');
    }
  }
  return graph;
}

function assertSnapshotSourceIndex(raw, manifest) {
  try {
    evidence.assertPlainRecord(raw, 'snapshot SourceIndex');
    if (raw.schema !== SOURCE_INDEX_SCHEMA || !['ready', 'empty', 'partial'].includes(raw.status) ||
        !Array.isArray(raw.sources) || !Array.isArray(raw.errors)) {
      fail('DELIVERY_STALE', 'SourceIndex 输入无效');
    }
    evidence.assertDigest(raw.revision, 'SourceIndex revision');
    const files = new Map(manifest.files.filter(file => file.kind === 'markdown').map(file => [file.path, file]));
    const sourceIds = new Set();
    for (const source of raw.sources) {
      evidence.assertPlainRecord(source, 'snapshot SourceIndex source');
      evidence.assertOpaqueId(source.id, 'sourceId');
      if (sourceIds.has(source.id) || typeof source.filePath !== 'string' || !REVISION_RE.test(source.revision || '')) {
        fail('DELIVERY_STALE', 'SourceIndex source identity 无效');
      }
      const file = files.get(source.filePath);
      if (!file || file.revision !== source.revision) {
        fail('DELIVERY_STALE', 'SourceIndex source 未绑定同一 snapshot revision set');
      }
      sourceIds.add(source.id);
    }
    return raw;
  } catch (error) {
    if (error instanceof SnapshotDeliveryProviderError) throw error;
    fail('DELIVERY_STALE', 'SourceIndex snapshot binding 无效');
  }
}

function exactContext(raw) {
  try {
    evidence.assertExactKeys(raw, [
      'schema', 'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
      'fileRevisionSetDigest', 'creationMutationGeneration', 'bundle',
    ], 'snapshot delivery builder context');
    if (raw.schema !== SCHEMA || !Buffer.isBuffer(raw.bundle)) fail('DELIVERY_BLOCKED', 'snapshot delivery builder context 无效');
    evidence.assertProjectInstanceId(raw.projectInstanceId);
    evidence.assertOpaqueId(raw.snapshotId, 'snapshotId');
    evidence.assertDigest(raw.snapshotManifestDigest, 'snapshotManifestDigest');
    evidence.assertDigest(raw.fileRevisionSetDigest, 'fileRevisionSetDigest');
    evidence.assertSafeInteger(raw.creationMutationGeneration, 'creationMutationGeneration');
    const parsed = snapshotBundle.parseBundle(raw.bundle);
    if (parsed.manifest.projectInstanceId !== raw.projectInstanceId || parsed.manifest.snapshotId !== raw.snapshotId ||
        parsed.manifest.snapshotManifestDigest !== raw.snapshotManifestDigest ||
        parsed.manifest.fileRevisionSetDigest !== raw.fileRevisionSetDigest ||
        parsed.manifest.creationMutationGeneration !== raw.creationMutationGeneration) {
      fail('DELIVERY_STALE', 'snapshot delivery builder context 已漂移');
    }
    return parsed;
  } catch (error) {
    if (error instanceof SnapshotDeliveryProviderError) throw error;
    fail('DELIVERY_BLOCKED', 'snapshot delivery builder context 无效');
  }
}

function snapshotMarkdownFiles(context) {
  const parsed = exactContext(context);
  const bytes = new Map(parsed.bindings.map(binding => [
    binding.fileId,
    context.bundle.subarray(binding.contentOffset, binding.contentOffset + binding.contentLength),
  ]));
  return {
    parsed,
    files: parsed.manifest.files.filter(file => file.kind === 'markdown').map(file => ({
      fileId: file.fileId,
      path: file.path,
      revision: file.revision,
      sha256: file.sha256,
      content: bytes.get(file.fileId).toString('utf8'),
    })),
  };
}

function buildSnapshotGraph(context, correctionArtifact = emptyCorrectionArtifact()) {
  const { parsed, files } = snapshotMarkdownFiles(context);
  let graph;
  try {
    graph = consistency.analyzeProject(files.map(file => ({
      path: file.path, revision: file.revision, content: file.content,
    })), { capturedAt: parsed.manifest.createdAt });
  } catch (_) {
    fail('DELIVERY_SNAPSHOT_DERIVATION_UNAVAILABLE', 'snapshot Graph 解析失败');
  }
  let corrected;
  try {
    const identity = graphCorrectionService.graphIdentity(graph);
    assertCorrectionRecordsBound(correctionArtifact.document, identity);
    corrected = graphCorrectionService.applyCorrectionsDocument(
      graph,
      correctionArtifact.document,
      { reason: null, persistenceBlocked: false },
    );
  } catch (_) {
    fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 无法应用');
  }
  return Object.freeze({
    ...corrected,
    manifest: Object.freeze({
      inputFiles: Object.freeze(files.map(file => ({ path: file.path, revision: file.revision }))
        .sort((left, right) => compare(left.path, right.path))),
      truncated: false,
      warnings: Object.freeze([]),
    }),
    correctionState: Object.freeze({
      ...corrected.correctionState,
      artifactDigest: correctionArtifact.digest,
    }),
  });
}

function sourceId(path) {
  return `src_${crypto.createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 20)}`;
}

function sourceLocator(file, title, offset) {
  const safeOffset = Math.max(0, Math.min(offset, file.content.length));
  const lineStart = file.content.lastIndexOf('\n', safeOffset - 1) + 1;
  const lineEnd = file.content.indexOf('\n', safeOffset);
  const lineBoundary = lineEnd === -1 ? file.content.length : lineEnd + 1;
  return {
    filePath: file.path,
    offset: safeOffset,
    // A front-matter/basename fallback title is not necessarily present in
    // the first line. Bind the locator to that complete line instead of
    // inventing an end offset past the line boundary.
    end: Math.min(file.content.length, Math.max(safeOffset, lineBoundary)),
    line: file.content.slice(0, safeOffset).split('\n').length,
    column: safeOffset - lineStart + 1,
    quote: file.content.slice(lineStart, lineEnd === -1 ? file.content.length : lineEnd).trim().slice(0, 240),
  };
}

function buildSnapshotSourceIndex(context) {
  const { files } = snapshotMarkdownFiles(context);
  const sources = files.filter(file => {
    const metadata = sourceIndexService.parseFrontMatter(file.content);
    const type = String(metadata.type || metadata.kind || metadata.source_type || '').toLowerCase();
    return file.path === 'references.md' || file.path.startsWith('references/') ||
      ['source', 'reference', 'citation'].includes(type) || Boolean(metadata.url || metadata.source_url || metadata.canonical_url);
  }).map(file => {
    const metadata = sourceIndexService.parseFrontMatter(file.content);
    const rawUrl = metadata.url || metadata.source_url || metadata.canonical_url || '';
    const url = sourceIndexService.safeHttpUrl(rawUrl);
    const type = String(metadata.type || metadata.kind || metadata.source_type || '').toLowerCase() || null;
    const heading = /^#\s+(.+?)\s*$/mu.exec(file.content);
    const title = metadata.title || heading?.[1] || file.path.split('/').at(-1).replace(/\.(?:md|markdown)$/iu, '');
    const offset = heading && heading[1] === title ? file.content.indexOf(title, heading.index) : Math.max(0, file.content.indexOf(title));
    return {
      id: sourceId(file.path), filePath: file.path, revision: file.revision,
      contentSha256: file.sha256, title,
      metadata: { type, author: metadata.author || null, published: metadata.published || metadata.date || null,
        citationKey: metadata.citation_key || metadata.citekey || null, url },
      indexStatus: url || !rawUrl ? 'indexed' : 'indexed_with_warnings',
      errors: url || !rawUrl ? [] : [{ code: 'UNSAFE_URL', message: '来源 URL 仅允许 http/https 且不得嵌入凭据' }],
      isReferenced: false, citationCount: 0, referencedBy: [], isCiting: false, citesCount: 0, citesSources: [], outboundLinks: [],
      locator: sourceLocator(file, title, offset),
    };
  }).sort((left, right) => compare(left.filePath, right.filePath));
  const errors = sources.flatMap(source => source.errors.map(error => ({ ...error, filePath: source.filePath })))
    .sort((left, right) => compare(`${left.filePath}\0${left.code}`, `${right.filePath}\0${right.code}`));
  const revision = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ sources, errors }), 'utf8').digest('hex')}`;
  return Object.freeze({
    schema: SOURCE_INDEX_SCHEMA,
    status: errors.length ? 'partial' : (sources.length ? 'ready' : 'empty'),
    revision,
    sources: Object.freeze(sources),
    errors: Object.freeze(errors),
    counts: Object.freeze({ sources: sources.length, referenced: 0, errors: errors.length, scannedFiles: files.length,
      scannedBytes: files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0) }),
  });
}

function createSnapshotDeliveryProvider(options = {}) {
  const readCommittedBundle = options.readCommittedBundle;
  const buildGraph = Object.hasOwn(options, 'buildSnapshotGraph') ? options.buildSnapshotGraph : buildSnapshotGraph;
  const buildSourceIndex = Object.hasOwn(options, 'buildSnapshotSourceIndex') ? options.buildSnapshotSourceIndex : buildSnapshotSourceIndex;
  const readCorrectionArtifact = typeof options.readCorrectionArtifact === 'function'
    ? options.readCorrectionArtifact : async () => emptyCorrectionArtifact();
  if (typeof readCommittedBundle !== 'function') throw new TypeError('readCommittedBundle is required');

  async function read(rawRequest) {
    const request = exactRequest(rawRequest);
    let loaded;
    try {
      loaded = await readCommittedBundle(Object.freeze({ ...request }));
    } catch (error) {
      if (error?.code === 'SNAPSHOT_UNAVAILABLE') fail('SNAPSHOT_UNAVAILABLE', '已提交 snapshot 不可用');
      fail('DELIVERY_BLOCKED', '读取已提交 snapshot 失败');
    }
    const loadedBundle = Buffer.isBuffer(loaded) ? loaded : loaded?.bundle;
    if (!Buffer.isBuffer(loadedBundle)) fail('SNAPSHOT_UNAVAILABLE', '已提交 snapshot bundle 无效');
    let handedOff = false;
    try {

    // Do not hand a provider the storage-owned Buffer. Every provider sees a
    // separate bounded copy and the final service gets another fresh copy.
    const ownedBundle = Buffer.from(loadedBundle);
    let parsed;
    try { parsed = snapshotBundle.parseBundle(ownedBundle); }
    catch (_) { fail('SNAPSHOT_UNAVAILABLE', '已提交 snapshot bundle 损坏'); }
    const manifest = parsed.manifest;
    if (manifest.projectInstanceId !== request.projectInstanceId || manifest.snapshotId !== request.snapshotId) {
      fail('DELIVERY_STALE', '已提交 snapshot 不属于当前请求');
    }
    if (typeof buildGraph !== 'function' || typeof buildSourceIndex !== 'function') {
      fail('DELIVERY_SNAPSHOT_DERIVATION_UNAVAILABLE', '尚无 snapshot-bound Graph/SourceIndex builder');
    }
    const context = Object.freeze({
      schema: SCHEMA,
      projectInstanceId: manifest.projectInstanceId,
      snapshotId: manifest.snapshotId,
      snapshotManifestDigest: manifest.snapshotManifestDigest,
      fileRevisionSetDigest: manifest.fileRevisionSetDigest,
      creationMutationGeneration: manifest.creationMutationGeneration,
      bundle: Buffer.from(ownedBundle),
    });
    let graph;
    let sourceIndex;
    let correctionArtifact;
    let correctionAfter;
    try {
      correctionArtifact = assertCorrectionArtifact(await readCorrectionArtifact(Object.freeze({ ...request })));
      graph = await buildGraph(Object.freeze({ ...context, bundle: Buffer.from(ownedBundle) }), correctionArtifact);
      sourceIndex = await buildSourceIndex(Object.freeze({ ...context, bundle: Buffer.from(ownedBundle) }));
      correctionAfter = await readCorrectionArtifact(Object.freeze({ ...request }));
      if (assertCorrectionArtifact(correctionAfter).digest !== correctionArtifact.digest) {
        fail('DELIVERY_STALE', 'snapshot-bound Graph correction artifact 在读取期间发生变化');
      }
    } catch (error) {
      if (error instanceof SnapshotDeliveryProviderError) throw error;
      fail('DELIVERY_SNAPSHOT_DERIVATION_UNAVAILABLE', 'snapshot-bound Graph/SourceIndex 未完成');
    }
    assertSnapshotGraph(graph, manifest);
    try {
      assertCorrectionRecordsBound(correctionArtifact.document, graphCorrectionService.graphIdentity(graph));
    } catch (error) {
      if (error instanceof SnapshotDeliveryProviderError) throw error;
      fail('DELIVERY_STALE', 'Graph correction 未绑定当前 Graph identity');
    }
    assertSnapshotCorrectionArtifact(graph);
    assertSnapshotSourceIndex(sourceIndex, manifest);
    try { snapshotBundle.parseBundle(ownedBundle); }
    catch (_) { fail('DELIVERY_STALE', 'snapshot bundle 在构造输入时发生变化'); }
    const result = Object.freeze({
      snapshot: Object.freeze({
        bundle: Buffer.from(ownedBundle),
        ...(typeof loaded?.decodeImageEntry === 'function' ? { decodeImageEntry: loaded.decodeImageEntry } : {}),
        ...(typeof loaded?.disposeSnapshot === 'function' ? { disposeSnapshot: loaded.disposeSnapshot } : {}),
      }),
      graph,
      sourceIndex,
    });
    handedOff = true;
    return result;
    } catch (error) {
      if (!handedOff && typeof loaded?.disposeSnapshot === 'function') {
        try { loaded.disposeSnapshot(); } catch (_) {}
      }
      throw error;
    }
  }

  return Object.freeze({ read });
}

module.exports = Object.freeze({
  SCHEMA,
  SnapshotDeliveryProviderError,
  exactRequest,
  exactContext,
  assertSnapshotGraph,
  assertCorrectionArtifact,
  assertCorrectionRecordsBound,
  assertSnapshotCorrectionArtifact,
  assertSnapshotSourceIndex,
  buildSnapshotGraph,
  buildSnapshotSourceIndex,
  createSnapshotDeliveryProvider,
});
