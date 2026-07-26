#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
  analyzeProject: engineAnalyzeProject,
  mergeAnalyzedGraphs,
} = require(path.join(__dirname, '..', 'src/main/consistency-engine.js'));

function analyzeProject(files, options = {}) {
  return engineAnalyzeProject(files, { capturedAt: '2026-07-21T00:00:00.000Z', ...options });
}

let passed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function issue(graph, type) {
  return graph.issues.find(item => item.type === type);
}

console.log('════════ WritCraft V0 · Writing diagnostics verify ════════');

check('evidence_gap 只响应明确待补来源标记', () => {
  const content = '# 市场分析\n\n用户规模已经达到一千万。【待补来源】\n';
  const graph = analyzeProject([{ path: 'chapters/market.md', revision: 'rev-market-1', content }]);
  const gap = issue(graph, 'evidence_gap');
  assert(gap);
  assert.equal(gap.severity, 'warning');
  assert.equal(gap.status, 'open');
  assert.equal(gap.evidenceIds.length, 1);
  assert.equal(gap.confidence, 1);
  assert.equal(Object.hasOwn(gap, 'fix'), false);
  const evidence = graph.evidence.find(item => item.id === gap.evidenceIds[0]);
  assert.equal(evidence.path, 'chapters/market.md');
  assert.equal(evidence.revision, 'rev-market-1');
  assert.equal(content.slice(evidence.start, evidence.end), evidence.quote);
  assert.match(evidence.quote, /待补来源/);
});

check('evidence_gap 逻辑 ID 不随前文 offset/revision 变化', () => {
  const first = analyzeProject([{
    path: 'chapters/market.md', revision: 'r1',
    content: '# 市场分析\n\n规模为一千万。[待补来源]\n',
  }]);
  const second = analyzeProject([{
    path: 'chapters/market.md', revision: 'r2',
    content: '引言。\n\n# 市场分析\n\n更新表述，规模为一千万。[待补来源]\n',
  }]);
  const firstIssue = issue(first, 'evidence_gap');
  const secondIssue = issue(second, 'evidence_gap');
  assert.equal(secondIssue.id, firstIssue.id);
  assert.notDeepEqual(secondIssue.evidenceIds, firstIssue.evidenceIds);
  const firstEvidence = first.evidence.find(item => item.id === firstIssue.evidenceIds[0]);
  const secondEvidence = second.evidence.find(item => item.id === secondIssue.evidenceIds[0]);
  assert.notEqual(secondEvidence.start, firstEvidence.start);
  assert.equal(secondEvidence.revision, 'r2');
});

check('普通数字论断、Front Matter、代码块与 edit.md 占位不误报', () => {
  const graph = analyzeProject([
    { path: 'chapters/plain.md', revision: '1', content: '# 数据\n用户规模为 1000 万，该结论没有显式标记。\n' },
    { path: 'chapters/code.md', revision: '2', content: '---\nnote: [待补来源]\n---\n```md\n数据【待补来源】\n```\n' },
    { path: 'edit.md', revision: '3', content: '# 来源规则\n[待补来源]\n' },
  ]);
  assert.equal(graph.issues.filter(item => item.type === 'evidence_gap').length, 0);
});

check('prompt_drift 仅在 edit.md 明确排除与正文主题精确重合时触发', () => {
  const files = [
    { path: 'edit.md', revision: 'prompt-r1', content: '# 范围与非目标\n\n禁止主题：广告\n' },
    { path: 'chapters/ad.md', revision: 'chapter-r1', content: '# 广告\n\n本章讨论广告投放。\n' },
  ];
  const graph = analyzeProject(files);
  const drift = issue(graph, 'prompt_drift');
  assert(drift);
  assert.equal(drift.severity, 'warning');
  assert.equal(drift.confidence, 0.99);
  assert.equal(drift.evidenceIds.length, 2);
  assert.equal(Object.hasOwn(drift, 'fix'), false);
  const evidence = drift.evidenceIds.map(id => graph.evidence.find(item => item.id === id));
  assert.deepEqual(evidence.map(item => item.path).sort(), ['chapters/ad.md', 'edit.md']);
  for (const item of evidence) {
    const file = files.find(entry => entry.path === item.path);
    assert.equal(item.revision, file.revision);
    assert.equal(file.content.slice(item.start, item.end), item.quote);
  }
});

