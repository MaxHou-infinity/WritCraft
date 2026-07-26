(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftGraphIssueHandoffTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const SCHEMA = 'writcraft.graph-issue-handoff/v1';
  const ISSUE_ID_RE = /^issue_[A-Za-z0-9_-]{1,120}$/;
  const GRAPH_ID_RE = /^graph_[a-f0-9]{32}$/;
  const BINDING_ID_RE = /^gih_[a-f0-9]{24}$/;

  function normalizeRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    const expected = ['bindingId', 'graphIdentity', 'issueId', 'schema'];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
    if (value.schema !== SCHEMA || !ISSUE_ID_RE.test(value.issueId || '') ||
        !GRAPH_ID_RE.test(value.graphIdentity || '') || !BINDING_ID_RE.test(value.bindingId || '')) return null;
    return Object.freeze({
      schema: SCHEMA,
      issueId: value.issueId,
      graphIdentity: value.graphIdentity,
      bindingId: value.bindingId,
    });
  }

  // Lifecycle/epoch ownership intentionally remains in
  // WritCraftChangesProposalTransaction's shared `issue` mode. This module is
  // only the strict identifier boundary for Graph UI → Changes.
  return Object.freeze({ SCHEMA, normalizeRequest });
});
