'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ISSUES_SCHEMA = 'writcraft.issues/v1';
const GRAPH_SCHEMA = 'writcraft.graph/v2';
const ISSUES_RELATIVE_PATH = '.writcraft/issues.json';
const MAX_ISSUES_FILE_BYTES = 2 * 1024 * 1024;
const MAX_STATES = 5000;
const ALLOWED_STATUSES = new Set(['open', 'acknowledged', 'dismissed', 'resolved']);
const ISSUE_ID_RE = /^issue_[A-Za-z0-9_-]{1,120}$/;

class IssueStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IssueStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IssueStateError(code, message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validIssueId(value) {
  if (typeof value !== 'string' || !ISSUE_ID_RE.test(value)) fail('INVALID_ISSUE_ID', '问题 ID 无效');
  return value;
}

function validStatus(value) {
  if (!ALLOWED_STATUSES.has(value)) fail('INVALID_ISSUE_STATUS', '不支持的问题状态');
  return value;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('INVALID_ISSUES_FILE', '问题状态时间无效');
  return value;
}

function stateLocation(rootPath, createMetadataDirectory = false) {
  if (typeof rootPath !== 'string' || !rootPath) fail('INVALID_ROOT', '项目目录无效');
  const absolute = path.resolve(rootPath);
  let rootStat;
  try { rootStat = fs.statSync(absolute); } catch (_) { fail('INVALID_ROOT', '项目目录不存在'); }
  if (!rootStat.isDirectory()) fail('INVALID_ROOT', '项目路径不是目录');
  const root = fs.realpathSync(absolute);
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    if (!createMetadataDirectory) {
      return { root, metadata, file: path.join(metadata, 'issues.json'), exists: false };
    }
    fs.mkdirSync(metadata, { mode: 0o700 });
  }
  const metadataStat = fs.lstatSync(metadata);
  if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory() || fs.realpathSync(metadata) !== metadata) {
    fail('UNSAFE_ISSUES_PATH', '.writcraft 必须是项目内普通目录');
  }
  const file = path.join(metadata, 'issues.json');
  if (fs.existsSync(file)) {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail('UNSAFE_ISSUES_PATH', 'issues.json 必须是普通文件');
  }
  return { root, metadata, file, exists: fs.existsSync(file) };
}

