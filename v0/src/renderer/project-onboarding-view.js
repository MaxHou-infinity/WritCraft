(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritCraftProjectOnboarding = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const REQUEST_SCHEMA = 'writcraft.onboarding-request/v2';
  // Must remain byte-for-byte aligned with Main's exported
  // project-onboarding-v2-service STRUCTURED_OUTPUT_ERROR_CODES contract.
  const STRUCTURED_OUTPUT_ERROR_CODES = Object.freeze([
    'INVALID_MODEL_OUTPUT',
    'MODEL_OUTPUT_TRUNCATED',
    'MODEL_OUTPUT_INCOMPLETE',
    'MODEL_OUTPUT_TOO_LARGE',
    'INVALID_FILE_SUGGESTIONS',
    'INVALID_SUGGESTION_PATH',
    'DUPLICATE_SUGGESTION_PATH',
    'RESERVED_SUGGESTION_PATH',
    'SUGGESTION_PATH_CONFLICT',
    'GENERATED_CONTENT_TOO_LARGE',
  ]);
  const STRUCTURED_OUTPUT_ERROR_SET = new Set(STRUCTURED_OUTPUT_ERROR_CODES);

  const QUESTIONS = Object.freeze([
    { id: 'premise', label: '内容主旨', prompt: '这项写作最想让读者记住或相信什么？', hint: '先写一句最重要的话，不必完整。' },
    { id: 'audience', label: '目标读者', prompt: '你在为谁写？他们已经知道什么、最关心什么？', hint: '可以描述一个具体的人，而不是泛泛的人群。' },
    { id: 'objective', label: '内容目标', prompt: '读完之后，希望读者理解、感受或采取什么行动？', hint: '写清读者发生的变化。' },
    { id: 'scope', label: '范围与边界', prompt: '必须覆盖什么，又明确不写什么？', hint: '边界能帮助 AI 少走弯路。' },
    { id: 'structure', label: '大概结构', prompt: '你预想用哪些章节、场景或论证步骤展开？', hint: '草图即可，之后仍可调整。' },
    { id: 'voice', label: '语气与规则', prompt: '作品的语气、视角、术语和格式有哪些约束？', hint: '例如：克制、第一人称、不使用网络流行语。' },
    { id: 'invariants', label: '关键不变量', prompt: '哪些人物、事实、定义或立场绝不能前后冲突？', hint: '这些内容会进入后续一致性检查。' },
    { id: 'timeline', label: '关系与时间', prompt: '关键人物、变量、事件之间有哪些关系和时间顺序？', hint: '不确定的地方也可以明确标成开放问题。' },
    { id: 'sources', label: '来源规则', prompt: '哪些结论必须有来源，允许使用哪些证据？', hint: '例如：关键数字必须能回到原始报告。' },
    { id: 'openQuestions', label: '开放问题', prompt: '目前还有哪些需要在写作中继续探索的问题？', hint: '保留未知，比让 AI 猜答案更可靠。' },
  ]);

  function element(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mount(host, options = {}) {
    const document = host?.ownerDocument;
    const stateApi = options.stateApi || root.WritCraftOnboardingState;
    if (!document || !stateApi) throw new Error('项目建立视图缺少 DOM 或状态模块');
    let session = stateApi.createSession(options.session || {});
    let busy = false;
    let feedback = '';
    let generationFailed = false;
    let generationFailureCode = '';
    let generationStartedAt = 0;
    let progressTimer = null;
    let destroyed = false;
    const focusBeforeOpen = document.activeElement;
    const inerted = [];

    host.classList.add('project-onboarding');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-labelledby', 'onboarding-dialog-title');
    host.tabIndex = -1;

    function makeBackgroundInert() {
      let branch = host;
      while (branch?.parentElement) {
        const parent = branch.parentElement;
        for (const sibling of parent.children) {
          if (sibling === branch) continue;
          inerted.push({
            node: sibling,
            inert: sibling.hasAttribute('inert'),
            ariaHidden: sibling.getAttribute('aria-hidden'),
          });
          sibling.setAttribute('inert', '');
          sibling.setAttribute('aria-hidden', 'true');
        }
        branch = parent;
        if (parent === document.body) break;
      }
    }

    function restoreBackground() {
      for (const item of inerted.splice(0)) {
        if (!item.inert) item.node.removeAttribute('inert');
        if (item.ariaHidden === null) item.node.removeAttribute('aria-hidden');
        else item.node.setAttribute('aria-hidden', item.ariaHidden);
      }
    }

    makeBackgroundInert();

    function cancel() {
      if (busy) return;
      options.onCancel?.(stateApi.createSession(session));
    }

    function onKeydown(event) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...host.querySelectorAll(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) {
        event.preventDefault();
        host.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const outsideSequence = !focusable.includes(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outsideSequence)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outsideSequence)) {
        event.preventDefault();
        first.focus();
      }
    }
    host.addEventListener('keydown', onKeydown);

    function announce(text) {
      feedback = text || '';
      const live = host.querySelector('.onboarding-live');
      if (live) live.textContent = feedback;
    }

    function recoverableGenerationMessage(failure) {
      const code = failure?.error || failure?.code || '';
      if (['RESERVED_SUGGESTION_PATH', 'INVALID_SUGGESTION_PATH',
        'DUPLICATE_SUGGESTION_PATH', 'SUGGESTION_PATH_CONFLICT'].includes(code)) {
        return 'AI 的新文件建议包含不适合创建的位置，因此笔触已停止，本次没有修改任何项目文件。你在本页填写的内容仍保留；点击“重新整理 edit.md”即可再试。';
      }
      if (STRUCTURED_OUTPUT_ERROR_SET.has(code)) {
        return 'AI 返回的整理结果不完整，因此笔触已停止，本次没有修改任何项目文件。你在本页填写的内容仍保留；点击“重新整理 edit.md”即可再试。';
      }
      if (code === 'ONBOARDING_DEPENDENCY_STALE') {
        return '整理期间项目内容发生了变化。为避免覆盖你的新内容，笔触已停止且没有修改文件；请检查项目后重新整理。';
      }
      if (code === 'NO_KEY') {
        return '这次没有调用 AI：当前 App 尚未配置 MiniMax Key。点击“打开设置”保存并检测 Key；重新打开项目卡后，你在本页填写的内容仍会保留。项目文件没有变化。';
      }
      return 'AI 暂时没有完成整理，本次没有修改任何项目文件。你在本页填写的内容仍保留，可以稍后重新整理。';
    }

    function generationElapsedSeconds() {
      return Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1000));
    }

    function generationProgressText() {
      return `AI 正在整理与安全检查 · 已等待 ${generationElapsedSeconds()} 秒`;
    }

    function refreshGenerationProgress() {
      if (!busy || destroyed) return;
      const elapsed = host.querySelector('.onboarding-progress-time');
      if (elapsed) elapsed.textContent = `已等待 ${generationElapsedSeconds()} 秒`;
      const live = host.querySelector('.onboarding-live');
      if (live) live.textContent = generationProgressText();
    }

    function stopGenerationProgress() {
      if (progressTimer !== null) {
        root.clearInterval(progressTimer);
        progressTimer = null;
      }
    }

    function startGenerationProgress() {
      stopGenerationProgress();
      generationStartedAt = Date.now();
      feedback = generationProgressText();
      progressTimer = root.setInterval(refreshGenerationProgress, 1000);
    }

    function renderGenerationProgress(body) {
      const progress = element(document, 'div', 'onboarding-progress');
      progress.setAttribute('role', 'status');
      progress.setAttribute('aria-label', '项目说明整理进度');
      const heading = element(document, 'div', 'onboarding-progress-heading');
      heading.append(
        element(document, 'span', 'onboarding-progress-pulse'),
        element(document, 'strong', '', 'AI 正在整理项目说明'),
        element(document, 'span', 'onboarding-progress-time', `已等待 ${generationElapsedSeconds()} 秒`)
      );
      const steps = element(document, 'ol', 'onboarding-progress-steps');
      [
        ['complete', '项目卡已提交'],
        ['active', '整理内容并检查建议'],
        ['pending', '进入修改预览'],
      ].forEach(([status, label]) => {
        const item = element(document, 'li', '', label);
        item.dataset.state = status;
        steps.appendChild(item);
      });
      progress.append(
        heading,
        steps,
        element(document, 'p', 'onboarding-progress-note', '笔触仍在工作，请勿重复提交。你填写的内容已经保留。')
      );
      body.appendChild(progress);
    }

    function recordOnboardingMetric(outcome, attempt) {
      if (!attempt?.operationId || !attempt.originProjectInstanceId) return;
      void root.WritCraftAiMetrics?.record?.(attempt.originProjectInstanceId, {
        operationId: attempt.operationId,
        action: 'onboarding',
        outcome,
        style: 'none',
        scope: 'project',
        durationMs: Math.max(0, Date.now() - attempt.startedAt),
        beforeChars: 0,
        afterChars: 0,
      });
    }

    function onboardingFailureOutcome(error) {
      return STRUCTURED_OUTPUT_ERROR_SET.has(error?.error || error?.code) ? 'structured_failed' : 'failed';
    }

    function button(label, className, action, disabled = false) {
      const node = element(document, 'button', className, label);
      node.type = 'button';
      node.disabled = disabled;
      node.addEventListener('click', action);
      return node;
    }

    function renderRail(container) {
      const rail = element(document, 'div', 'onboarding-rail');
      rail.setAttribute('aria-label', '项目卡进度');
      QUESTIONS.forEach((question, index) => {
        const marker = button(String(index + 1), 'onboarding-marker', () => {
          feedback = '';
          session = stateApi.editQuestion(session, question.id);
          render();
        }, busy);
        marker.title = question.label;
        marker.setAttribute('aria-label', `${index + 1}. ${question.label}`);
        if (session.answers[question.id]) marker.dataset.state = 'answered';
        else if (session.skipped.includes(question.id)) marker.dataset.state = 'skipped';
        if (session.status === 'questions' && session.currentIndex === index) marker.setAttribute('aria-current', 'step');
        rail.appendChild(marker);
      });
      container.appendChild(rail);
    }

    function renderQuestion(body) {
      const question = QUESTIONS[session.currentIndex];
      const eyebrow = element(document, 'div', 'onboarding-eyebrow', `项目卡 ${session.currentIndex + 1} / ${QUESTIONS.length} · ${question.label}`);
      const title = element(document, 'h2', 'onboarding-question', question.prompt);
      title.id = 'onboarding-dialog-title';
      const hint = element(document, 'p', 'onboarding-hint', question.hint);
      const textarea = element(document, 'textarea', 'onboarding-answer');
      textarea.value = session.answers[question.id] || '';
      textarea.maxLength = stateApi.MAX_ANSWER_CHARS;
      textarea.rows = 7;
      textarea.placeholder = '写下你的想法…';
      textarea.setAttribute('aria-labelledby', title.id);
      textarea.addEventListener('input', () => {
        session = stateApi.updateAnswer(session, question.id, textarea.value);
        announce(`已记录 ${textarea.value.trim().length} 个字符`);
      });
      body.append(eyebrow, title, hint, textarea);

      const actions = element(document, 'div', 'onboarding-actions');
      if (session.currentIndex > 0) actions.appendChild(button('返回', 'onboarding-button onboarding-button-quiet', () => {
        feedback = '';
        session = stateApi.goBack(session);
        render();
      }));
      actions.appendChild(button('暂时跳过', 'onboarding-button onboarding-button-quiet', () => {
        feedback = '';
        session = stateApi.skip(session, question.id);
        render();
      }));
      actions.appendChild(button(session.currentIndex === QUESTIONS.length - 1 ? '检查项目卡' : '继续', 'onboarding-button onboarding-button-primary', () => {
        try {
          feedback = '';
          session = stateApi.advance(stateApi.updateAnswer(session, question.id, textarea.value));
          render();
        } catch (error) {
          textarea.focus();
          announce(error.message);
        }
      }));
      body.appendChild(actions);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
        if (!destroyed) textarea.focus();
      });
    }

    function renderReview(body) {
      const title = element(document, 'h2', 'onboarding-question', '让 AI 先整理项目说明，不直接动笔。');
      title.id = 'onboarding-dialog-title';
      body.append(
        element(document, 'div', 'onboarding-eyebrow', '项目卡 · 提交前检查'),
        title,
        element(document, 'p', 'onboarding-hint', '下一步只会生成 edit.md Diff 和初始文件建议。你可以逐项接受、拒绝或返回修改。')
      );
      const list = element(document, 'div', 'onboarding-review-list');
      for (const question of QUESTIONS) {
        const item = element(document, 'button', 'onboarding-review-item');
        item.type = 'button';
        item.disabled = busy;
        item.addEventListener('click', () => {
          feedback = '';
          session = stateApi.editQuestion(session, question.id);
          render();
        });
        const label = element(document, 'span', 'onboarding-review-label', question.label);
        const answer = element(document, 'span', 'onboarding-review-answer', session.answers[question.id] || '已跳过');
        if (!session.answers[question.id]) item.dataset.state = 'skipped';
        item.append(label, answer);
        list.appendChild(item);
      }
      body.appendChild(list);
      if (busy) renderGenerationProgress(body);
      const actions = element(document, 'div', 'onboarding-actions');
      actions.appendChild(button('返回补充', 'onboarding-button onboarding-button-quiet', () => {
        feedback = '';
        session = stateApi.goBack(session);
        render();
      }, busy));
      const generateLabel = busy
        ? 'AI 整理中'
        : generationFailureCode === 'NO_KEY' ? '打开设置'
        : generationFailed ? '重新整理 edit.md' : '生成 edit.md 提案';
      actions.appendChild(button(generateLabel, 'onboarding-button onboarding-button-primary', async () => {
        if (busy) return;
        if (generationFailureCode === 'NO_KEY' && typeof options.onOpenSettings === 'function') {
          options.onOpenSettings(stateApi.createSession(session));
          return;
        }
        const attempt = {
          operationId: root.WritCraftAiMetrics?.createOperationId?.(),
          originProjectInstanceId: root.__workspace?.state?.project?.instanceId || null,
          startedAt: Date.now(),
          retry: generationFailed,
        };
        if (attempt.retry) recordOnboardingMetric('retried', attempt);
        try {
          const submitted = stateApi.submission(session);
          const request = Object.freeze({
            schema: REQUEST_SCHEMA,
            answers: Object.freeze(QUESTIONS
              .filter(question => typeof submitted[question.id] === 'string' && submitted[question.id].trim())
              .map(question => Object.freeze({ id: question.id, text: submitted[question.id].trim() }))),
          });
          if (!request.answers.length) throw new Error('至少回答一个项目建立问题');
          busy = true;
          startGenerationProgress();
          render();
          const result = await options.onGenerate?.(request, stateApi.createSession(session), Object.freeze({ ...attempt }));
          if (destroyed) return;
          stopGenerationProgress();
          busy = false;
          generationFailed = result?.ok === false;
          generationFailureCode = generationFailed ? (result?.error || result?.code || '') : '';
          recordOnboardingMetric(generationFailed ? onboardingFailureOutcome(result) : 'generated', attempt);
          announce(generationFailed
            ? recoverableGenerationMessage(result)
            : '项目提案已进入 Changes，请检查后再应用');
          if (!generationFailed) options.onComplete?.(result);
          if (!destroyed) render();
        } catch (error) {
          if (destroyed) return;
          stopGenerationProgress();
          busy = false;
          generationFailed = true;
          generationFailureCode = error?.error || error?.code || '';
          recordOnboardingMetric(onboardingFailureOutcome(error), attempt);
          announce(recoverableGenerationMessage(error));
          render();
        }
      }, busy));
      body.appendChild(actions);
    }

    function render() {
      if (destroyed) return;
      host.replaceChildren();
      const shell = element(document, 'section', 'onboarding-shell');
      renderRail(shell);
      const body = element(document, 'div', 'onboarding-body');
      const close = button('×', 'onboarding-close', cancel, busy);
      close.setAttribute('aria-label', '关闭项目卡');
      close.title = '稍后继续';
      body.appendChild(close);
      if (session.status === 'review') renderReview(body);
      else renderQuestion(body);
      const live = element(document, 'p', 'onboarding-live');
      live.textContent = feedback;
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      body.appendChild(live);
      shell.appendChild(body);
      host.appendChild(shell);
      if (busy && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
        if (!destroyed) host.focus();
      });
      options.onSessionChange?.(stateApi.createSession(session));
    }

    render();
    if (session.status === 'review' && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!destroyed) host.focus();
      });
    }
    return {
      getSession: () => stateApi.createSession(session),
      setSession(next) { session = stateApi.createSession(next); render(); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopGenerationProgress();
        host.removeEventListener('keydown', onKeydown);
        host.replaceChildren();
        host.classList.remove('project-onboarding');
        host.removeAttribute('role');
        host.removeAttribute('aria-modal');
        host.removeAttribute('aria-labelledby');
        host.removeAttribute('tabindex');
        restoreBackground();
        if (focusBeforeOpen?.isConnected && typeof focusBeforeOpen.focus === 'function') focusBeforeOpen.focus();
      },
    };
  }

  return { REQUEST_SCHEMA, STRUCTURED_OUTPUT_ERROR_CODES, QUESTIONS, mount };
});
