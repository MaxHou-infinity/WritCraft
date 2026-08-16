'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const decode = require('../src/main/delivery-image-decode-service');
const schema = require('../src/main/evidence-delivery-schema');
const snapshotBundle = require('../src/main/snapshot-bundle');
const fixture = require('./fixtures/electron-ai-provider');

const bytes = Buffer.from('png-bytes');
const digest = 'sha256:' + 'a'.repeat(64);
let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }
function expectCode(code, fn) { assert.throws(fn, error => error && error.code === code); }

test('accepts only the bounded ImageIO helper protocol', () => {
  const decoder = decode.createDeliveryImageDecoder({
    helperPath: '/private/tmp/delivery-image-decode-helper',
    spawnSync(_path, args, options) {
      assert.deepStrictEqual(args, ['png']);
      assert.strictEqual(options.input, bytes);
      return { status: 0, signal: null, error: null, stdout: `OK\t1\t1\t${digest}\n`, stderr: '' };
    },
  });
  assert.deepStrictEqual(decoder(bytes, 'image/png'), {
    width: 1, height: 1, mimeType: 'image/png', decodeDigest: digest,
    contentSha256: 'sha256:ea80334363eed145dfeee51ebae7dc3f1cd7d0c7879f8bfd2070c061d3c33f56',
  });
});

test('rejects malformed output, stderr and signals', () => {
  for (const result of [
    { status: 0, signal: null, error: null, stdout: 'OK\t1\t1\tbad\n', stderr: '' },
    { status: 0, signal: null, error: null, stdout: `OK\t1\t1\t${digest}\n`, stderr: 'warning' },
    { status: null, signal: 'SIGALRM', error: null, stdout: '', stderr: '' },
  ]) {
    const decoder = decode.createDeliveryImageDecoder({ helperPath: 'helper', spawnSync: () => result });
    expectCode('IMAGE_DECODE_FAILED', () => decoder(bytes, 'image/png'));
  }
});

test('rejects unsupported types and over-budget inputs before spawning', () => {
  let calls = 0;
  const decoder = decode.createDeliveryImageDecoder({ helperPath: 'helper', spawnSync: () => { calls += 1; return null; } });
  expectCode('IMAGE_DECODE_INVALID', () => decoder(bytes, 'image/gif'));
  expectCode('IMAGE_DECODE_INVALID', () => decoder(Buffer.alloc(decode.MAX_IMAGE_BYTES + 1), 'image/png'));
  assert.strictEqual(calls, 0);
});

test('passes a verified entry binding over a held bundle fd', () => {
  const binding = {
    schema: schema.SCHEMAS.SNAPSHOT_ENTRY_BINDING,
    snapshotId: 'snapshot_stage_b_entry',
    bundlePayloadSha256: digest,
    fileId: 'file_image_entry',
    bundleObjectDigest: digest,
    contentOffset: 128,
    contentLength: 10,
    entryBindingDigest: null,
  };
  binding.entryBindingDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT_ENTRY_BINDING, binding, 'entryBindingDigest');
  const headerBytes = Buffer.from('{"byteLength":10,"fileId":"file_image_entry","kind":"image","path":"assets/p.png","schema":"writcraft.snapshot-bundle-entry/v1","sha256":"' + digest + '"}', 'utf8');
  let observed = null;
  const decoder = decode.createDeliveryImageDecoder({
    helperPath: 'helper',
    spawnSync(_path, args, options) {
      observed = { args, options };
      return { status: 0, signal: null, error: null, stdout: `OK\t1\t1\t${digest}\n`, stderr: '' };
    },
  });
  const result = decoder.decodeEntry({ fd: 17, binding, headerBytes, contentSha256: digest, mimeType: 'image/png' });
  assert.deepStrictEqual(result, { width: 1, height: 1, mimeType: 'image/png', decodeDigest: digest, contentSha256: digest });
  assert.deepStrictEqual(observed.args, ['entry']);
  assert.strictEqual(observed.options.stdio[3], 17);
  assert.match(observed.options.input, /^E\tsnapshot_stage_b_entry\tfile_image_entry\t/);
  assert.ok(observed.options.input.endsWith('\tpng\n'));
});

