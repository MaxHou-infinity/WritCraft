'use strict';

const crypto = require('crypto');
const path = require('path');
const workerModule = require('./markdown-trash-worker');

const SCHEMA = 'writcraft.markdown-trash-list/v1';
const TRASH_SCHEMA = 'writcraft.trash/v1';
const TOKEN_RE = /^mti_[a-f0-9]{48}$/;
const ENTRY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_RE = /^[a-f0-9]{64}$/;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 2000;
const MAX_ITEMS = 100;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const ABSENT_MANIFEST_DIGEST = '0'.repeat(64);
const MANIFEST_KEYS = Object.freeze(['entries', 'schema', 'schemaVersion']);
const ENTRY_KEYS = Object.freeze([
  'bytes', 'deletedAt', 'id', 'originalPath', 'revision', 'trashPath',
]);

class MarkdownTrashError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarkdownTrashError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarkdownTrashError(code, message);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('MARKDOWN_TRASH_STALE', `${label}无效`);
  return value;
}

function privateRootIdentity(value) {
  if (!value || typeof value.dev !== 'bigint' || typeof value.ino !== 'bigint' ||
      typeof value.mode !== 'bigint') {
    fail('MARKDOWN_TRASH_STALE', '项目根目录身份无效');
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, mode: value.mode });
}

function validateBinding(binding) {
  if (!binding || !Number.isSafeInteger(binding.webContentsId) || binding.webContentsId < 1 ||
      typeof binding.projectInstanceId !== 'string' || !binding.projectInstanceId ||
      typeof binding.rootPath !== 'string' || !path.isAbsolute(binding.rootPath)) {
    fail('MARKDOWN_TRASH_STALE', '项目回收区绑定无效');
  }
  safeInteger(binding.mutationGeneration, '项目状态');
  safeInteger(binding.navigationEpoch, '窗口状态');
  return Object.freeze({
    webContentsId: binding.webContentsId,
    projectInstanceId: binding.projectInstanceId,
    rootPath: path.resolve(binding.rootPath),
    rootIdentity: privateRootIdentity(binding.rootIdentity),
    mutationGeneration: binding.mutationGeneration,
    navigationEpoch: binding.navigationEpoch,
  });
}

function sameBinding(left, right) {
  return left.webContentsId === right.webContentsId &&
    left.projectInstanceId === right.projectInstanceId &&
    left.rootPath === right.rootPath &&
    left.rootIdentity.dev === right.rootIdentity.dev &&
    left.rootIdentity.ino === right.rootIdentity.ino &&
    left.rootIdentity.mode === right.rootIdentity.mode &&
    left.mutationGeneration === right.mutationGeneration &&
    left.navigationEpoch === right.navigationEpoch;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function assertOriginalPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
      value === 'edit.md' || value.includes('\\') || path.posix.isAbsolute(value)) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区记录无效');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') ||
      normalized.split('/').some(part => !part || part.startsWith('.')) ||
      !/\.(md|markdown)$/i.test(normalized)) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区记录路径无效');
  }
  return normalized;
}

function assertPublicMarkdownPath(value) {
  try { return assertOriginalPath(value); }
  catch (_) { fail('INVALID_PATH', '文件路径必须是项目内的 Markdown 文件'); }
}

function emptyManifest() {
  return { schema: TRASH_SCHEMA, schemaVersion: 1, entries: [] };
}

function serializeManifest(manifest) {
  const result = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (result.length > workerModule.MAX_MANIFEST_BYTES) {
    fail('MARKDOWN_TRASH_CAPACITY', '项目回收区清单超过安全大小上限');
  }
  return result;
}

function parseManifest(snapshot) {
  if (snapshot?.empty === true) {
    return Object.freeze({
      manifest: emptyManifest(),
      digest: ABSENT_MANIFEST_DIGEST,
      bytes: serializeManifest(emptyManifest()),
      absent: true,
    });
  }
  if (!snapshot || !Buffer.isBuffer(snapshot.manifest) ||
      !REVISION_RE.test(snapshot.digest || '')) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区清单无法核验');
  }
  let parsed;
  try { parsed = JSON.parse(snapshot.manifest.toString('utf8')); }
  catch (_) { fail('MARKDOWN_TRASH_CORRUPT', '项目回收区清单损坏'); }
  if (!exactKeys(parsed, MANIFEST_KEYS) || parsed.schema !== TRASH_SCHEMA ||
      parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_ITEMS) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区清单格式无效');
  }
  return Object.freeze({
    manifest: parsed,
    digest: snapshot.digest,
    bytes: snapshot.manifest,
    absent: false,
  });
}

