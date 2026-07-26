#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const {
  analyzeProject: engineAnalyzeProject,
  mergeAnalyzedGraphs,
  detectGraphIssues,
  MAX_EVOLUTION_PATHS,
} = require(path.join(__dirname, '../src/main/consistency-engine.js'));

const CAPTURED_AT = '2026-07-21T00:00:00.000Z';
function analyzeProject(files) {
  return engineAnalyzeProject(files, { capturedAt: CAPTURED_AT });
}

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function issues(graph, type) {
  return graph.issues.filter(issue => issue.type === type);
}

console.log('════════ WritCraft V0 · Graph issue types and evolution verify ════════');

check('claim_conflict 只由同端点显式支持/反驳事实触发并绑定双证据', () => {
  const graph = analyzeProject([
    { path: 'chapters/support.md', revision: 's1', content: '甲支持乙。\n' },
    { path: 'chapters/contradict.md', revision: 'c1', content: '甲反驳乙。\n' },
  ]);
  const conflict = issues(graph, 'claim_conflict')[0];
  assert(conflict);
  assert.equal(conflict.details.kind, 'explicit_polarity');
  assert.equal(conflict.edgeIds.length, 2);
  assert.equal(conflict.evidenceIds.length, 2);
  assert.deepEqual(new Set(conflict.edgeIds.map(id => graph.edges.find(edge => edge.id === id).relation)), new Set(['supports', 'contradicts']));
});

check('单边论断、不同端点与普通提及不误报 claim_conflict', () => {
  const graph = analyzeProject([
    { path: 'a.md', revision: '1', content: '甲支持乙。\n' },
    { path: 'b.md', revision: '2', content: '甲反驳丙。\n' },
    { path: 'c.md', revision: '3', content: '作者讨论了甲、乙之间是否相互支持。\n' },
  ]);
  assert.equal(issues(graph, 'claim_conflict').length, 0);
});

check('claim_conflict 拒绝低置信、非显式或单证据的伪冲突', () => {
  const graph = analyzeProject([
    { path: 'a.md', revision: '1', content: '甲支持乙。\n' },
    { path: 'b.md', revision: '2', content: '甲反驳乙。\n' },
  ]);
  const lowConfidence = graph.edges.map(edge => edge.relation === 'contradicts' ? { ...edge, confidence: 0.89 } : edge);
  assert.equal(detectGraphIssues(graph.nodes, lowConfidence, graph.evidence).filter(item => item.type === 'claim_conflict').length, 0);
  const notExplicit = graph.edges.map(edge => edge.relation === 'supports' ? { ...edge, assertionMode: 'inferred' } : edge);
  assert.equal(detectGraphIssues(graph.nodes, notExplicit, graph.evidence).filter(item => item.type === 'claim_conflict').length, 0);
  const supportEvidence = graph.edges.find(edge => edge.relation === 'supports').evidenceIds;
  const oneEvidence = graph.edges.map(edge => ({ ...edge, evidenceIds: [...supportEvidence] }));
  assert.equal(detectGraphIssues(graph.nodes, oneEvidence, graph.evidence).filter(item => item.type === 'claim_conflict').length, 0);
});

check('Front Matter、```/~~~ 围栏与缩进代码中的论断不触发 claim_conflict', () => {
  const graph = analyzeProject([{
    path: 'hidden.md', revision: '1',
    content: [
      '---', 'claims:', ' - 甲支持乙。', ' - 甲反驳乙。', '---',
      '~~~md', '甲支持乙。', '甲反驳乙。', '~~~',
      '```md', '甲支持乙。', '甲反驳乙。', '```',
      '```text', '~~~', '甲支持乙。', '甲反驳乙。', '~~~', '```',
      '~~~text', '```', '甲支持乙。', '甲反驳乙。', '```', '~~~',
      '````text', '```', '甲支持乙。', '甲反驳乙。', '```', '````',
      '~~~~text', '~~~', '甲支持乙。', '甲反驳乙。', '~~~', '~~~~',
      '    甲支持乙。', '    甲反驳乙。', '\t甲支持乙。', '\t甲反驳乙。', '',
      '    - 甲支持乙。', '    - 甲反驳乙。', '\t- 甲支持乙。', '\t- 甲反驳乙。',
    ].join('\n'),
  }]);
  assert.equal(issues(graph, 'claim_conflict').length, 0);
  assert.equal(graph.edges.filter(edge => ['supports', 'contradicts'].includes(edge.relation)).length, 0);
});