test('native entry mode reads the exact bound image from a held bundle fd', () => {
  const helperPath = path.join(__dirname, '..', 'src', 'main', 'native', 'delivery-image-decode-helper');
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath)) {
    console.log('    (native entry binding fixture skipped outside macOS build environment)');
    return;
  }
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const fileId = 'file_image_entry';
  const header = { schema: schema.SCHEMAS.SNAPSHOT_BUNDLE_ENTRY, fileId, path: 'assets/p.png', kind: 'image', byteLength: image.length, sha256: snapshotBundle.digestBytes(image) };
  const headerBytes = Buffer.from(schema.canonicalJson(header), 'utf8');
  const file = {
    fileId, path: 'assets/p.png', kind: 'image', mode: 0o600, byteLength: image.length, sha256: header.sha256,
    revision: 'a'.repeat(64), ancestorIdentityDigest: `sha256:${'1'.repeat(64)}`,
    sourceObjectIdentityDigest: `sha256:${'2'.repeat(64)}`,
    bundleObjectDigest: snapshotBundle.bundleObjectDigest(headerBytes, image), references: [],
  };
  const limits = { ...snapshotBundle.SNAPSHOT_LIMITS };
  const manifest = {
    schema: schema.SCHEMAS.SNAPSHOT, projectInstanceId: 'instance_0123456789abcdef01234567', snapshotId: 'snapshot_stage_b_entry',
    createdAt: '2026-08-10T00:00:00.000Z', creationMutationGeneration: 1, rootIdentityDigest: `sha256:${'3'.repeat(64)}`,
    files: [file], fileRevisionSetDigest: null,
    budgets: { limits, observed: { markdownFiles: 0, imageFiles: 1, totalItems: 1, markdownBytes: 0, imageBytes: image.length, snapshotBytes: image.length, manifestBytes: 0, privateMetadataBytes: 0 } },
    producerVersion: 'stage-b-test', snapshotManifestDigest: null,
  };
  manifest.fileRevisionSetDigest = schema.createFileRevisionSetDigest([{ fileId, path: file.path, revision: file.revision, sha256: file.sha256 }]).digest;
  for (let index = 0; index < 8; index += 1) {
    manifest.snapshotManifestDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
    manifest.budgets.observed.manifestBytes = Buffer.byteLength(schema.canonicalJson(manifest), 'utf8');
  }
  manifest.snapshotManifestDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT, manifest, 'snapshotManifestDigest');
  const bundle = snapshotBundle.createBundle(manifest, [{ fileId, content: image }]).bundle;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-entry-'));
  const filePath = path.join(directory, 'bundle.wcsb');
  fs.writeFileSync(filePath, bundle, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  try {
    const parsed = snapshotBundle.parseBundle(bundle);
    const result = decode.createDeliveryImageDecoder({ helperPath }).decodeEntry({
      fd, binding: parsed.bindings[0], headerBytes, contentSha256: file.sha256, mimeType: 'image/png',
    });
    assert.strictEqual(result.width, 1);
    assert.strictEqual(result.height, 1);
    assert.strictEqual(result.contentSha256, file.sha256);
    const forged = { ...parsed.bindings[0], contentOffset: parsed.bindings[0].contentOffset + 1 };
    forged.entryBindingDigest = schema.digestObject(schema.SCHEMAS.SNAPSHOT_ENTRY_BINDING, forged, 'entryBindingDigest');
    expectCode('IMAGE_DECODE_FAILED', () => decode.createDeliveryImageDecoder({ helperPath }).decodeEntry({
      fd, binding: forged, headerBytes, contentSha256: file.sha256, mimeType: 'image/png',
    }));
  } finally {
    fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function crc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, data]);
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE(crc32(body), 8 + data.length);
  return result;
}

