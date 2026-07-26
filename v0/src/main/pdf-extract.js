'use strict';

// WritCraft · Node 内自包含 PDF 提取（pdfjs-dist legacy build）
// 替代外部 python3 + pypdf/pdfplumber，使发布包在干净 Mac 上可用。
// 约束：无网络、无 worker 线程文件依赖（disableWorker）、有页数/字符/超时边界。

const MAX_METADATA_CHARS = 500;

let pdfjsModulePromise = null;

function timeoutError(label) {
  const error = new Error(`PDF extraction timed out during ${label}`);
  error.code = 'PDF_TIMEOUT';
  return error;
}

function withDeadline(promise, deadline, label, onTimeout) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError(label));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { onTimeout?.(); } catch (_) {}
      reject(timeoutError(label));
    }, remaining);
    Promise.resolve(promise).then(value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function loadPdfjs() {
  if (!pdfjsModulePromise) {
    // legacy build 兼容 Node（无 DOM）；ESM-only 所以用动态 import。
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModulePromise;
}

function cleanMetadata(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\x00/g, '').trim().slice(0, MAX_METADATA_CHARS);
  return text || null;
}

async function extractPdf(sourcePath, { maxPages, maxChars, timeoutMs }) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error('invalid maxPages');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('invalid maxChars');
  const deadline = Date.now() + (Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000);
  const checkDeadline = label => {
    if (Date.now() >= deadline) throw timeoutError(label);
  };

  const fs = require('fs');
  const path = require('path');
  const data = new Uint8Array(await fs.promises.readFile(sourcePath));
  const pdfjs = await withDeadline(loadPdfjs(), deadline, 'runtime loading');
  checkDeadline('document loading');

  // 指向随包分发的标准字体目录（消除 standardFontDataUrl 警告；纯本地，无网络）。
  const fontsDirectory = path.join(require.resolve('pdfjs-dist/package.json'), '..', 'standard_fonts');
  const loadingTask = pdfjs.getDocument({
    data,
    // 自包含边界：不加载外部 cmap/wasm，不联网，不用 worker 文件。
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    stopAtErrors: true,
    standardFontDataUrl: `${fontsDirectory}${path.sep}`,
  });

  let document;
  try {
    document = await withDeadline(loadingTask.promise, deadline, 'document loading', () => loadingTask.destroy());
  } catch (error) {
    if (error && error.code === 'PDF_TIMEOUT') throw error;
    const message = String(error && error.name === 'PasswordException'
      ? 'encrypted PDFs are not supported'
      : (error && error.message) || 'PDF parse failed');
    const wrapped = new Error(message.slice(0, 500));
    wrapped.cause = undefined; // 不携带内部对象
    throw wrapped;
  }

  try {
    checkDeadline('page inventory');
    const pageCount = document.numPages;
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF has no pages');
    if (pageCount > maxPages) throw new Error(`PDF page limit exceeded: ${pageCount}`);

    let title = null;
    let author = null;
    try {
      const meta = await withDeadline(document.getMetadata(), deadline, 'metadata', () => document.destroy());
      const info = (meta && meta.info) || {};
      title = cleanMetadata(info.Title);
      author = cleanMetadata(info.Author);
    } catch (error) {
      if (error && error.code === 'PDF_TIMEOUT') throw error;
      /* 元数据缺失不致命 */
    }

    const pages = [];
    let total = 0;
    for (let number = 1; number <= pageCount; number += 1) {
      checkDeadline(`page ${number}`);
      const page = await withDeadline(document.getPage(number), deadline, `page ${number}`, () => document.destroy());
      let text = '';
      try {
        const content = await withDeadline(page.getTextContent(), deadline, `page ${number} text`, () => document.destroy());
        text = content.items
          .map(item => (typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+\n/g, '\n');
      } finally {
        page.cleanup();
      }
      total += text.length;
      if (total > maxChars) throw new Error('PDF text limit exceeded');
      pages.push({ page: number, text });
    }

    return { pageCount, title, author, pages };
  } finally {
    try { await document.destroy(); } catch (_) {}
  }
}

module.exports = { extractPdf, withDeadline };
