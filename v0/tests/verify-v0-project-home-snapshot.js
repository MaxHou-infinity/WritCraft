'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createProjectHomeSnapshotService, LIMITS } = require('../src/main/project-home-snapshot-service');

function revision(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
const files = { 'edit.md': '# Prompt', 'chapters/one.md': '# One\n正文', 'chapters/two.md': '# Two' };
const projectService = {
  listTree: () => Object.entries(files).map(([filePath, content]) => ({ type: 'file', path: filePath, size: Buffer.byteLength(content) })),
  readFileWithRevision: (_root, filePath) => ({ content: files[filePath], revision: revision(files[filePath]) }),
};
let now = 1000;
const service = createProjectHomeSnapshotService({ clock: () => now });
const projectInstanceId = `instance_${'a'.repeat(24)}`;
const captureAuthority = () => ({ projectInstanceId, projectMutationGeneration: 4 });
async function main() {
const inventoryRunner = async request => require('../src/main/workspace-inventory-service').buildWorkspaceInventory({
  projectService, rootPath: request.rootPath, captureAuthority: request.captureAuthority,
});
function homeState(overrides = {}) {
  return {
    authority: { projectMutationGeneration: 4, inventoryGeneration: 0, graphGeneration: 1, sourceGeneration: 2, pendingGeneration: 3 },
    workspace: { activePath: 'chapters/one.md', files: { 'chapters/one.md': { cursorOffset: 3, scrollTop: 9 } } },
    fileTimes: { 'chapters/one.md': 20, 'chapters/two.md': 10 },
    pendingReviews: [{ locationId: 'pr_public', label: '修改', targetPaths: ['chapters/one.md'], fileCount: 1, hunkCount: 2 }],
    openIssues: [
      { id: 'issue_1111111111111111', type: 'prompt_drift', status: 'open', title: '漂移', severity: 'warning' },
      { id: 'issue_2222222222222222', type: 'evidence_gap', status: 'open', title: '待补来源', severity: 'warning' },
      { id: 'issue_3333333333333333', type: 'prompt_drift', status: 'resolved', title: '已解决', severity: 'warning' },
    ],
    source: { status: 'ready', completeness: 'complete', reasonCodes: [] },
    ...overrides,
  };
}
const captured = homeState();
const snapshot = await service.build({
  projectInstanceId, rootPath: '/safe', projectService,
  captureAuthority,
  captureHomeState: () => captured,
  partialReasons: [],
  inventoryRunner,
});
assert.strictEqual(snapshot.schema, 'writcraft.project-home/v1');
assert.strictEqual(snapshot.summary.markdownFileCount, 3);
assert.strictEqual(snapshot.summary.manuscriptFileCount, 2);
assert.strictEqual(snapshot.continueLocation.path, 'chapters/one.md');
assert.deepStrictEqual(snapshot.recentFiles.map(item => item.path), ['chapters/one.md', 'chapters/two.md']);
assert.strictEqual(snapshot.pendingReviews.length, 1);
assert.strictEqual(snapshot.openIssues.length, 1);
assert.strictEqual(snapshot.explicitSourceGaps.length, 1);
assert.strictEqual(snapshot.status, 'ready');

const emptyProjectService = {
  listTree: () => [{ type: 'file', path: 'edit.md', size: 8 }],
  readFileWithRevision: () => ({ content: '# Prompt', revision: revision('# Prompt') }),
};
const emptyProject = await service.build({
  projectInstanceId, rootPath: '/safe', projectService: emptyProjectService,
  captureAuthority, partialReasons: [],
  inventoryRunner: async request => require('../src/main/workspace-inventory-service').buildWorkspaceInventory({
    projectService: emptyProjectService, rootPath: request.rootPath, captureAuthority: request.captureAuthority,
  }),
  captureHomeState: () => homeState({
    workspace: { activePath: 'edit.md', files: { 'edit.md': { caretOffset: 0, scrollTop: 0 } } },
    fileTimes: { 'edit.md': 1 }, pendingReviews: [], openIssues: [],
    source: { status: 'empty', completeness: 'complete', reasonCodes: [] },
  }),
});
assert.strictEqual(emptyProject.summary.manuscriptFileCount, 0);
assert.deepStrictEqual(emptyProject.chapterStates, []);
assert.strictEqual(emptyProject.continueLocation.path, 'edit.md');
assert.strictEqual(emptyProject.status, 'ready');

now += 1;
const tooMany = Array.from({ length: LIMITS.pendingReviews + 1 }, (_, index) => ({
  locationId: `pr_${index}`, label: '修改', targetPaths: ['chapters/one.md'], fileCount: 1, hunkCount: 1,
}));
const partial = await service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [],
  captureHomeState: () => homeState({
    authority: { projectMutationGeneration: 4, inventoryGeneration: 0, graphGeneration: 0, sourceGeneration: 0, pendingGeneration: 0 },
    fileTimes: {}, pendingReviews: tooMany, openIssues: [],
    source: { status: 'unavailable', completeness: 'partial', reasonCodes: ['SOURCE_UNAVAILABLE'] },
  }),
  inventoryRunner,
});
assert.strictEqual(partial.status, 'partial');
assert.strictEqual(partial.pendingReviews.length, LIMITS.pendingReviews);
assert.ok(partial.partialReasons.includes('PENDINGREVIEWS_LIMIT'));
assert.ok(partial.partialReasons.includes('FILE_TIME_UNAVAILABLE'));
assert.ok(partial.partialReasons.includes('SOURCE_UNAVAILABLE'));
assert.strictEqual(partial.sections.sources.dataStatus, 'unavailable');
assert.strictEqual(partial.sections.sources.completeness, 'partial');

