'use strict';

class InlineRewriteMutationGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InlineRewriteMutationGuardError';
    this.code = 'INLINE_REWRITE_RECOVERY_PENDING';
  }
}

class ChangesHistoryMutationGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangesHistoryMutationGuardError';
    this.code = 'CHANGES_RECOVERY_PENDING';
  }
}

function createInlineRewriteMutationGuard(options = {}) {
  if (typeof options.readMarker !== 'function') throw new TypeError('readMarker is required');
  const readChangesMarker = options.readChangesMarker;
  if (readChangesMarker !== undefined && typeof readChangesMarker !== 'function') {
    throw new TypeError('readChangesMarker must be a function');
  }

  function assertAvailable(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath) {
      throw new InlineRewriteMutationGuardError('Inline Rewrite 提交状态待恢复；请重开项目完成核对');
    }
    let marker;
    try { marker = options.readMarker(rootPath); }
    catch (_) {
      throw new InlineRewriteMutationGuardError('Inline Rewrite 提交状态待恢复；请重开项目完成核对');
    }
    if (marker) {
      throw new InlineRewriteMutationGuardError('Inline Rewrite 提交状态待恢复；请先完成恢复核对');
    }
    if (readChangesMarker) {
      let changesMarker;
      try { changesMarker = readChangesMarker(rootPath); }
      catch (_) {
        throw new ChangesHistoryMutationGuardError('Changes 提交状态无法核对；请先完成恢复');
      }
      if (changesMarker) {
        throw new ChangesHistoryMutationGuardError('Changes 提交状态待恢复；请先完成恢复核对');
      }
    }
    return true;
  }

  return Object.freeze({ assertAvailable });
}

module.exports = {
  InlineRewriteMutationGuardError,
  ChangesHistoryMutationGuardError,
  createInlineRewriteMutationGuard,
};
