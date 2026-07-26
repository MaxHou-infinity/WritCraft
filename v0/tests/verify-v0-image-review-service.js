#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const serviceModule = require('../src/main/image-review-service');

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function expectCode(code, fn, options = {}) {
  assert.throws(fn, error =>
    error instanceof serviceModule.ImageReviewError &&
    error.code === code &&
    (options.committed === undefined || error.committed === options.committed));
}

function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-image-review-')));
  const generated = path.join(root, 'assets', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const bytes = options.bytes || Buffer.from('writcraft-image-review-fixture');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetPath = `assets/generated/image-${digest}.png`;
  const target = path.join(root, ...assetPath.split('/'));
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  return {
    root,
    generated,
    bytes,
    digest,
    assetPath,
    target,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function binding(item, overrides = {}) {
  return {
    webContentsId: 7,
    projectInstanceId: 'project-instance',
    rootPath: item.root,
    mutationGeneration: 3,
    navigationEpoch: 2,
    ...overrides,
  };
}

function issueInput(item, overrides = {}) {
  return {
    ...binding(item),
    operationId: 'a'.repeat(32),
    assetPath: item.assetPath,
    assetDigest: item.digest,
    ...overrides,
  };
}

function review(token, decision = 'kept', overrides = {}) {
  return {
    token,
    decision,
    qualityRating: 4,
    ...overrides,
  };
}

function deterministicService(options = {}) {
  let token = 0;
  return serviceModule.createImageReviewService({
    randomToken: () => `irv_${(++token).toString(16).padStart(48, '0')}`,
    ...options,
  });
}

function proxyFs(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

console.log('\nWritCraft Image Review v1 service verification');

test('issues one bounded capability bound to exact private asset identity', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService();
    const issued = reviewService.issue(issueInput(item));
    assert.deepStrictEqual(Object.keys(issued), ['ok', 'schema', 'token', 'expiresAt']);
    assert.strictEqual(issued.schema, serviceModule.REVIEW_SCHEMA);
    assert.match(issued.token, serviceModule.TOKEN_RE);
    assert.deepStrictEqual(reviewService.inspect(issued.token), {
      phase: 'live',
      operationId: 'a'.repeat(32),
      expiresAt: issued.expiresAt,
    });
    expectCode('IMAGE_REVIEW_PENDING', () => reviewService.issue(issueInput(item, {
      operationId: 'b'.repeat(32),
    })));
  } finally { item.cleanup(); }
});

test('issue and review requests reject foreign fields and invalid review metadata', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService();
    expectCode('IMAGE_REVIEW_ISSUE_INVALID', () => reviewService.issue({
      ...issueInput(item),
      prompt: 'secret',
    }));
    const token = reviewService.issue(issueInput(item)).token;
    for (const invalid of [
      { ...review(token), assetPath: item.assetPath },
      { ...review(token), qualityRating: 0 },
      { ...review(token), qualityRating: 6 },
      { ...review(token), qualityRating: 4.5 },
      { ...review(token), costMinorUnits: 12 },
      { ...review(token), currency: 'CNY' },
      { ...review(token), costMinorUnits: -1, currency: 'CNY' },
      { ...review(token), costMinorUnits: serviceModule.MAX_COST_MINOR_UNITS + 1, currency: 'CNY' },
      { ...review(token), costMinorUnits: 12, currency: 'EUR' },
    ]) {
      expectCode('IMAGE_REVIEW_REQUEST_INVALID', () =>
        reviewService.settle(binding(item), invalid));
    }
    let getterReads = 0;
    const getterRequest = {
      decision: 'kept',
      qualityRating: 4,
    };
    Object.defineProperty(getterRequest, 'token', {
      enumerable: true,
      get() { getterReads += 1; return token; },
    });
    expectCode('IMAGE_REVIEW_REQUEST_INVALID', () =>
      reviewService.settle(binding(item), getterRequest));
    assert.strictEqual(getterReads, 0);
    assert.strictEqual(reviewService.inspect(token).phase, 'live');
  } finally { item.cleanup(); }
});

