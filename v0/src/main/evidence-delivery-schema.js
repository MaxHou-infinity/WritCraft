'use strict';

const crypto = require('crypto');

const DIGEST_DOMAIN = Buffer.from('writcraft-digest/v1', 'utf8');
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PROJECT_INSTANCE_RE = /^instance_[a-f0-9]{24}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const C0_RE = /[\u0000-\u001f]/u;
const TRANSACTION_STATES = Object.freeze(['PREPARING', 'UNCOMMITTED', 'COMMITTED', 'UNKNOWN']);
const LOCAL_TASK_KINDS = Object.freeze([
  'SNAPSHOT_CREATE', 'SNAPSHOT_COMPARE', 'SNAPSHOT_RESTORE', 'SNAPSHOT_DELETE',
]);
const LOCAL_TASK_STATUSES = Object.freeze(['queued', 'running', 'cancelling', 'completed', 'failed']);
const LOCAL_TASK_STAGES = Object.freeze([
  'preparing', 'settling_watcher', 'scanning_sources', 'writing_private_bundle',
  'publishing_bundle', 'reconciling', 'reading_snapshot', 'comparing',
  'preparing_restore', 'restoring_markdown', 'quarantining_snapshot',
  'deleting_snapshot', 'completed',
]);
const TERMINAL_TRUTHS = Object.freeze(['UNCOMMITTED', 'COMMITTED', 'COMMITTED_RISK', 'UNKNOWN']);
const PRECOMMIT_LOCAL_TASK_STAGES = Object.freeze([
  'preparing', 'settling_watcher', 'scanning_sources', 'writing_private_bundle',
  'reading_snapshot', 'comparing', 'preparing_restore',
]);
const SNAPSHOT_LIMITS = Object.freeze({
  maxMarkdownFiles: 300,
  maxImageFiles: 200,
  maxTotalItems: 500,
  maxMarkdownFileBytes: 4 * 1024 * 1024,
  maxMarkdownTotalBytes: 64 * 1024 * 1024,
  maxImageFileBytes: 25 * 1024 * 1024,
  maxSnapshotBytes: 512 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxControlRecordBytes: 1024 * 1024,
  maxPrivateMetadataBytes: 8 * 1024 * 1024,
});
const SNAPSHOT_RESTORE_HISTORY_LIMITS = Object.freeze({
  maxFiles: 300,
  maxAfterBytes: 64 * 1024 * 1024,
  maxBeforeAndAfterBytes: 128 * 1024 * 1024,
  maxCanonicalRecordBytes: 192 * 1024 * 1024,
});
const CHANGES_V4_LIMITS = Object.freeze({
  maxEntries: 100,
  maxCanonicalDocumentBytes: 192 * 1024 * 1024,
});

const SCHEMAS = Object.freeze({
  SNAPSHOT: 'writcraft.snapshot/v1',
  SNAPSHOT_FILE_REVISION_SET: 'writcraft.file-revision-set/v1',
  SNAPSHOT_BUNDLE_ENTRY: 'writcraft.snapshot-bundle-entry/v1',
  SNAPSHOT_ENTRY_BINDING: 'writcraft.snapshot-entry-binding/v1',
  SNAPSHOT_TRANSACTION: 'writcraft.snapshot-transaction/v1',
  SNAPSHOT_RECEIPT: 'writcraft.snapshot-receipt/v1',
  SNAPSHOT_RECOVERY: 'writcraft.snapshot-recovery/v1',
  SNAPSHOT_DELETE_TRANSACTION: 'writcraft.snapshot-delete-transaction/v1',
  SNAPSHOT_DELETE_RECEIPT: 'writcraft.snapshot-delete-receipt/v1',
  SNAPSHOT_DELETE_RECOVERY: 'writcraft.snapshot-delete-recovery/v1',
  SNAPSHOT_COMPARISON: 'writcraft.snapshot-comparison/v1',
  LOCAL_CAPABILITY: 'writcraft.local-capability/v1',
  SNAPSHOT_COMPARE_SELECTION: 'writcraft.snapshot-compare-selection/v1',
  SNAPSHOT_RESTORE_SELECTION: 'writcraft.snapshot-restore-selection/v1',
  SNAPSHOT_DELETE_SELECTION: 'writcraft.snapshot-delete-selection/v1',
  ROOT_IDENTITY: 'writcraft.root-identity/v1',
  ANCESTOR_IDENTITY: 'writcraft.ancestor-identity/v1',
  OBJECT_IDENTITY: 'writcraft.object-identity/v1',
  SNAPSHOT_PRIVATE_PARENT_IDENTITY: 'writcraft.snapshot-private-parent-identity/v1',
  SNAPSHOT_STAGE_IDENTITY: 'writcraft.snapshot-stage-identity/v1',
  SNAPSHOT_PUBLISHED_IDENTITY: 'writcraft.snapshot-published-identity/v1',
  SNAPSHOT_QUARANTINE_IDENTITY: 'writcraft.snapshot-quarantine-identity/v1',
  RESTORE_CREATED_IDENTITY: 'writcraft.restore-created-identity/v1',
  SNAPSHOT_RESTORE_RESULT: 'writcraft.snapshot-restore-result/v1',
  CHANGES_V4: 'writcraft.changes/v4',
  SNAPSHOT_RESTORE_HISTORY: 'writcraft.snapshot-restore-history/v1',
  SNAPSHOT_LIST: 'writcraft.snapshot-list/v1',
  SNAPSHOT_DELETE_PREFLIGHT: 'writcraft.snapshot-delete-preflight/v1',
  SNAPSHOT_RESTORE_PREFLIGHT: 'writcraft.snapshot-restore-preflight/v1',
  SNAPSHOT_COMPARISON_PUBLIC: 'writcraft.snapshot-comparison-public/v1',
  SNAPSHOT_DIFF: 'writcraft.snapshot-diff/v1',
  LOCAL_TASK: 'writcraft.local-task/v1',
  SNAPSHOT_LIST_REQUEST: 'writcraft.snapshot-list-request/v1',
  SNAPSHOT_CREATE_REQUEST: 'writcraft.snapshot-create-request/v1',
  SNAPSHOT_COMPARE_REQUEST: 'writcraft.snapshot-compare-request/v1',
  SNAPSHOT_DIFF_REQUEST: 'writcraft.snapshot-diff-request/v1',
  SNAPSHOT_RESTORE_PREPARE_REQUEST: 'writcraft.snapshot-restore-prepare-request/v1',
  SNAPSHOT_RESTORE_REQUEST: 'writcraft.snapshot-restore-request/v1',
  SNAPSHOT_DELETE_PREPARE_REQUEST: 'writcraft.snapshot-delete-prepare-request/v1',
  SNAPSHOT_DELETE_REQUEST: 'writcraft.snapshot-delete-request/v1',
  LOCAL_TASK_CANCEL_REQUEST: 'writcraft.local-task-cancel-request/v1',
});

