'use strict';

// Session-scoped public locations. Renderer receives display-only opaque IDs;
// every list/resolve call obtains the current Main authority and inventory from
// currentStateProvider. A location ID therefore identifies intent, never a
// cached path/revision or a transferable write capability.

const crypto = require('crypto');
const path = require('path');

const SCHEMA = 'writcraft.workspace-locations/v1';
const OUTLINE_SCHEMA = 'writcraft.document-outline/v1';
const RESOLVED_SCHEMA = 'writcraft.workspace-location-resolved/v1';
const KINDS = new Set(['file', 'heading', 'entity', 'issue', 'pending_review']);
const LOCATION_ID_RE = /^wl_[a-f0-9]{32}$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const SECTION_ID_RE = /^sec_[a-f0-9]{16}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const MAX_QUERY_BYTES = 256;
const MAX_LIMIT = 100;
const MAX_OUTLINE_ITEMS = 1000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TARGET_BYTES = 8 * 1024;
const MAX_LOCATIONS = 1024;
const LOCATION_TTL_MS = 5 * 60 * 1000;
const MAX_MINT_ATTEMPTS = 16;

class WorkspaceLocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceLocationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceLocationError(code, message);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value, maximum = 1024) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum;
}

function validAuthority(value) {
  const keys = ['projectMutationGeneration', 'inventoryGeneration', 'graphGeneration', 'sourceGeneration', 'pendingGeneration'];
  return exactKeys(value, keys) && keys.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 4096 || value.includes('\0') ||
      value.includes('\\') || value.includes('//') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.split('/');
  return !parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) &&
    /\.(?:md|markdown)$/i.test(parts[parts.length - 1]);
}

function stableLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_LOCATION', '定位描述无效');
  let normalized;
  if (value.kind === 'file' && exactKeys(value, ['kind', 'path']) && publicMarkdownPath(value.path)) {
    normalized = { kind: 'file', path: value.path };
  } else if (value.kind === 'heading' && exactKeys(value, ['kind', 'path', 'sectionId']) &&
      publicMarkdownPath(value.path) && SECTION_ID_RE.test(value.sectionId || '')) {
    normalized = { kind: 'heading', path: value.path, sectionId: value.sectionId };
  } else if (value.kind === 'entity' && exactKeys(value, ['kind', 'nodeId']) && /^node_[a-f0-9]{16}$/.test(value.nodeId || '')) {
    normalized = { kind: 'entity', nodeId: value.nodeId };
  } else if (value.kind === 'issue' && exactKeys(value, ['kind', 'issueId']) && /^issue_[a-f0-9]{16}$/.test(value.issueId || '')) {
    normalized = { kind: 'issue', issueId: value.issueId };
  } else {
    fail('INVALID_LOCATION', '定位描述字段或身份无效');
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_TARGET_BYTES) {
    fail('INVALID_LOCATION', '定位描述超过大小上限');
  }
  return Object.freeze(normalized);
}

function normalizeRequest(request) {
  if (!exactKeys(request, ['query', 'kinds', 'limit', 'requestId']) ||
      typeof request.query !== 'string' || Buffer.byteLength(request.query, 'utf8') > MAX_QUERY_BYTES ||
      !Array.isArray(request.kinds) || request.kinds.length < 1 || request.kinds.length > KINDS.size ||
      new Set(request.kinds).size !== request.kinds.length || request.kinds.some(kind => !KINDS.has(kind)) ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_LIMIT ||
      typeof request.requestId !== 'string' || !request.requestId || !boundedText(request.requestId, 128)) {
    fail('INVALID_QUERY', '快速打开查询参数无效');
  }
  return Object.freeze({
    query: request.query.normalize('NFKC').toLocaleLowerCase('zh-CN'),
    kinds: Object.freeze([...request.kinds]),
    limit: request.limit,
    requestId: request.requestId,
  });
}

function normalizePartialReasons(value) {
  if (!Array.isArray(value) || value.length > 16 || value.some(reason => !boundedText(reason, 128) || !/^[A-Z][A-Z0-9_]*$/.test(reason))) {
    fail('INVALID_LOCATION', '定位 partialReasons 无效');
  }
  return [...new Set(value)];
}

