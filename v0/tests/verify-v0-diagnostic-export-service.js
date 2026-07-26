'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const service = require('../src/main/diagnostic-export-service');

console.log('════════ WritCraft V0 · Diagnostic export service verify ════════');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function input(overrides = {}) {
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
        sampleSize: 4,
        smallSample: true,
        inlineDecisions: 1,
        planAttempts: 1,
        researchJudgments: 1,
        imageAttempts: 0,
        onboardingAttempts: 1,
      },
    },
    diagnostics: [
      { area: 'project', code: 'PROJECT_CHANGED', time: '2026-07-26T08:59:00.000Z' },
    ],
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    webContentsId: 7,
    projectInstanceId: 'project-instance',
    mutationGeneration: 3,
    navigationEpoch: 2,
    ...overrides,
  };
}

function serialized() {
  return service.serializeDiagnosticBundle(service.buildDiagnosticBundle(input()));
}

test('builds a fixed allowlisted bundle without project identity or content fields', () => {
  const bundle = service.buildDiagnosticBundle(input());
  assert.strictEqual(bundle.schema, service.BUNDLE_SCHEMA);
  assert.deepStrictEqual(Object.keys(bundle), [
    'schema', 'generatedAt', 'app', 'runtime', 'project', 'diagnostics',
  ]);
  assert.deepStrictEqual(Object.keys(bundle.project), [
    'open', 'fileCount', 'markdownFileCount', 'promptStatus',
    'promptDiagnosticCodes', 'watcherStatus', 'metrics',
  ]);
  const keys = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      visit(child);
    }
  };
  visit(bundle);
  for (const forbidden of [
    'rootPath', 'projectName', 'fileName', 'prompt', 'content', 'revision',
    'apiKey', 'message', 'quote', 'path',
  ]) {
    assert(!keys.includes(forbidden));
  }
  assert(!JSON.stringify(bundle).includes('SECRET_MANUSCRIPT_SENTINEL'));
  assert(Object.isFrozen(bundle));
  assert(Object.isFrozen(bundle.project.metrics));
});

