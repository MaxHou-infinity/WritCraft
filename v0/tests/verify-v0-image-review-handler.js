#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handlerModule = require('../src/main/image-review-handler');
const imageReviewServiceModule = require('../src/main/image-review-service');

console.log('\nWritCraft image review Main handler verification');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function fixture() {
  const state = {
    project: { instanceId: 'project-a', rootPath: '/canonical/project-a' },
    generation: 3,
    navigation: 5,
    senderId: 7,
    files: new Map(),
    issueInput: null,
    settleCalls: [],
  };
  const records = new Map();
  const token = `irv_${'a'.repeat(48)}`;
  const reviewService = {
    assertIssueAvailable(input, operationId) {
      state.issuePreflight = { input, operationId };
      return true;
    },
    issue(input) {
      state.issueInput = input;
      records.set(token, input);
      return {
        ok: true,
        schema: 'writcraft.image-review/v1',
        token,
        expiresAt: '2026-07-26T10:05:00.000Z',
        assetPath: 'must-not-leak',
      };
    },
    settle(binding, review, settlement) {
      state.settleCalls.push({ binding, review, settlement });
      if (review.decision === 'inserted') {
        assert.deepStrictEqual(settlement.commitInserted(), {
          ok: true,
          committed: true,
        });
      }
      return {
        ok: true,
        schema: 'writcraft.image-review/v1',
        decision: review.decision,
        operationId: 'b'.repeat(32),
        committed: true,
        responseRecovered: false,
        assetPath: 'must-not-leak',
        digest: 'must-not-leak',
      };
    },
    inspect() {
      return { phase: 'live' };
    },
    aggregate(rootPath) {
      return { schema: 'writcraft.image-review-aggregate/v1', rootSeen: rootPath };
    },
  };
  const projectService = {
    readFileWithRevision(rootPath, targetPath) {
      const value = state.files.get(targetPath);
      if (!value || rootPath !== state.project.rootPath) throw new Error('not found');
      return value;
    },
  };
  const handler = handlerModule.createImageReviewHandler({
    assertTrustedSender(event) {
      if (event?.sender?.trusted !== true) throw new Error('UNTRUSTED');
    },
    getCurrentProject: () => state.project,
    getMutationGeneration: () => state.generation,
    getNavigationEpoch: () => state.navigation,
    projectService,
    reviewService,
  });
  return {
    state,
    handler,
    event: () => ({ sender: { id: state.senderId, trusted: true } }),
    token,
  };
}

function issued(item) {
  const digest = crypto.createHash('sha256').update('image').digest('hex');
  const image = {
    filePath: `assets/generated/image-${digest}.png`,
    previewDataUrl: 'data:image/png;base64,SECRET',
    rootPath: '/renderer/forbidden',
  };
  const result = item.handler.issue(
    item.event(),
    item.state.project,
    'b'.repeat(32),
    image
  );
  return { result, digest, assetPath: image.filePath };
}

function review(token, decision = 'kept') {
  return {
    token,
    decision,
    qualityRating: 5,
    costMinorUnits: 125,
    currency: 'CNY',
  };
}

function expectCode(code, fn) {
  assert.throws(fn, error => error?.code === code);
}

test('issue signs only Main binding plus digest/path and returns no private asset data', () => {
  const item = fixture();
  const { result, digest, assetPath } = issued(item);
  assert.deepStrictEqual(item.state.issueInput, {
    webContentsId: 7,
    projectInstanceId: 'project-a',
    rootPath: '/canonical/project-a',
    mutationGeneration: 3,
    navigationEpoch: 5,
    operationId: 'b'.repeat(32),
    assetPath,
    assetDigest: digest,
  });
  assert.deepStrictEqual(Object.keys(result), ['ok', 'schema', 'token', 'expiresAt']);
  assert(!JSON.stringify(result).includes('asset'));
  assert(!JSON.stringify(item.state.issueInput).includes('SECRET'));
});

test('kept tolerates forward manuscript generations while preserving project authority', () => {
  const item = fixture();
  issued(item);
  item.state.generation += 1;
  const result = item.handler.settle(
    item.event(),
    'project-a',
    review(item.token, 'kept')
  );
  assert.strictEqual(result.decision, 'kept');
  assert.strictEqual(item.state.settleCalls.length, 1);
});

test('deleted blocks forward manuscript generations so a referenced asset cannot become a broken image', () => {
  const item = fixture();
  issued(item);
  item.state.generation += 1;
  expectCode('IMAGE_REVIEW_DELETE_BLOCKED', () =>
    item.handler.settle(item.event(), 'project-a', review(item.token, 'deleted')));
  assert.strictEqual(item.state.settleCalls.length, 0);
});

