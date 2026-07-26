'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Transaction = require('../src/renderer/plan-handoff-transaction');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}`); throw error; }
}

function request(plan, task) {
  return { schema: Transaction.SCHEMA, planId: plan, taskId: task };
}

async function run() {
  console.log('\nPlan handoff renderer transaction verification');

  await test('normalizes only the identifier-only exact request', async () => {
    const value = request('plan_a', 't1');
    assert.deepStrictEqual(Transaction.normalizeRequest(value), value);
    assert.strictEqual(Transaction.normalizeRequest({ ...value, instruction: '注入' }), null);
    assert.strictEqual(Transaction.normalizeRequest({ schema: Transaction.SCHEMA, planId: 'plan_a' }), null);
  });

  await test('A→B makes the full A identity stale and discards its late ChangeSet', async () => {
    const state = Transaction.create();
    const a = state.begin(request('plan_a', 'ta'), 'project-1');
    const b = state.begin(request('plan_b', 'tb'), 'project-1');
    const discarded = [];
    assert.strictEqual(await state.settle(a, { ok: true, changeSetId: 'cs_a' }, {
      projectInstanceId: 'project-1', discard: async id => discarded.push(id),
    }), false);
    assert.deepStrictEqual(discarded, ['cs_a']);
    assert.strictEqual(state.isCurrent(b, 'project-1'), true);
    assert.strictEqual(state.getActive().planId, 'plan_b');
    assert.strictEqual(state.getActive().taskId, 'tb');
  });

  await test('detach invalidates an in-flight request and disposes a late success', async () => {
    const state = Transaction.create();
    const token = state.begin(request('plan_a', 'ta'), 'project-1');
    state.invalidate();
    const discarded = [];
    assert.strictEqual(await state.settle(token, { ok: true, changeSetId: 'cs_late' }, {
      projectInstanceId: 'project-1', discard: async id => discarded.push(id),
    }), false);
    assert.deepStrictEqual(discarded, ['cs_late']);
    assert.strictEqual(state.getActive(), null);
  });

  await test('project instance is part of the gate while current success remains owned', async () => {
    const state = Transaction.create();
    const token = state.begin(request('plan_a', 'ta'), 'project-1');
    const discarded = [];
    assert.strictEqual(await state.settle(token, { ok: true, changeSetId: 'cs_a' }, {
      projectInstanceId: 'project-2', discard: async id => discarded.push(id),
    }), false);
    assert.deepStrictEqual(discarded, ['cs_a']);

    const current = state.begin(request('plan_b', 'tb'), 'project-2');
    assert.strictEqual(await state.settle(current, { ok: true, changeSetId: 'cs_b' }, {
      projectInstanceId: 'project-2', discard: async id => discarded.push(id),
    }), true);
    assert.deepStrictEqual(discarded, ['cs_a']);
  });

  await test('Changes view gates pending A before activating B and invalidates detach/project-switch epochs', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/changes-view.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
    assert.match(source, /if \(pending\) \{[\s\S]{0,260}请先处理当前待审阅 Changes/);
    assert.match(source, /proposalTransactions\?\.invalidate\(\);[\s\S]{0,180}activePlanRequest = null/);
    assert.match(source, /proposalTransactions\.settle\(transaction, result/);
    assert.match(source, /projectInstanceId: window\.__workspace\?\.state\?\.project\?\.instanceId/);
    assert.match(source, /if \(!current\) return \{ ok: true, canceled: true/);
    assert(html.indexOf('plan-handoff-transaction.js') < html.indexOf('changes-view.js'));
    assert(html.indexOf('changes-proposal-transaction.js') < html.indexOf('changes-view.js'));
  });

  console.log(`\nPlan handoff renderer transaction verification passed: ${passed}/5 tests.`);
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
