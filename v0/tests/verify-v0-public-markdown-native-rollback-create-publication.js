#!/usr/bin/env node
'use strict';

const assert = require('assert');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');

const TERMINAL_SCHEMA = journal.SCHEMAS.ROLLBACK_CREATE_PUBLICATION;
const ATTEMPT_SCHEMA = journal.SCHEMAS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION;
const operationId = `chr_${'a'.repeat(48)}`;
const foreignOperationId = `chr_${'b'.repeat(48)}`;
const sha = value => `sha256:${String(value).repeat(64)}`;

const AUTHORITY_BASE64 = Buffer.from('{"authority":1}', 'utf8').toString('base64');
const QUARANTINE_BASE64 = Buffer.from('{"quarantine":1}', 'utf8').toString('base64');
const SETTLE_BASE64 = Buffer.from('{"settle":1}', 'utf8').toString('base64');
const OTHER_BASE64 = Buffer.from('{"other":1}', 'utf8').toString('base64');

function sealTerminal(raw) {
  const value = { ...raw, publicationDigest: null };
  value.publicationDigest = journal.rollbackCreatePublicationDigest(value);
  return value;
}

function terminal(state, settleResultBase64 = SETTLE_BASE64, patch = {}) {
  return sealTerminal({
    schema: TERMINAL_SCHEMA,
    state,
    operationId,
    requestDigest: sha('1'),
    authorityBase64: AUTHORITY_BASE64,
    quarantineResultBase64: QUARANTINE_BASE64,
    settleResultBase64,
    ...patch,
  });
}

function quarantined() {
  return journal.assertRollbackCreatePublication(terminal('QUARANTINED', null));
}

function rolledBack() {
  return journal.assertRollbackCreatePublication(terminal('ROLLED_BACK', SETTLE_BASE64));
}

function ackCommitted() {
  return journal.assertRollbackCreatePublication(terminal('ACK_COMMITTED', SETTLE_BASE64));
}

function sealAttempt(raw) {
  const value = { ...raw, publicationDigest: null };
  value.publicationDigest = journal.rollbackCreateAttemptPublicationDigest(value);
  return value;
}

function attempt(patch = {}) {
  return sealAttempt({
    schema: ATTEMPT_SCHEMA,
    state: 'PREPARED',
    operationId,
    requestDigest: sha('1'),
    authorityBase64: AUTHORITY_BASE64,
    predecessorValueDigest: sha('2'),
    installedGeneration: '5',
    ...patch,
  });
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'INVALID_CHANGES_HISTORY_MARKER_JOURNAL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nRollback-create publication pure-schema verification');

test('QUARANTINED publication validates, exposes exact keys and reproduces its self-digest', () => {
  const value = journal.assertRollbackCreatePublication(terminal('QUARANTINED', null));
  assert.deepStrictEqual(Object.keys(value), journal.KEYS.ROLLBACK_CREATE_PUBLICATION);
  assert.strictEqual(value.publicationDigest, journal.rollbackCreatePublicationDigest(value));
  assert.strictEqual(
    value.publicationDigest,
    evidence.digestObject(TERMINAL_SCHEMA, { ...value, publicationDigest: null }, 'publicationDigest')
  );
  assert.strictEqual(value.settleResultBase64, null);
});

test('ROLLED_BACK and ACK_COMMITTED publications reproduce their self-digest', () => {
  for (const value of [rolledBack(), ackCommitted()]) {
    assert.notStrictEqual(value.settleResultBase64, null);
    assert.strictEqual(value.publicationDigest, journal.rollbackCreatePublicationDigest(value));
  }
});

test('QUARANTINED rejects a tampered publicationDigest', () => {
  invalid(() => journal.assertRollbackCreatePublication({
    ...terminal('QUARANTINED', null),
    publicationDigest: sha('9'),
  }));
  invalid(() => journal.assertRollbackCreatePublication({
    ...terminal('QUARANTINED', null),
    publicationDigest: 'sha256:' + '0'.repeat(63),
  }));
});

test('QUARANTINED must not carry a settle result', () => {
  invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', SETTLE_BASE64)));
});

