#!/usr/bin/env node
'use strict';

// Real Electron smoke/E2E harness without Playwright or product-side hooks.
// It launches the packaged Electron runtime, connects to the actual
// BrowserWindow through Chromium DevTools Protocol, and keeps all profile
// state inside a disposable OS temporary directory.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const projectService = require('../src/main/project-service');
const changeHistoryService = require('../src/main/change-history-service');
const changeSetService = require('../src/main/changeset-service');
const {
  createChangesHistoryTransaction,
} = require('../src/main/changes-history-transaction');
const longformFixture = require('./fixtures/writcraft-longform-project');
const electronAiFixture = require('./fixtures/electron-ai-provider');

const APP_ROOT = path.resolve(__dirname, '..');
const ENTRY_PATH = path.join(APP_ROOT, 'src', 'renderer', 'index.html');
const START_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 8_000;
const MAX_PROCESS_LOG_CHARS = 16_000;
const RELEASE_REQUIRED = process.env.WRITCRAFT_E2E_FORCE === '1' || process.env.CI === 'true';
const LARGE_GRAPH_FILE_COUNT = 300;
const GRAPH_COLD_BUDGET_MS = 2500;
const GRAPH_CACHE_BUDGET_MS = 700;
const GRAPH_INCREMENTAL_BUDGET_MS = 800;
const GRAPH_INTERACTION_BUDGET_MS = 100;
const GRAPH_RENDERER_HEAP_BUDGET_BYTES = 150 * 1024 * 1024;

let passed = 0;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function boundedLog(value) {
  const text = String(value || '');
  return text.length <= MAX_PROCESS_LOG_CHARS ? text : text.slice(-MAX_PROCESS_LOG_CHARS);
}

function skipReason() {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return 'Linux session has no DISPLAY/WAYLAND_DISPLAY';
  }
  return null;
}

function knownGuiFailure(log) {
  return /Missing X server|Unable to open X display|ozone_platform_x11|No protocol specified|WindowServer|window server is not available/i.test(log);
}

