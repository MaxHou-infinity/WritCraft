'use strict';

const blockAnchor = require('../shared/block-anchor');
const contextManifestService = require('../shared/context-manifest');
const editPromptManifest = require('../shared/edit-prompt-manifest');
const contextResolverService = require('./context-resolver-service');
const projectChangesProposalService = require('./project-changes-proposal-service');
const unifiedWritingTaskService = require('./unified-writing-task-service');
const { markdownPaths, MAX_CONTEXT_BYTES: NAVIGATION_CONTEXT_BUDGET_BYTES } = require('./writing-navigation-service');

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
  const publicHeading = rebuilt.headingKey || '文首';
  if (!sameJson(rebuilt, evidence.locator.blockAnchor) ||
      publicHeading !== evidence.sectionHeading) {
    fail('NAVIGATION_STALE', '导航证据章节已经变化，请重新生成导航');
  }
}

function availableBodyCount(projectService, rootPath) {
  if (typeof projectService.listTree !== 'function') {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航项目清单无效');
  }
  let tree;
  try { tree = projectService.listTree(rootPath); }
  catch (_) { fail('NAVIGATION_STALE', '项目文件清单已经变化，请重新生成导航'); }
  let paths;
  try { paths = markdownPaths(tree); }
  catch (_) { fail('NAVIGATION_STALE', '项目文件清单已经变化，请重新生成导航'); }
  const identities = new Set();
  for (const filePath of paths) {
    const identity = filePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (identities.has(identity)) {
      fail('NAVIGATION_STALE', '项目文件清单已经变化，请重新生成导航');
    }
    identities.add(identity);
  }
  return identities.size;
}

