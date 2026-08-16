'use strict';

// Citation URL identity is shared by SourceIndex, delivery preflight and any
// future Renderer projection.  It never performs network access and preserves
// the display URL separately from the duplicate-detection identity.
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

function duplicateIdentityUrl(raw) {
  const safe = safeHttpUrl(raw);
  if (!safe) return null;
  const parsed = new URL(safe);
  parsed.hash = '';
  return parsed.href;
}

module.exports = Object.freeze({ safeHttpUrl, duplicateIdentityUrl });
