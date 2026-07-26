#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');
const fixture = path.join(__dirname, 'fixtures', 'electron-dom-sanitizer-main.js');
const TIMEOUT_MS = 20_000;

function runElectron() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [fixture, '--disable-gpu'], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Electron DOM sanitizer probe timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Electron exited ${code}: ${stderr.slice(-4000)}`));
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('WRITCRAFT_DOM_SANITIZER_RESULT='));
      if (!line) return reject(new Error(`Probe result missing: ${stdout.slice(-4000)} ${stderr.slice(-2000)}`));
      try { resolve(JSON.parse(line.slice('WRITCRAFT_DOM_SANITIZER_RESULT='.length))); }
      catch (error) { reject(new Error(`Probe returned invalid JSON: ${error.message}`)); }
    });
  });
}

(async () => {
  const result = await runElectron();
  const checks = [
    ['active DOM elements are removed', () => assert.equal(result.activeCount, 0)],
    ['SVG/MathML namespaces are unwrapped', () => { assert.equal(result.namespaceCount, 0); assert.equal(result.foreignNamespaceCount, 0); }],
    ['event handlers cannot execute', () => { assert.equal(result.eventAttributeCount, 0); assert.equal(result.pwned, 0); }],
    ['DOM clobbering id/name attributes are stripped', () => assert.equal(result.clobberAttributeCount, 0)],
    ['javascript links are inert', () => assert.equal(result.unsafeHref, null)],
    ['safe HTTPS links retain a defensive rel', () => { assert.equal(result.safeHref, 'https://example.com/path'); assert.equal(result.safeRel, 'noopener noreferrer'); }],
    ['protocol-relative links are rejected', () => assert.equal(result.protocolRelativeHref, null)],
    ['remote and SVG image sources are rejected', () => { assert.equal(result.remoteSrc, null); assert.equal(result.svgDataCount, 0); }],
    ['PNG data images are retained with bounded dimensions', () => { assert.equal(result.pngDataCount, 1); assert.equal(result.invalidHeight, null); }],
    ['recovery preserves inert user-visible text', () => { assert.match(result.recoveryText, /正文/); assert.match(result.recoveryText, /math text/); }],
    ['Markdown rendering creates no active HTML or unsafe href', () => { assert.equal(result.markdownActiveCount, 0); assert.equal(result.markdownUnsafeHref, null); assert.match(result.markdownText, /<img src=x/); }],
    ['serialized sanitized HTML remains inert after reparsing', () => assert.equal(result.reparseDangerCount, 0)],
    ['oversized DOM fails closed to plain text', () => { assert.equal(result.oversizedElementCount, 0); assert.equal(result.oversizedTextLength, 10001); }],
  ];
  let passed = 0;
  console.log('════════ WritCraft V0 · Real DOM sanitizer verify ════════');
  for (const [label, check] of checks) {
    check();
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
  console.log(`\n✅ Real DOM sanitizer ${passed}/${checks.length} passed in sandboxed Electron`);
})().catch(error => {
  console.error(`\n❌ Real DOM sanitizer verify failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
