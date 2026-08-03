'use strict';

// Research-only apply boundary. Before applyDecision succeeds, failures keep
// their ordinary error semantics. After disk/history commit, every remaining
// operation is bookkeeping: it may require refresh, but must never invite the
// Renderer to replay an already-consumed decision.

function refreshedResidualMetadata(pending, applied = [], residualChangeSet = null, residualCapability = null) {
  const revisions = new Map(applied.map(file => [file.path, file.revision]));
  const provenance = pending.provenance ? JSON.parse(JSON.stringify(pending.provenance)) : null;
  if (provenance?.targets && !pending.researchDependencies) {
    provenance.targets = provenance.targets.map(target => ({
      ...target,
      revision: revisions.get(target.path) || target.revision,
    }));
  }
  return {
    projectDependencies: pending.projectDependencies
      ? pending.projectDependencies.map(item => ({ ...item, revision: revisions.get(item.path) || item.revision }))
      : null,
    issueDependencies: pending.issueDependencies,
    researchDependencies: pending.researchDependencies
      ? {
        ...pending.researchDependencies,
        targets: pending.researchDependencies.targets.map(item => ({
          ...item,
          revision: revisions.get(item.path) || item.revision,
        })),
        issuedCapability: residualChangeSet
          ? residualCapability
          : pending.researchDependencies.issuedCapability,
      }
      : null,
    requireCompleteDecision: pending.requireCompleteDecision,
    provenance,
    selectionPolicy: pending.selectionPolicy,
    fileSelectionPolicies: Object.fromEntries(
      Object.entries(pending.fileSelectionPolicies || {}).filter(([filePath]) =>
        !residualChangeSet || residualChangeSet.changes.some(change => change.path === filePath)
      )
    ),
  };
}

function failureCode(error) {
  return error?.code === 'RESEARCH_HANDOFF_STALE'
    ? 'RESEARCH_HANDOFF_STALE'
    : 'RESEARCH_HANDOFF_FAILED';
}

