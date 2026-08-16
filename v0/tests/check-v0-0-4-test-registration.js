'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.join(PROJECT_ROOT, 'tests');
const MANIFEST_PATH = path.join(TEST_ROOT, '0.4.0-test-gates.json');
const LEGACY_BASELINE_PATH = path.join(TEST_ROOT, '0.4.0-legacy-test-baseline.json');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const REQUIRED_FIELDS = Object.freeze([
  'test',
  'stage',
  'lane',
  'evidenceKind',
  'requiredInCurrentGate',
  'completionEligible',
  'requiresGui'
]);
const EXPECTED_SCRIPTS = Object.freeze({
  'verify:0.4:registration': 'node tests/check-v0-0-4-test-registration.js --check',
  'verify:0.4:stage-a-components': 'node tests/check-v0-0-4-test-registration.js --run stage-a-components',
  'verify:0.4:stage-b-preflight': 'node tests/check-v0-0-4-test-registration.js --run stage-b-preflight',
  'verify:0.4:current-components': 'npm run verify:0.4:stage-a-components && npm run verify:0.4:stage-b-preflight'
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectAllVerificationTests() {
  return fs.readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^verify-v0-.*\.js$/.test(name))
    .map((name) => `tests/${name}`)
    .sort();
}

function assertString(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} must be a string`);
  assert(value.length > 0, `${label} must not be empty`);
}

function validateManifest(manifest, legacyBaseline, packageJson) {
  assert.strictEqual(manifest.schemaVersion, 'writcraft.test-gates/v1');
  assert.strictEqual(manifest.targetVersion, '0.4.0');
  assert.strictEqual(manifest.legacyBaseline, 'tests/0.4.0-legacy-test-baseline.json');
  assert(Number.isSafeInteger(manifest.expectedTestCount));
  assert(Array.isArray(manifest.tests));
  assert.strictEqual(
    manifest.tests.length,
    manifest.expectedTestCount,
    'test manifest count does not match expectedTestCount'
  );

  const registered = new Set();
  for (const [index, entry] of manifest.tests.entries()) {
    for (const field of REQUIRED_FIELDS) {
      assert(
        Object.prototype.hasOwnProperty.call(entry, field),
        `tests[${index}] is missing ${field}`
      );
    }
    assertString(entry.test, `tests[${index}].test`);
    assert(/^[A-E]$/.test(entry.stage), `tests[${index}].stage must be A-E`);
    assertString(entry.lane, `tests[${index}].lane`);
    assertString(entry.evidenceKind, `tests[${index}].evidenceKind`);
    assert.strictEqual(typeof entry.requiredInCurrentGate, 'boolean');
    assert.strictEqual(typeof entry.completionEligible, 'boolean');
    assert.strictEqual(typeof entry.requiresGui, 'boolean');
    assert(!registered.has(entry.test), `duplicate test registration: ${entry.test}`);
    registered.add(entry.test);
    assert(
      fs.existsSync(path.join(PROJECT_ROOT, entry.test)),
      `registered test does not exist: ${entry.test}`
    );
    if (entry.stage === 'A') {
      assert.strictEqual(
        entry.completionEligible,
        false,
        `Stage A component evidence cannot self-sign completion: ${entry.test}`
      );
    }
    if (entry.stage === 'B' && entry.requiresGui) {
      assert.strictEqual(
        entry.requiredInCurrentGate,
        false,
        `Stage B GUI evidence cannot enter the default Node gate: ${entry.test}`
      );
    }
  }

  assert.strictEqual(legacyBaseline.schemaVersion, 'writcraft.test-legacy-baseline/v1');
  assert.strictEqual(legacyBaseline.frozenAt, '2026-08-11');
  assert(Number.isSafeInteger(legacyBaseline.expectedTestCount));
  assert(Array.isArray(legacyBaseline.tests));
  assert.strictEqual(
    legacyBaseline.tests.length,
    legacyBaseline.expectedTestCount,
    'legacy baseline count does not match expectedTestCount'
  );
  const legacy = new Set();
  for (const [index, test] of legacyBaseline.tests.entries()) {
    assertString(test, `legacy tests[${index}]`);
    assert(/^tests\/verify-v0-.*\.js$/.test(test), `invalid legacy test path: ${test}`);
    assert(!legacy.has(test), `duplicate legacy baseline entry: ${test}`);
    assert(!registered.has(test), `test classified as both 0.4 and legacy: ${test}`);
    legacy.add(test);
    assert(fs.existsSync(path.join(PROJECT_ROOT, test)), `legacy test does not exist: ${test}`);
  }
  const directoryTests = collectAllVerificationTests();
  const classifiedTests = [...registered, ...legacy].sort();
  assert.deepStrictEqual(
    classifiedTests,
    directoryTests,
    'verify-v0 test directory drift: classify every added, renamed, or removed script'
  );

  for (const [name, command] of Object.entries(EXPECTED_SCRIPTS)) {
    assert.strictEqual(packageJson.scripts[name], command, `package script drift: ${name}`);
  }
  for (const hook of ['pretest', 'preverify']) {
    assert(
      packageJson.scripts[hook].includes('npm run verify:0.4:registration'),
      `${hook} must include only the static 0.4 registration gate`
    );
    assert(
      !/verify:0\.4:(?:current-components|stage-a-components|stage-b-preflight)/.test(packageJson.scripts[hook]),
      `${hook} must not run 0.4 component suites`
    );
  }
  assert(
    !/npm run (?:test|verify)(?:\s|$)/.test(packageJson.scripts['verify:0.4:current-components']),
    'current-components must not recurse through test or verify'
  );

  const packageCommands = Object.values(packageJson.scripts).join('\n');
  for (const entry of manifest.tests) {
    if (entry.stage === 'A' && !entry.requiresGui && !entry.requiredInCurrentGate) {
      assert(
        packageCommands.includes(entry.test),
        `Stage A registration excluded from current-components has no package gate: ${entry.test}`
      );
    }
  }

  const prematureGate = Object.keys(packageJson.scripts).find((name) => (
    /0\.4/.test(name) && /(?:candidate|complete)/i.test(name)
  ));
  assert.strictEqual(
    prematureGate,
    undefined,
    `A0 forbids every 0.4 candidate/complete script: ${prematureGate}`
  );

  return {
    directoryCount: directoryTests.length,
    registeredCount: registered.size,
    legacyCount: legacy.size,
    stageAComponentCount: manifest.tests.filter((entry) => (
      entry.stage === 'A' && entry.requiredInCurrentGate && !entry.requiresGui
    )).length,
    stageBNodeCount: manifest.tests.filter((entry) => entry.stage === 'B' && !entry.requiresGui).length,
    guiCount: manifest.tests.filter((entry) => entry.requiresGui).length
  };
}

function selectTests(manifest, selector) {
  if (selector === 'stage-a-components') {
    return manifest.tests.filter((entry) => (
      entry.stage === 'A' && entry.requiredInCurrentGate && !entry.requiresGui
    ));
  }
  if (selector === 'stage-b-preflight') {
    return manifest.tests.filter((entry) => entry.stage === 'B' && !entry.requiresGui);
  }
  throw new Error(`unknown test gate selector: ${selector}`);
}

function runTests(entries, selector) {
  assert(entries.length > 0, `${selector} selected no tests`);
  for (const [index, entry] of entries.entries()) {
    process.stdout.write(`[0.4 gate ${selector}] ${index + 1}/${entries.length} ${entry.test}\n`);
    const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, entry.test)], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: 'inherit'
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status === null ? 1 : result.status);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.length === 1 && args[0] === '--check';
  const isRun = args.length === 2 && args[0] === '--run';
  assert(isCheck || isRun, 'usage: --check | --run <stage-a-components|stage-b-preflight>');

  const manifest = readJson(MANIFEST_PATH);
  const legacyBaseline = readJson(LEGACY_BASELINE_PATH);
  const packageJson = readJson(PACKAGE_PATH);
  const summary = validateManifest(manifest, legacyBaseline, packageJson);
  process.stdout.write(
    `0.4 test registration: ${summary.directoryCount} verify-v0 scripts classified `
      + `(${summary.registeredCount} current, ${summary.legacyCount} legacy), `
      + `${summary.stageAComponentCount} Stage A current components, `
      + `${summary.stageBNodeCount} Stage B Node preflight, ${summary.guiCount} GUI-only\n`
  );
  if (isRun) {
    runTests(selectTests(manifest, args[1]), args[1]);
  }
}

main();