async function stage(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function snapshotMarkdownFiles(rootPath) {
  const paths = [];
  const visit = nodes => {
    for (const node of nodes || []) {
      if (node?.type === 'directory') visit(node.children);
      else if (node?.type === 'file' && /\.(?:md|markdown)$/i.test(String(node.path || ''))) paths.push(node.path);
    }
  };
  visit(projectService.listTree(rootPath));
  return paths.sort().map(filePath => [filePath, projectService.readFile(rootPath, filePath)]);
}

function recoveryChangeSet(rootPath, paths, suffix) {
  const snapshots = paths.map(filePath => {
    const file = projectService.readFileWithRevision(rootPath, filePath);
    return { path: filePath, content: file.content, revision: file.revision };
  });
  return {
    snapshots,
    changeSet: changeSetService.createChangeSet(
      snapshots,
      snapshots.map(file => ({
        path: file.path,
        after: `${file.content}\n\n${suffix} ${file.path}\n`,
        summary: 'Electron Changes/History recovery journey',
      }))
    ),
  };
}

function createMixedChangesHistoryRecovery(rootPath, projectId, paths, suffix) {
  const prepared = recoveryChangeSet(rootPath, paths, suffix);
  let writes = 0;
  const flakyProjectService = {
    ...projectService,
    atomicWriteFile(...args) {
      writes += 1;
      if (writes === 2) {
        throw Object.assign(new Error('E2E injected second-file failure'), {
          code: 'E2E_SECOND_WRITE_FAILED',
        });
      }
      if (writes === 3) {
        throw Object.assign(new Error('E2E injected rollback failure'), {
          code: 'E2E_ROLLBACK_FAILED',
        });
      }
      return projectService.atomicWriteFile(...args);
    },
  };
  const transaction = createChangesHistoryTransaction({
    projectService: flakyProjectService,
  });
  const result = transaction.apply({
    rootPath,
    projectId,
    changeSet: prepared.changeSet,
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.status, 'manual_recovery');
  return { ...prepared, result };
}

function seedLargeGraphFiles(rootPath) {
  fs.mkdirSync(path.join(rootPath, 'large-graph'));
  for (let index = 0; index < LARGE_GRAPH_FILE_COUNT; index += 1) {
    const serial = String(index + 1).padStart(3, '0');
    projectService.createMarkdownFile(rootPath, `large-graph/node-${serial}.md`, [
      `# 大图章${serial}`,
      ...(index === 0 ? ['人物：周鹭、沈砚'] : []),
      `角色${serial}的年龄是31岁。`,
      `指标${serial}为1。`,
      '2026年1月1日。',
      '',
    ].join('\n'));
  }
}

async function withRejectedSymlink(filePath, action) {
  const backupPath = `${filePath}.e2e-backup-${process.pid}-${Date.now()}`;
  const initial = fs.lstatSync(filePath);
  assert(initial.isFile() && !initial.isSymbolicLink(), `${filePath} must begin as a regular file`);
  fs.renameSync(filePath, backupPath);
  try {
    fs.symlinkSync(backupPath, filePath);
    return await action();
  } finally {
    try { fs.unlinkSync(filePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error('CDP discovery response too large'));
      });
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`CDP discovery HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('CDP discovery returned invalid JSON')); }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error('CDP discovery timeout')));
    request.once('error', reject);
  });
}

async function discoverPage(port, child, logRef) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      const error = new Error(`Electron exited before BrowserWindow discovery (${child.exitCode ?? child.signalCode})`);
      error.processLog = boundedLog(logRef.value);
      throw error;
    }
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const error = new Error(`Timed out waiting for Electron BrowserWindow${lastError ? `: ${lastError.message}` : ''}`);
  error.processLog = boundedLog(logRef.value);
  throw error;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.failure = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket connection timeout')), COMMAND_TIMEOUT_MS);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed')); }, { once: true });
    });
    this.socket.addEventListener('message', event => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => {
      this.abort(this.failure || new Error('CDP WebSocket closed'));
    });
  }

  abort(error) {
    if (!this.failure) this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }

  handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  command(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`Renderer evaluation failed: ${result.exceptionDetails.text}`);
    return result.result?.value;
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function waitForRenderer(client) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await client.evaluate(`Boolean(
      document.readyState === 'complete' &&
      window.__editor &&
      window.__assistantDock &&
      document.querySelectorAll('[data-assistant-mode]').length === 4
    )`).catch(() => false);
    if (ready) return;
    await delay(100);
  }
  throw new Error('Renderer did not reach the expected runtime-ready state');
}

async function waitForValue(client, expression, description, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(expression).catch(() => null);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function pressKey(client, key) {
  const descriptors = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
    ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 },
    '+': { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187 },
    '-': { key: '-', code: 'Minus', windowsVirtualKeyCode: 189, nativeVirtualKeyCode: 189 },
  };
  const descriptor = descriptors[key] || {
    key, code: key, windowsVirtualKeyCode: key.charCodeAt(0), nativeVirtualKeyCode: key.charCodeAt(0),
  };
  await client.command('Input.dispatchKeyEvent', { type: 'keyDown', ...descriptor });
  await client.command('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor });
}

async function waitForProject(client, expectedChapterCount = 6) {
  return waitForValue(client, `(() => {
    const state = window.__workspace?.state;
    const chapterCount = document.querySelectorAll('.tree-file[data-path^="chapters/"]').length;
    if (!state?.project || !state.currentPath || chapterCount < ${expectedChapterCount}) return null;
    return {
      name: state.project.name,
      currentPath: state.currentPath,
      chapterCount,
      treeFileCount: document.querySelectorAll('.tree-file[data-path]').length,
    };
  })()`, 'the recent long-form project to enter the workspace');
}

async function waitForExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron did not exit within timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopElectron(instance) {
  if (!instance) return null;
  const { child, client } = instance;
  instance.stopping = true;
  if (child.exitCode !== null || child.signalCode) {
    client?.close();
    return { code: child.exitCode, signal: child.signalCode };
  }
  try {
    // Browser.close exercises Electron/Chromium's real shutdown path and gives
    // Chromium a chance to flush localStorage before the restart assertion.
    await client.command('Browser.close', {}, 2000).catch(() => {});
    const exited = await waitForExit(child, EXIT_TIMEOUT_MS).catch(() => null);
    if (exited) return exited;
  } finally {
    client.close();
  }
  child.kill('SIGTERM');
  const terminated = await waitForExit(child, 3000).catch(() => null);
  if (terminated) return terminated;
  child.kill('SIGKILL');
  return waitForExit(child, 3000);
}

function seedRecentProject(profileRoot, rootPath) {
  const home = path.join(profileRoot, 'home');
  const xdg = path.join(profileRoot, 'xdg-config');
  const chromiumUserData = path.join(profileRoot, 'chromium-user-data');
  const candidates = new Set([
    chromiumUserData,
    path.join(home, 'Library', 'Application Support', 'writ-craft'),
    path.join(home, 'Library', 'Application Support', 'Electron'),
    path.join(xdg, 'writ-craft'),
    path.join(xdg, 'Electron'),
  ]);
  for (const directory of candidates) {
    fs.mkdirSync(directory, { recursive: true });
    projectService.saveRecentProject(directory, rootPath);
  }
}

async function launchElectron(profileRoot, recentProjectRoot, options = {}) {
  const electronPath = require('electron');
  const port = await reservePort();
  const userData = path.join(profileRoot, 'chromium-user-data');
  const home = path.join(profileRoot, 'home');
  const xdg = path.join(profileRoot, 'xdg-config');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  if (recentProjectRoot) seedRecentProject(profileRoot, recentProjectRoot);

  const args = [
    APP_ROOT,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost',
  ];
  const child = spawn(electronPath, args, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      WRITCRAFT_MINIMAX_KEY: '',
      WRITCRAFT_E2E_AI_FIXTURE: options.aiFixture === false ? '' : '1',
      WRITCRAFT_E2E_USER_DATA: '1',
      WRITCRAFT_E2E_WATCHER_FAILURE: options.watcherFailure === true ? '1' : '',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logRef = { value: '' };
  const capture = chunk => { logRef.value = boundedLog(logRef.value + chunk); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let page;
  try {
    page = await discoverPage(port, child, logRef);
  } catch (error) {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await waitForExit(child, 3000).catch(() => {});
    throw error;
  }
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.connect();
  const networkRequests = [];
  client.on('Network.requestWillBeSent', event => networkRequests.push(event.request?.url || ''));
  await Promise.all([
    client.command('Runtime.enable'),
    client.command('Page.enable'),
    client.command('Network.enable'),
  ]);
  // Discovery attaches after Chromium's first navigation. Reload only after
  // Network is enabled so the release assertion observes the complete
  // renderer entry/resource lifecycle instead of only late requests.
  await client.command('Page.reload', { ignoreCache: true });
  await waitForRenderer(client);
  const instance = {
    child,
    client,
    page,
    logRef,
    networkRequests,
    profileRoot,
    userData,
    stopping: false,
  };
  child.once('exit', (code, signal) => {
    if (instance.stopping) return;
    const error = new Error(`Electron exited unexpectedly (${code ?? signal ?? 'unknown'})`);
    error.processLog = boundedLog(logRef.value);
    client.abort(error);
  });
  return instance;
}

async function inspectRuntime(instance) {
  return instance.client.evaluate(`(() => ({
    href: location.href,
    protocol: location.protocol,
    title: document.title,
    readyState: document.readyState,
    bookmarks: [...document.querySelectorAll('[data-assistant-mode]')].map(button => ({
      mode: button.dataset.assistantMode,
      label: button.textContent.trim(),
      role: button.getAttribute('role'),
      controls: button.getAttribute('aria-controls'),
    })),
    panels: [...document.querySelectorAll('[data-assistant-panel]')].map(panel => ({
      mode: panel.dataset.assistantPanel,
      role: panel.getAttribute('role'),
      labelledBy: panel.getAttribute('aria-labelledby'),
    })),
    dockMode: window.__assistantDock.getMode(),
    dockHidden: document.getElementById('assistant-dock').hidden,
    contextIsolation: typeof window.process === 'undefined' && typeof window.require === 'undefined',
    bridgeReady: Boolean(window.writCraft && window.writCraft.project),
    resourceUrls: performance.getEntriesByType('resource').map(entry => entry.name),
    loadedAssetUrls: [
      ...[...document.scripts].map(node => node.src),
      ...[...document.querySelectorAll('link[href]')].map(node => node.href),
      ...[...document.images].map(node => node.src),
    ].filter(Boolean),
  }))()`);
}

async function run() {
  console.log('\nWritCraft real Electron BrowserWindow E2E verification');

  // Prove the fixture is a Main-only development dependency before launching
  // the GUI. Unknown requests must fail closed instead of becoming a generic
  // mock that accidentally masks a new production AI path.
  const mainSource = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(APP_ROOT, 'src', 'main', 'preload.js'), 'utf8');
  assert(mainSource.includes("!app.isPackaged && process.env.WRITCRAFT_E2E_AI_FIXTURE === '1'"));
  assert.strictEqual(preloadSource.includes('WRITCRAFT_E2E_AI_FIXTURE'), false);
  const closedProvider = electronAiFixture.createElectronAiProvider();
  await assert.rejects(() => closedProvider.textFetch(electronAiFixture.TEXT_ENDPOINT, {
    method: 'POST', redirect: 'error', body: JSON.stringify({
      model: 'MiniMax-M3', messages: [{ role: 'user', content: 'unknown fixture request' }],
    }),
  }), /E2E_FIXTURE_UNHANDLED_TEXT/);
  await assert.rejects(() => closedProvider.imageFetch(electronAiFixture.IMAGE_ENDPOINT, {
    method: 'POST', redirect: 'error', body: JSON.stringify({
      model: 'image-01', prompt: 'unknown fixture request', response_format: 'base64', n: 1, aspect_ratio: '1:1',
    }),
  }), /E2E_FIXTURE_UNHANDLED_IMAGE/);

  const unavailable = skipReason();
  if (unavailable && !RELEASE_REQUIRED) {
    console.log(`\n⏭ SKIP: ${unavailable}. Set WRITCRAFT_E2E_FORCE=1 to require launch.`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-electron-e2e-'));
  const project = longformFixture.buildLongformProject({ parentPath: scratch, projectService });
  seedLargeGraphFiles(project.rootPath);
  const createdPath = 'chapters/07-electron-e2e.md';
  const changesSecondPath = electronAiFixture.CHANGES_SECOND_PATH;
  const changesSecondInitial = projectService.readFile(project.rootPath, changesSecondPath);
  fs.writeFileSync(
    path.join(project.rootPath, ...changesSecondPath.split('/')),
    `${changesSecondInitial}\n\n${electronAiFixture.CHANGES_BEFORE[2]}\n`,
    'utf8'
  );
  const marker = `Electron project lifecycle ${process.pid}-${Date.now()}`;
  const createdContent = [
    '# Electron E2E', marker,
    electronAiFixture.REWRITE_BEFORE,
    electronAiFixture.REWRITE_TARGET,
    electronAiFixture.REWRITE_AFTER,
    electronAiFixture.REWRITE_FAR,
    electronAiFixture.CHANGES_BEFORE[0],
    ...Array.from({ length: 12 }, (_, index) => `E2E_CHANGES_FILLER_A_${index + 1}`),
    electronAiFixture.CHANGES_BEFORE[1],
    ...Array.from({ length: 12 }, (_, index) => `E2E_CHANGES_FILLER_B_${index + 1}`),
    electronAiFixture.PLAN_BEFORE,
    electronAiFixture.PROPOSAL_RACE_BEFORE,
  ].join('\n\n');
  const changesReviewFixture = [
    electronAiFixture.CHANGES_BEFORE[0],
    ...Array.from({ length: 12 }, (_, index) => `E2E_CHANGES_FILLER_A_${index + 1}`),
    electronAiFixture.CHANGES_BEFORE[1],
    ...Array.from({ length: 12 }, (_, index) => `E2E_CHANGES_FILLER_B_${index + 1}`),
    electronAiFixture.PLAN_BEFORE,
    electronAiFixture.PROPOSAL_RACE_BEFORE,
  ].join('\n\n');
  let first = null;
  let second = null;
  let productionProfile = null;
  let imageReviewEvidenceAfterDelete = null;
  try {
    try {
      first = await launchElectron(scratch, project.rootPath);
    } catch (error) {
      const log = error.processLog || '';
      if (knownGuiFailure(log) && !RELEASE_REQUIRED) {
        console.log(`\n⏭ SKIP: Electron GUI is unavailable in this session. ${boundedLog(log)}`);
        return;
      }
      throw error;
    }

    const coldProject = await waitForProject(first.client, 6);

    await stage('cold-starts a real six-chapter project at the local file entry', async () => {
      const runtime = await inspectRuntime(first);
      assert.strictEqual(runtime.protocol, 'file:');
      assert.strictEqual(decodeURIComponent(new URL(runtime.href).pathname), ENTRY_PATH);
      assert.strictEqual(runtime.title, '笔触 · WritCraft');
      assert.strictEqual(runtime.readyState, 'complete');
      assert.strictEqual(runtime.contextIsolation, true);
      assert.strictEqual(runtime.bridgeReady, true);
      assert.strictEqual(coldProject.chapterCount, 6);
      assert(coldProject.treeFileCount >= 9);
      assert.strictEqual(coldProject.currentPath, 'edit.md');
    });

    await stage('keeps Onboarding v2 strict, separates edit.md apply from one-time atomic initial-file confirmation', async () => {
      const beforeDisk = projectService.readFile(project.rootPath, 'edit.md');
      const firstPath = path.join(project.rootPath, 'onboarding-a.md');
      const secondPath = path.join(project.rootPath, 'onboarding-b.md');
      await first.client.evaluate(`(() => {
        window.__workspace.openProjectOnboarding();
        window.__workspace.state.onboardingController.setSession({
          status: 'review', currentIndex: 9,
          answers: { premise: ${JSON.stringify(electronAiFixture.ONBOARDING_CHANGED_REQUEST)} },
          skipped: ['audience','objective','scope','structure','voice','invariants','timeline','sources','openQuestions']
        });
        const button = [...document.querySelectorAll('.onboarding-button-primary')]
          .find(node => node.textContent.includes('生成 edit.md 提案'));
        button.click();
      })()`);
      const recoverable = await waitForValue(first.client, `(() => {
        const button = [...document.querySelectorAll('.onboarding-button-primary')]
          .find(node => node.textContent.includes('重新整理 edit.md'));
        const answer = document.querySelector('.onboarding-review-answer')?.textContent || '';
        const live = document.querySelector('.onboarding-live')?.textContent || '';
        return button && answer.includes('真实 GUI') && live.includes('保留')
          ? { answer, live, changesMode: window.__assistantDock.getMode() === 'changes' }
          : null;
      })()`, 'strict malformed project-card failure without automatic repair');
      assert(recoverable.answer.includes(electronAiFixture.ONBOARDING_CHANGED_REQUEST));
      assert.strictEqual(recoverable.changesMode, false, 'malformed v2 output must not enter Changes');
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), beforeDisk);
      assert.strictEqual(fs.existsSync(firstPath), false);
      assert.strictEqual(fs.existsSync(secondPath), false);

      // The fixture returns malformed JSON once. Remaining on the explicit
      // retry state proves Main did not silently invoke a repair-model pass.
      await delay(250);
      assert.strictEqual(await first.client.evaluate(`Boolean([...document.querySelectorAll('.onboarding-button-primary')]
        .find(node => node.textContent.includes('重新整理 edit.md')))`) , true);

      await first.client.evaluate(`([...document.querySelectorAll('.onboarding-button-primary')]
        .find(node => node.textContent.includes('重新整理 edit.md'))).click()`);
      const previewState = await waitForValue(first.client, `(() => {
        const notice = document.getElementById('changes-commit-notice');
        const apply = document.getElementById('changes-apply');
        if (window.__assistantDock.getMode() !== 'changes' || notice.hidden || !apply.textContent.includes('提交 edit.md 审阅决定')) return null;
        const suggestions = [...document.querySelectorAll('[data-onboarding-path]')]
          .map(node => ({ path: node.dataset.onboardingPath, checked: node.checked }));
        return suggestions.length === 2 ? { notice: notice.textContent, apply: apply.textContent, suggestions } : null;
      })()`, 'review-only Onboarding v2 edit.md ChangeSet');
      assert(previewState.notice.includes('edit.md 修改待确认'));
      assert(previewState.notice.includes('提交 edit.md 不会创建任何初始文件'));
      assert(previewState.apply.includes('提交 edit.md 审阅决定'));
      assert.deepStrictEqual(previewState.suggestions.map(item => item.path), ['onboarding-a.md', 'onboarding-b.md']);
      assert(previewState.suggestions.every(item => item.checked));
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), beforeDisk);
      assert.strictEqual(fs.existsSync(firstPath), false);
      assert.strictEqual(fs.existsSync(secondPath), false);

      await first.client.evaluate(`(() => {
        document.querySelector('.change-file-actions .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      const editApplied = await waitForValue(first.client, `(() => {
        const summary = document.querySelector('.onboarding-confirmation-summary')?.textContent || '';
        const confirm = [...document.querySelectorAll('button')]
          .find(node => node.textContent.includes('确认创建所选初始文件'));
        return summary.includes('edit.md') && summary.includes('初始文件尚未创建') && confirm && !confirm.disabled
          ? { summary, confirm: confirm.textContent, currentPath: window.__workspace.state.currentPath }
          : null;
      })()`, 'independent initial-file confirmation after edit.md apply');
      assert.strictEqual(editApplied.currentPath, 'edit.md');
      const afterDisk = projectService.readFile(project.rootPath, 'edit.md');
      assert(afterDisk.includes(electronAiFixture.ONBOARDING_MARKER));
      assert.notStrictEqual(afterDisk, beforeDisk);
      assert.strictEqual(fs.existsSync(firstPath), false, 'applying edit.md must not create any suggested file');
      assert.strictEqual(fs.existsSync(secondPath), false, 'applying edit.md must not create any suggested file');

      fs.writeFileSync(secondPath, '# 外部冲突文件\n', 'utf8');
      await first.client.evaluate(`([...document.querySelectorAll('button')]
        .find(node => node.textContent.includes('确认创建所选初始文件'))).click()`);
      const atomicFailure = await waitForValue(first.client, `(() => {
        const status = document.getElementById('changes-status')?.textContent || '';
        const preview = document.querySelector('#changes-preview .tree-empty')?.textContent || '';
        const retry = [...document.querySelectorAll('button')]
          .find(node => node.textContent.includes('确认创建所选初始文件') && !node.disabled);
        return status.includes('初始文件') && preview.includes('零部分创建') &&
          preview.includes('重新整理项目卡') && !retry
          ? { status, preview, retryable: Boolean(retry) }
          : null;
      })()`, 'terminal atomic conflict after second confirmation');
      assert.strictEqual(atomicFailure.retryable, false);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), afterDisk, 'batch failure must preserve applied edit.md');
      assert.strictEqual(fs.existsSync(firstPath), false, 'batch conflict must not partially create an earlier suggestion');
      assert.strictEqual(fs.readFileSync(secondPath, 'utf8'), '# 外部冲突文件\n', 'external conflict must not be overwritten');

      const generationBeforeConflictCleanup = await first.client.evaluate(
        `window.__workspace.state.aiContextGeneration`
      );
      fs.unlinkSync(secondPath);
      await waitForValue(first.client, `(() => {
        const state = window.__workspace?.state;
        if (!state || state.aiContextGeneration <= ${JSON.stringify(generationBeforeConflictCleanup)}) return null;
        return Promise.resolve(state.externalQueue).then(() =>
          state.aiContextGeneration > ${JSON.stringify(generationBeforeConflictCleanup)} ? true : null
        );
      })()`, 'external conflict cleanup to settle before minting a fresh Onboarding capability');
      await first.client.evaluate(`(() => {
        window.__workspace.openProjectOnboarding();
        window.__workspace.state.onboardingController.setSession({
          status: 'review', currentIndex: 9,
          answers: { premise: ${JSON.stringify(electronAiFixture.ONBOARDING_CHANGED_REQUEST)} },
          skipped: ['audience','objective','scope','structure','voice','invariants','timeline','sources','openQuestions']
        });
        [...document.querySelectorAll('.onboarding-button-primary')]
          .find(node => node.textContent.includes('生成 edit.md 提案')).click();
      })()`);
      await waitForValue(first.client, `(() => {
        const apply = document.getElementById('changes-apply');
        const suggestions = [...document.querySelectorAll('[data-onboarding-path]:checked')];
        return window.__assistantDock.getMode() === 'changes' &&
          apply?.textContent.includes('提交 edit.md 审阅决定') && suggestions.length === 2;
      })()`, 'fresh Onboarding v2 proposal and token after conflict');
      assert.strictEqual(fs.existsSync(firstPath), false);
      assert.strictEqual(fs.existsSync(secondPath), false);

      await first.client.evaluate(`(() => {
        document.querySelector('.change-file-actions .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const confirm = [...document.querySelectorAll('button')]
          .find(node => node.textContent.includes('确认创建所选初始文件'));
        return confirm && !confirm.disabled ? true : null;
      })()`, 'fresh one-time initial-file confirmation');
      assert.strictEqual(fs.existsSync(firstPath), false);
      assert.strictEqual(fs.existsSync(secondPath), false);

      await first.client.evaluate(`([...document.querySelectorAll('button')]
        .find(node => node.textContent.includes('确认创建所选初始文件'))).click()`);
      let created;
      try {
        created = await waitForValue(first.client, `(() => {
          const status = document.getElementById('changes-status')?.textContent || '';
          const preview = document.querySelector('#changes-preview .tree-empty')?.textContent || '';
          const retry = [...document.querySelectorAll('button')]
            .find(node => node.textContent.includes('确认创建所选初始文件') && !node.disabled);
          return status.includes('初始文件') && preview.includes('已创建 2 个初始文件') && !retry
            ? { status, preview, retryable: Boolean(retry) }
            : null;
        })()`, 'one-time atomic creation of both selected templates');
      } catch (error) {
        const diagnostic = await first.client.evaluate(`(() => ({
          status: document.getElementById('changes-status')?.textContent || '',
          preview: document.querySelector('#changes-preview .tree-empty')?.textContent || '',
          apply: document.getElementById('changes-apply')?.textContent || '',
          applyHidden: Boolean(document.getElementById('changes-apply')?.hidden),
          applyDisabled: Boolean(document.getElementById('changes-apply')?.disabled),
        }))()`);
        error.message += `; renderer state=${JSON.stringify(diagnostic)}`;
        throw error;
      }
      assert.strictEqual(created.retryable, false);
      assert.strictEqual(projectService.readFile(project.rootPath, 'onboarding-a.md'), '# 项目卡初始文件 A\n\n');
      assert.strictEqual(projectService.readFile(project.rootPath, 'onboarding-b.md'), '# 项目卡初始文件 B\n\n');
      const rerunEdit = projectService.readFile(project.rootPath, 'edit.md');
      assert.strictEqual(rerunEdit.split(electronAiFixture.ONBOARDING_MARKER).length - 1, 1,
        'the first reviewed edit.md marker must survive exactly once');
      assert.strictEqual(rerunEdit.split(electronAiFixture.ONBOARDING_RERUN_MARKER).length - 1, 1,
        'the rerun marker must be applied exactly once');

      const beforeNoOpEdit = projectService.readFile(project.rootPath, 'edit.md');
      const beforeNoOpFirst = projectService.readFile(project.rootPath, 'onboarding-a.md');
      const beforeNoOpSecond = projectService.readFile(project.rootPath, 'onboarding-b.md');
      const wizardSubmission = await first.client.evaluate(`(() => {
        if (!window.__workspace.openProjectOnboarding()) return { ok: false, reason: 'open_failed' };
        const visited = [];
        const firstQuestion = document.querySelector('.onboarding-eyebrow')?.textContent || '';
        visited.push(firstQuestion);
        const textarea = document.querySelector('.onboarding-answer');
        textarea.value = ${JSON.stringify(electronAiFixture.ONBOARDING_NOOP_REQUEST)};
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const next = [...document.querySelectorAll('.onboarding-button-primary')]
          .find(node => node.textContent.trim() === '继续');
        if (!next) return { ok: false, reason: 'next_missing', visited };
        next.click();
        for (let index = 1; index < 10; index += 1) {
          visited.push(document.querySelector('.onboarding-eyebrow')?.textContent || '');
          const skip = [...document.querySelectorAll('.onboarding-button-quiet')]
            .find(node => node.textContent.includes('暂时跳过'));
          if (!skip) return { ok: false, reason: 'skip_missing', visited };
          skip.click();
        }
        const reviewItems = [...document.querySelectorAll('.onboarding-review-item')];
        const originalAccept = window.__changesView.acceptProposal;
        window.__changesView.acceptProposal = result => {
          window.__e2eOnboardingNoOpConfirmation = result?.onboardingConfirmation || null;
          window.__changesView.acceptProposal = originalAccept;
          return originalAccept(result);
        };
        const generate = [...document.querySelectorAll('.onboarding-button-primary')]
          .find(node => node.textContent.includes('生成 edit.md 提案'));
        if (!generate) return { ok: false, reason: 'generate_missing', visited, reviewCount: reviewItems.length };
        generate.click();
        return {
          ok: true,
          visited,
          reviewCount: reviewItems.length,
          firstAnswer: reviewItems[0]?.querySelector('.onboarding-review-answer')?.textContent || '',
        };
      })()`);
      assert.strictEqual(wizardSubmission.ok, true, JSON.stringify(wizardSubmission));
      assert.strictEqual(wizardSubmission.visited.length, 10, 'the no-op request must traverse all ten real wizard questions');
      assert.strictEqual(wizardSubmission.reviewCount, 10, 'the real review screen must render all ten answers/skips');
      assert(wizardSubmission.firstAnswer.includes(electronAiFixture.ONBOARDING_NOOP_REQUEST));

      const noOpConfirmation = await waitForValue(first.client, `(() => {
        const summary = document.querySelector('.onboarding-confirmation-summary')?.textContent || '';
        const confirmation = window.__e2eOnboardingNoOpConfirmation;
        const apply = document.getElementById('changes-apply');
        const selected = document.querySelectorAll('[data-onboarding-path]:checked').length;
        return summary.includes('edit.md') && summary.includes('无需修改') && confirmation?.token &&
          confirmation?.proposalDigest && apply?.textContent.includes('确认创建') && !apply.disabled
          ? { token: confirmation.token, proposalDigest: confirmation.proposalDigest, selected }
          : null;
      })()`, 'no-op Onboarding confirmation from a real ten-question request');
      assert.strictEqual(noOpConfirmation.selected, 0, 'the no-op fixture intentionally proposes zero files');
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), beforeNoOpEdit);

      await first.client.evaluate(`document.getElementById('changes-apply').click()`);
      await waitForValue(first.client, `(() => {
        const preview = document.querySelector('#changes-preview .tree-empty')?.textContent || '';
        const retry = [...document.querySelectorAll('button')]
          .find(node => node.textContent.includes('确认创建所选初始文件') && !node.disabled);
        return preview.includes('没有选择初始文件') && !retry ? true : null;
      })()`, 'zero-selection no-op confirmation to terminate');
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), beforeNoOpEdit);
      assert.strictEqual(projectService.readFile(project.rootPath, 'onboarding-a.md'), beforeNoOpFirst);
      assert.strictEqual(projectService.readFile(project.rootPath, 'onboarding-b.md'), beforeNoOpSecond);

      const replay = await first.client.evaluate(`window.writCraft.project.confirmOnboardingFiles(
        window.__workspace.state.project.instanceId,
        ${JSON.stringify(noOpConfirmation.token)},
        ${JSON.stringify(noOpConfirmation.proposalDigest)},
        []
      )`, true);
      assert.strictEqual(replay.ok, false, 'a zero-selection confirmation token must be single-use');
      assert.strictEqual(typeof replay.error, 'string');

      const discardPrepared = await first.client.evaluate(`(async () => {
        const projectInstanceId = window.__workspace.state.project.instanceId;
        const result = await window.writCraft.project.proposeOnboarding(projectInstanceId, {
          schema: 'writcraft.onboarding-request/v2',
          answers: [{ id: 'premise', text: ${JSON.stringify(electronAiFixture.ONBOARDING_NOOP_REQUEST)} }],
        });
        if (!result?.ok || !result.onboardingConfirmation) return { ok: false, result };
        const accepted = window.__changesView.acceptProposal(result);
        return {
          ok: accepted?.ok === true,
          token: result.onboardingConfirmation.token,
          proposalDigest: result.onboardingConfirmation.proposalDigest,
        };
      })()`, true);
      assert.strictEqual(discardPrepared.ok, true, JSON.stringify(discardPrepared));
      await waitForValue(first.client, `(() => {
        const summary = document.querySelector('.onboarding-confirmation-summary')?.textContent || '';
        const discard = document.getElementById('changes-discard');
        return summary.includes('无需修改') && discard?.textContent.includes('不创建') && !discard.disabled
          ? true : null;
      })()`, 'a fresh no-op token before explicit discard');
      await first.client.evaluate(`document.getElementById('changes-discard').click()`);
      await waitForValue(first.client, `(() => {
        const preview = document.querySelector('#changes-preview .tree-empty')?.textContent || '';
        return preview.includes('已放弃初始文件创建') && document.getElementById('changes-apply').hidden
          ? true : null;
      })()`, 'explicitly discarding a no-op initial-file token');
      const replayDiscarded = await first.client.evaluate(`window.writCraft.project.confirmOnboardingFiles(
        window.__workspace.state.project.instanceId,
        ${JSON.stringify(discardPrepared.token)},
        ${JSON.stringify(discardPrepared.proposalDigest)},
        []
      )`, true);
      assert.strictEqual(replayDiscarded.ok, false, 'an explicitly discarded confirmation token must be terminal');
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), beforeNoOpEdit);

      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('shows exact legacy Front Matter diagnostics and migrates v0 through a reviewed ChangeSet', async () => {
      const legacySave = await first.client.evaluate(`(async () => {
        const editor = document.getElementById('editor');
        const legacy = window.__editor.getContent().replace('schema: writcraft.edit/v1', 'schema: writcraft.edit/v0');
        editor.textContent = legacy;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'v0' }));
        return window.__workspace.persistCurrent(true);
      })()`);
      assert.strictEqual(legacySave, true);
      assert(projectService.readFile(project.rootPath, 'edit.md').includes('schema: writcraft.edit/v0'));

      const diagnostics = await first.client.evaluate(`(() => {
        const chip = document.getElementById('edit-context-chip');
        chip.click();
        const panel = document.getElementById('edit-diagnostic-panel');
        return {
          open: !panel.hidden,
          text: document.getElementById('edit-diagnostic-list').textContent,
          repairDisabled: document.getElementById('edit-diagnostic-repair').disabled,
        };
      })()`);
      assert.strictEqual(diagnostics.open, true);
      assert(diagnostics.text.includes('EDIT_SCHEMA_UNSUPPORTED'));
      assert(diagnostics.text.includes('第 2 行'));
      assert.strictEqual(diagnostics.repairDisabled, false);

      await first.client.evaluate(`document.getElementById('edit-diagnostic-repair').click()`);
      await waitForValue(first.client, `(() => {
        const notice = document.getElementById('changes-commit-notice');
        return window.__assistantDock.getMode() === 'changes' && !notice.hidden &&
          document.getElementById('changes-apply').textContent.includes('提交 edit.md 审阅决定');
      })()`, 'reviewed Front Matter repair proposal');
      assert(projectService.readFile(project.rootPath, 'edit.md').includes('schema: writcraft.edit/v0'));
      await first.client.evaluate(`(() => {
        document.querySelector('.change-file-actions .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      try {
        await waitForValue(first.client, `document.getElementById('changes-status')?.textContent.includes('已更新磁盘中的 edit.md')`, 'confirmed Front Matter migration');
      } catch (error) {
        const diagnostic = await first.client.evaluate(`(() => ({
          status: document.getElementById('changes-status')?.textContent || '',
          applyDisabled: document.getElementById('changes-apply')?.disabled,
          applyHidden: document.getElementById('changes-apply')?.hidden,
          mode: window.__assistantDock?.getMode?.() || '',
        }))()`);
        throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`);
      }
      const migrated = projectService.readFile(project.rootPath, 'edit.md');
      assert(migrated.includes('schema: writcraft.edit/v1'));
      assert(migrated.includes(electronAiFixture.ONBOARDING_MARKER));
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('creates, edits and switches Markdown files through the live GUI', async () => {
      const dialogOpened = await first.client.evaluate(`(() => {
        document.getElementById('new-file-button').click();
        const dialog = document.getElementById('file-dialog');
        const input = document.getElementById('file-path-input');
        input.value = ${JSON.stringify(createdPath)};
        return dialog.open && !document.getElementById('new-file-button').disabled;
      })()`);
      assert.strictEqual(dialogOpened, true);
      await first.client.evaluate(`(() => {
        document.getElementById('file-form').requestSubmit();
        return true;
      })()`);
      await waitForValue(first.client, `(() => {
        const button = document.querySelector('.tree-file[data-path=${JSON.stringify(createdPath)}]');
        return button && window.__workspace.state.currentPath === ${JSON.stringify(createdPath)};
      })()`, 'new Markdown creation and opening');

      const saved = await first.client.evaluate(`(async () => {
        const editor = document.getElementById('editor');
        editor.textContent = ${JSON.stringify(createdContent)};
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(marker)} }));
        return {
          persisted: await window.__workspace.persistCurrent(true),
          currentPath: window.__workspace.state.currentPath,
          text: window.__editor.getContent(),
        };
      })()`);
      assert.strictEqual(saved.persisted, true);
      assert.strictEqual(saved.currentPath, createdPath);
      assert(saved.text.includes(marker));

      await first.client.evaluate(`document.querySelector('.tree-file[data-path="chapters/01-arrival.md"]').click()`);
      await waitForValue(first.client, `window.__workspace.state.currentPath === 'chapters/01-arrival.md'`, 'chapter 1 tree switch');
      const chapterOne = await first.client.evaluate(`window.__editor.getContent()`);
      assert(chapterOne.includes('第一章'));
      await first.client.evaluate(`document.querySelector('.tree-file[data-path=${JSON.stringify(createdPath)}]').click()`);
      await waitForValue(first.client, `window.__workspace.state.currentPath === ${JSON.stringify(createdPath)}`, 'switching back to the created chapter');
      assert((await first.client.evaluate(`window.__editor.getContent()`)).includes(marker));
      await first.client.evaluate(`document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'ArrowRight' }))`);
      await delay(500);
    });

    await stage('previews exact privacy-safe diagnostics from visible Settings without opening save', async () => {
      const beforePath = await first.client.evaluate(`window.__workspace.state.currentPath`);
      const beforeContent = await first.client.evaluate(`window.__editor.getContent()`);
      await first.client.evaluate(`(() => {
        document.getElementById('activity-settings').click();
        document.getElementById('diagnostic-preview-open').click();
      })()`);
      const preview = await waitForValue(first.client, `(() => {
        const settings = document.getElementById('api-key-dialog');
        const dialog = document.getElementById('diagnostic-dialog');
        const serialized = document.getElementById('diagnostic-serialized');
        const exportButton = document.getElementById('diagnostic-export');
        if (settings.hidden || dialog.hidden || serialized.dataset.empty !== 'false' ||
            exportButton.disabled) return null;
        try {
          return {
            settingsVisible: getComputedStyle(settings).display !== 'none',
            dialogVisible: getComputedStyle(dialog).display !== 'none',
            serialized: serialized.textContent,
            bundle: JSON.parse(serialized.textContent),
          };
        } catch (_) {
          return null;
        }
      })()`, 'the visible Main-owned diagnostic preview');
      assert.strictEqual(preview.settingsVisible, true);
      assert.strictEqual(preview.dialogVisible, true);
      assert.deepStrictEqual(Object.keys(preview.bundle), [
        'schema', 'generatedAt', 'app', 'runtime', 'project', 'diagnostics',
      ]);
      assert.strictEqual(preview.bundle.schema, 'writcraft.diagnostic-bundle/v1');
      assert.strictEqual(Number.isNaN(Date.parse(preview.bundle.generatedAt)), false);
      assert.deepStrictEqual(Object.keys(preview.bundle.app), ['version', 'packaged']);
      assert.deepStrictEqual(Object.keys(preview.bundle.runtime), [
        'platform', 'arch', 'electron', 'node',
      ]);
      assert.deepStrictEqual(Object.keys(preview.bundle.project), [
        'open', 'fileCount', 'markdownFileCount', 'promptStatus',
        'promptDiagnosticCodes', 'watcherStatus', 'metrics',
      ]);
      assert.deepStrictEqual(Object.keys(preview.bundle.project.metrics), [
        'sampleSize', 'smallSample', 'inlineDecisions', 'planAttempts',
        'researchJudgments', 'imageAttempts', 'onboardingAttempts',
      ]);
      assert.strictEqual(preview.bundle.project.open, true);
      assert(preview.bundle.project.fileCount >= 10);
      assert(preview.bundle.project.markdownFileCount >= 10);
      assert(preview.bundle.project.markdownFileCount <= preview.bundle.project.fileCount);
      assert(Array.isArray(preview.bundle.diagnostics));
      assert(preview.bundle.diagnostics.every(event =>
        JSON.stringify(Object.keys(event)) === JSON.stringify(['area', 'code', 'time'])));

      const forbidden = [
        project.descriptor.name,
        marker,
        createdPath,
        path.basename(createdPath),
        project.rootPath,
        path.basename(project.rootPath),
        'edit.md',
        '01-arrival.md',
      ];
      for (const sentinel of forbidden) {
        assert(!preview.serialized.includes(sentinel),
          `diagnostic preview must exclude private sentinel: ${sentinel}`);
      }

      const closed = await first.client.evaluate(`(() => {
        document.getElementById('diagnostic-close').click();
        const settingsStillOpen = !document.getElementById('api-key-dialog').hidden;
        document.getElementById('api-key-close').click();
        return {
          settingsStillOpen,
          settingsHidden: document.getElementById('api-key-dialog').hidden,
          diagnosticHidden: document.getElementById('diagnostic-dialog').hidden,
          currentPath: window.__workspace.state.currentPath,
          content: window.__editor.getContent(),
        };
      })()`);
      assert.strictEqual(closed.settingsStillOpen, true);
      assert.strictEqual(closed.settingsHidden, true);
      assert.strictEqual(closed.diagnosticHidden, true);
      assert.strictEqual(closed.currentPath, beforePath);
      assert.strictEqual(closed.content, beforeContent);
      assert(closed.content.includes(marker));
    });

    await stage('plans every chapter block in Main, reviews one complete file, applies it once, and undoes it', async () => {
      const beforeDisk = projectService.readFile(project.rootPath, createdPath);
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="changes"]').click();
        const instruction = document.getElementById('changes-instruction');
        instruction.value = ${JSON.stringify(electronAiFixture.CHAPTER_GOAL)};
        instruction.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('changes-chapter').click();
      })()`);
      const review = await waitForValue(first.client, `(() => {
        const file = document.querySelector('.change-file');
        const accept = document.querySelector('.change-file-actions .change-decision--accepted');
        const status = document.getElementById('changes-status')?.textContent || '';
        if (!file || !accept || !file.textContent.includes(${JSON.stringify(electronAiFixture.CHAPTER_GENERATED_MARKER)})) return null;
        return {
          fileCount: document.querySelectorAll('.change-file').length,
          status,
          applyDisabled: document.getElementById('changes-apply').disabled,
        };
      })()`, 'the complete chapter file review assembled from planned blocks');
      assert.strictEqual(review.fileCount, 1);
      assert(review.status.includes('章节提案已生成'));
      assert.strictEqual(review.applyDisabled, true);
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);

      await first.client.evaluate(`(() => {
        document.querySelector('.change-file-actions .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `(() =>
        document.getElementById('changes-status')?.textContent.includes('已安全应用 1 个文件') &&
        window.__editor.getContent().includes(${JSON.stringify(electronAiFixture.CHAPTER_GENERATED_MARKER)})
      )()`, 'the accepted whole-chapter write');
      const generated = projectService.readFile(project.rootPath, createdPath);
      assert(generated.includes(electronAiFixture.CHAPTER_GENERATED_MARKER));

      const undoCount = await first.client.evaluate(`document.querySelectorAll('.history-card .history-undo').length`);
      await first.client.evaluate(`(() => {
        window.confirm = () => true;
        document.querySelector('.history-card .history-undo').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const remaining = document.querySelectorAll('.history-card .history-undo').length;
        return document.getElementById('changes-status')?.textContent.includes('已撤销 1 个文件') &&
          remaining === ${undoCount - 1};
      })()`, 'undoing the complete chapter generation');
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('previews, rejects, reloads and accepts one Main-verified inline rewrite', async () => {
      const richDom = await first.client.evaluate(`(async () => {
        const editor = document.getElementById('editor');
        editor.replaceChildren();
        const paragraph = value => {
          const node = document.createElement('div');
          node.textContent = value;
          return node;
        };
        const blank = () => {
          const node = document.createElement('div');
          node.appendChild(document.createElement('br'));
          return node;
        };
        editor.append(
          paragraph('# Electron E2E'), blank(),
          paragraph(${JSON.stringify(electronAiFixture.REWRITE_BEFORE)}), blank(),
          paragraph(${JSON.stringify(electronAiFixture.REWRITE_TARGET)}), blank(),
          paragraph(${JSON.stringify(electronAiFixture.REWRITE_AFTER)}), blank(),
          paragraph(${JSON.stringify(electronAiFixture.REWRITE_FAR)}), blank(),
          paragraph(${JSON.stringify(marker)})
        );
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }));
        const content = window.__editor.getContent();
        const persisted = await window.__workspace.persistCurrent(true);
        return { content, persisted, html: editor.innerHTML };
      })()`);
      assert.strictEqual(richDom.persisted, true);
      assert(richDom.html.includes('<div>') && richDom.html.includes('<br>'));
      assert(richDom.content.includes('\n\n'), 'rendered div/br manuscript must retain Markdown block separators');
      let beforeDisk = projectService.readFile(project.rootPath, createdPath);
      assert.strictEqual(beforeDisk, richDom.content);
      await first.client.evaluate(`(() => {
        window.__e2eInlineAckPending = null;
        const observer = new MutationObserver(() => {
          const wrapper = document.querySelector('.inline-diff');
          const controls = [...(wrapper?.querySelectorAll('button,select') || [])];
          if (!wrapper || !controls.length || window.__e2eInlineAckPending) return;
          window.__e2eInlineAckPending = {
            busy: wrapper.getAttribute('aria-busy'),
            allDisabled: controls.every(control => control.disabled),
          };
          observer.disconnect();
        });
        observer.observe(document.getElementById('editor'), { childList: true, subtree: true });
      })()`);
      const selectAndRewrite = `(() => {
        const editor = document.getElementById('editor');
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let target = null;
        let localStart = -1;
        while (walker.nextNode()) {
          const offset = walker.currentNode.data.indexOf(${JSON.stringify(electronAiFixture.REWRITE_TARGET)});
          if (offset >= 0) {
            target = walker.currentNode;
            localStart = offset;
            break;
          }
        }
        if (!target) return false;
        const range = document.createRange();
        range.setStart(target, localStart);
        range.setEnd(target, localStart + ${JSON.stringify(electronAiFixture.REWRITE_TARGET)}.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
        return true;
      })()`;
      assert.strictEqual(await first.client.evaluate(selectAndRewrite), true);
      let preview;
      try {
        preview = await waitForValue(first.client, `(() => {
          const wrapper = document.querySelector('.inline-diff');
          if (!wrapper || !wrapper.textContent.includes(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)})) return null;
          const chips = [...wrapper.querySelectorAll('.inline-diff-context-chip')].map(node => node.textContent);
          if (chips.length !== 3) return null;
          return {
            chips,
            text: window.__editor.getContent(),
            dirty: window.__workspace.state.dirty,
            ackPending: window.__e2eInlineAckPending,
          };
        })()`, 'Main-verified inline rewrite preview');
      } catch (error) {
        const diagnostic = await first.client.evaluate(`(() => ({
          status: document.getElementById('tip-tap-status')?.textContent,
          inlineHtml: document.querySelector('.inline-diff')?.outerHTML || null,
          editorHtml: document.getElementById('editor')?.innerHTML,
          content: window.__editor?.getContent?.(),
          dirty: window.__workspace?.state?.dirty,
          revision: window.__workspace?.state?.revision,
          selectionCount: window.getSelection()?.rangeCount || 0,
        }))()`).catch(() => null);
        error.message += `; diagnostic=${JSON.stringify(diagnostic)}; process=${boundedLog(first.logRef.value)}`;
        throw error;
      }
      assert.deepStrictEqual(preview.chips, ['✦ edit.md', '🎯 选段', '↕ 邻段']);
      assert.deepStrictEqual(preview.ackPending, { busy: 'true', allDisabled: true });
      assert.strictEqual(preview.text, beforeDisk);
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);

      const reloadStarted = await first.client.evaluate(`(() => {
        const old = document.querySelector('.inline-diff');
        if (!old) return false;
        old.dataset.e2eRewrite = 'old';
        document.querySelector('.inline-diff-button[data-action="regenerate"]').click();
        return true;
      })()`);
      assert.strictEqual(reloadStarted, true);
      await waitForValue(first.client, `(() => {
        const wrapper = document.querySelector('.inline-diff:not([data-e2e-rewrite="old"])');
        return wrapper?.textContent.includes(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)});
      })()`, 'immutable inline rewrite reload');
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);

      const contextOpened = await first.client.evaluate(`(() => {
        document.querySelector('.inline-diff-context-chip').click();
        const snapshot = window.__contextInspectorView;
        return {
          mode: window.__assistantDock.getMode(),
          cards: [...document.querySelectorAll('#context-inspector-host .context-inspector__card')]
            .map(card => card.className),
          hasSnapshot: Boolean(snapshot),
        };
      })()`);
      assert.strictEqual(contextOpened.mode, 'context');
      assert(contextOpened.cards.some(value => value.includes('context-inspector__card--neighbor')));
      await first.client.evaluate(`window.__assistantDock.close()`);

      await first.client.evaluate(`document.querySelector('.inline-diff-button[data-action="reject"]').click()`);
      await waitForValue(first.client, `(() => !document.querySelector('.inline-diff') &&
        window.__editor.getContent().includes(${JSON.stringify(electronAiFixture.REWRITE_TARGET)}) &&
        !window.__workspace.state.dirty)()`, 'inline rewrite rejection and original persistence');
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);

      const providerCallsBeforeDrift = (first.logRef.value.match(/INLINE_REWRITE_PROVIDER_CALL/g) || []).length;
      const driftAttack = await first.client.evaluate(`(() => {
        const editor = document.getElementById('editor');
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let target = null;
        while (walker.nextNode()) {
          if (walker.currentNode.data.includes(${JSON.stringify(electronAiFixture.REWRITE_TARGET)})) {
            target = walker.currentNode;
            break;
          }
        }
        if (!target) return false;
        const start = target.data.indexOf(${JSON.stringify(electronAiFixture.REWRITE_TARGET)});
        const range = document.createRange();
        range.setStart(target, start);
        range.setEnd(target, start + ${JSON.stringify(electronAiFixture.REWRITE_TARGET)}.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
        const wrapper = document.createElement('span');
        target.replaceWith(wrapper);
        wrapper.appendChild(target);
        return true;
      })()`);
      assert.strictEqual(driftAttack, true);
      await waitForValue(first.client, `(() =>
        !document.querySelector('.inline-diff') &&
        document.getElementById('tip-tap-status')?.textContent.includes('变化')
      )()`, 'DOM Range identity drift to fail closed before rewrite IPC');
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);
      assert.strictEqual(
        (first.logRef.value.match(/INLINE_REWRITE_PROVIDER_CALL/g) || []).length,
        providerCallsBeforeDrift,
        'DOM Range drift must stop before the provider is called'
      );

      assert.strictEqual(await first.client.evaluate(selectAndRewrite), true);
      await waitForValue(first.client, `document.querySelector('.inline-diff')?.textContent.includes(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)})`, 'inline rewrite regeneration');
      await first.client.evaluate(`document.querySelector('.inline-diff-button[data-action="accept"]').click()`);
      await waitForValue(first.client, `(() => !document.querySelector('.inline-diff') &&
        window.__editor.getContent().includes(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)}) &&
        !window.__workspace.state.dirty)()`, 'accepted inline rewrite persistence');
      const afterDisk = projectService.readFile(project.rootPath, createdPath);
      assert(afterDisk.includes(electronAiFixture.REWRITE_OUTPUT));
      assert(!afterDisk.includes(electronAiFixture.REWRITE_TARGET));
      assert(afterDisk.includes(electronAiFixture.REWRITE_FAR));
    });

    await stage('reviews two files with three independent hunks, carries a cross-file residual, and undoes both batches in order', async () => {
      const prepared = await first.client.evaluate(`(async () => {
        const editor = document.getElementById('editor');
        editor.textContent = window.__editor.getContent() + '\\n\\n' + ${JSON.stringify(changesReviewFixture)};
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'E2E Changes fixture' }));
        return window.__workspace.persistCurrent(true);
      })()`);
      assert.strictEqual(prepared, true);
      const beforeDisk = projectService.readFile(project.rootPath, createdPath);
      const secondBeforeDisk = projectService.readFile(project.rootPath, changesSecondPath);
      assert(electronAiFixture.CHANGES_BEFORE.slice(0, 2).every(marker => beforeDisk.includes(marker)));
      assert(secondBeforeDisk.includes(electronAiFixture.CHANGES_BEFORE[2]));
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="changes"]').click();
        const secondTarget = document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(changesSecondPath)}]');
        if (!secondTarget) throw new Error('E2E_SECOND_CHANGE_TARGET_MISSING');
        if (!secondTarget.checked) secondTarget.click();
        const input = document.getElementById('changes-instruction');
        input.value = ${JSON.stringify(electronAiFixture.CHANGES_REVIEW_GOAL)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('changes-propose').click();
        document.getElementById('changes-propose').click();
      })()`);
      const initialReview = await waitForValue(first.client, `(() => {
        const cards = [...document.querySelectorAll('.change-hunk-card')];
        const files = [...document.querySelectorAll('.change-file')];
        if (cards.length !== 3 || files.length !== 2) return null;
        return {
          statuses: cards.map(card => card.className),
          files: files.map(file => file.querySelector('.change-file-path')?.textContent || file.textContent),
          applyDisabled: document.getElementById('changes-apply').disabled,
          status: document.getElementById('changes-status').textContent,
        };
      })()`, 'three pending Main-owned review hunks');
      assert(initialReview.statuses.every(value => value.includes('is-pending')));
      assert(initialReview.files.some(value => value.includes(createdPath)));
      assert(initialReview.files.some(value => value.includes(changesSecondPath)));
      assert.strictEqual(initialReview.applyDisabled, true);
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);
      assert.strictEqual(projectService.readFile(project.rootPath, changesSecondPath), secondBeforeDisk);

      const decisions = await first.client.evaluate(`(() => {
        let cards = [...document.querySelectorAll('.change-hunk-card')];
        cards[0].querySelector('.change-decision--accepted').click();
        cards = [...document.querySelectorAll('.change-hunk-card')];
        cards[1].querySelector('.change-decision--rejected').click();
        return {
          states: [...document.querySelectorAll('.change-hunk-card')].map(card => card.className),
          disabled: document.getElementById('changes-apply').disabled,
        };
      })()`);
      assert(decisions.states[0].includes('is-accepted'));
      assert(decisions.states[1].includes('is-rejected'));
      assert(decisions.states[2].includes('is-pending'));
      assert.strictEqual(decisions.disabled, false);
      await first.client.evaluate(`document.getElementById('changes-apply').click()`);
      await waitForValue(first.client, `(() => {
        const status = document.getElementById('changes-status').textContent;
        return status.includes('本轮已接受 1、拒绝 1') && document.querySelectorAll('.change-hunk-card').length === 1;
      })()`, 'one residual pending hunk after the first reviewed batch');
      let afterFirst = projectService.readFile(project.rootPath, createdPath);
      assert(afterFirst.includes(electronAiFixture.CHANGES_AFTER[0]));
      assert(afterFirst.includes(electronAiFixture.CHANGES_BEFORE[1]));
      assert.strictEqual(projectService.readFile(project.rootPath, changesSecondPath), secondBeforeDisk);
      const residual = await first.client.evaluate(`(() => ({
        state: document.querySelector('.change-hunk-card')?.className || '',
        disabled: document.getElementById('changes-apply').disabled,
      }))()`);
      assert(residual.state.includes('is-pending'));
      assert.strictEqual(residual.disabled, true);

      await first.client.evaluate(`(() => {
        document.querySelector('.change-hunk-card .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `document.getElementById('changes-status').textContent.includes('已安全应用 1 个文件')`, 'the residual hunk application');
      const afterSecond = projectService.readFile(project.rootPath, createdPath);
      const secondAfter = projectService.readFile(project.rootPath, changesSecondPath);
      assert(afterSecond.includes(electronAiFixture.CHANGES_AFTER[0]));
      assert(afterSecond.includes(electronAiFixture.CHANGES_BEFORE[1]));
      assert(secondAfter.includes(electronAiFixture.CHANGES_AFTER[2]));
      assert(!secondAfter.includes(electronAiFixture.CHANGES_BEFORE[2]));

      const initialUndoCount = await first.client.evaluate(`document.querySelectorAll('.history-card .history-undo').length`);
      await first.client.evaluate(`(() => {
        window.confirm = () => true;
        document.querySelector('.history-card .history-undo').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const remaining = document.querySelectorAll('.history-card .history-undo').length;
        return document.getElementById('changes-status').textContent.includes('已撤销 1 个文件') && remaining === ${initialUndoCount - 1};
      })()`, 'undoing the residual batch');
      const afterUndoResidual = projectService.readFile(project.rootPath, createdPath);
      const secondAfterUndoResidual = projectService.readFile(project.rootPath, changesSecondPath);
      assert(afterUndoResidual.includes(electronAiFixture.CHANGES_AFTER[0]));
      assert(secondAfterUndoResidual.includes(electronAiFixture.CHANGES_BEFORE[2]));
      assert(!secondAfterUndoResidual.includes(electronAiFixture.CHANGES_AFTER[2]));

      const undoCount = await first.client.evaluate(`document.querySelectorAll('.history-card .history-undo').length`);
      await first.client.evaluate(`document.querySelector('.history-card .history-undo').click()`);
      await waitForValue(first.client, `(() => {
        const remaining = document.querySelectorAll('.history-card .history-undo').length;
        return document.getElementById('changes-status').textContent.includes('已撤销 1 个文件') && remaining === ${undoCount - 1};
      })()`, 'undoing the first accepted batch');
      const restored = projectService.readFile(project.rootPath, createdPath);
      const secondRestored = projectService.readFile(project.rootPath, changesSecondPath);
      assert(electronAiFixture.CHANGES_BEFORE.slice(0, 2).every(marker => restored.includes(marker)));
      assert(electronAiFixture.CHANGES_AFTER.slice(0, 2).every(marker => !restored.includes(marker)));
      assert(secondRestored.includes(electronAiFixture.CHANGES_BEFORE[2]));
      assert(!secondRestored.includes(electronAiFixture.CHANGES_AFTER[2]));
    });

    await stage('recovers a committed Changes response loss from disk and History before unlocking', async () => {
      const paths = [project.chapterPaths[0], project.chapterPaths[1]];
      const prepared = recoveryChangeSet(
        project.rootPath,
        paths,
        `E2E_CHANGES_RESPONSE_LOSS_${Date.now()}`
      );
      const transaction = createChangesHistoryTransaction({ projectService });
      const result = transaction.apply({
        rootPath: project.rootPath,
        projectId: project.descriptor.projectId,
        changeSet: prepared.changeSet,
      });
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(result.status, 'applied');
      const markerPath = path.join(
        project.rootPath,
        '.writcraft',
        'recovery',
        'changes-history-transaction.json'
      );
      assert.strictEqual(fs.existsSync(markerPath), true);
      await delay(250);
      const reconciled = await first.client.evaluate(
        `window.__workspace.reconcileChangesHistoryOnProjectEnter()`
      );
      assert.strictEqual(reconciled.ok, true, JSON.stringify(reconciled));
      assert.strictEqual(reconciled.status, 'applied');
      assert.strictEqual(reconciled.mutationTrusted, false);
      assert.strictEqual(fs.existsSync(markerPath), false);
      for (const change of prepared.changeSet.changes) {
        assert.strictEqual(projectService.readFile(project.rootPath, change.path), change.after);
      }
      const unlocked = await first.client.evaluate(`(() => ({
        blocked: window.__workspace.state.inlineMutationBlocked,
        editable: document.getElementById('editor').contentEditable,
        recoveryHidden: document.getElementById('changes-recovery').hidden,
      }))()`);
      assert.deepStrictEqual(unlocked, {
        blocked: false,
        editable: 'true',
        recoveryHidden: true,
      });
    });

    await stage('shows both manual recovery choices and keeps the project locked until exact resolution', async () => {
      const markerPath = path.join(
        project.rootPath,
        '.writcraft',
        'recovery',
        'changes-history-transaction.json'
      );
      const paths = [project.chapterPaths[2], project.chapterPaths[3]];
      const runChoice = async action => {
        const mixed = createMixedChangesHistoryRecovery(
          project.rootPath,
          project.descriptor.projectId,
          paths,
          `E2E_MANUAL_${action}_${Date.now()}`
        );
        assert.strictEqual(fs.existsSync(markerPath), true);
        await delay(250);
        const entered = await first.client.evaluate(
          `window.__workspace.reconcileChangesHistoryOnProjectEnter()`
        );
        assert.strictEqual(entered.ok, false);
        assert.strictEqual(entered.status, 'manual_recovery');
        const manual = await first.client.evaluate(`(() => ({
          blocked: window.__workspace.state.inlineMutationBlocked,
          editable: document.getElementById('editor').contentEditable,
          hidden: document.getElementById('changes-recovery').hidden,
          state: document.getElementById('changes-recovery').dataset.state,
          paths: [...document.querySelectorAll('#changes-recovery-paths li')].map(node => node.textContent),
          actions: [...document.querySelectorAll('#changes-recovery-actions button')].map(node => node.dataset.action),
        }))()`);
        assert.strictEqual(manual.blocked, true);
        assert.strictEqual(manual.editable, 'false');
        assert.strictEqual(manual.hidden, false);
        assert.strictEqual(manual.state, 'manual');
        assert.deepStrictEqual(manual.paths, paths);
        assert.deepStrictEqual(manual.actions, ['restore_before', 'keep_after']);
        const actionSelector = `#changes-recovery-actions [data-action="${action}"]`;
        if (action === 'keep_after') {
          await first.client.evaluate(`(() => {
            window.__e2eOriginalRecoveryResolver = window.__workspace.resolveChangesHistoryRecovery;
            window.__workspace.resolveChangesHistoryRecovery = async () => {
              const recovery = window.__workspace.state.changesHistoryRecovery;
              window.__changesView.setRecoveryState({
                blocked: true,
                state: 'manual',
                title: '需要你确认项目的最终状态',
                message: '首次恢复未完成；可以重试同一选择。',
                affectedPaths: recovery.affectedPaths,
                operationId: recovery.operationId,
              });
              return { ok: false, status: 'manual_recovery', recovery };
            };
          })()`);
          await first.client.evaluate(
            `document.querySelector(${JSON.stringify(actionSelector)}).click()`
          );
          await waitForValue(first.client, `(() => {
            const button = document.querySelector(${JSON.stringify(actionSelector)});
            return !document.getElementById('changes-recovery').hidden &&
              document.getElementById('changes-recovery').dataset.state === 'manual' &&
              button && !button.disabled &&
              window.__workspace.state.inlineMutationBlocked;
          })()`, 'manual keep-after same-action retry');
          assert.strictEqual(fs.existsSync(markerPath), true);
          await first.client.evaluate(`(() => {
            window.__workspace.resolveChangesHistoryRecovery = window.__e2eOriginalRecoveryResolver;
            delete window.__e2eOriginalRecoveryResolver;
          })()`);
        }
        await first.client.evaluate(
          `document.querySelector(${JSON.stringify(actionSelector)}).click()`
        );
        await waitForValue(first.client, `(() =>
          document.getElementById('changes-recovery').hidden &&
          !window.__workspace.state.inlineMutationBlocked &&
          document.getElementById('editor').contentEditable === 'true'
        )()`, `manual ${action} completion`);
        assert.strictEqual(fs.existsSync(markerPath), false);
        const expected = action === 'restore_before'
          ? mixed.snapshots.map(file => file.content)
          : mixed.changeSet.changes.map(change => change.after);
        paths.forEach((filePath, index) => {
          assert.strictEqual(projectService.readFile(project.rootPath, filePath), expected[index]);
        });
        return mixed;
      };

      await runChoice('restore_before');
      const kept = await runChoice('keep_after');
      const latest = changeHistoryService.listHistory(project.rootPath).find(entry =>
        entry.status === 'applied' &&
        entry.files.map(file => file.path).join('|') === paths.join('|'));
      assert(latest, 'keep-after must commit one exact History entry');
      const undo = createChangesHistoryTransaction({ projectService }).undo({
        rootPath: project.rootPath,
        projectId: project.descriptor.projectId,
        entryId: latest.id,
      });
      assert.strictEqual(undo.ok, true, JSON.stringify(undo));
      const restored = await first.client.evaluate(
        `window.__workspace.reconcileChangesHistoryOnProjectEnter()`
      );
      assert.strictEqual(restored.ok, true, JSON.stringify(restored));
      kept.snapshots.forEach(file => {
        assert.strictEqual(projectService.readFile(project.rootPath, file.path), file.content);
      });
      assert.strictEqual(fs.existsSync(markerPath), false);
    });

    await stage('rejects non-strict Plan JSON without writes and retries the same goal successfully', async () => {
      const markdownBefore = snapshotMarkdownFiles(project.rootPath);
      const historyPath = path.join(project.rootPath, changeHistoryService.HISTORY_RELATIVE_PATH);
      const historyBefore = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;

      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="plan"]').click();
        const goal = document.getElementById('plan-goal');
        goal.value = ${JSON.stringify(electronAiFixture.PLAN_STRICT_RETRY_GOAL)};
        goal.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('plan-generate').click();
      })()`);
      const recoverable = await waitForValue(first.client, `(() => {
        const alert = document.querySelector('.plan-mode__status--error[role="alert"]');
        const retry = alert?.querySelector('.plan-mode__primary');
        if (!alert || !retry || retry.textContent.trim() !== '重新生成') return null;
        return {
          state: window.__planModeView.getState().status,
          message: alert.querySelector('p')?.textContent || '',
          goal: document.getElementById('plan-goal').value,
          taskCount: document.querySelectorAll('.plan-mode__task').length,
          retryLabel: retry.textContent.trim(),
        };
      })()`, 'the recoverable strict Plan JSON error');
      assert.strictEqual(recoverable.state, 'error');
      assert(recoverable.message.length > 0);
      assert.strictEqual(recoverable.goal, electronAiFixture.PLAN_STRICT_RETRY_GOAL);
      assert.strictEqual(recoverable.taskCount, 0);
      assert.strictEqual(recoverable.retryLabel, '重新生成');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore,
        'non-strict Plan output must not modify any project Markdown');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'non-strict Plan output must write zero History bytes');

      await first.client.evaluate(`document.querySelector('.plan-mode__status--error .plan-mode__primary').click()`);
      const recovered = await waitForValue(first.client, `(() => {
        const task = document.querySelector('.plan-mode__task[data-task-id="strict_retry_t1"]');
        if (!task) return null;
        return {
          state: window.__planModeView.getState().status,
          goal: document.getElementById('plan-goal').value,
          taskCount: document.querySelectorAll('.plan-mode__task').length,
          title: task.textContent,
          hasError: Boolean(document.querySelector('.plan-mode__status--error')),
        };
      })()`, 'the strict Plan retry task card');
      assert.strictEqual(recovered.state, 'ready');
      assert.strictEqual(recovered.goal, electronAiFixture.PLAN_STRICT_RETRY_GOAL);
      assert.strictEqual(recovered.taskCount, 1);
      assert(recovered.title.includes('验证 strict 恢复'));
      assert.strictEqual(recovered.hasError, false);
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore,
        'successful Plan generation remains read-only');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'successful Plan generation must not create History');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('hands a revision-locked Plan task to Changes and writes only after explicit hunk acceptance', async () => {
      const beforeDisk = projectService.readFile(project.rootPath, createdPath);
      assert(beforeDisk.includes(electronAiFixture.PLAN_BEFORE));
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="changes"]').click();
        const instruction = document.getElementById('changes-instruction');
        instruction.value = ${JSON.stringify(electronAiFixture.PROPOSAL_RACE_GOAL)};
        instruction.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('changes-propose').click();
        document.getElementById('changes-propose').click();
        document.querySelector('[data-assistant-mode="plan"]').click();
        const goal = document.getElementById('plan-goal');
        goal.value = ${JSON.stringify(electronAiFixture.PLAN_GOAL)};
        goal.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('plan-generate').click();
      })()`);
      await waitForValue(first.client, `document.querySelector('.plan-mode__task[data-task-id="t1"]')`, 'the Main-bound Plan task card');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.plan-mode__task[data-task-id="t1"]');
        card.querySelector('.plan-mode__task-toggle').click();
        card.querySelector('.plan-mode__handoff').click();
      })()`);
      const planReview = await waitForValue(first.client, `(() => {
        const banner = document.querySelector('.changes-plan-mode');
        const card = document.querySelector('.change-hunk-card');
        const input = document.getElementById('changes-instruction');
        if (!banner || banner.hidden || !card || !input.readOnly) return null;
        return { banner: banner.textContent, input: input.value, state: card.className };
      })()`, 'the Plan-bound Changes review');
      assert(planReview.banner.includes('t1'));
      assert(planReview.banner.includes(createdPath));
      assert(planReview.input.includes('Task t1'));
      assert(planReview.state.includes('is-pending'));
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);
      await delay(900);
      const raceState = await first.client.evaluate(`(() => ({
        banner: document.querySelector('.changes-plan-mode')?.textContent || '',
        preview: document.querySelector('.change-hunk-card')?.textContent || '',
        readonly: document.getElementById('changes-instruction').readOnly,
      }))()`);
      assert(raceState.banner.includes('t1'));
      assert(raceState.preview.includes(electronAiFixture.PLAN_AFTER));
      assert(!raceState.preview.includes(electronAiFixture.PROPOSAL_RACE_AFTER));
      assert.strictEqual(raceState.readonly, true);
      assert(projectService.readFile(project.rootPath, createdPath).includes(electronAiFixture.PROPOSAL_RACE_BEFORE));

      await first.client.evaluate(`(() => {
        document.querySelector('.change-file-actions .change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `document.getElementById('changes-status').textContent.includes('Plan 任务已安全写入并完成')`, 'the explicitly accepted Plan task write');
      const afterDisk = projectService.readFile(project.rootPath, createdPath);
      assert(afterDisk.includes(electronAiFixture.PLAN_AFTER));
      assert(!afterDisk.includes(electronAiFixture.PLAN_BEFORE));
      await waitForValue(first.client, `(() => {
        const banner = document.querySelector('.changes-plan-mode');
        const status = document.getElementById('changes-status').textContent;
        return banner?.hidden && !document.getElementById('changes-instruction').readOnly &&
          status.includes('Plan 任务已安全写入并完成');
      })()`, 'the completed Plan task leaving its stale record automatically');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('filters the real Graph and exposes distinct evidence for every required diagnostic', async () => {
      const heapBefore = await first.client.command('Runtime.getHeapUsage');
      await first.client.evaluate(`(() => {
        const scope = document.getElementById('graph-scope');
        scope.value = 'project';
        scope.dispatchEvent(new Event('change', { bubbles: true }));
        window.__graphColdUiStarted = performance.now();
        window.__graphColdUiInteracted = false;
        window.__graphView.open();
        return true;
      })()`);
      const coldUi = await waitForValue(first.client, `(() => {
        const summary = document.getElementById('graph-summary');
        const nodes = [...document.querySelectorAll('.graph-node')];
        const issueTriggers = [...document.querySelectorAll('.issue-card .issue-detail-trigger')];
        const canvas = document.getElementById('consistency-graph');
        const fileOptions = [...document.querySelectorAll('#graph-file-filter option')]
          .filter(option => Boolean(option.value)).length;
        const liveReady = summary?.textContent.includes('个节点') &&
          summary.getAttribute('role') === 'status' &&
          ['polite', 'assertive'].includes(summary.getAttribute('aria-live'));
        const graphReady = nodes.length >= 500 && issueTriggers.length >= 4 &&
          canvas?.getBoundingClientRect().width > 0 && canvas?.getBoundingClientRect().height > 0;
        if (!liveReady || !graphReady) return null;
        if (!window.__graphColdUiInteracted) {
          issueTriggers[0].click();
          window.__graphColdUiInteracted = true;
        }
        const interactiveNodes = [...document.querySelectorAll('.graph-node')];
        interactiveNodes[0]?.focus();
        const detail = document.getElementById('graph-detail')?.textContent.trim() || '';
        const detailTitle = document.querySelector('#graph-detail .graph-detail-title')?.textContent.trim() || '';
        const interactive = interactiveNodes.length >= 500 &&
          document.activeElement === interactiveNodes[0] && detail && detailTitle;
        return interactive ? {
          elapsed: performance.now() - window.__graphColdUiStarted,
          nodes: interactiveNodes.length,
          issues: issueTriggers.length,
          fileOptions,
          summary: summary.textContent,
          role: summary.getAttribute('role'),
          live: summary.getAttribute('aria-live'),
          detail,
        } : null;
      })()`, 'the cold project Graph UI becoming fully interactive');
      assert(coldUi.nodes >= 500, `cold Graph UI rendered only ${coldUi.nodes} actual DOM nodes`);
      assert(coldUi.issues >= 4, `cold Graph UI exposed only ${coldUi.issues} interactive issue actions`);
      assert(coldUi.fileOptions >= LARGE_GRAPH_FILE_COUNT,
        `cold Graph UI exposed only ${coldUi.fileOptions} project-file filter options`);
      assert(coldUi.summary.includes('已重建索引'),
        `first Graph UI open did not prove a cold rebuild: ${coldUi.summary}`);
      assert.strictEqual(coldUi.role, 'status');
      assert(['polite', 'assertive'].includes(coldUi.live));
      assert(coldUi.detail.length > 0, 'cold Graph UI issue action must expose an interactive detail');
      assert(coldUi.elapsed <= GRAPH_COLD_BUDGET_MS,
        `real Electron cold Graph UI became interactive in ${coldUi.elapsed.toFixed(1)} ms, above ${GRAPH_COLD_BUDGET_MS} ms`);

      const cache = await first.client.evaluate(`(async () => {
        const started = performance.now();
        const result = await window.writCraft.project.buildGraph(window.__workspace.state.project.instanceId);
        return { ok: result.ok, status: result.index?.status, elapsed: performance.now() - started,
          nodes: result.graph?.nodes?.length || 0 };
      })()`, true);
      assert.strictEqual(cache.ok, true, JSON.stringify(cache));
      assert.strictEqual(cache.status, 'cache_hit');
      assert(cache.elapsed <= GRAPH_CACHE_BUDGET_MS,
        `real Electron Graph cache hit ${cache.elapsed.toFixed(1)} ms exceeded ${GRAPH_CACHE_BUDGET_MS} ms`);

      const incrementalPath = 'large-graph/node-123.md';
      const incrementalBefore = projectService.readFileWithRevision(project.rootPath, incrementalPath);
      const generationBeforeIncrementalWrite = await first.client.evaluate(
        `window.__workspace.state.aiContextGeneration`
      );
      projectService.atomicWriteFile(project.rootPath, incrementalPath,
        `${incrementalBefore.content}\n角色123的作者备注是增量校验。\n`, incrementalBefore.revision);
      const incremental = await first.client.evaluate(`(async () => {
        const started = performance.now();
        const result = await window.writCraft.project.buildGraph(window.__workspace.state.project.instanceId);
        return { ok: result.ok, status: result.index?.status, elapsed: performance.now() - started,
          analyzedPaths: result.index?.analyzedPaths || [] };
      })()`, true);
      assert.strictEqual(incremental.ok, true, JSON.stringify(incremental));
      assert.strictEqual(incremental.status, 'incremental');
      assert.deepStrictEqual(incremental.analyzedPaths, [incrementalPath]);
      assert(incremental.elapsed <= GRAPH_INCREMENTAL_BUDGET_MS,
        `real Electron incremental Graph build ${incremental.elapsed.toFixed(1)} ms exceeded ${GRAPH_INCREMENTAL_BUDGET_MS} ms`);
      await waitForValue(first.client, `(() => {
        const state = window.__workspace?.state;
        if (!state || state.aiContextGeneration <= ${JSON.stringify(generationBeforeIncrementalWrite)}) return null;
        return Promise.resolve(state.externalQueue).then(() =>
          state.aiContextGeneration > ${JSON.stringify(generationBeforeIncrementalWrite)} ? true : null
        );
      })()`, 'the external incremental write to settle before the authoritative Graph UI refresh');
      await first.client.evaluate(`window.__graphView.refresh()`);
      try {
        await waitForValue(first.client, `document.querySelectorAll('.graph-node').length >= 500 &&
          document.getElementById('graph-summary').textContent.includes('个节点')`,
        'the Renderer refreshing to the authoritative post-incremental Graph identity');
      } catch (error) {
        const diagnostic = await first.client.evaluate(`(() => ({
          nodes: document.querySelectorAll('.graph-node').length,
          issues: document.querySelectorAll('.issue-card').length,
          summary: document.getElementById('graph-summary')?.textContent || '',
          detail: document.getElementById('graph-detail')?.textContent || '',
          scope: document.getElementById('graph-scope')?.value || '',
          filter: document.getElementById('graph-filter')?.value || '',
        }))()`);
        error.message += `; renderer state=${JSON.stringify(diagnostic)}`;
        throw error;
      }

      const filterResults = await first.client.evaluate(`(async () => {
        const durations = [];
        const afterVisibleFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const visibleGraphNodes = () => [...document.querySelectorAll('.graph-node')]
          .filter(node => getComputedStyle(node).display !== 'none');
        const update = async (id, value, eventName = 'change') => {
          const element = document.getElementById(id);
          const from = element.value;
          element.value = value;
          const started = performance.now();
          element.dispatchEvent(new Event(eventName, { bubbles: true }));
          await afterVisibleFrame();
          const nodes = visibleGraphNodes();
          document.getElementById('consistency-graph').getBoundingClientRect();
          durations.push({ id, from, value, elapsed: performance.now() - started });
          return nodes;
        };
        const set = async (id, value, eventName = 'change') => (await update(id, value, eventName))
          .map(node => node.getAttribute('aria-label') || node.textContent.trim());
        const all = await set('graph-filter', 'all');
        const people = await set('graph-filter', 'person');
        const variables = await set('graph-filter', 'variable');
        const times = await set('graph-filter', 'time');
        const issues = await set('graph-filter', 'issues');
        await set('graph-filter', 'all');
        const fileSelect = document.getElementById('graph-file-filter');
        const filePath = [...fileSelect.options].map(option => option.value).find(value => value === 'chapters/01-arrival.md');
        const byFile = await set('graph-file-filter', filePath);
        await set('graph-file-filter', '');
        const timeSelect = document.getElementById('graph-time-filter');
        const timeEndSelect = document.getElementById('graph-time-end-filter');
        const timeIds = [...timeSelect.options].map(option => option.value).filter(Boolean);
        const timeId = timeIds[0];
        const byTime = await set('graph-time-filter', timeId);
        await set('graph-time-filter', '');
        const issueTotal = document.querySelectorAll('.issue-card').length;
        let range = null;
        for (const start of timeIds) {
          for (const end of timeIds) {
            await update('graph-time-filter', start);
            const rangeNodes = await update('graph-time-end-filter', end);
            const nodeCount = rangeNodes.length;
            const issueCount = document.querySelectorAll('.issue-card').length;
            if (nodeCount > 0 && nodeCount < all.length && issueCount > 0 && issueCount < issueTotal) {
              range = { start, end, nodeCount, issueCount, issueTotal };
              break;
            }
          }
          if (range) break;
        }
        await set('graph-time-filter', '');
        await set('graph-time-end-filter', '');
        const search = await set('graph-search', '林舟', 'input');
        await set('graph-search', '', 'input');
        return { all, people, variables, times, issues, byFile, byTime, search, filePath, timeId, range, durations };
      })()`);
      assert(filterResults.people.length > 0 && filterResults.people.length < filterResults.all.length);
      assert(filterResults.people.some(label => label.includes('林舟')));
      assert(filterResults.variables.some(label => label.includes('等待时间')));
      assert(filterResults.times.length > 0 && filterResults.times.every(label => /[0-9]{4}/.test(label)));
      assert(filterResults.issues.length > 0 && filterResults.issues.length < filterResults.all.length);
      assert.strictEqual(filterResults.filePath, 'chapters/01-arrival.md');
      assert(filterResults.byFile.length > 0 && filterResults.byFile.length < filterResults.all.length);
      assert(filterResults.timeId && filterResults.byTime.length > 0);
      assert(filterResults.range, 'a real start/end time range must narrow both Graph nodes and issues without emptying them');
      assert(filterResults.range.nodeCount > 0 && filterResults.range.nodeCount < filterResults.all.length);
      assert(filterResults.range.issueCount > 0 && filterResults.range.issueCount < filterResults.range.issueTotal);
      assert(filterResults.search.length > 0 && filterResults.search.length < filterResults.all.length);
      assert(filterResults.search.some(label => label.includes('林舟')),
        'Graph search keeps the direct 林舟 match alongside any issue-related nodes');
      assert(filterResults.durations.length > 0);
      for (const [measurementIndex, measurement] of filterResults.durations.entries()) {
        assert(measurement.elapsed <= GRAPH_INTERACTION_BUDGET_MS,
          `Graph measurement #${measurementIndex + 1} ${measurement.id} ${measurement.from} -> ${measurement.value} update ${measurement.elapsed.toFixed(1)} ms exceeded ${GRAPH_INTERACTION_BUDGET_MS} ms; all durations=${JSON.stringify(filterResults.durations)}`);
      }

      const diagnostics = await first.client.evaluate(`(() => {
        const inspect = title => {
          const card = [...document.querySelectorAll('.issue-card')].find(node => node.textContent.includes(title));
          const trigger = card?.querySelector('.issue-detail-trigger');
          if (!card || !trigger) return null;
          trigger.click();
          return {
            evidence: [...document.querySelectorAll('#graph-detail .graph-evidence')].map(node => node.textContent.trim()),
            missing: [...document.querySelectorAll('#graph-detail .graph-evidence-missing')].map(node => node.textContent.trim()),
            detail: document.getElementById('graph-detail').textContent,
          };
        };
        return {
          attribute: inspect('林舟 的年龄前后不一致'),
          timeline: inspect('时间先后关系形成闭环'),
          drift: inspect('章节主题偏离 edit.md 范围'),
          gap: inspect('论点尚未补充来源'),
        };
      })()`);
      for (const name of ['attribute', 'timeline', 'drift']) {
        assert(diagnostics[name], `${name} diagnostic needs an independent detail trigger`);
        assert(diagnostics[name].evidence.length >= 2, `${name} must expose at least two evidence locators`);
        assert(new Set(diagnostics[name].evidence).size >= 2, `${name} evidence locators must be distinct`);
      }
      assert(diagnostics.gap);
      assert.strictEqual(diagnostics.gap.evidence.length, 1);
      assert(diagnostics.gap.missing.length >= 1);
      assert(diagnostics.gap.missing.some(value => /缺失|待补|未补/.test(value)));

      const graphGeometry = await first.client.evaluate(`(() => {
        const parse = node => {
          const match = String(node.getAttribute('transform') || '').match(/translate\\(([-0-9.]+)[ ,]([-0-9.]+)\\)/);
          return match ? { x: Number(match[1]), y: Number(match[2]), label: node.getAttribute('aria-label') || '' } : null;
        };
        const nodes = [...document.querySelectorAll('.graph-node')];
        const timeNodes = nodes.filter(node => (node.getAttribute('aria-label') || '').includes('time节点')).map(parse).filter(Boolean);
        let minimumTimeDistance = Infinity;
        for (let left = 0; left < timeNodes.length; left += 1) {
          for (let right = left + 1; right < timeNodes.length; right += 1) {
            minimumTimeDistance = Math.min(minimumTimeDistance,
              Math.hypot(timeNodes[left].x - timeNodes[right].x, timeNodes[left].y - timeNodes[right].y));
          }
        }
        return {
          hitDiameters: nodes.map(node => Number(node.querySelector('.graph-node-hit')?.getAttribute('r') || 0) * 2),
          timeCount: timeNodes.length,
          minimumTimeDistance,
        };
      })()`);
      assert(graphGeometry.hitDiameters.length >= 500);
      assert(graphGeometry.hitDiameters.every(diameter => diameter >= 24), 'every focusable Graph node needs a 24x24 graph-coordinate hit target');
      assert(graphGeometry.timeCount >= 2);
      assert(graphGeometry.minimumTimeDistance >= 16,
        `time nodes were only ${graphGeometry.minimumTimeDistance.toFixed(1)} graph-coordinate pixels apart`);

      await first.client.command('Accessibility.enable');
      const accessibility = await first.client.command('Accessibility.getFullAXTree');
      const axNodes = accessibility.nodes || [];
      const hasAx = (role, pattern) => axNodes.some(node => node.role?.value === role && pattern.test(node.name?.value || ''));
      assert(hasAx('group', /项目实体关系图/), 'AX tree must name the Graph canvas group');
      assert(hasAx('button', /查看person节点：林舟/), 'AX tree must expose a named person-node button');
      assert(hasAx('button', /查看问题详情：时间先后关系形成闭环/), 'AX tree must expose a named issue-detail button');

      const heapAfter = await first.client.command('Runtime.getHeapUsage');
      const heapGrowth = Math.max(0, (heapAfter.usedSize || 0) - (heapBefore.usedSize || 0));
      assert(heapGrowth <= GRAPH_RENDERER_HEAP_BUDGET_BYTES,
        `Graph renderer JS heap grew ${(heapGrowth / 1024 / 1024).toFixed(1)} MiB, above 150 MiB`);
      const dom = await first.client.command('Memory.getDOMCounters');
      assert(dom.nodes >= coldUi.nodes, 'CDP DOM counters must include every rendered Graph node');
    });

    await stage('uses Graph keyboard controls and persists attribute, fact, and alias corrections without manuscript writes', async () => {
      const markdownBefore = snapshotMarkdownFiles(project.rootPath);
      const historyPath = path.join(project.rootPath, changeHistoryService.HISTORY_RELATIVE_PATH);
      const historyBefore = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;
      const correctionPath = path.join(project.rootPath, '.writcraft', 'graph-corrections.json');

      const nodeReady = await first.client.evaluate(`(() => {
        const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
          .find(item => item.getAttribute('aria-label').includes('person节点：林舟'));
        if (!node) return null;
        node.focus();
        const style = getComputedStyle(node);
        return { active: document.activeElement === node, label: node.getAttribute('aria-label'), outline: style.outlineStyle };
      })()`);
      assert(nodeReady && nodeReady.active);
      assert(nodeReady.label.includes('林舟'));
      await pressKey(first.client, 'Enter');
      await waitForValue(first.client, `document.getElementById('graph-detail').textContent.includes('林舟') &&
        Boolean(document.querySelector('#graph-detail .graph-correction-controls'))`, 'keyboard opening the person node correction detail');

      const issueKeyboard = await first.client.evaluate(`(() => {
        const nestedConflicts = document.querySelectorAll('.issue-card[role="button"] button, .issue-card [role="button"] button').length;
        const card = [...document.querySelectorAll('.issue-card')].find(node => node.textContent.includes('时间先后关系形成闭环'));
        const trigger = card?.querySelector('.issue-detail-trigger');
        if (!trigger) return { nestedConflicts, active: false, label: '' };
        trigger.focus();
        return { nestedConflicts, active: document.activeElement === trigger, label: trigger.getAttribute('aria-label') || '' };
      })()`);
      assert.strictEqual(issueKeyboard.nestedConflicts, 0, 'issue action buttons must not be nested in another button role');
      assert.strictEqual(issueKeyboard.active, true);
      assert(issueKeyboard.label.includes('时间') || issueKeyboard.label.includes('详情'));
      await pressKey(first.client, ' ');
      await waitForValue(first.client, `document.getElementById('graph-detail').textContent.includes('时间先后关系形成闭环')`, 'keyboard opening the issue detail');

      const correctionPrepared = await first.client.evaluate(`(() => {
        const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
          .find(item => item.getAttribute('aria-label').includes('person节点：林舟'));
        if (!node) return { ok: false, reason: 'PERSON_NODE_NOT_FOUND' };
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const form = document.querySelector('#graph-detail form.graph-correction-row') ||
          [...document.querySelectorAll('#graph-detail .graph-correction-row')]
            .find(row => row.querySelector('input[aria-label="要编辑的节点属性名"]'));
        if (!form) return { ok: false, reason: 'CORRECTION_FORM_NOT_FOUND', detail: document.getElementById('graph-detail').textContent };
        const name = form.querySelector('input[aria-label="要编辑的节点属性名"]');
        const value = form.querySelector('input[aria-label="节点属性值"]');
        if (!name || !value) return { ok: false, reason: 'CORRECTION_INPUT_NOT_FOUND' };
        name.value = '作者备注';
        value.value = '年龄以项目卡为准';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { ok: true };
      })()`);
      assert.strictEqual(correctionPrepared.ok, true, JSON.stringify(correctionPrepared));
      await waitForValue(first.client, `(() => {
        const detail = document.getElementById('graph-detail').textContent;
        const summary = document.getElementById('graph-summary').textContent;
        return summary.includes('纠错已保存') && detail.includes('作者备注：年龄以项目卡为准');
      })()`, 'the author attribute correction ledger');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore,
        'author Graph correction must not mutate public Markdown');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'author Graph correction must not create Change History');
      assert.strictEqual(fs.existsSync(correctionPath), true);
      assert(fs.readFileSync(correctionPath, 'utf8').includes('年龄以项目卡为准'));

      const factConfirmed = await first.client.evaluate(`(() => {
        const button = document.querySelector('#graph-detail .graph-fact-decision button[aria-label^="确认事实："]');
        if (!button) return { ok: false, detail: document.getElementById('graph-detail').textContent };
        button.click();
        return { ok: true, label: button.getAttribute('aria-label') };
      })()`);
      assert.strictEqual(factConfirmed.ok, true, JSON.stringify(factConfirmed));
      await waitForValue(first.client, `document.getElementById('graph-summary').textContent.includes('纠错已保存') &&
        Boolean(document.querySelector('#graph-detail .graph-fact-decision button.is-current[aria-label^="确认事实："]'))`,
      'the author confirming a relation fact through the real Graph UI');
      const factRejected = await first.client.evaluate(`(() => {
        const button = document.querySelector('#graph-detail .graph-fact-decision button[aria-label^="否定事实："]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      assert.strictEqual(factRejected, true);
      await waitForValue(first.client, `document.getElementById('graph-summary').textContent.includes('纠错已保存') &&
        Boolean(document.querySelector('#graph-detail .graph-fact-decision button.is-current[aria-label^="否定事实："]'))`,
      'the author rejecting the same relation fact through the real Graph UI');
      const factAccessibility = await first.client.command('Accessibility.getFullAXTree');
      assert((factAccessibility.nodes || []).some(node => node.role?.value === 'button' &&
        /(?:确认|否定)事实/.test(node.name?.value || '')), 'AX tree must expose named fact-decision buttons while relation detail is open');

      const aliasPrepared = await first.client.evaluate(`(() => {
        const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
          .find(item => item.getAttribute('aria-label').includes('person节点：沈砚'));
        if (!node) return { ok: false, reason: 'ALIAS_SOURCE_NOT_FOUND' };
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const select = document.querySelector('#graph-detail select[aria-label="选择别名的主节点"]');
        const button = [...document.querySelectorAll('#graph-detail .graph-correction-row button')]
          .find(item => item.textContent.trim() === '合并别名');
        const option = [...(select?.options || [])].find(item => item.textContent.includes('周鹭'));
        if (!select || !button || !option) return { ok: false, reason: 'ALIAS_TARGET_NOT_FOUND', detail: document.getElementById('graph-detail').textContent };
        select.value = option.value;
        button.click();
        return { ok: true };
      })()`);
      assert.strictEqual(aliasPrepared.ok, true, JSON.stringify(aliasPrepared));
      await waitForValue(first.client, `(() => {
        if (!document.getElementById('graph-summary').textContent.includes('纠错已保存')) return false;
        const source = [...document.querySelectorAll('.graph-node[aria-label]')]
          .some(node => node.getAttribute('aria-label').includes('person节点：沈砚'));
        const target = [...document.querySelectorAll('.graph-node[aria-label]')]
          .find(node => node.getAttribute('aria-label').includes('person节点：周鹭'));
        target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return !source && document.getElementById('graph-detail').textContent.includes('沈砚');
      })()`, 'the author merging 沈砚 into 周鹭 as a persistent alias');

      const correctionLedger = JSON.parse(fs.readFileSync(correctionPath, 'utf8'));
      const correctionTypes = correctionLedger.corrections.map(item => item.type);
      assert(correctionTypes.includes('edit_attribute'));
      assert(correctionTypes.includes('decide_fact'));
      assert(correctionTypes.includes('merge_alias'));
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore,
        'all author correction types must leave public Markdown unchanged');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'all author correction types must leave Change History unchanged');

      const correctionAccessibility = await first.client.command('Accessibility.getFullAXTree');
      const correctionAx = correctionAccessibility.nodes || [];
      const hasNamedButton = pattern => correctionAx.some(node => node.role?.value === 'button' && pattern.test(node.name?.value || ''));
      assert(hasNamedButton(/\u5408\u5e76\u522b\u540d/), 'AX tree must expose the named alias-merge button');
      assert(hasNamedButton(/\u4fdd\u5b58\u5c5e\u6027/), 'AX tree must expose the named attribute-save button');

      const graphInteraction = await first.client.evaluate(`(() => {
        const svg = document.getElementById('consistency-graph');
        svg.focus();
        window.__writcraftGraphLongTasks = [];
        window.__writcraftGraphLongTaskObserver?.disconnect?.();
        window.__writcraftGraphLongTaskObserver = typeof PerformanceObserver === 'function'
          ? new PerformanceObserver(list => window.__writcraftGraphLongTasks.push(...list.getEntries().map(entry => entry.duration)))
          : null;
        window.__writcraftGraphLongTaskObserver?.observe({ type: 'longtask', buffered: false });
        const bounds = svg.getBoundingClientRect();
        const visible = {
          left: Math.max(0, bounds.left), right: Math.min(innerWidth, bounds.right),
          top: Math.max(0, bounds.top), bottom: Math.min(innerHeight, bounds.bottom),
        };
        const rect = { x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 };
        const hit = document.elementFromPoint(rect.x, rect.y);
        return { before: svg.querySelector('.graph-scene')?.getAttribute('transform'), active: document.activeElement === svg,
          rect, visible, intersectsViewport: visible.right > visible.left && visible.bottom > visible.top,
          hitInsideGraph: Boolean(hit && (hit === svg || svg.contains(hit))), hit: hit?.className?.baseVal || hit?.className || hit?.tagName || '' };
      })()`);
      assert.strictEqual(graphInteraction.active, true);
      assert.strictEqual(graphInteraction.intersectsViewport, true, `Graph SVG is outside the viewport: ${JSON.stringify(graphInteraction.visible)}`);
      assert.strictEqual(graphInteraction.hitInsideGraph, true,
        `visible Graph pointer coordinate ${JSON.stringify(graphInteraction.rect)} hit ${graphInteraction.hit}`);
      await pressKey(first.client, 'ArrowRight');
      await pressKey(first.client, '+');
      const afterKeyboard = await first.client.evaluate(`document.querySelector('#consistency-graph .graph-scene')?.getAttribute('transform')`);
      assert.notStrictEqual(afterKeyboard, graphInteraction.before, 'keyboard pan/zoom must update the Graph transform');
      await first.client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: graphInteraction.rect.x, y: graphInteraction.rect.y, button: 'none', buttons: 0,
      });
      await first.client.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: graphInteraction.rect.x, y: graphInteraction.rect.y, deltaX: 0, deltaY: -120,
      });
      const afterWheel = await waitForValue(first.client,
        `(() => { const value = document.querySelector('#consistency-graph .graph-scene')?.getAttribute('transform');
          return value && value !== ${JSON.stringify(afterKeyboard)} ? value : null; })()`,
        'pointer wheel zoom updating the Graph transform');
      await first.client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: graphInteraction.rect.x, y: graphInteraction.rect.y, button: 'left', clickCount: 1,
      });
      await first.client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: graphInteraction.rect.x + 40, y: graphInteraction.rect.y + 30, button: 'left', buttons: 1,
      });
      await first.client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: graphInteraction.rect.x + 40, y: graphInteraction.rect.y + 30, button: 'left', clickCount: 1,
      });
      const interactionResult = await first.client.evaluate(`(() => {
        window.__writcraftGraphLongTaskObserver?.disconnect?.();
        return { transform: document.querySelector('#consistency-graph .graph-scene')?.getAttribute('transform'),
          longTasks: [...(window.__writcraftGraphLongTasks || [])] };
      })()`);
      assert.notStrictEqual(interactionResult.transform, afterWheel, 'pointer drag must pan the Graph');
      assert(interactionResult.longTasks.every(duration => duration <= GRAPH_INTERACTION_BUDGET_MS),
        `Graph interaction long task exceeded ${GRAPH_INTERACTION_BUDGET_MS} ms: ${JSON.stringify(interactionResult.longTasks)}`);
      await pressKey(first.client, 'Home');
      assert.strictEqual(await first.client.evaluate(`document.querySelector('#consistency-graph .graph-scene')?.getAttribute('transform')`),
        'translate(0 0) scale(1)');

      await first.client.evaluate(`document.getElementById('graph-refresh').click()`);
      await waitForValue(first.client, `(() => {
        const summary = document.getElementById('graph-summary').textContent;
        const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
          .find(item => item.getAttribute('aria-label').includes('person节点：林舟'));
        if (!summary.includes('个节点') || !node) return null;
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return document.getElementById('graph-detail').textContent.includes('作者备注：年龄以项目卡为准');
      })()`, 'the correction surviving a real Graph reanalysis');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore);
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore);
    });

    await stage('keeps Graph controls reachable at supported window sizes and 200 percent scale', async () => {
      const inspectLayout = async label => {
        const geometry = await first.client.evaluate(`(() => {
          const ids = ['graph-back','graph-scope','graph-file-filter','graph-time-filter','graph-time-end-filter','graph-filter','graph-search','graph-refresh'];
          const controls = ids.map(id => {
            const node = document.getElementById(id);
            const rect = node.getBoundingClientRect();
            return { id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          });
          const read = selector => {
            const node = document.querySelector(selector);
            const rect = node.getBoundingClientRect();
            return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, clientHeight: node.clientHeight,
              scrollHeight: node.scrollHeight, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          };
          const ancestors = [];
          for (let node = document.getElementById('graph-back'); node; node = node.parentElement) {
            const style = getComputedStyle(node);
            ancestors.push({ tag: node.tagName, id: node.id, className: node.className,
              scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
              overflowY: style.overflowY, position: style.position });
          }
          return { innerWidth, innerHeight, controls, view: read('#graph-view'), toolbar: read('.graph-toolbar'),
            stage: read('.graph-stage'), canvas: read('.graph-canvas-wrap'), issue: read('.issue-panel'),
            issueList: read('#issue-list'), detail: read('#graph-detail'),
            scrollState: { scrollX, scrollY, documentTop: document.documentElement.scrollTop, bodyTop: document.body.scrollTop,
              visualOffsetTop: visualViewport?.offsetTop || 0, visualPageTop: visualViewport?.pageTop || 0, ancestors } };
        })()`);
        for (const area of [geometry.view, geometry.toolbar, geometry.stage]) {
          assert(area.scrollWidth <= area.clientWidth + 1, `${label} Graph region must not overflow horizontally`);
        }
        for (const control of geometry.controls) {
          assert(control.width > 0 && control.height > 0, `${label} ${control.id} must be rendered`);
          assert(control.left >= -1 && control.right <= geometry.innerWidth + 1, `${label} ${control.id} must remain horizontally reachable`);
          assert(control.top >= -1 && control.bottom <= geometry.innerHeight + 1,
            `${label} ${control.id} must remain vertically reachable: ${JSON.stringify({ top: control.top, bottom: control.bottom,
              innerHeight: geometry.innerHeight, scrollState: geometry.scrollState })}`);
        }
        assert(geometry.detail.clientHeight > 0 && geometry.detail.scrollHeight >= geometry.detail.clientHeight,
          `${label} Graph detail must remain a bounded scroll region`);
        for (const [name, area] of [['canvas', geometry.canvas], ['issue', geometry.issue], ['issue list', geometry.issueList], ['detail', geometry.detail]]) {
          assert(area.clientWidth > 0 && area.clientHeight > 0, `${label} ${name} must retain a non-zero viewport`);
          assert(area.right > 0 && area.left < geometry.innerWidth && area.bottom > 0 && area.top < geometry.innerHeight,
            `${label} ${name} must intersect the visible viewport instead of being clipped below it`);
        }
        assert(geometry.stage.scrollHeight <= geometry.stage.clientHeight + 1,
          `${label} Graph stage must fit vertically without clipping its issue/detail row`);
      };
      try {
        for (const [width, height] of [[1400, 900], [1000, 600]]) {
          await first.client.command('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 1, mobile: false,
          });
          await delay(150);
          await first.client.evaluate(`window.scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0`);
          await inspectLayout(`${width}x${height}`);
        }
        await first.client.command('Emulation.setDeviceMetricsOverride', {
          width: 500, height: 300, deviceScaleFactor: 2, mobile: false,
        });
        await delay(150);
        await first.client.evaluate(`window.scrollTo(0, 0); document.body.scrollTop = 0; document.documentElement.scrollTop = 0`);
        await inspectLayout('1000x600 at 200% scale');
      } finally {
        await first.client.command('Emulation.clearDeviceMetricsOverride').catch(() => {});
        await delay(150);
      }
    });

    await stage('announces real Graph build and correction failures without manuscript writes', async () => {
      const markdownBefore = snapshotMarkdownFiles(project.rootPath);
      const historyPath = path.join(project.rootPath, changeHistoryService.HISTORY_RELATIVE_PATH);
      const historyBefore = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;
      const cachePath = path.join(project.rootPath, '.writcraft', 'graph.json');
      const correctionPath = path.join(project.rootPath, '.writcraft', 'graph-corrections.json');
      const correctionBefore = fs.readFileSync(correctionPath, 'utf8');

      await withRejectedSymlink(cachePath, async () => {
        await first.client.evaluate(`window.__graphView.refresh()`);
        const failure = await waitForValue(first.client, `(() => {
          const summary = document.getElementById('graph-summary');
          return /分析(?:失败|中断)/.test(summary.textContent)
            ? { text: summary.textContent, role: summary.getAttribute('role'), live: summary.getAttribute('aria-live') }
            : null;
        })()`, 'a real unsafe Graph cache failure in the live region');
        assert.strictEqual(failure.role, 'status');
        assert.strictEqual(failure.live, 'polite');
      });

      await first.client.evaluate(`window.__graphView.refresh()`);
      await waitForValue(first.client, `document.querySelectorAll('.graph-node').length >= 500 &&
        document.getElementById('graph-summary').textContent.includes('个节点')`, 'Graph recovery after restoring the regular cache file');

      await withRejectedSymlink(correctionPath, async () => {
        const submitted = await first.client.evaluate(`(() => {
          const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
            .find(item => item.getAttribute('aria-label').includes('person节点：林舟'));
          if (!node) return { ok: false, reason: 'PERSON_NODE_NOT_FOUND' };
          node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const form = [...document.querySelectorAll('#graph-detail form.graph-correction-row')]
            .find(row => row.querySelector('input[aria-label="要编辑的节点属性名"]'));
          const name = form?.querySelector('input[aria-label="要编辑的节点属性名"]');
          const value = form?.querySelector('input[aria-label="节点属性值"]');
          if (!form || !name || !value) return { ok: false, reason: 'CORRECTION_FORM_NOT_FOUND' };
          name.value = '故障注入';
          value.value = '不得写入';
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return { ok: true };
        })()`);
        assert.strictEqual(submitted.ok, true, JSON.stringify(submitted));
        const failure = await waitForValue(first.client, `(() => {
          const summary = document.getElementById('graph-summary');
          return summary.textContent.includes('纠错保存失败')
            ? { text: summary.textContent, role: summary.getAttribute('role'), live: summary.getAttribute('aria-live') }
            : null;
        })()`, 'a real unsafe correction-ledger failure in the live region');
        assert.strictEqual(failure.role, 'status');
        assert.strictEqual(failure.live, 'polite');
      });

      assert.strictEqual(fs.readFileSync(correctionPath, 'utf8'), correctionBefore,
        'failed correction must preserve the authoritative correction ledger');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore,
        'Graph build/correction failures must not mutate public Markdown');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'Graph build/correction failures must not mutate Change History');
      await first.client.evaluate(`window.__graphView.refresh()`);
      await waitForValue(first.client, `document.querySelectorAll('.graph-node').length >= 500 &&
        document.getElementById('graph-summary').textContent.includes('个节点')`, 'Graph recovery after restoring the correction ledger');
    });

    await stage('fails a stale Graph issue closed after an external evidence write', async () => {
      const issuePath = 'chapters/02-data-dispute.md';
      const original = projectService.readFileWithRevision(project.rootPath, issuePath);
      const historyPath = path.join(project.rootPath, changeHistoryService.HISTORY_RELATIVE_PATH);
      const historyBefore = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;
      const providerCallsBefore = (first.logRef.value.match(/GRAPH_ISSUE_PROVIDER_CALL/g) || []).length;
      const changed = `${original.content}\n\n外部证据变更 ${Date.now()}\n`;
      projectService.atomicWriteFile(project.rootPath, issuePath, changed, original.revision);
      const markdownAfterExternalWrite = snapshotMarkdownFiles(project.rootPath);

      const stale = await waitForValue(first.client, `(() => {
        const card = [...document.querySelectorAll('.issue-card')]
          .find(node => node.textContent.includes('时间先后关系形成闭环'));
        const button = card?.querySelector('.issue-suggest-fix');
        const marked = card?.dataset.stale === 'true' || card?.classList.contains('is-stale');
        return card && button?.disabled && marked && /证据已变更|证据已过期|重新分析/.test(card.textContent)
          ? { text: card.textContent, disabled: button.disabled }
          : null;
      })()`, 'the externally drifted issue becoming stale and non-actionable');
      assert.strictEqual(stale.disabled, true);
      const closed = await first.client.evaluate(`(() => {
        const card = [...document.querySelectorAll('.issue-card')]
          .find(node => node.textContent.includes('时间先后关系形成闭环'));
        card.querySelector('.issue-suggest-fix').click();
        const issueBanner = document.querySelector('.changes-issue-mode');
        return {
          dockMode: window.__assistantDock.getMode(),
          issueReviewVisible: Boolean(issueBanner && !issueBanner.hidden),
        };
      })()`);
      assert.strictEqual(closed.issueReviewVisible, false);
      assert.notStrictEqual(closed.dockMode, 'changes');
      assert.strictEqual((first.logRef.value.match(/GRAPH_ISSUE_PROVIDER_CALL/g) || []).length, providerCallsBefore,
        'stale issue must stop before the Graph Issue provider is called');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownAfterExternalWrite,
        'stale issue action must add no manuscript mutation after the external write');
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore,
        'stale issue action must add no Change History');

      const drifted = projectService.readFileWithRevision(project.rootPath, issuePath);
      projectService.atomicWriteFile(project.rootPath, issuePath, original.content, drifted.revision);
      await first.client.evaluate(`document.getElementById('graph-refresh').click()`);
      await waitForValue(first.client, `(() => {
        const card = [...document.querySelectorAll('.issue-card')]
          .find(node => node.textContent.includes('时间先后关系形成闭环'));
        const button = card?.querySelector('.issue-suggest-fix');
        return card && button && !button.disabled && card.dataset.stale !== 'true' && !card.classList.contains('is-stale');
      })()`, 'the restored evidence receiving a fresh repair binding');
      assert.strictEqual(projectService.readFile(project.rootPath, issuePath), original.content);
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBefore);
    });

    await stage('hands a Main-bound Graph Issue to locked Changes and requires a complete hunk decision', async () => {
      const issuePath = 'chapters/02-data-dispute.md';
      const beforeDisk = projectService.readFile(project.rootPath, issuePath);
      const editBefore = projectService.readFile(project.rootPath, 'edit.md');
      const historyPath = path.join(project.rootPath, changeHistoryService.HISTORY_RELATIVE_PATH);
      const historyBeforeIncomplete = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;
      assert(beforeDisk.includes(electronAiFixture.GRAPH_ISSUE_BEFORE_ONE));
      assert(beforeDisk.includes(electronAiFixture.GRAPH_ISSUE_BEFORE_TWO));

      // Exercise the Main gate directly once: a partial decision must fail
      // without consuming the capability or writing manuscript/history bytes.
      const direct = await first.client.evaluate(`(async () => {
        const projectInstanceId = window.__workspace.state.project.instanceId;
        const built = await window.writCraft.project.buildGraph(projectInstanceId);
        const issue = built.graph.issues.find(item => item.type === 'timeline_conflict' && item.changesHandoff);
        if (!issue) return { ok: false, error: 'NO_BOUND_TIMELINE_ISSUE' };
        const handoff = await window.writCraft.project.handoffGraphIssue(projectInstanceId, issue.changesHandoff);
        return { projectInstanceId, request: issue.changesHandoff, handoff };
      })()`, true);
      assert.strictEqual(direct.handoff.ok, true);
      assert.strictEqual(direct.handoff.proposalKind, 'graph_issue');
      assert.strictEqual(direct.handoff.requireCompleteDecision, true);
      assert.strictEqual(direct.handoff.review.totalHunks, 2);
      const firstHunkId = direct.handoff.review.files[0].hunks[0].id;
      const incomplete = await first.client.evaluate(`window.writCraft.project.applyChanges(
        ${JSON.stringify(direct.projectInstanceId)},
        ${JSON.stringify({
          schema: 'writcraft.changes-decision/v1',
          changeSetId: direct.handoff.changeSetId,
          acceptHunkIds: [firstHunkId],
          rejectHunkIds: [],
        })}
      )`, true);
      assert.strictEqual(incomplete.ok, false);
      assert.strictEqual(incomplete.error?.code, 'ISSUE_REVIEW_INCOMPLETE');
      assert.strictEqual(projectService.readFile(project.rootPath, issuePath), beforeDisk);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);
      assert.strictEqual(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, historyBeforeIncomplete,
        'incomplete Graph Issue review must write zero history bytes');
      const discarded = await first.client.evaluate(`window.writCraft.project.discardChanges(
        ${JSON.stringify(direct.projectInstanceId)}, ${JSON.stringify(direct.handoff.changeSetId)}
      )`, true);
      assert.strictEqual(discarded.ok, true, 'incomplete review must retain its capability until explicit discard');

      await first.client.evaluate(`(() => {
        const scope = document.getElementById('graph-scope');
        scope.value = 'project';
        scope.dispatchEvent(new Event('change', { bubbles: true }));
        window.__graphView.open();
      })()`);
      await waitForValue(first.client, `(() => [...document.querySelectorAll('.issue-card')].some(card =>
        card.textContent.includes('时间先后关系形成闭环') && card.querySelector('.issue-suggest-fix:not(:disabled)')
      ))()`, 'the bound timeline issue repair action');
      const opened = await first.client.evaluate(`(() => {
        const card = [...document.querySelectorAll('.issue-card')].find(item => item.textContent.includes('时间先后关系形成闭环'));
        card.querySelector('.issue-suggest-fix').click();
        return true;
      })()`);
      assert.strictEqual(opened, true);
      const review = await waitForValue(first.client, `(() => {
        const banner = document.querySelector('.changes-issue-mode');
        const cards = [...document.querySelectorAll('.change-hunk-card')];
        const input = document.getElementById('changes-instruction');
        if (!banner || banner.hidden || cards.length !== 2 || !input.readOnly) return null;
        return {
          banner: banner.textContent,
          states: cards.map(card => card.className),
          contextHidden: document.getElementById('composer-context-picker').hidden,
          chapterHidden: document.getElementById('changes-chapter').hidden,
        };
      })()`, 'the locked Graph Issue review');
      assert(review.banner.includes(issuePath));
      assert(review.states.every(value => value.includes('is-pending')));
      assert.strictEqual(review.contextHidden, true);
      assert.strictEqual(review.chapterHidden, true);
      assert.strictEqual(projectService.readFile(project.rootPath, issuePath), beforeDisk);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);

      const partialUi = await first.client.evaluate(`(() => {
        document.querySelector('.change-hunk-card .change-decision--accepted').click();
        return {
          disabled: document.getElementById('changes-apply').disabled,
          status: document.getElementById('changes-status').textContent,
        };
      })()`);
      assert.strictEqual(partialUi.disabled, true);
      assert(partialUi.status.includes('请先处理全部修改块'));
      assert.strictEqual(projectService.readFile(project.rootPath, issuePath), beforeDisk);

      await first.client.evaluate(`(() => {
        const pending = [...document.querySelectorAll('.change-hunk-card')].find(card => card.classList.contains('is-pending'));
        pending.querySelector('.change-decision--accepted').click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const banner = document.querySelector('.changes-issue-mode');
        return banner?.hidden && !document.getElementById('changes-instruction').readOnly &&
          document.getElementById('changes-status').textContent.includes('星图问题修复已安全写入');
      })()`, 'the complete Graph Issue review write and locked-mode exit');
      const afterDisk = projectService.readFile(project.rootPath, issuePath);
      assert(afterDisk.includes(electronAiFixture.GRAPH_ISSUE_AFTER_ONE));
      assert(afterDisk.includes(electronAiFixture.GRAPH_ISSUE_AFTER_TWO));
      assert(!afterDisk.includes(electronAiFixture.GRAPH_ISSUE_BEFORE_ONE));
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore,
        'Graph Issue apply must never modify edit.md');

      const undoCount = await first.client.evaluate(`document.querySelectorAll('.history-card .history-undo').length`);
      await first.client.evaluate(`(() => {
        window.confirm = () => true;
        document.querySelector('.history-card .history-undo').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const remaining = document.querySelectorAll('.history-card .history-undo').length;
        return document.getElementById('changes-status').textContent.includes('已撤销 1 个文件') &&
          remaining === ${undoCount - 1};
      })()`, 'undoing the Graph Issue repair through real Change History');
      assert.strictEqual(projectService.readFile(project.rootPath, issuePath), beforeDisk);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('switches all four Assistant tabs in the project runtime without invoking AI', async () => {
      const runtime = await inspectRuntime(first);
      assert.deepStrictEqual(runtime.bookmarks.map(item => item.mode), ['chat', 'plan', 'context', 'changes']);
      assert.deepStrictEqual(runtime.bookmarks.map(item => item.label), ['对话', '计划', '上下文', '修改']);
      assert(runtime.bookmarks.every(item => item.role === 'tab' && item.controls));
      assert.deepStrictEqual(runtime.panels.map(item => item.mode), ['chat', 'plan', 'context', 'changes']);
      assert(runtime.panels.every(item => item.role === 'tabpanel' && item.labelledBy));
      assert.strictEqual(runtime.dockMode, null);
      assert.strictEqual(runtime.dockHidden, true);
      for (const mode of ['chat', 'plan', 'context', 'changes']) {
        const selected = await first.client.evaluate(`(() => {
          document.querySelector('[data-assistant-mode=${JSON.stringify(mode)}]').click();
          const panel = document.querySelector('[data-assistant-panel=${JSON.stringify(mode)}]');
          return {
            mode: window.__assistantDock.getMode(),
            panelVisible: !panel.hidden && getComputedStyle(panel).display !== 'none',
            selected: document.querySelector('[data-assistant-mode=${JSON.stringify(mode)}]').getAttribute('aria-selected'),
          };
        })()`);
        assert.deepStrictEqual(selected, { mode, panelVisible: true, selected: 'true' });
      }
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('sends one authoritative edit.md and current-file context through the real Chat IPC', async () => {
      assert.strictEqual(await first.client.evaluate(`window.__workspace.state.currentPath`), createdPath);
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="chat"]').click();
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      const response = await waitForValue(first.client, `(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.CHAT_RESPONSE)}));
        if (!reply) return null;
        const chips = [...reply.querySelectorAll('.chat-response-context .context-chip')]
          .map(node => ({ type: node.dataset.type, text: node.textContent, tag: node.tagName }));
        return { text: reply.textContent, chips };
      })()`, 'the file-scoped Chat response and bound manifest');
      assert(response.text.includes(electronAiFixture.CHAT_RESPONSE));
      assert.deepStrictEqual(response.chips.map(chip => chip.type), ['scope', 'project_prompt', 'file']);
      assert(response.chips.every(chip => chip.tag === 'BUTTON'));
      assert.strictEqual(response.chips.filter(chip => chip.type === 'project_prompt').length, 1);
      assert.strictEqual(response.chips.filter(chip => chip.type === 'file' && chip.text.includes(createdPath)).length, 1);
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('clears invalidated Chat preflight chips without letting a late request erase newer actual chips', async () => {
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="chat"]').click();
        document.querySelector('[data-chat-scope="file"]').click();
        document.querySelectorAll('#chat-context-chips .context-chip')
          .forEach(node => { node.dataset.e2ePreviousActual = 'true'; });
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.STALE_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      const preflightTypes = await waitForValue(first.client, `(() => {
        const chips = [...document.querySelectorAll('#chat-context-chips .context-chip')];
        const types = chips.map(node => node.dataset.type);
        const replacedPreviousActual = chips.every(node => node.dataset.e2ePreviousActual !== 'true');
        return replacedPreviousActual && types.includes('scope') && types.includes('project_prompt') && types.includes('file')
          ? types
          : null;
      })()`, 'the delayed Chat preflight chips');
      assert.deepStrictEqual(preflightTypes, ['scope', 'project_prompt', 'file']);

      const clearedImmediately = await first.client.evaluate(`(() => {
        document.querySelector('[data-chat-scope="project"]').click();
        return document.querySelectorAll('#chat-context-chips .context-chip').length;
      })()`);
      assert.strictEqual(clearedImmediately, 0, 'scope invalidation proactively clears only the stale preflight');

      await first.client.evaluate(`(() => {
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.PROJECT_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      const newerActual = await waitForValue(first.client, `(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.PROJECT_CHAT_RESPONSE)}));
        if (!reply) return null;
        const types = [...document.querySelectorAll('#chat-context-chips .context-chip')]
          .map(node => node.dataset.type);
        return types.includes('retrieval') ? types : null;
      })()`, 'the newer project Chat actual chips');
      assert(newerActual.includes('scope'));
      assert(newerActual.includes('project_prompt'));
      assert(newerActual.includes('retrieval'));

      await delay(900);
      const settled = await first.client.evaluate(`(() => ({
        topTypes: [...document.querySelectorAll('#chat-context-chips .context-chip')]
          .map(node => node.dataset.type),
        staleReplyCount: [...document.querySelectorAll('#chat-messages .chat-ai')]
          .filter(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_CHAT_RESPONSE)})).length,
        staleUserCanceled: [...document.querySelectorAll('#chat-messages .chat-user')]
          .some(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_CHAT_QUESTION)}) &&
            node.dataset.requestCanceled === 'true'),
      }))()`);
      assert.strictEqual(settled.staleReplyCount, 0, 'late invalidated request never renders a reply');
      assert.strictEqual(settled.staleUserCanceled, true, 'late invalidated request is visibly canceled');
      assert(settled.topTypes.includes('retrieval'), 'late invalidated request cannot erase newer actual chips');

      const actualSurvivesScopeChange = await first.client.evaluate(`(() => {
        document.querySelector('[data-chat-scope="file"]').click();
        return [...document.querySelectorAll('#chat-context-chips .context-chip')]
          .map(node => node.dataset.type);
      })()`);
      assert(actualSurvivesScopeChange.includes('retrieval'), 'scope changes preserve actual response provenance');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('invalidates Chat preflight on reopen, collapsed selection and authoritative workspace changes', async () => {
      await first.client.evaluate(`window.__workspace.openFile(${JSON.stringify(createdPath)})`);
      await waitForValue(first.client, `window.__workspace.state.currentPath === ${JSON.stringify(createdPath)}`, 'returning to the Chat invalidation fixture');

      await first.client.evaluate(`(() => {
        window.__editor.triggerChat();
        document.querySelector('[data-chat-scope="file"]').click();
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.STALE_REOPEN_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const types = [...document.querySelectorAll('#chat-context-chips .context-chip')].map(node => node.dataset.type);
        return types.join(',') === 'scope,project_prompt,file';
      })()`, 'the reopen invalidation preflight');
      const reopened = await first.client.evaluate(`(() => {
        window.__assistantDock.close();
        const editor = document.getElementById('editor');
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let target = null;
        let start = -1;
        while (walker.nextNode()) {
          const offset = walker.currentNode.data.indexOf(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)});
          if (offset >= 0) { target = walker.currentNode; start = offset; break; }
        }
        if (!target) return null;
        const range = document.createRange();
        range.setStart(target, start);
        range.setEnd(target, start + ${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)}.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        window.__editor.triggerChat();
        return {
          chipCount: document.querySelectorAll('#chat-context-chips .context-chip').length,
          selectionPressed: document.querySelector('[data-chat-scope="selection"]').getAttribute('aria-pressed'),
        };
      })()`);
      assert.deepStrictEqual(reopened, { chipCount: 0, selectionPressed: 'true' });
      await waitForValue(first.client, `(() => [...document.querySelectorAll('#chat-messages .chat-user')]
        .some(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_REOPEN_CHAT_QUESTION)}) &&
          node.dataset.requestCanceled === 'true'))()`, 'the reopened Chat request cancellation');

      await first.client.evaluate(`(() => {
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.STALE_SELECTION_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const types = [...document.querySelectorAll('#chat-context-chips .context-chip')].map(node => node.dataset.type);
        return types.join(',') === 'scope,project_prompt,selection,neighbor,neighbor';
      })()`, 'the collapsed-selection preflight');
      const collapsed = await first.client.evaluate(`(() => {
        const editor = document.getElementById('editor');
        editor.focus();
        const selection = window.getSelection();
        selection.collapseToEnd();
        document.dispatchEvent(new Event('selectionchange'));
        return {
          chipCount: document.querySelectorAll('#chat-context-chips .context-chip').length,
          selectionDisabled: document.querySelector('[data-chat-scope="selection"]').disabled,
          filePressed: document.querySelector('[data-chat-scope="file"]').getAttribute('aria-pressed'),
        };
      })()`);
      assert.deepStrictEqual(collapsed, { chipCount: 0, selectionDisabled: true, filePressed: 'true' });
      await waitForValue(first.client, `(() => [...document.querySelectorAll('#chat-messages .chat-user')]
        .some(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_SELECTION_CHAT_QUESTION)}) &&
          node.dataset.requestCanceled === 'true'))()`, 'the collapsed-selection request cancellation');

      await first.client.evaluate(`(() => {
        window.__editor.triggerChat();
        document.querySelector('[data-chat-scope="file"]').click();
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.STALE_WORKSPACE_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const types = [...document.querySelectorAll('#chat-context-chips .context-chip')].map(node => node.dataset.type);
        return types.join(',') === 'scope,project_prompt,file';
      })()`, 'the workspace invalidation preflight');
      const externalPath = createdPath;
      const externalBefore = projectService.readFileWithRevision(project.rootPath, externalPath);
      projectService.atomicWriteFile(
        project.rootPath,
        externalPath,
        `${externalBefore.content}\n\nE2E_CHAT_CONTEXT_INVALIDATION`,
        externalBefore.revision
      );
      await waitForValue(first.client, `document.querySelectorAll('#chat-context-chips .context-chip').length === 0`, 'the authoritative workspace invalidation clearing preflight');
      await waitForValue(first.client, `document.getElementById('editor').innerText.includes('E2E_CHAT_CONTEXT_INVALIDATION')`, 'the externally changed current file reloading');
      await delay(1000);
      const workspaceInvalidation = await first.client.evaluate(`(() => {
        const matching = [...document.querySelectorAll('#chat-messages .chat-user')]
          .filter(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_WORKSPACE_CHAT_QUESTION)}))
          .map(node => ({
            text: node.textContent,
            canceled: node.dataset.requestCanceled === 'true',
            connected: node.isConnected,
          }));
        return {
          matching,
          staleReplies: [...document.querySelectorAll('#chat-messages .chat-ai')]
            .filter(node => node.textContent.includes(${JSON.stringify(electronAiFixture.STALE_WORKSPACE_CHAT_RESPONSE)})).length,
          topTypes: [...document.querySelectorAll('#chat-context-chips .context-chip')].map(node => node.dataset.type),
          aiTail: [...document.querySelectorAll('#chat-messages .chat-ai')].slice(-3).map(node => node.textContent),
        };
      })()`);
      assert.strictEqual(workspaceInvalidation.matching.length, 1, JSON.stringify(workspaceInvalidation));
      assert.strictEqual(
        workspaceInvalidation.matching[workspaceInvalidation.matching.length - 1].canceled,
        true,
        JSON.stringify(workspaceInvalidation)
      );
      assert.strictEqual(workspaceInvalidation.staleReplies, 0, JSON.stringify(workspaceInvalidation));
      const externalChanged = projectService.readFileWithRevision(project.rootPath, externalPath);
      projectService.atomicWriteFile(project.rootPath, externalPath, externalBefore.content, externalChanged.revision);
      await waitForValue(first.client, `!document.getElementById('editor').innerText.includes('E2E_CHAT_CONTEXT_INVALIDATION')`, 'restoring the Chat invalidation fixture');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('uses project scope with bounded retrieval and clickable @file/@section/@entity/@source reply chips', async () => {
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="chat"]').click();
        document.querySelector('[data-chat-scope="project"]').click();
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.PROJECT_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
      })()`);
      const response = await waitForValue(first.client, `(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.PROJECT_CHAT_RESPONSE)}));
        if (!reply) return null;
        const chips = [...reply.querySelectorAll('.chat-response-context .context-chip')]
          .map(node => ({ type: node.dataset.type, text: node.textContent, tag: node.tagName }));
        return { chips, scopePressed: document.querySelector('[data-chat-scope="project"]').getAttribute('aria-pressed') };
      })()`, 'the project-scoped Chat response with explicit and retrieved Main chips');
      assert.strictEqual(response.scopePressed, 'true');
      assert(response.chips.every(chip => chip.tag === 'BUTTON'));
      for (const type of ['scope', 'project_prompt', 'file', 'section', 'entity', 'source', 'retrieval']) {
        assert(response.chips.some(chip => chip.type === type), `missing project Chat chip: ${type}`);
      }
      assert(!response.chips.some(chip => chip.type === 'file' && chip.text.includes(createdPath)));

      const inspector = await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="context"]').click();
        return {
          text: document.getElementById('context-inspector-host').textContent,
          types: [...document.querySelectorAll('#context-inspector-host .context-inspector__card')]
            .map(node => [...node.classList].find(value => value.startsWith('context-inspector__card--'))),
        };
      })()`);
      assert(inspector.text.includes('项目范围'));
      assert(inspector.types.includes('context-inspector__card--retrieval'));

      const clickReplyChip = async (type, expectedPath, expectedText) => {
        const clicked = await first.client.evaluate(`(() => {
          const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
            .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.PROJECT_CHAT_RESPONSE)}));
          const chip = [...reply.querySelectorAll('.chat-response-context .context-chip')]
            .find(node => node.dataset.type === ${JSON.stringify(type)});
          if (!chip || chip.tagName !== 'BUTTON') return false;
          chip.click();
          return true;
        })()`);
        assert.strictEqual(clicked, true, `clickable ${type} reply chip`);
        await waitForValue(first.client, `(() => window.__workspace.state.currentPath === ${JSON.stringify(expectedPath)} &&
          ${expectedText ? `window.getSelection().toString().includes(${JSON.stringify(expectedText)})` : 'true'})()`, `locating ${type} reply chip`);
        if (expectedText) {
          const stableAfterViewRestore = await first.client.evaluate(`(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return window.__workspace.state.currentPath === ${JSON.stringify(expectedPath)} &&
              window.getSelection().toString().includes(${JSON.stringify(expectedText)});
          })()`);
          assert.strictEqual(stableAfterViewRestore, true, `${type} reply chip selection survives deferred view restoration`);
        }
      };
      await clickReplyChip('file', 'chapters/03-archive-room.md', null);
      await clickReplyChip('section', 'chapters/03-archive-room.md', '第三章 · 档案室');
      await clickReplyChip('entity', 'references/interviews.md', '周鹭');
      await clickReplyChip('source', 'references/meeting-minutes.md', '海岬城旧港公开听证纪要');

      const retrievalLocator = await first.client.evaluate(`(() => {
        const chipState = window.__contextInspectorView.getState().snapshot.chips
          .find(chip => chip.type === 'retrieval');
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.PROJECT_CHAT_RESPONSE)}));
        const chip = [...reply.querySelectorAll('.chat-response-context .context-chip')]
          .find(node => node.dataset.type === 'retrieval');
        if (!chip || !chipState?.locator) return null;
        chip.click();
        return chipState.locator;
      })()`);
      assert(retrievalLocator?.filePath, 'retrieval chip exposes a Main locator');
      const retrievalText = projectService.readFile(project.rootPath, retrievalLocator.filePath)
        .slice(retrievalLocator.offset, retrievalLocator.endOffset);
      assert(retrievalText.includes('季度复核'), 'deterministic top retrieval matches the user query');
      await waitForValue(first.client, `(() => window.__workspace.state.currentPath === ${JSON.stringify(retrievalLocator.filePath)} &&
        window.getSelection().toString() === ${JSON.stringify(retrievalText)})()`, 'locating the deterministic project retrieval chip');

      await first.client.evaluate(`(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.PROJECT_CHAT_RESPONSE)}));
        reply.querySelector('.chat-response-context .context-chip[data-type="scope"]').click();
      })()`);
      await waitForValue(first.client, `document.getElementById('save-state').textContent.includes('上下文说明')`, 'explaining a scope chip without guessing a locator');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('uses selection scope with exact offsets and two clickable neighboring paragraphs', async () => {
      await first.client.evaluate(`window.__workspace.openFile(${JSON.stringify(createdPath)})`);
      await waitForValue(first.client, `window.__workspace.state.currentPath === ${JSON.stringify(createdPath)}`, 'returning to the Chat selection fixture');
      const selected = await first.client.evaluate(`(() => {
        const editor = document.getElementById('editor');
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let target = null;
        let localStart = -1;
        while (walker.nextNode()) {
          const offset = walker.currentNode.data.indexOf(${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)});
          if (offset >= 0) { target = walker.currentNode; localStart = offset; break; }
        }
        if (!target) return false;
        const range = document.createRange();
        range.setStart(target, localStart);
        range.setEnd(target, localStart + ${JSON.stringify(electronAiFixture.REWRITE_OUTPUT)}.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        document.querySelector('[data-assistant-mode="chat"]').click();
        const scope = document.querySelector('[data-chat-scope="selection"]');
        if (scope.disabled) return false;
        scope.click();
        const input = document.getElementById('chat-input');
        input.value = ${JSON.stringify(electronAiFixture.SELECTION_CHAT_QUESTION)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('chat-submit').click();
        return true;
      })()`);
      assert.strictEqual(selected, true);
      const response = await waitForValue(first.client, `(() => {
        const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
          .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.SELECTION_CHAT_RESPONSE)}));
        if (!reply) return null;
        const chips = [...reply.querySelectorAll('.chat-response-context .context-chip')];
        return {
          types: chips.map(node => node.dataset.type),
          tags: chips.map(node => node.tagName),
          scopePressed: document.querySelector('[data-chat-scope="selection"]').getAttribute('aria-pressed'),
        };
      })()`, 'the selection-scoped Chat response');
      assert.strictEqual(response.scopePressed, 'true');
      assert.deepStrictEqual(response.types, ['scope', 'project_prompt', 'selection', 'neighbor', 'neighbor']);
      assert(response.tags.every(tag => tag === 'BUTTON'));

      const expectedNeighbors = [electronAiFixture.REWRITE_BEFORE, electronAiFixture.REWRITE_AFTER];
      for (let index = 0; index < expectedNeighbors.length; index += 1) {
        await first.client.evaluate(`(() => {
          const reply = [...document.querySelectorAll('#chat-messages .chat-ai')]
            .find(node => node.textContent.includes(${JSON.stringify(electronAiFixture.SELECTION_CHAT_RESPONSE)}));
          [...reply.querySelectorAll('.context-chip[data-type="neighbor"]')][${index}].click();
        })()`);
        await waitForValue(first.client, `window.getSelection().toString() === ${JSON.stringify(expectedNeighbors[index])}`, `locating selection neighbor ${index + 1}`);
      }
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('runs Research through dedicated Changes preview, apply, provenance history and undo', async () => {
      const researchTargetBefore = projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH);
      const editBefore = projectService.readFile(project.rootPath, 'edit.md');
      const accuracyBefore = await first.client.evaluate(`window.WritCraftAiMetrics.aggregate()`);
      await first.client.evaluate(`document.querySelector('[data-view="sources"]').click()`);
      await waitForValue(first.client, `document.querySelectorAll('#source-index-list .source-card').length >= 2`, 'the real Source Index GUI');
      const prepared = await first.client.evaluate(`(() => {
        const card = [...document.querySelectorAll('#source-index-list .source-card')]
          .find(node => node.textContent.includes('公开听证纪要'));
        const checkbox = card?.querySelector('input[type="checkbox"]');
        if (!checkbox) return false;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        const question = document.getElementById('source-research-question');
        question.value = '这份纪要能支持哪条关于试运行状态的主张？';
        question.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('source-research-run').click();
        return true;
      })()`);
      assert.strictEqual(prepared, true);
      await waitForValue(first.client, `document.querySelector('.research-card .research-claim')?.textContent.includes('附条件试运行')`, 'the first Research evidence card');

      fs.appendFileSync(
        path.join(project.rootPath, 'references', 'meeting-minutes.md'),
        `\nE2E 外部修订 ${Date.now()}。\n`,
        'utf8'
      );
      await delay(400);
      const staleRejected = await first.client.evaluate(`(() => {
        document.querySelector('.research-card .research-source').click();
        return true;
      })()`);
      assert.strictEqual(staleRejected, true);
      const staleState = await waitForValue(first.client, `(() => {
        const note = [...document.querySelectorAll('.research-card > .research-boundary')]
          .find(node => !node.hidden && node.textContent.includes('变化'));
        const button = document.querySelector('.research-card .research-to-changes');
        if (!note?.textContent.includes('变化') || !button?.disabled) return null;
        return { note: note.textContent, mode: window.__assistantDock.getMode() };
      })()`, 'stale Research rejection');
      assert.notStrictEqual(staleState.mode, 'changes');

      await first.client.evaluate(`(() => {
        document.querySelector('.research-card').dataset.e2eStaleCard = 'true';
        document.getElementById('source-research-run').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const card = document.querySelector('.research-card:not([data-e2e-stale-card])');
        return card && card.querySelector('.research-boundary[hidden]') ? card : null;
      })()`, 'fresh Research evidence card');

      // Exercise a true late-open A→B race: A starts its Main resolution, then
      // an authoritative rerun invalidates the open sequence before A returns.
      await first.client.evaluate(`document.querySelector('.research-card .research-source').click()`);
      await waitForValue(first.client, `[...document.querySelectorAll('.research-card .research-judgment-option')].every(button => !button.disabled)`,
        'opening the A card source before the late-open race');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        card.dataset.e2eLateOpenA = 'true';
        [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张匹配').click();
      })()`);
      await waitForValue(first.client, `[...document.querySelectorAll('.research-card .research-judgment-option')].find(button => button.textContent === '主张匹配')?.getAttribute('aria-pressed') === 'true'`,
        'persisting the A author match judgment');
      const raced = await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        card.querySelector('.research-to-changes').click();
        document.getElementById('source-research-run').click();
        return true;
      })()`);
      assert.strictEqual(raced, true);
      await waitForValue(first.client, `(() => {
        const card = document.querySelector('.research-card:not([data-e2e-late-open-a])');
        return card && card.querySelector('.research-claim')?.textContent.includes('附条件试运行') &&
          window.__assistantDock.getMode() !== 'changes';
      })()`, 'B Research card winning the late-open A race');

      const requiresConfirmation = await first.client.evaluate(`(() => {
        const button = document.querySelector('.research-card .research-to-changes');
        button.click();
        return { disabled: button.disabled, mode: window.__assistantDock.getMode() };
      })()`);
      assert.strictEqual(requiresConfirmation.disabled, true);
      assert.notStrictEqual(requiresConfirmation.mode, 'changes');
      await first.client.evaluate(`document.querySelector('.research-card .research-source').click()`);
      await waitForValue(first.client, `[...document.querySelectorAll('.research-card .research-judgment-option')].every(button => !button.disabled)`,
        'opening and manually inspecting the fresh Research source');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张不匹配').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const card = document.querySelector('.research-card');
        const mismatch = [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张不匹配');
        return mismatch?.getAttribute('aria-pressed') === 'true' && card.querySelector('.research-to-changes').disabled;
      })()`, 'recording mismatch without unlocking Changes');
      const mismatchGate = await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        card.querySelector('.research-to-changes').click();
        return window.__assistantDock.getMode();
      })()`);
      assert.notStrictEqual(mismatchGate, 'changes');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张匹配').click();
      })()`);
      await waitForValue(first.client, `(() => {
        const card = document.querySelector('.research-card');
        const match = [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张匹配');
        return match?.getAttribute('aria-pressed') === 'true' && !card.querySelector('.research-to-changes').disabled;
      })()`, 'correcting the same card to one persisted match sample');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        card.querySelector('.research-to-changes').click();
      })()`);
      await waitForValue(first.client, `window.__assistantDock.getMode() === 'changes' && !document.querySelector('.changes-research-mode')?.hidden`,
        'opening dedicated Research Changes mode');
      await first.client.evaluate(`(() => {
        const target = document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(electronAiFixture.RESEARCH_TARGET_PATH)}]');
        if (!target) return false;
        if (!target.checked) {
          target.checked = true;
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      })()`);
      const handedOff = await waitForValue(first.client, `(() => {
        const banner = document.querySelector('.changes-research-mode');
        const target = document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(electronAiFixture.RESEARCH_TARGET_PATH)}]');
        if (window.__assistantDock.getMode() !== 'changes' || banner?.hidden || !target) return null;
        return {
          banner: banner.textContent,
          instructionHidden: document.getElementById('changes-instruction').hidden,
          targetChecked: target.checked,
          targetCount: document.getElementById('project-changes-target-count').textContent,
          button: document.getElementById('changes-propose').textContent,
        };
      })()`, 'human-confirmed Research dedicated Changes mode');
      assert(handedOff.banner.includes('Research 证据卡专用模式'));
      assert(handedOff.banner.includes('来源只读'));
      assert(handedOff.banner.includes('不能支持系统已正式验收'));
      assert.strictEqual(handedOff.instructionHidden, true);
      assert.strictEqual(handedOff.targetChecked, true);
      assert.strictEqual(handedOff.targetCount, '1 / 8');
      assert.strictEqual(handedOff.button, '依据核对卡生成 Diff');
      assert.strictEqual(projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH), researchTargetBefore);

      await first.client.evaluate(`document.getElementById('changes-propose').click()`);
      const preview = await waitForValue(first.client, `(() => {
        const hunk = document.querySelector('#changes-preview .change-hunk-card');
        const status = document.getElementById('changes-status').textContent;
        if (!hunk || !status.includes('来源只读') || !status.includes('当前仅为预览')) return null;
        return { text: hunk.textContent, applyHidden: document.getElementById('changes-apply').hidden };
      })()`, 'Research Changes preview after delivery ACK');
      assert(preview.text.includes(electronAiFixture.RESEARCH_BEFORE));
      assert(preview.text.includes(electronAiFixture.RESEARCH_AFTER));
      assert.strictEqual(preview.applyHidden, false);
      assert.strictEqual(projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH), researchTargetBefore,
        'Research preview must write zero manuscript bytes');
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore,
        'Research preview must keep edit.md readonly');

      await first.client.evaluate(`(() => {
        const accept = [...document.querySelectorAll('#changes-preview .change-hunk-actions button')]
          .find(node => node.textContent === '接受');
        if (!accept) return false;
        accept.click();
        document.getElementById('changes-apply').click();
        return true;
      })()`);
      await waitForValue(first.client, `document.getElementById('changes-status').textContent.includes('Research 修改已安全应用 1 个文件')`,
        'Research Changes apply');
      const researchApplied = projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH);
      assert(researchApplied.includes(electronAiFixture.RESEARCH_AFTER));
      assert(!researchApplied.includes(electronAiFixture.RESEARCH_BEFORE));
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);

      const history = await first.client.evaluate(`window.writCraft.project.listChangeHistory()`);
      assert.strictEqual(history.ok, true);
      const researchEntry = history.history.find(entry => entry.provenance?.kind === 'research_card');
      assert(researchEntry, 'Research application must retain public provenance');
      assert.strictEqual(researchEntry.provenance.schema, 'writcraft.research-handoff/v1');
      assert.match(researchEntry.provenance.cardId, /^rc_[a-f0-9]{32}$/);
      assert.match(researchEntry.provenance.evidence.quoteDigest, /^sha256:[a-f0-9]{64}$/);
      assert.strictEqual(researchEntry.provenance.evidence.path, 'references/meeting-minutes.md');
      assert(researchEntry.provenance.targets.some(target => target.path === electronAiFixture.RESEARCH_TARGET_PATH));

      const undoCount = await first.client.evaluate(`document.querySelectorAll('.history-card .history-undo').length`);
      await first.client.evaluate(`(() => {
        window.confirm = () => true;
        document.querySelector('.history-card .history-undo').click();
      })()`);
      await waitForValue(first.client, `(() => document.getElementById('changes-status').textContent.includes('已撤销 1 个文件') &&
        document.querySelectorAll('.history-card .history-undo').length === ${undoCount - 1})()`, 'undoing Research Changes');
      assert.strictEqual(projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH), researchTargetBefore);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);

      // A second card follows the same human-confirmed path but rejects every
      // hunk. It must write a provenance-bearing review entry and zero file bytes.
      await first.client.evaluate(`(() => {
        document.querySelector('[data-view="sources"]').click();
        document.getElementById('source-research-run').click();
      })()`);
      await waitForValue(first.client, `document.querySelector('.research-card .research-claim')?.textContent.includes('附条件试运行')`,
        'Research reject-only evidence card');
      await first.client.evaluate(`document.querySelector('.research-card .research-source').click()`);
      await waitForValue(first.client, `[...document.querySelectorAll('.research-card .research-judgment-option')].every(button => !button.disabled)`,
        'opening the reject-only Research source');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        [...card.querySelectorAll('.research-judgment-option')].find(button => button.textContent === '主张匹配').click();
      })()`);
      await waitForValue(first.client, `[...document.querySelectorAll('.research-card .research-judgment-option')].find(button => button.textContent === '主张匹配')?.getAttribute('aria-pressed') === 'true'`,
        'persisting reject-only card match judgment');
      await first.client.evaluate(`(() => {
        const card = document.querySelector('.research-card');
        card.querySelector('.research-to-changes').click();
      })()`);
      await waitForValue(first.client, `window.__assistantDock.getMode() === 'changes' && !document.querySelector('.changes-research-mode')?.hidden`,
        'opening reject-only Research Changes mode');
      await first.client.evaluate(`(() => {
        const target = document.querySelector('#project-changes-target-list input[data-path=${JSON.stringify(electronAiFixture.RESEARCH_TARGET_PATH)}]');
        if (!target.checked) {
          target.checked = true;
          target.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.getElementById('changes-propose').click();
      })()`);
      await waitForValue(first.client, `document.querySelector('#changes-preview .change-hunk-card') &&
        document.getElementById('changes-status').textContent.includes('当前仅为预览')`, 'reject-only Research preview');
      const historyBeforeReject = await first.client.evaluate(`window.writCraft.project.listChangeHistory()`);
      await first.client.evaluate(`(() => {
        for (const button of document.querySelectorAll('#changes-preview .change-decision--rejected')) button.click();
        document.getElementById('changes-apply').click();
      })()`);
      await waitForValue(first.client, `document.getElementById('changes-status').textContent.includes('项目文件没有变化')`,
        'Research reject-only completion');
      assert.strictEqual(projectService.readFile(project.rootPath, electronAiFixture.RESEARCH_TARGET_PATH), researchTargetBefore);
      assert.strictEqual(projectService.readFile(project.rootPath, 'edit.md'), editBefore);
      const historyAfterReject = await first.client.evaluate(`window.writCraft.project.listChangeHistory()`);
      assert.strictEqual(historyAfterReject.history.length, historyBeforeReject.history.length + 1);
      const rejectEntry = historyAfterReject.history[0];
      assert.strictEqual(rejectEntry.provenance?.kind, 'research_card');
      assert.strictEqual(rejectEntry.files.length, 0);
      assert(rejectEntry.review?.rejectedHunkIds?.length > 0);

      const accuracyAfter = await first.client.evaluate(`window.WritCraftAiMetrics.aggregate()`);
      assert.strictEqual(accuracyAfter.status, 'ready');
      const baselineAccuracy = accuracyBefore.status === 'ready'
        ? accuracyBefore.metrics.authorEvidence?.researchAccuracy?.sampleSize || 0
        : 0;
      const baselineMatched = accuracyBefore.status === 'ready'
        ? accuracyBefore.metrics.authorEvidence?.researchAccuracy?.matched || 0
        : 0;
      assert.strictEqual(accuracyAfter.metrics.authorEvidence.researchAccuracy.sampleSize, baselineAccuracy + 3);
      assert.strictEqual(accuracyAfter.metrics.authorEvidence.researchAccuracy.matched, baselineMatched + 3);
      assert.strictEqual(accuracyAfter.metrics.authorEvidence.researchAccuracy.mismatched, 0);
      assert.strictEqual(accuracyAfter.metrics.authorEvidence.researchAccuracy.matchRate, 1);

      await first.client.evaluate(`window.__workspace.openFile(${JSON.stringify(electronAiFixture.RESEARCH_TARGET_PATH)}, { pin: true })`);
      await waitForValue(first.client, `window.__workspace.state.currentPath === ${JSON.stringify(electronAiFixture.RESEARCH_TARGET_PATH)}`,
        'restoring the manuscript tab after Research source inspection');
      await first.client.evaluate(`window.__assistantDock.close()`);
    });

    await stage('records and aggregates project-local AI metrics through real IPC', async () => {
      const aggregate = await first.client.evaluate(`(async () => {
        const origin = window.__workspace.state.project.instanceId;
        const baseline = await window.WritCraftAiMetrics.aggregate();
        const operationId = window.WritCraftAiMetrics.createOperationId();
        const generated = await window.WritCraftAiMetrics.record(origin, {
          operationId, action: 'changeset', outcome: 'generated', style: 'none', scope: 'multi_file',
          durationMs: 240, beforeChars: 1200, afterChars: 1240,
        });
        const accepted = await window.WritCraftAiMetrics.record(origin, {
          operationId, action: 'changeset', outcome: 'accepted', style: 'none', scope: 'multi_file',
          durationMs: 510, beforeChars: 1200, afterChars: 1240,
        });
        document.getElementById('ai-metrics-review').open = true;
        const result = await window.WritCraftAiMetrics.aggregate();
        return { generated, accepted, baseline, result };
      })()`);
      assert.strictEqual(aggregate.generated, true);
      assert.strictEqual(aggregate.accepted, true);
      assert.strictEqual(aggregate.result.status, 'ready');
      const baselineMetrics = aggregate.baseline.status === 'ready'
        ? aggregate.baseline.metrics
        : { sampleSize: 0, outcomes: { generated: 0, accepted: 0 } };
      assert.strictEqual(aggregate.result.metrics.sampleSize, baselineMetrics.sampleSize + 2);
      assert.strictEqual(aggregate.result.metrics.outcomes.generated, (baselineMetrics.outcomes.generated || 0) + 1);
      assert.strictEqual(aggregate.result.metrics.outcomes.accepted, (baselineMetrics.outcomes.accepted || 0) + 1);
      const expectedAccepted = (baselineMetrics.outcomes.accepted || 0) + 1;
      const expectedDecisions = expectedAccepted + (baselineMetrics.outcomes.rejected || 0);
      assert.strictEqual(aggregate.result.metrics.acceptanceRate, expectedAccepted / expectedDecisions);
      const expectedMetricsLabel = `已记录${aggregate.result.metrics.sampleSize} 次`;
      await waitForValue(first.client, `document.getElementById('ai-metrics-view')?.textContent.includes(${JSON.stringify(expectedMetricsLabel)})`, 'rendered project AI metrics aggregate');

      const metricsPath = path.join(project.rootPath, '.writcraft', 'metrics.json');
      const persisted = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
      assert.strictEqual(persisted.events.length, aggregate.result.metrics.sampleSize);
      assert(persisted.events.every(event => !Object.keys(event).some(key => /prompt|content|path|key/i.test(key))));
    });

    await stage('keeps manuscript unchanged through image preview, then rates and explicitly inserts', async () => {
      assert.strictEqual(await first.client.evaluate(`window.__workspace.state.currentPath`), createdPath);
      const beforeRenderer = await first.client.evaluate(`window.__editor.getContent()`);
      const beforeDisk = projectService.readFile(project.rootPath, createdPath);
      assert.strictEqual(beforeRenderer, beforeDisk);
      await first.client.evaluate(`(() => {
        document.querySelector('[data-assistant-mode="chat"]').click();
        document.getElementById('image-toggle').click();
        const prompt = document.getElementById('image-prompt');
        prompt.value = ${JSON.stringify(electronAiFixture.IMAGE_PROMPT)};
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('image-generate').click();
      })()`);
      const preview = await waitForValue(first.client, `(() => {
        const image = document.querySelector('#image-result .image-preview');
        const note = document.querySelector('#image-result .image-result-note');
        if (!image?.complete || image.naturalWidth !== 16 || image.naturalHeight !== 9 ||
            !note?.textContent.includes('尚未插入正文')) return null;
        return { source: image.src, note: note.textContent, text: window.__editor.getContent() };
      })()`, 'decoded image preview');
      assert(preview.source.startsWith('data:image/png;base64,'));
      assert.strictEqual(preview.text, beforeRenderer);
      assert.strictEqual(projectService.readFile(project.rootPath, createdPath), beforeDisk);

      await first.client.evaluate(`(() => {
        document.querySelector('#image-result .image-rating').value = '4';
        document.querySelector('#image-result .image-result-actions .is-primary').click();
      })()`);
      await waitForValue(first.client, `document.querySelector('#image-result .image-state')?.textContent.includes('已插入正文')`, 'rated explicit image insertion');
      const afterRenderer = await first.client.evaluate(`window.__editor.getContent()`);
      const afterDisk = projectService.readFile(project.rootPath, createdPath);
      assert(afterRenderer.includes('![WritCraft E2E 配图验收：旧港档案室](../assets/generated/image-'));
      assert.strictEqual(afterRenderer, afterDisk);
      const generatedDirectory = path.join(project.rootPath, 'assets', 'generated');
      const generatedFiles = fs.readdirSync(generatedDirectory).filter(name => name.endsWith('.png'));
      assert.strictEqual(generatedFiles.length, 1);
      for (const generatedFile of generatedFiles) {
        assert.deepStrictEqual(
          fs.readFileSync(path.join(generatedDirectory, generatedFile)),
          Buffer.from(electronAiFixture.PNG_BASE64, 'base64')
        );
      }
    });

    await stage('does not let an own-save watcher echo abort newly started AI work', async () => {
      const generatedDirectory = path.join(project.rootPath, 'assets', 'generated');
      for (const generatedFile of fs.readdirSync(generatedDirectory).filter(name => name.endsWith('.png'))) {
        fs.unlinkSync(path.join(generatedDirectory, generatedFile));
      }
      // Let the deliberate external asset cleanup settle before isolating the
      // manuscript save echo that this stage is intended to exercise.
      await delay(1400);
      const result = await first.client.evaluate(`(async () => {
        const editor = document.getElementById('editor');
        editor.textContent = window.__editor.getContent() + '\\n\\nWatcher own-echo probe.';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Watcher own-echo probe.' }));
        const persisted = await window.__workspace.persistCurrent(true);
        if (!persisted) return { ok: false, error: 'E2E_SAVE_FAILED' };
        const operationId = window.WritCraftAiMetrics.createOperationId();
        const generated = await window.writCraft.project.generateImage(
          window.__workspace.state.project.instanceId,
          operationId,
          ${JSON.stringify(electronAiFixture.IMAGE_PROMPT)},
          '16:9'
        );
        if (!generated?.ok) return generated;
        const settled = await window.writCraft.project.settleImageReview(
          window.__workspace.state.project.instanceId,
          {
            token: generated.review.token,
            decision: 'deleted',
            qualityRating: 4,
          },
          null
        );
        return { ...generated, settled };
      })()`);
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(result.settled?.ok, true, JSON.stringify(result));
      assert.strictEqual(result.settled?.decision, 'deleted');
      assert(result.image?.previewDataUrl?.startsWith('data:image/png;base64,'));
      assert(result.image?.filePath?.startsWith('assets/generated/image-'));
      imageReviewEvidenceAfterDelete = fs.readFileSync(
        path.join(project.rootPath, '.writcraft', 'image-reviews.json'),
        'utf8'
      );
    });

    await stage('visibly restores image trash without changing manuscript or review evidence', async () => {
      const markdownBefore = snapshotMarkdownFiles(project.rootPath);
      const generatedDirectory = path.join(project.rootPath, 'assets', 'generated');
      const trashDirectory = path.join(project.rootPath, '.writcraft', 'image-trash');
      assert.deepStrictEqual(
        fs.readdirSync(generatedDirectory).filter(name => /\.(?:png|jpg)$/i.test(name)),
        []
      );
      assert.strictEqual(fs.readdirSync(trashDirectory).length, 1);

      await first.client.evaluate(`(() => {
        const panel = document.getElementById('image-trash-panel');
        if (panel.hidden) document.getElementById('image-trash-toggle').click();
      })()`);
      const listed = await waitForValue(first.client, `(() => {
        const panel = document.getElementById('image-trash-panel');
        const button = document.querySelector('#image-trash-list button');
        const status = document.getElementById('image-trash-status')?.textContent || '';
        return !panel.hidden && button?.textContent.includes('恢复到素材区') &&
          status.includes('长期保留') &&
          document.getElementById('image-trash-toggle').textContent.includes('· 1')
          ? { status, label: button.textContent }
          : null;
      })()`, 'the visible image trash entry');
      assert(listed.status.includes('不会自动删除'));

      await first.client.evaluate(`document.querySelector('#image-trash-list button').click()`);
      await waitForValue(first.client, `document.getElementById('image-trash-toggle').textContent.includes('· 0') &&
        document.getElementById('image-trash-status').textContent.includes('废纸篓为空')`,
      'the visible image trash restore');
      const restored = fs.readdirSync(generatedDirectory)
        .filter(name => /\.(?:png|jpg)$/i.test(name));
      assert.strictEqual(restored.length, 1);
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore);
      assert.strictEqual(
        fs.readFileSync(path.join(project.rootPath, '.writcraft', 'image-reviews.json'), 'utf8'),
        imageReviewEvidenceAfterDelete
      );

      // Seed the restart half of the same real-user journey without invoking
      // another product mutation. The strict filename matches review-owned
      // private trash entries, and the bytes remain the already verified PNG.
      const restartSeed = `${'e'.repeat(32)}-${'f'.repeat(24)}.asset`;
      fs.renameSync(
        path.join(generatedDirectory, restored[0]),
        path.join(trashDirectory, restartSeed)
      );
      await first.client.evaluate(`window.__imageGenerationView.refreshTrash()`);
      await waitForValue(first.client, `document.getElementById('image-trash-toggle').textContent.includes('· 1')`,
        'the restart trash seed to become visible');
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBefore);
    });

    await stage('keeps the instrumented renderer reload at zero HTTP(S) network requests', async () => {
      await delay(300);
      const runtime = await inspectRuntime(first);
      const observed = [...runtime.resourceUrls, ...runtime.loadedAssetUrls, ...first.networkRequests];
      const remote = observed.filter(url => /^https?:/i.test(url));
      assert.deepStrictEqual(remote, []);
      assert(runtime.loadedAssetUrls.length > 0);
      assert([...runtime.resourceUrls, ...runtime.loadedAssetUrls].every(url => /^(?:file|data):/i.test(url)));
    });

    await stage('exits, restarts and restores the active file, tabs and persisted manuscript bytes', async () => {
      const firstExit = await stopElectron(first);
      first = null;
      assert(firstExit && (firstExit.code === 0 || firstExit.signal === 'SIGTERM'));

      second = await launchElectron(scratch, project.rootPath);
      await waitForProject(second.client, 7);
      const restored = await second.client.evaluate(`(() => ({
        text: window.__editor.getContent(),
        currentPath: window.__workspace.state.currentPath,
        tabs: [...window.__workspace.state.tabs],
        chapterCount: document.querySelectorAll('.tree-file[data-path^="chapters/"]').length,
        href: location.href,
      }))()`);
      assert(restored.text.includes(marker));
      assert.strictEqual(restored.currentPath, createdPath);
      assert(restored.tabs.includes(createdPath));
      assert(restored.tabs.includes('chapters/01-arrival.md'));
      assert.strictEqual(restored.chapterCount, 7);
      assert(projectService.readFile(project.rootPath, createdPath).includes(marker));
      assert.strictEqual(decodeURIComponent(new URL(restored.href).pathname), ENTRY_PATH);

      const markdownBeforeTrashEmpty = snapshotMarkdownFiles(project.rootPath);
      const reviewEvidenceBeforeTrashEmpty = fs.readFileSync(
        path.join(project.rootPath, '.writcraft', 'image-reviews.json'),
        'utf8'
      );
      assert.strictEqual(reviewEvidenceBeforeTrashEmpty, imageReviewEvidenceAfterDelete);
      await second.client.evaluate(`(async () => {
        document.querySelector('[data-assistant-mode="chat"]').click();
        const panel = document.getElementById('image-trash-panel');
        if (panel.hidden) document.getElementById('image-trash-toggle').click();
        await window.__imageGenerationView.refreshTrash();
      })()`);
      await waitForValue(second.client, `document.getElementById('image-trash-toggle').textContent.includes('· 1') &&
        document.getElementById('image-trash-status').textContent.includes('长期保留')`,
      'the image trash after a real Electron restart');

      const trashDirectory = path.join(project.rootPath, '.writcraft', 'image-trash');
      const lateArrival = `${'a'.repeat(32)}-${'b'.repeat(24)}.asset`;
      fs.writeFileSync(
        path.join(trashDirectory, lateArrival),
        Buffer.from(electronAiFixture.PNG_BASE64, 'base64')
      );
      await second.client.evaluate(`(() => {
        window.__e2eTrashConfirmMessages = [];
        window.confirm = message => {
          window.__e2eTrashConfirmMessages.push(String(message));
          return true;
        };
        document.getElementById('image-trash-empty').click();
      })()`);
      await waitForValue(second.client, `document.getElementById('image-trash-toggle').textContent.includes('· 1') &&
        document.getElementById('image-trash-status').textContent.includes('长期保留')`,
      'the late trash arrival to survive snapshot emptying');
      assert.deepStrictEqual(fs.readdirSync(trashDirectory), [lateArrival]);

      await second.client.evaluate(`document.getElementById('image-trash-empty').click()`);
      const trashEmptyState = await waitForValue(second.client, `(() => {
        const messages = window.__e2eTrashConfirmMessages || [];
        return messages.length === 2 &&
          document.getElementById('image-trash-toggle').textContent.includes('· 0') &&
          document.getElementById('image-trash-status').textContent.includes('废纸篓为空')
          ? { messages }
          : null;
      })()`, 'the explicit permanent trash empty confirmation');
      assert(trashEmptyState.messages.every(message =>
        message.includes('永久清空') && message.includes('无法撤销')));
      assert.deepStrictEqual(fs.readdirSync(trashDirectory), []);
      assert.deepStrictEqual(snapshotMarkdownFiles(project.rootPath), markdownBeforeTrashEmpty);
      assert.strictEqual(
        fs.readFileSync(path.join(project.rootPath, '.writcraft', 'image-reviews.json'), 'utf8'),
        reviewEvidenceBeforeTrashEmpty
      );

      await second.client.evaluate(`(() => {
        const scope = document.getElementById('graph-scope');
        scope.value = 'project';
        scope.dispatchEvent(new Event('change', { bubbles: true }));
        window.__graphView.open();
      })()`);
      await waitForValue(second.client, `document.querySelectorAll('.graph-node').length >= 500 &&
        document.getElementById('graph-summary').textContent.includes('个节点')`, 'the large Graph after a real Electron restart');
      const persistedCorrectionLabels = JSON.parse(fs.readFileSync(
        path.join(project.rootPath, '.writcraft', 'graph-corrections.json'), 'utf8'
      )).corrections.map(item => {
        if (item.type === 'merge_alias') return `${item.source.label} → ${item.target.label}`;
        if (item.type === 'edit_attribute') return `${item.attribute}：${item.value === null ? '已删除' : item.value}`;
        if (item.type === 'decide_fact') return item.decision === 'confirmed' ? '事实已确认' : '事实已否定';
        throw new Error(`Unknown persisted Graph correction: ${item.type}`);
      });
      const restartCorrections = await second.client.evaluate(`(() => {
        const node = [...document.querySelectorAll('.graph-node[role="button"][aria-label]')]
          .find(item => item.getAttribute('aria-label').includes('person节点：周鹭'));
        if (!node) return null;
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return {
          detail: document.getElementById('graph-detail').textContent,
          correctionCount: document.querySelectorAll('#graph-detail .graph-correction-ledger .graph-correction-status-row').length,
          hasSourceAliasNode: [...document.querySelectorAll('.graph-node[aria-label]')]
            .some(item => item.getAttribute('aria-label').includes('person节点：沈砚')),
        };
      })()`);
      assert(restartCorrections);
      assert.strictEqual(restartCorrections.hasSourceAliasNode, false);
      assert(restartCorrections.correctionCount >= persistedCorrectionLabels.length);
      for (const label of persistedCorrectionLabels) {
        assert(restartCorrections.detail.includes(label), `restart Graph UI omitted persisted correction: ${label}`);
      }

      const alternate = projectService.createProjectAt(scratch, 'Graph B isolation');
      projectService.saveRecentProject(second.userData, alternate.rootPath);
      await second.client.command('Page.reload', { ignoreCache: true });
      await waitForRenderer(second.client);
      const alternateState = await waitForProject(second.client, 0);
      assert.strictEqual(alternateState.name, 'Graph B isolation');
      await second.client.evaluate(`window.__graphView.open()`);
      await waitForValue(second.client, `document.getElementById('graph-summary').textContent.includes('个节点')`, 'the isolated B-project Graph');
      const isolatedGraph = await second.client.evaluate(`(() => ({
        project: window.__workspace.state.project.name,
        summary: document.getElementById('graph-summary').textContent,
        detail: document.getElementById('graph-detail').textContent,
        nodes: [...document.querySelectorAll('.graph-node[aria-label]')].map(node => node.getAttribute('aria-label')),
        scope: document.getElementById('graph-scope').value,
        file: document.getElementById('graph-file-filter').value,
        search: document.getElementById('graph-search').value,
      }))()`);
      assert.strictEqual(isolatedGraph.project, 'Graph B isolation');
      assert.strictEqual(isolatedGraph.scope, 'current');
      assert.strictEqual(isolatedGraph.file, '');
      assert.strictEqual(isolatedGraph.search, '');
      assert(!isolatedGraph.detail.includes('年龄以项目卡为准'));
      assert(!isolatedGraph.detail.includes('沈砚'));
      assert(!isolatedGraph.nodes.some(label => label.includes('林舟') || label.includes('周鹭')));
      await delay(300);
      const secondRuntime = await inspectRuntime(second);
      const remote = [...secondRuntime.resourceUrls, ...secondRuntime.loadedAssetUrls, ...second.networkRequests]
        .filter(url => /^https?:/i.test(url));
      assert.deepStrictEqual(remote, []);
    });

    await stage('normal startup refuses to restore a temporary E2E recent project', async () => {
      await stopElectron(second);
      second = null;
      const isolatedProfile = path.join(scratch, 'production-profile');
      productionProfile = await launchElectron(isolatedProfile, project.rootPath, { aiFixture: false });
      const state = await productionProfile.client.evaluate(`(() => ({
        hasProject: Boolean(window.__workspace.state.project),
        welcomeVisible: !document.getElementById('welcome').hidden,
        title: document.getElementById('project-title').textContent,
      }))()`);
      assert.strictEqual(state.hasProject, false);
      assert.strictEqual(state.welcomeVisible, true);
    });

    console.log(`\n✅ Real Electron E2E ${passed}/${passed} stages passed; project-card recovery/confirmation, temporary-profile isolation, Research stale/rerun/confirmation, project metrics IPC, own-save watcher isolation, explicit image insertion, visible image-trash restore/restart/snapshot-empty, restart recovery, 0 observed renderer network.`);
  } finally {
    await stopElectron(first).catch(() => {});
    await stopElectron(second).catch(() => {});
    await stopElectron(productionProfile).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const lifecycleGuard = setInterval(() => {}, 1000);
  run()
    .catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    })
    .finally(() => clearInterval(lifecycleGuard));
}

module.exports = {
  APP_ROOT,
  skipReason,
  knownGuiFailure,
  boundedLog,
  launchElectron,
  stopElectron,
  waitForRenderer,
  waitForValue,
  seedRecentProject,
};
