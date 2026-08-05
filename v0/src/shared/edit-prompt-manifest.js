'use strict';

// The prompt compiler is Main-owned, but its public semantic projection is
// shared so every AI entry discloses the same revision, budget, priority and
// omission meaning without exposing edit.md body content.

const SCHEMA = 'writcraft.edit-prompt-manifest/v1';
const PATH = 'edit.md';
const BUDGET_CHARS = 6000;
const BUDGET_BYTES = 18 * 1024;
const SELECTION_POLICY = 'required_sections_then_source_order';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function createEditPromptManifest({
  rawContent,
  compiledContent,
  revision,
  compiledResult,
  fallbackToRaw = false,
}) {
  if (typeof rawContent !== 'string' || typeof compiledContent !== 'string' ||
      typeof revision !== 'string' || !revision) {
    throw new TypeError('Invalid edit prompt manifest input');
  }
  const sections = Array.isArray(compiledResult?.sections) ? compiledResult.sections : [];
  const totalSectionCount = sections.length;
  const usedSectionCount = sections.filter(section => section?.status === 'used').length;
  const omittedSectionCount = sections.filter(section => section?.status === 'omitted').length;
  const truncated = compiledResult?.truncated === true || omittedSectionCount > 0;
  const safeFallback = fallbackToRaw === true;
  return deepFreeze({
    schema: SCHEMA,
    path: PATH,
    revision,
    rawChars: rawContent.length,
    rawBytes: bytes(rawContent),
    compiledChars: compiledContent.length,
    compiledBytes: bytes(compiledContent),
    budgetChars: BUDGET_CHARS,
    budgetBytes: BUDGET_BYTES,
    selectionPolicy: SELECTION_POLICY,
    totalSectionCount,
    usedSectionCount,
    omittedSectionCount,
    omissionReason: omittedSectionCount > 0 ? 'budget' : null,
    truncated,
    truncationReason: safeFallback ? 'fallback_to_raw' : (truncated ? 'budget' : null),
    fallbackToRaw: safeFallback,
  });
}

module.exports = {
  SCHEMA,
  PATH,
  BUDGET_CHARS,
  BUDGET_BYTES,
  SELECTION_POLICY,
  createEditPromptManifest,
};
