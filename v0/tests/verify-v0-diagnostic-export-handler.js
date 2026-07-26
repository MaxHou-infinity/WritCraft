'use strict';

const assert = require('assert');
const diagnosticExportService = require('../src/main/diagnostic-export-service');
const { createDiagnosticExportHandler } = require('../src/main/diagnostic-export-handler');

console.log('════════ WritCraft V0 · Diagnostic export handler verify ════════');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function bundleInput() {
  return {
    generatedAt: new Date('2026-07-26T09:00:00.000Z'),
    app: { version: '0.1.0', packaged: false },
    runtime: { platform: 'darwin', arch: 'arm64', electron: '32.3.3', node: '20.18.0' },
    project: {
      open: true,
      fileCount: 7,
      markdownFileCount: 6,
      promptStatus: 'valid',
      promptDiagnosticCodes: [],
      watcherStatus: 'healthy',
      metrics: {
        sampleSize: 2,
        smallSample: true,
        inlineDecisions: 1,
        planAttempts: 0,
        researchJudgments: 1,
        imageAttempts: 0,
        onboardingAttempts: 0,
      },
    },
    diagnostics: [],
  };
}

function harness(overrides = {}) {
  let binding = {
    webContentsId: 7,
    projectInstanceId: 'project-instance',
    mutationGeneration: 3,
    navigationEpoch: 2,
  };
  const writes = [];
  const dialogs = [];
  const store = diagnosticExportService.createDiagnosticPreviewStore();
  const handler = createDiagnosticExportHandler({
    assertTrustedSender(event) {
      if (event?.trusted !== true) {
        const error = new Error('untrusted');
        error.code = 'UNTRUSTED_SENDER';
        throw error;
      }
    },
    captureBinding: () => ({ ...binding }),
    createBundleInput: async () => bundleInput(),
    previewStore: store,
    showSaveDialog: async options => {
      dialogs.push(options);
      return { canceled: false, filePath: '/tmp/WritCraft-diagnostics.json' };
    },
    writeFile(filePath, serialized) { writes.push({ filePath, serialized }); },
    now: () => new Date('2026-07-26T09:01:02.003Z'),
    ...overrides,
  });
  return {
    handler,
    writes,
    dialogs,
    setBinding(next) { binding = { ...binding, ...next }; },
  };
}

