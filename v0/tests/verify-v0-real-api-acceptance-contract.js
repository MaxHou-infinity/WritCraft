#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const acceptance = require('./verify-v0-api');
const apiKeyConfig = require('../src/main/api-key-config-service');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const root = path.resolve(__dirname, '..');
const scriptPath = path.join(__dirname, 'verify-v0-api.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const TEST_CREDENTIAL = Object.freeze({ apiKey: 'sk-api-offline-contract-only', keyType: 'FULL', source: 'test' });
const TEST_CP_CREDENTIAL = Object.freeze({ apiKey: 'sk-cp-offline-contract-only', keyType: 'CODING_PLAN', source: 'test' });
const EXPECTED_CHECKS = 16;
const TEXT_STAGES = Object.freeze([
  'models_handshake', 'minimal_message', 'project_onboarding_json', 'research_exact_quote',
]);

function injectedStages(order, overrides = {}) {
  return Object.fromEntries([...TEXT_STAGES, 'image_01'].map(name => [name, async context => {
    order?.push(name);
    if (typeof overrides[name] === 'function') return overrides[name](context);
    return {};
  }]));
}

async function main() {
  console.log('\nReal MiniMax acceptance contract verification');

  await test('live script fails closed before network unless the explicit acceptance gate is set', () => {
    const env = { ...process.env };
    delete env.WRITCRAFT_REAL_API_ACCEPTANCE;
    delete env.WRITCRAFT_REAL_API_IMAGE;
    delete env.WRITCRAFT_REAL_API_SCOPE;
    delete env.WRITCRAFT_MINIMAX_KEY;
    const run = childProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.strictEqual(run.status, 2);
    assert.strictEqual(run.stdout, '');
    const payload = JSON.parse(run.stderr.trim());
    assert.deepStrictEqual(payload, {
      schema: 'writcraft.real-api-acceptance/v1',
      ok: false,
      error: 'LIVE_GATE_REQUIRED',
      hint: 'Set WRITCRAFT_REAL_API_ACCEPTANCE=1 to allow real MiniMax network requests.',
    });
  });

  await test('default npm verification cannot invoke the real API script', () => {
    for (const name of ['pretest', 'test', 'preverify', 'verify']) {
      assert(!String(packageJson.scripts[name] || '').includes('node tests/verify-v0-api.js'), `${name} must remain offline`);
    }
  });

  await test('acceptance uses only synthetic fixtures and requires a second gate for quota-consuming image generation', () => {
    assert(source.includes("const LIVE_GATE = 'WRITCRAFT_REAL_API_ACCEPTANCE'"));
    assert(source.includes("const IMAGE_GATE = 'WRITCRAFT_REAL_API_IMAGE'"));
    assert(source.includes("env.WRITCRAFT_REAL_API_SCOPE === 'image'"));
    assert(source.includes("require('./fixtures/writcraft-longform-project')"));
    assert(source.includes('syntheticContentOnly: true'));
    assert(source.includes('image generation may consume Token Plan quota or paid Credits'));
    assert(!source.includes("credential.keyType === 'CODING_PLAN'"),
      'Token Plan image capability must be decided by the provider, not the key prefix');
  });

  await test('credential lookup follows explicit key, explicit userData, stable, then ordered legacy precedence', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-credential-order-')));
    const directories = Object.fromEntries(
      ['explicit', 'stable', 'legacyFirst', 'legacySecond', 'emptyStable']
        .map(name => [name, path.join(parent, name)])
    );
    const keys = {
      environment: 'sk-api-offline-environment-0001',
      explicit: 'sk-api-offline-explicit-data-0002',
      stable: 'sk-api-offline-stable-data-0003',
      legacyFirst: 'sk-api-offline-legacy-first-0004',
      legacySecond: 'sk-api-offline-legacy-second-0005',
    };
    try {
      for (const directory of Object.values(directories)) fs.mkdirSync(directory);
      for (const name of ['explicit', 'stable', 'legacyFirst', 'legacySecond']) {
        apiKeyConfig.saveUserKey(directories[name], keys[name]);
      }
      const old = new Date('2020-01-01T00:00:00.000Z');
      const recent = new Date('2030-01-01T00:00:00.000Z');
      fs.utimesSync(path.join(directories.explicit, apiKeyConfig.CONFIG_FILE), old, old);
      fs.utimesSync(path.join(directories.stable, apiKeyConfig.CONFIG_FILE), recent, recent);
      fs.utimesSync(path.join(directories.legacyFirst, apiKeyConfig.CONFIG_FILE), old, old);
      fs.utimesSync(path.join(directories.legacySecond, apiKeyConfig.CONFIG_FILE), recent, recent);
      const lookupOptions = {
        stableUserData: directories.stable,
        legacyUserData: [directories.legacyFirst, directories.legacySecond],
      };

      const environment = acceptance.loadConfiguredKey({
        WRITCRAFT_MINIMAX_KEY: keys.environment,
        WRITCRAFT_USER_DATA: directories.explicit,
      }, lookupOptions);
      assert(environment && environment.apiKey === keys.environment, 'explicit environment key must win');

      const explicit = acceptance.loadConfiguredKey({ WRITCRAFT_USER_DATA: directories.explicit }, lookupOptions);
      assert(explicit && explicit.apiKey === keys.explicit, 'explicit userData must beat newer stable data');

      const stable = acceptance.loadConfiguredKey({}, lookupOptions);
      assert(stable && stable.apiKey === keys.stable, 'stable userData must beat legacy data');

      const legacy = acceptance.loadConfiguredKey({}, {
        stableUserData: directories.emptyStable,
        legacyUserData: [directories.legacyFirst, directories.legacySecond],
      });
      assert(legacy && legacy.apiKey === keys.legacyFirst, 'legacy fallback must use declared order, not global mtime');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  await test('an explicit empty or corrupt userData is isolated and never falls through to stable credentials', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-isolated-profile-')));
    const emptyProfile = path.join(parent, 'empty-profile');
    const corruptProfile = path.join(parent, 'corrupt-profile');
    const stableProfile = path.join(parent, 'stable-profile');
    for (const directory of [emptyProfile, corruptProfile, stableProfile]) fs.mkdirSync(directory);
    try {
      apiKeyConfig.saveUserKey(stableProfile, 'sk-api-offline-stable-isolation-0006');
      fs.writeFileSync(path.join(corruptProfile, apiKeyConfig.CONFIG_FILE), '{}\n', { mode: 0o600 });
      const lookupOptions = { stableUserData: stableProfile, legacyUserData: [] };

      const empty = acceptance.loadConfiguredKey({ WRITCRAFT_USER_DATA: emptyProfile }, lookupOptions);
      const corrupt = acceptance.loadConfiguredKey({ WRITCRAFT_USER_DATA: corruptProfile }, lookupOptions);
      const blank = acceptance.loadConfiguredKey({ WRITCRAFT_USER_DATA: '' }, lookupOptions);
      assert.strictEqual(empty, null, 'empty explicit profile must not fall through to stable userData');
      assert.strictEqual(corrupt, null, 'corrupt explicit profile must not fall through to stable userData');
      assert.strictEqual(blank, null, 'blank explicit profile variable must not fall through to stable userData');

      for (const explicitProfile of [emptyProfile, corruptProfile]) {
        let stageCalls = 0;
        const result = await acceptance.runAcceptance({
          env: {
            WRITCRAFT_REAL_API_ACCEPTANCE: '1',
            WRITCRAFT_USER_DATA: explicitProfile,
          },
          loadCredential: env => acceptance.loadConfiguredKey(env, lookupOptions),
          stageTasks: injectedStages(null, {
            models_handshake: async () => { stageCalls += 1; return {}; },
          }),
        });
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.payload.error, 'NO_KEY');
        assert.strictEqual(stageCalls, 0);
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  await test('acceptance report contains no historical key fingerprint or provider content logging', () => {
    assert(!source.includes("endsWith('O_pU')"));
    assert(!source.includes('Key 末尾指纹'));
    assert(!source.includes('可用模型:'));
    assert(!source.includes('返回: "'));
    assert(!source.includes('model: result.model'), 'provider-controlled model ids must not enter the report');
    assert(source.includes('modelMatchedDefault: result.model === minimaxText.DEFAULT_MODEL'));
    assert(!/console\.(?:log|error)\([^\n]*(?:apiKey|result\.text|previewDataUrl)/.test(source));
  });

  await test('Onboarding service remains the only strict JSON parser and reports public shape metadata', () => {
    assert(!source.includes('JSON.parse(response.text)'));
    assert(source.includes('responseKeys: Object.keys(result).sort()'));
    assert(source.includes('contextManifestKeys: Object.keys(result.contextManifest).sort()'));
    assert(source.includes('sectionCount: result.contextManifest.sectionIds.length'));
  });

  await test('image output is decoded, reports safe dimensions and is removed with the synthetic project', () => {
    assert(source.includes("spawnSync('/usr/bin/sips'"));
    assert(source.includes('decodedImageMetadata(decodedSize)'));
    assert(source.includes("requestedAspectRatio: '16:9'"));
    assert(source.includes('fs.rmSync(scratch, { recursive: true, force: true })'));
    assert(source.includes('manuscriptInserted: false'));
    assert.deepStrictEqual(acceptance.decodedImageMetadata({ width: 1920, height: 1080 }), {
      width: 1920, height: 1080, decodedRatio: 1.7778,
    });
  });

  await test('live gate plus no credential fails before every injected network stage', async () => {
    let stageCalls = 0;
    const result = await acceptance.runAcceptance({
      env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1' },
      loadCredential: () => null,
      stageTasks: injectedStages(null, {
        models_handshake: async () => { stageCalls += 1; return {}; },
      }),
    });
    assert.strictEqual(stageCalls, 0);
    assert.deepStrictEqual(result, {
      exitCode: 2,
      stream: 'stderr',
      payload: { schema: acceptance.REPORT_SCHEMA, ok: false, error: 'NO_KEY' },
    });
  });

  await test('image-only scope requires its second paid gate before credential lookup or stages', async () => {
    let credentialLoads = 0;
    const result = await acceptance.runAcceptance({
      env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1', WRITCRAFT_REAL_API_SCOPE: 'image' },
      loadCredential: () => { credentialLoads += 1; return TEST_CREDENTIAL; },
      stageTasks: injectedStages([]),
    });
    assert.strictEqual(credentialLoads, 0);
    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(result.payload.error, 'IMAGE_GATE_REQUIRED');
  });

  await test('unknown or misspelled scope fails before credential lookup and every stage', async () => {
    for (const invalidScope of ['imgae', '', 'ALL']) {
      let credentialLoads = 0;
      let stageCalls = 0;
      const result = await acceptance.runAcceptance({
        env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1', WRITCRAFT_REAL_API_SCOPE: invalidScope },
        loadCredential: () => { credentialLoads += 1; return TEST_CREDENTIAL; },
        stageTasks: injectedStages(null, {
          models_handshake: async () => { stageCalls += 1; return {}; },
        }),
      });
      assert.strictEqual(result.exitCode, 2);
      assert.strictEqual(result.payload.error, 'INVALID_SCOPE');
      assert.strictEqual(credentialLoads, 0);
      assert.strictEqual(stageCalls, 0);
    }
  });

  await test('all and image scopes run only their declared stages in deterministic order', async () => {
    const allOrder = [];
    const all = await acceptance.runAcceptance({
      env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1' },
      loadCredential: () => TEST_CREDENTIAL,
      stageTasks: injectedStages(allOrder),
    });
    assert.deepStrictEqual(allOrder, TEXT_STAGES);
    assert.deepStrictEqual(all.payload.stages.map(item => item.name), [...TEXT_STAGES, 'image_01']);
    assert.strictEqual(all.payload.stages.at(-1).skipped, true);
    assert.strictEqual(all.exitCode, 0);

    const imageOrder = [];
    const image = await acceptance.runAcceptance({
      env: {
        WRITCRAFT_REAL_API_ACCEPTANCE: '1',
        WRITCRAFT_REAL_API_SCOPE: 'image',
        WRITCRAFT_REAL_API_IMAGE: '1',
      },
      loadCredential: () => TEST_CREDENTIAL,
      stageTasks: injectedStages(imageOrder),
    });
    assert.deepStrictEqual(imageOrder, ['image_01']);
    assert.deepStrictEqual(image.payload.stages.map(item => item.name), ['image_01']);
    assert.strictEqual(image.exitCode, 0);
  });

  await test('image-only scope admits a Coding Plan key and defers capability to the provider', async () => {
    const imageOrder = [];
    const image = await acceptance.runAcceptance({
      env: {
        WRITCRAFT_REAL_API_ACCEPTANCE: '1',
        WRITCRAFT_REAL_API_SCOPE: 'image',
        WRITCRAFT_REAL_API_IMAGE: '1',
      },
      loadCredential: () => TEST_CP_CREDENTIAL,
      stageTasks: injectedStages(imageOrder, {
        image_01: async ({ credential }) => {
          assert.strictEqual(credential.keyType, 'CODING_PLAN');
          return { providerCapabilityChecked: true };
        },
      }),
    });
    assert.deepStrictEqual(imageOrder, ['image_01']);
    assert.strictEqual(image.payload.stages[0].providerCapabilityChecked, true);
    assert.strictEqual(image.exitCode, 0);
  });

  await test('hostile thrown messages and unknown codes collapse to metadata-only ACCEPTANCE_FAILED', async () => {
    const secret = 'sk-api-DO_NOT_LEAK prompt manuscript provider-body';
    const result = await acceptance.runAcceptance({
      env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1' },
      loadCredential: () => TEST_CREDENTIAL,
      stageTasks: injectedStages([], {
        models_handshake: async () => { throw Object.assign(new Error(secret), { code: secret }); },
      }),
    });
    const serialized = JSON.stringify(result);
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.payload.stages[0].error, 'ACCEPTANCE_FAILED');
    assert(!serialized.includes(secret));
    assert(!serialized.includes('provider-body'));
  });

  await test('stable Onboarding and image errors remain classifiable without messages or bodies', () => {
    for (const code of [
      'INVALID_MODEL_OUTPUT', 'MODEL_OUTPUT_TRUNCATED', 'MODEL_OUTPUT_INCOMPLETE',
      'ONBOARDING_DEPENDENCY_STALE', 'INVALID_API_RESPONSE',
      'IMAGE_RESPONSE_TOO_LARGE', 'IMAGE_RATE_LIMITED', 'IMAGE_ABORTED',
    ]) {
      assert.strictEqual(acceptance.safeError(code), code);
    }
    assert.strictEqual(acceptance.safeError('provider says secret'), 'ACCEPTANCE_FAILED');
  });

  await test('scratch project is removed in finally after an injected stage failure', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-contract-parent-'));
    let scratch = null;
    try {
      const result = await acceptance.runAcceptance({
        env: { WRITCRAFT_REAL_API_ACCEPTANCE: '1' },
        loadCredential: () => TEST_CREDENTIAL,
        scratchParent: parent,
        stageTasks: injectedStages([], {
          models_handshake: async context => {
            scratch = context.scratch;
            fs.writeFileSync(path.join(scratch, 'sentinel'), 'synthetic-only', 'utf8');
            throw Object.assign(new Error('synthetic failure'), { code: 'TIMEOUT' });
          },
        }),
      });
      assert.strictEqual(result.exitCode, 1);
      assert(scratch);
      assert.strictEqual(fs.existsSync(scratch), false);
      assert.deepStrictEqual(fs.readdirSync(parent), []);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  assert.strictEqual(passed, EXPECTED_CHECKS);
  console.log(`\n${passed}/${EXPECTED_CHECKS} real API acceptance contract checks passed; 0 network calls.`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
