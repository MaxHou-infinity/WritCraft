'use strict';

const assert = require('assert');
const base = require('../src/main/evidence-delivery-schema');
const delivery = require('../src/main/delivery-preflight-schema');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; } catch (error) { console.error(`FAIL ${name}: ${error.code || error.message}`); throw error; }
}
const digest = value => base.digestObject('writcraft.test/v1', { schema: 'writcraft.test/v1', value });
const d = digest('x');
const snapshotId = 'snapshot_stage_b';
const projectInstanceId = 'instance_0123456789abcdef01234567';
const fileRevisionSetDigest = digest('revisions');
const graphIdentity = `graph_${'a'.repeat(32)}`;

function authority() {
  return delivery.buildAuthority({
    projectInstanceId, snapshotId, snapshotManifestDigest: digest('manifest'),
    creationMutationGeneration: 4, fileRevisionSetDigest, graphIdentity,
    graphManifestDigest: digest('graph'), sourceIndexRevision: digest('source'),
  });
}

function evidence(id = 'evidence_1', fileId = 'file_a') {
  return {
    evidenceId: id, fileId, revision: 'a'.repeat(64), blockId: 'block_1', start: 0, end: 4,
    quoteSha256: d, contentSha256: d,
  };
}

function health(reasonCode = 'EXPLICIT_SOURCE_NEEDED_MARKER', subjectId = 'file_a', evidenceItems = [evidence()]) {
  const type = delivery.REASON[reasonCode];
  const evidenceIds = evidenceItems.map(item => item.evidenceId);
  return {
    schema: delivery.SCHEMAS.CITATION_HEALTH_ITEM,
    healthId: delivery.healthId(type, snapshotId, subjectId, evidenceIds, reasonCode),
    type,
    severity: delivery.BLOCKER_REASONS.has(reasonCode) ? 'blocker' : 'warning',
    reasonCode,
    snapshotId,
    subjectId,
    revisionBinding: { fileRevisionSetDigest, subjectRevision: 'a'.repeat(64), locatorDigest: d, quoteSha256: d },
    evidence: evidenceItems,
    nextAction: type === 'broken_footnote' ? 'FIX_FOOTNOTE' : 'ADD_SOURCE',
  };
}

function report(items = []) {
  const value = {
    schema: delivery.SCHEMAS.CITATION_HEALTH_REPORT, snapshotId, fileRevisionSetDigest,
    graphManifestDigest: d, sourceIndexRevision: d, status: items.some(item => item.severity === 'blocker') ? 'stale' : 'complete',
    items, reportDigest: null,
  };
  value.reportDigest = base.digestObject(delivery.SCHEMAS.CITATION_HEALTH_REPORT, value, 'reportDigest');
  return value;
}

function graphBinding() {
  const item = {
    schema: delivery.SCHEMAS.DELIVERY_SOURCE_BINDING,
    graphNodeId: 'claim_1', sourceId: 'source_1', evidenceId: 'evidence_1', bindingId: null, bindingDigest: null,
  };
  item.bindingId = base.digestObject('writcraft.graph-source-binding-id/v1', {
    schema: 'writcraft.graph-source-binding-id/v1', graphIdentity,
    graphNodeId: item.graphNodeId, sourceId: item.sourceId, evidenceId: item.evidenceId,
  });
  item.bindingDigest = base.digestObject(delivery.SCHEMAS.DELIVERY_SOURCE_BINDING, item, 'bindingDigest');
  return {
    schema: delivery.SCHEMAS.DELIVERY_GRAPH_BINDING, snapshotId, fileRevisionSetDigest, graphIdentity,
    graphSchema: 'writcraft.graph/v2', graphInputDigest: d, correctionsDigest: d, issueStateDigest: d,
    evidenceSetDigest: d, sourceBindings: [item],
  };
}

function sourceBinding() {
  return {
    schema: delivery.SCHEMAS.DELIVERY_SOURCE_INDEX_BINDING, snapshotId, fileRevisionSetDigest,
    inputDigest: d, itemDigests: [{ sourceId: 'source_1', itemDigest: d }], partial: false,
  };
}

