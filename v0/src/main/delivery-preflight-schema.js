'use strict';

const base = require('./evidence-delivery-schema');
const citationIdentity = require('../shared/citation-identity');

const SCHEMAS = Object.freeze({
  DELIVERY_AUTHORITY: 'writcraft.delivery-authority/v1',
  DELIVERY_GRAPH_BINDING: 'writcraft.delivery-graph-binding/v1',
  DELIVERY_SOURCE_BINDING: 'writcraft.graph-source-binding/v1',
  DELIVERY_SOURCE_INDEX_BINDING: 'writcraft.delivery-source-index-binding/v1',
  DELIVERY_SOURCE_ITEM: 'writcraft.delivery-source-item/v1',
  CITATION_HEALTH_ID: 'writcraft.citation-health-id/v1',
  CITATION_HEALTH_ROOT: 'writcraft.citation-health-root/v1',
  CITATION_HEALTH_ITEM: 'writcraft.citation-health-item/v1',
  CITATION_HEALTH_REPORT: 'writcraft.citation-health-report/v1',
  DELIVERY_MANIFEST: 'writcraft.delivery-manifest/v1',
  DELIVERY_PREFLIGHT_REQUEST: 'writcraft.delivery-preflight-request/v1',
  DELIVERY_PREFLIGHT: 'writcraft.delivery-preflight/v1',
  DELIVERY_EXPORT_SELECTION: 'writcraft.delivery-export-selection/v1',
});

const TYPES = Object.freeze([
  'missing_source', 'stale_locator', 'duplicate_source', 'single_evidence', 'broken_footnote',
]);
const SEVERITIES = Object.freeze(['warning', 'blocker']);
const STATUSES = Object.freeze(['complete', 'partial', 'stale']);
const WARNING_DECISIONS = Object.freeze(['REVIEW_ONLY', 'CONTINUE_WITH_WARNINGS']);
const NEXT_ACTIONS = Object.freeze(['ADD_SOURCE', 'REVIEW_LOCATOR', 'MERGE_SOURCE', 'ADD_EVIDENCE', 'FIX_FOOTNOTE']);
const MAX_FILES = 300;
const MAX_HEALTH_ITEMS = 2000;
const MAX_EVIDENCE_SUMMARIES = 32;
const MAX_DISPLAY_BYTES = 1024;
const MAX_EVIDENCE = 100;
const MAX_OUTLINE = 5000;
const MAX_PUBLIC_ENVELOPE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PRIVATE_METADATA_BYTES = 8 * 1024 * 1024;
const GRAPH_ID_RE = /^graph_[a-f0-9]{32}$/u;
const SYNTAX_TOKEN_KEYS = new Set(['space', 'heading', 'paragraph', 'text', 'strong', 'em', 'del', 'codespan', 'br', 'code', 'blockquote', 'list', 'list_item', 'link', 'image', 'table', 'hr', 'checkbox', 'html']);
const SYNTAX_REASON_KEYS = new Set(['UNSUPPORTED_MARKDOWN_SYNTAX', 'IMAGE_ALT_OR_CAPTION_MISSING', 'IMAGE_TOKEN_UNAVAILABLE', 'IMAGE_DECODE_INVALID', 'UNSUPPORTED_DELIVERY_IMAGE_FORMAT']);

const KEYS = Object.freeze({
  AUTHORITY: Object.freeze([
    'schema', 'projectInstanceId', 'snapshotId', 'snapshotManifestDigest',
    'creationMutationGeneration', 'fileRevisionSetDigest', 'graphIdentity',
    'graphManifestDigest', 'sourceIndexRevision', 'authorityDigest',
  ]),
  GRAPH_BINDING: Object.freeze([
    'schema', 'snapshotId', 'fileRevisionSetDigest', 'graphIdentity', 'graphSchema',
    'graphInputDigest', 'correctionsDigest', 'issueStateDigest', 'evidenceSetDigest', 'sourceBindings',
  ]),
  SOURCE_BINDING: Object.freeze(['schema', 'bindingId', 'graphNodeId', 'sourceId', 'evidenceId', 'bindingDigest']),
  SOURCE_INDEX_BINDING: Object.freeze(['schema', 'snapshotId', 'fileRevisionSetDigest', 'inputDigest', 'itemDigests', 'partial']),
  SOURCE_ITEM_DIGEST: Object.freeze(['sourceId', 'itemDigest']),
  SOURCE_ITEM: Object.freeze(['schema', 'sourceId', 'fileId', 'revision', 'contentSha256', 'displayUrl', 'locatorDigest']),
  HEALTH_ID: Object.freeze(['schema', 'type', 'snapshotId', 'subjectId', 'evidenceIds', 'reasonCode']),
  HEALTH_ITEM: Object.freeze([
    'schema', 'healthId', 'type', 'severity', 'reasonCode', 'snapshotId', 'subjectId',
    'revisionBinding', 'evidence', 'nextAction',
  ]),
  HEALTH_REPORT: Object.freeze(['schema', 'snapshotId', 'fileRevisionSetDigest', 'graphManifestDigest', 'sourceIndexRevision', 'status', 'items', 'reportDigest']),
  REVISION_BINDING: Object.freeze(['fileRevisionSetDigest', 'subjectRevision', 'locatorDigest', 'quoteSha256']),
  EVIDENCE: Object.freeze(['evidenceId', 'fileId', 'revision', 'blockId', 'start', 'end', 'quoteSha256', 'contentSha256']),
  SELECTED_FILE: Object.freeze(['fileId', 'revision', 'sha256', 'order', 'pageBreakBefore']),
  REQUEST_FILE: Object.freeze(['fileId', 'pageBreakBefore']),
  PREFLIGHT_REQUEST: Object.freeze(['schema', 'projectInstanceId', 'snapshotId', 'orderedFiles', 'warningDecision']),
  PREFLIGHT: Object.freeze([
    'schema', 'projectInstanceId', 'snapshotId', 'authorityDigest', 'selectedFiles',
    'outline', 'health', 'blockers', 'warnings', 'canExport', 'exportCapabilityId',
  ]),
  PUBLIC_SELECTED_FILE: Object.freeze(['fileId', 'displayPath', 'order']),
  OUTLINE: Object.freeze(['outlineId', 'fileId', 'level', 'text', 'ordinal']),
  FOOTNOTE: Object.freeze(['footnoteId', 'key', 'definitionFileId', 'definitionLocatorDigest', 'referenceLocatorDigests', 'sourceId']),
  SOURCE: Object.freeze(['sourceId', 'sourceIndexRevision', 'displayTitle', 'displayUrl', 'duplicateIdentityUrl', 'contentSha256', 'evidenceIds']),
  IMAGE: Object.freeze(['imageId', 'fileId', 'sha256', 'byteLength', 'mimeType', 'pixelWidth', 'pixelHeight', 'alt', 'caption', 'referenceLocatorDigests']),
  RESOURCE: Object.freeze(['resourceId', 'kind', 'status', 'reasonCode', 'fileId', 'locatorDigest']),
  SYNTAX_COVERAGE: Object.freeze(['parserId', 'tokenCount', 'supportedCounts', 'warningCounts', 'unsupportedCounts']),
  MANIFEST: Object.freeze(['schema', 'authority', 'selectedFiles', 'outline', 'footnotes', 'sources', 'images', 'resources', 'syntaxCoverage', 'health', 'blockers', 'warnings', 'manifestDigest']),
  PUBLIC_HEALTH_REPORT: Object.freeze(['status', 'items']),
  ISSUE_SUMMARY: Object.freeze(['issueId', 'reasonCode', 'subjectId', 'evidenceIds']),
  PUBLIC_HEALTH: Object.freeze(['healthId', 'type', 'severity', 'reasonCode', 'subjectLabel', 'evidenceSummaries', 'nextAction']),
  EVIDENCE_SUMMARY: Object.freeze(['fileId', 'displayPath', 'locatorDigest']),
  EXPORT_SELECTION: Object.freeze(['schema', 'authorityDigest', 'orderedFiles', 'warningDecision', 'deliveryManifestDigest']),
});

