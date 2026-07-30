'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const consistencyEngine = require('../src/main/consistency-engine');
const {
  CACHE_VERSION,
  indexProjectGraph,
  loadGraphCache,
} = require('../src/main/graph-index-service');

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

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-graph-index-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'edit.md'), '# 项目规则\n林舟的年龄是32岁。\n');
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n林舟的年龄是32岁。\n');
  fs.writeFileSync(path.join(root, 'chapters', 'two.md'), '# 第二章\n林舟的年龄是35岁。\n');
  return root;
}

function countingAnalyzer(calls) {
  return files => {
    calls.push(files[0].path);
    return consistencyEngine.analyzeProject(files);
  };
}

function graphPath(root) {
  return path.join(root, '.writcraft', 'graph.json');
}

console.log('\nGraph index service verification');

test('builds and persists a unified v2 graph with a revision manifest', () => {
  const root = makeProject();
  try {
    const before = new Map([
      ['edit.md', fs.readFileSync(path.join(root, 'edit.md'), 'utf8')],
      ['chapters/one.md', fs.readFileSync(path.join(root, 'chapters', 'one.md'), 'utf8')],
      ['chapters/two.md', fs.readFileSync(path.join(root, 'chapters', 'two.md'), 'utf8')],
    ]);
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.deepStrictEqual(calls.sort(), ['chapters/one.md', 'chapters/two.md', 'edit.md']);
    assert.strictEqual(result.graph.schema, consistencyEngine.SCHEMA);
    assert(result.graph.nodes.length > 0);
    assert(result.graph.edges.length > 0);
    assert(result.graph.evidence.every(item => !path.isAbsolute(item.path) && !item.path.startsWith('.')));
    assert(result.graph.issues.some(issue =>
      issue.type === 'attribute_conflict' && issue.details.kind === 'project_invariant'
    ));

    const persisted = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    assert.strictEqual(persisted.cacheVersion, CACHE_VERSION);
    assert.strictEqual(persisted.manifest.inputFiles.length, 3);
    assert(persisted.manifest.inputFiles.every(file => /^[a-f0-9]{64}$/.test(file.revision)));
    assert.match(persisted.manifest.contributionsHash, /^[a-f0-9]{64}$/);
    assert.strictEqual(persisted.fileGraphs.length, 3);
    for (const [relative, content] of before) {
      assert.strictEqual(fs.readFileSync(path.join(root, relative), 'utf8'), content);
    }
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.writcraft')).sort(), ['graph.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves compatibility-distinct author filenames as exact Graph evidence paths', () => {
  const root = makeProject();
  const authorPath = 'COPE：共创式组织产品模型》知识体系手册-v1.0.md';
  const compatibilityPeer = authorPath.normalize('NFKC');
  try {
    fs.writeFileSync(path.join(root, authorPath), '# 参考手册\nCOPE支持协作。\n');
    fs.writeFileSync(path.join(root, compatibilityPeer), '# 另一份参考\nCOPE反驳旧结论。\n');
    const result = indexProjectGraph(projectService, root);
    assert.strictEqual(result.status, 'rebuilt');
    assert(result.graph.evidence.some(item => item.path === authorPath && item.filePath === authorPath));
    assert(result.graph.evidence.some(item => item.path === compatibilityPeer && item.filePath === compatibilityPeer));
    assert(result.graph.manifest.inputFiles.some(item => item.path === authorPath));
    assert(result.graph.manifest.inputFiles.some(item => item.path === compatibilityPeer));
    assert.notStrictEqual(
      result.graph.evidence.find(item => item.path === authorPath)?.id,
      result.graph.evidence.find(item => item.path === compatibilityPeer)?.id
    );
    const cached = indexProjectGraph(projectService, root);
    assert.strictEqual(cached.status, 'cache_hit');
    assert(cached.graph.evidence.some(item => item.path === authorPath));
    assert(cached.graph.evidence.some(item => item.path === compatibilityPeer));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishes only bounded path-free Graph failure messages', () => {
  const known = require('../src/main/graph-index-service').publicGraphIndexFailure(
    new (require('../src/main/graph-index-service').GraphIndexError)(
      'CACHE_TOO_LARGE',
      'private path and manuscript fragment must not cross IPC'
    )
  );
  assert.deepStrictEqual(known, {
    ok: false,
    error: 'CACHE_TOO_LARGE',
    message: '图谱分析未完成。正文没有变化，请点击“重新分析”再试',
  });
  const unknown = require('../src/main/graph-index-service').publicGraphIndexFailure(
    new (require('../src/main/graph-index-service').GraphIndexError)('FUTURE_PRIVATE_CODE', '/private/author/project')
  );
  assert.strictEqual(unknown.error, 'GRAPH_INDEX_FAILED');
  assert(!JSON.stringify(unknown).includes('/private/author/project'));
  assert.strictEqual(require('../src/main/graph-index-service').publicGraphIndexFailure(new Error('x')), null);
});

test('returns an unchanged project from cache without analysis or rewrite', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const originalCache = fs.readFileSync(graphPath(root), 'utf8');
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'cache_hit');
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(result.reusedPaths.length, 3);
    assert.strictEqual(fs.readFileSync(graphPath(root), 'utf8'), originalCache);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revision-stable self-consistent evidence tampering reanalyzes only the affected file', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    const contribution = cache.fileGraphs.find(entry => entry.graph.evidence.length > 0);
    const evidence = contribution.graph.evidence[0];
    const originalQuote = evidence.quote;
    evidence.quote = `${originalQuote[0] === '伪' ? '假' : '伪'}${originalQuote.slice(1)}`;
    const mergedEvidence = cache.evidence.find(item => item.id === evidence.id);
    mergedEvidence.quote = evidence.quote;
    cache.manifest.contributionsHash = require('crypto')
      .createHash('sha256').update(JSON.stringify(cache.fileGraphs), 'utf8').digest('hex');
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    assert.strictEqual(loadGraphCache(root).reason, null, 'tamper fixture must remain structurally self-consistent');

    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'incremental');
    assert.strictEqual(result.cacheReason, 'AUTHORITY_SNAPSHOT_MISMATCH');
    assert.deepStrictEqual(calls, [contribution.path]);
    assert.strictEqual(result.reusedPaths.length, 2);
    const restored = result.graph.evidence.find(item => item.id === evidence.id);
    assert(restored);
    assert.strictEqual(restored.quote, originalQuote);
    const snapshot = projectService.readFileWithRevision(root, contribution.path);
    assert.strictEqual(snapshot.content.slice(restored.start, restored.end), restored.quote);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revision-stable self-consistent semantic tampering reanalyzes only the affected file', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    const contribution = cache.fileGraphs.find(entry => entry.graph.nodes.length > 0);
    const node = contribution.graph.nodes[0];
    const originalLabel = node.label;
    node.label = '伪造但结构自洽的节点';
    const mergedNode = cache.nodes.find(item => item.id === node.id);
    mergedNode.label = node.label;
    cache.manifest.contributionsHash = require('crypto')
      .createHash('sha256').update(JSON.stringify(cache.fileGraphs), 'utf8').digest('hex');
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    assert.strictEqual(loadGraphCache(root).reason, null, 'semantic tamper fixture must pass structural cache validation');

    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'incremental');
    assert.strictEqual(result.cacheReason, 'AUTHORITY_SNAPSHOT_MISMATCH');
    assert.deepStrictEqual(calls, [contribution.path]);
    assert.strictEqual(result.reusedPaths.length, 2);
    assert.strictEqual(result.graph.nodes.find(item => item.id === node.id)?.label, originalLabel);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an injected analyzer cannot publish evidence absent from the authoritative snapshot', () => {
  const root = makeProject();
  try {
    const forgedAnalyzer = files => {
      const graph = consistencyEngine.analyzeProject(files);
      const evidence = graph.evidence[0];
      evidence.quote = `${evidence.quote[0] === '伪' ? '假' : '伪'}${evidence.quote.slice(1)}`;
      return graph;
    };
    assert.throws(
      () => indexProjectGraph(projectService, root, { analyzeProject: forgedAnalyzer }),
      error => error?.code === 'EVIDENCE_SNAPSHOT_MISMATCH'
    );
    assert.strictEqual(fs.existsSync(graphPath(root)), false, 'invalid analyzer output must fail before cache persistence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an injected analyzer cannot publish structurally valid fabricated semantics', () => {
  const root = makeProject();
  try {
    const forgedAnalyzer = files => {
      const graph = consistencyEngine.analyzeProject(files);
      graph.nodes[0].label = '伪造语义';
      return graph;
    };
    assert.throws(
      () => indexProjectGraph(projectService, root, { analyzeProject: forgedAnalyzer }),
      error => error?.code === 'ANALYZER_AUTHORITY_MISMATCH'
    );
    assert.strictEqual(fs.existsSync(graphPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reanalyzes only added and modified files and removes deleted contributions', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章修订\n林舟的年龄是33岁。\n');
    fs.unlinkSync(path.join(root, 'chapters', 'two.md'));
    fs.writeFileSync(path.join(root, 'chapters', 'three.md'), '# 第三章\n林舟居住于杭州。\n');
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'incremental');
    assert.deepStrictEqual(calls.sort(), ['chapters/one.md', 'chapters/three.md']);
    assert.deepStrictEqual(result.reusedPaths, ['edit.md']);
    assert.deepStrictEqual(result.removedPaths, ['chapters/two.md']);
    assert(!result.graph.evidence.some(item => item.path === 'chapters/two.md'));
    assert(result.graph.evidence.some(item => item.path === 'chapters/three.md'));
    assert.deepStrictEqual(
      result.graph.manifest.inputFiles.map(file => file.path),
      ['chapters/one.md', 'chapters/three.md', 'edit.md']
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a deletion updates the graph without reanalyzing unchanged files', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    fs.unlinkSync(path.join(root, 'chapters', 'two.md'));
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'incremental');
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(result.removedPaths, ['chapters/two.md']);
    assert(!result.graph.evidence.some(item => item.path === 'chapters/two.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt JSON degrades to a complete rebuild', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    fs.writeFileSync(graphPath(root), '{not json');
    assert.strictEqual(loadGraphCache(root).reason, 'CACHE_CORRUPT');
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.strictEqual(result.cacheReason, 'CACHE_CORRUPT');
    assert.strictEqual(calls.length, 3);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(graphPath(root), 'utf8')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v1 cache schema and version degrade to a complete rebuild', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    cache.schema = 'writcraft.graph/v1';
    cache.cacheVersion = 1;
    for (const entry of cache.fileGraphs) entry.graph.schema = 'writcraft.graph/v1';
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    assert.strictEqual(loadGraphCache(root).reason, 'CACHE_INVALID');
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.strictEqual(result.cacheReason, 'CACHE_INVALID');
    assert.strictEqual(calls.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unknown future node types degrade to entity when reading a v2 cache', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    const contribution = cache.fileGraphs.find(entry => entry.graph.nodes.some(node => node.type === 'section'));
    const futureNode = contribution.graph.nodes.find(node => node.type === 'section');
    futureNode.type = 'future_narrative_object';
    const unified = cache.nodes.find(node => node.id === futureNode.id);
    unified.type = 'future_narrative_object';
    cache.manifest.contributionsHash = require('crypto')
      .createHash('sha256').update(JSON.stringify(cache.fileGraphs), 'utf8').digest('hex');
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    const loaded = loadGraphCache(root);
    assert.strictEqual(loaded.reason, null);
    assert.strictEqual(loaded.cache.nodes.find(node => node.id === futureNode.id).type, 'entity');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe paths inside cache invalidate it before reuse', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    cache.fileGraphs[0].path = '../outside.md';
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.strictEqual(result.cacheReason, 'CACHE_INVALID');
    assert.strictEqual(calls.length, 3);
    assert(!result.graph.evidence.some(item => item.path.includes('..')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseable but tampered graph contributions trigger a complete rebuild', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    cache.fileGraphs[0].graph.nodes[0].label = '被篡改的缓存标签';
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.strictEqual(result.cacheReason, 'CACHE_INVALID');
    assert.strictEqual(calls.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('旧 v2 缓存缺少可验证的 edge evolution 时安全重建', () => {
  const root = makeProject();
  try {
    indexProjectGraph(projectService, root);
    const cache = JSON.parse(fs.readFileSync(graphPath(root), 'utf8'));
    const contribution = cache.fileGraphs.find(entry => entry.graph.edges.length > 0);
    const edgeId = contribution.graph.edges[0].id;
    delete contribution.graph.edges[0].evolution;
    const unified = cache.edges.find(edge => edge.id === edgeId);
    if (unified) delete unified.evolution;
    cache.manifest.contributionsHash = require('crypto')
      .createHash('sha256').update(JSON.stringify(cache.fileGraphs), 'utf8').digest('hex');
    fs.writeFileSync(graphPath(root), JSON.stringify(cache));
    assert.strictEqual(loadGraphCache(root).reason, 'CACHE_INVALID');
    const calls = [];
    const result = indexProjectGraph(projectService, root, { analyzeProject: countingAnalyzer(calls) });
    assert.strictEqual(result.status, 'rebuilt');
    assert.strictEqual(result.cacheReason, 'CACHE_INVALID');
    assert.strictEqual(calls.length, 3);
    assert(result.graph.edges.every(edge => edge.evolution?.evidenceCount === edge.evidenceIds.length));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merged per-file contributions preserve cross-file issue detection', () => {
  const one = projectService.readFileWithRevision;
  const files = {
    'a.md': '林舟的年龄是32岁。',
    'b.md': '林舟的年龄是35岁。',
  };
  const service = {
    listTree() {
      return Object.entries(files).map(([filePath, content]) => ({
        name: filePath, path: filePath, type: 'file', size: Buffer.byteLength(content),
      }));
    },
    readFileWithRevision(_root, filePath) {
      const content = files[filePath];
      return {
        content,
        revision: require('crypto').createHash('sha256').update(content).digest('hex'),
      };
    },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-graph-merge-'));
  try {
    const result = indexProjectGraph(service, root);
    const conflict = result.graph.issues.find(issue => issue.type === 'attribute_conflict');
    assert(conflict);
    assert(conflict.evidenceIds.length >= 2);
    assert.strictEqual(one, projectService.readFileWithRevision);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/${passed} graph-index checks passed.\n`);
