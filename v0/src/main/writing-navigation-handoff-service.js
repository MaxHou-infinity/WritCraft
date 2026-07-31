'use strict';

const blockAnchor = require('../renderer/block-anchor');
const projectChangesProposalService = require('./project-changes-proposal-service');

const OPEN_HANDOFF_SCHEMA = 'writcraft.writing-navigation-open/v1';
const RESEARCH_HANDOFF_SCHEMA = 'writcraft.writing-navigation-research/v1';
const CHANGES_PROVENANCE_SCHEMA = 'writcraft.writing-navigation-changes/v1';
const REVISION_RE = /^[a-f0-9]{64}$/;

class WritingNavigationHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingNavigationHandoffError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingNavigationHandoffError(code, message);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function sameJson(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch (_) { return false; }
}

function readRevision(projectService, rootPath, dependency) {
  if (!dependency || typeof dependency.path !== 'string' ||
      !REVISION_RE.test(dependency.revision || '')) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航依赖无效');
  }
  let snapshot;
  try { snapshot = projectService.readFileWithRevision(rootPath, dependency.path); }
  catch (_) { fail('NAVIGATION_STALE', '导航引用的文件已删除或移动，请重新生成导航'); }
  if (!snapshot || typeof snapshot.content !== 'string' ||
      snapshot.revision !== dependency.revision) {
    fail('NAVIGATION_STALE', '导航引用的文件已经变化，请重新生成导航');
  }
  return snapshot;
}

function validateEvidence(snapshot, evidence) {
  if (!exactKeys(evidence, [
    'relativePath', 'revision', 'sectionHeading', 'quote', 'locator',
  ]) || evidence.relativePath !== evidence.locator?.filePath ||
      evidence.revision !== evidence.locator?.revision ||
      snapshot.revision !== evidence.revision ||
      !Number.isSafeInteger(evidence.locator.offset) ||
      !Number.isSafeInteger(evidence.locator.endOffset) ||
      evidence.locator.offset < 0 ||
      evidence.locator.endOffset <= evidence.locator.offset ||
      snapshot.content.slice(evidence.locator.offset, evidence.locator.endOffset) !== evidence.quote) {
    fail('NAVIGATION_STALE', '导航证据已经变化，请重新生成导航');
  }
  let rebuilt;
  try {
    rebuilt = blockAnchor.createBlockAnchor(
      snapshot.content,
      evidence.relativePath,
      evidence.locator.offset,
      evidence.locator.endOffset
    );
  } catch (_) {
    fail('NAVIGATION_STALE', '导航证据位置已经变化，请重新生成导航');
  }
  if (!sameJson(rebuilt, evidence.locator.blockAnchor) ||
      rebuilt.headingKey !== evidence.sectionHeading) {
    fail('NAVIGATION_STALE', '导航证据章节已经变化，请重新生成导航');
  }
}

function revalidateAuthority({ projectService, rootPath, authority }) {
  if (!projectService || typeof projectService.readFileWithRevision !== 'function' ||
      !authority?.record || !authority?.suggestion) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
  }
  const record = authority.record;
  if (record.schema !== 'writcraft.writing-navigation/v1' ||
      record.mode !== 'navigation' ||
      !Array.isArray(record.sources) ||
      !Array.isArray(authority.suggestion.evidence)) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
  }
  readRevision(projectService, rootPath, record.edit);
  const snapshots = new Map();
  for (const source of record.sources) {
    const snapshot = readRevision(projectService, rootPath, source);
    snapshots.set(source.path, snapshot);
  }
  for (const evidence of authority.suggestion.evidence) {
    const snapshot = snapshots.get(evidence.relativePath);
    if (!snapshot) fail('INVALID_NAVIGATION_AUTHORITY', '导航证据不在已读取上下文中');
    validateEvidence(snapshot, evidence);
  }
  return true;
}