function validateEntry(entry) {
  if (!exactKeys(entry, ENTRY_KEYS) || !ENTRY_ID_RE.test(entry.id || '') ||
      !REVISION_RE.test(entry.revision || '') ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      Number.isNaN(Date.parse(entry.deletedAt))) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区记录无效');
  }
  const originalPath = assertOriginalPath(entry.originalPath);
  const extension = path.posix.extname(originalPath).toLowerCase();
  const trashPath = `.writcraft/trash/${entry.id}${extension}`;
  if (entry.trashPath !== trashPath) {
    fail('MARKDOWN_TRASH_CORRUPT', '项目回收区记录位置无效');
  }
  return Object.freeze({ entry, originalPath, trashPath });
}

function operationError(result) {
  if (result?.state === 'RECOVERY_REQUIRED') {
    return new MarkdownTrashError(
      'MARKDOWN_TRASH_RECOVERY_REQUIRED',
      '回收区事务状态需要恢复；项目修改已锁定，请重新打开项目'
    );
  }
  if (result?.reason === 'TARGET_EXISTS') {
    return new MarkdownTrashError('FILE_EXISTS', '原位置已有文件；未覆盖现有内容');
  }
  if (result?.reason === 'SOURCE_STALE' || result?.reason === 'MANIFEST_STALE') {
    return new MarkdownTrashError('MARKDOWN_TRASH_STALE', '项目回收区内容已经变化，请刷新');
  }
  return new MarkdownTrashError('MARKDOWN_TRASH_REQUEST_INVALID', '项目回收区请求无法安全提交');
}

