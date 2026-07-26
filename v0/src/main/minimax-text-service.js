'use strict';

const BASE_URL = 'https://api.minimaxi.com/anthropic/v1';
const MODELS_ENDPOINT = `${BASE_URL}/models`;
const MESSAGES_ENDPOINT = `${BASE_URL}/messages`;
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 8_192;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_MODELS = 256;
const KEY_RE = /^sk-(cp|api)-[A-Za-z0-9_-]{8,240}$/i;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_ROLES = new Set(['user', 'assistant']);
const ALLOWED_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'tool_use']);
const UNKNOWN_STOP_REASON = 'unknown';
const USAGE_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
]);

function failure(error) {
  return { ok: false, error };
}

function validateApiKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  const match = key.match(KEY_RE);
  if (!match) return null;
  return { key, kind: match[1].toLocaleLowerCase('en-US') };
}

function authHeaders(apiKey, includeJson = false) {
  const validated = validateApiKey(apiKey);
  if (!validated) return null;
  const headers = {
    'anthropic-version': ANTHROPIC_VERSION,
  };
  // MiniMax Token Plan (sk-cp) documents the Anthropic auth-token/Bearer
  // route, while pay-as-you-go Anthropic calls use the standard x-api-key.
  if (validated.kind === 'cp') headers.Authorization = `Bearer ${validated.key}`;
  else headers['x-api-key'] = validated.key;
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 512) return null;
  const output = [];
  for (const message of value) {
    if (!message || Object.getPrototypeOf(message) !== Object.prototype) return null;
    if (!ALLOWED_ROLES.has(message.role) || typeof message.content !== 'string') return null;
    if (Object.keys(message).some(key => key !== 'role' && key !== 'content')) return null;
    if (!message.content || /\u0000/.test(message.content)) return null;
    output.push({ role: message.role, content: message.content });
  }
  return output;
}

function timeoutValue(value) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { code: 'TEXT_TIMEOUT' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { code: 'TEXT_TIMEOUT' }));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

async function readBoundedJson(response, signal) {
  if (!response || typeof response !== 'object') throw Object.assign(new Error('invalid response'), { code: 'INVALID_RESPONSE' });
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw Object.assign(new Error('invalid content type'), { code: 'INVALID_RESPONSE' });
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('oversized response'), { code: 'RESPONSE_TOO_LARGE' });
  }

  let bytes;
  try {
    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (!part || part.done) break;
        const chunk = Buffer.from(part.value);
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          throw Object.assign(new Error('oversized response'), { code: 'RESPONSE_TOO_LARGE' });
        }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, length);
    } else if (typeof response.text === 'function') {
      const text = await abortable(response.text(), signal);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw Object.assign(new Error('oversized response'), { code: 'RESPONSE_TOO_LARGE' });
      }
      bytes = Buffer.from(text, 'utf8');
    } else {
      throw Object.assign(new Error('unreadable response'), { code: 'INVALID_RESPONSE' });
    }
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error('unreadable response'), { code: 'INVALID_RESPONSE' });
  }

  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    throw Object.assign(new Error('invalid json'), { code: 'INVALID_RESPONSE' });
  }
}

function httpError(status) {
  const code = Number(status);
  if (code === 401 || code === 403) return 'AUTH_FAILED';
  if (code === 408 || code === 429) return 'RATE_LIMITED';
  if (code >= 500 && code <= 599) return 'SERVICE_UNAVAILABLE';
  return 'API_FAILED';
}

