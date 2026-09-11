'use strict';

const fs = require('fs');
const schema = require('./changes-history-marker-journal-schema');

const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;
const DIRECTORY = fs.constants.O_DIRECTORY || 0;
const JOURNAL_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const LEGACY_SCHEMA = 'writcraft.changes-history-recovery/v1';

class ChangesHistoryMarkerJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryMarkerJournalError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryMarkerJournalError(code, message);
}

function identity(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function valuesOf(raw, keys, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype || Object.getOwnPropertySymbols(raw).length !== 0) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is invalid`);
  }
  const names = Object.getOwnPropertyNames(raw);
  if (names.length !== keys.length || keys.some((key, index) => names[index] !== key)) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} fields are invalid`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set ||
        descriptor.enumerable !== true || descriptor.configurable !== true || descriptor.writable !== true) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} descriptors are invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function dataFunction(raw, key, label) {
  if (raw === null || typeof raw !== 'object') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is unavailable`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set ||
      typeof descriptor.value !== 'function') {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} is unavailable`);
  }
  return descriptor.value;
}

function assertDirectoryIdentity(raw, label) {
  const value = valuesOf(raw, ['dev', 'ino'], `${label} identity`);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.dev || '') ||
      !/^(?:0|[1-9][0-9]*)$/u.test(value.ino || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} identity is invalid`);
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function assertDirectoryAuthority(fileSystem, raw, label, requirePrivateMode) {
  const value = valuesOf(raw, ['fd', 'identity'], `${label} authority`);
  if (!Number.isInteger(value.fd) || value.fd < 0) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} descriptor is invalid`);
  }
  const expected = assertDirectoryIdentity(value.identity, label);
  let stat;
  try { stat = fileSystem.fstatSync(value.fd, { bigint: true }); }
  catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} descriptor is unavailable`); }
  if ((Number(stat.mode) & S_IFMT) !== S_IFDIR ||
      (requirePrivateMode && (Number(stat.uid) !== process.geteuid() ||
        Number(stat.mode & 0o7777n) !== DIRECTORY_MODE))) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} authority is unsafe`);
  }
  const held = identity(stat);
  if (held.dev !== expected.dev || held.ino !== expected.ino) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', `${label} descriptor identity changed`);
  }
  return Object.freeze({ fd: value.fd, identity: expected });
}

function assertVerifiedChain(raw, expected) {
  const value = valuesOf(
    raw,
    ['chainDigest', 'rootIdentity', 'privateIdentity', 'recoveryIdentity'],
    'verified project directory chain'
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.chainDigest || '')) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'verified project directory chain digest is invalid');
  }
  const identities = {
    root: assertDirectoryIdentity(value.rootIdentity, 'verified project root'),
    private: assertDirectoryIdentity(value.privateIdentity, 'verified private project directory'),
    recovery: assertDirectoryIdentity(value.recoveryIdentity, 'verified recovery directory'),
  };
  for (const key of ['root', 'private', 'recovery']) {
    if (!sameInode(expected[key], identities[key])) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'verified project directory chain identity differs');
    }
  }
  return Object.freeze({
    chainDigest: value.chainDigest,
    root: identities.root,
    private: identities.private,
    recovery: identities.recovery,
  });
}

function assertJournalStat(stat) {
  if ((Number(stat.mode) & S_IFMT) !== S_IFREG || Number(stat.uid) !== process.geteuid() ||
      Number(stat.mode & 0o7777n) !== JOURNAL_MODE || Number(stat.nlink) !== 1) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal authority is unsafe');
  }
  return identity(stat);
}

function writeAll(fileSystem, fd, bytes, position) {
  let written = 0;
  while (written < bytes.length) {
    const count = fileSystem.writeSync(fd, bytes, written, bytes.length - written, position + written);
    if (!Number.isInteger(count) || count <= 0) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal write is incomplete');
    }
    written += count;
  }
}

function readAt(fileSystem, fd, length, position) {
  const bytes = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fileSystem.readSync(fd, bytes, read, length - read, position + read);
    if (!Number.isInteger(count) || count < 0) {
      fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal read failed');
    }
    if (count === 0) break;
    read += count;
  }
  return bytes.subarray(0, read);
}

