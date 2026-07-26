'use strict';

// A renderer-independent transaction model for AI-authored, cross-file edits.
// The service intentionally accepts only public Markdown paths and never trusts
// a path, `before` value, or revision supplied by a model without validating it
// against a host-created snapshot.

const crypto = require('crypto');
const Diff = require('diff');

const CHANGESET_SCHEMA = 'writcraft.changeset/v1';
const CHANGE_SELECTION_SCHEMA = 'writcraft.changeset-selection/v1';
const MAX_CHANGE_FILES = 64;
const MAX_CHANGESET_BYTES = 20 * 1024 * 1024;
const MAX_CHANGE_HUNKS = 1024;
const MAX_REVIEW_BYTES = 4 * 1024 * 1024;
const MAX_SELECTION_BYTES = 64 * 1024;
const HUNK_CONTEXT_LINES = 3;
const REVISION_RE = /^[a-f0-9]{64}$/;
const HUNK_ID_RE = /^hk_[a-f0-9]{24}$/;

class ChangeSetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangeSetError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChangeSetError(code, message);
}

function assertText(value, field) {
  if (typeof value !== 'string') fail('INVALID_CHANGESET', `${field} 必须是文本`);
  return value;
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('INVALID_PATH', '修改路径无效');
  }
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    fail('ABSOLUTE_PATH', 'ChangeSet 只允许项目内相对路径');
  }
  if (value.includes('\\') || value.includes('//')) {
    fail('INVALID_PATH', 'ChangeSet 路径必须使用规范的 / 分隔符');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    fail('PATH_TRAVERSAL', 'ChangeSet 路径不能包含空段、. 或 ..');
  }
  if (parts.some(part => part.startsWith('.'))) {
    fail('PRIVATE_PATH', 'ChangeSet 不能修改隐藏或内部文件');
  }
  if (!/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('INVALID_EXTENSION', 'ChangeSet 只能修改 Markdown 文件');
  }
  return parts.join('/');
}

function assertRevision(value, field = 'revision') {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) {
    fail('INVALID_REVISION', `${field} 无效`);
  }
  return value;
}