const KEYS = Object.freeze({
  SNAPSHOT: Object.freeze([
    'schema', 'projectInstanceId', 'snapshotId', 'createdAt',
    'creationMutationGeneration', 'rootIdentityDigest', 'files',
    'fileRevisionSetDigest', 'budgets', 'producerVersion', 'snapshotManifestDigest',
  ]),
  SNAPSHOT_FILE: Object.freeze([
    'fileId', 'path', 'kind', 'mode', 'byteLength', 'sha256', 'revision',
    'ancestorIdentityDigest', 'sourceObjectIdentityDigest', 'bundleObjectDigest', 'references',
  ]),
  BUDGETS: Object.freeze(['limits', 'observed']),
  LIMITS: Object.freeze([
    'maxMarkdownFiles', 'maxImageFiles', 'maxTotalItems', 'maxMarkdownFileBytes',
    'maxMarkdownTotalBytes', 'maxImageFileBytes', 'maxSnapshotBytes',
    'maxManifestBytes', 'maxControlRecordBytes', 'maxPrivateMetadataBytes',
  ]),
  OBSERVED: Object.freeze([
    'markdownFiles', 'imageFiles', 'totalItems', 'markdownBytes', 'imageBytes',
    'snapshotBytes', 'manifestBytes', 'privateMetadataBytes',
  ]),
  REFERENCE: Object.freeze(['fromFileId', 'tokenOrdinal', 'locatorDigest']),
  FILE_REVISION_SET: Object.freeze(['schema', 'items']),
  FILE_REVISION_ITEM: Object.freeze(['fileId', 'path', 'revision', 'sha256']),
  BUNDLE_ENTRY: Object.freeze(['schema', 'fileId', 'path', 'kind', 'byteLength', 'sha256']),
  ENTRY_BINDING: Object.freeze([
    'schema', 'snapshotId', 'bundlePayloadSha256', 'fileId', 'bundleObjectDigest',
    'contentOffset', 'contentLength', 'entryBindingDigest',
  ]),
  ROOT_IDENTITY: Object.freeze(['schema', 'dev', 'ino', 'uid', 'mode']),
  ANCESTOR_IDENTITY: Object.freeze(['schema', 'components']),
  ANCESTOR_COMPONENT: Object.freeze(['nameSha256', 'dev', 'ino', 'uid', 'mode']),
  OBJECT_IDENTITY: Object.freeze([
    'schema', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs',
    'ctimeNs', 'contentSha256',
  ]),
  PRIVATE_PARENT_IDENTITY: Object.freeze([
    'schema', 'role', 'rootIdentityDigest', 'dev', 'ino', 'uid', 'mode',
  ]),
  STAGE_IDENTITY: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'parentIdentityDigest',
    'stageBasenameSha256', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size',
    'bundlePayloadSha256', 'snapshotManifestDigest',
  ]),
  PUBLISHED_IDENTITY: Object.freeze([
    'schema', 'snapshotId', 'parentIdentityDigest', 'finalBasenameSha256',
    'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'bundlePayloadSha256',
    'snapshotManifestDigest',
  ]),
  QUARANTINE_IDENTITY: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'parentIdentityDigest',
    'quarantineBasenameSha256', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size',
    'bundlePayloadSha256', 'snapshotManifestDigest',
  ]),
  RESTORE_CREATED_IDENTITY: Object.freeze([
    'schema', 'parentIdentityDigest', 'leafNameSha256', 'dev', 'ino', 'uid',
    'mode', 'nlink', 'size', 'contentSha256',
  ]),
  SNAPSHOT_TRANSACTION: Object.freeze([
    'schema', 'transactionId', 'projectInstanceId', 'snapshotId', 'ownerGeneration',
    'state', 'stageIdentityDigest', 'snapshotManifestDigest', 'createdAt', 'updatedAt',
    'receiptDigest', 'lastErrorCode',
  ]),
  SNAPSHOT_RECEIPT: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'publishedIdentityDigest',
    'snapshotManifestDigest', 'directoryFsyncComplete', 'committedAt', 'receiptDigest',
  ]),
  SNAPSHOT_RECOVERY: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'expectedManifestDigest',
    'expectedPublishedIdentityDigest', 'state', 'updatedAt', 'markerDigest',
  ]),
  DELETE_TRANSACTION: Object.freeze([
    'schema', 'transactionId', 'projectInstanceId', 'snapshotId', 'ownerGeneration',
    'state', 'sourceIdentityDigest', 'quarantineIdentityDigest', 'snapshotManifestDigest',
    'createdAt', 'updatedAt', 'receiptDigest', 'lastErrorCode',
  ]),
  DELETE_RECEIPT: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'deletedIdentityDigest',
    'snapshotManifestDigest', 'directoryFsyncComplete', 'committedAt', 'receiptDigest',
  ]),
  DELETE_RECOVERY: Object.freeze([
    'schema', 'transactionId', 'snapshotId', 'expectedManifestDigest',
    'expectedDeletedIdentityDigest', 'state', 'updatedAt', 'markerDigest',
  ]),
  COMPARISON: Object.freeze([
    'schema', 'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
    'currentMutationGeneration', 'currentFileRevisionSetDigest', 'items',
    'createdAt', 'comparisonDigest',
  ]),
  COMPARISON_ITEM: Object.freeze([
    'fileId', 'kind', 'status', 'snapshotRevision', 'currentRevision',
    'snapshotSha256', 'currentSha256', 'byteDelta', 'diffId',
  ]),
  CAPABILITY: Object.freeze([
    'schema', 'capabilityId', 'kind', 'projectInstanceId', 'ownerGeneration',
    'subjectId', 'authorityDigest', 'selectionDigest', 'issuedAt', 'expiresAt',
    'singleUse', 'consumedAt',
  ]),
  RESTORE_RESULT: Object.freeze([
    'schema', 'projectInstanceId', 'snapshotId', 'restoreCapabilityId', 'task', 'history',
  ]),
  RESTORE_HISTORY_RESULT: Object.freeze([
    'operationId', 'outcome', 'status', 'affectedPaths', 'historyEntryId',
    'recoveryRequired', 'responseRecovered', 'committedWarning',
  ]),
  HISTORY_V4_FILE: Object.freeze([
    'path', 'summary', 'before', 'after', 'createdIdentityDigest',
  ]),
  HISTORY_V4_STATE: Object.freeze([
    'exists', 'revision', 'contentHash', 'byteLength', 'encoding', 'data',
  ]),
  HISTORY_V4_ACCOUNTING_FILE: Object.freeze([
    'path', 'summary', 'beforeExists', 'beforeByteLength', 'afterByteLength',
    'createdIdentityDigest',
  ]),
  HISTORY_V4_DOCUMENT: Object.freeze(['schema', 'entries']),
  HISTORY_V4_SNAPSHOT_RESTORE_ENTRY: Object.freeze([
    'id', 'kind', 'changeSetId', 'status', 'appliedAt', 'files',
    'provenance', 'integrity',
  ]),
  HISTORY_V4_SNAPSHOT_RESTORE_UNDONE_ENTRY: Object.freeze([
    'id', 'kind', 'changeSetId', 'status', 'appliedAt', 'files',
    'provenance', 'undoneAt', 'integrity',
  ]),
  HISTORY_V4_SNAPSHOT_RESTORE_PROVENANCE: Object.freeze([
    'schema', 'snapshotId', 'snapshotManifestDigest', 'restoreCapabilityId',
    'comparisonDigest', 'selectedIds',
  ]),
  LOCAL_TASK: Object.freeze([
    'schema', 'taskId', 'projectInstanceId', 'kind', 'stage', 'status',
    'startedAt', 'elapsedMs', 'cancelAvailable', 'terminalTruth', 'errorCode',
  ]),
});

class EvidenceDeliverySchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceDeliverySchemaError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceDeliverySchemaError(code, message);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(value, field, options = {}) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || C0_RE.test(value)) {
    fail('INVALID_CANONICAL_VALUE', `${field} 不是安全 Unicode 文本`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  const scalars = Array.from(value).length;
  if ((options.ascii === true && /[^\x20-\x7e]/u.test(value)) ||
      (Number.isSafeInteger(options.minBytes) && bytes < options.minBytes) ||
      (Number.isSafeInteger(options.maxBytes) && bytes > options.maxBytes) ||
      (Number.isSafeInteger(options.maxScalars) && scalars > options.maxScalars) ||
      (options.pattern && !options.pattern.test(value))) {
    fail('INVALID_CANONICAL_VALUE', `${field} 超出冻结边界`);
  }
  return value;
}

function assertSafeInteger(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_CANONICAL_VALUE', `${field} 必须是安全整数`);
  }
  return value;
}

function compareUnicodeCodePoints(left, right) {
  const a = Array.from(left, character => character.codePointAt(0));
  const b = Array.from(right, character => character.codePointAt(0));
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

function compareUtf8Bytes(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertPlainRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Reflect.ownKeys(value).length !== Object.keys(value).length) {
    fail('INVALID_CANONICAL_VALUE', `${field} 必须是普通对象`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    assertString(key, `${field} key`);
    if (FORBIDDEN_KEYS.has(key) || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true) {
      fail('INVALID_CANONICAL_VALUE', `${field} 包含不安全字段`);
    }
  }
  return descriptors;
}

function assertExactKeys(value, expected, field = 'value') {
  const descriptors = assertPlainRecord(value, field);
  const actual = Object.keys(descriptors).sort(compareUnicodeCodePoints);
  const wanted = [...expected].sort(compareUnicodeCodePoints);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_SCHEMA_KEYS', `${field} 包含未知或缺失字段`);
  }
  return value;
}

