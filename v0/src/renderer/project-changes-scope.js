// Pure Renderer helpers for explicit ordinary Project Changes scope.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftProjectChangesScope = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUEST_SCHEMA = 'writcraft.project-changes-request/v1';
  const MAX_TARGET_FILES = 8;

  function isPublicMarkdownPath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
      !value.includes('\0') && !value.includes('\\') && !value.includes('//') &&
      !value.startsWith('/') && !/^[A-Za-z]:/.test(value) &&
      /\.(?:md|markdown)$/i.test(value) &&
      value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
  }

  function isReservedReadonlyPath(value) {
    const normalized = String(value || '').toLocaleLowerCase('en-US');
    return normalized === 'edit.md' || normalized.startsWith('references/') || normalized.startsWith('sources/');
  }

  function collectMarkdownPaths(nodes, output = []) {
    for (const node of nodes || []) {
      const filePath = node && (node.path || node.relativePath || '');
      if (node?.type === 'file' && isPublicMarkdownPath(filePath)) output.push(filePath);
      if (node?.type === 'directory' || Array.isArray(node?.children)) collectMarkdownPaths(node.children || [], output);
    }
    return output;
  }

  function availableTargetPaths(tree) {
    return [...new Set(collectMarkdownPaths(tree))]
      .filter(filePath => !isReservedReadonlyPath(filePath))
      .sort((left, right) => left.localeCompare(right, 'en'));
  }

  function reconcileTargets(selected, available, currentPath, preferCurrent = false) {
    const allowed = new Set((available || []).filter(path => isPublicMarkdownPath(path) && !isReservedReadonlyPath(path)));
    const safe = [...new Set((selected || []).filter(path => allowed.has(path)))].slice(0, MAX_TARGET_FILES);
    if (safe.length || !preferCurrent || !allowed.has(currentPath)) return safe;
    return [currentPath];
  }

  function updateTargets(selected, filePath, checked, available) {
    const candidates = Array.isArray(available) ? available : [];
    const safe = reconcileTargets(selected, candidates, '', false);
    if (!candidates.includes(filePath) || !isPublicMarkdownPath(filePath) || isReservedReadonlyPath(filePath)) {
      return { selected: safe, ok: false, error: 'TARGET_PATH_UNAVAILABLE' };
    }
    if (!checked) return { selected: safe.filter(path => path !== filePath), ok: true, error: null };
    if (safe.includes(filePath)) return { selected: safe, ok: true, error: null };
    if (safe.length >= MAX_TARGET_FILES) return { selected: safe, ok: false, error: 'TARGET_LIMIT' };
    return { selected: [...safe, filePath], ok: true, error: null };
  }

  function createRequest(instruction, targetPaths, contextPaths) {
    const trimmed = typeof instruction === 'string' ? instruction.trim() : '';
    if (!trimmed || !Array.isArray(targetPaths) || !targetPaths.length || !Array.isArray(contextPaths)) return null;
    const targets = [...new Set(targetPaths)];
    if (targets.length > MAX_TARGET_FILES || targets.some(path => !isPublicMarkdownPath(path) || isReservedReadonlyPath(path))) return null;
    const targetSet = new Set(targets);
    const contexts = [...new Set(contextPaths)].filter(path => !targetSet.has(path));
    if (contexts.some(path => !isPublicMarkdownPath(path))) return null;
    return Object.freeze({
      schema: REQUEST_SCHEMA,
      instruction: trimmed,
      targetPaths: Object.freeze(targets),
      contextPaths: Object.freeze(contexts),
    });
  }

  function sameRequest(left, right) {
    if (!left || !right || left.schema !== REQUEST_SCHEMA || right.schema !== REQUEST_SCHEMA ||
        left.instruction !== right.instruction) return false;
    return ['targetPaths', 'contextPaths'].every(key => Array.isArray(left[key]) && Array.isArray(right[key]) &&
      left[key].length === right[key].length && left[key].every((item, index) => item === right[key][index]));
  }

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }

  function validContextManifest(value) {
    if (!exactKeys(value, ['schema', 'authority', 'entry', 'editRevision', 'editCompilation', 'items', 'totals', 'sourceIndexRevision']) ||
        value.schema !== 'writcraft.context-manifest/v2' || value.authority !== 'main' ||
        value.entry !== 'changes' || !/^[a-f0-9]{64}$/.test(value.editRevision || '') ||
        !Array.isArray(value.items) || !value.totals ||
        !exactKeys(value.totals, ['availableItems', 'includedItems', 'omittedItems', 'rawBytes', 'includedBytes', 'budgetBytes'])) return false;
    if (!value.editCompilation || !exactKeys(value.editCompilation, [
      'status', 'rawBytes', 'compiledBytes', 'budgetBytes', 'budgetChars', 'availableSections',
      'includedSections', 'omittedSections', 'omissionReason', 'truncationReason', 'selectionPolicy',
    ]) || !['complete', 'truncated', 'unavailable'].includes(value.editCompilation.status) ||
        value.editCompilation.budgetBytes !== 18 * 1024 || value.editCompilation.budgetChars !== 6000 ||
        value.editCompilation.selectionPolicy !== 'required_sections_then_source_order') return false;
    const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
    if (![value.editCompilation.rawBytes, value.editCompilation.compiledBytes, value.editCompilation.budgetBytes,
      value.editCompilation.budgetChars, value.editCompilation.availableSections,
      value.editCompilation.includedSections, value.editCompilation.omittedSections].every(nonnegative) ||
        value.editCompilation.includedSections + value.editCompilation.omittedSections !== value.editCompilation.availableSections ||
        ![value.totals.availableItems, value.totals.includedItems, value.totals.omittedItems,
          value.totals.includedBytes, value.totals.budgetBytes].every(nonnegative) ||
        value.totals.includedItems + value.totals.omittedItems !== value.totals.availableItems ||
        value.totals.availableItems !== value.items.length) return false;
    const ids = new Set();
    return value.items.every(item => {
      if (!exactKeys(item, ['id', 'kind', 'path', 'revision', 'status', 'rawBytes', 'includedBytes', 'budgetBytes', 'omissionReason', 'truncationReason']) ||
          typeof item.id !== 'string' || ids.has(item.id) ||
          !['project_prompt', 'current_file', 'context', 'source', 'entity', 'target', 'selection'].includes(item.kind) ||
          !['included', 'omitted', 'unavailable', 'stale'].includes(item.status) ||
          (item.path !== null && (typeof item.path !== 'string' || item.path.startsWith('/') || item.path.includes('\\'))) ||
          (item.rawBytes !== null && !nonnegative(item.rawBytes)) || !nonnegative(item.includedBytes) ||
          !nonnegative(item.budgetBytes) || (item.status === 'included' && item.omissionReason !== null) ||
          (item.status !== 'included' && item.omissionReason === null)) return false;
      ids.add(item.id);
      return true;
    });
  }

  function responseMatchesRequest(result, request) {
    if (!result || result.ok !== true || !request || request.schema !== REQUEST_SCHEMA) return false;
    const provenance = result.provenance;
    if (!validContextManifest(result.contextManifest) ||
        !exactKeys(provenance, ['schema', 'kind', 'targets', 'context']) ||
        provenance.schema !== REQUEST_SCHEMA || provenance.kind !== 'project_changes' ||
        !Array.isArray(provenance.targets) || !Array.isArray(provenance.context) ||
        provenance.targets.length !== request.targetPaths.length) return false;
    for (let index = 0; index < request.targetPaths.length; index += 1) {
      const target = provenance.targets[index];
      if (!exactKeys(target, ['path', 'revision']) || target.path !== request.targetPaths[index] ||
          !/^[a-f0-9]{64}$/.test(target.revision || '')) return false;
    }
    const expectedContext = [...new Set(['edit.md', ...request.contextPaths])];
    if (provenance.context.length !== expectedContext.length) return false;
    for (let index = 0; index < expectedContext.length; index += 1) {
      const context = provenance.context[index];
      const expectedPath = expectedContext[index];
      const expectedRole = expectedPath === 'edit.md' ? 'project_prompt' : 'context';
      if (!exactKeys(context, ['path', 'revision', 'role']) || context.path !== expectedPath ||
          context.role !== expectedRole || !/^[a-f0-9]{64}$/.test(context.revision || '')) return false;
    }
    if (result.noChanges === true) return result.fileCount === 0 && !result.review && !result.changeSetId;
    if (result.noChanges !== false || typeof result.changeSetId !== 'string' || !result.changeSetId ||
        !result.review || result.review.changeSetId !== result.changeSetId ||
        !Array.isArray(result.review.files) || result.fileCount !== result.review.files.length || result.fileCount < 1) {
      return false;
    }
    const targetSet = new Set(request.targetPaths);
    const seen = new Set();
    return result.review.files.every(file => file && typeof file.path === 'string' &&
      targetSet.has(file.path) && !seen.has(file.path) && (seen.add(file.path), true));
  }

  return Object.freeze({
    REQUEST_SCHEMA,
    MAX_TARGET_FILES,
    isPublicMarkdownPath,
    isReservedReadonlyPath,
    collectMarkdownPaths,
    availableTargetPaths,
    reconcileTargets,
    updateTargets,
    createRequest,
    sameRequest,
    responseMatchesRequest,
  });
});
