// Project-wide filename and Markdown body search.
(function () {
  const bridge = window.writCraft?.project;
  const input = document.getElementById('project-search-input');
  const results = document.getElementById('project-search-results');
  const status = document.getElementById('project-search-status');
  const button = document.querySelector('[data-view="search"]');
  let timer = null;
  let requestId = 0;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.style.color = error ? '#a3473e' : '';
  }

  function empty(text) {
    results.replaceChildren();
    const message = document.createElement('div');
    message.className = 'tree-empty';
    message.textContent = text;
    results.appendChild(message);
  }

  function excerptNode(result) {
    const line = document.createElement('div');
    line.className = 'search-result-excerpt';
    const text = String(result.excerpt || '');
    const start = Math.max(0, Math.min(text.length, Number(result.matchStart) || 0));
    const end = Math.max(start, Math.min(text.length, Number(result.matchEnd) || start));
    line.append(document.createTextNode(text.slice(0, start)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    line.append(mark, document.createTextNode(text.slice(end)));
    return line;
  }

  function render(response) {
    results.replaceChildren();
    for (const item of response.results || []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'search-result';
      const heading = document.createElement('div');
      heading.className = 'search-result-path';
      const name = document.createElement('strong');
      name.textContent = item.path;
      const location = document.createElement('span');
      location.textContent = item.target === 'filename' ? '文件名' : `L${item.line}:${item.column}`;
      heading.append(name, location);
      row.append(heading, excerptNode(item));
      row.addEventListener('click', async () => {
        const opened = await window.__workspace?.openFile?.(item.path);
        if (opened !== false && item.target === 'content') {
          window.__workspace?.revealRange?.(item.offset, item.length);
        }
      });
      results.appendChild(row);
    }
    if (!response.results?.length) empty('没有找到匹配内容。');
    const stats = response.stats || {};
    const suffix = stats.truncated ? ' · 已按性能上限截断' : '';
    setStatus(`${stats.resultCount || 0} 个结果 · 扫描 ${stats.filesScanned || 0} 个文件${suffix}`);
  }

  async function searchNow() {
    clearTimeout(timer);
    const query = input.value.trim();
    if (!query) {
      requestId += 1;
      empty('搜索结果会显示文件、行号和上下文证据。');
      setStatus('输入关键词，在全部 Markdown 中查找。');
      return;
    }
    if (!window.__workspace?.state?.project) {
      empty('请先创建或打开一个项目。');
      setStatus('没有打开的项目', true);
      return;
    }
    const current = ++requestId;
    setStatus('正在搜索…');
    let response;
    try { response = await bridge.search(query); }
    catch (error) { response = { ok: false, message: error.message }; }
    if (current !== requestId) return;
    if (!response?.ok) {
      empty('搜索失败，正文没有被修改。');
      setStatus(response?.message || response?.error || '搜索失败', true);
      return;
    }
    render(response);
  }

  function openSearch() {
    window.__workspace?.setSidebarView?.('search');
    input.focus();
    if (input.value.trim()) searchNow();
  }

  button?.addEventListener('click', openSearch);
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(searchNow, 180);
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      openSearch();
    }
  });
})();
