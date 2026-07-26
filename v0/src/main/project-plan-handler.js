'use strict';

function createProposePlanHandler(options = {}) {
  const {
    assertTrustedSender,
    requireCurrentProject,
    getCurrentProject,
    getMutationGeneration,
    projectPlanService,
    projectService,
    projectCallLLM,
    pendingPlanRecords,
    staleAiProjectResult,
    projectFailure,
  } = options;

  return async function proposePlanHandler(event, projectInstanceId, goal, contextPaths = []) {
    try {
      assertTrustedSender(event);
      const project = requireCurrentProject();
      if (projectInstanceId !== project.instanceId) return staleAiProjectResult();
      const mutationGeneration = getMutationGeneration();
      const result = await projectPlanService.proposeProjectPlan({
        projectService,
        rootPath: project.rootPath,
        goal,
        contextPaths,
        callLLM: projectCallLLM(project.instanceId),
      });
      if (!result.ok) return result;
      const currentProject = getCurrentProject();
      if (!currentProject || currentProject.rootPath !== project.rootPath ||
          getMutationGeneration() !== mutationGeneration) {
        return { ok: false, error: 'PROJECT_CHANGED', message: '生成计划期间项目文件已变化，请重新生成' };
      }
      const { handoffRecord, ...publicResult } = result;
      pendingPlanRecords.put({
        ...handoffRecord,
        projectInstanceId: project.instanceId,
        rootPath: project.rootPath,
        mutationGeneration,
      });
      return publicResult;
    } catch (error) {
      return projectFailure(error);
    }
  };
}

module.exports = { createProposePlanHandler };
