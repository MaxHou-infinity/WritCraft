#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const resolver = require('../src/main/context-resolver-service');
const contextPolicy = require('../src/main/context-policy-service');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function occurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-context-resolver-'));
try {
  const project = projectService.createProjectAt(scratch, '上下文项目');
  projectService.createMarkdownFile(project.rootPath, 'chapters/intro.md', '# 开场\n\n## 证据\n\n人物：林舟\n\n林舟的年龄为32。\n');
  projectService.createMarkdownFile(project.rootPath, 'chapters/second.md', '# 第二章\n\nSECOND_CHAPTER_UNIQUE\n');
  projectService.createMarkdownFile(project.rootPath, 'references/research.md', '---\ntype: source\ntitle: 研究资料\n---\n\n# 研究资料\n\n这是可引用证据。\n');

  check('普通文件级 Chat 默认且仅携带一份 edit.md 与当前文件', () => {
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '请检查当前文件',
    });
    assert.deepEqual(result.chips.map(chip => chip.type), ['scope', 'project_prompt', 'file']);
    assert.equal(occurrences(result.contextText, '[上下文 · project prompt · edit.md]'), 1);
    assert.equal(occurrences(result.contextText, '[上下文 · file · chapters/intro.md]'), 1);
    assert.match(result.contextText, /林舟的年龄为32/);
    const currentFile = result.contextManifest.chips.find(chip => chip.type === 'file');
    const snapshot = projectService.readFileWithRevision(project.rootPath, 'chapters/intro.md');
    assert.match(currentFile.id, /^ctx_file_[a-f0-9]{24}$/);
    assert.equal(currentFile.id.length < 256, true);
    assert.equal(currentFile.revision, snapshot.revision);
    assert.deepEqual(currentFile.locator, {
      filePath: 'chapters/intro.md', offset: 0, endOffset: snapshot.content.length, line: 1, column: 1,
    });
    assert(currentFile.bytes > 0);
    assert.equal(currentFile.truncated, false);
    const prompt = result.contextManifest.chips.find(chip => chip.type === 'project_prompt');
    assert(prompt.sections.length > 0);
    assert(prompt.sections.every(section => section.status === 'used'));
    assert.equal(prompt.usedSectionCount, prompt.sectionCount);
    assert.equal(prompt.omittedSectionCount, 0);
    assert.equal(result.contextManifest.usedBytes, Buffer.byteLength(result.contextText, 'utf8'));
    assert.equal(result.contextManifest.usedChars, result.contextText.length);
    assert.equal(
      result.contextManifest.chips.reduce((total, chip) => total + chip.bytes, 0),
      result.contextManifest.usedBytes
    );
  });

  check('有效选段只携带 edit.md 与 selection，不自动注入当前全文', () => {
    const content = projectService.readFile(project.rootPath, 'chapters/intro.md');
    const text = '林舟的年龄为32。';
    const startOffset = content.indexOf(text);
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'selection',
      message: '请检查选段',
      selection: { text, filePath: 'chapters/intro.md', startOffset, endOffset: startOffset + text.length },
    });
    assert.deepEqual(result.chips.map(chip => chip.type), ['scope', 'project_prompt', 'selection', 'neighbor']);
    assert.equal(result.contextManifest.scope, 'selection');
    assert.equal(occurrences(result.contextText, '[上下文 · file · chapters/intro.md]'), 0);
    assert.equal(occurrences(result.contextText, '[上下文 · selection · chapters/intro.md]'), 1);
    assert.match(result.contextText, /[上下文 · neighbor · chapters\/intro\.md]/);
    assert.doesNotMatch(result.contextText, /SECOND_CHAPTER_UNIQUE/);
  });

  check('显式 @file 当前文件复用同一全文 Chip，不叠加隐式副本', () => {
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '@file:chapters/intro.md 请检查',
    });
    assert.deepEqual(result.chips.map(chip => chip.type), ['scope', 'project_prompt', 'file']);
    assert.equal(result.chips.filter(chip => chip.filePath === 'chapters/intro.md').length, 1);
    assert.equal(occurrences(result.contextText, '[上下文 · file · chapters/intro.md]'), 1);
  });

  check('file、chapter 与 folder 对同一路径按首次显式引用去重', () => {
    const fileFirst = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '@file:chapters/intro.md @chapter:intro @folder:chapters 请检查',
    });
    assert.deepEqual(fileFirst.chips.map(chip => chip.type), ['scope', 'project_prompt', 'file', 'folder']);
    assert.equal(occurrences(fileFirst.contextText, '人物：林舟'), 1);
    assert.equal(occurrences(fileFirst.contextText, 'SECOND_CHAPTER_UNIQUE'), 1);
    const folder = fileFirst.chips.find(chip => chip.type === 'folder');
    assert.deepEqual(folder.filePaths, ['chapters/second.md']);
    assert.equal(folder.truncated, true);
    assert.equal(folder.omittedCount, 1);

    const folderFirst = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '@folder:chapters @file:chapters/intro.md 请检查',
    });
    assert.deepEqual(folderFirst.chips.map(chip => chip.type), ['scope', 'project_prompt', 'folder']);
    assert.equal(occurrences(folderFirst.contextText, '人物：林舟'), 1);
    assert.equal(occurrences(folderFirst.contextText, 'SECOND_CHAPTER_UNIQUE'), 1);
  });

  check('选段 provenance 不允许伪装成其他当前文件', () => {
    assert.throws(() => resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'selection',
      message: '请检查选段',
      selection: { filePath: 'chapters/second.md', text: '人物：林舟', startOffset: 12 },
    }), /选段文件必须与当前文件一致/);
  });

  check('edit.md 作为当前文件或显式 @file 时仍只保留项目 Prompt', () => {
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@file:edit.md 请检查',
    });
    assert.deepEqual(result.chips.map(chip => chip.type), ['scope', 'project_prompt']);
    assert.equal(result.chips.filter(chip => chip.filePath === 'edit.md').length, 1);
    assert.equal(occurrences(result.contextText, '[上下文 · project prompt · edit.md]'), 1);
  });

  check('超长 edit.md 优先整章保留硬约束并在 Manifest 披露省略章节', () => {
    const longProject = projectService.createProjectAt(scratch, '章节化项目');
    const original = projectService.readFileWithRevision(longProject.rootPath, 'edit.md');
    const longEdit = [
      '---', 'schema: writcraft.edit/v1', '---', '',
      '# 项目主旨', '', 'CORE_INTENT 必须完整保留。', '',
      '## 写作目标', '', `OPTIONAL_GOAL_${'背景资料。'.repeat(900)}`, '',
      '## 范围与非目标', '', 'CORE_SCOPE 必须完整保留。', '',
      '## 自定义材料', '', `OPTIONAL_OVERFLOW_${'补充材料。'.repeat(1600)}`, '',
      '```md', '# 时间与关系约束', 'FAKE_FENCED_HEADING', '```', '',
      '## 关键实体与不变量', '', 'CORE_ENTITY 必须完整保留。', '',
      '## 时间与关系约束', '', 'CORE_TIME 必须完整保留。', '',
    ].join('\n');
    assert(longEdit.length > resolver.MAX_EDIT_CONTEXT_CHARS);
    projectService.atomicWriteFile(longProject.rootPath, 'edit.md', longEdit, original.revision);

    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: longProject.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '请检查项目规则',
    });
    for (const marker of ['CORE_INTENT', 'CORE_SCOPE', 'CORE_ENTITY', 'CORE_TIME']) {
      assert.match(result.contextText, new RegExp(marker));
    }
    assert(!result.contextText.includes('OPTIONAL_OVERFLOW'));
    assert(result.contextText.length <= resolver.MAX_CONTEXT_CHARS);
    const prompt = result.contextManifest.chips.find(chip => chip.type === 'project_prompt');
    assert.equal(prompt.revision, projectService.readFileWithRevision(longProject.rootPath, 'edit.md').revision);
    assert.equal(prompt.truncated, true);
    assert(prompt.omittedSectionCount > 0);
    assert.equal(prompt.usedSectionCount + prompt.omittedSectionCount, prompt.sectionCount);
    assert(prompt.sections.some(section => section.heading === '项目主旨' && section.status === 'used'));
    assert(prompt.sections.some(section => section.heading === '自定义材料' && section.status === 'omitted'));
    assert.equal(prompt.sections.filter(section => section.heading === '时间与关系约束').length, 1);
    assert(prompt.sections.every(section => section.locator?.filePath === 'edit.md'));
    assert(result.errors.some(error => error.code === 'PROJECT_PROMPT_SECTIONS_OMITTED'));
  });

  check('必需 edit.md 章节自身超过预算时稳定阻断且不返回半章', () => {
    const overflowProject = projectService.createProjectAt(scratch, '硬约束超限项目');
    const original = projectService.readFileWithRevision(overflowProject.rootPath, 'edit.md');
    const oversizedRequired = [
      '# 项目主旨', '', `REQUIRED_OVERFLOW_${'不可删减硬约束。'.repeat(1200)}`, '',
      '## 范围与非目标', '', '范围完整。', '',
      '## 关键实体与不变量', '', '实体完整。', '',
      '## 时间与关系约束', '', '时间完整。', '',
    ].join('\n');
    projectService.atomicWriteFile(overflowProject.rootPath, 'edit.md', oversizedRequired, original.revision);
    assert.throws(() => resolver.resolveProjectContext({
      projectService,
      rootPath: overflowProject.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '请检查项目规则',
    }), error => error?.code === 'PROJECT_PROMPT_REQUIRED_SECTIONS_TOO_LARGE' &&
      !String(error.message).includes(overflowProject.rootPath));
  });

  check('edit.md 标题解析忽略围栏并为重复标题生成有界唯一身份', () => {
    const parsed = resolver.parseEditPromptSections([
      '# 项目主旨', '第一版。', '',
      '```md', '## 范围与非目标', '围栏内容。', '```', '',
      '## 自定义章节', '甲。', '',
      '## 自定义章节', '乙。',
    ].join('\n'));
    assert.deepEqual(parsed.map(section => section.heading), ['项目主旨', '自定义章节', '自定义章节']);
    assert.equal(new Set(parsed.map(section => section.id)).size, parsed.length);
    assert(parsed.every(section => section.end > section.start));

    const tooMany = Array.from({ length: resolver.MAX_EDIT_CONTEXT_SECTIONS + 1 }, (_, index) => `## 第${index}章\n`).join('');
    assert.throws(() => resolver.parseEditPromptSections(tooMany), error => error?.code === 'PROJECT_PROMPT_SECTION_LIMIT');
    const preambleOverflow = `前言\n${Array.from(
      { length: resolver.MAX_EDIT_CONTEXT_SECTIONS },
      (_, index) => `## 第${index}章\n`
    ).join('')}`;
    assert.throws(() => resolver.parseEditPromptSections(preambleOverflow),
      error => error?.code === 'PROJECT_PROMPT_SECTION_LIMIT');

    const falseClose = resolver.parseEditPromptSections([
      '```md', '```not-a-close', '# 项目主旨', '围栏内示例。', '```',
      '# 范围与非目标', '真实范围。',
    ].join('\n'));
    assert.deepEqual(falseClose.map(section => section.heading), ['文档前言', '范围与非目标']);
    assert(!falseClose.some(section => section.heading === '项目主旨'));

    const longHeading = `# ${'超长标题'.repeat(100)}`;
    assert.throws(() => resolver.parseEditPromptSections(longHeading),
      error => error?.code === 'PROJECT_PROMPT_HEADING_LIMIT');

    const compactManyHeadings = `前言\n${Array.from(
      { length: resolver.MAX_EDIT_CONTEXT_SECTIONS },
      (_, index) => `# ${index}\n`
    ).join('')}`;
    const compactCompiled = resolver.compileEditPrompt(compactManyHeadings);
    assert.equal(compactCompiled.content, compactManyHeadings);
    assert.equal(compactCompiled.sections.length, 1);
    assert.equal(compactCompiled.sections[0].heading, '完整 edit.md');
  });

  check('Main 权威解析联通 chapter/section/folder/source/entity', () => {
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@chapter:intro @section:证据 @folder:chapters @source:"研究资料" @entity:林舟 请检查',
    });
    assert.equal(result.query, '请检查');
    assert.deepEqual(result.chips.map(chip => chip.type), ['scope', 'project_prompt', 'chapter', 'section', 'folder', 'source', 'entity']);
    assert.equal(result.chips[1].filePath, 'edit.md');
    assert.match(result.chips[1].revision, /^[a-f0-9]{64}$/);
    assert.match(result.contextText, /人物：林舟/);
    assert.match(result.contextText, /可引用证据/);
    assert.match(result.contextText, /project prompt · edit\.md/);
    assert.equal(result.errors.length, 0);
    assert.equal(result.contextManifest.currentFilePath, 'edit.md');
    assert.equal(result.contextManifest.chips.length, result.chips.length);
    assert(result.contextManifest.usedChars <= result.contextManifest.budgetChars);
    assert.equal(result.contextManifest.usedBytes, Buffer.byteLength(result.contextText, 'utf8'));
    assert(result.contextManifest.chips.every(chip => Number.isSafeInteger(chip.bytes)));
    assert(result.contextManifest.chips[0].bytes > 0);
  });

  check('远程 chapter 后的 section 经二次有界读取可精确定位', () => {
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@chapter:intro @section:证据 总结',
    });
    const section = result.chips.find(chip => chip.type === 'section');
    assert(section);
    assert.equal(section.filePath, 'chapters/intro.md');
    assert.match(section.excerpt, /林舟的年龄/);
    assert(!result.errors.some(error => error.code === 'CONTENT_UNAVAILABLE'));
  });

  check('组装后上下文受硬预算约束并在 manifest 解释截断', () => {
    projectService.createMarkdownFile(project.rootPath, 'chapters/long.md', `# 长章\n\n${'长文。'.repeat(6000)}`);
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@chapter:long 总结',
    });
    const chapter = result.chips.find(chip => chip.type === 'chapter');
    assert.equal(result.contextText.length <= resolver.MAX_CONTEXT_CHARS, true);
    assert.equal(result.contextManifest.usedChars, result.contextText.length);
    assert.equal(result.contextManifest.usedBytes, Buffer.byteLength(result.contextText, 'utf8'));
    assert.equal(chapter.truncated, true);
    assert.match(chapter.truncationReason, /预算/);
    const manifestChapter = result.contextManifest.chips.find(chip => chip.type === 'chapter');
    assert.equal(manifestChapter.truncated, true);
    assert.match(manifestChapter.truncationReason, /预算/);
  });

  check('多 block 剩余预算放不下完整长 header 时不追加半个 block', () => {
    const budgetProject = projectService.createProjectAt(scratch, '预算项目');
    const editContent = projectService.readFile(budgetProject.rootPath, 'edit.md');
    const firstPath = 'budget/01-fill.md';
    const secondPath = `budget/02-${'long-path-'.repeat(12)}.md`;
    const editHeader = '[上下文 · project prompt · edit.md]';
    const scopeHeader = '[上下文 · scope · file]';
    const scopeContent = '使用 edit.md、当前文件与用户显式引用';
    const firstHeader = `[上下文 · folder budget · ${firstPath}]`;
    const deliberatelyUnused = 20;
    const firstContentLength = resolver.MAX_CONTEXT_CHARS
      - (scopeHeader.length + 1 + scopeContent.length)
      - (2 + editHeader.length + 1 + editContent.length)
      - (2 + firstHeader.length + 1)
      - deliberatelyUnused;
    assert(firstContentLength > 0);
    projectService.createMarkdownFile(budgetProject.rootPath, firstPath, '甲'.repeat(firstContentLength));
    projectService.createMarkdownFile(budgetProject.rootPath, secondPath, 'SHOULD_NOT_ENTER_CONTEXT');

    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: budgetProject.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@folder:budget 总结',
    });
    const folder = result.contextManifest.chips.find(chip => chip.type === 'folder');
    assert.equal(result.contextText.length, resolver.MAX_CONTEXT_CHARS - deliberatelyUnused);
    assert.equal(result.contextManifest.usedChars, result.contextText.length);
    assert.equal(result.contextManifest.usedBytes, Buffer.byteLength(result.contextText, 'utf8'));
    assert.equal(
      result.contextManifest.chips.reduce((total, chip) => total + chip.bytes, 0),
      result.contextManifest.usedBytes
    );
    assert.match(result.contextText, new RegExp(firstPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert(!result.contextText.includes(secondPath));
    assert(!result.contextText.includes('SHOULD_NOT_ENTER_CONTEXT'));
    assert.equal(folder.truncated, true);
    assert.match(folder.truncationReason, /预算/);
  });

  check('完全未进入预算的 Chip 只进入 omittedChips，不冒充实际上下文', () => {
    const budgetProject = projectService.createProjectAt(scratch, '零字节预算项目');
    const editContent = projectService.readFile(budgetProject.rootPath, 'edit.md');
    const firstPath = 'budget/fill.md';
    const secondPath = `budget/${'very-long-'.repeat(14)}tail.md`;
    const editHeader = '[上下文 · project prompt · edit.md]';
    const scopeHeader = '[上下文 · scope · file]';
    const scopeContent = '使用 edit.md、当前文件与用户显式引用';
    const firstHeader = `[上下文 · file · ${firstPath}]`;
    const remainingAfterFirst = 20;
    const firstContentLength = resolver.MAX_CONTEXT_CHARS
      - (scopeHeader.length + 1 + scopeContent.length)
      - (2 + editHeader.length + 1 + editContent.length)
      - (2 + firstHeader.length + 1)
      - remainingAfterFirst;
    projectService.createMarkdownFile(budgetProject.rootPath, firstPath, '甲'.repeat(firstContentLength));
    projectService.createMarkdownFile(budgetProject.rootPath, secondPath, 'ZERO_BYTE_CHIP_MUST_NOT_BE_ACTUAL');
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: budgetProject.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: `@file:${firstPath} @file:${secondPath} 总结`,
    });
    assert.equal(result.contextManifest.usedChars, resolver.MAX_CONTEXT_CHARS - remainingAfterFirst);
    assert(!result.contextText.includes(secondPath));
    assert(!result.contextText.includes('ZERO_BYTE_CHIP_MUST_NOT_BE_ACTUAL'));
    assert(!result.contextManifest.chips.some(chip => chip.filePath === secondPath));
    assert(result.contextManifest.omittedChips.some(chip => chip.filePath === secondPath && chip.bytes === 0 && chip.truncated));
    assert(result.errors.some(error => error.code === 'CONTEXT_BUDGET_OMITTED' && error.omittedCount === 1));
  });

  check('选区作用域对缺失、重复与漂移选段全部 fail-closed', () => {
    const duplicatedPath = 'chapters/duplicate.md';
    projectService.createMarkdownFile(project.rootPath, duplicatedPath, '# 重复\n\n相同选段\n\n中间段落\n\n相同选段\n');
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: duplicatedPath,
      scope: 'selection', message: '检查', selection: null,
    }), error => error.code === 'SELECTION_REQUIRED');
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: duplicatedPath,
      scope: 'selection', message: '检查', selection: { filePath: duplicatedPath, text: '相同选段' },
    }), error => error.code === 'AMBIGUOUS_SELECTION');
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: duplicatedPath,
      scope: 'selection', message: '检查', selection: { filePath: duplicatedPath, text: '已漂移选段', startOffset: 5, endOffset: 11 },
    }), error => error.code === 'SELECTION_STALE');
  });

  check('选区作用域携带精确前后邻段 locator，不注入当前全文', () => {
    const neighborPath = 'chapters/neighbors.md';
    const content = '# 邻段\n\nPREVIOUS_NEIGHBOR\n\nSELECTED_TARGET\n\nNEXT_NEIGHBOR\n\nFAR_BLOCK_MUST_NOT_ENTER\n';
    projectService.createMarkdownFile(project.rootPath, neighborPath, content);
    const startOffset = content.indexOf('SELECTED_TARGET');
    const result = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: neighborPath,
      scope: 'selection', message: '检查当前选段',
      selection: { filePath: neighborPath, text: 'SELECTED_TARGET', startOffset, endOffset: startOffset + 'SELECTED_TARGET'.length },
    });
    const neighbors = result.contextManifest.chips.filter(chip => chip.type === 'neighbor');
    assert.deepEqual(neighbors.map(chip => chip.label), ['上一个相邻段落', '下一个相邻段落']);
    assert.deepEqual(neighbors.map(chip => content.slice(chip.locator.offset, chip.locator.endOffset)), ['PREVIOUS_NEIGHBOR', 'NEXT_NEIGHBOR']);
    assert(!result.contextText.includes('FAR_BLOCK_MUST_NOT_ENTER'));
    assert(!result.contextText.includes(`[上下文 · file · ${neighborPath}]`));

    const nextStart = content.indexOf('NEXT_NEIGHBOR');
    const boundaryText = content.slice(startOffset, nextStart);
    const boundary = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: neighborPath,
      scope: 'selection', message: '检查贴近下一段起点的排他选区',
      selection: { filePath: neighborPath, text: boundaryText, startOffset, endOffset: nextStart },
    });
    const nextNeighbor = boundary.contextManifest.chips.find(chip => chip.type === 'neighbor' && chip.label === '下一个相邻段落');
    assert(nextNeighbor);
    assert.equal(content.slice(nextNeighbor.locator.offset, nextNeighbor.locator.endOffset), 'NEXT_NEIGHBOR');
  });

  check('历史策略即使绑定 Manifest 也不得在 Resolver 过滤掉必需 selection', () => {
    const selectionPath = 'chapters/neighbors.md';
    const content = projectService.readFile(project.rootPath, selectionPath);
    const text = 'SELECTED_TARGET';
    const startOffset = content.indexOf(text);
    const selection = { filePath: selectionPath, text, startOffset, endOffset: startOffset + text.length };
    const baseline = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: selectionPath,
      scope: 'selection', message: '检查当前选段', selection,
    });
    const selectionChip = baseline.contextManifest.chips.find(chip => chip.type === 'selection');
    assert(selectionChip);
    // Rebuild the v1 binding to model a policy persisted by the previous
    // implementation, in which selection was incorrectly optional.
    const payload = JSON.stringify({
      scope: baseline.contextManifest.scope,
      currentFilePath: baseline.contextManifest.currentFilePath,
      currentRevision: baseline.contextManifest.currentRevision,
      chips: baseline.contextManifest.chips.map(chip => [chip.id, chip.type]),
    });
    const legacyPolicy = {
      version: contextPolicy.POLICY_VERSION,
      manifestBinding: crypto.createHash('sha256').update(payload).digest('hex'),
      excludedChipIds: [selectionChip.id],
    };
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: selectionPath,
      scope: 'selection', message: '检查当前选段', selection, policy: legacyPolicy,
    }), error => error.code === 'REQUIRED_SELECTION_CONTEXT');
  });

  check('edit.md 与精确选段必须完整进入模型，超限 Unicode 不会被静默截断', () => {
    const largeSelection = '🚀'.repeat(Math.floor(resolver.MAX_SELECTION_CONTEXT_BYTES / 4) + 1);
    const selectionPath = 'chapters/selection-limit.md';
    projectService.createMarkdownFile(project.rootPath, selectionPath, `# 选段上限\n\n${largeSelection}\n`);
    const content = projectService.readFile(project.rootPath, selectionPath);
    const startOffset = content.indexOf(largeSelection);
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: selectionPath,
      scope: 'selection', message: '检查',
      selection: { filePath: selectionPath, text: largeSelection, startOffset, endOffset: startOffset + largeSelection.length },
    }), error => error.code === 'SELECTION_CONTEXT_TOO_LARGE');

    const oversizedPrompt = projectService.createProjectAt(scratch, '过大项目提示');
    const edit = projectService.readFileWithRevision(oversizedPrompt.rootPath, 'edit.md');
    projectService.atomicWriteFile(oversizedPrompt.rootPath, 'edit.md', '规'.repeat(resolver.MAX_EDIT_CONTEXT_CHARS + 1), edit.revision);
    assert.throws(() => resolver.resolveProjectContext({
      projectService, rootPath: oversizedPrompt.rootPath, currentFilePath: 'edit.md', scope: 'file', message: '检查',
    }), error => error.code === 'PROJECT_PROMPT_CONTEXT_TOO_LARGE');
  });

  check('项目作用域仅发送 edit.md、显式引用与确定性检索，不默认发送当前全文', () => {
    const first = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: 'SECOND_CHAPTER_UNIQUE 出现在哪里？',
    });
    const second = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: 'SECOND_CHAPTER_UNIQUE 出现在哪里？',
    });
    assert.equal(first.contextManifest.scope, 'project');
    assert.deepEqual(first.contextManifest.chips.slice(0, 2).map(chip => chip.type), ['scope', 'project_prompt']);
    assert(first.contextManifest.chips.some(chip => chip.type === 'retrieval' && chip.filePath === 'chapters/second.md'));
    assert(!first.contextText.includes('[上下文 · file · chapters/intro.md]'));
    assert(!first.contextText.includes('人物：林舟'));
    assert.deepEqual(
      first.contextManifest.chips.filter(chip => chip.type === 'retrieval').map(chip => chip.id),
      second.contextManifest.chips.filter(chip => chip.type === 'retrieval').map(chip => chip.id),
    );
    assert(first.contextManifest.chips.find(chip => chip.type === 'retrieval').reason.includes('SECOND_CHAPTER_UNIQUE'.toLocaleLowerCase()));
  });

  check('项目自动检索排除 references/sources 与显式引用路径', () => {
    const automatic = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: '可引用证据在哪里？',
    });
    assert(!automatic.contextManifest.chips.some(chip => chip.type === 'retrieval' && chip.filePath.startsWith('references/')));
    const explicit = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: '@source:"研究资料" 可引用证据在哪里？',
    });
    assert(explicit.contextManifest.chips.some(chip => chip.type === 'source' && chip.filePath === 'references/research.md'));
    assert(!explicit.contextManifest.chips.some(chip => chip.type === 'retrieval' && chip.filePath === 'references/research.md'));
    const explicitFile = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: '@file:chapters/second.md SECOND_CHAPTER_UNIQUE 是什么？',
    });
    assert.equal(explicitFile.contextManifest.chips.filter(chip => chip.filePath === 'chapters/second.md').length, 1);
    assert.equal(explicitFile.contextManifest.chips.find(chip => chip.filePath === 'chapters/second.md').type, 'file');
  });

  check('项目检索的文件、字节、字符与片段上限进入 Main manifest', () => {
    for (let index = 0; index < resolver.MAX_PROJECT_RETRIEVAL_FILES + 6; index += 1) {
      projectService.createMarkdownFile(project.rootPath, `retrieval/${String(index).padStart(2, '0')}.md`, `# 边界 ${index}\n\nPROJECT_RETRIEVAL_BOUNDARY 片段 ${index}\n`);
    }
    const result = resolver.resolveProjectContext({
      projectService, rootPath: project.rootPath, currentFilePath: 'chapters/intro.md',
      scope: 'project', message: 'PROJECT_RETRIEVAL_BOUNDARY 总结',
    });
    const summary = result.contextManifest.retrieval;
    assert.equal(summary.scannedFiles, resolver.MAX_PROJECT_RETRIEVAL_FILES);
    assert(summary.omittedFiles > 0);
    assert(summary.scannedBytes <= resolver.MAX_PROJECT_RETRIEVAL_SCAN_BYTES);
    assert(summary.scannedChars <= resolver.MAX_PROJECT_RETRIEVAL_SCAN_CHARS);
    assert(result.contextManifest.chips.filter(chip => chip.type === 'retrieval').length <= resolver.MAX_PROJECT_RETRIEVAL_SNIPPETS);
    assert(result.errors.some(error => error.code === 'PROJECT_RETRIEVAL_OMITTED'));
    assert(result.contextText.length <= resolver.MAX_CONTEXT_CHARS);
    assert(Buffer.byteLength(result.contextText, 'utf8') <= resolver.MAX_CONTEXT_BYTES);
  });

  check('Main/preload/renderer 使用受限 IPC 并把权威 manifest 绑定到每条 AI 回复', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'src/main/preload.js'), 'utf8');
    const workspace = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/workspace.js'), 'utf8');
    const editor = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/editor.js'), 'utf8');
    assert.match(main, /writcraft:project:resolve-context/);
    assert.match(main, /ipcMain\.handle\('writcraft:chat',[\s\S]*contextResolverService\.resolveProjectContext/);
    const chatStart = main.indexOf("ipcMain.handle('writcraft:chat'");
    const chatEnd = main.indexOf("\nipcMain.handle('", chatStart + 20);
    const chatHandler = main.slice(chatStart, chatEnd);
    const requiredRequestGate = chatHandler.indexOf('currentProject && (contextRequest === null || contextRequest === undefined)');
    const validation = chatHandler.indexOf('validateRendererContext(projectContext, contextRequest)');
    const resolverCall = chatHandler.indexOf('contextResolverService.resolveProjectContext');
    assert(requiredRequestGate >= 0 && requiredRequestGate < validation);
    assert(validation >= 0 && validation < resolverCall);
    assert.match(chatHandler, /if \(currentProject\) \{[\s\S]*contextResolverService\.resolveProjectContext/);
    assert.match(main, /chatContextRequestService\.validate\(contextRequest\)/);
    assert.match(chatHandler, /const boundedContext = resolvedContext\s*\? \{ text: resolvedContext\.contextText, manifest: resolvedContext\.contextManifest \}\s*: buildProjectContext\(projectContext\)/);
    assert.doesNotMatch(chatHandler, /modelFiles/);
    assert.match(preload, /resolveContext: \(projectInstanceId, request\)/);
    assert.match(preload, /chat: \(projectInstanceId, userMessage, projectContext, contextRequest\)/);
    assert.match(workspace, /bridge\.resolveContext\(originProjectInstanceId, contextRequest\)/);
    assert.doesNotMatch(workspace, /renderer-only parser as a read-only fallback/);
    assert.match(editor, /manifestChips\(result\.contextManifest\)/);
    assert.match(editor, /const actualChips = manifestChips\(result\.contextManifest\)/);
    assert.doesNotMatch(editor, /actualChips\s*=\s*mergeContextChips/);
    assert.doesNotMatch(editor, /actualChips\s*=\s*[^;]*selectedContext/);
    assert.match(editor, /bindResponseContext\(response, actualChips\)/);
    assert.match(editor, /chatContextState\.createRequest/);
  });

  check('Main 绑定的排除策略只影响下一次模型上下文，edit.md 始终保留', () => {
    const request = {
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@chapter:intro @source:"研究资料" 请检查',
    };
    const first = resolver.resolveProjectContext(request);
    const source = first.contextManifest.chips.find(chip => chip.type === 'source');
    const policy = contextPolicy.createExclusionPolicy(first.contextManifest, [source.id]);
    const next = resolver.resolveProjectContext({ ...request, policy });
    assert(!next.contextManifest.chips.some(chip => chip.id === source.id));
    assert(!next.contextText.includes('这是可引用证据'));
    assert(next.contextManifest.chips.some(chip => chip.type === 'project_prompt'));
    assert.match(next.contextText, /project prompt · edit\.md/);
    assert.equal(first.contextManifest.chips.some(chip => chip.id === source.id), true);
  });

  check('默认当前文件 Chip 可由绑定 Manifest 的排除策略安全移除', () => {
    const request = {
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '只根据项目 Prompt 回答',
    };
    const first = resolver.resolveProjectContext(request);
    const currentFile = first.contextManifest.chips.find(chip => chip.type === 'file');
    const policy = contextPolicy.createExclusionPolicy(first.contextManifest, [currentFile.id]);
    const next = resolver.resolveProjectContext({ ...request, policy });
    assert.deepEqual(next.contextManifest.chips.map(chip => chip.type), ['scope', 'project_prompt']);
    assert.equal(occurrences(next.contextText, '[上下文 · project prompt · edit.md]'), 1);
    assert.equal(occurrences(next.contextText, '[上下文 · file · chapters/intro.md]'), 0);
    assert.doesNotMatch(next.contextText, /林舟的年龄为32/);
  });

  check('文件 revision 变化后旧排除策略失效并给出结构化解释', () => {
    const request = {
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'chapters/intro.md',
      scope: 'file',
      message: '@source:"研究资料" 请检查',
    };
    const first = resolver.resolveProjectContext(request);
    const source = first.contextManifest.chips.find(chip => chip.type === 'source');
    const policy = contextPolicy.createExclusionPolicy(first.contextManifest, [source.id]);
    const current = projectService.readFileWithRevision(project.rootPath, 'chapters/intro.md');
    projectService.atomicWriteFile(project.rootPath, 'chapters/intro.md', `${current.content}\n新版本。\n`, current.revision);
    const next = resolver.resolveProjectContext({ ...request, policy });
    assert(next.contextManifest.chips.some(chip => chip.id === source.id));
    assert(next.errors.some(error => error.code === 'CONTEXT_POLICY_STALE'));
  });

  check('多文件 folder 组合超过 Main 读取上限时结构化报错而不静默扩容', () => {
    for (let folder = 0; folder < 4; folder += 1) {
      for (let file = 0; file < 12; file += 1) {
        projectService.createMarkdownFile(project.rootPath, `bulk${folder}/${file}.md`, `# ${folder}-${file}\n`);
      }
    }
    const result = resolver.resolveProjectContext({
      projectService,
      rootPath: project.rootPath,
      currentFilePath: 'edit.md',
      scope: 'file',
      message: '@folder:bulk0 @folder:bulk1 @folder:bulk2 @folder:bulk3 总结',
    });
    assert.ok(result.errors.some(error => error.code === 'CONTEXT_FILE_LIMIT' && error.omittedCount === 8));
    assert.ok(result.chips.some(chip => chip.type === 'folder' && chip.truncationReason));
  });

  console.log(`\n${passed}/${passed} Main context resolver checks passed.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
