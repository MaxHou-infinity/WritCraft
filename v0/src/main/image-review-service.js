'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REVIEW_SCHEMA = 'writcraft.image-review/v1';
const EVIDENCE_SCHEMA = 'writcraft.image-reviews/v1';
const AGGREGATE_SCHEMA = 'writcraft.image-review-aggregate/v1';
const TOKEN_RE = /^irv_[a-f0-9]{48}$/;
const OPERATION_ID_RE = /^[a-f0-9]{32,128}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COST_MINOR_UNITS = 100_000_000;
const MAX_EVIDENCE_RECORDS = 1000;
const MAX_EVIDENCE_BYTES = 512 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CAPABILITIES = 64;
const DECISIONS = new Set(['inserted', 'kept', 'deleted']);
const CURRENCIES = new Set(['CNY', 'USD']);
const BINDING_KEYS = new Set([
  'webContentsId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
  'navigationEpoch',
]);
const ISSUE_KEYS = new Set([
  ...BINDING_KEYS, 'operationId', 'assetPath', 'assetDigest',
]);
const REQUIRED_REVIEW_KEYS = new Set(['token', 'decision', 'qualityRating']);
const OPTIONAL_REVIEW_KEYS = new Set(['costMinorUnits', 'currency']);
const EVIDENCE_KEYS = new Set([
  'operationId', 'decision', 'qualityRating', 'costMinorUnits', 'currency',
  'timestamp',
]);

class ImageReviewError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ImageReviewError';
    this.code = code;
    this.committed = options.committed === true;
    this.retryable = options.retryable === true;
    this.decision = options.decision || null;
  }
}

function fail(code, message, options) {
  throw new ImageReviewError(code, message, options);
}

function strictObject(value, allowed, required, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label}无效`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key) || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true) {
      fail(code, `${label}包含禁止字段`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(descriptors, key)) fail(code, `${label}缺少字段`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) =>
    [key, descriptor.value]));
}

function safeInteger(value, maximum, code, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label}超出安全范围`);
  }
  return value;
}

function isoTimestamp(value, code = 'IMAGE_REVIEW_EVIDENCE_CORRUPT') {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) ||
      Number.isNaN(Date.parse(text))) {
    fail(code, '图片审阅时间无效');
  }
  return text;
}

function readNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('IMAGE_REVIEW_TIME_INVALID', '图片审阅时间无效');
  return date;
}

function canonicalRoot(fileSystem, rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) ||
      rootPath.includes('\u0000')) {
    fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅项目绑定无效');
  }
  const resolved = path.resolve(rootPath);
  let stat;
  try { stat = fileSystem.lstatSync(resolved); }
  catch (_) { fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅项目不存在'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅项目目录不可信');
  }
  let canonical;
  try { canonical = fileSystem.realpathSync(resolved); }
  catch (_) { fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅项目目录不可信'); }
  if (canonical !== resolved) fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅项目路径不规范');
  return canonical;
}

function normalizeBinding(raw, fileSystem = fs) {
  const value = strictObject(
    raw,
    BINDING_KEYS,
    BINDING_KEYS,
    'IMAGE_REVIEW_BINDING_INVALID',
    '图片审阅绑定'
  );
  const text = field => {
    if (typeof value[field] !== 'string' || !value[field] ||
        value[field].length > 256 || /[\u0000-\u001f\u007f]/.test(value[field])) {
      fail('IMAGE_REVIEW_BINDING_INVALID', '图片审阅绑定无效');
    }
    return value[field];
  };
  return Object.freeze({
    webContentsId: safeInteger(
      value.webContentsId,
      0x7fffffff,
      'IMAGE_REVIEW_BINDING_INVALID',
      '窗口绑定',
      1
    ),
    projectInstanceId: text('projectInstanceId'),
    rootPath: canonicalRoot(fileSystem, value.rootPath),
    mutationGeneration: safeInteger(
      value.mutationGeneration,
      Number.MAX_SAFE_INTEGER,
      'IMAGE_REVIEW_BINDING_INVALID',
      '项目代际'
    ),
    navigationEpoch: safeInteger(
      value.navigationEpoch,
      Number.MAX_SAFE_INTEGER,
      'IMAGE_REVIEW_BINDING_INVALID',
      '页面代际'
    ),
  });
}

