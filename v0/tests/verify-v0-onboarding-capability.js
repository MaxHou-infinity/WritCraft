'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const {
  DEFAULT_TTL_MS,
  REVIEW_ID_RE,
  CONFIRMATION_TOKEN_RE,
  createOnboardingCapabilityStore,
  isOnboardingCapabilityStore,
} = require('../src/main/onboarding-capability-store');

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

function idFactory() {
  let value = 0;
  return size => {
    value += 1;
    return Buffer.from(value.toString(16).padStart(size * 2, '0'), 'hex');
  };
}

const PROJECT = `instance_${'a'.repeat(24)}`;
const OTHER_PROJECT = `instance_${'b'.repeat(24)}`;
const ROOT = path.resolve('/tmp/writcraft-onboarding-capability-a');
const OTHER_ROOT = path.resolve('/tmp/writcraft-onboarding-capability-b');
const BASE = sha('before');
const APPLIED = sha('after');
const DIGEST = `sha256:${sha('proposal')}`;
const CHANGESET = `pc_${'c'.repeat(32)}`;
const SUGGESTIONS = Object.freeze([
  Object.freeze({ path: 'chapters/01.md', title: '第一章', reason: '建立开场' }),
  Object.freeze({ path: 'appendix/notes.markdown', title: '备注', reason: '保留开放问题' }),
]);

function reviewBinding(overrides = {}) {
  return {
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 7,
    baseEditRevision: BASE,
    expectedAppliedRevision: APPLIED,
    proposalDigest: DIGEST,
    fileSuggestions: SUGGESTIONS,
    changeSetId: CHANGESET,
    ...overrides,
  };
}

function application(overrides = {}) {
  return {
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 8,
    changeSetId: CHANGESET,
    editRevision: APPLIED,
    proposalDigest: DIGEST,
    appliedPaths: ['edit.md'],
    residual: false,
    ...overrides,
  };
}

function confirmation(overrides = {}) {
  return {
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 8,
    editRevision: APPLIED,
    proposalDigest: DIGEST,
    selectedPaths: ['chapters/01.md'],
    ...overrides,
  };
}

function expectCode(code, fn) {
  assert.throws(fn, error => error && error.code === code);
}

console.log('\nOnboarding v2 capability store verification');

test('brands only authentic capability stores for coordinator injection', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  assert.strictEqual(isOnboardingCapabilityStore(store), true);
  assert.strictEqual(isOnboardingCapabilityStore({ consume() {}, invalidate() {} }), false);
});

test('mints opaque review and confirmation handles without exposing bound records', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const reviewId = store.createReview(reviewBinding());
  assert(REVIEW_ID_RE.test(reviewId));
  assert(!reviewId.includes(PROJECT));
  const token = store.completeReview(reviewId, application());
  assert(CONFIRMATION_TOKEN_RE.test(token));
  assert(!token.includes(CHANGESET));
  assert.equal(store.size, 1);
});

test('mints a confirmation only after the exact edit ChangeSet fully applies at the post-write generation', () => {
  for (const bad of [
    { changeSetId: `pc_${'d'.repeat(32)}` },
    { editRevision: BASE },
    { proposalDigest: `sha256:${sha('other')}` },
    { mutationGeneration: 7 },
    { mutationGeneration: 9 },
    { appliedPaths: [] },
    { appliedPaths: ['edit.md', 'chapters/01.md'] },
    { residual: true },
    { projectInstanceId: OTHER_PROJECT },
    { rootPath: OTHER_ROOT },
  ]) {
    const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
    const reviewId = store.createReview(reviewBinding());
    expectCode('INCOMPLETE_APPLICATION', () => store.completeReview(reviewId, application(bad)));
    expectCode('CAPABILITY_NOT_FOUND', () => store.completeReview(reviewId, application()));
  }
});

