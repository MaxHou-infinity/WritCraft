#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const {
  DEFAULT_TTL_MS,
  createOnboardingCapabilityStore,
} = require('../src/main/onboarding-capability-store');
const {
  createOnboardingAdmission,
  createProposeOnboardingHandler,
} = require('../src/main/project-onboarding-handler');
const {
  createPendingChangeSetStore,
} = require('../src/main/pending-changeset-store');

let passed = 0;

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

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function test(name, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const PROJECT = Object.freeze({
  instanceId: `instance_${'a'.repeat(24)}`,
  rootPath: path.resolve('/tmp/writcraft-onboarding-handler'),
});
const BASE = sha('edit-before');
const AFTER = sha('edit-after');

function noOpProposal(serial) {
  return Object.freeze({
    ok: true,
    noChanges: true,
    proposalDigest: `sha256:${sha(`no-op-${serial}`)}`,
    fileSuggestions: Object.freeze([]),
    contextManifest: Object.freeze({
      targetRevision: BASE,
      targetAfterRevision: BASE,
    }),
  });
}

function changedProposal(serial) {
  return Object.freeze({
    ok: true,
    noChanges: false,
    proposalDigest: `sha256:${sha(`changed-${serial}`)}`,
    fileSuggestions: Object.freeze([]),
    contextManifest: Object.freeze({
      targetRevision: BASE,
      targetAfterRevision: AFTER,
    }),
    changeSet: Object.freeze({ id: `model-change-${serial}` }),
  });
}

function harness(options = {}) {
  let now = 1_000;
  let mutationGeneration = 7;
  let rendererNavigationEpoch = 3;
  let currentProject = PROJECT;
  const capabilityStore = createOnboardingCapabilityStore({
    now: () => now,
    randomBytes: idFactory(),
  });
  const pendingOnboardingReviews = new Map();
  const pendingChangeSets = new Map();
  const admission = createOnboardingAdmission({
    capabilityStore,
    pendingOnboardingReviews,
    pendingChangeSets,
  });
  let cacheSerial = 0;
  const handler = createProposeOnboardingHandler({
    assertTrustedSender() {},
    requireCurrentProject() { return PROJECT; },
    getCurrentProject() { return currentProject; },
    getMutationGeneration() { return mutationGeneration; },
    getRendererNavigationEpoch() { return rendererNavigationEpoch; },
    assertOnboardingFlowAvailable: admission.assertAvailable,
    projectOnboardingV2Service: options.projectOnboardingV2Service,
    projectService: Object.freeze({ marker: 'injected-project-service' }),
    projectCallLLM(instanceId) {
      assert.strictEqual(instanceId, PROJECT.instanceId);
      return async () => ({ ok: true });
    },
    onboardingCapabilityStore: capabilityStore,
    cacheReviewedChangeSet(changeSet, project, cacheOptions) {
      assert.strictEqual(project, PROJECT);
      assert.deepStrictEqual(cacheOptions, { selectionPolicy: 'file' });
      cacheSerial += 1;
      const capability = `pc_${String(cacheSerial).padStart(32, 'a')}`;
      const cached = Object.freeze({
        capability,
        review: Object.freeze({ changeSetId: capability, source: changeSet.id }),
      });
      pendingChangeSets.set(capability, cached);
      return cached;
    },
    pendingChangeSets,
    pendingOnboardingReviews,
    staleAiProjectResult: () => ({ ok: false, error: 'PROJECT_CHANGED' }),
    projectFailure: error => ({
      ok: false,
      error: error?.code || 'UNEXPECTED',
      message: error?.message || 'unexpected',
    }),
  });
  return {
    handler,
    admission,
    capabilityStore,
    pendingOnboardingReviews,
    pendingChangeSets,
    advance(ms) { now += ms; },
    setGeneration(value) { mutationGeneration = value; },
    setRendererNavigationEpoch(value) { rendererNavigationEpoch = value; },
    setCurrentProject(value) { currentProject = value; },
  };
}

console.log('\nProject onboarding v2 production handler verification');

(async () => {
  await test('same-project concurrent proposals make one paid call and never share or release its lease', async () => {
    const first = deferred();
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        proposeProjectOnboardingV2() {
          calls += 1;
          return first.promise;
        },
      },
    });

    const requestA = subject.handler({}, PROJECT.instanceId, { answer: 'A' });
    const requestB = subject.handler({}, PROJECT.instanceId, { answer: 'B' });
    const rejectedB = await requestB;
    assert.deepStrictEqual(rejectedB, {
      ok: false,
      error: 'ONBOARDING_PROPOSAL_IN_PROGRESS',
      message: '项目卡正在生成中，请等待当前生成完成',
    });
    assert.strictEqual(calls, 1, 'the concurrent request must fail before paid model work');

    const requestC = await subject.handler({}, PROJECT.instanceId, { answer: 'C' });
    assert.strictEqual(requestC.error, 'ONBOARDING_PROPOSAL_IN_PROGRESS');
    assert.strictEqual(calls, 1, 'a rejected caller must not release the first caller lease');

    first.resolve(noOpProposal(1));
    const acceptedA = await requestA;
    assert.strictEqual(acceptedA.ok, true);
    assert.strictEqual(acceptedA.noChanges, true);
    assert.strictEqual(subject.capabilityStore.size, 1);
  });

  await test('a live authority blocks a later request before model work', async () => {
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          calls += 1;
          return noOpProposal(calls);
        },
      },
    });
    const first = await subject.handler({}, PROJECT.instanceId, { answer: 'first' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(calls, 1);

    const blocked = await subject.handler({}, PROJECT.instanceId, { answer: 'blocked' });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.error, 'ONBOARDING_REVIEW_PENDING');
    assert.strictEqual(calls, 1, 'a live authority must block before another paid model call');

    subject.capabilityStore.invalidate(first.onboardingConfirmation.token);
    const afterDiscard = await subject.handler({}, PROJECT.instanceId, { answer: 'after-discard' });
    assert.strictEqual(afterDiscard.ok, true);
    assert.strictEqual(calls, 2, 'success must release its generation lease');
  });

  await test('project invalidation revokes a no-op confirmation, preserves unrelated ChangeSets and permits retry', async () => {
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          calls += 1;
          return noOpProposal(calls);
        },
      },
    });
    const first = await subject.handler({}, PROJECT.instanceId, { answer: 'first' });
    const token = first.onboardingConfirmation.token;
    const unrelatedChangeSetId = `pc_${'f'.repeat(32)}`;
    subject.pendingChangeSets.set(unrelatedChangeSetId, Object.freeze({ kind: 'ordinary' }));

    subject.admission.invalidateProject(PROJECT);
    assert.strictEqual(subject.capabilityStore.hasActive(token, 'confirmation'), false);
    assert.strictEqual(subject.pendingOnboardingReviews.size, 0);
    assert.strictEqual(subject.pendingChangeSets.has(unrelatedChangeSetId), true);

    const retried = await subject.handler({}, PROJECT.instanceId, { answer: 'retry' });
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(calls, 2);
  });

  await test('project invalidation revokes a changed review and only its paired onboarding ChangeSet', async () => {
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          calls += 1;
          return changedProposal(calls);
        },
      },
    });
    const first = await subject.handler({}, PROJECT.instanceId, { answer: 'first' });
    const reviewId = subject.pendingOnboardingReviews.get(first.changeSetId).reviewId;
    const unrelatedChangeSetId = `pc_${'f'.repeat(32)}`;
    subject.pendingChangeSets.set(unrelatedChangeSetId, Object.freeze({ kind: 'ordinary' }));

    subject.admission.invalidateProject(PROJECT);
    assert.strictEqual(subject.capabilityStore.hasActive(reviewId, 'review'), false);
    assert.strictEqual(subject.pendingOnboardingReviews.has(first.changeSetId), false);
    assert.strictEqual(subject.pendingChangeSets.has(first.changeSetId), false);
    assert.strictEqual(subject.pendingChangeSets.has(unrelatedChangeSetId), true);

    const retried = await subject.handler({}, PROJECT.instanceId, { answer: 'retry' });
    assert.strictEqual(retried.ok, true);
    assert.notStrictEqual(retried.changeSetId, first.changeSetId);
    assert.strictEqual(calls, 2);
  });

  await test('a rejected service result releases the exact generation lease', async () => {
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          calls += 1;
          if (calls === 1) return { ok: false, error: 'MODEL_REJECTED', message: 'rejected' };
          return noOpProposal(calls);
        },
      },
    });

    const rejected = await subject.handler({}, PROJECT.instanceId, { answer: 'reject' });
    assert.deepStrictEqual(rejected, { ok: false, error: 'MODEL_REJECTED', message: 'rejected' });
    const retried = await subject.handler({}, PROJECT.instanceId, { answer: 'retry' });
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(calls, 2);
  });

  await test('a thrown service error releases the exact generation lease', async () => {
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('provider failed'), { code: 'PROVIDER_FAILED' });
          return noOpProposal(calls);
        },
      },
    });

    const failed = await subject.handler({}, PROJECT.instanceId, { answer: 'throw' });
    assert.deepStrictEqual(failed, {
      ok: false,
      error: 'PROVIDER_FAILED',
      message: 'provider failed',
    });
    const retried = await subject.handler({}, PROJECT.instanceId, { answer: 'retry' });
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(calls, 2);
  });

  await test('an expired confirmation is purged and no longer blocks a new proposal', async () => {
    let serial = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          serial += 1;
          return noOpProposal(serial);
        },
      },
    });
    const first = await subject.handler({}, PROJECT.instanceId, { answer: 'first' });
    assert.strictEqual(first.ok, true);
    const oldToken = first.onboardingConfirmation.token;
    subject.advance(DEFAULT_TTL_MS);

    const second = await subject.handler({}, PROJECT.instanceId, { answer: 'second' });
    assert.strictEqual(second.ok, true);
    assert.notStrictEqual(second.onboardingConfirmation.token, oldToken);
    assert.strictEqual(subject.capabilityStore.hasActive(oldToken, 'confirmation'), false);
    assert.strictEqual(subject.capabilityStore.size, 1);
  });

  await test('an expired review also removes its paired pending ChangeSet before readmission', async () => {
    let serial = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        async proposeProjectOnboardingV2() {
          serial += 1;
          return changedProposal(serial);
        },
      },
    });
    const first = await subject.handler({}, PROJECT.instanceId, { answer: 'first' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.noChanges, false);
    const oldChangeSetId = first.changeSetId;
    assert.strictEqual(subject.pendingOnboardingReviews.size, 1);
    assert.strictEqual(subject.pendingChangeSets.has(oldChangeSetId), true);

    subject.advance(DEFAULT_TTL_MS);
    const second = await subject.handler({}, PROJECT.instanceId, { answer: 'second' });
    assert.strictEqual(second.ok, true);
    assert.notStrictEqual(second.changeSetId, oldChangeSetId);
    assert.strictEqual(subject.pendingChangeSets.has(oldChangeSetId), false);
    assert.strictEqual(subject.pendingOnboardingReviews.has(oldChangeSetId), false);
    assert.strictEqual(subject.pendingOnboardingReviews.size, 1);
    assert.strictEqual(subject.capabilityStore.size, 1);
  });

  await test('an evicted ChangeSet invalidates its orphaned review before readmission', async () => {
    let serial = 0;
    const pendingChangeSets = createPendingChangeSetStore({
      maxEntries: 1,
      idFactory: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
    });
    const pendingOnboardingReviews = new Map();
    const capabilityStore = createOnboardingCapabilityStore({
      randomBytes: idFactory(),
    });
    const admission = createOnboardingAdmission({
      capabilityStore,
      pendingOnboardingReviews,
      pendingChangeSets,
    });
    const onboardingChangeSetId = pendingChangeSets.put(
      Object.freeze({ id: 'onboarding-change' }),
      PROJECT.rootPath
    );
    const reviewId = capabilityStore.createReview({
      projectInstanceId: PROJECT.instanceId,
      rootPath: PROJECT.rootPath,
      mutationGeneration: 7,
      baseEditRevision: BASE,
      expectedAppliedRevision: AFTER,
      proposalDigest: `sha256:${sha('evicted-review')}`,
      fileSuggestions: [],
      changeSetId: onboardingChangeSetId,
    });
    pendingOnboardingReviews.set(onboardingChangeSetId, Object.freeze({ reviewId }));

    const unrelatedChangeSetId = pendingChangeSets.put(
      Object.freeze({ id: 'unrelated-change' }),
      PROJECT.rootPath
    );
    assert.strictEqual(pendingChangeSets.has(onboardingChangeSetId), false);
    assert.strictEqual(capabilityStore.hasActive(reviewId, 'review'), true);

    admission.assertAvailable(PROJECT);
    assert.strictEqual(capabilityStore.hasActive(reviewId, 'review'), false);
    assert.strictEqual(pendingOnboardingReviews.has(onboardingChangeSetId), false);
    assert.strictEqual(pendingChangeSets.has(unrelatedChangeSetId), true);
  });

  await test('project or generation drift after model work mints no authority', async () => {
    for (const drift of ['project', 'generation']) {
      let calls = 0;
      let subject;
      subject = harness({
        projectOnboardingV2Service: {
          async proposeProjectOnboardingV2() {
            calls += 1;
            if (calls === 1) {
              if (drift === 'project') {
                subject.setCurrentProject({ instanceId: `instance_${'b'.repeat(24)}`, rootPath: '/other' });
              } else {
                subject.setGeneration(8);
              }
            }
            return noOpProposal(`${drift}-${calls}`);
          },
        },
      });
      const result = await subject.handler({}, PROJECT.instanceId, { answer: drift });
      assert.deepStrictEqual(result, {
        ok: false,
        error: 'PROJECT_CHANGED',
        message: '生成期间项目状态或页面会话已变化，请重新整理项目卡',
      });
      assert.strictEqual(subject.capabilityStore.size, 0);
      assert.strictEqual(subject.pendingOnboardingReviews.size, 0);
      assert.strictEqual(subject.pendingChangeSets.size, 0);

      subject.setCurrentProject(PROJECT);
      subject.setGeneration(7);
      const retried = await subject.handler({}, PROJECT.instanceId, { answer: `${drift}-retry` });
      assert.strictEqual(retried.ok, true, `${drift} drift must release its generation lease`);
      assert.strictEqual(calls, 2);
    }
  });

  await test('renderer navigation drift mints no authority, retains the old lease until settle and then permits retry', async () => {
    const first = deferred();
    let calls = 0;
    const subject = harness({
      projectOnboardingV2Service: {
        proposeProjectOnboardingV2() {
          calls += 1;
          return calls === 1 ? first.promise : Promise.resolve(noOpProposal(calls));
        },
      },
    });

    const running = subject.handler({}, PROJECT.instanceId, { answer: 'old-page' });
    subject.setRendererNavigationEpoch(4);
    const duringNavigation = await subject.handler({}, PROJECT.instanceId, { answer: 'new-page-too-early' });
    assert.strictEqual(duringNavigation.error, 'ONBOARDING_PROPOSAL_IN_PROGRESS');
    assert.strictEqual(calls, 1, 'a new page epoch must not bypass the old project lease');

    first.resolve(noOpProposal('old-page'));
    const stale = await running;
    assert.deepStrictEqual(stale, {
      ok: false,
      error: 'PROJECT_CHANGED',
      message: '生成期间项目状态或页面会话已变化，请重新整理项目卡',
    });
    assert.strictEqual(subject.capabilityStore.size, 0);
    assert.strictEqual(subject.pendingOnboardingReviews.size, 0);
    assert.strictEqual(subject.pendingChangeSets.size, 0);

    const retried = await subject.handler({}, PROJECT.instanceId, { answer: 'new-page' });
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(calls, 2, 'settling the old request must release its exact project lease');
  });

  console.log(`\n${passed}/${passed} project-onboarding handler checks passed.`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