test('rejects unknown fields recursively instead of silently carrying them into a preview', () => {
  assert.throws(
    () => service.buildDiagnosticBundle({ ...input(), manuscript: 'secret' }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
  assert.throws(
    () => service.buildDiagnosticBundle({
      ...input(),
      project: { ...input().project, rootPath: '/secret/project' },
    }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
  assert.throws(
    () => service.buildDiagnosticBundle({
      ...input(),
      project: {
        ...input().project,
        metrics: { ...input().project.metrics, modelAnswer: 'secret' },
      },
    }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
  assert.throws(
    () => service.buildDiagnosticBundle({
      ...input(),
      project: {
        ...input().project,
        metrics: { ...input().project.metrics, smallSample: 'false' },
      },
    }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
  assert.throws(
    () => service.buildDiagnosticBundle({
      ...input(),
      project: { ...input().project, fileCount: 1, markdownFileCount: 2 },
    }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
  assert.throws(
    () => service.buildDiagnosticBundle({
      ...input(),
      project: {
        ...input().project,
        open: false,
        promptStatus: 'not_open',
        watcherStatus: 'not_open',
      },
    }),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
});

test('recorder keeps a bounded stable-code ring and never stores raw messages', () => {
  let tick = 0;
  const recorder = service.createDiagnosticRecorder({
    maxEntries: 2,
    now: () => new Date(1000 * tick++),
  });
  recorder.record('project', 'FIRST_FAILURE');
  recorder.record('hostile-area', 'contains manuscript words');
  recorder.record('renderer', 'LAST_FAILURE');
  assert.deepStrictEqual(recorder.list().map(item => [item.area, item.code]), [
    ['diagnostic', 'UNCLASSIFIED_DIAGNOSTIC'],
    ['renderer', 'LAST_FAILURE'],
  ]);
  assert(!JSON.stringify(recorder.list()).includes('manuscript words'));
});

test('serialization is canonical, bounded and refuses a rebuilt hostile bundle', () => {
  const text = serialized();
  assert(text.endsWith('\n'));
  assert.strictEqual(Buffer.byteLength(text, 'utf8') <= service.MAX_SERIALIZED_BYTES, true);
  assert.strictEqual(
    service.serializeDiagnosticBundle(JSON.parse(text)),
    text
  );
  const parsed = JSON.parse(text);
  parsed.project.prompt = 'secret';
  assert.throws(
    () => service.serializeDiagnosticBundle(parsed),
    error => error.code === 'INVALID_DIAGNOSTIC_BUNDLE'
  );
});

test('preview token is bound to window, project, mutation and navigation authority', () => {
  const store = service.createDiagnosticPreviewStore({
    randomToken: () => 'a'.repeat(48),
  });
  const issued = store.issue({ serialized: serialized(), binding: binding() });
  assert.match(issued.token, /^[a-f0-9]{48}$/);
  assert.strictEqual(store.get(issued.token, binding()).serialized, serialized());
  for (const changed of [
    { webContentsId: 8 },
    { projectInstanceId: 'other-project' },
    { mutationGeneration: 4 },
    { navigationEpoch: 3 },
  ]) {
    assert.throws(
      () => store.get(issued.token, binding(changed)),
      error => error.code === 'DIAGNOSTIC_PREVIEW_STALE'
    );
  }
});

test('preview expires after five minutes and successful consume is single-use', () => {
  let time = Date.parse('2026-07-26T09:00:00.000Z');
  let tokenIndex = 0;
  const store = service.createDiagnosticPreviewStore({
    now: () => new Date(time),
    randomToken: () => (++tokenIndex).toString(16).padStart(48, '0'),
  });
  const first = store.issue({ serialized: serialized(), binding: binding() });
  store.consume(first.token, binding());
  assert.throws(() => store.get(first.token, binding()), error => error.code === 'DIAGNOSTIC_PREVIEW_STALE');
  const second = store.issue({ serialized: serialized(), binding: binding() });
  time += service.PREVIEW_TTL_MS + 1;
  assert.throws(() => store.get(second.token, binding()), error => error.code === 'DIAGNOSTIC_PREVIEW_STALE');
  assert.strictEqual(store.size(), 0);
});

test('committed consume stays truthful when a synchronous fsync crosses the token deadline', () => {
  let time = Date.parse('2026-07-26T09:00:00.000Z');
  const store = service.createDiagnosticPreviewStore({
    now: () => new Date(time),
    randomToken: () => 'c'.repeat(48),
  });
  const issued = store.issue({ serialized: serialized(), binding: binding() });
  const record = store.get(issued.token, binding());
  time += service.PREVIEW_TTL_MS + 1;
  assert.strictEqual(
    store.consumeCommitted(issued.token, binding(), record.serialized),
    true
  );
  assert.throws(
    () => store.get(issued.token, binding()),
    error => error.code === 'DIAGNOSTIC_PREVIEW_STALE'
  );
});

test('preview store rejects arbitrary non-canonical content', () => {
  const store = service.createDiagnosticPreviewStore({
    randomToken: () => 'b'.repeat(48),
  });
  assert.throws(
    () => store.issue({ serialized: '{"content":"secret"}\n', binding: binding() }),
    error => error.code === 'INVALID_DIAGNOSTIC_PREVIEW'
  );
  assert.throws(
    () => store.issue({ serialized: serialized(), binding: { ...binding(), rootPath: '/tmp/secret' } }),
    error => error.code === 'INVALID_DIAGNOSTIC_BINDING'
  );
  assert.throws(
    () => store.issue({ serialized: serialized(), binding: binding({ webContentsId: 0 }) }),
    error => error.code === 'INVALID_DIAGNOSTIC_BINDING'
  );
});

test('exclusive writer creates exact 0600 JSON bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-diagnostic-'));
  try {
    const target = path.join(root, 'diagnostic.json');
    const text = serialized();
    const result = service.writeDiagnosticFileExclusive(target, text);
    assert.strictEqual(result.bytes, Buffer.byteLength(text, 'utf8'));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), text);
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exclusive writer refuses an existing target without changing its bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-diagnostic-'));
  try {
    const target = path.join(root, 'diagnostic.json');
    fs.writeFileSync(target, 'owner data', 'utf8');
    assert.throws(
      () => service.writeDiagnosticFileExclusive(target, serialized()),
      error => error.code === 'DIAGNOSTIC_TARGET_EXISTS'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'owner data');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer rejects a parent symlink swap before writing and removes its outside empty file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-diagnostic-'));
  const parent = path.join(root, 'selected');
  const displaced = path.join(root, 'selected-original');
  const outside = path.join(root, 'outside');
  const target = path.join(parent, 'diagnostic.json');
  const outsideTarget = path.join(outside, 'diagnostic.json');
  const originalOpen = fs.openSync;
  fs.mkdirSync(parent);
  fs.mkdirSync(outside);
  try {
    fs.openSync = (filePath, flags, mode) => {
      fs.renameSync(parent, displaced);
      fs.symlinkSync(outside, parent);
      return originalOpen(filePath, flags, mode);
    };
    assert.throws(
      () => service.writeDiagnosticFileExclusive(target, serialized()),
      error => ['INVALID_DIAGNOSTIC_TARGET', 'DIAGNOSTIC_WRITE_FAILED'].includes(error.code)
    );
    assert.strictEqual(fs.existsSync(outsideTarget), false);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    assert.deepStrictEqual(fs.readdirSync(displaced), []);
  } finally {
    fs.openSync = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer removes a partial target after an injected write failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-diagnostic-'));
  const target = path.join(root, 'diagnostic.json');
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (descriptor) => {
      fs.writeSync(descriptor, Buffer.from('partial diagnostic bytes', 'utf8'));
      const error = new Error('injected');
      error.code = 'EIO';
      throw error;
    };
    assert.throws(
      () => service.writeDiagnosticFileExclusive(target, serialized()),
      error => error.code === 'DIAGNOSTIC_WRITE_FAILED'
    );
    assert.strictEqual(fs.existsSync(target), false);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writer failure never deletes a concurrent replacement at the selected path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-diagnostic-'));
  const target = path.join(root, 'diagnostic.json');
  const displaced = path.join(root, 'service-partial.json');
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (destination, content, encoding) => {
      if (typeof destination === 'number') {
        fs.renameSync(target, displaced);
        originalWrite(target, 'competitor data', 'utf8');
        const error = new Error('injected replacement race');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite(destination, content, encoding);
    };
    assert.throws(
      () => service.writeDiagnosticFileExclusive(target, serialized()),
      error => error.code === 'DIAGNOSTIC_WRITE_FAILED'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'competitor data');
  } finally {
    fs.writeFileSync = originalWrite;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed}/13 diagnostic export service checks passed.\n`);
