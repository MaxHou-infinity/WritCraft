#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const service = require('../src/main/inline-rewrite-context-service');
const anchor = require('../src/renderer/block-anchor');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}: ${error.stack || error.message}`);
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, error => error instanceof service.InlineRewriteContextError && error.code === code);
}

function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-inline-context-'));
  const project = projectService.createProjectAt(parent, 'Inline');
  const edit = '# 主旨\n\nPROJECT_PROMPT_UNIQUE\n\n## 语气\n\n冷静、准确。\n';
  const chapter = '# 章节\n\nNEIGHBOR_BEFORE_UNIQUE\n\n重复句。TARGET_UNIQUE 🚀 需要改写。重复句。\n\nNEIGHBOR_AFTER_UNIQUE\n\nFAR_PARAGRAPH_MUST_NOT_ENTER\n';
  projectService.atomicWriteFile(project.rootPath, 'edit.md', edit, projectService.readFileWithRevision(project.rootPath, 'edit.md').revision);
  projectService.createMarkdownFile(project.rootPath, 'chapters/a.md');
  projectService.atomicWriteFile(project.rootPath, 'chapters/a.md', chapter, projectService.readFileWithRevision(project.rootPath, 'chapters/a.md').revision);
  return { parent, project, edit, chapter };
}

function requestFor(rootPath, filePath, content, start, end, style = 'general') {
  const proof = service.compactProof(anchor.createBlockAnchor(content, filePath, start, end));
  return {
    schema: service.REQUEST_SCHEMA,
    currentFilePath: filePath,
    expectedRevision: projectService.readFileWithRevision(rootPath, filePath).revision,
    style,
    instruction: '压缩重复表达',
    selection: { startOffset: start, endOffset: end, proof },
  };
}

function resolve(rootPath, request, override = projectService) {
  return service.resolveInlineRewriteContext({ projectService: override, rootPath, request });
}

console.log('════════ WritCraft V0 · Structured Inline Rewrite Context verify ════════');
const item = fixture();
try {
  const targetStart = item.chapter.indexOf('TARGET_UNIQUE');
  const targetEnd = targetStart + 'TARGET_UNIQUE 🚀 需要改写。'.length;

  test('rebuilds one authoritative target, edit.md and immediate neighbors exactly once', () => {
    const reads = new Map();
    const tracking = {
      EDIT_FILE: projectService.EDIT_FILE,
      readFileWithRevision(rootPath, filePath) {
        reads.set(filePath, (reads.get(filePath) || 0) + 1);
        return projectService.readFileWithRevision(rootPath, filePath);
      },
    };
    const result = resolve(item.project.rootPath, requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd), tracking);
    assert.strictEqual(result.selectedText, 'TARGET_UNIQUE 🚀 需要改写。');
    assert.strictEqual(reads.get('edit.md'), 1);
    assert.strictEqual(reads.get('chapters/a.md'), 1);
    for (const marker of ['PROJECT_PROMPT_UNIQUE', 'TARGET_UNIQUE', 'NEIGHBOR_BEFORE_UNIQUE', 'NEIGHBOR_AFTER_UNIQUE']) {
      assert.strictEqual(result.modelContext.split(marker).length - 1, 1, marker);
    }
    assert(!result.modelContext.includes('FAR_PARAGRAPH_MUST_NOT_ENTER'));
    assert.deepStrictEqual(
      result.contextManifest.chips.map(chip => [chip.type, chip.id, chip.label]),
      [
        ['project_prompt', 'inline-project-prompt', 'edit.md'],
        ['selection', 'inline-selection', '当前选段'],
        ['neighbor', 'inline-neighbor-target-before', '同段前文'],
        ['neighbor', 'inline-neighbor-target-after', '同段后文'],
        ['neighbor', 'inline-neighbor-before', '上一块'],
        ['neighbor', 'inline-neighbor-after', '下一块'],
      ],
    );
    assert(result.contextManifest.chips.every(chip => chip.bytes > 0));
    assert.strictEqual(result.contextManifest.locator.offset, targetStart);
    assert.strictEqual(result.contextManifest.locator.endOffset, targetEnd);
  });

  test('fails closed on a stale expected revision', () => {
    const request = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    request.expectedRevision = '0'.repeat(64);
    throwsCode(() => resolve(item.project.rootPath, request), 'REWRITE_REVISION_MISMATCH');
  });

  test('rejects unsafe paths before reading them', () => {
    const request = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    request.currentFilePath = '../secret.md';
    request.selection.proof.filePath = '../secret.md';
    let reads = 0;
    const tracking = { EDIT_FILE: 'edit.md', readFileWithRevision() { reads += 1; throw new Error('must not read'); } };
    throwsCode(() => resolve(item.project.rootPath, request, tracking), 'INVALID_REWRITE_PATH');
    assert.strictEqual(reads, 0);
  });

  test('rejects wrong proof and out-of-range offsets', () => {
    const wrong = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    wrong.selection.proof.quoteFingerprint = '00000000';
    throwsCode(() => resolve(item.project.rootPath, wrong), 'REWRITE_PROOF_MISMATCH');
    const out = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    out.selection.endOffset = item.chapter.length + 1;
    throwsCode(() => resolve(item.project.rootPath, out), 'INVALID_REWRITE_SELECTION');
    const invalidId = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    invalidId.selection.proof.id = 'block_nothex';
    throwsCode(() => resolve(item.project.rootPath, invalidId), 'INVALID_REWRITE_PROOF');
    const nonNfc = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    nonNfc.currentFilePath = 'chapters/e\u0301.md';
    nonNfc.selection.proof.filePath = nonNfc.currentFilePath;
    throwsCode(() => resolve(item.project.rootPath, nonNfc), 'INVALID_REWRITE_PATH');
  });

  test('rejects a selection crossing Markdown blocks even when the DOM could be one TextNode', () => {
    const start = item.chapter.indexOf('NEIGHBOR_BEFORE_UNIQUE');
    const end = item.chapter.indexOf('TARGET_UNIQUE') + 6;
    const validProof = service.compactProof(anchor.createBlockAnchor(
      item.chapter,
      'chapters/a.md',
      start,
      start + 'NEIGHBOR_BEFORE_UNIQUE'.length,
    ));
    const request = {
      schema: service.REQUEST_SCHEMA,
      currentFilePath: 'chapters/a.md',
      expectedRevision: projectService.readFileWithRevision(item.project.rootPath, 'chapters/a.md').revision,
      style: 'general',
      instruction: '压缩重复表达',
      selection: { startOffset: start, endOffset: end, proof: validProof },
    };
    throwsCode(() => resolve(item.project.rootPath, request), 'REWRITE_SELECTION_CROSSES_BLOCK');
  });

  test('anchors the intended occurrence when the same sentence repeats', () => {
    const second = item.chapter.lastIndexOf('重复句。');
    const request = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, second, second + 4, 'concise');
    const result = resolve(item.project.rootPath, request);
    assert.strictEqual(result.selectedText, '重复句。');
    assert.strictEqual(result.contextManifest.locator.offset, second);
  });

  test('preserves UTF-16 emoji offsets and CRLF block boundaries', () => {
    projectService.createMarkdownFile(item.project.rootPath, 'chapters/crlf.md');
    const content = '# CRLF\r\n\r\n前块🚀\r\n\r\n目标🌟选段\r\n\r\n后块\r\n';
    const old = projectService.readFileWithRevision(item.project.rootPath, 'chapters/crlf.md');
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/crlf.md', content, old.revision);
    const start = content.indexOf('🌟');
    const result = resolve(item.project.rootPath, requestFor(item.project.rootPath, 'chapters/crlf.md', content, start, start + '🌟选段'.length));
    assert.strictEqual(result.selectedText, '🌟选段');
    assert.strictEqual(result.contextManifest.locator.endOffset, start + 4);
  });

  test('keeps the complete model context within 32 KiB and reports truncation', () => {
    const hugeEdit = '# Prompt\n\n' + 'E'.repeat(80 * 1024) + '\n';
    const editBefore = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', hugeEdit, editBefore.revision);
    const result = resolve(item.project.rootPath, requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd));
    assert(Buffer.byteLength(result.modelContext, 'utf8') <= service.MAX_MODEL_CONTEXT_BYTES);
    assert.strictEqual(result.contextManifest.usedBytes, Buffer.byteLength(result.modelContext, 'utf8'));
    assert.strictEqual(result.contextManifest.truncated, true);
    assert.strictEqual(result.contextManifest.chips[0].truncated, true);
  });

  test('truncates optional blocks instead of rejecting a legal 8 KiB selection at the byte boundary', () => {
    const hugeEdit = '# Prompt\n\n' + 'E'.repeat(20 * 1024) + '\n';
    const editBefore = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', hugeEdit, editBefore.revision);
    projectService.createMarkdownFile(item.project.rootPath, 'chapters/budget.md');
    const selection = 'S'.repeat(service.MAX_SELECTION_BYTES);
    const content = `# Budget\n\n${'P'.repeat(6 * 1024)}\n\n${'T'.repeat(6 * 1024)}${selection}\n\n${'N'.repeat(6 * 1024)}\n`;
    const old = projectService.readFileWithRevision(item.project.rootPath, 'chapters/budget.md');
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/budget.md', content, old.revision);
    const start = content.indexOf(selection);
    const result = resolve(item.project.rootPath, requestFor(
      item.project.rootPath,
      'chapters/budget.md',
      content,
      start,
      start + selection.length,
    ));
    assert(Buffer.byteLength(result.modelContext, 'utf8') <= service.MAX_MODEL_CONTEXT_BYTES);
    assert.strictEqual(result.contextManifest.usedBytes, Buffer.byteLength(result.modelContext, 'utf8'));
    assert.strictEqual(result.contextManifest.truncated, true);
    assert(result.contextManifest.chips.every(chip => chip.bytes > 0), 'manifest must not claim zero-byte context');
  });

  test('editing edit.md never duplicates original prompt characters', () => {
    const edit = '# START_SENTINEL\n\nBEFORE_SENTINEL target SELECT_SENTINEL tail AFTER_SENTINEL\n\n# END_SENTINEL\n';
    const before = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', edit, before.revision);
    const start = edit.indexOf('SELECT_SENTINEL');
    const result = resolve(item.project.rootPath, requestFor(item.project.rootPath, 'edit.md', edit, start, start + 'SELECT_SENTINEL'.length));
    for (const marker of ['START_SENTINEL', 'BEFORE_SENTINEL', 'SELECT_SENTINEL', 'AFTER_SENTINEL', 'END_SENTINEL']) {
      assert.strictEqual(result.modelContext.split(marker).length - 1, 1, marker);
    }
    assert.strictEqual(result.contextManifest.chips.filter(chip => chip.type === 'project_prompt').length, 1);
  });

  test('edit.md truncated neighbor locators cover only the slices sent to the model', () => {
    const previous = `PREVIOUS_START_${'B'.repeat(20 * 1024)}_PREVIOUS_END`;
    const selected = 'SELECT_SENTINEL';
    const next = `NEXT_START_${'A'.repeat(20 * 1024)}_NEXT_END`;
    const edit = `${previous}\n\n${selected}\n\n${next}\n`;
    const before = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', edit, before.revision);
    const start = edit.indexOf(selected);
    const result = resolve(item.project.rootPath, requestFor(
      item.project.rootPath, 'edit.md', edit, start, start + selected.length,
    ));
    const beforeChip = result.contextManifest.chips.find(chip => chip.id === 'inline-neighbor-before');
    const afterChip = result.contextManifest.chips.find(chip => chip.id === 'inline-neighbor-after');
    assert(beforeChip && afterChip);
    assert.strictEqual(beforeChip.truncated, true);
    assert.strictEqual(afterChip.truncated, true);
    assert(beforeChip.locator.offset > 0);
    assert(beforeChip.locator.endOffset <= start);
    assert(afterChip.locator.offset >= start + selected.length);
    assert(afterChip.locator.endOffset < edit.length);
    for (const chip of [beforeChip, afterChip]) {
      const slice = edit.slice(chip.locator.offset, chip.locator.endOffset);
      assert.strictEqual(chip.bytes, Buffer.byteLength(slice, 'utf8'));
      assert(result.modelContext.includes(slice));
    }
  });

  test('reports same-block before and after slices with exact locators and truncation', () => {
    const edit = '# Prompt\n\nKeep the local paragraph bounded.\n';
    const editBefore = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', edit, editBefore.revision);
    projectService.createMarkdownFile(item.project.rootPath, 'chapters/one-block.md');
    const content = `${'B'.repeat(8 * 1024)}SELECT_ME${'A'.repeat(8 * 1024)}`;
    const old = projectService.readFileWithRevision(item.project.rootPath, 'chapters/one-block.md');
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/one-block.md', content, old.revision);
    const start = content.indexOf('SELECT_ME');
    const result = resolve(item.project.rootPath, requestFor(
      item.project.rootPath, 'chapters/one-block.md', content, start, start + 'SELECT_ME'.length,
    ));
    const beforeChip = result.contextManifest.chips.find(chip => chip.id === 'inline-neighbor-target-before');
    const afterChip = result.contextManifest.chips.find(chip => chip.id === 'inline-neighbor-target-after');
    assert(beforeChip && afterChip);
    assert.strictEqual(beforeChip.locator.endOffset, start);
    assert.strictEqual(afterChip.locator.offset, start + 'SELECT_ME'.length);
    assert.strictEqual(beforeChip.bytes, 4 * 1024 - Buffer.byteLength('<target-before-selection>\n\n</target-before-selection>'));
    assert.strictEqual(beforeChip.truncated, true);
    assert.strictEqual(afterChip.truncated, true);
    assert.strictEqual(result.contextManifest.truncated, true);
  });

  test('rejects an empty edit.md instead of claiming a zero-byte project prompt', () => {
    const editBefore = projectService.readFileWithRevision(item.project.rootPath, 'edit.md');
    projectService.atomicWriteFile(item.project.rootPath, 'edit.md', '', editBefore.revision);
    const request = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    throwsCode(() => resolve(item.project.rootPath, request), 'PROJECT_PROMPT_UNAVAILABLE');
  });

  test('rejects unknown fields, renderer text and projectContext injection', () => {
    const base = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    throwsCode(() => resolve(item.project.rootPath, { ...base, schema: 'writcraft.inline-rewrite/v1' }), 'INVALID_REWRITE_REQUEST');
    const { instruction: omitted, ...legacyShape } = base;
    assert(omitted);
    throwsCode(() => resolve(item.project.rootPath, legacyShape), 'INVALID_REWRITE_REQUEST');
    throwsCode(() => resolve(item.project.rootPath, { ...base, text: 'renderer body' }), 'INVALID_REWRITE_REQUEST');
    throwsCode(() => resolve(item.project.rootPath, { ...base, projectContext: 'injected prompt' }), 'INVALID_REWRITE_REQUEST');
    const selectionText = { ...base, selection: { ...base.selection, text: 'injected text' } };
    throwsCode(() => resolve(item.project.rootPath, selectionText), 'INVALID_REWRITE_SELECTION');
    const proofText = { ...base, selection: { ...base.selection, proof: { ...base.selection.proof, quote: 'secret' } } };
    throwsCode(() => resolve(item.project.rootPath, proofText), 'INVALID_REWRITE_PROOF');
  });

  test('enforces the 8 KiB request, bounded instruction, 8 KiB selection and style allowlist', () => {
    const base = requestFor(item.project.rootPath, 'chapters/a.md', item.chapter, targetStart, targetEnd);
    throwsCode(() => resolve(item.project.rootPath, { ...base, style: 'system override' }), 'INVALID_REWRITE_STYLE');
    throwsCode(() => resolve(item.project.rootPath, { ...base, instruction: 'bad\nline' }), 'INVALID_REWRITE_INSTRUCTION');
    throwsCode(() => resolve(item.project.rootPath, { ...base, instruction: 'x'.repeat(501) }), 'INVALID_REWRITE_INSTRUCTION');
    const oversized = { ...base, extra: 'x'.repeat(service.MAX_REQUEST_BYTES) };
    throwsCode(() => resolve(item.project.rootPath, oversized), 'REWRITE_REQUEST_TOO_LARGE');

    projectService.createMarkdownFile(item.project.rootPath, 'chapters/large-selection.md');
    const content = '# Large\n\n' + 'x'.repeat(service.MAX_SELECTION_BYTES + 1) + '\n';
    const old = projectService.readFileWithRevision(item.project.rootPath, 'chapters/large-selection.md');
    projectService.atomicWriteFile(item.project.rootPath, 'chapters/large-selection.md', content, old.revision);
    const start = content.indexOf('x');
    const request = requestFor(item.project.rootPath, 'chapters/large-selection.md', content, start, start + service.MAX_SELECTION_BYTES + 1);
    throwsCode(() => resolve(item.project.rootPath, request), 'REWRITE_SELECTION_TOO_LARGE');
  });
} finally {
  fs.rmSync(item.parent, { recursive: true, force: true });
}

if (!process.exitCode) console.log(`\n✅ Structured Inline Rewrite Context ${passed}/${passed} 全过`);
