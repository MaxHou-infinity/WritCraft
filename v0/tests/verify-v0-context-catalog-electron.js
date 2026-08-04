'use strict';

// Stage-B real Electron proof.  The unit and real-tree checks prove candidate
// shape; this journey proves that the public catalog is actually Main-owned:
// a valid request-bound token reaches the shared project-context compiler,
// while a revision change or a project switch makes the same token unusable.
// The provider is the local deterministic fixture, so no manuscript or key
// leaves the disposable Electron profile.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectService = require('../src/main/project-service');
const fixture = require('./fixtures/electron-ai-provider');
const longformFixture = require('./fixtures/writcraft-longform-project');
const {
  launchElectron,
  stopElectron,
  skipReason,
  waitForRenderer,
  waitForValue,
} = require('./verify-v0-electron-e2e');

function buildProject(parentPath, name) {
  const project = longformFixture.buildLongformProject({ parentPath, projectService, name });
  projectService.createMarkdownFile(project.rootPath, fixture.CHAT_CURRENT_PATH, [
    '# Electron Context Catalog',
    '',
    'Electron project lifecycle',
    '人物：周鹭、沈砚',
    '',
  ].join('\n'));
  return project;
}

async function run() {
  const unavailable = skipReason();
  if (unavailable) {
    console.log(`SKIP: ${unavailable}`);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-context-catalog-electron-'));
  const first = buildProject(scratch, '上下文目录首项目');
  let instance = null;

  try {
    // The fixture-only short TTL makes the real renderer expiry message
    // deterministic. Production builds retain the ten-minute contract TTL.
    instance = await launchElectron(scratch, first.rootPath, { contextCatalogTtlMs: 1000 });
    await waitForRenderer(instance.client);
    await waitForValue(instance.client, `window.__workspace?.state?.projectReady === true &&
      Boolean(window.__workspace?.state?.project?.instanceId)`, 'context catalog project readiness');

    const catalog = await instance.client.evaluate(`(async () => {
      const projectId = window.__workspace.state.project.instanceId;
      const requests = {
        file: { query: '03-archive-room', currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)} },
        section: { query: '第三章', currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)} },
        source: { query: 'source', currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)} },
        entity: { query: 'entity 周鹭', currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)} },
      };
      const responses = {};
      for (const [key, request] of Object.entries(requests)) {
        responses[key] = await window.writCraft.project.listContextCandidates(projectId, request);
      }
      const pick = (response, kind, predicate = () => true) =>
        response?.candidates?.find(candidate => candidate.kind === kind && predicate(candidate)) || null;
      return {
        projectId,
        file: pick(responses.file, 'file', candidate => candidate.label === 'chapters/03-archive-room.md'),
        section: pick(responses.section, 'section', candidate => candidate.label.includes('第三章')),
        source: pick(responses.source, 'source', candidate => candidate.label === '海岬城旧港公开听证纪要'),
        entity: pick(responses.entity, 'entity', candidate => candidate.label === '周鹭'),
        serialized: JSON.stringify(responses),
      };
    })()`);

    for (const key of ['file', 'section', 'source', 'entity']) {
      assert(catalog[key], `Main catalog should return ${key} candidate`);
      assert.match(catalog[key].referenceToken, /^@ref:ctxcat_[A-Za-z0-9_-]+:ctxcand_[A-Za-z0-9_-]+$/);
    }
    assert(!catalog.serialized.includes(first.rootPath), 'catalog must not disclose project root');
    assert(!catalog.serialized.includes('Electron project lifecycle'), 'catalog must not disclose manuscript content');

    const tokenMessage = [
      catalog.file.referenceToken,
      catalog.section.referenceToken,
      catalog.entity.referenceToken,
      catalog.source.referenceToken,
      '季度复核为什么重要？',
    ].join(' ');
    const valid = await instance.client.evaluate(`(async () => {
      const projectId = window.__workspace.state.project.instanceId;
      const message = ${JSON.stringify(tokenMessage)};
      return window.writCraft.chat(projectId, message, '', {
        schema: 'writcraft.chat-context/v1',
        scope: 'project',
        message,
        currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)},
        selection: null,
        contextPolicy: { excludedChipIds: [] },
      });
    })()`);
    assert.strictEqual(valid.ok, true, JSON.stringify(valid));
    assert.strictEqual(valid.text, fixture.PROJECT_CHAT_RESPONSE);
    assert(!JSON.stringify(valid.contextManifest || {}).includes(catalog.file.referenceToken),
      'model manifest must contain canonical context, not opaque request tokens');

    const edit = await instance.client.evaluate(`window.writCraft.project.readFile('edit.md')`);
    assert.strictEqual(edit.ok, true);
    const changed = await instance.client.evaluate(`window.writCraft.project.writeFile(
      'edit.md',
      ${JSON.stringify(longformFixture.EDIT_CONTENT + '\n\n## 版本校准\n\n本次测试触发 revision 漂移。\n')},
      ${JSON.stringify(edit.revision)}
    )`);
    assert.strictEqual(changed.ok, true, JSON.stringify(changed));
    const stale = await instance.client.evaluate(`(async () => {
      const projectId = window.__workspace.state.project.instanceId;
      const message = ${JSON.stringify(tokenMessage)};
      return window.writCraft.chat(projectId, message, '', {
        schema: 'writcraft.chat-context/v1',
        scope: 'project',
        message,
        currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)},
        selection: null,
        contextPolicy: { excludedChipIds: [] },
      });
    })()`);
    assert.strictEqual(stale.ok, false, JSON.stringify(stale));
    assert(['CONTEXT_CANDIDATE_STALE', 'CONTEXT_CANDIDATE_EXPIRED'].includes(stale.error),
      `revision drift must invalidate the catalog token, got ${stale.error}`);

    // A foreign project instance is the same Main-side boundary used when a
    // real project switch invalidates in-flight Renderer work.  Passing that
    // identity with the old token must fail before any provider call.
    const switched = await instance.client.evaluate(`(async () => {
      const projectId = 'project_foreign_0123456789abcdef01234567';
      const message = ${JSON.stringify(tokenMessage)};
      return window.writCraft.chat(projectId, message, '', {
        schema: 'writcraft.chat-context/v1',
        scope: 'project',
        message,
        currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)},
        selection: null,
        contextPolicy: { excludedChipIds: [] },
      });
    })()`);
    assert.strictEqual(switched.ok, false, JSON.stringify(switched));
    assert(['CONTEXT_CANDIDATE_STALE', 'CONTEXT_CANDIDATE_EXPIRED', 'PROJECT_CHANGED'].includes(switched.error),
      `project switch must invalidate the catalog token, got ${switched.error}`);

    // Mint a fresh token after the revision-drift checks, let the fixture TTL
    // expire, and exercise the actual Chat UI. The renderer must disclose the
    // Main-owned expiry reason and stop before any provider call or write.
    const fresh = await instance.client.evaluate(`(async () => {
      const projectId = window.__workspace.state.project.instanceId;
      const response = await window.writCraft.project.listContextCandidates(projectId, {
        query: '03-archive-room',
        currentFilePath: ${JSON.stringify(fixture.CHAT_CURRENT_PATH)},
      });
      return response?.candidates?.find(candidate => candidate.kind === 'file') || null;
    })()`);
    assert(fresh?.referenceToken, 'fresh catalog token should be available before expiry');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await instance.client.evaluate(`(() => {
      document.querySelector('[data-assistant-mode="chat"]')?.click();
      const input = document.getElementById('chat-input');
      input.value = ${JSON.stringify(`${fresh.referenceToken} 过期引用测试`)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('chat-submit')?.click();
    })()`);
    let expiredUi;
    try {
      expiredUi = await waitForValue(instance.client, `(() => {
        const messages = [...document.querySelectorAll('#chat-messages .chat-ai')];
        const message = messages.find(node => node.textContent.includes('上下文候选已过期'));
        return message ? message.textContent : null;
      })()`, 'expired context reference UI message');
    } catch (error) {
      const diagnostics = await instance.client.evaluate(`(() => ({
        chat: [...document.querySelectorAll('#chat-messages .chat-ai')].map(node => node.textContent),
        projectReady: window.__workspace?.state?.projectReady,
        canUseAI: window.__workspace?.canUseAI?.(),
      }))()`);
      error.message += `; diagnostics=${JSON.stringify(diagnostics)}`;
      throw error;
    }
    assert(expiredUi.includes('上下文候选已过期') && expiredUi.includes('重新选择'), expiredUi);

    console.log('✅ Real Electron context catalog 1/1 passed; valid @ref resolution, revision/project invalidation, TTL expiry and Chat recovery UI verified');
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
