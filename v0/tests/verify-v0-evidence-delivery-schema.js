'use strict';

const assert = require('assert');
const crypto = require('crypto');
const schema = require('../src/main/evidence-delivery-schema');

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

const digest = character => `sha256:${character.repeat(64)}`;
const projectInstanceId = `instance_${'a'.repeat(24)}`;
const timestamp = '2026-08-06T00:00:00.000Z';

function withSelfDigest(value, digestField) {
  return {
    ...value,
    [digestField]: schema.digestObject(value.schema, {
      ...value,
      [digestField]: null,
    }, digestField),
  };
}

function localTask(overrides = {}) {
  return {
    schema: schema.SCHEMAS.LOCAL_TASK,
    taskId: 'task_restore_a',
    projectInstanceId,
    kind: 'SNAPSHOT_RESTORE',
    stage: 'preparing_restore',
    status: 'running',
    startedAt: timestamp,
    elapsedMs: 10000,
    cancelAvailable: true,
    terminalTruth: null,
    errorCode: null,
    ...overrides,
  };
}

function historyState(content) {
  const bytes = Buffer.from(content, 'utf8');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    exists: true,
    revision: hash,
    contentHash: hash,
    byteLength: bytes.length,
    encoding: 'base64',
    data: bytes.toString('base64'),
  };
}

function snapshotRestoreHistoryDocument(files, selectedIds, maximumMetadata = false) {
  const opaque = prefix => maximumMetadata
    ? `${prefix}_${'x'.repeat(128 - prefix.length - 1)}`
    : `${prefix}_a`;
  return {
    schema: schema.SCHEMAS.CHANGES_V4,
    entries: [{
      id: opaque('change'),
      kind: 'application',
      changeSetId: opaque('changeset'),
      status: 'applied',
      appliedAt: timestamp,
      files,
      provenance: {
        schema: schema.SCHEMAS.SNAPSHOT_RESTORE_HISTORY,
        snapshotId: opaque('snapshot'),
        snapshotManifestDigest: digest('1'),
        restoreCapabilityId: opaque('capability'),
        comparisonDigest: digest('2'),
        selectedIds,
      },
      integrity: 'a'.repeat(64),
    }],
  };
}

console.log('WritCraft 0.4.0 evidence delivery schema tests');

test('canonical JSON sorts object keys by Unicode code point', () => {
  const value = { '\uffff': 3, '\u{10000}': 4, a: 1, '写': 2 };
  assert.strictEqual(
    schema.canonicalJson(value),
    '{"a":1,"写":2,"￿":3,"𐀀":4}'
  );
});

test('digest preimage uses exact domain and raw NUL separators', () => {
  const value = { schema: 'writcraft.test/v1', name: '作者😀', count: 2 };
  const expected = Buffer.concat([
    Buffer.from('writcraft-digest/v1', 'utf8'),
    Buffer.from([0]),
    Buffer.from('writcraft.test/v1', 'utf8'),
    Buffer.from([0]),
    Buffer.from('{"count":2,"name":"作者😀","schema":"writcraft.test/v1"}', 'utf8'),
  ]);
  assert.deepStrictEqual(schema.digestPreimage('writcraft.test/v1', value), expected);
  assert.strictEqual(
    schema.digestObject('writcraft.test/v1', value),
    `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`
  );
});

test('self digest removes only the outer digest key', () => {
  const value = {
    schema: 'writcraft.test/v1',
    child: { digest: 'sha256:nested' },
    digest: 'sha256:outer',
  };
  const preimage = schema.digestPreimage('writcraft.test/v1', value, 'digest').toString('utf8');
  assert(preimage.includes('sha256:nested'));
  assert(!preimage.includes('sha256:outer'));
});

test('canonical JSON rejects floats, C0 controls and unpaired surrogates', () => {
  assert.throws(() => schema.canonicalJson({ value: 1.5 }), /安全整数/);
  assert.throws(() => schema.canonicalJson({ value: 'bad\nline' }), /安全 Unicode/);
  assert.throws(() => schema.canonicalJson({ value: '\ud800' }), /安全 Unicode/);
  assert.strictEqual(schema.canonicalJson({ value: 'emoji 😀' }), '{"value":"emoji 😀"}');
  assert.doesNotThrow(() => schema.canonicalJson({ value: 'delete\u007fallowed' }));
  assert.throws(() => schema.canonicalJson({ value: 'unit\u001fseparator' }), /安全 Unicode/);
});

test('digest preimage rejects an accessor payload without invoking its getter', () => {
  let getterInvocations = 0;
  const payload = { count: 1 };
  Object.defineProperty(payload, 'schema', {
    enumerable: true,
    get() {
      getterInvocations += 1;
      return 'writcraft.test/v1';
    },
  });
  assert.throws(() => schema.digestPreimage('writcraft.test/v1', payload), /不安全字段/);
  assert.strictEqual(getterInvocations, 0);
});

