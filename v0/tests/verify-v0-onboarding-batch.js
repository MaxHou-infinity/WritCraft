'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOnboardingCapabilityStore } = require('../src/main/onboarding-capability-store');
const batchModule = require('../src/main/onboarding-batch-service');
const {
  STAGE_PREFIX,
  templateForSuggestion,
  revisionFor,
  createOnboardingBatchService,
} = batchModule;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function makeRoot(withMetadata = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-batch-')));
  if (withMetadata) fs.mkdirSync(path.join(root, '.writcraft'), { mode: 0o700 });
  return root;
}

const PROJECT = `instance_${'a'.repeat(24)}`;
const REVISION = sha('edit');
const DIGEST = `sha256:${sha('proposal')}`;
const SUGGESTIONS = Object.freeze([
  Object.freeze({ path: 'chapters/01.md', title: '开场', reason: '第一章' }),
  Object.freeze({ path: 'appendix/notes.markdown', title: '备注', reason: '保留开放问题' }),
]);

function harness(root, suggestions = SUGGESTIONS, options = {}) {
  const store = createOnboardingCapabilityStore();
  const bindingChecks = [];
  const projectInstanceId = options.projectInstanceId || PROJECT;
  const mutationGeneration = options.mutationGeneration ?? 3;
  const editRevision = options.editRevision || REVISION;
  const proposalDigest = options.proposalDigest || DIGEST;
  const confirmationToken = store.createNoOp({
    projectInstanceId,
    rootPath: root,
    mutationGeneration,
    baseEditRevision: editRevision,
    expectedAppliedRevision: editRevision,
    proposalDigest,
    fileSuggestions: suggestions,
  });
  return {
    store,
    bindingChecks,
    service: createOnboardingBatchService({
      capabilityStore: store,
      bindingValidator: binding => {
        bindingChecks.push(binding);
        return options.bindingValidator ? options.bindingValidator(binding) : true;
      },
    }),
    request: {
      confirmationToken,
      projectInstanceId,
      rootPath: root,
      mutationGeneration,
      editRevision,
      proposalDigest,
      selectedPaths: options.selectedPaths || suggestions.map(item => item.path),
    },
  };
}

function invoke(subject, overrides = {}) {
  return subject.service.confirmAndCreate({ ...subject.request, ...overrides });
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code, `expected ${code}`);
}

function captureCode(code, fn) {
  try {
    fn();
  } catch (error) {
    assert.strictEqual(error?.code, code, `expected ${code}`);
    return error;
  }
  assert.fail(`expected ${code}`);
}

function expectReplay(subject) {
  expectCode('CAPABILITY_NOT_FOUND', () => invoke(subject));
}

function stageEntries(root) {
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) return [];
  return fs.readdirSync(metadata).filter(name => name.startsWith(STAGE_PREFIX));
}

function assertNoServiceTargets(root, suggestions = SUGGESTIONS) {
  for (const item of suggestions) {
    assert.strictEqual(fs.existsSync(path.join(root, ...item.path.split('/'))), false, item.path);
  }
  assert.deepStrictEqual(stageEntries(root), []);
}

console.log('\nOnboarding v2 atomic batch verification');

test('exports only the authentic-store coordinator and no consumed-envelope commit entry', () => {
  assert.strictEqual(Object.hasOwn(batchModule, 'createOnboardingFilesBatch'), false);
  assert.strictEqual(Object.hasOwn(batchModule, 'normalizeConsumedSelection'), false);
  expectCode('INVALID_CAPABILITY_STORE', () => createOnboardingBatchService({
    capabilityStore: { consume() {}, invalidate() {} },
    bindingValidator: () => true,
  }));
  const store = createOnboardingCapabilityStore();
  expectCode('INVALID_CAPABILITY_STORE', () => createOnboardingBatchService({ capabilityStore: store }));
  expectCode('INVALID_BINDING_VALIDATOR', () => createOnboardingBatchService({
    capabilityStore: store,
    bindingValidator: true,
  }));
});

