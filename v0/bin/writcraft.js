#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const userDataService = require('../src/main/user-data-service');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, 'package.json'));
const MINIMUM_MACOS_VERSION = '12.0';
const MINIMUM_DARWIN_MAJOR = 21;
const MINIMUM_NODE_VERSION = '22.12.0';
const SUPPORTED_NPM_MAJORS = Object.freeze([10, 11]);
const FORBIDDEN_ELECTRON_ENV = Object.freeze([
  'ELECTRON_OVERRIDE_DIST_PATH',
  'ELECTRON_INSTALL_PLATFORM',
  'ELECTRON_INSTALL_ARCH',
  'ELECTRON_CUSTOM_VERSION',
  'electron_use_remote_checksums',
  'npm_config_electron_use_remote_checksums',
  'npm_config_platform',
  'npm_config_arch',
]);
const HELP = [
  '笔触 · WritCraft npm Developer Preview',
  '',
  '用法:',
  '  writcraft            启动桌面编辑器',
  '  writcraft --profile <绝对目录>  使用一个已有的私有配置目录启动',
  '  writcraft --check    检查本机运行条件（不启动、不联网）',
  '  writcraft --version  显示版本',
  '  writcraft --help     显示帮助',
].join('\n');

function validateProfileDirectory(directory, options = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    return { ok: false, code: 'PROFILE_INVALID', message: '配置目录必须是已有的绝对路径。' };
  }
  try {
    const canonical = userDataService.assertPrivateDirectory(directory, options);
    return { ok: true, directory: canonical };
  } catch (_) {
    return { ok: false, code: 'PROFILE_UNSAFE', message: '配置目录不是可信的私有目录。' };
  }
}

function publicFailure(code, message) {
  process.stderr.write(`${JSON.stringify({
    schema: 'writcraft.npm-preview-error/v1',
    ok: false,
    error: code,
    message,
  })}\n`);
  process.exitCode = 1;
}

