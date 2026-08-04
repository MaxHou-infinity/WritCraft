#!/usr/bin/env node
'use strict';

// Focused real-Electron proof that a non-Navigation AI entry reaches the
// shared Main-owned task progress view. The provider is the double-gated,
// deterministic E2E fixture; no manuscript or credential leaves this process.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const longformFixture = require('./fixtures/writcraft-longform-project');
const fixture = require('./fixtures/electron-ai-provider');
const {
  launchElectron,
  stopElectron,
  skipReason,
  waitForRenderer,
  waitForValue,
} = require('./verify-v0-electron-e2e');

async function run() {
  const unavailable = skipReason();
  if (unavailable) {
    console.log(`SKIP: ${unavailable}`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-ai-progress-e2e-'));
  const project = longformFixture.buildLongformProject({ parentPath: scratch, projectService });
  const targetPath = fixture.CHAT_CURRENT_PATH;
  const targetFile = path.join(project.rootPath, ...targetPath.split('/'));
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, [
    '# Chat 任务进度夹具',
    'Electron project lifecycle focused progress fixture',
    fixture.REWRITE_BEFORE,
    fixture.UNIFIED_BEFORE,
  ].join('\n\n') + '\n', 'utf8');

  const edit = projectService.readFile(project.rootPath, 'edit.md');
  projectService.atomicWriteFile(project.rootPath, 'edit.md', [
    edit,
    fixture.ONBOARDING_MARKER,
    fixture.ONBOARDING_RERUN_MARKER,
  ].join('\n\n') + '\n');

  let instance = null;
  try {
    instance = await launchElectron(scratch, project.rootPath);
    await waitForRenderer(instance.client);
    await waitForValue(instance.client, `(() => window.__workspace?.state?.projectReady === true ? true : null)()`,
      'focused progress project');
    await instance.client.evaluate(`window.__workspace.openFile(${JSON.stringify(targetPath)})`);
    await waitForValue(instance.client, `(() => {
      const state = window.__workspace?.state;
      return state?.currentPath === ${JSON.stringify(targetPath)} ? true : null;
    })()`, 'focused progress target file');

    await instance.client.evaluate(`(() => {
      window.__focusedTaskProgress = [];
      window.__focusedTaskProgressStop = window.writCraft.project.onWritingTaskProgress(payload => {
        window.__focusedTaskProgress.push({
          schema: payload?.schema,
          kind: payload?.kind,
          phase: payload?.phase,
          status: payload?.status,
          projectInstanceId: payload?.projectInstanceId,
        });
      });
      document.querySelector('[data-assistant-mode="chat"]').click();
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(fixture.CHAT_QUESTION)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit').click();
    })()`);

    await waitForValue(instance.client, `(() => {
      const messages = document.getElementById('chat-messages')?.textContent || '';
      return messages.includes(${JSON.stringify(fixture.CHAT_RESPONSE)}) ? true : null;
    })()`, 'focused Chat response');

    const proof = await instance.client.evaluate(`(() => ({
      events: window.__focusedTaskProgress || [],
      host: {
        hidden: document.getElementById('ai-task-progress')?.hidden ?? true,
        status: document.getElementById('ai-task-progress')?.dataset.status || '',
        text: document.getElementById('ai-task-progress')?.textContent || '',
      },
    }))()`);
    assert(proof.events.length >= 3, 'Chat must publish at least start, phase and terminal progress');
    assert(proof.events.every(event => event.schema === 'writcraft.ai-task-progress/v1'));
    assert(proof.events.every(event => event.kind === 'chat'));
    assert(proof.events.some(event => event.phase === 'preparing_context'));
    assert(proof.events.some(event => event.phase === 'completed' && event.status === 'completed'));
    assert.strictEqual(proof.host.hidden, false);
    assert.strictEqual(proof.host.status, 'completed');
    assert(proof.host.text.includes('已完成'));

    await instance.client.evaluate('window.__focusedTaskProgressStop?.(); window.__focusedTaskProgressStop = null;');
    console.log('✅ Real Electron Chat task progress 1/1 passed; Main phases reached Renderer terminal state');
  } finally {
    await stopElectron(instance).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
