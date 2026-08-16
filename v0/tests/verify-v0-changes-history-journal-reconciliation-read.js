#!/usr/bin/env node
// 证据级别：COMPONENT（组件证据）。本脚本用内存 fake adapter 驱动
// reconciliation 读取收敛路径，证明决策逻辑；不是持久化证明。
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const historyService = require('../src/main/change-history-service');
const journal = require('../src/main/changes-history-marker-journal-schema');
const {
  RECOVERY_RELATIVE_PATH,
  createChangesHistoryReconciliationService,
} = require('../src/main/changes-history-reconciliation-service');

const sha = value => `sha256:${String(value).repeat(64)}`;

function marker(projectId) {
  const payload = {
    schema: 'writcraft.changes-history-recovery/v1',
    operationId: `chr_${'a'.repeat(48)}`,
    projectId,
    kind: 'review',
    state: 'terminal',
    outcome: 'reviewed',
    files: [],
    baseHistoryState: { exists: false, history: { schema: historyService.HISTORY_SCHEMA, entries: [] } },
    preparedHistoryState: { exists: false, history: { schema: historyService.HISTORY_SCHEMA, entries: [] } },
    recoveryWritePending: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
  };
  return {
    ...payload,
    integrity: crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
  };
}

function activeValue(activeMarker) {
  const value = {
    schema: journal.SCHEMAS.VALUE,
    journalId: `chrj_${'b'.repeat(48)}`,
    generation: '1',
    previousValueDigest: sha('c'),
    state: 'ACTIVE',
    projectId: activeMarker.projectId,
    activeOperationId: activeMarker.operationId,
    activeKind: activeMarker.kind,
    activeMarker,
    activeMarkerDigest: journal.activeMarkerDigest(activeMarker),
    nativePublication: null,
    existingTerminalPublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function valueResult(value) {
  return {
    schema: 'writcraft.changes-history-marker-journal-native-result/v1',
    command: 'READ',
    requestDigest: sha('d'),
    status: 'VALUE',
    head: journal.expectedHead(value),
    value,
  };
}

function emptyDiscover(status) {
  return {
    schema: 'writcraft.changes-history-marker-journal-native-result/v1',
    command: 'DISCOVER',
    status,
    olderSlot: null,
    olderHead: null,
    olderPreviousValueDigest: null,
    olderValue: null,
    newerSlot: null,
    newerHead: null,
    newerPreviousValueDigest: null,
    requestDigest: sha('e'),
  };
}

function baseDiscover(value, patch = {}) {
  return {
    schema: 'writcraft.changes-history-marker-journal-native-result/v1',
    command: 'DISCOVER',
    status: 'BASE',
    olderSlot: 'A',
    olderHead: journal.expectedHead(value),
    olderPreviousValueDigest: value.previousValueDigest,
    olderValue: value,
    newerSlot: null,
    newerHead: null,
    newerPreviousValueDigest: null,
    requestDigest: sha('e'),
    ...patch,
  };
}

function idleValue(projectId) {
  const value = {
    schema: journal.SCHEMAS.VALUE,
    journalId: `chrj_${'f'.repeat(48)}`,
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
    terminalCleanup: null,
    terminalCleanupDigest: null,
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function lifecycleReturning(result) {
  return {
    schema: 'test-marker-journal-lifecycle/v1',
    forProject() {
      return {
        schema: 'test-marker-journal-scoped/v1',
        discoverCurrent() { return result; },
      };
    },
  };
}

function expectManual(fn) {
  assert.throws(fn, error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
}

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-journal-read-'));
try {
  const project = projectService.createProjectAt(parent, 'Journal Read');
  const valid = marker(project.projectId);
  const markerPath = path.join(project.rootPath, RECOVERY_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
  const forged = { ...valid, integrity: '0'.repeat(64) };
  const service = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: {
      forProject() {
        return { discoverCurrent() { return valueResult(activeValue(forged)); } };
      },
    },
  });
  assert.throws(
    () => service.readMarker(project.rootPath),
    error => error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED'
  );

  const active = activeValue(valid);
  const activeService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: lifecycleReturning(valueResult(active)),
  });
  assert.deepStrictEqual(activeService.readMarker(project.rootPath), valid);
  assert.strictEqual(activeService.hasPending(project.rootPath), true);

  const idleService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: lifecycleReturning(valueResult(idleValue(project.projectId))),
  });
  assert.strictEqual(idleService.readMarker(project.rootPath), null);
  assert.strictEqual(idleService.hasPending(project.rootPath), false);
  const baseIdleService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: lifecycleReturning(baseDiscover(idleValue(project.projectId))),
  });
  assert.strictEqual(baseIdleService.readMarker(project.rootPath), null);
  assert.strictEqual(baseIdleService.hasPending(project.rootPath), false);

  const generationOneIdle = {
    ...idleValue(project.projectId),
    generation: '1',
    previousValueDigest: sha('8'),
    valueDigest: null,
  };
  generationOneIdle.valueDigest = journal.valueDigest(generationOneIdle);
  const hostileBases = [
    baseDiscover(idleValue(project.projectId), { olderSlot: 'B' }),
    baseDiscover(journal.assertJournalValue(generationOneIdle)),
    baseDiscover(active),
    baseDiscover(idleValue(project.projectId), {
      newerSlot: 'B',
      newerHead: journal.expectedHead(active),
      newerPreviousValueDigest: idleValue(project.projectId).valueDigest,
    }),
  ];
  for (const hostileBase of hostileBases) {
    const blockedBase = createChangesHistoryReconciliationService({
      projectService,
      historyService,
      markerJournalLifecycle: lifecycleReturning(hostileBase),
    });
    expectManual(() => blockedBase.readMarker(project.rootPath));
  }

  let forbiddenPathReads = 0;
  const guardedFs = new Proxy(fs, {
    get(target, key) {
      if (!['lstatSync', 'readFileSync'].includes(key)) return target[key];
      return (...args) => {
        if (args[0] === markerPath) {
          forbiddenPathReads += 1;
          throw new Error('forbidden marker path read');
        }
        return target[key](...args);
      };
    },
  });
  const absentService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    fileSystem: guardedFs,
    markerJournalLifecycle: lifecycleReturning(emptyDiscover('ABSENT')),
  });
  assert.strictEqual(absentService.readMarker(project.rootPath), null);
  assert.strictEqual(absentService.hasPending(project.rootPath), false);
  assert.strictEqual(forbiddenPathReads, 0);

  const legacyService = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    markerJournalLifecycle: lifecycleReturning(emptyDiscover('LEGACY')),
  });
  assert.deepStrictEqual(legacyService.readMarker(project.rootPath), valid);
  assert.strictEqual(legacyService.hasPending(project.rootPath), true);
  const legacyOnly = createChangesHistoryReconciliationService({ projectService, historyService });
  assert.deepStrictEqual(legacyOnly.readMarker(project.rootPath), valid);
  assert.strictEqual(legacyOnly.hasPending(project.rootPath), true);

  for (const result of [emptyDiscover('UNKNOWN'), null, { status: 'ABSENT' }]) {
    const blocked = createChangesHistoryReconciliationService({
      projectService,
      historyService,
      fileSystem: guardedFs,
      markerJournalLifecycle: lifecycleReturning(result),
    });
    expectManual(() => blocked.readMarker(project.rootPath));
    expectManual(() => blocked.hasPending(project.rootPath));
  }
  assert.strictEqual(forbiddenPathReads, 0);

  let getterCalls = 0;
  const outerGetter = {};
  Object.defineProperty(outerGetter, 'forProject', {
    enumerable: true,
    get() { getterCalls += 1; return () => ({ discoverCurrent() {} }); },
  });
  const hostileOuter = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    fileSystem: guardedFs,
    markerJournalLifecycle: outerGetter,
  });
  expectManual(() => hostileOuter.readMarker(project.rootPath));
  assert.strictEqual(getterCalls, 0);

  const missingScoped = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    fileSystem: guardedFs,
    markerJournalLifecycle: { forProject() { return {}; } },
  });
  expectManual(() => missingScoped.readMarker(project.rootPath));
  const scopedGetter = createChangesHistoryReconciliationService({
    projectService,
    historyService,
    fileSystem: guardedFs,
    markerJournalLifecycle: {
      forProject() {
        const scoped = {};
        Object.defineProperty(scoped, 'discoverCurrent', {
          enumerable: true,
          get() { getterCalls += 1; return () => emptyDiscover('ABSENT'); },
        });
        return scoped;
      },
    },
  });
  expectManual(() => scopedGetter.readMarker(project.rootPath));
  assert.strictEqual(getterCalls, 0);
  assert.strictEqual(forbiddenPathReads, 0);
} finally {
  fs.rmSync(parent, { recursive: true, force: true });
}

console.log('Changes/History journal reconciliation read verification: 8/8 passed');
