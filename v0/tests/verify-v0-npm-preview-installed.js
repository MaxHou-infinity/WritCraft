#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const timeoutMs = 45_000;
const npmVersionProbe = childProcess.spawnSync('npm', ['--version'], { encoding: 'utf8' });
const localNpmVersion = npmVersionProbe.status === 0 ? npmVersionProbe.stdout.trim() : '';
const publicPackageSpec = String(
  process.env.WRITCRAFT_NPM_PREVIEW_PACKAGE_SPEC || ''
).trim();
const expectedPublicShasum = String(
  process.env.WRITCRAFT_NPM_PREVIEW_EXPECTED_SHASUM || ''
).trim();
const publicRegistry = 'https://registry.npmjs.org/';
const expectedPublicPackageSpec = `${packageJson.name}@preview`;

assert.strictEqual(
  Boolean(publicPackageSpec),
  Boolean(expectedPublicShasum),
  'PUBLIC_SPEC_AND_SHASUM_MUST_BE_PAIRED'
);
if (publicPackageSpec) {
  assert.strictEqual(
    publicPackageSpec,
    expectedPublicPackageSpec,
    'PUBLIC_PACKAGE_SPEC_MUST_BE_EXACT_PREVIEW'
  );
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    ...options,
  });
}

function assertCommandSucceeded(result, code, privateRoots = []) {
  if (result.status === 0) return;
  let detail = String(result.stderr || result.stdout || '').trim();
  for (const privateRoot of privateRoots) {
    detail = detail.split(privateRoot).join('<temporary>');
  }
  detail = detail.replace(/\/Users\/[^/\s]+/g, '<home>');
  assert.fail(`${code}: exit=${result.status}; ${detail.slice(0, 800) || 'no command output'}`);
}

function safeEnvironment(home) {
  const env = {
    ...process.env,
    HOME: home,
    ELECTRON_GET_NO_PROGRESS: '1',
    electron_config_cache: path.join(os.homedir(), 'Library', 'Caches', 'electron'),
    npm_config_cache: path.join(os.homedir(), '.npm'),
    npm_config_registry: publicRegistry,
    npm_config_user_agent: `npm/${localNpmVersion} node/v${process.versions.node} darwin ${process.arch}`,
  };
  delete env.NPM_CONFIG_REGISTRY;
  for (const key of Object.keys(env)) {
    if (key.startsWith('WRITCRAFT_E2E_')) delete env[key];
  }
  delete env.WRITCRAFT_MINIMAX_KEY;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  delete env.ELECTRON_INSTALL_PLATFORM;
  delete env.ELECTRON_INSTALL_ARCH;
  delete env.ELECTRON_CUSTOM_VERSION;
  delete env.electron_use_remote_checksums;
  delete env.npm_config_electron_use_remote_checksums;
  delete env.npm_config_platform;
  delete env.npm_config_arch;
  delete env.npm_config_allow_scripts;
  delete env.npm_config_dangerously_allow_all_scripts;
  delete env.npm_config_ignore_scripts;
  delete env.npm_config_strict_allow_scripts;
  return env;
}

function processSnapshot() {
  const result = run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { timeout: 5_000 });
  assert.strictEqual(result.status, 0, 'PROCESS_SNAPSHOT_FAILED');
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    }] : [];
  });
}

function descendantsOf(rootPid, processes) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  descendants.delete(rootPid);
  return processes.filter(process => descendants.has(process.pid));
}

function redactedOutput(value, privateRoots = []) {
  let output = String(value || '');
  for (const privateRoot of privateRoots) {
    output = output.split(privateRoot).join('<temporary>');
  }
  return output.replace(/\/Users\/[^/\s]+/g, '<home>').slice(-1200);
}

function captureChildOutput(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => {
      chunks.push(String(chunk));
      while (chunks.join('').length > 2400) chunks.shift();
    });
  }
  return () => chunks.join('');
}

function hasReadyHandshake(output) {
  return output.split('\n').some(line => {
    try {
      return JSON.parse(line).schema === 'writcraft.npm-preview-ready/v1' &&
        JSON.parse(line).ready === true;
    } catch (_) {
      return false;
    }
  });
}