function validateManifest(projectService, rootPath, record, editSnapshot, snapshots) {
  const manifest = record.result.contextManifest;
  if (!exactKeys(manifest, [
    'usedBodyCount', 'availableBodyCount', 'omittedBodyCount', 'totalBodyBytes',
    'limitedProjectIntent', 'editPromptCompilation', 'editPrompt', 'unified', 'files', 'omissionReason',
    'truncationReason', 'disclosure',
  ]) || !Array.isArray(manifest.files) || manifest.files.length !== record.sources.length + 1 ||
      typeof manifest.limitedProjectIntent !== 'boolean' ||
      !exactKeys(manifest.editPromptCompilation, ['compiledBytes', 'fallbackToRaw']) ||
      !Number.isSafeInteger(manifest.editPromptCompilation.compiledBytes) ||
      typeof manifest.editPromptCompilation.fallbackToRaw !== 'boolean') {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航 Context 记录无效');
  }
  const available = availableBodyCount(projectService, rootPath);
  const totalBodyBytes = [...snapshots.values()]
    .reduce((sum, snapshot) => sum + Buffer.byteLength(snapshot.content, 'utf8'), 0);
  const expectedFiles = [
    {
      path: 'edit.md', role: 'project_prompt', revision: editSnapshot.revision,
      bytes: Buffer.byteLength(editSnapshot.content, 'utf8'),
    },
    ...record.sources.map(source => {
      const snapshot = snapshots.get(source.path);
      const existing = manifest.files.find(file => file.path === source.path);
      if (!existing || !['current_file', 'explicit_context'].includes(existing.role)) {
        fail('INVALID_NAVIGATION_AUTHORITY', '写作导航 Context 记录无效');
      }
      return {
        path: source.path,
        role: existing.role,
        revision: snapshot.revision,
        bytes: Buffer.byteLength(snapshot.content, 'utf8'),
      };
    }),
  ];
  let compiledEdit = { content: '', fallbackToRaw: false, result: { truncated: false, sections: [] } };
  if (editSnapshot.content.trim()) {
    try {
      const compiledResult = contextResolverService.compileEditPrompt(editSnapshot.content);
      compiledEdit = {
        content: compiledResult.content,
        fallbackToRaw: false,
        result: compiledResult,
      };
    } catch (_) {
      fail('NAVIGATION_STALE', 'edit.md 无法按统一项目 Prompt 合同重新编译，请重新生成导航');
    }
  }
  const expected = {
    usedBodyCount: record.sources.length,
    availableBodyCount: available,
    omittedBodyCount: Math.max(0, available - record.sources.length),
    totalBodyBytes,
    limitedProjectIntent: manifest.limitedProjectIntent,
    editPromptCompilation: {
      compiledBytes: Buffer.byteLength(compiledEdit.content, 'utf8'),
      fallbackToRaw: compiledEdit.fallbackToRaw,
    },
    editPrompt: editPromptManifest.createEditPromptManifest({
      rawContent: editSnapshot.content,
      compiledContent: compiledEdit.content,
      revision: editSnapshot.revision,
      compiledResult: compiledEdit.result,
      fallbackToRaw: compiledEdit.fallbackToRaw,
    }),
    unified: contextManifestService.createContextManifest({
      entry: 'navigation',
      editRevision: editSnapshot.revision,
      editCompilation: contextManifestService.createEditCompilation({
        rawContent: editSnapshot.content,
        compiledContent: compiledEdit.content,
        revision: editSnapshot.revision,
        compiledResult: compiledEdit.result,
        unavailable: !editSnapshot.content.trim(),
      }),
      items: [
        {
          id: 'nav_edit_prompt', kind: 'project_prompt', path: 'edit.md', revision: editSnapshot.revision,
          status: editSnapshot.content.trim() ? 'included' : 'unavailable',
          rawBytes: Buffer.byteLength(editSnapshot.content, 'utf8'),
          includedBytes: editSnapshot.content.trim() ? Buffer.byteLength(compiledEdit.content, 'utf8') : 0,
          budgetBytes: NAVIGATION_CONTEXT_BUDGET_BYTES,
          omissionReason: editSnapshot.content.trim() ? null : 'invalid_edit',
          truncationReason: null,
        },
        ...record.sources.map(source => {
          const snapshot = snapshots.get(source.path);
          const existing = manifest.files.find(file => file.path === source.path);
          return {
            id: `nav_${existing.role}_${source.path.replace(/[^A-Za-z0-9_-]/g, '_')}`,
            kind: existing.role === 'current_file' ? 'current_file' : 'context',
            path: source.path,
            revision: snapshot.revision,
            status: 'included',
            rawBytes: Buffer.byteLength(snapshot.content, 'utf8'),
            includedBytes: Buffer.byteLength(snapshot.content, 'utf8'),
            budgetBytes: NAVIGATION_CONTEXT_BUDGET_BYTES,
            omissionReason: null,
            truncationReason: null,
          };
        }),
        ...Array.from({ length: Math.max(0, available - record.sources.length) }, (_, index) => ({
          id: `nav_omitted_body_${index + 1}`,
          kind: 'context', path: null, revision: null, status: 'omitted', rawBytes: null,
          includedBytes: 0, budgetBytes: NAVIGATION_CONTEXT_BUDGET_BYTES, omissionReason: 'not_selected', truncationReason: null,
        })),
      ],
      budgetBytes: NAVIGATION_CONTEXT_BUDGET_BYTES,
    }),
    files: expectedFiles,
    omissionReason: available === record.sources.length ? null : 'not_selected',
    truncationReason: null,
    disclosure: available === record.sources.length
      ? '已读取当前项目全部正文'
      : `只基于本次已读取的 ${record.sources.length}/${available} 个正文文件`,
  };
  if (!sameJson(manifest, expected)) {
    fail('NAVIGATION_STALE', '写作导航 Context 已经变化，请重新生成导航');
  }
}

function revalidateRecord({ projectService, rootPath, record }) {
  if (!projectService || typeof projectService.readFileWithRevision !== 'function' || !record) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
  }
  if (record.schema !== 'writcraft.writing-navigation/v1' ||
      record.mode !== 'navigation' ||
      !Array.isArray(record.sources) ||
      !Array.isArray(record.result?.suggestions)) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
  }
  const editSnapshot = readRevision(projectService, rootPath, record.edit);
  const snapshots = new Map();
  for (const source of record.sources) {
    const snapshot = readRevision(projectService, rootPath, source);
    snapshots.set(source.path, snapshot);
  }
  validateManifest(projectService, rootPath, record, editSnapshot, snapshots);
  for (const suggestion of record.result.suggestions) {
    if (!Array.isArray(suggestion?.evidence)) {
      fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
    }
    for (const evidence of suggestion.evidence) {
      const snapshot = snapshots.get(evidence.relativePath);
      if (!snapshot) fail('INVALID_NAVIGATION_AUTHORITY', '导航证据不在已读取上下文中');
      validateEvidence(snapshot, evidence);
    }
  }
  return true;
}

