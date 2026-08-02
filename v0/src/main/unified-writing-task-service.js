'use strict';

const localizedEditService = require('./localized-edit-service');

const TOOL_NAME = 'submit_unified_writing_task';
const MAX_EDITS = 3;
const MAX_RECOVERY_CHARS = 160;
const MAX_TOOL_INPUT_BYTES = 20 * 1024;
const SAFE_TEXT_PATTERN = '^(?!\\s)(?![\\s\\S]*\\s$)(?:[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
const SAFE_TEXT = /^(?:[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/u;
const SAFE_MULTILINE = /^(?:[\t\n\r]|[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u;
const parsedChangesAuthority = new WeakMap();

class UnifiedWritingTaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UnifiedWritingTaskError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UnifiedWritingTaskError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail('INVALID_MODEL_OUTPUT', `${label}必须是普通对象`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_MODEL_OUTPUT', `${label}包含未授权或缺失字段`);
  }
}

function safeRecoveryText(value, label, allowEmpty) {
  if (typeof value !== 'string' || (!allowEmpty && !value) ||
      value !== value.trim() || (value && !SAFE_TEXT.test(value)) ||
      Array.from(value).length > MAX_RECOVERY_CHARS) {
    fail('INVALID_MODEL_OUTPUT', `${label}必须是有界安全文本`);
  }
  return value;
}

function providerOptions(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) {
    fail('INVALID_PATCH_RANGES', '统一任务缺少可修改正文范围');
  }
  const rangeIds = ranges.map((range, index) => {
    if (range?.rangeId !== `range_${index + 1}`) {
      fail('INVALID_PATCH_RANGES', '统一任务正文范围编号无效');
    }
    return range.rangeId;
  });
  const multiline = {
    type: 'string',
    minLength: 0,
    maxLength: localizedEditService.STRUCTURED_MAX_NEW_TEXT_CHARS,
    pattern: '^(?:[\\t\\n\\r]|[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
  };
  const summary = {
    type: 'string',
    minLength: 1,
    maxLength: localizedEditService.STRUCTURED_MAX_SUMMARY_CHARS,
    pattern: SAFE_TEXT_PATTERN,
  };
  const recovery = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_RECOVERY_CHARS,
    pattern: SAFE_TEXT_PATTERN,
  };
  const edit = {
    type: 'object',
    additionalProperties: false,
    required: ['rangeId', 'newText', 'summary'],
    properties: {
      rangeId: { type: 'string', enum: rangeIds },
      newText: multiline,
      summary,
    },
  };
  const branch = (status, edits, reason, question) => ({
    type: 'object',
    additionalProperties: false,
    required: ['status', 'edits', 'reason', 'question'],
    properties: {
      status: { const: status },
      edits,
      reason,
      question,
    },
  });
  return Object.freeze({
    tools: Object.freeze([Object.freeze({
      name: TOOL_NAME,
      description: '选择 Main 提供的证据范围并提交 1–3 个有界替换，或明确说明缺少来源；不得返回路径、原文、revision、偏移或完整文件。',
      input_schema: {
        oneOf: [
          branch(
            'changes',
            { type: 'array', minItems: 1, maxItems: MAX_EDITS, items: edit },
            { const: '' },
            { const: '' }
          ),
          branch(
            'needs_sources',
            { type: 'array', maxItems: 0, items: edit },
            recovery,
            recovery
          ),
        ],
      },
    })]),
    toolChoice: Object.freeze({ type: 'tool', name: TOOL_NAME }),
  });
}

function protocolPromptLines() {
  return [
    `必须且只能调用 ${TOOL_NAME} 一次；不要在文本中输出 JSON、Diff 或完整文件。`,
    `能够依据现有材料修改时，status 必须为 changes，提交 1–${MAX_EDITS} 个 edits，并让 reason 与 question 都为空字符串。`,
    '只有完成建议确实依赖当前没有提供的事实、数据或引用时，status 才能为 needs_sources；此时 edits 必须为空，并用 reason 说明缺口、用 question 提出一个聚焦的补充问题。',
    `只能使用列出的 rangeId；newText 只返回该证据范围的替换文本，最多 ${localizedEditService.STRUCTURED_MAX_NEW_TEXT_CHARS} 字，全部 newText 合计最多 ${localizedEditService.STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS} 字。`,
    `每项 summary 最多 ${localizedEditService.STRUCTURED_MAX_SUMMARY_CHARS} 字。Main 会从 rangeId 恢复权威原文、路径、revision 和精确偏移；不得返回这些字段、原文、完整文件，也不得把“希望查看更多内容”冒充必需来源缺口。`,
  ];
}

function canonicalLocalizedEdits(input, snapshots, ranges) {
  const trustedRanges = localizedEditService.validateSelectedStructuredRangeCatalog(ranges, snapshots);
  const rangeById = new Map(trustedRanges.map(range => [range.rangeId, range]));
  const edits = [];
  const seenRanges = new Set();
  let totalNewTextChars = 0;
  for (const [index, raw] of input.edits.entries()) {
    exactKeys(raw, ['rangeId', 'newText', 'summary'], `edits[${index}]`);
    if (typeof raw.rangeId !== 'string' || !rangeById.has(raw.rangeId)) {
      fail('UNAUTHORIZED_PATCH_RANGE', `edits[${index}] 试图修改未授权正文范围`);
    }
    if (seenRanges.has(raw.rangeId)) {
      fail('DUPLICATE_PATCH_RANGE', `edits[${index}] 重复修改同一正文范围`);
    }
    seenRanges.add(raw.rangeId);
    if (typeof raw.newText !== 'string' || typeof raw.summary !== 'string' ||
        !SAFE_MULTILINE.test(raw.newText) ||
        !SAFE_TEXT.test(raw.summary) || raw.summary !== raw.summary.trim()) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}] 包含无效局部文本`);
    }
    const newTextChars = Array.from(raw.newText).length;
    totalNewTextChars += newTextChars;
    if (newTextChars > localizedEditService.STRUCTURED_MAX_NEW_TEXT_CHARS ||
        totalNewTextChars > localizedEditService.STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS ||
        Buffer.byteLength(raw.newText, 'utf8') > localizedEditService.MAX_NEW_TEXT_BYTES) {
      fail('PATCH_NEW_TEXT_TOO_LARGE', `edits[${index}].newText 超过局部替换上限`);
    }
    if (Array.from(raw.summary).length > localizedEditService.STRUCTURED_MAX_SUMMARY_CHARS) {
      fail('INVALID_MODEL_OUTPUT', `edits[${index}].summary 超过上限`);
    }
    const range = rangeById.get(raw.rangeId);
    edits.push(Object.freeze({
      path: range.path,
      revision: range.revision,
      start: range.start,
      end: range.end,
      oldText: range.content,
      newText: raw.newText,
      summary: raw.summary,
    }));
  }
  const ordered = [...edits].sort((left, right) =>
    left.path.localeCompare(right.path) || left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.path === previous.path && current.start < previous.end) {
      fail('PATCH_OVERLAP', '统一任务局部修改不得重叠');
    }
  }
  return Object.freeze(edits);
}

function parseResult(model, snapshots, ranges) {
  if (model?.stopReason === 'max_tokens') {
    fail('MODEL_OUTPUT_TRUNCATED', '统一任务达到模型输出上限');
  }
  if (!model || model.ok !== true) {
    fail(typeof model?.error === 'string' ? model.error : 'LLM_FAILED', '统一任务生成失败');
  }
  if (model.stopReason !== 'tool_use' || model.toolUseBlockCount !== 1 ||
      !isPlainObject(model.toolUse) || model.toolUse.name !== TOOL_NAME ||
      !Object.prototype.hasOwnProperty.call(model.toolUse, 'input')) {
    fail('INVALID_MODEL_OUTPUT', '统一任务必须且只能提交一次结构化结果');
  }
  const input = model.toolUse.input;
  exactKeys(input, ['status', 'edits', 'reason', 'question'], '统一任务结果');
  let serialized;
  try { serialized = JSON.stringify(input); } catch (_) { serialized = null; }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_INPUT_BYTES) {
    fail('MODEL_OUTPUT_TOO_LARGE', '统一任务结果超过安全范围');
  }
  if (!Array.isArray(input.edits) || input.edits.length > MAX_EDITS) {
    fail('TOO_MANY_PATCH_EDITS', `统一任务最多允许 ${MAX_EDITS} 个局部修改`);
  }
  if (input.status === 'needs_sources') {
    if (input.edits.length) fail('INVALID_MODEL_OUTPUT', '来源不足结果不得携带修改');
    const reason = safeRecoveryText(input.reason, '来源缺口说明', false);
    const question = safeRecoveryText(input.question, '来源补充问题', false);
    return Object.freeze({ kind: 'needs_sources', reason, question });
  }
  if (input.status !== 'changes' || input.edits.length < 1) {
    fail('INVALID_MODEL_OUTPUT', '修改结果必须包含 1–3 个局部修改');
  }
  safeRecoveryText(input.reason, '修改分支 reason', true);
  safeRecoveryText(input.question, '修改分支 question', true);
  if (input.reason || input.question) {
    fail('INVALID_MODEL_OUTPUT', '修改结果不得同时请求补充来源');
  }
  const edits = canonicalLocalizedEdits(input, snapshots, ranges);
  const parsed = Object.freeze({ kind: 'changes', edits });
  parsedChangesAuthority.set(parsed, {
    snapshots,
    ranges,
    consumed: false,
  });
  return parsed;
}

function buildChangeSet({ snapshots, ranges, parsed, changeSetService }) {
  if (!changeSetService || typeof changeSetService.createChangeSet !== 'function') {
    fail('INVALID_PATCH_SERVICE', '统一任务修改结果处理器不可用');
  }
  const authority = parsedChangesAuthority.get(parsed);
  if (!authority || authority.consumed || parsed.kind !== 'changes') {
    fail('INVALID_MODEL_OUTPUT', '统一任务修改结果缺少本次解析权限');
  }
  authority.consumed = true;
  if (authority.snapshots !== snapshots || authority.ranges !== ranges) {
    fail('INVALID_MODEL_OUTPUT', '统一任务修改结果不属于本次请求');
  }
  const edits = parsed.edits;
  localizedEditService.validateAuthorizedSnapshots(snapshots);
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS) {
    fail('INVALID_MODEL_OUTPUT', '统一任务局部修改数量无效');
  }
  const snapshotByPath = new Map(snapshots.map(snapshot => [snapshot.path, snapshot]));
  let totalNewTextChars = 0;
  const trustedEdits = edits.map((edit, index) => {
    exactKeys(edit, ['path', 'revision', 'start', 'end', 'oldText', 'newText', 'summary'], `edits[${index}]`);
    const snapshot = snapshotByPath.get(edit.path);
    if (!snapshot || snapshot.revision !== edit.revision ||
        !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) ||
        edit.start < 0 || edit.end <= edit.start || edit.end > snapshot.content.length ||
        typeof edit.oldText !== 'string' || snapshot.content.slice(edit.start, edit.end) !== edit.oldText) {
      fail('INVALID_PATCH_RANGES', '统一任务局部锚点不再匹配权威快照');
    }
    if (!edit.oldText || typeof edit.newText !== 'string' || typeof edit.summary !== 'string' ||
        !SAFE_MULTILINE.test(edit.oldText) || !SAFE_MULTILINE.test(edit.newText) ||
        !SAFE_TEXT.test(edit.summary) || edit.summary !== edit.summary.trim() ||
        Array.from(edit.summary).length > localizedEditService.STRUCTURED_MAX_SUMMARY_CHARS) {
      fail('INVALID_MODEL_OUTPUT', '统一任务局部修改字段无效');
    }
    const newTextChars = Array.from(edit.newText).length;
    totalNewTextChars += newTextChars;
    if (newTextChars > localizedEditService.STRUCTURED_MAX_NEW_TEXT_CHARS ||
        totalNewTextChars > localizedEditService.STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS ||
        Buffer.byteLength(edit.newText, 'utf8') > localizedEditService.MAX_NEW_TEXT_BYTES) {
      fail('PATCH_NEW_TEXT_TOO_LARGE', '统一任务局部替换超过上限');
    }
    return Object.freeze({
      path: edit.path,
      revision: edit.revision,
      start: edit.start,
      end: edit.end,
      newText: edit.newText,
      summary: edit.summary,
    });
  });
  const proposals = localizedEditService.structuredEditsToProposals(snapshots, trustedEdits);
  if (!proposals.length) return Object.freeze({ noChanges: true, editCount: edits.length, fileCount: 0 });
  const changeSet = changeSetService.createChangeSet(snapshots, proposals);
  if (!changeSet.changes.length) return Object.freeze({ noChanges: true, editCount: edits.length, fileCount: 0 });
  return Object.freeze({
    noChanges: false,
    editCount: edits.length,
    fileCount: changeSet.changes.length,
    changeSet,
  });
}

module.exports = Object.freeze({
  TOOL_NAME,
  MAX_EDITS,
  MAX_RECOVERY_CHARS,
  MAX_TOOL_INPUT_BYTES,
  UnifiedWritingTaskError,
  providerOptions,
  protocolPromptLines,
  parseResult,
  buildChangeSet,
});
