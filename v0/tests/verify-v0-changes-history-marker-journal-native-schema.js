#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const evidence = require('../src/main/evidence-delivery-schema');
const native = require('../src/main/changes-history-marker-journal-native-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');

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

function sha(raw) {
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function initialValue() {
  const value = {
    schema: journal.SCHEMAS.VALUE,
    journalId,
    generation: '0',
    previousValueDigest: null,
    state: 'IDLE',
    projectId: 'project-native-wire',
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
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function active(previous) {
  const activeMarker = markerFixture(previous.projectId);
  const value = {
    ...previous,
    generation: journal.nextGeneration(previous.generation),
    previousValueDigest: previous.valueDigest,
    state: 'ACTIVE',
    activeOperationId: operationId,
    activeKind: 'snapshot_restore_undo',
    activeMarker,
    activeMarkerDigest: journal.activeMarkerDigest(activeMarker),
    valueDigest: null,
  };
  value.valueDigest = journal.valueDigest(value);
  return journal.assertJournalValue(value);
}

function request(schema, command, fields) {
  return { schema, command, ...fields };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('\nChanges/History native permanent-journal wire verification');

test('private API freezes physical and transport budgets', () => {
  assert.strictEqual(native.MAX_PHYSICAL_JOURNAL_BYTES, 201327618);
  assert.strictEqual(native.MAX_COMMAND_BYTES, 100664833);
  assert.strictEqual(native.MAX_RESULT_BYTES, 100664320);
  for (const name of [
    'encodeDiscoverCommand', 'encodeDiscoverResult', 'parseDiscoverResult',
    'encodeInitCommand', 'encodeReadCommand', 'encodeAppendCommand', 'parseCommand',
    'encodeResult', 'parseResult', 'encodeError', 'parseError', 'classifyFreshRead',
  ]) assert.strictEqual(typeof native[name], 'function');
});

test('small INIT, READ and APPEND commands have independent byte and SHA goldens', () => {
  const initial = initialValue();
  const next = active(initial);
  const init = native.encodeInitCommand(request(native.SCHEMAS.INIT, 'INIT', { initialValue: initial }));
  const read = native.encodeReadCommand(request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
  }));
  const append = native.encodeAppendCommand(request(native.SCHEMAS.APPEND, 'APPEND', {
    previousValue: initial,
    nextValue: next,
  }));
  assert.deepStrictEqual(
    [init.length, sha(init), read.length, sha(read), append.length, sha(append)],
    [
      1053, 'sha256:9c129be765b5cb094ad439ccfd26bbe06cb402e0dfa85612d78e8d298ea88834',
      344, 'sha256:aba3332ca717570c3d4ee9d5e54302bbd7350efd62f73141a644c4de99074c6f',
      2289, 'sha256:a29c9ba9a090523d1ae9eea891281bd1e5775f7e1bdf5f5e00da89e31e3a4538',
    ]
  );
  const parsedInit = native.parseCommand(init);
  const parsedRead = native.parseCommand(read);
  const parsedAppend = native.parseCommand(append);
  assert.strictEqual(parsedInit.command, 'INIT');
  assert.strictEqual(parsedInit.frame.slot, 'A');
  assert.strictEqual(parsedRead.expectedHeads.length, 2);
  assert.strictEqual(parsedAppend.command, 'APPEND');
  assert.strictEqual(parsedAppend.frame.slot, 'B');
  const readAuthority = native.assertRequestAuthority(request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
  }), 'READ');
  assert.strictEqual(readAuthority.requestDigest, evidence.digestObject(
    native.SCHEMAS.REQUEST_AUTHORITY,
    {
      schema: native.SCHEMAS.REQUEST_AUTHORITY,
      command: 'READ',
      expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
      nextFrameSha256: null,
    }
  ));
  const forgedDigest = Buffer.from(init);
  const digestOffset = forgedDigest.indexOf(Buffer.from('sha256:', 'utf8')) + 'sha256:'.length;
  forgedDigest[digestOffset] = forgedDigest[digestOffset] === 0x30 ? 0x31 : 0x30;
  assert.throws(() => native.parseCommand(forgedDigest), native.ChangesHistoryMarkerJournalNativeSchemaError);
});

