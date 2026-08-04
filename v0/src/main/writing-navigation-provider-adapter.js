'use strict';

function createWritingNavigationProviderAdapter(options = {}) {
  const { runAiRequest, callLLM } = options;
  if (typeof runAiRequest !== 'function' || typeof callLLM !== 'function') {
    throw new TypeError('Writing Navigation provider adapter dependencies are required');
  }
  return function writingNavigationProjectCallLLM(projectInstanceId) {
    return (messages, model, maxTokens, requestOptions = {}) => {
      const {
        signal: externalSignal,
        deadlineMs: _deadlineMs,
        taskHandle,
        kind,
        targetLocator,
        inputRevision,
        ownerToken,
        attemptId,
        completionStatus,
        startPhase,
        postModelPhase,
        ...providerOptions
      } = requestOptions;
      const effectiveStartPhase = startPhase || 'checking_evidence';
      const effectivePostModelPhase = postModelPhase || 'validating_result';
      return runAiRequest(
        projectInstanceId,
        signal => callLLM(messages, model, maxTokens, signal, providerOptions),
        externalSignal,
        {
          taskHandle,
          kind,
          targetLocator,
          inputRevision,
          ownerToken,
          attemptId,
          completionStatus,
          startPhase: effectiveStartPhase,
          postModelPhase: effectivePostModelPhase,
        }
      );
    };
  };
}

module.exports = Object.freeze({ createWritingNavigationProviderAdapter });
