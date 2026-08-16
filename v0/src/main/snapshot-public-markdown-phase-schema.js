'use strict';

// This validates one subrecord embedded in the existing Changes/History
// recovery marker. It owns no persistence and creates no second recovery
// authority. All untrusted records/arrays are descriptor-read so accessors are
// rejected without invoking getters.

const evidenceSchema = require('./evidence-delivery-schema');

const SCHEMA = 'writcraft.changes-history-public-markdown-phase/v1';
const SELECTION_SCHEMA = 'writcraft.changes-history-public-markdown-selection/v1';
const KINDS = Object.freeze(['snapshot_restore', 'snapshot_restore_undo']);
const PHASES = Object.freeze([
  'PRECREATE',
  'CREATED_RECEIPT',
  'EXISTING_COMMITTED',
  'CREATE_ROLLBACK_QUARANTINED',
  'ROLLED_BACK',
  'QUARANTINED',
  'HISTORY_COMMITTED',
  'FINALIZED',
  'RESTORED',
]);
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/u;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const SELECTED_ID_RE = /^[A-Za-z0-9:_-]{1,256}$/u;
const MAX_ITEMS = 300;
const ACTIONS = Object.freeze({
  snapshot_restore: Object.freeze(['EXISTING', 'MISSING']),
  snapshot_restore_undo: Object.freeze(['EXISTING', 'CREATED']),
});

class SnapshotPublicMarkdownPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotPublicMarkdownPhaseError';
    this.code = 'INVALID_SNAPSHOT_PUBLIC_MARKDOWN_PHASE';
  }
}

function fail(message) {
  throw new SnapshotPublicMarkdownPhaseError(message);
}

