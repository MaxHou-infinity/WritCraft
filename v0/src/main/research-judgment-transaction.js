'use strict';

// Synchronous coordinator for the one operation that must atomically bridge a
// live Research capability and hidden metrics persistence. Every callback is
// Main-owned; Renderer data is normalized before this boundary.

function required(options, name) {
  if (typeof options?.[name] !== 'function') throw new TypeError(`${name} callback required`);
  return options[name];
}

function recordResearchJudgmentTransaction(options) {
  const hasActiveMutation = required(options, 'hasActiveMutation');
  const busyError = required(options, 'busyError');
  const advanceGeneration = required(options, 'advanceGeneration');
  const getGeneration = required(options, 'getGeneration');
  const beginLease = required(options, 'beginLease');
  const resolveAuthority = required(options, 'resolveAuthority');
  const pauseWatcher = required(options, 'pauseWatcher');
  const restartWatcher = required(options, 'restartWatcher');
  const fingerprint = required(options, 'fingerprint');
  const changedError = required(options, 'changedError');
  const recordMetric = required(options, 'recordMetric');
  const finishLease = required(options, 'finishLease');
  const abortLease = required(options, 'abortLease');
  const publishInvalidation = required(options, 'publishInvalidation');

  let lease = null;
  let watcherPaused = false;
  let fingerprintBefore = null;
  let transactionGeneration = null;
  let metricsCommitted = false;
  let failure = null;
  let postcheckFailed = false;

  try {
    if (hasActiveMutation()) throw busyError();
    // Invalid, foreign or non-READY cards must have zero global side effects.
    // Acquire and resolve the exact owner-bound card before fencing the window.
    lease = beginLease();
    resolveAuthority();
    advanceGeneration();
    const generationBeforePause = getGeneration();
    try { pauseWatcher(); }
    finally { watcherPaused = true; }
    if (getGeneration() !== generationBeforePause) throw changedError('delayed_watcher_event');
    transactionGeneration = getGeneration();
    fingerprintBefore = fingerprint();
    recordMetric(() => {
      if (getGeneration() !== transactionGeneration) throw changedError('generation_changed');
      if (fingerprint() !== fingerprintBefore) throw changedError('public_context_changed');
      resolveAuthority();
    });
    metricsCommitted = true;
  } catch (error) {
    failure = error;
  } finally {
    // Restart precedes every post-commit read. A one-shot native start failure
    // is retried; a persistent failure remains locked and is reported honestly.
    if (watcherPaused) {
      try { restartWatcher(); }
      catch (firstRestartError) {
        try { restartWatcher(); }
        catch (_) { failure ||= firstRestartError; postcheckFailed = true; }
      }
    }
    if (!failure && fingerprintBefore !== null) {
      try {
        if (fingerprint() !== fingerprintBefore) throw changedError('postcommit_context_changed');
        resolveAuthority();
      } catch (error) {
        failure = error;
        postcheckFailed = true;
      }
    }
    if (!failure && lease) {
      try {
        finishLease(lease, transactionGeneration);
        lease = null;
      } catch (error) {
        failure = error;
        postcheckFailed = true;
      }
    }
    if (lease) {
      try { abortLease(lease); } catch (_) {}
    }
    if (postcheckFailed) {
      try { publishInvalidation(); } catch (_) {}
    }
  }

  if (metricsCommitted && failure) {
    const watcherUnavailable = failure?.code === 'PROJECT_WATCHER_UNAVAILABLE';
    return Object.freeze({
      ok: true,
      recorded: true,
      handoffAvailable: false,
      evidenceChanged: true,
      message: watcherUnavailable
        ? '作者判断已记录，但项目文件监控恢复失败；请重新打开项目后再继续'
        : '作者判断已记录，但证据或项目监控随后变化；请重新 Research 后再带入修改',
    });
  }
  if (failure) throw failure;
  return Object.freeze({ ok: true, recorded: true, handoffAvailable: true, evidenceChanged: false });
}

module.exports = { recordResearchJudgmentTransaction };
