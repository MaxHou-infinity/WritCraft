// WritCraft V0 · image-01 preview and explicit manuscript insertion.
(function () {
  const bridge = window.writCraft?.project;
  const toggle = document.getElementById('image-toggle');
  const compose = document.getElementById('image-compose');
  const prompt = document.getElementById('image-prompt');
  const aspect = document.getElementById('image-aspect');
  const generate = document.getElementById('image-generate');
  const resultHost = document.getElementById('image-result');
  let pending = null;
  let pendingMetric = null;
  let pendingOwner = null;
  let loading = false;
  let reviewBusy = false;
  let reviewSettlement = null;
  let requestSequence = 0;

  function sync() {
    if (generate) generate.disabled = loading || reviewBusy || !prompt?.value.trim() || !window.__workspace?.state?.project;
  }

  function clearResult() {
    pending = null;
    pendingMetric = null;
    pendingOwner = null;
    requestSequence += 1;
    resultHost?.replaceChildren();
    if (resultHost) resultHost.hidden = true;
  }

  async function recordImageMetric(outcome, metric = pendingMetric) {
    if (!metric?.operationId || !metric.originProjectInstanceId) return false;
    return Boolean(await window.WritCraftAiMetrics?.record?.(metric.originProjectInstanceId, {
      operationId: metric.operationId,
      action: 'image',
      outcome,
      style: 'none',
      scope: 'file',
      durationMs: Math.max(0, Date.now() - (['accepted', 'discarded'].includes(outcome) ? metric.readyAt : metric.startedAt)),
      beforeChars: 0,
      afterChars: 0,
    }));
  }

  async function discardPending() {
    const settlement = reviewSettlement;
    if (reviewBusy && settlement) await settlement;
    const owner = pendingOwner;
    if (!owner || !owner.image || !owner.metric) return false;
    if (pendingOwner !== owner) return false;
    const metric = owner.metric;
    pendingOwner = null;
    pending = null;
    pendingMetric = null;
    await recordImageMetric('discarded', metric);
    return true;
  }

  function renderState(text, error = false) {
    resultHost.hidden = false;
    resultHost.replaceChildren();
    const state = document.createElement('div');
    state.className = `image-state${error ? ' is-error' : ''}`;
    state.textContent = text;
    resultHost.appendChild(state);
  }

  function safePreviewDataUrl(value) {
    return typeof value === 'string' && /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';
  }

  function renderResult(result, metric) {
    const owner = Object.freeze({
      image: result.image,
      metric,
      altText: prompt.value.trim(),
    });
    pendingOwner = owner;
    pending = owner.image;
    pendingMetric = owner.metric;
    resultHost.hidden = false;
    resultHost.replaceChildren();
    const previewUrl = safePreviewDataUrl(result.image?.previewDataUrl);
    if (previewUrl) {
      const image = document.createElement('img');
      image.className = 'image-preview';
      image.alt = prompt.value.trim().slice(0, 160) || '生成配图预览';
      image.src = previewUrl;
      resultHost.appendChild(image);
    }
    const note = document.createElement('p');
    note.className = 'image-result-note';
    note.textContent = `已保存到项目 ${result.image?.filePath || 'assets/generated'}。尚未插入正文。`;
    const actions = document.createElement('div');
    actions.className = 'image-result-actions';
    const regenerate = document.createElement('button');
    regenerate.type = 'button';
    regenerate.textContent = '重新生成';
    regenerate.disabled = reviewBusy;
    regenerate.addEventListener('click', async () => {
      if (reviewBusy || pendingOwner !== owner) return;
      await run();
    });
    const abandon = document.createElement('button');
    abandon.type = 'button';
    abandon.textContent = '放弃插入';
    abandon.disabled = reviewBusy;
    abandon.addEventListener('click', async () => {
      if (reviewBusy || pendingOwner !== owner) return;
      await discardPending();
      renderState('已放弃插入。生成资产仍保留在项目中，正文没有修改。');
    });
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'is-primary';
    insert.textContent = '插入当前正文';
    insert.disabled = reviewBusy;
    insert.addEventListener('click', async () => {
      if (reviewBusy || pendingOwner !== owner) return;
      reviewBusy = true;
      regenerate.disabled = true;
      abandon.disabled = true;
      insert.disabled = true;
      sync();
      const settle = (async () => {
        const inserted = await window.__workspace?.insertGeneratedImage?.(owner.image, owner.altText);
        if (!inserted?.ok) {
          if (pendingOwner === owner) {
            renderState(inserted?.message || '配图引用插入失败，已生成资产保持不变。', true);
          }
          return false;
        }
        const currentProjectInstanceId = window.__workspace?.state?.project?.instanceId;
        if (pendingOwner !== owner || currentProjectInstanceId !== owner.metric.originProjectInstanceId) return false;
        await recordImageMetric('accepted', owner.metric);
        if (pendingOwner !== owner) return true;
        pendingOwner = null;
        pending = null;
        pendingMetric = null;
        renderState('已在当前光标位置插入 Markdown 配图引用。');
        return true;
      })();
      reviewSettlement = settle;
      try {
        await settle;
      } finally {
        if (reviewSettlement === settle) reviewSettlement = null;
        reviewBusy = false;
        if (pendingOwner === owner && resultHost.contains?.(actions)) {
          regenerate.disabled = false;
          abandon.disabled = false;
          insert.disabled = false;
        }
        sync();
      }
    });
    actions.append(regenerate, abandon, insert);
    resultHost.append(note, actions);
  }

  async function run() {
    if (loading || reviewBusy || !bridge?.generateImage) return;
    const value = prompt?.value.trim() || '';
    if (!value || !window.__workspace?.state?.project) return;
    await discardPending();
    if (reviewBusy || !window.__workspace?.state?.project) return;
    const requestId = ++requestSequence;
    const projectInstanceId = window.__workspace.state.project.instanceId;
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: projectInstanceId,
      startedAt: Date.now(),
      readyAt: null,
    };
    loading = true;
    sync();
    renderState('正在生成配图…完成前不会改写正文。');
    let result;
    try { result = await bridge.generateImage(projectInstanceId, value, aspect?.value || '16:9'); }
    catch (error) { result = { ok: false, message: error.message }; }
    if (requestId !== requestSequence || projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    loading = false;
    sync();
    if (!result?.ok || !result.image) {
      await recordImageMetric('failed', metric);
      renderState(result?.message || result?.error || '配图生成失败，项目正文没有被修改。', true);
      return;
    }
    metric.readyAt = Date.now();
    await recordImageMetric('generated', metric);
    renderResult(result, metric);
  }

  toggle?.addEventListener('click', () => {
    const open = compose.hidden;
    compose.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) prompt.focus();
    sync();
  });
  prompt?.addEventListener('input', sync);
  generate?.addEventListener('click', run);
  document.addEventListener('writcraft:project-entered', () => {
    const reset = async () => {
      if (reviewBusy && reviewSettlement) await reviewSettlement;
      loading = false;
      clearResult();
      sync();
    };
    void reset();
  });
  window.__imageGenerationView = Object.freeze({ discardPending });
})();
