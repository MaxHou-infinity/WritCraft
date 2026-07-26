(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftGraphFilters = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const graphLookupCache = new WeakMap();
  const MAX_SNAPSHOT_DEPTH = 64;
  const MAX_SNAPSHOT_NODES = 200000;
  const MAX_SNAPSHOT_ENTRIES = 200000;

  function freezeGraphSnapshot(value) {
    let nodes = 0;
    let entries = 0;
    const active = new Set();

    function clone(current, depth) {
      if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
      if (typeof current === 'number' && Number.isFinite(current)) return current;
      if (depth > MAX_SNAPSHOT_DEPTH) throw new TypeError('Graph snapshot exceeds maximum depth');
      if (!current || typeof current !== 'object') throw new TypeError('Graph snapshot contains a non-data value');
      if (++nodes > MAX_SNAPSHOT_NODES) throw new TypeError('Graph snapshot exceeds maximum node count');
      if (active.has(current)) throw new TypeError('Graph snapshot contains a cycle');

      const prototype = Object.getPrototypeOf(current);
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype) throw new TypeError('Graph snapshot contains a non-plain array');
      } else if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Graph snapshot contains a non-plain object');
      }

      active.add(current);
      try {
        if (Array.isArray(current)) {
          const lengthDescriptor = Object.getOwnPropertyDescriptor(current, 'length');
          if (!lengthDescriptor || lengthDescriptor.enumerable || lengthDescriptor.configurable ||
              !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
              !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
              lengthDescriptor.value > MAX_SNAPSHOT_ENTRIES - entries) {
            throw new TypeError('Graph snapshot array length is invalid or oversized');
          }
          const ownKeys = Reflect.ownKeys(current);
          if (ownKeys.some(key => typeof key !== 'string') ||
              ownKeys.length !== lengthDescriptor.value + 1 ||
              ownKeys.some(key => key !== 'length' &&
                (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= lengthDescriptor.value))) {
            throw new TypeError('Graph snapshot contains a non-data array property');
          }
          entries += lengthDescriptor.value;
          const descriptors = new Array(lengthDescriptor.value);
          for (let index = 0; index < lengthDescriptor.value; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
            if (!descriptor || descriptor.enumerable !== true ||
                !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
              throw new TypeError('Graph snapshot contains a sparse or accessor array element');
            }
            descriptors[index] = descriptor;
          }
          const copy = new Array(lengthDescriptor.value);
          for (let index = 0; index < descriptors.length; index += 1) {
            copy[index] = clone(descriptors[index].value, depth + 1);
          }
          return Object.freeze(copy);
        }
        const copy = {};
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some(key => typeof key !== 'string') ||
            ownKeys.length > MAX_SNAPSHOT_ENTRIES - entries) {
          throw new TypeError('Graph snapshot contains a symbol property or too many fields');
        }
        entries += ownKeys.length;
        for (const key of ownKeys) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (!descriptor || descriptor.enumerable !== true ||
              !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
            throw new TypeError('Graph snapshot contains a hidden field or accessor');
          }
          Object.defineProperty(copy, key, {
            value: clone(descriptor.value, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return Object.freeze(copy);
      } finally {
        active.delete(current);
      }
    }

    try {
      return clone(value, 0);
    } catch (error) {
      error.code = 'INVALID_GRAPH_SNAPSHOT';
      throw error;
    }
  }

  function graphLookup(graph) {
    const evidence = Array.isArray(graph?.evidence) ? graph.evidence : [];
    if (!graph || typeof graph !== 'object') {
      return { evidence, evidenceById: new Map(evidence.map(item => [item.id, item])), nodePaths: new WeakMap() };
    }
    const cached = graphLookupCache.get(graph);
    if (cached?.evidence === evidence) return cached;
    const lookup = {
      evidence,
      evidenceById: new Map(evidence.map(item => [item.id, item])),
      nodePaths: new WeakMap(),
    };
    graphLookupCache.set(graph, lookup);
    return lookup;
  }

  function evidenceIndex(graph) {
    return graphLookup(graph).evidenceById;
  }

  function itemEvidence(graph, item) {
    if (Array.isArray(item?.evidence)) return item.evidence;
    const index = evidenceIndex(graph);
    const ids = item?.evidenceIds || (item?.evidenceId ? [item.evidenceId] : []);
    return ids.map(id => index.get(id)).filter(Boolean);
  }

  function nodePaths(graph, node) {
    if (!node || typeof node !== 'object') return [];
    const lookup = graphLookup(graph);
    const cached = lookup.nodePaths.get(node);
    if (cached) return cached;
    // A graph response is an immutable Renderer snapshot. Cache its derived
    // path membership so file/scope filters stay O(nodes + evidence) instead
    // of rebuilding the complete evidence map once per node. Replacing the
    // graph (or its evidence array) naturally creates a fresh lookup.
    const paths = [...new Set(itemEvidence(graph, node).map(item => item.path).filter(Boolean))].sort();
    lookup.nodePaths.set(node, paths);
    return paths;
  }

  function edgeEnds(edge) {
    const id = value => typeof value === 'string' ? value : value?.id || '';
    return [edge?.sourceId || edge?.from || id(edge?.source), edge?.targetId || edge?.to || id(edge?.target)];
  }

  function issueNodeIds(issue) {
    const id = value => typeof value === 'string' ? value : value?.id || '';
    return (issue?.nodeIds || issue?.relatedNodeIds || issue?.nodes || []).map(id).filter(Boolean);
  }

  function normalizedFilters(filters = {}) {
    return {
      type: filters.type || 'all',
      scope: filters.scope === 'project' ? 'project' : 'current',
      currentPath: typeof filters.currentPath === 'string' ? filters.currentPath : '',
      filePath: typeof filters.filePath === 'string' ? filters.filePath : '',
      timeNodeId: typeof filters.timeNodeId === 'string' ? filters.timeNodeId : '',
      timeStartNodeId: typeof filters.timeStartNodeId === 'string' ? filters.timeStartNodeId : '',
      timeEndNodeId: typeof filters.timeEndNodeId === 'string' ? filters.timeEndNodeId : '',
      query: typeof filters.query === 'string' ? filters.query.trim().toLocaleLowerCase('zh-CN') : '',
    };
  }

  function searchableNodeText(node) {
    return [node?.label, node?.name, node?.key, ...(node?.aliases || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
  }

  function searchableIssueText(issue) {
    return [issue?.title, issue?.message, issue?.description, issue?.type]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
  }

  function visibleNodes(graph, filters = {}) {
    const resolved = normalizedFilters(filters);
    let nodes = [...(graph?.nodes || [])];
    const activeIssues = (graph?.issues || []).filter(issue => !['dismissed', 'resolved'].includes(issue.status));
    if (resolved.type === 'issues') {
      const ids = new Set(activeIssues.flatMap(issueNodeIds));
      nodes = nodes.filter(node => ids.has(node.id));
    } else if (resolved.type === 'entity') {
      nodes = nodes.filter(node => ['person', 'entity', 'organization', 'place', 'location'].includes(node.type));
    } else if (resolved.type === 'concept') {
      nodes = nodes.filter(node => ['concept', 'variable', 'value'].includes(node.type));
    } else if (resolved.type !== 'all') {
      nodes = nodes.filter(node => node.type === resolved.type);
    }
    const effectivePath = resolved.filePath || (resolved.scope === 'current' ? resolved.currentPath : '');
    if (effectivePath) nodes = nodes.filter(node => nodePaths(graph, node).includes(effectivePath));
    const timeIds = timeRangeNodeIds(graph, resolved);
    if (timeIds.size) {
      const connected = new Set(timeIds);
      for (const edge of graph?.edges || []) {
        const [from, to] = edgeEnds(edge);
        if (timeIds.has(from)) connected.add(to);
        if (timeIds.has(to)) connected.add(from);
      }
      nodes = nodes.filter(node => connected.has(node.id));
    }
    if (resolved.query) {
      // Search is a constellation query, not two unrelated text boxes. A
      // matching issue keeps its related nodes visible; a matching node keeps
      // its issue cards visible in visibleIssues().
      const relatedToMatchingIssue = new Set((graph?.issues || [])
        .filter(issue => searchableIssueText(issue).includes(resolved.query))
        .flatMap(issueNodeIds));
      nodes = nodes.filter(node => searchableNodeText(node).includes(resolved.query) ||
        relatedToMatchingIssue.has(node.id));
    }
    return nodes;
  }

  function visibleIssues(graph, filters = {}) {
    const resolved = normalizedFilters(filters);
    // Issue cards must describe the constellation currently on screen. Keep
    // type/time/path filtering based on the unsearched visible node set, then
    // let one shared query match either issue copy or any related node's
    // label/key/alias. visibleNodes() performs the inverse inclusion so a
    // matched issue never leaves all of its eligible nodes hidden.
    const visible = new Set(visibleNodes(graph, { ...resolved, query: '' }).map(node => node.id));
    const nodesById = new Map((graph?.nodes || []).map(node => [node.id, node]));
    const hasExplicitNodeFilter = resolved.type !== 'all' || Boolean(
      resolved.timeNodeId || resolved.timeStartNodeId || resolved.timeEndNodeId
    );
    const effectivePath = resolved.filePath || (resolved.scope === 'current' ? resolved.currentPath : '');
    return (graph?.issues || []).filter(issue => {
      const relatedNodeIds = issueNodeIds(issue);
      const nodeMatch = relatedNodeIds.length
        ? relatedNodeIds.some(id => visible.has(id))
        : !hasExplicitNodeFilter;
      const pathMatch = !effectivePath || itemEvidence(graph, issue).some(item => item.path === effectivePath);
      const queryMatch = !resolved.query || searchableIssueText(issue).includes(resolved.query) ||
        // A node text match must be the same related node that survived the
        // active type/time/path constellation. Do not let one related node
        // satisfy type while another hidden node satisfies the query.
        relatedNodeIds.some(id => visible.has(id) && searchableNodeText(nodesById.get(id)).includes(resolved.query));
      return nodeMatch && pathMatch && queryMatch;
    });
  }

  function fileOptions(graph) {
    return [...new Set((graph?.manifest?.inputFiles || []).map(item => item.path).filter(Boolean))].sort();
  }

  function timeOptions(graph) {
    return (graph?.nodes || []).filter(node => node.type === 'time')
      .map(node => ({ id: node.id, label: node.label || node.name || node.id }))
      .sort((a, b) => {
        const left = timeSortValue(a.label);
        const right = timeSortValue(b.label);
        if (left !== null && right !== null && left !== right) return left - right;
        if (left !== null && right === null) return -1;
        if (left === null && right !== null) return 1;
        return a.label.localeCompare(b.label, 'zh-CN') || a.id.localeCompare(b.id);
      });
  }

  function timeSortValue(label) {
    // Keep the renderer's chronology identical to Main's canonicalDate(): the
    // same separators and Chinese form are accepted, partial dates resolve to
    // January 1, and impossible calendar dates are rejected. Returning null
    // deliberately leaves timeOptions() on its stable label/id fallback.
    const value = String(label || '').trim().replace(/\s+/g, '');
    let match = value.match(/^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/);
    if (!match) match = value.match(/^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2] || 1);
    const day = Number(match[3] || 1);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return null;
    return year * 10000 + month * 100 + day;
  }

  function timeRangeNodeIds(graph, filters = {}) {
    const resolved = normalizedFilters(filters);
    if (!resolved.timeStartNodeId && !resolved.timeEndNodeId) {
      return new Set(resolved.timeNodeId ? [resolved.timeNodeId] : []);
    }
    const ordered = timeOptions(graph).map(item => item.id);
    if (!ordered.length) return new Set();
    const startIndex = resolved.timeStartNodeId ? ordered.indexOf(resolved.timeStartNodeId) : 0;
    const endIndex = resolved.timeEndNodeId ? ordered.indexOf(resolved.timeEndNodeId) : ordered.length - 1;
    if (startIndex < 0 || endIndex < 0) return new Set();
    const lower = Math.min(startIndex, endIndex);
    const upper = Math.max(startIndex, endIndex);
    return new Set(ordered.slice(lower, upper + 1));
  }

  function evidenceIsStale(evidence, currentPath, currentRevision) {
    return Boolean(evidence?.path && evidence.path === currentPath && evidence.revision && currentRevision && evidence.revision !== currentRevision);
  }

  function formatEdgeEvolution(evolution) {
    if (!evolution || !Number.isSafeInteger(evolution.evidenceCount) || evolution.evidenceCount < 0) return '';
    const paths = Array.isArray(evolution.paths) ? evolution.paths.filter(path => typeof path === 'string' && path) : [];
    const pathCount = Number.isSafeInteger(evolution.pathCount) && evolution.pathCount >= paths.length
      ? evolution.pathCount : paths.length;
    const evidence = `${evolution.evidenceCount} 条证据`;
    if (pathCount <= 1) return `出现于：${paths[0] || evolution.firstPath || '未知文件'}；${evidence}`;
    const listing = pathCount > paths.length
      ? `展示前 ${paths.length} / 共 ${pathCount} 个文件：${paths.join('、')}`
      : paths.join('、');
    const bounds = evolution.firstPath && evolution.lastPath && evolution.firstPath !== evolution.lastPath
      ? `；路径范围 ${evolution.firstPath} → ${evolution.lastPath}` : '';
    return `跨文件出现：${listing}；${evidence}${bounds}（按文件路径排序，不代表故事时间）`;
  }

  return { freezeGraphSnapshot, itemEvidence, nodePaths, edgeEnds, issueNodeIds, visibleNodes, visibleIssues, fileOptions, timeOptions, timeSortValue, timeRangeNodeIds, evidenceIsStale, formatEdgeEvolution };
});