test('canonical JSON rejects accessors, sparse arrays and prototype pollution keys', () => {
  const getter = {};
  Object.defineProperty(getter, 'value', { enumerable: true, get() { return 1; } });
  assert.throws(() => schema.canonicalJson(getter), /不安全字段/);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'x';
  assert.throws(() => schema.canonicalJson(sparse), /稠密普通数组/);
  const polluted = {};
  Object.defineProperty(polluted, '__proto__', { enumerable: true, value: 'x' });
  assert.throws(() => schema.canonicalJson(polluted), /不安全字段/);
});

test('exact-key validation rejects missing and extra fields', () => {
  const valid = { schema: 'x', id: 'y' };
  assert.strictEqual(schema.assertExactKeys(valid, ['schema', 'id']), valid);
  assert.throws(() => schema.assertExactKeys({ schema: 'x' }, ['schema', 'id']), /未知或缺失/);
  assert.throws(() => schema.assertExactKeys({ schema: 'x', id: 'y', extra: true }, ['schema', 'id']), /未知或缺失/);
});

test('unsigned decimal encoding is canonical', () => {
  assert.strictEqual(schema.unsignedDecimal(0n), '0');
  assert.strictEqual(schema.unsignedDecimal(18446744073709551615n), '18446744073709551615');
  assert.strictEqual(schema.assertUnsignedDecimal('0'), '0');
  assert.throws(() => schema.assertUnsignedDecimal('01'), /冻结边界/);
  assert.throws(() => schema.assertUnsignedDecimal('-1'), /冻结边界/);
});

test('file revision-set digest sorts by UTF-8 bytes and rejects duplicates', () => {
  const itemA = {
    fileId: 'file_a',
    path: '章节/一.md',
    revision: 'a'.repeat(64),
    sha256: `sha256:${'b'.repeat(64)}`,
  };
  const itemB = {
    fileId: 'file_b',
    path: 'a.md',
    revision: 'c'.repeat(64),
    sha256: `sha256:${'d'.repeat(64)}`,
  };
  const result = schema.createFileRevisionSetDigest([itemA, itemB]);
  assert.deepStrictEqual(result.payload.items.map(item => item.path), ['a.md', '章节/一.md']);
  assert(schema.SHA256_RE.test(result.digest));
  assert.throws(() => schema.createFileRevisionSetDigest([itemA, { ...itemA }]), /重复身份/);
});

test('frozen Stage A schema key sets remain exact', () => {
  assert.deepStrictEqual(schema.KEYS.SNAPSHOT, [
    'schema', 'projectInstanceId', 'snapshotId', 'createdAt',
    'creationMutationGeneration', 'rootIdentityDigest', 'files',
    'fileRevisionSetDigest', 'budgets', 'producerVersion', 'snapshotManifestDigest',
  ]);
  assert.deepStrictEqual(schema.KEYS.CAPABILITY, [
    'schema', 'capabilityId', 'kind', 'projectInstanceId', 'ownerGeneration',
    'subjectId', 'authorityDigest', 'selectionDigest', 'issuedAt', 'expiresAt',
    'singleUse', 'consumedAt',
  ]);
  assert.deepStrictEqual(schema.KEYS.STAGE_IDENTITY, [
    'schema', 'transactionId', 'snapshotId', 'parentIdentityDigest',
    'stageBasenameSha256', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size',
    'bundlePayloadSha256', 'snapshotManifestDigest',
  ]);
  assert.deepStrictEqual(schema.KEYS.QUARANTINE_IDENTITY, [
    'schema', 'transactionId', 'snapshotId', 'parentIdentityDigest',
    'quarantineBasenameSha256', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size',
    'bundlePayloadSha256', 'snapshotManifestDigest',
  ]);
});

