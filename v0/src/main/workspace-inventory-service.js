'use strict';

// Main-owned deterministic inventory shared by Project Home, Outline and
// Quick Open. The service never accepts Renderer-supplied paths: every read is
// derived from ProjectService's guarded tree for the active project root.

const path = require('path');
const crypto = require('crypto');
const contextSelection = require('../shared/context-selection');

const MAX_INVENTORY_FILES = 5000;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 5000;

class WorkspaceInventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceInventoryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceInventoryError(code, message);
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function publicMarkdownPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') ||
      value.includes('//') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含无效路径');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts[parts.length - 1])) {
    fail('UNSAFE_PROJECT_TREE', '项目树包含非公开 Markdown 路径');
  }
  return parts.join('/').normalize('NFC');
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
        visit(node.children);
      } else if (node.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) {
        const filePath = publicMarkdownPath(node.path);
        const key = filePath.toLocaleLowerCase('en-US');
        if (seen.has(key)) fail('UNSAFE_PROJECT_TREE', '项目树包含重复 Markdown 路径');
        seen.add(key);
        files.push(Object.freeze({
          path: filePath,
          name: path.posix.basename(filePath),
          size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null,
        }));
        if (files.length > MAX_INVENTORY_FILES) fail('TREE_TOO_LARGE', '项目 Markdown 文件超过索引上限');
      }
    }
  }
  visit(tree);
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
}

function manuscriptPath(filePath) {
  const lower = filePath.toLocaleLowerCase('en-US');
  return lower !== 'edit.md' && !lower.startsWith('references/') && !lower.startsWith('sources/');
}

const HTML_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, decimal, hex, named) => {
    const codePoint = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : null;
    if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      try { return String.fromCodePoint(codePoint); } catch (_) { return ' '; }
    }
    return HTML_ENTITIES[String(named || '').toLocaleLowerCase('en-US')] ?? ' ';
  });
}