function validateInventory(value) {
  if (!value || value.schema !== 'writcraft.workspace-inventory/v1' || !Array.isArray(value.files)) {
    fail('INVALID_LOCATION', '工作区 inventory 无效');
  }
  for (const file of value.files) {
    if (!file || !publicMarkdownPath(file.path) || !REVISION_RE.test(file.revision || '') || !Array.isArray(file.headings)) {
      fail('INVALID_LOCATION', '工作区文件定位数据无效');
    }
    for (const heading of file.headings) {
      if (!heading || !SECTION_ID_RE.test(heading.id || '') || typeof heading.heading !== 'string' ||
          !Number.isSafeInteger(heading.level) || heading.level < 1 || heading.level > 6 ||
          !Number.isSafeInteger(heading.occurrence) || heading.occurrence < 1 ||
          !Number.isSafeInteger(heading.startOffset) || !Number.isSafeInteger(heading.endOffset) ||
          heading.startOffset < 0 || heading.endOffset < heading.startOffset) {
        fail('INVALID_LOCATION', '工作区标题定位数据无效');
      }
    }
  }
  return value;
}

function normalizeCurrentState(value) {
  if (!value || !PROJECT_INSTANCE_ID_RE.test(value.projectInstanceId || '') || !validAuthority(value.authority)) {
    fail('NO_PROJECT', '尚未打开项目');
  }
  const inventory = validateInventory(value.inventory);
  if (!inventory.authority || inventory.authority.projectInstanceId !== value.projectInstanceId ||
      inventory.authority.projectMutationGeneration !== value.authority.projectMutationGeneration) {
    fail('PROJECT_CHANGED', '工作区 inventory 与当前项目权威不一致');
  }
  return Object.freeze({
    projectInstanceId: value.projectInstanceId,
    authority: Object.freeze({ ...value.authority }),
    inventory,
  });
}

function normalizeDisplay(item, kind) {
  const expected = kind === 'pending_review'
    ? ['locationId', 'label', 'detail', 'breadcrumb', 'badges']
    : ['locator', 'label', 'detail', 'breadcrumb', 'badges'];
  if (!exactKeys(item, expected) || !boundedText(item.label) || !boundedText(item.detail) ||
      !boundedText(item.breadcrumb) || !Array.isArray(item.badges) || item.badges.length > 8 ||
      item.badges.some(badge => !boundedText(badge, 128))) {
    fail('INVALID_LOCATION', '定位 adapter 展示投影无效');
  }
  if (kind === 'pending_review') {
    if (!boundedText(item.locationId, 256) || !item.locationId) fail('INVALID_LOCATION', '待审定位 adapter 身份无效');
    return { ...item, kind, adapterLocationId: item.locationId, locator: null };
  }
  const locator = stableLocator(item.locator);
  if (locator.kind !== kind) fail('INVALID_LOCATION', '定位 adapter kind 不一致');
  return { ...item, kind, locator, adapterLocationId: null };
}

function normalizeAdapterList(value, kind) {
  if (!exactKeys(value, ['status', 'partialReasons', 'items']) ||
      !['ready', 'empty', 'partial'].includes(value.status) || !Array.isArray(value.items) || value.items.length > MAX_LIMIT) {
    fail('INVALID_LOCATION', '定位 adapter 列表 envelope 无效');
  }
  const partialReasons = normalizePartialReasons(value.partialReasons);
  if (value.status === 'partial' && partialReasons.length === 0) fail('INVALID_LOCATION', 'partial adapter 必须说明原因');
  if (value.status !== 'partial' && partialReasons.length) fail('INVALID_LOCATION', '非 partial adapter 不得携带原因');
  return {
    status: value.status,
    partialReasons,
    items: value.items.map(item => normalizeDisplay(item, kind)),
  };
}

