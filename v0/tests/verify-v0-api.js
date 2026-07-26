#!/usr/bin/env node
'use strict';

// Explicit live MiniMax acceptance. This script is intentionally excluded
// from npm verify: it performs paid/limited POST requests only when the caller
// opts in. It uses synthetic fixture content and prints metadata only—never a
// key fingerprint, prompt, provider text, quote, image bytes or project path.

const childProcess = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apiKeyConfig = require('../src/main/api-key-config-service');
const handshakeService = require('../src/main/api-handshake-service');
const minimaxText = require('../src/main/minimax-text-service');
const projectService = require('../src/main/project-service');
const onboardingService = require('../src/main/project-onboarding-v2-service');
const sourceIndexService = require('../src/main/source-index-service');
const researchService = require('../src/main/research-service');
const imageService = require('../src/main/image-generation-service');
const longformFixture = require('./fixtures/writcraft-longform-project');

const REPORT_SCHEMA = 'writcraft.real-api-acceptance/v1';
const LIVE_GATE = 'WRITCRAFT_REAL_API_ACCEPTANCE';
const IMAGE_GATE = 'WRITCRAFT_REAL_API_IMAGE';
const STABLE_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', 'WritCraft');
const LEGACY_USER_DATA = Object.freeze([
  path.join(os.homedir(), 'Library', 'Application Support', '笔触 · WritCraft'),
  path.join(os.homedir(), 'Library', 'Application Support', 'writ-craft'),
]);

function assertExactKeys(value, expected, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepStrictEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}
const SAFE_STAGE_ERRORS = new Set([
  'NO_KEY', 'AUTH_FAILED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'API_FAILED',
  'TIMEOUT', 'REQUEST_ABORTED', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE',
  'REQUEST_FAILED', 'NO_TEXT_BLOCK', 'LLM_FAILED', 'LLM_REPAIR_FAILED',
  'INVALID_MODEL_OUTPUT', 'QUOTE_MISMATCH', 'IMAGE_AUTH_FAILED',
  'IMAGE_RATE_LIMITED', 'IMAGE_SERVICE_UNAVAILABLE', 'IMAGE_API_FAILED',
  'IMAGE_INSUFFICIENT_BALANCE', 'IMAGE_CONTENT_REJECTED',
  'IMAGE_QUOTA_EXCEEDED', 'IMAGE_INVALID_REQUEST',
  'IMAGE_KEY_UNSUPPORTED',
  'IMAGE_TIMEOUT', 'IMAGE_REQUEST_FAILED', 'INVALID_IMAGE_RESPONSE',
  'UNSUPPORTED_IMAGE_TYPE', 'INVALID_IMAGE_DATA', 'IMAGE_ASPECT_MISMATCH',
  'MODEL_OUTPUT_INCOMPLETE', 'MODEL_OUTPUT_TOO_LARGE', 'MODEL_OUTPUT_TRUNCATED',
  'INVALID_PROJECT_SERVICE', 'INVALID_LLM', 'INVALID_PROJECT_TREE',
  'INVALID_ONBOARDING_REQUEST', 'ONBOARDING_REQUEST_TOO_LARGE',
  'ONBOARDING_CONTEXT_TOO_LARGE', 'ONBOARDING_DEPENDENCY_STALE',
  'INVALID_EDIT_PROMPT', 'EDIT_PROMPT_TOO_LARGE', 'AMBIGUOUS_EDIT_PROMPT',
  'INVALID_FILE_SUGGESTIONS', 'INVALID_SUGGESTION_PATH',
  'DUPLICATE_SUGGESTION_PATH', 'RESERVED_SUGGESTION_PATH',
  'SUGGESTION_PATH_CONFLICT', 'GENERATED_CONTENT_TOO_LARGE',
  'INVALID_API_RESPONSE', 'IMAGE_RESPONSE_TOO_LARGE',
  'IMAGE_DECODER_UNAVAILABLE', 'IMAGE_ABORTED', 'IMAGE_EXISTS',
  'UNSAFE_IMAGE_DESTINATION', 'INVALID_PROJECT', 'INVALID_PROMPT',
  'PROMPT_TOO_LONG', 'INVALID_ASPECT_RATIO',
]);

