#!/usr/bin/env node
const assert = require('assert');
const path = require('path');

const context = require(path.join(__dirname, '..', 'src/renderer/context-selection.js'));
let pass = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    pass += 1;
  } catch (error) {
    console.error(`  ✗ ${label}: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}

function throwsCode(fn, code) {
  assert.throws(fn, error => error && error.code === code, `应抛出 ${code}`);
}

console.log('════════ WritCraft V0 · Context selection verify ════════');

check('只接受安全的项目相对 Markdown 路径', () => {
  assert.equal(context.normalizeMarkdownPath('chapters/01.md'), 'chapters/01.md');
  assert.equal(context.normalizeMarkdownPath('章节/第一 章.markdown'), '章节/第一 章.markdown');
  for (const [value, code] of [
    ['../outside.md', 'PATH_TRAVERSAL'],
    ['/etc/passwd.md', 'ABSOLUTE_PATH'],
    ['C:\\temp\\x.md', 'ABSOLUTE_PATH'],
    ['https://example.com/a.md', 'ABSOLUTE_PATH'],
    ['.writcraft/index.md', 'PRIVATE_PATH'],
    ['chapters//01.md', 'PATH_TRAVERSAL'],
    ['chapters/01.txt', 'INVALID_EXTENSION'],
  ]) throwsCode(() => context.normalizeMarkdownPath(value), code);
});

const chapter = `# 第一章

## 背景

背景正文。

### 细节

细节正文。

## 结论

结论正文。

附录标题
--------

附录正文。

\`\`\`md
# 代码块内不是标题
\`\`\`
`;

check('解析 ATX/Setext 章节，忽略代码块标题', () => {
  const sections = context.parseMarkdownSections(chapter, 'chapters/01.md');
  assert.deepEqual(sections.map(section => section.heading), ['第一章', '背景', '细节', '结论', '附录标题']);
  const background = sections.find(section => section.heading === '背景');
  assert.equal(background.level, 2);
  assert.equal(background.line, 3);
  assert.ok(background.excerpt.includes('### 细节'), '二级节应包含其子节');
  assert.ok(!background.excerpt.includes('## 结论'), '二级节应在下一个同级节截止');
});

check('不把 Front Matter 分隔线或注释误判为章节', () => {
  const markdown = `---\ntitle: 项目\n# 这是 YAML 注释\n---\n\n# 真实标题\n正文\n`;
  assert.deepEqual(
    context.parseMarkdownSections(markdown, 'edit.md').map(section => section.heading),
    ['真实标题']
  );
});

check('章节 ID 由路径+标题+重名序号稳定，内容变更只更新 fingerprint', () => {
  const before = context.parseMarkdownSections(chapter, 'chapters/01.md').find(section => section.heading === '背景');
  const changedText = chapter.replace('背景正文。', '背景正文已更新。');
  const after = context.parseMarkdownSections(changedText, 'chapters/01.md').find(section => section.heading === '背景');
  assert.equal(after.id, before.id);
  assert.notEqual(after.contentFingerprint, before.contentFingerprint);
  const moved = context.parseMarkdownSections('\n\n' + chapter, 'chapters/01.md').find(section => section.heading === '背景');
  assert.equal(moved.id, before.id);
  assert.notEqual(moved.startOffset, before.startOffset);
});

check('解析 @file、简写 @路径与 @section，按出现顺序生成 Chip', () => {
  const result = context.parseContextSelections(
    '请比较 @file:chapters/01.md @section:背景，并核对 @references/source.md。',
    {
      files: ['chapters/01.md', 'references/source.md'],
      currentFilePath: 'chapters/01.md',
      currentContent: chapter,
      fileContents: { 'chapters/01.md': chapter, 'references/source.md': '# 来源\n' },
      fileRevisions: { 'chapters/01.md': 'rev-a', 'references/source.md': 'rev-b' },
    }
  );
  assert.deepEqual(result.chips.map(chip => chip.type), ['file', 'section', 'file']);
  assert.equal(result.chips[1].label, '背景');
  assert.equal(result.chips[1].filePath, 'chapters/01.md');
  assert.equal(result.chips[1].revision, 'rev-a');
  assert.ok(result.chips[1].excerpt.includes('背景正文'));
  assert.ok(!result.query.includes('@file'));
  assert.ok(!result.query.includes('@section'));
  assert.equal(result.errors.length, 0);
});

check('带空格文件名/章节名可引号引用，最近 @file 决定 section 归属', () => {
  const content = '# 项目 背景\n\n正文\n';
  const result = context.parseContextSelections('@file:"chapters/my file.md" @section:"项目 背景" 请分析', {
    files: ['chapters/my file.md'],
    fileContents: { 'chapters/my file.md': content },
  });
  assert.deepEqual(result.chips.map(chip => chip.filePath), ['chapters/my file.md', 'chapters/my file.md']);
  assert.equal(result.chips[1].locator.line, 1);
  assert.equal(result.query, '请分析');
});

check('无引号 section 后的用户问题不会被当成标题吞掉', () => {
  const result = context.parseContextSelections('@section 背景 请分析其逻辑', {
    files: ['chapters/01.md'], currentFilePath: 'chapters/01.md', currentContent: chapter,
  });
  assert.equal(result.chips[0].label, '背景');
  assert.equal(result.query, '请分析其逻辑');
});

check('当前选段 Chip 包含可验证 offset/行列/fingerprint', () => {
  const text = '# 标题\n\n第一段。\n\n第二段。\n';
  const selected = '第二段。';
  const start = text.indexOf(selected);
  const chip = context.buildSelectionChip({
    filePath: 'chapters/02.md', text: selected, startOffset: start, endOffset: start + selected.length,
  }, { currentContent: text, currentRevision: 'rev-selection' });
  assert.equal(chip.type, 'selection');
  assert.equal(chip.label, '当前选段');
  assert.equal(chip.locator.offset, start);
  assert.equal(chip.locator.line, 5);
  assert.equal(chip.revision, 'rev-selection');
  assert.match(chip.locator.contentFingerprint, /^txt_[a-f0-9]{16}$/);
  assert.equal(chip.excerpt, selected);
});

check('无 offset 时只允许唯一可重定位选段，过期/重名不猜测', () => {
  const unique = context.buildSelectionChip(
    { filePath: 'chapters/a.md', text: '唯一文本' },
    { currentContent: 'A\n唯一文本\nB' }
  );
  assert.equal(unique.locator.line, 2);
  throwsCode(() => context.buildSelectionChip(
    { filePath: 'chapters/a.md', text: '重复' },
    { currentContent: '重复\n重复' }
  ), 'AMBIGUOUS_SELECTION');
  throwsCode(() => context.buildSelectionChip(
    { filePath: 'chapters/a.md', text: '旧文字', startOffset: 0 },
    { currentContent: '新文字' }
  ), 'SELECTION_STALE');
});

check('当前选段与显式引用合并，重复 Chip 去重', () => {
  const selected = '背景正文。';
  const start = chapter.indexOf(selected);
  const result = context.parseContextSelections('@chapters/01.md @chapters/01.md 请润色', {
    files: ['chapters/01.md'],
    currentFilePath: 'chapters/01.md',
    currentContent: chapter,
    selection: { filePath: 'chapters/01.md', text: selected, startOffset: start },
  });
  assert.deepEqual(result.chips.map(chip => chip.type), ['file', 'selection']);
});

check('未知文件、非法路径、缺失章节都结构化报错', () => {
  const result = context.parseContextSelections(
    '@file:missing.md @file:../outside.md @section:不存在 请分析',
    { files: ['chapters/01.md'], currentFilePath: 'chapters/01.md', currentContent: chapter }
  );
  assert.ok(result.errors.some(error => error.code === 'FILE_NOT_FOUND'));
  assert.ok(result.errors.some(error => error.code === 'PATH_TRAVERSAL'));
  assert.ok(result.errors.some(error => error.code === 'NO_SECTION_FILE'));
  assert.equal(result.chips.length, 0);
});

check('重名章节不静默猜测，输出 ambiguous 警告与稳定首项', () => {
  const duplicate = '# 项目\n\n## 背景\nA\n\n## 背景\nB\n';
  const result = context.parseContextSelections('@section:背景，检查', {
    files: ['a.md'], currentFilePath: 'a.md', currentContent: duplicate,
  });
  assert.equal(result.chips[0].locator.occurrence, 1);
  assert.ok(result.errors.some(error => error.code === 'AMBIGUOUS_SECTION'));
});

check('@chapter 支持文件 stem/路径别名，重名时拒绝猜测', () => {
  const unique = context.parseContextSelections('@chapter:开场 请总结', {
    files: ['chapters/开场.md', 'notes/背景.md'],
  });
  assert.equal(unique.chips[0].type, 'chapter');
  assert.equal(unique.chips[0].filePath, 'chapters/开场.md');
  assert.equal(unique.query, '请总结');
  const ambiguous = context.parseContextSelections('@chapter:intro', {
    files: ['a/intro.md', 'b/intro.markdown'],
  });
  assert.ok(ambiguous.errors.some(error => error.code === 'AMBIGUOUS_CHAPTER'));
  assert.equal(ambiguous.chips.length, 0);
});

check('@folder 只展开公开 Markdown 且有界，输出截断原因', () => {
  const files = Array.from({ length: context.MAX_FOLDER_FILES + 3 }, (_, index) => `chapters/${index}.md`);
  files.push('other/outside.md');
  const result = context.parseContextSelections('@folder:chapters 检查', { files });
  const chip = result.chips[0];
  assert.equal(chip.type, 'folder');
  assert.equal(chip.filePaths.length, context.MAX_FOLDER_FILES);
  assert.equal(chip.omittedCount, 3);
  assert.equal(chip.truncated, true);
  assert.match(chip.truncationReason, /最多纳入/);
  assert.ok(result.errors.some(error => error.code === 'FOLDER_LIMIT'));
  throwsCode(() => context.normalizeFolderPath('../private'), 'PATH_TRAVERSAL');
});

check('@source 按 ID/标题/路径精确解析，重名标题结构化报错', () => {
  const sources = [
    { id: 'src_a', title: '调研', filePath: 'references/a.md', revision: 'ra', locator: { filePath: 'references/a.md', line: 4 } },
    { id: 'src_b', title: '调研', filePath: 'references/b.md', revision: 'rb' },
  ];
  const exact = context.parseContextSelections('@source:src_a', { files: sources.map(item => item.filePath), sources });
  assert.equal(exact.chips[0].type, 'source');
  assert.equal(exact.chips[0].sourceId, 'src_a');
  assert.equal(exact.chips[0].locator.line, 4);
  const ambiguous = context.parseContextSelections('@source:调研', { files: sources.map(item => item.filePath), sources });
  assert.ok(ambiguous.errors.some(error => error.code === 'AMBIGUOUS_SOURCE'));
});

check('@entity 按 ID/唯一 label 解析并携带有界证据', () => {
  const evidence = {};
  const evidenceIds = Array.from({ length: context.MAX_ENTITY_EVIDENCE + 2 }, (_, index) => {
    const id = `ev_${index}`;
    evidence[id] = { id, path: 'chapters/a.md', start: index, end: index + 1, quote: `Q${index}` };
    return id;
  });
  const entities = [{ id: 'node_lin', label: '林舟', aliases: ['小林'], evidenceIds }];
  const result = context.parseContextSelections('@entity:小林', { files: ['chapters/a.md'], entities, evidenceById: evidence });
  const chip = result.chips[0];
  assert.equal(chip.type, 'entity');
  assert.equal(chip.entityId, 'node_lin');
  assert.equal(chip.filePath, 'chapters/a.md');
  assert.equal(chip.evidence.length, context.MAX_ENTITY_EVIDENCE);
  assert.equal(chip.omittedCount, 2);
  assert.match(chip.truncationReason, /最多展示/);
});

check('所有新引用语法可混合分词且仍受总 mention 上限约束', () => {
  const tokens = context.tokenizeMentions('@chapter c @folder:f @source:s @entity:e @file:x.md @section h');
  assert.deepEqual(tokens.map(item => item.kind), ['chapter', 'folder', 'source', 'entity', 'file', 'section']);
  const many = context.tokenizeMentions(Array.from({ length: context.MAX_MENTIONS + 5 }, (_, index) => `@file:${index}.md`).join(' '));
  assert.equal(many.length, context.MAX_MENTIONS);
  const parsed = context.parseContextSelections(Array.from({ length: context.MAX_MENTIONS + 5 }, (_, index) => `@file:${index}.md`).join(' '), {
    files: Array.from({ length: context.MAX_MENTIONS + 5 }, (_, index) => `${index}.md`),
  });
  assert.ok(parsed.errors.some(error => error.code === 'MENTION_LIMIT' && error.omittedCount === 5));
  const oversized = context.parseContextSelections('x'.repeat(context.MAX_MESSAGE_CHARS + 9));
  assert.ok(oversized.errors.some(error => error.code === 'MESSAGE_TOO_LONG' && error.omittedCount === 9));
});

check('模块是 UMD 纯函数，不依赖 DOM、IPC 或 Node 文件系统', () => {
  const source = require('fs').readFileSync(path.join(__dirname, '..', 'src/renderer/context-selection.js'), 'utf8');
  for (const forbidden of ['document.', 'window.', 'ipcRenderer', "require('fs')", 'localStorage']) {
    assert.ok(!source.includes(forbidden), `不应依赖 ${forbidden}`);
  }
});

if (!process.exitCode) console.log(`\n✅ 上下文选择/解析行为安全检查 ${pass}/${pass} 全过`);
