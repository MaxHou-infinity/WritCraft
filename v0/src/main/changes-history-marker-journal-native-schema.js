'use strict';

// Private binary wire contract for the native physical marker journal helper.
// Business-value and transition authority remains in marker-journal-schema.

const crypto = require('crypto');
const { TextDecoder } = require('util');
const evidence = require('./evidence-delivery-schema');
const journal = require('./changes-history-marker-journal-schema');

const SCHEMAS = Object.freeze({
  DISCOVER: 'writcraft.changes-history-marker-journal-native-discover-request/v1',
  INIT: 'writcraft.changes-history-marker-journal-native-init-request/v1',
  READ: 'writcraft.changes-history-marker-journal-native-read-request/v1',
  APPEND: 'writcraft.changes-history-marker-journal-native-append-request/v1',
  REQUEST_AUTHORITY: 'writcraft.changes-history-marker-journal-native-request-authority/v1',
  RESULT: 'writcraft.changes-history-marker-journal-native-result/v1',
  ERROR: 'writcraft.changes-history-marker-journal-native-error/v1',
});
const REQUEST_MAGIC = 'WRCCHJN2';
const RESULT_MAGIC = 'WRCCHJO2';
const ERROR_MAGIC = 'WRCCHJE2';
const COMMANDS = Object.freeze(['DISCOVER', 'INIT', 'READ', 'APPEND']);
const STATUSES = Object.freeze(['LEGACY', 'VALUE', 'UNKNOWN']);
const DISCOVER_STATUSES = Object.freeze(['ABSENT', 'LEGACY', 'BASE', 'PAIR', 'UNKNOWN']);
const ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'AUTHORITY_UNAVAILABLE',
  'JOURNAL_UNAVAILABLE',
  'JOURNAL_UNKNOWN',
  'BUDGET_EXCEEDED',
]);
const MAX_COMMAND_HEADER_BYTES = 1024;
const MAX_RESULT_HEADER_BYTES = 1024;
const MAX_COMMAND_BYTES = journal.MAX_FRAME_BYTES + MAX_COMMAND_HEADER_BYTES;
const MAX_RESULT_BYTES = journal.MAX_VALUE_BYTES + MAX_RESULT_HEADER_BYTES;
const MAX_PHYSICAL_JOURNAL_BYTES = journal.SLOT_CAPACITY * 2;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const GENERATION_RE = /^(?:0|[1-9][0-9]{0,19})$/u;

class ChangesHistoryMarkerJournalNativeSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangesHistoryMarkerJournalNativeSchemaError';
  }
}

function fail(message) {
  throw new ChangesHistoryMarkerJournalNativeSchemaError(message);
}

function valuesOf(raw, keys, label) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.getOwnPropertySymbols(raw).length !== 0) fail(`${label} is invalid`);
  const names = Object.getOwnPropertyNames(raw);
  if (names.length !== keys.length || keys.some(key => !names.includes(key))) {
    fail(`${label} fields are invalid`);
  }
  const value = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set ||
        descriptor.enumerable !== true) fail(`${label} descriptors are invalid`);
    value[key] = descriptor.value;
  }
  return value;
}

function schemaOf(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.getOwnPropertySymbols(raw).length !== 0) fail('native journal request is invalid');
  const descriptor = Object.getOwnPropertyDescriptor(raw, 'schema');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
    fail('native journal request schema descriptor is invalid');
  }
  return descriptor.value;
}

function denseArray(raw, label) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
      Object.getOwnPropertySymbols(raw).length !== 0) fail(`${label} is invalid`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, 'length');
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value)) fail(`${label} length is invalid`);
  const length = lengthDescriptor.value;
  const names = Object.getOwnPropertyNames(raw);
  if (names.length !== length + 1 || names[names.length - 1] !== 'length') fail(`${label} is sparse`);
  const items = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set ||
        descriptor.enumerable !== true) fail(`${label} descriptors are invalid`);
    items.push(descriptor.value);
  }
  return items;
}