function plainRecordValues(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} structure invalid`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string') ||
      ownKeys.some(key => !keys.includes(key))) fail(`${label} keys invalid`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) fail(`${label}.${key} must be plain data`);
    result[key] = descriptor.value;
  }
  return result;
}

function densePlainArray(value, label, minimum = 0, maximum = MAX_ITEMS) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < minimum ||
      lengthDescriptor.value > maximum) fail(`${label} length invalid`);
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some(key => typeof key !== 'string') ||
      ownKeys.some(key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    fail(`${label} contains hidden or extra entries`);
  }
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) fail(`${label} must be dense plain data`);
    result.push(descriptor.value);
  }
  return result;
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail(`${label} invalid`);
  return value;
}

function selectedId(value, label) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') ||
      !SELECTED_ID_RE.test(value) || Buffer.byteLength(value, 'utf8') > 256) {
    fail(`${label} invalid`);
  }
  return value;
}

function validateParentItem(raw, index, kind) {
  const values = plainRecordValues(raw, [
    'selectedId', 'action', 'path', 'revision', 'ancestorIdentityDigest',
  ], `parent.selected[${index}]`);
  if (!ACTIONS[kind].includes(values.action)) {
    fail(`parent.selected[${index}].action invalid for kind`);
  }
  return Object.freeze({
    selectedId: selectedId(values.selectedId, `parent.selected[${index}].selectedId`),
    action: values.action,
    path: publicMarkdownPath(values.path),
    revision: typeof values.revision === 'string' && REVISION_RE.test(values.revision)
      ? values.revision
      : fail(`parent.selected[${index}].revision invalid`),
    ancestorIdentityDigest: digest(
      values.ancestorIdentityDigest,
      `parent.selected[${index}].ancestorIdentityDigest`
    ),
  });
}

function assertParentSelectionBinding(raw) {
  const values = plainRecordValues(raw, ['schema', 'kind', 'selected'], 'parent selection');
  if (values.schema !== SELECTION_SCHEMA || !KINDS.includes(values.kind)) {
    fail('parent selection identity invalid');
  }
  const selected = densePlainArray(values.selected, 'parent.selected', 1, MAX_ITEMS)
    .map((entry, index) => validateParentItem(entry, index, values.kind));
  if (new Set(selected.map(entry => entry.selectedId)).size !== selected.length ||
      new Set(selected.map(entry => entry.path)).size !== selected.length) {
    fail('parent selection contains duplicate selectedId or path');
  }
  return Object.freeze({
    schema: SELECTION_SCHEMA,
    kind: values.kind,
    selected: Object.freeze(selected),
  });
}

function digestSelection(value) {
  const binding = assertParentSelectionBinding(value);
  try { return evidenceSchema.digestObject(SELECTION_SCHEMA, binding); }
  catch (_) { fail('parent selection cannot be canonically digested'); }
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC') ||
      value.includes('\0') || value.includes('\\') || value.startsWith('/') ||
      /^[A-Za-z]:/u.test(value) || Buffer.byteLength(value, 'utf8') > 4096) {
    fail('phase item path invalid');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/iu.test(parts[parts.length - 1])) fail('phase item path invalid');
  return parts.join('/');
}

function validateItem(raw, index, kind, phase) {
  const values = plainRecordValues(raw, [
    'selectedId', 'path', 'afterRevision', 'ancestorIdentityDigest',
    'createdIdentityDigest', 'creationReceiptDigest', 'quarantineReceiptDigest',
  ], `items[${index}]`);
  const item = {
    selectedId: selectedId(values.selectedId, `items[${index}].selectedId`),
    path: publicMarkdownPath(values.path),
    afterRevision: typeof values.afterRevision === 'string' && REVISION_RE.test(values.afterRevision)
      ? values.afterRevision
      : fail(`items[${index}].afterRevision invalid`),
    ancestorIdentityDigest: digest(
      values.ancestorIdentityDigest,
      `items[${index}].ancestorIdentityDigest`
    ),
    createdIdentityDigest: digest(
      values.createdIdentityDigest,
      `items[${index}].createdIdentityDigest`,
      true
    ),
    creationReceiptDigest: digest(
      values.creationReceiptDigest,
      `items[${index}].creationReceiptDigest`,
      true
    ),
    quarantineReceiptDigest: digest(
      values.quarantineReceiptDigest,
      `items[${index}].quarantineReceiptDigest`,
      true
    ),
  };
  if (kind === 'snapshot_restore') {
    const created = phase !== 'PRECREATE';
    const rollbackQuarantined = [
      'CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK',
    ].includes(phase);
    if ((item.createdIdentityDigest !== null) !== created ||
        (item.creationReceiptDigest !== null) !== created ||
        (item.quarantineReceiptDigest !== null) !== rollbackQuarantined) {
      fail(`items[${index}] restore receipt nullability invalid`);
    }
  } else {
    const quarantined = [
      'QUARANTINED', 'HISTORY_COMMITTED', 'FINALIZED', 'RESTORED',
    ].includes(phase);
    if (item.createdIdentityDigest === null || item.creationReceiptDigest !== null ||
        (item.quarantineReceiptDigest !== null) !== quarantined) {
      fail(`items[${index}] undo receipt nullability invalid`);
    }
  }
  return Object.freeze(item);
}

function assertPhaseRecord(raw, parentRaw) {
  const parent = assertParentSelectionBinding(parentRaw);
  const values = plainRecordValues(raw, [
    'schema', 'operationId', 'kind', 'phase', 'artifactDigest', 'selectionDigest',
    'items', 'preparedHistoryDigest', 'finalReceiptDigest',
    'existingReceiptSetDigest', 'rollbackReceiptDigest', 'updatedAt',
  ], 'public Markdown phase');
  if (values.schema !== SCHEMA || !OPERATION_ID_RE.test(values.operationId || '') ||
      !KINDS.includes(values.kind) || !PHASES.includes(values.phase) ||
      typeof values.updatedAt !== 'string' || Number.isNaN(Date.parse(values.updatedAt))) {
    fail('public Markdown phase identity invalid');
  }
  const allowed = values.kind === 'snapshot_restore'
    ? [
      'PRECREATE', 'CREATED_RECEIPT', 'EXISTING_COMMITTED',
      'CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK',
      'HISTORY_COMMITTED', 'FINALIZED',
    ]
    : ['PRECREATE', 'QUARANTINED', 'HISTORY_COMMITTED', 'FINALIZED', 'RESTORED'];
  if (!allowed.includes(values.phase)) fail('public Markdown phase is invalid for kind');
  if (parent.kind !== values.kind) fail('parent selection kind does not match phase');
  const selectionDigest = digest(values.selectionDigest, 'selectionDigest');
  if (selectionDigest !== digestSelection(parent)) {
    fail('selectionDigest does not bind parent selection');
  }
  const expectedAction = values.kind === 'snapshot_restore' ? 'MISSING' : 'CREATED';
  const expectedItems = parent.selected.filter(entry => entry.action === expectedAction);
  if (!expectedItems.length) fail('phase requires at least one native public-Markdown item');
  const rawItems = densePlainArray(values.items, 'items', expectedItems.length, expectedItems.length);
  const items = rawItems.map((entry, index) => validateItem(
    entry,
    index,
    values.kind,
    values.phase
  ));
  for (let index = 0; index < items.length; index += 1) {
    const actual = items[index];
    const expected = expectedItems[index];
    if (actual.selectedId !== expected.selectedId || actual.path !== expected.path ||
        actual.afterRevision !== expected.revision ||
        actual.ancestorIdentityDigest !== expected.ancestorIdentityDigest) {
      fail('phase items do not equal the parent-derived native subset');
    }
  }
  const preparedRequired = values.kind === 'snapshot_restore'
    ? values.phase !== 'PRECREATE'
    : true;
  const finalized = ['FINALIZED', 'RESTORED'].includes(values.phase);
  const hasExisting = parent.selected.some(entry => entry.action === 'EXISTING');
  const existingRequired = values.kind === 'snapshot_restore' && hasExisting && [
    'EXISTING_COMMITTED', 'CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK',
    'HISTORY_COMMITTED', 'FINALIZED',
  ].includes(values.phase);
  const rollbackRequired = values.kind === 'snapshot_restore' &&
    values.phase === 'ROLLED_BACK';
  if (values.kind === 'snapshot_restore' && !hasExisting && [
    'EXISTING_COMMITTED', 'CREATE_ROLLBACK_QUARANTINED', 'ROLLED_BACK',
  ].includes(values.phase)) {
    fail('full-missing restore cannot enter an existing/rollback phase');
  }
  const valid = Object.freeze({
    schema: SCHEMA,
    operationId: values.operationId,
    kind: values.kind,
    phase: values.phase,
    artifactDigest: digest(values.artifactDigest, 'artifactDigest'),
    selectionDigest,
    items: Object.freeze(items),
    preparedHistoryDigest: digest(
      values.preparedHistoryDigest,
      'preparedHistoryDigest',
      !preparedRequired
    ),
    finalReceiptDigest: digest(values.finalReceiptDigest, 'finalReceiptDigest', !finalized),
    existingReceiptSetDigest: digest(
      values.existingReceiptSetDigest,
      'existingReceiptSetDigest',
      !existingRequired
    ),
    rollbackReceiptDigest: digest(
      values.rollbackReceiptDigest,
      'rollbackReceiptDigest',
      !rollbackRequired
    ),
    updatedAt: values.updatedAt,
  });
  if ((!preparedRequired && valid.preparedHistoryDigest !== null) ||
      (!finalized && valid.finalReceiptDigest !== null) ||
      (!existingRequired && valid.existingReceiptSetDigest !== null) ||
      (!rollbackRequired && valid.rollbackReceiptDigest !== null)) {
    fail('public Markdown phase digest nullability invalid');
  }
  return valid;
}

function assertTransition(previousRaw, nextRaw, parentRaw, nextParentRaw = parentRaw) {
  const previousParent = assertParentSelectionBinding(parentRaw);
  const nextParent = assertParentSelectionBinding(nextParentRaw);
  const previous = assertPhaseRecord(previousRaw, previousParent);
  const next = assertPhaseRecord(nextRaw, nextParent);
  const hasExisting = previousParent.selected.some(entry => entry.action === 'EXISTING');
  const routes = previous.kind === 'snapshot_restore'
    ? {
      PRECREATE: ['CREATED_RECEIPT'],
      CREATED_RECEIPT: hasExisting
        ? ['EXISTING_COMMITTED', 'CREATE_ROLLBACK_QUARANTINED']
        : ['HISTORY_COMMITTED'],
      EXISTING_COMMITTED: ['HISTORY_COMMITTED'],
      CREATE_ROLLBACK_QUARANTINED: ['ROLLED_BACK'],
      HISTORY_COMMITTED: ['FINALIZED'],
    }
    : {
      PRECREATE: ['QUARANTINED'],
      QUARANTINED: ['HISTORY_COMMITTED', 'RESTORED'],
      HISTORY_COMMITTED: ['FINALIZED'],
    };
  if (next.operationId !== previous.operationId || next.kind !== previous.kind ||
      next.artifactDigest !== previous.artifactDigest ||
      next.selectionDigest !== previous.selectionDigest ||
      !routes[previous.phase]?.includes(next.phase) ||
      Date.parse(next.updatedAt) < Date.parse(previous.updatedAt) ||
      digestSelection(previousParent) !== digestSelection(nextParent) ||
      next.items.length !== previous.items.length) {
    fail('public Markdown phase transition invalid');
  }
  for (let index = 0; index < previous.items.length; index += 1) {
    const before = previous.items[index];
    const after = next.items[index];
    if (after.selectedId !== before.selectedId || after.path !== before.path ||
        after.afterRevision !== before.afterRevision ||
        after.ancestorIdentityDigest !== before.ancestorIdentityDigest ||
        (before.createdIdentityDigest !== null &&
         after.createdIdentityDigest !== before.createdIdentityDigest) ||
        (before.creationReceiptDigest !== null &&
         after.creationReceiptDigest !== before.creationReceiptDigest) ||
        (before.quarantineReceiptDigest !== null &&
         after.quarantineReceiptDigest !== before.quarantineReceiptDigest)) {
      fail('public Markdown phase authority changed across transition');
    }
  }
  if (previous.preparedHistoryDigest !== null &&
      next.preparedHistoryDigest !== previous.preparedHistoryDigest) {
    fail('prepared History digest changed across transition');
  }
  if (previous.existingReceiptSetDigest !== null &&
      next.existingReceiptSetDigest !== previous.existingReceiptSetDigest) {
    fail('existing receipt-set digest changed across transition');
  }
  if (previous.rollbackReceiptDigest !== null &&
      next.rollbackReceiptDigest !== previous.rollbackReceiptDigest) {
    fail('rollback receipt digest changed across transition');
  }
  return next;
}

module.exports = Object.freeze({
  SCHEMA,
  SELECTION_SCHEMA,
  KINDS,
  PHASES,
  ACTIONS,
  MAX_ITEMS,
  SnapshotPublicMarkdownPhaseError,
  assertParentSelectionBinding,
  digestSelection,
  assertPhaseRecord,
  assertTransition,
});
