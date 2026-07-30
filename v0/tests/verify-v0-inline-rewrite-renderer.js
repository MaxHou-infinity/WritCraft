#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');
const aiMetricsService = require('../src/main/ai-metrics-service');

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
  assert.ok(begin.indexOf('freezeRewriteIntent(style, canonicalInstruction)') >= 0);
  assert.ok(begin.indexOf('freezeRewriteIntent(style, canonicalInstruction)') < begin.indexOf('await runRewrite(entry)'));
  assert.ok(begin.indexOf('rewriteOwner.begin(frozen.intent)') < begin.indexOf('await runRewrite(entry)'));
});

test('Cmd-K opens a private instruction composer before any AI work', () => {
  for (const id of [
    'inline-rewrite-command', 'inline-rewrite-command-input', 'inline-rewrite-command-style',
    'inline-rewrite-command-submit', 'inline-rewrite-command-cancel',
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  const open = extractFunction('openRewriteCommand');
  assert.ok(open.includes('REWRITE_COMMAND.hidden = false'));
  assert.ok(open.includes('REWRITE_COMMAND_INPUT.focus()'));
  assert.ok(!open.includes('writCraft.rewrite'));
  assert.ok(!open.includes('persistCurrent'));
  assert.ok(!open.includes('recordRewriteMetric'));
});

test('instruction submit revalidates the frozen Range and Cmd-L cancels the local composer', () => {
  const open = extractFunction('openRewriteCommand');
  const submit = extractFunction('submitRewriteCommand');
  const current = extractFunction('rewriteCommandStillCurrent');
  assert.ok(open.includes('rangeIdentityFor(selected.range)'));
  assert.ok(open.includes('createBlockAnchor'));
  assert.ok(current.includes('rangeIdentityFor(command.range) !== command.rangeIdentity'));
  assert.ok(current.includes('JSON.stringify(proof) === JSON.stringify(command.proof)'));
  assert.ok(submit.includes('normalizeInstruction'));
  assert.ok(submit.includes('rewriteCommandStillCurrent(command)'));
  assert.ok(submit.includes('selection.addRange(range)'));
  assert.ok(submit.includes('beginRewrite(style, instruction)'));
  assert.ok(editor.includes("if (rewriteCommand) closeRewriteCommand(false);\n      if (CHAT_PANEL.style.display === 'flex')"));
  assert.ok(editor.includes("event.key === 'Enter' && !event.isComposing"));
  assert.ok(editor.includes('codePoints.slice(0, 500).join'));
  assert.ok(editor.includes('if (rewriteCommand) closeRewriteCommand(false);\n      cancelActiveRewriteForDocumentLoad();'));
});

test('instruction dynamically crosses the Renderer metrics boundary without reaching disk', () => {
  const metric = extractFunction('recordRewriteMetric');
  assert.ok(!metric.includes('instruction'));
  assert.ok(!metric.includes('digest'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-metric-'));
  const canary = 'PRIVATE_INSTRUCTION_CANARY_7f31';
  try {
    const context = {
      Date,
      Number,
      window: {
        WritCraftAiMetrics: {
          record(projectInstanceId, payload) {
            assert.equal(projectInstanceId, 'project-instance');
            aiMetricsService.appendEvent(scratch, payload, {
              now: new Date('2026-07-30T00:00:00.000Z'),
            });
          },
        },
      },
      entry: {
        operationId: '0123456789abcdef0123456789abcdef',
        originProjectInstanceId: 'project-instance',
        instruction: canary,
        instructionDigest: `sha256:${canary}`,
        style: 'concise',
        original: '原文',
        startedAt: Date.now(),
      },
    };
    vm.runInNewContext(`${metric}; recordRewriteMetric('generated', entry, 2);`, context);
    const persisted = fs.readFileSync(
      path.join(scratch, aiMetricsService.METRICS_RELATIVE_PATH),
      'utf8',
    );
    assert.ok(!persisted.includes(canary));
    assert.ok(!persisted.includes('instruction'));
    assert.equal(aiMetricsService.loadMetrics(scratch).events.length, 1);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
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
