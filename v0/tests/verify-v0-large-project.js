'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const projectSearch = require('../src/main/project-search-service');
const graphIndex = require('../src/main/graph-index-service');
const consistencyEngine = require('../src/main/consistency-engine');
const projectWatcher = require('../src/main/project-watcher');

const GRAPH_COLD_BUDGET_MS = 2500;
const GRAPH_CACHE_BUDGET_MS = 700;
const GRAPH_INCREMENTAL_BUDGET_MS = 800;
const WATCHER_FLUSH_BUDGET_MS = 2500;
const EXPECTED_CHECKS = 6;

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

function flatten(nodes, result = []) {
  for (const node of nodes || []) {
    if (node.type === 'file' && /\.(?:md|markdown)$/i.test(node.path)) result.push(node.path);
    if (node.type === 'directory') flatten(node.children, result);
  }
  return result;
}

function makeLargeProject(fileCount = 300) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-large-project-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, '.writcraft', 'project.json'), JSON.stringify({ schema: 'writcraft.project/v1' }));
  fs.writeFileSync(path.join(root, 'edit.md'), '# 项目主旨\n主角林舟，时间从2026年开始。\n');
  for (let index = 0; index < fileCount; index += 1) {
    const group = `part-${String(Math.floor(index / 50) + 1).padStart(2, '0')}`;
    const directory = path.join(root, 'chapters', group);
    fs.mkdirSync(directory, { recursive: true });
    const serial = String(index + 1).padStart(3, '0');
    const marker = index === fileCount - 1 ? 'WritCraftLargeProjectNeedle' : `普通段落${serial}`;
    fs.writeFileSync(
      path.join(directory, `chapter-${serial}.md`),
      `# 第 ${index + 1} 章\n林舟在第${index + 1}天记录：${marker}。\n`
    );
  }
  return root;
}

console.log('\nLarge project end-to-end verification');

(async () => {
  const root = makeLargeProject();
  try {
    await test('lists a 300-file writing project without truncating public Markdown', () => {
      const files = flatten(projectService.listTree(root));
      assert.strictEqual(files.length, 301);
      assert.strictEqual(files[0], 'chapters/part-01/chapter-001.md');
      assert(files.includes('edit.md'));
    });

    await test('finds an exact body hit across all 300 chapters within search budgets', () => {
      const result = projectSearch.searchProject(projectService, root, 'WritCraftLargeProjectNeedle', { limit: 20 });
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].path, 'chapters/part-06/chapter-300.md');
      assert.strictEqual(result.results[0].target, 'content');
      assert.strictEqual(result.stats.filesDiscovered, 301);
      assert.strictEqual(result.stats.filesScanned, 301);
      assert.strictEqual(result.stats.truncated, false);
    });

    const analyzed = [];
    const analyzer = files => {
      analyzed.push(files[0].path);
      return consistencyEngine.analyzeProject(files);
    };
    await test('builds then fully reuses the 300-file graph cache', () => {
      const coldStarted = performance.now();
      const first = graphIndex.indexProjectGraph(projectService, root, { analyzeProject: analyzer });
      const coldElapsed = performance.now() - coldStarted;
      assert.strictEqual(first.status, 'rebuilt');
      assert.strictEqual(first.analyzedPaths.length, 301);
      assert.strictEqual(analyzed.length, 301);
      assert(coldElapsed <= GRAPH_COLD_BUDGET_MS, `cold graph build ${coldElapsed.toFixed(1)} ms exceeded ${GRAPH_COLD_BUDGET_MS} ms`);
      const cacheStarted = performance.now();
      const second = graphIndex.indexProjectGraph(projectService, root, { analyzeProject: analyzer });
      const cacheElapsed = performance.now() - cacheStarted;
      assert.strictEqual(second.status, 'cache_hit');
      assert.strictEqual(second.analyzedPaths.length, 0);
      assert.strictEqual(second.reusedPaths.length, 301);
      assert.strictEqual(analyzed.length, 301);
      assert(cacheElapsed <= GRAPH_CACHE_BUDGET_MS, `cache hit ${cacheElapsed.toFixed(1)} ms exceeded ${GRAPH_CACHE_BUDGET_MS} ms`);
    });

    await test('reanalyzes exactly one chapter after a single-file edit', () => {
      const relative = 'chapters/part-03/chapter-123.md';
      fs.appendFileSync(path.join(root, relative), '\n林舟的年龄是32岁。\n');
      const before = analyzed.length;
      const incrementalStarted = performance.now();
      const result = graphIndex.indexProjectGraph(projectService, root, { analyzeProject: analyzer });
      const incrementalElapsed = performance.now() - incrementalStarted;
      assert.strictEqual(result.status, 'incremental');
      assert.deepStrictEqual(result.analyzedPaths, [relative]);
      assert.strictEqual(analyzed.length, before + 1);
      assert.strictEqual(result.reusedPaths.length, 300);
      assert(incrementalElapsed <= GRAPH_INCREMENTAL_BUDGET_MS, `incremental rebuild ${incrementalElapsed.toFixed(1)} ms exceeded ${GRAPH_INCREMENTAL_BUDGET_MS} ms`);
    });

    await test('keeps each watcher snapshot round inside the eight-file hash budget', async () => {
      let hashCalls = 0;
      const snapshot = await projectWatcher.projectSnapshot(root, {
        maxHashFiles: 8,
        maxHashBytes: 1024 * 1024,
        hashFile: async absolute => {
          hashCalls += 1;
          return crypto.createHash('sha256').update(await fs.promises.readFile(absolute)).digest('hex').slice(0, 16);
        },
      });
      assert.strictEqual(hashCalls, 8);
      assert.strictEqual(snapshot.stats.hashedFiles, 8);
      assert.strictEqual(snapshot.stats.markdownFiles, 301);
      assert(snapshot.stats.hashedFiles < snapshot.stats.markdownFiles);
      assert(snapshot.entries.get('edit.md').contentHash);
      assert(Number.isInteger(snapshot.nextCursor));
    });

    await test('fully hashes a 300-file project inside the explicit flush budget', async () => {
      const started = performance.now();
      const snapshot = await projectWatcher.projectSnapshot(root, {
        completeHash: true,
      });
      const elapsed = performance.now() - started;
      assert.strictEqual(snapshot.stats.markdownFiles, 301);
      assert.strictEqual(snapshot.stats.hashedFiles, 301);
      assert.strictEqual(snapshot.stats.hashCoverageComplete, true);
      assert(elapsed <= WATCHER_FLUSH_BUDGET_MS,
        `explicit watcher flush ${elapsed.toFixed(1)} ms exceeded ${WATCHER_FLUSH_BUDGET_MS} ms`);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.strictEqual(passed, EXPECTED_CHECKS);
  console.log(`\n${passed}/${EXPECTED_CHECKS} large project checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