test('DISCOVER freezes one empty request and BASE or two-step PAIR restart authority', () => {
  const initial = initialValue();
  const next = active(initial);
  const discoverRequest = request(native.SCHEMAS.DISCOVER, 'DISCOVER', {});
  const command = native.encodeDiscoverCommand(discoverRequest);
  const authority = native.assertRequestAuthority(discoverRequest, 'DISCOVER');
  assert.deepStrictEqual(authority.expectedHeads, []);
  assert.strictEqual(authority.requestDigest, evidence.digestObject(
    native.SCHEMAS.REQUEST_AUTHORITY,
    {
      schema: native.SCHEMAS.REQUEST_AUTHORITY,
      command: 'DISCOVER',
      expectedHeads: [],
      nextFrameSha256: null,
    }
  ));
  assert.deepStrictEqual(native.parseCommand(command), {
    command: 'DISCOVER',
    requestDigest: authority.requestDigest,
    expectedHeads: [],
  });

  const baseRaw = {
    schema: native.SCHEMAS.RESULT,
    command: 'DISCOVER',
    status: 'BASE',
    olderSlot: 'A',
    olderHead: journal.expectedHead(initial),
    olderPreviousValueDigest: null,
    olderValue: initial,
    newerSlot: null,
    newerHead: null,
    newerPreviousValueDigest: null,
  };
  const pairRaw = {
    ...baseRaw,
    status: 'PAIR',
    newerSlot: 'B',
    newerHead: journal.expectedHead(next),
    newerPreviousValueDigest: initial.valueDigest,
  };
  const baseBytes = native.encodeDiscoverResult(baseRaw, discoverRequest);
  const pairBytes = native.encodeDiscoverResult(pairRaw, discoverRequest);
  assert.deepStrictEqual(
    [command.length, sha(command), baseBytes.length, sha(baseBytes), pairBytes.length, sha(pairBytes)],
    [
      90, 'sha256:8f982bd5c5070ec6b699da4f8e4e822c6c94e4851fabef923a436cbd3c1104a3',
      859, 'sha256:60dee96b41f04984bae15af028dffa86b3705d6f46be2b2540b54701549441cf',
      1051, 'sha256:9f55362319ac718fb17d9ed892628a81e65e8cc5302ac15288b96f83526b1345',
    ]
  );
  const base = native.parseDiscoverResult(baseBytes, discoverRequest);
  const pair = native.parseDiscoverResult(pairBytes, discoverRequest);
  assert.strictEqual(base.status, 'BASE');
  assert.deepStrictEqual(base.olderValue, initial);
  assert.strictEqual(pair.status, 'PAIR');
  assert.deepStrictEqual(pair.olderValue, initial);
  assert.deepStrictEqual(pair.newerHead, journal.expectedHead(next));

  const readRequest = request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [pair.olderHead, pair.newerHead],
  });
  const newer = native.parseResult(native.encodeResult({
    schema: native.SCHEMAS.RESULT,
    command: 'READ',
    status: 'VALUE',
    value: next,
  }, readRequest), readRequest, 'READ');
  assert.deepStrictEqual(journal.assertTransition(pair.olderValue, newer.value), next);
});

