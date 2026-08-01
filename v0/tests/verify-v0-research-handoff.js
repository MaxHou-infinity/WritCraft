#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projectService = require('../src/main/project-service');
const changeSetService = require('../src/main/changeset-service');
const researchService = require('../src/main/research-service');
const service = require('../src/main/research-handoff-service');

let passed = 0;
async function test(label, run) {
  try { await run(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (error) { console.error(`  ✗ ${label}: ${error.stack || error.message}`); process.exitCode = 1; }
}
function expectCode(code, run) {
  assert.throws(run, error => error instanceof service.ResearchHandoffError && error.code === code);
}
async function expectCodeAsync(code, run) {
  await assert.rejects(run, error => error instanceof service.ResearchHandoffError && error.code === code);
}
function revision(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function sourceId(seed) { return `src_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 20)}`; }
function ids(prefix, length) {
  let value = 0;
  return () => `${prefix}${(++value).toString(16).padStart(length, '0')}`;
}

function fixture() {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-research-handoff-'));
  fs.mkdirSync(path.join(rootPath, '.writcraft'));
  fs.mkdirSync(path.join(rootPath, 'references'));
  fs.mkdirSync(path.join(rootPath, 'chapters'));
  const files = {
    'edit.md': '# 项目意图\n保持结论克制。\n',
    'references/source.md': '# 权威资料\n原始数据表明样本增长了 20%。\n边界仅限本地区。\n',
    'chapters/01.md': '# 第一章\n当前正文没有数据。\n',
    'chapters/02.md': '# 第二章\n保留原样。\n',
  };
  for (const [filePath, content] of Object.entries(files)) fs.writeFileSync(path.join(rootPath, filePath), content);
  const source = {
    id: sourceId('source'), filePath: 'references/source.md', revision: revision(files['references/source.md']),
    title: '权威资料', metadata: { type: 'official', author: null, published: null, citationKey: null, url: null },
  };
  const sourceIndex = {
    schema: researchService.SOURCE_INDEX_SCHEMA,
    revision: `sha256:${revision(JSON.stringify([source]))}`,
    sources: [source],
  };
  return { rootPath, files, source, sourceIndex };
}

async function canonicalRun(item) {
  const quote = '样本增长了 20%';
  const offset = item.files['references/source.md'].indexOf(quote);
  const result = await researchService.research({
    projectService,
    rootPath: item.rootPath,
    question: '样本发生了什么变化？',
    sourceIds: [item.source.id],
    sourceIndex: item.sourceIndex,
    callLLM: async () => ({
      ok: true,
      stopReason: 'tool_use',
      toolUseBlockCount: 1,
      toolUse: {
        id: 'toolu_research',
        name: researchService.RESEARCH_TOOL_NAME,
        input: { cards: [{
          claim: '样本增长了 20%，但范围有限。', sourceId: item.source.id, quote,
          offset, end: offset + quote.length, boundary: '不能外推到其他地区。',
        }] },
      },
    }),
  });
  return result.canonicalRun;
}

function makeStore(options = {}) {
  return service.createResearchHandoffStore({
    runIdFactory: ids('rr_', 24),
    cardIdFactory: ids('rc_', 32),
    leaseIdFactory: ids('rl_', 32),
    ...options,
  });
}

async function install(item, store, options = {}) {
  const binding = {
    projectInstanceId: 'instance_111111111111111111111111',
    rootPath: item.rootPath,
    mutationGeneration: 7,
    ownerId: 'webcontents:1',
    navigationEpoch: 3,
    ...options,
  };
  const admission = store.admitRun(binding);
  const installed = store.installRun(admission, await canonicalRun(item));
  return { binding, admission, installed, cardId: installed.cards[0].id };
}

function handoffRequest(cardId, targetPaths = ['chapters/01.md']) {
  return { schema: service.HANDOFF_SCHEMA, cardId, targetPaths };
}

async function run() {
  console.log('════════ WritCraft V0 · Research → Changes v1 service/store verify ════════');

  await test('请求只接受 exact schema/cardId/1–8 targetPaths，并拒绝注入与只读目标', async () => {
    const cardId = `rc_${'1'.repeat(32)}`;
    assert.deepStrictEqual(service.validateHandoffRequest(handoffRequest(cardId)), handoffRequest(cardId));
    for (const request of [
      { ...handoffRequest(cardId), claim: 'renderer injection' },
      { ...handoffRequest(cardId), targetPaths: [] },
      { ...handoffRequest(cardId), targetPaths: ['edit.md'] },
      { ...handoffRequest(cardId), targetPaths: ['references/source.md'] },
      { ...handoffRequest(cardId), targetPaths: ['chapters/01.md', 'chapters/../01.md'] },
      { ...handoffRequest(cardId), targetPaths: ['chapters/01.md', 'CHAPTERS/01.md'] },
    ]) expectCode('INVALID_RESEARCH_HANDOFF', () => service.validateHandoffRequest(request));
  });

  await test('初始 Research 提供完整 canonical data，Store 分配高熵格式 ID 并只公开卡片必要字段', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const result = await install(item, store);
      assert.match(result.admission.runId, service.RUN_ID_RE);
      assert.match(result.cardId, service.CARD_ID_RE);
      assert.deepStrictEqual(Object.keys(result.installed), ['schema', 'cards']);
      assert.deepStrictEqual(Object.keys(result.installed.cards[0]), ['id', 'claim', 'source', 'boundary', 'handoff']);
      assert.deepStrictEqual(result.installed.cards[0].handoff, {
        schema: service.HANDOFF_SCHEMA, cardId: result.cardId,
      });
      assert.equal(store.resolveCard({
        projectInstanceId: result.binding.projectInstanceId, rootPath: item.rootPath, cardId: result.cardId,
      }).source.quote, '样本增长了 20%');
      assert.equal(store.size, 1);
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('用于准确率判断的卡片解析绑定 Research 页面 owner 与 navigation epoch', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const current = await install(item, store);
      assert.equal(store.resolveCardForOwner({
        projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath,
        cardId: current.cardId,
        ownerId: current.binding.ownerId,
        navigationEpoch: current.binding.navigationEpoch,
      }).source.quote, '样本增长了 20%');
      for (const owner of [
        { ownerId: 'webcontents:2', navigationEpoch: current.binding.navigationEpoch },
        { ownerId: current.binding.ownerId, navigationEpoch: current.binding.navigationEpoch + 1 },
      ]) expectCode('RESEARCH_CARD_NOT_FOUND', () => store.resolveCardForOwner({
        projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath,
        cardId: current.cardId,
        ...owner,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('Research 判断租约只 rebind exact READY card，不复活 sibling 或错误 owner', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const binding = {
        projectInstanceId: 'instance_111111111111111111111111', rootPath: item.rootPath,
        mutationGeneration: 7, ownerId: 'webcontents:1', navigationEpoch: 3,
      };
      const admission = store.admitRun(binding);
      const canonical = await canonicalRun(item);
      const installed = store.installRun(admission, {
        ...canonical,
        cards: [canonical.cards[0], { ...canonical.cards[0], claim: '第二张卡片' }],
      });
      const [cardId, siblingId] = installed.cards.map(card => card.id);
      expectCode('RESEARCH_CARD_NOT_FOUND', () => store.beginJudgment({
        ...binding, cardId, ownerId: 'webcontents:2',
      }));
      const lease = store.beginJudgment({ ...binding, cardId });
      assert.equal(store.inspect(cardId).state, 'JUDGING');
      expectCode('RESEARCH_HANDOFF_BUSY', () => store.beginHandoff({ ...binding, cardId }));
      store.finishJudgment({ ...binding, cardId, leaseId: lease.leaseId, mutationGeneration: 8 });
      assert.equal(store.generation(cardId), 8);
      assert.equal(store.generation(siblingId), 7);
      const handoff = store.beginHandoff({ ...binding, mutationGeneration: 8, cardId });
      store.cancel({ ...binding, cardId });
      assert.match(handoff.leaseId, /^rl_[a-f0-9]{32}$/);
      expectCode('RESEARCH_HANDOFF_STALE', () => store.beginHandoff({
        ...binding, mutationGeneration: 8, cardId: siblingId,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('新 Research 原子淘汰 READY run，但 GENERATING/REVIEW 会阻断重跑', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const first = await install(item, store);
      const replacement = store.admitRun(first.binding);
      expectCode('RESEARCH_CARD_NOT_FOUND', () => store.resolveCard({
        projectInstanceId: first.binding.projectInstanceId, rootPath: item.rootPath, cardId: first.cardId,
      }));
      store.installRun(replacement, await canonicalRun(item));
      const currentCard = `rc_${'2'.padStart(32, '0')}`;
      store.beginHandoff({ ...first.binding, cardId: currentCard });
      expectCode('RESEARCH_RUN_ACTIVE', () => store.admitRun(first.binding));
      store.cancel({ ...first.binding, cardId: currentCard });
      assert.match(store.admitRun(first.binding).runId, service.RUN_ID_RE);
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('prepare 从 Main 重建证据/edit/targets，输出冻结 provenance 且预览前零写入', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const current = await install(item, store);
      const before = fs.readFileSync(path.join(item.rootPath, 'chapters/01.md'), 'utf8');
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      assert.equal(prepared.messages.length, 1);
      assert.match(prepared.messages[0].content, /不可信数据/);
      assert.match(prepared.messages[0].content, /evidence-source-readonly/);
      assert.deepStrictEqual(Object.keys(prepared.provenance), [
        'schema', 'kind', 'runId', 'cardId', 'bindingDigest', 'expiresAt', 'evidence', 'targets',
      ]);
      assert.equal(prepared.provenance.kind, 'research_card');
      assert.match(prepared.provenance.evidence.quoteDigest, /^sha256:[a-f0-9]{64}$/);
      assert(prepared.provenance.evidence.quoteExcerpt.length <= 240);
      const serialized = JSON.stringify(prepared.provenance);
      for (const secret of ['projectInstanceId', item.rootPath, '完整 quote', '样本发生了什么变化']) assert(!serialized.includes(secret));
      assert.equal(fs.readFileSync(path.join(item.rootPath, 'chapters/01.md'), 'utf8'), before);
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('来源 inode/路径别名不能成为 target；来源和 edit/target drift 均 stale', async () => {
    const item = fixture();
    try {
      fs.linkSync(path.join(item.rootPath, 'references/source.md'), path.join(item.rootPath, 'chapters/source-alias.md'));
      const store = makeStore();
      const current = await install(item, store);
      expectCode('SOURCE_TARGET_CONFLICT', () => service.prepareResearchHandoff({
        store, projectService, ...current.binding,
        request: handoffRequest(current.cardId, ['chapters/source-alias.md']), sourceIndex: item.sourceIndex,
      }));
      const retry = store.inspect(current.cardId);
      assert.equal(retry.state, 'FAILED');
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }

    const editAlias = fixture();
    try {
      fs.linkSync(path.join(editAlias.rootPath, 'edit.md'), path.join(editAlias.rootPath, 'chapters/edit-alias.md'));
      const store = makeStore();
      const current = await install(editAlias, store);
      expectCode('SOURCE_TARGET_CONFLICT', () => service.prepareResearchHandoff({
        store, projectService, ...current.binding,
        request: handoffRequest(current.cardId, ['chapters/edit-alias.md']), sourceIndex: editAlias.sourceIndex,
      }));
      assert.equal(store.inspect(current.cardId).state, 'FAILED');
    } finally { fs.rmSync(editAlias.rootPath, { recursive: true, force: true }); }

    const changed = fixture();
    try {
      const store = makeStore();
      const current = await install(changed, store);
      fs.appendFileSync(path.join(changed.rootPath, 'references/source.md'), '来源漂移。\n');
      expectCode('RESEARCH_HANDOFF_STALE', () => service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: changed.sourceIndex,
      }));
      assert.equal(store.inspect(current.cardId).state, 'STALE');
    } finally { fs.rmSync(changed.rootPath, { recursive: true, force: true }); }
  });

  await test('handoff localized output 拒绝围栏/尾随文本及非 end_turn，依赖 tamper 不能绕过 Store', async () => {
    for (const model of [
      { ok: true, stopReason: 'end_turn', text: '```json\n{"edits":[]}\n```', code: 'INVALID_MODEL_OUTPUT' },
      { ok: true, stopReason: 'end_turn', text: '{"edits":[]} trailing', code: 'INVALID_MODEL_OUTPUT' },
      { ok: true, stopReason: 'max_tokens', text: '{"edits":[]}', code: 'MODEL_OUTPUT_TRUNCATED' },
      { ok: true, text: '{"edits":[]}', code: 'MODEL_OUTPUT_INCOMPLETE' },
    ]) {
      const item = fixture();
      try {
        const store = makeStore();
        const current = await install(item, store);
        const prepared = service.prepareResearchHandoff({
          store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
        });
        assert.throws(() => service.finalizeResearchHandoff({
          store, prepared, projectService, rootPath: item.rootPath, sourceIndex: item.sourceIndex,
          model, changeSetService, cacheReview: () => { throw new Error('must not cache'); }, discardReview: () => {},
        }), error => error.code === model.code);
      } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
    }

    const item = fixture();
    try {
      const store = makeStore();
      const current = await install(item, store);
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      const tampered = JSON.parse(JSON.stringify(prepared.dependencies));
      tampered.targets[0].path = 'chapters/02.md';
      expectCode('RESEARCH_HANDOFF_STALE', () => service.validateResearchDependencies({
        store, projectService, projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath, sourceIndex: item.sourceIndex, dependencies: tampered,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('配置不能放宽硬上限；LRU 不返回 ghost run，单 run card/byte cap 失败后清理', async () => {
    const item = fixture();
    try {
      const canonical = await canonicalRun(item);
      const lru = makeStore({ maxRuns: 1, maxCards: 256, maxBytes: service.DEFAULT_MAX_BYTES * 2 });
      const firstBinding = {
        projectInstanceId: 'instance_111111111111111111111111', rootPath: item.rootPath,
        mutationGeneration: 1, ownerId: 'webcontents:1', navigationEpoch: 1,
      };
      const firstAdmission = lru.admitRun(firstBinding);
      const first = lru.installRun(firstAdmission, canonical);
      const secondBinding = { ...firstBinding, projectInstanceId: 'instance_222222222222222222222222' };
      const secondAdmission = lru.admitRun(secondBinding);
      const second = lru.installRun(secondAdmission, canonical);
      assert.equal(lru.runCount, 1);
      expectCode('RESEARCH_CARD_NOT_FOUND', () => lru.resolveCard({
        projectInstanceId: firstBinding.projectInstanceId, rootPath: item.rootPath, cardId: first.cards[0].id,
      }));
      assert.equal(lru.resolveCard({
        projectInstanceId: secondBinding.projectInstanceId, rootPath: item.rootPath, cardId: second.cards[0].id,
      }).id, second.cards[0].id);

      const capped = makeStore({ maxCards: 1 });
      const admission = capped.admitRun(firstBinding);
      expectCode('RESEARCH_RUN_TOO_LARGE', () => capped.installRun(admission, {
        ...canonical, cards: [canonical.cards[0], canonical.cards[0]],
      }));
      assert.equal(capped.runCount, 0);
      const byteCapped = makeStore({ maxBytes: 100 });
      const byteAdmission = byteCapped.admitRun(firstBinding);
      expectCode('RESEARCH_RUN_TOO_LARGE', () => byteCapped.installRun(byteAdmission, canonical));
      assert.equal(byteCapped.runCount, 0);
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('localized preview 绑定 pc_*、先 pending ack，确认后 REVIEW；cancel 撤销 child 并回 READY', async () => {
    const item = fixture();
    const revoked = [];
    try {
      const store = makeStore({ revokeCapability: capability => revoked.push(capability) });
      const current = await install(item, store);
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      const before = item.files['chapters/01.md'];
      const model = {
        ok: true,
        stopReason: 'end_turn',
        text: JSON.stringify({ edits: [{
          path: 'chapters/01.md', oldText: '当前正文没有数据。',
          newText: '权威资料显示样本增长了 20%，但仅适用于本地区。', summary: '补入有边界的数据',
        }] }),
      };
      const result = service.finalizeResearchHandoff({
        store, prepared, projectService, rootPath: item.rootPath, sourceIndex: item.sourceIndex,
        model, changeSetService,
        cacheReview: (_changeSet, metadata) => {
          const capability = `pc_${'a'.repeat(32)}`;
          const dependencies = metadata.researchDependencies(capability);
          assert.equal(dependencies.issuedCapability, capability);
          assert.deepStrictEqual(Object.keys(dependencies).sort(), [
            'bindingDigest', 'cardId', 'edit', 'expiresAt', 'issuedCapability', 'projectInstanceId',
            'rootPath', 'runId', 'schema', 'source', 'targets',
          ].sort());
          return { capability, review: { schema: 'writcraft.changes-review/v1', files: [] } };
        },
        discardReview: () => {},
      });
      assert.equal(result.ok, true);
      assert.equal(result.proposalKind, 'research_card');
      assert.equal(store.inspect(current.cardId).state, 'REVIEW_PENDING_ACK');
      assert.equal(fs.readFileSync(path.join(item.rootPath, 'chapters/01.md'), 'utf8'), before);
      store.ackReview({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId,
        capability: result.changeSetId, ownerId: current.binding.ownerId, navigationEpoch: current.binding.navigationEpoch,
      });
      assert.equal(store.inspect(current.cardId).state, 'REVIEW');
      store.cancel({ ...current.binding, cardId: current.cardId });
      assert.deepStrictEqual(revoked, [result.changeSetId]);
      assert.equal(store.inspect(current.cardId).state, 'READY');
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('ack 超时/页面销毁撤销 capability；错误 ack 与重复并发 fail closed', async () => {
    const item = fixture();
    const timers = [];
    const revoked = [];
    try {
      const store = makeStore({
        revokeCapability: capability => revoked.push(capability),
        setTimer: callback => { timers.push(callback); return callback; },
        clearTimer: () => {},
      });
      const current = await install(item, store);
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      expectCode('RESEARCH_HANDOFF_BUSY', () => store.beginHandoff({ ...current.binding, cardId: current.cardId }));
      store.issueReview(current.cardId, prepared.leaseId, `pc_${'b'.repeat(32)}`, prepared.dependencies, () => true);
      expectCode('RESEARCH_HANDOFF_STALE', () => store.ackReview({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId,
        capability: `pc_${'c'.repeat(32)}`, ownerId: current.binding.ownerId, navigationEpoch: current.binding.navigationEpoch,
      }));
      timers[0]();
      assert.deepStrictEqual(revoked, [`pc_${'b'.repeat(32)}`]);
      assert.equal(store.inspect(current.cardId).state, 'READY');
      store.clearOwner(current.binding.ownerId, current.binding.navigationEpoch);
      expectCode('RESEARCH_CARD_NOT_FOUND', () => store.resolveCard({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('Main cancel wrapper 不需要 Renderer 提交 binding，校验依赖后 abort 并回 READY', async () => {
    const item = fixture();
    try {
      const store = makeStore();
      const current = await install(item, store);
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      const result = service.cancelResearchHandoff({
        store, projectService, projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath,
        cardId: current.cardId, ownerId: current.binding.ownerId,
        navigationEpoch: current.binding.navigationEpoch, sourceIndex: item.sourceIndex,
      });
      assert.deepStrictEqual(result, { ok: true });
      assert.equal(prepared.signal.aborted, true);
      assert.equal(store.inspect(current.cardId).state, 'READY');
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('apply lease 单次烧毁旧 capability，residual 继承绝对 expiry 并原子替换 child', async () => {
    const item = fixture();
    const revoked = [];
    try {
      const store = makeStore({
        applyLeaseIdFactory: ids('ra_', 32),
        revokeCapability: capability => revoked.push(capability),
      });
      const current = await install(item, store);
      const prepared = service.prepareResearchHandoff({
        store, projectService, ...current.binding, request: handoffRequest(current.cardId), sourceIndex: item.sourceIndex,
      });
      const firstCapability = `pc_${'d'.repeat(32)}`;
      const finalized = service.finalizeResearchHandoff({
        store, prepared, projectService, rootPath: item.rootPath, sourceIndex: item.sourceIndex,
        model: {
          ok: true, stopReason: 'end_turn',
          text: JSON.stringify({ edits: [{
            path: 'chapters/01.md', oldText: '当前正文没有数据。', newText: '当前正文补入有边界的数据。', summary: '补入数据',
          }] }),
        },
        changeSetService,
        cacheReview: (_changeSet, metadata) => ({
          capability: firstCapability,
          review: { schema: 'writcraft.changes-review/v1' },
          dependencies: metadata.researchDependencies(firstCapability),
        }),
        discardReview: () => {},
      });
      store.ackReview({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId,
        capability: finalized.changeSetId, ownerId: current.binding.ownerId, navigationEpoch: current.binding.navigationEpoch,
      });
      const apply = store.beginApply({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath,
        cardId: current.cardId, capability: firstCapability,
      });
      assert.match(apply.leaseId, /^ra_[a-f0-9]{32}$/);
      assert.deepStrictEqual(revoked, []);
      assert.equal(store.commitApplyBegin(current.cardId, apply.leaseId), true);
      assert.deepStrictEqual(revoked, [firstCapability]);
      expectCode('RESEARCH_HANDOFF_BUSY', () => store.beginApply({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath,
        cardId: current.cardId, capability: firstCapability,
      }));
      assert.equal(service.validateResearchDependencies({
        store, projectService, projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath, sourceIndex: item.sourceIndex, dependencies: apply.dependencies,
      }), true);
      const residualCapability = `pc_${'e'.repeat(32)}`;
      const committed = '# 第一章\n已应用第一部分，仍有 residual。\n';
      fs.writeFileSync(path.join(item.rootPath, 'chapters/01.md'), committed);
      const applied = [{ path: 'chapters/01.md', revision: revision(committed) }];
      const residualDependencies = service.buildResearchResidualDependencies({
        dependencies: apply.dependencies, residualCapability, applied,
      });
      assert.equal(residualDependencies.expiresAt, apply.dependencies.expiresAt);
      assert.equal(service.validateResearchResidualDependencies({
        store, projectService, projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath, sourceIndex: item.sourceIndex, cardId: current.cardId,
        applyLeaseId: apply.leaseId, previousDependencies: apply.dependencies,
        residualDependencies, applied,
      }), true);
      store.finishApply(current.cardId, apply.leaseId, { residualCapability, researchDependencies: residualDependencies });
      assert.deepStrictEqual(store.inspect(current.cardId), { state: 'REVIEW', retryCount: 0, capability: residualCapability });
      const finalApply = store.beginApply({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath,
        cardId: current.cardId, capability: residualCapability,
      });
      store.finishApply(current.cardId, finalApply.leaseId);
      assert.equal(store.inspect(current.cardId).state, 'CONSUMED');
      expectCode('RESEARCH_HANDOFF_CONSUMED', () => store.beginApply({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath,
        cardId: current.cardId, capability: residualCapability,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('apply stale/unknown failure 进入稳定终态，revoke 异常不破坏原子清理', async () => {
    const item = fixture();
    try {
      const store = makeStore({
        applyLeaseIdFactory: ids('ra_', 32),
        revokeCapability: () => { throw new Error('simulated pending-store fault'); },
      });
      const current = await install(item, store);
      const lease = store.beginHandoff({ ...current.binding, cardId: current.cardId });
      const capability = `pc_${'f'.repeat(32)}`;
      store.issueReview(current.cardId, lease.leaseId, capability, {
        schema: service.HANDOFF_SCHEMA,
        projectInstanceId: current.binding.projectInstanceId,
        rootPath: item.rootPath,
        runId: current.admission.runId,
        cardId: current.cardId,
        bindingDigest: lease.run.bindingDigest,
        source: {
          id: lease.card.source.id, path: lease.card.source.filePath, revision: lease.card.source.revision,
          offset: lease.card.source.locator.offset, end: lease.card.source.locator.end,
          quote: lease.card.source.quote, gradeDigest: lease.card.source.metadataGradeDigest,
        },
        edit: { path: 'edit.md', revision: revision(item.files['edit.md']) },
        targets: [{ path: 'chapters/01.md', revision: revision(item.files['chapters/01.md']) }],
        expiresAt: lease.expiresAt,
        issuedCapability: capability,
      }, () => true);
      store.ackReview({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId,
        capability, ownerId: current.binding.ownerId, navigationEpoch: current.binding.navigationEpoch,
      });
      const apply = store.beginApply({
        projectInstanceId: current.binding.projectInstanceId, rootPath: item.rootPath, cardId: current.cardId, capability,
      });
      store.failApply(current.cardId, apply.leaseId, 'RESEARCH_HANDOFF_STALE');
      assert.equal(store.inspect(current.cardId).state, 'STALE');
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  await test('仅白名单错误可重试两次；expiry 是绝对时间且 no-op 会消费卡片', async () => {
    let now = 1000;
    const item = fixture();
    try {
      const store = makeStore({ clock: () => now, ttlMs: 100 });
      const current = await install(item, store);
      for (let retry = 0; retry < 2; retry += 1) {
        const lease = store.beginHandoff({ ...current.binding, cardId: current.cardId });
        assert.equal(store.failure(current.cardId, lease.leaseId, 'INVALID_MODEL_OUTPUT', true), true);
      }
      const finalLease = store.beginHandoff({ ...current.binding, cardId: current.cardId });
      assert.equal(store.failure(current.cardId, finalLease.leaseId, 'INVALID_MODEL_OUTPUT', true), false);
      assert.equal(store.inspect(current.cardId).state, 'FAILED');

      const noops = makeStore({ clock: () => now, ttlMs: 100 });
      const second = await install(item, noops);
      const prepared = service.prepareResearchHandoff({
        store: noops, projectService, ...second.binding,
        request: handoffRequest(second.cardId), sourceIndex: item.sourceIndex,
      });
      const noop = service.finalizeResearchHandoff({
        store: noops, prepared, projectService, rootPath: item.rootPath, sourceIndex: item.sourceIndex,
        model: { ok: true, stopReason: 'end_turn', text: '{"edits":[]}' }, changeSetService,
        cacheReview: () => { throw new Error('no-op must not cache'); }, discardReview: () => {},
      });
      assert.equal(noop.noChanges, true);
      assert.equal(noops.inspect(second.cardId).state, 'CONSUMED');

      const expiring = makeStore({ clock: () => now, ttlMs: 100 });
      const expiry = await install(item, expiring);
      now = 1100;
      expectCode('RESEARCH_HANDOFF_EXPIRED', () => expiring.resolveCard({
        projectInstanceId: expiry.binding.projectInstanceId, rootPath: item.rootPath, cardId: expiry.cardId,
      }));
    } finally { fs.rmSync(item.rootPath, { recursive: true, force: true }); }
  });

  if (!process.exitCode) console.log(`\n✅ Research → Changes v1 service/store ${passed}/${passed} 全过`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