test('ROLLED_BACK and ACK_COMMITTED must carry a settle result', () => {
  invalid(() => journal.assertRollbackCreatePublication(terminal('ROLLED_BACK', null)));
  invalid(() => journal.assertRollbackCreatePublication(terminal('ACK_COMMITTED', null)));
});

test('QUARANTINED to ROLLED_BACK is the only legal first transition', () => {
  const previous = quarantined();
  const next = rolledBack();
  assert.deepStrictEqual(journal.assertRollbackCreatePublicationTransition(previous, next), next);
});

test('ROLLED_BACK to ACK_COMMITTED is legal while an identical republication is a no-op', () => {
  const previous = rolledBack();
  const next = ackCommitted();
  assert.deepStrictEqual(journal.assertRollbackCreatePublicationTransition(previous, next), next);
  assert.deepStrictEqual(
    journal.assertRollbackCreatePublicationTransition(previous, rolledBack()),
    previous
  );
});

test('QUARANTINED cannot skip the ROLLED_BACK settle step', () => {
  invalid(() => journal.assertRollbackCreatePublicationTransition(quarantined(), ackCommitted()));
});

test('an ACK_COMMITTED terminal cannot regress to ROLLED_BACK', () => {
  invalid(() => journal.assertRollbackCreatePublicationTransition(ackCommitted(), rolledBack()));
});

test('operation identity and request digest are immutable across transition', () => {
  invalid(() => journal.assertRollbackCreatePublicationTransition(
    quarantined(),
    terminal('ROLLED_BACK', SETTLE_BASE64, { operationId: foreignOperationId })
  ));
  invalid(() => journal.assertRollbackCreatePublicationTransition(
    quarantined(),
    terminal('ROLLED_BACK', SETTLE_BASE64, { requestDigest: sha('3') })
  ));
});

test('authority and quarantine result bytes are immutable across transition', () => {
  invalid(() => journal.assertRollbackCreatePublicationTransition(
    quarantined(),
    terminal('ROLLED_BACK', SETTLE_BASE64, { authorityBase64: OTHER_BASE64 })
  ));
  invalid(() => journal.assertRollbackCreatePublicationTransition(
    quarantined(),
    terminal('ROLLED_BACK', SETTLE_BASE64, { quarantineResultBase64: OTHER_BASE64 })
  ));
});

test('a ROLLED_BACK settle result cannot be rewritten on the ACK transition', () => {
  invalid(() => journal.assertRollbackCreatePublicationTransition(
    rolledBack(),
    terminal('ACK_COMMITTED', OTHER_BASE64)
  ));
});

test('rollback-create publication rejects an invalid operation identity or state', () => {
  invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
    operationId: `chr_${'A'.repeat(48)}`,
  })));
  invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
    operationId: 'chr_short',
  })));
  invalid(() => journal.assertRollbackCreatePublication({
    ...terminal('ROLLED_BACK', SETTLE_BASE64),
    schema: ATTEMPT_SCHEMA,
  }));
  invalid(() => journal.assertRollbackCreatePublication(terminal('PUBLISHED', SETTLE_BASE64)));
});

test('rollback-create publication rejects malformed digest shapes', () => {
  for (const requestDigest of [sha('z'), 'a'.repeat(64), `sha256:${'a'.repeat(63)}`, 7, null]) {
    invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
      requestDigest,
    })));
  }
});

test('rollback-create publication enforces descriptor-exact keys', () => {
  const { settleResultBase64: _settle, ...withoutSettle } = terminal('QUARANTINED', null);
  invalid(() => journal.assertRollbackCreatePublication(withoutSettle));
  const { publicationDigest: _digest, ...withoutDigest } = terminal('QUARANTINED', null);
  invalid(() => journal.assertRollbackCreatePublication(withoutDigest));
  invalid(() => journal.assertRollbackCreatePublication({
    ...terminal('QUARANTINED', null),
    absolutePath: '/private/tmp/leak',
  }));
});