const REASON = Object.freeze({
  EXPLICIT_SOURCE_NEEDED_MARKER: 'missing_source',
  CLAIM_WITHOUT_SOURCE_BINDING: 'missing_source',
  GRAPH_EVIDENCE_REVISION_STALE: 'stale_locator',
  GRAPH_EVIDENCE_QUOTE_STALE: 'stale_locator',
  SOURCE_LOCATOR_REVISION_STALE: 'stale_locator',
  SOURCE_LOCATOR_QUOTE_STALE: 'stale_locator',
  SOURCE_ID_UNBOUND: 'stale_locator',
  DUPLICATE_IDENTITY_URL: 'duplicate_source',
  DUPLICATE_CONTENT_DIGEST: 'duplicate_source',
  CLAIM_SINGLE_VALID_EVIDENCE: 'single_evidence',
  REFERENCE_MISSING_DEFINITION: 'broken_footnote',
  DEFINITION_DUPLICATE: 'broken_footnote',
  REFERENCE_AMBIGUOUS: 'broken_footnote',
  DEFINITION_UNUSED: 'broken_footnote',
});
const BLOCKER_REASONS = new Set([
  'GRAPH_EVIDENCE_REVISION_STALE', 'GRAPH_EVIDENCE_QUOTE_STALE',
  'SOURCE_LOCATOR_REVISION_STALE', 'SOURCE_LOCATOR_QUOTE_STALE', 'SOURCE_ID_UNBOUND',
  'REFERENCE_MISSING_DEFINITION', 'DEFINITION_DUPLICATE', 'REFERENCE_AMBIGUOUS',
]);
const PUBLIC_WARNING_REASONS = new Set([
  'IMAGE_ALT_OR_CAPTION_MISSING', 'UNSUPPORTED_DELIVERY_IMAGE_FORMAT', 'UNSUPPORTED_MARKDOWN_SYNTAX',
]);
const PUBLIC_BLOCKER_REASONS = new Set([
  'IMAGE_TOKEN_UNAVAILABLE', 'IMAGE_DECODE_INVALID', 'UNSUPPORTED_DELIVERY_IMAGE_FORMAT',
]);

