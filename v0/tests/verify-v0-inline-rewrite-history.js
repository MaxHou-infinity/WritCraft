'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const {
  INLINE_REWRITE_PROVENANCE_SCHEMA,
  MAX_PROVENANCE_BYTES,
  applyAndRecord,
  listHistory,
  loadHistory,
  undoChange,
  validateProvenance,
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

function expectInvalid(fn) {
  assert.throws(fn, error => error && error.code === 'INVALID_HISTORY');
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-history-'));
  fs.mkdirSync(path.join(root, '.writcraft'));
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'edit.md'), '---\nschema: writcraft.edit/v1\n---\n');
  fs.writeFileSync(path.join(root, 'chapters/01.md'), 'before selected text after');
  return root;
}

function makeChangeSet(root, after) {
  const snapshot = {
    path: 'chapters/01.md',
    ...projectService.readFileWithRevision(root, 'chapters/01.md'),
  };
  return changeSetService.createChangeSet([snapshot], [{
    path: snapshot.path,
    after,
    summary: '行内改写',
  }]);
}

function provenance(overrides = {}) {
  const targetRevision = crypto.createHash('sha256').update('before selected text after').digest('hex');
  const editRevision = crypto.createHash('sha256').update('---\nschema: writcraft.edit/v1\n---\n').digest('hex');
  return {
    schema: INLINE_REWRITE_PROVENANCE_SCHEMA,
    kind: 'inline_rewrite',
    rewriteId: `ir_${'1'.repeat(32)}`,
    style: 'concise',
    summary: '精简重复表达',
    target: { path: 'chapters/01.md', revision: targetRevision },
    selection: {
      startOffset: 7,
      endOffset: 20,
      blockId: 'block_89abcdef',
      blockFingerprint: '0123abcd',
      quoteDigest: `sha256:${'2'.repeat(64)}`,
    },
    projectPrompt: { path: 'edit.md', revision: editRevision },
    neighbors: [
      {
        role: 'previous', path: 'chapters/01.md', revision: targetRevision,
        offset: 0, endOffset: 3, digest: `sha256:${'3'.repeat(64)}`,
      },
      {
        role: 'before_selection', path: 'chapters/01.md', revision: targetRevision,
        offset: 3, endOffset: 7, digest: `sha256:${'4'.repeat(64)}`,
      },
      {
        role: 'after_selection', path: 'chapters/01.md', revision: targetRevision,
        offset: 20, endOffset: 21, digest: `sha256:${'5'.repeat(64)}`,
      },
      {
        role: 'next', path: 'chapters/01.md', revision: targetRevision,
        offset: 21, endOffset: 26, digest: `sha256:${'6'.repeat(64)}`,
      },
    ],
    expiresAt: 2_000_000_000_000,
    ...overrides,
  };
}

console.log('\nInline Rewrite Change History verification');

