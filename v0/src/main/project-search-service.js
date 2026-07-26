'use strict';

// Pure Node project search. Electron owns the active project root; this module
// only consumes the guarded ProjectService interface and never accepts a list
// of renderer-supplied paths.

const path = require('path');

const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 200;
const MAX_QUERY_CHARS = 256;
const DEFAULT_CONTEXT_CHARS = 90;
const MAX_CONTEXT_CHARS = 500;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;
const MAX_FILE_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 20;

class ProjectSearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectSearchError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectSearchError(code, message);
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含无效路径');
  }
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含绝对路径');
  }
  if (value.includes('\\') || value.includes('//')) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含非规范路径');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含隐藏或越界路径');
  }
  if (!/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('UNSAFE_PROJECT_TREE', '搜索服务只接受公开 Markdown 路径');
  }
  return parts.join('/');
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function flattenMarkdownTree(tree) {
  if (!Array.isArray(tree)) fail('INVALID_PROJECT_SERVICE', 'listTree 未返回项目树');
  const files = [];
  const seen = new Set();

  function visit(nodes) {
    if (!Array.isArray(nodes)) fail('UNSAFE_PROJECT_TREE', '项目树目录节点无效');
    for (const node of nodes) {
      if (!node || typeof node !== 'object') fail('UNSAFE_PROJECT_TREE', '项目树节点无效');
      if (node.type === 'directory') {
        // A directory path is not read, but still reject hidden/traversal
        // containers instead of trusting their child paths accidentally.
        const directoryPath = node.path;
        if (typeof directoryPath !== 'string' || !directoryPath || directoryPath.includes('\\')) {
          fail('UNSAFE_PROJECT_TREE', '项目树目录路径无效');
        }
        const parts = directoryPath.split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) {
          fail('UNSAFE_PROJECT_TREE', '项目树包含隐藏或越界目录');
        }
        visit(node.children);
      } else if (node.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) {
        const normalized = publicMarkdownPath(node.path);
        if (seen.has(normalized)) fail('UNSAFE_PROJECT_TREE', `项目树文件重复：${normalized}`);
        seen.add(normalized);
        files.push({
          path: normalized,
          name: path.posix.basename(normalized),
          size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null,
        });
      }
      // Non-Markdown files and blocked/symlink nodes are deliberately ignored.
    }
  }

  visit(tree);
  return files.sort((a, b) => compareText(a.path, b.path));
}

function positiveBoundedInteger(value, fallback, maximum, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) fail('INVALID_OPTIONS', `${field} 必须是正整数`);
  return Math.min(value, maximum);
}

function normalizeOptions(options) {
  if (options === undefined) options = {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('INVALID_OPTIONS', '搜索选项无效');
  }
  return {
    limit: positiveBoundedInteger(options.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT, 'limit'),
    contextChars: positiveBoundedInteger(
      options.contextChars,
      DEFAULT_CONTEXT_CHARS,
      MAX_CONTEXT_CHARS,
      'contextChars'
    ),
    maxFiles: positiveBoundedInteger(options.maxFiles, MAX_SEARCH_FILES, MAX_SEARCH_FILES, 'maxFiles'),
    maxBytes: positiveBoundedInteger(options.maxBytes, MAX_SEARCH_BYTES, MAX_SEARCH_BYTES, 'maxBytes'),
    caseSensitive: options.caseSensitive === true,
    searchFilenames: options.searchFilenames !== false,
    searchContent: options.searchContent !== false,
  };
}

function normalizeQuery(query) {
  if (typeof query !== 'string') fail('INVALID_QUERY', '搜索词必须是文本');
  const value = query.trim();
  if (!value) fail('INVALID_QUERY', '搜索词不能为空');
  if (value.length > MAX_QUERY_CHARS) {
    fail('QUERY_TOO_LONG', `搜索词不能超过 ${MAX_QUERY_CHARS} 个字符`);
  }
  return value;
}

function literalMatcher(query, caseSensitive) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, caseSensitive ? 'gu' : 'giu');
}

function firstMatch(text, query, caseSensitive) {
  const match = literalMatcher(query, caseSensitive).exec(text);
  return match ? { offset: match.index, length: match[0].length } : null;
}

