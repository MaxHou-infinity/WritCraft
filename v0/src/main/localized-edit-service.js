'use strict';

const blockAnchor = require('../renderer/block-anchor');

// Main-owned boundary for model-authored localized edits. The provider never
// returns a complete file: it identifies a unique, bounded substring in a
// trusted snapshot and supplies its bounded replacement. Main resolves every
// range against the same `before`, rejects overlap, and constructs full `after`
// files locally before handing them to ChangeSet.

const MAX_MODEL_OUTPUT_BYTES = 24 * 1024;
const MAX_PATCH_EDITS = 32;
const MAX_PATCH_FILES = 16;
const MAX_PATH_BYTES = 512;
const MAX_OLD_TEXT_BYTES = 2 * 1024;
const MAX_NEW_TEXT_BYTES = 4 * 1024;
const MAX_SUMMARY_CHARS = 500;
const MAX_SUMMARY_BYTES = 512;
const MAX_TOTAL_EDIT_BYTES = 20 * 1024;
const STRUCTURED_TOOL_NAME = 'submit_localized_edits';
// Main exposes revision-bound, request-local ranges. The model never repeats
// canonical paths, source text, or offsets. Eight edits cover a chapter's
// common heading structure; the aggregate replacement budget closes beneath
// both the dedicated 7 KiB tool-input boundary and the provider's 8,192-token ceiling.
const STRUCTURED_MAX_PATCH_EDITS = 8;
const STRUCTURED_MAX_RANGES = 96;
const STRUCTURED_MAX_RANGE_BYTES = 32 * 1024;
const STRUCTURED_MAX_NEW_TEXT_CHARS = 640;
const STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS = 1024;
const STRUCTURED_MAX_SUMMARY_CHARS = 40;
const STRUCTURED_MAX_TOOL_INPUT_BYTES = 7 * 1024;
const STRUCTURED_MAX_TOKENS = 8_192;
const SAFE_MULTILINE_TOOL_TEXT_PATTERN = '^(?:[\\t\\n\\r]|[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$';
const SAFE_SUMMARY_TOOL_TEXT_PATTERN = '^(?!\\s)(?![\\s\\S]*\\s$)(?:[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
const SAFE_MULTILINE_TOOL_TEXT = /^(?:[\t\n\r]|[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u;
const SAFE_SUMMARY_TOOL_TEXT = /^(?:[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/u;
const STRUCTURED_RETRYABLE_CODES = new Set([
  'INVALID_TOOL_USE',
  'INVALID_MODEL_OUTPUT',
  'MODEL_OUTPUT_TOO_LARGE',
  'TOO_MANY_PATCH_EDITS',
  'UNAUTHORIZED_PATCH_RANGE',
  'DUPLICATE_PATCH_RANGE',
  'PATCH_NEW_TEXT_TOO_LARGE',
]);

class LocalizedEditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalizedEditError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalizedEditError(code, message);
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function assertExactObject(value, expectedKeys, label) {
  if (!isPlainObject(value)) fail('INVALID_MODEL_OUTPUT', `${label}必须是普通对象`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_MODEL_OUTPUT', `${label}包含未授权或缺失字段`);
  }
}

function validateEdits(value) {
  if (!Array.isArray(value)) fail('INVALID_MODEL_OUTPUT', 'edits 必须是数组');
  if (value.length > MAX_PATCH_EDITS) {
    fail('TOO_MANY_PATCH_EDITS', `单次最多允许 ${MAX_PATCH_EDITS} 个局部修改`);
  }

  let totalEditBytes = 0;
  const edits = value.map((edit, index) => {
    assertExactObject(edit, ['path', 'oldText', 'newText', 'summary'], `edits[${index}]`);
    if (typeof edit.path !== 'string' || typeof edit.oldText !== 'string' ||
        typeof edit.newText !== 'string' || typeof edit.summary !== 'string') {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}] 字段类型无效`);
    }
    const summary = edit.summary.trim();
    if (!edit.path || /\0/.test(edit.path) || bytes(edit.path) > MAX_PATH_BYTES) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}].path 无效`);
    }
    if (!edit.oldText || /\0/.test(edit.oldText) || bytes(edit.oldText) > MAX_OLD_TEXT_BYTES) {
      fail('PATCH_OLD_TEXT_INVALID', `edits[${index}].oldText 必须是非空且有界的唯一锚点`);
    }
    if (/\0/.test(edit.newText) || bytes(edit.newText) > MAX_NEW_TEXT_BYTES) {
      fail('PATCH_NEW_TEXT_TOO_LARGE', `edits[${index}].newText 超过局部替换上限`);
    }
    if (!summary || /\0/.test(summary) || summary.length > MAX_SUMMARY_CHARS || bytes(summary) > MAX_SUMMARY_BYTES) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}].summary 无效`);
    }
    totalEditBytes += bytes(edit.path) + bytes(edit.oldText) + bytes(edit.newText) + bytes(summary);
    if (totalEditBytes > MAX_TOTAL_EDIT_BYTES) {
      fail('PATCH_TEXT_TOO_LARGE', `局部修改文本合计不能超过 ${MAX_TOTAL_EDIT_BYTES} 字节`);
    }
    return Object.freeze({ path: edit.path, oldText: edit.oldText, newText: edit.newText, summary });
  });
  return Object.freeze(edits);
}

function headingLevel(block) {
  const matched = typeof block?.text === 'string' && block.text.match(/^\s{0,3}(#{1,6})\s+/);
  return matched ? matched[1].length : null;
}

function buildStructuredRangeCatalog(snapshots) {
  const snapshotByPath = trustedSnapshots(snapshots);
  if (!snapshotByPath.size) fail('INVALID_PATCH_SNAPSHOTS', '结构化局部修改至少需要一个目标文件');
  if (snapshotByPath.size > STRUCTURED_MAX_PATCH_EDITS) {
    fail('INVALID_PATCH_SNAPSHOTS', `结构化局部修改最多允许 ${STRUCTURED_MAX_PATCH_EDITS} 个目标文件`);
  }
  const ranges = [];
  for (const [filePath, snapshot] of snapshotByPath.entries()) {
    let blocks;
    try { blocks = blockAnchor.parseBlocks(snapshot.content, filePath); }
    catch (_) { fail('INVALID_PATCH_SNAPSHOTS', '无法为结构化修改建立正文范围目录'); }
    const headings = blocks.filter(block => block.type === 'heading');
    const minimumLevel = headings.length
      ? Math.min(...headings.map(headingLevel).filter(Number.isInteger))
      : null;
    const minimumHeadings = Number.isInteger(minimumLevel)
      ? headings.filter(block => headingLevel(block) === minimumLevel)
      : [];
    const nextLevel = minimumHeadings.length === 1
      ? Math.min(...headings.map(headingLevel).filter(level => level > minimumLevel))
      : Infinity;
    const sectionLevel = Number.isFinite(nextLevel) ? nextLevel : minimumLevel;
    const sectionHeadings = Number.isInteger(sectionLevel)
      ? headings.filter(block => headingLevel(block) === sectionLevel)
      : [];
    const sourceRanges = [];
    if (sectionHeadings.length) {
      const firstStart = sectionHeadings[0].start;
      if (snapshot.content.slice(0, firstStart).trim()) {
        sourceRanges.push({ start: 0, end: firstStart, label: '文首' });
      }
      for (const [index, heading] of sectionHeadings.entries()) {
        sourceRanges.push({
          start: heading.start,
          end: sectionHeadings[index + 1]?.start ?? snapshot.content.length,
          label: heading.text.replace(/^\s{0,3}#{1,6}\s+/, '').trim().slice(0, 80),
        });
      }
    } else {
      for (const block of blocks) {
        sourceRanges.push({
          start: block.start,
          end: block.end,
          label: block.headingKey || block.type,
        });
      }
    }
    for (const sourceRange of sourceRanges) {
      const content = snapshot.content.slice(sourceRange.start, sourceRange.end);
      if (!content || bytes(content) > STRUCTURED_MAX_RANGE_BYTES) {
        fail('PATCH_RANGE_TOO_LARGE', `正文范围超过 ${STRUCTURED_MAX_RANGE_BYTES} 字节，不能交给结构化修改`);
      }
      ranges.push(Object.freeze({
        rangeId: `range_${ranges.length + 1}`,
        path: filePath,
        revision: snapshot.revision,
        start: sourceRange.start,
        end: sourceRange.end,
        label: sourceRange.label,
        content,
      }));
      if (ranges.length > STRUCTURED_MAX_RANGES) {
        fail('TOO_MANY_PATCH_RANGES', `结构化修改范围最多允许 ${STRUCTURED_MAX_RANGES} 个`);
      }
    }
  }
  if (!ranges.length) fail('INVALID_PATCH_SNAPSHOTS', '目标文件没有可修改的正文范围');
  return Object.freeze(ranges);
}

function validateStructuredRangeCatalog(ranges, snapshots) {
  const rebuilt = buildStructuredRangeCatalog(snapshots);
  if (!Array.isArray(ranges) || ranges.length !== rebuilt.length) {
    fail('INVALID_PATCH_RANGES', '结构化修改范围目录无效');
  }
  for (let index = 0; index < rebuilt.length; index += 1) {
    const left = ranges[index];
    const right = rebuilt[index];
    if (!left || left.rangeId !== right.rangeId || left.path !== right.path ||
        left.revision !== right.revision || left.start !== right.start ||
        left.end !== right.end || left.content !== right.content) {
      fail('INVALID_PATCH_RANGES', '结构化修改范围目录与权威快照不一致');
    }
  }
  return rebuilt;
}

function structuredProviderOptions(ranges) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > STRUCTURED_MAX_RANGES) {
    fail('INVALID_PATCH_RANGES', '结构化修改范围目录无效');
  }
  const rangeIds = ranges.map(range => range?.rangeId);
  if (rangeIds.some((id, index) => id !== `range_${index + 1}`)) {
    fail('INVALID_PATCH_RANGES', '结构化修改范围编号无效');
  }
  const text = (minLength, maxLength, pattern = SAFE_MULTILINE_TOOL_TEXT_PATTERN) => ({
    type: 'string',
    minLength,
    maxLength,
    pattern,
  });
  return Object.freeze({
    tools: Object.freeze([Object.freeze({
      name: STRUCTURED_TOOL_NAME,
      description: '选择 Main 提供的正文范围并提交有界替换；不得返回路径、原文、偏移或完整文件。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['edits'],
        properties: {
          edits: {
            type: 'array',
            maxItems: STRUCTURED_MAX_PATCH_EDITS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rangeId', 'newText', 'summary'],
              properties: {
                rangeId: { type: 'string', enum: rangeIds },
                newText: text(0, STRUCTURED_MAX_NEW_TEXT_CHARS),
                summary: text(1, STRUCTURED_MAX_SUMMARY_CHARS, SAFE_SUMMARY_TOOL_TEXT_PATTERN),
              },
            },
          },
        },
      },
    })]),
    toolChoice: Object.freeze({ type: 'tool', name: STRUCTURED_TOOL_NAME }),
  });
}

function parseStructuredModelEdits(model, snapshots, ranges) {
  if (model?.stopReason === 'max_tokens') {
    fail('MODEL_OUTPUT_TRUNCATED', '局部修改达到模型输出上限');
  }
  if (!model || model.ok !== true) {
    fail(typeof model?.error === 'string' ? model.error : 'LLM_FAILED', '局部修改生成失败');
  }
  if (model.stopReason !== 'tool_use' || model.toolUseBlockCount !== 1 ||
      !isPlainObject(model.toolUse) || model.toolUse.name !== STRUCTURED_TOOL_NAME ||
      !Object.prototype.hasOwnProperty.call(model.toolUse, 'input')) {
    fail('INVALID_MODEL_OUTPUT', '局部修改必须且只能提交一次结构化结果');
  }
  const input = model.toolUse.input;
  assertExactObject(input, ['edits'], '局部修改');
  let serialized;
  try { serialized = JSON.stringify(input); } catch (_) { serialized = null; }
  if (!serialized || bytes(serialized) > STRUCTURED_MAX_TOOL_INPUT_BYTES) {
    fail('MODEL_OUTPUT_TOO_LARGE', `AI 局部修改输出不能超过 ${STRUCTURED_MAX_TOOL_INPUT_BYTES} 字节`);
  }
  if (!Array.isArray(input.edits)) fail('INVALID_MODEL_OUTPUT', 'edits 必须是数组');
  if (input.edits.length > STRUCTURED_MAX_PATCH_EDITS) {
    fail('TOO_MANY_PATCH_EDITS', `本次最多允许 ${STRUCTURED_MAX_PATCH_EDITS} 个局部修改`);
  }
  const trustedRanges = validateStructuredRangeCatalog(ranges, snapshots);
  const rangeById = new Map(trustedRanges.map(range => [range.rangeId, range]));
  const canonicalEdits = [];
  const seenRanges = new Set();
  let totalNewTextChars = 0;
  for (const [index, raw] of input.edits.entries()) {
    assertExactObject(raw, ['rangeId', 'newText', 'summary'], `edits[${index}]`);
    if (typeof raw.rangeId !== 'string' || !rangeById.has(raw.rangeId)) {
      fail('UNAUTHORIZED_PATCH_RANGE', `edits[${index}] 试图修改未授权正文范围`);
    }
    if (seenRanges.has(raw.rangeId)) {
      fail('DUPLICATE_PATCH_RANGE', `edits[${index}] 重复修改同一正文范围`);
    }
    seenRanges.add(raw.rangeId);
    if (typeof raw.newText !== 'string' || typeof raw.summary !== 'string' ||
        !SAFE_MULTILINE_TOOL_TEXT.test(raw.newText) ||
        !SAFE_SUMMARY_TOOL_TEXT.test(raw.summary) || raw.summary !== raw.summary.trim()) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}] 包含未授权的控制字符或无效 Unicode`);
    }
    const range = rangeById.get(raw.rangeId);
    const newTextChars = Array.from(raw.newText).length;
    totalNewTextChars += newTextChars;
    if (newTextChars > STRUCTURED_MAX_NEW_TEXT_CHARS ||
        totalNewTextChars > STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS) {
      fail('PATCH_NEW_TEXT_TOO_LARGE', '结构化替换文本超过单项或合计上限');
    }
    if (Array.from(raw.summary).length > STRUCTURED_MAX_SUMMARY_CHARS) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}].summary 超过结构化摘要上限`);
    }
    canonicalEdits.push(Object.freeze({
      rangeId: raw.rangeId,
      path: range.path,
      revision: range.revision,
      start: range.start,
      end: range.end,
      newText: raw.newText,
      summary: raw.summary,
    }));
  }
  if (canonicalEdits.length > STRUCTURED_MAX_PATCH_EDITS) {
    fail('TOO_MANY_PATCH_EDITS', `本次最多允许 ${STRUCTURED_MAX_PATCH_EDITS} 个局部修改`);
  }
  return Object.freeze(canonicalEdits);
}

function parseModelEdits(text) {
  if (typeof text !== 'string') fail('INVALID_MODEL_OUTPUT', 'AI 没有返回局部修改 JSON');
  if (bytes(text) > MAX_MODEL_OUTPUT_BYTES) {
    fail('MODEL_OUTPUT_TOO_LARGE', `AI 局部修改输出不能超过 ${MAX_MODEL_OUTPUT_BYTES} 字节`);
  }
  let parsed;
  try {
    // Deliberately reject Markdown fences or prose around the object. Accepting
    // an extracted fragment would turn an allegedly strict protocol into an
    // ambiguous one and make output bounds harder to reason about.
    parsed = JSON.parse(text);
  } catch (_) {
    fail('INVALID_MODEL_OUTPUT', 'AI 返回的局部修改不是严格 JSON');
  }
  assertExactObject(parsed, ['edits'], '局部修改');
  return validateEdits(parsed.edits);
}

function trustedSnapshots(value) {
  if (!Array.isArray(value) || value.length > MAX_PATCH_FILES) {
    fail('INVALID_PATCH_SNAPSHOTS', `局部修改快照最多允许 ${MAX_PATCH_FILES} 个文件`);
  }
  const byPath = new Map();
  for (const snapshot of value) {
    if (!isPlainObject(snapshot) || typeof snapshot.path !== 'string' ||
        typeof snapshot.content !== 'string' || typeof snapshot.revision !== 'string' ||
        byPath.has(snapshot.path)) {
      fail('INVALID_PATCH_SNAPSHOTS', '局部修改快照无效');
    }
    if (!snapshot.path || /\0/.test(snapshot.path) || bytes(snapshot.path) > MAX_PATH_BYTES) {
      fail('PATCH_PATH_TOO_LONG', `局部修改目标路径不能超过 ${MAX_PATH_BYTES} 字节`);
    }
    byPath.set(snapshot.path, snapshot);
  }
  return byPath;
}

function validateAuthorizedSnapshots(value) {
  trustedSnapshots(value);
  return true;
}

function boundedSummary(edits) {
  const unique = [];
  for (const edit of edits) {
    if (!unique.includes(edit.summary)) unique.push(edit.summary);
  }
  let summary = unique.join('；');
  while (summary.length > MAX_SUMMARY_CHARS || bytes(summary) > MAX_SUMMARY_BYTES) {
    summary = `${summary.slice(0, -2)}…`;
  }
  return summary || '局部修改';
}

function editsToProposals(snapshots, edits) {
  const snapshotByPath = trustedSnapshots(snapshots);
  const validatedEdits = validateEdits(edits);
  const editsByPath = new Map();

  for (const [index, edit] of validatedEdits.entries()) {
    const snapshot = snapshotByPath.get(edit.path);
    if (!snapshot) fail('UNAUTHORIZED_PATCH_PATH', `edits[${index}] 试图修改未授权文件`);
    const start = snapshot.content.indexOf(edit.oldText);
    if (start < 0) fail('PATCH_ANCHOR_NOT_FOUND', `edits[${index}] 锚点不在权威快照中`);
    if (snapshot.content.indexOf(edit.oldText, start + 1) >= 0) {
      fail('PATCH_ANCHOR_AMBIGUOUS', `edits[${index}] 锚点在权威快照中不唯一`);
    }
    const ranged = { ...edit, start, end: start + edit.oldText.length };
    if (!editsByPath.has(edit.path)) editsByPath.set(edit.path, []);
    editsByPath.get(edit.path).push(ranged);
  }

  const proposals = [];
  // Snapshot order is authoritative and deterministic regardless of provider
  // ordering. Every range was resolved against that same immutable `before`.
  for (const snapshot of snapshots) {
    const fileEdits = editsByPath.get(snapshot.path);
    if (!fileEdits?.length) continue;
    const ascending = [...fileEdits].sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ascending.length; index += 1) {
      if (ascending[index].start < ascending[index - 1].end) {
        fail('PATCH_OVERLAP', '同一文件的局部修改区间不得重叠');
      }
    }
    let after = snapshot.content;
    for (const edit of [...ascending].reverse()) {
      after = `${after.slice(0, edit.start)}${edit.newText}${after.slice(edit.end)}`;
    }
    if (after === snapshot.content) continue;
    proposals.push({ path: snapshot.path, after, summary: boundedSummary(ascending) });
  }
  return proposals;
}

function assertCompleteModelOutput(stopReason) {
  if (stopReason === 'max_tokens') {
    fail('MODEL_OUTPUT_TRUNCATED', 'AI 局部修改输出被 token 上限截断，未进入 JSON 解析');
  }
  // MiniMax normalizes every provider response to end_turn, max_tokens,
  // tool_use or unknown. Only end_turn is a completed text contract. Keep
  // undefined available for pure unit callers that bypass the provider
  // boundary; production always supplies the normalized value.
  if (stopReason !== undefined && stopReason !== 'end_turn') {
    fail('MODEL_OUTPUT_INCOMPLETE', 'AI 局部修改输出未正常结束，请重新生成');
  }
}

function buildLocalizedChangeSet({ snapshots, modelText, stopReason, changeSetService }) {
  if (!changeSetService || typeof changeSetService.createChangeSet !== 'function') {
    fail('INVALID_PATCH_SERVICE', '局部修改结果处理器不可用');
  }
  assertCompleteModelOutput(stopReason);
  const edits = parseModelEdits(modelText);
  const proposals = editsToProposals(snapshots, edits);
  if (!proposals.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  const changeSet = changeSetService.createChangeSet(snapshots, proposals);
  if (!changeSet.changes.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  return Object.freeze({ noChanges: false, editCount: edits.length, changeSet });
}

function structuredEditsToProposals(snapshots, edits) {
  const snapshotByPath = trustedSnapshots(snapshots);
  const editsByPath = new Map();
  for (const edit of edits) {
    const snapshot = snapshotByPath.get(edit.path);
    if (!snapshot || snapshot.revision !== edit.revision ||
        !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) ||
        edit.start < 0 || edit.end <= edit.start || edit.end > snapshot.content.length) {
      fail('INVALID_PATCH_RANGES', '结构化修改范围不再匹配权威快照');
    }
    if (!editsByPath.has(edit.path)) editsByPath.set(edit.path, []);
    editsByPath.get(edit.path).push(edit);
  }
  const proposals = [];
  for (const snapshot of snapshots) {
    const fileEdits = editsByPath.get(snapshot.path);
    if (!fileEdits?.length) continue;
    const ascending = [...fileEdits].sort((left, right) => left.start - right.start);
    for (let index = 1; index < ascending.length; index += 1) {
      if (ascending[index].start < ascending[index - 1].end) {
        fail('PATCH_OVERLAP', '结构化正文范围不得重叠');
      }
    }
    let after = snapshot.content;
    for (const edit of [...ascending].reverse()) {
      after = `${after.slice(0, edit.start)}${edit.newText}${after.slice(edit.end)}`;
    }
    if (after !== snapshot.content) {
      proposals.push({ path: snapshot.path, after, summary: boundedSummary(ascending) });
    }
  }
  return proposals;
}

function buildStructuredLocalizedChangeSet({ snapshots, ranges, model, changeSetService }) {
  if (!changeSetService || typeof changeSetService.createChangeSet !== 'function') {
    fail('INVALID_PATCH_SERVICE', '局部修改结果处理器不可用');
  }
  const edits = parseStructuredModelEdits(model, snapshots, ranges);
  const proposals = structuredEditsToProposals(snapshots, edits);
  if (!proposals.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  const changeSet = changeSetService.createChangeSet(snapshots, proposals);
  if (!changeSet.changes.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  return Object.freeze({ noChanges: false, editCount: edits.length, changeSet });
}

function protocolPromptLines(options = {}) {
  if (options.structured === true) {
    return [
      `必须且只能调用 ${STRUCTURED_TOOL_NAME} 一次；不要在文本中输出 JSON、Diff 或完整文件。`,
      `最多 ${STRUCTURED_MAX_PATCH_EDITS} 个范围替换；每项 newText 最多 ${STRUCTURED_MAX_NEW_TEXT_CHARS} 字，全部 newText 合计最多 ${STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS} 字，summary 最多 ${STRUCTURED_MAX_SUMMARY_CHARS} 字。`,
      '只能选择下方与工具 schema 同源列出的 rangeId；Main 会恢复权威路径、revision、原文和偏移。不得返回这些字段。',
      'newText 必须是该范围替换后的完整内容；删除整个范围时使用空 newText。不得选择同一 rangeId 两次。',
      '未修改任何内容时提交空 edits 数组。',
    ];
  }
  return [
    '只返回严格 JSON（不得使用 Markdown 代码围栏或额外说明）：{"edits":[{"path":"...","oldText":"当前文件中唯一的原文锚点","newText":"局部替换文本","summary":"修改摘要"}]}',
    `最多 ${MAX_PATCH_EDITS} 个 edits；path 不超过 ${MAX_PATH_BYTES} 字节；oldText 必须非空、在对应文件原始快照中只出现一次且不超过 ${MAX_OLD_TEXT_BYTES} 字节；newText 不超过 ${MAX_NEW_TEXT_BYTES} 字节。`,
    `summary 必须是非空摘要，不超过 ${MAX_SUMMARY_CHARS} 个字符且不超过 ${MAX_SUMMARY_BYTES} 字节。`,
    `完整 JSON 输出不超过 ${MAX_MODEL_OUTPUT_BYTES} 字节；所有 edit 的 path、oldText、newText、summary 合计不超过 ${MAX_TOTAL_EDIT_BYTES} 字节。`,
    '同文件的多个 edits 都以下方同一份原始快照为准，oldText 区间不得重叠；删除时使用空 newText。',
    '插入时也必须选择唯一原文作为 oldText，并在 newText 中保留该锚点后加入新文本。不得返回完整 after 文件。',
    '未修改任何内容时返回 {"edits":[]}。',
  ];
}

function isRetryableStructuredOutputError(error) {
  return error instanceof LocalizedEditError && STRUCTURED_RETRYABLE_CODES.has(error.code);
}

function structuredProviderResultError(model) {
  if (model?.ok === false && model.error === 'INVALID_TOOL_USE') {
    return new LocalizedEditError(
      'INVALID_TOOL_USE',
      'AI 没有提交唯一有效的结构化修改工具调用'
    );
  }
  return null;
}

function structuredRetryMessages(messages, error) {
  if (!Array.isArray(messages) || !isRetryableStructuredOutputError(error)) {
    fail('INVALID_STRUCTURE_RETRY', '结构化结果纠正请求无效');
  }
  const correction = [
    '上一份工具参数没有通过 Main 的安全结构校验；不要复述、引用或猜测上一份结果。',
    `失败类别：${error.code}。请重新阅读原始请求，并且只调用 ${STRUCTURED_TOOL_NAME} 一次。`,
    `只能使用列出的 rangeId；最多 ${STRUCTURED_MAX_PATCH_EDITS} 项；每项 newText 最多 ${STRUCTURED_MAX_NEW_TEXT_CHARS} 字，合计最多 ${STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS} 字；summary 最多 ${STRUCTURED_MAX_SUMMARY_CHARS} 字。`,
    '如果无法在这些范围内完成，请提交空 edits；不要输出文本、JSON、路径、原文、偏移或完整文件。',
  ].join('\n');
  return Object.freeze([
    ...messages,
    Object.freeze({ role: 'user', content: correction }),
  ]);
}

module.exports = {
  MAX_MODEL_OUTPUT_BYTES,
  MAX_PATCH_EDITS,
  MAX_PATCH_FILES,
  MAX_PATH_BYTES,
  MAX_OLD_TEXT_BYTES,
  MAX_NEW_TEXT_BYTES,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_BYTES,
  MAX_TOTAL_EDIT_BYTES,
  STRUCTURED_TOOL_NAME,
  STRUCTURED_MAX_PATCH_EDITS,
  STRUCTURED_MAX_RANGES,
  STRUCTURED_MAX_RANGE_BYTES,
  STRUCTURED_MAX_NEW_TEXT_CHARS,
  STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS,
  STRUCTURED_MAX_SUMMARY_CHARS,
  STRUCTURED_MAX_TOOL_INPUT_BYTES,
  STRUCTURED_MAX_TOKENS,
  LocalizedEditError,
  validateEdits,
  parseModelEdits,
  validateAuthorizedSnapshots,
  editsToProposals,
  assertCompleteModelOutput,
  buildLocalizedChangeSet,
  buildStructuredRangeCatalog,
  validateStructuredRangeCatalog,
  structuredProviderOptions,
  parseStructuredModelEdits,
  structuredEditsToProposals,
  buildStructuredLocalizedChangeSet,
  protocolPromptLines,
  isRetryableStructuredOutputError,
  structuredProviderResultError,
  structuredRetryMessages,
};
