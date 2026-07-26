'use strict';

const {
  OnboardingCapabilityError,
} = require('./onboarding-capability-store');

function createOnboardingAdmission(options = {}) {
  const {
    capabilityStore,
    pendingOnboardingReviews,
    pendingChangeSets,
  } = options;

  function pruneExpired() {
    capabilityStore.purgeExpired();
    for (const [changeSetId, record] of pendingOnboardingReviews) {
      if (!pendingChangeSets.has(changeSetId)) {
        capabilityStore.invalidate(record.reviewId);
        pendingOnboardingReviews.delete(changeSetId);
        continue;
      }
      if (capabilityStore.hasActive(record.reviewId, 'review')) continue;
      pendingOnboardingReviews.delete(changeSetId);
      pendingChangeSets.delete(changeSetId);
    }
  }

  function assertAvailable(project) {
    pruneExpired();
    const active = capabilityStore.activeCountsByProject(project.instanceId, project.rootPath);
    if (!active.review && !active.confirmation) return;
    throw new OnboardingCapabilityError(
      'ONBOARDING_REVIEW_PENDING',
      active.confirmation
        ? '已有项目卡初始文件等待确认，请先确认或放弃当前创建'
        : '已有项目卡修改等待审阅，请先应用或放弃当前修改'
    );
  }

  function invalidateProject(project) {
    capabilityStore.invalidateByProject(project.instanceId, project.rootPath);
    for (const [changeSetId, record] of pendingOnboardingReviews) {
      if (record.projectInstanceId !== project.instanceId || record.rootPath !== project.rootPath) continue;
      pendingOnboardingReviews.delete(changeSetId);
      pendingChangeSets.delete(changeSetId);
    }
  }

  return Object.freeze({ pruneExpired, assertAvailable, invalidateProject });
}

function createProposeOnboardingHandler(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    getRendererNavigationEpoch,
    assertOnboardingFlowAvailable,
    projectOnboardingV2Service,
    projectService,
    projectCallLLM,
    onboardingCapabilityStore,
    cacheReviewedChangeSet,
    pendingChangeSets,
    pendingOnboardingReviews,
    staleAiProjectResult,
    projectFailure,
  } = options;
  const proposalLeases = new Map();

  function proposalLeaseKey(project) {
    return JSON.stringify([project.instanceId, project.rootPath]);
  }

  function acquireProposalLease(project) {
    const key = proposalLeaseKey(project);
    if (proposalLeases.has(key)) {
      throw new OnboardingCapabilityError(
        'ONBOARDING_PROPOSAL_IN_PROGRESS',
        '项目卡正在生成中，请等待当前生成完成'
      );
    }
    const lease = Object.freeze({ key });
    proposalLeases.set(key, lease);
    return lease;
  }

  function releaseProposalLease(lease) {
    if (proposalLeases.get(lease.key) === lease) {
      proposalLeases.delete(lease.key);
    }
  }

  return async function proposeOnboardingHandler(event, projectInstanceId, request) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const rendererNavigationEpoch = getRendererNavigationEpoch();
      assertOnboardingFlowAvailable(project);
      const proposalLease = acquireProposalLease(project);
      try {
        const mutationGeneration = getMutationGeneration();
        const proposal = await projectOnboardingV2Service.proposeProjectOnboardingV2({
          projectService,
          rootPath: project.rootPath,
          request,
          callLLM: projectCallLLM(project.instanceId),
        });
        if (!proposal.ok) return proposal;
        const currentProject = getCurrentProject();
        if (!currentProject || currentProject.instanceId !== project.instanceId ||
            currentProject.rootPath !== project.rootPath ||
            getMutationGeneration() !== mutationGeneration ||
            getRendererNavigationEpoch() !== rendererNavigationEpoch) {
          return {
            ok: false,
            error: 'PROJECT_CHANGED',
            message: '生成期间项目状态或页面会话已变化，请重新整理项目卡',
          };
        }
        // Preserve the live-authority gate independently from the in-flight lease.
        assertOnboardingFlowAvailable(project);

        if (proposal.noChanges) {
          const token = onboardingCapabilityStore.createNoOp({
            projectInstanceId: project.instanceId,
            rootPath: project.rootPath,
            mutationGeneration,
            baseEditRevision: proposal.contextManifest.targetRevision,
            expectedAppliedRevision: proposal.contextManifest.targetAfterRevision,
            proposalDigest: proposal.proposalDigest,
            fileSuggestions: proposal.fileSuggestions,
          });
          return {
            ok: true,
            proposalKind: 'onboarding_v2',
            noChanges: true,
            changeSetId: null,
            review: null,
            fileCount: 0,
            fileSuggestions: proposal.fileSuggestions,
            contextManifest: proposal.contextManifest,
            onboardingConfirmation: {
              token,
              proposalDigest: proposal.proposalDigest,
              fileSuggestions: proposal.fileSuggestions,
              source: 'no_op',
            },
          };
        }

        const cached = cacheReviewedChangeSet(proposal.changeSet, project, { selectionPolicy: 'file' });
        let reviewId;
        try {
          reviewId = onboardingCapabilityStore.createReview({
            projectInstanceId: project.instanceId,
            rootPath: project.rootPath,
            mutationGeneration,
            baseEditRevision: proposal.contextManifest.targetRevision,
            expectedAppliedRevision: proposal.contextManifest.targetAfterRevision,
            proposalDigest: proposal.proposalDigest,
            fileSuggestions: proposal.fileSuggestions,
            changeSetId: cached.capability,
          });
        } catch (error) {
          pendingChangeSets.delete(cached.capability);
          throw error;
        }
        pendingOnboardingReviews.set(cached.capability, Object.freeze({
          reviewId,
          projectInstanceId: project.instanceId,
          rootPath: project.rootPath,
          mutationGeneration,
          expectedAppliedRevision: proposal.contextManifest.targetAfterRevision,
          proposalDigest: proposal.proposalDigest,
          fileSuggestions: proposal.fileSuggestions,
          createdAt: Date.now(),
        }));
        return {
          ok: true,
          proposalKind: 'onboarding_v2',
          noChanges: false,
          changeSetId: cached.capability,
          review: cached.review,
          fileCount: 1,
          fileSuggestions: proposal.fileSuggestions,
          contextManifest: proposal.contextManifest,
          proposalDigest: proposal.proposalDigest,
        };
      } finally {
        releaseProposalLease(proposalLease);
      }
    } catch (error) {
      return projectFailure(error);
    }
  };
}

module.exports = {
  createOnboardingAdmission,
  createProposeOnboardingHandler,
};