function splitFrame(frame) {
  const newline = frame.indexOf(0x0a);
  if (newline < 0 || newline + 1 > schema.MAX_HEADER_BYTES) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'journal frame header is invalid');
  }
  return Object.freeze({
    header: frame.subarray(0, newline + 1),
    payload: frame.subarray(newline + 1),
  });
}

function readSlot(fileSystem, fd, slot) {
  const offset = schema.SLOT_OFFSETS[slot];
  const prefix = readAt(fileSystem, fd, schema.MAX_HEADER_BYTES, offset);
  if (prefix.length === 0) return Object.freeze({ slot, state: 'ABSENT', frame: null, value: null });
  const newline = prefix.indexOf(0x0a);
  if (newline < 0) return Object.freeze({ slot, state: 'INVALID', frame: null, value: null });
  const fields = prefix.subarray(0, newline).toString('utf8').split('\t');
  const payloadLength = fields.length === 8 && /^(?:0|[1-9][0-9]*)$/u.test(fields[4])
    ? Number(fields[4])
    : -1;
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 1 ||
      payloadLength > schema.MAX_VALUE_BYTES) {
    return Object.freeze({ slot, state: 'INVALID', frame: null, value: null });
  }
  const length = newline + 1 + payloadLength;
  const frame = readAt(fileSystem, fd, length, offset);
  if (frame.length !== length) {
    return Object.freeze({ slot, state: 'INVALID', frame: null, value: null });
  }
  try {
    const parsed = schema.parseSlotFrame(frame);
    if (parsed.slot !== slot) throw new Error('slot');
    return Object.freeze({ slot, state: 'VALID', frame, value: parsed.value });
  } catch (_) {
    return Object.freeze({ slot, state: 'INVALID', frame: null, value: null });
  }
}

function select(fileSystem, fd, expectedHead = null) {
  const left = readSlot(fileSystem, fd, 'A');
  const right = readSlot(fileSystem, fd, 'B');
  const invalid = Buffer.from([0xff]);
  let head;
  try {
    head = schema.selectJournalHead(
      left.state === 'VALID' ? left.frame : invalid,
      right.state === 'VALID' ? right.frame : invalid,
      expectedHead
    );
  } catch (_) {
    fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal head is invalid');
  }
  return Object.freeze({ head, slots: Object.freeze({ A: left, B: right }) });
}

function initialValue(projectId, journalId) {
  const raw = {
    schema: schema.SCHEMAS.VALUE,
    journalId,
    generation: '0',
    previousValueDigest: null,
    state: 'IDLE',
    projectId,
    activeOperationId: null,
    activeKind: null,
    activeMarker: null,
    activeMarkerDigest: null,
    nativePublication: null,
    existingTerminalPublication: null,
    rollbackCreatePublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
    valueDigest: null,
  };
  raw.valueDigest = schema.valueDigest(raw);
  return schema.assertJournalValue(raw);
}

