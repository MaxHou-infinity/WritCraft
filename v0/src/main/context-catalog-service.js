'use strict';

// Main-owned, bounded catalog for the @ context picker.  The catalog exposes
// only opaque candidate ids plus canonical insertion tokens; it never returns
// document content, project roots, credentials, or write capabilities.
const crypto = require('crypto');
const contextSelection = require('../shared/context-selection');

const SCHEMA = 'writcraft.context-catalog/v1';
const MAX_QUERY_CHARS = 120;
const MAX_CANDIDATES = 24;
const MAX_FILES = 400;
const MAX_FOLDERS = 80;
const MAX_SECTIONS_PER_FILE = 32;
const MAX_TOTAL_SECTIONS = 160;
const MAX_SOURCES = 32;
const MAX_ENTITIES = 32;
// Graph v2 uses semantic node types for declared entities (person, place,
// organization, variable, ...), while older snapshots used the generic
// `entity` type.  The @entity picker must expose both forms; filtering only
// the legacy type silently hides the people and variables authors most often
// need to reference.
const GRAPH_ENTITY_TYPES = new Set([
  'entity', 'person', 'organization', 'place', 'variable', 'concept', 'event', 'datum',
]);

class ContextCatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextCatalogError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContextCatalogError(code, message);
}

function stableId(kind, value) {
  return `ctxcand_${kind}_${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)}`;
}

function flattenTree(nodes, files = [], folders = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.type === 'directory') {
      if (node.path) folders.push(node.path);
      flattenTree(node.children, files, folders);
    } else if (node?.type === 'file' && typeof node.path === 'string' && /\.(?:md|markdown)$/i.test(node.path)) {
      files.push(node.path);
    }
  }
  return { files, folders };
}

function basename(filePath) {
  return String(filePath || '').split('/').at(-1) || filePath;
}

function chapterLabel(filePath) {
  return basename(filePath).replace(/\.(?:md|markdown)$/i, '') || basename(filePath);
}

function makeCandidate(kind, label, token, locator = null, rank = 0) {
  return {
    id: stableId(kind, `${token}\0${locator ? JSON.stringify(locator) : ''}`),
    kind,
    label: String(label || token),
    insertText: token,
    locator,
    rank,
  };
}

function normalizeQuery(query) {
  if (query === undefined || query === null) return '';
  if (typeof query !== 'string') fail('INVALID_QUERY', '上下文搜索词必须是文本');
  const normalized = query.normalize('NFKC').trim();
  if (normalized.length > MAX_QUERY_CHARS) fail('QUERY_TOO_LONG', `上下文搜索词不能超过 ${MAX_QUERY_CHARS} 个字符`);
  return normalized.toLocaleLowerCase();
}

function score(candidate, query, currentFilePath) {
  // `entity <label>` and `source <label>` are picker prefixes, not literal
  // prose.  Strip the prefix only for the matching kind so a broad `entity`
  // query still excludes unrelated file/section candidates.
  const kindPrefix = candidate.kind === 'entity'
    ? /^(?:entity|实体)\s*/iu
    : candidate.kind === 'source'
      ? /^(?:source|来源)\s*/iu
      : null;
  const effectiveQuery = kindPrefix && kindPrefix.test(query) ? query.replace(kindPrefix, '').trim() : query;
  const text = `${candidate.label} ${candidate.insertText}`.toLocaleLowerCase();
  if (!effectiveQuery) return candidate.locator?.filePath === currentFilePath ? 0 : candidate.rank;
  if (text === effectiveQuery) return 0;
  if (text.startsWith(effectiveQuery)) return 1;
  if (text.includes(effectiveQuery)) return 2;
  return 1000;
}