function canonicalJson(value) {
  const ancestors = new Set();
  let nodes = 0;

  function encode(current, field) {
    if (current === null) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'string') {
      assertString(current, field);
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      assertSafeInteger(current, field, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      return String(current);
    }
    if (!current || typeof current !== 'object') {
      fail('INVALID_CANONICAL_VALUE', `${field} 包含不可序列化值`);
    }
    nodes += 1;
    if (nodes > 100000 || ancestors.has(current)) {
      fail('INVALID_CANONICAL_VALUE', `${field} 结构过大或包含循环`);
    }
    ancestors.add(current);
    let result;
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length !== 0 ||
          Object.getOwnPropertyNames(current).length !== current.length + 1 ||
          Object.keys(current).length !== current.length) {
        fail('INVALID_CANONICAL_VALUE', `${field} 必须是稠密普通数组`);
      }
      result = `[${current.map((item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          fail('INVALID_CANONICAL_VALUE', `${field}[${index}] 不是普通值`);
        }
        return encode(descriptor.value, `${field}[${index}]`);
      }).join(',')}]`;
    } else {
      const descriptors = assertPlainRecord(current, field);
      const keys = Object.keys(descriptors).sort(compareUnicodeCodePoints);
      result = `{${keys.map(key =>
        `${JSON.stringify(key)}:${encode(descriptors[key].value, `${field}.${key}`)}`
      ).join(',')}}`;
    }
    ancestors.delete(current);
    return result;
  }

  return encode(value, 'value');
}

function canonicalJsonByteLength(value) {
  const ancestors = new Set();
  let nodes = 0;

  function measure(current, field) {
    if (current === null) return 4;
    if (typeof current === 'boolean') return current ? 4 : 5;
    if (typeof current === 'string') {
      assertString(current, field);
      return Buffer.byteLength(JSON.stringify(current), 'utf8');
    }
    if (typeof current === 'number') {
      assertSafeInteger(current, field, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      return Buffer.byteLength(String(current), 'ascii');
    }
    if (!current || typeof current !== 'object') {
      fail('INVALID_CANONICAL_VALUE', `${field} 包含不可序列化值`);
    }
    nodes += 1;
    if (nodes > 100000 || ancestors.has(current)) {
      fail('INVALID_CANONICAL_VALUE', `${field} 结构过大或包含循环`);
    }
    ancestors.add(current);
    let bytes = 2;
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length !== 0 ||
          Object.getOwnPropertyNames(current).length !== current.length + 1 ||
          Object.keys(current).length !== current.length) {
        fail('INVALID_CANONICAL_VALUE', `${field} 必须是稠密普通数组`);
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          fail('INVALID_CANONICAL_VALUE', `${field}[${index}] 不是普通值`);
        }
        if (index > 0) bytes += 1;
        bytes += measure(descriptor.value, `${field}[${index}]`);
      }
    } else {
      const descriptors = assertPlainRecord(current, field);
      const keys = Object.keys(descriptors).sort(compareUnicodeCodePoints);
      for (const [index, key] of keys.entries()) {
        if (index > 0) bytes += 1;
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
        bytes += measure(descriptors[key].value, `${field}.${key}`);
      }
    }
    ancestors.delete(current);
    return bytes;
  }

  return measure(value, 'value');
}

function historyJsonByteLength(value) {
  const ancestors = new Set();
  let nodes = 0;

  function measure(current, field) {
    if (current === null) return 4;
    if (typeof current === 'boolean') return current ? 4 : 5;
    if (typeof current === 'string') {
      if (hasUnpairedSurrogate(current)) {
        fail('INVALID_CHANGES_V4_ENVELOPE', `${field} 包含无配对 surrogate`);
      }
      return Buffer.byteLength(JSON.stringify(current), 'utf8');
    }
    if (typeof current === 'number') {
      assertSafeInteger(current, field, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      return Buffer.byteLength(String(current), 'ascii');
    }
    if (!current || typeof current !== 'object') {
      fail('INVALID_CHANGES_V4_ENVELOPE', `${field} 包含不可序列化值`);
    }
    nodes += 1;
    if (nodes > 100000 || ancestors.has(current)) {
      fail('INVALID_CHANGES_V4_ENVELOPE', `${field} 结构过大或包含循环`);
    }
    ancestors.add(current);
    let bytes = 2;
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length !== 0 ||
          Object.getOwnPropertyNames(current).length !== current.length + 1 ||
          Object.keys(current).length !== current.length) {
        fail('INVALID_CHANGES_V4_ENVELOPE', `${field} 必须是稠密普通数组`);
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          fail('INVALID_CHANGES_V4_ENVELOPE', `${field}[${index}] 不是普通值`);
        }
        if (index > 0) bytes += 1;
        bytes += measure(descriptor.value, `${field}[${index}]`);
      }
    } else {
      const descriptors = assertPlainRecord(current, field);
      const keys = Object.keys(descriptors);
      for (const [index, key] of keys.entries()) {
        if (index > 0) bytes += 1;
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 1;
        bytes += measure(descriptors[key].value, `${field}.${key}`);
      }
    }
    ancestors.delete(current);
    return bytes;
  }

  return measure(value, 'changes/v4 document');
}

function cloneWithoutOwnField(value, field) {
  const descriptors = assertPlainRecord(value, 'digest object');
  if (!Object.hasOwn(descriptors, field)) {
    fail('INVALID_DIGEST_INPUT', `摘要对象缺少 ${field}`);
  }
  const clone = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key !== field) clone[key] = descriptor.value;
  }
  return clone;
}

function digestPreimage(schema, value, digestField = null) {
  assertString(schema, 'schema', { ascii: true, minBytes: 1, maxBytes: 96 });
  const descriptors = assertPlainRecord(value, 'digest object');
  if (!Object.hasOwn(descriptors, 'schema') || descriptors.schema.value !== schema) {
    fail('INVALID_DIGEST_INPUT', '摘要 schema 与 payload 不一致');
  }
  const payload = digestField === null ? value : cloneWithoutOwnField(value, digestField);
  return Buffer.concat([
    DIGEST_DOMAIN,
    Buffer.from([0]),
    Buffer.from(schema, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalJson(payload), 'utf8'),
  ]);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestObject(schema, value, digestField = null) {
  return sha256(digestPreimage(schema, value, digestField));
}

function assertDigest(value, field = 'digest') {
  return assertString(value, field, { ascii: true, pattern: SHA256_RE });
}

function assertProjectInstanceId(value) {
  return assertString(value, 'projectInstanceId', {
    ascii: true,
    pattern: PROJECT_INSTANCE_RE,
  });
}

function assertOpaqueId(value, field = 'opaqueId') {
  return assertString(value, field, { ascii: true, pattern: OPAQUE_ID_RE });
}

function unsignedDecimal(value, field = 'unsigned') {
  if (typeof value !== 'bigint' || value < 0n) {
    fail('INVALID_CANONICAL_VALUE', `${field} 必须是非负 bigint`);
  }
  return value.toString(10);
}

function assertUnsignedDecimal(value, field = 'unsigned') {
  return assertString(value, field, {
    ascii: true,
    pattern: /^(?:0|[1-9][0-9]*)$/,
  });
}

function createFileRevisionSetDigest(items) {
  if (!Array.isArray(items) || items.length > 500) {
    fail('INVALID_FILE_REVISION_SET', '文件 revision 集合无效');
  }
  const normalized = items.map((item, index) => {
    assertExactKeys(item, KEYS.FILE_REVISION_ITEM, `items[${index}]`);
    assertOpaqueId(item.fileId, `items[${index}].fileId`);
    assertString(item.path, `items[${index}].path`, { minBytes: 1, maxBytes: 4096, maxScalars: 1024 });
    assertString(item.revision, `items[${index}].revision`, { ascii: true, pattern: /^[a-f0-9]{64}$/ });
    assertDigest(item.sha256, `items[${index}].sha256`);
    return Object.freeze({ ...item });
  }).sort((left, right) => compareUtf8Bytes(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path ||
        normalized[index - 1].fileId === normalized[index].fileId) {
      fail('INVALID_FILE_REVISION_SET', '文件 revision 集合包含重复身份');
    }
  }
  const payload = { schema: SCHEMAS.SNAPSHOT_FILE_REVISION_SET, items: normalized };
  return Object.freeze({
    payload: Object.freeze(payload),
    digest: digestObject(SCHEMAS.SNAPSHOT_FILE_REVISION_SET, payload),
  });
}

function nullableDigest(value, field) {
  if (value === null) return null;
  return assertDigest(value, field);
}

function nullableErrorCode(value, field = 'lastErrorCode') {
  if (value === null) return null;
  return assertString(value, field, {
    ascii: true,
    minBytes: 1,
    maxBytes: 96,
    pattern: /^[A-Z][A-Z0-9_]*$/,
  });
}

function assertTimestamp(value, field) {
  assertString(value, field, { ascii: true, minBytes: 1, maxBytes: 96 });
  if (Number.isNaN(Date.parse(value))) fail('INVALID_CANONICAL_VALUE', `${field} 时间无效`);
  return value;
}

function assertMode(value, field) {
  return assertSafeInteger(value, field, 0, 0xffff);
}

function assertRootIdentity(value) {
  assertExactKeys(value, KEYS.ROOT_IDENTITY, 'root identity');
  if (value.schema !== SCHEMAS.ROOT_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'root identity schema 无效');
  }
  assertUnsignedDecimal(value.dev, 'root identity.dev');
  assertUnsignedDecimal(value.ino, 'root identity.ino');
  assertSafeInteger(value.uid, 'root identity.uid');
  assertMode(value.mode, 'root identity.mode');
  return value;
}

