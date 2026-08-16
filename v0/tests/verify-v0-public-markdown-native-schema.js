#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/public-markdown-native-schema');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');

const digest = value => `sha256:${String(value).repeat(64)}`;
const operationId = `chr_${'a'.repeat(48)}`;

function createRequest(items = null, overrides = {}) {
  return {
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId,
    artifactDigest: digest(1),
    artifactIdentityDigest: digest(2),
    artifactByteLength: 100,
    precreatePhaseDigest: digest(3),
    selectionDigest: digest(4),
    items: items || [{
      selectedId: 'missing:1',
      path: 'chapter.md',
      artifactOffset: 10,
      byteLength: 5,
      contentDigest: digest(5),
      ancestorIdentityDigest: digest(6),
    }],
    ...overrides,
  };
}

function authority() {
  const request = createRequest();
  const control = schema.buildControl(request, 0);
  const receipt = schema.buildReceipt(control, digest(7));
  const token = schema.buildToken(request, 0, receipt);
  const finalize = {
    schema: schema.SCHEMAS.FINALIZE_REQUEST,
    operationId,
    artifactDigest: request.artifactDigest,
    selectionDigest: request.selectionDigest,
    historyCommittedPhaseDigest: digest(8),
    tokens: [token],
  };
  return { request, control, receipt, token, finalize };
}

function objectIdentity(seed, contentSha256, mode = 0o600) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(1000 + seed),
    ino: String(2000 + seed),
    uid: 501,
    mode,
    nlink: 1,
    size: String(3000 + seed),
    mtimeNs: String(4000 + seed),
    ctimeNs: String(5000 + seed),
    contentSha256,
  };
}

function publicationResult(request = createRequest(), identityOffset = 0) {
  return {
    schema: schema.SCHEMAS.CREATE_PUBLICATION_RESULT,
    operationId: request.operationId,
    requestDigest: schema.createRequestDigest(request),
    items: request.items.map((item, index) => {
      const control = schema.buildControl(request, index);
      const created = objectIdentity(identityOffset + index * 3 + 1, item.contentDigest, 0o644);
      const receipt = schema.buildReceipt(control, evidence.digestObjectIdentity(created));
      return {
        selectedId: item.selectedId,
        createdLeafIdentity: created,
        controlRecordIdentity: objectIdentity(
          identityOffset + index * 3 + 2,
          evidence.sha256(schema.encodeControlRecord(control))
        ),
        receiptRecordIdentity: objectIdentity(
          identityOffset + index * 3 + 3,
          evidence.sha256(schema.encodeReceiptRecord(receipt, control))
        ),
      };
    }),
  };
}

