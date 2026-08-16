#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const physical = require('../src/main/changes-history-marker-journal');
const schema = require('../src/main/changes-history-marker-journal-schema');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-marker-journal-'));
const journalId = `chrj_${'a'.repeat(48)}`;
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

function project(rootMode = 0o700) {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  const privatePath = path.join(root, '.writcraft');
  const recovery = path.join(privatePath, 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, rootMode);
  fs.chmodSync(privatePath, 0o700);
  fs.chmodSync(recovery, 0o700);
  return { root, privatePath, recovery, journalPath: path.join(recovery, schema.JOURNAL_BASENAME) };
}

function directoryIdentity(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function openBinding(fixture) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const rootFd = fs.openSync(fixture.root, flags);
  const privateFd = fs.openSync(fixture.privatePath, flags);
  const recoveryFd = fs.openSync(fixture.recovery, flags);
  const binding = {
    rootDirectory: { fd: rootFd, identity: directoryIdentity(rootFd) },
    privateDirectory: { fd: privateFd, identity: directoryIdentity(privateFd) },
    recoveryDirectory: { fd: recoveryFd, identity: directoryIdentity(recoveryFd) },
  };
  return { rootFd, privateFd, recoveryFd, binding };
}

function heldProject(fixture, fileSystem = fs, hooks = Object.freeze({}), observeVerification = null) {
  const { rootFd, privateFd, recoveryFd, binding } = openBinding(fixture);
  const digest = `sha256:${crypto.createHash('sha256').update([
    'writcraft.test-marker-journal-directory-chain/v1',
    binding.rootDirectory.identity.dev,
    binding.rootDirectory.identity.ino,
    binding.privateDirectory.identity.dev,
    binding.privateDirectory.identity.ino,
    binding.recoveryDirectory.identity.dev,
    binding.recoveryDirectory.identity.ino,
  ].join('\n')).digest('hex')}`;
  const api = physical.createChangesHistoryMarkerJournal({
    fileSystem,
    hooks,
    verifyDirectoryChain(authority) {
      if (observeVerification) observeVerification();
      assert.strictEqual(authority.rootDirectory.fd, rootFd);
      assert.strictEqual(authority.privateDirectory.fd, privateFd);
      assert.strictEqual(authority.recoveryDirectory.fd, recoveryFd);
      return {
        chainDigest: digest,
        rootIdentity: { ...binding.rootDirectory.identity },
        privateIdentity: { ...binding.privateDirectory.identity },
        recoveryIdentity: { ...binding.recoveryDirectory.identity },
      };
    },
    openJournalAt(fd, basename, openFlags, mode) {
      assert.strictEqual(fd, recoveryFd);
      assert.strictEqual(basename, schema.JOURNAL_BASENAME);
      return fileSystem.openSync(fixture.journalPath, openFlags, mode);
    },
  });
  return api.forProject(binding);
}

function active(previous) {
  const activeMarker = markerFixture(previous.projectId);
  const value = {
    ...previous,
    generation: schema.nextGeneration(previous.generation),
    previousValueDigest: previous.valueDigest,
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    activeMarker,
    activeMarkerDigest: schema.activeMarkerDigest(activeMarker),
    valueDigest: null,
  };
  value.valueDigest = schema.valueDigest(value);
  return schema.assertJournalValue(value);
}

