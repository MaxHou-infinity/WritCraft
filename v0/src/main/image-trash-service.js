'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TRASH_SCHEMA = 'writcraft.image-trash/v1';
const POLICY = 'manual_until_restore_or_empty';
const ENTRY_RE = /^([a-f0-9]{32,128})-([a-f0-9]{24})\.asset$/;
const ITEM_TOKEN_RE = /^iti_[a-f0-9]{48}$/;
const SNAPSHOT_TOKEN_RE = /^its_[a-f0-9]{48}$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_VISIBLE = 50;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CAPACITY = 512;
const BINDING_KEYS = new Set([
  'webContentsId', 'projectInstanceId', 'rootPath', 'mutationGeneration',
  'navigationEpoch',
]);

class ImageTrashError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ImageTrashError';
    this.code = code;
    this.committed = options.committed === true;
    this.retryable = options.retryable === true;
  }
}

function fail(code, message, options) {
  throw new ImageTrashError(code, message, options);
}

function exactObject(value, keys, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label}无效`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.size ||
      Object.entries(descriptors).some(([key, descriptor]) =>
        !keys.has(key) || !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true)) {
    fail(code, `${label}包含禁止或缺失字段`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) fail(code, `${label}缺少字段`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) =>
    [key, descriptor.value]));
}

function safeInteger(value, minimum, maximum, code, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label}无效`);
  }
  return value;
}

function canonicalRoot(rootPath, fileSystem) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) ||
      rootPath.includes('\u0000')) {
    fail('IMAGE_TRASH_BINDING_INVALID', '图片废纸篓项目绑定无效');
  }
  const resolved = path.resolve(rootPath);
  let stat;
  let canonical;
  try {
    stat = fileSystem.lstatSync(resolved);
    canonical = fileSystem.realpathSync(resolved);
  } catch (_) {
    fail('IMAGE_TRASH_BINDING_INVALID', '图片废纸篓项目不可用');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || canonical !== resolved) {
    fail('IMAGE_TRASH_BINDING_INVALID', '图片废纸篓项目不可信');
  }
  return canonical;
}

