'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUNDLE_SCHEMA = 'writcraft.diagnostic-bundle/v1';
const PREVIEW_SCHEMA = 'writcraft.diagnostic-preview/v1';
const EXPORT_SCHEMA = 'writcraft.diagnostic-export/v1';
const MAX_SERIALIZED_BYTES = 128 * 1024;
const MAX_DIAGNOSTICS = 64;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_PREVIEWS = 8;

const AREAS = new Set(['project', 'renderer', 'window', 'diagnostic']);
const PROMPT_STATUSES = new Set([
  'not_open', 'missing', 'valid', 'warning', 'invalid', 'unavailable',
]);
const WATCHER_STATUSES = new Set(['not_open', 'healthy', 'degraded', 'unavailable']);
const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TOKEN_RE = /^[a-f0-9]{32,128}$/;
const PROJECT_KEYS = new Set([
  'open', 'fileCount', 'markdownFileCount', 'promptStatus',
  'promptDiagnosticCodes', 'watcherStatus', 'metrics',
]);
const METRICS_KEYS = new Set([
  'sampleSize', 'smallSample', 'inlineDecisions', 'planAttempts',
  'researchJudgments', 'imageAttempts', 'onboardingAttempts',
]);
const BINDING_KEYS = new Set([
  'webContentsId', 'projectInstanceId', 'mutationGeneration', 'navigationEpoch',
]);

class DiagnosticExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DiagnosticExportError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DiagnosticExportError(code, message);
}

function plainObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label}无效`);
  }
  return value;
}

function exactKeys(value, keys, code, label) {
  plainObject(value, code, label);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(code, `${label}包含禁止字段`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(code, `${label}缺少字段`);
  }
}

function safeInteger(value, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(code, `${label}超出安全范围`);
  }
  return value;
}

function timestamp(value, code = 'INVALID_DIAGNOSTIC_BUNDLE') {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
      Number.isNaN(Date.parse(text))) {
    fail(code, '诊断时间无效');
  }
  return text;
}

function boundedVersion(value, label) {
  if (typeof value !== 'string' || !value || value.length > 64 ||
      !/^[A-Za-z0-9._+-]+$/.test(value)) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', `${label}无效`);
  }
  return value;
}

function boundedRuntimeName(value, label) {
  if (typeof value !== 'string' || !value || value.length > 32 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', `${label}无效`);
  }
  return value;
}

function normalizeMetrics(raw) {
  exactKeys(raw, METRICS_KEYS, 'INVALID_DIAGNOSTIC_BUNDLE', '诊断指标');
  if (typeof raw.smallSample !== 'boolean') {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '小样本标记无效');
  }
  return {
    sampleSize: safeInteger(raw.sampleSize, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', '指标样本数'),
    smallSample: raw.smallSample,
    inlineDecisions: safeInteger(raw.inlineDecisions, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', 'Inline 决策数'),
    planAttempts: safeInteger(raw.planAttempts, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', 'Plan 尝试数'),
    researchJudgments: safeInteger(raw.researchJudgments, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', 'Research 判断数'),
    imageAttempts: safeInteger(raw.imageAttempts, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', '图片尝试数'),
    onboardingAttempts: safeInteger(raw.onboardingAttempts, 1000000, 'INVALID_DIAGNOSTIC_BUNDLE', '项目卡尝试数'),
  };
}

function normalizeProject(raw) {
  exactKeys(raw, PROJECT_KEYS, 'INVALID_DIAGNOSTIC_BUNDLE', '诊断项目摘要');
  if (typeof raw.open !== 'boolean' || !PROMPT_STATUSES.has(raw.promptStatus) ||
      !WATCHER_STATUSES.has(raw.watcherStatus) ||
      !Array.isArray(raw.promptDiagnosticCodes) || raw.promptDiagnosticCodes.length > 20) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '诊断项目摘要无效');
  }
  const promptDiagnosticCodes = raw.promptDiagnosticCodes.map(code => {
    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      fail('INVALID_DIAGNOSTIC_BUNDLE', '项目 Prompt 诊断代码无效');
    }
    return code;
  });
  if (new Set(promptDiagnosticCodes).size !== promptDiagnosticCodes.length) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '项目 Prompt 诊断代码重复');
  }
  const project = {
    open: raw.open,
    fileCount: safeInteger(raw.fileCount, 10000, 'INVALID_DIAGNOSTIC_BUNDLE', '项目文件数'),
    markdownFileCount: safeInteger(raw.markdownFileCount, 10000, 'INVALID_DIAGNOSTIC_BUNDLE', 'Markdown 文件数'),
    promptStatus: raw.promptStatus,
    promptDiagnosticCodes,
    watcherStatus: raw.watcherStatus,
    metrics: normalizeMetrics(raw.metrics),
  };
  if (project.markdownFileCount > project.fileCount) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', 'Markdown 文件数不能超过项目文件数');
  }
  if (!project.open &&
      (project.fileCount !== 0 || project.markdownFileCount !== 0 ||
       project.promptStatus !== 'not_open' ||
       project.promptDiagnosticCodes.length !== 0 ||
       project.watcherStatus !== 'not_open')) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '未打开项目时诊断摘要必须为空');
  }
  return project;
}

function normalizeDiagnostic(raw) {
  exactKeys(raw, new Set(['area', 'code', 'time']), 'INVALID_DIAGNOSTIC_BUNDLE', '诊断事件');
  if (!AREAS.has(raw.area) || typeof raw.code !== 'string' || !CODE_RE.test(raw.code)) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '诊断事件无效');
  }
  return { area: raw.area, code: raw.code, time: timestamp(raw.time) };
}

function normalizeBundle(raw, options = {}) {
  const inputKeys = options.serialized
    ? new Set(['schema', 'generatedAt', 'app', 'runtime', 'project', 'diagnostics'])
    : new Set(['generatedAt', 'app', 'runtime', 'project', 'diagnostics']);
  exactKeys(raw, inputKeys, 'INVALID_DIAGNOSTIC_BUNDLE', '诊断包');
  if (options.serialized && raw.schema !== BUNDLE_SCHEMA) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '诊断包 schema 无效');
  }
  exactKeys(raw.app, new Set(['version', 'packaged']), 'INVALID_DIAGNOSTIC_BUNDLE', '应用诊断');
  exactKeys(raw.runtime, new Set(['platform', 'arch', 'electron', 'node']), 'INVALID_DIAGNOSTIC_BUNDLE', '运行时诊断');
  if (typeof raw.app.packaged !== 'boolean' || !Array.isArray(raw.diagnostics) ||
      raw.diagnostics.length > MAX_DIAGNOSTICS) {
    fail('INVALID_DIAGNOSTIC_BUNDLE', '诊断包无效');
  }
  return {
    schema: BUNDLE_SCHEMA,
    generatedAt: timestamp(raw.generatedAt),
    app: {
      version: boundedVersion(raw.app.version, '应用版本'),
      packaged: raw.app.packaged,
    },
    runtime: {
      platform: boundedRuntimeName(raw.runtime.platform, '平台'),
      arch: boundedRuntimeName(raw.runtime.arch, '架构'),
      electron: boundedVersion(raw.runtime.electron, 'Electron 版本'),
      node: boundedVersion(raw.runtime.node, 'Node 版本'),
    },
    project: normalizeProject(raw.project),
    diagnostics: raw.diagnostics.map(normalizeDiagnostic),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildDiagnosticBundle(input) {
  return deepFreeze(normalizeBundle(input));
}

function serializeDiagnosticBundle(bundle) {
  const normalized = normalizeBundle(bundle, { serialized: true });
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    fail('DIAGNOSTIC_TOO_LARGE', '诊断信息超过安全上限');
  }
  return serialized;
}

function readNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('INVALID_DIAGNOSTIC_TIME', '诊断时间无效');
  return date;
}

function createDiagnosticRecorder(options = {}) {
  const now = options.now || (() => new Date());
  const maximum = options.maxEntries === undefined
    ? MAX_DIAGNOSTICS
    : safeInteger(options.maxEntries, MAX_DIAGNOSTICS, 'INVALID_DIAGNOSTIC_LIMIT', '诊断事件上限');
  if (maximum < 1) fail('INVALID_DIAGNOSTIC_LIMIT', '诊断事件上限无效');
  let events = [];
  return Object.freeze({
    record(area, code) {
      const event = Object.freeze({
        area: AREAS.has(area) ? area : 'diagnostic',
        code: typeof code === 'string' && CODE_RE.test(code) ? code : 'UNCLASSIFIED_DIAGNOSTIC',
        time: readNow(now).toISOString(),
      });
      events = [...events, event].slice(-maximum);
      return event;
    },
    list() {
      return Object.freeze(events.map(event => Object.freeze({ ...event })));
    },
    clear() { events = []; },
  });
}

function normalizeBinding(raw) {
  exactKeys(raw, BINDING_KEYS, 'INVALID_DIAGNOSTIC_BINDING', '诊断预览绑定');
  if (raw.projectInstanceId !== null &&
      (typeof raw.projectInstanceId !== 'string' || !raw.projectInstanceId ||
       raw.projectInstanceId.length > 256 || /[\u0000-\u001f\u007f]/.test(raw.projectInstanceId))) {
    fail('INVALID_DIAGNOSTIC_BINDING', '诊断预览项目绑定无效');
  }
  const webContentsId = safeInteger(
    raw.webContentsId,
    0x7fffffff,
    'INVALID_DIAGNOSTIC_BINDING',
    '窗口绑定'
  );
  if (webContentsId < 1) {
    fail('INVALID_DIAGNOSTIC_BINDING', '窗口绑定无效');
  }
  return {
    webContentsId,
    projectInstanceId: raw.projectInstanceId,
    mutationGeneration: safeInteger(raw.mutationGeneration, Number.MAX_SAFE_INTEGER, 'INVALID_DIAGNOSTIC_BINDING', '项目代际'),
    navigationEpoch: safeInteger(raw.navigationEpoch, Number.MAX_SAFE_INTEGER, 'INVALID_DIAGNOSTIC_BINDING', '页面代际'),
  };
}

function bindingIdentity(raw) {
  const value = normalizeBinding(raw);
  return `${value.webContentsId}\0${value.projectInstanceId || ''}\0${value.mutationGeneration}\0${value.navigationEpoch}`;
}

function validateSerialized(serialized) {
  if (typeof serialized !== 'string' || !serialized ||
      Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    fail('INVALID_DIAGNOSTIC_PREVIEW', '诊断预览内容无效');
  }
  let parsed;
  try { parsed = JSON.parse(serialized); }
  catch (_) { fail('INVALID_DIAGNOSTIC_PREVIEW', '诊断预览内容无效'); }
  let canonical;
  try { canonical = serializeDiagnosticBundle(parsed); }
  catch (_) { fail('INVALID_DIAGNOSTIC_PREVIEW', '诊断预览内容无效'); }
  if (canonical !== serialized) {
    fail('INVALID_DIAGNOSTIC_PREVIEW', '诊断预览不是规范序列化结果');
  }
  return serialized;
}

function createDiagnosticPreviewStore(options = {}) {
  const now = options.now || (() => new Date());
  const randomToken = options.randomToken || (() => crypto.randomBytes(24).toString('hex'));
  const ttlMs = options.ttlMs === undefined
    ? PREVIEW_TTL_MS
    : safeInteger(options.ttlMs, PREVIEW_TTL_MS, 'INVALID_DIAGNOSTIC_LIMIT', '诊断预览期限');
  const maxEntries = options.maxEntries === undefined
    ? MAX_PREVIEWS
    : safeInteger(options.maxEntries, MAX_PREVIEWS, 'INVALID_DIAGNOSTIC_LIMIT', '诊断预览数量');
  if (ttlMs < 1000 || maxEntries < 1) fail('INVALID_DIAGNOSTIC_LIMIT', '诊断预览限制无效');
  const entries = new Map();

  function nowMs() {
    return readNow(now).getTime();
  }

  function purge(at = nowMs()) {
    for (const [token, record] of entries) {
      if (record.expiresMs <= at) entries.delete(token);
    }
  }

  function token(value) {
    if (typeof value !== 'string' || !TOKEN_RE.test(value)) {
      fail('DIAGNOSTIC_PREVIEW_STALE', '诊断预览已经失效，请重新预览');
    }
    return value;
  }

  function get(value, binding) {
    const at = nowMs();
    purge(at);
    const record = entries.get(token(value));
    if (!record || record.binding !== bindingIdentity(binding) || record.expiresMs <= at) {
      fail('DIAGNOSTIC_PREVIEW_STALE', '诊断预览已经失效，请重新预览');
    }
    return Object.freeze({
      serialized: record.serialized,
      expiresAt: record.expiresAt,
    });
  }

  return Object.freeze({
    issue(raw) {
      exactKeys(raw, new Set(['serialized', 'binding']), 'INVALID_DIAGNOSTIC_PREVIEW', '诊断预览');
      const serialized = validateSerialized(raw.serialized);
      const binding = bindingIdentity(raw.binding);
      const at = nowMs();
      purge(at);
      let value = randomToken();
      if (typeof value !== 'string' || !TOKEN_RE.test(value) || entries.has(value)) {
        fail('DIAGNOSTIC_TOKEN_FAILED', '无法创建诊断预览');
      }
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      const expiresMs = at + ttlMs;
      const expiresAt = new Date(expiresMs).toISOString();
      entries.set(value, { serialized, binding, expiresMs, expiresAt });
      return Object.freeze({ token: value, expiresAt });
    },
    get,
    consume(value, binding) {
      const record = get(value, binding);
      entries.delete(value);
      return record;
    },
    consumeCommitted(value, binding, expectedSerialized) {
      const key = token(value);
      const record = entries.get(key);
      if (!record ||
          record.binding !== bindingIdentity(binding) ||
          record.serialized !== expectedSerialized) {
        return false;
      }
      // The handler calls this only after a synchronous write/fsync that began
      // while get() still proved the token live. Do not re-run the TTL clock:
      // crossing the deadline during that durable write cannot turn a committed
      // file into a user-visible failure.
      entries.delete(key);
      return true;
    },
    clear() { entries.clear(); },
    size() { purge(); return entries.size; },
  });
}

function writeDiagnosticFileExclusive(filePath, serialized) {
  validateSerialized(serialized);
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) ||
      path.basename(filePath) === '.' || path.basename(filePath) === '..') {
    fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出位置无效');
  }
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); }
  catch (_) { fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出目录不存在'); }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出目录不安全');
  }
  let canonicalParent;
  try { canonicalParent = fs.realpathSync(parent); }
  catch (_) { fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出目录不可访问'); }
  const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
  let fd;
  let createdIdentity = null;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    const createdStat = fs.fstatSync(fd);
    if (!createdStat.isFile() || createdStat.nlink !== 1) {
      fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出目标无效');
    }
    createdIdentity = { dev: createdStat.dev, ino: createdStat.ino };

    // The native save dialog returns a path, but the leaf directory can be
    // renamed and replaced with a symlink before open(). Re-check both the
    // selected directory and the newly created inode before writing any JSON.
    const currentParent = fs.lstatSync(parent);
    const currentTarget = fs.lstatSync(target);
    const currentCanonicalParent = fs.realpathSync(parent);
    const currentCanonicalTarget = fs.realpathSync(target);
    if (currentParent.isSymbolicLink() || !currentParent.isDirectory() ||
        currentParent.dev !== parentIdentity.dev ||
        currentParent.ino !== parentIdentity.ino ||
        currentCanonicalParent !== canonicalParent ||
        currentTarget.isSymbolicLink() ||
        currentTarget.nlink !== 1 ||
        currentTarget.dev !== createdIdentity.dev ||
        currentTarget.ino !== createdIdentity.ino ||
        path.dirname(currentCanonicalTarget) !== canonicalParent) {
      fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出位置在写入前发生变化');
    }

    fs.fchmodSync(fd, 0o600);
    const beforeWrite = fs.fstatSync(fd);
    if (!beforeWrite.isFile() || beforeWrite.nlink !== 1 ||
        beforeWrite.dev !== createdIdentity.dev ||
        beforeWrite.ino !== createdIdentity.ino) {
      fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出目标在写入前发生变化');
    }
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(target);
        if (!current.isSymbolicLink() &&
            current.dev === createdIdentity.dev &&
            current.ino === createdIdentity.ino) {
          fs.unlinkSync(target);
        }
      } catch (_) {}
    }
    if (error?.code === 'EEXIST') {
      fail('DIAGNOSTIC_TARGET_EXISTS', '同名诊断文件已存在，请选择新名称');
    }
    if (error instanceof DiagnosticExportError) throw error;
    fail('DIAGNOSTIC_WRITE_FAILED', '诊断文件保存失败，请检查目录权限');
  }
  return Object.freeze({ bytes: Buffer.byteLength(serialized, 'utf8') });
}

module.exports = {
  BUNDLE_SCHEMA,
  PREVIEW_SCHEMA,
  EXPORT_SCHEMA,
  MAX_SERIALIZED_BYTES,
  MAX_DIAGNOSTICS,
  PREVIEW_TTL_MS,
  DiagnosticExportError,
  buildDiagnosticBundle,
  serializeDiagnosticBundle,
  createDiagnosticRecorder,
  createDiagnosticPreviewStore,
  writeDiagnosticFileExclusive,
};