function resolvedFileTarget(value, locator, inventory = null) {
  const keys = ['action', 'filePath', 'revision', 'offset', 'endOffset'];
  if (!exactKeys(value, keys) || value.action !== 'open_file' || !publicMarkdownPath(value.filePath) ||
      !REVISION_RE.test(value.revision || '') || !Number.isSafeInteger(value.offset) ||
      !Number.isSafeInteger(value.endOffset) || value.offset < 0 || value.endOffset < value.offset) {
    fail('INVALID_LOCATION', '定位 adapter target 无效');
  }
  const target = { ...value, stableLocator: locator };
  if (inventory) {
    const file = inventory.files.find(item => item.path === value.filePath);
    if (!file || file.revision !== value.revision) fail('LOCATION_STALE', '定位目标已发生变化');
    const maximum = Number.isSafeInteger(file.contentLength) ? file.contentLength : null;
    if (maximum !== null && value.endOffset > maximum) fail('LOCATION_STALE', '定位范围已超出当前文件');
  }
  if (Buffer.byteLength(JSON.stringify(target), 'utf8') > MAX_TARGET_BYTES) fail('INVALID_LOCATION', '定位 target 超过大小上限');
  return Object.freeze(target);
}

function resolvedPendingTarget(value, expectedLocationId) {
  if (!exactKeys(value, ['action', 'reviewLocationId']) || value.action !== 'open_review' ||
      !boundedText(value.reviewLocationId, 256) || !value.reviewLocationId) {
    fail('INVALID_LOCATION', '待审定位 adapter target 无效');
  }
  if (value.reviewLocationId !== expectedLocationId) fail('LOCATION_STALE', '待审定位已变化');
  return Object.freeze({ ...value });
}