test('consumes a valid confirmation exactly once and returns only the selected trusted metadata', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const token = store.completeReview(store.createReview(reviewBinding()), application());
  const result = store.consume(token, confirmation());
  assert.deepStrictEqual(result.fileSuggestions, [SUGGESTIONS[0]]);
  assert.strictEqual(result.source, 'review');
  assert.deepStrictEqual({
    projectInstanceId: result.projectInstanceId,
    rootPath: result.rootPath,
    mutationGeneration: result.mutationGeneration,
    editRevision: result.editRevision,
    proposalDigest: result.proposalDigest,
  }, {
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 8,
    editRevision: APPLIED,
    proposalDigest: DIGEST,
  });
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.fileSuggestions));
  expectCode('CAPABILITY_NOT_FOUND', () => store.consume(token, confirmation()));
});

test('invalid selections never consume a still-current token', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const token = store.completeReview(store.createReview(reviewBinding()), application());
  expectCode('INVALID_SELECTION', () => store.consume(token, confirmation({ selectedPaths: ['chapters/01.md', 'chapters/01.md'] })));
  expectCode('INVALID_SELECTION', () => store.consume(token, confirmation({ selectedPaths: ['chapters/not-proposed.md'] })));
  const result = store.consume(token, confirmation({ selectedPaths: ['appendix/notes.markdown'] }));
  assert.deepStrictEqual(result.fileSuggestions, [SUGGESTIONS[1]]);
});

test('project, root, generation, revision or digest drift invalidates a confirmation fail-closed', () => {
  for (const stale of [
    { projectInstanceId: OTHER_PROJECT },
    { rootPath: OTHER_ROOT },
    { mutationGeneration: 9 },
    { editRevision: BASE },
    { proposalDigest: `sha256:${sha('other')}` },
  ]) {
    const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
    const token = store.completeReview(store.createReview(reviewBinding()), application());
    expectCode('STALE_CONFIRMATION', () => store.consume(token, confirmation(stale)));
    expectCode('CAPABILITY_NOT_FOUND', () => store.consume(token, confirmation()));
  }
});

test('no-op uses an independent token path and still requires a later explicit consume', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const token = store.createNoOp({
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 7,
    baseEditRevision: BASE,
    expectedAppliedRevision: BASE,
    proposalDigest: DIGEST,
    fileSuggestions: SUGGESTIONS,
  });
  assert(CONFIRMATION_TOKEN_RE.test(token));
  assert.equal(store.size, 1, 'minting a no-op token is not the confirmation itself');
  const consumed = store.consume(token, confirmation({ mutationGeneration: 7, editRevision: BASE, selectedPaths: [] }));
  assert.strictEqual(consumed.source, 'no_op');
  assert.deepStrictEqual(consumed.fileSuggestions, []);
});

test('rejects a no-op on the review path and a changed revision on the no-op path', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  expectCode('NOOP_REQUIRES_TOKEN', () => store.createReview(reviewBinding({ expectedAppliedRevision: BASE })));
  expectCode('INVALID_NOOP', () => store.createNoOp({
    projectInstanceId: PROJECT,
    rootPath: ROOT,
    mutationGeneration: 7,
    baseEditRevision: BASE,
    expectedAppliedRevision: APPLIED,
    proposalDigest: DIGEST,
    fileSuggestions: [],
  }));
});

test('expires both review and confirmation records after thirty minutes', () => {
  let now = 1_000;
  const store = createOnboardingCapabilityStore({ now: () => now, randomBytes: idFactory() });
  const reviewId = store.createReview(reviewBinding());
  now += DEFAULT_TTL_MS;
  expectCode('CAPABILITY_NOT_FOUND', () => store.completeReview(reviewId, application()));

  const token = store.createNoOp({
    projectInstanceId: PROJECT, rootPath: ROOT, mutationGeneration: 7,
    baseEditRevision: BASE, expectedAppliedRevision: BASE, proposalDigest: DIGEST, fileSuggestions: [],
  });
  now += DEFAULT_TTL_MS;
  expectCode('CAPABILITY_NOT_FOUND', () => store.consume(token, confirmation({ mutationGeneration: 7, editRevision: BASE, selectedPaths: [] })));
  assert.equal(store.size, 0);
});

