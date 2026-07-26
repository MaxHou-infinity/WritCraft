'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const METRICS_SCHEMA = 'writcraft.ai-metrics/v1';
const METRICS_RELATIVE_PATH = '.writcraft/metrics.json';
const MAX_EVENTS = 2000;
const MAX_METRICS_BYTES = 2 * 1024 * 1024;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_CHAR_COUNT = 100 * 1024 * 1024;
const SMALL_SAMPLE_THRESHOLD = 20;
const RESEARCH_JUDGMENT_SCHEMA = 'writcraft.research-judgment/v1';
const RESEARCH_CARD_ID_RE = /^rc_([a-f0-9]{32})$/;

// Keep the v1 file shape stable: these enums add privacy-safe workflow labels
// without adding content, prompts, paths, provider output or identifiers.
const ACTIONS = new Set([
  'inline_rewrite', 'changeset', 'plan', 'onboarding', 'research', 'image',
  'graph_issue', 'plan_task',
]);
const OUTCOMES = new Set(['accepted', 'rejected', 'generated', 'discarded', 'failed', 'structured_failed', 'retried']);
const FILE_ACTIONS = new Set([...ACTIONS, 'research_accuracy']);
const FILE_OUTCOMES = new Set([...OUTCOMES, 'matched', 'mismatched']);
const STYLES = new Set(['general', 'concise', 'expand', 'polish', 'formal', 'casual', 'vivid', 'academic', 'creative', 'neutral', 'none']);
const SCOPES = new Set(['selection', 'file', 'multi_file', 'project']);
const EVENT_KEYS = new Set(['operationId', 'action', 'outcome', 'style', 'scope', 'durationMs', 'beforeChars', 'afterChars', 'time']);
const INPUT_KEYS = new Set([...EVENT_KEYS].filter(key => key !== 'time'));

class AiMetricsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiMetricsError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AiMetricsError(code, message);
}

function exactKeys(value, allowed, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${label}必须是对象`);
  // Never echo an untrusted property name: a hostile caller could place正文,
  // Prompt or key material in the key itself and make an error response leak it.
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label}包含禁止字段`);
}

function enumValue(value, allowed, field, code = 'INVALID_EVENT') {
  if (typeof value !== 'string' || !allowed.has(value)) fail(code, `${field} 不受支持`);
  return value;
}

function boundedInteger(value, maximum, field, code = 'INVALID_EVENT') {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail(code, `${field} 超出安全范围`);
  return value;
}

function timestamp(value, code = 'INVALID_METRICS_FILE') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail(code, '指标时间无效');
  }
  return value;
}

function operationId(value, code = 'INVALID_EVENT') {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/i.test(value)) fail(code, 'operationId 无效');
  return value.toLowerCase();
}

function normalizeEvent(raw, options = {}) {
  const fromFile = options.fromFile === true;
  const internalResearchAccuracy = options.internalResearchAccuracy === true;
  exactKeys(raw, fromFile ? EVENT_KEYS : INPUT_KEYS, fromFile ? 'INVALID_METRICS_FILE' : 'INVALID_EVENT', 'AI 指标事件');
  for (const required of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) {
      fail(fromFile ? 'INVALID_METRICS_FILE' : 'INVALID_EVENT', `AI 指标事件缺少 ${required}`);
    }
  }
  const code = fromFile ? 'INVALID_METRICS_FILE' : 'INVALID_EVENT';
  const event = {
    operationId: operationId(raw.operationId, code),
    action: enumValue(raw.action, fromFile || internalResearchAccuracy ? FILE_ACTIONS : ACTIONS, 'action', code),
    outcome: enumValue(raw.outcome, fromFile || internalResearchAccuracy ? FILE_OUTCOMES : OUTCOMES, 'outcome', code),
    style: enumValue(raw.style, STYLES, 'style', code),
    scope: enumValue(raw.scope, SCOPES, 'scope', code),
    durationMs: boundedInteger(raw.durationMs, MAX_DURATION_MS, 'durationMs', code),
    beforeChars: boundedInteger(raw.beforeChars, MAX_CHAR_COUNT, 'beforeChars', code),
    afterChars: boundedInteger(raw.afterChars, MAX_CHAR_COUNT, 'afterChars', code),
    time: fromFile ? timestamp(raw.time, code) : timestamp((options.now || new Date()).toISOString(), code),
  };
  return event;
}

function emptyDocument(now = new Date()) {
  return { schema: METRICS_SCHEMA, updatedAt: now.toISOString(), events: [] };
}

