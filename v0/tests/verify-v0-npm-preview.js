#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cli = path.join(root, 'bin', 'writcraft.js');
const cliModule = require(cli);
const EXPECTED_CHECKS = 10;
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function runCli(args, environment = {}) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    npm_config_user_agent: 'npm/11.16.0 node/v24.4.1 darwin arm64',
    ...environment,
  };
  for (const key of cliModule.FORBIDDEN_ELECTRON_ENV) delete env[key];
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

function packDryRun() {
  const packed = childProcess.spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
    timeout: 30_000,
  });
  assert.strictEqual(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout);
  assert(Array.isArray(report) && report.length === 1);
  return report[0];
}

console.log('\nWritCraft npm Developer Preview verification');

test('publishes an explicit preview-tagged macOS 12+ CLI with exact runtime dependencies', () => {
  assert.deepStrictEqual(packageJson.bin, { writcraft: 'bin/writcraft.js' });
  assert.deepStrictEqual(packageJson.os, ['darwin']);
  assert.deepStrictEqual(packageJson.cpu, ['arm64', 'x64']);
  assert.deepStrictEqual(packageJson.engines, {
    node: '>=22.12.0',
    npm: '>=10 <12',
  });
  assert.deepStrictEqual(packageJson.publishConfig, { access: 'public', tag: 'preview' });
  assert.deepStrictEqual(packageJson.dependencies, {
    diff: '9.0.0',
    electron: '43.2.0',
    'pdfjs-dist': '5.4.149',
  });
  assert.strictEqual(packageJson.devDependencies, undefined);
  assert.strictEqual(packageJson.license, 'UNLICENSED');
});

test('uses a narrow publish allowlist that excludes tests, releases and secrets', () => {
  const files = packageJson.files;
  assert(Array.isArray(files));
  for (const required of [
    'bin/writcraft.js',
    'src/main/**/*.js',
    'src/main/native/*',
    'src/renderer/**/*',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'npm-shrinkwrap.json',
  ]) assert(files.includes(required), `missing ${required}`);
  const serialized = JSON.stringify(files);
  for (const forbidden of ['tests', 'release', 'checkpoints', '.env', 'DEVELOPMENT-STATUS']) {
    assert(!serialized.includes(forbidden), `publish list contains ${forbidden}`);
  }
});

test('ships the complete runtime and three executable universal helper artifacts', () => {
  for (const relative of [
    'src/main/main.js',
    'src/main/preload.js',
    'src/renderer/index.html',
    'src/main/native/author-copy-helper',
    'src/main/native/project-hash-helper',
    'src/main/native/markdown-trash-helper',
  ]) {
    const target = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(target);
    assert(!stat.isSymbolicLink() && stat.isFile(), relative);
    if (relative.includes('/native/')) {
      assert((stat.mode & 0o111) !== 0, `${relative} must be executable`);
      const lipo = childProcess.spawnSync('/usr/bin/lipo', ['-archs', target], { encoding: 'utf8' });
      assert.strictEqual(lipo.status, 0, lipo.stderr);
      assert.deepStrictEqual(new Set(lipo.stdout.trim().split(/\s+/)), new Set(['arm64', 'x86_64']));
    }
  }
});

test('help and version are deterministic and never launch Electron', () => {
  const help = runCli(['--help']);
  assert.strictEqual(help.status, 0);
  assert(help.stdout.includes('npm Developer Preview'));
  assert(help.stdout.includes('--profile <绝对目录>'));
  assert.strictEqual(help.stderr, '');
  const version = runCli(['--version']);
  assert.strictEqual(version.status, 0);
  assert.strictEqual(version.stdout.trim(), packageJson.version);
  assert.strictEqual(version.stderr, '');
  const mainSource = fs.readFileSync(path.join(root, 'src', 'main', 'main.js'), 'utf8');
  assert.strictEqual(
    mainSource.split('if (isNpmPreview && !npmPreviewReady)').length - 1,
    2,
    'preview failure exits must never affect ordinary Electron launches'
  );
});