function sha256(raw) {
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function command(raw) {
  if (!COMMANDS.includes(raw)) fail('native journal command is invalid');
  return raw;
}

function generation(raw) {
  if (!GENERATION_RE.test(raw || '') || BigInt(raw) > ((1n << 64n) - 1n)) {
    fail('native journal generation is invalid');
  }
  return raw;
}

function digest(raw, label) {
  if (!DIGEST_RE.test(raw || '')) fail(`${label} is invalid`);
  return raw;
}

function sameHead(left, right) {
  return left.journalId === right.journalId && left.generation === right.generation &&
    left.valueDigest === right.valueDigest;
}

function headFields(raw) {
  return [raw.journalId, raw.generation, raw.valueDigest];
}

function assertHeads(raw) {
  const items = denseArray(raw, 'native journal allowed heads');
  if (items.length < 1 || items.length > 2) fail('native journal allowed heads are invalid');
  const heads = items.map(value => journal.assertExpectedHead(value));
  if (heads.length === 2) {
    if (heads[0].journalId !== heads[1].journalId ||
        BigInt(heads[1].generation) !== BigInt(heads[0].generation) + 1n ||
        heads[0].valueDigest === heads[1].valueDigest) {
      fail('native journal reconciliation heads are not one ordered boundary');
    }
  }
  return Object.freeze(heads);
}

function assertPhysicalSlotFrame(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > journal.MAX_FRAME_BYTES) {
    fail('native journal slot frame budget is invalid');
  }
  const newline = raw.indexOf(0x0a);
  if (newline < 0 || newline + 1 > journal.MAX_HEADER_BYTES) {
    fail('native journal slot header is invalid');
  }
  let header;
  try { header = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, newline)); }
  catch (_) { fail('native journal slot header is not valid UTF-8'); }
  const fields = header.split('\t');
  if (fields.length !== 8 || fields[0] !== journal.JOURNAL_MAGIC ||
      !journal.SLOTS.includes(fields[1]) || !/^chrj_[a-f0-9]{48}$/u.test(fields[2]) ||
      !GENERATION_RE.test(fields[3]) || !/^(?:0|[1-9][0-9]*)$/u.test(fields[4]) ||
      !DIGEST_RE.test(fields[5]) || !(fields[6] === '-' || DIGEST_RE.test(fields[6])) ||
      !DIGEST_RE.test(fields[7])) fail('native journal slot header fields are invalid');
  const payloadLength = Number(fields[4]);
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 1 ||
      payloadLength > journal.MAX_VALUE_BYTES || raw.length !== newline + 1 + payloadLength) {
    fail('native journal slot payload length is invalid');
  }
  const payload = raw.subarray(newline + 1);
  if (payload.includes(0) || payload[payload.length - 1] !== 0x0a || sha256(payload) !== fields[7]) {
    fail('native journal slot payload digest is invalid');
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(payload); }
  catch (_) { fail('native journal slot payload is not valid UTF-8'); }
  return Object.freeze({
    slot: fields[1],
    journalId: fields[2],
    generation: generation(fields[3]),
    valueDigest: digest(fields[5], 'native journal frame value digest'),
    previousValueDigest: fields[6] === '-'
      ? null
      : digest(fields[6], 'native journal frame previous value digest'),
    payloadLength,
    payloadSha256: fields[7],
    headerBytes: newline + 1,
  });
}

function requestHeader(fields, payload = null) {
  const header = Buffer.from(`${fields.join('\t')}\n`, 'utf8');
  if (header.length > MAX_COMMAND_HEADER_BYTES) fail('native journal command header exceeds budget');
  const bytes = payload === null ? header : Buffer.concat([header, payload]);
  if (bytes.length > MAX_COMMAND_BYTES) fail('native journal command exceeds budget');
  return bytes;
}

function requestAuthorityDigest(commandValue, heads, frame) {
  return evidence.digestObject(SCHEMAS.REQUEST_AUTHORITY, {
    schema: SCHEMAS.REQUEST_AUTHORITY,
    command: commandValue,
    expectedHeads: heads,
    nextFrameSha256: frame === null ? null : sha256(frame),
  });
}

