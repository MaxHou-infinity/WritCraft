'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://api.minimax.io/v1/image_generation';
const MODEL = 'image-01';
const MAX_PROMPT_CHARS = 1500;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 64 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']);
const ASPECT_RATIO_SET = new Set(ASPECT_RATIOS);
const ASPECT_RATIO_DIMENSIONS = Object.freeze({
  '1:1': Object.freeze({ width: 1024, height: 1024 }),
  '16:9': Object.freeze({ width: 1280, height: 720 }),
  '4:3': Object.freeze({ width: 1152, height: 864 }),
  '3:2': Object.freeze({ width: 1248, height: 832 }),
  '2:3': Object.freeze({ width: 832, height: 1248 }),
  '3:4': Object.freeze({ width: 864, height: 1152 }),
  '9:16': Object.freeze({ width: 720, height: 1280 }),
  '21:9': Object.freeze({ width: 1344, height: 576 }),
});
const GENERATED_DIR = Object.freeze(['assets', 'generated']);

class ImageGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageGenerationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ImageGenerationError(code, message);
}

function validatePrompt(value) {
  if (typeof value !== 'string') fail('INVALID_PROMPT', '图片描述必须是文本');
  const prompt = value.trim();
  if (!prompt) fail('INVALID_PROMPT', '请先填写图片描述');
  if (Array.from(prompt).length > MAX_PROMPT_CHARS) {
    fail('PROMPT_TOO_LONG', `图片描述不能超过 ${MAX_PROMPT_CHARS} 个字符`);
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    fail('INVALID_PROMPT', '图片描述包含无效控制字符');
  }
  return prompt;
}

function validateAspectRatio(value) {
  if (typeof value !== 'string' || !ASPECT_RATIO_SET.has(value)) {
    fail('INVALID_ASPECT_RATIO', '图片比例不在官方 image-01 白名单中');
  }
  return value;
}

function validateApiKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('NO_KEY', '请先在应用设置中配置 MiniMax Key');
  }
  return value.trim();
}

function validateProjectRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) fail('INVALID_PROJECT', '当前项目路径无效');
  let stat;
  try { stat = fs.lstatSync(rootPath); } catch (_) { fail('INVALID_PROJECT', '当前项目不存在'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('INVALID_PROJECT', '当前项目目录不可信');
  const resolved = path.resolve(rootPath);
  const canonical = fs.realpathSync(resolved);
  return canonical;
}

function strictBase64(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    fail('INVALID_IMAGE_RESPONSE', '图片响应缺失或超过大小上限');
  }
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('INVALID_IMAGE_RESPONSE', '图片响应不是严格 Base64');
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== value) {
    fail('INVALID_IMAGE_RESPONSE', '图片响应无效或超过大小上限');
  }
  return buffer;
}

function detectImageType(buffer) {
  const png = buffer.length >= 33 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.readUInt32BE(8) === 13 && buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
    buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0;
  if (png) return { mimeType: 'image/png', extension: '.png' };
  const jpeg = buffer.length >= 8 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (jpeg) return { mimeType: 'image/jpeg', extension: '.jpg' };
  fail('UNSUPPORTED_IMAGE_TYPE', '生成结果不是可验证的 JPEG 或 PNG');
}

