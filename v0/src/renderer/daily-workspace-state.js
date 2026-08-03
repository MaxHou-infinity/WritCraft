'use strict';

// Pure interaction state for Outline and Quick Open. Keeping request ownership
// outside the DOM prevents a late result from an old file/project replacing the
// current author's navigation choices.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftDailyWorkspaceState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const KINDS = Object.freeze(['file', 'heading', 'entity', 'issue', 'pending_review']);

  function create() {
    return {
      projectInstanceId: null,
      currentPath: '',
      generation: 0,
      querySequence: 0,
      open: false,
      composing: false,
      status: 'closed',
      items: [],
      selectedIndex: -1,
    };
  }

  function bind(state, projectInstanceId, currentPath = '') {
    state.projectInstanceId = projectInstanceId || null;
    state.currentPath = currentPath || '';
    state.generation += 1;
    state.querySequence += 1;
    state.open = false;
    state.composing = false;
    state.status = 'closed';
    state.items = [];
    state.selectedIndex = -1;
    return state.generation;
  }

  function begin(state, status = 'querying') {
    state.status = status;
    const requestId = `${state.generation}:${++state.querySequence}`;
    return Object.freeze({ projectInstanceId: state.projectInstanceId, generation: state.generation, requestId });
  }

  function current(state, owner) {
    return Boolean(owner && owner.projectInstanceId && owner.projectInstanceId === state.projectInstanceId &&
      owner.generation === state.generation && owner.requestId === `${state.generation}:${state.querySequence}`);
  }

  function settle(state, owner, response) {
    if (!current(state, owner)) return false;
    state.items = Array.isArray(response?.items) ? response.items.slice(0, 100) : [];
    state.status = response?.status === 'partial' ? 'partial' : state.items.length ? 'ready' : 'empty';
    state.selectedIndex = state.items.length ? 0 : -1;
    return true;
  }

  function fail(state, owner) {
    if (!current(state, owner)) return false;
    state.status = 'error';
    state.items = [];
    state.selectedIndex = -1;
    return true;
  }

  function move(state, direction) {
    if (!state.items.length) return -1;
    if (direction === 'home') state.selectedIndex = 0;
    else if (direction === 'end') state.selectedIndex = state.items.length - 1;
    else state.selectedIndex = (state.selectedIndex + direction + state.items.length) % state.items.length;
    return state.selectedIndex;
  }

  return Object.freeze({ KINDS, create, bind, begin, current, settle, fail, move });
});