test('snapshot budgets are fixed, complete and frozen', () => {
  assert.deepStrictEqual(schema.SNAPSHOT_LIMITS, {
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
  assert.strictEqual(Object.isFrozen(schema.SNAPSHOT_LIMITS), true);
  assert.deepStrictEqual(Object.keys(schema.SNAPSHOT_LIMITS), schema.KEYS.LIMITS);
});

test('transaction nullability follows the frozen state matrix', () => {
  const base = {
    schema: schema.SCHEMAS.SNAPSHOT_TRANSACTION,
    transactionId: 'transaction_a',
    projectInstanceId: `instance_${'a'.repeat(24)}`,
    snapshotId: 'snapshot_a',
    ownerGeneration: 1,
    state: 'PREPARING',
    stageIdentityDigest: null,
    snapshotManifestDigest: `sha256:${'1'.repeat(64)}`,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    receiptDigest: null,
    lastErrorCode: null,
  };
  assert.strictEqual(schema.assertSnapshotTransaction(base, 'create'), base);
  assert.throws(() => schema.assertSnapshotTransaction({
    ...base,
    state: 'COMMITTED',
  }, 'create'), /COMMITTED nullability/);
  const committed = {
    ...base,
    state: 'COMMITTED',
    stageIdentityDigest: `sha256:${'2'.repeat(64)}`,
    receiptDigest: `sha256:${'3'.repeat(64)}`,
  };
  assert.throws(() => schema.assertSnapshotTransaction(committed, 'create'), /绑定 receipt/);
  assert.strictEqual(schema.assertSnapshotTransaction({
    ...base, state: 'UNCOMMITTED', lastErrorCode: 'CREATE_NOT_PUBLISHED',
  }, 'create').state, 'UNCOMMITTED');
  assert.strictEqual(schema.assertSnapshotTransaction({
    ...base, state: 'UNKNOWN', stageIdentityDigest: digest('8'),
    lastErrorCode: 'CREATE_OUTCOME_UNKNOWN',
  }, 'create').state, 'UNKNOWN');
  assert.throws(() => schema.assertSnapshotTransaction({
    ...base,
    state: 'UNKNOWN',
  }, 'create'), /UNKNOWN nullability/);

  const deleteBase = {
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_TRANSACTION,
    transactionId: 'transaction_delete_a', projectInstanceId,
    snapshotId: 'snapshot_a', ownerGeneration: 2, state: 'PREPARING',
    sourceIdentityDigest: digest('4'), quarantineIdentityDigest: null,
    snapshotManifestDigest: digest('5'), createdAt: timestamp, updatedAt: timestamp,
    receiptDigest: null, lastErrorCode: null,
  };
  assert.strictEqual(schema.assertSnapshotTransaction(deleteBase, 'delete'), deleteBase);
  assert.strictEqual(schema.assertSnapshotTransaction({
    ...deleteBase, state: 'UNCOMMITTED', lastErrorCode: 'DELETE_ROLLED_BACK',
  }, 'delete').state, 'UNCOMMITTED');
  assert.strictEqual(schema.assertSnapshotTransaction({
    ...deleteBase, state: 'UNKNOWN', quarantineIdentityDigest: digest('6'),
    lastErrorCode: 'DELETE_OUTCOME_UNKNOWN',
  }, 'delete').state, 'UNKNOWN');
  assert.throws(() => schema.assertSnapshotTransaction({
    ...deleteBase, state: 'COMMITTED', receiptDigest: digest('7'),
  }, 'delete'), /COMMITTED nullability/);
});

test('local-task terminal truth cannot regress or hide an error', () => {
  const running = {
    schema: schema.SCHEMAS.LOCAL_TASK,
    taskId: 'task_a',
    projectInstanceId: `instance_${'b'.repeat(24)}`,
    kind: 'SNAPSHOT_CREATE',
    stage: 'scanning_sources',
    status: 'running',
    startedAt: '2026-08-06T00:00:00.000Z',
    elapsedMs: 2000,
    cancelAvailable: false,
    terminalTruth: null,
    errorCode: null,
  };
  assert.strictEqual(schema.assertLocalTask(running), running);
  assert.throws(() => schema.assertLocalTask({ ...running, terminalTruth: 'UNCOMMITTED' }), /非终态/);
  const completed = {
    ...running,
    stage: 'completed',
    status: 'completed',
    cancelAvailable: false,
    terminalTruth: 'COMMITTED',
    errorCode: null,
  };
  assert.strictEqual(schema.assertLocalTask(completed), completed);
  assert.throws(() => schema.assertLocalTask({
    ...completed,
    status: 'failed',
    terminalTruth: 'UNKNOWN',
  }), /必须携带 errorCode/);
});

test('local-task cancellation is available only after ten seconds in running precommit', () => {
  const valid = localTask();
  assert.strictEqual(schema.assertLocalTask(valid), valid);
  assert.throws(() => schema.assertLocalTask(localTask({ elapsedMs: 9999 })), /cancelAvailable/);
  assert.throws(() => schema.assertLocalTask(localTask({ status: 'queued' })), /cancelAvailable/);
  assert.throws(() => schema.assertLocalTask(localTask({ status: 'cancelling' })), /cancelAvailable/);
  for (const stage of [
    'publishing_bundle', 'reconciling', 'restoring_markdown',
    'quarantining_snapshot', 'deleting_snapshot', 'completed',
  ]) {
    assert.throws(() => schema.assertLocalTask(localTask({ stage })), /cancelAvailable/);
  }
  assert.strictEqual(
    schema.assertLocalTask(localTask({ elapsedMs: 9999, cancelAvailable: false })).cancelAvailable,
    false
  );
  assert.strictEqual(schema.assertLocalTask(localTask({
    status: 'queued', stage: 'preparing', elapsedMs: 0, cancelAvailable: false,
  })).status, 'queued');
  assert.throws(() => schema.assertLocalTask(localTask({
    status: 'queued', stage: 'comparing', elapsedMs: 0, cancelAvailable: false,
  })), /status\/stage/);
  assert.throws(() => schema.assertLocalTask(localTask({
    status: 'running', stage: 'completed', cancelAvailable: false,
  })), /status\/stage/);
  assert.throws(() => schema.assertLocalTask(localTask({
    status: 'cancelling', stage: 'completed', cancelAvailable: false,
  })), /status\/stage/);
});

test('root, ancestor and object identities are exact canonical records', () => {
  const root = {
    schema: schema.SCHEMAS.ROOT_IDENTITY,
    dev: '1', ino: '9007199254740993', uid: 501, mode: 493,
  };
  assert.strictEqual(schema.assertRootIdentity(root), root);
  assert.strictEqual(schema.digestRootIdentity(root),
    schema.digestObject(schema.SCHEMAS.ROOT_IDENTITY, root));
  assert.throws(() => schema.assertRootIdentity({ ...root, ino: '01' }), /ino/);
  assert.throws(() => schema.assertRootIdentity({ ...root, absolutePath: '/private' }), /未知或缺失/);

  const ancestor = {
    schema: schema.SCHEMAS.ANCESTOR_IDENTITY,
    components: [{ nameSha256: digest('1'), dev: '1', ino: '2', uid: 501, mode: 493 }],
  };
  assert.strictEqual(schema.assertAncestorIdentity(ancestor), ancestor);
  assert.strictEqual(schema.digestAncestorIdentity(ancestor),
    schema.digestObject(schema.SCHEMAS.ANCESTOR_IDENTITY, ancestor));
  assert.throws(() => schema.assertAncestorIdentity({
    ...ancestor,
    components: [{ ...ancestor.components[0], name: 'chapters' }],
  }), /未知或缺失/);
  assert.throws(() => schema.assertAncestorIdentity({
    ...ancestor,
    components: [{ ...ancestor.components[0], mode: 65536 }],
  }), /mode/);

  const object = {
    schema: schema.SCHEMAS.OBJECT_IDENTITY,
    dev: '1', ino: '2', uid: 501, mode: 420, nlink: 1,
    size: '37', mtimeNs: '1000000001', ctimeNs: '1000000002',
    contentSha256: digest('2'),
  };
  assert.strictEqual(schema.assertObjectIdentity(object), object);
  assert.strictEqual(schema.digestObjectIdentity(object),
    schema.digestObject(schema.SCHEMAS.OBJECT_IDENTITY, object));
  assert.throws(() => schema.assertObjectIdentity({ ...object, mtimeNs: 1 }), /mtimeNs/);
  assert.throws(() => schema.assertObjectIdentity({ ...object, nlink: 0 }), /nlink/);
});

test('snapshot private and file identities have exact canonical digests', () => {
  const parent = {
    schema: schema.SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY,
    role: 'control',
    rootIdentityDigest: digest('1'),
    dev: '18446744073709551615',
    ino: '9007199254740993',
    uid: 501,
    mode: 448,
  };
  assert.strictEqual(schema.assertSnapshotPrivateParentIdentity(parent), parent);
  assert.strictEqual(
    schema.digestSnapshotPrivateParentIdentity(parent),
    schema.digestObject(schema.SCHEMAS.SNAPSHOT_PRIVATE_PARENT_IDENTITY, parent)
  );
  assert.throws(() => schema.assertSnapshotPrivateParentIdentity({ ...parent, dev: '01' }), /dev/);
  assert.throws(() => schema.assertSnapshotPrivateParentIdentity({ ...parent, role: 'other' }), /role/);
  assert.throws(() => schema.assertSnapshotPrivateParentIdentity({ ...parent, mode: '448' }), /mode/);
  assert.throws(() => schema.assertSnapshotPrivateParentIdentity({ ...parent, path: '/private/path' }), /未知或缺失/);

  const stage = {
    schema: schema.SCHEMAS.SNAPSHOT_STAGE_IDENTITY,
    transactionId: 'transaction_create_a',
    snapshotId: 'snapshot_a',
    parentIdentityDigest: schema.digestSnapshotPrivateParentIdentity(parent),
    stageBasenameSha256: digest('2'),
    dev: '10',
    ino: '20',
    uid: 501,
    mode: 384,
    nlink: 1,
    size: '4096',
    bundlePayloadSha256: digest('3'),
    snapshotManifestDigest: digest('4'),
  };
  assert.strictEqual(schema.assertSnapshotStageIdentity(stage, parent), stage);
  assert.strictEqual(
    schema.digestSnapshotStageIdentity(stage, parent),
    schema.digestObject(schema.SCHEMAS.SNAPSHOT_STAGE_IDENTITY, stage)
  );
  assert.throws(() => schema.assertSnapshotStageIdentity({ ...stage, size: 4096 }, parent), /size/);
  assert.throws(() => schema.assertSnapshotStageIdentity({ ...stage, nlink: 2 }, parent), /nlink/);

  const bundlesParent = { ...parent, role: 'bundles', ino: '9007199254740994' };

  const published = {
    schema: schema.SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY,
    snapshotId: 'snapshot_a',
    parentIdentityDigest: schema.digestSnapshotPrivateParentIdentity(bundlesParent),
    finalBasenameSha256: digest('6'),
    dev: '10', ino: '20', uid: 501, mode: 384, nlink: 1, size: '4096',
    bundlePayloadSha256: digest('3'), snapshotManifestDigest: digest('4'),
  };
  assert.strictEqual(schema.assertSnapshotPublishedIdentity(published, bundlesParent), published);
  assert.strictEqual(schema.digestSnapshotPublishedIdentity(published, bundlesParent),
    schema.digestObject(schema.SCHEMAS.SNAPSHOT_PUBLISHED_IDENTITY, published));
  assert.throws(() => schema.assertSnapshotPublishedIdentity(published, parent), /bundles/);

  const quarantineParent = { ...parent, role: 'quarantine', ino: '9007199254740995' };
  const quarantine = {
    schema: schema.SCHEMAS.SNAPSHOT_QUARANTINE_IDENTITY,
    transactionId: 'transaction_delete_a', snapshotId: 'snapshot_a',
    parentIdentityDigest: schema.digestSnapshotPrivateParentIdentity(quarantineParent),
    quarantineBasenameSha256: digest('8'),
    dev: '10', ino: '20', uid: 501, mode: 384, nlink: 1, size: '4096',
    bundlePayloadSha256: digest('3'), snapshotManifestDigest: digest('4'),
  };
  assert.strictEqual(schema.assertSnapshotQuarantineIdentity(quarantine, quarantineParent), quarantine);
  assert.strictEqual(schema.digestSnapshotQuarantineIdentity(quarantine, quarantineParent),
    schema.digestObject(schema.SCHEMAS.SNAPSHOT_QUARANTINE_IDENTITY, quarantine));

  const ancestor = {
    schema: schema.SCHEMAS.ANCESTOR_IDENTITY,
    components: [{
      nameSha256: digest('9'), dev: '10', ino: '20', uid: 501, mode: 493,
    }],
  };
  const created = {
    schema: schema.SCHEMAS.RESTORE_CREATED_IDENTITY,
    parentIdentityDigest: schema.digestAncestorIdentity(ancestor), leafNameSha256: digest('a'),
    dev: '10', ino: '21', uid: 501, mode: 420, nlink: 1, size: '37',
    contentSha256: digest('b'),
  };
  assert.strictEqual(schema.assertRestoreCreatedIdentity(created, ancestor), created);
  assert.strictEqual(schema.digestRestoreCreatedIdentity(created, ancestor),
    schema.digestObject(schema.SCHEMAS.RESTORE_CREATED_IDENTITY, created));
  assert.throws(() => schema.assertRestoreCreatedIdentity(created), /ancestor|parent/);
  assert.throws(() => schema.assertRestoreCreatedIdentity({ ...created, mode: 65536 }), /mode/);
  assert.throws(() => schema.assertRestoreCreatedIdentity({ ...created, leafPath: 'draft.md' }), /未知或缺失/);
  assert.throws(() => schema.assertRestoreCreatedIdentity({
    ...created, parentIdentityDigest: digest('f'),
  }, ancestor), /不匹配/);
});

test('create and delete receipts prove committed truth and reproduce their self-digest', () => {
  const createReceipt = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_RECEIPT,
    transactionId: 'transaction_create_a', snapshotId: 'snapshot_a',
    publishedIdentityDigest: digest('1'), snapshotManifestDigest: digest('2'),
    directoryFsyncComplete: true, committedAt: timestamp, receiptDigest: null,
  }, 'receiptDigest');
  assert.strictEqual(schema.assertSnapshotReceipt(createReceipt, 'create'), createReceipt);
  assert.strictEqual(schema.assertSnapshotTransaction({
    schema: schema.SCHEMAS.SNAPSHOT_TRANSACTION,
    transactionId: createReceipt.transactionId, projectInstanceId,
    snapshotId: createReceipt.snapshotId, ownerGeneration: 1, state: 'COMMITTED',
    stageIdentityDigest: digest('9'),
    snapshotManifestDigest: createReceipt.snapshotManifestDigest,
    createdAt: timestamp, updatedAt: timestamp,
    receiptDigest: createReceipt.receiptDigest, lastErrorCode: null,
  }, 'create', createReceipt).state, 'COMMITTED');
  assert.throws(() => schema.assertSnapshotReceipt({ ...createReceipt, directoryFsyncComplete: false }, 'create'), /directoryFsyncComplete/);
  assert.throws(() => schema.assertSnapshotReceipt({ ...createReceipt, receiptDigest: digest('f') }, 'create'), /receiptDigest/);

  const deleteReceipt = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_RECEIPT,
    transactionId: 'transaction_delete_a', snapshotId: 'snapshot_a',
    deletedIdentityDigest: digest('3'), snapshotManifestDigest: digest('2'),
    directoryFsyncComplete: true, committedAt: timestamp, receiptDigest: null,
  }, 'receiptDigest');
  assert.strictEqual(schema.assertSnapshotReceipt(deleteReceipt, 'delete'), deleteReceipt);
  assert.strictEqual(schema.assertSnapshotTransaction({
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_TRANSACTION,
    transactionId: deleteReceipt.transactionId, projectInstanceId,
    snapshotId: deleteReceipt.snapshotId, ownerGeneration: 2, state: 'COMMITTED',
    sourceIdentityDigest: digest('8'),
    quarantineIdentityDigest: deleteReceipt.deletedIdentityDigest,
    snapshotManifestDigest: deleteReceipt.snapshotManifestDigest,
    createdAt: timestamp, updatedAt: timestamp,
    receiptDigest: deleteReceipt.receiptDigest, lastErrorCode: null,
  }, 'delete', deleteReceipt).state, 'COMMITTED');
  assert.throws(() => schema.assertSnapshotReceipt({ ...deleteReceipt, publishedIdentityDigest: digest('4') }, 'delete'), /未知或缺失/);
});