function bindingIdentity(binding) {
  return [
    binding.webContentsId,
    binding.projectInstanceId,
    binding.rootPath,
    binding.mutationGeneration,
    binding.navigationEpoch,
  ].join('\u0000');
}

function normalizeAssetPath(assetPath, digest) {
  if (typeof assetPath !== 'string' || assetPath !== assetPath.normalize('NFC') ||
      assetPath.includes('\\') || assetPath.startsWith('/') ||
      !/^assets\/generated\/image-[a-f0-9]{64}\.(?:png|jpg)$/.test(assetPath) ||
      !DIGEST_RE.test(digest || '') ||
      !assetPath.startsWith(`assets/generated/image-${digest}.`)) {
    fail('IMAGE_REVIEW_ASSET_INVALID', '图片审阅资产身份无效');
  }
  return assetPath;
}

function directoryIdentity(root, fileSystem = fs) {
  let cursor = root;
  for (const segment of ['assets', 'generated']) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fileSystem.lstatSync(cursor); }
    catch (_) { fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片目录不存在'); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片目录不可信');
    }
    let canonical;
    try { canonical = fileSystem.realpathSync(cursor); }
    catch (_) { fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片目录不可信'); }
    if (canonical !== cursor || !canonical.startsWith(`${root}${path.sep}`)) {
      fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片目录已越出项目');
    }
  }
  const stat = fileSystem.lstatSync(cursor);
  return Object.freeze({ path: cursor, dev: stat.dev, ino: stat.ino });
}

function trashDirectoryIdentity(root, fileSystem = fs) {
  const metadata = evidenceDirectory(root, fileSystem, true);
  const directory = path.join(metadata.path, 'image-trash');
  if (!fileSystem.existsSync(directory)) {
    try { fileSystem.mkdirSync(directory, { mode: 0o700 }); }
    catch (_) { fail('IMAGE_REVIEW_DELETE_FAILED', '无法创建图片废纸篓'); }
  }
  let stat;
  let canonical;
  try {
    stat = fileSystem.lstatSync(directory);
    canonical = fileSystem.realpathSync(directory);
  } catch (_) {
    fail('IMAGE_REVIEW_DELETE_FAILED', '图片废纸篓不可用');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      canonical !== directory || !canonical.startsWith(`${root}${path.sep}`)) {
    fail('IMAGE_REVIEW_DELETE_FAILED', '图片废纸篓不可信');
  }
  return Object.freeze({ path: directory, dev: stat.dev, ino: stat.ino });
}

function sameInode(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function hashFile(fileSystem, target, size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片大小无效');
  }
  let bytes;
  try { bytes = fileSystem.readFileSync(target); }
  catch (_) { fail('IMAGE_REVIEW_ASSET_UNSAFE', '无法读取生成图片'); }
  if (!Buffer.isBuffer(bytes) || bytes.length !== size || bytes.length > MAX_IMAGE_BYTES) {
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片读取结果无效');
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inspectAsset(root, assetPath, digest, fileSystem = fs, expected = null) {
  const directory = directoryIdentity(root, fileSystem);
  const target = path.join(root, ...assetPath.split('/'));
  if (path.dirname(target) !== directory.path) {
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片位置无效');
  }
  let stat;
  try { stat = fileSystem.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ missing: true, directory, target });
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '无法核验生成图片');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      stat.size < 1 || stat.size > MAX_IMAGE_BYTES) {
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片不是安全的单链接常规文件');
  }
  let canonical;
  try { canonical = fileSystem.realpathSync(target); }
  catch (_) { fail('IMAGE_REVIEW_ASSET_UNSAFE', '无法核验生成图片路径'); }
  if (canonical !== target || !canonical.startsWith(`${directory.path}${path.sep}`)) {
    fail('IMAGE_REVIEW_ASSET_UNSAFE', '生成图片路径不可信');
  }
  if (expected && (!sameInode(stat, expected) || stat.size !== expected.size)) {
    fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片身份已经变化');
  }
  if (hashFile(fileSystem, target, stat.size) !== digest) {
    fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片内容已经变化');
  }
  const after = fileSystem.lstatSync(target);
  if (!sameInode(stat, after) || stat.size !== after.size || after.nlink !== 1) {
    fail('IMAGE_REVIEW_ASSET_CHANGED', '核验期间生成图片身份发生变化');
  }
  const directoryAfter = directoryIdentity(root, fileSystem);
  if (!sameInode(directory, directoryAfter)) {
    fail('IMAGE_REVIEW_ASSET_CHANGED', '核验期间生成图片目录发生变化');
  }
  return Object.freeze({
    missing: false,
    directory,
    target,
    identity: Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size }),
  });
}

