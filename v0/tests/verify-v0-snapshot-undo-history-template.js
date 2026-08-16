#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const historyService = require('../src/main/change-history-service');
const recoveryArtifact = require('../src/main/changes-history-recovery-artifact');
const evidenceSchema = require('../src/main/evidence-delivery-schema');

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

function expectHistoryFailure(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_HISTORY');
}

function present(text) {
  const bytes = Buffer.from(text, 'utf8');
  const revision = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    exists: true,
    revision,
    contentHash: revision,
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

function absent() {
  return {
    exists: false,
    revision: null,
    contentHash: null,
    byteLength: 0,
    encoding: null,
    data: null,
  };
}

function provenance(count) {
  return {
    schema: historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA,
    snapshotId: 'snapshot_undo_template',
    snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
    restoreCapabilityId: 'capability_undo_template',
    comparisonDigest: `sha256:${'2'.repeat(64)}`,
    selectedIds: Array.from({ length: count }, (_, index) => `selected_${index}`),
  };
}

function makeApplied(count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-undo-template-'));
  fs.mkdirSync(path.join(root, '.writcraft', 'recovery'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, '.writcraft', 'recovery'), 0o700);
  const files = Array.from({ length: count }, (_, index) => ({
    path: `chapters/${String(index).padStart(3, '0')}.md`,
    summary: `恢复章节 ${index}`,
    before: absent(),
    after: present(`snapshot ${index}\n`),
    createdIdentityDigest: `sha256:${String((index % 9) + 1).repeat(64)}`,
    ancestorIdentityDigest: `sha256:${String(((index + 3) % 9) + 1).repeat(64)}`,
  }));
  const prepared = historyService.prepareSnapshotRestoreHistory(
    root,
    files,
    provenance(count),
    {
      id: 'change_11111111-1111-4111-8111-111111111111',
      changeSetId: `cs_${'a'.repeat(24)}`,
      appliedAt: '2026-08-09T01:02:03.000Z',
    }
  );
  historyService.saveHistory(root, prepared.preparedHistoryState.history, {
    expectedState: prepared.baseHistoryState,
  });
  return {
    root,
    files,
    entryId: prepared.record.id,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function nativeArtifactFiles(files) {
  return files.map(file => ({
    path: file.path,
    before: file.after,
    after: file.before,
    createdIdentityDigest: file.createdIdentityDigest,
  }));
}

const noMutationLifecycle = Object.freeze({
  cleanup() { throw new Error('cleanup out of scope'); },
  rollback() { throw new Error('rollback out of scope'); },
});

test('undo template canonical bytes and 3.1.4 digest match independent frozen goldens', () => {
  const item = makeApplied();
  try {
    const prepared = historyService.prepareSnapshotRestoreUndoHistory(
      item.root,
      item.entryId,
      { undoneAt: '2026-08-09T01:03:04.000Z' }
    );
    const canonical = evidenceSchema.canonicalJson(prepared.historyTemplate);
    const digest = evidenceSchema.digestObject(
      historyService.SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA,
      prepared.historyTemplate
    );
    assert.strictEqual(canonical, '{"appliedAt":"2026-08-09T01:02:03.000Z","baseHistoryState":{"digest":"7fd56322bdd0147909795cadd65efa53d59745007f01a617e7da527df21c3e6d","exists":true},"changeSetId":"cs_aaaaaaaaaaaaaaaaaaaaaaaa","files":[{"after":{"byteLength":11,"contentHash":"c13de15b7fd4b28e2529bb26209e834cc682a1f7e2f1058c781f9c0f1f17ce35","data":"c25hcHNob3QgMAo=","encoding":"base64","exists":true,"revision":"c13de15b7fd4b28e2529bb26209e834cc682a1f7e2f1058c781f9c0f1f17ce35"},"ancestorIdentityDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444","before":{"byteLength":0,"contentHash":null,"data":null,"encoding":null,"exists":false,"revision":null},"createdIdentityDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","path":"chapters/000.md","summary":"恢复章节 0"}],"id":"change_11111111-1111-4111-8111-111111111111","provenance":{"comparisonDigest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","restoreCapabilityId":"capability_undo_template","schema":"writcraft.snapshot-restore-history/v1","selectedIds":["selected_0"],"snapshotId":"snapshot_undo_template","snapshotManifestDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},"schema":"writcraft.snapshot-restore-undo-history-template/v1","status":"undone","undoneAt":"2026-08-09T01:03:04.000Z"}');
    assert.strictEqual(
      digest,
      'sha256:153dd38561f6e383dcea3e5e74f666c17f493b030f844c979c3ebf261f25d6d4'
    );
  } finally { item.cleanup(); }
});

test('artifact v2 distinguishes undo template and restart materializes exact prepared bytes', () => {
  const item = makeApplied();
  try {
    const rawBase = fs.readFileSync(path.join(item.root, '.writcraft', 'changes.json'));
    const prepared = historyService.prepareSnapshotRestoreUndoHistory(
      item.root,
      item.entryId,
      { undoneAt: '2026-08-09T01:03:04.000Z' }
    );
    const binding = recoveryArtifact.writeSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      `chr_${'b'.repeat(48)}`,
      nativeArtifactFiles(item.files),
      prepared.baseHistoryState,
      prepared.preparedHistoryState,
      historyService,
      noMutationLifecycle,
      prepared.historyTemplate
    );
    assert.strictEqual(binding.schema, 'writcraft.changes-history-recovery-artifact/v2');
    assert.strictEqual(binding.historyTemplateDigest, prepared.historyTemplateDigest.slice(7));
    const inspected = recoveryArtifact.inspectSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      binding,
      () => {},
      { includeHistory: true, historyService }
    );
    assert.strictEqual(
      inspected.preparedDelta.templateSchema,
      historyService.SNAPSHOT_RESTORE_UNDO_HISTORY_TEMPLATE_SCHEMA
    );
    assert.deepStrictEqual(inspected.historyTemplate, prepared.historyTemplate);
    assert.deepStrictEqual(inspected.baseHistory.bytes, rawBase);
    const restarted = historyService.materializeSnapshotRestoreUndoHistoryTemplate(
      inspected.baseHistory.bytes,
      inspected.historyTemplate
    );
    assert.strictEqual(restarted.preparedHistoryDigest, prepared.preparedHistoryDigest);
    assert.deepStrictEqual(
      restarted.preparedHistoryState.history,
      prepared.preparedHistoryState.history
    );
    historyService.saveHistory(item.root, restarted.preparedHistoryState.history, {
      expectedState: restarted.baseHistoryState,
    });
    assert.deepStrictEqual(
      fs.readFileSync(path.join(item.root, '.writcraft', 'changes.json')),
      restarted.preparedHistoryBytes
    );
  } finally { item.cleanup(); }
});

test('raw-base, template and cross-kind tampering fail before materialized History exists', () => {
  const item = makeApplied();
  try {
    const rawBase = fs.readFileSync(path.join(item.root, '.writcraft', 'changes.json'));
    const prepared = historyService.prepareSnapshotRestoreUndoHistory(
      item.root,
      item.entryId,
      { undoneAt: '2026-08-09T01:03:04.000Z' }
    );
    const minified = Buffer.from(JSON.stringify(JSON.parse(rawBase.toString('utf8'))), 'utf8');
    expectHistoryFailure(() => historyService.materializeSnapshotRestoreUndoHistoryTemplate(
      minified,
      prepared.historyTemplate
    ));
    expectHistoryFailure(() => historyService.validateSnapshotRestoreUndoHistoryTemplate({
      ...prepared.historyTemplate,
      extra: true,
    }));
    const ordinary = historyService.prepareSnapshotRestoreHistoryTemplate(
      item.root,
      item.files.map(file => ({ ...file, createdIdentityDigest: null })),
      provenance(1),
      {
        id: prepared.historyTemplate.id,
        changeSetId: prepared.historyTemplate.changeSetId,
        appliedAt: prepared.historyTemplate.appliedAt,
      }
    );
    expectHistoryFailure(() => historyService.materializeSnapshotRestoreUndoHistoryTemplate(
      rawBase,
      ordinary.historyTemplate
    ));
    const wrongBase = {
      ...prepared.historyTemplate,
      baseHistoryState: {
        ...prepared.historyTemplate.baseHistoryState,
        digest: 'f'.repeat(64),
      },
    };
    expectHistoryFailure(() => historyService.materializeSnapshotRestoreUndoHistoryTemplate(
      rawBase,
      wrongBase
    ));
  } finally { item.cleanup(); }
});

test('top, nested and array accessors are rejected without getter invocation', () => {
  const item = makeApplied();
  try {
    const prepared = historyService.prepareSnapshotRestoreUndoHistory(
      item.root,
      item.entryId,
      { undoneAt: '2026-08-09T01:03:04.000Z' }
    );
    for (const hostile of [
      (() => {
        const value = { ...prepared.historyTemplate };
        Object.defineProperty(value, 'undoneAt', {
          enumerable: true,
          get() { throw new Error('top getter invoked'); },
        });
        return value;
      })(),
      (() => {
        const file = { ...prepared.historyTemplate.files[0] };
        Object.defineProperty(file, 'ancestorIdentityDigest', {
          enumerable: true,
          get() { throw new Error('nested getter invoked'); },
        });
        return { ...prepared.historyTemplate, files: [file] };
      })(),
      (() => {
        const files = [...prepared.historyTemplate.files];
        Object.defineProperty(files, '0', {
          enumerable: true,
          get() { throw new Error('array getter invoked'); },
        });
        return { ...prepared.historyTemplate, files };
      })(),
    ]) {
      expectHistoryFailure(() =>
        historyService.validateSnapshotRestoreUndoHistoryTemplate(hostile));
    }
  } finally { item.cleanup(); }
});

test('ordinary restore template remains distinct and WRCCHRA2-compatible', () => {
  const item = makeApplied();
  try {
    const template = historyService.prepareSnapshotRestoreHistoryTemplate(
      item.root,
      item.files.map(file => ({ ...file, createdIdentityDigest: null })),
      provenance(1),
      {
        id: 'change_22222222-2222-4222-8222-222222222222',
        changeSetId: `cs_${'c'.repeat(24)}`,
        appliedAt: '2026-08-09T02:03:04.000Z',
      }
    );
    const binding = recoveryArtifact.writeSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      `chr_${'d'.repeat(48)}`,
      nativeArtifactFiles(item.files),
      template.baseHistoryState,
      null,
      historyService,
      noMutationLifecycle,
      template.historyTemplate
    );
    const inspected = recoveryArtifact.inspectSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      binding,
      () => {},
      { includeHistory: true, historyService }
    );
    assert.strictEqual(
      inspected.preparedDelta.templateSchema,
      historyService.SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA
    );
    assert.strictEqual(inspected.historyTemplate.schema,
      historyService.SNAPSHOT_RESTORE_HISTORY_TEMPLATE_SCHEMA);
  } finally { item.cleanup(); }
});

