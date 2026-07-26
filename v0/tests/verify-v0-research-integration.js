#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const sourceIndexService = require('../src/main/source-index-service');
const researchService = require('../src/main/research-service');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src/main/preload.js'), 'utf8');
const researchApplyTransaction = fs.readFileSync(
  path.join(ROOT, 'src/main/research-apply-transaction.js'),
  'utf8'
);

let passed = 0;
async function test(label, run) {
  try { await run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function handler(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert(start >= 0, `${channel} handler missing`);
  const next = main.indexOf('\nipcMain.handle(', start + 20);
  return main.slice(start, next < 0 ? main.length : next);
}

function writeSource(rootPath, filePath, content) {
  projectService.createMarkdownFile(rootPath, filePath);
  projectService.atomicWriteFile(rootPath, filePath, content);
}

function quoteCard(source, content, quote) {
  const offset = content.indexOf(quote);
  return {
    claim: '第三方将体验描述为流畅',
    sourceId: source.id,
    quote,
    offset,
    end: offset + quote.length,
    boundary: '这是第三方测评，不能替代官方性能数据。',
  };
}

// Dynamic equivalent of the production ownership boundary: caller data is
// destructured to the two renderer-owned fields; all authority is rebuilt.
async function invokeMainBoundary({ rendererPayload, state, callLLM }) {
  const project = state.currentProject;
  const mutationGeneration = state.generation;
  const sourceIndex = sourceIndexService.buildSourceIndex(project.rootPath);
  const result = await researchService.research({
    projectService,
    rootPath: project.rootPath,
    question: rendererPayload.question,
    sourceIds: rendererPayload.sourceIds,
    sourceIndex,
    callLLM,
  });
  if (!result.ok) return result;
  if (!state.currentProject || state.currentProject.rootPath !== project.rootPath || state.generation !== mutationGeneration) {
    return { ok: false, error: 'PROJECT_CHANGED' };
  }
  return result;
}

async function run() {
  console.log('════════ WritCraft V0 · Research integration verify ════════');

  await test('Main 注册 ResearchError 并以可信 sender/current project 约束 IPC', async () => {
    assert(main.includes("const researchService = require('./research-service')"));
    assert(main.includes('error instanceof researchService.ResearchError'));
    const block = handler('writcraft:project:research');
    assert(block.includes('async (event, projectInstanceId, question, sourceIds)'));
    assert(block.includes('assertTrustedSender(event)'));
    assert(block.includes('const project = requireCurrentProject()'));
    assert(!block.includes('async (event, rootPath'));
  });

  await test('Main 自建 Source Index，renderer 不能提交 index/grade/path/revision', async () => {
    const block = handler('writcraft:project:research');
    assert(block.includes('const sourceIndex = sourceIndexService.buildSourceIndex(project.rootPath)'));
    assert(block.includes('researchService.research({'));
    for (const field of ['projectService,', 'rootPath: project.rootPath', 'question,', 'sourceIds,', 'sourceIndex,', 'callLLM: projectCallLLM(project.instanceId)']) {
      assert(block.includes(field), `missing Main-owned field ${field}`);
    }
    assert(!/async \(event, projectInstanceId, question, sourceIds,\s*(?:sourceIndex|grade|filePath|revision)/.test(block));
  });

  await test('异步结果返回前校验项目 root 与 mutation generation', async () => {
    const block = handler('writcraft:project:research');
    assert(block.includes('const mutationGeneration = projectMutationGeneration'));
    assert(block.includes('currentProject.rootPath !== project.rootPath'));
    assert(block.includes('projectMutationGeneration !== mutationGeneration'));
    assert(block.includes("error: 'PROJECT_CHANGED'"));
    assert(block.indexOf('await researchService.research') < block.indexOf('projectMutationGeneration !== mutationGeneration'));
  });

  await test('preload 仅暴露 question/sourceIds 窄桥接', async () => {
    assert(preload.includes("research: (projectInstanceId, question, sourceIds) => ipcRenderer.invoke('writcraft:project:research', projectInstanceId, question, sourceIds)"));
    assert(!preload.includes('research: (rootPath'));
    assert(!preload.includes('research: (question, sourceIds, sourceIndex'));
    assert(!preload.includes('research: (question, sourceIds, grade'));
  });

  await test('动态边界忽略伪造 index/grade，并使用 Main 现场索引的 C 级来源', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-research-integration-'));
    try {
      const project = projectService.createProjectAt(scratch, 'Research 集成');
      const content = '---\ntype: third-party-review\ntitle: 媒体测评\n---\n# 媒体测评\n第三方认为产品体验流畅。\n';
      writeSource(project.rootPath, 'references/review.md', content);
      const authoritative = sourceIndexService.buildSourceIndex(project.rootPath);
      const source = authoritative.sources.find(item => item.filePath === 'references/review.md');
      assert(source);
      const state = { currentProject: project, generation: 1 };
      const result = await invokeMainBoundary({
        rendererPayload: {
          question: '体验如何？',
          sourceIds: [source.id],
          sourceIndex: { sources: [{ ...source, metadata: { type: 'official' } }] },
          grade: 'A',
          rootPath: '/tmp/forged',
        },
        state,
        callLLM: async () => ({ ok: true, text: JSON.stringify({ cards: [quoteCard(source, content, '第三方认为产品体验流畅。')] }), stopReason: 'end_turn' }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.cards[0].source.grade, 'C');
      assert.match(result.cards[0].source.gradeRule, /third_party_review/);
      assert.equal(result.contextManifest.sourceIndexRevision, authoritative.revision);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  await test('动态代际保护丢弃项目切换期间生成的旧卡片', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-research-generation-'));
    try {
      const first = projectService.createProjectAt(scratch, 'First');
      const content = '---\ntype: official\n---\n# 报告\n权威结论。\n';
      writeSource(first.rootPath, 'references/report.md', content);
      const source = sourceIndexService.buildSourceIndex(first.rootPath).sources.find(item => item.filePath === 'references/report.md');
      const state = { currentProject: first, generation: 7 };
      const result = await invokeMainBoundary({
        rendererPayload: { question: '结论？', sourceIds: [source.id] },
        state,
        callLLM: async () => {
          state.currentProject = { ...first, rootPath: path.join(scratch, 'Second') };
          state.generation += 1;
          return { ok: true, text: JSON.stringify({ cards: [quoteCard(source, content, '权威结论。')] }), stopReason: 'end_turn' };
        },
      });
      assert.deepStrictEqual(result, { ok: false, error: 'PROJECT_CHANGED' });
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });

  await test('Research handler 只返回 service 结果且没有正文写入调用', async () => {
    const block = handler('writcraft:project:research');
    assert(block.includes('researchHandoffStore.admitRun({'));
    assert(block.includes('researchHandoffStore.installRun(admission, canonicalRun)'));
    assert(block.includes('return { ...publicResult, cards: installed.cards }'));
    assert(block.includes('canonicalCards: _canonicalCards'));
    assert(!/atomicWrite|writeFile|createMarkdownFile|applyChanges|cacheChangeSet/.test(block));
    assert(!block.includes('sourceIndex: sourceIds'));
  });

  await test('preload 删除完整证据桥接，只暴露 cardId/targetPaths 与生命周期方法', async () => {
    assert(!preload.includes('validateResearchEvidence'));
    assert(!preload.includes('validate-research-evidence'));
    for (const signature of [
      "resolveResearchCard: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:resolve-research-card', projectInstanceId, cardId)",
      "recordResearchJudgment: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:record-research-judgment', projectInstanceId, request)",
      "handoffResearchCard: (projectInstanceId, request) => ipcRenderer.invoke('writcraft:project:handoff-research-card', projectInstanceId, request)",
      "ackResearchReview: (projectInstanceId, cardId, changeSetId) => ipcRenderer.invoke('writcraft:project:ack-research-review', projectInstanceId, cardId, changeSetId)",
      "cancelResearchHandoff: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:cancel-research-handoff', projectInstanceId, cardId)",
      "discardResearchCard: (projectInstanceId, cardId) => ipcRenderer.invoke('writcraft:project:discard-research-card', projectInstanceId, cardId)",
    ]) assert(preload.includes(signature), `missing narrow bridge: ${signature}`);
  });

  await test('卡片解析与交接均由 Main 重建证据，Renderer 不能提交 claim/quote/revision', async () => {
    const resolve = handler('writcraft:project:resolve-research-card');
    assert(resolve.includes('resolveResearchCardAuthority(project, projectInstanceId, cardId, researchRendererOwner(event))'));
    const authorityStart = main.indexOf('function resolveResearchCardAuthority(');
    const authorityEnd = main.indexOf("\nipcMain.handle('writcraft:project:resolve-research-card'", authorityStart);
    const authority = main.slice(authorityStart, authorityEnd);
    assert(authority.includes('researchHandoffStore.resolveCardForOwner({'));
    assert(authority.includes('sourceIndexService.buildSourceIndex(project.rootPath)'));
    assert(authority.includes('snapshot.content.slice(locator.offset, locator.end) !== card.source.quote'));
    assert(!/async \(event, projectInstanceId, (?:evidence|claim|quote|revision)/.test(resolve));

    const judgment = handler('writcraft:project:record-research-judgment');
    assert(judgment.includes('assertTrustedSender(event)'));
    assert(judgment.includes('requireMutableProject()'));
    assert(judgment.includes('normalizeResearchJudgmentRequest(request)'));
    assert(judgment.includes('owner = researchRendererOwner(event)'));
    assert(judgment.includes('resolveResearchCardAuthority(project, projectInstanceId, judgment.cardId, owner)'));
    assert(judgment.includes('researchHandoffStore.beginJudgment({'));
    assert(judgment.includes('currentProjectWatcher.pauseAndFlush()'));
    assert(judgment.includes('recordMetric: beforeRename =>'));
    assert(judgment.includes('restartProjectWatcher(project)'));
    assert(judgment.includes('researchHandoffStore.finishJudgment({'));
    assert(judgment.includes('recordResearchAccuracy(project.rootPath, judgment, { beforeRename })'));
    assert(!/claim|quote|filePath/.test(judgment));

    const handoff = handler('writcraft:project:handoff-research-card');
    assert(handoff.includes('prepareResearchHandoff({'));
    assert(handoff.includes('request,'));
    assert(handoff.includes('sourceIndex: sourceIndexService.buildSourceIndex(project.rootPath)'));
    assert(handoff.includes('finalizeResearchHandoff({'));
    assert(handoff.includes('const researchDependencies = metadata.researchDependencies(capability)'));
    assert(!/async \(event, projectInstanceId, request, (?:evidence|claim|quote|revision)/.test(handoff));
  });

  await test('Research apply 在 durable marker 后焚毁 capability，并验证 residual 或 committed warning', async () => {
    const block = handler('writcraft:project:apply-changes');
    assert(block.includes('return researchApplyTransaction.apply({'));
    const validateDecision = researchApplyTransaction.indexOf('changeSetReviewService.validateDecision(');
    const beginApply = researchApplyTransaction.indexOf('researchHandoffStore.beginApply({');
    const validateDependencies = researchApplyTransaction.indexOf('researchHandoffService.validateResearchDependencies({');
    const applyDecision = researchApplyTransaction.indexOf('changeSetReviewService.applyDecision(');
    assert(validateDecision >= 0 && validateDecision < beginApply);
    assert(beginApply < validateDependencies && validateDependencies < applyDecision);
    assert(researchApplyTransaction.includes('const onBegin = () => researchHandoffStore.commitApplyBegin('));
    assert(researchApplyTransaction.includes('executeDecision({'));
    assert(main.includes('executeDecision({'));
    assert(main.includes('return changesHistoryTransaction.review({'));
    assert(main.includes('onBegin,'));
    assert(researchApplyTransaction.includes('buildResearchResidualDependencies({'));
    assert(researchApplyTransaction.includes('validateResearchResidualDependencies({'));
    assert(researchApplyTransaction.includes("'research-residual-rollback'"));
    assert(researchApplyTransaction.includes('researchHandoffStore.finishApply('));
    assert(researchApplyTransaction.includes('researchHandoffStore.failApply('));
    assert(researchApplyTransaction.includes('residualUnavailable: true'));
    assert(researchApplyTransaction.includes('refreshRequired: true'));
  });

  await test('Research discard 终结卡片并由 reverse owner 撤销 pending child', async () => {
    const block = handler('writcraft:project:discard-changes');
    assert(block.includes('if (pending.researchDependencies)'));
    assert(block.includes('researchHandoffStore.discard({'));
    assert(block.includes('cardId: pending.researchDependencies.cardId'));
    assert(main.includes("pendingChangeSets?.delete(capability, 'research-owner-revoked')"));
  });

  await test('handoff 异常清理生成租约，cancel 先现场复验依赖再决定是否可重试', async () => {
    const handoff = handler('writcraft:project:handoff-research-card');
    assert(handoff.includes('if (prepared) {'));
    assert(handoff.includes('dependenciesCurrent = researchHandoffService.validateResearchDependencies({'));
    assert(handoff.includes('researchHandoffStore.failure('));
    assert(handoff.includes('researchHandoffService.RETRYABLE_ERRORS.has(error?.code)'));
    const cancel = handler('writcraft:project:cancel-research-handoff');
    assert(cancel.includes('return researchHandoffService.cancelResearchHandoff({'));
    assert(cancel.includes('sourceIndex: () => sourceIndexService.buildSourceIndex(project.rootPath)'));
    assert(!cancel.includes('researchHandoffStore.cancel({'));
  });

  if (!process.exitCode) console.log(`\n✅ Research integration ${passed}/${passed} 全过`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