check('unresolved_foreshadow 只响应显式伏笔标记，出现显式回收后消失', () => {
  const declared = { path: 'chapters/one.md', revision: 'f1', content: '伏笔：红色钥匙\n' };
  const unresolved = analyzeProject([declared]);
  const issue = issues(unresolved, 'unresolved_foreshadow')[0];
  assert(issue);
  assert.equal(issue.details.kind, 'explicit_marker');
  assert.equal(issue.evidenceIds.length, 1);
  const resolved = analyzeProject([
    declared,
    { path: 'chapters/end.md', revision: 'f2', content: '回应伏笔：红色钥匙\n' },
  ]);
  assert.equal(issues(resolved, 'unresolved_foreshadow').length, 0);
});

check('嵌套列表中的伏笔、回收与人物声明保持可见且保留诊断语义', () => {
  const unresolved = analyzeProject([{
    path: 'nested.md', revision: '1', content: '- 设定\n    - 伏笔：旧怀表\n\t1. 人物：林舟\n',
  }]);
  assert.equal(issues(unresolved, 'unresolved_foreshadow').length, 1);
  assert(issues(unresolved, 'orphan_entity').some(issue =>
    unresolved.nodes.find(node => node.id === issue.nodeIds[0])?.label === '林舟'));
  const resolved = analyzeProject([{
    path: 'nested.md', revision: '2', content: '- 设定\n    - 伏笔：旧怀表\n    - 回应伏笔：旧怀表\n',
  }]);
  assert.equal(issues(resolved, 'unresolved_foreshadow').length, 0);
});

check('普通叙述、Front Matter、围栏与缩进代码不触发 unresolved_foreshadow', () => {
  const graph = analyzeProject([{
    path: 'chapters/plain.md', revision: '1',
    content: '---\nnote: 伏笔：钥匙\n---\n这里也许是一个伏笔，但没有结构化声明。\n```md\n伏笔：代码示例\n```\n~~~md\n伏笔：波浪围栏\n~~~\n```text\n~~~\n伏笔：混合围栏\n~~~\n```\n    伏笔：缩进示例\n\t伏笔：制表示例\n    - 伏笔：根缩进列表代码\n\t- 伏笔：根制表列表代码\n',
  }]);
  assert.equal(issues(graph, 'unresolved_foreshadow').length, 0);
});

check('orphan_entity 只报告显式声明且无语义关系的人物/组织/地点/变量', () => {
  const graph = analyzeProject([{
    path: 'cast.md', revision: '1',
    content: '人物：林舟\n组织：编辑部\n地点：北岸码头\n变量：等待时间\n“远方”只是意象。\nDarwin appears in prose.\n',
  }]);
  const labels = issues(graph, 'orphan_entity')
    .map(issue => graph.nodes.find(node => node.id === issue.nodeIds[0])?.label)
    .sort();
  assert.deepEqual(labels, ['北岸码头', '林舟', '等待时间', '编辑部'].sort());
  assert(issues(graph, 'orphan_entity').every(issue => issue.severity === 'info' && issue.evidenceIds.length >= 1));
  assert(!labels.includes('远方'));
  assert(!labels.includes('Darwin'));
});

check('显式节点建立任一语义关系后不再被视为孤立', () => {
  const graph = analyzeProject([{
    path: 'cast.md', revision: '1',
    content: '人物：林舟\n组织：编辑部\n林舟属于编辑部。\n',
  }]);
  assert.equal(issues(graph, 'orphan_entity').length, 0);
});

check('显式声明列表拆成独立中英文节点，单项语义保持不变', () => {
  const graph = analyzeProject([{
    path: 'cast.md', revision: '1',
    content: '人物：林舟、夏雨\n人物: Alice, Bob\n组织：编辑部\n',
  }]);
  const declared = graph.nodes.filter(node => node.explicitDeclaration).map(node => [node.type, node.label]).sort();
  assert.deepEqual(declared, [
    ['organization', '编辑部'], ['person', 'Alice'], ['person', 'Bob'], ['person', '夏雨'], ['person', '林舟'],
  ].sort());
  assert(!graph.nodes.some(node => ['林舟、夏雨', 'Alice, Bob'].includes(node.label)));
});