function fail(code, message) {
  const error = new base.EvidenceDeliverySchemaError(code, message);
  throw error;
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = immutable(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function exact(value, keys, field) {
  try { base.assertExactKeys(value, keys, field); } catch (error) { throw error; }
  return value;
}

function digest(value, field) {
  base.assertDigest(value, field);
  return value;
}

function text(value, field, maxBytes = MAX_DISPLAY_BYTES) {
  base.assertString(value, field, { minBytes: 1, maxBytes, maxScalars: 512 });
  return value;
}

function nullableText(value, field, maxBytes = MAX_DISPLAY_BYTES) {
  if (value !== null) text(value, field, maxBytes);
  return value;
}

function assertAuthority(raw) {
  const value = exact(raw, KEYS.AUTHORITY, 'delivery authority');
  if (value.schema !== SCHEMAS.DELIVERY_AUTHORITY) fail('INVALID_DELIVERY_AUTHORITY', 'delivery authority schema 无效');
  base.assertProjectInstanceId(value.projectInstanceId);
  base.assertOpaqueId(value.snapshotId, 'snapshotId');
  digest(value.snapshotManifestDigest, 'snapshotManifestDigest');
  base.assertSafeInteger(value.creationMutationGeneration, 'creationMutationGeneration');
  digest(value.fileRevisionSetDigest, 'fileRevisionSetDigest');
  if (!GRAPH_ID_RE.test(value.graphIdentity)) fail('INVALID_DELIVERY_AUTHORITY', 'graphIdentity 无效');
  digest(value.graphManifestDigest, 'graphManifestDigest');
  digest(value.sourceIndexRevision, 'sourceIndexRevision');
  digest(value.authorityDigest, 'authorityDigest');
  const expected = base.digestObject(SCHEMAS.DELIVERY_AUTHORITY, value, 'authorityDigest');
  if (expected !== value.authorityDigest) fail('INVALID_DELIVERY_AUTHORITY', 'authorityDigest 无法复现');
  return value;
}

function assertGraphSourceBinding(raw, graphIdentity, index) {
  const field = `sourceBindings[${index}]`;
  const value = exact(raw, KEYS.SOURCE_BINDING, field);
  if (value.schema !== SCHEMAS.DELIVERY_SOURCE_BINDING) fail('INVALID_DELIVERY_GRAPH_BINDING', `${field}.schema 无效`);
  base.assertOpaqueId(value.graphNodeId, `${field}.graphNodeId`);
  base.assertOpaqueId(value.sourceId, `${field}.sourceId`);
  base.assertOpaqueId(value.evidenceId, `${field}.evidenceId`);
  const expectedId = base.digestObject('writcraft.graph-source-binding-id/v1', {
    schema: 'writcraft.graph-source-binding-id/v1', graphIdentity,
    graphNodeId: value.graphNodeId, sourceId: value.sourceId, evidenceId: value.evidenceId,
  });
  if (value.bindingId !== expectedId) fail('INVALID_DELIVERY_GRAPH_BINDING', `${field}.bindingId 无法复现`);
  digest(value.bindingDigest, `${field}.bindingDigest`);
  if (base.digestObject(SCHEMAS.DELIVERY_SOURCE_BINDING, value, 'bindingDigest') !== value.bindingDigest) {
    fail('INVALID_DELIVERY_GRAPH_BINDING', `${field}.bindingDigest 无法复现`);
  }
  return value;
}

function assertGraphBinding(raw) {
  const value = exact(raw, KEYS.GRAPH_BINDING, 'delivery graph binding');
  if (value.schema !== SCHEMAS.DELIVERY_GRAPH_BINDING) fail('INVALID_DELIVERY_GRAPH_BINDING', 'graph binding schema 无效');
  base.assertOpaqueId(value.snapshotId, 'graph binding snapshotId');
  digest(value.fileRevisionSetDigest, 'graph binding fileRevisionSetDigest');
  if (!GRAPH_ID_RE.test(value.graphIdentity)) fail('INVALID_DELIVERY_GRAPH_BINDING', 'graphIdentity 无效');
  if (value.graphSchema !== 'writcraft.graph/v2') fail('INVALID_DELIVERY_GRAPH_BINDING', 'graphSchema 无效');
  digest(value.graphInputDigest, 'graphInputDigest');
  digest(value.correctionsDigest, 'correctionsDigest');
  digest(value.issueStateDigest, 'issueStateDigest');
  digest(value.evidenceSetDigest, 'evidenceSetDigest');
  if (!Array.isArray(value.sourceBindings) || value.sourceBindings.length > MAX_FILES * 10) {
    fail('INVALID_DELIVERY_GRAPH_BINDING', 'sourceBindings 超限');
  }
  let prior = null;
  const identities = new Set();
  value.sourceBindings.forEach((item, index) => {
    assertGraphSourceBinding(item, value.graphIdentity, index);
    const key = `${item.graphNodeId}\0${item.sourceId}\0${item.evidenceId}`;
    if (identities.has(key) || (prior !== null && prior > key)) fail('INVALID_DELIVERY_GRAPH_BINDING', 'sourceBindings 未排序或重复');
    identities.add(key);
    prior = key;
  });
  return value;
}

function assertSourceItem(raw, field = 'source item') {
  const value = exact(raw, KEYS.SOURCE_ITEM, field);
  if (value.schema !== SCHEMAS.DELIVERY_SOURCE_ITEM) fail('INVALID_DELIVERY_SOURCE_BINDING', `${field}.schema 无效`);
  base.assertOpaqueId(value.sourceId, `${field}.sourceId`);
  base.assertOpaqueId(value.fileId, `${field}.fileId`);
  base.assertString(value.revision, `${field}.revision`, { ascii: true, pattern: /^[a-f0-9]{64}$/u });
  digest(value.contentSha256, `${field}.contentSha256`);
  if (value.displayUrl !== null) {
    text(value.displayUrl, `${field}.displayUrl`, 4096);
    if (!citationIdentity.safeHttpUrl(value.displayUrl)) fail('INVALID_DELIVERY_SOURCE_BINDING', `${field}.displayUrl 无效`);
  }
  digest(value.locatorDigest, `${field}.locatorDigest`);
  return value;
}

function assertSourceIndexBinding(raw) {
  const value = exact(raw, KEYS.SOURCE_INDEX_BINDING, 'delivery source index binding');
  if (value.schema !== SCHEMAS.DELIVERY_SOURCE_INDEX_BINDING) fail('INVALID_DELIVERY_SOURCE_BINDING', 'source index schema 无效');
  base.assertOpaqueId(value.snapshotId, 'source index snapshotId');
  digest(value.fileRevisionSetDigest, 'source index fileRevisionSetDigest');
  digest(value.inputDigest, 'source index inputDigest');
  if (typeof value.partial !== 'boolean') fail('INVALID_DELIVERY_SOURCE_BINDING', 'source index partial 无效');
  if (!Array.isArray(value.itemDigests) || value.itemDigests.length > MAX_FILES) fail('INVALID_DELIVERY_SOURCE_BINDING', 'source index itemDigests 超限');
  let prior = null;
  const ids = new Set();
  value.itemDigests.forEach((item, index) => {
    exact(item, KEYS.SOURCE_ITEM_DIGEST, `itemDigests[${index}]`);
    base.assertOpaqueId(item.sourceId, `itemDigests[${index}].sourceId`);
    digest(item.itemDigest, `itemDigests[${index}].itemDigest`);
    if (ids.has(item.sourceId) || (prior !== null && prior >= item.sourceId)) fail('INVALID_DELIVERY_SOURCE_BINDING', 'source itemDigests 未排序或重复');
    ids.add(item.sourceId);
    prior = item.sourceId;
  });
  return value;
}

function assertSelectedFiles(raw, field = 'orderedFiles') {
  if (!Array.isArray(raw) || raw.length > MAX_FILES) fail('INVALID_DELIVERY_SELECTION', `${field} 超限`);
  const ids = new Set();
  raw.forEach((item, index) => {
    exact(item, KEYS.REQUEST_FILE, `${field}[${index}]`);
    base.assertOpaqueId(item.fileId, `${field}[${index}].fileId`);
    if (ids.has(item.fileId)) fail('INVALID_DELIVERY_SELECTION', `${field} 存在重复 fileId`);
    ids.add(item.fileId);
    if (typeof item.pageBreakBefore !== 'boolean' || (index === 0 && item.pageBreakBefore !== false)) {
      fail('INVALID_DELIVERY_SELECTION', `${field}[${index}].pageBreakBefore 无效`);
    }
  });
  return raw;
}

function assertPreflightRequest(raw) {
  const value = exact(raw, KEYS.PREFLIGHT_REQUEST, 'delivery preflight request');
  if (value.schema !== SCHEMAS.DELIVERY_PREFLIGHT_REQUEST) fail('INVALID_DELIVERY_REQUEST', 'preflight request schema 无效');
  base.assertProjectInstanceId(value.projectInstanceId);
  base.assertOpaqueId(value.snapshotId, 'snapshotId');
  assertSelectedFiles(value.orderedFiles);
  if (!WARNING_DECISIONS.includes(value.warningDecision)) fail('INVALID_DELIVERY_REQUEST', 'warningDecision 无效');
  return value;
}

function assertHealthId(raw, expectedHealthId = null) {
  const value = exact(raw, KEYS.HEALTH_ID, 'citation health id');
  if (value.schema !== SCHEMAS.CITATION_HEALTH_ID) fail('INVALID_CITATION_HEALTH', 'health id schema 无效');
  if (!TYPES.includes(value.type)) fail('INVALID_CITATION_HEALTH', 'health type 无效');
  base.assertOpaqueId(value.snapshotId, 'health snapshotId');
  nullableText(value.subjectId, 'health subjectId', 128);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length > MAX_EVIDENCE_SUMMARIES) fail('INVALID_CITATION_HEALTH', 'evidenceIds 无效');
  value.evidenceIds.forEach((id, index) => base.assertOpaqueId(id, `evidenceIds[${index}]`));
  text(value.reasonCode, 'reasonCode', 96);
  const calculated = healthId(value.type, value.snapshotId, value.subjectId, value.evidenceIds, value.reasonCode);
  if (expectedHealthId !== null && calculated !== expectedHealthId) fail('INVALID_CITATION_HEALTH', 'healthId 无法复现');
  return calculated;
}

function assertRevisionBinding(raw, field = 'revisionBinding') {
  const value = exact(raw, KEYS.REVISION_BINDING, field);
  digest(value.fileRevisionSetDigest, `${field}.fileRevisionSetDigest`);
  if (value.subjectRevision !== null) base.assertString(value.subjectRevision, `${field}.subjectRevision`, { ascii: true, pattern: /^[a-f0-9]{64}$/u });
  if (value.locatorDigest !== null) digest(value.locatorDigest, `${field}.locatorDigest`);
  if (value.quoteSha256 !== null) digest(value.quoteSha256, `${field}.quoteSha256`);
  return value;
}

function assertEvidence(raw, index) {
  const value = exact(raw, KEYS.EVIDENCE, `evidence[${index}]`);
  base.assertOpaqueId(value.evidenceId, `evidence[${index}].evidenceId`);
  base.assertOpaqueId(value.fileId, `evidence[${index}].fileId`);
  base.assertString(value.revision, `evidence[${index}].revision`, { ascii: true, pattern: /^[a-f0-9]{64}$/u });
  base.assertOpaqueId(value.blockId, `evidence[${index}].blockId`);
  base.assertSafeInteger(value.start, `evidence[${index}].start`, 0);
  base.assertSafeInteger(value.end, `evidence[${index}].end`, 1);
  if (value.start >= value.end) fail('INVALID_CITATION_HEALTH', 'evidence locator 范围无效');
  digest(value.quoteSha256, `evidence[${index}].quoteSha256`);
  digest(value.contentSha256, `evidence[${index}].contentSha256`);
  return value;
}

function assertHealthItem(raw) {
  const value = exact(raw, KEYS.HEALTH_ITEM, 'citation health item');
  if (value.schema !== SCHEMAS.CITATION_HEALTH_ITEM) fail('INVALID_CITATION_HEALTH', 'health item schema 无效');
  digest(value.healthId, 'healthId');
  if (!TYPES.includes(value.type) || !SEVERITIES.includes(value.severity)) fail('INVALID_CITATION_HEALTH', 'health type/severity 无效');
  text(value.reasonCode, 'reasonCode', 96);
  if (REASON[value.reasonCode] !== value.type) fail('INVALID_CITATION_HEALTH', 'reasonCode 与 type 不一致');
  base.assertOpaqueId(value.snapshotId, 'snapshotId');
  if (value.subjectId !== null) base.assertOpaqueId(value.subjectId, 'subjectId');
  assertRevisionBinding(value.revisionBinding);
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > MAX_EVIDENCE) fail('INVALID_CITATION_HEALTH', 'health evidence 必须包含至少一个 locator');
  value.evidence.forEach(assertEvidence);
  const evidenceIds = value.evidence.map(item => item.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) fail('INVALID_CITATION_HEALTH', 'health evidence 重复');
  if (!NEXT_ACTIONS.includes(value.nextAction)) fail('INVALID_CITATION_HEALTH', 'nextAction 无效');
  if (value.severity !== (BLOCKER_REASONS.has(value.reasonCode) ? 'blocker' : 'warning')) {
    fail('INVALID_CITATION_HEALTH', 'reasonCode 与 severity 不一致');
  }
  if (healthId(value.type, value.snapshotId, value.subjectId, evidenceIds, value.reasonCode) !== value.healthId) fail('INVALID_CITATION_HEALTH', 'healthId 无法复现');
  return value;
}