function assertRequestAuthority(raw, expectedCommand = null) {
  let value;
  let heads;
  let frame = null;
  const rawSchema = schemaOf(raw);
  if (rawSchema === SCHEMAS.DISCOVER) {
    value = valuesOf(raw, ['schema', 'command'], 'native journal DISCOVER request');
    if (command(value.command) !== 'DISCOVER') fail('native journal DISCOVER identity is invalid');
    heads = Object.freeze([]);
  } else if (rawSchema === SCHEMAS.INIT) {
    value = valuesOf(raw, ['schema', 'command', 'initialValue'], 'native journal INIT request');
    if (command(value.command) !== 'INIT') fail('native journal INIT identity is invalid');
    const initial = journal.assertJournalValue(value.initialValue);
    if (initial.generation !== '0' || initial.previousValueDigest !== null || initial.state !== 'IDLE') {
      fail('native journal INIT value is not generation-zero IDLE');
    }
    frame = journal.encodeSlotFrame(initial, 'A');
    heads = Object.freeze([journal.expectedHead(initial)]);
  } else if (rawSchema === SCHEMAS.READ) {
    value = valuesOf(raw, ['schema', 'command', 'expectedHeads'], 'native journal READ request');
    if (command(value.command) !== 'READ') fail('native journal READ identity is invalid');
    heads = assertHeads(value.expectedHeads);
  } else if (rawSchema === SCHEMAS.APPEND) {
    value = valuesOf(
      raw,
      ['schema', 'command', 'previousValue', 'nextValue'],
      'native journal APPEND request'
    );
    if (command(value.command) !== 'APPEND') fail('native journal APPEND identity is invalid');
    const previous = journal.assertJournalValue(value.previousValue);
    const next = journal.assertTransition(previous, value.nextValue);
    heads = Object.freeze([journal.expectedHead(previous), journal.expectedHead(next)]);
    const slot = BigInt(next.generation) % 2n === 0n ? 'A' : 'B';
    frame = journal.encodeSlotFrame(next, slot);
  } else {
    fail('native journal request schema is invalid');
  }
  if (expectedCommand !== null && command(expectedCommand) !== value.command) {
    fail('native journal request command differs from expected command');
  }
  return Object.freeze({
    command: value.command,
    requestDigest: requestAuthorityDigest(value.command, heads, frame),
    expectedHeads: heads,
    frame,
  });
}

function encodeDiscoverCommand(raw) {
  const authority = assertRequestAuthority(raw, 'DISCOVER');
  return requestHeader([REQUEST_MAGIC, 'DISCOVER', authority.requestDigest]);
}

function encodeInitCommand(raw) {
  const authority = assertRequestAuthority(raw, 'INIT');
  const frame = authority.frame;
  const head = authority.expectedHeads[0];
  return requestHeader([
    REQUEST_MAGIC, 'INIT', authority.requestDigest,
    ...headFields(head), String(frame.length), sha256(frame),
  ], frame);
}

function encodeReadCommand(raw) {
  const authority = assertRequestAuthority(raw, 'READ');
  return requestHeader([
    REQUEST_MAGIC, 'READ', authority.requestDigest,
    String(authority.expectedHeads.length), ...authority.expectedHeads.flatMap(headFields),
  ]);
}

function encodeAppendCommand(raw) {
  const authority = assertRequestAuthority(raw, 'APPEND');
  const [expected, nextHead] = authority.expectedHeads;
  const frame = authority.frame;
  return requestHeader([
    REQUEST_MAGIC, 'APPEND', authority.requestDigest,
    ...headFields(expected), ...headFields(nextHead),
    String(frame.length), sha256(frame),
  ], frame);
}

function splitWire(raw, maximum, headerMaximum, label) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > maximum) fail(`${label} bytes are invalid`);
  const newline = raw.indexOf(0x0a);
  if (newline < 0 || newline + 1 > headerMaximum) fail(`${label} header is invalid`);
  if (raw.subarray(0, newline).includes(0)) fail(`${label} header contains NUL`);
  let header;
  try { header = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, newline)); }
  catch (_) { fail(`${label} header is not valid UTF-8`); }
  return Object.freeze({ fields: header.split('\t'), payload: raw.subarray(newline + 1) });
}