test('create and delete recovery marker nullability and receipt binding are exact', () => {
  const preparing = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_RECOVERY,
    transactionId: 'transaction_create_a', snapshotId: 'snapshot_a',
    expectedManifestDigest: digest('1'), expectedPublishedIdentityDigest: null,
    state: 'PREPARING', updatedAt: timestamp, markerDigest: null,
  }, 'markerDigest');
  assert.strictEqual(schema.assertSnapshotRecovery(preparing, 'create'), preparing);
  for (const state of ['PREPARING', 'UNCOMMITTED', 'UNKNOWN']) {
    const marker = withSelfDigest({
      ...preparing,
      state,
      expectedPublishedIdentityDigest: digest('a'),
      markerDigest: null,
    }, 'markerDigest');
    assert.strictEqual(schema.assertSnapshotRecovery(marker, 'create'), marker);
  }

  const createReceipt = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_RECEIPT,
    transactionId: 'transaction_create_a', snapshotId: 'snapshot_a',
    publishedIdentityDigest: digest('2'), snapshotManifestDigest: digest('1'),
    directoryFsyncComplete: true, committedAt: timestamp, receiptDigest: null,
  }, 'receiptDigest');
  const committed = withSelfDigest({
    ...preparing,
    state: 'COMMITTED', expectedPublishedIdentityDigest: digest('2'), markerDigest: null,
  }, 'markerDigest');
  assert.strictEqual(schema.assertSnapshotRecovery(committed, 'create', createReceipt), committed);
  assert.throws(() => schema.assertSnapshotRecovery(committed, 'create'), /receipt/);
  assert.throws(() => schema.assertSnapshotRecovery(preparing, 'create', createReceipt), /非 COMMITTED/);
  assert.throws(() => schema.assertSnapshotRecovery({ ...committed, expectedPublishedIdentityDigest: null }, 'create', createReceipt), /COMMITTED/);
  assert.throws(() => schema.assertSnapshotRecovery(committed, 'create', { ...createReceipt, publishedIdentityDigest: digest('3') }), /receiptDigest|receipt/);

  const deleteReceipt = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_RECEIPT,
    transactionId: 'transaction_delete_a', snapshotId: 'snapshot_a',
    deletedIdentityDigest: digest('4'), snapshotManifestDigest: digest('5'),
    directoryFsyncComplete: true, committedAt: timestamp, receiptDigest: null,
  }, 'receiptDigest');
  const deleteRecovery = withSelfDigest({
    schema: schema.SCHEMAS.SNAPSHOT_DELETE_RECOVERY,
    transactionId: 'transaction_delete_a', snapshotId: 'snapshot_a',
    expectedManifestDigest: digest('5'), expectedDeletedIdentityDigest: digest('4'),
    state: 'COMMITTED', updatedAt: timestamp, markerDigest: null,
  }, 'markerDigest');
  assert.strictEqual(schema.assertSnapshotRecovery(deleteRecovery, 'delete', deleteReceipt), deleteRecovery);
  assert.throws(() => schema.assertSnapshotRecovery({ ...deleteRecovery, markerDigest: digest('f') }, 'delete', deleteReceipt), /markerDigest/);
});

