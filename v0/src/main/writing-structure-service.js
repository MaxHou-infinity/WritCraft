'use strict';

const crypto = require('crypto');
const path = require('path');
const {
  LIMITS,
  WritingNavigationError,
  rawText,
} = require('./writing-navigation-service');

const PREVIEW_SCHEMA = 'writcraft.writing-structure-preview/v1';
const PREPARED_SCHEMA = 'writcraft.writing-structure-prepared/v1';
const REVISION_RE = /^[a-f0-9]{64}$/;
const NAVIGATION_ID_RE = /^nav_[a-f0-9]{32}$/;
const ALTERNATIVE_ID_RE = /^alternative_[1-3]$/;
const PROJECT_INSTANCE_ID_RE = /^instance_[a-f0-9]{24}$/;
const AUTHENTIC_PREPARED_RECORDS = new WeakSet();

class WritingStructureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WritingStructureError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WritingStructureError(code, message);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) fail('INVALID_STRUCTURE_CONFIRMATION', '结构确认请求无效');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_STRUCTURE_CONFIRMATION', '结构确认请求包含未知字段或缺少必填字段');
  }
}

function ownerId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) {
    fail('INVALID_OWNER', '结构确认 owner 无效');
  }
  return value;
}

function projectInstanceId(value) {
  if (typeof value !== 'string' || !PROJECT_INSTANCE_ID_RE.test(value)) {
    fail('INVALID_PROJECT', '项目实例标识无效');
  }
  return value;
}

function rootPath(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_ROOT', '项目根目录无效');
  }
  return path.resolve(value);
}

function generation(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_STRUCTURE_CONFIRMATION', `${label}无效`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) {
    fail('INVALID_STRUCTURE_CONFIRMATION', `${label}无效`);
  }
  return value;
}

function navigationId(value) {
  if (typeof value !== 'string' || !NAVIGATION_ID_RE.test(value)) {
    fail('INVALID_NAVIGATION_ID', '写作导航标识无效');
  }
  return value;
}

function alternativeId(value) {
  if (typeof value !== 'string' || !ALTERNATIVE_ID_RE.test(value)) {
    fail('INVALID_ALTERNATIVE', '结构方案标识无效');
  }
  return value;
}

function validateAuthorText(value, label, maxChars, options = {}) {
  try {
    return rawText(value, label, maxChars, {
      ...options,
      code: 'INVALID_STRUCTURE_CONFIRMATION',
    });
  } catch (error) {
    if (error instanceof WritingNavigationError) {
      fail('INVALID_STRUCTURE_CONFIRMATION', error.message);
    }
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeStructureProposalDigest(files) {
  const hash = crypto.createHash('sha256');
  hash.update(`${PREVIEW_SCHEMA}\0`, 'utf8');
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, 'utf8');
    const contentBytes = Buffer.from(file.content, 'utf8');
    hash.update(String(pathBytes.length), 'ascii');
    hash.update(':', 'ascii');
    hash.update(pathBytes);
    hash.update(String(contentBytes.length), 'ascii');
    hash.update(':', 'ascii');
    hash.update(contentBytes);
  }
  return hash.digest('hex');
}

function prepareWritingStructure({
  navigationStore,
  ownerId: rawOwnerId,
  projectInstanceId: rawProjectInstanceId,
  rootPath: rawRootPath,
  mutationGeneration: rawMutationGeneration,
  navigationEpoch: rawNavigationEpoch,
  navigationId: rawNavigationId,
  alternativeId: rawAlternativeId,
  emptyTreeDigest: rawEmptyTreeDigest,
  chapters: rawChapters,
}) {
  if (!navigationStore || typeof navigationStore.get !== 'function') {
    fail('INVALID_NAVIGATION_STORE', '写作导航结果存储不可用');
  }
  const binding = Object.freeze({
    ownerId: ownerId(rawOwnerId),
    projectInstanceId: projectInstanceId(rawProjectInstanceId),
    rootPath: rootPath(rawRootPath),
    mutationGeneration: generation(rawMutationGeneration, '项目修改世代'),
    navigationEpoch: generation(rawNavigationEpoch, '写作导航世代'),
  });
  const selectedNavigationId = navigationId(rawNavigationId);
  const selectedAlternativeId = alternativeId(rawAlternativeId);
  const emptyTreeDigest = digest(rawEmptyTreeDigest, '空项目树摘要');
  const result = navigationStore.get({
    ...binding,
    navigationId: selectedNavigationId,
  });
  if (!isPlainObject(result) || result.mode !== 'structure' ||
      result.navigationId !== selectedNavigationId || !Array.isArray(result.alternatives)) {
    fail('INVALID_NAVIGATION_RESULT', '写作导航结果不是可确认的结构方案');
  }
  const selected = result.alternatives.find(
    alternative => alternative?.alternativeId === selectedAlternativeId
  );
  if (!selected || !Array.isArray(selected.chapters)) {
    fail('ALTERNATIVE_NOT_FOUND', '所选结构方案已不存在');
  }
  if (!Array.isArray(rawChapters) || rawChapters.length !== selected.chapters.length ||
      rawChapters.length < 1 || rawChapters.length > 8) {
    fail('CHAPTER_COUNT_MISMATCH', '章节数量必须与所选结构方案一致');
  }
  const files = Object.freeze(rawChapters.map((chapter, index) => {
    exactKeys(chapter, ['title', 'purpose']);
    const title = validateAuthorText(chapter.title, '章节标题', LIMITS.title);
    const purpose = validateAuthorText(chapter.purpose, '写作目的', LIMITS.purpose, {
      forbidDoubleHyphen: true,
    });
    const relativePath = `chapters/${String(index + 1).padStart(2, '0')}.md`;
    const content = `# ${title}\n\n<!-- 写作目的：${purpose} -->\n`;
    return Object.freeze({
      path: relativePath,
      title,
      purpose,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256(Buffer.from(content, 'utf8')),
    });
  }));
  const proposalDigest = computeStructureProposalDigest(files);
  const editFile = result.contextManifest?.files?.find(file => file?.path === 'edit.md');
  const editRevision = digest(editFile?.revision, 'edit.md 修订');
  const preview = Object.freeze({
    schema: PREVIEW_SCHEMA,
    navigationId: selectedNavigationId,
    alternativeId: selectedAlternativeId,
    chapterCount: files.length,
    createsProse: false,
    disclosure: '只创建章节标题与写作目的注释，不会生成正文。',
    files,
    proposalDigest,
  });
  const prepared = Object.freeze({
    schema: PREPARED_SCHEMA,
    ...binding,
    navigationId: selectedNavigationId,
    alternativeId: selectedAlternativeId,
    editRevision,
    emptyTreeDigest,
    proposalDigest,
    files,
    preview,
  });
  AUTHENTIC_PREPARED_RECORDS.add(prepared);
  return Object.freeze({ preview, prepared });
}

function isAuthenticWritingStructurePreparedRecord(value) {
  return Boolean(value && AUTHENTIC_PREPARED_RECORDS.has(value));
}

module.exports = Object.freeze({
  PREVIEW_SCHEMA,
  PREPARED_SCHEMA,
  WritingStructureError,
  computeStructureProposalDigest,
  prepareWritingStructure,
  isAuthenticWritingStructurePreparedRecord,
});
