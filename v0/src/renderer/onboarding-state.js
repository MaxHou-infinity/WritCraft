(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftOnboardingState = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'writcraft.onboarding-session/v1';
  const QUESTION_IDS = Object.freeze([
    'premise', 'audience', 'objective', 'scope', 'structure', 'voice',
    'invariants', 'timeline', 'sources', 'openQuestions',
  ]);
  const MAX_ANSWER_CHARS = 4000;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function questionIndex(id) {
    const index = QUESTION_IDS.indexOf(id);
    if (index < 0) fail('UNKNOWN_QUESTION', '未知的项目建立问题');
    return index;
  }

  function cleanAnswer(value) {
    if (typeof value !== 'string') fail('INVALID_ANSWER', '回答必须是文本');
    const answer = value.trim();
    if (answer.length > MAX_ANSWER_CHARS) fail('ANSWER_TOO_LONG', `回答不能超过 ${MAX_ANSWER_CHARS} 个字符`);
    return answer;
  }

  function normalize(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_SESSION', '项目建立会话无效');
    const answers = {};
    for (const [id, value] of Object.entries(raw.answers || {})) {
      questionIndex(id);
      const answer = cleanAnswer(value);
      if (answer) answers[id] = answer;
    }
    const skipped = [];
    if (raw.skipped !== undefined && !Array.isArray(raw.skipped)) fail('INVALID_SESSION', '跳过问题列表无效');
    for (const id of raw.skipped || []) {
      questionIndex(id);
      if (!answers[id] && !skipped.includes(id)) skipped.push(id);
    }
    const currentIndex = Number.isInteger(raw.currentIndex) ? raw.currentIndex : 0;
    if (currentIndex < 0 || currentIndex >= QUESTION_IDS.length) fail('INVALID_SESSION', '当前问题位置无效');
    const status = raw.status === 'review' ? 'review' : 'questions';
    return { schema: SCHEMA, currentIndex, status, answers, skipped };
  }

  function createSession(raw = {}) {
    return normalize(raw);
  }

  function updateAnswer(state, id, value) {
    const next = normalize(state);
    questionIndex(id);
    const answer = cleanAnswer(value);
    if (answer) next.answers[id] = answer;
    else delete next.answers[id];
    next.skipped = next.skipped.filter(item => item !== id);
    return next;
  }

  function skip(state, id = QUESTION_IDS[normalize(state).currentIndex]) {
    const next = normalize(state);
    const index = questionIndex(id);
    delete next.answers[id];
    if (!next.skipped.includes(id)) next.skipped.push(id);
    next.currentIndex = Math.min(QUESTION_IDS.length - 1, index + 1);
    if (index === QUESTION_IDS.length - 1) next.status = 'review';
    return next;
  }

  function advance(state) {
    const next = normalize(state);
    const id = QUESTION_IDS[next.currentIndex];
    if (!next.answers[id] && !next.skipped.includes(id)) {
      fail('QUESTION_UNRESOLVED', '请回答或跳过当前问题');
    }
    if (next.currentIndex === QUESTION_IDS.length - 1) next.status = 'review';
    else next.currentIndex += 1;
    return next;
  }

  function goBack(state) {
    const next = normalize(state);
    if (next.status === 'review') {
      next.status = 'questions';
      next.currentIndex = QUESTION_IDS.length - 1;
    } else {
      next.currentIndex = Math.max(0, next.currentIndex - 1);
    }
    return next;
  }

  function editQuestion(state, id) {
    const next = normalize(state);
    next.currentIndex = questionIndex(id);
    next.status = 'questions';
    return next;
  }

  function progress(state) {
    const current = normalize(state);
    const resolved = QUESTION_IDS.filter(id => current.answers[id] || current.skipped.includes(id)).length;
    return { resolved, answered: Object.keys(current.answers).length, total: QUESTION_IDS.length };
  }

  function submission(state) {
    const current = normalize(state);
    if (!Object.keys(current.answers).length) fail('EMPTY_ANSWERS', '至少回答一个项目建立问题');
    return { ...current.answers };
  }

  return {
    SCHEMA,
    QUESTION_IDS,
    MAX_ANSWER_CHARS,
    createSession,
    updateAnswer,
    skip,
    advance,
    goBack,
    editQuestion,
    progress,
    submission,
  };
});
