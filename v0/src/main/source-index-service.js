// WritCraft local source/evidence index.
//
// This service performs no network access and never executes front matter. It
// reads only project-relative Markdown through ProjectService's guarded API.
// The returned index is derived data and can always be rebuilt from the files.

const path = require('path');
const crypto = require('crypto');
const projectService = require('./project-service');

const INDEX_SCHEMA = 'writcraft.sources/v1';
const MAX_SOURCE_FILES = 500;
const MAX_CORPUS_FILES = 2000;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FRONT_MATTER_BYTES = 16 * 1024;

function stableHash(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceId(filePath) {
  return `src_${stableHash(filePath).slice(0, 20)}`;
}

function isMarkdown(filePath) {
  return /\.(?:md|markdown)$/i.test(filePath);
}

function isReferencePath(filePath) {
  return filePath === 'references' || filePath === 'references.md' || filePath.startsWith('references/');
}

function flattenTree(nodes, files = [], blocked = []) {
  for (const node of nodes) {
    if (node.type === 'directory') flattenTree(node.children || [], files, blocked);
    else if (node.type === 'file') files.push(node.path);
    else if (node.type === 'symlink' && (isReferencePath(node.path) || isMarkdown(node.path))) blocked.push(node.path);
  }
  return { files, blocked };
}

function unquoteScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Deliberately parses only simple key/scalar pairs. YAML tags, aliases,
// objects and constructors remain inert text and are never deserialized.
function parseFrontMatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const bounded = content.slice(0, MAX_FRONT_MATTER_BYTES);
  const lines = bounded.split(/\r?\n/);
  const result = {};
  for (let index = 1; index < lines.length && index <= 100; index += 1) {
    const line = lines[index];
    if (line === '---') return result;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):\s*(.*?)\s*$/);
    if (match) result[match[1].toLowerCase().replace(/-/g, '_')] = unquoteScalar(match[2]);
  }
  return {};
}

function safeHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw.trim());
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function titleFromContent(content, metadata, fallback) {
  const heading = /^#\s+(.+?)\s*$/m.exec(content);
  if (metadata.title) {
    // Prefer the visible body heading when it is the same canonical title.
    // `indexOf(metadata.title)` otherwise lands in YAML front matter, so a
    // click appears to reveal metadata instead of the source document title.
    if (heading && heading[1] === metadata.title) {
      return { title: metadata.title, offset: content.indexOf(heading[1], heading.index) };
    }
    const offset = content.indexOf(metadata.title);
    return { title: metadata.title, offset: Math.max(0, offset) };
  }
  if (heading) return { title: heading[1], offset: content.indexOf(heading[1], heading.index) };
  return { title: path.posix.basename(fallback).replace(/\.(?:md|markdown)$/i, ''), offset: 0 };
}

function locator(filePath, content, offset, length = 0) {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const before = content.slice(0, safeOffset);
  const lastBreak = before.lastIndexOf('\n');
  const lineStart = lastBreak + 1;
  const lineEndRaw = content.indexOf('\n', safeOffset);
  const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
  return {
    filePath,
    offset: safeOffset,
    end: Math.min(content.length, safeOffset + length),
    line: before.split('\n').length,
    column: safeOffset - lineStart + 1,
    quote: content.slice(lineStart, lineEnd).trim().slice(0, 240),
  };
}

function metadataFrom(content) {
  const raw = parseFrontMatter(content);
  const rawUrl = raw.url || raw.source_url || raw.canonical_url || '';
  const url = safeHttpUrl(rawUrl);
  const type = (raw.type || raw.kind || raw.source_type || '').toLowerCase();
  return {
    raw,
    rawUrl,
    url,
    recognized: ['source', 'reference', 'citation'].includes(type) || Boolean(raw.url || raw.source_url || raw.canonical_url),
    public: {
      type: type || null,
      author: raw.author || null,
      published: raw.published || raw.date || null,
      citationKey: raw.citation_key || raw.citekey || null,
      url,
    },
  };
}

