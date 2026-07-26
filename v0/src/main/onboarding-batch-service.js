'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  normalizeSuggestions,
  isOnboardingCapabilityStore,
} = require('./onboarding-capability-store');

const STAGE_PREFIX = 'onboarding-stage-';
const ALLOWED_HOOKS = new Set(['preflight', 'stage', 'commit', 'rollback']);
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const MAX_ROLLBACK_SCAN_NODES = 20000;
const MAX_ROLLBACK_SCAN_DEPTH = 64;

class OnboardingBatchError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'OnboardingBatchError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new OnboardingBatchError(code, message, cause);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactObject(value, keys, code, label) {
  if (!isPlainObject(value)) fail(code, `${label}无效`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label}包含未授权或缺失字段`);
  }
}

function normalizeHooks(value) {
  if (value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) fail('INVALID_FAULT_HOOKS', '批量创建故障钩子无效');
  const hooks = {};
  for (const [name, hook] of Object.entries(value)) {
    if (!ALLOWED_HOOKS.has(name) || typeof hook !== 'function') {
      fail('INVALID_FAULT_HOOKS', '批量创建故障钩子只允许 preflight/stage/commit/rollback 函数');
    }
    hooks[name] = hook;
  }
  return Object.freeze(hooks);
}

function normalizeConsumedSelection(value) {
  exactObject(value, [
    'source', 'projectInstanceId', 'rootPath', 'mutationGeneration', 'editRevision',
    'proposalDigest', 'fileSuggestions',
  ], 'INVALID_CONSUMED_SELECTION', '已消费的项目建立选择');
  if (!['review', 'no_op'].includes(value.source) || typeof value.proposalDigest !== 'string' ||
      !DIGEST_RE.test(value.proposalDigest) || typeof value.projectInstanceId !== 'string' ||
      !PROJECT_INSTANCE_ID_RE.test(value.projectInstanceId) || !Number.isSafeInteger(value.mutationGeneration) ||
      value.mutationGeneration < 0 || typeof value.editRevision !== 'string' || !REVISION_RE.test(value.editRevision)) {
    fail('INVALID_CONSUMED_SELECTION', '已消费的项目建立选择缺少可验证来源或提案摘要');
  }
  return Object.freeze({
    source: value.source,
    projectInstanceId: value.projectInstanceId,
    rootPath: normalizeRoot(value.rootPath),
    mutationGeneration: value.mutationGeneration,
    editRevision: value.editRevision,
    proposalDigest: value.proposalDigest.startsWith('sha256:') ? value.proposalDigest : `sha256:${value.proposalDigest}`,
    fileSuggestions: normalizeSuggestions(value.fileSuggestions),
  });
}

function normalizeRoot(rootPath) {
  if (typeof rootPath !== 'string' || !rootPath || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    fail('INVALID_ROOT', '项目根目录无效');
  }
  let stat;
  try { stat = fs.lstatSync(rootPath); }
  catch (error) { fail('INVALID_ROOT', '项目根目录不存在', error); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INVALID_ROOT', '项目根目录必须是普通目录');
  const root = fs.realpathSync(rootPath);
  if (path.resolve(rootPath) !== root) fail('INVALID_ROOT', '项目根目录不得经过符号链接');
  return root;
}

function templateForSuggestion(suggestion) {
  return `# ${suggestion.title}\n\n`;
}

