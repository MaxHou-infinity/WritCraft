'use strict';

const crypto = require('crypto');
const contextSelection = require('../shared/context-selection');
const sourceIndexService = require('./source-index-service');
const graphIndexService = require('./graph-index-service');
const contextPolicyService = require('./context-policy-service');
const blockAnchor = require('../shared/block-anchor');
const contextManifestService = require('../shared/context-manifest');
const editPromptManifest = require('../shared/edit-prompt-manifest');

const MAX_CONTEXT_CHARS = 10000;
const MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_CONTEXT_FILES = 40;
const MAX_EDIT_CONTEXT_CHARS = editPromptManifest.BUDGET_CHARS;
const MAX_EDIT_CONTEXT_BYTES = editPromptManifest.BUDGET_BYTES;
const MAX_EDIT_CONTEXT_SECTIONS = 64;
const MAX_EDIT_HEADING_CHARS = 256;
const MAX_EDIT_HEADING_BYTES = 1024;
const MAX_SELECTION_CONTEXT_CHARS = 3000;
const MAX_SELECTION_CONTEXT_BYTES = 9 * 1024;
const CONTEXT_SCOPES = Object.freeze(['project', 'file', 'selection']);
const MAX_PROJECT_RETRIEVAL_FILES = 24;
const MAX_PROJECT_RETRIEVAL_SCAN_BYTES = 256 * 1024;
const MAX_PROJECT_RETRIEVAL_SCAN_CHARS = 180000;
const MAX_PROJECT_RETRIEVAL_FILE_CHARS = 48000;
const MAX_PROJECT_RETRIEVAL_SNIPPETS = 6;
const MAX_PROJECT_RETRIEVAL_SNIPPET_CHARS = 1200;

class ContextResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextResolverError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ContextResolverError(code, message);
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)}`;
}

function lineColumn(content, offset) {
  const safe = Math.max(0, Math.min(Number(offset) || 0, content.length));
  const before = content.slice(0, safe);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: safe - lastBreak };
}

function prefixWithinBytes(value, limit) {
  const source = String(value || '');
  if (limit <= 0) return '';
  if (Buffer.byteLength(source, 'utf8') <= limit) return source;
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(source.slice(0, middle), 'utf8') <= limit) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(source[low - 1]) && /[\uDC00-\uDFFF]/.test(source[low] || '')) low -= 1;
  return source.slice(0, low);
}

function normalizedHeading(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, '').replace(/[：:、，,。.!！?？·—_-]/g, '');
}

const REQUIRED_EDIT_HEADINGS = new Map([
  ['项目主旨', 0],
  ['主旨', 0],
  ['范围与非目标', 1],
  ['范围和非目标', 1],
  ['关键实体与不变量', 2],
  ['关键实体和不变量', 2],
  ['时间与关系约束', 3],
  ['时间和关系约束', 3],
].map(([heading, rank]) => [normalizedHeading(heading), rank]));

function parseEditPromptSections(content) {
  const lines = [];
  let offset = 0;
  for (const raw of String(content || '').split(/(?<=\n)/)) {
    lines.push({ raw, text: raw.replace(/\r?\n$/, ''), start: offset, end: offset + raw.length });
    offset += raw.length;
  }
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text;
    if (fence) {
      const closing = text.match(/^\s{0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const normalized = heading[2].normalize('NFKC').trim();
    if (normalized.length > MAX_EDIT_HEADING_CHARS ||
        Buffer.byteLength(normalized, 'utf8') > MAX_EDIT_HEADING_BYTES) {
      fail('PROJECT_PROMPT_HEADING_LIMIT',
        `edit.md 标题不能超过 ${MAX_EDIT_HEADING_CHARS} 字符或 ${MAX_EDIT_HEADING_BYTES} 字节`);
    }
    headings.push({
      heading: normalized,
      level: heading[1].length,
      start: lines[index].start,
      line: index + 1,
    });
    if (headings.length > MAX_EDIT_CONTEXT_SECTIONS) {
      fail('PROJECT_PROMPT_SECTION_LIMIT', `edit.md 最多支持 ${MAX_EDIT_CONTEXT_SECTIONS} 个可披露章节`);
    }
  }

  const sections = [];
  if (!headings.length || headings[0].start > 0) {
    const end = headings[0]?.start ?? content.length;
    if (content.slice(0, end).trim()) {
      sections.push({ heading: '文档前言', level: 0, start: 0, end, line: 1, requiredRank: null });
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    sections.push({
      ...heading,
      end: headings[index + 1]?.start ?? content.length,
      requiredRank: REQUIRED_EDIT_HEADINGS.get(normalizedHeading(heading.heading)) ?? null,
    });
  }
  if (sections.length > MAX_EDIT_CONTEXT_SECTIONS) {
    fail('PROJECT_PROMPT_SECTION_LIMIT', `edit.md 最多支持 ${MAX_EDIT_CONTEXT_SECTIONS} 个可披露章节`);
  }
  return sections.map((section, index) => ({
    ...section,
    id: stableId('ctx_edit_section', `${section.heading}\0${section.level}\0${section.start}\0${index}`),
    content: content.slice(section.start, section.end),
  }));
}

function compileEditPrompt(content) {
  const source = String(content || '');
  if (!source.trim()) fail('PROJECT_PROMPT_UNAVAILABLE', '项目 Prompt edit.md 不能为空');
  const fullFits = source.length <= MAX_EDIT_CONTEXT_CHARS && Buffer.byteLength(source, 'utf8') <= MAX_EDIT_CONTEXT_BYTES;
  let sections;
  try {
    sections = parseEditPromptSections(source);
  } catch (error) {
    if (!fullFits || !['PROJECT_PROMPT_SECTION_LIMIT', 'PROJECT_PROMPT_HEADING_LIMIT'].includes(error?.code)) throw error;
    sections = [{
      id: stableId('ctx_edit_section', `complete\0${source.length}`),
      heading: '完整 edit.md',
      level: 0,
      start: 0,
      end: source.length,
      line: 1,
      requiredRank: null,
      content: source,
      disclosureReason: '短项目卡已完整纳入；章节目录超过逐章披露上限',
    }];
  }
  if (fullFits) {
    return {
      content: source,
      truncated: false,
      sections: sections.map(section => ({
        ...section,
        status: 'used',
        reason: section.disclosureReason || '完整 edit.md 已纳入',
        bytes: Buffer.byteLength(section.content, 'utf8'),
      })),
    };
  }
  if (!sections.length) fail('PROJECT_PROMPT_CONTEXT_TOO_LARGE', '超长 edit.md 需要使用 Markdown 标题划分章节后才能完整选择硬约束');

  const required = sections.filter(section => section.requiredRank !== null)
    .sort((left, right) => left.requiredRank - right.requiredRank || left.start - right.start);
  const selectedIds = new Set(required.map(section => section.id));
  function selectedContent(ids) {
    return sections.filter(section => ids.has(section.id)).map(section => section.content).filter(Boolean).join('');
  }
  let compiled = selectedContent(selectedIds);
  if (compiled.length > MAX_EDIT_CONTEXT_CHARS || Buffer.byteLength(compiled, 'utf8') > MAX_EDIT_CONTEXT_BYTES) {
    fail('PROJECT_PROMPT_REQUIRED_SECTIONS_TOO_LARGE', 'edit.md 的必需硬约束章节超过项目 Prompt 预算，未生成部分上下文');
  }
  for (const section of sections) {
    if (selectedIds.has(section.id)) continue;
    const candidateIds = new Set(selectedIds);
    candidateIds.add(section.id);
    const candidate = selectedContent(candidateIds);
    if (candidate.length > MAX_EDIT_CONTEXT_CHARS || Buffer.byteLength(candidate, 'utf8') > MAX_EDIT_CONTEXT_BYTES) continue;
    selectedIds.add(section.id);
    compiled = candidate;
  }
  if (!compiled.trim()) fail('PROJECT_PROMPT_CONTEXT_TOO_LARGE', '超长 edit.md 没有可在预算内完整纳入的 Markdown 章节');
  return {
    content: compiled,
    truncated: selectedIds.size < sections.length,
    sections: sections.map(section => {
      const used = selectedIds.has(section.id);
      return {
        ...section,
        status: used ? 'used' : 'omitted',
        reason: used
          ? section.requiredRank !== null ? '硬约束优先保留' : '按原文顺序完整纳入'
          : `超过项目 Prompt ${MAX_EDIT_CONTEXT_CHARS} 字符 / ${MAX_EDIT_CONTEXT_BYTES} 字节预算`,
        bytes: used ? Buffer.byteLength(section.content, 'utf8') : 0,
      };
    }),
  };
}

function scopeChip(scope) {
  const labels = { project: '项目作用域', file: '文件作用域', selection: '选区作用域' };
  const reasons = {
    project: '仅使用 edit.md、用户显式引用与确定性检索片段；未读取或发送整个项目',
    file: '使用 edit.md、当前文件与用户显式引用',
    selection: '使用 edit.md、当前精确选区、前后相邻 Markdown 段落与用户显式引用',
  };
  return {
    id: `ctx_scope_${scope}`,
    type: 'scope',
    label: labels[scope],
    scope,
    reason: reasons[scope],
    locator: null,
    truncated: false,
    truncationReason: null,
  };
}

function authoritativeCurrentFileChip(filePath, snapshot) {
  return {
    id: `ctx_file_${crypto.createHash('sha256').update(filePath, 'utf8').digest('hex').slice(0, 24)}`,
    type: 'file',
    label: filePath.split('/').at(-1) || filePath,
    filePath,
    revision: snapshot.revision,
    locator: { filePath, offset: 0, endOffset: snapshot.content.length, line: 1, column: 1 },
    truncated: false,
    truncationReason: null,
  };
}

function dedupeFullFileChips(chips, initiallyClaimed = []) {
  const claimedPaths = new Set(initiallyClaimed);
  const normalized = [];
  for (const chip of chips || []) {
    if (chip?.type === 'file' || chip?.type === 'chapter') {
      if (!chip.filePath || claimedPaths.has(chip.filePath)) continue;
      claimedPaths.add(chip.filePath);
      normalized.push(chip);
      continue;
    }
    if (chip?.type === 'folder') {
      const originalPaths = Array.isArray(chip.filePaths) ? chip.filePaths : [];
      const filePaths = [];
      let omittedCount = 0;
      for (const filePath of originalPaths) {
        if (claimedPaths.has(filePath)) {
          omittedCount += 1;
          continue;
        }
        claimedPaths.add(filePath);
        filePaths.push(filePath);
      }
      if (!filePaths.length) continue;
      normalized.push(omittedCount ? {
        ...chip,
        filePaths,
        truncated: true,
        omittedCount: (chip.omittedCount || 0) + omittedCount,
        truncationReason: chip.truncationReason || '重复的完整文件引用已合并，正文只进入模型一次',
      } : chip);
      continue;
    }
    normalized.push(chip);
  }
  return { chips: normalized, claimedPaths };
}

function markdownPaths(tree, output = []) {
  for (const node of tree || []) {
    if (node?.type === 'directory') markdownPaths(node.children, output);
    else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) output.push(node.path);
  }
  return output;
}

function requestedPaths(chips) {
  const paths = [];
  for (const chip of chips || []) {
    if (chip.filePath) paths.push(chip.filePath);
    for (const filePath of chip.filePaths || []) paths.push(filePath);
    for (const evidence of chip.evidence || []) if (evidence.path || evidence.filePath) paths.push(evidence.path || evidence.filePath);
  }
  return [...new Set(paths)];
}

function locatorFrom(value, fallbackPath = null) {
  if (!value || typeof value !== 'object') return null;
  const filePath = value.filePath || value.path || fallbackPath;
  const offset = Number.isSafeInteger(value.offset) ? value.offset
    : Number.isSafeInteger(value.start) ? value.start : null;
  const endOffset = Number.isSafeInteger(value.endOffset) ? value.endOffset
    : Number.isSafeInteger(value.end) ? value.end : offset;
  if (typeof filePath !== 'string' || offset === null || endOffset === null || offset < 0 || endOffset < offset) return null;
  return {
    filePath,
    offset,
    endOffset,
    line: Number.isSafeInteger(value.line) && value.line > 0 ? value.line : 1,
    column: Number.isSafeInteger(value.column) && value.column > 0 ? value.column : 1,
    ...(typeof value.heading === 'string' && value.heading ? { heading: value.heading } : {}),
  };
}

function ensureChipLocator(chip) {
  if (!chip || typeof chip !== 'object') return chip;
  const firstEvidence = Array.isArray(chip.evidence) ? chip.evidence.find(Boolean) : null;
  const locator = locatorFrom(chip.locator, chip.filePath) || locatorFrom(firstEvidence, chip.filePath);
  return locator ? { ...chip, filePath: locator.filePath, locator } : { ...chip, locator: null };
}

function selectionNeighbors(content, filePath, revision, selectionChip) {
  const blocks = blockAnchor.parseBlocks(content, filePath);
  const start = selectionChip.locator.offset;
  const end = selectionChip.locator.endOffset;
  const selectedIndexes = blocks.map((block, index) => ({ block, index }))
    .filter(({ block }) => block.start < end && block.end > start)
    .map(({ index }) => index);
  const firstIndex = selectedIndexes[0] ?? -1;
  const lastIndex = selectedIndexes.at(-1) ?? -1;
  if (firstIndex < 0 || lastIndex < firstIndex) {
    fail('SELECTION_BLOCK_NOT_FOUND', '选段无法定位到稳定 Markdown 段落');
  }
  const candidates = [];
  for (let index = firstIndex - 1; index >= 0; index -= 1) {
    if (blocks[index].type === 'paragraph') {
      candidates.push({ block: blocks[index], direction: 'previous', label: '上一个相邻段落' });
      break;
    }
  }
  for (let index = lastIndex + 1; index < blocks.length; index += 1) {
    if (blocks[index].type === 'paragraph') {
      candidates.push({ block: blocks[index], direction: 'next', label: '下一个相邻段落' });
      break;
    }
  }
  return candidates.map(({ block, direction, label }) => {
    const position = lineColumn(content, block.start);
    return {
      id: stableId('ctx_neighbor', `${filePath}\n${revision}\n${direction}\n${block.start}\n${block.end}`),
      type: 'neighbor',
      label,
      filePath,
      revision,
      heading: block.headingKey || null,
      reason: direction === 'previous' ? '当前选区之前最近的 Markdown 段落' : '当前选区之后最近的 Markdown 段落',
      locator: { filePath, offset: block.start, endOffset: block.end, ...position },
      excerpt: block.text,
      truncated: false,
      truncationReason: null,
    };
  });
}

function isAutomaticRetrievalPath(filePath, currentFilePath) {
  return filePath !== 'edit.md' && filePath !== currentFilePath &&
    !filePath.startsWith('.writcraft/') && !filePath.startsWith('references/') && !filePath.startsWith('sources/');
}

function retrievalTerms(query) {
  const normalized = String(query || '').normalize('NFKC').toLocaleLowerCase();
  const stop = new Set(['请', '帮我', '分析', '检查', '什么', '怎么', '为什么', '项目', '文件', '内容', '这个', '一下']);
  const terms = [];
  function add(term) {
    const clean = term.trim();
    if (clean.length < 2 || stop.has(clean) || terms.includes(clean)) return;
    terms.push(clean);
  }
  for (const token of normalized.match(/[a-z0-9_\-]{2,}|[\p{Script=Han}]{2,}/gu) || []) {
    add(token);
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1 && terms.length < 24; index += 1) add(token.slice(index, index + 2));
    }
    if (terms.length >= 24) break;
  }
  return terms.slice(0, 24);
}

function scoreRetrievalBlock(block, filePath, terms) {
  const body = `${block.headingKey || ''}\n${block.text}`.normalize('NFKC').toLocaleLowerCase();
  const pathText = filePath.toLocaleLowerCase();
  const matched = [];
  let score = 0;
  for (const term of terms) {
    if (!body.includes(term) && !pathText.includes(term)) continue;
    matched.push(term);
    if (block.headingKey?.normalize('NFKC').toLocaleLowerCase().includes(term)) score += 6;
    else if (pathText.includes(term)) score += 4;
    else score += 2;
    const count = body.split(term).length - 1;
    score += Math.min(3, Math.max(0, count - 1));
  }
  return { score, matched: matched.slice(0, 5) };
}

function retrieveProjectSnippets({ projectService, rootPath, files, currentFilePath, query, excludedPaths = new Set() }) {
  const candidatePaths = files.filter(filePath => isAutomaticRetrievalPath(filePath, currentFilePath) && !excludedPaths.has(filePath))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const terms = retrievalTerms(query);
  const scored = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let scannedChars = 0;
  let fileTruncations = 0;
  for (const filePath of candidatePaths) {
    if (scannedFiles >= MAX_PROJECT_RETRIEVAL_FILES || scannedBytes >= MAX_PROJECT_RETRIEVAL_SCAN_BYTES || scannedChars >= MAX_PROJECT_RETRIEVAL_SCAN_CHARS) break;
    const snapshot = projectService.readFileWithRevision(rootPath, filePath);
    const remainingBytes = MAX_PROJECT_RETRIEVAL_SCAN_BYTES - scannedBytes;
    const remainingChars = Math.min(MAX_PROJECT_RETRIEVAL_FILE_CHARS, MAX_PROJECT_RETRIEVAL_SCAN_CHARS - scannedChars);
    let scanned = snapshot.content.slice(0, remainingChars);
    scanned = prefixWithinBytes(scanned, remainingBytes);
    if (!scanned && snapshot.content) break;
    scannedFiles += 1;
    scannedBytes += Buffer.byteLength(scanned, 'utf8');
    scannedChars += scanned.length;
    const fileWasTruncated = scanned.length < snapshot.content.length;
    if (fileWasTruncated) fileTruncations += 1;
    if (!terms.length) continue;
    for (const block of blockAnchor.parseBlocks(scanned, filePath)) {
      const scoredBlock = scoreRetrievalBlock(block, filePath, terms);
      if (!scoredBlock.score) continue;
      scored.push({ filePath, revision: snapshot.revision, scanned, block, fileWasTruncated, ...scoredBlock });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath, 'en') || left.block.start - right.block.start);
  const selected = scored.slice(0, MAX_PROJECT_RETRIEVAL_SNIPPETS);
  const chips = selected.map(item => {
    const excerpt = item.block.text.slice(0, MAX_PROJECT_RETRIEVAL_SNIPPET_CHARS);
    const truncated = excerpt.length < item.block.text.length || item.fileWasTruncated;
    const position = lineColumn(item.scanned, item.block.start);
    return {
      id: stableId('ctx_retrieval', `${item.filePath}\n${item.revision}\n${item.block.start}\n${item.block.end}`),
      type: 'retrieval',
      label: item.block.headingKey || item.filePath.split('/').at(-1) || item.filePath,
      filePath: item.filePath,
      revision: item.revision,
      heading: item.block.headingKey || null,
      reason: `确定性检索匹配：${item.matched.join('、')}`,
      locator: { filePath: item.filePath, offset: item.block.start, endOffset: item.block.end, ...position },
      excerpt,
      score: item.score,
      truncated,
      truncationReason: truncated ? '检索仅扫描受限文件前缀或片段超过发送上限' : null,
    };
  });
  return {
    chips,
    summary: {
      candidateFiles: candidatePaths.length,
      scannedFiles,
      scannedBytes,
      scannedChars,
      omittedFiles: Math.max(0, candidatePaths.length - scannedFiles),
      fileTruncations,
      matchedBlocks: scored.length,
      omittedMatches: Math.max(0, scored.length - selected.length),
      terms,
      limits: {
        files: MAX_PROJECT_RETRIEVAL_FILES,
        bytes: MAX_PROJECT_RETRIEVAL_SCAN_BYTES,
        chars: MAX_PROJECT_RETRIEVAL_SCAN_CHARS,
        snippets: MAX_PROJECT_RETRIEVAL_SNIPPETS,
        snippetChars: MAX_PROJECT_RETRIEVAL_SNIPPET_CHARS,
      },
    },
  };
}

function chipManifest(chip) {
  const normalized = ensureChipLocator(chip);
  const sections = Array.isArray(normalized.sections) ? normalized.sections.slice(0, MAX_EDIT_CONTEXT_SECTIONS).map(section => ({
    id: section.id,
    heading: section.heading,
    level: section.level,
    status: section.status,
    reason: section.reason,
    bytes: section.bytes || 0,
    locator: section.locator || null,
  })) : undefined;
  return {
    id: normalized.id,
    type: normalized.type,
    label: normalized.label,
    scope: normalized.scope || null,
    filePath: normalized.filePath || null,
    filePaths: normalized.filePaths || undefined,
    folderPath: normalized.folderPath || null,
    sourceId: normalized.sourceId || null,
    entityId: normalized.entityId || null,
    revision: normalized.revision || null,
    locator: normalized.locator || null,
    evidence: normalized.evidence || undefined,
    heading: normalized.heading || normalized.locator?.heading || null,
    reason: normalized.reason || null,
    stale: Boolean(normalized.stale),
    truncated: Boolean(normalized.truncated),
    truncationReason: normalized.truncationReason || null,
    omittedCount: normalized.omittedCount || 0,
    sectionCount: normalized.sectionCount || 0,
    usedSectionCount: normalized.usedSectionCount || 0,
    omittedSectionCount: normalized.omittedSectionCount || 0,
    sections,
    bytes: normalized.bytes || 0,
  };
}

function resolveProjectContext({ projectService, rootPath, message, currentFilePath, scope, selection = null, policy = null }) {
  if (!projectService || typeof projectService.listTree !== 'function' || typeof projectService.readFileWithRevision !== 'function') {
    throw new TypeError('projectService 缺少权威文件接口');
  }
  if (typeof message !== 'string') fail('INVALID_CONTEXT_MESSAGE', 'message 必须是文本');
  if (!CONTEXT_SCOPES.includes(scope)) fail('INVALID_CONTEXT_SCOPE', '对话作用域必须是 project、file 或 selection');
  if (scope === 'selection' && !selection) {
    fail('SELECTION_REQUIRED', '选区作用域需要可验证的当前选段');
  }
  if (scope !== 'selection' && selection !== null && selection !== undefined) {
    fail('SELECTION_SCOPE_MISMATCH', '只有选区作用域可以提交选段定位');
  }
  const files = markdownPaths(projectService.listTree(rootPath));
  if (!files.includes(currentFilePath)) fail('CURRENT_FILE_NOT_FOUND', '当前文件不属于项目');
  if (!files.includes('edit.md')) {
    fail('PROJECT_PROMPT_UNAVAILABLE', '项目 Prompt edit.md 不可用');
  }
  if (selection?.filePath !== undefined && selection.filePath !== currentFilePath) {
    fail('SELECTION_FILE_MISMATCH', '选段文件必须与当前文件一致');
  }
  if (scope === 'selection' && (typeof selection.text !== 'string' ||
      selection.text.length > MAX_SELECTION_CONTEXT_CHARS || Buffer.byteLength(selection.text, 'utf8') > MAX_SELECTION_CONTEXT_BYTES)) {
    fail('SELECTION_CONTEXT_TOO_LARGE', `选段必须完整进入模型，不能超过 ${MAX_SELECTION_CONTEXT_CHARS} 字符或 ${MAX_SELECTION_CONTEXT_BYTES} 字节`);
  }

  const mentions = contextSelection.tokenizeMentions(message);
  const needsSources = mentions.some(item => item.kind === 'source');
  const needsEntities = mentions.some(item => item.kind === 'entity');
  const sources = needsSources ? sourceIndexService.buildSourceIndex(rootPath).sources : [];
  const graph = needsEntities ? graphIndexService.indexProjectGraph(projectService, rootPath).graph : null;
  const evidenceById = Object.fromEntries((graph?.evidence || []).map(item => [item.id, item]));

  const current = projectService.readFileWithRevision(rootPath, currentFilePath);
  const fileContents = { [currentFilePath]: current.content };
  const fileRevisions = { [currentFilePath]: current.revision };
  const options = {
    files,
    currentFilePath,
    currentContent: current.content,
    currentRevision: current.revision,
    fileContents,
    fileRevisions,
    selection: scope === 'selection' ? selection : null,
    sources,
    entities: graph?.nodes || [],
    evidenceById,
  };

  // First pass resolves aliases/catalog objects. A bounded second pass loads
  // only the files those explicit references selected, so @section after a
  // remote @file/@chapter can be resolved without reading the whole project.
  const first = contextSelection.parseContextSelections(message, options);
  const allRequestedPaths = requestedPaths(first.chips);
  const selectedPaths = allRequestedPaths.slice(0, MAX_CONTEXT_FILES);
  for (const filePath of selectedPaths) {
    if (fileContents[filePath] !== undefined || !files.includes(filePath)) continue;
    try {
      const snapshot = projectService.readFileWithRevision(rootPath, filePath);
      fileContents[filePath] = snapshot.content;
      fileRevisions[filePath] = snapshot.revision;
    } catch (_) {}
  }
  const parsed = contextSelection.parseContextSelections(message, options);
  if (allRequestedPaths.length > MAX_CONTEXT_FILES) {
    const omittedPaths = new Set(allRequestedPaths.slice(MAX_CONTEXT_FILES));
    parsed.errors.push({
      code: 'CONTEXT_FILE_LIMIT',
      message: `每次最多读取 ${MAX_CONTEXT_FILES} 个显式上下文文件`,
      token: '', index: -1, omittedCount: omittedPaths.size,
    });
    for (const chip of parsed.chips) {
      const paths = [chip.filePath, ...(chip.filePaths || [])].filter(Boolean);
      if (!paths.some(filePath => omittedPaths.has(filePath))) continue;
      chip.truncated = true;
      chip.truncationReason ||= `超过 ${MAX_CONTEXT_FILES} 个文件的请求读取上限`;
    }
  }

  const edit = currentFilePath === 'edit.md' ? current : projectService.readFileWithRevision(rootPath, 'edit.md');
  const compiledEdit = compileEditPrompt(edit.content);
  const editContent = compiledEdit.content;
  const editSections = compiledEdit.sections.map(section => ({
    id: section.id,
    heading: section.heading,
    level: section.level,
    status: section.status,
    reason: section.reason,
    bytes: section.bytes,
    locator: {
      filePath: 'edit.md',
      offset: section.start,
      endOffset: section.end,
      line: section.line,
      column: 1,
      revision: edit.revision,
    },
  }));
  const usedEditSections = editSections.filter(section => section.status === 'used').length;
  const omittedEditSections = editSections.length - usedEditSections;
  const editChip = {
    id: 'ctx_project_prompt_edit_md', type: 'project_prompt', label: 'edit.md', filePath: 'edit.md',
    revision: edit.revision, locator: { filePath: 'edit.md', offset: 0, endOffset: edit.content.length, line: 1, column: 1 },
    reason: compiledEdit.truncated
      ? '项目级 Prompt 按章节预算编译；硬约束优先且所有已用章节均完整'
      : '项目级 Prompt 是每次项目 AI 请求的固定硬约束',
    truncated: compiledEdit.truncated,
    truncationReason: compiledEdit.truncated ? `有 ${omittedEditSections} 个 edit.md 章节因项目 Prompt 预算未进入本次请求` : null,
    omittedCount: omittedEditSections,
    sectionCount: editSections.length,
    usedSectionCount: usedEditSections,
    omittedSectionCount: omittedEditSections,
    sections: editSections,
  };
  if (omittedEditSections) {
    parsed.errors.push({
      code: 'PROJECT_PROMPT_SECTIONS_OMITTED',
      message: `edit.md 已按章节纳入 ${usedEditSections}/${editSections.length} 个；省略 ${omittedEditSections} 个，详情见 Context Inspector`,
      token: '', index: -1, omittedCount: omittedEditSections,
    });
  }

  // edit.md is always represented by the required project_prompt chip. Drop a
  // redundant explicit full-file reference so one authoritative file never
  // reaches the model twice (including when edit.md is the current file).
  const deduped = dedupeFullFileChips(parsed.chips, ['edit.md']);
  let parsedChips = deduped.chips.map(ensureChipLocator);
  const selectionChip = parsedChips.find(chip => chip.type === 'selection') || null;
  if (scope === 'selection' && !selectionChip) {
    const selectionError = parsed.errors.find(error => /SELECTION/.test(error.code || ''));
    fail(selectionError?.code || 'SELECTION_UNVERIFIED', selectionError?.message || '当前选段无法由 Main 从磁盘快照精确重建');
  }
  if (scope !== 'selection' && selectionChip) {
    fail('SELECTION_SCOPE_MISMATCH', '非选区作用域不得混入选段');
  }
  const neighborChips = scope === 'selection'
    ? selectionNeighbors(current.content, currentFilePath, current.revision, selectionChip)
    : [];
  if (scope === 'selection') {
    parsedChips = [selectionChip, ...neighborChips, ...parsedChips.filter(chip => chip !== selectionChip)];
  }

  let retrieval = { chips: [], summary: null };
  if (scope === 'project') {
    retrieval = retrieveProjectSnippets({
      projectService,
      rootPath,
      files,
      currentFilePath,
      query: parsed.query,
      excludedPaths: new Set([...deduped.claimedPaths, ...requestedPaths(parsedChips)]),
    });
    parsedChips = [...parsedChips, ...retrieval.chips];
    if (!retrieval.summary.terms.length) {
      parsed.errors.push({
        code: 'PROJECT_RETRIEVAL_EMPTY_QUERY',
        message: '问题中没有可用于项目检索的关键词；本次仅使用 edit.md 与显式引用',
        token: '', index: -1, omittedCount: 0,
      });
    } else if (!retrieval.chips.length) {
      parsed.errors.push({
        code: 'PROJECT_RETRIEVAL_NO_MATCH',
        message: '受限项目检索没有找到相关正文片段',
        token: '', index: -1, omittedCount: 0,
      });
    }
    if (retrieval.summary.omittedFiles || retrieval.summary.fileTruncations || retrieval.summary.omittedMatches) {
      parsed.errors.push({
        code: 'PROJECT_RETRIEVAL_OMITTED',
        message: `项目检索已扫描 ${retrieval.summary.scannedFiles}/${retrieval.summary.candidateFiles} 个候选文件、${retrieval.summary.scannedChars} 字符；未扫描 ${retrieval.summary.omittedFiles} 个，文件前缀截断 ${retrieval.summary.fileTruncations} 个，未发送匹配片段 ${retrieval.summary.omittedMatches} 个`,
        token: '', index: -1,
        omittedCount: retrieval.summary.omittedFiles + retrieval.summary.omittedMatches,
      });
    }
  }

  const hasCurrentFullFile = deduped.claimedPaths.has(currentFilePath);
  const currentFileChip = scope === 'file' && currentFilePath !== 'edit.md' && !hasCurrentFullFile
    ? authoritativeCurrentFileChip(currentFilePath, current)
    : null;
  const activeScopeChip = scopeChip(scope);
  if (scope === 'project' && retrieval.summary && (retrieval.summary.omittedFiles || retrieval.summary.fileTruncations || retrieval.summary.omittedMatches)) {
    activeScopeChip.truncated = true;
    activeScopeChip.omittedCount = retrieval.summary.omittedFiles + retrieval.summary.omittedMatches;
    activeScopeChip.truncationReason = `检索边界：${retrieval.summary.scannedFiles}/${retrieval.summary.candidateFiles} 文件、${retrieval.summary.scannedBytes} 字节、最多 ${MAX_PROJECT_RETRIEVAL_SNIPPETS} 个片段`;
  }
  const implicitChips = [activeScopeChip, editChip, currentFileChip].filter(Boolean);
  const allChips = [...implicitChips, ...parsedChips];
  const provisionalManifest = {
    scope,
    currentFilePath,
    currentRevision: current.revision,
    chips: allChips.map(chipManifest),
  };
  let excluded = new Set();
  if (policy) {
    if (contextPolicyService.policyAppliesToManifest(provisionalManifest, policy)) {
      excluded = new Set(policy.excludedChipIds);
    } else {
      parsed.errors.push({
        code: 'CONTEXT_POLICY_STALE',
        message: '上下文或文件版本已变化，上次的排除选择没有继续应用',
        token: '', index: -1, omittedCount: 0,
      });
    }
  }
  const effectiveScopeChip = !excluded.has(activeScopeChip.id) ? activeScopeChip : null;
  const effectiveParsedChips = parsedChips.filter(chip => !excluded.has(chip.id));
  const effectiveEditChip = !excluded.has(editChip.id) ? editChip : null;
  const effectiveCurrentFileChip = currentFileChip && !excluded.has(currentFileChip.id) ? currentFileChip : null;

  // Fail closed even if a legacy or otherwise malformed policy reaches this
  // layer. Selection scope is truthful only while its exact, Main-verified
  // selection chip remains in the effective model context.
  if (scope === 'selection' && !effectiveParsedChips.some(chip => chip.type === 'selection')) {
    fail('REQUIRED_SELECTION_CONTEXT', '当前精确选段是选区作用域的必需上下文，不能被排除');
  }

  let remaining = MAX_CONTEXT_CHARS;
  let remainingBytes = MAX_CONTEXT_BYTES;
  const blocks = [];
  function appendBlock(header, content, chip) {
    const separator = blocks.length ? '\n\n' : '';
    const prefix = `${separator}${header}\n`;
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    if (prefix.length > remaining || prefixBytes > remainingBytes) {
      chip.truncated = true;
      chip.truncationReason ||= `本次上下文超过 ${MAX_CONTEXT_CHARS} 字符或 ${MAX_CONTEXT_BYTES} 字节预算`;
      return false;
    }
    const raw = String(content || '');
    const allowance = remaining - prefix.length;
    const byteAllowance = remainingBytes - prefixBytes;
    const used = prefixWithinBytes(raw.slice(0, allowance), byteAllowance);
    const block = `${header}\n${used}`;
    blocks.push(block);
    // Attribute the inter-block separator to the block that follows it so
    // summing chip bytes exactly matches the final context payload.
    chip.bytes = (chip.bytes || 0) + Buffer.byteLength(`${separator}${block}`, 'utf8');
    const emittedBytes = Buffer.byteLength(`${separator}${block}`, 'utf8');
    remaining -= prefix.length + used.length;
    remainingBytes -= emittedBytes;
    if (used.length < raw.length) {
      chip.truncated = true;
      chip.truncationReason ||= `内容因 ${MAX_CONTEXT_CHARS} 字符 / ${MAX_CONTEXT_BYTES} 字节请求预算被截断`;
    }
    return true;
  }

  function appendRequiredBlock(header, content, chip, code, message) {
    const separator = blocks.length ? '\n\n' : '';
    const beforeBytes = chip.bytes || 0;
    const expectedBytes = Buffer.byteLength(`${separator}${header}\n${String(content || '')}`, 'utf8');
    const appended = appendBlock(header, content, chip);
    if (!appended || (chip.bytes || 0) - beforeBytes !== expectedBytes) fail(code, message);
  }

  if (effectiveScopeChip) appendRequiredBlock(`[上下文 · scope · ${scope}]`, effectiveScopeChip.reason, effectiveScopeChip,
    'SCOPE_CONTEXT_TOO_LARGE', '作用域说明未能完整进入模型');
  if (effectiveEditChip) appendRequiredBlock('[上下文 · project prompt · edit.md]', editContent, effectiveEditChip,
    'PROJECT_PROMPT_CONTEXT_TOO_LARGE', 'edit.md 未能完整进入模型');
  if (effectiveCurrentFileChip) {
    appendBlock(`[上下文 · file · ${currentFilePath}]`, current.content, effectiveCurrentFileChip);
  }
  for (const chip of effectiveParsedChips) {
    if (chip.type === 'selection') {
      appendRequiredBlock(`[上下文 · selection · ${chip.filePath}]`, chip.excerpt, chip,
        'SELECTION_CONTEXT_TOO_LARGE', '当前精确选段未能完整进入模型');
    } else if (chip.type === 'section' || chip.type === 'neighbor') {
      appendBlock(`[上下文 · ${chip.type} · ${chip.filePath}]`, chip.excerpt, chip);
    } else if (chip.type === 'retrieval') {
      const heading = chip.heading ? ` · ${chip.heading}` : '';
      appendBlock(`[上下文 · retrieval · ${chip.filePath}${heading} · ${chip.reason}]`, chip.excerpt, chip);
    } else if (chip.type === 'file' || chip.type === 'chapter') {
      appendBlock(`[上下文 · ${chip.type} · ${chip.filePath}]`, fileContents[chip.filePath], chip);
    } else if (chip.type === 'folder') {
      for (const filePath of chip.filePaths || []) appendBlock(`[上下文 · folder ${chip.folderPath} · ${filePath}]`, fileContents[filePath], chip);
    } else if (chip.type === 'source') {
      appendBlock(`[上下文 · source · ${chip.label}]`, fileContents[chip.filePath] || (chip.evidence || []).map(item => item.quote).join('\n'), chip);
    } else if (chip.type === 'entity') {
      appendBlock(`[上下文 · entity · ${chip.label}]`, (chip.evidence || []).map(item => `${item.path || item.filePath || ''}: ${item.quote || ''}`).join('\n'), chip);
    }
  }

  const candidateChips = [effectiveScopeChip, effectiveEditChip, effectiveCurrentFileChip, ...effectiveParsedChips].filter(Boolean);
  const chips = candidateChips.filter(chip => (chip.bytes || 0) > 0);
  const omittedChips = candidateChips.filter(chip => (chip.bytes || 0) === 0);
  if (omittedChips.length) {
    parsed.errors.push({
      code: 'CONTEXT_BUDGET_OMITTED',
      message: `有 ${omittedChips.length} 个上下文项因字符预算未进入本次模型请求`,
      token: '', index: -1, omittedCount: omittedChips.length,
    });
  }
  const contextText = blocks.join('\n\n');
  const unifiedItems = candidateChips.map(chip => {
    const included = (chip.bytes || 0) > 0;
    const kind = chip.type === 'project_prompt' ? 'project_prompt'
      : chip.type === 'file' && chip.filePath === currentFilePath ? 'current_file'
        : ['source', 'entity', 'selection'].includes(chip.type) ? chip.type : 'context';
    return {
      id: chip.id,
      kind,
      path: typeof chip.filePath === 'string' ? chip.filePath : null,
      revision: typeof chip.revision === 'string' ? chip.revision : null,
      status: included ? 'included' : 'omitted',
      rawBytes: null,
      includedBytes: included ? chip.bytes : 0,
      budgetBytes: MAX_CONTEXT_BYTES,
      omissionReason: included ? null : (chip.truncated ? 'budget' : 'not_selected'),
      truncationReason: chip.truncated ? 'aggregate_budget' : null,
    };
  });
  const unified = contextManifestService.createContextManifest({
    entry: 'chat',
    editRevision: edit.revision,
    editCompilation: contextManifestService.createEditCompilation({
      rawContent: edit.content,
      compiledContent: editContent,
      revision: edit.revision,
      compiledResult: compiledEdit,
    }),
    items: unifiedItems,
    budgetBytes: MAX_CONTEXT_BYTES,
  });
  return {
    query: parsed.query,
    chips,
    errors: parsed.errors,
    contextText,
    contextManifest: {
      schema: 'writcraft.context-manifest/v1',
      authority: 'main-manifest',
      scope,
      currentFilePath,
      currentRevision: current.revision,
      budgetChars: MAX_CONTEXT_CHARS,
      budgetBytes: MAX_CONTEXT_BYTES,
      usedChars: contextText.length,
      usedBytes: Buffer.byteLength(contextText, 'utf8'),
      chips: chips.map(chipManifest),
      omittedChips: omittedChips.map(chipManifest),
      retrieval: retrieval.summary,
      unified,
      editPrompt: editPromptManifest.createEditPromptManifest({
        rawContent: edit.content,
        compiledContent: compiledEdit.content,
        revision: edit.revision,
        compiledResult: compiledEdit,
      }),
    },
  };
}

module.exports = {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILES,
  MAX_EDIT_CONTEXT_CHARS,
  MAX_EDIT_CONTEXT_BYTES,
  MAX_EDIT_CONTEXT_SECTIONS,
  MAX_EDIT_HEADING_CHARS,
  MAX_EDIT_HEADING_BYTES,
  MAX_SELECTION_CONTEXT_CHARS,
  MAX_SELECTION_CONTEXT_BYTES,
  CONTEXT_SCOPES,
  MAX_PROJECT_RETRIEVAL_FILES,
  MAX_PROJECT_RETRIEVAL_SCAN_BYTES,
  MAX_PROJECT_RETRIEVAL_SCAN_CHARS,
  MAX_PROJECT_RETRIEVAL_SNIPPETS,
  MAX_PROJECT_RETRIEVAL_SNIPPET_CHARS,
  ContextResolverError,
  parseEditPromptSections,
  compileEditPrompt,
  resolveProjectContext,
};
