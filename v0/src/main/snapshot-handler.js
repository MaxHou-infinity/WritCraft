'use strict';

const schema = require('./evidence-delivery-schema');

const LIST_REQUEST_SCHEMA = 'writcraft.snapshot-list-request/v1';
const CREATE_REQUEST_SCHEMA = 'writcraft.snapshot-create-request/v1';
const CANCEL_REQUEST_SCHEMA = 'writcraft.local-task-cancel-request/v1';
const LIST_SCHEMA = 'writcraft.snapshot-list/v1';
const CREATE_CONFIRMATION = 'CREATE_SNAPSHOT';
const CANCEL_CONFIRMATION = 'CANCEL_LOCAL_OPERATION';
const MAX_SNAPSHOTS = 20;
const MAX_PRIVATE_BYTES = 2 * 1024 * 1024 * 1024;

class SnapshotHandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotHandlerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotHandlerError(code, message);
}

function exactRequest(raw, expectedSchema, fields, label) {
  schema.assertExactKeys(raw, ['schema', ...fields], label);
  if (raw.schema !== expectedSchema) fail('SNAPSHOT_REQUEST_INVALID', `${label} schema is invalid`);
  schema.assertProjectInstanceId(raw.projectInstanceId);
  return raw;
}

function createSnapshotHandler(options = {}) {
  const required = [
    'assertTrustedSender', 'getCurrentProject', 'captureBinding', 'sameBinding',
    'createWorker', 'storageAvailable',
  ];
  for (const name of required) {
    if (typeof options[name] !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!options.snapshotService || typeof options.snapshotService.create !== 'function') {
    throw new TypeError('snapshotService.create is required');
  }
  if (!options.localOperations || typeof options.localOperations.cancel !== 'function') {
    throw new TypeError('localOperations.cancel is required');
  }

  function owner(event, request) {
    options.assertTrustedSender(event);
    const project = options.getCurrentProject();
    const binding = options.captureBinding(event);
    if (!project || typeof project.rootPath !== 'string' ||
        project.instanceId !== request.projectInstanceId ||
        binding?.projectInstanceId !== request.projectInstanceId ||
        !Number.isSafeInteger(binding.ownerGeneration) || binding.ownerGeneration < 0) {
      fail('SNAPSHOT_STALE', '项目状态已变化，请重新打开本地快照');
    }
    return Object.freeze({ project, binding });
  }

  function assertCurrent(event, initial) {
    const project = options.getCurrentProject();
    const current = options.captureBinding(event);
    if (!project || project.instanceId !== initial.project.instanceId ||
        project.rootPath !== initial.project.rootPath ||
        !options.sameBinding(initial.binding, current)) {
      fail('SNAPSHOT_STALE', '项目状态已变化，请重新打开本地快照');
    }
    return project;
  }

  async function withWorker(event, initial, task) {
    let worker = null;
    let result;
    try {
      worker = await options.createWorker(initial.project);
      assertCurrent(event, initial);
      if (!worker || typeof worker.ready !== 'function' || typeof worker.close !== 'function') {
        fail('SNAPSHOT_WORKER_UNAVAILABLE', '本地快照存储暂不可用');
      }
      await worker.ready();
      assertCurrent(event, initial);
      result = await task(worker);
    } finally {
      if (worker) await worker.close().catch(() => {});
    }
    assertCurrent(event, initial);
    return result;
  }

  async function listFor(event, initial) {
    if (!options.storageAvailable(initial.project)) {
      assertCurrent(event, initial);
      return Object.freeze({
        schema: LIST_SCHEMA,
        projectInstanceId: initial.project.instanceId,
        items: Object.freeze([]),
        unavailableCount: 0,
        capacity: Object.freeze({
          maxSnapshots: MAX_SNAPSHOTS,
          maxPrivateBytes: MAX_PRIVATE_BYTES,
          usedSnapshots: 0,
          usedPrivateBytes: 0,
        }),
      });
    }
    return withWorker(event, initial, async worker => {
      const listed = await worker.listCommitted();
      assertCurrent(event, initial);
      const items = [];
      let unavailableCount = listed.unavailableCount;
      for (const item of listed.items) {
        try {
          const loaded = await worker.readCommittedSnapshot({ snapshotId: item.snapshotId });
          assertCurrent(event, initial);
          const files = loaded.manifest.files || [];
          items.push(Object.freeze({
            snapshotId: item.snapshotId,
            createdAt: loaded.manifest.createdAt,
            status: 'committed',
            markdownCount: files.filter(file => file.kind === 'markdown').length,
            imageCount: files.filter(file => file.kind === 'image').length,
            totalBytes: item.size,
            snapshotManifestDigest: item.snapshotManifestDigest,
          }));
        } catch (error) {
          assertCurrent(event, initial);
          unavailableCount += 1;
        }
      }
      const usedPrivateBytes = items.reduce((total, item) => total + item.totalBytes, 0);
      return Object.freeze({
        schema: LIST_SCHEMA,
        projectInstanceId: initial.project.instanceId,
        items: Object.freeze(items),
        unavailableCount,
        capacity: Object.freeze({
          maxSnapshots: MAX_SNAPSHOTS,
          maxPrivateBytes: MAX_PRIVATE_BYTES,
          usedSnapshots: items.length,
          usedPrivateBytes,
        }),
      });
    });
  }

  async function list(event, rawRequest) {
    options.assertTrustedSender(event);
    const request = exactRequest(rawRequest, LIST_REQUEST_SCHEMA, ['projectInstanceId'],
      'snapshot list request');
    const initial = owner(event, request);
    return listFor(event, initial);
  }

  async function create(event, rawRequest) {
    options.assertTrustedSender(event);
    const request = exactRequest(rawRequest, CREATE_REQUEST_SCHEMA,
      ['projectInstanceId', 'confirmation'], 'snapshot create request');
    if (request.confirmation !== CREATE_CONFIRMATION) {
      fail('SNAPSHOT_CONFIRMATION_REQUIRED', '创建本地快照需要明确确认');
    }
    const initial = owner(event, request);
    const before = await listFor(event, initial);
    if (before.unavailableCount !== 0 || before.capacity.usedSnapshots >= MAX_SNAPSHOTS ||
        before.capacity.usedPrivateBytes >= MAX_PRIVATE_BYTES) {
      fail('SNAPSHOT_CAPACITY_EXCEEDED', '本地快照容量已满；不会自动删除旧快照');
    }
    assertCurrent(event, initial);
    return options.snapshotService.create({
      projectInstanceId: request.projectInstanceId,
      ownerGeneration: initial.binding.ownerGeneration,
      confirmation: CREATE_CONFIRMATION,
    });
  }

  function cancel(event, rawRequest) {
    options.assertTrustedSender(event);
    const request = exactRequest(rawRequest, CANCEL_REQUEST_SCHEMA,
      ['projectInstanceId', 'taskId', 'confirmation'], 'snapshot cancel request');
    schema.assertOpaqueId(request.taskId, 'taskId');
    if (request.confirmation !== CANCEL_CONFIRMATION) {
      fail('SNAPSHOT_CONFIRMATION_REQUIRED', '取消本地快照需要明确确认');
    }
    owner(event, request);
    return options.localOperations.cancel({
      projectInstanceId: request.projectInstanceId,
      taskId: request.taskId,
    });
  }

  return Object.freeze({ create, list, cancel });
}

module.exports = Object.freeze({
  LIST_REQUEST_SCHEMA,
  CREATE_REQUEST_SCHEMA,
  CANCEL_REQUEST_SCHEMA,
  LIST_SCHEMA,
  CREATE_CONFIRMATION,
  CANCEL_CONFIRMATION,
  MAX_SNAPSHOTS,
  MAX_PRIVATE_BYTES,
  SnapshotHandlerError,
  createSnapshotHandler,
});