(async () => {
  await test('trusted preview returns the exact Main-owned serialized JSON and no save dialog', async () => {
    const run = harness();
    const result = await run.handler.preview({ trusted: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.schema, diagnosticExportService.PREVIEW_SCHEMA);
    assert.match(result.token, /^[a-f0-9]{32,128}$/);
    assert.strictEqual(JSON.parse(result.serialized).schema, diagnosticExportService.BUNDLE_SCHEMA);
    assert.strictEqual(run.dialogs.length, 0);
    assert.strictEqual(run.writes.length, 0);
  });

  await test('untrusted preview fails before bundle creation', async () => {
    let built = 0;
    const run = harness({ createBundleInput: async () => { built += 1; return bundleInput(); } });
    await assert.rejects(() => run.handler.preview({ trusted: false }), error => error.code === 'UNTRUSTED_SENDER');
    assert.strictEqual(built, 0);
  });

  await test('project drift while a preview is being assembled issues no usable token', async () => {
    let captures = 0;
    const run = harness({
      captureBinding: () => ({
        webContentsId: 7,
        projectInstanceId: 'project-instance',
        mutationGeneration: captures++ === 0 ? 3 : 4,
        navigationEpoch: 2,
      }),
    });
    await assert.rejects(
      () => run.handler.preview({ trusted: true }),
      error => error.code === 'DIAGNOSTIC_PREVIEW_STALE'
    );
    assert.strictEqual(run.dialogs.length, 0);
    assert.strictEqual(run.writes.length, 0);
  });

  await test('Renderer cannot supply diagnostic content, an output path or unknown fields', async () => {
    const run = harness();
    const preview = await run.handler.preview({ trusted: true });
    for (const extra of [
      { content: 'manuscript' },
      { filePath: '/tmp/hostile.json' },
      { schema: 'wrong' },
    ]) {
      await assert.rejects(
        () => run.handler.exportPreview({ trusted: true }, {
          schema: diagnosticExportService.EXPORT_SCHEMA,
          token: preview.token,
          ...extra,
        }),
        error => error.code === 'INVALID_DIAGNOSTIC_EXPORT'
      );
    }
    assert.strictEqual(run.dialogs.length, 0);
  });

  await test('project drift after preview fails before the native dialog', async () => {
    const run = harness();
    const preview = await run.handler.preview({ trusted: true });
    run.setBinding({ mutationGeneration: 4 });
    await assert.rejects(
      () => run.handler.exportPreview({ trusted: true }, {
        schema: diagnosticExportService.EXPORT_SCHEMA,
        token: preview.token,
      }),
      error => error.code === 'DIAGNOSTIC_PREVIEW_STALE'
    );
    assert.strictEqual(run.dialogs.length, 0);
    assert.strictEqual(run.writes.length, 0);
  });

  await test('project drift while the native dialog is open fails before write', async () => {
    let release;
    const run = harness({
      showSaveDialog: () => new Promise(resolve => { release = resolve; }),
    });
    const preview = await run.handler.preview({ trusted: true });
    const pending = run.handler.exportPreview({ trusted: true }, {
      schema: diagnosticExportService.EXPORT_SCHEMA,
      token: preview.token,
    });
    await Promise.resolve();
    run.setBinding({ navigationEpoch: 3 });
    release({ canceled: false, filePath: '/tmp/WritCraft-diagnostics.json' });
    await assert.rejects(() => pending, error => error.code === 'DIAGNOSTIC_PREVIEW_STALE');
    assert.strictEqual(run.writes.length, 0);
  });

  await test('cancel writes nothing and keeps the preview available for a later retry', async () => {
    let calls = 0;
    const run = harness({
      showSaveDialog: async () => {
        calls += 1;
        return calls === 1
          ? { canceled: true }
          : { canceled: false, filePath: '/tmp/WritCraft-diagnostics.json' };
      },
    });
    const preview = await run.handler.preview({ trusted: true });
    const request = { schema: diagnosticExportService.EXPORT_SCHEMA, token: preview.token };
    assert.deepStrictEqual(
      await run.handler.exportPreview({ trusted: true }, request),
      { ok: true, canceled: true, saved: false }
    );
    assert.strictEqual(run.writes.length, 0);
    const saved = await run.handler.exportPreview({ trusted: true }, request);
    assert.strictEqual(saved.saved, true);
    assert.strictEqual(run.writes.length, 1);
  });

  await test('successful export writes exact preview bytes, returns basename only and consumes token', async () => {
    const run = harness();
    const preview = await run.handler.preview({ trusted: true });
    const request = { schema: diagnosticExportService.EXPORT_SCHEMA, token: preview.token };
    const result = await run.handler.exportPreview({ trusted: true }, request);
    assert.deepStrictEqual(result, {
      ok: true,
      schema: diagnosticExportService.EXPORT_SCHEMA,
      canceled: false,
      saved: true,
      basename: 'WritCraft-diagnostics.json',
    });
    assert.strictEqual(run.writes[0].serialized, preview.serialized);
    assert(!JSON.stringify(result).includes('/tmp'));
    await assert.rejects(
      () => run.handler.exportPreview({ trusted: true }, request),
      error => ['DIAGNOSTIC_PREVIEW_STALE', 'DIAGNOSTIC_PREVIEW_NOT_FOUND'].includes(error.code)
    );
  });

  await test('a write crossing the preview TTL still reports committed success and cannot replay', async () => {
    let time = Date.parse('2026-07-26T09:00:00.000Z');
    const store = diagnosticExportService.createDiagnosticPreviewStore({
      now: () => new Date(time),
    });
    const run = harness({
      previewStore: store,
      writeFile(filePath, serialized) {
        run.writes.push({ filePath, serialized });
        time += diagnosticExportService.PREVIEW_TTL_MS + 1;
      },
    });
    const preview = await run.handler.preview({ trusted: true });
    const request = { schema: diagnosticExportService.EXPORT_SCHEMA, token: preview.token };
    const result = await run.handler.exportPreview({ trusted: true }, request);
    assert.strictEqual(result.saved, true);
    assert.strictEqual(run.writes.length, 1);
    await assert.rejects(
      () => run.handler.exportPreview({ trusted: true }, request),
      error => error.code === 'DIAGNOSTIC_PREVIEW_STALE'
    );
  });

  await test('writer failure does not consume the preview and a retry can succeed', async () => {
    let failWrite = true;
    const run = harness({
      writeFile(filePath, serialized) {
        if (failWrite) {
          failWrite = false;
          const error = new Error('disk failure');
          error.code = 'DIAGNOSTIC_WRITE_FAILED';
          throw error;
        }
        run.writes.push({ filePath, serialized });
      },
    });
    const preview = await run.handler.preview({ trusted: true });
    const request = { schema: diagnosticExportService.EXPORT_SCHEMA, token: preview.token };
    await assert.rejects(() => run.handler.exportPreview({ trusted: true }, request));
    const result = await run.handler.exportPreview({ trusted: true }, request);
    assert.strictEqual(result.saved, true);
    assert.strictEqual(run.writes.length, 1);
  });

  console.log(`\n${passed}/10 diagnostic export handler checks passed.\n`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