test('maximum 300-item undo template remains inside preparedDelta budget and 301 is rejected', () => {
  const item = makeApplied(300);
  try {
    const prepared = historyService.prepareSnapshotRestoreUndoHistory(
      item.root,
      item.entryId,
      { undoneAt: '2026-08-09T01:03:04.000Z' }
    );
    const canonicalBytes = Buffer.byteLength(
      evidenceSchema.canonicalJson(prepared.historyTemplate),
      'utf8'
    );
    assert(canonicalBytes < recoveryArtifact.MAX_DELTA_BYTES);
    assert.strictEqual(prepared.historyTemplate.files.length, 300);
    expectHistoryFailure(() => historyService.validateSnapshotRestoreUndoHistoryTemplate({
      ...prepared.historyTemplate,
      files: [...prepared.historyTemplate.files, prepared.historyTemplate.files[0]],
    }));
    const binding = recoveryArtifact.writeSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      `chr_${'e'.repeat(48)}`,
      nativeArtifactFiles(item.files),
      prepared.baseHistoryState,
      prepared.preparedHistoryState,
      historyService,
      noMutationLifecycle,
      prepared.historyTemplate
    );
    const inspected = recoveryArtifact.inspectSnapshotArtifact(
      path.join(item.root, '.writcraft', 'recovery'),
      binding,
      () => {},
      { includeHistory: true, historyService }
    );
    assert.strictEqual(inspected.historyTemplate.files.length, 300);
    assert.strictEqual(inspected.preparedDelta.byteLength, canonicalBytes);
  } finally { item.cleanup(); }
});

console.log(`\n${passed}/6 Snapshot Safe Undo History template checks passed.`);
