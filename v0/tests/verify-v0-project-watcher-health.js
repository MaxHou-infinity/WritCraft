#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../src/main/project-watcher-health');
const projectService = require('../src/main/project-service');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

const health = service.createProjectWatcherHealth();
const projectA = { instanceId: 'instance_a', rootPath: '/project/a' };
const projectB = { instanceId: 'instance_b', rootPath: '/project/b' };

console.log('════════ WritCraft V0 · Project watcher degraded gate verify ════════');

health.markDegraded(projectA);
assert.equal(health.isDegraded(projectA), true);
assert.equal(health.isDegraded(projectB), false);
for (const pathName of ['runAiRequest', 'requireMutableProject']) {
  assert.throws(
    () => health.assertAvailable(projectA, () => Object.assign(new Error(pathName), { code: 'PROJECT_WATCHER_UNAVAILABLE' })),
    error => error.code === 'PROJECT_WATCHER_UNAVAILABLE',
  );
}
console.log('  ✓ persistent restart failure degrades only the exact project instance');

health.clear(projectB);
assert.equal(health.isDegraded(projectA), true, 'foreign watcher success cannot clear A');
health.clear(projectA);
assert.equal(health.isDegraded(projectA), false);
assert.strictEqual(health.assertAvailable(projectA), projectA);
console.log('  ✓ only exact watcher success clears the degraded gate');

health.markDegraded(projectA);
health.reset();
assert.equal(health.isDegraded(projectA), false);
console.log('  ✓ switching project authority may reset the old degraded binding');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-watcher-reopen-'));
try {
  fs.writeFileSync(path.join(scratch, 'edit.md'), '# project\n');
  const firstOpen = projectService.openProject(scratch);
  const sameRootReopen = projectService.openProject(scratch);
  assert.equal(firstOpen.instanceId, sameRootReopen.instanceId, 'same canonical root has stable instanceId');
  health.markDegraded(firstOpen);
  assert.equal(health.needsRecovery(sameRootReopen, false), true);
  assert.equal(health.isDegraded(sameRootReopen), true, 'reopen does not bypass degraded state before restart');
  health.clear(sameRootReopen);
  assert.equal(health.needsRecovery(sameRootReopen, true), false);
  assert.strictEqual(health.assertAvailable(sameRootReopen), sameRootReopen);
  assert(main.includes('projectWatcherHealth.needsRecovery(project, Boolean(currentProjectWatcher))'));
  assert(main.indexOf('} else if (recoverSameProjectWatcher) {') < main.indexOf('restartProjectWatcher(project);', main.indexOf('} else if (recoverSameProjectWatcher) {')));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log('  ✓ real same-root reopen retries watcher and clears health only after success');

console.log('\n✅ Project watcher degraded gate 4/4 全过');