function stripMarkdownForCounting(content) {
  let text = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, ' ');
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^\s*\[\^[^\]]+\]:\s*/gm, '');
  // Link-reference destinations are metadata, while footnote definitions are
  // manuscript prose. Keep the latter intact so its first word is counted.
  text = text.replace(/^(\s*\[(?!\^)[^\]]+\]:)\s*\S+\s*/gm, '$1 ');
  text = text.replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>])/g, '$1');
  text = text.replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '');
  return text.replace(/[*_~`|]/g, ' ');
}

function countManuscriptWords(content) {
  const text = stripMarkdownForCounting(content).normalize('NFC');
  // JavaScript set intersection support varies across Electron/Node versions;
  // count CJK and full-width digits explicitly instead of relying on `v` regex.
  const cjkCount = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF10-\uFF19]/gu) || []).length;
  const withoutCjk = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uFF10-\uFF19]/gu, ' ');
  const graphemeSegmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter('und', { granularity: 'grapheme' })
    : null;
  let emojiCount = 0;
  let withoutEmoji = withoutCjk;
  if (graphemeSegmenter) {
    withoutEmoji = [...graphemeSegmenter.segment(withoutCjk)].map(({ segment }) => {
      if (!/(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3)/u.test(segment)) return segment;
      emojiCount += 1;
      return ' ';
    }).join('');
  } else {
    emojiCount = (withoutCjk.match(/\p{Extended_Pictographic}/gu) || []).length;
  }
  const latinCount = (withoutEmoji.match(/[\p{Script=Latin}0-9]+(?:['’-][\p{Script=Latin}0-9]+)*/gu) || []).length;
  return cjkCount + latinCount + emojiCount;
}

function chapterState(content, headings) {
  const structuralSource = String(content || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (!structuralSource) return 'blank';
  const withoutHeadingSyntax = String(content || '')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')
    .replace(/^([^\n]+)\n\s{0,3}(?:=+|-+)\s*$/gm, '');
  const remainingLines = withoutHeadingSyntax.split(/\r?\n/).filter(raw => {
    const line = raw.trim();
    if (!line || /^\s{0,3}(?:=+|-+)\s*$/.test(line)) return false;
    if (/^(?:[-+*]|\d+[.)]|>)\s*$/.test(line)) return false;
    const placeholder = line.replace(/^(?:[-+*]|\d+[.)]|>)\s*/, '').replace(/[\s.!！?？:：;；,，。…_-]+$/g, '');
    return !/^(?:TODO|TBD|待写|待补|待补正文|占位)$/i.test(placeholder);
  });
  return remainingLines.length ? 'body' : 'skeleton';
}

function parseInventoryHeadings(content, filePath) {
  // Context selection intentionally rejects URI-looking paths such as
  // `Graph:Notes.md`, while ProjectService permits that valid POSIX filename.
  // Inventory borrows only its Markdown grammar and owns its own location ID;
  // otherwise one legal author filename can make the entire Home snapshot fail.
  return contextSelection.parseMarkdownSections(content, 'inventory.md').map(section => Object.freeze({
    id: `sec_${crypto.createHash('sha256')
      .update(`${filePath}\n${section.normalizedHeading}\n${section.occurrence}`, 'utf8')
      .digest('hex').slice(0, 16)}`,
    heading: section.heading,
    normalizedHeading: section.normalizedHeading,
    level: section.level,
    occurrence: section.occurrence,
    startOffset: section.startOffset,
    endOffset: section.endOffset,
    line: section.line,
  }));
}

function sameAuthority(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return left.projectInstanceId === right.projectInstanceId &&
    Number.isSafeInteger(left.projectMutationGeneration) &&
    left.projectMutationGeneration === right.projectMutationGeneration;
}

function buildWorkspaceInventory(options = {}) {
  const { projectService, rootPath } = options;
  const captureAuthority = options.captureAuthority;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const deadlineMs = Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0
    ? Math.min(options.deadlineMs, DEFAULT_DEADLINE_MS)
    : DEFAULT_DEADLINE_MS;
  if (!projectService || typeof projectService.listTree !== 'function' ||
      typeof projectService.readFileWithRevision !== 'function') {
    fail('INVALID_PROJECT_SERVICE', '工作区索引需要 listTree/readFileWithRevision');
  }
  if (typeof captureAuthority !== 'function') fail('INVALID_AUTHORITY_GUARD', '工作区索引缺少项目权威保护');
  if (typeof rootPath !== 'string' || !rootPath) fail('NO_PROJECT', '尚未打开项目');
  const startedAt = clock();
  const initialAuthority = captureAuthority();
  if (!initialAuthority || typeof initialAuthority.projectInstanceId !== 'string') {
    fail('PROJECT_CHANGED', '项目权威不可用');
  }
  const assertAuthority = () => {
    if (!sameAuthority(initialAuthority, captureAuthority())) fail('PROJECT_CHANGED', '项目在索引期间发生变化');
  };
  const assertDeadline = () => {
    if (clock() - startedAt >= deadlineMs) fail('HOME_SNAPSHOT_TIMEOUT', '项目统计暂不可用');
  };
  assertDeadline();
  assertAuthority();
  const listed = flattenMarkdownTree(projectService.listTree(rootPath));
  assertAuthority();
  const files = [];
  let readBytes = 0;
  for (const item of listed) {
    assertDeadline();
    assertAuthority();
    const snapshot = projectService.readFileWithRevision(rootPath, item.path);
    assertAuthority();
    if (!snapshot || typeof snapshot.content !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision || '')) {
      fail('INVALID_PROJECT_SERVICE', '文件快照或 revision 无效');
    }
    readBytes += byteLength(snapshot.content);
    if (readBytes > MAX_INVENTORY_BYTES) fail('INDEX_BYTE_LIMIT', '项目正文超过索引读取上限');
    const headings = parseInventoryHeadings(snapshot.content, item.path);
    const isManuscript = manuscriptPath(item.path);
    files.push(Object.freeze({
      ...item,
      revision: snapshot.revision,
      contentLength: snapshot.content.length,
      manuscript: isManuscript,
      wordCount: isManuscript ? countManuscriptWords(snapshot.content) : 0,
      chapterState: isManuscript ? chapterState(snapshot.content, headings) : null,
      headings: Object.freeze(headings),
    }));
  }
  assertDeadline();
  assertAuthority();
  return Object.freeze({
    schema: 'writcraft.workspace-inventory/v1',
    status: 'ready',
    markdownFileCount: files.length,
    manuscriptFileCount: files.filter(file => file.manuscript).length,
    manuscriptWordCount: files.reduce((total, file) => total + file.wordCount, 0),
    readBytes,
    authority: Object.freeze({ ...initialAuthority }),
    files: Object.freeze(files),
  });
}

module.exports = {
  MAX_INVENTORY_FILES,
  MAX_INVENTORY_BYTES,
  DEFAULT_DEADLINE_MS,
  WorkspaceInventoryError,
  flattenMarkdownTree,
  manuscriptPath,
  stripMarkdownForCounting,
  decodeHtmlEntities,
  countManuscriptWords,
  chapterState,
  buildWorkspaceInventory,
};