function normalizeBinding(raw, fileSystem) {
  const value = exactObject(
    raw,
    BINDING_KEYS,
    'IMAGE_TRASH_BINDING_INVALID',
    '图片废纸篓绑定'
  );
  const boundedText = field => {
    if (typeof value[field] !== 'string' || !value[field] ||
        value[field].length > 256 ||
        /[\u0000-\u001f\u007f]/.test(value[field])) {
      fail('IMAGE_TRASH_BINDING_INVALID', '图片废纸篓绑定无效');
    }
    return value[field];
  };
  return Object.freeze({
    webContentsId: safeInteger(
      value.webContentsId, 1, 0x7fffffff,
      'IMAGE_TRASH_BINDING_INVALID', '窗口绑定'
    ),
    projectInstanceId: boundedText('projectInstanceId'),
    rootPath: canonicalRoot(value.rootPath, fileSystem),
    mutationGeneration: safeInteger(
      value.mutationGeneration, 0, Number.MAX_SAFE_INTEGER,
      'IMAGE_TRASH_BINDING_INVALID', '项目代际'
    ),
    navigationEpoch: safeInteger(
      value.navigationEpoch, 0, Number.MAX_SAFE_INTEGER,
      'IMAGE_TRASH_BINDING_INVALID', '页面代际'
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

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function safeDirectory(root, segments, fileSystem, missingAllowed = false) {
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat;
    let canonical;
    try {
      stat = fileSystem.lstatSync(cursor);
      canonical = fileSystem.realpathSync(cursor);
    } catch (error) {
      if (missingAllowed && error?.code === 'ENOENT') return null;
      fail('IMAGE_TRASH_UNSAFE', '图片废纸篓目录不可用');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        canonical !== cursor || !canonical.startsWith(`${root}${path.sep}`)) {
      fail('IMAGE_TRASH_UNSAFE', '图片废纸篓目录不可信');
    }
  }
  const stat = fileSystem.lstatSync(cursor);
  return Object.freeze({ path: cursor, dev: stat.dev, ino: stat.ino });
}

function trashDirectory(root, fileSystem, missingAllowed = false) {
  return safeDirectory(root, ['.writcraft', 'image-trash'], fileSystem, missingAllowed);
}

function generatedDirectory(root, fileSystem) {
  return safeDirectory(root, ['assets', 'generated'], fileSystem, false);
}

function operationDirectory(root, fileSystem) {
  const parent = safeDirectory(root, ['.writcraft'], fileSystem, false);
  const target = path.join(parent.path, 'image-trash-operations');
  try {
    fileSystem.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      fail('IMAGE_TRASH_UNSAFE', '无法创建图片废纸篓事务目录');
    }
  }
  return safeDirectory(
    root,
    ['.writcraft', 'image-trash-operations'],
    fileSystem,
    false
  );
}

function operationTarget(root, fileSystem) {
  const directory = operationDirectory(root, fileSystem);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const target = path.join(
      directory.path,
      `op_${crypto.randomBytes(24).toString('hex')}.asset`
    );
    if (!fileSystem.existsSync(target)) return { directory, target };
  }
  fail('IMAGE_TRASH_CAPACITY', '无法分配图片废纸篓事务位置');
}

function inspectEntries(root, fileSystem) {
  const directory = trashDirectory(root, fileSystem, true);
  if (!directory) return { directory: null, entries: [] };
  let names;
  try { names = fileSystem.readdirSync(directory.path); }
  catch (_) { fail('IMAGE_TRASH_UNSAFE', '无法读取图片废纸篓'); }
  if (names.length > MAX_ENTRIES) fail('IMAGE_TRASH_CAPACITY', '图片废纸篓条目过多');
  let totalBytes = 0;
  const entries = names.map(name => {
    if (!ENTRY_RE.test(name)) fail('IMAGE_TRASH_CORRUPT', '图片废纸篓包含未知条目');
    const target = path.join(directory.path, name);
    let stat;
    let canonical;
    try {
      stat = fileSystem.lstatSync(target);
      canonical = fileSystem.realpathSync(target);
    } catch (_) {
      fail('IMAGE_TRASH_CORRUPT', '图片废纸篓条目不可用');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
        stat.size < 1 || stat.size > MAX_IMAGE_BYTES ||
        canonical !== target || path.dirname(canonical) !== directory.path) {
      fail('IMAGE_TRASH_CORRUPT', '图片废纸篓条目不可信');
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      fail('IMAGE_TRASH_CAPACITY', '图片废纸篓总容量超过安全核验上限');
    }
    let bytes;
    let afterRead;
    try {
      bytes = fileSystem.readFileSync(target);
      afterRead = fileSystem.lstatSync(target);
    } catch (_) {
      fail('IMAGE_TRASH_CORRUPT', '图片废纸篓条目无法核验');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== stat.size ||
        afterRead.isSymbolicLink() || !afterRead.isFile() ||
        afterRead.nlink !== 1 || !sameInode(stat, afterRead) ||
        afterRead.size !== stat.size) {
      fail('IMAGE_TRASH_CORRUPT', '图片废纸篓条目读取期间发生变化');
    }
    const created = stat.birthtime instanceof Date && stat.birthtime.getTime() > 0
      ? stat.birthtime
      : stat.mtime;
    return Object.freeze({
      name,
      target,
      identity: Object.freeze({ dev: stat.dev, ino: stat.ino, size: stat.size }),
      digest: crypto.createHash('sha256').update(bytes).digest('hex'),
      createdAt: created.toISOString(),
    });
  }).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.name.localeCompare(right.name));
  const after = trashDirectory(root, fileSystem, false);
  if (!sameInode(directory, after)) fail('IMAGE_TRASH_STALE', '图片废纸篓读取期间发生变化');
  return { directory, entries };
}

function sniffImage(bytes) {
  const png = bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (png) return 'png';
  const jpeg = bytes.length >= 8 &&
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (jpeg) return 'jpg';
  fail('IMAGE_TRASH_CORRUPT', '废纸篓图片格式无法验证');
}

function syncDirectory(fileSystem, directory) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(directory, 'r');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
  } catch (_) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch (_) {}
    }
    fail(
      'IMAGE_TRASH_COMMITTED_WARNING',
      '图片操作已提交，但目录持久化仍待确认',
      { committed: true, retryable: true }
    );
  }
}

