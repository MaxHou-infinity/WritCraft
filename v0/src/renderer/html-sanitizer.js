// WritCraft renderer HTML sanitizer.
// The editor accepts HTML only from its own legacy recovery payload and from
// locally rendered Markdown. Keep one DOM implementation for both paths.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftHtmlSanitizer = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ALLOWED_ELEMENTS = new Set([
    'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'LI', 'MARK', 'OL', 'P',
    'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'UL',
  ]);
  const DROP_WITH_CONTENT = new Set([
    'APPLET', 'AUDIO', 'BASE', 'BUTTON', 'EMBED', 'FORM', 'FRAME', 'FRAMESET',
    'IFRAME', 'INPUT', 'LINK', 'META', 'NOSCRIPT', 'OBJECT', 'OPTION', 'SCRIPT',
    'SELECT', 'SOURCE', 'STYLE', 'TEMPLATE', 'TEXTAREA', 'TRACK', 'VIDEO',
  ]);
  const ATTRIBUTES = Object.freeze({
    A: new Set(['href', 'title']),
    IMG: new Set(['alt', 'height', 'src', 'title', 'width']),
  });
  const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
  const MAX_ELEMENTS = 10_000;
  const MAX_FALLBACK_TEXT_CHARS = 1_000_000;

  function numericDimension(value) {
    return /^(?:[1-9]\d{0,3})$/.test(String(value || '').trim());
  }

  function sanitizeFragment(fragment, urlPolicy) {
    if (!fragment || typeof fragment.querySelectorAll !== 'function') {
      throw new TypeError('sanitizeFragment requires a DOM fragment');
    }
    if (!urlPolicy || typeof urlPolicy.isSafeUrl !== 'function' || typeof urlPolicy.isSafeEmbeddedUrl !== 'function') {
      throw new TypeError('sanitizeFragment requires an explicit URL policy');
    }

    const elements = [...fragment.querySelectorAll('*')];
    if (elements.length > MAX_ELEMENTS) {
      const text = String(fragment.textContent || '').slice(0, MAX_FALLBACK_TEXT_CHARS);
      fragment.replaceChildren(fragment.ownerDocument.createTextNode(text));
      return fragment;
    }

    for (const node of elements) {
      const tag = String(node.tagName || '').toUpperCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        node.remove();
        continue;
      }
      if (node.namespaceURI !== HTML_NAMESPACE || !ALLOWED_ELEMENTS.has(tag)) {
        node.replaceWith(...node.childNodes);
        continue;
      }

      const allowed = ATTRIBUTES[tag] || new Set();
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name)) node.removeAttribute(attr.name);
      }

      if (tag === 'A') {
        const href = node.getAttribute('href');
        if (href !== null && !urlPolicy.isSafeUrl(href)) node.removeAttribute('href');
        if (node.hasAttribute('href')) node.setAttribute('rel', 'noopener noreferrer');
      }
      if (tag === 'IMG') {
        const src = node.getAttribute('src');
        if (src === null || !urlPolicy.isSafeEmbeddedUrl(src)) node.removeAttribute('src');
        for (const name of ['width', 'height']) {
          if (node.hasAttribute(name) && !numericDimension(node.getAttribute(name))) node.removeAttribute(name);
        }
      }
    }
    return fragment;
  }

  return Object.freeze({ sanitizeFragment });
});