function revisionFor(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function inodeOf(absolute) {
  const stat = fs.lstatSync(absolute);
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function sameInode(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (_) {
    // Directory fsync is best effort on filesystems that do not support it.
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function suggestionPrefixIdentity(suggestions) {
  const prefixes = new Map();
  for (const suggestion of suggestions) {
    const parts = suggestion.path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const visible = parts.slice(0, index).join('/');
      const key = visible.normalize('NFC').toLocaleLowerCase('en-US');
      const prior = prefixes.get(key);
      if (prior && prior !== visible) fail('CASE_COLLISION', `初始文件路径大小写冲突：${prior} / ${visible}`);
      prefixes.set(key, visible);
    }
  }
}

function preflightTarget(root, relativePath) {
  const parts = relativePath.split('/');
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    let entries;
    try { entries = fs.readdirSync(cursor); }
    catch (error) { fail('PARENT_NOT_DIRECTORY', '初始文件父路径不可读取', error); }
    const folded = part.normalize('NFC').toLocaleLowerCase('en-US');
    const matches = entries.filter(entry => entry.normalize('NFC').toLocaleLowerCase('en-US') === folded);
    if (matches.length > 1 || (matches[0] && matches[0] !== part)) {
      fail('CASE_COLLISION', `初始文件路径与已有项大小写冲突：${relativePath}`);
    }
    if (!matches.length) return;
    const next = path.join(cursor, part);
    const stat = fs.lstatSync(next);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `初始文件路径不得经过符号链接：${relativePath}`);
    if (index === parts.length - 1) fail('FILE_EXISTS', `初始文件已存在：${relativePath}`);
    if (!stat.isDirectory()) fail('PARENT_NOT_DIRECTORY', `初始文件父路径不是目录：${relativePath}`);
    cursor = next;
  }
}

function ensureMetadataDirectory(root, createdDirectories) {
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    fs.mkdirSync(metadata, { mode: 0o700 });
    createdDirectories.push({ path: metadata, ...inodeOf(metadata), private: true });
  }
  const stat = fs.lstatSync(metadata);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(metadata) !== metadata) {
    fail('UNSAFE_STAGE_ROOT', '.writcraft 必须是项目内普通目录');
  }
  return metadata;
}

function createStageDirectory(metadata) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stage = path.join(metadata, `${STAGE_PREFIX}${crypto.randomBytes(16).toString('hex')}`);
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      const metadataDevice = fs.lstatSync(metadata).dev;
      const stageDevice = fs.lstatSync(stage).dev;
      if (metadataDevice !== stageDevice) fail('CROSS_DEVICE_STAGE', '项目建立暂存目录不在项目文件系统中');
      return stage;
    } catch (error) {
      if (error instanceof OnboardingBatchError) throw error;
      if (error && error.code === 'EEXIST') continue;
      fail('STAGE_FAILED', '无法创建项目建立私有暂存目录', error);
    }
  }
  fail('STAGE_FAILED', '无法分配唯一项目建立暂存目录');
}

function ensureTargetParents(root, relativePath, createdDirectories) {
  const parts = relativePath.split('/').slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    const entries = fs.readdirSync(cursor);
    const folded = part.normalize('NFC').toLocaleLowerCase('en-US');
    const matches = entries.filter(entry => entry.normalize('NFC').toLocaleLowerCase('en-US') === folded);
    if (matches.length > 1 || (matches[0] && matches[0] !== part)) {
      fail('CASE_COLLISION', `初始文件父目录大小写冲突：${relativePath}`);
    }
    cursor = path.join(cursor, part);
    if (!matches.length) {
      try {
        fs.mkdirSync(cursor, { mode: 0o700 });
        createdDirectories.push({ path: cursor, ...inodeOf(cursor), private: false });
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
      }
    }
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `初始文件路径不得经过符号链接：${relativePath}`);
    if (!stat.isDirectory()) fail('PARENT_NOT_DIRECTORY', `初始文件父路径不是目录：${relativePath}`);
  }
  return path.join(root, ...relativePath.split('/'));
}

