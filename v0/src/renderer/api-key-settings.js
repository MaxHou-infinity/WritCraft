// WritCraft · AI Key 设置
// 打开设置只读取本机配置状态；联网检测必须由用户点击，或在保存成功后执行一次。

(function () {
  'use strict';

  const openButton = document.getElementById('activity-settings');
  const dialog = document.getElementById('api-key-dialog');
  const statusLine = document.getElementById('api-key-status-line');
  const input = document.getElementById('api-key-input');
  const saveButton = document.getElementById('api-key-save');
  const checkButton = document.getElementById('api-key-check');
  const clearButton = document.getElementById('api-key-clear');
  const closeButton = document.getElementById('api-key-close');
  const feedback = document.getElementById('api-key-feedback');
  const connection = document.getElementById('api-key-connection');
  const connectionStatus = document.getElementById('api-key-connection-status');
  const connectionDetail = document.getElementById('api-key-connection-detail');
  if (!openButton || !dialog) return;

  const KEY_TYPE_LABEL = {
    CODING_PLAN: 'Coding Plan Key（sk-cp-）',
    FULL: '完整 API Key（sk-api-）',
  };

  const FAILURE_COPY = {
    NO_KEY: '先保存一个 sk-api- 或 sk-cp- 开头的 MiniMax Key，再重新检测。',
    AUTH_FAILED: 'MiniMax 拒绝了这个 Key。请确认 Key 未失效、未复制多余空格，然后重新保存。',
    RATE_LIMITED: '请求过于频繁或额度受限。请检查 MiniMax 套餐状态，稍后再试。',
    SERVICE_UNAVAILABLE: 'MiniMax 服务当前不可用。请稍后重新检测。',
    API_FAILED: 'MiniMax 未接受本次检测。请检查 Key 权限与账户状态。',
    TIMEOUT: '连接 MiniMax 超时。请检查网络或代理设置后重试。',
    REQUEST_ABORTED: '检测已中止，请重新点击“检测连接”。',
    RESPONSE_TOO_LARGE: 'MiniMax 返回内容超出安全上限，请稍后再试或更新应用。',
    INVALID_RESPONSE: 'MiniMax 返回格式暂不兼容，请稍后再试或更新应用。',
    REQUEST_FAILED: '无法连接 MiniMax。请检查网络、代理或防火墙后重试。',
  };

  let configured = false;
  let clearable = false;
  let busy = false;

  function setFeedback(text, isError) {
    if (!feedback) return;
    feedback.textContent = text || '';
    feedback.classList.toggle('is-error', Boolean(isError));
  }

  function setConnection(state, title, detail) {
    if (connection) connection.dataset.state = state;
    if (connectionStatus) connectionStatus.textContent = title;
    if (connectionDetail) connectionDetail.textContent = detail;
  }

  function resetConnection() {
    setConnection('idle', '尚未检测连接', '检测只读取可用模型列表，不会发送项目正文。');
  }

  function updateButtons() {
    if (saveButton) saveButton.disabled = busy;
    if (checkButton) checkButton.disabled = busy || !configured;
    if (clearButton) clearButton.disabled = busy || !clearable;
  }

  function setBusy(value) {
    busy = Boolean(value);
    updateButtons();
  }

  async function refreshStatus() {
    if (!window.writCraft?.apiKey) {
      configured = false;
      statusLine.textContent = 'Key 配置接口不可用，请重新启动应用。';
      updateButtons();
      return false;
    }
    try {
      const status = await window.writCraft.apiKey.status();
      configured = Boolean(status?.ok !== false && status?.configured);
      clearable = configured || Boolean(status?.ok !== false && status?.userConfigError);
      if (configured && status?.userConfigError) {
        statusLine.textContent = `已配置：${KEY_TYPE_LABEL[status.keyType] || status.keyType || '未知类型'}（正在使用启动环境；本机已存配置损坏或不安全，可先清除）`;
      } else if (configured) {
        statusLine.textContent = `已配置：${KEY_TYPE_LABEL[status.keyType] || status.keyType || '未知类型'}`;
      } else if (status?.userConfigError) {
        statusLine.textContent = '本机已存 Key 配置损坏或不安全，请清除后重新保存。';
      } else if (status?.ok === false) {
        statusLine.textContent = '无法读取本机 Key 状态，请检查应用数据目录权限。';
      } else {
        statusLine.textContent = '尚未配置 AI Key——⌘K / ⌘L / 章节生成暂不可用';
      }
    } catch (_) {
      configured = false;
      clearable = false;
      statusLine.textContent = '无法读取本机 Key 状态，请重新启动应用后再试。';
    }
    updateButtons();
    return configured;
  }

  async function checkConnection() {
    const check = window.writCraft?.apiKey?.check;
    if (typeof check !== 'function') {
      setConnection('failed', '连接检测不可用', '请重新启动或更新笔触后再试。');
      return false;
    }
    setBusy(true);
    setConnection('checking', '正在检测 MiniMax…', '只读取模型列表，不发送项目正文。');
    try {
      const result = await check();
      const latency = Number.isSafeInteger(result?.latencyMs) ? `${result.latencyMs} ms` : '耗时未知';
      if (result?.ok) {
        const models = Array.isArray(result.models) ? result.models : [];
        const modelCount = Number.isSafeInteger(result.modelCount) ? result.modelCount : models.length;
        const sample = models.slice(0, 3).join('、');
        const modelCopy = sample ? `；可用模型：${sample}${modelCount > 3 ? ' 等' : ''}` : '';
        if (result.defaultModelAvailable === false) {
          setConnection('limited', 'Key 已通过验证，默认写作模型不可用', `${latency} · 请检查账户是否有 MiniMax-M3 权限，或更新模型配置${modelCopy}`);
          return false;
        }
        setConnection('connected', 'MiniMax 文本服务已连接', `${latency} · ${modelCount} 个模型${modelCopy}`);
        return true;
      }
      const reason = typeof result?.reason === 'string' ? result.reason : 'REQUEST_FAILED';
      setConnection('failed', '连接检测失败', `${FAILURE_COPY[reason] || FAILURE_COPY.REQUEST_FAILED}（${reason}，${latency}）`);
      return false;
    } catch (_) {
      setConnection('failed', '连接检测失败', FAILURE_COPY.REQUEST_FAILED);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openDialog() {
    setFeedback('');
    input.value = '';
    dialog.hidden = false;
    // 只读本机配置；不要在打开设置时自动访问网络。
    refreshStatus();
    input.focus();
  }

  function closeDialog() {
    dialog.hidden = true;
    input.value = '';
    setFeedback('');
  }

  openButton.addEventListener('click', () => {
    if (dialog.hidden) openDialog();
    else closeDialog();
  });
  closeButton?.addEventListener('click', closeDialog);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); closeDialog(); }
  });

  checkButton?.addEventListener('click', () => checkConnection());

  saveButton?.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { setFeedback('请输入 sk-api- 或 sk-cp- 开头的 Key。', true); return; }
    setBusy(true);
    try {
      const result = await window.writCraft.apiKey.set(key);
      if (result?.ok) {
        input.value = '';
        configured = true;
        clearable = true;
        setFeedback(`已保存（${KEY_TYPE_LABEL[result.keyType] || result.keyType}），正在检测文本服务…`);
        await refreshStatus();
        const verified = await checkConnection();
        setFeedback(verified ? 'Key 已保存，文本服务连接已验证。' : 'Key 已保存，但文本服务尚未通过检测；请按下方提示处理。', !verified);
      } else {
        const copy = result?.error === 'INVALID_KEY'
          ? 'Key 格式无效：仅支持 sk-api- 或 sk-cp- 开头的 MiniMax Key。'
          : '保存失败：请检查应用数据目录权限后重试。';
        setFeedback(copy, true);
      }
    } catch (_) {
      setFeedback('保存失败：请检查应用数据目录权限，重新启动后再试。', true);
    } finally {
      setBusy(false);
    }
  });

  clearButton?.addEventListener('click', async () => {
    setBusy(true);
    try {
      const result = await window.writCraft.apiKey.clear();
      if (result?.ok) {
        input.value = '';
        resetConnection();
        setFeedback('已清除用户 Key。若启动环境提供了 Key，应用会回退使用。');
        await refreshStatus();
      } else {
        setFeedback('清除失败：请检查应用数据目录权限后重试。', true);
      }
    } catch (_) {
      setFeedback('清除失败：请检查应用数据目录权限，重新启动后再试。', true);
    } finally {
      setBusy(false);
    }
  });

  // Enter 直接保存
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); saveButton?.click(); }
  });

  resetConnection();
  updateButtons();
})();