test('restore result binds a terminal restore task to safe public Markdown history', () => {
  const task = localTask({
    stage: 'completed', status: 'completed', elapsedMs: 12500,
    cancelAvailable: false, terminalTruth: 'COMMITTED', errorCode: null,
  });
  const result = {
    schema: schema.SCHEMAS.SNAPSHOT_RESTORE_RESULT,
    projectInstanceId,
    snapshotId: 'snapshot_a',
    restoreCapabilityId: 'capability_restore_a',
    task,
    history: {
      operationId: 'operation_restore_a',
      outcome: 'applied',
      status: 'completed',
      affectedPaths: ['chapters/one.md', 'draft.markdown'],
      historyEntryId: 'history_restore_a',
      recoveryRequired: false,
      responseRecovered: false,
      committedWarning: false,
    },
  };
  assert.strictEqual(schema.assertSnapshotRestoreResult(result), result);
  assert.throws(() => schema.assertSnapshotRestoreResult({ ...result, task: localTask() }), /terminal|终态/);
  assert.throws(() => schema.assertSnapshotRestoreResult({
    ...result,
    task: { ...task, projectInstanceId: `instance_${'b'.repeat(24)}` },
  }), /projectInstanceId/);
  assert.throws(() => schema.assertSnapshotRestoreResult({
    ...result,
    history: { ...result.history, affectedPaths: ['../escape.md'] },
  }), /affectedPaths/);
  assert.throws(() => schema.assertPublicMarkdownPath('.writcraft/secret.md', 'path'), /相对 Markdown/);
  assert.throws(() => schema.assertPublicMarkdownPath('chapters/.private/draft.md', 'path'), /相对 Markdown/);
  assert.throws(() => schema.assertSnapshotRestoreResult({
    ...result,
    history: { ...result.history, affectedPaths: ['chapters/one.md', 'chapters/one.md'] },
  }), /affectedPaths/);
  assert.throws(() => schema.assertSnapshotRestoreResult({
    ...result,
    history: { ...result.history, recoveryRequired: true },
  }), /COMMITTED/);
  assert.throws(() => schema.assertSnapshotRestoreResult({ ...result, absolutePath: '/private/work' }), /未知或缺失/);
});

