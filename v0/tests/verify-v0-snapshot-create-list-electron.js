'use strict';

// A2a App boundary: create one committed local recovery point through the
// production Renderer -> preload -> Main -> native storage route, then prove
// the same App lists it before and after restart. Public Markdown must remain
// byte-identical and Renderer receives no private path or manuscript content.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const snapshotWorker = require('../src/main/snapshot-storage-worker');
const {
  launchElectron,
  stopElectron,
  waitForValue,
  seedRecentProject,
  skipReason,
} = require('./verify-v0-electron-e2e');

const FORCE = process.env.WRITCRAFT_E2E_FORCE === '1' || process.env.CI === 'true';

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

async function listedSnapshot(rootPath) {
  const worker = snapshotWorker.createSnapshotStorageWorkerForRoot(rootPath);
  try {
    await worker.ready();
    const listed = await worker.listCommitted();
    assert.strictEqual(listed.unavailableCount, 0);
    assert.strictEqual(listed.items.length, 1);
    const item = listed.items[0];
    const loaded = await worker.readCommittedSnapshot({ snapshotId: item.snapshotId });
    assert.strictEqual(loaded.manifest.snapshotId, item.snapshotId);
    assert(loaded.manifest.files.some(file => file.path === 'chapters/one.md'));
    return item.snapshotId;
  } finally {
    await worker.close();
  }
}

async function openHome(instance, projectInstanceId) {
  await instance.client.evaluate(`document.querySelector('[data-workspace-view="home"]').click()`);
  return waitForValue(instance.client, `(() => {
    const state = window.__workspace?.state;
    const create = document.getElementById('project-home-snapshot-create');
    const list = document.getElementById('project-home-snapshot-list');
    return state?.project?.instanceId === ${JSON.stringify(projectInstanceId)} && create && list
      ? { createLabel: create.textContent, listText: list.textContent }
      : null;
  })()`, 'the A2a snapshot controls');
}

