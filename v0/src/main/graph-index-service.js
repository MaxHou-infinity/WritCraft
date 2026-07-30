'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const blockAnchor = require('../renderer/block-anchor');
const {
  SCHEMA,
  NODE_TYPES,
  EDGE_TYPES,
  ISSUE_TYPES,
  DEFAULT_LIMITS,
  MAX_EVOLUTION_PATHS,
  analyzeProject,
  mergeAnalyzedGraphs,
} = require('./consistency-engine');
const graphCorrectionService = require('./graph-correction-service');

const CACHE_VERSION = 2;
const CACHE_RELATIVE_PATH = '.writcraft/graph.json';
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const REVISION_RE = /^[a-f0-9]{64}$/;
const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const BLOCK_ID_RE = /^blk_[a-f0-9]{16}$/;
const PUBLIC_ERROR_CODES = new Set([
  'ANALYZER_AUTHORITY_MISMATCH',
  'AUTHORITY_SNAPSHOT_MISMATCH',
  'CACHE_TOO_LARGE',
  'EVIDENCE_SNAPSHOT_MISMATCH',
  'INVALID_CACHE',
  'INVALID_PROJECT_SERVICE',
  'INVALID_ROOT',
  'UNSAFE_CACHE_PATH',
  'UNSAFE_PATH',
]);

class GraphIndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GraphIndexError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GraphIndexError(code, message);
}

function publicGraphIndexFailure(error) {
  if (!(error instanceof GraphIndexError)) return null;
  return {
    ok: false,
    error: PUBLIC_ERROR_CODES.has(error.code) ? error.code : 'GRAPH_INDEX_FAILED',
    message: '图谱分析未完成。正文没有变化，请点击“重新分析”再试',
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail('UNSAFE_PATH', '图谱文件路径无效');
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    fail('UNSAFE_PATH', '图谱只接受项目内相对路径');
  }
  if (value.includes('\\') || value.includes('//')) fail('UNSAFE_PATH', '图谱路径必须使用规范的 /');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('UNSAFE_PATH', '图谱不能索引隐藏或越界路径');
  }
  if (!/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) fail('UNSAFE_PATH', '图谱只索引 Markdown 文件');
  return parts.join('/');
}

function assertRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath) fail('INVALID_ROOT', '项目目录无效');
  const absolute = path.resolve(rootPath);
  let stat;
  try { stat = fs.statSync(absolute); } catch (_) { fail('INVALID_ROOT', '项目目录不存在'); }
  if (!stat.isDirectory()) fail('INVALID_ROOT', '项目路径不是目录');
  return fs.realpathSync(absolute);
}

function cacheAbsolute(rootPath, createMetadataDirectory = false) {
  const root = assertRoot(rootPath);
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    if (!createMetadataDirectory) return { root, metadata, cache: path.join(metadata, 'graph.json'), exists: false };
    fs.mkdirSync(metadata, { mode: 0o700 });
  }
  const stat = fs.lstatSync(metadata);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_CACHE_PATH', '.writcraft 必须是项目内普通目录');
  if (fs.realpathSync(metadata) !== metadata) fail('UNSAFE_CACHE_PATH', '.writcraft 已越出项目目录');
  const cache = path.join(metadata, 'graph.json');
  if (fs.existsSync(cache)) {
    const cacheStat = fs.lstatSync(cache);
    if (cacheStat.isSymbolicLink() || !cacheStat.isFile()) fail('UNSAFE_CACHE_PATH', 'graph.json 必须是普通文件');
  }
  return { root, metadata, cache, exists: fs.existsSync(cache) };
}

