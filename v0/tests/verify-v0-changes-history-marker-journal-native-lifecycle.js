#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lifecycle = require('../src/main/changes-history-marker-journal-native-lifecycle');
const nativeSchema = require('../src/main/changes-history-marker-journal-native-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-native-journal-'));
const source = path.join(__dirname, '..', 'native', 'changes-history-artifact-helper.c');
const operationId = `chr_${'b'.repeat(48)}`;

function markerFixture(projectId, kind = 'snapshot_restore_undo') {
  const payload = {
    schema: 'writcraft.changes-history-recovery/v1',
    operationId,
    projectId,
    kind,
    state: 'applying',
    outcome: null,
    files: [{ path: 'chapter.md', beforeRevision: '1'.repeat(64), afterRevision: '2'.repeat(64) }],
    baseHistoryState: { exists: true, digest: '3'.repeat(64) },
    preparedHistoryState: { exists: true, digest: '4'.repeat(64) },
    recoveryWritePending: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
  };
  return { ...payload, integrity: crypto.createHash('sha256').update(
    JSON.stringify(payload), 'utf8'
  ).digest('hex') };
}

function compile(label = 'default', definitions = []) {
  const output = path.join(scratch, `changes-history-artifact-helper-journal-${label}`);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-Wframe-larger-than=2097152', '-mmacosx-version-min=11.0',
    '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`), source, '-o', output,
  ]);
  return output;
}