function parsedHead(fields, offset) {
  return journal.assertExpectedHead({
    schema: journal.SCHEMAS.HEAD,
    journalId: fields[offset],
    generation: fields[offset + 1],
    valueDigest: fields[offset + 2],
  });
}

function parseCommand(raw) {
  const wire = splitWire(raw, MAX_COMMAND_BYTES, MAX_COMMAND_HEADER_BYTES, 'native journal command');
  if (wire.fields[0] !== REQUEST_MAGIC) fail('native journal command magic is invalid');
  const kind = command(wire.fields[1]);
  const requestDigest = digest(wire.fields[2], 'native journal request digest');
  if (kind === 'DISCOVER') {
    const expectedHeads = Object.freeze([]);
    if (wire.fields.length !== 3 || wire.payload.length !== 0 ||
        requestDigest !== requestAuthorityDigest('DISCOVER', expectedHeads, null)) {
      fail('native journal DISCOVER wire is invalid');
    }
    return Object.freeze({ command: kind, requestDigest, expectedHeads });
  }
  if (kind === 'READ') {
    if (!/^[12]$/u.test(wire.fields[3] || '')) fail('native journal READ head count is invalid');
    const count = Number(wire.fields[3]);
    if ((count !== 1 && count !== 2) || wire.fields.length !== 4 + count * 3 || wire.payload.length !== 0) {
      fail('native journal READ wire is invalid');
    }
    const heads = [];
    for (let index = 0; index < count; index += 1) heads.push(parsedHead(wire.fields, 4 + index * 3));
    const expectedHeads = assertHeads(heads);
    if (requestDigest !== requestAuthorityDigest('READ', expectedHeads, null)) {
      fail('native journal READ request digest is invalid');
    }
    return Object.freeze({ command: kind, requestDigest, expectedHeads });
  }
  const isInit = kind === 'INIT';
  const exactFields = isInit ? 8 : 11;
  if (wire.fields.length !== exactFields) fail(`native journal ${kind} wire fields are invalid`);
  const expected = parsedHead(wire.fields, 3);
  const next = isInit ? expected : parsedHead(wire.fields, 6);
  const lengthIndex = isInit ? 6 : 9;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(wire.fields[lengthIndex]) ||
      Number(wire.fields[lengthIndex]) !== wire.payload.length ||
      !DIGEST_RE.test(wire.fields[lengthIndex + 1]) || sha256(wire.payload) !== wire.fields[lengthIndex + 1]) {
    fail(`native journal ${kind} payload envelope is invalid`);
  }
  const frame = assertPhysicalSlotFrame(wire.payload);
  if (frame.journalId !== next.journalId || frame.generation !== next.generation ||
      frame.valueDigest !== next.valueDigest) fail(`native journal ${kind} frame head is invalid`);
  if (isInit) {
    if (frame.slot !== 'A' || expected.generation !== '0' || frame.previousValueDigest !== null ||
        requestDigest !== requestAuthorityDigest('INIT', [expected], wire.payload)) {
      fail('native journal INIT authority is invalid');
    }
  } else {
    const wantedSlot = BigInt(next.generation) % 2n === 0n ? 'A' : 'B';
    if (expected.journalId !== next.journalId ||
        BigInt(next.generation) !== BigInt(expected.generation) + 1n ||
        frame.previousValueDigest !== expected.valueDigest || frame.slot !== wantedSlot ||
        requestDigest !== requestAuthorityDigest('APPEND', [expected, next], wire.payload)) {
      fail('native journal APPEND authority is invalid');
    }
  }
  return Object.freeze({ command: kind, requestDigest, expectedHead: expected, nextHead: next, frame });
}

function valuePayload(raw) {
  const value = journal.assertJournalValue(raw);
  const payload = Buffer.from(`${evidence.canonicalJson(value)}\n`, 'utf8');
  if (payload.length > journal.MAX_VALUE_BYTES) fail('native journal result value exceeds budget');
  return Object.freeze({ value, payload, head: journal.expectedHead(value) });
}

