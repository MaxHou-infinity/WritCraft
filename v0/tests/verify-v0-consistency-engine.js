#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const {
  analyzeProject: engineAnalyzeProject,
  mergeAnalyzedGraphs,
  detectGraphIssues,
  parseStatement,
  SCHEMA,
  NODE_TYPES,
  EDGE_TYPES,
  ISSUE_TYPES,
} = require(path.join(__dirname, '../src/main/consistency-engine.js'));

const CAPTURED_AT = '2026-07-21T00:00:00.000Z';
function analyzeProject(files, options = {}) {
  return engineAnalyzeProject(files, { capturedAt: CAPTURED_AT, ...options });
}

let passed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed += 1; }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}

console.log('════════ WritCraft V0 · Consistency Engine verify ════════');

const files = [
  { path: 'chapter-1.md', revision: 'r2', content: '# 第一章\n张三位于上海。\n张三出生于1991年。\n甲早于乙。\n乙早于丙。\n丙早于甲。\n“秘密计划”发生于2028-03-01。' },
  { path: 'edit.md', revision: 'r1', content: '# 项目约束\n张三位于北京。\n张三出生于1990年。' }
];

check('输出固定 v2 schema，数组与 manifest 完整', () => {
  const graph = analyzeProject(files);
  assert.equal(graph.schema, SCHEMA);
  for (const key of ['nodes', 'edges', 'evidence', 'issues']) assert(Array.isArray(graph[key]));
  assert.equal(graph.manifest.schema, SCHEMA);
  assert.equal(graph.manifest.stats.files, 2);
});