function assertCommitTargetSafe(root, relativePath, target) {
  const parts = relativePath.split('/').slice(0, -1);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `提交前父路径被替换为符号链接：${relativePath}`);
    if (!stat.isDirectory()) fail('PARENT_NOT_DIRECTORY', `提交前父路径不再是目录：${relativePath}`);
    const real = fs.realpathSync(cursor);
    if (real !== cursor || (real !== root && !real.startsWith(`${root}${path.sep}`))) {
      fail('SYMLINK_NOT_ALLOWED', `提交前父路径逃离项目：${relativePath}`);
    }
  }
  try {
    fs.lstatSync(target);
    fail('FILE_EXISTS', `初始文件在提交时已被占用：${relativePath}`);
  } catch (error) {
    if (error instanceof OnboardingBatchError) throw error;
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function assertCommittedTargetSafe(root, relativePath, target, realTarget) {
  const parent = path.dirname(target);
  const realParent = fs.realpathSync(parent);
  if (realParent !== parent || (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) ||
      realTarget !== target || (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`))) {
    fail('SYMLINK_NOT_ALLOWED', `提交后目标逃离项目：${relativePath}`);
  }
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    fail('SYMLINK_NOT_ALLOWED', `提交后父路径被替换：${relativePath}`);
  }
}

function cleanPrivateStage(stage) {
  if (!stage) return null;
  try {
    const name = path.basename(stage);
    if (!name.startsWith(STAGE_PREFIX)) return new Error('unsafe stage cleanup target');
    fs.rmSync(stage, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error;
  }
}

function inodeKey(value) {
  return `${value.dev}:${value.ino}`;
}

function lstatIfPresent(absolute) {
  try { return fs.lstatSync(absolute); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function unlinkIfOwned(absolute, ownershipByInode, removed) {
  const stat = lstatIfPresent(absolute);
  if (!stat || stat.isSymbolicLink() || stat.isDirectory()) return false;
  const owner = ownershipByInode.get(inodeKey(stat));
  if (!owner) return false;
  fs.unlinkSync(absolute);
  removed.add(absolute);
  syncDirectory(path.dirname(absolute));
  return true;
}

function walkCanonicalProjectFiles(root, stage, visit) {
  const stack = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { directory, depth } = stack.pop();
    if (depth > MAX_ROLLBACK_SCAN_DEPTH) throw new Error('rollback scan exceeded depth bound');
    const directoryStat = lstatIfPresent(directory);
    if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
    const realDirectory = fs.realpathSync(directory);
    if (realDirectory !== directory || (directory !== root && !directory.startsWith(`${root}${path.sep}`))) {
      throw new Error('rollback scan encountered non-canonical directory');
    }
    const entries = fs.readdirSync(directory);
    for (const name of entries) {
      visited += 1;
      if (visited > MAX_ROLLBACK_SCAN_NODES) throw new Error('rollback scan exceeded node bound');
      const absolute = path.join(directory, name);
      if (stage && absolute === stage) continue;
      const stat = lstatIfPresent(absolute);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push({ directory: absolute, depth: depth + 1 });
        continue;
      }
      visit(absolute, stat);
    }
  }
}

function scanAndRemoveOwnedLinks(root, stage, ownershipByInode, removed) {
  walkCanonicalProjectFiles(root, stage, absolute => {
    unlinkIfOwned(absolute, ownershipByInode, removed);
  });
}

function verifyBatchLinearization(root, stage, ownership) {
  const byInode = new Map(ownership.map(item => [inodeKey(item), item]));
  const locations = new Map(ownership.map(item => [inodeKey(item), []]));
  walkCanonicalProjectFiles(root, stage, (absolute, stat) => {
    const key = inodeKey(stat);
    if (byInode.has(key)) locations.get(key).push(absolute);
  });

  for (const item of ownership) {
    const expectedTarget = path.join(root, ...item.relativePath.split('/'));
    const stageStat = fs.lstatSync(item.stagePath);
    const matches = locations.get(inodeKey(item));
    if (!sameInode(stageStat, item) || stageStat.nlink !== 2 ||
        matches.length !== 1 || matches[0] !== expectedTarget) {
      fail('COMMIT_INTEGRITY_FAILED', `初始文件整批线性化校验失败：${item.relativePath}`);
    }
    const targetStat = fs.lstatSync(expectedTarget);
    const realTarget = fs.realpathSync(expectedTarget);
    if (!sameInode(targetStat, item)) fail('COMMIT_INTEGRITY_FAILED', '初始文件目标 inode 在整批校验时变化');
    assertCommittedTargetSafe(root, item.relativePath, expectedTarget, realTarget);
    const proofFd = fs.openSync(item.stagePath, 'r');
    const proofStat = fs.fstatSync(proofFd);
    if (!sameInode(proofStat, item) || proofStat.nlink !== 2) {
      fs.closeSync(proofFd);
      fail('COMMIT_INTEGRITY_FAILED', '初始文件 stage 证明句柄无效');
    }
    item.proofFd = proofFd;
  }
}

function verifyPublishedBatch(root, ownership) {
  for (const item of ownership) {
    const target = path.join(root, ...item.relativePath.split('/'));
    const targetStat = fs.lstatSync(target);
    const realTarget = fs.realpathSync(target);
    const proofStat = fs.fstatSync(item.proofFd);
    if (!sameInode(targetStat, item) || targetStat.nlink !== 1 ||
        !sameInode(proofStat, item) || proofStat.nlink !== 1) {
      fail('COMMIT_INTEGRITY_FAILED', `初始文件发布后校验失败：${item.relativePath}`);
    }
    assertCommittedTargetSafe(root, item.relativePath, target, realTarget);
  }
}

function closeProofDescriptors(ownership) {
  for (const item of ownership) {
    if (item.proofFd === undefined) continue;
    try { fs.closeSync(item.proofFd); } catch (_) {}
    delete item.proofFd;
  }
}

function rollbackTransaction({ ownership, createdDirectories, stage, hooks, root }) {
  const failures = [];
  for (let index = ownership.length - 1; index >= 0; index -= 1) {
    const item = ownership[index];
    try {
      hooks.rollback?.(Object.freeze({ phase: 'rollback', index, path: item.relativePath }));
    } catch (error) {
      // Fault hooks may report rollback trouble, but cleanup still continues.
      failures.push(error);
    }
  }

  const ownershipByInode = new Map(ownership.map(item => [inodeKey(item), item]));
  const removed = new Set();
  for (const item of ownership) {
    for (const knownPath of item.knownPaths) {
      if (removed.has(knownPath)) continue;
      try { unlinkIfOwned(knownPath, ownershipByInode, removed); }
      catch (error) { failures.push(error); }
    }
  }
  try { scanAndRemoveOwnedLinks(root, stage, ownershipByInode, removed); }
  catch (error) { failures.push(error); }

  // Before stage cleanup the stage path must be the sole remaining link. If
  // stage was already removed, the retained proof fd must report nlink zero.
  // Either form proves no unrecognized transaction link remains.
  for (const item of ownership) {
    try {
      const stageStat = lstatIfPresent(item.stagePath);
      const proofStat = item.proofFd === undefined ? null : fs.fstatSync(item.proofFd);
      const proven = stageStat
        ? sameInode(stageStat, item) && stageStat.nlink === 1
        : proofStat && sameInode(proofStat, item) && proofStat.nlink === 0;
      if (!proven) {
        failures.push(new Error(`unidentified hard link remains: ${item.relativePath}`));
      }
    } catch (error) { failures.push(error); }
  }

  const stageFailure = cleanPrivateStage(stage);
  if (stageFailure) failures.push(stageFailure);

  for (let index = createdDirectories.length - 1; index >= 0; index -= 1) {
    const directory = createdDirectories[index];
    try {
      if (!fs.existsSync(directory.path)) continue;
      const current = inodeOf(directory.path);
      if (!sameInode(current, directory)) {
        failures.push(new Error(`directory inode changed before rollback: ${directory.path}`));
        continue;
      }
      const entries = fs.readdirSync(directory.path);
      if (!entries.length) fs.rmdirSync(directory.path);
    } catch (error) {
      failures.push(error);
    }
  }
  closeProofDescriptors(ownership);
  return failures;
}

function phaseError(error, phase) {
  if (error instanceof OnboardingBatchError) return error;
  const code = phase === 'preflight' ? 'PREFLIGHT_FAILED'
    : phase === 'stage' ? 'STAGE_FAILED'
      : phase === 'commit' ? (error && error.code === 'EXDEV' ? 'CROSS_DEVICE_COMMIT' : 'COMMIT_FAILED')
        : 'BATCH_FAILED';
  return new OnboardingBatchError(code, `初始文件批量创建在 ${phase} 阶段失败`, error);
}

function createOnboardingBatchService(options = {}) {
  exactObject(options, ['capabilityStore', 'bindingValidator'], 'INVALID_CAPABILITY_STORE', '项目建立批量服务配置');
  const { capabilityStore, bindingValidator } = options;
  if (!isOnboardingCapabilityStore(capabilityStore)) {
    fail('INVALID_CAPABILITY_STORE', '项目建立批量服务必须持有真实 capability store');
  }
  if (typeof bindingValidator !== 'function') {
    fail('INVALID_BINDING_VALIDATOR', '项目建立批量服务必须持有 Main 绑定复核器');
  }

  function confirmAndCreate(raw) {
    const candidateToken = isPlainObject(raw) ? raw.confirmationToken : null;
    try {
      const hasFaultHooks = isPlainObject(raw) && Object.hasOwn(raw, 'faultHooks');
      exactObject(raw, [
        'confirmationToken', 'projectInstanceId', 'rootPath', 'mutationGeneration',
        'editRevision', 'proposalDigest', 'selectedPaths',
        ...(hasFaultHooks ? ['faultHooks'] : []),
      ], 'INVALID_CONFIRM_REQUEST', '项目建立确认请求');
      const selection = capabilityStore.consume(raw.confirmationToken, {
        projectInstanceId: raw.projectInstanceId,
        rootPath: raw.rootPath,
        mutationGeneration: raw.mutationGeneration,
        editRevision: raw.editRevision,
        proposalDigest: raw.proposalDigest,
        selectedPaths: raw.selectedPaths,
      });
      return commitConsumedSelection({ selection, faultHooks: raw.faultHooks, bindingValidator });
    } catch (error) {
      // consume deliberately preserves a token for some low-level validation
      // failures. The coordinator is stricter: every confirmation attempt is
      // terminal, including malformed requests and commit/rollback failures.
      if (typeof candidateToken === 'string') capabilityStore.invalidate(candidateToken);
      throw error;
    }
  }

  return Object.freeze({ confirmAndCreate });
}

function validateMainBinding(bindingValidator, consumed, checkpoint) {
  const binding = Object.freeze({
    checkpoint,
    projectInstanceId: consumed.projectInstanceId,
    rootPath: consumed.rootPath,
    mutationGeneration: consumed.mutationGeneration,
    editRevision: consumed.editRevision,
  });
  let valid;
  try {
    valid = bindingValidator(binding);
  } catch (error) {
    fail('BINDING_CHANGED', '项目、世代或 edit.md 已变化，初始文件整批创建已取消', error);
  }
  if (valid !== true) fail('BINDING_CHANGED', '项目、世代或 edit.md 已变化，初始文件整批创建已取消');
}

function commitConsumedSelection({ selection, faultHooks, bindingValidator } = {}) {
  const hooks = normalizeHooks(faultHooks);
  const consumed = normalizeConsumedSelection(selection);
  const root = consumed.rootPath;
  suggestionPrefixIdentity(consumed.fileSuggestions);

  let phase = 'preflight';
  let stage = null;
  const staged = [];
  const ownership = [];
  const createdDirectories = [];
  try {
    for (const suggestion of consumed.fileSuggestions) preflightTarget(root, suggestion.path);
    hooks.preflight?.(Object.freeze({
      phase: 'preflight', rootPath: root,
      paths: Object.freeze(consumed.fileSuggestions.map(item => item.path)),
    }));

    if (!consumed.fileSuggestions.length) {
      validateMainBinding(bindingValidator, consumed, 'before_empty_success');
      return Object.freeze({
        ok: true,
        source: consumed.source,
        projectInstanceId: consumed.projectInstanceId,
        rootPath: consumed.rootPath,
        mutationGeneration: consumed.mutationGeneration,
        editRevision: consumed.editRevision,
        proposalDigest: consumed.proposalDigest,
        files: Object.freeze([]),
      });
    }

    phase = 'stage';
    const metadata = ensureMetadataDirectory(root, createdDirectories);
    stage = createStageDirectory(metadata);
    consumed.fileSuggestions.forEach((suggestion, index) => {
      const content = templateForSuggestion(suggestion);
      const stagePath = path.join(stage, `${String(index).padStart(2, '0')}.stage`);
      hooks.stage?.(Object.freeze({ phase: 'stage', index, path: suggestion.path }));
      let fd;
      try {
        fd = fs.openSync(stagePath, 'wx', 0o600);
        fs.writeFileSync(fd, content, { encoding: 'utf8' });
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      staged.push(Object.freeze({
        suggestion, content, stagePath, inode: inodeOf(stagePath),
      }));
    });
    syncDirectory(stage);

    phase = 'commit';
    // The capability binding was checked when it was consumed, but staging can
    // take long enough for the active project or edit.md revision to drift.
    // Main's private validator is therefore the last gate before the first
    // project-visible hard link is published.
    validateMainBinding(bindingValidator, consumed, 'before_publish');
    staged.forEach((item, index) => {
      const target = ensureTargetParents(root, item.suggestion.path, createdDirectories);
      // Re-run the exact target check immediately before the exclusive link so
      // a race can fail without overwriting the competing file.
      if (fs.existsSync(target)) fail('FILE_EXISTS', `初始文件在提交前已被占用：${item.suggestion.path}`);
      hooks.commit?.(Object.freeze({ phase: 'commit', index, path: item.suggestion.path }));
      assertCommitTargetSafe(root, item.suggestion.path, target);
      try { fs.linkSync(item.stagePath, target); }
      catch (error) {
        if (error && error.code === 'EEXIST') fail('FILE_EXISTS', `初始文件在提交时已被占用：${item.suggestion.path}`, error);
        if (error && error.code === 'EXDEV') fail('CROSS_DEVICE_COMMIT', '初始文件暂存与项目目标不在同一文件系统', error);
        throw error;
      }
      // linkSync may be monkeypatched or raced so that the directory entry is
      // moved before the call returns. The stage inode is the only authority
      // we know at this point, so register provisional ownership before
      // looking at the selected target again.
      const committedEntry = {
        relativePath: item.suggestion.path,
        stagePath: item.stagePath,
        dev: item.inode.dev,
        ino: item.inode.ino,
        knownPaths: new Set([target]),
      };
      ownership.push(committedEntry);
      const targetInode = inodeOf(target);
      if (!sameInode(targetInode, item.inode)) fail('COMMIT_INTEGRITY_FAILED', '初始文件提交 inode 与暂存文件不一致');
      // If the parent was swapped between the pre-check and link(2), retain
      // the exact real landing path so rollback removes only our inode-backed
      // outside hard link and never a later competing path.
      const realTarget = fs.realpathSync(target);
      committedEntry.knownPaths.add(realTarget);
      assertCommittedTargetSafe(root, item.suggestion.path, target, realTarget);
      if (fs.lstatSync(item.stagePath).nlink !== 2) {
        fail('COMMIT_INTEGRITY_FAILED', '初始文件提交产生了未授权硬链接');
      }
      syncDirectory(path.dirname(target));
    });

    // This is the pre-publication half of the batch linearization point: every
    // staged inode must have exactly one project link at its selected path.
    verifyBatchLinearization(root, stage, ownership);
    // Revalidate once more while the private stage still owns rollback proof.
    // A failure here removes every published target before any stage name or
    // proof descriptor is released.
    validateMainBinding(bindingValidator, consumed, 'before_stage_cleanup');
    const stageFailure = cleanPrivateStage(stage);
    if (stageFailure) throw stageFailure;
    stage = null;
    // Once private stage names are gone, each selected target must be the sole
    // link. A mutation observed after this final check is a new external
    // mutation, not state that this transaction can claim or roll back.
    verifyPublishedBatch(root, ownership);
    closeProofDescriptors(ownership);
    return Object.freeze({
      ok: true,
      source: consumed.source,
      projectInstanceId: consumed.projectInstanceId,
      rootPath: consumed.rootPath,
      mutationGeneration: consumed.mutationGeneration,
      editRevision: consumed.editRevision,
      proposalDigest: consumed.proposalDigest,
      files: Object.freeze(staged.map(item => Object.freeze({
        path: item.suggestion.path,
        bytes: Buffer.byteLength(item.content, 'utf8'),
        revision: revisionFor(item.content),
      }))),
    });
  } catch (error) {
    const original = phaseError(error, phase);
    const rollbackFailures = rollbackTransaction({ ownership, createdDirectories, stage, hooks, root });
    if (rollbackFailures.length) {
      fail('ROLLBACK_FAILED', '初始文件批量创建失败，且回滚遇到异常', original);
    }
    throw original;
  }
}

module.exports = {
  STAGE_PREFIX,
  OnboardingBatchError,
  templateForSuggestion,
  revisionFor,
  createOnboardingBatchService,
};
