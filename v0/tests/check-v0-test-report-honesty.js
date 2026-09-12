#!/usr/bin/env node
'use strict';

// R1 + R4 report-honesty gate.
//
// This is a *static policy* gate: its subject is test source text, so it does
// not pretend to exercise production behaviour. It exists because the suite's
// human-readable output currently cannot express failure:
//
//   R1  a script that prints `${passed}/${passed}` (or a hardcoded "N/N") tells
//       a reader nothing, because the denominator is the numerator. A green
//       line is then indistinguishable from a red one by eye.
//   R4  a skip path that logs and returns without failing, or without a
//       `skipped` counter, silently converts "not run" into "green".
//
// The gate is a RATCHET, not a big-bang rewrite: it fails on any *new*
// offender while freezing the current debt in an explicit, dated allowlist.
// The allowlist is debt with a name, not a hiding place -- `--report` prints it
// with counts, and shrinking it is the point.
//
// usage:
//   node tests/check-v0-test-report-honesty.js --check    (gate; exit 1 on new)
//   node tests/check-v0-test-report-honesty.js --report   (inventory; exit 0)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TEST_ROOT = path.join(__dirname);
const ALLOWLIST_PATH = path.join(TEST_ROOT, '0.4.0-report-honesty-allowlist.json');

const SAME_IDENTIFIER_TOTAL = 'same-identifier-total';
const HARDCODED_TOTAL = 'hardcoded-total';
const MISSING_TOTAL_ASSERTION = 'missing-total-assertion';
const SILENT_SKIP = 'silent-skip';

const CATEGORIES = Object.freeze([
  SAME_IDENTIFIER_TOTAL,
  HARDCODED_TOTAL,
  MISSING_TOTAL_ASSERTION,
  SILENT_SKIP
]);

function listTestFiles() {
  return fs.readdirSync(TEST_ROOT)
    .filter((name) => /^verify-v0-.*\.js$/.test(name))
    .sort();
}

function reportLines(source) {
  return source.split('\n').filter((line) => /console\.(log|error)|process\.stdout\.write/.test(line));
}

// R1a: an interpolated total whose denominator is the same identifier.
function findSameIdentifierTotals(source) {
  const hits = [];
  const pattern = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s*\/\s*\$\{\s*\1\s*\}/;
  for (const line of reportLines(source)) {
    if (pattern.test(line)) hits.push(line.trim());
  }
  return hits;
}

