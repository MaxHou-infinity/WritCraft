'use strict';

const assert = require('assert');
const { withDeadline } = require('../src/main/pdf-extract');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('\nPDF extraction cancellation boundary verification');

(async () => {
  await test('resolves an operation that completes inside the deadline', async () => {
    const value = await withDeadline(Promise.resolve('ok'), Date.now() + 1000, 'fast operation');
    assert.strictEqual(value, 'ok');
  });

  await test('actively cancels a hanging operation and returns a structured timeout', async () => {
    let canceled = false;
    const never = new Promise(() => {});
    await assert.rejects(
      () => withDeadline(never, Date.now() + 20, 'stalled page', () => { canceled = true; }),
      error => error && error.code === 'PDF_TIMEOUT' && /stalled page/.test(error.message)
    );
    assert.strictEqual(canceled, true);
  });

  await test('an already-expired deadline fails without starting a timer', async () => {
    await assert.rejects(
      () => withDeadline(Promise.resolve('late'), Date.now() - 1, 'expired'),
      error => error && error.code === 'PDF_TIMEOUT'
    );
  });

  console.log(`\n${passed}/3 PDF timeout checks passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