function assertHealthReport(raw) {
  const value = exact(raw, KEYS.HEALTH_REPORT, 'citation health report');
  if (value.schema !== SCHEMAS.CITATION_HEALTH_REPORT) fail('INVALID_CITATION_HEALTH', 'health report schema 无效');
  base.assertOpaqueId(value.snapshotId, 'snapshotId');
  digest(value.fileRevisionSetDigest, 'fileRevisionSetDigest');
  digest(value.graphManifestDigest, 'graphManifestDigest');
  digest(value.sourceIndexRevision, 'sourceIndexRevision');
  if (!STATUSES.includes(value.status)) fail('INVALID_CITATION_HEALTH', 'health report status 无效');
  if (!Array.isArray(value.items) || value.items.length > MAX_HEALTH_ITEMS) fail('INVALID_CITATION_HEALTH', 'health report items 超限');
  const healthIds = new Set();
  value.items.forEach((item, index) => {
    assertHealthItem(item);
    if (item.snapshotId !== value.snapshotId) fail('INVALID_CITATION_HEALTH', `items[${index}] snapshotId 未绑定报告`);
    if (healthIds.has(item.healthId)) fail('INVALID_CITATION_HEALTH', 'health report 存在重复项');
    healthIds.add(item.healthId);
  });
  if (value.status === 'complete' && value.items.some(item => item.severity === 'blocker')) fail('INVALID_CITATION_HEALTH', 'complete report 不得包含 blocker');
  digest(value.reportDigest, 'reportDigest');
  if (base.digestObject(SCHEMAS.CITATION_HEALTH_REPORT, value, 'reportDigest') !== value.reportDigest) fail('INVALID_CITATION_HEALTH', 'health report digest 无法复现');
  if (base.canonicalJsonByteLength(value) > MAX_PRIVATE_METADATA_BYTES) fail('INVALID_CITATION_HEALTH', 'health report 超出私有 metadata 预算');
  return value;
}

