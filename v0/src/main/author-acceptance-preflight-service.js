'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('./project-service');

const PREFLIGHT_SCHEMA = 'writcraft.author-acceptance-preflight/v1';
const COPY_SCHEMA = 'writcraft.author-acceptance-copy/v1';
const COPY_MANIFEST = path.join('.writcraft', 'author-acceptance-copy.json');
const MIN_CHAPTER_FILES = 5;
const MIN_VISIBLE_CHINESE_CHARS = 2000;
const MIN_SOURCE_FILES = 1;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const MAX_DEPTH = 32;
const IGNORED_NAMES = new Set(['.git', '.DS_Store']);
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === 'number'
  ? fs.constants.O_NOFOLLOW
  : 0;
const ATOMIC_RENAME_HELPER = path.join(
  __dirname,
  '..',
  '..',
  'scripts',
  'atomic-rename-exclusive.py'
);

let cwdLeaseActive = false;

class AuthorAcceptancePreflightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuthorAcceptancePreflightError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new AuthorAcceptancePreflightError(code, message, details);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function identityOf(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function captureDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_PATH', `${label}无效`);
  const absolute = path.resolve(value);
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (_) {
    fail('NOT_FOUND', `${label}不存在`);
  }
  if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', `${label}不能是符号链接`);
  if (!stat.isDirectory()) fail('NOT_DIRECTORY', `${label}不是目录`);
  const canonical = fs.realpathSync(absolute);
  const canonicalStat = fs.lstatSync(canonical, { bigint: true });
  if (!canonicalStat.isDirectory() || !sameIdentity(identityOf(stat), identityOf(canonicalStat))) {
    fail('PATH_IDENTITY_CHANGED', `${label}身份不稳定`);
  }
  return Object.freeze({
    path: canonical,
    ...identityOf(canonicalStat),
    mode: Number(canonicalStat.mode & 0o777n),
  });
}

function assertCurrentDirectory(identity, code = 'PATH_IDENTITY_CHANGED') {
  const current = fs.statSync('.', { bigint: true });
  if (!current.isDirectory() || !sameIdentity(identity, identityOf(current))) {
    fail(code, '目录身份在操作期间发生变化');
  }
}

function enterDirectory(identity, code = 'PATH_IDENTITY_CHANGED') {
  try {
    process.chdir(identity.path);
  } catch (_) {
    fail(code, '目录路径在操作期间失效');
  }
  assertCurrentDirectory(identity, code);
}

function assertDirectoryPathIdentity(identity, code = 'PATH_IDENTITY_CHANGED') {
  let current;
  try {
    current = fs.lstatSync(identity.path, { bigint: true });
  } catch (_) {
    fail(code, '目录路径在操作期间失效');
  }
  if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameIdentity(identity, identityOf(current))) {
    fail(code, '目录路径身份在操作期间发生变化');
  }
}

function runWithCwdLease(operation) {
  if (cwdLeaseActive) fail('CWD_LEASE_BUSY', '验收文件事务正在执行');
  const original = process.cwd();
  const originalIdentity = identityOf(fs.statSync('.', { bigint: true }));
  cwdLeaseActive = true;
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  try {
    process.chdir(original);
    const restored = fs.statSync('.', { bigint: true });
    if (!sameIdentity(originalIdentity, identityOf(restored))) {
      throw new Error('cwd identity changed');
    }
  } catch (_) {
    const restoreError = new AuthorAcceptancePreflightError(
      'CWD_RESTORE_FAILED',
      '验收事务结束后无法恢复工作目录',
      {
        causeCode: operationError?.code || null,
        committed: result?.copyCreated === true || operationError?.committed === true,
      }
    );
    cwdLeaseActive = false;
    throw restoreError;
  }
  cwdLeaseActive = false;
  if (operationError) throw operationError;
  return result;
}

function boundedLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail('INVALID_LIMIT', '验收预检资源上限无效');
  }
  return value;
}

function resolveLimits(options = {}) {
  return Object.freeze({
    maxFiles: boundedLimit(options.maxFiles, MAX_FILES, MAX_FILES),
    maxFileBytes: boundedLimit(options.maxFileBytes, MAX_FILE_BYTES, MAX_FILE_BYTES),
    maxTotalBytes: boundedLimit(options.maxTotalBytes, MAX_TOTAL_BYTES, MAX_TOTAL_BYTES),
    maxDepth: boundedLimit(options.maxDepth, MAX_DEPTH, MAX_DEPTH),
  });
}

function assertStableFileIdentity(stat, expected, code = 'SOURCE_CHANGED') {
  if (!stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.nlink !== expected.nlink ||
      stat.size !== expected.size ||
      stat.mtimeNs !== expected.mtimeNs ||
      stat.ctimeNs !== expected.ctimeNs) {
    fail(code, '项目文件身份在检查期间发生变化');
  }
}