function createImageTrashService(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const now = options.now || (() => new Date());
  const randomToken = options.randomToken ||
    (kind => `${kind}_${crypto.randomBytes(24).toString('hex')}`);
  const ttlMs = options.ttlMs === undefined
    ? DEFAULT_TTL_MS
    : safeInteger(
      options.ttlMs, 1000, DEFAULT_TTL_MS,
      'IMAGE_TRASH_LIMIT_INVALID', '图片废纸篓期限'
    );
  const capacity = options.capacity === undefined
    ? DEFAULT_CAPACITY
    : safeInteger(
      options.capacity, 1, 4096,
      'IMAGE_TRASH_LIMIT_INVALID', '图片废纸篓能力数量'
    );
  const capabilities = new Map();

  function nowMs() {
    const value = typeof now === 'function' ? now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('IMAGE_TRASH_TIME_INVALID', '图片废纸篓时间无效');
    return date.getTime();
  }

  function purge(at = nowMs()) {
    for (const [token, record] of capabilities) {
      if (record.expiresMs <= at &&
          !['committed_partial', 'committed_pending_fsync'].includes(record.phase)) {
        capabilities.delete(token);
      }
    }
  }

  function token(kind) {
    const prefix = kind === 'item' ? 'iti' : 'its';
    const value = randomToken(prefix);
    const pattern = kind === 'item' ? ITEM_TOKEN_RE : SNAPSHOT_TOKEN_RE;
    if (typeof value !== 'string' || !pattern.test(value) || capabilities.has(value)) {
      fail('IMAGE_TRASH_TOKEN_FAILED', '无法创建图片废纸篓能力');
    }
    return value;
  }

  function addCapabilities(count) {
    purge();
    if (capabilities.size + count > capacity) {
      fail('IMAGE_TRASH_CAPACITY', '图片废纸篓能力达到上限');
    }
  }

  function current(rawToken, kind, rawBinding) {
    const pattern = kind === 'item' ? ITEM_TOKEN_RE : SNAPSHOT_TOKEN_RE;
    if (typeof rawToken !== 'string' || !pattern.test(rawToken)) {
      fail('IMAGE_TRASH_STALE', '图片废纸篓能力已经失效');
    }
    const record = capabilities.get(rawToken);
    const committed = record &&
      ['committed_partial', 'committed_pending_fsync'].includes(record.phase);
    if (!record || record.kind !== kind ||
        record.bindingIdentity !== bindingIdentity(normalizeBinding(rawBinding, fileSystem)) ||
        (!committed && record.expiresMs <= nowMs())) {
      fail('IMAGE_TRASH_STALE', '图片废纸篓能力已经失效');
    }
    return record;
  }

  function counts(root) {
    const inspected = inspectEntries(root, fileSystem);
    return {
      count: inspected.entries.length,
      bytes: inspected.entries.reduce((sum, entry) => sum + entry.identity.size, 0),
    };
  }

  function list(rawBinding) {
    const binding = normalizeBinding(rawBinding, fileSystem);
    const inspected = inspectEntries(binding.rootPath, fileSystem);
    const identity = bindingIdentity(binding);
    // A refresh intentionally supersedes old live/terminal UI capabilities for
    // the same owner. Preserve only committed-warning records that still own
    // the exact retry path for a mutation that may already have happened.
    for (const [value, record] of capabilities) {
      if (record.bindingIdentity === identity &&
          (record.phase === 'live' || record.phase === 'terminal')) {
        capabilities.delete(value);
      }
    }
    const visible = inspected.entries.slice(0, MAX_VISIBLE);
    addCapabilities(visible.length + (inspected.entries.length ? 1 : 0));
    const expiresMs = nowMs() + ttlMs;
    const items = visible.map(entry => {
      const value = token('item');
      capabilities.set(value, {
        kind: 'item',
        binding,
        bindingIdentity: identity,
        directory: inspected.directory,
        entry,
        expiresMs,
        phase: 'live',
        result: null,
      });
      return Object.freeze({
        token: value,
        createdAt: entry.createdAt,
        sizeBytes: entry.identity.size,
      });
    });
    let snapshotToken = null;
    if (inspected.entries.length) {
      snapshotToken = token('snapshot');
      capabilities.set(snapshotToken, {
        kind: 'snapshot',
        binding,
        bindingIdentity: identity,
        directory: inspected.directory,
        entries: inspected.entries,
        removed: new Set(),
        quarantines: new Map(),
        expiresMs,
        phase: 'live',
        result: null,
      });
    }
    return Object.freeze({
      ok: true,
      schema: TRASH_SCHEMA,
      policy: POLICY,
      totalCount: inspected.entries.length,
      totalBytes: inspected.entries.reduce((sum, entry) => sum + entry.identity.size, 0),
      items: Object.freeze(items),
      snapshotToken,
    });
  }

  function assertDirectory(record) {
    const currentDirectory = trashDirectory(record.binding.rootPath, fileSystem, false);
    if (!sameInode(record.directory, currentDirectory)) {
      fail('IMAGE_TRASH_STALE', '图片废纸篓目录已经变化');
    }
    return currentDirectory;
  }

  function moveToOperation(root, source) {
    const operation = operationTarget(root, fileSystem);
    try {
      fileSystem.renameSync(source, operation.target);
    } catch (error) {
      try {
        fileSystem.lstatSync(operation.target);
      } catch (_) {
        throw error;
      }
    }
    let identity;
    try {
      identity = fileSystem.lstatSync(operation.target);
    } catch (_) {
      fail('IMAGE_TRASH_STALE', '图片废纸篓事务文件无法核验');
    }
    return { ...operation, identity };
  }

  function unlinkOperation(operation) {
    try {
      fileSystem.unlinkSync(operation.target);
    } catch (error) {
      try {
        fileSystem.lstatSync(operation.target);
      } catch (inspectionError) {
        if (inspectionError?.code === 'ENOENT') return;
      }
      throw error;
    }
  }

  function preserveMovedEntry(operation, originalTarget) {
    try {
      fileSystem.linkSync(operation.target, originalTarget);
    } catch (_) {
      fail(
        'IMAGE_TRASH_COMMITTED_WARNING',
        '外部文件变化已安全隔离，请重新打开项目核验',
        { committed: true, retryable: false }
      );
    }
    try {
      unlinkOperation(operation);
    } catch (_) {
      fail(
        'IMAGE_TRASH_COMMITTED_WARNING',
        '外部文件已保留，但事务目录仍待人工核验',
        { committed: true, retryable: false }
      );
    }
  }

  function contentDigest(target, expectedSize) {
    let bytes;
    try { bytes = fileSystem.readFileSync(target); }
    catch (_) { fail('IMAGE_TRASH_STALE', '图片内容无法再次核验'); }
    if (!Buffer.isBuffer(bytes) || bytes.length !== expectedSize) {
      fail('IMAGE_TRASH_STALE', '图片内容已经变化');
    }
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  function removeExactPath(root, source, expected, expectedDigest = null) {
    const operation = moveToOperation(root, source);
    if (operation.identity.isSymbolicLink() || !operation.identity.isFile() ||
        !sameInode(operation.identity, expected) ||
        operation.identity.size !== expected.size ||
        (expectedDigest !== null &&
          contentDigest(operation.target, expected.size) !== expectedDigest)) {
      preserveMovedEntry(operation, source);
      fail('IMAGE_TRASH_STALE', '图片在提交瞬间发生变化，未删除外来文件');
    }
    unlinkOperation(operation);
    return operation.directory;
  }

  function publicRestore(record, recovered) {
    return Object.freeze({
      ok: true,
      schema: TRASH_SCHEMA,
      restored: true,
      assetPath: record.assetPath,
      responseRecovered: recovered === true,
    });
  }

  function finishRestore(record, recovered) {
    assertDirectory(record);
    const generated = generatedDirectory(record.binding.rootPath, fileSystem);
    if (!sameInode(generated, record.generatedDirectory)) {
      fail('IMAGE_TRASH_STALE', '生成图片目录已经变化');
    }
    let target;
    try { target = fileSystem.lstatSync(record.target); }
    catch (_) { fail('IMAGE_TRASH_STALE', '已恢复图片无法核验'); }
    if (target.isSymbolicLink() || !target.isFile() || target.nlink !== 1 ||
        !sameInode(target, record.entry.identity) ||
        target.size !== record.entry.identity.size) {
      fail('IMAGE_TRASH_STALE', '已恢复图片身份已经变化');
    }
    syncDirectory(fileSystem, record.directory.path);
    syncDirectory(fileSystem, generated.path);
    record.phase = 'terminal';
    record.result = publicRestore(record, recovered);
    return record.result;
  }

  function restore(rawBinding, itemToken) {
    const record = current(itemToken, 'item', rawBinding);
    if (record.phase === 'terminal') return publicRestore(record, true);
    if (record.phase === 'committed_pending_fsync') return finishRestore(record, true);
    assertDirectory(record);
    let entry;
    let bytes;
    try {
      entry = fileSystem.lstatSync(record.entry.target);
      bytes = fileSystem.readFileSync(record.entry.target);
    } catch (_) {
      fail('IMAGE_TRASH_STALE', '废纸篓图片已经变化');
    }
    if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 ||
        !sameInode(entry, record.entry.identity) ||
        entry.size !== record.entry.identity.size ||
        !Buffer.isBuffer(bytes) || bytes.length !== entry.size) {
      fail('IMAGE_TRASH_STALE', '废纸篓图片已经变化');
    }
    const extension = sniffImage(bytes);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== record.entry.digest) {
      fail('IMAGE_TRASH_STALE', '废纸篓图片内容已经变化');
    }
    const generated = generatedDirectory(record.binding.rootPath, fileSystem);
    const assetPath = `assets/generated/image-${digest}.${extension}`;
    const target = path.join(record.binding.rootPath, ...assetPath.split('/'));
    if (fileSystem.existsSync(target)) {
      fail('IMAGE_TRASH_DESTINATION_EXISTS', '相同图片已存在，未恢复废纸篓条目');
    }
    let targetPublished = false;
    let publishedIdentity = null;
    try {
      fileSystem.linkSync(record.entry.target, target);
      targetPublished = true;
      const linked = fileSystem.lstatSync(target);
      publishedIdentity = linked;
      const source = fileSystem.lstatSync(record.entry.target);
      const currentGenerated = generatedDirectory(record.binding.rootPath, fileSystem);
      const currentTrash = trashDirectory(record.binding.rootPath, fileSystem, false);
      const canonicalTarget = fileSystem.realpathSync(target);
      if (linked.isSymbolicLink() || !linked.isFile() ||
          !sameInode(linked, entry) || !sameInode(source, entry) ||
          linked.nlink !== 2 || source.nlink !== 2 ||
          !sameInode(currentGenerated, generated) ||
          !sameInode(currentTrash, record.directory) ||
          canonicalTarget !== target ||
          path.dirname(canonicalTarget) !== generated.path) {
        fail('IMAGE_TRASH_STALE', '恢复图片时身份发生变化');
      }
      if (contentDigest(target, entry.size) !== digest) {
        fail('IMAGE_TRASH_STALE', '恢复图片时内容发生变化');
      }
      const operation = moveToOperation(record.binding.rootPath, record.entry.target);
      if (operation.identity.isSymbolicLink() || !operation.identity.isFile() ||
          !sameInode(operation.identity, entry) ||
          operation.identity.size !== entry.size) {
        // The exact original is already safely published through the exclusive
        // hard link. Preserve the late foreign arrival at its original trash
        // path instead of unlinking whichever inode won the race.
        preserveMovedEntry(operation, record.entry.target);
      } else {
        if (contentDigest(operation.target, entry.size) !== digest ||
            contentDigest(target, entry.size) !== digest) {
          preserveMovedEntry(operation, record.entry.target);
          fail('IMAGE_TRASH_STALE', '恢复图片时内容发生变化');
        }
        unlinkOperation(operation);
      }
    } catch (error) {
      if (targetPublished && publishedIdentity) {
        try {
          const linked = fileSystem.lstatSync(target);
          if (!linked.isSymbolicLink() && linked.isFile() &&
              sameInode(linked, publishedIdentity)) {
            removeExactPath(
              record.binding.rootPath,
              target,
              publishedIdentity
            );
          }
        } catch (_) {}
      }
      if (error instanceof ImageTrashError) throw error;
      if (error?.code === 'EEXIST') {
        fail('IMAGE_TRASH_DESTINATION_EXISTS', '相同图片已存在，未恢复废纸篓条目');
      }
      fail('IMAGE_TRASH_RESTORE_FAILED', '图片恢复失败，废纸篓条目保持不变');
    }
    record.generatedDirectory = generated;
    record.target = target;
    record.assetPath = assetPath;
    record.phase = 'committed_pending_fsync';
    return finishRestore(record, false);
  }

  function publicEmpty(record, recovered) {
    const currentCounts = counts(record.binding.rootPath);
    return Object.freeze({
      ok: true,
      schema: TRASH_SCHEMA,
      emptiedCount: record.removed.size,
      remainingCount: currentCounts.count,
      responseRecovered: recovered === true,
    });
  }

  function finishEmpty(record, recovered) {
    assertDirectory(record);
    syncDirectory(fileSystem, record.directory.path);
    record.phase = 'terminal';
    record.result = publicEmpty(record, recovered);
    return record.result;
  }

  function empty(rawBinding, snapshotToken) {
    const record = current(snapshotToken, 'snapshot', rawBinding);
    if (record.phase === 'terminal') {
      return Object.freeze({ ...record.result, responseRecovered: true });
    }
    if (record.phase === 'committed_pending_fsync') {
      return finishEmpty(record, true);
    }
    const recoveringPartial = record.phase === 'committed_partial';
    assertDirectory(record);
    for (const [name, operation] of [...record.quarantines]) {
      try {
        unlinkOperation(operation);
        record.quarantines.delete(name);
        record.removed.add(name);
      } catch (_) {
        record.phase = 'committed_partial';
        fail(
          'IMAGE_TRASH_EMPTY_FAILED',
          '废纸篓已部分清空，可重试剩余条目',
          { committed: true, retryable: true }
        );
      }
    }
    const candidates = [];
    for (const entry of record.entries) {
      if (record.removed.has(entry.name)) continue;
      let currentEntry;
      try { currentEntry = fileSystem.lstatSync(entry.target); }
      catch (error) {
        if (error?.code === 'ENOENT') {
          fail('IMAGE_TRASH_STALE', '废纸篓快照条目已经缺失');
        }
        fail('IMAGE_TRASH_STALE', '废纸篓快照已经变化');
      }
      if (currentEntry.isSymbolicLink() || !currentEntry.isFile() ||
          currentEntry.nlink !== 1 || !sameInode(currentEntry, entry.identity) ||
          currentEntry.size !== entry.identity.size ||
          contentDigest(entry.target, entry.identity.size) !== entry.digest) {
        fail('IMAGE_TRASH_STALE', '废纸篓快照条目已经变化');
      }
      candidates.push(entry);
    }
    let committed = record.removed.size > 0;
    for (const entry of candidates) {
      try {
        const operation = moveToOperation(record.binding.rootPath, entry.target);
        if (!sameInode(operation.identity, entry.identity) ||
            operation.identity.isSymbolicLink() ||
            !operation.identity.isFile() ||
            operation.identity.nlink !== 1 ||
            operation.identity.size !== entry.identity.size ||
            contentDigest(operation.target, entry.identity.size) !== entry.digest) {
          preserveMovedEntry(operation, entry.target);
          fail('IMAGE_TRASH_STALE', '废纸篓快照条目已经变化');
        }
        record.quarantines.set(entry.name, operation);
        committed = true;
        try {
          unlinkOperation(operation);
          record.quarantines.delete(entry.name);
          record.removed.add(entry.name);
        } catch (error) {
          record.phase = 'committed_partial';
          fail(
            'IMAGE_TRASH_EMPTY_FAILED',
            '废纸篓已部分清空，可重试剩余条目',
            { committed: true, retryable: true }
          );
        }
      } catch (error) {
        record.phase = committed ? 'committed_partial' : 'live';
        if (error instanceof ImageTrashError) throw error;
        fail(
          'IMAGE_TRASH_EMPTY_FAILED',
          committed ? '废纸篓已部分清空，可重试剩余条目' : '图片废纸篓清空失败',
          committed ? { committed: true, retryable: true } : undefined
        );
      }
    }
    record.phase = 'committed_pending_fsync';
    return finishEmpty(record, recoveringPartial);
  }

  return Object.freeze({ list, restore, empty });
}

module.exports = {
  TRASH_SCHEMA,
  ImageTrashError,
  createImageTrashService,
};