function assertManifestSelectedFiles(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_FILES) fail('INVALID_DELIVERY_MANIFEST', 'manifest selectedFiles 超限');
  const ids = new Set();
  raw.forEach((item, index) => {
    exact(item, KEYS.SELECTED_FILE, `manifest.selectedFiles[${index}]`);
    base.assertOpaqueId(item.fileId, `manifest.selectedFiles[${index}].fileId`);
    base.assertString(item.revision, `manifest.selectedFiles[${index}].revision`, { ascii: true, pattern: /^[a-f0-9]{64}$/u });
    digest(item.sha256, `manifest.selectedFiles[${index}].sha256`);
    base.assertSafeInteger(item.order, `manifest.selectedFiles[${index}].order`, index, index);
    if (typeof item.pageBreakBefore !== 'boolean' || (index === 0 && item.pageBreakBefore !== false)) {
      fail('INVALID_DELIVERY_MANIFEST', 'manifest.selectedFiles pageBreakBefore 无效');
    }
    if (ids.has(item.fileId)) fail('INVALID_DELIVERY_MANIFEST', 'manifest.selectedFiles 重复');
    ids.add(item.fileId);
  });
  return raw;
}

function assertOutline(raw, field = 'outline') {
  if (!Array.isArray(raw) || raw.length > MAX_OUTLINE) fail('INVALID_DELIVERY_MANIFEST', `${field} 超限`);
  raw.forEach((item, index) => {
    exact(item, KEYS.OUTLINE, `${field}[${index}]`);
    digest(item.outlineId, `${field}[${index}].outlineId`);
    base.assertOpaqueId(item.fileId, `${field}[${index}].fileId`);
    base.assertSafeInteger(item.level, `${field}[${index}].level`, 1, 6);
    text(item.text, `${field}[${index}].text`);
    base.assertSafeInteger(item.ordinal, `${field}[${index}].ordinal`, index, index);
  });
  return raw;
}

function assertFootnotes(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_FILES * 100) fail('INVALID_DELIVERY_MANIFEST', 'footnotes 超限');
  raw.forEach((item, index) => {
    exact(item, KEYS.FOOTNOTE, `footnotes[${index}]`);
    digest(item.footnoteId, `footnotes[${index}].footnoteId`);
    text(item.key, `footnotes[${index}].key`, 128);
    base.assertOpaqueId(item.definitionFileId, `footnotes[${index}].definitionFileId`);
    digest(item.definitionLocatorDigest, `footnotes[${index}].definitionLocatorDigest`);
    if (!Array.isArray(item.referenceLocatorDigests) || item.referenceLocatorDigests.length < 1 || item.referenceLocatorDigests.length > 100) {
      fail('INVALID_DELIVERY_MANIFEST', 'footnote referenceLocatorDigests 无效');
    }
    item.referenceLocatorDigests.forEach((value, refIndex) => digest(value, `footnotes[${index}].referenceLocatorDigests[${refIndex}]`));
    if (item.sourceId !== null) base.assertOpaqueId(item.sourceId, `footnotes[${index}].sourceId`);
  });
  return raw;
}