test('native helper rejects a CRC-valid but damaged PNG IDAT stream', () => {
  const helperPath = path.join(__dirname, '..', 'src', 'main', 'native', 'delivery-image-decode-helper');
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath)) {
    console.log('    (native damaged-IDAT fixture skipped outside macOS build environment)');
    return;
  }
  const valid = Buffer.from(fixture.PNG_BASE64, 'base64');
  const damaged = Buffer.from(valid);
  let offset = 8;
  let changed = false;
  while (offset + 12 <= damaged.length) {
    const length = damaged.readUInt32BE(offset);
    const type = damaged.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 0) {
      damaged[offset + 8] ^= 0xff;
      const body = damaged.subarray(offset + 4, offset + 8 + length);
      damaged.writeUInt32BE(crc32(body), offset + 8 + length);
      changed = true;
      break;
    }
    offset += 12 + length;
  }
  assert.strictEqual(changed, true);
  const decoder = decode.createDeliveryImageDecoder({ helperPath });
  expectCode('IMAGE_DECODE_FAILED', () => decoder(damaged, 'image/png'));
});

test('native helper rejects a structurally valid JPEG with a damaged entropy stream', () => {
  const helperPath = path.join(__dirname, '..', 'src', 'main', 'native', 'delivery-image-decode-helper');
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath)) {
    console.log('    (native damaged-JPEG entropy fixture skipped outside macOS build environment)');
    return;
  }
  const valid = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUDBAMEBgUGBgYFBQUGBwkIBgcIBwUFCAsICAkJCgoKBgcLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBgUGCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAACAn/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCFgA+uA//Z', 'base64');
  const damaged = Buffer.from(valid);
  let scanStart = -1;
  for (let offset = 2; offset + 3 < damaged.length; offset += 1) {
    if (damaged[offset] !== 0xff || damaged[offset + 1] !== 0xda) continue;
    const segmentLength = damaged.readUInt16BE(offset + 2);
    scanStart = offset + 2 + segmentLength;
    break;
  }
  assert.ok(scanStart > 0 && scanStart + 4 < damaged.length);
  // Replace the first entropy byte with a value that violates the baseline
  // Huffman/DC syntax while leaving the JPEG container, SOS, and EOI intact.
  damaged[scanStart] = 0x00;
  const decoder = decode.createDeliveryImageDecoder({ helperPath });
  expectCode('IMAGE_DECODE_FAILED', () => decoder(damaged, 'image/jpeg'));
});

function maxLegalPng() {
  // 16,384 x 2,441 = 39,993,344 pixels, below the frozen 40Mpx limit.
  // A blank RGBA image compresses to a small input while forcing ImageIO and
  // the bitmap draw path to allocate and decode the full legal pixel budget.
  const width = 16384;
  const height = 2441;
  const row = Buffer.alloc(width * 4 + 1);
  const raw = Buffer.alloc(row.length * height);
  for (let index = 0; index < height; index += 1) row.copy(raw, index * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

test('real macOS helper stays within the 40-image and 40Mpx worker envelope', () => {
  const helperPath = path.join(__dirname, '..', 'src', 'main', 'native', 'delivery-image-decode-helper');
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath)) {
    console.log('    (native ImageIO pressure fixture skipped outside macOS build environment)');
    return;
  }
  const decoder = decode.createDeliveryImageDecoder({ helperPath });
  const onePixel = Buffer.from(fixture.PNG_BASE64, 'base64');
  for (let index = 0; index < 40; index += 1) {
    const result = decoder(onePixel, 'image/png');
    assert.strictEqual(result.width, 16);
    assert.strictEqual(result.height, 9);
  }
  const maximum = maxLegalPng();
  const result = decoder(maximum, 'image/png');
  assert.strictEqual(result.width, 16384);
  assert.strictEqual(result.height, 2441);
  assert.strictEqual(result.contentSha256, `sha256:${crypto.createHash('sha256').update(maximum).digest('hex')}`);
});

console.log(`Stage B delivery ImageIO decoder boundary: ${passed}/8 passed`);
