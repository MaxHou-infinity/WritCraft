'use strict';

// Stage B is deliberately a read-only service.  It consumes one immutable
// snapshot bundle plus Main-owned Graph/SourceIndex projections and never
// reads the live manuscript or performs a write.
const crypto = require('crypto');
const zlib = require('zlib');
const snapshotBundle = require('./snapshot-bundle');
const graphCorrection = require('./graph-correction-service');
const schema = require('./delivery-preflight-schema');
const evidenceSchema = require('./evidence-delivery-schema');
const marked = require('../shared/marked.umd');
const citationIdentity = require('../shared/citation-identity');
const blockAnchor = require('../shared/block-anchor');

const GRAPH_BINDING_SCHEMA = schema.SCHEMAS.DELIVERY_GRAPH_BINDING;
const SOURCE_BINDING_SCHEMA = schema.SCHEMAS.DELIVERY_SOURCE_BINDING;
const SOURCE_INDEX_BINDING_SCHEMA = schema.SCHEMAS.DELIVERY_SOURCE_INDEX_BINDING;
const SOURCE_ITEM_SCHEMA = schema.SCHEMAS.DELIVERY_SOURCE_ITEM;
const LOCATOR_SCHEMA = 'writcraft.locator-identity/v1';
const REVISION_RE = /^[a-f0-9]{64}$/;
const FOOTNOTE_ID_RE = /^[\p{L}\p{N}_.:\-]{1,128}$/u;
const FOOTNOTE_REF_RE = /\[\^([^\]\r\n]+)\](?!:)/gu;
const FOOTNOTE_DEF_RE = /^\[\^([^\]\r\n]+)\]:/gmu;
const FOOTNOTE_SOURCE_RE = /<!--\s*writcraft-source:([A-Za-z0-9_-]{1,128})\s*-->/giu;
const MAX_OUTLINE = schema.MAX_OUTLINE;
const MARKED_PARSER_ID = 'marked@18.0.6+sha256:62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d';

class DeliveryPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryPreflightError';
    this.code = code;
  }
}

