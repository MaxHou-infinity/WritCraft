#!/usr/bin/env node
'use strict';

const assert = require('assert');
const evidence = require('../src/main/evidence-delivery-schema');
const schema = require('../src/main/changes-history-marker-lifecycle-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;
const operationId = `chr_${'a'.repeat(48)}`;

function request(overrides = {}) {
  return {
    schema: schema.SCHEMAS.REQUEST,
    operationId,
    projectId: 'project-marker-clear',
    markerBasename: schema.MARKER_BASENAME,
    markerByteLength: 4096,
    markerDigest: digest(1),
    markerIdentityDigest: digest(2),
    finalizedPhaseDigest: digest(3),
    artifactCleanupDigest: digest(4),
    trustedRootIdentityDigest: digest(5),
    projectChainIdentityDigest: digest(6),
    recoveryIdentityDigest: digest(7),
    ...overrides,
  };
}

function recordIdentity(bytes, offset) {
  return schema.buildRecordIdentity({
    dev: String(10 + offset),
    ino: String(20 + offset),
    uid: 501,
    mode: 0o600,
    nlink: 1,
    size: String(Buffer.byteLength(bytes, 'utf8')),
    mtimeNs: String(30 + offset),
    ctimeNs: String(40 + offset),
    recordSha256: evidence.sha256(Buffer.from(bytes, 'utf8')),
  });
}

function authority() {
  const expectedRequest = request();
  const control = schema.buildControl(
    expectedRequest,
    `.changes-history-marker-clear.${'5'.repeat(32)}`
  );
  const receipt = schema.buildReceipt(expectedRequest, control);
  const controlIdentity = recordIdentity(schema.encodeControlRecord(expectedRequest, control), 1);
  const receiptIdentity = recordIdentity(
    schema.encodeReceiptRecord(expectedRequest, control, receipt),
    2
  );
  const token = schema.buildToken(
    expectedRequest,
    control,
    receipt,
    controlIdentity,
    receiptIdentity
  );
  return { request: expectedRequest, control, receipt, controlIdentity, receiptIdentity, token };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'MARKER_CLEAR_PROTOCOL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nChanges/History exact marker lifecycle schema verification');

test('formal record identity is a complete 3.1.4 self-digested authority', () => {
  const identity = schema.buildRecordIdentity({
    dev: '1', ino: '2', uid: 501, mode: 0o600, nlink: 1, size: '128',
    mtimeNs: '3', ctimeNs: '4', recordSha256: digest(5),
  });
  assert.strictEqual(schema.assertRecordIdentity(identity).identityDigest, identity.identityDigest);
  invalid(() => schema.assertRecordIdentity({ ...identity, ino: '9' }));
  invalid(() => schema.assertRecordIdentity({ ...identity, recordSha256: digest(9) }));
});

test('3.1.4 request/control/receipt digests and record names match frozen goldens', () => {
  const value = authority();
  assert.strictEqual(
    schema.requestDigest(value.request),
    'sha256:db39a1faa91e55b3003d7997a2d021eab29b2cd03cb6277479ad57861b59aaeb'
  );
  assert.deepStrictEqual(schema.recordNames(value.request), {
    controlBasename: '.changes-history-marker-clear-control.ff481aabf81efebe2f1d859dddf1c3bad67643299baa128ffbb2784aed473139',
    receiptBasename: '.changes-history-marker-clear-receipt.ff481aabf81efebe2f1d859dddf1c3bad67643299baa128ffbb2784aed473139',
  });
  assert.strictEqual(
    value.control.controlDigest,
    'sha256:8dcc21958764066d7326157a04fc6d9c592e4a0d56a88f099a6fab8b1f2040af'
  );
  assert.strictEqual(
    value.receipt.receiptDigest,
    'sha256:fd3164a4a8d1558e99a51b6d03f55c15c020e21957aa1b988017cb7c940a1ff7'
  );
});

test('request binds exact marker, project, phase, cleanup, byte and identity authority', () => {
  const base = request();
  assert.strictEqual(schema.assertRequest(base).markerByteLength, 4096);
  for (const drift of [
    { operationId: `chr_${'b'.repeat(48)}` },
    { projectId: 'other-project' },
    { markerByteLength: 4097 },
    { markerDigest: digest(6) },
    { markerIdentityDigest: digest(6) },
    { finalizedPhaseDigest: digest(6) },
    { artifactCleanupDigest: digest(6) },
    { trustedRootIdentityDigest: digest(8) },
    { projectChainIdentityDigest: digest(8) },
    { recoveryIdentityDigest: digest(8) },
  ]) {
    assert.notStrictEqual(schema.requestDigest(request(drift)), schema.requestDigest(base));
  }
  invalid(() => schema.assertRequest(request({ markerBasename: '/private/tmp/marker' })));
  invalid(() => schema.assertRequest(request({ body: 'manuscript' })));
  invalid(() => schema.assertRequest(request({ projectId: `bad\ud800` })));
});

test('request/control/receipt/token reject descriptors before invoking getters', () => {
  for (const [build, field, validate] of [
    [() => request(), 'markerDigest', hostile => schema.assertRequest(hostile)],
    [() => authority().control, 'controlDigest', hostile => {
      const value = authority();
      return schema.assertControl(hostile, value.request);
    }],
    [() => authority().receipt, 'receiptDigest', hostile => {
      const value = authority();
      return schema.assertReceipt(hostile, value.request, value.control);
    }],
    [() => authority().token, 'receiptDigest', hostile => {
      const value = authority();
      return schema.assertToken(hostile, value.request);
    }],
    [() => authority().controlIdentity, 'ino', hostile => schema.assertRecordIdentity(hostile)],
  ]) {
    let getters = 0;
    const hostile = { ...build() };
    Object.defineProperty(hostile, field, {
      enumerable: true,
      get() { getters += 1; return digest(9); },
    });
    invalid(() => validate(hostile));
    assert.strictEqual(getters, 0);
  }
});

test('hidden, symbol, inherited and extra authority never validates', () => {
  const extra = request({ absolutePath: '/private/tmp/foreign' });
  invalid(() => schema.assertRequest(extra));
  const hidden = request();
  Object.defineProperty(hidden, 'hidden', { value: true });
  invalid(() => schema.assertRequest(hidden));
  const symbolic = request();
  symbolic[Symbol('foreign')] = true;
  invalid(() => schema.assertRequest(symbolic));
  const inherited = Object.assign(Object.create({ foreign: true }), request());
  invalid(() => schema.assertRequest(inherited));
});

test('formal token rederives the complete request/control/receipt relation', () => {
  const {
    request: expectedRequest,
    control,
    receipt,
    controlIdentity,
    receiptIdentity,
    token,
  } = authority();
  invalid(() => schema.assertControl(control));
  invalid(() => schema.buildReceipt(control));
  invalid(() => schema.assertReceipt(receipt));
  invalid(() => schema.assertToken(token));
  assert.strictEqual(schema.assertToken(token, expectedRequest).receiptDigest, token.receiptDigest);
  invalid(() => schema.assertToken({ ...token, controlDigest: digest(8) }, expectedRequest));
  invalid(() => schema.assertToken({ ...token, receiptDigest: digest(8) }, expectedRequest));
  invalid(() => schema.assertToken({
    ...token,
    controlIdentity: { ...token.controlIdentity, ino: '999' },
  }, expectedRequest));
  invalid(() => schema.assertToken({
    ...token,
    receiptIdentity: { ...token.receiptIdentity, recordSha256: digest(8) },
  }, expectedRequest));
  invalid(() => schema.assertToken({
    ...token,
    quarantineBasename: `.changes-history-marker-clear.${'6'.repeat(32)}`,
  }, expectedRequest));
  invalid(() => schema.assertToken(token, request({ projectId: 'foreign-project' })));
  invalid(() => schema.assertToken(token, request({ finalizedPhaseDigest: digest(9) })));
  invalid(() => schema.assertToken(token, request({ trustedRootIdentityDigest: digest(9) })));
  invalid(() => schema.assertToken(token, request({ projectChainIdentityDigest: digest(9) })));
  invalid(() => schema.assertToken(token, request({ recoveryIdentityDigest: digest(9) })));
  const wrongSizeIdentity = schema.buildRecordIdentity({
    dev: controlIdentity.dev,
    ino: controlIdentity.ino,
    uid: controlIdentity.uid,
    mode: controlIdentity.mode,
    nlink: controlIdentity.nlink,
    size: String(Number(controlIdentity.size) + 1),
    mtimeNs: controlIdentity.mtimeNs,
    ctimeNs: controlIdentity.ctimeNs,
    recordSha256: controlIdentity.recordSha256,
  });
  invalid(() => schema.buildToken(
    expectedRequest,
    control,
    receipt,
    wrongSizeIdentity,
    receiptIdentity
  ));
});

test('result matrix accepts only command-bound terminal three-state truth', () => {
  const value = authority();
  const base = {
    schema: schema.SCHEMAS.RESULT,
    command: 'CLEAR',
    state: 'COMMITTED',
    operationId,
    requestDigest: schema.requestDigest(value.request),
    token: value.token,
    errorCode: null,
  };
  assert.strictEqual(schema.assertResult(base, value.request, 'CLEAR').state, 'COMMITTED');
  assert.strictEqual(schema.assertResult({
    ...base,
    command: 'RECONCILE',
    state: 'UNCOMMITTED',
    token: null,
  }, value.request, 'RECONCILE').state, 'UNCOMMITTED');
  assert.strictEqual(schema.assertResult({
    ...base,
    command: 'RECONCILE',
    state: 'UNKNOWN',
    token: null,
    errorCode: 'MARKER_CLEAR_UNKNOWN',
  }, value.request, 'RECONCILE').state, 'UNKNOWN');
  invalid(() => schema.assertResult({ ...base, command: 'RECONCILE' }, value.request, 'CLEAR'));
  invalid(() => schema.assertResult({ ...base, token: null }, value.request, 'CLEAR'));
  invalid(() => schema.assertResult({ ...base, state: 'UNCOMMITTED' }, value.request, 'CLEAR'));
  invalid(() => schema.assertResult({ ...base, errorCode: 'raw /private/tmp/secret' }, value.request, 'CLEAR'));
  invalid(() => schema.assertResult({ ...base, requestDigest: digest(8) }, value.request, 'CLEAR'));
});

test('ACK consumes only the exact formal token and has no guessed success state', () => {
  const value = authority();
  const ack = schema.buildAckRequest(value.request, value.token);
  assert.strictEqual(schema.assertAckRequest(ack, value.request).token.receiptDigest,
    value.token.receiptDigest);
  assert.strictEqual(schema.assertAckResult({
    schema: schema.SCHEMAS.ACK_RESULT,
    state: 'ACKED',
    operationId,
    requestDigest: schema.requestDigest(value.request),
    errorCode: null,
  }, value.request).state, 'ACKED');
  assert.strictEqual(schema.assertAckResult({
    schema: schema.SCHEMAS.ACK_RESULT,
    state: 'UNKNOWN',
    operationId,
    requestDigest: schema.requestDigest(value.request),
    errorCode: 'MARKER_CLEAR_UNKNOWN',
  }, value.request).state, 'UNKNOWN');
  invalid(() => schema.assertAckRequest({
    ...ack,
    token: { ...value.token, receiptDigest: digest(9) },
  }, value.request));
  invalid(() => schema.assertAckResult({
    schema: schema.SCHEMAS.ACK_RESULT,
    state: 'ACKED',
    operationId,
    requestDigest: schema.requestDigest(value.request),
    errorCode: 'MARKER_CLEAR_UNKNOWN',
  }, value.request));
  invalid(() => schema.assertAckResult({
    schema: schema.SCHEMAS.ACK_RESULT,
    state: 'ACKED',
    operationId,
    requestDigest: schema.requestDigest(value.request),
    errorCode: 'raw /private/tmp/secret',
  }, value.request));
});

test('marker and project limits fail at the frozen boundary', () => {
  assert.strictEqual(schema.assertRequest(request({
    markerByteLength: schema.LIMITS.maxMarkerBytes,
  })).markerByteLength, schema.LIMITS.maxMarkerBytes);
  invalid(() => schema.assertRequest(request({
    markerByteLength: schema.LIMITS.maxMarkerBytes + 1,
  })));
  assert.strictEqual(schema.assertRequest(request({ projectId: 'p'.repeat(256) })).projectId.length, 256);
  invalid(() => schema.assertRequest(request({ projectId: 'p'.repeat(257) })));
});

console.log(`\n✓ ${passed}/${passed} exact marker lifecycle schema checks passed`);