function nullablePreviousDigest(raw, label) {
  return raw === null ? null : digest(raw, label);
}

function expectedPhysicalSlot(rawGeneration) {
  return BigInt(rawGeneration) % 2n === 0n ? 'A' : 'B';
}

function assertDiscoverResult(raw, rawRequest) {
  const value = valuesOf(raw, [
    'schema', 'command', 'status',
    'olderSlot', 'olderHead', 'olderPreviousValueDigest', 'olderValue',
    'newerSlot', 'newerHead', 'newerPreviousValueDigest',
  ], 'native journal DISCOVER result');
  if (value.schema !== SCHEMAS.RESULT || command(value.command) !== 'DISCOVER' ||
      !DISCOVER_STATUSES.includes(value.status)) {
    fail('native journal DISCOVER result identity is invalid');
  }
  const authority = assertRequestAuthority(rawRequest, 'DISCOVER');
  if (['ABSENT', 'LEGACY', 'UNKNOWN'].includes(value.status)) {
    if (value.olderSlot !== null || value.olderHead !== null ||
        value.olderPreviousValueDigest !== null || value.olderValue !== null ||
        value.newerSlot !== null || value.newerHead !== null ||
        value.newerPreviousValueDigest !== null) {
      fail('native journal empty DISCOVER result retains authority');
    }
    return Object.freeze({ ...value, requestDigest: authority.requestDigest });
  }
  if (!journal.SLOTS.includes(value.olderSlot)) fail('native journal older slot is invalid');
  const olderHead = journal.assertExpectedHead(value.olderHead);
  const olderPreviousValueDigest = nullablePreviousDigest(
    value.olderPreviousValueDigest,
    'native journal older predecessor digest'
  );
  const encodedOlder = valuePayload(value.olderValue);
  if (!sameHead(olderHead, encodedOlder.head) ||
      olderPreviousValueDigest !== encodedOlder.value.previousValueDigest ||
      value.olderSlot !== expectedPhysicalSlot(olderHead.generation)) {
    fail('native journal older DISCOVER authority is inconsistent');
  }
  if (value.status === 'BASE') {
    if (value.olderSlot !== 'A' || olderHead.generation !== '0' ||
        olderPreviousValueDigest !== null || encodedOlder.value.state !== 'IDLE' ||
        value.newerSlot !== null || value.newerHead !== null ||
        value.newerPreviousValueDigest !== null) {
      fail('native journal BASE authority is invalid');
    }
    return Object.freeze({
      ...value,
      olderHead,
      olderPreviousValueDigest,
      olderValue: encodedOlder.value,
      requestDigest: authority.requestDigest,
    });
  }
  if (!journal.SLOTS.includes(value.newerSlot)) fail('native journal newer slot is invalid');
  const newerHead = journal.assertExpectedHead(value.newerHead);
  const newerPreviousValueDigest = nullablePreviousDigest(
    value.newerPreviousValueDigest,
    'native journal newer predecessor digest'
  );
  if (olderHead.journalId !== newerHead.journalId ||
      BigInt(newerHead.generation) !== BigInt(olderHead.generation) + 1n ||
      newerPreviousValueDigest !== olderHead.valueDigest ||
      value.newerSlot !== expectedPhysicalSlot(newerHead.generation) ||
      value.newerSlot === value.olderSlot) {
    fail('native journal PAIR authority is not one physical predecessor chain');
  }
  return Object.freeze({
    ...value,
    olderHead,
    olderPreviousValueDigest,
    olderValue: encodedOlder.value,
    newerHead,
    newerPreviousValueDigest,
    requestDigest: authority.requestDigest,
  });
}

function physicalFields(slot, head, previousValueDigest) {
  if (slot === null) return ['-', '-', '-', '-', '-'];
  return [slot, ...headFields(head), previousValueDigest === null ? '-' : previousValueDigest];
}