function initialValue() {
  const value = {
    schema: journal.SCHEMAS.VALUE,
    journalId: `chrj_${'a'.repeat(48)}`,
    generation: '0',
    previousValueDigest: null,
    state: 'IDLE',
    projectId: 'project-native-journal',
    activeOperationId: null,
    activeKind: null,
    activeMarker: null,
    activeMarkerDigest: null,
    nativePublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function active(previous) {
  const activeMarker = markerFixture(previous.projectId);
  const value = {
    ...previous,
    generation: journal.nextGeneration(previous.generation),
    previousValueDigest: previous.valueDigest,
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    activeMarker,
    activeMarkerDigest: journal.activeMarkerDigest(activeMarker),
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
  const recovery = path.join(root, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, '.writcraft'), 0o700);
  fs.chmodSync(recovery, 0o700);
  return { root, recovery };
}

function installPhysicalFrames(fixture, entries) {
  const journalPath = path.join(fixture.recovery, journal.JOURNAL_BASENAME);
  const fd = fs.openSync(journalPath, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_RDWR, 0o600);
  try {
    for (const entry of entries) {
      fs.writeSync(fd, entry.frame, 0, entry.frame.length, journal.SLOT_OFFSETS[entry.physical]);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const size = fs.statSync(journalPath, { bigint: true }).size;
  return {
    journalPath,
    size,
    assertUnchanged() {
      assert.strictEqual(fs.statSync(journalPath, { bigint: true }).size, size);
      const checkFd = fs.openSync(journalPath, fs.constants.O_RDONLY);
      try {
        for (const entry of entries) {
          const actual = Buffer.alloc(entry.frame.length);
          assert.strictEqual(fs.readSync(
            checkFd,
            actual,
            0,
            actual.length,
            journal.SLOT_OFFSETS[entry.physical]
          ), actual.length);
          assert.deepStrictEqual(actual, entry.frame);
        }
      } finally {
        fs.closeSync(checkFd);
      }
    },
  };
}

console.log('\nChanges/History native permanent-journal lifecycle verification');

const api = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle();
assert.strictEqual(typeof api.forProject, 'function');
for (const method of ['discover', 'discoverCurrent', 'initialize', 'read', 'append']) {
  assert.strictEqual(typeof api.forProject('/private/tmp/writcraft-journal-shape')[method], 'function');
}

console.log('Changes/History native permanent-journal lifecycle verification: 1/1 passed');

const helperPath = compile();
const fixture = project();
const scoped = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(fixture.root);
const initial = initialValue();
assert.strictEqual(scoped.discover().status, 'ABSENT');
assert.strictEqual(scoped.discoverCurrent().status, 'ABSENT');
const initRequest = {
  schema: nativeSchema.SCHEMAS.INIT,
  command: 'INIT',
  initialValue: initial,
};
const initialized = scoped.initialize(initRequest);
assert.strictEqual(initialized.status, 'VALUE');
assert.deepStrictEqual(initialized.value, initial);
const restartedBase = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(fixture.root)
  .discoverCurrent();
assert.strictEqual(restartedBase.status, 'BASE');
assert.deepStrictEqual(restartedBase.olderValue, initial);

const lostInitFixture = project();
let lostInitCalls = 0;
const lostInit = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({
  helperPath,
  spawnSync(binary, args, options) {
    lostInitCalls += 1;
    const committed = childProcess.spawnSync(binary, args, options);
    if (options.input.includes(Buffer.from('\tINIT\t', 'utf8'))) {
      return { status: 17, signal: null, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
    }
    return committed;
  },
}).forProject(lostInitFixture.root);
assert.strictEqual(lostInit.initialize(initRequest), null);
assert.strictEqual(lostInitCalls, 1);
const recoveredLostInit = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(lostInitFixture.root)
  .discoverCurrent();
assert.strictEqual(recoveredLostInit.status, 'BASE');
assert.deepStrictEqual(recoveredLostInit.olderValue, initial);

const readRequest = {
  schema: nativeSchema.SCHEMAS.READ,
  command: 'READ',
  expectedHeads: [journal.expectedHead(initial)],
};
assert.deepStrictEqual(scoped.read(readRequest).value, initial);

const next = active(initial);
const appendRequest = {
  schema: nativeSchema.SCHEMAS.APPEND,
  command: 'APPEND',
  previousValue: initial,
  nextValue: next,
};

let directOldCalls = 0;
const directOld = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({
  spawnSync() {
    directOldCalls += 1;
    return {
      status: 0,
      signal: null,
      error: undefined,
      stderr: Buffer.alloc(0),
      stdout: Buffer.concat([
        Buffer.from('P\tOK\n', 'utf8'),
        nativeSchema.encodeResult({
          schema: nativeSchema.SCHEMAS.RESULT,
          command: 'APPEND',
          status: 'VALUE',
          value: initial,
        }, appendRequest),
      ]),
    };
  },
}).forProject(fixture.root);
assert.throws(
  () => directOld.append(appendRequest),
  error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
);
assert.strictEqual(directOldCalls, 1);

const appendReadRequest = {
  schema: nativeSchema.SCHEMAS.READ,
  command: 'READ',
  expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
};
let malformedThenNextCalls = 0;
const malformedThenNext = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({
  spawnSync() {
    malformedThenNextCalls += 1;
    return {
      status: 0,
      signal: null,
      error: undefined,
      stderr: Buffer.alloc(0),
      stdout: malformedThenNextCalls === 1
        ? Buffer.from('P\tOK\nmalformed\n', 'utf8')
        : Buffer.concat([
          Buffer.from('P\tOK\n', 'utf8'),
          nativeSchema.encodeResult({
            schema: nativeSchema.SCHEMAS.RESULT,
            command: 'READ',
            status: 'VALUE',
            value: next,
          }, appendReadRequest),
        ]),
    };
  },
}).forProject(fixture.root);
assert.deepStrictEqual(malformedThenNext.append(appendRequest).value, next);
assert.strictEqual(malformedThenNextCalls, 2);

let transportThenOldCalls = 0;
const transportThenOld = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({
  spawnSync() {
    transportThenOldCalls += 1;
    if (transportThenOldCalls === 1) return { status: 17, signal: null };
    return {
      status: 0,
      signal: null,
      error: undefined,
      stderr: Buffer.alloc(0),
      stdout: Buffer.concat([
        Buffer.from('P\tOK\n', 'utf8'),
        nativeSchema.encodeResult({
          schema: nativeSchema.SCHEMAS.RESULT,
          command: 'READ',
          status: 'VALUE',
          value: initial,
        }, appendReadRequest),
      ]),
    };
  },
}).forProject(fixture.root);
assert.throws(
  () => transportThenOld.append(appendRequest),
  error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
);
assert.strictEqual(transportThenOldCalls, 2);

assert.deepStrictEqual(scoped.append(appendRequest).value, next);
const restartedPair = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(fixture.root);
const pair = restartedPair.discover();
assert.strictEqual(pair.status, 'PAIR');
assert.deepStrictEqual(pair.olderValue, initial);
assert.deepStrictEqual(pair.newerHead, journal.expectedHead(next));
const currentAfterPair = restartedPair.discoverCurrent();
assert.strictEqual(currentAfterPair.status, 'VALUE');
assert.deepStrictEqual(currentAfterPair.value, next);
assert.deepStrictEqual(scoped.read({
  schema: nativeSchema.SCHEMAS.READ,
  command: 'READ',
  expectedHeads: [journal.expectedHead(next)],
}).value, next);

const failFsyncHelper = compile('fail-value-fsync', ['WRITCRAFT_TEST_JOURNAL_FAIL_VALUE_FSYNC']);
const failFsyncScoped = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({
  helperPath: failFsyncHelper,
}).forProject(fixture.root);
const failedDurableRead = failFsyncScoped.read({
  schema: nativeSchema.SCHEMAS.READ,
  command: 'READ',
  expectedHeads: [journal.expectedHead(next)],
});
assert.strictEqual(failedDurableRead.status, 'UNKNOWN');
assert.strictEqual(failedDurableRead.value, null);
assert.throws(
  () => failFsyncScoped.append(appendRequest),
  error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
);

const replacementFixture = project();
const replacementBase = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(replacementFixture.root);
assert.strictEqual(replacementBase.initialize(initRequest).status, 'VALUE');
const replacementJournal = path.join(replacementFixture.recovery, journal.JOURNAL_BASENAME);
const replacementHeld = path.join(
  replacementFixture.recovery,
  '.changes-history-journal-test-held'
);
const beforeReplacement = fs.statSync(replacementJournal, { bigint: true });
const replaceHelper = compile('replace-before-value', [
  'WRITCRAFT_TEST_JOURNAL_REPLACE_BEFORE_VALUE',
]);
const replaced = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath: replaceHelper })
  .forProject(replacementFixture.root)
  .discover();
assert.strictEqual(replaced.status, 'UNKNOWN');
assert.ok(fs.existsSync(replacementJournal));
assert.ok(fs.existsSync(replacementHeld));
assert.deepStrictEqual(fs.readFileSync(replacementJournal), fs.readFileSync(replacementHeld));
assert.notStrictEqual(fs.statSync(replacementJournal, { bigint: true }).ino, beforeReplacement.ino);

const rewriteFixture = project();
const rewriteBase = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(rewriteFixture.root);
assert.strictEqual(rewriteBase.initialize(initRequest).status, 'VALUE');
const rewriteJournal = path.join(rewriteFixture.recovery, journal.JOURNAL_BASENAME);
const beforeRewrite = fs.statSync(rewriteJournal, { bigint: true });
const rewriteHelper = compile('rewrite-before-value', [
  'WRITCRAFT_TEST_JOURNAL_REWRITE_BEFORE_VALUE',
]);
const rewritten = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath: rewriteHelper })
  .forProject(rewriteFixture.root)
  .discover();
assert.strictEqual(rewritten.status, 'UNKNOWN');
const afterRewrite = fs.statSync(rewriteJournal, { bigint: true });
assert.strictEqual(afterRewrite.ino, beforeRewrite.ino);
assert.ok(afterRewrite.ctimeNs !== beforeRewrite.ctimeNs || afterRewrite.mtimeNs !== beforeRewrite.mtimeNs);

const initialA = journal.encodeSlotFrame(initial, 'A');
const nextB = journal.encodeSlotFrame(next, 'B');
const misplacedA = project();
const misplacedAEvidence = installPhysicalFrames(misplacedA, [{ physical: 'B', frame: initialA }]);
const misplacedAResult = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(misplacedA.root)
  .read(readRequest);
assert.strictEqual(misplacedAResult.status, 'UNKNOWN');
misplacedAEvidence.assertUnchanged();

const misplacedB = project();
const misplacedBEvidence = installPhysicalFrames(misplacedB, [{ physical: 'A', frame: nextB }]);
const misplacedBResult = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(misplacedB.root)
  .discover();
assert.strictEqual(misplacedBResult.status, 'UNKNOWN');
misplacedBEvidence.assertUnchanged();

const swapped = project();
const swappedEvidence = installPhysicalFrames(swapped, [
  { physical: 'A', frame: nextB },
  { physical: 'B', frame: initialA },
]);
const swappedResult = lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(swapped.root)
  .read(appendReadRequest);
assert.strictEqual(swappedResult.status, 'UNKNOWN');
swappedEvidence.assertUnchanged();

const legacy = project();
const legacyPath = path.join(legacy.recovery, journal.JOURNAL_BASENAME);
fs.writeFileSync(legacyPath, JSON.stringify({
  schema: 'writcraft.changes-history-recovery/v1',
  operationId,
}), { mode: 0o600 });
fs.chmodSync(legacyPath, 0o600);
assert.strictEqual(lifecycle.createChangesHistoryMarkerJournalNativeLifecycle({ helperPath })
  .forProject(legacy.root)
  .discoverCurrent().status, 'LEGACY');

console.log('Changes/History native permanent-journal lifecycle verification: 10/10 passed');