function supportsNodeVersion(value) {
  const match = String(value || '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 12);
}

function npmMajorFromEnvironment(environment) {
  const match = String(environment?.npm_config_user_agent || '')
    .match(/(?:^|\s)npm\/(\d+)(?:\.\d+){0,2}(?:\s|$)/);
  return match ? Number(match[1]) : null;
}

function runtimeCheck(options = {}) {
  const platform = options.platform || process.platform;
  const darwinRelease = options.darwinRelease || os.release();
  const environment = options.env || process.env;
  if (platform !== 'darwin') {
    return { ok: false, code: 'MACOS_REQUIRED', message: '当前预览版仅支持 macOS。' };
  }
  const darwinMajor = Number.parseInt(String(darwinRelease).split('.')[0], 10);
  if (!Number.isSafeInteger(darwinMajor) || darwinMajor < MINIMUM_DARWIN_MAJOR) {
    return {
      ok: false,
      code: 'MACOS_VERSION_UNSUPPORTED',
      message: `当前预览版需要 macOS ${MINIMUM_MACOS_VERSION} 或更高版本。`,
    };
  }
  if (FORBIDDEN_ELECTRON_ENV.some(key =>
    Object.prototype.hasOwnProperty.call(environment, key) && String(environment[key] || '').length > 0)) {
    return {
      ok: false,
      code: 'UNSAFE_ELECTRON_ENV',
      message: '检测到会改变 Electron 运行时身份的环境配置，请清除后重试。',
    };
  }
  const nodeVersion = options.nodeVersion || process.versions.node;
  if (!supportsNodeVersion(nodeVersion)) {
    return {
      ok: false,
      code: 'NODE_VERSION_UNSUPPORTED',
      message: `当前预览版需要 Node.js ${MINIMUM_NODE_VERSION} 或更高版本。`,
    };
  }
  const npmMajor = npmMajorFromEnvironment(environment);
  if (!SUPPORTED_NPM_MAJORS.includes(npmMajor)) {
    return {
      ok: false,
      code: 'NPM_VERSION_UNSUPPORTED',
      message: '当前预览版必须通过 npm 10 或 npm 11 的 npx 启动。',
    };
  }
  const required = [
    path.join(PACKAGE_ROOT, 'src', 'main', 'main.js'),
    path.join(PACKAGE_ROOT, 'src', 'main', 'preload.js'),
    path.join(PACKAGE_ROOT, 'src', 'renderer', 'index.html'),
    path.join(PACKAGE_ROOT, 'src', 'main', 'native', 'author-copy-helper'),
    path.join(PACKAGE_ROOT, 'src', 'main', 'native', 'project-hash-helper'),
    path.join(PACKAGE_ROOT, 'src', 'main', 'native', 'markdown-trash-helper'),
  ];
  for (const target of required) {
    let stat;
    try { stat = fs.lstatSync(target); } catch (_) {
      return { ok: false, code: 'PACKAGE_INCOMPLETE', message: 'npm 包缺少运行文件，请重新安装。' };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, code: 'PACKAGE_UNSAFE', message: 'npm 包运行文件不可信，请重新安装。' };
    }
  }
  let electronPackagePath;
  let electronPackage;
  try {
    electronPackagePath = require.resolve('electron/package.json');
    electronPackage = require(electronPackagePath);
  } catch (_) {
    return { ok: false, code: 'ELECTRON_MISSING', message: 'Electron 运行时未正确安装，请重新安装 npm 包。' };
  }
  if (electronPackage?.version !== PACKAGE_JSON.dependencies.electron) {
    return { ok: false, code: 'ELECTRON_INVALID', message: 'Electron 运行时版本不匹配，请重新安装 npm 包。' };
  }
  const electronRoot = path.dirname(electronPackagePath);
  let runtimeReady = false;
  try {
    const executable = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim();
    runtimeReady = Boolean(executable) && fs.existsSync(path.join(electronRoot, 'dist', executable));
  } catch (_) {}
  return {
    ok: true,
    electronPackageVersion: electronPackage.version,
    nodeVersion: String(nodeVersion).replace(/^v/, ''),
    npmMajor,
    runtimeReady,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    process.stdout.write(`${PACKAGE_JSON.version}\n`);
    return;
  }
  const profileRequest = args.length === 2 && args[0] === '--profile'
    ? validateProfileDirectory(args[1])
    : null;
  if (profileRequest && !profileRequest.ok) {
    publicFailure(profileRequest.code, profileRequest.message);
    return;
  }
  if ((!profileRequest && args.length > 1) ||
      (args.length === 1 && args[0] !== '--check')) {
    publicFailure('INVALID_ARGUMENT', '只支持 --check、--version、--help 和 --profile <绝对目录>。');
    return;
  }

  const checked = runtimeCheck();
  if (!checked.ok) {
    publicFailure(checked.code, checked.message);
    return;
  }
  if (args[0] === '--check') {
    process.stdout.write(`${JSON.stringify({
      schema: 'writcraft.npm-preview-check/v1',
      ok: true,
      platform: 'darwin',
      version: PACKAGE_JSON.version,
      minimumMacosVersion: MINIMUM_MACOS_VERSION,
      minimumNodeVersion: MINIMUM_NODE_VERSION,
      nodeVersion: checked.nodeVersion,
      npmMajor: checked.npmMajor,
      electronPackageVersion: checked.electronPackageVersion,
      runtimeReady: checked.runtimeReady,
    })}\n`);
    return;
  }

  let electronPath;
  try { electronPath = require('electron'); } catch (_) {
    publicFailure('ELECTRON_DOWNLOAD_FAILED', 'Electron 官方运行时下载失败，请检查网络后重新启动。');
    return;
  }
  if (typeof electronPath !== 'string' || !path.isAbsolute(electronPath)) {
    publicFailure('ELECTRON_INVALID', 'Electron 运行时路径无效，请重新安装 npm 包。');
    return;
  }

  const env = { ...process.env, WRITCRAFT_NPM_PREVIEW: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.WRITCRAFT_E2E_AI_FIXTURE;
  delete env.WRITCRAFT_E2E_USER_DATA;
  delete env.WRITCRAFT_E2E_FORCE;
  delete env.WRITCRAFT_E2E_WATCHER_FAILURE;
  delete env.WRITCRAFT_NPM_PREVIEW_PROFILE;
  for (const key of FORBIDDEN_ELECTRON_ENV) delete env[key];
  if (profileRequest) env.WRITCRAFT_NPM_PREVIEW_PROFILE = profileRequest.directory;

  let child;
  try {
    child = childProcess.spawn(electronPath, [PACKAGE_ROOT], {
      cwd: PACKAGE_ROOT,
      env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      shell: false,
    });
  } catch (_) {
    publicFailure('LAUNCH_FAILED', '无法启动笔触，请重新安装 npm 包。');
    return;
  }

  let settled = false;
  let forwardedSignal = null;
  let forceKillTimer = null;
  const signalHandlers = new Map();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    signalHandlers.clear();
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = null;
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      if (forwardedSignal) return;
      forwardedSignal = signal;
      try { child.kill(signal); } catch (_) {}
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 5_000);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  child.on('message', message => {
    if (!message || message.schema !== 'writcraft.npm-preview-renderer/v1') return;
    if (message.status === 'ready') {
      process.stdout.write(`${JSON.stringify({
        schema: 'writcraft.npm-preview-ready/v1',
        ready: true,
      })}\n`);
    }
  });
  child.once('error', () => {
    if (settled) return;
    settled = true;
    removeSignalHandlers();
    publicFailure('LAUNCH_FAILED', '无法启动笔触，请重新安装 npm 包。');
  });
  child.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    removeSignalHandlers();
    if (forwardedSignal) {
      try { process.kill(process.pid, forwardedSignal); } catch (_) {
        process.exitCode = 1;
      }
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
}

if (require.main === module) main();

module.exports = {
  FORBIDDEN_ELECTRON_ENV,
  HELP,
  MINIMUM_MACOS_VERSION,
  MINIMUM_NODE_VERSION,
  SUPPORTED_NPM_MAJORS,
  npmMajorFromEnvironment,
  runtimeCheck,
  supportsNodeVersion,
  validateProfileDirectory,
};