check('prompt_drift 支持明确章节主题声明与多个排除主题', () => {
  const graph = analyzeProject([
    { path: 'edit.md', revision: '1', content: '# 非目标\n- 不写：广告、财经投资\n' },
    { path: 'chapters/money.md', revision: '2', content: '# 第三章\n本章主题：财经投资\n' },
  ]);
  const drift = issue(graph, 'prompt_drift');
  assert(drift);
  assert.match(drift.message, /财经投资/);
});

check('prompt_drift 问题 ID 在同文件/同主题移动后稳定', () => {
  const prompt1 = { path: 'edit.md', revision: 'p1', content: '禁止主题：广告\n' };
  const prompt2 = { path: 'edit.md', revision: 'p2', content: '# 新增说明\n\n禁止主题：广告\n' };
  const chapter1 = { path: 'chapters/a.md', revision: 'c1', content: '# 广告\n正文\n' };
  const chapter2 = { path: 'chapters/a.md', revision: 'c2', content: '引言\n\n# 广告\n更新正文\n' };
  const first = issue(analyzeProject([prompt1, chapter1]), 'prompt_drift');
  const second = issue(analyzeProject([prompt2, chapter2]), 'prompt_drift');
  assert.equal(second.id, first.id);
  assert.notDeepEqual(second.evidenceIds, first.evidenceIds);
});

check('仅在普通正文提及、子串相似或 edit.md 无显式指令时不报 drift', () => {
  const graph = analyzeProject([
    { path: 'edit.md', revision: '1', content: '# 范围\n我们暂时不想讨论广告，但这不是结构化指令。\n' },
    { path: 'chapters/a.md', revision: '2', content: '# 广告行业\n正文中提到广告，但不声明这是章节主题。\n' },
  ]);
  assert.equal(graph.issues.filter(item => item.type === 'prompt_drift').length, 0);

  const exactDirectiveButMentionOnly = analyzeProject([
    { path: 'edit.md', revision: '3', content: '排除主题：广告\n' },
    { path: 'chapters/b.md', revision: '4', content: '# 第一章\n这里只在普通句子里提到广告。\n' },
  ]);
  assert.equal(exactDirectiveButMentionOnly.issues.filter(item => item.type === 'prompt_drift').length, 0);
});

check('每文件独立贡献 merge 后重算跨文件 prompt_drift', () => {
  const edit = { path: 'edit.md', revision: 'p1', content: '# 范围\n非目标：广告\n' };
  const chapter = { path: 'chapters/ad.md', revision: 'c1', content: '# 广告\n正文\n' };
  const direct = analyzeProject([edit, chapter]);
  const editContribution = analyzeProject([edit]);
  const chapterContribution = analyzeProject([chapter]);
  assert.equal(editContribution.issues.some(item => item.type === 'prompt_drift'), false);
  assert.equal(chapterContribution.issues.some(item => item.type === 'prompt_drift'), false);
  const merged = mergeAnalyzedGraphs([chapterContribution, editContribution]);
  const directIssue = issue(direct, 'prompt_drift');
  const mergedIssue = issue(merged, 'prompt_drift');
  assert.deepEqual(mergedIssue, directIssue);
  assert.deepEqual(merged.evidence, direct.evidence);
});

check('文件修改后 merge 重算会移除已不存在的诊断', () => {
  const prompt = analyzeProject([{ path: 'edit.md', revision: 'p1', content: '禁止主题：广告\n' }]);
  const before = analyzeProject([{ path: 'chapters/a.md', revision: 'c1', content: '# 广告\n' }]);
  const after = analyzeProject([{ path: 'chapters/a.md', revision: 'c2', content: '# 产品设计\n' }]);
  assert(issue(mergeAnalyzedGraphs([prompt, before]), 'prompt_drift'));
  assert.equal(issue(mergeAnalyzedGraphs([prompt, after]), 'prompt_drift'), undefined);
});

check('输入顺序不影响问题 ID 和稳定排序', () => {
  const files = [
    { path: 'edit.md', revision: '1', content: '排除主题：广告\n' },
    { path: 'chapters/a.md', revision: '2', content: '# 广告\n数据。[citation needed]\n' },
  ];
  const first = analyzeProject(files);
  const second = analyzeProject([...files].reverse());
  assert.deepEqual(second, first);
  assert.deepEqual(first.issues.map(item => item.id), [...first.issues.map(item => item.id)].sort());
});

if (!process.exitCode) console.log(`\n✅ 写作诊断 ${passed}/${passed} 全过`);