function safeError(value) {
  return SAFE_STAGE_ERRORS.has(value) ? value : 'ACCEPTANCE_FAILED';
}

function elapsed(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function loadConfiguredKey(env = process.env, options = {}) {
  const explicit = String(env.WRITCRAFT_MINIMAX_KEY || '').trim();
  if (explicit) {
    const validated = apiKeyConfig.validateKey(explicit);
    return { apiKey: validated.key, keyType: validated.keyType, source: 'environment' };
  }
  const explicitUserDataProvided = Object.prototype.hasOwnProperty.call(env, 'WRITCRAFT_USER_DATA');
  const explicitUserData = String(env.WRITCRAFT_USER_DATA || '').trim();
  const stableUserData = typeof options.stableUserData === 'string'
    ? options.stableUserData
    : STABLE_USER_DATA;
  const legacyUserData = Array.isArray(options.legacyUserData)
    ? options.legacyUserData
    : LEGACY_USER_DATA;
  // An explicit userData variable is an isolation boundary for E2E/manual
  // profiles. Empty, corrupt or missing configuration in that profile means
  // NO_KEY; it must never fall through to a real stable/legacy credential.
  // The explicit environment key above remains the sole higher authority.
  if (explicitUserDataProvided) {
    if (!explicitUserData) return null;
    try { return apiKeyConfig.loadUserKey(explicitUserData); }
    catch (_) { return null; }
  }
  // Without an explicit profile, stable app userData precedes ordered legacy
  // fallbacks. The layers are never globally sorted by mtime.
  const candidates = [stableUserData, ...legacyUserData]
    .filter(value => typeof value === 'string' && value);
  for (const directory of [...new Set(candidates)]) {
    try {
      const configured = apiKeyConfig.loadUserKey(directory);
      if (!configured) continue;
      return configured;
    } catch (_) {
      // A corrupt/unsafe candidate is not a credential source and its details
      // may contain paths or secret material, so it is deliberately ignored.
    }
  }
  return null;
}

function acceptanceScope(env) {
  if (!Object.prototype.hasOwnProperty.call(env, 'WRITCRAFT_REAL_API_SCOPE')) return 'all';
  if (env.WRITCRAFT_REAL_API_SCOPE === 'all' || env.WRITCRAFT_REAL_API_SCOPE === 'image') {
    return env.WRITCRAFT_REAL_API_SCOPE;
  }
  return null;
}

function decodedImageMetadata(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw Object.assign(new Error('decoded image metadata unavailable'), { code: 'INVALID_IMAGE_DATA' });
  }
  return {
    width,
    height,
    decodedRatio: Number((width / height).toFixed(4)),
  };
}

