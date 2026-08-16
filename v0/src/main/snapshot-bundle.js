'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const schema = require('./evidence-delivery-schema');

const MAGIC = Buffer.from([0x57, 0x43, 0x53, 0x42, 0x01, 0x00, 0x00, 0x00]);
const FOOTER = Buffer.from([0x57, 0x43, 0x53, 0x42, 0x45, 0x4e, 0x44, 0x01]);
const MAX_ENTRIES = 500;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 520 * 1024 * 1024;
const REVISION_RE = /^[a-f0-9]{64}$/;
const MARKDOWN_RE = /\.(?:md|markdown)$/i;
const IMAGE_RE = /\.(?:png|jpe?g|gif|webp)$/i;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const SNAPSHOT_LIMITS = schema.SNAPSHOT_LIMITS;

class SnapshotBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotBundleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SnapshotBundleError(code, message);
}

function uint32(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    fail('SNAPSHOT_BUNDLE_INVALID', `${field} 超出 uint32`);
  }
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value, 0);
  return result;
}

function uint64(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SNAPSHOT_BUNDLE_INVALID', `${field} 超出安全整数`);
  }
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(value), 0);
  return result;
}

function readUint64(buffer, offset, field) {
  if (offset + 8 > buffer.length) fail('SNAPSHOT_BUNDLE_CORRUPT', `${field} 缺失`);
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('SNAPSHOT_BUNDLE_CORRUPT', `${field} 超出安全整数`);
  }
  return Number(value);
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function rawDigest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