function fail(code, message) { throw new DeliveryPreflightError(code, message); }
function digest(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function digestBytes(value) { return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`; }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function freeze(value) {
  if (value && typeof value === 'object' && Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = freeze(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function graphInputDigest(graph) {
  const manifest = graph?.manifest;
  const inputFiles = Array.isArray(manifest?.inputFiles) ? manifest.inputFiles.map(item => ({
    path: item.path, revision: item.revision,
  })).sort((a, b) => compare(a.path, b.path)) : [];
  return evidenceSchema.digestObject('writcraft.graph-input/v1', {
    schema: 'writcraft.graph-input/v1', inputFiles,
  });
}

function graphManifest(graph, snapshotManifest) {
  if (!graph || graph.schema !== 'writcraft.graph/v2' || !graph.manifest) fail('DELIVERY_STALE', 'Graph 输入不可用');
  const expected = snapshotManifest.files.filter(file => file.kind === 'markdown').map(file => ({ path: file.path, revision: file.revision }))
    .sort((a, b) => compare(a.path, b.path));
  const actual = Array.isArray(graph.manifest.inputFiles) ? graph.manifest.inputFiles.map(item => ({
    path: item.path, revision: item.revision,
  })).sort((a, b) => compare(a.path, b.path)) : [];
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('DELIVERY_STALE', 'Graph 未绑定同一 snapshot revision set');
  const graphIdentity = graphCorrection.graphIdentity(graph);
  const sourceBindings = [];
  for (const edge of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!['cites', 'supports', 'contradicts'].includes(edge.relation)) continue;
    const from = graph.nodes?.find(node => node.id === edge.from);
    const to = graph.nodes?.find(node => node.id === edge.to);
    const claim = from?.type === 'claim' ? from : to?.type === 'claim' ? to : null;
    const source = from?.type === 'source' || from?.type === 'datum' ? from : to?.type === 'source' || to?.type === 'datum' ? to : null;
    if (!claim || !source) continue;
    for (const evidenceId of [...new Set(edge.evidenceIds || source.evidenceIds || [])].sort(compare)) {
      const bindingId = evidenceSchema.digestObject('writcraft.graph-source-binding-id/v1', {
        schema: 'writcraft.graph-source-binding-id/v1', graphIdentity,
        graphNodeId: claim.id, sourceId: source.id, evidenceId,
      });
      const item = {
        schema: SOURCE_BINDING_SCHEMA,
        bindingId,
        graphNodeId: claim.id,
        sourceId: source.id,
        evidenceId,
        bindingDigest: null,
      };
      item.bindingDigest = evidenceSchema.digestObject(SOURCE_BINDING_SCHEMA, item, 'bindingDigest');
      sourceBindings.push(item);
    }
  }
  sourceBindings.sort((a, b) => compare(`${a.graphNodeId}\0${a.sourceId}\0${a.evidenceId}`, `${b.graphNodeId}\0${b.sourceId}\0${b.evidenceId}`));
  const binding = {
    schema: GRAPH_BINDING_SCHEMA,
    snapshotId: snapshotManifest.snapshotId,
    fileRevisionSetDigest: snapshotManifest.fileRevisionSetDigest,
    graphIdentity,
    graphSchema: graph.schema,
    graphInputDigest: graphInputDigest(graph),
    correctionsDigest: digestBytes(Buffer.from(JSON.stringify(graph.correctionState || null), 'utf8')),
    issueStateDigest: digestBytes(Buffer.from(JSON.stringify((graph.issues || []).map(item => ({ id: item.id, status: item.status || 'open' })), 'utf8'))),
    evidenceSetDigest: digestBytes(Buffer.from(JSON.stringify((graph.evidence || []).map(item => item.id).sort(compare), 'utf8'))),
    sourceBindings,
  };
  const graphManifestDigest = evidenceSchema.digestObject(GRAPH_BINDING_SCHEMA, binding);
  schema.assertGraphBinding(binding);
  return { graphIdentity, graphManifestDigest, binding };
}

function sourceBinding(sourceIndex, snapshotManifest, bytesById) {
  if (!sourceIndex || !Array.isArray(sourceIndex.sources) || typeof sourceIndex.revision !== 'string') {
    fail('DELIVERY_STALE', 'SourceIndex 输入不可用');
  }
  const fileByPath = new Map(snapshotManifest.files.map(file => [file.path, {
    ...file,
    fileRevisionSetDigest: snapshotManifest.fileRevisionSetDigest,
    content: bytesById?.get(file.fileId)?.toString('utf8') || null,
  }]));
  const itemDigests = [];
  const itemsById = new Map();
  let skipped = 0;
  for (const source of sourceIndex.sources) {
    const file = fileByPath.get(source.filePath);
    if (!file || source.revision !== file.revision) { skipped += 1; continue; }
    const locator = source.locator;
    const content = bytesById?.get(file.fileId)?.toString('utf8') || '';
    if (typeof source.contentSha256 !== 'string' || source.contentSha256 !== file.sha256) {
      fail('DELIVERY_STALE', `SourceIndex content digest 未绑定 snapshot: ${source.id}`);
    }
    const lineStart = content.lastIndexOf('\n', Math.max(0, locator?.offset || 0) - 1) + 1;
    const lineEndIndex = content.indexOf('\n', Math.max(0, locator?.offset || 0));
    const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex;
    const expectedQuote = content.slice(lineStart, lineEnd).trim().slice(0, 240);
    const endsAtLineBreak = Number.isSafeInteger(locator?.end) && locator.end === lineEnd + 1 && content[lineEnd] === '\n';
    if (!locator || !Number.isSafeInteger(locator.offset) || !Number.isSafeInteger(locator.end) || locator.offset < 0 || locator.end < locator.offset || locator.end > content.length || typeof locator.quote !== 'string' || locator.quote !== expectedQuote || (locator.end > lineEnd && !endsAtLineBreak) || (locator.end > locator.offset && !content.slice(locator.offset, Math.min(locator.end, lineEnd)))) {
      fail('DELIVERY_STALE', `SourceIndex locator 未绑定 snapshot: ${source.id}`);
    }
    const item = {
      schema: SOURCE_ITEM_SCHEMA,
      sourceId: source.id,
      fileId: file.fileId,
      revision: source.revision,
      contentSha256: file.sha256,
      displayUrl: source.metadata?.url || null,
      locatorDigest: evidenceSchema.digestObject(LOCATOR_SCHEMA, {
        schema: LOCATOR_SCHEMA,
        fileId: file.fileId,
        revision: source.revision,
        blockId: `title_${source.id}`,
        start: locator.offset,
        end: locator.end,
        quoteSha256: digestBytes(Buffer.from(locator.quote, 'utf8')),
      }),
    };
    schema.assertSourceItem(item, `source[${source.id}]`);
    itemsById.set(source.id, Object.freeze({ ...item, locator }));
    itemDigests.push({ sourceId: source.id, itemDigest: evidenceSchema.digestObject(SOURCE_ITEM_SCHEMA, item) });
  }
  itemDigests.sort((a, b) => compare(a.sourceId, b.sourceId));
  const binding = {
    schema: SOURCE_INDEX_BINDING_SCHEMA,
    snapshotId: snapshotManifest.snapshotId,
    fileRevisionSetDigest: snapshotManifest.fileRevisionSetDigest,
    inputDigest: sourceIndex.revision,
    itemDigests,
    partial: sourceIndex.status !== 'ready' || (sourceIndex.errors || []).length > 0 || skipped > 0,
  };
  schema.assertSourceIndexBinding(binding);
  return { sourceIndexRevision: evidenceSchema.digestObject(SOURCE_INDEX_BINDING_SCHEMA, binding), binding, fileByPath, itemsById };
}

function frontMatterEnd(content) {
  if (!(content.startsWith('---\n') || content.startsWith('---\r\n'))) return 0;
  const close = content.search(/\r?\n---(?:\r?\n|$)/u);
  if (close < 0) return 0;
  const newline = content.slice(close).search(/\r?\n/u);
  return newline < 0 ? content.length : close + newline + 1;
}

function tokenRaw(token) {
  if (!token || typeof token !== 'object') fail('DELIVERY_PARTIAL', 'Markdown token 缺少可信 raw 字段');
  const descriptor = Object.getOwnPropertyDescriptor(token, 'raw');
  if (!descriptor || typeof descriptor.value !== 'string' || descriptor.get || descriptor.set) {
    fail('DELIVERY_PARTIAL', 'Markdown token raw 字段不可验证');
  }
  return descriptor.value;
}

function tokenChildren(token) {
  const children = Array.isArray(token.tokens) ? token.tokens : Array.isArray(token.items) ? token.items : [];
  for (const child of children) tokenRaw(child);
  return children;
}

function childOffset(parentRaw, childRaw, from) {
  const direct = parentRaw.indexOf(childRaw, from);
  if (direct >= 0) return direct;
  // marked removes `> ` from blockquote child raw.  Resolve that offset from
  // the parent token instead of using a second Markdown parser or a regex.
  let normalized = '';
  const offsets = [];
  let lineStart = true;
  for (let index = 0; index < parentRaw.length; index += 1) {
    if (lineStart && parentRaw[index] === '>') {
      index += 1;
      if (parentRaw[index] === ' ') index += 1;
      if (index >= parentRaw.length) break;
    }
    normalized += parentRaw[index];
    offsets.push(index);
    lineStart = parentRaw[index] === '\n' || parentRaw[index] === '\r';
  }
  const found = normalized.indexOf(childRaw, normalized.slice(0, from).length);
  return found < 0 ? -1 : offsets[found];
}

function htmlState(raw, open) {
  if (!/^<\/?[A-Za-z]/u.test(raw) || /^<!(?:--|\[CDATA\[)/u.test(raw)) return open;
  if (/^<\//u.test(raw)) return false;
  if (/\/\s*>$/u.test(raw) || /^<(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(?:\s|>)/iu.test(raw)) return open;
  return true;
}

function markedTokenSpans(content) {
  let tokens;
  try { tokens = marked.lexer(content, { gfm: true, breaks: false, pedantic: false }); }
  catch (_) { fail('DELIVERY_PARTIAL', 'Markdown 语法无法由共享 parser 复现'); }
  const spans = [];
  const hiddenTypes = new Set(['code', 'codespan', 'image']);
  const frontEnd = frontMatterEnd(content);
  function visit(token, start, raw, inheritedHidden = false, inheritedHtml = false) {
    const type = typeof token.type === 'string' ? token.type : '';
    const hidden = inheritedHidden || inheritedHtml || hiddenTypes.has(type) || type === 'html' || start < frontEnd;
    spans.push({ type, start, end: start + raw.length, raw, hidden });
    const children = tokenChildren(token);
    let cursor = 0;
    let htmlOpen = inheritedHtml;
    for (const child of children) {
      const childRaw = tokenRaw(child);
      if (!childRaw) continue;
      const relative = childOffset(raw, childRaw, cursor);
      if (relative < 0 || start + relative + childRaw.length > content.length) {
        fail('DELIVERY_PARTIAL', 'Markdown token offset 无法绑定 snapshot');
      }
      const childType = typeof child.type === 'string' ? child.type : '';
      visit(child, start + relative, childRaw, hidden, htmlOpen);
      if (childType === 'html') htmlOpen = htmlState(childRaw, htmlOpen);
      cursor = relative + childRaw.length;
    }
  }
  let cursor = 0;
  for (const token of tokens) {
    const raw = tokenRaw(token);
    if (!raw) continue;
    if (cursor + raw.length > content.length) fail('DELIVERY_PARTIAL', 'Markdown token 超出 snapshot');
    visit(token, cursor, raw);
    cursor += raw.length;
  }
  if (cursor > content.length) fail('DELIVERY_PARTIAL', 'Markdown token 总长度超出 snapshot');
  return spans;
}

function parseFootnotes(content, file) {
  const references = [];
  const definitions = new Map();
  const spans = markedTokenSpans(content);
  const addDefinition = (match, absoluteOffset) => {
    const key = match[1];
    if (!FOOTNOTE_ID_RE.test(key)) return;
    const lineStart = content.lastIndexOf('\n', absoluteOffset - 1) + 1;
    const lineEndIndex = content.indexOf('\n', absoluteOffset);
    const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex;
    const line = content.slice(lineStart, lineEnd);
    const sourceIds = [...line.matchAll(FOOTNOTE_SOURCE_RE)].map(item => item[1]);
    const prior = definitions.get(key) || [];
    prior.push({ key, offset: absoluteOffset, end: absoluteOffset + match[0].length, sourceIds });
    definitions.set(key, prior);
  };
  const addReferences = (raw, absoluteOffset, type) => {
    if (type === 'link' && !/^\[\^[^\]\r\n]+\]$/u.test(raw)) return;
    FOOTNOTE_REF_RE.lastIndex = 0;
    for (const match of raw.matchAll(FOOTNOTE_REF_RE)) {
      const key = match[1];
      if (!FOOTNOTE_ID_RE.test(key)) continue;
      references.push({ key, offset: absoluteOffset + match.index, end: absoluteOffset + match.index + match[0].length });
    }
  };
  for (const span of spans) {
    if (span.hidden) continue;
    if (span.type !== 'def' && span.type !== 'text' && span.type !== 'link') continue;
    FOOTNOTE_DEF_RE.lastIndex = 0;
    for (const match of span.raw.matchAll(FOOTNOTE_DEF_RE)) addDefinition(match, span.start + match.index);
    addReferences(span.raw, span.start, span.type);
  }
  references.sort((a, b) => a.offset - b.offset || a.end - b.end);
  return { file, references, definitions };
}

function visibleMarkdown(content) {
  let tokens;
  try { tokens = marked.lexer(content, { gfm: true, breaks: false, pedantic: false }); }
  catch (_) { fail('DELIVERY_PARTIAL', 'Markdown 语法无法由共享 parser 复现'); }
  const chars = content.split('');
  function mask(start, length) {
    for (let index = start; index < start + length && index < chars.length; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  }
  function visit(token, start, raw) {
    if (!token || typeof token !== 'object') return;
    if (token.type === 'code' || token.type === 'codespan' || token.type === 'html' || token.type === 'image') mask(start, raw.length);
    const children = Array.isArray(token.tokens) ? token.tokens : Array.isArray(token.items) ? token.items : [];
    function locate(childRaw, from) {
      const direct = raw.indexOf(childRaw, from);
      if (direct >= 0) return direct;
      // marked removes the `> ` quote prefix from nested token.raw. Build a
      // bounded offset map so nested fenced/html tokens still mask source
      // bytes without falling back to an independent Markdown regex parser.
      let normalized = '';
      const offsets = [];
      let lineStart = true;
      for (let index = 0; index < raw.length; index += 1) {
        if (lineStart && raw[index] === '>') {
          index += 1;
          if (raw[index] === ' ') index += 1;
          if (index >= raw.length) break;
        }
        normalized += raw[index];
        offsets.push(index);
        lineStart = raw[index] === '\n' || raw[index] === '\r';
      }
      const normalizedFrom = normalized.slice(0, from).length;
      const found = normalized.indexOf(childRaw, normalizedFrom);
      return found < 0 ? -1 : offsets[found];
    }
    let cursor = 0;
    for (const child of children) {
      const childRaw = typeof child?.raw === 'string' ? child.raw : '';
      if (!childRaw) continue;
      const relative = locate(childRaw, cursor);
      if (relative < 0) continue;
      visit(child, start + relative, childRaw);
      cursor = relative + childRaw.length;
    }
  }
  let cursor = 0;
  for (const token of tokens) {
    const raw = typeof token.raw === 'string' ? token.raw : '';
    if (raw) visit(token, cursor, raw);
    cursor += raw.length;
  }
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const close = content.search(/\r?\n---(?:\r?\n|$)/u);
    if (close >= 0) {
      const end = close + content.slice(close).search(/\r?\n/u) + 1;
      for (let index = 0; index < end && index < chars.length; index += 1) {
        if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
      }
    }
  }
  return chars.join('');
}

function visibleMarker(content, file) {
  const visible = visibleMarkdown(content);
  try {
    const analyzed = require('./consistency-engine').analyzeProject([{
      path: file?.path || 'delivery.md',
      revision: file?.revision || 'a'.repeat(64),
      content: visible,
    }], { capturedAt: '1970-01-01T00:00:00.000Z' });
    const evidence = analyzed.evidence.find(item => analyzed.issues.some(issue =>
      issue.type === 'evidence_gap' && issue.evidenceIds?.includes(item.id)));
    return evidence ? { index: evidence.start, length: evidence.end - evidence.start } : null;
  } catch (_) {
    fail('DELIVERY_PARTIAL', '共享 consistency marker authority 无法复现');
  }
}

function locatorDigest(file, start, end, quote) {
  return evidenceSchema.digestObject(LOCATOR_SCHEMA, {
    schema: LOCATOR_SCHEMA,
    fileId: file.fileId,
    revision: file.revision,
    blockId: `delivery_${file.fileId}_${start}`,
    start, end,
    quoteSha256: digestBytes(Buffer.from(quote, 'utf8')),
  });
}

function buildManifestFootnotes(selected) {
  const result = [];
  const notesByFile = selected.map(item => ({ item, notes: parseFootnotes(item.content, item.file) }));
  const definitionsByKey = new Map();
  const referencesByKey = new Map();
  for (const { item, notes } of notesByFile) {
    for (const [key, definitions] of notes.definitions) {
      const all = definitionsByKey.get(key) || [];
      for (const definition of definitions) all.push({ ...definition, item });
      definitionsByKey.set(key, all);
    }
    for (const reference of notes.references) {
      const all = referencesByKey.get(reference.key) || [];
      all.push({ ...reference, item });
      referencesByKey.set(reference.key, all);
    }
  }
  for (const [key, definitions] of definitionsByKey) {
    const references = referencesByKey.get(key) || [];
    if (references.length === 0 || definitions.length !== 1) continue;
    const definition = definitions[0];
    result.push({
      footnoteId: evidenceSchema.digestObject('writcraft.delivery-footnote-id/v1', {
        schema: 'writcraft.delivery-footnote-id/v1', fileId: definition.item.file.fileId, key,
      }),
      key,
      definitionFileId: definition.item.file.fileId,
      definitionLocatorDigest: locatorDigest(definition.item.file, definition.offset, definition.end, definition.item.content.slice(definition.offset, definition.end)),
      referenceLocatorDigests: references.map(reference => locatorDigest(reference.item.file, reference.offset, reference.end, reference.item.content.slice(reference.offset, reference.end))),
      sourceId: definition.sourceIds.length === 1 ? definition.sourceIds[0] : null,
    });
  }
  return result;
}

function issueSummary(item) {
  return {
    issueId: item.healthId,
    reasonCode: item.reasonCode,
    subjectId: item.subjectId,
    evidenceIds: item.evidence.map(evidence => evidence.evidenceId),
  };
}

function evidenceLocatorDigest(evidence) {
  return evidenceSchema.digestObject('writcraft.delivery-evidence-locator/v1', {
    schema: 'writcraft.delivery-evidence-locator/v1',
    fileId: evidence.fileId, revision: evidence.revision, blockId: evidence.blockId,
    start: evidence.start, end: evidence.end,
    quoteSha256: evidence.quoteSha256, contentSha256: evidence.contentSha256,
  });
}

function resourceIssueSummary(item) {
  return {
    issueId: item.resourceId,
    reasonCode: item.reasonCode,
    subjectId: item.fileId,
    evidenceIds: [],
  };
}

function publicHealthItem(item, selectedById, fileById = selectedById) {
  return {
    healthId: item.healthId,
    type: item.type,
    severity: item.severity,
    reasonCode: item.reasonCode,
    subjectLabel: selectedById.get(item.subjectId)?.path || fileById.get(item.subjectId)?.path || item.subjectId || item.type,
    evidenceSummaries: item.evidence.map(evidence => ({
      fileId: evidence.fileId,
      displayPath: selectedById.get(evidence.fileId)?.path || fileById.get(evidence.fileId)?.path || evidence.fileId,
      locatorDigest: evidenceLocatorDigest(evidence),
    })),
    nextAction: item.nextAction,
  };
}

function healthRootDigest(item) {
  const footnoteMatch = item.type === 'broken_footnote' && typeof item.subjectLabel === 'string'
    ? /^\[\^([^\]]+)\]$/u.exec(item.subjectLabel)
    : null;
  return evidenceSchema.digestObject(schema.SCHEMAS.CITATION_HEALTH_ROOT, {
    schema: schema.SCHEMAS.CITATION_HEALTH_ROOT,
    snapshotId: item.snapshotId,
    type: item.type,
    subjectId: item.subjectId,
    footnoteKey: footnoteMatch ? footnoteMatch[1] : null,
    reasonCode: item.reasonCode,
  });
}

function buildMediaManifest(selected, parsed, bytesById, decodeImage, decodeImageEntry) {
  const selectedIds = new Set(selected.map(item => item.file.fileId));
  const selectedById = new Map(selected.map(item => [item.file.fileId, item]));
  const images = [];
  const resources = [];
  function tokenAtOrdinal(content, ordinal) {
    let index = 0;
    let found = null;
    let tokens;
    try { tokens = marked.lexer(content, { gfm: true, breaks: false, pedantic: false }); }
    catch (_) { return null; }
    marked.walkTokens(tokens, token => {
      if (index === ordinal && !found) found = token;
      index += 1;
    });
    return found;
  }
  function pngSize(bytes) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
    function crc32(value) {
      let crc = 0xffffffff;
      for (const byte of value) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const bitDepth = bytes[24];
    const colorType = bytes[25];
    const interlace = bytes[28];
    if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) return null;
    let offset = 8;
    let hasIHDR = false;
    let hasIDAT = false;
    let hasIEND = false;
    const idatParts = [];
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (length > 64 * 1024 * 1024 || end > bytes.length) return null;
      const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
      if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expectedCrc) return null;
      if (type === 'IHDR') {
        if (hasIHDR || length !== 13 || offset !== 8) return null;
        hasIHDR = true;
      } else if (type === 'IDAT') { hasIDAT = true; idatParts.push(data); }
      else if (type === 'IEND') {
        if (length !== 0 || hasIEND) return null;
        hasIEND = true;
        if (end !== bytes.length) return null;
        break;
      }
      offset = end;
    }
    if (!hasIHDR || !hasIDAT || !hasIEND) return null;
    // ImageIO is intentionally still the production pixel decoder, but it
    // may accept a recoverable PNG stream after a damaged IDAT. Inflate the
    // exact IDAT stream here so a CRC-valid yet truncated/corrupt payload
    // cannot pass the structural preflight before the native draw boundary.
    try {
      const inflated = zlib.inflateSync(Buffer.concat(idatParts));
      if (interlace === 0 && [0, 2, 3, 4, 6].includes(colorType) && [1, 2, 4, 8, 16].includes(bitDepth)) {
        const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
        const rowBytes = Math.ceil(width * channels * bitDepth / 8);
        if (inflated.length !== (rowBytes + 1) * height) return null;
      } else if (inflated.length < height) return null;
    } catch (_) { return null; }
    return { width, height };
  }
  function jpegSize(bytes) {
    if (!bytes || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    let width = 0;
    let height = 0;
    let frameCount = 0;
    let sawScan = false;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return null;
      const marker = bytes[offset++];
      if (marker === 0xd9) return width && height ? { width, height } : null;
      if (marker === 0xda) { sawScan = true; break; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      const isFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isFrame) {
        frameCount += 1;
        if (frameCount !== 1) return null;
        if (length < 7) return null;
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) return null;
      }
      offset += length;
    }
    if (!sawScan || frameCount !== 1 || !width || !height) return null;
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
    for (let index = offset; index < bytes.length - 2; index += 1) {
      if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) return null;
    }
    return { width, height };
  }
  for (const file of parsed.manifest.files) {
    if (file.kind !== 'image') continue;
    const refs = file.references.filter(reference => selectedIds.has(reference.fromFileId));
    if (!refs.length) continue;
    const extension = file.path.split('.').pop().toLowerCase();
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
    const referenceTokens = refs.map(reference => {
      const owner = selectedById.get(reference.fromFileId);
      const token = owner ? tokenAtOrdinal(owner.content, reference.tokenOrdinal) : null;
      return { reference, token };
    });
    const firstReference = refs[0];
    const token = referenceTokens[0]?.token || null;
    const alt = token && token.type === 'image' && typeof token.text === 'string' && token.text ? token.text : null;
    const caption = token && token.type === 'image' && typeof token.title === 'string' && token.title ? token.title : null;
    const tokenMissing = referenceTokens.some(({ token: candidate }) => !candidate || candidate.type !== 'image');
    const referenceMetadataMissing = referenceTokens.some(({ token: candidate }) =>
      !candidate || candidate.type !== 'image' || typeof candidate.text !== 'string' || !candidate.text ||
      typeof candidate.title !== 'string' || !candidate.title);
    const imageId = evidenceSchema.digestObject('writcraft.delivery-image-id/v1', { schema: 'writcraft.delivery-image-id/v1', fileId: file.fileId, sha256: file.sha256 });
    let pixelWidth = 0;
    let pixelHeight = 0;
    let status = 'warning';
    let reasonCode = 'IMAGE_ALT_OR_CAPTION_MISSING';
    const bytes = bytesById.get(file.fileId);
    if (tokenMissing) { status = 'blocker'; reasonCode = 'IMAGE_TOKEN_UNAVAILABLE'; }
    else if (!['png', 'jpg', 'jpeg'].includes(extension)) { status = 'blocker'; reasonCode = 'UNSUPPORTED_DELIVERY_IMAGE_FORMAT'; }
    else if (extension === 'png') {
      const size = pngSize(bytes || Buffer.alloc(0));
      if (!size) { status = 'blocker'; reasonCode = 'IMAGE_DECODE_INVALID'; }
      else { pixelWidth = size.width; pixelHeight = size.height; }
    }
    else if (extension === 'jpg' || extension === 'jpeg') {
      const size = jpegSize(bytes);
      if (!size) {
        status = 'blocker'; reasonCode = 'IMAGE_DECODE_INVALID';
      } else { pixelWidth = size.width; pixelHeight = size.height; }
    }
    if (status !== 'blocker' && typeof decodeImageEntry === 'function') {
      try {
        const binding = parsed.bindings.find(item => item.fileId === file.fileId);
        const headerBytes = Buffer.from(evidenceSchema.canonicalJson(snapshotBundle.entryHeader(file)), 'utf8');
        const decoded = decodeImageEntry({ binding, headerBytes, contentSha256: file.sha256, mimeType });
        if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) ||
            decoded.contentSha256 !== file.sha256 || decoded.width !== pixelWidth || decoded.height !== pixelHeight ||
            decoded.width < 1 || decoded.height < 1 || decoded.width > 16384 || decoded.height > 16384 ||
            decoded.width * decoded.height > 40000000) {
          status = 'blocker';
          reasonCode = 'IMAGE_DECODE_INVALID';
        }
      } catch (_) {
        status = 'blocker';
        reasonCode = 'IMAGE_DECODE_INVALID';
      }
    } else if (status !== 'blocker' && typeof decodeImage === 'function') {
      try {
        const decoded = decodeImage(bytes, mimeType);
        if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) ||
            decoded.contentSha256 !== file.sha256 ||
            decoded.width !== pixelWidth || decoded.height !== pixelHeight ||
            decoded.width < 1 || decoded.height < 1 || decoded.width > 16384 || decoded.height > 16384 ||
            decoded.width * decoded.height > 40000000) {
          status = 'blocker';
          reasonCode = 'IMAGE_DECODE_INVALID';
        }
      } catch (_) {
        status = 'blocker';
        reasonCode = 'IMAGE_DECODE_INVALID';
      }
    }
    images.push({ imageId, fileId: file.fileId, sha256: file.sha256, byteLength: file.byteLength, mimeType, pixelWidth, pixelHeight, alt, caption, referenceLocatorDigests: refs.map(reference => reference.locatorDigest) });
    if (status === 'warning' && !referenceMetadataMissing) status = null;
    if (status) resources.push({
      resourceId: evidenceSchema.digestObject('writcraft.delivery-resource-id/v1', { schema: 'writcraft.delivery-resource-id/v1', fileId: file.fileId, kind: 'image' }),
      kind: 'image', status, reasonCode, fileId: file.fileId,
      locatorDigest: refs[0].locatorDigest,
    });
  }
  return { images, resources };
}

function buildSyntaxCoverage(selected) {
  const supportedCounts = {};
  const warningCounts = {};
  const unsupportedCounts = {};
  let tokenCount = 0;
  for (const item of selected) {
    let tokens;
    try { tokens = marked.lexer(item.content, { gfm: true, breaks: false, pedantic: false }); }
    catch (_) { fail('DELIVERY_PARTIAL', 'Markdown 语法无法由共享 parser 复现'); }
    marked.walkTokens(tokens, token => {
      tokenCount += 1;
      const type = token.type || 'unknown';
      const supported = new Set(['space', 'heading', 'paragraph', 'text', 'strong', 'em', 'del', 'codespan', 'br', 'code', 'blockquote', 'list', 'list_item', 'link', 'image', 'table', 'hr', 'checkbox']);
      if (supported.has(type)) supportedCounts[type] = (supportedCounts[type] || 0) + 1;
      else if (type === 'html') warningCounts[type] = (warningCounts[type] || 0) + 1;
      else unsupportedCounts.UNSUPPORTED_MARKDOWN_SYNTAX = (unsupportedCounts.UNSUPPORTED_MARKDOWN_SYNTAX || 0) + 1;
    });
  }
  return { parserId: MARKED_PARSER_ID, tokenCount, supportedCounts, warningCounts, unsupportedCounts };
}

function createHealth({ type, reasonCode, snapshotId, subjectId = null, subjectLabel, file, start = 0, end = 0, quote = '', evidenceIds = [], evidenceAuthority = null, locatorAuthority = null, locatorDigestOverride = null, nextAction }) {
  const effectiveStart = Number.isSafeInteger(locatorAuthority?.start) ? locatorAuthority.start : start;
  const effectiveEnd = Number.isSafeInteger(locatorAuthority?.end) ? locatorAuthority.end : end;
  const effectiveQuote = typeof locatorAuthority?.quote === 'string' ? locatorAuthority.quote : quote;
  const evidence = [];
  if (file && effectiveEnd > effectiveStart) {
    const effectiveEvidenceIds = evidenceIds.length ? evidenceIds : [`evidence_${evidenceSchema.digestObject('writcraft.delivery-evidence-id/v1', {
      schema: 'writcraft.delivery-evidence-id/v1', snapshotId, fileId: file.fileId, revision: file.revision,
      start: effectiveStart, end: effectiveEnd, quoteSha256: digestBytes(Buffer.from(effectiveQuote, 'utf8')),
    }).slice(-32)}`];
    let blockId = `delivery_${file.fileId}_${start}`;
    let contentSha256 = file.sha256;
    if (typeof file.content === 'string') {
      try {
        const anchor = blockAnchor.createBlockAnchor(file.content, file.path, effectiveStart, effectiveEnd);
        blockId = anchor.id;
        const block = blockAnchor.parseBlocks(file.content, file.path).find(item => effectiveStart >= item.start && effectiveEnd <= item.end);
        if (block) contentSha256 = digestBytes(Buffer.from(block.text, 'utf8'));
      } catch (_) {}
    }
    const authorityById = new Map();
    for (const item of Array.isArray(evidenceAuthority) ? evidenceAuthority : evidenceAuthority ? [evidenceAuthority] : []) {
      if (item && typeof item.id === 'string') authorityById.set(item.id, item);
    }
    for (const evidenceId of [...new Set(effectiveEvidenceIds)].sort(compare)) {
      const authoritative = authorityById.get(evidenceId);
      const authoritativeQuote = authoritative && typeof authoritative.quote === 'string' ? authoritative.quote : effectiveQuote;
      evidence.push({
        evidenceId,
        fileId: file.fileId,
        revision: authoritative?.revision || file.revision,
        blockId: authoritative?.blockId || locatorAuthority?.blockId || blockId,
        start: Number.isSafeInteger(authoritative?.start) ? authoritative.start : effectiveStart,
        end: Number.isSafeInteger(authoritative?.end) ? authoritative.end : effectiveEnd,
        quoteSha256: authoritativeQuote ? digestBytes(Buffer.from(authoritativeQuote, 'utf8')) : digestBytes(Buffer.from(effectiveQuote, 'utf8')),
        contentSha256: authoritative?.contentHash || contentSha256,
      });
    }
  }
  const healthId = schema.healthId(type, snapshotId, subjectId, evidence.map(item => item.evidenceId), reasonCode);
  if (evidence.length === 0) fail('DELIVERY_STALE', 'health item 缺少可复现 locator');
  return freeze({
    schema: schema.SCHEMAS.CITATION_HEALTH_ITEM,
    healthId,
    type,
    severity: schema.BLOCKER_REASONS.has(reasonCode) ? 'blocker' : 'warning',
    reasonCode,
    snapshotId,
    revisionBinding: {
      fileRevisionSetDigest: file?.fileRevisionSetDigest || null,
      subjectRevision: file?.revision || null,
      locatorDigest: locatorDigestOverride || (file && effectiveEnd > effectiveStart ? locatorDigest(file, effectiveStart, effectiveEnd, effectiveQuote) : null),
      quoteSha256: file && effectiveEnd > effectiveStart ? digestBytes(Buffer.from(effectiveQuote, 'utf8')) : null,
    },
    evidence,
    subjectId,
    nextAction,
  });
}

function aggregateHealth(items) {
  const groups = new Map();
  for (const item of items) {
    // Bind aggregation to the frozen citation-health-root/v1 payload.  In
    // particular, two footnote keys in the same file must remain distinct,
    // while multiple evidence locators for one root merge into one issue.
    const key = healthRootDigest(item);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...item, evidence: [...item.evidence] });
      continue;
    }
    const byId = new Map(existing.evidence.map(entry => [entry.evidenceId, entry]));
    for (const evidence of item.evidence) byId.set(evidence.evidenceId, evidence);
    existing.evidence = [...byId.values()].sort((left, right) => compare(left.evidenceId, right.evidenceId));
  }
  return [...groups.values()].map(item => ({
    ...item,
    healthId: schema.healthId(item.type, item.snapshotId, item.subjectId, item.evidence.map(entry => entry.evidenceId), item.reasonCode),
  }));
}

function contentMap(bundle, parsed) {
  const byId = new Map();
  for (const binding of parsed.bindings) {
    byId.set(binding.fileId, bundle.subarray(binding.contentOffset, binding.contentOffset + binding.contentLength));
  }
  return byId;
}

function validateGraphEvidence(graph, parsed, bytesById) {
  const fileByPath = new Map(parsed.manifest.files.map(file => [file.path, file]));
  const evidenceById = new Map();
  for (const evidence of graph.evidence || []) {
    if (evidenceById.has(evidence.id)) fail('DELIVERY_STALE', 'Graph evidence ID 重复');
    const file = fileByPath.get(evidence.path);
    if (!file) fail('DELIVERY_STALE', 'Graph evidence path 未绑定 snapshot');
    if (typeof evidence.id !== 'string' || !evidence.id || typeof evidence.revision !== 'string') fail('DELIVERY_STALE', 'Graph evidence identity 无效');
    evidenceById.set(evidence.id, evidence);
    if (evidence.revision !== file.revision) {
      const currentContent = bytesById.get(file.fileId)?.toString('utf8') || '';
      if (currentContent.length === 0) fail('DELIVERY_STALE', 'Graph evidence 无法绑定空 snapshot 文件 locator');
      continue;
    }
    if (typeof evidence.blockId !== 'string' || !/^blk_[a-f0-9]{16}$/u.test(evidence.blockId) || typeof evidence.contentHash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(evidence.contentHash)) {
      fail('DELIVERY_STALE', 'Graph evidence block/digest authority 缺失');
    }
    if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.start >= evidence.end) {
      fail('DELIVERY_STALE', 'Graph evidence locator 无效');
    }
    const content = bytesById.get(file.fileId)?.toString('utf8');
    if (typeof content !== 'string' || evidence.end > content.length || content.slice(evidence.start, evidence.end) !== evidence.quote) continue;
    let blocks;
    try { blocks = blockAnchor.parseBlocks(content, file.path); } catch (_) { fail('DELIVERY_STALE', 'Graph evidence block authority 无法复现'); }
    const block = blocks.find(item => evidence.start >= item.start && evidence.end <= item.end);
    if (!block || digestBytes(Buffer.from(block.text, 'utf8')) !== evidence.contentHash) continue;
    const duplicateOrdinal = blocks.filter(item => item.start <= block.start && item.headingKey === block.headingKey && item.type === block.type && item.fingerprint === block.fingerprint).length;
    const expectedBlockId = `blk_${crypto.createHash('sha256').update(`${file.path}\0${block.headingKey}\0${block.type}\0${block.fingerprint}\0${duplicateOrdinal}`, 'utf8').digest('hex').slice(0, 16)}`;
    if (expectedBlockId !== evidence.blockId) continue;
  }
  return { evidenceById, fileByPath };
}

function validateGraphSourceIndexCrossBinding(graphBinding, graph, sourceIndex, fileByPath, evidenceById) {
  const sourcesById = new Map((sourceIndex.sources || []).map(source => [source.id, source]));
  for (const binding of graphBinding.sourceBindings) {
    const source = sourcesById.get(binding.sourceId);
    const evidence = evidenceById.get(binding.evidenceId);
    if (!source || !evidence) fail('DELIVERY_STALE', 'Graph source binding 缺少 SourceIndex/evidence authority');
    const file = fileByPath.get(source.filePath);
    if (!file || source.revision !== file.revision || evidence.path !== source.filePath || evidence.revision !== source.revision) {
      fail('DELIVERY_STALE', 'Graph source binding 未绑定同一 revision');
    }
  }
  return graph;
}

function createDeliveryPreflightService(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const issueCapability = typeof options.issueDeliveryCapability === 'function'
    ? options.issueDeliveryCapability : null;
  const decodeImage = typeof options.decodeImage === 'function' ? options.decodeImage : null;
  const decodeImageEntry = typeof options.decodeImageEntry === 'function' ? options.decodeImageEntry : null;

  function preflight(input) {
    if (!input || !Buffer.isBuffer(input.snapshot?.bundle)) fail('DELIVERY_BLOCKED', 'snapshot bundle 缺失');
    const request = schema.assertPreflightRequest(input.request);
    const parsed = snapshotBundle.parseBundle(input.snapshot.bundle);
    if (parsed.manifest.projectInstanceId !== request.projectInstanceId || parsed.manifest.snapshotId !== request.snapshotId) {
      fail('DELIVERY_STALE', 'snapshot 与请求不匹配');
    }
    const bytesById = contentMap(input.snapshot.bundle, parsed);
    const graphEvidence = validateGraphEvidence(input.graph, parsed, bytesById);
    const graph = graphManifest(input.graph, parsed.manifest);
    const source = sourceBinding(input.sourceIndex, parsed.manifest, bytesById);
    validateGraphSourceIndexCrossBinding(graph.binding, input.graph, input.sourceIndex, graphEvidence.fileByPath, graphEvidence.evidenceById);
    const indexedSourceIds = new Set((input.sourceIndex.sources || []).map(item => item.id));
    if (graph.binding.sourceBindings.some(item => !indexedSourceIds.has(item.sourceId))) {
      fail('DELIVERY_STALE', 'Graph source binding 未绑定当前 SourceIndex');
    }
    const authority = schema.buildAuthority({
      projectInstanceId: request.projectInstanceId,
      snapshotId: request.snapshotId,
      snapshotManifestDigest: parsed.manifest.snapshotManifestDigest,
      creationMutationGeneration: parsed.manifest.creationMutationGeneration,
      fileRevisionSetDigest: parsed.manifest.fileRevisionSetDigest,
      graphIdentity: graph.graphIdentity,
      graphManifestDigest: graph.graphManifestDigest,
      sourceIndexRevision: source.sourceIndexRevision,
    });
    const files = parsed.manifest.files.map(file => ({ ...file, fileRevisionSetDigest: parsed.manifest.fileRevisionSetDigest, content: bytesById.get(file.fileId)?.toString('utf8') || null }));
    const byId = new Map(files.map(file => [file.fileId, file]));
    const fileByPath = new Map(files.map(file => [file.path, file]));
    const sourceItems = input.sourceIndex.sources || [];
    const selected = request.orderedFiles.map((item, order) => {
      const file = byId.get(item.fileId);
      if (!file || file.kind !== 'markdown' || file.path === 'edit.md') fail('DELIVERY_BLOCKED', '选择的正文文件无效');
      return { fileId: file.fileId, displayPath: file.path, order, file, content: bytesById.get(file.fileId).toString('utf8') };
    });
    if (!selected.length) fail('DELIVERY_BLOCKED', '至少选择一个正文文件');
    const selectedIds = new Set(selected.map(item => item.fileId));
    const media = buildMediaManifest(
      selected, parsed, bytesById, decodeImage,
      decodeImageEntry || (typeof input.snapshot.decodeImageEntry === 'function' ? input.snapshot.decodeImageEntry : null)
    );
    const mediaWarnings = media.resources.filter(item => item.status === 'warning');
    const mediaBlockers = media.resources.filter(item => item.status === 'blocker');
    const syntaxCoverage = buildSyntaxCoverage(selected);
    const syntaxWarnings = Object.entries(syntaxCoverage.warningCounts).map(([type, count]) => ({
      resourceId: evidenceSchema.digestObject('writcraft.delivery-syntax-warning-id/v1', { schema: 'writcraft.delivery-syntax-warning-id/v1', type, count, snapshotId: request.snapshotId }),
      reasonCode: 'UNSUPPORTED_MARKDOWN_SYNTAX', fileId: selected[0]?.file.fileId || null,
    }));
    const outline = [];
    const health = [];
    const footnoteNotes = selected.map(item => ({ item, notes: parseFootnotes(item.content, item.file) }));
    const definitionsByKey = new Map();
    for (const { item, notes } of footnoteNotes) {
      for (const [key, definitions] of notes.definitions) {
        const all = definitionsByKey.get(key) || [];
        for (const definition of definitions) all.push({ ...definition, file: item.file, content: item.content });
        definitionsByKey.set(key, all);
      }
    }
    for (const item of selected) {
      let markdownTokens;
      try { markdownTokens = marked.lexer(item.content, { gfm: true, breaks: false, pedantic: false }); }
      catch (_) { fail('DELIVERY_PARTIAL', 'Markdown 语法无法由共享 parser 复现'); }
      const headings = [];
      marked.walkTokens(markdownTokens, token => {
        if (token.type === 'heading') headings.push(token);
      });
      for (const heading of headings) {
        if (outline.length >= MAX_OUTLINE) fail('DELIVERY_PARTIAL', '标题目录超限');
        const text = String(heading.text || '').trim();
        outline.push({
          outlineId: evidenceSchema.digestObject('writcraft.delivery-outline-id/v1', {
            schema: 'writcraft.delivery-outline-id/v1', fileId: item.fileId, ordinal: outline.length,
          }),
          fileId: item.fileId, level: heading.depth, text, ordinal: outline.length,
        });
      }
      const markerMatch = visibleMarker(item.content, item.file);
      if (markerMatch) {
        health.push(createHealth({ type: 'missing_source', reasonCode: 'EXPLICIT_SOURCE_NEEDED_MARKER', snapshotId: request.snapshotId, subjectId: item.fileId, subjectLabel: item.file.path, file: item.file, start: markerMatch.index, end: markerMatch.index + markerMatch.length, quote: item.content.slice(markerMatch.index, markerMatch.index + markerMatch.length), nextAction: 'ADD_SOURCE' }));
      }
      const notes = footnoteNotes.find(entry => entry.item.fileId === item.fileId).notes;
      for (const reference of notes.references) {
        const definitions = definitionsByKey.get(reference.key) || [];
        if (!definitions.length) health.push(createHealth({ type: 'broken_footnote', reasonCode: 'REFERENCE_MISSING_DEFINITION', snapshotId: request.snapshotId, subjectId: item.fileId, subjectLabel: `[^${reference.key}]`, file: item.file, start: reference.offset, end: reference.end, quote: item.content.slice(reference.offset, reference.end), nextAction: 'FIX_FOOTNOTE' }));
        else if (definitions.length > 1) health.push(createHealth({ type: 'broken_footnote', reasonCode: 'DEFINITION_DUPLICATE', snapshotId: request.snapshotId, subjectId: item.fileId, subjectLabel: `[^${reference.key}]`, file: item.file, start: reference.offset, end: reference.end, quote: item.content.slice(reference.offset, reference.end), nextAction: 'FIX_FOOTNOTE' }));
        else if (definitions[0].sourceIds.length !== 1 || !sourceItems.some(sourceItem => sourceItem.id === definitions[0].sourceIds[0])) {
          health.push(createHealth({ type: 'broken_footnote', reasonCode: definitions[0].sourceIds.length > 1 ? 'REFERENCE_AMBIGUOUS' : 'SOURCE_ID_UNBOUND', snapshotId: request.snapshotId, subjectId: item.fileId, subjectLabel: `[^${reference.key}]`, file: item.file, start: reference.offset, end: reference.end, quote: item.content.slice(reference.offset, reference.end), nextAction: 'FIX_FOOTNOTE' }));
        }
      }
      for (const [key, definitions] of notes.definitions) {
        if (!notes.references.some(reference => reference.key === key)) health.push(createHealth({ type: 'broken_footnote', reasonCode: 'DEFINITION_UNUSED', snapshotId: request.snapshotId, subjectId: item.fileId, subjectLabel: `[^${key}]`, file: item.file, start: definitions[0].offset, end: definitions[0].end, quote: item.content.slice(definitions[0].offset, definitions[0].end), nextAction: 'FIX_FOOTNOTE' }));
      }
    }
    const evidenceById = new Map((input.graph.evidence || []).map(item => [item.id, item]));
    const validEvidenceById = new Map();
    for (const evidence of evidenceById.values()) {
      const file = fileByPath.get(evidence.path);
      const content = file ? bytesById.get(file.fileId).toString('utf8') : null;
      if (!file || !REVISION_RE.test(evidence.revision || '') || evidence.revision !== file.revision) {
        if (!file) fail('DELIVERY_STALE', 'Graph evidence 未绑定 snapshot 文件');
        const currentEnd = Math.min(content.length, 1);
        health.push(createHealth({ type: 'stale_locator', reasonCode: 'GRAPH_EVIDENCE_REVISION_STALE', snapshotId: request.snapshotId, subjectId: evidence.id, subjectLabel: evidence.path || evidence.id, file, start: 0, end: currentEnd, quote: content.slice(0, currentEnd), nextAction: 'REVIEW_LOCATOR' }));
      } else if (typeof content !== 'string' || content.slice(evidence.start, evidence.end) !== evidence.quote) {
        const currentContent = typeof content === 'string' ? content : '';
        const currentEnd = Math.min(currentContent.length, 1);
        health.push(createHealth({ type: 'stale_locator', reasonCode: 'GRAPH_EVIDENCE_QUOTE_STALE', snapshotId: request.snapshotId, subjectId: evidence.id, subjectLabel: evidence.path || evidence.id, file, start: 0, end: currentEnd, quote: currentContent.slice(0, currentEnd), nextAction: 'REVIEW_LOCATOR' }));
      } else {
        validEvidenceById.set(evidence.id, evidence);
      }
    }
    for (const issue of input.graph.issues || []) {
      if (issue.type !== 'evidence_gap' || issue.status === 'resolved' || issue.status === 'dismissed') continue;
        const file = fileByPath.get(issue.filePath);
      const issueEvidence = (issue.evidenceIds || []).map(id => validEvidenceById.get(id)).find(item => item && fileByPath.get(item.path));
      const issueFile = issueEvidence ? fileByPath.get(issueEvidence.path) : file;
      if (!issueFile) fail('DELIVERY_STALE', 'Graph evidence gap 未绑定 snapshot 文件');
      const issueContent = bytesById.get(issueFile.fileId)?.toString('utf8') || '';
      const issueEnd = issueEvidence?.end || Math.min(issueContent.length, 1);
      health.push(createHealth({ type: 'missing_source', reasonCode: 'CLAIM_WITHOUT_SOURCE_BINDING', snapshotId: request.snapshotId, subjectId: issue.id, subjectLabel: issue.title || issue.id, file: issueFile, start: issueEvidence?.start || 0, end: issueEnd, quote: issueEvidence?.quote || issueContent.slice(0, issueEnd), nextAction: 'ADD_SOURCE', evidenceIds: issueEvidence ? [issueEvidence.id] : [], evidenceAuthority: issueEvidence }));
    }
    for (const node of input.graph.nodes || []) {
      if (node.type !== 'claim') continue;
      const evidenceIds = [...new Set(node.evidenceIds || [])].filter(id => validEvidenceById.has(id));
      const hasSourceBinding = graph.binding.sourceBindings.some(item => item.graphNodeId === node.id);
      if (!hasSourceBinding) {
        if (evidenceIds.length === 0) fail('DELIVERY_STALE', 'Graph claim 缺少可定位的来源证据');
        const claimEvidence = validEvidenceById.get(evidenceIds[0]);
        const claimFile = fileByPath.get(claimEvidence.path);
        health.push(createHealth({ type: 'missing_source', reasonCode: 'CLAIM_WITHOUT_SOURCE_BINDING', snapshotId: request.snapshotId, subjectId: node.id, subjectLabel: node.label || node.id, file: claimFile, start: claimEvidence.start, end: claimEvidence.end, quote: claimEvidence.quote, nextAction: 'ADD_SOURCE', evidenceIds: [claimEvidence.id], evidenceAuthority: claimEvidence }));
      }
      if (evidenceIds.length === 1) {
        const graphEvidence = validEvidenceById.get(evidenceIds[0]);
        const file = fileByPath.get(graphEvidence.path);
        health.push(createHealth({ type: 'single_evidence', reasonCode: 'CLAIM_SINGLE_VALID_EVIDENCE', snapshotId: request.snapshotId, subjectId: node.id, subjectLabel: node.label || node.id, file, start: graphEvidence.start, end: graphEvidence.end, quote: graphEvidence.quote || '', nextAction: 'ADD_EVIDENCE', evidenceIds, evidenceAuthority: graphEvidence }));
      }
    }
    const sources = input.sourceIndex.sources || [];
    const byUrl = new Map();
    const byContent = new Map();
    for (const sourceItem of sources) {
      const file = source.fileByPath.get(sourceItem.filePath);
      const sourceAuthority = source.itemsById.get(sourceItem.id);
      const sourceLocator = sourceAuthority?.locator || null;
      const sourceEvidenceId = sourceAuthority
        ? `source_evidence_${evidenceSchema.digestObject('writcraft.delivery-source-evidence-id/v1', {
          schema: 'writcraft.delivery-source-evidence-id/v1', sourceId: sourceItem.id,
          locatorDigest: sourceAuthority.locatorDigest,
        }).slice(-32)}`
        : null;
      const sourceLocatorAuthority = sourceLocator ? {
        start: sourceLocator.offset,
        end: sourceLocator.end,
        quote: sourceLocator.quote,
        blockId: `title_${sourceItem.id}`,
      } : null;
      const sourceEvidenceIds = sourceEvidenceId ? [sourceEvidenceId] : [];
      const url = sourceItem.metadata?.url;
      if (url) {
        const identityUrl = citationIdentity.duplicateIdentityUrl(url);
        if (!identityUrl) continue;
        const prior = byUrl.get(identityUrl);
        if (prior) {
          const sourceContent = file ? bytesById.get(file.fileId).toString('utf8') : '';
          health.push(createHealth({ type: 'duplicate_source', reasonCode: 'DUPLICATE_IDENTITY_URL', snapshotId: request.snapshotId, subjectId: sourceItem.id, subjectLabel: sourceItem.title || sourceItem.id, file, start: 0, end: file && sourceContent.length ? 1 : 0, quote: sourceContent.slice(0, 1), locatorAuthority: sourceLocatorAuthority, locatorDigestOverride: sourceAuthority?.locatorDigest || null, evidenceIds: sourceEvidenceIds, nextAction: 'MERGE_SOURCE' }));
        }
        else byUrl.set(identityUrl, sourceItem);
      }
      if (file) {
        const prior = byContent.get(file.sha256);
        if (prior) {
          const sourceContent = file ? bytesById.get(file.fileId).toString('utf8') : '';
            health.push(createHealth({ type: 'duplicate_source', reasonCode: 'DUPLICATE_CONTENT_DIGEST', snapshotId: request.snapshotId, subjectId: sourceItem.id, subjectLabel: sourceItem.title || sourceItem.id, file, start: 0, end: file && sourceContent.length ? 1 : 0, quote: sourceContent.slice(0, 1), locatorAuthority: sourceLocatorAuthority, locatorDigestOverride: sourceAuthority?.locatorDigest || null, evidenceIds: sourceEvidenceIds, nextAction: 'MERGE_SOURCE' }));
        }
        else byContent.set(file.sha256, sourceItem);
      }
    }
    const uniqueHealth = aggregateHealth(health)
      .sort((a, b) => compare(a.healthId, b.healthId));
    const stale = uniqueHealth.some(item => item.type === 'stale_locator' || item.severity === 'blocker');
    const partial = source.binding.partial || input.graph.manifest.truncated === true || (input.graph.manifest.warnings || []).length > 0;
    const healthStatus = stale ? 'stale' : partial ? 'partial' : 'complete';
    const blockers = uniqueHealth.filter(item => item.severity === 'blocker');
    const warnings = uniqueHealth.filter(item => item.severity === 'warning');
    const report = {
      schema: schema.SCHEMAS.CITATION_HEALTH_REPORT,
      snapshotId: request.snapshotId,
      fileRevisionSetDigest: parsed.manifest.fileRevisionSetDigest,
      graphManifestDigest: graph.graphManifestDigest,
      sourceIndexRevision: source.sourceIndexRevision,
      status: healthStatus,
      items: uniqueHealth,
      reportDigest: null,
    };
    report.reportDigest = evidenceSchema.digestObject(schema.SCHEMAS.CITATION_HEALTH_REPORT, report, 'reportDigest');
    schema.assertHealthReport(report);
    const manifestWarnings = [...mediaWarnings, ...syntaxWarnings];
    const manifestBlockers = [...mediaBlockers];
    const canExport = selected.length > 0 && blockers.length === 0 && healthStatus === 'complete' &&
      manifestBlockers.length === 0 &&
      (warnings.length === 0 && manifestWarnings.length === 0 || request.warningDecision === 'CONTINUE_WITH_WARNINGS');
    let exportCapabilityId = null;
    const manifest = {
      schema: schema.SCHEMAS.DELIVERY_MANIFEST,
      authority,
      selectedFiles: selected.map((item, order) => ({ fileId: item.file.fileId, revision: item.file.revision, sha256: item.file.sha256, order, pageBreakBefore: request.orderedFiles[order].pageBreakBefore })),
      outline,
      footnotes: buildManifestFootnotes(selected),
      sources: (input.sourceIndex.sources || []).flatMap(sourceItem => {
        const file = source.fileByPath.get(sourceItem.filePath);
        if (!file) return [];
        const displayUrl = citationIdentity.safeHttpUrl(sourceItem.metadata?.url || null);
        return [{
          sourceId: sourceItem.id,
          sourceIndexRevision: source.sourceIndexRevision,
          displayTitle: sourceItem.title || sourceItem.id,
          displayUrl,
          duplicateIdentityUrl: citationIdentity.duplicateIdentityUrl(displayUrl),
          contentSha256: file.sha256,
          evidenceIds: graph.binding.sourceBindings.filter(binding => binding.sourceId === sourceItem.id).map(binding => binding.evidenceId).sort(compare),
        }];
      }),
      ...media,
      syntaxCoverage,
      health: report,
      blockers: [...blockers.map(issueSummary), ...manifestBlockers.map(resourceIssueSummary)],
      warnings: [...warnings.map(issueSummary), ...manifestWarnings.map(resourceIssueSummary)],
      manifestDigest: null,
    };
    manifest.manifestDigest = evidenceSchema.digestObject(schema.SCHEMAS.DELIVERY_MANIFEST, manifest, 'manifestDigest');
    schema.assertManifest(manifest);
    if (canExport) {
      if (!issueCapability) fail('DELIVERY_BLOCKED', 'delivery capability store unavailable');
      if (!Number.isSafeInteger(input.ownerGeneration) || input.ownerGeneration < 0) {
        fail('DELIVERY_BLOCKED', 'delivery capability 缺少 owner generation');
      }
      const issued = issueCapability({
        projectInstanceId: request.projectInstanceId,
        ownerGeneration: input.ownerGeneration,
        subjectId: request.snapshotId,
        authorityDigest: authority.authorityDigest,
        selectionDigest: evidenceSchema.digestObject(schema.SCHEMAS.DELIVERY_EXPORT_SELECTION, {
          schema: schema.SCHEMAS.DELIVERY_EXPORT_SELECTION,
          authorityDigest: authority.authorityDigest,
          orderedFiles: request.orderedFiles,
          warningDecision: request.warningDecision,
          deliveryManifestDigest: manifest.manifestDigest,
        }),
      });
      exportCapabilityId = issued?.capabilityId || null;
      if (!exportCapabilityId) fail('DELIVERY_BLOCKED', 'delivery capability 无效');
    }
    const selectedById = new Map(selected.map(item => [item.file.fileId, item.file]));
    const result = {
      schema: schema.SCHEMAS.DELIVERY_PREFLIGHT,
      projectInstanceId: request.projectInstanceId,
      snapshotId: request.snapshotId,
      authorityDigest: authority.authorityDigest,
      selectedFiles: selected.map((item, order) => ({ fileId: item.fileId, displayPath: item.displayPath, order })),
      outline,
      health: { status: healthStatus, items: uniqueHealth.map(item => publicHealthItem(item, selectedById, byId)) },
      blockers: [...blockers.map(issueSummary), ...manifestBlockers.map(resourceIssueSummary)],
      warnings: [...warnings.map(issueSummary), ...manifestWarnings.map(resourceIssueSummary)],
      canExport: Boolean(canExport && exportCapabilityId),
      exportCapabilityId,
    };
    schema.assertDeliveryPreflight(result);
    return freeze({ public: result, manifest, authority });
  }

  return Object.freeze({ preflight });
}

module.exports = Object.freeze({
  DeliveryPreflightError,
  healthRootDigest,
  createDeliveryPreflightService,
});