function digestRootIdentity(value) {
  assertRootIdentity(value);
  return digestObject(SCHEMAS.ROOT_IDENTITY, value);
}

function assertAncestorIdentity(value) {
  assertExactKeys(value, KEYS.ANCESTOR_IDENTITY, 'ancestor identity');
  if (value.schema !== SCHEMAS.ANCESTOR_IDENTITY ||
      !Array.isArray(value.components) || value.components.length > 1024) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'ancestor identity schema/components 无效');
  }
  for (const [index, component] of value.components.entries()) {
    assertExactKeys(component, KEYS.ANCESTOR_COMPONENT, `ancestor identity.components[${index}]`);
    assertDigest(component.nameSha256, `ancestor identity.components[${index}].nameSha256`);
    assertUnsignedDecimal(component.dev, `ancestor identity.components[${index}].dev`);
    assertUnsignedDecimal(component.ino, `ancestor identity.components[${index}].ino`);
    assertSafeInteger(component.uid, `ancestor identity.components[${index}].uid`);
    assertMode(component.mode, `ancestor identity.components[${index}].mode`);
  }
  return value;
}

function digestAncestorIdentity(value) {
  assertAncestorIdentity(value);
  return digestObject(SCHEMAS.ANCESTOR_IDENTITY, value);
}

function assertObjectIdentity(value) {
  assertExactKeys(value, KEYS.OBJECT_IDENTITY, 'object identity');
  if (value.schema !== SCHEMAS.OBJECT_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'object identity schema 无效');
  }
  assertUnsignedDecimal(value.dev, 'object identity.dev');
  assertUnsignedDecimal(value.ino, 'object identity.ino');
  assertSafeInteger(value.uid, 'object identity.uid');
  assertMode(value.mode, 'object identity.mode');
  assertSafeInteger(value.nlink, 'object identity.nlink', 1);
  assertUnsignedDecimal(value.size, 'object identity.size');
  assertUnsignedDecimal(value.mtimeNs, 'object identity.mtimeNs');
  assertUnsignedDecimal(value.ctimeNs, 'object identity.ctimeNs');
  assertDigest(value.contentSha256, 'object identity.contentSha256');
  return value;
}

function digestObjectIdentity(value) {
  assertObjectIdentity(value);
  return digestObject(SCHEMAS.OBJECT_IDENTITY, value);
}

function assertPrivateFileIdentityFields(value, field) {
  assertUnsignedDecimal(value.dev, `${field}.dev`);
  assertUnsignedDecimal(value.ino, `${field}.ino`);
  assertSafeInteger(value.uid, `${field}.uid`);
  assertMode(value.mode, `${field}.mode`);
  assertSafeInteger(value.nlink, `${field}.nlink`);
  assertUnsignedDecimal(value.size, `${field}.size`);
  if (value.mode !== 0o600) fail('INVALID_SNAPSHOT_IDENTITY', `${field}.mode 必须是 0600`);
  if (value.nlink !== 1) fail('INVALID_SNAPSHOT_IDENTITY', `${field}.nlink 必须是 1`);
}

function assertPublicLeafIdentityFields(value, field) {
  assertUnsignedDecimal(value.dev, `${field}.dev`);
  assertUnsignedDecimal(value.ino, `${field}.ino`);
  assertSafeInteger(value.uid, `${field}.uid`);
  assertMode(value.mode, `${field}.mode`);
  assertSafeInteger(value.nlink, `${field}.nlink`);
  assertUnsignedDecimal(value.size, `${field}.size`);
  if (value.nlink !== 1) fail('INVALID_SNAPSHOT_IDENTITY', `${field}.nlink 必须是 1`);
}

function assertSnapshotPrivateParentIdentity(value) {
  assertExactKeys(value, KEYS.PRIVATE_PARENT_IDENTITY, 'snapshot private parent identity');
  if (value.schema !== SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot private parent identity schema 无效');
  }
  assertString(value.role, 'snapshot private parent identity.role', {
    ascii: true,
    pattern: /^(?:control|bundles|quarantine)$/,
  });
  assertDigest(value.rootIdentityDigest, 'snapshot private parent identity.rootIdentityDigest');
  assertUnsignedDecimal(value.dev, 'snapshot private parent identity.dev');
  assertUnsignedDecimal(value.ino, 'snapshot private parent identity.ino');
  assertSafeInteger(value.uid, 'snapshot private parent identity.uid');
  assertMode(value.mode, 'snapshot private parent identity.mode');
  if (value.mode !== 0o700) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot private parent identity.mode 必须是 0700');
  }
  return value;
}

function digestSnapshotPrivateParentIdentity(value) {
  assertSnapshotPrivateParentIdentity(value);
  return digestObject(SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY, value);
}

function assertSnapshotStageIdentity(value, parentIdentity) {
  assertExactKeys(value, KEYS.STAGE_IDENTITY, 'snapshot stage identity');
  if (value.schema !== SCHEMAS.SNAPSHOT_STAGE_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot stage identity schema 无效');
  }
  assertOpaqueId(value.transactionId, 'snapshot stage identity.transactionId');
  assertOpaqueId(value.snapshotId, 'snapshot stage identity.snapshotId');
  assertDigest(value.parentIdentityDigest, 'snapshot stage identity.parentIdentityDigest');
  assertDigest(value.stageBasenameSha256, 'snapshot stage identity.stageBasenameSha256');
  assertPrivateFileIdentityFields(value, 'snapshot stage identity');
  assertDigest(value.bundlePayloadSha256, 'snapshot stage identity.bundlePayloadSha256');
  assertDigest(value.snapshotManifestDigest, 'snapshot stage identity.snapshotManifestDigest');
  assertSnapshotPrivateParentIdentity(parentIdentity);
  if (parentIdentity.role !== 'control' ||
      value.parentIdentityDigest !== digestSnapshotPrivateParentIdentity(parentIdentity)) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot stage identity parent 必须绑定 control identity');
  }
  return value;
}

function digestSnapshotStageIdentity(value, parentIdentity) {
  assertSnapshotStageIdentity(value, parentIdentity);
  return digestObject(SCHEMAS.SNAPSHOT_STAGE_IDENTITY, value);
}

function assertSnapshotPublishedIdentity(value, parentIdentity) {
  assertExactKeys(value, KEYS.PUBLISHED_IDENTITY, 'snapshot published identity');
  if (value.schema !== SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot published identity schema 无效');
  }
  assertOpaqueId(value.snapshotId, 'snapshot published identity.snapshotId');
  assertDigest(value.parentIdentityDigest, 'snapshot published identity.parentIdentityDigest');
  assertDigest(value.finalBasenameSha256, 'snapshot published identity.finalBasenameSha256');
  assertPrivateFileIdentityFields(value, 'snapshot published identity');
  assertDigest(value.bundlePayloadSha256, 'snapshot published identity.bundlePayloadSha256');
  assertDigest(value.snapshotManifestDigest, 'snapshot published identity.snapshotManifestDigest');
  assertSnapshotPrivateParentIdentity(parentIdentity);
  if (parentIdentity.role !== 'bundles' ||
      value.parentIdentityDigest !== digestSnapshotPrivateParentIdentity(parentIdentity)) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot published identity parent 必须绑定 bundles identity');
  }
  return value;
}

function digestSnapshotPublishedIdentity(value, parentIdentity) {
  assertSnapshotPublishedIdentity(value, parentIdentity);
  return digestObject(SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY, value);
}