test('invalid CLI arguments fail closed without forwarding Chromium switches', () => {
  const invalid = runCli(['--inspect=0']);
  assert.strictEqual(invalid.status, 1);
  const payload = JSON.parse(invalid.stderr.trim());
  assert.deepStrictEqual(Object.keys(payload).sort(), ['error', 'message', 'ok', 'schema']);
  assert.strictEqual(payload.error, 'INVALID_ARGUMENT');
  assert.strictEqual(payload.ok, false);
  assert.strictEqual(invalid.stdout, '');
  const npm12 = runCli(['--check'], {
    npm_config_user_agent: 'npm/12.0.0 node/v24.4.1 darwin arm64',
  });
  assert.strictEqual(npm12.status, 1);
  assert.strictEqual(JSON.parse(npm12.stderr).error, 'NPM_VERSION_UNSUPPORTED');

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-cli-profile-')));
  try {
    const privateProfile = path.join(scratch, 'private');
    const publicProfile = path.join(scratch, 'public');
    fs.mkdirSync(privateProfile, { mode: 0o700 });
    fs.mkdirSync(publicProfile, { mode: 0o755 });
    const profileOptions = { homeDirectory: scratch };
    assert.deepStrictEqual(cliModule.validateProfileDirectory(privateProfile, profileOptions), {
      ok: true,
      directory: privateProfile,
    });
    assert.strictEqual(cliModule.validateProfileDirectory('relative', profileOptions).code, 'PROFILE_INVALID');
    assert.strictEqual(cliModule.validateProfileDirectory(publicProfile, profileOptions).code, 'PROFILE_UNSAFE');
    if (process.platform !== 'win32') {
      const link = path.join(scratch, 'link');
      fs.symlinkSync(privateProfile, link);
      assert.strictEqual(cliModule.validateProfileDirectory(link, profileOptions).code, 'PROFILE_UNSAFE');
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('local runtime check is zero-network and exposes no filesystem path', () => {
  const checked = runCli(['--check']);
  assert.strictEqual(checked.status, 0);
  const payload = JSON.parse(checked.stdout.trim());
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    'electronPackageVersion', 'minimumMacosVersion', 'minimumNodeVersion',
    'nodeVersion', 'npmMajor', 'ok', 'platform', 'runtimeReady', 'schema', 'version',
  ]);
  assert.strictEqual(payload.schema, 'writcraft.npm-preview-check/v1');
  assert.strictEqual(payload.ok, true);
  assert.strictEqual(payload.platform, 'darwin');
  assert.strictEqual(payload.version, packageJson.version);
  assert.strictEqual(payload.minimumMacosVersion, '12.0');
  assert.strictEqual(payload.minimumNodeVersion, '22.12.0');
  assert(cliModule.supportsNodeVersion(payload.nodeVersion));
  assert([10, 11].includes(payload.npmMajor));
  assert.strictEqual(payload.electronPackageVersion, packageJson.dependencies.electron);
  assert.strictEqual(typeof payload.runtimeReady, 'boolean');
  assert.strictEqual(checked.stderr, '');
});

test('macOS 11 and runtime-identity overrides fail before Electron resolution', () => {
  const oldMac = cliModule.runtimeCheck({
    platform: 'darwin',
    darwinRelease: '20.6.0',
    env: {},
  });
  assert.deepStrictEqual(oldMac, {
    ok: false,
    code: 'MACOS_VERSION_UNSUPPORTED',
    message: '当前预览版需要 macOS 12.0 或更高版本。',
  });
  for (const key of cliModule.FORBIDDEN_ELECTRON_ENV) {
    const unsafe = cliModule.runtimeCheck({
      platform: 'darwin',
      darwinRelease: '21.0.0',
      env: { [key]: 'attacker-controlled' },
    });
    assert.strictEqual(unsafe.ok, false);
    assert.strictEqual(unsafe.code, 'UNSAFE_ELECTRON_ENV');
  }
  const common = {
    platform: 'darwin',
    darwinRelease: '21.0.0',
    env: { npm_config_user_agent: 'npm/11.16.0 node/v24.4.1 darwin arm64' },
  };
  assert.strictEqual(cliModule.runtimeCheck({
    ...common,
    nodeVersion: '22.11.0',
  }).code, 'NODE_VERSION_UNSUPPORTED');
  assert.strictEqual(cliModule.runtimeCheck({
    ...common,
    nodeVersion: '22.12.0',
    env: { npm_config_user_agent: 'npm/12.0.0 node/v24.4.1 darwin arm64' },
  }).code, 'NPM_VERSION_UNSUPPORTED');
  assert.strictEqual(cliModule.runtimeCheck({
    ...common,
    nodeVersion: '22.12.0',
    env: {},
  }).code, 'NPM_VERSION_UNSUPPORTED');
});

test('actual npm tarball has the shrinkwrap, notices, safe paths and executable modes', () => {
  const report = packDryRun();
  assert.strictEqual(report.name, packageJson.name);
  assert.strictEqual(report.version, packageJson.version);
  assert(report.size > 0 && report.unpackedSize > report.size);
  const files = new Map(report.files.map(file => [file.path, file]));
  for (const required of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'npm-shrinkwrap.json',
    'bin/writcraft.js',
    'src/main/main.js',
    'src/main/native/author-copy-helper',
    'src/main/native/project-hash-helper',
    'src/main/native/markdown-trash-helper',
    'src/renderer/index.html',
  ]) assert(files.has(required), `tarball missing ${required}`);
  for (const file of files.values()) {
    assert(!/(^|\/)(?:tests|fixtures|release|checkpoints)(?:\/|$)/.test(file.path), file.path);
    assert(!/(^|\/)\.env(?:\.|$)/.test(file.path), file.path);
    assert(!file.path.includes('DEVELOPMENT-STATUS'), file.path);
  }
  for (const executable of [
    'bin/writcraft.js',
    'src/main/native/author-copy-helper',
    'src/main/native/project-hash-helper',
    'src/main/native/markdown-trash-helper',
  ]) assert.strictEqual(files.get(executable).mode, 0o755, executable);
  const executablePaths = new Set([
    'bin/writcraft.js',
    'src/main/native/author-copy-helper',
    'src/main/native/project-hash-helper',
    'src/main/native/markdown-trash-helper',
  ]);
  for (const file of files.values()) {
    if (!executablePaths.has(file.path)) {
      assert.strictEqual(file.mode, 0o644, `${file.path} must be world-readable`);
    }
  }

  const shrinkwrap = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
  const installScriptPackages = Object.entries(shrinkwrap.packages)
    .filter(([, record]) => record && record.hasInstallScript === true)
    .map(([packagePath]) => packagePath);
  assert.deepStrictEqual(installScriptPackages, []);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-pack-content-')));
  try {
    const packed = childProcess.spawnSync(
      'npm',
      ['pack', '--json', '--pack-destination', scratch],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, npm_config_loglevel: 'silent' },
        timeout: 30_000,
      }
    );
    assert.strictEqual(packed.status, 0, packed.stderr);
    const actual = JSON.parse(packed.stdout);
    assert(Array.isArray(actual) && actual.length === 1);
    const tarball = path.join(scratch, actual[0].filename);
    for (const file of actual[0].files) {
      const extracted = childProcess.spawnSync(
        '/usr/bin/tar',
        ['-xOf', tarball, `package/${file.path}`],
        { encoding: null, maxBuffer: 10 * 1024 * 1024, timeout: 10_000 }
      );
      assert.strictEqual(extracted.status, 0, file.path);
      const text = extracted.stdout.toString('utf8');
      assert(!text.includes('/Users/maxhou'), file.path);
      assert(!text.includes('/var/folders/df/'), file.path);
      assert(!/sk-(?:api|cp)-[A-Za-z0-9_-]{32,}/.test(text), file.path);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('npm preview documentation states tagged install, macOS and rights boundaries', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert(readme.includes('不是已签名、公证的普通用户安装包'));
  assert(readme.includes('npx writ-craft@preview'));
  assert(readme.includes('macOS 12'));
  assert(readme.includes('--profile'));
  assert(readme.includes('image-01'));
  assert(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('All rights reserved'));
  const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert(notices.includes('jsdiff 9.0.0'));
  assert(notices.includes('Marked 18.0.6'));
});

test('release contract freezes immutable preview versions and a reversible dist-tag rollback', () => {
  const contract = fs.readFileSync(path.join(
    root,
    '..',
    'docs',
    'NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md'
  ), 'utf8');
  assert(contract.includes('npm versions are immutable'));
  assert(contract.includes('npm dist-tag add writ-craft@<known-good-version> preview'));
  assert(contract.includes('Do not use unpublish as the normal rollback mechanism'));
  assert(contract.includes('npx writ-craft@preview'));
});

assert.strictEqual(passed, EXPECTED_CHECKS);
console.log(`\n${passed}/${EXPECTED_CHECKS} npm Developer Preview checks passed; 0 network calls.\n`);