test('reports only live project-scoped review and confirmation authority for Main admission control', () => {
  let now = 2_000;
  const store = createOnboardingCapabilityStore({ now: () => now, randomBytes: idFactory() });
  const reviewId = store.createReview(reviewBinding());
  const token = store.createNoOp({
    projectInstanceId: PROJECT, rootPath: ROOT, mutationGeneration: 7,
    baseEditRevision: BASE, expectedAppliedRevision: BASE, proposalDigest: DIGEST, fileSuggestions: [],
  });
  store.createNoOp({
    projectInstanceId: OTHER_PROJECT, rootPath: OTHER_ROOT, mutationGeneration: 1,
    baseEditRevision: BASE, expectedAppliedRevision: BASE,
    proposalDigest: `sha256:${sha('other-project')}`, fileSuggestions: [],
  });
  assert.strictEqual(store.hasActive(reviewId, 'review'), true);
  assert.strictEqual(store.hasActive(token, 'confirmation'), true);
  assert.deepStrictEqual(store.activeCountsByProject(PROJECT, ROOT), { review: 1, confirmation: 1 });
  assert.deepStrictEqual(store.activeCountsByProject(OTHER_PROJECT, OTHER_ROOT), { review: 0, confirmation: 1 });
  assert(Object.isFrozen(store.activeCountsByProject(PROJECT, ROOT)));

  now += DEFAULT_TTL_MS;
  assert.strictEqual(store.hasActive(reviewId, 'review'), false);
  assert.strictEqual(store.hasActive(token, 'confirmation'), false);
  assert.deepStrictEqual(store.activeCountsByProject(PROJECT, ROOT), { review: 0, confirmation: 0 });
  assert.equal(store.size, 0);
});

test('enforces one shared eight-entry LRU bound across reviews and confirmations', () => {
  const store = createOnboardingCapabilityStore({ maxEntries: 8, randomBytes: idFactory() });
  const tokens = [];
  for (let index = 0; index < 9; index += 1) {
    tokens.push(store.createNoOp({
      projectInstanceId: PROJECT, rootPath: ROOT, mutationGeneration: index,
      baseEditRevision: BASE, expectedAppliedRevision: BASE,
      proposalDigest: `sha256:${sha(`proposal-${index}`)}`, fileSuggestions: [],
    }));
  }
  assert.equal(store.size, 8);
  expectCode('CAPABILITY_NOT_FOUND', () => store.consume(tokens[0], confirmation({ mutationGeneration: 0, editRevision: BASE, proposalDigest: `sha256:${sha('proposal-0')}`, selectedPaths: [] })));
  assert.deepStrictEqual(store.consume(tokens[8], confirmation({ mutationGeneration: 8, editRevision: BASE, proposalDigest: `sha256:${sha('proposal-8')}`, selectedPaths: [] })).fileSuggestions, []);
});

test('supports explicit discard, residual/stale and project-switch invalidation', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const first = store.createReview(reviewBinding());
  assert.strictEqual(store.invalidate(first), true);
  assert.strictEqual(store.invalidate(first), false);

  const second = store.createReview(reviewBinding({ changeSetId: `pc_${'d'.repeat(32)}` }));
  assert.equal(store.invalidateByChangeSet(`pc_${'d'.repeat(32)}`), 1);
  expectCode('CAPABILITY_NOT_FOUND', () => store.completeReview(second, application({ changeSetId: `pc_${'d'.repeat(32)}` })));

  store.createReview(reviewBinding());
  store.createNoOp({
    projectInstanceId: PROJECT, rootPath: ROOT, mutationGeneration: 7,
    baseEditRevision: BASE, expectedAppliedRevision: BASE, proposalDigest: DIGEST, fileSuggestions: [],
  });
  assert.equal(store.invalidateByProject(PROJECT, ROOT), 2);
  assert.equal(store.size, 0);
});