test('retains exact Inline Rewrite provenance through integrity, public History, and undo', () => {
  const root = makeProject();
  try {
    const input = provenance();
    const applied = applyAndRecord(projectService, root, makeChangeSet(root, 'before concise text after'), {
      provenance: input,
    });
    input.summary = '调用方事后篡改';
    assert.strictEqual(applied.ok, true);
    assert.strictEqual(applied.historyEntry.provenance.summary, '精简重复表达');
    assert.deepStrictEqual(listHistory(root)[0].provenance, applied.historyEntry.provenance);
    assert(Buffer.byteLength(JSON.stringify(applied.historyEntry.provenance), 'utf8') <= MAX_PROVENANCE_BYTES);

    const undone = undoChange(projectService, root, applied.historyEntry.id);
    assert.strictEqual(undone.ok, true);
    assert.deepStrictEqual(undone.historyEntry.provenance, applied.historyEntry.provenance);
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapters/01.md'), 'utf8'), 'before selected text after');

    const persisted = JSON.parse(fs.readFileSync(path.join(root, '.writcraft/changes.json'), 'utf8'));
    persisted.entries[0].provenance.summary = '完整性篡改';
    fs.writeFileSync(path.join(root, '.writcraft/changes.json'), `${JSON.stringify(persisted, null, 2)}\n`);
    expectInvalid(() => loadHistory(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('accepts only the exact schema, kind, ir_ identity, and style allowlist', () => {
  for (const style of ['general', 'concise', 'vivid', 'academic', 'casual']) {
    assert.strictEqual(validateProvenance(provenance({ style })).style, style);
  }
  for (const mutation of [
    { schema: 'writcraft.inline-rewrite/v2' },
    { kind: 'inline-rewrite' },
    { rewriteId: `irc_${'1'.repeat(32)}` },
    { rewriteId: `ir_${'A'.repeat(32)}` },
    { style: 'formal' },
  ]) expectInvalid(() => validateProvenance(provenance(mutation)));
});

test('rejects capability IDs, manuscript/model text, unknown keys, and unsafe summaries', () => {
  for (const extra of [
    { capabilityId: `irc_${'7'.repeat(32)}` },
    { replacement: '正文' },
    { selectedText: '正文' },
    { prompt: '项目提示词' },
    { modelText: '模型原文' },
  ]) expectInvalid(() => validateProvenance({ ...provenance(), ...extra }));
  for (const summary of ['', ' leading', 'trailing ', 'line\nbreak', 'nul\0byte', '😀'.repeat(241), '汉'.repeat(342)]) {
    expectInvalid(() => validateProvenance(provenance({ summary })));
  }
  const hugePath = `${'a'.repeat(MAX_PROVENANCE_BYTES)}.md`;
  expectInvalid(() => validateProvenance(provenance({
    target: { path: hugePath, revision: 'a'.repeat(64) },
    neighbors: [],
  })));
});

test('validates target, non-empty range, block identity, and every digest', () => {
  const base = provenance();
  const decomposedPath = `chapters/cafe\u0301.md`;
  const mutations = [
    { target: { ...base.target, path: '/absolute.md' } },
    { target: { ...base.target, path: decomposedPath }, neighbors: [] },
    { target: { ...base.target, revision: 'A'.repeat(64) } },
    { selection: { ...base.selection, startOffset: 20 } },
    { selection: { ...base.selection, endOffset: 7 } },
    { selection: { ...base.selection, blockId: 'block_123' } },
    { selection: { ...base.selection, blockFingerprint: 'ABCDEF12' } },
    { selection: { ...base.selection, quoteDigest: '2'.repeat(64) } },
  ];
  for (const mutation of mutations) expectInvalid(() => validateProvenance(provenance(mutation)));
});

test('requires edit.md projectPrompt unless edit.md is the target', () => {
  expectInvalid(() => validateProvenance(provenance({ projectPrompt: null })));
  expectInvalid(() => validateProvenance(provenance({
    projectPrompt: { path: 'other.md', revision: 'a'.repeat(64) },
  })));
  const editTarget = provenance({
    target: { path: 'edit.md', revision: 'a'.repeat(64) },
    projectPrompt: null,
    neighbors: [],
  });
  assert.strictEqual(validateProvenance(editTarget).projectPrompt, null);
  expectInvalid(() => validateProvenance({
    ...editTarget,
    projectPrompt: { path: 'edit.md', revision: 'a'.repeat(64) },
  }));
});

test('enforces at most four fixed-order, non-empty, target-bound neighbors', () => {
  const base = provenance();
  const decomposedPath = `chapters/cafe\u0301.md`;
  assert.strictEqual(validateProvenance(base).neighbors.length, 4);
  const invalidNeighbors = [
    [...base.neighbors, { ...base.neighbors[3] }],
    [base.neighbors[1], base.neighbors[0]],
    [base.neighbors[0], { ...base.neighbors[1], role: 'previous' }],
    [{ ...base.neighbors[0], role: 'unknown' }],
    [{ ...base.neighbors[0], endOffset: base.neighbors[0].offset }],
    [{ ...base.neighbors[0], path: 'chapters/02.md' }],
    [{ ...base.neighbors[0], path: decomposedPath }],
    [{ ...base.neighbors[0], revision: 'a'.repeat(64) }],
    [{ ...base.neighbors[0], digest: '3'.repeat(64) }],
    [base.neighbors[0], { ...base.neighbors[1], offset: 2 }],
  ];
  for (const neighbors of invalidNeighbors) {
    expectInvalid(() => validateProvenance(provenance({ neighbors })));
  }
});

console.log(`\n${passed}/${passed} inline-rewrite History checks passed.\n`);