function publicEvidence(evidence) {
  return Object.freeze({
    path: evidence.relativePath,
    revision: evidence.revision,
    sectionHeading: evidence.sectionHeading,
    quote: evidence.quote,
    locator: evidence.locator,
  });
}

function openHandoff(authority) {
  if (authority?.suggestion?.action !== 'open' || !authority.suggestion.evidence?.length) {
    fail('ACTION_MISMATCH', '这条建议不是打开章节动作');
  }
  const evidence = authority.suggestion.evidence[0];
  return Object.freeze({
    ok: true,
    kind: 'open',
    handoff: Object.freeze({
      schema: OPEN_HANDOFF_SCHEMA,
      navigationId: authority.navigationId,
      suggestionId: authority.suggestion.suggestionId,
      path: evidence.relativePath,
      locator: evidence.locator,
    }),
  });
}

function researchHandoff(authority) {
  if (authority?.suggestion?.action !== 'research') {
    fail('ACTION_MISMATCH', '这条建议不是补充来源动作');
  }
  const suggestion = authority.suggestion;
  return Object.freeze({
    ok: true,
    kind: 'research',
    handoff: Object.freeze({
      schema: RESEARCH_HANDOFF_SCHEMA,
      navigationId: authority.navigationId,
      suggestionId: suggestion.suggestionId,
      question: suggestion.recommendedAction,
      finding: suggestion.finding,
      evidence: Object.freeze(suggestion.evidence.map(publicEvidence)),
    }),
  });
}

function prepareChangesHandoff({ projectService, rootPath, authority }) {
  if (authority?.suggestion?.action !== 'changes') {
    fail('ACTION_MISMATCH', '这条建议不是生成修改建议动作');
  }
  const suggestion = authority.suggestion;
  const targetPaths = [...new Set(suggestion.evidence.map(item => item.relativePath))];
  const targetSet = new Set(targetPaths);
  const contextPaths = authority.record.sources
    .map(item => item.path)
    .filter(filePath => !targetSet.has(filePath));
  const instruction = [
    `发现：${suggestion.finding}`,
    `为什么现在处理：${suggestion.whyNow}`,
    `建议动作：${suggestion.recommendedAction}`,
    `预期结果：${suggestion.expectedResult}`,
  ].join('\n');
  const prepared = projectChangesProposalService.prepareProjectChangesProposal({
    projectService,
    rootPath,
    request: {
      schema: projectChangesProposalService.REQUEST_SCHEMA,
      instruction,
      targetPaths,
      contextPaths,
    },
  });
  return Object.freeze({
    prepared,
    provenance: Object.freeze({
      schema: CHANGES_PROVENANCE_SCHEMA,
      navigationId: authority.navigationId,
      suggestionId: suggestion.suggestionId,
      evidence: Object.freeze(suggestion.evidence.map(publicEvidence)),
    }),
  });
}

function finalizeChangesHandoff({ preparedHandoff, model, changeSetService }) {
  const finalized = projectChangesProposalService.finalizeProjectChangesProposal({
    prepared: preparedHandoff.prepared,
    model,
    changeSetService,
  });
  if (!finalized.ok || finalized.noChanges) {
    return Object.freeze({
      ...finalized,
      kind: 'changes',
      provenance: preparedHandoff.provenance,
    });
  }
  return Object.freeze({
    ok: true,
    kind: 'changes',
    noChanges: false,
    changeSet: finalized.changeSet,
    fileCount: finalized.fileCount,
    dependencies: preparedHandoff.prepared.dependencies,
    provenance: preparedHandoff.provenance,
  });
}

module.exports = Object.freeze({
  OPEN_HANDOFF_SCHEMA,
  RESEARCH_HANDOFF_SCHEMA,
  CHANGES_PROVENANCE_SCHEMA,
  WritingNavigationHandoffError,
  revalidateAuthority,
  openHandoff,
  researchHandoff,
  prepareChangesHandoff,
  finalizeChangesHandoff,
});