// R1b: a literal total baked into the message, e.g. "8/8" or "1/1 passed".
function findHardcodedTotals(source) {
  const hits = [];
  for (const line of reportLines(source)) {
    if (/\$\{/.test(line)) continue; // interpolated, handled by R1a
    if (/['"`][^'"`]*\b\d+\s*\/\s*\d+\b/.test(line)) hits.push(line.trim());
  }
  return hits;
}

// R1c: a script that prints a counted total without ever asserting the counter
// against a constant. Without that assertion the printed number is decoration:
// nothing ties "we ran 12 checks" to "there are 12 checks". This is checked
// structurally (does the file assert the printed counter?) rather than by
// guessing at brace nesting around the print statement.
function printedCounters(source) {
  const counters = new Set();
  for (const line of reportLines(source)) {
    const pattern = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s*\//g;
    let match = pattern.exec(line);
    while (match) {
      counters.add(match[1]);
      match = pattern.exec(line);
    }
  }
  return [...counters];
}

function findMissingTotalAssertions(source) {
  const hits = [];
  for (const counter of printedCounters(source)) {
    const asserted = new RegExp(
      `assert\\.(?:strictEqual|equal|strict\\.equal)\\(\\s*${counter}\\s*,`
    ).test(source);
    if (!asserted) {
      hits.push(`prints \${${counter}}/… with no assert.strictEqual(${counter}, EXPECTED_TOTAL)`);
    }
  }
  return hits;
}

// R4: a skip path inside a test body that is not counted anywhere.
// The "counted" test must look for a real counter, not for the word "skipped"
// appearing in a log message -- an earlier version of this detector accepted
// `console.log('... skipped ...')` as evidence of counting, which is exactly
// the defect it is meant to catch.
function hasSkipCounter(source) {
  if (/WRITCRAFT_ALLOW_SKIP/.test(source)) return true;
  if (/(?:let|const|var)\s+skipped\b/.test(source)) return true;
  if (/\bskipped\s*(?:\+=|\+\+)/.test(source)) return true;
  if (/\bskipCount\s*(?:\+=|\+\+)/.test(source)) return true;
  return false;
}

function findSilentSkips(source) {
  if (hasSkipCounter(source)) return [];
  const lines = source.split('\n');
  const hits = [];
  for (const line of lines) {
    if (/console\.(log|error|warn)/.test(line)
      && /\b(skip|skipped|SKIP|Skipping)\b/.test(line)) {
      hits.push(line.trim());
    }
  }
  return hits;
}

function inspect(source) {
  const found = {};
  found[SAME_IDENTIFIER_TOTAL] = findSameIdentifierTotals(source);
  found[HARDCODED_TOTAL] = findHardcodedTotals(source);
  found[MISSING_TOTAL_ASSERTION] = findMissingTotalAssertions(source);
  found[SILENT_SKIP] = findSilentSkips(source);
  return found;
}

function readAllowlist() {
  const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  assert.strictEqual(raw.schemaVersion, 'writcraft.report-honesty-allowlist/v1');
  for (const category of CATEGORIES) {
    assert(Array.isArray(raw[category]), `allowlist.${category} must be an array`);
  }
  return raw;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.length === 1 && args[0] === '--check';
  const isReport = args.length === 1 && args[0] === '--report';
  assert(isCheck || isReport, 'usage: --check | --report');

  const allowlist = readAllowlist();
  const files = listTestFiles();
  const allowed = new Map();
  for (const category of CATEGORIES) {
    for (const file of allowlist[category]) {
      if (!allowed.has(file)) allowed.set(file, new Set());
      allowed.get(file).add(category);
    }
  }

  const violations = [];
  const debt = new Map();
  for (const file of files) {
    const found = inspect(fs.readFileSync(path.join(TEST_ROOT, file), 'utf8'));
    for (const category of CATEGORIES) {
      if (found[category].length === 0) continue;
      const frozen = allowed.get(file)?.has(category);
      const entry = { file, category, samples: found[category].slice(0, 2), count: found[category].length };
      if (frozen) {
        if (!debt.has(file)) debt.set(file, new Set());
        debt.get(file).add(category);
      } else {
        violations.push(entry);
      }
    }
  }

  // A stale allowlist entry (offender already fixed) is progress, but leaving it
  // in place would silently re-permit a regression. Surface it loudly.
  const stale = [];
  for (const [file, categories] of allowed) {
    if (!files.includes(file)) { stale.push(`${file} (file gone)`); continue; }
    const found = inspect(fs.readFileSync(path.join(TEST_ROOT, file), 'utf8'));
    for (const category of categories) {
      if (found[category].length === 0) stale.push(`${file} [${category}]`);
    }
  }

  const outstanding = debt.size;
  const lines = [];
  lines.push(`test report honesty: ${files.length} verify-v0 scripts scanned`);
  lines.push(`  frozen debt : ${outstanding} files (${CATEGORIES.map((c) => `${c}=${allowlist[c].length}`).join(', ')})`);
  lines.push(`  new violations: ${violations.length}`);
  if (stale.length > 0) {
    lines.push(`  stale allowlist entries (already fixed -- remove them): ${stale.length}`);
    for (const item of stale) lines.push(`    - ${item}`);
  }

  if (isReport) {
    lines.push('');
    lines.push('Frozen debt by file:');
    for (const [file, categories] of [...debt].sort()) {
      lines.push(`  ${file}: ${[...categories].join(', ')}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (violations.length > 0) {
    lines.push('');
    lines.push('NEW report-honesty violations (a green line that cannot express failure):');
    for (const v of violations) {
      lines.push(`  ${v.file} [${v.category}] x${v.count}`);
      for (const sample of v.samples) lines.push(`      ${sample}`);
    }
    lines.push('');
    lines.push('Fix: give the script a real EXPECTED_TOTAL constant, assert');
    lines.push('`assert.strictEqual(passed, EXPECTED_TOTAL)` before printing, and print');
    lines.push('`${passed}/${EXPECTED_TOTAL}`. A skip path must increment a `skipped`');
    lines.push('counter and exit non-zero unless WRITCRAFT_ALLOW_SKIP=1.');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  if (violations.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = { inspect, listTestFiles, TEST_ROOT, CATEGORIES, ALLOWLIST_PATH };