function revalidateAuthority({ projectService, rootPath, authority }) {
  if (!authority?.record || !authority?.suggestion ||
      !Array.isArray(authority.suggestion.evidence)) {
    fail('INVALID_NAVIGATION_AUTHORITY', '写作导航权威记录无效');
  }
  revalidateRecord({ projectService, rootPath, record: authority.record });
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

function prepareChangesHandoff({
  projectService,
  rootPath,
  authority,
  adjustment = '',
  extraContextPaths = [],
}) {
  if (authority?.suggestion?.action !== 'changes') {
    fail('ACTION_MISMATCH', '这条建议不是生成修改建议动作');
  }
  const suggestion = authority.suggestion;
  // The public unified task edits only the canonical evidence file selected by
  // Navigation. Main turns those frozen evidence locators into request-local
  // ranges; the model never repeats source text, paths, revisions or offsets.
  const targetPaths = [suggestion.evidence[0].relativePath];
  const targetSet = new Set(targetPaths);
  if (suggestion.evidence.some(evidence => !targetSet.has(evidence.relativePath))) {
    fail('ACTION_SCOPE_MISMATCH', '这条建议跨越多个正文文件，不能直接生成局部修改');
  }
  const structuredRangeSelections = suggestion.evidence.map(evidence => ({
    path: evidence.relativePath,
    revision: evidence.revision,
    start: evidence.locator?.offset,
    end: evidence.locator?.endOffset,
  }));
  const contextPaths = [...new Set([
    ...extraContextPaths,
    ...authority.record.sources.map(item => item.path),
  ])].filter(filePath => !targetSet.has(filePath)).slice(0, 8);
  const instruction = [
    `发现：${suggestion.finding}`,
    `为什么现在处理：${suggestion.whyNow}`,
    `建议动作：${suggestion.recommendedAction}`,
    `预期结果：${suggestion.expectedResult}`,
    ...(adjustment ? [`作者继续调整：${adjustment}`] : []),
  ].join('\n');
  const prepared = projectChangesProposalService.prepareProjectChangesProposal({
    projectService,
    rootPath,
    structuredOutput: true,
    structuredProtocolLines: unifiedWritingTaskService.protocolPromptLines(),
    structuredRangeSelections,
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

function needsSourcesHandoff(preparedHandoff, parsed) {
  if (!preparedHandoff?.provenance || parsed?.kind !== 'needs_sources') {
    fail('INVALID_MODEL_OUTPUT', '统一任务来源恢复结果无效');
  }
  return Object.freeze({
    ok: true,
    kind: 'needs_sources',
    noChanges: true,
    reason: parsed.reason,
    question: parsed.question,
    provenance: preparedHandoff.provenance,
    handoff: Object.freeze({
      schema: RESEARCH_HANDOFF_SCHEMA,
      navigationId: preparedHandoff.provenance.navigationId,
      suggestionId: preparedHandoff.provenance.suggestionId,
      question: parsed.question,
      finding: parsed.reason,
      evidence: preparedHandoff.provenance.evidence,
    }),
  });
}

function finalizeChangesHandoff({ preparedHandoff, parsed, changeSetService }) {
  if (parsed?.kind !== 'changes' || !Array.isArray(parsed.edits)) {
    fail('INVALID_MODEL_OUTPUT', '统一任务修改结果无效');
  }
  const finalized = unifiedWritingTaskService.buildChangeSet({
    snapshots: preparedHandoff.prepared.snapshots,
    ranges: preparedHandoff.prepared.structuredRanges,
    parsed,
    changeSetService,
  });
  if (finalized.noChanges) {
    return Object.freeze({
      ok: true,
      noChanges: true,
      kind: 'changes',
      fileCount: 0,
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
  RESEARCH_HANDOFF_SCHEMA,
  CHANGES_PROVENANCE_SCHEMA,
  WritingNavigationHandoffError,
  revalidateRecord,
  revalidateAuthority,
  prepareChangesHandoff,
  needsSourcesHandoff,
  finalizeChangesHandoff,
});