function createWorkspaceLocationService(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
  const currentStateProvider = options.currentStateProvider;
  const adapters = options.adapters && typeof options.adapters === 'object' ? options.adapters : {};
  const locations = new Map();

  if (typeof currentStateProvider !== 'function') fail('INVALID_LOCATION', '工作区定位缺少 currentStateProvider');

  function current(projectInstanceId) {
    const state = normalizeCurrentState(currentStateProvider());
    if (state.projectInstanceId !== projectInstanceId) fail('PROJECT_CHANGED', '项目已切换');
    return state;
  }

  function prune() {
    const now = clock();
    for (const [id, record] of locations) if (record.expiresAt <= now) locations.delete(id);
    while (locations.size > MAX_LOCATIONS) locations.delete(locations.keys().next().value);
  }

  function clearProject() {
    locations.clear();
  }

  function mint(record) {
    prune();
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
      const bytes = randomBytes(16);
      if (!Buffer.isBuffer(bytes) || bytes.length !== 16) fail('INVALID_LOCATION', '定位随机源无效');
      const id = `wl_${bytes.toString('hex')}`;
      if (locations.has(id)) continue;
      locations.set(id, Object.freeze({ ...record, expiresAt: clock() + LOCATION_TTL_MS }));
      prune();
      return id;
    }
    fail('LOCATION_ID_COLLISION', '无法分配唯一定位身份');
  }

  function matches(item, query) {
    if (!query) return true;
    return [item.label, item.detail, item.breadcrumb]
      .some(value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query));
  }

  function list(projectInstanceId, request) {
    const active = current(projectInstanceId);
    const query = normalizeRequest(request);
    const candidates = [];
    const partialReasons = [];
    if (query.kinds.includes('file') || query.kinds.includes('heading')) {
      for (const file of active.inventory.files) {
        if (query.kinds.includes('file')) candidates.push({
          kind: 'file', label: path.posix.basename(file.path), detail: file.path, breadcrumb: file.path, badges: [],
          locator: Object.freeze({ kind: 'file', path: file.path }), adapterLocationId: null,
        });
        if (query.kinds.includes('heading')) {
          for (const heading of file.headings) candidates.push({
            kind: 'heading', label: heading.heading, detail: file.path,
            breadcrumb: `${file.path} · H${heading.level} · ${heading.occurrence}`,
            badges: heading.occurrence > 1 ? [`同名 ${heading.occurrence}`] : [],
            locator: Object.freeze({ kind: 'heading', path: file.path, sectionId: heading.id }),
            adapterLocationId: null,
          });
        }
      }
    }
    for (const kind of ['entity', 'issue', 'pending_review']) {
      if (!query.kinds.includes(kind)) continue;
      const adapter = adapters[kind];
      if (!adapter || typeof adapter.list !== 'function') {
        if (kind !== 'pending_review') partialReasons.push('GRAPH_UNAVAILABLE');
        continue;
      }
      const projected = normalizeAdapterList(adapter.list({
        projectInstanceId, authority: active.authority, inventory: active.inventory, query: query.query,
      }), kind);
      partialReasons.push(...projected.partialReasons);
      candidates.push(...projected.items);
    }
    const items = [];
    let truncated = false;
    for (const candidate of candidates) {
      if (!matches(candidate, query.query)) continue;
      if (items.length >= query.limit) { truncated = true; break; }
      const locationId = mint({
        projectInstanceId,
        kind: candidate.kind,
        locator: candidate.kind === 'pending_review' ? null : stableLocator(candidate.locator),
        adapterLocationId: candidate.adapterLocationId,
      });
      const item = Object.freeze({
        locationId, kind: candidate.kind, label: candidate.label, detail: candidate.detail,
        breadcrumb: candidate.breadcrumb, badges: Object.freeze([...candidate.badges]),
      });
      const projected = {
        schema: SCHEMA, projectInstanceId, authority: active.authority, status: 'ready',
        partialReasons: [], items: [...items, item],
      };
      if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MAX_RESPONSE_BYTES) {
        locations.delete(locationId);
        truncated = true;
        break;
      }
      items.push(item);
    }
    if (truncated) partialReasons.push('LOCATION_RESULTS_LIMIT');
    const reasons = Object.freeze([...new Set(partialReasons)]);
    return Object.freeze({
      schema: SCHEMA,
      projectInstanceId,
      authority: active.authority,
      status: reasons.length ? 'partial' : items.length ? 'ready' : 'empty',
      partialReasons: reasons,
      items: Object.freeze(items),
    });
  }

  function resolve(projectInstanceId, locationId) {
    const active = current(projectInstanceId);
    prune();
    if (!LOCATION_ID_RE.test(String(locationId || ''))) fail('INVALID_LOCATION', '定位身份无效');
    const record = locations.get(locationId);
    if (!record) fail('LOCATION_UNRESOLVED', '定位已失效');
    if (record.projectInstanceId !== projectInstanceId) fail('PROJECT_CHANGED', '项目已切换');
    if (record.kind === 'pending_review') {
      const adapter = adapters.pending_review;
      const value = typeof adapter?.resolve === 'function'
        ? adapter.resolve({ projectInstanceId, authority: active.authority, inventory: active.inventory, locationId: record.adapterLocationId })
        : null;
      if (!value) fail('REVIEW_NOT_AVAILABLE', '待审修改已失效');
      return Object.freeze({
        schema: RESOLVED_SCHEMA, projectInstanceId, authority: active.authority,
        kind: record.kind, target: resolvedPendingTarget(value, record.adapterLocationId),
      });
    }
    const locator = record.locator;
    if (locator.kind === 'file' || locator.kind === 'heading') {
      const file = active.inventory.files.find(item => item.path === locator.path);
      if (!file) fail('LOCATION_MISSING', locator.kind === 'file' ? '文件已不存在' : '标题所属文件已不存在');
      let offset = 0;
      let endOffset = 0;
      if (locator.kind === 'heading') {
        const heading = file.headings.find(item => item.id === locator.sectionId);
        if (!heading) fail('LOCATION_UNRESOLVED', '标题位置已变化');
        offset = heading.startOffset;
        endOffset = heading.endOffset;
      }
      return Object.freeze({
        schema: RESOLVED_SCHEMA, projectInstanceId, authority: active.authority, kind: locator.kind,
        target: resolvedFileTarget({ action: 'open_file', filePath: file.path, revision: file.revision, offset, endOffset }, locator, active.inventory),
      });
    }
    const adapter = adapters[record.kind];
    const value = typeof adapter?.resolve === 'function'
      ? adapter.resolve({ projectInstanceId, authority: active.authority, inventory: active.inventory, locator })
      : null;
    if (!value) fail('LOCATION_UNRESOLVED', '图谱位置当前不可用');
    return Object.freeze({
      schema: RESOLVED_SCHEMA, projectInstanceId, authority: active.authority,
      kind: record.kind, target: resolvedFileTarget(value, locator, active.inventory),
    });
  }

  function resolveStable(projectInstanceId, requestedLocator) {
    const active = current(projectInstanceId);
    const locator = stableLocator(requestedLocator);
    if (locator.kind === 'file' || locator.kind === 'heading') {
      const file = active.inventory.files.find(item => item.path === locator.path);
      if (!file) fail('LOCATION_MISSING', '项目位置所属文件已不存在');
      let offset = 0;
      let endOffset = 0;
      if (locator.kind === 'heading') {
        const heading = file.headings.find(item => item.id === locator.sectionId);
        if (!heading) fail('LOCATION_UNRESOLVED', '标题位置已变化');
        offset = heading.startOffset;
        endOffset = heading.endOffset;
      }
      return Object.freeze({
        schema: RESOLVED_SCHEMA, projectInstanceId, authority: active.authority, kind: locator.kind,
        target: resolvedFileTarget({ action: 'open_file', filePath: file.path, revision: file.revision, offset, endOffset }, locator, active.inventory),
      });
    }
    const adapter = adapters[locator.kind];
    const value = typeof adapter?.resolve === 'function'
      ? adapter.resolve({ projectInstanceId, authority: active.authority, inventory: active.inventory, locator })
      : null;
    if (!value) fail('LOCATION_UNRESOLVED', '图谱位置当前不可用');
    return Object.freeze({
      schema: RESOLVED_SCHEMA, projectInstanceId, authority: active.authority,
      kind: locator.kind, target: resolvedFileTarget(value, locator, active.inventory),
    });
  }

  function listOutline(projectInstanceId, request) {
    const active = current(projectInstanceId);
    if (!exactKeys(request, ['path', 'requestId']) || !publicMarkdownPath(request.path) ||
        typeof request.requestId !== 'string' || !request.requestId || !boundedText(request.requestId, 128)) {
      fail('INVALID_QUERY', '大纲查询参数无效');
    }
    const file = active.inventory.files.find(item => item.path === request.path);
    if (!file) fail('LOCATION_MISSING', '当前文件已不存在');
    const items = [];
    const parents = [];
    let truncated = false;
    for (const heading of file.headings) {
      if (items.length >= MAX_OUTLINE_ITEMS) { truncated = true; break; }
      while (parents.length >= heading.level) parents.pop();
      const parentOutlineId = parents.length ? parents[parents.length - 1] : null;
      const locationId = mint({
        projectInstanceId,
        kind: 'heading',
        locator: stableLocator({ kind: 'heading', path: file.path, sectionId: heading.id }),
        adapterLocationId: null,
      });
      const item = Object.freeze({
        outlineId: heading.id,
        locationId,
        label: heading.heading,
        level: heading.level,
        parentOutlineId,
        occurrence: heading.occurrence,
        startOffset: heading.startOffset,
        endOffset: heading.endOffset,
      });
      const candidate = {
        schema: OUTLINE_SCHEMA, projectInstanceId, authority: active.authority,
        path: file.path, revision: file.revision, status: 'partial',
        partialReasons: ['LOCATION_RESULTS_LIMIT'], items: [...items, item],
      };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_RESPONSE_BYTES) {
        locations.delete(locationId);
        truncated = true;
        break;
      }
      items.push(item);
      parents[heading.level - 1] = heading.id;
    }
    const partialReasons = Object.freeze(truncated ? ['LOCATION_RESULTS_LIMIT'] : []);
    return Object.freeze({
      schema: OUTLINE_SCHEMA, projectInstanceId, authority: active.authority, path: file.path, revision: file.revision,
      status: truncated ? 'partial' : items.length ? 'ready' : 'empty',
      partialReasons, items: Object.freeze(items),
    });
  }

  return Object.freeze({ clearProject, list, listOutline, resolve, resolveStable, get size() { prune(); return locations.size; } });
}

module.exports = {
  SCHEMA,
  OUTLINE_SCHEMA,
  RESOLVED_SCHEMA,
  MAX_QUERY_BYTES,
  MAX_LIMIT,
  MAX_OUTLINE_ITEMS,
  MAX_RESPONSE_BYTES,
  MAX_MINT_ATTEMPTS,
  WorkspaceLocationError,
  stableLocator,
  createWorkspaceLocationService,
};
