#!/usr/bin/env node
'use strict';

// Focused real-Electron continuity check for the existing Main-owned API Key
// store. It writes a synthetic format-valid key into a disposable profile,
// fully exits the first App process, and proves that the same profile reports
// only public configured/type metadata after restart. No provider request is
// made and the key never enters an assertion message or log.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  skipReason,
  launchElectron,
  stopElectron,
} = require('./verify-v0-electron-e2e');

const KEY = `sk-cp-${'E2e_-'.repeat(18)}`;

async function run() {
  const skipped = skipReason();
  if (skipped) {
    console.log(`SKIP: ${skipped}`);
    return;
  }
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-api-key-restart-')));
  const profileRoot = path.join(scratch, 'profile');
  fs.mkdirSync(profileRoot, { recursive: true });
  let first = null;
  let second = null;
  try {
    first = await launchElectron(profileRoot, null, { aiFixture: false });
    const saved = await first.client.evaluate(`window.writCraft.apiKey.set(${JSON.stringify(KEY)})`);
    assert.strictEqual(saved?.ok, true, 'same-profile save must succeed');
    assert.deepStrictEqual(await first.client.evaluate('window.writCraft.apiKey.status()'), {
      ok: true,
      configured: true,
      keyType: 'CODING_PLAN',
    });
    await stopElectron(first);
    first = null;

    second = await launchElectron(profileRoot, null, { aiFixture: false });
    const status = await second.client.evaluate('window.writCraft.apiKey.status()');
    assert.deepStrictEqual(status, { ok: true, configured: true, keyType: 'CODING_PLAN' });
    assert(!JSON.stringify(status).includes('sk-cp-'), 'public status must not expose key material');
    console.log('✅ API Key same-profile restart 1/1 passed; no network call and no key disclosure');
  } finally {
    await stopElectron(first).catch(() => {});
    await stopElectron(second).catch(() => {});
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