function assertSnapshotQuarantineIdentity(value, parentIdentity) {
  assertExactKeys(value, KEYS.QUARANTINE_IDENTITY, 'snapshot quarantine identity');
  if (value.schema !== SCHEMAS.SNAPSHOT_QUARANTINE_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot quarantine identity schema 无效');
  }
  assertOpaqueId(value.transactionId, 'snapshot quarantine identity.transactionId');
  assertOpaqueId(value.snapshotId, 'snapshot quarantine identity.snapshotId');
  assertDigest(value.parentIdentityDigest, 'snapshot quarantine identity.parentIdentityDigest');
  assertDigest(value.quarantineBasenameSha256, 'snapshot quarantine identity.quarantineBasenameSha256');
  assertPrivateFileIdentityFields(value, 'snapshot quarantine identity');
  assertDigest(value.bundlePayloadSha256, 'snapshot quarantine identity.bundlePayloadSha256');
  assertDigest(value.snapshotManifestDigest, 'snapshot quarantine identity.snapshotManifestDigest');
  assertSnapshotPrivateParentIdentity(parentIdentity);
  if (parentIdentity.role !== 'quarantine' ||
      value.parentIdentityDigest !== digestSnapshotPrivateParentIdentity(parentIdentity)) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'snapshot quarantine identity parent 必须绑定 quarantine identity');
  }
  return value;
}

function digestSnapshotQuarantineIdentity(value, parentIdentity) {
  assertSnapshotQuarantineIdentity(value, parentIdentity);
  return digestObject(SCHEMAS.SNAPSHOT_QUARANTINE_IDENTITY, value);
}

function assertRestoreCreatedIdentity(value, parentIdentity) {
  assertExactKeys(value, KEYS.RESTORE_CREATED_IDENTITY, 'restore created identity');
  if (value.schema !== SCHEMAS.RESTORE_CREATED_IDENTITY) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'restore created identity schema 无效');
  }
  assertDigest(value.parentIdentityDigest, 'restore created identity.parentIdentityDigest');
  assertDigest(value.leafNameSha256, 'restore created identity.leafNameSha256');
  assertPublicLeafIdentityFields(value, 'restore created identity');
  assertDigest(value.contentSha256, 'restore created identity.contentSha256');
  assertAncestorIdentity(parentIdentity);
  if (value.parentIdentityDigest !== digestAncestorIdentity(parentIdentity)) {
    fail('INVALID_SNAPSHOT_IDENTITY', 'restore created identity parentIdentityDigest 不匹配');
  }
  return value;
}

function digestRestoreCreatedIdentity(value, parentIdentity) {
  assertRestoreCreatedIdentity(value, parentIdentity);
  return digestObject(SCHEMAS.RESTORE_CREATED_IDENTITY, value);
}

function assertSnapshotReceipt(value, kind) {
  const isDelete = kind === 'delete';
  if (!['create', 'delete'].includes(kind)) {
    fail('INVALID_SNAPSHOT_RECEIPT', 'snapshot receipt kind 无效');
  }
  const expectedSchema = isDelete ? SCHEMAS.SNAPSHOT_DELETE_RECEIPT : SCHEMAS.SNAPSHOT_RECEIPT;
  assertExactKeys(
    value,
    isDelete ? KEYS.DELETE_RECEIPT : KEYS.SNAPSHOT_RECEIPT,
    `${kind} receipt`
  );
  if (value.schema !== expectedSchema) fail('INVALID_SNAPSHOT_RECEIPT', 'snapshot receipt schema 无效');
  assertOpaqueId(value.transactionId, 'receipt.transactionId');
  assertOpaqueId(value.snapshotId, 'receipt.snapshotId');
  assertDigest(
    isDelete ? value.deletedIdentityDigest : value.publishedIdentityDigest,
    isDelete ? 'receipt.deletedIdentityDigest' : 'receipt.publishedIdentityDigest'
  );
  assertDigest(value.snapshotManifestDigest, 'receipt.snapshotManifestDigest');
  if (value.directoryFsyncComplete !== true) {
    fail('INVALID_SNAPSHOT_RECEIPT', 'receipt.directoryFsyncComplete 必须为 true');
  }
  assertTimestamp(value.committedAt, 'receipt.committedAt');
  assertDigest(value.receiptDigest, 'receipt.receiptDigest');
  const expectedDigest = digestObject(expectedSchema, value, 'receiptDigest');
  if (value.receiptDigest !== expectedDigest) {
    fail('INVALID_SNAPSHOT_RECEIPT', 'receipt.receiptDigest 不可复现');
  }
  return value;
}

function assertSnapshotRecovery(value, kind, receipt = null) {
  const isDelete = kind === 'delete';
  if (!['create', 'delete'].includes(kind)) {
    fail('INVALID_SNAPSHOT_RECOVERY', 'snapshot recovery kind 无效');
  }
  const expectedSchema = isDelete ? SCHEMAS.SNAPSHOT_DELETE_RECOVERY : SCHEMAS.SNAPSHOT_RECOVERY;
  const identityField = isDelete
    ? 'expectedDeletedIdentityDigest'
    : 'expectedPublishedIdentityDigest';
  assertExactKeys(
    value,
    isDelete ? KEYS.DELETE_RECOVERY : KEYS.SNAPSHOT_RECOVERY,
    `${kind} recovery`
  );
  if (value.schema !== expectedSchema || !TRANSACTION_STATES.includes(value.state)) {
    fail('INVALID_SNAPSHOT_RECOVERY', 'snapshot recovery schema/state 无效');
  }
  assertOpaqueId(value.transactionId, 'recovery.transactionId');
  assertOpaqueId(value.snapshotId, 'recovery.snapshotId');
  assertDigest(value.expectedManifestDigest, 'recovery.expectedManifestDigest');
  nullableDigest(value[identityField], `recovery.${identityField}`);
  assertTimestamp(value.updatedAt, 'recovery.updatedAt');
  assertDigest(value.markerDigest, 'recovery.markerDigest');
  if (value.state === 'COMMITTED' && value[identityField] === null) {
    fail('INVALID_SNAPSHOT_RECOVERY', `COMMITTED recovery.${identityField} 不得为 null`);
  }
  const expectedMarkerDigest = digestObject(expectedSchema, value, 'markerDigest');
  if (value.markerDigest !== expectedMarkerDigest) {
    fail('INVALID_SNAPSHOT_RECOVERY', 'recovery.markerDigest 不可复现');
  }
  if (value.state === 'COMMITTED') {
    if (receipt === null) {
      fail('INVALID_SNAPSHOT_RECOVERY', 'COMMITTED recovery 必须绑定 committed receipt');
    }
    assertSnapshotReceipt(receipt, kind);
    const receiptIdentity = isDelete
      ? receipt.deletedIdentityDigest
      : receipt.publishedIdentityDigest;
    if (receipt.transactionId !== value.transactionId ||
        receipt.snapshotId !== value.snapshotId ||
        receipt.snapshotManifestDigest !== value.expectedManifestDigest ||
        receiptIdentity !== value[identityField]) {
      fail('INVALID_SNAPSHOT_RECOVERY', 'COMMITTED recovery 与 receipt 不一致');
    }
  } else if (receipt !== null) {
    fail('INVALID_SNAPSHOT_RECOVERY', '非 COMMITTED recovery 不得绑定 receipt');
  }
  return value;
}

