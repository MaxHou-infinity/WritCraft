// WritCraft context selection/parser (UMD, pure and DOM-free).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftContext = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PATH_LENGTH = 512;
  const MAX_MENTIONS = 20;
  const MAX_MESSAGE_CHARS = 4000;
  const MAX_EXCERPT_LENGTH = 12000;
  const MAX_FOLDER_FILES = 12;
  const MAX_ENTITY_EVIDENCE = 6;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function normalizeMarkdownPath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      fail('INVALID_PATH', '文件路径无效');
    }
    const clean = value.trim();
    if (clean.length > MAX_PATH_LENGTH) fail('PATH_TOO_LONG', '文件路径过长');
    if (clean.startsWith('/') || clean.startsWith('\\') || /^[A-Za-z]:/.test(clean) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clean)) {
      fail('ABSOLUTE_PATH', '只允许项目内相对路径');
    }
    if (clean.includes('\\')) fail('INVALID_SEPARATOR', '文件路径必须使用 /');
    const parts = clean.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) {
      fail('PATH_TRAVERSAL', '路径不能包含空段、. 或 ..');
    }
    if (parts.some(part => part.startsWith('.'))) fail('PRIVATE_PATH', '不能引用隐藏或内部文件');
    if (!/\.(?:md|markdown)$/i.test(parts.at(-1))) fail('INVALID_EXTENSION', '只能引用 Markdown 文件');
    return parts.join('/');
  }

  function normalizeFolderPath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('INVALID_FOLDER', '文件夹路径无效');
    const clean = value.trim().replace(/\/$/, '');
    if (clean.length > MAX_PATH_LENGTH) fail('PATH_TOO_LONG', '文件夹路径过长');
    if (clean.startsWith('/') || clean.startsWith('\\') || /^[A-Za-z]:/.test(clean) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(clean)) {
      fail('ABSOLUTE_PATH', '只允许项目内相对文件夹');
    }
    if (clean.includes('\\')) fail('INVALID_SEPARATOR', '文件夹路径必须使用 /');
    const parts = clean.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) fail('PATH_TRAVERSAL', '文件夹路径不能包含空段、. 或 ..');
    if (parts.some(part => part.startsWith('.'))) fail('PRIVATE_PATH', '不能引用隐藏或内部文件夹');
    return parts.join('/');
  }

  function hash32(value, seed) {
    let hash = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function stableId(prefix, value) {
    return `${prefix}_${hash32(value, 2166136261)}${hash32(value, 3339675911)}`;
  }

  function normalizedHeading(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function lineColumn(content, offset) {
    const safe = Math.max(0, Math.min(Number(offset) || 0, content.length));
    const before = content.slice(0, safe);
    const lastBreak = before.lastIndexOf('\n');
    return { line: before.split('\n').length, column: safe - lastBreak };
  }

  function excerpt(content, start, end) {
    const text = content.slice(start, end);
    return {
      text: text.slice(0, MAX_EXCERPT_LENGTH),
      truncated: text.length > MAX_EXCERPT_LENGTH,
    };
  }

  function parseMarkdownSections(content, filePath) {
    if (typeof content !== 'string') fail('INVALID_CONTENT', 'Markdown 内容必须是文本');
    const safePath = normalizeMarkdownPath(filePath);
    const lines = [];
    let offset = 0;
    for (const raw of content.split(/(?<=\n)/)) {
      const text = raw.replace(/\r?\n$/, '');
      lines.push({ text, start: offset, end: offset + raw.length });
      offset += raw.length;
    }
    if (!lines.length) lines.push({ text: '', start: 0, end: 0 });

    const headings = [];
    let fence = null;
    let frontMatter = lines[0]?.text.trim() === '---';
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (frontMatter) {
        if (index > 0 && (line.text.trim() === '---' || line.text.trim() === '...')) frontMatter = false;
        continue;
      }
      const fenceMatch = line.text.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence) continue;
      const atx = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (atx) {
        headings.push({ heading: atx[2], level: atx[1].length, startOffset: line.start, contentStart: line.end, line: index + 1 });
        continue;
      }
      const next = lines[index + 1];
      if (line.text.trim() && next) {
        const setext = next.text.match(/^\s{0,3}(=+|-+)\s*$/);
        if (setext) {
          headings.push({ heading: line.text.trim(), level: setext[1][0] === '=' ? 1 : 2, startOffset: line.start, contentStart: next.end, line: index + 1 });
          index += 1;
        }
      }
    }

    const occurrences = new Map();
    return headings.map((heading, index) => {
      const key = normalizedHeading(heading.heading);
      const occurrence = (occurrences.get(key) || 0) + 1;
      occurrences.set(key, occurrence);
      let endOffset = content.length;
      for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
        if (headings[cursor].level <= heading.level) {
          endOffset = headings[cursor].startOffset;
          break;
        }
      }
      const selected = excerpt(content, heading.startOffset, endOffset);
      return {
        id: stableId('sec', `${safePath}\n${key}\n${occurrence}`),
        filePath: safePath,
        heading: heading.heading,
        normalizedHeading: key,
        level: heading.level,
        occurrence,
        startOffset: heading.startOffset,
        contentStart: heading.contentStart,
        endOffset,
        line: heading.line,
        column: 1,
        contentFingerprint: stableId('txt', content.slice(heading.startOffset, endOffset)),
        excerpt: selected.text,
        truncated: selected.truncated,
      };
    });
  }

  function fileName(filePath) {
    return filePath.split('/').at(-1) || filePath;
  }

  function makeFileChip(filePath, revision) {
    return {
      id: stableId('ctx_file', filePath),
      type: 'file',
      label: fileName(filePath),
      filePath,
      revision: typeof revision === 'string' ? revision : null,
      locator: { filePath, offset: 0, endOffset: 0, line: 1, column: 1 },
    };
  }

  function chapterAlias(filePath) {
    return fileName(filePath).replace(/\.(?:md|markdown)$/i, '').trim().toLocaleLowerCase();
  }

  function chooseUnique(value, items, keys) {
    const wanted = normalizedHeading(value);
    const matches = items.filter(item => keys(item).some(key => normalizedHeading(key) === wanted));
    return { item: matches.length === 1 ? matches[0] : null, count: matches.length };
  }

  function makeChapterChip(filePath, revision) {
    return {
      ...makeFileChip(filePath, revision),
      id: stableId('ctx_chapter', filePath),
      type: 'chapter',
      label: chapterAlias(filePath) || fileName(filePath),
    };
  }

  function makeFolderChip(folderPath, filePaths, total) {
    const omitted = Math.max(0, total - filePaths.length);
    return {
      id: stableId('ctx_folder', folderPath),
      type: 'folder',
      label: folderPath,
      folderPath,
      filePaths,
      locator: { folderPath },
      truncated: omitted > 0,
      truncationReason: omitted > 0 ? `文件夹内共 ${total} 个 Markdown，本次最多纳入 ${MAX_FOLDER_FILES} 个` : null,
      omittedCount: omitted,
    };
  }

  function makeSourceChip(source) {
    const filePath = source.filePath ? normalizeMarkdownPath(source.filePath) : null;
    return {
      id: stableId('ctx_source', String(source.id || filePath || source.title)),
      type: 'source',
      label: String(source.title || source.label || fileName(filePath || '') || source.id),
      sourceId: source.id || null,
      filePath,
      revision: typeof source.revision === 'string' ? source.revision : null,
      locator: source.locator || (filePath ? { filePath, offset: 0, line: 1, column: 1 } : null),
      evidence: Array.isArray(source.evidence) ? source.evidence.slice(0, MAX_ENTITY_EVIDENCE) : [],
      truncated: Boolean(source.truncated),
      truncationReason: source.truncationReason || null,
    };
  }

  function makeEntityChip(entity, evidenceById) {
    const ids = Array.isArray(entity.evidenceIds) ? entity.evidenceIds : [];
    const evidence = ids.map(id => getValue(evidenceById, id)).filter(Boolean).slice(0, MAX_ENTITY_EVIDENCE);
    const omitted = Math.max(0, ids.length - evidence.length);
    return {
      id: stableId('ctx_entity', String(entity.id)),
      type: 'entity',
      label: String(entity.label || entity.name || entity.id),
      entityId: entity.id,
      filePath: evidence[0]?.path || evidence[0]?.filePath || null,
      evidence,
      locator: evidence[0] || null,
      truncated: omitted > 0,
      truncationReason: omitted > 0 ? `该实体共 ${ids.length} 条证据，本次最多展示 ${MAX_ENTITY_EVIDENCE} 条` : null,
      omittedCount: omitted,
    };
  }

  function makeSectionChip(section, revision) {
    return {
      id: stableId('ctx_section', section.id),
      type: 'section',
      label: section.heading,
      filePath: section.filePath,
      revision: typeof revision === 'string' ? revision : null,
      locator: {
        sectionId: section.id,
        filePath: section.filePath,
        heading: section.heading,
        occurrence: section.occurrence,
        offset: section.startOffset,
        contentStart: section.contentStart,
        endOffset: section.endOffset,
        line: section.line,
        column: section.column,
        contentFingerprint: section.contentFingerprint,
      },
      excerpt: section.excerpt,
      truncated: section.truncated,
    };
  }

  function buildSelectionChip(selection, options = {}) {
    if (!selection || typeof selection.text !== 'string' || !selection.text.trim()) return null;
    const filePath = normalizeMarkdownPath(selection.filePath || options.currentFilePath);
    const content = typeof options.currentContent === 'string' ? options.currentContent : '';
    let start = Number.isInteger(selection.startOffset) ? selection.startOffset : -1;
    if (start < 0 && content) {
      start = content.indexOf(selection.text);
      if (start < 0) fail('SELECTION_NOT_FOUND', '选段已不在当前文件中');
      if (content.indexOf(selection.text, start + 1) !== -1) {
        fail('AMBIGUOUS_SELECTION', '选段文本重复出现，需要精确 offset');
      }
    }
    if (start < 0) fail('SELECTION_OFFSET_REQUIRED', '缺少当前选段的 offset');
    const end = Number.isInteger(selection.endOffset) ? selection.endOffset : start + selection.text.length;
    if (start > end || start < 0 || (content && end > content.length)) fail('INVALID_SELECTION', '选段范围无效');
    if (content && content.slice(start, end) !== selection.text) {
      fail('SELECTION_STALE', '当前选段与文件内容已不一致');
    }
    const position = lineColumn(content || selection.text, content ? start : 0);
    const selected = excerpt(selection.text, 0, selection.text.length);
    const fingerprint = stableId('txt', selection.text);
    return {
      id: stableId('ctx_selection', `${filePath}\n${start}\n${end}\n${fingerprint}`),
      type: 'selection',
      label: '当前选段',
      filePath,
      revision: typeof options.currentRevision === 'string' ? options.currentRevision : null,
      locator: { filePath, offset: start, endOffset: end, line: position.line, column: position.column, contentFingerprint: fingerprint },
      excerpt: selected.text,
      truncated: selected.truncated,
    };
  }

  function readQuotedOrBare(match, indexes) {
    for (const index of indexes) if (match[index] !== undefined) return match[index].trim();
    return '';
  }

  function tokenizeMentions(message) {
    const mentions = [];
    const specs = [
      ['file', /@file\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s@，。！？,;；]+))/giu],
      ['section', /@section(?:(?:\s*:\s*)|\s+)(?:"([^"]+)"|'([^']+)'|([^@，。！？,;；\n]+))/giu],
      ['chapter', /@chapter(?:(?:\s*:\s*)|\s+)(?:"([^"]+)"|'([^']+)'|([^\s@，。！？,;；]+))/giu],
      ['folder', /@folder(?:(?:\s*:\s*)|\s+)(?:"([^"]+)"|'([^']+)'|([^\s@，。！？,;；]+))/giu],
      ['source', /@source(?:(?:\s*:\s*)|\s+)(?:"([^"]+)"|'([^']+)'|([^\s@，。！？,;；]+))/giu],
      ['entity', /@entity(?:(?:\s*:\s*)|\s+)(?:"([^"]+)"|'([^']+)'|([^\s@，。！？,;；]+))/giu],
      ['file', /@((?:[^\s@，。！？,;；])+?\.(?:md|markdown))(?=$|[\s@，。！？,;；])/giu, true],
    ];
    for (const [kind, pattern, legacy] of specs) {
      for (const match of message.matchAll(pattern)) {
        const value = legacy ? match[1].trim() : readQuotedOrBare(match, [1, 2, 3]);
        mentions.push({ kind, value, raw: match[0], index: match.index, end: match.index + match[0].length });
      }
    }
    mentions.sort((a, b) => a.index - b.index || b.end - a.end);
    const distinct = [];
    for (const mention of mentions) {
      if (distinct.some(item => mention.index < item.end && mention.end > item.index)) continue;
      distinct.push(mention);
    }
    const limited = distinct.slice(0, MAX_MENTIONS);
    Object.defineProperty(limited, 'omittedCount', { value: Math.max(0, distinct.length - limited.length), enumerable: false });
    return limited;
  }

  function getValue(container, key) {
    if (container instanceof Map) return container.get(key);
    return container && Object.prototype.hasOwnProperty.call(container, key) ? container[key] : undefined;
  }

  function chooseSection(value, sections) {
    const wanted = normalizedHeading(value);
    let exact = sections.filter(section => section.normalizedHeading === wanted);
    if (exact.length) return { section: exact[0], ambiguous: exact.length > 1 };
    // For unquoted "@section 标题，请分析", prefer the longest real
    // heading that prefixes the token rather than swallowing the user query.
    exact = sections
      .filter(section => wanted.startsWith(`${section.normalizedHeading} `) || wanted === section.normalizedHeading)
      .sort((a, b) => b.normalizedHeading.length - a.normalizedHeading.length);
    return exact.length ? { section: exact[0], ambiguous: false } : { section: null, ambiguous: false };
  }

  function cleanQuery(message, mentions) {
    let query = message;
    for (const mention of [...mentions].sort((a, b) => b.index - a.index)) {
      query = query.slice(0, mention.index) + query.slice(mention.end);
    }
    return query.replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function parseContextSelections(message, options = {}) {
    if (typeof message !== 'string') fail('INVALID_MESSAGE', '对话内容必须是文本');
    if (message.length > MAX_MESSAGE_CHARS) {
      return {
        query: message.slice(0, MAX_MESSAGE_CHARS),
        chips: [],
        errors: [{ code: 'MESSAGE_TOO_LONG', message: `对话内容超过 ${MAX_MESSAGE_CHARS} 字符，本次只保留前部`, token: '', index: MAX_MESSAGE_CHARS, omittedCount: message.length - MAX_MESSAGE_CHARS }],
        mentions: [],
      };
    }
    const knownFilesProvided = Array.isArray(options.files);
    const knownFiles = new Set();
    for (const value of options.files || []) {
      try { knownFiles.add(normalizeMarkdownPath(typeof value === 'string' ? value : value.path)); } catch (_) {}
    }
    const revisions = options.fileRevisions || {};
    const contents = options.fileContents || {};
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const entities = Array.isArray(options.entities) ? options.entities : [];
    const evidenceById = options.evidenceById || {};
    const mentions = tokenizeMentions(message);
    const chips = [];
    const errors = [];
    if (mentions.omittedCount) {
      errors.push({ code: 'MENTION_LIMIT', message: `每次最多解析 ${MAX_MENTIONS} 个显式上下文引用`, token: '', index: -1, omittedCount: mentions.omittedCount });
    }
    let activeFile = null;
    try {
      if (options.currentFilePath) activeFile = normalizeMarkdownPath(options.currentFilePath);
    } catch (error) {
      errors.push({ code: error.code, message: error.message, token: options.currentFilePath, index: -1 });
    }

    function addChip(chip) {
      if (chip && !chips.some(existing => existing.id === chip.id)) chips.push(chip);
    }

    for (const mention of mentions) {
      if (mention.kind === 'file' || mention.kind === 'chapter') {
        try {
          let filePath;
          if (mention.kind === 'file') {
            filePath = normalizeMarkdownPath(mention.value);
            if (knownFilesProvided && !knownFiles.has(filePath)) fail('FILE_NOT_FOUND', '项目中不存在该 Markdown 文件');
          } else {
            const selected = chooseUnique(mention.value, [...knownFiles], path => [path, fileName(path), chapterAlias(path)]);
            if (selected.count > 1) fail('AMBIGUOUS_CHAPTER', '@chapter 匹配到多个文件，请使用项目相对路径');
            if (!selected.item) fail('CHAPTER_NOT_FOUND', '未找到 @chapter 指定的章节文件');
            filePath = selected.item;
          }
          activeFile = filePath;
          addChip(mention.kind === 'chapter'
            ? makeChapterChip(filePath, getValue(revisions, filePath))
            : makeFileChip(filePath, getValue(revisions, filePath)));
        } catch (error) {
          activeFile = null;
          errors.push({ code: error.code || 'INVALID_PATH', message: error.message, token: mention.raw, index: mention.index });
        }
        continue;
      }
      if (mention.kind === 'folder') {
        try {
          const folderPath = normalizeFolderPath(mention.value);
          const matches = [...knownFiles].filter(path => path.startsWith(`${folderPath}/`)).sort();
          if (!matches.length) fail('FOLDER_NOT_FOUND', '该文件夹不存在公开 Markdown 文件');
          addChip(makeFolderChip(folderPath, matches.slice(0, MAX_FOLDER_FILES), matches.length));
          if (matches.length > MAX_FOLDER_FILES) errors.push({ code: 'FOLDER_LIMIT', message: `@folder 只纳入前 ${MAX_FOLDER_FILES} 个 Markdown 文件`, token: mention.raw, index: mention.index, omittedCount: matches.length - MAX_FOLDER_FILES });
        } catch (error) {
          errors.push({ code: error.code || 'INVALID_FOLDER', message: error.message, token: mention.raw, index: mention.index });
        }
        continue;
      }
      if (mention.kind === 'source') {
        const selected = chooseUnique(mention.value, sources, source => [source.id, source.title, source.label, source.filePath].filter(Boolean));
        if (selected.count > 1) errors.push({ code: 'AMBIGUOUS_SOURCE', message: '@source 匹配多个来源，请使用来源 ID 或路径', token: mention.raw, index: mention.index });
        else if (!selected.item) errors.push({ code: 'SOURCE_NOT_FOUND', message: '未找到 @source 指定的来源', token: mention.raw, index: mention.index });
        else {
          try { addChip(makeSourceChip(selected.item)); }
          catch (error) { errors.push({ code: error.code || 'INVALID_SOURCE', message: error.message, token: mention.raw, index: mention.index }); }
        }
        continue;
      }
      if (mention.kind === 'entity') {
        const selected = chooseUnique(mention.value, entities, entity => [entity.id, entity.label, entity.name, ...(entity.aliases || [])].filter(Boolean));
        if (selected.count > 1) errors.push({ code: 'AMBIGUOUS_ENTITY', message: '@entity 匹配多个实体，请使用实体 ID', token: mention.raw, index: mention.index });
        else if (!selected.item) errors.push({ code: 'ENTITY_NOT_FOUND', message: '未找到 @entity 指定的实体', token: mention.raw, index: mention.index });
        else addChip(makeEntityChip(selected.item, evidenceById));
        continue;
      }
      if (!activeFile) {
        errors.push({ code: 'NO_SECTION_FILE', message: '@section 需要当前文件或前置 @file', token: mention.raw, index: mention.index });
        continue;
      }
      const content = getValue(contents, activeFile)
        ?? (activeFile === options.currentFilePath ? options.currentContent : undefined);
      if (typeof content !== 'string') {
        errors.push({ code: 'CONTENT_UNAVAILABLE', message: '无法读取该文件的章节信息', token: mention.raw, index: mention.index });
        continue;
      }
      try {
        const chosen = chooseSection(mention.value, parseMarkdownSections(content, activeFile));
        if (!chosen.section) fail('SECTION_NOT_FOUND', '未找到指定章节标题');
        if (normalizedHeading(mention.value) !== chosen.section.normalizedHeading) {
          const valueStart = mention.raw.lastIndexOf(mention.value);
          if (valueStart >= 0) {
            mention.end = mention.index + valueStart + chosen.section.heading.length;
            mention.raw = message.slice(mention.index, mention.end);
            mention.value = chosen.section.heading;
          }
        }
        addChip(makeSectionChip(chosen.section, getValue(revisions, activeFile)));
        if (chosen.ambiguous) {
          errors.push({ code: 'AMBIGUOUS_SECTION', message: '存在重名章节，已选择第一处', token: mention.raw, index: mention.index });
        }
      } catch (error) {
        errors.push({ code: error.code || 'SECTION_ERROR', message: error.message, token: mention.raw, index: mention.index });
      }
    }

    try {
      addChip(buildSelectionChip(options.selection, {
        currentFilePath: options.currentFilePath,
        currentContent: options.currentContent,
        currentRevision: options.currentRevision,
      }));
    } catch (error) {
      errors.push({ code: error.code || 'INVALID_SELECTION', message: error.message, token: '当前选段', index: -1 });
    }

    return {
      query: cleanQuery(message, mentions),
      chips,
      errors,
      mentions,
    };
  }

  return Object.freeze({
    MAX_MENTIONS,
    MAX_MESSAGE_CHARS,
    MAX_EXCERPT_LENGTH,
    MAX_FOLDER_FILES,
    MAX_ENTITY_EVIDENCE,
    normalizeMarkdownPath,
    normalizeFolderPath,
    tokenizeMentions,
    parseMarkdownSections,
    buildSelectionChip,
    parseContextSelections,
  });
});
