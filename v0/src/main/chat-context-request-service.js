'use strict';

const REQUEST_SCHEMA = 'writcraft.chat-context/v1';
const SCOPES = Object.freeze(['project', 'file', 'selection']);
const SCOPE_SET = new Set(SCOPES);
const REQUEST_KEYS = Object.freeze(['schema', 'scope', 'message', 'currentFilePath', 'selection', 'contextPolicy']);
const MAX_MESSAGE_CHARS = 4000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_SELECTION_CHARS = 3000;
const MAX_SELECTION_BYTES = 9 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_EXCLUDED_IDS = 128;
const MAX_ID_BYTES = 512;
const MAX_REQUEST_BYTES = 96 * 1024;

function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch (_) { return Number.POSITIVE_INFINITY; }
}

function invalid(message, error = 'INVALID_CONTEXT_REQUEST') {
  return { ok: false, error, message };
}

function validate(request) {
  if (!exactObject(request, REQUEST_KEYS) || request.schema !== REQUEST_SCHEMA || serializedBytes(request) > MAX_REQUEST_BYTES) {
    return invalid('上下文请求格式无效');
  }
  if (!SCOPE_SET.has(request.scope)) return invalid('上下文作用域无效');
  if (typeof request.message !== 'string' || Array.from(request.message).length > MAX_MESSAGE_CHARS || utf8Bytes(request.message) > MAX_MESSAGE_BYTES) {
    return invalid('上下文问题不能超过 4000 个字符或 16 KiB', 'CONTEXT_TOO_LARGE');
  }
  if (typeof request.currentFilePath !== 'string' || !request.currentFilePath || utf8Bytes(request.currentFilePath) > MAX_PATH_BYTES) {
    return invalid('当前文件路径无效');
  }
  if (request.scope === 'selection') {
    const selection = request.selection;
    if (!exactObject(selection, ['filePath', 'text', 'startOffset', 'endOffset']) ||
        typeof selection.filePath !== 'string' || utf8Bytes(selection.filePath) > MAX_PATH_BYTES ||
        typeof selection.text !== 'string' || !selection.text.trim() || selection.text.length > MAX_SELECTION_CHARS ||
        utf8Bytes(selection.text) > MAX_SELECTION_BYTES ||
        !Number.isSafeInteger(selection.startOffset) || !Number.isSafeInteger(selection.endOffset) ||
        selection.startOffset < 0 || selection.endOffset <= selection.startOffset ||
        selection.endOffset - selection.startOffset !== selection.text.length) {
      return invalid('选段上下文格式无效或超过限制');
    }
    if (selection.filePath !== request.currentFilePath) return invalid('选段文件必须与当前文件一致');
  } else if (request.selection !== null) {
    return invalid('非选区作用域不得提交选段');
  }
  const policy = request.contextPolicy;
  if (!exactObject(policy, ['excludedChipIds']) || !Array.isArray(policy.excludedChipIds) ||
      policy.excludedChipIds.length > MAX_EXCLUDED_IDS ||
      policy.excludedChipIds.some(id => typeof id !== 'string' || !id || utf8Bytes(id) > MAX_ID_BYTES)) {
    return invalid('上下文排除列表格式无效或超过限制');
  }
  return { ok: true };
}

module.exports = Object.freeze({
  REQUEST_SCHEMA,
  SCOPES,
  REQUEST_KEYS,
  MAX_REQUEST_BYTES,
  validate,
});