function createChangesHistoryMarkerJournal(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const hooks = options.hooks || Object.freeze({});
  const openJournalAt = dataFunction(options, 'openJournalAt', 'descriptor-relative journal opener');
  const verifyDirectoryChain = dataFunction(
    options,
    'verifyDirectoryChain',
    'descriptor-safe project directory chain verifier'
  );

  function forProject(rawAuthority) {
    const value = valuesOf(
      rawAuthority,
      ['rootDirectory', 'privateDirectory', 'recoveryDirectory'],
      'project journal directory authority'
    );
    const bound = Object.freeze({
      root: assertDirectoryAuthority(fileSystem, value.rootDirectory, 'project root', false),
      private: assertDirectoryAuthority(fileSystem, value.privateDirectory, 'private project directory', true),
      recovery: assertDirectoryAuthority(fileSystem, value.recoveryDirectory, 'recovery directory', true),
    });

    function publicAuthority() {
      return Object.freeze({
        rootDirectory: Object.freeze({
          fd: bound.root.fd,
          identity: Object.freeze({ dev: bound.root.identity.dev, ino: bound.root.identity.ino }),
        }),
        privateDirectory: Object.freeze({
          fd: bound.private.fd,
          identity: Object.freeze({ dev: bound.private.identity.dev, ino: bound.private.identity.ino }),
        }),
        recoveryDirectory: Object.freeze({
          fd: bound.recovery.fd,
          identity: Object.freeze({ dev: bound.recovery.identity.dev, ino: bound.recovery.identity.ino }),
        }),
      });
    }

    function currentIdentities() {
      return Object.freeze({
        root: assertDirectoryAuthority(fileSystem, {
          fd: bound.root.fd,
          identity: { dev: bound.root.identity.dev, ino: bound.root.identity.ino },
        }, 'project root', false).identity,
        private: assertDirectoryAuthority(fileSystem, {
          fd: bound.private.fd,
          identity: { dev: bound.private.identity.dev, ino: bound.private.identity.ino },
        }, 'private project directory', true).identity,
        recovery: assertDirectoryAuthority(fileSystem, {
          fd: bound.recovery.fd,
          identity: { dev: bound.recovery.identity.dev, ino: bound.recovery.identity.ino },
        }, 'recovery directory', true).identity,
      });
    }

    function verifyCurrentChain(identities) {
      let raw;
      try { raw = verifyDirectoryChain(publicAuthority()); }
      catch (_) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'project directory ancestry is not verified');
      }
      return assertVerifiedChain(raw, identities);
    }

    const initialChain = verifyCurrentChain(currentIdentities());

    function authorities() {
      const identities = currentIdentities();
      const verified = verifyCurrentChain(identities);
      if (verified.chainDigest !== initialChain.chainDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'project directory chain digest changed');
      }
      return verified;
    }

    function assertChain(expected) {
      const current = authorities();
      if (!sameInode(expected.root, current.root) ||
          !sameInode(expected.private, current.private) ||
          !sameInode(expected.recovery, current.recovery) ||
          expected.chainDigest !== current.chainDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal root chain changed');
      }
      return current;
    }

    function syncRecoveryDirectory(expectedChain) {
      assertChain(expectedChain);
      const held = identity(fileSystem.fstatSync(bound.recovery.fd, { bigint: true }));
      if (!sameInode(expectedChain.recovery, held)) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'recovery directory descriptor changed');
      }
      fileSystem.fsyncSync(bound.recovery.fd);
      assertChain(expectedChain);
    }

    function openJournal(flags, mode) {
      try {
        return openJournalAt(bound.recovery.fd, schema.JOURNAL_BASENAME, flags, mode);
      } catch (error) {
        throw error;
      }
    }

    function reopenExact(expectedHeld, expectedChain) {
      assertChain(expectedChain);
      let fd;
      try { fd = openJournal(fs.constants.O_RDWR | NO_FOLLOW); }
      catch (_) { fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal is unavailable'); }
      try {
        const current = assertJournalStat(fileSystem.fstatSync(fd, { bigint: true }));
        if (!sameInode(expectedHeld, current)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal was replaced');
        }
        return fd;
      } catch (error) {
        try { fileSystem.closeSync(fd); } catch (_) {}
        throw error;
      }
    }

    function openExisting() {
      const chain = authorities();
      let fd;
      try {
        fd = openJournal(fs.constants.O_RDWR | NO_FOLLOW);
      } catch (_) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal is unavailable');
      }
      let held;
      try { held = assertJournalStat(fileSystem.fstatSync(fd, { bigint: true })); }
      catch (error) { try { fileSystem.closeSync(fd); } catch (_) {} throw error; }
      const rebound = reopenExact(held, chain);
      fileSystem.closeSync(rebound);
      return { fd, held, chain };
    }

    function classifyLegacy(fd) {
      const prefix = readAt(fileSystem, fd, 4096, 0);
      const text = prefix.toString('utf8').trimStart();
      if (!text.startsWith('{')) return false;
      try {
        const parsed = JSON.parse(text);
        return parsed && parsed.schema === LEGACY_SCHEMA;
      } catch (_) { return false; }
    }

    function readHead(rawExpectedHead = null) {
      const opened = openExisting();
      try {
        if (classifyLegacy(opened.fd)) return Object.freeze({ state: 'LEGACY', head: null });
        const selected = select(fileSystem, opened.fd, rawExpectedHead);
        assertChain(opened.chain);
        const rebound = reopenExact(opened.held, opened.chain);
        try { select(fileSystem, rebound, schema.expectedHead(selected.head)); }
        finally { fileSystem.closeSync(rebound); }
        return Object.freeze({
          state: 'READY',
          head: selected.head,
          expectedHead: schema.expectedHead(selected.head),
        });
      } finally { fileSystem.closeSync(opened.fd); }
    }

    function openOrInitialize(raw) {
      const value = initialValue(raw.projectId, raw.journalId);
      const chain = authorities();
      let fd;
      try {
        fd = openJournal(
          fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          JOURNAL_MODE
        );
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          const recovered = readHead(schema.expectedHead(value));
          syncRecoveryDirectory(chain);
          return readHead(recovered.expectedHead);
        }
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'permanent marker journal initialization failed');
      }
      try {
        fileSystem.fchmodSync(fd, JOURNAL_MODE);
        const frame = schema.encodeSlotFrame(value, 'A');
        assertChain(chain);
        writeAll(fileSystem, fd, frame, schema.SLOT_OFFSETS.A);
        fileSystem.fsyncSync(fd);
        const held = assertJournalStat(fileSystem.fstatSync(fd, { bigint: true }));
        assertChain(chain);
        syncRecoveryDirectory(chain);
        if (typeof hooks.afterInitializeDurable === 'function') hooks.afterInitializeDurable();
        const rebound = reopenExact(held, chain);
        try { select(fileSystem, rebound, schema.expectedHead(value)); }
        finally { fileSystem.closeSync(rebound); }
        return Object.freeze({
          state: 'INITIALIZED',
          head: value,
          expectedHead: schema.expectedHead(value),
        });
      } finally { fileSystem.closeSync(fd); }
    }

    function append(rawExpectedHead, rawNextValue) {
      const expected = schema.assertExpectedHead(rawExpectedHead);
      const next = schema.assertJournalValue(rawNextValue);
      const opened = openExisting();
      try {
        if (classifyLegacy(opened.fd)) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'legacy marker must migrate before journal append');
        }
        const before = select(fileSystem, opened.fd, expected);
        const currentHead = schema.expectedHead(before.head);
        if (currentHead.journalId !== expected.journalId ||
            currentHead.generation !== expected.generation ||
            currentHead.valueDigest !== expected.valueDigest) {
          fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'journal append expected head is stale');
        }
        if (before.head.valueDigest === next.valueDigest) {
          syncRecoveryDirectory(opened.chain);
          return Object.freeze({
            state: 'COMMITTED',
            head: next,
            expectedHead: schema.expectedHead(next),
          });
        }
        schema.assertTransition(before.head, next);
        let activeSlot = 'A';
        for (const slot of schema.SLOTS) {
          if (before.slots[slot].state === 'VALID' &&
              before.slots[slot].value.valueDigest === before.head.valueDigest) activeSlot = slot;
        }
        const inactiveSlot = activeSlot === 'A' ? 'B' : 'A';
        const frame = schema.encodeSlotFrame(next, inactiveSlot);
        const parts = splitFrame(frame);
        const offset = schema.SLOT_OFFSETS[inactiveSlot];
        assertChain(opened.chain);
        writeAll(fileSystem, opened.fd, parts.payload, offset + parts.header.length);
        fileSystem.fsyncSync(opened.fd);
        assertChain(opened.chain);
        if (typeof hooks.afterInactivePayload === 'function') hooks.afterInactivePayload();
        const beforeCommitFd = reopenExact(opened.held, opened.chain);
        fileSystem.closeSync(beforeCommitFd);
        select(fileSystem, opened.fd, expected);
        writeAll(fileSystem, opened.fd, parts.header, offset);
        fileSystem.fsyncSync(opened.fd);
        syncRecoveryDirectory(opened.chain);
        if (typeof hooks.afterCommitDurable === 'function') hooks.afterCommitDurable();
        assertChain(opened.chain);
        const reboundFd = reopenExact(opened.held, opened.chain);
        try {
          assertJournalStat(fileSystem.fstatSync(reboundFd, { bigint: true }));
          const rebound = select(fileSystem, reboundFd, schema.expectedHead(next));
          if (rebound.head.valueDigest !== next.valueDigest) {
            fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'journal commit did not become logical head');
          }
        } finally { fileSystem.closeSync(reboundFd); }
        return Object.freeze({
          state: 'COMMITTED',
          head: next,
          expectedHead: schema.expectedHead(next),
        });
      } finally { fileSystem.closeSync(opened.fd); }
    }

    return Object.freeze({ openOrInitialize, readHead, append });
  }

  return Object.freeze({ forProject });
}

module.exports = Object.freeze({
  ChangesHistoryMarkerJournalError,
  createChangesHistoryMarkerJournal,
});
