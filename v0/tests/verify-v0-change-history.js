'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const {
  HISTORY_SCHEMA,
  LEGACY_HISTORY_SCHEMA,
  PREVIOUS_HISTORY_SCHEMA,
  MAX_HISTORY_BYTES,
  MAX_PROVENANCE_BYTES,
  loadHistory,
  saveHistory,
  listHistory,
  applyAndRecord,
  validateProvenance,
  undoChange,
} = require('../src/main/change-history-service');

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

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

function makeProject(files = { 'a.md': 'old A' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-history-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

function makeChangeSet(root, afterByPath) {
  const snapshots = Object.keys(afterByPath).map(filePath => ({
    path: filePath,
    ...projectService.readFileWithRevision(root, filePath),
  }));
  return changeSetService.createChangeSet(snapshots, snapshots.map(file => ({
    path: file.path,
    after: afterByPath[file.path],
    summary: `更新 ${file.path}`,
  })));
}

function historyPath(root) {
  return path.join(root, '.writcraft', 'changes.json');
}

function hash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function researchProvenance(targetRevision = 'b'.repeat(64)) {
  return {
    schema: 'writcraft.research-handoff/v1',
    kind: 'research_card',
    runId: `rr_${'1'.repeat(24)}`,
    cardId: `rc_${'2'.repeat(32)}`,
    bindingDigest: `sha256:${'3'.repeat(64)}`,
    expiresAt: 1_900_000_000_000,
    evidence: {
      sourceId: `src_${'4'.repeat(20)}`,
      path: 'references/source.md',
      revision: '5'.repeat(64),
      locator: { offset: 8, end: 24, line: 2, column: 1 },
      grade: 'B',
      gradeRule: 'third_party_review',
      quoteDigest: `sha256:${'6'.repeat(64)}`,
      quoteExcerpt: '可公开的短引文',
    },
    targets: [{ path: 'a.md', revision: targetRevision }],
  };
}

console.log('\nChange history service verification');

test('applies a ChangeSet and atomically records complete rollback data', () => {
  const root = makeProject();
  try {
    const result = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'applied');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'new A');
    assert.match(result.historyEntry.id, /^change_/);
    const history = loadHistory(root);
    assert.strictEqual(history.schema, HISTORY_SCHEMA);
    assert.strictEqual(history.entries.length, 1);
    assert.strictEqual(history.entries[0].provenance, null);
    const file = history.entries[0].files[0];
    assert.strictEqual(file.before.content, 'old A');
    assert.strictEqual(file.after.content, 'new A');
    assert.strictEqual(file.before.revision, file.before.contentHash);
    assert.strictEqual(file.after.revision, file.after.contentHash);
    assert(!fs.readdirSync(path.join(root, '.writcraft')).some(name => name.endsWith('.tmp')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listHistory is newest-first and never exposes rollback content', () => {
  const root = makeProject();
  try {
    const first = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }));
    const second = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'newer A' }));
    const listed = listHistory(root);
    assert.deepStrictEqual(listed.map(entry => entry.id), [second.historyEntry.id, first.historyEntry.id]);
    assert.strictEqual(listed[0].files[0].afterHash.length, 64);
    assert(!Object.hasOwn(listed[0].files[0], 'before'));
    assert(!Object.hasOwn(listed[0].files[0], 'after'));
    assert(!JSON.stringify(listed).includes('newer A'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads a valid v1 history, migrates it in memory, and rewrites v3 without losing undo data', () => {
  const root = makeProject();
  try {
    const set = makeChangeSet(root, { 'a.md': 'new A' });
    const appliedAt = new Date().toISOString();
    const record = {
      id: `change_${crypto.randomUUID()}`,
      changeSetId: set.id,
      status: 'applied',
      appliedAt,
      files: [{
        path: 'a.md',
        summary: '旧版历史',
        before: { revision: hash('old A'), contentHash: hash('old A'), content: 'old A' },
        after: { revision: hash('new A'), contentHash: hash('new A'), content: 'new A' },
      }],
    };
    fs.writeFileSync(historyPath(root), `${JSON.stringify({
      schema: LEGACY_HISTORY_SCHEMA,
      updatedAt: appliedAt,
      entries: [{ ...record, integrity: hash(JSON.stringify(record)) }],
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(root, 'a.md'), 'new A');

    const migrated = loadHistory(root);
    assert.strictEqual(migrated.schema, HISTORY_SCHEMA);
    assert.strictEqual(migrated.entries[0].kind, 'application');
    assert.strictEqual(migrated.entries[0].provenance, null);
    assert.strictEqual(migrated.entries[0].files[0].before.content, 'old A');
    saveHistory(root, migrated);
    assert.strictEqual(JSON.parse(fs.readFileSync(historyPath(root), 'utf8')).schema, HISTORY_SCHEMA);
    const undone = undoChange(projectService, root, migrated.entries[0].id);
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads a valid v2 history as v3 with integrity-covered null provenance', () => {
  const root = makeProject();
  try {
    const set = makeChangeSet(root, { 'a.md': 'new A' });
    const appliedAt = new Date().toISOString();
    const record = {
      id: `change_${crypto.randomUUID()}`,
      kind: 'application',
      changeSetId: set.id,
      status: 'applied',
      appliedAt,
      files: [{
        path: 'a.md',
        summary: 'V2 历史',
        before: { revision: hash('old A'), contentHash: hash('old A'), content: 'old A' },
        after: { revision: hash('new A'), contentHash: hash('new A'), content: 'new A' },
      }],
    };
    fs.writeFileSync(historyPath(root), `${JSON.stringify({
      schema: PREVIOUS_HISTORY_SCHEMA,
      updatedAt: appliedAt,
      entries: [{ ...record, integrity: hash(JSON.stringify(record)) }],
    }, null, 2)}\n`);
    const migrated = loadHistory(root);
    assert.strictEqual(migrated.schema, HISTORY_SCHEMA);
    assert.strictEqual(migrated.entries[0].provenance, null);
    saveHistory(root, migrated);
    const persisted = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    assert.strictEqual(persisted.schema, HISTORY_SCHEMA);
    assert(Object.hasOwn(persisted.entries[0], 'provenance'));
    assert.strictEqual(persisted.entries[0].provenance, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strictly clones bounded Research provenance, covers it by integrity, and retains it through undo', () => {
  const root = makeProject();
  try {
    const provenance = researchProvenance(projectService.readFileWithRevision(root, 'a.md').revision);
    const result = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }), { provenance });
    provenance.evidence.quoteExcerpt = '调用方事后篡改';
    assert.strictEqual(result.historyEntry.provenance.evidence.quoteExcerpt, '可公开的短引文');
    const undone = undoChange(projectService, root, result.historyEntry.id);
    assert.strictEqual(undone.ok, true);
    assert.deepStrictEqual(undone.historyEntry.provenance, result.historyEntry.provenance);
    const persisted = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    persisted.entries[0].provenance.evidence.grade = 'D';
    fs.writeFileSync(historyPath(root), `${JSON.stringify(persisted, null, 2)}\n`);
    expectCode('INVALID_HISTORY', () => loadHistory(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects Research provenance smuggling and any provenance above 16 KiB', () => {
  const provenance = researchProvenance();
  expectCode('INVALID_HISTORY', () => validateProvenance({ ...provenance, question: '不得进入历史' }));
  expectCode('INVALID_HISTORY', () => validateProvenance({
    ...provenance,
    evidence: { ...provenance.evidence, quoteExcerpt: 'x'.repeat(241) },
  }));
  expectCode('INVALID_HISTORY', () => validateProvenance({ blob: 'x'.repeat(MAX_PROVENANCE_BYTES) }));
  const generic = { kind: 'plan_task', targets: [{ path: 'a.md', revision: '7'.repeat(64) }] };
  const genericClone = validateProvenance(generic);
  generic.targets[0].path = 'mutated.md';
  assert.strictEqual(genericClone.targets[0].path, 'a.md');
  const accessor = {};
  Object.defineProperty(accessor, 'secret', { enumerable: true, get() { return 'not plain JSON'; } });
  expectCode('INVALID_HISTORY', () => validateProvenance(accessor));
});

test('undo restores all files and marks the history record undone', () => {
  const root = makeProject({ 'a.md': 'old A', 'chapters/b.md': 'old B' });
  try {
    const applied = applyAndRecord(projectService, root, makeChangeSet(root, {
      'a.md': 'new A', 'chapters/b.md': 'new B',
    }));
    const undone = undoChange(projectService, root, applied.historyEntry.id);
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(undone.status, 'undone');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapters/b.md'), 'utf8'), 'old B');
    assert.strictEqual(loadHistory(root).entries[0].status, 'undone');
    assert(loadHistory(root).entries[0].files.every(file => /^[a-f0-9]{64}$/.test(file.undoRevision)));
    expectCode('HISTORY_ALREADY_UNDONE', () => undoChange(projectService, root, applied.historyEntry.id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('undo performs full revision preflight and never overwrites an external edit', () => {
  const root = makeProject({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    const applied = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A', 'b.md': 'new B' }));
    const currentB = projectService.readFileWithRevision(root, 'b.md');
    projectService.atomicWriteFile(root, 'b.md', 'external B', currentB.revision);
    const result = undoChange(projectService, root, applied.historyEntry.id);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'conflict');
    assert.strictEqual(result.path, 'b.md');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'new A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'external B');
    assert.strictEqual(loadHistory(root).entries[0].status, 'applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mid-undo write failure rolls earlier files back to the applied state', () => {
  const root = makeProject({ 'a.md': 'old A', 'b.md': 'old B' });
  try {
    const applied = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A', 'b.md': 'new B' }));
    const failingService = {
      ...projectService,
      atomicWriteFile(rootPath, filePath, content, expectedRevision) {
        if (filePath === 'b.md' && content === 'old B') {
          throw Object.assign(new Error('simulated second-file failure'), { code: 'DISK_FAILURE' });
        }
        return projectService.atomicWriteFile(rootPath, filePath, content, expectedRevision);
      },
    };
    const result = undoChange(failingService, root, applied.historyEntry.id);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'rolled_back');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'new A');
    assert.strictEqual(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'new B');
    assert.strictEqual(loadHistory(root).entries[0].status, 'applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history commit failure after apply rolls正文 back and leaves no false audit', () => {
  const root = makeProject();
  try {
    const result = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }), {
      saveHistory() { throw new Error('simulated history disk failure'); },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'history_failed_rolled_back');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(fs.existsSync(historyPath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history commit failure after undo restores applied content and audit agreement', () => {
  const root = makeProject();
  try {
    const applied = applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }));
    const result = undoChange(projectService, root, applied.historyEntry.id, {
      saveHistory() { throw new Error('simulated history disk failure'); },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'history_failed_rolled_back');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'new A');
    assert.strictEqual(loadHistory(root).entries[0].status, 'applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlink history is rejected before apply and its target is untouched', () => {
  const root = makeProject();
  const outside = path.join(os.tmpdir(), `writcraft-history-outside-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(outside, 'external sentinel');
    fs.symlinkSync(outside, historyPath(root));
    const changeSet = makeChangeSet(root, { 'a.md': 'new A' });
    expectCode('UNSAFE_HISTORY_PATH', () => applyAndRecord(projectService, root, changeSet));
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'external sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch (_) {}
  }
});

test('corrupt or oversized history fails closed before manuscript writes', () => {
  const root = makeProject();
  try {
    const changeSet = makeChangeSet(root, { 'a.md': 'new A' });
    fs.writeFileSync(historyPath(root), '{broken');
    expectCode('HISTORY_CORRUPT', () => applyAndRecord(projectService, root, changeSet));
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
    fs.truncateSync(historyPath(root), MAX_HISTORY_BYTES + 1);
    expectCode('HISTORY_TOO_LARGE', () => applyAndRecord(projectService, root, changeSet));
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Main IPC and preload bind list/undo to the current project without renderer paths', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  const handler = fs.readFileSync(path.join(__dirname, '../src/main/changes-history-handler.js'), 'utf8');
  assert(main.includes("require('./change-history-service')"));
  const listStart = main.indexOf("ipcMain.handle('writcraft:project:list-change-history'");
  const undoStart = main.indexOf("ipcMain.handle('writcraft:project:undo-change'");
  assert(listStart >= 0 && undoStart >= 0);
  const listRoute = main.slice(listStart, undoStart);
  const undoRoute = main.slice(undoStart, main.indexOf('\nipcMain.handle(', undoStart + 20));
  assert(listRoute.includes('assertTrustedSender(event)'));
  assert(listRoute.includes('requireCurrentProject()'));
  assert(listRoute.includes('project.rootPath'));
  assert(undoRoute.includes('assertTrustedSender(event)'));
  assert(undoRoute.includes('changesHistoryHandler.undoChange(projectInstanceId, historyEntryId)'));
  assert(handler.includes('const project = current(projectInstanceId)'));
  assert(handler.includes('assertMutationAvailable(project)'));
  assert(handler.includes('transaction.undo({'));
  assert(preload.includes("listChangeHistory: () => ipcRenderer.invoke('writcraft:project:list-change-history')"));
  assert(preload.includes("ipcRenderer.invoke('writcraft:project:undo-change', projectInstanceId, historyEntryId)"));
  assert(!preload.includes('undoChange: (rootPath'));
});

console.log(`\n${passed}/${passed} change-history checks passed.\n`);
