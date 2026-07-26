'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_SCHEMA = 'writcraft.ai-config/v1';
const CONFIG_FILE = 'ai-config.json';
const MAX_CONFIG_BYTES = 16 * 1024;
const KEY_RE = /^sk-(api|cp)-[A-Za-z0-9_-]{8,240}$/i;

class ApiKeyConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiKeyConfigError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApiKeyConfigError(code, message);
}

function detectKeyType(value) {
  if (typeof value !== 'string') return 'INVALID';
  const match = value.match(KEY_RE);
  if (!match) return 'INVALID';
  return match[1].toLocaleLowerCase('en-US') === 'cp' ? 'CODING_PLAN' : 'FULL';
}

function validateKey(value) {
  if (typeof value !== 'string') fail('INVALID_KEY', 'AI Key 格式无效');
  const key = value.trim();
  const keyType = detectKeyType(key);
  if (keyType === 'INVALID') {
    fail('INVALID_KEY', '仅支持 sk-api- 或 sk-cp- 开头的兼容 Key');
  }
  return { key, keyType };
}

function storageTarget(storageDirectory) {
  if (typeof storageDirectory !== 'string' || !storageDirectory) fail('INVALID_STORAGE', '应用配置目录无效');
  const storage = path.resolve(storageDirectory);
  let stat;
  try { stat = fs.lstatSync(storage); } catch (_) { fail('INVALID_STORAGE', '应用配置目录不存在'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_STORAGE', '应用配置目录必须是普通目录');
  const canonical = fs.realpathSync(storage);
  if (canonical !== storage) fail('UNSAFE_STORAGE', '应用配置目录路径不可信');
  const target = path.join(canonical, CONFIG_FILE);
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) fail('UNSAFE_CONFIG', 'AI 配置必须是普通文件');
  }
  return { storage: canonical, target };
}

function syncDirectory(directory) {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) {}
}

function atomicWrite(target, content) {
  const temporary = path.join(
    path.dirname(target),
    `.ai-config.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    syncDirectory(path.dirname(target));
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function saveUserKey(storageDirectory, value) {
  const { target } = storageTarget(storageDirectory);
  const { key, keyType } = validateKey(value);
  const content = `${JSON.stringify({
    schema: CONFIG_SCHEMA,
    schemaVersion: 1,
    apiKey: key,
    keyType,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  atomicWrite(target, content);
  return { configured: true, keyType };
}

function loadUserKey(storageDirectory) {
  const { target } = storageTarget(storageDirectory);
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (stat.size > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE', 'AI 配置文件超过大小限制');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('INSECURE_PERMISSIONS', 'AI 配置文件权限不安全，请重新保存 Key');
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch (_) { fail('CONFIG_CORRUPT', 'AI 配置文件已损坏，请重新保存 Key'); }
  if (!parsed || parsed.schema !== CONFIG_SCHEMA || parsed.schemaVersion !== 1) {
    fail('CONFIG_CORRUPT', 'AI 配置版本无效，请重新保存 Key');
  }
  const validated = validateKey(parsed.apiKey);
  if (parsed.keyType !== validated.keyType) fail('CONFIG_CORRUPT', 'AI 配置类型不一致，请重新保存 Key');
  return { apiKey: validated.key, keyType: validated.keyType, source: 'user' };
}

function clearUserKey(storageDirectory) {
  const { storage, target } = storageTarget(storageDirectory);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    syncDirectory(storage);
  }
  return { configured: false, keyType: null };
}

function resolveApiKey(storageDirectory, environmentKey) {
  const configured = loadUserKey(storageDirectory);
  if (configured) return configured;
  if (typeof environmentKey !== 'string' || !environmentKey.trim()) return null;
  const validated = validateKey(environmentKey);
  return { apiKey: validated.key, keyType: validated.keyType, source: 'environment' };
}

const PUBLIC_CONFIG_ERRORS = new Set([
  'CONFIG_TOO_LARGE',
  'INSECURE_PERMISSIONS',
  'CONFIG_CORRUPT',
  'UNSAFE_CONFIG',
  'INVALID_KEY',
]);

function publicConfigError(error) {
  return PUBLIC_CONFIG_ERRORS.has(error?.code) ? error.code : 'CONFIG_UNREADABLE';
}

function publicStatus(storageDirectory, environmentKey) {
  let configured;
  try {
    configured = loadUserKey(storageDirectory);
  } catch (error) {
    let environment = null;
    try {
      if (typeof environmentKey === 'string' && environmentKey.trim()) {
        environment = validateKey(environmentKey);
      }
    } catch (_) {
      // The environment value is also invalid. It must not obscure the safe,
      // actionable local-config state or cross the renderer boundary.
    }
    return {
      configured: Boolean(environment),
      keyType: environment?.keyType || null,
      userConfigError: publicConfigError(error),
    };
  }
  if (configured) return { configured: true, keyType: configured.keyType };
  if (typeof environmentKey !== 'string' || !environmentKey.trim()) {
    return { configured: false, keyType: null };
  }
  const environment = validateKey(environmentKey);
  return { configured: true, keyType: environment.keyType };
}

module.exports = {
  CONFIG_SCHEMA,
  CONFIG_FILE,
  ApiKeyConfigError,
  detectKeyType,
  validateKey,
  saveUserKey,
  loadUserKey,
  clearUserKey,
  resolveApiKey,
  publicConfigError,
  publicStatus,
};