function assertSnapshotTransaction(value, kind, receipt = null) {
  const isDelete = kind === 'delete';
  if (!['create', 'delete'].includes(kind)) {
    fail('INVALID_SNAPSHOT_TRANSACTION', 'snapshot transaction kind 无效');
  }
  assertExactKeys(
    value,
    isDelete ? KEYS.DELETE_TRANSACTION : KEYS.SNAPSHOT_TRANSACTION,
    `${kind} transaction`
  );
  if (value.schema !== (isDelete
    ? SCHEMAS.SNAPSHOT_DELETE_TRANSACTION
    : SCHEMAS.SNAPSHOT_TRANSACTION) ||
      !TRANSACTION_STATES.includes(value.state)) {
    fail('INVALID_SNAPSHOT_TRANSACTION', 'snapshot transaction schema/state 无效');
  }
  assertOpaqueId(value.transactionId, 'transactionId');
  assertProjectInstanceId(value.projectInstanceId);
  assertOpaqueId(value.snapshotId, 'snapshotId');
  assertSafeInteger(value.ownerGeneration, 'ownerGeneration');
  assertDigest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  assertTimestamp(value.createdAt, 'createdAt');
  assertTimestamp(value.updatedAt, 'updatedAt');
  nullableDigest(value.receiptDigest, 'receiptDigest');
  nullableErrorCode(value.lastErrorCode);
  if (isDelete) {
    assertDigest(value.sourceIdentityDigest, 'sourceIdentityDigest');
    nullableDigest(value.quarantineIdentityDigest, 'quarantineIdentityDigest');
  } else {
    nullableDigest(value.stageIdentityDigest, 'stageIdentityDigest');
  }
  if (value.state === 'PREPARING') {
    if (value.receiptDigest !== null || value.lastErrorCode !== null ||
        (isDelete && value.quarantineIdentityDigest !== null)) {
      fail('INVALID_SNAPSHOT_TRANSACTION', 'PREPARING nullability 无效');
    }
  } else if (value.state === 'COMMITTED') {
    if (value.receiptDigest === null || value.lastErrorCode !== null ||
        (isDelete ? value.quarantineIdentityDigest === null : value.stageIdentityDigest === null)) {
      fail('INVALID_SNAPSHOT_TRANSACTION', 'COMMITTED nullability 无效');
    }
  } else if (value.receiptDigest !== null || value.lastErrorCode === null) {
    fail('INVALID_SNAPSHOT_TRANSACTION', `${value.state} nullability 无效`);
  }
  if (value.state === 'COMMITTED' && receipt === null) {
    fail('INVALID_SNAPSHOT_TRANSACTION', 'COMMITTED transaction 必须绑定 receipt');
  }
  if (receipt !== null) {
    if (value.state !== 'COMMITTED') {
      fail('INVALID_SNAPSHOT_TRANSACTION', '非 COMMITTED transaction 不得绑定 receipt');
    }
    assertSnapshotReceipt(receipt, kind);
    if (receipt.transactionId !== value.transactionId ||
        receipt.snapshotId !== value.snapshotId ||
        receipt.snapshotManifestDigest !== value.snapshotManifestDigest ||
        receipt.receiptDigest !== value.receiptDigest ||
        (isDelete && receipt.deletedIdentityDigest !== value.quarantineIdentityDigest)) {
      fail('INVALID_SNAPSHOT_TRANSACTION', 'COMMITTED transaction 与 receipt 不一致');
    }
  }
  return value;
}

function nullableOpaqueId(value, field) {
  if (value === null) return null;
  return assertOpaqueId(value, field);
}

function nullableResultToken(value, field) {
  if (value === null) return null;
  return assertString(value, field, {
    ascii: true,
    minBytes: 1,
    maxBytes: 96,
    pattern: /^[a-z][a-z0-9_-]*$/,
  });
}

function assertPublicMarkdownPath(value, field) {
  assertString(value, field, { minBytes: 1, maxBytes: 4096, maxScalars: 1024 });
  const segments = value.split('/');
  if (value.startsWith('/') || value.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..' ||
        segment.startsWith('.') || segment === '.writcraft') ||
      !/\.(?:md|markdown)$/iu.test(value)) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', `${field} 必须是项目内相对 Markdown path`);
  }
  return value;
}

function canonicalObjectByteLengthFromValueLengths(entries) {
  let bytes = 2;
  for (const [index, entry] of entries.entries()) {
    if (index > 0) bytes += 1;
    bytes += Buffer.byteLength(JSON.stringify(entry.key), 'utf8') + 1 + entry.valueBytes;
  }
  return bytes;
}

function base64DataLength(byteLength) {
  return byteLength === 0 ? 0 : 4 * Math.ceil(byteLength / 3);
}

function accountExistingRestoreHistoryState(byteLength) {
  assertSafeInteger(
    byteLength,
    'history state byteLength',
    0,
    SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes
  );
  return canonicalObjectByteLengthFromValueLengths([
    { key: 'byteLength', valueBytes: Buffer.byteLength(String(byteLength), 'ascii') },
    { key: 'contentHash', valueBytes: 66 },
    { key: 'data', valueBytes: base64DataLength(byteLength) + 2 },
    { key: 'encoding', valueBytes: 8 },
    { key: 'exists', valueBytes: 4 },
    { key: 'revision', valueBytes: 66 },
  ]);
}

const ABSENT_RESTORE_HISTORY_STATE = Object.freeze({
  exists: false,
  revision: null,
  contentHash: null,
  byteLength: 0,
  encoding: null,
  data: null,
});
const ABSENT_RESTORE_HISTORY_STATE_BYTES = canonicalJsonByteLength(ABSENT_RESTORE_HISTORY_STATE);

function assertSnapshotRestoreHistoryState(value, field = 'snapshot restore history state') {
  assertExactKeys(value, KEYS.HISTORY_V4_STATE, field);
  if (typeof value.exists !== 'boolean') {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.exists 必须是 boolean`);
  }
  if (!value.exists) {
    if (value.revision !== null || value.contentHash !== null || value.byteLength !== 0 ||
        value.encoding !== null || value.data !== null) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field} 缺失状态必须使用冻结 nullability`);
    }
    return Object.freeze({ value, rawBytes: 0, canonicalBytes: ABSENT_RESTORE_HISTORY_STATE_BYTES });
  }
  assertString(value.revision, `${field}.revision`, {
    ascii: true,
    pattern: /^[a-f0-9]{64}$/,
  });
  assertString(value.contentHash, `${field}.contentHash`, {
    ascii: true,
    pattern: /^[a-f0-9]{64}$/,
  });
  assertSafeInteger(
    value.byteLength,
    `${field}.byteLength`,
    0,
    SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes
  );
  if (value.encoding !== 'base64') {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.encoding 必须是 base64`);
  }
  assertString(value.data, `${field}.data`, {
    ascii: true,
    maxBytes: base64DataLength(SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes),
  });
  const expectedEncodedLength = base64DataLength(value.byteLength);
  if (value.data.length !== expectedEncodedLength ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.data 不是 canonical RFC 4648 base64`);
  }
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length !== value.byteLength || bytes.toString('base64') !== value.data) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.data 与 byteLength 不一致`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.data 不是完整合法 UTF-8`);
  }
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (value.revision !== actualHash || value.contentHash !== actualHash) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field} revision/contentHash 与 raw bytes 不一致`);
  }
  return Object.freeze({
    value,
    rawBytes: bytes.length,
    canonicalBytes: canonicalJsonByteLength(value),
  });
}

function assertSnapshotRestoreHistoryFile(value, field = 'snapshot restore history file') {
  assertExactKeys(value, KEYS.HISTORY_V4_FILE, field);
  assertPublicMarkdownPath(value.path, `${field}.path`);
  assertString(value.summary, `${field}.summary`, { maxBytes: 4096, maxScalars: 1024 });
  const before = assertSnapshotRestoreHistoryState(value.before, `${field}.before`);
  const after = assertSnapshotRestoreHistoryState(value.after, `${field}.after`);
  if (!value.after.exists) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.after 必须存在`);
  }
  nullableDigest(value.createdIdentityDigest, `${field}.createdIdentityDigest`);
  const createsLeaf = !value.before.exists && value.after.exists;
  if ((createsLeaf && value.createdIdentityDigest === null) ||
      (!createsLeaf && value.createdIdentityDigest !== null)) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `${field}.createdIdentityDigest nullability 无效`);
  }
  return Object.freeze({
    value,
    beforeBytes: before.rawBytes,
    afterBytes: after.rawBytes,
    canonicalBytes: canonicalJsonByteLength(value),
  });
}

function assertSnapshotRestoreHistoryProvenance(value, expectedFileCount) {
  assertExactKeys(
    value,
    KEYS.HISTORY_V4_SNAPSHOT_RESTORE_PROVENANCE,
    'snapshot restore history provenance'
  );
  if (value.schema !== SCHEMAS.SNAPSHOT_RESTORE_HISTORY) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history provenance schema 无效');
  }
  assertOpaqueId(value.snapshotId, 'history provenance.snapshotId');
  assertDigest(value.snapshotManifestDigest, 'history provenance.snapshotManifestDigest');
  assertOpaqueId(value.restoreCapabilityId, 'history provenance.restoreCapabilityId');
  assertDigest(value.comparisonDigest, 'history provenance.comparisonDigest');
  if (!Array.isArray(value.selectedIds) || value.selectedIds.length !== expectedFileCount ||
      value.selectedIds.length > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxFiles) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'history provenance.selectedIds 数量无效');
  }
  const selectedIds = new Set();
  for (const [index, id] of value.selectedIds.entries()) {
    assertOpaqueId(id, `history provenance.selectedIds[${index}]`);
    if (selectedIds.has(id)) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'history provenance.selectedIds 重复');
    }
    selectedIds.add(id);
  }
  return value;
}