function assertSources(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_FILES) fail('INVALID_DELIVERY_MANIFEST', 'sources 超限');
  const ids = new Set();
  raw.forEach((item, index) => {
    exact(item, KEYS.SOURCE, `sources[${index}]`);
    base.assertOpaqueId(item.sourceId, `sources[${index}].sourceId`);
    digest(item.sourceIndexRevision, `sources[${index}].sourceIndexRevision`);
    text(item.displayTitle, `sources[${index}].displayTitle`, 1024);
    if (item.displayUrl !== null) {
      text(item.displayUrl, `sources[${index}].displayUrl`, 4096);
      if (!citationIdentity.safeHttpUrl(item.displayUrl)) fail('INVALID_DELIVERY_MANIFEST', 'source displayUrl 必须是安全 HTTP(S) URL');
    }
    if (item.duplicateIdentityUrl !== null) {
      text(item.duplicateIdentityUrl, `sources[${index}].duplicateIdentityUrl`, 4096);
      if (item.duplicateIdentityUrl !== citationIdentity.duplicateIdentityUrl(item.displayUrl)) fail('INVALID_DELIVERY_MANIFEST', 'source duplicateIdentityUrl 无法复现');
    }
    digest(item.contentSha256, `sources[${index}].contentSha256`);
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length > MAX_EVIDENCE) fail('INVALID_DELIVERY_MANIFEST', 'source evidenceIds 无效');
    item.evidenceIds.forEach((id, idIndex) => base.assertOpaqueId(id, `sources[${index}].evidenceIds[${idIndex}]`));
    if (ids.has(item.sourceId)) fail('INVALID_DELIVERY_MANIFEST', 'sources 重复');
    ids.add(item.sourceId);
  });
  return raw;
}

function assertImages(raw) {
  if (!Array.isArray(raw) || raw.length > 200) fail('INVALID_DELIVERY_MANIFEST', 'images 超限');
  raw.forEach((item, index) => {
    exact(item, KEYS.IMAGE, `images[${index}]`);
    digest(item.imageId, `images[${index}].imageId`);
    base.assertOpaqueId(item.fileId, `images[${index}].fileId`);
    digest(item.sha256, `images[${index}].sha256`);
    base.assertSafeInteger(item.byteLength, `images[${index}].byteLength`);
    text(item.mimeType, `images[${index}].mimeType`, 128);
    base.assertSafeInteger(item.pixelWidth, `images[${index}].pixelWidth`);
    base.assertSafeInteger(item.pixelHeight, `images[${index}].pixelHeight`);
    nullableText(item.alt, `images[${index}].alt`);
    nullableText(item.caption, `images[${index}].caption`);
    if (!Array.isArray(item.referenceLocatorDigests) || item.referenceLocatorDigests.length > 2000) fail('INVALID_DELIVERY_MANIFEST', 'image references 无效');
    item.referenceLocatorDigests.forEach((value, refIndex) => digest(value, `images[${index}].referenceLocatorDigests[${refIndex}]`));
  });
  return raw;
}

function assertResources(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_FILES * 10) fail('INVALID_DELIVERY_MANIFEST', 'resources 超限');
  raw.forEach((item, index) => {
    exact(item, KEYS.RESOURCE, `resources[${index}]`);
    digest(item.resourceId, `resources[${index}].resourceId`);
    text(item.kind, `resources[${index}].kind`, 96);
    if (!['warning', 'blocker'].includes(item.status)) fail('INVALID_DELIVERY_MANIFEST', `resources[${index}].status 无效`);
    text(item.reasonCode, `resources[${index}].reasonCode`, 96);
    const allowedReasons = item.status === 'blocker' ? PUBLIC_BLOCKER_REASONS : PUBLIC_WARNING_REASONS;
    if (!allowedReasons.has(item.reasonCode)) fail('INVALID_DELIVERY_MANIFEST', `resources[${index}] reason/status 不一致`);
    if (item.fileId !== null) base.assertOpaqueId(item.fileId, `resources[${index}].fileId`);
    if (item.locatorDigest !== null) digest(item.locatorDigest, `resources[${index}].locatorDigest`);
  });
  return raw;
}

function assertCountMap(raw, field, allowedKeys = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_DELIVERY_MANIFEST', `${field} 必须是 map`);
  base.assertPlainRecord(raw, field);
  for (const [key, value] of Object.entries(raw)) {
    text(key, `${field} key`, 96);
    if (allowedKeys && !allowedKeys.has(key)) fail('INVALID_DELIVERY_MANIFEST', `${field} key 不在冻结枚举`);
    base.assertSafeInteger(value, `${field}.${key}`);
  }
  return raw;
}

function assertSyntaxCoverage(raw) {
  exact(raw, KEYS.SYNTAX_COVERAGE, 'syntaxCoverage');
  text(raw.parserId, 'syntaxCoverage.parserId', 256);
  base.assertSafeInteger(raw.tokenCount, 'syntaxCoverage.tokenCount');
  assertCountMap(raw.supportedCounts, 'syntaxCoverage.supportedCounts', SYNTAX_TOKEN_KEYS);
  assertCountMap(raw.warningCounts, 'syntaxCoverage.warningCounts', new Set([...SYNTAX_TOKEN_KEYS, ...SYNTAX_REASON_KEYS]));
  assertCountMap(raw.unsupportedCounts, 'syntaxCoverage.unsupportedCounts', new Set([...SYNTAX_TOKEN_KEYS, ...SYNTAX_REASON_KEYS]));
  return raw;
}

function assertIssueSummary(raw, field, index) {
  const value = exact(raw, KEYS.ISSUE_SUMMARY, `${field}[${index}]`);
  digest(value.issueId, `${field}[${index}].issueId`);
  text(value.reasonCode, `${field}[${index}].reasonCode`, 96);
  if (value.subjectId !== null) base.assertOpaqueId(value.subjectId, `${field}[${index}].subjectId`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length > MAX_EVIDENCE) fail('INVALID_DELIVERY_MANIFEST', `${field} evidenceIds 无效`);
  value.evidenceIds.forEach((id, idIndex) => base.assertOpaqueId(id, `${field}[${index}].evidenceIds[${idIndex}]`));
  return value;
}

