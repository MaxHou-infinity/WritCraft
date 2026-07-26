(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftCitation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STYLES = new Set(['apa7', 'mla9', 'chicago17']);
  function clean(value, fallback = '') { return String(value || fallback).trim().replace(/\s+/g, ' '); }
  function year(value) { const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/); return match ? match[1] : 'n.d.'; }
  function safeUrl(value) {
    try { const url = new URL(clean(value)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
  }
  function citationKey(source) {
    const explicit = clean(source?.metadata?.citationKey).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64);
    if (explicit) return explicit;
    const base = clean(source?.metadata?.author || source?.title || 'source').normalize('NFKD').replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'source';
    return `${base}-${year(source?.metadata?.published)}`;
  }
  function formatCitation(source, style = 'apa7') {
    if (!STYLES.has(style)) throw new TypeError('unsupported citation style');
    const author = clean(source?.metadata?.author, '佚名');
    const title = clean(source?.title || source?.filePath, '未命名来源');
    const published = year(source?.metadata?.published);
    const url = safeUrl(source?.metadata?.url);
    if (style === 'apa7') return `${author}. (${published}). ${title}.${url ? ` ${url}` : ''}`;
    if (style === 'mla9') return `${author}. “${title}.” ${published}.${url ? ` ${url}` : ''}`;
    return `${author}. “${title}.” ${published}.${url ? ` ${url}` : ''}`;
  }
  function fnv1a64(value, seed) {
    let hash = seed;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= BigInt(value.charCodeAt(index));
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
  }
  function sourceFingerprint(source) {
    // SourceIndex already assigns an 80-bit SHA-256-derived ID. Preserve that
    // complete identity instead of compressing it into the old 32-bit FNV tag.
    const sourceId = clean(source?.id).toLowerCase();
    if (/^src_[a-f0-9]{20,64}$/.test(sourceId)) return sourceId;

    // Direct callers may not have a SourceIndex ID. Keep the fallback compact
    // and HTML-comment-safe, but use two independently seeded 64-bit hashes so
    // a collision in the retired 32-bit fingerprint cannot alias a citation.
    const filePath = clean(source?.filePath).normalize('NFKC');
    const url = safeUrl(source?.metadata?.url);
    const identity = filePath
      ? `path:${filePath}`
      : url
        ? `url:${url}`
        : `source:${JSON.stringify([
          clean(source?.title).normalize('NFKC'),
          clean(source?.metadata?.author).normalize('NFKC'),
          clean(source?.metadata?.published).normalize('NFKC'),
        ])}`;
    return `fp_${fnv1a64(identity, 0xcbf29ce484222325n)}${fnv1a64(identity, 0x84222325cbf29ce4n)}`;
  }
  function insertFootnote(content, offset, source, style = 'apa7') {
    if (typeof content !== 'string') throw new TypeError('content must be text');
    const safeOffset = Math.max(0, Math.min(Number.isInteger(offset) ? offset : content.length, content.length));
    const baseKey = citationKey(source);
    const fingerprint = sourceFingerprint(source);
    let key = baseKey;
    let suffix = 2;
    const definitionFor = candidate => {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = content.match(new RegExp(`^\\[\\^${escaped}\\]:[ \\t]*(.*)$`, 'm'));
      if (!match) return null;
      const marker = match[1].match(/<!--\s*writcraft-source:((?:src_[a-f0-9]{20,64}|fp_[a-f0-9]{32}))\s*-->/i);
      return { text: match[1], fingerprint: marker ? marker[1].toLowerCase() : null };
    };
    let existing = definitionFor(key);
    while (existing && existing.fingerprint !== fingerprint) {
      key = `${baseKey}-${suffix++}`;
      existing = definitionFor(key);
    }
    const reference = `[^${key}]`;
    let next = content.slice(0, safeOffset) + reference + content.slice(safeOffset);
    if (!existing) {
      next = `${next.replace(/\s*$/, '')}\n\n[^${key}]: ${formatCitation(source, style)} <!-- writcraft-source:${fingerprint} -->\n`;
    }
    return { content: next, cursorOffset: safeOffset + reference.length, key, reference, citation: formatCitation(source, style) };
  }
  return Object.freeze({ STYLES: [...STYLES], citationKey, formatCitation, sourceFingerprint, insertFootnote });
});