test('kept records exact privacy-safe evidence and aggregate quality, decision and cost', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService({
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const token = reviewService.issue(issueInput(item)).token;
    const result = reviewService.settle(binding(item), review(token, 'kept', {
      qualityRating: 5,
      costMinorUnits: 125,
      currency: 'CNY',
    }));
    assert.deepStrictEqual(result, {
      ok: true,
      schema: serviceModule.REVIEW_SCHEMA,
      decision: 'kept',
      operationId: 'a'.repeat(32),
      committed: true,
      responseRecovered: false,
    });
    assert.deepStrictEqual(fs.readFileSync(item.target), item.bytes);
    const evidencePath = path.join(item.root, '.writcraft', 'image-reviews.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.deepStrictEqual(Object.keys(evidence), ['schema', 'updatedAt', 'records']);
    assert.deepStrictEqual(Object.keys(evidence.records[0]), [
      'operationId', 'decision', 'qualityRating', 'costMinorUnits', 'currency', 'timestamp',
    ]);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [
      item.root, item.assetPath, item.digest, 'prompt', 'path', 'digest', 'base64',
    ]) assert(!serialized.includes(forbidden));
    assert.deepStrictEqual(reviewService.aggregate(item.root), {
      schema: serviceModule.AGGREGATE_SCHEMA,
      sampleSize: 1,
      averageQualityRating: 5,
      decisions: { inserted: 0, kept: 1, deleted: 0 },
      costs: {
        CNY: { sampleSize: 1, totalMinorUnits: 125, averageMinorUnits: 125 },
        USD: { sampleSize: 0, totalMinorUnits: 0, averageMinorUnits: null },
      },
      smallSample: true,
    });
  } finally { item.cleanup(); }
});

test('insert failure keeps capability live; exact response retry never repeats commit', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService();
    const token = reviewService.issue(issueInput(item)).token;
    let commits = 0;
    expectCode('IMAGE_REVIEW_INSERT_FAILED', () =>
      reviewService.settle(binding(item), review(token, 'inserted'), {
        commitInserted() {
          commits += 1;
          return { ok: false, committed: false };
        },
      }));
    assert.strictEqual(reviewService.inspect(token).phase, 'live');
    const result = reviewService.settle(binding(item), review(token, 'inserted'), {
      commitInserted() {
        commits += 1;
        return { ok: true, committed: true };
      },
    });
    assert.strictEqual(result.decision, 'inserted');
    assert.strictEqual(commits, 2);
    const recovered = reviewService.settle(binding(item), review(token, 'inserted'), {
      commitInserted() {
        commits += 1;
        return { ok: true, committed: true };
      },
    });
    assert.strictEqual(recovered.responseRecovered, true);
    assert.strictEqual(commits, 2);
  } finally { item.cleanup(); }
});

test('deleted removes only the exact asset, fsyncs, records evidence and supports response-loss retry', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService();
    const token = reviewService.issue(issueInput(item)).token;
    const request = review(token, 'deleted', {
      qualityRating: 2,
      costMinorUnits: 9,
      currency: 'USD',
    });
    const first = reviewService.settle(binding(item), request);
    assert.strictEqual(first.decision, 'deleted');
    assert.strictEqual(fs.existsSync(item.target), false);
    const trashDirectory = path.join(item.root, '.writcraft', 'image-trash');
    const trashed = fs.readdirSync(trashDirectory);
    assert.strictEqual(trashed.length, 1);
    assert.deepStrictEqual(fs.readFileSync(path.join(trashDirectory, trashed[0])), item.bytes);
    const retried = reviewService.settle(binding(item), request);
    assert.strictEqual(retried.decision, 'deleted');
    assert.strictEqual(retried.responseRecovered, true);
    assert.strictEqual(reviewService.aggregate(item.root).decisions.deleted, 1);
    expectCode('IMAGE_REVIEW_REPLAY', () =>
      reviewService.settle(binding(item), { ...request, qualityRating: 3 }));
  } finally { item.cleanup(); }
});

test('missing exact asset is an idempotent deleted decision without touching siblings', () => {
  const item = fixture();
  const sibling = path.join(item.generated, 'keep-me.png');
  try {
    fs.writeFileSync(sibling, 'sibling', 'utf8');
    const reviewService = deterministicService();
    const token = reviewService.issue(issueInput(item)).token;
    fs.unlinkSync(item.target);
    const result = reviewService.settle(binding(item), review(token, 'deleted'));
    assert.strictEqual(result.decision, 'deleted');
    assert.strictEqual(fs.readFileSync(sibling, 'utf8'), 'sibling');
  } finally { item.cleanup(); }
});

test('foreign binding, project, mutation and navigation drift never delete the asset', () => {
  for (const changed of [
    { webContentsId: 8 },
    { projectInstanceId: 'other-project' },
    { mutationGeneration: 4 },
    { navigationEpoch: 3 },
  ]) {
    const item = fixture();
    try {
      const reviewService = deterministicService();
      const token = reviewService.issue(issueInput(item)).token;
      expectCode('IMAGE_REVIEW_STALE', () =>
        reviewService.settle(binding(item, changed), review(token, 'deleted')));
      assert.deepStrictEqual(fs.readFileSync(item.target), item.bytes);
    } finally { item.cleanup(); }
  }
});

