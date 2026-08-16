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
  TERMINAL_HISTORY_STATE_SCHEMA,
  LEGACY_HISTORY_SCHEMA,
  PREVIOUS_HISTORY_SCHEMA,
  PREVIOUS_V3_HISTORY_SCHEMA,
  MAX_HISTORY_BYTES,
  MAX_PROVENANCE_BYTES,
  SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
  validateHistory,
  digestHistoryState,
  loadHistory,
  saveHistory,
  listHistory,
  applyAndRecord,
  prepareSnapshotRestoreHistory,
  prepareSnapshotRestoreHistoryTemplate,
  materializeSnapshotRestoreHistoryTemplate,
  prepareSnapshotRestoreUndoHistory,
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

function identityDigest(character = '4') {
  return `sha256:${character.repeat(64)}`;
}

function snapshotState(content) {
  const bytes = Buffer.from(content, 'utf8');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    exists: true,
    revision: digest,
    contentHash: digest,
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

function absentSnapshotState() {
  return {
    exists: false,
    revision: null,
    contentHash: null,
    byteLength: 0,
    encoding: null,
    data: null,
  };
}

function snapshotProvenance(selectedIds) {
  return {
    schema: SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    snapshotId: 'snapshot_history_a',
    snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
    restoreCapabilityId: 'capability_history_a',
    comparisonDigest: `sha256:${'2'.repeat(64)}`,
    selectedIds,
  };
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

test('current production History schema is writcraft.changes/v4', () => {
  assert.strictEqual(HISTORY_SCHEMA, 'writcraft.changes/v4');
  assert.strictEqual(
    TERMINAL_HISTORY_STATE_SCHEMA,
    'writcraft.changes-history-terminal-history-state/v1'
  );
  assert.strictEqual(MAX_HISTORY_BYTES, 192 * 1024 * 1024);
});

test('terminal History state digest has a frozen domain golden and binds existence', () => {
  const absent = { exists: false, history: { schema: HISTORY_SCHEMA, entries: [] } };
  const present = { exists: true, history: { schema: HISTORY_SCHEMA, entries: [] } };
  assert.strictEqual(
    digestHistoryState(absent),
    'sha256:ec524d62da0428ab8534979ac7a024003c48f06ea7d9b9e6315f51d08a14718a'
  );
  assert.notStrictEqual(digestHistoryState(absent), digestHistoryState(present));
});

test('terminal History digest descriptor-validates state and binds validated entry truth', () => {
  let getterCalls = 0;
  const accessor = { history: { schema: HISTORY_SCHEMA, entries: [] } };
  Object.defineProperty(accessor, 'exists', {
    enumerable: true,
    get() { getterCalls += 1; return false; },
  });
  expectCode('INVALID_HISTORY', () => digestHistoryState(accessor));
  assert.strictEqual(getterCalls, 0);
  expectCode('INVALID_HISTORY', () => digestHistoryState({
    exists: false,
    history: { schema: HISTORY_SCHEMA, entries: [] },
    extra: true,
  }));

  const root = makeProject();
  try {
    const emptyDigest = digestHistoryState({ exists: false, history: { schema: HISTORY_SCHEMA, entries: [] } });
    applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'new A' }));
    const entryDigest = digestHistoryState({ exists: true, history: loadHistory(root) });
    assert.notStrictEqual(entryDigest, emptyDigest);
    applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'newer A' }));
    const driftedEntryDigest = digestHistoryState({ exists: true, history: loadHistory(root) });
    assert.notStrictEqual(driftedEntryDigest, entryDigest);
    expectCode('INVALID_HISTORY', () => digestHistoryState({
      exists: false,
      history: loadHistory(root),
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary v4 utf8 History preserves newline and tab while rejecting unpaired surrogate before writes', () => {
  const exact = makeProject({ 'a.md': 'old\n\tline\n' });
  try {
    const result = applyAndRecord(
      projectService,
      exact,
      makeChangeSet(exact, { 'a.md': 'new\n\tline\n' })
    );
    assert.strictEqual(result.ok, true);
    const persisted = JSON.parse(fs.readFileSync(historyPath(exact), 'utf8'));
    assert.strictEqual(persisted.entries[0].files[0].before.data, 'old\n\tline\n');
    assert.strictEqual(persisted.entries[0].files[0].after.data, 'new\n\tline\n');
  } finally {
    fs.rmSync(exact, { recursive: true, force: true });
  }

  const hostile = makeProject({ 'a.md': 'old A' });
  try {
    const changeSet = makeChangeSet(hostile, { 'a.md': `hostile \ud800` });
    expectCode('INVALID_HISTORY', () => applyAndRecord(projectService, hostile, changeSet));
    assert.strictEqual(fs.readFileSync(path.join(hostile, 'a.md'), 'utf8'), 'old A');
    assert.strictEqual(fs.existsSync(historyPath(hostile)), false);
  } finally {
    fs.rmSync(hostile, { recursive: true, force: true });
  }
});

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
    assert.strictEqual(file.createdIdentityDigest, null);
    assert.strictEqual(file.ancestorIdentityDigest, null);
    assert.strictEqual(file.before.encoding, 'utf8');
    assert.strictEqual(file.before.data, 'old A');
    assert.strictEqual(file.after.data, 'new A');
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

test('loads a valid v1 history, migrates it in memory, and rewrites v4 without losing undo data', () => {
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
    assert.strictEqual(migrated.entries[0].files[0].before.data, 'old A');
    assert.strictEqual(migrated.entries[0].files[0].ancestorIdentityDigest, null);
    saveHistory(root, migrated);
    assert.strictEqual(JSON.parse(fs.readFileSync(historyPath(root), 'utf8')).schema, HISTORY_SCHEMA);
    const undone = undoChange(projectService, root, migrated.entries[0].id);
    assert.strictEqual(undone.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'old A');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads a valid v2 history as v4 with integrity-covered null provenance', () => {
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
    assert.strictEqual(migrated.entries[0].files[0].ancestorIdentityDigest, null);
    saveHistory(root, migrated);
    const persisted = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    assert.strictEqual(persisted.schema, HISTORY_SCHEMA);
    assert(Object.hasOwn(persisted.entries[0], 'provenance'));
    assert.strictEqual(persisted.entries[0].provenance, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads a valid v3 history deterministically as exact v4 utf8 state', () => {
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
        summary: 'V3 历史',
        before: { revision: hash('old A'), contentHash: hash('old A'), content: 'old A' },
        after: { revision: hash('new A'), contentHash: hash('new A'), content: 'new A' },
      }],
      provenance: null,
    };
    fs.writeFileSync(historyPath(root), `${JSON.stringify({
      schema: PREVIOUS_V3_HISTORY_SCHEMA,
      updatedAt: appliedAt,
      entries: [{ ...record, integrity: hash(JSON.stringify(record)) }],
    }, null, 2)}\n`);
    const migrated = loadHistory(root);
    assert.strictEqual(migrated.schema, HISTORY_SCHEMA);
    assert.deepStrictEqual(Object.keys(migrated).sort(), ['entries', 'schema']);
    assert.deepStrictEqual(Object.keys(migrated.entries[0].files[0]).sort(), [
      'after', 'ancestorIdentityDigest', 'before', 'createdIdentityDigest', 'path', 'summary',
    ]);
    assert.strictEqual(migrated.entries[0].files[0].before.encoding, 'utf8');
    assert.strictEqual(migrated.entries[0].files[0].before.data, 'old A');
    assert.strictEqual(migrated.entries[0].files[0].ancestorIdentityDigest, null);
    saveHistory(root, migrated);
    const persisted = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    assert.deepStrictEqual(Object.keys(persisted).sort(), ['entries', 'schema']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads pre-ancestor ordinary v4 only after old integrity verifies and rewrites exact null authority', () => {
  const root = makeProject({ 'a.md': 'old\n\tA' });
  try {
    const result = applyAndRecord(
      projectService,
      root,
      makeChangeSet(root, { 'a.md': 'new\n\tA' })
    );
    const persisted = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    const legacyEntry = persisted.entries[0];
    delete legacyEntry.files[0].ancestorIdentityDigest;
    const { integrity: _integrity, ...legacyPayload } = legacyEntry;
    legacyEntry.integrity = hash(JSON.stringify(legacyPayload));
    fs.writeFileSync(historyPath(root), JSON.stringify(persisted));

    const migrated = loadHistory(root);
    assert.strictEqual(migrated.entries[0].files[0].ancestorIdentityDigest, null);
    assert.strictEqual(migrated.entries[0].files[0].before.data, 'old\n\tA');
    assert.notStrictEqual(migrated.entries[0].integrity, legacyEntry.integrity);
    saveHistory(root, migrated);
    const rewritten = JSON.parse(fs.readFileSync(historyPath(root), 'utf8'));
    assert.strictEqual(rewritten.entries[0].files[0].ancestorIdentityDigest, null);
    assert.deepStrictEqual(Object.keys(rewritten.entries[0].files[0]).sort(), [
      'after', 'ancestorIdentityDigest', 'before', 'createdIdentityDigest', 'path', 'summary',
    ]);

    const tampered = JSON.parse(JSON.stringify(persisted));
    tampered.entries[0].files[0].summary = 'tampered';
    fs.writeFileSync(historyPath(root), JSON.stringify(tampered));
    expectCode('INVALID_HISTORY', () => loadHistory(root));
    assert.strictEqual(result.ok, true);
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

test('prepares, saves, and reloads exact snapshot-restore base64 History alongside ordinary entries', () => {
  const root = makeProject({ 'a.md': 'current A' });
  try {
    applyAndRecord(projectService, root, makeChangeSet(root, { 'a.md': 'ordinary A' }));
    const files = [{
      path: 'a.md',
      summary: '恢复已有章节',
      before: snapshotState('ordinary A'),
      after: snapshotState('{"raw":true}\n'),
      createdIdentityDigest: null,
      ancestorIdentityDigest: identityDigest('4'),
    }, {
      path: 'chapters/restored.md',
      summary: '恢复缺失章节',
      before: absentSnapshotState(),
      after: snapshotState('restored chapter\n'),
      createdIdentityDigest: `sha256:${'3'.repeat(64)}`,
      ancestorIdentityDigest: identityDigest('5'),
    }];
    const prepared = prepareSnapshotRestoreHistory(
      root,
      files,
      snapshotProvenance(['selected_a', 'selected_b'])
    );
    assert.strictEqual(prepared.kind, 'snapshot_restore');
    assert.strictEqual(prepared.preparedHistoryState.history.entries.length, 2);
    saveHistory(root, prepared.preparedHistoryState.history, {
      expectedState: prepared.baseHistoryState,
    });
    const loaded = loadHistory(root);
    assert.strictEqual(loaded.entries.length, 2);
    const entry = loaded.entries[1];
    assert.strictEqual(entry.provenance.schema, SNAPSHOT_RESTORE_PROVENANCE_SCHEMA);
    assert.deepStrictEqual(Object.keys(entry).sort(), [
      'appliedAt', 'changeSetId', 'files', 'id', 'integrity', 'kind',
      'provenance', 'status',
    ]);
    assert.deepStrictEqual(Object.keys(entry.files[0]).sort(), [
      'after', 'ancestorIdentityDigest', 'before', 'createdIdentityDigest', 'path', 'summary',
    ]);
    assert.strictEqual(entry.files[0].before.encoding, 'base64');
    assert.strictEqual(entry.files[0].after.data, snapshotState('{"raw":true}\n').data);
    assert.strictEqual(Buffer.from(entry.files[0].after.data, 'base64').toString('utf8'), '{"raw":true}\n');
    assert.strictEqual(entry.files[0].ancestorIdentityDigest, identityDigest('4'));
    assert.strictEqual(entry.files[1].ancestorIdentityDigest, identityDigest('5'));
    assert.strictEqual(entry.files[1].before.exists, false);
    assert.match(entry.files[1].createdIdentityDigest, /^sha256:[a-f0-9]{64}$/);
    assert(!JSON.stringify(listHistory(root)).includes('snapshot A'));
    expectCode('SNAPSHOT_RESTORE_UNDO_REQUIRED', () =>
      undoChange(projectService, root, entry.id));
    const undoPrepared = prepareSnapshotRestoreUndoHistory(root, entry.id, {
      undoneAt: '2026-08-06T08:00:00.000Z',
    });
    saveHistory(root, undoPrepared.preparedHistoryState.history, {
      expectedState: undoPrepared.baseHistoryState,
    });
    const undone = loadHistory(root).entries[1];
    assert.strictEqual(undone.status, 'undone');
    assert.strictEqual(undone.undoneAt, '2026-08-06T08:00:00.000Z');
    assert.strictEqual(undone.provenance.schema, SNAPSHOT_RESTORE_PROVENANCE_SCHEMA);
    assert.strictEqual(undone.files[1].createdIdentityDigest, entry.files[1].createdIdentityDigest);
    assert.strictEqual(undone.files[0].ancestorIdentityDigest, identityDigest('4'));
    assert.strictEqual(undone.files[1].ancestorIdentityDigest, identityDigest('5'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot-restore History rejects malformed raw bytes, smuggling, identity gaps, and over-300 files', () => {
  const root = makeProject();
  try {
    const valid = {
      path: 'a.md', summary: '恢复',
      before: snapshotState('old A'), after: snapshotState('new A'),
      createdIdentityDigest: null,
      ancestorIdentityDigest: identityDigest('7'),
    };
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(root, [{
      ...valid,
      after: { ...valid.after, encoding: 'utf8', data: 'new A' },
    }], snapshotProvenance(['selected_a'])));
    const invalidUtf8 = Buffer.from([0xff]);
    const invalidUtf8Hash = crypto.createHash('sha256').update(invalidUtf8).digest('hex');
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(root, [{
      ...valid,
      after: {
        ...valid.after,
        revision: invalidUtf8Hash,
        contentHash: invalidUtf8Hash,
        byteLength: 1,
        data: invalidUtf8.toString('base64'),
      },
    }], snapshotProvenance(['selected_a'])));
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(root, [{
      ...valid, absolutePath: '/private/manuscript/a.md',
    }], snapshotProvenance(['selected_a'])));
    const { ancestorIdentityDigest: _ancestorIdentityDigest, ...missingAncestor } = valid;
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(
      root,
      [missingAncestor],
      snapshotProvenance(['selected_a'])
    ));
    let ancestorGetterReads = 0;
    const getterAncestor = { ...valid };
    Object.defineProperty(getterAncestor, 'ancestorIdentityDigest', {
      enumerable: true,
      get() {
        ancestorGetterReads += 1;
        return identityDigest('8');
      },
    });
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(
      root,
      [getterAncestor],
      snapshotProvenance(['selected_a'])
    ));
    assert.strictEqual(ancestorGetterReads, 0);
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(root, [{
      ...valid,
      path: 'missing.md', before: absentSnapshotState(), createdIdentityDigest: null,
    }], snapshotProvenance(['selected_a'])));
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(
      root,
      [valid],
      snapshotProvenance(['selected_a', 'selected_b'])
    ));
    const tooMany = Array.from({ length: 301 }, (_, index) => ({
      ...valid,
      path: `chapters/${String(index).padStart(3, '0')}.md`,
    }));
    const maximumCount = tooMany.slice(0, 300);
    assert.strictEqual(prepareSnapshotRestoreHistory(
      root,
      maximumCount,
      snapshotProvenance(maximumCount.map((_, index) => `selected_${index}`))
    ).record.files.length, 300);
    const maximumSurface = {
      ...valid,
      path: `${'😀'.repeat(1021)}.md`,
      summary: '😀'.repeat(1024),
    };
    assert.strictEqual(prepareSnapshotRestoreHistory(
      root,
      [maximumSurface],
      snapshotProvenance(['selected_surface'])
    ).record.files[0].summary, maximumSurface.summary);
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(
      root,
      tooMany,
      snapshotProvenance(tooMany.map((_, index) => `selected_${index}`))
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot template materialization and restart preserve sealed ancestor authority through undo', () => {
  const root = makeProject({ 'a.md': 'current A' });
  try {
    const files = [{
      path: 'a.md',
      summary: 'restore existing',
      before: snapshotState('current A'),
      after: snapshotState('snapshot A'),
      createdIdentityDigest: null,
      ancestorIdentityDigest: identityDigest('9'),
    }, {
      path: 'chapters/new.md',
      summary: 'restore missing',
      before: absentSnapshotState(),
      after: snapshotState('snapshot new\n'),
      createdIdentityDigest: null,
      ancestorIdentityDigest: identityDigest('a'),
    }];
    const prepared = prepareSnapshotRestoreHistoryTemplate(
      root,
      files,
      snapshotProvenance(['selected_existing', 'selected_missing']),
      { appliedAt: '2026-08-06T08:00:00.000Z' }
    );
    files[0].ancestorIdentityDigest = identityDigest('f');
    assert.strictEqual(prepared.historyTemplate.files[0].ancestorIdentityDigest, identityDigest('9'));
    assert.strictEqual(prepared.historyTemplate.files[1].ancestorIdentityDigest, identityDigest('a'));

    const materialized = materializeSnapshotRestoreHistoryTemplate(
      prepared.baseHistoryState,
      prepared.historyTemplate,
      [{ path: 'chapters/new.md', createdIdentityDigest: identityDigest('b') }]
    );
    assert.strictEqual(materialized.record.files[0].ancestorIdentityDigest, identityDigest('9'));
    assert.strictEqual(materialized.record.files[1].ancestorIdentityDigest, identityDigest('a'));
    assert.strictEqual(materialized.record.files[1].createdIdentityDigest, identityDigest('b'));
    saveHistory(root, materialized.preparedHistoryState.history, {
      expectedState: materialized.baseHistoryState,
    });
    const restarted = loadHistory(root);
    assert.strictEqual(restarted.entries[0].files[0].ancestorIdentityDigest, identityDigest('9'));
    assert.strictEqual(restarted.entries[0].files[1].ancestorIdentityDigest, identityDigest('a'));
    const undone = prepareSnapshotRestoreUndoHistory(root, restarted.entries[0].id, {
      undoneAt: '2026-08-06T08:01:00.000Z',
    });
    assert.strictEqual(undone.record.files[0].ancestorIdentityDigest, identityDigest('9'));
    assert.strictEqual(undone.record.files[1].ancestorIdentityDigest, identityDigest('a'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v4 full-document gate is exact and FIFO retains the new snapshot record at 100 entries', () => {
  const root = makeProject();
  try {
    let firstId;
    for (let index = 0; index < 100; index += 1) {
      const result = applyAndRecord(projectService, root, makeChangeSet(root, {
        'a.md': `revision ${index}`,
      }));
      if (index === 0) firstId = result.historyEntry.id;
    }
    const valid = {
      path: 'a.md', summary: 'FIFO snapshot restore',
      before: snapshotState('revision 99'), after: snapshotState('snapshot final'),
      createdIdentityDigest: null,
      ancestorIdentityDigest: identityDigest('8'),
    };
    const prepared = prepareSnapshotRestoreHistory(
      root,
      [valid],
      snapshotProvenance(['selected_final'])
    );
    const history = prepared.preparedHistoryState.history;
    assert.strictEqual(history.entries.length, 100);
    assert(!history.entries.some(entry => entry.id === firstId));
    assert.strictEqual(history.entries[99].provenance.schema, SNAPSHOT_RESTORE_PROVENANCE_SCHEMA);
    expectCode('INVALID_HISTORY', () => saveHistory(root, {
      ...history,
      updatedAt: new Date().toISOString(),
    }));
    expectCode('INVALID_HISTORY', () => saveHistory(root, {
      schema: HISTORY_SCHEMA,
      entries: [...history.entries, history.entries[0]],
    }));
    expectCode('INVALID_HISTORY', () => prepareSnapshotRestoreHistory(
      root,
      [{
        path: 'a.md', summary: 'bad\nsummary',
        before: snapshotState('revision 99'), after: snapshotState('snapshot final'),
        createdIdentityDigest: null,
        ancestorIdentityDigest: identityDigest('8'),
      }],
      snapshotProvenance(['selected_bad_summary'])
    ));
    const ordinarySnapshot = projectService.readFileWithRevision(root, 'a.md');
    const ordinary = changeSetService.createChangeSet(
      [{ path: 'a.md', ...ordinarySnapshot }],
      [{ path: 'a.md', after: 'ordinary newline summary target', summary: 'bad\nsummary' }]
    );
    expectCode('INVALID_HISTORY', () => applyAndRecord(projectService, root, ordinary));
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
    assert(listHistory(root)[0].files.every(file => /^[a-f0-9]{64}$/.test(file.undoRevision)));
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