function issue(issueId, reasonCode, subjectId = 'file_a') {
  return { issueId: digest(issueId), reasonCode, subjectId, evidenceIds: [] };
}

function preflight(items = [], blockers = [], warnings = [], status = 'complete', capability = null) {
  return {
    schema: delivery.SCHEMAS.DELIVERY_PREFLIGHT,
    projectInstanceId, snapshotId, authorityDigest: authority().authorityDigest,
    selectedFiles: [{ fileId: 'file_a', displayPath: 'chapter.md', order: 0 }],
    outline: [{ outlineId: d, fileId: 'file_a', level: 1, text: '标题', ordinal: 0 }],
    health: { status, items }, blockers, warnings, canExport: Boolean(capability), exportCapabilityId: capability,
  };
}

test('authority, graph binding and source index binding are independently recomputable', () => {
  assert.strictEqual(delivery.assertAuthority(authority()).authorityDigest, authority().authorityDigest);
  assert.strictEqual(delivery.assertGraphBinding(graphBinding()).graphIdentity, graphIdentity);
  assert.strictEqual(delivery.assertSourceIndexBinding(sourceBinding()).partial, false);
  assert.throws(() => delivery.assertAuthority({ ...authority(), graphIdentity: 'graph_fake' }), /graphIdentity/);
  const bad = graphBinding(); bad.sourceBindings[0] = { ...bad.sourceBindings[0], sourceId: 'source_2' };
  assert.throws(() => delivery.assertGraphBinding(bad), /bindingId/);
});

test('health item uses exact private contract, evidence authority and stable healthId', () => {
  const item = health('GRAPH_EVIDENCE_QUOTE_STALE', 'claim_1', [evidence()]);
  assert.strictEqual(delivery.assertHealthItem(item), item);
  const healthPayload = {
    schema: delivery.SCHEMAS.CITATION_HEALTH_ID,
    type: item.type, snapshotId, subjectId: item.subjectId,
    evidenceIds: item.evidence.map(entry => entry.evidenceId), reasonCode: item.reasonCode,
  };
  assert.strictEqual(delivery.assertHealthId(healthPayload), item.healthId);
  assert.throws(() => delivery.assertHealthItem({ ...item, healthId: d }), /healthId/);
  const forged = { ...item, evidence: [{ ...item.evidence[0], evidenceId: 'evidence_forged' }] };
  assert.throws(() => delivery.assertHealthItem(forged), /healthId/);
  const accessor = { ...item };
  let reads = 0;
  Object.defineProperty(accessor, 'subjectId', { enumerable: true, get() { reads += 1; return item.subjectId; } });
  assert.throws(() => delivery.assertHealthItem(accessor));
  assert.strictEqual(reads, 0);
});

test('public projection rejects private health fields and enforces blocker/capability gate', () => {
  const warning = health();
  const publicItem = {
    healthId: warning.healthId, type: warning.type, severity: warning.severity, reasonCode: warning.reasonCode,
    subjectLabel: 'chapter.md', evidenceSummaries: [{ fileId: 'file_a', displayPath: 'chapter.md', locatorDigest: d }], nextAction: 'ADD_SOURCE',
  };
  const value = preflight([publicItem], [], [{ issueId: warning.healthId, reasonCode: warning.reasonCode, subjectId: warning.subjectId, evidenceIds: [] }], 'complete', null);
  assert.strictEqual(delivery.assertDeliveryPreflight(value), value);
  assert.throws(() => delivery.assertDeliveryPreflight({ ...value, health: { status: 'complete', items: [{ ...publicItem, revision: 'secret' }] } }), /未知或缺失/);
  const blocker = health('REFERENCE_MISSING_DEFINITION');
  const blockerPublic = { ...publicItem, healthId: blocker.healthId, type: blocker.type, severity: blocker.severity, reasonCode: blocker.reasonCode, nextAction: 'FIX_FOOTNOTE' };
  assert.throws(() => delivery.assertDeliveryPreflight(preflight([blockerPublic], [], [], 'complete', 'cap_1')), /issue summary|blockers/);
  const invalidComplete = { ...report([blocker]), status: 'complete' };
  invalidComplete.reportDigest = base.digestObject(delivery.SCHEMAS.CITATION_HEALTH_REPORT, invalidComplete, 'reportDigest');
  assert.throws(() => delivery.assertHealthReport(invalidComplete), /complete/);
});

