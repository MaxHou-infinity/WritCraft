'use strict';

const localizedEditService = require('./localized-edit-service');

const TOOL_NAME = 'submit_unified_writing_task';
const MAX_EDITS = 3;
const MAX_RECOVERY_CHARS = 160;
const MAX_TOOL_INPUT_BYTES = 8 * 1024;
const SAFE_TEXT_PATTERN = '^(?!\\s)(?![\\s\\S]*\\s$)(?:[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$';
const SAFE_TEXT = /^(?:[^\u0000-\u001f\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/u;

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
    minLength: 0,
    maxLength: MAX_RECOVERY_CHARS,
    pattern: '^(?:[^\\u0000-\\u001f\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])*$',
  };
  return Object.freeze({
    tools: Object.freeze([Object.freeze({
      name: TOOL_NAME,
      description: '要么提交 1–3 个有界局部修改，要么明确说明缺少来源；不得返回路径、原文、偏移或完整文件。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'edits', 'reason', 'question'],
        properties: {
          status: { type: 'string', enum: ['changes', 'needs_sources'] },
          edits: {
            type: 'array',
            maxItems: MAX_EDITS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rangeId', 'newText', 'summary'],
              properties: {
                rangeId: { type: 'string', enum: rangeIds },
                newText: multiline,
                summary,
              },
            },
          },
          reason: recovery,
          question: recovery,
        },
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
    `只能使用列出的 rangeId；每项 newText 最多 ${localizedEditService.STRUCTURED_MAX_NEW_TEXT_CHARS} 字，全部 newText 合计最多 ${localizedEditService.STRUCTURED_MAX_TOTAL_NEW_TEXT_CHARS} 字，summary 最多 ${localizedEditService.STRUCTURED_MAX_SUMMARY_CHARS} 字。`,
    'Main 会恢复权威路径、revision、原文和偏移。不得返回这些字段，也不得把“希望查看更多内容”冒充必需来源缺口。',
  ];
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
  const localizedModel = Object.freeze({
    ...model,
    toolUse: Object.freeze({
      ...model.toolUse,
      name: localizedEditService.STRUCTURED_TOOL_NAME,
      input: Object.freeze({ edits: input.edits }),
    }),
  });
  localizedEditService.parseStructuredModelEdits(localizedModel, snapshots, ranges);
  return Object.freeze({ kind: 'changes', model: localizedModel });
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
});