test('rollback-create publication rejects invalid, non-canonical and empty base64', () => {
  const hostile = ['not base64!!!', 'eA=', 'eB==', 'eyJ4IjoxfQ-_', ''];
  for (const value of hostile) {
    invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
      authorityBase64: value,
    })));
    invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
      quarantineResultBase64: value,
    })));
    invalid(() => journal.assertRollbackCreatePublication(terminal('ROLLED_BACK', value)));
  }
});

test('rollback-create publication rejects base64 over the frozen budget', () => {
  const overBudget = 'A'.repeat(journal.MAX_EXISTING_TERMINAL_PUBLICATION_BYTES + 4);
  invalid(() => journal.assertRollbackCreatePublication(terminal('QUARANTINED', null, {
    authorityBase64: overBudget,
  })));
  invalid(() => journal.assertRollbackCreatePublication(terminal('ROLLED_BACK', overBudget)));
});

test('attempt latch validates, exposes exact keys and reproduces its self-digest', () => {
  const value = journal.assertRollbackCreateAttemptPublication(attempt());
  assert.deepStrictEqual(Object.keys(value), journal.KEYS.ROLLBACK_CREATE_ATTEMPT_PUBLICATION);
  assert.strictEqual(value.state, 'PREPARED');
  assert.strictEqual(value.publicationDigest, journal.rollbackCreateAttemptPublicationDigest(value));
  assert.strictEqual(
    value.publicationDigest,
    evidence.digestObject(ATTEMPT_SCHEMA, { ...value, publicationDigest: null }, 'publicationDigest')
  );
});

test('attempt latch rejects a tampered digest, predecessor or generation authority', () => {
  invalid(() => journal.assertRollbackCreateAttemptPublication({
    ...attempt(), publicationDigest: sha('9'),
  }));
  invalid(() => journal.assertRollbackCreateAttemptPublication({
    ...attempt(), predecessorValueDigest: sha('4'),
  }));
  invalid(() => journal.assertRollbackCreateAttemptPublication(attempt({
    state: 'QUARANTINED',
  })));
  invalid(() => journal.assertRollbackCreateAttemptPublication(attempt({
    operationId: 'chr_short',
  })));
  invalid(() => journal.assertRollbackCreateAttemptPublication({
    ...attempt(), requestDigest: sha('5'),
  }));
});

test('attempt latch requires predecessorValueDigest and installedGeneration', () => {
  for (const key of ['predecessorValueDigest', 'installedGeneration', 'authorityBase64']) {
    const hostile = attempt();
    delete hostile[key];
    invalid(() => journal.assertRollbackCreateAttemptPublication(hostile));
  }
  invalid(() => journal.assertRollbackCreateAttemptPublication({
    ...attempt(), absolutePath: '/private/tmp/leak',
  }));
});

test('attempt latch rejects malformed generation and authority bytes', () => {
  for (const installedGeneration of ['', '05', '-1', '1e3', '18446744073709551616', 5]) {
    invalid(() => journal.assertRollbackCreateAttemptPublication(attempt({ installedGeneration })));
  }
  for (const authorityBase64 of ['not base64!!!', 'eB==', '']) {
    invalid(() => journal.assertRollbackCreateAttemptPublication(attempt({ authorityBase64 })));
  }
});

test('KEYS.VALUE carries rollbackCreatePublication between EXISTING terminal and cleanup', () => {
  const keys = journal.KEYS.VALUE;
  const index = keys.indexOf('rollbackCreatePublication');
  assert.strictEqual(index, keys.indexOf('existingTerminalPublication') + 1);
  assert.strictEqual(keys.indexOf('terminalCleanup'), index + 1);
});

test('publication schemas are the exact frozen literals and remain distinct', () => {
  assert.strictEqual(TERMINAL_SCHEMA, 'writcraft.changes-history-rollback-create-publication/v1');
  assert.strictEqual(
    ATTEMPT_SCHEMA,
    'writcraft.changes-history-rollback-create-attempt-publication/v1'
  );
  assert.notStrictEqual(TERMINAL_SCHEMA, ATTEMPT_SCHEMA);
});

console.log(`\nRollback-create publication schema verification: ${passed}/${passed} passed`);
if (passed !== 23) process.exitCode = 1;
