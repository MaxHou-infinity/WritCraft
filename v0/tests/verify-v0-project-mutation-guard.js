#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  createInlineRewriteMutationGuard,
} = require('../src/main/inline-rewrite-mutation-guard');

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
  assert.throws(fn, error =>
    error && error.code === code && !error.message.includes('/private/'));
}

console.log('\nComposite project mutation guard verification');

test('allows mutation only when both recovery authorities are empty', () => {
  const guard = createInlineRewriteMutationGuard({
    readMarker: () => null,
    readChangesMarker: () => null,
  });
  assert.strictEqual(guard.assertAvailable('/project'), true);
});

test('preserves the signed Inline recovery error', () => {
  const guard = createInlineRewriteMutationGuard({
    readMarker: () => ({ outcome: 'applied' }),
    readChangesMarker: () => null,
  });
  expectCode('INLINE_REWRITE_RECOVERY_PENDING', () => guard.assertAvailable('/project'));
});

test('blocks every Changes marker without exposing marker contents', () => {
  const guard = createInlineRewriteMutationGuard({
    readMarker: () => null,
    readChangesMarker: () => ({ operationId: 'secret', files: ['a.md'] }),
  });
  expectCode('CHANGES_RECOVERY_PENDING', () => guard.assertAvailable('/project'));
});

test('fails closed when either marker cannot be read', () => {
  const inline = createInlineRewriteMutationGuard({
    readMarker: () => { throw new Error('/private/secret'); },
    readChangesMarker: () => null,
  });
  expectCode('INLINE_REWRITE_RECOVERY_PENDING', () => inline.assertAvailable('/project'));

  const changes = createInlineRewriteMutationGuard({
    readMarker: () => null,
    readChangesMarker: () => { throw new Error('/private/secret'); },
  });
  expectCode('CHANGES_RECOVERY_PENDING', () => changes.assertAvailable('/project'));
});

test('rejects an invalid root before invoking either reader', () => {
  let reads = 0;
  const guard = createInlineRewriteMutationGuard({
    readMarker: () => { reads += 1; return null; },
    readChangesMarker: () => { reads += 1; return null; },
  });
  expectCode('INLINE_REWRITE_RECOVERY_PENDING', () => guard.assertAvailable(''));
  assert.strictEqual(reads, 0);
});

console.log(`\n${passed}/5 composite mutation guard checks passed.\n`);