function normalizeReviewRequest(raw) {
  const allowed = new Set([...REQUIRED_REVIEW_KEYS, ...OPTIONAL_REVIEW_KEYS]);
  const value = strictObject(
    raw,
    allowed,
    REQUIRED_REVIEW_KEYS,
    'IMAGE_REVIEW_REQUEST_INVALID',
    '图片审阅请求'
  );
  if (!TOKEN_RE.test(value.token || '') || !DECISIONS.has(value.decision)) {
    fail('IMAGE_REVIEW_REQUEST_INVALID', '图片审阅身份或决定无效');
  }
  const qualityRating = safeInteger(
    value.qualityRating,
    5,
    'IMAGE_REVIEW_REQUEST_INVALID',
    '图片质量评分',
    1
  );
  const hasCost = Object.hasOwn(value, 'costMinorUnits');
  const hasCurrency = Object.hasOwn(value, 'currency');
  if (hasCost !== hasCurrency) {
    fail('IMAGE_REVIEW_REQUEST_INVALID', '成本与币种必须同时提供');
  }
  let costMinorUnits = null;
  let currency = null;
  if (hasCost) {
    costMinorUnits = safeInteger(
      value.costMinorUnits,
      MAX_COST_MINOR_UNITS,
      'IMAGE_REVIEW_REQUEST_INVALID',
      '图片成本'
    );
    if (!CURRENCIES.has(value.currency)) {
      fail('IMAGE_REVIEW_REQUEST_INVALID', '图片成本币种无效');
    }
    currency = value.currency;
  }
  return Object.freeze({
    token: value.token,
    decision: value.decision,
    qualityRating,
    costMinorUnits,
    currency,
  });
}

function sameReview(left, right) {
  return left.token === right.token &&
    left.decision === right.decision &&
    left.qualityRating === right.qualityRating &&
    left.costMinorUnits === right.costMinorUnits &&
    left.currency === right.currency;
}

function evidenceDirectory(root, fileSystem, create) {
  const directory = path.join(root, '.writcraft');
  if (!fileSystem.existsSync(directory)) {
    if (!create) return null;
    try { fileSystem.mkdirSync(directory, { mode: 0o700 }); }
    catch (_) { fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '无法创建图片审阅证据目录'); }
  }
  let stat;
  try { stat = fileSystem.lstatSync(directory); }
  catch (_) { fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据目录不可用'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据目录不可信');
  }
  let canonical;
  try { canonical = fileSystem.realpathSync(directory); }
  catch (_) { fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据目录不可信'); }
  if (canonical !== directory || !canonical.startsWith(`${root}${path.sep}`)) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据目录已越出项目');
  }
  return Object.freeze({ path: directory, stat });
}

function normalizeEvidenceRecord(raw) {
  const value = strictObject(
    raw,
    EVIDENCE_KEYS,
    EVIDENCE_KEYS,
    'IMAGE_REVIEW_EVIDENCE_CORRUPT',
    '图片审阅证据'
  );
  if (!OPERATION_ID_RE.test(value.operationId || '') ||
      !DECISIONS.has(value.decision)) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据身份无效');
  }
  const qualityRating = safeInteger(
    value.qualityRating,
    5,
    'IMAGE_REVIEW_EVIDENCE_CORRUPT',
    '图片质量评分',
    1
  );
  if ((value.costMinorUnits === null) !== (value.currency === null)) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅成本证据无效');
  }
  let costMinorUnits = null;
  let currency = null;
  if (value.costMinorUnits !== null) {
    costMinorUnits = safeInteger(
      value.costMinorUnits,
      MAX_COST_MINOR_UNITS,
      'IMAGE_REVIEW_EVIDENCE_CORRUPT',
      '图片成本'
    );
    if (!CURRENCIES.has(value.currency)) {
      fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片成本币种无效');
    }
    currency = value.currency;
  }
  return Object.freeze({
    operationId: value.operationId,
    decision: value.decision,
    qualityRating,
    costMinorUnits,
    currency,
    timestamp: isoTimestamp(value.timestamp),
  });
}