function assertChangesV4DocumentEnvelope(value, validateEntry) {
  assertExactKeys(value, KEYS.HISTORY_V4_DOCUMENT, 'changes/v4 document envelope');
  if (value.schema !== SCHEMAS.CHANGES_V4 || !Array.isArray(value.entries) ||
      value.entries.length < 1 || value.entries.length > CHANGES_V4_LIMITS.maxEntries) {
    fail('INVALID_CHANGES_V4_ENVELOPE', 'changes/v4 document schema/entries 无效');
  }
  if (typeof validateEntry !== 'function') {
    fail('INVALID_CHANGES_V4_ENVELOPE', 'changes/v4 document 必须提供既有 History kind validator');
  }
  for (const [index, entry] of value.entries.entries()) {
    assertPlainRecord(entry, `changes/v4 entries[${index}]`);
    const validation = validateEntry(entry, index);
    if (validation !== true && validation !== entry) {
      fail('INVALID_CHANGES_V4_ENVELOPE', 'History kind validator 未确认 exact entry');
    }
  }
  const serializedBytes = historyJsonByteLength(value);
  if (serializedBytes > CHANGES_V4_LIMITS.maxCanonicalDocumentBytes) {
    fail('CHANGES_V4_BUDGET_EXCEEDED', 'changes/v4 document 超过 192 MiB');
  }
  return Object.freeze({ value, serializedBytes, canonicalBytes: serializedBytes });
}

function assertSnapshotRestoreHistoryProofDocument(value, files, options = {}) {
  assertExactKeys(value, KEYS.HISTORY_V4_DOCUMENT, 'snapshot restore history document');
  if (value.schema !== SCHEMAS.CHANGES_V4 || !Array.isArray(value.entries) ||
      value.entries.length !== 1) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history document 无效');
  }
  const entry = value.entries[0];
  const entryKeys = entry?.status === 'undone'
    ? KEYS.HISTORY_V4_SNAPSHOT_RESTORE_UNDONE_ENTRY
    : KEYS.HISTORY_V4_SNAPSHOT_RESTORE_ENTRY;
  assertExactKeys(entry, entryKeys, 'snapshot restore history entry');
  if (entry.kind !== 'application' || !['applied', 'undone'].includes(entry.status) ||
      !Array.isArray(entry.files)) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history entry kind/status/files 无效');
  }
  assertOpaqueId(entry.id, 'snapshot restore history entry.id');
  assertOpaqueId(entry.changeSetId, 'snapshot restore history entry.changeSetId');
  assertTimestamp(entry.appliedAt, 'snapshot restore history entry.appliedAt');
  if (entry.status === 'undone') assertTimestamp(entry.undoneAt, 'snapshot restore history entry.undoneAt');
  assertString(entry.integrity, 'snapshot restore history entry.integrity', {
    ascii: true,
    pattern: /^[a-f0-9]{64}$/,
  });
  if (options.template === true) {
    if (entry.files.length !== 0) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'accounting template entry.files 必须为空数组');
    }
  } else if (entry.files !== files) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history document 未绑定 exact files');
  }
  assertSnapshotRestoreHistoryProvenance(entry.provenance, files.length);
  return value;
}

function assertSnapshotRestoreHistoryBudget(files, canonicalRecord) {
  if (!Array.isArray(files) || files.length < 1 ||
      files.length > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxFiles) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history files 数量无效');
  }
  const proofDocument = { schema: SCHEMAS.CHANGES_V4, entries: [canonicalRecord] };
  assertSnapshotRestoreHistoryProofDocument(proofDocument, files);
  const seenPaths = new Set();
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const [index, file] of files.entries()) {
    const result = assertSnapshotRestoreHistoryFile(file, `files[${index}]`);
    if (seenPaths.has(file.path)) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore history files 包含重复 path');
    }
    seenPaths.add(file.path);
    beforeBytes += result.beforeBytes;
    afterBytes += result.afterBytes;
  }
  if (afterBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxAfterBytes ||
      beforeBytes + afterBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes) {
    fail('SNAPSHOT_RESTORE_HISTORY_BUDGET_EXCEEDED', 'snapshot restore history raw byte 预算超限');
  }
  const canonicalFilesBytes = canonicalJsonByteLength(files);
  const canonicalRecordBytes = canonicalJsonByteLength(proofDocument);
  if (canonicalRecordBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxCanonicalRecordBytes) {
    fail('SNAPSHOT_RESTORE_HISTORY_BUDGET_EXCEEDED', 'snapshot restore history canonical record 超过 192 MiB');
  }
  return Object.freeze({
    fileCount: files.length,
    beforeBytes,
    afterBytes,
    beforeAndAfterBytes: beforeBytes + afterBytes,
    canonicalFilesBytes,
    canonicalRecordBytes,
  });
}

function accountSnapshotRestoreHistoryBase64Fixture(files, recordTemplate) {
  if (!Array.isArray(files) || files.length < 1 ||
      files.length > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxFiles) {
    fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore accounting files 数量无效');
  }
  const proofTemplate = { schema: SCHEMAS.CHANGES_V4, entries: [recordTemplate] };
  assertSnapshotRestoreHistoryProofDocument(proofTemplate, files, { template: true });
  const canonicalTemplateBytes = canonicalJsonByteLength(proofTemplate);
  const canonicalRecordEnvelopeBytes = canonicalTemplateBytes - 2;
  let beforeBytes = 0;
  let afterBytes = 0;
  let canonicalFilesBytes = 2;
  const seenPaths = new Set();
  for (const [index, file] of files.entries()) {
    assertExactKeys(file, KEYS.HISTORY_V4_ACCOUNTING_FILE, `accountingFiles[${index}]`);
    assertPublicMarkdownPath(file.path, `accountingFiles[${index}].path`);
    assertString(file.summary, `accountingFiles[${index}].summary`, {
      maxBytes: 4096,
      maxScalars: 1024,
    });
    if (seenPaths.has(file.path)) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', 'snapshot restore accounting files 包含重复 path');
    }
    seenPaths.add(file.path);
    if (typeof file.beforeExists !== 'boolean') {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `accountingFiles[${index}].beforeExists 无效`);
    }
    assertSafeInteger(
      file.beforeByteLength,
      `accountingFiles[${index}].beforeByteLength`,
      0,
      SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes
    );
    assertSafeInteger(
      file.afterByteLength,
      `accountingFiles[${index}].afterByteLength`,
      0,
      SNAPSHOT_RESTORE_HISTORY_LIMITS.maxAfterBytes
    );
    if (!file.beforeExists && file.beforeByteLength !== 0) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `accountingFiles[${index}] 缺失 before 必须为 0 bytes`);
    }
    nullableDigest(file.createdIdentityDigest, `accountingFiles[${index}].createdIdentityDigest`);
    if ((!file.beforeExists && file.createdIdentityDigest === null) ||
        (file.beforeExists && file.createdIdentityDigest !== null)) {
      fail('INVALID_SNAPSHOT_RESTORE_HISTORY', `accountingFiles[${index}].createdIdentityDigest nullability 无效`);
    }
    const beforeCanonicalBytes = file.beforeExists
      ? accountExistingRestoreHistoryState(file.beforeByteLength)
      : ABSENT_RESTORE_HISTORY_STATE_BYTES;
    const afterCanonicalBytes = accountExistingRestoreHistoryState(file.afterByteLength);
    const fileCanonicalBytes = canonicalObjectByteLengthFromValueLengths([
      { key: 'after', valueBytes: afterCanonicalBytes },
      { key: 'before', valueBytes: beforeCanonicalBytes },
      {
        key: 'createdIdentityDigest',
        valueBytes: file.createdIdentityDigest === null ? 4 : 73,
      },
      { key: 'path', valueBytes: Buffer.byteLength(JSON.stringify(file.path), 'utf8') },
      { key: 'summary', valueBytes: Buffer.byteLength(JSON.stringify(file.summary), 'utf8') },
    ]);
    if (index > 0) canonicalFilesBytes += 1;
    canonicalFilesBytes += fileCanonicalBytes;
    beforeBytes += file.beforeByteLength;
    afterBytes += file.afterByteLength;
  }
  if (afterBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxAfterBytes ||
      beforeBytes + afterBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxBeforeAndAfterBytes) {
    fail('SNAPSHOT_RESTORE_HISTORY_BUDGET_EXCEEDED', 'snapshot restore accounting raw byte 预算超限');
  }
  const canonicalRecordBytes = canonicalFilesBytes + canonicalRecordEnvelopeBytes;
  if (canonicalRecordBytes > SNAPSHOT_RESTORE_HISTORY_LIMITS.maxCanonicalRecordBytes) {
    fail('SNAPSHOT_RESTORE_HISTORY_BUDGET_EXCEEDED', 'snapshot restore accounting record 超过 192 MiB');
  }
  return Object.freeze({
    fileCount: files.length,
    beforeBytes,
    afterBytes,
    beforeAndAfterBytes: beforeBytes + afterBytes,
    canonicalFilesBytes,
    canonicalRecordEnvelopeBytes,
    canonicalRecordBytes,
  });
}

