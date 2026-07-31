'use strict';

const assert = require('assert');
const adapterModule = require('../src/main/writing-navigation-provider-adapter');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

(async () => {
  console.log('\nWriting navigation provider adapter verification');

  await test('deadline owner signal reaches and aborts the innermost provider request', async () => {
    let active = 0;
    let providerSignal;
    let externalSeen;
    const runAiRequest = async (_projectInstanceId, task, externalSignal) => {
      externalSeen = externalSignal;
      const controller = new AbortController();
      const relay = () => controller.abort();
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', relay, { once: true });
      active += 1;
      try { return await task(controller.signal); }
      finally {
        active -= 1;
        externalSignal.removeEventListener('abort', relay);
      }
    };
    const callLLM = async (_messages, _model, _tokens, signal, options) => {
      providerSignal = signal;
      assert.deepStrictEqual(options, { tools: ['tool'], toolChoice: { name: 'tool' } });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.code = 'REQUEST_ABORTED';
          reject(error);
        }, { once: true });
      });
    };
    const projectCallLLM = adapterModule.createWritingNavigationProviderAdapter({
      runAiRequest,
      callLLM,
    });
    const owner = new AbortController();
    const pending = projectCallLLM('instance_0123456789abcdef01234567')(
      [{ role: 'user', content: 'bounded' }],
      'MiniMax-M3',
      8192,
      {
        signal: owner.signal,
        deadlineMs: 90_000,
        tools: ['tool'],
        toolChoice: { name: 'tool' },
      }
    );
    await Promise.resolve();
    assert.strictEqual(active, 1);
    assert.strictEqual(externalSeen, owner.signal);
    owner.abort();
    await assert.rejects(() => pending, error => error.code === 'REQUEST_ABORTED');
    assert.strictEqual(providerSignal.aborted, true);
    assert.strictEqual(active, 0);
  });

  console.log(`\n${passed}/${passed} writing-navigation provider adapter checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
