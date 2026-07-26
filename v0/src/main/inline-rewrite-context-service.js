'use strict';

// Main-owned context builder for project-scoped inline rewrites. The renderer
// sends only a locator proof; every byte given to the model is reconstructed
// from the authoritative project snapshot here.

const blockAnchor = require('../renderer/block-anchor');

const REQUEST_SCHEMA = 'writcraft.inline-rewrite/v1';
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_SELECTION_BYTES = 8 * 1024;
const MAX_MODEL_CONTEXT_BYTES = 32 * 1024;
const MAX_PATH_BYTES = 1024;
const STYLE_ALLOWLIST = Object.freeze(['general', 'concise', 'vivid', 'academic', 'casual']);
const STYLE_SET = new Set(STYLE_ALLOWLIST);
const REQUEST_KEYS = Object.freeze(['schema', 'currentFilePath', 'expectedRevision', 'style', 'selection']);
const SELECTION_KEYS = Object.freeze(['startOffset', 'endOffset', 'proof']);
const PROOF_KEYS = Object.freeze([
  'schema', 'id', 'filePath', 'type', 'headingKey', 'ordinal',
  'blockFingerprint', 'quoteFingerprint', 'relativeStart', 'relativeEnd',
]);

class InlineRewriteContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InlineRewriteContextError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new InlineRewriteContextError(code, message);
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
}

function validatePublicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || utf8Bytes(value) > MAX_PATH_BYTES ||
      value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    fail('INVALID_REWRITE_PATH', '当前文件路径无效');
  }
  const normalized = value.normalize('NFC');
  if (value !== normalized) fail('INVALID_REWRITE_PATH', '当前文件路径必须使用 NFC 规范形式');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('INVALID_REWRITE_PATH', '当前文件必须是项目内的公开 Markdown 文件');
  }
  return parts.join('/');
}

function validateProof(proof, currentFilePath) {
  if (!exactKeys(proof, PROOF_KEYS) || proof.schema !== blockAnchor.SCHEMA ||
      proof.filePath !== currentFilePath || typeof proof.id !== 'string' || !/^block_[a-f0-9]{8}$/.test(proof.id) ||
      typeof proof.type !== 'string' || !proof.type || utf8Bytes(proof.type) > 80 ||
      typeof proof.headingKey !== 'string' || utf8Bytes(proof.headingKey) > 1024 ||
      !Number.isSafeInteger(proof.ordinal) || proof.ordinal < 1 ||
      typeof proof.blockFingerprint !== 'string' || !/^[a-f0-9]{8}$/.test(proof.blockFingerprint) ||
      typeof proof.quoteFingerprint !== 'string' || !/^[a-f0-9]{8}$/.test(proof.quoteFingerprint) ||
      !Number.isSafeInteger(proof.relativeStart) || proof.relativeStart < 0 ||
      !Number.isSafeInteger(proof.relativeEnd) || proof.relativeEnd < proof.relativeStart) {
    fail('INVALID_REWRITE_PROOF', '选段定位证明无效');
  }
  return proof;
}

function validateRequest(request) {
  if (serializedBytes(request) > MAX_REQUEST_BYTES) {
    fail('REWRITE_REQUEST_TOO_LARGE', '结构化改写请求不能超过 4 KiB');
  }
  if (!exactKeys(request, REQUEST_KEYS) || request.schema !== REQUEST_SCHEMA) {
    fail('INVALID_REWRITE_REQUEST', '结构化改写请求格式无效');
  }
  const currentFilePath = validatePublicMarkdownPath(request.currentFilePath);
  if (typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision)) {
    fail('INVALID_REWRITE_REVISION', '文件 revision 无效');
  }
  if (!STYLE_SET.has(request.style)) fail('INVALID_REWRITE_STYLE', '不支持该改写风格');
  if (!exactKeys(request.selection, SELECTION_KEYS)) {
    fail('INVALID_REWRITE_SELECTION', '选段范围格式无效');
  }
  const { startOffset, endOffset } = request.selection;
  if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) ||
      startOffset < 0 || endOffset <= startOffset) {
    fail('INVALID_REWRITE_SELECTION', '选段 UTF-16 偏移无效');
  }
  validateProof(request.selection.proof, currentFilePath);
  return request;
}