test('deleted still settles at the exact issued manuscript generation', () => {
  const item = fixture();
  issued(item);
  const result = item.handler.settle(
    item.event(),
    'project-a',
    review(item.token, 'deleted')
  );
  assert.strictEqual(result.decision, 'deleted');
  assert.strictEqual(item.state.settleCalls.length, 1);
});

test('all decisions reject an impossible mutation-generation rollback', () => {
  for (const decision of ['kept', 'deleted', 'inserted']) {
    const item = fixture();
    issued(item);
    item.state.generation -= 1;
    expectCode('IMAGE_REVIEW_STALE', () =>
      item.handler.settle(item.event(), 'project-a', review(item.token, decision)));
    assert.strictEqual(item.state.settleCalls.length, 0);
  }
});

test('foreign sender, project and navigation fail before service settlement', () => {
  for (const mutate of [
    item => { item.state.senderId = 8; },
    item => { item.state.project = { instanceId: 'project-b', rootPath: '/canonical/project-b' }; },
    item => { item.state.navigation += 1; },
  ]) {
    const item = fixture();
    issued(item);
    mutate(item);
    expectCode('IMAGE_REVIEW_STALE', () =>
      item.handler.settle(item.event(), 'project-a', review(item.token)));
    assert.strictEqual(item.state.settleCalls.length, 0);
  }
});

test('inserted accepts forward generation only with exact authoritative Markdown proof', () => {
  const item = fixture();
  const { assetPath } = issued(item);
  item.state.generation += 1;
  const targetPath = 'chapters/01.md';
  const content = `# Chapter\n\n![AI 生成图片](../${assetPath})\n`;
  const revision = crypto.createHash('sha256').update(content).digest('hex');
  item.state.files.set(targetPath, { content, revision });
  const result = item.handler.settle(
    item.event(),
    'project-a',
    review(item.token, 'inserted'),
    { targetPath, revision }
  );
  assert.strictEqual(result.decision, 'inserted');
  assert.deepStrictEqual(Object.keys(result), [
    'ok', 'schema', 'decision', 'operationId', 'committed', 'responseRecovered',
  ]);
  assert(!JSON.stringify(result).includes(assetPath));
  assert.strictEqual(item.state.settleCalls[0].binding.mutationGeneration, 3);
});

test('insert proof rejects missing, stale, forbidden and smuggled authority', () => {
  for (const [code, targetPath, proofTransform] of [
    ['IMAGE_REVIEW_PROOF_INVALID', 'edit.md', proof => proof],
    ['IMAGE_REVIEW_PROOF_INVALID', 'notes.txt', proof => proof],
    ['IMAGE_REVIEW_PROOF_INVALID', 'chapters/01.md', proof => ({ ...proof, assetPath: 'assets/generated/foreign.png' })],
    ['IMAGE_REVIEW_PROOF_STALE', 'chapters/01.md', proof => ({ ...proof, revision: 'f'.repeat(64) })],
    ['IMAGE_REVIEW_PROOF_MISSING', 'chapters/01.md', proof => proof],
  ]) {
    const item = fixture();
    issued(item);
    const content = '# Chapter\n\nNo image here.\n';
    const revision = crypto.createHash('sha256').update(content).digest('hex');
    item.state.files.set('chapters/01.md', { content, revision });
    const proof = proofTransform({ targetPath, revision });
    expectCode(code, () =>
      item.handler.settle(
        item.event(),
        'project-a',
        review(item.token, 'inserted'),
        proof
      ));
    assert.strictEqual(item.state.settleCalls.length, 0);
  }
});

test('non-inserted decisions reject insertion proof and aggregate returns only service output', () => {
  const item = fixture();
  issued(item);
  expectCode('IMAGE_REVIEW_PROOF_FORBIDDEN', () =>
    item.handler.settle(
      item.event(),
      'project-a',
      review(item.token, 'kept'),
      { targetPath: 'chapters/01.md', revision: 'a'.repeat(64) }
    ));
  const aggregate = item.handler.aggregate(item.event(), 'project-a');
  assert.deepStrictEqual(aggregate, {
    schema: 'writcraft.image-review-aggregate/v1',
    rootSeen: '/canonical/project-a',
  });
});

test('untrusted callers never reach issue, settle or aggregate authority', () => {
  const item = fixture();
  const untrusted = { sender: { id: 7, trusted: false } };
  assert.throws(() => item.handler.issue(
    untrusted,
    item.state.project,
    'b'.repeat(32),
    { filePath: `assets/generated/image-${'a'.repeat(64)}.png` }
  ), /UNTRUSTED/);
  assert.throws(() => item.handler.aggregate(untrusted, 'project-a'), /UNTRUSTED/);
});

