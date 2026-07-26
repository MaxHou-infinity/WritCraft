// DOM-free Renderer validation and routing for Changes / History recovery v1.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftChangesHistoryRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const QUERY_SCHEMA = 'writcraft.changes-history-recovery-query/v1';
  const RESOLVE_SCHEMA = 'writcraft.changes-history-recovery-resolve/v1';
  const CLEAR_SCHEMA = 'writcraft.changes-history-recovery-clear/v1';
  const ERROR_SCHEMA = 'writcraft.changes-history-error/v1';
  const OPERATION_ID_RE = /^chr_[a-f0-9]{48}$/;
  const KINDS = Object.freeze(['apply', 'review', 'undo']);
  const STATES = Object.freeze(['applying', 'terminal']);
  const OUTCOMES = Object.freeze([
    'applied',
    'reviewed',
    'undone',
    'zero_write_error',
    'committed_warning',
    'manual_recovery',
  ]);
  const SAFE_OUTCOMES = new Set(['applied', 'reviewed', 'undone', 'zero_write_error']);
  const MANUAL_OUTCOMES = new Set(['committed_warning', 'manual_recovery']);
  const RECOVERY_KEYS = Object.freeze([
    'operationId',
    'kind',
    'state',
    'outcome',
    'affectedPaths',
    'createdAt',
    'updatedAt',
    'actions',
  ]);
  const MAX_PATHS = 64;
  const MAX_PATH_BYTES = 1024;

  function dataRecord(value, exactKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    if (exactKeys) {
      const expected = [...exactKeys].sort();
      if (actual.length !== expected.length ||
          actual.some((key, index) => key !== expected[index])) return null;
    }
    const copy = Object.create(null);
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true ||
          key === '__proto__' || key === 'prototype' || key === 'constructor') return null;
      copy[key] = descriptor.value;
    }
    return copy;
  }

  function byteLength(value) {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
    if (typeof Buffer === 'function') return Buffer.byteLength(value, 'utf8');
    return unescape(encodeURIComponent(value)).length;
  }

  function validPath(value) {
    if (typeof value !== 'string' || !value || byteLength(value) > MAX_PATH_BYTES ||
        value !== value.normalize('NFC') || value.startsWith('/') || value.includes('\\') ||
        value.includes('//') || /^[A-Za-z]:/.test(value) ||
        /[\u0000-\u001F\u007F-\u009F]/u.test(value)) return false;
    const parts = value.split('/');
    return !parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) &&
      /\.(?:md|markdown)$/i.test(parts[parts.length - 1]);
  }

  function clonePaths(value) {
    if (!Array.isArray(value) || value.length > MAX_PATHS) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(?:0|[1-9][0-9]*)$/.test(key) || !Object.hasOwn(descriptors[key], 'value') ||
          descriptors[key].enumerable !== true))) return null;
    const paths = [];
    const seen = new Set();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !validPath(descriptor.value) ||
          seen.has(descriptor.value)) return null;
      seen.add(descriptor.value);
      paths.push(descriptor.value);
    }
    return Object.freeze(paths);
  }

  function cloneActions(value, manual) {
    if (!Array.isArray(value)) return null;
    const expected = manual ? ['restore_before', 'keep_after'] : [];
    if (value.length !== expected.length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < expected.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          descriptor.value !== expected[index]) return null;
    }
    return Object.freeze([...expected]);
  }

  function validTimestamp(value) {
    return typeof value === 'string' && value.length >= 20 && value.length <= 40 &&
      !Number.isNaN(Date.parse(value));
  }

  function kindOutcomeMatches(kind, state, outcome) {
    if (state === 'applying') return outcome === null;
    if (MANUAL_OUTCOMES.has(outcome) || outcome === 'zero_write_error') return true;
    return (kind === 'apply' && outcome === 'applied') ||
      (kind === 'review' && outcome === 'reviewed') ||
      (kind === 'undo' && outcome === 'undone');
  }

  function normalizeRecovery(value) {
    const raw = dataRecord(value, RECOVERY_KEYS);
    if (!raw || !OPERATION_ID_RE.test(raw.operationId || '') ||
        !KINDS.includes(raw.kind) || !STATES.includes(raw.state) ||
        (raw.state === 'applying' ? raw.outcome !== null : !OUTCOMES.includes(raw.outcome)) ||
        !kindOutcomeMatches(raw.kind, raw.state, raw.outcome) ||
        !validTimestamp(raw.createdAt) || !validTimestamp(raw.updatedAt) ||
        Date.parse(raw.updatedAt) < Date.parse(raw.createdAt)) return null;
    const affectedPaths = clonePaths(raw.affectedPaths);
    if (!affectedPaths ||
        (raw.kind === 'review' ? affectedPaths.length !== 0 : affectedPaths.length === 0)) return null;
    const actions = cloneActions(raw.actions, MANUAL_OUTCOMES.has(raw.outcome));
    if (!actions) return null;
    return Object.freeze({
      operationId: raw.operationId,
      kind: raw.kind,
      state: raw.state,
      outcome: raw.outcome,
      affectedPaths,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      actions,
    });
  }

  function normalizeError(value) {
    const raw = dataRecord(value, ['code', 'message', 'recoverable']);
    if (!raw || typeof raw.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(raw.code) ||
        typeof raw.message !== 'string' || byteLength(raw.message) > 1024 ||
        typeof raw.recoverable !== 'boolean') return null;
    return Object.freeze({
      code: raw.code,
      message: raw.message,
      recoverable: raw.recoverable,
    });
  }

  function normalizeFailure(value) {
    const raw = dataRecord(value);
    if (!raw || raw.ok !== false || raw.schema !== ERROR_SCHEMA || !normalizeError(raw.error)) return null;
    const allowed = new Set([
      'ok', 'schema', 'operationId', 'outcome', 'affectedPaths', 'recoveryRequired',
      'consumed', 'retryable', 'error',
    ]);
    if (Object.keys(raw).some(key => !allowed.has(key))) return null;
    if (Object.hasOwn(raw, 'operationId') &&
        raw.operationId !== null && !OPERATION_ID_RE.test(raw.operationId || '')) return null;
    if (Object.hasOwn(raw, 'outcome') &&
        raw.outcome !== null && !OUTCOMES.includes(raw.outcome)) return null;
    const affectedPaths = Object.hasOwn(raw, 'affectedPaths')
      ? clonePaths(raw.affectedPaths)
      : undefined;
    if (Object.hasOwn(raw, 'affectedPaths') && !affectedPaths) return null;
    for (const key of ['recoveryRequired', 'consumed', 'retryable']) {
      if (Object.hasOwn(raw, key) && typeof raw[key] !== 'boolean') return null;
    }
    const normalized = {
      ok: false,
      schema: ERROR_SCHEMA,
      error: normalizeError(raw.error),
    };
    for (const key of ['operationId', 'outcome', 'recoveryRequired', 'consumed', 'retryable']) {
      if (Object.hasOwn(raw, key)) normalized[key] = raw[key];
    }
    if (affectedPaths) normalized.affectedPaths = affectedPaths;
    return Object.freeze(normalized);
  }

  function normalizeRecoveryEnvelope(value, schema) {
    const raw = dataRecord(value);
    if (!raw) return null;
    if (raw.ok === false) return normalizeFailure(value);
    if (!dataRecord(value, ['ok', 'schema', 'recovery']) ||
        raw.ok !== true || raw.schema !== schema) return null;
    if (raw.recovery === null) {
      return schema === QUERY_SCHEMA
        ? Object.freeze({ ok: true, schema, recovery: null })
        : null;
    }
    const recovery = normalizeRecovery(raw.recovery);
    return recovery ? Object.freeze({ ok: true, schema, recovery }) : null;
  }

  function normalizeQueryResult(value) {
    return normalizeRecoveryEnvelope(value, QUERY_SCHEMA);
  }

  function normalizeResolveResult(value) {
    return normalizeRecoveryEnvelope(value, RESOLVE_SCHEMA);
  }

  function normalizeClearResult(value) {
    const raw = dataRecord(value);
    if (!raw) return null;
    if (raw.ok === false) return normalizeFailure(value);
    if (!dataRecord(value, ['ok', 'schema', 'operationId']) ||
        raw.ok !== true || raw.schema !== CLEAR_SCHEMA ||
        !OPERATION_ID_RE.test(raw.operationId || '')) return null;
    return Object.freeze({ ok: true, schema: CLEAR_SCHEMA, operationId: raw.operationId });
  }

  function routeQueryResult(value) {
    const result = normalizeQueryResult(value);
    if (!result || result.ok !== true) {
      return Object.freeze({ action: 'reopen-required', recovery: null });
    }
    if (result.recovery === null) {
      return Object.freeze({ action: 'ready', recovery: null });
    }
    if (result.recovery.state !== 'terminal') {
      return Object.freeze({ action: 'reopen-required', recovery: result.recovery });
    }
    if (SAFE_OUTCOMES.has(result.recovery.outcome)) {
      return Object.freeze({ action: 'reload-and-clear', recovery: result.recovery });
    }
    if (MANUAL_OUTCOMES.has(result.recovery.outcome)) {
      return Object.freeze({ action: 'manual-recovery', recovery: result.recovery });
    }
    return Object.freeze({ action: 'reopen-required', recovery: result.recovery });
  }

  function normalizeMutationResult(value) {
    const raw = dataRecord(value);
    if (!raw || typeof raw.ok !== 'boolean') return null;
    if (raw.ok === false && raw.schema !== ERROR_SCHEMA) return null;
    if (!OPERATION_ID_RE.test(raw.operationId || '') || !OUTCOMES.includes(raw.outcome)) return null;
    const affectedPaths = clonePaths(raw.affectedPaths);
    if (!affectedPaths) return null;
    if (raw.ok === true && typeof raw.status !== 'string') return null;
    if (raw.ok === false && !normalizeError(raw.error)) return null;
    return Object.freeze({
      ok: raw.ok,
      operationId: raw.operationId,
      outcome: raw.outcome,
      affectedPaths,
    });
  }

  function samePaths(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }

  function mutationMatchesRecovery(kind, mutationValue, recoveryValue) {
    const mutation = normalizeMutationResult(mutationValue);
    const recovery = normalizeRecovery(recoveryValue);
    const allowedKinds = kind === 'apply' ? new Set(['apply', 'review']) :
      kind === 'undo' ? new Set(['undo']) : null;
    return Boolean(mutation && recovery && allowedKinds && allowedKinds.has(recovery.kind) &&
      mutation.operationId === recovery.operationId &&
      mutation.outcome === recovery.outcome &&
      samePaths(mutation.affectedPaths, recovery.affectedPaths));
  }

  function resolveMatchesRecovery(resolveValue, expectedRecovery, expectedAction) {
    const result = normalizeResolveResult(resolveValue);
    const recovery = normalizeRecovery(expectedRecovery);
    return Boolean(result?.ok === true && result.recovery && recovery &&
      ['restore_before', 'keep_after'].includes(expectedAction) &&
      result.recovery.operationId === recovery.operationId &&
      samePaths(result.recovery.affectedPaths, recovery.affectedPaths));
  }

  function clearMatchesRecovery(clearValue, expectedRecovery) {
    const result = normalizeClearResult(clearValue);
    const recovery = normalizeRecovery(expectedRecovery);
    return Boolean(result?.ok === true && recovery &&
      result.operationId === recovery.operationId);
  }

  return Object.freeze({
    QUERY_SCHEMA,
    RESOLVE_SCHEMA,
    CLEAR_SCHEMA,
    ERROR_SCHEMA,
    normalizeRecovery,
    normalizeQueryResult,
    normalizeResolveResult,
    normalizeClearResult,
    normalizeMutationResult,
    routeQueryResult,
    mutationMatchesRecovery,
    resolveMatchesRecovery,
    clearMatchesRecovery,
  });
});