function canonicalChanges(changes) {
  return changes.map(change => ({
    path: change.path,
    before: change.before,
    after: change.after,
    expectedRevision: change.expectedRevision,
    summary: change.summary,
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function stableId(changes) {
  const canonical = JSON.stringify({ schema: CHANGESET_SCHEMA, changes: canonicalChanges(changes) });
  return `cs_${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24)}`;
}

function validateChanges(changes) {
  if (!Array.isArray(changes)) fail('INVALID_CHANGESET', 'changes 必须是数组');
  if (changes.length > MAX_CHANGE_FILES) {
    fail('TOO_MANY_FILES', `单个 ChangeSet 最多修改 ${MAX_CHANGE_FILES} 个文件`);
  }

  const paths = new Set();
  let totalBytes = 0;
  const normalized = changes.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('INVALID_CHANGESET', `changes[${index}] 无效`);
    }
    const change = {
      path: publicMarkdownPath(raw.path),
      before: assertText(raw.before, `changes[${index}].before`),
      after: assertText(raw.after, `changes[${index}].after`),
      expectedRevision: assertRevision(raw.expectedRevision, `changes[${index}].expectedRevision`),
      summary: assertText(raw.summary, `changes[${index}].summary`).trim(),
    };
    if (!change.summary || change.summary.length > 500) {
      fail('INVALID_SUMMARY', '每项修改需要 1–500 字符的摘要');
    }
    if (paths.has(change.path)) fail('DUPLICATE_PATH', `文件重复出现：${change.path}`);
    paths.add(change.path);
    totalBytes += Buffer.byteLength(change.before, 'utf8') + Buffer.byteLength(change.after, 'utf8');
    if (totalBytes > MAX_CHANGESET_BYTES) {
      fail('CHANGESET_TOO_LARGE', `ChangeSet 文本总量不能超过 ${MAX_CHANGESET_BYTES} 字节`);
    }
    return change;
  });
  return normalized;
}

function makeChangeSet(changes) {
  const normalized = validateChanges(changes);
  return {
    schema: CHANGESET_SCHEMA,
    id: stableId(normalized),
    changes: normalized,
  };
}

/**
 * Bind untrusted proposals to trusted host snapshots.
 *
 * snapshots: [{ path, content, revision }]
 * proposals: [{ path, after, summary, before?, expectedRevision? }]
 */
function createChangeSet(snapshots, proposals) {
  if (!Array.isArray(snapshots) || !Array.isArray(proposals)) {
    fail('INVALID_INPUT', 'snapshots 和 proposals 必须是数组');
  }
  if (snapshots.length > MAX_CHANGE_FILES || proposals.length > MAX_CHANGE_FILES) {
    fail('TOO_MANY_FILES', `单个 ChangeSet 最多修改 ${MAX_CHANGE_FILES} 个文件`);
  }

  const snapshotByPath = new Map();
  for (const [index, raw] of snapshots.entries()) {
    if (!raw || typeof raw !== 'object') fail('INVALID_SNAPSHOT', `snapshot[${index}] 无效`);
    const path = publicMarkdownPath(raw.path);
    if (snapshotByPath.has(path)) fail('DUPLICATE_PATH', `快照文件重复：${path}`);
    const content = assertText(raw.content, `snapshot[${index}].content`);
    const revision = assertRevision(raw.revision, `snapshot[${index}].revision`);
    snapshotByPath.set(path, { path, content, revision });
  }

  const changes = proposals.map((proposal, index) => {
    if (!proposal || typeof proposal !== 'object') fail('INVALID_PROPOSAL', `proposal[${index}] 无效`);
    const path = publicMarkdownPath(proposal.path);
    const snapshot = snapshotByPath.get(path);
    if (!snapshot) fail('UNSNAPSHOTTED_PATH', `AI 试图修改未授权文件：${path}`);
    if (proposal.before !== undefined && proposal.before !== snapshot.content) {
      fail('SNAPSHOT_MISMATCH', `AI 提供的 before 与快照不一致：${path}`);
    }
    if (proposal.expectedRevision !== undefined && proposal.expectedRevision !== snapshot.revision) {
      fail('SNAPSHOT_MISMATCH', `AI 提供的版本与快照不一致：${path}`);
    }
    return {
      path,
      before: snapshot.content,
      after: assertText(proposal.after, `proposal[${index}].after`),
      expectedRevision: snapshot.revision,
      summary: assertText(proposal.summary, `proposal[${index}].summary`),
    };
  });
  // Validate the complete model list before filtering no-ops. Otherwise a
  // duplicate path could be hidden by making one duplicate a no-op.
  const normalized = validateChanges(changes);
  return makeChangeSet(normalized.filter(change => change.after !== change.before));
}

function validateChangeSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CHANGESET', 'ChangeSet 无效');
  }
  if (value.schema !== CHANGESET_SCHEMA) fail('INVALID_SCHEMA', '不支持的 ChangeSet schema');
  const changes = validateChanges(value.changes);
  const expectedId = stableId(changes);
  if (value.id !== expectedId) fail('INVALID_ID', 'ChangeSet ID 与内容不一致');
  return { schema: CHANGESET_SCHEMA, id: expectedId, changes };
}

function changePatch(change) {
  const patch = Diff.structuredPatch(
    change.path,
    change.path,
    change.before,
    change.after,
    '',
    '',
    { context: HUNK_CONTEXT_LINES },
  );
  if (patch.hunks.length > MAX_CHANGE_HUNKS) {
    fail('TOO_MANY_HUNKS', `单个文件最多包含 ${MAX_CHANGE_HUNKS} 个修改块`);
  }
  return patch;
}

function stableHunkId(changeSetId, change, hunk) {
  const canonical = JSON.stringify({
    changeSetId,
    path: change.path,
    expectedRevision: change.expectedRevision,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  });
  return `hk_${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24)}`;
}

function reviewHunks(changeSetId, change) {
  const patch = changePatch(change);
  const ids = new Set();
  const hunks = patch.hunks.map(hunk => {
    const id = stableHunkId(changeSetId, change, hunk);
    if (ids.has(id)) fail('DUPLICATE_HUNK', 'ChangeSet 包含无法区分的修改块');
    ids.add(id);
    return { id, patch: hunk };
  });
  return { patch, hunks };
}