function assertManifest(raw) {
  const value = exact(raw, KEYS.MANIFEST, 'delivery manifest');
  if (value.schema !== SCHEMAS.DELIVERY_MANIFEST) fail('INVALID_DELIVERY_MANIFEST', 'manifest schema 无效');
  assertAuthority(value.authority);
  assertManifestSelectedFiles(value.selectedFiles);
  assertOutline(value.outline);
  assertFootnotes(value.footnotes);
  assertSources(value.sources);
  assertImages(value.images);
  assertResources(value.resources);
  assertSyntaxCoverage(value.syntaxCoverage);
  assertHealthReport(value.health);
  if (!Array.isArray(value.blockers) || value.blockers.length > 1000) fail('INVALID_DELIVERY_MANIFEST', 'manifest blockers 无效');
  if (!Array.isArray(value.warnings) || value.warnings.length > 1000) fail('INVALID_DELIVERY_MANIFEST', 'manifest warnings 无效');
  const issueIds = new Set();
  for (const [field, items] of [['blockers', value.blockers], ['warnings', value.warnings]]) {
    items.forEach((item, index) => {
      assertIssueSummary(item, field, index);
      if (issueIds.has(item.issueId)) fail('INVALID_DELIVERY_MANIFEST', 'blockers/warnings 存在重复 issue');
      issueIds.add(item.issueId);
    });
  }
  for (const healthItem of value.health.items) {
    if (!issueIds.has(healthItem.healthId)) fail('INVALID_DELIVERY_MANIFEST', 'manifest 缺少 health issue summary');
  }
  for (const resource of value.resources) {
    const summaries = value[resource.status === 'blocker' ? 'blockers' : 'warnings'];
    if (!summaries.some(item => item.issueId === resource.resourceId && item.reasonCode === resource.reasonCode)) {
      fail('INVALID_DELIVERY_MANIFEST', 'resource status 未绑定 issue summary');
    }
  }
  digest(value.manifestDigest, 'manifestDigest');
  if (base.digestObject(SCHEMAS.DELIVERY_MANIFEST, value, 'manifestDigest') !== value.manifestDigest) fail('INVALID_DELIVERY_MANIFEST', 'manifestDigest 无法复现');
  if (base.canonicalJsonByteLength(value) > MAX_MANIFEST_BYTES) fail('INVALID_DELIVERY_MANIFEST', 'manifest 超出 4MiB budget');
  return value;
}

function assertDeliveryPreflight(raw) {
  const value = exact(raw, KEYS.PREFLIGHT, 'delivery preflight');
  if (value.schema !== SCHEMAS.DELIVERY_PREFLIGHT) fail('INVALID_DELIVERY_PREFLIGHT', 'preflight schema 无效');
  base.assertProjectInstanceId(value.projectInstanceId);
  base.assertOpaqueId(value.snapshotId, 'snapshotId');
  digest(value.authorityDigest, 'authorityDigest');
  if (!Array.isArray(value.selectedFiles) || value.selectedFiles.length > MAX_FILES) fail('INVALID_DELIVERY_PREFLIGHT', 'selectedFiles 超限');
  const selectedIds = new Set();
  value.selectedFiles.forEach((item, index) => {
    exact(item, KEYS.PUBLIC_SELECTED_FILE, `selectedFiles[${index}]`);
    base.assertOpaqueId(item.fileId, `selectedFiles[${index}].fileId`);
    text(item.displayPath, `selectedFiles[${index}].displayPath`, 1024);
    base.assertSafeInteger(item.order, `selectedFiles[${index}].order`, index, index);
    if (selectedIds.has(item.fileId)) fail('INVALID_DELIVERY_PREFLIGHT', 'selectedFiles 重复');
    selectedIds.add(item.fileId);
  });
  if (!Array.isArray(value.outline) || value.outline.length > MAX_OUTLINE) fail('INVALID_DELIVERY_PREFLIGHT', 'outline 无效');
  value.outline.forEach((item, index) => {
    exact(item, KEYS.OUTLINE, `outline[${index}]`);
    digest(item.outlineId, `outline[${index}].outlineId`);
    base.assertOpaqueId(item.fileId, `outline[${index}].fileId`);
    base.assertSafeInteger(item.level, `outline[${index}].level`, 1, 6);
    text(item.text, `outline[${index}].text`);
    base.assertSafeInteger(item.ordinal, `outline[${index}].ordinal`);
  });
  exact(value.health, KEYS.PUBLIC_HEALTH_REPORT, 'health');
  if (!STATUSES.includes(value.health.status) || !Array.isArray(value.health.items) || value.health.items.length > MAX_HEALTH_ITEMS) fail('INVALID_DELIVERY_PREFLIGHT', 'health public report 无效');
  const publicHealthIds = new Set();
  value.health.items.forEach((item, index) => {
    exact(item, KEYS.PUBLIC_HEALTH, `health.items[${index}]`);
    digest(item.healthId, `health.items[${index}].healthId`);
    if (!TYPES.includes(item.type) || !SEVERITIES.includes(item.severity) || !REASON[item.reasonCode] || REASON[item.reasonCode] !== item.type) fail('INVALID_DELIVERY_PREFLIGHT', 'health public item type/reasonCode 无效');
    if (item.severity !== (BLOCKER_REASONS.has(item.reasonCode) ? 'blocker' : 'warning')) fail('INVALID_DELIVERY_PREFLIGHT', 'health public item severity 无效');
    if (publicHealthIds.has(item.healthId)) fail('INVALID_DELIVERY_PREFLIGHT', 'health public item 重复');
    publicHealthIds.add(item.healthId);
    text(item.subjectLabel, `health.items[${index}].subjectLabel`);
    if (!Array.isArray(item.evidenceSummaries) || item.evidenceSummaries.length < 1 || item.evidenceSummaries.length > MAX_EVIDENCE_SUMMARIES) fail('INVALID_DELIVERY_PREFLIGHT', 'health evidence summaries 必须包含 locator');
    item.evidenceSummaries.forEach((summary, summaryIndex) => {
      exact(summary, KEYS.EVIDENCE_SUMMARY, `health.items[${index}].evidenceSummaries[${summaryIndex}]`);
      base.assertOpaqueId(summary.fileId, 'public evidence fileId');
      text(summary.displayPath, 'public evidence displayPath', 1024);
      digest(summary.locatorDigest, 'public evidence locatorDigest');
    });
    if (!NEXT_ACTIONS.includes(item.nextAction)) fail('INVALID_DELIVERY_PREFLIGHT', 'health nextAction 无效');
  });
  if (!Array.isArray(value.blockers) || value.blockers.length > 1000 || !Array.isArray(value.warnings) || value.warnings.length > 1000) {
    fail('INVALID_DELIVERY_PREFLIGHT', 'blockers/warnings 无效');
  }
  const issueIds = new Set();
  const assertIssue = (item, field, index, isBlocker) => {
    assertIssueSummary(item, field, index);
    if (issueIds.has(item.issueId)) fail('INVALID_DELIVERY_PREFLIGHT', 'blockers/warnings 存在重复 issue');
    issueIds.add(item.issueId);
    if (isBlocker !== (BLOCKER_REASONS.has(item.reasonCode) || PUBLIC_BLOCKER_REASONS.has(item.reasonCode))) fail('INVALID_DELIVERY_PREFLIGHT', `${field} severity 与 reasonCode 不一致`);
  };
  value.blockers.forEach((item, index) => assertIssue(item, 'blockers', index, true));
  value.warnings.forEach((item, index) => assertIssue(item, 'warnings', index, false));
  const summaryIds = new Set([...value.blockers, ...value.warnings].map(item => item.issueId));
  for (const healthId of publicHealthIds) if (!summaryIds.has(healthId)) fail('INVALID_DELIVERY_PREFLIGHT', 'health item 缺少 issue summary');
  for (const item of [...value.blockers, ...value.warnings]) {
    if (!publicHealthIds.has(item.issueId) && !PUBLIC_WARNING_REASONS.has(item.reasonCode) && !PUBLIC_BLOCKER_REASONS.has(item.reasonCode)) {
      fail('INVALID_DELIVERY_PREFLIGHT', 'issue summary 未绑定 health item');
    }
  }
  if (typeof value.canExport !== 'boolean') fail('INVALID_DELIVERY_PREFLIGHT', 'canExport 无效');
  const publicHasHealthBlocker = value.health.items.some(item => item.severity === 'blocker');
  const publicHasBlockerSummary = value.blockers.some(item => BLOCKER_REASONS.has(item.reasonCode) || PUBLIC_BLOCKER_REASONS.has(item.reasonCode));
  if (publicHasHealthBlocker && !publicHasBlockerSummary) fail('INVALID_DELIVERY_PREFLIGHT', 'blockers 与 health 不一致');
  if (value.canExport && (value.blockers.length > 0 || value.health.status !== 'complete')) fail('INVALID_DELIVERY_PREFLIGHT', 'canExport 与 blockers/status 不一致');
  if (value.canExport && value.selectedFiles.length === 0) fail('INVALID_DELIVERY_PREFLIGHT', '未选择正文不得导出');
  if (value.exportCapabilityId !== null) base.assertOpaqueId(value.exportCapabilityId, 'exportCapabilityId');
  if (value.canExport && value.exportCapabilityId === null) fail('INVALID_DELIVERY_PREFLIGHT', 'canExport 必须绑定 capability');
  if ((!value.canExport || value.health.status !== 'complete' || value.blockers.length > 0) && value.exportCapabilityId !== null) fail('INVALID_DELIVERY_PREFLIGHT', '阻断或 stale/partial 不得有 capability');
  if (base.canonicalJsonByteLength(value) > MAX_PUBLIC_ENVELOPE_BYTES) fail('INVALID_DELIVERY_PREFLIGHT', 'public preflight 超出 4MiB budget');
  return value;
}