function validateDecodedImage(buffer, mimeType, aspectRatio, decodeImage) {
  if (typeof decodeImage !== 'function') fail('IMAGE_DECODER_UNAVAILABLE', '当前运行时无法完整解码图片');
  let size;
  try { size = decodeImage(buffer, mimeType); }
  catch (_) { fail('INVALID_IMAGE_DATA', '生成结果无法完整解码'); }
  if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) ||
      size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) {
    fail('INVALID_IMAGE_DATA', '生成结果无法完整解码');
  }
  const expected = ASPECT_RATIO_DIMENSIONS[aspectRatio];
  if (!expected || size.width * expected.height !== size.height * expected.width) {
    fail('IMAGE_ASPECT_MISMATCH', '生成图片比例与请求不一致，已阻止保存');
  }
  return Object.freeze({
    width: size.width,
    height: size.height,
    requestedAspectRatio: aspectRatio,
    decodedRatio: Number((size.width / size.height).toFixed(4)),
    officialPresetMatch: size.width === expected.width && size.height === expected.height,
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new ImageGenerationError('IMAGE_TIMEOUT', '图片生成超时，请稍后重试'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ImageGenerationError('IMAGE_TIMEOUT', '图片生成超时，请稍后重试'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

function imageHttpFailure(status) {
  const code = Number(status);
  if (code === 401 || code === 403) {
    return { code: 'IMAGE_AUTH_FAILED', message: '图片服务鉴权失败，请检查完整 API Key 是否支持 image-01' };
  }
  if (code === 408) {
    return { code: 'IMAGE_TIMEOUT', message: '图片服务请求超时，请稍后再试' };
  }
  if (code === 429) {
    return { code: 'IMAGE_RATE_LIMITED', message: '图片服务当前限流，请稍后再试' };
  }
  if (code >= 500 && code <= 599) {
    return { code: 'IMAGE_SERVICE_UNAVAILABLE', message: '图片服务暂时不可用，请稍后再试' };
  }
  return { code: 'IMAGE_API_FAILED', message: `图片服务请求失败（HTTP ${code || 0}）` };
}

function imageProviderFailure(statusCode) {
  const code = Number(statusCode);
  if (code === 1001) return { code: 'IMAGE_TIMEOUT', message: '图片服务处理超时，请稍后再试' };
  if ([1002, 1041, 2045].includes(code)) {
    return { code: 'IMAGE_RATE_LIMITED', message: '图片服务当前限流，请稍后再试' };
  }
  if ([1004, 2049].includes(code)) {
    return { code: 'IMAGE_AUTH_FAILED', message: '当前 Key 无法使用图片服务；Coding Plan Key 可能仅支持文本，请配置完整 API Key' };
  }
  if (code === 1008) {
    return { code: 'IMAGE_INSUFFICIENT_BALANCE', message: '图片服务余额不足，请检查 MiniMax 账户余额' };
  }
  if ([1026, 1027].includes(code)) {
    return { code: 'IMAGE_CONTENT_REJECTED', message: '图片描述或生成结果未通过内容安全检查，请调整描述' };
  }
  if (code === 1039) {
    return { code: 'IMAGE_INVALID_REQUEST', message: '图片描述或请求内容超出服务限制，请缩短后重试' };
  }
  if (code === 2056) {
    return { code: 'IMAGE_QUOTA_EXCEEDED', message: '图片服务额度或用量已达上限，请检查套餐后再试' };
  }
  if (code === 2013) {
    return { code: 'IMAGE_INVALID_REQUEST', message: '图片服务未接受当前参数，请更新应用或调整图片比例' };
  }
  if ([1000, 1013, 1024, 1033].includes(code)) {
    return { code: 'IMAGE_SERVICE_UNAVAILABLE', message: '图片服务暂时不可用，请稍后再试' };
  }
  return { code: 'IMAGE_API_FAILED', message: '图片服务未成功生成图片' };
}

function safeGeneratedDirectory(root) {
  let cursor = root;
  for (const segment of GENERATED_DIR) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) fs.mkdirSync(cursor, { mode: 0o700 });
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_IMAGE_DESTINATION', '图片保存目录不可信');
    const canonical = fs.realpathSync(cursor);
    if (canonical !== cursor || !canonical.startsWith(`${root}${path.sep}`)) {
      fail('UNSAFE_IMAGE_DESTINATION', '图片保存目录已越出项目');
    }
  }
  const stat = fs.lstatSync(cursor);
  return Object.freeze({
    path: cursor,
    canonical: fs.realpathSync(cursor),
    dev: stat.dev,
    ino: stat.ino,
  });
}

function syncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (_) {}
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

function verifyGeneratedPath(directory, filePath, identity, expectedLinks = 1) {
  let directoryStat;
  let fileStat;
  let canonicalDirectory;
  let canonicalFile;
  try {
    directoryStat = fs.lstatSync(directory.path);
    fileStat = fs.lstatSync(filePath);
    canonicalDirectory = fs.realpathSync(directory.path);
    canonicalFile = fs.realpathSync(filePath);
  } catch (_) {
    fail('UNSAFE_IMAGE_DESTINATION', '图片保存位置在写入前发生变化');
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() ||
      directoryStat.dev !== directory.dev || directoryStat.ino !== directory.ino ||
      canonicalDirectory !== directory.canonical ||
      fileStat.isSymbolicLink() || !fileStat.isFile() ||
      fileStat.nlink !== expectedLinks ||
      !sameIdentity(fileStat, identity) ||
      path.dirname(canonicalFile) !== directory.canonical) {
    fail('UNSAFE_IMAGE_DESTINATION', '图片保存位置在写入前发生变化');
  }
}

function unlinkMatching(filePath, identity) {
  if (!identity) return;
  try {
    const current = fs.lstatSync(filePath);
    if (!current.isSymbolicLink() && current.isFile() &&
        sameIdentity(current, identity)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

function atomicWriteExclusive(directory, fileName, content) {
  const target = path.join(directory.path, fileName);
  if (fs.existsSync(target)) fail('IMAGE_EXISTS', '相同图片已经保存，不会覆盖现有文件');
  const temporary = path.join(directory.path, `.image.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let descriptor;
  let temporaryIdentity = null;
  let targetIdentity = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    const temporaryStat = fs.fstatSync(descriptor);
    if (!temporaryStat.isFile()) fail('UNSAFE_IMAGE_DESTINATION', '图片临时文件无效');
    temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    verifyGeneratedPath(directory, temporary, temporaryIdentity);
    const beforeWrite = fs.fstatSync(descriptor);
    if (!beforeWrite.isFile() || beforeWrite.nlink !== 1 ||
        !sameIdentity(beforeWrite, temporaryIdentity)) {
      fail('UNSAFE_IMAGE_DESTINATION', '图片临时文件在写入前发生变化');
    }
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    verifyGeneratedPath(directory, temporary, temporaryIdentity);
    fs.linkSync(temporary, target);
    targetIdentity = temporaryIdentity;
    verifyGeneratedPath(directory, temporary, temporaryIdentity, 2);
    verifyGeneratedPath(directory, target, targetIdentity, 2);
    unlinkMatching(temporary, temporaryIdentity);
    syncDirectory(directory.path);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
    unlinkMatching(target, targetIdentity);
    unlinkMatching(temporary, temporaryIdentity);
    if (error && error.code === 'EEXIST') fail('IMAGE_EXISTS', '相同图片已经保存，不会覆盖现有文件');
    throw error;
  }
  return target;
}

async function responsePayload(response, signal) {
  if (!response || (typeof response.text !== 'function' && typeof response.body?.getReader !== 'function')) {
    fail('INVALID_API_RESPONSE', '图片服务响应无效');
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_CHARS) {
    fail('IMAGE_RESPONSE_TOO_LARGE', '图片服务响应超过大小上限');
  }
  let text;
  try {
    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        const chunk = Buffer.from(part.value);
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_CHARS) {
          try { await reader.cancel(); } catch (_) {}
          fail('IMAGE_RESPONSE_TOO_LARGE', '图片服务响应超过大小上限');
        }
        chunks.push(chunk);
      }
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } else {
      text = await abortable(response.text(), signal);
    }
  } catch (error) {
    if (error?.code === 'IMAGE_TIMEOUT') {
      try { await response.body?.cancel?.(); } catch (_) {}
      throw error;
    }
    if (error instanceof ImageGenerationError) throw error;
    fail('INVALID_API_RESPONSE', '无法读取图片服务响应');
  }
  if (typeof text !== 'string' || text.length > MAX_RESPONSE_CHARS) {
    fail('IMAGE_RESPONSE_TOO_LARGE', '图片服务响应超过大小上限');
  }
  let payload;
  try { payload = JSON.parse(text); } catch (_) { fail('INVALID_API_RESPONSE', '图片服务返回了无效 JSON'); }
  if (!response.ok) {
    const failure = imageHttpFailure(response.status);
    fail(failure.code, failure.message);
  }
  const statusCode = payload?.base_resp?.status_code;
  if (statusCode !== undefined && Number(statusCode) !== 0) {
    const failure = imageProviderFailure(statusCode);
    fail(failure.code, failure.message);
  }
  return payload;
}

async function generateAndSaveImage(options = {}) {
  const prompt = validatePrompt(options.prompt);
  const aspectRatio = validateAspectRatio(options.aspectRatio);
  const apiKey = validateApiKey(options.apiKey);
  const root = validateProjectRoot(options.rootPath);
  const request = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof request !== 'function') fail('IMAGE_SERVICE_UNAVAILABLE', '当前运行时不支持图片请求');

  const controller = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal?.aborted) fail('IMAGE_ABORTED', '图片生成已因项目状态变化而取消');
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, REQUEST_TIMEOUT_MS)
    : REQUEST_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortFromOwner = () => controller.abort();
  externalSignal?.addEventListener?.('abort', abortFromOwner, { once: true });
  let payload;
  try {
    const response = await abortable(request(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        aspect_ratio: aspectRatio,
        response_format: 'base64',
        n: 1,
      }),
      signal: controller.signal,
    }), controller.signal);
    payload = await responsePayload(response, controller.signal);
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      if (error.code === 'IMAGE_TIMEOUT' && !timedOut && externalSignal?.aborted) {
        fail('IMAGE_ABORTED', '图片生成已因项目状态变化而取消');
      }
      throw error;
    }
    if (controller.signal.aborted) fail('IMAGE_TIMEOUT', '图片生成超时，请稍后重试');
    fail('IMAGE_REQUEST_FAILED', '图片服务连接失败，请稍后重试');
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener?.('abort', abortFromOwner);
  }
  const images = payload?.data?.image_base64;
  if (!Array.isArray(images) || images.length !== 1) {
    fail('INVALID_IMAGE_RESPONSE', '图片服务未返回唯一的 Base64 图片');
  }
  const bytes = strictBase64(images[0]);
  const type = detectImageType(bytes);
  const metadata = validateDecodedImage(bytes, type.mimeType, aspectRatio, options.decodeImage);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const fileName = `image-${digest}${type.extension}`;
  const filePath = `assets/generated/${fileName}`;

  // Main supplies a synchronous generation/root guard. No await may occur
  // between this check and the exclusive filesystem commit.
  if (typeof options.beforeCommit === 'function') options.beforeCommit();
  const directory = safeGeneratedDirectory(root);
  atomicWriteExclusive(directory, fileName, bytes);

  return {
    ok: true,
    image: {
      filePath,
      mimeType: type.mimeType,
      previewDataUrl: `data:${type.mimeType};base64,${images[0]}`,
      ...metadata,
    },
    markdown: `![AI 生成图片](${filePath})`,
  };
}

module.exports = {
  ENDPOINT,
  MODEL,
  MAX_PROMPT_CHARS,
  MAX_IMAGE_BYTES,
  MAX_RESPONSE_CHARS,
  ASPECT_RATIOS,
  ASPECT_RATIO_DIMENSIONS,
  ImageGenerationError,
  imageHttpFailure,
  imageProviderFailure,
  generateAndSaveImage,
};