test('copies and freezes suggestion metadata so caller mutation cannot widen authority', () => {
  const suggestions = [{ path: 'chapters/01.md', title: '第一章', reason: '原因' }];
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const token = store.createNoOp({
    projectInstanceId: PROJECT, rootPath: ROOT, mutationGeneration: 7,
    baseEditRevision: BASE, expectedAppliedRevision: BASE, proposalDigest: DIGEST, fileSuggestions: suggestions,
  });
  suggestions[0].path = 'chapters/evil.md';
  suggestions.push({ path: 'chapters/extra.md', title: '多余', reason: '多余' });
  const result = store.consume(token, confirmation({ mutationGeneration: 7, editRevision: BASE }));
  assert.deepStrictEqual(result.fileSuggestions.map(item => item.path), ['chapters/01.md']);
  assert(Object.isFrozen(result.fileSuggestions[0]));
});

test('rejects unknown fields, protected paths, content-bearing suggestions and case-insensitive duplicates', () => {
  const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  expectCode('INVALID_RECORD', () => store.createReview({ ...reviewBinding(), extra: true }));
  for (const filePath of ['edit.md', '.writcraft/a.md', 'references/a.md', 'sources/a.md', '../a.md', '/tmp/a.md']) {
    expectCode(filePath.startsWith('../') || filePath.startsWith('/') ? 'INVALID_SUGGESTION_PATH' : 'PROTECTED_SUGGESTION_PATH', () =>
      store.createReview(reviewBinding({ fileSuggestions: [{ path: filePath, title: 'A', reason: 'B' }] })));
  }
  expectCode('INVALID_SUGGESTION', () => store.createReview(reviewBinding({
    fileSuggestions: [{ path: 'a.md', title: 'A', reason: 'B', content: '# forbidden' }],
  })));
  expectCode('DUPLICATE_SUGGESTION', () => store.createReview(reviewBinding({
    fileSuggestions: [
      { path: 'Chapters/A.md', title: 'A', reason: 'A' },
      { path: 'chapters/a.md', title: 'B', reason: 'B' },
    ],
  })));
});

test('matches v2 NFC, title 120/256-byte and reason 500/1024-byte metadata bounds', () => {
  const validStore = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  const valid = validStore.createReview(reviewBinding({
    fileSuggestions: [{ path: '章节/开场.md', title: 'T'.repeat(120), reason: 'R'.repeat(500) }],
  }));
  assert(REVIEW_ID_RE.test(valid));

  for (const item of [
    { path: `chapters/e\u0301.md`, title: 'A', reason: 'B' },
    { path: 'chapters/bad\nname.md', title: 'A', reason: 'B' },
    { path: 'chapters/bad\tname.md', title: 'A', reason: 'B' },
    { path: 'chapters/bad\u007fname.md', title: 'A', reason: 'B' },
    { path: 'chapters/bad\u0085name.md', title: 'A', reason: 'B' },
    { path: 'a.md', title: 'T'.repeat(121), reason: 'B' },
    { path: 'a.md', title: '界'.repeat(86), reason: 'B' },
    { path: 'a.md', title: 'A', reason: 'R'.repeat(501) },
    { path: 'a.md', title: 'A', reason: '界'.repeat(342) },
    { path: 'a.md', title: 'A\n# injected', reason: 'B' },
  ]) {
    const store = createOnboardingCapabilityStore({ randomBytes: idFactory() });
    assert.throws(() => store.createReview(reviewBinding({ fileSuggestions: [item] })));
  }

  const conflictStore = createOnboardingCapabilityStore({ randomBytes: idFactory() });
  expectCode('DUPLICATE_SUGGESTION', () => conflictStore.createReview(reviewBinding({
    fileSuggestions: [
      { path: 'outline.md', title: 'A', reason: 'A' },
      { path: 'outline.md/child.md', title: 'B', reason: 'B' },
    ],
  })));
});

console.log(`\n${passed}/${passed} onboarding-capability checks passed.`);