function encodeDiscoverResult(raw, rawRequest) {
  const value = assertDiscoverResult(raw, rawRequest);
  const payload = value.olderValue === null ? null : valuePayload(value.olderValue).payload;
  const fields = [
    RESULT_MAGIC, 'DISCOVER', value.status, value.requestDigest,
    ...physicalFields(value.olderSlot, value.olderHead, value.olderPreviousValueDigest),
    ...physicalFields(value.newerSlot, value.newerHead, value.newerPreviousValueDigest),
    payload === null ? '0' : String(payload.length),
    payload === null ? '-' : sha256(payload),
  ];
  const header = Buffer.from(`${fields.join('\t')}\n`, 'utf8');
  const bytes = payload === null ? header : Buffer.concat([header, payload]);
  if (header.length > MAX_RESULT_HEADER_BYTES || bytes.length > MAX_RESULT_BYTES) {
    fail('native journal DISCOVER result exceeds budget');
  }
  return bytes;
}

function parsedPhysical(fields, offset, label) {
  const slot = fields[offset];
  if (!journal.SLOTS.includes(slot)) fail(`native journal ${label} physical slot is invalid`);
  return Object.freeze({
    slot,
    head: parsedHead(fields, offset + 1),
    previousValueDigest: fields[offset + 4] === '-'
      ? null
      : digest(fields[offset + 4], `native journal ${label} predecessor digest`),
  });
}

function parseDiscoverResult(raw, rawRequest) {
  const authority = assertRequestAuthority(rawRequest, 'DISCOVER');
  const wire = splitWire(raw, MAX_RESULT_BYTES, MAX_RESULT_HEADER_BYTES, 'native journal DISCOVER result');
  if (wire.fields.length !== 16 || wire.fields[0] !== RESULT_MAGIC ||
      wire.fields[1] !== 'DISCOVER' || !DISCOVER_STATUSES.includes(wire.fields[2]) ||
      wire.fields[3] !== authority.requestDigest) {
    fail('native journal DISCOVER result header is invalid');
  }
  const status = wire.fields[2];
  if (['ABSENT', 'LEGACY', 'UNKNOWN'].includes(status)) {
    if (wire.fields.slice(4).join('\t') !== '-\t-\t-\t-\t-\t-\t-\t-\t-\t-\t0\t-' ||
        wire.payload.length !== 0) {
      fail('native journal empty DISCOVER result is invalid');
    }
    return assertDiscoverResult({
      schema: SCHEMAS.RESULT,
      command: 'DISCOVER',
      status,
      olderSlot: null,
      olderHead: null,
      olderPreviousValueDigest: null,
      olderValue: null,
      newerSlot: null,
      newerHead: null,
      newerPreviousValueDigest: null,
    }, rawRequest);
  }
  const older = parsedPhysical(wire.fields, 4, 'older');
  let newer = null;
  if (status === 'BASE') {
    if (wire.fields.slice(9, 14).join('\t') !== '-\t-\t-\t-\t-') {
      fail('native journal BASE retains newer authority');
    }
  } else {
    newer = parsedPhysical(wire.fields, 9, 'newer');
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(wire.fields[14]) ||
      Number(wire.fields[14]) !== wire.payload.length || !DIGEST_RE.test(wire.fields[15]) ||
      sha256(wire.payload) !== wire.fields[15] || wire.payload.length < 1 ||
      wire.payload.length > journal.MAX_VALUE_BYTES || wire.payload[wire.payload.length - 1] !== 0x0a) {
    fail('native journal DISCOVER payload envelope is invalid');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(wire.payload); }
  catch (_) { fail('native journal DISCOVER payload is not valid UTF-8'); }
  let parsed;
  try { parsed = JSON.parse(text.slice(0, -1)); }
  catch (_) { fail('native journal DISCOVER payload is not JSON'); }
  const encoded = valuePayload(parsed);
  if (!encoded.payload.equals(wire.payload)) fail('native journal DISCOVER payload is not canonical');
  return assertDiscoverResult({
    schema: SCHEMAS.RESULT,
    command: 'DISCOVER',
    status,
    olderSlot: older.slot,
    olderHead: older.head,
    olderPreviousValueDigest: older.previousValueDigest,
    olderValue: encoded.value,
    newerSlot: newer?.slot || null,
    newerHead: newer?.head || null,
    newerPreviousValueDigest: newer?.previousValueDigest || null,
  }, rawRequest);
}