function failDirectoryFsyncOnce() {
  let failed = false;
  return new Proxy(fs, {
    get(target, key) {
      if (key !== 'fsyncSync') return target[key];
      return fd => {
        const stat = fs.fstatSync(fd);
        if (!failed && stat.isDirectory()) {
          failed = true;
          const error = new Error('injected directory fsync response loss');
          error.code = 'EIO';
          throw error;
        }
        return fs.fsyncSync(fd);
      };
    },
  });
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nChanges/History permanent marker physical journal verification');

test('module exposes one project-scoped physical journal API', () => {
  const fixture = project();
  const api = physical.createChangesHistoryMarkerJournal({
    openJournalAt() {},
    verifyDirectoryChain() {},
  });
  assert.strictEqual(typeof api.forProject, 'function');
  const scoped = heldProject(fixture);
  for (const method of ['openOrInitialize', 'readHead', 'append']) {
    assert.strictEqual(typeof scoped[method], 'function');
  }
});

test('absence initializes durable WRCCHRJ2 IDLE and exact read authority', () => {
  const fixture = project();
  const scoped = heldProject(fixture);
  const initialized = scoped.openOrInitialize({ projectId: 'project-physical', journalId });
  assert.strictEqual(initialized.state, 'INITIALIZED');
  assert.strictEqual(initialized.head.state, 'IDLE');
  assert.strictEqual(
    fs.readFileSync(fixture.journalPath, 'utf8').startsWith(`WRCCHRJ2\tA\t${journalId}\t0\t`),
    true
  );
  assert.strictEqual(Number(fs.statSync(fixture.journalPath, { bigint: true }).mode & 0o7777n), 0o600);
  const read = scoped.readHead(initialized.expectedHead);
  assert.strictEqual(read.state, 'READY');
  assert.deepStrictEqual(read.head, initialized.head);
});

test('append CAS advances inactive slot from IDLE to ACTIVE', () => {
  const fixture = project();
  const scoped = heldProject(fixture);
  const initialized = scoped.openOrInitialize({ projectId: 'project-physical', journalId });
  const next = active(initialized.head);
  const committed = scoped.append(initialized.expectedHead, next);
  assert.strictEqual(committed.state, 'COMMITTED');
  assert.deepStrictEqual(committed.head, next);
  assert.deepStrictEqual(scoped.readHead(committed.expectedHead).head, next);
});

test('initialization directory-fsync loss retries the same exact IDLE truth', () => {
  const fixture = project();
  const failing = heldProject(fixture, failDirectoryFsyncOnce());
  assert.throws(
    () => failing.openOrInitialize({ projectId: 'project-physical', journalId }),
    /directory fsync response loss/
  );
  const recovered = heldProject(fixture)
    .openOrInitialize({ projectId: 'project-physical', journalId });
  assert.strictEqual(recovered.head.state, 'IDLE');
});

test('append directory-fsync loss converges from the exact committed next value', () => {
  const fixture = project();
  const normal = heldProject(fixture);
  const initialized = normal.openOrInitialize({ projectId: 'project-physical', journalId });
  const next = active(initialized.head);
  const failing = heldProject(fixture, failDirectoryFsyncOnce());
  assert.throws(() => failing.append(initialized.expectedHead, next), /directory fsync response loss/);
  assert.throws(
    () => normal.append(initialized.expectedHead, next),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.deepStrictEqual(normal.readHead(schema.expectedHead(next)).head, next);
});

test('a path-only symlinked private input cannot bypass the held-verifier dependency gate', () => {
  const root = fs.mkdtempSync(path.join(scratch, 'symlink-root-'));
  const outside = fs.mkdtempSync(path.join(scratch, 'symlink-outside-'));
  const outsideRecovery = path.join(outside, 'recovery');
  fs.mkdirSync(outsideRecovery, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(outside, 0o700);
  fs.symlinkSync(outside, path.join(root, '.writcraft'));
  const scoped = physical.createChangesHistoryMarkerJournal({
    openJournalAt() {},
    verifyDirectoryChain() {},
  });
  assert.throws(
    () => scoped.forProject(root),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.existsSync(path.join(outsideRecovery, schema.JOURNAL_BASENAME)), false);
});

test('the injected descriptor-chain verifier rejects crossed project fds before either write', () => {
  const left = project();
  const right = project();
  const leftHeld = openBinding(left);
  const rightHeld = openBinding(right);
  const mixed = {
    rootDirectory: leftHeld.binding.rootDirectory,
    privateDirectory: rightHeld.binding.privateDirectory,
    recoveryDirectory: rightHeld.binding.recoveryDirectory,
  };
  let journalOpens = 0;
  const api = physical.createChangesHistoryMarkerJournal({
    verifyDirectoryChain(authority) {
      assert.strictEqual(authority.rootDirectory.fd, rightHeld.rootFd);
    },
    openJournalAt() {
      journalOpens += 1;
      throw new Error('must not open');
    },
  });
  assert.throws(
    () => api.forProject(mixed),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(journalOpens, 0);
  assert.strictEqual(fs.existsSync(left.journalPath), false);
  assert.strictEqual(fs.existsSync(right.journalPath), false);
});

test('missing, partial and accessor verifier dependencies fail before write with getter zero', () => {
  const fixture = project();
  const held = openBinding(fixture);
  assert.throws(
    () => physical.createChangesHistoryMarkerJournal({ openJournalAt() {} }),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  const partial = physical.createChangesHistoryMarkerJournal({
    openJournalAt() { throw new Error('must not open'); },
    verifyDirectoryChain() { return { chainDigest: `sha256:${'0'.repeat(64)}` }; },
  });
  assert.throws(
    () => partial.forProject(held.binding),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  let resultGetterCalls = 0;
  const accessorResult = physical.createChangesHistoryMarkerJournal({
    openJournalAt() { throw new Error('must not open'); },
    verifyDirectoryChain() {
      const result = {};
      Object.defineProperty(result, 'chainDigest', {
        enumerable: true,
        configurable: true,
        get() { resultGetterCalls += 1; return `sha256:${'0'.repeat(64)}`; },
      });
      result.rootIdentity = { ...held.binding.rootDirectory.identity };
      result.privateIdentity = { ...held.binding.privateDirectory.identity };
      result.recoveryIdentity = { ...held.binding.recoveryDirectory.identity };
      return result;
    },
  });
  assert.throws(
    () => accessorResult.forProject(held.binding),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(resultGetterCalls, 0);
  let getterCalls = 0;
  const hostile = { openJournalAt() {} };
  Object.defineProperty(hostile, 'verifyDirectoryChain', {
    enumerable: true,
    get() { getterCalls += 1; return () => ({}); },
  });
  assert.throws(
    () => physical.createChangesHistoryMarkerJournal(hostile),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(getterCalls, 0);
  assert.strictEqual(fs.existsSync(fixture.journalPath), false);
});

test('the chain verifier is replayed across init, read and append durability boundaries', () => {
  const fixture = project();
  let verificationCalls = 0;
  let atInitializeDurable = 0;
  let atInactivePayload = 0;
  let atCommitDurable = 0;
  const scoped = heldProject(fixture, fs, {
    afterInitializeDurable() { atInitializeDurable = verificationCalls; },
    afterInactivePayload() { atInactivePayload = verificationCalls; },
    afterCommitDurable() { atCommitDurable = verificationCalls; },
  }, () => { verificationCalls += 1; });
  const afterBind = verificationCalls;
  const initialized = scoped.openOrInitialize({ projectId: 'project-physical', journalId });
  assert.strictEqual(atInitializeDurable > afterBind, true);
  const beforeRead = verificationCalls;
  scoped.readHead(initialized.expectedHead);
  assert.strictEqual(verificationCalls > beforeRead, true);
  const beforeAppend = verificationCalls;
  scoped.append(initialized.expectedHead, active(initialized.head));
  assert.strictEqual(atInactivePayload > beforeAppend, true);
  assert.strictEqual(atCommitDurable > atInactivePayload, true);
});

test('project root mode 0755 is accepted while private directories remain 0700', () => {
  const fixture = project(0o755);
  const initialized = heldProject(fixture)
    .openOrInitialize({ projectId: 'project-physical', journalId });
  assert.strictEqual(initialized.head.state, 'IDLE');
  assert.strictEqual(Number(fs.statSync(fixture.root, { bigint: true }).mode & 0o7777n), 0o755);
  assert.strictEqual(Number(fs.statSync(fixture.privatePath, { bigint: true }).mode & 0o7777n), 0o700);
  assert.strictEqual(Number(fs.statSync(fixture.recovery, { bigint: true }).mode & 0o7777n), 0o700);
});

test('initialization final nofollow reopen rejects a basename symlink to the same journal inode', () => {
  const fixture = project();
  const ownedPath = path.join(fixture.recovery, 'owned-journal');
  const scoped = heldProject(fixture, fs, {
    afterInitializeDurable() {
      fs.renameSync(fixture.journalPath, ownedPath);
      fs.symlinkSync(path.basename(ownedPath), fixture.journalPath);
    },
  });
  assert.throws(
    () => scoped.openOrInitialize({ projectId: 'project-physical', journalId }),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.strictEqual(fs.lstatSync(fixture.journalPath).isSymbolicLink(), true);
  assert.strictEqual(
    fs.readFileSync(ownedPath, 'utf8').startsWith(`WRCCHRJ2\tA\t${journalId}\t0\t`),
    true
  );
});

test('append rejects a stale expected head before changing any journal byte', () => {
  const fixture = project();
  const scoped = heldProject(fixture);
  const initialized = scoped.openOrInitialize({ projectId: 'project-physical', journalId });
  const next = active(initialized.head);
  scoped.append(initialized.expectedHead, next);
  const before = fs.readFileSync(fixture.journalPath);
  assert.throws(
    () => scoped.append(initialized.expectedHead, next),
    error => error && error.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );
  assert.deepStrictEqual(fs.readFileSync(fixture.journalPath), before);
});

console.log(`Changes/History permanent marker physical journal verification: ${passed}/${passed} passed`);
