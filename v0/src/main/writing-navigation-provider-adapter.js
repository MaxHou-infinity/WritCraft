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
        ...providerOptions
      } = requestOptions;
      return runAiRequest(
        projectInstanceId,
        signal => callLLM(messages, model, maxTokens, signal, providerOptions),
        externalSignal
      );
    };
  };
}

module.exports = Object.freeze({ createWritingNavigationProviderAdapter });