function assertSnapshotRestoreHistory(value, task) {
  assertLocalTask(task);
  assertExactKeys(value, KEYS.RESTORE_HISTORY_RESULT, 'snapshot restore history');
  nullableOpaqueId(value.operationId, 'history.operationId');
  nullableResultToken(value.outcome, 'history.outcome');
  nullableResultToken(value.status, 'history.status');
  nullableOpaqueId(value.historyEntryId, 'history.historyEntryId');
  if (!Array.isArray(value.affectedPaths) || value.affectedPaths.length > SNAPSHOT_LIMITS.maxMarkdownFiles) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'history.affectedPaths 数量无效');
  }
  const seenPaths = new Set();
  for (const [index, path] of value.affectedPaths.entries()) {
    assertPublicMarkdownPath(path, `history.affectedPaths[${index}]`);
    if (seenPaths.has(path)) {
      fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'history.affectedPaths 包含重复 path');
    }
    seenPaths.add(path);
  }
  for (const field of ['recoveryRequired', 'responseRecovered', 'committedWarning']) {
    if (typeof value[field] !== 'boolean') {
      fail('INVALID_SNAPSHOT_RESTORE_RESULT', `history.${field} 必须是 boolean`);
    }
  }
  if (value.responseRecovered && value.operationId === null) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'responseRecovered 必须绑定 operationId');
  }
  if (task.terminalTruth === 'COMMITTED') {
    if (value.recoveryRequired || value.committedWarning || value.operationId === null ||
        value.outcome === null || value.status === null || value.historyEntryId === null) {
      fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'COMMITTED restore history nullability 无效');
    }
  } else if (task.terminalTruth === 'COMMITTED_RISK') {
    if (!value.recoveryRequired || !value.committedWarning || value.operationId === null) {
      fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'COMMITTED_RISK restore history 无效');
    }
  } else if (task.terminalTruth === 'UNKNOWN') {
    if (!value.recoveryRequired || value.committedWarning) {
      fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'UNKNOWN restore history 无效');
    }
  } else if (value.recoveryRequired || value.committedWarning || value.historyEntryId !== null) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'UNCOMMITTED restore history 无效');
  }
  return value;
}

function assertSnapshotRestoreResult(value) {
  assertExactKeys(value, KEYS.RESTORE_RESULT, 'snapshot restore result');
  if (value.schema !== SCHEMAS.SNAPSHOT_RESTORE_RESULT) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'snapshot restore result schema 无效');
  }
  assertProjectInstanceId(value.projectInstanceId);
  assertOpaqueId(value.snapshotId, 'snapshotId');
  assertOpaqueId(value.restoreCapabilityId, 'restoreCapabilityId');
  assertLocalTask(value.task);
  if (value.task.kind !== 'SNAPSHOT_RESTORE' ||
      !['completed', 'failed'].includes(value.task.status)) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'restore result task 必须是 terminal restore task');
  }
  if (value.task.projectInstanceId !== value.projectInstanceId) {
    fail('INVALID_SNAPSHOT_RESTORE_RESULT', 'restore result projectInstanceId 不一致');
  }
  assertSnapshotRestoreHistory(value.history, value.task);
  return value;
}

function assertLocalTask(value) {
  assertExactKeys(value, KEYS.LOCAL_TASK, 'local task');
  if (value.schema !== SCHEMAS.LOCAL_TASK ||
      !LOCAL_TASK_KINDS.includes(value.kind) ||
      !LOCAL_TASK_STATUSES.includes(value.status) ||
      !LOCAL_TASK_STAGES.includes(value.stage)) {
    fail('INVALID_LOCAL_TASK', 'local task 枚举无效');
  }
  assertOpaqueId(value.taskId, 'taskId');
  assertProjectInstanceId(value.projectInstanceId);
  assertString(value.startedAt, 'startedAt', { ascii: true, minBytes: 1, maxBytes: 96 });
  if (Number.isNaN(Date.parse(value.startedAt))) fail('INVALID_LOCAL_TASK', 'local task 时间无效');
  assertSafeInteger(value.elapsedMs, 'elapsedMs');
  if (typeof value.cancelAvailable !== 'boolean') fail('INVALID_LOCAL_TASK', 'cancelAvailable 无效');
  if (value.cancelAvailable && (value.status !== 'running' || value.elapsedMs < 10000 ||
      !PRECOMMIT_LOCAL_TASK_STAGES.includes(value.stage))) {
    fail('INVALID_LOCAL_TASK', 'cancelAvailable 只允许已运行十秒的 precommit running task');
  }
  if ((value.status === 'queued' && value.stage !== 'preparing') ||
      (['running', 'cancelling'].includes(value.status) && value.stage === 'completed')) {
    fail('INVALID_LOCAL_TASK', 'local task status/stage 矩阵无效');
  }
  const terminal = ['completed', 'failed'].includes(value.status);
  if (!terminal) {
    if (value.terminalTruth !== null || value.errorCode !== null) {
      fail('INVALID_LOCAL_TASK', '非终态 local task 不得携带终态真相');
    }
  } else {
    if (!TERMINAL_TRUTHS.includes(value.terminalTruth)) {
      fail('INVALID_LOCAL_TASK', 'terminalTruth 无效');
    }
    nullableErrorCode(value.errorCode, 'errorCode');
    if (value.terminalTruth === 'COMMITTED' && value.status === 'completed') {
      if (value.errorCode !== null) fail('INVALID_LOCAL_TASK', '成功 COMMITTED 不得携带 errorCode');
    } else if (value.errorCode === null) {
      fail('INVALID_LOCAL_TASK', '非成功终态必须携带 errorCode');
    }
    if (value.cancelAvailable !== false || value.stage !== 'completed') {
      fail('INVALID_LOCAL_TASK', 'terminal local task 控件状态无效');
    }
  }
  return value;
}

module.exports = Object.freeze({
  DIGEST_DOMAIN,
  SHA256_RE,
  PROJECT_INSTANCE_RE,
  TRANSACTION_STATES,
  LOCAL_TASK_KINDS,
  LOCAL_TASK_STATUSES,
  LOCAL_TASK_STAGES,
  TERMINAL_TRUTHS,
  PRECOMMIT_LOCAL_TASK_STAGES,
  SNAPSHOT_LIMITS,
  SNAPSHOT_RESTORE_HISTORY_LIMITS,
  CHANGES_V4_LIMITS,
  SCHEMAS,
  KEYS,
  EvidenceDeliverySchemaError,
  hasUnpairedSurrogate,
  assertString,
  assertSafeInteger,
  compareUnicodeCodePoints,
  compareUtf8Bytes,
  assertPlainRecord,
  assertExactKeys,
  canonicalJson,
  canonicalJsonByteLength,
  historyJsonByteLength,
  digestPreimage,
  sha256,
  digestObject,
  assertDigest,
  assertProjectInstanceId,
  assertOpaqueId,
  unsignedDecimal,
  assertUnsignedDecimal,
  createFileRevisionSetDigest,
  nullableDigest,
  nullableErrorCode,
  assertTimestamp,
  assertRootIdentity,
  digestRootIdentity,
  assertAncestorIdentity,
  digestAncestorIdentity,
  assertObjectIdentity,
  digestObjectIdentity,
  assertSnapshotPrivateParentIdentity,
  digestSnapshotPrivateParentIdentity,
  assertSnapshotStageIdentity,
  digestSnapshotStageIdentity,
  assertSnapshotPublishedIdentity,
  digestSnapshotPublishedIdentity,
  assertSnapshotQuarantineIdentity,
  digestSnapshotQuarantineIdentity,
  assertRestoreCreatedIdentity,
  digestRestoreCreatedIdentity,
  assertSnapshotReceipt,
  assertSnapshotRecovery,
  assertSnapshotTransaction,
  assertPublicMarkdownPath,
  assertSnapshotRestoreHistory,
  assertSnapshotRestoreResult,
  assertSnapshotRestoreHistoryState,
  assertSnapshotRestoreHistoryFile,
  assertSnapshotRestoreHistoryProvenance,
  assertChangesV4DocumentEnvelope,
  assertSnapshotRestoreHistoryProofDocument,
  assertSnapshotRestoreHistoryBudget,
  accountSnapshotRestoreHistoryBase64Fixture,
  assertLocalTask,
});