function atomicWrite(filePath, content) {
  const temporary = path.join(
    path.dirname(filePath),
    `.issues.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
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

function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== ISSUES_SCHEMA || raw.graphSchema !== GRAPH_SCHEMA ||
      !Array.isArray(raw.states) || raw.states.length > MAX_STATES) {
    fail('INVALID_ISSUES_FILE', '问题状态文件 schema 或结构无效');
  }
  const seen = new Set();
  const states = raw.states.map(state => {
    if (!state || typeof state !== 'object') fail('INVALID_ISSUES_FILE', '问题状态记录无效');
    const issueId = validIssueId(state.issueId);
    const status = validStatus(state.status);
    if (status === 'open') fail('INVALID_ISSUES_FILE', 'open 是默认状态，不应作为覆盖持久化');
    if (seen.has(issueId)) fail('INVALID_ISSUES_FILE', '问题状态记录重复');
    seen.add(issueId);
    return { issueId, status, updatedAt: validTimestamp(state.updatedAt) };
  }).sort((left, right) => compareText(left.issueId, right.issueId));
  return {
    schema: ISSUES_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    updatedAt: validTimestamp(raw.updatedAt),
    states,
  };
}

function emptyDocument() {
  return {
    schema: ISSUES_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    updatedAt: new Date().toISOString(),
    states: [],
  };
}

function loadIssueState(rootPath) {
  let location;
  try {
    location = stateLocation(rootPath, false);
  } catch (error) {
    if (error instanceof IssueStateError && error.code === 'UNSAFE_ISSUES_PATH') {
      // Reading a project must not fail because optional user-state storage is
      // unsafe. Ignore the symlink and expose open defaults, but mark writes as
      // blocked so no caller mistakes this for durable state.
      return { document: emptyDocument(), reason: 'UNSAFE_PATH', needsRepair: false, persistenceBlocked: true };
    }
    throw error;
  }
  if (!location.exists) return { document: emptyDocument(), reason: 'MISSING', needsRepair: false };
  try {
    const stat = fs.statSync(location.file);
    if (stat.size > MAX_ISSUES_FILE_BYTES) {
      return { document: emptyDocument(), reason: 'TOO_LARGE', needsRepair: true };
    }
    const document = normalizeDocument(JSON.parse(fs.readFileSync(location.file, 'utf8')));
    return { document, reason: null, needsRepair: false };
  } catch (error) {
    if (error instanceof IssueStateError && error.code === 'UNSAFE_ISSUES_PATH') throw error;
    return {
      document: emptyDocument(),
      reason: error instanceof IssueStateError ? 'INVALID' : 'CORRUPT',
      needsRepair: true,
    };
  }
}

function saveIssueState(rootPath, document) {
  const normalized = normalizeDocument(document);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ISSUES_FILE_BYTES) {
    fail('ISSUES_FILE_TOO_LARGE', '问题状态文件超过大小上限');
  }
  const location = stateLocation(rootPath, true);
  atomicWrite(location.file, serialized);
  return normalized;
}

function normalizeGraphIssues(graphIssues) {
  if (!Array.isArray(graphIssues)) fail('INVALID_GRAPH_ISSUES', '当前图谱问题列表无效');
  const seen = new Set();
  return graphIssues.map(issue => {
    if (!issue || typeof issue !== 'object') fail('INVALID_GRAPH_ISSUES', '当前图谱问题无效');
    const id = validIssueId(issue.id);
    if (seen.has(id)) fail('INVALID_GRAPH_ISSUES', '当前图谱问题 ID 重复');
    seen.add(id);
    return { ...issue, status: 'open' };
  });
}

function documentFromStates(states) {
  return {
    schema: ISSUES_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    updatedAt: new Date().toISOString(),
    states: [...states].sort((left, right) => compareText(left.issueId, right.issueId)),
  };
}

function reconcileIssueStates(rootPath, graphIssues) {
  const issues = normalizeGraphIssues(graphIssues);
  const currentIds = new Set(issues.map(issue => issue.id));
  const loaded = loadIssueState(rootPath);
  const kept = loaded.document.states.filter(state => currentIds.has(state.issueId));
  const byId = new Map(kept.map(state => [state.issueId, state]));
  const reconciledIssues = issues.map(issue => ({ ...issue, status: byId.get(issue.id)?.status || 'open' }));
  const pruned = loaded.document.states.length - kept.length;
  let document = documentFromStates(kept);
  const shouldWrite = loaded.needsRepair || pruned > 0;
  if (shouldWrite) document = saveIssueState(rootPath, document);
  else document.updatedAt = loaded.document.updatedAt;
  return {
    issues: reconciledIssues,
    document,
    recovered: loaded.needsRepair,
    recoveryReason: loaded.reason,
    pruned,
    persistenceBlocked: loaded.persistenceBlocked === true,
  };
}

function setIssueStatus(rootPath, graphIssues, issueId, status) {
  const id = validIssueId(issueId);
  const nextStatus = validStatus(status);
  const reconciled = reconcileIssueStates(rootPath, graphIssues);
  const issue = reconciled.issues.find(item => item.id === id);
  if (!issue) fail('ISSUE_NOT_FOUND', '当前图谱中不存在该问题');
  const states = new Map(reconciled.document.states.map(state => [state.issueId, state]));
  if (nextStatus === 'open') states.delete(id);
  else states.set(id, { issueId: id, status: nextStatus, updatedAt: new Date().toISOString() });
  const document = saveIssueState(rootPath, documentFromStates([...states.values()]));
  return {
    issue: { ...issue, status: nextStatus },
    document,
    recovered: reconciled.recovered,
    recoveryReason: reconciled.recoveryReason,
    pruned: reconciled.pruned,
  };
}

module.exports = {
  ISSUES_SCHEMA,
  GRAPH_SCHEMA,
  ISSUES_RELATIVE_PATH,
  ALLOWED_STATUSES,
  IssueStateError,
  loadIssueState,
  saveIssueState,
  reconcileIssueStates,
  setIssueStatus,
};