function emptyEvidence() {
  return Object.freeze({
    schema: EVIDENCE_SCHEMA,
    updatedAt: null,
    records: Object.freeze([]),
  });
}

function readEvidence(root, fileSystem = fs) {
  const directory = evidenceDirectory(root, fileSystem, false);
  if (!directory) return emptyEvidence();
  const target = path.join(directory.path, 'image-reviews.json');
  if (!fileSystem.existsSync(target)) return emptyEvidence();
  let stat;
  try { stat = fileSystem.lstatSync(target); }
  catch (_) { fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '无法读取图片审阅证据'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      stat.size < 2 || stat.size > MAX_EVIDENCE_BYTES) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据文件不可信');
  }
  let raw;
  try { raw = JSON.parse(fileSystem.readFileSync(target, 'utf8')); }
  catch (_) { fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据无法解析'); }
  const value = strictObject(
    raw,
    new Set(['schema', 'updatedAt', 'records']),
    new Set(['schema', 'updatedAt', 'records']),
    'IMAGE_REVIEW_EVIDENCE_CORRUPT',
    '图片审阅证据文件'
  );
  if (value.schema !== EVIDENCE_SCHEMA || !Array.isArray(value.records) ||
      value.records.length > MAX_EVIDENCE_RECORDS) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据文件无效');
  }
  const records = value.records.map(normalizeEvidenceRecord);
  if (new Set(records.map(record => record.operationId)).size !== records.length) {
    fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据包含重复操作');
  }
  const updatedAt = isoTimestamp(value.updatedAt);
  return Object.freeze({
    schema: EVIDENCE_SCHEMA,
    updatedAt,
    records: Object.freeze(records),
  });
}

function syncDirectory(fileSystem, directory) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) {}
    }
    throw error;
  }
}

function sameStat(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mode === right.mode;
}

