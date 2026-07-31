'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const sourceView = fs.readFileSync(path.join(root, 'src', 'renderer', 'sources-view.js'), 'utf8');

console.log('\nSources import and citation UI verification');

test('shows native attachment import beside the three citation styles', () => {
  assert.match(html, /id="source-import"/);
  for (const style of ['apa7', 'mla9', 'chicago17']) assert.match(html, new RegExp(`value="${style}"`));
});

test('calls the instance-bound import bridge without renderer filesystem paths', () => {
  assert.match(sourceView, /await bridge\.importReference\(projectInstanceId\)/);
  assert.doesNotMatch(sourceView, /bridge\.importReference\([^\n]*(?:rootPath|filePath|outputPath)/);
});

test('handles native-dialog cancel and failure without inventing a source', () => {
  assert.match(sourceView, /result\?\.canceled/);
  assert.match(sourceView, /现有文件未被覆盖/);
  assert.match(sourceView, /if \(!result\?\.ok\)/);
});

test('renders the authoritative returned index then refreshes the project tree', () => {
  assert.match(sourceView, /render\(result\.index\)/);
  assert.match(sourceView, /__workspace\?\.refreshTree\?\.\(\)/);
});

test('keeps citation insertion routed through the workspace persistence gate', () => {
  assert.match(sourceView, /insertSourceCitation/);
  assert.match(sourceView, /citationStyle\?\.value/);
});

test('Research requires an explicit question and at most eight selected source IDs', () => {
  assert.match(html, /id="source-research-question"[^>]+maxlength="4000"/);
  assert.match(html, /id="source-research-count"[^>]*>0 \/ 8</);
  assert.match(sourceView, /selectedSourceIds\.length < 8/);
  assert.match(sourceView, /selectedSourceIds\.length >= 8/);
  assert.match(sourceView, /!hasQuestion \|\| selectedSourceIds\.length === 0/);
});

test('Research calls only the origin instance plus narrow question/sourceIds preload method', () => {
  assert.match(sourceView, /await bridge\.research\(projectInstanceId, question, sourceIds\)/);
  assert.doesNotMatch(sourceView, /bridge\.research\([^\n]*(?:sourceIndex|grade|revision|rootPath)/);
});

test('Research renders Claim Source Boundary with A-D grade and exact quote', () => {
  for (const marker of ['CLAIM', 'SOURCE', 'BOUNDARY']) assert(sourceView.includes(marker));
  assert.match(sourceView, /card\.source\.grade/);
  assert.match(sourceView, /card\.source\.gradeReason/);
  assert.match(sourceView, /card\.source\.quote/);
  assert.match(sourceView, /openResearchSource\(resolvedSource\)/);
});

test('Research exposes safely dropped unverifiable quotes instead of silently hiding partial failure', () => {
  assert.match(sourceView, /renderResearchCards\(result\.cards, result\.warnings\)/);
  assert.match(sourceView, /UNVERIFIED_QUOTES_DROPPED/);
  assert.match(sourceView, /warning\.message/);
  assert.match(html, /\.research-state\.is-warning/);
});

test('Research hands only the opaque card capability to dedicated Changes and never writes files', () => {
  assert.match(sourceView, /__changesView\?\.openResearchCard\?\.\(card\.handoff\)/);
  assert.doesNotMatch(sourceView, /openWithInstruction/);
  assert.doesNotMatch(sourceView, /instructionText/);
  assert.doesNotMatch(sourceView, /(?:writeFile|atomicWrite|applyChanges|insertContent)\s*\(/);
});

test('Research discards stale asynchronous cards after project switch', () => {
  assert.match(sourceView, /researchRequestSequence/);
  assert.match(sourceView, /projectInstanceId !== window\.__workspace\?\.state\?\.project\?\.instanceId/);
  assert.match(sourceView, /writcraft:project-entered/);
  assert.match(sourceView, /clearResearchResults\(\)/);
});

test('index refresh and native import are both origin-instance and sequence gated', () => {
  assert.match(sourceView, /bridge\.buildSourceIndex\(projectInstanceId\)/);
  assert.match(sourceView, /indexRequestSequence/);
  assert.match(sourceView, /importRequestSequence/);
  assert.match(sourceView, /projectInstanceId !== window\.__workspace\?\.state\?\.project\?\.instanceId/);
});

test('Research source navigation resolves canonical evidence by card ID only', () => {
  assert.match(sourceView, /bridge\.resolveResearchCard\(projectInstanceId, handoff\.cardId\)/);
  assert.doesNotMatch(sourceView, /validateResearchEvidence/);
  assert.match(sourceView, /sourceOpened/);
  assert.match(sourceView, /matchButton\.disabled = true/);
  assert.match(sourceView, /mismatchButton\.disabled = true/);
  assert.match(sourceView, /不等于独立事实核验/);
});

test('Research requires one persisted author match judgment before Changes', () => {
  assert.match(sourceView, /主张匹配/);
  assert.match(sourceView, /主张不匹配/);
  assert.match(sourceView, /schema: 'writcraft\.research-judgment\/v1'/);
  assert.match(sourceView, /bridge\.recordResearchJudgment\(cardProjectInstanceId/);
  assert.match(sourceView, /cardId: card\.handoff\.cardId/);
  assert.match(sourceView, /result\?\.ok === true && result\?\.recorded === true/);
  assert.match(sourceView, /result\?\.handoffAvailable === true && result\?\.evidenceChanged === false/);
  assert.match(sourceView, /recordedVerdict = verdict/);
  assert.match(sourceView, /toChanges\.disabled = verdict !== 'matched'/);
  assert.match(sourceView, /judgmentInFlight/);
  assert.match(sourceView, /if \(!sourceOpened \|\| recordedVerdict !== 'matched'\) return/);
  assert.doesNotMatch(sourceView, /recordResearchJudgment\([^\n]*(?:claim|quote|path|question|revision)/);
});

test('Research judgment is project and render-sequence gated and labels author judgment honestly', () => {
  assert.match(sourceView, /cardRenderSequence !== researchRequestSequence/);
  assert.match(sourceView, /cardProjectInstanceId !== window\.__workspace\?\.state\?\.project\?\.instanceId/);
  assert.match(sourceView, /作者判断，不是事实核验/);
  assert.match(sourceView, /toChanges\.disabled = true/);
  assert.match(sourceView, /recordedButLocked/);
  assert.match(sourceView, /sourceOpened = false/);
  assert.match(sourceView, /sourceButton\.disabled = true/);
  assert.match(sourceView, /判断已记录但证据随后变化，请重新 Research/);
});

test('a new Research run first cancels any dedicated handoff in Changes', () => {
  assert.match(sourceView, /await window\.__changesView\?\.cancelResearchForRerun\?\.\(\)/);
});

test('Writing Navigation hands Research a strict question-and-evidence preview without auto-running it', () => {
  assert.match(sourceView, /writcraft\.writing-navigation-research\/v1/);
  assert.match(sourceView, /function openWritingNavigation\(value\)/);
  assert.match(sourceView, /window\.__workspace\?\.setSidebarView\?\.\('sources'\)/);
  assert.match(sourceView, /researchQuestion\.value = handoff\.question/);
  assert.match(sourceView, /renderNavigationHandoff\(\)/);
  assert.match(sourceView, /researchRequestSequence \+= 1/);
  assert.match(sourceView, /researching = false/);
  assert.match(sourceView, /只用于保留写作现场/);
  assert.doesNotMatch(sourceView, /function openWritingNavigation[\s\S]{0,900}runResearch\(\)/);
  assert.match(sourceView, /window\.__sourcesView = \{ activate: open, openWritingNavigation \}/);
});

console.log(`\n${passed}/17 sources UI checks passed.`);
