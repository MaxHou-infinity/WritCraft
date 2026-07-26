#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');

const root = path.join(__dirname, '..');
const editor = fs.readFileSync(path.join(root, 'src/renderer/editor.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
let passed = 0;

function test(label, assertion) {
  assertion();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

function extractFunction(name) {
  const start = editor.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  const brace = editor.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < editor.length; index += 1) {
    if (editor[index] === '{') depth += 1;
    if (editor[index] === '}') depth -= 1;
    if (depth === 0) return editor.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

console.log('Inline Rewrite Renderer UI verification');

test('transaction helper loads before editor', () => {
  const transactionIndex = html.indexOf('src="inline-rewrite-transaction.js"');
  const editorIndex = html.indexOf('src="editor.js"');
  assert.ok(transactionIndex >= 0 && transactionIndex < editorIndex);
});

test('synchronous UTF-8 SHA-256 matches Node authority', () => {
  const source = extractFunction('sha256Digest');
  const sha256Digest = vm.runInNewContext(`(${source})`, { TextEncoder, BigInt, DataView, Uint8Array, Uint32Array });
  for (const sample of ['', 'abc', '笔触·选段', '🚀\nMarkdown']) {
    const expected = `sha256:${crypto.createHash('sha256').update(sample, 'utf8').digest('hex')}`;
    assert.equal(sha256Digest(sample), expected);
  }
});

test('intent is frozen before the first rewrite await', () => {
  const begin = editor.slice(editor.indexOf('async function beginRewrite('), editor.indexOf('async function rejectRewrite('));
  assert.ok(begin.indexOf('freezeRewriteIntent(style)') < begin.indexOf('await runRewrite(entry)'));
  assert.ok(begin.indexOf('rewriteOwner.begin(frozen.intent)') < begin.indexOf('await runRewrite(entry)'));
});

test('generation installs preview only after strict normalization', () => {
  const run = editor.slice(editor.indexOf('async function runRewrite('), editor.indexOf('async function beginRewrite('));
  assert.ok(run.indexOf('await window.writCraft.rewrite') < run.indexOf('normalizeReviewResult'));
  assert.ok(run.indexOf('normalizeReviewResult') < run.indexOf('placeRewriteAnchor'));
  assert.ok(run.indexOf('renderInlineDiff') < run.indexOf('await window.writCraft.ackRewrite'));
  assert.ok(run.indexOf('await window.writCraft.ackRewrite') < run.indexOf("recordRewriteMetric('generated'"));
  assert.ok(run.indexOf('setPreviewAckPending(entry, true)') < run.indexOf('await window.writCraft.ackRewrite'));
  assert.ok(html.includes('role="status" aria-live="polite" aria-atomic="true"'));
});

test('accept never writes local document truth', () => {
  const accept = editor.slice(editor.indexOf('async function acceptRewrite('), editor.indexOf('function cancelActiveRewriteForDocumentLoad'));
  assert.ok(accept.includes('window.writCraft.applyRewrite'));
  assert.ok(accept.includes('completeInlineRewriteCommit'));
  assert.ok(accept.includes('restoreInlineRewriteAfterZeroWrite'));
  assert.ok(accept.includes('enterRewriteRecovery'));
  assert.ok(!accept.includes('dispatchEvent'));
  assert.ok(!accept.includes('document.createTextNode'));
  assert.ok(!accept.includes('saveDraftNow'));
});

test('reject and regeneration discard without autosave', () => {
  const reject = editor.slice(editor.indexOf('async function rejectRewrite('), editor.indexOf('async function acceptRewrite('));
  assert.ok(reject.includes('rewriteOwner.discardPayload'));
  assert.ok(reject.includes('await safeDiscard'));
  assert.ok(reject.includes('restorePreview'));
  assert.ok(!reject.includes('dispatchEvent'));
  assert.ok(!reject.includes('saveDraftNow'));
});

test('unknown/manual outcomes remain locked and enter workspace recovery', () => {
  const accept = editor.slice(editor.indexOf('async function acceptRewrite('), editor.indexOf('function cancelActiveRewriteForDocumentLoad'));
  assert.ok(accept.includes("route.kind === 'manual_recovery' ? 'manual_recovery' : 'outcome_unknown'"));
  assert.ok(accept.includes('lockPreview(entry)'));
  assert.ok(!accept.includes('safeDiscard(entry.intent.projectInstanceId, payload)'));
  assert.ok(accept.includes("recovery?.ok === true && recovery.authoritativeReloaded === true"));
  assert.ok(accept.indexOf('destroyTransientPreview(entry)') < accept.lastIndexOf('enterRewriteRecovery(recoveryKind'));
});

test('blocking recovery dynamically destroys transient DOM without restoring bytes', () => {
  const source = extractFunction('destroyTransientPreview');
  let removed = 0;
  let updated = 0;
  const entry = { wrapper: { isConnected: true, remove() { removed += 1; } } };
  const context = {
    entry,
    pendingRewrite: entry,
    activeRewrite: entry,
    rewritePreparing: true,
    updateCount() { updated += 1; },
  };
  vm.runInNewContext(`${source}; destroyTransientPreview(entry);`, context);
  assert.equal(removed, 1);
  assert.equal(updated, 1);
  assert.equal(context.pendingRewrite, null);
  assert.equal(context.activeRewrite, null);
  assert.equal(context.rewritePreparing, false);
});

console.log(`Inline Rewrite Renderer UI verification passed: ${passed}/${passed}.`);
