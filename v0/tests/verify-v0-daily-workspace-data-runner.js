'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { runDailyWorkspaceData } = require('../src/main/daily-workspace-data-runner');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-daily-data-'));
  fs.writeFileSync(path.join(root, 'edit.md'), '# 项目说明\n', 'utf8');
  fs.mkdirSync(path.join(root, 'chapters'));
  fs.writeFileSync(path.join(root, 'chapters', 'one.md'), '# 第一章\n林夏在北京。\n', 'utf8');
  const authority = { projectInstanceId: `instance_${'a'.repeat(24)}`, projectMutationGeneration: 1 };
  try {
    const result = await runDailyWorkspaceData({ rootPath: root, authority });
    assert.strictEqual(result.inventory.markdownFileCount, 2);
    assert.strictEqual(result.inventory.authority.projectInstanceId, authority.projectInstanceId);
    assert.strictEqual(typeof result.fileTimes['chapters/one.md'], 'number');
    assert(result.source && Array.isArray(result.source.reasonCodes));

    class HangingWorker extends EventEmitter {
      terminate() { this.terminated = true; return Promise.resolve(0); }
    }
    const started = Date.now();
    await assert.rejects(runDailyWorkspaceData({
      rootPath: root, authority, deadlineMs: 20, WorkerClass: HangingWorker,
    }), error => error.code === 'HOME_SNAPSHOT_TIMEOUT' && error.message === '项目统计暂不可用');
    assert(Date.now() - started < 500);

    class HostileMessageWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('message', {
          ok: false,
          error: { code: 'INTERNAL_IMPORT_FAILED', message: 'Cannot load /secret/root/private.js' },
        }));
      }
      terminate() { return Promise.resolve(0); }
    }
    await assert.rejects(runDailyWorkspaceData({
      rootPath: root, authority, WorkerClass: HostileMessageWorker,
    }), error => error.code === 'DAILY_WORKSPACE_FAILED' &&
      error.message === '工作区数据暂不可用，请稍后重试' &&
      !error.message.includes('/secret/root'));

    class HostileErrorWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => this.emit('error', new Error('worker crashed at /secret/root/private.js')));
      }
      terminate() { return Promise.resolve(0); }
    }
    await assert.rejects(runDailyWorkspaceData({
      rootPath: root, authority, WorkerClass: HostileErrorWorker,
    }), error => error.code === 'DAILY_WORKSPACE_FAILED' &&
      error.message === '工作区数据暂不可用，请稍后重试' &&
      !error.message.includes('/secret/root'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('verify-v0-daily-workspace-data-runner: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
