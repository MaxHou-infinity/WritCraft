// Pure watcher invalidation routing shared by Main and regression tests.
//
// A filename-less fs.watch event means "the project may have changed" and must
// always stay fail-closed. Being observed while an internal mutation lease is
// active is timing evidence, not source provenance: an unrelated external write
// can arrive during the same window. Only named changes can be compared with an
// authoritative Main-owned revision and safely deduplicated.

'use strict';

function watcherPayloadAffectsAiContext(payload, options = {}) {
  const namedChangeAffectsContext = typeof options.namedChangeAffectsContext === 'function'
    ? options.namedChangeAffectsContext
    : () => true;
  let affectsContext = false;

  for (const change of payload?.changes || []) {
    if (!change || typeof change !== 'object') return true;
    if (change.path === null) {
      affectsContext = true;
      continue;
    }
    if (typeof change.path !== 'string' || !change.path) return true;
    if (namedChangeAffectsContext(change)) affectsContext = true;
  }

  return affectsContext;
}

module.exports = {
  watcherPayloadAffectsAiContext,
};
