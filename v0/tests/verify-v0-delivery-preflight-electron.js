'use strict';

// Stage B App boundary: seed one committed immutable snapshot, then exercise
// the real Electron/Renderer delivery-preflight journey.  The project is an
// isolated author-selected copy; private .writcraft workspace changes are
// allowed, while every Markdown byte must remain identical.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const snapshotWorker = require('../src/main/snapshot-storage-worker');
const {
  launchElectron,
  stopElectron,
  waitForRenderer,
  waitForValue,
  seedRecentProject,
  skipReason,
} = require('./verify-v0-electron-e2e');

const APP_ROOT = path.resolve(__dirname, '..');
const FORCE = process.env.WRITCRAFT_E2E_FORCE === '1' || process.env.CI === 'true';

function stableRequest(projectInstanceId) {
  const transactionId = `stx_${'7'.repeat(32)}`;
  const snapshotId = `snap_${'8'.repeat(32)}`;
  return {
    transactionId,
    projectInstanceId,
    snapshotId,
    ownerGeneration: 1,
    creationMutationGeneration: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    stageBasename: `stage-${crypto.createHash('sha256').update(transactionId).digest('hex')}.wcsb`,
    finalBasename: `bundle-${crypto.createHash('sha256').update(snapshotId).digest('hex')}.wcsb`,
    signal: null,
  };
}

function ensureSnapshotDirectories(rootPath) {
  const relative = [
    '.writcraft/snapshots/v1',
    '.writcraft/snapshots/v1/bundles',
    '.writcraft/snapshots/v1/control',
    '.writcraft/snapshots/v1/quarantine',
  ];
  for (const value of relative) fs.mkdirSync(path.join(rootPath, value), { recursive: true, mode: 0o700 });
  for (const value of ['.writcraft', '.writcraft/snapshots', ...relative]) {
    fs.chmodSync(path.join(rootPath, value), 0o700);
  }
}

function markdownBytes(rootPath) {
  return new Map(projectService.listTree(rootPath).flatMap(node => {
    const walk = current => current.type === 'directory'
      ? current.children.flatMap(walk)
      : /\.(?:md|markdown)$/iu.test(current.path)
        ? [[current.path, projectService.readFile(rootPath, current.path)]]
        : [];
    return walk(node);
  }));
}

async function run() {
  const unavailable = skipReason();
  if (unavailable && !FORCE) {
    console.log(`⏭ SKIP: ${unavailable}. Set WRITCRAFT_E2E_FORCE=1 to require launch.`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-delivery-electron-'));
  let instance = null;
  try {
    const project = projectService.createProjectAt(scratch, 'Stage B Delivery App');
    ensureSnapshotDirectories(project.rootPath);
    projectService.createMarkdownFile(project.rootPath, 'README.md', [
      '# Stage B Delivery',
      '',
      'This immutable snapshot is selected by the author for offline delivery preflight.',
      '',
    ].join('\n'));
    projectService.createMarkdownFile(project.rootPath, 'references.md', [
      '# Reference',
      '',
      '- https://example.com/reference',
      '',
    ].join('\n'));

    const request = stableRequest(project.instanceId);
    const creator = snapshotWorker.createSnapshotStorageWorkerForRoot(project.rootPath);
    try {
      const committed = await creator.createProductionSnapshot(request);
      assert.strictEqual(committed.state, 'COMMITTED');
    } finally {
      await creator.close();
    }
    seedRecentProject(scratch, project.rootPath);
    const beforeMarkdown = markdownBytes(project.rootPath);

    // The fixture flag only permits this disposable /tmp recent-project path
    // during development E2E; the journey itself never calls the AI provider.
    instance = await launchElectron(scratch, project.rootPath, { aiFixture: true });
    const loadedProject = await waitForValue(instance.client, `(() => {
      const state = window.__workspace?.state;
      return state?.project && state.projectReady === true
        ? { instanceId: state.project.instanceId, projectName: state.project.name }
        : null;
    })()`, 'the seeded delivery project');
    assert.deepStrictEqual(loadedProject, {
      instanceId: project.instanceId,
      projectName: 'Stage B Delivery App',
    });

    await instance.client.evaluate(`document.querySelector('[data-workspace-view="sources"]').click()`);
    const snapshotDebug = await waitForValue(instance.client, `(() => {
      const select = document.getElementById('delivery-snapshot-select');
      const status = document.getElementById('delivery-preflight-status');
      const result = document.getElementById('delivery-preflight-result');
      return select && status && status.textContent !== '正在读取已提交 snapshot…'
        ? {
          status: status.textContent,
          result: result?.textContent || '',
          options: [...select.options].map(option => option.value),
          project: window.__workspace?.state?.project?.instanceId || null,
        }
        : null;
    })()`, 'the delivery snapshot list to settle');
    assert(snapshotDebug.options.includes(request.snapshotId),
      `committed snapshot missing from Renderer: ${JSON.stringify(snapshotDebug)}`);
    await instance.client.evaluate(`(() => {
      const select = document.getElementById('delivery-snapshot-select');
      select.value = ${JSON.stringify(request.snapshotId)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    })()`);
    try {
      await waitForValue(instance.client, `document.querySelectorAll('#delivery-snapshot-files input[data-delivery-file-id]').length >= 1`, 'the committed Markdown file choices');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        status: document.getElementById('delivery-preflight-status')?.textContent || '',
        result: document.getElementById('delivery-preflight-result')?.textContent || '',
        files: document.getElementById('delivery-snapshot-files')?.textContent || '',
        inputs: document.querySelectorAll('#delivery-snapshot-files input[data-delivery-file-id]').length,
      }))()`).catch(() => null);
      error.message += `; delivery files diagnostics=${JSON.stringify(diagnostics)}; electronLog=${JSON.stringify(instance.logRef?.value || '')}`;
      throw error;
    }
    const selected = await instance.client.evaluate(`(() => {
      const input = document.querySelector('#delivery-snapshot-files input[data-delivery-file-id]');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.dataset.deliveryFileId;
    })()`);
    assert.strictEqual(typeof selected, 'string');
    await instance.client.evaluate(`document.getElementById('delivery-preflight-run').click()`);
    const result = await waitForValue(instance.client, `(() => {
      const text = document.getElementById('delivery-preflight-result').textContent;
      return text.includes('预检通过') ? text : null;
    })()`, 'the completed delivery preflight');
    assert(result.includes('当前 snapshot 与所选文件可用于离线导出'));

    const runtime = await instance.client.evaluate(`(() => ({
      projectInstanceId: window.__workspace.state.project.instanceId,
      snapshotId: document.getElementById('delivery-snapshot-select').value,
      status: document.getElementById('delivery-preflight-status').textContent,
      result: document.getElementById('delivery-preflight-result').textContent,
      privateRoot: window.__workspace.state.project.rootPath || null,
    }))()`);
    assert.strictEqual(runtime.projectInstanceId, project.instanceId);
    assert.strictEqual(runtime.snapshotId, request.snapshotId);
    assert.strictEqual(runtime.status, '交付预检通过');
    assert(!runtime.privateRoot, 'Renderer must not expose the private project root');
    const remoteRequests = instance.networkRequests.filter(url => /^https?:/iu.test(url));
    assert.deepStrictEqual(remoteRequests, []);
    assert.deepStrictEqual([...markdownBytes(project.rootPath)], [...beforeMarkdown]);
    console.log('  ✓ real Electron committed-snapshot preflight passes with Markdown zero-write and no HTTP(S) requests');
  } finally {
    await stopElectron(instance).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    if (error?.processLog) console.error(error.processLog);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ run });
