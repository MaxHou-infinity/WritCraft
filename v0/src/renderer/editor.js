// WritCraft V0 · Day 5
// contenteditable + anchored inline Diff + ⌘L chat + local draft recovery

(function () {
  const STATUS_EL = document.getElementById('tip-tap-status');
  const COUNTER_EL = document.getElementById('char-count');
  const EDITOR_EL = document.getElementById('editor');
  const CHAT_PANEL = document.getElementById('chat-panel');
  const CHAT_CLOSE = document.getElementById('chat-close');
  const CHAT_MESSAGES = document.getElementById('chat-messages');
  const CHAT_INPUT = document.getElementById('chat-input');
  const CHAT_SUBMIT = document.getElementById('chat-submit');
  const CHAT_CONTEXT_LABEL = document.getElementById('chat-context-label');
  const CHAT_CONTEXT_CHIPS = document.getElementById('chat-context-chips');
  const CHAT_SCOPE_BUTTONS = [...document.querySelectorAll('[data-chat-scope]')];
  const state = window.__rewriteState;
  const htmlSanitizer = window.WritCraftHtmlSanitizer;
  const chatContextState = window.WritCraftChatContextState;
  const rewriteTransaction = window.WritCraftInlineRewriteTransaction;

  const STORAGE_KEY = 'writcraft:v0:draft';
  const REWRITE_ACCEPT = 'accept';
  const REWRITE_REJECT = 'reject';
  const rewriteOwner = rewriteTransaction?.createOwner?.() || null;
  let pendingRewrite = null;
  let activeRewrite = null;
  let rewritePreparing = false;
  let requestSequence = 0;
  let chatRequestSequence = 0;
  const chatContextChipOwnership = chatContextState?.createChipOwnership?.() || null;
  let preflightChatGuard = null;
  let rangeMarkerSequence = 0;
  let selectionEpoch = 0;
  let ignoreNextRewriteSelectionChange = false;

  function recordRewriteMetric(outcome, entry, afterChars) {
    if (!entry?.operationId) return;
    const phaseStartedAt = ['accepted', 'rejected', 'discarded'].includes(outcome) ? entry.readyAt : entry.startedAt;
    void window.WritCraftAiMetrics.record(entry.originProjectInstanceId, {
      operationId: entry.operationId,
      action: 'inline_rewrite',
      outcome,
      style: entry.style || 'general',
      scope: 'selection',
      durationMs: Math.max(0, Date.now() - (phaseStartedAt || Date.now())),
      beforeChars: entry.original?.length || 0,
      afterChars: Number.isFinite(afterChars) ? afterChars : (entry.original?.length || 0),
    });
  }
  let saveTimer = null;
  let cachedEditorSelection = null;
  let chatScope = 'file';
  let lastCaretOffset = 0;
  let lastCaretRange = null;
  let projectManaged = false;

  function setStatus(text, isError) {
    if (!STATUS_EL) return;
    STATUS_EL.textContent = text;
    STATUS_EL.style.color = isError ? '#a3473e' : '#5c6f57';
  }

  function readRenderedInnerText(clone) {
    const computed = window.getComputedStyle(EDITOR_EL);
    clone.removeAttribute('id');
    Object.assign(clone.style, {
      position: 'fixed',
      left: '-100000px',
      top: '0',
      width: `${Math.max(1, Math.round(EDITOR_EL.getBoundingClientRect().width))}px`,
      height: 'auto',
      display: computed.display === 'none' ? 'block' : computed.display,
      whiteSpace: computed.whiteSpace,
      textTransform: computed.textTransform,
      direction: computed.direction,
      writingMode: computed.writingMode,
      visibility: 'visible',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    clone.setAttribute('aria-hidden', 'true');
    document.body.appendChild(clone);
    try { return clone.innerText || ''; }
    finally { clone.remove(); }
  }

  function getStableText() {
    if (!pendingRewrite) return EDITOR_EL.innerText || '';
    const clone = EDITOR_EL.cloneNode(true);
    const transient = clone.querySelector('[data-writcraft-transient="rewrite"]');
    if (transient) transient.replaceWith(document.createTextNode(pendingRewrite.original));
    return readRenderedInnerText(clone);
  }

  function getStableHtml() {
    const clone = EDITOR_EL.cloneNode(true);
    const transient = clone.querySelector('[data-writcraft-transient="rewrite"]');
    if (transient && pendingRewrite) {
      const template = document.createElement('template');
      template.innerHTML = pendingRewrite.originalHtml;
      transient.replaceWith(template.content.cloneNode(true));
    }
    return clone.innerHTML;
  }

  function updateCount() {
    const text = getStableText().trim();
    const words = text ? text.split(/\s+/).length : 0;
    if (COUNTER_EL) COUNTER_EL.textContent = `字符: ${text.length} · 词数: ${words}`;
  }

  function saveDraftNow() {
    if (projectManaged) return;
    const payload = state.createStoragePayload(getStableHtml());
    try {
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (error) {
      setStatus('⚠️ 草稿暂时无法保存：' + error.message, true);
    }
  }

  async function prepareAIRequestGuard() {
    if (!window.__workspace?.state?.project) return null;
    const neededFlush = Boolean(window.__workspace.state.dirty || window.__workspace.state.savePromise);
    const saved = await window.__workspace.persistCurrent?.(true);
    if (!saved || !window.__workspace.canUseAI?.()) return false;
    if (neededFlush) await window.__workspace.settleOwnWriteEcho?.();
    return window.__workspace.captureAIRequestGuard?.() || false;
  }

  async function prepareChatRequestGuard(intent) {
    return window.__aiRequestGuard?.prepareChatIntent?.(intent, {
      getState: () => window.__workspace?.state,
      getInteraction: currentChatInteraction,
      persist: () => window.__workspace?.persistCurrent?.(true),
      settle: () => window.__workspace?.settleOwnWriteEcho?.(),
      canUseAI: () => window.__workspace?.canUseAI?.(),
    }) || { ok: false, reason: 'CHAT_INTENT_INVALID' };
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraftNow, 350);
  }

  function restoreDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || typeof saved.html !== 'string') return false;
      const template = document.createElement('template');
      template.innerHTML = saved.html;
      htmlSanitizer.sanitizeFragment(template.content, state);
      EDITOR_EL.replaceChildren(template.content.cloneNode(true));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function selectionInsideEditor(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return EDITOR_EL.contains(range.commonAncestorContainer);
  }

  function getEditorSelection() {
    const selection = window.getSelection();
    if (!selectionInsideEditor(selection)) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    return { range: selection.getRangeAt(0).cloneRange(), text };
  }

  // Web Crypto is asynchronous. Inline Rewrite must freeze the selected-text
  // digest before its first await, so this small SHA-256 implementation works
  // synchronously over UTF-8 bytes in the Renderer only.
  function sha256Digest(value) {
    const bytes = new TextEncoder().encode(String(value));
    const length = Math.ceil((bytes.length + 9) / 64) * 64;
    const input = new Uint8Array(length);
    input.set(bytes);
    input[bytes.length] = 0x80;
    const view = new DataView(input.buffer);
    const bitLength = BigInt(bytes.length) * 8n;
    view.setUint32(length - 8, Number((bitLength >> 32n) & 0xffffffffn));
    view.setUint32(length - 4, Number(bitLength & 0xffffffffn));
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const words = new Uint32Array(64);
    const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
    for (let offset = 0; offset < length; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choice = (e & f) ^ (~e & g);
        const first = (h + s1 + choice + constants[index] + words[index]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const second = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + first) >>> 0;
        d = c; c = b; b = a; a = (first + second) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    return `sha256:${hash.map(word => word.toString(16).padStart(8, '0')).join('')}`;
  }

  function rememberEditorCaret(selection = window.getSelection()) {
    if (!selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!EDITOR_EL.contains(range.startContainer)) return;
    lastCaretRange = range.cloneRange();
    lastCaretRange.collapse(true);
  }

  function resolveRememberedCaretOffset(stableText) {
    if (!lastCaretRange || !EDITOR_EL.contains(lastCaretRange.startContainer)) return lastCaretOffset;
    const offsets = rangeOffsets(lastCaretRange, stableText);
    return offsets ? offsets.startOffset : lastCaretOffset;
  }

  function insertCitation(source, style) {
    if (!window.WritCraftCitation) return { ok: false, message: '脚注格式器未连接' };
    try {
      const current = getStableText();
      const offset = resolveRememberedCaretOffset(current);
      const result = window.WritCraftCitation.insertFootnote(current, offset, source, style);
      if (pendingRewrite) rejectRewrite(false);
      EDITOR_EL.textContent = result.content;
      lastCaretOffset = result.cursorOffset;
      lastCaretRange = null;
      updateCount();
      EDITOR_EL.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: result.reference }));
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }

  function insertMarkdown(markdown) {
    const value = String(markdown || '');
    if (!value || value.length > 4096) return { ok: false, message: '待插入 Markdown 无效' };
    const current = getStableText();
    const offset = Math.max(0, Math.min(resolveRememberedCaretOffset(current), current.length));
    if (pendingRewrite) rejectRewrite(false);
    const prefix = offset > 0 && current[offset - 1] !== '\n' ? '\n\n' : '';
    const suffix = offset < current.length && current[offset] !== '\n' ? '\n\n' : '';
    const inserted = `${prefix}${value}${suffix}`;
    EDITOR_EL.textContent = current.slice(0, offset) + inserted + current.slice(offset);
    lastCaretOffset = offset + inserted.length;
    lastCaretRange = null;
    updateCount();
    EDITOR_EL.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    return { ok: true, cursorOffset: lastCaretOffset };
  }

  function topLevelEditorChild(node) {
    let current = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (current && current.parentNode !== EDITOR_EL) current = current.parentNode;
    return current;
  }

  function isSingleBlockRange(range) {
    return topLevelEditorChild(range.startContainer) === topLevelEditorChild(range.endContainer);
  }

  function nodePathFromEditor(node) {
    const path = [];
    let current = node;
    while (current && current !== EDITOR_EL) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.push(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === EDITOR_EL ? path.reverse() : null;
  }

  function nodeAtPath(root, path) {
    let current = root;
    for (const index of path || []) {
      current = current?.childNodes?.[index];
      if (!current) return null;
    }
    return current;
  }

  function rangeIdentityFor(range) {
    if (!range) return null;
    const startPath = nodePathFromEditor(range.startContainer);
    const endPath = nodePathFromEditor(range.endContainer);
    if (!startPath || !endPath) return null;
    return `${startPath.join('.')}:${range.startOffset}:${endPath.join('.')}:${range.endOffset}`;
  }

  function insertPointMarker(container, offset, marker) {
    if (container.nodeType === Node.TEXT_NODE) {
      if (offset < 0 || offset > container.data.length) return false;
      container.insertData(offset, marker);
      return true;
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
      if (offset < 0 || offset > container.childNodes.length) return false;
      container.insertBefore(document.createTextNode(marker), container.childNodes[offset] || null);
      return true;
    }
    return false;
  }

  function rangeOffsets(range, stableText) {
    if (!range || !EDITOR_EL.contains(range.commonAncestorContainer)) return null;
    const startPath = nodePathFromEditor(range.startContainer);
    const endPath = nodePathFromEditor(range.endContainer);
    if (!startPath || !endPath) return null;
    const clone = EDITOR_EL.cloneNode(true);
    clone.removeAttribute('id');
    const startContainer = nodeAtPath(clone, startPath);
    const endContainer = nodeAtPath(clone, endPath);
    if (!startContainer || !endContainer) return null;

    let markerId;
    let startMarker;
    let endMarker;
    do {
      markerId = ++rangeMarkerSequence;
      startMarker = `\uE000writcraft-range-start-${markerId}\uE001`;
      endMarker = `\uE000writcraft-range-end-${markerId}\uE001`;
    } while (stableText.includes(startMarker) || stableText.includes(endMarker));

    // Insert the later boundary first so two points in the same text/element
    // keep their original offsets.
    if (!insertPointMarker(endContainer, range.endOffset, endMarker) ||
        !insertPointMarker(startContainer, range.startOffset, startMarker)) return null;

    // innerText only applies rendered block/<br> newline semantics to a node
    // participating in layout. The helper uses an off-screen rendered clone.
    const serialized = readRenderedInnerText(clone);

    const startIndex = serialized.indexOf(startMarker);
    const endIndex = serialized.indexOf(endMarker);
    if (startIndex < 0 || endIndex < startIndex + startMarker.length) return null;
    const selectedText = serialized.slice(startIndex + startMarker.length, endIndex);
    const withoutMarkers = serialized.slice(0, startIndex) + selectedText + serialized.slice(endIndex + endMarker.length);
    if (withoutMarkers !== stableText) return null;
    return {
      startOffset: startIndex,
      endOffset: startIndex + selectedText.length,
    };
  }

  function captureEditorSelection(selected = getEditorSelection()) {
    if (!selected?.range) return null;
    const stableText = getStableText();
    const offsets = rangeOffsets(selected.range, stableText);
    if (!offsets || offsets.endOffset <= offsets.startOffset) return null;
    const text = stableText.slice(offsets.startOffset, offsets.endOffset);
    if (!text.trim()) return null;
    const snapshot = {
      text,
      filePath: window.__workspace?.getCurrentPath?.() || undefined,
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
    };
    return chatContextState?.validSelection?.(snapshot) ? snapshot : null;
  }

  function compactBlockProof(value) {
    const keys = [
      'schema', 'id', 'filePath', 'type', 'headingKey', 'ordinal',
      'blockFingerprint', 'quoteFingerprint', 'relativeStart', 'relativeEnd',
    ];
    const proof = {};
    for (const key of keys) proof[key] = value[key];
    return Object.freeze(proof);
  }

  function makeButton(label, action, primary) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `inline-diff-button${primary ? ' is-primary' : ''}`;
    button.dataset.action = action;
    button.textContent = label;
    button.setAttribute('contenteditable', 'false');
    button.addEventListener('mousedown', event => event.preventDefault());
    return button;
  }

  function appendActionBar(wrapper) {
    const bar = document.createElement('span');
    bar.className = 'inline-diff-actions';
    bar.setAttribute('contenteditable', 'false');
    const style = document.createElement('select');
    style.className = 'inline-diff-style';
    style.setAttribute('aria-label', '改写风格');
    for (const [value, label] of [['general', '润色'], ['concise', '精简'], ['vivid', '生动'], ['academic', '学术'], ['casual', '口语']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      style.appendChild(option);
    }
    style.value = pendingRewrite?.style || 'general';
    style.addEventListener('change', () => {
      if (!pendingRewrite) return;
      void regenerateRewrite(style.value);
    });
    bar.append(
      style,
      makeButton('重载', 'regenerate'),
      makeButton('接受', 'accept', true),
      makeButton('拒绝', 'reject')
    );
    bar.addEventListener('click', event => {
      const action = event.target && event.target.dataset.action;
      if (action === REWRITE_ACCEPT) void acceptRewrite();
      if (action === REWRITE_REJECT) void rejectRewrite();
      if (action === 'regenerate') void regenerateRewrite();
    });
    wrapper.appendChild(bar);
  }

  function renderLoading(wrapper, original) {
    wrapper.replaceChildren();
    const text = document.createElement('span');
    text.className = 'inline-diff-original is-loading';
    text.textContent = original;
    const badge = document.createElement('span');
    badge.className = 'inline-diff-loading';
    badge.textContent = 'M3 正在校改…';
    badge.setAttribute('contenteditable', 'false');
    wrapper.append(text, badge);
  }

  function appendRewriteContextChips(wrapper, contextManifest) {
    const chips = Array.isArray(contextManifest?.chips) ? contextManifest.chips : [];
    const available = [
      ['project_prompt', '✦ edit.md'],
      ['selection', '🎯 选段'],
      ['neighbor', '↕ 邻段'],
    ].filter(([type]) => chips.some(chip => chip.type === type));
    if (!available.length) return;
    const row = document.createElement('span');
    row.className = 'inline-diff-context';
    row.setAttribute('contenteditable', 'false');
    row.setAttribute('aria-label', '本次改写实际使用的上下文');
    for (const [type, label] of available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inline-diff-context-chip';
      button.textContent = label;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        window.__contextInspectorView?.update?.(contextManifest, contextManifest?.errors || []);
        window.__contextInspectorView?.open?.();
      });
      row.append(button);
    }
    wrapper.appendChild(row);
  }

  function renderInlineDiff(wrapper, original, proposal, contextManifest) {
    wrapper.replaceChildren();
    const diffApi = window.Diff || window.diff;
    const fragments = diffApi
      ? diffApi.diffWords(original || '', proposal || '')
      : [{ value: proposal || '', added: true }];
    for (const fragment of fragments) {
      const span = document.createElement('span');
      span.className = fragment.added ? 'inline-diff-add'
        : fragment.removed ? 'inline-diff-remove'
        : 'inline-diff-equal';
      span.textContent = fragment.value;
      wrapper.appendChild(span);
    }
    appendRewriteContextChips(wrapper, contextManifest);
    appendActionBar(wrapper);
  }

  function placeRewriteAnchor(range, original) {
    const fragment = range.cloneContents();
    const holder = document.createElement('div');
    holder.appendChild(fragment.cloneNode(true));
    const wrapper = document.createElement('span');
    wrapper.className = 'inline-diff';
    wrapper.dataset.writcraftTransient = 'rewrite';
    wrapper.setAttribute('contenteditable', 'false');
    range.deleteContents();
    range.insertNode(wrapper);
    renderLoading(wrapper, original);
    ignoreNextRewriteSelectionChange = true;
    window.getSelection().removeAllRanges();
    return { wrapper, originalFragment: fragment, originalHtml: holder.innerHTML };
  }

  function currentRewriteSelection(frozen) {
    if (!frozen || selectionEpoch !== frozen.selectionEpoch) return null;
    const selected = getEditorSelection();
    if (!selected) return null;
    const stableText = getStableText();
    const offsets = rangeOffsets(selected.range, stableText);
    if (!offsets || offsets.startOffset !== frozen.offsets.startOffset || offsets.endOffset !== frozen.offsets.endOffset) return null;
    const original = stableText.slice(offsets.startOffset, offsets.endOffset);
    if (sha256Digest(original) !== frozen.selection.digest) return null;
    const rangeIdentity = rangeIdentityFor(selected.range);
    if (!rangeIdentity || rangeIdentity !== frozen.selection.rangeIdentity) return null;
    let proof;
    try {
      proof = compactBlockProof(window.WritCraftBlockAnchor.createBlockAnchor(
        stableText, frozen.intent.currentPath, offsets.startOffset, offsets.endOffset,
      ));
    } catch (_) { return null; }
    return {
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
      digest: frozen.selection.digest,
      proof,
      rangeIdentity,
      range: selected.range,
    };
  }

  function freezeRewriteIntent(style) {
    const workspaceState = window.__workspace?.state;
    const selected = getEditorSelection();
    if (!workspaceState?.project || !selected) return null;
    const stableText = getStableText();
    const offsets = rangeOffsets(selected.range, stableText);
    const original = offsets ? stableText.slice(offsets.startOffset, offsets.endOffset) : '';
    if (!offsets || !original.trim()) return null;
    let proof;
    try {
      proof = compactBlockProof(window.WritCraftBlockAnchor.createBlockAnchor(
        stableText, workspaceState.currentPath, offsets.startOffset, offsets.endOffset,
      ));
    } catch (_) { return null; }
    const rangeIdentity = rangeIdentityFor(selected.range);
    if (!rangeIdentity) return null;
    const selection = Object.freeze({
      startOffset: offsets.startOffset,
      endOffset: offsets.endOffset,
      digest: sha256Digest(original),
      proof,
      rangeIdentity,
    });
    const intent = rewriteTransaction?.captureIntent?.(workspaceState, selection, style);
    return intent ? { intent, selection, selectionEpoch, offsets, original, selectedRange: selected.range.cloneRange() } : null;
  }

  function previewBindingCurrent(entry) {
    const workspaceState = window.__workspace?.state;
    const intent = entry?.binding?.intent;
    return Boolean(entry && intent && entry.wrapper?.isConnected && pendingRewrite === entry &&
      workspaceState?.project?.instanceId === intent.projectInstanceId && workspaceState.currentPath === intent.currentPath &&
      workspaceState.openGeneration === intent.openGeneration && workspaceState.editVersion === intent.editVersion &&
      workspaceState.dirty === false && workspaceState.revision === entry.binding.persistedRevision &&
      getStableText().slice(intent.selection.startOffset, intent.selection.endOffset) === entry.original);
  }

  function safeDiscard(projectInstanceId, payload) {
    if (!window.writCraft?.discardRewrite || !projectInstanceId || !payload) return Promise.resolve(false);
    return Promise.resolve(window.writCraft.discardRewrite(projectInstanceId, payload)).then(
      result => result?.ok === true,
      () => false,
    );
  }

  function restorePreview(entry, focus = false) {
    if (!entry?.wrapper?.isConnected) return null;
    const fragment = entry.originalFragment.cloneNode(true);
    const first = fragment.firstChild;
    const last = fragment.lastChild;
    entry.wrapper.replaceWith(fragment);
    updateCount();
    if (!focus || !first || !last || !EDITOR_EL.contains(first) || !EDITOR_EL.contains(last)) return null;
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    EDITOR_EL.focus();
    return range;
  }

  function lockPreview(entry) {
    entry.locked = true;
    entry.wrapper?.setAttribute?.('aria-busy', 'true');
    entry.wrapper?.querySelectorAll?.('button,select').forEach(control => { control.disabled = true; });
  }

  function setPreviewAckPending(entry, pending) {
    entry.wrapper?.setAttribute?.('aria-busy', pending ? 'true' : 'false');
    entry.wrapper?.querySelectorAll?.('button,select').forEach(control => { control.disabled = Boolean(pending); });
  }

  function destroyTransientPreview(entry) {
    if (entry?.wrapper?.isConnected) entry.wrapper.remove();
    if (pendingRewrite === entry) pendingRewrite = null;
    if (activeRewrite === entry) activeRewrite = null;
    rewritePreparing = false;
    updateCount();
  }

  function committedBindingCurrent(entry, revision) {
    const workspaceState = window.__workspace?.state;
    return Boolean(workspaceState?.project?.instanceId === entry.intent.projectInstanceId &&
      workspaceState.currentPath === entry.intent.currentPath && workspaceState.revision === revision);
  }

  function placeCollapsedCaret(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) return false;
    const walker = document.createTreeWalker(EDITOR_EL, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.data.length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        EDITOR_EL.focus();
        return true;
      }
      remaining -= node.data.length;
    }
    return false;
  }

  async function enterRewriteRecovery(kind, rewriteId, message) {
    try {
      return await window.__workspace?.beginInlineRewriteRecovery?.({ kind, rewriteId, message }) || null;
    } catch (_) { return null; }
  }

  async function failGeneration(entry, message, discardPayload = null) {
    if (discardPayload) await safeDiscard(entry.intent.projectInstanceId, discardPayload);
    if (rewriteOwner?.owns(entry.token)) rewriteOwner.invalidate(rewriteTransaction.STATES.FAILED);
    if (activeRewrite === entry) activeRewrite = null;
    rewritePreparing = false;
    recordRewriteMetric('failed', entry, entry.original.length);
    setStatus(message, true);
  }

  async function runRewrite(entry) {
    const adapters = {
      getState: () => window.__workspace?.state,
      getSelection: () => currentRewriteSelection(entry.frozen),
      getStyle: () => entry.style,
      persist: async () => {
        const saved = await window.__workspace?.persistCurrent?.(true);
        return { ok: saved === true, revision: window.__workspace?.state?.revision };
      },
      settleWatcher: () => window.__workspace?.settleOwnWriteEcho?.(),
    };
    const prepared = await rewriteTransaction.prepareIntent(entry.intent, adapters);
    if (!rewriteOwner.owns(entry.token) || activeRewrite !== entry) return;
    if (!prepared.ok || !window.__workspace?.canUseAI?.()) {
      await failGeneration(entry, '⚠️ 选段、文件或项目在保存期间已变化，请重新选中');
      return;
    }
    entry.binding = prepared.binding;
    const request = rewriteTransaction.createRequest(prepared.binding);
    if (!request || !rewriteOwner.transition(entry.token, rewriteTransaction.STATES.GENERATING)) {
      await failGeneration(entry, '⚠️ 改写请求无法安全建立');
      return;
    }
    setStatus('✦ 正在校改选中文字…');
    let rawResult;
    try {
      rawResult = await window.writCraft.rewrite(entry.intent.projectInstanceId, request);
    } catch (_) {
      const payload = rewriteOwner.discardPayload(entry.token);
      if (rewriteOwner.owns(entry.token)) await failGeneration(entry, '⚠️ 改写服务中断，原文未改动', payload);
      return;
    }
    if (!rewriteOwner.owns(entry.token) || activeRewrite !== entry) {
      const lateReview = rewriteTransaction.discardPayloadForReview(rawResult);
      if (lateReview) await safeDiscard(entry.intent.projectInstanceId, lateReview);
      return;
    }
    const selection = currentRewriteSelection(entry.frozen);
    const bindingCurrent = rewriteTransaction.preparedBindingMatches(
      entry.binding, window.__workspace?.state, selection, entry.style,
    );
    const review = rewriteTransaction.normalizeReviewResult(rawResult);
    if (!review || !bindingCurrent) {
      const payload = rewriteTransaction.discardPayloadForReview(rawResult) || rewriteOwner.discardPayload(entry.token);
      await failGeneration(entry, review ? '⚠️ 选段或项目已变化，本次结果已丢弃' : '⚠️ AI 返回了无法验证的校改结果', payload);
      return;
    }
    const associated = rewriteOwner.associateReview(entry.token, review, true);
    if (!associated) {
      await failGeneration(entry, '⚠️ 校改结果已过期', rewriteTransaction.discardPayloadForReview(review));
      return;
    }
    if (review.outcome === 'no_op') {
      rewriteOwner.invalidate(rewriteTransaction.STATES.NO_OP);
      activeRewrite = null;
      rewritePreparing = false;
      setStatus('✅ AI 建议与原文相同，未创建修改');
      return;
    }
    const liveSelection = getEditorSelection();
    if (!liveSelection || !currentRewriteSelection(entry.frozen)) {
      await failGeneration(entry, '⚠️ 选区已变化，本次结果已丢弃', rewriteTransaction.discardPayloadForReview(review));
      return;
    }
    const placed = placeRewriteAnchor(liveSelection.range, entry.original);
    Object.assign(entry, placed, {
      proposal: review.replacement,
      review,
      contextManifest: review.contextManifest,
      readyAt: Date.now(),
    });
    pendingRewrite = entry;
    renderInlineDiff(entry.wrapper, entry.original, entry.proposal, entry.contextManifest);
    setPreviewAckPending(entry, true);
    window.__contextInspectorView?.update?.(entry.contextManifest, entry.contextManifest?.errors || []);
    const ackPayload = rewriteOwner.ackPayload(entry.token, previewBindingCurrent(entry));
    let ackResult = null;
    try {
      if (ackPayload) ackResult = await window.writCraft.ackRewrite(entry.intent.projectInstanceId, ackPayload);
    } catch (_) {}
    if (!rewriteOwner.owns(entry.token) || pendingRewrite !== entry) return;
    if (!rewriteOwner.acknowledge(entry.token, ackResult, previewBindingCurrent(entry))) {
      const discardPayload = rewriteTransaction.discardPayloadForReview(review);
      await safeDiscard(entry.intent.projectInstanceId, discardPayload);
      pendingRewrite = null;
      restorePreview(entry, false);
      await failGeneration(entry, '⚠️ 校改预览未能安全确认，原文已保留');
      return;
    }
    setPreviewAckPending(entry, false);
    rewritePreparing = false;
    recordRewriteMetric('generated', entry, entry.proposal.length);
    setStatus('✦ 校改已就位 · Tab 接受 · Esc 拒绝 · Ctrl+Enter 重载');
    updateCount();
  }

  async function beginRewrite(style = 'general') {
    if (!window.__workspace?.state?.project) {
      setStatus('⚠️ ⌘K 校改只在写作项目中可用', true);
      return;
    }
    if (!rewriteTransaction || !rewriteOwner || !window.writCraft?.rewrite || !window.writCraft?.ackRewrite) {
      setStatus('⚠️ Inline Rewrite 安全服务未连接', true);
      return;
    }
    if (!window.__workspace.canUseAI?.()) {
      setStatus('⚠️ 项目 Prompt 缺失或文件冲突，处理后才能使用 AI', true);
      return;
    }
    if (activeRewrite || pendingRewrite || rewritePreparing) {
      setStatus('⚠️ 请先接受或拒绝当前校改', true);
      return;
    }
    // Everything below, through captureIntent/owner.begin, is synchronous and
    // therefore freezes the exact UTF-16 selection before the first await.
    const frozen = freezeRewriteIntent(style);
    if (!frozen) {
      setStatus('⚠️ 请在同一个 Markdown 段落块内选中要改写的文字', true);
      return;
    }
    const token = rewriteOwner.begin(frozen.intent);
    if (!token) return;
    rewritePreparing = true;
    const entry = {
      token,
      intent: frozen.intent,
      frozen,
      original: frozen.original,
      style,
      operationId: window.WritCraftAiMetrics?.createOperationId?.(),
      originProjectInstanceId: frozen.intent.projectInstanceId,
      startedAt: Date.now(),
    };
    activeRewrite = entry;
    await runRewrite(entry);
  }

  async function rejectRewrite(announce = true) {
    const entry = pendingRewrite;
    if (!entry || entry.locked) return false;
    const bindingCurrent = previewBindingCurrent(entry);
    const payload = rewriteOwner.discardPayload(entry.token);
    rewriteOwner.invalidate(rewriteTransaction.STATES.REJECTED);
    activeRewrite = null;
    pendingRewrite = null;
    requestSequence += 1;
    if (bindingCurrent) restorePreview(entry, announce);
    await safeDiscard(entry.intent.projectInstanceId, payload);
    if (announce) {
      setStatus(bindingCurrent ? '原文已恢复' : '校改已丢弃；当前编辑状态已变化', !bindingCurrent);
      recordRewriteMetric('rejected', entry, entry.original.length);
    }
    return bindingCurrent;
  }

  async function regenerateRewrite(nextStyle = pendingRewrite?.style || 'general') {
    const entry = pendingRewrite;
    if (!entry || entry.locked) return false;
    const bindingCurrent = previewBindingCurrent(entry);
    const payload = rewriteOwner.discardPayload(entry.token);
    rewriteOwner.invalidate(rewriteTransaction.STATES.DISCARDED);
    activeRewrite = null;
    pendingRewrite = null;
    requestSequence += 1;
    const restoredRange = bindingCurrent ? restorePreview(entry, true) : null;
    await safeDiscard(entry.intent.projectInstanceId, payload);
    if (!restoredRange || !window.__workspace?.canUseAI?.()) {
      setStatus('⚠️ 选段或项目已变化，无法重新校改', true);
      return false;
    }
    recordRewriteMetric('discarded', entry, entry.original.length);
    await beginRewrite(nextStyle);
    return true;
  }

  async function acceptRewrite() {
    const entry = pendingRewrite;
    if (!entry || entry.locked || !previewBindingCurrent(entry)) {
      setStatus('⚠️ 文件或选段已变化，不能接受该校改', true);
      return false;
    }
    const payload = rewriteOwner.beginApply(entry.token, true);
    if (!payload || !window.writCraft?.applyRewrite) return false;
    lockPreview(entry);
    setStatus('正在应用校改…');
    let rawResult;
    try {
      rawResult = await window.writCraft.applyRewrite(entry.intent.projectInstanceId, payload);
    } catch (_) { rawResult = null; }
    if (!rewriteOwner.owns(entry.token) || activeRewrite !== entry || pendingRewrite !== entry) return false;
    const route = rewriteOwner.settleApply(entry.token, rawResult);
    if (!route) return false;
    if (route.kind === 'trusted_success') {
      if (route.result.status === 'committed_warning' && route.result.manualRecoveryRequired) {
        destroyTransientPreview(entry);
        await enterRewriteRecovery('manual_recovery', entry.review.rewriteId, route.result.message);
        setStatus(`⚠️ ${route.result.message}`, true);
        return true;
      }
      let completion = null;
      try {
        completion = await window.__workspace?.completeInlineRewriteCommit?.({
          status: route.result.status,
          path: route.result.path,
          revision: route.result.revision,
          rewriteId: entry.review.rewriteId,
          historyEntryId: route.result.historyEntryId,
        }) || null;
      } catch (_) { completion = null; }
      if (completion?.ok !== true || completion.authoritativeReloaded !== true) {
        destroyTransientPreview(entry);
        await enterRewriteRecovery('trusted_success', entry.review.rewriteId, '已应用，但界面刷新失败；请重开项目，不要重试');
        setStatus('⚠️ 已应用，但界面刷新失败；请重开项目，不要重试', true);
        return true;
      }
      pendingRewrite = null;
      activeRewrite = null;
      rewriteOwner.invalidate(rewriteTransaction.STATES.APPLIED);
      recordRewriteMetric('accepted', entry, entry.proposal.length);
      const caretOffset = entry.intent.selection.startOffset + entry.proposal.length;
      if (rewriteTransaction.canPlaceCommittedCaret(route, committedBindingCurrent(entry, route.result.revision), true, false)) {
        placeCollapsedCaret(caretOffset);
      }
      if (route.result.status === 'committed_warning') {
        setStatus(`⚠️ ${route.result.message}`, true);
      } else {
        setStatus('✅ 已应用校改');
      }
      return true;
    }
    if (route.kind === 'known_zero_write_error') {
      let recovery = null;
      try {
        recovery = await window.__workspace?.restoreInlineRewriteAfterZeroWrite?.({
          rewriteId: entry.review.rewriteId,
        }) || null;
      } catch (_) { recovery = null; }
      const safeToRestore = recovery?.ok === true && recovery.safeToRestore === true;
      if (rewriteTransaction.canRestoreOrRefocus('known-zero-write-error', previewBindingCurrent(entry), safeToRestore, false)) {
        pendingRewrite = null;
        activeRewrite = null;
        restorePreview(entry, true);
        rewriteOwner.invalidate(rewriteTransaction.STATES.FAILED);
        setStatus(`⚠️ ${route.result.error.message}`, true);
      } else {
        destroyTransientPreview(entry);
        await enterRewriteRecovery('known_zero_write_error', entry.review.rewriteId, '校改结果需要重开项目确认');
        setStatus('⚠️ 无法清除恢复标记；请重开项目，不要重试', true);
      }
      recordRewriteMetric('failed', entry, entry.original.length);
      return false;
    }
    const recoveryKind = route.kind === 'manual_recovery' ? 'manual_recovery' : 'outcome_unknown';
    const message = route.kind === 'manual_recovery'
      ? route.result.error.message
      : '无法确认校改是否已写入；已锁定编辑，请等待恢复或重开项目，不要重试';
    destroyTransientPreview(entry);
    const recovery = await enterRewriteRecovery(recoveryKind, entry.review.rewriteId, message);
    if (route.kind === 'outcome_unknown' && recovery?.ok === true && recovery.authoritativeReloaded === true) {
      pendingRewrite = null;
      activeRewrite = null;
      rewriteOwner.transition(entry.token, rewriteTransaction.STATES.RECONCILED);
      setStatus(recovery.message || '已按磁盘和历史恢复校改结果');
      return true;
    }
    setStatus(`⚠️ ${message}`, true);
    if (route.kind === 'manual_recovery') recordRewriteMetric('failed', entry, entry.original.length);
    return false;
  }

  function cancelActiveRewriteForDocumentLoad() {
    if (pendingRewrite) {
      const phase = rewriteOwner?.getActive?.()?.state;
      if (phase === rewriteTransaction?.STATES.APPLYING || pendingRewrite.locked) {
        // APPLYING survives Renderer navigation. The replacement workspace owns
        // reconciliation and must not see a local restoration or discard.
        pendingRewrite = null;
        activeRewrite = null;
        return;
      }
      void rejectRewrite(false);
      return;
    }
    if (!activeRewrite || !rewriteOwner?.owns(activeRewrite.token)) return;
    const entry = activeRewrite;
    const payload = rewriteOwner.discardPayload(entry.token);
    rewriteOwner.invalidate(rewriteTransaction.STATES.CANCELED);
    activeRewrite = null;
    rewritePreparing = false;
    void safeDiscard(entry.intent.projectInstanceId, payload);
  }

  function hideChat() {
    if (window.__workspace && window.__workspace.setAIVisible) {
      window.__workspace.setAIVisible(false);
    } else {
      CHAT_PANEL.style.display = 'none';
    }
  }
  function showChat() {
    cachedEditorSelection = captureEditorSelection() || cachedEditorSelection;
    chatScope = chatContextState?.defaultScope?.(cachedEditorSelection) || (cachedEditorSelection ? 'selection' : 'file');
    clearStalePreflightContextChips();
    if (window.__workspace && window.__workspace.setAIVisible) {
      window.__workspace.setAIVisible(true);
    } else {
      CHAT_PANEL.style.display = 'flex';
    }
    updateChatContextLabel();
    CHAT_INPUT.focus();
  }

  function setChatScope(nextScope) {
    const normalized = chatContextState?.normalizeScope?.(nextScope, cachedEditorSelection) || 'file';
    if (nextScope === 'selection' && normalized !== 'selection') {
      setStatus('⚠ 选区作用域需要先在正文中选中文字', true);
      return false;
    }
    chatScope = normalized;
    updateChatContextLabel();
    clearStalePreflightContextChips();
    return true;
  }

  function updateChatContextLabel() {
    for (const button of CHAT_SCOPE_BUTTONS) {
      const scope = button.dataset.chatScope;
      button.disabled = scope === 'selection' && !cachedEditorSelection;
      button.setAttribute('aria-pressed', String(scope === chatScope));
      if (scope === 'selection') button.title = cachedEditorSelection ? '仅使用精确选段与前后相邻段落' : '在正文中选中文字后可用';
    }
    if (chatScope === 'project') {
      CHAT_CONTEXT_LABEL.textContent = '◎ 项目 · edit.md + 显式引用 + 受限检索';
      CHAT_CONTEXT_LABEL.style.background = '#e7e9f5';
    } else if (chatScope === 'selection' && cachedEditorSelection) {
      const preview = cachedEditorSelection.text.length > 20
        ? cachedEditorSelection.text.slice(0, 20) + '…'
        : cachedEditorSelection.text;
      CHAT_CONTEXT_LABEL.textContent = `🎯 选区 · “${preview}” + 相邻段落`;
      CHAT_CONTEXT_LABEL.style.background = '#fff3e0';
    } else {
      CHAT_CONTEXT_LABEL.textContent = `📄 文件 · ${window.__workspace?.getCurrentPath?.() || '当前文件'}（${getStableText().length} 字）`;
      CHAT_CONTEXT_LABEL.style.background = '#e8f0f5';
    }
  }

  function clearPreflightContextChips(requestToken = null) {
    if (!CHAT_CONTEXT_CHIPS || !chatContextChipOwnership?.clearPreflight?.(requestToken)) return false;
    preflightChatGuard = null;
    CHAT_CONTEXT_CHIPS.replaceChildren();
    return true;
  }

  function clearStalePreflightContextChips() {
    const owner = chatContextChipOwnership?.get?.();
    if (owner?.phase !== 'preflight' || !preflightChatGuard) return false;
    if (isChatRequestCurrent(owner.requestToken, preflightChatGuard, true)) return false;
    return clearPreflightContextChips(owner.requestToken);
  }

  function renderContextChips(chips, ownership = null) {
    if (!CHAT_CONTEXT_CHIPS) return;
    CHAT_CONTEXT_CHIPS.replaceChildren();
    for (const chip of chips || []) {
      const button = document.createElement('button');
      button.className = 'context-chip';
      chatContextState.bindChipButton(button, chip, value => window.__workspace?.revealContextChip?.(value));
      CHAT_CONTEXT_CHIPS.appendChild(button);
    }
    if (ownership) {
      chatContextChipOwnership?.publish?.(ownership.requestToken, ownership.phase);
      preflightChatGuard = ownership.phase === 'preflight' ? ownership.chatGuard : null;
    } else {
      chatContextChipOwnership?.clearAll?.();
      preflightChatGuard = null;
    }
  }

  function appendChatMsg(role, text, useMarkdown) {
    const div = document.createElement('div');
    div.className = `chat-msg chat-${role}`;
    if (useMarkdown && window.marked) {
      const label = document.createTextNode('AI: ');
      const body = document.createElement('div');
      body.className = 'md-body';
      const template = document.createElement('template');
      template.innerHTML = window.marked.parse(state.escapeMarkdownSource(text));
      htmlSanitizer.sanitizeFragment(template.content, state);
      body.replaceChildren(template.content.cloneNode(true));
      div.append(label, body);
    } else {
      div.textContent = `${role === 'user' ? '你' : 'AI'}: ${text || ''}`;
    }
    CHAT_MESSAGES.appendChild(div);
    CHAT_MESSAGES.scrollTop = CHAT_MESSAGES.scrollHeight;
    return div;
  }

  function manifestChips(contextManifest) {
    if (!contextManifest) return [];
    if (Array.isArray(contextManifest)) return contextManifest.map(item => ({
      id: `ctx_manifest_${item.path}_${item.revision || ''}`,
      type: item.role === 'project-prompt' ? 'project_prompt' : 'file',
      label: item.path,
      filePath: item.path,
      revision: item.revision || null,
      locator: { filePath: item.path, offset: 0, line: 1, column: 1 },
    }));
    return Array.isArray(contextManifest.chips) ? contextManifest.chips : [];
  }

  function bindResponseContext(message, chips) {
    if (!message || !chips?.length) return;
    const row = document.createElement('div');
    row.className = 'chat-response-context';
    row.setAttribute('aria-label', '该回复实际使用的上下文');
    for (const chip of chips) {
      const tag = document.createElement('button');
      tag.className = 'context-chip';
      chatContextState.bindChipButton(tag, chip, value => window.__workspace?.revealContextChip?.(value));
      row.appendChild(tag);
    }
    message.appendChild(row);
  }

  function markChatRequestCanceled(messageNode, reason = '项目、文件或选段已变化') {
    if (!messageNode || messageNode.dataset.requestCanceled === 'true') return;
    messageNode.dataset.requestCanceled = 'true';
    const note = document.createElement('span');
    note.className = 'chat-request-canceled';
    note.setAttribute('role', 'status');
    note.textContent = ` · 请求已取消（${reason}），可重试`;
    messageNode.appendChild(note);
  }

  function currentChatInteraction() {
    return {
      scope: chatScope,
      currentFilePath: window.__workspace?.getCurrentPath?.() || null,
      selection: chatScope === 'selection' ? cachedEditorSelection : null,
    };
  }

  function isChatRequestCurrent(requestToken, chatGuard, projectRequest) {
    if (requestToken !== chatRequestSequence) return false;
    if (!projectRequest) return true;
    return Boolean(window.__workspace?.isChatRequestCurrent?.(chatGuard, currentChatInteraction()));
  }

  async function doChat(userMessage) {
    // Allocate before the first await: a later submit immediately supersedes
    // this request even while saving or resolving its preflight context.
    const requestToken = ++chatRequestSequence;
    window.__workspace?.supersedeChatRequest?.(requestToken);
    clearPreflightContextChips();
    if (window.__workspace?.state?.project && !window.__workspace?.canUseAI?.()) {
      appendChatMsg('ai', '项目 Prompt 缺失或当前文件存在磁盘冲突。请先恢复 edit.md 或处理冲突，再继续对话。', false);
      return;
    }
    if (!window.writCraft || !window.writCraft.chat) {
      appendChatMsg('ai', '对话服务未连接', false);
      return;
    }
    let contextRequest = null;
    let chatIntent = null;
    if (window.__workspace?.state?.project) {
      try {
        // Freeze the original A intent before persistence or watcher settling
        // can yield. This exact request is the only one allowed to reach Main.
        contextRequest = chatContextState.createRequest({
          scope: chatScope,
          message: userMessage,
          currentFilePath: window.__workspace.getCurrentPath?.(),
          selection: chatScope === 'selection' ? cachedEditorSelection : null,
          contextPolicy: window.__contextInspectorView?.getRequestPolicy?.() || { excludedChipIds: [] },
        });
        chatIntent = window.__workspace?.captureChatRequestIntent?.(requestToken, contextRequest) || null;
        if (!chatIntent) throw new Error('当前对话意图无法冻结');
      } catch (error) {
        appendChatMsg('ai', `上下文请求已停止：${error.message}`, false);
        return;
      }
    }
    const userMessageNode = appendChatMsg('user', userMessage, false);
    const stopIfStale = () => {
      if (isChatRequestCurrent(requestToken, chatGuard, Boolean(contextRequest))) return false;
      clearPreflightContextChips(requestToken);
      markChatRequestCanceled(userMessageNode);
      return true;
    };
    let aiGuard = null;
    let chatGuard = null;
    if (contextRequest) {
      const prepared = await prepareChatRequestGuard(chatIntent);
      if (!prepared?.ok) {
        markChatRequestCanceled(userMessageNode,
          prepared?.reason === 'CHAT_SAVE_FAILED' ? '当前文件未能安全保存' : '项目、文件或选段在保存期间已变化');
        return;
      }
      aiGuard = prepared.aiGuard;
      chatGuard = window.__workspace?.beginChatRequest?.(requestToken, aiGuard, contextRequest) || null;
      if (!chatGuard || !isChatRequestCurrent(requestToken, chatGuard, true)) {
        markChatRequestCanceled(userMessageNode, '项目、文件或选段在请求建立时已变化');
        return;
      }
    } else {
      aiGuard = await prepareAIRequestGuard();
      if (requestToken !== chatRequestSequence) {
        markChatRequestCanceled(userMessageNode, '已有更新的对话请求');
        return;
      }
      if (aiGuard === false) {
        markChatRequestCanceled(userMessageNode, '当前文件未能安全保存');
        return;
      }
    }
    const selectedContext = contextRequest
      ? await window.__workspace?.resolveContextSelections?.(contextRequest, chatGuard)
      : null;
    if (stopIfStale()) return;
    if (contextRequest && !selectedContext?.ok) {
      appendChatMsg('ai', `上下文无法由 Main 验证：${selectedContext?.message || selectedContext?.error || '未知错误'}`, false);
      return;
    }
    renderContextChips(selectedContext?.chips || [], {
      requestToken,
      phase: 'preflight',
      chatGuard,
    });
    if (selectedContext?.errors?.length) {
      appendChatMsg('ai', `有 ${selectedContext.errors.length} 个上下文引用未能解析：${selectedContext.errors.map(item => item.message).join('；')}`, false);
    }
    const projectContext = window.__workspace && window.__workspace.getAIContext
      ? window.__workspace.getAIContext()
      : '';
    // In a project, Main reads the saved edit.md authority itself. Sending the
    // renderer cache again would duplicate the project prompt and make the
    // displayed manifest diverge from the actual request.
    const standaloneDocumentContext = cachedEditorSelection
      ? `[用户选中的段落]\n${cachedEditorSelection.text}`
      : `[用户当前全文]\n${getStableText().slice(0, 12000)}`;
    const context = window.__workspace?.state?.project
      ? ''
      : [projectContext, standaloneDocumentContext].filter(Boolean).join('\n\n');
    // A stale preflight must never advance to the model call. This is the
    // boundary that prevents a slow older request from spending tokens after
    // a newer request or same-project file/selection switch supersedes it.
    if (stopIfStale()) return;
    let result;
    try {
      result = await window.writCraft.chat(aiGuard?.projectInstanceId || null, userMessage, context, contextRequest);
    } catch (error) {
      if (stopIfStale()) return;
      clearPreflightContextChips(requestToken);
      appendChatMsg('ai', '对话服务中断：' + error.message, false);
      return;
    }
    // Inspector, composer chips and the answer are one publication unit. Old
    // responses are discarded without mutating any of those shared surfaces.
    if (stopIfStale()) return;
    // Main advances its project/context generation before the debounced
    // filesystem event reaches Renderer. Treat that authoritative verdict as
    // cancellation even if the local guard has not observed the event yet.
    if (chatContextState.isAuthoritativeCancellation?.(result)) {
      clearPreflightContextChips(requestToken);
      markChatRequestCanceled(userMessageNode, '项目上下文已变化');
      return;
    }
    if (!result.ok) {
      clearPreflightContextChips(requestToken);
      appendChatMsg('ai', '调用失败：' + result.error, false);
    }
    else {
      window.__contextInspectorView?.update?.(result.contextManifest, result.contextManifest?.errors || []);
      // Preflight chips are only a composer preview. Once Main responds, its
      // manifest is the sole authority for what actually reached the model.
      const actualChips = manifestChips(result.contextManifest);
      renderContextChips(actualChips, { requestToken, phase: 'actual' });
      const response = appendChatMsg('ai', result.text, true);
      bindResponseContext(response, actualChips);
    }
  }

  EDITOR_EL.contentEditable = 'true';
  EDITOR_EL.setAttribute('data-placeholder', '在这里书写你的故事…');
  EDITOR_EL.spellcheck = false;
  restoreDraft();
  EDITOR_EL.addEventListener('input', () => {
    if (pendingRewrite && !pendingRewrite.locked) void rejectRewrite(false);
    updateCount();
    scheduleSave();
    // workspace.js advances editVersion in its own listener for this event.
    // Clear only after every synchronous input listener has observed the edit.
    queueMicrotask(clearStalePreflightContextChips);
  });
  EDITOR_EL.addEventListener('paste', event => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  EDITOR_EL.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      document.execCommand('bold');
    }
  });

  document.addEventListener('selectionchange', () => {
    // Chromium may deliver the event for the selection that launched Cmd-K
    // only after persistCurrent's first await. Do not invalidate that exact
    // frozen Range; any different Range still advances the epoch permanently.
    const selected = getEditorSelection();
    const delayedLaunchSelection = Boolean(activeRewrite?.frozen && !pendingRewrite &&
      selectionEpoch === activeRewrite.frozen.selectionEpoch && selected?.range &&
      rangeIdentityFor(selected.range) === activeRewrite.frozen.selection.rangeIdentity);
    if (!delayedLaunchSelection) selectionEpoch += 1;
    if (pendingRewrite && !pendingRewrite.locked) {
      if (ignoreNextRewriteSelectionChange) ignoreNextRewriteSelectionChange = false;
      else void rejectRewrite(false);
    }
    rememberEditorCaret();
    const capturedSelection = captureEditorSelection(selected);
    if (capturedSelection) {
      cachedEditorSelection = capturedSelection;
      // The selection scope button is disabled after each document load. A
      // newly captured selection must refresh all scope controls even while
      // the active scope is still file/project, otherwise the user cannot
      // switch into selection scope.
      updateChatContextLabel();
      if (chatScope === 'selection') clearStalePreflightContextChips();
    } else {
      const nativeSelection = window.getSelection();
      const activeElement = document.activeElement;
      const explicitlyCollapsedInEditor = Boolean(nativeSelection?.isCollapsed &&
        nativeSelection.rangeCount > 0 &&
        EDITOR_EL.contains(nativeSelection.anchorNode) &&
        (activeElement === EDITOR_EL || EDITOR_EL.contains(activeElement)));
      if (explicitlyCollapsedInEditor && cachedEditorSelection) {
        cachedEditorSelection = null;
        if (chatScope === 'selection') chatScope = 'file';
        updateChatContextLabel();
        clearStalePreflightContextChips();
      }
    }
  });

  document.addEventListener('writcraft:chat-context-invalidated', clearStalePreflightContextChips);

  document.addEventListener('click', event => {
    const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
    if (anchor) event.preventDefault();
  });

  document.addEventListener('keydown', event => {
    const meta = event.metaKey || event.ctrlKey;
    const inChat = CHAT_PANEL.contains(event.target);
    if (inChat) {
      if (event.key === 'Escape') {
        event.preventDefault();
        hideChat();
      }
      return;
    }
    if (pendingRewrite && !pendingRewrite.locked && event.key === 'Tab') {
      event.preventDefault();
      void acceptRewrite();
      return;
    }
    if (pendingRewrite && !pendingRewrite.locked && event.key === 'Escape') {
      event.preventDefault();
      void rejectRewrite();
      return;
    }
    if (pendingRewrite && !pendingRewrite.locked && event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      void regenerateRewrite();
      return;
    }
    if (meta && event.key.toLowerCase() === 'k' && !event.shiftKey) {
      event.preventDefault();
      beginRewrite();
      return;
    }
    if (meta && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      if (CHAT_PANEL.style.display === 'flex') hideChat();
      else showChat();
      return;
    }
    if (event.key === 'Escape') hideChat();
  });

  CHAT_CLOSE.addEventListener('click', hideChat);
  for (const button of CHAT_SCOPE_BUTTONS) {
    button.addEventListener('click', () => setChatScope(button.dataset.chatScope));
  }
  CHAT_SUBMIT.addEventListener('click', () => {
    const value = CHAT_INPUT.value.trim();
    if (!value) return;
    CHAT_INPUT.value = '';
    doChat(value);
  });
  CHAT_INPUT.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      CHAT_SUBMIT.click();
    }
  });

  window.addEventListener('beforeunload', () => {
    const destroyed = rewriteOwner?.destroy?.();
    const previous = destroyed?.previous;
    if (destroyed?.discardAllowed && previous && activeRewrite?.intent?.projectInstanceId) {
      void safeDiscard(activeRewrite.intent.projectInstanceId, {
        schema: 'writcraft.inline-rewrite-discard/v1',
        rewriteId: previous.rewriteId,
        capabilityId: previous.capabilityId,
      });
    }
    saveDraftNow();
  });

  setStatus('✅ 编辑器就绪 · 自动保存已开启');
  updateCount();
  EDITOR_EL.focus();
  window.__editorEl = EDITOR_EL;
  window.__editor = {
    el: EDITOR_EL,
    triggerRewrite: beginRewrite,
    acceptRewrite,
    rejectRewrite,
    regenerateRewrite,
    triggerChat: showChat,
    saveDraftNow,
    getContent: getStableText,
    insertCitation,
    insertMarkdown,
    setProjectManaged(value) {
      projectManaged = Boolean(value);
      clearTimeout(saveTimer);
    },
    loadDocument(content) {
      cancelActiveRewriteForDocumentLoad();
      projectManaged = true;
      cachedEditorSelection = null;
      chatScope = 'file';
      lastCaretOffset = 0;
      lastCaretRange = null;
      renderContextChips([]);
      EDITOR_EL.textContent = typeof content === 'string' ? content : '';
      updateCount();
      updateChatContextLabel();
      EDITOR_EL.focus();
    },
  };
})();
