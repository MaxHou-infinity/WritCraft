#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const State = require('../src/renderer/context-inspector-state');
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'context-inspector.js'), 'utf8');

let passed = 0;
function check(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

const manifest = {
  scope: 'selection',
  currentFilePath: 'chapters/01.md',
  currentRevision: 'abcdef1234567890',
  budgetChars: 10000,
  usedChars: 2400,
  usedBytes: 3100,
  chips: [
    {
      id: 'prompt', type: 'project_prompt', label: 'edit.md', filePath: 'edit.md', revision: 'promptrev', bytes: 800,
      sectionCount: 3, usedSectionCount: 2, omittedSectionCount: 1,
      sections: [
        { id: 'prompt-main', heading: '项目主旨', level: 1, status: 'used', reason: '硬约束优先保留', bytes: 500, locator: { filePath: 'edit.md', revision: 'promptrev', offset: 10, endOffset: 40, line: 2, column: 1 } },
        { id: 'prompt-custom', heading: '自定义材料', level: 2, status: 'omitted', reason: '超过项目 Prompt 预算', bytes: 0, locator: { filePath: 'edit.md', offset: 41, endOffset: 80, line: 5, column: 1 } },
      ],
    },
    { id: 'file', type: 'file', label: '01.md', filePath: 'chapters/01.md', revision: 'filerev', bytes: 1200 },
    { id: 'section', type: 'section', label: '冲突', filePath: 'chapters/01.md', revision: 'filerev', bytes: 400 },
    { id: 'folder', type: 'folder', label: 'notes', folderPath: 'notes', filePaths: ['notes/a.md'], bytes: 300, truncated: true, truncationReason: '最多纳入 12 个文件' },
    { id: 'source', type: 'source', label: '访谈', sourceId: 'src-1', revision: 'sourcerev', bytes: 200 },
    { id: 'entity', type: 'entity', label: '林岚', entityId: 'entity-1', bytes: 100 },
    { id: 'selection', type: 'selection', label: '当前选段', filePath: 'chapters/01.md', revision: 'filerev', bytes: 100 },
    { id: 'neighbor', type: 'neighbor', label: '下一块', filePath: 'chapters/01.md', revision: 'filerev', bytes: 90, locator: { filePath: 'chapters/01.md', offset: 90, endOffset: 120 } },
  ],
};

console.log('════════ WritCraft V0 · Context Inspector verify ════════');

check('规范化完整上下文类型、revision、bytes、截断与错误', () => {
  const state = State.createState(manifest, [{ code: 'SOURCE_NOT_FOUND', message: '没有找到来源', token: '@source:x' }]);
  const view = State.toViewModel(state);
  assert.deepStrictEqual(view.chips.map(chip => chip.type), ['project_prompt', 'file', 'section', 'folder', 'source', 'entity', 'selection', 'neighbor']);
  assert.equal(view.currentRevision, manifest.currentRevision);
  assert.equal(view.usedLabel, '3.0 KB');
  assert.equal(view.chips[1].bytesLabel, '1.2 KB');
  assert.equal(view.chips[3].truncationReason, '最多纳入 12 个文件');
  assert.equal(view.chips[7].locator.endOffset, 120);
  assert.deepStrictEqual(view.chips[0].sections.map(section => section.status), ['used', 'omitted']);
  assert.equal(view.chips[0].sections[0].statusLabel, '已使用');
  assert.equal(view.chips[0].sections[1].statusLabel, '已省略');
  assert.equal(view.chips[0].sectionSummary, '2/3 章已使用 · 1 章省略');
  assert.equal(view.chips[0].sections[1].locator, null);
  assert.equal(view.chips[0].sections[0].locator.revision, 'promptrev');
  assert.equal(view.errors[0].code, 'SOURCE_NOT_FOUND');
});

check('本次回复快照深度冻结，移除只改变下次请求排除 ID', () => {
  const original = State.createState(manifest, []);
  const next = State.reduce(original, { type: 'exclude', chipId: 'source' });
  assert(Object.isFrozen(original.snapshot));
  assert(Object.isFrozen(original.snapshot.chips[0]));
  assert(Object.isFrozen(original.snapshot.chips[0].sections));
  assert(Object.isFrozen(original.snapshot.chips[0].sections[0]));
  assert.strictEqual(next.snapshot, original.snapshot);
  assert.deepStrictEqual(State.requestPolicy(next), { excludedChipIds: ['source'] });
  assert.equal(next.snapshot.chips.length, original.snapshot.chips.length);
});

check('project prompt 与当前 selection 是固定上下文，未知 ID 不能伪造或删除 Chip', () => {
  const state = State.createState(manifest, []);
  assert.strictEqual(State.reduce(state, { type: 'exclude', chipId: 'prompt' }), state);
  assert.strictEqual(State.reduce(state, { type: 'exclude', chipId: 'selection' }), state);
  assert.equal(State.toViewModel(state).chips.find(chip => chip.id === 'selection').removable, false);
  assert.strictEqual(State.reduce(state, { type: 'exclude', chipId: 'forged' }), state);
  assert(!Object.keys(State).some(key => /add|insert|append/i.test(key)));
});

check('恢复和新 Manifest 更新都只保留仍存在的可选排除项', () => {
  let state = State.createState(manifest, []);
  state = State.reduce(state, { type: 'exclude', chipId: 'file' });
  state = State.reduce(state, { type: 'exclude', chipId: 'entity' });
  state = State.replaceSnapshot(state, { ...manifest, chips: manifest.chips.filter(chip => chip.id !== 'entity') }, []);
  assert.deepStrictEqual(state.excludedChipIds, ['file']);
  state = State.reduce(state, { type: 'restore', chipId: 'file' });
  assert.deepStrictEqual(state.excludedChipIds, []);
});

check('恶意和超量 Manifest 被有界规范化而不污染状态', () => {
  const many = Array.from({ length: State.MAX_CHIPS + 20 }, (_, index) => ({ id: `f${index}`, type: 'file', label: `F${index}` }));
  const nested = Array.from({ length: State.MAX_PROMPT_SECTIONS + 20 }, (_, index) => ({
    id: `s${index}`, heading: `章节 ${index}`, level: 99, status: index % 2 ? 'used' : 'omitted',
    bytes: -1, locator: { filePath: 'edit.md', offset: index + 1, endOffset: index },
  }));
  const state = State.createState({
    chips: [
      { id: 'bad', type: '__proto__' },
      { id: 'prompt-many', type: 'project_prompt', sectionCount: Number.MAX_SAFE_INTEGER, sections: nested },
      ...many,
    ],
  }, Array.from({ length: 80 }, () => ({ message: 'x' })));
  assert.equal(state.snapshot.chips.length, State.MAX_CHIPS - 1);
  assert.equal(state.snapshot.errors.length, State.MAX_ERRORS);
  const prompt = state.snapshot.chips.find(chip => chip.id === 'prompt-many');
  assert.equal(prompt.sections.length, State.MAX_PROMPT_SECTIONS);
  assert(prompt.sections.every(section => section.level <= 6 && section.bytes === 0));
  assert(Object.isFrozen(prompt.sections[0].locator));
  assert.equal({}.polluted, undefined);
});

check('project prompt 章节 locator 必须携带与父 Chip 完全一致的 revision', () => {
  const state = State.createState({
    chips: [{
      id: 'prompt-revision', type: 'project_prompt', revision: 'rev-current',
      sections: [
        { id: 'valid', heading: '有效', status: 'used', locator: { filePath: 'edit.md', revision: 'rev-current', offset: 1, endOffset: 2 } },
        { id: 'missing', heading: '缺失', status: 'used', locator: { filePath: 'edit.md', offset: 2, endOffset: 3 } },
        { id: 'mismatch', heading: '错配', status: 'used', locator: { filePath: 'edit.md', revision: 'rev-old', offset: 3, endOffset: 4 } },
      ],
    }],
  }, []);
  const sections = state.snapshot.chips[0].sections;
  assert.equal(sections[0].locator.revision, 'rev-current');
  assert.equal(sections[1].locator, null);
  assert.equal(sections[2].locator, null);
});

check('右侧书签组件不使用 innerHTML，且仅回传 excludedChipIds policy', () => {
  const base = path.join(__dirname, '..', 'src', 'renderer');
  const component = fs.readFileSync(path.join(base, 'context-inspector.js'), 'utf8');
  const css = fs.readFileSync(path.join(base, 'context-inspector.css'), 'utf8');
  assert(!component.includes('innerHTML'));
  assert(component.includes("options.onPolicyChange?.(State.requestPolicy(state))"));
  assert(component.includes("['actual', '本次回复']"));
  assert(component.includes("['next', `下次提问"));
  assert(component.includes('context-inspector__sections'));
  assert(component.includes('context-inspector__section--${section.status}'));
  assert(css.includes('.context-inspector__card::before'));
  assert(css.includes('.context-inspector__section--omitted'));
  assert(css.includes(':focus-visible'));
  const integration = fs.readFileSync(path.join(base, 'assistant-workspace.js'), 'utf8');
  assert(integration.includes('revealContextChip'));
  assert(integration.includes('revision: locator.revision || null'));
});

check('本次/下次页签具有完整 ARIA 绑定、roving tabindex 与键盘导航', () => {
  assert.match(viewSource, /aria-controls', 'context-inspector-content'/);
  assert.match(viewSource, /content\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(viewSource, /button\.tabIndex = view\.tab === tab \? 0 : -1/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) assert.ok(viewSource.includes(`event.key === '${key}'`));
});

if (!process.exitCode) console.log(`\n✅ Context Inspector ${passed}/${passed} 全过`);
