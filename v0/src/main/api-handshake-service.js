'use strict';

// Public projection for the read-only MiniMax models handshake. This module is
// deliberately small so its privacy boundary can be verified without booting
// Electron: provider payloads, thrown messages and key material never cross it.
const PUBLIC_FAILURE_REASONS = new Set([
  'NO_KEY',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'API_FAILED',
  'TIMEOUT',
  'REQUEST_ABORTED',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
  'REQUEST_FAILED',
]);
// The provider contract may contain other metadata strings; only MiniMax model
// identifiers are public. In particular, a key-shaped string must never be
// accepted as a renderer-visible model id.
const PUBLIC_MODEL_ID_RE = /^MiniMax-(?:M[1-9][0-9]*(?:\.[0-9]+)?(?:-[A-Za-z0-9][A-Za-z0-9._-]{0,64})?|Text-[A-Za-z0-9][A-Za-z0-9._-]{0,64})$/;

function isPublicModelId(value) {
  if (typeof value !== 'string' || !PUBLIC_MODEL_ID_RE.test(value)) return false;
  const normalized = value.toLocaleLowerCase('en-US');
  return !normalized.includes('sk-api-') && !normalized.includes('sk-cp-');
}

function safeLatency(startedAt, finishedAt) {
  const elapsed = Number(finishedAt) - Number(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(elapsed));
}

function stableReason(value) {
  return PUBLIC_FAILURE_REASONS.has(value) ? value : 'REQUEST_FAILED';
}

async function runApiHandshake(options = {}) {
  const checkModels = options.checkModels;
  const now = typeof options.now === 'function' ? options.now : () => performance.now();
  const startedAt = now();
  let result;
  try {
    result = typeof checkModels === 'function'
      ? await checkModels({ apiKey: options.apiKey, fetchImpl: options.fetchImpl })
      : { ok: false, error: 'SERVICE_UNAVAILABLE' };
  } catch (_) {
    result = { ok: false, error: 'REQUEST_FAILED' };
  }
  const latencyMs = safeLatency(startedAt, now());
  if (!result?.ok) {
    return { ok: false, reason: stableReason(result?.error), latencyMs };
  }

  if (!Array.isArray(result.models)
    || result.models.length > 256
    || result.models.some(model => !isPublicModelId(model))) {
    return { ok: false, reason: 'INVALID_RESPONSE', latencyMs };
  }
  const models = result.models.slice();
  const defaultModelAvailable = typeof options.defaultModel === 'string'
    ? models.includes(options.defaultModel)
    : undefined;
  return {
    ok: true,
    latencyMs,
    modelCount: models.length,
    models,
    ...(defaultModelAvailable === undefined ? {} : { defaultModelAvailable }),
  };
}

module.exports = {
  PUBLIC_FAILURE_REASONS,
  isPublicModelId,
  runApiHandshake,
  safeLatency,
  stableReason,
};