function createMarkdownTrashService(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const createId = typeof options.createId === 'function' ? options.createId : () => crypto.randomUUID();
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  const workerFactory = options.workerFactory || ((binding) =>
    workerModule.createMarkdownTrashWorkerForRoot(
      binding.rootPath,
      binding.rootIdentity,
      options.workerOptions || {}
    ));
  const tokens = new Map();
  const recoveryByRoot = new Map();

  function rootKey(binding) {
    return `${binding.projectInstanceId}\0${binding.rootPath}\0${binding.rootIdentity.dev}\0${binding.rootIdentity.ino}`;
  }

  async function withWorker(binding, task) {
    let worker;
    try {
      worker = workerFactory(binding);
      if (!worker || typeof worker.ready !== 'function') {
        fail('MARKDOWN_TRASH_UNAVAILABLE', '项目回收区原生事务服务不可用');
      }
      await worker.ready();
      return await task(worker);
    } catch (error) {
      if (error instanceof MarkdownTrashError) throw error;
      if (error?.code === 'MARKDOWN_TRASH_RECOVERY_REQUIRED') throw error;
      throw new MarkdownTrashError(
        error?.code === 'MARKDOWN_TRASH_ROOT_CHANGED'
          ? 'MARKDOWN_TRASH_STALE'
          : 'MARKDOWN_TRASH_UNAVAILABLE',
        error?.code === 'MARKDOWN_TRASH_ROOT_CHANGED'
          ? '项目根目录身份已经变化，请重新打开项目'
          : '项目回收区原生事务服务不可用'
      );
    } finally {
      try { worker?.close?.(); } catch (_) {}
    }
  }

  function purgeExpired() {
    const current = now();
    for (const [token, record] of tokens) {
      if (record.expiresAt <= current) tokens.delete(token);
    }
  }

  async function inspectManifest(worker) {
    const snapshot = parseManifest(await worker.list());
    let totalBytes = 0;
    const entries = [];
    for (const rawEntry of snapshot.manifest.entries) {
      const value = validateEntry(rawEntry);
      totalBytes += value.entry.bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        fail('MARKDOWN_TRASH_CAPACITY', '项目回收区总容量超过安全核验上限');
      }
      const inspected = await worker.inspect(value.trashPath, maxFileBytes);
      if (!inspected?.ok || !sameIdentity(inspected.identity, {
        dev: inspected.identity?.dev,
        ino: inspected.identity?.ino,
        size: BigInt(value.entry.bytes),
      }) || inspected.digest !== value.entry.revision) {
        fail('MARKDOWN_TRASH_STALE', '项目回收区文件内容已经变化');
      }
      entries.push(Object.freeze({ ...value, identity: inspected.identity }));
    }
    return Object.freeze({ ...snapshot, entries, totalBytes });
  }

  async function reconcileKnown(binding) {
    const key = rootKey(binding);
    const pending = recoveryByRoot.get(key);
    if (!pending) return null;
    if (pending.kind === 'unknown') {
      const recovered = await withWorker(binding, worker => worker.reconcile());
      if (['CLEAR', 'UNCOMMITTED', 'COMMITTED'].includes(recovered?.state)) {
        recoveryByRoot.delete(key);
        return recovered;
      }
      throw operationError(recovered);
    }
    const result = await withWorker(binding, async worker => {
      const status = await worker.status({ ...pending.request, operation: pending.kind === 'restore' ? 'R' : 'T' });
      if (status?.state === 'COMMITTED' || status?.state === 'UNCOMMITTED') {
        return worker[pending.kind](pending.request);
      }
      return status;
    });
    if (result?.state === 'COMMITTED' || result?.state === 'UNCOMMITTED') {
      recoveryByRoot.delete(key);
      return result;
    }
    throw operationError(result);
  }

  async function ensureRecovered(binding) {
    const known = await reconcileKnown(binding);
    if (known) return known;
    const result = await withWorker(binding, worker => worker.reconcile());
    if (['CLEAR', 'UNCOMMITTED', 'COMMITTED'].includes(result?.state)) return result;
    recoveryByRoot.set(rootKey(binding), { kind: 'unknown', request: null });
    throw operationError(result);
  }

  async function executeOperation(binding, kind, request) {
    const key = rootKey(binding);
    await ensureRecovered(binding);
    try {
      const result = await withWorker(binding, worker => worker[kind](request));
      if (result?.state === 'COMMITTED') return result;
      if (result?.state === 'RECOVERY_REQUIRED') recoveryByRoot.set(key, { kind, request });
      throw operationError(result);
    } catch (error) {
      if (error?.code !== 'MARKDOWN_TRASH_RECOVERY_REQUIRED') throw error;
      recoveryByRoot.set(key, { kind, request });
      const reconciled = await reconcileKnown(binding);
      if (reconciled?.state === 'COMMITTED') return reconciled;
      throw operationError(reconciled);
    }
  }

  async function bindProject(project) {
    const binding = validateBinding({
      webContentsId: 1,
      projectInstanceId: project?.instanceId,
      rootPath: project?.rootPath,
      rootIdentity: project?.rootIdentity,
      mutationGeneration: 0,
      navigationEpoch: 0,
    });
    const result = await withWorker(binding, worker => worker.reconcile());
    if (result?.state === 'RECOVERY_REQUIRED') {
      recoveryByRoot.set(rootKey(binding), { kind: 'unknown', request: null });
      return Object.freeze({ ok: false, state: 'RECOVERY_REQUIRED' });
    }
    recoveryByRoot.delete(rootKey(binding));
    return Object.freeze({ ok: true, state: result?.state || 'CLEAR' });
  }

  function assertMutationAvailable(project) {
    if (!project?.rootIdentity) return project;
    const binding = validateBinding({
      webContentsId: 1,
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      rootIdentity: project.rootIdentity,
      mutationGeneration: 0,
      navigationEpoch: 0,
    });
    if (recoveryByRoot.has(rootKey(binding))) {
      fail('MARKDOWN_TRASH_RECOVERY_REQUIRED',
        '回收区事务尚未恢复；项目修改已锁定，请重新打开项目');
    }
    return project;
  }

  async function list(rawBinding) {
    const binding = validateBinding(rawBinding);
    await ensureRecovered(binding);
    purgeExpired();
    for (const [token, record] of tokens) {
      if (record.binding.webContentsId === binding.webContentsId) tokens.delete(token);
    }
    const inspected = await withWorker(binding, worker => inspectManifest(worker));
    if (tokens.size + inspected.entries.length > maxTokens) {
      fail('MARKDOWN_TRASH_CAPACITY', '项目回收区恢复能力已达上限');
    }
    const items = inspected.entries.map(item => {
      const token = `mti_${crypto.randomBytes(24).toString('hex')}`;
      tokens.set(token, {
        binding,
        expiresAt: now() + ttlMs,
        entryId: item.entry.id,
        originalPath: item.originalPath,
        trashPath: item.trashPath,
        revision: item.entry.revision,
        identity: item.identity,
        digest: item.entry.revision,
      });
      return Object.freeze({
        token,
        originalPath: item.originalPath,
        deletedAt: new Date(item.entry.deletedAt).toISOString(),
        sizeBytes: Number(item.identity.size),
      });
    });
    return Object.freeze({
      ok: true,
      schema: SCHEMA,
      totalCount: items.length,
      totalBytes: inspected.totalBytes,
      items,
    });
  }

  async function trash(rawBinding, relPath, expectedRevision) {
    const binding = validateBinding(rawBinding);
    await ensureRecovered(binding);
    const source = assertPublicMarkdownPath(relPath);
    if (source === 'edit.md') fail('EDIT_FILE_PROTECTED', 'edit.md 是项目级 Prompt，不能移到回收区');
    if (expectedRevision !== undefined && expectedRevision !== null &&
        !REVISION_RE.test(expectedRevision)) {
      fail('INVALID_REVISION', '文件版本无效');
    }
    return withWorker(binding, async worker => {
      const inspected = await inspectManifest(worker);
      if (inspected.entries.length >= MAX_ITEMS) fail('TRASH_FULL', '项目回收区记录已达上限');
      const sourceSnapshot = await worker.inspect(source, maxFileBytes);
      if (!sourceSnapshot?.ok) fail('FILE_CONFLICT', '源文件已经变化，请刷新');
      if (expectedRevision && sourceSnapshot.digest !== expectedRevision) {
        fail('FILE_CONFLICT', '文件在操作前已发生变化，请刷新后重试');
      }
      const id = createId();
      if (!ENTRY_ID_RE.test(id)) fail('MARKDOWN_TRASH_REQUEST_INVALID', '回收区记录身份无效');
      const extension = path.posix.extname(source).toLowerCase();
      const trashPath = `.writcraft/trash/${id}${extension}`;
      const entry = {
        id,
        originalPath: source,
        trashPath,
        deletedAt: new Date(now()).toISOString(),
        revision: sourceSnapshot.digest,
        bytes: Number(sourceSnapshot.identity.size),
      };
      const nextManifest = serializeManifest({
        ...inspected.manifest,
        entries: [...inspected.manifest.entries, entry],
      });
      const request = Object.freeze({
        source,
        targetName: path.posix.basename(trashPath),
        digest: sourceSnapshot.digest,
        identity: sourceSnapshot.identity,
        manifestDigest: inspected.digest,
        nextManifest,
      });
      const committed = await executeOperation(binding, 'trash', request);
      if (committed.state !== 'COMMITTED') throw operationError(committed);
      return Object.freeze({
        fromPath: source,
        path: trashPath,
        bytes: entry.bytes,
        revision: entry.revision,
        trashed: true,
        trashEntry: Object.freeze({ ...entry }),
      });
    });
  }

  async function restore(rawBinding, token) {
    const binding = validateBinding(rawBinding);
    await ensureRecovered(binding);
    purgeExpired();
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      fail('MARKDOWN_TRASH_REQUEST_INVALID', '项目回收区恢复身份无效');
    }
    const record = tokens.get(token);
    if (!record || !sameBinding(record.binding, binding)) {
      fail('MARKDOWN_TRASH_STALE', '项目回收区列表已过期，请刷新');
    }
    return withWorker(binding, async worker => {
      const inspected = await inspectManifest(worker);
      const item = inspected.entries.find(value => value.entry.id === record.entryId);
      if (!item || item.originalPath !== record.originalPath ||
          item.trashPath !== record.trashPath ||
          item.entry.revision !== record.revision ||
          item.entry.revision !== record.digest ||
          !sameIdentity(item.identity, record.identity)) {
        tokens.delete(token);
        fail('MARKDOWN_TRASH_STALE', '项目回收区条目已经变化，请刷新');
      }
      const nextManifest = serializeManifest({
        ...inspected.manifest,
        entries: inspected.manifest.entries.filter(entry => entry.id !== record.entryId),
      });
      const request = Object.freeze({
        sourceName: path.posix.basename(item.trashPath),
        target: item.originalPath,
        digest: item.entry.revision,
        identity: item.identity,
        manifestDigest: inspected.digest,
        nextManifest,
      });
      const committed = await executeOperation(binding, 'restore', request);
      if (committed.state !== 'COMMITTED') throw operationError(committed);
      tokens.delete(token);
      for (const [otherToken, other] of tokens) {
        if (sameBinding(other.binding, binding)) tokens.delete(otherToken);
      }
      return Object.freeze({
        ok: true,
        schema: SCHEMA,
        restored: true,
        file: {
          path: item.originalPath,
          bytes: item.entry.bytes,
          revision: item.entry.revision,
        },
      });
    });
  }

  return Object.freeze({
    bindProject,
    assertMutationAvailable,
    list,
    trash,
    restore,
  });
}

module.exports = {
  SCHEMA,
  TRASH_SCHEMA,
  TOKEN_RE,
  MAX_ITEMS,
  MAX_TOTAL_BYTES,
  ABSENT_MANIFEST_DIGEST,
  MarkdownTrashError,
  createMarkdownTrashService,
};
