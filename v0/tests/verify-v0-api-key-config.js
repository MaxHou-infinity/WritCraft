'use strict';

// P1-4 专项：AI Key 配置服务 + main/preload/renderer 集成
// Key 明文绝不出现在 renderer 可达的返回值中。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../src/main/api-key-config-service');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function makeStorage() {
  // macOS 的 os.tmpdir() 含符号链接（/var → /private/var），service 会正确拒绝；
  // 测试用 canonical 路径模拟 Electron userData（真实 userData 不经符号链接）。
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-key-storage-')));
}

const VALID_CP = 'sk-cp-' + 'A1_-'.repeat(20);
const VALID_API = 'sk-api-' + 'B2_-'.repeat(20);

console.log('\nAPI key config service verification');

test('validates and classifies both supported key families', () => {
  assert.strictEqual(service.detectKeyType(VALID_CP), 'CODING_PLAN');
  assert.strictEqual(service.detectKeyType(VALID_API), 'FULL');
  assert.strictEqual(service.detectKeyType('sk-other-xxxxxxxxxx'), 'INVALID');
  assert.strictEqual(service.detectKeyType(''), 'INVALID');
  assert.strictEqual(service.detectKeyType(null), 'INVALID');
});

test('saves the user key atomically with 0600 and loads it back', () => {
  const storage = makeStorage();
  try {
    const saved = service.saveUserKey(storage, VALID_CP);
    assert.deepStrictEqual(saved, { configured: true, keyType: 'CODING_PLAN' });
    const target = path.join(storage, service.CONFIG_FILE);
    const stat = fs.statSync(target);
    assert.strictEqual(stat.mode & 0o077, 0, 'config must not be group/world readable');
    const loaded = service.loadUserKey(storage);
    assert.strictEqual(loaded.apiKey, VALID_CP);
    assert.strictEqual(loaded.keyType, 'CODING_PLAN');
    assert.strictEqual(loaded.source, 'user');
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('user-configured key takes priority over the environment key', () => {
  const storage = makeStorage();
  try {
    service.saveUserKey(storage, VALID_CP);
    const resolved = service.resolveApiKey(storage, VALID_API);
    assert.strictEqual(resolved.apiKey, VALID_CP);
    assert.strictEqual(resolved.source, 'user');
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('falls back to the environment key and then to null after clear', () => {
  const storage = makeStorage();
  try {
    const fromEnv = service.resolveApiKey(storage, VALID_API);
    assert.strictEqual(fromEnv.apiKey, VALID_API);
    assert.strictEqual(fromEnv.source, 'environment');
    service.saveUserKey(storage, VALID_CP);
    service.clearUserKey(storage);
    assert.strictEqual(service.loadUserKey(storage), null);
    assert.strictEqual(service.resolveApiKey(storage, ''), null);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('rejects invalid keys, symlinked config and corrupt content', () => {
  const storage = makeStorage();
  const outside = makeStorage();
  try {
    assert.throws(() => service.saveUserKey(storage, 'not-a-key'), error => error.code === 'INVALID_KEY');
    // 符号链接的配置文件必须被拒绝
    const target = path.join(storage, service.CONFIG_FILE);
    fs.writeFileSync(path.join(outside, 'evil.json'), '{}');
    fs.symlinkSync(path.join(outside, 'evil.json'), target);
    assert.throws(() => service.loadUserKey(storage), error => error.code === 'UNSAFE_CONFIG');
    fs.unlinkSync(target);
    // 损坏 JSON
    fs.writeFileSync(target, 'not json', { mode: 0o600 });
    assert.throws(() => service.loadUserKey(storage), error => error.code === 'CONFIG_CORRUPT');
    // 不安全权限（writeFileSync 的 mode 只在创建时生效，需显式 chmod）
    fs.writeFileSync(target, JSON.stringify({ schema: service.CONFIG_SCHEMA, schemaVersion: 1, apiKey: VALID_CP, keyType: 'CODING_PLAN' }));
    fs.chmodSync(target, 0o644);
    assert.throws(() => service.loadUserKey(storage), error => error.code === 'INSECURE_PERMISSIONS');
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('publicStatus never exposes key material', () => {
  const storage = makeStorage();
  try {
    service.saveUserKey(storage, VALID_CP);
    const status = service.publicStatus(storage, undefined);
    assert.deepStrictEqual(Object.keys(status).sort(), ['configured', 'keyType']);
    assert.strictEqual(JSON.stringify(status).includes('sk-cp-'), false);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('publicStatus safely reports an environment fallback when the local config is corrupt', () => {
  const storage = makeStorage();
  try {
    fs.writeFileSync(path.join(storage, service.CONFIG_FILE), 'not json', { mode: 0o600 });
    const status = service.publicStatus(storage, VALID_API);
    assert.deepStrictEqual(status, {
      configured: true,
      keyType: 'FULL',
      userConfigError: 'CONFIG_CORRUPT',
    });
    assert.strictEqual(JSON.stringify(status).includes(VALID_API), false);
    assert.throws(() => service.resolveApiKey(storage, VALID_API), error => error.code === 'CONFIG_CORRUPT');
    assert.deepStrictEqual(service.clearUserKey(storage), { configured: false, keyType: null });
    assert.deepStrictEqual(service.publicStatus(storage, VALID_API), { configured: true, keyType: 'FULL' });
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test('main integrates the service: resolveActiveApiKey + status/set/clear IPC guarded by trusted sender', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  assert(main.includes("require('./api-key-config-service')"));
  assert(main.includes('function resolveActiveApiKey()'));
  assert(!main.includes('function loadEnv'), 'Main must not parse a repository/project .env file');
  assert(!main.includes('ENV_PATH'), 'Main must not bind secrets to the repository path');
  assert(main.includes('apiKeyConfigService.validateKey(process.env.WRITCRAFT_MINIMAX_KEY).key'), 'corrupt config fallback must validate the environment key');
  assert(!main.includes('return process.env.WRITCRAFT_MINIMAX_KEY || null'), 'raw environment strings must never become request credentials');
  // 所有 LLM 路径都用统一解析（不再直接读 env）
  const llmUsesResolver = main.match(/const apiKey = resolveActiveApiKey\(\);/g) || [];
  assert(llmUsesResolver.length >= 2, 'check-api and callLLM must both use resolveActiveApiKey');
  assert(!/const apiKey = process\.env\.WRITCRAFT_MINIMAX_KEY;/.test(main), 'no direct env read in request paths');
  assert((main.match(/'NO_PROJECT'/g) || []).length >= 1, 'NO_PROJECT must remain an explicit safe boundary');
  assert(main.includes("new projectService.ProjectServiceError('NO_PROJECT'"), 'NO_PROJECT must remain a safe public project error');
  assert.match(main, /ipcMain\.handle\('writcraft:rewrite'[\s\S]*?const project = requireCurrentProject\(\)[\s\S]*?return inlineRewriteFailure\(error\)/);
  // 三个 IPC 都存在且校验 sender
  for (const channel of ['writcraft:api-key:status', 'writcraft:api-key:set', 'writcraft:api-key:clear']) {
    const start = main.indexOf(`ipcMain.handle('${channel}'`);
    assert(start >= 0, `${channel} missing`);
    const block = main.slice(start, start + 400);
    assert(block.includes('assertTrustedSender(event)'), `${channel} must assert trusted sender`);
  }
  // set/status/clear 返回值绝不包含 apiKey 字段
  const statusBlock = main.slice(main.indexOf("ipcMain.handle('writcraft:api-key:status'"), main.indexOf("ipcMain.handle('writcraft:api-key:set'"));
  assert(!statusBlock.includes('apiKey:'), 'status must not return key material');
});

test('preload exposes set/clear/status/check and renderer never handles plaintext keys after save', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  assert(preload.includes("status: () => ipcRenderer.invoke('writcraft:api-key:status')"));
  assert(preload.includes("set: (key) => ipcRenderer.invoke('writcraft:api-key:set', key)"));
  assert(preload.includes("clear: () => ipcRenderer.invoke('writcraft:api-key:clear')"));
  assert(preload.includes("check: () => ipcRenderer.invoke('writcraft:check-api')"));
  assert(preload.includes("checkApi: () => ipcRenderer.invoke('writcraft:check-api')"), 'legacy checkApi must remain compatible');
  assert(!preload.includes('api-key:get'), 'no plaintext getter may exist');
  const settings = fs.readFileSync(path.join(__dirname, '../src/renderer/api-key-settings.js'), 'utf8');
  assert(settings.includes("input.value = ''"), 'input must be cleared after save');
  assert(!settings.includes('console.log'), 'settings UI must not log key material');
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert(html.includes('id="activity-settings"'));
  assert(html.includes('id="api-key-dialog"'));
  assert(html.includes('type="password"'));
  assert(html.includes('生成 image-01 配图需要完整 API Key'));
  assert(html.includes('id="api-key-check"'));
  assert(html.includes('id="api-key-connection"'));
  assert(html.includes('aria-live="polite"'));
  assert(html.includes('api-key-settings.js'));
});

test('packaging script ships the settings UI with the rest of src', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/package-macos.js'), 'utf8');
  // 整个 src 目录都会被复制，其中包含 api-key-settings.js 与 service
  assert.match(script, /fs\.cpSync\(path\.join\(root, 'src'\)/);
  assert(fs.existsSync(path.join(__dirname, '../src/main/api-key-config-service.js')));
  assert(fs.existsSync(path.join(__dirname, '../src/renderer/api-key-settings.js')));
});

console.log(`\n${passed}/${passed} API key config checks passed.\n`);
