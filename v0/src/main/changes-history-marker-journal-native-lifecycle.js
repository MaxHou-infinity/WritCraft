'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const nativeSchema = require('./changes-history-marker-journal-native-schema');
const journal = require('./changes-history-marker-journal-schema');

const HELPER_PATH = process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, '..', 'Helpers', 'changes-history-artifact-helper')
  : path.join(__dirname, 'native', 'changes-history-artifact-helper');
const LIFECYCLE_SCHEMA = 'writcraft.changes-history-marker-journal-native-lifecycle/v1';
const SCOPED_SCHEMA = 'writcraft.changes-history-marker-journal-native-lifecycle-scoped/v1';
const DEFAULT_TIMEOUT_MS = 30000;
const ROOT_PREFIX = Buffer.from('P\tOK\n', 'utf8');

class ChangesHistoryMarkerJournalNativeLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangesHistoryMarkerJournalNativeLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangesHistoryMarkerJournalNativeLifecycleError(code, message);
}

function boundedRoot(raw) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0') ||
      path.resolve(raw) !== raw || Buffer.byteLength(raw, 'utf8') > 4096) {
    fail('JOURNAL_NATIVE_PROTOCOL', 'canonical project root is required');
  }
  return raw;
}

function createChangesHistoryMarkerJournalNativeLifecycle(options = {}) {
  const helperPath = options.helperPath || HELPER_PATH;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  function forProject(rawRootPath) {
    const rootPath = boundedRoot(rawRootPath);
    const rootLine = Buffer.from(`P\t${Buffer.from(rootPath, 'utf8').toString('hex')}\n`, 'utf8');

    function invoke(rawRequest, commandBytes, expectedCommand) {
      let trustedRootFd;
      try { trustedRootFd = fs.openSync('/', fs.constants.O_RDONLY); }
      catch (_) { return null; }
      let result;
      try {
        result = spawnSync(helperPath, [], {
          input: Buffer.concat([rootLine, commandBytes]),
          timeout: timeoutMs,
          maxBuffer: nativeSchema.MAX_RESULT_BYTES + ROOT_PREFIX.length,
          stdio: ['pipe', 'pipe', 'pipe', trustedRootFd],
        });
      } catch (_) {
        return null;
      } finally {
        try { fs.closeSync(trustedRootFd); } catch (_) {}
      }
      const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.alloc(0);
      const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr : Buffer.alloc(0);
      if (result?.status !== 0 || result?.signal !== null || result?.error || stderr.length !== 0 ||
          stdout.length < ROOT_PREFIX.length || !stdout.subarray(0, ROOT_PREFIX.length).equals(ROOT_PREFIX)) {
        return null;
      }
      const payload = stdout.subarray(ROOT_PREFIX.length);
      try {
        return expectedCommand === 'DISCOVER'
          ? nativeSchema.parseDiscoverResult(payload, rawRequest)
          : nativeSchema.parseResult(payload, rawRequest, expectedCommand);
      }
      catch (_) {
        try {
          nativeSchema.parseError(payload, rawRequest, expectedCommand);
          return null;
        } catch (_) { return null; }
      }
    }

    function discover() {
      const rawRequest = { schema: nativeSchema.SCHEMAS.DISCOVER, command: 'DISCOVER' };
      return invoke(rawRequest, nativeSchema.encodeDiscoverCommand(rawRequest), 'DISCOVER');
    }

    function discoverCurrent() {
      const discovered = discover();
      if (discovered === null) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native journal DISCOVER is unavailable');
      }
      if (discovered.status !== 'PAIR') return discovered;
      const readRequest = {
        schema: nativeSchema.SCHEMAS.READ,
        command: 'READ',
        expectedHeads: [discovered.olderHead, discovered.newerHead],
      };
      const current = read(readRequest);
      if (current === null || current.status !== 'VALUE' ||
          current.head.journalId !== discovered.newerHead.journalId ||
          current.head.generation !== discovered.newerHead.generation ||
          current.head.valueDigest !== discovered.newerHead.valueDigest) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native journal DISCOVER pair changed before READ');
      }
      journal.assertTransition(discovered.olderValue, current.value);
      return current;
    }

    function initialize(rawRequest) {
      return invoke(rawRequest, nativeSchema.encodeInitCommand(rawRequest), 'INIT');
    }

    function read(rawRequest) {
      return invoke(rawRequest, nativeSchema.encodeReadCommand(rawRequest), 'READ');
    }

    function append(rawRequest) {
      const authority = nativeSchema.assertRequestAuthority(rawRequest, 'APPEND');
      const direct = invoke(rawRequest, nativeSchema.encodeAppendCommand(rawRequest), 'APPEND');
      if (direct !== null) {
        const next = authority.expectedHeads[1];
        if (direct.status === 'VALUE' && direct.head.journalId === next.journalId &&
            direct.head.generation === next.generation &&
            direct.head.valueDigest === next.valueDigest) return direct;
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native journal APPEND did not commit the exact next value');
      }
      const readRequest = {
        schema: nativeSchema.SCHEMAS.READ,
        command: 'READ',
        expectedHeads: [...authority.expectedHeads],
      };
      const reconciled = read(readRequest);
      if (!reconciled) {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native journal APPEND requires exact reconciliation');
      }
      const state = nativeSchema.classifyFreshRead(reconciled, rawRequest, readRequest);
      if (state !== 'COMMITTED') {
        fail('CHANGES_MANUAL_RECOVERY_REQUIRED', 'native journal APPEND is not durably committed');
      }
      return reconciled;
    }

    return Object.freeze({ schema: SCOPED_SCHEMA, discover, discoverCurrent, initialize, read, append });
  }

  return Object.freeze({ schema: LIFECYCLE_SCHEMA, forProject });
}

module.exports = Object.freeze({
  HELPER_PATH,
  ChangesHistoryMarkerJournalNativeLifecycleError,
  createChangesHistoryMarkerJournalNativeLifecycle,
});