test('snapshot restore History v4 state and file validators preserve exact raw bytes', () => {
  const absent = {
    exists: false, revision: null, contentHash: null,
    byteLength: 0, encoding: null, data: null,
  };
  assert.strictEqual(schema.assertSnapshotRestoreHistoryState(absent).value, absent);
  const before = historyState('旧稿\n');
  const after = historyState('新稿😀\n');
  assert.strictEqual(schema.assertSnapshotRestoreHistoryState(after).rawBytes,
    Buffer.byteLength('新稿😀\n', 'utf8'));
  assert.strictEqual(schema.canonicalJsonByteLength(after),
    Buffer.byteLength(schema.canonicalJson(after), 'utf8'));
  assert.throws(() => schema.assertSnapshotRestoreHistoryState({ ...after, data: 'Zg' }), /base64/);
  const invalidUtf8 = Buffer.from([0xff]);
  const invalidHash = crypto.createHash('sha256').update(invalidUtf8).digest('hex');
  assert.throws(() => schema.assertSnapshotRestoreHistoryState({
    ...after, revision: invalidHash, contentHash: invalidHash,
    byteLength: 1, data: invalidUtf8.toString('base64'),
  }), /UTF-8/);
  assert.throws(() => schema.assertSnapshotRestoreHistoryState({ ...absent, data: '' }), /nullability/);

  const modified = {
    path: 'chapters/one.md', summary: '恢复作者选择的章节',
    before, after, createdIdentityDigest: null,
  };
  assert.strictEqual(schema.assertSnapshotRestoreHistoryFile(modified).value, modified);
  const created = {
    path: 'draft.markdown', summary: '恢复缺失草稿',
    before: absent, after, createdIdentityDigest: digest('d'),
  };
  assert.strictEqual(schema.assertSnapshotRestoreHistoryFile(created).value, created);
  assert.throws(() => schema.assertSnapshotRestoreHistoryFile({
    ...created, createdIdentityDigest: null,
  }), /createdIdentityDigest/);
  assert.throws(() => schema.assertSnapshotRestoreHistoryFile({
    ...modified, after: absent,
  }), /after/);
});