const partialSource = await service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({ source: { status: 'partial', completeness: 'partial', reasonCodes: [] } }),
});
assert.strictEqual(partialSource.sections.sources.dataStatus, 'ready');
assert.strictEqual(partialSource.sections.sources.completeness, 'partial');
assert.deepStrictEqual(partialSource.sections.sources.reasonCodes, ['SOURCE_PARTIAL']);
const emptySource = await service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({ source: { status: 'empty', completeness: 'complete', reasonCodes: [] } }),
});
assert.strictEqual(emptySource.sections.sources.dataStatus, 'empty');
await assert.rejects(service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({ source: { status: 'partial', completeness: 'complete', reasonCodes: [] } }),
}), error => error.code === 'INVALID_SNAPSHOT_INPUT');
const manySourceReasons = Array.from({ length: 65 }, (_, index) => `SOURCE_${index}`);
const exactSourceReasons = await service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({
    source: { status: 'partial', completeness: 'partial', reasonCodes: manySourceReasons.slice(0, 64) },
  }),
});
assert.deepStrictEqual(exactSourceReasons.sections.sources.reasonCodes, manySourceReasons.slice(0, 64));
const boundedSourceReasons = await service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({
    source: { status: 'partial', completeness: 'partial', reasonCodes: [...manySourceReasons, 'SOURCE_0'] },
  }),
});
assert.strictEqual(boundedSourceReasons.sections.sources.reasonCodes.length, 64);
assert.strictEqual(boundedSourceReasons.sections.sources.reasonCodes.at(-1), 'SOURCE_REASON_LIMIT');

const largeFiles = Array.from({ length: 1000 }, (_, index) => ({
  path: `chapters/${String(index).padStart(4, '0')}-${'x'.repeat(3000)}.md`,
  revision: 'a'.repeat(64), manuscript: true, wordCount: 1, chapterState: 'body', headings: [], contentLength: 1,
}));
const largeFileTimes = Object.fromEntries(largeFiles.map((file, index) => [file.path, index]));
const bounded = await service.build({
  projectInstanceId, rootPath: '/safe', captureAuthority, partialReasons: [],
  inventoryRunner: async () => ({
    schema: 'writcraft.workspace-inventory/v1', status: 'ready', markdownFileCount: 1000,
    manuscriptFileCount: 1000, manuscriptWordCount: 1000, readBytes: 1000,
    authority: captureAuthority(), files: largeFiles,
  }),
  captureHomeState: () => homeState({ fileTimes: largeFileTimes, pendingReviews: [], openIssues: [] }),
});
assert(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 2 * 1024 * 1024);
assert.strictEqual(bounded.status, 'partial');
assert(bounded.partialReasons.some(reason => reason === 'CHAPTERSTATES_LIMIT' || reason === 'HOME_RESPONSE_LIMIT'));

let derivedGeneration = 1;
await assert.rejects(service.build({
  projectInstanceId, rootPath: '/safe', projectService, captureAuthority, partialReasons: [], inventoryRunner,
  captureHomeState: () => homeState({
    authority: { projectMutationGeneration: 4, inventoryGeneration: 0, graphGeneration: derivedGeneration++, sourceGeneration: 0, pendingGeneration: 0 },
  }),
}), error => error.code === 'PROJECT_CHANGED');

await assert.rejects(service.build({ projectInstanceId: 'bad', rootPath: '/safe', projectService }),
  error => error.code === 'NO_PROJECT');

console.log('verify-v0-project-home-snapshot: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
