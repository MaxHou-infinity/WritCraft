'use strict';

const crypto = require('crypto');

const PUBLIC_STATE_SCHEMA = 'writcraft.chat-conversation-state/v1';
const MAX_STORED_TURNS = 6;
const MAX_SUMMARY_CHARS = 6000;
const MAX_SUMMARY_BYTES = 18 * 1024;
const MAX_USER_TURN_CHARS = 600;
const MAX_USER_TURN_BYTES = 3 * 1024;
const MAX_ASSISTANT_TURN_CHARS = 1200;
const MAX_ASSISTANT_TURN_BYTES = 6 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_OWNERS = 8;
const RESET_REASONS = new Set([
  'user_reset',
  'project_changed',
  'chat_reopened',
  'context_changed',
  'expired',
]);

class ChatConversationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ChatConversationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChatConversationError(code, message);
}

function validString(value, maxBytes = 1024) {
  return typeof value === 'string' && value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function validateBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
      !validString(binding.ownerId, 256) ||
      !Number.isSafeInteger(binding.navigationEpoch) || binding.navigationEpoch < 0 ||
      !validString(binding.projectInstanceId, 512) ||
      !validString(binding.rootPath, 4096) ||
      !Number.isSafeInteger(binding.contextGeneration) || binding.contextGeneration < 0) {
    fail('INVALID_CHAT_CONVERSATION_BINDING', 'Chat 会话绑定无效');
  }
  return binding;
}

function sameBinding(left, right) {
  return Boolean(left && right &&
    left.ownerId === right.ownerId &&
    left.navigationEpoch === right.navigationEpoch &&
    left.projectInstanceId === right.projectInstanceId &&
    left.rootPath === right.rootPath &&
    left.contextGeneration === right.contextGeneration);
}

function resetReason(previous, next) {
  if (!previous) return null;
  if (previous.projectInstanceId !== next.projectInstanceId || previous.rootPath !== next.rootPath) {
    return 'project_changed';
  }
  if (previous.navigationEpoch !== next.navigationEpoch) return 'chat_reopened';
  if (previous.contextGeneration !== next.contextGeneration) return 'context_changed';
  return null;
}

function boundedText(value, maxChars, maxBytes) {
  if (typeof value !== 'string') fail('INVALID_CHAT_CONVERSATION_TURN', 'Chat 会话轮次正文无效');
  let output = '';
  let chars = 0;
  let bytes = 0;
  for (const character of value) {
    if (chars >= maxChars) break;
    const safeCharacter = character === '\u0000' ? '�' : character;
    const nextBytes = Buffer.byteLength(safeCharacter, 'utf8');
    if (bytes + nextBytes > maxBytes) break;
    output += safeCharacter;
    chars += 1;
    bytes += nextBytes;
  }
  return output;
}

function turnText(turn) {
  return `第 ${turn.sequence} 轮\n用户：${turn.user}\n助手：${turn.assistant}`;
}

function summarize(turns) {
  const selected = [];
  let chars = 0;
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = turnText(turns[index]);
    const separator = selected.length ? '\n\n' : '';
    const next = `${separator}${text}`;
    const nextChars = Array.from(next).length;
    const nextBytes = Buffer.byteLength(next, 'utf8');
    if (chars + nextChars > MAX_SUMMARY_CHARS || bytes + nextBytes > MAX_SUMMARY_BYTES) break;
    selected.unshift(text);
    chars += nextChars;
    bytes += nextBytes;
  }
  const text = selected.join('\n\n');
  return Object.freeze({
    text,
    includedTurnCount: selected.length,
    totalTurnCount: turns.length,
    chars: Array.from(text).length,
    bytes: Buffer.byteLength(text, 'utf8'),
  });
}

function publicState(turnCount, reason = null) {
  return Object.freeze({
    schema: PUBLIC_STATE_SCHEMA,
    turnCount,
    resetReason: RESET_REASONS.has(reason) ? reason : null,
  });
}

function attachSummaryToManifest(manifest, summary) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      !summary || typeof summary.text !== 'string' || !summary.text) return manifest;
  const chars = Number.isSafeInteger(summary.chars) && summary.chars >= 0
    ? summary.chars : Array.from(summary.text).length;
  const bytes = Number.isSafeInteger(summary.bytes) && summary.bytes >= 0
    ? summary.bytes : Buffer.byteLength(summary.text, 'utf8');
  const conversation = Object.freeze({
    includedTurnCount: Math.min(MAX_STORED_TURNS, Math.max(0, Number(summary.includedTurnCount) || 0)),
    totalTurnCount: Math.min(MAX_STORED_TURNS, Math.max(0, Number(summary.totalTurnCount) || 0)),
    chars,
    bytes,
  });
  return Object.freeze({
    ...manifest,
    budgetChars: Math.max(0, Number(manifest.budgetChars) || 0) + MAX_SUMMARY_CHARS,
    budgetBytes: Math.max(0, Number(manifest.budgetBytes) || 0) + MAX_SUMMARY_BYTES,
    usedChars: Math.max(0, Number(manifest.usedChars) || 0) + chars,
    usedBytes: Math.max(0, Number(manifest.usedBytes) || 0) + bytes,
    conversation,
  });
}

function createChatConversationStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs : DEFAULT_TTL_MS;
  const maxOwners = Number.isSafeInteger(options.maxOwners) && options.maxOwners > 0
    ? options.maxOwners : DEFAULT_MAX_OWNERS;
  const sessions = new Map();
  const pendingResetReasons = new Map();

  function abortSession(session) {
    try { session?.pending?.controller?.abort(); } catch (_) {}
    if (session) session.pending = null;
  }

  function removeOwner(ownerId, reason = null) {
    const session = sessions.get(ownerId);
    if (!session) return false;
    abortSession(session);
    sessions.delete(ownerId);
    if (RESET_REASONS.has(reason)) pendingResetReasons.set(ownerId, reason);
    return true;
  }

  function cleanup() {
    const cutoff = now() - ttlMs;
    for (const [ownerId, session] of sessions) {
      if (session.touchedAt <= cutoff) removeOwner(ownerId, 'expired');
    }
    while (sessions.size > maxOwners) {
      removeOwner(sessions.keys().next().value, 'expired');
    }
  }

  function createSession(binding) {
    const session = {
      id: crypto.randomUUID(),
      binding: Object.freeze({ ...binding }),
      turns: [],
      nextSequence: 1,
      pending: null,
      touchedAt: now(),
    };
    sessions.delete(binding.ownerId);
    sessions.set(binding.ownerId, session);
    return session;
  }

  function requireLease(lease) {
    if (!lease || typeof lease !== 'object') {
      fail('CHAT_CONVERSATION_STALE', 'Chat 会话请求已失效');
    }
    const session = sessions.get(lease.ownerId);
    if (!session || session.id !== lease.sessionId ||
        !session.pending || session.pending.turnId !== lease.turnId ||
        !sameBinding(session.binding, lease.binding)) {
      fail('CHAT_CONVERSATION_STALE', 'Chat 会话请求已失效');
    }
    return session;
  }

  function begin(binding, userMessage) {
    validateBinding(binding);
    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      fail('INVALID_CHAT_CONVERSATION_TURN', 'Chat 会话问题不能为空');
    }
    cleanup();
    let session = sessions.get(binding.ownerId) || null;
    let reason = pendingResetReasons.get(binding.ownerId) || null;
    pendingResetReasons.delete(binding.ownerId);
    if (session && !sameBinding(session.binding, binding)) {
      reason = resetReason(session.binding, binding) || 'context_changed';
      abortSession(session);
      sessions.delete(binding.ownerId);
      session = null;
    }
    if (!session) session = createSession(binding);
    if (session.pending) abortSession(session);

    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    session.pending = { turnId, controller };
    session.touchedAt = now();
    sessions.delete(binding.ownerId);
    sessions.set(binding.ownerId, session);
    return Object.freeze({
      ownerId: binding.ownerId,
      sessionId: session.id,
      turnId,
      binding: session.binding,
      userMessage: boundedText(userMessage, MAX_USER_TURN_CHARS, MAX_USER_TURN_BYTES),
      summary: summarize(session.turns),
      resetReason: RESET_REASONS.has(reason) ? reason : null,
      signal: controller.signal,
    });
  }

  function commit(lease, assistantText) {
    const session = requireLease(lease);
    const assistant = boundedText(assistantText, MAX_ASSISTANT_TURN_CHARS, MAX_ASSISTANT_TURN_BYTES);
    if (!assistant.trim()) fail('INVALID_CHAT_CONVERSATION_TURN', 'Chat 会话回答不能为空');
    session.turns.push(Object.freeze({
      sequence: session.nextSequence,
      user: lease.userMessage,
      assistant,
    }));
    session.nextSequence += 1;
    if (session.turns.length > MAX_STORED_TURNS) {
      session.turns.splice(0, session.turns.length - MAX_STORED_TURNS);
    }
    session.pending = null;
    session.touchedAt = now();
    return publicState(session.turns.length, lease.resetReason);
  }

  function finish(lease) {
    try {
      const session = requireLease(lease);
      session.pending = null;
      session.touchedAt = now();
      return true;
    } catch (_) {
      return false;
    }
  }

  function cancelPending(binding) {
    validateBinding(binding);
    cleanup();
    const session = sessions.get(binding.ownerId);
    if (!session) return false;
    if (!sameBinding(session.binding, binding)) {
      removeOwner(binding.ownerId, resetReason(session.binding, binding) || 'context_changed');
      return false;
    }
    if (!session.pending) return false;
    abortSession(session);
    session.touchedAt = now();
    return true;
  }

  function reset(binding) {
    validateBinding(binding);
    const removed = removeOwner(binding.ownerId);
    pendingResetReasons.set(binding.ownerId, 'user_reset');
    return removed;
  }

  function invalidateOwner(ownerId, reason = 'context_changed') {
    if (!validString(ownerId, 256)) return false;
    return removeOwner(ownerId, RESET_REASONS.has(reason) ? reason : 'context_changed');
  }

  function inspect(binding) {
    validateBinding(binding);
    const session = sessions.get(binding.ownerId);
    if (!session || !sameBinding(session.binding, binding)) return null;
    return Object.freeze({
      binding: session.binding,
      turns: Object.freeze(session.turns.map(turn => Object.freeze({ ...turn }))),
      pending: Boolean(session.pending),
    });
  }

  return Object.freeze({
    begin,
    commit,
    finish,
    cancelPending,
    reset,
    invalidateOwner,
    inspect,
    clear() {
      for (const ownerId of [...sessions.keys()]) removeOwner(ownerId);
      pendingResetReasons.clear();
    },
  });
}

module.exports = Object.freeze({
  PUBLIC_STATE_SCHEMA,
  MAX_STORED_TURNS,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_BYTES,
  ChatConversationError,
  createChatConversationStore,
  attachSummaryToManifest,
});