check('Node / Edge / Evidence / Issue 遵守 v2 契约', () => {
  const graph = analyzeProject(files);
  for (const node of graph.nodes) {
    assert(NODE_TYPES.includes(node.type));
    assert.equal(typeof node.label, 'string');
    assert(Array.isArray(node.aliases));
    assert(node.attributes && typeof node.attributes === 'object');
    assert.equal(typeof node.summary, 'string');
    assert.equal(typeof node.explicitDeclaration, 'boolean');
    assert(Array.isArray(node.declarationEvidenceIds));
    assert(Array.isArray(node.declarationTypes));
    assert.equal(node.status, 'proposed');
    assert.equal(node.updatedAt, CAPTURED_AT);
    assert(node.confidence >= 0 && node.confidence <= 1);
  }
  for (const edge of graph.edges) {
    assert(EDGE_TYPES.includes(edge.type));
    assert.equal(edge.directed, true);
    assert.equal(typeof edge.label, 'string');
    assert.equal(typeof edge.relation, 'string');
    assert.equal(edge.status, 'proposed');
    assert.deepStrictEqual(Object.keys(edge.evolution).sort(), ['evidenceCount', 'firstPath', 'lastPath', 'pathCount', 'paths']);
    assert.equal(edge.evolution.evidenceCount, edge.evidenceIds.length);
    assert(Array.isArray(edge.evolution.paths));
  }
  for (const evidence of graph.evidence) {
    assert.equal(evidence.filePath, evidence.path);
    assert.match(evidence.blockId, /^blk_[a-f0-9]{16}$/);
    assert.match(evidence.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(evidence.capturedAt, CAPTURED_AT);
    assert.equal(evidence.end - evidence.start, evidence.quote.length);
  }
  for (const issue of graph.issues) {
    assert(ISSUE_TYPES.includes(issue.type));
    assert.equal(typeof issue.title, 'string');
    assert.equal(typeof issue.description, 'string');
    assert.equal(issue.message, issue.description);
    assert.strictEqual(issue.resolution, null);
    assert(issue.details && typeof issue.details === 'object');
  }
});

check('输入顺序变化不影响稳定 ID 与确定排序', () => {
  const first = analyzeProject(files);
  const second = analyzeProject([...files].reverse());
  assert.deepStrictEqual(first, second);
  for (const key of ['nodes', 'edges', 'evidence', 'issues']) {
    assert.deepStrictEqual(first[key].map(item => item.id), [...first[key].map(item => item.id)].sort());
  }
});

check('每条事实都有可回溯且边界准确的证据', () => {
  const graph = analyzeProject(files);
  const byId = new Map(graph.evidence.map(item => [item.id, item]));
  assert(graph.edges.length >= 7);
  for (const edge of graph.edges) {
    assert(edge.evidenceIds.length > 0);
    for (const id of edge.evidenceIds) {
      const evidence = byId.get(id);
      assert(evidence);
      const file = files.find(item => item.path === evidence.path);
      assert.equal(file.content.slice(evidence.start, evidence.end), evidence.quote);
      assert.equal(evidence.revision, file.revision);
      assert(evidence.confidence >= 0 && evidence.confidence <= 1);
    }
  }
});

check('抽取标题、显式时间、引号实体和明确关系', () => {
  const graph = analyzeProject(files);
  assert(graph.nodes.some(node => node.type === 'section' && node.label === '第一章'));
  assert(graph.nodes.some(node => node.type === 'time' && node.label === '2028-03-01'));
  assert(graph.nodes.some(node => node.type === 'event' && node.label === '秘密计划'));
  assert(graph.edges.some(edge => edge.relation === 'occurs_at'));
  assert(graph.edges.some(edge => edge.relation === 'birth'));
  assert(graph.edges.some(edge => edge.relation === 'location'));
});

check('无空格定义关系可抽取，日期主语仍归为 time', () => {
  const graph = analyzeProject([{ path: 'timeline.md', revision: '1', content: '张三是编辑。\n1990年早于2000年。' }]);
  assert(graph.edges.some(edge => edge.relation === 'is'));
  const before = graph.edges.find(edge => edge.relation === 'before');
  const from = graph.nodes.find(node => node.id === before.from);
  assert.equal(from.type, 'time');
  assert.equal(from.label, '1990年');
});

check('属性事实和 edit.md 不变量冲突被标记但不自动修稿', () => {
  const graph = analyzeProject(files);
  const conflicts = graph.issues.filter(issue => issue.type === 'attribute_conflict');
  assert(conflicts.length >= 2);
  assert(conflicts.every(issue => issue.details.kind === 'project_invariant'));
  for (const issue of graph.issues) {
    assert.equal(issue.status, 'open');
    assert(!Object.hasOwn(issue, 'fix'));
    assert(issue.evidenceIds.length >= 2);
    assert(issue.confidence >= 0.9);
  }
});

check('时间早晚闭环被识别', () => {
  const graph = analyzeProject(files);
  const issue = graph.issues.find(item => item.type === 'timeline_conflict' && item.details.kind === 'cycle');
  assert(issue);
  assert.equal(issue.edgeIds.length, 3);
});

check('变量定义、单位或口径漂移进入 variable_drift', () => {
  const graph = analyzeProject([
    { path: 'edit.md', revision: 'r1', content: '等待时间的单位是分钟。' },
    { path: 'chapter.md', revision: 'r2', content: '等待时间的单位是小时。' },
  ]);
  const issue = graph.issues.find(item => item.type === 'variable_drift');
  assert(issue);
  assert.equal(issue.details.property, '单位');
  assert.equal(issue.details.kind, 'project_invariant');
  assert(graph.nodes.some(node => node.type === 'variable' && node.label === '等待时间'));
});

check('跨文件冲突不残留任意权威值，且 merge 顺序无关', () => {
  const minute = analyzeProject([{ path: 'a.md', revision: 'r1', content: '等待时间的单位是分钟。' }]);
  const hour = analyzeProject([{ path: 'b.md', revision: 'r2', content: '等待时间的单位是小时。' }]);
  const forward = mergeAnalyzedGraphs([minute, hour]);
  const reverse = mergeAnalyzedGraphs([hour, minute]);
  assert.deepStrictEqual(forward, reverse);
  const variable = forward.nodes.find(node => node.type === 'variable' && node.label === '等待时间');
  assert(variable);
  assert(!Object.hasOwn(variable.attributes, '单位'));
  assert(forward.issues.some(issue => issue.type === 'variable_drift'));
});

check('冲突值集合变化会产生新 Issue ID', () => {
  const first = analyzeProject([
    { path: 'a.md', revision: 'r1', content: '张三位于北京。' },
    { path: 'b.md', revision: 'r1', content: '张三位于上海。' },
  ]).issues.find(issue => issue.type === 'attribute_conflict');
  const changed = analyzeProject([
    { path: 'a.md', revision: 'r1', content: '张三位于北京。' },
    { path: 'b.md', revision: 'r2', content: '张三位于广州。' },
  ]).issues.find(issue => issue.type === 'attribute_conflict');
  assert(first && changed);
  assert.notEqual(first.id, changed.id);
});

check('身份和职业属性会把主语建模为 person', () => {
  const graph = analyzeProject([
    { path: 'a.md', revision: 'r1', content: '林舟的职业是记者。' },
    { path: 'b.md', revision: 'r2', content: '林舟的职业是编辑。' },
  ]);
  assert(graph.nodes.some(node => node.type === 'person' && node.label === '林舟'));
  assert(graph.issues.some(issue => issue.type === 'attribute_conflict' && issue.details.property === '职业'));
});

check('单断言日期倒置不升格为冲突，不可能区间绑定两条精确证据', () => {
  const content = '2026-03-01早于2026-02-01。\n项目从2026-03-01到2026-02-01。';
  const graph = analyzeProject([{ path: 'timeline.md', revision: 'r1', content }]);
  assert(!graph.issues.some(issue => issue.type === 'timeline_conflict' && issue.details.kind === 'date_order'));
  const interval = graph.issues.find(issue => issue.type === 'timeline_conflict' && issue.details.kind === 'impossible_interval');
  assert(interval);
  assert.equal(interval.evidenceIds.length, 2);
  const evidence = interval.evidenceIds.map(id => graph.evidence.find(item => item.id === id));
  assert.equal(new Set(evidence.map(item => `${item.path}:${item.start}:${item.end}`)).size, 2);
  assert.deepEqual(evidence.map(item => item.quote).sort(), ['从2026-03-01', '到2026-02-01'].sort());
  for (const item of evidence) assert.equal(content.slice(item.start, item.end), item.quote);
});

check('冲突证据门禁拒绝重复 ID、伪造 ID 与不可定位的第二引用', () => {
  const graph = analyzeProject([{ path: 'timeline.md', revision: 'r1', content: '项目从2026-03-01到2026-02-01。' }]);
  const interval = graph.issues.find(issue => issue.details.kind === 'impossible_interval');
  assert(interval);
  const [firstEvidenceId] = interval.evidenceIds;
  const collapsed = graph.edges.map(edge => ['starts_at', 'ends_at'].includes(edge.relation)
    ? { ...edge, evidenceIds: [firstEvidenceId] } : edge);
  assert(!detectGraphIssues(graph.nodes, collapsed, graph.evidence)
    .some(issue => issue.details.kind === 'impossible_interval'));

  const firstEvidence = graph.evidence.find(item => item.id === firstEvidenceId);
  const forgedId = 'ev_ffffffffffffffff';
  const forgedEvidence = { ...firstEvidence, id: forgedId };
  const forgedEdges = graph.edges.map(edge => edge.relation === 'ends_at'
    ? { ...edge, evidenceIds: [forgedId] }
    : edge.relation === 'starts_at' ? { ...edge, evidenceIds: [firstEvidenceId] } : edge);
  assert(!detectGraphIssues(graph.nodes, forgedEdges, [...graph.evidence, forgedEvidence])
    .some(issue => issue.details.kind === 'impossible_interval'));

  const overlappingEvidence = {
    ...firstEvidence,
    id: 'ev_dddddddddddddddd',
    end: firstEvidence.end - 1,
    quote: firstEvidence.quote.slice(0, -1),
  };
  const overlappingEdges = forgedEdges.map(edge => edge.relation === 'ends_at'
    ? { ...edge, evidenceIds: [overlappingEvidence.id] } : edge);
  assert(!detectGraphIssues(graph.nodes, overlappingEdges, [...graph.evidence, overlappingEvidence])
    .some(issue => issue.details.kind === 'impossible_interval'));

  const unlocatable = { ...forgedEvidence, id: 'ev_eeeeeeeeeeeeeeee', quote: '' };
  const unlocatableEdges = forgedEdges.map(edge => edge.relation === 'ends_at'
    ? { ...edge, evidenceIds: [unlocatable.id] } : edge);
  assert(!detectGraphIssues(graph.nodes, unlocatableEdges, [...graph.evidence, unlocatable])
    .some(issue => issue.details.kind === 'impossible_interval'));
});

check('长句叙事不会产生垃圾 value 属性边', () => {
  const prose = '本章的核心不是赞美纸张，而是说明流程为什么失灵。';
  assert.deepStrictEqual(parseStatement(prose), []);
  const graph = analyzeProject([{ path: 'essay.md', revision: 'r1', content: prose }]);
  assert(!graph.edges.some(edge => edge.relation.startsWith('value:')));
});

check('段落前方插入内容后 blockId 与 contentHash 保持稳定', () => {
  const base = '# 第一章\n\n张三位于上海。';
  const shifted = '# 第一章\n\n新插入的无关段落。\n\n张三位于上海。';
  const first = analyzeProject([{ path: 'chapter.md', revision: 'r1', content: base }]);
  const second = analyzeProject([{ path: 'chapter.md', revision: 'r2', content: shifted }]);
  const a = first.evidence.find(item => item.quote === '张三位于上海。');
  const b = second.evidence.find(item => item.quote === '张三位于上海。');
  assert(a && b);
  assert.equal(a.blockId, b.blockId);
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.start, b.start);
});

