'use strict';

function createProjectWatcherHealth() {
  let degraded = null;
  const binding = project => project && typeof project.instanceId === 'string' && typeof project.rootPath === 'string'
    ? `${project.instanceId}\0${project.rootPath}`
    : null;
  return Object.freeze({
    markDegraded(project) {
      const value = binding(project);
      if (value) degraded = value;
    },
    clear(project) {
      const value = binding(project);
      if (value && degraded === value) degraded = null;
    },
    reset() { degraded = null; },
    isDegraded(project) {
      const value = binding(project);
      return Boolean(value && degraded === value);
    },
    needsRecovery(project, watcherAvailable) {
      const value = binding(project);
      return Boolean(value && (degraded === value || watcherAvailable !== true));
    },
    assertAvailable(project, errorFactory) {
      const value = binding(project);
      if (value && degraded === value) {
        throw typeof errorFactory === 'function' ? errorFactory() : new Error('PROJECT_WATCHER_UNAVAILABLE');
      }
      return project;
    },
  });
}

module.exports = { createProjectWatcherHealth };
