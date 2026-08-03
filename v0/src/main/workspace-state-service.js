'use strict';

// Pure workspace-state contract. Filesystem authority stays in project-service;
// this module validates only a caller-supplied, already project-bound path.

const SCHEMA_V1 = 'writcraft.workspace/v1';
const SCHEMA_V2 = 'writcraft.workspace/v2';
const MAX_TABS = 100;
const MAX_RETURN_STACK = 32;
const MAX_COLLAPSED_OUTLINES = 128;
const MAX_NUMBER = 1_000_000_000;
const SECTION_ID_RE = /^sec_[a-f0-9]{16}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const VIEWS = new Set(['project_home', 'editor', 'graph', 'sources', 'changes']);

class WorkspaceStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceStateError';
    this.code = code;
  }
}

function fail(message) {
  throw new WorkspaceStateError('INVALID_WORKSPACE', message);
}

function plain(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function number(value, label, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_NUMBER ||
      (integer && !Number.isSafeInteger(value))) fail(`${label}无效`);
  return value;
}

function nullableOutlineId(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !SECTION_ID_RE.test(value)) fail(`${label}无效`);
  return value;
}

function fileState(value = {}) {
  if (!exactKeys(value, [
    'caretOffset', 'selectionAnchorOffset', 'selectionFocusOffset', 'scrollTop',
    'activeOutlineId', 'collapsedOutlineIds',
  ])) fail('工作区文件位置字段无效');
  if (!Array.isArray(value.collapsedOutlineIds) || value.collapsedOutlineIds.length > MAX_COLLAPSED_OUTLINES) {
    fail('折叠标题状态无效');
  }
  const collapsed = [];
  const seen = new Set();
  for (const id of value.collapsedOutlineIds) {
    const normalized = nullableOutlineId(id, '折叠标题');
    if (normalized === null || seen.has(normalized)) fail('折叠标题状态无效');
    seen.add(normalized);
    collapsed.push(normalized);
  }
  return {
    caretOffset: number(value.caretOffset, '光标位置', true),
    selectionAnchorOffset: number(value.selectionAnchorOffset, '选区起点', true),
    selectionFocusOffset: number(value.selectionFocusOffset, '选区终点', true),
    scrollTop: number(value.scrollTop, '滚动位置'),
    activeOutlineId: nullableOutlineId(value.activeOutlineId, '当前标题'),
    collapsedOutlineIds: collapsed,
  };
}

function stableLocator(value, assertPath) {
  if (value === null) return null;
  let normalized;
  if (exactKeys(value, ['kind', 'path']) && value.kind === 'file') {
    normalized = { kind: 'file', path: assertPath(value.path) };
  } else if (exactKeys(value, ['kind', 'path', 'sectionId']) && value.kind === 'heading' &&
      SECTION_ID_RE.test(value.sectionId || '')) {
    normalized = { kind: 'heading', path: assertPath(value.path), sectionId: value.sectionId };
  } else if (exactKeys(value, ['kind', 'nodeId']) && value.kind === 'entity' &&
      /^node_[a-f0-9]{16}$/.test(value.nodeId || '')) {
    normalized = { kind: 'entity', nodeId: value.nodeId };
  } else if (exactKeys(value, ['kind', 'issueId']) && value.kind === 'issue' &&
      /^issue_[a-f0-9]{16}$/.test(value.issueId || '')) {
    normalized = { kind: 'issue', issueId: value.issueId };
  } else {
    fail('返回定位无效');
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 8 * 1024) fail('返回定位过大');
  return normalized;
}

function editorReturnState(value, assertPath) {
  if (value === null) return null;
  if (!exactKeys(value, [
    'path', 'caretOffset', 'selectionAnchorOffset', 'selectionFocusOffset', 'scrollTop', 'revision',
  ]) || typeof value.revision !== 'string' || !REVISION_RE.test(value.revision)) {
    fail('编辑器返回位置无效');
  }
  const normalized = {
    path: assertPath(value.path),
    caretOffset: number(value.caretOffset, '返回光标', true),
    selectionAnchorOffset: number(value.selectionAnchorOffset, '返回选区起点', true),
    selectionFocusOffset: number(value.selectionFocusOffset, '返回选区终点', true),
    scrollTop: number(value.scrollTop, '返回滚动位置'),
    revision: value.revision,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 16 * 1024) fail('编辑器返回位置过大');
  return normalized;
}

function returnEntry(value, assertPath) {
  if (!exactKeys(value, ['view', 'stableLocator', 'scrollTop', 'editorReturnState']) ||
      !VIEWS.has(value.view)) fail('返回路径条目无效');
  return {
    view: value.view,
    stableLocator: stableLocator(value.stableLocator, assertPath),
    scrollTop: number(value.scrollTop, '视图滚动位置'),
    editorReturnState: editorReturnState(value.editorReturnState, assertPath),
  };
}

function normalizeV2(state, assertPath) {
  if (!exactKeys(state, ['tabs', 'activePath', 'files', 'returnStack']) ||
      !Array.isArray(state.tabs) || state.tabs.length === 0 || state.tabs.length > MAX_TABS ||
      !plain(state.files) || !Array.isArray(state.returnStack) || state.returnStack.length > MAX_RETURN_STACK) {
    fail('工作区状态无效');
  }
  const tabs = [];
  const seen = new Set();
  for (const candidate of state.tabs) {
    const path = assertPath(candidate);
    if (!seen.has(path)) {
      seen.add(path);
      tabs.push(path);
    }
  }
  const activePath = assertPath(state.activePath);
  if (!seen.has(activePath)) fail('当前文件必须在已打开标签页中');
  const files = {};
  for (const path of tabs) files[path] = fileState(state.files[path]);

  const returnStack = [];
  for (const candidate of state.returnStack) {
    const normalized = returnEntry(candidate, assertPath);
    const previous = returnStack[returnStack.length - 1];
    if (!previous || JSON.stringify(previous) !== JSON.stringify(normalized)) returnStack.push(normalized);
  }
  return { tabs, activePath, files, returnStack };
}

function migrateV1(state, assertPath) {
  if (!plain(state) || !Array.isArray(state.tabs) || !plain(state.files)) fail('旧工作区状态无效');
  return normalizeV2({
    tabs: state.tabs,
    activePath: state.activePath,
    files: Object.fromEntries(state.tabs.map(path => {
      const old = plain(state.files[path]) ? state.files[path] : {};
      const caret = Number.isSafeInteger(old.cursorOffset) && old.cursorOffset >= 0 ? old.cursorOffset : 0;
      const scrollTop = typeof old.scrollTop === 'number' && Number.isFinite(old.scrollTop) && old.scrollTop >= 0
        ? old.scrollTop
        : 0;
      return [path, {
        caretOffset: caret,
        selectionAnchorOffset: caret,
        selectionFocusOffset: caret,
        scrollTop,
        activeOutlineId: null,
        collapsedOutlineIds: [],
      }];
    })),
    returnStack: [],
  }, assertPath);
}

module.exports = {
  SCHEMA_V1,
  SCHEMA_V2,
  WorkspaceStateError,
  migrateV1,
  normalizeV2,
};