check('普通叙述不因弱实体候选产生误报警', () => {
  const graph = analyzeProject([{ path: 'essay.md', revision: '1', content: '# 随笔\n春天到了，风从窗边经过。\n“远方”只是一个意象。' }]);
  assert.equal(graph.issues.length, 0);
  assert.equal(graph.edges.length, 0);
});

check('同一事实重复出现会合并证据', () => {
  const graph = analyzeProject([{ path: 'a.md', revision: '1', content: '张三位于北京。\n张三位于北京。' }]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].evidenceIds.length, 2);
});

check('文件、总量和事实限制可控且会写入 manifest', () => {
  const graph = analyzeProject([
    { path: 'a.md', content: '甲早于乙。', revision: '1' },
    { path: 'big.md', content: '超'.repeat(30), revision: '1' },
    { path: 'z.md', content: '乙早于丙。', revision: '1' }
  ], { maxFiles: 2, maxFileBytes: 20, maxTotalBytes: 20, maxFacts: 1 });
  assert.equal(graph.manifest.truncated, true);
  assert(graph.manifest.warnings.some(item => item.code === 'FILE_TOO_LARGE'));
  assert(graph.manifest.warnings.some(item => item.code === 'MAX_FACTS' || item.code === 'TOTAL_SIZE_LIMIT'));
  assert(graph.edges.length <= 1);
});