function compactProof(anchor) {
  const compact = {};
  for (const key of PROOF_KEYS) compact[key] = anchor[key];
  return compact;
}

function proofsEqual(left, right) {
  return PROOF_KEYS.every(key => left[key] === right[key]);
}

function prefixWithinBytes(value, limit) {
  const source = String(value || '');
  if (limit <= 0) return '';
  if (utf8Bytes(source) <= limit) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(source.slice(0, mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  // Never split a surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/.test(source[low - 1]) && /[\uDC00-\uDFFF]/.test(source[low] || '')) low -= 1;
  return source.slice(0, low);
}

function suffixWithinBytes(value, limit) {
  const source = String(value || '');
  if (limit <= 0) return '';
  if (utf8Bytes(source) <= limit) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (utf8Bytes(source.slice(source.length - length)) <= limit) low = length;
    else high = length - 1;
  }
  let start = source.length - low;
  if (start > 0 && /[\uD800-\uDBFF]/.test(source[start - 1]) && /[\uDC00-\uDFFF]/.test(source[start] || '')) start += 1;
  return source.slice(start);
}

function tagged(label, content) {
  return `<${label}>\n${content}\n</${label}>`;
}

function fitTagged(label, content, available, edge = 'prefix') {
  const overhead = utf8Bytes(tagged(label, ''));
  if (available <= overhead) return { text: '', content: '', bytes: 0, truncated: Boolean(content) };
  const slice = edge === 'suffix'
    ? suffixWithinBytes(content, available - overhead)
    : prefixWithinBytes(content, available - overhead);
  const text = slice ? tagged(label, slice) : '';
  return { text, content: slice, bytes: utf8Bytes(slice), truncated: slice !== content };
}

function makeChip(type, id, file, range, options = {}) {
  return {
    id,
    type,
    label: options.label || file.path,
    filePath: file.path,
    revision: file.revision,
    locator: {
      filePath: file.path,
      offset: range.start,
      endOffset: range.end,
    },
    bytes: options.bytes === undefined ? utf8Bytes(file.content.slice(range.start, range.end)) : options.bytes,
    truncated: Boolean(options.truncated),
    truncationReason: options.truncated ? '为保持 Inline Rewrite 上下文边界已截断' : null,
  };
}

function locateBlock(blocks, start, end) {
  return blocks.find(block => start >= block.start && end <= block.end) || null;
}

function buildNormalFileContext(editFile, targetFile, request, blocks, targetBlock) {
  const selection = request.selection;
  const index = blocks.indexOf(targetBlock);
  const previous = index > 0 ? blocks[index - 1] : null;
  const next = index + 1 < blocks.length ? blocks[index + 1] : null;
  const targetBefore = targetFile.content.slice(targetBlock.start, selection.startOffset);
  const selected = targetFile.content.slice(selection.startOffset, selection.endOffset);
  const targetAfter = targetFile.content.slice(selection.endOffset, targetBlock.end);
  const required = tagged('rewrite-selection', selected);
  if (utf8Bytes(required) > MAX_MODEL_CONTEXT_BYTES) fail('REWRITE_CONTEXT_TOO_LARGE', '选段无法放入改写上下文');

  const parts = [];
  // There can be at most six emitted tagged parts, hence five "\n\n"
  // separators. Reserve every possible separator up front so an optional
  // block can never consume the two bytes needed to join the mandatory
  // selection. Unused separator reserve is harmless and keeps the allocator
  // exact for the legal 8 KiB selection boundary.
  const MAX_SEPARATOR_BYTES = 5 * utf8Bytes('\n\n');
  let remaining = MAX_MODEL_CONTEXT_BYTES - utf8Bytes(required) - MAX_SEPARATOR_BYTES;
  function addOptional(text) {
    if (!text) return;
    parts.push(text);
    remaining -= utf8Bytes(text);
  }

  // The exact selection is never truncated. Only optional project/local
  // context consumes the remaining allocation above.
  const editBudget = Math.max(0, Math.min(18 * 1024, remaining));
  const editPart = fitTagged('project-prompt', editFile.content, editBudget, 'prefix');
  addOptional(editPart.text);

  const fittedLocal = new Map();
  for (const [label, value, edge] of [
    ['previous-block', previous?.text || '', 'suffix'],
    ['target-before-selection', targetBefore, 'suffix'],
  ]) {
    const cap = Math.min(4 * 1024, Math.max(0, remaining));
    const fitted = fitTagged(label, value, cap, edge);
    fittedLocal.set(label, fitted);
    addOptional(fitted.text);
  }
  parts.push(required);
  for (const [label, value, edge] of [
    ['target-after-selection', targetAfter, 'prefix'],
    ['next-block', next?.text || '', 'prefix'],
  ]) {
    const cap = Math.min(4 * 1024, Math.max(0, remaining));
    const fitted = fitTagged(label, value, cap, edge);
    fittedLocal.set(label, fitted);
    addOptional(fitted.text);
  }

  const modelContext = parts.join('\n\n');
  const chips = [
    makeChip('project_prompt', 'inline-project-prompt', editFile, { start: 0, end: editFile.content.length }, {
      label: 'edit.md', bytes: editPart.bytes, truncated: editPart.truncated,
    }),
    makeChip('selection', 'inline-selection', targetFile, {
      start: selection.startOffset, end: selection.endOffset,
    }, { label: '当前选段', bytes: utf8Bytes(selected) }),
  ];
  const targetBeforePart = fittedLocal.get('target-before-selection');
  if (targetBeforePart?.bytes > 0) {
    chips.push(makeChip('neighbor', 'inline-neighbor-target-before', targetFile, {
      start: selection.startOffset - targetBeforePart.content.length,
      end: selection.startOffset,
    }, {
      label: '同段前文', bytes: targetBeforePart.bytes, truncated: targetBeforePart.truncated,
    }));
  }
  const targetAfterPart = fittedLocal.get('target-after-selection');
  if (targetAfterPart?.bytes > 0) {
    chips.push(makeChip('neighbor', 'inline-neighbor-target-after', targetFile, {
      start: selection.endOffset,
      end: selection.endOffset + targetAfterPart.content.length,
    }, {
      label: '同段后文', bytes: targetAfterPart.bytes, truncated: targetAfterPart.truncated,
    }));
  }
  if (previous && fittedLocal.get('previous-block')?.bytes > 0) {
    const fitted = fittedLocal.get('previous-block');
    chips.push(makeChip('neighbor', 'inline-neighbor-before', targetFile, {
      start: previous.end - fitted.content.length,
      end: previous.end,
    }, {
      label: '上一块', bytes: fitted.bytes, truncated: fitted.truncated,
    }));
  }
  if (next && fittedLocal.get('next-block')?.bytes > 0) {
    const fitted = fittedLocal.get('next-block');
    chips.push(makeChip('neighbor', 'inline-neighbor-after', targetFile, {
      start: next.start,
      end: next.start + fitted.content.length,
    }, {
      label: '下一块', bytes: fitted.bytes, truncated: fitted.truncated,
    }));
  }
  return {
    modelContext,
    chips,
    truncated: editPart.truncated || [...fittedLocal.values()].some(item => item.truncated),
  };
}

function buildEditTargetContext(editFile, request, blocks, targetBlock) {
  const selection = request.selection;
  const selected = editFile.content.slice(selection.startOffset, selection.endOffset);
  const required = tagged('rewrite-selection', selected);
  if (utf8Bytes(required) > MAX_MODEL_CONTEXT_BYTES) fail('REWRITE_CONTEXT_TOO_LARGE', '选段无法放入改写上下文');
  const available = MAX_MODEL_CONTEXT_BYTES - utf8Bytes(required) - 4;
  const beforeBudget = Math.floor(available / 2);
  const afterBudget = available - beforeBudget;
  const beforeRaw = editFile.content.slice(0, selection.startOffset);
  const afterRaw = editFile.content.slice(selection.endOffset);
  const before = fitTagged('project-prompt-before-selection', beforeRaw, beforeBudget, 'suffix');
  const after = fitTagged('project-prompt-after-selection', afterRaw, afterBudget, 'prefix');
  const modelContext = [before.text, required, after.text].filter(Boolean).join('\n\n');
  const index = blocks.indexOf(targetBlock);
  const includedBeforeStart = selection.startOffset - before.content.length;
  const includedAfterEnd = selection.endOffset + after.content.length;
  function includedNeighbor(block) {
    // A neighbor is wholly before or after the selection, so choose the
    // corresponding included interval.
    const actualStart = block.end <= selection.startOffset
      ? Math.max(block.start, includedBeforeStart)
      : Math.max(block.start, selection.endOffset);
    const actualEnd = block.end <= selection.startOffset
      ? Math.min(block.end, selection.startOffset)
      : Math.min(block.end, includedAfterEnd);
    const bytes = actualEnd > actualStart ? utf8Bytes(editFile.content.slice(actualStart, actualEnd)) : 0;
    return {
      range: { start: actualStart, end: actualEnd },
      bytes,
      truncated: actualStart !== block.start || actualEnd !== block.end,
    };
  }
  const chips = [
    makeChip('project_prompt', 'inline-project-prompt', editFile, { start: 0, end: editFile.content.length }, {
      label: 'edit.md', bytes: before.bytes + utf8Bytes(selected) + after.bytes,
      truncated: before.truncated || after.truncated,
    }),
    makeChip('selection', 'inline-selection', editFile, {
      start: selection.startOffset, end: selection.endOffset,
    }, { label: '当前选段', bytes: utf8Bytes(selected) }),
  ];
  if (index > 0) {
    const previous = blocks[index - 1];
    const included = includedNeighbor(previous);
    if (included.bytes > 0) {
      chips.push(makeChip('neighbor', 'inline-neighbor-before', editFile, included.range, {
        label: '上一块', bytes: included.bytes, truncated: included.truncated,
      }));
    }
  }
  if (index + 1 < blocks.length) {
    const next = blocks[index + 1];
    const included = includedNeighbor(next);
    if (included.bytes > 0) {
      chips.push(makeChip('neighbor', 'inline-neighbor-after', editFile, included.range, {
        label: '下一块', bytes: included.bytes, truncated: included.truncated,
      }));
    }
  }
  return { modelContext, chips, truncated: before.truncated || after.truncated };
}

function resolveInlineRewriteContext({ projectService, rootPath, request }) {
  if (!projectService || typeof projectService.readFileWithRevision !== 'function') {
    throw new TypeError('projectService.readFileWithRevision is required');
  }
  validateRequest(request);

  let targetFile;
  try {
    targetFile = projectService.readFileWithRevision(rootPath, request.currentFilePath);
  } catch (error) {
    if (error && ['INVALID_PATH', 'PATH_TRAVERSAL', 'PRIVATE_PATH', 'INVALID_EXTENSION', 'NOT_FOUND'].includes(error.code)) {
      fail('INVALID_REWRITE_PATH', '当前 Markdown 文件不可用');
    }
    throw error;
  }
  targetFile = { ...targetFile, path: request.currentFilePath };
  if (targetFile.revision !== request.expectedRevision) {
    fail('REWRITE_REVISION_MISMATCH', '当前文件已变化，请重新选中后改写');
  }
  if (request.selection.endOffset > targetFile.content.length) {
    fail('INVALID_REWRITE_SELECTION', '选段已超出当前文件');
  }
  const selected = targetFile.content.slice(request.selection.startOffset, request.selection.endOffset);
  if (!selected.trim()) fail('EMPTY_REWRITE_SELECTION', '选段不能为空');
  if (utf8Bytes(selected) > MAX_SELECTION_BYTES) {
    fail('REWRITE_SELECTION_TOO_LARGE', '单次改写选段不能超过 8 KiB');
  }

  let reconstructed;
  try {
    reconstructed = blockAnchor.createBlockAnchor(
      targetFile.content,
      request.currentFilePath,
      request.selection.startOffset,
      request.selection.endOffset,
    );
  } catch (error) {
    if (/one Markdown block/.test(String(error && error.message))) {
      fail('REWRITE_SELECTION_CROSSES_BLOCK', '一次只能改写一个 Markdown 块');
    }
    fail('INVALID_REWRITE_SELECTION', '无法在当前文件中重建选段');
  }
  if (!proofsEqual(compactProof(reconstructed), request.selection.proof)) {
    fail('REWRITE_PROOF_MISMATCH', '选段定位证明与当前文件不一致');
  }

  const blocks = blockAnchor.parseBlocks(targetFile.content, request.currentFilePath);
  const targetBlock = locateBlock(blocks, request.selection.startOffset, request.selection.endOffset);
  if (!targetBlock) fail('REWRITE_SELECTION_CROSSES_BLOCK', '一次只能改写一个 Markdown 块');

  let built;
  if (request.currentFilePath === projectService.EDIT_FILE) {
    built = buildEditTargetContext(targetFile, request, blocks, targetBlock);
  } else {
    let editFile;
    try {
      editFile = { ...projectService.readFileWithRevision(rootPath, projectService.EDIT_FILE), path: projectService.EDIT_FILE };
    } catch (error) {
      fail('PROJECT_PROMPT_UNAVAILABLE', '项目 Prompt edit.md 不可用');
    }
    if (!editFile.content.trim()) fail('PROJECT_PROMPT_UNAVAILABLE', '项目 Prompt edit.md 不能为空');
    built = buildNormalFileContext(editFile, targetFile, request, blocks, targetBlock);
  }
  if (utf8Bytes(built.modelContext) > MAX_MODEL_CONTEXT_BYTES) {
    fail('REWRITE_CONTEXT_TOO_LARGE', '改写上下文超过 32 KiB');
  }

  return Object.freeze({
    request: Object.freeze({
      schema: request.schema,
      currentFilePath: request.currentFilePath,
      expectedRevision: request.expectedRevision,
      style: request.style,
      selection: Object.freeze({
        startOffset: request.selection.startOffset,
        endOffset: request.selection.endOffset,
      }),
    }),
    selectedText: selected,
    modelContext: built.modelContext,
    contextManifest: Object.freeze({
      schema: 'writcraft.context-manifest/v1',
      authority: 'main-manifest',
      scope: 'selection',
      currentFilePath: request.currentFilePath,
      currentRevision: targetFile.revision,
      budgetChars: MAX_MODEL_CONTEXT_BYTES,
      budgetBytes: MAX_MODEL_CONTEXT_BYTES,
      usedChars: built.modelContext.length,
      usedBytes: utf8Bytes(built.modelContext),
      truncated: Boolean(built.truncated),
      locator: Object.freeze({
        filePath: request.currentFilePath,
        offset: request.selection.startOffset,
        endOffset: request.selection.endOffset,
      }),
      chips: Object.freeze(built.chips.map(chip => Object.freeze(chip))),
      errors: Object.freeze([]),
    }),
  });
}

module.exports = {
  REQUEST_SCHEMA,
  MAX_REQUEST_BYTES,
  MAX_SELECTION_BYTES,
  MAX_MODEL_CONTEXT_BYTES,
  STYLE_ALLOWLIST,
  PROOF_KEYS,
  InlineRewriteContextError,
  compactProof,
  validateRequest,
  resolveInlineRewriteContext,
};
