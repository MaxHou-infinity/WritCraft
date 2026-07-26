// WritCraft V0 · Day 5 rewrite state helpers
// Kept DOM-free so the rewrite contract can be tested with plain Node.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__rewriteState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function resolveRewrite(action, original, proposal) {
    if (action === 'accept') return String(proposal || '');
    if (action === 'reject') return String(original || '');
    throw new Error(`Unknown rewrite action: ${action}`);
  }

  function escapeMarkdownSource(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function createStoragePayload(html) {
    return JSON.stringify({ version: 1, html: String(html || ''), savedAt: Date.now() });
  }

  function isSafeUrl(value) {
    const url = String(value || '').trim();
    if (!url || url.startsWith('#') || /^\/(?![\\/])/.test(url) || url.startsWith('./') || url.startsWith('../')) return true;
    return /^(?:https?:|mailto:)/i.test(url);
  }

  function isSafeEmbeddedUrl(value) {
    const url = String(value || '').trim();
    return url.length <= 8 * 1024 * 1024 && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/i.test(url);
  }

  function isLatestRequest(activeRequestId, responseRequestId) {
    return activeRequestId === responseRequestId;
  }

  return { resolveRewrite, escapeMarkdownSource, createStoragePayload, isLatestRequest, isSafeUrl, isSafeEmbeddedUrl };
});