function encodeResult(raw, rawRequest) {
  const value = valuesOf(raw, ['schema', 'command', 'status', 'value'], 'native journal result');
  if (value.schema !== SCHEMAS.RESULT) fail('native journal result schema is invalid');
  const kind = command(value.command);
  if (kind === 'DISCOVER') fail('native journal DISCOVER requires its exact result envelope');
  const authority = assertRequestAuthority(rawRequest, kind);
  if (!STATUSES.includes(value.status)) fail('native journal result status is invalid');
  let fields;
  let payload = null;
  if (value.status === 'VALUE') {
    const encoded = valuePayload(value.value);
    payload = encoded.payload;
    fields = [
      RESULT_MAGIC, kind, value.status, authority.requestDigest,
      ...headFields(encoded.head), String(payload.length), sha256(payload),
    ];
  } else {
    if (value.value !== null) fail('native journal non-value result retains value');
    fields = [RESULT_MAGIC, kind, value.status, authority.requestDigest, '-', '-', '-', '0', '-'];
  }
  const header = Buffer.from(`${fields.join('\t')}\n`, 'utf8');
  const bytes = payload === null ? header : Buffer.concat([header, payload]);
  if (header.length > MAX_RESULT_HEADER_BYTES || bytes.length > MAX_RESULT_BYTES) {
    fail('native journal result exceeds budget');
  }
  return bytes;
}

function parseResult(raw, rawRequest, expectedCommand) {
  if (expectedCommand === 'DISCOVER') {
    fail('native journal DISCOVER requires its exact result parser');
  }
  const authority = assertRequestAuthority(rawRequest, expectedCommand);
  const wire = splitWire(raw, MAX_RESULT_BYTES, MAX_RESULT_HEADER_BYTES, 'native journal result');
  if (wire.fields.length !== 9 || wire.fields[0] !== RESULT_MAGIC ||
      command(wire.fields[1]) !== command(expectedCommand) || !STATUSES.includes(wire.fields[2]) ||
      wire.fields[3] !== authority.requestDigest) {
    fail('native journal result header is invalid');
  }
  const status = wire.fields[2];
  if (status === 'LEGACY' || status === 'UNKNOWN') {
    if (status === 'LEGACY' && expectedCommand === 'APPEND') {
      fail('native journal APPEND cannot return legacy truth');
    }
    if (wire.fields.slice(4).join('\t') !== '-\t-\t-\t0\t-' || wire.payload.length !== 0) {
      fail('native journal non-value result is invalid');
    }
    return Object.freeze({
      schema: SCHEMAS.RESULT,
      command: expectedCommand,
      requestDigest: authority.requestDigest,
      status,
      head: null,
      value: null,
    });
  }
  const head = parsedHead(wire.fields, 4);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(wire.fields[7]) || Number(wire.fields[7]) !== wire.payload.length ||
      !DIGEST_RE.test(wire.fields[8]) || sha256(wire.payload) !== wire.fields[8] ||
      wire.payload.length < 1 || wire.payload.length > journal.MAX_VALUE_BYTES ||
      wire.payload[wire.payload.length - 1] !== 0x0a) fail('native journal result payload envelope is invalid');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(wire.payload); }
  catch (_) { fail('native journal result payload is not valid UTF-8'); }
  let parsed;
  try { parsed = JSON.parse(text.slice(0, -1)); }
  catch (_) { fail('native journal result payload is not JSON'); }
  const encoded = valuePayload(parsed);
  if (!encoded.payload.equals(wire.payload) || !sameHead(encoded.head, head)) {
    fail('native journal result value is not exact canonical truth');
  }
  if (!authority.expectedHeads.some(expected => sameHead(expected, head))) {
    fail('native journal result head is outside the exact request boundary');
  }
  return Object.freeze({
    schema: SCHEMAS.RESULT,
    command: expectedCommand,
    requestDigest: authority.requestDigest,
    status,
    head,
    value: encoded.value,
  });
}