test('production changes/v4 envelope delegates two retained/target entries to a mandatory kind validator', () => {
  const document = {
    schema: schema.SCHEMAS.CHANGES_V4,
    entries: [
      { kind: 'retained', id: 'entry_retained' },
      { kind: 'target', id: 'entry_target' },
    ],
  };
  const validateEntry = entry => {
    schema.assertExactKeys(entry, ['kind', 'id'], 'production history entry');
    assert(['retained', 'target'].includes(entry.kind));
    schema.assertOpaqueId(entry.id, 'production history entry.id');
    return entry;
  };
  const result = schema.assertChangesV4DocumentEnvelope(document, validateEntry);
  assert.strictEqual(result.value, document);
  assert.strictEqual(result.canonicalBytes,
    Buffer.byteLength(schema.canonicalJson(document), 'utf8'));
  assert.throws(() => schema.assertChangesV4DocumentEnvelope(document), /validator/);
  assert.throws(() => schema.assertChangesV4DocumentEnvelope({
    schema: schema.SCHEMAS.CHANGES_V4,
    entries: [],
  }, validateEntry), /entries/);
  const markdown = {
    schema: schema.SCHEMAS.CHANGES_V4,
    entries: [{ kind: 'retained', id: 'entry_markdown', data: 'line one\nline two\t' }],
  };
  const markdownResult = schema.assertChangesV4DocumentEnvelope(markdown, entry => {
    schema.assertExactKeys(entry, ['kind', 'id', 'data'], 'ordinary history entry');
    assert.strictEqual(entry.kind, 'retained');
    return true;
  });
  assert.strictEqual(markdownResult.serializedBytes,
    Buffer.byteLength(JSON.stringify(markdown), 'utf8'));
  assert.throws(() => schema.assertChangesV4DocumentEnvelope({
    schema: schema.SCHEMAS.CHANGES_V4,
    entries: [{ kind: 'retained', id: 'entry_bad', data: '\ud800' }],
  }, () => true), /surrogate/);
});