test('symlink, hard-link and same-byte replacement attacks never remove a foreign inode', () => {
  for (const attack of ['symlink', 'hardlink', 'replacement']) {
    const item = fixture();
    const outside = path.join(item.root, 'outside.png');
    try {
      fs.writeFileSync(outside, item.bytes);
      const reviewService = deterministicService();
      const token = reviewService.issue(issueInput(item)).token;
      if (attack === 'symlink') {
        fs.unlinkSync(item.target);
        fs.symlinkSync(outside, item.target);
      } else if (attack === 'hardlink') {
        fs.linkSync(item.target, path.join(item.generated, 'second-link.png'));
      } else {
        fs.unlinkSync(item.target);
        fs.writeFileSync(item.target, item.bytes);
      }
      expectCode(
        attack === 'hardlink' || attack === 'symlink'
          ? 'IMAGE_REVIEW_ASSET_UNSAFE'
          : 'IMAGE_REVIEW_ASSET_CHANGED',
        () => reviewService.settle(binding(item), review(token, 'deleted'))
      );
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), item.bytes.toString());
      assert.strictEqual(reviewService.inspect(token).phase, 'live');
    } finally { item.cleanup(); }
  }
});

test('generated-directory replacement is not mistaken for an idempotently missing asset', () => {
  const item = fixture();
  const originalDirectory = `${item.generated}-original`;
  try {
    const reviewService = deterministicService();
    const token = reviewService.issue(issueInput(item)).token;
    fs.renameSync(item.generated, originalDirectory);
    fs.mkdirSync(item.generated);
    expectCode('IMAGE_REVIEW_ASSET_CHANGED', () =>
      reviewService.settle(binding(item), review(token, 'deleted')));
    assert.deepStrictEqual(
      fs.readFileSync(path.join(originalDirectory, path.basename(item.target))),
      item.bytes
    );
    assert.strictEqual(reviewService.inspect(token).phase, 'live');
  } finally { item.cleanup(); }
});

test('expired live token fails closed while exact terminal kept retry is recoverable', () => {
  const item = fixture();
  let time = Date.parse('2026-07-26T10:00:00.000Z');
  try {
    const expiring = deterministicService({
      now: () => new Date(time),
      ttlMs: 1000,
    });
    const expired = expiring.issue(issueInput(item)).token;
    time += 1001;
    expectCode('IMAGE_REVIEW_STALE', () =>
      expiring.settle(binding(item), review(expired, 'kept')));

    const current = deterministicService();
    const token = current.issue(issueInput(item, { operationId: 'b'.repeat(32) })).token;
    current.settle(binding(item), review(token, 'kept'));
    assert.strictEqual(
      current.settle(binding(item), review(token, 'kept')).responseRecovered,
      true
    );
    expectCode('IMAGE_REVIEW_REPLAY', () =>
      current.settle(binding(item), review(token, 'kept', { qualityRating: 5 })));
  } finally { item.cleanup(); }
});