function journalAuthorityFixture(request = createRequest()) {
  const prepared = schema.buildLatchedCreatePublication(request);
  const activeMarker = {
    schema: 'writcraft.changes-history-recovery/v1',
    operationId: request.operationId,
    projectId: 'project-create-journal',
    kind: 'snapshot_restore',
    state: 'applying',
    outcome: null,
    files: [],
    baseHistoryState: { exists: true, digest: '1'.repeat(64) },
    preparedHistoryState: { exists: true, digest: '2'.repeat(64) },
    recoveryWritePending: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:01.000Z',
    integrity: '3'.repeat(64),
  };
  const value = {
    schema: journal.SCHEMAS.VALUE,
    journalId: `chrj_${'d'.repeat(48)}`,
    generation: '1',
    previousValueDigest: digest(4),
    state: 'ACTIVE',
    projectId: activeMarker.projectId,
    activeOperationId: request.operationId,
    activeKind: 'snapshot_restore',
    activeMarker,
    activeMarkerDigest: journal.activeMarkerDigest(activeMarker),
    nativePublication: prepared,
    existingTerminalPublication: null,
    terminalCleanup: null,
    terminalCleanupDigest: null,
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  const validValue = journal.assertJournalValue(value);
  return {
    value: validValue,
    authority: schema.buildCreateJournalAuthority(request, validValue),
  };
}

function invalid(fn) {
  assert.throws(fn, error => error?.code === 'PUBLIC_MARKDOWN_NATIVE_PROTOCOL');
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nPrivate public-Markdown native schema verification');

assert.strictEqual(typeof schema.createRequestDigest, 'function');
assert.strictEqual(typeof schema.buildPreparedCreatePublication, 'function');
assert.strictEqual(typeof schema.createAttemptDigest, 'function');
assert.strictEqual(typeof schema.buildLatchedCreatePublication, 'function');
assert.strictEqual(typeof schema.assertLatchedCreatePublication, 'function');
assert.strictEqual(typeof schema.buildCreateCapture, 'function');
assert.strictEqual(typeof schema.assertStoredCreateCapture, 'function');
assert.strictEqual(typeof schema.buildPreparedCreateFinalization, 'function');
assert.strictEqual(typeof schema.buildCapturedCreateFinalization, 'function');
assert.strictEqual(typeof schema.assertStoredCreateFinalization, 'function');
assert.strictEqual(typeof schema.buildCreateJournalAuthority, 'function');
assert.strictEqual(typeof schema.buildCreateJournalPhysicalBinding, 'function');
assert.strictEqual(typeof schema.assertCreateJournalPhysicalBinding, 'function');
assert.strictEqual(typeof schema.encodeCreateMissingJournalCommand, 'function');
assert.strictEqual(typeof schema.encodeCreateMissingJournalResponse, 'function');
assert.strictEqual(typeof schema.parseCreateMissingJournalResponse, 'function');
assert.strictEqual(typeof schema.parseCreateMissingJournalCommand, 'function');
assert.strictEqual(typeof schema.verifyCreateMissingJournalPhysicalAuthority, 'function');

test('CREATE_MISSING domain authority has independent request/publication/capture goldens', () => {
  const request = createRequest();
  const result = publicationResult(request);
  const prepared = schema.buildPreparedCreatePublication(request);
  const latched = schema.buildLatchedCreatePublication(request);
  const capture = schema.buildCreateCapture(request, result);
  assert.deepStrictEqual(schema.assertPreparedCreatePublication(prepared, request), prepared);
  assert.deepStrictEqual(schema.assertLatchedCreatePublication(latched, request), latched);
  assert.deepStrictEqual(schema.assertCreatePublicationResult(result, request), result);
  invalid(() => schema.assertCreatePublicationResult({
    ...result,
    items: result.items.map((item, index) => index === 0
      ? {
        ...item,
        receiptRecordIdentity: {
          ...item.receiptRecordIdentity,
          dev: item.controlRecordIdentity.dev,
          ino: item.controlRecordIdentity.ino,
        },
      }
      : item),
  }, request));
  assert.deepStrictEqual(schema.assertStoredCreateCapture(capture, request), capture);
  assert.deepStrictEqual({
    requestDigest: schema.createRequestDigest(request),
    attemptDigest: schema.createAttemptDigest(request),
    publicationDigest: prepared.publicationDigest,
    latchedPublicationDigest: latched.publicationDigest,
    captureBytes: Buffer.byteLength(evidence.canonicalJson(capture), 'utf8'),
    captureSha256: crypto.createHash('sha256')
      .update(evidence.canonicalJson(capture), 'utf8').digest('hex'),
  }, {
    requestDigest: 'sha256:a4eb49e74303ca310180d08607345c81fe2cda354ed8839722d819603386a88d',
    attemptDigest: 'sha256:c628b97406036e329a3448369b58b62df24f72ddaa7305fafaa6b0d02fa6a706',
    publicationDigest: 'sha256:cb1290b8964f9850ad9e5e5a0c08266eb18380b06654681f3afd09961e267cde',
    latchedPublicationDigest: 'sha256:6bf30bf718023db0e6600285ce52da15533c29c3f40eb84fcde9b5de8622e1c3',
    captureBytes: 2736,
    captureSha256: '9be5266d9c0001ecf13a52cb3a8246a0d772d0ef596fde7cb1e49d13e491c2e7',
  });
});

test('CREATE_MISSING domain rejects cross-request, order, descriptor and persisted inode drift', () => {
  const request = createRequest();
  const result = publicationResult(request);
  const capture = schema.buildCreateCapture(request, result);
  invalid(() => schema.assertCreatePublicationResult({
    ...result,
    requestDigest: digest(9),
  }, request));
  invalid(() => schema.assertCreatePublicationResult({ ...result, items: [] }, request));
  const latched = schema.buildLatchedCreatePublication(request);
  const forgedLatch = {
    ...latched,
    createAttemptDigest: digest(9),
    publicationDigest: null,
  };
  forgedLatch.publicationDigest = journal.publicationDigest(forgedLatch);
  invalid(() => schema.assertLatchedCreatePublication(forgedLatch, request));
  invalid(() => schema.assertLatchedCreatePublication(
    latched,
    { ...request, selectionDigest: digest(8) }
  ));
  let getterCalls = 0;
  const hostile = { ...result };
  Object.defineProperty(hostile, 'items', {
    enumerable: true,
    get() { getterCalls += 1; return result.items; },
  });
  invalid(() => schema.assertCreatePublicationResult(hostile, request));
  assert.strictEqual(getterCalls, 0);
  const replacementCapture = schema.buildCreateCapture(request, publicationResult(request, 100));
  const prepared = schema.buildLatchedCreatePublication(request);
  const armed = {
    ...prepared,
    state: 'ARMED',
    previousPublicationDigest: prepared.publicationDigest,
    createCapture: capture,
    publicationDigest: null,
  };
  armed.publicationDigest = journal.publicationDigest(armed);
  const validArmed = journal.assertPublication(armed);
  const foreignCommit = {
    ...validArmed,
    state: 'COMMITTED',
    previousPublicationDigest: validArmed.publicationDigest,
    createCapture: replacementCapture,
    publicationDigest: null,
  };
  foreignCommit.publicationDigest = journal.publicationDigest(foreignCommit);
  assert.throws(
    () => journal.assertPublicationTransition(validArmed, foreignCommit),
    error => error?.code === 'INVALID_CHANGES_HISTORY_MARKER_JOURNAL'
  );
  invalid(() => schema.assertStoredCreateCapture({
    ...capture,
    items: [{ ...capture.items[0], path: 'foreign.md' }],
  }, request));
});

test('CREATE_MISSING finalization seals PREPARED then exact CAPTURED record authority', () => {
  const artifactIdentity = {
    ...objectIdentity(90, digest(1)),
    size: '100',
  };
  const request = createRequest(null, {
    artifactIdentityDigest: evidence.digestObjectIdentity(artifactIdentity),
  });
  const capture = schema.buildCreateCapture(request, publicationResult(request));
  const latched = schema.buildLatchedCreatePublication(request);
  const armed = {
    ...latched,
    state: 'ARMED',
    previousPublicationDigest: latched.publicationDigest,
    createCapture: capture,
    publicationDigest: null,
  };
  armed.publicationDigest = journal.publicationDigest(armed);
  const validArmed = journal.assertPublicationTransition(latched, armed);
  const committed = {
    ...validArmed,
    state: 'COMMITTED',
    previousPublicationDigest: validArmed.publicationDigest,
    publicationDigest: null,
  };
  committed.publicationDigest = journal.publicationDigest(committed);
  const validCommitted = journal.assertPublicationTransition(validArmed, committed);
  const authority = {
    schema: schema.SCHEMAS.CREATE_FINALIZATION_AUTHORITY,
    createRequest: request,
    committedPublication: validCommitted,
    historyCommittedPhaseDigest: digest(8),
    rawPreparedHistoryStateDigest: digest(9),
    artifactIdentity,
  };
  const prepared = schema.buildPreparedCreateFinalization(authority);
  const finalBytes = schema.encodeFinalAckRecord(
    prepared.finalAck,
    prepared.finalizeRequest,
    request
  );
  const finalIdentity = {
    ...objectIdentity(91, evidence.sha256(finalBytes)),
    size: String(finalBytes.length),
  };
  const captured = schema.buildCapturedCreateFinalization(authority, finalIdentity);
  assert.deepStrictEqual(schema.assertStoredCreateFinalization(prepared, authority), prepared);
  assert.deepStrictEqual(schema.assertStoredCreateFinalization(captured, authority), captured);
  const cleanup = schema.buildCreateCleanupAuthority(authority, finalIdentity);
  assert.deepStrictEqual(schema.assertCreateCleanupAuthority(cleanup, authority), cleanup);
  assert.deepStrictEqual(cleanup.finalRecordIdentity, finalIdentity);
  invalid(() => schema.assertCreateCleanupAuthority({
    ...cleanup,
    finalRecordIdentity: { ...finalIdentity, contentSha256: digest(77) },
  }, authority));
  assert.strictEqual(cleanup.items.length, 2);
  assert(cleanup.items.every(item => schema.CREATE_CLEANUP_BASENAME_RE.test(
    item.cleanupBasename
  )));
  assert.strictEqual(new Set([
    ...cleanup.items.map(item => item.sourceBasename),
    cleanup.finalBasename,
    ...cleanup.items.map(item => item.cleanupBasename),
  ]).size, 5);
  assert.deepStrictEqual(cleanup.items.map(item => item.cleanupBasename), [
    '.changes-history-native-create-cleanup.9878a7baf91a5b489e586f552cbebb97c02e4e396ec2751d1d175367ed1029a0',
    '.changes-history-native-create-cleanup.3a31a5b83e930dfa9143a9f7b145c57ccd830d93c8cb1ed853d88c0b16ab2fe7',
  ]);
  assert.deepStrictEqual({
    authorityDigest: cleanup.authorityDigest,
    itemDigests: cleanup.items.map(item => item.itemDigest),
  }, {
    authorityDigest: 'sha256:9bd0cc6c6408bd73f2151949acb9317ea5372e4e1d4e035113a653b50523f62c',
    itemDigests: [
      'sha256:e7410b976de3888bdd349c55790e072d1fd4f419dc5faeb8d5d6fa12e357a177',
      'sha256:fa62122a5b4059fe061a0b94e7f6ba5ef90461c40a4825dc545d71b060783691',
    ],
  });
  invalid(() => schema.assertCreateCleanupAuthority({
    ...cleanup,
    items: cleanup.items.map((item, index) => index === 0
      ? { ...item, cleanupBasename: item.sourceBasename }
      : item),
  }, authority));
  const cleanupResult = (command, state, items = [], errorCode = null) => ({
    schema: schema.SCHEMAS.CREATE_CLEANUP_RESULT,
    command,
    state,
    operationId: cleanup.operationId,
    authorityDigest: cleanup.authorityDigest,
    items,
    errorCode,
  });
  const movedItems = cleanup.items.map(item => ({
    schema: schema.SCHEMAS.CREATE_CLEANUP_RESULT_ITEM,
    ordinal: item.ordinal,
    cleanupBasename: item.cleanupBasename,
    cleanupIdentity: {
      ...item.recordIdentity,
      ctimeNs: String(BigInt(item.recordIdentity.ctimeNs) + 1n),
    },
  }));
  for (const [command, state, items, errorCode] of [
    [schema.CREATE_CLEANUP_COMMANDS.CLEANUP, 'UNCOMMITTED', [], null],
    [schema.CREATE_CLEANUP_COMMANDS.CLEANUP, 'COMMITTED', movedItems, null],
    [schema.CREATE_CLEANUP_COMMANDS.RECONCILE, 'COMMITTED', movedItems, null],
    [schema.CREATE_CLEANUP_COMMANDS.RECONCILE, 'UNKNOWN', [],
      'PUBLIC_MARKDOWN_NATIVE_UNKNOWN'],
    [schema.CREATE_CLEANUP_COMMANDS.ACK, 'ACKED', [], null],
    [schema.CREATE_CLEANUP_COMMANDS.ACK, 'UNKNOWN', [],
      'PUBLIC_MARKDOWN_NATIVE_UNKNOWN'],
  ]) {
    assert.deepStrictEqual(
      schema.assertCreateCleanupResult(
        cleanupResult(command, state, items, errorCode), cleanup, command
      ),
      cleanupResult(command, state, items, errorCode)
    );
  }
  const commandLetters = [
    [schema.CREATE_CLEANUP_COMMANDS.CLEANUP, 'G'],
    [schema.CREATE_CLEANUP_COMMANDS.RECONCILE, 'R'],
    [schema.CREATE_CLEANUP_COMMANDS.ACK, 'A'],
  ];
  for (const [command, letter] of commandLetters) {
    assert(schema.encodeCreateCleanupCommand(command, cleanup).startsWith(
      `${letter}\tCREATE_CLEANUP\t${cleanup.operationId}\t`
    ));
  }
  const committedWire = [
    'P\tOK',
    [
      'R', 'OK', 'COMMITTED', cleanup.operationId, cleanup.authorityDigest,
      String(movedItems.length), '-',
    ].join('\t'),
    ...movedItems.map(item => {
      const identity = item.cleanupIdentity;
      return [
        'K', String(item.ordinal), item.cleanupBasename,
        identity.dev, identity.ino, String(identity.uid), String(identity.mode),
        String(identity.nlink), identity.size, identity.mtimeNs, identity.ctimeNs,
        identity.contentSha256,
      ].join('\t');
    }),
  ].join('\n') + '\n';
  assert.deepStrictEqual(
    schema.parseCreateCleanupResult(
      committedWire,
      Buffer.alloc(0),
      cleanup,
      schema.CREATE_CLEANUP_COMMANDS.RECONCILE
    ),
    cleanupResult(schema.CREATE_CLEANUP_COMMANDS.RECONCILE, 'COMMITTED', movedItems, null)
  );
  invalid(() => schema.assertCreateCleanupResult(
    cleanupResult(schema.CREATE_CLEANUP_COMMANDS.ACK, 'COMMITTED', movedItems, null),
    cleanup,
    schema.CREATE_CLEANUP_COMMANDS.ACK
  ));
  assert.deepStrictEqual({
    preparedDigest: prepared.finalizationDigest,
    capturedDigest: captured.finalizationDigest,
    finalBasename: prepared.finalBasename,
    finalBytes: finalBytes.length,
  }, {
    preparedDigest: 'sha256:2ac6f559edc4c1cd5bef07f36a394e25243b1d1c73bb6f4f12e9ccd3a0e39f2c',
    capturedDigest: 'sha256:9cf41b6507ba2bedf6ed685ee8e2f6df88cdc815a952d066ab2c803f9f99ede4',
    finalBasename: '.changes-history-native-create-final.71efaed4a226dd3edf1fb872b9a5c92b04ff09cb528f929d09bf26a257c892ff',
    finalBytes: 470,
  });
  const finalPreparedPublication = {
    ...validCommitted,
    previousPublicationDigest: validCommitted.publicationDigest,
    createFinalization: prepared,
    publicationDigest: null,
  };
  finalPreparedPublication.publicationDigest = journal.publicationDigest(
    finalPreparedPublication
  );
  const withPrepared = journal.assertPublicationTransition(
    validCommitted,
    finalPreparedPublication
  );
  const finalCapturedPublication = {
    ...withPrepared,
    previousPublicationDigest: withPrepared.publicationDigest,
    createFinalization: captured,
    publicationDigest: null,
  };
  finalCapturedPublication.publicationDigest = journal.publicationDigest(
    finalCapturedPublication
  );
  assert.strictEqual(journal.assertPublicationTransition(
    withPrepared,
    finalCapturedPublication
  ).createFinalization.state, 'CAPTURED');
  invalid(() => schema.assertStoredCreateFinalization({
    ...captured,
    rawPreparedHistoryStateDigest: digest(7),
  }, authority));
  invalid(() => schema.assertStoredCreateFinalization({
    ...captured,
    finalRecordIdentity: { ...finalIdentity, ino: '999999' },
  }, authority));
  let getterCalls = 0;
  const hostile = { ...prepared };
  Object.defineProperty(hostile, 'finalAck', {
    enumerable: true,
    get() { getterCalls += 1; return prepared.finalAck; },
  });
  invalid(() => schema.assertStoredCreateFinalization(hostile, authority));
  assert.strictEqual(getterCalls, 0);
});

test('CREATE_MISSING current-head authority and wire bind exact ACTIVE PREPARED truth', () => {
  const request = createRequest();
  const fixture = journalAuthorityFixture(request);
  const authority = schema.assertCreateJournalAuthority(
    fixture.authority,
    request,
    fixture.value
  );
  const token = schema.buildCreateJournalCommandToken(
    authority,
    request,
    fixture.value
  );
  const wire = schema.encodeCreateMissingJournalCommand(
    authority,
    request,
    fixture.value
  );
  assert.deepStrictEqual(schema.parseCreateMissingJournalCommand(wire), authority);
  const frame = journal.encodeSlotFrame(fixture.value, 'B');
  assert.deepStrictEqual(schema.verifyCreateMissingJournalPhysicalAuthority(
    wire,
    frame
  ), authority);
  const changedFrame = Buffer.from(frame);
  changedFrame[authority.journalPhysicalBinding.activeMarkerOffset +
    frame.indexOf(0x0a) + 1] ^= 0x01;
  invalid(() => schema.verifyCreateMissingJournalPhysicalAuthority(wire, changedFrame));
  assert(!wire.includes('chapter.md'));
  assert(wire.includes(Buffer.from('chapter.md', 'utf8').toString('hex')));
  const result = publicationResult(request);
  const response = {
    schema: schema.SCHEMAS.CREATE_JOURNAL_RESPONSE,
    command: 'CREATE_MISSING',
    state: 'COMMITTED',
    operationId,
    commandDigest: token.commandDigest,
    publicationResult: result,
    errorCode: null,
  };
  assert.strictEqual(schema.assertCreateMissingJournalResponse(
    response,
    authority,
    request,
    fixture.value
  ).state, 'COMMITTED');
  const envelope = schema.encodeCreateMissingJournalResponse(
    response, authority, request, fixture.value
  );
  assert.strictEqual(schema.parseCreateMissingJournalResponse(
    envelope, Buffer.alloc(0), authority, request, fixture.value
  ).state, 'COMMITTED');
  invalid(() => schema.parseCreateMissingJournalResponse(
    envelope, Buffer.from('fatal'), authority, request, fixture.value
  ));
  invalid(() => schema.parseCreateMissingJournalResponse(
    Buffer.concat([envelope, Buffer.from('x')]), Buffer.alloc(0),
    authority, request, fixture.value
  ));
  invalid(() => schema.parseCreateMissingJournalResponse(
    envelope.subarray(0, -1), Buffer.alloc(0),
    authority, request, fixture.value
  ));
  invalid(() => schema.parseCreateMissingJournalResponse(
    Buffer.from([0xc3, 0x28, 0x0a]), Buffer.alloc(0),
    authority, request, fixture.value
  ));
  invalid(() => schema.parseCreateMissingJournalResponse(
    Buffer.concat([envelope.subarray(0, 5), Buffer.from([0]), envelope.subarray(6)]),
    Buffer.alloc(0), authority, request, fixture.value
  ));
  invalid(() => schema.parseCreateMissingJournalResponse(
    Buffer.alloc(schema.LIMITS.maxCreateJournalResponseBytes + 1, 0x61),
    Buffer.alloc(0), authority, request, fixture.value
  ));
  assert.deepStrictEqual({
    wireBytes: Buffer.byteLength(wire, 'utf8'),
    wireSha256: crypto.createHash('sha256').update(wire, 'utf8').digest('hex'),
    commandDigest: token.commandDigest,
  }, {
    wireBytes: 1656,
    wireSha256: 'bbbacfb453c8538a74497a8525061ed883c30ff07fcfacb72b322216dd9cdd1d',
    commandDigest: 'sha256:44e14be5a732ac69d6490dc3dfcbd072a1c3620b7a4fc0e724295e2d4a76f948',
  });
  const mutateHeader = (source, transform) => {
    const lines = source.trimEnd().split('\n');
    const fields = lines[0].split('\t');
    transform(fields);
    return `${[fields.join('\t'), ...lines.slice(1)].join('\n')}\n`;
  };
  const rebuildSelfConsistentWire = changes => {
    const lines = wire.trimEnd().split('\n');
    const fields = lines[0].split('\t');
    const changedRequest = {
      ...request,
      ...(changes.request || {}),
    };
    const changedPublication = schema.buildLatchedCreatePublication(changedRequest);
    const changedBinding = JSON.parse(JSON.stringify(authority.journalPhysicalBinding));
    changedBinding.operationId = changedRequest.operationId;
    if (changes.projectId !== undefined) changedBinding.projectId = changes.projectId;
    if (changes.kind !== undefined) changedBinding.kind = changes.kind;
    const slices = JSON.parse(JSON.stringify(authority.currentPayloadSlices));
    const expectedSlices = {
      activeOperationId: changedRequest.operationId,
      projectId: changedBinding.projectId,
      activeKind: changedBinding.kind,
      nativePublication: changedPublication,
      activeMarkerDigest: changedBinding.activeMarkerDigest,
    };
    for (const key of Object.keys(expectedSlices)) {
      const bytes = Buffer.from(evidence.canonicalJson(expectedSlices[key]), 'utf8');
      slices[key].byteLength = bytes.length;
      slices[key].rawSha256 = evidence.sha256(bytes);
    }
    if (changes.slices) changes.slices(slices, changedBinding);
    const bindingDigest = evidence.digestObject(
      schema.SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING,
      changedBinding
    );
    const currentPayloadSlicesDigest = evidence.digestObject(
      schema.SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES,
      slices
    );
    const tokenValue = {
      schema: schema.SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN,
      command: 'CREATE_MISSING',
      operationId: changedRequest.operationId,
      requestDigest: schema.createRequestDigest(changedRequest),
      preparedPublicationDigest: changedPublication.publicationDigest,
      bindingDigest,
      currentPayloadSlicesDigest,
      commandDigest: null,
    };
    tokenValue.commandDigest = evidence.digestObject(
      schema.SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN,
      tokenValue,
      'commandDigest'
    );
    fields[2] = tokenValue.commandDigest;
    fields[3] = changedRequest.operationId;
    fields[4] = Buffer.from(changedBinding.projectId, 'utf8').toString('hex');
    fields[5] = changedBinding.kind;
    fields[6] = tokenValue.requestDigest;
    fields[7] = changedPublication.publicationDigest;
    fields[8] = bindingDigest;
    fields[19] = changedBinding.activeMarkerDigest;
    fields[20] = changedRequest.artifactDigest;
    fields[21] = changedRequest.artifactIdentityDigest;
    fields[22] = String(changedRequest.artifactByteLength);
    fields[23] = changedRequest.precreatePhaseDigest;
    fields[24] = changedRequest.selectionDigest;
    [
      'activeOperationId', 'projectId', 'activeKind', 'nativePublication', 'activeMarkerDigest',
    ]
      .forEach((key, index) => {
        const offset = 26 + (index * 3);
        fields[offset] = String(slices[key].offset);
        fields[offset + 1] = String(slices[key].byteLength);
        fields[offset + 2] = slices[key].rawSha256;
      });
    return `${[fields.join('\t'), ...lines.slice(1)].join('\n')}\n`;
  };
  const physicalRejects = hostile => invalid(() =>
    schema.verifyCreateMissingJournalPhysicalAuthority(
      hostile,
      frame
    ));
  const forgedProject = rebuildSelfConsistentWire({
    projectId: 'x'.repeat(Buffer.byteLength(fixture.value.projectId, 'utf8')),
  });
  assert.strictEqual(schema.parseCreateMissingJournalCommand(forgedProject).request.operationId,
    request.operationId);
  physicalRejects(forgedProject);
  const forgedOperation = rebuildSelfConsistentWire({
    request: { operationId: `chr_${'e'.repeat(48)}` },
  });
  assert.strictEqual(schema.parseCreateMissingJournalCommand(forgedOperation).request.operationId,
    `chr_${'e'.repeat(48)}`);
  physicalRejects(forgedOperation);
  const forgedPublication = rebuildSelfConsistentWire({
    request: { precreatePhaseDigest: digest(8) },
  });
  assert.strictEqual(schema.parseCreateMissingJournalCommand(forgedPublication)
    .request.precreatePhaseDigest, digest(8));
  physicalRejects(forgedPublication);
  const forgedDigestWire = rebuildSelfConsistentWire({
    slices(slices, binding) {
      binding.activeMarkerDigest = digest(9);
      const bytes = Buffer.from(evidence.canonicalJson(binding.activeMarkerDigest), 'utf8');
      slices.activeMarkerDigest.byteLength = bytes.length;
      slices.activeMarkerDigest.rawSha256 = evidence.sha256(bytes);
    },
  });
  assert.strictEqual(schema.parseCreateMissingJournalCommand(forgedDigestWire)
    .journalPhysicalBinding.activeMarkerDigest, digest(9));
  physicalRejects(forgedDigestWire);
  invalid(() => schema.parseCreateMissingJournalCommand(rebuildSelfConsistentWire({
    kind: 'snapshot_restore_undo',
  })));
  invalid(() => schema.parseCreateMissingJournalCommand(rebuildSelfConsistentWire({
    slices(slices, binding) {
      slices.projectId.offset = binding.activeMarkerOffset;
    },
  })));
  invalid(() => schema.parseCreateMissingJournalCommand(rebuildSelfConsistentWire({
    slices(slices, binding) {
      slices.projectId.offset = binding.payloadByteLength;
    },
  })));
  physicalRejects(rebuildSelfConsistentWire({
    slices(slices) { slices.projectId.rawSha256 = digest(9); },
  }));
  physicalRejects(rebuildSelfConsistentWire({
    slices(slices) { slices.projectId.offset += 1; },
  }));
  for (const hostile of [
    mutateHeader(wire, fields => fields.splice(4, 1)),
    mutateHeader(wire, fields => { fields[4] = Buffer.from('foreign', 'utf8').toString('hex'); }),
    mutateHeader(wire, fields => { fields[5] = 'snapshot_restore_undo'; }),
    mutateHeader(wire, fields => { fields[3] = `chr_${'f'.repeat(48)}`; }),
    mutateHeader(wire, fields => { fields[8] = digest(8); }),
    mutateHeader(wire, fields => { fields[2] = digest(7); }),
    mutateHeader(wire, fields => { [fields[6], fields[7]] = [fields[7], fields[6]]; }),
    `${wire}trailing`,
    mutateHeader(wire, fields => { fields[4] = '61'.repeat(8200); }),
  ]) invalid(() => schema.parseCreateMissingJournalCommand(hostile));
  invalid(() => schema.parseCreateMissingJournalCommand(Buffer.from([0xc3, 0x28, 0x0a])));
  invalid(() => schema.parseCreateMissingJournalCommand(Buffer.concat([
    Buffer.from(wire.slice(0, 5), 'utf8'), Buffer.from([0]), Buffer.from(wire.slice(6), 'utf8'),
  ])));
  let getterCalls = 0;
  const nonWire = {};
  Object.defineProperty(nonWire, 'toString', {
    get() { getterCalls += 1; return () => wire; },
  });
  invalid(() => schema.parseCreateMissingJournalCommand(nonWire));
  assert.strictEqual(getterCalls, 0);
  invalid(() => schema.buildCreateJournalAuthority(request, {
    ...fixture.value,
    nativePublication: null,
  }));
});

test('maximum 300-item publication result and capture retain frame and response budget', () => {
  const items = Array.from({ length: schema.LIMITS.maxItems }, (_, index) => ({
    selectedId: `m${String(index).padStart(3, '0')}${'x'.repeat(252)}`,
    path: `${'📚'.repeat(1000)}-${index}.md`,
    artifactOffset: index,
    byteLength: 1,
    contentDigest: digest((index % 9) + 1),
    ancestorIdentityDigest: digest(((index + 1) % 9) + 1),
  }));
  const request = createRequest(items, { artifactByteLength: items.length });
  let identityOrdinal = 0n;
  const maximumIdentity = identity => {
    identityOrdinal += 1n;
    return {
      ...identity,
      dev: String(18446744073709500000n + identityOrdinal),
      ino: String(18446744073709510000n + identityOrdinal),
      uid: 4294967295,
      size: '18446744073709551615',
      mtimeNs: String(18446744073709400000n + identityOrdinal),
      ctimeNs: String(18446744073709300000n + identityOrdinal),
    };
  };
  const result = {
    schema: schema.SCHEMAS.CREATE_PUBLICATION_RESULT,
    operationId,
    requestDigest: schema.createRequestDigest(request),
    items: request.items.map((item, index) => {
      const control = schema.buildControl(request, index);
      const createdLeafIdentity = maximumIdentity(
        objectIdentity(index * 3 + 1, item.contentDigest, 0o644)
      );
      const receipt = schema.buildReceipt(
        control,
        evidence.digestObjectIdentity(createdLeafIdentity)
      );
      return {
        selectedId: item.selectedId,
        createdLeafIdentity,
        controlRecordIdentity: maximumIdentity(objectIdentity(
          index * 3 + 2,
          evidence.sha256(schema.encodeControlRecord(control))
        )),
        receiptRecordIdentity: maximumIdentity(objectIdentity(
          index * 3 + 3,
          evidence.sha256(schema.encodeReceiptRecord(receipt, control))
        )),
      };
    }),
  };
  assert.deepStrictEqual(schema.assertCreatePublicationResult(result, request), result);
  const capture = schema.buildCreateCapture(request, result);
  const captureJson = evidence.canonicalJson(capture);
  const fixture = journalAuthorityFixture(request);
  const armedPublication = {
    ...fixture.authority.preparedPublication,
    state: 'ARMED',
    previousPublicationDigest: fixture.authority.preparedPublication.publicationDigest,
    createCapture: capture,
    publicationDigest: null,
  };
  armedPublication.publicationDigest = journal.publicationDigest(armedPublication);
  const armed = journal.assertPublication(armedPublication);
  const value = {
    ...fixture.value,
    generation: journal.nextGeneration(fixture.value.generation),
    previousValueDigest: fixture.value.valueDigest,
    nativePublication: armed,
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  const frame = journal.encodeSlotFrame(journal.assertJournalValue(value), 'A');
  const token = schema.buildCreateJournalCommandToken(
    fixture.authority, request, fixture.value
  );
  const response = {
    schema: schema.SCHEMAS.CREATE_JOURNAL_RESPONSE,
    command: 'CREATE_MISSING',
    state: 'COMMITTED',
    operationId,
    commandDigest: token.commandDigest,
    publicationResult: result,
    errorCode: null,
  };
  const responseEnvelope = schema.encodeCreateMissingJournalResponse(
    response, fixture.authority, request, fixture.value
  );
  assert.strictEqual(schema.parseCreateMissingJournalResponse(
    responseEnvelope, Buffer.alloc(0), fixture.authority,
    request, fixture.value
  ).publicationResult.items.length, 300);
  const responseBytes = responseEnvelope.length;
  assert.deepStrictEqual({
    captureBytes: Buffer.byteLength(captureJson, 'utf8'),
    captureSha256: crypto.createHash('sha256').update(captureJson, 'utf8').digest('hex'),
    frameBytes: frame.length,
    frameSha256: crypto.createHash('sha256').update(frame).digest('hex'),
    responseBytes,
  }, {
    captureBytes: 4697033,
    captureSha256: '1b035dbff6e0448074e259514a2bea2ad5e1c70af659d9db5c0a332f15654c90',
    frameBytes: 4699664,
    frameSha256: 'c9360828b9069e40a2a6d9c83ef01a971267637443f60a8cd8a9832a453cdd3f',
    responseBytes: 395434,
  });
  assert(frame.length < journal.MAX_FRAME_BYTES);
  assert(responseBytes > schema.LIMITS.maxResponseBytes);
  assert(responseBytes < schema.LIMITS.maxCreateJournalResponseBytes);
  invalid(() => schema.assertCreatePublicationResult({
    ...result,
    items: [...result.items, result.items[0]],
  }, request));
});

test('3.1.4 control/receipt/final digests and deterministic basenames match golden bytes', () => {
  const { request, control, receipt, finalize } = authority();
  assert.deepStrictEqual(schema.recordNames(request, 0), {
    controlBasename: '.changes-history-native-create-control.5c11e1bd70f86759950ef75b06907b535852265bc9cb2804f6148f25e32a326b',
    receiptBasename: '.changes-history-native-create-receipt.5c11e1bd70f86759950ef75b06907b535852265bc9cb2804f6148f25e32a326b',
  });
  assert.strictEqual(
    control.controlDigest,
    'sha256:b242c15a03eccb23655fab4e9086f474fb7a854fea53304d99c35e1ac5cc8a08'
  );
  assert.strictEqual(
    receipt.receiptDigest,
    'sha256:8b6d732aaddc693928b0254c59e91163f1d0cbd5638f5851a9227e6fe4ca53d8'
  );
  assert.strictEqual(
    schema.receiptSetDigest(finalize, request),
    'sha256:a250c1a385afd113ba2ed19e6bf94941f2b36b875b52dabc112f1abb9e62e724'
  );
  assert.strictEqual(
    schema.finalRecordName(finalize, request),
    '.changes-history-native-create-final.8377350152480d0dbd871c429bce4d8685012b633240ff8c160ac31673c8657f'
  );
  assert.strictEqual(
    schema.buildFinalAck(finalize, request).finalAckDigest,
    'sha256:7c8c8f4a7facf11d90df1ba945dd4454db595299fa20fdff741072ad23e4d5c3'
  );
});

test('root bind and create wire contain only path hex plus bounded digest authority', () => {
  const root = {
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: '/private/tmp/作者项目',
    expectedRootIdentityDigest: digest(1),
    expectedRecoveryIdentityDigest: digest(2),
  };
  const rootWire = schema.encodeRootBind(root);
  assert(!rootWire.includes(root.canonicalRoot));
  assert(rootWire.includes(Buffer.from(root.canonicalRoot, 'utf8').toString('hex')));
  const request = createRequest([{
    selectedId: 'unicode',
    path: '章节/😀.md',
    artifactOffset: 1,
    byteLength: 2,
    contentDigest: digest(5),
    ancestorIdentityDigest: digest(6),
  }]);
  const wire = schema.encodeCreateCommand('CREATE', request);
  assert(!wire.includes('章节/😀.md'));
  assert(wire.includes(Buffer.from('章节/😀.md', 'utf8').toString('hex')));
  assert.strictEqual(wire.split('\n').filter(Boolean).length, 2);
});

test('getter, extra, symbol, sparse and named-array attacks fail without invocation', () => {
  let getters = 0;
  const getter = createRequest();
  Object.defineProperty(getter, 'artifactDigest', {
    enumerable: true,
    get() { getters += 1; return digest(1); },
  });
  invalid(() => schema.assertCreateRequest(getter));
  assert.strictEqual(getters, 0);
  invalid(() => schema.assertCreateRequest({ ...createRequest(), extra: true }));
  const symbolic = createRequest();
  symbolic[Symbol('hidden')] = 1;
  invalid(() => schema.assertCreateRequest(symbolic));
  const sparse = createRequest();
  sparse.items = new Array(1);
  invalid(() => schema.assertCreateRequest(sparse));
  const named = createRequest();
  named.items.extra = true;
  invalid(() => schema.assertCreateRequest(named));
});

test('path, duplicate, overlap, offset, Unicode and digest drift fail closed', () => {
  const item = createRequest().items[0];
  invalid(() => schema.assertCreateRequest(createRequest([{ ...item, path: '../escape.md' }])));
  invalid(() => schema.assertCreateRequest(createRequest([{ ...item, path: `bad\ud800.md` }])));
  invalid(() => schema.assertCreateRequest(createRequest([item, { ...item, artifactOffset: 20 }])));
  invalid(() => schema.assertCreateRequest(createRequest([
    item,
    { ...item, selectedId: 'missing:2', path: 'two.md', artifactOffset: 12 },
  ])));
  invalid(() => schema.assertCreateRequest(createRequest([{ ...item, artifactOffset: 99, byteLength: 2 }])));
  const { control, receipt, finalize, request } = authority();
  invalid(() => schema.assertControl({ ...control, artifactOffset: 11 }));
  invalid(() => schema.assertReceipt({ ...receipt, contentDigest: digest(9) }, control));
  const ack = schema.buildFinalAck(finalize, request);
  invalid(() => schema.assertFinalAck({ ...ack, itemCount: 2 }, finalize, request));
});

test('result truth matrix requires complete ordered tokens only for COMMITTED', () => {
  const { request, token } = authority();
  const base = {
    schema: schema.SCHEMAS.RESULT,
    command: 'CREATE',
    state: 'COMMITTED',
    operationId,
    artifactDigest: request.artifactDigest,
    precreatePhaseDigest: request.precreatePhaseDigest,
    selectionDigest: request.selectionDigest,
    tokens: [token],
    errorCode: null,
  };
  assert.strictEqual(schema.assertResult(base, request, 'CREATE').state, 'COMMITTED');
  assert.strictEqual(schema.assertResult({
    ...base,
    command: 'RECONCILE',
    state: 'UNCOMMITTED',
    tokens: [],
  }, request, 'RECONCILE').state, 'UNCOMMITTED');
  assert.strictEqual(schema.assertResult({
    ...base,
    command: 'RECONCILE',
    state: 'UNKNOWN',
    tokens: [],
    errorCode: 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN',
  }, request, 'RECONCILE').state, 'UNKNOWN');
  invalid(() => schema.assertResult({ ...base, command: 'RECONCILE' }, request, 'CREATE'));
  invalid(() => schema.assertResult(base, request));
  invalid(() => schema.assertResult({ ...base, tokens: [] }, request, 'CREATE'));
  invalid(() => schema.assertResult({ ...base, state: 'UNCOMMITTED' }, request, 'CREATE'));
  invalid(() => schema.assertResult({
    ...base,
    errorCode: 'raw /private/tmp/secret',
  }, request, 'CREATE'));
  invalid(() => schema.assertResult({
    ...base,
    tokens: [{
      ...token,
      receiptBasename: `.changes-history-native-create-receipt.${'f'.repeat(64)}`,
    }],
  }, request, 'CREATE'));
  invalid(() => schema.assertResult({
    ...base,
    tokens: [{ ...token, receiptDigest: digest(9) }],
  }, request, 'CREATE'));
});

test('finalize binds the complete ordered token set and cannot acknowledge drift', () => {
  const { request, token, finalize } = authority();
  assert(schema.encodeFinalizeCommand(finalize, request).startsWith(`F\t${operationId}\t`));
  invalid(() => schema.assertFinalizeRequest(finalize));
  invalid(() => schema.encodeFinalizeCommand(finalize));
  invalid(() => schema.buildFinalAck(finalize));
  invalid(() => schema.assertFinalizeRequest({ ...finalize, tokens: [] }, request));
  invalid(() => schema.assertFinalizeRequest({
    ...finalize,
    tokens: [{ ...token, selectedId: 'other' }],
  }, request));
  invalid(() => schema.assertFinalizeRequest({
    ...finalize,
    tokens: [{
      ...token,
      receiptBasename: `.changes-history-native-create-receipt.${'f'.repeat(64)}`,
    }],
  }, request));
  invalid(() => schema.encodeFinalizeCommand({
    ...finalize,
    tokens: [{
      ...token,
      controlBasename: `.changes-history-native-create-control.${'f'.repeat(64)}`,
    }],
  }, request));
  const ack = schema.buildFinalAck(finalize, request);
  assert.deepStrictEqual(schema.assertFinalAck(ack, finalize, request), ack);
});

test('record encodings are exact LF-terminated and contain no Markdown body or output path', () => {
  const { request, control, receipt, finalize } = authority();
  const ack = schema.buildFinalAck(finalize, request);
  for (const wire of [
    schema.encodeControlRecord(control),
    schema.encodeReceiptRecord(receipt, control),
    schema.encodeFinalAckRecord(ack, finalize, request),
  ]) {
    assert(wire.endsWith('\n'));
    assert(!wire.includes('/private/tmp'));
    assert(!wire.includes('markdown body'));
    assert(!wire.includes('\0'));
  }
});

test('maximum 300-item Unicode request fits frozen wire budget', () => {
  const items = Array.from({ length: schema.LIMITS.maxItems }, (_, index) => ({
    selectedId: `missing:${index}`,
    path: `${'😀'.repeat(1000)}-${index}.md`,
    artifactOffset: index,
    byteLength: 1,
    contentDigest: digest((index % 9) + 1),
    ancestorIdentityDigest: digest(((index + 1) % 9) + 1),
  }));
  const request = createRequest(items, { artifactByteLength: items.length });
  const wire = schema.encodeCreateCommand('RECONCILE', request);
  assert(Buffer.byteLength(wire, 'utf8') < schema.LIMITS.maxRequestBytes);
  assert.strictEqual(wire.split('\n').filter(Boolean).length, 301);
});

test('untrusted response envelope rejects stderr, NUL, invalid UTF-8 and byte overflow', () => {
  assert.strictEqual(schema.assertResponseEnvelope(Buffer.from('P\tOK\n')), 'P\tOK\n');
  invalid(() => schema.assertResponseEnvelope(Buffer.from('P\tOK\n'), Buffer.from('/secret')));
  invalid(() => schema.assertResponseEnvelope(Buffer.from('P\0OK\n')));
  invalid(() => schema.assertResponseEnvelope(Buffer.from([0xc3, 0x28, 0x0a])));
  invalid(() => schema.assertResponseEnvelope(Buffer.alloc(schema.LIMITS.maxResponseBytes + 1, 0x61)));
});

console.log(`\n${passed}/14 Private public-Markdown native schema checks passed.`);