async function run() {
  const unavailable = skipReason();
  if (unavailable && !FORCE) {
    console.log(`⏭ SKIP: ${unavailable}. Set WRITCRAFT_E2E_FORCE=1 to require launch.`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-snapshot-create-list-'));
  let instance = null;
  try {
    const project = projectService.createProjectAt(scratch, 'A2a Snapshot App');
    projectService.createMarkdownFile(project.rootPath, 'chapters/one.md', [
      '# 第一章',
      '',
      '这是由作者明确保存到本地恢复点的正文。',
      '',
    ].join('\n'));
    projectService.createMarkdownFile(project.rootPath, 'notes.md', '# Notes\n\nKeep writing.\n');
    fs.chmodSync(path.join(project.rootPath, '.writcraft'), 0o700);
    seedRecentProject(scratch, project.rootPath);
    const beforeMarkdown = markdownBytes(project.rootPath);

    instance = await launchElectron(scratch, project.rootPath, { aiFixture: true });
    try {
      await waitForValue(instance.client, `window.__workspace?.state?.projectReady === true`, 'the A2a project');
    } catch (error) {
      const diagnostic = await instance.client.evaluate(`(() => ({
        state: window.__workspace?.state || null,
        body: document.body?.innerText?.slice(0, 2000) || '',
      }))()`).catch(() => null);
      error.message += `; diagnostic=${JSON.stringify(diagnostic)}; electronLog=${JSON.stringify(instance.logRef?.value || '')}`;
      throw error;
    }
    const controls = await openHome(instance, project.instanceId);
    assert.strictEqual(controls.createLabel, '创建本地快照');
    await instance.client.evaluate(`document.getElementById('project-home-snapshot-create').click()`);
    let created;
    try {
      created = await waitForValue(instance.client, `(() => {
        const status = document.getElementById('project-home-snapshot-status');
        const rows = [...document.querySelectorAll('[data-snapshot-id]')];
        return status?.textContent === '本地快照已创建。' && rows.length === 1
          ? { status: status.textContent, snapshotId: rows[0].dataset.snapshotId,
            listText: document.getElementById('project-home-snapshot-list')?.textContent || '',
            rendererRoot: window.__workspace?.state?.project?.rootPath || null }
          : null;
      })()`, 'the App-created committed snapshot');
    } catch (error) {
      const diagnostic = await instance.client.evaluate(`(() => ({
        status: document.getElementById('project-home-snapshot-status')?.textContent || '',
        list: document.getElementById('project-home-snapshot-list')?.textContent || '',
        button: document.getElementById('project-home-snapshot-create')?.textContent || '',
        disabled: document.getElementById('project-home-snapshot-create')?.disabled || false,
      }))()`).catch(() => null);
      error.message += `; diagnostic=${JSON.stringify(diagnostic)}; electronLog=${JSON.stringify(instance.logRef?.value || '')}`;
      throw error;
    }
    assert.match(created.snapshotId, /^snap_[a-f0-9]{32}$/u);
    assert(created.listText.includes('1 个本地快照'));
    assert.strictEqual(created.rendererRoot, null);
    assert.deepStrictEqual(instance.networkRequests.filter(url => /^https?:/iu.test(url)), []);
    assert.deepStrictEqual([...markdownBytes(project.rootPath)], [...beforeMarkdown]);

    // renderer/project-home-view.js:440 starts a non-quiet refresh() for this
    // Home activation, so its loadSnapshots (:156) can still be in flight right
    // here. If that read lands after the chmod below makes the private snapshot
    // root unsafe, its failure branch (:172-173) rewrites the create status this
    // probe asserts, while the probe's own quiet refresh preserves it by design
    // (:172 guard). Wait until the view is idle and one quiet refresh has taken
    // over both request sequences; then any earlier non-quiet read is either
    // finished or superseded and can no longer write the status.
    await waitForValue(instance.client, `(async () => {
      const view = document.getElementById('project-home-view');
      if (view?.getAttribute('aria-busy') !== 'false') return null;
      await window.__projectHomeView.refresh({ quietSnapshots: true });
      const status = document.getElementById('project-home-status')?.textContent || '';
      return status === '已根据当前项目事实更新。' ||
        status === '部分本地索引暂不可用；已验证的入口仍可使用。';
    })()`, 'the Home snapshot read to settle before the private-permission probe');

    const snapshotPrivateRoot = path.join(project.rootPath, '.writcraft', 'snapshots');
    fs.chmodSync(snapshotPrivateRoot, 0o755);
    try {
      const quietFailure = await instance.client.evaluate(`(async () => {
        await window.__projectHomeView.refresh({ quietSnapshots: true });
        return {
          status: document.getElementById('project-home-snapshot-status')?.textContent || '',
          error: document.getElementById('project-home-snapshot-status')?.classList.contains('is-error'),
        };
      })()`);
      assert.deepStrictEqual(quietFailure, { status: '本地快照已创建。', error: false });
    } finally {
      fs.chmodSync(snapshotPrivateRoot, 0o700);
    }

    await stopElectron(instance);
    instance = null;
    assert.strictEqual(await listedSnapshot(project.rootPath), created.snapshotId);

    instance = await launchElectron(scratch, project.rootPath, { aiFixture: true });
    await waitForValue(instance.client, `window.__workspace?.state?.projectReady === true`, 'the restarted A2a project');
    await openHome(instance, project.instanceId);
    const restarted = await waitForValue(instance.client, `(() => {
      const row = document.querySelector('[data-snapshot-id]');
      return row ? { snapshotId: row.dataset.snapshotId, text: row.textContent } : null;
    })()`, 'the committed snapshot after restart');
    assert.strictEqual(restarted.snapshotId, created.snapshotId);
    assert(!restarted.text.includes('第一章'), 'Renderer list must not expose manuscript content');
    assert.deepStrictEqual(instance.networkRequests.filter(url => /^https?:/iu.test(url)), []);
    assert.deepStrictEqual([...markdownBytes(project.rootPath)], [...beforeMarkdown]);
    console.log('  ✓ real Electron creates and relists one committed snapshot with Markdown zero-write');
  } finally {
    await stopElectron(instance).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error?.stack || error);
    if (error?.processLog) console.error(error.processLog);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ run });