async function requestJson({ endpoint, method, headers, body, fetchImpl, timeoutMs, signal: externalSignal }) {
  const request = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof request !== 'function') return failure('SERVICE_UNAVAILABLE');
  if (externalSignal?.aborted) return failure('REQUEST_ABORTED');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutValue(timeoutMs));
  const abortFromOwner = () => controller.abort();
  externalSignal?.addEventListener?.('abort', abortFromOwner, { once: true });
  let response;
  try {
    response = await abortable(request(endpoint, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    }), controller.signal);
    const payload = await readBoundedJson(response, controller.signal);
    if (!response.ok) return failure(httpError(response.status));
    return { ok: true, payload };
  } catch (error) {
    if (controller.signal.aborted || error?.code === 'TEXT_TIMEOUT') {
      try { await response?.body?.cancel?.(); } catch (_) {}
      return failure(timedOut ? 'TIMEOUT' : 'REQUEST_ABORTED');
    }
    if (error?.code === 'RESPONSE_TOO_LARGE') return failure('RESPONSE_TOO_LARGE');
    if (error?.code === 'INVALID_RESPONSE') return failure('INVALID_RESPONSE');
    return failure('REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', abortFromOwner);
  }
}

async function checkModels(options = {}) {
  const headers = authHeaders(options.apiKey);
  if (!headers) return failure('NO_KEY');
  const result = await requestJson({
    endpoint: MODELS_ENDPOINT,
    method: 'GET',
    headers,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!result.ok) return result;
  const list = result.payload?.data;
  if (!Array.isArray(list) || list.length > MAX_MODELS) return failure('INVALID_RESPONSE');
  const models = [];
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !MODEL_RE.test(item.id)) return failure('INVALID_RESPONSE');
    models.push(item.id);
  }
  return { ok: true, models, base: BASE_URL };
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const usage = {};
  for (const field of USAGE_FIELDS) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) usage[field] = value[field];
  }
  return usage;
}

function safeStopReason(value) {
  return typeof value === 'string' && ALLOWED_STOP_REASONS.has(value)
    ? value
    : UNKNOWN_STOP_REASON;
}

async function callMessages(options = {}) {
  const headers = authHeaders(options.apiKey, true);
  if (!headers) return failure('NO_KEY');
  const messages = validateMessages(options.messages);
  if (!messages) return failure('INVALID_MESSAGES');
  const model = options.model === undefined ? DEFAULT_MODEL : options.model;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return failure('INVALID_MODEL');
  const maxTokens = options.maxTokens === undefined ? DEFAULT_MAX_TOKENS : options.maxTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_MAX_TOKENS) {
    return failure('INVALID_MAX_TOKENS');
  }
  const body = JSON.stringify({ model, max_tokens: maxTokens, messages });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) return failure('REQUEST_TOO_LARGE');

  const result = await requestJson({
    endpoint: MESSAGES_ENDPOINT,
    method: 'POST',
    headers,
    body,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  if (!result.ok) return result;
  const payload = result.payload;
  const contentBlocks = Array.isArray(payload?.content) ? payload.content : [];
  let textBlock = null;
  let textBlockCount = 0;
  for (const block of contentBlocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      textBlockCount += 1;
      if (!textBlock) textBlock = block;
    }
  }
  const stopReason = safeStopReason(payload.stop_reason);
  const responseModel = typeof payload.model === 'string' && MODEL_RE.test(payload.model) ? payload.model : model;
  // Keep the long-standing failure shape for callers that cannot parse an
  // absent text value, while retaining safe completion metadata so strict
  // consumers can classify truncation/incompletion before text presence.
  if (!textBlock) {
    return {
      ok: false,
      error: 'NO_TEXT_BLOCK',
      text: null,
      contentBlockCount: contentBlocks.length,
      textBlockCount,
      nonTextBlockCount: contentBlocks.length - textBlockCount,
      usage: safeUsage(payload.usage),
      model: responseModel,
      stopReason,
    };
  }
  return {
    ok: true,
    text: textBlock ? textBlock.text : null,
    contentBlockCount: contentBlocks.length,
    textBlockCount,
    nonTextBlockCount: contentBlocks.length - textBlockCount,
    usage: safeUsage(payload.usage),
    model: responseModel,
    stopReason,
  };
}

module.exports = {
  BASE_URL,
  MODELS_ENDPOINT,
  MESSAGES_ENDPOINT,
  ANTHROPIC_VERSION,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  UNKNOWN_STOP_REASON,
  authHeaders,
  checkModels,
  callMessages,
};
