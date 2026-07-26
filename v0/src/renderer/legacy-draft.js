// Legacy single-document draft inspection and conservative HTML → Markdown.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__legacyDraft = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STORAGE_KEY = 'writcraft:v0:draft';

  function parsePayload(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || typeof value.html !== 'string') return null;
      return {
        html: value.html,
        savedAt: Number.isFinite(value.savedAt) ? value.savedAt : null,
      };
    } catch (_) {
      return null;
    }
  }

  function safeLink(value) {
    const url = String(value || '').trim();
    return /^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(url) ? url : '';
  }

  function resolveTransientDiffs(fragment, warnings) {
    fragment.querySelectorAll('[data-writcraft-transient="rewrite"]').forEach(node => {
      const pieces = [...node.querySelectorAll('.inline-diff-remove,.inline-diff-equal')];
      if (pieces.length) {
        node.replaceWith(node.ownerDocument.createTextNode(pieces.map(piece => piece.textContent || '').join('')));
        warnings.push('检测到未完成的 Inline Diff，已恢复为原始文字，没有自动接受 AI 建议。');
      } else {
        const fallback = node.textContent || '';
        node.replaceWith(node.ownerDocument.createTextNode(fallback));
        warnings.push('检测到无法完整识别的临时校改标记，已按普通文本导入，请在确认后复核。');
      }
    });
  }

  function nodeMarkdown(node, depth = 0) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const children = () => [...node.childNodes].map(child => nodeMarkdown(child, depth + 1)).join('');
    if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'button', 'input'].includes(tag)) return '';
    if (tag === 'br') return '\n';
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') return `${children().trim()}\n\n`;
    if (tag === 'strong' || tag === 'b') return `**${children()}**`;
    if (tag === 'em' || tag === 'i') return `*${children()}*`;
    if (tag === 's' || tag === 'del') return `~~${children()}~~`;
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return `\`${children()}\``;
    if (tag === 'pre') return `\`\`\`\n${node.textContent || ''}\n\`\`\`\n\n`;
    if (tag === 'blockquote') return `${children().trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (tag === 'li') return `${node.parentElement?.tagName.toLowerCase() === 'ol' ? '1.' : '-'} ${children().trim()}\n`;
    if (tag === 'ul' || tag === 'ol') return `${children()}\n`;
    if (tag === 'a') {
      const label = children() || node.textContent || '';
      const href = safeLink(node.getAttribute('href'));
      return href ? `[${label}](${href})` : label;
    }
    return children();
  }

  function inspect(raw, documentRef) {
    const payload = parsePayload(raw);
    if (!payload || !documentRef?.createElement) return null;
    const template = documentRef.createElement('template');
    template.innerHTML = payload.html;
    const warnings = [];
    resolveTransientDiffs(template.content, warnings);
    const markdown = [...template.content.childNodes]
      .map(node => nodeMarkdown(node))
      .join('')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!markdown) return null;
    return { ...payload, markdown: `${markdown}\n`, warnings };
  }

  return { STORAGE_KEY, parsePayload, inspect };
});