test('selection order, manifest nested schemas and digest are bounded', () => {
  const request = { schema: delivery.SCHEMAS.DELIVERY_PREFLIGHT_REQUEST, projectInstanceId, snapshotId, orderedFiles: [{ fileId: 'file_a', pageBreakBefore: false }], warningDecision: 'REVIEW_ONLY' };
  assert.strictEqual(delivery.assertPreflightRequest(request), request);
  assert.throws(() => delivery.assertPreflightRequest({ ...request, orderedFiles: [{ fileId: 'file_a', pageBreakBefore: true }] }), /pageBreak/);
  const manifest = {
    schema: delivery.SCHEMAS.DELIVERY_MANIFEST, authority: authority(),
    selectedFiles: [{ fileId: 'file_a', revision: 'a'.repeat(64), sha256: d, order: 0, pageBreakBefore: false }],
    outline: [], footnotes: [], sources: [], images: [], resources: [],
    syntaxCoverage: { parserId: 'marked', tokenCount: 0, supportedCounts: {}, warningCounts: {}, unsupportedCounts: {} },
    health: report([]), blockers: [], warnings: [], manifestDigest: null,
  };
  manifest.manifestDigest = base.digestObject(delivery.SCHEMAS.DELIVERY_MANIFEST, manifest, 'manifestDigest');
  assert.strictEqual(delivery.assertManifest(manifest), manifest);
  assert.throws(() => delivery.assertManifest({ ...manifest, selectedFiles: [{ ...manifest.selectedFiles[0], order: 1 }] }), /order/);
});

test('public selected files remain public and warning-only REVIEW_ONLY cannot mint capability', () => {
  const warning = health();
  const item = { healthId: warning.healthId, type: warning.type, severity: warning.severity, reasonCode: warning.reasonCode, subjectLabel: 'chapter.md', evidenceSummaries: [{ fileId: 'file_a', displayPath: 'chapter.md', locatorDigest: d }], nextAction: 'ADD_SOURCE' };
  const value = preflight([item], [], [{ issueId: warning.healthId, reasonCode: warning.reasonCode, subjectId: warning.subjectId, evidenceIds: [] }], 'complete', null);
  assert.strictEqual(delivery.assertDeliveryPreflight(value).canExport, false);
  assert.throws(() => delivery.assertDeliveryPreflight({ ...value, selectedFiles: [{ fileId: 'file_a', displayPath: 'chapter.md', order: 1 }] }), /order/);
  assert.throws(() => delivery.assertDeliveryPreflight({ ...value, selectedFiles: [], canExport: true, exportCapabilityId: 'cap_1' }), /正文|selectedFiles/);
  const forged = { ...value, health: { status: 'complete', items: [{ ...item, type: 'missing_source', severity: 'warning', reasonCode: 'GRAPH_EVIDENCE_QUOTE_STALE' }] }, blockers: [], canExport: true, exportCapabilityId: 'cap_1' };
  assert.throws(() => delivery.assertDeliveryPreflight(forged), /type|severity|blocker/);
});

test('public envelope rejects canonical payloads over the frozen 4MiB budget', () => {
  const value = preflight([], [], [], 'complete', null);
  value.outline = Array.from({ length: delivery.MAX_OUTLINE }, (_, index) => ({
    outlineId: d, fileId: 'file_a', level: 1, text: '中'.repeat(341), ordinal: index,
  }));
  assert.throws(() => delivery.assertDeliveryPreflight(value), /4MiB|budget/);
});

console.log(`Stage B delivery preflight schema: ${passed}/6 passed`);
