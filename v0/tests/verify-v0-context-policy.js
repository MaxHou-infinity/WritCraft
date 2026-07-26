#!/usr/bin/env node
'use strict';

const assert = require('assert');
const policyService = require('../src/main/context-policy-service');

let passed = 0;
function check(label, run) {
  try { run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.message}`); process.exitCode = 1; }
}

function manifest(chips) {
  return {
    scope: 'file',
    currentFilePath: 'chapters/01.md',
    currentRevision: 'rev-current',
    usedBytes: 2048,
    chips: chips || [
      { id: 'prompt', type: 'project_prompt', label: 'edit.md', revision: 'rev-prompt' },
      { id: 'file', type: 'file', label: '01.md', revision: 'rev-file' },
      { id: 'source', type: 'source', label: '访谈' },
      { id: 'entity', type: 'entity', label: '林岚' },
    ],
  };
}

function throwsCode(code, run) {
  assert.throws(run, error => error instanceof policyService.ContextPolicyError && error.code === code);
}

console.log('════════ WritCraft V0 · Main Context Policy verify ════════');

check('仅接受权威 Manifest 中的可选 Chip，并输出有界 Main policy', () => {
  const result = policyService.createExclusionPolicy(manifest(), ['source', 'file']);
  assert.equal(result.version, 1);
  assert.equal(result.authority, 'main-context-policy');
  assert.deepStrictEqual(result.excludedChipIds, ['source', 'file']);
  assert.deepStrictEqual(result.includedChipIds, ['prompt', 'entity']);
  assert.match(result.manifestBinding, /^[a-f0-9]{64}$/);
  assert.equal(result.limits.maxExcludedChips, policyService.MAX_EXCLUDED_CHIPS);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.excludedChipIds));
});

check('重复 ID 按首次出现顺序规范化，不消耗额外 policy 配额', () => {
  const result = policyService.createExclusionPolicy(manifest(), ['entity', 'entity', 'source', 'entity']);
  assert.deepStrictEqual(result.excludedChipIds, ['entity', 'source']);
});

check('project_prompt 永不可排除', () => {
  throwsCode('REQUIRED_CONTEXT', () => policyService.createExclusionPolicy(manifest(), ['prompt']));
});

check('scope 也是不可移除的 Main 权威上下文', () => {
  const source = manifest([
    { id: 'scope-project', type: 'scope', label: '项目作用域' },
    { id: 'prompt', type: 'project_prompt', label: 'edit.md' },
  ]);
  assert.throws(() => policyService.createExclusionPolicy(source, ['scope-project']), error => error.code === 'REQUIRED_CONTEXT');
});

check('selection 是选区作用域的必需上下文，Main 永不允许排除', () => {
  const source = manifest([
    { id: 'scope-selection', type: 'scope', label: '选区作用域' },
    { id: 'prompt', type: 'project_prompt', label: 'edit.md' },
    { id: 'selection-current', type: 'selection', label: '当前选段' },
  ]);
  throwsCode('REQUIRED_CONTEXT', () => policyService.createExclusionPolicy(source, ['selection-current']));
});

check('未知、畸形及非数组输入全部 fail closed', () => {
  throwsCode('UNKNOWN_CONTEXT', () => policyService.createExclusionPolicy(manifest(), ['forged-chip']));
  throwsCode('INVALID_CHIP_ID', () => policyService.createExclusionPolicy(manifest(), ['bad\u0000id']));
  throwsCode('INVALID_POLICY', () => policyService.createExclusionPolicy(manifest(), { source: true }));
});

check('唯一排除数与原始输入工作量均有硬上限', () => {
  const optional = Array.from({ length: policyService.MAX_EXCLUDED_CHIPS + 1 }, (_, index) => ({ id: `f-${index}`, type: 'file' }));
  const boundedManifest = manifest([{ id: 'prompt', type: 'project_prompt' }, ...optional]);
  throwsCode('POLICY_LIMIT', () => policyService.createExclusionPolicy(boundedManifest, optional.map(chip => chip.id)));
  throwsCode('POLICY_INPUT_LIMIT', () => policyService.createExclusionPolicy(manifest(), Array(81).fill('source')));
});

check('无效、重复或超量 Manifest 不可成为白名单', () => {
  throwsCode('INVALID_MANIFEST', () => policyService.createExclusionPolicy(null, []));
  throwsCode('DUPLICATE_MANIFEST_CHIP', () => policyService.createExclusionPolicy(manifest([
    { id: 'same', type: 'file' }, { id: 'same', type: 'source' },
  ]), []));
  throwsCode('MANIFEST_LIMIT', () => policyService.createExclusionPolicy(manifest(
    Array.from({ length: policyService.MAX_MANIFEST_CHIPS + 1 }, (_, index) => ({ id: `m-${index}`, type: 'file' })),
  ), []));
});

check('策略绑定精确 Manifest，revision 或 Chip 集合变化后必须重新由 Main 校验', () => {
  const current = manifest();
  const policy = policyService.createExclusionPolicy(current, ['source']);
  assert.equal(policyService.policyAppliesToManifest(current, policy), true);
  assert.equal(policyService.policyAppliesToManifest({ ...current, currentRevision: 'rev-new' }, policy), false);
  assert.equal(policyService.policyAppliesToManifest({ ...current, chips: current.chips.slice(0, 3) }, policy), false);
  assert.equal(policyService.policyAppliesToManifest(current, { ...policy, manifestBinding: 'not-a-hash' }), false);
});

check('建立策略不会修改本次 response Manifest 或其 Chip', () => {
  const current = manifest();
  const before = JSON.stringify(current);
  const promptRef = current.chips[0];
  policyService.createExclusionPolicy(current, ['file']);
  assert.equal(JSON.stringify(current), before);
  assert.strictEqual(current.chips[0], promptRef);
  assert.equal(current.chips.length, 4);
});

if (!process.exitCode) console.log(`\n✅ Main Context Policy ${passed}/${passed} 全过`);