test('snapshot restore History v4 budget accountant closes the 300-file 128 MiB maximum', () => {
  const before = historyState('before\n');
  const after = historyState('after\n');
  const file = {
    path: 'chapters/calibration.md', summary: '校准',
    before, after, createdIdentityDigest: null,
  };
  const files = [file];
  const selectedIds = ['selected_a'];
  const record = snapshotRestoreHistoryDocument(files, selectedIds);
  assert.throws(() => schema.assertSnapshotRestoreHistoryProofDocument({
    ...record,
    entries: [record.entries[0], { ...record.entries[0], id: 'change_b' }],
  }, files), /document/);
  const actual = schema.assertSnapshotRestoreHistoryBudget(files, record.entries[0]);
  assert.strictEqual(actual.canonicalRecordBytes,
    Buffer.byteLength(schema.canonicalJson(record), 'utf8'));
  const template = snapshotRestoreHistoryDocument([], selectedIds);
  const calibrated = schema.accountSnapshotRestoreHistoryBase64Fixture([{
    path: file.path, summary: file.summary, beforeExists: true,
    beforeByteLength: before.byteLength, afterByteLength: after.byteLength,
    createdIdentityDigest: null,
  }], template.entries[0]);
  assert.strictEqual(calibrated.canonicalRecordBytes, actual.canonicalRecordBytes);
  assert.strictEqual(calibrated.canonicalRecordEnvelopeBytes,
    actual.canonicalRecordBytes - actual.canonicalFilesBytes);
  assert.throws(() => schema.assertSnapshotRestoreHistoryProofDocument({
    ...record, updatedAt: timestamp,
  }, files), /未知或缺失/);
  assert.throws(() => schema.assertSnapshotRestoreHistoryProofDocument({
    ...record,
    entries: [{ ...record.entries[0], extra: true }],
  }, files), /未知或缺失/);
  assert.throws(() => schema.assertSnapshotRestoreHistoryProofDocument({
    ...record,
    entries: [{
      ...record.entries[0],
      provenance: { ...record.entries[0].provenance, path: '/private' },
    }],
  }, files), /未知或缺失/);

  const sixtyFourMiB = 64 * 1024 * 1024;
  const baseChunk = Math.floor(sixtyFourMiB / 300);
  const remainder = sixtyFourMiB - baseChunk * 300;
  const maximum = Array.from({ length: 300 }, (_, index) => ({
    path: `${String.fromCodePoint(0x10000 + index)}${'😀'.repeat(1020)}.md`,
    summary: '😀'.repeat(1024),
    beforeExists: true,
    beforeByteLength: baseChunk + (index < remainder ? 1 : 0),
    afterByteLength: baseChunk + (index < remainder ? 1 : 0),
    createdIdentityDigest: null,
  }));
  const maximumSelectedIds = Array.from({ length: 300 }, (_, index) =>
    `selected_${String(index).padStart(3, '0')}_${'x'.repeat(115)}`);
  const maximumTemplate = snapshotRestoreHistoryDocument([], maximumSelectedIds, true);
  const maximumAccount = schema.accountSnapshotRestoreHistoryBase64Fixture(
    maximum,
    maximumTemplate.entries[0]
  );
  assert.strictEqual(maximumAccount.fileCount, 300);
  assert.strictEqual(maximumAccount.afterBytes, sixtyFourMiB);
  assert.strictEqual(maximumAccount.beforeAndAfterBytes, 128 * 1024 * 1024);
  assert(maximumAccount.canonicalRecordBytes <
    schema.SNAPSHOT_RESTORE_HISTORY_LIMITS.maxCanonicalRecordBytes);
  assert.throws(() => schema.accountSnapshotRestoreHistoryBase64Fixture([
    ...maximum,
    { ...maximum[0], path: 'chapters/overflow.md' },
  ], maximumTemplate.entries[0]), /数量/);
  assert.throws(() => schema.accountSnapshotRestoreHistoryBase64Fixture([{
    ...maximum[0], afterByteLength: sixtyFourMiB + 1,
  }], snapshotRestoreHistoryDocument([], ['selected_a']).entries[0]), /安全整数|预算超限/);
});

console.log(`\n${passed}/${passed} evidence delivery schema tests passed.`);