function assertStrictUtf8(bytes, field) {
  try {
    STRICT_UTF8_DECODER.decode(bytes);
  } catch (_) {
    fail('SNAPSHOT_MARKDOWN_INVALID_UTF8', `${field} 不是严格 UTF-8`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function publicPath(value, kind, field) {
  schema.assertString(value, field, { minBytes: 1, maxBytes: 4096, maxScalars: 1024 });
  if (value.startsWith('/') || value.includes('\\') || value.includes('//')) {
    fail('SNAPSHOT_BUNDLE_INVALID', `${field} 不是项目内 POSIX path`);
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      (kind === 'markdown' && !MARKDOWN_RE.test(value)) ||
      (kind === 'image' && !IMAGE_RE.test(value))) {
    fail('SNAPSHOT_BUNDLE_INVALID', `${field} 不符合 ${kind} allowlist`);
  }
  return value;
}

function assertManifest(manifest) {
  try {
    schema.assertExactKeys(manifest, schema.KEYS.SNAPSHOT, 'snapshot manifest');
    if (manifest.schema !== schema.SCHEMAS.SNAPSHOT) fail('SNAPSHOT_BUNDLE_INVALID', 'manifest schema 无效');
    schema.assertProjectInstanceId(manifest.projectInstanceId);
    schema.assertOpaqueId(manifest.snapshotId, 'snapshotId');
    schema.assertString(manifest.createdAt, 'createdAt', { ascii: true, maxBytes: 96 });
    if (Number.isNaN(Date.parse(manifest.createdAt))) fail('SNAPSHOT_BUNDLE_INVALID', 'createdAt 无效');
    schema.assertSafeInteger(manifest.creationMutationGeneration, 'creationMutationGeneration');
    schema.assertDigest(manifest.rootIdentityDigest, 'rootIdentityDigest');
    schema.assertDigest(manifest.fileRevisionSetDigest, 'fileRevisionSetDigest');
    schema.assertString(manifest.producerVersion, 'producerVersion', { ascii: true, minBytes: 1, maxBytes: 96 });
    schema.assertDigest(manifest.snapshotManifestDigest, 'snapshotManifestDigest');
    schema.assertExactKeys(manifest.budgets, schema.KEYS.BUDGETS, 'budgets');
    schema.assertExactKeys(manifest.budgets.limits, schema.KEYS.LIMITS, 'budgets.limits');
    schema.assertExactKeys(manifest.budgets.observed, schema.KEYS.OBSERVED, 'budgets.observed');
    for (const [key, value] of Object.entries(SNAPSHOT_LIMITS)) {
      if (manifest.budgets.limits[key] !== value) {
        fail('SNAPSHOT_BUNDLE_INVALID', `budgets.limits.${key} 不是冻结值`);
      }
      schema.assertSafeInteger(value, `budgets.limits.${key}`);
    }
    for (const [key, value] of Object.entries(manifest.budgets.observed)) {
      schema.assertSafeInteger(value, `budgets.observed.${key}`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length > MAX_ENTRIES) {
      fail('SNAPSHOT_BUNDLE_INVALID', 'manifest files 超限');
    }
    const ids = new Set();
    const paths = new Set();
    let markdownFiles = 0;
    let imageFiles = 0;
    let markdownBytes = 0;
    let imageBytes = 0;
    let previousPath = null;
    const markdownIds = new Set();
    const pendingReferences = [];
    for (const [index, file] of manifest.files.entries()) {
      schema.assertExactKeys(file, schema.KEYS.SNAPSHOT_FILE, `files[${index}]`);
      schema.assertOpaqueId(file.fileId, `files[${index}].fileId`);
      if (!['markdown', 'image'].includes(file.kind)) fail('SNAPSHOT_BUNDLE_INVALID', '文件 kind 无效');
      publicPath(file.path, file.kind, `files[${index}].path`);
      schema.assertSafeInteger(file.mode, `files[${index}].mode`, 0, 0xffff);
      schema.assertSafeInteger(file.byteLength, `files[${index}].byteLength`);
      schema.assertDigest(file.sha256, `files[${index}].sha256`);
      schema.assertString(file.revision, `files[${index}].revision`, { ascii: true, pattern: REVISION_RE });
      schema.assertDigest(file.ancestorIdentityDigest, `files[${index}].ancestorIdentityDigest`);
      schema.assertDigest(file.sourceObjectIdentityDigest, `files[${index}].sourceObjectIdentityDigest`);
      schema.assertDigest(file.bundleObjectDigest, `files[${index}].bundleObjectDigest`);
      if (!Array.isArray(file.references) || file.references.length > 2000) {
        fail('SNAPSHOT_BUNDLE_INVALID', '图片引用列表超限');
      }
      for (const [referenceIndex, reference] of file.references.entries()) {
        schema.assertExactKeys(reference, schema.KEYS.REFERENCE, `files[${index}].references[${referenceIndex}]`);
        schema.assertOpaqueId(reference.fromFileId, 'fromFileId');
        schema.assertSafeInteger(reference.tokenOrdinal, 'tokenOrdinal');
        schema.assertDigest(reference.locatorDigest, 'locatorDigest');
        pendingReferences.push({ file, reference });
      }
      if (ids.has(file.fileId) || paths.has(file.path) ||
          (previousPath !== null && schema.compareUtf8Bytes(previousPath, file.path) >= 0)) {
        fail('SNAPSHOT_BUNDLE_INVALID', 'manifest 文件身份重复或排序错误');
      }
      ids.add(file.fileId);
      paths.add(file.path);
      previousPath = file.path;
      if (file.kind === 'markdown') {
        if (file.references.length !== 0) {
          fail('SNAPSHOT_BUNDLE_INVALID', 'Markdown 文件不得携带图片引用关系');
        }
        markdownIds.add(file.fileId);
        markdownFiles += 1;
        markdownBytes += file.byteLength;
      } else {
        imageFiles += 1;
        imageBytes += file.byteLength;
      }
    }
    for (const { file, reference } of pendingReferences) {
      if (file.kind !== 'image' || !markdownIds.has(reference.fromFileId)) {
        fail('SNAPSHOT_BUNDLE_INVALID', '图片引用必须指向同一 manifest 内的 Markdown');
      }
    }
    const observed = manifest.budgets.observed;
    if (observed.markdownFiles !== markdownFiles || observed.imageFiles !== imageFiles ||
        observed.totalItems !== manifest.files.length || observed.markdownBytes !== markdownBytes ||
        observed.imageBytes !== imageBytes || observed.snapshotBytes !== markdownBytes + imageBytes) {
      fail('SNAPSHOT_BUNDLE_INVALID', 'manifest observed 预算与文件不一致');
    }
    const limits = SNAPSHOT_LIMITS;
    if (markdownFiles > limits.maxMarkdownFiles || imageFiles > limits.maxImageFiles ||
        manifest.files.length > limits.maxTotalItems || markdownBytes > limits.maxMarkdownTotalBytes ||
        markdownBytes + imageBytes > limits.maxSnapshotBytes ||
        observed.privateMetadataBytes > limits.maxPrivateMetadataBytes ||
        manifest.files.some(file => file.byteLength > (file.kind === 'markdown'
          ? limits.maxMarkdownFileBytes
          : limits.maxImageFileBytes))) {
      fail('SNAPSHOT_BUNDLE_INVALID', 'manifest 超出冻结预算');
    }
    const revisionSet = schema.createFileRevisionSetDigest(manifest.files.map(file => ({
      fileId: file.fileId,
      path: file.path,
      revision: file.revision,
      sha256: file.sha256,
    })));
    if (revisionSet.digest !== manifest.fileRevisionSetDigest ||
        schema.digestObject(schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest') !==
          manifest.snapshotManifestDigest) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', 'manifest digest 无法复现');
    }
    const canonical = Buffer.from(schema.canonicalJson(manifest), 'utf8');
    if (canonical.length > MAX_MANIFEST_BYTES || canonical.length > limits.maxManifestBytes ||
        observed.manifestBytes !== canonical.length) {
      fail('SNAPSHOT_BUNDLE_INVALID', 'manifest byteLength 预算不一致');
    }
    return Object.freeze({ canonical, manifest });
  } catch (error) {
    if (error instanceof SnapshotBundleError) throw error;
    if (error instanceof schema.EvidenceDeliverySchemaError) {
      fail('SNAPSHOT_BUNDLE_INVALID', error.message);
    }
    throw error;
  }
}

function entryHeader(file) {
  return Object.freeze({
    schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY,
    fileId: file.fileId,
    path: file.path,
    kind: file.kind,
    byteLength: file.byteLength,
    sha256: file.sha256,
  });
}

function bundleObjectDigest(headerBytes, content) {
  const preimage = Buffer.concat([
    Buffer.from('writcraft-snapshot-object/v1', 'utf8'),
    Buffer.from([0]),
    uint32(headerBytes.length, 'header length'),
    headerBytes,
    uint64(content.length, 'content length'),
    content,
  ]);
  return digestBytes(preimage);
}

function normalizeEntries(manifest, entries) {
  if (!Array.isArray(entries) || entries.length !== manifest.files.length) {
    fail('SNAPSHOT_BUNDLE_INVALID', 'bundle entries 与 manifest 不一致');
  }
  return entries.map((raw, index) => {
    const file = manifest.files[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        !Buffer.isBuffer(raw.content) || raw.fileId !== file.fileId) {
      fail('SNAPSHOT_BUNDLE_INVALID', `entries[${index}] 无效`);
    }
    if (raw.content.length !== file.byteLength || digestBytes(raw.content) !== file.sha256) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', `entries[${index}] 内容摘要不一致`);
    }
    if (file.kind === 'markdown') assertStrictUtf8(raw.content, `entries[${index}] Markdown`);
    const header = entryHeader(file);
    const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
    if (headerBytes.length > MAX_HEADER_BYTES ||
        bundleObjectDigest(headerBytes, raw.content) !== file.bundleObjectDigest) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', `entries[${index}] bundle object 摘要不一致`);
    }
    return Object.freeze({ file, header, headerBytes, content: raw.content });
  });
}

function createBundle(manifest, entries) {
  const checked = assertManifest(manifest);
  const normalized = normalizeEntries(manifest, entries);
  let contentBytes = 0;
  const pieces = [MAGIC, uint32(checked.canonical.length, 'manifest length'), checked.canonical,
    uint32(normalized.length, 'entry count')];
  for (const item of normalized) {
    contentBytes += item.content.length;
    if (contentBytes > MAX_CONTENT_BYTES) fail('SNAPSHOT_BUNDLE_INVALID', 'bundle content 超限');
    pieces.push(
      uint32(item.headerBytes.length, 'header length'),
      item.headerBytes,
      uint64(item.content.length, 'content length'),
      item.content
    );
  }
  const payload = Buffer.concat(pieces);
  const bundle = Buffer.concat([payload, rawDigest(payload), FOOTER]);
  if (bundle.length > MAX_BUNDLE_BYTES) fail('SNAPSHOT_BUNDLE_INVALID', 'bundle 总长超限');
  return Object.freeze({
    bundle,
    bundlePayloadSha256: digestBytes(payload),
  });
}

function parseCanonicalObject(bytes, field) {
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('SNAPSHOT_BUNDLE_CORRUPT', `${field} JSON 损坏`); }
  let canonical;
  try { canonical = Buffer.from(schema.canonicalJson(parsed), 'utf8'); }
  catch (_) { fail('SNAPSHOT_BUNDLE_CORRUPT', `${field} JSON 不可规范化`); }
  if (!canonical.equals(bytes)) fail('SNAPSHOT_BUNDLE_CORRUPT', `${field} 不是冻结 canonical bytes`);
  return parsed;
}

function parseBundle(bundle) {
  if (!Buffer.isBuffer(bundle) || bundle.length < MAGIC.length + 4 + 4 + 32 + FOOTER.length ||
      bundle.length > MAX_BUNDLE_BYTES || !bundle.subarray(0, MAGIC.length).equals(MAGIC) ||
      !bundle.subarray(bundle.length - FOOTER.length).equals(FOOTER)) {
    fail('SNAPSHOT_BUNDLE_CORRUPT', 'bundle framing 无效');
  }
  const payloadEnd = bundle.length - FOOTER.length - 32;
  const payload = bundle.subarray(0, payloadEnd);
  const storedRawDigest = bundle.subarray(payloadEnd, payloadEnd + 32);
  if (!rawDigest(payload).equals(storedRawDigest)) {
    fail('SNAPSHOT_BUNDLE_CORRUPT', 'bundle payload digest 不一致');
  }
  let offset = MAGIC.length;
  if (offset + 4 > payloadEnd) fail('SNAPSHOT_BUNDLE_CORRUPT', 'manifest length 缺失');
  const manifestLength = bundle.readUInt32BE(offset);
  offset += 4;
  if (manifestLength > MAX_MANIFEST_BYTES || offset + manifestLength + 4 > payloadEnd) {
    fail('SNAPSHOT_BUNDLE_CORRUPT', 'manifest length 无效');
  }
  const manifestBytes = bundle.subarray(offset, offset + manifestLength);
  offset += manifestLength;
  const manifest = parseCanonicalObject(manifestBytes, 'manifest');
  const checked = assertManifest(manifest);
  if (!checked.canonical.equals(manifestBytes)) fail('SNAPSHOT_BUNDLE_CORRUPT', 'manifest canonical bytes 漂移');
  const entryCount = bundle.readUInt32BE(offset);
  offset += 4;
  if (entryCount !== manifest.files.length || entryCount > MAX_ENTRIES) {
    fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry count 不一致');
  }
  const bindings = [];
  let contentBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 4 > payloadEnd) fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry header length 缺失');
    const headerLength = bundle.readUInt32BE(offset);
    offset += 4;
    if (headerLength > MAX_HEADER_BYTES || offset + headerLength + 8 > payloadEnd) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry header length 无效');
    }
    const headerBytes = bundle.subarray(offset, offset + headerLength);
    offset += headerLength;
    const header = parseCanonicalObject(headerBytes, `entry[${index}] header`);
    schema.assertExactKeys(header, schema.KEYS.BUNDLE_ENTRY, `entry[${index}] header`);
    const file = manifest.files[index];
    const expectedHeader = entryHeader(file);
    if (schema.canonicalJson(header) !== schema.canonicalJson(expectedHeader)) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry header 与 manifest 不一致');
    }
    const contentLength = readUint64(bundle, offset, `entry[${index}] content length`);
    offset += 8;
    contentBytes += contentLength;
    if (contentLength !== file.byteLength || contentBytes > MAX_CONTENT_BYTES ||
        offset + contentLength > payloadEnd) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry content length 无效');
    }
    const contentOffset = offset;
    const content = bundle.subarray(offset, offset + contentLength);
    offset += contentLength;
    if (digestBytes(content) !== file.sha256 ||
        bundleObjectDigest(headerBytes, content) !== file.bundleObjectDigest) {
      fail('SNAPSHOT_BUNDLE_CORRUPT', 'entry content digest 无效');
    }
    if (file.kind === 'markdown') assertStrictUtf8(content, `entry[${index}] Markdown`);
    const binding = {
      schema: schema.SCHEMAS.SNAPSHOT_ENTRY_BINDING,
      snapshotId: manifest.snapshotId,
      bundlePayloadSha256: digestBytes(payload),
      fileId: file.fileId,
      bundleObjectDigest: file.bundleObjectDigest,
      contentOffset,
      contentLength,
      entryBindingDigest: null,
    };
    binding.entryBindingDigest = schema.digestObject(
      schema.SCHEMAS.SNAPSHOT_ENTRY_BINDING,
      binding,
      'entryBindingDigest'
    );
    bindings.push(Object.freeze(binding));
  }
  if (offset !== payloadEnd) fail('SNAPSHOT_BUNDLE_CORRUPT', 'bundle 存在 trailing bytes');
  deepFreeze(manifest);
  return Object.freeze({
    manifest,
    bindings: Object.freeze(bindings),
    bundlePayloadSha256: digestBytes(payload),
    payloadLength: payload.length,
  });
}

module.exports = Object.freeze({
  MAGIC,
  FOOTER,
  MAX_ENTRIES,
  MAX_MANIFEST_BYTES,
  MAX_HEADER_BYTES,
  MAX_CONTENT_BYTES,
  MAX_BUNDLE_BYTES,
  SNAPSHOT_LIMITS,
  SnapshotBundleError,
  digestBytes,
  entryHeader,
  bundleObjectDigest,
  assertManifest,
  createBundle,
  parseBundle,
});