function normalizeDocument(raw) {
  exactKeys(raw, new Set(['schema', 'updatedAt', 'events']), 'INVALID_METRICS_FILE', 'AI 指标文件');
  if (raw.schema !== METRICS_SCHEMA || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) {
    fail('INVALID_METRICS_FILE', 'AI 指标文件 schema 或事件数量无效');
  }
  const events = raw.events.map(event => normalizeEvent(event, { fromFile: true }));
  const identities = new Set();
  const researchJudgments = new Set();
  for (const event of events) {
    const identity = `${event.operationId}\0${event.outcome}`;
    if (identities.has(identity)) fail('INVALID_METRICS_FILE', 'AI 指标文件包含重复事件');
    identities.add(identity);
    if (event.action === 'research_accuracy') {
      if (researchJudgments.has(event.operationId)) fail('INVALID_METRICS_FILE', '同一 Research 卡片包含冲突判断');
      researchJudgments.add(event.operationId);
    }
  }
  return { schema: METRICS_SCHEMA, updatedAt: timestamp(raw.updatedAt), events };
}

function metricsLocation(rootPath, createMetadataDirectory = false) {
  if (typeof rootPath !== 'string' || !rootPath) fail('INVALID_ROOT', '项目目录无效');
  const absolute = path.resolve(rootPath);
  let rootStat;
  try { rootStat = fs.statSync(absolute); } catch (_) { fail('INVALID_ROOT', '项目目录不存在'); }
  if (!rootStat.isDirectory()) fail('INVALID_ROOT', '项目路径不是目录');
  const root = fs.realpathSync(absolute);
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    if (!createMetadataDirectory) return { file: path.join(metadata, 'metrics.json'), exists: false };
    fs.mkdirSync(metadata, { mode: 0o700 });
  }
  const metadataStat = fs.lstatSync(metadata);
  if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory() || fs.realpathSync(metadata) !== metadata) {
    fail('UNSAFE_METRICS_PATH', '.writcraft 必须是项目内普通目录');
  }
  const file = path.join(metadata, 'metrics.json');
  if (fs.existsSync(file)) {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail('UNSAFE_METRICS_PATH', 'metrics.json 必须是普通文件');
  }
  return { file, exists: fs.existsSync(file) };
}