function encodeError(raw, rawRequest) {
  const value = valuesOf(raw, ['schema', 'command', 'code'], 'native journal error');
  if (value.schema !== SCHEMAS.ERROR || !ERROR_CODES.includes(value.code) ||
      !COMMANDS.includes(value.command)) fail('native journal error is invalid');
  const authority = assertRequestAuthority(rawRequest, value.command);
  return Buffer.from(
    `${ERROR_MAGIC}\t${value.command}\t${authority.requestDigest}\t${value.code}\n`,
    'utf8'
  );
}

function parseError(raw, rawRequest, expectedCommand) {
  const authority = assertRequestAuthority(rawRequest, expectedCommand);
  const wire = splitWire(raw, MAX_RESULT_HEADER_BYTES, MAX_RESULT_HEADER_BYTES, 'native journal error');
  if (wire.payload.length !== 0 || wire.fields.length !== 4 || wire.fields[0] !== ERROR_MAGIC ||
      wire.fields[1] !== command(expectedCommand) || wire.fields[2] !== authority.requestDigest ||
      !ERROR_CODES.includes(wire.fields[3])) fail('native journal error wire is invalid');
  return Object.freeze({
    schema: SCHEMAS.ERROR,
    command: expectedCommand,
    requestDigest: authority.requestDigest,
    code: wire.fields[3],
  });
}

function classifyFreshRead(rawResult, rawOriginalRequest, rawReadRequest) {
  const original = assertRequestAuthority(rawOriginalRequest);
  if (original.command !== 'INIT' && original.command !== 'APPEND') {
    fail('native journal reconciliation origin is invalid');
  }
  const readAuthority = assertRequestAuthority(rawReadRequest, 'READ');
  if (readAuthority.expectedHeads.length !== original.expectedHeads.length ||
      readAuthority.expectedHeads.some((head, index) => !sameHead(head, original.expectedHeads[index]))) {
    fail('native journal reconciliation READ boundary differs from original request');
  }
  const result = valuesOf(
    rawResult,
    ['schema', 'command', 'requestDigest', 'status', 'head', 'value'],
    'native journal fresh READ result'
  );
  if (result.schema !== SCHEMAS.RESULT || result.command !== 'READ' ||
      result.requestDigest !== readAuthority.requestDigest || !STATUSES.includes(result.status)) {
    fail('native journal fresh READ result identity is invalid');
  }
  if (result.status === 'LEGACY' || result.status === 'UNKNOWN') {
    if (result.head !== null || result.value !== null) {
      fail('native journal non-value fresh READ retains authority');
    }
    return result.status;
  }
  const head = journal.assertExpectedHead(result.head);
  const value = journal.assertJournalValue(result.value);
  if (!sameHead(journal.expectedHead(value), head)) {
    fail('native journal fresh READ value is not exact truth');
  }
  const expected = original.command === 'APPEND' ? original.expectedHeads[0] : null;
  const next = original.expectedHeads[original.expectedHeads.length - 1];
  if (sameHead(head, next)) return 'COMMITTED';
  if (expected !== null && sameHead(head, expected)) return 'UNCOMMITTED';
  return 'UNKNOWN';
}

module.exports = Object.freeze({
  SCHEMAS,
  REQUEST_MAGIC,
  RESULT_MAGIC,
  ERROR_MAGIC,
  COMMANDS,
  STATUSES,
  DISCOVER_STATUSES,
  ERROR_CODES,
  MAX_COMMAND_HEADER_BYTES,
  MAX_RESULT_HEADER_BYTES,
  MAX_COMMAND_BYTES,
  MAX_RESULT_BYTES,
  MAX_PHYSICAL_JOURNAL_BYTES,
  ChangesHistoryMarkerJournalNativeSchemaError,
  assertRequestAuthority,
  assertPhysicalSlotFrame,
  encodeDiscoverCommand,
  encodeDiscoverResult,
  parseDiscoverResult,
  encodeInitCommand,
  encodeReadCommand,
  encodeAppendCommand,
  parseCommand,
  encodeResult,
  parseResult,
  encodeError,
  parseError,
  classifyFreshRead,
});
