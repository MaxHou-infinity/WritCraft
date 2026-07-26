(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftFileLifecycleState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function uniquePaths(paths) {
    return [...new Set((Array.isArray(paths) ? paths : []).filter(path => typeof path === 'string' && path))];
  }

  function preview(state, path) {
    let tabs = uniquePaths(state.tabs || []);
    let previewPath = typeof state.previewPath === 'string' ? state.previewPath : null;
    if (tabs.includes(path)) return { tabs, previewPath };
    const replaceIndex = previewPath ? tabs.indexOf(previewPath) : -1;
    if (replaceIndex >= 0) tabs[replaceIndex] = path;
    else tabs.push(path);
    tabs = uniquePaths(tabs);
    previewPath = path;
    return { tabs, previewPath };
  }

  function pin(state, path) {
    const tabs = uniquePaths([...(state.tabs || []), path]);
    return {
      tabs,
      previewPath: state.previewPath === path ? null : state.previewPath || null,
    };
  }

  function relocate(state, sourcePath, targetPath) {
    const tabs = uniquePaths((state.tabs || []).map(path => path === sourcePath ? targetPath : path));
    const views = { ...(state.views || {}) };
    if (Object.prototype.hasOwnProperty.call(views, sourcePath)) {
      views[targetPath] = views[sourcePath];
      delete views[sourcePath];
    }
    return {
      tabs,
      views,
      currentPath: state.currentPath === sourcePath ? targetPath : state.currentPath,
      previewPath: state.previewPath === sourcePath ? targetPath : state.previewPath || null,
    };
  }

  function trash(state, sourcePath, promptPath = 'edit.md') {
    const oldTabs = uniquePaths(state.tabs || []);
    const removedIndex = oldTabs.indexOf(sourcePath);
    const tabs = oldTabs.filter(path => path !== sourcePath);
    const views = { ...(state.views || {}) };
    delete views[sourcePath];
    const wasCurrent = state.currentPath === sourcePath;
    let currentPath = state.currentPath;
    if (wasCurrent) {
      currentPath = tabs[Math.min(Math.max(removedIndex, 0), tabs.length - 1)] || promptPath;
      if (!tabs.includes(currentPath)) tabs.push(currentPath);
    }
    return {
      tabs,
      views,
      currentPath,
      wasCurrent,
      previewPath: state.previewPath === sourcePath ? null : state.previewPath || null,
    };
  }

  return Object.freeze({ preview, pin, relocate, trash });
});