function extractLinks(filePath, content) {
  const links = [];
  const markdownLink = /\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(markdownLink)) {
    const destination = match[2].replace(/^<|>$/g, '');
    links.push({ label: match[1], destination, offset: match.index, length: match[0].length });
  }
  const wikiLink = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of content.matchAll(wikiLink)) {
    links.push({ label: match[2] || match[1], destination: match[1], offset: match.index, length: match[0].length, wiki: true });
  }
  return links.map(link => ({ ...link, locator: locator(filePath, content, link.offset, link.length) }));
}

function resolveProjectLink(fromPath, destination, wiki = false) {
  if (!destination || destination.startsWith('#') || safeHttpUrl(destination)) return null;
  let decoded;
  try { decoded = decodeURIComponent(destination.split('#')[0].split('?')[0]); } catch (_) { return null; }
  if (!decoded || decoded.includes('\\') || decoded.startsWith('/')) return null;
  let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), decoded));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  if (wiki && !path.posix.extname(resolved)) resolved += '.md';
  return resolved;
}

function boundedLimit(value, hardLimit) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, hardLimit) : hardLimit;
}

function buildSourceIndex(rootPath, options = {}) {
  const maxSourceFiles = boundedLimit(options.maxSourceFiles, MAX_SOURCE_FILES);
  const maxCorpusFiles = boundedLimit(options.maxCorpusFiles, MAX_CORPUS_FILES);
  const maxTotalBytes = boundedLimit(options.maxTotalBytes, MAX_TOTAL_BYTES);
  const errors = [];
  const tree = projectService.listTree(rootPath);
  const flattened = flattenTree(tree);
  for (const blockedPath of flattened.blocked) {
    errors.push({ code: 'SYMLINK_NOT_ALLOWED', filePath: blockedPath, message: '来源路径不能是符号链接' });
  }

  const markdownPaths = flattened.files.filter(isMarkdown).sort((a, b) => a.localeCompare(b, 'en'));
  const corpus = new Map();
  let totalBytes = 0;
  for (const filePath of markdownPaths.slice(0, maxCorpusFiles)) {
    try {
      const file = projectService.readFileWithRevision(rootPath, filePath);
      const bytes = Buffer.byteLength(file.content, 'utf8');
      if (totalBytes + bytes > maxTotalBytes) {
        errors.push({ code: 'INDEX_BYTE_LIMIT', filePath, message: '本次索引已达总大小上限' });
        break;
      }
      totalBytes += bytes;
      corpus.set(filePath, { ...file, bytes, metadata: metadataFrom(file.content) });
    } catch (error) {
      errors.push({ code: error.code || 'READ_FAILED', filePath, message: error.message || '读取失败' });
    }
  }
  if (markdownPaths.length > maxCorpusFiles) {
    errors.push({ code: 'INDEX_FILE_LIMIT', filePath: null, message: `Markdown 文件超过 ${maxCorpusFiles} 个，未全部索引` });
  }

  const candidatePaths = [];
  for (const [filePath, file] of corpus) {
    if (isReferencePath(filePath) || file.metadata.recognized) candidatePaths.push(filePath);
  }
  candidatePaths.sort((a, b) => a.localeCompare(b, 'en'));
  if (candidatePaths.length > maxSourceFiles) {
    errors.push({ code: 'SOURCE_LIMIT', filePath: null, message: `来源文件超过 ${maxSourceFiles} 个，未全部索引` });
  }

  const selectedPaths = candidatePaths.slice(0, maxSourceFiles);
  const selectedSet = new Set(selectedPaths);
  const byUrl = new Map();
  for (const filePath of selectedPaths) {
    const url = corpus.get(filePath).metadata.url;
    if (url) {
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(filePath);
    }
  }

  const inbound = new Map(selectedPaths.map(filePath => [filePath, []]));
  const outbound = new Map(selectedPaths.map(filePath => [filePath, []]));
  const outboundSources = new Map(selectedPaths.map(filePath => [filePath, []]));
  for (const [fromPath, file] of corpus) {
    for (const link of extractLinks(fromPath, file.content)) {
      const url = safeHttpUrl(link.destination);
      if (url) {
        if (selectedSet.has(fromPath)) {
          outbound.get(fromPath).push({ url, label: link.label || null, locator: link.locator });
        }
        for (const targetPath of byUrl.get(url) || []) {
          if (targetPath !== fromPath) {
            inbound.get(targetPath).push({ fromPath, ...link.locator });
            if (selectedSet.has(fromPath)) {
              outboundSources.get(fromPath).push({
                targetId: sourceId(targetPath),
                targetPath,
                ...link.locator,
              });
            }
          }
        }
        continue;
      }
      const targetPath = resolveProjectLink(fromPath, link.destination, link.wiki);
      if (targetPath && selectedSet.has(targetPath) && targetPath !== fromPath) {
        inbound.get(targetPath).push({ fromPath, ...link.locator });
        if (selectedSet.has(fromPath)) {
          outboundSources.get(fromPath).push({
            targetId: sourceId(targetPath),
            targetPath,
            ...link.locator,
          });
        }
      }
    }
  }

  const sources = selectedPaths.map(filePath => {
    const file = corpus.get(filePath);
    const title = titleFromContent(file.content, file.metadata.raw, filePath);
    const itemErrors = [];
    if (file.metadata.rawUrl && !file.metadata.url) {
      itemErrors.push({ code: 'UNSAFE_URL', message: '来源 URL 仅允许 http/https 且不得嵌入凭据' });
    }
    const referencedBy = inbound.get(filePath)
      .sort((a, b) => a.fromPath.localeCompare(b.fromPath, 'en') || a.offset - b.offset);
    const outboundLinks = outbound.get(filePath)
      .sort((a, b) => a.url.localeCompare(b.url, 'en') || a.locator.offset - b.locator.offset);
    const citesSources = outboundSources.get(filePath)
      .sort((a, b) => a.targetPath.localeCompare(b.targetPath, 'en') || a.offset - b.offset);
    return {
      id: sourceId(filePath),
      filePath,
      revision: file.revision,
      title: title.title,
      metadata: file.metadata.public,
      indexStatus: itemErrors.length ? 'indexed_with_warnings' : 'indexed',
      errors: itemErrors,
      isReferenced: referencedBy.length > 0,
      citationCount: referencedBy.length,
      referencedBy,
      isCiting: citesSources.length > 0,
      citesCount: citesSources.length,
      citesSources,
      outboundLinks,
      locator: locator(filePath, file.content, title.offset, title.title.length),
    };
  });

  for (const source of sources) {
    for (const error of source.errors) errors.push({ ...error, filePath: source.filePath });
  }
  errors.sort((a, b) => (a.filePath || '').localeCompare(b.filePath || '', 'en') || a.code.localeCompare(b.code, 'en'));
  const canonical = JSON.stringify({ sources, errors });
  return {
    schema: INDEX_SCHEMA,
    status: errors.length ? 'partial' : (sources.length ? 'ready' : 'empty'),
    revision: `sha256:${stableHash(canonical)}`,
    sources,
    errors,
    counts: {
      sources: sources.length,
      referenced: sources.filter(source => source.isReferenced).length,
      errors: errors.length,
      scannedFiles: corpus.size,
      scannedBytes: totalBytes,
    },
  };
}

function locateSource(index, id) {
  if (!index || !Array.isArray(index.sources) || typeof id !== 'string') return null;
  const source = index.sources.find(item => item.id === id);
  return source ? { ...source.locator } : null;
}

module.exports = {
  INDEX_SCHEMA,
  MAX_SOURCE_FILES,
  MAX_CORPUS_FILES,
  MAX_TOTAL_BYTES,
  buildSourceIndex,
  locateSource,
  parseFrontMatter,
  safeHttpUrl,
};