test('DISCOVER empty truth, cross-request and physical predecessor hostiles fail closed', () => {
  const initial = initialValue();
  const next = active(initial);
  const discoverRequest = request(native.SCHEMAS.DISCOVER, 'DISCOVER', {});
  const empty = status => ({
    schema: native.SCHEMAS.RESULT,
    command: 'DISCOVER',
    status,
    olderSlot: null,
    olderHead: null,
    olderPreviousValueDigest: null,
    olderValue: null,
    newerSlot: null,
    newerHead: null,
    newerPreviousValueDigest: null,
  });
  for (const status of ['ABSENT', 'LEGACY', 'UNKNOWN']) {
    const bytes = native.encodeDiscoverResult(empty(status), discoverRequest);
    assert.strictEqual(native.parseDiscoverResult(bytes, discoverRequest).status, status);
  }
  const pair = {
    ...empty('PAIR'),
    olderSlot: 'A',
    olderHead: journal.expectedHead(initial),
    olderPreviousValueDigest: null,
    olderValue: initial,
    newerSlot: 'B',
    newerHead: journal.expectedHead(next),
    newerPreviousValueDigest: initial.valueDigest,
  };
  const bytes = native.encodeDiscoverResult(pair, discoverRequest);
  assert.throws(() => native.parseDiscoverResult(
    bytes,
    request(native.SCHEMAS.INIT, 'INIT', { initialValue: initial })
  ), native.ChangesHistoryMarkerJournalNativeSchemaError);
  for (const hostile of [
    { ...pair, newerPreviousValueDigest: `sha256:${'9'.repeat(64)}` },
    { ...pair, newerSlot: 'A' },
    { ...pair, olderSlot: 'B' },
    { ...pair, newerHead: journal.expectedHead(initial) },
  ]) assert.throws(
    () => native.encodeDiscoverResult(hostile, discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  let getterCalls = 0;
  const getter = { ...pair };
  Object.defineProperty(getter, 'olderValue', {
    enumerable: true,
    get() { getterCalls += 1; return initial; },
  });
  assert.throws(
    () => native.encodeDiscoverResult(getter, discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.strictEqual(getterCalls, 0);
  let nestedGetterCalls = 0;
  const nestedHead = {};
  for (const [key, value] of Object.entries(journal.expectedHead(initial))) {
    if (key === 'generation') {
      Object.defineProperty(nestedHead, key, {
        enumerable: true,
        get() { nestedGetterCalls += 1; return value; },
      });
    } else nestedHead[key] = value;
  }
  assert.throws(
    () => native.encodeDiscoverResult({ ...pair, olderHead: nestedHead }, discoverRequest),
    /descriptor|invalid/u
  );
  assert.strictEqual(nestedGetterCalls, 0);
  assert.throws(
    () => native.encodeDiscoverResult({ ...pair, extra: true }, discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(
    () => native.parseDiscoverResult(Buffer.concat([bytes, Buffer.from('x')]), discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const nul = Buffer.from(bytes);
  nul[1] = 0;
  assert.throws(() => native.parseDiscoverResult(nul, discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError);
  const invalidUtf8 = Buffer.from(bytes);
  invalidUtf8[1] = 0xff;
  assert.throws(() => native.parseDiscoverResult(invalidUtf8, discoverRequest),
    native.ChangesHistoryMarkerJournalNativeSchemaError);
});

test('neutral VALUE returns canonical bytes while native IDLE or ACTIVE claims are rejected', () => {
  const initial = initialValue();
  const next = active(initial);
  const requests = {
    INIT: request(native.SCHEMAS.INIT, 'INIT', { initialValue: initial }),
    READ: request(native.SCHEMAS.READ, 'READ', {
      expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
    }),
    APPEND: request(native.SCHEMAS.APPEND, 'APPEND', {
      previousValue: initial, nextValue: next,
    }),
  };
  for (const [command, status, value] of [
    ['INIT', 'VALUE', initial],
    ['READ', 'VALUE', next],
    ['READ', 'LEGACY', null],
    ['APPEND', 'UNKNOWN', null],
  ]) {
    const bytes = native.encodeResult(
      { schema: native.SCHEMAS.RESULT, command, status, value },
      requests[command]
    );
    const parsed = native.parseResult(bytes, requests[command], command);
    assert.strictEqual(parsed.status, status);
    assert.deepStrictEqual(parsed.value, value);
  }
  const activeResult = native.encodeResult({
    schema: native.SCHEMAS.RESULT,
    command: 'READ',
    status: 'VALUE',
    value: next,
  }, requests.READ);
  for (const forgedStatus of ['IDLE', 'ACTIVE']) {
    assert.throws(() => native.encodeResult({
      schema: native.SCHEMAS.RESULT,
      command: 'READ',
      status: forgedStatus,
      value: next,
    }, requests.READ), native.ChangesHistoryMarkerJournalNativeSchemaError);
    assert.throws(
      () => native.parseResult(
        Buffer.from(activeResult.toString('utf8').replace('\tVALUE\t', `\t${forgedStatus}\t`), 'utf8'),
        requests.READ,
        'READ'
      ),
      native.ChangesHistoryMarkerJournalNativeSchemaError
    );
  }
  assert.throws(
    () => native.parseResult(Buffer.concat([activeResult, Buffer.from('x')]), requests.READ, 'READ'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const invalidUtf8 = Buffer.from(activeResult);
  invalidUtf8[1] = 0xff;
  assert.throws(
    () => native.parseResult(invalidUtf8, requests.READ, 'READ'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(
    () => native.parseResult(activeResult, requests.READ, 'APPEND'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
});

test('fresh READ alone classifies exact next, exact expected, legacy and unknown truth', () => {
  const initial = initialValue();
  const next = active(initial);
  const origin = request(native.SCHEMAS.APPEND, 'APPEND', {
    previousValue: initial, nextValue: next,
  });
  const readRequest = request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
  });
  const committedBytes = native.encodeResult({
    schema: native.SCHEMAS.RESULT, command: 'READ', status: 'VALUE', value: next,
  }, readRequest);
  const uncommittedBytes = native.encodeResult({
    schema: native.SCHEMAS.RESULT, command: 'READ', status: 'VALUE', value: initial,
  }, readRequest);
  const committed = native.parseResult(committedBytes, readRequest, 'READ');
  const uncommitted = native.parseResult(uncommittedBytes, readRequest, 'READ');
  assert.strictEqual(native.classifyFreshRead(committed, origin, readRequest), 'COMMITTED');
  assert.strictEqual(native.classifyFreshRead(uncommitted, origin, readRequest), 'UNCOMMITTED');
  for (const status of ['LEGACY', 'UNKNOWN']) {
    const result = native.parseResult(native.encodeResult({
      schema: native.SCHEMAS.RESULT, command: 'READ', status, value: null,
    }, readRequest), readRequest, 'READ');
    assert.strictEqual(native.classifyFreshRead(result, origin, readRequest), status);
  }
  const foreignRead = request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(initial)],
  });
  assert.throws(
    () => native.parseResult(committedBytes, foreignRead, 'READ'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(
    () => native.parseResult(committedBytes, null, 'READ'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(() => native.classifyFreshRead({
    schema: native.SCHEMAS.RESULT,
    command: 'READ',
    requestDigest: native.assertRequestAuthority(readRequest, 'READ').requestDigest,
    status: 'UNKNOWN',
    head: journal.expectedHead(next),
    value: null,
  }, origin, readRequest), native.ChangesHistoryMarkerJournalNativeSchemaError);
});

test('APPEND encoder owns the business transition and rejects skip, cross-project and stale authority', () => {
  const initial = initialValue();
  const next = active(initial);
  const foreignMarker = markerFixture('foreign');
  assert.throws(() => native.encodeAppendCommand(request(native.SCHEMAS.APPEND, 'APPEND', {
    previousValue: initial,
    nextValue: {
      ...next,
      projectId: 'foreign',
      activeMarker: foreignMarker,
      activeMarkerDigest: journal.activeMarkerDigest(foreignMarker),
    },
  })), /invalid|digest|transition/u);
  assert.throws(() => native.encodeReadCommand(request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(next), journal.expectedHead(initial)],
  })), native.ChangesHistoryMarkerJournalNativeSchemaError);
  const append = native.encodeAppendCommand(request(native.SCHEMAS.APPEND, 'APPEND', {
    previousValue: initial,
    nextValue: next,
  }));
  const newline = append.indexOf(0x0a);
  const headerFields = append.subarray(0, newline).toString('utf8').split('\t');
  const frame = append.subarray(newline + 1);
  const foreignFields = [...headerFields];
  foreignFields[6] = `chrj_${'d'.repeat(48)}`;
  const foreignHeads = [
    journal.expectedHead(initial),
    { ...journal.expectedHead(next), journalId: foreignFields[6] },
  ];
  foreignFields[2] = evidence.digestObject(native.SCHEMAS.REQUEST_AUTHORITY, {
    schema: native.SCHEMAS.REQUEST_AUTHORITY,
    command: 'APPEND',
    expectedHeads: foreignHeads,
    nextFrameSha256: sha(frame),
  });
  assert.throws(() => native.parseCommand(Buffer.concat([
    Buffer.from(`${foreignFields.join('\t')}\n`, 'utf8'), frame,
  ])), native.ChangesHistoryMarkerJournalNativeSchemaError);
  const wrongSlotFrame = Buffer.from(frame);
  wrongSlotFrame['WRCCHRJ2\t'.length] = 0x41;
  const wrongSlotFields = [...headerFields];
  wrongSlotFields[10] = sha(wrongSlotFrame);
  wrongSlotFields[2] = evidence.digestObject(native.SCHEMAS.REQUEST_AUTHORITY, {
    schema: native.SCHEMAS.REQUEST_AUTHORITY,
    command: 'APPEND',
    expectedHeads: [journal.expectedHead(initial), journal.expectedHead(next)],
    nextFrameSha256: wrongSlotFields[10],
  });
  assert.throws(() => native.parseCommand(Buffer.concat([
    Buffer.from(`${wrongSlotFields.join('\t')}\n`, 'utf8'), wrongSlotFrame,
  ])), native.ChangesHistoryMarkerJournalNativeSchemaError);
});

test('exact descriptors, extras and accessors fail without invoking getters', () => {
  const initial = initialValue();
  const reordered = { command: 'INIT', initialValue: initial, schema: native.SCHEMAS.INIT };
  assert.deepStrictEqual(
    native.encodeInitCommand(reordered),
    native.encodeInitCommand(request(native.SCHEMAS.INIT, 'INIT', { initialValue: initial }))
  );
  let getterCalls = 0;
  const hostile = {
    schema: native.SCHEMAS.INIT,
    command: 'INIT',
  };
  Object.defineProperty(hostile, 'initialValue', {
    enumerable: true,
    get() { getterCalls += 1; return initial; },
  });
  assert.throws(() => native.encodeInitCommand(hostile), native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.strictEqual(getterCalls, 0);
  let schemaGetterCalls = 0;
  const hostileSchema = { command: 'INIT', initialValue: initial };
  Object.defineProperty(hostileSchema, 'schema', {
    enumerable: true,
    get() { schemaGetterCalls += 1; return native.SCHEMAS.INIT; },
  });
  assert.throws(
    () => native.encodeInitCommand(hostileSchema),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.strictEqual(schemaGetterCalls, 0);
  let itemGetterCalls = 0;
  const hostileHeads = [];
  Object.defineProperty(hostileHeads, '0', {
    enumerable: true,
    configurable: true,
    get() { itemGetterCalls += 1; return journal.expectedHead(initial); },
  });
  hostileHeads.length = 1;
  assert.throws(() => native.encodeReadCommand(request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: hostileHeads,
  })), native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.strictEqual(itemGetterCalls, 0);
  assert.throws(() => native.encodeInitCommand({
    ...request(native.SCHEMAS.INIT, 'INIT', { initialValue: initial }), extra: true,
  }), native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.throws(() => native.encodeDiscoverCommand({
    schema: native.SCHEMAS.DISCOVER, command: 'DISCOVER', extra: true,
  }), native.ChangesHistoryMarkerJournalNativeSchemaError);
  let discoverGetterCalls = 0;
  const discoverGetter = { schema: native.SCHEMAS.DISCOVER };
  Object.defineProperty(discoverGetter, 'command', {
    enumerable: true,
    get() { discoverGetterCalls += 1; return 'DISCOVER'; },
  });
  assert.throws(
    () => native.encodeDiscoverCommand(discoverGetter),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.strictEqual(discoverGetterCalls, 0);
});

test('physical slot parser rejects invalid UTF-8, length, overflow and trailing bytes', () => {
  const frame = journal.encodeSlotFrame(initialValue(), 'A');
  const invalidUtf8 = Buffer.from(frame);
  invalidUtf8[invalidUtf8.length - 2] = 0xff;
  assert.throws(() => native.assertPhysicalSlotFrame(invalidUtf8), /UTF-8|digest/u);
  const newline = frame.indexOf(0x0a);
  const fields = frame.subarray(0, newline).toString('utf8').split('\t');
  fields[4] = String(Number(fields[4]) - 1);
  const wrongLength = Buffer.concat([
    Buffer.from(`${fields.join('\t')}\n`, 'utf8'),
    frame.subarray(newline + 1),
  ]);
  assert.throws(() => native.assertPhysicalSlotFrame(wrongLength), native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.throws(
    () => native.assertPhysicalSlotFrame(Buffer.concat([frame, Buffer.from('x')])),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(
    () => native.assertPhysicalSlotFrame(Buffer.alloc(journal.MAX_FRAME_BYTES + 1)),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const initial = initialValue();
  const read = native.encodeReadCommand(request(native.SCHEMAS.READ, 'READ', {
    expectedHeads: [journal.expectedHead(initial)],
  }));
  const noncanonicalCount = Buffer.from(read.toString('utf8').replace('\t1\t', '\t01\t'), 'utf8');
  assert.throws(() => native.parseCommand(noncanonicalCount), native.ChangesHistoryMarkerJournalNativeSchemaError);
  const nulHeader = Buffer.from(read);
  nulHeader[1] = 0;
  assert.throws(() => native.parseCommand(nulHeader), native.ChangesHistoryMarkerJournalNativeSchemaError);
  const invalidHeaderUtf8 = Buffer.from(read);
  invalidHeaderUtf8[1] = 0xff;
  assert.throws(() => native.parseCommand(invalidHeaderUtf8), native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.throws(
    () => native.parseCommand(Buffer.concat([read, Buffer.from('x')])),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const discover = native.encodeDiscoverCommand(request(native.SCHEMAS.DISCOVER, 'DISCOVER', {}));
  assert.throws(
    () => native.parseCommand(Buffer.concat([discover, Buffer.from('x')])),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const discoverNul = Buffer.from(discover);
  discoverNul[1] = 0;
  assert.throws(() => native.parseCommand(discoverNul), native.ChangesHistoryMarkerJournalNativeSchemaError);
  const discoverUtf8 = Buffer.from(discover);
  discoverUtf8[1] = 0xff;
  assert.throws(() => native.parseCommand(discoverUtf8), native.ChangesHistoryMarkerJournalNativeSchemaError);
});

test('stable error envelopes contain only command and a frozen path-free code', () => {
  const previous = initialValue();
  const errorRequest = request(native.SCHEMAS.APPEND, 'APPEND', {
    previousValue: previous,
    nextValue: active(previous),
  });
  const bytes = native.encodeError({
    schema: native.SCHEMAS.ERROR,
    command: 'APPEND',
    code: 'AUTHORITY_UNAVAILABLE',
  }, errorRequest);
  assert.strictEqual(
    sha(bytes),
    'sha256:bb4593b96c79bec0a8408fd6d47f71d0f2ffa91b75a2cd6f9bcf0bb0887c3638'
  );
  assert.deepStrictEqual(native.parseError(bytes, errorRequest, 'APPEND'), {
    schema: native.SCHEMAS.ERROR,
    command: 'APPEND',
    requestDigest: native.assertRequestAuthority(errorRequest, 'APPEND').requestDigest,
    code: 'AUTHORITY_UNAVAILABLE',
  });
  assert.throws(() => native.parseError(
    Buffer.from('WRCCHJE2\tAPPEND\tsha256:0000000000000000000000000000000000000000000000000000000000000000\t/private/book\n'),
    errorRequest,
    'APPEND'
  ),
    native.ChangesHistoryMarkerJournalNativeSchemaError);
  assert.throws(
    () => native.parseError(Buffer.concat([bytes, Buffer.from('x')]), errorRequest, 'APPEND'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  const invalidUtf8 = Buffer.from(bytes);
  invalidUtf8[1] = 0xff;
  assert.throws(
    () => native.parseError(invalidUtf8, errorRequest, 'APPEND'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
  assert.throws(
    () => native.parseError(bytes, errorRequest, 'READ'),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
});

test('96 MiB is a hard transport/frame cap boundary, not a maximum legal business authority', () => {
  const prefix = Buffer.from('{"pad":"', 'utf8');
  const suffix = Buffer.from('"}\n', 'utf8');
  const payload = Buffer.concat([
    prefix,
    Buffer.alloc(journal.MAX_VALUE_BYTES - prefix.length - suffix.length, 0x61),
    suffix,
  ]);
  assert.strictEqual(payload.length, 100663296);
  assert.strictEqual(
    sha(payload),
    'sha256:05fc081a1977e2b77ba109d42274a2411af48ac5e69cbe024ccd1d81ed92cf69'
  );
  const valueDigest = `sha256:${'d'.repeat(64)}`;
  const header = Buffer.from(
    `WRCCHRJ2\tA\t${journalId}\t0\t${payload.length}\t${valueDigest}\t-\t${sha(payload)}\n`,
    'utf8'
  );
  const frame = Buffer.concat([header, payload]);
  assert.strictEqual(frame.length, 100663519);
  assert.strictEqual(
    sha(frame),
    'sha256:600a3d3e8b478559e6f26f3666f449a86946a9b03c8976e7e43a874c1bb466d2'
  );
  const parsed = native.assertPhysicalSlotFrame(frame);
  assert.strictEqual(parsed.payloadLength, journal.MAX_VALUE_BYTES);
  const n2 = Buffer.concat([
    Buffer.from(
      `WRCCHJN2\tINIT\tsha256:${'0'.repeat(64)}\t${journalId}\t0\t${valueDigest}` +
      `\t${frame.length}\t${sha(frame)}\n`,
      'utf8'
    ),
    frame,
  ]);
  assert.deepStrictEqual([n2.length, sha(n2)], [
    100663815,
    'sha256:a793995f3c7462c3d057a4e712ca11a738fdf9da68f8a32cea7fd17a7cd6d756',
  ]);
  const o2 = Buffer.concat([
    Buffer.from(
      `WRCCHJO2\tREAD\tVALUE\tsha256:${'0'.repeat(64)}\t${journalId}\t0\t${valueDigest}` +
      `\t${payload.length}\t${sha(payload)}\n`,
      'utf8'
    ),
    payload,
  ]);
  assert.deepStrictEqual([o2.length, sha(o2)], [
    100663598,
    'sha256:aacb8c70ad58cae6156ed491d88d8f2b14002e10b06e77c94cce7e4590ebcd41',
  ]);
  assert.throws(
    () => native.assertPhysicalSlotFrame(Buffer.concat([frame, Buffer.from('x')])),
    native.ChangesHistoryMarkerJournalNativeSchemaError
  );
});

console.log(`Changes/History native permanent-journal wire verification: ${passed}/${passed} passed`);