function atomicWrite(filePath, content) {
  const temporary = path.join(
    path.dirname(filePath),
    `.graph.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    try {
      const directoryFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function graphView(cache, rootPath) {
  const raw = {
    schema: cache.schema,
    nodes: cache.nodes,
    edges: cache.edges,
    evidence: cache.evidence,
    issues: cache.issues,
    manifest: cache.manifest,
  };
  return rootPath ? graphCorrectionService.applyCorrections(rootPath, raw) : raw;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contributionHash(fileGraphs) {
  return crypto.createHash('sha256').update(JSON.stringify(fileGraphs), 'utf8').digest('hex');
}

function evidenceId(pathname, start, end, revision) {
  return `ev_${crypto.createHash('sha256')
    .update(`${pathname}\0${start}\0${end}\0${revision}`)
    .digest('hex').slice(0, 16)}`;
}

function authorityGraph(graph) {
  return {
    ...graph,
    nodes: Array.isArray(graph?.nodes)
      ? graph.nodes.map(item => ({ ...item, updatedAt: '<snapshot-capture>' }))
      : graph?.nodes,
    evidence: Array.isArray(graph?.evidence)
      ? graph.evidence.map(item => ({ ...item, capturedAt: '<snapshot-capture>' }))
      : graph?.evidence,
  };
}

function validateContribution(entry) {
  if (!entry || typeof entry !== 'object') fail('INVALID_CACHE', '文件图谱缓存无效');
  const filePath = publicMarkdownPath(entry.path);
  if (!REVISION_RE.test(entry.revision || '')) fail('INVALID_CACHE', '文件图谱 revision 无效');
  const graph = entry.graph;
  if (!graph || graph.schema !== SCHEMA || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) ||
      !Array.isArray(graph.evidence) || !Array.isArray(graph.issues)) {
    fail('INVALID_CACHE', '文件图谱贡献无效');
  }
  const evidenceIds = new Set();
  const evidenceById = new Map();
  for (const evidence of graph.evidence) {
    if (!evidence || typeof evidence.id !== 'string' || publicMarkdownPath(evidence.path) !== filePath ||
        evidence.filePath !== filePath || !BLOCK_ID_RE.test(evidence.blockId || '') ||
        !CONTENT_HASH_RE.test(evidence.contentHash || '') || Number.isNaN(Date.parse(evidence.capturedAt || '')) ||
        !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 || evidence.end < evidence.start || typeof evidence.quote !== 'string' ||
        evidence.end - evidence.start !== evidence.quote.length ||
        typeof evidence.confidence !== 'number' || evidence.confidence < 0 || evidence.confidence > 1) {
      fail('INVALID_CACHE', '缓存证据路径无效');
    }
    if (evidence.revision !== entry.revision || evidenceIds.has(evidence.id)) {
      fail('INVALID_CACHE', '缓存证据 revision 或 ID 无效');
    }
    evidenceIds.add(evidence.id);
    evidenceById.set(evidence.id, evidence);
  }
  const nodeIds = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.type !== 'string' || !node.type || typeof node.label !== 'string' ||
        !Array.isArray(node.aliases) || node.aliases.some(alias => typeof alias !== 'string') ||
        typeof node.summary !== 'string' || typeof node.key !== 'string' ||
        !node.attributes || typeof node.attributes !== 'object' || Array.isArray(node.attributes) ||
        !Array.isArray(node.evidenceIds) || node.evidenceIds.some(id => !evidenceIds.has(id)) ||
        typeof node.explicitDeclaration !== 'boolean' || !Array.isArray(node.declarationEvidenceIds) ||
        node.declarationEvidenceIds.some(id => !evidenceIds.has(id) || !node.evidenceIds.includes(id)) ||
        !Array.isArray(node.declarationTypes) || node.declarationTypes.some(type => !['person', 'organization', 'place', 'variable'].includes(type)) ||
        (node.explicitDeclaration ? !node.declarationEvidenceIds.length || !node.declarationTypes.length : node.declarationEvidenceIds.length > 0 || node.declarationTypes.length > 0) ||
        typeof node.confidence !== 'number' || node.confidence < 0 || node.confidence > 1 ||
        !['proposed', 'confirmed', 'rejected'].includes(node.status) || Number.isNaN(Date.parse(node.updatedAt || '')) ||
        nodeIds.has(node.id)) {
      fail('INVALID_CACHE', '缓存节点证据引用无效');
    }
    nodeIds.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of graph.edges) {
    const uniqueEvidenceIds = [...new Set(edge?.evidenceIds || [])].sort(compareText);
    const allPaths = [...new Set(uniqueEvidenceIds.map(id => evidenceById.get(id)?.path).filter(Boolean))].sort(compareText);
    const expectedEvolution = {
      evidenceCount: uniqueEvidenceIds.length,
      pathCount: allPaths.length,
      paths: allPaths.slice(0, MAX_EVOLUTION_PATHS),
      firstPath: allPaths[0] || '',
      lastPath: allPaths[allPaths.length - 1] || '',
    };
    const expectedAssertionMode = ['supports', 'contradicts'].includes(edge?.relation)
      ? 'explicit_statement'
      : ['foreshadows', 'resolves'].includes(edge?.relation) ? 'explicit_marker' : null;
    if (!edge || typeof edge.id !== 'string' || !EDGE_TYPES.includes(edge.type) ||
        !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || typeof edge.directed !== 'boolean' ||
        typeof edge.label !== 'string' || typeof edge.relation !== 'string' ||
        (edge.assertionMode || null) !== expectedAssertionMode ||
        !(edge.property === null || edge.property === undefined || typeof edge.property === 'string') ||
        !['project_prompt', 'manuscript'].includes(edge.source) ||
        typeof edge.confidence !== 'number' || edge.confidence < 0 || edge.confidence > 1 ||
        !['proposed', 'confirmed', 'rejected'].includes(edge.status) ||
        !Array.isArray(edge.evidenceIds) || edge.evidenceIds.some(id => !evidenceIds.has(id)) ||
        !sameJson(edge.evidenceIds, uniqueEvidenceIds) || !edge.evolution || Array.isArray(edge.evolution) ||
        !sameJson(edge.evolution, expectedEvolution) || edgeIds.has(edge.id)) {
      fail('INVALID_CACHE', '缓存关系证据引用无效');
    }
    edgeIds.add(edge.id);
  }
  const issueIds = new Set();
  for (const issue of graph.issues) {
    if (!issue || typeof issue.id !== 'string' || !ISSUE_TYPES.includes(issue.type) ||
        !['error', 'warning', 'info'].includes(issue.severity) || typeof issue.title !== 'string' ||
        typeof issue.description !== 'string' || issue.message !== issue.description ||
        !['open', 'acknowledged', 'dismissed', 'resolved'].includes(issue.status) ||
        !(issue.resolution === null || typeof issue.resolution === 'object') ||
        !issue.details || typeof issue.details !== 'object' || Array.isArray(issue.details) ||
        typeof issue.confidence !== 'number' || issue.confidence < 0 || issue.confidence > 1 ||
        !Array.isArray(issue.nodeIds) || issue.nodeIds.some(id => !nodeIds.has(id)) ||
        !Array.isArray(issue.edgeIds) || issue.edgeIds.some(id => !edgeIds.has(id)) ||
        !Array.isArray(issue.evidenceIds) || issue.evidenceIds.some(id => !evidenceIds.has(id)) ||
        issueIds.has(issue.id)) {
      fail('INVALID_CACHE', '缓存问题契约或证据引用无效');
    }
    issueIds.add(issue.id);
  }
  return { path: filePath, revision: entry.revision, graph };
}

function validateContributionAgainstSnapshot(entry, snapshot) {
  const contribution = validateContribution(entry);
  if (!snapshot || typeof snapshot.content !== 'string' ||
      !REVISION_RE.test(snapshot.revision || '') || snapshot.revision !== contribution.revision) {
    fail('EVIDENCE_SNAPSHOT_MISMATCH', '图谱贡献与当前文件 revision 不一致');
  }
  const blocks = blockAnchor.parseBlocks(snapshot.content, contribution.path);
  for (const evidence of contribution.graph.evidence) {
    const block = blocks.find(item => evidence.start >= item.start && evidence.start <= item.end &&
      evidence.end <= item.end);
    const duplicateOrdinal = block ? blocks.filter(item => item.start <= block.start &&
      item.headingKey === block.headingKey && item.type === block.type &&
      item.fingerprint === block.fingerprint).length : 0;
    const expectedBlockId = block ? `blk_${crypto.createHash('sha256')
      .update(`${contribution.path}\0${block.headingKey}\0${block.type}\0${block.fingerprint}\0${duplicateOrdinal}`)
      .digest('hex').slice(0, 16)}` : '';
    const expectedContentHash = block ? `sha256:${crypto.createHash('sha256')
      .update(String(block.text), 'utf8').digest('hex')}` : '';
    if (evidence.path !== contribution.path || evidence.filePath !== contribution.path ||
        evidence.revision !== snapshot.revision ||
        !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
        evidence.start < 0 || evidence.end <= evidence.start || evidence.end > snapshot.content.length ||
        snapshot.content.slice(evidence.start, evidence.end) !== evidence.quote ||
        evidence.id !== evidenceId(contribution.path, evidence.start, evidence.end, snapshot.revision) ||
        evidence.blockId !== expectedBlockId || evidence.contentHash !== expectedContentHash) {
      fail('EVIDENCE_SNAPSHOT_MISMATCH', '图谱证据无法由当前文件快照证明');
    }
  }
  return contribution;
}

function validateCache(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== SCHEMA || raw.cacheVersion !== CACHE_VERSION) {
    fail('INVALID_CACHE', '图谱缓存 schema 或版本过旧');
  }
  if (!raw.manifest || !Array.isArray(raw.manifest.inputFiles) || !Array.isArray(raw.manifest.inventory) ||
      !Array.isArray(raw.fileGraphs) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges) ||
      !Array.isArray(raw.evidence) || !Array.isArray(raw.issues)) {
    fail('INVALID_CACHE', '图谱缓存结构不完整');
  }
  const seen = new Set();
  const fileGraphs = raw.fileGraphs.map(entry => {
    const valid = validateContribution(entry);
    if (seen.has(valid.path)) fail('INVALID_CACHE', '图谱缓存包含重复文件');
    seen.add(valid.path);
    return valid;
  }).sort((a, b) => compareText(a.path, b.path));
  const expectedManifest = fileGraphs.map(entry => ({ path: entry.path, revision: entry.revision }));
  const manifestFiles = raw.manifest.inputFiles.map(entry => ({
    path: publicMarkdownPath(entry.path),
    revision: REVISION_RE.test(entry.revision || '') ? entry.revision : fail('INVALID_CACHE', 'manifest revision 无效'),
  })).sort((a, b) => compareText(a.path, b.path));
  if (!sameJson(expectedManifest, manifestFiles)) fail('INVALID_CACHE', 'manifest 与文件图谱不一致');
  if (raw.manifest.contributionsHash !== contributionHash(fileGraphs)) {
    fail('INVALID_CACHE', '文件图谱贡献摘要不一致');
  }
  for (const item of raw.manifest.inventory) {
    publicMarkdownPath(item.path);
    if (item.size !== null && (!Number.isSafeInteger(item.size) || item.size < 0)) fail('INVALID_CACHE', 'inventory size 无效');
  }
  const merged = mergeAnalyzedGraphs(fileGraphs.map(entry => entry.graph));
  const readableNodes = raw.nodes.map(node => ({
    ...node,
    type: NODE_TYPES.includes(node?.type) ? node.type : 'entity',
  }));
  if (!sameJson(merged.nodes, readableNodes) || !sameJson(merged.edges, raw.edges) ||
      !sameJson(merged.evidence, raw.evidence) || !sameJson(merged.issues, raw.issues)) {
    fail('INVALID_CACHE', '统一图谱与文件贡献不一致');
  }
  return { ...raw, nodes: merged.nodes, fileGraphs };
}

function loadGraphCache(rootPath) {
  let location;
  try { location = cacheAbsolute(rootPath, false); } catch (error) {
    if (error instanceof GraphIndexError) throw error;
    return { cache: null, reason: 'CACHE_PATH_ERROR' };
  }
  if (!location.exists) return { cache: null, reason: 'CACHE_MISSING' };
  try {
    const stat = fs.statSync(location.cache);
    if (stat.size > MAX_CACHE_BYTES) return { cache: null, reason: 'CACHE_TOO_LARGE' };
    const raw = JSON.parse(fs.readFileSync(location.cache, 'utf8'));
    return { cache: validateCache(raw), reason: null };
  } catch (error) {
    if (error instanceof GraphIndexError && error.code === 'UNSAFE_CACHE_PATH') throw error;
    return { cache: null, reason: error instanceof GraphIndexError ? 'CACHE_INVALID' : 'CACHE_CORRUPT' };
  }
}

function saveGraphCache(rootPath, cache) {
  const valid = validateCache(cache);
  const serialized = `${JSON.stringify(valid, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_BYTES) fail('CACHE_TOO_LARGE', '图谱缓存超过大小上限');
  const location = cacheAbsolute(rootPath, true);
  atomicWrite(location.cache, serialized);
  return location.cache;
}

function flattenMarkdown(tree) {
  if (!Array.isArray(tree)) fail('INVALID_PROJECT_SERVICE', 'listTree 未返回数组');
  const files = [];
  const seen = new Set();
  function visit(nodes) {
    if (!Array.isArray(nodes)) fail('UNSAFE_PATH', '项目目录树无效');
    for (const node of nodes) {
      if (!node || typeof node !== 'object') fail('UNSAFE_PATH', '项目目录树节点无效');
      if (node.type === 'directory') visit(node.children);
      else if (node.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) {
        const filePath = publicMarkdownPath(node.path);
        if (seen.has(filePath)) fail('UNSAFE_PATH', '项目目录树包含重复 Markdown 文件');
        seen.add(filePath);
        files.push({ path: filePath, size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null });
      }
    }
  }
  visit(tree);
  return files.sort((a, b) => compareText(a.path, b.path));
}

function cacheInventory(files) {
  return files.map(file => ({ path: file.path, size: file.size }));
}

function buildCache(fileGraphs, inventory, warnings, previousGeneratedAt) {
  const sorted = [...fileGraphs].sort((a, b) => compareText(a.path, b.path));
  const merged = mergeAnalyzedGraphs(sorted.map(entry => entry.graph));
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    cacheVersion: CACHE_VERSION,
    generatedBy: 'writcraft-graph-index-service',
    nodes: merged.nodes,
    edges: merged.edges,
    evidence: merged.evidence,
    issues: merged.issues,
    manifest: {
      generatedAt: previousGeneratedAt || now,
      updatedAt: now,
      inputFiles: sorted.map(entry => ({ path: entry.path, revision: entry.revision })),
      contributionsHash: contributionHash(sorted),
      inventory,
      stats: {
        files: sorted.length,
        nodes: merged.nodes.length,
        edges: merged.edges.length,
        evidence: merged.evidence.length,
        issues: merged.issues.length,
      },
      truncated: warnings.length > 0,
      warnings,
    },
    fileGraphs: sorted,
  };
}

function indexProjectGraph(projectService, rootPath, options = {}) {
  if (!projectService || typeof projectService.listTree !== 'function' || typeof projectService.readFileWithRevision !== 'function') {
    fail('INVALID_PROJECT_SERVICE', 'projectService 缺少 listTree/readFileWithRevision 接口');
  }
  const analyzer = typeof options.analyzeProject === 'function' ? options.analyzeProject : analyzeProject;
  const files = flattenMarkdown(projectService.listTree(rootPath));
  const inventory = cacheInventory(files);
  const loaded = loadGraphCache(rootPath);
  const oldByPath = new Map((loaded.cache?.fileGraphs || []).map(entry => [entry.path, entry]));
  const current = [];
  const warnings = [];
  const analyzedPaths = [];
  const reusedPaths = [];
  let authoritySnapshotMismatch = false;
  let totalBytes = 0;

  for (const file of files) {
    if (current.length >= DEFAULT_LIMITS.maxFiles) {
      warnings.push({ code: 'MAX_FILES', path: file.path });
      continue;
    }
    if (file.size !== null && file.size > DEFAULT_LIMITS.maxFileBytes) {
      warnings.push({ code: 'FILE_TOO_LARGE', path: file.path, bytes: file.size });
      continue;
    }
    if (file.size !== null && totalBytes + file.size > DEFAULT_LIMITS.maxTotalBytes) {
      warnings.push({ code: 'TOTAL_SIZE_LIMIT', path: file.path, bytes: file.size });
      continue;
    }
    let snapshot;
    try { snapshot = projectService.readFileWithRevision(rootPath, file.path); } catch (error) {
      warnings.push({ code: 'READ_ERROR', path: file.path, error: error && error.code ? error.code : 'READ_FAILED' });
      continue;
    }
    if (!snapshot || typeof snapshot.content !== 'string' || !REVISION_RE.test(snapshot.revision || '')) {
      fail('INVALID_PROJECT_SERVICE', 'readFileWithRevision 返回无效快照');
    }
    const bytes = Buffer.byteLength(snapshot.content, 'utf8');
    if (bytes > DEFAULT_LIMITS.maxFileBytes) {
      warnings.push({ code: 'FILE_TOO_LARGE', path: file.path, bytes });
      continue;
    }
    if (totalBytes + bytes > DEFAULT_LIMITS.maxTotalBytes) {
      warnings.push({ code: 'TOTAL_SIZE_LIMIT', path: file.path, bytes });
      continue;
    }
    totalBytes += bytes;
    const input = [{ path: file.path, content: snapshot.content, revision: snapshot.revision }];
    const expectedGraph = analyzeProject(input);
    const expectedContribution = validateContributionAgainstSnapshot(
      { path: file.path, revision: snapshot.revision, graph: expectedGraph },
      snapshot
    );
    const old = oldByPath.get(file.path);
    if (old && old.revision === snapshot.revision) {
      try {
        const validatedOld = validateContributionAgainstSnapshot(old, snapshot);
        if (!sameJson(authorityGraph(validatedOld.graph), authorityGraph(expectedContribution.graph))) {
          fail('AUTHORITY_SNAPSHOT_MISMATCH', '图谱贡献语义无法由当前文件快照重建');
        }
        current.push(validatedOld);
        reusedPaths.push(file.path);
        continue;
      } catch (error) {
        if (!(error instanceof GraphIndexError) ||
            !['EVIDENCE_SNAPSHOT_MISMATCH', 'AUTHORITY_SNAPSHOT_MISMATCH'].includes(error.code)) throw error;
        authoritySnapshotMismatch = true;
      }
    }
    const graph = analyzer === analyzeProject ? expectedGraph : analyzer(input);
    const contribution = validateContributionAgainstSnapshot(
      { path: file.path, revision: snapshot.revision, graph },
      snapshot
    );
    if (!sameJson(authorityGraph(contribution.graph), authorityGraph(expectedContribution.graph))) {
      fail('ANALYZER_AUTHORITY_MISMATCH', '分析器输出语义无法由当前文件快照重建');
    }
    current.push(contribution);
    analyzedPaths.push(file.path);
  }

  warnings.sort((a, b) => compareText(`${a.code}\0${a.path || ''}`, `${b.code}\0${b.path || ''}`));
  const currentPaths = new Set(current.map(entry => entry.path));
  const removedPaths = [...oldByPath.keys()].filter(filePath => !currentPaths.has(filePath)).sort(compareText);
  const inputs = current.map(entry => ({ path: entry.path, revision: entry.revision })).sort((a, b) => compareText(a.path, b.path));
  const cacheHit = loaded.cache && !authoritySnapshotMismatch &&
    sameJson(loaded.cache.manifest.inputFiles, inputs) &&
    sameJson(loaded.cache.manifest.inventory, inventory) && sameJson(loaded.cache.manifest.warnings, warnings);

  if (cacheHit) {
    return {
      graph: graphView(loaded.cache, rootPath),
      status: 'cache_hit',
      analyzedPaths: [],
      reusedPaths,
      removedPaths: [],
      cacheReason: null,
    };
  }

  const cache = buildCache(current, inventory, warnings, loaded.cache?.manifest.generatedAt);
  saveGraphCache(rootPath, cache);
  return {
    graph: graphView(cache, rootPath),
    status: loaded.cache ? 'incremental' : 'rebuilt',
    analyzedPaths,
    reusedPaths,
    removedPaths,
    cacheReason: authoritySnapshotMismatch ? 'AUTHORITY_SNAPSHOT_MISMATCH' : loaded.reason,
  };
}

module.exports = {
  CACHE_VERSION,
  CACHE_RELATIVE_PATH,
  MAX_CACHE_BYTES,
  GraphIndexError,
  publicGraphIndexFailure,
  indexProjectGraph,
  loadGraphCache,
  saveGraphCache,
  validateContributionAgainstSnapshot,
};