function waitForInstalledRenderer(cli, installRoot, output, privateRoots, spawnFailure) {
  const deadline = Date.now() + timeoutMs;
  const electronMarker = path.join(
    installRoot,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron'
  );
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (cli.exitCode !== null || cli.signalCode !== null) {
          reject(new Error(
            `INSTALLED_CLI_EXITED: code=${cli.exitCode}; signal=${cli.signalCode}; ` +
            redactedOutput(output(), privateRoots)
          ));
          return;
        }
        if (spawnFailure()) {
          reject(new Error(`INSTALLED_CLI_SPAWN_FAILED: ${spawnFailure().code || 'unknown'}`));
          return;
        }
        const descendants = descendantsOf(cli.pid, processSnapshot());
        const main = descendants.find(process => process.command.includes(electronMarker));
        const renderer = descendants.find(process => process.command.includes('--type=renderer'));
        if (main && renderer && hasReadyHandshake(output())) {
          resolve({ main, renderer });
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(
          `INSTALLED_RENDERER_NOT_READY: ${redactedOutput(output(), privateRoots)}`
        ));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CLI_EXIT_TIMEOUT')), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function waitForProcessesGone(processes) {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const current = processSnapshot();
      const stillPresent = processes.some(expected =>
        current.some(process =>
          process.pid === expected.pid && process.command === expected.command));
      if (!stillPresent) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('INSTALLED_CHILDREN_REMAIN'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForProcessGroupChild(processGroup) {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const members = processSnapshot().filter(process =>
        process.pgid === processGroup && process.pid !== processGroup);
      if (members.length > 0) {
        resolve(members);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('EARLY_FAILURE_CHILD_NOT_STARTED'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function waitForProcessGroupGone(processGroup) {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (!processSnapshot().some(process => process.pgid === processGroup)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('EARLY_FAILURE_GROUP_REMAINS'));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function main() {
  assert.strictEqual(process.platform, 'darwin', 'npm preview installed smoke requires macOS');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-npm-installed-'));
  const installRoot = path.join(temporary, 'install');
  const home = path.join(temporary, 'home');
  let cli = null;
  let cliProcessGroup = null;
  try {
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
    const profile = path.join(home, 'WritCraft');
    fs.mkdirSync(profile, { mode: 0o700 });
    const defaultProfile = path.join(home, 'Library', 'Application Support', 'WritCraft');
    assert.strictEqual(fs.existsSync(defaultProfile), false);

    const packArgs = ['pack'];
    const publicPackCache = path.join(temporary, 'public-pack-cache');
    if (publicPackageSpec) {
      fs.mkdirSync(publicPackCache, { mode: 0o700 });
      packArgs.push(
        publicPackageSpec,
        '--ignore-scripts',
        `--registry=${publicRegistry}`,
        `--cache=${publicPackCache}`,
        '--offline=false',
        '--prefer-offline=false'
      );
    }
    packArgs.push('--json', '--pack-destination', temporary);
    const packEnvironment = {
      ...process.env,
      npm_config_loglevel: 'silent',
    };
    delete packEnvironment.npm_config_registry;
    delete packEnvironment.NPM_CONFIG_REGISTRY;
    delete packEnvironment.npm_config_cache;
    delete packEnvironment.NPM_CONFIG_CACHE;
    delete packEnvironment.npm_config_offline;
    delete packEnvironment.NPM_CONFIG_OFFLINE;
    delete packEnvironment.npm_config_prefer_offline;
    delete packEnvironment.NPM_CONFIG_PREFER_OFFLINE;
    const packed = run('npm', packArgs, {
      cwd: root,
      env: packEnvironment,
    });
    assert.strictEqual(packed.status, 0, 'PACK_FAILED');
    const packReport = JSON.parse(packed.stdout);
    assert(Array.isArray(packReport) && packReport.length === 1);
    if (publicPackageSpec) {
      assert.strictEqual(
        packReport[0].id,
        `${packageJson.name}@${packageJson.version}`,
        'PUBLIC_PACKAGE_ID_MISMATCH'
      );
      assert(expectedPublicShasum, 'PUBLIC_SHASUM_REQUIRED');
      assert.strictEqual(
        packReport[0].shasum,
        expectedPublicShasum,
        'PUBLIC_TARBALL_SHASUM_MISMATCH'
      );
    }
    const tarball = path.join(temporary, packReport[0].filename);

    const installed = run('npm', [
      'install',
      '--offline',
      '--no-audit',
      '--no-fund',
      tarball,
    ], {
      cwd: installRoot,
      env: safeEnvironment(home),
    });
    assertCommandSucceeded(installed, 'ISOLATED_INSTALL_FAILED', [temporary]);

    const executable = path.join(installRoot, 'node_modules', '.bin', 'writcraft');
    const before = run(executable, ['--check'], {
      cwd: installRoot,
      env: safeEnvironment(home),
    });
    assert.strictEqual(before.status, 0, 'PRELAUNCH_CHECK_FAILED');
    const beforePayload = JSON.parse(before.stdout);
    assert.strictEqual(beforePayload.version, packageJson.version);
    assert([10, 11].includes(beforePayload.npmMajor));
    assert.strictEqual(beforePayload.runtimeReady, false);

    const failureProfile = path.join(home, 'Early-Failure');
    fs.mkdirSync(failureProfile, { mode: 0o700 });
    const failureProbe = childProcess.spawn(executable, ['--profile', failureProfile], {
      cwd: installRoot,
      env: safeEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    const failureGroup = failureProbe.pid;
    cliProcessGroup = failureGroup;
    let failureSpawnError = null;
    failureProbe.once('error', error => { failureSpawnError = error; });
    captureChildOutput(failureProbe);
    await waitForProcessGroupChild(failureGroup);
    assert.strictEqual(failureSpawnError, null);
    process.kill(-failureGroup, 'SIGKILL');
    await waitForExit(failureProbe);
    await waitForProcessGroupGone(failureGroup);
    cliProcessGroup = null;

    cli = childProcess.spawn(executable, ['--profile', profile], {
      cwd: installRoot,
      env: safeEnvironment(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    cliProcessGroup = cli.pid;
    let cliSpawnFailure = null;
    cli.once('error', error => { cliSpawnFailure = error; });
    const childOutput = captureChildOutput(cli);
    const ready = await waitForInstalledRenderer(
      cli,
      installRoot,
      childOutput,
      [temporary],
      () => cliSpawnFailure
    );
    assert(Number.isSafeInteger(ready.main.pid));
    assert(Number.isSafeInteger(ready.renderer.pid));

    const after = run(executable, ['--check'], {
      cwd: installRoot,
      env: safeEnvironment(home),
    });
    assert.strictEqual(after.status, 0, 'POSTLAUNCH_CHECK_FAILED');
    const afterPayload = JSON.parse(after.stdout);
    assert.strictEqual(afterPayload.runtimeReady, true);
    assert(fs.existsSync(path.join(profile, 'Local Storage')), 'TEMPORARY_USER_DATA_NOT_CREATED');
    assert.strictEqual(fs.existsSync(defaultProfile), false);

    process.kill(cli.pid, 'SIGTERM');
    const exit = await waitForExit(cli);
    assert(exit.signal === 'SIGTERM' || exit.code === 143);
    await waitForProcessesGone([ready.main, ready.renderer]);
    cliProcessGroup = null;
    cli = null;
    console.log('\nWritCraft installed npm preview smoke verification');
    console.log('  ✓ early harness failure removes its whole process group');
    console.log('  ✓ tarball installed offline, acquired Electron from verified cache, observed did-finish-load through Main IPC, and exited through CLI signal forwarding');
    console.log(
      `\n2/2 installed npm preview smoke checks passed; ` +
      `${publicPackageSpec ? 'public registry tarball' : 'local candidate tarball'}, ` +
      `isolated profile, no manuscript opened.\n`
    );
  } finally {
    if (cliProcessGroup) {
      try { process.kill(-cliProcessGroup, 'SIGKILL'); } catch (_) {}
    }
    if (cli && cli.exitCode === null && cli.signalCode === null) {
      try { cli.kill('SIGKILL'); } catch (_) {}
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`\nInstalled npm preview smoke failed: ${error.message}\n`);
  process.exit(1);
});
