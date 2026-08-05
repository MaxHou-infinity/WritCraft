'use strict';

// Cross-entry, Main-owned context disclosure. This module contains only
// bounded metadata; it never accepts or returns project root paths or body
// content. Each entry may retain its legacy display fields, but this envelope
// is the stable semantic contract used for cross-entry comparisons.

const SCHEMA = 'writcraft.context-manifest/v2';
const AUTHORITY = 'main';
const EDIT_PROMPT_SCHEMA = 'writcraft.edit-prompt-manifest/v1';
const EDIT_PROMPT_BUDGET_CHARS = 6000;
const EDIT_PROMPT_BUDGET_BYTES = 18 * 1024;
const EDIT_SELECTION_POLICY = 'required_sections_then_source_order';
const ENTRIES = new Set(['chat', 'navigation', 'research', 'chapter', 'changes']);
const ITEM_KINDS = new Set(['project_prompt', 'current_file', 'context', 'source', 'entity', 'target', 'selection']);
const ITEM_STATUSES = new Set(['included', 'omitted', 'unavailable', 'stale']);
const OMIT_REASONS = new Set(['not_selected', 'budget', 'unavailable', 'invalid_edit', 'stale', 'project_mismatch']);
const TRUNCATION_REASONS = new Set(['item_budget', 'aggregate_budget', 'edit_prompt_budget']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function safeCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function safeBytes(value, field, nullable = false) {
  if (nullable && value === null) return null;
  return safeCount(value, field);
}

function validRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function createEditCompilation({
  rawContent,
  compiledContent,
  revision,
  compiledResult,
  unavailable = false,
}) {
  if (typeof rawContent !== 'string' || typeof compiledContent !== 'string' ||
      typeof revision !== 'string' || !revision) throw new TypeError('Invalid edit compilation input');
  const sections = Array.isArray(compiledResult?.sections) ? compiledResult.sections : [];
  const totalSectionCount = sections.length;
  const usedSectionCount = sections.filter(section => section?.status === 'used').length;
  const omittedSectionCount = sections.filter(section => section?.status === 'omitted').length;
  const truncated = !unavailable && (compiledResult?.truncated === true || omittedSectionCount > 0);
  return deepFreeze({
    status: unavailable ? 'unavailable' : (truncated ? 'truncated' : 'complete'),
    rawBytes: utf8Bytes(rawContent),
    compiledBytes: utf8Bytes(compiledContent),
    budgetBytes: EDIT_PROMPT_BUDGET_BYTES,
    budgetChars: EDIT_PROMPT_BUDGET_CHARS,
    availableSections: totalSectionCount,
    includedSections: usedSectionCount,
    omittedSections: omittedSectionCount,
    omissionReason: unavailable ? 'invalid_edit' : (omittedSectionCount > 0 ? 'budget' : null),
    truncationReason: truncated ? 'edit_prompt_budget' : null,
    selectionPolicy: EDIT_SELECTION_POLICY,
  });
}

function createEditPromptManifest(options) {
  const compilation = createEditCompilation(options);
  return deepFreeze({
    schema: EDIT_PROMPT_SCHEMA,
    path: 'edit.md',
    revision: options.revision,
    rawChars: String(options.rawContent || '').length,
    rawBytes: compilation.rawBytes,
    compiledChars: String(options.compiledContent || '').length,
    compiledBytes: compilation.compiledBytes,
    budgetChars: compilation.budgetChars,
    budgetBytes: compilation.budgetBytes,
    selectionPolicy: compilation.selectionPolicy,
    totalSectionCount: compilation.availableSections,
    usedSectionCount: compilation.includedSections,
    omittedSectionCount: compilation.omittedSections,
    omissionReason: compilation.omissionReason,
    truncated: compilation.status === 'truncated',
    truncationReason: compilation.truncationReason,
    fallbackToRaw: false,
  });
}

function createContextItem({
  id,
  kind,
  path = null,
  revision = null,
  status = 'included',
  rawBytes = null,
  includedBytes = 0,
  budgetBytes = 0,
  omissionReason = null,
  truncationReason = null,
}) {
  if (typeof id !== 'string' || !id || !ITEM_KINDS.has(kind) || !ITEM_STATUSES.has(status)) {
    throw new TypeError('Invalid context manifest item');
  }
  if (path !== null && !validRelativePath(path)) {
    throw new TypeError('Context manifest item path must be project-relative');
  }
  if (revision !== null && (typeof revision !== 'string' || !revision)) throw new TypeError('Invalid context revision');
  safeBytes(rawBytes, 'rawBytes', true);
  safeBytes(includedBytes, 'includedBytes');
  safeBytes(budgetBytes, 'budgetBytes');
  if (omissionReason !== null && !OMIT_REASONS.has(omissionReason)) throw new TypeError('Invalid omission reason');
  if (truncationReason !== null && !TRUNCATION_REASONS.has(truncationReason)) throw new TypeError('Invalid truncation reason');
  if (status === 'included' && omissionReason !== null) {
    throw new TypeError('Included context item cannot have an omission reason');
  }
  if (status !== 'included' && omissionReason === null) throw new TypeError('Omitted context item needs an omission reason');
  return deepFreeze({ id, kind, path, revision, status, rawBytes, includedBytes, budgetBytes, omissionReason, truncationReason });
}

function sumKnown(items, field) {
  return items.every(item => item[field] !== null)
    ? items.reduce((sum, item) => sum + item[field], 0)
    : null;
}

function createContextManifest({
  entry,
  editRevision,
  editCompilation,
  items = [],
  budgetBytes,
  sourceIndexRevision = null,
}) {
  if (!ENTRIES.has(entry) || typeof editRevision !== 'string' || !editRevision ||
      !editCompilation || !Array.isArray(items)) throw new TypeError('Invalid context manifest input');
  safeBytes(budgetBytes, 'budgetBytes');
  if (sourceIndexRevision !== null && typeof sourceIndexRevision !== 'string') {
    throw new TypeError('Invalid source index revision');
  }
  const normalizedItems = items.map(item => createContextItem(item));
  const ids = new Set();
  for (const item of normalizedItems) {
    if (ids.has(item.id)) throw new TypeError('Duplicate context manifest item id');
    ids.add(item.id);
  }
  const includedItems = normalizedItems.filter(item => item.status === 'included').length;
  return deepFreeze({
    schema: SCHEMA,
    authority: AUTHORITY,
    entry,
    editRevision,
    editCompilation,
    items: deepFreeze(normalizedItems),
    totals: deepFreeze({
      availableItems: normalizedItems.length,
      includedItems,
      omittedItems: normalizedItems.length - includedItems,
      rawBytes: sumKnown(normalizedItems, 'rawBytes'),
      includedBytes: normalizedItems.reduce((sum, item) => sum + item.includedBytes, 0),
      budgetBytes,
    }),
    sourceIndexRevision,
  });
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validContextManifest(value) {
  if (!exactKeys(value, ['schema', 'authority', 'entry', 'editRevision', 'editCompilation', 'items', 'totals', 'sourceIndexRevision']) ||
      value.schema !== SCHEMA || value.authority !== AUTHORITY || !ENTRIES.has(value.entry) ||
      typeof value.editRevision !== 'string' || !Array.isArray(value.items) || !value.totals ||
      !exactKeys(value.totals, ['availableItems', 'includedItems', 'omittedItems', 'rawBytes', 'includedBytes', 'budgetBytes'])) return false;
  if (!exactKeys(value.editCompilation, [
    'status', 'rawBytes', 'compiledBytes', 'budgetBytes', 'budgetChars', 'availableSections',
    'includedSections', 'omittedSections', 'omissionReason', 'truncationReason', 'selectionPolicy',
  ])) return false;
  if (!['complete', 'truncated', 'unavailable'].includes(value.editCompilation.status) ||
      value.editCompilation.budgetBytes !== EDIT_PROMPT_BUDGET_BYTES ||
      value.editCompilation.budgetChars !== EDIT_PROMPT_BUDGET_CHARS ||
      value.editCompilation.selectionPolicy !== EDIT_SELECTION_POLICY) return false;
  if (value.sourceIndexRevision !== null && typeof value.sourceIndexRevision !== 'string') return false;
  const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
  if (![value.editCompilation.rawBytes, value.editCompilation.compiledBytes,
    value.editCompilation.budgetBytes, value.editCompilation.budgetChars,
    value.editCompilation.availableSections, value.editCompilation.includedSections,
    value.editCompilation.omittedSections].every(nonnegative) ||
      value.editCompilation.includedSections + value.editCompilation.omittedSections !== value.editCompilation.availableSections ||
      !['budget', 'invalid_edit', null].includes(value.editCompilation.omissionReason) ||
      !['edit_prompt_budget', null].includes(value.editCompilation.truncationReason) ||
      (value.editCompilation.status === 'truncated') !== (value.editCompilation.truncationReason === 'edit_prompt_budget')) return false;
  if (value.totals.rawBytes !== null && !nonnegative(value.totals.rawBytes)) return false;
  if (![value.totals.availableItems, value.totals.includedItems, value.totals.omittedItems,
    value.totals.includedBytes, value.totals.budgetBytes].every(nonnegative) ||
      value.totals.includedItems + value.totals.omittedItems !== value.totals.availableItems ||
      value.items.length !== value.totals.availableItems) return false;
  const ids = new Set();
  for (const item of value.items) {
    if (!exactKeys(item, ['id', 'kind', 'path', 'revision', 'status', 'rawBytes', 'includedBytes', 'budgetBytes', 'omissionReason', 'truncationReason']) ||
        typeof item.id !== 'string' || ids.has(item.id) || !ITEM_KINDS.has(item.kind) || !ITEM_STATUSES.has(item.status) ||
        (item.path !== null && !validRelativePath(item.path)) ||
        (item.revision !== null && (typeof item.revision !== 'string' || !item.revision)) ||
        (item.rawBytes !== null && !nonnegative(item.rawBytes)) || !nonnegative(item.includedBytes) || !nonnegative(item.budgetBytes) ||
        (item.omissionReason !== null && !OMIT_REASONS.has(item.omissionReason)) ||
        (item.truncationReason !== null && !TRUNCATION_REASONS.has(item.truncationReason)) ||
        (item.status === 'included' && item.omissionReason !== null) ||
        (item.status !== 'included' && item.omissionReason === null)) return false;
    ids.add(item.id);
  }
  return true;
}

module.exports = {
  SCHEMA,
  EDIT_PROMPT_SCHEMA,
  EDIT_PROMPT_BUDGET_CHARS,
  EDIT_PROMPT_BUDGET_BYTES,
  EDIT_SELECTION_POLICY,
  createEditCompilation,
  createEditPromptManifest,
  createContextItem,
  createContextManifest,
  validContextManifest,
};
