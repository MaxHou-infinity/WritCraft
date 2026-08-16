'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const evidence = require('./evidence-delivery-schema');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_DIMENSION = 16384;
const MAX_PIXELS = 40000000;

class DeliveryImageDecodeError extends Error {
  constructor(code, message) { super(message); this.name = 'DeliveryImageDecodeError'; this.code = code; }
}

function fail(code, message) { throw new DeliveryImageDecodeError(code, message); }

function assertEntryBinding(binding, headerBytes, contentSha256, mimeType) {
  try {
    evidence.assertExactKeys(binding, evidence.KEYS.ENTRY_BINDING, 'snapshot entry binding');
    if (binding.schema !== evidence.SCHEMAS.SNAPSHOT_ENTRY_BINDING ||
        !Buffer.isBuffer(headerBytes) || headerBytes.length < 1 || headerBytes.length > 1024 * 1024 ||
        typeof contentSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(contentSha256) ||
        !['image/png', 'image/jpeg'].includes(mimeType)) {
      fail('IMAGE_DECODE_INVALID', 'snapshot entry binding 无效');
    }
    evidence.assertOpaqueId(binding.snapshotId, 'snapshotId');
    evidence.assertOpaqueId(binding.fileId, 'fileId');
    evidence.assertDigest(binding.bundlePayloadSha256, 'bundlePayloadSha256');
    evidence.assertDigest(binding.bundleObjectDigest, 'bundleObjectDigest');
    evidence.assertDigest(binding.entryBindingDigest, 'entryBindingDigest');
    evidence.assertSafeInteger(binding.contentOffset, 'contentOffset', 0, 520 * 1024 * 1024);
    evidence.assertSafeInteger(binding.contentLength, 'contentLength', 1, 25 * 1024 * 1024);
    const expected = evidence.digestObject(evidence.SCHEMAS.SNAPSHOT_ENTRY_BINDING, binding, 'entryBindingDigest');
    if (expected !== binding.entryBindingDigest) fail('IMAGE_DECODE_INVALID', 'snapshot entry binding digest 无效');
    return true;
  } catch (error) {
    if (error instanceof DeliveryImageDecodeError) throw error;
    fail('IMAGE_DECODE_INVALID', 'snapshot entry binding 无效');
  }
}

function entryWire({ binding, headerBytes, contentSha256, mimeType }) {
  assertEntryBinding(binding, headerBytes, contentSha256, mimeType);
  const kind = mimeType === 'image/png' ? 'png' : 'jpeg';
  const fields = [
    'E', binding.snapshotId, binding.fileId, binding.bundlePayloadSha256,
    binding.bundleObjectDigest, String(binding.contentOffset), String(binding.contentLength),
    binding.entryBindingDigest, headerBytes.toString('hex'), contentSha256, kind,
  ];
  const wire = `${fields.join('\t')}\n`;
  if (Buffer.byteLength(wire, 'ascii') > 64 * 1024) fail('IMAGE_DECODE_INVALID', 'snapshot entry binding wire 超限');
  return wire;
}

function createDeliveryImageDecoder(options = {}) {
  const helperPath = options.helperPath;
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  if (typeof helperPath !== 'string' || !helperPath) throw new TypeError('helperPath is required');
  if (typeof spawnSync !== 'function') throw new TypeError('spawnSync is required');
  function decodeImage(bytes, mimeType) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES ||
        !['image/png', 'image/jpeg'].includes(mimeType)) fail('IMAGE_DECODE_INVALID', 'image decode input 无效');
    const kind = mimeType === 'image/png' ? 'png' : 'jpeg';
    let result;
    try { result = spawnSync(helperPath, [kind], { input: bytes, encoding: 'utf8', timeout: 5500, maxBuffer: 4096, windowsHide: true }); }
    catch (_) { fail('IMAGE_DECODE_FAILED', 'image decode helper 无法启动'); }
    if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string' || (result.stderr && String(result.stderr).length)) {
      fail('IMAGE_DECODE_FAILED', 'image decode helper 失败');
    }
    const match = /^OK\t([1-9][0-9]*)\t([1-9][0-9]*)\t(sha256:[a-f0-9]{64})\n$/u.exec(result.stdout);
    if (!match) fail('IMAGE_DECODE_FAILED', 'image decode helper 协议无效');
    const width = Number(match[1]); const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      fail('IMAGE_DECODE_FAILED', 'image decode dimensions 无效');
    }
    return Object.freeze({ width, height, mimeType, decodeDigest: match[3], contentSha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` });
  }
  decodeImage.decodeEntry = function decodeEntry({ fd, binding, headerBytes, contentSha256, mimeType }) {
    if (!Number.isSafeInteger(fd) || fd < 0) fail('IMAGE_DECODE_INVALID', 'snapshot bundle fd 无效');
    const wire = entryWire({ binding, headerBytes, contentSha256, mimeType });
    let result;
    try {
      result = spawnSync(helperPath, ['entry'], {
        input: wire,
        encoding: 'utf8',
        timeout: 5500,
        maxBuffer: 4096,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe', fd],
      });
    } catch (_) { fail('IMAGE_DECODE_FAILED', 'image entry helper 无法启动'); }
    if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string' || (result.stderr && String(result.stderr).length)) {
      fail('IMAGE_DECODE_FAILED', 'image entry helper 失败');
    }
    const match = /^OK\t([1-9][0-9]*)\t([1-9][0-9]*)\t(sha256:[a-f0-9]{64})\n$/u.exec(result.stdout);
    if (!match) fail('IMAGE_DECODE_FAILED', 'image entry helper 协议无效');
    const width = Number(match[1]); const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      fail('IMAGE_DECODE_FAILED', 'image entry dimensions 无效');
    }
    return Object.freeze({ width, height, mimeType, decodeDigest: match[3], contentSha256 });
  };
  Object.defineProperty(decodeImage, 'decodeEntry', { enumerable: false, writable: false });
  return decodeImage;
}

module.exports = Object.freeze({ MAX_IMAGE_BYTES, MAX_DIMENSION, MAX_PIXELS, DeliveryImageDecodeError, createDeliveryImageDecoder, assertEntryBinding, entryWire });
