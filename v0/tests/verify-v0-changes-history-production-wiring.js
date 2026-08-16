#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'main.js'),
  'utf8'
);

assert.match(
  mainSource,
  /const publicMarkdownNativeLifecycleService = require\('\.\/public-markdown-native-lifecycle'\);/u
);
assert.match(
  mainSource,
  /require\('\.\/changes-history-marker-journal-native-lifecycle'\);/u
);
assert.match(
  mainSource,
  /const changesHistoryMarkerLifecycleService = require\('\.\/changes-history-marker-lifecycle'\);/u
);
const wiringStart = mainSource.indexOf('const publicMarkdownNativeLifecycle =');
const wiringEnd = mainSource.indexOf('const writingStructureTransaction =', wiringStart);
assert(wiringStart >= 0 && wiringEnd > wiringStart, 'Snapshot restore production wiring block is absent');
const wiring = mainSource.slice(wiringStart, wiringEnd);
assert.match(
  wiring,
  /publicMarkdownNativeLifecycleService\.createPublicMarkdownNativeLifecycle\(\)/u
);
assert.match(
  wiring,
  /createChangesHistoryMarkerJournalNativeLifecycle\(\)/u
);
assert.match(
  mainSource,
  /changesHistoryMarkerLifecycleService\.createChangesHistoryMarkerLifecycle\(\)/u
);
for (const method of [
  'create',
  'createMissingJournal',
  'reconcile',
  'verifyCreate',
  'finalizeCreate',
  'reconcileFinalize',
  'cleanupCreate',
  'reconcileCreateCleanup',
  'ackCreateCleanup',
]) {
  assert.match(wiring, new RegExp(`${method}: scoped\\.${method}`, 'u'));
}
for (const forbidden of [
  'quarantine',
  'reconcileUndo',
  'restoreQuarantine',
  'finalizeUndo',
  'ackUndo',
]) {
  assert.doesNotMatch(wiring, new RegExp(`${forbidden}: scoped\\.${forbidden}`, 'u'));
}
assert.match(
  wiring,
  /publicMarkdownLifecycle: snapshotRestorePublicMarkdownLifecycle/u
);
assert.match(
  wiring,
  /markerJournalLifecycle: changesHistoryMarkerJournalLifecycle/u
);
assert.match(
  wiring,
  /exactMarkerLifecycle: changesHistoryMarkerLifecycle/u
);

const transactionSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'changes-history-transaction.js'),
  'utf8'
);
assert.match(
  transactionSource,
  /markerJournalLifecycle: options\.markerJournalLifecycle/u
);
assert.match(
  transactionSource,
  /exactMarkerLifecycle: options\.exactMarkerLifecycle/u
);

console.log('1/1 Main permanent-journal Snapshot CREATE lifecycle composition wiring passed');