test('trash directory-fsync failure becomes committed warning and exact retry never moves twice', () => {
  const item = fixture();
  let failDirectoryFsync = true;
  const fileSystem = proxyFs({
    fsyncSync(descriptor) {
      if (failDirectoryFsync && fs.fstatSync(descriptor).isDirectory()) {
        failDirectoryFsync = false;
        const error = new Error('injected directory fsync failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.fsyncSync(descriptor);
    },
  });
  try {
    const reviewService = deterministicService({ fileSystem });
    const token = reviewService.issue(issueInput(item)).token;
    const request = review(token, 'deleted');
    expectCode('IMAGE_REVIEW_COMMITTED_WARNING', () =>
      reviewService.settle(binding(item), request), { committed: true });
    assert.strictEqual(fs.existsSync(item.target), false);
    assert.strictEqual(reviewService.inspect(token).phase, 'committed_pending_evidence');
    const recovered = reviewService.settle(binding(item), request);
    assert.strictEqual(recovered.responseRecovered, true);
    assert.strictEqual(reviewService.inspect(token).phase, 'terminal');
  } finally { item.cleanup(); }
});

test('committed pending evidence remains recoverable after the original token TTL', () => {
  const item = fixture();
  let time = Date.parse('2026-07-26T10:00:00.000Z');
  let failRename = true;
  const fileSystem = proxyFs({
    renameSync(source, target) {
      if (failRename && target.endsWith('image-reviews.json')) {
        failRename = false;
        const error = new Error('injected evidence rename failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(source, target);
    },
  });
  try {
    const reviewService = deterministicService({
      fileSystem,
      now: () => new Date(time),
      ttlMs: 1000,
    });
    const token = reviewService.issue(issueInput(item)).token;
    const request = review(token, 'kept');
    expectCode('IMAGE_REVIEW_COMMITTED_WARNING', () =>
      reviewService.settle(binding(item), request), { committed: true });
    time += 60_000;
    const recovered = reviewService.settle(binding(item), request);
    assert.strictEqual(recovered.responseRecovered, true);
    assert.strictEqual(reviewService.aggregate(item.root).decisions.kept, 1);
  } finally { item.cleanup(); }
});

test('evidence failure after inserted commit retries evidence without repeating Markdown commit', () => {
  const item = fixture();
  let failRename = true;
  const fileSystem = proxyFs({
    renameSync(source, target) {
      if (failRename && target.endsWith('image-reviews.json')) {
        failRename = false;
        const error = new Error('injected atomic rename failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(source, target);
    },
  });
  try {
    const reviewService = deterministicService({
      fileSystem,
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const token = reviewService.issue(issueInput(item)).token;
    const request = review(token, 'inserted');
    let commits = 0;
    expectCode('IMAGE_REVIEW_COMMITTED_WARNING', () =>
      reviewService.settle(binding(item), request, {
        commitInserted() {
          commits += 1;
          return { ok: true, committed: true };
        },
      }), { committed: true });
    assert.strictEqual(commits, 1);
    assert(!fs.readdirSync(path.join(item.root, '.writcraft'))
      .some(name => name.endsWith('.tmp')));
    const recovered = reviewService.settle(binding(item), request, {
      commitInserted() {
        commits += 1;
        return { ok: true, committed: true };
      },
    });
    assert.strictEqual(recovered.responseRecovered, true);
    assert.strictEqual(commits, 1);
    assert.strictEqual(reviewService.aggregate(item.root).decisions.inserted, 1);
  } finally { item.cleanup(); }
});

test('evidence rename committed but directory fsync failed is recovered idempotently', () => {
  const item = fixture();
  let failEvidenceDirectoryFsync = true;
  let directoryFsyncCalls = 0;
  const fileSystem = proxyFs({
    fsyncSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      if (stat.isDirectory()) {
        directoryFsyncCalls += 1;
        if (failEvidenceDirectoryFsync) {
          failEvidenceDirectoryFsync = false;
          const error = new Error('injected evidence directory fsync failure');
          error.code = 'EIO';
          throw error;
        }
      }
      return fs.fsyncSync(descriptor);
    },
  });
  try {
    const reviewService = deterministicService({
      fileSystem,
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const token = reviewService.issue(issueInput(item)).token;
    const request = review(token, 'kept');
    expectCode('IMAGE_REVIEW_COMMITTED_WARNING', () =>
      reviewService.settle(binding(item), request), { committed: true });
    assert.strictEqual(fs.existsSync(path.join(item.root, '.writcraft', 'image-reviews.json')), true);
    const recovered = reviewService.settle(binding(item), request);
    assert.strictEqual(recovered.responseRecovered, true);
    assert.strictEqual(directoryFsyncCalls, 2);
    assert.strictEqual(reviewService.aggregate(item.root).sampleSize, 1);
  } finally { item.cleanup(); }
});

test('corrupt, symlinked or privacy-expanded evidence fails closed', () => {
  for (const kind of ['corrupt', 'unknown', 'symlink']) {
    const item = fixture();
    const metadata = path.join(item.root, '.writcraft');
    const evidence = path.join(metadata, 'image-reviews.json');
    const outside = path.join(item.root, 'outside-evidence.json');
    try {
      fs.mkdirSync(metadata);
      if (kind === 'corrupt') {
        fs.writeFileSync(evidence, '{bad json', 'utf8');
      } else if (kind === 'unknown') {
        fs.writeFileSync(evidence, JSON.stringify({
          schema: serviceModule.EVIDENCE_SCHEMA,
          updatedAt: '2026-07-26T10:00:00.000Z',
          records: [],
          assetPath: item.assetPath,
        }), 'utf8');
      } else {
        fs.writeFileSync(outside, '{}', 'utf8');
        fs.symlinkSync(outside, evidence);
      }
      expectCode('IMAGE_REVIEW_EVIDENCE_CORRUPT', () =>
        serviceModule.aggregateEvidence(item.root));
    } finally { item.cleanup(); }
  }
});

test('asset path, digest and project root never enter public results, evidence or aggregate', () => {
  const item = fixture();
  try {
    const reviewService = deterministicService();
    const issued = reviewService.issue(issueInput(item));
    const settled = reviewService.settle(binding(item), review(issued.token, 'kept'));
    const aggregate = reviewService.aggregate(item.root);
    const publicText = JSON.stringify({ issued, settled, aggregate });
    assert(!publicText.includes(item.root));
    assert(!publicText.includes(item.assetPath));
    assert(!publicText.includes(item.digest));
    const evidence = fs.readFileSync(path.join(item.root, '.writcraft', 'image-reviews.json'), 'utf8');
    assert(!evidence.includes(item.root));
    assert(!evidence.includes(item.assetPath));
    assert(!evidence.includes(item.digest));
  } finally { item.cleanup(); }
});

console.log(`\n${passed}/${passed} Image Review service checks passed.\n`);
