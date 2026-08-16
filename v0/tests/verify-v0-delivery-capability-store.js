'use strict';

const assert = require('assert');
const storeModule = require('../src/main/delivery-capability-store');

const projectInstanceId = 'instance_0123456789abcdef01234567';
const binding = Object.freeze({
  ownerId: 'webcontents:42',
  projectInstanceId,
  ownerGeneration: 2,
  mutationGeneration: 7,
  navigationEpoch: 4,
});
const authorityDigest = `sha256:${'a'.repeat(64)}`;
const selectionDigest = `sha256:${'b'.repeat(64)}`;

function issueInput(overrides = {}) {
  return {
    subjectId: 'snapshot_stage_b',
    authorityDigest,
    selectionDigest,
    ...overrides,
  };
}

function makeClock(start = 1000) {
  let now = start;
  return {
    clock: () => now,
    advance(ms) { now += ms; },
  };
}

function makeRandomBytes() {
  let counter = 0;
  return () => {
    const bytes = Buffer.alloc(16);
    bytes.writeUInt32BE(counter += 1, 12);
    return bytes;
  };
}

function createFixedRandom(capabilityId) {
  return () => Buffer.from(capabilityId.slice('delivery_cap_'.length), 'hex');
}

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

console.log('WritCraft 0.4.0 Stage B delivery capability store tests');

test('issues an opaque one-time capability with the frozen local record shape', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  const issued = store.issue(binding, issueInput());
  assert.match(issued.capabilityId, storeModule.CAPABILITY_ID_RE);
  assert.strictEqual(issued.expiresAt, new Date(1000 + storeModule.CAPABILITY_TTL_MS).toISOString());
  const record = store.inspect({ capabilityId: issued.capabilityId });
  assert.deepStrictEqual(Object.keys(record).sort(), [
    'authorityDigest', 'capabilityId', 'consumedAt', 'expiresAt', 'issuedAt',
    'kind', 'ownerGeneration', 'projectInstanceId', 'schema', 'selectionDigest',
    'singleUse', 'subjectId',
  ].sort());
  assert.strictEqual(record.kind, storeModule.CAPABILITY_KIND);
  assert.strictEqual(record.singleUse, true);
  assert.strictEqual(record.consumedAt, null);
  assert.deepStrictEqual(store.stats(), { active: 1, tombstones: 0 });
});

test('consumes once and marks consumed before returning', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  const issued = store.issue(binding, issueInput());
  const consumed = store.consume(binding, {
    capabilityId: issued.capabilityId,
    authorityDigest,
    selectionDigest,
  });
  assert.strictEqual(consumed.capabilityId, issued.capabilityId);
  assert.strictEqual(consumed.projectInstanceId, projectInstanceId);
  assert.strictEqual(consumed.consumedAt, new Date(1000).toISOString());
  assert.strictEqual(store.inspect({ capabilityId: issued.capabilityId }), null);
  assert.throws(
    () => store.consume(binding, { capabilityId: issued.capabilityId, authorityDigest, selectionDigest }),
    error => error.code === 'DELIVERY_CAPABILITY_REPLAYED'
  );
});

test('owner, authority and selection drift fail closed without consuming the capability', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  const issued = store.issue(binding, issueInput());
  assert.throws(
    () => store.consume({ ...binding, navigationEpoch: binding.navigationEpoch + 1 }, {
      capabilityId: issued.capabilityId, authorityDigest, selectionDigest,
    }),
    error => error.code === 'DELIVERY_CAPABILITY_STALE'
  );
  assert.throws(
    () => store.consume(binding, {
      capabilityId: issued.capabilityId,
      authorityDigest: `sha256:${'c'.repeat(64)}`,
      selectionDigest,
    }),
    error => error.code === 'DELIVERY_CAPABILITY_STALE'
  );
  assert.ok(store.inspect({ capabilityId: issued.capabilityId }));
  const consumed = store.consume(binding, { capabilityId: issued.capabilityId, authorityDigest, selectionDigest });
  assert.strictEqual(consumed.capabilityId, issued.capabilityId);
});

test('fixed TTL expires at the boundary and distinguishes expiry from replay', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  const issued = store.issue(binding, issueInput());
  time.advance(storeModule.CAPABILITY_TTL_MS);
  assert.strictEqual(store.inspect({ capabilityId: issued.capabilityId }), null);
  assert.throws(
    () => store.consume(binding, { capabilityId: issued.capabilityId, authorityDigest, selectionDigest }),
    error => error.code === 'DELIVERY_CAPABILITY_EXPIRED'
  );
});

test('explicit revoke and project revoke invalidate capabilities without exposing records', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  const first = store.issue(binding, issueInput());
  const second = store.issue({ ...binding, ownerGeneration: 3 }, issueInput({ subjectId: 'snapshot_stage_c' }));
  assert.strictEqual(store.revoke(binding, { capabilityId: first.capabilityId }), true);
  assert.throws(
    () => store.consume(binding, { capabilityId: first.capabilityId, authorityDigest, selectionDigest }),
    error => error.code === 'DELIVERY_CAPABILITY_REPLAYED'
  );
  assert.strictEqual(store.revokeProject({ projectInstanceId }), 1);
  assert.strictEqual(store.inspect({ capabilityId: second.capabilityId }), null);
  assert.throws(
    () => store.consume({ ...binding, ownerGeneration: 3 }, {
      capabilityId: second.capabilityId, authorityDigest, selectionDigest,
    }),
    error => error.code === 'DELIVERY_CAPABILITY_REPLAYED'
  );
});

test('unknown fields and accessors are rejected before any getter is read', () => {
  const time = makeClock();
  const store = storeModule.createDeliveryCapabilityStore({ clock: time.clock, randomBytes: makeRandomBytes() });
  assert.throws(() => store.issue(binding, { ...issueInput(), extra: true }), error => error.code === 'INVALID_DELIVERY_CAPABILITY');
  let bindingReads = 0;
  const getterBinding = { ...binding };
  Object.defineProperty(getterBinding, 'projectInstanceId', {
    enumerable: true,
    get() { bindingReads += 1; return projectInstanceId; },
  });
  assert.throws(() => store.issue(getterBinding, issueInput()), error => error.code === 'INVALID_DELIVERY_CAPABILITY');
  assert.strictEqual(bindingReads, 0);
  let requestReads = 0;
  const getterRequest = { ...issueInput() };
  Object.defineProperty(getterRequest, 'selectionDigest', {
    enumerable: true,
    get() { requestReads += 1; return selectionDigest; },
  });
  assert.throws(() => store.issue(binding, getterRequest), error => error.code === 'INVALID_DELIVERY_CAPABILITY');
  assert.strictEqual(requestReads, 0);
  assert.throws(() => store.revoke(binding, { capabilityId: 'delivery_cap_' + 'a'.repeat(32), extra: true }), error => error.code === 'INVALID_DELIVERY_CAPABILITY');
});

test('never reuses a tombstoned opaque id', () => {
  const time = makeClock();
  const firstBytes = Buffer.alloc(16, 3);
  let calls = 0;
  const store = storeModule.createDeliveryCapabilityStore({
    clock: time.clock,
    randomBytes: () => {
      calls += 1;
      return calls <= 2 ? firstBytes : Buffer.alloc(16, 7);
    },
  });
  const first = store.issue(binding, issueInput());
  store.revoke(binding, { capabilityId: first.capabilityId });
  const second = store.issue(binding, issueInput());
  assert.notStrictEqual(second.capabilityId, first.capabilityId);
});

console.log(`Stage B delivery capability store: ${passed}/${passed} passed`);
