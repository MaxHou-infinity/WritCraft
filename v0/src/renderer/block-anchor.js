(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftBlockAnchor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SCHEMA = 'writcraft.block-anchor/v1';

  function hash(value) {
    let result = 2166136261;
    for (const char of String(value)) { result ^= char.codePointAt(0); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(16).padStart(8, '0');
  }
  function safePath(value) {
    if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) throw new TypeError('invalid project path');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || !/\.(?:md|markdown)$/i.test(value)) throw new TypeError('invalid Markdown path');
    return value;
  }
  function normalized(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' '); }

  function parseBlocks(content, filePath) {
    if (typeof content !== 'string') throw new TypeError('content must be text');
    const path = safePath(filePath);
    const lines = [];
    let offset = 0;
    for (const raw of content.split(/(?<=\n)/)) {
      lines.push({ raw, text: raw.replace(/\r?\n$/, ''), start: offset, end: offset + raw.length });
      offset += raw.length;
    }
    const blocks = [];
    const headings = [];
    const ordinals = new Map();
    for (let index = 0; index < lines.length;) {
      if (!lines[index].text.trim()) { index += 1; continue; }
      const startIndex = index;
      const heading = lines[index].text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      let type = 'paragraph';
      if (heading) {
        type = 'heading';
        const level = heading[1].length;
        headings.splice(level - 1);
        headings[level - 1] = normalized(heading[2]);
        index += 1;
      } else if (/^\s*(`{3,}|~{3,})/.test(lines[index].text)) {
        type = 'code';
        const marker = lines[index].text.trim()[0];
        index += 1;
        while (index < lines.length) {
          const closes = new RegExp(`^\\s*${marker}{3,}`).test(lines[index].text);
          index += 1;
          if (closes) break;
        }
      } else {
        if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[index].text)) type = 'list';
        if (/^\s*>/.test(lines[index].text)) type = 'quote';
        index += 1;
        while (index < lines.length && lines[index].text.trim() && !/^\s{0,3}#{1,6}\s+/.test(lines[index].text) && !/^\s*(`{3,}|~{3,})/.test(lines[index].text)) index += 1;
      }
      const start = lines[startIndex].start;
      const end = lines[Math.max(startIndex, index - 1)].end;
      const text = content.slice(start, end).replace(/\r?\n$/, '');
      const headingKey = headings.filter(Boolean).join(' / ');
      const ordinalKey = `${headingKey}\0${type}`;
      const ordinal = (ordinals.get(ordinalKey) || 0) + 1;
      ordinals.set(ordinalKey, ordinal);
      blocks.push({ path, type, start, end: start + text.length, text, headingKey, ordinal, fingerprint: hash(normalized(text)) });
    }
    return blocks;
  }

  function createBlockAnchor(content, filePath, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > content.length) throw new TypeError('invalid selection range');
    const blocks = parseBlocks(content, filePath);
    const block = blocks.find(item => start >= item.start && start <= item.end && end <= item.end);
    if (!block) throw new Error('selection is not inside one Markdown block');
    const quote = content.slice(start, end);
    return Object.freeze({
      schema: SCHEMA, id: `block_${hash(`${block.path}\0${block.headingKey}\0${block.type}\0${block.ordinal}\0${block.fingerprint}`)}`,
      filePath: block.path, type: block.type, headingKey: block.headingKey, ordinal: block.ordinal,
      blockFingerprint: block.fingerprint, quote, quoteFingerprint: hash(quote),
      relativeStart: start - block.start, relativeEnd: end - block.start,
    });
  }

  function bigrams(value) {
    const text = normalized(value);
    if (text.length < 2) return new Set([text]);
    const set = new Set();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  }
  function similarity(left, right) {
    const a = bigrams(left); const b = bigrams(right);
    let overlap = 0;
    for (const item of a) if (b.has(item)) overlap += 1;
    return a.size + b.size ? 2 * overlap / (a.size + b.size) : 1;
  }
  function resolveBlockAnchor(anchor, content) {
    if (!anchor || anchor.schema !== SCHEMA || typeof content !== 'string') return { ok: false, reason: 'invalid_anchor' };
    let blocks;
    try { blocks = parseBlocks(content, anchor.filePath); } catch (_) { return { ok: false, reason: 'invalid_path' }; }
    if (anchor.quote) {
      const matches = [];
      let cursor = content.indexOf(anchor.quote);
      while (cursor >= 0 && matches.length < 3) { matches.push(cursor); cursor = content.indexOf(anchor.quote, cursor + 1); }
      if (matches.length === 1) {
        const matchingBlock = blocks.find(block => matches[0] >= block.start && matches[0] + anchor.quote.length <= block.end);
        if (matchingBlock && matchingBlock.type === anchor.type && matchingBlock.headingKey === anchor.headingKey) {
          return { ok: true, start: matches[0], end: matches[0] + anchor.quote.length, confidence: 1, method: 'exact_quote' };
        }
        return { ok: false, reason: 'quote_context_changed' };
      }
      if (matches.length > 1) return { ok: false, reason: 'ambiguous_quote' };
    }
    const exact = blocks.filter(block => block.fingerprint === anchor.blockFingerprint && block.type === anchor.type && block.headingKey === anchor.headingKey);
    if (exact.length === 1) {
      const block = exact[0];
      return { ok: true, start: block.start, end: block.end, confidence: .96, method: 'exact_block' };
    }
    const candidates = blocks.filter(block => block.type === anchor.type && block.headingKey === anchor.headingKey && block.ordinal === anchor.ordinal);
    if (candidates.length !== 1) return { ok: false, reason: candidates.length ? 'ambiguous_block' : 'block_missing' };
    const candidate = candidates[0];
    const score = similarity(anchor.quote, candidate.text);
    if (score < .72) return { ok: false, reason: 'block_changed', confidence: score };
    return { ok: true, start: candidate.start, end: candidate.end, confidence: score, method: 'section_ordinal_similarity' };
  }

  return Object.freeze({ SCHEMA, parseBlocks, createBlockAnchor, resolveBlockAnchor });
});
