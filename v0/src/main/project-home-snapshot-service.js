'use strict';

const inventoryRunner = require('./workspace-inventory-runner');

const SCHEMA = 'writcraft.project-home/v1';
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const LIMITS = Object.freeze({
  recentFiles: 8,
  chapterStates: 1000,
  pendingReviews: 10,
  openIssues: 500,
  explicitSourceGaps: 500,
  partialReasons: 64,
});
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;

class ProjectHomeSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectHomeSnapshotError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectHomeSnapshotError(code, message);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function authorityVector(value = {}) {
  const keys = ['projectMutationGeneration', 'inventoryGeneration', 'graphGeneration', 'sourceGeneration', 'pendingGeneration'];
  if (!value || typeof value !== 'object' || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
    fail('INVALID_AUTHORITY', '项目首页权威向量无效');
  }
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])));
}

function sameDerivedAuthority(left, right) {
  return ['projectMutationGeneration', 'graphGeneration', 'sourceGeneration', 'pendingGeneration']
    .every(key => left[key] === right[key]);
}

function captureHomeState(capture) {
  if (typeof capture !== 'function') fail('INVALID_SNAPSHOT_INPUT', '项目首页缺少 Main 权威状态提供器');
  const value = capture();
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SNAPSHOT_INPUT', '项目首页 Main 权威状态无效');
  const authority = authorityVector({ ...value.authority, inventoryGeneration: 0 });
  const source = value.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      !['ready', 'empty', 'partial', 'unavailable'].includes(source.status) ||
      !['complete', 'partial', 'truncated', 'session_only'].includes(source.completeness) ||
      !Array.isArray(source.reasonCodes) || source.reasonCodes.some(reason => typeof reason !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(reason))) {
    fail('INVALID_SNAPSHOT_INPUT', '项目首页来源 envelope 无效');
  }
  if ((source.status === 'partial' && source.completeness !== 'partial') ||
      (source.status === 'unavailable' && source.completeness !== 'partial') ||
      (source.status === 'empty' && source.completeness !== 'complete')) {
    fail('INVALID_SNAPSHOT_INPUT', '项目首页来源状态组合无效');
  }
  const allSourceReasons = [...new Set(source.reasonCodes)];
  const sourceReasons = allSourceReasons.length > LIMITS.partialReasons
    ? [...allSourceReasons.slice(0, LIMITS.partialReasons - 1), 'SOURCE_REASON_LIMIT']
    : allSourceReasons;
  if (source.status === 'partial' && !sourceReasons.length) sourceReasons.push('SOURCE_PARTIAL');
  if (source.status === 'unavailable' && !sourceReasons.length) sourceReasons.push('SOURCE_UNAVAILABLE');
  const normalizedSource = Object.freeze({
    status: source.status === 'partial' ? 'ready' : source.status,
    completeness: source.status === 'unavailable' ? 'partial' : source.completeness,
    reasonCodes: Object.freeze(sourceReasons),
  });
  return Object.freeze({
    authority,
    workspace: value.workspace && typeof value.workspace === 'object' ? value.workspace : null,
    fileTimes: value.fileTimes,
    pendingReviews: value.pendingReviews,
    openIssues: value.openIssues,
    source: normalizedSource,
  });
}

function boundedString(value, maximum = 1024) {
  if (typeof value !== 'string') return '';
  if (Buffer.byteLength(value, 'utf8') > maximum) fail('HOME_SNAPSHOT_FIELD_LIMIT', '项目首页字段超过安全范围');
  return value;
}