function writeEvidence(root, next, fileSystem = fs) {
  const directory = evidenceDirectory(root, fileSystem, true);
  const target = path.join(directory.path, 'image-reviews.json');
  let expected = null;
  if (fileSystem.existsSync(target)) {
    expected = fileSystem.lstatSync(target);
    if (expected.isSymbolicLink() || !expected.isFile() || expected.nlink !== 1) {
      fail('IMAGE_REVIEW_EVIDENCE_CORRUPT', '图片审阅证据文件不可信');
    }
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅证据超过安全上限');
  }
  const temporary = path.join(
    directory.path,
    `.image-reviews.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let descriptor;
  let temporaryIdentity;
  try {
    descriptor = fileSystem.openSync(temporary, 'wx', 0o600);
    temporaryIdentity = fileSystem.fstatSync(descriptor);
    if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1) {
      fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅临时文件不可信');
    }
    fileSystem.fchmodSync(descriptor, 0o600);
    fileSystem.writeFileSync(descriptor, serialized, 'utf8');
    fileSystem.fsyncSync(descriptor);
    const writtenIdentity = fileSystem.fstatSync(descriptor);
    if (!sameInode(temporaryIdentity, writtenIdentity) ||
        writtenIdentity.nlink !== 1 ||
        writtenIdentity.size !== Buffer.byteLength(serialized, 'utf8')) {
      fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅临时文件发生变化');
    }
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    const currentDirectory = evidenceDirectory(root, fileSystem, false);
    if (!sameInode(directory.stat, currentDirectory.stat)) {
      fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅证据目录发生变化');
    }
    const currentExists = fileSystem.existsSync(target);
    if (Boolean(expected) !== currentExists ||
        (expected && (() => {
          const current = fileSystem.lstatSync(target);
          return current.isSymbolicLink() || !current.isFile() ||
            current.nlink !== 1 || !sameStat(expected, current);
        })())) {
      fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅证据发生并发变化');
    }
    const currentTemporary = fileSystem.lstatSync(temporary);
    if (currentTemporary.isSymbolicLink() || !currentTemporary.isFile() ||
        currentTemporary.nlink !== 1 || !sameStat(writtenIdentity, currentTemporary)) {
      fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅临时文件身份发生变化');
    }
    fileSystem.renameSync(temporary, target);
    syncDirectory(fileSystem, directory.path);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) {}
    }
    try {
      const currentTemporary = fileSystem.lstatSync(temporary);
      if (temporaryIdentity && currentTemporary.isFile() &&
          !currentTemporary.isSymbolicLink() &&
          currentTemporary.dev === temporaryIdentity.dev &&
          currentTemporary.ino === temporaryIdentity.ino) {
        fileSystem.unlinkSync(temporary);
      }
    } catch (_) {}
    if (error instanceof ImageReviewError) throw error;
    fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅证据写入失败');
  }
}

function appendEvidence(root, rawRecord, fileSystem = fs, now = () => new Date()) {
  const record = normalizeEvidenceRecord(rawRecord);
  const current = readEvidence(root, fileSystem);
  const existing = current.records.find(item => item.operationId === record.operationId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      fail('IMAGE_REVIEW_EVIDENCE_CONFLICT', '图片审阅证据与既有终态冲突');
    }
    // A previous atomic rename may have committed before its parent-directory
    // fsync failed. Exact retry must repeat that durability barrier.
    const directory = evidenceDirectory(root, fileSystem, false);
    syncDirectory(fileSystem, directory.path);
    return Object.freeze({ record: existing, alreadyRecorded: true });
  }
  if (current.records.length >= MAX_EVIDENCE_RECORDS) {
    fail('IMAGE_REVIEW_EVIDENCE_WRITE_FAILED', '图片审阅证据数量达到上限');
  }
  const updatedAt = readNow(now).toISOString();
  const next = {
    schema: EVIDENCE_SCHEMA,
    updatedAt,
    records: [...current.records, record],
  };
  writeEvidence(root, next, fileSystem);
  return Object.freeze({ record, alreadyRecorded: false });
}

function aggregateEvidence(rootPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const root = canonicalRoot(fileSystem, rootPath);
  const evidence = readEvidence(root, fileSystem);
  const decisions = { inserted: 0, kept: 0, deleted: 0 };
  let qualityTotal = 0;
  const costs = {
    CNY: { sampleSize: 0, totalMinorUnits: 0 },
    USD: { sampleSize: 0, totalMinorUnits: 0 },
  };
  for (const record of evidence.records) {
    decisions[record.decision] += 1;
    qualityTotal += record.qualityRating;
    if (record.currency) {
      costs[record.currency].sampleSize += 1;
      costs[record.currency].totalMinorUnits += record.costMinorUnits;
    }
  }
  const publicCosts = Object.fromEntries(Object.entries(costs).map(([currency, value]) => [
    currency,
    Object.freeze({
      sampleSize: value.sampleSize,
      totalMinorUnits: value.totalMinorUnits,
      averageMinorUnits: value.sampleSize
        ? Number((value.totalMinorUnits / value.sampleSize).toFixed(2))
        : null,
    }),
  ]));
  return Object.freeze({
    schema: AGGREGATE_SCHEMA,
    sampleSize: evidence.records.length,
    averageQualityRating: evidence.records.length
      ? Number((qualityTotal / evidence.records.length).toFixed(2))
      : null,
    decisions: Object.freeze(decisions),
    costs: Object.freeze(publicCosts),
    smallSample: evidence.records.length < 20,
  });
}

function createImageReviewService(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const now = options.now || (() => new Date());
  const randomToken = options.randomToken ||
    (() => `irv_${crypto.randomBytes(24).toString('hex')}`);
  const ttlMs = options.ttlMs === undefined
    ? DEFAULT_TTL_MS
    : safeInteger(
      options.ttlMs,
      DEFAULT_TTL_MS,
      'IMAGE_REVIEW_LIMIT_INVALID',
      '图片审阅期限',
      1000
    );
  const maxCapabilities = options.maxCapabilities === undefined
    ? DEFAULT_MAX_CAPABILITIES
    : safeInteger(
      options.maxCapabilities,
      64,
      'IMAGE_REVIEW_LIMIT_INVALID',
      '图片审阅数量',
      1
    );
  const records = new Map();

  function nowMs() {
    return readNow(now).getTime();
  }

  function purge(at = nowMs()) {
    for (const [token, record] of records) {
      // Once a manuscript insert or trash move has committed, expiration
      // cannot erase the only retry path for evidence/durability settlement.
      if (record.phase !== 'committed_pending_evidence' &&
          record.expiresMs <= at) records.delete(token);
    }
  }

  function ensureIssueAvailable(binding, operationId) {
    if (!OPERATION_ID_RE.test(operationId || '')) {
      fail('IMAGE_REVIEW_ISSUE_INVALID', '图片审阅操作身份无效');
    }
    const at = nowMs();
    purge(at);
    if ([...records.values()].some(record =>
      record.bindingIdentity === bindingIdentity(binding) &&
      record.phase !== 'terminal')) {
      fail('IMAGE_REVIEW_PENDING', '请先结算当前图片预览');
    }
    if ([...records.values()].some(record => record.operationId === operationId)) {
      fail('IMAGE_REVIEW_ISSUE_INVALID', '图片生成操作已经签发审阅');
    }
    if (records.size >= maxCapabilities) {
      fail('IMAGE_REVIEW_CAPACITY', '图片审阅数量达到上限');
    }
  }

  function assertIssueAvailable(rawBinding, operationId) {
    const binding = normalizeBinding(rawBinding, fileSystem);
    ensureIssueAvailable(binding, operationId);
    return true;
  }

  function currentRecord(token, binding) {
    const at = nowMs();
    purge(at);
    const record = records.get(token);
    if (!record ||
        (record.phase !== 'committed_pending_evidence' && record.expiresMs <= at)) {
      fail('IMAGE_REVIEW_STALE', '图片审阅已经过期或不存在');
    }
    const normalized = normalizeBinding(binding, fileSystem);
    if (record.bindingIdentity !== bindingIdentity(normalized)) {
      fail('IMAGE_REVIEW_STALE', '图片审阅不属于当前窗口或项目状态');
    }
    return record;
  }

  function issue(raw) {
    const value = strictObject(
      raw,
      ISSUE_KEYS,
      ISSUE_KEYS,
      'IMAGE_REVIEW_ISSUE_INVALID',
      '图片审阅签发'
    );
    const binding = normalizeBinding(Object.fromEntries(
      [...BINDING_KEYS].map(key => [key, value[key]])
    ), fileSystem);
    if (!OPERATION_ID_RE.test(value.operationId || '') ||
        !DIGEST_RE.test(value.assetDigest || '')) {
      fail('IMAGE_REVIEW_ISSUE_INVALID', '图片审阅操作身份无效');
    }
    const assetPath = normalizeAssetPath(value.assetPath, value.assetDigest);
    const inspected = inspectAsset(
      binding.rootPath,
      assetPath,
      value.assetDigest,
      fileSystem
    );
    if (inspected.missing) fail('IMAGE_REVIEW_ASSET_INVALID', '生成图片不存在');
    const at = nowMs();
    ensureIssueAvailable(binding, value.operationId);
    const token = randomToken();
    if (!TOKEN_RE.test(token || '') || records.has(token)) {
      fail('IMAGE_REVIEW_TOKEN_FAILED', '无法签发图片审阅');
    }
    const expiresMs = at + ttlMs;
    records.set(token, {
      token,
      binding,
      bindingIdentity: bindingIdentity(binding),
      operationId: value.operationId,
      assetPath,
      assetDigest: value.assetDigest,
      assetIdentity: inspected.identity,
      directoryIdentity: inspected.directory,
      expiresMs,
      expiresAt: new Date(expiresMs).toISOString(),
      phase: 'live',
      review: null,
      evidenceRecord: null,
      deleteNeedsFsync: false,
      trashPath: null,
      trashIdentity: null,
      result: null,
    });
    return Object.freeze({
      ok: true,
      schema: REVIEW_SCHEMA,
      token,
      expiresAt: new Date(expiresMs).toISOString(),
    });
  }

  function evidenceFor(record, review) {
    return {
      operationId: record.operationId,
      decision: review.decision,
      qualityRating: review.qualityRating,
      costMinorUnits: review.costMinorUnits,
      currency: review.currency,
      timestamp: readNow(now).toISOString(),
    };
  }

  function publicResult(record, options = {}) {
    return Object.freeze({
      ok: true,
      schema: REVIEW_SCHEMA,
      decision: record.review.decision,
      operationId: record.operationId,
      committed: true,
      responseRecovered: options.responseRecovered === true,
    });
  }

  function persistCommitted(record) {
    if (!record.evidenceRecord) {
      record.evidenceRecord = Object.freeze(evidenceFor(record, record.review));
    }
    try {
      appendEvidence(
        record.binding.rootPath,
        record.evidenceRecord,
        fileSystem,
        now
      );
    } catch (error) {
      fail(
        'IMAGE_REVIEW_COMMITTED_WARNING',
        '图片决定已提交，但审阅证据尚待补记',
        { committed: true, retryable: true, decision: record.review.decision }
      );
    }
    record.phase = 'terminal';
    record.result = publicResult(record);
    return record.result;
  }

  function finishPendingEvidence(record) {
    if (record.review.decision === 'deleted' && record.deleteNeedsFsync) {
      try {
        const directory = directoryIdentity(record.binding.rootPath, fileSystem);
        if (!sameInode(directory, record.directoryIdentity)) {
          fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片目录已经变化');
        }
        syncDirectory(fileSystem, directory.path);
        if (record.trashPath) {
          const trash = trashDirectoryIdentity(record.binding.rootPath, fileSystem);
          if (path.dirname(record.trashPath) !== trash.path) {
            fail('IMAGE_REVIEW_ASSET_CHANGED', '图片废纸篓绑定已经变化');
          }
          syncDirectory(fileSystem, trash.path);
        }
        record.deleteNeedsFsync = false;
      } catch (error) {
        if (error instanceof ImageReviewError) throw error;
        fail(
          'IMAGE_REVIEW_COMMITTED_WARNING',
          '图片已经删除，但目录持久化仍待确认',
          { committed: true, retryable: true, decision: 'deleted' }
        );
      }
    }
    const result = persistCommitted(record);
    record.result = publicResult(record, { responseRecovered: true });
    return record.result;
  }

  function commitDelete(record) {
    const inspected = inspectAsset(
      record.binding.rootPath,
      record.assetPath,
      record.assetDigest,
      fileSystem,
      record.assetIdentity
    );
    if (!sameInode(inspected.directory, record.directoryIdentity)) {
      fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片目录已经变化');
    }
    if (inspected.missing) {
      if (record.trashPath && record.trashIdentity) {
        let trashed;
        try { trashed = fileSystem.lstatSync(record.trashPath); }
        catch (_) { fail('IMAGE_REVIEW_ASSET_CHANGED', '图片废纸篓中的资产无法核验'); }
        if (trashed.isSymbolicLink() || !trashed.isFile() ||
            !sameInode(trashed, record.trashIdentity) ||
            trashed.size !== record.trashIdentity.size) {
          fail('IMAGE_REVIEW_ASSET_CHANGED', '图片废纸篓中的资产已经变化');
        }
      }
      return;
    }
    const trash = trashDirectoryIdentity(record.binding.rootPath, fileSystem);
    const trashPath = path.join(
      trash.path,
      `${record.operationId}-${crypto.randomBytes(12).toString('hex')}.asset`
    );
    try {
      fileSystem.renameSync(inspected.target, trashPath);
    } catch (_) {
      fail('IMAGE_REVIEW_DELETE_FAILED', '生成图片未能移入可恢复废纸篓');
    }
    let moved;
    try { moved = fileSystem.lstatSync(trashPath); }
    catch (_) {
      fail(
        'IMAGE_REVIEW_COMMITTED_WARNING',
        '图片已离开素材目录，但废纸篓状态仍待确认',
        { committed: true, retryable: true, decision: 'deleted' }
      );
    }
    if (moved.isSymbolicLink() || !moved.isFile() ||
        !sameInode(moved, inspected.identity) ||
        moved.size !== inspected.identity.size ||
        moved.nlink !== 1) {
      // Never permanently unlink a path-selected file. Best-effort restore a
      // foreign concurrent replacement if rename captured the wrong inode.
      try {
        if (!fileSystem.existsSync(inspected.target)) {
          fileSystem.renameSync(trashPath, inspected.target);
        }
      } catch (_) {}
      fail('IMAGE_REVIEW_ASSET_CHANGED', '移动时生成图片身份发生变化');
    }
    record.trashPath = trashPath;
    record.trashIdentity = Object.freeze({
      dev: moved.dev,
      ino: moved.ino,
      size: moved.size,
    });
    record.deleteNeedsFsync = true;
    try {
      syncDirectory(fileSystem, inspected.directory.path);
      syncDirectory(fileSystem, trash.path);
      record.deleteNeedsFsync = false;
    } catch (_) {
      fail(
        'IMAGE_REVIEW_COMMITTED_WARNING',
        '图片已经删除，但目录持久化仍待确认',
        { committed: true, retryable: true, decision: 'deleted' }
      );
    }
  }

  function settle(binding, rawRequest, settlement = {}) {
    const review = normalizeReviewRequest(rawRequest);
    const record = currentRecord(review.token, binding);
    if (record.phase === 'terminal') {
      if (sameReview(record.review, review)) {
        return publicResult(record, { responseRecovered: true });
      }
      fail('IMAGE_REVIEW_REPLAY', '图片审阅已经终结');
    }
    if (record.phase === 'committed_pending_evidence') {
      if (!sameReview(record.review, review)) {
        fail('IMAGE_REVIEW_REPLAY', '已提交图片决定不能更改');
      }
      return finishPendingEvidence(record);
    }
    if (record.phase !== 'live') fail('IMAGE_REVIEW_STALE', '图片审阅状态无效');

    if (review.decision === 'inserted') {
      const inspected = inspectAsset(
        record.binding.rootPath,
        record.assetPath,
        record.assetDigest,
        fileSystem,
        record.assetIdentity
      );
      if (inspected.missing || !sameInode(inspected.directory, record.directoryIdentity)) {
        fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片已经不存在或发生变化');
      }
      if (typeof settlement.commitInserted !== 'function') {
        fail('IMAGE_REVIEW_INSERT_FAILED', '正文插入提交器不可用');
      }
      let committed;
      try { committed = settlement.commitInserted(); }
      catch (_) { fail('IMAGE_REVIEW_INSERT_FAILED', '正文引用未能提交'); }
      if (!committed || committed.ok !== true || committed.committed !== true) {
        fail('IMAGE_REVIEW_INSERT_FAILED', '正文引用未能提交');
      }
    } else if (review.decision === 'kept') {
      const inspected = inspectAsset(
        record.binding.rootPath,
        record.assetPath,
        record.assetDigest,
        fileSystem,
        record.assetIdentity
      );
      if (inspected.missing || !sameInode(inspected.directory, record.directoryIdentity)) {
        fail('IMAGE_REVIEW_ASSET_CHANGED', '生成图片已经不存在或发生变化');
      }
    } else if (review.decision === 'deleted') {
      try {
        commitDelete(record);
      } catch (error) {
        if (error instanceof ImageReviewError && error.committed) {
          record.review = review;
          record.phase = 'committed_pending_evidence';
        }
        throw error;
      }
    }

    record.review = review;
    record.phase = 'committed_pending_evidence';
    return persistCommitted(record);
  }

  return Object.freeze({
    assertIssueAvailable,
    issue,
    settle,
    inspect(token) {
      purge();
      const record = records.get(token);
      if (!record) return null;
      return Object.freeze({
        phase: record.phase,
        operationId: record.operationId,
        expiresAt: record.expiresAt,
      });
    },
    size() {
      purge();
      return records.size;
    },
    aggregate(rootPath) {
      return aggregateEvidence(rootPath, { fileSystem });
    },
  });
}

module.exports = {
  REVIEW_SCHEMA,
  EVIDENCE_SCHEMA,
  AGGREGATE_SCHEMA,
  TOKEN_RE,
  OPERATION_ID_RE,
  DIGEST_RE,
  MAX_IMAGE_BYTES,
  MAX_COST_MINOR_UNITS,
  DEFAULT_TTL_MS,
  ImageReviewError,
  normalizeReviewRequest,
  createImageReviewService,
  aggregateEvidence,
};
