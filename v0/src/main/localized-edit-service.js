'use strict';

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
// Eight edits can cover a chapter's common 8-heading structure while the
// smaller per-item limits keep the complete tool input below the existing
// 24 KiB parser boundary. Model output contains only short request-local
// target IDs plus bounded Unicode fields; Main restores canonical paths.
const STRUCTURED_MAX_PATCH_EDITS = 8;
const STRUCTURED_MAX_OLD_TEXT_CHARS = 128;
const STRUCTURED_MAX_NEW_TEXT_CHARS = 256;
const STRUCTURED_MAX_SUMMARY_CHARS = 40;
const SAFE_MULTILINE_TOOL_TEXT_PATTERN = '^(?:[\\t\\n\\r]|[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$';
const SAFE_SUMMARY_TOOL_TEXT_PATTERN = '^(?!\\s)(?![\\s\\S]*\\s$)(?:[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
const SAFE_MULTILINE_TOOL_TEXT = /^(?:[\t\n\r]|[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u;
const SAFE_SUMMARY_TOOL_TEXT = /^(?:[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/u;

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

function structuredProviderOptions(snapshots) {
  const snapshotByPath = trustedSnapshots(snapshots);
  if (!snapshotByPath.size) fail('INVALID_PATCH_SNAPSHOTS', '结构化局部修改至少需要一个目标文件');
  if (snapshotByPath.size > STRUCTURED_MAX_PATCH_EDITS) {
    fail('INVALID_PATCH_SNAPSHOTS', `结构化局部修改最多允许 ${STRUCTURED_MAX_PATCH_EDITS} 个目标文件`);
  }
  const targetIds = [...snapshotByPath.keys()].map((_, index) => `target_${index + 1}`);
  const text = (minLength, maxLength, pattern = SAFE_MULTILINE_TOOL_TEXT_PATTERN) => ({
    type: 'string',
    minLength,
    maxLength,
    pattern,
  });
  return Object.freeze({
    tools: Object.freeze([Object.freeze({
      name: STRUCTURED_TOOL_NAME,
      description: '提交最多八个有界的局部文本替换；不得返回完整文件。',
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
              required: ['targetId', 'oldText', 'newText', 'summary'],
              properties: {
                targetId: { type: 'string', enum: targetIds },
                oldText: text(1, STRUCTURED_MAX_OLD_TEXT_CHARS),
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

function parseStructuredModelEdits(model, snapshots) {
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
  if (!serialized || bytes(serialized) > MAX_MODEL_OUTPUT_BYTES) {
    fail('MODEL_OUTPUT_TOO_LARGE', `AI 局部修改输出不能超过 ${MAX_MODEL_OUTPUT_BYTES} 字节`);
  }
  if (!Array.isArray(input.edits)) fail('INVALID_MODEL_OUTPUT', 'edits 必须是数组');
  const snapshotByPath = trustedSnapshots(snapshots);
  if (!snapshotByPath.size || snapshotByPath.size > STRUCTURED_MAX_PATCH_EDITS) {
    fail('INVALID_PATCH_SNAPSHOTS', '结构化局部修改目标快照无效');
  }
  const pathByTargetId = new Map(
    [...snapshotByPath.keys()].map((filePath, index) => [`target_${index + 1}`, filePath])
  );
  const canonicalEdits = [];
  for (const [index, raw] of input.edits.entries()) {
    assertExactObject(raw, ['targetId', 'oldText', 'newText', 'summary'], `edits[${index}]`);
    if (typeof raw.targetId !== 'string' || !pathByTargetId.has(raw.targetId)) {
      fail('UNAUTHORIZED_PATCH_PATH', `edits[${index}] 试图修改未授权文件`);
    }
    if (typeof raw.oldText !== 'string' ||
        typeof raw.newText !== 'string' || typeof raw.summary !== 'string' ||
        !SAFE_MULTILINE_TOOL_TEXT.test(raw.oldText) ||
        !SAFE_MULTILINE_TOOL_TEXT.test(raw.newText) ||
        !SAFE_SUMMARY_TOOL_TEXT.test(raw.summary) || raw.summary !== raw.summary.trim()) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}] 包含未授权的控制字符或无效 Unicode`);
    }
    canonicalEdits.push({
      path: pathByTargetId.get(raw.targetId),
      oldText: raw.oldText,
      newText: raw.newText,
      summary: raw.summary,
    });
  }
  const edits = validateEdits(canonicalEdits);
  if (edits.length > STRUCTURED_MAX_PATCH_EDITS) {
    fail('TOO_MANY_PATCH_EDITS', `本次最多允许 ${STRUCTURED_MAX_PATCH_EDITS} 个局部修改`);
  }
  for (const [index, edit] of edits.entries()) {
    if (Array.from(edit.oldText).length > STRUCTURED_MAX_OLD_TEXT_CHARS) {
      fail('PATCH_OLD_TEXT_INVALID', `edits[${index}].oldText 超过结构化局部锚点上限`);
    }
    if (Array.from(edit.newText).length > STRUCTURED_MAX_NEW_TEXT_CHARS) {
      fail('PATCH_NEW_TEXT_TOO_LARGE', `edits[${index}].newText 超过结构化局部替换上限`);
    }
    if (Array.from(edit.summary).length > STRUCTURED_MAX_SUMMARY_CHARS) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}].summary 超过结构化摘要上限`);
    }
  }
  return edits;
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

function buildStructuredLocalizedChangeSet({ snapshots, model, changeSetService }) {
  if (!changeSetService || typeof changeSetService.createChangeSet !== 'function') {
    fail('INVALID_PATCH_SERVICE', '局部修改结果处理器不可用');
  }
  const edits = parseStructuredModelEdits(model, snapshots);
  const proposals = editsToProposals(snapshots, edits);
  if (!proposals.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  const changeSet = changeSetService.createChangeSet(snapshots, proposals);
  if (!changeSet.changes.length) return Object.freeze({ noChanges: true, editCount: edits.length });
  return Object.freeze({ noChanges: false, editCount: edits.length, changeSet });
}

function protocolPromptLines(options = {}) {
  if (options.structured === true) {
    return [
      `必须且只能调用 ${STRUCTURED_TOOL_NAME} 一次；不要在文本中输出 JSON、Diff 或完整文件。`,
      `最多 ${STRUCTURED_MAX_PATCH_EDITS} 个局部替换；oldText 最多 ${STRUCTURED_MAX_OLD_TEXT_CHARS} 字，newText 最多 ${STRUCTURED_MAX_NEW_TEXT_CHARS} 字，summary 最多 ${STRUCTURED_MAX_SUMMARY_CHARS} 字。`,
      '只能选择工具 schema 列出的 targetId；Main 会把它恢复为权威路径。oldText 必须是对应原文中唯一的有界锚点。',
      '插入时也必须在 newText 中保留 oldText 锚点；删除时使用空 newText。',
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
  STRUCTURED_MAX_OLD_TEXT_CHARS,
  STRUCTURED_MAX_NEW_TEXT_CHARS,
  STRUCTURED_MAX_SUMMARY_CHARS,
  LocalizedEditError,
  validateEdits,
  parseModelEdits,
  validateAuthorizedSnapshots,
  editsToProposals,
  assertCompleteModelOutput,
  buildLocalizedChangeSet,
  structuredProviderOptions,
  parseStructuredModelEdits,
  buildStructuredLocalizedChangeSet,
  protocolPromptLines,
};
