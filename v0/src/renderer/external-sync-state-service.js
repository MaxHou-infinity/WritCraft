'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftExternalSyncState = api;
})(typeof window !== 'undefined' ? window : globalThis, function createApi() {
  function createExternalSyncState() {
    let queue = Promise.resolve();
    let failure = null;
    let epoch = 0;

    function enqueue(task, onFailure) {
      const ownerEpoch = epoch;
      queue = queue.then(async () => {
        try {
          await task();
          if (epoch === ownerEpoch) failure = null;
        } catch (error) {
          if (epoch === ownerEpoch) {
            failure = new Error('项目文件同步失败，请重新打开项目');
            try { onFailure?.(error); } catch (_) {}
          }
        }
      });
      return queue;
    }

    async function drain() {
      await queue;
      if (failure) throw failure;
    }

    function reset() {
      epoch += 1;
      failure = null;
      queue = Promise.resolve();
    }

    return Object.freeze({
      enqueue,
      drain,
      reset,
      available: () => failure === null,
    });
  }

  return Object.freeze({ createExternalSyncState });
});
