'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { runWorkspaceInventory } = require('../src/main/workspace-inventory-runner');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-workspace-inventory-'));
  fs.writeFileSync(path.join(root, 'edit.md'), '# Prompt\n', 'utf8');
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# One\n正文\n', 'utf8');
  const authority = { projectInstanceId: `instance_${'a'.repeat(24)}`, projectMutationGeneration: 1 };
  try {
    const inventory = await runWorkspaceInventory({ rootPath: root, captureAuthority: () => authority });
    assert.strictEqual(inventory.markdownFileCount, 2);
    assert.strictEqual(inventory.authority.projectInstanceId, authority.projectInstanceId);

    class HangingWorker extends EventEmitter {
      removeAllListeners() { return super.removeAllListeners(); }
      terminate() { this.terminated = true; return Promise.resolve(0); }
    }
    const started = Date.now();
    await assert.rejects(runWorkspaceInventory({
      rootPath: root, captureAuthority: () => authority, deadlineMs: 20, WorkerClass: HangingWorker,
    }), error => error.code === 'HOME_SNAPSHOT_TIMEOUT');
    assert.ok(Date.now() - started < 500, 'timeout must terminate independently of worker progress');

    let generation = 1;
    class ResultWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => {
          generation = 2;
          this.emit('message', { ok: true, inventory });
        });
      }
      removeAllListeners() { return super.removeAllListeners(); }
      terminate() { return Promise.resolve(0); }
    }
    await assert.rejects(runWorkspaceInventory({
      rootPath: root,
      captureAuthority: () => ({ ...authority, projectMutationGeneration: generation }),
      WorkerClass: ResultWorker,
    }), error => error.code === 'PROJECT_CHANGED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('verify-v0-workspace-inventory-runner: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
