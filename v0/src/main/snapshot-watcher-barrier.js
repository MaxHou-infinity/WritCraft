'use strict';

const OWNER_KIND = 'SNAPSHOT_CREATE';
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/u;

class SnapshotWatcherBarrierError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotWatcherBarrierError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotWatcherBarrierError(code, message);
}

function stableCode(error, fallback) {
  return typeof error?.code === 'string' && ERROR_CODE_RE.test(error.code)
    ? error.code
    : fallback;
}

function assertOwner(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) ||
      typeof owner.projectInstanceId !== 'string' || !owner.projectInstanceId ||
      !Number.isSafeInteger(owner.ownerGeneration) || owner.ownerGeneration < 0 ||
      typeof owner.taskId !== 'string' || !owner.taskId || owner.kind !== OWNER_KIND) {
    fail('SNAPSHOT_OWNER_INVALID', 'Snapshot watcher owner is invalid');
  }
  return owner;
}

function sameProject(left, right) {
  return Boolean(left && right && left.instanceId === right.instanceId &&
    left.rootPath === right.rootPath);
}

function createSnapshotWatcherBarrierAdapter(options = {}) {
  const required = [
    'getCurrentProject', 'getCurrentWatcher', 'getMutationGeneration',
    'assertWatcherAvailable', 'markWatcherDegraded', 'beginMutation',
    'endMutation', 'getActiveLease', 'drainDeferredWatcherPayloads',
  ];
  for (const name of required) {
    if (typeof options[name] !== 'function') throw new TypeError(`${name} is required`);
  }
  const liveBindings = new WeakSet();

  function currentProjectFor(owner) {
    const project = options.getCurrentProject();
    if (!project || project.instanceId !== owner.projectInstanceId ||
        typeof project.rootPath !== 'string' || !project.rootPath) {
      fail('PROJECT_CHANGED', 'Snapshot project changed');
    }
    return project;
  }

  function assertLeaseBinding(owner, lease) {
    assertOwner(owner);
    if (!lease || typeof lease !== 'object' || !liveBindings.has(lease) ||
        lease.projectInstanceId !== owner.projectInstanceId ||
        lease.ownerGeneration !== owner.ownerGeneration ||
        lease.taskId !== owner.taskId || lease.kind !== owner.kind) {
      fail('SNAPSHOT_LEASE_STALE', 'Snapshot lease is stale');
    }
    const project = currentProjectFor(owner);
    if (!sameProject(project, lease.project) ||
        options.getCurrentWatcher() !== lease.watcher ||
        options.getActiveLease(lease.project.rootPath) !== lease.token) {
      fail('SNAPSHOT_LEASE_STALE', 'Snapshot lease is stale');
    }
    options.assertWatcherAvailable(project);
    return project;
  }

  function acquireLease(rawOwner) {
    const owner = assertOwner(rawOwner);
    const project = currentProjectFor(owner);
    options.assertWatcherAvailable(project);
    const watcher = options.getCurrentWatcher();
    if (!watcher || typeof watcher.flush !== 'function') {
      fail('PROJECT_WATCHER_UNAVAILABLE', 'Snapshot watcher is unavailable');
    }
    const token = options.beginMutation(project);
    if (!token || typeof token !== 'object') {
      fail('SNAPSHOT_LEASE_INVALID', 'Snapshot mutation lease is invalid');
    }
    const lease = Object.freeze({
      projectInstanceId: owner.projectInstanceId,
      ownerGeneration: owner.ownerGeneration,
      taskId: owner.taskId,
      kind: owner.kind,
      project,
      watcher,
      token,
    });
    liveBindings.add(lease);
    try {
      assertLeaseBinding(owner, lease);
      return lease;
    } catch (error) {
      liveBindings.delete(lease);
      try { options.endMutation(token, project); } catch (_) {}
      throw error;
    }
  }

  function assertOwnerCurrent(binding) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
      fail('SNAPSHOT_OWNER_INVALID', 'Snapshot owner binding is invalid');
    }
    return assertLeaseBinding(binding, binding.lease);
  }

  function aborted(signal) {
    if (signal?.aborted) fail('REQUEST_ABORTED', 'Snapshot watcher barrier was aborted');
  }

  async function settleWatcherBarrier(binding) {
    const project = assertOwnerCurrent(binding);
    const lease = binding.lease;
    const watcher = lease.watcher;
    aborted(binding.signal);
    let flushed;
    try {
      flushed = await watcher.flush();
    } catch (error) {
      try {
        assertLeaseBinding(binding, lease);
      } catch (stale) {
        throw stale;
      }
      options.markWatcherDegraded(project);
      fail('PROJECT_WATCHER_UNAVAILABLE',
        `Snapshot watcher barrier failed: ${stableCode(error, 'PROJECT_WATCHER_FLUSH_FAILED')}`);
    }
    const current = assertLeaseBinding(binding, lease);
    aborted(binding.signal);
    if (!flushed || flushed.ok !== true) {
      options.markWatcherDegraded(current);
      fail('PROJECT_WATCHER_UNAVAILABLE', 'Snapshot watcher barrier did not complete');
    }
    const drained = options.drainDeferredWatcherPayloads(current, lease.token);
    if (!Number.isSafeInteger(drained) || drained < 0) {
      fail('SNAPSHOT_BARRIER_INVALID', 'Snapshot watcher drain result is invalid');
    }
    assertLeaseBinding(binding, lease);
    aborted(binding.signal);
    const mutationGeneration = options.getMutationGeneration();
    if (!Number.isSafeInteger(mutationGeneration) || mutationGeneration < 0) {
      fail('SNAPSHOT_BARRIER_INVALID', 'Snapshot mutation generation is invalid');
    }
    return Object.freeze({
      projectInstanceId: current.instanceId,
      mutationGeneration,
    });
  }

  function releaseLease(lease, terminalBinding) {
    if (!lease || typeof lease !== 'object' || !liveBindings.has(lease)) return false;
    if (!terminalBinding || terminalBinding.projectInstanceId !== lease.projectInstanceId ||
        terminalBinding.ownerGeneration !== lease.ownerGeneration ||
        terminalBinding.taskId !== lease.taskId || terminalBinding.kind !== lease.kind ||
        !['COMMITTED', 'UNCOMMITTED'].includes(terminalBinding.terminalTruth)) {
      return false;
    }
    liveBindings.delete(lease);
    if (options.getActiveLease(lease.project.rootPath) !== lease.token) return false;
    options.endMutation(lease.token, lease.project);
    return options.getActiveLease(lease.project.rootPath) !== lease.token;
  }

  return Object.freeze({
    acquireLease,
    assertOwnerCurrent,
    settleWatcherBarrier,
    releaseLease,
  });
}

module.exports = Object.freeze({
  OWNER_KIND,
  SnapshotWatcherBarrierError,
  createSnapshotWatcherBarrierAdapter,
});