function createResearchApplyTransaction(options) {
  const {
    changeSetReviewService,
    researchHandoffService,
    researchHandoffStore,
    pendingChangeSets,
    projectService,
    sourceIndex,
    rememberApplied,
    invalidateDerivedState,
    executeDecision,
  } = options || {};
  if (!changeSetReviewService || !researchHandoffService || !researchHandoffStore ||
      !pendingChangeSets || !projectService || typeof sourceIndex !== 'function' ||
      typeof rememberApplied !== 'function' || typeof invalidateDerivedState !== 'function' ||
      (executeDecision !== undefined && typeof executeDecision !== 'function')) {
    throw new TypeError('Research apply transaction dependencies are incomplete');
  }

  function settleFailure(apply, residualCapability, error) {
    try {
      researchHandoffStore.settleCommittedApplyFailure(
        apply.cardId,
        apply.leaseId,
        failureCode(error),
        residualCapability
      );
    } catch (_) {}
  }

  function committedWarning({
    project,
    changeSetId,
    apply,
    residualCapability,
    publicResult,
    applied,
    error,
  }) {
    try { pendingChangeSets.delete(changeSetId, 'research-committed'); } catch (_) {}
    if (residualCapability) {
      try { pendingChangeSets.delete(residualCapability, 'research-residual-rollback'); } catch (_) {}
    }
    settleFailure(apply, residualCapability, error);
    let treeResult = {};
    if (applied.length) {
      try { treeResult = { tree: projectService.listTree(project.rootPath) }; }
      catch (treeError) {
        treeResult = {
          treeRefreshRequired: true,
          treeError: treeError?.code || 'TREE_REFRESH_FAILED',
        };
      }
    }
    return {
      ...publicResult,
      ok: true,
      review: null,
      changeSetId: null,
      residualUnavailable: true,
      refreshRequired: true,
      ...treeResult,
    };
  }

  function apply({ project, pending, changeSetId, decision }) {
    const decisionOptions = {
      reviewId: changeSetId,
      selectionPolicy: pending.selectionPolicy,
      fileSelectionPolicies: pending.fileSelectionPolicies,
      requireCompleteDecision: pending.requireCompleteDecision,
    };
    // Validate before beginApply so malformed Renderer input cannot burn a
    // valid single-use Research child.
    changeSetReviewService.validateDecision(pending.changeSet, decision, decisionOptions);
    const applyLease = {
      cardId: pending.researchDependencies.cardId,
      ...researchHandoffStore.beginApply({
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        cardId: pending.researchDependencies.cardId,
        capability: changeSetId,
      }),
    };
    let committed = false;
    try {
      researchHandoffService.validateResearchDependencies({
        store: researchHandoffStore,
        projectService,
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        sourceIndex: () => sourceIndex(project.rootPath),
        dependencies: applyLease.dependencies,
      });
      const residualReviewId = pendingChangeSets.allocateCapability();
      const onBegin = () => researchHandoffStore.commitApplyBegin(
        applyLease.cardId,
        applyLease.leaseId
      );
      const result = executeDecision
        ? executeDecision({
          project,
          pending,
          changeSetId,
          decision,
          decisionOptions,
          residualReviewId,
          onBegin,
        })
        : (() => {
          onBegin();
          return changeSetReviewService.applyDecision(
            projectService,
            project.rootPath,
            pending.changeSet,
            decision,
            {
              ...decisionOptions,
              residualReviewId,
              provenance: pending.provenance,
            }
          );
        })();
      if (!result.ok) {
        const code = ['conflict', 'preflight_failed'].includes(result.status)
          ? 'RESEARCH_HANDOFF_STALE'
          : 'RESEARCH_HANDOFF_FAILED';
        researchHandoffStore.failApply(applyLease.cardId, applyLease.leaseId, code);
        return result;
      }

      committed = true;
      if (result.responseRecovered || result.recoveryRequired ||
          result.status === 'committed_warning') {
        const { residualChangeSet: _private, ...publicResult } = result;
        return committedWarning({
          project,
          changeSetId,
          apply: applyLease,
          residualCapability: null,
          publicResult,
          applied: result.applied || [],
          error: Object.assign(new Error('Changes/History recovery required'), {
            code: result.recoveryRequired
              ? 'CHANGES_MANUAL_RECOVERY_REQUIRED'
              : 'CHANGES_RESPONSE_RECOVERED',
          }),
        });
      }
      let residualChangeSet = null;
      let publicResult = null;
      let applied = [];
      try {
        ({ residualChangeSet, ...publicResult } = result);
        applied = result.applied || [];
        let bookkeepingError = null;
        for (const file of applied) {
          try { rememberApplied(file); }
          catch (error) { bookkeepingError ||= error; }
        }
        if (applied.length) {
          try { invalidateDerivedState(changeSetId); }
          catch (error) { bookkeepingError ||= error; }
        } else {
          try { pendingChangeSets.delete(changeSetId, 'research-committed'); }
          catch (error) { bookkeepingError ||= error; }
        }
        if (bookkeepingError) throw bookkeepingError;

        const residualMetadata = refreshedResidualMetadata(
          pending,
          applied,
          residualChangeSet,
          residualChangeSet ? residualReviewId : null
        );
        if (residualChangeSet) {
          const appliedRevisions = applied.map(({ path: filePath, revision }) => ({
            path: filePath,
            revision,
          }));
          const researchDependencies = researchHandoffService.buildResearchResidualDependencies({
            dependencies: applyLease.dependencies,
            residualCapability: residualReviewId,
            applied: appliedRevisions,
          });
          researchHandoffService.validateResearchResidualDependencies({
            store: researchHandoffStore,
            projectService,
            projectInstanceId: project.instanceId,
            rootPath: project.rootPath,
            sourceIndex: () => sourceIndex(project.rootPath),
            cardId: applyLease.cardId,
            applyLeaseId: applyLease.leaseId,
            previousDependencies: applyLease.dependencies,
            residualDependencies: researchDependencies,
            applied: appliedRevisions,
          });
          pendingChangeSets.putWithCapability(
            residualReviewId,
            residualChangeSet,
            project.rootPath,
            { ...residualMetadata, researchDependencies }
          );
          const tree = applied.length ? projectService.listTree(project.rootPath) : null;
          researchHandoffStore.finishApply(applyLease.cardId, applyLease.leaseId, {
            residualCapability: residualReviewId,
            researchDependencies,
          });
          pendingChangeSets.delete(changeSetId, 'research-committed');
          return {
            ...publicResult,
            changeSetId: result.review?.changeSetId || null,
            ...(residualMetadata.provenance ? { provenance: residualMetadata.provenance } : {}),
            ...(tree ? { tree } : {}),
          };
        }

        const tree = applied.length ? projectService.listTree(project.rootPath) : null;
        researchHandoffStore.finishApply(applyLease.cardId, applyLease.leaseId);
        pendingChangeSets.delete(changeSetId, 'research-committed');
        return {
          ...publicResult,
          changeSetId: null,
          ...(tree ? { tree } : {}),
        };
      } catch (error) {
        return committedWarning({
          project,
          changeSetId,
          apply: applyLease,
          residualCapability: residualChangeSet ? residualReviewId : null,
          publicResult,
          applied,
          error,
        });
      }
    } catch (error) {
      // Every operation after an ok result, including reading its public
      // fields, belongs to the committed-warning boundary above.
      if (committed) {
        return committedWarning({
          project,
          changeSetId,
          apply: applyLease,
          residualCapability: null,
          publicResult: null,
          applied: [],
          error,
        });
      }
      try {
        researchHandoffStore.failApply(
          applyLease.cardId,
          applyLease.leaseId,
          failureCode(error)
        );
      } catch (_) {}
      throw error;
    }
  }

  return Object.freeze({ apply });
}

module.exports = {
  refreshedResidualMetadata,
  createResearchApplyTransaction,
};