check('Front Matter、围栏与缩进代码中的声明不触发 orphan_entity', () => {
  const graph = analyzeProject([{
    path: 'hidden.md', revision: '1',
    content: '---\n人物：配置角色\n---\n~~~md\n组织：示例机构\n~~~\n```md\n地点：示例地点\n```\n~~~text\n```\n人物：混合围栏角色\n```\n~~~\n    变量：缩进变量\n\t人物：制表人物\n    - 人物：根缩进列表角色\n\t- 组织：根制表列表组织\n',
  }]);
  assert.equal(issues(graph, 'orphan_entity').length, 0);
  assert.equal(graph.nodes.filter(node => node.explicitDeclaration).length, 0);
});

check('全部抽取器共享可见正文边界，不索引隐藏标题、引号、日期或变量定义', () => {
  const hiddenDefinition = '系统甲记录的是五分钟，系统乙记录的则是十分钟。两个指标被称为“等待时间”。';
  const graph = analyzeProject([{
    path: 'hidden.md', revision: '1',
    content: [
      '---', '# 元数据标题', 'name: “元数据实体”', 'date: 2026-01-01', hiddenDefinition, '---',
      '~~~md', '# 围栏标题', '“围栏实体”', '2027-01-01', hiddenDefinition, '~~~',
      '```text', '~~~', '# 混合围栏标题', '“混合围栏实体”', '2029-01-01', hiddenDefinition, '~~~', '```',
      '    # 缩进标题', '    “缩进实体”', '    2028-01-01', `    ${hiddenDefinition}`, '',
    ].join('\n'),
  }]);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.issues.length, 0);
});

check('空白行或退缩正文关闭列表上下文，后续根缩进列表仍按代码处理', () => {
  const graph = analyzeProject([{
    path: 'closed-list.md', revision: '1',
    content: '- 父列表\n\n    - 伏笔：空白后代码\n- 第二列表\n正文退缩。\n    - 人物：退缩后代码\n',
  }]);
  assert.equal(issues(graph, 'unresolved_foreshadow').length, 0);
  assert.equal(issues(graph, 'orphan_entity').length, 0);
});

check('独立文件贡献合并会重算三类跨文件诊断且与直接分析一致', () => {
  const files = [
    { path: 'a.md', revision: '1', content: '甲支持乙。\n伏笔：旧怀表\n' },
    { path: 'b.md', revision: '2', content: '甲否定乙。\n人物：林舟\n' },
  ];
  const direct = analyzeProject(files);
  const merged = mergeAnalyzedGraphs(files.map(file => analyzeProject([file])).reverse());
  assert.deepEqual(merged.nodes, direct.nodes);
  assert.deepEqual(merged.edges, direct.edges);
  assert.deepEqual(merged.evidence, direct.evidence);
  assert.deepEqual(merged.issues, direct.issues);
  for (const type of ['claim_conflict', 'unresolved_foreshadow', 'orphan_entity']) assert(issues(merged, type).length > 0);
});

check('edge evolution 有界、稳定并只按证据路径表达跨文件出现', () => {
  const files = Array.from({ length: MAX_EVOLUTION_PATHS + 8 }, (_, index) => ({
    path: `chapters/${String(index).padStart(2, '0')}.md`,
    revision: `r${index}`,
    content: '甲支持乙。\n',
  }));
  const direct = analyzeProject(files);
  const edge = direct.edges.find(item => item.relation === 'supports');
  assert(edge);
  assert.equal(edge.evolution.evidenceCount, files.length);
  assert.equal(edge.evolution.pathCount, files.length);
  assert.equal(edge.evolution.paths.length, MAX_EVOLUTION_PATHS);
  assert.equal(edge.evolution.firstPath, 'chapters/00.md');
  assert.equal(edge.evolution.lastPath, `chapters/${files.length - 1}.md`);
  assert.deepEqual(edge.evolution.paths, [...edge.evolution.paths].sort());
  const merged = mergeAnalyzedGraphs(files.map(file => analyzeProject([file])).reverse());
  assert.deepEqual(merged.edges, direct.edges);
  assert.deepEqual(analyzeProject([...files].reverse()).edges, direct.edges);
});

if (!process.exitCode) console.log(`\n✅ Graph issue types / evolution ${passed}/${passed} 全过`);
