'use strict';

// Main-only composition for the delivery preflight handler. The adapter owns
// the capability store and keeps each immutable snapshot result request-scoped;
// Renderer input never reaches a root/path-backed reader.
const deliveryService = require('./delivery-preflight-service');
const deliveryHandler = require('./delivery-preflight-handler');
const providerModule = require('./snapshot-delivery-provider-adapter');

class DeliveryPreflightMainAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryPreflightMainAdapterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DeliveryPreflightMainAdapterError(code, message);
}

function assertCapabilityStore(store) {
  if (!store || typeof store.issue !== 'function' || typeof store.revoke !== 'function') {
    throw new TypeError('capabilityStore.issue/revoke are required');
  }
}

function bindingForCapability(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      typeof binding.webContentsId !== 'number' || !Number.isSafeInteger(binding.webContentsId) ||
      typeof binding.projectInstanceId !== 'string' ||
      !Number.isSafeInteger(binding.ownerGeneration) || binding.ownerGeneration < 0 ||
      !Number.isSafeInteger(binding.mutationGeneration) || binding.mutationGeneration < 0 ||
      !Number.isSafeInteger(binding.navigationEpoch) || binding.navigationEpoch < 0) {
    fail('DELIVERY_BLOCKED', 'delivery capability owner binding 不可用');
  }
  return Object.freeze({
    ownerId: `webcontents:${binding.webContentsId}`,
    projectInstanceId: binding.projectInstanceId,
    ownerGeneration: binding.ownerGeneration,
    mutationGeneration: binding.mutationGeneration,
    navigationEpoch: binding.navigationEpoch,
  });
}

function requestKey(request, binding) {
  return [
    request.projectInstanceId,
    request.snapshotId,
    binding.webContentsId,
    binding.ownerGeneration,
    binding.mutationGeneration,
    binding.navigationEpoch,
  ].join('\0');
}

function createDeliveryPreflightMainAdapter(options = {}) {
  const {
    assertTrustedSender,
    captureBinding,
    settleAuthority,
    readCommittedBundle,
    readCorrectionArtifact,
    buildSnapshotGraph,
    buildSnapshotSourceIndex,
    decodeImage,
    capabilityStore,
    maxPendingSnapshots = 8,
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender, captureBinding, settleAuthority, readCommittedBundle,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  assertCapabilityStore(capabilityStore);
  if (!Number.isSafeInteger(maxPendingSnapshots) || maxPendingSnapshots < 1 || maxPendingSnapshots > 32) {
    throw new TypeError('maxPendingSnapshots must be 1..32');
  }

  const pending = new Map();
  const issuedBindings = new Map();

  function rememberPending(key, value) {
    pending.delete(key);
    pending.set(key, value);
    while (pending.size > maxPendingSnapshots) pending.delete(pending.keys().next().value);
  }

  function takePending(context) {
    const key = requestKey(context.request, context.binding);
    const value = pending.get(key);
    if (!value) fail('DELIVERY_STALE', 'snapshot 预检上下文已过期');
    return value;
  }

  function issueDeliveryCapability(info, binding) {
    const owner = bindingForCapability(binding);
    if (!info || typeof info !== 'object' || Array.isArray(info)) {
      fail('DELIVERY_BLOCKED', 'delivery capability 请求无效');
    }
    if (info.projectInstanceId !== owner.projectInstanceId ||
        info.ownerGeneration !== owner.ownerGeneration) {
      fail('DELIVERY_STALE', 'delivery capability owner 已漂移');
    }
    const issued = capabilityStore.issue(owner, {
      subjectId: info.subjectId,
      authorityDigest: info.authorityDigest,
      selectionDigest: info.selectionDigest,
    });
    issuedBindings.set(issued.capabilityId, owner);
    while (issuedBindings.size > 512) issuedBindings.delete(issuedBindings.keys().next().value);
    return issued;
  }

  function revokeDeliveryCapability(info) {
    if (!info || typeof info !== 'object' || Array.isArray(info) ||
        typeof info.capabilityId !== 'string') return false;
    const owner = issuedBindings.get(info.capabilityId);
    if (!owner || owner.projectInstanceId !== info.projectInstanceId ||
        owner.ownerGeneration !== info.ownerGeneration) return false;
    try {
      const result = capabilityStore.revoke(owner, { capabilityId: info.capabilityId });
      if (result === true) issuedBindings.delete(info.capabilityId);
      return result === true;
    } catch (_) {
      return false;
    }
  }

  const provider = providerModule.createSnapshotDeliveryProvider({
    readCommittedBundle,
    ...(typeof readCorrectionArtifact === 'function' ? { readCorrectionArtifact } : {}),
    ...(buildSnapshotGraph ? { buildSnapshotGraph } : {}),
    ...(buildSnapshotSourceIndex ? { buildSnapshotSourceIndex } : {}),
  });

  const handler = deliveryHandler.createDeliveryPreflightHandler({
    assertTrustedSender,
    captureBinding,
    settleAuthority,
    revokeDeliveryCapability,
    readSnapshot: async context => {
      const key = requestKey(context.request, context.binding);
      const result = await provider.read(Object.freeze({
        projectInstanceId: context.request.projectInstanceId,
        snapshotId: context.request.snapshotId,
      }));
      rememberPending(key, Object.freeze(result));
      return result.snapshot;
    },
    readGraph: async context => takePending(context).graph,
    readSourceIndex: async context => {
      const key = requestKey(context.request, context.binding);
      const value = takePending(context);
      pending.delete(key);
      return value.sourceIndex;
    },
    createService: ({ binding }) => deliveryService.createDeliveryPreflightService({
      issueDeliveryCapability: info => issueDeliveryCapability(info, binding),
      ...(typeof decodeImage === 'function' ? { decodeImage } : {}),
    }),
  });

  return Object.freeze({
    preflight: handler.preflight,
    revokeDeliveryCapability,
    pendingSize: () => pending.size,
  });
}

module.exports = Object.freeze({
  DeliveryPreflightMainAdapterError,
  createDeliveryPreflightMainAdapter,
});