function assertExportSelection(raw) {
  const value = exact(raw, KEYS.EXPORT_SELECTION, 'delivery export selection');
  if (value.schema !== SCHEMAS.DELIVERY_EXPORT_SELECTION) fail('INVALID_DELIVERY_SELECTION', 'export selection schema 无效');
  digest(value.authorityDigest, 'authorityDigest');
  assertSelectedFiles(value.orderedFiles);
  if (!WARNING_DECISIONS.includes(value.warningDecision)) fail('INVALID_DELIVERY_SELECTION', 'warningDecision 无效');
  digest(value.deliveryManifestDigest, 'deliveryManifestDigest');
  return value;
}

function buildAuthority(input) {
  const value = { schema: SCHEMAS.DELIVERY_AUTHORITY, ...input };
  value.authorityDigest = base.digestObject(SCHEMAS.DELIVERY_AUTHORITY, { ...value, authorityDigest: null }, 'authorityDigest');
  return immutable(value);
}

function healthId(type, snapshotId, subjectId, evidenceIds, reasonCode) {
  const payload = { schema: SCHEMAS.CITATION_HEALTH_ID, type, snapshotId, subjectId: subjectId || null, evidenceIds: [...evidenceIds].sort(), reasonCode };
  return base.digestObject(SCHEMAS.CITATION_HEALTH_ID, payload);
}

module.exports = Object.freeze({
  SCHEMAS, KEYS, TYPES, SEVERITIES, STATUSES, WARNING_DECISIONS, NEXT_ACTIONS, REASON, BLOCKER_REASONS,
  MAX_FILES, MAX_HEALTH_ITEMS, MAX_EVIDENCE_SUMMARIES,
  MAX_EVIDENCE, MAX_OUTLINE, MAX_PUBLIC_ENVELOPE_BYTES, MAX_MANIFEST_BYTES, MAX_PRIVATE_METADATA_BYTES,
  GRAPH_ID_RE, PUBLIC_WARNING_REASONS, PUBLIC_BLOCKER_REASONS,
  assertAuthority, assertGraphBinding, assertGraphSourceBinding, assertSourceItem, assertSourceIndexBinding,
  assertSelectedFiles, assertPreflightRequest, assertHealthId, assertRevisionBinding, assertEvidence, assertHealthItem,
  assertHealthReport, assertManifest, assertDeliveryPreflight, assertExportSelection, buildAuthority, healthId,
});