function dedupe(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function listContextCandidates({ projectService, rootPath, projectInstanceId, mutationGeneration, query = '', currentFilePath = null }) {
  if (!projectService || typeof projectService.listTree !== 'function' || typeof projectService.readFileWithRevision !== 'function') {
    throw new TypeError('projectService 缺少目录和文件读取接口');
  }
  const normalizedQuery = normalizeQuery(query);
  const tree = flattenTree(projectService.listTree(rootPath));
  const files = [...new Set(tree.files)].sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, MAX_FILES);
  const folders = [...new Set(tree.folders)].sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, MAX_FOLDERS);
  const candidates = [];

  for (const filePath of files) {
    const isChapter = filePath.startsWith('chapters/');
    candidates.push(makeCandidate('file', filePath, `@file: "${filePath}"`, { filePath }, isChapter ? 3 : 5));
    if (isChapter) {
      candidates.push(makeCandidate('chapter', chapterLabel(filePath), `@chapter: "${filePath}"`, { filePath }, 2));
    }
  }
  for (const folderPath of folders) {
    if (!files.some(filePath => filePath.startsWith(`${folderPath}/`))) continue;
    candidates.push(makeCandidate('folder', folderPath, `@folder: "${folderPath}"`, { folderPath }, 6));
  }

  let sectionCount = 0;
  const preferredFiles = [...files].sort((left, right) => {
    if (left === currentFilePath) return -1;
    if (right === currentFilePath) return 1;
    return left.localeCompare(right, 'zh-CN');
  });
  for (const filePath of preferredFiles) {
    if (sectionCount >= MAX_TOTAL_SECTIONS) break;
    let snapshot;
    try { snapshot = projectService.readFileWithRevision(rootPath, filePath); } catch (_) { continue; }
    let sections;
    try { sections = contextSelection.parseMarkdownSections(snapshot.content, filePath); } catch (_) { continue; }
    for (const section of sections.slice(0, MAX_SECTIONS_PER_FILE)) {
      sectionCount += 1;
      candidates.push(makeCandidate(
        'section',
        `${basename(filePath)} · ${section.heading}`,
        `@file: "${filePath}" @section: "${section.heading}"`,
        { filePath, sectionId: section.id, heading: section.heading, occurrence: section.occurrence, revision: snapshot.revision },
        filePath === currentFilePath ? 1 : 4
      ));
      if (sectionCount >= MAX_TOTAL_SECTIONS) break;
    }
  }

  // Source/entity indexes are deliberately opt-in by query prefix to avoid a
  // graph scan on every keystroke.  They are still rebuilt by Main from the
  // current project snapshot, and only labels/ids are disclosed to Renderer.
  if (/^(source|来源|entity|实体)/iu.test(normalizedQuery)) {
    try {
      const sourceIndexService = require('./source-index-service');
      for (const source of sourceIndexService.buildSourceIndex(rootPath).sources.slice(0, MAX_SOURCES)) {
        candidates.push(makeCandidate('source', source.title || source.id, `@source: "${source.id || source.filePath}"`, {
          sourceId: source.id || null,
          filePath: source.filePath || null,
          revision: source.revision || null,
        }, 2));
      }
    } catch (_) {}
    try {
      const graphIndexService = require('./graph-index-service');
      const graph = graphIndexService.indexProjectGraph(projectService, rootPath)?.graph;
      // Prioritize a typed-label match before applying the global cap.  A
      // large project may have more than MAX_ENTITIES nodes; slicing the raw
      // graph first could permanently hide the exact person/variable the
      // author just typed into the picker.
      const entityQuery = normalizedQuery.replace(/^(?:entity|实体)\s*/iu, '').trim();
      const graphEntities = (graph?.nodes || [])
        .filter(node => GRAPH_ENTITY_TYPES.has(node?.type))
        .sort((left, right) => {
          const leftLabel = String(left?.label || left?.name || left?.id || '').toLocaleLowerCase();
          const rightLabel = String(right?.label || right?.name || right?.id || '').toLocaleLowerCase();
          const leftMatch = entityQuery && leftLabel.includes(entityQuery) ? 0 : 1;
          const rightMatch = entityQuery && rightLabel.includes(entityQuery) ? 0 : 1;
          return leftMatch - rightMatch || leftLabel.localeCompare(rightLabel, 'zh-CN');
        });
      for (const entity of graphEntities.slice(0, MAX_ENTITIES)) {
        candidates.push(makeCandidate('entity', entity.label || entity.name || entity.id, `@entity: "${entity.id}"`, {
          entityId: entity.id,
        }, 2));
      }
    } catch (_) {}
  }

  const ranked = dedupe(candidates)
    .map(candidate => ({ ...candidate, score: score(candidate, normalizedQuery, currentFilePath) }))
    .filter(candidate => candidate.score < 1000)
    .sort((left, right) => left.score - right.score || left.rank - right.rank || left.label.localeCompare(right.label, 'zh-CN'))
    .slice(0, MAX_CANDIDATES)
    .map(({ score: _score, rank: _rank, ...candidate }) => candidate);
  return {
    ok: true,
    schema: SCHEMA,
    authority: 'main-catalog',
    projectInstanceId,
    mutationGeneration,
    query: normalizedQuery,
    candidates: ranked,
    truncated: candidates.length > ranked.length,
  };
}

module.exports = {
  SCHEMA,
  MAX_QUERY_CHARS,
  MAX_CANDIDATES,
  MAX_FILES,
  MAX_FOLDERS,
  MAX_SECTIONS_PER_FILE,
  MAX_TOTAL_SECTIONS,
  ContextCatalogError,
  listContextCandidates,
};