function publicUsage(value) {
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

function systemDecodeImage(bytes, mimeType, scratch) {
  if (process.platform !== 'darwin') return null;
  const extension = mimeType === 'image/png' ? '.png' : '.jpg';
  const target = path.join(scratch, `decode${extension}`);
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  try {
    const result = childProcess.spawnSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', target], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0) return null;
    const width = Number(String(result.stdout).match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(String(result.stdout).match(/pixelHeight:\s*(\d+)/)?.[1]);
    return Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { width, height } : null;
  } finally {
    try { fs.unlinkSync(target); } catch (_) {}
  }
}

async function runAcceptance(options = {}) {
  const env = options.env || process.env;
  const scope = acceptanceScope(env);
  if (!scope) {
    return {
      exitCode: 2,
      stream: 'stderr',
      payload: { schema: REPORT_SCHEMA, ok: false, error: 'INVALID_SCOPE' },
    };
  }
  if (env[LIVE_GATE] !== '1') {
    return {
      exitCode: 2,
      stream: 'stderr',
      payload: {
      schema: REPORT_SCHEMA,
      ok: false,
      error: 'LIVE_GATE_REQUIRED',
      hint: `Set ${LIVE_GATE}=1 to allow real MiniMax network requests.`,
      },
    };
  }
  if (scope === 'image' && env[IMAGE_GATE] !== '1') {
    return {
      exitCode: 2,
      stream: 'stderr',
      payload: { schema: REPORT_SCHEMA, ok: false, error: 'IMAGE_GATE_REQUIRED' },
    };
  }

  let credential;
  try {
    credential = typeof options.loadCredential === 'function'
      ? options.loadCredential(env)
      : loadConfiguredKey(env);
  }
  catch (_) { credential = null; }
  if (!credential) {
    return {
      exitCode: 2,
      stream: 'stderr',
      payload: { schema: REPORT_SCHEMA, ok: false, error: 'NO_KEY' },
    };
  }

  const report = {
    schema: REPORT_SCHEMA,
    startedAt: new Date().toISOString(),
    keyType: credential.keyType,
    credentialSource: credential.source,
    syntheticContentOnly: true,
    scope,
    stages: [],
  };
  let failed = false;
  const scratchParent = typeof options.scratchParent === 'string' ? options.scratchParent : os.tmpdir();
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'writcraft-real-api-acceptance-'));

  async function stage(name, task) {
    const startedAt = Date.now();
    try {
      const injected = options.stageTasks && options.stageTasks[name];
      const detail = await (typeof injected === 'function'
        ? injected({ credential, env, scratch, scope })
        : task());
      report.stages.push({ name, ok: true, latencyMs: elapsed(startedAt), ...detail });
    } catch (error) {
      failed = true;
      report.stages.push({ name, ok: false, latencyMs: elapsed(startedAt), error: safeError(error?.code || error?.error) });
    }
  }

  try {
    if (report.scope !== 'image') {
      await stage('models_handshake', async () => {
      const result = await handshakeService.runApiHandshake({
        apiKey: credential.apiKey,
        checkModels: minimaxText.checkModels,
        defaultModel: minimaxText.DEFAULT_MODEL,
      });
      if (!result.ok) throw { code: result.reason };
      return { modelCount: result.modelCount, defaultModelAvailable: result.defaultModelAvailable };
      });

      await stage('minimal_message', async () => {
      const result = await minimaxText.callMessages({
        apiKey: credential.apiKey,
        model: minimaxText.DEFAULT_MODEL,
        maxTokens: 8,
        messages: [{ role: 'user', content: '这是 WritCraft 合成连接自检。请只回复 OK。' }],
      });
      if (!result.ok) throw { code: result.error };
      if (!result.text) throw { code: 'NO_TEXT_BLOCK' };
      return {
        modelMatchedDefault: result.model === minimaxText.DEFAULT_MODEL,
        responseChars: Array.from(result.text).length,
        usage: publicUsage(result.usage),
      };
      });

      await stage('project_onboarding_json', async () => {
      const descriptor = projectService.createProjectAt(scratch, '合成项目卡验收');
      const initialEdit = projectService.readFile(descriptor.rootPath, 'edit.md');
        let llmCallCount = 0;
        let requestContractObserved = false;
      const result = await onboardingService.proposeProjectOnboardingV2({
        projectService,
        rootPath: descriptor.rootPath,
        request: {
          schema: onboardingService.REQUEST_SCHEMA,
          answers: [
            { id: 'premise', text: '写一篇关于城市公共档案与社区记忆的非虚构文章。' },
            { id: 'audience', text: '关心城市更新的普通读者。' },
            { id: 'objective', text: '解释决策过程、证据边界与不同参与者的立场。' },
            { id: 'structure', text: '三章：现场、证据、复核。' },
            { id: 'voice', text: '克制、准确，不把推测写成事实。' },
          ],
        },
        callLLM: async (messages, model, maxTokens) => {
          llmCallCount += 1;
          assert.strictEqual(model, onboardingService.MODEL, 'Onboarding must use its pinned model');
          assert.strictEqual(maxTokens, onboardingService.MAX_TOKENS, 'Onboarding must use its bounded token budget');
          assert(Array.isArray(messages), 'Onboarding model messages must be an array');
          assert.strictEqual(messages.length, 1, 'Onboarding must send exactly one model message');
          assert.strictEqual(messages[0]?.role, 'user', 'Onboarding model message must use the user role');
          assert.strictEqual(typeof messages[0]?.content, 'string', 'Onboarding prompt must be text');
          const prompt = messages[0].content;
          const answerIds = [...prompt.matchAll(/<project-answer id="([^"]+)" label="[^"]+">/g)]
            .map(match => match[1]);
          assert.deepStrictEqual(answerIds, ['premise', 'audience', 'objective', 'structure', 'voice'],
            'Onboarding prompt must preserve the submitted answer IDs and order');
          assert.strictEqual((prompt.match(/<project-file role="project_prompt" path="edit\.md" revision="[a-f0-9]{64}">/g) || []).length, 1,
            'Onboarding prompt must include exactly one revision-bound edit.md project prompt');
          assert.strictEqual((prompt.match(/<existing-project-paths>/g) || []).length, 1,
            'Onboarding prompt must include exactly one existing-path boundary');
          assert(prompt.includes('严禁返回完整 edit.md、editContent、文件 content、Front Matter、初稿或任何文件正文。'),
            'Onboarding prompt must retain the metadata-only output prohibition');
          requestContractObserved = true;
          const response = await minimaxText.callMessages({
            apiKey: credential.apiKey, messages, model, maxTokens,
          });
          return response;
        },
      });
      if (!result.ok) throw { code: result.error };
      assert.strictEqual(llmCallCount, 1, 'Onboarding v2 must make exactly one model call and never auto-repair');
      assert.strictEqual(requestContractObserved, true, 'Onboarding live acceptance must observe its request contract');
      assertExactKeys(result, [
        'ok', 'noChanges', 'changeSet', 'preview', 'fileSuggestions', 'proposalDigest', 'contextManifest',
      ], 'Onboarding service response');
      assertExactKeys(result.contextManifest, [
        'schema', 'targetPath', 'targetRevision', 'targetAfterRevision', 'treeDigest',
        'answered', 'sectionIds', 'suggestionPaths', 'proposalDigest',
      ], 'Onboarding context manifest');
      assert.strictEqual(typeof result.noChanges, 'boolean', 'Onboarding noChanges must be explicit');
      assert(Array.isArray(result.fileSuggestions), 'Onboarding fileSuggestions must be an array');
      result.fileSuggestions.forEach((item, index) =>
        assertExactKeys(item, ['path', 'title', 'reason'], `Onboarding fileSuggestions[${index}]`));
      const changes = Array.isArray(result.changeSet?.changes) ? result.changeSet.changes : [];
      if (result.noChanges) {
        assert.strictEqual(result.changeSet, null, 'no-op Onboarding must not return a ChangeSet');
        assert.strictEqual(result.preview, null, 'no-op Onboarding must not return a preview');
        assert.strictEqual(changes.length, 0, 'no-op Onboarding must report zero changes');
      } else {
        assert(result.changeSet && result.preview, 'changed Onboarding must return a ChangeSet and preview');
        assert.strictEqual(changes.length, 1, 'Onboarding may change only edit.md');
        assert.strictEqual(changes[0].path, 'edit.md', 'Onboarding ChangeSet target must be edit.md');
      }
      const metadataOnly = result.fileSuggestions.every(item =>
        Object.keys(item).sort().join(',') === 'path,reason,title');
      assert.strictEqual(metadataOnly, true, 'Onboarding suggestions must remain metadata-only');
      const diskChanged = projectService.readFile(descriptor.rootPath, 'edit.md') !== initialEdit;
      assert.strictEqual(diskChanged, false, 'Onboarding proposal must not write edit.md');
      return {
        schema: onboardingService.REQUEST_SCHEMA,
        modelCalls: llmCallCount,
        strictNoRepairObserved: llmCallCount === 1,
        requestContractObserved,
        responseKeys: Object.keys(result).sort(),
        contextManifestKeys: Object.keys(result.contextManifest).sort(),
        sectionCount: result.contextManifest.sectionIds.length,
        noChanges: result.noChanges,
        changeCount: changes.length,
        suggestionCount: result.fileSuggestions.length,
        metadataOnly,
        diskChanged,
      };
      });

      await stage('research_exact_quote', async () => {
      const fixture = longformFixture.buildLongformProject({
        parentPath: scratch,
        projectService,
        name: '合成 Research 验收',
      });
      const sourceIndex = sourceIndexService.buildSourceIndex(fixture.rootPath);
      const source = sourceIndex.sources.find(item => item.filePath === 'references/meeting-minutes.md');
      if (!source) throw { code: 'ACCEPTANCE_FAILED' };
      const result = await researchService.research({
        projectService,
        rootPath: fixture.rootPath,
        question: '这份纪要能支持哪一条关于试运行状态的主张？',
        sourceIds: [source.id],
        sourceIndex,
        callLLM: (messages, model, maxTokens) => minimaxText.callMessages({
          apiKey: credential.apiKey, messages, model, maxTokens,
        }),
      });
      if (!result.ok) throw { code: result.error };
      return {
        cardCount: result.cards.length,
        locatorRepairs: result.contextManifest.locatorRepairs,
        rejectedQuoteCards: result.contextManifest.rejectedQuoteCards,
      };
      });
    }

    if (env[IMAGE_GATE] === '1') {
      await stage('image_01', async () => {
        if (credential.keyType === 'CODING_PLAN') throw { code: 'IMAGE_KEY_UNSUPPORTED' };
        const rootPath = fs.mkdtempSync(path.join(scratch, 'image-project-'));
        let decodedSize = null;
        const result = await imageService.generateAndSaveImage({
          rootPath,
          prompt: '雨后的港口档案室，纪实摄影，安静克制，无文字',
          aspectRatio: '16:9',
          apiKey: credential.apiKey,
          decodeImage: (bytes, mimeType) => {
            decodedSize = systemDecodeImage(bytes, mimeType, scratch);
            return decodedSize;
          },
        });
        if (result.image.width !== decodedSize?.width ||
            result.image.height !== decodedSize?.height ||
            result.image.requestedAspectRatio !== '16:9' ||
            result.image.officialPresetMatch !== true) {
          throw { code: 'IMAGE_ASPECT_MISMATCH' };
        }
        const target = path.join(rootPath, ...result.image.filePath.split('/'));
        return {
          mimeType: result.image.mimeType,
          bytes: fs.statSync(target).size,
          requestedAspectRatio: '16:9',
          ...decodedImageMetadata(decodedSize),
          officialPresetMatch: result.image.officialPresetMatch,
          manuscriptInserted: false,
        };
      });
    } else {
      report.stages.push({
        name: 'image_01', ok: null, skipped: true,
        reason: `${IMAGE_GATE}=1 is required because image generation may consume paid quota.`,
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  report.finishedAt = new Date().toISOString();
  report.ok = !failed && report.stages.every(item => item.ok === true || item.skipped === true);
  return { exitCode: report.ok ? 0 : 1, stream: 'stdout', payload: report };
}

async function runCli() {
  const result = await runAcceptance();
  const serialized = result.stream === 'stdout'
    ? JSON.stringify(result.payload, null, 2)
    : JSON.stringify(result.payload);
  (result.stream === 'stdout' ? console.log : console.error)(serialized);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  runCli().catch(() => {
    console.error(JSON.stringify({ schema: REPORT_SCHEMA, ok: false, error: 'ACCEPTANCE_FAILED' }));
    process.exitCode = 1;
  });
}

module.exports = {
  REPORT_SCHEMA,
  LIVE_GATE,
  IMAGE_GATE,
  SAFE_STAGE_ERRORS,
  safeError,
  loadConfiguredKey,
  acceptanceScope,
  decodedImageMetadata,
  runAcceptance,
};
