// Pure Renderer guards for the identifier-only Research -> Changes handoff.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftResearchHandoffTransaction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA = 'writcraft.research-handoff/v1';
  const CARD_ID = /^rc_[a-f0-9]{32}$/;
  const MAX_TARGETS = 8;
  const MAX_REQUEST_BYTES = 8 * 1024;

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function normalizeCardHandoff(value) {
    if (!exactKeys(value, ['schema', 'cardId']) || value.schema !== SCHEMA ||
        !CARD_ID.test(value.cardId)) return null;
    return Object.freeze({ schema: SCHEMA, cardId: value.cardId });
  }

  function normalizeTargets(paths) {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_TARGETS) return null;
    const seen = new Set();
    const normalized = [];
    for (const filePath of paths) {
      if (typeof filePath !== 'string' || !filePath || seen.has(filePath)) return null;
      seen.add(filePath);
      normalized.push(filePath);
    }
    return Object.freeze(normalized);
  }

  function createRequest(handoff, targetPaths) {
    const card = normalizeCardHandoff(handoff);
    const targets = normalizeTargets(targetPaths);
    if (!card || !targets) return null;
    const request = { schema: SCHEMA, cardId: card.cardId, targetPaths: targets };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_REQUEST_BYTES) return null;
    return Object.freeze(request);
  }

  function targetFingerprint(paths) {
    const normalized = normalizeTargets(paths);
    return normalized ? JSON.stringify(normalized) : '';
  }

  function captureBinding(workspaceState, targetPaths) {
    const projectInstanceId = workspaceState?.project?.instanceId;
    const fingerprint = targetFingerprint(targetPaths);
    if (typeof projectInstanceId !== 'string' || !projectInstanceId || !fingerprint) return null;
    return Object.freeze({
      projectInstanceId,
      currentPath: typeof workspaceState.currentPath === 'string' ? workspaceState.currentPath : '',
      editorSession: Number.isSafeInteger(workspaceState.openGeneration) ? workspaceState.openGeneration : -1,
      editVersion: Number.isSafeInteger(workspaceState.editVersion) ? workspaceState.editVersion : -1,
      dirtyGeneration: Number.isSafeInteger(workspaceState.editVersion) ? workspaceState.editVersion : -1,
      dirty: workspaceState.dirty === true,
      targetFingerprint: fingerprint,
    });
  }

  function bindingMatches(binding, workspaceState, targetPaths) {
    const current = captureBinding(workspaceState, targetPaths);
    return Boolean(binding && current &&
      binding.projectInstanceId === current.projectInstanceId &&
      binding.currentPath === current.currentPath &&
      binding.editorSession === current.editorSession &&
      binding.editVersion === current.editVersion &&
      binding.dirtyGeneration === current.dirtyGeneration &&
      binding.dirty === current.dirty &&
      binding.targetFingerprint === current.targetFingerprint);
  }

  function responseMatches(result, request) {
    if (!result || result.ok !== true || !request || request.schema !== SCHEMA ||
        result.proposalKind !== 'research_card') return false;
    const provenance = result.provenance;
    if (!provenance || provenance.schema !== SCHEMA || provenance.kind !== 'research_card' ||
        provenance.cardId !== request.cardId || !Array.isArray(provenance.targets) ||
        provenance.targets.length !== request.targetPaths.length ||
        provenance.targets.some((target, index) => target?.path !== request.targetPaths[index])) return false;
    if (result.noChanges === true) {
      return result.fileCount === 0 && !result.review && !result.changeSetId;
    }
    if (!(result.noChanges === false && typeof result.changeSetId === 'string' && result.changeSetId &&
      result.review?.changeSetId === result.changeSetId && Array.isArray(result.review.files) &&
      result.fileCount === result.review.files.length && result.fileCount > 0)) return false;
    const selected = new Set(request.targetPaths);
    const seen = new Set();
    return result.review.files.every(file => file && typeof file.path === 'string' && selected.has(file.path) &&
      !seen.has(file.path) && (seen.add(file.path), true));
  }

  return Object.freeze({
    SCHEMA,
    CARD_ID,
    MAX_TARGETS,
    MAX_REQUEST_BYTES,
    normalizeCardHandoff,
    normalizeTargets,
    createRequest,
    targetFingerprint,
    captureBinding,
    bindingMatches,
    responseMatches,
  });
});
