// WritCraft V0 · image-01 preview, author review and explicit settlement.
(function () {
  'use strict';

  const bridge = window.writCraft?.project;
  const toggle = document.getElementById('image-toggle');
  const compose = document.getElementById('image-compose');
  const prompt = document.getElementById('image-prompt');
  const aspect = document.getElementById('image-aspect');
  const generate = document.getElementById('image-generate');
  const resultHost = document.getElementById('image-result');
  const reviewSummary = document.getElementById('image-review-summary');
  const trashToggle = document.getElementById('image-trash-toggle');
  const trashPanel = document.getElementById('image-trash-panel');
  const trashStatus = document.getElementById('image-trash-status');
  const trashList = document.getElementById('image-trash-list');
  const trashRefresh = document.getElementById('image-trash-refresh');
  const trashEmpty = document.getElementById('image-trash-empty');
  let pendingOwner = null;
  let loading = false;
  let reviewBusy = false;
  let reviewSettlement = null;
  let requestSequence = 0;
  let aggregateSequence = 0;
  let trashSequence = 0;
  let trashBusy = false;
  let trashOwner = null;

  function hasExactKeys(value, expected) {
    const keys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
    return keys.length === expected.length &&
      expected.every((key, index) => keys[index] === key);
  }

  function safeTrashResult(result) {
    const value = result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : null;
    if (!value || !hasExactKeys(value, [
      'items', 'ok', 'policy', 'schema', 'snapshotToken', 'totalBytes', 'totalCount',
    ]) || value.ok !== true || value.schema !== 'writcraft.image-trash/v1' ||
        value.policy !== 'manual_until_restore_or_empty' ||
        !Number.isSafeInteger(value.totalCount) || value.totalCount < 0 ||
        !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 ||
        !Array.isArray(value.items) || value.items.length > 50 ||
        (value.snapshotToken !== null &&
          (typeof value.snapshotToken !== 'string' ||
            !/^its_[a-f0-9]{48}$/.test(value.snapshotToken)))) {
      return null;
    }
    const items = [];
    for (const item of value.items) {
      if (!item || !hasExactKeys(item, ['createdAt', 'sizeBytes', 'token']) ||
          typeof item.token !== 'string' || !/^iti_[a-f0-9]{48}$/.test(item.token) ||
          typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt)) ||
          !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1) {
        return null;
      }
      items.push(Object.freeze({
        token: item.token,
        createdAt: item.createdAt,
        sizeBytes: item.sizeBytes,
      }));
    }
    if ((value.totalCount === 0) !== (value.snapshotToken === null) ||
        value.totalCount < items.length) return null;
    return Object.freeze({
      totalCount: value.totalCount,
      totalBytes: value.totalBytes,
      items: Object.freeze(items),
      snapshotToken: value.snapshotToken,
    });
  }

  function formatTrashBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function trashMessage(text, error = false) {
    if (!trashStatus) return;
    trashStatus.textContent = text;
    trashStatus.className = `image-trash-status${error ? ' is-error' : ''}`;
  }

  function resetTrash() {
    trashSequence += 1;
    trashBusy = false;
    trashOwner = null;
    trashList?.replaceChildren();
    if (trashToggle) trashToggle.textContent = '图片废纸篓 · 0';
    if (trashEmpty) trashEmpty.disabled = true;
    trashMessage('长期保留，不会自动删除；只有恢复或清空才会改变废纸篓。');
  }

  function renderTrash(owner) {
    if (!trashList || !trashToggle || !trashEmpty) return;
    trashList.replaceChildren();
    trashToggle.textContent = `图片废纸篓 · ${owner.totalCount}`;
    trashEmpty.disabled = trashBusy || !owner.snapshotToken;
    trashMessage(owner.totalCount
      ? `共 ${owner.totalCount} 张，${formatTrashBytes(owner.totalBytes)}。长期保留，不会自动删除。`
      : '废纸篓为空。图片长期保留，除非你明确恢复或清空。');
    for (const [index, item] of owner.items.entries()) {
      const row = document.createElement('div');
      row.className = 'image-trash-item';
      const detail = document.createElement('span');
      const created = new Date(item.createdAt);
      detail.textContent =
        `图片 ${index + 1} · ${formatTrashBytes(item.sizeBytes)} · ${created.toLocaleString('zh-CN')}`;
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = '恢复到素材区';
      restore.disabled = trashBusy;
      restore.addEventListener('click', () => restoreTrashItem(owner, item));
      row.append(detail, restore);
      trashList.appendChild(row);
    }
    if (owner.totalCount > owner.items.length) {
      const more = document.createElement('p');
      more.className = 'image-trash-status';
      more.textContent = `另有 ${owner.totalCount - owner.items.length} 张未展开；清空会以当前核验快照为准。`;
      trashList.appendChild(more);
    }
  }

  async function refreshTrash() {
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    if (!projectInstanceId || !bridge?.getImageTrash || trashBusy) {
      if (!projectInstanceId) resetTrash();
      return false;
    }
    const sequence = ++trashSequence;
    trashMessage('正在核验图片废纸篓…');
    let result;
    try {
      result = await bridge.getImageTrash(projectInstanceId);
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (sequence !== trashSequence ||
        projectInstanceId !== window.__workspace?.state?.project?.instanceId) return false;
    const safe = safeTrashResult(result);
    if (!safe) {
      trashOwner = null;
      trashList?.replaceChildren();
      if (trashEmpty) trashEmpty.disabled = true;
      trashMessage(result?.message || '图片废纸篓读取失败；未改变任何文件。', true);
      return false;
    }
    trashOwner = Object.freeze({ projectInstanceId, ...safe });
    renderTrash(trashOwner);
    return true;
  }

  async function restoreTrashItem(owner, item) {
    if (trashBusy || trashOwner !== owner || !bridge?.restoreImageTrash) return false;
    trashBusy = true;
    renderTrash(owner);
    trashMessage('正在把这张图片恢复到项目素材区…');
    let result;
    try {
      result = await bridge.restoreImageTrash(owner.projectInstanceId, item.token);
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (trashOwner !== owner ||
        owner.projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      trashBusy = false;
      return false;
    }
    trashBusy = false;
    if (!result?.ok) {
      renderTrash(owner);
      trashMessage(result?.message || '图片恢复失败；废纸篓内容保持不变。', true);
      return false;
    }
    const safePath = typeof result.assetPath === 'string' &&
      /^assets\/generated\/image-[a-f0-9]{64}\.(?:png|jpg)$/.test(result.assetPath)
      ? result.assetPath
      : '项目素材区';
    trashMessage(`已恢复到 ${safePath}；正文没有修改。`);
    return refreshTrash();
  }

  async function emptyTrash() {
    const owner = trashOwner;
    if (trashBusy || !owner?.snapshotToken || !bridge?.emptyImageTrash) return false;
    const confirmed = window.confirm?.(
      `永久清空当前核验的 ${owner.totalCount} 张图片？\n\n该操作无法撤销；清空期间新进入的图片不会被删除。`
    );
    if (!confirmed) return false;
    trashBusy = true;
    renderTrash(owner);
    trashMessage('正在永久清空当前核验快照…');
    let result;
    try {
      result = await bridge.emptyImageTrash(owner.projectInstanceId, owner.snapshotToken);
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (trashOwner !== owner ||
        owner.projectInstanceId !== window.__workspace?.state?.project?.instanceId) {
      trashBusy = false;
      return false;
    }
    trashBusy = false;
    if (!result?.ok) {
      renderTrash(owner);
      trashMessage(result?.message || '清空尚未完成；请保持项目不变后重试。', true);
      return false;
    }
    trashMessage(`已永久清空 ${Number.isSafeInteger(result.emptiedCount) ? result.emptiedCount : 0} 张；正在刷新。`);
    return refreshTrash();
  }

  async function refreshReviewSummary() {
    const projectInstanceId = window.__workspace?.state?.project?.instanceId;
    if (!reviewSummary || !projectInstanceId || !bridge?.getImageReviewAggregate) return;
    const sequence = ++aggregateSequence;
    let result;
    try {
      result = await bridge.getImageReviewAggregate(projectInstanceId);
    } catch (_) {
      return;
    }
    if (sequence !== aggregateSequence ||
        projectInstanceId !== window.__workspace?.state?.project?.instanceId ||
        !result?.ok || !result.aggregate) return;
    const aggregate = result.aggregate;
    const total = Number.isSafeInteger(aggregate.sampleSize) ? aggregate.sampleSize : 0;
    if (!total) {
      reviewSummary.textContent = '本项目尚无图片评审记录';
      return;
    }
    const average = Number.isFinite(aggregate.averageQualityRating)
      ? `均分 ${aggregate.averageQualityRating.toFixed(1)}`
      : '暂无评分';
    const decisions = aggregate.decisions || {};
    reviewSummary.textContent =
      `本项目 ${total} 次评审 · ${average} · 插入 ${decisions.inserted || 0} / ` +
      `保留 ${decisions.kept || 0} / 废纸篓 ${decisions.deleted || 0}`;
  }

  function sync() {
    if (generate) {
      generate.disabled = loading || reviewBusy || Boolean(pendingOwner) ||
        !prompt?.value.trim() || !window.__workspace?.state?.project;
    }
  }

  function clearResult() {
    pendingOwner = null;
    requestSequence += 1;
    resultHost?.replaceChildren();
    if (resultHost) resultHost.hidden = true;
    sync();
  }

  async function recordImageMetric(outcome, owner) {
    const metric = owner?.metric;
    if (!metric?.operationId || !metric.originProjectInstanceId) return false;
    return Boolean(await window.WritCraftAiMetrics?.record?.(metric.originProjectInstanceId, {
      operationId: metric.operationId,
      action: 'image',
      outcome,
      style: 'none',
      scope: 'file',
      durationMs: Math.max(0, Date.now() -
        (['accepted', 'discarded'].includes(outcome) ? metric.readyAt : metric.startedAt)),
      beforeChars: 0,
      afterChars: 0,
    }));
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
    return typeof value === 'string' &&
      /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)
      ? value
      : '';
  }

  function reviewPayload(owner, decision, controls) {
    const qualityRating = Number(controls.rating.value);
    if (!Number.isSafeInteger(qualityRating) || qualityRating < 1 || qualityRating > 5) {
      controls.hint.textContent = '请先给这张图片打 1–5 分。';
      controls.rating.focus();
      return null;
    }
    const payload = {
      token: owner.review.token,
      decision,
      qualityRating,
    };
    const costText = controls.cost.value.trim();
    if (costText) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(costText)) {
        controls.hint.textContent = '费用应为不小于 0 的金额，最多保留两位小数。';
        controls.cost.focus();
        return null;
      }
      const cost = Number(costText);
      const costMinorUnits = Math.round(cost * 100);
      if (!Number.isFinite(cost) || cost < 0 ||
          !Number.isSafeInteger(costMinorUnits) || costMinorUnits > 100_000_000) {
        controls.hint.textContent = '费用应为不小于 0 的金额，最多保留两位小数。';
        controls.cost.focus();
        return null;
      }
      payload.costMinorUnits = costMinorUnits;
      payload.currency = controls.currency.value;
    }
    controls.hint.textContent = '只记录评分、决定与可选费用；不记录图片描述或正文。';
    return payload;
  }

  async function settleOwner(owner, decision, controls, insertionProof = null) {
    if (pendingOwner !== owner || reviewBusy || !bridge?.settleImageReview) return false;
    const payload = reviewPayload(owner, decision, controls);
    if (!payload) return false;
    reviewBusy = true;
    controls.buttons.forEach(button => { button.disabled = true; });
    sync();
    const settle = (async () => {
      let result;
      try {
        result = await bridge.settleImageReview(
          owner.metric.originProjectInstanceId,
          payload,
          insertionProof
        );
      } catch (error) {
        result = { ok: false, message: error.message };
      }
      if (pendingOwner !== owner) return false;
      if (!result?.ok) {
        controls.hint.textContent = result?.message ||
          '图片决定尚未安全结算，请保持当前项目并重试。';
        return false;
      }
      await refreshReviewSummary();
      await recordImageMetric(decision === 'inserted' ? 'accepted' : 'discarded', owner);
      if (pendingOwner !== owner) return true;
      pendingOwner = null;
      if (decision === 'inserted') {
        renderState('已插入正文，并记录本次图片判断。');
      } else if (decision === 'kept') {
        renderState('已保留为项目素材，正文没有修改。');
      } else {
        renderState('已移入图片废纸篓，正文没有修改。可在本面板中恢复。');
        void refreshTrash();
      }
      return true;
    })();
    reviewSettlement = settle;
    try {
      return await settle;
    } finally {
      if (reviewSettlement === settle) reviewSettlement = null;
      reviewBusy = false;
      if (pendingOwner === owner) {
        controls.buttons.forEach(button => { button.disabled = false; });
      }
      sync();
    }
  }

  function reviewControls(owner) {
    const review = document.createElement('div');
    review.className = 'image-review';

    const label = document.createElement('label');
    label.className = 'image-review-label';
    label.textContent = '你的判断';
    const rating = document.createElement('select');
    rating.className = 'image-rating';
    rating.setAttribute('aria-label', '图片质量评分');
    for (const [value, text] of [
      ['', '质量评分…'],
      ['1', '1 · 不可用'],
      ['2', '2 · 较差'],
      ['3', '3 · 可用'],
      ['4', '4 · 良好'],
      ['5', '5 · 出色'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      rating.appendChild(option);
    }

    const cost = document.createElement('input');
    cost.className = 'image-cost';
    cost.type = 'number';
    cost.min = '0';
    cost.step = '0.01';
    cost.inputMode = 'decimal';
    cost.placeholder = '本次费用（可选）';
    cost.setAttribute('aria-label', '人工核对的本次图片费用');
    const currency = document.createElement('select');
    currency.className = 'image-currency';
    currency.setAttribute('aria-label', '费用币种');
    for (const value of ['CNY', 'USD']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      currency.appendChild(option);
    }

    const fields = document.createElement('div');
    fields.className = 'image-review-fields';
    fields.append(rating, cost, currency);
    const hint = document.createElement('p');
    hint.className = 'image-review-hint';
    hint.textContent = '只记录评分、决定与可选费用；不记录图片描述或正文。';
    review.append(label, fields, hint);

    const actions = document.createElement('div');
    actions.className = 'image-result-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移入废纸篓';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = '保留素材';
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'is-primary';
    insert.textContent = '插入当前正文';
    const controls = {
      rating,
      cost,
      currency,
      hint,
      buttons: [remove, keep, insert],
    };
    remove.addEventListener('click', () => settleOwner(owner, 'deleted', controls));
    keep.addEventListener('click', () => settleOwner(owner, 'kept', controls));
    insert.addEventListener('click', async () => {
      if (pendingOwner !== owner || reviewBusy) return;
      if (!reviewPayload(owner, 'inserted', controls)) return;
      if (!owner.insertionProof) {
        const inserted = await window.__workspace?.insertGeneratedImage?.(
          owner.image
        );
        if (!inserted?.ok) {
          controls.hint.textContent = inserted?.message ||
            '配图引用插入失败，生成资产保持不变。';
          return;
        }
        owner.insertionProof = Object.freeze({
          targetPath: inserted.targetPath,
          revision: inserted.revision,
        });
      }
      await settleOwner(owner, 'inserted', controls, owner.insertionProof);
    });
    actions.append(remove, keep, insert);
    return { review, actions };
  }

  function renderResult(result, metric) {
    const owner = {
      image: result.image,
      review: result.review,
      metric,
      altText: prompt.value.trim(),
      insertionProof: null,
    };
    pendingOwner = owner;
    resultHost.hidden = false;
    resultHost.replaceChildren();
    const previewUrl = safePreviewDataUrl(owner.image?.previewDataUrl);
    if (previewUrl) {
      const image = document.createElement('img');
      image.className = 'image-preview';
      image.alt = owner.altText.slice(0, 160) || '生成配图预览';
      image.src = previewUrl;
      resultHost.appendChild(image);
    }
    const proof = document.createElement('div');
    proof.className = 'image-proof';
    const dimensions = Number.isSafeInteger(owner.image?.width) &&
      Number.isSafeInteger(owner.image?.height)
      ? `${owner.image.width}×${owner.image.height}`
      : '尺寸待核验';
    proof.textContent = `${dimensions} · ${owner.image?.requestedAspectRatio || '比例待核验'} · 已解码`;
    const note = document.createElement('p');
    note.className = 'image-result-note';
    note.textContent = '图片已进入项目素材区，尚未插入正文。请选择评分和最终动作。';
    resultHost.append(proof, note);
    const controls = reviewControls(owner);
    resultHost.append(controls.review, controls.actions);
    sync();
  }

  async function discardPending() {
    if (reviewBusy && reviewSettlement) await reviewSettlement;
    return !pendingOwner;
  }

  async function run() {
    if (loading || reviewBusy || pendingOwner || !bridge?.generateImage) return;
    const value = prompt?.value.trim() || '';
    if (!value || !window.__workspace?.state?.project) return;
    const requestId = ++requestSequence;
    const projectInstanceId = window.__workspace.state.project.instanceId;
    const metric = {
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: projectInstanceId,
      startedAt: Date.now(),
      readyAt: null,
    };
    if (!metric.operationId) {
      renderState('无法创建本次图片审阅，请重新打开项目后再试。', true);
      return;
    }
    loading = true;
    sync();
    renderState('正在生成配图…完成前不会改写正文。');
    let result;
    try {
      result = await bridge.generateImage(
        projectInstanceId,
        metric.operationId,
        value,
        aspect?.value || '16:9'
      );
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    if (requestId !== requestSequence ||
        projectInstanceId !== window.__workspace?.state?.project?.instanceId) return;
    loading = false;
    sync();
    if (!result?.ok || !result.image || !result.review?.token) {
      await recordImageMetric('failed', { metric });
      renderState(result?.message ||
        '配图生成或审阅签发失败，正文没有被修改。', true);
      return;
    }
    metric.readyAt = Date.now();
    await recordImageMetric('generated', { metric });
    renderResult(result, metric);
  }

  toggle?.addEventListener('click', () => {
    const open = compose.hidden;
    compose.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) prompt.focus();
    if (open) void refreshReviewSummary();
    sync();
  });
  trashToggle?.addEventListener('click', () => {
    const open = Boolean(trashPanel?.hidden);
    if (trashPanel) trashPanel.hidden = !open;
    trashToggle.setAttribute('aria-expanded', String(open));
    if (open) void refreshTrash();
  });
  trashRefresh?.addEventListener('click', () => { void refreshTrash(); });
  trashEmpty?.addEventListener('click', () => { void emptyTrash(); });
  prompt?.addEventListener('input', sync);
  generate?.addEventListener('click', run);
  document.addEventListener('writcraft:project-entered', () => {
    aggregateSequence += 1;
    loading = false;
    if (!pendingOwner) clearResult();
    void refreshReviewSummary();
    resetTrash();
    if (trashPanel && !trashPanel.hidden) void refreshTrash();
    sync();
  });
  window.__imageGenerationView = Object.freeze({ discardPending, refreshTrash });
})();