function atomicWrite(filePath, content, options = {}) {
  const temporary = path.join(path.dirname(filePath), `.metrics.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (typeof options.beforeRename === 'function') options.beforeRename();
    fs.renameSync(temporary, filePath);
    try {
      const directoryFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function serializeDocument(document) {
  const normalized = normalizeDocument(document);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_METRICS_BYTES) fail('METRICS_TOO_LARGE', 'AI 指标文件超过安全上限');
  return { normalized, serialized };
}

function loadMetrics(rootPath) {
  const location = metricsLocation(rootPath, false);
  if (!location.exists) return emptyDocument();
  const stat = fs.statSync(location.file);
  if (stat.size > MAX_METRICS_BYTES) fail('METRICS_TOO_LARGE', 'AI 指标文件超过安全上限');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(location.file, 'utf8')); }
  catch (_) { fail('METRICS_CORRUPT', 'AI 指标文件损坏，已阻止覆盖'); }
  return normalizeDocument(raw);
}

function appendEvent(rootPath, rawEvent, options = {}) {
  if (rawEvent?.action === 'research_accuracy') {
    fail('INVALID_EVENT', 'Research 准确率只能通过 Main 权威判断接口记录');
  }
  const event = normalizeEvent(rawEvent, { now: options.now });
  const current = loadMetrics(rootPath); // Corruption and unsafe paths fail before any write.
  const duplicate = current.events.find(item => item.operationId === event.operationId && item.outcome === event.outcome);
  if (duplicate) return { event: duplicate, document: current, duplicate: true };
  const now = options.now || new Date();
  let events = [...current.events, event];
  if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
  let candidate = { schema: METRICS_SCHEMA, updatedAt: now.toISOString(), events };
  let serialized;
  while (events.length) {
    try {
      ({ serialized } = serializeDocument(candidate));
      break;
    } catch (error) {
      if (!(error instanceof AiMetricsError) || error.code !== 'METRICS_TOO_LARGE' || events.length === 1) throw error;
      events = events.slice(1);
      candidate = { ...candidate, events };
    }
  }
  const location = metricsLocation(rootPath, true);
  atomicWrite(location.file, serialized);
  return { event, document: candidate, duplicate: false };
}

function normalizeResearchJudgmentRequest(raw) {
  exactKeys(raw, new Set(['schema', 'cardId', 'verdict']), 'INVALID_RESEARCH_JUDGMENT', 'Research 判断请求');
  if (raw.schema !== RESEARCH_JUDGMENT_SCHEMA) {
    fail('INVALID_RESEARCH_JUDGMENT', 'Research 判断 schema 无效');
  }
  const match = typeof raw.cardId === 'string' ? raw.cardId.match(RESEARCH_CARD_ID_RE) : null;
  if (!match || (raw.verdict !== 'matched' && raw.verdict !== 'mismatched')) {
    fail('INVALID_RESEARCH_JUDGMENT', 'Research 判断卡片或结论无效');
  }
  return Object.freeze({ schema: RESEARCH_JUDGMENT_SCHEMA, cardId: raw.cardId, verdict: raw.verdict });
}

function recordResearchAccuracy(rootPath, rawRequest, options = {}) {
  const request = normalizeResearchJudgmentRequest(rawRequest);
  const event = normalizeEvent({
    operationId: request.cardId.slice(3),
    action: 'research_accuracy',
    outcome: request.verdict,
    style: 'none',
    scope: 'project',
    durationMs: 0,
    beforeChars: 0,
    afterChars: 0,
  }, { now: options.now, internalResearchAccuracy: true });
  const current = loadMetrics(rootPath);
  const previous = current.events.find(item =>
    item.action === 'research_accuracy' && item.operationId === event.operationId);
  if (previous?.outcome === event.outcome) {
    if (typeof options.beforeRename === 'function') options.beforeRename();
    return { event: previous, document: current, duplicate: true, replaced: false };
  }

  const now = options.now || new Date();
  let events = current.events.filter(item =>
    !(item.action === 'research_accuracy' && item.operationId === event.operationId));
  events.push(event);
  if (events.length > MAX_EVENTS) events = events.slice(events.length - MAX_EVENTS);
  let candidate = { schema: METRICS_SCHEMA, updatedAt: now.toISOString(), events };
  let serialized;
  while (events.length) {
    try {
      ({ serialized } = serializeDocument(candidate));
      break;
    } catch (error) {
      if (!(error instanceof AiMetricsError) || error.code !== 'METRICS_TOO_LARGE' || events.length === 1) throw error;
      events = events.slice(1);
      candidate = { ...candidate, events };
    }
  }
  const location = metricsLocation(rootPath, true);
  atomicWrite(location.file, serialized, { beforeRename: options.beforeRename });
  return { event, document: candidate, duplicate: false, replaced: Boolean(previous) };
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function aggregateMetrics(input) {
  const document = Array.isArray(input)
    ? normalizeDocument({ schema: METRICS_SCHEMA, updatedAt: new Date(0).toISOString(), events: input })
    : normalizeDocument(input);
  const events = document.events;
  const accepted = events.filter(event => event.outcome === 'accepted').length;
  const rejected = events.filter(event => event.outcome === 'rejected').length;
  const decisions = accepted + rejected;
  const responseDurations = events.filter(event =>
    event.outcome === 'generated' || event.outcome === 'failed' || event.outcome === 'structured_failed'
  ).map(event => event.durationMs).sort((left, right) => left - right);
  const reviewDurations = events.filter(event => event.outcome === 'accepted' || event.outcome === 'rejected' || event.outcome === 'discarded').map(event => event.durationMs).sort((left, right) => left - right);
  const summarizeDurations = values => ({
    average: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  });
  const byAction = Object.fromEntries([...FILE_ACTIONS].map(action => {
    const subset = events.filter(event => event.action === action);
    const subsetAccepted = subset.filter(event => event.outcome === 'accepted').length;
    const subsetRejected = subset.filter(event => event.outcome === 'rejected').length;
    const subsetDecisions = subsetAccepted + subsetRejected;
    const subsetGenerated = subset.filter(event => event.outcome === 'generated').length;
    const subsetStructuredFailed = subset.filter(event => event.outcome === 'structured_failed').length;
    const subsetFailed = subset.filter(event => event.outcome === 'failed').length + subsetStructuredFailed;
    const subsetAttempts = subsetGenerated + subsetFailed;
    return [action, {
      events: subset.length,
      accepted: subsetAccepted,
      rejected: subsetRejected,
      generated: subsetGenerated,
      failed: subsetFailed,
      structuredFailed: subsetStructuredFailed,
      discarded: subset.filter(event => event.outcome === 'discarded').length,
      retried: subset.filter(event => event.outcome === 'retried').length,
      attemptSampleSize: subsetAttempts,
      attemptSmallSample: subsetAttempts < SMALL_SAMPLE_THRESHOLD,
      failureRate: subsetAttempts ? subsetFailed / subsetAttempts : null,
      decisionSampleSize: subsetDecisions,
      decisionSmallSample: subsetDecisions < SMALL_SAMPLE_THRESHOLD,
      decisionSampleNote: subsetDecisions < SMALL_SAMPLE_THRESHOLD
        ? `该操作决策样本少于 ${SMALL_SAMPLE_THRESHOLD}，接受率与拒绝率仅供方向参考`
        : null,
      acceptanceRate: subsetDecisions ? subsetAccepted / subsetDecisions : null,
      rejectionRate: subsetDecisions ? subsetRejected / subsetDecisions : null,
    }];
  }));
  const onboardingEvents = events.filter(event => event.action === 'onboarding');
  const retriedOperationIds = new Set(onboardingEvents
    .filter(event => event.outcome === 'retried')
    .map(event => event.operationId));
  const retrySuccesses = onboardingEvents.filter(event =>
    event.outcome === 'generated' && retriedOperationIds.has(event.operationId)).length;
  const retryFailures = onboardingEvents.filter(event =>
    (event.outcome === 'failed' || event.outcome === 'structured_failed') &&
      retriedOperationIds.has(event.operationId)).length;
  const retryResults = retrySuccesses + retryFailures;
  const evidenceFor = action => Object.freeze({
    sampleSize: byAction[action].events,
    attempts: byAction[action].attemptSampleSize,
    decisionSampleSize: byAction[action].decisionSampleSize,
    acceptanceRate: byAction[action].acceptanceRate,
    failureRate: byAction[action].failureRate,
    smallSample: Math.max(byAction[action].decisionSampleSize, byAction[action].attemptSampleSize) < SMALL_SAMPLE_THRESHOLD,
  });
  const authorEvidence = Object.freeze({
    inline: evidenceFor('inline_rewrite'),
    planRun: evidenceFor('plan'),
    planTask: evidenceFor('plan_task'),
    research: evidenceFor('research'),
    researchAccuracy: (() => {
      const judgments = events.filter(event => event.action === 'research_accuracy');
      const matched = judgments.filter(event => event.outcome === 'matched').length;
      const mismatched = judgments.filter(event => event.outcome === 'mismatched').length;
      return Object.freeze({
        sampleSize: judgments.length,
        matched,
        mismatched,
        matchRate: judgments.length ? matched / judgments.length : null,
        smallSample: judgments.length < SMALL_SAMPLE_THRESHOLD,
        sampleNote: judgments.length < SMALL_SAMPLE_THRESHOLD
          ? `Research 判断样本少于 ${SMALL_SAMPLE_THRESHOLD}，匹配率仅供方向参考`
          : null,
        note: '作者对 AI 主张与当次来源摘录是否匹配的判断，不是来源真实性、权威性或平台事实评分。',
      });
    })(),
    image: evidenceFor('image'),
    onboarding: Object.freeze({
      ...evidenceFor('onboarding'),
      attempts: byAction.onboarding.attemptSampleSize,
      retries: byAction.onboarding.retried,
      retryResults,
      retrySuccesses,
      retryFailures,
      retrySuccessRate: retryResults ? retrySuccesses / retryResults : null,
      structuredFailures: byAction.onboarding.structuredFailed,
      structuredFailureRate: byAction.onboarding.attemptSampleSize
        ? byAction.onboarding.structuredFailed / byAction.onboarding.attemptSampleSize
        : null,
    }),
  });
  return {
    sampleSize: events.length,
    smallSample: events.length < SMALL_SAMPLE_THRESHOLD,
    sampleNote: events.length < SMALL_SAMPLE_THRESHOLD ? `样本少于 ${SMALL_SAMPLE_THRESHOLD}，比例仅供方向参考` : null,
    outcomes: Object.fromEntries([...FILE_OUTCOMES].map(outcome => [outcome, events.filter(event => event.outcome === outcome).length])),
    decisionSampleSize: decisions,
    decisionSmallSample: decisions < SMALL_SAMPLE_THRESHOLD,
    decisionSampleNote: decisions < SMALL_SAMPLE_THRESHOLD
      ? `接受/拒绝决策样本少于 ${SMALL_SAMPLE_THRESHOLD}，比例仅供方向参考`
      : null,
    acceptanceRate: decisions ? accepted / decisions : null,
    rejectionRate: decisions ? rejected / decisions : null,
    durationMs: summarizeDurations(responseDurations),
    reviewDurationMs: summarizeDurations(reviewDurations),
    byAction,
    authorEvidence,
  };
}

module.exports = {
  METRICS_SCHEMA,
  METRICS_RELATIVE_PATH,
  MAX_EVENTS,
  MAX_METRICS_BYTES,
  SMALL_SAMPLE_THRESHOLD,
  RESEARCH_JUDGMENT_SCHEMA,
  ACTIONS,
  OUTCOMES,
  STYLES,
  SCOPES,
  AiMetricsError,
  loadMetrics,
  appendEvent,
  normalizeResearchJudgmentRequest,
  recordResearchAccuracy,
  aggregateMetrics,
};