function readBoundRegularFile(name, limits) {
  const before = fs.lstatSync(name, { bigint: true });
  if (before.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目包含符号链接');
  if (!before.isFile()) fail('UNSUPPORTED_ENTRY', '项目包含非普通文件');
  if (before.nlink !== 1n) fail('HARD_LINK_NOT_ALLOWED', '项目包含硬链接文件');
  if (before.size > BigInt(limits.maxFileBytes)) {
    fail('FILE_TOO_LARGE', '项目文件超过大小限制');
  }
  let fd;
  try {
    fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    assertStableFileIdentity(opened, before, 'SOURCE_PATH_CHANGED');
    const buffer = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertStableFileIdentity(after, opened);
    const atPath = fs.lstatSync(name, { bigint: true });
    assertStableFileIdentity(atPath, opened);
    if (offset !== buffer.length) fail('SOURCE_CHANGED', '项目文件读取不完整');
    return Object.freeze({
      bytes: buffer,
      size: buffer.length,
      mode: Number(opened.mode & 0o777n),
      digest: crypto.createHash('sha256').update(buffer).digest('hex'),
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function scanBoundProject(binding, limits) {
  assertCurrentDirectory(binding, 'SOURCE_PATH_CHANGED');
  const currentRoot = fs.statSync('.', { bigint: true });
  const files = [];
  const directories = [{
    relative: '',
    mode: Number(currentRoot.mode & 0o777n),
  }];
  let totalBytes = 0;
  let totalEntries = 0;

  function visit(relativeDirectory, depth, directoryIdentity) {
    if (depth > limits.maxDepth) fail('TREE_TOO_DEEP', '项目目录层级过深');
    assertCurrentDirectory(directoryIdentity, 'SOURCE_PATH_CHANGED');
    const entries = fs.readdirSync('.', { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目包含符号链接');
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const entryStat = fs.lstatSync(entry.name, { bigint: true });
      if (entryStat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED', '项目包含符号链接');
      if (totalEntries >= limits.maxFiles) {
        fail('TREE_TOO_LARGE', '项目文件和目录总数超过限制');
      }
      totalEntries += 1;
      if (entryStat.isDirectory()) {
        const childIdentity = identityOf(entryStat);
        directories.push(Object.freeze({
          relative,
          mode: Number(entryStat.mode & 0o777n),
        }));
        process.chdir(entry.name);
        assertCurrentDirectory(childIdentity, 'SOURCE_PATH_CHANGED');
        visit(relative, depth + 1, childIdentity);
        process.chdir('..');
        assertCurrentDirectory(directoryIdentity, 'SOURCE_PATH_CHANGED');
        continue;
      }
      if (!entryStat.isFile()) fail('UNSUPPORTED_ENTRY', '项目包含非普通文件');
      const content = readBoundRegularFile(entry.name, limits);
      totalBytes += content.size;
      if (totalBytes > limits.maxTotalBytes) fail('PROJECT_TOO_LARGE', '项目总大小超过限制');
      files.push(Object.freeze({ relative, ...content }));
    }
  }

  visit('', 0, binding);
  const snapshot = crypto.createHash('sha256');
  const snapshotEntries = [
    ...directories.map(directory => ({
      type: 'directory',
      relative: directory.relative,
      mode: directory.mode,
      digest: '',
      size: 0,
    })),
    ...files.map(file => ({
      type: 'file',
      relative: file.relative,
      mode: file.mode,
      digest: file.digest,
      size: file.size,
    })),
  ].sort((left, right) =>
    left.relative.localeCompare(right.relative, 'en') ||
    left.type.localeCompare(right.type, 'en')
  );
  for (const entry of snapshotEntries) {
    snapshot.update(entry.type, 'utf8');
    snapshot.update('\0');
    snapshot.update(entry.relative, 'utf8');
    snapshot.update('\0');
    snapshot.update(String(entry.mode));
    snapshot.update('\0');
    snapshot.update(String(entry.size));
    snapshot.update('\0');
    snapshot.update(entry.digest);
    snapshot.update('\0');
  }
  return Object.freeze({
    root: binding.path,
    rootIdentity: binding,
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    fileCount: files.length,
    totalBytes,
    snapshotDigest: snapshot.digest('hex'),
  });
}

function scanProjectTree(rootPath, options = {}) {
  const binding = captureDirectory(rootPath, '项目目录');
  const limits = resolveLimits(options);
  return runWithCwdLease(() => {
    enterDirectory(binding, 'SOURCE_PATH_CHANGED');
    return scanBoundProject(binding, limits);
  });
}

function stripFrontMatter(content) {
  const source = String(content || '').replace(/^\uFEFF/, '');
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) return source;
  const match = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return match ? source.slice(match[0].length) : source;
}

function countVisibleChineseCharacters(content) {
  return (stripFrontMatter(content).match(/\p{Script=Han}/gu) || []).length;
}

function inspectScan(scan) {
  const byPath = new Map(scan.files.map(file => [file.relative, file]));
  const edit = byPath.get('edit.md');
  const chapterFiles = scan.files.filter(file =>
    /^chapters\/.+\.(?:md|markdown)$/i.test(file.relative)
  );
  const sourceFiles = scan.files.filter(file => /^references\/.+/i.test(file.relative));
  const visibleChineseChars = chapterFiles.reduce(
    (total, file) => total + countVisibleChineseCharacters(file.bytes.toString('utf8')),
    0
  );
  let editPromptStatus = 'missing';
  if (edit) {
    try {
      editPromptStatus = projectService.inspectEditFrontMatter(edit.bytes.toString('utf8')).status;
    } catch (_) {
      editPromptStatus = 'invalid';
    }
  }
  const errors = [];
  if (!edit) errors.push('EDIT_MD_REQUIRED');
  else if (editPromptStatus !== 'valid') errors.push('EDIT_MD_INVALID');
  if (chapterFiles.length < MIN_CHAPTER_FILES) errors.push('CHAPTER_COUNT_INSUFFICIENT');
  if (visibleChineseChars < MIN_VISIBLE_CHINESE_CHARS) errors.push('MANUSCRIPT_TOO_SHORT');
  if (sourceFiles.length < MIN_SOURCE_FILES) errors.push('SOURCE_MATERIAL_REQUIRED');

  return Object.freeze({
    schema: PREFLIGHT_SCHEMA,
    eligible: errors.length === 0,
    checks: Object.freeze({
      editPromptStatus,
      chapterFileCount: chapterFiles.length,
      visibleChineseChars,
      sourceFileCount: sourceFiles.length,
      projectFileCount: scan.fileCount,
      projectBytes: scan.totalBytes,
    }),
    requirements: Object.freeze({
      minimumChapterFiles: MIN_CHAPTER_FILES,
      minimumVisibleChineseChars: MIN_VISIBLE_CHINESE_CHARS,
      minimumSourceFiles: MIN_SOURCE_FILES,
    }),
    errors: Object.freeze(errors),
    snapshotDigest: scan.snapshotDigest,
  });
}

function inspectProject(rootPath, options = {}) {
  return inspectScan(scanProjectTree(rootPath, options));
}

function validateCopyName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N} _.-]{1,100}$/u.test(value) ||
      value === '.' || value === '..') {
    fail('INVALID_COPY_NAME', '验收副本名称无效');
  }
  return value;
}

function syncCurrentDirectory() {
  const fd = fs.openSync('.', 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function runAtomicDirectoryHelper(sourceParentFd, targetParentFd, request) {
  if (process.platform !== 'darwin') {
    fail('COPY_ATOMIC_PUBLISH_UNAVAILABLE', '当前文件系统不支持排他发布');
  }
  const execution = childProcess.spawnSync(
    '/usr/bin/python3',
    ['-I', ATOMIC_RENAME_HELPER],
    {
      input: JSON.stringify(request),
      encoding: 'utf8',
      maxBuffer: 4096,
      timeout: 5000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', sourceParentFd, targetParentFd],
    }
  );
  let report;
  try {
    report = JSON.parse(String(execution.stdout || ''));
  } catch (_) {
    report = null;
  }
  return { execution, report };
}

function reservePrivateDirectory(parentFd) {
  const { execution, report } = runAtomicDirectoryHelper(
    parentFd,
    parentFd,
    { mode: 'reserve' }
  );
  if (execution.status !== 0 ||
      !report ||
      report.ok !== true ||
      typeof report.name !== 'string' ||
      !/^\.writcraft-author-copy-[a-f0-9]{48}$/.test(report.name) ||
      typeof report.dev !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/.test(report.dev) ||
      typeof report.ino !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/.test(report.ino) ||
      report.mode !== 0o700 ||
      Object.keys(report).sort().join(',') !== 'dev,ino,mode,name,ok') {
    fail('COPY_RESERVATION_UNCERTAIN', '验收副本私有目录预留结果不确定');
  }
  return Object.freeze({
    name: report.name,
    identity: Object.freeze({
      dev: BigInt(report.dev),
      ino: BigInt(report.ino),
    }),
  });
}

function inspectPublishedDirectory(sourceParentFd, targetParentFd, sourceName, targetName) {
  const { execution, report } = runAtomicDirectoryHelper(sourceParentFd, targetParentFd, {
    mode: 'inspect',
    source: sourceName,
    target: targetName,
  });
  if (execution.status !== 0 ||
      !report ||
      report.ok !== true ||
      Object.keys(report).sort().join(',') !== 'ok,source,target' ||
      !isOptionalIdentityReport(report.source) ||
      !isOptionalIdentityReport(report.target)) {
    return null;
  }
  return report;
}

function isOptionalIdentityReport(value) {
  if (value === null) return true;
  return Boolean(
    value &&
    Object.keys(value).sort().join(',') === 'dev,ino,mode,type' &&
    (value.type === 'directory' || value.type === 'other') &&
    typeof value.dev === 'string' &&
    /^(?:0|[1-9][0-9]*)$/.test(value.dev) &&
    typeof value.ino === 'string' &&
    /^(?:0|[1-9][0-9]*)$/.test(value.ino) &&
    Number.isSafeInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777
  );
}

function reportMatchesIdentity(value, expected) {
  return Boolean(
    value &&
    value.type === 'directory' &&
    value.dev === String(expected.dev) &&
    value.ino === String(expected.ino)
  );
}

function publishDirectoryExclusive(
  sourceParentFd,
  targetParentFd,
  sourceName,
  targetName,
  expectedIdentity
) {
  const request = {
    mode: 'publish',
    source: sourceName,
    target: targetName,
    dev: String(expectedIdentity.dev),
    ino: String(expectedIdentity.ino),
  };
  const { execution, report } = runAtomicDirectoryHelper(
    sourceParentFd,
    targetParentFd,
    request
  );
  const strictReport = Boolean(
    report &&
    Object.keys(report).sort().join(',') === 'errno,expected,ok,source,target' &&
    typeof report.ok === 'boolean' &&
    Number.isSafeInteger(report.errno) &&
    typeof report.expected === 'boolean' &&
    isOptionalIdentityReport(report.source) &&
    isOptionalIdentityReport(report.target)
  );
  if (execution.status === 0 &&
      strictReport &&
      report.ok === true &&
      report.expected === true &&
      report.source === null &&
      reportMatchesIdentity(report.target, expectedIdentity)) {
    return Object.freeze({ recovered: false });
  }
  const inspected = inspectPublishedDirectory(
    sourceParentFd,
    targetParentFd,
    sourceName,
    targetName
  );
  if (inspected &&
      inspected.source === null &&
      reportMatchesIdentity(inspected.target, expectedIdentity)) {
    return Object.freeze({ recovered: true });
  }
  if (execution.status === 2 &&
      strictReport &&
      report.ok === false &&
      report.errno === 17 &&
      report.expected === false &&
      reportMatchesIdentity(report.source, expectedIdentity)) {
    fail('COPY_ALREADY_EXISTS', '验收副本已存在');
  }
  if (inspected &&
      reportMatchesIdentity(inspected.source, expectedIdentity) &&
      !reportMatchesIdentity(inspected.target, expectedIdentity)) {
    fail('COPY_ATOMIC_PUBLISH_FAILED', '验收副本排他发布失败');
  }
  throw new AuthorAcceptancePreflightError(
    'COPY_PUBLISH_UNCERTAIN',
    '验收副本排他发布结果无法安全确认',
    { committed: true }
  );
}

function writeBuffer(fd, bytes, position = 0) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      fail('COPY_WRITE_STALLED', '验收副本写入没有取得进展');
    }
    offset += written;
  }
}

function writeOwnedFile(name, bytes, mode) {
  let fd;
  try {
    fd = fs.openSync(
      name,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      0o600
    );
    fs.fchmodSync(fd, 0o600);
    writeBuffer(fd, bytes);
    fs.fsyncSync(fd);
    const opened = fs.fstatSync(fd, { bigint: true });
    const atPath = fs.lstatSync(name, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n ||
        !sameIdentity(identityOf(opened), identityOf(atPath))) {
      fail('COPY_TARGET_CHANGED', '验收副本文件身份发生变化');
    }
    return Object.freeze({
      identity: identityOf(opened),
      mode: Number(opened.mode & 0o777n),
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createDirectoryNode() {
  return {
    type: 'directory',
    children: new Map(),
    identity: null,
    expectedMode: 0o700,
  };
}

function addDirectoryPath(root, components) {
  let cursor = root;
  for (const component of components) {
    const existing = cursor.children.get(component);
    if (existing && existing.type !== 'directory') {
      fail('COPY_TREE_CONFLICT', '验收副本目录结构冲突');
    }
    if (!existing) cursor.children.set(component, createDirectoryNode());
    cursor = cursor.children.get(component);
  }
  return cursor;
}

function buildCopyTree(source) {
  const root = createDirectoryNode();
  root.identity = source.rootIdentity;
  for (const directory of source.directories) {
    if (!directory.relative) continue;
    addDirectoryPath(root, directory.relative.split('/'));
  }
  for (const file of source.files) {
    if (file.relative === COPY_MANIFEST.replaceAll(path.sep, '/')) {
      fail('COPY_MANIFEST_CONFLICT', '原项目已包含验收副本标记');
    }
    const components = file.relative.split('/');
    const name = components.pop();
    const directory = addDirectoryPath(root, components);
    if (directory.children.has(name)) fail('COPY_TREE_CONFLICT', '验收副本文件结构冲突');
    directory.children.set(name, {
      type: 'file',
      identity: null,
      bytes: file.bytes,
      mode: file.mode,
      digest: file.digest,
    });
  }
  addDirectoryPath(root, ['.writcraft']);
  return root;
}

function writeOwnedTree(node, currentIdentity) {
  assertCurrentDirectory(currentIdentity, 'COPY_TARGET_CHANGED');
  const entries = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [name, child] of entries) {
    if (child.type === 'file') {
      const written = writeOwnedFile(name, child.bytes, child.mode);
      child.identity = written.identity;
      child.expectedMode = written.mode;
      continue;
    }
    try {
      fs.mkdirSync(name, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') fail('COPY_TARGET_CHANGED', '验收副本目录被占用');
      throw error;
    }
    fs.chmodSync(name, 0o700);
    const created = fs.lstatSync(name, { bigint: true });
    if (!created.isDirectory() || created.isSymbolicLink()) {
      fail('COPY_TARGET_CHANGED', '验收副本目录身份异常');
    }
    child.identity = identityOf(created);
    child.expectedMode = Number(created.mode & 0o777n);
    process.chdir(name);
    assertCurrentDirectory(child.identity, 'COPY_TARGET_CHANGED');
    writeOwnedTree(child, child.identity);
    syncCurrentDirectory();
    process.chdir('..');
    assertCurrentDirectory(currentIdentity, 'COPY_TARGET_CHANGED');
  }
}

function withOwnedDirectory(rootNode, components, operation) {
  const parents = [];
  let cursor = rootNode;
  for (const component of components) {
    const child = cursor.children.get(component);
    if (!child || child.type !== 'directory' || !child.identity) {
      fail('COPY_TARGET_CHANGED', '验收副本目录不存在');
    }
    parents.push(cursor.identity);
    process.chdir(component);
    assertCurrentDirectory(child.identity, 'COPY_TARGET_CHANGED');
    cursor = child;
  }
  let result;
  let operationError;
  try {
    result = operation(cursor);
  } catch (error) {
    operationError = error;
  }
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    process.chdir('..');
    assertCurrentDirectory(parents[index], 'COPY_TARGET_CHANGED');
  }
  if (operationError) throw operationError;
  return result;
}

function createPreparedManifest(rootNode, manifestBytes) {
  return withOwnedDirectory(rootNode, ['.writcraft'], metadataNode => {
    const name = path.basename(COPY_MANIFEST);
    if (metadataNode.children.has(name)) {
      fail('COPY_MANIFEST_CONFLICT', '验收副本标记冲突');
    }
    let fd;
    try {
      fd = fs.openSync(
        name,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
        0o600
      );
      fs.fchmodSync(fd, 0o600);
      const prepared = Buffer.from(manifestBytes);
      if (prepared[0] !== 0x7b) fail('COPY_COMMIT_FAILED', '验收副本标记格式无效');
      prepared[0] = 0x20;
      writeBuffer(fd, prepared);
      fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd, { bigint: true });
      const atPath = fs.lstatSync(name, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n ||
          !sameIdentity(identityOf(opened), identityOf(atPath))) {
        fail('COPY_TARGET_CHANGED', '验收副本标记身份发生变化');
      }
      metadataNode.children.set(name, {
        type: 'file',
        identity: identityOf(opened),
        bytes: manifestBytes,
        preparedBytes: prepared,
        mode: 0o600,
        expectedMode: Number(opened.mode & 0o777n),
      });
      syncCurrentDirectory();
      return { fd, identity: identityOf(opened) };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw error;
    }
  });
}

function verifyOwnedFile(name, node, prepared) {
  const expectedBytes = prepared && node.preparedBytes
    ? node.preparedBytes
    : node.bytes;
  let fd;
  try {
    const atPathBefore = fs.lstatSync(name, { bigint: true });
    if (atPathBefore.isSymbolicLink() || !atPathBefore.isFile() ||
        atPathBefore.nlink !== 1n ||
        !sameIdentity(node.identity, identityOf(atPathBefore)) ||
        atPathBefore.size !== BigInt(expectedBytes.length) ||
        Number(atPathBefore.mode & 0o777n) !== node.expectedMode) {
      fail('COPY_VERIFY_FAILED', '验收副本文件身份或大小发生变化');
    }
    fd = fs.openSync(name, fs.constants.O_RDONLY | NO_FOLLOW);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n ||
        !sameIdentity(node.identity, identityOf(opened)) ||
        opened.size !== BigInt(expectedBytes.length) ||
        Number(opened.mode & 0o777n) !== node.expectedMode) {
      fail('COPY_VERIFY_FAILED', '验收副本文件身份发生变化');
    }
    const actual = Buffer.allocUnsafe(expectedBytes.length);
    let offset = 0;
    while (offset < actual.length) {
      const read = fs.readSync(fd, actual, offset, actual.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const atPathAfter = fs.lstatSync(name, { bigint: true });
    if (offset !== actual.length ||
        !sameIdentity(node.identity, identityOf(after)) ||
        !sameIdentity(node.identity, identityOf(atPathAfter)) ||
        after.size !== BigInt(expectedBytes.length) ||
        Number(after.mode & 0o777n) !== node.expectedMode ||
        Number(atPathAfter.mode & 0o777n) !== node.expectedMode ||
        !actual.equals(expectedBytes)) {
      fail('COPY_VERIFY_FAILED', '验收副本文件内容或路径发生变化');
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function verifyOwnedTree(node, currentIdentity, prepared = false) {
  assertCurrentDirectory(currentIdentity, 'COPY_VERIFY_FAILED');
  const currentDirectory = fs.statSync('.', { bigint: true });
  if (Number(currentDirectory.mode & 0o777n) !== node.expectedMode) {
    fail('COPY_VERIFY_FAILED', '验收副本目录权限发生变化');
  }
  const expectedNames = [...node.children.keys()].sort((left, right) =>
    left.localeCompare(right, 'en')
  );
  const actualNames = fs.readdirSync('.').sort((left, right) =>
    left.localeCompare(right, 'en')
  );
  if (expectedNames.length !== actualNames.length ||
      expectedNames.some((name, index) => name !== actualNames[index])) {
    fail('COPY_VERIFY_FAILED', '验收副本目录内容发生变化');
  }
  for (const name of expectedNames) {
    const child = node.children.get(name);
    if (child.type === 'file') {
      verifyOwnedFile(name, child, prepared);
      continue;
    }
    const current = fs.lstatSync(name, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
        !sameIdentity(child.identity, identityOf(current)) ||
        Number(current.mode & 0o777n) !== child.expectedMode) {
      fail('COPY_VERIFY_FAILED', '验收副本目录身份发生变化');
    }
    process.chdir(name);
    assertCurrentDirectory(child.identity, 'COPY_VERIFY_FAILED');
    verifyOwnedTree(child, child.identity, prepared);
    process.chdir('..');
    assertCurrentDirectory(currentIdentity, 'COPY_VERIFY_FAILED');
  }
}

function descriptorMatches(fd, expectedBytes) {
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(expectedBytes.length)) return false;
    const actual = Buffer.allocUnsafe(Number(stat.size));
    let offset = 0;
    while (offset < actual.length) {
      const read = fs.readSync(fd, actual, offset, actual.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === actual.length &&
      crypto.timingSafeEqual(actual, expectedBytes);
  } catch (_) {
    return false;
  }
}

function cleanupOperationName(randomHex) {
  const token = typeof randomHex === 'function'
    ? randomHex()
    : crypto.randomBytes(12).toString('hex');
  if (typeof token !== 'string' || !/^[a-f0-9]{24}$/i.test(token)) {
    fail('INVALID_RANDOM', '验收副本清理随机值无效');
  }
  return `.writcraft-author-cleanup-${token.toLowerCase()}`;
}

function restoreQuarantinedEntry(operationName, originalName) {
  let operation;
  try {
    operation = fs.lstatSync(operationName, { bigint: true });
  } catch (_) {
    return false;
  }
  if (!operation.isFile() || operation.isSymbolicLink() || operation.nlink !== 1n) {
    return false;
  }
  try {
    fs.linkSync(operationName, originalName);
  } catch (_) {
    return false;
  }
  try {
    fs.unlinkSync(operationName);
  } catch (_) {
    return false;
  }
  return true;
}

function moveOwnedEntryToQuarantine(name, expectedIdentity, randomHex) {
  const operationName = cleanupOperationName(randomHex);
  try {
    fs.lstatSync(operationName);
    fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理隔离名称被占用');
  } catch (error) {
    if (error instanceof AuthorAcceptancePreflightError) throw error;
    if (error?.code !== 'ENOENT') {
      fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理隔离名称无法核验');
    }
  }
  try {
    fs.renameSync(name, operationName);
  } catch (error) {
    try {
      fs.lstatSync(operationName);
    } catch (_) {
      throw error;
    }
  }
  const moved = fs.lstatSync(operationName, { bigint: true });
  if (!sameIdentity(expectedIdentity, identityOf(moved))) {
    restoreQuarantinedEntry(operationName, name);
    fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理捕获了外来条目');
  }
  return operationName;
}

function cleanupOwnedDirectory(node, currentIdentity, randomHex, prepared) {
  assertCurrentDirectory(currentIdentity, 'COPY_CLEANUP_INCOMPLETE');
  const entries = [...node.children.entries()]
    .sort(([left], [right]) => right.localeCompare(left, 'en'));
  for (const [name, child] of entries) {
    let current;
    try {
      current = fs.lstatSync(name, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理条目无法核验');
    }
    if (!sameIdentity(child.identity, identityOf(current))) {
      fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理条目身份已经变化');
    }
    const operationName = moveOwnedEntryToQuarantine(
      name,
      child.identity,
      randomHex
    );
    if (child.type === 'file') {
      try {
        verifyOwnedFile(operationName, child, prepared);
        fs.unlinkSync(operationName);
      } catch (error) {
        restoreQuarantinedEntry(operationName, name);
        throw error;
      }
      continue;
    }
    let childError;
    let enteredChild = false;
    try {
      process.chdir(operationName);
      assertCurrentDirectory(child.identity, 'COPY_CLEANUP_INCOMPLETE');
      enteredChild = true;
      cleanupOwnedDirectory(child, child.identity, randomHex, prepared);
    } catch (error) {
      childError = error;
    }
    if (enteredChild) {
      try {
        process.chdir('..');
        assertCurrentDirectory(currentIdentity, 'COPY_CLEANUP_INCOMPLETE');
      } catch (error) {
        throw new AuthorAcceptancePreflightError(
          'COPY_CLEANUP_INCOMPLETE',
          '验收副本清理无法返回可信父目录',
          { causeCode: error?.code || null }
        );
      }
    }
    if (childError) {
      restoreQuarantinedEntry(operationName, name);
      throw new AuthorAcceptancePreflightError(
        'COPY_CLEANUP_INCOMPLETE',
        '验收副本清理目录失败',
        { causeCode: childError?.code || null }
      );
    }
    try {
      const atOperation = fs.lstatSync(operationName, { bigint: true });
      if (!sameIdentity(child.identity, identityOf(atOperation))) {
        fail('COPY_CLEANUP_INCOMPLETE', '验收副本清理目录身份已经变化');
      }
      fs.rmdirSync(operationName);
    } catch (error) {
      restoreQuarantinedEntry(operationName, name);
      throw error;
    }
  }
  const remaining = fs.readdirSync('.');
  if (remaining.length !== 0) {
    fail('COPY_CLEANUP_INCOMPLETE', '验收副本包含外来条目');
  }
  return true;
}

function cleanupOwnedCopy(
  parent,
  copyName,
  rootNode,
  finalIdentity,
  randomHex,
  prepared
) {
  try {
    try {
      assertCurrentDirectory(parent, 'COPY_CLEANUP_INCOMPLETE');
    } catch (_) {
      enterDirectory(parent, 'COPY_CLEANUP_INCOMPLETE');
    }
    const current = fs.lstatSync(copyName, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
        !sameIdentity(finalIdentity, identityOf(current))) {
      return false;
    }
    process.chdir(copyName);
    assertCurrentDirectory(finalIdentity, 'COPY_CLEANUP_INCOMPLETE');
    const childrenRemoved = cleanupOwnedDirectory(
      rootNode,
      finalIdentity,
      randomHex,
      prepared
    );
    process.chdir('..');
    assertCurrentDirectory(parent, 'COPY_CLEANUP_INCOMPLETE');
    if (!childrenRemoved) return false;
    fs.rmdirSync(copyName);
    syncCurrentDirectory();
    return true;
  } catch (_) {
    return false;
  }
}

function createWorkingCopy(input = {}, options = {}) {
  const sourceBinding = captureDirectory(input.rootPath, '项目目录');
  const parent = captureDirectory(input.destinationParent, '副本目标目录');
  const limits = resolveLimits(options);
  if (isWithin(sourceBinding.path, parent.path)) {
    fail('COPY_DESTINATION_INSIDE_SOURCE', '验收副本不能创建在原项目内部');
  }
  const copyName = validateCopyName(input.copyName);
  const finalTarget = path.join(parent.path, copyName);

  return runWithCwdLease(() => {
    enterDirectory(sourceBinding, 'SOURCE_PATH_CHANGED');
    const source = scanBoundProject(sourceBinding, limits);
    const preflight = inspectScan(source);
    if (!preflight.eligible) fail('PROJECT_NOT_ELIGIBLE', '项目未通过真实作者验收预检');
    const copyTree = buildCopyTree(source);

    enterDirectory(parent, 'COPY_TARGET_CHANGED');
    let stageName = null;
    let stagePath = null;
    let manifestFd;
    let committed = false;
    let committedRecovered = false;
    let readinessCommitted = false;
    let finalIdentity = null;
    let parentFd;
    try {
      assertDirectoryPathIdentity(parent, 'COPY_TARGET_CHANGED');
      parentFd = fs.openSync(
        '.',
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NO_FOLLOW
      );
      const openedParent = fs.fstatSync(parentFd, { bigint: true });
      if (!openedParent.isDirectory() ||
          !sameIdentity(parent, identityOf(openedParent))) {
        fail('COPY_TARGET_CHANGED', '验收副本父目录身份发生变化');
      }
      const reservation = reservePrivateDirectory(parentFd);
      stageName = reservation.name;
      stagePath = path.join(parent.path, stageName);
      finalIdentity = reservation.identity;
      let stageStat;
      try {
        stageStat = fs.lstatSync(stageName, { bigint: true });
      } catch (error) {
        throw new AuthorAcceptancePreflightError(
          'COPY_RESERVATION_UNCERTAIN',
          '验收副本私有目录已经创建，但身份无法核验',
          { committed: false, causeCode: error?.code || null }
        );
      }
      if (!stageStat.isDirectory() || stageStat.isSymbolicLink() ||
          Number(stageStat.mode & 0o777n) !== 0o700 ||
          !sameIdentity(finalIdentity, identityOf(stageStat))) {
        throw new AuthorAcceptancePreflightError(
          'COPY_RESERVATION_UNCERTAIN',
          '验收副本私有目录身份异常',
          { committed: false }
        );
      }
      copyTree.identity = finalIdentity;
      syncCurrentDirectory();
      process.chdir(stageName);
      assertCurrentDirectory(finalIdentity, 'COPY_TARGET_CHANGED');

      writeOwnedTree(copyTree, finalIdentity);
      syncCurrentDirectory();
      const createdAt = (typeof options.now === 'function' ? options.now() : new Date()).toISOString();
      const manifest = {
        schema: COPY_SCHEMA,
        createdAt,
        sourceSnapshotDigest: source.snapshotDigest,
        sourceFileCount: source.fileCount,
        sourceBytes: source.totalBytes,
        sourceUnchanged: true,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const preparedManifest = createPreparedManifest(copyTree, manifestBytes);
      manifestFd = preparedManifest.fd;
      assertCurrentDirectory(finalIdentity, 'COPY_TARGET_CHANGED');
      process.chdir('..');
      assertCurrentDirectory(parent, 'COPY_TARGET_CHANGED');

      if (typeof options.beforePublish === 'function') {
        options.beforePublish({
          finalTarget: stagePath,
          publicationTarget: finalTarget,
        });
      }
      if (typeof options.beforeSourceRecheck === 'function') {
        options.beforeSourceRecheck();
      }
      assertDirectoryPathIdentity(parent, 'COPY_TARGET_CHANGED');
      const targetAtPath = fs.lstatSync(stageName, { bigint: true });
      if (!targetAtPath.isDirectory() || targetAtPath.isSymbolicLink() ||
          !sameIdentity(finalIdentity, identityOf(targetAtPath))) {
        fail('COPY_TARGET_CHANGED', '验收副本目标在提交前发生变化');
      }
      process.chdir(stageName);
      assertCurrentDirectory(finalIdentity, 'COPY_VERIFY_FAILED');
      verifyOwnedTree(copyTree, finalIdentity, true);
      process.chdir('..');
      assertCurrentDirectory(parent, 'COPY_VERIFY_FAILED');

      const commitDefault = () => {
        writeBuffer(manifestFd, Buffer.from('{', 'utf8'), 0);
        fs.fsyncSync(manifestFd);
      };
      try {
        commitDefault();
        if (!descriptorMatches(manifestFd, manifestBytes)) {
          fail('COPY_COMMIT_FAILED', '验收副本就绪标记未提交');
        }
        readinessCommitted = true;
      } catch (error) {
        if (!descriptorMatches(manifestFd, manifestBytes)) throw error;
        readinessCommitted = true;
        committedRecovered = true;
        try {
          fs.fsyncSync(manifestFd);
        } catch (_) {
          throw new AuthorAcceptancePreflightError(
            'COPY_COMMIT_FAILED',
            '验收副本私有就绪标记持久化失败',
            { committed: false }
          );
        }
      }
      fs.closeSync(manifestFd);
      manifestFd = undefined;

      enterDirectory(parent, 'COPY_TARGET_CHANGED');
      const preparedTarget = fs.lstatSync(stageName, { bigint: true });
      if (!preparedTarget.isDirectory() || preparedTarget.isSymbolicLink() ||
          !sameIdentity(finalIdentity, identityOf(preparedTarget))) {
        fail('COPY_TARGET_CHANGED', '验收副本私有目录在发布前发生变化');
      }
      process.chdir(stageName);
      assertCurrentDirectory(finalIdentity, 'COPY_VERIFY_FAILED');
      verifyOwnedTree(copyTree, finalIdentity, false);
      process.chdir('..');
      assertCurrentDirectory(parent, 'COPY_VERIFY_FAILED');

      if (typeof options.beforeDestinationReserve === 'function') {
        options.beforeDestinationReserve({
          finalTarget,
          candidateTarget: stagePath,
        });
        assertCurrentDirectory(parent, 'COPY_TARGET_CHANGED');
      }
      assertDirectoryPathIdentity(parent, 'COPY_TARGET_CHANGED');

      enterDirectory(sourceBinding, 'SOURCE_PATH_CHANGED');
      const rechecked = scanBoundProject(sourceBinding, limits);
      if (rechecked.snapshotDigest !== source.snapshotDigest) {
        fail('SOURCE_CHANGED', '原项目在创建验收副本期间发生变化');
      }

      const publication = publishDirectoryExclusive(
        parentFd,
        parentFd,
        stageName,
        copyName,
        finalIdentity
      );
      committed = true;
      committedRecovered = committedRecovered || publication.recovered;

      try {
        fs.fsyncSync(parentFd);
      } catch (error) {
        throw new AuthorAcceptancePreflightError(
          'COPY_COMMITTED_FSYNC_FAILED',
          '验收副本已发布，但目标目录持久化确认失败',
          { committed: true, causeCode: error?.code || null }
        );
      }

      let committedSource;
      try {
        enterDirectory(sourceBinding, 'SOURCE_PATH_CHANGED');
        committedSource = scanBoundProject(sourceBinding, limits);
      } catch (error) {
        throw new AuthorAcceptancePreflightError(
          'COPY_COMMITTED_SOURCE_CHANGED',
          '验收副本已提交，但原项目随后发生变化',
          { committed: true, causeCode: error?.code || null }
        );
      }
      if (committedSource.snapshotDigest !== source.snapshotDigest) {
        throw new AuthorAcceptancePreflightError(
          'COPY_COMMITTED_SOURCE_CHANGED',
          '验收副本已提交，但原项目随后发生变化',
          { committed: true }
        );
      }

      try {
        enterDirectory(parent, 'COPY_COMMITTED_TARGET_CHANGED');
        const committedTarget = fs.lstatSync(copyName, { bigint: true });
        if (!committedTarget.isDirectory() || committedTarget.isSymbolicLink() ||
            !sameIdentity(finalIdentity, identityOf(committedTarget))) {
          fail('COPY_COMMITTED_TARGET_CHANGED', '验收副本目标在提交后发生变化');
        }
        process.chdir(copyName);
        assertCurrentDirectory(finalIdentity, 'COPY_COMMITTED_TARGET_CHANGED');
        verifyOwnedTree(copyTree, finalIdentity, false);
        process.chdir('..');
        assertCurrentDirectory(parent, 'COPY_COMMITTED_TARGET_CHANGED');
      } catch (error) {
        throw new AuthorAcceptancePreflightError(
          'COPY_COMMITTED_TARGET_CHANGED',
          '验收副本已提交，但目标路径随后发生变化',
          { committed: true, causeCode: error?.code || null }
        );
      }
      return Object.freeze({
        schema: COPY_SCHEMA,
        ok: true,
        copyCreated: true,
        sourceUnchanged: true,
        sourceSnapshotDigest: source.snapshotDigest,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        committedRecovered,
        preflight,
      });
    } catch (error) {
      if (manifestFd !== undefined) {
        try { fs.closeSync(manifestFd); } catch (_) {}
        manifestFd = undefined;
      }
      if (committed || error?.committed === true) {
        if (error instanceof AuthorAcceptancePreflightError && error.committed === true) {
          throw error;
        }
        throw new AuthorAcceptancePreflightError(
          'COPY_COMMITTED_FSYNC_FAILED',
          '验收副本已创建，但完成确认失败',
          { committed: true, causeCode: error?.code || null }
        );
      }
      if (!finalIdentity || !stageName) throw error;
      const cleaned = cleanupOwnedCopy(
        parent,
        stageName,
        copyTree,
        finalIdentity,
        options.randomHex,
        !readinessCommitted
      );
      if (!cleaned) {
        throw new AuthorAcceptancePreflightError(
          'COPY_CLEANUP_INCOMPLETE',
          '验收副本未提交，且私有工作目录需要人工清理',
          { committed: false, causeCode: error?.code || null }
        );
      }
      throw error;
    } finally {
      if (parentFd !== undefined) {
        try { fs.closeSync(parentFd); } catch (_) {}
      }
    }
  });
}

module.exports = {
  PREFLIGHT_SCHEMA,
  COPY_SCHEMA,
  COPY_MANIFEST,
  MIN_CHAPTER_FILES,
  MIN_VISIBLE_CHINESE_CHARS,
  MIN_SOURCE_FILES,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_DEPTH,
  AuthorAcceptancePreflightError,
  countVisibleChineseCharacters,
  scanProjectTree,
  inspectProject,
  createWorkingCopy,
};
