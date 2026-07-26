'use strict';

const crypto = require('crypto');

const POLICY_VERSION = 1;
const MAX_EXCLUDED_CHIPS = 20;
const MAX_MANIFEST_CHIPS = 64;
const MAX_CHIP_ID_LENGTH = 256;
// The exact selection is part of the authority of a selection-scoped request,
// not an optional retrieval hint. Letting a renderer exclude it would turn a
// visibly selection-scoped question into a different request.
const REQUIRED_TYPES = new Set(['scope', 'project_prompt', 'selection']);

class ContextPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContextPolicyError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ContextPolicyError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validId(value, label) {
  if (typeof value !== 'string' || !value || value.length > MAX_CHIP_ID_LENGTH || /[\u0000-\u001f]/.test(value)) {
    fail('INVALID_CHIP_ID', `${label}包含无效的上下文 ID`);
  }
  return value;
}

function manifestWhitelist(contextManifest) {
  if (!contextManifest || typeof contextManifest !== 'object' || Array.isArray(contextManifest)) {
    fail('INVALID_MANIFEST', '缺少 Main 权威 Context Manifest');
  }
  if (!Array.isArray(contextManifest.chips)) fail('INVALID_MANIFEST', 'Context Manifest 缺少 chips');
  if (contextManifest.chips.length > MAX_MANIFEST_CHIPS) {
    fail('MANIFEST_LIMIT', `Context Manifest 最多包含 ${MAX_MANIFEST_CHIPS} 个 Chip`, {
      limit: MAX_MANIFEST_CHIPS,
      actual: contextManifest.chips.length,
    });
  }

  const all = new Map();
  const optional = new Set();
  const required = new Set();
  for (const chip of contextManifest.chips) {
    if (!chip || typeof chip !== 'object') fail('INVALID_MANIFEST_CHIP', 'Context Manifest 包含无效 Chip');
    const id = validId(chip.id, 'Context Manifest');
    if (all.has(id)) fail('DUPLICATE_MANIFEST_CHIP', `Context Manifest 包含重复 Chip：${id}`, { chipId: id });
    const type = typeof chip.type === 'string' ? chip.type : '';
    if (!type) fail('INVALID_MANIFEST_CHIP', `Context Chip ${id} 缺少类型`, { chipId: id });
    all.set(id, type);
    if (REQUIRED_TYPES.has(type)) required.add(id);
    else optional.add(id);
  }
  return { all, optional, required };
}

function manifestBinding(contextManifest, whitelist) {
  const payload = JSON.stringify({
    scope: typeof contextManifest.scope === 'string' ? contextManifest.scope : null,
    currentFilePath: typeof contextManifest.currentFilePath === 'string' ? contextManifest.currentFilePath : null,
    currentRevision: typeof contextManifest.currentRevision === 'string' ? contextManifest.currentRevision : null,
    chips: [...whitelist.all.entries()],
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Build a bounded exclusion policy from an authoritative Main manifest.
 * Duplicate request IDs are normalized in first-seen order. Unknown and
 * required IDs fail closed. Neither the manifest nor its chips are mutated.
 */
function createExclusionPolicy(contextManifest, excludedChipIds = []) {
  const whitelist = manifestWhitelist(contextManifest);
  if (!Array.isArray(excludedChipIds)) fail('INVALID_POLICY', 'excludedChipIds 必须是数组');
  // Bound work even for hostile renderer payloads before canonicalization.
  if (excludedChipIds.length > MAX_EXCLUDED_CHIPS * 4) {
    fail('POLICY_INPUT_LIMIT', `排除请求最多提交 ${MAX_EXCLUDED_CHIPS * 4} 个 ID`, {
      limit: MAX_EXCLUDED_CHIPS * 4,
      actual: excludedChipIds.length,
    });
  }

  const normalized = [];
  const seen = new Set();
  for (const rawId of excludedChipIds) {
    const id = validId(rawId, '排除策略');
    if (seen.has(id)) continue;
    seen.add(id);
    if (whitelist.required.has(id)) {
      fail('REQUIRED_CONTEXT', '作用域、项目级 Prompt 与当前精确选段是固定上下文，不能排除', { chipId: id });
    }
    if (!whitelist.optional.has(id)) {
      fail('UNKNOWN_CONTEXT', `排除策略引用了不在权威 Manifest 中的 Chip：${id}`, { chipId: id });
    }
    normalized.push(id);
    if (normalized.length > MAX_EXCLUDED_CHIPS) {
      fail('POLICY_LIMIT', `每次最多排除 ${MAX_EXCLUDED_CHIPS} 个可选上下文`, {
        limit: MAX_EXCLUDED_CHIPS,
        actual: normalized.length,
      });
    }
  }

  const excluded = new Set(normalized);
  return deepFreeze({
    version: POLICY_VERSION,
    authority: 'main-context-policy',
    manifestBinding: manifestBinding(contextManifest, whitelist),
    excludedChipIds: normalized,
    includedChipIds: [...whitelist.all.keys()].filter(id => !excluded.has(id)),
    limits: { maxExcludedChips: MAX_EXCLUDED_CHIPS },
  });
}

function policyAppliesToManifest(contextManifest, policy) {
  if (!policy || policy.version !== POLICY_VERSION || typeof policy.manifestBinding !== 'string') return false;
  try {
    const whitelist = manifestWhitelist(contextManifest);
    return crypto.timingSafeEqual(
      Buffer.from(manifestBinding(contextManifest, whitelist), 'hex'),
      Buffer.from(policy.manifestBinding, 'hex'),
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  POLICY_VERSION,
  MAX_EXCLUDED_CHIPS,
  MAX_MANIFEST_CHIPS,
  ContextPolicyError,
  createExclusionPolicy,
  policyAppliesToManifest,
};