function preview(changeSet, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'structured') ||
      (options.structured !== undefined && typeof options.structured !== 'boolean')) {
    fail('INVALID_PREVIEW_OPTIONS', 'Changes 预览只允许选择固定上下文的结构化输出');
  }
  const valid = validateChangeSet(changeSet);
  const structured = options.structured === true;
  let totalHunks = 0;
  let reviewBytes = 2; // outer []
  const result = valid.changes.map(change => {
    const file = {
      path: change.path,
      summary: change.summary,
      hunks: reviewHunks(valid.id, change).hunks.map(({ id, patch: hunk }) => {
      totalHunks += 1;
      if (totalHunks > MAX_CHANGE_HUNKS) {
        fail('TOO_MANY_HUNKS', `单个 ChangeSet 最多包含 ${MAX_CHANGE_HUNKS} 个修改块`);
      }
      const common = {
        id,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      };
      const item = structured ? {
        ...common,
        lines: hunk.lines.map(line => ({
          kind: line.startsWith('+') ? 'add'
            : line.startsWith('-') ? 'remove'
              : line.startsWith(' ') ? 'context' : 'meta',
          text: /^[+\- ]/.test(line) ? line.slice(1) : line,
        })),
      } : {
        ...common,
        text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`,
      };
      reviewBytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (reviewBytes > MAX_REVIEW_BYTES) {
        fail('REVIEW_TOO_LARGE', `Changes 预览不能超过 ${MAX_REVIEW_BYTES} 字节`);
      }
      return item;
      }),
    };
    reviewBytes += Buffer.byteLength(JSON.stringify({ path: file.path, summary: file.summary }), 'utf8') + 1;
    if (reviewBytes > MAX_REVIEW_BYTES) {
      fail('REVIEW_TOO_LARGE', `Changes 预览不能超过 ${MAX_REVIEW_BYTES} 字节`);
    }
    return file;
  });
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_REVIEW_BYTES) {
    fail('REVIEW_TOO_LARGE', `Changes 预览不能超过 ${MAX_REVIEW_BYTES} 字节`);
  }
  return result;
}

function exactObject(value, keys, code = 'INVALID_SELECTION') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, 'ChangeSet 选择无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, 'ChangeSet 选择包含未知或缺失字段');
  }
}

function validateSelection(value) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (_) { fail('INVALID_SELECTION', 'ChangeSet 选择不可序列化'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_SELECTION_BYTES) {
    fail('SELECTION_TOO_LARGE', `ChangeSet 选择不能超过 ${MAX_SELECTION_BYTES} 字节`);
  }
  exactObject(value, ['schema', 'files']);
  if (value.schema !== CHANGE_SELECTION_SCHEMA || !Array.isArray(value.files)) {
    fail('INVALID_SELECTION', 'ChangeSet 选择 schema 无效');
  }
  if (!value.files.length) fail('NO_CHANGES_SELECTED', '请至少选择一个修改块');
  if (value.files.length > MAX_CHANGE_FILES) fail('TOO_MANY_FILES', '选择文件数量超限');
  const paths = new Set();
  return value.files.map((raw, index) => {
    exactObject(raw, ['path', 'hunkIds']);
    const path = publicMarkdownPath(raw.path);
    if (paths.has(path)) fail('DUPLICATE_PATH', `选择文件重复：${path}`);
    paths.add(path);
    if (!Array.isArray(raw.hunkIds) || !raw.hunkIds.length || raw.hunkIds.length > MAX_CHANGE_HUNKS) {
      fail('INVALID_SELECTION', `files[${index}].hunkIds 无效`);
    }
    const ids = new Set();
    const hunkIds = raw.hunkIds.map(id => {
      if (typeof id !== 'string' || !HUNK_ID_RE.test(id)) fail('INVALID_HUNK_ID', '修改块 ID 无效');
      if (ids.has(id)) fail('DUPLICATE_HUNK', `修改块重复：${id}`);
      ids.add(id);
      return id;
    });
    return { path, hunkIds };
  });
}

function selectHunks(changeSet, selection, options = {}) {
  const valid = validateChangeSet(changeSet);
  const selectedFiles = validateSelection(selection);
  const changeByPath = new Map(valid.changes.map(change => [change.path, change]));
  const selectedChanges = [];
  for (const selectedFile of selectedFiles) {
    const change = changeByPath.get(selectedFile.path);
    if (!change) fail('CHANGE_NOT_FOUND', `ChangeSet 中不存在：${selectedFile.path}`);
    const review = reviewHunks(valid.id, change);
    const available = new Map(review.hunks.map(item => [item.id, item.patch]));
    for (const id of selectedFile.hunkIds) {
      if (!available.has(id)) fail('HUNK_NOT_FOUND', `修改块不属于当前 ChangeSet：${id}`);
    }
    // IDs arrive from Renderer and their order is untrusted. Patches must
    // always be applied in Main's canonical old-file order; Diff.applyPatch
    // can otherwise duplicate or reorder text for a valid reversed ID list.
    const requested = new Set(selectedFile.hunkIds);
    const selected = review.hunks.filter(item => requested.has(item.id)).map(item => item.patch);
    if (options.selectionPolicy === 'file' && selected.length !== review.hunks.length) {
      fail('PARTIAL_SELECTION_FORBIDDEN', `${selectedFile.path} 必须整文件确认`);
    }
    const after = selected.length === review.hunks.length
      ? change.after
      : Diff.applyPatch(change.before, { ...review.patch, hunks: selected }, { fuzzFactor: 0 });
    if (after === false || typeof after !== 'string' || after === change.before) {
      fail('HUNK_APPLY_FAILED', `无法重建所选修改块：${selectedFile.path}`);
    }
    selectedChanges.push({
      ...change,
      after,
      summary: selected.length === review.hunks.length
        ? change.summary
        : `${change.summary}（已选 ${selected.length}/${review.hunks.length} 个修改块）`,
    });
  }
  return makeChangeSet(selectedChanges);
}

function selectPath(changeSet, targetPath, keepTarget) {
  const valid = validateChangeSet(changeSet);
  const path = publicMarkdownPath(targetPath);
  if (!valid.changes.some(change => change.path === path)) {
    fail('CHANGE_NOT_FOUND', `ChangeSet 中不存在：${path}`);
  }
  return makeChangeSet(valid.changes.filter(change => keepTarget ? change.path === path : change.path !== path));
}

// Accepting one produces an independently applicable, one-file ChangeSet;
// rejecting one produces the remainder. Neither operation touches the disk.
function acceptOne(changeSet, targetPath) {
  return selectPath(changeSet, targetPath, true);
}

function rejectOne(changeSet, targetPath) {
  return selectPath(changeSet, targetPath, false);
}

function assertProjectService(service) {
  if (!service || typeof service.readFileWithRevision !== 'function' || typeof service.atomicWriteFile !== 'function') {
    fail('INVALID_PROJECT_SERVICE', 'projectService 缺少版本化读写接口');
  }
}

function applyAll(projectService, rootPath, changeSet) {
  assertProjectService(projectService);
  const valid = validateChangeSet(changeSet);

  // Preflight every file before the first write, so ordinary conflicts never
  // leave a partially applied project.
  try {
    for (const change of valid.changes) {
      const current = projectService.readFileWithRevision(rootPath, change.path);
      if (!current || current.revision !== change.expectedRevision || current.content !== change.before) {
        return { ok: false, status: 'conflict', path: change.path, applied: [], rolledBack: [] };
      }
    }
  } catch (error) {
    return { ok: false, status: 'preflight_failed', error, applied: [], rolledBack: [] };
  }

  const written = [];
  try {
    for (const change of valid.changes) {
      const result = projectService.atomicWriteFile(
        rootPath,
        change.path,
        change.after,
        change.expectedRevision
      );
      written.push({ change, revision: result.revision });
    }
    return {
      ok: true,
      status: 'applied',
      changeSetId: valid.id,
      applied: written.map(item => ({ path: item.change.path, revision: item.revision })),
      rolledBack: [],
    };
  } catch (error) {
    const rolledBack = [];
    const rollbackFailed = [];
    for (const item of written.slice().reverse()) {
      try {
        const result = projectService.atomicWriteFile(
          rootPath,
          item.change.path,
          item.change.before,
          item.revision
        );
        rolledBack.push({ path: item.change.path, revision: result.revision });
      } catch (rollbackError) {
        rollbackFailed.push({ path: item.change.path, error: rollbackError });
      }
    }
    return {
      ok: false,
      status: rollbackFailed.length ? 'rollback_failed' : 'rolled_back',
      error,
      applied: written.map(item => ({ path: item.change.path, revision: item.revision })),
      rolledBack,
      rollbackFailed,
    };
  }
}

module.exports = {
  CHANGESET_SCHEMA,
  CHANGE_SELECTION_SCHEMA,
  MAX_CHANGE_FILES,
  MAX_CHANGESET_BYTES,
  MAX_CHANGE_HUNKS,
  MAX_REVIEW_BYTES,
  MAX_SELECTION_BYTES,
  HUNK_CONTEXT_LINES,
  ChangeSetError,
  createChangeSet,
  validateChangeSet,
  preview,
  selectHunks,
  applyAll,
  acceptOne,
  rejectOne,
};