test('preflight binds current Main authority before image bytes can be requested', () => {
  const item = fixture();
  assert.strictEqual(
    item.handler.assertCanIssue(item.event(), item.state.project, 'b'.repeat(32)),
    true
  );
  assert.strictEqual(item.state.issuePreflight.operationId, 'b'.repeat(32));
  assert.deepStrictEqual(item.state.issuePreflight.input, {
    webContentsId: 7,
    projectInstanceId: 'project-a',
    rootPath: '/canonical/project-a',
    mutationGeneration: 3,
    navigationEpoch: 5,
  });
});

test('exact inserted response-loss retry is recovered without a second commit', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-image-handler-')));
  const generated = path.join(root, 'assets', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const bytes = Buffer.from('handler-inserted-retry-fixture');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetPath = `assets/generated/image-${digest}.png`;
  fs.writeFileSync(path.join(root, ...assetPath.split('/')), bytes);
  const targetPath = 'chapter.md';
  let content = `# Chapter\n\n![AI 生成图片](${assetPath})\n`;
  let revision = crypto.createHash('sha256').update(content).digest('hex');
  const state = {
    project: { instanceId: 'project-real', rootPath: root },
    generation: 1,
    navigation: 1,
  };
  try {
    const service = imageReviewServiceModule.createImageReviewService({
      randomToken: () => `irv_${'c'.repeat(48)}`,
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const handler = handlerModule.createImageReviewHandler({
      assertTrustedSender() {},
      getCurrentProject: () => state.project,
      getMutationGeneration: () => state.generation,
      getNavigationEpoch: () => state.navigation,
      projectService: {
        readFileWithRevision(_rootPath, requestedPath) {
          assert.strictEqual(requestedPath, targetPath);
          return { content, revision };
        },
      },
      reviewService: service,
    });
    const event = { sender: { id: 9 } };
    const issuedReview = handler.issue(
      event,
      state.project,
      'd'.repeat(32),
      { filePath: assetPath }
    );
    const request = {
      token: issuedReview.token,
      decision: 'inserted',
      qualityRating: 4,
    };
    const proof = { targetPath, revision };
    assert.strictEqual(
      handler.settle(event, 'project-real', request, proof).decision,
      'inserted'
    );
    state.generation += 1;
    content = '# Chapter changed after committed response loss\n';
    revision = crypto.createHash('sha256').update(content).digest('hex');
    assert.strictEqual(
      handler.settle(event, 'project-real', request, proof).responseRecovered,
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forward-generation keep reaches the real asset identity and digest checks', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-image-handler-keep-')));
  const generated = path.join(root, 'assets', 'generated');
  fs.mkdirSync(generated, { recursive: true });
  const bytes = Buffer.from('handler-forward-keep-fixture');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetPath = `assets/generated/image-${digest}.png`;
  const absoluteAssetPath = path.join(root, ...assetPath.split('/'));
  fs.writeFileSync(absoluteAssetPath, bytes);
  const state = {
    project: { instanceId: 'project-real-keep', rootPath: root },
    generation: 1,
    navigation: 1,
  };
  try {
    let tokenIndex = 0;
    const service = imageReviewServiceModule.createImageReviewService({
      randomToken: () => `irv_${String(++tokenIndex).padStart(48, 'e')}`,
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const handler = handlerModule.createImageReviewHandler({
      assertTrustedSender() {},
      getCurrentProject: () => state.project,
      getMutationGeneration: () => state.generation,
      getNavigationEpoch: () => state.navigation,
      projectService: { readFileWithRevision() { throw new Error('not used'); } },
      reviewService: service,
    });
    const event = { sender: { id: 10 } };
    const issuedReview = handler.issue(
      event,
      state.project,
      'f'.repeat(32),
      { filePath: assetPath }
    );
    state.generation += 1;
    const kept = handler.settle(event, state.project.instanceId, {
      token: issuedReview.token,
      decision: 'kept',
      qualityRating: 4,
    });
    assert.strictEqual(kept.decision, 'kept');
    assert.deepStrictEqual(fs.readFileSync(absoluteAssetPath), bytes);

    const second = handler.issue(
      event,
      state.project,
      '1'.repeat(32),
      { filePath: assetPath }
    );
    fs.writeFileSync(absoluteAssetPath, Buffer.from('replacement'));
    state.generation += 1;
    expectCode('IMAGE_REVIEW_ASSET_CHANGED', () => handler.settle(
      event,
      state.project.instanceId,
      { token: second.token, decision: 'kept', qualityRating: 4 }
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n✅ image review handler ${passed}/${passed} checks passed.\n`);