function publicPath(value) {
  const path = boundedString(value, 4096);
  if (!path || path.includes('\0') || path.includes('\\') || path.includes('//') || path.startsWith('/') ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('HOME_SNAPSHOT_INVALID_PATH', '项目首页包含无效路径');
  }
  return path;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function appendBounded(base, key, candidates, limit, reasonCodes) {
  const output = [];
  for (const candidate of candidates) {
    if (output.length >= limit) {
      reasonCodes.add(`${key.toUpperCase()}_LIMIT`);
      break;
    }
    const next = { ...base, [key]: [...output, candidate], partialReasons: [...reasonCodes] };
    if (serializedBytes(next) > MAX_SNAPSHOT_BYTES) {
      reasonCodes.add(`${key.toUpperCase()}_LIMIT`);
      break;
    }
    output.push(candidate);
  }
  return Object.freeze(output);
}

function createProjectHomeSnapshotService(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  let inventoryGeneration = 0;
  let latestInventory = null;

  async function build(request = {}) {
    if (!PROJECT_INSTANCE_ID_RE.test(String(request.projectInstanceId || ''))) {
      fail('NO_PROJECT', '尚未打开项目');
    }
    const before = captureHomeState(request.captureHomeState);
    const inventory = await (request.inventoryRunner || inventoryRunner.runWorkspaceInventory)({
      rootPath: request.rootPath,
      deadlineMs: request.deadlineMs,
      captureAuthority: request.captureAuthority,
      WorkerClass: request.WorkerClass,
    });
    const after = captureHomeState(request.captureHomeState);
    if (!sameDerivedAuthority(before.authority, after.authority)) {
      fail('PROJECT_CHANGED', '项目首页派生索引在扫描期间已变化');
    }
    inventoryGeneration += 1;
    if (!Array.isArray(request.partialReasons) || request.partialReasons.some(reason =>
      typeof reason !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(reason))) {
      fail('INVALID_SNAPSHOT_INPUT', '项目首页 partial reason 无效');
    }
    const reasons = new Set(request.partialReasons.slice(0, LIMITS.partialReasons));
    const authority = authorityVector({
      ...before.authority,
      inventoryGeneration,
    });
    if (inventory.authority.projectInstanceId !== request.projectInstanceId ||
        inventory.authority.projectMutationGeneration !== authority.projectMutationGeneration) {
      fail('PROJECT_CHANGED', '项目首页索引不属于当前项目权威');
    }
    const workspace = before.workspace;
    const activeFile = workspace && inventory.files.find(file => file.path === workspace.activePath);
    const continueLocation = activeFile ? Object.freeze({
      kind: 'file',
      path: activeFile.path,
      revision: activeFile.revision,
      caretOffset: integer(workspace.files?.[activeFile.path]?.cursorOffset ?? workspace.files?.[activeFile.path]?.caretOffset),
      scrollTop: integer(workspace.files?.[activeFile.path]?.scrollTop),
    }) : null;

    if (!before.fileTimes || typeof before.fileTimes !== 'object' || Array.isArray(before.fileTimes)) {
      fail('INVALID_SNAPSHOT_INPUT', '项目首页来源状态无效');
    }
    const fileTimes = before.fileTimes;
    const recentCandidates = inventory.files
      .filter(file => file.manuscript)
      .map(file => ({ file, mtimeMs: fileTimes?.[file.path] }))
      .filter(item => Number.isFinite(item.mtimeMs) && item.mtimeMs >= 0 && item.mtimeMs <= 8.64e15)
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.file.path.localeCompare(right.file.path, 'en-US'))
      .map(item => Object.freeze({
        path: publicPath(item.file.path), mtimeMs: item.mtimeMs,
        stableLocator: Object.freeze({ kind: 'file', path: publicPath(item.file.path) }),
      }));
    if (inventory.files.some(file => file.manuscript && (!Number.isFinite(fileTimes[file.path]) ||
      fileTimes[file.path] < 0 || fileTimes[file.path] > 8.64e15))) {
      reasons.add('FILE_TIME_UNAVAILABLE');
    }

    for (const reason of before.source.reasonCodes) reasons.add(reason);

    const pendingPathSet = new Set((before.pendingReviews || []).flatMap(item => item.targetPaths || []));
    const issuePathSet = new Set((before.openIssues || []).filter(issue => issue?.status === 'open' && issue.filePath).map(issue => issue.filePath));
    const gapPathSet = new Set((before.openIssues || []).filter(issue => issue?.status === 'open' && issue.type === 'evidence_gap' && issue.filePath).map(issue => issue.filePath));
    const chapterCandidates = inventory.files.filter(file => file.manuscript).map(file => Object.freeze({
      path: publicPath(file.path),
      revision: file.revision,
      wordCount: file.wordCount,
      baseState: file.chapterState,
      flags: Object.freeze([
        ...(pendingPathSet.has(file.path) ? ['pending_review'] : []),
        ...(issuePathSet.has(file.path) ? ['open_issue'] : []),
        ...(gapPathSet.has(file.path) ? ['source_gap'] : []),
      ]),
      stableLocator: Object.freeze({ kind: 'file', path: publicPath(file.path) }),
    }));
    const pendingCandidates = Array.isArray(before.pendingReviews) ? before.pendingReviews.map(item => Object.freeze({
      locationId: boundedString(item.locationId, 128),
      label: boundedString(item.label),
      targetPaths: Object.freeze((item.targetPaths || []).slice(0, 8).map(publicPath)),
      fileCount: integer(item.fileCount),
      hunkCount: integer(item.hunkCount),
      expiresAt: item.expiresAt == null ? null : integer(item.expiresAt),
    })) : [];
    const issues = Array.isArray(before.openIssues) ? before.openIssues.filter(issue => issue?.status === 'open') : [];
    const issueCandidates = issues.filter(issue => issue.type !== 'evidence_gap').map(issue => Object.freeze({
      issueId: boundedString(issue.id, 128),
      type: boundedString(issue.type, 128),
      title: boundedString(issue.title),
      severity: boundedString(issue.severity, 64),
      stableLocator: Object.freeze({ kind: 'issue', issueId: boundedString(issue.id, 128) }),
    }));
    const gapCandidates = issues.filter(issue => issue.type === 'evidence_gap').map(issue => Object.freeze({
      issueId: boundedString(issue.id, 128),
      title: boundedString(issue.title),
      stableLocator: Object.freeze({ kind: 'issue', issueId: boundedString(issue.id, 128) }),
    }));

    const base = {
      schema: SCHEMA,
      projectInstanceId: request.projectInstanceId,
      authority,
      status: 'ready',
      generatedAt: new Date(clock()).toISOString(),
      summary: Object.freeze({
        markdownFileCount: inventory.markdownFileCount,
        manuscriptFileCount: inventory.manuscriptFileCount,
        manuscriptWordCount: inventory.manuscriptWordCount,
      }),
      continueLocation,
      recentFiles: [], chapterStates: [], pendingReviews: [], openIssues: [], explicitSourceGaps: [],
      sourceStatus: before.source.status,
      partialReasons: [],
    };
    const recentFiles = appendBounded(base, 'recentFiles', recentCandidates, LIMITS.recentFiles, reasons);
    const withRecent = { ...base, recentFiles };
    const chapterStates = appendBounded(withRecent, 'chapterStates', chapterCandidates, LIMITS.chapterStates, reasons);
    const withChapters = { ...withRecent, chapterStates };
    const pendingReviews = appendBounded(withChapters, 'pendingReviews', pendingCandidates, LIMITS.pendingReviews, reasons);
    const withPending = { ...withChapters, pendingReviews };
    const openIssues = appendBounded(withPending, 'openIssues', issueCandidates, LIMITS.openIssues, reasons);
    const withIssues = { ...withPending, openIssues };
    const explicitSourceGaps = appendBounded(withIssues, 'explicitSourceGaps', gapCandidates, LIMITS.explicitSourceGaps, reasons);
    let finalRecentFiles = [...recentFiles];
    let finalChapterStates = [...chapterStates];
    let finalPendingReviews = [...pendingReviews];
    let finalOpenIssues = [...openIssues];
    let finalExplicitSourceGaps = [...explicitSourceGaps];
    const composeResult = () => {
      const partialReasons = Object.freeze([...reasons].slice(0, LIMITS.partialReasons));
      return Object.freeze({
      ...base,
      recentFiles: Object.freeze(finalRecentFiles),
      chapterStates: Object.freeze(finalChapterStates),
      pendingReviews: Object.freeze(finalPendingReviews),
      openIssues: Object.freeze(finalOpenIssues),
      explicitSourceGaps: Object.freeze(finalExplicitSourceGaps),
      status: partialReasons.length ? 'partial' : 'ready', partialReasons,
      sections: Object.freeze({
        recentFiles: Object.freeze({
          dataStatus: finalRecentFiles.length ? 'ready' : 'empty',
          completeness: reasons.has('RECENTFILES_LIMIT') ? 'truncated' : reasons.has('FILE_TIME_UNAVAILABLE') ? 'partial' : 'complete',
          reasonCodes: Object.freeze([...reasons].filter(reason => reason === 'RECENTFILES_LIMIT' || reason === 'FILE_TIME_UNAVAILABLE')),
        }),
        chapterStates: Object.freeze({
          dataStatus: finalChapterStates.length ? 'ready' : 'empty',
          completeness: reasons.has('CHAPTERSTATES_LIMIT') ? 'truncated' : 'complete',
          reasonCodes: Object.freeze(reasons.has('CHAPTERSTATES_LIMIT') ? ['CHAPTERSTATES_LIMIT'] : []),
        }),
        pendingReviews: Object.freeze({
          dataStatus: finalPendingReviews.length ? 'ready' : 'empty', completeness: 'session_only',
          reasonCodes: Object.freeze(reasons.has('PENDINGREVIEWS_LIMIT') ? ['PENDINGREVIEWS_LIMIT'] : []),
        }),
        openIssues: Object.freeze({
          dataStatus: finalOpenIssues.length ? 'ready' : 'empty',
          completeness: reasons.has('OPENISSUES_LIMIT') ? 'truncated' : 'complete',
          reasonCodes: Object.freeze(reasons.has('OPENISSUES_LIMIT') ? ['OPENISSUES_LIMIT'] : []),
        }),
        explicitSourceGaps: Object.freeze({
          dataStatus: finalExplicitSourceGaps.length ? 'ready' : 'empty',
          completeness: reasons.has('EXPLICITSOURCEGAPS_LIMIT') ? 'truncated' : 'complete',
          reasonCodes: Object.freeze(reasons.has('EXPLICITSOURCEGAPS_LIMIT') ? ['EXPLICITSOURCEGAPS_LIMIT'] : []),
        }),
        sources: Object.freeze({
          dataStatus: before.source.status,
          completeness: before.source.completeness,
          reasonCodes: before.source.reasonCodes,
        }),
      }),
    });
    };
    let result = composeResult();
    const trimOrder = [
      { reason: 'EXPLICITSOURCEGAPS_LIMIT', trim: () => finalExplicitSourceGaps.pop() },
      { reason: 'OPENISSUES_LIMIT', trim: () => finalOpenIssues.pop() },
      { reason: 'PENDINGREVIEWS_LIMIT', trim: () => finalPendingReviews.pop() },
      { reason: 'RECENTFILES_LIMIT', trim: () => finalRecentFiles.pop() },
      { reason: 'CHAPTERSTATES_LIMIT', trim: () => finalChapterStates.pop() },
    ];
    let trimIndex = 0;
    while (serializedBytes(result) > MAX_SNAPSHOT_BYTES) {
      reasons.add('HOME_RESPONSE_LIMIT');
      while (trimIndex < trimOrder.length && !trimOrder[trimIndex].trim()) trimIndex += 1;
      if (trimIndex >= trimOrder.length) fail('HOME_SNAPSHOT_TOO_LARGE', '项目首页固定响应超过安全范围');
      reasons.add(trimOrder[trimIndex].reason);
      result = composeResult();
    }
    latestInventory = inventory;
    return result;
  }

  return Object.freeze({
    build,
    get inventoryGeneration() { return inventoryGeneration; },
    get latestInventory() { return latestInventory; },
  });
}

module.exports = {
  SCHEMA,
  MAX_SNAPSHOT_BYTES,
  LIMITS,
  ProjectHomeSnapshotError,
  createProjectHomeSnapshotService,
};