check('证据引用在 quote 限制下仍与 start/end 精确一致', () => {
  const content = `# ${'长'.repeat(80)}`;
  const graph = analyzeProject([{ path: 'long.md', revision: '1', content }], { maxEvidenceQuote: 12 });
  const evidence = graph.evidence[0];
  assert.equal(content.slice(evidence.start, evidence.end), evidence.quote);
  assert(evidence.quote.length <= 12);
});

check('证据 quote 不会在 UTF-16 上限处留下孤立 high surrogate', () => {
  const content = `# ${'长'.repeat(237)}😀尾`;
  const graph = analyzeProject([{ path: 'emoji.md', revision: 'emoji-revision', content }], {
    maxEvidenceQuote: 240,
  });
  const evidence = graph.evidence[0];
  assert.equal(evidence.quote.length, 239);
  assert(!/[\uD800-\uDBFF]$/.test(evidence.quote));
  assert.equal(evidence.end - evidence.start, evidence.quote.length);
  assert.equal(content.slice(evidence.start, evidence.end), evidence.quote);
  const expectedId = `ev_${crypto.createHash('sha256')
    .update(`emoji.md\0${evidence.start}\0${evidence.end}\0emoji-revision`)
    .digest('hex').slice(0, 16)}`;
  assert.equal(evidence.id, expectedId);
});

check('拒绝绝对路径、路径穿越和非字符串正文', () => {
  assert.throws(() => analyzeProject([{ path: '../secret.md', content: '', revision: '1' }]), /project-relative/);
  assert.throws(() => analyzeProject([{ path: '/secret.md', content: '', revision: '1' }]), /project-relative/);
  assert.throws(() => analyzeProject([{ path: 'C:/secret.md', content: '', revision: '1' }]), /project-relative/);
  assert.throws(() => analyzeProject([{ path: 'ok.md', content: null, revision: '1' }]), /string/);
});

if (!process.exitCode) console.log(`\n✅ Consistency Engine ${passed}/${passed} 全过`);
