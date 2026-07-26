#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const {
  skipReason,
  knownGuiFailure,
  boundedLog,
  launchElectron,
  stopElectron,
  waitForValue,
} = require('./verify-v0-electron-e2e');

const FORCE = process.env.WRITCRAFT_E2E_FORCE === '1' || process.env.CI === 'true';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function snapshotProject(rootPath) {
  const snapshot = new Map();
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) snapshot.set(relative, `symlink:${fs.readlinkSync(absolute)}`);
      else if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) snapshot.set(relative, `file:${stat.mode & 0o777}:${sha256(fs.readFileSync(absolute))}`);
      else snapshot.set(relative, `other:${stat.mode}`);
    }
  }
  visit(rootPath);
  return [...snapshot];
}

function errorCode(result) {
  return typeof result?.error === 'string' ? result.error : result?.error?.code;
}

async function invoke(client, expression) {
  return client.evaluate(`(async () => ${expression})()`);
}

async function main() {
  console.log('\nWritCraft persistent watcher real Main/IPC verification');
  const unavailable = skipReason();
  if (unavailable && !FORCE) {
    console.log(`\n⏭ SKIP: ${unavailable}. Set WRITCRAFT_E2E_FORCE=1 to require launch.`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-watcher-main-ipc-'));
  const normalParent = path.join(scratch, 'normal-parent');
  const legacyRoot = path.join(scratch, 'legacy-project');
  fs.mkdirSync(normalParent);
  fs.mkdirSync(legacyRoot);
  const normal = projectService.createProjectAt(normalParent, 'persistent-watcher');
  projectService.createMarkdownFile(normal.rootPath, 'chapter.md', '# Chapter\n\n正文保持不变。\n');
  fs.writeFileSync(path.join(legacyRoot, 'editor.md'), '# Legacy project\n\n首次迁移必须保留。\n', 'utf8');

  let degraded = null;
  let firstMigration = null;
  try {
    try {
      degraded = await launchElectron(
        path.join(scratch, 'degraded-profile'),
        normal.rootPath,
        { watcherFailure: true }
      );
    } catch (error) {
      if (knownGuiFailure(error.processLog || '') && !FORCE) {
        console.log(`\n⏭ SKIP: Electron GUI is unavailable. ${boundedLog(error.processLog)}`);
        return;
      }
      throw error;
    }

    const project = await waitForValue(degraded.client, `(() => {
      const project = window.__workspace?.state?.project;
      return project?.instanceId ? project : null;
    })()`, 'degraded recent project');

    const reopen = await invoke(degraded.client, 'window.writCraft.project.openRecent()');
    assert.strictEqual(reopen.ok, true, JSON.stringify(reopen));
    assert.strictEqual(reopen.project.instanceId, project.instanceId);

    const beforeRoutes = snapshotProject(normal.rootPath);
    const results = await degraded.client.evaluate(`(async () => {
      const project = window.__workspace.state.project;
      const operationId = 'chr_' + 'a'.repeat(48);
      return {
        rewrite: await window.writCraft.applyRewrite(project.instanceId, {}),
        graph: await window.writCraft.project.handoffGraphIssue(project.instanceId, {}),
        query: await window.writCraft.project.queryChangesHistoryRecovery(project.instanceId),
        clear: await window.writCraft.project.clearChangesHistoryRecovery(project.instanceId, operationId),
      };
    })()`);
    for (const [route, result] of Object.entries(results)) {
      assert.strictEqual(errorCode(result), 'PROJECT_WATCHER_UNAVAILABLE',
        `${route} did not fail at watcher admission: ${JSON.stringify(result)}`);
    }
    assert.deepStrictEqual(snapshotProject(normal.rootPath), beforeRoutes,
      'degraded rewrite/Graph/reconciliation IPC must leave every public/private project byte unchanged');
    console.log('  ✓ persistent restart failure blocks rewrite, Graph and Changes recovery before project writes');

    const editPath = path.join(normal.rootPath, 'edit.md');
    const editorPath = path.join(normal.rootPath, 'editor.md');
    fs.renameSync(editPath, editorPath);
    const preview = await invoke(degraded.client, 'window.writCraft.project.openRecent()');
    assert.strictEqual(preview.ok, false, JSON.stringify(preview));
    assert.strictEqual(preview.migration?.kind, 'legacy-edit');
    const beforeLegacyConfirm = snapshotProject(normal.rootPath);
    const blockedConfirm = await degraded.client.evaluate(
      `window.writCraft.project.confirmLegacyEdit(${JSON.stringify(preview.migration.token)})`
    );
    assert.strictEqual(errorCode(blockedConfirm), 'PROJECT_WATCHER_UNAVAILABLE', JSON.stringify(blockedConfirm));
    assert.deepStrictEqual(snapshotProject(normal.rootPath), beforeLegacyConfirm,
      'same-root legacy confirmation must not rename or mutate metadata while watcher is degraded');
    assert.strictEqual(fs.existsSync(editorPath), true);
    assert.strictEqual(fs.existsSync(editPath), false);
    console.log('  ✓ existing same-root legacy confirmation is blocked before its first rename');

    await stopElectron(degraded);
    degraded = null;

    firstMigration = await launchElectron(
      path.join(scratch, 'first-migration-profile'),
      legacyRoot,
      { watcherFailure: true }
    );
    const migration = await invoke(firstMigration.client, 'window.writCraft.project.openRecent()');
    assert.strictEqual(migration.ok, false, JSON.stringify(migration));
    assert.strictEqual(migration.migration?.kind, 'legacy-edit');
    const migrated = await firstMigration.client.evaluate(
      `window.writCraft.project.confirmLegacyEdit(${JSON.stringify(migration.migration.token)})`
    );
    assert.strictEqual(migrated.ok, true, JSON.stringify(migrated));
    assert.strictEqual(fs.existsSync(path.join(legacyRoot, 'editor.md')), false);
    assert.strictEqual(
      fs.readFileSync(path.join(legacyRoot, 'edit.md'), 'utf8'),
      '# Legacy project\n\n首次迁移必须保留。\n'
    );
    console.log('  ✓ first legacy migration without current-project authority remains atomic and permitted');

    console.log('\n✅ Persistent watcher real Main/IPC 3/3 passed.');
  } finally {
    await stopElectron(degraded).catch(() => {});
    await stopElectron(firstMigration).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