test('creates Main-owned blank templates through a real one-time capability', () => {
  const root = makeRoot();
  try {
    const subject = harness(root);
    const result = invoke(subject);
    assert.deepStrictEqual({
      ok: result.ok,
      source: result.source,
      projectInstanceId: result.projectInstanceId,
      rootPath: result.rootPath,
      mutationGeneration: result.mutationGeneration,
      editRevision: result.editRevision,
      proposalDigest: result.proposalDigest,
    }, {
      ok: true,
      source: 'no_op',
      projectInstanceId: PROJECT,
      rootPath: root,
      mutationGeneration: 3,
      editRevision: REVISION,
      proposalDigest: DIGEST,
    });
    assert.deepStrictEqual(result.files.map(item => item.path), SUGGESTIONS.map(item => item.path));
    for (const [index, suggestion] of SUGGESTIONS.entries()) {
      const expected = templateForSuggestion(suggestion);
      assert.strictEqual(expected, `# ${suggestion.title}\n\n`);
      assert.strictEqual(fs.readFileSync(path.join(root, ...suggestion.path.split('/')), 'utf8'), expected);
      assert.deepStrictEqual(result.files[index], {
        path: suggestion.path,
        bytes: Buffer.byteLength(expected, 'utf8'),
        revision: revisionFor(expected),
      });
    }
    assert.deepStrictEqual(stageEntries(root), []);
    assert.deepStrictEqual(subject.bindingChecks.map(item => item.checkpoint), [
      'before_publish', 'before_stage_cleanup',
    ]);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('creates only the selected subset and consumes even an empty selection', () => {
  for (const selectedPaths of [['appendix/notes.markdown'], []]) {
    const root = makeRoot(false);
    try {
      const subject = harness(root, SUGGESTIONS, { selectedPaths });
      const result = invoke(subject);
      assert.deepStrictEqual(result.files.map(item => item.path), selectedPaths);
      assert.strictEqual(fs.existsSync(path.join(root, 'chapters', '01.md')), false);
      if (selectedPaths.length) {
        assert.strictEqual(fs.readFileSync(path.join(root, 'appendix', 'notes.markdown'), 'utf8'), '# 备注\n\n');
      } else {
        assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
        assert.deepStrictEqual(subject.bindingChecks.map(item => item.checkpoint), ['before_empty_success']);
      }
      expectReplay(subject);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('Main binding drift before first publication removes private stage with zero project writes', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root, SUGGESTIONS, {
      bindingValidator: binding => binding.checkpoint !== 'before_publish',
    });
    expectCode('BINDING_CHANGED', () => invoke(subject));
    assertNoServiceTargets(root);
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
    assert.deepStrictEqual(subject.bindingChecks.map(item => item.checkpoint), ['before_publish']);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Main binding drift before stage cleanup rolls back every already-published target', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root, SUGGESTIONS, {
      bindingValidator: binding => binding.checkpoint !== 'before_stage_cleanup',
    });
    expectCode('BINDING_CHANGED', () => invoke(subject));
    assertNoServiceTargets(root);
    assert.strictEqual(fs.existsSync(path.join(root, 'chapters')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'appendix')), false);
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
    assert.deepStrictEqual(subject.bindingChecks.map(item => item.checkpoint), [
      'before_publish', 'before_stage_cleanup',
    ]);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects forged structured envelopes with no public commit path and burns the token', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    expectCode('INVALID_CONFIRM_REQUEST', () => invoke(subject, {
      source: 'no_op',
      fileSuggestions: SUGGESTIONS.slice(0, 1),
    }));
    assertNoServiceTargets(root, SUGGESTIONS.slice(0, 1));
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project, root, generation, revision and digest drift fail closed and burn the token', () => {
  const otherRoot = makeRoot(false);
  try {
    const mutations = [
      { projectInstanceId: `instance_${'b'.repeat(24)}` },
      { rootPath: otherRoot },
      { mutationGeneration: 4 },
      { editRevision: sha('changed-edit') },
      { proposalDigest: `sha256:${sha('changed-proposal')}` },
    ];
    for (const mutation of mutations) {
      const root = makeRoot(false);
      try {
        const subject = harness(root, SUGGESTIONS.slice(0, 1));
        expectCode('STALE_CONFIRMATION', () => invoke(subject, mutation));
        assertNoServiceTargets(root, SUGGESTIONS.slice(0, 1));
        assert.strictEqual(fs.existsSync(path.join(otherRoot, 'chapters', '01.md')), false);
        expectReplay(subject);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(otherRoot, { recursive: true, force: true }); }
});

test('invalid selected paths are terminal and cannot be retried', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    expectCode('INVALID_SELECTION', () => invoke(subject, { selectedPaths: ['not-proposed.md'] }));
    assertNoServiceTargets(root, SUGGESTIONS.slice(0, 1));
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('full preflight rejects an existing target or parent file with zero service writes', () => {
  for (const parentIsFile of [false, true]) {
    const root = makeRoot();
    try {
      if (parentIsFile) fs.writeFileSync(path.join(root, 'chapters'), 'not a directory');
      else {
        fs.mkdirSync(path.join(root, 'chapters'));
        fs.writeFileSync(path.join(root, 'chapters', '01.md'), '# existing\n');
      }
      const subject = harness(root);
      expectCode(parentIsFile ? 'PARENT_NOT_DIRECTORY' : 'FILE_EXISTS', () => invoke(subject));
      assert.strictEqual(fs.existsSync(path.join(root, 'appendix', 'notes.markdown')), false);
      assert.deepStrictEqual(stageEntries(root), []);
      expectReplay(subject);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('rejects symlink parents and existing hard-link targets without touching their owners', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, 'chapters'));
    let subject = harness(root, SUGGESTIONS.slice(0, 1));
    expectCode('SYMLINK_NOT_ALLOWED', () => invoke(subject));
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    expectReplay(subject);
    fs.unlinkSync(path.join(root, 'chapters'));

    fs.mkdirSync(path.join(root, 'chapters'));
    const source = path.join(outside, 'source.md');
    fs.writeFileSync(source, '# hard link source\n');
    fs.linkSync(source, path.join(root, 'chapters', '01.md'));
    subject = harness(root, SUGGESTIONS.slice(0, 1));
    expectCode('FILE_EXISTS', () => invoke(subject));
    assert.strictEqual(fs.readFileSync(source, 'utf8'), '# hard link source\n');
    assert.strictEqual(fs.statSync(source).ino, fs.statSync(path.join(root, 'chapters', '01.md')).ino);
    expectReplay(subject);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('preflight and staging faults leave no target, directory or private stage residue', () => {
  for (const [hook, failIndex] of [['preflight', 0], ['stage', 1]]) {
    const root = makeRoot(false);
    try {
      const subject = harness(root);
      const faultHooks = {
        [hook]: context => {
          if (hook === 'preflight' || context.index === failIndex) throw new Error(`${hook} injected`);
        },
      };
      expectCode(hook === 'preflight' ? 'PREFLIGHT_FAILED' : 'STAGE_FAILED', () => invoke(subject, { faultHooks }));
      assertNoServiceTargets(root);
      assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
      expectReplay(subject);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('mid-commit failure rolls back every service inode and newly created directory', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root);
    expectCode('COMMIT_FAILED', () => invoke(subject, {
      faultHooks: { commit: ({ index }) => { if (index === 1) throw new Error('commit injected'); } },
    }));
    assertNoServiceTargets(root);
    assert.strictEqual(fs.existsSync(path.join(root, 'chapters')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'appendix')), false);
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('EXDEV commit failure rolls back the earlier linked inode', () => {
  const root = makeRoot();
  try {
    const subject = harness(root);
    expectCode('CROSS_DEVICE_COMMIT', () => invoke(subject, {
      faultHooks: { commit: ({ index }) => {
        if (index === 1) {
          const error = new Error('cross-device link');
          error.code = 'EXDEV';
          throw error;
        }
      } },
    }));
    assertNoServiceTargets(root);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a concurrent target occupant is preserved while earlier service links roll back', () => {
  const root = makeRoot();
  try {
    const subject = harness(root);
    expectCode('FILE_EXISTS', () => invoke(subject, {
      faultHooks: { commit: ({ index, path: filePath }) => {
        if (index === 1) fs.writeFileSync(path.join(root, ...filePath.split('/')), '# concurrent owner\n', { flag: 'wx' });
      } },
    }));
    assert.strictEqual(fs.existsSync(path.join(root, 'chapters', '01.md')), false);
    assert.strictEqual(fs.readFileSync(path.join(root, 'appendix', 'notes.markdown'), 'utf8'), '# concurrent owner\n');
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rollback hook failure is reported after cleanup still removes every service inode', () => {
  const root = makeRoot(false);
  try {
    const subject = harness(root);
    const error = captureCode('ROLLBACK_FAILED', () => invoke(subject, {
      faultHooks: {
        commit: ({ index }) => { if (index === 1) throw new Error('force rollback'); },
        rollback: () => { throw new Error('rollback observer failure'); },
      },
    }));
    assert.strictEqual(error.cause?.code, 'COMMIT_FAILED');
    assert.strictEqual(error.cause?.cause?.message, 'force rollback');
    assertNoServiceTargets(root);
    assert.strictEqual(fs.existsSync(path.join(root, '.writcraft')), false);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rollback never deletes a competing inode that replaced the selected target', () => {
  const root = makeRoot();
  let replaced = false;
  try {
    const subject = harness(root);
    expectCode('COMMIT_FAILED', () => invoke(subject, {
      faultHooks: {
        commit: ({ index }) => { if (index === 1) throw new Error('force rollback'); },
        rollback: ({ path: filePath }) => {
          if (replaced) return;
          replaced = true;
          const target = path.join(root, ...filePath.split('/'));
          fs.unlinkSync(target);
          fs.writeFileSync(target, '# replacement owner\n', { flag: 'wx' });
        },
      },
    }));
    assert.strictEqual(fs.readFileSync(path.join(root, 'chapters', '01.md'), 'utf8'), '# replacement owner\n');
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a parent swapped to a symlink before link cannot redirect staged content outside', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-race-outside-'));
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    expectCode('ROLLBACK_FAILED', () => invoke(subject, {
      faultHooks: { commit: () => {
        fs.rmdirSync(path.join(root, 'chapters'));
        fs.symlinkSync(outside, path.join(root, 'chapters'));
      } },
    }));
    assert.strictEqual(fs.existsSync(path.join(outside, '01.md')), false);
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a parent swapped inside linkSync rolls back its outside hard link and preserves competitors', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-link-race-outside-'));
  const originalLinkSync = fs.linkSync;
  try {
    fs.writeFileSync(path.join(outside, 'competitor.md'), '# competitor\n');
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    let intercepted = false;
    fs.linkSync = (source, target) => {
      if (!intercepted && target === path.join(root, 'chapters', '01.md')) {
        intercepted = true;
        fs.rmdirSync(path.join(root, 'chapters'));
        fs.symlinkSync(outside, path.join(root, 'chapters'));
      }
      return originalLinkSync(source, target);
    };
    expectCode('ROLLBACK_FAILED', () => invoke(subject));
    assert.strictEqual(intercepted, true);
    assert.strictEqual(fs.existsSync(path.join(outside, '01.md')), false);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'competitor.md'), 'utf8'), '# competitor\n');
    assert.strictEqual(fs.lstatSync(path.join(root, 'chapters')).isSymbolicLink(), true);
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a link renamed to an unselected path before return is found by inode scan and removed', () => {
  const root = makeRoot();
  const originalLinkSync = fs.linkSync;
  const selected = path.join(root, 'chapters', '01.md');
  const unselected = path.join(root, 'moved-by-race.md');
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    let intercepted = false;
    fs.linkSync = (source, target) => {
      const result = originalLinkSync(source, target);
      if (!intercepted && target === selected) {
        intercepted = true;
        fs.renameSync(target, unselected);
        fs.writeFileSync(target, '# competing selected owner\n', { flag: 'wx' });
      }
      return result;
    };
    expectCode('COMMIT_INTEGRITY_FAILED', () => invoke(subject));
    assert.strictEqual(intercepted, true);
    assert.strictEqual(fs.existsSync(unselected), false, 'renamed service inode must be discovered and removed');
    assert.strictEqual(fs.readFileSync(selected, 'utf8'), '# competing selected owner\n');
    assert.notStrictEqual(fs.readFileSync(selected, 'utf8'), '# 开场\n\n');
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a selected link renamed after final nlink scan but before stage cleanup is rolled back', () => {
  const root = makeRoot();
  const originalRmSync = fs.rmSync;
  const selected = path.join(root, 'chapters', '01.md');
  const moved = path.join(root, 'moved-after-final-scan.md');
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    let intercepted = false;
    fs.rmSync = (target, options) => {
      if (!intercepted && path.basename(target).startsWith(STAGE_PREFIX)) {
        intercepted = true;
        fs.renameSync(selected, moved);
        fs.writeFileSync(selected, '# competing selected owner\n', { flag: 'wx' });
      }
      return originalRmSync(target, options);
    };
    expectCode('COMMIT_INTEGRITY_FAILED', () => invoke(subject));
    assert.strictEqual(intercepted, true);
    assert.strictEqual(fs.existsSync(moved), false, 'moved transaction inode must be removed after stage cleanup');
    assert.strictEqual(fs.readFileSync(selected, 'utf8'), '# competing selected owner\n');
    assert.notStrictEqual(fs.readFileSync(selected, 'utf8'), '# 开场\n\n');
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally {
    fs.rmSync = originalRmSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a mutation after the final published-path observation is external, not transaction state', () => {
  const root = makeRoot();
  const originalLstatSync = fs.lstatSync;
  const selected = path.join(root, 'chapters', '01.md');
  const moved = path.join(root, 'external-after-linearization.md');
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    let mutatedAfterObservation = false;
    fs.lstatSync = target => {
      const stat = originalLstatSync(target);
      if (!mutatedAfterObservation && target === path.dirname(selected) && stageEntries(root).length === 0) {
        // assertCommittedTargetSafe has already observed the final canonical
        // parent. This rename is a new external mutation after that observation.
        mutatedAfterObservation = true;
        fs.renameSync(selected, moved);
      }
      return stat;
    };
    const result = invoke(subject);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(mutatedAfterObservation, true);
    assert.strictEqual(fs.existsSync(selected), false);
    assert.strictEqual(fs.readFileSync(moved, 'utf8'), '# 开场\n\n');
    expectReplay(subject);
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stage nlink proves an unrecognized outside hard link and reports rollback failure', () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-onboarding-unidentified-link-'));
  const leaked = path.join(outside, 'unknown.md');
  const originalLinkSync = fs.linkSync;
  try {
    const subject = harness(root, SUGGESTIONS.slice(0, 1));
    let intercepted = false;
    fs.linkSync = (source, target) => {
      const result = originalLinkSync(source, target);
      if (!intercepted) {
        intercepted = true;
        originalLinkSync(source, leaked);
      }
      return result;
    };
    expectCode('ROLLBACK_FAILED', () => invoke(subject));
    assert.strictEqual(intercepted, true);
    assert.strictEqual(fs.existsSync(path.join(root, 'chapters', '01.md')), false);
    assert.strictEqual(fs.existsSync(leaked), true, 'outside unidentified link is proven, not falsely claimed cleaned');
    assert.deepStrictEqual(stageEntries(root), []);
    expectReplay(subject);
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/${passed} onboarding-batch checks passed.`);