function lineStartsFor(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineIndexAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

function contentEvidence(text, match, lineStarts, contextChars) {
  const lineIndex = lineIndexAt(lineStarts, match.offset);
  const physicalLineStart = lineStarts[lineIndex];
  const newline = text.indexOf('\n', match.offset + match.length);
  const physicalLineEnd = newline === -1 ? text.length : newline;
  const excerptStart = Math.max(physicalLineStart, match.offset - contextChars);
  const excerptEnd = Math.min(physicalLineEnd, match.offset + match.length + contextChars);
  return {
    line: lineIndex + 1,
    column: match.offset - physicalLineStart + 1,
    offset: match.offset,
    length: match.length,
    excerpt: text.slice(excerptStart, excerptEnd),
    excerptStart,
    matchStart: match.offset - excerptStart,
    matchEnd: match.offset - excerptStart + match.length,
  };
}

function findContentResults(file, content, query, options, remaining) {
  if (remaining <= 0) return { results: [], hasMore: true };
  const results = [];
  const matcher = literalMatcher(query, options.caseSensitive);
  const lineStarts = lineStartsFor(content);
  let match;
  while ((match = matcher.exec(content)) !== null) {
    if (results.length >= remaining) return { results, hasMore: true };
    results.push({
      path: file.path,
      target: 'content',
      ...contentEvidence(content, { offset: match.index, length: match[0].length }, lineStarts, options.contextChars),
    });
  }
  return { results, hasMore: false };
}

/**
 * Search public Markdown filenames and bodies.
 *
 * `offset`, `excerptStart`, and filename offsets are zero-based JavaScript
 * UTF-16 character offsets; `line` and `column` are one-based for editor UI.
 */
function searchProject(projectService, rootPath, query, options) {
  if (!projectService || typeof projectService.listTree !== 'function' || typeof projectService.readFile !== 'function') {
    fail('INVALID_PROJECT_SERVICE', 'projectService 缺少 listTree/readFile 接口');
  }
  const needle = normalizeQuery(query);
  const settings = normalizeOptions(options);
  const files = flattenMarkdownTree(projectService.listTree(rootPath));
  const reasons = new Set();
  const errors = [];
  const filenameResults = [];
  const contentResults = [];

  if (settings.searchFilenames) {
    for (const file of files) {
      const match = firstMatch(file.name, needle, settings.caseSensitive);
      if (!match) continue;
      filenameResults.push({
        path: file.path,
        target: 'filename',
        line: null,
        column: match.offset + 1,
        offset: match.offset,
        length: match.length,
        excerpt: file.name,
        excerptStart: 0,
        matchStart: match.offset,
        matchEnd: match.offset + match.length,
      });
    }
  }

  let filesScanned = 0;
  let filesConsidered = 0;
  let bytesScanned = 0;
  if (settings.searchContent && filenameResults.length < settings.limit) {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      if (filesConsidered >= settings.maxFiles) {
        reasons.add('FILE_LIMIT');
        break;
      }
      filesConsidered += 1;
      if (file.size !== null && file.size > MAX_FILE_SEARCH_BYTES) {
        reasons.add('FILE_TOO_LARGE');
        continue;
      }
      if (file.size !== null && bytesScanned + file.size > settings.maxBytes) {
        reasons.add('BYTE_LIMIT');
        break;
      }

      let content;
      try {
        content = projectService.readFile(rootPath, file.path);
      } catch (error) {
        reasons.add('READ_ERROR');
        if (errors.length < MAX_REPORTED_ERRORS) {
          errors.push({ path: file.path, code: error && error.code ? error.code : 'READ_FAILED' });
        }
        continue;
      }
      if (typeof content !== 'string') fail('INVALID_PROJECT_SERVICE', 'readFile 未返回文本');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_FILE_SEARCH_BYTES) {
        reasons.add('FILE_TOO_LARGE');
        continue;
      }
      if (bytesScanned + bytes > settings.maxBytes) {
        reasons.add('BYTE_LIMIT');
        break;
      }
      filesScanned += 1;
      bytesScanned += bytes;

      const remaining = settings.limit - filenameResults.length - contentResults.length;
      const found = findContentResults(file, content, needle, settings, remaining);
      contentResults.push(...found.results);
      if (found.hasMore || filenameResults.length + contentResults.length >= settings.limit) {
        if (found.hasMore || fileIndex < files.length - 1) reasons.add('RESULT_LIMIT');
        break;
      }
    }
  } else if (settings.searchContent && filenameResults.length >= settings.limit) {
    reasons.add('RESULT_LIMIT');
  } else if (filenameResults.length > settings.limit) {
    reasons.add('RESULT_LIMIT');
  }

  // Filename hits intentionally rank before body hits. Within each class the
  // project path and then body offset are stable because files are pre-sorted.
  const results = filenameResults.concat(contentResults).slice(0, settings.limit);
  if (filenameResults.length + contentResults.length > settings.limit) reasons.add('RESULT_LIMIT');
  return {
    query: needle,
    results,
    stats: {
      filesDiscovered: files.length,
      filesConsidered,
      filesScanned,
      bytesScanned,
      resultCount: results.length,
      truncated: reasons.size > 0,
      truncatedReasons: Array.from(reasons).sort(compareText),
      errors,
    },
  };
}

module.exports = {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_QUERY_CHARS,
  MAX_SEARCH_FILES,
  MAX_SEARCH_BYTES,
  MAX_FILE_SEARCH_BYTES,
  ProjectSearchError,
  searchProject,
};
