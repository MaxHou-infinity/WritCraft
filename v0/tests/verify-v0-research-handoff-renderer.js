#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Handoff = require('../src/renderer/research-handoff-transaction');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = path.resolve(__dirname, '..');
const changes = fs.readFileSync(path.join(root, 'src', 'renderer', 'changes-view.js'), 'utf8');
const sources = fs.readFileSync(path.join(root, 'src', 'renderer', 'sources-view.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const cardId = `rc_${'a'.repeat(32)}`;
const handoff = { schema: Handoff.SCHEMA, cardId };

console.log('\nResearch -> Changes Renderer verification');

test('accepts only the exact opaque card handoff', () => {
  assert.deepStrictEqual(Handoff.normalizeCardHandoff(handoff), handoff);
  assert.strictEqual(Handoff.normalizeCardHandoff({ ...handoff, claim: 'forged' }), null);
  assert.strictEqual(Handoff.normalizeCardHandoff({ ...handoff, cardId: 'rc_short' }), null);
});

test('creates an ordered identifier-only request with one to eight targets', () => {
  const request = Handoff.createRequest(handoff, ['chapters/02.md', 'chapters/01.md']);
  assert.deepStrictEqual(request, { schema: Handoff.SCHEMA, cardId, targetPaths: ['chapters/02.md', 'chapters/01.md'] });
  assert.strictEqual(Handoff.createRequest(handoff, []), null);
  assert.strictEqual(Handoff.createRequest(handoff, Array.from({ length: 9 }, (_, index) => `${index}.md`)), null);
  assert.strictEqual(Handoff.createRequest(handoff, ['one.md', 'one.md']), null);
});

test('binding fences project, path, editor session, edit version, dirty state and ordered targets', () => {
  const state = { project: { instanceId: 'project-1' }, currentPath: 'chapters/01.md', openGeneration: 7, editVersion: 9, dirty: false };
  const binding = Handoff.captureBinding(state, ['chapters/01.md', 'chapters/02.md']);
  assert(Handoff.bindingMatches(binding, state, ['chapters/01.md', 'chapters/02.md']));
  for (const drift of [
    { ...state, project: { instanceId: 'project-2' } },
    { ...state, currentPath: 'chapters/02.md' },
    { ...state, openGeneration: 8 },
    { ...state, editVersion: 10 },
    { ...state, dirty: true },
  ]) assert.strictEqual(Handoff.bindingMatches(binding, drift, ['chapters/01.md', 'chapters/02.md']), false);
  assert.strictEqual(Handoff.bindingMatches(binding, state, ['chapters/02.md', 'chapters/01.md']), false);
});

test('accepts only card-matched Research no-op or review responses', () => {
  const request = Handoff.createRequest(handoff, ['chapters/01.md']);
  const provenance = { schema: Handoff.SCHEMA, kind: 'research_card', cardId, targets: [{ path: 'chapters/01.md' }] };
  assert(Handoff.responseMatches({ ok: true, proposalKind: 'research_card', provenance, noChanges: true, fileCount: 0 }, request));
  const review = { changeSetId: 'pc_review', files: [{ path: 'chapters/01.md' }] };
  assert(Handoff.responseMatches({ ok: true, proposalKind: 'research_card', provenance, noChanges: false, changeSetId: 'pc_review', review, fileCount: 1 }, request));
  assert.strictEqual(Handoff.responseMatches({ ok: true, proposalKind: 'normal', provenance, noChanges: true, fileCount: 0 }, request), false);
  assert.strictEqual(Handoff.responseMatches({ ok: true, proposalKind: 'research_card', provenance: { ...provenance, cardId: `rc_${'b'.repeat(32)}` }, noChanges: true, fileCount: 0 }, request), false);
  assert.strictEqual(Handoff.responseMatches({ ok: true, proposalKind: 'research_card', provenance: { ...provenance, targets: [{ path: 'other.md' }] }, noChanges: true, fileCount: 0 }, request), false);
});

test('Sources removes full-evidence and free-instruction handoff paths', () => {
  assert.match(sources, /resolveResearchCard\(projectInstanceId, handoff\.cardId\)/);
  assert.match(sources, /openResearchCard\?\.\(card\.handoff\)/);
  assert.doesNotMatch(sources, /validateResearchEvidence|openWithInstruction|instructionText/);
});

test('dedicated mode locks Claim Source Boundary and free-form controls', () => {
  for (const marker of ['Research 证据卡专用模式', '来源只读', '当前仅生成预览', '自由指令已锁定', 'CLAIM', 'SOURCE', 'BOUNDARY']) {
    assert(changes.includes(marker), marker);
  }
  assert.match(changes, /instruction\.hidden = Boolean\(activeResearchRequest\)/);
  assert.match(html, /research-handoff-transaction\.js/);
});

test('handoff persists then captures and rechecks the complete editor binding', () => {
  assert.match(changes, /await window\.__workspace\.persistCurrent\(true\)/);
  assert.match(changes, /captureBinding\(window\.__workspace\?\.state, request\.targetPaths\)/);
  assert.match(changes, /researchSessionCurrent\(session\)/);
  assert.match(changes, /const openSequence = \+\+researchOpenSequence/);
  assert.match(changes, /openSequence !== researchOpenSequence[\s\S]{0,220}pending \|\| confirmationMode \|\| activeIssueRequest \|\| activeResearchRequest/);
  assert.match(changes, /async function cancelResearchForRerun\(\) \{\s*\/\/[\s\S]{0,180}researchOpenSequence \+= 1;\s*if \(!activeResearchRequest\)/);
  assert.match(changes, /bindingMatches/);
});

test('Renderer sends only project, schema/card ID and ordered target paths to handoff', () => {
  assert.match(changes, /bridge\.handoffResearchCard\(owner\.projectInstanceId, request\)/);
  assert.doesNotMatch(changes, /handoffResearchCard\([^\n]*(?:claim|quote|boundary|revision|rootPath|instruction)/);
});

test('review is transferred before exact card and ChangeSet acknowledgement', () => {
  const renderAt = changes.indexOf('renderChangeSet(result, metric, reviewState)');
  const ackAt = changes.indexOf('bridge.ackResearchReview(owner.projectInstanceId, request.cardId, result.changeSetId)');
  assert(renderAt > 0 && ackAt > renderAt);
  assert.match(changes, /pending\?\.id !== result\.changeSetId/);
});

test('late, canceled and discarded ownership is cleaned up all-settled against the origin', () => {
  assert.match(changes, /Promise\.allSettled\(tasks\)/);
  assert.match(changes, /cancelResearchHandoff\(projectInstanceId, cardId\)/);
  assert.match(changes, /discardChanges\(projectInstanceId, changeSetId\)/);
  assert.match(changes, /discardResearchCard\(projectInstanceId, cardId\)/);
});

test('apply repeats the save and frozen-binding gate', () => {
  assert.match(changes, /pending\?\.proposalKind === 'research_card'[\s\S]{0,500}bindingMatches/);
  assert.match(changes, /当前草稿与 Research 审阅绑定不一致，已阻止应用/);
});

test('project, tree, file, editor input and unload lifecycles release Research ownership', () => {
  for (const marker of ['writcraft:project-entered', 'writcraft:tree-changed', 'writcraft:current-file-changed',
    'writcraft:file-lifecycle-changed', "getElementById('editor')", "addEventListener('unload'"]) assert(changes.includes(marker));
});

test('normal Changes, Graph and Onboarding reject Research exclusivity', () => {
  assert.match(changes, /pending \|\| confirmationMode \|\| activeIssueRequest \|\| activeResearchRequest/);
  assert.match(changes, /当前仍绑定 Research 证据卡/);
  assert.match(changes, /if \(activeResearchRequest\) return proposeResearchCard\(\)/);
});

console.log(`\n${passed}/13 Research Renderer checks passed.`);
